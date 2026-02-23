# Milestone v0.1 Research — Local Process Orchestration

> Research compiled for devrig milestone v0.1. Covers crate selection, design patterns,
> implementation strategies, testing approaches, and risk analysis.

---

## Crate/Library Recommendations

### Core Dependencies

| Crate | Version | Purpose | Notes |
|---|---|---|---|
| `clap` | 4.5 | CLI framework | Derive API with subcommands |
| `tokio` | 1.49 | Async runtime | Multi-thread, full features |
| `tokio-util` | 0.7 | Task tracking | `TaskTracker` + `CancellationToken` |
| `tokio-stream` | 0.1 | Stream combinators | `LinesStream`, `merge` for log multiplexing |
| `serde` | 1.0 | Serialization | Derive feature |
| `toml` | 1.0 | TOML parsing | v1.x line (not the old 0.5.x) |
| `petgraph` | 0.7 | Dependency graph | Topological sort with cycle detection |
| `sha2` | 0.10 | Hashing | Deterministic project identity |
| `hex` | 0.4 | Hex encoding | For hash display |
| `nix` | 0.31 | POSIX APIs | `killpg()` for process group signals |
| `owo-colors` | 4.2 | Terminal colors | Zero-alloc colored output |
| `tracing` | 0.1 | Structured logging | Application-level logging |
| `tracing-subscriber` | 0.3 | Log output | With `env-filter`, `ansi`, `fmt` features |
| `anyhow` | 1.0 | Error handling | For application-level errors |
| `thiserror` | 2.0 | Error types | For library-level typed errors |
| `miette` | 7.0 | Diagnostics | User-friendly config errors with source spans |
| `regex` | 1.0 | Template parsing | For `{{ var }}` interpolation |
| `is-terminal` | 0.4 | TTY detection | Disable colors when piping |

### Dev Dependencies

| Crate | Version | Purpose |
|---|---|---|
| `assert_cmd` | 2.1 | CLI integration testing |
| `assert_fs` | 1.1 | Filesystem test fixtures |
| `predicates` | 3.1 | Test assertion combinators |
| `tempfile` | 3.25 | Temporary directories/files |
| `tokio` (test-util) | 1.49 | Async test utilities, `start_paused` |

### Recommended Cargo.toml

```toml
[package]
name = "devrig"
version = "0.1.0"
edition = "2024"

[dependencies]
clap = { version = "4.5", features = ["derive", "env", "wrap_help"] }
tokio = { version = "1.49", features = ["rt-multi-thread", "macros", "process", "signal", "io-util", "time", "fs", "sync"] }
tokio-util = { version = "0.7", features = ["rt"] }
tokio-stream = "0.1"
serde = { version = "1.0", features = ["derive"] }
toml = "1.0"
petgraph = "0.7"
sha2 = "0.10"
hex = "0.4"
nix = { version = "0.31", features = ["signal", "process"] }
owo-colors = "4.2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "ansi", "fmt"] }
anyhow = "1"
thiserror = "2"
miette = { version = "7", features = ["fancy"] }
regex = "1"
is-terminal = "0.4"

[dev-dependencies]
assert_cmd = "2.1"
assert_fs = "1.1"
predicates = "3.1"
tempfile = "3.25"
tokio = { version = "1.49", features = ["test-util", "macros"] }

[features]
default = []
integration = []
```

### Crate Selection Rationale

**Why `petgraph` over custom toposort?** petgraph's `toposort()` is O(|V| + |E|), handles cycle detection (returns `Err(Cycle)` including the offending node), and is battle-tested with both unit and property-based tests. Writing a correct topological sort with good cycle error messages is non-trivial; petgraph eliminates this work.

**Why `sha2` + `hex` over `std::hash`?** Rust's `DefaultHasher` is explicitly NOT deterministic across runs (random seed). `ahash` is also not cross-platform stable. SHA-256 truncated to 8 hex characters provides a deterministic, stable project identity hash that won't change between restarts, machines, or Rust versions.

**Why `owo-colors` over `colored`?** `colored` allocates a `ColoredString` on every operation. For high-throughput log multiplexing (potentially hundreds of lines per second from multiple services), `owo-colors` is measurably faster with zero allocations. Both support the same color operations.

**Why `miette` + `thiserror` together?** `thiserror` defines error types with proper `Display` and `Error` implementations for the library/core logic. `miette` adds source spans, labels, help text, and rich diagnostic formatting for user-facing config errors. They compose naturally — `miette::Diagnostic` can be derived on `thiserror` error types.

**Why NOT `figment` for config?** devrig v0.1 uses a single TOML file with no env-var overrides or config layering. Plain `toml` + `serde` is simpler and sufficient. figment can be added later if env-var overrides or config merging become needed.

**Why NOT `bollard` in v0.1?** Milestone v0.1 is local process orchestration only — no Docker containers. bollard is needed for v0.2 (infrastructure containers). Including it now would add unnecessary dependencies.

---

## Design Patterns

### 1. CLI Structure (clap Derive API)

Use a `Parser` struct with flattened global options and a subcommand enum:

```rust
use clap::{Parser, Subcommand, Args};

#[derive(Debug, Parser)]
#[command(name = "devrig", version, about = "Local development orchestrator")]
pub struct Cli {
    #[command(flatten)]
    pub global: GlobalOpts,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Args)]
pub struct GlobalOpts {
    /// Use a specific config file
    #[arg(short = 'f', long = "file", global = true)]
    pub config_file: Option<PathBuf>,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// Start all services
    Start {
        /// Specific services to start
        services: Vec<String>,
    },
    /// Stop all services
    Stop {
        /// Specific services to stop
        services: Vec<String>,
    },
    /// Stop and remove all resources
    Delete,
    /// Show service status
    Ps {
        /// Show all running devrig instances
        #[arg(long)]
        all: bool,
    },
    /// Generate a starter devrig.toml
    Init,
    /// Check that dependencies are installed
    Doctor,
}
```

**Key pitfall:** When using `#[command(flatten)]` with global args, each field must be marked `global = true` individually — the attribute does not propagate. Always start with a `Parser` struct (not an enum at top level) to allow adding global options later without breaking changes.

