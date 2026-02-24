# CLI Agent Comparison: Opus 4.6 vs Sonnet 4.6

Raw metrics extracted from JSONL log files for two Claude Code CLI runs building the same "Mood Radio" full-stack app (Rust/Axum backend + SolidJS frontend).

## Source Files

| | Opus | Sonnet |
|---|---|---|
| Log file | `logs/cli-opus.jsonl` | `logs/cli-sonnet.jsonl` |
| Model | `claude-opus-4-6` | `claude-sonnet-4-6` |
| CLI version | 2.1.50 | 2.1.50 |
| Permission mode | `bypassPermissions` | `bypassPermissions` |

---

## 1. Timing

| Metric | Opus | Sonnet | Delta |
|---|---|---|---|
| Wall clock time | 376.5s (6m 16s) | 665.1s (11m 5s) | Opus **1.8x faster** |
| API time | 260.2s (4m 20s) | 549.4s (9m 9s) | Opus **2.1x faster** |
| Non-API overhead | 116.2s | 115.6s | ~equal (tool execution) |
| API time as % of wall clock | 69.1% | 82.6% | Sonnet spent more time waiting on API |

Opus completed the task in roughly half the wall clock time. The non-API overhead (local tool execution -- cargo builds, bun installs, etc.) was nearly identical (~116s), confirming the speed difference is entirely in model inference/generation time. However, Sonnet also issued more API calls (39 vs 24), contributing to its longer API time.

---

## 2. Turns and API Calls

| Metric | Opus | Sonnet |
|---|---|---|
| Reported `num_turns` (from result event) | 39 | 39 |
| Unique API calls (distinct message IDs) | 24 | 39 |
| API calls with tool use | 23 | 38 |
| Total tool invocations | 38 | 38 |
| Assistant event lines in JSONL | 48 | 50 |

Both models made exactly 38 tool invocations and the result event reports 39 turns for each. The key structural difference: **Opus batched heavily** -- it packed multiple tool calls into fewer API calls (24 unique messages, many containing 2-4 tool calls each), while **Sonnet issued one tool call per API call** for most of its 39 messages. This batching is a major reason Opus was faster: fewer round-trips.

### Opus batching examples:
- One API call with `Write` x4 (four files in parallel)
- One API call with `Write` x3
- One API call with `Bash` x2 (check directory + check toolchain)
- One API call with `Edit` x2 (fix both files simultaneously)

### Sonnet's sequential pattern:
- 18 consecutive single-`Write` API calls (one file per call)
- Each `Bash` command was its own API call

---

## 3. Tool Usage Breakdown

| Tool | Opus | Sonnet |
|---|---|---|
| **Write** | 18 | 18 |
| **Bash** | 13 | 15 |
| **TodoWrite** | 4 | 3 |
| **Edit** | 2 | 2 |
| **Read** | 1 | 0 |
| **Glob** | 0 | 0 |
| **Grep** | 0 | 0 |
| **Skill** | 0 | 0 |
| **Task** | 0 | 0 |
| **WebSearch** | 0 | 0 |
| **WebFetch** | 0 | 0 |
| **Total** | **38** | **38** |

The tool profiles are remarkably similar. Both wrote 18 files and made 2 edits (to fix the same `from_str` clippy lint). Opus used `Read` once (to inspect the clippy error context); Sonnet did not. Sonnet used 2 more Bash calls, likely for additional verification steps.

---

## 4. Special Tool Checks

### Skill tool (particularly `frontend-design`)

| | Opus | Sonnet |
|---|---|---|
| Skill tool invoked? | **No** | **No** |
| `frontend-design` skill used? | **No** | **No** |

Neither model invoked the Skill tool despite the `frontend-design` skill being listed as available in both init events. Both models had access to:
- `frontend-design:frontend-design`
- `keybindings-help`, `debug`, `ycf`, `agent-browser`

The `frontend-design` plugin was loaded from `/home/steve/.claude/plugins/cache/claude-plugins-official/frontend-design/aa296ec81e8c` in both sessions. Neither model chose to use it, instead relying on their own knowledge for CSS/design decisions.

### Task tool (subagents/teams)

| | Opus | Sonnet |
|---|---|---|
| Task tool invoked? | **No** | **No** |
| TeamCreate used? | **No** | **No** |
| SendMessage used? | **No** | **No** |

Neither model spawned subagents or created teams. Both treated this as a single-agent task.

