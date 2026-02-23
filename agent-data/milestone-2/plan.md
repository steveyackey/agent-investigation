# Implementation Plan — v0.3: k3d Cluster Support

## Overview

Milestone v0.3 extends devrig with local Kubernetes cluster management via k3d, adding a `[cluster]` config section, k3d cluster create/delete lifecycle, local registry support, `[cluster.deploy.*]` with Docker build + manifest apply, file watching for auto-rebuild, and network bridging between the existing Docker network and the k3d cluster. This builds directly on v0.2's `InfraManager`, Docker network management, and multi-phase orchestrator.

By the end of v0.3:
- `[cluster]` configuration enables a k3d cluster that joins the existing devrig network
- `k3d cluster create/delete` lifecycle is managed automatically during `devrig start/delete`
- A local Docker registry is optionally created for in-cluster image access
- `[cluster.deploy.*]` entries build Docker images, push to the registry, and apply Kubernetes manifests
- File watchers trigger automatic rebuild/redeploy for cluster-deployed services with `watch = true`
- Pods in the k3d cluster can reach infra containers by name via the shared Docker bridge network
- `devrig kubectl`/`devrig k` proxies kubectl with an isolated kubeconfig
- `.devrig/kubeconfig` is the sole kubeconfig — `~/.kube/config` is never touched

---

## Architecture Overview

### New Module Structure

```
src/
  cluster/                   # NEW MODULE
    mod.rs                   # K3dManager: create, delete, status, kubeconfig
    registry.rs              # Registry lifecycle: create, health check, port discovery
    deploy.rs                # Build + push + apply pipeline for cluster.deploy.*
    watcher.rs               # File watching + rebuild trigger for watch=true deploys
  lib.rs                     # Add cluster module declaration
  cli.rs                     # Add Cluster, Kubectl commands
  config/
    model.rs                 # Extend: ClusterConfig, ClusterDeployConfig
    validate.rs              # Extend: validate cluster refs, deploy paths
    interpolate.rs           # Extend: add cluster.name template var
  orchestrator/
    mod.rs                   # Extend: insert Phase 3.5 (cluster) between infra and resolve
    graph.rs                 # Extend: add ClusterDeploy resource kind
    state.rs                 # Extend: ClusterState, ClusterDeployState
  commands/
    mod.rs                   # Add cluster module export
    cluster.rs               # NEW: devrig cluster create/delete/kubeconfig
    doctor.rs                # Extend: k3d version check
  ui/
    summary.rs               # Extend: cluster section in startup summary
```

### Phase Architecture Extension

The orchestrator startup pipeline gains Phase 3.5 between existing Phase 3 (Infrastructure) and Phase 4 (Resolve & Inject):

```
Phase 0: Parse & Validate
Phase 1: Network (create devrig-{slug}-net)
Phase 2: Compose
Phase 3: Infrastructure
Phase 3.5: Cluster ← NEW
  ├─ Check if k3d cluster already exists (idempotent)
  ├─ k3d cluster create --network devrig-{slug}-net
  │   ├─ --kubeconfig-update-default=false
  │   ├─ --kubeconfig-switch-context=false
  │   ├─ --api-port 127.0.0.1:0
  │   └─ --registry-create (if registry = true)
  ├─ Extract kubeconfig to .devrig/kubeconfig
  ├─ Discover registry port (if registry enabled)
  ├─ For each [cluster.deploy.*]:
  │   ├─ docker build context
  │   ├─ docker tag + push to local registry
  │   └─ kubectl apply -f manifests/
  └─ Start file watchers (if watch = true)
Phase 4: Resolve & Inject
Phase 5: Services
```

The cluster phase comes after infra so that infrastructure containers (Postgres, Redis) are already running on the shared network before the cluster connects. This ensures pods can reach infra containers by name immediately.

### Dependency Additions (Cargo.toml)

```toml
notify = "8"
notify-debouncer-mini = "0.5"
```

Note: `serde_yaml` and `tar` are NOT needed — we shell out to `docker build` (handles `.dockerignore`, BuildKit, multi-stage builds) and `kubectl apply` (handles all manifest formats). This is simpler and more compatible.

---

## Key Design Decisions

### 1. Shell-Out Pattern for k3d and kubectl

k3d has no Rust client library — it is designed as a CLI tool. The codebase already shells out to `docker compose` in `src/compose/lifecycle.rs`, so this pattern is proven. The `K3dManager` wraps k3d and kubectl CLI calls with async `tokio::process::Command`, capturing stdout/stderr and returning structured results.

### 2. kubectl Over kube-rs

The v0.3 scope involves applying user-provided manifests and checking pod status. `kubectl apply -f <dir>` handles all resource types, multi-document YAML, CRDs, and version skew natively. kube-rs would require ~80 lines of GVK resolution logic and add 5-10MB binary size. The `devrig k` proxy already wraps kubectl, making it a natural fit. kube-rs can be added in v0.5+ if programmatic pod watching is needed for the dashboard.

### 3. docker build via CLI, Not bollard

