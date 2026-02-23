# Milestone Report: v0.4 — Developer Experience Polish

## 1. Summary

Milestone v0.4 transforms devrig from a functional orchestrator into a polished developer tool. Six features were implemented: `devrig validate` with rustc-style diagnostic errors, automatic config file watching with hot reload, crash recovery with exponential backoff and configurable per-service restart policies, `devrig logs` with filtering/search/export, shell completions for bash/zsh/fish, and a colored structured terminal UI using `comfy-table` and `owo-colors`. All 34 verification checks pass, with 173 unit tests and 43 integration tests green.

## 2. Features Implemented

### 2.1 `devrig validate` with Helpful Error Messages — COMPLETE

Rewrote `src/config/validate.rs` to produce miette-powered diagnostic errors with source spans, line numbers, underlined problem locations, and "did you mean?" suggestions via `strsim::jaro_winkler`. The `validate()` signature now accepts raw TOML source and filename to construct `NamedSource<String>` for byte-offset error highlighting.

Key design decision: instead of using `toml::Spanned<T>` on `depends_on` fields (which would have required touching every file that accesses dependency names), byte offsets are computed by searching the raw TOML source at validation time. This avoided the ripple effect identified as the #1 risk in research.

Example output for an invalid config:
```
  × unknown dependency `nonexistent`
   ╭─[devrig.toml:5:16]
 4 │ command = "echo hi"
 5 │ depends_on = ["nonexistent"]
   ·                ─────┬─────
   ·                     ╰── service `api` depends on `nonexistent`, which does not exist
   ╰────
  help: available resources: ["api"]
```

**Files created:** `src/commands/validate.rs`
**Files modified:** `src/config/validate.rs` (rewrite), `src/config/mod.rs`, `src/cli.rs`, `src/commands/mod.rs`, `src/main.rs`
**New dependency:** `strsim = "0.11"`

### 2.2 Config File Watching (Auto-restart on devrig.toml Changes) — COMPLETE

Implemented config file watching using `notify` + `notify-debouncer-mini` with 500ms debounce. Watches the parent directory (not the file itself) to handle vim/emacs atomic saves correctly. On change: re-reads file, parses TOML, validates (rejects invalid configs with miette diagnostic logged to terminal), computes diff, and applies changes.

The `ConfigDiff` struct identifies added/removed/changed services and infra by comparing `BTreeMap` keys and using `PartialEq` on config structs. The watcher starts only after Phase 5 completes to avoid races during startup. Project name changes are rejected during hot reload with a message instructing the user to run `devrig delete && devrig start`.

Conservative reload strategy: if any infra changes, the user is told to restart. Only service additions/removals/changes get targeted operations. Transitive dependency cascade optimization deferred to a future milestone.

**Files created:** `src/config/watcher.rs`, `src/config/diff.rs`
**Files modified:** `src/config/mod.rs`, `src/config/model.rs` (PartialEq derives), `src/orchestrator/mod.rs`

### 2.3 Crash Recovery with Exponential Backoff — COMPLETE

Enhanced the existing supervisor with explicit state tracking and configurable policies. The pre-existing equal jitter exponential backoff algorithm was retained (correct for process supervision).

Additions to `src/orchestrator/supervisor.rs`:
- **`ServicePhase` enum:** `Initial`, `Starting`, `Running`, `Backoff { attempt }`, `Failed { reason }`, `Stopped` — replaces implicit state tracking
- **`RestartMode` enum:** `Always`, `OnFailure` (default), `Never` — exit code 0 with `OnFailure` does not trigger restart
- **`startup_grace` period** (default 2s): processes that exit before this threshold are classified as startup failures with a lower retry budget (`startup_max_restarts`, default 3)
- **Crash rate detection:** 5 crashes within 30 seconds triggers immediate `Failed` transition
- **Per-service TOML configuration** under `[services.*.restart]` with fields: `policy`, `max_restarts`, `startup_max_restarts`, `startup_grace_ms`, `initial_delay_ms`, `max_delay_ms`

**Files modified:** `src/orchestrator/supervisor.rs`, `src/config/model.rs` (RestartConfig struct), `src/orchestrator/mod.rs`

### 2.4 `devrig logs` Filtering, Search, and Export — COMPLETE

Added `devrig logs` subcommand with comprehensive filtering and export capabilities.

