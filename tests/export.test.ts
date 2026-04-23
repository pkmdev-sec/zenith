import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { registerExportTools } from "../extensions/research-tools/export.js";

function loadTools() {
	const tools: Record<string, any> = {};
	const pi = { registerTool: (t: any) => { tools[t.name] = t; }, registerCommand: () => {}, on: () => {} } as any;
	registerExportTools(pi);
	return tools;
}

let workdir: string;
beforeEach(() => { workdir = mkdtempSync(resolve(tmpdir(), "zenith-exp-")); });
afterEach(() => { rmSync(workdir, { recursive: true, force: true }); });

function writeMd(content: string, name = "test.md"): string {
	const p = resolve(workdir, name);
	writeFileSync(p, content);
	return p;
}

describe("export_bibtex", () => {
	it("extracts sources and emits BibTeX entries", async () => {
		const tools = loadTools();
		const p = writeMd(`# Report

Some claim [1].

## Sources

1. Smith, J. Attention is all you need. NeurIPS 2017. https://arxiv.org/abs/1706.03762 arXiv: 1706.03762
2. Doe, A. Another paper. ICLR 2020. DOI: 10.1234/abc.2020
`);
		const r = await tools["export_bibtex"].execute("t", { filePath: p }, undefined, undefined, {} as any);
		assert.equal(r.details.count, 2);
		const bib = readFileSync(r.details.outPath as string, "utf8");
		assert.match(bib, /@article/);
		assert.match(bib, /archiveprefix = \{arXiv\}/);
		assert.match(bib, /doi\s+=\s+\{10\.1234\/abc\.2020\}/i);
	});

	it("returns a message when file has no Sources section", async () => {
		const tools = loadTools();
		const p = writeMd(`# Report\n\nNothing here.\n`);
		const r = await tools["export_bibtex"].execute("t", { filePath: p }, undefined, undefined, {} as any);
		assert.match(r.content[0].text, /No Sources/i);
	});
});

describe("export_csv", () => {
	it("writes a markdown table to CSV", async () => {
		const tools = loadTools();
		const p = writeMd(`# Report

| Model | Params | Accuracy |
|-------|--------|----------|
| GPT   | 175B   | 0.87     |
| BERT  | 340M   | 0.81     |
`);
		const r = await tools["export_csv"].execute("t", { filePath: p }, undefined, undefined, {} as any);
		assert.equal(r.details.tableCount, 1);
		// Find the emitted CSV
		const lines = (r.content[0].text as string).split("\n");
		const csvPathLine = lines.find(l => l.includes(".csv"));
		assert.ok(csvPathLine, `expected csv path, got ${r.content[0].text}`);
		const csvPath = csvPathLine!.split(": ")[1].split(" — ")[0];
		const csv = readFileSync(csvPath, "utf8");
		assert.match(csv, /Model,Params,Accuracy/);
		assert.match(csv, /GPT,175B,0\.87/);
	});

	it("reports 'no tables' when file has none", async () => {
		const tools = loadTools();
		const p = writeMd(`# Report\n\nPlain prose.\n`);
		const r = await tools["export_csv"].execute("t", { filePath: p }, undefined, undefined, {} as any);
		assert.match(r.content[0].text, /No markdown tables/i);
	});
});

describe("export_json", () => {
	it("emits structured JSON with sections, sources, and tables", async () => {
		const tools = loadTools();
		const p = writeMd(`# Report

Intro with claim [1].

## Findings

More text [2].

| Metric | Value |
|--------|-------|
| acc    | 0.95  |

## Sources

1. First at https://example.com
2. Second at https://example.org
`);
		const r = await tools["export_json"].execute("t", { filePath: p }, undefined, undefined, {} as any);
		const data = r.details;
		assert.equal((data.sources as any[]).length, 2);
		assert.equal((data.tables as any[]).length, 1);
		assert.ok((data.sections as any[]).length >= 3);
		// Validate written file
		const jsonPath = (data as any).sourceFile ? (data as any).sourceFile.replace(/\.md$/, ".json") : null;
		if (jsonPath) {
			assert.ok(existsSync(jsonPath));
			const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
			assert.equal(parsed.sources.length, 2);
		}
	});
});
