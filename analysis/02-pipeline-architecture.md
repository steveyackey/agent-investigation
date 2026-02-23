# Pipeline Architecture Analysis

## How It Works

The pipeline is a TypeScript orchestrator (~500 lines across 14 files) that drives headless Claude Code agents through a structured sequence of phases per milestone. It uses the `@anthropic-ai/claude-agent-sdk` to spawn agent sessions with full tool access.

```
PRD.md ──→ [Parse] ──→ milestones.json
                            │
              ┌─────────────┴─────────────┐
              │   For each milestone:       │
              │                             │
              │   [Research] → research.md  │
              │        ↓                    │
              │   [Architect] → plan.md     │
              │               → steps.json  │
              │               → validation  │
              │        ↓                    │
              │   [Execute] → code changes  │
              │        ↓                    │
              │   [Verify] → pass/fail      │
              │        ↓                    │
              │   fail? → [Fix] → [Verify]  │
              │          (up to 3 attempts) │
              │        ↓                    │
              │   [Report] → report.md      │
              │        ↓                    │
              │   git commit + push         │
              └─────────────────────────────┘
                            │
              [Final Report] → report.md
```

## Configuration

| Parameter | Value | Notes |
|-----------|-------|-------|
| Model | `claude-sonnet-4-6` | Hardcoded default, overridable via `--model` |
| Max retries | 3 | Per milestone (1 execute + 2 fix attempts) |
| Permission mode | `bypassPermissions` | Agents can do anything without approval |
| Sub-agents | worker, reviewer, tester | All inherit parent model |
| System prompt | `claude_code` preset | Standard Claude Code system prompt |

## Phase Tool Access

| Phase | Read/Write | Bash | Search | Web | Edit | Task/Skill |
|-------|-----------|------|--------|-----|------|-----------|
| Parse | Yes | Yes | No | No | No | No |
| Research | Yes | Yes | Yes | **Yes** | No | No |
| Architect | Yes | Yes | Yes | No | No | No |
| Execute | Yes | Yes | Yes | No | Yes | **Yes** |
| Verify | Yes | Yes | Yes | No | No | No |
| Fix | Yes | Yes | Yes | No | Yes | No |
| Report | Yes | No | Yes | No | No | No |

## Design Strengths

### 1. Phase Separation Is Well-Designed

Each phase has a clear, bounded responsibility. Research gathers information. Architect makes decisions. Execute writes code. Verify checks it. Fix patches failures. Report documents outcomes. This separation means failures in one phase don't corrupt others.

### 2. Artifact Persistence Enables Resumability

Every phase writes its output to disk before the next phase starts. If the pipeline crashes, it can resume from the last completed phase by checking for artifact existence. This is robust and saved at least one manual restart during the run.

### 3. Verification Is Strict and Binary

The all-or-nothing pass/fail check (all checks must pass) forces completeness. There's no "good enough" — the pipeline either produces a fully passing milestone or retries. This is the right call for autonomous operation where partial success can compound into larger problems.

### 4. Fix Phase Is Separate from Execute

Using a targeted fix agent (with access to specific failure output) instead of re-running the full execute phase is much more cost-efficient. The fix phase correctly loads only relevant steps and failure details, keeping context focused.

### 5. Prior Context Accumulation

Each milestone can see all previous milestones' reports. This gives the agent awareness of what's already built, preventing duplication and enabling incremental development. The architecture evolves coherently across milestones.

## Design Weaknesses

### 1. No Pre-Verification Lint Gate (Critical)

The execute phase does not run `cargo fmt --check` or `cargo clippy` before declaring implementation complete. The verify phase then catches these, triggering an entire fix → re-verify cycle that costs $5-15.

**Impact:** 5 of 6 milestones needed formatting/linting fixes. Estimated waste: $30-40.

**Fix:** Add to the execute phase prompt: "Before declaring implementation complete, run `cargo fmt` and `cargo clippy -- -D warnings` and fix any issues."

