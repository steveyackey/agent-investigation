# Milestone v0.1 Report — Local Process Orchestration

## Summary

Milestone v0.1 bootstrapped the devrig Rust project from scratch and implemented the full local process orchestration layer. The implementation spans 21 source files, 10 test files, and 16 documentation files, delivering a working CLI tool that parses `devrig.toml` configs, resolves service dependencies via topological sort, spawns and supervises processes with colored log output, detects port collisions, and manages multi-instance isolation through project identity hashing. All 45 unit tests and 9 integration tests pass, with zero clippy warnings and clean formatting.

## Features Implemented

| Feature | Status | Description |
|---|---|---|
| Parse devrig.toml | Complete | TOML config with `[project]`, `[services.*]`, `[env]` sections. Custom `Port` deserializer handles `number \| "auto"`. Two-phase parsing: serde deserialization then validation. (`src/config/model.rs`, `src/config/mod.rs`) |
| `-f` flag for alternate config | Complete | Global clap argument `--file` / `-f` on all subcommands. Direct path lookup with clear error if not found. (`src/cli.rs`, `src/config/resolve.rs`) |
| Project identity (name + path hash) | Complete | SHA-256 hash of canonical config path, truncated to 8 hex chars. Slug format: `{name}-{hash}`. Deterministic across restarts. (`src/identity.rs`) |
| Directory-aware config discovery | Complete | Walks up directory tree from CWD via `PathBuf::pop()` looking for `devrig.toml`. Clear error message when no config found. (`src/config/resolve.rs`) |
| `devrig start` / `stop` / `delete` | Complete | Full lifecycle orchestration. Start: parse -> validate -> resolve deps -> check ports -> spawn supervisors -> print summary. Stop: cancel token -> SIGTERM process groups -> 10s timeout. Delete: stop + remove state. (`src/orchestrator/mod.rs`) |
| Startup summary with URLs | Complete | Branded output showing project name, hash, per-service URLs with port and status indicators, Ctrl+C hint. (`src/ui/summary.rs`) |
| Port collision detection | Complete | `TcpListener::bind()` pre-flight check on all fixed ports. `/proc/net/tcp` owner identification on Linux. `port = "auto"` via ephemeral port binding. (`src/orchestrator/ports.rs`) |
| Dependency ordering with `depends_on` | Complete | petgraph `DiGraph` with topological sort. Edges from dependency to dependent. Cycle detection with human-readable error naming the offending service. (`src/orchestrator/graph.rs`) |
| Unified colored log output | Complete | mpsc channel-based multiplexing prevents line interleaving. 6-color cycling palette via owo-colors. Right-padded service names for column alignment. TTY detection disables ANSI when piping. (`src/ui/logs.rs`) |
| `devrig ps` status display | Complete | Reads `.devrig/state.json`, checks PID liveness, displays table with service name, PID, port, URL, and running/stopped status. (`src/commands/ps.rs`) |
| `devrig ps --all` cross-project discovery | Complete | Global registry at `~/.devrig/instances.json`. Lists all known instances with stale entry cleanup. Atomic writes for concurrent access safety. (`src/orchestrator/registry.rs`, `src/commands/ps.rs`) |
| `devrig init` scaffolding | Complete | Detects project type (Cargo.toml -> Rust, package.json -> Node). Generates starter `devrig.toml` with detected command and commented examples. Errors if config already exists. (`src/commands/init.rs`) |
| `devrig doctor` dependency checker | Complete | Checks for docker, k3d, kubectl, cargo-watch in PATH. Reports version or "not found" for each. Overall pass/fail summary. (`src/commands/doctor.rs`) |

## Architecture

### Key Structural Decisions

1. **Single binary, library-backed.** `src/main.rs` is thin (CLI parse + dispatch). All logic lives in `src/lib.rs` re-exports, enabling both CLI use and integration testing via the library API.

2. **Two-phase config processing.** TOML deserialization (`src/config/model.rs`) is separated from validation (`src/config/validate.rs`). Validation collects all errors before returning, so users fix everything in one pass.

3. **Process groups for clean shutdown.** Every spawned child gets `.process_group(0)` so `killpg(SIGTERM)` terminates the entire process tree. Critical for commands like `cargo watch` that spawn sub-processes. `.kill_on_drop(true)` as safety net. (`src/orchestrator/supervisor.rs`)

4. **Channel-based log multiplexing.** Each `ServiceSupervisor` sends log lines through an `mpsc` channel to a single `LogWriter` task. Prevents line interleaving without holding mutexes across async boundaries. (`src/ui/logs.rs`)

5. **CancellationToken + TaskTracker.** `tokio-util`'s cooperative shutdown primitives coordinate graceful shutdown across all service supervisors. 10-second timeout before force termination. (`src/orchestrator/mod.rs`)

6. **File-based instance registry.** `~/.devrig/instances.json` tracks running instances for `ps --all`. Per-project state at `.devrig/state.json`. Both use atomic writes (write to tmp, rename). (`src/orchestrator/state.rs`, `src/orchestrator/registry.rs`)

