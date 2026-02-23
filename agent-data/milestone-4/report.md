# Milestone Report: v0.5 — Observability + Dashboard

## Summary

Milestone v0.5 adds a built-in OpenTelemetry collector and web dashboard to devrig. The implementation introduces three new Rust modules (`otel`, `dashboard`, `query`), a SolidJS frontend application (`dashboard/`), and a new orchestrator phase (Phase 4.5) that starts the OTLP receivers and dashboard server before service spawning. All 69 verification checks pass, including 211 unit tests, 51 integration tests, and 76 discoverable Playwright E2E tests across 8 test files.

---

## Features Implemented

### 1. In-Process OTLP Receiver (gRPC + HTTP)
**Status:** Complete

An in-process OpenTelemetry collector accepts traces, metrics, and logs over both gRPC (port 4317) and HTTP (port 4318). The gRPC receiver implements tonic `TraceService`, `MetricsService`, and `LogsService` traits from `opentelemetry-proto`. The HTTP receiver provides Axum handlers at `/v1/traces`, `/v1/metrics`, `/v1/logs` supporting `application/x-protobuf` content type.

**Files:** `src/otel/receiver_grpc.rs`, `src/otel/receiver_http.rs`, `src/otel/mod.rs`

### 2. In-Memory Ring Buffer Storage
**Status:** Complete

Telemetry data is stored in `VecDeque`-based ring buffers with configurable capacity (default: 10K traces, 50K metric points, 100K log records). Secondary indexes provide efficient querying by trace ID, service name, error status, and log severity. Items are evicted on capacity overflow and by a background sweeper every 30 seconds for retention enforcement.

**Files:** `src/otel/storage.rs`, `src/otel/types.rs`, `src/otel/query.rs`

### 3. Auto-Injection of OTEL Environment Variables
**Status:** Complete

When `[dashboard]` is configured, all services automatically receive:
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:{http_port}`
- `OTEL_SERVICE_NAME={service_name}`
- `DEVRIG_DASHBOARD_URL=http://localhost:{dashboard_port}`

Injection occurs in Phase 4.5 of the orchestrator startup, before service spawning (Phase 5).

**Files:** `src/orchestrator/mod.rs` (lines 474–526), `src/discovery/env.rs`

### 4. Dashboard Backend (Axum)
**Status:** Complete

A single Axum server on the dashboard port (default 4000) serves the REST API, WebSocket endpoint, and embedded SPA. REST API routes cover all telemetry query operations plus service management.

**Endpoints:**
- `GET /api/traces`, `GET /api/traces/{trace_id}`, `GET /api/traces/{trace_id}/related`
- `GET /api/metrics`, `GET /api/logs`, `GET /api/status`
- `GET /api/env`, `GET /api/env/{service}`
- `POST /api/services/{name}/restart`, `POST /api/services/{name}/stop`
- `GET /api/ws` (WebSocket)

**Files:** `src/dashboard/mod.rs`, `src/dashboard/server.rs`, `src/dashboard/routes/` (7 files), `src/dashboard/ws.rs`, `src/dashboard/static_files.rs`

### 5. Dashboard Frontend (SolidJS + Vite + Tailwind)
**Status:** Complete

A SolidJS single-page application with five views:
- **StatusView** — Service/infra status cards with restart/stop controls
- **TracesView** — Trace list with service, status, and duration filters
- **TraceDetail** — Span waterfall visualization with parent-child nesting
- **MetricsView** — Metric discovery with name/service filtering
- **LogsView** — Structured log viewer with severity/search filtering

Additional components: sidebar navigation, status bar with WebSocket connectivity indicator, dark/light theme toggle (dark default, persisted to localStorage), Cmd+K command palette.

**Files:** `dashboard/src/` (15 source files), built output in `dashboard/dist/`

### 6. Real-Time Updates via WebSocket
**Status:** Complete

The OTLP receiver broadcasts `TelemetryEvent` messages via `tokio::sync::broadcast`. The WebSocket handler (`/api/ws`) subscribes to the broadcast channel and forwards events to connected browser clients. Events are batched at 100ms intervals. Slow clients (5s send timeout) are disconnected. The frontend reconnects automatically and shows a live/disconnected status indicator.

**Files:** `src/dashboard/ws.rs`, `dashboard/src/api.ts` (WebSocket client)

### 7. CLI Query Commands
**Status:** Complete

`devrig query` provides six subcommands that call the dashboard REST API:

