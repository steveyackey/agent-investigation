# Milestone v0.2 Research — Infrastructure Containers

> Research compiled for devrig milestone v0.2. Covers crate selection, design patterns,
> implementation strategies for Docker container lifecycle, ready checks, service discovery,
> template interpolation, compose interop, and testing approaches.

---

## Crate/Library Recommendations

### New Dependencies for v0.2

| Crate | Version | Purpose | Notes |
|---|---|---|---|
| `bollard` | 0.20 | Docker Engine API client | Async, comprehensive, 3.1M downloads/month. Covers containers, images, volumes, networks, exec, logs. |
| `futures-util` | 0.3 | Stream combinators | Required for consuming bollard's streaming APIs (`StreamExt::next()`) |
| `reqwest` | 0.12 | HTTP client | For HTTP ready checks. Use `default-features = false, features = ["rustls-tls"]` to avoid OpenSSL. |
| `backon` | 1.x | Retry with backoff | For ready check polling. Trait-based, supports `when`, `notify`, exponential backoff with jitter. 4M+ downloads/month. |

### Existing Dependencies (from v0.1, reused)

| Crate | Version | v0.2 Usage |
|---|---|---|
| `tokio` | 1.x | Async runtime, `TcpStream::connect` for TCP checks, `process::Command` for compose CLI |
| `serde` + `serde_json` | 1.0 | Config model extensions, state persistence, compose JSON parsing |
| `toml` | 0.8 | Extended config parsing with `[infra.*]`, `[compose]` sections |
| `regex` | 1.x | Template expression resolution (`{{ path.to.value }}`) |
| `petgraph` | 0.7 | Extended dependency graph (services + infra in same graph) |

### Crates Considered but NOT Recommended

| Crate | Reason for Exclusion |
|---|---|
| `shiplift` | Unmaintained since 2021, does not track modern Docker API |
| `dockworker` | Low activity, lacks async support, smaller community than bollard |
| `portpicker` | devrig already has `find_free_port()` and `check_port_available()` — adding portpicker is unnecessary |
| `minijinja` | Considered for template interpolation but overkill for simple `{{ var }}` resolution. The PRD specifies "Custom lightweight resolver (no full template engine)". Zero-dependency regex approach is preferred. |
| `tera` / `handlebars` | Full template engines — unnecessary for dot-path variable substitution |
| `compose-rs` | Immature (v0.0.4), doesn't support all flags devrig needs. Shelling out to `docker compose` directly is more reliable. |
| `docker-compose-types` | Could be useful for parsing compose YAML, but `docker compose config --format json` + serde_json is simpler and always matches actual compose behavior. |
| `tokio-retry` | Less ergonomic than `backon` — lacks `when` (conditional retry) and `notify` (progress tracking) |
| `humantime-serde` | Could be used for parsing duration strings like "30s" in config, but a simple custom parser is sufficient and avoids the dependency |

### Recommended Cargo.toml Additions

```toml
# Add to [dependencies]
bollard = "0.20"
futures-util = "0.3"
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
backon = "1"
```

### Crate Selection Rationale

**Why `bollard` over shelling out to `docker` CLI?** Bollard provides typed Rust APIs for the Docker Engine socket. It returns structured data (not CLI text to parse), handles streaming (logs, image pulls) natively with Tokio streams, and supports Docker labels as first-class `HashMap<String, String>`. The only exception is compose interop, where shelling out to `docker compose` is necessary because bollard does not implement the Compose specification.

**Why `backon` over hand-rolled retry?** The existing `ServiceSupervisor` in v0.1 has hand-rolled backoff, but ready checks need different semantics: retry until success with a total timeout, progress notifications (for logging "postgres not ready, retrying in 250ms..."), and conditional retry (stop if the container has died). `backon` provides all of this via a clean trait-based API (`Retryable`) with zero overhead.

**Why `reqwest` for HTTP checks instead of hand-rolling with `hyper`?** HTTP health checks need connection pooling (reuse across polls), timeout configuration, and 2xx status checking. reqwest provides all of this in 3 lines. hyper would require 30+ lines of boilerplate for the same result.

**Why NOT `minijinja`?** The template syntax is strictly `{{ dotted.path }}` — no filters, no conditionals, no loops. The variable namespace is flat and well-known (project.name, services.X.port, infra.X.port). A regex-based resolver is ~80 lines and requires zero new dependencies (regex is already in Cargo.toml). MiniJinja would add a dependency for features that will never be used. However, if requirements expand (e.g., default values, filters), MiniJinja should be reconsidered — it is excellent and has only serde as a required dependency.

---

## Design Patterns

### 1. Config Model Extensions

Extend `DevrigConfig` in `src/config/model.rs` to support infrastructure and compose blocks:

```rust
#[derive(Debug, Deserialize)]
pub struct DevrigConfig {
    pub project: ProjectConfig,
    #[serde(default)]
    pub services: BTreeMap<String, ServiceConfig>,
    #[serde(default)]
    pub infra: BTreeMap<String, InfraConfig>,        // NEW
    #[serde(default)]
    pub compose: Option<ComposeConfig>,               // NEW
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub network: Option<NetworkConfig>,               // NEW
}

#[derive(Debug, Deserialize)]
pub struct InfraConfig {
    pub image: String,
    #[serde(default)]
    pub port: Option<Port>,                           // Single port (reuse existing Port enum)
    #[serde(default)]
    pub ports: BTreeMap<String, Port>,                // Named ports (e.g., smtp = 1025, ui = 8025)
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub volumes: Vec<String>,
    #[serde(default)]
    pub ready_check: Option<ReadyCheck>,
    #[serde(default)]
    pub init: Vec<String>,                            // SQL or shell commands to run once
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum ReadyCheck {
    #[serde(rename = "pg_isready")]
    PgIsReady,
    #[serde(rename = "cmd")]
    Cmd {
        command: String,
        #[serde(default)]
        expect: Option<String>,                       // Expected output (e.g., "PONG")
    },
    #[serde(rename = "http")]
    Http { url: String },
    #[serde(rename = "tcp")]
    Tcp,                                              // Uses the container's exposed port
    #[serde(rename = "log")]
    Log {
        #[serde(rename = "match")]
        pattern: String,
    },
}

#[derive(Debug, Deserialize)]
pub struct ComposeConfig {
    pub file: String,                                 // Path to docker-compose.yml
    #[serde(default)]
    pub services: Vec<String>,                        // Which services to manage (empty = all)
    #[serde(default)]
    pub env_file: Option<String>,
    #[serde(default)]
    pub ready_checks: BTreeMap<String, ReadyCheck>,   // Ready checks for compose services
}
```

