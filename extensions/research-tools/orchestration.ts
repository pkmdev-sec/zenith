/**
 * orchestration.ts — Deterministic Swarm orchestration engine (MiroFish-inspired).
 *
 * Three tools:
 *   classify_intent  — Heuristic intent classifier for routing queries
 *   swarm_status     — Read append-only event log and return structured status
 *   run_swarm        — Prepare swarm directory infrastructure, event logging, budget tracking
 *
 * This is the core deterministic layer. It does NOT dispatch agents itself — the
 * calling prompt invokes `subagent` for actual agent execution. This module handles:
 * directory scaffolding, event log management, budget enforcement, and status queries.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── Types ──────────────────────────────────────────────

interface IntentClassification {
	isResearch: boolean;
	taskType: string | null;
	domains: string[];
	explicitWorkflow: string | null;
	confidence: number;
}

interface SwarmEvent {
	ts: string;
	type: string;
	[key: string]: unknown;
}

interface SwarmStatus {
	slug: string;
	phase: string;
	agentsTotal: number;
	agentsComplete: number;
	agentsFailed: number;
	tokensUsed: number;
	budgetPct: number;
	elapsedMs: number;
	events: SwarmEvent[];
}

interface BudgetLimits {
	maxTokens: number;
	maxAgents: number;
	maxWallClockMs: number;
}

interface SwarmPhase {
	name: string;
	agents: string[];
}

interface SwarmPlan {
	slug: string;
	query: string;
	phases: SwarmPhase[];
	budget?: "broad" | "expensive" | BudgetLimits;
}

interface BudgetTracker {
	limits: BudgetLimits;
	tokensUsed: number;
	agentsSpawned: number;
	startedAt: string;
	remainingTokens: number;
	remainingAgents: number;
	budgetPct: number;
}

// ── Constants ──────────────────────────────────────────

const DEFAULT_BROAD_BUDGET: BudgetLimits = { maxTokens: 500_000, maxAgents: 200, maxWallClockMs: 0 };
const DEFAULT_EXPENSIVE_BUDGET: BudgetLimits = { maxTokens: 1_500_000, maxAgents: 500, maxWallClockMs: 0 };

const SWARM_SUBDIRS = ["scout", "research", "debate", "verify", "build"] as const;

const QUESTION_WORDS = new Set(["what", "when", "who", "where", "how", "which", "whose", "whom"]);

/**
 * Domain keyword mapping. Each key is a keyword (or short phrase) that can appear
 * in a query; the value is the specialist agent name it routes to.
 * Scanned case-insensitively against the raw query text.
 */
const DOMAIN_KEYWORDS: Record<string, string> = {
	// AI / ML
	"neural network":       "transformer-specialist",
	"transformer":          "transformer-specialist",
	"attention mechanism":  "transformer-specialist",
	"large language model": "llm-specialist",
	"llm":                  "llm-specialist",
	"gpt":                  "llm-specialist",
	"diffusion model":      "generative-specialist",
	"generative ai":        "generative-specialist",
	"reinforcement learning": "rl-specialist",
	"machine learning":     "ml-specialist",
	"deep learning":        "ml-specialist",
	"computer vision":      "cv-specialist",
	"image recognition":    "cv-specialist",
	"object detection":     "cv-specialist",
	"natural language":     "nlp-specialist",
	"nlp":                  "nlp-specialist",
	"speech recognition":   "speech-specialist",
	"robotics":             "robotics-specialist",

	// Sciences
	"climate":              "climate-science-specialist",
	"global warming":       "climate-science-specialist",
	"gene":                 "genomics-specialist",
	"genome":               "genomics-specialist",
	"crispr":               "genomics-specialist",
	"protein folding":      "protein-specialist",
	"protein structure":    "protein-specialist",
	"drug discovery":       "pharma-specialist",
	"pharmacology":         "pharma-specialist",
	"neuroscience":         "neuro-specialist",
	"brain":                "neuro-specialist",
	"quantum computing":    "quantum-specialist",
	"quantum":              "quantum-specialist",
	"astrophysics":         "astro-specialist",
	"cosmology":            "astro-specialist",
	"particle physics":     "particle-specialist",
	"materials science":    "materials-specialist",
	"battery":              "energy-specialist",
	"solar energy":         "energy-specialist",
	"fusion":               "energy-specialist",
	"ecology":              "ecology-specialist",
	"biodiversity":         "ecology-specialist",

	// Engineering / CS
	"cryptography":         "crypto-specialist",
	"blockchain":           "crypto-specialist",
	"distributed systems":  "distributed-specialist",
	"database":             "database-specialist",
	"compiler":             "compiler-specialist",
	"operating system":     "os-specialist",
	"cybersecurity":        "security-specialist",
	"network security":     "security-specialist",

	// Social sciences / Economics
	"economics":            "economics-specialist",
	"monetary policy":      "economics-specialist",
	"game theory":          "game-theory-specialist",
	"psychology":           "psychology-specialist",
	"cognitive science":    "cogsci-specialist",
	"sociology":            "sociology-specialist",
	"political science":    "polisci-specialist",

	// Math
	"topology":             "math-specialist",
	"algebra":              "math-specialist",
	"number theory":        "math-specialist",
	"statistics":           "statistics-specialist",
	"bayesian":             "statistics-specialist",
	"optimization":         "optimization-specialist",
} as const;

