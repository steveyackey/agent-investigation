# Milestone Report — v0.3: k3d Cluster Support

## Summary

Milestone v0.3 extends devrig with local Kubernetes cluster management via k3d. The implementation adds a `[cluster]` configuration section, automated k3d cluster create/delete lifecycle, an optional local Docker registry, a `[cluster.deploy.*]` build-push-apply pipeline, file watching for automatic rebuild/redeploy, and network bridging between the existing Docker network and the k3d cluster. All 20 implementation steps completed successfully, with 42/42 verification checks passing including three cluster-specific integration tests and full backwards compatibility with v0.2.

## Features Implemented

### 1. `[cluster]` Configuration — COMPLETE

Extended `DevrigConfig` in `src/config/model.rs` with `ClusterConfig` and `ClusterDeployConfig` structs. The `[cluster]` section supports `name` (defaults to `{project.name}-dev`), `agents` (default 1), `ports` (k3d port mapping syntax), `registry` (bool), and a `deploy` map of named deploy entries. Each `[cluster.deploy.*]` entry has `context`, `dockerfile`, `manifests`, `watch`, and `depends_on` fields. Validation in `src/config/validate.rs` enforces non-empty context/manifests, cross-resource name uniqueness, dependency resolution, and cycle detection. Template interpolation in `src/config/interpolate.rs` exposes `{{ cluster.name }}`.

### 2. k3d Cluster Create/Delete Lifecycle — COMPLETE

`src/cluster/mod.rs` implements `K3dManager` with idempotent `create_cluster()`, `delete_cluster()`, `cluster_exists()`, `write_kubeconfig()`, and `kubectl()` methods. Cluster creation uses `--kubeconfig-update-default=false`, `--kubeconfig-switch-context=false`, and `--api-port 127.0.0.1:0` to ensure full isolation. A post-write kubeconfig port fix resolves the k3d bug where `--api-port 0` writes port `0` into the kubeconfig instead of the actual assigned port. The fix discovers the real port via `docker inspect` on the server load balancer container.

### 3. Local Registry Support — COMPLETE

`src/cluster/registry.rs` implements registry port discovery via `docker inspect` and a health check using `reqwest` with `backon` exponential backoff against the `/v2/` endpoint. The registry is created via k3d's `--registry-create` flag with port `0` for automatic host port assignment. Images are pushed as `localhost:{port}/{service}:{timestamp}` and referenced in-cluster as `k3d-devrig-{slug}-reg:{port}/{service}:{timestamp}`.

### 4. `[cluster.deploy.*]` with Build + Manifest Apply — COMPLETE

`src/cluster/deploy.rs` implements the full build-push-apply pipeline: `docker build` (CLI shell-out for `.dockerignore`/BuildKit support), `docker push` to the local registry, and `kubectl apply -f` with isolated kubeconfig. Rebuilds additionally run `kubectl rollout restart` to force pod updates. Each step checks a `CancellationToken` for cancel-and-restart support. Image tags use unix timestamps for uniqueness, avoiding `imagePullPolicy: Always`.

### 5. File Watching for Cluster-Deployed Services — COMPLETE

`src/cluster/watcher.rs` uses `notify` + `notify-debouncer-mini` with a 500ms debounce window. Each `watch = true` deploy gets its own watcher task tracked by the existing `TaskTracker`. File events are filtered to ignore `.git`, `target`, `node_modules`, `.devrig`, `.claude`, `__pycache__`, and common temp file extensions (`.swp`, `.swo`, `.tmp`, `.pyc`, `.pyo`). On change, any in-progress build is cancelled via a child `CancellationToken` before starting a new pipeline. Includes 10 unit tests for the ignore logic.

### 6. Network Bridging Between Docker Network and Cluster — COMPLETE

The k3d cluster joins the existing `devrig-{slug}-net` bridge network via `--network`. Because infra containers are started in Phase 3 (before the cluster in Phase 3.5), pods can immediately resolve infra container names via k3d's CoreDNS NodeHosts injection. The network is marked external by k3d, so cluster deletion does not remove it — devrig's own cleanup handles network removal during `devrig delete`.

## Architecture

### Module Structure

```
src/cluster/
  mod.rs           K3dManager: create, delete, status, kubeconfig (230 lines)
  registry.rs      Registry port discovery + health check (78 lines)
  deploy.rs        Docker build/push + kubectl apply pipeline (198 lines)
  watcher.rs       File watching with debounced auto-rebuild (303 lines)
src/commands/
  cluster.rs       CLI command handlers for cluster/kubectl (112 lines)
```

### Key Decisions

1. **Shell-out pattern for k3d and kubectl**: k3d has no Rust client library. The project already shells out to `docker compose`, so `tokio::process::Command` is used consistently for k3d, kubectl, and docker build operations.