**Key design decisions:**
- `ReadyCheck` uses `#[serde(tag = "type")]` for clean TOML: `ready_check = { type = "pg_isready" }`
- `InfraConfig` supports both `port` (single) and `ports` (named map) — exactly matching the PRD examples
- `ComposeConfig` is `Option<ComposeConfig>` — absent means no compose, present enables it
- All new sections use `#[serde(default)]` for opt-in behavior

### 2. Docker Resource Naming Convention

All Docker resources use the project slug as namespace (matching PRD spec):

```
Container:  devrig-{slug}-{service}          e.g., devrig-myapp-a3f1c9e2-postgres
Network:    devrig-{slug}-net                e.g., devrig-myapp-a3f1c9e2-net
Volume:     devrig-{slug}-{volume_name}      e.g., devrig-myapp-a3f1c9e2-pgdata
```

Every resource gets Docker labels for discovery and cleanup:

```rust
fn resource_labels(slug: &str, service: &str) -> HashMap<String, String> {
    HashMap::from([
        ("devrig.project".into(), slug.into()),
        ("devrig.service".into(), service.into()),
        ("devrig.managed-by".into(), "devrig".into()),
    ])
}
```

This enables:
- `devrig ps --all`: Query `docker ps --filter label=devrig.managed-by=devrig`
- `devrig delete`: Remove only resources with `devrig.project={slug}`
- Port conflict identification: Look up `devrig.project` label on the container holding a conflicting port

### 3. Orchestrator Phase Architecture

The orchestrator start sequence expands from v0.1's single phase to a multi-phase pipeline:

```
devrig start
  │
  ├─ Phase 0: Parse & Validate
  │   ├─ Parse devrig.toml (services + infra + compose)
  │   ├─ Validate config (deps, ports, cycles)
  │   └─ Load previous state (.devrig/state.json) for port stickiness
  │
  ├─ Phase 1: Network
  │   └─ Create Docker network (devrig-{slug}-net)
  │
  ├─ Phase 2: Compose (if [compose] present)
  │   ├─ docker compose -f <file> -p devrig-{slug} up -d [services...]
  │   ├─ docker compose ps --format json (get container IDs)
  │   ├─ Connect compose containers to devrig network
  │   └─ Run ready checks for compose services
  │
  ├─ Phase 3: Infrastructure
  │   ├─ Pull images (parallel, with progress reporting)
  │   ├─ Create volumes
  │   ├─ Start containers (respecting depends_on order)
  │   ├─ Run ready checks (poll with backoff)
  │   └─ Run init scripts (if first time, tracked in state.json)
  │
  ├─ Phase 4: Resolve & Inject
  │   ├─ Resolve all auto-assigned ports (both service and infra)
  │   ├─ Build template variable map
  │   ├─ Resolve template expressions in config
  │   ├─ Generate DEVRIG_* environment variables
  │   └─ Check for port conflicts
  │
  ├─ Phase 5: Services
  │   ├─ Inject env vars (global + service + DEVRIG_* + PORT/HOST)
  │   ├─ Spawn processes (respecting depends_on)
  │   └─ Begin log multiplexing
  │
  ├─ Print startup summary
  └─ Enter watch mode
```

**Critical ordering: Phase 4 (resolve) must happen after Phase 3 (infra) because infra containers may have auto-assigned ports that need to be resolved before template expressions can be evaluated.**

### 4. Unified Dependency Graph

The dependency graph must now include both services and infra. The PRD allows services to depend on infra:

```toml
[services.api]
depends_on = ["postgres"]   # postgres is [infra.postgres]
```

The `DependencyResolver` should treat all entries (services + infra + compose services) as nodes in a single graph:

```rust
pub enum ResourceKind {
    Service,
    Infra,
    Compose,
}

pub struct ResourceNode {
    pub name: String,
    pub kind: ResourceKind,
}
```

Topological sort determines the start order across all resource types. Infra nodes are started with Docker, compose nodes via `docker compose`, and service nodes as local processes.

### 5. Ready Check Architecture

Ready checks are the bridge between "container is running" and "container is ready to accept connections." Each strategy maps to a different implementation:

```
ReadyCheck::PgIsReady  → Docker exec: pg_isready -h localhost -q -t 2
ReadyCheck::Cmd        → Docker exec: <command>, check exit code (+ optional stdout match)
ReadyCheck::Http       → reqwest GET to URL, check for 2xx status
ReadyCheck::Tcp        → tokio TcpStream::connect to host:port
ReadyCheck::Log        → bollard logs stream with follow:true, scan for pattern
```

All except `Log` use the backon retry pattern:

```rust
let result = (|| async { check_fn().await })
    .retry(ExponentialBuilder::default()
        .with_min_delay(Duration::from_millis(250))
        .with_max_delay(Duration::from_secs(3))
        .with_max_times(200)   // High max; total timeout is the real limit
        .with_jitter())
    .sleep(tokio::time::sleep)
    .notify(|err, dur| {
        tracing::debug!(service = %name, "ready check failed: {err}, retrying in {dur:?}");
    })
    .await;

// Wrap in total timeout
tokio::time::timeout(Duration::from_secs(30), result).await
```

The `Log` strategy is different — it's a continuous stream, not poll-retry:

```rust
let options = LogsOptions { follow: true, stdout: true, stderr: true, tail: "all", .. };
let stream = docker.logs(container, Some(options));
tokio::time::timeout(timeout, async {
    while let Some(Ok(output)) = stream.next().await {
        if output.to_string().contains(&pattern) { return Ok(()); }
    }
    Err(anyhow!("log stream ended without finding pattern"))
}).await
```

### 6. Template Expression Resolution

Use a flat `HashMap<String, String>` variable map with dot-path keys:

