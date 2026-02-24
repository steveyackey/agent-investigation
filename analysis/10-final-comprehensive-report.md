# Final Comprehensive Report: 10-Way Agent Comparison

**Date:** 2026-02-23
**Experiment:** Build the same "Mood Radio" full-stack app (Rust/Axum + SolidJS) using 10 different AI agent configurations, then compare cost, speed, code quality, design quality, and tool usage.

---

## Executive Summary

We ran 10 configurations building identical Mood Radio apps:
- **3 Opus SDK variants** (bare, pipeline, optimized pipeline)
- **5 Sonnet SDK variants** (bare, +skill, +teams, +skill+teams, and Haiku)
- **2 CLI variants** (Opus and Sonnet via `claude -p`)

**The winner depends on what you optimize for:**

| Goal | Best Variant | Cost | Time | Score |
|------|-------------|------|------|-------|
| **Cheapest** | v0-haiku (SDK) | $0.97 | 8m 23s | 4.0/10 |
| **Fastest** | v0-sonnet-skill-teams (SDK) | $2.06 | 5m 57s | 6.0/10 |
| **Best code** | v1 pipeline (SDK) | $12.77 | 42m 36s | 9.0/10 |
| **Best value** | CLI Opus | $1.22 | 6m 16s | 7.7/10 |
| **Best design** | v0-sonnet-skill (SDK) | $1.57 | 7m 3s | 7.0/10 |
| **Best all-around** | CLI Opus | $1.22 | 6m 16s | 7.7/10 |

**The single biggest finding:** The design skill injected via prompt is the highest-ROI intervention across the entire experiment. It costs ~$0.20 extra and transforms generic dark UIs into distinctive, professional designs.

---

## 1. The 10 Variants

| # | Variant | Runner | Model | Tools | Design Skill |
|---|---------|--------|-------|-------|:------------:|
| 1 | v0 | SDK `query()` | Opus 4.6 | Restricted (7) | No |
| 2 | v1 | SDK pipeline | Opus 4.6 | Per-phase | No |
| 3 | v2 | SDK pipeline | Opus 4.6 + Haiku | Per-phase (optimized) | No |
| 4 | v0-sonnet | SDK `query()` | Sonnet 4.6 | Restricted (7) | No |
| 5 | v0-sonnet-skill | SDK `query()` | Sonnet 4.6 | Restricted (7) | **Prompt injection** |
| 6 | v0-sonnet-teams | SDK `query()` | Sonnet 4.6 | All tools | No |
| 7 | v0-sonnet-skill-teams | SDK `query()` | Sonnet 4.6 | All tools | **Prompt injection** |
| 8 | v0-haiku | SDK `query()` | Haiku 4.5 | Restricted (7) | No |
| 9 | cli-opus | `claude -p` | Opus 4.6 | Full CLI toolset | **In prompt** |
| 10 | cli-sonnet | `claude -p` | Sonnet 4.6 | Full CLI toolset | **In prompt** |

---

## 2. Cost & Speed Leaderboard

| Rank | Variant | Cost | Time | $/minute |
|------|---------|------|------|----------|
| 1 | v0-haiku | **$0.97** | 8m 23s | $0.12 |
| 2 | CLI Opus | $1.22 | **6m 16s** | $0.19 |
| 3 | v0-sonnet | $1.36 | 6m 41s | $0.20 |
| 4 | v0-sonnet-skill | $1.57 | 7m 3s | $0.22 |
| 5 | v0 (Opus bare) | $1.62 | 6m 27s | $0.25 |
| 6 | v0-sonnet-skill-teams | $2.06 | 5m 57s | $0.35 |
| 7 | v0-sonnet-teams | $2.18 | 8m 18s | $0.26 |
| 8 | CLI Sonnet | $2.68 | 11m 5s | $0.24 |
| 9 | v2 (optimized pipeline) | $5.24 | ~25m | $0.21 |
| 10 | v1 (pipeline) | $12.77 | 42m 36s | $0.30 |

**Key insight:** The bare-prompt approaches cluster at $1-2 and 6-8 minutes. Pipeline approaches are 3-10x more expensive for marginal quality gains. The CLI variants fall in the same range as SDK variants, meaning `claude -p` is comparable to the Agent SDK for simple tasks.

