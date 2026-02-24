# .NET Experiment: Does Explicit "What/Why/How" Split Matter?

## Hypothesis

When given a vague prompt, does forcing an agent to first plan (PRD → tasks.yml) before executing produce measurably better code than letting it freestyle?

## Setup

Both runs used **CLI Opus** (`claude -p --model opus`) with identical conditions:
- `--dangerously-skip-permissions --no-session-persistence --verbose --output-format stream-json`
- Empty starting directory, .NET 10 SDK available
- Model: `claude-opus-4-6` via Claude Code v2.1.51

**Core prompt:** `create a .net cli with clean arch and ddd that allows you to track the next most important task. use ascii art.`

**Structured variant** wrapped it with explicit workflow steps:
1. Write a detailed PRD (`prd.md`)
2. Create `tasks.yml` with ordered implementation tasks + acceptance criteria
3. Execute tasks in order, marking each done
4. Verify with `dotnet build` + `dotnet test`

**Raw variant** received only the one-line prompt.

---

## Results

### Headline Numbers

| Metric | Raw | Structured | Delta |
|--------|-----|-----------|-------|
| **Cost** | $1.57 | $2.27 | +$0.70 (+45%) |
| **Duration** | 8.1 min | 10.6 min | +2.5 min (+30%) |
| **Build** | 0 warnings, 0 errors | 0 warnings, 0 errors | tie |
| **Tests** | 0 (no test projects) | 37 passing (26 domain + 11 app) | structured wins |
| **Source files** | 16 | 23 | +7 (tests + planning) |
| **API turns** | 61 | 63 | similar |
| **Tool calls** | 60 | 62 | similar |
| **Tool batching** | 1.28 tools/turn (max 8) | 1.02 tools/turn (max 2) | raw batches more |
| **Errors** | 6 | 6 | tie |

### Quality Scorecard (from deep code review)

| Dimension | Raw | Structured | Delta |
|-----------|-----|-----------|-------|
| Clean Architecture | 5/10 | 9/10 | +4 |
| DDD Patterns | 6/10 | 8/10 | +2 |
| CLI UX | 6/10 | 9/10 | +3 |
| Code Quality | 7/10 | 8/10 | +1 |
| Testing | 0/10 | 8/10 | +8 |
| Persistence | 7/10 | 7/10 | 0 |
| Core Ranking Logic | 3/10 | 9/10 | +6 |
| **Total** | **34/70** | **58/70** | **+24** |

---

## What the Structured Agent Got Right

### 1. The Core Algorithm (+6 delta)

The PRD specified an urgency-weighted ranking formula:
```
rank = priority_level × urgency_factor

urgency_factor:
  no due date    → 1.0
  overdue        → 2.0
  due within 24h → 1.8
  due within 3d  → 1.5
  due within 7d  → 1.2
  far out        → 1.0
```

The agent implemented it as a `TaskRankingService` domain service with a `TaskRank` value object. Result: a Medium-priority task due tomorrow (`3 × 1.8 = 5.4`) correctly surfaces above a High-priority task due in 3 months (`4 × 1.0 = 4.0`).

The raw agent had **no due date field at all** — it sorted purely by static priority weight. For an app whose purpose is "what should I do next?", this misses the entire point of temporal urgency.

### 2. Tests (+8 delta)

`tasks.yml` explicitly required:
- Task 4: "Domain unit tests" — Priority validation, entity lifecycle, ranking algorithm tiers
- Task 6: "Application layer unit tests" — Command/query verification, fake repository

The agent delivered 37 tests covering all specified criteria. The raw agent wrote zero tests.

### 3. Clean Architecture (+4 delta)

The PRD specified that `ITaskRepository` belongs in the Application layer. The raw agent put it in Domain (a common mistake). The PRD also implicitly prevented the reflection-based entity hydration the raw agent used, by specifying a `Reconstitute` factory method pattern.

### 4. CLI Framework

The PRD specified `System.CommandLine` for argument parsing. The structured app got proper `--help`, typed options (`-p 5`, `--due 2026-02-28`), short aliases, and default values. The raw app hand-rolled a `switch(args[0])` parser.

---

## What the Raw Agent Got Right

Despite having no planning, the raw agent made creative decisions:

- **`TaskStatus` value object** — modeled the task lifecycle (Pending → InProgress → Done) as a proper DDD value object. The structured app only has completed/not-completed (derived from `CompletedAt`).
- **`Start()` command** — added an in-progress state transition the structured app lacks.
- **`Reprioritize()` and `UpdateTitle()`** — richer entity behaviors showing lifecycle thinking.
- **In-memory cache** in the repository — micro-optimization the structured app skipped.
- **Faster tool batching** — wrote up to 8 files per API turn (entire Application layer in one shot).

The raw agent improvises well. It adds features the user might want. But it makes worse architectural decisions and skips verification entirely.