### 2. Research Phase Doesn't Adapt to Milestone Position

Milestone 0's research (1,459 lines, foundational crate evaluation) was highly valuable. Milestone 5's research (871 lines, mostly re-documenting existing architecture) was mostly wasted context. The pipeline runs the same research phase for every milestone regardless of whether the milestone introduces new technology or builds on established patterns.

**Impact:** Later milestones' research was ~50% codebase state assessment that the agent could derive from prior reports. Estimated waste: $15-25.

**Fix:** Make research adaptive:
- New technology milestones → full research with web search
- Incremental feature milestones → skip research or use a lightweight "codebase review" variant
- The PRD could tag milestones as `research: full | light | skip`

### 3. Prior Context Grows Without Bounds

Each milestone's research and architect phases include ALL prior milestone reports in the prompt. By milestone 5, that's 5 full reports (each 15-20KB) prepended to the prompt. This consumes tokens on context that could be summarized.

**Impact:** Token waste scales quadratically with milestone count. For 6 milestones: ~$10-15 in redundant prior context tokens.

**Fix:** Instead of including full prior reports, generate a running "project context summary" (1-2 pages) that's updated after each milestone. Include only this summary plus the immediately preceding milestone's report.

### 4. Verification Can Modify the Codebase

The verify phase has `Bash` access, meaning it could run `cargo fmt` (which modifies files) or other side-effecting commands. A verification phase should be read-only on the codebase.

**Impact:** Low (the verify agent didn't abuse this in practice), but it's a correctness risk.

**Fix:** Remove `Bash` from verify's tool set, or sandbox it to read-only commands.

### 5. `git add -A` Is Indiscriminate

The pipeline commits with `git add -A`, which stages everything including temporary files, debug output, or unintended changes an agent might have left behind.

**Impact:** Medium — could commit secrets, large binaries, or debug files.

**Fix:** Use targeted staging based on the execution plan's file list, or at minimum exclude known patterns (`.env`, `*.log`, etc.).

### 6. No Per-Phase Cost Tracking

Costs are tracked per-milestone but not per-phase. We can't determine exactly how much the research vs. execute vs. fix phases cost. This makes optimization harder.

**Impact:** Analysis limitations — we have to estimate phase costs rather than measure them.

**Fix:** Track `phase_cost` in the pipeline state alongside milestone cost. The SDK returns cost per query.

### 7. No Timeout or Token Budget

There's no timeout on individual agent phases and no token budget ceiling. A runaway agent could consume unlimited tokens.

**Impact:** Risk of cost blowup, especially on complex milestones.

**Fix:** Add per-phase token limits and wall-clock timeouts. Kill the agent if it exceeds either.

### 8. Model Is Uniform Across All Phases

Every phase uses the same model (Sonnet). But phases have very different complexity:
- Research: needs intelligence for synthesis → Sonnet/Opus
- Architect: needs intelligence for design → Sonnet/Opus
- Execute: needs coding ability → Sonnet
- Verify: runs commands, checks output → Haiku
- Fix: targeted patches → Sonnet
- Report: text synthesis → Haiku/Sonnet

**Impact:** Using Sonnet for verification and reporting wastes ~3x the cost vs. Haiku.

**Fix:** See [Model Selection Strategy](06-model-strategy.md).

### 9. No Parallelism

Milestones run sequentially even when their dependency graphs allow parallelism. The milestone schema includes a `dependencies` field, but it's never consulted during execution.

**Impact:** For this particular PRD (linear dependency chain), no impact. For PRDs with parallel milestones, this would be a significant time waste.

**Fix:** Topologically sort milestones by dependencies and run independent milestones concurrently.

### 10. Verification Results Overwritten on Each Attempt

Each verify run overwrites the previous `verification-status.json`. There's no attempt-indexed history, making post-mortem analysis of fix progression harder.

**Impact:** Analysis limitation only — doesn't affect pipeline operation.

**Fix:** Write to `verification-status-attempt-N.json` and keep a `latest` symlink.
