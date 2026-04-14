import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

export async function promptText(question: string, defaultValue = ""): Promise<string> {
	if (!input.isTTY || !output.isTTY) {
		throw new Error("zenith setup requires an interactive terminal.");
	}
	const rl = createInterface({ input, output });
	try {
		const suffix = defaultValue ? ` [${defaultValue}]` : "";
		const value = (await rl.question(`${question}${suffix}: `)).trim();
		return value || defaultValue;
	} finally {
		rl.close();
	}
}

export async function promptChoice(question: string, choices: string[], defaultIndex = 0): Promise<number> {
	console.log(question);
	for (const [index, choice] of choices.entries()) {
		const marker = index === defaultIndex ? "*" : " ";
		console.log(`  ${marker} ${index + 1}. ${choice}`);
	}
	const answer = await promptText("Select", String(defaultIndex + 1));
	const parsed = Number(answer);
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > choices.length) {
		return defaultIndex;
	}
	return parsed - 1;
}
