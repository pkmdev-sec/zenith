import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	formatPiWebAccessDoctorLines,
	getPiWebAccessStatus,
	getPiWebSearchConfigPath,
	loadPiWebAccessConfig,
} from "../src/pi/web-access.js";

test("loadPiWebAccessConfig returns empty config when Pi web config is missing", () => {
	const root = mkdtempSync(join(tmpdir(), "zenith-pi-web-"));
	const configPath = getPiWebSearchConfigPath(root);

	assert.deepEqual(loadPiWebAccessConfig(configPath), {});
});

test("getPiWebAccessStatus reads Pi web-access config directly", () => {
	const root = mkdtempSync(join(tmpdir(), "zenith-pi-web-"));
	const configPath = getPiWebSearchConfigPath(root);
	mkdirSync(join(root, ".zenith"), { recursive: true });
	writeFileSync(
		configPath,
		JSON.stringify({
			provider: "gemini",
			searchProvider: "gemini",
			chromeProfile: "Profile 2",
			geminiApiKey: "AIza...",
		}),
		"utf8",
	);

	const status = getPiWebAccessStatus(loadPiWebAccessConfig(configPath), configPath);
	assert.equal(status.routeLabel, "Gemini");
	assert.equal(status.requestProvider, "gemini");
	assert.equal(status.geminiApiConfigured, true);
	assert.equal(status.perplexityConfigured, false);
	assert.equal(status.chromeProfile, "Profile 2");
});

test("formatPiWebAccessDoctorLines reports Pi-managed web access", () => {
	const lines = formatPiWebAccessDoctorLines(
		getPiWebAccessStatus({
			provider: "auto",
			searchProvider: "auto",
		}, "/tmp/pi-web-search.json"),
	);

	assert.equal(lines[0], "web access: pi-web-access");
	assert.ok(lines.some((line) => line.includes("/tmp/pi-web-search.json")));
});
