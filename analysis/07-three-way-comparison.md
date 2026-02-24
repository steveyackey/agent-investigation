# Three-Way Agent Pipeline Comparison

**Date:** 2026-02-23
**App:** Mood Radio (SolidJS + Axum full-stack)
**Model:** claude-opus-4-6 (all 3 runners)
**System Prompt:** `{ type: "preset", preset: "claude_code" }` with `settingSources: []`

## Executive Summary

We ran three approaches to building the same app from the same PRD:

| Metric | v0: Bare Prompt | v1: Pipeline | v2: Optimized Pipeline |
|--------|-----------------|--------------|------------------------|
| **Total Cost** | **$1.62** | $12.77 | $5.24 |
| **Wall-Clock Time** | **6m 27s** | 42m 36s | ~25m (active)* |
| **Turns** | 53 | 202 | 203 |
| **Quality Checks** | 5/5 | 5/5 | 5/5 |
| **Cost/Quality Ratio** | **Best** | Worst | Middle |

\* v2 experienced ~37 minutes of rate-limit stalling on M1 research (3 Opus agents competing). Active compute time was ~25 minutes; wall-clock including stall was ~63 minutes. Required manual restart with `--milestone 1`.

**Verdict:** For a small, well-defined app (2 milestones, ~300 lines PRD), the bare prompt approach (v0) is the clear winner — **7.9x cheaper** than the pipeline and **6.6x faster**, with identical quality. The pipeline's multi-phase overhead only pays off on larger, multi-milestone projects where independent research, architecture planning, and verification genuinely reduce rework.

## Cost Breakdown

### Total Cost

```
v0  ████                                          $1.62
v1  ████████████████████████████████████████████   $12.77
v2  ██████████████████                             $5.24
```

### v0 Cost Distribution

Single agent, single session. No phases — just one `query()` call:
- Opus: $1.61 (99.4%)
- Haiku: $0.01 (0.6% — internal Claude Code tool-planner)
- Web search: 0 requests
- Web fetch: 0 requests

### v1 vs v2 Per-Phase Cost (Milestone 0: Backend API + Tests)

| Phase | v1 | v2 | Savings | What Changed |
|-------|------|------|---------|-------------|
| parse | $0.13 | $0.03 | **77%** | Haiku model routing |
| research | $2.71 | $0.63 | **77%** | Adaptive "light" mode (no web search, <200 lines) |
| architect | $0.48 | $0.47 | 2% | Same model, similar work |
| execute | $1.46 | $1.02 | **30%** | Leaner context (milestones.json, not full PRD) |
| verify | $0.18 | $0.04 | **78%** | Haiku model routing |
| report | $0.29 | $0.04 | **86%** | Haiku model routing |
| **Total M0** | **$5.12** | **$2.19** | **57%** | |

### v1 vs v2 Per-Phase Cost (Milestone 1: Frontend + Static Serving)

| Phase | v1 | v2 | Savings | What Changed |
|-------|------|------|---------|-------------|
| research | $3.38 | $0.34 | **90%** | Light mode + only latest prior report |
| architect | $0.99 | $0.66 | **33%** | Only latest prior report context |
| execute | $1.96 | $1.71 | **13%** | Leaner context, self-check prompt |
| verify | $0.51 | $0.15 | **71%** | Haiku model routing |
| report | $0.33 | $0.07 | **79%** | Haiku model routing |
| **Total M1** | **$7.17** | **$2.93** | **59%** | |

### v1 vs v2 Overhead Phases

| Phase | v1 | v2 | Savings |
|-------|------|------|---------|
| final-report | $0.35 | $0.08 | 77% |
| **Grand Total** | **$12.77** | **$5.24** | **59%** |

### Where v2 Optimizations Had the Most Impact

1. **Research phase (-77% to -90%):** Adaptive "light" mode was the single biggest cost saver. For a 2-milestone PRD, full web research is wasteful — the model already knows Axum, SolidJS, and Tailwind.
2. **Haiku routing (-77% to -86% on parse/verify/report):** These phases are mostly JSON manipulation and checklist validation. Haiku handles them perfectly at 1/10th the cost.
3. **Leaner execute context (-13% to -30%):** Sending just milestones.json instead of the full PRD + all prior reports reduced input tokens.

