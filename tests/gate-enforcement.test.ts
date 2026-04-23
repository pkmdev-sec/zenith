import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { registerGateEnforcement } from "../extensions/research-tools/gate-enforcement.js";
import { registerOrchestrationTools } from "../extensions/research-tools/orchestration.js";

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function makeMockPi() {
	const tools: Record<string, any> = {};
	const handlers: Record<string, Handler[]> = {};
	const pi = {
		registerTool: (t: any) => { tools[t.name] = t; },
		registerCommand: () => {},
		on: (event: string, handler: Handler) => {
			(handlers[event] ??= []).push(handler);
		},
		getCommands: () => [],
	} as any;
	registerOrchestrationTools(pi);
	registerGateEnforcement(pi);
	return { pi, tools, handlers };
}

async function callTool(tools: any, name: string, params: any) {
	return tools[name].execute("t", params, undefined, undefined, {} as any);
}

async function fireToolCall(handlers: Record<string, Handler[]>, event: any): Promise<any[]> {
	const results: any[] = [];
	for (const h of handlers["tool_call"] ?? []) {
		const r = await h(event, {});
		if (r) results.push(r);
	}
	return results;
}

function appendVerifyCitationsPassed(swarmDir: string, artifactPath: string): void {
	// Simulate a prior verify_citations(filePath, slug) PASS run by appending the
	// receipt event directly — avoids making real HTTP calls in this gate test.
	const eventsPath = resolve(swarmDir, "events.jsonl");
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

let zhome: string;
let saved: { home?: string; zhome?: string };

beforeEach(() => {
	zhome = mkdtempSync(resolve(tmpdir(), "zenith-enf-"));
	saved = { home: process.env.HOME, zhome: process.env.ZENITH_HOME };
	process.env.ZENITH_HOME = zhome;
	process.env.HOME = zhome; // so ~/research resolves under test dir
});

afterEach(() => {
	if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
	if (saved.zhome === undefined) delete process.env.ZENITH_HOME; else process.env.ZENITH_HOME = saved.zhome;
	rmSync(zhome, { recursive: true, force: true });
});

describe("gate-enforcement: delivery gate", () => {
	it("blocks raw write to ~/research/*.md when not delivered", async () => {
		const { handlers } = makeMockPi();
		const researchPath = resolve(zhome, "research", "rogue-slug.md");
		const results = await fireToolCall(handlers, {
			type: "tool_call",
			toolCallId: "c1",
			toolName: "write",
			input: { file_path: researchPath, content: "fake" },
		});
		assert.equal(results.length, 1, "should produce a block decision");
		assert.equal(results[0].block, true, "should block");
		assert.match(results[0].reason, /deliver_artifact/);
	});

	it("blocks bash `cat > ~/research/slug.md`", async () => {
		const { handlers } = makeMockPi();
		const results = await fireToolCall(handlers, {
			type: "tool_call", toolCallId: "c2", toolName: "bash",
			input: { command: `cat > ${zhome}/research/evil.md <<EOF\ndata\nEOF` },
		});
		assert.equal(results[0]?.block, true, `should block, got ${JSON.stringify(results)}`);
	});

	it("allows write to ~/research/<slug>.md after deliver_artifact", async () => {
		const { tools, handlers } = makeMockPi();
		// First initialize a swarm and deliver an artifact. This writes a
		// `delivered` event to the swarm's event log.
		await callTool(tools, "run_swarm", {
			slug: "approved-slug",
			query: "q",
			phases: [{ name: "scout", agents: Array.from({ length: 100 }, (_, i) => `a${i}`) }],
			budget: "broad",
		});

		// Create an artifact with matching inline/sources
		const swarmDir = resolve(zhome, "swarm-work", "approved-slug");
		mkdirSync(resolve(swarmDir, "build"), { recursive: true });
		const artifact = resolve(swarmDir, "build", "final.md");
		writeFileSync(artifact,
			"# Report\n\nClaim [1] and another [2].\n\n## Sources\n\n1. First at https://example.com/a\n2. Second at https://example.com/b\n\n" +
			"x".repeat(500));
		appendVerifyCitationsPassed(swarmDir, artifact);

		const dres = await callTool(tools, "deliver_artifact", { slug: "approved-slug", artifactPath: artifact });
		assert.equal(dres.details.delivered, true, `deliver_artifact should succeed, got: ${dres.content[0].text}`);

		// Now a write to ~/research/approved-slug.md should be allowed (it's the approved target).
		const researchPath = resolve(zhome, "research", "approved-slug.md");
		const results = await fireToolCall(handlers, {
			type: "tool_call", toolCallId: "c3", toolName: "write",
			input: { file_path: researchPath, content: "update" },
		});
		assert.equal(results.length, 0, `should not block after delivery, got ${JSON.stringify(results)}`);
	});

	it("ignores writes outside ~/research/", async () => {
		const { handlers } = makeMockPi();
		const results = await fireToolCall(handlers, {
			type: "tool_call", toolCallId: "c4", toolName: "write",
			input: { file_path: resolve(zhome, "some-other-file.md"), content: "x" },
		});
		assert.equal(results.length, 0);
	});
});

describe("gate-enforcement: subagent gate", () => {
	it("allows subagent when no active swarm exists (permissive)", async () => {
		const { handlers } = makeMockPi();
		// No swarm initialized → listActiveSwarms() returns [].
		const results = await fireToolCall(handlers, {
			type: "tool_call", toolCallId: "c5", toolName: "subagent",
			input: { agent: "researcher", task: "test", agentId: "arbitrary" },
		});
		assert.equal(results.length, 0);
	});

	it("blocks subagent with unapproved agentId when a swarm is active", async () => {
		const { tools, handlers } = makeMockPi();
		await callTool(tools, "run_swarm", {
			slug: "enf-test",
			query: "q",
			phases: [{ name: "scout", agents: Array.from({ length: 100 }, (_, i) => `a${i}`) }],
			budget: "broad",
		});
		// Calling subagent WITHOUT first calling log_agent_spawn
		const results = await fireToolCall(handlers, {
			type: "tool_call", toolCallId: "c6", toolName: "subagent",
			input: { agent: "researcher", task: "hi", agentId: "not-approved" },
		});
		assert.equal(results[0]?.block, true, `should block unapproved, got ${JSON.stringify(results)}`);
	});

	it("allows subagent after log_agent_spawn approves the agentId", async () => {
		const { tools, handlers } = makeMockPi();
		await callTool(tools, "run_swarm", {
			slug: "enf-ok",
			query: "q",
			phases: [{ name: "scout", agents: Array.from({ length: 100 }, (_, i) => `a${i}`) }],
			budget: "broad",
		});
		await callTool(tools, "log_agent_spawn", {
			slug: "enf-ok", agentName: "researcher", agentId: "a-approved", phase: "scout",
		});
		const results = await fireToolCall(handlers, {
			type: "tool_call", toolCallId: "c7", toolName: "subagent",
			input: { agent: "researcher", task: "hi", agentId: "a-approved" },
		});
		assert.equal(results.length, 0, `should allow, got ${JSON.stringify(results)}`);
	});

	it("is permissive when agentId is absent (non-swarm delegation)", async () => {
		const { tools, handlers } = makeMockPi();
		await callTool(tools, "run_swarm", {
			slug: "enf-any",
			query: "q",
			phases: [{ name: "scout", agents: Array.from({ length: 100 }, (_, i) => `a${i}`) }],
			budget: "broad",
		});
		const results = await fireToolCall(handlers, {
			type: "tool_call", toolCallId: "c8", toolName: "subagent",
			input: { agent: "researcher", task: "one-off" }, // no agentId
		});
		assert.equal(results.length, 0);
	});
});
