# Validation Criteria — v0.1: Local Process Orchestration

## Standard Checks

These checks must ALL pass for the milestone to be considered complete.

### 1. Code Formatting
```bash
cargo fmt --check
```
**Pass criteria:** Exit code 0, no formatting differences reported.

### 2. Linting
```bash
cargo clippy -- -D warnings
```
**Pass criteria:** Exit code 0, no warnings or errors.

### 3. Compilation
```bash
cargo build
```
**Pass criteria:** Exit code 0, compiles without errors.

### 4. Unit Tests
```bash
cargo test
```
**Pass criteria:** Exit code 0, all unit tests pass. Zero test failures.

---

## Milestone-Specific Checks

### 5. Config Parsing Unit Tests
```bash
cargo test config -- --nocapture
```
**Pass criteria:** All config parsing tests pass, including:
- Minimal config (just `[project]` name)
- Full config with multiple services
- Fixed port parsing (`port = 3000`)
- Auto port parsing (`port = "auto"`)
- Invalid port string rejection
- Port out of range rejection
- Missing required fields error
- Service env and depends_on parsing

### 6. Config Validation Unit Tests
```bash
cargo test validate -- --nocapture
```
**Pass criteria:** All validation tests pass, including:
- Missing dependency reference detected
- Duplicate fixed port detected
- Dependency cycle detected
- Valid config passes validation
- Multiple errors collected simultaneously

### 7. Dependency Graph Unit Tests
```bash
cargo test graph -- --nocapture
```
**Pass criteria:** All dependency graph tests pass, including:
- Linear chain ordering (a→b→c yields c,b,a)
- Diamond dependency ordering
- Cycle detection with error message
- Self-loop detection
- No-dependency services (all valid orderings accepted)
- Empty config produces empty order

### 8. Project Identity Unit Tests
```bash
cargo test identity -- --nocapture
```
**Pass criteria:** All identity tests pass, including:
- Hash is deterministic (same path → same hash)
- Hash is exactly 8 hex characters
- Different paths produce different hashes
- Slug format is `{name}-{hash}`

### 9. Config Resolution Unit Tests
```bash
cargo test resolve -- --nocapture
```
**Pass criteria:** All resolution tests pass, including:
- Config found in current directory
- Config found in parent directory
- No config found returns appropriate error
- `-f` flag with valid path succeeds
- `-f` flag with invalid path errors

### 10. CLI Help Output
```bash
cargo run -- --help
cargo run -- start --help
cargo run -- ps --help
```
**Pass criteria:** All three commands exit 0 and display meaningful help text with subcommand descriptions.

### 11. Integration Tests
```bash
cargo test --features integration
```
**Pass criteria:** Exit code 0, all integration tests pass. This includes:
- Start/stop lifecycle (service starts, port reachable, stop releases port)
- `-f` flag loads alternate config file
- Process crash recovery (exited service is restarted)
- Port collision detection (clear error when port in use)
- Multi-instance isolation (two projects run independently)
- `ps --all` discovers multiple running instances
- Directory tree config discovery (finds config in parent)
- Label-scoped cleanup (delete only removes own resources)

### 12. Integration Test Cleanup Verification
After integration tests complete, verify no leaked resources:
```bash
# No orphaned test processes
! pgrep -f "devrig-test" 2>/dev/null
```
**Pass criteria:** No orphaned processes from test runs remain.

---

## Documentation Completeness Checks

### 13. README.md
```bash
test -f README.md && wc -l README.md
```
**Pass criteria:** File exists, is under 200 lines, contains quickstart section, example devrig.toml, and CLI command reference.

### 14. ADR Documents
```bash
test -f docs/adr/001-toml-only.md && \
test -f docs/adr/002-no-profiles.md && \
test -f docs/adr/003-isolated-kubeconfig.md && \
test -f docs/adr/004-compose-interop.md && \
test -f docs/adr/005-traefik-over-nginx.md && \
test -f docs/adr/006-in-memory-otel.md && \
test -f docs/adr/007-agent-browser-testing.md && \
test -f docs/adr/008-multi-instance-isolation.md && \
echo "All ADRs present"
```
**Pass criteria:** All 8 ADR files exist and each contains Context, Decision, and Consequences sections.

