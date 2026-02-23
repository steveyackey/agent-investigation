# Validation Criteria — v0.3: k3d Cluster Support

## Standard Checks

### 1. Code Quality

| Check | Command | Expected |
|---|---|---|
| Formatting | `cargo fmt --check` | Exit 0, no formatting differences |
| Linting | `cargo clippy -- -D warnings` | Exit 0, zero warnings |
| Build | `cargo build` | Exit 0, successful compilation |
| Unit tests | `cargo test` | All tests pass, 0 failures |

### 2. Unit Test Coverage

The following unit test modules must pass:

| Module | Command | Min Tests | Key Coverage |
|---|---|---|---|
| `config::model` | `cargo test config::model` | 20+ | ClusterConfig parsing, ClusterDeployConfig parsing, defaults, backwards compatibility |
| `config::validate` | `cargo test config::validate` | 20+ | Cluster deploy depends_on, empty context/manifests, name conflicts, cross-type deps |
| `config::interpolate` | `cargo test config::interpolate` | 7+ | cluster.name template variable, existing tests still pass |
| `orchestrator::graph` | `cargo test orchestrator::graph` | 18+ | ClusterDeploy nodes, mixed 4-type graph, cluster deploy dependencies |
| `orchestrator::state` | Included in `cargo test` | — | ClusterState serialization roundtrip |

### 3. Integration Tests

| Check | Command | Expected |
|---|---|---|
| All integration tests | `cargo test --features integration` | All pass (including all v0.1 + v0.2 tests) |

**Note:** Cluster-specific integration tests require k3d to be installed. If k3d is not available, these tests should skip gracefully (print "Skipping: k3d not found" and return), NOT fail.

---

## Milestone-Specific Validation

### 4. Cluster Lifecycle Test (`cluster_lifecycle`)

**Command:** `cargo test --features integration cluster_lifecycle -- --nocapture`

**Validates the full create → deploy → verify → delete cycle:**

| Step | Assertion |
|---|---|
| Cluster creation | k3d cluster exists in `k3d cluster list -o json` |
| Kubeconfig | `.devrig/kubeconfig` file exists and is valid YAML |
| Pod running | At least one pod in Running state via kubectl |
| kubectl proxy | `devrig k get pods` equivalent returns valid output |
| Kubeconfig isolation | `~/.kube/config` SHA-256 checksum unchanged from before test |
| Cluster deletion | k3d cluster no longer in `k3d cluster list -o json` |
| Kubeconfig cleanup | `.devrig/kubeconfig` file removed |
| Resource cleanup | Zero Docker containers with test project label remain |
| State cleanup | `.devrig/state.json` removed |

### 5. Registry Push/Pull Test (`cluster_registry`)

**Command:** `cargo test --features integration cluster_registry -- --nocapture`

**Validates registry creation and image distribution:**

| Step | Assertion |
|---|---|
| Registry container | Docker container `k3d-devrig-{slug}-reg` exists and is running |
| Image push | `docker push` to `localhost:{port}/{name}:{tag}` succeeds |
| Pod start | Pod using the registry image starts successfully (image pulled from local registry) |
| Cleanup | All resources removed after delete |

### 6. Network Bridge Test (`cluster_network`)

**Command:** `cargo test --features integration cluster_network -- --nocapture`

**Validates connectivity between cluster pods and infra containers:**

| Step | Assertion |
|---|---|
| Infra running | Redis infra container is running and ready |
| Pod connectivity | Checker pod/job that TCP connects to `devrig-{slug}-redis:6379` completes successfully |
| DNS resolution | The container name resolves correctly from within the k3d cluster |
| Cleanup | All resources (infra containers, cluster, network) removed |

### 7. No Resource Leaks

**After each integration test completes (pass or fail):**

```bash
# No containers with test label
docker ps -a --filter "label=devrig.project={test_slug}" --format "{{.ID}}" | wc -l
# Expected: 0

# No volumes with test label
docker volume ls --filter "label=devrig.project={test_slug}" --format "{{.Name}}" | wc -l
# Expected: 0

# No networks with test label
docker network ls --filter "label=devrig.project={test_slug}" --format "{{.Name}}" | wc -l
# Expected: 0

# No k3d clusters with test name
k3d cluster list -o json | jq '.[].name' | grep -c "devrig-{test_slug}"
# Expected: 0
```

### 8. Backwards Compatibility

Existing v0.1 and v0.2 integration tests must continue to pass without modification:

```bash
cargo test --features integration start_stop
cargo test --features integration infra_lifecycle
cargo test --features integration service_discovery
cargo test --features integration compose_interop
cargo test --features integration leaked_resources
```

A minimal devrig.toml with only `[project]` and `[services.*]` (no `[cluster]`) must work identically to v0.2.

---

## CLI Validation

### 9. New Commands Exist

