# Milestone Report — v0.2: Infrastructure Containers

## Summary

Milestone v0.2 extends devrig from a local-process orchestrator into a full development environment manager capable of Docker container lifecycle management, service discovery, template interpolation, and docker-compose interop. The implementation adds three new modules (`infra`, `compose`, `discovery`), three new CLI commands (`env`, `exec`, `reset`), and a multi-phase orchestrator startup pipeline — all backed by 98 unit tests and 28 integration tests with zero leaked Docker resources. The milestone required two verification passes: the first pass completed all 23 implementation steps but failed 7 verification checks (formatting, test race conditions, missing integration tests, documentation paths); the second pass resolved all failures.

---

## Features Implemented

### 1. `[infra.*]` blocks with Docker container lifecycle — COMPLETE

Docker containers are managed through the new `src/infra/` module using the `bollard` crate for the Docker Engine API. `InfraManager` (`src/infra/mod.rs`) coordinates the full lifecycle: image pull, volume creation, container creation with labels/env/ports/network, start, ready check, and init script execution. All containers are named `devrig-{slug}-{name}` and labeled with `devrig.project`, `devrig.service`, and `devrig.managed-by` for discovery and cleanup.

**Key files:** `src/infra/mod.rs`, `container.rs`, `image.rs`, `volume.rs`, `network.rs`, `exec.rs`, `ready.rs`

### 2. Image pulling and volume management — COMPLETE

Image pulling uses bollard's streaming `create_image` API with progress reporting and error detection via `error_detail` inspection. Images are checked locally before pulling (`inspect_image`). Multiple images are pulled in parallel via `tokio::JoinSet`. Volume specs like `pgdata:/var/lib/postgresql/data` are parsed into project-scoped Docker volumes (`devrig-{slug}-pgdata`).

**Key files:** `src/infra/image.rs` (4 unit tests), `src/infra/volume.rs` (4 unit tests)

### 3. Ready check system — COMPLETE

All five built-in strategies are implemented:

| Strategy | Implementation |
|---|---|
| `pg_isready` | Docker exec: `pg_isready -h localhost -q -t 2`, exit code 0 = ready |
| `cmd` | Docker exec with optional `expect` stdout matching |
| `http` | `reqwest::Client::get(url)`, check for 2xx status |
| `tcp` | `tokio::net::TcpStream::connect` with 2s timeout |
| `log` | bollard logs stream with `follow: true`, scan for pattern match |

All poll-based strategies use `backon` with exponential backoff (250ms min, 3s max delay, jitter) wrapped in a total timeout (30s default, 60s for log). Each retry is logged at debug level. On timeout, the last error and attempt count are reported.

**Key file:** `src/infra/ready.rs`
**Integration tests:** `ready_checks::ready_check_tcp_with_redis`, `ready_check_cmd_with_redis`, `ready_check_pg_isready`, `ready_check_log_with_postgres`

### 4. Init script execution and tracking — COMPLETE

Init scripts run via Docker exec after the ready check passes. For postgres images, scripts execute via `psql -U <user> -c "<script>"`; for other images, via `sh -c "<script>"`. Completion is tracked in `state.json` via `init_completed: bool` and `init_completed_at` timestamp. Scripts are skipped on subsequent starts and re-enabled by `devrig reset`.

**Key file:** `src/infra/exec.rs`
**Integration test:** `init_scripts::init_scripts_run_once`

### 5. Service discovery: DEVRIG_* environment variables — COMPLETE

Every service process receives auto-generated environment variables for all infra and services:

- `DEVRIG_{NAME}_HOST=localhost`
- `DEVRIG_{NAME}_PORT={resolved_port}`
- `DEVRIG_{NAME}_URL={protocol}://...`
- `DEVRIG_{NAME}_PORT_{PORTNAME}={port}` (for named ports)
- `PORT` and `HOST` for the service's own port

**Key files:** `src/discovery/env.rs` (5 unit tests), `src/discovery/mod.rs`
**Integration tests:** `service_discovery::devrig_vars_injected_via_env_command`

### 6. URL generation — COMPLETE

URLs are generated using image-name heuristics:

| Image prefix | URL pattern |
|---|---|
| `postgres` | `postgres://{user}:{pass}@localhost:{port}` |
| `redis` | `redis://localhost:{port}` |
| Multi-port | `localhost:{port}` (no protocol) |
| Default | `http://localhost:{port}` |

Credentials are extracted from infra env vars (`POSTGRES_USER`, `POSTGRES_PASSWORD`).

**Key file:** `src/discovery/url.rs` (6 unit tests)
**Integration test:** `service_discovery::url_generation_correctness`

