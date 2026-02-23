# Milestone v0.3 Research — k3d Cluster Support

## Crate/Library Recommendations

### New Dependencies

| Crate | Version | Purpose | Notes |
|-------|---------|---------|-------|
| `notify` | 8.2 | File system watching for cluster-deployed service rebuilds | De facto standard; used by rust-analyzer, cargo-watch, watchexec |
| `notify-debouncer-mini` | 0.7 | Debounced file events (collapses rapid saves into single trigger) | Lighter than `notify-debouncer-full`; no rename-stitching needed |
| `serde_yaml` | 0.9 | Multi-document YAML parsing for K8s manifests | Unmaintained but stable; `serde_yml` is a drop-in fork if needed |
| `tar` | 0.4 | Create tar archives for `docker build` context | Required by bollard's `build_image` API |

### Existing Dependencies (already in Cargo.toml, reusable)

| Crate | Current Usage | v0.3 Usage |
|-------|--------------|------------|
| `bollard` 0.20 | Infra container lifecycle | Docker build, tag, push to registry |
| `tokio` (process, fs, sync, net, time) | Process spawning, async I/O | k3d CLI shelling, kubectl proxy, file watching async bridge |
| `tokio-util` (CancellationToken, TaskTracker) | Graceful shutdown | Cancel-and-restart for rebuild pipelines |
| `backon` 1.x | Ready check retry | Cluster readiness polling, registry availability |
| `futures-util` 0.3 | Bollard stream processing | Build/push stream consumption |
| `serde_json` | State serialization | kube-rs integration (Patch::Apply takes JSON) |
| `reqwest` 0.12 | HTTP ready checks | Registry health checks |

### Crates Evaluated but NOT Recommended

| Crate | Reason for Rejection |
|-------|---------------------|
| `watchexec` 8.0 | Too heavy — pulls in process supervisor, screen clearing, ignore-file parsers. devrig already has its own supervisor. |
| `notify-debouncer-full` 0.7 | Overkill — file ID tracking and rename stitching not needed for build triggers |
| `kube` 3.0 / `k8s-openapi` 0.27 | Adds ~5-10MB binary size. For v0.3's scope (apply manifests, check pods), kubectl shell-out is simpler and more compatible. Consider adding in a later milestone if programmatic watch/wait is needed. |

**Rationale for kubectl over kube-rs:** The v0.3 scope involves applying user-provided manifests (which may include CRDs) and checking pod status. `kubectl apply -f <dir>` handles all resource types, multi-document YAML, and version skew natively with zero parsing code. kube-rs's DynamicObject + Discovery pattern requires ~80 lines of GVK resolution logic and is sensitive to API version mismatches. The `devrig k` CLI proxy already wraps kubectl, so it's a natural fit. If v0.5+ needs programmatic pod watching for the dashboard, kube-rs can be added then.

---

## Design Patterns

### 1. Shell-Out Pattern for k3d and kubectl

k3d has no Rust client library — it's designed as a CLI tool. The established pattern (used by Tilt, Skaffold, and similar tools) is to shell out. devrig already shells out to `docker compose` in `src/compose/lifecycle.rs`, so this pattern is proven in the codebase.

**Recommended abstraction:**

```rust
// src/cluster/k3d.rs
pub struct K3d {
    cluster_name: String,  // e.g., "devrig-myapp-a3f1c9e2"
    kubeconfig_path: PathBuf,
    network_name: String,
}

impl K3d {
    /// Run a k3d subcommand, capture output
    async fn run(&self, args: &[&str]) -> Result<String> {
        let output = Command::new("k3d")
            .args(args)
            .output()
            .await?;
        if !output.status.success() {
            bail!("k3d {} failed: {}", args[0], String::from_utf8_lossy(&output.stderr));
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// Run kubectl with isolated kubeconfig
    pub async fn kubectl(&self, args: &[&str]) -> Result<String> {
        let output = Command::new("kubectl")
            .args(args)
            .env("KUBECONFIG", &self.kubeconfig_path)
            .output()
            .await?;
        // ...
    }
}
```

### 2. Cancel-and-Restart Pattern for File Watch Rebuilds

When files change during an in-progress build, the previous build must be cancelled and a new one started. This uses `CancellationToken` from `tokio-util` (already a dependency).

