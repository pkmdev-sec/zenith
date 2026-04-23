import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export function getZenithHome(): string {
	return resolve(process.env.ZENITH_HOME ?? homedir(), ".zenith");
}

export function getZenithAgentDir(home = getZenithHome()): string {
	return resolve(home, "agent");
}

export function getZenithMemoryDir(home = getZenithHome()): string {
	return resolve(home, "memory");
}

export function getZenithStateDir(home = getZenithHome()): string {
	return resolve(home, ".state");
}

export function getDefaultSessionDir(home = getZenithHome()): string {
	return resolve(home, "sessions");
}

export function getBootstrapStatePath(home = getZenithHome()): string {
	return resolve(getZenithStateDir(home), "bootstrap.json");
}

export function getSwarmWorkRoot(home = getZenithHome()): string {
	return resolve(home, "swarm-work");
}

export function getSwarmWorkDir(slug: string, home = getZenithHome()): string {
	return resolve(getSwarmWorkRoot(home), slug);
}

export function getSwarmCheckpointDir(slug: string, home = getZenithHome()): string {
	return resolve(getSwarmWorkDir(slug, home), "checkpoints");
}

export function ensureZenithHome(home = getZenithHome()): void {
	for (const dir of [
		home,
		getZenithAgentDir(home),
		getZenithMemoryDir(home),
		getZenithStateDir(home),
		getDefaultSessionDir(home),
	]) {
		mkdirSync(dir, { recursive: true });
	}
}
