import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { registerOrchestrationTools } from "../extensions/research-tools/orchestration.js";

// ── Minimal mock of ExtensionAPI — captures tools for direct invocation ──

type AnyTool = {
	name: string;
	label?: string;
	description: string;
	parameters: any;
	execute: (id: string, params: any, ...rest: any[]) => Promise<any>;
};

function makeMockPi() {
	const tools: Record<string, AnyTool> = {};
	const pi = {
		registerTool: (tool: AnyTool) => { tools[tool.name] = tool; },
		registerCommand: () => {},
		on: () => {},
		getCommands: () => [],
		sendMessage: () => {},
	} as any;
	registerOrchestrationTools(pi);
	return { pi, tools };
}

async function callTool(tools: Record<string, AnyTool>, name: string, params: any) {
	const t = tools[name];
	assert.ok(t, `tool ${name} not registered`);
	// pi-coding-agent signature: (toolCallId, params, signal, onUpdate, ctx)
	return t.execute("test-call", params, undefined, undefined, {} as any);
}

// ── Test harness: isolated ZENITH_HOME per test ──

let zenithHome: string;
let originalEnv: { home?: string; zhome?: string; maxAgents?: string; };

beforeEach(() => {
	zenithHome = mkdtempSync(resolve(tmpdir(), "zenith-gate-test-"));
	originalEnv = {
		home: process.env.HOME,
		zhome: process.env.ZENITH_HOME,
		maxAgents: process.env.ZENITH_MAX_AGENTS,
	};
	process.env.ZENITH_HOME = zenithHome;
});

afterEach(() => {
	if (originalEnv.home === undefined) delete process.env.HOME;
	else process.env.HOME = originalEnv.home;
	if (originalEnv.zhome === undefined) delete process.env.ZENITH_HOME;
	else process.env.ZENITH_HOME = originalEnv.zhome;
	if (originalEnv.maxAgents === undefined) delete process.env.ZENITH_MAX_AGENTS;
	else process.env.ZENITH_MAX_AGENTS = originalEnv.maxAgents;
	rmSync(zenithHome, { recursive: true, force: true });
});

function getSwarmDir(slug: string): string {
	return resolve(zenithHome, "swarm-work", slug);
}

function appendVerifyCitationsPassed(slug: string, artifactPath: string): void {
	// Simulate a prior verify_citations PASS run for this slug without
	// actually making HTTP calls. Lets the happy-path deliver tests exercise
	// the verify-receipt gate without pulling in the hallucination-guard
	// URL-checker.
	const eventsPath = resolve(getSwarmDir(slug), "events.jsonl");
	const event = {
		ts: new Date().toISOString(),
		type: "verify_citations_passed",
		artifact: artifactPath,
		inlineCitations: 2,
		sources: 2,
		urlsChecked: 2,
		urlsLive: 2,
		minorIssues: 0,
	};
	appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf-8");
}

async function initSwarm(tools: Record<string, AnyTool>, slug: string, opts: { budget?: string; agents?: number; phases?: string[] } = {}) {
	const agents = opts.agents ?? 120;
	const phases = opts.phases ?? ["scout", "research"];
	// Distribute agents across phases; first phase gets 1, rest get the remainder split
	const agentsPerPhase = Math.floor(agents / phases.length);
	const extra = agents - agentsPerPhase * phases.length;
	const phaseSpec = phases.map((name, i) => ({
		name,
		agents: Array.from({ length: agentsPerPhase + (i === 0 ? extra : 0) }, (_, k) => `${name}-agent-${k}`),
	}));
	return callTool(tools, "run_swarm", { slug, query: "test query", phases: phaseSpec, budget: opts.budget ?? "broad" });
}

// ── Tests ──

