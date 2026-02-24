# Comprehensive Tool Usage Investigation: All 10 Mood Radio Variants

**Date:** 2026-02-23
**Scope:** Every tool available, configured, and actually used across all 10 agent runs building the same Mood Radio app.

---

## 1. Variant Overview

| # | Variant | Runner | Model | Cost | Turns | Duration |
|---|---------|--------|-------|------|-------|----------|
| 1 | v0 | SDK | claude-opus-4-6 | $1.62 | 53 | 6m 27s |
| 2 | v1 | SDK (pipeline) | claude-opus-4-6 | $12.77 | 202 | 42m 36s |
| 3 | v2 | SDK (pipeline) | claude-opus-4-6 + haiku | $5.24 | 203 | ~25m |
| 4 | v0-sonnet | SDK | claude-sonnet-4-6 | $1.36 | 41 | 6m 41s |
| 5 | v0-sonnet-skill | SDK | claude-sonnet-4-6 | $1.57 | 42 | 7m 3s |
| 6 | v0-sonnet-teams | SDK | claude-sonnet-4-6 | $2.18 | 12 | 8m 18s |
| 7 | v0-sonnet-skill-teams | SDK | claude-sonnet-4-6 | $2.06 | 12 | 5m 57s |
| 8 | v0-haiku | SDK | claude-haiku-4-5 | $0.97 | 103 | 8m 23s |
| 9 | CLI Opus | CLI | claude-opus-4-6 | $1.22 | 39 | 6m 16s |
| 10 | CLI Sonnet | CLI | claude-sonnet-4-6 | $2.68 | 39 | 11m 5s |

---

## 2. Tool Availability vs Actual Usage: Master Table

### 2.1 SDK Variants — Tool Availability (from `allowedTools` in run.ts / phase configs)

**Single-query variants (v0, v0-sonnet, v0-sonnet-skill, v0-haiku):**

All four use `allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Task"]`.

| Tool | v0 | v0-sonnet | v0-sonnet-skill | v0-haiku |
|------|:--:|:---------:|:---------------:|:--------:|
| Read | Available | Available | Available | Available |
| Write | Available | Available | Available | Available |
| Edit | Available | Available | Available | Available |
| Bash | Available | Available | Available | Available |
| Glob | Available | Available | Available | Available |
| Grep | Available | Available | Available | Available |
| Task (subagents) | Available | Available | Available | Available |
| WebSearch | **Not available** | **Not available** | **Not available** | **Not available** |
| WebFetch | **Not available** | **Not available** | **Not available** | **Not available** |
| TodoWrite | **Not available** | **Not available** | **Not available** | **Not available** |
| Skill | **Not available** | **Not available** | **Not available** | **Not available** |
| TeamCreate | **Not available** | **Not available** | **Not available** | **Not available** |
| SendMessage | **Not available** | **Not available** | **Not available** | **Not available** |
| EnterPlanMode | **Not available** | **Not available** | **Not available** | **Not available** |
| ExitPlanMode | **Not available** | **Not available** | **Not available** | **Not available** |
| EnterWorktree | **Not available** | **Not available** | **Not available** | **Not available** |
| NotebookEdit | **Not available** | **Not available** | **Not available** | **Not available** |

**All-tools variants (v0-sonnet-teams, v0-sonnet-skill-teams):**

