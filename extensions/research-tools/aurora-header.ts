/**
 * aurora-header.ts — live ASCII aurora for the Zenith home screen.
 *
 * Inspiration: live-ascii (github.com/Arcelyth/live-ascii) renders a live
 * rig at terminal-cell resolution. We borrow the *idea* — a live, meaningful
 * ASCII element driven by real signal — not the implementation.
 *
 * What it is:
 *   - A horizontal aurora band rendered as a 2-D grid of Unicode gradient
 *     characters colored along Zenith's cold sky-blue palette.
 *   - Six "phase beacons" floating along the aurora's baseline, one per
 *     pipeline phase (scout, research, debate, verify, build, deliver).
 *   - A status ribbon below showing the current swarm (if any) and its
 *     live progress, read from ~/.zenith/swarm-work/<slug>/events.jsonl.
 *
 * Why it's on-brand:
 *   - "Zenith" = the highest point in the sky; the aurora is a cold-blue
 *     high-altitude phenomenon. The animation literally depicts the brand.
 *   - The beacons map to the 6-phase pipeline the README advertises.
 *   - When a real swarm is running, the active phase's beacon pulses.
 *     The home screen becomes a live dashboard, not wallpaper.
 *
 * Technique:
 *   - Aurora brightness is the sum of two phase-shifted sine waves plus a
 *     smooth deterministic noise field. At 5 FPS, both the CPU cost and
 *     visual motion are gentle enough for a CLI.
 *   - Rendering uses raw 24-bit ANSI RGB escapes — matching src/ui/terminal.ts
 *     exactly — so color fidelity doesn't depend on which palette tokens the
 *     pi-coding-agent theme happens to expose.
 *   - setInterval + ctx.invalidate() drive the redraw loop. dispose() in the
 *     Component cleans up the timer when the header is replaced.
 *
 * Fallback:
 *   - If !process.stdout.isTTY, or width < MIN_WIDTH, render falls through
 *     to the static header (no animation, no timer, no color shift).
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── Palette (sky-blue, matches src/ui/terminal.ts) ─────────────

const AURORA_COLD: [number, number, number] = [60, 110, 200];   // deep base
const AURORA_MID: [number, number, number] = [70, 150, 230];    // teal
const AURORA_HOT: [number, number, number] = [130, 200, 255];   // accent
const AURORA_CREST: [number, number, number] = [210, 235, 255]; // near-white peak

const ASH: [number, number, number] = [140, 160, 185];
const DIM: [number, number, number] = [95, 115, 150];
const STAR: [number, number, number] = [200, 220, 245];

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function rgb([r, g, b]: [number, number, number], text: string): string {
	return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * Math.max(0, Math.min(1, t));
}

function lerpRGB(
	a: [number, number, number],
	b: [number, number, number],
	t: number,
): [number, number, number] {
	return [
		Math.round(lerp(a[0], b[0], t)),
		Math.round(lerp(a[1], b[1], t)),
		Math.round(lerp(a[2], b[2], t)),
	];
}

// ── Brightness → gradient char ────────────────────────────────

// Half-block + shade glyphs. Low end leaves the row dark; high end crests
// into the accent color at cell resolution.
const GRADIENT_CHARS = [" ", " ", "·", "·", "˙", "·", ":", ".", "⋅", "∴", "∵", "∷", "‥", "…", "⁖", "⁘", "⁙"];

function gradientChar(brightness: number): string {
	const idx = Math.max(0, Math.min(GRADIENT_CHARS.length - 1, Math.floor(brightness * GRADIENT_CHARS.length)));
	return GRADIENT_CHARS[idx]!;
}

// ── Deterministic smooth noise (no randomness — stable across frames) ──
// A hash-based pseudo-noise we can sample at continuous (x, t) coordinates.
// Cheap enough to run across ~2000 cells per frame without measurable cost.

function hash(x: number, y: number): number {
	// 2D integer hash, deterministic, uniform in [0, 1).
	let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	h ^= h >>> 16;
	return ((h >>> 0) % 1000000) / 1000000;
}

function smoothNoise(x: number, t: number): number {
	// Sample hash at integer grid, bilinear-interpolate along x, time-blend with t.
	const x0 = Math.floor(x);
	const x1 = x0 + 1;
	const fx = x - x0;
	const tLow = Math.floor(t);
	const tHigh = tLow + 1;
	const ft = t - tLow;
	const nxLow = lerp(hash(x0, tLow), hash(x1, tLow), fx);
	const nxHigh = lerp(hash(x0, tHigh), hash(x1, tHigh), fx);
	return lerp(nxLow, nxHigh, ft);
}

// ── Aurora field ──────────────────────────────────────────────
// For each (col, row) cell, compute a brightness [0, 1]. The aurora is
// stratified: stronger in the middle rows, dimming toward the top/bottom.

interface AuroraParams {
	cols: number;
	rows: number;
	t: number; // seconds
}

function auroraBrightness(x: number, y: number, p: AuroraParams): number {
	const { cols, rows, t } = p;
	// Horizontal position in normalized [0, 1]
	const nx = x / Math.max(1, cols - 1);
	// Vertical falloff: peak at mid-upper rows (y ~ rows * 0.35).
	const yBand = 0.35;
	const yDist = Math.abs(y / Math.max(1, rows - 1) - yBand);
	const yFalloff = Math.max(0, 1 - yDist * 2.2);
	// Two phase-shifted long waves sweep horizontally at slow speed.
	const wave1 = 0.5 + 0.5 * Math.sin(nx * Math.PI * 2 + t * 0.55);
	const wave2 = 0.5 + 0.5 * Math.sin(nx * Math.PI * 3.3 - t * 0.31 + 1.7);
	// Smooth noise breaks up the waves so it doesn't look like a fake curve.
	const noise = smoothNoise(nx * 7 + t * 0.2, t * 0.18);
	// Combine: waves dominate, noise adds jitter, yFalloff shapes the band.
	const combined = (wave1 * 0.5 + wave2 * 0.4 + noise * 0.35) * yFalloff;
	return Math.max(0, Math.min(1, combined));
}

function brightnessToRGB(b: number): [number, number, number] {
	// Ramp: COLD → MID → HOT → CREST
	if (b < 0.33) return lerpRGB(AURORA_COLD, AURORA_MID, b / 0.33);
	if (b < 0.7) return lerpRGB(AURORA_MID, AURORA_HOT, (b - 0.33) / 0.37);
	return lerpRGB(AURORA_HOT, AURORA_CREST, (b - 0.7) / 0.3);
}

// ── Phase beacons ─────────────────────────────────────────────

export const PHASES = ["scout", "research", "debate", "verify", "build", "deliver"] as const;
export type Phase = (typeof PHASES)[number];

interface BeaconState {
	phase: Phase;
	active: boolean;   // currently-running phase in some swarm
	visited: boolean;  // phase already transitioned past
	pulse: number;     // 0..1 rolling pulse for active beacon
}

// ── Swarm discovery (non-blocking, cheap) ─────────────────────

function getSwarmWorkRoot(): string {
	const home = process.env.ZENITH_HOME ?? resolve(process.env.HOME ?? homedir(), ".zenith");
	return resolve(home, "swarm-work");
}

interface SwarmSnapshot {
	slug: string;
	currentPhase: Phase | null;
	visited: Set<Phase>;
	agentsSpawned: number;
	agentsComplete: number;
	agentsTotal: number;
	ageMs: number;
}

function readLastEvents(path: string, tailBytes = 32_768): any[] {
	if (!existsSync(path)) return [];
	const stat = statSync(path);
	const start = Math.max(0, stat.size - tailBytes);
	const buf = Buffer.alloc(stat.size - start);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buf, 0, buf.length, start);
	} finally {
		closeSync(fd);
	}
	const text = buf.toString("utf8");
	const events: any[] = [];
	// Drop the possibly-partial first line (we started mid-file).
	const lines = text.split("\n");
	const firstFull = start === 0 ? 0 : 1;
	for (let i = firstFull; i < lines.length; i++) {
		const t = lines[i].trim();
		if (!t) continue;
		try {
			events.push(JSON.parse(t));
		} catch {
			/* ignore */
		}
	}
	return events;
}

