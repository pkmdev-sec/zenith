/**
 * hallucination-guard.ts — Programmatic citation verification and output validation.
 *
 * Two tools:
 *   verify_citations  — Cross-references every [N] citation against the Sources section
 *                        and live-fetches each URL to confirm it resolves.
 *   validate_output   — Checks structural completeness of a research artifact against
 *                        Zenith's workflow requirements.
 *
 * This is the primary anti-hallucination layer. The LLM agents are instructed to use
 * these tools before delivering any artifact, but the tools also serve as an independent
 * audit mechanism for humans.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── Swarm receipt helpers ──────────────────────────────
//
// verify_citations can optionally receive a `slug`, in which case a PASS
// verdict is recorded into the swarm's events.jsonl as a
// `verify_citations_passed` event. That event is what `deliver_artifact`
// uses to tell "citation verifier actually ran" apart from "model just
// called deliver_artifact directly". The resolver mirrors orchestration.ts
// rather than importing from it: hallucination-guard must remain usable
// out-of-band (human auditors re-running the tool after the fact).

function hgZenithHome(): string {
	if (process.env.ZENITH_HOME) return process.env.ZENITH_HOME;
	const home = process.env.HOME ?? homedir();
	return resolve(home, ".zenith");
}

function hgSwarmDir(slug: string): string {
	return resolve(hgZenithHome(), "swarm-work", slug);
}

function hgSwarmEventsPath(slug: string): string {
	return resolve(hgSwarmDir(slug), "events.jsonl");
}

function hgAppendSwarmEvent(slug: string, event: Record<string, unknown>): void {
	// Only append when the swarm dir already exists — this prevents stray
	// calls of verify_citations(slug="typo") from creating orphan state.
	if (!existsSync(hgSwarmDir(slug))) return;
	appendFileSync(hgSwarmEventsPath(slug), JSON.stringify(event) + "\n", "utf-8");
}

// ── Types ──────────────────────────────────────────────

interface SourceEntry {
	index: number;
	url: string;
	title: string;
	raw: string;
}

interface CitationIssue {
	severity: "fatal" | "major" | "minor";
	citation: number;
	message: string;
}

interface UrlCheckResult {
	url: string;
	status: "live" | "dead" | "redirect" | "timeout" | "error" | "skipped";
	httpStatus?: number;
	resolvedUrl?: string;
	error?: string;
}

// ── Parsing helpers ────────────────────────────────────

/** Strip fenced code blocks so we don't pick up [1] inside code. */
function stripCodeBlocks(md: string): string {
	return md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
}

/** Extract every unique [N] reference from the body text. */
function extractInlineCitations(md: string): number[] {
	const clean = stripCodeBlocks(md);
	const seen = new Set<number>();
	for (const m of clean.matchAll(/\[(\d+)\]/g)) {
		seen.add(parseInt(m[1], 10));
	}
	return [...seen].sort((a, b) => a - b);
}