// ── Helpers ────────────────────────────────────────────

// Standardized resolver matching src/config/paths.ts::getSwarmWorkDir.
// Source of truth: $ZENITH_HOME if set, else $HOME/.zenith (or homedir()/.zenith).
// This helper is duplicated (rather than imported) because `extensions/` and
// `src/` are separate compilation units; keep this mirror in sync with paths.ts.
function getSwarmDir(_workingDir: string, slug: string): string {
	return resolve(getZenithHome(), "swarm-work", slug);
}

function getZenithHome(): string {
	if (process.env.ZENITH_HOME) return process.env.ZENITH_HOME;
	const home = process.env.HOME ?? homedir();
	return resolve(home, ".zenith");
}

function getEventsPath(swarmDir: string): string {
	return resolve(swarmDir, "events.jsonl");
}

/**
 * Append a single event to the JSONL log.
 * Each call is one `appendFileSync` of exactly one JSON line + newline,
 * making it safe for concurrent appends on the same file (POSIX guarantees
 * atomicity for writes under PIPE_BUF, ~4KB, and a single event line will
 * always be well under that).
 */
function appendEvent(eventsPath: string, event: SwarmEvent): void {
	const line = JSON.stringify(event) + "\n";
	appendFileSync(eventsPath, line, "utf-8");
}

function readEvents(eventsPath: string): SwarmEvent[] {
	if (!existsSync(eventsPath)) return [];
	const raw = readFileSync(eventsPath, "utf-8");
	const events: SwarmEvent[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			events.push(JSON.parse(trimmed) as SwarmEvent);
		} catch {
			// Skip malformed lines — log corruption should not crash status reads
		}
	}
	return events;
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

/**
 * Detect domains by scanning the query for keyword matches.
 * Returns deduplicated specialist names sorted by match position (earliest first),
 * capped at 10 results.
 */
function detectDomains(query: string): string[] {
	const lowerQuery = query.toLowerCase();
	const hits: Array<{ specialist: string; position: number }> = [];
	const seen = new Set<string>();

	for (const [keyword, specialist] of Object.entries(DOMAIN_KEYWORDS)) {
		const idx = lowerQuery.indexOf(keyword);
		if (idx !== -1 && !seen.has(specialist)) {
			seen.add(specialist);
			hits.push({ specialist, position: idx });
		}
	}

	hits.sort((a, b) => a.position - b.position);
	return hits.slice(0, 10).map((h) => h.specialist);
}

/**
 * Detect the task type from the query content.
 * Returns a human-readable task label or null if nothing specific was detected.
 */
function detectTaskType(query: string): string | null {
	const lower = query.toLowerCase();

	const taskPatterns: Array<[RegExp, string]> = [
		[/\b(?:compare|vs\.?|versus|comparison)\b/, "comparison"],
		[/\b(?:survey|overview|landscape|state of the art|sota)\b/, "survey"],
		[/\b(?:replicate|reproduce|replication)\b/, "replication"],
		[/\b(?:audit|assess|evaluate|evaluation)\b/, "audit"],
		[/\b(?:review|critique|critical analysis)\b/, "review"],
		[/\b(?:explain|how does|mechanism|why does)\b/, "explanation"],
		[/\b(?:predict|forecast|projection|trend)\b/, "forecasting"],
		[/\b(?:design|architect|blueprint|propose)\b/, "design"],
		[/\b(?:debug|troubleshoot|diagnose|fix)\b/, "debugging"],
		[/\b(?:synthesize|synthesis|integrate|meta-analysis)\b/, "synthesis"],
	];

	for (const [pattern, taskType] of taskPatterns) {
		if (pattern.test(lower)) return taskType;
	}

	return null;
}

/**
 * Heuristic confidence score.
 * Higher when: multiple domain matches, longer query, task type detected.
 * Lower when: short query, no domain matches, ambiguous phrasing.
 */
function computeConfidence(
	query: string,
	domains: string[],
	taskType: string | null,
	isResearch: boolean,
): number {
	if (!isResearch) {
		// Non-research classifications (slash commands, trivial lookups) are high confidence
		return 0.95;
	}

	let score = 0.5; // base: "we defaulted to research"

	// Domain matches boost confidence
	if (domains.length >= 3) score += 0.25;
	else if (domains.length >= 1) score += 0.15;

	// Task type detection boosts confidence
	if (taskType !== null) score += 0.1;

	// Longer queries tend to be more clearly research
	const wordCount = query.trim().split(/\s+/).length;
	if (wordCount >= 30) score += 0.1;
	else if (wordCount >= 15) score += 0.05;

	// Presence of academic/research signal words
	const researchSignals = /\b(?:paper|study|research|literature|evidence|hypothesis|methodology|findings|data|analysis|experiment)\b/i;
	if (researchSignals.test(query)) score += 0.1;

	return Math.min(score, 1.0);
}

function resolveBudget(budget?: "broad" | "expensive" | BudgetLimits): BudgetLimits {
	if (!budget || budget === "broad") return { ...DEFAULT_BROAD_BUDGET };
	if (budget === "expensive") return { ...DEFAULT_EXPENSIVE_BUDGET };
	return { ...budget };
}

