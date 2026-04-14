import test from "node:test";
import assert from "node:assert/strict";

import {
	MIN_NODE_VERSION,
	ensureSupportedNodeVersion,
	getUnsupportedNodeVersionLines,
	isSupportedNodeVersion,
} from "../src/system/node-version.js";

test("isSupportedNodeVersion enforces the exact minimum floor", () => {
	assert.equal(isSupportedNodeVersion("20.19.0"), true);
	assert.equal(isSupportedNodeVersion("20.19.0"), true);
	assert.equal(isSupportedNodeVersion("21.0.0"), true);
	assert.equal(isSupportedNodeVersion("20.18.1"), false);
	assert.equal(isSupportedNodeVersion("18.17.0"), false);
});

test("ensureSupportedNodeVersion throws a guided upgrade message", () => {
	assert.throws(
		() => ensureSupportedNodeVersion("18.17.0"),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes(`Node.js ${MIN_NODE_VERSION}`) &&
			error.message.includes("nvm install 20 && nvm use 20") &&
			error.message.includes("https://zenith.is/install"),
	);
});

test("unsupported version guidance reports the detected version", () => {
	const lines = getUnsupportedNodeVersionLines("18.17.0");

	assert.equal(lines[0], "zenith requires Node.js 20.19.0 or later (detected 18.17.0).");
	assert.ok(lines.some((line) => line.includes("curl -fsSL https://zenith.is/install | bash")));
});
