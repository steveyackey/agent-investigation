# Implementation Plan — v0.1: Local Process Orchestration

## Overview

Milestone v0.1 bootstraps the devrig Rust project from scratch and implements the core local process orchestration layer. This is the foundation that all subsequent milestones build upon. By the end of v0.1, `devrig start` can parse a `devrig.toml`, resolve service dependencies, spawn processes with colored log output, detect port collisions, and manage the full start/stop/delete lifecycle across multiple isolated project instances.

No Docker, k3d, or dashboard functionality is included — those arrive in v0.2–v0.5.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                        CLI (clap)                       │
│  devrig start | stop | delete | ps | init | doctor      │
│  Global: -f <file>                                      │
└──────────────────────┬──────────────────────────────────┘
                       │
         ┌─────────────▼─────────────┐
         │       Orchestrator        │
         │  start / stop / delete    │
         │  Coordinates all layers   │
         └──┬──────┬──────┬──────┬───┘
            │      │      │      │
    ┌───────▼──┐ ┌─▼────┐ │  ┌───▼──────────┐
    │  Config  │ │Graph │ │  │    State      │
    │  Parser  │ │Topo- │ │  │ .devrig/     │
    │  +Valid  │ │sort  │ │  │ state.json   │
    │  +Resolve│ │      │ │  │ + registry   │
    └──────────┘ └──────┘ │  └──────────────┘
                          │
              ┌───────────▼──────────────┐
              │   Service Supervisors    │
              │  ┌─────┐ ┌─────┐ ┌─────┐│
              │  │ svc │ │ svc │ │ svc ││
              │  │  1  │ │  2  │ │  3  ││
              │  └──┬──┘ └──┬──┘ └──┬──┘│
              └─────┼───────┼───────┼───┘
                    │       │       │
              ┌─────▼───────▼───────▼───┐
              │   Log Multiplexer       │
              │   (mpsc channel →       │
              │    colored stdout)      │
              └─────────────────────────┘
```

### Key Architectural Decisions

1. **Single binary, library-backed.** `main.rs` is thin (CLI parse + dispatch). All logic lives in `lib.rs` re-exports, enabling both CLI use and integration testing via the library API.

2. **Two-phase config processing.** TOML deserialization (serde) is separated from validation (cross-field checks, dependency cycle detection). This follows Cargo's pattern and produces better error messages.

3. **Process groups for clean shutdown.** Every spawned child gets `.process_group(0)` so `killpg()` can terminate the entire process tree. This is critical for commands like `cargo watch` that spawn sub-processes.

4. **Channel-based log multiplexing.** Each service supervisor sends log lines through an `mpsc` channel to a single `LogWriter` task. This prevents line interleaving without holding mutexes across async boundaries.

5. **File-based instance registry.** `~/.devrig/instances.json` tracks all running devrig instances for `ps --all` discovery. This is simpler than scanning the filesystem and sufficient for v0.1 (v0.2+ adds Docker label-based discovery).

6. **CancellationToken + TaskTracker.** `tokio-util`'s cooperative shutdown primitives coordinate graceful shutdown across all service supervisors without complex state machines.

---

## File Structure

All paths relative to `/home/steve/fj/devrig`.

### Source Files

```
Cargo.toml                          # Project manifest with all dependencies
src/
  main.rs                           # CLI entry point: parse args → dispatch
  lib.rs                            # Library root: re-exports all modules
  cli.rs                            # clap derive structs (Cli, Commands, GlobalOpts)
  identity.rs                       # ProjectIdentity (name + SHA-256 path hash)
  config/
    mod.rs                          # Re-exports, load_config() entry point
    model.rs                        # DevrigConfig, ProjectConfig, ServiceConfig, Port
    validate.rs                     # Post-parse validation (missing deps, dup ports, cycles)
    resolve.rs                      # Config file discovery (dir walk), path resolution
  orchestrator/
    mod.rs                          # Orchestrator struct: start/stop/delete coordination
    supervisor.rs                   # ServiceSupervisor: spawn, monitor, restart w/ backoff
    graph.rs                        # DependencyResolver: petgraph toposort
    ports.rs                        # Port availability check, free port, owner identification
    state.rs                        # .devrig/state.json read/write
    registry.rs                     # ~/.devrig/instances.json global instance registry
  commands/
    mod.rs                          # Re-exports command handlers
    ps.rs                           # devrig ps / ps --all
    init.rs                         # devrig init (generate starter devrig.toml)
    doctor.rs                       # devrig doctor (check dependencies)
  ui/
    mod.rs                          # Re-exports UI modules
    logs.rs                         # LogLine, LogWriter, color palette, TTY detection
    summary.rs                      # Startup summary printer