```rust
// Build after all ports are resolved
let mut vars: HashMap<String, String> = HashMap::new();
vars.insert("project.name".into(), config.project.name.clone());

for (name, svc) in &config.services {
    if let Some(port) = resolved_ports.get(&format!("service:{name}")) {
        vars.insert(format!("services.{name}.port"), port.to_string());
    }
}
for (name, infra) in &config.infra {
    if let Some(port) = resolved_ports.get(&format!("infra:{name}")) {
        vars.insert(format!("infra.{name}.port"), port.to_string());
    }
}
```

Resolution with compiled regex:

```rust
use std::sync::LazyLock;
use regex::Regex;

static TEMPLATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\{\{\s*([\w.]+)\s*\}\}").unwrap()
});

fn resolve_template(
    input: &str,
    vars: &HashMap<String, String>,
    field_context: &str,   // For error messages: "services.api.env.DATABASE_URL"
) -> Result<String, Vec<TemplateError>> {
    // Pass 1: validate all references exist
    let mut errors = Vec::new();
    for caps in TEMPLATE_RE.captures_iter(input) {
        let path = &caps[1];
        if !vars.contains_key(path) {
            errors.push(TemplateError::UnresolvedVariable {
                field: field_context.to_string(),
                variable: path.to_string(),
            });
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }

    // Pass 2: replace (all lookups guaranteed to succeed)
    let result = TEMPLATE_RE.replace_all(input, |caps: &regex::Captures| {
        vars[&caps[1]].clone()
    });
    Ok(result.into_owned())
}
```

**Why two-pass?** The `replace_all` closure cannot return `Result`, so we validate first, then replace. This also matches the existing error-collection pattern in `validate.rs`.

**Circular references are not possible** in the current design: template expressions only reference `project.name`, `services.*.port`, and `infra.*.port` — all of which are concrete values (literal strings/numbers or auto-assigned ports), never themselves template expressions.

### 7. Service Discovery Environment Variables

Every service process receives a comprehensive set of auto-generated environment variables:

```rust
fn build_service_env(
    service_name: &str,
    config: &DevrigConfig,
    resolved_ports: &HashMap<String, u16>,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();

    // Global env
    env.extend(config.env.clone());

    // DEVRIG_* vars for all infra
    for (name, infra) in &config.infra {
        let upper = name.to_uppercase();
        env.insert(format!("DEVRIG_{upper}_HOST"), "localhost".into());
        if let Some(port) = resolved_ports.get(&format!("infra:{name}")) {
            env.insert(format!("DEVRIG_{upper}_PORT"), port.to_string());
            env.insert(format!("DEVRIG_{upper}_URL"), generate_url(name, infra, *port));
        }
        // Named ports
        for (port_name, _) in &infra.ports {
            let upper_port = port_name.to_uppercase();
            if let Some(port) = resolved_ports.get(&format!("infra:{name}:{port_name}")) {
                env.insert(format!("DEVRIG_{upper}_PORT_{upper_port}"), port.to_string());
            }
        }
    }

    // DEVRIG_* vars for all services
    for (name, svc) in &config.services {
        let upper = name.to_uppercase();
        env.insert(format!("DEVRIG_{upper}_HOST"), "localhost".into());
        if let Some(port) = resolved_ports.get(&format!("service:{name}")) {
            env.insert(format!("DEVRIG_{upper}_PORT"), port.to_string());
            env.insert(format!("DEVRIG_{upper}_URL"), format!("http://localhost:{port}"));
        }
    }

    // Service's own PORT and HOST
    if let Some(port) = resolved_ports.get(&format!("service:{service_name}")) {
        env.insert("PORT".into(), port.to_string());
        env.insert("HOST".into(), "localhost".into());
    }

    // Service-specific env (may override auto-generated)
    if let Some(svc) = config.services.get(service_name) {
        env.extend(svc.env.clone());
    }

    env
}
```

### 8. URL Generation Rules

```rust
fn generate_url(name: &str, infra: &InfraConfig, port: u16) -> String {
    let image_lower = infra.image.to_lowercase();

    if image_lower.starts_with("postgres") {
        // Extract POSTGRES_USER and POSTGRES_PASSWORD from infra env
        let user = infra.env.get("POSTGRES_USER").map(|s| s.as_str()).unwrap_or("postgres");
        let pass = infra.env.get("POSTGRES_PASSWORD").map(|s| s.as_str()).unwrap_or("");
        if pass.is_empty() {
            format!("postgres://{user}@localhost:{port}")
        } else {
            format!("postgres://{user}:{pass}@localhost:{port}")
        }
    } else if image_lower.starts_with("redis") {
        format!("redis://localhost:{port}")
    } else if image_lower.contains("mailpit") || image_lower.contains("smtp") {
        // Generic: no URL for multi-port services, just host:port
        format!("localhost:{port}")
    } else {
        // Default: assume HTTP
        format!("http://localhost:{port}")
    }
}
```

The URL generation heuristic is based on image name. This works for common cases (postgres, redis) and falls back to a reasonable default. For multi-port infra services, no single URL is generated — users access individual ports via `DEVRIG_<NAME>_PORT_<PORTNAME>`.

### 9. Docker Network Management

```rust
async fn ensure_network(docker: &Docker, network_name: &str, labels: HashMap<String, String>) -> Result<()> {
    // Check if network already exists
    match docker.inspect_network(network_name, None::<InspectNetworkOptions<String>>).await {
        Ok(_) => return Ok(()),  // Already exists
        Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) => {}
        Err(e) => return Err(e.into()),
    }

    // Create bridge network
    let config = CreateNetworkOptions {
        name: network_name,
        driver: "bridge",
        labels,
        ..Default::default()
    };
    docker.create_network(config).await?;
    Ok(())
}
```

### 10. Compose Interop Pattern

Compose interaction uses `tokio::process::Command` to shell out to `docker compose`:

