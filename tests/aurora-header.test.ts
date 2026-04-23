import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
	AURORA_MIN_WIDTH,
	AURORA_ROWS,
	auroraEnabled,
	getActiveSwarmSnapshot,
	PHASES,
	renderAurora,
} from "../extensions/research-tools/aurora-header.js";

// ── Strip ANSI for plain-text assertions ──
function strip(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Test isolation ──
let zhome: string;
let saved: { home?: string; zhome?: string; aurora?: string; term?: string };
beforeEach(() => {
	zhome = mkdtempSync(resolve(tmpdir(), "zenith-aurora-"));
	saved = {
		home: process.env.HOME,
		zhome: process.env.ZENITH_HOME,
		aurora: process.env.ZENITH_AURORA,
		term: process.env.TERM,
	};
	process.env.ZENITH_HOME = zhome;
	process.env.HOME = zhome;
	delete process.env.ZENITH_AURORA;
});
afterEach(() => {
	const rev = (envKey: string, val: string | undefined) => {
		if (val === undefined) delete process.env[envKey]; else process.env[envKey] = val;
	};
	rev("HOME", saved.home);
	rev("ZENITH_HOME", saved.zhome);
	rev("ZENITH_AURORA", saved.aurora);
	rev("TERM", saved.term);
	rmSync(zhome, { recursive: true, force: true });
});

describe("auroraEnabled", () => {
	it("returns false when ZENITH_AURORA=0", () => {
		const prev = process.stdout.isTTY;
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		process.env.ZENITH_AURORA = "0";
		assert.equal(auroraEnabled(), false);
		Object.defineProperty(process.stdout, "isTTY", { value: prev, configurable: true });
	});
	it("returns false when stdout is not a TTY", () => {
		const prev = process.stdout.isTTY;
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
		assert.equal(auroraEnabled(), false);
		Object.defineProperty(process.stdout, "isTTY", { value: prev, configurable: true });
	});
	it("returns false when TERM=dumb", () => {
		const prev = process.stdout.isTTY;
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		process.env.TERM = "dumb";
		assert.equal(auroraEnabled(), false);
		Object.defineProperty(process.stdout, "isTTY", { value: prev, configurable: true });
	});
});

describe("renderAurora", () => {
	it("emits AURORA_ROWS aurora lines + beacon row + ribbon row", () => {
		const lines = renderAurora({ width: 80, t: 0, snapshot: null });
		// aurora rows + beacons row + ribbon row
		assert.equal(lines.length, AURORA_ROWS + 2);
	});

	it("beacon row contains every phase label", () => {
		const lines = renderAurora({ width: 120, t: 0, snapshot: null });
		const beaconLine = strip(lines[AURORA_ROWS]);
		for (const p of PHASES) {
			assert.ok(beaconLine.includes(p), `beacon row should include '${p}': ${beaconLine}`);
		}
	});

	it("idle ribbon tells the user to ask a question", () => {
		const lines = renderAurora({ width: 80, t: 0, snapshot: null });
		const ribbon = strip(lines[lines.length - 1]);
		assert.match(ribbon, /ask a question/i);
	});

	it("active ribbon shows the slug + current phase", () => {
		const snap = {
			slug: "my-run", currentPhase: "research" as const, visited: new Set<any>(["scout"]),
			agentsSpawned: 10, agentsComplete: 3, agentsTotal: 100, ageMs: 1000,
		};
		const lines = renderAurora({ width: 100, t: 0, snapshot: snap });
		const ribbon = strip(lines[lines.length - 1]);
		assert.match(ribbon, /my-run/);
		assert.match(ribbon, /research/);
		assert.match(ribbon, /3\/10 agents/);
	});

	it("animation differs between frames", () => {
		const a = renderAurora({ width: 80, t: 0, snapshot: null });
		const b = renderAurora({ width: 80, t: 1.5, snapshot: null });
		// Compare total rendered bytes — aurora content should shift.
		assert.notEqual(a.join("\n"), b.join("\n"), "frames at t=0 and t=1.5 must differ");
	});

	it("narrow width still renders without crashing", () => {
		const lines = renderAurora({ width: 40, t: 0.5, snapshot: null });
		assert.equal(lines.length, AURORA_ROWS + 2);
	});
});

describe("getActiveSwarmSnapshot", () => {
	it("returns null when no swarm-work dir exists", () => {
		assert.equal(getActiveSwarmSnapshot(), null);
	});

	it("returns null when log is older than 10 minutes", async () => {
		const slug = "stale";
		const dir = resolve(zhome, "swarm-work", slug);
		mkdirSync(dir, { recursive: true });
		const events = resolve(dir, "events.jsonl");
		writeFileSync(events, JSON.stringify({ type: "swarm_init", totalAgents: 5, ts: new Date().toISOString() }) + "\n");
		// Backdate mtime
		const past = Date.now() - 15 * 60 * 1000;
		const { utimesSync } = await import("node:fs");
		utimesSync(events, past / 1000, past / 1000);
		assert.equal(getActiveSwarmSnapshot(), null);
	});

	it("reports current phase, agent count, and slug for recent swarm", () => {
		const slug = "recent";
		const dir = resolve(zhome, "swarm-work", slug);
		mkdirSync(dir, { recursive: true });
		const events = resolve(dir, "events.jsonl");
		const lines = [
			JSON.stringify({ type: "swarm_init", totalAgents: 120, ts: new Date().toISOString() }),
			JSON.stringify({ type: "phase_transition", phase: "scout", ts: new Date().toISOString() }),
			JSON.stringify({ type: "agent_spawn", id: "a1", phase: "scout", ts: new Date().toISOString() }),
			JSON.stringify({ type: "agent_complete", id: "a1", tokens: 100, phase: "scout", ts: new Date().toISOString() }),
			JSON.stringify({ type: "phase_transition", phase: "research", ts: new Date().toISOString() }),
			JSON.stringify({ type: "agent_spawn", id: "a2", phase: "research", ts: new Date().toISOString() }),
		];
		writeFileSync(events, lines.join("\n") + "\n");

		const snap = getActiveSwarmSnapshot();
		assert.ok(snap, "expected snapshot");
		assert.equal(snap!.slug, "recent");
		assert.equal(snap!.currentPhase, "research");
		assert.equal(snap!.agentsSpawned, 2);
		assert.equal(snap!.agentsComplete, 1);
		assert.equal(snap!.agentsTotal, 120);
		assert.ok(snap!.visited.has("scout"), "scout should be visited");
	});
});

describe("AURORA_MIN_WIDTH", () => {
	it("is a reasonable terminal width", () => {
		assert.ok(AURORA_MIN_WIDTH >= 40 && AURORA_MIN_WIDTH <= 120);
	});
});
