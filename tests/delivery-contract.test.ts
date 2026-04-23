/**
 * End-to-end integration: verify_citations and deliver_artifact share events.jsonl.
 *
 * These tests register BOTH tool sets against the same mock Pi and exercise
 * the full receipt chain:
 *
 *   run_swarm(slug)
 *     → verify_citations(filePath, slug)   // emits verify_citations_passed
 *         → deliver_artifact(slug, path)   // reads the event, allows delivery
 *
 * They intentionally set `checkUrls: false` so the tests do not make real
 * HTTP calls — the receipt gate only requires that a PASS verdict was
 * reached on the structural checks, which we exercise directly.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { registerOrchestrationTools } from "../extensions/research-tools/orchestration.js";
import { registerHallucinationGuard } from "../extensions/research-tools/hallucination-guard.js";

type AnyTool = {
	name: string;
	execute: (id: string, params: any, ...rest: any[]) => Promise<any>;
};

function makePi() {
	const tools: Record<string, AnyTool> = {};
	const pi = {
		registerTool: (t: AnyTool) => { tools[t.name] = t; },
		registerCommand: () => {},
		on: () => {},
		getCommands: () => [],
	} as any;
	registerOrchestrationTools(pi);
	registerHallucinationGuard(pi);
	return tools;
}

async function callTool(tools: Record<string, AnyTool>, name: string, params: any) {
	return tools[name].execute("t", params, undefined, undefined, {} as any);
}

let zhome: string;
let saved: { home?: string; zhome?: string };

beforeEach(() => {
	zhome = mkdtempSync(resolve(tmpdir(), "zenith-delivery-"));
	saved = { home: process.env.HOME, zhome: process.env.ZENITH_HOME };
	process.env.HOME = zhome;
	process.env.ZENITH_HOME = zhome;
});

afterEach(() => {
	if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
	if (saved.zhome === undefined) delete process.env.ZENITH_HOME; else process.env.ZENITH_HOME = saved.zhome;
	rmSync(zhome, { recursive: true, force: true });
});

function goodArtifact(): string {
	return "# Report\n\nClaim [1] and another [2].\n\n## Sources\n\n1. First at https://example.com/a\n2. Second at https://example.com/b\n\n" + "x".repeat(500);
}

async function initSwarm(tools: Record<string, AnyTool>, slug: string): Promise<void> {
	await callTool(tools, "run_swarm", {
		slug,
		query: "q",
		phases: [{ name: "scout", agents: Array.from({ length: 100 }, (_, i) => `a${i}`) }],
		budget: "broad",
	});
}

describe("full verify→deliver receipt chain", () => {
	it("verify_citations(slug) → deliver_artifact(slug) succeeds end-to-end", async () => {
		const tools = makePi();
		const slug = "contract-happy";
		await initSwarm(tools, slug);

		const swarmDir = resolve(zhome, "swarm-work", slug);
		const artifact = resolve(swarmDir, "build", "final.md");
		mkdirSync(resolve(swarmDir, "build"), { recursive: true });
		writeFileSync(artifact, goodArtifact());

		const vr = await callTool(tools, "verify_citations", { filePath: artifact, checkUrls: false, slug });
		assert.match(vr.content[0].text, /PASS/);

		const dr = await callTool(tools, "deliver_artifact", { slug, artifactPath: artifact });
		assert.equal(dr.details.delivered, true, `expected delivery, got: ${dr.content[0].text}`);

		const gate = JSON.parse(readFileSync(resolve(swarmDir, "quality-gate.json"), "utf8"));
		assert.equal(gate.delivered, true);
		assert.equal(gate.citations.inline, 2);
		assert.ok(typeof gate.verifyCitations.passedAt === "string" && gate.verifyCitations.passedAt.length > 0);
	});

	it("skipping verify_citations blocks delivery even when structure is clean", async () => {
		const tools = makePi();
		const slug = "contract-skip";
		await initSwarm(tools, slug);

		const swarmDir = resolve(zhome, "swarm-work", slug);
		const artifact = resolve(swarmDir, "build", "final.md");
		mkdirSync(resolve(swarmDir, "build"), { recursive: true });
		writeFileSync(artifact, goodArtifact());

		const dr = await callTool(tools, "deliver_artifact", { slug, artifactPath: artifact });
		assert.equal(dr.details.delivered, false);
		assert.match(dr.content[0].text, /verify_citations/);

		// No ~/research/ copy.
		assert.equal(existsSync(resolve(zhome, "research", `${slug}.md`)), false);
	});

	it("verify_citations without slug does NOT unblock delivery", async () => {
		const tools = makePi();
		const slug = "contract-no-slug";
		await initSwarm(tools, slug);

		const swarmDir = resolve(zhome, "swarm-work", slug);
		const artifact = resolve(swarmDir, "build", "final.md");
		mkdirSync(resolve(swarmDir, "build"), { recursive: true });
		writeFileSync(artifact, goodArtifact());

		// Call verify_citations without slug — PASS, but no event emitted.
		const vr = await callTool(tools, "verify_citations", { filePath: artifact, checkUrls: false });
		assert.match(vr.content[0].text, /PASS/);

		const dr = await callTool(tools, "deliver_artifact", { slug, artifactPath: artifact });
		assert.equal(dr.details.delivered, false);
		assert.match(dr.content[0].text, /verify_citations/);
	});
});
