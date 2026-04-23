/**
 * `zenith batch <sub>` — CLI subcommands for the Anthropic Message Batches
 * workflow used by `run_swarm` in batched mode.
 *
 * Why this exists: running 100+ persona calls synchronously burns through RPM
 * limits. Batched mode submits all personas in one job, then returns control
 * to the user so they can come back later and collect. These subcommands are
 * the "come back later" half of that loop:
 *
 *   - `list`    — show all locally-tracked batches across swarm slugs.
 *   - `status`  — show local state + live Anthropic-side status for one batch.
 *   - `collect` — stream results, stitch each succeeded reply back into the
 *                 evidence graph + per-persona memory so round 2 can read it.
 *
 * Design notes:
 *
 * - We keep an **in-process injection point** for `fetchImpl`, `now`, and the
 *   three I/O functions that touch disk (`memoryAppend`, `evidenceAppend`,
 *   `recordSave`). The CLI binding passes the live defaults; tests replace
 *   them with mocks. This is the same pattern batch-runner.ts already uses
 *   for `fetchImpl`, extended here to the evidence-graph + persona-memory
 *   side-effects.
 *
 * - We deliberately do NOT import dependencies that would force pulling the
 *   whole extension graph (tool registration, typebox schemas, etc.) into
 *   this CLI-only path — we cherry-pick the pure functions.
 *
 * - Status printing uses the same sky-blue palette as the rest of the CLI,
 *   via the shared terminal helpers.
 */

import {
	AnthropicBatchClient,
	extractText,
	listBatchRecords,
	readBatchRecord,
	saveBatchRecord,
	type BatchInfo,
	type LocalBatchRecord,
} from "../../extensions/research-tools/batch-runner.js";
import { appendEvidence } from "../../extensions/research-tools/evidence-graph.js";
import { appendPersonaMemory } from "../../extensions/research-tools/memory.js";
import { printError, printInfo, printSection, printSuccess, printWarning } from "../ui/terminal.js";

// ── Injection surface (tests replace these) ───────────────────

export interface BatchCmdDeps {
	/** Construct a client; tests override to inject a mocked fetch. */
	makeClient: () => AnthropicBatchClient;
	/** Read every locally-tracked record (optionally filtered to one slug). */
	list: (slug?: string) => LocalBatchRecord[];
	/** Read one local record by (slug, batchId). Returns null when missing. */
	read: (slug: string, batchId: string) => LocalBatchRecord | null;
	/** Persist an updated local record (collect re-saves with new lastStatus). */
	save: (rec: LocalBatchRecord) => void;
	/** Append a claim to the persona's long-term memory JSONL. */
	memoryAppend: typeof appendPersonaMemory;
	/** Append an assertion to the shared evidence graph JSONL. */
	evidenceAppend: typeof appendEvidence;
	now: () => Date;
	log: (line: string) => void;
	warn: (line: string) => void;
	err: (line: string) => void;
}

const DEFAULT_DEPS: BatchCmdDeps = {
	makeClient: () => new AnthropicBatchClient(),
	list: listBatchRecords,
	read: readBatchRecord,
	save: saveBatchRecord,
	memoryAppend: appendPersonaMemory,
	evidenceAppend: appendEvidence,
	now: () => new Date(),
	log: (l) => console.log(l),
	warn: (l) => printWarning(l),
	err: (l) => printError(l),
};

// ── Public helpers (unit-testable) ────────────────────────────

export interface ListOptions {
	slug?: string;
}

export function cmdList(opts: ListOptions, deps: BatchCmdDeps = DEFAULT_DEPS): void {
	const records = deps.list(opts.slug).slice().sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
	if (records.length === 0) {
		deps.log("No batches tracked locally" + (opts.slug ? ` for slug '${opts.slug}'.` : "."));
		return;
	}
	printSection(`Batches (${records.length})`);
	deps.log(
		[
			"SLUG".padEnd(20),
			"BATCH ID".padEnd(26),
			"STATUS".padEnd(12),
			"COUNT".padEnd(6),
			"SUBMITTED",
		].join("  "),
	);
	for (const r of records) {
		deps.log(
			[
				truncate(r.slug, 20).padEnd(20),
				truncate(r.batchId, 26).padEnd(26),
				r.lastStatus.padEnd(12),
				String(r.requestCount).padEnd(6),
				r.submittedAt,
			].join("  "),
		);
	}
}