function buildManifest(plan: SwarmPlan, limits: BudgetLimits): string {
	const lines: string[] = [
		`# Swarm Manifest: ${plan.slug}`,
		``,
		`**Query:** ${plan.query}`,
		`**Created:** ${new Date().toISOString()}`,
		`**Budget:** ${limits.maxTokens.toLocaleString()} tokens / ${limits.maxAgents} agents / ${limits.maxWallClockMs > 0 ? `${(limits.maxWallClockMs / 1000).toFixed(0)}s wall clock` : "no time limit"}`,
		``,
		`## Phases`,
		``,
	];

	for (const [i, phase] of plan.phases.entries()) {
		lines.push(`### ${i + 1}. ${phase.name}`);
		lines.push(``);
		for (const agent of phase.agents) {
			lines.push(`- [ ] ${agent}`);
		}
		lines.push(``);
	}

	const totalAgents = plan.phases.reduce((sum, p) => sum + p.agents.length, 0);
	lines.push(`---`);
	lines.push(`**Total agents:** ${totalAgents}`);
	lines.push(`**Total phases:** ${plan.phases.length}`);

	return lines.join("\n");
}

function buildBudgetTracker(limits: BudgetLimits, events: SwarmEvent[]): BudgetTracker {
	let tokensUsed = 0;
	let agentsSpawned = 0;
	let startedAt = new Date().toISOString();

	for (const event of events) {
		if (event.type === "swarm_init") {
			startedAt = event.ts;
		}
		if (typeof event.tokens === "number") {
			tokensUsed += event.tokens;
		}
		if (event.type === "agent_spawn") {
			agentsSpawned++;
		}
	}

	const budgetPct = limits.maxTokens > 0 ? (tokensUsed / limits.maxTokens) * 100 : 0;

	return {
		limits,
		tokensUsed,
		agentsSpawned,
		startedAt,
		remainingTokens: Math.max(0, limits.maxTokens - tokensUsed),
		remainingAgents: Math.max(0, limits.maxAgents - agentsSpawned),
		budgetPct: Math.round(budgetPct * 100) / 100,
	};
}

// ── Tool registration ──────────────────────────────────

