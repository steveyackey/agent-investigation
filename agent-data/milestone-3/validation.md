# Validation Criteria — v0.4: Developer Experience Polish

## Standard Checks

### 1. Formatting
```bash
cargo fmt --check
```
**Pass criteria:** Zero formatting differences. Exit code 0.

### 2. Linting
```bash
cargo clippy -- -D warnings
```
**Pass criteria:** Zero warnings. Exit code 0.

### 3. Build
```bash
cargo build
```
**Pass criteria:** Clean build with no errors. Exit code 0.

### 4. Unit Tests
```bash
cargo test
```
**Pass criteria:** All unit tests pass. Zero failures. This includes all pre-existing tests from v0.1/v0.2/v0.3 (backwards compatibility).

### 5. Integration Tests
```bash
cargo test --features integration
```
**Pass criteria:** All integration tests pass, including all pre-existing tests from v0.1/v0.2/v0.3 and all new v0.4 tests.

---

## Milestone-Specific Checks

### 6. New Dependencies Present
```bash
grep 'clap_complete' Cargo.toml && grep 'strsim' Cargo.toml && grep 'comfy-table' Cargo.toml
```
**Pass criteria:** All three crates appear in Cargo.toml [dependencies].

### 7. CLI Commands Registered
```bash
cargo run -- validate --help 2>&1 | head -1
cargo run -- logs --help 2>&1 | head -1
cargo run -- completions --help 2>&1 | head -1
```
**Pass criteria:** All three commands produce help output (not "unrecognized subcommand"). Exit code 0 for each.

### 8. Validate Command — Valid Config
```bash
echo '[project]\nname = "test"\n[services.api]\ncommand = "echo hi"\nport = 3000' > /tmp/devrig-test-valid.toml
cargo run -- -f /tmp/devrig-test-valid.toml validate
```
**Pass criteria:** Exit code 0. Output contains a success confirmation message.

### 9. Validate Command — Invalid Config
```bash
echo '[project]\nname = "test"\n[services.api]\ncommand = "echo hi"\ndepends_on = ["nonexistent"]' > /tmp/devrig-test-invalid.toml
cargo run -- -f /tmp/devrig-test-invalid.toml validate; echo "exit: $?"
```
**Pass criteria:** Exit code non-zero. Output contains diagnostic information including the word "nonexistent" and a source span or line reference. If a similar service name exists, output includes a "did you mean?" suggestion.

### 10. Shell Completions Output
```bash
cargo run -- completions bash | wc -l
cargo run -- completions zsh | wc -l
cargo run -- completions fish | wc -l
```
**Pass criteria:** Each command produces at least 10 lines of output. The output contains "devrig" somewhere in the completion script.

### 11. RestartConfig Parsing
```bash
echo '[project]
name = "test"
[services.api]
command = "echo hi"
[services.api.restart]
policy = "on-failure"
max_restarts = 5
initial_delay_ms = 1000' > /tmp/devrig-test-restart.toml
cargo run -- -f /tmp/devrig-test-restart.toml validate
```
**Pass criteria:** Exit code 0. The restart config section parses without error.

### 12. New Source Files Exist
```bash
test -f src/commands/validate.rs && \
test -f src/commands/logs.rs && \
test -f src/config/watcher.rs && \
test -f src/config/diff.rs && \
test -f src/ui/filter.rs && \
test -f src/ui/buffer.rs && \
echo "All files present"
```
**Pass criteria:** All six new source files exist.

### 13. Miette Actually Used
```bash
grep -r 'miette::Diagnostic' src/config/validate.rs
grep -r 'NamedSource' src/config/validate.rs
grep -r 'SourceSpan' src/config/validate.rs
```
**Pass criteria:** All three patterns found in validate.rs, confirming miette diagnostics are implemented (not just the crate being listed in Cargo.toml as before).

### 14. owo-colors Actually Used
```bash
grep -r 'owo_colors' src/ui/logs.rs
grep -r 'owo_colors' src/ui/summary.rs
```
**Pass criteria:** Both files import and use owo-colors (not raw ANSI escape codes).

### 15. comfy-table Used in Summary
```bash
grep -r 'comfy_table' src/ui/summary.rs
```
**Pass criteria:** comfy-table is imported and used in the startup summary.

### 16. Broadcast Channel Used for Logs
```bash
grep -r 'broadcast' src/orchestrator/mod.rs
grep -r 'broadcast' src/ui/logs.rs
```
**Pass criteria:** The orchestrator uses broadcast::channel (not mpsc) for log distribution, and LogWriter accepts a broadcast::Receiver.

### 17. LogLine Has Timestamp and Level
```bash
grep 'timestamp' src/ui/logs.rs
grep 'LogLevel' src/ui/logs.rs
```
**Pass criteria:** LogLine struct includes timestamp and level fields. LogLevel enum is defined.

### 18. JSONL Log File Written
```bash
grep 'current.jsonl' src/orchestrator/mod.rs
```
**Pass criteria:** The orchestrator creates a JSONL log writer that writes to .devrig/logs/current.jsonl.

### 19. Config Watcher Implemented
```bash
grep 'notify' src/config/watcher.rs
grep 'DebouncedEvent\|DebounceEventResult' src/config/watcher.rs
```
**Pass criteria:** Config watcher uses notify crate with debouncing.

