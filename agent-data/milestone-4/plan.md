# Implementation Plan — v0.5: Observability + Dashboard

## Overview

Milestone v0.5 adds a built-in OpenTelemetry collector and web dashboard to devrig. This is the largest milestone yet — it introduces three new Rust modules (`otel`, `dashboard`, `query`), a SolidJS frontend application (`dashboard-ui/`), and a new orchestrator phase (Phase 4.5) that starts the dashboard and OTLP receivers before service spawning so that `OTEL_EXPORTER_OTLP_ENDPOINT` is available in service environment variables.

By the end of v0.5:
- `[dashboard]` and `[dashboard.otel]` config sections control the dashboard and OTLP receiver
- An in-process gRPC (port 4317) and HTTP (port 4318) OTLP receiver accepts traces, metrics, and logs
- All telemetry is stored in in-memory ring buffers with secondary indexes for efficient querying
- `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` are auto-injected into all services
- A SolidJS + Solid UI web dashboard serves overview, trace waterfall, metric charts, and structured log views
- Real-time updates flow to the browser via WebSocket
- `devrig query` CLI subcommands provide machine-readable JSON access to all telemetry data
- REST API endpoints mirror the CLI query capabilities
- Services can be started/stopped/restarted from the dashboard UI

---

## Architecture Overview

### New Module Structure

```
src/
  lib.rs                        # Add: otel, dashboard, query module declarations
  cli.rs                        # Add: Query subcommand with nested args
  config/
    model.rs                    # Add: DashboardConfig, OtelConfig
    validate.rs                 # Extend: dashboard/otel port conflict checks
    interpolate.rs              # Extend: dashboard.port, dashboard.otel.* template vars
  orchestrator/
    mod.rs                      # Insert Phase 4.5: dashboard + OTLP startup before services
    ports.rs                    # Extend: check dashboard/otel ports for conflicts
    state.rs                    # Extend: DashboardState in ProjectState
  otel/                         # NEW MODULE
    mod.rs                      # OtelCollector: start gRPC + HTTP, coordinate storage
    storage.rs                  # TelemetryStore: ring buffers + secondary indexes
    types.rs                    # StoredSpan, StoredLog, StoredMetric, internal types
    receiver_grpc.rs            # tonic TraceService/MetricsService/LogsService impl
    receiver_http.rs            # Axum handlers for /v1/traces, /v1/metrics, /v1/logs
    query.rs                    # Query engine: filter, search, correlate
  dashboard/                    # NEW MODULE
    mod.rs                      # DashboardServer: start Axum, configure routes
    routes/
      mod.rs                    # Route registration
      traces.rs                 # GET /api/traces, /api/traces/{trace_id}, /api/traces/{trace_id}/related
      metrics.rs                # GET /api/metrics
      logs.rs                   # GET /api/logs
      status.rs                 # GET /api/status
      env.rs                    # GET /api/env, /api/env/{service}
      services.rs               # POST /api/services/{name}/restart|stop|start
    ws.rs                       # WebSocket handler with broadcast subscription
    static_files.rs             # rust-embed SPA serving with fallback
  query/                        # NEW MODULE
    mod.rs                      # Re-exports
    output.rs                   # NDJSON, JSON-pretty, table formatters
  commands/
    mod.rs                      # Add: query module export
    query.rs                    # NEW: devrig query CLI handlers
  discovery/
    env.rs                      # Extend: inject OTEL_EXPORTER_OTLP_ENDPOINT + OTEL_SERVICE_NAME
  ui/
    summary.rs                  # Extend: show dashboard URL + OTLP endpoints
dashboard-ui/                   # NEW: SolidJS + Solid UI frontend
  src/
    index.tsx                   # App root, router setup
    App.tsx                     # Layout with sidebar
    components/
      ui/                       # Solid UI components (copy-paste from solidui-cli)
      Sidebar.tsx               # Navigation sidebar
      CommandPalette.tsx        # Cmd+K palette
      ThemeToggle.tsx           # Dark/light mode toggle
    views/
      Overview.tsx              # Service/infra status dashboard
      Traces.tsx                # Trace list + waterfall
      TraceDetail.tsx           # Span waterfall + detail panel
      Metrics.tsx               # Metric chart discovery + time-series
      Logs.tsx                  # Structured log viewer
    lib/
      ws.ts                     # WebSocket client with reconnection
      api.ts                    # REST API client functions
      store.ts                  # SolidJS store for telemetry state
      theme.ts                  # Dark/light mode management
    types/
      telemetry.ts              # TypeScript types matching Rust structs
  package.json
  vite.config.ts
  tsconfig.json
  tailwind.config.js
  postcss.config.js
e2e/                            # NEW: E2E test directory
  dashboard/
    overview.test.ts
    traces.test.ts
    metrics.test.ts
    logs.test.ts
    trace-correlation.test.ts
    cmd-k.test.ts
    dark-light.test.ts
    realtime.test.ts
  playwright.config.ts
  package.json
```

