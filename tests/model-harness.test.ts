import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveInitialPrompt } from "../src/cli.js";
import { buildModelStatusSnapshotFromRecords, chooseRecommendedModel } from "../src/model/catalog.js";
import { setDefaultModelSpec } from "../src/model/commands.js";

function createAuthPath(contents: Record<string, unknown>): string {
	const root = mkdtempSync(join(tmpdir(), "zenith-auth-"));
	const authPath = join(root, "auth.json");
	writeFileSync(authPath, JSON.stringify(contents, null, 2) + "\n", "utf8");
	return authPath;
}

test("chooseRecommendedModel prefers the strongest authenticated research model", () => {
	const authPath = createAuthPath({
		openai: { type: "api_key", key: "openai-test-key" },
		anthropic: { type: "api_key", key: "anthropic-test-key" },
	});

	const recommendation = chooseRecommendedModel(authPath);

	assert.equal(recommendation?.spec, "anthropic/claude-opus-4-6");
});

test("setDefaultModelSpec accepts a unique bare model id from authenticated models", () => {
	const authPath = createAuthPath({
		openai: { type: "api_key", key: "openai-test-key" },
	});
	const settingsPath = join(mkdtempSync(join(tmpdir(), "zenith-settings-")), "settings.json");

	setDefaultModelSpec(settingsPath, authPath, "gpt-5.4");

	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
		defaultProvider?: string;
		defaultModel?: string;
	};
	assert.equal(settings.defaultProvider, "openai");
	assert.equal(settings.defaultModel, "gpt-5.4");
});

test("buildModelStatusSnapshotFromRecords flags an invalid current model and suggests a replacement", () => {
	const snapshot = buildModelStatusSnapshotFromRecords(
		[
			{ provider: "anthropic", id: "claude-opus-4-6" },
			{ provider: "openai", id: "gpt-5.4" },
		],
		[{ provider: "openai", id: "gpt-5.4" }],
		"anthropic/claude-opus-4-6",
	);

	assert.equal(snapshot.currentValid, false);
	assert.equal(snapshot.recommended, "openai/gpt-5.4");
	assert.ok(snapshot.guidance.some((line) => line.includes("Configured default model is unavailable")));
});

test("resolveInitialPrompt maps top-level research commands to Pi slash workflows", () => {
	const workflows = new Set(["lit", "watch", "jobs", "deepresearch"]);
	assert.equal(resolveInitialPrompt("lit", ["tool-using", "agents"], undefined, workflows, false, false), "/lit tool-using agents");
	assert.equal(resolveInitialPrompt("watch", ["openai"], undefined, workflows, false, false), "/watch openai");
	assert.equal(resolveInitialPrompt("jobs", [], undefined, workflows, false, false), "/jobs");
	assert.equal(resolveInitialPrompt("chat", ["hello"], undefined, workflows, false, false), "hello");
	assert.equal(resolveInitialPrompt("unknown", ["topic"], undefined, workflows, false, false), "unknown topic");
});

test("resolveInitialPrompt routes bare text through /orchestrate when swarmDefault is true", () => {
	const workflows = new Set(["lit", "watch", "jobs", "deepresearch"]);
	assert.strictEqual(
		resolveInitialPrompt("scaling", ["laws", "in", "LLMs"], undefined, workflows, true, false),
		"/orchestrate scaling laws in LLMs",
	);
});

test("resolveInitialPrompt bypasses swarm routing when --direct is set", () => {
	const workflows = new Set(["lit", "watch", "jobs", "deepresearch"]);
	assert.strictEqual(
		resolveInitialPrompt("scaling", ["laws", "in", "LLMs"], undefined, workflows, true, true),
		"scaling laws in LLMs",
	);
});
