/**
 * app-root.ts — locate the installed Zenith package root at runtime.
 *
 * Why: `src/cli.ts` needs to import `metadata/commands.mjs` (a hand-written
 * plain-ESM helper). In dev, the relative path `../metadata/commands.mjs`
 * resolves correctly from `src/cli.ts`. After `tsc` emits the compiled CLI
 * into `dist/src/cli.js`, that same literal resolves one level too deep
 * (to `dist/metadata/commands.mjs`, which does not exist).
 *
 * Rather than keep two hand-maintained copies of the helper, or baking a
 * depth-specific relative path into the source, this module walks up from
 * `import.meta.url` until it finds the enclosing `package.json`. That's
 * the canonical definition of "package root" in Node and works identically
 * for:
 *
 *   - dev (tsx, source) — stops at `/Users/you/zenith/`
 *   - local compile (dist/src/foo.js) — skips `dist/` and stops at the repo
 *   - installed (node_modules/zenith-agent/dist/src/foo.js) — stops at the
 *     installed package root
 *
 * Keep this module dependency-free so it can be imported early from the
 * startup path without pulling in the rest of the graph.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function findAppRoot(fromUrl: string): string {
	let dir = dirname(fileURLToPath(fromUrl));
	for (let i = 0; i < 10; i++) {
		if (existsSync(resolve(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`Cannot locate app root: no package.json above ${fromUrl}`);
}