### Dependency Additions (Cargo.toml)

```toml
# Web server
axum = { version = "0.8", features = ["ws"] }
tower-http = { version = "0.6", features = ["cors", "compression-br"] }

# gRPC OTLP receiver
tonic = "0.12"
prost = "0.13"
prost-types = "0.13"
opentelemetry-proto = { version = "0.27", features = ["gen-tonic", "trace", "metrics", "logs", "with-serde"] }

# SPA embedding
rust-embed = { version = "8", features = ["compression"] }
mime_guess = "2"

# CLI duration parsing
humantime = "2"
```

**Version rationale:** tonic 0.12 + prost 0.13 + opentelemetry-proto 0.27 are the compatible set that works with hyper 1.x (shared with axum 0.8). Using tonic 0.14 + opentelemetry-proto 0.31 would be ideal per the research, but version compatibility between tonic and axum must be verified at build time. If 0.14/0.31 compiles cleanly with axum 0.8, prefer those. The step 1 build verification will determine the final versions.

### Phase Architecture Extension

The orchestrator startup pipeline gains Phase 4.5 between Phase 4 (Resolve & Inject) and Phase 5 (Services):

```
Phase 0: Parse & Validate
Phase 1: Network (create devrig-{slug}-net)
Phase 2: Compose
Phase 3: Infrastructure
Phase 3.5: Cluster
Phase 4: Resolve & Inject (ports, templates, DEVRIG_* vars)
Phase 4.5: Dashboard + OTLP Collector  ← NEW
  ├─ Create TelemetryStore (ring buffers + indexes)
  ├─ Create broadcast channel for TelemetryEvent (WebSocket push)
  ├─ Start OTLP gRPC receiver (port 4317)
  ├─ Start OTLP HTTP receiver (port 4318)
  ├─ Start Axum dashboard server (port 4000)
  │   ├─ REST API routes
  │   ├─ WebSocket endpoint
  │   └─ Embedded SPA static files
  └─ Record dashboard state (ports, URLs)
Phase 5: Services (with OTEL_EXPORTER_OTLP_ENDPOINT injected)
```

Phase 4.5 must come after Phase 4 (ports resolved) because the dashboard needs to know all resolved ports for the status endpoint. It must come before Phase 5 (services) so that `OTEL_EXPORTER_OTLP_ENDPOINT` points to a running OTLP receiver when services start.

### Shared State Architecture

The dashboard, OTLP receiver, REST API, WebSocket, and CLI query commands all need access to shared state:

```rust
#[derive(Clone)]
pub struct AppState {
    /// Telemetry storage (ring buffers + indexes)
    pub store: Arc<RwLock<TelemetryStore>>,
    /// Broadcast channel for real-time WebSocket push
    pub events_tx: broadcast::Sender<TelemetryEvent>,
    /// Project config (for status, env endpoints)
    pub config: Arc<DevrigConfig>,
    /// Project identity
    pub identity: Arc<ProjectIdentity>,
    /// Resolved ports (for env endpoint)
    pub resolved_ports: Arc<HashMap<String, u16>>,
    /// Service phase tracking (for overview status)
    pub service_phases: Arc<DashMap<String, String>>,
    /// Cancellation token for service management
    pub cancel: CancellationToken,
}
```

`AppState` is constructed in Phase 4.5 and shared across:
- OTLP gRPC receiver (writes to `store`, sends to `events_tx`)
- OTLP HTTP receiver (writes to `store`, sends to `events_tx`)
- Dashboard REST API (reads from `store`, `config`, `resolved_ports`)
- WebSocket handler (subscribes to `events_tx`)
- Service management endpoints (uses `cancel` token)

---

## Key Design Decisions

### 1. In-Memory Ring Buffer with Secondary Indexes