describe("run_swarm minimum agent enforcement", () => {
	it("rejects plans with <10 personas (MiroFish minimum)", async () => {
		const { tools } = makeMockPi();
		const res = await initSwarm(tools, "test-too-few", { agents: 5, budget: "broad" });
		assert.equal(res.details.rejected, true, "should reject");
		assert.equal(res.details.minRequired, 10);
	});

	it("accepts plans with >=10 personas", async () => {
		const { tools } = makeMockPi();
		const res = await initSwarm(tools, "test-broad-ok", { agents: 30, budget: "broad" });
		assert.ok(!res.details.rejected, `should accept, got ${JSON.stringify(res.details)}`);
		assert.equal(res.details.totalAgents, 30);
	});

	it("accepts expensive plan with >=10 personas (no tier-specific minimum anymore)", async () => {
		const { tools } = makeMockPi();
		const res = await initSwarm(tools, "test-expensive-ok", { agents: 30, budget: "expensive" });
		assert.ok(!res.details.rejected, `should accept ${res.details.totalAgents} agents, got: ${JSON.stringify(res.details)}`);
	});

	it("accepts large plan in either budget tier", async () => {
		const { tools } = makeMockPi();
		const res = await initSwarm(tools, "test-large-ok", { agents: 100, budget: "expensive" });
		assert.ok(!res.details.rejected, `should accept 100 agents, got ${JSON.stringify(res.details)}`);
		assert.equal(res.details.totalAgents, 100);
	});
});

describe("log_agent_spawn event naming + budget", () => {
	it("records agent_spawn events that swarm_status sees", async () => {
		const { tools } = makeMockPi();
		await initSwarm(tools, "test-count", { agents: 100 });

		// Spawn 3 agents
		for (let i = 0; i < 3; i++) {
			const r = await callTool(tools, "log_agent_spawn", {
				slug: "test-count", agentName: "researcher", agentId: `agent-${i}`, phase: "scout",
			});
			assert.equal(r.details.approved, true, "should be approved");
		}

		// Mark them complete (clients must emit these; after fix the tool will emit them)
		for (let i = 0; i < 3; i++) {
			const r = await callTool(tools, "mark_agent_complete", {
				slug: "test-count", agentId: `agent-${i}`, tokens: 1000,
			});
			assert.equal(r.details.ok, true);
		}

		// Now swarm_status should show 3/100 complete
		const status = await callTool(tools, "swarm_status", { slug: "test-count" });
		assert.equal(status.details.agentsComplete, 3, `expected 3 complete, got ${status.details.agentsComplete}`);
		assert.equal(status.details.tokensUsed, 3000, `expected 3000 tokens, got ${status.details.tokensUsed}`);
	});

	it("blocks spawn when limit reached", async () => {
		const { tools } = makeMockPi();
		// Force a tiny limit via env
		process.env.ZENITH_MAX_AGENTS = "3";
		await initSwarm(tools, "test-limit", { agents: 100 });

		for (let i = 0; i < 3; i++) {
			const r = await callTool(tools, "log_agent_spawn", {
				slug: "test-limit", agentName: "researcher", agentId: `a${i}`, phase: "scout",
			});
			assert.equal(r.details.approved, true);
		}
		const blocked = await callTool(tools, "log_agent_spawn", {
			slug: "test-limit", agentName: "researcher", agentId: `a4`, phase: "scout",
		});
		assert.equal(blocked.details.approved, false, "should block over-limit");
	});
});

describe("phase_gate enforcement", () => {
	it("accepts deliver as a valid phase (6-phase pipeline)", async () => {
		const { tools } = makeMockPi();
		await initSwarm(tools, "test-phases", { agents: 100, phases: ["scout", "research", "debate", "verify", "build"] });

		// Advance through all phases
		const phases = ["scout", "research", "debate", "verify", "build", "deliver"];
		let prev = "none";
		for (const p of phases) {
			const r = await callTool(tools, "phase_gate", { slug: "test-phases", nextPhase: p });
			assert.equal(r.details.approved, true, `phase ${p} should be approved (from ${prev}), got: ${r.content[0].text}`);
			prev = p;
		}
	});

	it("blocks skipping phases", async () => {
		const { tools } = makeMockPi();
		await initSwarm(tools, "test-skip", { agents: 100 });
		const r = await callTool(tools, "phase_gate", { slug: "test-skip", nextPhase: "verify" });
		assert.equal(r.details.approved, false, "should block skip from none → verify");
	});

	it("enforces completion threshold (research: 60%)", async () => {
		const { tools } = makeMockPi();
		await initSwarm(tools, "test-threshold", { agents: 100 });

		// Advance to scout then to research
		await callTool(tools, "phase_gate", { slug: "test-threshold", nextPhase: "scout" });
		await callTool(tools, "phase_gate", { slug: "test-threshold", nextPhase: "research" });

		// Spawn 10 research agents, complete 4 (40% < 60% threshold)
		for (let i = 0; i < 10; i++) {
			await callTool(tools, "log_agent_spawn", { slug: "test-threshold", agentName: "researcher", agentId: `r${i}`, phase: "research" });
		}
		for (let i = 0; i < 4; i++) {
			await callTool(tools, "mark_agent_complete", { slug: "test-threshold", agentId: `r${i}`, tokens: 100 });
		}

		// Try to advance to debate
		const r = await callTool(tools, "phase_gate", { slug: "test-threshold", nextPhase: "debate" });
		assert.equal(r.details.approved, false, `should block at 40% completion, got: ${r.content[0].text}`);
		assert.ok(String(r.content[0].text).includes("40%") || String(r.content[0].text).includes("complete"), `expected threshold message, got ${r.content[0].text}`);

		// Complete 4 more (80% ≥ 60%) — should unblock
		for (let i = 4; i < 8; i++) {
			await callTool(tools, "mark_agent_complete", { slug: "test-threshold", agentId: `r${i}`, tokens: 100 });
		}
		const r2 = await callTool(tools, "phase_gate", { slug: "test-threshold", nextPhase: "debate" });
		assert.equal(r2.details.approved, true, `should approve at 80%, got: ${r2.content[0].text}`);
	});
});

