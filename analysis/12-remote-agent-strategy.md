# Remote Agent Strategy for yackey.cloud

## Summary

After 15 agent runs across 7 experiments spending ~$30 in test costs, we have enough empirical data to define how remote agents should work across the fj project ecosystem. This document synthesizes findings into actionable architecture decisions.

---

## The Evidence Base

| Experiment | Runs | Key Finding |
|-----------|------|-------------|
| Mood Radio: v0/v1/v2 | 3 | Pipeline overhead not justified for small tasks; v0 matched quality at 1/7th cost |
| Sonnet variants | 4 | Design skill via prompt injection is highest ROI; subagents degrade quality |
| CLI Opus vs Sonnet | 2 | Opus 1.8x faster and 2.2x cheaper under subscription; batches tools aggressively |
| Vague prompt (3-way) | 3 | Plan mode is a dead end for unattended agents; raw Opus just builds while others stall |
| .NET structured vs raw | 2 | PRD+tasks.yml costs 45% more but delivers 70% higher quality (58/70 vs 34/70) |
| devrig pipeline (original) | 1 | $178.78 for 17K LOC, ~55% was preventable waste from mechanical failures and context bloat |

### Universal Findings (held across all experiments)

1. **`claude -p` CLI is sufficient.** Agent SDK adds complexity without quality improvement. CLI supports streaming JSON for cost tracking, all tools, and `--dangerously-skip-permissions` for unattended use.

2. **Opus is the right model for code generation.** 1.8x faster than Sonnet, 2.2x cheaper under subscription pricing, batches 2-4 tools per turn vs Sonnet's 1. Sonnet thinks more but produces equivalent or lower quality code.

3. **Haiku for non-coding phases.** When you do need planning/parsing/verification as separate steps, route Haiku there. It costs 1/10th of Opus for structured reasoning tasks.

4. **The Skill tool is never self-invoked.** Across 13+ runs where it was available, 0 invocations. Skill content must be injected directly into the prompt to be effective.

5. **Plan mode breaks unattended agents.** ExitPlanMode requires user approval. In `claude -p`, there is no user — the agent plans, requests approval, gets no response, and exits successfully having produced zero code. Two of three vague-prompt runs fell into this trap.

6. **Subagents (Task/TeamCreate) are net negative for small-to-medium tasks.** They fragment context, add coordination overhead, and produced lower quality code in every comparison.

7. **Design skill injection is highest ROI.** ~$0.20 extra cost for +1.0 quality point on a 10-point scale. Injecting a 4,500-char design skill prompt produces custom fonts, warm accents, and distinctive UI instead of generic dark mode.

8. **Web research is lowest ROI.** v1 pipeline spent 217 WebSearch calls and $6-8 on research that produced zero actionable information beyond the model's training data. For established stacks (Axum, SolidJS, React, .NET), skip it entirely.

---

## Architecture: Two Tiers

### Tier 1: Single-Shot Agent (Default)

**Use for:** Features, bug fixes, refactoring, new components, anything completable in one session (~5-15 minutes, <$3).

**Configuration:**
```bash
cat prompt.md | claude -p \
  --model opus \
  --output-format stream-json \
  --dangerously-skip-permissions \
  --no-session-persistence \
  --verbose
```

**Prompt structure:**
```markdown
You are building [thing] in [directory].

## Context
[Relevant architecture notes, conventions, file paths]

## Requirements
[What to build — specific enough to avoid ambiguity]

## Constraints
- Run `[build command]` and fix all errors before finishing
- Run `[test command]` and ensure all tests pass
- Follow existing code conventions in [reference file]

## Design Guidelines (optional — inject when frontend work)
[4,500-char design skill content]
```

**Key rules:**
- Always include a build/test gate in the prompt ("run X before declaring done")
- Never mention plan mode, skills, or subagents — the agent won't use them
- Include relevant file paths and conventions — the agent won't explore proactively
- For frontend: inject the design skill directly into the prompt

**Expected performance:**
- Cost: $1-3 per task
- Time: 5-15 minutes
- Quality: 7-8/10 code, 8-9/10 with design skill

### Tier 2: Structured Agent (For Complex Domains)

**Use for:** New applications, complex domain logic, anything where architecture decisions compound — OR when tests and correctness matter more than speed.

**Configuration:** Same CLI, different prompt structure.

**Prompt structure:**
```markdown
You are building [thing] from scratch in the current directory.

Follow this workflow strictly:

STEP 1 — PLAN: Write a detailed PRD (prd.md) covering:
- User stories and acceptance criteria
- Architecture decisions and layer boundaries
- Data model with field types
- Core algorithms (specify formulas/logic)
- API/CLI interface definitions

STEP 2 — TASKS: Create tasks.yml breaking the PRD into ordered tasks.
Each task needs: name, description, acceptance criteria, dependencies.
Include test tasks with specific test case requirements.

STEP 3 — EXECUTE: Work through tasks.yml in order.
After completing each task, run [build command] and fix any errors.

STEP 4 — VERIFY: Run [full test suite]. Fix any failures.

The application:
[Description]

## Conventions
[Project-specific conventions]

## Design Guidelines (optional)
[Design skill content]
```

**Why this works:** The act of writing the PRD forces the model to resolve ambiguities before coding. The tasks.yml ensures tests and verification steps aren't skipped. Both cost +45% and +30% time but deliver +70% quality.

**Expected performance:**
- Cost: $2-5 per application
- Time: 10-20 minutes
- Quality: 8-9/10 code with tests

---

## What NOT to Do