Shell out to `docker build` for image building instead of bollard's `build_image` API. This handles `.dockerignore`, BuildKit, and multi-stage builds automatically. bollard would require creating tar archives of the build context and doesn't support `.dockerignore`. Use bollard only for tag + push operations where the streaming API is useful.

**Revised approach for v0.3:** Actually shell out to `docker build`, `docker tag`, and `docker push` for simplicity. bollard's push API has authentication complexity with local registries that CLI push avoids.

### 4. Cancel-and-Restart for File Watch Rebuilds

When files change during an in-progress build, the previous build must be cancelled. Uses `CancellationToken` from `tokio-util` (already a dependency):

```
File change → Debounce (500ms) → Cancel in-progress build → Start new pipeline:
  1. docker build (check cancellation)
  2. docker tag + push (check cancellation)
  3. kubectl apply manifests (check cancellation)
  4. kubectl rollout restart (force new image pull)
```

### 5. Kubeconfig Isolation

k3d is invoked with `--kubeconfig-update-default=false` and `--kubeconfig-switch-context=false`. The kubeconfig is extracted to `.devrig/kubeconfig` after cluster creation. All kubectl invocations set `KUBECONFIG=.devrig/kubeconfig`. Integration tests verify `~/.kube/config` is unchanged before and after the lifecycle.

### 6. Network Bridging via Shared External Network

Phase 1 creates `devrig-{slug}-net`. Phase 3 starts infra on this network. Phase 3.5 passes `--network devrig-{slug}-net` to k3d, which connects all cluster nodes to the devrig network. Because k3d sees this as an external network, it does NOT delete it when the cluster is removed — devrig's Phase 1 cleanup handles network removal during `devrig delete`.

### 7. Registry Naming and Port Discovery

When `cluster.registry = true`, the registry is created via `--registry-create` on `k3d cluster create`:

```bash
k3d cluster create devrig-{slug} --registry-create devrig-{slug}-reg:0.0.0.0:0
```

Port 0 lets Docker assign an available host port. After creation, the port is discovered via `docker inspect`. Images are pushed as `localhost:{port}/{service}:latest` and referenced in-cluster as `k3d-devrig-{slug}-reg:{port}/{service}:latest`.

### 8. Image Tag Strategy

Use `localhost:{registry_port}/{service_name}:{unix_timestamp}` for unique tags on rebuilds. This ensures Kubernetes always pulls the new image without needing `imagePullPolicy: Always`. On initial deploy, also tag as `:latest`.

### 9. Graceful Shutdown Extension

- **`devrig stop`**: Cancel file watchers, cancel in-progress builds, stop services, stop infra. Leave cluster running for fast restart.
- **`devrig delete`**: Cancel watchers, cancel builds, stop services, delete k3d cluster, remove `.devrig/kubeconfig`, delete infra containers/volumes, remove network, remove state.

---

## Config Model Extensions

### ClusterConfig

```rust
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ClusterConfig {
    #[serde(default)]
    pub name: Option<String>,       // Defaults to "{project.name}-dev"
    #[serde(default = "default_agents")]
    pub agents: u32,                // Default: 1
    #[serde(default)]
    pub ports: Vec<String>,         // k3d port mappings: "8080:80@loadbalancer"
    #[serde(default)]
    pub registry: bool,             // Create local registry
    #[serde(default)]
    pub deploy: BTreeMap<String, ClusterDeployConfig>,
}
```

### ClusterDeployConfig

```rust
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ClusterDeployConfig {
    pub context: String,            // Docker build context path
    #[serde(default = "default_dockerfile")]
    pub dockerfile: String,         // Default: "Dockerfile"
    pub manifests: String,          // Path to K8s manifests directory
    #[serde(default)]
    pub watch: bool,                // Rebuild on file changes
    #[serde(default)]
    pub depends_on: Vec<String>,    // Dependencies (infra, etc.)
}
```

### State Extension

```rust
pub struct ClusterState {
    pub cluster_name: String,
    pub kubeconfig_path: String,
    pub registry_name: Option<String>,
    pub registry_port: Option<u16>,
    pub deployed_services: BTreeMap<String, ClusterDeployState>,
}

pub struct ClusterDeployState {
    pub image_tag: String,
    pub last_deployed: DateTime<Utc>,
}
```

### Dependency Graph Extension

```rust
pub enum ResourceKind {
    Service,
    Infra,
    Compose,
    ClusterDeploy,  // NEW
}
```

ClusterDeploy nodes can depend on Infra nodes (e.g., a pod needs Postgres running). Services can depend on ClusterDeploy names.

---

## Integration Points with Existing Code

### Config Module (`src/config/`)

- **`model.rs`**: Add `ClusterConfig`, `ClusterDeployConfig` structs. Add `cluster: Option<ClusterConfig>` to `DevrigConfig`.
- **`validate.rs`**: Add validation for cluster deploy `depends_on` references, check `context` and `manifests` paths conceptually (existence checked at runtime), validate cluster name characters. Add new `ConfigError` variants.
- **`interpolate.rs`**: Add `cluster.name` to template vars. Add `cluster.registry.port` when registry is enabled.

