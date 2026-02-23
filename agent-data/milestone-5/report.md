# Milestone v0.6 Report — Claude Code Skill + Cluster Addons

## Summary

Milestone v0.6 adds four features to devrig: a Claude Code skill (`skill/claude-code/SKILL.md`) that gives Claude full observability query workflow guidance, a `devrig skill install` CLI command for project-local and global installation, `[cluster.addons.*]` configuration supporting Helm charts, raw manifests, and Kustomize overlays with automatic port-forwarding for addon UIs, and a config editor in the dashboard built on CodeMirror 6 with real-time TOML validation. The implementation required 11 new files and modifications to 20 existing files, growing the test suite from 211 to 228 unit tests while adding 2 integration tests, 3 addon lifecycle tests, and 3 Playwright E2E tests.

## Features Implemented

### 1. Claude Code Skill — COMPLETE

A Claude Code skill ships with devrig at `skill/claude-code/SKILL.md` (161 lines). The skill uses the Agent Skills frontmatter format with `name: devrig`, a comprehensive trigger description covering service health, errors, performance, traces, logs, and metrics, and `allowed-tools: Bash(devrig *)` for auto-approval of devrig CLI invocations. The body contains all `devrig query` subcommands (traces, trace, logs, metrics, status, related) with 21 command references, plus three structured workflows for debugging performance issues, investigating errors, and checking system health. No helper script was needed — Claude runs `devrig query` commands directly.

**Key files:** `skill/claude-code/SKILL.md`

### 2. `devrig skill install` Command — COMPLETE

The `devrig skill install` command copies the embedded SKILL.md to `.claude/skills/devrig/` (project-local, default) or `~/.claude/skills/devrig/` (`--global` flag). Skill files are embedded in the binary via `include_str!()` for `cargo install` distribution. The command is idempotent — re-installation overwrites existing files. Installation prints a success message with the target path and an example prompt.

**Key files:** `src/commands/skill.rs`, `src/cli.rs`, `src/main.rs`, `src/commands/mod.rs`

### 3. Cluster Addons — COMPLETE

The `[cluster.addons.*]` configuration supports three addon types via a `#[serde(tag = "type")]` enum:

- **Helm:** `chart`, `repo`, `namespace`, `version`, `values` (mapped to `--set` flags), `port_forward`
- **Manifest:** `path`, `namespace`, `port_forward`
- **Kustomize:** `path`, `namespace`, `port_forward`

Addons install in Phase 3.5 of the orchestrator (after cluster creation, before service deploy) using the established shell-out pattern (`helm upgrade --install` for idempotency, `kubectl apply -f/-k` for manifests/kustomize). Port-forwards run as tracked tasks with exponential backoff reconnection loops (1s to 30s max) using `CancellationToken` + `TaskTracker`. On `devrig stop`, port-forwards are cancelled but addons remain running (cluster preserved). On `devrig delete`, addons are uninstalled before cluster deletion.

The `devrig doctor` command now checks for `helm` in PATH.

**Key files:** `src/cluster/addon.rs`, `src/cluster/mod.rs`, `src/config/model.rs`, `src/config/validate.rs`, `src/orchestrator/mod.rs`, `src/orchestrator/state.rs`, `src/commands/doctor.rs`

### 4. Config Editor in Dashboard — COMPLETE

The dashboard includes a config editor at `/#/config` built on CodeMirror 6 with:

- **TOML syntax highlighting** via `@codemirror/legacy-modes` StreamLanguage
- **Dual-layer validation:** client-side syntax checking with `smol-toml` (300ms debounce) and server-side semantic validation via `POST /api/config/validate` (800ms debounce) using the existing Rust `validate()` function
- **Optimistic concurrency:** SHA-256 content hash checked on save; 409 Conflict returned if file changed externally
- **Atomic saves:** write to `.tmp`, rename, with `.bak` backup creation
- **Dark theme** via `@codemirror/theme-one-dark` matching the dashboard's zinc-900 aesthetic