**Primary storage:** `VecDeque<T>` with manual capacity enforcement per the research recommendation. Each item gets a monotonic `u64` record ID for index cross-referencing.

**Secondary indexes for query performance:**
- `trace_index: HashMap<[u8; 16], Vec<u64>>` — trace ID → span record IDs
- `service_index: HashMap<String, Vec<u64>>` — service name → record IDs
- `time_index: BTreeMap<i64, Vec<u64>>` — timestamp (millis) → record IDs (range queries)
- `error_spans: HashSet<u64>` — spans with error status

**Concurrency:** `tokio::sync::RwLock<TelemetryStore>`. Multiple OTLP writers (gRPC + HTTP), multiple REST/WebSocket/CLI readers. Write locks are held briefly — only during insert + index update. Serialization and broadcast happen outside the lock.

**Eviction:** On insert, check if `items.len() >= max_capacity`. If so, `pop_front()` and clean all index entries for the evicted item. Additionally, a background sweeper runs every 30 seconds to evict items older than the retention window.

### 2. Two Separate Servers for gRPC and HTTP OTLP

The OTLP spec defines gRPC (port 4317) and HTTP (port 4318) as separate protocols. Running them on separate ports avoids content-type sniffing and HTTP/2-only mode complexity. Both write to the same `TelemetryStore` via `Arc`.

The gRPC server uses tonic's own transport. The HTTP OTLP receiver is a set of Axum handlers mounted at `/v1/traces`, `/v1/metrics`, `/v1/logs` on a second Axum server (port 4318). This second server is separate from the dashboard server (port 4000) to match the OTLP spec's standard port expectations.

### 3. Single Dashboard Axum Server

One Axum server on the dashboard port (default 4000) serves:
- REST API under `/api/*`
- WebSocket at `/api/ws`
- Embedded SPA static files as fallback

The SPA fallback rule: if path starts with `/api/`, route to API handlers. Otherwise, try to serve a matching embedded file. If no file matches, serve `index.html` (for client-side routing).

### 4. WebSocket Fan-Out via broadcast Channel

When telemetry is ingested, the OTLP receiver sends a `TelemetryEvent` to a `broadcast::channel`. Each WebSocket client task subscribes and forwards events to the browser. This is the same pattern used for the existing `LogLine` broadcast in the orchestrator.

Events are batched: the WebSocket handler collects events for up to 100ms before sending a batch message. This prevents overwhelming clients during high-throughput ingest.

```rust
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", content = "payload")]
pub enum TelemetryEvent {
    TraceUpdate { trace_id: String, service: String, duration_ms: u64, has_error: bool },
    LogRecord { trace_id: Option<String>, severity: String, body: String, service: String },
    MetricUpdate { name: String, value: f64, service: String },
    ServiceStatusChange { service: String, status: String },
}
```

### 5. CLI Query via REST API

`devrig query` commands make HTTP requests to `http://localhost:{dashboard_port}/api/...`. This avoids the CLI needing direct access to in-process storage (which would require IPC or shared memory). The dashboard must be running for query commands to work — if not, the CLI prints a clear error.

Output formats: NDJSON (default), `--format json-pretty`, `--format table` (via `comfy-table`).

### 6. Frontend Build Integration

The SolidJS frontend is built with Vite and embedded into the Rust binary via `rust-embed`. In debug mode, `rust-embed` reads from disk (supporting `npm run dev` for frontend development). In release mode, files are embedded at compile time.

The frontend build is NOT triggered automatically by `build.rs` — this would require Node.js for every `cargo build`. Instead, the frontend is pre-built and committed as `dashboard-ui/dist/`. A CI step or `make build-frontend` builds the frontend before `cargo build --release`.

Feature gate: `#[cfg(feature = "dashboard")]` guards the dashboard module. Users who don't need the dashboard can build without it (no Node.js or frontend assets required). Default features include `dashboard`.

### 7. OTLP Proto Type Conversion

OpenTelemetry proto types (from `opentelemetry-proto`) are converted to internal `StoredSpan`, `StoredLog`, `StoredMetric` types on ingest. The internal types:
- Extract `service.name` from `Resource.attributes`
- Convert trace/span IDs from `Vec<u8>` to hex strings
- Convert timestamps from proto nanos to `chrono::DateTime<Utc>`
- Store a subset of attributes (first N key-value pairs) to control memory