```
File change detected
  → Debounce (500ms quiet period)
  → Cancel any in-progress build (CancellationToken)
  → Wait for cancellation to complete (with 2s timeout)
  → Start new build pipeline:
      1. docker build (with cancellation check)
      2. docker tag + push to registry (with cancellation check)
      3. kubectl apply manifests (with cancellation check)
      4. kubectl rollout restart (to pick up new image)
```

Each step checks `token.is_cancelled()` before proceeding, and long-running subprocess steps use `tokio::select!` to race the process against cancellation.

### 3. Phased Startup Extension

The existing 6-phase orchestrator pipeline in `src/orchestrator/mod.rs` needs a new phase inserted between Phase 3 (Infrastructure) and Phase 4 (Resolve & Inject):

```
Phase 0: Parse & Validate
Phase 1: Network (create devrig-{slug}-net)
Phase 2: Compose
Phase 3: Infrastructure (Docker containers)
Phase 3.5: Cluster ← NEW
  ├─ Create k3d cluster (if [cluster] present)
  │   ├─ k3d cluster create --network devrig-{slug}-net
  │   ├─ --kubeconfig-update-default=false
  │   ├─ --kubeconfig-switch-context=false
  │   └─ --registry-create (if registry = true)
  ├─ Write kubeconfig to .devrig/kubeconfig
  ├─ For each [cluster.deploy.*]:
  │   ├─ docker build context
  │   ├─ docker tag + push to local registry
  │   └─ kubectl apply -f manifests/
  └─ Start file watchers (if watch = true)
Phase 4: Resolve & Inject
Phase 5: Services
```

The cluster phase comes after infra so that infra containers (Postgres, Redis) are already running on the shared network before the cluster connects to it. This ensures pods can reach infra by container name immediately.

### 4. Resource Lifecycle Integration with Existing Patterns

Following the established v0.2 patterns:

**Config model extension** (`src/config/model.rs`):
```rust
pub struct DevrigConfig {
    // ... existing fields ...
    pub cluster: Option<ClusterConfig>,
}

pub struct ClusterConfig {
    pub name: Option<String>,       // Defaults to "{project.name}-dev"
    pub agents: Option<u32>,        // Default: 1
    pub ports: Vec<String>,         // e.g., ["8080:80@loadbalancer"]
    pub registry: Option<bool>,     // Default: false
    pub deploy: BTreeMap<String, ClusterDeployConfig>,
}

pub struct ClusterDeployConfig {
    pub context: String,            // Docker build context path
    pub dockerfile: Option<String>, // Default: "Dockerfile"
    pub manifests: String,          // Path to K8s manifests directory
    pub watch: Option<bool>,        // Default: false
}
```

**State model extension** (`src/orchestrator/state.rs`):
```rust
pub struct ProjectState {
    // ... existing fields ...
    pub cluster: Option<ClusterState>,
}

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

**Dependency graph extension** (`src/orchestrator/graph.rs`):
```rust
pub enum ResourceKind {
    Service,
    Infra,
    Compose,
    ClusterDeploy,  // NEW
}
```

Services can `depends_on` cluster-deployed services, and cluster deploys can depend on infra.

### 5. Label-Based Cleanup (Consistent with v0.2)

All k3d resources inherit the devrig labeling convention:
- k3d cluster name: `devrig-{slug}` (the k3d prefix makes it `k3d-devrig-{slug}` for Docker containers)
- Registry container: `devrig-{slug}-registry`
- Cluster cleanup on `devrig delete` uses `k3d cluster delete devrig-{slug}`
- The kubeconfig at `.devrig/kubeconfig` is deleted along with other state

---

## Implementation Strategy

### Feature 1: `[cluster]` Configuration

**Approach:** Extend the config model in `src/config/model.rs` with `ClusterConfig` and `ClusterDeployConfig` structs, following the same serde + TOML deserialization pattern as existing sections. Add validation rules in `src/config/validate.rs`.

**Config model:**
```rust
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ClusterConfig {
    pub name: Option<String>,
    #[serde(default = "default_agents")]
    pub agents: u32,
    #[serde(default)]
    pub ports: Vec<String>,
    #[serde(default)]
    pub registry: bool,
    #[serde(default)]
    pub deploy: BTreeMap<String, ClusterDeployConfig>,
}

fn default_agents() -> u32 { 1 }

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ClusterDeployConfig {
    pub context: String,
    #[serde(default = "default_dockerfile")]
    pub dockerfile: String,
    pub manifests: String,
    #[serde(default)]
    pub watch: bool,
}