---

## 3. Code Quality Rankings (Updated with CLI variants)

| Rank | Variant | Score | Strengths | Weaknesses |
|------|---------|-------|-----------|------------|
| 1 | v1 (pipeline) | 9.0 | Strongest typing, best test assertions, SVG animations, typed fetch abstraction | $12.77 cost |
| 2 | v2 (optimized pipeline) | 8.5 | Most idiomatic Rust (FromStr, Display, const arrays), cleanest app factory | Over-permissive CORS |
| 3 | CLI Opus | 7.7 | Clean modules, bounded store with MAX_HISTORY const, responsive grid, latest deps | Duplicated hexToRgb |
| 4 | CLI Sonnet | 7.7 | Lock poisoning recovery, static slices, optimistic updates, cutting-edge CSS | Mood data in routes (not model) |
| 5 | v0 (Opus bare) | 7.5 | Good separation, working glassmorphism | Mood as String, no res.ok checks |
| 6 | v0-sonnet | 7.0 | createResource usage, clean glassmorphism | Redundant double-sort in history |
| 7 | v0-sonnet-skill | 7.0 | Only SDK variant bounding memory, film grain/scanlines | Glassmorphism mixed with noise |
| 8 | v0-sonnet-skill-teams | 6.0 | Inline RadioWave component | Mixed paradigms from subagent split |
| 9 | v0-sonnet-teams | 5.0 | Case-insensitive mood parsing | **History ordering bug**, mood data in route handler |
| 10 | v0-haiku | 4.0 | Consistent radio metaphor in messages | **Broken SPA fallback**, createEffect infinite loop risk |

**Notable:** The CLI variants (7.7) scored higher than the original SDK bare-prompt variants (7.0-7.5). The iterative development loop of `claude -p` (write → build → fix → verify) catches issues that single-shot SDK calls miss.

---

## 4. Design Quality Rankings

| Rank | Variant | Design Score | Key Visual Identity |
|------|---------|:----------:|---------------------|
| 1 | v0-sonnet-skill | 9/10 | Film grain, scanlines, "Live" badge, Libre Baskerville + Space Mono, golden accent |
| 2 | cli-sonnet | 8.5/10 | "88.7 FM" indicator, Syne font, amber accent, brutalist radio station UI |
| 3 | cli-opus | 8/10 | Space Grotesk + Libre Baskerville, gradient text, purple radial glows |
| 4 | v0-sonnet-skill-teams | 7.5/10 | DM Sans + Space Mono, amber, noise texture, radio wave bars |
| 5 | v1 (pipeline) | 7/10 | SVG concentric radio wave animation, three-color gradient |
| 6 | v0 (Opus bare) | 6/10 | Clean glassmorphism, animated bars, satellite emoji |
| 7 | v0-sonnet | 6/10 | Similar to v0, animated bars, functional but generic |
| 8 | v2 (optimized pipeline) | 5.5/10 | Static dots, Inter font (generic), no glassmorphism |
| 9 | v0-sonnet-teams | 4/10 | Purple bars, no glassmorphism, no distinctive typography |
| 10 | v0-haiku | 3.5/10 | Animated blobs, but broken styling in places |

**The design skill is the clearest differentiator in the entire experiment.** All 4 variants that received design guidance (ranks 1-4) produced visually distinctive apps with custom fonts and warm accents. The 6 without it produced similar dark-gradient UIs with system fonts.

---

## 5. Tool Usage Patterns

### 5.1 Tools That Were Never Used (Despite Being Available)

| Tool | Available In | Times Used |
|------|:-----------:|:----------:|
| EnterPlanMode | 4 variants | **0** |
| TeamCreate | 4 variants | **0** |
| SendMessage | 4 variants | **0** |
| Skill (as tool call) | 4+ variants | **0** |

**Plan mode, teams, and the Skill tool were universally ignored.** Agents preferred implicit planning (thinking blocks + TodoWrite) over formal plan mode. The Skill tool's design guidance only worked when injected directly into the prompt.

### 5.2 Tools Actually Used

