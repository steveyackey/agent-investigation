import { runQuery } from "../query.js";
import type { PhaseResult, PipelineConfig } from "../types.js";
import { existsMilestone, read, readMilestone } from "../workspace.js";

/**
 * v2 optimization: Adaptive research.
 * - "light" mode for small PRDs (<=2 milestones or <300 lines): no web search, focused output
 * - "full" mode for larger PRDs: full web research
 */
export async function research(config: PipelineConfig, milestoneIndex: number): Promise<PhaseResult> {
	const milestones = await read(config.workDir, "milestones.json");
	const parsed = JSON.parse(milestones);
	const milestone = parsed.milestones[milestoneIndex];
	const milestoneCount = parsed.milestones.length;

	const prdContent = await Bun.file(config.prdPath).text();
	const prdLines = prdContent.split("\n").length;

	// Determine research mode
	const isLight = milestoneCount <= 2 || prdLines < 300;

	// Gather context from prior milestones (only latest report, not all — reduces context bloat)
	let priorContext = "";
	if (milestoneIndex > 0) {
		const prevIdx = milestoneIndex - 1;
		if (await existsMilestone(config.workDir, prevIdx, "report.md")) {
			const report = await readMilestone(config.workDir, prevIdx, "report.md");
			priorContext = `## Previous Milestone (${parsed.milestones[prevIdx].version}) Report\n\n${report}`;
		}
	}

	const milestoneDir = `${config.workDir}/milestone-${milestoneIndex}`;

	if (isLight) {
		// Light research: no web, just codebase exploration + PRD analysis
		const prompt = `You are a research agent preparing for milestone ${milestone.version} — "${milestone.name}" of the ${parsed.project.name} project.

This is a small project. Write concise, practical research findings to: ${milestoneDir}/research.md

## Milestone Details

Version: ${milestone.version}
Name: ${milestone.name}
Features:
${milestone.features.map((f: string) => `- ${f}`).join("\n")}

Tests required:
${milestone.tests.map((t: string) => `- ${t}`).join("\n")}

## PRD Summary

<prd>
${prdContent}
</prd>

${priorContext ? `\n${priorContext}` : ""}

## Research Instructions (Light Mode)

1. Check the current codebase at ${config.repoRoot} to see what exists
2. Identify the key crates/libraries needed with version recommendations
3. Note any design decisions or gotchas
4. Keep it under 200 lines — this is a small project

Write findings to: ${milestoneDir}/research.md

Structure:
- ## Key Dependencies (crate name + version)
- ## Implementation Notes (brief, practical)
- ## Gotchas (if any)`;

		return runQuery({
			prompt,
			config,
			phase: `research-${milestoneIndex}`,
			tools: ["Read", "Write", "Glob", "Grep", "Bash"],
		});
	}

	// Full research mode (unchanged from v1)
	const prompt = `You are a research agent preparing for milestone ${milestone.version} — "${milestone.name}" of the ${parsed.project.name} project.

Your goal is to research best practices, crate/library choices, design patterns, and implementation strategies for this milestone's features. Write your findings to: ${milestoneDir}/research.md

## Milestone Details

Version: ${milestone.version}
Name: ${milestone.name}
Features:
${milestone.features.map((f: string) => `- ${f}`).join("\n")}

Tests required:
${milestone.tests.map((t: string) => `- ${t}`).join("\n")}

Docs required:
${milestone.docs.map((d: string) => `- ${d}`).join("\n")}

## Full PRD (for context)

<prd>
${prdContent}
</prd>

${priorContext}

## Current Codebase

The project root is at: ${config.repoRoot}
Explore what exists already (if anything) to understand the current state.

## Research Instructions

1. Search the web for best practices related to this milestone's features
2. Explore the current codebase to understand what already exists
3. For Rust crates, research the latest versions, API patterns, and common pitfalls
4. For each major feature, identify the recommended approach
5. Note any architectural decisions that need to be made
6. Consider how this milestone's work integrates with previous milestones

Write comprehensive research findings to: ${milestoneDir}/research.md

Structure the output as:
- ## Crate/Library Recommendations (with versions)
- ## Design Patterns
- ## Implementation Strategy (for each major feature)
- ## Risks and Considerations
- ## References`;

	return runQuery({
		prompt,
		config,
		phase: `research-${milestoneIndex}`,
		tools: ["Read", "Write", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"],
	});
}
