# v0.3 Milestone Execution Results: k3d Cluster Support

## Status: COMPLETE

All 20 implementation steps completed successfully. All quality gates pass, including all three cluster integration tests (cluster_lifecycle, cluster_registry, cluster_network).

## Quality Gates

| Check | Status |
|-------|--------|
| `cargo build` | PASS |
| `cargo build --features integration` | PASS |
| `cargo test` | PASS (127 tests, 0 failures) |
| `cargo test --features integration cluster_lifecycle` | PASS |
| `cargo test --features integration cluster_registry` | PASS |
| `cargo test --features integration cluster_network` | PASS |
| `cargo fmt --check` | PASS |
| `cargo clippy -- -D warnings` | PASS (0 warnings) |
| `devrig cluster create --help` | PASS (exit 0) |
| `devrig cluster delete --help` | PASS (exit 0) |
| `devrig cluster kubeconfig --help` | PASS (exit 0) |
| `devrig kubectl --help` | PASS (exit 0) |
| `devrig k --help` | PASS (exit 0) |
| `devrig doctor` (k3d check) | PASS (shows k3d v5.8.3) |
| Resource leak check | PASS (0 leaked containers, 0 clusters) |

## Verification Fix Pass

The initial implementation (first execution) passed 37/39 checks but failed 2 integration tests. This fix pass resolved both failures:

### Fix 1: Kubeconfig Port 0 Issue (cluster_lifecycle + cluster_network)

**Root cause**: When `--api-port 127.0.0.1:0` is passed to `k3d cluster create`, k3d lets Docker assign a random port for the API server. However, `k3d kubeconfig get` returns the kubeconfig with `server: https://127.0.0.1:0` instead of the actual assigned port.

**Fix**: Added `fix_kubeconfig_port()` method to `K3dManager::write_kubeconfig()` that:
1. Reads the kubeconfig after writing
2. Checks if any `server:` line ends with `:0`
3. If so, discovers the actual port via `docker inspect k3d-{cluster}-serverlb --format '{{(index .NetworkSettings.Ports "6443/tcp" 0).HostPort}}'`
4. Rewrites the kubeconfig with the correct port

**File**: `src/cluster/mod.rs`

### Fix 2: Double-Panic in Scopeguard (cluster_network)

**Root cause**: The test's `scopeguard` cleanup closure created a new `tokio::runtime::Runtime` inside the already-running tokio test runtime. When the test panicked (due to Fix 1's issue), the scopeguard fired and triggered "Cannot start a runtime from within a runtime", causing a double-panic and SIGABRT.

**Fix**:
- Added `k3d_cleanup_sync()` to `tests/common/mod.rs` — uses `std::process::Command` (blocking) instead of `tokio::process::Command` (async), safe to call from non-async contexts
- Updated all three cluster test scopeguards to use `k3d_cleanup_sync()` and move-capture variables instead of borrowing
- Added pre-test cleanup in cluster_network to remove stale containers/networks from previous failed runs

**Files**: `tests/common/mod.rs`, `tests/integration/cluster_lifecycle.rs`, `tests/integration/cluster_network.rs`, `tests/integration/cluster_registry.rs`

### Fix 3: Stale Container Name Conflict (cluster_network)

**Root cause**: A stale `devrig-nettest-redis` container from a previous crashed test run caused `docker run --name devrig-nettest-redis` to fail with a name conflict.

**Fix**: Added pre-test cleanup at the start of cluster_network test that removes stale resources: `k3d_cleanup_sync()`, `docker rm -f`, `docker_cleanup()`, and `docker network rm`.

**File**: `tests/integration/cluster_network.rs`

## Implementation Summary

### Phase 1: Foundation (Steps 1-5)

**Step 1 — Dependencies**: Added `notify = "8"` and `notify-debouncer-mini = "0.5"` to `[dependencies]`. Added `scopeguard = "1"` to `[dev-dependencies]`.

**Step 2 — Config Model**: Extended `DevrigConfig` with `cluster: Option<ClusterConfig>`. Added `ClusterConfig` struct (name, agents, ports, registry, deploy) and `ClusterDeployConfig` struct (context, dockerfile, manifests, watch, depends_on). Added 6 parsing tests. Updated all manual `DevrigConfig` constructions across validate.rs, graph.rs, env.rs, and interpolate.rs.