```rust
async fn compose_up(
    compose_file: &Path,
    project_name: &str,
    services: &[String],
) -> Result<()> {
    let mut cmd = tokio::process::Command::new("docker");
    cmd.args(["compose", "-f", &compose_file.to_string_lossy(), "-p", project_name, "up", "-d"]);
    for svc in services {
        cmd.arg(svc);
    }
    let output = cmd.output().await?;
    if !output.status.success() {
        anyhow::bail!("docker compose up failed: {}", String::from_utf8_lossy(&output.stderr));
    }
    Ok(())
}

async fn compose_ps(compose_file: &Path, project_name: &str) -> Result<Vec<ComposeService>> {
    let output = tokio::process::Command::new("docker")
        .args(["compose", "-f", &compose_file.to_string_lossy(), "-p", project_name, "ps", "--format", "json"])
        .output()
        .await?;
    let services: Vec<ComposeService> = serde_json::from_slice(&output.stdout)?;
    Ok(services)
}

#[derive(Debug, Deserialize)]
struct ComposeService {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Service")]
    service: String,
    #[serde(rename = "State")]
    state: String,
    #[serde(rename = "Health")]
    health: String,
    #[serde(rename = "Publishers")]
    publishers: Vec<ComposePublisher>,
}

#[derive(Debug, Deserialize)]
struct ComposePublisher {
    #[serde(rename = "TargetPort")]
    target_port: u16,
    #[serde(rename = "PublishedPort")]
    published_port: u16,
}
```

After `compose up`, connect compose containers to the devrig network:

```rust
async fn bridge_compose_containers(
    docker: &Docker,
    network_name: &str,
    compose_containers: &[ComposeService],
) -> Result<()> {
    for container in compose_containers {
        docker.connect_network(network_name, ConnectNetworkOptions {
            container: &container.id,
            endpoint_config: EndpointSettings {
                aliases: Some(vec![container.service.clone()]),
                ..Default::default()
            },
        }).await?;
    }
    Ok(())
}
```

### 11. Init Script Execution and Tracking

Init scripts run once per infrastructure service and are tracked in `.devrig/state.json`:

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct InfraState {
    pub container_id: String,
    pub container_name: String,
    pub port: Option<u16>,
    pub port_auto: bool,
    pub init_completed: bool,          // Track init script execution
    pub init_completed_at: Option<DateTime<Utc>>,
}
```

For SQL init scripts (like Postgres), use `docker exec`:

```rust
async fn run_init_scripts(
    docker: &Docker,
    container_id: &str,
    infra_name: &str,
    infra: &InfraConfig,
) -> Result<()> {
    for (i, script) in infra.init.iter().enumerate() {
        tracing::info!(infra = %infra_name, "running init script {}/{}", i + 1, infra.init.len());

        // Detect if this is SQL (for postgres) or a shell command
        let cmd = if infra.image.starts_with("postgres") {
            let user = infra.env.get("POSTGRES_USER").map(|s| s.as_str()).unwrap_or("postgres");
            vec!["psql", "-U", user, "-c", script]
        } else {
            vec!["sh", "-c", script]
        };

        let exec = docker.create_exec(container_id, CreateExecOptions {
            cmd: Some(cmd.into_iter().map(String::from).collect()),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            ..Default::default()
        }).await?;

        // Start exec and consume output
        if let StartExecResults::Attached { mut output, .. } = docker.start_exec(&exec.id, None).await? {
            while let Some(msg) = output.next().await {
                match msg {
                    Ok(log) => tracing::debug!(infra = %infra_name, "init: {}", log),
                    Err(e) => tracing::warn!(infra = %infra_name, "init stream error: {}", e),
                }
            }
        }

        // Check exit code
        let inspect = docker.inspect_exec(&exec.id).await?;
        if inspect.exit_code != Some(0) {
            anyhow::bail!(
                "init script {} for {} failed with exit code {:?}",
                i + 1, infra_name, inspect.exit_code
            );
        }
    }
    Ok(())
}
```

`devrig reset <name>` clears `init_completed` in the state file, so the next `devrig start` re-runs init scripts.

### 12. State Model Extensions

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectState {
    pub slug: String,
    pub config_path: String,
    pub services: BTreeMap<String, ServiceState>,
    pub infra: BTreeMap<String, InfraState>,         // NEW
    pub compose_services: BTreeMap<String, ComposeServiceState>,  // NEW
    pub network_name: Option<String>,                 // NEW
    pub started_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InfraState {
    pub container_id: String,
    pub container_name: String,
    pub port: Option<u16>,
    pub port_auto: bool,
    pub named_ports: BTreeMap<String, u16>,
    pub init_completed: bool,
    pub init_completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ComposeServiceState {
    pub container_id: String,
    pub container_name: String,
    pub port: Option<u16>,
}
```

### 13. Auto Port Selection with Stickiness

Extend the existing port system to support sticky auto-ports across restarts:

```rust
fn resolve_port(
    resource_key: &str,         // e.g., "infra:postgres" or "service:worker"
    port_config: &Port,
    prev_state: Option<&InfraState>,
    allocated: &mut HashSet<u16>,  // Track already-allocated ports to avoid TOCTOU races
) -> Result<u16> {
    match port_config {
        Port::Fixed(p) => Ok(*p),
        Port::Auto => {
            // Try to reuse previously assigned port
            if let Some(prev) = prev_state {
                if prev.port_auto {
                    if let Some(prev_port) = prev.port {
                        if !allocated.contains(&prev_port) && check_port_available(prev_port) {
                            allocated.insert(prev_port);
                            return Ok(prev_port);
                        }
                        tracing::info!("{}: previously assigned port {} no longer available", resource_key, prev_port);
                    }
                }
            }
            // Find a new free port
            let port = find_free_port_excluding(allocated)?;
            allocated.insert(port);
            Ok(port)
        }
    }
}
```

---

## Implementation Strategy

### Feature 1: [infra.*] blocks with Docker container lifecycle

**Approach:** New `src/infra/` module with `InfraManager` struct that owns a `bollard::Docker` client. Container lifecycle: pull image → create container (with labels, env, volumes, port bindings, network) → start → ready check → init scripts.

**Key design decisions:**
- Use `bollard::Docker::connect_with_local_defaults()` for cross-platform socket detection
- Container naming: `devrig-{slug}-{service}`
- All containers get `devrig.project` and `devrig.service` labels
- Image pull is parallel across all infra services (via `tokio::JoinSet`)
- Container creation respects `depends_on` ordering from the unified dependency graph