### 2. Config Parsing with Serde

**The `port = number | "auto"` pattern** — use a custom deserializer for better error messages than `#[serde(untagged)]`:

```rust
use serde::{Deserialize, Deserializer, de};

#[derive(Debug, Clone)]
pub enum Port {
    Fixed(u16),
    Auto,
}

impl<'de> Deserialize<'de> for Port {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct PortVisitor;
        impl<'de> de::Visitor<'de> for PortVisitor {
            type Value = Port;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                write!(f, "a port number (1-65535) or the string \"auto\"")
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                u16::try_from(v).map(Port::Fixed)
                    .map_err(|_| E::custom(format!("port {} out of range", v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                u16::try_from(v).map(Port::Fixed)
                    .map_err(|_| E::custom(format!("port {} out of range", v)))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                if v == "auto" {
                    Ok(Port::Auto)
                } else {
                    Err(E::custom(format!("expected \"auto\" but got \"{}\"", v)))
                }
            }
        }
        deserializer.deserialize_any(PortVisitor)
    }
}
```

**Config struct hierarchy:**

```rust
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
pub struct DevrigConfig {
    pub project: ProjectConfig,
    #[serde(default)]
    pub services: BTreeMap<String, ServiceConfig>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct ProjectConfig {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct ServiceConfig {
    #[serde(default)]
    pub path: Option<String>,
    pub command: String,
    #[serde(default)]
    pub port: Option<Port>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
}
```

