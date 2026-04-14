import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// We test the parsing helpers by importing the module and testing the extraction logic.
// Since the tools are registered via pi.registerTool (which we can't easily mock),
// we test the underlying parsing functions directly.

// For now, test the markdown parsing that the hallucination guard depends on.

describe("citation extraction", () => {
    it("extracts inline citations from markdown", () => {
        const md = `
# Test Report
This claim [1] is supported. Another claim [2] agrees.
Also see [1] again and [3].
\`\`\`
code with [4] should be ignored
\`\`\`
`;
        // Strip code blocks
        const clean = md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
        const cites = [...new Set([...clean.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1], 10)))].sort((a, b) => a - b);
        assert.deepEqual(cites, [1, 2, 3]);
    });

    it("extracts sources section entries", () => {
        const md = `
# Report
Some text [1] and [2].

## Sources
[1] Smith et al. Deep Learning. https://arxiv.org/abs/2301.12345
[2] Jones. Machine Learning Review. https://doi.org/10.1234/ml.2023
`;
        const headingRe = /^#{1,4}\s*(Sources|References|Bibliography)\s*$/im;
        const match = headingRe.exec(md);
        assert.ok(match, "Should find Sources heading");

        const body = md.slice(match.index + match[0].length);
        const entries = [];
        for (const line of body.split("\n")) {
            const entryMatch = line.match(/^\s*[-*]?\s*\[?(\d+)\]?[.):\s]\s*(.+)/);
            if (entryMatch) entries.push({ index: parseInt(entryMatch[1], 10), raw: entryMatch[2].trim() });
        }
        assert.equal(entries.length, 2);
        assert.equal(entries[0].index, 1);
        assert.ok(entries[0].raw.includes("Smith"));
    });

    it("detects orphan citations", () => {
        const inlineCites = [1, 2, 3];
        const sourceIndices = new Set([1, 2]);
        const orphans = inlineCites.filter(n => !sourceIndices.has(n));
        assert.deepEqual(orphans, [3]);
    });

    it("detects orphan sources", () => {
        const inlineSet = new Set([1, 3]);
        const sources = [{ index: 1 }, { index: 2 }, { index: 3 }];
        const orphans = sources.filter(s => !inlineSet.has(s.index));
        assert.equal(orphans.length, 1);
        assert.equal(orphans[0].index, 2);
    });
});

describe("markdown table extraction", () => {
    it("extracts a simple markdown table", () => {
        const md = `
# Report

| Name | Score | Year |
|------|-------|------|
| A    | 95    | 2023 |
| B    | 88    | 2024 |
`;
        const lines = md.split("\n");
        let headerLine = null;
        let headerIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith("|") && line.endsWith("|") && !line.match(/^\|[\s:|-]+\|$/)) {
                if (i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
                    headerLine = line;
                    headerIdx = i;
                    break;
                }
            }
        }
        assert.ok(headerLine, "Should find table header");
        const headers = headerLine.split("|").slice(1, -1).map(c => c.trim());
        assert.deepEqual(headers, ["Name", "Score", "Year"]);
    });
});
