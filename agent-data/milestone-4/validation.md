# Validation Criteria — v0.5: Observability + Dashboard

## Overview

This document defines the verification checks that must pass before milestone v0.5 is considered complete. Checks are organized into categories with clear pass/fail criteria.

---

## 1. Build Quality (5 checks)

### 1.1 Code Formatting
```bash
cargo fmt --check
```
**Pass:** Exit code 0, no formatting differences.

### 1.2 Clippy Lints
```bash
cargo clippy -- -D warnings
```
**Pass:** Exit code 0, zero warnings.

### 1.3 Cargo Build (default features)
```bash
cargo build
```
**Pass:** Compiles without errors.

### 1.4 Cargo Build (no dashboard feature)
```bash
cargo build --no-default-features
```
**Pass:** Compiles without errors when dashboard feature is disabled (if feature-gated).

### 1.5 Frontend Build
```bash
cd dashboard-ui && npm run build
```
**Pass:** Produces `dashboard-ui/dist/index.html` and associated assets.

---

## 2. Unit Tests (8 checks)

### 2.1 All Unit Tests Pass
```bash
cargo test
```
**Pass:** All tests pass (expect 180+ tests given v0.4 had 173).

### 2.2 Config Model Tests
```bash
cargo test config::model
```
**Pass:** DashboardConfig parsing tests pass — full config, minimal config, defaults, OtelConfig, retention string, backward compatibility (config without [dashboard] still parses).

### 2.3 Config Validation Tests
```bash
cargo test config::validate
```
**Pass:** Dashboard port conflict tests pass — dashboard port vs service port, OTLP ports vs infra ports, retention parse failure, all three dashboard/otel ports distinct.

### 2.4 OTel Storage Tests
```bash
cargo test otel::storage
```
**Pass:** Ring buffer tests pass — insert up to capacity, eviction cleans indexes, trace index grouping, error span index, service index, sweep_expired, capacity enforcement.

### 2.5 OTel Query Tests
```bash
cargo test otel::query
```
**Pass:** Query engine tests pass — trace list with service/status/duration filters, trace detail assembly, log search, metric discovery, related telemetry correlation.

### 2.6 OTel Type Conversion Tests
```bash
cargo test otel::types
```
**Pass:** Proto-to-internal conversion tests pass — trace ID hex encoding, service name extraction from resource attributes, timestamp conversion.

### 2.7 Query Output Tests
```bash
cargo test query::output
```
**Pass:** Output formatter tests pass — NDJSON format (one JSON object per line), table format (contains expected headers).

### 2.8 Template Interpolation Tests
```bash
cargo test config::interpolate
```
**Pass:** Dashboard template variable tests pass — dashboard.port, dashboard.otel.grpc_port, dashboard.otel.http_port resolve correctly.

---

## 3. Integration Tests (10 checks)

All integration tests require Docker and are gated behind `#[cfg(feature = "integration")]`.

### 3.1 OTLP Span Ingest
```bash
cargo test --features integration otel_ingest::otel_ingest_spans
```
**Pass:** Send ExportTraceServiceRequest via HTTP POST to OTLP endpoint → query traces via CLI → trace IDs appear in output.

### 3.2 OTLP Log Ingest
```bash
cargo test --features integration otel_ingest::otel_ingest_logs
```
**Pass:** Send ExportLogServiceRequest → query logs → log records appear.

### 3.3 OTLP Metric Ingest
```bash
cargo test --features integration otel_ingest::otel_ingest_metrics
```
**Pass:** Send ExportMetricsServiceRequest → query metrics → metric data appears.

### 3.4 OTEL Environment Injection
```bash
cargo test --features integration otel_ingest::otel_env_injection
```
**Pass:** Service env contains `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` when dashboard is configured.

### 3.5 Dashboard REST API
```bash
cargo test --features integration otel_ingest::dashboard_rest_api
```
**Pass:** GET /api/status returns 200 with JSON. GET /api/traces returns 200 with JSON array.

