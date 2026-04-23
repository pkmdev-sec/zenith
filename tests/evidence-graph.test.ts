import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
	appendEvidence,
	disputedClaimIds,
	readEvidenceGraph,
	registerEvidenceGraphTools,
} from "../extensions/research-tools/evidence-graph.js";

function makeMockPi() {
	const tools: Record<string, any> = {};
	const pi = {
		registerTool: (t: any) => { tools[t.name] = t; },
		registerCommand: () => {},
		on: () => {},
	} as any;
	registerEvidenceGraphTools(pi);
	return { tools };
}

let zhome: string;
let saved: { home?: string; zhome?: string };

beforeEach(() => {
	zhome = mkdtempSync(resolve(tmpdir(), "zenith-ev-"));
	saved = { home: process.env.HOME, zhome: process.env.ZENITH_HOME };
	process.env.ZENITH_HOME = zhome;
	process.env.HOME = zhome;
});

afterEach(() => {
	if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
	if (saved.zhome === undefined) delete process.env.ZENITH_HOME; else process.env.ZENITH_HOME = saved.zhome;
	rmSync(zhome, { recursive: true, force: true });
});

describe("evidence graph — direct API", () => {
	it("append assigns a stable id and round-trips", () => {
		const e = appendEvidence("q", {
			round: 1,
			persona: "p1",
			claim: "L2 outperforms L1 on CIFAR-10",
			sources: [{ url: "https://arxiv.org/abs/1234", quote: "L2 92.3% vs L1 91.1%" }],
			kind: "assertion",
		});
		assert.match(e.id, /^c_[0-9a-f]{8}$/);
		const graph = readEvidenceGraph("q");
		assert.equal(graph.length, 1);
		assert.equal(graph[0].id, e.id);
		assert.equal(graph[0].claim, "L2 outperforms L1 on CIFAR-10");
	});

	it("identical (persona, claim, round) produces the same id", () => {
		const a = appendEvidence("q", { round: 1, persona: "p1", claim: "X", sources: [{ url: "u" }], kind: "assertion" });
		const b = appendEvidence("q", { round: 1, persona: "p1", claim: "X", sources: [{ url: "u" }], kind: "assertion" });
		assert.equal(a.id, b.id);
	});

	it("different rounds produce different ids for the same claim", () => {
		const a = appendEvidence("q", { round: 1, persona: "p1", claim: "X", sources: [{ url: "u" }], kind: "assertion" });
		const b = appendEvidence("q", { round: 2, persona: "p1", claim: "X", sources: [{ url: "u" }], kind: "assertion" });
		assert.notEqual(a.id, b.id);
	});

	it("disputedClaimIds: both support + contradict on the same target", () => {
		const base = appendEvidence("q", {
			round: 1, persona: "p1", claim: "L2 > L1", sources: [{ url: "u" }], kind: "assertion",
		});
		appendEvidence("q", {
			round: 2, persona: "p2", claim: "agree", sources: [{ url: "u2" }], kind: "support", targetClaimId: base.id,
		});
		appendEvidence("q", {
			round: 2, persona: "p3", claim: "disagree", sources: [{ url: "u3" }], kind: "contradict", targetClaimId: base.id,
		});
		const disputed = disputedClaimIds("q");
		assert.deepEqual(disputed, [base.id]);
	});

	it("support alone is not disputed", () => {
		const base = appendEvidence("q", { round: 1, persona: "p1", claim: "C", sources: [{ url: "u" }], kind: "assertion" });
		appendEvidence("q", { round: 2, persona: "p2", claim: "s", sources: [{ url: "u" }], kind: "support", targetClaimId: base.id });
		assert.deepEqual(disputedClaimIds("q"), []);
	});
});

describe("evidence graph — tool", () => {
	it("append_evidence rejects entries with no sources", async () => {
		const { tools } = makeMockPi();
		const res = await tools.append_evidence.execute(
			"t",
			{ slug: "q", persona: "p1", round: 1, claim: "X", sources: [], kind: "assertion" },
			undefined, undefined, {} as any,
		);
		assert.match(res.content[0].text, /REJECTED/);
		assert.equal(res.details.ok, false);
		assert.equal(readEvidenceGraph("q").length, 0);
	});

	it("append_evidence rejects non-assertion without targetClaimId", async () => {
		const { tools } = makeMockPi();
		const res = await tools.append_evidence.execute(
			"t",
			{ slug: "q", persona: "p1", round: 2, claim: "agree", sources: [{ url: "u" }], kind: "support" },
			undefined, undefined, {} as any,
		);
		assert.match(res.content[0].text, /REJECTED/);
		assert.equal(readEvidenceGraph("q").length, 0);
	});

	it("query_evidence_graph filters by persona and kind", async () => {
		const { tools } = makeMockPi();
		appendEvidence("q", { round: 1, persona: "p1", claim: "A", sources: [{ url: "u" }], kind: "assertion" });
		appendEvidence("q", { round: 1, persona: "p2", claim: "B", sources: [{ url: "u" }], kind: "assertion" });
		const res = await tools.query_evidence_graph.execute(
			"t",
			{ slug: "q", persona: "p1" },
			undefined, undefined, {} as any,
		);
		assert.equal(res.details.entries.length, 1);
		assert.equal(res.details.entries[0].persona, "p1");
	});

	it("query_evidence_graph notPersona shows peers only (round 2 use case)", async () => {
		const { tools } = makeMockPi();
		appendEvidence("q", { round: 1, persona: "me", claim: "A", sources: [{ url: "u" }], kind: "assertion" });
		appendEvidence("q", { round: 1, persona: "peer1", claim: "B", sources: [{ url: "u" }], kind: "assertion" });
		appendEvidence("q", { round: 1, persona: "peer2", claim: "C", sources: [{ url: "u" }], kind: "assertion" });
		const res = await tools.query_evidence_graph.execute(
			"t",
			{ slug: "q", notPersona: "me", round: 1 },
			undefined, undefined, {} as any,
		);
		assert.equal(res.details.entries.length, 2);
		assert.ok(res.details.entries.every((e: any) => e.persona !== "me"));
	});

	it("query_evidence_graph disputedOnly returns only 2-sided claims", async () => {
		const { tools } = makeMockPi();
		const a = appendEvidence("q", { round: 1, persona: "p1", claim: "A", sources: [{ url: "u" }], kind: "assertion" });
		const b = appendEvidence("q", { round: 1, persona: "p2", claim: "B", sources: [{ url: "u" }], kind: "assertion" });
		appendEvidence("q", { round: 2, persona: "p3", claim: "s", sources: [{ url: "u" }], kind: "support", targetClaimId: a.id });
		appendEvidence("q", { round: 2, persona: "p4", claim: "c", sources: [{ url: "u" }], kind: "contradict", targetClaimId: a.id });
		appendEvidence("q", { round: 2, persona: "p5", claim: "s2", sources: [{ url: "u" }], kind: "support", targetClaimId: b.id });
		const res = await tools.query_evidence_graph.execute(
			"t",
			{ slug: "q", disputedOnly: true },
			undefined, undefined, {} as any,
		);
		// All entries returned must be on claim A (the disputed one)
		for (const e of res.details.entries) {
			const targetOrSelf = e.targetClaimId ?? e.id;
			assert.equal(targetOrSelf, a.id);
		}
		assert.deepEqual(res.details.disputed, [a.id]);
	});
});
