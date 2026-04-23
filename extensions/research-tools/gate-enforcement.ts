/**
 * gate-enforcement.ts — Runtime enforcement for the "code-enforced gates".
 *
 * The README/AGENTS.md promise that `log_agent_spawn`, `phase_gate`, and
 * `deliver_artifact` are *code-enforced*. Without a `tool_call` interceptor,
 * those claims are prose: the LLM can simply skip the tools. This module
 * provides the missing enforcement by subscribing to `tool_call` events and
 * rejecting calls that bypass the gates.
 *
 * Two invariants enforced:
 *
 *   1. Every write to `~/research/<slug>.md` must be preceded by a successful
 *      `deliver_artifact` call for that slug. Unsanctioned writes are blocked
 *      with a message pointing the LLM at the right workflow.
 *
 *   2. `subagent` (or `spawn_agent`) calls that target a roster-style research
 *      agent must be preceded by a `log_agent_spawn` APPROVED event for that
 *      agent id. (Permissive for non-swarm uses: if no active swarm is open,
 *      subagent calls are allowed; the goal is to catch bypass, not block
 *      normal agent delegation.)
 *
 * Enforcement is driven off the append-only event log the gates already write.
 * That means these checks see exactly what the gates committed — not an
 * in-memory snapshot that can drift.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── Path helpers (mirror of extensions/research-tools/orchestration.ts) ──

function getZenithHome(): string {
	if (process.env.ZENITH_HOME) return process.env.ZENITH_HOME;
	const home = process.env.HOME ?? homedir();
	return resolve(home, ".zenith");
}

function getSwarmWorkRoot(): string {
	return resolve(getZenithHome(), "swarm-work");
}

function getResearchDir(): string {
	return resolve(process.env.HOME ?? homedir(), "research");
}

// ── Event log helpers ──

type SwarmEvent = Record<string, unknown> & { type?: string };

function readSwarmEvents(slug: string): SwarmEvent[] {
	const path = resolve(getSwarmWorkRoot(), slug, "events.jsonl");
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8");
	const out: SwarmEvent[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try { out.push(JSON.parse(t)); } catch { /* ignore malformed */ }
	}
	return out;
}

function listActiveSwarms(): string[] {
	const root = getSwarmWorkRoot();
	if (!existsSync(root)) return [];
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter(e => e.isDirectory())
			.map(e => e.name);
	} catch {
		return [];
	}
}

// Check: has this agentId been APPROVED via log_agent_spawn in any swarm?
function isAgentApproved(agentId: string): boolean {
	for (const slug of listActiveSwarms()) {
		const events = readSwarmEvents(slug);
		for (const ev of events) {
			if (ev.type === "agent_spawn" && ev.id === agentId) return true;
		}
	}
	return false;
}

// Check: was this exact artifact path approved by deliver_artifact (i.e., a
// `delivered` event exists in some swarm's log with researchPath matching)?
function isResearchPathApproved(researchPath: string): boolean {
	const target = resolve(researchPath);
	for (const slug of listActiveSwarms()) {
		const events = readSwarmEvents(slug);
		for (const ev of events) {
			if (ev.type !== "delivered") continue;
			// The `delivered` event doesn't currently include researchPath, only
			// `artifact`. But deliver_artifact always copies to ~/research/<slug>.md,
			// so we can derive it:
			const expected = resolve(getResearchDir(), `${slug}.md`);
			if (expected === target) return true;
		}
	}
	return false;
}

// ── Gate detection ──

// "Research-looking" write: ~/research/<slug>.md (the directory deliver_artifact copies to).
function isResearchWrite(filePath: string | undefined): boolean {
	if (!filePath) return false;
	const abs = resolve(filePath);
	const researchDir = getResearchDir();
	return abs.startsWith(researchDir + "/") && abs.endsWith(".md");
}

// ── Extension hook ──

export function registerGateEnforcement(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		// 1) Research-directory write guard.
		// Applies to: `write`, `edit`, and bash invocations that look like they
		// clobber ~/research/. This catches the most obvious bypass paths.
		if (event.toolName === "write" || event.toolName === "edit") {
			const input = (event as any).input ?? {};
			const target = (input.file_path ?? input.path ?? input.filePath) as string | undefined;
			if (isResearchWrite(target) && !isResearchPathApproved(target!)) {
				return {
					block: true,
					reason:
						`GATE_BLOCKED: Direct writes to ${getResearchDir()}/ are not allowed. ` +
						`Use deliver_artifact after passing verify_citations to publish a research report. ` +
						`This is the code-enforced delivery gate — see AGENTS.md.`,
				};
			}
		}

		if (event.toolName === "bash") {
			const cmd = ((event as any).input?.command as string | undefined) ?? "";
			// Heuristic: a bash command that writes to the research dir via
			// redirection, cp, mv, or tee. This doesn't catch every case (no bash
			// parser here) but nails the common ones.
			if (/\~\/research\/[^\s]+\.md/.test(cmd) || /\/research\/[^\s]+\.md/.test(cmd)) {
				if (/(^|[\s;&|])(tee|cp|mv|rm|cat\s+>|echo\s+.*>)/.test(cmd) || />\s*[^\s]*\/research\/[^\s]+\.md/.test(cmd)) {
					// If no approved research path in this command, block.
					const match = cmd.match(/~?\/?[^\s]*\/research\/[^\s]+\.md/);
					const candidate = match ? match[0].replace(/^~/, process.env.HOME ?? homedir()) : undefined;
					if (!candidate || !isResearchPathApproved(candidate)) {
						return {
							block: true,
							reason:
								`GATE_BLOCKED: Shell write to ~/research/ detected. ` +
								`Publish research reports via deliver_artifact, not direct shell I/O. ` +
								`This is the code-enforced delivery gate.`,
						};
					}
				}
			}
		}

		// 2) Subagent spawn guard.
		// The `subagent` / `spawn_agent` tool takes an agent task spec. We check
		// whether the current request's agent id was approved via log_agent_spawn.
		// If the caller didn't pass an id, we can't verify — in that case we skip
		// enforcement (permissive; we only block clear bypass).
		if (event.toolName === "subagent" || event.toolName === "spawn_agent") {
			// No active swarms ⇒ this call isn't part of the research pipeline;
			// allow (unit tests, one-off delegation, etc.).
			if (listActiveSwarms().length === 0) return undefined;

			const input = (event as any).input ?? {};
			const agentId = (input.agentId ?? input.id ?? input.task_id) as string | undefined;
			if (!agentId) return undefined; // permissive

			if (!isAgentApproved(agentId)) {
				return {
					block: true,
					reason:
						`GATE_BLOCKED: subagent spawn for agentId='${agentId}' was not approved. ` +
						`Call log_agent_spawn first — this is the code-enforced budget gate.`,
				};
			}
		}

		return undefined;
	});
}