**Step 3 — Validation**: Added 3 new `ConfigError` variants (`EmptyDeployContext`, `EmptyDeployManifests`, `DuplicateResourceName`). Extended `validate()` with cluster deploy name availability, depends_on validation, name conflict detection across resource types, cycle detection integration, and empty-field checks. Added 6 new tests.

**Step 4 — State**: Added `ClusterState` (cluster_name, kubeconfig_path, registry_name, registry_port, deployed_services) and `ClusterDeployState` (image_tag, last_deployed) to `ProjectState`. Updated orchestrator to include `cluster: None` in default state construction.

**Step 5 — Graph**: Added `ClusterDeploy` variant to `ResourceKind` enum. Extended `from_config()` to create cluster deploy nodes and dependency edges. Added 7 new graph tests.

### Phase 2: Cluster Core (Steps 6-9)

**Step 6 — K3dManager**: Created `src/cluster/mod.rs` with `K3dManager` struct providing `create_cluster()` (idempotent), `delete_cluster()`, `cluster_exists()`, `write_kubeconfig()` (with port fix), and `kubectl()` methods. Uses shell-out pattern to k3d/kubectl CLIs.

**Step 7 — Registry**: Created `src/cluster/registry.rs` with `get_registry_port()` (docker inspect to find assigned port) and `wait_for_registry()` (backon retry with reqwest health check on /v2/).

**Step 8 — Deploy**: Created `src/cluster/deploy.rs` with `run_deploy()` (docker build, optional push to registry, kubectl apply) and `run_rebuild()` (same plus rollout restart). Supports `CancellationToken` for cancel-and-restart pattern.

**Step 9 — Watcher**: Created `src/cluster/watcher.rs` with `start_watchers()` spawning per-deploy file watchers using `notify-debouncer-mini` with 500ms debounce, tokio mpsc bridge, and intelligent ignore rules (node_modules, .git, target, __pycache__, etc.). Added 10 unit tests for ignore logic.

### Phase 3: Integration (Steps 10-13)

**Step 10 — Orchestrator**: Added Phase 3.5 (between infra and service resolve) implementing full cluster lifecycle: create cluster, write kubeconfig, discover registry port, deploy services, start file watchers. Updated service filter for cluster deploy transitive dependencies. Extended `delete()` to clean up k3d cluster. Added cluster info to startup summary.

**Step 11 — CLI Commands**: Added `Commands::Cluster` (with Create, Delete, Kubeconfig subcommands) and `Commands::Kubectl` (alias "k") to CLI. Created `src/commands/cluster.rs` with handler functions.

**Step 12 — UI**: Extended summary with cluster hint line ("Use: devrig k get pods"). Extended doctor command with k3d v5.x version compatibility check.

**Step 13 — Interpolation**: Added `cluster.name` template variable (defaults to `{project.name}-dev`). Added unit test.

### Phase 4: Quality (Steps 14-20)

**Step 14 — Test Infrastructure**: Added helpers to `tests/common/mod.rs`: `k3d_available()`, `k3d_cleanup()`, `k3d_cleanup_sync()`, `wait_for_pod_running()`, `wait_for_job_complete()`, `file_checksum()`.

