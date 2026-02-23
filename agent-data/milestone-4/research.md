# Milestone v0.5 Research — Observability + Dashboard

## Table of Contents

1. [Crate/Library Recommendations](#cratelibrary-recommendations)
2. [Design Patterns](#design-patterns)
3. [Implementation Strategy](#implementation-strategy)
4. [Risks and Considerations](#risks-and-considerations)
5. [References](#references)

---

## Crate/Library Recommendations

### Rust Dependencies to Add

| Crate | Version | Purpose | Notes |
|-------|---------|---------|-------|
| `opentelemetry-proto` | 0.31 | OTLP protobuf types + tonic gRPC service traits | Features: `gen-tonic`, `trace`, `metrics`, `logs`, `with-serde` |
| `tonic` | 0.14 | gRPC server for OTLP receiver (port 4317) | Paired with opentelemetry-proto's generated service traits |
| `prost` | 0.14 | Protobuf encoding/decoding (required by tonic + opentelemetry-proto) | |
| `axum` | 0.8 | HTTP server for dashboard, REST API, OTLP HTTP receiver, WebSocket | Breaking change in 0.8: path params use `/{param}` not `/:param` |
| `tower-http` | 0.6 | CORS, compression middleware for Axum | Features: `cors`, `compression-br` |
| `rust-embed` | 8 | Embed built SolidJS frontend into Rust binary | Debug mode reads from disk; release embeds at compile time |
| `mime_guess` | 2 | Content-type detection for embedded static files | |
| `humantime` | 2.3 | Parse duration strings ("5m", "1h", "30s") for CLI `--last` flags | 265M+ downloads, zero-dependency, standard choice |
| `hex` | 0.4 | Encode/decode trace IDs and span IDs | Already in Cargo.toml |

### Already Available (no additions needed)

| Crate | Version | Used For |
|-------|---------|----------|
| `tokio` | 1.x | Async runtime, broadcast channels, RwLock, tasks |
| `serde` / `serde_json` | 1.x | JSON serialization for REST API, WebSocket, CLI output |
| `clap` | 4.5 | CLI framework (nested subcommands for `devrig query`) |
| `comfy-table` | 7 | Table formatting for `--format table` output |
| `chrono` | 0.4 | Timestamps, time range parsing |
| `reqwest` | 0.12 | HTTP ready checks (already present) |
| `futures-util` | 0.3 | Stream combinators for WebSocket split |
| `owo-colors` | 4 | Colored terminal output |
| `tracing` | 0.1 | Internal logging |

### Frontend Dependencies (package.json)

| Package | Version | Purpose |
|---------|---------|---------|
| `solid-js` | ^1.9 | UI framework |
| `@solid-primitives/websocket` | latest | Reconnecting WebSocket with heartbeat |
| `@dschz/solid-uplot` | latest | Time-series metric charts (uPlot wrapper) |
| `uplot` | ^1.6 | High-performance time-series charting |
| `vite` | ^6 | Build tool |
| `vite-plugin-solid` | ^2.11 | SolidJS Vite plugin |
| `typescript` | ^5.7 | Type checking |
| `tailwindcss` | ^3 | Styling (required by Solid UI) |
| `postcss` | ^8 | CSS processing |
| `autoprefixer` | ^10 | CSS vendor prefixes |

### Solid UI Components (copy-paste, not npm)

Solid UI follows the shadcn pattern — components are added to the project via CLI and owned by the project. Built on Kobalte (headless accessible primitives) + Tailwind CSS.

```bash
npx solidui-cli@latest init
npx solidui-cli@latest add button table tabs dialog command card badge toast skeleton sidebar
npx solidui-cli@latest add charts   # Chart.js wrappers for simple charts
```

Components needed for the dashboard:

| Component | Dashboard Use |
|-----------|--------------|
| `sidebar` | Left navigation (Overview, Traces, Metrics, Logs) |
| `data-table` | Trace list, log viewer, metric list |
| `tabs` | View switching within pages |
| `command` (cmdk-solid) | Cmd+K command palette |
| `dialog` / `sheet` | Span detail slide-over, trace detail panel |
| `card` | Service status cards, metric summary cards |
| `badge` | Status indicators (running, error, healthy) |
| `toast` | Notifications for events |
| `skeleton` | Loading states |
| `toggle-group` | Filter controls (service, severity) |
| `charts` | Summary charts (built on Chart.js) |

### E2E Testing Dependencies

| Tool | Version | Purpose |
|------|---------|---------|
| `@playwright/test` | ^1.58 | E2E browser testing for CI |
| `agent-browser` | latest | AI-agent browser automation (Claude Code skill) |
| `otelgen` | latest | Synthetic OTLP data generation for test fixtures |

---

## Design Patterns

### 1. In-Memory Ring Buffer Storage

**Primary storage: `VecDeque<T>` with manual capacity enforcement.**

Dedicated ring buffer crates (`ringbuffer`, `ringbuf`) serve simpler use cases. A telemetry store needs secondary indexes for queries by trace ID, service name, time range, and status. `VecDeque` with a custom wrapper that returns evicted items (for index cleanup) is simpler and more transparent.

```rust
struct BoundedStore<T> {
    items: VecDeque<T>,
    max_capacity: usize,
}

impl<T> BoundedStore<T> {
    fn push(&mut self, item: T) -> Option<T> {
        let evicted = if self.items.len() >= self.max_capacity {
            self.items.pop_front()
        } else {
            None
        };
        self.items.push_back(item);
        evicted // caller cleans up indexes
    }
}
```

**Concurrency: `tokio::sync::RwLock<TelemetryStore>`.**

Multiple OTLP writers, multiple REST/WebSocket/CLI readers. Classic readers-writer pattern. Tokio's `RwLock` yields to the runtime instead of blocking OS threads. Acquire write locks briefly — do serialization and broadcast notifications outside the lock.

Not `DashMap` — the store has correlated data (spans within traces, indexes that must be updated atomically). Not lock-free — write rate (hundreds/sec) does not justify the complexity.

**Storage model:**

```rust
struct TelemetryStore {
    // Primary storage (ring buffers)
    spans: VecDeque<StoredSpan>,
    logs: VecDeque<StoredLog>,
    metrics: VecDeque<StoredMetric>,
    next_id: u64, // monotonic internal ID

    // Secondary indexes
    trace_index: HashMap<TraceId, HashSet<u64>>,       // trace ID -> span record IDs
    trace_to_logs: HashMap<TraceId, HashSet<u64>>,     // trace ID -> log record IDs
    service_index: HashMap<String, HashSet<u64>>,      // service name -> record IDs
    time_index: BTreeMap<Instant, Vec<u64>>,            // timestamp -> record IDs (range queries)
    error_spans: HashSet<u64>,                          // spans with error status
    severity_index: HashMap<Severity, HashSet<u64>>,   // log severity -> record IDs
    id_to_position: HashMap<u64, usize>,               // record ID -> VecDeque position

    // Configuration
    max_spans: usize,
    max_logs: usize,
    max_metrics: usize,
    retention: Duration,
}
```

**Index design rationale:**
- `BTreeMap` for time index — supports `range()` queries for "give me spans from the last 5 minutes"
- `HashMap` for everything else — O(1) exact-match lookups
- `HashSet<u64>` at each index entry — avoids duplicating span/log data

**Spans stored individually, traces assembled on query.** Spans arrive out of order from different services. Index by trace ID, assemble on read. When a span is evicted, clean up all index entries.

**Retention: hybrid approach.** Lazy eviction on insert (check front of VecDeque, which is sorted by time) + background sweeper every 30 seconds. The sweeper handles the "ingestion stopped but memory should be reclaimed" case.

**Memory budget:** ~110 MB for the default config (10K traces × ~5 spans each, 50K metric points, 100K log records). Acceptable for a dev tool.

### 2. OTLP Receiver Architecture

**Two separate servers, shared state via `Arc`.**

- gRPC server (tonic) on port 4317
- HTTP server (Axum) on port 4318

Both receive OTLP data and write to the shared `TelemetryStore`. Separate ports are simpler than multiplexing gRPC and HTTP on a single port (which requires content-type sniffing and HTTP/2-only mode).

**gRPC receiver:** Implement tonic service traits generated by `opentelemetry-proto`:

```rust
#[tonic::async_trait]
impl TraceService for OtlpReceiver {
    async fn export(
        &self,
        request: tonic::Request<ExportTraceServiceRequest>,
    ) -> Result<tonic::Response<ExportTraceServiceResponse>, tonic::Status> {
        let req = request.into_inner();
        // Process req.resource_spans → store in TelemetryStore
        Ok(tonic::Response::new(ExportTraceServiceResponse {
            partial_success: None,
        }))
    }
}
```

All three services (TraceService, MetricsService, LogsService) share a single `OtlpReceiver` struct via `Arc`.

**HTTP receiver:** Axum handlers for POST `/v1/traces`, `/v1/metrics`, `/v1/logs`. Content-type negotiation: `application/x-protobuf` (prost::Message::decode) and `application/json` (serde_json with `with-serde` feature). Response mirrors request content type per OTLP spec.

### 3. Dashboard Server Architecture

**Single Axum server on the dashboard port (default 4000)** serving:

1. **Embedded SPA** — SolidJS build output via `rust-embed`, with SPA fallback (unknown paths serve `index.html`)
2. **REST API** — `/api/traces`, `/api/metrics`, `/api/logs`, `/api/status`, `/api/env`
3. **WebSocket** — `/api/ws` for real-time telemetry push
4. **Service management** — POST `/api/services/:name/restart`, `/api/services/:name/stop`

```rust
fn dashboard_router(state: AppState) -> Router {
    Router::new()
        // REST API
        .route("/api/traces", get(list_traces))
        .route("/api/traces/{trace_id}", get(get_trace))
        .route("/api/traces/{trace_id}/related", get(get_related))
        .route("/api/metrics", get(list_metrics))
        .route("/api/logs", get(list_logs))
        .route("/api/status", get(get_status))
        .route("/api/env", get(list_all_env))
        .route("/api/env/{service}", get(get_service_env))
        .route("/api/services/{name}/restart", post(restart_service))
        .route("/api/services/{name}/stop", post(stop_service))
        // WebSocket
        .route("/api/ws", get(ws_handler))
        // Static files (SPA fallback)
        .fallback(static_handler)
        .with_state(state)
}
```

### 4. WebSocket Real-Time Updates

**`tokio::sync::broadcast` for fan-out to multiple WebSocket clients.**

When telemetry is ingested, the OTLP receiver sends a `TelemetryEvent` to a broadcast channel. Each WebSocket client subscribes and forwards events to the browser.

```rust
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", content = "payload")]
enum TelemetryEvent {
    TraceUpdate { trace_id: String, service: String, duration_ms: u64, has_error: bool },
    LogRecord { trace_id: Option<String>, severity: String, body: String, service: String },
    MetricUpdate { name: String, value: f64, service: String },
    ServiceStatusChange { service: String, status: String },
}
```

**Backpressure:** Three layers — broadcast channel capacity (1024 messages, lagged clients skip), Axum write buffer limits, application-level send timeout (5s). Slow clients get disconnected rather than unbounded buffering.

**Client-side:** `@solid-primitives/websocket` with `createReconnectingWS` + `makeHeartbeatWS`. Initial data load via REST, live updates via WebSocket. SolidJS `createStore` for reactive state management.

### 5. CLI Query Pattern

**Nested clap subcommands:**

```
devrig query traces [--service X] [--status error] [--min-duration 100ms] [--last 5m] [--format json]
devrig query trace <trace-id>
devrig query metrics [--name X] [--service X] [--last 5m]
devrig query logs [--service X] [--level error] [--search "text"] [--trace-id X]
devrig query status
devrig query related <trace-id>
```

**Output format:** NDJSON by default (`serde_json::to_writer` + `writeln!`). `--format json-pretty` for human-readable. `--format table` via `comfy-table` (already a dependency).

**Query execution:** The CLI connects to the dashboard's REST API (same endpoints the UI uses). This avoids needing the CLI to directly access the in-process store. If the dashboard is not running, the CLI prints a clear error.

### 6. Frontend Architecture

```
dashboard-ui/
  src/
    index.tsx              # App root, router setup
    App.tsx                # Layout with sidebar
    components/
      ui/                  # Solid UI components (copy-paste)
      Sidebar.tsx          # Navigation sidebar
      CommandPalette.tsx   # Cmd+K palette
      ThemeToggle.tsx      # Dark/light mode toggle
    views/
      Overview.tsx         # Service/infra status dashboard
      Traces.tsx           # Trace list + waterfall
      TraceDetail.tsx      # Span waterfall + detail panel
      Metrics.tsx          # Metric chart discovery + time-series
      Logs.tsx             # Structured log viewer
    lib/
      ws.ts                # WebSocket client with reconnection
      api.ts               # REST API client functions
      store.ts             # SolidJS store for telemetry state
      theme.ts             # Dark/light mode management
    types/
      telemetry.ts         # TypeScript types matching Rust structs
  package.json
  vite.config.ts
  tsconfig.json
  tailwind.config.js
```

**Dark mode:** Kobalte's `ColorModeProvider` + `ColorModeScript` (prevents flash). Persists to localStorage. Default: dark.

**Cmd+K palette:** Solid UI `command` component (based on cmdk-solid). Actions: navigate between views, jump to a trace by ID, filter by service.

**Charts:** uPlot (via `@dschz/solid-uplot`) for real-time time-series metric panels. Solid UI's built-in Chart.js wrappers for summary visualizations.

**Cross-telemetry navigation:** URL-based deep links (`/traces?traceId=abc`, `/logs?service=api&from=...&to=...`). Keyboard shortcuts: `t` (traces), `l` (logs), `m` (metrics), `Escape` (back).

### 7. Orchestrator Integration

Dashboard starts as **Phase 4.5** (after port resolution, before service spawning):

```
Phase 0: Parse & Validate
Phase 1: Network
Phase 2: Compose
Phase 3: Infrastructure
Phase 3.5: Cluster
Phase 4: Resolve & Inject
Phase 4.5: Dashboard + OTLP Collector  ← NEW
Phase 5: Services (with OTEL_EXPORTER_OTLP_ENDPOINT injected)
```

Dashboard must start before services so that `OTEL_EXPORTER_OTLP_ENDPOINT` points to a running receiver when services start.

**Environment injection:** Add to all services:
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:{http_port}` (default 4318)
- `OTEL_SERVICE_NAME={service_name}`
- `DEVRIG_DASHBOARD_URL=http://localhost:{dashboard_port}`

---

## Implementation Strategy

### Feature 1: Config Model Extension

**What:** Add `[dashboard]` and `[dashboard.otel]` sections to `DevrigConfig`.

**Where:** `src/config/model.rs`, `src/config/validate.rs`

```rust
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct DashboardConfig {
    #[serde(default = "default_dashboard_port")]
    pub port: u16,
    #[serde(default)]
    pub enabled: Option<bool>,  // defaults to true if [dashboard] present
    #[serde(default)]
    pub otel: Option<OtelConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct OtelConfig {
    #[serde(default = "default_grpc_port")]
    pub grpc_port: u16,        // default 4317
    #[serde(default = "default_http_port")]
    pub http_port: u16,        // default 4318
    #[serde(default = "default_trace_buffer")]
    pub trace_buffer: usize,   // default 10000
    #[serde(default = "default_metric_buffer")]
    pub metric_buffer: usize,  // default 50000
    #[serde(default = "default_log_buffer")]
    pub log_buffer: usize,     // default 100000
    #[serde(default = "default_retention")]
    pub retention: String,     // default "1h"
}
```

**Validation:** Check port conflicts with services/infra. Validate retention string is parseable by `humantime`.

### Feature 2: OTLP Receiver Module

**What:** In-process OTLP receiver accepting traces, metrics, logs over gRPC and HTTP.

**Where:** New `src/otel/` module.

```
src/otel/
  mod.rs           # OtelCollector: start gRPC + HTTP, coordinate storage
  receiver_grpc.rs # tonic TraceService/MetricsService/LogsService impl
  receiver_http.rs # Axum handlers for /v1/traces, /v1/metrics, /v1/logs
  storage.rs       # TelemetryStore: ring buffers + indexes
  types.rs         # StoredSpan, StoredLog, StoredMetric, internal types
  query.rs         # Query engine: filter, search, correlate
```

**Implementation order:**
1. Define internal types in `types.rs` (converting from proto types to stored types)
2. Implement `TelemetryStore` in `storage.rs` with ring buffers and indexes
3. Implement gRPC receiver in `receiver_grpc.rs`
4. Implement HTTP receiver in `receiver_http.rs`
5. Wire up `OtelCollector` in `mod.rs` to start both servers

**Key conversion:** Proto `Span` → `StoredSpan`. Extract service name from `Resource.attributes` (the `service.name` attribute). Extract trace ID and span ID as `[u8; 16]` and `[u8; 8]`. Convert timestamps from proto nanos to `SystemTime`.

### Feature 3: Dashboard Backend

**What:** Axum server serving REST API, WebSocket, and embedded SPA.

**Where:** New `src/dashboard/` module.

```
src/dashboard/
  mod.rs           # DashboardServer: start Axum, configure routes
  routes/
    mod.rs         # Route registration
    traces.rs      # GET /api/traces, GET /api/traces/:id, GET /api/traces/:id/related
    metrics.rs     # GET /api/metrics
    logs.rs        # GET /api/logs
    status.rs      # GET /api/status
    env.rs         # GET /api/env, GET /api/env/:service
    services.rs    # POST /api/services/:name/restart|stop|start
  ws.rs            # WebSocket handler with broadcast subscription
  static_files.rs  # rust-embed SPA serving with fallback
```

**AppState shared between dashboard and OTLP receiver:**

```rust
#[derive(Clone)]
struct AppState {
    store: Arc<RwLock<TelemetryStore>>,
    events_tx: broadcast::Sender<TelemetryEvent>,
    orchestrator: Arc<OrchestratorHandle>,  // for service management
}
```

### Feature 4: Dashboard Frontend

**What:** SolidJS + Solid UI + Tailwind CSS SPA.

**Where:** New `dashboard-ui/` directory at project root.

**Setup steps:**
1. `npm create vite@latest dashboard-ui -- --template vanilla-ts`
2. Install SolidJS, Tailwind, Solid UI
3. `npx solidui-cli@latest init` + add components
4. Implement views: Overview, Traces, Metrics, Logs

**Routing:** Use `@solidjs/router` for client-side routing. Routes:
- `/` → Overview
- `/traces` → Trace list
- `/traces/:id` → Trace detail (waterfall)
- `/metrics` → Metric discovery + charts
- `/logs` → Structured log viewer

**Build integration:** Add `build.rs` to trigger `npm run build` in `dashboard-ui/`. The built output goes to `dashboard-ui/dist/` which `rust-embed` embeds.

### Feature 5: CLI Query Commands

**What:** `devrig query` subcommands for machine-readable observability data.

**Where:** New `src/query/` module + `src/commands/query.rs`.

```
src/query/
  mod.rs           # Query execution logic
  output.rs        # NDJSON, JSON-pretty, table formatters
src/commands/
  query.rs         # CLI command handlers
```

**Design decision: CLI talks to REST API.** The `devrig query` commands make HTTP requests to `http://localhost:{dashboard_port}/api/...`. This avoids the complexity of the CLI directly accessing in-process storage (which would require IPC or shared memory). The dashboard must be running for query commands to work.

Alternative considered: Unix domain socket for direct access when dashboard is not running. Deferred — the dashboard is always running when `devrig start` is active.

### Feature 6: Service Management from UI

**What:** Start/stop/restart services from the dashboard overview page.

**Where:** REST endpoints in `src/dashboard/routes/services.rs`, backed by `OrchestratorHandle`.

**OrchestratorHandle:** A new struct exposing controlled access to the orchestrator's service management (restart, stop, start). Uses `mpsc` channel to send commands to the orchestrator's main loop, avoiding direct `Arc<Mutex<Orchestrator>>` complexity.

### Feature 7: E2E Tests

**What:** Browser-based validation of all dashboard views.

**Where:** New `e2e/dashboard/` directory.

**Test infrastructure:**
1. Start devrig with a test config (services + dashboard + OTel)
2. Send synthetic OTLP data via `otelgen` or programmatic `opentelemetry-otlp` client
3. Run Playwright tests against `http://localhost:{dashboard_port}`
4. Teardown via `devrig delete`

**Test files:**

```
e2e/
  fixtures/
    devrig.test.toml          # Test config with dashboard enabled
    send-telemetry.sh         # otelgen wrapper for synthetic data
  dashboard/
    overview.test.ts          # Services/infra appear with correct status
    traces.test.ts            # Trace waterfall renders, filters work
    metrics.test.ts           # Charts render, auto-discover works
    logs.test.ts              # Log lines appear, severity filter works
    trace-correlation.test.ts # Cross-telemetry navigation
    cmd-k.test.ts             # Command palette opens, navigates
    dark-light.test.ts        # Theme toggle works, persists
    realtime.test.ts          # New data appears via WebSocket
  playwright.config.ts
  package.json
```

**Agent-browser skill tests** are complementary — used during development for ad-hoc validation, not in CI. The Playwright tests are the CI-friendly, reproducible alternative.

### Feature 8: Documentation

**Files to create:**
- `docs/architecture/otel-storage.md` — Ring buffer design, retention, eviction strategy, index design, memory model
- `docs/api/rest-api.md` — All REST endpoints with request/response examples
- `docs/api/query-cli.md` — `devrig query` command reference with examples

**Files to update:**
- `docs/guides/configuration.md` — Add `[dashboard]` and `[dashboard.otel]` sections

---

## Implementation Order

Recommended sequence based on dependency analysis:

1. **Config model** — `[dashboard]` and `[dashboard.otel]` in model.rs + validation
2. **Storage** — `TelemetryStore` with ring buffers, indexes, query engine
3. **OTLP receivers** — gRPC + HTTP receivers writing to storage
4. **Dashboard backend** — Axum server with REST API, WebSocket, static file serving
5. **Orchestrator integration** — Phase 4.5 startup, env injection, service management handle
6. **Frontend scaffolding** — Vite + SolidJS + Solid UI setup, build integration
7. **Frontend views** — Overview, Traces (list + waterfall), Metrics, Logs
8. **CLI query commands** — `devrig query` subcommands talking to REST API
9. **Cross-telemetry navigation** — Deep links, keyboard shortcuts, correlation
10. **E2E tests** — Playwright test suite with synthetic OTLP data
11. **Documentation** — Architecture docs, API reference, config guide updates

---

## Risks and Considerations

### 1. Build Complexity — Frontend in Rust Binary

**Risk:** Adding a Node.js build step (Vite/SolidJS) to a Rust project complicates the build. CI must have Node.js + npm. `build.rs` running `npm run build` can be slow and fragile.

**Mitigation:**
- Feature-gate the dashboard: `#[cfg(feature = "dashboard")]`. Users who don't need the dashboard can build without Node.js.
- Pre-build the frontend and commit `dashboard-ui/dist/` to the repo (avoids Node.js in CI). Or use a separate CI step that builds the frontend first.
- In debug mode, `rust-embed` reads from disk, so the frontend can be developed with `npm run dev` independently.

### 2. opentelemetry-proto Version Churn

**Risk:** The OpenTelemetry Rust ecosystem is still evolving. `opentelemetry-proto` 0.31 may have breaking changes in future versions. The `with-serde` feature for JSON support may have incomplete coverage.

**Mitigation:**
- Pin `opentelemetry-proto` to a specific version (`= "0.31"` not `"0.31"`).
- Test JSON encoding/decoding of all three signal types early.
- If `with-serde` is problematic for the HTTP receiver, fall back to protobuf-only (most OTLP clients send protobuf by default).

### 3. tonic + Axum Version Compatibility

**Risk:** tonic 0.14 and Axum 0.8 both depend on hyper, tower, and http crates. Version mismatches can cause compilation errors.

**Mitigation:**
- Verify that tonic 0.14 and Axum 0.8 are compatible (both use hyper 1.x, http 1.x, tower 0.4/0.5).
- Run on separate ports (avoids the tonic-axum multiplexing complexity entirely).
- If version conflicts arise, consider running the gRPC server with tonic's own transport (not Axum).

### 4. Ring Buffer Index Maintenance

**Risk:** Maintaining multiple secondary indexes (trace ID, service name, time, severity) on every insert and eviction is error-prone. Missed cleanup leads to dangling index entries and incorrect query results.

**Mitigation:**
- Centralize all index updates in `insert()` and `evict()` methods.
- Return evicted items from the ring buffer so the caller always has the data needed for cleanup.
- Write thorough unit tests: insert N+1 items into a buffer of size N, verify the evicted item's index entries are removed.
- Consider a single `remove_from_all_indexes(record_id, &item)` method called on every eviction.

### 5. WebSocket Memory Under Load

**Risk:** If many browser tabs are open and telemetry is flowing fast, the broadcast channel + per-client WebSocket buffers could use significant memory.

**Mitigation:**
- Broadcast channel capacity: 1024 messages. Lagged clients skip old messages automatically.
- Send timeout (5s) on WebSocket writes. Slow clients get disconnected.
- Throttle WebSocket events: batch multiple telemetry events into a single message every 100ms instead of sending each individually.

### 6. SPA Routing vs. Static File Serving

**Risk:** SolidJS uses client-side routing. Direct navigation to `/traces/abc123` must serve `index.html`, not 404. The static file handler must correctly fall back.

**Mitigation:**
- Explicit fallback: if the requested path has no matching embedded file and is not an `/api/` path, serve `index.html`.
- Test deep link navigation in E2E tests.

### 7. OTLP JSON Encoding Edge Cases

**Risk:** The OTLP spec requires trace IDs and span IDs in JSON to be hex-encoded strings (not base64). The `with-serde` feature of `opentelemetry-proto` may not handle this correctly.

**Mitigation:**
- Test with a known OTLP JSON payload early in development.
- If serde encoding is wrong, implement custom deserializers for the HTTP handler.
- Most real-world OTLP clients use protobuf, so JSON is a secondary concern.

### 8. Agent-Browser Test Stability

**Risk:** Agent-browser E2E tests depend on AI agent behavior, which is inherently non-deterministic. Tests may pass or fail based on how the agent interprets the page.

**Mitigation:**
- Use Playwright for CI tests (deterministic, repeatable).
- Use agent-browser only for development-time validation (manual trigger, not in CI pipeline).
- Add `data-testid` attributes to all key UI elements for reliable Playwright selectors.

### 9. Dashboard Port Conflicts with User Services

**Risk:** Default dashboard port (4000), gRPC port (4317), and HTTP port (4318) may conflict with user's own services.

**Mitigation:**
- All ports are configurable in `[dashboard]` and `[dashboard.otel]`.
- Port collision detection (already implemented in `src/orchestrator/ports.rs`) should include dashboard and OTel ports.
- Clear error messages identifying which devrig component owns the conflicting port.

### 10. Binary Size Increase

**Risk:** Adding tonic (gRPC), Axum (HTTP), opentelemetry-proto (protobuf types), and embedded frontend assets will significantly increase binary size.

**Mitigation:**
- Feature-gate: `cargo build --features dashboard` for users who want the dashboard; without the feature, the binary stays lean.
- Use `rust-embed` compression feature to reduce embedded asset size.
- Monitor binary size in CI; set an alert if it exceeds a threshold (e.g., 50MB).

### 11. Trace Waterfall Rendering Complexity

**Risk:** The trace waterfall view (showing spans as horizontal bars in a parent-child tree) is a complex UI component. Getting the timing bars, nesting, colors, and interactivity right is significant frontend work.

**Mitigation:**
- Start with a simplified waterfall: flat list of spans sorted by start time with indentation for parent-child relationships. No pixel-perfect timing bars in v0.5.
- Study existing implementations: Jaeger's React waterfall component is well-documented. Adapt the visual design, not the code.
- Use `data-testid` attributes on span bars for E2E testing.

### 12. Metric Aggregation and Chart Types

**Risk:** OpenTelemetry metrics include multiple types (counter, gauge, histogram, summary, exponential histogram). Each requires different chart visualization. Auto-discovering and rendering appropriate charts for each type is non-trivial.

**Mitigation:**
- Start with gauges (line chart) and counters (rate chart) only. These cover the majority of use cases.
- For histograms, show the sum/count/bucket values as separate line charts initially.
- The metric auto-discovery view should list metric names with their types, and only render charts for supported types.

---

## References

### OTLP Protocol & Implementation
- [OTLP Specification 1.9.0](https://opentelemetry.io/docs/specs/otlp/)
- [opentelemetry-proto crate (v0.31)](https://docs.rs/opentelemetry-proto/0.31.0/opentelemetry_proto/)
- [opentelemetry-proto on crates.io](https://crates.io/crates/opentelemetry-proto)
- [opentelemetry-rust GitHub](https://github.com/open-telemetry/opentelemetry-rust)
- [tonic (v0.14)](https://docs.rs/tonic/0.14/tonic/)
- [prost (v0.14)](https://docs.rs/prost/0.14/prost/)
- [OTLP HTTP specification](https://github.com/open-telemetry/oteps/blob/main/text/0099-otlp-http.md)
- [OTLP proto definitions](https://github.com/open-telemetry/opentelemetry-proto)

### Axum & Web Server
- [Axum 0.8 announcement](https://tokio.rs/blog/2025-01-01-announcing-axum-0-8-0)
- [Axum docs.rs](https://docs.rs/axum/latest/axum/)
- [Axum WebSocket docs](https://docs.rs/axum/latest/axum/extract/ws/index.html)
- [Axum REST-gRPC multiplex example](https://github.com/tokio-rs/axum/tree/main/examples/rest-grpc-multiplex)
- [tower-http (v0.6)](https://docs.rs/tower-http/latest/tower_http/)
- [rust-embed (v8)](https://crates.io/crates/rust-embed)
- [axum-embed crate](https://docs.rs/axum-embed/latest/axum_embed/)

### SolidJS & Frontend
- [SolidJS (v1.9)](https://www.solidjs.com/)
- [Solid UI (www.solid-ui.com)](https://www.solid-ui.com/)
- [Solid UI GitHub](https://github.com/stefan-karger/solid-ui)
- [solidui-cli on npm](https://www.npmjs.com/package/solidui-cli)
- [Kobalte (headless UI for SolidJS)](https://github.com/kobaltedev/kobalte)
- [@solid-primitives/websocket](https://primitives.solidjs.community/package/websocket/)
- [solid-uplot (SolidJS uPlot wrapper)](https://github.com/dsnchz/solid-uplot)
- [uPlot](https://github.com/leeoniya/uPlot)
- [vite-plugin-solid](https://github.com/solidjs/vite-plugin-solid)

### Storage & Concurrency
- [VecDeque docs](https://doc.rust-lang.org/std/collections/struct.VecDeque.html)
- [tokio::sync::broadcast](https://docs.rs/tokio/latest/tokio/sync/broadcast/index.html)
- [tokio::sync::RwLock](https://docs.rs/tokio/latest/tokio/sync/struct.RwLock.html)
- [DashMap](https://github.com/xacrimon/dashmap)
- [Moka cache](https://github.com/moka-rs/moka)

### Testing
- [Playwright (v1.58)](https://playwright.dev/)
- [Playwright WebSocket testing](https://playwright.dev/docs/api/class-websocketroute)
- [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots)
- [agent-browser (Vercel Labs)](https://github.com/vercel-labs/agent-browser)
- [otelgen — synthetic OTLP generator](https://github.com/krzko/otelgen)
- [SolidJS testing guide](https://docs.solidjs.com/guides/testing)

### CLI & Query Patterns
- [clap derive tutorial](https://docs.rs/clap/latest/clap/_derive/_tutorial/index.html)
- [humantime (v2.3)](https://crates.io/crates/humantime)
- [comfy-table (v7)](https://docs.rs/comfy-table)
- [Jaeger APIs](https://www.jaegertracing.io/docs/2.dev/architecture/apis/)
- [Grafana Tempo HTTP API](https://grafana.com/docs/tempo/latest/api_docs/)
- [Grafana Loki HTTP API](https://grafana.com/docs/loki/latest/reference/loki-http-api/)

### Architecture & Patterns
- [Datadog Rust timeseries engine](https://www.datadoghq.com/blog/engineering/rust-timeseries-engine/)
- [Building production web services with Rust and Axum](https://dasroot.net/posts/2026/01/building-production-web-services-rust-axum/)
- [FP Complete: Combining Axum, Hyper, Tonic, Tower](https://academy.fpblock.com/blog/axum-hyper-tonic-tower-part1/)
