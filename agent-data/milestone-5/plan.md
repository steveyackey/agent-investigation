# Implementation Plan — v0.6: Claude Code Skill + Cluster Addons

## Overview

Milestone v0.6 adds four features to devrig: a Claude Code skill for AI-assisted observability, a `devrig skill install` CLI command, cluster addon management with Helm/manifest/Kustomize support, and a config editor in the dashboard. This milestone extends four existing modules (`config`, `orchestrator`, `cluster`, `dashboard`) and adds two new ones (`commands/skill`, `cluster/addon`).

By the end of v0.6:
- `skill/claude-code/SKILL.md` ships with devrig, providing Claude Code with full query workflow guidance
- `devrig skill install` copies the skill to `.claude/skills/devrig/` (project-local) or `~/.claude/skills/devrig/` (`--global`)
- `[cluster.addons.*]` in `devrig.toml` supports Helm charts, raw manifests, and Kustomize overlays
- Addon UIs are automatically port-forwarded to localhost
- The dashboard includes a config editor with real-time TOML validation
- `helm` is checked in `devrig doctor`

---

## Architecture Overview

### New Module Structure

```
skill/
  claude-code/
    SKILL.md                      # NEW: Claude Code skill instructions (embedded in binary)

src/
  cli.rs                          # MODIFY: Add Skill subcommand
  main.rs                         # MODIFY: Add Skill dispatch
  lib.rs                          # NO CHANGE (cluster module already declared)
  commands/
    mod.rs                        # MODIFY: Add skill module export
    skill.rs                      # NEW: devrig skill install handler
    doctor.rs                     # MODIFY: Add helm check
  config/
    model.rs                      # MODIFY: Add AddonConfig to ClusterConfig
    validate.rs                   # MODIFY: Add addon validation rules
  cluster/
    mod.rs                        # MODIFY: Extend K3dManager with addon methods
    addon.rs                      # NEW: Addon install/uninstall/port-forward lifecycle
  orchestrator/
    mod.rs                        # MODIFY: Insert addon install in Phase 3.5, port-forwards
    state.rs                      # MODIFY: Add AddonState to ClusterState
  dashboard/
    mod.rs                        # NO CHANGE
    routes/
      mod.rs                      # MODIFY: Add config routes
      config.rs                   # NEW: GET/POST/PUT /api/config endpoints
  ui/
    summary.rs                    # MODIFY: Add addons section to startup summary

dashboard/
  package.json                    # MODIFY: Add CodeMirror + smol-toml dependencies
  src/
    App.tsx                       # MODIFY: Add #/config route
    components/
      Sidebar.tsx                 # MODIFY: Add Config nav item
      ConfigEditor.tsx            # NEW: CodeMirror TOML editor component
    views/
      ConfigView.tsx              # NEW: Config editor view
    api.ts                        # MODIFY: Add config API functions

e2e/
  dashboard/
    config-editor.test.ts         # NEW: Playwright tests for config editor

tests/
  integration/
    skill_install.rs              # NEW: Skill install integration tests
    addon_lifecycle.rs            # NEW: Addon install/teardown integration tests
  integration.rs                  # MODIFY: Add new test modules

docs/
  guides/
    claude-code-skill.md          # NEW: Skill usage guide
    configuration.md              # MODIFY: Add [cluster.addons.*] section
```

### Dependency Changes

**Rust (Cargo.toml):** No new crate dependencies. All required crates are already present:
- `tokio` (process, fs, sync, net) — for helm/kubectl shell-out, file copy, port-forward
- `backon` — retry logic for port-forward reconnection
- `sha2` — config content hashing for save conflict detection
- `tokio-util` (CancellationToken, TaskTracker) — port-forward lifecycle management
- `serde`/`toml` — config model extension