**Log pipeline overhaul:** Replaced `mpsc` channel with `tokio::sync::broadcast` (4096 buffer) for fan-out. Added a JSONL file writer task that persists all logs to `.devrig/logs/current.jsonl`. Added `LogBuffer` (ring buffer via `VecDeque<LogLine>` behind `Arc<RwLock<>>`, 10,000 line capacity).

**LogLine enhancements:** Added `timestamp: DateTime<Utc>` and `level: Option<LogLevel>`. Log level detection via regex matching common formats (`[INFO]`, `level=info`, `"level":"info"`, bare `WARN`/`ERROR`, etc.).

**CLI flags:** `--follow` (`-f`), `--tail N`, `--since <duration|RFC3339>`, `--grep` (`-g`), `--exclude` (`-v`), `--level` (`-l`), `--format text|json`, `--output` (`-o`), `--timestamps` (`-t`).

**`LogFilter` struct** applies a predicate chain (service filter AND level filter AND regex include AND regex exclude) — same pattern used by stern and docker compose logs.

Since `devrig logs` runs as a separate process, it reads from the JSONL file (not the in-memory broadcast channel). `--follow` uses `notify` to watch the file for appends.

**Files created:** `src/commands/logs.rs`, `src/ui/filter.rs`, `src/ui/buffer.rs`
**Files modified:** `src/ui/logs.rs`, `src/ui/mod.rs`, `src/orchestrator/mod.rs`, `src/orchestrator/supervisor.rs`, `src/cli.rs`, `src/commands/mod.rs`, `src/main.rs`

### 2.5 Shell Completions (bash, zsh, fish) — COMPLETE

Added `devrig completions <shell>` subcommand using `clap_complete::aot::generate()`. Generates completion scripts to stdout for bash (931 lines), zsh (604 lines), and fish (114 lines). Added `ValueHint::FilePath` to the `-f`/`--file` global argument for better path completions.

Installation one-liners documented in configuration guide:
- Bash: `devrig completions bash > ~/.local/share/bash-completion/completions/devrig`
- Zsh: `devrig completions zsh > ~/.zfunc/_devrig`
- Fish: `devrig completions fish > ~/.config/fish/completions/devrig.fish`

**Files modified:** `src/cli.rs`, `src/main.rs`
**New dependency:** `clap_complete = "4.5"`

### 2.6 Colored, Structured Terminal UI — COMPLETE

Replaced raw ANSI escape codes with `owo-colors` throughout the UI layer. Replaced manual padding in startup summary with `comfy-table` for box-drawing bordered tables with automatic column alignment.

**Startup summary** (`src/ui/summary.rs`): Structured into separate Services/Infrastructure/Cluster sections. Status indicators use green for running/ready, yellow for backoff, red for failed. URLs colored cyan. Auto-assigned ports show `(auto)` suffix dimmed.

**Log output** (`src/ui/logs.rs`): Optional timestamps (dimmed HH:MM:SS), colored log levels (TRACE dimmed, DEBUG blue, INFO green, WARN yellow, ERROR red), dimmed pipe separators, stderr lines in red. Stdout wrapped in `BufWriter` with periodic flush for performance.

**Status event lines** interleaved with log output for crash/restart events (e.g., `devrig: api crashed (exit 1), restarting in 2s (attempt 3/10)` in yellow).

No ratatui — devrig is a launch-and-stream tool, not an interactive explorer. This matches docker compose's approach.

**Files modified:** `src/ui/summary.rs` (rewrite), `src/ui/logs.rs` (rewrite), `src/orchestrator/mod.rs`
**New dependency:** `comfy-table = "7"`

## 3. Architecture

### 3.1 Dependency Changes

Three new crates added to `Cargo.toml`:
- `clap_complete = "4.5"` — shell completion generation
- `strsim = "0.11"` — string similarity for validation suggestions
- `comfy-table = "7"` — table formatting with box-drawing borders

Several existing but previously unused crates were activated: `miette` (validation diagnostics), `owo-colors` (colored output), `notify`/`notify-debouncer-mini` (config watching, previously only used for cluster deploy watching).

### 3.2 Log Pipeline Architecture

```
Supervisors → broadcast::Sender<LogLine>(4096)
    ├─ Fan-out task → mpsc → LogWriter (terminal display, filtered, colored)
    ├─ Fan-out task → mpsc → JSONL file writer (.devrig/logs/current.jsonl)
    ├─ Fan-out task → LogBuffer (VecDeque ring buffer, Arc<RwLock<>>)
    └─ (future: devrig logs live subscribers)
```

