/**
 * Keep the inlined TOP_LEVEL_COMMAND_NAMES in src/cli.ts in sync with the
 * canonical list in metadata/commands.mjs. We inline it because importing
 * from metadata/commands.mjs would cross dist-layout boundaries; this test
 * is the leash that keeps the two copies honest.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { topLevelCommandNames } from "../metadata/commands.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliTs = readFileSync(resolve(here, "..", "src", "cli.ts"), "utf8");

function extractInlinedNames(): string[] {
	const m = cliTs.match(/const TOP_LEVEL_COMMAND_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const;/);
	assert.ok(m, "TOP_LEVEL_COMMAND_NAMES block not found in src/cli.ts");
	const raw = m[1];
	const names: string[] = [];
	for (const match of raw.matchAll(/"([^"]+)"/g)) names.push(match[1]);
	return names;
}

describe("TOP_LEVEL_COMMAND_NAMES sync", () => {
	it("matches metadata/commands.mjs exactly (same names, order-insensitive)", () => {
		const inlined = extractInlinedNames();
		assert.deepEqual(
			new Set(inlined),
			new Set(topLevelCommandNames),
			`Drift detected.\n  inlined:  ${inlined.sort().join(", ")}\n  metadata: ${[...topLevelCommandNames].sort().join(", ")}`,
		);
	});
});
