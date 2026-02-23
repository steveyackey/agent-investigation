# Milestone v0.4 Research — Developer Experience Polish

Research completed 2026-02-21. Covers all six features: validate with helpful errors, config file watching, crash recovery with exponential backoff, logs filtering/search/export, shell completions, and colored structured terminal UI.

---

## Crate/Library Recommendations

| Crate | Version | Purpose | Already in Cargo.toml? |
|-------|---------|---------|----------------------|
| `clap_complete` | 4.5 | Shell completion generation (bash, zsh, fish, PowerShell, Elvish) | No — **add** |
| `strsim` | 0.11 | String similarity for "did you mean?" suggestions | No — **add** |
| `comfy-table` | latest | Pretty-printed tables with box-drawing borders for startup summary | No — **add** |
| `miette` | 7 (fancy feature) | Rich diagnostic output with source snippets and labels | Yes |
| `toml` | 0.8 | TOML parsing — use `Spanned<T>` for byte offset tracking | Yes |
| `notify` | 8 | File system watching | Yes |
| `notify-debouncer-mini` | 0.5 | Debounced file watching | Yes |
| `regex` | 1 | Pattern matching on log lines | Yes |
| `chrono` | 0.4 | Timestamps, duration parsing | Yes |
| `owo-colors` | 4 | ANSI color output | Yes |
| `serde_json` | 1.0 | JSONL log export | Yes |
| `tokio` (broadcast channel) | 1 | Fan-out log lines to multiple consumers | Yes |
| `backon` | 1 | Retry with exponential backoff (used for ready checks, reusable for duration computation) | Yes |

### Crates explicitly NOT recommended

| Crate | Reason |
|-------|--------|
| `ratatui` | Overkill — alternate screen mode breaks piping, copy-paste, and native scrollback. devrig is a "launch and stream" tool, not an interactive explorer. See Terminal UI section. |
| `clap_complete_nushell` | Niche user base. Add later behind a feature flag if requested. |
| `crossterm` (standalone) | `owo-colors` already covers coloring needs. Only needed for cursor positioning which we don't need. |
| `indicatif` | Progress spinners during startup would be nice but add complexity for the startup→streaming transition. Defer to a later enhancement. |
| `kube-rs` | Not needed for v0.4. Only relevant if v0.5+ needs programmatic pod watching. |

---

## Design Patterns

### 1. Filter Pipeline Pattern (Logs)

Apply a chain of filters to the `LogLine` stream before display. Each filter is a predicate:

```
LogLine → ServiceFilter → LevelFilter → RegexFilter → Display/Export
```

This is the pattern used by stern, docker compose logs, and klp. The filter struct holds compiled regexes and service name sets, and exposes a single `matches(&LogLine) -> bool` method.

### 2. Watch-Parse-Validate-Diff-Apply Pattern (Config Watching)

Separate five concerns in the config reload pipeline:

1. **Watch** — `notify` detects file change on parent directory (not the file itself — critical for vim/emacs atomic saves)
2. **Parse** — Re-read and parse TOML
3. **Validate** — Reuse existing `validate()`. If invalid, log error, keep old config
4. **Diff** — Compare old vs new config to identify added/removed/changed services and infra
5. **Apply** — Only restart what changed; cascade through dependency graph

This follows nginx's pattern: validate before applying, roll back on failure.

### 3. State Machine Pattern (Crash Recovery)

Replace the implicit state tracking in `ServiceSupervisor` with an explicit `ServicePhase` enum:

```
Initial → Starting → Running → Backoff → Starting (retry)
                                       → Failed (exhausted)
                  → Backoff (startup failure, lower retry budget)
Any → Stopped (user cancellation)
```

This is the supervisord model, proven at scale. The key discriminator is `startup_grace` — how long a process must run to be considered "successfully started."

### 4. Diagnostic Error Pattern (Validation)

Combine `thiserror` (error type definition) + `miette` (rich display) + `toml::Spanned` (source locations) + `strsim` (suggestions):

```
ConfigError {
    src: NamedSource<String>,   // TOML source text
    span: SourceSpan,           // Byte offset from Spanned<T>
    advice: String,             // "did you mean?" from strsim
}
```

Renders as rustc-style diagnostics with line numbers, underlined spans, and help text.

