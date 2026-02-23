# Optimization Playbook

Concrete changes ranked by impact-to-effort ratio. Each optimization includes estimated savings, implementation complexity, and code-level guidance.

---

## Tier 1: High Impact, Low Effort

### 1. Pre-Verification Lint Gate

**Savings: ~$27-35 | Effort: 30 minutes | Priority: Critical**

Add a mandatory lint step at the end of the execute phase, before verification begins. This eliminates the entire category of formatting/linting retries.

**Option A: Prompt-based (simplest)**

Add to the execute phase system prompt in `phases/execute.ts`:

```
CRITICAL: Before declaring this milestone implementation complete, you MUST:
1. Run `cargo fmt` (not --check, actually format the code)
2. Run `cargo clippy -- -D warnings` and fix ALL warnings
3. Run `cargo build` to verify compilation
4. Run `cargo test` to verify tests pass
Only after all four commands succeed with zero errors may you declare completion.
```

**Option B: Pipeline-enforced (more reliable)**

Add a post-execute, pre-verify step in `pipeline.ts`:

```typescript
// After execute(), before verify():
const lintResult = await runLintGate(config);
if (!lintResult.passed) {
  // Feed lint errors back to execute agent for one more pass
  await runQuery({ prompt: `Fix these lint issues:\n${lintResult.output}`, ... });
}
```

### 2. Adaptive Research Budgets

**Savings: ~$15-25 | Effort: 1-2 hours | Priority: High**

Tag milestones in the PRD with research intensity. The parse phase extracts this, and the research phase adjusts its scope.

**Implementation:**

In `milestones.json`, add a field:
```json
{
  "id": 5,
  "research_level": "light",  // "full" | "light" | "skip"
  ...
}
```

In `phases/research.ts`, branch on this:
```typescript
if (milestone.research_level === "skip") {
  // Write a minimal research.md noting this is an incremental milestone
  return;
}

if (milestone.research_level === "light") {
  // Shorter prompt: "Review the codebase for relevant patterns.
  //  Do NOT do web research. Focus on identifying existing patterns
  //  to reuse. Keep output under 300 lines."
}
```

**Heuristic for auto-detection:** If a milestone introduces no new languages, frameworks, or external services compared to its dependencies, use "light". If it only extends existing features, use "skip".

### 3. Run `cargo build` + `cargo test` in Execute Phase

**Savings: ~$10-15 | Effort: 15 minutes | Priority: High**

The execute phase should validate its own work before handing off to verify. Add to the execute prompt:

```
After implementing all steps, run:
  cargo build 2>&1
  cargo test 2>&1
If either fails, fix the issues before declaring the milestone complete.
```

This catches compilation errors and test failures during the execute phase (where the agent has full context) instead of during the fix phase (where context must be reconstructed).

---

## Tier 2: Medium Impact, Medium Effort

### 4. Prior Context Summarization

**Savings: ~$10-15 | Effort: 2-3 hours | Priority: Medium**

Instead of including ALL prior milestone reports in each prompt, maintain a rolling summary.

**Implementation:**

After each milestone's report phase, add a summarization step:

```typescript
// In pipeline.ts, after report phase:
const summaryPrompt = `
  Here is the current project context summary:
  ${existingSummary}

  Here is the report from milestone ${milestone.version}:
  ${report}

  Update the project context summary to incorporate the new milestone.
  Keep it under 2000 words. Focus on: architecture decisions, patterns established,
  key file paths, what's been built, and gotchas discovered.
`;
const updatedSummary = await runQuery({ prompt: summaryPrompt, model: "haiku", ... });
await write(config.workDir, "project-summary.md", updatedSummary);
```

Then in research/architect/execute phases, include only `project-summary.md` + the immediately preceding milestone's report, instead of all N reports.

**Token savings calculation:**
- Each report: ~800-1200 tokens
- By milestone 5: 5 reports = ~5000 tokens per phase call
- With summary: ~800 tokens (the summary) + ~1200 (latest report) = ~2000 tokens
- Savings: ~3000 tokens × 5 phases × 5 milestones = ~75,000 tokens
- At ~$0.003/1K tokens: ~$0.23 saved in input tokens alone
- Real savings come from reduced context confusion and faster responses

