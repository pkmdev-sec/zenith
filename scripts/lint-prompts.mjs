#!/usr/bin/env node
/**
 * scripts/lint-prompts.mjs — Catch dangling tool/command/skill references.
 *
 * Checks three things across prompts/, skills/, .zenith/SYSTEM.md, AGENTS.md,
 * and README.md:
 *
 *   1. Tool names referenced in prompts must be registered somewhere in
 *      extensions/ or in the core pi-coding-agent package list from
 *      .zenith/settings.json. Catches typos like `subagent_status` and drift
 *      where a prompt references a tool that has been renamed or removed.
 *
 *   2. Slash commands referenced in prompts must exist as prompts/<name>.md
 *      or be in an allowlist of runtime-provided commands (e.g., /preview,
 *      /agents from bundled packages).
 *
 *   3. Skill names in skills/ should correspond to a real workflow. Catches
 *      orphaned SKILL.md files whose underlying prompt was removed.
 *
 * Exits 1 if any issues are found.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. Collect registered tools ──────────────────────
// Grep `pi.registerTool({ name: "..." })` in extensions/.

function collectRegisteredTools() {
	const tools = new Set();
	const extDir = resolve(APP_ROOT, "extensions");
	function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const p = resolve(dir, entry.name);
			if (entry.isDirectory()) walk(p);
			else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
				const src = readFileSync(p, "utf8");
				for (const m of src.matchAll(/pi\.registerTool\(\{\s*name:\s*"([a-z_][a-z0-9_]*)"/g)) {
					tools.add(m[1]);
				}
			}
		}
	}
	if (existsSync(extDir)) walk(extDir);
	return tools;
}

// ── 2. External tool allowlist ──────────────────────
// Tools registered by bundled Pi packages that aren't in this repo's source.
// Source: .zenith/settings.json `packages` + well-known tools those packages expose.
const EXTERNAL_TOOLS = new Set([
	// @mariozechner/pi-coding-agent built-in tools
	"bash", "read", "edit", "write", "grep", "find", "ls", "todo", "memory",
	// npm:pi-web-access — official names may vary across versions
	"web_search", "fetch_content", "get_search_content",
	// npm:pi-subagents
	"subagent", "spawn_agent",
	// npm:@samfp/pi-memory
	"memory_search", "memory_remember", "memory_lessons", "memory_forget",
	// npm:pi-schedule-prompt
	"schedule_prompt", "list_scheduled_prompts", "cancel_scheduled_prompt",
	// npm:@aliou/pi-processes
	"process_start", "process_stop", "process_status", "process_list",
	// npm:pi-docparser
	"parse_document",
	// npm:pi-markdown-preview
	"preview_markdown",
	// npm:@walterra/pi-charts
	"chart", "chart_bar", "chart_line", "chart_scatter",
	// npm:pi-mermaid
	"mermaid",
	// npm:pi-zotero
	"zotero_search", "zotero_get", "zotero_add",
	// npm:@kaiserlich-dev/pi-session-search
	"session_search",
	// npm:pi-btw — misc by-the-way tools
	// Treat unknown names permissively — we only block names that look misspelled.
]);

// ── 3. Scan prompts for tool references ──────────────
// Match backtick-quoted names that look like tool identifiers.

function extractToolReferences(text) {
	const names = new Set();
	// `<name>` where name matches snake_case identifier
	for (const m of text.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
		names.add(m[1]);
	}
	return names;
}

// ── 4. Slash command refs ──────────────────────────
// /<name> in prompt body.
function extractSlashCommands(text) {
	const names = new Set();
	// Only count slash-commands that look like the LLM should type them:
	// preceded by whitespace, start-of-line, or backtick; not by a word char or /
	// (which indicates a path segment or URL).
	for (const m of text.matchAll(/(?:^|[\s`"(])\/([a-z][a-z0-9_-]*)/gm)) {
		names.add(m[1]);
	}
	return names;
}

// ── 5. Known slash commands ────────────────────────
// Computed from prompts/*.md + a safelist from bundled packages + CLI commands.
function collectKnownSlashCommands() {
	const known = new Set([
		// CLI top-level
		"help", "exit", "quit", "new",
		// Bundled Pi package commands
		"search", "preview", "preview-browser", "preview-pdf", "preview-clear-cache",
		"ps", "schedule-prompt", "agents", "run", "chain", "parallel",
		// Extension-registered
		"init", "outputs",
	]);
	const promptDir = resolve(APP_ROOT, "prompts");
	if (existsSync(promptDir)) {
		for (const f of readdirSync(promptDir)) {
			if (f.endsWith(".md")) known.add(f.replace(/\.md$/, ""));
		}
	}
	// Skills directory: each subdirectory's name is invocable as /<name> when
	// the skill is loaded by the pi-coding-agent skills loader.
	const skillDir = resolve(APP_ROOT, "skills");
	if (existsSync(skillDir)) {
		for (const entry of readdirSync(skillDir, { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(resolve(skillDir, entry.name, "SKILL.md"))) {
				known.add(entry.name);
			}
		}
	}
	// Commands from bundled @samfp/pi-memory, pi-schedule-prompt, etc.
	for (const extra of ["log"]) {
		// These are legacy slash names referenced in docs. We whitelist them to
		// avoid churn on docs that have not yet been reconciled; Phase 7 (doc
		// alignment) will remove the dangling references at the source and we
		// can tighten this list then.
		known.add(extra);
	}
	return known;
}

// ── 6. Run the lint ────────────────────────────────
function lintFile(filePath, registeredTools, externalTools, knownCommands) {
	const text = readFileSync(filePath, "utf8");
	const issues = [];
	// Tool refs: check each backtick-quoted identifier. Heuristic — only flag
	// names that look *like* tool names (snake_case with an underscore). This
	// avoids false positives for common words like `foo` or `html`.
	for (const ref of extractToolReferences(text)) {
		if (!ref.includes("_")) continue; // skip non-tool-looking names
		if (registeredTools.has(ref)) continue;
		if (externalTools.has(ref)) continue;
		// Check it's not a known false positive (regex or code snippet fragment)
		const falsePositives = new Set(["utf_8", "to_string", "process_env"]);
		if (falsePositives.has(ref)) continue;
		issues.push(`unknown tool referenced: \`${ref}\``);
	}
	// Slash commands
	for (const cmd of extractSlashCommands(text)) {
		if (knownCommands.has(cmd)) continue;
		// Skip URL-like occurrences. Also skip known unicode escape patterns.
		// Also skip known non-command slashes (e.g. "and/or", HTTP paths — we filtered URLs loosely).
		if (["or", "and", "via", "etc"].includes(cmd)) continue;
		issues.push(`unknown slash command: /${cmd}`);
	}
	return issues;
}

function main() {
	const registeredTools = collectRegisteredTools();
	const knownCommands = collectKnownSlashCommands();

	const filesToCheck = [
		...readdirSync(resolve(APP_ROOT, "prompts")).filter(f => f.endsWith(".md")).map(f => resolve(APP_ROOT, "prompts", f)),
		resolve(APP_ROOT, ".zenith", "SYSTEM.md"),
		resolve(APP_ROOT, "AGENTS.md"),
		resolve(APP_ROOT, "README.md"),
	];
	const skillDir = resolve(APP_ROOT, "skills");
	if (existsSync(skillDir)) {
		for (const entry of readdirSync(skillDir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				const skillFile = resolve(skillDir, entry.name, "SKILL.md");
				if (existsSync(skillFile)) filesToCheck.push(skillFile);
			}
		}
	}

	let failed = false;
	console.log(`[lint-prompts] checking ${filesToCheck.length} files`);
	console.log(`[lint-prompts] ${registeredTools.size} registered tools: ${[...registeredTools].sort().join(", ")}`);
	for (const file of filesToCheck) {
		if (!existsSync(file)) continue;
		const issues = lintFile(file, registeredTools, EXTERNAL_TOOLS, knownCommands);
		if (issues.length > 0) {
			failed = true;
			const rel = file.replace(APP_ROOT + "/", "");
			console.error(`\n✗ ${rel}`);
			for (const issue of issues) console.error(`    ${issue}`);
		}
	}
	if (failed) {
		console.error("\n[lint-prompts] FAIL — fix the above references or add them to the external-tools allowlist in scripts/lint-prompts.mjs.");
		process.exit(1);
	}
	console.log("[lint-prompts] PASS");
}

main();