function snapshotActiveSwarm(): SwarmSnapshot | null {
	const root = getSwarmWorkRoot();
	if (!existsSync(root)) return null;
	let best: { slug: string; mtime: number } | null = null;
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const eventsPath = resolve(root, entry.name, "events.jsonl");
			if (!existsSync(eventsPath)) continue;
			const m = statSync(eventsPath).mtimeMs;
			if (!best || m > best.mtime) best = { slug: entry.name, mtime: m };
		}
	} catch {
		return null;
	}
	if (!best) return null;
	// Only consider "active" if the log was touched recently (< 10 min).
	const ageMs = Date.now() - best.mtime;
	if (ageMs > 10 * 60 * 1000) return null;

	const events = readLastEvents(resolve(root, best.slug, "events.jsonl"));
	const visited = new Set<Phase>();
	let currentPhase: Phase | null = null;
	let agentsSpawned = 0, agentsComplete = 0, agentsTotal = 0;
	for (const ev of events) {
		if (ev.type === "phase_transition" || ev.type === "phase_start") {
			const p = ev.phase as string;
			if (PHASES.includes(p as Phase)) currentPhase = p as Phase;
		}
		if (ev.type === "agent_spawn") agentsSpawned++;
		if (ev.type === "agent_complete" || ev.type === "agent_failed") agentsComplete++;
		if (ev.type === "swarm_init" && typeof ev.totalAgents === "number") agentsTotal = ev.totalAgents;
	}
	if (currentPhase) {
		// Every phase strictly before currentPhase is "visited"
		const idx = PHASES.indexOf(currentPhase);
		for (let i = 0; i < idx; i++) visited.add(PHASES[i]!);
	}
	return { slug: best.slug, currentPhase, visited, agentsSpawned, agentsComplete, agentsTotal, ageMs };
}

