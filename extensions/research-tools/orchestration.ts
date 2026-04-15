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
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
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
	wallClockPct: number;
}

// ── Constants ──────────────────────────────────────────

const DEFAULT_BROAD_BUDGET: BudgetLimits = { maxTokens: 500_000, maxAgents: 200, maxWallClockMs: 600_000 };
const DEFAULT_EXPENSIVE_BUDGET: BudgetLimits = { maxTokens: 1_500_000, maxAgents: 500, maxWallClockMs: 900_000 };

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

function getSwarmDir(workingDir: string, slug: string): string {
	return resolve(workingDir, "outputs", ".swarm", slug);
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
		`**Budget:** ${limits.maxTokens.toLocaleString()} tokens / ${limits.maxAgents} agents / ${(limits.maxWallClockMs / 1000).toFixed(0)}s wall clock`,
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
		if (event.type === "agent_start") {
			agentsSpawned++;
		}
	}

	const budgetPct = limits.maxTokens > 0 ? (tokensUsed / limits.maxTokens) * 100 : 0;
	const elapsed = Date.now() - new Date(startedAt).getTime();
	const wallClockPct = limits.maxWallClockMs > 0 ? (elapsed / limits.maxWallClockMs) * 100 : 0;

	return {
		limits,
		tokensUsed,
		agentsSpawned,
		startedAt,
		remainingTokens: Math.max(0, limits.maxTokens - tokensUsed),
		remainingAgents: Math.max(0, limits.maxAgents - agentsSpawned),
		budgetPct: Math.round(budgetPct * 100) / 100,
		wallClockPct: Math.round(wallClockPct * 100) / 100,
	};
}

// ── Tool registration ──────────────────────────────────

export function registerOrchestrationTools(pi: ExtensionAPI): void {
	// ── Tool 1: classify_intent ────────────────────────

	pi.registerTool({
		name: "classify_intent",
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

			if (wordCount < 15 && QUESTION_WORDS.has(firstWordLower)) {
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
		description:
			"Read the append-only event log for a swarm and return structured status including " +
			"phase, agent progress, token usage, budget percentage, and elapsed time.",

		parameters: Type.Object({
			slug: Type.String({ description: "Swarm slug (directory name under outputs/.swarm/)" }),
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
					}],
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
					case "agent_start":
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
			const totalAgents = params.phases.reduce((sum, p) => sum + p.agents.length, 0);
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
				`  Wall clock: ${(limits.maxWallClockMs / 1000).toFixed(0)}s`,
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
				},
			};
		},
	});
}