### 20. Config Diff Implemented
```bash
grep 'ConfigDiff' src/config/diff.rs
grep 'services_added\|services_removed\|services_changed' src/config/diff.rs
```
**Pass criteria:** ConfigDiff struct exists with fields for tracking added/removed/changed services.

### 21. Supervisor Has ServicePhase
```bash
grep 'ServicePhase' src/orchestrator/supervisor.rs
grep 'RestartMode' src/orchestrator/supervisor.rs
grep 'startup_grace' src/orchestrator/supervisor.rs
```
**Pass criteria:** ServicePhase enum, RestartMode enum, and startup_grace field all present in supervisor.rs.

---

## Backwards Compatibility Checks

### 22. Pre-existing Unit Tests Pass
```bash
cargo test config::model -- --test-threads=1 2>&1 | tail -1
cargo test config::validate -- --test-threads=1 2>&1 | tail -1
cargo test config::interpolate -- --test-threads=1 2>&1 | tail -1
cargo test orchestrator::graph -- --test-threads=1 2>&1 | tail -1
cargo test orchestrator::supervisor -- --test-threads=1 2>&1 | tail -1
cargo test identity -- --test-threads=1 2>&1 | tail -1
```
**Pass criteria:** All existing test modules pass with zero failures. The validate() signature change must not break existing test assertions.

### 23. Pre-existing Integration Tests Pass
```bash
cargo test --features integration -- start_stop 2>&1 | tail -3
cargo test --features integration -- infra_lifecycle 2>&1 | tail -3
cargo test --features integration -- service_discovery 2>&1 | tail -3
```
**Pass criteria:** Sample of pre-existing integration tests still pass.

---

## Documentation Checks

### 24. Configuration Guide Updated
```bash
grep -c 'restart' docs/guides/configuration.md
grep 'devrig validate' docs/guides/configuration.md
grep 'devrig logs' docs/guides/configuration.md
grep 'devrig completions' docs/guides/configuration.md
```
**Pass criteria:** Configuration guide mentions restart config, and all three new commands (validate, logs, completions).

---

## New Unit Test Coverage

### 25. Validation Tests
```bash
cargo test config::validate 2>&1 | grep 'test result'
```
**Pass criteria:** At least 12 tests pass (original 7+ from v0.3, plus new miette diagnostic tests).

### 26. Config Diff Tests
```bash
cargo test config::diff 2>&1 | grep 'test result'
```
**Pass criteria:** At least 5 tests pass covering: no changes, added, removed, changed, project name change.

### 27. Supervisor Tests
```bash
cargo test orchestrator::supervisor 2>&1 | grep 'test result'
```
**Pass criteria:** At least 8 tests pass (original 5, plus new phase/mode/grace tests).

### 28. Filter Tests
```bash
cargo test ui::filter 2>&1 | grep 'test result'
```
**Pass criteria:** At least 4 tests pass covering service, level, regex, and combined filters.

### 29. Buffer Tests
```bash
cargo test ui::buffer 2>&1 | grep 'test result'
```
**Pass criteria:** At least 3 tests pass covering capacity, eviction, and time queries.

### 30. Log Level Detection Tests
```bash
cargo test ui::logs 2>&1 | grep 'test result'
```
**Pass criteria:** At least 4 tests pass covering various log level format detection.

---

## New Integration Test Coverage

### 31. Validate Command Tests
```bash
cargo test --features integration -- validate_command 2>&1 | grep 'test result'
```
**Pass criteria:** At least 2 tests pass (valid config, invalid config).

### 32. Completions Tests
```bash
cargo test --features integration -- completions 2>&1 | grep 'test result'
```
**Pass criteria:** At least 3 tests pass (bash, zsh, fish).

### 33. Crash Recovery v2 Tests
```bash
cargo test --features integration -- crash_recovery 2>&1 | grep 'test result'
```
**Pass criteria:** At least 2 tests pass (restart on failure, behavior with different exit codes).

---

## Resource Leak Check

### 34. No Leaked Docker Resources
```bash
docker ps -a --filter "label=devrig.managed-by=devrig" --filter "label=devrig.project" --format "{{.Names}}" | grep -c "devrig-test" || echo "0 leaked containers"
docker volume ls --filter "label=devrig.managed-by=devrig" --format "{{.Name}}" | grep -c "devrig-test" || echo "0 leaked volumes"
docker network ls --filter "label=devrig.managed-by=devrig" --format "{{.Name}}" | grep -c "devrig-test" || echo "0 leaked networks"
```
**Pass criteria:** Zero leaked test containers, volumes, and networks after all integration tests complete.

---

## Summary

| Category | Checks | IDs |
|----------|--------|-----|
| Standard (fmt, clippy, build, test) | 5 | 1-5 |
| New dependencies & files | 3 | 6, 12, 13 |
| CLI commands work | 4 | 7, 8, 9, 10 |
| Feature implementation verified | 9 | 11, 14-21 |
| Backwards compatibility | 2 | 22, 23 |
| Documentation | 1 | 24 |
| New unit test coverage | 6 | 25-30 |
| New integration test coverage | 3 | 31-33 |
| Resource leaks | 1 | 34 |
| **Total** | **34** | |
