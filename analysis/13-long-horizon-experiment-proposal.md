# Proposal: Long-Horizon Agent Execution Experiment

## The Question

Does forcing checkpoint validation between milestones keep a multi-session project on track better than single-shot execution?

We know from the .NET experiment that structured prompts (PRD→tasks→execute) produce 70% higher quality than raw prompts. But that was a single-session, single-milestone build. The devrig pipeline ($178.78, 6 milestones) is our only multi-milestone data point, and its 55% waste rate suggests there's room for improvement.

The specific variables to test:

1. **One-shot**: Give the full PRD and let the agent build everything in one long session
2. **Task-at-a-time with validation**: Execute one task, validate, then resume with the next task
3. **Milestone-at-a-time with validation**: Execute one milestone (group of related tasks), validate, resume

---

## The App: Recipe Scaler

A SolidJS + Axum + SQLite full-stack app. Chosen because:

- **Large enough to require multiple milestones** (~3000-5000 LOC target)
- **Has real domain logic** (unit conversion, scaling algorithms, fraction math)
- **Uses our standard stack** (same as solidjs-axum-yauth template)
- **Has clear milestone boundaries** (backend API → domain logic → frontend → integration)
- **Testable at each checkpoint** (cargo test, cargo clippy, frontend build)

### Feature Set

**Milestone 1: Data Model + API**
- Recipe CRUD (title, servings, ingredients, steps)
- Ingredient model (name, quantity, unit, preparation notes)
- SQLite via rusqlite (code-first, migrations)
- REST API: list, get, create, update, delete recipes
- Unit tests for all endpoints