### 7. `devrig env <service>` command — COMPLETE

Loads config and state, resolves all ports and template variables, builds the complete service environment via the discovery module, and prints `KEY=VALUE` pairs. Supports `--export` flag for `export KEY="VALUE"` format and optional specific variable lookup.

**Key file:** `src/commands/env.rs`
**Integration tests:** `env_command::env_command_shows_vars`, `env_command::env_command_unknown_service`

### 8. Auto port selection with state persistence — COMPLETE

When `port = "auto"`, devrig assigns a free port and records it with `port_auto = true` in `state.json`. On subsequent starts, it attempts to reuse the same port for stability. If the previous port is occupied, a new one is assigned. Port allocation tracks all assigned ports in a `HashSet<u16>` to prevent self-collisions.

**Key files:** `src/orchestrator/ports.rs`
**Integration test:** `service_discovery::auto_port_persistence`

### 9. Template expression resolution — COMPLETE

A regex-based resolver (`\{\{\s*([\w.]+)\s*\}\}`) handles `{{ dotted.path }}` expressions. Variables available: `project.name`, `services.{name}.port`, `infra.{name}.port`. Resolution uses a two-pass approach: validate all references exist, then replace. The variable map is built after all ports are resolved (Phase 4) and before services are spawned (Phase 5).

**Key file:** `src/config/interpolate.rs` (6 unit tests)
**Integration test:** `service_discovery::template_resolution_in_env`

### 10. `devrig exec` and `devrig reset` — COMPLETE

`devrig exec <infra>` shells out to `docker exec -it <container> /bin/sh` using `std::process::Command` (not tokio) for real TTY support. `devrig reset <infra>` clears the `init_completed` flag in state.json so init scripts re-run on the next start.

**Key files:** `src/commands/exec.rs`, `src/commands/reset.rs`
**Integration test:** `reset_command::reset_clears_init_flag`

### 11. Docker network creation and management — COMPLETE

A project-scoped bridge network (`devrig-{slug}-net`) is created in Phase 1 of startup. All infra containers and compose containers are connected to it, enabling DNS-based service discovery between containers. Networks are idempotently created (check-then-create) and removed on `devrig delete`.

**Key file:** `src/infra/network.rs`
**Integration test:** `network_tests::network_isolation`

### 12. `[compose]` interop — COMPLETE