## Time Breakdown

### Wall-Clock Duration

```
v0  ██                                             6m 27s
v1  ████████████████████████████████████████████   42m 36s
v2  ██████████████████████████                     ~25m (active)
```

### v1 Phase Duration (Wall-Clock)

| Phase | M0 | M1 | Total |
|-------|------|------|-------|
| parse | 21s | — | 21s |
| research | 5m 24s | 7m 8s | 12m 32s |
| architect | 2m 52s | 5m 2s | 7m 54s |
| execute | 4m 55s | 7m 0s | 11m 55s |
| verify | 42s | 2m 28s | 3m 10s |
| report | 2m 52s | 1m 23s | 4m 15s |
| final-report | — | — | 2m 14s |
| **Total** | **17m 3s** | **23m 16s** | **42m 36s** |

### v2 Phase Duration (Wall-Clock, Active Only)

| Phase | M0 | M1 | Total |
|-------|------|------|-------|
| parse | 18s | — | 18s |
| research | 1m 38s | 1m 45s | 3m 23s |
| architect | 2m 38s | 3m 43s | 6m 21s |
| execute | 3m 49s | 5m 44s | 9m 33s |
| verify | 31s | 1m 49s | 2m 20s |
| report | 33s | 1m 7s | 1m 40s |
| final-report | — | — | 1m 12s |
| **Total** | **9m 29s** | **14m 22s** | **~25m** |

v2 is 40% faster than v1 in active compute time, driven primarily by shorter research phases.

## Quality Assessment

### Automated Checks (All Pass)

| Check | v0 | v1 | v2 |
|-------|------|------|------|
| `cargo build` | ✅ | ✅ | ✅ |
| `cargo test` (5/5) | ✅ | ✅ | ✅ |
| `cargo fmt --check` | ✅ | ✅ | ✅ |
| `cargo clippy -- -D warnings` | ✅ | ✅ | ✅ |
| `bun run build` (frontend) | ✅ | ✅ | ✅ |

All three passed every quality gate on the first attempt. No fix phases were needed.

### Code Metrics

| Metric | v0 | v1 | v2 |
|--------|------|------|------|
| Rust backend (lines) | 287 | 253 | 260 |
| Frontend (lines) | 286 | 446 | 326 |
| Tests (lines) | 195 | 175 | 189 |
| **Total** | **768** | **874** | **775** |
| Source files (backend) | 5 | 5 | 5 |
| Source files (frontend) | 7 | 7 | 7 |

All three produced functionally equivalent apps with the same file structure:
- `src/main.rs`, `src/lib.rs`, `src/models.rs`, `src/routes.rs`, `src/store.rs`
- `tests/api_tests.rs`
- `web/src/App.tsx`, `web/src/api.ts`, `web/src/index.css`, `web/src/index.tsx`
- `web/src/components/MoodPicker.tsx`, `web/src/components/VibeCard.tsx`, `web/src/components/History.tsx`

v1's frontend is notably larger (446 lines vs 286/326) — it generated more elaborate CSS and component styling.

### Visual Quality (Screenshots)

All three apps share the same design DNA (dark theme, colored mood buttons, glassmorphism vibe card) but with distinct visual execution:

**v0 (Bare Prompt):**
- Clean, minimal dark layout with small radio dot indicator
- Mood buttons in 2x4 grid with colored borders and emoji labels
- Vibe card with gradient border (warm-to-cool) and italic message
- History section with seeded vibes showing relative timestamps
- Most compact layout — everything fits above the fold

**v1 (Pipeline):**
- Virtually identical layout to v0 — same "Mood Radio" header, similar grid
- Slightly different color scheme (darker button backgrounds, red-orange gradient on vibe card)
- "CREATIVE" label on vibe card vs "Creative" on v0
- History section ("RECENT VIBES") positioned lower
- Emojis render as boxes in headless Chrome (system font limitation, not a code issue)