2. **kubectl over kube-rs**: `kubectl apply -f` handles all resource types, CRDs, multi-document YAML, and version skew natively. kube-rs would add 5-10MB binary size and ~80 lines of GVK resolution logic for the same functionality. Deferred to v0.5+ if programmatic pod watching is needed.

3. **docker build via CLI, not bollard**: Shell-out to `docker build` handles `.dockerignore`, BuildKit, and multi-stage builds automatically. bollard's `build_image` API requires manual tar archive creation and doesn't support `.dockerignore`.

4. **Phase 3.5 orchestration**: Cluster creation runs after infra (Phase 3) but before service resolution (Phase 4). This ensures infra containers are running and reachable before pods attempt connections, and allows services to declare `depends_on` cluster deploy names.

5. **Kubeconfig isolation**: `~/.kube/config` is never touched. All operations use `.devrig/kubeconfig` with explicit `KUBECONFIG` env var. Integration tests verify this with file checksum comparison.

6. **Graceful shutdown split**: `devrig stop` cancels watchers and builds but leaves the cluster running for fast restart. `devrig delete` tears down everything including the k3d cluster.

### Dependency Additions

| Crate | Version | Purpose |
|-------|---------|---------|
| `notify` | 8 | File system watching for `watch = true` deploys |
| `notify-debouncer-mini` | 0.5 | 500ms event debouncing for rapid saves |
| `scopeguard` | 1 (dev) | Test cleanup guards |

Existing dependencies reused: `bollard` (tag/push), `tokio` (process, sync), `tokio-util` (CancellationToken, TaskTracker), `backon` (registry health retry), `reqwest` (registry health check).

### Kubeconfig Port Fix

A notable implementation detail: when `--api-port 127.0.0.1:0` is passed to k3d, the generated kubeconfig contains `server: https://127.0.0.1:0` instead of the actual assigned port. `K3dManager::write_kubeconfig()` includes a `fix_kubeconfig_port()` step that discovers the real port via `docker inspect k3d-{cluster}-serverlb` and rewrites the kubeconfig. This fix was discovered and resolved during the verification pass.

## Tests

### Unit Tests: 127 total, all passing

| Module | Count | New in v0.3 |
|--------|-------|-------------|
| `config::model` | 34 | 6 (cluster parsing) |
| `config::validate` | 22 | 6 (cluster validation) |
| `config::interpolate` | 7 | 1 (cluster.name template var) |
| `orchestrator::graph` | 20 | 7 (ClusterDeploy in graph) |
| `cluster::watcher` | 10 | 10 (ignore logic) |
| Other existing | 34 | 0 |

### Integration Tests: 3 cluster tests + 28 existing, all passing

| Test | File | Duration | What It Verifies |
|------|------|----------|------------------|
| `cluster_lifecycle` | `tests/integration/cluster_lifecycle.rs` | 25.92s | Full create → kubectl get nodes → kubeconfig isolation → delete cycle. Checksums `~/.kube/config` before/after. |
| `cluster_registry_push_pull` | `tests/integration/cluster_registry.rs` | 27.13s | Registry push/pull: build image, push to local registry, deploy pod using registry image, verify pod starts. |
| `cluster_network_bridge` | `tests/integration/cluster_network.rs` | 35.32s | Start infra Redis + k3d cluster, run a Kubernetes Job that TCP connects to Redis container by name, verify Job succeeds. |

All cluster tests are gated behind `#[cfg(feature = "integration")]` with a runtime `k3d_available()` skip guard. Test infrastructure helpers added to `tests/common/mod.rs`: `k3d_available()`, `k3d_cleanup()`, `k3d_cleanup_sync()`, `wait_for_pod_running()`, `wait_for_job_complete()`, `file_checksum()`.

### Backwards Compatibility: All v0.2 tests passing

| Test Suite | Count | Status |
|------------|-------|--------|
| start_stop | 1 | PASS |
| infra_lifecycle | 3 | PASS |
| service_discovery | 4 | PASS |
| compose_interop | 1 | PASS |
| leaked_resources | 1 | PASS |

## Documentation

### New Files

| File | Lines | Content |
|------|-------|---------|
| `docs/guides/cluster-setup.md` | 274 | Prerequisites, configuration walkthrough, registry usage, manifest conventions, file watching, network connectivity, troubleshooting |
| `docs/architecture/kubeconfig-isolation.md` | 132 | ADR-format document: why devrig never touches `~/.kube/config`, how isolation works, how to access the cluster externally via `export KUBECONFIG` |

### Updated Files

