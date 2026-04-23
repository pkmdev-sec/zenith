import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerAlphaTools } from "./research-tools/alpha.js";
import { registerExportTools } from "./research-tools/export.js";
import { registerHallucinationGuard } from "./research-tools/hallucination-guard.js";
import { registerEvidenceGraphTools } from "./research-tools/evidence-graph.js";
import { registerMemoryTools } from "./research-tools/memory.js";
import { installZenithHeader } from "./research-tools/header.js";
import { registerHelpCommand } from "./research-tools/help.js";
import { registerGateEnforcement } from "./research-tools/gate-enforcement.js";
import { registerOrchestrationTools } from "./research-tools/orchestration.js";
import { registerPipelineTools } from "./research-tools/pipeline.js";
import { registerInitCommand, registerOutputsCommand } from "./research-tools/project.js";
import { registerSemanticScholarTools } from "./research-tools/semantic-scholar.js";

export default function researchTools(pi: ExtensionAPI): void {
	const cache: { agentSummaryPromise?: Promise<{ agents: string[]; chains: string[] }> } = {};

	pi.on("session_start", async (_event, ctx) => {
		await installZenithHeader(pi, ctx, cache);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await installZenithHeader(pi, ctx, cache);
	});

	registerAlphaTools(pi);
	registerSemanticScholarTools(pi);
	registerHallucinationGuard(pi);
	registerExportTools(pi);
	registerOrchestrationTools(pi);
	registerPipelineTools(pi);
	registerMemoryTools(pi);
	registerEvidenceGraphTools(pi);
	registerGateEnforcement(pi);
	registerHelpCommand(pi);
	registerInitCommand(pi);
	registerOutputsCommand(pi);
}