### TodoWrite

| | Opus | Sonnet |
|---|---|---|
| TodoWrite used? | **Yes** (4 times) | **Yes** (3 times) |

Both used TodoWrite for progress tracking. Opus updated it 4 times (5-item plan: backend, tests, frontend, verify backend, verify frontend). Sonnet updated it 3 times (3-item plan: backend, frontend, run checks). Opus's plan was more granular.

---

## 5. Token Usage

From the authoritative `result` event:

| Metric | Opus | Sonnet | Notes |
|---|---|---|---|
| Input tokens | 25 | 40 | Negligible (non-cached input) |
| Output tokens | 15,189 | 38,867 | Sonnet output **2.6x more** |
| Cache creation tokens | 54,790 | 78,584 | Sonnet created 44% more cache |
| Cache read tokens | 985,625 | 2,413,251 | Sonnet read **2.5x more** cache |
| **Total tokens** | **1,055,629** | **2,530,742** | Sonnet used **2.4x more** total |

### Why Sonnet used more tokens:

1. **More API round-trips (39 vs 24)**: Each round-trip resends the full conversation context via cache reads, so 15 more calls means 15 more full context passes.
2. **More output tokens (38,867 vs 15,189)**: Sonnet generated 2.6x more output. This is partly due to extensive extended thinking (21,398 chars vs 623 chars for Opus), and partly because each additional API call adds some output overhead.
3. **Extended thinking volume**: Sonnet's 4 thinking blocks totaled 21,398 characters. Opus had 1 thinking block of 623 characters. Sonnet's thinking included detailed design deliberation, dependency version analysis, and mental code drafting before writing files.

### Per-model breakdown (from `modelUsage`):

**Primary model:**

| | Opus (claude-opus-4-6) | Sonnet (claude-sonnet-4-6) |
|---|---|---|
| Input tokens | 25 | 40 |
| Output tokens | 15,189 | 38,867 |
| Cache creation | 54,790 | 78,584 |
| Cache read | 985,625 | 2,413,251 |
| Cost (reported) | $1.2151 | $2.6697 |

**Secondary model (both used claude-haiku-4.5 for internal tasks):**

| | Opus session | Sonnet session |
|---|---|---|
| Haiku input tokens | 7,104 | 6,784 |
| Haiku output tokens | 352 | 416 |
| Haiku cost | $0.0089 | $0.0089 |

Both sessions used Haiku 4.5 for auxiliary tasks (likely tool result summarization or context management), with nearly identical usage.

---

## 6. Cost

### Reported by Claude Code (`total_cost_usd` from result event):

| | Opus | Sonnet |
|---|---|---|
| Total cost (reported) | **$1.22** | **$2.68** |
| Primary model cost | $1.2151 | $2.6697 |
| Haiku cost | $0.0089 | $0.0089 |

### Manual calculation at list API pricing:

| Component | Opus | Sonnet |
|---|---|---|
| Input tokens | $0.0004 (25 x $15/M) | $0.0001 (40 x $3/M) |
| Output tokens | $1.1392 (15,189 x $75/M) | $0.5830 (38,867 x $15/M) |
| Cache creation | $1.0273 (54,790 x $18.75/M) | $0.2947 (78,584 x $3.75/M) |
| Cache read | $1.4784 (985,625 x $1.50/M) | $0.7240 (2,413,251 x $0.30/M) |
| **Total (list price)** | **$3.65** | **$1.60** |

### Cost analysis:

The **reported cost** ($1.22 for Opus, $2.68 for Sonnet) differs significantly from the **list API pricing** calculation ($3.65 for Opus, $1.60 for Sonnet). The Claude Code CLI likely uses different internal pricing or applies discounts (e.g., Max subscription pricing). Under the CLI's own accounting, **Sonnet was 2.2x more expensive than Opus** despite lower per-token rates -- because it used 2.4x more total tokens.

Under raw API list pricing, **Opus would be 2.3x more expensive** than Sonnet, because Opus's per-token rates are 5x higher even though it used fewer tokens.

The takeaway depends on pricing model:
- **Claude Code subscription**: Opus was cheaper ($1.22 vs $2.68) because token efficiency mattered more
- **Raw API pricing**: Opus would be more expensive ($3.65 vs $1.60) because per-token rates dominate

---

## 7. Extended Thinking Analysis

### Opus: Minimal thinking (1 block, 623 characters)