### 5. Fan-out Pattern (Log Distribution)

Replace the current single-consumer `mpsc` channel with `tokio::sync::broadcast` for fan-out to multiple consumers:

```
Supervisors → broadcast::Sender<LogLine>
    ├─ Terminal display (LogWriter)
    ├─ Ring buffer (for devrig logs --tail)
    ├─ File writer (optional, JSONL format)
    └─ Future: devrig logs subscribers
```

### 6. Runtime Subcommand Pattern (Shell Completions)

Add `devrig completions <shell>` subcommand that generates completion scripts to stdout. This is the approach used by starship and ripgrep. Users pipe to the appropriate shell config location.

---

## Implementation Strategy

### Feature 1: `devrig validate` with Helpful Error Messages

**Current state:** `src/config/validate.rs` has 8 `ConfigError` variants with flat string messages. `miette` is in Cargo.toml but unused in validation.

**Strategy:**

1. **Add `strsim = "0.11"` to Cargo.toml.**

2. **Change `depends_on` fields from `Vec<String>` to `Vec<Spanned<String>>` in `src/config/model.rs`.** The `toml::Spanned<T>` wrapper captures byte offsets during deserialization with zero runtime cost. This is the key enabler for source-location errors.

   ```rust
   // Before
   pub depends_on: Vec<String>,
   // After
   pub depends_on: Vec<toml::Spanned<String>>,
   ```

   This requires updating all code that accesses `depends_on` values to use `.get_ref()` for the inner string and `.span()` for the byte range.

3. **Update `validate()` signature to accept raw TOML source and filename:**

   ```rust
   pub fn validate(
       config: &DevrigConfig,
       source: &str,
       filename: &str,
   ) -> Result<(), Vec<ConfigError>>
   ```

   The raw source is needed to construct `NamedSource<String>` for miette. The caller (`load_config` in `src/config/mod.rs`) already has both values.

4. **Rewrite `ConfigError` variants with miette derives:**

   ```rust
   #[derive(Error, Debug, Diagnostic)]
   pub enum ConfigError {
       #[error("unknown dependency `{dependency}`")]
       #[diagnostic(code(devrig::missing_dependency))]
       MissingDependency {
           #[source_code]
           src: NamedSource<String>,
           #[label("service `{service}` depends on `{dependency}`, which does not exist")]
           span: SourceSpan,
           #[help]
           advice: String,
           service: String,
           dependency: String,
       },
       // ... similar for DuplicatePort, DependencyCycle, etc.
   }
   ```

5. **Implement `find_closest_match()` using `strsim::jaro_winkler` with threshold 0.8.** For config key names (short strings, 3-20 chars), Jaro-Winkler is ideal because it gives extra weight to matching prefixes (e.g., `postgres` vs `postres`).

6. **Add a `devrig validate` command** to `src/cli.rs` that loads, parses, and validates the config, printing all diagnostics. On success, print a confirmation message. On failure, print all errors with source context.

7. **Update error rendering in `main.rs`** to use `miette::Report` for rendering instead of `eprintln!("{:#}", e)`.

**Files to modify:** `src/config/model.rs`, `src/config/validate.rs`, `src/config/mod.rs`, `src/cli.rs`, `src/main.rs`, `src/commands/mod.rs` (add validate command handler)

**Files to create:** `src/commands/validate.rs`

**Key risk:** Changing `depends_on` to `Vec<Spanned<String>>` is a breaking change to the internal API. All code that iterates over `depends_on` must be updated. Grep for `depends_on` across the codebase — it's used in `validate.rs`, `graph.rs`, `interpolate.rs`, and the orchestrator.

**For fields where `Spanned` cannot be used** (e.g., TOML table keys like `[services.api]`), fall back to searching the raw TOML source for the key string and computing byte offsets manually.

---

### Feature 2: Config File Watching (Auto-restart on devrig.toml Changes)

**Current state:** Config loaded once at startup. No watching. `notify` and `notify-debouncer-mini` already in Cargo.toml (used by `src/cluster/watcher.rs`).

**Strategy:**

1. **Watch the parent directory, not the file itself.** This is critical. On Linux (inotify), watching a single file breaks when editors perform atomic saves (vim: write tmp → delete original → rename tmp). After the delete, the inotify watch on the original file is gone. Watching the parent directory and filtering by filename is the correct approach.