**Files:**
- `src/infra/mod.rs` — Re-exports, `InfraManager` struct
- `src/infra/container.rs` — Container create/start/stop/remove lifecycle
- `src/infra/image.rs` — Image pulling with progress reporting
- `src/infra/volume.rs` — Volume creation with project-scoped naming
- `src/infra/network.rs` — Network create/remove/connect
- `src/infra/exec.rs` — Docker exec for init scripts and ready checks
- `src/infra/ready.rs` — Ready check strategies (all 5 types)

### Feature 2: Image pulling, volume management

**Approach:** Image pulling uses bollard's `create_image` stream API with progress reporting. Volumes are created with project-scoped names (`devrig-{slug}-{volume_name}`) and labeled with `devrig.project`.

**Image pull pattern:**
```rust
async fn pull_image(docker: &Docker, image: &str) -> Result<()> {
    let (name, tag) = parse_image_ref(image);  // "postgres:16" -> ("postgres", "16")
    let options = CreateImageOptionsBuilder::default()
        .from_image(&name)
        .tag(&tag)
        .build();
    let mut stream = docker.create_image(Some(options), None, None);
    while let Some(result) = stream.next().await {
        let info = result?;
        if info.error_detail.is_some() {
            anyhow::bail!("image pull failed for {}", image);
        }
        // Log progress
    }
    Ok(())
}
```

**Volume naming:** Config `volumes = ["pgdata:/var/lib/postgresql/data"]` becomes Docker volume `devrig-{slug}-pgdata` mounted at `/var/lib/postgresql/data`.

### Feature 3: Ready check system

**Approach:** A `ReadyChecker` trait with implementations for each strategy. The `backon` crate handles retry logic with exponential backoff. Total timeout defaults to 30s but is configurable.

**Strategy implementations:**

| Strategy | Implementation |
|---|---|
| `pg_isready` | Docker exec: `pg_isready -h localhost -q -t 2`. Exit code 0 = ready. |
| `cmd` | Docker exec: `<command>`. Check exit code (0 = success). Optionally check stdout matches `expect`. |
| `http` | `reqwest::Client::get(url)`. Check for 2xx status. Use per-request timeout of 2s. |
| `tcp` | `tokio::net::TcpStream::connect("127.0.0.1:{port}")` with 2s connect timeout. |
| `log` | `docker.logs(container, LogsOptions { follow: true, ... })`. Scan stream for pattern match. Wrap in total timeout. |

**Default timeout:** 30s for all strategies except `log` which defaults to 60s (some services are slow to emit readiness messages).

**Error reporting when ready check fails:**
```
  postgres  ready check timed out after 30s (47 attempts)
            strategy: pg_isready
            last error: connection refused (os error 111)
```

### Feature 4: Init script execution and tracking

**Approach:** After ready check passes, run init scripts via `docker exec`. Track completion in `state.json` via `init_completed: bool`. Skip on subsequent starts. `devrig reset <name>` clears the flag.

**Key decisions:**
- For postgres images, init scripts are run via `psql -U <user> -c "<script>"`
- For other images, init scripts are run via `sh -c "<script>"`
- Init scripts run sequentially (order matters for SQL)
- If any init script fails, the entire startup fails with a clear error

### Feature 5: Service discovery (DEVRIG_* vars)

**Approach:** After all ports are resolved (both service and infra), build the complete environment variable map. Every service gets DEVRIG_* vars for every other service and all infra. See the `build_service_env()` function in Design Patterns section 7.

**Variable naming convention:**
```
DEVRIG_{UPPER_NAME}_HOST=localhost
DEVRIG_{UPPER_NAME}_PORT={resolved_port}
DEVRIG_{UPPER_NAME}_URL={protocol}://...
DEVRIG_{UPPER_NAME}_PORT_{UPPER_PORT_NAME}={port}   (for named ports)
PORT={own_port}                                       (service's own port)
HOST=localhost                                        (service's own host)
```

### Feature 6: URL generation

**Approach:** Image-name-based heuristic for URL protocol. See `generate_url()` in Design Patterns section 8.

| Image prefix | URL pattern |
|---|---|
| `postgres` | `postgres://{user}:{pass}@localhost:{port}` |
| `redis` | `redis://localhost:{port}` |
| Multi-port | No URL (use individual `_PORT_<name>` vars) |
| Default | `http://localhost:{port}` |

### Feature 7: devrig env command

**Approach:** New CLI subcommand that reads config + state, resolves all variables, and prints them.

```rust
#[derive(Debug, Subcommand)]
pub enum Commands {
    // ... existing commands ...
    /// Show resolved environment variables
    Env {
        /// Service name
        service: String,
        /// Specific variable name (optional)
        variable: Option<String>,
        /// Output as shell export statements
        #[arg(long)]
        export: bool,
    },
}
```

Output formats:
- Default: `KEY=VALUE` (one per line)
- `--export`: `export KEY="VALUE"` (shell-safe, eval-ready)

**Files:**
- `src/commands/env.rs` — `devrig env` implementation

### Feature 8: Auto port selection with state persistence

**Approach:** Extend the existing port system with sticky auto-ports. Load previous state, try to reuse auto-assigned ports, fall back to new allocation. Track allocated ports in a `HashSet` during resolution to prevent TOCTOU races.

**Key flow:**
1. Load `.devrig/state.json` (if exists)
2. For each service/infra with `port = "auto"`: try previous port, then find new
3. For each service/infra with `port = <number>`: verify available
4. Save resolved ports to state

### Feature 9: Template expression resolution

**Approach:** Regex-based resolver with flat variable map. See Design Patterns section 6.

**Key design decisions:**
- Use `std::sync::LazyLock` for compiled regex (stable since Rust 1.80)
- Two-pass: validate all references exist, then replace
- Walk only string fields that support templates (env values, cluster.name)
- Template resolution happens after all ports are assigned

**Files:**
- `src/config/interpolate.rs` — Template resolver

### Feature 10: devrig exec and devrig reset

**Approach:**
- `devrig exec <infra>`: Opens an interactive shell in the infra container via `docker exec -it <container> /bin/sh`
- `devrig reset <infra>`: Clears `init_completed` in state, optionally re-runs init on next start

```rust
pub enum Commands {
    Exec {
        /// Infrastructure service name
        service: String,
    },
    Reset {
        /// Infrastructure service name
        service: String,
    },
}
```

