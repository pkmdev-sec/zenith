import { isLoggedIn as isAlphaLoggedIn, login as loginAlpha } from "@companion-ai/alpha-hub/lib";

import { getPiWebAccessStatus } from "../pi/web-access.js";
import { normalizeZenithSettings } from "../pi/settings.js";
import type { ThinkingLevel } from "../pi/settings.js";
import { getCurrentModelSpec, runModelSetup } from "../model/commands.js";
import { PANDOC_FALLBACK_PATHS, resolveExecutable } from "../system/executables.js";
import { setupPreviewDependencies } from "./preview.js";
import { printInfo, printSection, printSuccess } from "../ui/terminal.js";

type SetupOptions = {
	settingsPath: string;
	bundledSettingsPath: string;
	authPath: string;
	workingDir: string;
	sessionDir: string;
	appRoot: string;
	defaultThinkingLevel?: ThinkingLevel;
};

function isInteractiveTerminal(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function printNonInteractiveSetupGuidance(): void {
	printInfo("Non-interactive terminal. Use explicit commands:");
	printInfo("  zenith model login <provider>");
	printInfo("  zenith model set <provider/model>");
	printInfo("  # or configure API keys via env vars/auth.json and rerun `zenith model list`");
	printInfo("  zenith alpha login");
	printInfo("  zenith doctor");
}

export async function runSetup(options: SetupOptions): Promise<void> {
	if (!isInteractiveTerminal()) {
		printNonInteractiveSetupGuidance();
		return;
	}

	await runModelSetup(options.settingsPath, options.authPath);

	if (!isAlphaLoggedIn()) {
		await loginAlpha();
		printSuccess("alphaXiv login complete");
	}

	const result = setupPreviewDependencies();
	printSuccess(result.message);

	normalizeZenithSettings(
		options.settingsPath,
		options.bundledSettingsPath,
		options.defaultThinkingLevel ?? "medium",
		options.authPath,
	);

	printSection("Ready");
	printInfo(`Model: ${getCurrentModelSpec(options.settingsPath) ?? "not set"}`);
	printInfo(`alphaXiv: ${isAlphaLoggedIn() ? "configured" : "not configured"}`);
	printInfo(`Preview: ${resolveExecutable("pandoc", PANDOC_FALLBACK_PATHS) ? "configured" : "not configured"}`);
	printInfo(`Web: ${getPiWebAccessStatus().routeLabel}`);
}