### 5. Per-Phase Cost Tracking

**Savings: Indirect (enables future optimization) | Effort: 1 hour | Priority: Medium**

Track cost per phase to identify exactly where money is spent.

```typescript
// In pipeline.ts, after each phase:
const phaseResult = await runPhase(...);
state.milestones[i].phases.push({
  name: phaseName,
  cost: phaseResult.cost,
  duration_ms: Date.now() - phaseStart,
  tokens_in: phaseResult.usage?.input_tokens,
  tokens_out: phaseResult.usage?.output_tokens,
});
```

This data enables:
- Identifying which phases are unexpectedly expensive
- Correlating cost with retry counts
- Model selection optimization (see #8)

### 6. Root-Cause Grouping in Fix Phase

**Savings: ~$5-10 | Effort: 2 hours | Priority: Medium**

The fix phase currently receives a flat list of failed checks. When multiple failures share a root cause (e.g., type errors in one file), the agent treats each as independent.

**Implementation:**

In `phases/fix.ts`, add pre-processing:

```typescript
// Group failures by file path
const failuresByFile = new Map<string, FailedCheck[]>();
for (const check of failedChecks) {
  const files = extractFilePathsFromError(check.output);
  for (const file of files) {
    failuresByFile.get(file)?.push(check) ?? failuresByFile.set(file, [check]);
  }
}

// Add grouping guidance to the prompt
const groupingHint = Array.from(failuresByFile.entries())
  .filter(([_, checks]) => checks.length > 1)
  .map(([file, checks]) => `${file}: ${checks.length} errors — likely a shared root cause`)
  .join('\n');
```

### 7. Phase Timeouts and Token Budgets

**Savings: Risk mitigation | Effort: 1 hour | Priority: Medium**

Add circuit breakers to prevent runaway agents:

```typescript
const PHASE_LIMITS = {
  research: { timeout_ms: 300_000, max_cost: 8.0 },
  architect: { timeout_ms: 300_000, max_cost: 5.0 },
  execute:   { timeout_ms: 600_000, max_cost: 20.0 },
  verify:    { timeout_ms: 180_000, max_cost: 3.0 },
  fix:       { timeout_ms: 300_000, max_cost: 10.0 },
  report:    { timeout_ms: 120_000, max_cost: 3.0 },
};
```

---

## Tier 3: Lower Impact, Higher Effort

### 8. Model Routing per Phase

**Savings: ~$15-25 | Effort: 3-4 hours | Priority: Medium-Low**

See [Model Selection Strategy](06-model-strategy.md) for full details.

### 9. Parallel Milestone Execution

**Savings: Time only (not cost) | Effort: 4-6 hours | Priority: Low for linear PRDs**

Milestones with no dependencies on each other could run in parallel. Requires:
- Topological sort of milestone dependency graph
- Concurrent agent sessions
- Merge strategy for overlapping file changes

For the devrig PRD (linear dependency chain: 0→1→2→3→4→5), this provides zero benefit. But for PRDs with independent feature tracks, it could cut wall-clock time significantly.

### 10. Verification Attempt History

**Savings: Analysis quality | Effort: 30 minutes | Priority: Low**

Write verification results to attempt-indexed files:

```typescript
const attemptPath = `verification-status-attempt-${attempt}.json`;
await write(msDir, attemptPath, JSON.stringify(status));
await write(msDir, "verification-status.json", JSON.stringify(status)); // latest
```

---

## Impact Summary

```
  Estimated savings by optimization (cumulative)

  $180 ┤ ─ ─ ─ ─ ─ ─ ─ ─ ─  Actual: $178.78
       │
  $140 ┤ ███████████████████  After lint gate: ~$150
       │
  $120 ┤ ███████████████████  + Adaptive research: ~$125
       │
  $100 ┤ ███████████████████  + Context summarization: ~$110
       │
   $80 ┤ ███████████████████  + Model routing: ~$85
       │
   $60 ┤ ███████████████████  + All Tier 2-3: ~$65
       │
       └──────────────────────────────────────────────
```

**Bottom line: Implementing just the top 3 optimizations (lint gate, adaptive research, build/test in execute) would save ~40% of costs and reduce attempts from 14 to ~8.**