Use `BTreeMap` over `HashMap` for deterministic iteration order (following Cargo's pattern). Use `#[serde(default)]` on all optional sections.

**Two-phase parsing (Cargo's pattern):** Deserialize into the raw config structs first, then run a separate validation/resolution phase. This keeps parsing concerns separate from business logic.

### 3. Post-Deserialization Validation

Validate after parsing, returning all errors (not just the first):

```rust
impl DevrigConfig {
    pub fn validate(&self) -> Result<(), Vec<ConfigError>> {
        let mut errors = Vec::new();

        // Check depends_on references exist
        let all_names: HashSet<&str> = self.services.keys().map(|s| s.as_str()).collect();
        for (name, svc) in &self.services {
            for dep in &svc.depends_on {
                if !all_names.contains(dep.as_str()) {
                    errors.push(ConfigError::MissingDependency {
                        service: name.clone(),
                        dependency: dep.clone(),
                        available: all_names.iter().copied().collect(),
                    });
                }
            }
        }

        // Check for duplicate fixed ports
        let mut port_owners: BTreeMap<u16, Vec<&str>> = BTreeMap::new();
        for (name, svc) in &self.services {
            if let Some(Port::Fixed(p)) = &svc.port {
                port_owners.entry(*p).or_default().push(name);
            }
        }
        for (port, owners) in &port_owners {
            if owners.len() > 1 {
                errors.push(ConfigError::DuplicatePort {
                    port: *port,
                    services: owners.iter().map(|s| s.to_string()).collect(),
                });
            }
        }

        // Check for dependency cycles (via petgraph)
        if let Err(cycle_node) = self.build_dependency_graph() {
            errors.push(ConfigError::DependencyCycle { node: cycle_node });
        }

        if errors.is_empty() { Ok(()) } else { Err(errors) }
    }
}
```

### 4. Dependency Graph Resolution

Build a directed graph with petgraph. Edges point from dependency to dependent (so topological sort yields start order):

```rust
use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::algo::toposort;

pub struct DependencyResolver {
    graph: DiGraph<String, ()>,
    node_map: BTreeMap<String, NodeIndex>,
}

impl DependencyResolver {
    pub fn from_config(config: &DevrigConfig) -> Result<Self, String> {
        let mut graph = DiGraph::new();
        let mut node_map = BTreeMap::new();

        // Add all services as nodes
        for name in config.services.keys() {
            let idx = graph.add_node(name.clone());
            node_map.insert(name.clone(), idx);
        }

        // Add dependency edges
        for (name, svc) in &config.services {
            let dependent = node_map[name];
            for dep in &svc.depends_on {
                let dependency = node_map.get(dep)
                    .ok_or_else(|| format!("{} depends on unknown service {}", name, dep))?;
                // Edge from dependency -> dependent (dependency starts first)
                graph.add_edge(*dependency, dependent, ());
            }
        }

        Ok(Self { graph, node_map })
    }

    pub fn start_order(&self) -> Result<Vec<String>, String> {
        toposort(&self.graph, None)
            .map(|order| order.iter().map(|idx| self.graph[*idx].clone()).collect())
            .map_err(|cycle| format!(
                "Circular dependency detected involving '{}'",
                self.graph[cycle.node_id()]
            ))
    }

    /// Return groups of services that can start in parallel.
    /// Each group's dependencies are satisfied by all previous groups.
    pub fn parallel_start_groups(&self) -> Result<Vec<Vec<String>>, String> {
        let order = self.start_order()?;
        let mut groups: Vec<Vec<String>> = Vec::new();
        let mut started: HashSet<String> = HashSet::new();

        for name in &order {
            let svc = &self.node_map[name];
            let deps: Vec<String> = self.graph
                .neighbors_directed(*svc, petgraph::Direction::Incoming)
                .map(|n| self.graph[n].clone())
                .collect();

            // If all deps are in previous groups, can go in current group
            let all_deps_started = deps.iter().all(|d| started.contains(d));
            if all_deps_started && !groups.is_empty() {
                groups.last_mut().unwrap().push(name.clone());
            } else {
                groups.push(vec![name.clone()]);
            }
            started.insert(name.clone());
        }

        groups
    }
}
```

**Parallel start groups** are the key optimization: services with no dependencies on each other can start simultaneously, similar to how turborepo executes independent tasks in parallel.

### 5. Project Identity

```rust
use sha2::{Sha256, Digest};
use std::path::Path;

pub struct ProjectIdentity {
    pub name: String,
    pub id: String,       // 8-char hex hash
    pub slug: String,     // "{name}-{id}"
    pub config_path: PathBuf,
}

impl ProjectIdentity {
    pub fn from_config(config: &DevrigConfig, config_path: &Path) -> anyhow::Result<Self> {
        let canonical = config_path.canonicalize()?;
        let canonical_str = canonical.to_string_lossy();

        let mut hasher = Sha256::new();
        hasher.update(canonical_str.as_bytes());
        let result = hasher.finalize();
        let id = hex::encode(&result[..4]); // 8 hex chars

        let name = config.project.name.clone();
        let slug = format!("{}-{}", name, id);

        Ok(Self {
            name,
            id,
            slug,
            config_path: canonical,
        })
    }
}
```

### 6. Directory-Aware Config Discovery

```rust
pub fn find_config(start: &Path, filename: &str) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        let candidate = current.join(filename);
        if candidate.is_file() {
            return Some(candidate);
        }
        if !current.pop() {
            return None; // reached filesystem root
        }
    }
}

pub fn resolve_config(cli_file: Option<&Path>) -> anyhow::Result<PathBuf> {
    match cli_file {
        Some(path) => {
            if path.is_file() {
                Ok(path.to_path_buf())
            } else {
                anyhow::bail!("Config file not found: {}", path.display())
            }
        }
        None => {
            let cwd = std::env::current_dir()?;
            find_config(&cwd, "devrig.toml").ok_or_else(|| {
                anyhow::anyhow!(
                    "No devrig.toml found in {} or any parent directory",
                    cwd.display()
                )
            })
        }
    }
}
```

**Pitfall:** `PathBuf::pop()` returns `false` at the filesystem root — this is the loop termination condition. Canonicalize the start path first to avoid symlink loops.

### 7. Process Management Architecture

Use one spawned tokio task per child process, with a centralized orchestrator communicating via channels:

```
Orchestrator (main task)
  ├── CancellationToken (shared)
  ├── TaskTracker (tracks all supervisor tasks)
  ├── mpsc::Sender<LogLine> (for unified log output)
  │
  ├── ServiceSupervisor("api")
  │     ├── Owns Child process handle
  │     ├── Reads stdout/stderr -> sends to log channel
  │     ├── Monitors exit -> restart with backoff
  │     └── Listens for CancellationToken
  │
  ├── ServiceSupervisor("web")
  │     └── (same structure)
  │
  └── LogWriter (single consumer)
        └── Reads from mpsc::Receiver<LogLine>
        └── Formats with color prefix and writes to stdout
```

**Process group management is critical.** When devrig starts `cargo watch -x run`, that command spawns child processes. To kill the entire tree:

```rust
let mut child = Command::new(&service.command)
    .process_group(0)       // Create new process group
    .kill_on_drop(true)     // Safety net
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()?;

// On shutdown: kill the entire process group
let pid = child.id().unwrap() as i32;
nix::sys::signal::killpg(
    nix::unistd::Pid::from_raw(pid),
    nix::sys::signal::Signal::SIGTERM
).ok();
```

`.process_group(0)` is Unix-only (available since tokio 1.24). It creates a new process group with the child as leader, so `killpg()` kills the entire tree.

### 8. Signal Handling and Graceful Shutdown

```rust
use tokio::signal;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

async fn run(config: DevrigConfig, identity: ProjectIdentity) -> anyhow::Result<()> {
    let token = CancellationToken::new();
    let tracker = TaskTracker::new();

    // Spawn service supervisors (in dependency order)
    let resolver = DependencyResolver::from_config(&config)?;
    for name in resolver.start_order()? {
        let svc = &config.services[&name];
        let token = token.clone();
        tracker.spawn(supervise_service(name, svc.clone(), token));
    }

    // Wait for shutdown signal
    tokio::select! {
        _ = signal::ctrl_c() => {
            eprintln!("\nShutting down...");
        }
        _ = async {
            tracker.close();
            tracker.wait().await;
        } => {
            eprintln!("All services exited");
        }
    }

    // Graceful shutdown
    token.cancel();
    tracker.close();
    let timeout = tokio::time::Duration::from_secs(10);
    match tokio::time::timeout(timeout, tracker.wait()).await {
        Ok(()) => eprintln!("All services stopped cleanly"),
        Err(_) => eprintln!("Shutdown timed out — some processes may have been force-killed"),
    }

    Ok(())
}
```

**Signals to handle:** SIGINT (Ctrl+C), SIGTERM (for when devrig is managed by another tool). Both trigger the same graceful shutdown sequence.

### 9. Colored Log Multiplexing

Foreman-style pattern: each service gets a color-coded prefix, all output goes through a single mpsc channel to prevent line interleaving.

```rust
use tokio::sync::mpsc;

struct LogLine {
    service: String,
    text: String,
    is_stderr: bool,
}

const COLORS: &[&str] = &[
    "\x1b[36m",  // Cyan
    "\x1b[33m",  // Yellow
    "\x1b[32m",  // Green
    "\x1b[35m",  // Magenta
    "\x1b[34m",  // Blue
    "\x1b[31m",  // Red
];
const RESET: &str = "\x1b[0m";

async fn log_writer(mut rx: mpsc::Receiver<LogLine>, max_name_len: usize) {
    let mut color_map: BTreeMap<String, usize> = BTreeMap::new();
    let mut next_color = 0;

    while let Some(line) = rx.recv().await {
        let color_idx = *color_map.entry(line.service.clone()).or_insert_with(|| {
            let idx = next_color;
            next_color = (next_color + 1) % COLORS.len();
            idx
        });

        println!(
            "{}{:>width$} |{} {}",
            COLORS[color_idx],
            line.service,
            RESET,
            line.text,
            width = max_name_len,
        );
    }
}
```

**Key design decisions:**
- Single consumer pattern via `mpsc` channel prevents line interleaving without holding a mutex across async boundaries
- Right-pad all service names to the longest name length for column alignment
- Assign colors by insertion order, cycling through the palette
- Detect TTY with `is-terminal` crate and disable ANSI codes when piping to a file

### 10. Port Collision Detection

```rust
use std::net::TcpListener;

pub fn check_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub fn find_free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .expect("failed to bind ephemeral port")
        .local_addr()
        .unwrap()
        .port()
}

pub fn check_all_ports(services: &BTreeMap<String, ServiceConfig>) -> Vec<PortConflict> {
    let mut conflicts = Vec::new();
    for (name, svc) in services {
        if let Some(Port::Fixed(port)) = &svc.port {
            if !check_port_available(*port) {
                conflicts.push(PortConflict {
                    service: name.clone(),
                    port: *port,
                    owner: identify_port_owner(*port),
                });
            }
        }
    }
    conflicts
}
```

For identifying which devrig project owns a conflicting port, the approach depends on the milestone:
- **v0.1 (local processes only):** Parse `/proc/net/tcp` to find the PID, then read `/proc/{pid}/cmdline` to identify the process
- **v0.2+ (with Docker):** Also query Docker labels (`devrig.project`) via bollard to identify devrig-managed containers

### 11. Crash Recovery with Exponential Backoff

```rust
use std::time::{Duration, Instant};

pub struct RestartPolicy {
    pub max_restarts: u32,
    pub initial_delay: Duration,
    pub max_delay: Duration,
    pub reset_after: Duration,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            max_restarts: 10,
            initial_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(30),
            reset_after: Duration::from_secs(60),
        }
    }
}

async fn supervise_service(
    name: String,
    config: ServiceConfig,
    cancel: CancellationToken,
) {
    let policy = RestartPolicy::default();
    let mut restart_count: u32 = 0;

    loop {
        let start_time = Instant::now();
        let mut child = spawn_service(&name, &config).await.unwrap();

        tokio::select! {
            status = child.wait() => {
                let runtime = start_time.elapsed();

                // Reset counter if process ran long enough
                if runtime > policy.reset_after {
                    restart_count = 0;
                }

                if restart_count >= policy.max_restarts {
                    tracing::error!("{}: exceeded max restarts ({})", name, policy.max_restarts);
                    break;
                }

                // Equal jitter backoff
                let base_ms = policy.initial_delay.as_millis() as f64
                    * 2_f64.powi(restart_count as i32);
                let capped_ms = base_ms.min(policy.max_delay.as_millis() as f64);
                let half = capped_ms / 2.0;
                let jitter = rand::random::<f64>() * half;
                let delay = Duration::from_millis((half + jitter) as u64);

                restart_count += 1;
                tracing::warn!(
                    "{}: exited with {:?}, restarting in {:?} (attempt {}/{})",
                    name, status, delay, restart_count, policy.max_restarts
                );

                tokio::time::sleep(delay).await;
            }
            _ = cancel.cancelled() => {
                // Graceful shutdown: SIGTERM the process group
                if let Some(pid) = child.id() {
                    let _ = nix::sys::signal::killpg(
                        nix::unistd::Pid::from_raw(pid as i32),
                        nix::sys::signal::Signal::SIGTERM,
                    );
                }
                let _ = tokio::time::timeout(
                    Duration::from_secs(5),
                    child.wait(),
                ).await;
                break;
            }
        }
    }
}
```

**Equal jitter** (delay = base/2 + random(0, base/2)) is recommended over full jitter for process restart because you always want at least some minimum delay before restarting a crashed process.

### 12. Startup Summary Display

```rust
fn print_startup_summary(identity: &ProjectIdentity, services: &BTreeMap<String, RunningService>) {
    println!();
    println!("  devrig \u{26a1} {} ({})", identity.name, identity.id);
    println!();
    println!("  Services");

    for (name, svc) in services {
        let url = svc.port.map(|p| format!("http://localhost:{}", p))
            .unwrap_or_default();
        let auto_tag = if svc.port_auto { " (auto)" } else { "" };
        println!(
            "    {:<12} {:<30}{} \u{25cf} running",
            name, format!("{}{}", url, auto_tag), ""
        );
    }

    println!();
    println!("  Press Ctrl+C to stop all services");
    println!();
}
```

### 13. Template Interpolation (Lightweight)

Use a regex-based approach that resolves `{{ path.to.value }}` expressions against the config:

```rust
use regex::Regex;

pub fn interpolate(
    template: &str,
    vars: &BTreeMap<String, String>,
) -> Result<String, Vec<String>> {
    let re = Regex::new(r"\{\{\s*([\w.]+)\s*\}\}").unwrap();
    let mut missing = Vec::new();

    let result = re.replace_all(template, |caps: &regex::Captures| {
        let key = &caps[1];
        match vars.get(key) {
            Some(val) => val.clone(),
            None => {
                missing.push(key.to_string());
                caps[0].to_string()
            }
        }
    });

    if missing.is_empty() {
        Ok(result.into_owned())
    } else {
        Err(missing)
    }
}
```

For v0.1, template expressions are limited to `{{ services.<name>.port }}` references. Full interpolation with `{{ infra.<name>.port }}` comes in v0.2.

---

## Implementation Strategy

### Feature 1: Parse devrig.toml with [project], [services.*], [env]

**Approach:** Define a `DevrigConfig` struct hierarchy with serde derive. Use `BTreeMap<String, ServiceConfig>` for the services table. Use a custom `Port` type with a serde Visitor for `port = 5432 | "auto"`.

**Key decisions:**
- Use `BTreeMap` over `HashMap` for deterministic iteration (matches Cargo's pattern)
- Use `#[serde(default)]` on all optional fields/sections
- Parse in two phases: (1) deserialize TOML → struct, (2) validate cross-field constraints
- Return all validation errors at once, not just the first

**Files:**
- `src/config/mod.rs` — Re-exports, `load_config()` entry point
- `src/config/model.rs` — Struct definitions (`DevrigConfig`, `ProjectConfig`, `ServiceConfig`, `Port`)
- `src/config/validate.rs` — Post-parse validation logic
- `src/config/resolve.rs` — Config file discovery, path resolution

### Feature 2: -f flag for alternate config files

**Approach:** Add `-f` / `--file` as a global clap argument. In the config resolution logic, if `-f` is provided, use that path directly (error if not found). If not provided, walk up from CWD looking for `devrig.toml`.

**Files:**
- `src/cli.rs` — Clap struct with global `-f` option
- `src/config/resolve.rs` — `resolve_config(cli_file: Option<&Path>)` function

### Feature 3: Project identity (name + path hash)

**Approach:** SHA-256 hash of the canonical config file path, truncated to 8 hex chars. The project slug is `{name}-{hash}`.

**Key decisions:**
- Canonicalize the path first (`std::fs::canonicalize`) to ensure stability
- Use SHA-256 (not Rust's DefaultHasher which is non-deterministic)
- 8 hex chars = 32 bits of entropy, sufficient for local collision avoidance

**Files:**
- `src/identity.rs` — `ProjectIdentity` struct and `from_config()` constructor

### Feature 4: Directory-aware config discovery

**Approach:** Starting from CWD, check for `devrig.toml` in each directory, walking up via `PathBuf::pop()` until either found or at filesystem root.

**Key decisions:**
- `pop()` returns `false` at root — this is the loop termination
- Canonicalize start path to avoid symlink loops
- Clear error message: "No devrig.toml found in {cwd} or any parent directory"

**Files:**
- `src/config/resolve.rs` — `find_config()` function

### Feature 5: devrig start / stop / delete

**Approach:**
- **start:** Parse config → validate → resolve dependencies → check ports → spawn processes in order → print summary → enter watch mode
- **stop:** Send CancellationToken → SIGTERM to process groups → wait with timeout → SIGKILL survivors → write state
- **delete:** stop + remove `.devrig/state.json`

**Architecture:**
```
Orchestrator
  ├── parse_and_validate(config_path) -> DevrigConfig
  ├── resolve_identity(config) -> ProjectIdentity
  ├── check_ports(config) -> Result<(), Vec<PortConflict>>
  ├── start_services(config, identity) -> RunningState
  │     Uses TaskTracker + CancellationToken
  │     Spawns ServiceSupervisor per service
  ├── print_summary(identity, running_state)
  └── wait_for_shutdown(cancel_token, tracker)
```

**Files:**
- `src/orchestrator/mod.rs` — `Orchestrator` struct, main start/stop/delete logic
- `src/orchestrator/supervisor.rs` — `ServiceSupervisor` per-process management
- `src/orchestrator/state.rs` — `.devrig/state.json` read/write

### Feature 6: Startup summary

**Approach:** After all services are started and confirmed running (via port check), print a formatted summary with service names, URLs, ports, auto-port indicators, and status.

**Files:**
- `src/ui/summary.rs` — `print_startup_summary()` function

### Feature 7: Port collision detection

**Approach:** Before starting any service, check all fixed ports with `TcpListener::bind()`. If any fail, try to identify the owner (via `/proc/net/tcp` + `/proc/{pid}/cmdline` on Linux). Report all conflicts at once with actionable error messages.

**Key decisions:**
- Check all ports before starting anything (fail fast)
- On Linux, identify the conflicting process for better error messages
- TOCTOU race is acceptable — the actual bind will also fail with a clear error

**Files:**
- `src/orchestrator/ports.rs` — `check_all_ports()`, `identify_port_owner()`

### Feature 8: Dependency ordering with depends_on

**Approach:** Build a `petgraph::DiGraph`, run `toposort()`. If cycle detected, report the involved node. Start services in topological order — for v0.1, sequential start is sufficient. Parallel start groups are a v0.4 optimization.

**Files:**
- `src/orchestrator/graph.rs` — `DependencyResolver` struct

### Feature 9: Unified colored log output

**Approach:** Each `ServiceSupervisor` captures stdout/stderr via `tokio::io::BufReader`, wraps in `LinesStream`, merges them, and sends each line through an `mpsc` channel. A single `LogWriter` task consumes the channel and prints with colored service prefixes.

**Key decisions:**
- Use `mpsc` channel (not mutex) to prevent line interleaving across async boundaries
- Right-pad service names to max length for column alignment
- Cycle through 6 ANSI colors by service index
- Disable colors when stdout is not a TTY (`is-terminal` crate)

**Files:**
- `src/ui/logs.rs` — `LogLine`, `LogWriter`, color palette

### Feature 10: devrig ps / ps --all

**Approach:**
- `devrig ps` — Read `.devrig/state.json` for current project, check if processes are still running
- `devrig ps --all` — In v0.1 (no Docker), scan for `.devrig/state.json` files in known locations or check running processes. In v0.2+, also query Docker labels.

**Key decisions:**
- For v0.1, `ps --all` is limited because without Docker labels, cross-project discovery requires a global registry. Consider a simple file-based registry at `~/.devrig/instances.json` that tracks known project paths.

**Files:**
- `src/commands/ps.rs` — `ps` and `ps --all` implementation
- `src/orchestrator/registry.rs` — Global instance registry

### Feature 11: devrig init

**Approach:** Interactive prompts to generate a starter `devrig.toml`. Ask for project name, detect common project types (Cargo.toml → Rust, package.json → Node), offer to add service stubs.

**Files:**
- `src/commands/init.rs` — Interactive scaffolding

### Feature 12: devrig doctor

**Approach:** Check for required dependencies and report their status. For v0.1: just check that common tools are in PATH (docker, k3d, etc.) with version info.

**Files:**
- `src/commands/doctor.rs` — Dependency checker

---

## Testing Strategy

### Test Organization

```
src/
  config/
    mod.rs
    model.rs        (unit tests inline)
    validate.rs     (unit tests inline)
    resolve.rs      (unit tests inline)
  orchestrator/
    graph.rs        (unit tests inline)
  identity.rs       (unit tests inline)

tests/
  common/
    mod.rs          # ProcessGuard, port helpers, config builders
  cli_test.rs       # assert_cmd tests for CLI interface
  config_test.rs    # Full config parse → validate integration
  graph_test.rs     # Dependency graph edge cases
  identity_test.rs  # Project identity hash stability

  integration/      # Gated behind --features integration
    start_stop.rs
    config_file_flag.rs
    crash_recovery.rs
    port_collision.rs
    multi_instance.rs
    ps_all.rs
    dir_discovery.rs
    label_cleanup.rs
```

### Unit Test Patterns

**Config parsing tests (inline):**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_minimal_config() {
        let toml = r#"
            [project]
            name = "test"
        "#;
        let config: DevrigConfig = toml::from_str(toml).unwrap();
        assert_eq!(config.project.name, "test");
        assert!(config.services.is_empty());
    }

    #[test]
    fn parse_port_fixed() {
        let toml = r#"
            [project]
            name = "test"
            [services.api]
            command = "echo hi"
            port = 3000
        "#;
        let config: DevrigConfig = toml::from_str(toml).unwrap();
        assert!(matches!(config.services["api"].port, Some(Port::Fixed(3000))));
    }

    #[test]
    fn parse_port_auto() {
        let toml = r#"
            [project]
            name = "test"
            [services.api]
            command = "echo hi"
            port = "auto"
        "#;
        let config: DevrigConfig = toml::from_str(toml).unwrap();
        assert!(matches!(config.services["api"].port, Some(Port::Auto)));
    }

    #[test]
    fn parse_port_invalid_string() {
        let toml = r#"
            [project]
            name = "test"
            [services.api]
            command = "echo hi"
            port = "invalid"
        "#;
        assert!(toml::from_str::<DevrigConfig>(toml).is_err());
    }

    #[test]
    fn validate_missing_dependency() {
        let toml = r#"
            [project]
            name = "test"
            [services.api]
            command = "echo hi"
            depends_on = ["nonexistent"]
        "#;
        let config: DevrigConfig = toml::from_str(toml).unwrap();
        let errors = config.validate().unwrap_err();
        assert!(errors.iter().any(|e| matches!(e, ConfigError::MissingDependency { .. })));
    }

    #[test]
    fn validate_duplicate_ports() {
        let toml = r#"
            [project]
            name = "test"
            [services.api]
            command = "echo hi"
            port = 3000
            [services.web]
            command = "echo hi"
            port = 3000
        "#;
        let config: DevrigConfig = toml::from_str(toml).unwrap();
        let errors = config.validate().unwrap_err();
        assert!(errors.iter().any(|e| matches!(e, ConfigError::DuplicatePort { .. })));
    }
}
```

**Dependency graph tests:**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_dependency_chain() {
        // a -> b -> c (a depends on b, b depends on c)
        // Start order: c, b, a
        let config = make_config(vec![
            ("a", vec!["b"]),
            ("b", vec!["c"]),
            ("c", vec![]),
        ]);
        let resolver = DependencyResolver::from_config(&config).unwrap();
        let order = resolver.start_order().unwrap();
        assert_before(&order, "c", "b");
        assert_before(&order, "b", "a");
    }

    #[test]
    fn diamond_dependency() {
        // d depends on b and c; b and c depend on a
        let config = make_config(vec![
            ("d", vec!["b", "c"]),
            ("b", vec!["a"]),
            ("c", vec!["a"]),
            ("a", vec![]),
        ]);
        let resolver = DependencyResolver::from_config(&config).unwrap();
        let order = resolver.start_order().unwrap();
        assert_before(&order, "a", "b");
        assert_before(&order, "a", "c");
        assert_before(&order, "b", "d");
        assert_before(&order, "c", "d");
    }

    #[test]
    fn cycle_detected() {
        let config = make_config(vec![
            ("a", vec!["b"]),
            ("b", vec!["c"]),
            ("c", vec!["a"]),
        ]);
        let resolver = DependencyResolver::from_config(&config).unwrap();
        assert!(resolver.start_order().is_err());
    }

    #[test]
    fn self_loop_detected() {
        let config = make_config(vec![
            ("a", vec!["a"]),
        ]);
        let resolver = DependencyResolver::from_config(&config).unwrap();
        assert!(resolver.start_order().is_err());
    }

    #[test]
    fn no_dependencies() {
        let config = make_config(vec![
            ("a", vec![]),
            ("b", vec![]),
            ("c", vec![]),
        ]);
        let resolver = DependencyResolver::from_config(&config).unwrap();
        let order = resolver.start_order().unwrap();
        assert_eq!(order.len(), 3);
    }

    #[test]
    fn empty_config() {
        let config = make_config(vec![]);
        let resolver = DependencyResolver::from_config(&config).unwrap();
        assert!(resolver.start_order().unwrap().is_empty());
    }

    fn assert_before(order: &[String], a: &str, b: &str) {
        let pos_a = order.iter().position(|x| x == a).unwrap();
        let pos_b = order.iter().position(|x| x == b).unwrap();
        assert!(pos_a < pos_b, "{} should come before {} in {:?}", a, b, order);
    }
}
```

**Project identity hash tests:**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_deterministic() {
        let path = Path::new("/tmp/test-devrig/devrig.toml");
        let id1 = compute_project_id(path);
        let id2 = compute_project_id(path);
        assert_eq!(id1, id2);
    }

    #[test]
    fn hash_is_8_hex_chars() {
        let path = Path::new("/tmp/test-devrig/devrig.toml");
        let id = compute_project_id(path);
        assert_eq!(id.len(), 8);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn different_paths_produce_different_hashes() {
        let id1 = compute_project_id(Path::new("/tmp/project-a/devrig.toml"));
        let id2 = compute_project_id(Path::new("/tmp/project-b/devrig.toml"));
        assert_ne!(id1, id2);
    }

    #[test]
    fn slug_format() {
        let identity = ProjectIdentity {
            name: "myapp".to_string(),
            id: "a3f1c9e2".to_string(),
            slug: "myapp-a3f1c9e2".to_string(),
            config_path: PathBuf::from("/test"),
        };
        assert_eq!(identity.slug, "myapp-a3f1c9e2");
    }
}
```

### Integration Test Patterns

**Test helper module (`tests/common/mod.rs`):**

```rust
use tempfile::TempDir;
use std::path::PathBuf;
use std::net::TcpListener;

pub struct TestProject {
    pub dir: TempDir,
    pub config_path: PathBuf,
}

impl TestProject {
    pub fn new(config_toml: &str) -> Self {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("devrig.toml");
        std::fs::write(&config_path, config_toml).unwrap();
        Self { dir, config_path }
    }
}

pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap()
        .local_addr().unwrap().port()
}

pub fn free_ports(count: usize) -> Vec<u16> {
    let listeners: Vec<_> = (0..count)
        .map(|_| TcpListener::bind("127.0.0.1:0").unwrap())
        .collect();
    let ports: Vec<_> = listeners.iter()
        .map(|l| l.local_addr().unwrap().port())
        .collect();
    drop(listeners);
    ports
}

pub async fn wait_for_port(port: u16, timeout: std::time::Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port)).await.is_ok() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    false
}
```

**Lifecycle integration test pattern:**

```rust
#![cfg(feature = "integration")]

