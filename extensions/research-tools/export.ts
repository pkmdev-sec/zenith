/**
 * export.ts — Structured export of research artifacts.
 *
 * Three tools:
 *   export_bibtex  — Extract sources from a markdown file and generate BibTeX
 *   export_csv     — Extract evidence/comparison tables from markdown into CSV
 *   export_json    — Export full research output as structured JSON
 *
 * These fill a critical gap: Zenith's outputs are markdown-only, which makes
 * them unusable in standard academic tools (Zotero, Mendeley, R, pandas, etc.).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ── BibTeX generation ──────────────────────────────────

interface ParsedSource {
	index: number;
	authors: string;
	title: string;
	year: string;
	url: string;
	venue: string;
	doi: string;
	arxiv: string;
	raw: string;
}

function parseSourceLine(line: string, index: number): ParsedSource {
	const raw = line.trim();

	// Extract URL
	const urlMatch = raw.match(/(https?:\/\/[^\s)\]>,"]+)/);
	const url = urlMatch ? urlMatch[1].replace(/[.,;:]+$/, "") : "";

	// Extract DOI
	const doiMatch = raw.match(/(?:DOI:\s*|doi\.org\/)(10\.\d{4,}\/[^\s,)]+)/i);
	const doi = doiMatch ? doiMatch[1] : "";

	// Extract arXiv ID
	const arxivMatch = raw.match(/(?:arxiv[.:]?\s*|arxiv\.org\/abs\/)(\d{4}\.\d{4,5}(?:v\d+)?)/i);
	const arxiv = arxivMatch ? arxivMatch[1] : "";

	// Extract year (4-digit number, prefer one in parentheses)
	const yearParenMatch = raw.match(/\((\d{4})\)/);
	const yearPlainMatch = raw.match(/\b(19\d{2}|20\d{2})\b/);
	const year = yearParenMatch?.[1] || yearPlainMatch?.[1] || "";

	// Heuristic parsing: assume "Author(s). Title. Venue." or "Author(s), Title, Venue"
	// Strip the URL and known identifiers
	let text = raw
		.replace(/(https?:\/\/[^\s)\]>,"]+)/g, "")
		.replace(/(?:DOI:\s*|doi\.org\/)10\.\d{4,}\/[^\s,)]*/gi, "")
		.replace(/(?:arXiv:\s*)\d{4}\.\d{4,5}(?:v\d+)?/gi, "")
		.replace(/\(\d{4}\)/g, "")
		.replace(/\s+/g, " ")
		.trim();

	// Try to split into author/title/venue by periods or em-dashes
	const parts = text.split(/\.\s+|—\s*|–\s*/);
	const authors = parts.length >= 2 ? parts[0].trim() : "";
	const title = parts.length >= 2 ? parts[1].trim() : parts[0]?.trim() || "";
	const venue = parts.length >= 3 ? parts[2].trim() : "";

	return { index, authors, title, year, url, venue, doi, arxiv, raw };
}

function generateBibtexKey(source: ParsedSource): string {
	const firstAuthor = source.authors.split(/[,&]/)[ 0]?.trim().split(/\s+/).pop() || "unknown";
	const year = source.year || "nd";
	const titleWord = source.title.split(/\s+/).find((w) => w.length > 3)?.toLowerCase() || "paper";
	return `${firstAuthor}${year}${titleWord}`.replace(/[^a-zA-Z0-9]/g, "");
}

function toBibtex(source: ParsedSource): string {
	const key = generateBibtexKey(source);
	const entryType = source.arxiv ? "article" : source.venue ? "inproceedings" : "misc";

	const fields: string[] = [];
	if (source.title) fields.push(`  title     = {${source.title}}`);
	if (source.authors) fields.push(`  author    = {${source.authors}}`);
	if (source.year) fields.push(`  year      = {${source.year}}`);
	if (source.venue) fields.push(`  booktitle = {${source.venue}}`);
	if (source.doi) fields.push(`  doi       = {${source.doi}}`);
	if (source.arxiv) fields.push(`  eprint    = {${source.arxiv}}`);
	if (source.arxiv) fields.push(`  archiveprefix = {arXiv}`);
	if (source.url) fields.push(`  url       = {${source.url}}`);
	fields.push(`  note      = {[${source.index}] in Zenith output}`);

	return `@${entryType}{${key},\n${fields.join(",\n")}\n}`;
}