**Steps 15-17 — Integration Tests**:
- `cluster_lifecycle.rs`: Full create → kubectl get nodes → verify kubeconfig isolation → delete cycle.
- `cluster_registry.rs`: Registry push/pull validation using hello-world image.
- `cluster_network.rs`: Network bridge connectivity test (Redis on shared Docker network, Kubernetes Job verifying TCP connectivity via k3d's CoreDNS NodeHosts injection).

All gated behind `#[cfg(feature = "integration")]` with `k3d_available()` skip guard.

**Steps 18-20 — Documentation**:
- `docs/guides/cluster-setup.md` (274 lines): Practical setup guide with prerequisites, configuration, deployment walkthrough, and troubleshooting.
- `docs/architecture/kubeconfig-isolation.md` (132 lines): ADR-format document explaining the kubeconfig isolation design decision.
- `docs/guides/configuration.md`: Updated with cluster configuration sections (675 lines total).

## Files Changed

### New Files (10 files, ~1,657 lines)

| File | Lines | Purpose |
|------|-------|---------|
| `src/cluster/mod.rs` | 230 | K3dManager — cluster lifecycle with kubeconfig port fix |
| `src/cluster/registry.rs` | 78 | Registry port discovery + health check |
| `src/cluster/deploy.rs` | 198 | Docker build/push + kubectl apply pipeline |
| `src/cluster/watcher.rs` | 303 | File watching with debounced auto-rebuild |
| `src/commands/cluster.rs` | 112 | CLI command handlers |
| `tests/integration/cluster_lifecycle.rs` | 141 | Lifecycle integration test |
| `tests/integration/cluster_registry.rs` | 92 | Registry integration test |
| `tests/integration/cluster_network.rs` | 141 | Network bridge integration test |
| `docs/guides/cluster-setup.md` | 274 | Setup guide |
| `docs/architecture/kubeconfig-isolation.md` | 132 | Architecture decision record |

### Modified Files (17 files)

| File | Purpose of Changes |
|------|--------------------|
| `Cargo.toml` | Added notify, notify-debouncer-mini, scopeguard |
| `src/lib.rs` | Added `pub mod cluster` |
| `src/config/model.rs` | ClusterConfig, ClusterDeployConfig structs + 6 tests |
| `src/config/validate.rs` | 3 new error variants, cluster validation + 6 tests |
| `src/config/interpolate.rs` | cluster.name template variable + 1 test |
| `src/orchestrator/state.rs` | ClusterState, ClusterDeployState structs |
| `src/orchestrator/graph.rs` | ClusterDeploy resource kind + 7 tests |
| `src/orchestrator/mod.rs` | Phase 3.5 cluster lifecycle, delete cleanup |
| `src/cli.rs` | Cluster and Kubectl commands |
| `src/main.rs` | Command dispatch for new commands |
| `src/commands/mod.rs` | `pub mod cluster` |
| `src/commands/doctor.rs` | k3d v5.x version check |
| `src/ui/summary.rs` | Cluster hint line |
| `src/discovery/env.rs` | Test fixture updates (cluster: None) |
| `tests/common/mod.rs` | k3d test helpers (k3d_cleanup, k3d_cleanup_sync, etc.) |
| `tests/integration.rs` | Cluster test module registrations |
| `docs/guides/configuration.md` | Cluster configuration sections |

## Test Summary

- **Unit tests**: 127 total, all passing
  - Config model: 34 tests (6 new)
  - Validation: 22 tests (6 new)
  - Graph: 20 tests (7 new)
  - Watcher: 10 tests (all new)
  - Interpolation: 7 tests (1 new)
  - Other existing: 34 tests (unchanged)
- **Integration tests**: 3 cluster test files (require k3d + Docker, gated behind `--features integration`)
  - cluster_lifecycle: 1 test — PASS
  - cluster_registry: 1 test — PASS
  - cluster_network: 1 test — PASS

## Architectural Decisions

1. **Shell-out pattern**: k3d and kubectl operations use `tokio::process::Command` shell-out rather than Kubernetes client libraries, consistent with the project's existing Docker CLI pattern and keeping dependencies minimal.

2. **Kubeconfig isolation**: Cluster kubeconfig is written to `.devrig/kubeconfig` per-project, never touching `~/.kube/config`. All kubectl operations pass `--kubeconfig` explicitly. The kubeconfig port is fixed post-write if k3d doesn't resolve `--api-port 127.0.0.1:0`.

3. **Cancel-and-restart watcher pattern**: File watchers use `CancellationToken` from tokio-util for graceful cancellation during rebuild. When files change during a deploy, the current deploy is cancelled and restarted.

4. **Phase 3.5 orchestration**: Cluster creation/deployment runs after infra containers are ready but before service process resolution, allowing services to depend on cluster deploys.

5. **CoreDNS NodeHosts for pod-to-infra connectivity**: k3d automatically injects Docker container names into the CoreDNS NodeHosts configmap, enabling pods to resolve infra container names without `hostNetwork: true`.

## Commands That Should Pass

```
cargo fmt --check
cargo clippy -- -D warnings
cargo build
cargo test
cargo test --features integration cluster_lifecycle -- --nocapture
cargo test --features integration cluster_registry -- --nocapture
cargo test --features integration cluster_network -- --nocapture
```

## Known Issues

None. All verification checks pass. No known bugs or incomplete items.
