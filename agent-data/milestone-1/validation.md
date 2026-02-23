# Validation Criteria — v0.2: Infrastructure Containers

## Standard Checks

These checks must all pass before the milestone is considered complete.

### 1. Formatting

```bash
cargo fmt --check
```

**Expected:** No formatting differences. Exit code 0.

### 2. Linting

```bash
cargo clippy -- -D warnings
```

**Expected:** Zero warnings, zero errors. Exit code 0.

### 3. Build

```bash
cargo build
```

**Expected:** Clean build with no errors. Exit code 0.

### 4. Unit Tests

```bash
cargo test
```

**Expected:** All unit tests pass. This includes:

| Module | Minimum Test Count | Key Coverage |
|---|---|---|
| `config::model` | 15 (existing) + 8 (new) | InfraConfig parsing, ComposeConfig parsing, ReadyCheck variants (all 5), named ports, backwards compat |
| `config::validate` | 7 (existing) + 5 (new) | Cross-type dependency refs, infra port conflicts, empty image, compose validation |
| `config::interpolate` | 7 (new) | Template resolution, missing var errors, no-op, whitespace handling, var map building |
| `orchestrator::graph` | 8 (existing, updated) + 4 (new) | Mixed resource types, cross-type dependencies, infra as leaf nodes |
| `orchestrator::supervisor` | 5 (existing) | Unchanged |
| `discovery::url` | 5 (new) | postgres URL with/without password, redis URL, http default, multi-port |
| `discovery::env` | 4 (new) | DEVRIG_* generation, named ports, own PORT/HOST, override precedence |

---

## Integration Tests

All integration tests require Docker and are gated behind the `integration` feature flag.

```bash
cargo test --features integration
```

### Docker Prerequisite Check

Before running integration tests, verify Docker is available:

```bash
docker info > /dev/null 2>&1 && echo "Docker available" || echo "Docker NOT available"
```

### Infrastructure Lifecycle Tests

```bash
cargo test --features integration -- infra_lifecycle
```

| Test | Validates |
|---|---|
| `postgres_lifecycle` | Start postgres container with pg_isready ready check. Verify TCP connectivity to the assigned port. Stop. Verify container is removed from Docker. |
| `redis_lifecycle` | Start redis container with cmd ready check (redis-cli ping). Verify TCP connectivity. Stop. Verify container removed. |

### Ready Check Tests

```bash
cargo test --features integration -- ready_checks
```

| Test | Validates |
|---|---|
| `ready_check_pg_isready` | pg_isready succeeds after postgres container starts |
| `ready_check_cmd` | Custom command (redis-cli ping) returns PONG via expect matching |
| `ready_check_tcp` | TCP port check succeeds when container port is open |
| `ready_check_http` | HTTP endpoint check returns 2xx (tested against a container with HTTP endpoint) |
| `ready_check_log` | Log pattern match detects readiness string in container output |

### Init Script Tests

```bash
cargo test --features integration -- init_scripts
```

| Test | Validates |
|---|---|
| `init_scripts_run_once` | Init SQL runs on first start (verified by querying table existence). Skipped on restart (init_completed = true). Runs again after `devrig reset`. |

### Service Discovery Tests

```bash
cargo test --features integration -- service_discovery
```

| Test | Validates |
|---|---|
| `devrig_vars_injected` | Service process receives DEVRIG_POSTGRES_HOST, DEVRIG_POSTGRES_PORT, DEVRIG_POSTGRES_URL |
| `url_generation_correctness` | postgres:// URL includes user:pass, redis:// URL is correct, http:// default works |
| `devrig_env_output` | `devrig env <service>` CLI outputs correct resolved DEVRIG_* variables |
| `auto_port_persistence` | Auto-assigned port persists across stop/start cycles |
| `template_resolution` | `{{ infra.postgres.port }}` in service env resolves to actual postgres port |

### Compose Interop Tests

```bash
cargo test --features integration -- compose_interop
```

| Test | Validates |
|---|---|
| `compose_basic` | Compose services start via docker compose, connect to devrig network, DEVRIG_* vars generated |
| `compose_native_coexistence` | Compose postgres + native redis on same network, services can discover both |

### Cleanup Tests

```bash
cargo test --features integration -- volume_cleanup network_tests leaked_resources
```

| Test | Validates |
|---|---|
| `volume_cleanup` | `devrig delete` removes all project-scoped Docker volumes |
| `network_isolation` | Two devrig projects have separate networks, no cross-contamination |
| `no_leaked_resources` | After delete, zero Docker containers, volumes, or networks with matching `devrig.project` label remain |