**Frontend (dashboard/package.json):** New npm packages:
- `solid-codemirror` ^2.3.1 — SolidJS CodeMirror 6 integration
- `@codemirror/state` ^6.5.4 — CodeMirror core state
- `@codemirror/view` ^6.38.8 — CodeMirror rendering
- `@codemirror/language` ^6.0.0 — Language support infrastructure
- `@codemirror/legacy-modes` ^6.5.2 — TOML syntax highlighting
- `@codemirror/lint` ^6.9.4 — Inline error/warning display
- `@codemirror/theme-one-dark` ^6.0.0 — Dark theme
- `codemirror` ^6.0.0 — Meta-package with basicSetup
- `smol-toml` ^1.6.0 — Client-side TOML syntax validation

**External CLI dependencies (runtime):**
- `helm` 3.x+ — required for Helm addon installation (checked by `devrig doctor`)

---

## Key Design Decisions

### 1. Skill Files Embedded via `include_str!()`

The skill files must be embedded in the binary for `cargo install devrig` distribution. Using `include_str!("../../skill/claude-code/SKILL.md")` is the simplest approach — no runtime path resolution, no dependency on filesystem layout. The `devrig skill install` command writes the embedded content to disk.

### 2. Shell-Out to `helm` and `kubectl` for Addons

The project already shells out to `k3d`, `kubectl`, `docker compose`, and `docker build` via `tokio::process::Command`. Addon management follows the same pattern. There is no mature Rust crate for Helm. The `run_cmd()` helper in `src/cluster/deploy.rs` provides the cancellable subprocess execution pattern to follow.

### 3. `helm upgrade --install` for Idempotency

Always use `helm upgrade --install` instead of `helm install`. This is idempotent: installs if the release does not exist, upgrades if it does. Eliminates the need for "already installed" checks and handles restarts cleanly.

### 4. Port-Forward with Reconnection Loop

Port-forwards die when pods restart or API server connections drop. Each port-forward runs as a tracked task with a reconnection loop using `CancellationToken` + `TaskTracker` (same pattern as `src/cluster/watcher.rs`). Exponential backoff (1s → 30s max) handles transient failures.

### 5. Serde Tag-Based Enum for Addon Types

Using `#[serde(tag = "type")]` on `AddonConfig` allows the TOML `type = "helm"` field to select the correct variant. This matches the existing `ReadyCheck` pattern in `src/config/model.rs`.

### 6. Dual-Layer Config Validation

- **Client-side (instant):** `smol-toml.parse()` catches TOML syntax errors with line/column info. 300ms debounce.
- **Server-side (authoritative):** `POST /api/config/validate` runs the existing Rust `validate()` function which produces miette diagnostics with byte offsets.

### 7. Config Editor Save with Optimistic Concurrency

SHA-256 hash of config content is included in GET response and checked on PUT. If the hash mismatches (file changed externally), the server returns 409 Conflict. This prevents overwriting external edits.

### 8. Addon Lifecycle Mapping

| devrig command | Addon behavior |
|---------------|----------------|
| `devrig start` (cluster create) | Install all addons, start port-forwards |
| `devrig stop` | Leave addons running (cluster preserved), stop port-forwards |
| `devrig start` (cluster exists) | No-op for addons (idempotent), restart port-forwards |
| `devrig delete` | Uninstall addons, delete cluster, kill port-forwards |

### 9. SKILL.md Design

- **Frontmatter** with `name`, `description`, and `allowed-tools: Bash(devrig *)` for auto-approval
- **Body** with all `devrig query` commands, workflow guidance for performance/error/health debugging
- **No helper script** — Claude can run `devrig query` commands directly via the Bash tool
- Keep under 300 lines for fast loading

### 10. Addons Install Between Cluster Create and Service Deploy

In the orchestrator Phase 3.5, addons install after the cluster is created but before user services are deployed. This ensures addon functionality (e.g., Traefik for ingress) is available when services need it. The BTreeMap provides alphabetical ordering (deterministic). Users can prefix names for explicit ordering: `01-cert-manager`, `02-traefik`.

---

## Integration Points with Existing Code

### Config Module (`src/config/`)