```

### Test Files

```
tests/
  common/
    mod.rs                          # TestProject, free_port(), wait_for_port(), ProcessGuard
  integration/
    mod.rs                          # Feature-gate and test module declarations
    start_stop.rs                   # Start/stop lifecycle tests
    config_file_flag.rs             # -f flag tests
    crash_recovery.rs               # Process crash → restart with backoff
    port_collision.rs               # Port conflict detection tests
    multi_instance.rs               # Two projects, no cross-talk
    ps_all.rs                       # ps --all cross-project discovery
    dir_discovery.rs                # Directory tree config walk
    label_cleanup.rs                # Scoped cleanup (only own resources)
```

### Documentation Files

```
README.md                           # Quickstart, demo placeholder, minimal example
docs/
  adr/
    001-toml-only.md
    002-no-profiles.md
    003-isolated-kubeconfig.md
    004-compose-interop.md
    005-traefik-over-nginx.md
    006-in-memory-otel.md
    007-agent-browser-testing.md
    008-multi-instance-isolation.md
  architecture/
    overview.md
    config-model.md
    dependency-graph.md
    multi-instance.md
  guides/
    getting-started.md
    configuration.md
    contributing.md
```

---

## Implementation Order and Rationale

The implementation follows a bottom-up dependency order. Each step produces compilable code with passing tests before the next step begins.

### Phase 1: Foundation (Steps 1–6)

**Step 1: Project bootstrap.** `cargo init`, `Cargo.toml` with all dependencies, minimal `main.rs` and module stubs. The goal is a project that compiles with `cargo build` from the very start, even though modules are empty. This prevents cascading compile errors as code is added.

**Step 2: Config model + parsing.** The config types (`DevrigConfig`, `ServiceConfig`, `Port`) are the foundation everything else depends on. Defined with serde derive. Custom `Port` deserializer handles `number | "auto"`. Includes inline unit tests for parsing edge cases.

**Step 3: Config validation.** Separated from parsing per the two-phase pattern. Validates: missing `depends_on` references, duplicate fixed ports, and dependency cycles (delegates to the graph module for cycle detection — uses a simple check here, full graph comes in step 6). Returns all errors, not just the first.

**Step 4: Config resolution + project identity.** Config file discovery (walk up directory tree) and `-f` flag handling. Project identity with SHA-256 hash. Both are needed before the orchestrator can run.

**Step 5: CLI structure.** clap derive with all v0.1 subcommands and global `-f` option. No command implementations yet — just the argument parsing.

**Step 6: Dependency graph.** petgraph-based `DependencyResolver` with topological sort and cycle detection. Extensive unit tests covering linear chains, diamond dependencies, cycles, self-loops, and empty configs.

### Phase 2: Process Management (Steps 7–10)

**Step 7: Process supervisor.** The core of v0.1. `ServiceSupervisor` spawns a child process with `.process_group(0)`, captures stdout/stderr via `BufReader` + `LinesStream`, sends lines through an mpsc channel, monitors for exit, and restarts with exponential backoff. Responds to `CancellationToken` for graceful shutdown via `killpg(SIGTERM)`.

**Step 8: Log multiplexing + UI.** `LogWriter` consumes the mpsc channel and prints colored, aligned output. `print_startup_summary()` displays the post-start status. TTY detection for color support.

**Step 9: Port collision detection.** `check_port_available()` via `TcpListener::bind()`. `find_free_port()` for `port = "auto"`. `identify_port_owner()` via `/proc/net/tcp` on Linux. `check_all_ports()` aggregates conflicts with clear error messages.

**Step 10: State management + instance registry.** `.devrig/state.json` tracks running services (PIDs, ports, started_at). `~/.devrig/instances.json` is the global registry for `ps --all`. Both use serde JSON serialization.

### Phase 3: Integration (Steps 11–13)

**Step 11: Orchestrator.** The central coordinator. `Orchestrator::start()`: parse config → validate → resolve identity → check ports → start services in dependency order → print summary → enter watch mode. `stop()`: cancel token → wait with timeout. `delete()`: stop + remove state. Wires together all Phase 1 and 2 components.

**Step 12: Commands.** `ps`: reads state file, checks process liveness, displays table. `ps --all`: reads global registry, checks all instances. `init`: detects project type (Cargo.toml, package.json), generates starter devrig.toml. `doctor`: checks for docker, k3d, etc. in PATH.

**Step 13: Main entry point.** `main.rs` parses CLI args, dispatches to commands, sets up tracing subscriber, installs signal handlers, runs the tokio runtime.

### Phase 4: Quality (Steps 14–15)

**Step 14: Integration tests.** Feature-gated behind `integration` feature. Uses `assert_cmd` for CLI testing and direct library API for lifecycle tests. Unique ports and temp directories per test for parallelism. Covers: start/stop lifecycle, -f flag, crash recovery, port collision, multi-instance isolation, ps --all, directory discovery, scoped cleanup.

**Step 15: Documentation.** README.md with quickstart and minimal example. 8 ADRs for existing design decisions. Architecture docs for overview, config model, dependency graph, and multi-instance isolation. Guides for getting started, configuration reference, and contributing.

---

## Key Design Decisions

### Config Model

- **`BTreeMap` over `HashMap`** for services and env: deterministic iteration order, matches Cargo's convention.
- **Custom `Port` deserializer** instead of `#[serde(untagged)]`: produces clear error messages ("expected a port number (1-65535) or the string \"auto\"") instead of cryptic serde errors.
- **`#[serde(default)]` on all optional sections**: a minimal `[project]\nname = "x"` is a valid config.

