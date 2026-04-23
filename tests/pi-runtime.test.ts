import test from "node:test";
import assert from "node:assert/strict";

import { buildPiArgs, buildPiEnv, resolvePiPaths } from "../src/pi/runtime.js";

test("buildPiArgs includes configured runtime paths and prompt", () => {
	const args = buildPiArgs({
		appRoot: "/repo/zenith",
		workingDir: "/workspace",
		sessionDir: "/sessions",
		zenithAgentDir: "/home/.zenith/agent",
		initialPrompt: "hello",
		explicitModelSpec: "openai:gpt-5.4",
		thinkingLevel: "medium",
	});

	assert.deepEqual(args, [
		"--session-dir",
		"/sessions",
		"--extension",
		"/repo/zenith/extensions/research-tools.ts",
		"--prompt-template",
		"/repo/zenith/prompts",
		"--model",
		"openai:gpt-5.4",
		"--thinking",
		"medium",
		"hello",
	]);
});

test("buildPiEnv wires Zenith paths into the Pi environment", () => {
	const previousUppercasePrefix = process.env.NPM_CONFIG_PREFIX;
	const previousLowercasePrefix = process.env.npm_config_prefix;
	process.env.NPM_CONFIG_PREFIX = "/tmp/global-prefix";
	process.env.npm_config_prefix = "/tmp/global-prefix-lower";

	const env = buildPiEnv({
		appRoot: "/repo/zenith",
		workingDir: "/workspace",
		sessionDir: "/sessions",
		zenithAgentDir: "/home/.zenith/agent",
		zenithVersion: "0.1.5",
	});

	try {
		assert.equal(env.ZENITH_SESSION_DIR, "/sessions");
		assert.equal(env.ZENITH_BIN_PATH, "/repo/zenith/bin/zenith.js");
		assert.equal(env.ZENITH_MEMORY_DIR, "/home/.zenith/memory");
		assert.equal(env.ZENITH_NPM_PREFIX, "/home/.zenith/npm-global");
		assert.equal(env.NPM_CONFIG_PREFIX, "/home/.zenith/npm-global");
		assert.equal(env.npm_config_prefix, "/home/.zenith/npm-global");
		assert.equal(env.PI_CODING_AGENT_DIR, "/home/.zenith/agent");
		assert.ok(
			env.PATH?.startsWith(
				"/repo/zenith/node_modules/.bin:/repo/zenith/.zenith/npm/node_modules/.bin:/home/.zenith/npm-global/bin:",
			),
		);
	} finally {
		if (previousUppercasePrefix === undefined) {
			delete process.env.NPM_CONFIG_PREFIX;
		} else {
			process.env.NPM_CONFIG_PREFIX = previousUppercasePrefix;
		}
		if (previousLowercasePrefix === undefined) {
			delete process.env.npm_config_prefix;
		} else {
			process.env.npm_config_prefix = previousLowercasePrefix;
		}
	}
});

test("buildPiEnv strips ANTHROPIC_MODEL and related collide-with-pin env vars", () => {
	const saved = {
		model: process.env.ANTHROPIC_MODEL,
		maxTokens: process.env.ANTHROPIC_MAX_TOKENS,
		smallFast: process.env.ANTHROPIC_SMALL_FAST_MODEL,
		claude: process.env.CLAUDE_MODEL,
	};
	process.env.ANTHROPIC_MODEL = "claude-rogue-3.5";
	process.env.ANTHROPIC_MAX_TOKENS = "128000";
	process.env.ANTHROPIC_SMALL_FAST_MODEL = "claude-haiku-4-5";
	process.env.CLAUDE_MODEL = "claude-whatever";

	try {
		const env = buildPiEnv({
			appRoot: "/repo/zenith",
			workingDir: "/workspace",
			sessionDir: "/sessions",
			zenithAgentDir: "/home/.zenith/agent",
			zenithVersion: "0.1.5",
		});

		assert.equal(env.ANTHROPIC_MODEL, undefined, "ANTHROPIC_MODEL must not leak into Pi env");
		assert.equal(env.ANTHROPIC_MAX_TOKENS, undefined, "ANTHROPIC_MAX_TOKENS must not leak");
		assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, undefined, "ANTHROPIC_SMALL_FAST_MODEL must not leak");
		assert.equal(env.CLAUDE_MODEL, undefined, "CLAUDE_MODEL must not leak");
		// Caller process.env is untouched (we only strip from the child env).
		assert.equal(process.env.ANTHROPIC_MODEL, "claude-rogue-3.5");
	} finally {
		if (saved.model === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = saved.model;
		if (saved.maxTokens === undefined) delete process.env.ANTHROPIC_MAX_TOKENS; else process.env.ANTHROPIC_MAX_TOKENS = saved.maxTokens;
		if (saved.smallFast === undefined) delete process.env.ANTHROPIC_SMALL_FAST_MODEL; else process.env.ANTHROPIC_SMALL_FAST_MODEL = saved.smallFast;
		if (saved.claude === undefined) delete process.env.CLAUDE_MODEL; else process.env.CLAUDE_MODEL = saved.claude;
	}
});

test("resolvePiPaths includes the Promise.withResolvers polyfill path", () => {
	const paths = resolvePiPaths("/repo/zenith");

	assert.equal(paths.promisePolyfillPath, "/repo/zenith/dist/system/promise-polyfill.js");
});
