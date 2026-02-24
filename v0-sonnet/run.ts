import { resolve } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const startTime = Date.now();
const appDir = resolve("app");
const promptPath = resolve("../prompt.md");

// Ensure app directory exists
await Bun.spawn(["mkdir", "-p", appDir]).exited;

// Read the shared PRD
const prd = await Bun.file(promptPath).text();

const prompt = `You are building a full-stack app called "Mood Radio" from scratch.

Build EVERYTHING described in the PRD below. The project root is: ${appDir}

Create the complete Rust backend (Axum) and SolidJS frontend in this directory.
When done, ensure ALL of these pass:
- cargo fmt --check
- cargo clippy -- -D warnings
- cargo build
- cargo test
- cd web && bun install && bun run build

<prd>
${prd}
</prd>`;

console.log("=== v0-sonnet: Bare Prompt (Sonnet) ===");
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
		model: "claude-sonnet-4-6",
		cwd: appDir,
		env,
		allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Task"],
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
		settingSources: [],
		systemPrompt: { type: "preset", preset: "claude_code" },
		additionalDirectories: [appDir],
	},
})) {
	messages.push(msg);

	// Stream key events
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
	approach: "v0-sonnet",
	model: "claude-sonnet-4-6",
	cost_usd: result?.subtype === "success" ? result.total_cost_usd : 0,
	duration_ms: elapsed,
	duration_human: `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`,
	turns: result?.subtype === "success" ? result.num_turns : 0,
	status: result?.subtype ?? "unknown",
};

console.log("\n=== v0-sonnet Result ===");
console.log(JSON.stringify(summary, null, 2));

await Bun.write(resolve("result.json"), JSON.stringify(summary, null, 2));