| Tool | Core Use | Used By |
|------|----------|---------|
| Write | File creation | All 10 |
| Edit | Bug fixes | All 10 |
| Bash | Build/test | All 10 |
| Read | Inspect files | 9 of 10 |
| TodoWrite | Progress tracking | 4+ variants |
| Task (subagents) | Parallel work | 4 variants (v1, v2, teams variants) |
| WebSearch | Research | 2 variants (v1, v2 pipelines only) |

### 5.3 SDK vs CLI Tool Differences

| Aspect | SDK `query()` | `claude -p` CLI |
|--------|:------------:|:---------------:|
| TodoWrite | Not available (restricted) | Available and used |
| Skill tool | Not available (restricted) | Available but **unused** |
| EnterPlanMode | Not available (restricted) | Available but **unused** |
| ntfy notifications | Not available | Used by both (from CLAUDE.md) |
| Tool batching | Opus batches; Sonnet sequential | Same pattern |
| Iterative fix loop | Single-shot (no retry) | Iterative (clippy → fix → re-verify) |

**The CLI's iterative loop is a significant advantage.** Both CLI variants hit the same clippy lint (`from_str` naming), fixed it, and re-verified. SDK bare-prompt variants that hit issues during their single pass sometimes left them unfixed.

---

## 6. How They Approached the Same Prompt Differently

### 6.1 Execution Strategy by Model

**Opus (SDK and CLI):**
- Brief thinking (623 chars), then aggressive execution
- Batches 2-4 tool calls per API turn
- "Think less, do more" philosophy
- Writes files in groups, verifies at the end

**Sonnet (SDK and CLI):**
- Extensive thinking (6,000-21,000 chars) before first tool call
- Plans fonts, colors, animations, and component structure mentally
- Sequential file writes (1 per API turn in CLI)
- "Think deeply, then execute carefully"

**Haiku:**
- Minimal thinking, very fast execution
- 103 turns (most of any variant) due to many small operations
- Less coherent overall — quantity over quality

### 6.2 Unclear Instructions — How 10 Agents Diverged

The PRD had several ambiguous areas. Here's how they split:

**In-memory storage (Vec cap at 50):**
- 4 variants bound memory at the store level (v0-sonnet-skill, v0-haiku, cli-opus, cli-sonnet)
- 6 variants let the Vec grow forever — a subtle memory leak

**Vibe.mood field type:**
- 5 stored as `String` (loses type safety)
- 5 stored as `Mood` enum with serde (stronger typing)

**Test framework:**
- 6 used tower::ServiceExt + oneshot
- 3 used axum-test crate
- 1 (cli-opus) spawned a real HTTP server — true integration testing

**Glassmorphism:**
- 4 implemented real `backdrop-blur` (v0, v1, v0-sonnet, v0-sonnet-skill)
- 6 skipped it entirely or replaced with opaque panels

**Dark mode toggle:**
- All 10 implemented static dark theme with no toggle
- 100% consensus: "by default" = "only mode"

---

## 7. The Design Skill Question

### Did models use the Skill tool when available?

**No. Across all 10 variants, the Skill tool was never invoked as a tool call.**

The CLI variants had `frontend-design:frontend-design` listed in their available skills, loaded from the plugin cache, and the prompt included design guidance. Neither Opus nor Sonnet chose to invoke it as a Skill tool call. They incorporated the design guidance from the prompt text instead.

### What actually worked for design quality?

| Approach | Variants | Result |
|----------|----------|--------|
| No design guidance | v0, v1, v2, v0-sonnet, v0-haiku | Generic dark UI, system fonts |
| Skill available as tool | v0-sonnet-teams, CLI variants | **Tool ignored**, design from prompt text |
| Skill content in prompt | v0-sonnet-skill, v0-sonnet-skill-teams | **Dramatically better** design |
| Design guidance in prompt text | cli-opus, cli-sonnet | **Good** design (less impactful than full skill injection) |

**Conclusion:** Prompt injection > tool availability. The full skill file (~4,500 chars) injected via `<design-skill>` tags was the most effective. The CLI prompt's briefer design guidance (~300 chars) was partially effective. Making the Skill tool available was completely ineffective.

---

