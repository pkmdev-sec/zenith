import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { registerOrchestrationTools } from "../extensions/research-tools/orchestration.js";

function loadClassifier() {
	const tools: Record<string, any> = {};
	const pi = { registerTool: (t: any) => { tools[t.name] = t; }, registerCommand: () => {}, on: () => {} } as any;
	registerOrchestrationTools(pi);
	return tools["classify_intent"];
}

async function classify(query: string) {
	const tool = loadClassifier();
	return tool.execute("t", { query }, undefined, undefined, {} as any);
}

describe("classify_intent", () => {
	it("routes slash commands to explicit workflow", async () => {
		const r = await classify("/deepresearch scaling laws");
		assert.equal(r.details.isResearch, false);
		assert.equal(r.details.explicitWorkflow, "deepresearch");
		assert.ok(r.details.confidence >= 0.95);
	});

	it("marks short factual questions as trivial", async () => {
		const r = await classify("Who wrote the attention is all you need paper?");
		assert.equal(r.details.isResearch, false);
		assert.equal(r.details.taskType, "trivial-lookup");
	});

	it("treats multi-domain questions as research", async () => {
		const r = await classify("How does reinforcement learning compare with imitation learning for robotics control?");
		assert.equal(r.details.isResearch, true);
		assert.ok(r.details.domains.length >= 2, `expected >=2 domains, got ${JSON.stringify(r.details.domains)}`);
	});

	it("detects comparison task type", async () => {
		const r = await classify("Compare diffusion models versus autoregressive models for image generation");
		assert.equal(r.details.taskType, "comparison");
	});

	it("detects survey task type", async () => {
		const r = await classify("What is the state of the art in mechanistic interpretability research?");
		assert.equal(r.details.taskType, "survey");
	});

	it("is deterministic on the same input", async () => {
		const a = await classify("Analyze the latest results in protein folding from alphafold");
		const b = await classify("Analyze the latest results in protein folding from alphafold");
		assert.deepEqual(a.details, b.details);
	});
});
