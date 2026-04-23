/**
 * memory.ts — Per-persona long-term memory.
 *
 * MiroFish-inspired: every investigator persona carries memory across rounds.
 * Without this, round 2 restarts from scratch and "social evolution" collapses
 * to 100 parallel single-shot calls. With it, each persona can recall what
 * they looked at, what claims they committed to, and what they changed their
 * mind about.
 *
 * Layout on disk:
 *   ~/.zenith/swarm-work/<slug>/memory/<persona-id>.jsonl
 *
 * Each line is a JSON object:
 *   { ts, round, kind: "observation" | "claim" | "retract" | "note", text, refs }
 *
 * Tools registered:
 *   - read_persona_memory : read the full memory trace for one persona
 *   - append_persona_memory : append a new entry
 *
 * Append-only by design. Retractions are first-class entries, not deletions.
 * This mirrors how evidence actually accumulates: belief updates are part of
 * the record, not a rewrite of it.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── Path helpers (mirror of orchestration.ts) ─────────────────

function getZenithHome(): string {
	if (process.env.ZENITH_HOME) return process.env.ZENITH_HOME;
	const home = process.env.HOME ?? homedir();
	return resolve(home, ".zenith");
}

function getMemoryDir(slug: string): string {
	return resolve(getZenithHome(), "swarm-work", slug, "memory");
}

function getMemoryPath(slug: string, personaId: string): string {
	// Sanitize persona id to a filesystem-safe filename.
	const safe = personaId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 80);
	return resolve(getMemoryDir(slug), `${safe}.jsonl`);
}

// ── Types ─────────────────────────────────────────────────────

export type MemoryKind = "observation" | "claim" | "retract" | "note";

export interface MemoryEntry {
	ts: string;
	round: number;
	kind: MemoryKind;
	text: string;
	refs?: string[]; // optional list of evidence-graph ids or source URLs
}

// ── IO primitives ─────────────────────────────────────────────

function readMemoryFile(path: string): MemoryEntry[] {
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8");
	const out: MemoryEntry[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t) as MemoryEntry);
		} catch {
			// malformed line; skip
		}
	}
	return out;
}

function appendMemoryEntry(path: string, entry: MemoryEntry): void {
	mkdirSync(resolve(path, ".."), { recursive: true });
	appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

// ── Public helpers (exported for orchestration + tests) ────────

export function readPersonaMemory(slug: string, personaId: string): MemoryEntry[] {
	return readMemoryFile(getMemoryPath(slug, personaId));
}

export function appendPersonaMemory(
	slug: string,
	personaId: string,
	entry: Omit<MemoryEntry, "ts">,
): MemoryEntry {
	const full: MemoryEntry = { ts: new Date().toISOString(), ...entry };
	appendMemoryEntry(getMemoryPath(slug, personaId), full);
	return full;
}

// ── Tool registration ─────────────────────────────────────────

export function registerMemoryTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read_persona_memory",
		label: "Read Persona Memory",
		description:
			"Read the full memory trace for a persona in a swarm run. Used at the start " +
			"of each round >= 2 so the persona can see what they committed to previously " +
			"and what other personas claimed (when paired with evidence graph queries).",
		parameters: Type.Object({
			slug: Type.String({ description: "Swarm slug" }),
			personaId: Type.String({ description: "Persona identifier (e.g. 'statistics-specialist-01')" }),
			sinceRound: Type.Optional(
				Type.Number({ description: "If set, return only entries with round >= this value." }),
			),
		}),
		async execute(_id, params) {
			const entries = readPersonaMemory(params.slug, params.personaId);
			const filtered =
				params.sinceRound !== undefined
					? entries.filter((e) => e.round >= params.sinceRound!)
					: entries;
			const lines: string[] = [
				`# Memory: ${params.personaId} (${filtered.length} entries)`,
				"",
			];
			for (const e of filtered) {
				lines.push(`- [r${e.round} ${e.kind}] ${e.text}`);
				if (e.refs && e.refs.length > 0) {
					lines.push(`    refs: ${e.refs.join(", ")}`);
				}
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { entries: filtered },
			};
		},
	});

	pi.registerTool({
		name: "append_persona_memory",
		label: "Append Persona Memory",
		description:
			"Append a new memory entry for a persona. Kinds: 'observation' (something you " +
			"read/noticed), 'claim' (something you assert), 'retract' (a prior claim you " +
			"now reject; the prior entry stays in the log for audit), 'note' (freeform).",
		parameters: Type.Object({
			slug: Type.String({ description: "Swarm slug" }),
			personaId: Type.String({ description: "Persona identifier" }),
			round: Type.Number({ description: "Current round (0-indexed or 1-indexed — use the same convention throughout the run)" }),
			kind: Type.Union(
				[
					Type.Literal("observation"),
					Type.Literal("claim"),
					Type.Literal("retract"),
					Type.Literal("note"),
				],
				{ description: "Entry kind" },
			),
			text: Type.String({ description: "The entry text. Keep concise; this is a log, not a document." }),
			refs: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional evidence-graph ids or URLs supporting this entry.",
				}),
			),
		}),
		async execute(_id, params) {
			const entry = appendPersonaMemory(params.slug, params.personaId, {
				round: params.round,
				kind: params.kind,
				text: params.text,
				refs: params.refs,
			});
			return {
				content: [
					{
						type: "text",
						text: `APPENDED: ${params.personaId} [r${entry.round} ${entry.kind}] ${entry.text.slice(0, 80)}${entry.text.length > 80 ? "…" : ""}`,
					},
				],
				details: { entry },
			};
		},
	});
}