| Subcommand | Purpose | Key Flags |
|---|---|---|
| `devrig query traces` | List traces with filters | `--service`, `--status`, `--min-duration`, `--last`, `--format`, `--limit` |
| `devrig query trace <ID>` | Get trace detail | `--format` |
| `devrig query metrics` | List metrics | `--name`, `--service`, `--last`, `--format`, `--limit` |
| `devrig query logs` | Search logs | `--service`, `--level`, `--search`, `--trace-id`, `--last`, `--format`, `--limit` |
| `devrig query status` | System status | `--format` |
| `devrig query related <ID>` | Related telemetry for a trace | `--format` |

Output formats: NDJSON (default), `json-pretty`, `table` (via `comfy-table`). Duration flags accept humantime strings (e.g., `5m`, `1h`).

**Files:** `src/commands/query.rs`, `src/query/mod.rs`, `src/query/output.rs`, `src/cli.rs`

### 8. Service Management from UI
**Status:** Complete

REST endpoints for `POST /api/services/{name}/restart` and `POST /api/services/{name}/stop` signal the orchestrator via command channel. The Overview page renders restart/stop buttons for each service.

**Files:** `src/dashboard/routes/services.rs`, `dashboard/src/views/StatusView.tsx`

### 9. Configuration
**Status:** Complete

New config sections with sensible defaults:

```toml
[dashboard]
port = 4000          # Dashboard web UI port
enabled = true       # Defaults to true when section present

[dashboard.otel]
grpc_port = 4317     # OTLP gRPC receiver port
http_port = 4318     # OTLP HTTP receiver port
trace_buffer = 10000 # Max stored traces
metric_buffer = 50000
log_buffer = 100000
retention = "1h"     # Time-based eviction window
```

Validation enforces: no port conflicts between dashboard/otel/services/infra, all three dashboard-related ports are distinct, retention string is parseable by `humantime`.

**Files:** `src/config/model.rs` (lines 170–193), `src/config/validate.rs`, `src/config/interpolate.rs`

---

## Architecture

### New Module Structure

Three new Rust modules were added to `src/lib.rs`:

| Module | Files | Purpose |
|---|---|---|
| `otel` | 6 files | OTLP receivers (gRPC + HTTP), ring buffer storage, query engine, internal types |
| `dashboard` | 11 files | Axum server, REST API routes (7), WebSocket handler, static file serving |
| `query` | 2 files | Output formatters (NDJSON, JSON-pretty, table) |

Plus `src/commands/query.rs` for CLI dispatch and `dashboard/` for the frontend SPA.

### Key Architectural Decisions

1. **Separate servers for gRPC and HTTP OTLP** — tonic on port 4317, Axum on port 4318. Avoids content-type sniffing and HTTP/2 multiplexing complexity. Both write to the same `TelemetryStore` via `Arc<RwLock<>>`.

2. **`VecDeque<T>` with manual capacity enforcement** — Chosen over dedicated ring buffer crates because the telemetry store needs secondary indexes (trace ID, service name, error status) that require coordinated insert/evict logic.

3. **`tokio::sync::RwLock<TelemetryStore>`** — Multiple concurrent readers (REST API, WebSocket, CLI) with brief write locks during OTLP ingest. Serialization and broadcast happen outside the lock.

4. **CLI queries via REST API** — `devrig query` commands make HTTP requests to the dashboard's REST endpoints rather than accessing in-process storage directly. Simpler architecture; dashboard must be running.

5. **Frontend embedded via `rust-embed`** — Debug mode reads from disk (supports `npm run dev` for frontend development). Release mode embeds `dashboard/dist/` at compile time. Feature-gated behind `#[cfg(feature = "dashboard")]`.

6. **Phase 4.5 in orchestrator pipeline** — Dashboard + OTLP collector start after port resolution (Phase 4) but before service spawning (Phase 5), ensuring `OTEL_EXPORTER_OTLP_ENDPOINT` points to a running receiver.

### Dependency Versions

| Crate | Version | Purpose |
|---|---|---|
| `axum` | 0.8 (features: `ws`) | Dashboard HTTP server, WebSocket |
| `tonic` | 0.12 | gRPC OTLP receiver |
| `prost` / `prost-types` | 0.13 | Protobuf encoding/decoding |
| `opentelemetry-proto` | 0.27 (features: `gen-tonic`, `trace`, `metrics`, `logs`, `with-serde`) | OTLP protobuf types |
| `tower-http` | 0.6 (features: `cors`, `compression-br`) | CORS, compression middleware |
| `rust-embed` | 8 (features: `compression`, `include-exclude`) | Embed SPA into binary |
| `humantime` | 2 | Parse duration strings |
| `dashmap` | 6 | Concurrent map for service phases |

Version rationale: tonic 0.12 + prost 0.13 + opentelemetry-proto 0.27 are the compatible set that works with hyper 1.x (shared with axum 0.8). Higher versions (tonic 0.14, opentelemetry-proto 0.31) were considered but these versions compiled cleanly together.