`devrig exec` requires an interactive terminal, so it shells out to `docker exec -it <container> /bin/sh` (or `/bin/bash` if available) rather than using bollard's exec API.

### Feature 11: Docker network creation and management

**Approach:** Create a project-scoped bridge network on `devrig start`, connect all infra containers to it, connect compose containers to it. Remove on `devrig delete`.

**Key decisions:**
- Network name: `devrig-{slug}-net`
- Network driver: `bridge` (default, supports DNS resolution between containers)
- Idempotent: check if network exists before creating
- All containers get aliases on the network (service name as alias)

### Feature 12: [compose] interop

**Approach:** Shell out to `docker compose` CLI for lifecycle management. Use bollard for network bridging. See Design Patterns section 10.

**Key decisions:**
- Always pass `-p devrig-{slug}` to control compose project name
- Always pass `-f <compose_file>` explicitly
- After `docker compose up`, connect containers to devrig network
- Ready checks for compose services are configured in `[compose.ready_checks]`
- `docker compose down --remove-orphans` on `devrig delete`

### Feature 13: Compose + native infra coexistence

**Approach:** Both compose and native infra containers connect to the same devrig network. DNS resolution allows them to find each other by container name or alias.

**Key decisions:**
- Create the devrig network first, before starting compose or native infra
- Connect compose containers to devrig network after `compose up`
- Native infra containers are created directly on the devrig network
- Service discovery via DEVRIG_* vars works identically for compose and native infra

---

## Risks and Considerations

### Risk 1: Docker Daemon Availability

The Docker daemon may not be running, or the user may not have permission to access the Docker socket.

**Mitigation:**
- Check Docker daemon connectivity at startup with `docker.ping().await`
- `devrig doctor` should verify Docker is running and accessible
- Clear error message: "Cannot connect to Docker daemon. Is Docker running?"
- Check socket permissions: `/var/run/docker.sock` must be readable by the user

### Risk 2: Bollard API Version Compatibility

Bollard targets a specific Docker API version. Older Docker installations may not support all API features.

**Mitigation:**
- Use `docker.negotiate_version().await` to discover the server's API version
- Stick to widely-supported API features (containers, networks, volumes, exec are stable since API v1.25+)
- Test against Docker CE 20.10+ (the minimum commonly-available version)

### Risk 3: Image Pull Failures

Image pulls can fail for many reasons: network issues, auth required, image not found, disk space.

**Mitigation:**
- Always check `error_detail` on each stream item (bollard historically had a bug where pull errors were silently swallowed)
- Report the specific pull error clearly: "Failed to pull postgres:16: image not found"
- Consider checking if the image already exists locally before pulling (`docker.inspect_image()`)
- Support `--pull never|missing|always` flag (similar to compose)

### Risk 4: Port Binding Race Conditions

Between resolving an auto port and actually binding it in the container, another process could grab it.

**Mitigation:**
- For Docker containers: bind the port in the container config and let Docker report the actual bound port
- For services: use the existing hold-and-release pattern from v0.1's `find_free_port()`
- Track all allocated ports in a `HashSet<u16>` during resolution to prevent self-collisions
- Retry port allocation if Docker reports a bind failure

### Risk 5: Ready Check Flakiness

Container startup times are variable. A ready check that works 95% of the time causes flaky tests and frustrated developers.

**Mitigation:**
- Use generous default timeouts (30s for most, 60s for log-based)
- Exponential backoff with jitter prevents thundering herd on overloaded machines
- Log every retry attempt at debug level for troubleshooting
- When ready check times out, show the *last error* not just "timed out"
- Allow per-service timeout configuration: `ready_check = { type = "pg_isready", timeout = "60s" }`

### Risk 6: Volume Cleanup on Delete

`devrig delete` must remove all volumes, but volumes may be in use by running containers.

**Mitigation:**
- Always stop and remove containers before removing volumes
- Use `docker.remove_volume(name, None).await` with error handling for "volume in use"
- Use label-based discovery (`devrig.project={slug}`) to find all volumes, not just those in state.json
- Verify cleanup: after delete, assert zero resources with matching labels remain

### Risk 7: Compose File Compatibility

Users' compose files may use features that interact poorly with devrig's management (custom networks, depends_on with conditions, profiles).

**Mitigation:**
- Validate compose file with `docker compose config --quiet` before starting
- List available services with `docker compose config --services` and validate user's `services` list against it
- Document known limitations in `docs/guides/compose-migration.md`
- Use `-p` flag to isolate the compose project namespace

### Risk 8: Template Resolution Order

If template expressions reference each other, resolution order matters. Currently, templates only reference concrete values, but future features could introduce dependencies.

**Mitigation:**
- Document that template expressions may only reference `project.name`, `services.*.port`, and `infra.*.port`
- These are always concrete values, never themselves template expressions
- If env-to-env references are ever added, implement topological sort on template dependencies (reuse petgraph)

### Risk 9: State File Corruption

`.devrig/state.json` could become corrupted (partial write, concurrent access, manual editing).

**Mitigation:**
- Atomic writes (write to `.tmp`, then rename) — already implemented in v0.1
- Treat state as advisory: if state.json is missing or corrupt, fall back to Docker label-based discovery
- `devrig delete` should work even without state.json by querying Docker labels

### Risk 10: Container Cleanup After Failed Start

If devrig fails mid-startup (e.g., one infra container starts but another fails its ready check), orphaned containers remain.

**Mitigation:**
- Implement a cleanup-on-failure path: if startup fails after creating any resources, tear down what was created
- Use Docker labels for cleanup, not just in-memory state
- `devrig delete` should always clean up everything, even from failed starts
- Integration tests must verify no leaked resources after failure scenarios

### Risk 11: Integration Test Docker Requirements

Integration tests for v0.2 require a running Docker daemon, which adds CI complexity.

**Mitigation:**
- Gate all Docker-dependent tests behind `#[cfg(feature = "integration")]`
- CI pipeline needs Docker installed (GitHub Actions, GitLab CI both support this)
- Each test gets a unique project slug (via unique temp dir paths) for isolation
- Assert zero leaked resources after each test using label-based queries
- Use lightweight images for tests (alpine, postgres:16-alpine, redis:7-alpine)