// ── Markdown table to CSV ──────────────────────────────

function extractMarkdownTables(md: string): { header: string[]; rows: string[][] }[] {
	const tables: { header: string[]; rows: string[][] }[] = [];
	const lines = md.split("\n");

	let i = 0;
	while (i < lines.length) {
		const line = lines[i].trim();
		// Detect table header: | col1 | col2 | ...
		if (line.startsWith("|") && line.endsWith("|")) {
			const header = line
				.split("|")
				.slice(1, -1)
				.map((c) => c.trim());

			// Check for separator line
			if (i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
				const rows: string[][] = [];
				i += 2; // skip header + separator
				while (i < lines.length && lines[i].trim().startsWith("|")) {
					const row = lines[i]
						.trim()
						.split("|")
						.slice(1, -1)
						.map((c) => c.trim());
					rows.push(row);
					i++;
				}
				if (rows.length > 0) {
					tables.push({ header, rows });
				}
				continue;
			}
		}
		i++;
	}
	return tables;
}

function tableToCsv(table: { header: string[]; rows: string[][] }): string {
	const escape = (s: string) => {
		if (s.includes(",") || s.includes('"') || s.includes("\n")) {
			return `"${s.replace(/"/g, '""')}"`;
		}
		return s;
	};

	const lines = [table.header.map(escape).join(",")];
	for (const row of table.rows) {
		lines.push(row.map(escape).join(","));
	}
	return lines.join("\n");
}

// ── Sources section parser (shared with hallucination-guard) ──

function extractSourcesForExport(md: string): ParsedSource[] {
	const headingRe = /^#{1,4}\s*(Sources|References|Bibliography)\s*$/im;
	const match = headingRe.exec(md);
	if (!match) return [];

	const body = md.slice(match.index! + match[0].length);
	const sources: ParsedSource[] = [];

	for (const line of body.split("\n")) {
		if (/^#{1,4}\s/.test(line)) break;
		const entryMatch = line.match(/^\s*[-*]?\s*\[?(\d+)\]?[\.\):\s]\s*(.+)/);
		if (entryMatch) {
			sources.push(parseSourceLine(entryMatch[2], parseInt(entryMatch[1], 10)));
		}
	}
	return sources;
}

// ── Tool registration ──────────────────────────────────