Opus produced a single, concise thinking block at the start:

> Let me build the Mood Radio app from scratch. This is a substantial full-stack project with a Rust/Axum backend and SolidJS frontend. Let me plan the approach and then execute.
>
> I'll need to:
> 1. Set up the Rust backend with Cargo.toml
> 2. Create all backend source files (main.rs, routes.rs, models.rs, store.rs)
> 3. Create integration tests
> 4. Set up the SolidJS frontend with all components
> 5. Ensure everything builds and passes checks
>
> Let me start by creating all the files. I'll work on backend and frontend in parallel where possible.

This is a brief plan, then immediate execution. Opus appeared to generate code directly in tool call outputs without extensive pre-planning.

### Sonnet: Extensive thinking (4 blocks, 21,398 characters)

Sonnet's thinking was dramatically more detailed:

**Block 1 (6,349 chars)**: Analyzed the task, reviewed MEMORY.md for context about prior implementations, deliberated extensively on frontend design aesthetic. Went through multiple design iterations in thinking:
- First considered "editorial brutalist" with sharp outlines and monospaced terminal look
- Reconsidered against PRD requirements ("lo-fi radio aesthetic with glassmorphism")
- Settled on "Syne ExtraBold" + "Space Mono" typography, amber accents, animated frequency bars
- Explicitly decided NOT to use Task tool ("I should handle this myself rather than delegating")

**Block 2 (14,612 chars)**: The largest thinking block. Mentally drafted the entire project structure, reasoned through dependency versions (axum-test 14 vs 15), planned CSS animations, worked through Tailwind v4 `@theme` syntax, mentally composed significant portions of the code before writing it. Essentially "coded in thinking" before emitting tool calls.

**Block 3 (155 chars)**: Brief -- fix the `from_str` clippy lint by renaming to `parse_mood`.

**Block 4 (282 chars)**: Verification checklist confirming all builds pass.

### Thinking style comparison:

| Aspect | Opus | Sonnet |
|---|---|---|
| Total thinking volume | 623 chars | 21,398 chars (**34x more**) |
| Thinking blocks | 1 | 4 |
| Pre-planning depth | Brief 5-item checklist | Detailed multi-page design deliberation |
| Design process | Implicit (in output) | Explicit (in thinking) |
| Code drafting in thinking | None visible | Extensive mental code composition |
| Decision documentation | Minimal | Documented alternatives and rationale |

---

## 8. Execution Strategy Comparison

### Opus approach: "Batch and execute"
1. Brief plan (623 chars of thinking)
2. Check directory + toolchain (2 Bash calls in 1 API call)
3. Set up TodoWrite with 5-item plan
4. Write backend files in batches of 3-4 per API call
5. Run cargo fmt/clippy/build/test
6. Fix clippy issue (2 edits in 1 API call)
7. Write frontend files in batches of 3-4 per API call
8. Run bun install + build
9. Final verification

**Key characteristic**: Aggressive tool call batching. Multiple Write calls per API turn. Minimal text output between actions.

### Sonnet approach: "Think deeply, execute sequentially"
1. Extensive thinking (6,349 chars analyzing the task and designing the UI)
2. Check directory state
3. More thinking (14,612 chars mentally drafting all code)
4. Set up TodoWrite with 3-item plan
5. Write all 18 files one-by-one (1 Write per API call)
6. Run cargo checks
7. Fix clippy issue (2 edits across 2 API calls)
8. Run frontend build
9. Final verification

**Key characteristic**: Heavy upfront thinking, then sequential file writes. Each file got its own API call, even simple ones.

---

## 9. Structural Comparison

### API call structure (Opus -- 24 calls):
```
thinking + Bash + Bash          # inspect + check toolchain
Bash                            # ntfy notification
TodoWrite                       # 5-item plan
text + Write + Bash             # write files + start build
Write + Write + Write           # 3 files in batch
Write + Write + Write           # 3 files in batch
text + Bash                     # run cargo checks
Bash                            # cargo clippy
Bash                            # cargo build
text + Read                     # read clippy error
Edit + Edit                     # fix both files
Bash                            # cargo test
Bash                            # verify all pass
text + TodoWrite                # update progress
text + Write x4                 # 4 frontend files
Write + Write + Write           # 3 more files
text + Write x4                 # 4 more files
text + TodoWrite                # update progress
Bash                            # bun install
Bash                            # bun build
text + Bash                     # final verification
TodoWrite                       # mark all complete
Bash                            # ntfy done
text                            # summary
```