---

## Testing Strategy for v0.2

### Integration Test Matrix

| Test | What It Verifies |
|---|---|
| `infra_lifecycle` | Start postgres container → ready check passes → connect to postgres → stop → container removed |
| `redis_lifecycle` | Start redis → cmd ready check (redis-cli ping) → connect → stop → removed |
| `ready_check_pg_isready` | pg_isready succeeds after container starts, fails before |
| `ready_check_cmd` | Custom command exec succeeds/fails correctly, expect matching works |
| `ready_check_http` | HTTP endpoint check returns 2xx, retries on failure |
| `ready_check_tcp` | TCP port check succeeds when port is open |
| `ready_check_log` | Log pattern matching detects readiness string in container output |
| `init_scripts_run_once` | Init SQL runs on first start, skipped on restart, runs again after reset |
| `service_discovery_vars` | DEVRIG_POSTGRES_HOST/PORT/URL injected into service processes |
| `url_generation` | postgres:// URL with credentials, redis:// URL, http:// URL |
| `devrig_env_output` | `devrig env api` shows correct resolved variables |
| `auto_port_persistence` | Auto-assigned port persists across stop/start |
| `auto_port_realloc` | If previous auto port is occupied, new port is assigned |
| `template_resolution` | `{{ infra.postgres.port }}` resolves correctly in env vars |
| `compose_interop` | Compose services start, connect to devrig network, accessible by native services |
| `compose_native_coexistence` | Compose postgres + native redis on same network, services can reach both |
| `volume_cleanup` | `devrig delete` removes all project-scoped volumes |
| `network_isolation` | Two devrig projects have separate networks, no cross-talk |
| `leaked_resource_check` | After delete, zero Docker resources with matching project labels |
| `devrig_exec` | `devrig exec postgres` connects to container shell |
| `devrig_reset` | `devrig reset postgres` clears init state, re-runs on next start |
| `image_pull` | Image is pulled if not present locally, skipped if present |

### Test Patterns

**Every integration test follows this cleanup-safe pattern:**

```rust
#[tokio::test]
async fn test_infra_lifecycle() {
    let docker = Docker::connect_with_local_defaults().unwrap();
    let project = TestProject::new_with_infra(r#"
        [project]
        name = "test-infra"
        [infra.postgres]
        image = "postgres:16-alpine"
        port = "auto"
        env = { POSTGRES_USER = "devrig", POSTGRES_PASSWORD = "devrig" }
        ready_check = { type = "pg_isready" }
    "#);

    // Act: start
    let rig = DevRig::from_config(project.config_path.clone()).await.unwrap();
    rig.start().await.unwrap();

    // Assert: postgres is reachable
    // (try connecting with tokio-postgres or just TCP check)

    // Act: stop
    rig.stop().await.unwrap();

    // Assert: container is gone
    let containers = docker.list_containers(Some(ListContainersOptions {
        all: true,
        filters: HashMap::from([("label", vec![format!("devrig.project={}", project.slug)])]),
        ..Default::default()
    })).await.unwrap();
    assert!(containers.is_empty(), "leaked containers: {:?}", containers);

    // Act: delete
    rig.delete().await.unwrap();

    // Assert: volumes and network gone
    // ... label-based queries for volumes and networks
}
```

### Cleanup Verification Helper

```rust
async fn assert_no_leaked_resources(docker: &Docker, slug: &str) {
    // Check containers
    let containers = docker.list_containers(Some(ListContainersOptions {
        all: true,
        filters: HashMap::from([("label", vec![format!("devrig.project={slug}")])]),
        ..Default::default()
    })).await.unwrap();
    assert!(containers.is_empty(), "leaked containers for {slug}: {containers:?}");

    // Check volumes
    let volumes = docker.list_volumes(Some(ListVolumesOptions {
        filters: HashMap::from([("label", vec![format!("devrig.project={slug}")])]),
    })).await.unwrap();
    assert!(volumes.volumes.unwrap_or_default().is_empty(), "leaked volumes for {slug}");

    // Check networks
    let networks = docker.list_networks(Some(ListNetworksOptions {
        filters: HashMap::from([("label", vec![format!("devrig.project={slug}")])]),
    })).await.unwrap();
    assert!(networks.is_empty(), "leaked networks for {slug}");
}
```

---

## Module Structure for v0.2

```
src/
  main.rs                    # CLI entry point (unchanged)
  lib.rs                     # Add infra, compose module re-exports
  cli.rs                     # Add Env, Exec, Reset subcommands
  identity.rs                # Unchanged
  config/
    mod.rs                   # Extended load_config with validation
    model.rs                 # Add InfraConfig, ComposeConfig, ReadyCheck, NetworkConfig
    validate.rs              # Extended: validate infra refs, compose refs, port conflicts across infra+services
    resolve.rs               # Unchanged
    interpolate.rs           # NEW: Template expression resolution
  orchestrator/
    mod.rs                   # Extended: multi-phase startup (network → compose → infra → resolve → services)
    supervisor.rs            # Unchanged (service processes)
    graph.rs                 # Extended: unified graph with services + infra + compose
    ports.rs                 # Extended: sticky auto-ports, port resolution for infra
    state.rs                 # Extended: InfraState, ComposeServiceState
    registry.rs              # Extended: Docker label-based discovery
  infra/                     # NEW MODULE
    mod.rs                   # InfraManager struct, re-exports
    container.rs             # Container create/start/stop/remove
    image.rs                 # Image pulling with progress
    volume.rs                # Volume creation and cleanup
    network.rs               # Network create/remove/connect
    exec.rs                  # Docker exec (for init scripts and cmd ready checks)
    ready.rs                 # Ready check strategies (pg_isready, cmd, http, tcp, log)
  compose/                   # NEW MODULE
    mod.rs                   # ComposeManager struct
    lifecycle.rs             # compose up/down/ps via CLI
    bridge.rs                # Network bridging for compose containers
  discovery/                 # NEW MODULE
    mod.rs                   # Service discovery env var generation
    env.rs                   # DEVRIG_* variable building
    url.rs                   # URL generation (postgres://, redis://, http://)
  commands/
    mod.rs                   # Add env, exec, reset exports
    ps.rs                    # Extended: show infra status from Docker
    init.rs                  # Extended: offer infra examples
    doctor.rs                # Extended: check Docker daemon
    env.rs                   # NEW: devrig env command
    exec.rs                  # NEW: devrig exec command
    reset.rs                 # NEW: devrig reset command
  ui/
    logs.rs                  # Extended: include infra container logs
    summary.rs               # Extended: show infra endpoints and compose services
```