---

## The Planning Artifacts

### prd.md (4.6 KB)

Full product requirements document with:
- User stories, architecture decisions, data model
- The complete ranking algorithm specification
- CLI command definitions with acceptance criteria
- ASCII art design requirements

### tasks.yml (10 dependency-ordered tasks)

Each task had: name, description, acceptance criteria, dependencies. Tasks ranged from project setup through domain implementation, tests, infrastructure, CLI, and verification.

### Were they referenced during execution?

**No.** The structured agent never re-read `prd.md` during coding. `tasks.yml` was read once at the end to mark tasks done. The planning value came from forcing the model to **think through the design before coding** — the artifacts were consumed through the context window during creation, not by re-reading them later.

This is a critical insight: **the act of writing the plan matters more than the plan as a reference document.**

---

## CLI Output Comparison

### Raw ("NextTask") — `next` command
```
╔═══════════════════════════════════════════════╗
║   _  _         _  _____         _             ║
║  | \| |_____ _| ||_   _|_ _ ___| |__          ║
║  | .` / -_) \ /  _| | / _` (_-<| / /          ║
║  |_|\_\___/_\_\\__| |_\__,_/__/|_\_\          ║
║         What matters most, right now.          ║
╚═══════════════════════════════════════════════╝

          ╔═══════════════════════════════════════════╗
          ║        >>> YOUR NEXT TASK <<<             ║
          ╠═══════════════════════════════════════════╣
          ║  !!! Deploy auth service                  ║
          ║  Priority: Critical                       ║
          ║  Must ship before Friday                  ║
          ╚═══════════════════════════════════════════╝
```

### Structured ("NextUp") — `next` command
```
███╗   ██╗███████╗██╗  ██╗████████╗██╗   ██╗██████╗
████╗  ██║██╔════╝╚██╗██╔╝╚══██╔══╝██║   ██║██╔══██╗
██╔██╗ ██║█████╗   ╚███╔╝    ██║   ██║   ██║██████╔╝
██║╚██╗██║██╔══╝   ██╔██╗    ██║   ██║   ██║██╔═══╝
██║ ╚████║███████╗██╔╝ ██╗   ██║   ╚██████╔╝██║
╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝
─── focus on what matters next ───

╔════════════════════════════════════════════════════╗
║  ████░ HIGH  rank: 7.2                             ║
║  Fix memory leak                                   ║
║  id: 0bc4728c    due: 2026-02-24    created: ...   ║
╚════════════════════════════════════════════════════╝
```

The structured app shows the computed rank score, has ANSI color coding, priority bar indicators, and correctly surfaced a High-priority task due tomorrow above a Critical-priority task due in 5 days.

### Structured — `list` command
```
  #  PRI   RANK  TITLE                             DUE        ID
  ── ───── ───── ─────────────────────────────────── ────────── ────────
► 1  ●●●●○   7.2  Fix memory leak                    2026-02-24  0bc4728c
  2  ●●●●●   6.0  Deploy API to production            2026-03-01  3013fc9b
  3  ●●●●●   6.0  Deploy auth service                 2026-02-28  ecb001b0
  4  ●●●○○   3.0  Write unit tests                      ---      1df4491d
```

---

## Answer: Does Explicit "What/Why/How" Split Matter?

**Yes, decisively — for structured domains with clear acceptance criteria.**

The structured approach costs 45% more and takes 30% longer, but delivers:
- **+24 quality points** across 7 dimensions
- **Tests that actually exist** (37 vs 0)
- **The correct core algorithm** (urgency-weighted vs priority-only)
- **Proper architecture** (clean layer boundaries vs common mistakes)
- **Professional CLI UX** (System.CommandLine vs hand-rolled parser)

The ROI calculation: **+$0.70 for a 70% quality improvement** (34/70 → 58/70).

### When it matters most

- **Domain-specific logic** — the ranking algorithm was the app's entire reason to exist. The PRD specified it; the raw agent missed it.
- **Architectural decisions** — where interfaces live, how entities are hydrated, what libraries to use. These compound across the codebase.
- **Verification** — the structured prompt's "STEP 4: verify" was never explicitly needed (the agent ran build/test during development), but the task plan's test requirements forced test creation.

### When it doesn't matter

- **Prototyping** — if you need something fast and don't care about tests or architecture, the raw agent delivers in 8 minutes for $1.57.
- **Creative improvisation** — the raw agent independently invented `TaskStatus`, `Start()`, caching, and richer entity behaviors. Planning constrains creativity.
- **Simple tasks** — for straightforward CRUD without domain complexity, the overhead isn't worth it.

### The one remaining question

This experiment tested single-shot execution of a small-to-medium task. It does NOT answer: **for long-horizon, multi-day projects, does forcing one-task-at-a-time execution with validation between tasks stay on track better than one-shot?** That's the final variable to test.