## 8. SDK vs CLI: Head-to-Head

Both the Agent SDK and `claude -p` CLI produced working apps in similar time and cost ranges:

| Metric | SDK Opus (v0) | CLI Opus | SDK Sonnet (v0-sonnet) | CLI Sonnet |
|--------|:------------:|:--------:|:----------------------:|:----------:|
| Cost | $1.62 | **$1.22** | **$1.36** | $2.68 |
| Time | 6m 27s | **6m 16s** | **6m 41s** | 11m 5s |
| Code Score | 7.5 | **7.7** | 7.0 | **7.7** |
| Design Score | 6/10 | **8/10** | 6/10 | **8.5/10** |
| Tests Pass | Yes | Yes | Yes | Yes |
| Memory Bounded | No | **Yes** | No | **Yes** |

**CLI Opus is the clear winner.** Cheaper ($1.22 vs $1.62), faster (6m16s vs 6m27s), better code (7.7 vs 7.5), better design (8/10 vs 6/10), and no memory leak. The CLI's advantages:
1. Design guidance was in the prompt
2. Iterative clippy fix loop
3. TodoWrite for progress tracking
4. Full Claude Code system prompt with coding best practices

**CLI Sonnet was surprisingly expensive** ($2.68 vs $1.36 for SDK Sonnet). Sonnet's sequential tool calls (1 per API turn) are much more costly in the CLI because each round-trip resends the full conversation context. In the SDK, the context window is smaller (no system prompt).

---

## 9. Cost Efficiency Analysis

### What drove costs?