### Don't use the Agent SDK for simple tasks
The SDK adds dependency management, TypeScript compilation, and API complexity. `claude -p` does the same thing with a bash one-liner. The SDK is useful if you need programmatic control (custom tool implementations, multi-turn orchestration), but for fire-and-forget tasks, CLI wins.

### Don't build a multi-phase pipeline for small tasks
The v1 pipeline (parse → research → architect → execute → verify → fix → report) cost 7x more than single-shot for equivalent quality on Mood Radio. Pipeline overhead only pays off for multi-milestone projects where each milestone is substantial (>1000 LOC).

### Don't enable plan mode
It's a dead end in non-interactive contexts. The agent writes an excellent plan, calls ExitPlanMode, and stops — producing zero code. This cost $0.59-$1.63 per run with nothing to show for it.

### Don't rely on subagents
TeamCreate, Task tool with delegation, and multi-agent coordination produced lower quality code in every experiment. The context fragmentation hurts more than the parallelism helps.

### Don't do web research for established stacks
Models have excellent training data for Rust, TypeScript, .NET, React, SolidJS, Axum, etc. WebSearch calls waste $6-8 per run. Only research if the task involves a genuinely novel library or API.

### Don't pass raw/vague prompts for important work
The .NET experiment proved this decisively: raw prompts produce prototype-quality code (34/70) while structured prompts produce production-quality code (58/70). The extra $0.70 and 2.5 minutes pay for themselves immediately in test coverage and architectural correctness.

---

## Integration with yackey.cloud Infrastructure

### Forgejo CI Trigger

The natural integration point is Forgejo CI. An action triggered by issue labels, PR comments, or scheduled runs:

```yaml
# .forgejo/workflows/agent.yml
name: Agent Task
on:
  issues:
    types: [labeled]

jobs:
  agent:
    if: contains(github.event.label.name, 'agent')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          # Extract task from issue body
          TASK=$(gh issue view ${{ github.event.issue.number }} --json body -q .body)

          # Build prompt with repo conventions
          cat <<EOF | claude -p --model opus --dangerously-skip-permissions --verbose
          You are working in the $(basename $PWD) repository.

          $(cat CLAUDE.md)

          ## Task
          ${TASK}

          ## Verification
          Run the project's validation command before finishing.
          EOF

          # Create PR with changes
          gh pr create --title "agent: $(gh issue view ${{ github.event.issue.number }} --json title -q .title)" \
            --body "Closes #${{ github.event.issue.number }}"
```

### Backstage Integration

The Backstage scaffolder can trigger agent runs for post-scaffold customization:

1. Backstage scaffolds new app from `fullstack-bun` or `solidjs-axum-yauth` template
2. Agent run triggered to implement the specific feature described in the scaffolder form
3. Agent uses Tier 1 (single-shot) with the template's conventions injected into the prompt
4. PR created automatically for review

### devrig Local Development

devrig can orchestrate agent runs for local development:

1. Developer writes an issue or task description
2. `devrig agent "implement X"` wraps it with repo conventions and launches `claude -p`
3. Agent works in a git worktree, creates a branch
4. Developer reviews the diff before merging

---

## Cost Projections

Based on empirical data:

| Task Type | Tier | Est. Cost | Est. Time |
|-----------|------|-----------|-----------|
| Bug fix | 1 | $0.50-1.50 | 3-8 min |
| New component/feature | 1 | $1-3 | 5-15 min |
| New endpoint + tests | 1 | $1-2 | 5-10 min |
| New application (simple) | 2 | $2-5 | 10-20 min |
| New application (complex domain) | 2 | $3-8 | 15-30 min |
| Multi-milestone project | Pipeline* | $30-80 | 2-5 hours |

*Pipeline approach only justified for projects >5 milestones where unattended overnight execution matters.

### Monthly Budget Estimate

For a moderately active development workflow (5-10 agent tasks/week):
- Low end: $20-40/month (mostly Tier 1 bug fixes and features)
- High end: $80-150/month (includes occasional Tier 2 new apps and pipeline runs)

---

## Open Questions

### Long-Horizon Execution

All experiments tested single-session tasks (5-30 minutes). The devrig build ($178.78, 10 hours, 6 milestones) is our only data point for multi-session work, and it had 55% waste from mechanical failures.

**Unanswered:** Does forcing checkpoint validation between milestones (complete milestone → verify → approve → start next) reduce waste enough to justify the session-resumption overhead? See the companion proposal for an experiment design.

### Session Resumption Quality

`claude --resume` maintains conversation context across sessions. But we haven't measured whether context quality degrades over long sessions as the compaction algorithm summarizes earlier turns.

### Model Routing at Scale

The v2 pipeline routed Haiku to non-critical phases and saved 59% on those phases. For a production system, dynamic model routing (Haiku for planning/verification, Opus for execution) could significantly reduce costs. But we haven't tested whether Haiku-generated plans are as good as Opus-generated plans.

---

## Recommendation

**Start with Tier 1 (single-shot `claude -p` with Opus) for everything.** It's the simplest architecture, empirically the best value, and covers 90% of development tasks.

Add Tier 2 (structured prompt with PRD→tasks→execute) when:
- You need tests and they won't be written otherwise
- The domain has complex logic (ranking algorithms, state machines, business rules)
- Architecture decisions matter (clean architecture, DDD, layer boundaries)

Consider a pipeline only for overnight batch operations where you're building something substantial (>5 milestones, >5000 LOC) and don't need to babysit it.

The single most impactful thing you can do is write good prompts. The difference between raw and structured prompts ($0.70 extra) produced a larger quality delta (+24 points) than any model, tool, or architecture choice we tested.