**v2 (Optimized Pipeline):**
- Larger, bolder header with "tune into how you feel" subtitle
- Radio-themed language: "SELECT FREQUENCY", "CURRENT SIGNAL", "CREATIVE FREQUENCY"
- More saturated mood button colors (olive, blue, red, gray tones)
- Animated radio dots below the header
- Cleaner vibe card without border gradient — relies on text color for emphasis
- Most thematically consistent with the "radio" concept

All three are fully functional. None have obvious bugs. The visual differences are purely aesthetic choices, not quality gaps.

## Tool & Agent Usage

### v0: Bare Prompt

Single agent session. The v0 runner uses `query()` with tools `[Read, Write, Edit, Bash, Glob, Grep, Task]`.

From the result:
- **0** web search requests
- **0** web fetch requests
- **0** subagent spawns (Task tool)
- **53 turns** total
- The agent wrote all code directly without research, planning phases, or web lookup

This is the key insight: Opus already knows how to build an Axum+SolidJS app. It doesn't need to search the web or create research documents. It just builds.

### v1: Pipeline (Tool Counts from Log)

| Tool | Count | Notes |
|------|-------|-------|
| WebSearch | 121 | Heavy web research in both milestones |
| WebFetch | 96 | Following up on search results |
| Bash | 99 | Build, test, install, format commands |
| Task (subagents) | 23 | Research spawns parallel sub-agents |
| Skill refs | 19 | Various Claude Code skills |
| TodoWrite | 48 | Planning/tracking within phases |

v1 spent **217 tool calls** on web research (WebSearch + WebFetch) — 53% of its tool budget — to research things Opus already knows.

### v2: Optimized Pipeline (Tool Counts from Log)

| Tool | Count | Notes |
|------|-------|-------|
| WebSearch | 56 | Reduced by light-mode research |
| WebFetch | 55 | Still fetches some docs |
| Bash | 94 | Similar build/test cadence |
| Task (subagents) | 18 | Fewer research sub-agents |
| Skill refs | 18 | Similar skill usage |
| TodoWrite | 28 | Less planning overhead |

v2 cut web research by 49% (111 vs 217 calls). Still too many — the light-mode research still did web searches in some cases where it shouldn't have needed to.

### Skills Used

All three runners loaded the Claude Code preset, which includes:
- `keybindings-help`, `debug` as built-in skills
- Agent types: `Bash`, `general-purpose`, `Explore`, `Plan`, `claude-code-guide`

v1 and v2 referenced skills like `debug` and spawned `Explore` and `general-purpose` subagents during research phases. v0 used none of these — it never needed them.

## Operational Issues

### v2 Rate-Limit Stall

With three Opus agents running simultaneously (v0, v1, v2), the API hit rate limits during v2's M1 research phase. The agent received `rate_limit_event` with `overageStatus: "rejected"` and stalled for ~37 minutes before we manually killed it.

**Resolution:** Killed the stuck process and restarted v2 with `--milestone 1`, leveraging the pipeline's built-in resume capability. M0 was already complete, so no work was lost.

**Lesson:** Running multiple Opus agents in parallel requires rate-limit awareness. v2's rate-limit issue was operational, not a flaw in its optimization. In production, stagger launches or use rate-limit-aware queuing.

### v0 Process Forking

The `run-all.sh` script used `nohup ... &` to background all three. PID capture with `$!` didn't work reliably with nohup. Not a significant issue — process management via `ps aux` and `lsof` worked fine.

## Analysis: When Does a Pipeline Help?

### Why v0 Won This Round

1. **Small scope:** 2 milestones, ~300 lines of PRD. A single Opus agent can hold the entire problem in context.
2. **Known technology:** Axum, SolidJS, Tailwind, Vite — all well-represented in training data. Web research added zero value.
3. **No ambiguity:** The PRD specified exact routes, data models, test cases, and component names. No research or architecture decisions needed.
4. **No rework:** v0 got it right on the first pass with minor clippy and test fixes. The pipeline's verify/fix loop never triggered either.

### When the Pipeline Would Win

