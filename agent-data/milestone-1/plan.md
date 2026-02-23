# Implementation Plan — v0.2: Infrastructure Containers

## Overview

Milestone v0.2 extends devrig from a pure local-process orchestrator into a full development environment manager that handles Docker container lifecycle, service discovery, template interpolation, and compose interop. It builds directly on the v0.1 foundation — config model, orchestrator, dependency graph, supervisor, state management — and adds three new modules (`infra`, `compose`, `discovery`) alongside significant extensions to existing modules.

By the end of v0.2:
- `[infra.*]` blocks define Docker containers that devrig pulls, starts, health-checks, and initializes
- `[compose]` delegates to an existing `docker-compose.yml` for infrastructure
- All services receive `DEVRIG_*` environment variables for automatic service discovery
- Template expressions like `{{ infra.postgres.port }}` resolve across the config
- `devrig env`, `devrig exec`, and `devrig reset` are available as new CLI commands
- Docker networks and volumes are project-scoped and labeled for safe multi-instance operation

---

## Architecture Overview

### New Module Structure

```
src/
  lib.rs                     # Add infra, compose, discovery module declarations
  cli.rs                     # Add Env, Exec, Reset subcommands
  config/
    model.rs                 # Extend: InfraConfig, ComposeConfig, ReadyCheck, NetworkConfig
    validate.rs              # Extend: validate infra refs, compose refs, cross-type port conflicts
    interpolate.rs           # NEW: Template expression resolution ({{ path.to.value }})
  orchestrator/
    mod.rs                   # Rewrite: multi-phase startup (network → compose → infra → resolve → services)
    graph.rs                 # Extend: unified graph with services + infra + compose as ResourceKind
    ports.rs                 # Extend: sticky auto-ports for infra, infra port conflict checks
    state.rs                 # Extend: InfraState, ComposeServiceState, network_name
  infra/                     # NEW MODULE
    mod.rs                   # InfraManager struct, Docker client, re-exports
    container.rs             # Container create/start/stop/remove lifecycle
    image.rs                 # Image pulling with progress reporting
    volume.rs                # Volume creation and cleanup
    network.rs               # Network create/remove/connect
    exec.rs                  # Docker exec (init scripts, cmd ready checks)
    ready.rs                 # Ready check strategies (pg_isready, cmd, http, tcp, log)
  compose/                   # NEW MODULE
    mod.rs                   # ComposeManager struct, re-exports
    lifecycle.rs             # compose up/down/ps via docker compose CLI
    bridge.rs                # Network bridging for compose containers
  discovery/                 # NEW MODULE
    mod.rs                   # Re-exports
    env.rs                   # DEVRIG_* variable building
    url.rs                   # URL generation (postgres://, redis://, http://)
  commands/
    mod.rs                   # Add env, exec, reset exports
    env.rs                   # NEW: devrig env <service>
    exec.rs                  # NEW: devrig exec <infra>
    reset.rs                 # NEW: devrig reset <infra>
    ps.rs                    # Extend: show infra status
    doctor.rs                # Extend: verify Docker daemon is running
  ui/
    summary.rs               # Extend: show infra endpoints and compose services
```

### Dependency Additions (Cargo.toml)

```toml
bollard = "0.20"
futures-util = "0.3"
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
backon = "1"
```

### Phase Architecture

The orchestrator start sequence expands from v0.1's single-phase model to a multi-phase pipeline:

```
devrig start
  │
  ├─ Phase 0: Parse & Validate
  │   ├─ Parse devrig.toml (services + infra + compose)
  │   ├─ Validate config (deps across types, ports, cycles)
  │   └─ Load previous state (.devrig/state.json) for port stickiness
  │
  ├─ Phase 1: Network
  │   └─ Create Docker network (devrig-{slug}-net)
  │
  ├─ Phase 2: Compose (if [compose] present)
  │   ├─ docker compose -f <file> -p devrig-{slug} up -d [services...]
  │   ├─ docker compose ps --format json (get container IDs + published ports)
  │   ├─ Connect compose containers to devrig network
  │   └─ Run ready checks for compose services
  │
  ├─ Phase 3: Infrastructure
  │   ├─ Pull images (parallel, with progress reporting)
  │   ├─ Create volumes
  │   ├─ Start containers (respecting depends_on order from unified graph)
  │   ├─ Run ready checks (poll with backoff via backon)
  │   └─ Run init scripts (if first time, tracked in state.json)
  │
  ├─ Phase 4: Resolve & Inject
  │   ├─ Resolve all auto-assigned ports (both service and infra)
  │   ├─ Build template variable map
  │   ├─ Resolve template expressions in service env values
  │   ├─ Generate DEVRIG_* environment variables
  │   └─ Check for port conflicts
  │
  ├─ Phase 5: Services
  │   ├─ Inject env vars (global + service + DEVRIG_* + PORT/HOST)
  │   ├─ Spawn processes (respecting depends_on)
  │   └─ Begin log multiplexing
  │
  ├─ Print startup summary (services + infra + compose)
  └─ Enter watch mode
```