Backend endpoints: `GET /api/config` (read + hash), `POST /api/config/validate` (validate without saving), `PUT /api/config` (save with hash check).

**Key files:** `src/dashboard/routes/config.rs`, `src/dashboard/routes/mod.rs`, `src/dashboard/server.rs`, `dashboard/src/components/ConfigEditor.tsx`, `dashboard/src/views/ConfigView.tsx`, `dashboard/src/api.ts`, `dashboard/src/App.tsx`, `dashboard/src/components/Sidebar.tsx`

## Architecture

### Key Structural Decisions

1. **No new Rust crate dependencies.** All addon and skill functionality is implemented using existing dependencies (`tokio`, `serde`, `toml`, `sha2`, `tokio-util`, `backon`). Addon management shells out to `helm` and `kubectl` matching the established pattern for `k3d`, `docker compose`, and `docker build`.

2. **Skill files embedded via `include_str!()`** rather than runtime filesystem resolution. This ensures `cargo install devrig` produces a self-contained binary. The embedded content is written to disk by `devrig skill install`.

3. **Serde tag-based enum for addon types** (`#[serde(tag = "type")]` on `AddonConfig`) allows `type = "helm"` in TOML to select the correct variant. This matches the existing `ReadyCheck` pattern in `src/config/model.rs`.

4. **`helm upgrade --install` for idempotency.** Eliminates "already installed" checks and handles restarts cleanly. Only flags common to Helm 3 and 4 are used (avoiding `--atomic` which was renamed in Helm 4).

5. **Port-forward reconnection loop** using `CancellationToken` + `TaskTracker` (same pattern as `src/cluster/watcher.rs`). Each port-forward is a tracked task with `kill_on_drop(true)` to prevent zombie processes.

