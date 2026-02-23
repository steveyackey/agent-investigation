import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { runQuery } from "../query.js";
import type { PhaseResult, PipelineConfig } from "../types.js";
import { existsMilestone, read, readMilestone } from "../workspace.js";

const agents: Record<string, AgentDefinition> = {
	worker: {
		description: "General-purpose worker agent for reading, writing, editing files, and running commands.",
		prompt: "You are a worker agent. Implement the changes described in your instructions carefully and thoroughly.",
		tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
		model: "inherit",
	},
	reviewer: {
		description: "Read-only code review agent for checking correctness and style.",
		prompt: "You are a code reviewer. Review changes for correctness, style, potential bugs, and Rust conventions.",
		tools: ["Read", "Glob", "Grep"],
		model: "inherit",
	},
	tester: {
		description: "Testing agent focused on running tests and validation.",
		prompt: "You are a testing agent. Run tests and validate changes work correctly.",
		tools: ["Bash", "Read", "Glob", "Grep"],
		model: "inherit",
	},
};

const FRONTEND_KEYWORDS = ["dashboard", "solidjs", "solid-ui", "frontend", "ui", "vite", "tsx", "jsx", "component"];

function isFrontendMilestone(milestone: { name: string; features: string[] }): boolean {
	const text = `${milestone.name} ${milestone.features.join(" ")}`.toLowerCase();
	return FRONTEND_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * v2 optimizations applied:
 * 1. Lint gate: mandate cargo fmt + clippy + build + test before declaring done
 * 2. Leaner context: don't include full PRD when milestones.json has everything
 * 3. Self-check: agent runs full build+test before completion
 */
export async function execute(config: PipelineConfig, milestoneIndex: number): Promise<PhaseResult> {
	const milestones = await read(config.workDir, "milestones.json");
	const parsed = JSON.parse(milestones);
	const milestone = parsed.milestones[milestoneIndex];
	const planMd = await readMilestone(config.workDir, milestoneIndex, "plan.md");
	const researchMd = await readMilestone(config.workDir, milestoneIndex, "research.md");
	const milestoneDir = `${config.workDir}/milestone-${milestoneIndex}`;
	const hasFrontend = isFrontendMilestone(milestone);

	let stepsTxt = "";
	if (await existsMilestone(config.workDir, milestoneIndex, "steps.json")) {
		stepsTxt = await readMilestone(config.workDir, milestoneIndex, "steps.json");
	}

	// Check for prior execution failures (for retry context)
	let priorFailures = "";
	if (await existsMilestone(config.workDir, milestoneIndex, "verification-results.md")) {
		priorFailures = await readMilestone(config.workDir, milestoneIndex, "verification-results.md");
	}

	// v2 optimization: Only include latest prior milestone report (not all)
	let priorContext = "";
	if (milestoneIndex > 0) {
		const prevIdx = milestoneIndex - 1;
		if (await existsMilestone(config.workDir, prevIdx, "report.md")) {
			const report = await readMilestone(config.workDir, prevIdx, "report.md");
			priorContext = `## Previous Milestone (${parsed.milestones[prevIdx].version}) Report\n\n${report}`;
		}
	}

	const promptParts: string[] = [
		`You are implementing milestone ${milestone.version} — "${milestone.name}" of the ${parsed.project.name} project.`,
		"Your job is to implement ALL the code, tests, and documentation for this milestone.",
		`## Project Root\n${config.repoRoot}\n\nAll file operations happen here. This is the Rust project root (where Cargo.toml lives or will be created).`,
		`## Implementation Plan\n${planMd}`,
		`## Research Findings\n${researchMd}`,
	];

	// v2 optimization: Only include milestone details from milestones.json, NOT full PRD
	promptParts.push(
		`## Milestone Requirements\n\nFeatures:\n${milestone.features.map((f: string) => `- ${f}`).join("\n")}\n\nTests:\n${milestone.tests.map((t: string) => `- ${t}`).join("\n")}`,
	);

	if (stepsTxt) {
		const steps = JSON.parse(stepsTxt);
		const stepsWithValidation = steps
			.map(
				(s: { id: number; name: string; description: string; validation: string; files: string[] }) =>
					`### Step ${s.id}: ${s.name}\n${s.description}\n\n**Files:** ${s.files.join(", ")}\n**Validation (MUST pass before next step):** \`${s.validation}\``,
			)
			.join("\n\n---\n\n");
		promptParts.push(
			`## Implementation Steps\n\n${stepsWithValidation}\n\n## CRITICAL: Step Validation Protocol\n\nAfter completing each step, you MUST:\n1. Run the step's validation command\n2. If it fails, fix the issue immediately\n3. Re-run validation until it passes\n4. Only then proceed to the next step\n\nDo NOT batch steps. Do NOT skip validation. Each step's validation command is a gate.`,
		);
	}

	if (priorFailures) {
		promptParts.push(
			`## IMPORTANT: Prior Verification Failures\n\nThe previous execution attempt failed verification. Here are the failure details:\n\n${priorFailures}\n\nFix ALL of these issues in this attempt. Do not repeat the same mistakes.`,
		);
	}

	if (priorContext) {
		promptParts.push(priorContext);
	}

	const rules = [
		"1. Write clean, idiomatic Rust code following standard conventions",
		"2. Use the project structure defined in the plan",
		"3. After implementing each logical unit, run `cargo build` to catch compilation errors early",
		"4. Run `cargo fmt` regularly to keep formatting consistent",
		"5. Write tests alongside implementation — don't leave them for the end",
		"6. Write documentation as specified in the milestone requirements",
		"7. When creating new files, use the Write tool. When modifying existing files, use the Edit tool.",
		'8. You have access to subagents: delegate to "worker" for parallel file operations, "reviewer" for code review, "tester" for running test suites',
	];
	promptParts.push(`## Execution Rules\n\n${rules.join("\n")}`);

	if (hasFrontend) {
		promptParts.push(
			[
				"## IMPORTANT: Frontend Work — Use the frontend-design Skill",
				"",
				"This milestone includes frontend/UI work. For ALL frontend components, pages, views, and UI code:",
				'- Use the Skill tool with skill: "frontend-design" to generate frontend code',
				"- This skill creates distinctive, production-grade interfaces with high design quality",
				"- Use it for: dashboard views, component design, layouts, styling, SolidJS components",
				"- The skill avoids generic AI aesthetics and produces polished, creative code",
				"- Invoke it BEFORE writing any .tsx/.jsx/.css files — let the skill drive the UI implementation",
				"- You can provide context about what the component should do and the skill will handle the design",
			].join("\n"),
		);
	}

	// v2 optimization: Mandatory self-check (lint gate) before declaring done
	promptParts.push(
		[
			"## MANDATORY: Pre-Completion Verification (DO NOT SKIP)",
			"",
			"Before writing your execution results, you MUST run ALL of these commands and fix any failures:",
			"",
			"```bash",
			"cargo fmt",
			"cargo fmt --check",
			"cargo clippy -- -D warnings",
			"cargo build",
			"cargo test",
			"```",
			"",
			"If ANY of these commands fail, fix the issue immediately and re-run ALL commands.",
			"Do NOT write execution-results.md until ALL five commands pass with exit code 0.",
			"This is the #1 most important rule — a clean build gate prevents expensive retry cycles.",
		].join("\n"),
	);

	promptParts.push(
		[
			"## After Implementation (ONLY after all checks pass)",
			"",
			`When all implementation AND verification is complete, write a summary to: ${milestoneDir}/execution-results.md`,
			"",
			"The summary should include:",
			"- Files created/modified",
			"- Features implemented",
			"- Tests written",
			"- Pre-completion check results (all should say PASSED)",
			"- Any known issues or incomplete items",
		].join("\n"),
	);

	const prompt = promptParts.join("\n\n");

	const tools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Task"];
	if (hasFrontend) {
		tools.push("Skill");
	}

	return runQuery({
		prompt,
		config,
		phase: `execute-${milestoneIndex}`,
		tools,
		agents,
	});
}