---

## Key Design Decisions

### 1. Config Model Extensions

`DevrigConfig` gains three new optional sections: `infra`, `compose`, and `network`. All use `#[serde(default)]` so existing v0.1 configs work unchanged.

`InfraConfig` supports both `port` (single port) and `ports` (named port map) to handle services like Mailpit that expose multiple ports. The `ReadyCheck` enum uses `#[serde(tag = "type")]` for clean TOML representation.

### 2. Unified Dependency Graph

The `DependencyResolver` currently only knows about services. It must be extended to include infra and compose nodes in a single graph. A service can `depends_on` an infra name (e.g., `depends_on = ["postgres"]` where `postgres` is `[infra.postgres]`). The graph uses a `ResourceKind` enum to distinguish node types so the orchestrator knows how to start each one.

### 3. Docker Resource Naming

All Docker resources are namespaced with the project slug:
- Container: `devrig-{slug}-{name}`
- Network: `devrig-{slug}-net`
- Volume: `devrig-{slug}-{volume_name}`

Every resource gets labels (`devrig.project`, `devrig.service`, `devrig.managed-by`) for discovery and cleanup, enabling `devrig delete` to work even without state.json.

### 4. Template Resolution Before Service Start

Template expressions only reference concrete values: `project.name`, `services.*.port`, `infra.*.port`. Resolution happens after all ports are assigned (Phase 4), before services are spawned (Phase 5). A two-pass approach validates all references exist, then replaces. The regex `\{\{\s*([\w.]+)\s*\}\}` handles the simple dot-path syntax.

### 5. Sticky Auto Ports

When `port = "auto"`, devrig records the assigned port and `port_auto = true` in state.json. On subsequent starts, it tries to reuse the same port. This prevents services from seeing a different `DEVRIG_*_PORT` every restart.

### 6. Ready Check Strategy

Each strategy maps to a different implementation:
- `pg_isready` → Docker exec: `pg_isready -h localhost -q -t 2`
- `cmd` → Docker exec with optional `expect` stdout matching
- `http` → reqwest GET, check 2xx
- `tcp` → `TcpStream::connect` to localhost:port
- `log` → bollard logs stream, scan for pattern match

All except `log` use backon's `Retryable` with exponential backoff (250ms → 3s, total timeout 30s). `log` uses a streaming approach with a 60s total timeout.

### 7. Compose Interop