| File | Changes |
|------|---------|
| `docs/guides/configuration.md` | Added `[cluster]` section reference, `[cluster.deploy.*]` section reference, registry configuration, port mappings, `devrig cluster` and `devrig kubectl`/`devrig k` CLI commands, `{{ cluster.name }}` template variable |

## Verification Status

**Result: 42/42 checks passed**

| Category | Checks | Passed |
|----------|--------|--------|
| Build & lint (fmt, clippy, build) | 3 | 3 |
| Unit tests | 5 | 5 |
| Integration tests (cluster) | 3 | 3 |
| Integration tests (all) | 1 | 1 |
| Backwards compatibility | 5 | 5 |
| CLI commands | 5 | 5 |
| Doctor check | 1 | 1 |
| Module existence | 5 | 5 |
| Test file existence | 3 | 3 |
| Documentation content | 3 | 3 |
| Documentation files | 3 | 3 |
| Resource leak check | 1 | 1 |
| **Total** | **42** | **42** |

### Verification Fix Pass

The initial execution passed 37/39 checks but failed 2 integration tests. Three fixes were applied:

1. **Kubeconfig port 0 issue** (`src/cluster/mod.rs`): k3d writes port `0` into kubeconfig when `--api-port 127.0.0.1:0` is used. Fixed by discovering the actual port via `docker inspect` and rewriting the kubeconfig.

2. **Double-panic in scopeguard** (`tests/common/mod.rs`, test files): Async cleanup in scopeguard tried to create a new tokio runtime inside the existing one. Fixed by adding `k3d_cleanup_sync()` using blocking `std::process::Command`.

3. **Stale container name conflict** (`tests/integration/cluster_network.rs`): Previous crashed test runs left stale containers. Fixed by adding pre-test cleanup.

## Known Issues

None. All 42 verification checks pass. No known bugs or incomplete items. Zero resource leaks detected.

## Next Milestone Context

### What v0.4+ should know about this implementation:

1. **K3dManager location**: `src/cluster/mod.rs` — the central struct for all k3d operations. Follows the same pattern as `InfraManager` in `src/infra/mod.rs`.

2. **Kubeconfig path**: Always `.devrig/kubeconfig`. All kubectl operations must set `KUBECONFIG` env var to this path. The `K3dManager::kubectl()` method handles this.

3. **Kubeconfig port fix**: `write_kubeconfig()` includes a workaround for k3d's `--api-port 0` bug. If k3d fixes this upstream, the `fix_kubeconfig_port()` method can be removed.

4. **Registry naming convention**: The k3d registry container is named `k3d-devrig-{slug}-reg`. Port is dynamic (assigned by Docker). Manifests reference images as `k3d-devrig-{slug}-reg:{port}/{service}:{tag}`.

5. **Phase 3.5**: The cluster phase is between infra (Phase 3) and resolve (Phase 4) in `src/orchestrator/mod.rs`. Services can `depends_on` cluster deploy names.

6. **kube-rs upgrade path**: The research evaluated kube-rs and deferred it. If v0.5+ needs programmatic pod watching (e.g., for a dashboard), kube-rs 3.0 + k8s-openapi 0.27 are the recommended crates. The `DynamicObject` + `Discovery` pattern would replace kubectl shell-out for watch/wait operations.

7. **Watcher ignored paths**: Hard-coded in `src/cluster/watcher.rs` (`IGNORED_DIRS`, `IGNORED_EXTENSIONS`). A future milestone could make these configurable or read `.gitignore`/`.dockerignore`.

8. **Network model**: Pods reach infra containers by Docker container name (e.g., `devrig-{slug}-postgres`). This relies on k3d's CoreDNS NodeHosts injection. Users write these names directly in their Kubernetes manifests. A future milestone could generate ConfigMaps or inject env vars automatically.

9. **State file**: `ClusterState` is serialized into the existing `.devrig/state.json` with `#[serde(default)]` for backwards compatibility. Contains cluster name, kubeconfig path, registry info, and per-deploy state (image tag, last deployed timestamp).

10. **Dependencies added**: `notify = "8"`, `notify-debouncer-mini = "0.5"` (runtime), `scopeguard = "1"` (dev only). No heavy additions — binary size impact is minimal.

### Files most likely to need modification in future milestones:

| File | Why |
|------|-----|
| `src/cluster/mod.rs` | Extend K3dManager with new cluster operations |
| `src/cluster/deploy.rs` | Add manifest templating, ConfigMap generation |
| `src/cluster/watcher.rs` | Configurable ignore patterns, .gitignore support |
| `src/orchestrator/mod.rs` | Additional phases, dashboard integration |
| `src/config/model.rs` | New config sections |
| `src/config/validate.rs` | Validation for new features |
| `src/orchestrator/state.rs` | State extensions |