### Shared State

```rust
pub struct AppState {
    pub store: Arc<RwLock<TelemetryStore>>,
    pub events_tx: broadcast::Sender<TelemetryEvent>,
    pub config: Arc<DevrigConfig>,
    pub identity: Arc<ProjectIdentity>,
    pub resolved_ports: Arc<HashMap<String, u16>>,
    pub cancel: CancellationToken,
}
```

Constructed in Phase 4.5, shared across OTLP receivers, REST API, WebSocket handler, and service management endpoints.

---

## Tests

### Unit Tests — 211 total (38 new for v0.5)

| Module | Test Count | Key Tests |
|---|---|---|
| `config::model` | 44 | `parse_full_dashboard_config`, `parse_empty_dashboard_all_defaults`, `existing_config_without_dashboard_still_parses` |
| `config::validate` | 31 | `dashboard_port_conflicts_with_service`, `otel_ports_conflict_with_infra`, `dashboard_otel_ports_must_be_distinct`, `retention_parse_failure` |
| `config::interpolate` | 8 | `dashboard_template_vars` |
| `otel::storage` | 8 | `insert_past_capacity_evicts_oldest`, `index_cleanup_complete_after_eviction`, `trace_index_groups_spans`, `sweep_expired_removes_old` |
| `otel::query` | 8 | `query_traces_by_service`, `query_traces_by_error_status`, `query_traces_by_min_duration`, `query_logs_by_severity`, `query_logs_by_search_text`, `query_metrics_by_name`, `get_related_for_trace` |
| `otel::types` | 3 | `hex_encode_trace_id`, `nanos_to_datetime_conversion`, `severity_from_number` |
| `query::output` | 7 | `output_format_from_str`, `format_duration_*`, `format_metric_*` |

All 211 unit tests pass. The 173 pre-existing tests from v0.4 remain unchanged and passing.

### Integration Tests — 51 total (8 new for v0.5)

| Test | What It Verifies |
|---|---|
| `otel_ingest::otel_ingest_spans` | Send OTLP spans via HTTP, verify via query |
| `otel_ingest::otel_ingest_logs` | Send OTLP logs via HTTP, verify via query |
| `otel_ingest::otel_ingest_metrics` | Send OTLP metrics via HTTP, verify via query |
| `otel_ingest::otel_env_injection` | Services receive `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` |
| `dashboard_api::dashboard_status_endpoint_returns_empty_initially` | GET /api/status returns 200 with empty counts |
| `dashboard_api::dashboard_list_endpoints_return_empty` | GET /api/traces, /api/logs, /api/metrics return empty arrays |
| `dashboard_api::otlp_http_ingestion_and_dashboard_query` | End-to-end: ingest via OTLP HTTP, query via REST API |
| `dashboard_api::websocket_receives_trace_update_event` | WebSocket receives TelemetryEvent after OTLP ingest |

All 51 integration tests pass. The 43 pre-existing tests from v0.4 remain unchanged and passing (verified: `start_stop`, `infra_lifecycle`, `service_discovery`). No Docker resource leaks detected.

### E2E Tests (Playwright) — 76 tests across 8 files

| Test File | Tests | Coverage |
|---|---|---|
| `overview.test.ts` | 10 | Service status cards, stat cards, reporting services, refresh, auto-refresh |
| `traces.test.ts` | 11 | Trace table, filters, waterfall rendering, span detail panel |
| `metrics.test.ts` | 12 | Metric list, type badges, service/name filtering, empty state |
| `logs.test.ts` | 13 | Log lines, severity badges, severity/search filtering, trace links |
| `trace-correlation.test.ts` | 5 | Log-to-trace navigation, related logs/metrics tabs, browser history |
| `cmd-k.test.ts` | 8 | Palette open/close, view navigation, keyboard navigation |
| `dark-light.test.ts` | 9 | Default dark mode, toggle, persistence across refresh, localStorage |
| `realtime.test.ts` | 8 | WebSocket connection, live indicator, auto-refresh for traces/logs/metrics, reconnection |

All 76 tests are discoverable by Playwright (`npx playwright test --list`). Execution requires a running devrig stack with `[dashboard]` configured.

### Backwards Compatibility

- All 173 pre-v0.5 unit tests pass
- All 43 pre-v0.5 integration tests pass
- Configs without `[dashboard]` section parse and run correctly (verified via `start_stop_lifecycle` integration test)
- `cargo build --no-default-features` compiles without the dashboard feature

---

## Documentation

### New Files