fn default_dockerfile() -> String { "Dockerfile".to_string() }
```

**Validation rules:**
- If `[cluster]` is present and has `deploy` entries, each deploy must have valid `context` and `manifests` paths (relative to config file)
- `cluster.name` defaults to `"{project.name}-dev"` — resolve during validation
- `ports` entries must follow k3d port mapping syntax: `[HOST:]HOSTPORT:CONTAINERPORT[/PROTOCOL][@NODEFILTER]`
- If `cluster.deploy.*.watch = true`, the `context` path must exist
- Services can `depends_on` cluster deploy names

**Template variable expansion:**
- `{{ cluster.name }}` resolves to the cluster name

**Files to modify:** `src/config/model.rs`, `src/config/validate.rs`, `src/config/interpolate.rs`

### Feature 2: k3d Cluster Create/Delete Lifecycle

**Approach:** Create a new `src/cluster/` module with a `K3dManager` struct that wraps k3d CLI interactions, following the same pattern as `InfraManager` in `src/infra/mod.rs`.

**Module structure:**
```
src/cluster/
  mod.rs         # K3dManager: create, delete, status, kubeconfig
  registry.rs    # Registry lifecycle: create, push, health check
  deploy.rs      # Build + push + apply pipeline for cluster.deploy.*
  watcher.rs     # File watching + rebuild trigger for watch=true deploys
```

**K3dManager lifecycle:**

```rust
pub struct K3dManager {
    cluster_name: String,       // e.g., "devrig-myapp-a3f1c9e2"
    network_name: String,       // devrig-{slug}-net (reuse existing)
    kubeconfig_path: PathBuf,   // .devrig/kubeconfig
    config: ClusterConfig,
}

impl K3dManager {
    pub async fn create_cluster(&self) -> Result<()>;
    pub async fn delete_cluster(&self) -> Result<()>;
    pub async fn cluster_exists(&self) -> Result<bool>;
    pub async fn write_kubeconfig(&self) -> Result<()>;
    pub async fn kubectl(&self, args: &[&str]) -> Result<String>;
}
```

**Cluster creation command:**
```bash
k3d cluster create devrig-{slug} \
  --network devrig-{slug}-net \
  --agents {config.agents} \
  --kubeconfig-update-default=false \
  --kubeconfig-switch-context=false \
  --api-port 127.0.0.1:0 \
  {port_mappings} \
  {registry_flags}
```

Key flags:
- `--network devrig-{slug}-net` — reuse the existing devrig network (created in Phase 1). k3d will NOT delete this network on cluster delete because it's external.
- `--kubeconfig-update-default=false --kubeconfig-switch-context=false` — never touch `~/.kube/config`
- `--api-port 127.0.0.1:0` — let the OS assign an available port for the K8s API server

**Kubeconfig extraction:**
After cluster creation, extract the isolated kubeconfig:
```bash
k3d kubeconfig get devrig-{slug} > .devrig/kubeconfig
```

**Idempotent create:** Check `k3d cluster list -o json` for existing cluster before creating. If it exists, skip creation but still write kubeconfig (it may have been deleted from `.devrig/`).

**Cluster deletion:**
```bash
k3d cluster delete devrig-{slug}
```
Then remove `.devrig/kubeconfig`. The external network (`devrig-{slug}-net`) is preserved because k3d labels it as external.

**Integration with orchestrator:** Add cluster phase to `Orchestrator::start()` after Phase 3 (infra). Add cluster teardown to `Orchestrator::stop()` (stop watchers, leave cluster running) and `Orchestrator::delete()` (full cluster deletion).

### Feature 3: Local Registry Support

**Approach:** When `cluster.registry = true`, create a k3d-managed registry alongside the cluster using the `--registry-create` flag on `k3d cluster create`.

**Registry naming:** `devrig-{slug}-registry`

The `--registry-create` flag format:
```bash
k3d cluster create devrig-{slug} \
  --registry-create devrig-{slug}-registry:0.0.0.0:0
