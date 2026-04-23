/**
 * Tests for `zenith batch {list,status,collect}`. We use the dependency-
 * injection hooks on `handleBatchCommand` so the tests touch neither the
 * real network nor the real `~/.zenith/swarm-work/` tree.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
	AnthropicBatchClient,
	type LocalBatchRecord,
} from "../extensions/research-tools/batch-runner.js";
import type { EvidenceEntry } from "../extensions/research-tools/evidence-graph.js";
import type { MemoryEntry } from "../extensions/research-tools/memory.js";
import {
	cmdCollect,
	cmdList,
	cmdStatus,
	handleBatchCommand,
	type BatchCmdDeps,
} from "../src/batch/commands.js";

let zhome: string;
let saved: { home?: string; zhome?: string; apiKey?: string };

beforeEach(() => {
	zhome = mkdtempSync(resolve(tmpdir(), "zenith-batch-cli-"));
	saved = { home: process.env.HOME, zhome: process.env.ZENITH_HOME, apiKey: process.env.ANTHROPIC_API_KEY };
	process.env.ZENITH_HOME = zhome;
	process.env.HOME = zhome;
	process.env.ANTHROPIC_API_KEY = "sk-test-fake";
});

afterEach(() => {
	if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
	if (saved.zhome === undefined) delete process.env.ZENITH_HOME; else process.env.ZENITH_HOME = saved.zhome;
	if (saved.apiKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.apiKey;
	rmSync(zhome, { recursive: true, force: true });
});

function mockFetch(responses: Array<{ status: number; body: string }>) {
	let index = 0;
	const impl: typeof fetch = async (_input: any, _init?: any) => {
		const r = responses[index++];
		if (!r) throw new Error("mockFetch exhausted");
		return new Response(r.body, { status: r.status });
	};
	return impl;
}

function makeDeps(overrides: Partial<BatchCmdDeps> & { records?: LocalBatchRecord[] }): BatchCmdDeps {
	const records: LocalBatchRecord[] = overrides.records ?? [];
	const memoryAppends: Array<{ slug: string; personaId: string; entry: Omit<MemoryEntry, "ts"> }> = [];
	const evidenceAppends: Array<{ slug: string; entry: Omit<EvidenceEntry, "id" | "ts"> }> = [];
	const logs: string[] = [];
	const warns: string[] = [];
	const errs: string[] = [];
	const saves: LocalBatchRecord[] = [];
	const deps: BatchCmdDeps = {
		makeClient: overrides.makeClient ?? (() => new AnthropicBatchClient({ fetchImpl: async () => new Response("{}") })),
		list: overrides.list ?? ((slug?: string) => (slug ? records.filter((r) => r.slug === slug) : records)),
		read: overrides.read ?? ((slug: string, id: string) => records.find((r) => r.slug === slug && r.batchId === id) ?? null),
		save: overrides.save ?? ((rec: LocalBatchRecord) => { saves.push(rec); }),
		memoryAppend: overrides.memoryAppend ?? ((slug, personaId, entry) => {
			memoryAppends.push({ slug, personaId, entry });
			return { ts: new Date().toISOString(), ...entry };
		}),
		evidenceAppend: overrides.evidenceAppend ?? ((slug, entry) => {
			evidenceAppends.push({ slug, entry });
			return { id: `c_mock${evidenceAppends.length}`, ts: new Date().toISOString(), ...entry };
		}),
		now: overrides.now ?? (() => new Date("2026-04-23T12:00:00Z")),
		log: (l) => { logs.push(l); },
		warn: (l) => { warns.push(l); },
		err: (l) => { errs.push(l); },
	};
	(deps as any).__inspect = { memoryAppends, evidenceAppends, logs, warns, errs, saves };
	return deps;
}

describe("zenith batch list", () => {
	it("shows 'No batches tracked locally.' when empty", () => {
		const deps = makeDeps({ records: [] });
		cmdList({}, deps);
		const { logs } = (deps as any).__inspect;
		assert.ok(logs.some((l: string) => l.includes("No batches tracked locally")));
	});

	it("lists records newest-first", () => {
		const deps = makeDeps({
			records: [
				{ slug: "alpha", batchId: "b_old", submittedAt: "2025-01-01T00:00:00Z", lastPolledAt: "x", lastStatus: "in_progress", requestCount: 10, customIdsToPersona: {} },
				{ slug: "beta",  batchId: "b_new", submittedAt: "2026-04-01T00:00:00Z", lastPolledAt: "x", lastStatus: "ended",       requestCount: 20, customIdsToPersona: {} },
			],
		});
		cmdList({}, deps);
		const { logs } = (deps as any).__inspect;
		const body = logs.join("\n");
		assert.ok(body.indexOf("b_new") < body.indexOf("b_old"), `expected b_new to appear before b_old; got:\n${body}`);
	});

	it("--slug filters down to that slug", () => {
		const deps = makeDeps({
			records: [
				{ slug: "alpha", batchId: "b_a", submittedAt: "2025-01-01T00:00:00Z", lastPolledAt: "x", lastStatus: "in_progress", requestCount: 1, customIdsToPersona: {} },
				{ slug: "beta",  batchId: "b_b", submittedAt: "2025-01-01T00:00:00Z", lastPolledAt: "x", lastStatus: "ended",       requestCount: 1, customIdsToPersona: {} },
			],
		});
		cmdList({ slug: "beta" }, deps);
		const body = (deps as any).__inspect.logs.join("\n");
		assert.ok(body.includes("b_b"));
		assert.ok(!body.includes("b_a"));
	});
});

describe("zenith batch status", () => {
	it("prints local state + live counts and persists the refreshed snapshot", async () => {
		const record: LocalBatchRecord = {
			slug: "q", batchId: "msgbatch_1", submittedAt: "2026-04-01T00:00:00Z", lastPolledAt: "2026-04-01T00:01:00Z",
			lastStatus: "in_progress", requestCount: 3, customIdsToPersona: {}, round: 1,
		};
		const fetchImpl = mockFetch([{
			status: 200,
			body: JSON.stringify({
				id: "msgbatch_1", type: "message_batch", processing_status: "ended",
				request_counts: { processing: 0, succeeded: 3, errored: 0, canceled: 0, expired: 0 },
				ended_at: "2026-04-01T00:05:00Z", created_at: "c", expires_at: "e",
				archived_at: null, cancel_initiated_at: null, results_url: "r",
			}),
		}]);
		const deps = makeDeps({
			records: [record],
			makeClient: () => new AnthropicBatchClient({ fetchImpl }),
		});
		await cmdStatus({ batchId: "msgbatch_1" }, deps);
		const { logs, saves } = (deps as any).__inspect;
		const body = logs.join("\n");
		assert.ok(body.includes("processing_status: ended"));
		assert.ok(body.includes("succeeded=3"));
		assert.equal(saves.length, 1);
		assert.equal(saves[0].lastStatus, "ended");
	});

	it("throws when no local record matches", async () => {
		const deps = makeDeps({ records: [] });
		await assert.rejects(
			cmdStatus({ batchId: "does-not-exist" }, deps),
			/batch record not found/,
		);
	});

	it("warns + returns if the Anthropic call fails", async () => {
		const record: LocalBatchRecord = {
			slug: "q", batchId: "msgbatch_x", submittedAt: "x", lastPolledAt: "x",
			lastStatus: "in_progress", requestCount: 1, customIdsToPersona: {},
		};
		const deps = makeDeps({
			records: [record],
			makeClient: () => new AnthropicBatchClient({ fetchImpl: async () => new Response("boom", { status: 500 }) }),
		});
		await cmdStatus({ batchId: "msgbatch_x" }, deps);
		const { warns, saves } = (deps as any).__inspect;
		assert.ok(warns.some((w: string) => w.includes("Could not fetch live status")));
		assert.equal(saves.length, 0, "should not overwrite local state on failed live lookup");
	});
});

describe("zenith batch collect", () => {
	it("ingests succeeded results into memory + evidence, tallies errored/canceled", async () => {
		const record: LocalBatchRecord = {
			slug: "q", batchId: "mb_c", submittedAt: "s", lastPolledAt: "s",
			lastStatus: "ended", requestCount: 3,
			customIdsToPersona: { c1: "statistics-specialist-01", c2: "climate-specialist-01", c3: "nlp-specialist-01" },
			round: 1,
		};
		const jsonl = [
			{ custom_id: "c1", result: { type: "succeeded", message: { id: "m1", type: "message", role: "assistant", content: [{ type: "text", text: "L2 regularization outperforms L1 on CIFAR-10." }], model: "m", stop_reason: null, usage: { input_tokens: 10, output_tokens: 10 } } } },
			{ custom_id: "c2", result: { type: "errored", error: { type: "rate_limit", message: "too many" } } },
			{ custom_id: "c3", result: { type: "canceled" } },
			{ custom_id: "unknown", result: { type: "succeeded", message: { id: "m2", type: "message", role: "assistant", content: [{ type: "text", text: "orphan" }], model: "m", stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } } },
		];
		const fetchImpl = mockFetch([{ status: 200, body: jsonl.map((j) => JSON.stringify(j)).join("\n") }]);
		const deps = makeDeps({
			records: [record],
			makeClient: () => new AnthropicBatchClient({ fetchImpl }),
		});

		const summary = await cmdCollect({ batchId: "mb_c" }, deps);
		assert.equal(summary.succeeded, 1);
		assert.equal(summary.errored, 1);
		assert.equal(summary.canceled, 1);
		assert.equal(summary.unknownPersona, 1);

		const { memoryAppends, evidenceAppends, saves } = (deps as any).__inspect;
		assert.equal(memoryAppends.length, 1);
		assert.equal(memoryAppends[0].personaId, "statistics-specialist-01");
		assert.equal(memoryAppends[0].entry.kind, "claim");
		assert.equal(memoryAppends[0].entry.round, 1);

		assert.equal(evidenceAppends.length, 1);
		assert.equal(evidenceAppends[0].entry.kind, "assertion");
		assert.equal(evidenceAppends[0].entry.round, 1);
		assert.equal(evidenceAppends[0].entry.persona, "statistics-specialist-01");
		assert.match(evidenceAppends[0].entry.claim, /L2 regularization/);

		assert.equal(saves.length, 1);
		assert.equal(saves[0].lastStatus, "ended");
	});

	it("defaults round to 1 when neither --round nor record.round is set", async () => {
		const record: LocalBatchRecord = {
			slug: "q", batchId: "mb_noround", submittedAt: "s", lastPolledAt: "s",
			lastStatus: "ended", requestCount: 1,
			customIdsToPersona: { c1: "researcher" },
		};
		const fetchImpl = mockFetch([{ status: 200, body: JSON.stringify({
			custom_id: "c1", result: { type: "succeeded", message: { id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], model: "m", stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
		}) }]);
		const deps = makeDeps({
			records: [record],
			makeClient: () => new AnthropicBatchClient({ fetchImpl }),
		});
		await cmdCollect({ batchId: "mb_noround" }, deps);
		const { memoryAppends } = (deps as any).__inspect;
		assert.equal(memoryAppends[0].entry.round, 1);
	});

	it("honors an explicit --round override", async () => {
		const record: LocalBatchRecord = {
			slug: "q", batchId: "mb_override", submittedAt: "s", lastPolledAt: "s",
			lastStatus: "ended", requestCount: 1,
			customIdsToPersona: { c1: "researcher" }, round: 1,
		};
		const fetchImpl = mockFetch([{ status: 200, body: JSON.stringify({
			custom_id: "c1", result: { type: "succeeded", message: { id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], model: "m", stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
		}) }]);
		const deps = makeDeps({
			records: [record],
			makeClient: () => new AnthropicBatchClient({ fetchImpl }),
		});
		await cmdCollect({ batchId: "mb_override", round: 2 }, deps);
		const { memoryAppends, evidenceAppends } = (deps as any).__inspect;
		assert.equal(memoryAppends[0].entry.round, 2);
		assert.equal(evidenceAppends[0].entry.round, 2);
	});
});

describe("handleBatchCommand router", () => {
	it("unknown subcommand throws a clear error", async () => {
		await assert.rejects(handleBatchCommand("hypothetical", []), /Unknown batch command: hypothetical/);
	});
	it("collect requires a batch id", async () => {
		await assert.rejects(handleBatchCommand("collect", []), /Usage: zenith batch collect/);
	});
	it("status requires a batch id", async () => {
		await assert.rejects(handleBatchCommand("status", []), /Usage: zenith batch status/);
	});
	it("help subcommand prints without error", async () => {
		await handleBatchCommand("help", [], makeDeps({ records: [] }));
	});
});