export function registerOrchestrationTools(pi: ExtensionAPI): void {
	// ── Tool 1: classify_intent ────────────────────────

	pi.registerTool({
		name: "classify_intent",
		label: "Classify Intent",
		description:
			"Heuristic intent classifier for routing user queries. Returns structured classification " +
			"with research flag, task type, matched specialist domains, and confidence score. " +
			"Confidence below 0.7 means the caller should escalate to LLM Tier 2 for disambiguation.",

		parameters: Type.Object({
			query: Type.String({ description: "The user's raw query string to classify" }),
		}),
		async execute(_id, params) {
			const query = params.query.trim();

			// ── Rule 1: Explicit workflow via slash command ──
			if (query.startsWith("/")) {
				const match = query.match(/^\/(\S+)/);
				const workflow = match ? match[1] : null;
				const classification: IntentClassification = {
					isResearch: false,
					taskType: "workflow-invocation",
					domains: [],
					explicitWorkflow: workflow,
					confidence: 0.99,
				};
				return {
					content: [{
						type: "text",
						text: `Explicit workflow: /${workflow}. Routed directly — no swarm needed.`,
					}],
					details: classification,
				};
			}

			// ── Rule 2: Trivial lookup (short question about a single entity) ──
			const words = query.replace(/[?!.,;:]+/g, "").trim().split(/\s+/);
			const wordCount = words.length;
			const firstWordLower = words[0]?.toLowerCase() ?? "";

			// Research-style task hints mean even a short question is research, not trivial.
			const earlyTaskType = detectTaskType(query);
			const researchTaskTypes = new Set(["comparison", "survey", "replication", "audit", "review", "synthesis", "forecasting"]);
			const looksLikeResearchTask = earlyTaskType !== null && researchTaskTypes.has(earlyTaskType);

			if (!looksLikeResearchTask && wordCount < 15 && QUESTION_WORDS.has(firstWordLower)) {
				// Check if it's a simple factoid question (single entity, no complex qualifiers)
				// Heuristic: if the question has no conjunctions, comparatives, or multi-clause structure
				const complexityMarkers = /\b(?:and|or|but|versus|vs|compared|between|relationship|affect|influence|impact|implications|why.*(?:does|do|is|are)|how.*(?:does|do|affect|change))\b/i;
				if (!complexityMarkers.test(query)) {
					const domains = detectDomains(query);
					const classification: IntentClassification = {
						isResearch: false,
						taskType: "trivial-lookup",
						domains,
						explicitWorkflow: null,
						confidence: 0.85,
					};
					return {
						content: [{
							type: "text",
							text: `Trivial lookup detected (${wordCount} words, simple question). Direct answer recommended.`,
						}],
						details: classification,
					};
				}
			}

			// ── Rule 3: Default to research ──
			const domains = detectDomains(query);
			const taskType = detectTaskType(query);
			const confidence = computeConfidence(query, domains, taskType, true);

			const classification: IntentClassification = {
				isResearch: true,
				taskType,
				domains,
				explicitWorkflow: null,
				confidence,
			};

			const lines = [`Research intent detected (confidence: ${confidence.toFixed(2)})`];
			if (taskType) lines.push(`Task type: ${taskType}`);
			if (domains.length > 0) lines.push(`Matched domains: ${domains.join(", ")}`);
			if (confidence < 0.7) lines.push(`Low confidence — escalate to LLM Tier 2 for disambiguation.`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: classification,
			};
		},
	});

	// ── Tool 2: swarm_status ───────────────────────────

	pi.registerTool({
		name: "swarm_status",
		label: "Swarm Status",
		description:
			"Read the append-only event log for a swarm and return structured status including " +
			"phase, agent progress, token usage, budget percentage, and elapsed time.",

		parameters: Type.Object({
			slug: Type.String({ description: "Swarm slug (directory under ~/.zenith/swarm-work/)" }),
		}),
		async execute(_id, params) {
			const cwd = process.cwd();
			const swarmDir = getSwarmDir(cwd, params.slug);
			const eventsPath = getEventsPath(swarmDir);

			if (!existsSync(swarmDir)) {
				return {
					content: [{
						type: "text",
						text: `No swarm found for slug "${params.slug}". Directory does not exist: ${swarmDir}`,
					}], details: undefined,
				};
			}

			const events = readEvents(eventsPath);
			if (events.length === 0) {
				return {
					content: [{
						type: "text",
						text: `Swarm "${params.slug}" exists but has no events logged yet.`,
					}],
					details: {
						slug: params.slug,
						phase: "uninitialized",
						agentsTotal: 0,
						agentsComplete: 0,
						agentsFailed: 0,
						tokensUsed: 0,
						budgetPct: 0,
						elapsedMs: 0,
						events: [],
					} satisfies SwarmStatus,
				};
			}

			// Derive status from event stream
			let phase = "unknown";
			let agentsTotal = 0;
			let agentsSpawned = 0;
			let agentsComplete = 0;
			let agentsFailed = 0;
			let tokensUsed = 0;
			let startedAt: number | null = null;
			let budgetMaxTokens = DEFAULT_BROAD_BUDGET.maxTokens;

			for (const event of events) {
				switch (event.type) {
					case "swarm_init":
						startedAt = new Date(event.ts).getTime();
						if (typeof event.totalAgents === "number") agentsTotal = event.totalAgents;
						if (typeof event.maxTokens === "number") budgetMaxTokens = event.maxTokens;
						phase = "initialized";
						break;
					case "phase_start":
						if (typeof event.phase === "string") phase = event.phase;
						break;
					case "phase_complete":
						// Phase is still the last started one until a new one begins
						break;
					case "agent_spawn":
						agentsSpawned++;
						break;
					case "agent_complete":
						agentsComplete++;
						if (typeof event.tokens === "number") tokensUsed += event.tokens;
						break;
					case "agent_failed":
						agentsFailed++;
						if (typeof event.tokens === "number") tokensUsed += event.tokens;
						break;
					case "swarm_complete":
						phase = "complete";
						break;
					case "swarm_failed":
						phase = "failed";
						break;
					case "budget_exceeded":
						phase = "budget-exceeded";
						break;
					default:
						// Token usage can come from any event type
						if (typeof event.tokens === "number") tokensUsed += event.tokens;
						break;
				}
			}

			const now = Date.now();
			const elapsedMs = startedAt !== null ? now - startedAt : 0;
			const budgetPct = budgetMaxTokens > 0
				? Math.round((tokensUsed / budgetMaxTokens) * 10000) / 100
				: 0;

			const status: SwarmStatus = {
				slug: params.slug,
				phase,
				agentsTotal,
				agentsComplete,
				agentsFailed,
				tokensUsed,
				budgetPct,
				elapsedMs,
				events,
			};

			const progressBar = agentsTotal > 0
				? (() => {
					const done = agentsComplete + agentsFailed;
					const pct = Math.round((done / agentsTotal) * 100);
					const filled = Math.round(pct / 5);
					return `[${"#".repeat(filled)}${"-".repeat(20 - filled)}] ${pct}%`;
				})()
				: "[no agents tracked]";

			const lines = [
				`# Swarm Status: ${params.slug}`,
				``,
				`**Phase:** ${phase}`,
				`**Progress:** ${progressBar}`,
				`**Agents:** ${agentsComplete} complete, ${agentsFailed} failed / ${agentsTotal} total`,
				`**Tokens:** ${tokensUsed.toLocaleString()} used (${budgetPct}% of budget)`,
				`**Elapsed:** ${(elapsedMs / 1000).toFixed(1)}s`,
				`**Events:** ${events.length}`,
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: status,
			};
		},
	});

	// ── Tool 3: run_swarm ──────────────────────────────

	pi.registerTool({
		name: "run_swarm",
		label: "Run Swarm",
		description:
			"Prepare the swarm orchestration infrastructure for a research query. Creates directory " +
			"structure, writes the execution manifest, initializes the event log, and returns prepared " +
			"paths plus a budget tracker. Does NOT dispatch agents — the caller uses subagent tool " +
			"calls and logs events back via the returned event log path.",

		parameters: Type.Object({
			slug: Type.String({
				description: "URL-safe identifier for this swarm run (e.g., 'scaling-laws-2025')",
			}),
			query: Type.String({
				description: "The original research query that spawned this swarm",
			}),
			phases: Type.Array(
				Type.Object({
					name: Type.String({ description: "Phase name: scout, research, debate, verify, build, or custom" }),
					agents: Type.Array(Type.String(), {
						description: "List of agent identifiers to run in this phase",
					}),
				}),
				{ description: "Ordered list of execution phases, each with its agent roster" },
			),
			budget: Type.Optional(
				Type.Union([
					Type.Literal("broad"),
					Type.Literal("expensive"),
					Type.Object({
						maxTokens: Type.Number({ description: "Maximum total tokens across all agents" }),
						maxAgents: Type.Number({ description: "Maximum number of agent spawns" }),
						maxWallClockMs: Type.Number({ description: "Maximum wall-clock time in milliseconds" }),
					}),
				], { description: "Budget tier or custom limits. Default: 'broad'" }),
			),
		}),
		async execute(_id, params) {
			const cwd = process.cwd();
			const safeSlug = slugify(params.slug);
			const swarmDir = getSwarmDir(cwd, safeSlug);

			// ── Enforce minimum agent count ──
			const totalAgents = params.phases.reduce((sum, p) => sum + p.agents.length, 0);

			const MIN_AGENTS_BROAD = 100;
			const MIN_AGENTS_EXPENSIVE = 300;
			const scaleStr = typeof params.budget === "string" ? params.budget : "broad";
			const minRequired = scaleStr === "expensive" ? MIN_AGENTS_EXPENSIVE : MIN_AGENTS_BROAD;

			if (totalAgents < minRequired) {
				return {
					content: [{ type: "text", text: `REJECTED: Plan has only ${totalAgents} agents. Minimum for '${scaleStr}' tier is ${minRequired}. Redesign the plan with more diverse researchers — add domain specialists, different lenses (empiricist/theorist/practitioner/critic/historian/methodologist), and different stances (advocate/skeptic/neutral/contrarian). Every research request deserves thorough investigation.` }],
					details: { rejected: true, totalAgents, minRequired, scale: scaleStr } as Record<string, unknown>,
				};
			}

			// ── Create directory structure ──
			mkdirSync(swarmDir, { recursive: true });
			for (const subdir of SWARM_SUBDIRS) {
				mkdirSync(resolve(swarmDir, subdir), { recursive: true });
			}

			// ── Resolve budget ──
			const limits = resolveBudget(params.budget as "broad" | "expensive" | BudgetLimits | undefined);

			// ── Write manifest ──
			const plan: SwarmPlan = {
				slug: safeSlug,
				query: params.query,
				phases: params.phases,
				budget: params.budget as SwarmPlan["budget"],
			};
			const manifestPath = resolve(swarmDir, "manifest.md");
			writeFileSync(manifestPath, buildManifest(plan, limits), "utf-8");

			// ── Initialize event log ──
			const eventsPath = getEventsPath(swarmDir);
			const initEvent: SwarmEvent = {
				ts: new Date().toISOString(),
				type: "swarm_init",
				slug: safeSlug,
				query: params.query,
				totalAgents,
				phaseCount: params.phases.length,
				maxTokens: limits.maxTokens,
				maxAgents: limits.maxAgents,
				maxWallClockMs: limits.maxWallClockMs,
			};
			appendEvent(eventsPath, initEvent);

			// ── Build budget tracker ──
			const tracker = buildBudgetTracker(limits, [initEvent]);

			// ── Build paths map ──
			const paths: Record<string, string> = {
				swarmDir,
				manifest: manifestPath,
				events: eventsPath,
			};
			for (const subdir of SWARM_SUBDIRS) {
				paths[subdir] = resolve(swarmDir, subdir);
			}

			// ── Build phase summary for output ──
			const phaseSummary = params.phases.map((p, i) =>
				`  ${i + 1}. ${p.name} (${p.agents.length} agent${p.agents.length === 1 ? "" : "s"}): ${p.agents.join(", ")}`,
			);

			const lines = [
				`# Swarm Prepared: ${safeSlug}`,
				``,
				`**Directory:** ${swarmDir}`,
				`**Manifest:** ${manifestPath}`,
				`**Event log:** ${eventsPath}`,
				``,
				`## Budget`,
				`  Tokens: ${limits.maxTokens.toLocaleString()}`,
				`  Agents: ${limits.maxAgents}`,
				`  Wall clock: ${limits.maxWallClockMs > 0 ? `${(limits.maxWallClockMs / 1000).toFixed(0)}s` : "unlimited"}`,
				``,
				`## Phases (${params.phases.length})`,
				...phaseSummary,
				``,
				`## Agent total: ${totalAgents}`,
				``,
				`## Subdirectories`,
				...SWARM_SUBDIRS.map((d) => `  ${d}/`),
				``,
				`Ready for agent dispatch. Log events to: ${eventsPath}`,
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					slug: safeSlug,
					paths,
					budget: tracker,
					totalAgents,
					phases: params.phases,
				} as Record<string, unknown>,
			};
		},
	});

	// ── Tool 4: log_agent_spawn ────────────────────────

	pi.registerTool({
		name: "log_agent_spawn",
		label: "Log Agent Spawn",
		description: "REQUIRED before spawning each subagent. Checks budget limits and either approves or blocks the spawn.",
		parameters: Type.Object({
			slug: Type.String({ description: "Swarm slug" }),
			agentName: Type.String({ description: "Agent template name" }),
			agentId: Type.String({ description: "Unique ID for this agent instance" }),
			phase: Type.Optional(Type.String({ description: "Current pipeline phase (scout|research|debate|verify|build). Required for phase_gate threshold tracking." })),
		}),
		async execute(_id, params) {
			const cwd = process.cwd();
			const swarmDir = getSwarmDir(cwd, params.slug);
			const eventsPath = getEventsPath(swarmDir);
			const events = readEvents(eventsPath);

			const initEvent = events.find(e => e.type === "swarm_init");
			const maxAgents = (initEvent?.maxAgents as number) ?? 200;
			const rawEnvMax = process.env.ZENITH_MAX_AGENTS;
			const parsedEnvMax = rawEnvMax !== undefined && rawEnvMax !== "" ? parseInt(rawEnvMax, 10) : NaN;
			const settingsMax = Number.isFinite(parsedEnvMax) ? parsedEnvMax : maxAgents;
			const effectiveMax = Math.min(maxAgents, settingsMax);

			const spawned = events.filter(e => e.type === "agent_spawn").length;

			if (spawned >= effectiveMax) {
				appendEvent(eventsPath, { ts: new Date().toISOString(), type: "budget_exceeded", reason: "agent_limit", spawned, limit: effectiveMax, blocked: params.agentId });
				return {
					content: [{ type: "text", text: `BUDGET_EXCEEDED: Agent limit reached (${spawned}/${effectiveMax}). Do NOT spawn more agents. Proceed to synthesis with available results.` }],
					details: { approved: false, spawned, limit: effectiveMax },
				};
			}

			// Resolve current phase: prefer explicit param, else derive from last phase_transition.
			const phaseEvents = events.filter(e => e.type === "phase_transition" || e.type === "phase_start");
			const lastPhase = phaseEvents.length > 0 ? String(phaseEvents[phaseEvents.length - 1]!.phase ?? "scout") : "scout";
			const phase = params.phase ?? lastPhase;

			appendEvent(eventsPath, { ts: new Date().toISOString(), type: "agent_spawn", agent: params.agentName, id: params.agentId, phase });
			return {
				content: [{ type: "text", text: `APPROVED: Agent ${spawned + 1} of ${effectiveMax} (${params.agentName}:${params.agentId})` }],
				details: { approved: true, spawned: spawned + 1, limit: effectiveMax },
			};
		},
	});

	// ── Tool 4b: mark_agent_complete ───────────────────
	// Records that a previously-spawned agent finished successfully. This is the
	// counterpart to log_agent_spawn — together they let phase_gate compute
	// completion ratios and let swarm_status show real progress.

	pi.registerTool({
		name: "mark_agent_complete",
		label: "Mark Agent Complete",
		description: "Record that a spawned agent finished successfully. Pair with log_agent_spawn so phase_gate threshold checks work.",
		parameters: Type.Object({
			slug: Type.String({ description: "Swarm slug" }),
			agentId: Type.String({ description: "Agent instance ID (same value passed to log_agent_spawn)" }),
			tokens: Type.Optional(Type.Number({ description: "Token usage for budget tracking" })),
			phase: Type.Optional(Type.String({ description: "Phase the agent ran in" })),
		}),
		async execute(_id, params) {
			const cwd = process.cwd();
			const swarmDir = getSwarmDir(cwd, params.slug);
			const eventsPath = getEventsPath(swarmDir);
			if (!existsSync(eventsPath)) {
				return { content: [{ type: "text", text: `NO_SWARM: slug '${params.slug}' not initialized.` }], details: { ok: false } as Record<string, unknown> };
			}
			// Derive phase from the matching spawn event if not provided.
			let phase = params.phase;
			if (!phase) {
				const events = readEvents(eventsPath);
				const spawn = events.find(e => e.type === "agent_spawn" && e.id === params.agentId);
				phase = spawn ? String(spawn.phase ?? "unknown") : "unknown";
			}
			appendEvent(eventsPath, { ts: new Date().toISOString(), type: "agent_complete", id: params.agentId, tokens: params.tokens ?? 0, phase });
			return { content: [{ type: "text", text: `OK: Marked ${params.agentId} complete (phase=${phase})` }], details: { ok: true, phase } as Record<string, unknown> };
		},
	});

	// ── Tool 4c: mark_agent_failed ─────────────────────

	pi.registerTool({
		name: "mark_agent_failed",
		label: "Mark Agent Failed",
		description: "Record that a spawned agent failed or returned empty. Counts toward completion-ratio but not useful output.",
		parameters: Type.Object({
			slug: Type.String({ description: "Swarm slug" }),
			agentId: Type.String({ description: "Agent instance ID" }),
			reason: Type.Optional(Type.String({ description: "Short failure reason" })),
			tokens: Type.Optional(Type.Number({ description: "Token usage before failure" })),
			phase: Type.Optional(Type.String({ description: "Phase the agent ran in" })),
		}),
		async execute(_id, params) {
			const cwd = process.cwd();
			const swarmDir = getSwarmDir(cwd, params.slug);
			const eventsPath = getEventsPath(swarmDir);
			if (!existsSync(eventsPath)) {
				return { content: [{ type: "text", text: `NO_SWARM: slug '${params.slug}' not initialized.` }], details: { ok: false } as Record<string, unknown> };
			}
			let phase = params.phase;
			if (!phase) {
				const events = readEvents(eventsPath);
				const spawn = events.find(e => e.type === "agent_spawn" && e.id === params.agentId);
				phase = spawn ? String(spawn.phase ?? "unknown") : "unknown";
			}
			appendEvent(eventsPath, { ts: new Date().toISOString(), type: "agent_failed", id: params.agentId, reason: params.reason ?? "", tokens: params.tokens ?? 0, phase });
			return { content: [{ type: "text", text: `OK: Marked ${params.agentId} failed (phase=${phase}${params.reason ? `, reason=${params.reason}` : ""})` }], details: { ok: true, phase } as Record<string, unknown> };
		},
	});

	// ── Tool 5: phase_gate ─────────────────────────────

	pi.registerTool({
		name: "phase_gate",
		label: "Phase Gate",
		description: "REQUIRED before advancing to the next swarm phase. Validates the current phase is complete enough to proceed.",
		parameters: Type.Object({
			slug: Type.String({ description: "Swarm slug" }),
			nextPhase: Type.String({ description: "Phase to transition to" }),
		}),
		async execute(_id, params) {
			// 6-phase pipeline. `deliver` is the final gate (README/AGENTS). `cross-examine`
			// and `quality-gate` are documentation-friendly aliases for `debate` and `deliver`.
			const PHASE_ORDER = ["scout", "research", "debate", "verify", "build", "deliver"];
			const PHASE_ALIASES: Record<string, string> = {
				"cross-examine": "debate",
				"cross-examination": "debate",
				"quality-gate": "deliver",
				"quality_gate": "deliver",
				"deliver-artifact": "deliver",
			};
			const READY_THRESHOLDS: Record<string, number> = { scout: 1.0, research: 0.6, debate: 0.7, verify: 0.8, build: 1.0, deliver: 1.0 };

			const cwd = process.cwd();
			const swarmDir = getSwarmDir(cwd, params.slug);
			const eventsPath = getEventsPath(swarmDir);
			const events = readEvents(eventsPath);
			const nextPhase = PHASE_ALIASES[params.nextPhase] ?? params.nextPhase;

			// Determine current phase. We distinguish three signals:
			//   - `phase_start` (caller declared the phase open)
			//   - `phase_transition` (this gate wrote it on a prior APPROVE)
			//   - `phase_complete` (caller explicitly marked the phase done)
			// `phase_transition` advances the "current" cursor but does NOT itself count
			// as "complete" — otherwise the gate's own writes would satisfy its own check.
			const phaseEvents = events.filter(e => {
				const eventType = (e.type as string) || (e.event as string) || "";
				return eventType === "phase_start" || eventType === "phase_transition" || eventType === "phase_complete";
			});

			let currentPhase = "none";
			let explicitlyComplete = false;
			if (phaseEvents.length > 0) {
				const last = phaseEvents[phaseEvents.length - 1]!;
				currentPhase = String(last.phase ?? "none");
				const lastType = (last.type as string) || (last.event as string) || "";
				explicitlyComplete = lastType === "phase_complete";
			}

			const currentIdx = PHASE_ORDER.indexOf(currentPhase);
			const nextIdx = PHASE_ORDER.indexOf(nextPhase);

			if (nextIdx === -1) {
				return { content: [{ type: "text", text: `BLOCKED: Unknown phase '${params.nextPhase}'. Valid phases: ${PHASE_ORDER.join(", ")}` }], details: { approved: false } as Record<string, unknown> };
			}

			if (nextIdx > currentIdx + 1) {
				const skipped = PHASE_ORDER.slice(currentIdx + 1, nextIdx).join(", ");
				return { content: [{ type: "text", text: `BLOCKED: Cannot skip phases. Complete '${skipped}' before advancing to '${nextPhase}'.` }], details: { approved: false } as Record<string, unknown> };
			}

			// Threshold check: does the current phase have enough completed agents?
			// Skipped when the caller explicitly emitted `phase_complete` (they know
			// it's done even if no agents were logged for it).
			if (currentPhase !== "none" && currentIdx >= 0 && !explicitlyComplete) {
				const threshold = READY_THRESHOLDS[currentPhase] ?? 0.6;
				// Count spawns + completions tagged to THIS phase specifically.
				// Require explicit phase tag — if the LLM didn't tag, we fall back to
				// matching agents that occurred after the current phase's transition.
				const currentTransitionIdx = events.findIndex(e => e.type === "phase_transition" && String(e.phase ?? "") === currentPhase);
				const windowStart = currentTransitionIdx === -1 ? 0 : currentTransitionIdx;
				const windowEvents = events.slice(windowStart);
				const phaseAgents = windowEvents.filter(e => e.type === "agent_spawn" && String(e.phase ?? currentPhase) === currentPhase).length;
				const agentsFinished = windowEvents.filter(e => (e.type === "agent_complete" || e.type === "agent_failed") && String(e.phase ?? currentPhase) === currentPhase).length;
				const completionRate = phaseAgents > 0 ? agentsFinished / phaseAgents : 1.0;

				if (completionRate < threshold) {
					return { content: [{ type: "text", text: `BLOCKED: Phase '${currentPhase}' is ${Math.round(completionRate * 100)}% complete (need ${Math.round(threshold * 100)}%). Wait for more agents to finish, or emit a phase_complete event for '${currentPhase}'.` }], details: { approved: false, completionRate, threshold, phaseAgents, agentsFinished } as Record<string, unknown> };
				}
			}

			appendEvent(eventsPath, { ts: new Date().toISOString(), type: "phase_transition", from: currentPhase, phase: nextPhase });
			return { content: [{ type: "text", text: `APPROVED: Advancing to phase '${nextPhase}' (${currentPhase} was ${currentPhase === "none" ? "initial" : explicitlyComplete ? "explicitly complete" : "ready"})` }], details: { approved: true, from: currentPhase, to: nextPhase } as Record<string, unknown> };
		},
	});

	// ── Tool 6: deliver_artifact ───────────────────────

	pi.registerTool({
		name: "deliver_artifact",
		label: "Deliver Artifact",
		description: "REQUIRED to finalize a swarm research deliverable. Runs structural citation verification before allowing delivery.",
		parameters: Type.Object({
			slug: Type.String({ description: "Swarm slug" }),
			artifactPath: Type.String({ description: "Path to the final research artifact" }),
		}),
		async execute(_id, params) {
			const cwd = process.cwd();
			const swarmDir = getSwarmDir(cwd, params.slug);
			const eventsPath = getEventsPath(swarmDir);
			// Resolve artifact path: try cwd-relative first, then swarm-relative so LLMs
			// that hand us `build/final.md` work regardless of where `zenith` was launched.
			let fullPath = resolve(cwd, params.artifactPath);
			if (!existsSync(fullPath)) {
				const swarmRelative = resolve(swarmDir, params.artifactPath);
				if (existsSync(swarmRelative)) fullPath = swarmRelative;
			}

			if (!existsSync(fullPath)) {
				return { content: [{ type: "text", text: `DELIVERY_BLOCKED: Artifact not found at ${params.artifactPath} (tried ${cwd} and ${swarmDir})` }], details: { delivered: false } as Record<string, unknown> };
			}

			const content = readFileSync(fullPath, "utf8");

			// Strip fenced code blocks before extracting citations so `[1]` inside code
			// doesn't inflate the count.
			const stripped = content.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
			const inlineMatches = [...stripped.matchAll(/\[(\d+)\]/g)];
			const citedNumbers = new Set(inlineMatches.map(m => parseInt(m[1], 10)));
			const hasSourcesSection = /^#{1,4}\s*(Sources|References|Bibliography)\s*$/mi.test(content);
			// Source entries: `N. ...` or `[N] ...` or `- [N] ...`
			const sourceEntryRe = /^\s*[-*]?\s*\[?(\d+)\]?[\.\):\s]/gm;
			const sourceNumbers = new Set<number>();
			for (const m of content.matchAll(sourceEntryRe)) {
				sourceNumbers.add(parseInt(m[1], 10));
			}

			const issues: string[] = [];
			if (citedNumbers.size === 0) issues.push("No inline citations [N] found in the body");
			if (!hasSourcesSection) issues.push("No Sources/References/Bibliography section found");
			if (content.length < 500) issues.push("Artifact is suspiciously short (<500 chars)");

			// Each inline citation must resolve to a source entry (fatal).
			const orphanInline = [...citedNumbers].filter(n => !sourceNumbers.has(n));
			for (const n of orphanInline) {
				issues.push(`Inline citation [${n}] has no matching entry in Sources section`);
			}
			// Each source entry should be referenced by at least one inline citation (major).
			const orphanSources = [...sourceNumbers].filter(n => !citedNumbers.has(n));
			for (const n of orphanSources) {
				issues.push(`Source [${n}] is listed but never referenced in the body`);
			}

			if (issues.length > 0) {
				appendEvent(eventsPath, { ts: new Date().toISOString(), type: "delivery_blocked", artifact: params.artifactPath, issues });
				const issueList = issues.map(i => `  - ${i}`).join("\n");
				return {
					content: [{ type: "text", text: `DELIVERY_BLOCKED: Fix these issues before delivering:\n${issueList}\n\nRun verify_citations and fix, then call deliver_artifact again.` }],
					details: { delivered: false, issues } as Record<string, unknown>,
				};
			}

			appendEvent(eventsPath, { ts: new Date().toISOString(), type: "delivered", artifact: params.artifactPath, citations: citedNumbers.size, sources: sourceNumbers.size });

			// Copy final artifact to ~/research/, rotating any prior report so it isn't
			// silently clobbered. Prior report is renamed with an ISO timestamp suffix
			// derived from its mtime; swarm-work is preserved intact.
			const researchDir = resolve(process.env.HOME ?? ".", "research");
			mkdirSync(researchDir, { recursive: true });
			const baseName = params.slug + ".md";
			const destPath = resolve(researchDir, baseName);
			let rotatedPath: string | undefined;
			if (existsSync(destPath)) {
				const stat = statSync(destPath);
				const ts = stat.mtime.toISOString().replace(/[:.]/g, "-");
				rotatedPath = resolve(researchDir, `${params.slug}.${ts}.md`);
				copyFileSync(destPath, rotatedPath);
			}
			copyFileSync(fullPath, destPath);

			const deliveredMsg = rotatedPath
				? `DELIVERED: Research saved to ~/research/${baseName}\nPrevious version rotated to ${rotatedPath}\nWorking data at ${swarmDir}`
				: `DELIVERED: Research saved to ~/research/${baseName}\nWorking data at ${swarmDir}`;

			return { content: [{ type: "text", text: deliveredMsg }], details: { delivered: true, citations: citedNumbers.size, sources: sourceNumbers.size, researchPath: destPath, rotatedPath, swarmDir } as Record<string, unknown> };
		},
	});
}
