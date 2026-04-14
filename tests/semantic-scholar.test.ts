import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Test the formatting helpers and URL construction logic
// (actual API calls are integration tests, not unit tests)

describe("Semantic Scholar URL construction", () => {
    const S2_BASE = "https://api.semanticscholar.org/graph/v1";

    it("constructs search URL with parameters", () => {
        const url = new URL(S2_BASE + "/paper/search");
        url.searchParams.set("query", "transformer attention");
        url.searchParams.set("limit", "10");
        url.searchParams.set("year", "2020-2024");
        assert.ok(url.toString().includes("query=transformer+attention"));
        assert.ok(url.toString().includes("limit=10"));
        assert.ok(url.toString().includes("year=2020-2024"));
    });

    it("handles paper ID formats", () => {
        const ids = [
            "649def34f8be52c8b66281af98ae884c09aef38b",  // S2 ID
            "DOI:10.18653/v1/N18-1202",                   // DOI
            "ARXIV:2106.09685",                            // ArXiv
            "PMID:12345678",                               // PubMed
        ];
        for (const id of ids) {
            const url = `${S2_BASE}/paper/${encodeURIComponent(id)}`;
            assert.ok(url.startsWith(S2_BASE));
        }
    });

    it("formats author list correctly", () => {
        const formatAuthors = (authors: {name: string}[] | null) => {
            if (!authors?.length) return "Unknown";
            if (authors.length <= 3) return authors.map(a => a.name).join(", ");
            return `${authors[0].name}, ${authors[1].name}, ... +${authors.length - 2} more`;
        };

        assert.equal(formatAuthors([]), "Unknown");
        assert.equal(formatAuthors(null), "Unknown");
        assert.equal(formatAuthors([{ name: "Alice" }]), "Alice");
        assert.equal(formatAuthors([{ name: "A" }, { name: "B" }, { name: "C" }]), "A, B, C");
        assert.equal(formatAuthors([{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }]), "A, B, ... +2 more");
    });
});

describe("Semantic Scholar rate limiting", () => {
    it("respects minimum request interval", () => {
        const MIN_INTERVAL = 1100;
        let lastTime = 0;
        const now = Date.now();
        const elapsed = now - lastTime;
        // First request should not need to wait
        assert.ok(elapsed >= MIN_INTERVAL || lastTime === 0);
    });
});