### 8. Service Management from UI

REST endpoints for service management (`POST /api/services/{name}/restart|stop|start`) signal the orchestrator via an `mpsc` channel. The orchestrator's main loop selects on this channel alongside the shutdown signal. This avoids sharing the full orchestrator struct — only a lightweight command channel is exposed.

```rust
pub enum ServiceCommand {
    Restart(String),
    Stop(String),
    Start(String),
}
```

For v0.5, the implementation is limited to restart (cancel the supervisor task + respawn). Full stop/start requires changes to the supervisor lifecycle that can be refined post-v0.5.

### 9. E2E Testing Strategy

**Playwright** for CI-reproducible tests. The test harness:
1. Starts devrig with a test config (services + dashboard + OTel)
2. Sends synthetic OTLP data via a small Node.js script using `@opentelemetry/exporter-trace-otlp-http`
3. Runs Playwright tests against `http://localhost:{dashboard_port}`
4. Tears down via `devrig delete`

All key UI elements get `data-testid` attributes for reliable selectors.

**Agent-browser** tests are complementary — used during development for ad-hoc validation, not in CI.

---

## Integration Points with Existing Code

### Config Module (`src/config/`)

- **`model.rs`**: Add `DashboardConfig`, `OtelConfig` structs. Add `dashboard: Option<DashboardConfig>` to `DevrigConfig` with `#[serde(default)]`.
- **`validate.rs`**: Add validation for dashboard/otel port conflicts with services/infra. Validate retention string is parseable by `humantime`.
- **`interpolate.rs`**: Add `dashboard.port`, `dashboard.otel.grpc_port`, `dashboard.otel.http_port` to template vars.

### Orchestrator Module (`src/orchestrator/`)

- **`mod.rs`**: Insert Phase 4.5 between Phase 4 and Phase 5. Construct `AppState`, start OTLP collector and dashboard server as background tasks on the `TaskTracker`. Inject `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` into service env before Phase 5.
- **`ports.rs`**: Extend `check_all_ports_unified()` to include dashboard port, gRPC port, and HTTP OTLP port.
- **`state.rs`**: Add `DashboardState` (ports, URLs) to `ProjectState`.

### Discovery Module (`src/discovery/`)

- **`env.rs`**: When `config.dashboard` is `Some`, inject `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:{http_port}`, `OTEL_SERVICE_NAME={service_name}`, and `DEVRIG_DASHBOARD_URL=http://localhost:{dashboard_port}` into all services.

### UI Module (`src/ui/`)

- **`summary.rs`**: Add dashboard section to startup summary showing dashboard URL, OTLP gRPC endpoint, OTLP HTTP endpoint.

### CLI (`src/cli.rs`, `src/main.rs`)

- **`cli.rs`**: Add `Query` command with nested subcommands (traces, trace, metrics, logs, status, related).
- **`main.rs`**: Add dispatch for `Query` command.

---

## Implementation Order and Rationale

The implementation follows a layered approach: Rust backend first (config → storage → receivers → API → CLI), then frontend, then E2E tests, then docs.

### Phase 1: Foundation (Steps 1–4)

**Step 1: Dependencies.** Add all new crates to Cargo.toml. Build to verify version compatibility between tonic, axum, and opentelemetry-proto. This is the critical risk — if versions conflict, we need to adjust before writing any code.

**Step 2: Config model.** Add `DashboardConfig` and `OtelConfig` to the config model. Add validation rules for port conflicts and retention parsing. Extend template interpolation.

**Step 3: State model.** Extend `ProjectState` with `DashboardState` for persistence.

**Step 4: Port checking.** Extend port conflict detection to include dashboard and OTLP ports.

### Phase 2: Telemetry Storage (Steps 5–6)

**Step 5: Internal types.** Define `StoredSpan`, `StoredLog`, `StoredMetric` types with the fields needed for querying. Define `TelemetryEvent` for WebSocket push.

**Step 6: TelemetryStore.** Implement the ring buffer storage with secondary indexes, insert/evict logic, and query methods. This is the core data structure — it must be thoroughly tested before building receivers on top.

### Phase 3: OTLP Receivers (Steps 7–8)

**Step 7: gRPC receiver.** Implement tonic `TraceService`, `MetricsService`, `LogsService` traits. Convert proto types to internal types. Write to shared `TelemetryStore`.