Compose interaction shells out to `docker compose` CLI (bollard doesn't implement the Compose spec). After `compose up -d`, devrig queries container state via `compose ps --format json`, connects compose containers to the devrig network with service-name aliases, and runs configured ready checks. The compose project name is set to `devrig-{slug}` for namespace isolation.

**Key files:** `src/compose/lifecycle.rs`, `src/compose/bridge.rs`
**Integration test:** `compose_interop::compose_basic`

### 13. Compose + native infra coexistence on shared network — COMPLETE

Both compose and native infra containers connect to the same `devrig-{slug}-net` bridge network. DNS resolution allows cross-communication by container name. Service discovery via `DEVRIG_*` vars works identically for compose and native infra resources.

---

## Architecture

### Multi-Phase Orchestrator

The v0.1 single-phase startup was rewritten into a 6-phase pipeline in `src/orchestrator/mod.rs`:

```
Phase 0: Parse & Validate → Load state for port stickiness
Phase 1: Network          → Create devrig-{slug}-net
Phase 2: Compose           → docker compose up, bridge to network, ready checks
Phase 3: Infrastructure    → Pull images, create volumes, start containers, ready checks, init scripts
Phase 4: Resolve & Inject  → Resolve auto-ports, build template vars, resolve templates, generate DEVRIG_* vars
Phase 5: Services          → Inject env, spawn processes, begin log multiplexing
```

Phase 4 must follow Phase 3 because infra containers may have auto-assigned ports that need resolution before template expressions can be evaluated.

### Unified Dependency Graph

`src/orchestrator/graph.rs` was extended with a `ResourceKind` enum (`Service`, `Infra`, `Compose`) so services can depend on infra names (e.g., `depends_on = ["postgres"]` where `postgres` is `[infra.postgres]`). The topological sort produces `Vec<(String, ResourceKind)>` so the orchestrator knows how to start each node (Docker container vs compose vs local process). 14 unit tests cover the graph logic.

### Docker Resource Naming and Labels

All Docker resources use project-slug namespacing:
- Container: `devrig-{slug}-{name}`
- Network: `devrig-{slug}-net`
- Volume: `devrig-{slug}-{volume_name}`

Every resource is labeled with `devrig.project={slug}`, `devrig.service={name}`, `devrig.managed-by=devrig`. This enables label-based discovery for cleanup (even without state.json) and multi-instance isolation.

### New Module Structure

Three new top-level modules were added:

- **`src/infra/`** (7 files) — Docker container lifecycle via bollard: network, image, container, volume, exec, ready checks, and InfraManager coordinator
- **`src/compose/`** (3 files) — Compose CLI interaction and network bridging
- **`src/discovery/`** (3 files) — DEVRIG_* env var generation and URL heuristics

### New Dependencies

| Crate | Version | Purpose |
|---|---|---|
| `bollard` | 0.20 | Docker Engine API client |
| `futures-util` | 0.3 | Stream combinators for bollard's streaming APIs |
| `reqwest` | 0.12 | HTTP ready checks (rustls-tls, no OpenSSL) |
| `backon` | 1.x | Retry with exponential backoff for ready check polling |

---

## Tests

### Unit Tests — 98 passing

| Module | Count |
|---|---|
| `config::model` | 28 |
| `config::validate` | 16 |
| `config::interpolate` | 6 |
| `config::resolve` | 5 |
| `orchestrator::graph` | 14 |
| `orchestrator::supervisor` | 5 |
| `discovery::env` | 5 |
| `discovery::url` | 6 |
| `identity` | 4 |
| `infra::image` | 4 |
| `infra::volume` | 4 |
| **Total** | **98** |

### Integration Tests — 28 passing

All gated behind `#[cfg(feature = "integration")]` and require a running Docker daemon.

| Test File | Tests | What It Verifies |
|---|---|---|
| `infra_lifecycle` | 3 | Container start/stop, env injection, delete cleanup |
| `ready_checks` | 4 | tcp, cmd, pg_isready, log strategies with real containers |
| `init_scripts` | 1 | Init runs once, reset re-enables |
| `service_discovery` | 4 | DEVRIG_* vars, URL generation, template resolution, auto-port persistence |
| `env_command` | 2 | env output, unknown service error |
| `reset_command` | 1 | Reset clears init flag |
| `compose_interop` | 1 | Compose up/down lifecycle with network bridging |
| `volume_cleanup` | 1 | Delete removes Docker volumes |
| `network_tests` | 1 | Network isolation between projects |
| `leaked_resources` | 1 | Zero leaked Docker resources after delete |
| `label_cleanup` | 1 | Delete removes state file |
| `start_stop` | 1 | Basic start/stop lifecycle |
| `config_file_flag` | 1 | Custom config file path |
| `crash_recovery` | 1 | Process crash recovery |
| `multi_instance` | 1 | Two projects, no crosstalk |
| `ps_all` | 1 | `devrig ps --all` output |
| `exec_in_container` | 1 | Exec into infra container |
| `depends_on_order` | 1 | Dependency ordering |
| `auto_port` | 1 | Auto port assignment |

All integration tests use dual-layer cleanup: `devrig delete` + direct Docker CLI fallback via `docker_cleanup()` helper in `tests/common/mod.rs`.

---

## Documentation

### Created

- **`docs/architecture/service-discovery.md`** — How DEVRIG_* vars are generated, URL generation rules with image-name heuristics, template expression syntax and resolution order, the resolve phase in the startup pipeline, `devrig env` command usage
- **`docs/guides/compose-migration.md`** — When to use compose vs native infra, configuration examples, coexistence on shared network, ready checks for compose services, migration path from compose to native

### Updated

- **`docs/guides/configuration.md`** — Complete rewrite covering all v0.2 features: `[infra.*]` section with all fields, `[compose]` section, ready check types table with timeouts, init scripts, volumes with project-scoped naming, template expressions, service discovery variables, URL generation heuristics, CLI commands reference (start, stop, delete, ps, env, exec, reset, doctor, init), complete example configuration, validation rules

---

## Verification Status

**Overall: PASSED (30/30 checks)**

```
cargo fmt --check              PASS
cargo clippy -- -D warnings    PASS  (0 warnings)
cargo build                    PASS
cargo test                     PASS  (98 unit tests)
cargo test --features integration  PASS  (28 integration tests)
Docker resource leaks          PASS  (0 containers, 0 volumes, 0 networks)
```

All 23 implementation steps validated. All documentation at correct paths with required content. All CLI commands registered. Config backwards compatibility confirmed. Full verification details in `verification-results.md`.

### Verification Pass 2 Fixes

The first execution pass completed all 23 steps but failed 7 verification checks:

1. **`cargo fmt`** — 17 files had formatting differences. Fixed by running `cargo fmt`.
2. **`label_cleanup::delete_removes_state`** — Test sent SIGINT (which triggers stop, not delete per commit fc86ddc) then asserted state file was removed. Fixed: assert state IS preserved after SIGINT, then run explicit delete.
3. **`reset_command::reset_clears_init_flag`** — Race condition: SIGINT sent before state.json written to disk. Fixed: added wait loop for state.json existence (up to 10s).
4. **Missing integration tests** — 7 new test files with 16 test functions created (ready_checks, init_scripts, service_discovery, volume_cleanup, network_tests, leaked_resources, compose_interop).
5. **Documentation paths** — Files at wrong locations. Moved to `docs/architecture/` and `docs/guides/` respectively.
6. **Configuration guide gaps** — Complete rewrite with all v0.2 features.
7. **Docker resource leaks** — Added `docker_cleanup()` fallback and state.json wait loops to all Docker-using tests.

---

## Known Issues

None. All verification checks pass. No known bugs, test flakiness, or incomplete items.

---

## Next Milestone Context

### What v0.3 should know about v0.2's implementation:

1. **Docker client pattern**: `InfraManager` holds a `bollard::Docker` client created via `connect_with_local_defaults()`. The client is created once during orchestrator startup and shared across all infra operations. Any future Docker-related features should reuse this client rather than creating new connections.

2. **State model**: `ProjectState` in `src/orchestrator/state.rs` now contains `infra: BTreeMap<String, InfraState>`, `compose_services: BTreeMap<String, ComposeServiceState>`, and `network_name: Option<String>`. All new fields use `#[serde(default)]` for backwards compatibility. State is written atomically (write to `.tmp`, then rename).

3. **Unified dependency graph**: `src/orchestrator/graph.rs` uses `ResourceKind` enum (`Service`, `Infra`, `Compose`). Any new resource types should add a variant here. The graph's `start_order()` returns `Vec<(String, ResourceKind)>`.

4. **Service discovery**: `src/discovery/env.rs` builds the complete environment for each service. If new resource types are added, `build_service_env()` needs updating to include their DEVRIG_* variables.

5. **Template resolution**: `src/config/interpolate.rs` uses a flat `HashMap<String, String>` with dot-path keys. The variable namespace is currently `project.name`, `services.{name}.port`, `infra.{name}.port`. Expanding this (e.g., adding `infra.{name}.host` or custom variables) requires updating `build_template_vars()`.

6. **Ready check extensibility**: Adding new ready check strategies requires: (1) adding a variant to `ReadyCheck` enum in `src/config/model.rs`, (2) adding the implementation in `src/infra/ready.rs`, (3) adding the dispatch case in `run_ready_check()`.

7. **Label-based cleanup**: All Docker resources are labeled with `devrig.project={slug}`. `devrig delete` uses label queries as the primary cleanup mechanism, with state.json as a secondary source. This dual-path ensures cleanup works even after crashes or corrupted state.

8. **Integration test patterns**: All Docker-dependent tests use `docker_cleanup()` from `tests/common/mod.rs` as a safety net. Tests wait for `state.json` existence before sending signals to avoid race conditions. Each test gets a unique project slug via its temp directory path.

9. **Port resolution**: `src/orchestrator/ports.rs` tracks allocated ports in a `HashSet<u16>` during resolution to prevent TOCTOU races and self-collisions. Both infra and service ports go through the same resolution pipeline.

10. **Compose interop**: Compose is managed via CLI (`docker compose`), not bollard. The compose project name is always `devrig-{slug}`. After `compose up`, containers are connected to the devrig network. This means compose containers appear in two networks: their own compose default network and the devrig network.

### Files created in v0.2 (29 new files):

**Source (17):** `src/infra/{mod,network,image,container,volume,exec,ready}.rs`, `src/compose/{mod,lifecycle,bridge}.rs`, `src/discovery/{mod,env,url}.rs`, `src/config/interpolate.rs`, `src/commands/{env,exec,reset}.rs`

**Tests (10):** `tests/integration/{infra_lifecycle,ready_checks,init_scripts,service_discovery,env_command,reset_command,volume_cleanup,network_tests,leaked_resources,compose_interop}.rs`

**Docs (2):** `docs/architecture/service-discovery.md`, `docs/guides/compose-migration.md`

### Files modified in v0.2 (15):

`Cargo.toml`, `Cargo.lock`, `src/lib.rs`, `src/cli.rs`, `src/main.rs`, `src/orchestrator/{mod,graph,ports,state}.rs`, `src/config/{mod,model,validate}.rs`, `src/commands/{mod,ps,doctor}.rs`, `src/ui/summary.rs`, `tests/integration.rs`, `tests/common/mod.rs`, `docs/guides/configuration.md`