### Process Management

- **`.process_group(0)`**: creates a new process group with the child as leader. `killpg()` kills the entire tree (critical for `cargo watch` → child processes).
- **`.kill_on_drop(true)`**: safety net for any process that escapes graceful shutdown.
- **Exponential backoff with equal jitter**: `delay = base/2 + random(0, base/2)`. Ensures minimum delay while avoiding thundering herd.
- **Reset counter after 60s of stable running**: a process that runs for a minute before crashing gets a fresh restart budget.

### Multi-Instance Isolation

- **Project identity = SHA-256(canonical_config_path)[:8]**: deterministic, stable across restarts, unique per path.
- **Slug format: `{name}-{hash}`**: human-readable project name plus collision-resistant hash.
- **File-based global registry at `~/.devrig/instances.json`**: simple JSON tracking all active instances. Stale entries cleaned up on `ps --all` by checking if PIDs are alive.

### Error Handling

- **`thiserror` for typed errors** in library code (config parsing, validation, graph resolution).
- **`anyhow` for application errors** in command handlers and main.
- **`miette` for user-facing diagnostics** on config errors (source spans, help text).
- **Collect all validation errors**, not just the first: users fix everything in one pass.

### Signal Handling

- **SIGINT + SIGTERM** both trigger graceful shutdown via `CancellationToken`.
- **10-second timeout** after cancellation: warn and force-exit if processes won't stop.
- **Second Ctrl+C** triggers immediate `std::process::exit(1)`.

---

## Testing Strategy

### Unit Tests (inline, `#[cfg(test)]`)

| Module | Tests |
|---|---|
| `config::model` | Minimal config, full config, fixed port, auto port, invalid port string, port out of range, missing required fields, env merging |
| `config::validate` | Missing dependency, duplicate ports, valid config passes, multiple errors collected |
| `config::resolve` | Find config in current dir, find config in parent, no config found, -f flag with valid/invalid path |
| `identity` | Hash determinism, hash length (8 hex chars), different paths → different hashes, slug format |
| `orchestrator::graph` | Linear chain, diamond, cycle, self-loop, no dependencies, empty config, single service |

### Integration Tests (feature-gated, `tests/integration/`)

| Test File | What It Tests |
|---|---|
| `start_stop.rs` | Start services → verify port reachable → stop → verify port released |
| `config_file_flag.rs` | `-f custom.toml` loads alternate config |
| `crash_recovery.rs` | Service exits → supervisor restarts with backoff |
| `port_collision.rs` | Start with already-bound port → clear error message |
| `multi_instance.rs` | Two projects on different ports → both run, stop one doesn't affect other |
| `ps_all.rs` | Two projects running → `ps --all` shows both |
| `dir_discovery.rs` | Config in parent dir → devrig finds it from subdirectory |
| `label_cleanup.rs` | Delete only removes own state files and processes |

### Test Helpers (`tests/common/mod.rs`)

- `TestProject::new(toml)` — creates temp dir with devrig.toml
- `free_port()` / `free_ports(n)` — dynamic port allocation
- `wait_for_port(port, timeout)` — poll TCP connectivity
- `ProcessGuard` — ensures cleanup on panic

---

## Documentation Plan

### README.md
- One-liner description
- Demo placeholder (asciinema TODO)
- Quickstart: `cargo install devrig && devrig init && devrig start`
- Minimal example devrig.toml (2 services, no infra)
- Core commands with one-line descriptions
- Link to docs/ for details

### ADRs (8 files)
Each follows: Context → Decision → Consequences format. These document decisions already made in the PRD:
1. TOML-only config format
2. No profiles system (use -f flag instead)
3. Isolated kubeconfig (never touch ~/.kube/config)
4. Compose interop (delegate to existing docker-compose.yml)
5. Traefik over nginx for ingress
6. In-memory OTel storage (ring buffers, no disk)
7. Agent-browser testing for dashboard E2E
8. Multi-instance isolation (project slug, resource naming)

### Architecture Docs (4 files)
- `overview.md` — System architecture, runtime model, component diagram
- `config-model.md` — TOML schema, two-phase parsing, Port type, validation rules
- `dependency-graph.md` — petgraph usage, topological sort, cycle detection, parallel groups
- `multi-instance.md` — Project identity, slug derivation, state scoping, registry, port collision

### Guides (3 files)
- `getting-started.md` — Install, init, start, stop, delete walkthrough
- `configuration.md` — Full devrig.toml reference with all v0.1 options
- `contributing.md` — Dev setup, running tests, code organization, PR guidelines