**Step 8: HTTP receiver.** Implement Axum handlers for `/v1/traces`, `/v1/metrics`, `/v1/logs`. Support protobuf content type. Write to shared `TelemetryStore`.

### Phase 4: Query Engine (Steps 9–10)

**Step 9: Query engine.** Implement query methods on `TelemetryStore`: list traces (with filters), get trace detail, list metrics, list logs, get status, get related telemetry.

**Step 10: Query output formatters.** NDJSON, JSON-pretty, table formatters for CLI output.

### Phase 5: Dashboard Backend (Steps 11–14)

**Step 11: REST API routes.** Implement all `/api/*` endpoints reading from `TelemetryStore`.

**Step 12: WebSocket handler.** Implement `/api/ws` with broadcast subscription and event batching.

**Step 13: Static file serving.** Implement `rust-embed` SPA serving with fallback to `index.html`.

**Step 14: Dashboard server assembly.** Wire routes, WebSocket, and static files into a single Axum server.

### Phase 6: Orchestrator Integration (Steps 15–16)

**Step 15: Phase 4.5 + env injection.** Insert Phase 4.5 into the orchestrator. Start OTLP collector and dashboard server. Inject OTEL env vars into services.

**Step 16: Service management.** Add service command channel for restart/stop from the dashboard.

### Phase 7: CLI (Steps 17–18)

**Step 17: CLI query commands.** Add `devrig query` subcommands that call REST API endpoints.

**Step 18: CLI integration.** Wire CLI commands into `cli.rs` and `main.rs`.

### Phase 8: Frontend (Steps 19–22)

**Step 19: Frontend scaffolding.** Vite + SolidJS + Tailwind + Solid UI setup. Build pipeline. TypeScript types.

**Step 20: Core views.** Overview, Traces (list + waterfall), Metrics, Logs views.

**Step 21: Interactive features.** Cmd+K palette, dark/light toggle, keyboard shortcuts, cross-telemetry navigation.

**Step 22: Real-time updates.** WebSocket client integration with reactive stores.

### Phase 9: Testing (Steps 23–25)

**Step 23: Integration tests.** OTLP ingest tests (send spans/metrics/logs, verify via query CLI).

**Step 24: E2E test infrastructure.** Playwright config, test harness, synthetic OTLP data generation.

**Step 25: E2E dashboard tests.** All nine agent-browser/Playwright test suites.

### Phase 10: Documentation (Step 26)

**Step 26: Documentation.** Architecture docs, API reference, CLI reference, config guide updates.

---

## Testing Strategy

### Unit Tests

| Module | Tests |
|---|---|
| `config::model` | DashboardConfig parsing (all fields, defaults, missing), OtelConfig parsing, retention string validation |
| `config::validate` | Dashboard port conflicts with services/infra, OTLP port conflicts, retention parse errors |
| `config::interpolate` | dashboard.port, dashboard.otel.* template vars |
| `otel::storage` | Ring buffer insert/evict, index maintenance on eviction, trace assembly, time range queries, service filter, error span index, log severity filter, metric name lookup, capacity enforcement, concurrent read/write |
| `otel::types` | Proto-to-internal type conversion, hex encoding of trace/span IDs, service name extraction from resource attributes |
| `otel::query` | Trace list with filters, trace detail assembly, log search, metric discovery, related telemetry correlation, time window queries |
| `dashboard::routes` | Query parameter parsing, response serialization |
| `query::output` | NDJSON formatting, table formatting, JSON-pretty formatting |

### Integration Tests

| Test | What It Verifies |
|---|---|
| `otel_ingest_spans` | Send OTLP spans via HTTP → verify via `devrig query traces` → spans appear with correct service/trace ID |
| `otel_ingest_metrics` | Send OTLP metrics via HTTP → verify via `devrig query metrics` |
| `otel_ingest_logs` | Send OTLP logs via HTTP → verify via `devrig query logs` |
| `otel_ring_buffer_eviction` | Send more spans than buffer capacity → oldest evicted, newest retained |
| `query_cli_traces` | `devrig query traces --service X --format json` returns valid JSON |
| `query_cli_status` | `devrig query status` returns service/infra status |
| `dashboard_startup` | Dashboard serves on configured port, root returns HTML |
| `otel_env_injection` | Service env contains `OTEL_EXPORTER_OTLP_ENDPOINT` when dashboard enabled |
| `dashboard_rest_api` | GET /api/traces returns 200 with JSON array |
| `dashboard_websocket` | WebSocket connects, receives events after OTLP ingest |