2. **Reuse the existing `notify-debouncer-mini` pattern from `src/cluster/watcher.rs`** with 500ms debounce. After the debounce window, re-read the file content (don't try to reconstruct from events).

3. **Parse + validate the new config before applying.** If the new config is invalid, log the error with full miette diagnostics and keep the old config running. This is the nginx pattern.

4. **Implement a `ConfigDiff` struct** that identifies what changed:

   ```rust
   pub struct ConfigDiff {
       pub services_added: Vec<String>,
       pub services_removed: Vec<String>,
       pub services_changed: Vec<String>,
       pub infra_added: Vec<String>,
       pub infra_removed: Vec<String>,
       pub infra_changed: Vec<String>,
       pub global_env_changed: bool,
       // cluster changes, compose changes...
   }
   ```

   Since `DevrigConfig` uses `BTreeMap` for services/infra, diffing is straightforward: iterate over keys, compare values.

5. **Add `PartialEq` to `ServiceConfig`, `InfraConfig`, and `Port`** to enable field-by-field comparison. Currently these only derive `Debug, Clone, Deserialize`.

6. **Apply only the diff:**
   - Stop removed services (cancel their supervisors)
   - Stop changed services, then restart with new config
   - Start newly added services
   - For infra changes: stop container, start new one
   - Cascade: if an infra port changed, restart all services that depend on it (transitively through the dependency graph)

7. **Reject project name changes** during hot reload. Changing `[project] name` affects the slug, Docker network, container names, labels — effectively requires a full restart. Log: "project name changed; run `devrig delete && devrig start` to apply."

8. **Start the config watcher only after initial startup completes** (after `print_startup_summary()`). This avoids the race condition of config changes during the multi-phase startup.

9. **Use `tokio::sync::watch` channel** to distribute the new config to consumers. The watcher sends new configs, and supervisors/managers subscribe.

**Architecture:**

```
Config Watcher Task (background)
  → detect file change (notify + debounce)
  → re-read file
  → parse TOML
  → validate (reject if invalid)
  → diff against current config
  → send ConfigChange through channel
  → Orchestrator receives, applies diff
```

**Files to create:** `src/config/watcher.rs`, `src/config/diff.rs`

**Files to modify:** `src/orchestrator/mod.rs` (start watcher after Phase 5, handle config change events in the main loop), `src/config/model.rs` (add PartialEq derives)

**Edge cases to handle:**
- File deleted: log warning, keep running
- File empty/truncated mid-write: retry read after 50ms
- Multiple rapid saves: debounce handles this
- Config change during stop/delete: check `CancellationToken.is_cancelled()` before applying
- Circular dependency introduced: existing `validate()` catches this
- Port conflicts in new config: run port availability check during validation

---

### Feature 3: Crash Recovery with Exponential Backoff

**Current state:** `src/orchestrator/supervisor.rs` already implements equal jitter exponential backoff with `RestartPolicy { max_restarts: 10, initial_delay: 500ms, max_delay: 30s, reset_after: 60s }`. The backoff algorithm is correct.

**Strategy — enhance, don't rewrite:**

1. **Add `ServicePhase` state enum:**

   ```rust
   #[derive(Debug, Clone, PartialEq, Eq)]
   pub enum ServicePhase {
       Initial,
       Starting,
       Running,
       Backoff { attempt: u32 },
       Failed { reason: String, last_exit_code: Option<i32> },
       Stopped,
   }
   ```

   Replace the implicit state tracking (restart_count + is-running) with explicit phase transitions.

2. **Add `startup_grace` period** (default: 2 seconds). If a process exits before `startup_grace`, classify as a startup failure with a lower retry budget (default: 3). This distinguishes "config error" crashes from runtime crashes.

   ```rust
   pub struct RestartPolicy {
       pub max_restarts: u32,          // 10
       pub startup_max_restarts: u32,  // 3 — lower budget for startup failures
       pub startup_grace: Duration,    // 2s
       pub initial_delay: Duration,    // 500ms
       pub max_delay: Duration,        // 30s
       pub reset_after: Duration,      // 60s
       pub policy: RestartMode,        // OnFailure | Always | Never
   }

   pub enum RestartMode {
       Always,     // Restart regardless of exit code
       OnFailure,  // Restart only on non-zero exit (default)
       Never,      // Do not restart
   }
   ```

3. **Distinguish exit code 0 from non-zero.** Currently all exits are treated the same. With `RestartMode::OnFailure` (default), a clean exit (code 0) should NOT trigger a restart.

4. **Add time-windowed crash rate detection.** If 5 crashes happen within 30 seconds, transition to Failed immediately without exhausting all 10 retries. This catches rapid crash loops faster.

5. **Broadcast `ServicePhase` changes** via a channel so the UI can display live status updates.

6. **Make restart policy configurable per service in TOML:**

   ```toml
   [services.api.restart]
   policy = "on-failure"       # "always" | "on-failure" | "never"
   max_restarts = 10
   initial_delay_ms = 500
   max_delay_ms = 30000
   ```

   All fields optional with sensible defaults.

**Files to modify:** `src/orchestrator/supervisor.rs` (main changes), `src/config/model.rs` (add RestartConfig), `src/config/validate.rs` (validate restart config), `src/ui/summary.rs` (display phase), `src/orchestrator/mod.rs` (pass restart config)

**Backoff algorithm — keep equal jitter.** The current implementation is correct. Full jitter would only matter if many services crash simultaneously and contend for the same resources; equal jitter's guaranteed minimum delay floor is more appropriate for process supervision.

---

### Feature 4: `devrig logs` Filtering, Search, and Export

**Current state:** `src/ui/logs.rs` has `LogLine { service, text, is_stderr }` with single-consumer `mpsc` channel. No filtering, no history, no export, no timestamps.

**Strategy:**

1. **Add timestamp to `LogLine`:**

   ```rust
   pub struct LogLine {
       pub timestamp: DateTime<Utc>,
       pub service: String,
       pub text: String,
       pub is_stderr: bool,
       pub level: Option<LogLevel>,
   }
   ```

   Detect log level from text using regex: `(?i)\b(trace|debug|info|warn(?:ing)?|error)\b` — check common formats (JSON `"level":"info"`, logfmt `level=info`, bracketed `[INFO]`).

2. **Switch from `mpsc` to `broadcast` channel** for log fan-out. This allows multiple consumers: terminal display, ring buffer, file writer, and future `devrig logs` subscribers.

   ```rust
   let (log_tx, _) = broadcast::channel::<LogLine>(4096);
   ```

   Note: `broadcast` requires `Clone` on `LogLine` (already derived).

3. **Add in-memory ring buffer** using `VecDeque<LogLine>` with configurable capacity (default: 10,000 lines, ~2MB). This enables `--tail N` and `--since <time>` queries.

   ```rust
   pub struct LogBuffer {
       lines: VecDeque<LogLine>,
       capacity: usize,
   }
   ```

   Wrap in `Arc<RwLock<LogBuffer>>` for concurrent access. The buffer task subscribes to the broadcast channel and pushes lines.

4. **Add `LogFilter` struct:**

   ```rust
   pub struct LogFilter {
       pub services: Vec<String>,
       pub min_level: Option<LogLevel>,
       pub include: Option<Regex>,
       pub exclude: Option<Regex>,
       pub stderr_only: bool,
   }
   ```

5. **Add `devrig logs` subcommand to CLI:**

   ```rust
   Logs {
       services: Vec<String>,
       #[arg(short, long)] follow: bool,
       #[arg(long)] tail: Option<usize>,
       #[arg(long)] since: Option<String>,
       #[arg(long, short = 'g')] grep: Option<String>,
       #[arg(long, short = 'v')] exclude: Option<String>,
       #[arg(long, short = 'l')] level: Option<String>,
       #[arg(long, default_value = "text")] format: OutputFormat,
       #[arg(long, short = 'o')] output: Option<PathBuf>,
       #[arg(long, short = 't')] timestamps: bool,
   }
   ```

6. **Support three output formats:** `text` (default, current colored format), `json` (JSONL — one JSON object per line), optionally `csv`.

7. **Duration parsing for `--since`:** Support RFC 3339 (`2026-02-21T14:00:00Z`), Unix timestamps, and relative durations (`5m`, `1h`, `30s`).

8. **Add a `--gate` mechanism to `LogWriter`** using `tokio::sync::Notify` to prevent log lines from interleaving with the startup summary. Buffer lines until startup is complete, then release.

9. **File export:** `--output <path>` writes filtered logs to a file in the chosen format. For JSONL, each line is `serde_json::to_string(&line)`.

10. **Batch stdout writes** using `BufWriter<Stdout>` with periodic flush (every 16ms) for better performance under high log volume.

**Files to create:** `src/commands/logs.rs`, `src/ui/filter.rs`, `src/ui/buffer.rs`

**Files to modify:** `src/ui/logs.rs` (add timestamp, broadcast support, gate), `src/orchestrator/mod.rs` (switch to broadcast, add buffer task), `src/cli.rs` (add Logs command), `src/commands/mod.rs`

**Zero new dependencies needed.** Everything required (`regex`, `chrono`, `serde_json`, `tokio::sync::broadcast`) is already in Cargo.toml.

---

### Feature 5: Shell Completions (bash, zsh, fish)

**Current state:** No shell completion support. No `clap_complete` dependency.

**Strategy:**

1. **Add `clap_complete = "4.5"` to Cargo.toml.**

2. **Add `Completions` variant to `Commands` enum in `src/cli.rs`:**

   ```rust
   use clap_complete::aot::Shell;

   /// Generate shell completions to stdout
   Completions {
       /// The shell to generate completions for
       #[arg(value_enum)]
       shell: Shell,
   },
   ```

3. **Handle in `main.rs`:**

   ```rust
   Commands::Completions { shell } => {
       let mut cmd = Cli::command();
       clap_complete::aot::generate(shell, &mut cmd, "devrig", &mut std::io::stdout());
       Ok(())
   }
   ```

4. **Add `ValueHint::FilePath`** to the `--file` / `-f` global argument for better zsh/fish completions:

   ```rust
   #[arg(short = 'f', long = "file", global = true, value_hint = clap::ValueHint::FilePath)]
   pub config_file: Option<PathBuf>,
   ```

5. **Document installation in README** with one-liners per shell:
   - Bash: `devrig completions bash > ~/.local/share/bash-completion/completions/devrig`
   - Zsh: `devrig completions zsh > ~/.zfunc/_devrig` (needs `fpath+=(~/.zfunc)`)
   - Fish: `devrig completions fish > ~/.config/fish/completions/devrig.fish`

6. **Build-time generation (optional, for release archives):** Add `build.rs` with `clap_complete::aot::generate_to()` for pre-generating completion files. Only needed when creating release tarballs. Skip for v0.4 — the runtime subcommand is sufficient.

**Files to modify:** `Cargo.toml`, `src/cli.rs`, `src/main.rs`

**Pitfalls to avoid:**
- The `bin_name` passed to `generate()` MUST match the actual binary name ("devrig")
- Zsh completion file must be named `_devrig` (underscore prefix)
- Fish does not support positional argument completions — only named flags complete
- Don't use the `unstable-dynamic` / `CompleteEnv` API — it's not stable yet

---

### Feature 6: Colored, Structured Terminal UI (Service Status Dashboard)

**Current state:** `src/ui/summary.rs` prints a startup summary table using plain `println!` with some `owo-colors` coloring. `src/ui/logs.rs` prints prefixed log lines.

**Recommendation: Do NOT adopt ratatui. Enhance the current approach.**

**Rationale:** ratatui takes over the terminal with alternate screen mode, breaking piping (`devrig start | tee log.txt`), copy-paste, and native scrollback. docker compose — the closest functional analogy to devrig — uses the exact same approach devrig currently uses: colored prefixed output, no TUI framework. The tools that use full TUI frameworks (lazydocker, k9s) are interactive exploration tools, not launch-and-stream orchestrators.

**Strategy:**

1. **Add `comfy-table` for the startup summary.** Replace the manual padding in `src/ui/summary.rs` with `comfy-table` for proper box-drawing borders, padding, and automatic column alignment:

   ```rust
   use comfy_table::{Table, Row, Cell, Color, Attribute};

   let mut table = Table::new();
   table.set_header(vec!["Service", "URL", "Status"]);
   for (name, svc) in services {
       table.add_row(vec![
           Cell::new(name),
           Cell::new(url),
           Cell::new("running").fg(Color::Green),
       ]);
   }
   println!("{table}");
   ```

2. **Enhance `owo-colors` usage for log output.** Add colored log levels, dimmed timestamps, and structured formatting:

   ```rust
   use owo_colors::OwoColorize;

   // Startup header
   println!("  {} {} ({})", "devrig".bold(), identity.name.cyan(), identity.id.dimmed());

   // Log lines with optional timestamps
   if show_timestamps {
       write!(writer, "{} ", line.timestamp.format("%H:%M:%S").dimmed())?;
   }
   write!(writer, "{:>width$} {} ", service_colored, "|".dimmed(), width = max_len)?;
   if line.is_stderr {
       writeln!(writer, "{}", line.text.red())?;
   } else {
       writeln!(writer, "{}", line.text)?;
   }
   ```

3. **Add live status updates during the run loop.** When a service crashes or enters backoff, print a status line:

   ```
   devrig: api crashed (exit 1), restarting in 2s (attempt 3/10)
   devrig: api restarted successfully
   devrig: worker failed after 10 restart attempts
   ```

   These interleave with log output, using a distinct prefix (`devrig:`) and color (yellow for backoff, red for failure, green for recovery).

4. **Consider a `devrig status` command** (or enhance `devrig ps`) that shows the current live state of all services including their `ServicePhase`, restart count, and uptime. This is the "dashboard" for non-interactive use — run it in a separate terminal.

5. **Batch stdout writes** in `LogWriter` using `BufWriter<Stdout>` with 16ms flush interval for better performance.

**Files to modify:** `Cargo.toml` (add comfy-table), `src/ui/summary.rs` (use comfy-table), `src/ui/logs.rs` (enhanced formatting, timestamps, level colors), `src/orchestrator/mod.rs` (status update lines)

---

## Risks and Considerations

### 1. `Spanned<T>` Ripple Effect (Validation)

Changing `depends_on: Vec<String>` to `Vec<Spanned<String>>` touches every piece of code that accesses dependency names. This is a pervasive change across `validate.rs`, `graph.rs`, `interpolate.rs`, and the orchestrator. **Mitigation:** Do this first, as a standalone refactor with full test coverage, before adding miette diagnostics.

### 2. Broadcast Channel Backpressure (Logs)

`tokio::sync::broadcast` drops messages when a slow receiver falls behind (returns `RecvError::Lagged(n)`). The terminal display consumer must keep up with log production. **Mitigation:** The 4096 buffer should be sufficient for normal use. Log the lag count as a warning. The ring buffer consumer is fast (just a VecDeque push). If needed, add an intermediate hub task that bridges mpsc (with backpressure on producers) to broadcast (for fan-out).

### 3. Config Reload Cascade Complexity (Config Watching)

When an infra container's port changes, all services that depend on it need restarting because their environment variables changed. Computing this cascade through the dependency graph correctly is non-trivial. **Mitigation:** Start with a conservative approach — if any infra changes, restart all services. Optimize to targeted restarts in a follow-up.

### 4. Config Reload During Active Operations (Config Watching)

A config change might arrive while a previous reload is still in progress (e.g., stopping old containers). **Mitigation:** Use the cancel-and-restart pattern from `src/cluster/watcher.rs` — cancel the in-progress reload when new changes arrive.

### 5. State File Compatibility (Crash Recovery)

Adding `ServicePhase` and restart policy to the state model must be backwards-compatible with existing `.devrig/state.json` files. **Mitigation:** Use `#[serde(default)]` on all new fields, as the project already does for previous state model extensions.

### 6. Startup Summary vs Log Interleaving (Terminal UI)

Services spawned in Phase 5 may emit log lines before the startup summary is printed. **Mitigation:** Add a `Notify` gate to `LogWriter` that buffers lines until after the summary is printed. This is a one-line change to signal after `print_startup_summary()`.

### 7. Editor-Specific File Event Patterns (Config Watching)

Different editors produce different event sequences for "save": vim does write→delete→rename (3+ events), VS Code writes directly, JetBrains uses `___jb_tmp___` temp files. **Mitigation:** Watch the parent directory (not the file), use 500ms debounce, and re-read the file after the debounce window. This handles all editor patterns.

### 8. Project Name Change During Hot Reload (Config Watching)

Changing `[project] name` during hot reload would require changing the Docker network name, container prefixes, labels, and state directory — effectively a full restart. **Mitigation:** Detect project name changes and reject them during hot reload with a clear message instructing the user to run `devrig delete && devrig start`.

---

## References

### Shell Completions
- [clap_complete docs](https://docs.rs/clap_complete/latest/clap_complete/)
- [clap_complete::aot module](https://docs.rs/clap_complete/latest/clap_complete/aot/index.html)
- [Kevin K's Blog: CLI Shell Completions in Rust](https://kbknapp.dev/shell-completions/)
- [ripgrep shell completion approach](https://github.com/BurntSushi/ripgrep)
- [fd shell completion approach](https://github.com/sharkdp/fd)
- [starship completion subcommand](https://github.com/starship/starship)

### Validation & Error Diagnostics
- [miette crate documentation](https://docs.rs/miette/latest/miette/)
- [miette Diagnostic derive](https://docs.rs/miette/latest/miette/derive.Diagnostic.html)
- [toml::Spanned documentation](https://docs.rs/toml/latest/toml/struct.Spanned.html)
- [strsim crate (string similarity)](https://docs.rs/strsim/latest/strsim/)
- [Rustc diagnostics guide](https://rustc-dev-guide.rust-lang.org/diagnostics.html)
- [Terraform validate command](https://developer.hashicorp.com/terraform/cli/commands/validate)

### Config File Watching
- [notify crate docs (v8)](https://docs.rs/notify/latest/notify/)
- [notify-debouncer-mini docs](https://docs.rs/notify-debouncer-mini/latest/notify_debouncer_mini/)
- [Vim and inotify (atomic save problem)](https://www.extrema.is/blog/2022/03/04/vim-and-inotify)
- [Analysis of inotify events for different editors](https://github.com/guard/guard/wiki/Analysis-of-inotify-events-for-different-editors)
- [Controlling nginx (graceful reload)](https://nginx.org/en/docs/control.html)
- [Docker Compose Watch](https://docs.docker.com/compose/how-tos/file-watch/)
- [arc_swap patterns](https://docs.rs/arc-swap/latest/arc_swap/docs/patterns/index.html)

### Crash Recovery & Backoff
- [AWS Architecture Blog: Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [AWS Builders' Library: Timeouts, retries and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- [Thom Wright: The problem with decorrelated jitter](https://thomwright.co.uk/2024/04/24/decorrelated-jitter/)
- [Supervisord subprocess state machine](https://supervisord.org/subprocess.html)
- [Canonical Pebble state machine refactor](https://github.com/canonical/pebble/pull/79)
- [systemd RestartSteps (v254)](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
- [Kubernetes CrashLoopBackOff](https://www.sysdig.com/blog/debug-kubernetes-crashloopbackoff)
- [Kubernetes Liveness, Readiness, and Startup Probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/)
- [Docker restart policy exponential backoff](https://github.com/moby/moby/issues/22283)
- [backon crate documentation](https://docs.rs/backon/)

### Logs Filtering & Export
- [stern (Kubernetes log aggregator)](https://github.com/stern/stern)
- [klp (structured log viewer)](https://github.com/dloss/klp)
- [JSONL for log processing](https://jsonl.help/use-cases/log-processing/)
- [Docker container logs reference](https://docs.docker.com/reference/cli/docker/container/logs/)
- [Tokio broadcast channel docs](https://docs.rs/tokio/latest/tokio/sync/broadcast/index.html)
- [regex crate documentation](https://docs.rs/regex/latest/regex/)
- [file-rotate crate](https://crates.io/crates/file-rotate)

### Terminal UI
- [Ratatui (evaluated, not recommended for devrig)](https://ratatui.rs/)
- [comfy-table crate](https://crates.io/crates/comfy-table)
- [owo-colors crate](https://docs.rs/owo-colors/latest/owo_colors/)
- [Docker Compose logs approach (no TUI)](https://docs.docker.com/reference/cli/docker/compose/logs/)
- [lazydocker (full TUI, different use case)](https://github.com/jesseduffield/lazydocker)