```

Using port `0` lets Docker assign an available host port. After creation, discover the assigned port by inspecting the registry container:

```rust
async fn get_registry_port(&self) -> Result<u16> {
    // docker inspect devrig-{slug}-registry --format '{{(index .NetworkSettings.Ports "5000/tcp" 0).HostPort}}'
    let output = Command::new("docker")
        .args(["inspect", &format!("k3d-devrig-{}-registry", self.slug),
               "--format", "{{(index .NetworkSettings.Ports \"5000/tcp\" 0).HostPort}}"])
        .output()
        .await?;
    let port: u16 = String::from_utf8_lossy(&output.stdout).trim().parse()?;
    Ok(port)
}
```

**Image naming conventions:**
- Host push: `localhost:{registry_port}/{service_name}:latest`
- In-cluster reference (K8s manifests): `k3d-devrig-{slug}-registry:{registry_port}/{service_name}:latest`

**Registry health check:** TCP connect to `localhost:{registry_port}` or HTTP GET `http://localhost:{registry_port}/v2/` (returns 200 when ready). Use the existing `backon` retry pattern.

### Feature 4: `[cluster.deploy.*]` with Build + Manifest Apply

**Approach:** For each `[cluster.deploy.<name>]` entry, run a build-push-apply pipeline. This is the core of the cluster deployment feature.

**Pipeline steps:**

1. **Docker Build** — Use bollard's `build_image` API (consistent with existing Docker patterns in `src/infra/`):
   ```rust
   async fn build_image(
       docker: &Docker,
       context_path: &Path,
       dockerfile: &str,
       image_tag: &str,
   ) -> Result<()> {
       // Create tar archive of build context
       let tar = create_tar_archive(context_path)?;
       // Stream build via bollard
       let options = BuildImageOptions {
           dockerfile: dockerfile.to_string(),
           t: image_tag.to_string(),
           rm: true,
           ..Default::default()
       };
       let mut stream = docker.build_image(options, None, Some(tar.into()));
       while let Some(result) = stream.next().await {
           // Log progress, detect errors
       }
       Ok(())
   }
   ```

2. **Docker Tag + Push** — Tag for local registry and push via bollard:
   ```rust
   // Tag: localhost:{port}/{service}:latest
   docker.tag_image(local_tag, Some(TagImageOptions { repo, tag })).await?;
   // Push via bollard streaming API
   let mut stream = docker.push_image(repo, Some(PushImageOptions { tag }), None);
   ```

3. **Manifest Apply** — Shell out to kubectl with isolated kubeconfig:
   ```bash
   kubectl apply -f {manifests_dir} --kubeconfig .devrig/kubeconfig
   ```

4. **Rollout Restart** (on rebuilds) — Force pods to pull the new image:
   ```bash
   kubectl rollout restart deployment/{name} --kubeconfig .devrig/kubeconfig
   ```
   Alternative: use a unique image tag per build (timestamp or short hash) and update the manifest. The rollout restart approach is simpler since it avoids manifest templating.

**Image tag strategy:** Use `localhost:{registry_port}/{service_name}:{unix_timestamp}` for unique tags on rebuilds, plus `latest` as an alias. This ensures Kubernetes always pulls the new image without needing `imagePullPolicy: Always`.

**Manifest handling:** Users provide a directory path (`manifests = "./k8s/api/"`). devrig runs `kubectl apply -f ./k8s/api/ --kubeconfig .devrig/kubeconfig`. kubectl handles:
- All YAML files in the directory
- Multi-document files (`---` separators)
- Any resource type including CRDs
- Namespace handling (from manifest metadata or default)

**Template substitution in manifests:** Users may want to reference the registry in their manifests. Two approaches:

Option A (recommended for v0.3): Document that users should use a fixed registry reference in manifests:
```yaml
# In k8s/api/deployment.yaml
image: k3d-devrig-registry:5000/api:latest
```
And devrig pushes to match. Simple, no templating needed.

Option B (future): devrig processes manifests with `{{ }}` template expressions before applying. This adds complexity and is better deferred.

**Decision: Use Option A** for v0.3. Document the registry naming convention in the cluster setup guide.

### Feature 5: File Watching for Cluster-Deployed Services

**Approach:** Use `notify` + `notify-debouncer-mini` with tokio integration. Each `cluster.deploy.*` with `watch = true` gets its own watcher task.

**Architecture:**

```rust
// src/cluster/watcher.rs
pub struct DeployWatcher {
    service_name: String,
    watch_dir: PathBuf,        // cluster.deploy.*.context
    cancel: CancellationToken,
    rebuild_tx: mpsc::Sender<String>,  // Send service name on change
}
```

**Watcher lifecycle:**
1. Create `notify::RecommendedWatcher` with `tokio::sync::mpsc` bridge
2. Watch `context` directory recursively
3. On debounced event (500ms quiet period):
   - Filter out ignored paths (.git, target/, node_modules/, .devrig/)
   - Send service name to rebuild channel