---

## Leaked Resource Verification

After ALL integration tests complete, verify no test resources leaked:

```bash
# No containers with devrig test labels
docker ps -a --filter "label=devrig.managed-by=devrig" --format "{{.Names}}" | grep "devrig-test-" && echo "LEAKED CONTAINERS" || echo "No leaked containers"

# No volumes with devrig test labels
docker volume ls --filter "label=devrig.managed-by=devrig" --format "{{.Name}}" | grep "devrig-test-" && echo "LEAKED VOLUMES" || echo "No leaked volumes"

# No networks with devrig test labels
docker network ls --filter "label=devrig.managed-by=devrig" --format "{{.Name}}" | grep "devrig-test-" && echo "LEAKED NETWORKS" || echo "No leaked networks"
```

**Expected:** All three report no leaked resources.

---

## Module Structure Verification

Verify all required source files exist:

```bash
# New modules
test -f src/infra/mod.rs && echo "OK: infra/mod.rs" || echo "MISSING: infra/mod.rs"
test -f src/infra/container.rs && echo "OK: infra/container.rs" || echo "MISSING: infra/container.rs"
test -f src/infra/image.rs && echo "OK: infra/image.rs" || echo "MISSING: infra/image.rs"
test -f src/infra/volume.rs && echo "OK: infra/volume.rs" || echo "MISSING: infra/volume.rs"
test -f src/infra/network.rs && echo "OK: infra/network.rs" || echo "MISSING: infra/network.rs"
test -f src/infra/exec.rs && echo "OK: infra/exec.rs" || echo "MISSING: infra/exec.rs"
test -f src/infra/ready.rs && echo "OK: infra/ready.rs" || echo "MISSING: infra/ready.rs"
test -f src/compose/mod.rs && echo "OK: compose/mod.rs" || echo "MISSING: compose/mod.rs"
test -f src/compose/lifecycle.rs && echo "OK: compose/lifecycle.rs" || echo "MISSING: compose/lifecycle.rs"
test -f src/compose/bridge.rs && echo "OK: compose/bridge.rs" || echo "MISSING: compose/bridge.rs"
test -f src/discovery/mod.rs && echo "OK: discovery/mod.rs" || echo "MISSING: discovery/mod.rs"
test -f src/discovery/env.rs && echo "OK: discovery/env.rs" || echo "MISSING: discovery/env.rs"
test -f src/discovery/url.rs && echo "OK: discovery/url.rs" || echo "MISSING: discovery/url.rs"
test -f src/config/interpolate.rs && echo "OK: config/interpolate.rs" || echo "MISSING: config/interpolate.rs"
test -f src/commands/env.rs && echo "OK: commands/env.rs" || echo "MISSING: commands/env.rs"
test -f src/commands/exec.rs && echo "OK: commands/exec.rs" || echo "MISSING: commands/exec.rs"
test -f src/commands/reset.rs && echo "OK: commands/reset.rs" || echo "MISSING: commands/reset.rs"
```

**Expected:** All files report "OK".

---

## CLI Verification

Verify new CLI commands are registered and accessible:

```bash
cargo run -- --help 2>&1 | grep -q "env" && echo "OK: env command" || echo "MISSING: env command"
cargo run -- --help 2>&1 | grep -q "exec" && echo "OK: exec command" || echo "MISSING: exec command"
cargo run -- --help 2>&1 | grep -q "reset" && echo "OK: reset command" || echo "MISSING: reset command"
cargo run -- env --help 2>&1 && echo "OK: env --help" || echo "FAIL: env --help"
cargo run -- exec --help 2>&1 && echo "OK: exec --help" || echo "FAIL: exec --help"
cargo run -- reset --help 2>&1 && echo "OK: reset --help" || echo "FAIL: reset --help"
```

**Expected:** All commands appear in help and have their own help text.

---

## Config Backwards Compatibility

Verify that a v0.1-style config (no infra, no compose) still parses and works:

```bash
cargo test config::model::tests::parse_minimal_config
cargo test config::model::tests::parse_full_config
```

**Expected:** All existing config model tests pass unchanged. The new `infra`, `compose`, and `network` fields default to empty/None via `#[serde(default)]`.

---

## Documentation Completeness

