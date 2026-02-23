# Implementation Plan — v0.4: Developer Experience Polish

## Overview

Milestone v0.4 transforms devrig from a functional but rough orchestrator into a polished developer tool with rich error diagnostics, self-healing config reload, robust crash recovery, powerful log management, shell completions, and a structured colored terminal UI. This milestone touches every layer — config parsing, validation, orchestrator, supervisor, CLI, and UI — but adds no new infrastructure modules.

By the end of v0.4:
- `devrig validate` produces rustc-style diagnostic errors with source spans and "did you mean?" suggestions
- Config file changes are detected and applied automatically (add/remove/restart services as needed)
- Crash recovery distinguishes startup failures from runtime crashes, with configurable per-service restart policies
- `devrig logs` supports service filtering, regex search, log level detection, timestamps, and JSONL export
- `devrig completions <shell>` generates completions for bash, zsh, and fish
- Terminal output uses `owo-colors` for consistent coloring and `comfy-table` for structured startup summaries

---

## Architecture Overview

### Dependency Changes (Cargo.toml)

**Add:**
```toml
clap_complete = "4.5"    # Shell completion generation
strsim = "0.11"          # String similarity for "did you mean?" suggestions
comfy-table = "7"        # Pretty-printed tables with box-drawing borders
```

**Already present, now actively used:**
- `miette = "7"` with `features = ["fancy"]` — currently in Cargo.toml but **unused**. v0.4 activates it for validation diagnostics.
- `owo-colors = "4"` — currently in Cargo.toml but **unused** (logs use raw ANSI escapes). v0.4 adopts it throughout.
- `notify = "8"` + `notify-debouncer-mini = "0.5"` — currently only used for cluster deploy watching. v0.4 reuses the same pattern for config file watching.
- `chrono = "0.4"` — already present, used for timestamps in LogLine.
- `regex = "1"` — already present, used for log level detection and search.
- `tokio::sync::broadcast` — already available via tokio, replaces mpsc for log fan-out.

### Module Changes

```
src/
  cli.rs                     # Add: Validate, Logs, Completions, Restart commands
  main.rs                    # Update: miette error rendering, new command dispatch
  lib.rs                     # No changes

  config/
    mod.rs                   # Update: load_config returns raw source for diagnostics
    model.rs                 # Add: RestartConfig, PartialEq on ServiceConfig/InfraConfig
    validate.rs              # REWRITE: miette diagnostics, strsim suggestions, source spans
    watcher.rs               # NEW: Config file watching with debounce
    diff.rs                  # NEW: ConfigDiff computation

  orchestrator/
    mod.rs                   # Update: config watcher integration, broadcast channels,
                             #         status event lines, restart command support
    supervisor.rs            # Update: ServicePhase enum, configurable RestartPolicy,
                             #         exit code awareness, startup_grace, crash rate detection

  commands/
    mod.rs                   # Add: validate, logs module exports
    validate.rs              # NEW: devrig validate command handler
    logs.rs                  # NEW: devrig logs command with filtering/export

  ui/
    logs.rs                  # REWRITE: broadcast channel, timestamps, owo-colors,
                             #          log level detection, BufWriter batching
    summary.rs               # REWRITE: comfy-table, owo-colors, structured sections
    filter.rs                # NEW: LogFilter predicate chain
    buffer.rs                # NEW: Ring buffer for log history (--tail, --since)
```

### Data Flow Changes

**Current log pipeline:**
```
Supervisors → mpsc::Sender<LogLine> → LogWriter (single consumer, prints to stdout)
```

**New log pipeline:**
```
Supervisors → broadcast::Sender<LogLine>
    ├─ LogWriter (terminal display, filtered, colored)
    ├─ LogBuffer (VecDeque ring buffer, Arc<RwLock<>>)
    └─ (future: devrig logs subscribers, file writer)
```

**Current config lifecycle:**
```
Load once at startup → validate → use
```

**New config lifecycle:**
```
Load at startup → validate → use
Config watcher task (after Phase 5):
    → detect file change (notify + debounce 500ms)
    → re-read file
    → parse TOML → validate (reject if invalid, log error, keep running)
    → diff against current config
    → apply diff: stop removed, restart changed, start added
```

---

## Key Design Decisions

### 1. Miette Diagnostics for Validation (Feature 1)

