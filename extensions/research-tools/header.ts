import { readdir } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { execSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
	APP_ROOT,
	ZENITH_AGENT_LOGO,
	ZENITH_VERSION,
} from "./shared.js";
import {
	AURORA_MIN_WIDTH,
	AURORA_ROWS,
	auroraEnabled,
	getActiveSwarmSnapshot,
	renderAurora,
} from "./aurora-header.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLength(text: string): number {
	return text.replace(ANSI_RE, "").length;
}

function truncateVisible(text: string, maxVisible: number): string {
	const raw = text.replace(ANSI_RE, "");
	if (raw.length <= maxVisible) return text;
	if (maxVisible <= 3) return ".".repeat(maxVisible);
	return `${raw.slice(0, maxVisible - 3)}...`;
}

function wrapWords(text: string, maxW: number): string[] {
	const words = text.split(" ");
	const lines: string[] = [];
	let cur = "";
	for (let word of words) {
		if (word.length > maxW) {
			if (cur) { lines.push(cur); cur = ""; }
			word = maxW > 3 ? `${word.slice(0, maxW - 1)}…` : word.slice(0, maxW);
		}
		const test = cur ? `${cur} ${word}` : word;
		if (cur && test.length > maxW) {
			lines.push(cur);
			cur = word;
		} else {
			cur = test;
		}
	}
	if (cur) lines.push(cur);
	return lines.length ? lines : [""];
}

function padRight(text: string, width: number): string {
	const gap = Math.max(0, width - visibleLength(text));
	return `${text}${" ".repeat(gap)}`;
}

function centerText(text: string, width: number): string {
	if (text.length >= width) return text.slice(0, width);
	const left = Math.floor((width - text.length) / 2);
	const right = width - text.length - left;
	return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}

function extractMessageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			const record = item as { type?: string; text?: unknown; name?: unknown };
			if (record.type === "text" && typeof record.text === "string") return record.text;
			if (record.type === "toolCall") return `[${typeof record.name === "string" ? record.name : "tool"}]`;
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

function getRecentActivitySummary(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index]!;
		if (entry.type !== "message") continue;
		const msg = entry as any;
		const text = extractMessageText(msg.message).replace(/\s+/g, " ").trim();
		if (!text) continue;
		const role = msg.message.role === "assistant" ? "agent" : msg.message.role === "user" ? "you" : msg.message.role;
		return `${role}: ${text}`;
	}
	return "";
}