// ── Render ────────────────────────────────────────────────────

export const AURORA_ROWS = 5; // height in terminal rows

interface RenderParams {
	width: number;
	t: number;
	snapshot: SwarmSnapshot | null;
}

export function renderAurora(params: RenderParams): string[] {
	const { width, t, snapshot } = params;
	const cols = Math.max(20, width);
	const rows = AURORA_ROWS;

	// Build the aurora grid
	const lines: string[] = [];
	for (let y = 0; y < rows; y++) {
		let line = "";
		for (let x = 0; x < cols; x++) {
			const b = auroraBrightness(x, y, { cols, rows, t });
			if (b < 0.05) {
				line += " ";
				continue;
			}
			const ch = gradientChar(b);
			const color = brightnessToRGB(b);
			line += rgb(color, ch);
		}
		lines.push(line);
	}

	// Occasional stars on the top row (deterministic per position + slow time window)
	const starLine0 = lines[0];
	const starChars = starLine0.split("");
	// (Splitting an ANSI-colored string is ugly; simpler to overlay by rebuilding row 0 raw.)
	// We rebuild row 0 with occasional sparkles:
	let row0 = "";
	const timeWindow = Math.floor(t / 2.0); // stars shift every 2s
	for (let x = 0; x < cols; x++) {
		const h = hash(x * 17 + timeWindow * 101, timeWindow);
		const b = auroraBrightness(x, 0, { cols, rows, t });
		if (h > 0.985 && b < 0.3) {
			row0 += rgb(STAR, "˙");
		} else if (b < 0.05) {
			row0 += " ";
		} else {
			row0 += rgb(brightnessToRGB(b), gradientChar(b));
		}
	}
	lines[0] = row0;

	// Phase beacons row
	const beacons: BeaconState[] = PHASES.map((phase) => ({
		phase,
		active: snapshot?.currentPhase === phase,
		visited: snapshot?.visited.has(phase) ?? false,
		pulse: 0,
	}));
	const beaconRow = renderBeacons(beacons, cols, t);
	lines.push(beaconRow);

	// Status ribbon
	const ribbon = renderRibbon(snapshot, cols, t);
	lines.push(ribbon);

	return lines;
}