The research recommended using `toml::Spanned<T>` on `depends_on` fields to capture byte offsets. **This plan takes a simpler approach**: instead of the invasive `Spanned<T>` refactor (which would touch `validate.rs`, `graph.rs`, `interpolate.rs`, and the orchestrator — every place that reads `depends_on`), we search the raw TOML source for field values to compute byte offsets at validation time. This is the approach needed anyway for TOML table keys (e.g., `[services.api]`) where `Spanned` cannot be used.

**Rationale:** The `Spanned<T>` ripple effect was identified as the #1 risk in the research. Searching the source text is simpler, sufficient for validation diagnostics, and avoids touching the hot path of config access throughout the codebase.

The `validate()` signature changes to:
```rust
pub fn validate(
    config: &DevrigConfig,
    source: &str,
    filename: &str,
) -> Result<(), Vec<ConfigDiagnostic>>
```

Where `ConfigDiagnostic` implements `miette::Diagnostic` with `#[source_code]`, `#[label]`, and `#[help]` annotations.

### 2. Config Watching: Conservative Reload (Feature 2)

The research recommended a full diff-and-apply approach with cascade through the dependency graph. **This plan starts conservative**: on config change, validate the new config, then if any infra changed, restart all services. Only services that are added/removed/changed get targeted operations.

**Rationale:** Computing transitive dependency cascades (e.g., postgres port changed → restart all services that depend on postgres) is complex and error-prone. The conservative approach is correct and simple. Targeted cascades can be optimized in a follow-up.

Key implementation details:
- Watch the **parent directory**, not the file itself (critical for vim/emacs atomic saves)
- 500ms debounce via `notify-debouncer-mini` (same pattern as `cluster/watcher.rs`)
- Reject project name changes during hot reload (would require full restart)
- Start watcher only after Phase 5 completes (avoid race during startup)

### 3. Crash Recovery: Enhance, Don't Rewrite (Feature 3)

The existing `RestartPolicy` + backoff algorithm in `supervisor.rs` is correct. This plan adds:
- `ServicePhase` enum for explicit state tracking (exposed to UI)
- `startup_grace` period (2s default) to distinguish startup vs runtime failures
- `RestartMode` enum: `on-failure` (default), `always`, `never`
- Exit code awareness: clean exit (code 0) with `on-failure` does not restart
- Crash rate detection: 5 crashes in 30s → immediate failure
- Per-service TOML configuration under `[services.*.restart]`
- Status event broadcast for UI updates

### 4. Log System: Broadcast + Ring Buffer (Feature 4)

Replace the `mpsc` channel with `tokio::sync::broadcast` for fan-out. Add a ring buffer (`VecDeque<LogLine>` behind `Arc<RwLock<>>`) for history queries.

The `devrig logs` command reads from the ring buffer (for `--tail` and `--since`) and subscribes to the broadcast channel (for `--follow`). Since `devrig logs` runs as a separate process (not inside the running orchestrator), the initial implementation reads from a JSONL log file written by a background task. A future enhancement could use a Unix domain socket for live streaming.

**Revised approach**: Since `devrig logs` is a separate CLI invocation (separate process), it cannot directly subscribe to the in-memory broadcast channel. Instead:
- The orchestrator writes logs to `.devrig/logs/current.jsonl` (JSONL format, one line per log entry)
- `devrig logs` reads this file, applying filters, and optionally tails it (`--follow` uses `notify` to watch the file)
- The broadcast channel is used internally for the LogWriter display and the JSONL file writer
- This is the same pattern used by `docker compose logs`

### 5. Shell Completions: Runtime Subcommand (Feature 5)

Add `devrig completions <shell>` that generates completion scripts to stdout via `clap_complete`. This is the standard approach used by ripgrep, starship, and fd. No build-time generation needed for v0.4.

### 6. Terminal UI: Colored Output, Not TUI Framework (Feature 6)

Replace raw ANSI escapes with `owo-colors` throughout. Replace manual padding in `summary.rs` with `comfy-table` for the startup summary. Add colored log levels, dimmed timestamps, and structured status sections. No `ratatui` — devrig is a launch-and-stream tool, not an interactive explorer.

---

## Implementation Order and Rationale

The implementation follows a layered approach: foundation changes first (dependencies, config model), then core features (validation, supervisor, logs), then integration (orchestrator wiring, config watcher), then CLI/UI, and finally tests and docs.

### Phase 1: Foundation (Steps 1-3)

**Step 1: Dependencies.** Add `clap_complete`, `strsim`, `comfy-table` to Cargo.toml. This must come first so all subsequent steps can use the new crates.

**Step 2: Config model extensions.** Add `RestartConfig` to `ServiceConfig` for per-service restart policy configuration. Add `PartialEq` derives to `ServiceConfig` and `InfraConfig` for config diffing. These types are needed by the supervisor, config watcher, and validation features.