Compose interaction shells out to `docker compose` CLI (not bollard, since bollard doesn't implement Compose spec). After `compose up`, devrig connects compose containers to the devrig network and runs configured ready checks. Compose services participate in the unified dependency graph and service discovery.

### 8. Service Discovery

Every service process receives:
- `DEVRIG_{NAME}_HOST=localhost` for all services and infra
- `DEVRIG_{NAME}_PORT={port}` for all services and infra
- `DEVRIG_{NAME}_URL={url}` with protocol-appropriate URLs
- `DEVRIG_{NAME}_PORT_{PORTNAME}={port}` for named ports
- `PORT` and `HOST` for the service's own port

URL generation uses image-name heuristics: `postgres` → `postgres://`, `redis` → `redis://`, default → `http://`.

---

## Integration Points with Existing Code

### Config Module (`src/config/`)

- `model.rs`: Add `InfraConfig`, `ComposeConfig`, `ReadyCheck`, `NetworkConfig` structs. Add `infra`, `compose`, `network` fields to `DevrigConfig`.
- `validate.rs`: Extend validation to check infra dependency references, cross-type port conflicts (infra + services sharing ports), and compose service references.
- `mod.rs`: No changes needed (existing `load_config` will deserialize new sections automatically via serde).

### Orchestrator Module (`src/orchestrator/`)

- `mod.rs`: Major rewrite. The `start()` method becomes multi-phase. Docker client initialization. Infra lifecycle before service spawn. Template resolution step.
- `graph.rs`: Add `ResourceKind` enum. `from_config()` adds infra and compose nodes alongside service nodes. Dependency edges cross resource types.
- `ports.rs`: Add `resolve_port()` with sticky port logic. Extend `check_all_ports()` to include infra ports.
- `state.rs`: Add `InfraState`, `ComposeServiceState` structs. Extend `ProjectState` with `infra`, `compose_services`, `network_name` fields.

### CLI (`src/cli.rs`, `src/main.rs`)

- `cli.rs`: Add `Env`, `Exec`, `Reset` variants to `Commands`.
- `main.rs`: Add dispatch for new commands (env, exec, reset).

### UI (`src/ui/`)

- `summary.rs`: Add infrastructure and compose sections to startup summary output.

### Commands (`src/commands/`)

- `doctor.rs`: Check Docker daemon connectivity (not just binary presence).
- `ps.rs`: Show infra container status alongside service status.

---

## Testing Strategy

### New Integration Tests

All Docker-dependent tests are feature-gated behind `#[cfg(feature = "integration")]`.

| Test | What It Verifies |
|---|---|
| `infra_postgres_lifecycle` | Start postgres → pg_isready → connect → init SQL → stop → container removed |
| `infra_redis_lifecycle` | Start redis → cmd ready check → connect → stop → removed |
| `ready_check_http` | HTTP endpoint check returns 2xx |
| `ready_check_tcp` | TCP port check succeeds when port is open |
| `ready_check_log` | Log pattern matching detects readiness string |
| `init_scripts_run_once` | Init SQL runs on first start, skipped on restart, runs again after reset |
| `service_discovery_vars` | DEVRIG_POSTGRES_HOST/PORT/URL injected into service processes |
| `url_generation` | postgres:// URL with credentials, redis:// URL, http:// URL |
| `devrig_env_output` | `devrig env api` shows correct resolved variables |
| `auto_port_persistence` | Auto-assigned port persists across stop/start |
| `template_resolution` | `{{ infra.postgres.port }}` resolves correctly in env vars |
| `compose_interop` | Compose services start, connect to devrig network |
| `volume_cleanup` | `devrig delete` removes all project-scoped volumes |
| `network_isolation` | Two devrig projects have separate networks |
| `leaked_resource_check` | After delete, zero Docker resources with matching project labels |

### Unit Tests

| Module | Tests |
|---|---|
| `config::model` | InfraConfig parsing, ComposeConfig parsing, ReadyCheck variants, named ports |
| `config::validate` | Cross-type dependency refs, infra port conflicts, compose service refs |
| `config::interpolate` | Template resolution, missing variable errors, nested refs, no-op on no templates |
| `discovery::url` | URL generation for postgres, redis, generic, multi-port |
| `discovery::env` | DEVRIG_* variable building, named port vars, service own PORT/HOST |
| `orchestrator::graph` | Unified graph with mixed resource types, cross-type dependencies |

### Test Patterns

Every integration test:
1. Creates a unique `TestProject` with temp directory (unique project slug)
2. Uses alpine-based Docker images for speed (`postgres:16-alpine`, `redis:7-alpine`)
3. Verifies actual connectivity (not just devrig thinks it worked)
4. Cleans up via `devrig delete` equivalent
5. Asserts zero leaked Docker resources via label-based queries

### Cleanup Verification Helper

```rust
async fn assert_no_leaked_resources(docker: &Docker, slug: &str) {
    // Query containers, volumes, networks by label devrig.project={slug}
    // Assert all empty
}
```

---

## Documentation Plan

### New Files

- `docs/architecture/service-discovery.md` — How DEVRIG_* vars are generated, URL patterns, template expressions, the resolve phase
- `docs/guides/compose-migration.md` — Moving from docker-compose to native infra, coexistence patterns, ready checks for compose services

### Updated Files

- `docs/guides/configuration.md` — Add `[infra.*]`, `[compose]`, ready checks, init scripts, service discovery vars, template expressions, `port = "auto"` for infra
- `README.md` — Add infrastructure section to example config, update feature list

---

## Implementation Order

The implementation follows a bottom-up dependency order, same as v0.1. Each step produces compilable code with tests.

1. **Cargo.toml + dependencies** — Add bollard, futures-util, reqwest, backon
2. **Config model extensions** — InfraConfig, ComposeConfig, ReadyCheck types + unit tests
3. **Config validation extensions** — Cross-type dependency validation, infra port checks
4. **Template interpolation** — New `interpolate.rs` module + unit tests
5. **State model extensions** — InfraState, ComposeServiceState, extended ProjectState
6. **Unified dependency graph** — ResourceKind, mixed-type graph, cross-type edges
7. **Docker network management** — Network create/remove/connect via bollard
8. **Docker image pulling** — Image pull with progress, local image check
9. **Docker container lifecycle** — Container create/start/stop/remove with labels
10. **Docker volume management** — Volume create/remove with project-scoped naming
11. **Docker exec** — Exec for init scripts and cmd ready checks
12. **Ready check strategies** — All 5 strategies with backon retry
13. **InfraManager** — Ties together container, image, volume, network, exec, ready
14. **Compose lifecycle** — compose up/down/ps via CLI, network bridging
15. **Service discovery** — DEVRIG_* env var generation, URL generation
16. **Orchestrator rewrite** — Multi-phase startup integrating all new modules
17. **CLI commands** — devrig env, exec, reset
18. **UI extensions** — Startup summary with infra/compose sections, ps with infra
19. **Integration tests** — All Docker-dependent tests
20. **Documentation** — service-discovery.md, compose-migration.md, config guide update