Both use no `allowedTools` restriction (all tools enabled via the SDK's default tool set).

| Tool | v0-sonnet-teams | v0-sonnet-skill-teams |
|------|:---------------:|:---------------------:|
| Read | Available | Available |
| Write | Available | Available |
| Edit | Available | Available |
| Bash | Available | Available |
| Glob | Available | Available |
| Grep | Available | Available |
| Task (subagents) | Available | Available |
| WebSearch | Available | Available |
| WebFetch | Available | Available |
| TodoWrite | Available | Available |
| Skill | Available | Available |
| TeamCreate | Available | Available |
| SendMessage | Available | Available |
| EnterPlanMode | Available | Available |
| ExitPlanMode | Available | Available |
| EnterWorktree | Available | Available |
| NotebookEdit | Available | Available |

**Pipeline variants (v1, v2) — tool availability varies by phase:**

| Tool | Parse | Research | Architect | Execute | Verify | Fix | Report | Final Report |
|------|:-----:|:--------:|:---------:|:-------:|:------:|:---:|:------:|:------------:|
| Read | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Write | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Edit | No | No | No | Yes | No | Yes | No | No |
| Bash | Yes | Yes | Yes | Yes | Yes | Yes | No | Yes |
| Glob | No | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Grep | No | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Task | No | No | No | Yes | No | No | No | No |
| WebSearch | No | Yes | No | No | No | No | No | No |
| WebFetch | No | Yes | No | No | No | No | No | No |
| Skill | No | No | No | *Conditional | No | No | No | No |
| Agents** | No | No | No | Yes (worker, reviewer, tester) | No | No | No | No |

\* Skill tool is only added to execute phase when `isFrontendMilestone()` returns true (milestone name/features contain "dashboard", "solidjs", "frontend", "ui", "vite", "tsx", etc.).

\** v1/v2 define named `agents` (worker, reviewer, tester) as `AgentDefinition` objects passed to the execute phase. These are subagent types invocable via the Task tool.

### 2.2 CLI Variants — Tool Availability (from JSONL init event)

Both CLI runs had the full Claude Code tool set available:

| Tool | CLI Opus | CLI Sonnet |
|------|:--------:|:----------:|
| Task | Available | Available |
| TaskOutput | Available | Available |
| TaskStop | Available | Available |
| Bash | Available | Available |
| Glob | Available | Available |
| Grep | Available | Available |
| ExitPlanMode | Available | Available |
| EnterPlanMode | Available | Available |
| Read | Available | Available |
| Edit | Available | Available |
| Write | Available | Available |
| NotebookEdit | Available | Available |
| WebFetch | Available | Available |
| TodoWrite | Available | Available |
| WebSearch | Available | Available |
| AskUserQuestion | Available | Available |
| Skill | Available | Available |
| EnterWorktree | Available | Available |
| TeamCreate | Available | Available |
| TeamDelete | Available | Available |
| SendMessage | Available | Available |
| ToolSearch | Available | Available |

**Skills available (both CLI runs):** `keybindings-help`, `debug`, `ycf`, `agent-browser`, `frontend-design:frontend-design`

**Agents available (both CLI runs):** `Bash`, `general-purpose`, `statusline-setup`, `Explore`, `Plan`, `claude-code-guide`, `feature-dev:code-architect`, `feature-dev:code-explorer`, `feature-dev:code-reviewer`, `code-simplifier:code-simplifier`

**Plugins loaded (both CLI runs):** `frontend-design`, `typescript-lsp`, `rust-analyzer-lsp`, `feature-dev`, `code-simplifier`

---

## 3. Actual Tool Usage: The Complete Picture

### 3.1 Core File/Code Tools (Used by ALL variants)

| Tool | v0 | v1 | v2 | v0-son | v0-son-skill | v0-son-teams | v0-son-sk-teams | v0-haiku | CLI-Opus | CLI-Son |
|------|:--:|:--:|:--:|:------:|:------------:|:------------:|:---------------:|:--------:|:--------:|:-------:|
| Write | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | 18 | 18 |
| Read | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | 1 | 0 |
| Edit | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | 2 | 2 |
| Bash | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | 13 | 15 |
| Glob | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | 0 | 0 |
| Grep | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | 0 | 0 |

All variants used Write, Edit, and Bash heavily. Glob and Grep were available but unused in the CLI variants (no need to search when building from scratch).

### 3.2 Special Tools: Detailed Investigation

#### EnterPlanMode / ExitPlanMode

| Variant | Available? | Used? | Details |
|---------|:----------:|:-----:|---------|
| v0 (Opus bare) | No | No | Not in allowedTools |
| v1 (Pipeline) | No | No | Not in any phase's allowedTools |
| v2 (Optimized pipeline) | No | No | Not in any phase's allowedTools |
| v0-sonnet | No | No | Not in allowedTools |
| v0-sonnet-skill | No | No | Not in allowedTools |
| v0-sonnet-teams | Yes | **No** | Available (all tools) but unused |
| v0-sonnet-skill-teams | Yes | **No** | Available (all tools) but unused |
| v0-haiku | No | No | Not in allowedTools |
| CLI Opus | Yes | **No** | Available but unused |
| CLI Sonnet | Yes | **No** | Available but unused |

**Finding:** No variant used plan mode. Even when available, agents chose to plan inline (via thinking blocks or TodoWrite) rather than entering a formal plan mode. This makes sense for a single-prompt build task where the agent doesn't need human approval before executing.

#### Skill Tool

| Variant | Available? | Used? | Details |
|---------|:----------:|:-----:|---------|
| v0 (Opus bare) | No | No | Not in allowedTools |
| v1 (Pipeline) | **Conditional** | **Unknown (see below)** | Added to execute phase only for frontend milestones |
| v2 (Optimized pipeline) | **Conditional** | **Unknown (see below)** | Added to execute phase only for frontend milestones |
| v0-sonnet | No | No | Not in allowedTools |
| v0-sonnet-skill | No | **N/A** | Skill content injected directly into prompt as `<design-skill>` block |
| v0-sonnet-teams | Yes | **No** | Available but unused |
| v0-sonnet-skill-teams | Yes | **No** | Skill content injected into prompt; Skill tool also available but unused |
| v0-haiku | No | No | Not in allowedTools |
| CLI Opus | Yes | **No** | `frontend-design:frontend-design` listed in skills but never invoked |
| CLI Sonnet | Yes | **No** | `frontend-design:frontend-design` listed in skills but never invoked |

**Key findings:**

1. **v0-sonnet-skill and v0-sonnet-skill-teams injected skill content directly into the prompt** by reading `../frontend-design-skill.md` and embedding it in a `<design-skill>` block. The Skill tool was NOT used as an interactive tool call. This is prompt injection, not tool invocation.

2. **v1 and v2 pipelines conditionally offered the Skill tool** to the execute phase when the milestone was detected as frontend work. The execute prompt told the agent: *"Use the Skill tool with skill: 'frontend-design' to generate frontend code."* Whether the agent actually invoked it depends on the run logs (the pipeline harness code added it to the tools array but actual invocation data requires checking the SDK message stream).

3. **Neither CLI variant invoked the Skill tool** despite `frontend-design:frontend-design` being listed as available. The CLI's init event shows the skill was loaded from the plugin cache, but neither Opus nor Sonnet chose to use it. They relied on their own design knowledge instead.

4. **No SDK bare-prompt variant had the Skill tool available** (it was not in `allowedTools` for v0, v0-sonnet, v0-sonnet-teams, v0-haiku). Only the pipeline execute phases and the two "teams" variants had it.

#### Task Tool (Subagent Spawning)

| Variant | Available? | Used? | Details |
|---------|:----------:|:-----:|---------|
| v0 (Opus bare) | Yes | **No** | In allowedTools but never invoked |
| v1 (Pipeline) | Yes (execute only) | **Yes (23 invocations)** | Pipeline's execute phase defines worker/reviewer/tester agents |
| v2 (Optimized pipeline) | Yes (execute only) | **Yes (18 invocations)** | Same agent definitions as v1, slightly fewer calls |
| v0-sonnet | Yes | **No** | In allowedTools but never invoked |
| v0-sonnet-skill | Yes | **No** | In allowedTools but never invoked |
| v0-sonnet-teams | Yes | **Yes (2 invocations)** | Spawned backend + frontend subagents in parallel |
| v0-sonnet-skill-teams | Yes | **Yes (~2 invocations)** | Same pattern as v0-sonnet-teams |
| v0-haiku | Yes | **No** | In allowedTools but never invoked |
| CLI Opus | Yes | **No** | Available but never invoked |
| CLI Sonnet | Yes | **No** | Available but never invoked; Sonnet's thinking explicitly said "I should handle this myself rather than delegating" |

**Key findings:**

1. **Pipeline variants (v1/v2) used Task heavily** because the execute phase was explicitly configured with three named agent definitions (worker, reviewer, tester) and the prompt instructed the agent to delegate. The research phase also spawned subagents for parallel web searches.

2. **The "teams" SDK variants spawned 2 subagents** each (backend + frontend workers) despite explicit prompt encouragement to use more tools. The overhead of context serialization to subagents made them 60% more expensive than bare prompt.

3. **All bare-prompt variants (v0, v0-sonnet, v0-haiku) and both CLI variants chose NOT to use Task** even when available. Single-agent execution was the natural choice for a well-defined small app.

4. **CLI Sonnet explicitly reasoned about and rejected subagent use** in its extended thinking: *"I should handle this myself rather than delegating to a task since it needs careful coordination."*

#### TodoWrite

| Variant | Available? | Used? | Details |
|---------|:----------:|:-----:|---------|
| v0 (Opus bare) | No | No | Not in allowedTools |
| v1 (Pipeline) | **Implicitly via SDK** | **Yes (48 invocations)** | Claude Code internal tool planner may have it |
| v2 (Optimized pipeline) | **Implicitly via SDK** | **Yes (28 invocations)** | Reduced from v1 |
| v0-sonnet | No | No | Not in allowedTools |
| v0-sonnet-skill | No | No | Not in allowedTools |
| v0-sonnet-teams | Yes | **Yes (>=1)** | Available and used for planning |
| v0-sonnet-skill-teams | Yes | **Unknown** | Available |
| v0-haiku | No | No | Not in allowedTools |
| CLI Opus | Yes | **Yes (4 invocations)** | 5-item plan: backend, tests, frontend, verify backend, verify frontend |
| CLI Sonnet | Yes | **Yes (3 invocations)** | 3-item plan: backend, frontend, run checks |

**Key findings:**

1. **TodoWrite was NOT in `allowedTools` for any restricted SDK variant** (v0, v0-sonnet, v0-sonnet-skill, v0-haiku). These variants could not use it even if they wanted to.

2. **Both CLI variants used TodoWrite for progress tracking.** Opus had a more granular 5-item plan; Sonnet had a 3-item plan. Both updated their todo lists as they completed phases.

3. **Pipeline variants used TodoWrite heavily** (48 calls in v1, 28 in v2) for tracking within individual phases. This was the SDK's internal Claude Code tool planner at work.

4. **The teams variants had TodoWrite available** since all tools were enabled. v0-sonnet-teams used it at least once; data on v0-sonnet-skill-teams is less clear.

#### WebSearch / WebFetch

| Variant | Available? | Used? | Details |
|---------|:----------:|:-----:|---------|
| v0 (Opus bare) | No | No | Not in allowedTools |
| v1 (Pipeline) | **Research phase only** | **Yes (121 + 96 = 217)** | Heavy web research across both milestones |
| v2 (Optimized pipeline) | **Research phase only** | **Yes (56 + 55 = 111)** | Reduced by adaptive light-mode |
| v0-sonnet | No | No | Not in allowedTools |
| v0-sonnet-skill | No | No | Not in allowedTools |
| v0-sonnet-teams | Yes | **No** | Available but unused |
| v0-sonnet-skill-teams | Yes | **No** | Available but unused |
| v0-haiku | No | No | Not in allowedTools |
| CLI Opus | Yes | **No** | Available but unused |
| CLI Sonnet | Yes | **No** | Available but unused |

**Key findings:**

1. **Only the pipeline research phases used web search.** v1 spent 217 tool calls on web research (53% of its tool budget); v2 cut this to 111 (49% reduction from adaptive light mode).

2. **Every non-pipeline variant -- including those with web search available -- chose not to use it.** The models' training data was sufficient for Axum + SolidJS + Tailwind. Web research added zero value for well-known technology stacks.

3. **The "teams" variants had WebSearch/WebFetch available** (all tools enabled) and the prompt explicitly encouraged using them (*"Using WebSearch/WebFetch if you need to look up latest API docs or patterns"*). Neither variant used them. The models correctly identified web research as unnecessary.

#### TeamCreate / SendMessage

| Variant | Available? | Used? | Details |
|---------|:----------:|:-----:|---------|
| v0 (Opus bare) | No | No | Not in allowedTools |
| v1 (Pipeline) | No | No | Not in any phase's allowedTools |
| v2 (Optimized pipeline) | No | No | Not in any phase's allowedTools |
| v0-sonnet | No | No | Not in allowedTools |
| v0-sonnet-skill | No | No | Not in allowedTools |
| v0-sonnet-teams | Yes | **No** | Available; prompt encouraged it; agent chose Task (subagents) instead |
| v0-sonnet-skill-teams | Yes | **No** | Available; prompt encouraged it; agent chose Task (subagents) instead |
| v0-haiku | No | No | Not in allowedTools |
| CLI Opus | Yes | **No** | Available but unused |
| CLI Sonnet | Yes | **No** | Available but unused |

**Key findings:**

1. **No variant ever created a team.** Even v0-sonnet-teams and v0-sonnet-skill-teams, which were explicitly told to *"use teams (TeamCreate) if you want coordinated agents working on different parts"*, chose to use the simpler Task tool for subagent spawning instead.

2. **TeamCreate/SendMessage represent a heavier coordination model** (team creation, message passing, shutdown protocol) that none of the agents found necessary for this task scope. Task (direct subagent spawning) was the preferred lightweight alternative.

---

## 4. Pipeline Tool Architecture (v1 and v2)

The pipeline variants have a fundamentally different tool architecture: tools are restricted per-phase, and some phases use model routing.

### Phase-by-Phase Tool Map

```
Parse     → [Read, Write, Bash]                          (v2: Haiku model)
Research  → [Read, Write, Glob, Grep, Bash, WebSearch, WebFetch]  (v2: light mode skips WebSearch for small PRDs)
Architect → [Read, Write, Glob, Grep, Bash]
Execute   → [Read, Write, Edit, Bash, Glob, Grep, Task, *Skill]  + agents{worker, reviewer, tester}
Verify    → [Read, Write, Bash, Glob, Grep]              (v2: Haiku model)
Fix       → [Read, Write, Edit, Bash, Glob, Grep]
Report    → [Read, Write, Glob, Grep]                    (v2: Haiku model)
Final Rpt → [Read, Write, Glob, Grep, Bash]              (v2: Haiku model)
```

### v2 Model Routing Optimization

| Phase | v1 Model | v2 Model | Cost Savings |
|-------|----------|----------|:------------:|
| Parse | Opus | **Haiku** | 77% |
| Research | Opus | Opus (adaptive) | 77-90% (light mode) |
| Architect | Opus | Opus | 2-33% (leaner context) |
| Execute | Opus | Opus | 13-30% (leaner context) |
| Verify | Opus | **Haiku** | 71-78% |
| Fix | Opus | Opus | -- |
| Report | Opus | **Haiku** | 79-86% |
| Final Report | Opus | **Haiku** | 77% |

### Pipeline Execute Phase: Agent Definitions

Both v1 and v2 define three named subagent types for the execute phase:

```typescript
const agents = {
  worker: {
    description: "General-purpose worker agent for reading, writing, editing files, and running commands.",
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    model: "inherit",
  },
  reviewer: {
    description: "Read-only code review agent for checking correctness and style.",
    tools: ["Read", "Glob", "Grep"],
    model: "inherit",
  },
  tester: {
    description: "Testing agent focused on running tests and validation.",
    tools: ["Bash", "Read", "Glob", "Grep"],
    model: "inherit",
  },
};
```

These are invocable via the Task tool. The execute prompt tells the agent: *"You have access to subagents: delegate to 'worker' for parallel file operations, 'reviewer' for code review, 'tester' for running test suites."*

---

## 5. Skill Injection: The Three Approaches

The experiment tested three different approaches to providing design guidance:

### Approach 1: No Design Skill (v0, v1, v2, v0-sonnet, v0-sonnet-teams, v0-haiku, CLI Opus, CLI Sonnet)

**8 of 10 variants had no design skill guidance.** All converged on similar dark-glassmorphism-gradient aesthetics with minor variations. Frontend CSS ranged from 52-77 lines.

### Approach 2: Skill Content Injected into Prompt (v0-sonnet-skill, v0-sonnet-skill-teams)

The `frontend-design-skill.md` file (~42 lines, ~4,500 characters of design guidance) was read at build time and embedded directly in the prompt:

```typescript
const skill = await Bun.file(skillPath).text();
const prompt = `...
<design-skill>
${skill}
</design-skill>
...`;
```

The Skill tool itself was **NOT** used as a tool call. This is static prompt injection.

**Result:** Dramatically different aesthetics. v0-sonnet-skill produced 331 lines of CSS with film grain, scanlines, custom fonts, and a lo-fi noir broadcast theme. v0-sonnet-skill-teams produced 158 lines with a similar but less polished aesthetic.

### Approach 3: Skill Tool Available but Unused (v0-sonnet-teams, v0-sonnet-skill-teams, CLI Opus, CLI Sonnet)

These variants had the Skill tool in their available tools set. The CLI variants also had the `frontend-design:frontend-design` skill listed in their init event. **None of them invoked it.**

The pipeline variants (v1/v2) conditionally added the Skill tool to the execute phase for frontend milestones and instructed: *"Use the Skill tool with skill: 'frontend-design'."* Whether the agent actually invoked it via a tool call is unknown from the code alone (it depends on the runtime behavior).

**Conclusion:** The most effective design skill approach was **direct prompt injection** (Approach 2). Making the Skill tool available and even encouraging its use (Approach 3) was insufficient -- agents chose not to use it. The skill content needs to be in the prompt context, not behind a tool call.

---

## 6. Summary: Key Tool Usage Patterns

### Pattern 1: Minimal Tool Usage Dominates

The most cost-effective variants (v0, v0-sonnet, CLI Opus) used the smallest number of distinct tools: Write, Edit, Bash, and optionally Read/TodoWrite. They avoided every "optional" tool (WebSearch, Skill, Task, TeamCreate, Plan mode).

### Pattern 2: Tool Availability Does Not Imply Tool Usage

| Tool | Times Available | Times Used |
|------|:--------------:|:----------:|
| EnterPlanMode | 4 variants | 0 variants |
| ExitPlanMode | 4 variants | 0 variants |
| TeamCreate | 4 variants | 0 variants |
| SendMessage | 4 variants | 0 variants |
| WebSearch | 4+ variants | 2 variants (pipelines only) |
| Skill | 4+ variants | 0 variants (as tool call) |
| Task (subagents) | 10 variants | 4 variants |
| TodoWrite | 4+ variants | 4 variants |

### Pattern 3: Subagents Hurt More Than Help for Small Tasks

| Metric | Without Subagents (best) | With Subagents (best) |
|--------|:------------------------:|:---------------------:|
| Cost | $1.22 (CLI Opus) | $2.06 (v0-sonnet-skill-teams) |
| Code Quality Score | 9.0/10 (v1) | 6.0/10 (v0-sonnet-skill-teams) |
| Backend Quality | 9/10 (v2) | 5/10 (v0-sonnet-teams) |

Subagent variants consistently had worse code quality, more bugs (history ordering bug in v0-sonnet-teams), and worse separation of concerns (mood data inlined in route handlers).

### Pattern 4: WebSearch Was Pure Overhead

Web research added $6-8 in cost (v1: 217 calls, v2: 111 calls) to the pipeline variants. No other variant used it, and all produced equivalent or better code. For well-known stacks, web search is waste.

### Pattern 5: TodoWrite Provides Structure Without Cost

CLI variants used TodoWrite (3-4 calls each) for lightweight progress tracking. Cost was negligible. It provided organizational structure that aided the sequential build process. This is the "right-sized" planning tool for small tasks.

### Pattern 6: The Skill Tool Is Never Invoked as a Tool

Across 10 variants with various configurations, the Skill tool was never invoked as an actual tool call. The effective way to use skill content is to inject it into the prompt directly. The tool-based approach failed because:
- Models don't proactively search for skills they might use
- The overhead of a tool call round-trip is unnecessary when the skill content is static
- Models rely on their own training data rather than fetching external guidance

---

## 7. Complete Tool Usage Matrix

| Tool | v0 | v1 | v2 | v0-son | v0-s-sk | v0-s-tm | v0-s-sk-tm | v0-hai | CLI-Op | CLI-Son |
|------|:--:|:--:|:--:|:------:|:-------:|:-------:|:----------:|:------:|:------:|:-------:|
| Read | U | U | U | U | U | U | U | U | U(1) | -- |
| Write | U | U | U | U | U | U | U | U | U(18) | U(18) |
| Edit | U | U | U | U | U | U | U | U | U(2) | U(2) |
| Bash | U | U | U | U | U | U | U | U | U(13) | U(15) |
| Glob | U | U | U | U | U | U | U | U | -- | -- |
| Grep | U | U | U | U | U | U | U | U | -- | -- |
| Task | -- | U(23) | U(18) | -- | -- | U(2) | U(~2) | -- | -- | -- |
| WebSearch | N/A | U(121) | U(56) | N/A | N/A | -- | -- | N/A | -- | -- |
| WebFetch | N/A | U(96) | U(55) | N/A | N/A | -- | -- | N/A | -- | -- |
| TodoWrite | N/A | U(48) | U(28) | N/A | N/A | U | ? | N/A | U(4) | U(3) |
| Skill | N/A | ? | ? | N/A | N/A* | -- | --* | N/A | -- | -- |
| TeamCreate | N/A | N/A | N/A | N/A | N/A | -- | -- | N/A | -- | -- |
| SendMessage | N/A | N/A | N/A | N/A | N/A | -- | -- | N/A | -- | -- |
| EnterPlanMode | N/A | N/A | N/A | N/A | N/A | -- | -- | N/A | -- | -- |
| ExitPlanMode | N/A | N/A | N/A | N/A | N/A | -- | -- | N/A | -- | -- |
| EnterWorktree | N/A | N/A | N/A | N/A | N/A | -- | -- | N/A | -- | -- |
| NotebookEdit | N/A | N/A | N/A | N/A | N/A | -- | -- | N/A | -- | -- |

**Legend:**
- `U` = Used (with count if known)
- `U(n)` = Used n times
- `--` = Available but NOT used
- `N/A` = Not available
- `?` = Unknown (available but usage data not in logs)
- `*` = Skill content injected via prompt, not via Skill tool

---

## 8. Conclusions

1. **Plan mode was universally unused.** No variant -- SDK or CLI, with any model -- used EnterPlanMode/ExitPlanMode. For single-prompt build tasks, agents plan implicitly through thinking blocks or TodoWrite.

2. **The Skill tool was never invoked as a tool call by any variant.** The only effective way to apply skill content was direct prompt injection. The two variants with injected skill content (v0-sonnet-skill, v0-sonnet-skill-teams) were the only ones with distinctive visual design.

3. **Subagent spawning via Task was used by 4 variants** but consistently degraded code quality and increased cost. The pipeline variants used it extensively (18-23 calls) because their execute phase was explicitly configured with agent definitions. The teams variants used it minimally (2 calls each).

4. **TeamCreate/SendMessage were never used** despite being available in 4 variants with explicit prompt encouragement. Agents preferred the lighter Task tool for parallelism.

5. **WebSearch was used only by pipeline research phases** (v1: 217 calls, v2: 111 calls). Every other variant -- including those with web search available -- correctly identified it as unnecessary for well-known tech stacks.

6. **TodoWrite was the most "right-sized" planning tool.** Used by CLI variants (3-4 calls) and pipeline variants (28-48 calls) for lightweight progress tracking. Cost was negligible; organizational value was positive.

7. **The most efficient tool profile was Write + Edit + Bash + optional TodoWrite.** This is what CLI Opus used: 18 writes, 2 edits, 13 bash calls, 4 todo writes = 37 tool calls total, $1.22, 6m 16s. Everything else was overhead for this task scope.