function renderBeacons(beacons: BeaconState[], cols: number, t: number): string {
	// Evenly spaced beacons across the horizontal. Each beacon occupies a small
	// slot containing a glyph and a short label.
	const slotW = Math.floor(cols / beacons.length);
	let row = "";
	for (let i = 0; i < beacons.length; i++) {
		const b = beacons[i]!;
		const slotStart = i * slotW;
		const slotEnd = i === beacons.length - 1 ? cols : (i + 1) * slotW;
		const slotWidth = slotEnd - slotStart;
		const label = b.phase;
		// Beacon glyph: pulsing diamond when active, filled dot when visited, hollow dot otherwise.
		let glyph: string;
		let labelColor: [number, number, number];
		if (b.active) {
			// Pulse 0..1 over ~1.5s
			const pulse = 0.5 + 0.5 * Math.sin(t * 4.2);
			const glyphColor = lerpRGB(AURORA_HOT, AURORA_CREST, pulse);
			const glyphs = ["◆", "◆", "◇", "◇"];
			const idx = Math.floor((t * 3) % glyphs.length);
			glyph = rgb(glyphColor, BOLD + glyphs[idx]!);
			labelColor = lerpRGB(AURORA_MID, AURORA_CREST, pulse);
		} else if (b.visited) {
			glyph = rgb(AURORA_MID, "●");
			labelColor = ASH;
		} else {
			glyph = rgb(DIM, "○");
			labelColor = DIM;
		}
		const entry = `${glyph} ${rgb(labelColor, label)}`;
		const visibleLen = 1 + 1 + label.length; // glyph(1) + space(1) + label.length
		const padLen = Math.max(0, slotWidth - visibleLen);
		const padLeft = Math.floor(padLen / 2);
		const padRight = padLen - padLeft;
		row += " ".repeat(padLeft) + entry + " ".repeat(padRight);
	}
	return row;
}

function renderRibbon(snapshot: SwarmSnapshot | null, cols: number, _t: number): string {
	if (!snapshot) {
		const msg = "idle · ask a question to start the swarm";
		const padded = " ".repeat(Math.max(0, Math.floor((cols - msg.length) / 2))) + msg;
		return rgb(DIM, padded);
	}
	const { slug, currentPhase, agentsSpawned, agentsComplete, agentsTotal } = snapshot;
	const progress =
		agentsTotal > 0
			? `${agentsComplete}/${agentsSpawned} agents · ${agentsTotal} planned`
			: `${agentsComplete}/${agentsSpawned} agents`;
	const phase = currentPhase ? `${currentPhase}` : "pending";
	const msg = `▸ ${slug} · ${phase} · ${progress}`;
	const padded = " ".repeat(Math.max(0, Math.floor((cols - msg.length) / 2))) + msg;
	return rgb(AURORA_HOT, padded);
}

// ── Status accessor (exported so header.ts can decide fallback) ──

export function getActiveSwarmSnapshot(): SwarmSnapshot | null {
	try {
		return snapshotActiveSwarm();
	} catch {
		return null;
	}
}

export const AURORA_MIN_WIDTH = 60;

export function auroraEnabled(): boolean {
	if (process.env.ZENITH_AURORA === "0") return false;
	if (process.env.ZENITH_AURORA === "off") return false;
	if (!process.stdout.isTTY) return false;
	// TERM=dumb or missing color support → fallback
	const term = process.env.TERM ?? "";
	if (term === "dumb") return false;
	return true;
}
