import { resolve } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const startTime = Date.now();
const appDir = resolve("app");
const promptPath = resolve("../prompt.md");
const skillPath = resolve("../frontend-design-skill.md");

// Ensure app directory exists
await Bun.spawn(["mkdir", "-p", appDir]).exited;

// Read the shared PRD and skill
const prd = await Bun.file(promptPath).text();
const skill = await Bun.file(skillPath).text();

const prompt = `You are building a full-stack app called "Mood Radio" from scratch.

Build EVERYTHING described in the PRD below. The project root is: ${appDir}

Create the complete Rust backend (Axum) and SolidJS frontend in this directory.
When done, ensure ALL of these pass:
- cargo fmt --check
- cargo clippy -- -D warnings
- cargo build
- cargo test
- cd web && bun install && bun run build

IMPORTANT: When building the frontend, follow the design skill guidelines below.
The frontend should be visually distinctive, polished, and production-grade.
Avoid generic AI aesthetics. Make bold design choices.

<design-skill>
${skill}
</design-skill>

STRATEGY: You have access to the full suite of tools including agent teams,
subagents (Task tool), TodoWrite for planning, and all collaboration tools. Use whatever
combination helps you finish the work quickly and with high quality. Consider:

- Spawning subagents (Task tool) to work on backend and frontend in parallel
- Using TodoWrite to plan and track your work
- Using teams (TeamCreate) if you want coordinated agents working on different parts
- Using WebSearch/WebFetch if you need to look up latest API docs or patterns

Be creative with your tool usage. The goal is speed and quality — use every tool at
your disposal to build this as efficiently as possible.

<prd>
${prd}
</prd>`;

console.log("=== v0-sonnet-skill-teams: Skill + All Tools (Sonnet) ===");
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
		// All tools enabled
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
	approach: "v0-sonnet-skill-teams",
	model: "claude-sonnet-4-6",
	cost_usd: result?.subtype === "success" ? result.total_cost_usd : 0,
	duration_ms: elapsed,
	duration_human: `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`,
	turns: result?.subtype === "success" ? result.num_turns : 0,
	status: result?.subtype ?? "unknown",
};

console.log("\n=== v0-sonnet-skill-teams Result ===");
console.log(JSON.stringify(summary, null, 2));

await Bun.write(resolve("result.json"), JSON.stringify(summary, null, 2));
