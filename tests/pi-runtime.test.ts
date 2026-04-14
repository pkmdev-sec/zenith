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

test("resolvePiPaths includes the Promise.withResolvers polyfill path", () => {
	const paths = resolvePiPaths("/repo/zenith");

	assert.equal(paths.promisePolyfillPath, "/repo/zenith/dist/system/promise-polyfill.js");
});
