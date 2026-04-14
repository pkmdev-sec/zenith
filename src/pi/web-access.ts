import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type PiWebSearchProvider = "auto" | "perplexity" | "gemini";

export type PiWebAccessConfig = Record<string, unknown> & {
	provider?: PiWebSearchProvider;
	searchProvider?: PiWebSearchProvider;
	perplexityApiKey?: string;
	geminiApiKey?: string;
	chromeProfile?: string;
};

export type PiWebAccessStatus = {
	configPath: string;
	searchProvider: PiWebSearchProvider;
	requestProvider: PiWebSearchProvider;
	perplexityConfigured: boolean;
	geminiApiConfigured: boolean;
	chromeProfile?: string;
	routeLabel: string;
	note: string;
};

export function getPiWebSearchConfigPath(home = process.env.HOME ?? homedir()): string {
	return resolve(home, ".zenith", "web-search.json");
}

function normalizeProvider(value: unknown): PiWebSearchProvider | undefined {
	return value === "auto" || value === "perplexity" || value === "gemini" ? value : undefined;
}

function normalizeNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function loadPiWebAccessConfig(configPath = getPiWebSearchConfigPath()): PiWebAccessConfig {
	if (!existsSync(configPath)) {
		return {};
	}

	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as PiWebAccessConfig;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function formatRouteLabel(provider: PiWebSearchProvider): string {
	switch (provider) {
		case "perplexity":
			return "Perplexity";
		case "gemini":
			return "Gemini";
		default:
			return "Auto";
	}
}

function formatRouteNote(provider: PiWebSearchProvider): string {
	switch (provider) {
		case "perplexity":
			return "Pi web-access will use Perplexity for search.";
		case "gemini":
			return "Pi web-access will use Gemini API or Gemini Browser.";
		default:
			return "Pi web-access will try Perplexity, then Gemini API, then Gemini Browser.";
	}
}

export function getPiWebAccessStatus(
	config: PiWebAccessConfig = loadPiWebAccessConfig(),
	configPath = getPiWebSearchConfigPath(),
): PiWebAccessStatus {
	const searchProvider = normalizeProvider(config.searchProvider) ?? "auto";
	const requestProvider = normalizeProvider(config.provider) ?? searchProvider;
	const perplexityConfigured = Boolean(normalizeNonEmptyString(config.perplexityApiKey));
	const geminiApiConfigured = Boolean(normalizeNonEmptyString(config.geminiApiKey));
	const chromeProfile = normalizeNonEmptyString(config.chromeProfile);
	const effectiveProvider = searchProvider;

	return {
		configPath,
		searchProvider,
		requestProvider,
		perplexityConfigured,
		geminiApiConfigured,
		chromeProfile,
		routeLabel: formatRouteLabel(effectiveProvider),
		note: formatRouteNote(effectiveProvider),
	};
}

export function formatPiWebAccessDoctorLines(
	status: PiWebAccessStatus = getPiWebAccessStatus(),
): string[] {
	return [
		"web access: pi-web-access",
		`  search route: ${status.routeLabel}`,
		`  request route: ${status.requestProvider}`,
		`  perplexity api: ${status.perplexityConfigured ? "configured" : "not configured"}`,
		`  gemini api: ${status.geminiApiConfigured ? "configured" : "not configured"}`,
		`  browser profile: ${status.chromeProfile ?? "default Chromium profile"}`,
		`  config path: ${status.configPath}`,
		`  note: ${status.note}`,
	];
}