**Milestone 2: Scaling Engine (Domain Logic)**
- Scale recipe by target servings (multiply all quantities)
- Unit conversion system (cups↔ml, oz↔g, tbsp↔tsp, etc.)
- Fraction display (1.5 → 1½, 0.333 → ⅓, 0.25 → ¼)
- Smart rounding (don't say "1.0001 cups", say "1 cup")
- Handle "to taste" and "pinch of" (non-scalable ingredients)
- Domain service with full test coverage

**Milestone 3: Frontend**
- Recipe list with search/filter
- Recipe detail view with scaling slider (1x → 10x)
- Live-updating ingredient quantities as slider moves
- Add/edit recipe form
- Responsive design, dark mode
- Design skill applied

**Milestone 4: Integration + Polish**
- Frontend ↔ API integration
- Error handling (network failures, validation errors)
- Loading states and optimistic updates
- E2E smoke test (add recipe, scale it, verify quantities)
- cargo clippy clean, cargo fmt, biome lint

---

## Three Runners

### Runner A: One-Shot

Single `claude -p` invocation with the full PRD. No milestones, no checkpoints. The agent decides its own execution order.

```bash
cat recipe-scaler-prd.md | claude -p \
  --model opus \
  --output-format stream-json \
  --dangerously-skip-permissions \
  --no-session-persistence \
  --verbose \
  > logs/one-shot.jsonl 2>&1
```

### Runner B: Task-at-a-Time

PRD is pre-decomposed into ~15-20 individual tasks (similar to the .NET structured approach but with forced validation between each). An orchestrator script:

1. Starts a session: `claude -p` with task 1
2. After completion, runs validation (`cargo build`, `cargo test`, `cargo clippy`)
3. If validation fails, resumes with error context
4. If validation passes, starts new session with task 2 + context summary
5. Repeats until all tasks complete

```bash
#!/usr/bin/env bash
for task in $(yq '.tasks[].id' tasks.yml); do
  TASK_DESC=$(yq ".tasks[] | select(.id == \"$task\")" tasks.yml)
  CONTEXT=$(summarize_completed_tasks)

  cat <<EOF | claude -p --model opus --dangerously-skip-permissions --verbose \
    > "logs/task-${task}.jsonl" 2>&1
You are continuing work on Recipe Scaler in the current directory.

## Completed So Far
${CONTEXT}

## Current Task
${TASK_DESC}

## Validation
After completing this task, run:
- cargo build (must succeed with 0 errors)
- cargo test (must pass)
- cargo clippy -- -D warnings (must be clean)
Fix any failures before declaring done.
EOF

  # Validate
  cd app && cargo build && cargo test && cargo clippy -- -D warnings
  if [ $? -ne 0 ]; then
    echo "VALIDATION FAILED for task ${task}" >> logs/validation.log
    # Feed errors back in a retry
  fi
  cd ..
done
```

### Runner C: Milestone-at-a-Time

Same as Runner B but grouped by milestone (4 sessions instead of 15-20). Each milestone gets the full PRD context + summary of completed milestones.

```bash
for milestone in 1 2 3 4; do
  TASKS=$(yq ".tasks[] | select(.milestone == ${milestone})" tasks.yml)
  COMPLETED=$(summarize_completed_milestones)

  cat <<EOF | claude -p --model opus --dangerously-skip-permissions --verbose \
    > "logs/milestone-${milestone}.jsonl" 2>&1
You are working on Milestone ${milestone} of Recipe Scaler.

## PRD
$(cat recipe-scaler-prd.md)

## Completed Milestones
${COMPLETED}

## Tasks for This Milestone
${TASKS}

## Workflow
1. Write a brief plan for this milestone
2. Implement all tasks in order
3. Run cargo build, cargo test, cargo clippy after each task
4. Fix any issues before moving to the next task
5. Run full validation before declaring the milestone complete
EOF

  # External validation gate
  cd app && cargo build && cargo test && cargo clippy -- -D warnings
  cd ..
done
```

---

## What We're Measuring

### Primary Metrics

| Metric | How Measured |
|--------|-------------|
| **Total cost** | Sum of all JSONL cost data |
| **Wall-clock time** | First timestamp to last |
| **Build success** | `cargo build` exit code |
| **Test count + pass rate** | `cargo test` output |
| **Clippy cleanliness** | `cargo clippy -- -D warnings` |
| **Frontend build** | `bun run build` exit code |

### Quality Metrics

| Metric | How Measured |
|--------|-------------|
| **Architecture score** | Code review: layer boundaries, dependency direction |
| **Domain logic correctness** | Manual test: scale 1 cup flour to 3 servings → expect 3 cups |
| **Test coverage quality** | Review: do tests cover edge cases (fractions, unit conversion, non-scalable)? |
| **Dropped requirements** | Compare delivered features against PRD acceptance criteria |
| **Frontend design quality** | Screenshot comparison |

### Process Metrics (the real experiment)

| Metric | How Measured |
|--------|-------------|
| **Requirements dropped** | Count of PRD acceptance criteria not implemented |
| **Errors per milestone** | Count of build/test/clippy failures |
| **Retries needed** | Number of validation-fail-and-retry cycles |
| **Context quality over time** | Does later code reference/respect earlier decisions? |
| **Drift from PRD** | Does the agent diverge from the plan in later milestones? |

---

## Hypotheses

**H1: Task-at-a-time (B) will have the fewest dropped requirements.**
Rationale: Forced validation after each task catches omissions immediately. The .NET structured run dropped file locking despite specifying it — a checkpoint would have caught this.

**H2: One-shot (A) will be cheapest and fastest.**
Rationale: No session overhead, no context re-injection, no validation scripting. Consistent with Mood Radio results where v0 was 7x cheaper than v1.

**H3: Milestone-at-a-time (C) will be the best quality/cost tradeoff.**
Rationale: Fewer sessions than B (4 vs 15-20) so less context loss, but still has validation gates. Enough context per session for the agent to make coherent cross-task decisions.

**H4: One-shot (A) will have the most drift in later milestones.**
Rationale: As context grows, earlier decisions may be forgotten or contradicted. The devrig pipeline showed growing context waste in later milestones.

**H5: Task-at-a-time (B) will be most expensive.**
Rationale: ~15-20 separate sessions means ~15-20 context re-injections. Each session pays the prompt token cost for the full PRD + completed context summary.

---

## Implementation Plan

### Phase 1: Write the PRD (1 hour)

Write `recipe-scaler-prd.md` with:
- Full feature specification for all 4 milestones
- Acceptance criteria for every feature
- Architecture decisions (layer boundaries, file structure)
- Scaling algorithm specification (exact formulas for unit conversion)
- Test requirements per milestone

Also write `tasks.yml` with 15-20 tasks grouped into 4 milestones.

### Phase 2: Build the Orchestrator (1-2 hours)

Write the bash scripts for all three runners:
- `run-one-shot.sh` — simple pipe to claude
- `run-task-at-a-time.sh` — loop with validation gates
- `run-milestone-at-a-time.sh` — grouped loop with validation gates
- `validate.sh` — shared validation script (build, test, clippy, frontend)
- `summarize.sh` — generates context summaries for B and C

### Phase 3: Run All Three (1-3 hours wall clock)

Launch all three in parallel. Expected durations:
- A (one-shot): 15-30 minutes
- B (task-at-a-time): 45-90 minutes (serial tasks with validation)
- C (milestone-at-a-time): 30-60 minutes (4 serial milestones)

### Phase 4: Analysis (1-2 hours)

- Parse all JSONL logs for cost/token/timing data
- Run quality checks on all three outputs
- Manual testing of scaling logic
- Code review across all dimensions
- Screenshot comparison
- Write final comparison report

### Total Estimated Cost

| Runner | Estimated Cost |
|--------|---------------|
| A (one-shot) | $3-8 |
| B (task-at-a-time) | $8-20 |
| C (milestone-at-a-time) | $5-12 |
| **Total** | **$16-40** |

---

## Expected Outcome

This experiment will answer the final open question: **is the one-shot approach good enough for multi-milestone projects, or do validation checkpoints provide enough quality improvement to justify the overhead?**

Combined with the existing 15 runs of data, this will complete the empirical basis for the remote agent strategy. The possible outcomes:

1. **One-shot wins on everything except dropped requirements** → Keep Tier 1 as default, add a post-completion validation step that feeds errors back for a single retry
2. **Milestone-at-a-time is clearly best** → Build milestone orchestration into the Forgejo CI workflow, with validation gates between milestones
3. **Task-at-a-time is worth the overhead** → Build a task-level orchestrator, but this is unlikely given the cost projections

The most likely outcome is (1) or (2), which means the remote agent strategy stays simple: single-shot for small tasks, milestone-gated for large ones.

---

## Repo Structure

```
~/fj/agent-investigation/
├── recipe-scaler/
│   ├── prd.md
│   ├── tasks.yml
│   ├── run-one-shot.sh
│   ├── run-task-at-a-time.sh
│   ├── run-milestone-at-a-time.sh
│   ├── validate.sh
│   ├── summarize.sh
│   ├── one-shot/app/         # Runner A output
│   ├── task-at-a-time/app/   # Runner B output
│   └── milestone/app/        # Runner C output
├── logs/
│   ├── one-shot.jsonl
│   ├── task-*.jsonl
│   └── milestone-*.jsonl
└── analysis/
    └── 14-long-horizon-comparison.md
```