4. Rebuild controller receives service name:
   - Cancel any in-progress build for this service
   - Start new build-push-apply pipeline
5. On orchestrator stop: cancel watcher via CancellationToken

**Debounce strategy:**
- Use `notify-debouncer-mini` with 500ms duration
- This handles the common case of editors writing temp files then renaming (vim), or IDEs doing "save all" across multiple files
- After debounce, drain any remaining events from the channel before triggering rebuild

**Ignore patterns (built-in, not configurable for v0.3):**
```rust
const IGNORED_DIRS: &[&str] = &[".git", "target", "node_modules", ".devrig", ".claude", "__pycache__"];
const IGNORED_EXTENSIONS: &[&str] = &["swp", "swo", "tmp", "pyc", "pyo"];
```

**Integration with orchestrator:** Watchers are spawned as tokio tasks during the cluster phase. The `TaskTracker` from `tokio-util` (already used for service supervisors) tracks them for graceful shutdown.

**Rebuild output:** Log rebuild status through the existing `LogWriter` system in `src/ui/logs.rs`. Each deploy gets a color-coded log prefix like services do:
```
[api-deploy] File change detected, rebuilding...
[api-deploy] Building image localhost:5000/api:1740000000...
[api-deploy] Pushing to registry...
[api-deploy] Applying manifests...
[api-deploy] Deploy complete (4.2s)
```

### Feature 6: Network Bridging Between Docker Network and Cluster

**Approach:** Reuse the existing `devrig-{slug}-net` bridge network created in Phase 1 by passing it to k3d via `--network`.

**How it works:**

1. Phase 1 creates `devrig-{slug}-net` (existing behavior, `src/infra/network.rs`)
2. Phase 3 starts infra containers on this network (existing behavior)
3. Phase 3.5 creates k3d cluster with `--network devrig-{slug}-net`
4. k3d connects all cluster nodes (server, agent, load balancer) to the devrig network
5. k3d's NodeHosts injection provides DNS resolution for container names

**Result:** Pods inside the k3d cluster can resolve infra containers by their Docker container name. For example, a pod can connect to `devrig-myapp-a3f1c9e2-postgres:5432` directly.

**Service discovery for cluster deploys:** Since pods connect to infra by Docker container name (not `localhost`), the DEVRIG_* env vars need adjustment for cluster-deployed services:

```yaml
# In the pod's K8s manifest (user-managed):
env:
  - name: DATABASE_URL
    value: "postgres://devrig:devrig@devrig-myapp-a3f1c9e2-postgres:5432/myapp"
```

For v0.3, document this naming convention. Users write their manifests with the full container name. In a future milestone, devrig could inject these as ConfigMaps or generate environment variable references automatically.

**Network preservation on delete:** Because k3d is given an external network (not one it created), k3d labels cluster nodes with `k3d.cluster.network.external=true` and skips network deletion. devrig's existing Phase 1 network cleanup handles network removal during `devrig delete`.

**Connectivity directions:**
| From | To | How |
|------|-----|-----|
| Pod → Infra container | Container name (e.g., `devrig-{slug}-postgres`) | Docker DNS on shared network + k3d NodeHosts |
| Infra container → Pod | Via NodePort, LoadBalancer, or k3d node IP | Standard K8s service exposure |
| Host → Pod | Via k3d port mappings (`-p "8080:80@loadbalancer"`) | Docker port forwarding |
| Host → Infra | Via infra port mappings (existing) | Same as v0.2 |

### CLI Commands

**New subcommands to add in `src/cli.rs`:**

```rust
#[derive(Subcommand)]
pub enum Commands {
    // ... existing commands ...

    /// Manage the k3d cluster
    Cluster {
        #[command(subcommand)]
        command: ClusterCommands,
    },

    /// Proxy to kubectl with devrig's isolated kubeconfig
    #[command(name = "kubectl", alias = "k")]
    Kubectl {
        /// Arguments passed to kubectl
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
}

#[derive(Subcommand)]
pub enum ClusterCommands {
    /// Create the k3d cluster
    Create,
    /// Delete the k3d cluster
    Delete,
    /// Print path to devrig's isolated kubeconfig
    Kubeconfig,
}
```

**Command handlers (new file `src/commands/cluster.rs`):**

