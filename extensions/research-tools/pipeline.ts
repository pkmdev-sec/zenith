/**
 * pipeline.ts — Research pipeline checkpoint and recovery system.
 *
 * Two tools:
 *   save_checkpoint  — Persist pipeline state at stage boundaries
 *   load_checkpoint  — Restore state to resume after interruption
 *
 * Checkpoints are stored in ~/.zenith/swarm-work/<slug>/checkpoints/ as JSON,
 * alongside the rest of the swarm working data for that slug.
 * The prompts instruct the lead agent to save checkpoints at each
 * stage boundary (after plan, after research, after draft, etc.)
 * so a crashed or interrupted pipeline can resume mid-flow.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── Types ──────────────────────────────────────────────

interface Checkpoint {
	slug: string;
	stage: string;
	timestamp: string;
	workflow: string;
	plan?: string;
	artifacts: string[];
	completedStages: string[];
	metadata: Record<string, unknown>;
}

// ── Helpers ────────────────────────────────────────────

// Checkpoints live alongside the swarm's working data under
// ~/.zenith/swarm-work/<slug>/checkpoints/. Source-of-truth resolution matches
// src/config/paths.ts::getSwarmCheckpointDir (duplicated because `extensions/`
// and `src/` are separate compilation units).
function getCheckpointDir(_workingDir: string, slug: string): string {
	const zenithHome = process.env.ZENITH_HOME ?? resolve(process.env.HOME ?? homedir(), ".zenith");
	return resolve(zenithHome, "swarm-work", slug, "checkpoints");
}

function getCheckpointPath(dir: string, stage: string): string {
	// Replace spaces/special chars with hyphens for safe filenames
	const safeName = stage.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	return resolve(dir, `${safeName}.json`);
}

// ── Tool registration ──────────────────────────────────

export function registerPipelineTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "save_checkpoint",
		label: "Save Checkpoint",
		description:
			"Save a pipeline checkpoint at the current stage. Use this at stage boundaries " +
			"(after planning, after research, after drafting, etc.) so the pipeline can " +
			"resume from this point if interrupted. Checkpoints live under ~/.zenith/swarm-work/<slug>/checkpoints/.",
		
		parameters: Type.Object({
			slug: Type.String({ description: "Research slug (e.g., 'scaling-laws')" }),
			stage: Type.String({
				description:
				"Current stage: plan, research, synthesize, draft, cite, verify, review, deliver",
			}),
			workflow: Type.String({
				description: "Workflow type: deepresearch, lit, review, audit, compare, draft, replicate",
			}),
			artifacts: Type.Array(Type.String(), {
				description: "List of file paths created/modified in this stage",
			}),
			completedStages: Type.Array(Type.String(), {
				description: "All stages completed so far, in order",
			}),
			planSummary: Type.Optional(
				Type.String({ description: "Brief summary of the research plan" }),
			),
			notes: Type.Optional(
				Type.String({ description: "Any notes about current state or pending work" }),
			),
		}),
		async execute(_id, params) {
			const cwd = process.cwd();
			const dir = getCheckpointDir(cwd, params.slug);
			mkdirSync(dir, { recursive: true });

			const checkpoint: Checkpoint = {
				slug: params.slug,
				stage: params.stage,
				timestamp: new Date().toISOString(),
				workflow: params.workflow,
				plan: params.planSummary,
				artifacts: params.artifacts,
				completedStages: params.completedStages,
				metadata: {},
			};
			if (params.notes) checkpoint.metadata.notes = params.notes;

			// Save stage-specific checkpoint
			const path = getCheckpointPath(dir, params.stage);
			writeFileSync(path, JSON.stringify(checkpoint, null, 2), "utf-8");

			// Also save a "latest" pointer
			const latestPath = resolve(dir, "latest.json");
			writeFileSync(latestPath, JSON.stringify(checkpoint, null, 2), "utf-8");

			// Verify artifacts exist
			const missing = params.artifacts.filter((a) => !existsSync(resolve(cwd, a)));

			const lines = [
				`Checkpoint saved: ${params.slug} @ ${params.stage}`,
				`  File: ${path}`,
				`  Completed stages: ${params.completedStages.join(" → ")}`,
				`  Artifacts: ${params.artifacts.length}`,
			];
			if (missing.length > 0) {
				lines.push(`  ⚠ Missing artifacts: ${missing.join(", ")}`);
			}

			return { content: [{ type: "text", text: lines.join("\n") }], details: checkpoint };
		},
	});

	pi.registerTool({
		name: "load_checkpoint",
		label: "Load Checkpoint",
		description:
			"Load the latest checkpoint for a research slug to resume an interrupted pipeline. " +
			"Returns the stage, completed work, and artifact paths so you can pick up where you left off.",
		
		parameters: Type.Object({
			slug: Type.String({ description: "Research slug to resume" }),
			stage: Type.Optional(
				Type.String({ description: "Load a specific stage checkpoint instead of latest" }),
			),
		}),
		async execute(_id, params) {
			const cwd = process.cwd();
			const dir = getCheckpointDir(cwd, params.slug);

			if (!existsSync(dir)) {
				return {
					content: [
						{
							type: "text",
							text: `No checkpoints found for "${params.slug}". Starting fresh.`,
						},
					], details: undefined,
				};
			}

			// Load specific or latest
			const path = params.stage ? getCheckpointPath(dir, params.stage) : resolve(dir, "latest.json");

			if (!existsSync(path)) {
				// List available checkpoints
				const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "latest.json");
				return {
					content: [
						{
							type: "text",
							text:
								`No checkpoint found for stage "${params.stage || "latest"}". ` +
								`Available checkpoints: ${files.map((f) => f.replace(".json", "")).join(", ") || "none"}`,
						},
					], details: undefined,
				};
			}

			try {
				const checkpoint: Checkpoint = JSON.parse(readFileSync(path, "utf-8"));

				// Check which artifacts still exist
				const artifactStatus = checkpoint.artifacts.map((a) => ({
					path: a,
					exists: existsSync(resolve(cwd, a)),
				}));

				const lines = [
					`# Pipeline Checkpoint: ${checkpoint.slug}`,
					``,
					`**Workflow:** ${checkpoint.workflow}`,
					`**Last stage:** ${checkpoint.stage}`,
					`**Saved at:** ${checkpoint.timestamp}`,
					`**Completed stages:** ${checkpoint.completedStages.join(" → ")}`,
				];

				if (checkpoint.plan) {
					lines.push(``, `**Plan summary:** ${checkpoint.plan}`);
				}

				lines.push(``, `## Artifacts`);
				for (const a of artifactStatus) {
					lines.push(`  ${a.exists ? "✓" : "✗"} ${a.path}`);
				}

				const missingCount = artifactStatus.filter((a) => !a.exists).length;
				if (missingCount > 0) {
					lines.push(``, `⚠ ${missingCount} artifact(s) missing — may need to re-run earlier stages.`);
				}

				if (checkpoint.metadata.notes) {
					lines.push(``, `**Notes:** ${checkpoint.metadata.notes}`);
				}

				// Suggest next stage
				const stageOrder = [
					"plan",
					"research",
					"synthesize",
					"draft",
					"cite",
					"verify",
					"review",
					"deliver",
				];
				const currentIdx = stageOrder.indexOf(checkpoint.stage);
				const nextStage = currentIdx >= 0 && currentIdx < stageOrder.length - 1
					? stageOrder[currentIdx + 1]
					: null;
				if (nextStage) {
					lines.push(``, `**Resume from:** ${nextStage}`);
				}

				return { content: [{ type: "text", text: lines.join("\n") }], details: checkpoint };
			} catch (err: any) {
				return {
					content: [
						{
							type: "text",
							text: `Error reading checkpoint: ${err.message}`,
						},
					], details: undefined,
				};
			}
		},
	});
}