### E2E Tests (Playwright)

| Test File | What It Verifies |
|---|---|
| `overview.test.ts` | Services/infra appear with correct status indicators |
| `traces.test.ts` | Trace waterfall renders, filters work, span detail shows |
| `metrics.test.ts` | Charts render for discovered metrics, service filter works |
| `logs.test.ts` | Log lines appear, severity filter works, search works |
| `trace-correlation.test.ts` | Click trace ID on log → navigates to trace view |
| `cmd-k.test.ts` | Cmd+K opens palette, can navigate between views |
| `dark-light.test.ts` | Theme toggle works, persists across refresh |
| `realtime.test.ts` | New data appears without refresh (WebSocket push) |

### Backwards Compatibility

All existing 173 unit tests and 43 integration tests must continue to pass. The config model extension uses `#[serde(default)]` so existing configs without `[dashboard]` parse correctly.

---

## Documentation Plan

### New Files

- **`docs/architecture/otel-storage.md`** — Ring buffer design, secondary indexes, eviction strategy, retention, memory model, concurrency approach
- **`docs/api/rest-api.md`** — All REST endpoints with request/response examples, query parameters, response schemas
- **`docs/api/query-cli.md`** — `devrig query` command reference with examples for each subcommand

### Updated Files

- **`docs/guides/configuration.md`** — Add `[dashboard]` section (port, enabled), `[dashboard.otel]` section (grpc_port, http_port, trace_buffer, metric_buffer, log_buffer, retention), auto-injected env vars (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME, DEVRIG_DASHBOARD_URL)
- **`docs/architecture/overview.md`** — Update architecture diagram to include dashboard and OTLP collector
- **`README.md`** — Add dashboard section, update feature list

---

## Risk Mitigation

### 1. tonic + axum + opentelemetry-proto Version Compatibility

The biggest technical risk. All three crates depend on hyper, tower, and http. Step 1 resolves this immediately by adding all dependencies and running `cargo build`. If versions conflict, we adjust before writing code.

**Fallback:** If tonic and axum cannot share a hyper version, run the gRPC server with tonic's own standalone transport (separate from axum entirely). They already run on different ports, so no multiplexing is needed.

### 2. opentelemetry-proto `with-serde` Feature Completeness

The `with-serde` feature may not handle all edge cases (e.g., hex-encoded trace IDs in JSON). Step 8 (HTTP receiver) tests JSON deserialization early.

**Fallback:** If `with-serde` is problematic, use protobuf-only for the HTTP receiver (most OTLP clients send protobuf by default) and manually implement JSON deserialization where needed.

### 3. Frontend Build Complexity

Adding Node.js to the build chain is significant. Mitigated by:
- Pre-building and committing `dashboard-ui/dist/` to the repo
- Feature-gating the dashboard behind `#[cfg(feature = "dashboard")]`
- In debug mode, `rust-embed` reads from disk (no rebuild needed for frontend changes)

### 4. Ring Buffer Index Maintenance

Multiple secondary indexes must be kept in sync during insert and eviction. Mitigated by:
- Centralizing all index updates in `insert()` and `evict()` methods
- Returning evicted items so the caller has data needed for cleanup
- Thorough unit tests: insert N+1 into capacity N, verify evicted item's index entries are removed
- A single `remove_from_indexes(record_id, &item)` method for eviction cleanup

### 5. WebSocket Memory Under Load

Broadcast channel capacity (1024 messages) with lagged client auto-skip. Send timeout (5s) on WebSocket writes — slow clients disconnected. Event batching (100ms window) reduces per-message overhead.

### 6. Binary Size Increase

Adding tonic, axum, opentelemetry-proto, prost, and embedded frontend assets increases binary size significantly. Mitigated by:
- Feature-gating: `cargo build` without `--features dashboard` stays lean
- `rust-embed` compression reduces embedded asset size
- Monitoring binary size in CI

### 7. SPA Routing vs. Static File Serving

Direct navigation to `/traces/abc123` must serve `index.html`, not 404. The static file handler explicitly falls back: if path has no matching embedded file and is not `/api/*`, serve `index.html`. Tested in E2E tests with deep link navigation.