The broadcast channel handles fan-out. Each consumer subscribes via `log_tx.subscribe()`. `RecvError::Lagged(n)` is handled gracefully with a warning. The JSONL file is truncated on each `devrig start` for a fresh session log.

### 3.3 Config Reload Pipeline

```
notify (parent dir watch) → debounce (500ms) → re-read file → parse TOML
    → validate (reject invalid, log miette error, keep old config)
    → diff_configs(old, new) → ConfigDiff
    → apply: stop removed, restart changed, start added
```

### 3.4 Key Design Decisions

1. **Source text search over `Spanned<T>`** for validation byte offsets — avoids invasive refactor across the codebase
2. **Conservative config reload** — infra changes require manual restart; service changes are targeted
3. **Enhance supervisor, don't rewrite** — existing backoff algorithm was correct; added explicit state machine and configurability on top
4. **JSONL file for `devrig logs`** — since it runs as a separate process, it reads the persisted log file rather than connecting to the in-memory broadcast channel
5. **No ratatui** — alternate screen mode would break piping, copy-paste, and scrollback

### 3.5 New Module Map

```
src/commands/validate.rs    — devrig validate command handler
src/commands/logs.rs        — devrig logs command with filtering/export
src/config/watcher.rs       — Config file watching with debounce
src/config/diff.rs          — ConfigDiff computation (old vs new config)
src/ui/filter.rs            — LogFilter predicate chain
src/ui/buffer.rs            — Ring buffer for log history
```

## 4. Tests

### 4.1 Unit Tests — 173 passing

| Module | Count | What's Tested |
|--------|-------|---------------|
| `config::validate` | 26 | Miette diagnostics rendering, source spans, "did you mean?" suggestions, all error variants |
| `config::model` | 38 | RestartConfig parsing (all fields, defaults, invalid values), existing model tests |
| `config::diff` | 6 | Services added/removed/changed, infra changes, global env changes, project name change detection |
| `config::interpolate` | 7 | Existing interpolation tests (unchanged) |
| `orchestrator::graph` | 20 | Existing dependency graph tests (unchanged) |
| `orchestrator::supervisor` | 10 | ServicePhase transitions, exit code 0 with OnFailure, startup failure classification, crash rate detection, RestartMode::Never, from_config construction |
| `ui::filter` | 7 | Service filter, level filter, regex include/exclude, combined filters, empty filter matches all |
| `ui::buffer` | 4 | Ring buffer capacity, oldest evicted, time-based queries |
| `ui::logs` (log level) | 8 | Level detection across formats: `[INFO]`, `level=info`, `"level":"info"`, bare keywords |
| `identity` | 4 | Existing identity tests (unchanged) |
| Other | 43 | Remaining existing tests |

### 4.2 Integration Tests — 43 passing

New tests for v0.4:

| Test File | Tests | What's Verified |
|-----------|-------|-----------------|
| `tests/integration/validate_command.rs` | 4 | Valid config exits 0 with success message; invalid config exits 1 with miette diagnostic containing source span |
| `tests/integration/completions.rs` | 3 | `devrig completions bash/zsh/fish` each produce non-empty output containing "devrig" |
| `tests/integration/crash_recovery.rs` | 2 | Service exits non-zero → restarts with backoff; service exits 0 with `on-failure` → no restart (clean exit) |
| `tests/integration/config_diff.rs` | 1+ | Config diff detection |

Pre-existing integration tests all pass (start_stop, infra_lifecycle, service_discovery, init_scripts, cluster_lifecycle, etc.).

### 4.3 Fix Passes

Two fix passes were required to reach 34/34 verification checks:

**Pass 1 (7 fixes):** `cargo fmt`, clippy warnings (unused imports, dead code, collapsible-if), mpsc→broadcast migration in supervisor, `infra_env_vars_injected` test timeout (exit code 0 no longer restarts under default `OnFailure` policy — changed test command from `env` to `env && sleep 60`), added `clean_exit_no_restart` integration test.

**Pass 2 (1 fix):** `init_scripts::init_scripts_run_once` flaky timeout — increased `state.json` wait timeout from 10s to 30s, added child process health check for early failure detection.

## 5. Documentation

### Updated Files

**`docs/guides/configuration.md`** — Updated with:
- `[services.*.restart]` section documenting all restart config fields with defaults and examples
- `devrig validate` command reference with example output
- `devrig logs` command reference with all flags and examples
- `devrig completions` command with shell-specific installation instructions
- Config watching behavior explanation (auto-reload on save, invalid config rejected)