**Step 3: Load config with source.** Modify `load_config()` to return the raw TOML source alongside the parsed config. This is needed by the validation rewrite (for source spans) and is a small, isolated change.

### Phase 2: Validation Rewrite (Steps 4-5)

**Step 4: Validation diagnostics.** Rewrite `ConfigError` as `ConfigDiagnostic` with miette derives. Add source span computation (search raw TOML for field values). Add `strsim::jaro_winkler` for "did you mean?" suggestions. Update `validate()` signature to accept source and filename.

**Step 5: Validate command + error rendering.** Add `devrig validate` CLI command. Update `main.rs` to render errors via `miette::Report`. Update `Orchestrator::from_config()` to pass source/filename to validate.

### Phase 3: Crash Recovery Enhancement (Steps 6-7)

**Step 6: Supervisor enhancement.** Add `ServicePhase` enum, `RestartMode`, `startup_grace`, exit code awareness, crash rate detection. Make `RestartPolicy` configurable from `RestartConfig`. These changes are internal to `supervisor.rs` with no external API changes yet.

**Step 7: Wire restart config.** Update the orchestrator to read `RestartConfig` from service configs and pass to supervisors. Add status event logging for crash/restart events.

### Phase 4: Log System Overhaul (Steps 8-11)

**Step 8: LogLine enhancement.** Add `timestamp` and `level` fields to `LogLine`. Add log level detection regex. This is a foundational change that affects all log producers and consumers.

**Step 9: Broadcast channel + JSONL writer.** Replace `mpsc` with `broadcast` in the orchestrator. Add a JSONL file writer task that persists logs to `.devrig/logs/current.jsonl`. Add ring buffer for in-memory history.

**Step 10: Log filter.** Implement `LogFilter` struct with service, level, regex include/exclude predicates. Used by both the terminal LogWriter and the `devrig logs` command.

**Step 11: Logs command.** Add `devrig logs` CLI subcommand with `--follow`, `--tail`, `--since`, `--grep`, `--exclude`, `--level`, `--format`, `--output`, `--timestamps` flags. Reads from JSONL file, applies filters.

### Phase 5: Terminal UI Enhancement (Steps 12-13)

**Step 12: Startup summary rewrite.** Replace manual padding with `comfy-table`. Replace raw ANSI with `owo-colors`. Structure output into separate Services/Infrastructure/Cluster sections matching the PRD design.

**Step 13: Log output enhancement.** Adopt `owo-colors` in `LogWriter`. Add optional timestamps, colored log levels, dimmed separators. Add `BufWriter<Stdout>` with periodic flush for performance. Add status event lines for crash/restart/backoff interleaved with log output.

### Phase 6: Config Watching (Steps 14-15)

**Step 14: Config diff.** Implement `ConfigDiff` struct that compares old vs new config to identify added/removed/changed services and infra.

**Step 15: Config watcher.** Implement the file watcher using `notify` + `notify-debouncer-mini`. Watch parent directory, debounce 500ms, parse + validate + diff + apply. Wire into orchestrator's post-Phase-5 startup. Reject project name changes.

### Phase 7: Shell Completions (Step 16)

**Step 16: Shell completions.** Add `devrig completions <shell>` command using `clap_complete`. Add `ValueHint::FilePath` to the `-f` flag.

### Phase 8: Quality (Steps 17-18)

**Step 17: Integration tests.** Add integration tests for: validate command (valid/invalid configs), crash recovery (restart on failure, no restart on exit 0, max restarts), logs command (filtering, JSONL export), config watching (add/remove service, invalid config rejected), shell completions (output is non-empty for each shell).

**Step 18: Documentation.** Update `docs/guides/configuration.md` with `[services.*.restart]` config, new CLI commands (`validate`, `logs`, `completions`). No new architecture docs needed — features are enhancements, not new architectural concepts.

---

## Integration Points with Existing Code

### Config Module

- **`model.rs`**: Add `RestartConfig` struct (all optional fields with defaults). Add it as an optional field on `ServiceConfig`. Add `PartialEq` on `ServiceConfig`, `InfraConfig`.
- **`validate.rs`**: Full rewrite of error types to use miette. Signature change adds `source` and `filename` parameters. All callers must be updated.
- **`mod.rs`**: `load_config()` returns `(DevrigConfig, String)` tuple (config + raw source).

### Orchestrator Module