- `devrig cluster create` — Run cluster creation outside of full `devrig start` (useful for manual setup)
- `devrig cluster delete` — Tear down just the cluster (not infra or services)
- `devrig cluster kubeconfig` — Print `.devrig/kubeconfig` path
- `devrig kubectl ...` / `devrig k ...` — Proxy to kubectl with `KUBECONFIG=.devrig/kubeconfig`

### Integration Test Strategy

**Test files to create:**

```
tests/integration/
  cluster_lifecycle.rs     # Full create → deploy → verify → delete cycle
  cluster_registry.rs      # Registry push/pull validation
  cluster_network.rs       # Network bridge connectivity
```

**Test 1: Full cluster lifecycle** (`cluster_lifecycle.rs`)
```
1. Write devrig.toml with [cluster] + [cluster.deploy.echo]
2. Start devrig (or just cluster phase)
3. Assert: k3d cluster exists (`k3d cluster list -o json`)
4. Assert: .devrig/kubeconfig exists and is valid
5. Assert: Pod is running (`devrig k get pods -o json`)
6. Assert: ~/.kube/config is NOT modified (checksum before/after)
7. Run devrig delete
8. Assert: k3d cluster no longer exists
9. Assert: .devrig/kubeconfig removed
10. Assert: No Docker containers with devrig-test-* labels remain
```

**Test 2: Registry push/pull** (`cluster_registry.rs`)
```
1. Create cluster with registry = true
2. Build a minimal Docker image (FROM alpine, CMD echo hello)
3. Push to local registry
4. Deploy a pod that uses the registry image
5. Assert: Pod starts successfully (image was pulled from registry)
6. Cleanup
```

**Test 3: Network bridge** (`cluster_network.rs`)
```
1. Start devrig with [infra.redis] + [cluster] + [cluster.deploy.checker]
2. checker is a pod that tries to TCP connect to devrig-{slug}-redis:6379
3. Assert: checker pod exits 0 (connectivity works)
4. Cleanup
```

**Test infrastructure additions to `tests/common/mod.rs`:**
```rust
/// Check if k3d is available
pub fn k3d_available() -> bool {
    std::process::Command::new("k3d").arg("version").output().is_ok()
}

/// Wait for a pod to be in Running state
pub async fn wait_for_pod_running(kubeconfig: &Path, label: &str, timeout: Duration) -> Result<()> {
    // kubectl get pods -l {label} --kubeconfig {path} -o jsonpath='{.items[0].status.phase}'
    // Poll until "Running"
}

/// Cleanup k3d cluster by name
pub async fn k3d_cleanup(cluster_name: &str) {
    let _ = Command::new("k3d")
        .args(["cluster", "delete", cluster_name])
        .output()
        .await;
}
```

**Test gating:** Cluster tests require both Docker and k3d. Gate with:
```rust
#[cfg(feature = "integration")]
#[tokio::test]
async fn test_cluster_lifecycle() {
    if !k3d_available() {
        eprintln!("Skipping: k3d not found");
        return;
    }
    // ...
}
```

### Startup Summary Extension

Update `src/ui/summary.rs` to display cluster status:

```
  devrig ⚡ myapp (a3f1c9e2)

  Services
    web       http://localhost:5173    ● running

  Infrastructure
    postgres  localhost:5432           ● ready
    redis     localhost:6379           ● ready

  Cluster     myapp-dev               ● ready
    api       k3d-registry:5000/api   ● deployed (watching)
    Use: devrig k get pods

  Press Ctrl+C to stop all services
```

---

## Risks and Considerations

### 1. k3d Startup Time

**Risk:** k3d cluster creation takes 15-30 seconds (pulling k3s images, starting nodes, waiting for API server). This significantly extends `devrig start` time compared to the instant infra container starts.

**Mitigation:**
- Check if cluster already exists before creating (idempotent start)
- On `devrig stop`, leave the cluster running (only stop watchers). Only `devrig delete` removes the cluster.
- Print clear progress messages during cluster creation:
  ```
  Creating k3d cluster devrig-myapp-a3f1c9e2...
    Waiting for API server... ● ready (12s)
    Starting local registry... ● ready
  ```
- Consider caching: on subsequent `devrig start`, if the cluster exists and is healthy, skip creation entirely.

### 2. k3d Version Compatibility

**Risk:** Different k3d versions may have different CLI flags or behavior. The `--registry-create` syntax changed between k3d v4 and v5.