async function buildAgentCatalogSummary(): Promise<{ agents: string[]; chains: string[] }> {
	const agents: string[] = [];
	const chains: string[] = [];
	try {
		const entries = await readdir(resolvePath(APP_ROOT, ".zenith", "agents"), { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			if (entry.name.endsWith(".chain.md")) {
				chains.push(entry.name.replace(/\.chain\.md$/i, ""));
			} else {
				agents.push(entry.name.replace(/\.md$/i, ""));
			}
		}
	} catch {
		return { agents: [], chains: [] };
	}
	agents.sort();
	chains.sort();
	return { agents, chains };
}

type SystemResources = {
	cpu: string;
	cores: number;
	ramTotal: string;
	ramFree: string;
	gpu: string | null;
	docker: boolean;
};

let cachedResources: SystemResources | null = null;

function detectSystemResources(): SystemResources {
	if (cachedResources) return cachedResources;

	const cores = cpus().length;
	const totalBytes = totalmem();
	const ramTotal = `${Math.round(totalBytes / (1024 ** 3))}GB`;

	cachedResources = { cpu: "", cores, ramTotal, ramFree: "", gpu: null, docker: false };

	try {
		if (process.platform === "darwin") {
			const out = execSync("sysctl -n machdep.cpu.brand_string 2>/dev/null", { encoding: "utf8", timeout: 1000 }).trim();
			if (out) cachedResources.cpu = out;
		}
	} catch {}

	try {
		execSync("command -v docker >/dev/null 2>&1", { timeout: 500 });
		cachedResources.docker = true;
	} catch {}

	return cachedResources;
}

type WorkflowInfo = { name: string; description: string };

function getResearchWorkflows(pi: ExtensionAPI): WorkflowInfo[] {
	return pi.getCommands()
		.filter((cmd) => cmd.source === "prompt")
		.map((cmd) => ({ name: `/${cmd.name}`, description: cmd.description ?? "" }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function shortDescription(desc: string): string {
	const lower = desc.toLowerCase();
	for (const prefix of ["run a ", "run an ", "set up a ", "build a ", "build the ", "turn ", "design the ", "produce a ", "compare ", "simulate ", "inspect ", "write a ", "plan or execute a ", "prepare a "]) {
		if (lower.startsWith(prefix)) return desc.slice(prefix.length);
	}
	return desc;
}

export function installZenithHeader(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cache: { agentSummaryPromise?: Promise<{ agents: string[]; chains: string[] }> },
): void | Promise<void> {
	if (!ctx.hasUI) return;

	cache.agentSummaryPromise ??= buildAgentCatalogSummary();

	return cache.agentSummaryPromise.then((agentData) => {
		const agentCount = agentData.agents.length + agentData.chains.length;

		// Animation state shared between render() and the invalidation timer.
		// start = high-res epoch when the header first mounted; t = seconds since.
		const start = Date.now();
		let snapshotCache: ReturnType<typeof getActiveSwarmSnapshot> = null;
		let snapshotUpdatedAt = 0;
		let tickHandle: NodeJS.Timeout | null = null;

		// Capture the TUI handle the factory gives us so our tick timer can
		// request re-renders. Stored in a closure var.
		let tuiRef: any = null;
		let componentRef: { invalidate(): void } | null = null;

		ctx.ui.setHeader((tui, theme) => {
			tuiRef = tui;
			// Start the tick loop on first setHeader installation. pi-coding-agent
			// calls the factory once per session; we keep one timer for its lifetime
			// and clean up in dispose().
			if (tickHandle === null && auroraEnabled()) {
				tickHandle = setInterval(() => {
					// Invalidate the component (clears its own cache) and ask the
					// TUI to redraw. requestRender() is a no-op if no region needs
					// a repaint, so this is cheap when nothing changed.
					try {
						if (componentRef) componentRef.invalidate();
						if (tuiRef && typeof tuiRef.requestRender === "function") {
							tuiRef.requestRender();
						}
					} catch {
						/* tui may have gone away */
					}
				}, 200); // 5 FPS — gentle for a CLI
				// Don't hold the event loop open just for the animation.
				if (typeof tickHandle.unref === "function") tickHandle.unref();
			}

			const component = {
			render(width: number): string[] {
				const pad = "  ";
				const contentW = Math.max(width - 4, 20);
				const lines: string[] = [];

				const push = (line: string) => { lines.push(line); };
				const blank = () => { push(""); };

				// ── Live aurora (only if TTY + wide enough + not opted out) ──
				if (auroraEnabled() && width >= AURORA_MIN_WIDTH) {
					// Refresh swarm snapshot at most every 1s (cheap but not per-frame).
					const nowMs = Date.now();
					if (nowMs - snapshotUpdatedAt > 1000) {
						snapshotCache = getActiveSwarmSnapshot();
						snapshotUpdatedAt = nowMs;
					}
					const t = (nowMs - start) / 1000;
					const auroraLines = renderAurora({ width, t, snapshot: snapshotCache });
					for (const l of auroraLines) push(l);
					blank();
				}

				// ── Logo: left-aligned with 2-space indent ──
				blank();
				for (const logoLine of ZENITH_AGENT_LOGO) {
					push(`${pad}${theme.fg("accent", theme.bold(truncateVisible(logoLine, contentW)))}`);
				}

				// ── Version: right-aligned on its own line ──
				const versionText = `v${ZENITH_VERSION}`;
				const versionGap = Math.max(0, width - visibleLength(versionText));
				push(`${" ".repeat(versionGap)}${theme.fg("dim", versionText)}`);

				blank();
				// ── Section divider helper ──
				const divider = (label: string): string => {
					const labelRendered = theme.fg("accent", ` ${label} `);
					const labelVisible = visibleLength(labelRendered);
					const prefixDash = theme.fg("borderMuted", "──");
					const suffixLen = Math.max(0, contentW - 2 - labelVisible);
					const suffixDash = theme.fg("borderMuted", "─".repeat(suffixLen));
					return `${pad}${prefixDash}${labelRendered}${suffixDash}`;
				};

				// ── Swarm section ──
				push(divider("swarm"));
				blank();

				const swarmDesc = [
					"Every research question dispatches 100-500 agents as councils,",
					"challengers, and domain specialists. Multi-agent consensus",
					"eliminates hallucination.",
				];
				for (const descLine of swarmDesc) {
					push(`${pad}${theme.fg("dim", descLine)}`);
				}

				blank();

				const tierNameW = 21;
				const tierAgentW = 18;
				const tiers: [string, string, string][] = [
					["broad (default)", "100-200 agents", "thorough research"],
					["expensive", "300-500 agents", "interdisciplinary deep-dive"],
				];
				for (const [name, agents, desc] of tiers) {
					push(`${pad}${theme.fg("accent", name.padEnd(tierNameW))}${theme.fg("dim", agents.padEnd(tierAgentW))}${theme.fg("dim", desc)}`);
				}

				blank();

				// ── Agents section ──
				push(divider("agents"));
				blank();

				const coreNames = ["researcher", "writer", "reviewer", "verifier"];
				const swarmNames = ["synthesizer", "coordinator", "scout", "debate-agent"];
				const specialistCount = Math.max(0, agentCount - coreNames.length);

				const corePart = coreNames
					.map((n) => theme.fg("accent", n))
					.join(theme.fg("dim", " · "));
				const specialistPart = specialistCount > 0
					? `${theme.fg("dim", "  +")}${theme.fg("dim", `${specialistCount} specialists`)}`
					: "";
				push(`${pad}${corePart}${specialistPart}`);

				const swarmPart = swarmNames
					.map((n) => theme.fg("accent", n))
					.join(theme.fg("dim", " · "));
				push(`${pad}${swarmPart}`);

				blank();

				// ── Quick start section ──
				push(divider("quick start"));
				blank();

				push(`${pad}${theme.fg("dim", "Just ask a question. The swarm handles the rest.")}`);
				push(`${pad}${theme.fg("dim", "Use ")}${theme.fg("accent", "--direct")}${theme.fg("dim", " for single-agent answers.")}`);

				blank();

				return lines;
			},
			invalidate() {
				// Captured so the tick timer can request re-renders without
				// knowing about the Component instance.
				// (pi-coding-agent's TUI calls invalidate() itself too; this
				// wiring just gives the timer a handle.)
			},
			dispose() {
				if (tickHandle) {
					clearInterval(tickHandle);
					tickHandle = null;
				}
				tuiRef = null;
				componentRef = null;
			},
			};
			componentRef = component;
			return component;
		});
	});
}
