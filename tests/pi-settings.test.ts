import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CORE_PACKAGE_SOURCES, getOptionalPackagePresetSources, shouldPruneLegacyDefaultPackages } from "../src/pi/package-presets.js";
import { normalizeZenithSettings, normalizeThinkingLevel } from "../src/pi/settings.js";

test("normalizeThinkingLevel accepts the latest Pi thinking levels", () => {
	assert.equal(normalizeThinkingLevel("off"), "off");
	assert.equal(normalizeThinkingLevel("minimal"), "minimal");
	assert.equal(normalizeThinkingLevel("low"), "low");
	assert.equal(normalizeThinkingLevel("medium"), "medium");
	assert.equal(normalizeThinkingLevel("high"), "high");
	assert.equal(normalizeThinkingLevel("xhigh"), "xhigh");
});

test("normalizeThinkingLevel rejects unknown values", () => {
	assert.equal(normalizeThinkingLevel("turbo"), undefined);
	assert.equal(normalizeThinkingLevel(undefined), undefined);
});

test("normalizeZenithSettings seeds the fast core package set", () => {
	const root = mkdtempSync(join(tmpdir(), "zenith-settings-"));
	const settingsPath = join(root, "settings.json");
	const bundledSettingsPath = join(root, "bundled-settings.json");
	const authPath = join(root, "auth.json");

	writeFileSync(bundledSettingsPath, "{}\n", "utf8");
	writeFileSync(authPath, "{}\n", "utf8");

	normalizeZenithSettings(settingsPath, bundledSettingsPath, "medium", authPath);

	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: string[] };
	assert.deepEqual(settings.packages, [...CORE_PACKAGE_SOURCES]);
});

test("normalizeZenithSettings prunes the legacy slow default package set", () => {
	const root = mkdtempSync(join(tmpdir(), "zenith-settings-"));
	const settingsPath = join(root, "settings.json");
	const bundledSettingsPath = join(root, "bundled-settings.json");
	const authPath = join(root, "auth.json");

	writeFileSync(
		settingsPath,
		JSON.stringify(
			{
				packages: [
					...CORE_PACKAGE_SOURCES,
					"npm:pi-generative-ui",
				],
			},
			null,
			2,
		) + "\n",
		"utf8",
	);
	writeFileSync(bundledSettingsPath, "{}\n", "utf8");
	writeFileSync(authPath, "{}\n", "utf8");

	normalizeZenithSettings(settingsPath, bundledSettingsPath, "medium", authPath);

	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: string[] };
	assert.deepEqual(settings.packages, [...CORE_PACKAGE_SOURCES]);
});

test("optional package presets map friendly aliases", () => {
	assert.deepEqual(getOptionalPackagePresetSources("memory"), undefined);
	assert.deepEqual(getOptionalPackagePresetSources("ui"), ["npm:pi-generative-ui"]);
	assert.deepEqual(getOptionalPackagePresetSources("search"), undefined);
	assert.equal(shouldPruneLegacyDefaultPackages(["npm:custom"]), false);
});