### Orchestrator Module (`src/orchestrator/`)

- **`mod.rs`**: Insert Phase 3.5 cluster logic. Extend `stop()` to cancel watchers. Extend `delete()` to tear down k3d cluster and remove kubeconfig.
- **`graph.rs`**: Add `ClusterDeploy` variant to `ResourceKind`. Add cluster deploy nodes from `config.cluster.deploy` to the graph. Cluster deploy depends_on creates edges.
- **`ports.rs`**: No changes needed — k3d port mappings are configured via k3d CLI flags, not devrig's port allocator.
- **`state.rs`**: Add `ClusterState` and `ClusterDeployState` structs. Add `cluster: Option<ClusterState>` to `ProjectState`.

### CLI (`src/cli.rs`, `src/main.rs`)

- **`cli.rs`**: Add `Cluster` subcommand with `Create`/`Delete`/`Kubeconfig` variants. Add `Kubectl` command with trailing varargs and `k` alias.
- **`main.rs`**: Add dispatch for `Cluster` and `Kubectl` commands.

### Commands (`src/commands/`)

- **`cluster.rs`**: New file implementing `devrig cluster create/delete/kubeconfig` handlers.
- **`doctor.rs`**: Add k3d version check (parse `k3d version` output for v5.x).

### UI (`src/ui/summary.rs`)

Add cluster section to startup summary showing cluster name, status, and deployed services with watch indicators.

### Test Infrastructure (`tests/common/mod.rs`)

Add helpers: `k3d_available()`, `k3d_cleanup()`, `wait_for_pod_running()`.

---

## Testing Strategy

### New Integration Tests

All cluster tests require both Docker and k3d. Gated with `#[cfg(feature = "integration")]` and a runtime `k3d_available()` check that skips if k3d is not installed.

| Test File | Tests | What It Verifies |
|---|---|---|
| `cluster_lifecycle.rs` | 1 | Full create → deploy → verify pod → `devrig k get pods` → delete → no resources remain → kubeconfig removed → `~/.kube/config` untouched |
| `cluster_registry.rs` | 1 | Registry push/pull: build image, push to registry, deploy pod using registry image, pod starts |
| `cluster_network.rs` | 1 | Network bridge: start infra redis + cluster pod that TCP connects to redis container name, pod exits 0 |

### Unit Tests

| Module | Tests |
|---|---|
| `config::model` | ClusterConfig parsing, ClusterDeployConfig parsing, cluster with deploy entries, minimal config still works |
| `config::validate` | Cluster deploy depends_on validation, cluster deploy with unknown dependency errors |
| `orchestrator::graph` | ClusterDeploy nodes in graph, service depends on cluster deploy, cluster deploy depends on infra |
| `orchestrator::state` | ClusterState serialization/deserialization |

### Test Patterns

- Each test uses a unique project slug (via temp directory path)
- k3d cleanup helper as fallback for test crashes
- `~/.kube/config` checksum before/after lifecycle
- Zero leaked Docker resources assertion via label queries

---

## Documentation Plan

### New Files

- **`docs/guides/cluster-setup.md`** — k3d cluster setup guide: prerequisites, configuration, registry usage, manifest conventions, file watching, network connectivity
- **`docs/architecture/kubeconfig-isolation.md`** — Why devrig never touches `~/.kube/config`, how isolation works, how to access the cluster externally

### Updated Files

- **`docs/guides/configuration.md`** — Add `[cluster]` section, `[cluster.deploy.*]` section, registry configuration, port mappings, CLI commands (`devrig cluster`, `devrig kubectl`/`devrig k`)

---

## Implementation Order

The implementation follows bottom-up dependency order. Each step produces compilable code.

### Phase 1: Foundation (Steps 1–5)

1. **Dependencies** — Add notify, notify-debouncer-mini to Cargo.toml
2. **Config model** — ClusterConfig, ClusterDeployConfig types + unit tests
3. **Config validation** — Cluster-specific validation rules
4. **State model** — ClusterState, ClusterDeployState + serialization
5. **Dependency graph** — ClusterDeploy resource kind in unified graph

### Phase 2: Cluster Core (Steps 6–9)

6. **K3dManager core** — Create/delete/exists/kubeconfig operations
7. **Registry support** — Registry creation, port discovery, health check
8. **Deploy pipeline** — Docker build, tag, push, kubectl apply
9. **File watcher** — notify + debounce + cancel-and-restart rebuild

### Phase 3: Integration (Steps 10–13)

10. **Orchestrator extension** — Phase 3.5 cluster startup, shutdown, delete
11. **CLI commands** — Cluster subcommands, kubectl proxy
12. **UI extension** — Startup summary cluster section, doctor k3d check
13. **Template vars** — cluster.name in interpolation

### Phase 4: Quality (Steps 14–16)

14. **Test infrastructure** — k3d helpers in tests/common
15. **Integration tests** — Cluster lifecycle, registry, network bridge
16. **Documentation** — Cluster setup guide, kubeconfig isolation, config reference update