| File | Lines | Content |
|---|---|---|
| `docs/architecture/otel-storage.md` | 226 | Ring buffer design, secondary indexes, eviction strategy, memory model (~110MB for defaults), concurrency approach (tokio RwLock), sweep interval |
| `docs/api/rest-api.md` | 407 | All REST endpoints with HTTP method, path, query parameters, response schemas, curl examples (11 endpoint references) |
| `docs/api/query-cli.md` | 284 | All `devrig query` subcommands with syntax, flags, output format examples, workflow examples (31 `devrig query` references) |

### Updated Files

| File | Changes |
|---|---|
| `docs/guides/configuration.md` | Added `[dashboard]` section (port, enabled), `[dashboard.otel]` section (grpc_port, http_port, trace_buffer, metric_buffer, log_buffer, retention), auto-injected environment variables documentation (16 dashboard references) |

---

## Verification Status

**Result: 69/69 checks passed, 0 failed, 0 skipped**

| Category | Checks | Passed |
|---|---|---|
| Build Quality | 5 | 5 |
| Unit Tests | 8 | 8 |
| Integration Tests | 10 | 10 |
| CLI Commands | 6 | 6 |
| Module Existence | 8 | 8 |
| Crate Usage | 6 | 6 |
| Functional Behavior | 7 | 7 |
| E2E Tests | 9 | 9 |
| Documentation | 6 | 6 |
| Dependencies | 4 | 4 |

Build quality: `cargo fmt --check` (clean), `cargo clippy -- -D warnings` (zero warnings), `cargo build` (success), `cargo build --no-default-features` (success), `npm run build` (success, 52.85 KB JS + 0.68 KB CSS).

---

## Known Issues

1. **E2E tests verify discoverability, not execution.** The 76 Playwright tests are verified as syntactically valid and discoverable (`npx playwright test --list`), but execution requires a running devrig stack with Docker infrastructure. CI execution requires a test harness that starts devrig with a `[dashboard]` config, sends synthetic OTLP data, runs tests, and tears down.

2. **Service management limited to restart/stop.** The `start` action for stopped services is defined in the API route but the underlying orchestrator command channel implementation focuses on restart (cancel supervisor + respawn). Full stop/start lifecycle management can be refined in a future milestone.

3. **Metric visualization is basic.** The Metrics view lists metrics with name/type/value and supports filtering, but does not render time-series charts with uPlot in v0.5. The research recommended starting with gauges and counters only; the current implementation shows metric data points in a table view.

4. **JSON OTLP content type.** The HTTP OTLP receiver supports `application/x-protobuf` (the primary format used by most OTLP clients). JSON support via the `with-serde` feature of `opentelemetry-proto` is available but less tested. Most real-world OTLP clients default to protobuf.

5. **Frontend directory naming.** The plan specified `dashboard-ui/` but the actual implementation uses `dashboard/`. All references in the codebase, rust-embed paths, and build scripts use the `dashboard/` name consistently.

---

## Next Milestone Context

### What the next milestone should know:

1. **Module locations:** OTel collector is in `src/otel/`, dashboard backend in `src/dashboard/`, query formatters in `src/query/`, CLI commands in `src/commands/query.rs`, frontend in `dashboard/`.

2. **Shared state pattern:** `AppState` (defined in `src/dashboard/mod.rs`) holds `Arc<RwLock<TelemetryStore>>` and `broadcast::Sender<TelemetryEvent>`. Any new real-time features should broadcast through the existing `TelemetryEvent` enum.

3. **Phase 4.5 in orchestrator:** Dashboard and OTLP collector start at `src/orchestrator/mod.rs:474–526`. New infrastructure that must be ready before services should integrate into this phase.

4. **Config model extension point:** `DashboardConfig` and `OtelConfig` are in `src/config/model.rs:170–193`. Both use `#[serde(default)]` for all fields, maintaining backwards compatibility.

5. **Test counts:** 211 unit tests, 51 integration tests, 76 E2E tests. New features should maintain or exceed these counts.

6. **Dependency versions:** axum 0.8, tonic 0.12, prost 0.13, opentelemetry-proto 0.27. These are a compatible set sharing hyper 1.x. Upgrading any of these requires verifying the others still compile.

7. **Feature gate:** The dashboard is behind `#[cfg(feature = "dashboard")]` (default feature). `cargo build --no-default-features` must continue to compile.

8. **Frontend build:** `cd dashboard && npm run build` produces `dashboard/dist/`. The built output is embedded via `rust-embed`. Frontend development uses `npm run dev` with rust-embed's debug-mode disk reads.

9. **Port defaults:** Dashboard 4000, OTLP gRPC 4317, OTLP HTTP 4318. All configurable and validated for conflicts with service/infra ports.

10. **WebSocket protocol:** Events are JSON-serialized `TelemetryEvent` variants with `{ "type": "...", "payload": {...} }` tagged format. Clients connect to `/api/ws`. Events are batched at 100ms intervals.
