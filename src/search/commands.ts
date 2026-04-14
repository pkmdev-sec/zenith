import { getPiWebAccessStatus } from "../pi/web-access.js";
import { printInfo } from "../ui/terminal.js";

export function printSearchStatus(): void {
	const status = getPiWebAccessStatus();
	printInfo("Managed by: pi-web-access");
	printInfo(`Search route: ${status.routeLabel}`);
	printInfo(`Request route: ${status.requestProvider}`);
	printInfo(`Perplexity API configured: ${status.perplexityConfigured ? "yes" : "no"}`);
	printInfo(`Gemini API configured: ${status.geminiApiConfigured ? "yes" : "no"}`);
	printInfo(`Browser profile: ${status.chromeProfile ?? "default Chromium profile"}`);
	printInfo(`Config path: ${status.configPath}`);
}
