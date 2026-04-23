import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { registerHallucinationGuard } from "../extensions/research-tools/hallucination-guard.js";

type AnyTool = { execute: (id: string, params: any, ...rest: any[]) => Promise<any> };

function loadTools() {
	const tools: Record<string, AnyTool> = {};
	const pi = { registerTool: (t: any) => { tools[t.name] = t; }, registerCommand: () => {}, on: () => {} } as any;
	registerHallucinationGuard(pi);
	return tools;
}

let workdir: string;
beforeEach(() => { workdir = mkdtempSync(resolve(tmpdir(), "zenith-hg-")); });
afterEach(() => { rmSync(workdir, { recursive: true, force: true }); });

function writeMd(content: string): string {
	const p = resolve(workdir, "test.md");
	writeFileSync(p, content);
	return p;
}

// ── verify_citations (structural checks, URL checking skipped) ──

describe("verify_citations — structural checks", () => {
	it("reports PASS on well-formed artifact", async () => {
		const tools = loadTools();
		const p = writeMd(`# Report

A claim [1] and another [2].

## Sources

1. First at https://example.com/a
2. Second at https://example.com/b
`);
		const r = await tools["verify_citations"].execute("t", { filePath: p, checkUrls: false }, undefined, undefined, {} as any);
		assert.match(r.content[0].text, /PASS/);
	});

	it("flags orphan inline citations as FATAL", async () => {
		const tools = loadTools();
		const p = writeMd(`# Report

A claim [1] and [2] and [99].

## Sources

1. First at https://example.com/a
2. Second at https://example.com/b
`);
		const r = await tools["verify_citations"].execute("t", { filePath: p, checkUrls: false }, undefined, undefined, {} as any);
		assert.match(r.content[0].text, /FAIL/);
		const fatals = (r.details.issues as any[]).filter(i => i.severity === "fatal");
		assert.ok(fatals.some(f => String(f.message).includes("[99]")), `expected fatal for [99], got: ${JSON.stringify(fatals)}`);
	});

	it("flags orphan sources as MINOR", async () => {
		const tools = loadTools();
		const p = writeMd(`# Report

One claim [1] only.

## Sources

1. First at https://example.com/a
2. Listed but unused source
`);
		const r = await tools["verify_citations"].execute("t", { filePath: p, checkUrls: false }, undefined, undefined, {} as any);
		const minors = (r.details.issues as any[]).filter(i => i.severity === "minor");
		assert.ok(minors.some(m => String(m.message).includes("[2]")), `expected minor for [2], got: ${JSON.stringify(minors)}`);
	});

	it("ignores citations inside fenced code blocks", async () => {
		const tools = loadTools();
		const p = writeMd(`# Report

Real claim [1].

\`\`\`
code block with [99] that should not count
\`\`\`

## Sources

1. First at https://example.com/a
`);
		const r = await tools["verify_citations"].execute("t", { filePath: p, checkUrls: false }, undefined, undefined, {} as any);
		assert.match(r.content[0].text, /PASS/);
	});

	it("returns error when file is missing", async () => {
		const tools = loadTools();
		const r = await tools["verify_citations"].execute("t", { filePath: resolve(workdir, "nonexistent.md"), checkUrls: false }, undefined, undefined, {} as any);
		assert.match(r.content[0].text, /not found/i);
	});
});

// ── validate_output — workflow structure checks ──

describe("validate_output — structural", () => {
	it("detects deepresearch workflow and requires Summary + Sources", async () => {
		const tools = loadTools();
		const p = writeMd(`# Report

Some text. [1].

## Key Findings

Stuff.

## Sources

1. Stub at https://x.com
`);
		const r = await tools["validate_output"].execute("t", { filePath: p }, undefined, undefined, {} as any);
		assert.equal(r.details.wfType, "deepresearch");
		// Expected missing: "Summary", "Background", "Open Questions"
		const issues: string[] = r.details.issues;
		assert.ok(issues.some(s => /Summary/.test(s)), `expected missing Summary, got ${JSON.stringify(issues)}`);
	});

	it("auto-detects compare workflow from headings", async () => {
		const tools = loadTools();
		const p = writeMd(`# Compare

## Source Summaries
x

## Agreement
y

## Disagreement
z

## Synthesis
w

## Sources

1. s at https://x.com
`);
		const r = await tools["validate_output"].execute("t", { filePath: p }, undefined, undefined, {} as any);
		assert.equal(r.details.wfType, "compare");
	});
});