- **`model.rs`**: Add `AddonConfig` enum (Helm/Manifest/Kustomize variants) with `#[serde(tag = "type")]`. Add `addons: BTreeMap<String, AddonConfig>` to `ClusterConfig` with `#[serde(default)]` for backwards compatibility.
- **`validate.rs`**: Add validation for addon port-forward ports not conflicting with service/infra/dashboard ports. Validate non-empty chart/path strings. Validate addon names don't conflict with deploy names.

### Orchestrator Module (`src/orchestrator/`)

- **`mod.rs`**: In Phase 3.5, after cluster creation and before service deployment, call `install_addons()` and `start_port_forwards()`. On `stop()`, cancel port-forward tasks. On `delete()`, uninstall addons before deleting cluster.
- **`state.rs`**: Add `installed_addons: BTreeMap<String, AddonState>` to `ClusterState` with `#[serde(default)]`.

### Cluster Module (`src/cluster/`)

- **`mod.rs`**: Add methods to `K3dManager` for running `helm` commands (following the existing `run_k3d()` pattern). Extend with addon lifecycle coordination.
- **`addon.rs`**: New file implementing `install_addons()`, `uninstall_addons()`, individual addon type handlers, and port-forward management.

### Dashboard Module (`src/dashboard/`)

- **`routes/mod.rs`**: Add config routes to the router.
- **`routes/config.rs`**: New file with `GET /api/config`, `POST /api/config/validate`, `PUT /api/config` endpoints.
- **`server.rs`**: Pass `config_path` through to `DashboardState` (extend the struct).

### CLI (`src/cli.rs`, `src/main.rs`)

- **`cli.rs`**: Add `Skill` subcommand with `Install { global: bool }`.
- **`main.rs`**: Add dispatch for `Skill` command.

### UI (`src/ui/summary.rs`)

- Add "Addons" section showing installed addons with their port-forwarded URLs and status.

---

## Implementation Order and Rationale

### Phase 1: Foundation (Steps 1–4)

**Step 1: Create SKILL.md.** The skill file is standalone content with no code dependencies. Creating it first allows parallel development of the install command.

**Step 2: Config model extension.** Add `AddonConfig` enum and `addons` field to `ClusterConfig`. This must come before validation, orchestrator, and addon implementation since they all depend on the config types.

**Step 3: Config validation.** Add addon-specific validation rules. Depends on the config model.

**Step 4: State model extension.** Add `AddonState` to `ClusterState`. Needed before the addon lifecycle implementation.

### Phase 2: Skill Command (Steps 5–6)

**Step 5: Skill install command.** Implement `devrig skill install` with `--global` flag. Uses `include_str!()` to embed SKILL.md. Simple file copy operation.

**Step 6: Doctor helm check.** Extend `devrig doctor` to check for `helm` in PATH. Quick addition to existing patterns.

### Phase 3: Addon Core (Steps 7–9)

**Step 7: Addon lifecycle module.** Implement `src/cluster/addon.rs` with Helm, manifest, and Kustomize install/uninstall functions. Port-forward management with reconnection loop.

**Step 8: Orchestrator addon integration.** Wire addon installation into Phase 3.5. Handle addon lifecycle on stop/delete. Start port-forwards.

**Step 9: Startup summary addons section.** Add addons to the terminal startup summary output.

### Phase 4: Config Editor Backend (Steps 10–11)

**Step 10: Config API endpoints.** Implement `GET /api/config`, `POST /api/config/validate`, `PUT /api/config` with hash-based optimistic concurrency.

**Step 11: Dashboard state extension.** Pass config path through to DashboardState so the config endpoints can read/write the file.

### Phase 5: Config Editor Frontend (Steps 12–13)

**Step 12: Frontend dependencies + editor component.** Install npm packages. Create `ConfigEditor.tsx` with CodeMirror 6, TOML syntax highlighting, and lint integration.

**Step 13: Config view + routing.** Create `ConfigView.tsx`, add route to `App.tsx`, add nav item to `Sidebar.tsx`. Wire up save/validate flow.

### Phase 6: Testing (Steps 14–17)