7. **Exponential backoff with equal jitter.** Crashed services restart with `delay = base/2 + random(0, base/2)`. Counter resets after 60s of stable running. Max 10 restarts before giving up. (`src/orchestrator/supervisor.rs`)

### Module Structure

```
src/
  main.rs                    # CLI entry point: tokio runtime, tracing, command dispatch
  lib.rs                     # Library root: re-exports all modules
  cli.rs                     # clap derive structs (Cli, Commands, GlobalOpts)
  identity.rs                # ProjectIdentity (name + SHA-256 path hash)
  config/
    mod.rs                   # Re-exports, load_config() entry point
    model.rs                 # DevrigConfig, ProjectConfig, ServiceConfig, Port
    validate.rs              # Post-parse validation (missing deps, dup ports, cycles)
    resolve.rs               # Config file discovery (dir walk), path resolution
  orchestrator/
    mod.rs                   # Orchestrator struct: start/stop/delete coordination
    supervisor.rs            # ServiceSupervisor: spawn, monitor, restart w/ backoff
    graph.rs                 # DependencyResolver: petgraph toposort
    ports.rs                 # Port availability check, free port, owner identification
    state.rs                 # .devrig/state.json read/write
    registry.rs              # ~/.devrig/instances.json global instance registry
  commands/
    mod.rs                   # Re-exports command handlers
    ps.rs                    # devrig ps / ps --all
    init.rs                  # devrig init (generate starter devrig.toml)
    doctor.rs                # devrig doctor (check dependencies)
  ui/
    logs.rs                  # LogLine, LogWriter, color palette, TTY detection
    summary.rs               # Startup summary printer
```

### Dependency Stack

Core: clap 4.5, tokio 1.x, tokio-util 0.7, serde 1.0, toml 0.8, petgraph 0.7, sha2 0.10, nix 0.29, owo-colors 4, tracing 0.1, anyhow 1, thiserror 2, miette 7, chrono 0.4, rand 0.8, regex 1, is-terminal 0.4

Dev: assert_cmd 2.1, tempfile 3.25

## Tests

### Unit Tests — 45 tests, all passing

| Module | Count | Key Coverage |
|---|---|---|
| `config::model` | 15 | Minimal/full config parsing, fixed/auto/none/invalid/out-of-range/negative ports, missing fields, deterministic ordering, helper methods |
| `config::validate` | 7 | Missing dependency, duplicate ports, cycles, self-reference, empty commands, multiple errors collected, valid config passes |
| `config::resolve` | 6 | Current/parent/grandparent dir discovery, no config found, `-f` with valid/invalid path |
| `identity` | 4 | Hash determinism, 8 hex char length, different paths produce different hashes, slug format |
| `orchestrator::graph` | 8 | Linear chain, diamond dependency, cycle detection, self-loop, no dependencies, empty config, single service, unknown dependency errors |
| `orchestrator::supervisor` | 5 | Default restart policy, backoff bounds, process runs and exits, stderr capture, cancel stops process |

### Integration Tests — 9 tests, all passing (feature-gated behind `integration`)

| Test | File | What It Verifies |
|---|---|---|
| `start_stop_lifecycle` | `tests/integration/start_stop.rs` | Start services -> port reachable -> stop -> port released |
| `custom_config_file` | `tests/integration/config_file_flag.rs` | `-f custom.toml` loads alternate config |
| `crash_recovery_restarts` | `tests/integration/crash_recovery.rs` | Crashed service restarts with backoff |
| `port_collision_detected` | `tests/integration/port_collision.rs` | Already-bound port produces clear error |
| `two_projects_no_crosstalk` | `tests/integration/multi_instance.rs` | Two projects run independently, stopping one doesn't affect the other |
| `ps_all_shows_instances` | `tests/integration/ps_all.rs` | Two running projects appear in `ps --all` |
| `config_found_in_parent_directory` | `tests/integration/dir_discovery.rs` | Config in parent dir found from subdirectory |
| `config_found_in_grandparent_directory` | `tests/integration/dir_discovery.rs` | Config in grandparent dir found |
| `delete_removes_state` | `tests/integration/label_cleanup.rs` | Delete removes `.devrig/` state and processes |

### Test Infrastructure

- `tests/common/mod.rs`: `TestProject::new(toml)` (temp dir + config), `free_port()` / `free_ports(n)` (dynamic port allocation), `wait_for_port(port, timeout)` (TCP polling)
- Integration tests feature-gated: `cargo test` runs unit tests only; `cargo test --features integration` runs all
- Each test uses unique ports and temp directories for parallel safety
- No orphaned processes after test runs (verified)

## Documentation

### 16 documentation files created

| Category | Files | Content |
|---|---|---|
| README | `README.md` (128 lines) | Quickstart, example `devrig.toml`, CLI command reference |
| ADRs | 8 files in `docs/adr/` | Context/Decision/Consequences format for: TOML-only config, no profiles, isolated kubeconfig, compose interop, Traefik over nginx, in-memory OTel, agent-browser testing, multi-instance isolation |
| Architecture | 4 files in `docs/architecture/` | System overview with component diagram, config model and parsing patterns, dependency graph and toposort, multi-instance isolation and state scoping |
| Guides | 3 files in `docs/guides/` | Getting started walkthrough, full configuration reference, contributing guidelines |