/** Parse the Sources / References section into structured entries. */
function extractSources(md: string): SourceEntry[] {
	// Find the heading
	const headingRe = /^#{1,4}\s*(Sources|References|Bibliography)\s*$/im;
	const match = headingRe.exec(md);
	if (!match) return [];

	const body = md.slice(match.index! + match[0].length);
	const entries: SourceEntry[] = [];

	for (const line of body.split("\n")) {
		// Stop at next heading
		if (/^#{1,4}\s/.test(line)) break;

		// Match patterns: [1] ..., 1. ..., 1) ..., - [1] ...
		const entryMatch = line.match(/^\s*[-*]?\s*\[?(\d+)\]?[\.\):\s]\s*(.+)/);
		if (!entryMatch) continue;

		const index = parseInt(entryMatch[1], 10);
		const raw = entryMatch[2].trim();

		// Extract URLs — greedy match up to whitespace or closing paren/bracket
		const urlMatch = raw.match(/(https?:\/\/[^\s)\]>,"]+)/);
		const url = urlMatch ? urlMatch[1].replace(/[.,;:]+$/, "") : "";
		const title = urlMatch
			? raw.slice(0, urlMatch.index).replace(/[\s.\-–—]+$/, "").trim()
			: raw;

		entries.push({ index, url, title, raw });
	}

	return entries;
}

// ── URL verification ───────────────────────────────────

async function checkUrl(url: string, timeoutMs = 10000): Promise<UrlCheckResult> {
	if (!url) return { url, status: "skipped", error: "No URL provided" };

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		// Try HEAD first (cheaper)
		let res = await fetch(url, {
			method: "HEAD",
			signal: controller.signal,
			redirect: "follow",
			headers: { "User-Agent": "Zenith-CitationVerifier/1.0" },
		});
		clearTimeout(timer);

		// Some servers reject HEAD — fall back to GET
		if (res.status === 405 || res.status === 403) {
			const controller2 = new AbortController();
			const timer2 = setTimeout(() => controller2.abort(), timeoutMs);
			res = await fetch(url, {
				method: "GET",
				signal: controller2.signal,
				redirect: "follow",
				headers: { "User-Agent": "Zenith-CitationVerifier/1.0" },
			});
			clearTimeout(timer2);
		}

		if (res.ok) {
			const resolved = res.url !== url ? res.url : undefined;
			return { url, status: resolved ? "redirect" : "live", httpStatus: res.status, resolvedUrl: resolved };
		}
		if (res.status === 404 || res.status === 410) {
			return { url, status: "dead", httpStatus: res.status };
		}
		return { url, status: "error", httpStatus: res.status, error: `HTTP ${res.status}` };
	} catch (err: any) {
		if (err.name === "AbortError") {
			return { url, status: "timeout", error: `Timed out after ${timeoutMs}ms` };
		}
		return { url, status: "error", error: err.message || String(err) };
	}
}

// ── Section detection for structural validation ────────

const WORKFLOW_SECTIONS: Record<string, string[]> = {
	deepresearch: ["Summary", "Background", "Key Findings", "Open Questions", "Sources"],
	lit: ["Scope", "Consensus", "Disagreements", "Open Questions", "Sources"],
	review: ["Summary Assessment", "Strengths", "Weaknesses", "Sources"],
	audit: ["Match Summary", "Confirmed Claims", "Mismatches", "Sources"],
	compare: ["Source Summaries", "Agreement", "Disagreement", "Synthesis", "Sources"],
	draft: ["Abstract", "Introduction", "Sources"],
};