No new documentation files were created — all v0.4 features are enhancements to existing concepts.

## 6. Verification Status

**34/34 checks passed.** Full breakdown:

| Category | Checks | Status |
|----------|--------|--------|
| Build quality (fmt, clippy, build) | 3 | All pass |
| Unit tests (173) | 1 | Pass |
| Integration tests (43) | 1 | Pass |
| New dependencies present | 1 | Pass |
| CLI commands registered (validate, logs, completions) | 1 | Pass |
| Validate command (valid + invalid config) | 2 | Pass |
| Shell completions output (bash, zsh, fish) | 1 | Pass |
| RestartConfig parsing | 1 | Pass |
| New source files exist (6 files) | 1 | Pass |
| Crate usage verification (miette, owo-colors, comfy-table, broadcast) | 4 | Pass |
| LogLine has timestamp and level | 1 | Pass |
| JSONL log file written | 1 | Pass |
| Config watcher implemented | 1 | Pass |
| Config diff implemented | 1 | Pass |
| Supervisor has ServicePhase | 1 | Pass |
| Pre-existing tests pass (unit + integration) | 2 | Pass |
| Configuration guide updated | 1 | Pass |
| New unit test coverage thresholds | 6 | All pass |
| New integration test coverage thresholds | 3 | All pass |
| No leaked Docker resources | 1 | Pass |

## 7. Known Issues

1. **Cosmetic warning:** One unused import in `tests/integration/config_diff.rs` — does not affect functionality or test results.

2. **Conservative infra reload:** Config watcher does not hot-reload infrastructure changes (port changes, image changes). Users are told to restart manually. This is intentional for v0.4 safety; targeted infra reload can be optimized later.

3. **No live log streaming between processes:** `devrig logs` reads from the JSONL file, not a live socket. This means there's a small write-flush delay. A Unix domain socket for real-time streaming is a potential future enhancement.

4. **`_phase` variable in supervisor:** The `ServicePhase` tracking variable is prefixed with `_` to suppress clippy warnings — it's set but not yet exposed to external consumers. It's ready for UI integration (e.g., a future `devrig status` dashboard command).

5. **init_scripts test sensitivity:** The `init_scripts_run_once` test required a timeout increase (10s → 30s) under heavy CI load. It passes reliably now but could be sensitive in resource-constrained environments.

## 8. Next Milestone Context

### What v0.5 Should Know

1. **Log pipeline is broadcast-based.** New log consumers (e.g., a `devrig status` live dashboard) can subscribe via `log_tx.subscribe()` in `src/orchestrator/mod.rs`. The `LogLine` struct includes `timestamp`, `level`, `service`, `text`, and `is_stderr`.

2. **JSONL log file at `.devrig/logs/current.jsonl`.** Any tool that needs to read historical logs can deserialize `LogLine` from this file. It's truncated on each `devrig start`.

3. **`ServicePhase` is tracked but not externally exposed yet.** The supervisor sets `_phase` on every state transition. Exposing it via a channel to a `devrig status` command or the startup summary would be straightforward.

4. **Config watcher sends `ConfigDiff` via mpsc channel.** The orchestrator's main loop selects on this channel. New diff fields (e.g., compose changes, cluster config changes) can be added to `ConfigDiff` in `src/config/diff.rs`.

5. **`PartialEq` on `ServiceConfig` and `InfraConfig`** enables config diffing. Any new config types that need diff detection should also derive `PartialEq`.

6. **`validate()` requires source text and filename.** All callers must provide the raw TOML string and filename for miette diagnostics. The tuple `(DevrigConfig, String)` is returned by `load_config()`.

7. **`RestartConfig` is optional per-service.** Defaults are applied when not specified. The `RestartPolicy::from_config()` constructor handles the `Option<RestartConfig>` → `RestartPolicy` conversion.

8. **Infra hot-reload is intentionally conservative.** If v0.5 needs infra hot-reload, implement the transitive dependency cascade in `src/orchestrator/mod.rs` — when an infra container's port changes, restart all services that depend on it (walk the dependency graph from `src/orchestrator/graph.rs`).

9. **Shell completions are runtime-generated.** For release archives with pre-generated completions, add `build.rs` with `clap_complete::aot::generate_to()`. Not needed unless creating distribution packages.

10. **Three new crates in dependency tree:** `clap_complete` (4.5), `strsim` (0.11), `comfy-table` (7). All are well-maintained, widely-used crates with no known security issues.