| Command | Validation |
|---|---|
| `devrig cluster create` | `cargo run -- cluster create --help` exits 0 |
| `devrig cluster delete` | `cargo run -- cluster delete --help` exits 0 |
| `devrig cluster kubeconfig` | `cargo run -- cluster kubeconfig --help` exits 0 |
| `devrig kubectl` | `cargo run -- kubectl --help` exits 0 |
| `devrig k` | `cargo run -- k --help` exits 0 (alias for kubectl) |

### 10. Doctor Check

```bash
cargo run -- doctor
```

Must include a line for k3d showing either the version (e.g., `k3d v5.8.3`) or `not found`.

---

## Documentation Completeness

### 11. Required Files Exist

| File | Min Lines | Key Content |
|---|---|---|
| `docs/guides/cluster-setup.md` | 80+ | Prerequisites, configuration, registry, file watching, network, CLI, troubleshooting |
| `docs/architecture/kubeconfig-isolation.md` | 40+ | Why isolated, how it works, flag reference, lifecycle, testing |
| `docs/guides/configuration.md` | Updated | Contains `[cluster]` section, `[cluster.deploy.*]` section, cluster CLI commands |

### 12. Documentation Content Checks

**`docs/guides/cluster-setup.md` must contain:**
- k3d prerequisite mention
- `[cluster]` TOML example
- `[cluster.deploy.*]` TOML example
- Registry image naming convention
- `devrig kubectl` / `devrig k` usage
- Network connectivity explanation

**`docs/architecture/kubeconfig-isolation.md` must contain:**
- `--kubeconfig-update-default=false` flag reference
- `.devrig/kubeconfig` path
- `~/.kube/config` never-touch guarantee
- `export KUBECONFIG` usage example

**`docs/guides/configuration.md` must contain:**
- `[cluster]` section with all fields documented
- `[cluster.deploy.*]` section with all fields documented
- `{{ cluster.name }}` template variable

---

## Module Structure Validation

### 13. Required Source Files

```
src/cluster/mod.rs          # K3dManager
src/cluster/registry.rs     # Registry port discovery, health check
src/cluster/deploy.rs       # Build + push + apply pipeline
src/cluster/watcher.rs      # File watching + rebuild
src/commands/cluster.rs     # CLI command handlers
```

All must exist and compile.

### 14. Required Test Files

```
tests/integration/cluster_lifecycle.rs
tests/integration/cluster_registry.rs
tests/integration/cluster_network.rs
```

All must exist and be registered in the test harness.

---

## Full Validation Sequence

Run these checks in order. All must pass.

```bash
# 1. Code quality
cargo fmt --check
cargo clippy -- -D warnings
cargo build

# 2. Unit tests
cargo test

# 3. Config parsing tests (subset)
cargo test config::model
cargo test config::validate
cargo test config::interpolate

# 4. Graph tests (subset)
cargo test orchestrator::graph

# 5. CLI help
cargo run -- --help
cargo run -- cluster --help
cargo run -- kubectl --help

# 6. Integration tests (requires Docker)
cargo test --features integration

# 7. Cluster tests (requires Docker + k3d) — may skip if k3d not installed
cargo test --features integration cluster_lifecycle -- --nocapture
cargo test --features integration cluster_registry -- --nocapture
cargo test --features integration cluster_network -- --nocapture

# 8. Backwards compatibility
cargo test --features integration start_stop
cargo test --features integration infra_lifecycle

# 9. Documentation
test -f docs/guides/cluster-setup.md
test -f docs/architecture/kubeconfig-isolation.md
grep -q "\[cluster\]" docs/guides/configuration.md
grep -q "cluster.deploy" docs/guides/configuration.md

# 10. Module structure
test -f src/cluster/mod.rs
test -f src/cluster/registry.rs
test -f src/cluster/deploy.rs
test -f src/cluster/watcher.rs
test -f src/commands/cluster.rs

# 11. Leak check (after all tests)
docker ps -a --filter "label=devrig.managed-by=devrig" --format "{{.Names}}" | grep -c "devrig-test-" || true
# Expected: 0
```

---

## Failure Handling

If any check fails:

1. **Formatting (`cargo fmt`)**: Run `cargo fmt` and re-check. This is a formatting-only fix.
2. **Clippy warnings**: Fix the warning in the relevant source file. Common issues: unused imports, unnecessary clones, missing error handling.
3. **Build failure**: Check for missing module declarations in `lib.rs`, `mod.rs`, or `commands/mod.rs`. Check for missing `use` imports.
4. **Unit test failure**: Fix the failing test or the code it tests. Do not disable tests.
5. **Integration test failure**: Check Docker daemon is running. Check k3d is installed (for cluster tests). Check for port conflicts. Check for stale Docker resources from previous runs.
6. **Resource leak**: Run `docker_cleanup()` / `k3d_cleanup()` for the leaked slug. Investigate why the test cleanup didn't run (panic? missing Drop guard?).
7. **Documentation missing**: Create the file with the required content sections.
8. **Backwards compatibility failure**: The new code must not break existing functionality. Check that `DevrigConfig` changes use `#[serde(default)]`, that `ProjectState` changes use `#[serde(default)]`, and that the orchestrator handles `config.cluster = None` gracefully.