### 3.6 All Integration Tests Pass
```bash
cargo test --features integration
```
**Pass:** All integration tests pass (expect 50+ total including v0.4's 43).

### 3.7 No Docker Resource Leaks
```bash
# After all integration tests complete:
docker ps -a --filter "label=devrig.managed-by=devrig" --format '{{.Names}}' | grep -c "devrig-" || echo "0"
docker volume ls --filter "label=devrig.managed-by=devrig" --format '{{.Name}}' | grep -c "devrig-" || echo "0"
docker network ls --filter "label=devrig.managed-by=devrig" --format '{{.Name}}' | grep -c "devrig-" || echo "0"
```
**Pass:** All counts are 0 — no leaked containers, volumes, or networks.

### 3.8 Backwards Compatibility - Unit Tests
```bash
cargo test
```
**Pass:** All pre-existing v0.4 unit tests (173) still pass alongside new tests.

### 3.9 Backwards Compatibility - Integration Tests
```bash
cargo test --features integration start_stop
cargo test --features integration infra_lifecycle
cargo test --features integration service_discovery
```
**Pass:** Pre-existing integration tests pass unchanged.

### 3.10 Config Without Dashboard
```bash
# Verify a config with no [dashboard] section still works:
cargo test --features integration start_stop
```
**Pass:** Services start/stop correctly without dashboard configured. No errors about missing dashboard.

---

## 4. CLI Commands (6 checks)

### 4.1 Query Traces Command Registered
```bash
cargo run -- query traces --help
```
**Pass:** Shows help with flags: --service, --status, --min-duration, --last, --format, --limit.

### 4.2 Query Logs Command Registered
```bash
cargo run -- query logs --help
```
**Pass:** Shows help with flags: --service, --level, --search, --trace-id, --last, --format, --limit.

### 4.3 Query Metrics Command Registered
```bash
cargo run -- query metrics --help
```
**Pass:** Shows help with flags: --name, --service, --last, --format, --limit.

### 4.4 Query Status Command Registered
```bash
cargo run -- query status --help
```
**Pass:** Shows help with --format flag.

### 4.5 Query Trace Detail Command Registered
```bash
cargo run -- query trace --help
```
**Pass:** Shows help accepting a trace ID positional argument.

### 4.6 Query Related Command Registered
```bash
cargo run -- query related --help
```
**Pass:** Shows help accepting a trace ID positional argument.

---

## 5. Module Existence (8 checks)

### 5.1 OTel Module
```bash
test -f src/otel/mod.rs && test -f src/otel/storage.rs && test -f src/otel/types.rs && test -f src/otel/receiver_grpc.rs && test -f src/otel/receiver_http.rs && test -f src/otel/query.rs && echo "PASS"
```
**Pass:** All 6 otel source files exist.

### 5.2 Dashboard Module
```bash
test -f src/dashboard/mod.rs && test -f src/dashboard/ws.rs && test -f src/dashboard/static_files.rs && echo "PASS"
```
**Pass:** All 3 dashboard core files exist.

### 5.3 Dashboard Routes
```bash
test -f src/dashboard/routes/mod.rs && test -f src/dashboard/routes/traces.rs && test -f src/dashboard/routes/metrics.rs && test -f src/dashboard/routes/logs.rs && test -f src/dashboard/routes/status.rs && test -f src/dashboard/routes/env.rs && test -f src/dashboard/routes/services.rs && echo "PASS"
```
**Pass:** All 7 route files exist.

### 5.4 Query Module
```bash
test -f src/query/mod.rs && test -f src/query/output.rs && echo "PASS"
```
**Pass:** Both query files exist.

### 5.5 Query Command
```bash
test -f src/commands/query.rs && echo "PASS"
```
**Pass:** Query command handler exists.

### 5.6 Frontend Source
```bash
test -f dashboard-ui/src/index.tsx && test -f dashboard-ui/src/App.tsx && echo "PASS"
```
**Pass:** Frontend entry points exist.

### 5.7 Frontend Views
```bash
test -f dashboard-ui/src/views/Overview.tsx && test -f dashboard-ui/src/views/Traces.tsx && test -f dashboard-ui/src/views/TraceDetail.tsx && test -f dashboard-ui/src/views/Metrics.tsx && test -f dashboard-ui/src/views/Logs.tsx && echo "PASS"
```
**Pass:** All 5 view files exist.

### 5.8 Frontend Libs
```bash
test -f dashboard-ui/src/lib/api.ts && test -f dashboard-ui/src/lib/ws.ts && test -f dashboard-ui/src/lib/store.ts && test -f dashboard-ui/src/lib/theme.ts && echo "PASS"
```
**Pass:** All 4 lib files exist.

---

## 6. Crate and Feature Usage (6 checks)

### 6.1 Axum in Use
```bash
grep -r "axum::" src/dashboard/ | head -1
```
**Pass:** At least one file in dashboard module imports from axum.

### 6.2 Tonic in Use
```bash
grep -r "tonic::" src/otel/ | head -1
```
**Pass:** At least one file in otel module imports from tonic.

### 6.3 opentelemetry-proto in Use
```bash
grep -r "opentelemetry_proto" src/otel/ | head -1
```
**Pass:** At least one file in otel module uses opentelemetry_proto types.

### 6.4 rust-embed in Use
```bash
grep -r "rust_embed\|RustEmbed\|Embed" src/dashboard/static_files.rs | head -1
```
**Pass:** Static file handler uses rust-embed.

### 6.5 humantime in Use
```bash
grep -r "humantime" src/ | head -1
```
**Pass:** humantime is used for duration parsing (in query commands or validation).

### 6.6 TelemetryStore Uses RwLock
```bash
grep -r "RwLock" src/otel/ | head -1
```
**Pass:** TelemetryStore is wrapped in tokio RwLock for concurrent access.

---

## 7. Functional Behavior (7 checks)

### 7.1 DashboardConfig Parses Correctly
```bash
cargo test config::model::tests -- dashboard
```
**Pass:** Tests for DashboardConfig parsing pass (full config, defaults, backward compat).

### 7.2 TelemetryStore Ring Buffer Eviction
```bash
cargo test otel::storage -- evict
```
**Pass:** Inserting past capacity evicts oldest item and cleans up all index entries.

### 7.3 TelemetryStore Index Integrity
```bash
cargo test otel::storage -- index
```
**Pass:** After eviction, no dangling index entries remain. trace_index, service_index, error_spans are all consistent.

### 7.4 Proto-to-Internal Conversion
```bash
cargo test otel -- conversion
```
**Pass:** Trace ID bytes convert to correct hex string. Service name extracted from resource attributes. Timestamps convert correctly.

### 7.5 Query Filters Work
```bash
cargo test otel::query
```
**Pass:** Trace queries filter by service, status, min_duration. Log queries filter by severity, search text, trace_id. Metric queries filter by name, service.

### 7.6 NDJSON Output Format
```bash
cargo test query::output -- ndjson
```
**Pass:** NDJSON output has exactly one JSON object per line. Each line is valid JSON.

### 7.7 Startup Summary Shows Dashboard
Test: When config has `[dashboard]`, the startup summary output includes the dashboard URL and OTLP endpoints.
```bash
grep -r "Dashboard\|dashboard" src/ui/summary.rs | head -3
```
**Pass:** Summary module references dashboard for display.

---

## 8. E2E Tests (9 checks)

E2E test verification confirms tests are authored, discoverable by Playwright, and meet minimum coverage thresholds. Actual browser execution requires a running devrig stack and is performed in CI or manually via `cd e2e && npx playwright test`.

### 8.1 E2E Test Infrastructure
```bash
cd e2e && npm install && npx playwright install chromium
```
**Pass:** Playwright installed and ready.

### 8.2 Overview Status
```bash
cd e2e && npx playwright test --list dashboard/overview.test.ts 2>&1 | grep -c "›"
```
**Pass:** At least 8 overview tests are discoverable by Playwright (covers status heading, stat cards, service list, refresh, sidebar highlight, footer).

### 8.3 Trace Waterfall Rendering
```bash
cd e2e && npx playwright test --list dashboard/traces.test.ts 2>&1 | grep -c "›"
```
**Pass:** At least 8 trace tests are discoverable (covers heading, filter bar, table columns, trace detail, waterfall, span detail, tabs, navigation).

### 8.4 Metric Chart Discovery
```bash
cd e2e && npx playwright test --list dashboard/metrics.test.ts 2>&1 | grep -c "›"
```
**Pass:** At least 8 metric tests are discoverable (covers heading, filter bar, table columns, type badges, service filter, name filter, clear, count).

### 8.5 Log Filtering
```bash
cd e2e && npx playwright test --list dashboard/logs.test.ts 2>&1 | grep -c "›"
```
**Pass:** At least 8 log tests are discoverable (covers heading, filter bar, table columns, severity badges, severity filter, search, clear, trace links).

### 8.6 Trace Correlation Navigation
```bash
cd e2e && npx playwright test --list dashboard/trace-correlation.test.ts 2>&1 | grep -c "›"
```
**Pass:** At least 4 trace correlation tests are discoverable (covers trace link navigation, trace detail, related logs, related metrics, browser history).

### 8.7 Cmd+K Palette
```bash
cd e2e && npx playwright test --list dashboard/cmd-k.test.ts 2>&1 | grep -c "›"
```
**Pass:** At least 6 command palette tests are discoverable (covers open/close, search input, view listing, navigation, sidebar fallback, keyboard nav).

### 8.8 Dark/Light Toggle
```bash
cd e2e && npx playwright test --list dashboard/dark-light.test.ts 2>&1 | grep -c "›"
```
**Pass:** At least 6 theme toggle tests are discoverable (covers default dark mode, toggle button, light switch, persistence, localStorage, colors).

### 8.9 Real-time WebSocket Push
```bash
cd e2e && npx playwright test --list dashboard/realtime.test.ts 2>&1 | grep -c "›"
```
**Pass:** At least 5 real-time WebSocket tests are discoverable (covers connection, live indicator, trace/log/metric updates, reconnection, status bar).

---

## 9. Documentation (6 checks)

### 9.1 OTel Storage Architecture Doc
```bash
test -f docs/architecture/otel-storage.md && wc -l docs/architecture/otel-storage.md | awk '$1 >= 50'
```
**Pass:** File exists with at least 50 lines. Contains sections on: ring buffer design, secondary indexes, eviction strategy, retention, memory model, concurrency.

### 9.2 REST API Reference
```bash
test -f docs/api/rest-api.md && wc -l docs/api/rest-api.md | awk '$1 >= 100'
```
**Pass:** File exists with at least 100 lines. Documents all endpoints: /api/traces, /api/traces/{id}, /api/traces/{id}/related, /api/metrics, /api/logs, /api/status, /api/env, /api/env/{service}, /api/services/{name}/restart, /api/ws.

### 9.3 Query CLI Reference
```bash
test -f docs/api/query-cli.md && wc -l docs/api/query-cli.md | awk '$1 >= 80'
```
**Pass:** File exists with at least 80 lines. Documents: devrig query traces, trace, metrics, logs, status, related with flags and examples.

### 9.4 Configuration Guide Updated
```bash
grep -c "dashboard" docs/guides/configuration.md
```
**Pass:** At least 10 occurrences of "dashboard" in the configuration guide (covering [dashboard], [dashboard.otel], ports, retention, env vars, CLI commands).

### 9.5 REST API Doc Has Endpoints
```bash
grep -c "GET\|POST" docs/api/rest-api.md
```
**Pass:** At least 10 HTTP method references (covering all endpoints with examples).

### 9.6 Query CLI Doc Has Subcommands
```bash
grep -c "devrig query" docs/api/query-cli.md
```
**Pass:** At least 8 references to "devrig query" (covering all subcommands with examples).

---

## 10. New Dependency Verification (4 checks)

### 10.1 Axum Present in Cargo.toml
```bash
grep "axum" Cargo.toml
```
**Pass:** axum dependency with ws feature is listed.

### 10.2 Tonic Present in Cargo.toml
```bash
grep "tonic" Cargo.toml
```
**Pass:** tonic dependency is listed.

### 10.3 opentelemetry-proto Present in Cargo.toml
```bash
grep "opentelemetry-proto" Cargo.toml
```
**Pass:** opentelemetry-proto with gen-tonic, trace, metrics, logs features is listed.

### 10.4 rust-embed Present in Cargo.toml
```bash
grep "rust-embed" Cargo.toml
```
**Pass:** rust-embed with compression feature is listed.

---

## Summary

| Category | Checks | Description |
|---|---|---|
| Build Quality | 5 | fmt, clippy, cargo build (with/without dashboard), frontend build |
| Unit Tests | 8 | Config, storage, query, types, output, interpolation |
| Integration Tests | 10 | OTLP ingest (3 signals), env injection, REST API, backwards compat, leak check |
| CLI Commands | 6 | All query subcommands registered and accessible |
| Module Existence | 8 | All source files created in otel/, dashboard/, query/, dashboard-ui/ |
| Crate Usage | 6 | axum, tonic, opentelemetry-proto, rust-embed, humantime, RwLock |
| Functional Behavior | 7 | Ring buffer, indexes, conversion, queries, output format, summary |
| E2E Tests | 9 | Overview, traces, metrics, logs, correlation, cmd-k, theme, realtime |
| Documentation | 6 | Architecture, REST API, CLI reference, config guide |
| Dependencies | 4 | All new crates in Cargo.toml |
| **Total** | **69** | |

**Pass threshold:** All 69 checks must pass. The milestone is not complete until every check shows PASS.

**Execution order:** Run checks in category order (1 through 10). Build quality and unit tests should pass first. Integration tests require Docker. E2E tests require the full stack and are run last.
