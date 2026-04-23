import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";

import {
	BROWSER_FALLBACK_PATHS,
	MERMAID_FALLBACK_PATHS,
	PANDOC_FALLBACK_PATHS,
	resolveExecutable,
} from "../system/executables.js";

export type PiRuntimeOptions = {
	appRoot: string;
	workingDir: string;
	sessionDir: string;
	zenithAgentDir: string;
	zenithVersion?: string;
	thinkingLevel?: string;
	explicitModelSpec?: string;
	oneShotPrompt?: string;
	initialPrompt?: string;
};

export function resolvePiPaths(appRoot: string) {
	return {
		piPackageRoot: resolve(appRoot, "node_modules", "@mariozechner", "pi-coding-agent"),
		piCliPath: resolve(appRoot, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"),
		promisePolyfillPath: resolve(appRoot, "dist", "system", "promise-polyfill.js"),
		promisePolyfillSourcePath: resolve(appRoot, "src", "system", "promise-polyfill.ts"),
		tsxLoaderPath: resolve(appRoot, "node_modules", "tsx", "dist", "loader.mjs"),
		researchToolsPath: resolve(appRoot, "extensions", "research-tools.ts"),
		promptTemplatePath: resolve(appRoot, "prompts"),
		systemPromptPath: resolve(appRoot, ".zenith", "SYSTEM.md"),
		piWorkspaceNodeModulesPath: resolve(appRoot, ".zenith", "npm", "node_modules"),
		nodeModulesBinPath: resolve(appRoot, "node_modules", ".bin"),
	};
}

export function validatePiInstallation(appRoot: string): string[] {
	const paths = resolvePiPaths(appRoot);
	const missing: string[] = [];

	if (!existsSync(paths.piCliPath)) missing.push(paths.piCliPath);
	if (!existsSync(paths.promisePolyfillPath)) {
		// Dev fallback: allow running from source without `dist/` build artifacts.
		const hasDevPolyfill = existsSync(paths.promisePolyfillSourcePath) && existsSync(paths.tsxLoaderPath);
		if (!hasDevPolyfill) missing.push(paths.promisePolyfillPath);
	}
	if (!existsSync(paths.researchToolsPath)) missing.push(paths.researchToolsPath);
	if (!existsSync(paths.promptTemplatePath)) missing.push(paths.promptTemplatePath);

	return missing;
}

export function buildPiArgs(options: PiRuntimeOptions): string[] {
	const paths = resolvePiPaths(options.appRoot);
	const args = [
		"--session-dir",
		options.sessionDir,
		"--extension",
		paths.researchToolsPath,
		"--prompt-template",
		paths.promptTemplatePath,
	];

	if (existsSync(paths.systemPromptPath)) {
		args.push("--system-prompt", readFileSync(paths.systemPromptPath, "utf8"));
	}

	if (options.explicitModelSpec) {
		args.push("--model", options.explicitModelSpec);
	}
	if (options.thinkingLevel) {
		args.push("--thinking", options.thinkingLevel);
	}
	if (options.oneShotPrompt) {
		args.push("-p", options.oneShotPrompt);
	} else if (options.initialPrompt) {
		args.push(options.initialPrompt);
	}

	return args;
}

// Env vars that collide with Zenith's single-model policy or its budget
// discipline. We strip these before spawning Pi so a user's ambient shell
// config (Claude Desktop, other Anthropic integrations) can't silently
// redirect Zenith's traffic to a different model, or inflate token limits
// past what the workspace rate plan can sustain.
const PI_ENV_BLOCKLIST = [
	"ANTHROPIC_MODEL",          // overrides our pinned model
	"ANTHROPIC_MAX_TOKENS",     // overrides Pi's default output cap
	"ANTHROPIC_SMALL_FAST_MODEL", // Claude Code sets this; can re-route "fast" calls
	"CLAUDE_MODEL",             // alt alias some tools use
];

function inheritedEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of PI_ENV_BLOCKLIST) {
		delete env[key];
	}
	return env;
}

export function buildPiEnv(options: PiRuntimeOptions): NodeJS.ProcessEnv {
	const paths = resolvePiPaths(options.appRoot);
	const zenithHome = dirname(options.zenithAgentDir);
	const zenithNpmPrefixPath = resolve(zenithHome, "npm-global");
	const zenithNpmBinPath = resolve(zenithNpmPrefixPath, "bin");

	const currentPath = process.env.PATH ?? "";
	const binEntries = [paths.nodeModulesBinPath, resolve(paths.piWorkspaceNodeModulesPath, ".bin"), zenithNpmBinPath];
	const binPath = binEntries.join(delimiter);

	return {
		...inheritedEnv(),
		PATH: `${binPath}${delimiter}${currentPath}`,
		ZENITH_VERSION: options.zenithVersion,
		ZENITH_SESSION_DIR: options.sessionDir,
		ZENITH_MEMORY_DIR: resolve(dirname(options.zenithAgentDir), "memory"),
		ZENITH_NODE_EXECUTABLE: process.execPath,
		ZENITH_BIN_PATH: resolve(options.appRoot, "bin", "zenith.js"),
		// Exposed for consumers/integrations that inspect the Zenith env. Internal
		// npm prefix handling uses NPM_CONFIG_PREFIX/npm_config_prefix below.
		ZENITH_NPM_PREFIX: zenithNpmPrefixPath,
		// Ensure the Pi child process uses Zenith's agent dir for auth/models/settings.
		PI_CODING_AGENT_DIR: options.zenithAgentDir,
		PANDOC_PATH: process.env.PANDOC_PATH ?? resolveExecutable("pandoc", PANDOC_FALLBACK_PATHS),
		PI_HARDWARE_CURSOR: process.env.PI_HARDWARE_CURSOR ?? "1",
		PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK ?? "1",
		MERMAID_CLI_PATH: process.env.MERMAID_CLI_PATH ?? resolveExecutable("mmdc", MERMAID_FALLBACK_PATHS),
		PUPPETEER_EXECUTABLE_PATH:
			process.env.PUPPETEER_EXECUTABLE_PATH ?? resolveExecutable("google-chrome", BROWSER_FALLBACK_PATHS),
		// Always pin npm's global prefix to the Zenith workspace. npm injects
		// lowercase config vars into child processes, which would otherwise leak
		// the caller's global prefix into Pi.
		NPM_CONFIG_PREFIX: zenithNpmPrefixPath,
		npm_config_prefix: zenithNpmPrefixPath,
	};
}