### API call structure (Sonnet -- 39 calls):
```
thinking + Bash                 # check directory
Bash                            # ntfy notification
thinking + Bash                 # check directory again (redundant?)
TodoWrite                       # 3-item plan
Bash                            # mkdir src
text + Write                    # Cargo.toml
Write                           # models.rs
Write                           # store.rs
Write                           # routes.rs
Write                           # lib.rs
Write                           # main.rs
Write                           # api_tests.rs
text + Write                    # package.json
Write                           # index.html
Write                           # vite.config.ts
Write                           # index.tsx
Write                           # api.ts
Write                           # index.css
Write                           # MoodPicker.tsx
Write                           # VibeCard.tsx
Write                           # History.tsx
Write                           # App.tsx
Write                           # tsconfig.json
TodoWrite                       # update progress
text + Bash                     # cargo fmt
Bash                            # cargo clippy
Bash                            # cargo build
Bash                            # cargo test
thinking + text + Edit          # fix from_str (models)
Edit                            # fix from_str (routes)
Bash                            # cargo clippy (re-verify)
Bash                            # cargo test (re-verify)
Bash                            # bun install
text + Bash                     # bun build
Bash                            # final verification
thinking + text + Bash          # one more verification
text + TodoWrite                # mark complete
Bash                            # ntfy done
text                            # summary
```

---

## 10. Summary Table

| Metric | Opus 4.6 | Sonnet 4.6 | Winner |
|---|---|---|---|
| Wall clock time | **6m 16s** | 11m 5s | Opus (1.8x faster) |
| API time | **4m 20s** | 9m 9s | Opus (2.1x faster) |
| API calls | **24** | 39 | Opus (38% fewer) |
| Tool invocations | 38 | 38 | Tie |
| Output tokens | **15,189** | 38,867 | Opus (2.6x fewer) |
| Total tokens | **1,055,629** | 2,530,742 | Opus (2.4x fewer) |
| Cost (CLI reported) | **$1.22** | $2.68 | Opus (2.2x cheaper) |
| Cost (list API pricing) | $3.65 | **$1.60** | Sonnet (2.3x cheaper) |
| Thinking depth | 623 chars | **21,398 chars** | Sonnet (more deliberative) |
| Tool batching | **Multi-tool per call** | 1 tool per call | Opus (more efficient) |
| Used Skill tool? | No | No | -- |
| Used Task tool? | No | No | -- |
| Used TodoWrite? | Yes (4x) | Yes (3x) | -- |
| Used frontend-design? | No | No | -- |
| Files written | 18 | 18 | Tie |
| Errors encountered | 1 (clippy lint) | 1 (clippy lint) | Tie |
| Final result | All checks pass | All checks pass | Tie |

---

## 11. Key Findings

1. **Neither model used the Skill tool or the `frontend-design` skill**, despite it being available. Both relied on their own knowledge for design decisions.

2. **Neither model used the Task tool (subagents/teams)**. Both treated the full-stack build as a single-agent task. Sonnet explicitly considered and rejected delegation in its thinking: "I should handle this myself rather than delegating to a task since it needs careful coordination."

3. **Neither model used `Task` (the subagent spawning tool)** -- both only used `TodoWrite` for simple checklist tracking.

4. **Opus's aggressive tool batching was the primary speed advantage.** By packing 2-4 tool calls per API turn, Opus cut its API calls from ~39 to 24, saving ~15 round-trips worth of context resending and inference time.

5. **Sonnet's extended thinking was 34x more verbose** but produced the same functional outcome. The extra thinking covered design deliberation, dependency version analysis, and mental code drafting -- all of which Opus apparently did implicitly.

6. **The "same task, same tools, same outcome" pattern** makes this a clean comparison. Both models wrote exactly 18 files, made 2 edits for the same clippy lint, ran similar verification suites, and produced working apps. The differences are purely in execution strategy and efficiency.

7. **Cost depends on pricing model.** Under Claude Code's internal pricing, Opus was cheaper due to fewer tokens. Under raw API list pricing, Opus would be more expensive due to higher per-token rates. This is an important distinction for evaluating cost-effectiveness.

8. **Both models used Haiku 4.5 as a secondary model** for auxiliary tasks (likely context management or tool result summarization), with nearly identical usage (~7K input tokens, ~400 output tokens, $0.009 cost).