**Mitigation:**
- Target k3d v5.x (current stable, widely used)
- Add k3d version check to `devrig doctor` output
- Document minimum k3d version in docs/guides/cluster-setup.md
- Parse `k3d version` output to detect incompatible versions at startup

### 3. Port Conflicts with k3d API Server

**Risk:** k3d's API server port and load balancer ports can conflict with infra container ports or other devrig instances.

**Mitigation:**
- Use `--api-port 127.0.0.1:0` to let the OS assign an available port
- For load balancer port mappings from config (`ports = ["8080:80@loadbalancer"]`), validate these ports are available in the existing port conflict detection code (`src/orchestrator/ports.rs`)
- Store the resolved API server port in state for the kubeconfig

### 4. Registry Container Naming and k3d Prefix

**Risk:** k3d automatically prepends `k3d-` to all resource names. A registry named `devrig-myapp-a3f1c9e2-registry` becomes a Docker container named `k3d-devrig-myapp-a3f1c9e2-registry`. This can exceed Docker's 64-character container name limit.

**Mitigation:**
- Use a shorter registry name: `{slug}-reg` (instead of full `devrig-{slug}-registry`)
- Or: use the k3d-convention directly: `k3d registry create {slug}-reg --port 0`
- Test with long project names to verify name limits

### 5. Docker Build Context Size

**Risk:** `bollard::build_image` requires creating a tar archive of the entire build context. For large codebases (e.g., a Rust project with a `target/` directory), this can be slow and memory-intensive.

