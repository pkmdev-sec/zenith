/**
 * semantic-scholar.ts — Semantic Scholar API integration for Zenith.
 *
 * Provides access to 200M+ papers across ALL academic fields — not just arXiv.
 * Covers PubMed, IEEE, ACM, Springer, Elsevier, and more.
 *
 * Five tools:
 *   scholar_search     — Full-text paper search with filters
 *   scholar_paper      — Detailed paper info (accepts DOI, ArXiv ID, PMID, etc.)
 *   scholar_citations  — Forward citation traversal (who cited this?)
 *   scholar_references — Backward reference traversal (what does this cite?)
 *   scholar_author     — Author profile, h-index, and top papers
 *
 * Rate limits: 100 requests / 5 minutes without API key.
 * Set SEMANTIC_SCHOLAR_API_KEY env var for higher limits.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ── API configuration ──────────────────────────────────

const S2_BASE = "https://api.semanticscholar.org/graph/v1";

const FIELDS = {
	search: "title,abstract,year,venue,citationCount,authors,url,externalIds,publicationDate,openAccessPdf,tldr",
	paper: "title,abstract,year,venue,citationCount,referenceCount,influentialCitationCount,authors,url,externalIds,publicationDate,fieldsOfStudy,openAccessPdf,tldr,journal,publicationTypes",
	citation: "title,year,venue,citationCount,authors,url,externalIds,abstract",
	reference: "title,year,venue,citationCount,authors,url,externalIds,abstract",
	author: "name,hIndex,citationCount,paperCount,url,affiliations",
	authorPaper: "title,year,venue,citationCount,url,externalIds",
};

// ── HTTP layer with retry and rate-limit handling ──────

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1100; // ~1 req/sec to stay under limits

async function s2Fetch(path: string, params: Record<string, string> = {}): Promise<any> {
	// Throttle requests
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < MIN_REQUEST_INTERVAL_MS) {
		await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
	}
	lastRequestTime = Date.now();

	const url = new URL(S2_BASE + path);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== "") url.searchParams.set(k, v);
	}

	const headers: Record<string, string> = {
		"User-Agent": "Zenith-Research-Agent/1.0",
	};
	const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
	if (apiKey) headers["x-api-key"] = apiKey;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15000);

	try {
		let response = await fetch(url.toString(), { headers, signal: controller.signal });
		clearTimeout(timer);

		// Retry once on rate limit
		if (response.status === 429) {
			const retryAfter = parseInt(response.headers.get("retry-after") || "3", 10);
			await new Promise((r) => setTimeout(r, retryAfter * 1000));
			const controller2 = new AbortController();
			const timer2 = setTimeout(() => controller2.abort(), 15000);
			response = await fetch(url.toString(), { headers, signal: controller2.signal });
			clearTimeout(timer2);
		}

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(
				`Semantic Scholar API error: HTTP ${response.status} ${response.statusText}` +
					(body ? `\n${body.slice(0, 200)}` : ""),
			);
		}

		return await response.json();
	} catch (err: any) {
		clearTimeout(timer);
		if (err.name === "AbortError") {
			throw new Error("Semantic Scholar API request timed out (15s)");
		}
		throw err;
	}
}

// ── Formatting helpers ─────────────────────────────────

function formatAuthors(authors: any[]): string {
	if (!authors?.length) return "Unknown";
	if (authors.length <= 3) return authors.map((a: any) => a.name).join(", ");
	return `${authors[0].name}, ${authors[1].name}, ... +${authors.length - 2} more`;
}

function formatPaper(p: any, index: number): string {
	const lines = [`[${index}] ${p.title || "Untitled"}`];
	lines.push(`    Authors: ${formatAuthors(p.authors)}`);
	lines.push(
		`    Year: ${p.year || "?"} | Venue: ${p.venue || "?"} | Citations: ${p.citationCount ?? "?"}`,
	);
	if (p.url) lines.push(`    URL: ${p.url}`);
	if (p.tldr?.text) lines.push(`    TLDR: ${p.tldr.text}`);
	if (p.openAccessPdf?.url) lines.push(`    PDF: ${p.openAccessPdf.url}`);
	if (p.externalIds?.ArXiv) lines.push(`    arXiv: ${p.externalIds.ArXiv}`);
	if (p.externalIds?.DOI) lines.push(`    DOI: ${p.externalIds.DOI}`);
	if (p.externalIds?.PubMed) lines.push(`    PubMed: ${p.externalIds.PubMed}`);
	if (p.abstract) {
		const abs = p.abstract.length > 300 ? p.abstract.slice(0, 300) + "..." : p.abstract;
		lines.push(`    Abstract: ${abs}`);
	}
	return lines.join("\n");
}

function formatPaperBrief(p: any, index: number): string {
	return (
		`[${index}] ${p.title || "Untitled"} (${p.year || "?"}) — ${formatAuthors(p.authors)}` +
		` [${p.citationCount ?? "?"} citations]` +
		(p.url ? ` ${p.url}` : "")
	);
}

// ── Tool registration ──────────────────────────────────

export function registerSemanticScholarTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "scholar_search",
		label: "Scholar Search",
		description:
			"Search Semantic Scholar's corpus of 200M+ papers across ALL academic fields. " +
			"Broader than arXiv-only search — covers PubMed, IEEE, ACM, Springer, Elsevier, and more. " +
			"Use this alongside alpha_search for comprehensive literature coverage.",
		
		parameters: Type.Object({
			query: Type.String({ description: "Search query — natural language or keywords" }),
			limit: Type.Optional(Type.Number({ description: "Max results, 1-100. Default: 10" })),
			year: Type.Optional(
				Type.String({ description: 'Year range filter: "2020-2024", "2023-", "-2020"' }),
			),
			fieldsOfStudy: Type.Optional(
				Type.String({
					description:
					"Comma-separated: Computer Science, Medicine, Biology, Physics, Mathematics, Chemistry, Engineering, Psychology, Economics, etc.",
				}),
			),
			minCitations: Type.Optional(
				Type.Number({ description: "Only return papers with at least this many citations" }),
			),
		}),
		async execute(_id, params) {
			try {
				const searchParams: Record<string, string> = {
					query: params.query,
					limit: String(Math.min(Math.max(params.limit || 10, 1), 100)),
					fields: FIELDS.search,
				};
				if (params.year) searchParams.year = params.year;
				if (params.fieldsOfStudy) searchParams.fieldsOfStudy = params.fieldsOfStudy;
				if (params.minCitations) searchParams.minCitationCount = String(params.minCitations);

				const result = await s2Fetch("/paper/search", searchParams);
				const papers = result.data || [];

				if (papers.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `Semantic Scholar: No results for "${params.query}". Try broader terms, different spelling, or remove filters.`,
							},
						], details: undefined,
					};
				}

				const formatted = papers.map((p: any, i: number) => formatPaper(p, i + 1)).join("\n\n");
				const text =
					`Semantic Scholar: ${result.total?.toLocaleString() ?? "?"} total results for "${params.query}"\n` +
					`Showing ${papers.length} of ${result.total ?? "?"}\n\n${formatted}`;

				return { content: [{ type: "text", text }], details: result };
			} catch (err: any) {
				return {
					content: [
						{
							type: "text",
							text: `Semantic Scholar search failed: ${err.message}\n\nFallback: try alpha_search or web_search for this query.`,
						},
					], details: undefined,
				};
			}
		},
	});

	pi.registerTool({
		name: "scholar_paper",
		label: "Scholar Paper",
		description:
			"Get detailed information about a specific paper from Semantic Scholar. " +
			"Accepts multiple ID formats: Semantic Scholar ID, DOI (DOI:10.xxx), " +
			"ArXiv ID (ARXIV:2106.09685), PubMed ID (PMID:12345), ACL ID (ACL:P18-1234), " +
			"or a direct Semantic Scholar URL.",
		
		parameters: Type.Object({
			paperId: Type.String({
				description:
				'Paper identifier: S2 ID, "DOI:10.xxx", "ARXIV:2106.09685", "PMID:12345", or URL',
			}),
		}),
		async execute(_id, params) {
			try {
				const result = await s2Fetch(`/paper/${encodeURIComponent(params.paperId)}`, {
					fields: FIELDS.paper,
				});

				const lines = [
					`# ${result.title || "Untitled"}`,
					``,
					`**Authors:** ${formatAuthors(result.authors)}`,
					`**Year:** ${result.year || "?"} | **Venue:** ${result.venue || result.journal?.name || "?"}`,
					`**Citations:** ${result.citationCount ?? "?"} (${result.influentialCitationCount ?? "?"} influential) | **References:** ${result.referenceCount ?? "?"}`,
				];

				if (result.fieldsOfStudy?.length)
					lines.push(`**Fields:** ${result.fieldsOfStudy.join(", ")}`);
				if (result.publicationTypes?.length)
					lines.push(`**Type:** ${result.publicationTypes.join(", ")}`);
				if (result.url) lines.push(`**URL:** ${result.url}`);
				if (result.openAccessPdf?.url) lines.push(`**PDF:** ${result.openAccessPdf.url}`);
				if (result.externalIds?.DOI) lines.push(`**DOI:** ${result.externalIds.DOI}`);
				if (result.externalIds?.ArXiv) lines.push(`**arXiv:** ${result.externalIds.ArXiv}`);
				if (result.externalIds?.PubMed) lines.push(`**PubMed:** ${result.externalIds.PubMed}`);
				if (result.tldr?.text) lines.push(``, `**TLDR:** ${result.tldr.text}`);
				if (result.abstract) lines.push(``, `## Abstract`, ``, result.abstract);

				return { content: [{ type: "text", text: lines.join("\n") }], details: result };
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Failed to fetch paper: ${err.message}` }], details: undefined,
				};
			}
		},
	});

	pi.registerTool({
		name: "scholar_citations",
		label: "Scholar Citations",
		description:
			"Get papers that CITE a given paper (forward citation traversal). " +
			"Essential for understanding a paper's impact and finding follow-up work. " +
			"Returns citing papers sorted by influence.",
		
		parameters: Type.Object({
			paperId: Type.String({ description: "Paper ID (same formats as scholar_paper)" }),
			limit: Type.Optional(Type.Number({ description: "Max results, 1-100. Default: 20" })),
		}),
		async execute(_id, params) {
			try {
				const result = await s2Fetch(`/paper/${encodeURIComponent(params.paperId)}/citations`, {
					fields: FIELDS.citation,
					limit: String(Math.min(params.limit || 20, 100)),
				});

				const citations = (result.data || [])
					.map((c: any) => c.citingPaper)
					.filter((p: any) => p?.title);

				if (citations.length === 0) {
					return {
						content: [{ type: "text", text: "No citations found for this paper." }], details: undefined,
					};
				}

				// Sort by citation count (most influential first)
				citations.sort((a: any, b: any) => (b.citationCount || 0) - (a.citationCount || 0));

				const formatted = citations.map((p: any, i: number) => formatPaperBrief(p, i + 1)).join("\n");
				const text = `Papers citing this work (${citations.length} shown):\n\n${formatted}`;

				return { content: [{ type: "text", text }], details: result };
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Failed to fetch citations: ${err.message}` }], details: undefined,
				};
			}
		},
	});

	pi.registerTool({
		name: "scholar_references",
		label: "Scholar References",
		description:
			"Get papers REFERENCED BY a given paper (backward citation traversal). " +
			"Shows what foundational work a paper builds upon. " +
			"Use this to trace the intellectual lineage of an idea.",
		
		parameters: Type.Object({
			paperId: Type.String({ description: "Paper ID (same formats as scholar_paper)" }),
			limit: Type.Optional(Type.Number({ description: "Max results, 1-100. Default: 20" })),
		}),
		async execute(_id, params) {
			try {
				const result = await s2Fetch(`/paper/${encodeURIComponent(params.paperId)}/references`, {
					fields: FIELDS.reference,
					limit: String(Math.min(params.limit || 20, 100)),
				});

				const refs = (result.data || [])
					.map((r: any) => r.citedPaper)
					.filter((p: any) => p?.title);

				if (refs.length === 0) {
					return {
						content: [{ type: "text", text: "No references found for this paper." }], details: undefined,
					};
				}

				refs.sort((a: any, b: any) => (b.citationCount || 0) - (a.citationCount || 0));

				const formatted = refs.map((p: any, i: number) => formatPaperBrief(p, i + 1)).join("\n");
				const text = `References from this paper (${refs.length} shown):\n\n${formatted}`;

				return { content: [{ type: "text", text }], details: result };
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Failed to fetch references: ${err.message}` }], details: undefined,
				};
			}
		},
	});

	pi.registerTool({
		name: "scholar_author",
		label: "Scholar Author",
		description:
			"Look up an author on Semantic Scholar. Returns h-index, citation count, " +
			"affiliations, and most-cited papers. Use for assessing author expertise and finding related work.",
		
		parameters: Type.Object({
			query: Type.String({
				description: "Author name to search, or Semantic Scholar author ID",
			}),
			paperLimit: Type.Optional(
				Type.Number({ description: "Max papers to return. Default: 10" }),
			),
		}),
		async execute(_id, params) {
			try {
				let authorId = params.query;

				// If it looks like a name (not a numeric ID), search first
				if (!/^\d+$/.test(params.query)) {
					const searchResult = await s2Fetch("/author/search", {
						query: params.query,
						limit: "1",
					});
					const authors = searchResult.data || [];
					if (authors.length === 0) {
						return {
							content: [
								{
									type: "text",
									text: `No author found for "${params.query}". Try a more specific name.`,
								},
							], details: undefined,
						};
					}
					authorId = authors[0].authorId;
				}

				// Fetch author details
				const author = await s2Fetch(`/author/${authorId}`, { fields: FIELDS.author });

				// Fetch top papers
				const papersResult = await s2Fetch(`/author/${authorId}/papers`, {
					fields: FIELDS.authorPaper,
					limit: String(Math.min(params.paperLimit || 10, 50)),
				});

				const papers = (papersResult.data || []).sort(
					(a: any, b: any) => (b.citationCount || 0) - (a.citationCount || 0),
				);

				const lines = [
					`# ${author.name || "Unknown Author"}`,
					``,
					`**h-index:** ${author.hIndex ?? "?"}`,
					`**Total citations:** ${author.citationCount?.toLocaleString() ?? "?"}`,
					`**Papers:** ${author.paperCount?.toLocaleString() ?? "?"}`,
				];
				if (author.affiliations?.length)
					lines.push(`**Affiliations:** ${author.affiliations.join(", ")}`);
				if (author.url) lines.push(`**Profile:** ${author.url}`);

				if (papers.length > 0) {
					lines.push(``, `## Top Papers (by citations)`);
					for (const [i, p] of papers.entries()) {
						lines.push(formatPaperBrief(p, i + 1));
					}
				}

				return { content: [{ type: "text", text: lines.join("\n") }], details: { author, papers } };
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Failed to fetch author: ${err.message}` }], details: undefined,
				};
			}
		},
	});
}