**Step 14: Skill install integration tests.** Test project-local and global install, idempotency, content verification.

**Step 15: Addon lifecycle integration tests.** Test Helm chart deploy, port-forward connectivity, cleanup on delete. Requires k3d + helm.

**Step 16: Config editor E2E tests.** Playwright tests for config loading, validation display, and save flow.

**Step 17: Skill command validation test.** Verify every `devrig` command mentioned in SKILL.md is a real subcommand.

### Phase 7: Documentation (Step 18)

**Step 18: Documentation.** Create `docs/guides/claude-code-skill.md`. Update `docs/guides/configuration.md` with `[cluster.addons.*]`.

---

## Testing Strategy

### Unit Tests

| Module | Tests |
|---|---|
| `config::model` | AddonConfig parsing (helm, manifest, kustomize variants), port_forward map, values map, backwards compat with no addons |
| `config::validate` | Addon port conflicts with services/infra, empty chart/path strings, addon name conflicts with deploy names |
| `cluster::addon` | `toml_value_to_helm_set()` for each value type (string, bool, int, float, array) |

### Integration Tests

| Test | File | What It Verifies |
|---|---|---|
| `skill_install_project_local` | `tests/integration/skill_install.rs` | Files copied to `.claude/skills/devrig/SKILL.md`, content contains expected keywords |
| `skill_install_global` | `tests/integration/skill_install.rs` | Files copied to `~/.claude/skills/devrig/SKILL.md` (using temp HOME) |
| `skill_install_idempotent` | `tests/integration/skill_install.rs` | Install twice succeeds, content matches |
| `skill_commands_valid` | `tests/integration/skill_install.rs` | Every `devrig` command in SKILL.md is a valid subcommand (--help exits 0) |
| `addon_helm_traefik_lifecycle` | `tests/integration/addon_lifecycle.rs` | Helm chart deploys, port-forward works, cleanup on delete |

### E2E Tests (Playwright)

| Test | What It Verifies |
|---|---|
| `config editor loads current config` | `/#/config` shows editor with current TOML content |
| `shows validation error for invalid config` | Invalid TOML shows lint markers |
| `save button persists changes` | Edit → save → reload → verify |

### Backwards Compatibility

All existing 211 unit tests and 51 integration tests must continue to pass. The config model extension uses `#[serde(default)]` on the `addons` field so existing configs parse correctly.

---

## Documentation Plan

### New Files

- **`docs/guides/claude-code-skill.md`** — How to install the skill, example prompts, what Claude can do with devrig, workflow examples

### Updated Files

- **`docs/guides/configuration.md`** — Add `[cluster.addons.*]` section with addon types table, Helm values mapping, port-forward configuration, Traefik example, lifecycle mapping

---

## Risk Mitigation

### 1. Helm Binary Availability
`devrig doctor` checks for `helm` and reports version. Clear error message if not found: "helm is required for cluster addons. Install from https://helm.sh". Only flags common to Helm 3 and 4 are used.

### 2. Port-Forward Stability
Exponential backoff reconnection loop (1s → 30s max). `kill_on_drop(true)` prevents zombie processes. Health check via TCP probe detects dead tunnels.

### 3. Addon Installation Timeout in CI
Use `tokio::time::timeout(Duration::from_secs(300), ...)` on integration tests. Use `helm upgrade --install --wait --timeout 5m` for addon installation.

### 4. TOML Values to Helm `--set`
Implement and unit-test `toml_value_to_helm_set()` for all TOML value types. For complex nested values, recommend `values_file` over inline `values`.

### 5. Config Editor Concurrent Modification
Content hash checked on PUT. 409 Conflict with current content on mismatch. Frontend shows reload prompt.

### 6. CodeMirror TOML Highlighting
Legacy TOML mode provides basic syntax highlighting (keys, values, strings, comments, tables). Server-side semantic validation compensates for limitations.

### 7. Skill File Embedding
`include_str!()` embeds skill files at compile time. Keep files small for negligible binary size impact.
