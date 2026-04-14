import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { syncBundledAssets } from "../src/bootstrap/sync.js";

function createAppRoot(): string {
	const appRoot = mkdtempSync(join(tmpdir(), "zenith-app-"));
	mkdirSync(join(appRoot, ".zenith", "themes"), { recursive: true });
	mkdirSync(join(appRoot, ".zenith", "agents"), { recursive: true });
	writeFileSync(join(appRoot, ".zenith", "themes", "zenith.json"), '{"theme":"v1"}\n', "utf8");
	writeFileSync(join(appRoot, ".zenith", "agents", "researcher.md"), "# v1\n", "utf8");
	return appRoot;
}

test("syncBundledAssets copies missing bundled files", () => {
	const appRoot = createAppRoot();
	const home = mkdtempSync(join(tmpdir(), "zenith-home-"));
	process.env.ZENITH_HOME = home;
	const agentDir = join(home, "agent");
	mkdirSync(agentDir, { recursive: true });

	const result = syncBundledAssets(appRoot, agentDir);

	assert.deepEqual(result.copied.sort(), ["researcher.md", "zenith.json"]);
	assert.equal(readFileSync(join(agentDir, "themes", "zenith.json"), "utf8"), '{"theme":"v1"}\n');
	assert.equal(readFileSync(join(agentDir, "agents", "researcher.md"), "utf8"), "# v1\n");
});

test("syncBundledAssets preserves user-modified files and updates managed files", () => {
	const appRoot = createAppRoot();
	const home = mkdtempSync(join(tmpdir(), "zenith-home-"));
	process.env.ZENITH_HOME = home;
	const agentDir = join(home, "agent");
	mkdirSync(agentDir, { recursive: true });

	syncBundledAssets(appRoot, agentDir);

	writeFileSync(join(appRoot, ".zenith", "themes", "zenith.json"), '{"theme":"v2"}\n', "utf8");
	writeFileSync(join(appRoot, ".zenith", "agents", "researcher.md"), "# v2\n", "utf8");
	writeFileSync(join(agentDir, "agents", "researcher.md"), "# user-custom\n", "utf8");

	const result = syncBundledAssets(appRoot, agentDir);

	assert.deepEqual(result.updated, ["zenith.json"]);
	assert.deepEqual(result.skipped, ["researcher.md"]);
	assert.equal(readFileSync(join(agentDir, "themes", "zenith.json"), "utf8"), '{"theme":"v2"}\n');
	assert.equal(readFileSync(join(agentDir, "agents", "researcher.md"), "utf8"), "# user-custom\n");
});

test("syncBundledAssets removes deleted managed files but preserves user-modified stale files", () => {
	const appRoot = createAppRoot();
	const home = mkdtempSync(join(tmpdir(), "zenith-home-"));
	process.env.ZENITH_HOME = home;
	const agentDir = join(home, "agent");
	mkdirSync(agentDir, { recursive: true });

	mkdirSync(join(appRoot, "skills", "paper-eli5"), { recursive: true });
	writeFileSync(join(appRoot, "skills", "paper-eli5", "SKILL.md"), "# old skill\n", "utf8");
	syncBundledAssets(appRoot, agentDir);

	rmSync(join(appRoot, "skills", "paper-eli5"), { recursive: true, force: true });
	mkdirSync(join(appRoot, "skills", "eli5"), { recursive: true });
	writeFileSync(join(appRoot, "skills", "eli5", "SKILL.md"), "# new skill\n", "utf8");

	const firstResult = syncBundledAssets(appRoot, agentDir);
	assert.deepEqual(firstResult.copied, ["eli5/SKILL.md"]);
	assert.equal(existsSync(join(agentDir, "skills", "paper-eli5", "SKILL.md")), false);
	assert.equal(readFileSync(join(agentDir, "skills", "eli5", "SKILL.md"), "utf8"), "# new skill\n");

	mkdirSync(join(appRoot, "skills", "legacy"), { recursive: true });
	writeFileSync(join(appRoot, "skills", "legacy", "SKILL.md"), "# managed legacy\n", "utf8");
	syncBundledAssets(appRoot, agentDir);
	writeFileSync(join(agentDir, "skills", "legacy", "SKILL.md"), "# user legacy override\n", "utf8");
	rmSync(join(appRoot, "skills", "legacy"), { recursive: true, force: true });

	const secondResult = syncBundledAssets(appRoot, agentDir);
	assert.deepEqual(secondResult.skipped, ["legacy/SKILL.md"]);
	assert.equal(readFileSync(join(agentDir, "skills", "legacy", "SKILL.md"), "utf8"), "# user legacy override\n");
});
