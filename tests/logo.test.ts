/**
 * The ASCII logo lives in two places: `logo.mjs` at the repo root (consumed
 * by `scripts/patch-embedded-pi.mjs` + extensions) and inlined at the top of
 * `src/ui/terminal.ts` (so the CLI's compiled output in `dist/src/ui/` has
 * no cross-layout relative path to worry about). This test makes sure the
 * two copies stay byte-identical so a drift can't silently ship.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ZENITH_ASCII_LOGO as ROOT_LOGO } from "../logo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const terminalTs = readFileSync(resolve(here, "..", "src", "ui", "terminal.ts"), "utf8");

describe("ZENITH ASCII logo consistency", () => {
	it("every line of `logo.mjs` appears in `src/ui/terminal.ts`", () => {
		for (const line of ROOT_LOGO) {
			assert.ok(
				terminalTs.includes(line),
				`Line not found in terminal.ts:\n${line}\n\nUpdate src/ui/terminal.ts to match logo.mjs after editing the art.`,
			);
		}
	});

	it("count of banner lines matches", () => {
		// A permissive count: every line beginning with a tab + quote inside
		// the declared array block.
		const block = terminalTs.match(/const ZENITH_ASCII_LOGO[\s\S]*?\];/);
		assert.ok(block, "ZENITH_ASCII_LOGO block not found");
		const entries = block[0].match(/"\s/gu)?.length ?? 0;
		// Each of the 5 entries has a leading space after the opening quote.
		assert.equal(entries, ROOT_LOGO.length, "terminal.ts logo has a different number of entries than logo.mjs");
	});
});