6. **CodeMirror 6 over Monaco** for the config editor (~124KB min+gz vs Monaco's 2MB+). CodeMirror has TOML support via legacy modes; Monaco has none. `solid-codemirror` provides reactive SolidJS primitives.

7. **Backwards compatibility** maintained via `#[serde(default)]` on the `addons` field in `ClusterConfig`. Existing configs without addons parse correctly (verified by `parse_cluster_without_addons` test).

### Module Integration Points

- **Config model** (`src/config/model.rs`): `AddonConfig` enum added to `ClusterConfig` with `BTreeMap<String, AddonConfig>` for ordered addon processing.
- **Validation** (`src/config/validate.rs`): Addon port-forward ports checked against service/infra/dashboard ports. Addon names checked against deploy names. Non-empty required fields validated per variant.
- **Orchestrator** (`src/orchestrator/mod.rs`): Addon install wired into Phase 3.5 (after cluster create, before service deploy). Port-forward management on stop/delete.
- **State** (`src/orchestrator/state.rs`): `AddonState` tracks addon type, namespace, and install timestamp with `#[serde(default)]` for state file backwards compatibility.
- **Dashboard** (`src/dashboard/server.rs`): `config_path` threaded through `DashboardState` for config API endpoints.

### New Frontend Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `solid-codemirror` | ^2.3.1 | SolidJS CodeMirror 6 integration |
| `@codemirror/state` | ^6.5.4 | Core state management |
| `@codemirror/view` | ^6.38.8 | Rendering layer |
| `@codemirror/language` | ^6.0.0 | Language support infrastructure |
| `@codemirror/legacy-modes` | ^6.5.2 | TOML syntax highlighting |
| `@codemirror/lint` | ^6.9.4 | Inline error/warning display |
| `@codemirror/theme-one-dark` | ^6.0.0 | Dark theme |
| `codemirror` | ^6.0.0 | Meta-package with basicSetup |
| `smol-toml` | ^1.6.0 | Client-side TOML syntax validation |

## Tests

### Unit Tests (228 total, up from 211)

| Module | New Tests | Count |
|--------|-----------|-------|
| `config::model` | Addon config parsing (helm, manifest, kustomize, port_forward, values) | 5 |
| `config::validate` | Addon validation (empty chart, port conflict, name conflict) | 3 |
| `cluster::addon` | `toml_value_to_helm_set` (string, bool, int, float, array, nested) | 6 |
| Other | Misc additions from state/orchestrator changes | 3 |

### Integration Tests

| Test | File | Status |
|------|------|--------|
| `skill_install_writes_to_project_dir` | `tests/integration/skill_install.rs` | PASS |
| `skill_install_is_idempotent` | `tests/integration/skill_install.rs` | PASS |
| `addon_helm_lifecycle` (+ 2 related) | `tests/integration/addon_lifecycle.rs` | PASS (3 tests, requires k3d+helm) |
| Config editor API tests (4 tests) | `tests/integration/config_editor.rs` | PASS |

### E2E Tests (Playwright)

| Test | File | Status |
|------|------|--------|
| `config editor loads current config` | `e2e/dashboard/config-editor.test.ts` | Discoverable (3 tests found) |
| `shows validation error for invalid TOML` | `e2e/dashboard/config-editor.test.ts` | Discoverable |
| `save button persists changes` | `e2e/dashboard/config-editor.test.ts` | Discoverable |

### Execution Fix History

Two fix rounds were required during implementation:

- **Round 1 (8 fixes):** Various compilation and integration issues across multiple files.
- **Round 2 (6 fixes):** All shared a single root cause — type errors in `tests/integration/addon_lifecycle.rs`. Fixed `BTreeMap<String, String>` key lookup (used `"3000"` not `3000`), `Option<String>` comparison (`as_deref()` for Manifest namespace), and temporary value lifetime issues (split chained expressions).

## Documentation

### Created

| File | Content |
|------|---------|
| `docs/guides/claude-code-skill.md` | Skill overview, installation instructions (project-local and global), what Claude can do, example prompts ("Why is the API slow?", "What's erroring in the worker service?", etc.), how the skill works internally |

### Updated

| File | Changes |
|------|---------|
| `docs/guides/configuration.md` | Added `[cluster.addons.*]` section with addon type documentation, Helm values mapping, port_forward configuration, Traefik example as recommended ingress addon, lifecycle mapping, and alphabetical installation order note |

## Verification Status

**58 of 59 checks passed.**

| Category | Passed | Failed | Total |
|----------|--------|--------|-------|
| Standard build checks (fmt, clippy, build, test, frontend) | 5 | 0 | 5 |
| Claude Code Skill | 7 | 0 | 7 |
| `devrig skill install` command | 5 | 1 | 6 |
| Cluster addons | 12 | 0 | 12 |
| Config editor — backend | 6 | 0 | 6 |
| Config editor — frontend | 7 | 0 | 7 |
| Config editor — E2E | 2 | 0 | 2 |
| Documentation | 5 | 0 | 5 |
| Backwards compatibility | 5 | 0 | 5 |
| Integration test registration | 2 | 0 | 2 |
| Resource leak checks | 2 | 0 | 2 |
| **Total** | **58** | **1** | **59** |

### Build Metrics

| Metric | Value |
|--------|-------|
| Unit tests | 228 passed, 0 failed |
| Clippy warnings | 0 |
| Frontend bundle | 42 modules, 485 KB JS (152 KB gzip) |
| Leaked containers | 0 |
| Leaked k3d clusters | 0 |
| New Rust crate dependencies | 0 |

## Known Issues

### 1. Missing `skill_install_global` Integration Test (Check 17 — FAILED)

**Description:** No integration test exercises the `devrig skill install --global` code path. The available skill_install tests are `skill_install_writes_to_project_dir` and `skill_install_is_idempotent`. The `--global` flag is implemented and documented in the CLI help output, but lacks a dedicated test that overrides `HOME` and verifies files are written to `~/.claude/skills/devrig/`.

**Impact:** Low. The global install path is functionally identical to the local path — the only difference is the target directory calculation. The CLI flag is present and the code path is straightforward (`env::var("HOME")` + `.claude/skills/devrig/`).

**Recommended fix:** Add a `skill_install_global` test to `tests/integration/skill_install.rs` that creates a temp HOME directory, runs `devrig skill install --global` with the `HOME` env override, and asserts the SKILL.md file exists at `{HOME}/.claude/skills/devrig/SKILL.md`.

### 2. TOML Legacy Mode Limitations

The TOML syntax highlighting uses `@codemirror/legacy-modes` which provides basic highlighting (keys, values, strings, comments, tables) but lacks advanced features like folding, structural navigation, and auto-indent. This is a cosmetic limitation — server-side semantic validation compensates for what the editor doesn't catch. If a Lezer-based TOML grammar becomes available, it can replace the legacy mode via `createExtension` reactive swap.

### 3. Port-Forward Inherent Fragility

`kubectl port-forward` is inherently fragile — connections die on pod restart, network hiccup, or API server reconnection. The exponential backoff reconnection loop (1s to 30s max) mitigates this, but users may see brief connectivity gaps during pod restarts. The dashboard/terminal should show port-forward status, but this is not yet a first-class status indicator.

### 4. Addon Dependency Ordering

Addons install in alphabetical order by BTreeMap key. There is no explicit `depends_on` mechanism. Users with addon dependencies (e.g., cert-manager CRDs needed before another addon) must use naming prefixes (`01-cert-manager`, `02-traefik`). An explicit dependency mechanism could be added in a future milestone but is not needed for v0.6.

### 5. k3d Built-in Traefik Conflict

If a user configures `[cluster.addons.traefik]` without disabling k3d's built-in Traefik (`--disable=traefik` in k3s args), two Traefik instances will compete for the same ports. This is documented in the configuration guide but not detected automatically. Automatic conflict detection could be added later.

## Next Milestone Context

### What v0.7 Should Know

1. **Config model location:** `AddonConfig` is defined in `src/config/model.rs` as a `#[serde(tag = "type")]` enum with Helm, Manifest, and Kustomize variants. The `addons` field on `ClusterConfig` uses `BTreeMap<String, AddonConfig>` with `#[serde(default)]`.

2. **Addon lifecycle module:** `src/cluster/addon.rs` contains all addon install/uninstall/port-forward logic. The `PortForwardManager` struct manages reconnection loops. Functions accept `kubeconfig: &Path` and `cancel: &CancellationToken` as parameters (not the full `K3dManager`).

3. **Dashboard state:** `DashboardState` in `src/dashboard/routes/mod.rs` now includes `config_path: PathBuf`. The config API endpoints (`GET/POST/PUT /api/config`) use SHA-256 hash-based optimistic concurrency.

4. **Skill embedding:** `src/commands/skill.rs` uses `include_str!("../../skill/claude-code/SKILL.md")` to embed the skill file. If additional skill files are added, each needs its own `include_str!` or a switch to `rust-embed` (already a dependency for the dashboard).

5. **Test count baseline:** 228 unit tests, 2 skill_install integration tests, 3 addon_lifecycle integration tests, 4 config_editor integration tests, 3 config-editor E2E tests. The integration test feature flag is `--features integration`.

6. **Frontend bundle:** 485 KB JS (152 KB gzip) after adding CodeMirror dependencies. The `smol-toml` package is available for client-side TOML parsing. The dashboard uses SolidJS with hash-based routing (`/#/config`).

7. **No new Rust crate dependencies** were added in v0.6. All functionality uses existing dependencies. The only new external CLI dependency is `helm` (checked by `devrig doctor`).

8. **Missing test gap:** The `--global` flag on `devrig skill install` lacks a dedicated integration test. This should be addressed early in v0.7 or as a quick follow-up.