### 15. Architecture Documents
```bash
test -f docs/architecture/overview.md && \
test -f docs/architecture/config-model.md && \
test -f docs/architecture/dependency-graph.md && \
test -f docs/architecture/multi-instance.md && \
echo "All architecture docs present"
```
**Pass criteria:** All 4 architecture documents exist with substantive content (not just stubs).

### 16. Guide Documents
```bash
test -f docs/guides/getting-started.md && \
test -f docs/guides/configuration.md && \
test -f docs/guides/contributing.md && \
echo "All guides present"
```
**Pass criteria:** All 3 guides exist with substantive content.

---

## Structural Checks

### 17. Module Structure
```bash
test -f src/main.rs && \
test -f src/lib.rs && \
test -f src/cli.rs && \
test -f src/identity.rs && \
test -f src/config/mod.rs && \
test -f src/config/model.rs && \
test -f src/config/validate.rs && \
test -f src/config/resolve.rs && \
test -f src/orchestrator/mod.rs && \
test -f src/orchestrator/supervisor.rs && \
test -f src/orchestrator/graph.rs && \
test -f src/orchestrator/ports.rs && \
test -f src/orchestrator/state.rs && \
test -f src/orchestrator/registry.rs && \
test -f src/commands/mod.rs && \
test -f src/commands/ps.rs && \
test -f src/commands/init.rs && \
test -f src/commands/doctor.rs && \
test -f src/ui/mod.rs && \
test -f src/ui/logs.rs && \
test -f src/ui/summary.rs && \
echo "All source modules present"
```
**Pass criteria:** All source files in the planned module structure exist.

### 18. Test Structure
```bash
test -f tests/common/mod.rs && \
test -d tests/integration && \
echo "Test structure present"
```
**Pass criteria:** Test common helpers and integration test directory exist.

### 19. Cargo.toml Dependencies
```bash
grep -q 'clap' Cargo.toml && \
grep -q 'tokio' Cargo.toml && \
grep -q 'serde' Cargo.toml && \
grep -q 'toml' Cargo.toml && \
grep -q 'petgraph' Cargo.toml && \
grep -q 'sha2' Cargo.toml && \
grep -q 'nix' Cargo.toml && \
grep -q 'owo-colors' Cargo.toml && \
grep -q 'miette' Cargo.toml && \
grep -q 'thiserror' Cargo.toml && \
grep -q 'anyhow' Cargo.toml && \
grep -q 'tracing' Cargo.toml && \
grep -q 'assert_cmd' Cargo.toml && \
grep -q 'tempfile' Cargo.toml && \
echo "All required dependencies present"
```
**Pass criteria:** Cargo.toml includes all required dependencies from the research findings.

---

## Summary

| # | Check | Command | Critical |
|---|---|---|---|
| 1 | Formatting | `cargo fmt --check` | Yes |
| 2 | Linting | `cargo clippy -- -D warnings` | Yes |
| 3 | Compilation | `cargo build` | Yes |
| 4 | Unit tests | `cargo test` | Yes |
| 5 | Config parsing tests | `cargo test config` | Yes |
| 6 | Validation tests | `cargo test validate` | Yes |
| 7 | Graph tests | `cargo test graph` | Yes |
| 8 | Identity tests | `cargo test identity` | Yes |
| 9 | Resolution tests | `cargo test resolve` | Yes |
| 10 | CLI help | `cargo run -- --help` | Yes |
| 11 | Integration tests | `cargo test --features integration` | Yes |
| 12 | Cleanup verification | No orphaned processes | Yes |
| 13 | README.md | File exists, <200 lines | Yes |
| 14 | ADR documents | All 8 files exist | Yes |
| 15 | Architecture docs | All 4 files exist | Yes |
| 16 | Guide docs | All 3 files exist | Yes |
| 17 | Module structure | All source files exist | Yes |
| 18 | Test structure | Test dirs exist | Yes |
| 19 | Dependencies | All crates in Cargo.toml | Yes |

**Milestone passes if and only if ALL 19 checks pass.**