---

## References

### Crate Documentation
- [bollard 0.20 — crates.io](https://crates.io/crates/bollard) — Docker Engine API client
- [bollard API docs](https://docs.rs/bollard/latest/bollard/) — Container, Image, Network, Volume, Exec APIs
- [bollard GitHub examples](https://github.com/fussybeaver/bollard/tree/master/examples) — exec.rs, container lifecycle
- [backon — crates.io](https://crates.io/crates/backon) — Retry with backoff
- [backon API design article](https://rustmagazine.org/issue-2/how-i-designed-the-api-for-backon-a-user-friendly-retry-crate/)
- [reqwest — crates.io](https://crates.io/crates/reqwest) — HTTP client
- [futures-util — crates.io](https://crates.io/crates/futures-util) — Stream combinators

### Docker API References
- [Docker Engine API v1.49](https://docs.docker.com/engine/api/v1.49/) — Container, Network, Volume, Exec endpoints
- [Docker Compose CLI reference](https://docs.docker.com/reference/cli/docker/compose/) — up, down, ps, config
- [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/) — Bridge networks, DNS resolution
- [Docker Compose project naming](https://docs.docker.com/compose/how-tos/project-name/) — -p flag, container naming convention
- [Docker labels for compose](https://docs.docker.com/compose/how-tos/use-labels/) — com.docker.compose.project, .service

### Ready Check References
- [PostgreSQL pg_isready](https://www.postgresql.org/docs/current/app-pg-isready.html) — Exit codes, arguments
- [Docker health check best practices](https://docs.docker.com/reference/dockerfile/#healthcheck) — HEALTHCHECK instruction
- [Docker Compose health checks guide](https://last9.io/blog/docker-compose-health-checks/) — depends_on with condition

### Design Pattern References
- [.NET Aspire service discovery](https://learn.microsoft.com/en-us/dotnet/aspire/service-discovery/overview) — Connection strings, endpoint injection
- [.NET Aspire networking overview](https://aspire.dev/fundamentals/networking-overview/) — Port assignment, environment injection
- [Tilt Docker Compose docs](https://docs.tilt.dev/docker_compose.html) — Compose delegation pattern
- [direnv](https://direnv.net/) — Environment variable export patterns
- [mise env command](https://mise.jdx.dev/cli/env.html) — Multi-format env output

### Template Engine References
- [MiniJinja](https://github.com/mitsuhiko/minijinja) — Lightweight Jinja2 in Rust (considered, not used)
- [MiniJinja design article](https://lucumr.pocoo.org/2024/8/27/minijinja/) — Performance benchmarks, design rationale
- [Regex replace_all patterns](https://docs.rs/regex/latest/regex/trait.Replacer.html) — Fallible replacement patterns

### Testing References
- [bollard test suite](https://github.com/fussybeaver/bollard/tree/master/tests) — Docker integration test patterns
- [testcontainers-rs](https://github.com/testcontainers/testcontainers-rs) — Container test lifecycle management
- [Docker in GitHub Actions](https://docs.github.com/en/actions/use-cases-and-examples/using-containerized-services) — CI Docker availability

### Prior Milestone Context
- [v0.1 Research](../milestone-0/research.md) — Crate selection rationale, design patterns, testing strategy
- [v0.1 Report](../milestone-0/report.md) — Implementation details, known issues, architecture decisions

---

## Appendix: Bollard API Quick Reference

### Container Lifecycle

```rust
// Create
docker.create_container(Some(opts), config).await?;  // Returns ContainerCreateResponse { id }
// Start
docker.start_container(&id, None::<StartContainerOptions>).await?;
// Stop (with timeout)
docker.stop_container(&id, Some(StopContainerOptions { t: 10 })).await?;
// Remove
docker.remove_container(&id, Some(RemoveContainerOptionsBuilder::default().force(true).build())).await?;
// Inspect
docker.inspect_container(&id, None).await?;  // Returns ContainerInspectResponse
// List with label filter
docker.list_containers(Some(ListContainersOptions {
    all: true,
    filters: HashMap::from([("label", vec!["devrig.project=slug"])]),
    ..Default::default()
})).await?;
```

### Image Operations

```rust
// Pull (streaming)
let mut stream = docker.create_image(Some(opts), None, None);
while let Some(result) = stream.next().await { /* check error_detail */ }
// Check if exists
docker.inspect_image("postgres:16").await.is_ok()
```

### Network Operations

```rust
// Create
docker.create_network(CreateNetworkOptions { name: "net", driver: "bridge", labels, .. }).await?;
// Connect container
docker.connect_network("net", ConnectNetworkOptions { container: &id, .. }).await?;
// Remove
docker.remove_network("net").await?;
```

### Volume Operations

```rust
// Create
docker.create_volume(CreateVolumeOptions { name: "vol", labels, .. }).await?;
// Remove
docker.remove_volume("vol", None).await?;
```

### Exec Operations

```rust
// Create exec instance
let exec = docker.create_exec(&container_id, CreateExecOptions {
    cmd: Some(vec!["pg_isready".into(), "-h".into(), "localhost".into()]),
    attach_stdout: Some(true), attach_stderr: Some(true),
    ..Default::default()
}).await?;
// Start and consume output
if let StartExecResults::Attached { mut output, .. } = docker.start_exec(&exec.id, None).await? {
    while let Some(Ok(msg)) = output.next().await { /* process */ }
}
// Get exit code
let inspect = docker.inspect_exec(&exec.id).await?;
// inspect.exit_code: Option<i64>
```

### Key Bollard Error Patterns

```rust
match result {
    Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) => {
        // Resource not found — safe to ignore for idempotent operations
    }
    Err(bollard::errors::Error::DockerResponseServerError { status_code: 409, message }) => {
        // Conflict — container already running, name in use, etc.
    }
    Err(e) => return Err(e.into()),
    Ok(_) => {}
}
```
