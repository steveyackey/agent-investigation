import { resolve } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const startTime = Date.now();
const appDir = resolve("app");
const promptPath = resolve("../vague-prompt.md");

// Ensure app directory exists
await Bun.spawn(["mkdir", "-p", appDir]).exited;

const prompt = await Bun.file(promptPath).text();

console.log("=== vague-sdk: SDK Opus, Vague Prompt, All Tools ===");
console.log(`App dir: ${appDir}`);
console.log(`Prompt length: ${prompt.length} chars`);
console.log("Starting...\n");

// Strip CLAUDECODE env var to allow nested invocation
const env = { ...process.env };
delete env.CLAUDECODE;

const messages: SDKMessage[] = [];

for await (const msg of query({
	prompt,
	options: {
		model: "claude-opus-4-6",
		cwd: appDir,
		env,
		// All tools enabled — no allowedTools restriction
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
		settingSources: [],
		systemPrompt: { type: "preset", preset: "claude_code" },
		additionalDirectories: [appDir],
	},
})) {
	messages.push(msg);

	if (msg.type === "assistant" && msg.message?.content) {
		for (const block of msg.message.content) {
			if (block.type === "text") {
				process.stdout.write(block.text);
			}
		}
	}

	if (msg.type === "result") {
		process.stdout.write(`\n${JSON.stringify(msg)}\n`);
	}
}

const result = messages.find(
	(m): m is Extract<SDKMessage, { type: "result" }> => m.type === "result",
);

const elapsed = Date.now() - startTime;

const summary = {
	approach: "vague-sdk",
	model: "claude-opus-4-6",
	cost_usd: result?.subtype === "success" ? result.total_cost_usd : 0,
	duration_ms: elapsed,
	duration_human: `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`,
	turns: result?.subtype === "success" ? result.num_turns : 0,
	status: result?.subtype ?? "unknown",
};

console.log("\n=== vague-sdk Result ===");
console.log(JSON.stringify(summary, null, 2));

await Bun.write(resolve("result.json"), JSON.stringify(summary, null, 2));
