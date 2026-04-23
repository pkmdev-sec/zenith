import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
	AnthropicBatchClient,
	extractText,
	listBatchRecords,
	readBatchRecord,
	saveBatchRecord,
	type BatchResult,
} from "../extensions/research-tools/batch-runner.js";

let zhome: string;
let saved: { home?: string; zhome?: string; apiKey?: string };

beforeEach(() => {
	zhome = mkdtempSync(resolve(tmpdir(), "zenith-batch-"));
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

// ── Helper: mock fetch that records requests + replays canned responses ──

function mockFetch(responses: Array<{ status: number; body: string }>) {
	let index = 0;
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const impl: typeof fetch = async (input: any, init?: any) => {
		const r = responses[index++];
		if (!r) throw new Error(`mockFetch exhausted; unexpected call to ${input}`);
		calls.push({ url: String(input), init });
		return new Response(r.body, { status: r.status });
	};
	return { impl, calls };
}

// ── Tests ─────────────────────────────────────────────────────

describe("AnthropicBatchClient — submit", () => {
	it("POSTs to /v1/messages/batches with the beta header", async () => {
		const { impl, calls } = mockFetch([
			{ status: 200, body: JSON.stringify({ id: "msgbatch_1", type: "message_batch", processing_status: "in_progress", request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 }, ended_at: null, created_at: "now", expires_at: "later", archived_at: null, cancel_initiated_at: null, results_url: null }) },
		]);
		const client = new AnthropicBatchClient({ fetchImpl: impl });
		const info = await client.submit([
			{ custom_id: "p1", params: { model: "claude-opus-4-6", max_tokens: 100, messages: [{ role: "user", content: "hi" }] } },
			{ custom_id: "p2", params: { model: "claude-opus-4-6", max_tokens: 100, messages: [{ role: "user", content: "hi" }] } },
		]);
		assert.equal(info.id, "msgbatch_1");
		assert.equal(calls.length, 1);
		assert.match(calls[0].url, /\/v1\/messages\/batches$/);
		const body = JSON.parse((calls[0].init!.body as string));
		assert.equal(body.requests.length, 2);
		const headers = (calls[0].init!.headers as Record<string, string>);
		assert.equal(headers["anthropic-beta"], "message-batches-2024-09-24");
		assert.equal(headers["x-api-key"], "sk-test-fake");
	});

	it("rejects empty batches before making a call", async () => {
		const { impl, calls } = mockFetch([]);
		const client = new AnthropicBatchClient({ fetchImpl: impl });
		await assert.rejects(() => client.submit([]), /at least 1 request/);
		assert.equal(calls.length, 0);
	});

	it("surfaces HTTP errors with status and body snippet", async () => {
		const { impl } = mockFetch([{ status: 400, body: "invalid_request: max_tokens too large" }]);
		const client = new AnthropicBatchClient({ fetchImpl: impl });
		await assert.rejects(
			() => client.submit([{ custom_id: "p", params: { model: "x", max_tokens: 1, messages: [{ role: "user", content: "x" }] } }]),
			/HTTP 400/,
		);
	});
});

describe("AnthropicBatchClient — retrieve", () => {
	it("GETs to /v1/messages/batches/<id>", async () => {
		const { impl, calls } = mockFetch([
			{ status: 200, body: JSON.stringify({ id: "msgbatch_2", type: "message_batch", processing_status: "ended", request_counts: { processing: 0, succeeded: 2, errored: 0, canceled: 0, expired: 0 }, ended_at: "now", created_at: "earlier", expires_at: "much later", archived_at: null, cancel_initiated_at: null, results_url: "https://…/results" }) },
		]);
		const client = new AnthropicBatchClient({ fetchImpl: impl });
		const info = await client.retrieve("msgbatch_2");
		assert.equal(info.processing_status, "ended");
		assert.equal(info.request_counts.succeeded, 2);
		assert.match(calls[0].url, /\/v1\/messages\/batches\/msgbatch_2$/);
	});
});

describe("AnthropicBatchClient — results", () => {
	it("streams JSONL results as a generator", async () => {
		const jsonl = [
			JSON.stringify({ custom_id: "p1", result: { type: "succeeded", message: { id: "m1", type: "message", role: "assistant", content: [{ type: "text", text: "reply 1" }], model: "claude-opus-4-6", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } } } }),
			JSON.stringify({ custom_id: "p2", result: { type: "errored", error: { type: "invalid_request", message: "bad input" } } }),
			"", // empty line — should be skipped
			"not-json", // malformed — should be skipped
		].join("\n");
		const { impl } = mockFetch([{ status: 200, body: jsonl }]);
		const client = new AnthropicBatchClient({ fetchImpl: impl });
		const out: BatchResult[] = [];
		for await (const r of client.results("msgbatch_3")) out.push(r);
		assert.equal(out.length, 2);
		assert.equal(out[0].custom_id, "p1");
		assert.equal(out[1].custom_id, "p2");
		assert.equal(extractText(out[0]), "reply 1");
		assert.equal(extractText(out[1]), null);
	});
});

describe("local batch record persistence", () => {
	it("save then read round-trips a record", () => {
		saveBatchRecord({
			slug: "q",
			batchId: "msgbatch_z",
			submittedAt: "2026-04-23T00:00:00Z",
			lastPolledAt: "2026-04-23T00:10:00Z",
			lastStatus: "in_progress",
			requestCount: 42,
			customIdsToPersona: { c1: "persona-a", c2: "persona-b" },
			note: "first batch",
		});
		const r = readBatchRecord("q", "msgbatch_z");
		assert.ok(r);
		assert.equal(r!.requestCount, 42);
		assert.equal(r!.customIdsToPersona.c1, "persona-a");
	});

	it("listBatchRecords finds records across swarm slugs", () => {
		saveBatchRecord({ slug: "q1", batchId: "b1", submittedAt: "x", lastPolledAt: "x", lastStatus: "in_progress", requestCount: 1, customIdsToPersona: {} });
		saveBatchRecord({ slug: "q2", batchId: "b2", submittedAt: "x", lastPolledAt: "x", lastStatus: "ended", requestCount: 2, customIdsToPersona: {} });
		const all = listBatchRecords();
		assert.equal(all.length, 2);
		const q1Only = listBatchRecords("q1");
		assert.equal(q1Only.length, 1);
		assert.equal(q1Only[0].batchId, "b1");
	});

	it("readBatchRecord returns null for missing ids", () => {
		assert.equal(readBatchRecord("q", "nope"), null);
	});
});

describe("extractText", () => {
	it("concatenates all text blocks in a succeeded message", () => {
		const r: BatchResult = {
			custom_id: "x",
			result: {
				type: "succeeded",
				message: {
					id: "m", type: "message", role: "assistant",
					content: [{ type: "text", text: "part A" }, { type: "tool_use" }, { type: "text", text: "part B" }] as any,
					model: "m", stop_reason: null,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			},
		};
		assert.equal(extractText(r), "part A\npart B");
	});
	it("returns null for non-succeeded results", () => {
		const r: BatchResult = { custom_id: "x", result: { type: "canceled" } };
		assert.equal(extractText(r), null);
	});
});