export function registerExportTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "export_bibtex",
		description:
			"Extract all sources from a research output's Sources/References section and export as BibTeX. " +
			"Output can be imported into Zotero, Mendeley, or any citation manager.",
		
		parameters: Type.Object({
			filePath: Type.String({ description: "Markdown file to extract sources from" }),
			outputPath: Type.Optional(
				Type.String({ description: "Where to write the .bib file. Default: same name with .bib extension" }),
			),
		}),
		async execute(_id, params) {
			if (!existsSync(params.filePath)) {
				return { content: [{ type: "text", text: `File not found: ${params.filePath}` }] };
			}

			const md = readFileSync(params.filePath, "utf-8");
			const sources = extractSourcesForExport(md);

			if (sources.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No Sources/References section found in the file, or it is empty.",
						},
					],
				};
			}

			const bibtex = sources.map(toBibtex).join("\n\n");
			const outPath = params.outputPath || params.filePath.replace(/\.md$/, ".bib");
			writeFileSync(outPath, bibtex, "utf-8");

			return {
				content: [
					{
						type: "text",
						text: `Exported ${sources.length} sources to BibTeX:\n  ${outPath}\n\nEntries:\n${sources.map((s) => `  ${generateBibtexKey(s)} — ${s.title || s.raw.slice(0, 60)}`).join("\n")}`,
					},
				],
				details: { outPath, count: sources.length, sources },
			};
		},
	});

	pi.registerTool({
		name: "export_csv",
		description:
			"Extract markdown tables (evidence tables, comparison matrices, etc.) from a research output and export as CSV files. " +
			"Useful for importing into R, pandas, Excel, or any data analysis tool.",
		
		parameters: Type.Object({
			filePath: Type.String({ description: "Markdown file containing tables" }),
			outputPath: Type.Optional(
				Type.String({ description: "Output CSV path. For multiple tables, appends -1, -2, etc." }),
			),
			tableIndex: Type.Optional(
				Type.Number({ description: "Export only the Nth table (0-based). Default: export all" }),
			),
		}),
		async execute(_id, params) {
			if (!existsSync(params.filePath)) {
				return { content: [{ type: "text", text: `File not found: ${params.filePath}` }] };
			}

			const md = readFileSync(params.filePath, "utf-8");
			const tables = extractMarkdownTables(md);

			if (tables.length === 0) {
				return {
					content: [{ type: "text", text: "No markdown tables found in the file." }],
				};
			}

			const basePath = params.outputPath || params.filePath.replace(/\.md$/, ".csv");
			const outputs: string[] = [];

			const toExport =
				params.tableIndex !== undefined ? [tables[params.tableIndex]].filter(Boolean) : tables;

			for (const [i, table] of toExport.entries()) {
				const csv = tableToCsv(table);
				const path = toExport.length === 1 ? basePath : basePath.replace(/\.csv$/, `-${i + 1}.csv`);
				writeFileSync(path, csv, "utf-8");
				outputs.push(`  Table ${i + 1} (${table.header.join(", ")}): ${path} — ${table.rows.length} rows`);
			}

			return {
				content: [
					{
						type: "text",
						text: `Exported ${toExport.length} table(s) to CSV:\n${outputs.join("\n")}`,
					},
				],
				details: { paths: outputs, tableCount: toExport.length },
			};
		},
	});

	pi.registerTool({
		name: "export_json",
		description:
			"Export a research output as structured JSON with metadata, sections, sources, and claims. " +
			"Machine-readable format for downstream processing, dashboards, or API consumption.",
		
		parameters: Type.Object({
			filePath: Type.String({ description: "Markdown file to export" }),
			outputPath: Type.Optional(Type.String({ description: "Output JSON path" })),
		}),
		async execute(_id, params) {
			if (!existsSync(params.filePath)) {
				return { content: [{ type: "text", text: `File not found: ${params.filePath}` }] };
			}

			const md = readFileSync(params.filePath, "utf-8");
			const sources = extractSourcesForExport(md);
			const tables = extractMarkdownTables(md);

			// Parse sections
			const sections: { level: number; title: string; content: string }[] = [];
			const sectionRegex = /^(#{1,4})\s+(.+)$/gm;
			let lastIdx = 0;
			let lastSection: (typeof sections)[0] | null = null;

			for (const m of md.matchAll(sectionRegex)) {
				if (lastSection) {
					lastSection.content = md.slice(lastIdx, m.index).trim();
				}
				lastSection = { level: m[1].length, title: m[2].trim(), content: "" };
				sections.push(lastSection);
				lastIdx = m.index! + m[0].length;
			}
			if (lastSection) {
				lastSection.content = md.slice(lastIdx).trim();
			}

			// Extract inline citations per section
			const sectionCitations = sections.map((s) => ({
				title: s.title,
				level: s.level,
				wordCount: s.content.split(/\s+/).length,
				citations: [...s.content.matchAll(/\[(\d+)\]/g)].map((m) => parseInt(m[1], 10)),
			}));

			const output = {
				exportedAt: new Date().toISOString(),
				sourceFile: params.filePath,
				wordCount: md.split(/\s+/).length,
				sections: sectionCitations,
				sources: sources.map((s) => ({
					index: s.index,
					title: s.title,
					authors: s.authors,
					year: s.year,
					url: s.url,
					doi: s.doi,
					arxiv: s.arxiv,
					venue: s.venue,
				})),
				tables: tables.map((t, i) => ({
					index: i,
					columns: t.header,
					rowCount: t.rows.length,
					data: t.rows.map((row) => Object.fromEntries(t.header.map((h, j) => [h, row[j] || ""]))),
				})),
			};

			const outPath = params.outputPath || params.filePath.replace(/\.md$/, ".json");
			writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

			return {
				content: [
					{
						type: "text",
						text:
							`Exported structured JSON to: ${outPath}\n\n` +
							`Summary:\n` +
							`  Sections: ${sections.length}\n` +
							`  Sources: ${sources.length}\n` +
							`  Tables: ${tables.length}\n` +
							`  Word count: ${output.wordCount.toLocaleString()}`,
					},
				],
				details: output,
			};
		},
	});
}