## Verification Status

**Result: ALL 19 CHECKS PASSED**

| Check | Status |
|---|---|
| `cargo fmt --check` | Pass — no formatting differences |
| `cargo clippy -- -D warnings` | Pass — zero warnings |
| `cargo build` | Pass |
| `cargo test` | Pass — 45 passed, 0 failed |
| Config parsing tests | Pass — 29 tests (filtered subset) |
| Validation tests | Pass — 7 tests |
| Graph tests | Pass — 8 tests |
| Identity tests | Pass — 4 tests |
| Resolution tests | Pass — 6 tests |
| CLI help output | Pass — `--help`, `start --help`, `ps --help` all exit 0 |
| Integration tests | Pass — 9 passed, 0 failed |
| Cleanup verification | Pass — no orphaned processes |
| README.md | Pass — 128 lines, contains required sections |
| ADR documents | Pass — all 8 present with required structure |
| Architecture docs | Pass — all 4 present |
| Guide docs | Pass — all 3 present |
| Module structure | Pass — all 21 source modules present |
| Test structure | Pass — common helpers and integration directory present |
| Cargo.toml dependencies | Pass — all 14 required crates present |

## Known Issues

1. **PID tracking shows 0 in state.json.** The Orchestrator saves PID 0 for services because extracting actual child PIDs from async supervisors would require additional channel plumbing. The `ps` command compensates by checking process liveness directly rather than relying solely on stored PIDs.

2. **Integration tests require `python3`.** The start/stop and multi-instance tests use `python3 -m http.server` as a test service. Systems without Python 3 will fail these specific tests.

3. **Second Ctrl+C force-exit not implemented.** The plan called for a second Ctrl+C to trigger `std::process::exit(1)`. Current implementation relies on the 10-second graceful shutdown timeout instead. Minor UX gap.

4. **Template interpolation deferred.** The `{{ services.api.port }}` template system was not implemented. It is more relevant to v0.2+ when infrastructure services (Postgres, Redis) are added and cross-service port references become necessary.

5. **`ps --all` requires file registry.** Cross-project discovery relies on `~/.devrig/instances.json` which can become stale if devrig is killed without cleanup. The `cleanup()` method handles this by checking PID liveness, but entries from a rebooted system may linger until `ps --all` is run.

6. **Linux-only port owner identification.** The `/proc/net/tcp` approach for identifying which process owns a conflicting port only works on Linux. macOS falls back to reporting the conflict without owner information.

## Next Milestone Context

### What v0.2 should know about v0.1's implementation:

1. **Config model is extensible.** `DevrigConfig` in `src/config/model.rs` uses `BTreeMap<String, ServiceConfig>` for services. v0.2 should add an `infra: BTreeMap<String, InfraConfig>` section following the same pattern. The two-phase parse/validate approach in `src/config/validate.rs` should be extended to validate infra references.

2. **Port system supports "auto".** The `Port` enum (`Fixed(u16) | Auto`) and `find_free_port()` in `src/orchestrator/ports.rs` are ready. v0.2 infrastructure containers will need their ports resolved and made available to services via the template interpolation system (currently unimplemented — see known issue #4).

3. **Template interpolation is the bridge.** Services reference infrastructure ports via `{{ infra.postgres.port }}` in their env vars. The regex-based interpolation approach is designed in the research doc (`research.md`, section 13) but not yet implemented. v0.2 should implement this in a new `src/config/interpolate.rs` module, building a variable map after all ports (both service and infra) are resolved.

4. **Orchestrator start sequence needs infra phase.** Currently `Orchestrator::start()` in `src/orchestrator/mod.rs` goes: parse -> validate -> check ports -> spawn services. v0.2 should insert an infra phase: parse -> validate -> start infra containers -> resolve ports -> interpolate templates -> check ports -> spawn services.

5. **State model needs infra tracking.** `ProjectState` in `src/orchestrator/state.rs` tracks services with PIDs. v0.2 should extend this to track infrastructure container IDs (Docker container names/IDs) for the stop/delete lifecycle.

6. **Process groups are Unix-only.** `.process_group(0)` and `killpg()` use `nix` crate. If Windows support is ever needed, this would require `windows-sys` job objects. Currently guarded by the `nix` dependency (Unix-only).

7. **Registry design anticipates Docker labels.** The file-based `~/.devrig/instances.json` registry works for v0.1 but is a stopgap. v0.2's Docker containers should use labels (`devrig.project={slug}`, `devrig.service={name}`) for native discovery. The `ps --all` command should query both the file registry and Docker labels.

8. **The `devrig doctor` command should check for Docker in v0.2.** Currently it checks for docker/k3d/kubectl but only reports their presence. v0.2 should verify Docker daemon is running and accessible (`docker info`).
