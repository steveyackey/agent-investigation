# Sonnet Variants Comparison

**Date:** 2026-02-23
**App:** Mood Radio (SolidJS + Axum full-stack)
**Model:** claude-sonnet-4-6 (all 3 variants)
**System Prompt:** `{ type: "preset", preset: "claude_code" }` with `settingSources: []`
**Context:** Follow-up to the three-way Opus comparison. The bare-prompt approach won decisively at $1.62/6m27s. Now testing if Sonnet can replicate that quality for less.

## Executive Summary

| Metric | v0-sonnet | v0-sonnet-skill | v0-sonnet-teams | v0-opus (baseline) |
|--------|-----------|-----------------|-----------------|---------------------|
| **Cost** | **$1.36** | $1.57 | $2.18 | $1.62 |
| **Duration** | **6m 41s** | 7m 3s | 8m 18s | 6m 27s |
| **Turns** | 41 | 42 | 12 | 53 |
| **Quality (5 checks)** | 5/5 | 5/5 | 5/5 | 5/5 |
| **Rust LOC** | 301 | 307 | 286 | 287 |
| **Frontend LOC** | 332 | **866** | 327 | 286 |
| **Test LOC** | 180 | 114 | 192 | 195 |

**Verdict:** Sonnet matches Opus quality at **16% less cost** and comparable speed. The design skill produces dramatically better UI (866 lines of frontend, distinctive lo-fi noir aesthetic) for only $0.21 more. The teams/subagent approach is the worst value — 60% more expensive than bare Sonnet, slower, and visually indistinguishable.

## The Three Variants

### v0-sonnet: Bare Prompt
Same setup as the original v0 Opus run. Single `query()` call, same PRD, same restricted tool set (`Read, Write, Edit, Bash, Glob, Grep, Task`). Just swapped the model from `claude-opus-4-6` to `claude-sonnet-4-6`.

### v0-sonnet-skill: Bare Prompt + Frontend Design Skill
Same as v0-sonnet, but the prompt includes the full `frontend-design` skill content (the official Claude plugin SKILL.md). This adds ~4,500 characters of design guidance: typography choices, color theory, motion design, spatial composition, and explicit instructions to avoid "generic AI aesthetics."

### v0-sonnet-teams: Bare Prompt + All Tools + Team Encouragement
Same model, but with all tools unlocked (no `allowedTools` restriction — full access to `TeamCreate`, `SendMessage`, `TodoWrite`, `WebSearch`, `WebFetch`, etc.) and a prompt that explicitly encourages using subagents, teams, and web research for speed.

## Cost Analysis

```
v0-sonnet       ████████████████████████████████         $1.36
v0-sonnet-skill ████████████████████████████████████     $1.57  (+$0.21)
v0-sonnet-teams ████████████████████████████████████████████████  $2.18  (+$0.82)
v0-opus         ██████████████████████████████████████   $1.62  (baseline)
```

### Cost Breakdown by Model

| Variant | Sonnet Cost | Haiku Cost | Total |
|---------|-------------|------------|-------|
| v0-sonnet | $1.352 | $0.008 | $1.361 |
| v0-sonnet-skill | $1.565 | $0.010 | $1.575 |
| v0-sonnet-teams | $2.166 | $0.012 | $2.178 |
| v0-opus (baseline) | $1.608 | $0.010 | $1.618 |

Haiku cost is negligible in all cases (~$0.01) — it's used internally by Claude Code's tool planner.

### Why Teams Cost More

The teams variant spawned 2 subagents (backend + frontend) in parallel. While this reduced the main agent to just 12 turns, the subagents each needed their own context windows:

- **Main agent:** 12 turns, lightweight orchestration
- **Backend subagent:** Full Cargo project creation + tests
- **Frontend subagent:** Full SolidJS/Vite/Tailwind setup

Cache reads: 1.66M tokens (vs 1.55M for bare sonnet). The overhead of serializing context to subagents and the additional session initialization costs added **60% to the bill** with no quality improvement.

## Time Comparison

```
v0-sonnet       ██████████████████████████████████  6m 41s
v0-sonnet-skill ████████████████████████████████████  7m 03s
v0-sonnet-teams ██████████████████████████████████████████  8m 18s
v0-opus         ████████████████████████████████  6m 27s
```