function detectSections(md: string): string[] {
	const headings: string[] = [];
	for (const m of md.matchAll(/^#{1,4}\s+(.+)$/gm)) {
		headings.push(m[1].trim());
	}
	return headings;
}

// ── Tool registration ──────────────────────────────────

export function registerHallucinationGuard(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "verify_citations",
		label: "Verify Citations",
		description:
			"Verify all citations in a research output file. Checks: " +
			"(1) every inline [N] has a matching source entry, " +
			"(2) every source is referenced at least once, " +
			"(3) every URL is live and accessible. " +
			"Run this before delivering ANY research artifact to catch hallucinated or broken citations.",
		parameters: Type.Object({
			filePath: Type.String({ description: "Path to the markdown file to verify" }),
			checkUrls: Type.Optional(
				Type.Boolean({ description: "Fetch each URL to verify it resolves. Default: true" }),
			),
			slug: Type.Optional(
				Type.String({ description: "Swarm slug. When provided and the verdict is PASS (0 fatal, 0 major), a `verify_citations_passed` event is appended to the swarm\'s events.jsonl. `deliver_artifact` requires that event to exist for the same slug." }),
			),
		}),
		async execute(_id, params) {
			const { filePath, checkUrls = true, slug } = params as { filePath: string; checkUrls?: boolean; slug?: string };

			if (!existsSync(filePath)) {
				return {
					content: [{ type: "text", text: `Error: File not found: ${filePath}` }], details: undefined,
				};
			}

			const md = readFileSync(filePath, "utf-8");
			const inlineCites = extractInlineCitations(md);
			const sources = extractSources(md);
			const issues: CitationIssue[] = [];

			// ── Check 1: Orphan inline citations (referenced but no source entry)
			const sourceIndices = new Set(sources.map((s) => s.index));
			for (const n of inlineCites) {
				if (!sourceIndices.has(n)) {
					issues.push({
						severity: "fatal",
						citation: n,
						message: `[${n}] is referenced in text but has no entry in Sources section`,
					});
				}
			}

			// ── Check 2: Orphan sources (listed but never referenced)
			const inlineSet = new Set(inlineCites);
			for (const s of sources) {
				if (!inlineSet.has(s.index)) {
					issues.push({
						severity: "minor",
						citation: s.index,
						message: `Source [${s.index}] is listed but never referenced in the text`,
					});
				}
			}

			// ── Check 3: Sources with no URL
			for (const s of sources) {
				if (!s.url) {
					issues.push({
						severity: "major",
						citation: s.index,
						message: `Source [${s.index}] has no URL: "${s.title}"`,
					});
				}
			}

			// ── Check 4: Numbering gaps
			if (sources.length > 0) {
				const maxIdx = Math.max(...sources.map((s) => s.index));
				for (let i = 1; i <= maxIdx; i++) {
					if (!sourceIndices.has(i)) {
						issues.push({
							severity: "minor",
							citation: i,
							message: `Gap in source numbering: [${i}] is missing (sources go up to [${maxIdx}])`,
						});
					}
				}
			}

			// ── Check 5: URL liveness
			const urlResults: UrlCheckResult[] = [];
			if (checkUrls) {
				const urlSources = sources.filter((s) => s.url);
				// Process in batches of 5 to avoid hammering servers
				for (let i = 0; i < urlSources.length; i += 5) {
					const batch = urlSources.slice(i, i + 5);
					const results = await Promise.all(batch.map((s) => checkUrl(s.url)));
					for (let j = 0; j < batch.length; j++) {
						const result = results[j];
						urlResults.push(result);
						if (result.status === "dead") {
							issues.push({
								severity: "fatal",
								citation: batch[j].index,
								message: `Source [${batch[j].index}] URL is dead (HTTP ${result.httpStatus}): ${result.url}`,
							});
						} else if (result.status === "timeout") {
							issues.push({
								severity: "major",
								citation: batch[j].index,
								message: `Source [${batch[j].index}] URL timed out: ${result.url}`,
							});
						} else if (result.status === "error") {
							issues.push({
								severity: "major",
								citation: batch[j].index,
								message: `Source [${batch[j].index}] URL check failed (${result.error}): ${result.url}`,
							});
						}
					}
					// Rate-limit pause between batches
					if (i + 5 < urlSources.length) {
						await new Promise((r) => setTimeout(r, 500));
					}
				}
			}

			// ── Format report
			const fatals = issues.filter((i) => i.severity === "fatal");
			const majors = issues.filter((i) => i.severity === "major");
			const minors = issues.filter((i) => i.severity === "minor");
			const urlsChecked = urlResults.length;
			const urlsLive = urlResults.filter((r) => r.status === "live" || r.status === "redirect").length;

			const lines: string[] = [
				`# Citation Verification Report`,
				``,
				`**File:** ${filePath}`,
				`**Inline citations found:** ${inlineCites.length}`,
				`**Source entries found:** ${sources.length}`,
				checkUrls ? `**URLs checked:** ${urlsChecked} (${urlsLive} live)` : `**URL checking:** skipped`,
				``,
				`## Verdict: ${fatals.length > 0 ? "FAIL" : majors.length > 0 ? "WARN" : "PASS"}`,
				``,
				`- Fatal issues: ${fatals.length}`,
				`- Major issues: ${majors.length}`,
				`- Minor issues: ${minors.length}`,
			];

			if (issues.length > 0) {
				lines.push(``, `## Issues`);
				for (const issue of issues) {
					const icon = issue.severity === "fatal" ? "🔴" : issue.severity === "major" ? "🟡" : "⚪";
					lines.push(`${icon} **${issue.severity.toUpperCase()}** ${issue.message}`);
				}
			}

			if (fatals.length === 0 && majors.length === 0) {
				lines.push(``, `All citations verified. Output is safe to deliver.`);
			} else {
				lines.push(
					``,
					`**Action required:** Fix fatal/major issues before delivering this artifact.`,
				);
			}

			const text = lines.join("\n");

			// Emit the swarm receipt: a PASS verdict (no fatal + no major issues)
			// gates deliver_artifact for this slug. We intentionally do NOT emit
			// on WARN/FAIL — deliver_artifact should keep blocking those runs.
			if (slug && fatals.length === 0 && majors.length === 0) {
				hgAppendSwarmEvent(slug, {
					ts: new Date().toISOString(),
					type: "verify_citations_passed",
					artifact: filePath,
					inlineCitations: inlineCites.length,
					sources: sources.length,
					urlsChecked,
					urlsLive,
					minorIssues: minors.length,
				});
			}

			return { content: [{ type: "text", text }], details: { issues, urlResults, inlineCites, sources, slug, verdict: fatals.length > 0 ? "FAIL" : majors.length > 0 ? "WARN" : "PASS" } };
		},
	});

	pi.registerTool({
		name: "validate_output",
		label: "Validate Output",
		description:
			"Validate that a research output has the required structure for its workflow type. " +
			"Checks section presence, citation density, and structural completeness. " +
			"Use this alongside verify_citations for a full quality gate before delivery.",
		parameters: Type.Object({
			filePath: Type.String({ description: "Path to the output file" }),
			workflowType: Type.Optional(
				Type.String({
					description:
						"Workflow that produced this: deepresearch, lit, review, audit, compare, draft. Auto-detected if omitted.",
				}),
			),
		}),
		async execute(_id, params) {
			const { filePath } = params;

			if (!existsSync(filePath)) {
				return {
					content: [{ type: "text", text: `Error: File not found: ${filePath}` }], details: undefined,
				};
			}

			const md = readFileSync(filePath, "utf-8");
			const headings = detectSections(md);
			const sources = extractSources(md);
			const inlineCites = extractInlineCitations(md);
			const wordCount = md.split(/\s+/).length;
			const issues: string[] = [];

			// Auto-detect workflow type from content if not specified
			let wfType = params.workflowType;
			if (!wfType) {
				if (headings.some((h) => /match summary/i.test(h))) wfType = "audit";
				else if (headings.some((h) => /agreement.*matrix/i.test(h) || /disagreement/i.test(h)))
					wfType = "compare";
				else if (headings.some((h) => /strengths/i.test(h) && headings.some((h2) => /weaknesses/i.test(h2))))
					wfType = "review";
				else if (headings.some((h) => /abstract/i.test(h))) wfType = "draft";
				else if (headings.some((h) => /consensus/i.test(h))) wfType = "lit";
				else wfType = "deepresearch";
			}

			// Check required sections
			const required = WORKFLOW_SECTIONS[wfType] || WORKFLOW_SECTIONS.deepresearch;
			for (const section of required) {
				const found = headings.some((h) => h.toLowerCase().includes(section.toLowerCase()));
				if (!found) {
					issues.push(`Missing required section: "${section}" (expected for ${wfType} workflow)`);
				}
			}

			// Check citation density (at least 1 citation per 300 words for research outputs)
			if (wfType !== "review" && wordCount > 200) {
				const expectedCites = Math.max(3, Math.floor(wordCount / 300));
				if (inlineCites.length < expectedCites) {
					issues.push(
						`Low citation density: ${inlineCites.length} citations for ${wordCount} words ` +
							`(expected at least ${expectedCites}). May indicate unsourced claims.`,
					);
				}
			}

			// Check Sources section exists and has entries
			if (sources.length === 0) {
				issues.push("No Sources/References section found, or it is empty.");
			}

			// Check for minimum length
			if (wordCount < 200 && wfType !== "review") {
				issues.push(`Output is very short (${wordCount} words). May be incomplete.`);
			}

			const lines = [
				`# Output Validation Report`,
				``,
				`**File:** ${filePath}`,
				`**Detected workflow:** ${wfType}`,
				`**Word count:** ${wordCount.toLocaleString()}`,
				`**Sections found:** ${headings.length}`,
				`**Citations:** ${inlineCites.length} inline, ${sources.length} sources`,
				``,
				`## Verdict: ${issues.length === 0 ? "PASS" : "ISSUES FOUND"}`,
			];

			if (issues.length > 0) {
				lines.push(``, `## Issues (${issues.length})`);
				for (const issue of issues) {
					lines.push(`- ${issue}`);
				}
			} else {
				lines.push(``, `Structure looks good. Proceed with delivery.`);
			}

			return { content: [{ type: "text", text: lines.join("\n") }], details: { wfType, headings, wordCount, issues } };
		},
	});
}