describe("deliver_artifact", () => {
	it("blocks artifact with mismatched inline/sources", async () => {
		const { tools } = makeMockPi();
		await initSwarm(tools, "test-deliver-bad", { agents: 100 });

		// Create a file with inline [1] but no matching source
		const swarmDir = getSwarmDir("test-deliver-bad");
		const artifactPath = resolve(swarmDir, "build", "final.md");
		mkdirSync(resolve(swarmDir, "build"), { recursive: true });
		writeFileSync(artifactPath, "# Report\n\nClaim [1] without source.\n\n## Sources\n\n2. Some entry at https://example.com\n\n" + "x".repeat(500));

		const r = await callTool(tools, "deliver_artifact", { slug: "test-deliver-bad", artifactPath });
		assert.equal(r.details.delivered, false, `should block mismatched citations, got: ${r.content[0].text}`);
	});

	it("rotates prior delivered report instead of clobbering", async () => {
		const { tools } = makeMockPi();
		await initSwarm(tools, "test-deliver-rotate", { agents: 100 });

		const swarmDir = getSwarmDir("test-deliver-rotate");
		mkdirSync(resolve(swarmDir, "build"), { recursive: true });
		const a = resolve(swarmDir, "build", "v1.md");
		writeFileSync(a, goodArtifact("V1"));
		const researchHome = resolve(zenithHome, "research");
		process.env.HOME = zenithHome;

		appendVerifyCitationsPassed("test-deliver-rotate", a);
		const r1 = await callTool(tools, "deliver_artifact", { slug: "test-deliver-rotate", artifactPath: a });
		assert.equal(r1.details.delivered, true, `first delivery should succeed, got: ${r1.content[0].text}`);
		const delivered1 = readFileSync(resolve(researchHome, "test-deliver-rotate.md"), "utf8");
		assert.ok(delivered1.includes("V1"));

		// Deliver a v2
		const b = resolve(swarmDir, "build", "v2.md");
		writeFileSync(b, goodArtifact("V2"));
		appendVerifyCitationsPassed("test-deliver-rotate", b);
		const r2 = await callTool(tools, "deliver_artifact", { slug: "test-deliver-rotate", artifactPath: b });
		assert.equal(r2.details.delivered, true, `second delivery should succeed, got: ${r2.content[0].text}`);
		const delivered2 = readFileSync(resolve(researchHome, "test-deliver-rotate.md"), "utf8");
		assert.ok(delivered2.includes("V2"), "current report should be V2");

		// Previous report should be rotated with a timestamp or .old suffix
		const { readdirSync } = await import("node:fs");
		const allFiles = readdirSync(researchHome);
		const rotated = allFiles.filter(f => f.startsWith("test-deliver-rotate") && f.endsWith(".md") && f !== "test-deliver-rotate.md");
		assert.ok(rotated.length >= 1, `expected rotated file, got: ${allFiles.join(", ")}`);
	});
	it("blocks when verify_citations has not been called for this slug", async () => {
		const { tools } = makeMockPi();
		await initSwarm(tools, "test-deliver-no-verify", { agents: 100 });
		const swarmDir = getSwarmDir("test-deliver-no-verify");
		mkdirSync(resolve(swarmDir, "build"), { recursive: true });
		const artifact = resolve(swarmDir, "build", "final.md");
		writeFileSync(artifact, goodArtifact("X"));
		process.env.HOME = zenithHome;

		// Note: no appendVerifyCitationsPassed call here.
		const r = await callTool(tools, "deliver_artifact", { slug: "test-deliver-no-verify", artifactPath: artifact });
		assert.equal(r.details.delivered, false, `expected block, got: ${r.content[0].text}`);
		assert.match(r.content[0].text, /verify_citations/);
		assert.match(r.content[0].text, /DELIVERY_BLOCKED/);

		// Artifact should NOT have been copied to ~/research/
		const researchPath = resolve(zenithHome, "research", "test-deliver-no-verify.md");
		assert.equal(existsSync(researchPath), false, "should not publish when verify receipt is missing");

		// quality-gate.json should record the block with reason=verify-missing.
		const gatePath = resolve(swarmDir, "quality-gate.json");
		assert.ok(existsSync(gatePath), "quality-gate.json should be written on block");
		const gate = JSON.parse(readFileSync(gatePath, "utf8"));
		assert.equal(gate.delivered, false);
		assert.equal(gate.reason, "verify-missing");
	});

	it("writes quality-gate.json with evidence-graph stats on success", async () => {
		const { tools } = makeMockPi();
		await initSwarm(tools, "test-deliver-gate", { agents: 100 });
		const swarmDir = getSwarmDir("test-deliver-gate");
		mkdirSync(resolve(swarmDir, "build"), { recursive: true });
		const artifact = resolve(swarmDir, "build", "final.md");
		writeFileSync(artifact, goodArtifact("Q"));
		process.env.HOME = zenithHome;

		// Simulate an evidence graph: 5 round-1 assertions across 5 personas,
		// with one contradict + one qualify in round 2. That hits the floor of
		// 1 contradict per 5 assertions (5/5=1), so no pushback warning.
		const evPath = resolve(swarmDir, "evidence.jsonl");
		const entries = [
			{ id: "c_1", ts: "t", round: 1, persona: "p1", claim: "x", sources: [], kind: "assertion" },
			{ id: "c_2", ts: "t", round: 1, persona: "p2", claim: "x", sources: [], kind: "assertion" },
			{ id: "c_3", ts: "t", round: 1, persona: "p3", claim: "x", sources: [], kind: "assertion" },
			{ id: "c_4", ts: "t", round: 1, persona: "p4", claim: "x", sources: [], kind: "assertion" },
			{ id: "c_5", ts: "t", round: 1, persona: "p5", claim: "x", sources: [], kind: "assertion" },
			{ id: "c_6", ts: "t", round: 2, persona: "p6", claim: "x", sources: [], kind: "contradict", targetClaimId: "c_1" },
			{ id: "c_7", ts: "t", round: 2, persona: "p7", claim: "x", sources: [], kind: "qualify", targetClaimId: "c_2" },
		];
		writeFileSync(evPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

		appendVerifyCitationsPassed("test-deliver-gate", artifact);
		const r = await callTool(tools, "deliver_artifact", { slug: "test-deliver-gate", artifactPath: artifact });
		assert.equal(r.details.delivered, true, `expected success, got: ${r.content[0].text}`);

		const gatePath = resolve(swarmDir, "quality-gate.json");
		assert.ok(existsSync(gatePath));
		const gate = JSON.parse(readFileSync(gatePath, "utf8"));
		assert.equal(gate.delivered, true);
		assert.equal(gate.slug, "test-deliver-gate");
		assert.equal(gate.citations.inline, 2);
		assert.equal(gate.citations.sources, 2);
		assert.equal(gate.evidenceGraph.totalClaims, 7);
		assert.equal(gate.evidenceGraph.round1Assertions, 5);
		assert.equal(gate.evidenceGraph.round2.contradict, 1);
		assert.equal(gate.evidenceGraph.round2.qualify, 1);
		assert.equal(gate.evidenceGraph.pushback.minimumExpected, 1);
		assert.equal(gate.evidenceGraph.pushback.warn, false);
		assert.equal(gate.warnings.length, 0);
		assert.equal(typeof gate.verifyCitations.passedAt, "string");
		assert.equal(gate.verifyCitations.urlsChecked, 2);
	});

	it("quality-gate warns when round-2 pushback is too thin", async () => {
		const { tools } = makeMockPi();
		await initSwarm(tools, "test-deliver-shallow", { agents: 100 });
		const swarmDir = getSwarmDir("test-deliver-shallow");
		mkdirSync(resolve(swarmDir, "build"), { recursive: true });
		const artifact = resolve(swarmDir, "build", "final.md");
		writeFileSync(artifact, goodArtifact("S"));
		process.env.HOME = zenithHome;

		// 10 round-1 assertions, 0 round-2 contradicts — mirrors the
		// autogenesis-protocol-agp run we post-mortemed.
		const evPath = resolve(swarmDir, "evidence.jsonl");
		const entries = Array.from({ length: 10 }, (_, i) => ({
			id: `c_${i + 1}`, ts: "t", round: 1, persona: `p${i + 1}`,
			claim: "x", sources: [], kind: "assertion" as const,
		}));
		writeFileSync(evPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

		appendVerifyCitationsPassed("test-deliver-shallow", artifact);
		const r = await callTool(tools, "deliver_artifact", { slug: "test-deliver-shallow", artifactPath: artifact });
		assert.equal(r.details.delivered, true);

		const gate = JSON.parse(readFileSync(resolve(swarmDir, "quality-gate.json"), "utf8"));
		assert.equal(gate.evidenceGraph.round1Assertions, 10);
		assert.equal(gate.evidenceGraph.round2.contradict, 0);
		assert.equal(gate.evidenceGraph.pushback.minimumExpected, 2);
		assert.equal(gate.evidenceGraph.pushback.warn, true);
		assert.equal(gate.warnings.length >= 1, true);
		assert.match(gate.warnings[0], /shallow/);
	});
});

function goodArtifact(tag: string): string {
	return `# Report ${tag}\n\nSome claim [1] and another [2].\n\n## Sources\n\n1. First source at https://example.com/a\n2. Second source at https://example.com/b\n\n${"x".repeat(500)}\n`;
}


describe("run_swarm MiroFish mode (personas + rounds + executionMode)", () => {
	it("accepts a personas[] plan with 3 rounds", async () => {
		const { tools } = makeMockPi();
		const personas = Array.from({ length: 12 }, (_, i) => ({
			id: `statistics-specialist-${String(i).padStart(2, "0")}`,
			agent: "statistics-specialist",
			subQuestion: `sub-question ${i}`,
			lens: i % 2 === 0 ? "empiricist" : "critic",
			stance: i % 3 === 0 ? "advocate" : "skeptic",
		}));
		const res = await callTool(tools, "run_swarm", {
			slug: "mf-mode",
			query: "test",
			phases: [{ name: "scout", agents: ["scout"] }],
			personas,
			rounds: 3,
			executionMode: "sync",
			budget: "broad",
		});
		assert.ok(!res.details.rejected, `should accept MiroFish plan, got: ${JSON.stringify(res.details).slice(0, 200)}`);
	});

	it("rejects personas[] with fewer than 10", async () => {
		const { tools } = makeMockPi();
		const personas = [{ id: "p1", agent: "statistics-specialist", subQuestion: "q" }];
		const res = await callTool(tools, "run_swarm", {
			slug: "mf-too-few",
			query: "test",
			phases: [{ name: "scout", agents: ["scout"] }],
			personas,
			rounds: 3,
			budget: "broad",
		});
		assert.equal(res.details.rejected, true);
		assert.equal(res.details.personaCount, 1);
	});

	it("rejects MiroFish plan with fewer than 2 rounds", async () => {
		const { tools } = makeMockPi();
		const personas = Array.from({ length: 12 }, (_, i) => ({
			id: `p-${i}`, agent: "statistics-specialist", subQuestion: "q",
		}));
		const res = await callTool(tools, "run_swarm", {
			slug: "mf-too-short",
			query: "test",
			phases: [{ name: "scout", agents: ["scout"] }],
			personas,
			rounds: 1,
			budget: "broad",
		});
		assert.equal(res.details.rejected, true);
		assert.equal(res.details.rounds, 1);
	});

	it("defaults rounds=3 and executionMode=sync when personas[] is set without them", async () => {
		const { tools } = makeMockPi();
		const personas = Array.from({ length: 10 }, (_, i) => ({
			id: `p-${i}`, agent: "statistics-specialist", subQuestion: "q",
		}));
		const res = await callTool(tools, "run_swarm", {
			slug: "mf-defaults",
			query: "test",
			phases: [{ name: "scout", agents: ["scout"] }],
			personas,
			budget: "broad",
		});
		assert.ok(!res.details.rejected, "should accept default defaults");
	});
});
