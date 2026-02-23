import { runQuery } from "../query.js";
import type { PhaseResult, PipelineConfig, VerificationCheck } from "../types.js";
import { existsMilestone, read, readMilestone } from "../workspace.js";

/**
 * v2 optimization: Root-cause grouping.
 * Groups compiler errors by file so the agent can fix all errors in a file at once
 * instead of treating each error line as a separate issue.
 */
function groupErrorsByFile(checks: VerificationCheck[]): string {
	const fileErrors = new Map<string, string[]>();
	const otherErrors: string[] = [];

	for (const check of checks) {
		if (!check.passed && check.output) {
			// Parse Rust compiler errors: "error[E0xxx]: ... --> path/to/file.rs:line:col"
			const lines = check.output.split("\n");
			let currentFile: string | null = null;
			const currentBlock: string[] = [];

			for (const line of lines) {
				const fileMatch = line.match(/--> (.+\.rs):\d+:\d+/);
				if (fileMatch?.[1]) {
					// Flush previous block
					if (currentFile && currentBlock.length > 0) {
						const existing = fileErrors.get(currentFile) ?? [];
						existing.push(currentBlock.join("\n"));
						fileErrors.set(currentFile, existing);
					}
					currentFile = fileMatch[1];
					currentBlock.length = 0;
				}
				currentBlock.push(line);
			}

			// Flush last block
			if (currentFile && currentBlock.length > 0) {
				const existing = fileErrors.get(currentFile) ?? [];
				existing.push(currentBlock.join("\n"));
				fileErrors.set(currentFile, existing);
			} else if (currentBlock.length > 0) {
				otherErrors.push(currentBlock.join("\n"));
			}
		}
	}

	if (fileErrors.size === 0) return "";

	const sections: string[] = [];
	for (const [file, errors] of fileErrors) {
		sections.push(`### ${file} (${errors.length} error${errors.length > 1 ? "s" : ""})\n\n${errors.join("\n\n")}`);
	}

	if (otherErrors.length > 0) {
		sections.push(`### Other Errors\n\n${otherErrors.join("\n\n")}`);
	}

	return `## Errors Grouped by File\n\n${sections.join("\n\n---\n\n")}`;
}

export async function fix(config: PipelineConfig, milestoneIndex: number): Promise<PhaseResult> {
	const milestones = await read(config.workDir, "milestones.json");
	const parsed = JSON.parse(milestones);
	const milestone = parsed.milestones[milestoneIndex];
	const milestoneDir = `${config.workDir}/milestone-${milestoneIndex}`;

	// Load verification results — these tell us exactly what failed
	const verificationStatusJson = await readMilestone(config.workDir, milestoneIndex, "verification-status.json");
	const verificationStatus = JSON.parse(verificationStatusJson);
	const failedChecks: VerificationCheck[] = verificationStatus.checks.filter((c: VerificationCheck) => !c.passed);

	// Load detailed verification results for full error context
	let verificationResults = "";
	if (await existsMilestone(config.workDir, milestoneIndex, "verification-results.md")) {
		verificationResults = await readMilestone(config.workDir, milestoneIndex, "verification-results.md");
	}

	// Load the plan for reference (but not the full research — keep context tight)
	const planMd = await readMilestone(config.workDir, milestoneIndex, "plan.md");

	// Load steps.json to identify which steps are related to failures
	let stepsContext = "";
	if (await existsMilestone(config.workDir, milestoneIndex, "steps.json")) {
		const stepsTxt = await readMilestone(config.workDir, milestoneIndex, "steps.json");
		const steps = JSON.parse(stepsTxt);
		// Only include steps whose names appear in failure output
		const failureText = failedChecks.map((c) => `${c.name} ${c.output}`).join(" ").toLowerCase();
		const relevantSteps = steps.filter(
			(s: { id: number; name: string; files: string[] }) =>
				failureText.includes(`step ${s.id}`) ||
				failureText.includes(s.name.toLowerCase()) ||
				s.files.some((f: string) => failureText.includes(f.toLowerCase())),
		);
		if (relevantSteps.length > 0) {
			stepsContext = relevantSteps
				.map(
					(s: { id: number; name: string; description: string; validation: string; files: string[] }) =>
						`### Step ${s.id}: ${s.name}\nFiles: ${s.files.join(", ")}\nValidation: \`${s.validation}\``,
				)
				.join("\n\n");
		}
	}

	const failureSummary = failedChecks
		.map((c) => `### ${c.name}\n**Output:** ${c.output}`)
		.join("\n\n");

	// v2 optimization: Group errors by file for root-cause analysis
	const groupedErrors = groupErrorsByFile(failedChecks);

	const prompt = `You are a fix agent for milestone ${milestone.version} — "${milestone.name}" of the ${parsed.project.name} project.

## YOUR MISSION

The previous execution attempt passed most checks but **${failedChecks.length} check(s) failed**. The existing code is mostly correct — do NOT rewrite working code. Your job is to make targeted fixes to resolve ONLY the failures listed below.

## Project Root
${config.repoRoot}

## Failed Checks (${failedChecks.length} of ${verificationStatus.checks.length} total)

${failureSummary}

${groupedErrors ? `\n${groupedErrors}\n` : ""}

## Detailed Verification Output

${verificationResults}

## Implementation Plan (for reference)

${planMd}

${stepsContext ? `## Relevant Steps\n\n${stepsContext}` : ""}

## Fix Protocol

1. **Read the failing code first** — use Glob/Grep/Read to understand what's already there
2. **Fix all errors in a file together** — if a file has multiple errors, fix them all in one pass (they often share a root cause)
3. **Make minimal, targeted edits** — use the Edit tool, not Write, for existing files
4. **Do NOT rewrite files that are working** — the passing checks confirm most code is correct
5. **Run the specific failing check after each fix** to verify it passes
6. **Run \`cargo fmt\` if formatting is a failure** — this is a one-command fix
7. **Run \`cargo test\` at the end** to confirm no regressions
8. **If a test file is missing, create it** — but don't restructure existing test files

## MANDATORY: Verify All Checks Before Finishing

Before writing execution-results.md, run:
\`\`\`bash
cargo fmt && cargo fmt --check && cargo clippy -- -D warnings && cargo build && cargo test
\`\`\`
Fix any remaining failures. Only write results when ALL pass.

## After Fixes

When all fixes are applied, write an updated summary to: ${milestoneDir}/execution-results.md

Include:
- What was fixed
- Files modified
- Commands that should now pass`;

	return runQuery({
		prompt,
		config,
		phase: `fix-${milestoneIndex}`,
		tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
	});
}