Sonnet is marginally slower than Opus despite being a "faster" model. This is likely because:
- Sonnet needed more turns for some fixes (41 turns vs Opus's 53 — but Opus's turns were more productive per-turn)
- The teams variant looks fast in turns (12) but wall-clock was longest due to subagent coordination overhead

## Quality Assessment

### Automated Checks (All Pass)

| Check | v0-sonnet | v0-sonnet-skill | v0-sonnet-teams |
|-------|-----------|-----------------|-----------------|
| `cargo fmt --check` | ✅ | ✅ | ✅ |
| `cargo test` (5/5) | ✅ | ✅ | ✅ |
| `cargo clippy -- -D warnings` | ✅ | ✅ | ✅ |
| `cargo build` | ✅ | ✅ | ✅ |
| `bun run build` (frontend) | ✅ | ✅ | ✅ |

All three variants pass every quality gate. Identical to the Opus baseline.

### Code Metrics

| Metric | v0-sonnet | v0-sonnet-skill | v0-sonnet-teams | v0-opus |
|--------|-----------|-----------------|-----------------|---------|
| Rust backend | 301 | 307 | 286 | 287 |
| Frontend | 332 | **866** | 327 | 286 |
| Tests | 180 | 114 | 192 | 195 |
| **Total** | **813** | **1,287** | **805** | **768** |

The skill variant's frontend is **2.6x larger** than the others. This isn't bloat — it's substantially more CSS (custom animations, textures, typography) and more detailed component implementations.

The skill variant's tests are notably shorter (114 lines vs 180-192). This isn't a quality gap — it has the same 5 tests, just more concise assertions.

### Visual Quality (Screenshots)

This is where the variants diverge most dramatically:

**v0-sonnet (Bare):**
- Very similar to v0-opus — dark theme, 2x4 mood grid, glassmorphism vibe card
- Radio wave icon in header, "tune into your frequency" subtitle
- Gradient-filled vibe card with mood color, "CREATIVE" label badge
- Clean and functional, no obvious defects
- Indistinguishable from Opus output at a glance

**v0-sonnet-skill (Frontend Design Skill):**
- **Dramatically different aesthetic.** Lo-fi noir broadcast station feel
- Left-aligned header with golden radio icon and "LIVE" badge in top-right
- "// TUNE YOUR FREQUENCY" section header with monospace comment syntax
- Larger mood buttons, uppercase labels, no emojis visible (text-only buttons)
- Vibe card shows italic serif quote: *"Creativity is just problem-solving that forgot to take itself seriously."*
- "BROADCASTING ON ALL FREQUENCIES" placeholder text
- Subtle gradient line divider below header
- The most visually distinctive of ALL variants across both experiments
- 866 lines of carefully crafted CSS with custom properties, film grain effects, and serif typography

**v0-sonnet-teams (All Tools):**
- Nearly identical to v0-sonnet (bare). Same layout, same styling approach
- Purple radio bars icon, same "tune into your frequency" subtitle
- Same glassmorphism card, same gradient, same font choices
- "RECENT VIBES" history section with relative timestamps
- Subagent parallelization didn't improve visual quality at all

### Visual Quality Verdict

The frontend-design skill is the **only variant that produced genuinely distinctive UI**. All other variants (both Sonnet and Opus) converge on the same dark-glassmorphism-gradient aesthetic. The skill breaks this convergence by injecting design intentionality — it chose a "lo-fi noir broadcast" direction and committed to it with serif fonts, uppercase monospace labels, and a broadcast station metaphor.

## Tool & Agent Usage

| Tool | v0-sonnet | v0-sonnet-skill | v0-sonnet-teams |
|------|-----------|-----------------|-----------------|
| Web search | 0 | 0 | 0 |
| Web fetch | 0 | 0 | 0 |
| Task (subagents) | 0 | 0 | 2 |
| TodoWrite | 0 | 0 | ≥1 |
| Turns | 41 | 42 | 12 |
| Output tokens | 15,855 | ~16,000 | 31,887* |

\* Teams variant has high output tokens because subagent prompts/results count toward the total.