mod common;
use common::*;

#[tokio::test]
async fn test_start_stop_lifecycle() {
    let port = free_port();
    let project = TestProject::new(&format!(r#"
        [project]
        name = "test-lifecycle"
        [services.echo]
        command = "python3 -m http.server {port}"
        port = {port}
    "#));

    // Start
    let rig = DevRig::from_config(project.config_path.clone()).await.unwrap();
    rig.start().await.unwrap();

    // Verify running
    assert!(wait_for_port(port, Duration::from_secs(10)).await,
        "Service did not become reachable on port {port}");

    // Stop
    rig.stop().await.unwrap();

    // Verify stopped
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(tokio::net::TcpStream::connect(format!("127.0.0.1:{port}")).await.is_err(),
        "Service still running after stop");
}
```

**Multi-instance isolation test:**

```rust
#[tokio::test]
async fn test_two_projects_no_crosstalk() {
    let ports = free_ports(2);
    let project_a = TestProject::new(&format!(r#"
        [project]
        name = "project-a"
        [services.web]
        command = "python3 -m http.server {}"
        port = {}
    "#, ports[0], ports[0]));

    let project_b = TestProject::new(&format!(r#"
        [project]
        name = "project-b"
        [services.web]
        command = "python3 -m http.server {}"
        port = {}
    "#, ports[1], ports[1]));

    let rig_a = DevRig::from_config(project_a.config_path.clone()).await.unwrap();
    let rig_b = DevRig::from_config(project_b.config_path.clone()).await.unwrap();

    rig_a.start().await.unwrap();
    rig_b.start().await.unwrap();

    // Both running independently
    assert!(wait_for_port(ports[0], Duration::from_secs(10)).await);
    assert!(wait_for_port(ports[1], Duration::from_secs(10)).await);

    // Stop A, B still running
    rig_a.stop().await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(tokio::net::TcpStream::connect(format!("127.0.0.1:{}", ports[0])).await.is_err());
    assert!(wait_for_port(ports[1], Duration::from_secs(1)).await);

    rig_b.stop().await.unwrap();
}
```

### Feature-Gated Integration Tests

```toml
# Cargo.toml
[features]
default = []
integration = []
```

```rust
// tests/integration/start_stop.rs
#![cfg(feature = "integration")]
// ... integration tests ...
```

```bash
# Run unit tests only (fast, no Docker)
cargo test

# Run integration tests (require real processes)
cargo test --features integration

# Run all tests
cargo test --all-features
```

### Key Testing Invariants

1. **Every `start` test has a matching `stop` and cleanup assertion** — ports released, processes gone
2. **Every test uses unique ports** — `free_port()` prevents collisions between parallel tests
3. **Every test uses unique temp directories** — `TempDir::new()` provides unique project paths and hashes
4. **TempDir cleanup works even on panic** — Rust's Drop trait runs during unwinding (default for tests)
5. **`kill_on_drop(true)`** on all spawned processes as a safety net

---

## Risks and Considerations

### Risk 1: Process Group Killing on macOS vs Linux

`.process_group(0)` and `killpg()` behave slightly differently across platforms. On macOS, process groups work the same way but some edge cases around orphaned processes differ. The `nix` crate provides a portable wrapper, but testing must cover both platforms.

**Mitigation:** Test on both Linux and macOS in CI. Use `kill_on_drop(true)` as a safety net for any process that escapes group termination.

### Risk 2: TOCTOU Race in Port Detection

Checking port availability with `TcpListener::bind()` and then starting a service on that port has a race window. Another process could claim the port between check and use.

**Mitigation:** Accept the race for fixed ports (the actual service bind will fail with a clear error). For `port = "auto"`, bind the port first to reserve it, pass the port number to the service, then release the binding right before the service starts.

### Risk 3: Zombie Processes on Unexpected Exit

If devrig crashes or is SIGKILLed, child processes become orphans. Process groups help (the kernel sends SIGHUP to orphaned process groups) but this is not guaranteed.

**Mitigation:**
- `.kill_on_drop(true)` on all child processes
- `.process_group(0)` to ensure `killpg` can clean up the tree
- `devrig doctor` or `devrig ps` can detect orphaned processes from previous runs
- State file (`.devrig/state.json`) records PIDs for manual cleanup

### Risk 4: Cross-Platform Compatibility

`process_group(0)`, `killpg()`, and `/proc/net/tcp` are Linux/Unix-specific. Windows support would require different approaches.

**Mitigation:** v0.1 targets Linux and macOS only. Use `#[cfg(unix)]` guards on platform-specific code. Windows support can be added later with `windows-sys` crate for job objects (Windows equivalent of process groups).

### Risk 5: Template Interpolation Complexity

The PRD specifies `{{ services.api.port }}` and `{{ infra.postgres.port }}` expressions. In v0.1, only services exist, but the template system needs to be designed with infra in mind.

**Mitigation:** Implement a flat key-value resolver where keys are dot-separated paths like `services.api.port`. Build the variable map after all ports are resolved (including auto-assigned). This is simple, extensible, and avoids the complexity of a full template engine.

### Risk 6: `ps --all` Discovery Without Docker Labels

In v0.1 (no Docker), cross-project discovery is harder. Docker labels provide natural discovery in v0.2+, but v0.1 needs an alternative.

**Mitigation:** Use a simple file-based registry at `~/.devrig/instances.json` that records `{slug, config_path, pids, started_at}` for each running instance. Clean up stale entries on `devrig ps --all` by checking if PIDs are still alive.

### Risk 7: Config Validation Error Quality

TOML parse errors from serde are often cryptic ("expected table, found string at line 42"). Users editing config by hand need better feedback.

**Mitigation:** Use `miette` for rich diagnostic output with source spans. The `toml` crate's error type includes `.span()` which provides byte offsets. Convert these to miette `SourceSpan` for pointing at the exact location in the file.

### Risk 8: Test Parallelism

Integration tests that spawn real processes and bind ports can interfere with each other when run in parallel.

**Mitigation:** Every test uses `free_port()` for unique port allocation and `TempDir::new()` for unique project paths (which produce unique project identity hashes). No shared state between tests. Consider `--test-threads=1` for integration tests if port contention proves problematic, though the dynamic port approach should avoid this.

### Risk 9: Signal Handling Edge Cases

`tokio::signal::ctrl_c()` replaces the default OS signal handler. Once installed, the process will NOT terminate on Ctrl+C unless the handler explicitly initiates shutdown.

**Mitigation:** Always handle the signal by cancelling the CancellationToken and running the graceful shutdown sequence. Set a hard timeout (e.g., 10 seconds) after which `std::process::exit(1)` is called to prevent hangs. Consider handling a second Ctrl+C as a force-quit.

### Risk 10: Startup Order vs Parallel Start

v0.1 starts services sequentially in topological order. This is correct but slow for configs with many independent services.

**Mitigation:** Sequential start is fine for v0.1. The `parallel_start_groups()` method on `DependencyResolver` is designed for v0.4 when we optimize startup performance. The architecture supports both without refactoring.

---

## Current Codebase State

The project root at `/home/steve/fj/devrig` currently contains:

- **No Rust code** — No `Cargo.toml`, no `src/` directory. The Rust project needs to be initialized from scratch.
- **`PRD.md`** (1316 lines) — Comprehensive product requirements document
- **`README.md`** — Brief 3-line project description
- **`pipeline/`** — TypeScript-based AI build pipeline (using Bun + Claude Agent SDK) that drives the milestone implementation process
- **`pipeline/agent-data/milestones.json`** — Parsed PRD with 6 milestones
- **`.gitignore`** — Covers `.devrig/`, `pipeline/agent-data/`, `node_modules/`
- **2 git commits** on `main` branch

The Rust project must be bootstrapped with `cargo init` as the first step of implementation.

---

## References

### Crate Documentation
- [clap 4.5 — Derive Tutorial](https://docs.rs/clap/latest/clap/_derive/_tutorial/index.html)
- [tokio — Process Module](https://docs.rs/tokio/latest/tokio/process/index.html)
- [tokio — Graceful Shutdown Guide](https://tokio.rs/tokio/topics/shutdown)
- [tokio — Unit Testing](https://tokio.rs/tokio/topics/testing)
- [serde — Enum Representations](https://serde.rs/enum-representations.html)
- [serde — Container Attributes](https://serde.rs/container-attrs.html)
- [toml 1.0 — docs.rs](https://docs.rs/toml/latest/toml/)
- [petgraph — toposort](https://docs.rs/petgraph/latest/petgraph/algo/fn.toposort.html)
- [bollard — Docker Engine API client](https://docs.rs/bollard/latest/bollard/)
- [miette — Diagnostic library](https://docs.rs/miette/latest/miette/)
- [nix — POSIX APIs](https://docs.rs/nix/latest/nix/)
- [owo-colors — Terminal colors](https://docs.rs/owo-colors/latest/owo_colors/)

### Design Pattern References
- [Rain's Rust CLI Recommendations](https://rust-cli-recommendations.sunshowers.io/)
- [Command Line Applications in Rust (official book)](https://rust-cli.github.io/book/)
- [Beyond Ctrl-C: Signal Handling in Rust](https://sunshowers.io/posts/beyond-ctrl-c-signals/)
- [RFC 3228: process_group](https://rust-lang.github.io/rfcs/3228-process-process_group.html)
- [Turborepo Package and Task Graphs](https://turborepo.dev/docs/core-concepts/package-and-task-graph)
- [Docker Compose Project Isolation](https://docs.docker.com/compose/how-tos/project-name/)

### Testing References
- [Testing Rust CLI Apps with assert_cmd](https://alexwlchan.net/2025/testing-rust-cli-apps-with-assert-cmd/)
- [Rust CLI Book — Testing Chapter](https://rust-cli.github.io/book/tutorial/testing.html)
- [bollard test suite](https://github.com/fussybeaver/bollard/tree/master/tests)
- [petgraph test suite](https://github.com/petgraph/petgraph/blob/master/tests/graph.rs)
- [testcontainers-rs](https://github.com/testcontainers/testcontainers-rs)

### Process Management References
- [Foreman — Process Manager (Ruby)](https://github.com/ddollar/foreman)
- [Overmind — Process Manager (Go)](https://github.com/DarthSim/overmind)
- [kill_tree crate](https://lib.rs/crates/kill_tree)
- [tokio-graceful-shutdown crate](https://docs.rs/tokio-graceful-shutdown)

### Hashing References
- [deterministic-hash crate](https://crates.io/crates/deterministic-hash)
- [The Stable HashMap Trap](https://morestina.net/1843/the-stable-hashmap-trap)
- [rustc-stable-hash](https://github.com/rust-lang/rustc-stable-hash)

### Config Parsing References
- [Cargo manifest parsing (rust-lang/cargo)](https://github.com/rust-lang/cargo/blob/master/src/cargo/util/toml/mod.rs)
- [cargo_toml crate](https://docs.rs/cargo_toml/latest/cargo_toml/)
- [Figment documentation](https://docs.rs/figment/latest/figment/)
- [eserde — Accumulating serde errors](https://crates.io/crates/eserde)