```bash
# New docs
test -f docs/architecture/service-discovery.md && echo "OK" || echo "MISSING: service-discovery.md"
test -f docs/guides/compose-migration.md && echo "OK" || echo "MISSING: compose-migration.md"

# Updated docs (check for new content)
grep -q "infra" docs/guides/configuration.md && echo "OK: config guide has infra" || echo "MISSING: infra in config guide"
grep -q "compose" docs/guides/configuration.md && echo "OK: config guide has compose" || echo "MISSING: compose in config guide"
grep -q "DEVRIG_" docs/guides/configuration.md && echo "OK: config guide has DEVRIG vars" || echo "MISSING: DEVRIG vars in config guide"
grep -q "template" docs/guides/configuration.md && echo "OK: config guide has templates" || echo "MISSING: templates in config guide"
grep -q "ready_check" docs/guides/configuration.md && echo "OK: config guide has ready checks" || echo "MISSING: ready checks in config guide"
```

**Expected:** All documentation files exist and contain the required content.

### Documentation Content Requirements

**docs/architecture/service-discovery.md** must cover:
- How DEVRIG_* environment variables are generated
- Variable naming convention (DEVRIG_{UPPER_NAME}_HOST, _PORT, _URL, _PORT_{UPPER_PORTNAME})
- URL generation rules with image-name heuristics
- Template expression syntax (`{{ path.to.value }}`)
- Resolution order (ports resolved before templates)
- Integration with the orchestrator phase pipeline

**docs/guides/compose-migration.md** must cover:
- When to use `[compose]` vs native `[infra.*]`
- Example configuration for compose interop
- Coexistence: compose + native infra on shared network
- Ready checks for compose-managed services
- Migration path from compose to native infra

**docs/guides/configuration.md** must be updated with:
- `[infra.*]` section reference (all fields: image, port, ports, env, volumes, ready_check, init)
- `[compose]` section reference (file, services, env_file, ready_checks)
- Ready check type reference (pg_isready, cmd, http, tcp, log) with examples
- Init script documentation
- Service discovery variables (DEVRIG_*) with full naming convention
- Template expressions with examples
- `port = "auto"` for infra services
- `devrig env`, `devrig exec`, `devrig reset` command reference

---

## Dependency Verification

```bash
# Verify new dependencies are in Cargo.toml
grep -q 'bollard' Cargo.toml && echo "OK: bollard" || echo "MISSING: bollard"
grep -q 'futures-util' Cargo.toml && echo "OK: futures-util" || echo "MISSING: futures-util"
grep -q 'reqwest' Cargo.toml && echo "OK: reqwest" || echo "MISSING: reqwest"
grep -q 'backon' Cargo.toml && echo "OK: backon" || echo "MISSING: backon"
```

**Expected:** All four new dependencies present.

---

## Full Validation Sequence

Run all checks in order:

```bash
# 1. Format check
cargo fmt --check

# 2. Lint check
cargo clippy -- -D warnings

# 3. Build
cargo build

# 4. Unit tests
cargo test

# 5. Integration tests (requires Docker)
cargo test --features integration

# 6. CLI smoke test
cargo run -- --help
cargo run -- env --help
cargo run -- exec --help
cargo run -- reset --help

# 7. Module structure check
for f in src/infra/mod.rs src/infra/container.rs src/infra/image.rs src/infra/volume.rs \
         src/infra/network.rs src/infra/exec.rs src/infra/ready.rs \
         src/compose/mod.rs src/compose/lifecycle.rs src/compose/bridge.rs \
         src/discovery/mod.rs src/discovery/env.rs src/discovery/url.rs \
         src/config/interpolate.rs \
         src/commands/env.rs src/commands/exec.rs src/commands/reset.rs; do
  test -f "$f" && echo "OK: $f" || echo "MISSING: $f"
done

# 8. Documentation check
for f in docs/architecture/service-discovery.md docs/guides/compose-migration.md; do
  test -f "$f" && echo "OK: $f" || echo "MISSING: $f"
done

# 9. Leaked resource check (after integration tests)
docker ps -a --filter "label=devrig.managed-by=devrig" --format "{{.Names}}" | grep -c "devrig-test-" | grep -q "^0$" && echo "OK: no leaked containers" || echo "FAIL: leaked containers"
docker volume ls --filter "label=devrig.managed-by=devrig" --format "{{.Name}}" | grep -c "devrig-test-" | grep -q "^0$" && echo "OK: no leaked volumes" || echo "FAIL: leaked volumes"
docker network ls --filter "label=devrig.managed-by=devrig" --format "{{.Name}}" | grep -c "devrig-test-" | grep -q "^0$" && echo "OK: no leaked networks" || echo "FAIL: leaked networks"
```

**All checks must pass for milestone v0.2 to be considered complete.**
