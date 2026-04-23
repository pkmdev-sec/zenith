/**
 * evidence-graph.ts — Shared claim/source graph for a swarm run.
 *
 * While memory.ts is per-persona (private thinking), this is shared: every
 * persona can read and write to it. It's how round 2 personas discover what
 * round 1 personas claimed, and how the synthesizer discovers consensus vs
 * dissent without running any LLM reasoning.
 *
 * Schema (append-only JSONL at ~/.zenith/swarm-work/<slug>/evidence.jsonl):
 *
 *   {
 *     id: "c_<stable-8-char-hash>",  // deterministic from (persona, claim, round)
 *     ts: "2026-04-23T..",
 *     round: 1,
 *     persona: "statistics-specialist-01",
 *     claim: "L2 regularization with λ=0.01 outperforms L1 on CIFAR-10",
 *     sources: [                       // URL + optional quoted fragment
 *       { url: "https://arxiv.org/abs/...", quote: "L2 yielded 92.3% vs 91.1% for L1" }
 *     ],
 *     kind: "assertion" | "support" | "contradict" | "qualify",
 *     targetClaimId?: "c_abc12345"    // set when kind != "assertion"
 *   }
 *
 * Kinds let round 2 personas explicitly react to round 1 claims:
 *   - support:    I agree with this claim and I have additional evidence.
 *   - contradict: I found evidence that falsifies this claim.
 *   - qualify:    True but only in context X / with caveat Y.
 *
 * Tools registered:
 *   - append_evidence : persona commits a new claim or reaction
 *   - query_evidence_graph : flexible read (by persona, by kind, recent, disputed)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";

// ── Path helpers ──────────────────────────────────────────────

function getZenithHome(): string {
	if (process.env.ZENITH_HOME) return process.env.ZENITH_HOME;
	const home = process.env.HOME ?? homedir();
	return resolve(home, ".zenith");
}

function getEvidencePath(slug: string): string {
	return resolve(getZenithHome(), "swarm-work", slug, "evidence.jsonl");
}

// ── Types ─────────────────────────────────────────────────────

export type EvidenceKind = "assertion" | "support" | "contradict" | "qualify";

export interface EvidenceSource {
	url: string;
	quote?: string;
}

export interface EvidenceEntry {
	id: string;
	ts: string;
	round: number;
	persona: string;
	claim: string;
	sources: EvidenceSource[];
	kind: EvidenceKind;
	targetClaimId?: string;
}

// ── IO primitives ─────────────────────────────────────────────

function readEvidenceFile(path: string): EvidenceEntry[] {
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8");
	const out: EvidenceEntry[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t) as EvidenceEntry);
		} catch {
			// skip malformed
		}
	}
	return out;
}

function appendEvidenceEntry(path: string, entry: EvidenceEntry): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

// Deterministic-ish id: first 8 hex chars of sha256(persona|claim|round).
// Same persona re-asserting the same claim in the same round collides intentionally
// (idempotent append). Different rounds or personas get different ids.
function makeClaimId(persona: string, claim: string, round: number): string {
	const h = createHash("sha256").update(`${persona}|${claim}|${round}`).digest("hex");
	return `c_${h.slice(0, 8)}`;
}

// ── Public helpers ────────────────────────────────────────────

export function readEvidenceGraph(slug: string): EvidenceEntry[] {
	return readEvidenceFile(getEvidencePath(slug));
}

export function appendEvidence(
	slug: string,
	entry: Omit<EvidenceEntry, "id" | "ts">,
): EvidenceEntry {
	const full: EvidenceEntry = {
		id: makeClaimId(entry.persona, entry.claim, entry.round),
		ts: new Date().toISOString(),
		...entry,
	};
	appendEvidenceEntry(getEvidencePath(slug), full);
	return full;
}

// Disputed claims: claims with both support and contradict children.
export function disputedClaimIds(slug: string): string[] {
	const entries = readEvidenceGraph(slug);
	const supportIds = new Set<string>();
	const contradictIds = new Set<string>();
	for (const e of entries) {
		if (!e.targetClaimId) continue;
		if (e.kind === "support") supportIds.add(e.targetClaimId);
		if (e.kind === "contradict") contradictIds.add(e.targetClaimId);
	}
	return [...supportIds].filter((id) => contradictIds.has(id));
}

// ── Tool registration ─────────────────────────────────────────

export function registerEvidenceGraphTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "append_evidence",
		label: "Append Evidence",
		description:
			"Commit a claim (or a reaction to someone else's claim) to the shared evidence " +
			"graph for this swarm run. Use kind='assertion' for a new claim; use 'support', " +
			"'contradict', or 'qualify' when reacting to an existing claim (pass its id as " +
			"targetClaimId). Every claim must include at least one source URL.",
		parameters: Type.Object({
			slug: Type.String({ description: "Swarm slug" }),
			persona: Type.String({ description: "Persona id of the claimer" }),
			round: Type.Number({ description: "Round number" }),
			claim: Type.String({ description: "The claim, one sentence." }),
			sources: Type.Array(
				Type.Object({
					url: Type.String({ description: "Source URL (paper, docs, web page)" }),
					quote: Type.Optional(Type.String({ description: "Short verbatim quote from the source" })),
				}),
				{ description: "At least one source URL. Empty list is not allowed." },
			),
			kind: Type.Union(
				[
					Type.Literal("assertion"),
					Type.Literal("support"),
					Type.Literal("contradict"),
					Type.Literal("qualify"),
				],
				{ description: "assertion | support | contradict | qualify" },
			),
			targetClaimId: Type.Optional(
				Type.String({ description: "When kind != 'assertion', the id of the claim being reacted to." }),
			),
		}),
		async execute(_id, params) {
			if (!params.sources || params.sources.length === 0) {
				return {
					content: [{ type: "text", text: "REJECTED: every evidence entry must include at least one source URL." }],
					details: { ok: false, reason: "no_sources" } as Record<string, unknown>,
				};
			}
			if (params.kind !== "assertion" && !params.targetClaimId) {
				return {
					content: [{ type: "text", text: `REJECTED: kind='${params.kind}' requires targetClaimId.` }],
					details: { ok: false, reason: "missing_target" } as Record<string, unknown>,
				};
			}
			const entry = appendEvidence(params.slug, {
				round: params.round,
				persona: params.persona,
				claim: params.claim,
				sources: params.sources,
				kind: params.kind,
				targetClaimId: params.targetClaimId,
			});
			return {
				content: [
					{
						type: "text",
						text: `APPENDED [${entry.id}] ${entry.kind}${entry.targetClaimId ? ` → ${entry.targetClaimId}` : ""}: ${entry.claim.slice(0, 100)}`,
					},
				],
				details: { entry } as Record<string, unknown>,
			};
		},
	});

	pi.registerTool({
		name: "query_evidence_graph",
		label: "Query Evidence Graph",
		description:
			"Read the shared evidence graph with optional filters. Use at the start of " +
			"round 2 so personas can see what other personas claimed in round 1 and decide " +
			"whether to support, contradict, or qualify. Filters combine AND.",
		parameters: Type.Object({
			slug: Type.String({ description: "Swarm slug" }),
			persona: Type.Optional(Type.String({ description: "Only entries from this persona" })),
			notPersona: Type.Optional(Type.String({ description: "Exclude entries from this persona (useful: 'show what OTHER personas claimed')" })),
			kind: Type.Optional(
				Type.Union([
					Type.Literal("assertion"),
					Type.Literal("support"),
					Type.Literal("contradict"),
					Type.Literal("qualify"),
				]),
			),
			round: Type.Optional(Type.Number({ description: "Only entries from this round" })),
			disputedOnly: Type.Optional(Type.Boolean({ description: "If true, return only assertions that have both support and contradict children." })),
			limit: Type.Optional(Type.Number({ description: "Max entries to return (default 50)" })),
		}),
		async execute(_id, params) {
			let entries = readEvidenceGraph(params.slug);
			if (params.persona) entries = entries.filter((e) => e.persona === params.persona);
			if (params.notPersona) entries = entries.filter((e) => e.persona !== params.notPersona);
			if (params.kind) entries = entries.filter((e) => e.kind === params.kind);
			if (params.round !== undefined) entries = entries.filter((e) => e.round === params.round);
			if (params.disputedOnly) {
				const disputed = new Set(disputedClaimIds(params.slug));
				entries = entries.filter((e) => disputed.has(e.id) || (e.targetClaimId && disputed.has(e.targetClaimId)));
			}
			const limit = params.limit ?? 50;
			entries = entries.slice(-limit); // most recent N

			const lines: string[] = [
				`# Evidence graph query: ${entries.length} entries`,
				"",
			];
			for (const e of entries) {
				const target = e.targetClaimId ? ` → ${e.targetClaimId}` : "";
				lines.push(`[${e.id}] r${e.round} ${e.persona} ${e.kind}${target}: ${e.claim}`);
				for (const s of e.sources) {
					lines.push(`    ${s.url}${s.quote ? ` — "${s.quote.slice(0, 80)}"` : ""}`);
				}
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { entries, disputed: params.disputedOnly ? disputedClaimIds(params.slug) : undefined },
			};
		},
	});
}