**Key finding:** Even when explicitly told to use teams, web search, and every tool available, the teams variant only used subagents (2 parallel agents) and a todo list. It didn't use web search, web fetch, or team creation — it correctly identified that these tools wouldn't help for this task. Smart tool selection, but the subagent overhead still made it the most expensive option.

## Sonnet vs Opus

### Direct Comparison: v0-sonnet vs v0-opus

| Metric | Sonnet | Opus | Sonnet Advantage |
|--------|--------|------|------------------|
| Cost | $1.36 | $1.62 | **16% cheaper** |
| Duration | 6m 41s | 6m 27s | 3% slower |
| Turns | 41 | 53 | 23% fewer turns |
| Quality | 5/5 | 5/5 | Same |
| Rust LOC | 301 | 287 | +5% |
| Frontend LOC | 332 | 286 | +16% |
| Test LOC | 180 | 195 | -8% |

Sonnet is slightly cheaper with virtually identical output. The 16% cost savings comes from Sonnet's lower per-token price. Both produce essentially the same app with the same quality.

### When Opus Would Still Win

For this task size (small, well-defined), Sonnet matches Opus. Opus advantages would emerge with:
- Ambiguous requirements needing better reasoning
- Complex architecture decisions
- Multi-file refactoring requiring more context coherence
- Debugging subtle issues

## Recommendations

### For Small, Well-Defined Apps

**Use v0-sonnet (bare prompt).** $1.36, 6m41s, identical quality to Opus.

**Add the frontend-design skill** if visual quality matters. $0.21 more for dramatically better UI. This is the single highest-ROI addition in the entire experiment — 15% cost increase for 2.6x more frontend code and a genuinely distinctive aesthetic.

### Don't Use Teams for Small Tasks

The teams/subagent approach is a net negative for small apps:
- 60% more expensive than bare prompt
- 25% slower
- No quality improvement
- The coordination overhead outweighs any parallelism gains

Teams would make sense for apps with 5+ independent components where subagents can work on truly separate modules without stepping on each other.

### Don't Bother with Web Research

None of the Sonnet variants used web search — even the one explicitly encouraged to. For well-known technology stacks (Axum, SolidJS, Tailwind), the model's training data is sufficient. Web research is pure overhead.

## The Full Leaderboard (All 6 Runs)

| Rank | Variant | Cost | Time | Quality | Visual Quality |
|------|---------|------|------|---------|----------------|
| 1 | **v0-sonnet** | **$1.36** | 6m 41s | 5/5 | Standard |
| 2 | v0-sonnet-skill | $1.57 | 7m 3s | 5/5 | **Best** |
| 3 | v0-opus | $1.62 | 6m 27s | 5/5 | Standard |
| 4 | v0-sonnet-teams | $2.18 | 8m 18s | 5/5 | Standard |
| 5 | v2-optimized | $5.24 | ~25m | 5/5 | Good |
| 6 | v1-pipeline | $12.77 | 42m 36s | 5/5 | Good |

**Best overall value:** v0-sonnet-skill ($1.57 for best visual quality)
**Cheapest:** v0-sonnet ($1.36)
**Best visual quality:** v0-sonnet-skill (lo-fi noir broadcast aesthetic, 866 lines frontend)

## Raw Data

### v0-sonnet
```json
{
  "approach": "v0-sonnet",
  "model": "claude-sonnet-4-6",
  "cost_usd": 1.36054025,
  "duration_ms": 401518,
  "duration_human": "6m 41s",
  "turns": 41,
  "status": "success"
}
```

### v0-sonnet-skill
```json
{
  "approach": "v0-sonnet-skill",
  "model": "claude-sonnet-4-6",
  "cost_usd": 1.5745959999999999,
  "duration_ms": 423815,
  "duration_human": "7m 3s",
  "turns": 42,
  "status": "success"
}
```

### v0-sonnet-teams
```json
{
  "approach": "v0-sonnet-teams",
  "model": "claude-sonnet-4-6",
  "cost_usd": 2.17761225,
  "duration_ms": 498225,
  "duration_human": "8m 18s",
  "turns": 12,
  "status": "success"
}
```
