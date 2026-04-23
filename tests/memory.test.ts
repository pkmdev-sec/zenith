import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
	appendPersonaMemory,
	readPersonaMemory,
	registerMemoryTools,
} from "../extensions/research-tools/memory.js";

function makeMockPi() {
	const tools: Record<string, any> = {};
	const pi = {
		registerTool: (t: any) => { tools[t.name] = t; },
		registerCommand: () => {},
		on: () => {},
	} as any;
	registerMemoryTools(pi);
	return { tools };
}

let zhome: string;
let saved: { home?: string; zhome?: string };

beforeEach(() => {
	zhome = mkdtempSync(resolve(tmpdir(), "zenith-mem-"));
	saved = { home: process.env.HOME, zhome: process.env.ZENITH_HOME };
	process.env.ZENITH_HOME = zhome;
	process.env.HOME = zhome;
});

afterEach(() => {
	if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
	if (saved.zhome === undefined) delete process.env.ZENITH_HOME; else process.env.ZENITH_HOME = saved.zhome;
	rmSync(zhome, { recursive: true, force: true });
});

describe("persona memory — direct API", () => {
	it("append then read round-trips every entry with a timestamp", () => {
		appendPersonaMemory("q", "p1", { round: 1, kind: "observation", text: "found paper X" });
		appendPersonaMemory("q", "p1", { round: 1, kind: "claim", text: "X supports hypothesis Y" });
		const mem = readPersonaMemory("q", "p1");
		assert.equal(mem.length, 2);
		assert.equal(mem[0].kind, "observation");
		assert.equal(mem[0].text, "found paper X");
		assert.ok(mem[0].ts);
		assert.equal(mem[1].kind, "claim");
	});

	it("lives at ~/.zenith/swarm-work/<slug>/memory/<id>.jsonl", () => {
		appendPersonaMemory("my-run", "researcher-01", { round: 1, kind: "note", text: "hi" });
		const expected = resolve(zhome, "swarm-work", "my-run", "memory", "researcher-01.jsonl");
		assert.ok(existsSync(expected), `expected memory file at ${expected}`);
		const content = readFileSync(expected, "utf8");
		const entry = JSON.parse(content.trim());
		assert.equal(entry.text, "hi");
	});

	it("sanitizes unsafe persona ids into filenames", () => {
		appendPersonaMemory("q", "weird id/with\\slashes..and*stars", { round: 1, kind: "note", text: "ok" });
		const mem = readPersonaMemory("q", "weird id/with\\slashes..and*stars");
		assert.equal(mem.length, 1);
	});

	it("preserves insertion order across many appends", () => {
		for (let i = 0; i < 10; i++) {
			appendPersonaMemory("q", "p", { round: 1, kind: "note", text: `entry ${i}` });
		}
		const mem = readPersonaMemory("q", "p");
		assert.equal(mem.length, 10);
		for (let i = 0; i < 10; i++) {
			assert.equal(mem[i].text, `entry ${i}`);
		}
	});

	it("retraction is a first-class entry, not a delete", () => {
		appendPersonaMemory("q", "p", { round: 1, kind: "claim", text: "original claim" });
		appendPersonaMemory("q", "p", { round: 2, kind: "retract", text: "rejecting prior claim" });
		const mem = readPersonaMemory("q", "p");
		assert.equal(mem.length, 2);
		assert.equal(mem[0].kind, "claim");
		assert.equal(mem[1].kind, "retract");
	});

	it("returns empty array for persona with no memory", () => {
		const mem = readPersonaMemory("q", "nobody");
		assert.deepEqual(mem, []);
	});
});

describe("persona memory — tool harness", () => {
	it("append_persona_memory tool writes a round-tagged entry", async () => {
		const { tools } = makeMockPi();
		const res = await tools.append_persona_memory.execute(
			"t",
			{ slug: "q", personaId: "p1", round: 1, kind: "claim", text: "claim one", refs: ["arxiv:1234"] },
			undefined,
			undefined,
			{} as any,
		);
		assert.match(res.content[0].text, /APPENDED/);
		assert.equal(res.details.entry.text, "claim one");
		assert.deepEqual(res.details.entry.refs, ["arxiv:1234"]);
	});

	it("read_persona_memory tool honors sinceRound filter", async () => {
		const { tools } = makeMockPi();
		appendPersonaMemory("q", "p1", { round: 1, kind: "note", text: "old" });
		appendPersonaMemory("q", "p1", { round: 2, kind: "note", text: "new" });
		const res = await tools.read_persona_memory.execute(
			"t",
			{ slug: "q", personaId: "p1", sinceRound: 2 },
			undefined,
			undefined,
			{} as any,
		);
		assert.equal(res.details.entries.length, 1);
		assert.equal(res.details.entries[0].text, "new");
	});
});