The pipeline (v1/v2) adds value when:
1. **Large scope (>5 milestones):** Context window exhaustion in a single agent session
2. **Unknown technology:** The agent genuinely needs to research APIs, SDKs, or patterns it hasn't seen
3. **Complex architecture:** Multiple services, databases, auth flows — where an architecture phase prevents costly rework
4. **High failure rate:** When the first execute attempt often fails and needs targeted fix phases

### The Optimization Tax

v2 saved 59% over v1, proving the optimizations work. But it still cost **3.2x more** than v0 for identical output. The pipeline's overhead phases (parse, research, architect, verify, report) are a "tax" that only pays off when the execution phase is expensive enough to justify prevention.

For Mood Radio, the execution phase was cheap ($1-2), so the tax was pure waste. For the original devrig build ($178), a 59% savings from v2 optimizations would have saved ~$105 — well worth the overhead.

## Cost Efficiency Ratios

| Metric | v0 | v1 | v2 |
|--------|------|------|------|
| Cost per line of code | $2.11 | $14.61 | $6.76 |
| Cost per Rust line | $5.65 | $50.47 | $20.15 |
| Cost per test line | $8.30 | $72.99 | $27.72 |
| Cost per quality check pass | $0.32 | $2.55 | $1.05 |
| Turns per dollar | 32.7 | 15.8 | 38.7 |

v2 actually has the best turns-per-dollar ratio because Haiku turns are cheap. But v0's cost-per-everything-else is unbeatable.

## Recommendations

### For Small Apps (1-3 milestones, well-defined PRD)

**Use v0 (bare prompt).** Just give Opus the PRD and let it build. No phases, no overhead. Expected cost: $1-5. Expected time: 5-15 minutes.

### For Medium Apps (4-8 milestones, some ambiguity)

**Use v2 (optimized pipeline) with light research.** The milestone-based approach prevents context exhaustion and the verify/fix loop catches regressions between milestones. Expected cost: $20-50 with optimizations.

### For Large Apps (>8 milestones, complex architecture)

**Use v2 (optimized pipeline) with full research.** Architecture planning and research genuinely prevent costly rework. Consider model routing: Opus for execute/architect, Haiku for parse/verify/report.

### Future Experiment

Re-run v0 with `claude-sonnet-4-6` to test whether the bare-prompt approach works with a cheaper model. If Sonnet can produce the same quality for this app scope, cost drops to ~$0.25-0.50, making it a no-brainer for small projects.

## Raw Data

### v0 Result
```json
{
  "approach": "v0-bare-prompt",
  "model": "claude-opus-4-6",
  "cost_usd": 1.618329,
  "duration_ms": 387574,
  "duration_human": "6m 27s",
  "turns": 53,
  "status": "success"
}
```

### v1 Pipeline State
```json
{
  "started_at": "2026-02-23T23:20:37.067Z",
  "milestones": [
    { "id": 0, "version": "v0.1", "status": "completed", "attempts": 1, "cost": 5.12 },
    { "id": 1, "version": "v0.2", "status": "completed", "attempts": 1, "cost": 7.17 }
  ],
  "total_cost": 12.77
}
```

### v2 Pipeline State
```json
{
  "started_at": "2026-02-23T23:20:38.389Z",
  "milestones": [
    { "id": 0, "version": "v0.1", "status": "completed", "attempts": 1, "cost": 2.19 },
    { "id": 1, "version": "v0.2", "status": "completed", "attempts": 1, "cost": 2.93 }
  ],
  "total_cost": 5.24
}
```

### v2 Per-Phase Cost Summary
```json
{
  "parse":        { "cost": 0.03, "duration_s": 18,  "turns": 3,  "count": 1 },
  "research":     { "cost": 0.97, "duration_s": 203, "turns": 33, "count": 2 },
  "architect":    { "cost": 1.13, "duration_s": 380, "turns": 26, "count": 2 },
  "execute":      { "cost": 2.73, "duration_s": 572, "turns": 83, "count": 2 },
  "verify":       { "cost": 0.19, "duration_s": 140, "turns": 46, "count": 2 },
  "report":       { "cost": 0.11, "duration_s": 100, "turns": 4,  "count": 2 },
  "final-report": { "cost": 0.08, "duration_s": 72,  "turns": 8,  "count": 1 }
}
```