| Cost Driver | Impact | Worst Example |
|------------|--------|---------------|
| Web research | +$6-8 | v1 pipeline (217 WebSearch/WebFetch calls) |
| Subagent overhead | +$0.50-1.00 | v0-sonnet-teams (context duplication) |
| Sequential tool calls | +$0.50-1.50 | CLI Sonnet (39 API round-trips vs Opus's 24) |
| Pipeline phases | +$3-11 | v1 (8 phases with full context each) |
| Design skill prompt | +$0.15-0.21 | v0-sonnet-skill (4,500 chars extra context) |

### Cost breakdown by category:

| Category | Variants | Avg Cost | Avg Score |
|----------|----------|----------|-----------|
| Bare prompt (restricted tools) | v0, v0-sonnet, v0-haiku | $1.32 | 6.2 |
| Bare prompt + design skill | v0-sonnet-skill | $1.57 | 7.0 |
| Full tools + teams | v0-sonnet-teams, v0-sonnet-skill-teams | $2.12 | 5.5 |
| CLI (full toolset) | cli-opus, cli-sonnet | $1.95 | 7.7 |
| Pipeline | v1, v2 | $9.01 | 8.75 |

**Best ROI:** Design skill injection (+$0.21 for +1.0 quality points). **Worst ROI:** Pipeline research phase (+$6.00 for web searches that produced zero actionable information).

---

## 10. Surprising Findings

### 1. Subagents consistently degraded code quality
Every variant that used Task to spawn subagents scored lower on code quality than its single-agent counterpart. The v0-sonnet-teams variants (5.0, 6.0) scored far below bare v0-sonnet (7.0). Subagent code suffered from duplicated mood data, broken separation of concerns, and coordination bugs.

### 2. Haiku produced the most thematically coherent messages
Despite scoring lowest on code quality (4.0), v0-haiku's radio-themed messages ("Static is just signals that haven't found their pattern") were among the most creative. Smaller models may be more "playful" in creative text generation.

### 3. CLI > SDK for single-task builds
The `claude -p` CLI outperformed the Agent SDK on both cost and quality for this task. The CLI's system prompt (coding best practices, iterative verification) and full tool access (TodoWrite, notifications) provided meaningful advantages without user effort.

### 4. 6 of 10 variants have a memory leak
Only 4 variants (v0-sonnet-skill, v0-haiku, cli-opus, cli-sonnet) bounded the in-memory Vec at 50 items. The other 6 let it grow forever. This was explicitly specified in the PRD ("cap at 50") but most variants only enforced it at read time.

### 5. The Skill tool is dead weight
Across 10 variants with various configurations, the Skill tool was never invoked as a tool call. Models don't proactively search for skills they might use. The only way to influence design quality was direct prompt injection.

### 6. Opus batches aggressively, Sonnet doesn't
CLI Opus packed 2-4 tool calls per API turn (24 calls for 38 tool invocations). CLI Sonnet issued 1 tool per turn (39 calls for 38 invocations). This batching gave Opus a 1.8x speed advantage and 2.2x cost advantage under CLI pricing.

---

## 11. Recommendations

### For small, well-defined tasks (like Mood Radio):
1. **Use `claude -p` CLI** — simpler setup than Agent SDK, comparable or better results
2. **Inject design guidance into the prompt** — highest ROI intervention
3. **Use Opus** for speed and cost efficiency (under subscription pricing)
4. **Don't bother with subagents** — single-agent is faster, cheaper, and higher quality
5. **Don't bother with web research** — models know well-established stacks

### For larger, multi-milestone projects:
1. **Pipeline approach may justify its cost** — v1/v2 scored 8.5-9.0 on code quality
2. **Route Haiku to non-critical phases** (parse, verify, report) — v2's approach saved 59%
3. **Skip the research phase** — or use adaptive light mode for known stacks
4. **Add lint gates to execute** — `cargo clippy && cargo test` before declaring done

### For design quality:
1. **Inject the full skill file into the prompt** (not as a tool)
2. **Specify distinctive font choices** in the PRD
3. **Use warm accent colors** alongside dark themes
4. **Call out specific techniques** (glassmorphism, noise textures) you want

---

## 12. Final Rankings: Overall Value (Cost × Quality × Speed)

| Rank | Variant | Cost | Time | Code | Design | Value Score |
|------|---------|------|------|:----:|:------:|:-----------:|
| 1 | **CLI Opus** | $1.22 | 6m16s | 7.7 | 8.0 | **Best overall** |
| 2 | v0-sonnet-skill | $1.57 | 7m3s | 7.0 | 9.0 | Best design/$ |
| 3 | v0 (Opus bare) | $1.62 | 6m27s | 7.5 | 6.0 | Solid baseline |
| 4 | CLI Sonnet | $2.68 | 11m5s | 7.7 | 8.5 | Good but slow |
| 5 | v0-sonnet | $1.36 | 6m41s | 7.0 | 6.0 | Cheap but plain |
| 6 | v2 (optimized pipeline) | $5.24 | ~25m | 8.5 | 5.5 | Code > design |
| 7 | v0-sonnet-skill-teams | $2.06 | 5m57s | 6.0 | 7.5 | Fast, mixed quality |
| 8 | v1 (pipeline) | $12.77 | 42m36s | 9.0 | 7.0 | Overkill for scope |
| 9 | v0-sonnet-teams | $2.18 | 8m18s | 5.0 | 4.0 | Subagents hurt |
| 10 | v0-haiku | $0.97 | 8m23s | 4.0 | 3.5 | Cheapest, buggiest |

---

## 13. Methodology Notes

- All variants built from the same PRD (prompt.md for SDK, cli-prompt.md for CLI)
- All quality checks: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo build`, `cargo test`, `cd web && bun install && bun run build`
- All 10 variants pass all 5 quality checks
- Screenshots captured with agent-browser at 1280x900 viewport
- Cost data from SDK `result.json` files and CLI `result` JSONL events
- Code scores assigned by senior-engineer-level deep review of all source files
- Design scores assigned by visual comparison of screenshots

## Supporting Analysis Files

| File | Content |
|------|---------|
| `07-three-way-comparison.md` | v0/v1/v2 Opus comparison |
| `08-sonnet-variants-comparison.md` | 5 Sonnet variants + leaderboard |
| `09-deep-code-investigation.md` | Deep code review of 8 SDK variants |
| `cli-comparison-data.md` | Raw JSONL parsing for CLI variants |
| `cli-deep-code-review.md` | Deep code review of CLI variants |
| `tool-usage-investigation.md` | Complete tool availability vs usage matrix |
| `unclear-instructions-investigation.md` | How 10 variants handled ambiguous PRD areas |
| `screenshots/` | 20 screenshots (homepage + with-vibe for all 10) |