- **`mod.rs`**: Phase 5 switches from `mpsc::channel` to `broadcast::channel`. Adds JSONL writer task. Adds config watcher task after startup summary. Reads `RestartConfig` from service configs.
- **`supervisor.rs`**: Internal enhancement — `ServicePhase` enum, configurable restart policy, exit code awareness. External interface changes: `RestartPolicy` gains new fields.
- **`state.rs`**: No changes needed — `ServicePhase` is runtime-only, not persisted.

### CLI + Commands

- **`cli.rs`**: Add `Validate`, `Logs`, `Completions`, `Restart` command variants.
- **`main.rs`**: Add dispatch for new commands. Switch error rendering from `eprintln!("{:#}", e)` to `miette::Report` for config-related errors.
- **`commands/`**: Add `validate.rs`, `logs.rs` handlers.

### UI Module

- **`logs.rs`**: Rewrite to use `broadcast::Receiver`, `owo-colors`, optional timestamps, BufWriter.
- **`summary.rs`**: Rewrite to use `comfy-table`, `owo-colors`, structured sections.

---

## Testing Strategy

### Unit Tests

| Module | Tests |
|---|---|
| `config::validate` | Miette diagnostics render correctly, "did you mean?" suggestions, source spans point to correct locations, all error variants produce valid diagnostics |
| `config::diff` | Services added/removed/changed detected, infra changes detected, global env changes detected, project name change flagged |
| `config::model` | RestartConfig parsing (all fields, defaults, invalid values) |
| `orchestrator::supervisor` | ServicePhase transitions, startup_grace classification, exit code 0 with on-failure mode, crash rate detection, restart mode never |
| `ui::filter` | Service filter, level filter, regex include/exclude, combined filters |
| `ui::buffer` | Ring buffer capacity, oldest evicted, time-based queries |

### Integration Tests

| Test | What It Verifies |
|---|---|
| `validate_valid_config` | `devrig validate` on a valid config exits 0 with success message |
| `validate_invalid_config` | `devrig validate` on invalid config exits non-zero with miette-formatted diagnostic |
| `crash_recovery_on_failure` | Service exits non-zero → restarts with backoff |
| `clean_exit_no_restart` | Service exits 0 with `on-failure` policy → no restart |
| `max_restarts_exhausted` | Service crashes repeatedly → stops after max_restarts |
| `logs_filter_by_service` | `devrig logs <service>` shows only that service's lines |
| `logs_jsonl_export` | `devrig logs --format json --output <file>` produces valid JSONL |
| `completions_bash` | `devrig completions bash` produces non-empty output |
| `completions_zsh` | `devrig completions zsh` produces non-empty output |
| `completions_fish` | `devrig completions fish` produces non-empty output |

### Backwards Compatibility

All existing unit and integration tests must continue to pass. The `validate()` signature change is the most impactful — all callers (orchestrator, integration tests) must be updated to pass source and filename.

---

## Documentation Plan

### Updated Files

- **`docs/guides/configuration.md`** — Add `[services.*.restart]` section with all fields and defaults. Add `devrig validate`, `devrig logs`, `devrig completions` command reference. Document log filtering flags, JSONL export format, shell completion installation.

### No New Files

All v0.4 features are enhancements to existing concepts, not new architectural patterns. Documentation updates to the configuration guide and README are sufficient.

---

## Risk Mitigation

### 1. Broadcast Channel Backpressure

`tokio::sync::broadcast` drops messages when slow receivers fall behind. **Mitigation:** Use 4096 buffer capacity. Log a warning on `RecvError::Lagged(n)`. The JSONL writer and terminal display are fast consumers. The ring buffer consumer is a simple VecDeque push.

### 2. Config Reload During Active Operations

A config change might arrive while a previous reload is still in progress. **Mitigation:** Use a mutex or single-flight pattern — ignore config changes while a reload is in progress. Log a message to retry.

### 3. JSONL Log File Growth

The JSONL file could grow unbounded during long sessions. **Mitigation:** Truncate the file on `devrig start` (fresh log for each session). The file is in `.devrig/logs/` which is cleaned up by `devrig delete`.

### 4. Validate Signature Change

Changing `validate()` to require source and filename affects `Orchestrator::from_config()` and all test helpers that call `validate()`. **Mitigation:** Update all callers in the same step. The validate rewrite step includes updating the orchestrator and test helpers.

### 5. State File Compatibility

Adding `RestartConfig` to `ServiceConfig` is a config model change, not a state model change. `ServicePhase` is runtime-only. No state file migration needed. All new config fields use `#[serde(default)]`.
