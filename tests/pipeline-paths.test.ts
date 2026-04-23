import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { registerPipelineTools } from "../extensions/research-tools/pipeline.js";

type AnyTool = {
	name: string;
	execute: (id: string, params: any, ...rest: any[]) => Promise<any>;
};

function makeMockPi() {
	const tools: Record<string, AnyTool> = {};
	const pi = { registerTool: (t: AnyTool) => { tools[t.name] = t; } } as any;
	registerPipelineTools(pi);
	return { tools };
}

let zhome: string;
let saved: { home?: string; zhome?: string };

beforeEach(() => {
	zhome = mkdtempSync(resolve(tmpdir(), "zenith-pipeline-"));
	saved = { home: process.env.HOME, zhome: process.env.ZENITH_HOME };
	process.env.ZENITH_HOME = zhome;
});

afterEach(() => {
	if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
	if (saved.zhome === undefined) delete process.env.ZENITH_HOME; else process.env.ZENITH_HOME = saved.zhome;
	rmSync(zhome, { recursive: true, force: true });
});

describe("pipeline checkpoint paths", () => {
	it("writes checkpoints under ~/.zenith/swarm-work/<slug>/checkpoints/", async () => {
		const { tools } = makeMockPi();
		const save = tools["save_checkpoint"];
		assert.ok(save);
		const artifact = resolve(zhome, "stub.md");
		writeFileSync(artifact, "x");
		const res = await save.execute("t", {
			slug: "test-slug",
			stage: "plan",
			workflow: "deepresearch",
			artifacts: [artifact],
			completedStages: ["plan"],
		}, undefined, undefined, {} as any);
		assert.equal(res.details.slug, "test-slug");
		const expected = resolve(zhome, "swarm-work", "test-slug", "checkpoints");
		assert.ok(existsSync(expected), `expected checkpoint dir at ${expected}`);
		assert.ok(existsSync(resolve(expected, "plan.json")), "stage file should exist");
		assert.ok(existsSync(resolve(expected, "latest.json")), "latest.json should exist");
	});

	it("load_checkpoint reads from swarm-work path", async () => {
		const { tools } = makeMockPi();
		const save = tools["save_checkpoint"];
		const load = tools["load_checkpoint"];
		const artifact = resolve(zhome, "stub.md");
		writeFileSync(artifact, "x");
		await save.execute("t", {
			slug: "test-load",
			stage: "research",
			workflow: "deepresearch",
			artifacts: [artifact],
			completedStages: ["plan", "research"],
		}, undefined, undefined, {} as any);
		const res = await load.execute("t", { slug: "test-load" }, undefined, undefined, {} as any);
		assert.equal(res.details?.stage, "research");
		assert.equal(res.details?.workflow, "deepresearch");
	});

	it("load_checkpoint on unknown slug returns a 'no checkpoints' message without crashing", async () => {
		const { tools } = makeMockPi();
		const load = tools["load_checkpoint"];
		const res = await load.execute("t", { slug: "nothing-here" }, undefined, undefined, {} as any);
		assert.ok(String(res.content[0].text).toLowerCase().includes("no checkpoints"));
	});
});