**Mitigation:**
- Respect `.dockerignore` when creating the tar archive. The `tar` crate doesn't do this natively — need to parse `.dockerignore` and filter.
- Alternative: shell out to `docker build` instead of using bollard. This handles `.dockerignore` automatically and supports BuildKit features. The trade-off is losing the bollard streaming API for build output.
- **Recommendation for v0.3:** Shell out to `docker build` for the build step. Use bollard only for tag + push (which don't need build context). This is simpler and handles `.dockerignore`, BuildKit, and multi-stage builds correctly.

**Revised build approach:**
```rust
async fn docker_build(
    context_path: &Path,
    dockerfile: &str,
    tag: &str,
) -> Result<()> {
    let status = Command::new("docker")
        .args(["build", "-t", tag, "-f", dockerfile, "."])
        .current_dir(context_path)
        .status()
        .await?;
    if !status.success() {
        bail!("docker build failed");
    }
    Ok(())
}
```

### 6. Kubeconfig Isolation Edge Cases

**Risk:** If the user runs `kubectl` directly (not through `devrig k`), they might accidentally target the wrong cluster.

**Mitigation:**
- Never write to `~/.kube/config` (the `--kubeconfig-update-default=false` flag)
- `devrig k` and `devrig kubectl` always set `KUBECONFIG=.devrig/kubeconfig`
- `devrig cluster kubeconfig` prints the path so users can `export KUBECONFIG=$(devrig cluster kubeconfig)` if they want direct kubectl access
- Integration test: checksum `~/.kube/config` before and after cluster lifecycle, assert unchanged

### 7. File Watcher Edge Cases

**Risk:** notify can produce platform-specific behavior. Linux inotify has watch limits. macOS FSEvents batches events differently.

**Mitigation:**
- Use `RecommendedWatcher` (auto-selects best backend per platform)
- 500ms debounce handles most platform differences
- Log a warning if the watch limit is hit on Linux (notify returns an error)
- Filter events by path to ignore non-source files
- Keep watcher handle alive (dropping it silently stops watching)

### 8. Network DNS Resolution Timing

**Risk:** When k3d creates the cluster on the devrig network, the NodeHosts DNS injection may not immediately include all infra containers — especially if infra containers haven't fully started their DNS registration.

**Mitigation:**
- The phased startup ensures infra containers are fully started (with ready checks) before the cluster phase begins
- If pods fail DNS resolution, the cluster deploy should retry with backoff
- Document that pods should use retry logic for database connections at startup (standard K8s practice)

### 9. Graceful Shutdown Complexity

**Risk:** Shutdown now involves more components: watchers, build processes, k3d cluster. The order matters.

**Mitigation:**
- **`devrig stop` shutdown order:**
  1. Cancel all file watchers (CancellationToken)
  2. Cancel any in-progress builds
  3. Stop service supervisors (existing)
  4. Stop infra containers (existing)
  5. Leave cluster running (for fast restart)
  6. Save state

- **`devrig delete` shutdown order:**
  1. Cancel all file watchers
  2. Cancel any in-progress builds
  3. Stop service supervisors
  4. Delete k3d cluster (`k3d cluster delete`)
  5. Remove `.devrig/kubeconfig`
  6. Delete infra containers and volumes
  7. Remove network
  8. Remove state

### 10. Test Resource Cleanup

**Risk:** If integration tests crash or are interrupted, k3d clusters may be left running, consuming Docker resources.

**Mitigation:**
- Each test uses a unique cluster name based on the temp directory hash (same slug mechanism)
- `docker_cleanup()` fallback in `tests/common/mod.rs` should be extended with `k3d cluster delete`
- Add a CI step that runs `k3d cluster delete --all` and `docker system prune` after tests
- Use `Drop` impl or `scopeguard` for test cleanup

---

## References

### k3d Documentation
- [k3d.io — Official Documentation (v5.8.3)](https://k3d.io/)
- [k3d cluster create — Flag Reference](https://k3d.io/v5.8.3/usage/commands/k3d_cluster_create/)
- [k3d Networking Design](https://k3d.io/v5.3.0/design/networking/)
- [k3d Kubeconfig Handling](https://k3d.io/v5.3.0/usage/kubeconfig/)
- [k3d Image Registries](https://k3d.io/v5.1.0/usage/registries/)
- [k3d Image Import](https://k3d.io/v5.3.0/usage/commands/k3d_image_import/)
- [k3d K3s Features (NodeHosts, host.k3d.internal)](https://k3d.io/v5.8.3/usage/k3s/)
- [k3d Config File Reference](https://k3d.io/v5.6.0/usage/configfile/)
- [k3d GitHub — Network Issues (#111, #220, #1515, #1516)](https://github.com/k3d-io/k3d)

### Rust Crates
- [notify 8.2 — File Watching](https://docs.rs/notify/8.2.0/notify/) — [GitHub](https://github.com/notify-rs/notify)
- [notify-debouncer-mini 0.7](https://docs.rs/notify-debouncer-mini/0.7.0/notify_debouncer_mini/)
- [bollard 0.20 — Docker API](https://docs.rs/bollard/0.20/bollard/) — [GitHub](https://github.com/fussybeaver/bollard)
- [kube-rs 3.0 — Kubernetes Client](https://docs.rs/kube/3.0.1/kube/) — [GitHub](https://github.com/kube-rs/kube)
- [serde_yaml 0.9 — YAML Parsing](https://docs.rs/serde_yaml/0.9/serde_yaml/)
- [tar 0.4 — Archive Creation](https://docs.rs/tar/0.4/tar/)
- [tokio-util CancellationToken](https://docs.rs/tokio-util/latest/tokio_util/sync/struct.CancellationToken.html)
- [backon — Retry with Backoff](https://docs.rs/backon/latest/backon/)

### Kubernetes
- [Server-Side Apply Documentation](https://kubernetes.io/docs/reference/using-api/server-side-apply/)
- [K3s Private Registry Configuration](https://docs.k3s.io/installation/private-registry)
- [kube-rs kubectl.rs Example (DynamicObject + Discovery)](https://github.com/kube-rs/kube/blob/main/examples/kubectl.rs)

### Related Tools (design inspiration)
- [Tilt — k3d Local Registry Discovery](https://github.com/tilt-dev/k3d-local-registry)
- [Skaffold — File Sync and Rebuild](https://skaffold.dev/)
- [DevSpace — Development Workflows](https://devspace.sh/)

### devrig Codebase (key files for v0.3 integration)
- `src/orchestrator/mod.rs` — 6-phase startup pipeline (insert cluster phase)
- `src/config/model.rs` — Config model (add ClusterConfig, ClusterDeployConfig)
- `src/config/validate.rs` — Validation rules (add cluster validation)
- `src/config/interpolate.rs` — Template variables (add cluster.name)
- `src/orchestrator/state.rs` — State model (add ClusterState)
- `src/orchestrator/graph.rs` — Dependency graph (add ClusterDeploy resource kind)
- `src/infra/network.rs` — Network creation (reuse for cluster)
- `src/infra/mod.rs` — InfraManager pattern to follow for K3dManager
- `src/compose/lifecycle.rs` — Shell-out pattern to follow for k3d CLI
- `src/ui/summary.rs` — Startup summary (add cluster section)
- `src/commands/doctor.rs` — Doctor checks (add k3d version check)
- `tests/common/mod.rs` — Test helpers (add k3d helpers)