export interface StatusOptions {
	batchId: string;
	slug?: string;
}

export async function cmdStatus(opts: StatusOptions, deps: BatchCmdDeps = DEFAULT_DEPS): Promise<void> {
	const record = findRecord(opts, deps);
	if (!record) {
		deps.err(`No local record for batch '${opts.batchId}'${opts.slug ? ` in slug '${opts.slug}'` : ""}.`);
		throw new Error("batch record not found");
	}
	printSection(`Batch ${record.batchId}`);
	deps.log(`slug:            ${record.slug}`);
	deps.log(`submitted at:    ${record.submittedAt}`);
	deps.log(`last polled at:  ${record.lastPolledAt}`);
	deps.log(`last seen state: ${record.lastStatus}`);
	deps.log(`request count:   ${record.requestCount}`);
	if (record.round !== undefined) deps.log(`round:           ${record.round}`);
	if (record.note) deps.log(`note:            ${record.note}`);

	let info: BatchInfo;
	try {
		const client = deps.makeClient();
		info = await client.retrieve(record.batchId);
	} catch (err) {
		deps.warn(`Could not fetch live status: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	printSection("Anthropic-side status");
	deps.log(`processing_status: ${info.processing_status}`);
	deps.log(`created_at:        ${info.created_at}`);
	deps.log(`ended_at:          ${info.ended_at ?? "(still running)"}`);
	const c = info.request_counts;
	deps.log(
		`counts: processing=${c.processing}  succeeded=${c.succeeded}  errored=${c.errored}  canceled=${c.canceled}  expired=${c.expired}`,
	);

	// Persist the refreshed snapshot so the next `list` shows the right status.
	deps.save({ ...record, lastStatus: info.processing_status, lastPolledAt: deps.now().toISOString() });

	if (info.processing_status === "ended") {
		printSuccess(`Batch ended. Run 'zenith batch collect ${record.batchId}' to ingest results.`);
	}
}

export interface CollectOptions {
	batchId: string;
	slug?: string;
	/** Override the round used for memory/evidence writes (defaults to record.round ?? 1). */
	round?: number;
}

export interface CollectSummary {
	succeeded: number;
	errored: number;
	canceled: number;
	expired: number;
	unknownPersona: number;
}

export async function cmdCollect(opts: CollectOptions, deps: BatchCmdDeps = DEFAULT_DEPS): Promise<CollectSummary> {
	const record = findRecord(opts, deps);
	if (!record) {
		deps.err(`No local record for batch '${opts.batchId}'${opts.slug ? ` in slug '${opts.slug}'` : ""}.`);
		throw new Error("batch record not found");
	}
	const round = opts.round ?? record.round ?? 1;
	printSection(`Collecting ${record.batchId} (slug=${record.slug}, round=${round})`);

	const client = deps.makeClient();
	const summary: CollectSummary = { succeeded: 0, errored: 0, canceled: 0, expired: 0, unknownPersona: 0 };

	for await (const result of client.results(record.batchId)) {
		const persona = record.customIdsToPersona[result.custom_id];
		if (!persona) {
			summary.unknownPersona += 1;
			deps.warn(`custom_id='${result.custom_id}' not found in record; skipping`);
			continue;
		}

		if (result.result.type === "errored") {
			summary.errored += 1;
			deps.warn(`${persona}: errored — ${result.result.error.type}: ${result.result.error.message}`);
			continue;
		}
		if (result.result.type === "canceled") { summary.canceled += 1; continue; }
		if (result.result.type === "expired") { summary.expired += 1; continue; }

		const text = extractText(result) ?? "";
		if (!text.trim()) {
			deps.warn(`${persona}: empty response, not committing`);
			continue;
		}

		deps.memoryAppend(record.slug, persona, {
			round,
			kind: "claim",
			text,
		});
		deps.evidenceAppend(record.slug, {
			round,
			persona,
			claim: firstClaimLine(text),
			sources: [],
			kind: "assertion",
		});
		summary.succeeded += 1;
	}

	// Update the record so repeated `collect` runs are visible + fast.
	deps.save({ ...record, lastStatus: "ended", lastPolledAt: deps.now().toISOString() });

	printSuccess(
		`Collected: ${summary.succeeded} succeeded, ${summary.errored} errored, ${summary.canceled} canceled, ${summary.expired} expired, ${summary.unknownPersona} unknown-persona.`,
	);
	return summary;
}

// ── Entrypoint dispatcher ─────────────────────────────────────

function printBatchHelp(): void {
	printSection("zenith batch");
	printInfo("list                       List all tracked batches");
	printInfo("list --slug <slug>         Filter by swarm slug");
	printInfo("status <batchId>           Local + live status for one batch");
	printInfo("status <batchId> --slug <slug>   Disambiguate if the id collides");
	printInfo("collect <batchId>          Ingest results into evidence + memory");
	printInfo("collect <batchId> --round <n>   Override round (default: record.round ?? 1)");
}

export async function handleBatchCommand(
	subcommand: string | undefined,
	args: string[],
	deps: BatchCmdDeps = DEFAULT_DEPS,
): Promise<void> {
	if (!subcommand || subcommand === "help" || subcommand === "--help") {
		printBatchHelp();
		return;
	}
	const flags = parseFlags(args);
	if (subcommand === "list") {
		cmdList({ slug: flags.slug }, deps);
		return;
	}
	if (subcommand === "status") {
		const id = flags.positional[0];
		if (!id) throw new Error("Usage: zenith batch status <batchId> [--slug <slug>]");
		await cmdStatus({ batchId: id, slug: flags.slug }, deps);
		return;
	}
	if (subcommand === "collect") {
		const id = flags.positional[0];
		if (!id) throw new Error("Usage: zenith batch collect <batchId> [--slug <slug>] [--round <n>]");
		const round = flags.round !== undefined ? Number.parseInt(flags.round, 10) : undefined;
		await cmdCollect({ batchId: id, slug: flags.slug, round }, deps);
		return;
	}
	throw new Error(`Unknown batch command: ${subcommand}`);
}

// ── Internals ─────────────────────────────────────────────────

function findRecord(
	opts: { batchId: string; slug?: string },
	deps: BatchCmdDeps,
): LocalBatchRecord | null {
	if (opts.slug) {
		return deps.read(opts.slug, opts.batchId);
	}
	// Walk every slug until we find a record for this id. Slugs are
	// user-created so collisions are rare enough that a linear scan is fine.
	for (const rec of deps.list()) {
		if (rec.batchId === opts.batchId) return rec;
	}
	return null;
}

function truncate(s: string, width: number): string {
	return s.length <= width ? s : s.slice(0, width - 1) + "…";
}

function firstClaimLine(text: string): string {
	// Take the first non-empty line; trim trailing periods to match the
	// style the evidence graph uses elsewhere. Cap at ~300 chars so one
	// pathological response can't blow up the graph.
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (t.length > 0) return t.slice(0, 300);
	}
	return text.slice(0, 300);
}

interface ParsedFlags {
	slug?: string;
	round?: string;
	positional: string[];
}

function parseFlags(args: string[]): ParsedFlags {
	const out: ParsedFlags = { positional: [] };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--slug") {
			out.slug = args[++i];
		} else if (a === "--round") {
			out.round = args[++i];
		} else if (a.startsWith("--slug=")) {
			out.slug = a.slice("--slug=".length);
		} else if (a.startsWith("--round=")) {
			out.round = a.slice("--round=".length);
		} else {
			out.positional.push(a);
		}
	}
	return out;
}
