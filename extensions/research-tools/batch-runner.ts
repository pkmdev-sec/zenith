/**
 * batch-runner.ts — Anthropic Message Batches API client.
 *
 * Why: running 100+ persona calls synchronously with Opus on low-tier accounts
 * produces 429s. Anthropic's Batches API (docs: anthropic.com/en/api/creating-
 * message-batches) solves this: submit up to 100,000 requests in one job,
 * get a 50% discount, bypass RPM limits entirely, results within 24h (typically
 * 5–30 min for small batches).
 *
 * Design choice: raw HTTP, not the SDK. Zenith doesn't already depend on
 * @anthropic-ai/sdk directly (Pi does); pulling the SDK in just for batches
 * doubles our install footprint. The batch API is three straightforward
 * endpoints — submit, retrieve status, collect results — and we want to
 * persist batch state to disk anyway.
 *
 * Batch state persists to ~/.zenith/swarm-work/<slug>/batches/<batch-id>.json
 * so `zenith batch status <id>` can find them even across restarts.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── Types (subset of the Anthropic API) ───────────────────────

export interface BatchRequest {
	custom_id: string; // opaque id we pick; used to match results
	params: {
		model: string;
		max_tokens: number;
		messages: Array<{ role: "user" | "assistant"; content: string }>;
		system?: string;
	};
}

export type BatchStatus =
	| "in_progress"
	| "canceling"
	| "ended"; // ended = results available (processed, errored, or canceled)

export interface BatchInfo {
	id: string;
	type: "message_batch";
	processing_status: BatchStatus;
	request_counts: {
		processing: number;
		succeeded: number;
		errored: number;
		canceled: number;
		expired: number;
	};
	ended_at: string | null;
	created_at: string;
	expires_at: string;
	archived_at: string | null;
	cancel_initiated_at: string | null;
	results_url: string | null;
}

export interface BatchResult {
	custom_id: string;
	result:
		| {
				type: "succeeded";
				message: {
					id: string;
					type: "message";
					role: "assistant";
					content: Array<{ type: string; text?: string }>;
					model: string;
					stop_reason: string | null;
					usage: { input_tokens: number; output_tokens: number };
				};
		  }
		| { type: "errored"; error: { type: string; message: string } }
		| { type: "canceled" }
		| { type: "expired" };
}

// ── Local persistence ─────────────────────────────────────────

function getZenithHome(): string {
	if (process.env.ZENITH_HOME) return process.env.ZENITH_HOME;
	const home = process.env.HOME ?? homedir();
	return resolve(home, ".zenith");
}

function getBatchDir(slug: string): string {
	return resolve(getZenithHome(), "swarm-work", slug, "batches");
}

export interface LocalBatchRecord {
	slug: string;
	batchId: string;
	submittedAt: string;
	lastPolledAt: string;
	lastStatus: BatchStatus;
	requestCount: number;
	customIdsToPersona: Record<string, string>; // decode which persona each request belonged to
	note?: string;
}

export function saveBatchRecord(rec: LocalBatchRecord): void {
	const dir = getBatchDir(rec.slug);
	mkdirSync(dir, { recursive: true });
	writeFileSync(resolve(dir, `${rec.batchId}.json`), JSON.stringify(rec, null, 2));
}

export function readBatchRecord(slug: string, batchId: string): LocalBatchRecord | null {
	const path = resolve(getBatchDir(slug), `${batchId}.json`);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as LocalBatchRecord;
	} catch {
		return null;
	}
}

export function listBatchRecords(slug?: string): LocalBatchRecord[] {
	const root = resolve(getZenithHome(), "swarm-work");
	if (!existsSync(root)) return [];
	const records: LocalBatchRecord[] = [];
	const slugs = slug ? [slug] : readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	for (const s of slugs) {
		const dir = getBatchDir(s);
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			try {
				records.push(JSON.parse(readFileSync(resolve(dir, f), "utf8")));
			} catch {
				// skip
			}
		}
	}
	return records;
}

// ── HTTP client ───────────────────────────────────────────────

const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const BATCH_BETA_HEADER = "message-batches-2024-09-24";

export interface BatchClientOptions {
	apiKey?: string;
	// Injectable fetch for tests (default: global fetch)
	fetchImpl?: typeof fetch;
	baseUrl?: string;
}

export class AnthropicBatchClient {
	private readonly apiKey: string;
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrl: string;

	constructor(opts: BatchClientOptions = {}) {
		const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
		if (!key) throw new Error("ANTHROPIC_API_KEY is not set.");
		this.apiKey = key;
		this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
		this.baseUrl = opts.baseUrl ?? ANTHROPIC_BASE;
	}

	private headers(): Record<string, string> {
		return {
			"x-api-key": this.apiKey,
			"anthropic-version": API_VERSION,
			"anthropic-beta": BATCH_BETA_HEADER,
			"content-type": "application/json",
		};
	}

	/** Submit a batch of up to 100_000 requests. Returns the batch id. */
	async submit(requests: BatchRequest[]): Promise<BatchInfo> {
		if (requests.length === 0) throw new Error("Batch requires at least 1 request.");
		if (requests.length > 100_000) throw new Error("Anthropic batch max is 100,000 requests.");
		const res = await this.fetchImpl(`${this.baseUrl}/v1/messages/batches`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ requests }),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Batch submit failed: HTTP ${res.status} ${text.slice(0, 300)}`);
		}
		return (await res.json()) as BatchInfo;
	}

	/** Get current status of an existing batch. */
	async retrieve(batchId: string): Promise<BatchInfo> {
		const res = await this.fetchImpl(`${this.baseUrl}/v1/messages/batches/${batchId}`, {
			method: "GET",
			headers: this.headers(),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Batch retrieve failed: HTTP ${res.status} ${text.slice(0, 300)}`);
		}
		return (await res.json()) as BatchInfo;
	}

	/** Collect results for an ended batch. Yields each result as it parses. */
	async *results(batchId: string): AsyncGenerator<BatchResult> {
		const res = await this.fetchImpl(`${this.baseUrl}/v1/messages/batches/${batchId}/results`, {
			method: "GET",
			headers: this.headers(),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Batch results failed: HTTP ${res.status} ${text.slice(0, 300)}`);
		}
		// JSONL stream
		const text = await res.text();
		for (const line of text.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				yield JSON.parse(t) as BatchResult;
			} catch {
				// skip malformed
			}
		}
	}

	/** Convenience: poll until ended, returning all results. Use sparingly — batches can take hours. */
	async submitAndWait(
		requests: BatchRequest[],
		opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
	): Promise<{ info: BatchInfo; results: BatchResult[] }> {
		const pollInterval = opts.pollIntervalMs ?? 30_000;
		const timeout = opts.timeoutMs ?? 24 * 60 * 60 * 1000;
		const started = Date.now();
		let info = await this.submit(requests);
		while (info.processing_status !== "ended") {
			if (Date.now() - started > timeout) throw new Error(`Batch ${info.id} timed out after ${Math.round(timeout / 60000)} min`);
			await new Promise((r) => setTimeout(r, pollInterval));
			info = await this.retrieve(info.id);
		}
		const results: BatchResult[] = [];
		for await (const r of this.results(info.id)) results.push(r);
		return { info, results };
	}
}

// Extract the plain-text content from a succeeded result (convenience).
export function extractText(result: BatchResult): string | null {
	if (result.result.type !== "succeeded") return null;
	return result.result.message.content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text!)
		.join("\n");
}
