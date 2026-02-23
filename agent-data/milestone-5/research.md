# Milestone v0.6 Research — Claude Code Skill + Cluster Addons

## Current Codebase State

The devrig project at commit `d86cd72` (v0.5 complete) has:

- **211 unit tests, 51 integration tests, 76 Playwright E2E tests** — all passing
- **src/cluster/** — `K3dManager` with cluster create/delete, registry, deploy pipeline, file watching
- **src/dashboard/** — Axum server, REST API (traces/logs/metrics/status/env/services), WebSocket, `rust-embed` SPA serving
- **src/otel/** — In-process OTLP receiver (gRPC + HTTP), ring buffer storage, query engine
- **src/commands/query.rs** — `devrig query traces|trace|logs|metrics|status|related` with JSON output
- **src/config/model.rs** — `ClusterConfig` has `name`, `agents`, `ports`, `registry`, `deploy` map — but **no `addons` field yet**
- **dashboard/** — SolidJS frontend with StatusView, TracesView, TraceDetail, LogsView, MetricsView, Overview
- **No `skill/` directory** — needs to be created from scratch
- **No `devrig skill` CLI command** — needs to be added to `src/cli.rs`
- **No config editor view** in the dashboard
- **No `/api/config` endpoints** in the backend

Shell-out pattern is established: k3d, kubectl, docker compose, and docker build all use `tokio::process::Command`. The `run_cmd()` helper in `src/cluster/deploy.rs` provides cancellable subprocess execution.

---

## Crate/Library Recommendations

### Rust Dependencies (no new crates needed)

| Crate | Current Version | Use in v0.6 | Notes |
|-------|----------------|-------------|-------|
| `tokio` | 1.x (process, fs, sync, net) | Port-forward process management, file copy | Already in Cargo.toml |
| `backon` | 1.x | Retry logic for port-forward reconnection | Already used for ready checks |
| `anyhow` | 1 | Error handling in addon/skill commands | Already in Cargo.toml |
| `tracing` | 0.1 | Logging addon lifecycle events | Already in Cargo.toml |
| `serde`/`toml` | 1.0/0.8 | Config model extension for addons | Already in Cargo.toml |
| `sha2` | 0.10 | Config content hashing for save conflict detection | Already in Cargo.toml |
| `tokio-util` | 0.7 (CancellationToken, TaskTracker) | Port-forward lifecycle management | Already in Cargo.toml |

**No new Rust crate dependencies are required.** The addon feature shells out to `helm` and `kubectl` (matching existing patterns). The skill install feature uses `tokio::fs` for file operations. The config editor backend reuses existing validation infrastructure.

### Frontend Dependencies (new npm packages)

| Package | Version | Purpose |
|---------|---------|---------|
| `solid-codemirror` | ^2.3.1 | SolidJS integration for CodeMirror 6 editor |
| `@codemirror/state` | ^6.5.4 | CodeMirror core state management |
| `@codemirror/view` | ^6.38.8 | CodeMirror view/rendering layer |
| `@codemirror/language` | ^6.0.0 | Language support infrastructure |
| `@codemirror/legacy-modes` | ^6.5.2 | TOML syntax highlighting via `StreamLanguage.define(toml)` |
| `@codemirror/lint` | ^6.9.4 | Inline error/warning display with gutter markers |
| `@codemirror/merge` | ^6.11.2 | Diff view before saving (unified merge view) |
| `@codemirror/theme-one-dark` | ^6.0.0 | Dark theme matching dashboard aesthetic |
| `codemirror` | ^6.0.0 | Meta-package with basicSetup (line numbers, bracket matching, search) |
| `smol-toml` | ^1.6.0 | Client-side TOML syntax validation (fast, TOML 1.1 compliant) |

**Why CodeMirror 6 over Monaco:** ~124KB min+gz vs Monaco's 2MB+. CodeMirror has TOML support via legacy modes; Monaco has none (open issue #2798). `solid-codemirror` provides reactive SolidJS primitives (`createCodeMirror`, `createEditorControlledValue`, `createEditorReadonly`, `createExtension`). The devrig dashboard already uses `rust-embed` for asset compression — keeping JS payload small matters.

### External CLI Dependencies (runtime, not build)

| Tool | Min Version | Required For | Checked By |
|------|-------------|-------------|------------|
| `helm` | 3.x (4.x compatible) | Helm addon installation | `devrig doctor` |
| `kubectl` | 1.28+ | Kustomize/manifest addons, port-forward | Already checked |
| `k3d` | 5.x | Cluster lifecycle | Already checked |

**Helm 4 note:** Helm 4.0.0 was released November 2025. Key CLI rename: `--atomic` → `--rollback-on-failure`. Helm 3 charts (v2 API) are fully supported by Helm 4. Helm 3 receives security fixes until November 2026. Target Helm 3 CLI compatibility; the `helm upgrade --install` pattern works identically on both versions.

---

## Design Patterns

### 1. Shell-Out Pattern for Helm/kubectl (established)

The project already shells out to `k3d`, `kubectl`, `docker compose`, and `docker build` via `tokio::process::Command`. Addon management follows the same pattern. There is no mature Rust crate for Helm (the `helm-wrapper-rs` crate has negligible adoption). Shell-out is the standard approach for Rust tools interacting with Helm.

```rust
async fn run_helm(args: &[&str], kubeconfig: &Path, cancel: &CancellationToken) -> Result<String> {
    // Same pattern as run_cmd() in src/cluster/deploy.rs
    // Sets KUBECONFIG env var, captures stdout/stderr, respects cancellation
}
```

### 2. Idempotent Operations via `helm upgrade --install`

Always use `helm upgrade --install` instead of `helm install`. This is idempotent: installs if the release does not exist, upgrades if it does. This eliminates the need for "already installed" checks and handles restarts cleanly.

```bash
helm upgrade --install <release> <chart> \
  --namespace <ns> --create-namespace \
  --wait --timeout 5m \
  --set key=value
```

### 3. Port-Forward with Reconnection Loop

Port-forwards die when pods restart or API server connections drop. Use `CancellationToken` + `TaskTracker` (same as `src/cluster/watcher.rs`) with exponential backoff reconnection:

```
loop {
    spawn kubectl port-forward (kill_on_drop=true)
    select! {
        exit = child.wait() => { log + backoff + retry }
        _ = cancel.cancelled() => { kill child; break }
    }
}
```

Health check: TCP connect probe to `127.0.0.1:<local_port>` + process exit detection.

### 4. SKILL.md Frontmatter + Body Format (Agent Skills Standard)

Claude Code skills use the [Agent Skills](https://agentskills.io) open standard:

```yaml
---
name: devrig
description: Inspect and debug a running devrig development environment. Use when the user asks about service health, errors, performance, traces, logs, or metrics in their local dev environment.
---

# Markdown body with instructions
```

**Discovery mechanism:** At startup, Claude loads `name` + `description` from all installed skills into context. The body is loaded only on invocation. This means the description is critical for triggering — it should be exhaustive about when to use the skill.

**Key fields:**
- `name` — lowercase letters/numbers/hyphens, max 64 chars. Also becomes the `/slash-command`.
- `description` — third person, max 1024 chars. Answers "what does it do" AND "when to use it".
- `allowed-tools` — optional, e.g. `Bash(devrig *)` to auto-approve devrig commands.

### 5. Dual-Layer Validation for Config Editor

- **Client-side (instant):** `smol-toml.parse()` catches syntax errors with line/column info. 300ms debounce.
- **Server-side (authoritative):** `POST /api/config/validate` runs the existing Rust `validate()` function which produces `miette` diagnostics with byte offsets. These map directly to CodeMirror's `Diagnostic` `from`/`to` positions. 800ms debounce after syntax passes.

### 6. Config Editor Save Flow

```
Edit → client-side syntax check (instant)
     → server-side semantic validation (debounced)
     → "Save" button (enabled only when valid)
     → Server creates backup (devrig.toml.bak), writes file
     → Existing ConfigWatcher detects change (src/config/watcher.rs)
     → ConfigDiff triggers hot-reload for affected services
```

### 7. Addon Lifecycle Mapping

| devrig command | Addon behavior |
|---------------|----------------|
| `devrig start` (cluster create) | Install all addons, start port-forwards |
| `devrig stop` | Leave addons running (cluster preserved), stop port-forwards |
| `devrig start` (cluster exists) | No-op for addons (idempotent), restart port-forwards |
| `devrig delete` | Uninstall addons, delete cluster, kill port-forwards |

This is natural because k3d preserves cluster state on stop (Docker volumes) and destroys everything on delete.

---

## Implementation Strategy

### Feature 1: Claude Code Skill

#### 1a. Create `skill/claude-code/SKILL.md`

Create the skill directory at project root with the PRD-specified SKILL.md content, enhanced with best practices:

```
skill/claude-code/
  SKILL.md       — Main skill instructions (≤500 lines, frontmatter + body)
```

**SKILL.md design decisions:**

- **No `devrig.sh` helper script.** The PRD mentions one, but it adds no value — Claude can run `devrig query` commands directly via the Bash tool. A wrapper script is unnecessary indirection. The SKILL.md body provides all the command examples Claude needs. This follows the "concise is key" best practice: only add context Claude doesn't already have.
- **Include `allowed-tools: Bash(devrig *)` in frontmatter** to auto-approve devrig CLI invocations without user confirmation prompts.
- **Description should be comprehensive about triggers:** mention "service health", "errors", "performance", "traces", "logs", "metrics", "debugging", "slow requests", "what happened at [time]" — all the things a developer might ask about.
- **Workflow guidance in the body** — the PRD's three workflows (performance, errors, health) should be the core of the instructions.
- **Progressive disclosure** — keep the main SKILL.md under 300 lines. If a command reference grows beyond that, split into a `reference.md` file that Claude reads only when needed.

#### 1b. Implement `devrig skill install` CLI command

Add to `src/cli.rs`:
```rust
/// Manage the Claude Code skill
#[derive(Subcommand)]
enum SkillCommands {
    /// Install the devrig skill for Claude Code
    Install {
        /// Install globally to ~/.claude/skills/ instead of project-local
        #[arg(long)]
        global: bool,
    },
}
```

Add `src/commands/skill.rs`:
```rust
pub async fn run_install(global: bool, config_dir: &Path) -> Result<()> {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("skill/claude-code");
    // Or: embed skill files via include_str!/include_bytes! for single-binary distribution

    let target = if global {
        dirs::home_dir().unwrap().join(".claude/skills/devrig")
    } else {
        config_dir.join(".claude/skills/devrig")
    };

    tokio::fs::create_dir_all(&target).await?;
    // Copy SKILL.md (and any reference files)
    copy_dir_contents(&source, &target).await?;

    println!("Installed devrig skill to {}", target.display());
    println!("Try asking Claude: \"What services are running and are there any errors?\"");
    Ok(())
}
```

**Key design decision: embedded vs filesystem source.**

For `cargo install devrig` distribution, the skill files must be embedded in the binary (they won't exist on disk after installation). Use `include_str!` for SKILL.md:

```rust
const SKILL_MD: &str = include_str!("../../skill/claude-code/SKILL.md");

async fn install_skill(target: &Path) -> Result<()> {
    tokio::fs::create_dir_all(target).await?;
    tokio::fs::write(target.join("SKILL.md"), SKILL_MD).await?;
    Ok(())
}
```

This is the simplest approach and avoids runtime path resolution issues. For multiple files, use `rust-embed` (already a dependency) or individual `include_str!` calls.

**Idempotency:** Overwrite existing files on re-install. No version checking needed — the installed version always matches the devrig binary version.

#### 1c. Add `helm` to `devrig doctor`

Extend `src/commands/doctor.rs` to check for `helm` in PATH, since it's now a required tool for addons.

### Feature 2: Cluster Addons

#### 2a. Extend config model

Add to `src/config/model.rs`:

```rust
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type")]
pub enum AddonConfig {
    #[serde(rename = "helm")]
    Helm {
        chart: String,
        repo: String,
        namespace: String,
        #[serde(default)]
        version: Option<String>,
        #[serde(default)]
        values: BTreeMap<String, toml::Value>,
        #[serde(default)]
        port_forward: BTreeMap<u16, String>,  // local_port -> "svc/name:remote_port"
    },
    #[serde(rename = "manifest")]
    Manifest {
        path: String,
        #[serde(default)]
        namespace: Option<String>,
        #[serde(default)]
        port_forward: BTreeMap<u16, String>,
    },
    #[serde(rename = "kustomize")]
    Kustomize {
        path: String,
        #[serde(default)]
        namespace: Option<String>,
        #[serde(default)]
        port_forward: BTreeMap<u16, String>,
    },
}
```

Add `addons: BTreeMap<String, AddonConfig>` to `ClusterConfig` with `#[serde(default)]` for backwards compatibility.

**Config example:**
```toml
[cluster.addons.traefik]
type = "helm"
chart = "traefik/traefik"
repo = "https://traefik.github.io/charts"
namespace = "traefik"
port_forward = { 9000 = "svc/traefik:9000" }

[cluster.addons.traefik.values]
"ports.web.nodePort" = 32080

[cluster.addons.cert-manager]
type = "helm"
chart = "jetstack/cert-manager"
repo = "https://charts.jetstack.io"
namespace = "cert-manager"

[cluster.addons.cert-manager.values]
installCRDs = true

[cluster.addons.my-tool]
type = "manifest"
path = "./k8s/addons/my-tool.yaml"
```

**Serde tag-based enum:** Using `#[serde(tag = "type")]` allows the TOML `type = "helm"` field to select the correct variant. This is clean and matches the PRD's config syntax.

**Port-forward config:** The PRD specifies `port_forward = { 8080 = "svc/headlamp:80" }` — a map from local port to a kubectl port-forward target string. This is parsed from TOML as `BTreeMap<u16, String>`.

**Values handling:** The `values` field uses `BTreeMap<String, toml::Value>` to support diverse TOML value types (strings, booleans, numbers). For Helm, each entry becomes a `--set key=value` argument. Nested keys use dot notation: `"ports.web.nodePort" = 32080` → `--set ports.web.nodePort=32080`.

#### 2b. Implement addon lifecycle in `src/cluster/addon.rs`

New file: `src/cluster/addon.rs`

Core functions:
- `install_addons()` — iterate addons in config order (BTreeMap = alphabetical), call appropriate installer
- `install_helm_addon()` — `helm repo add`, `helm repo update`, `helm upgrade --install` with values
- `install_manifest_addon()` — `kubectl apply -f <path>`
- `install_kustomize_addon()` — `kubectl apply -k <path>`
- `uninstall_addons()` — reverse order: `helm uninstall` for helm addons, `kubectl delete -f` for manifests
- `start_port_forwards()` — spawn port-forward processes, return handles
- `stop_port_forwards()` — kill all port-forward processes

**Helm addon install implementation:**

```rust
async fn install_helm_addon(
    name: &str,
    config: &HelmAddonConfig,
    kubeconfig: &Path,
    cancel: &CancellationToken,
) -> Result<()> {
    // 1. Add repo (idempotent)
    let repo_name = name;  // Use addon name as repo name
    run_helm(&["repo", "add", repo_name, &config.repo, "--force-update"],
             kubeconfig, cancel).await?;
    run_helm(&["repo", "update"], kubeconfig, cancel).await?;

    // 2. Build install args
    let mut args = vec![
        "upgrade", "--install", name, &config.chart,
        "--namespace", &config.namespace,
        "--create-namespace",
        "--wait",
        "--timeout", "5m",
    ];

    // Add version if specified
    let version_str;
    if let Some(v) = &config.version {
        version_str = v.clone();
        args.push("--version");
        args.push(&version_str);
    }

    // Add --set for each value
    let set_args: Vec<String> = config.values.iter()
        .map(|(k, v)| format!("{}={}", k, toml_value_to_helm_set(v)))
        .collect();
    for arg in &set_args {
        args.push("--set");
        args.push(arg);
    }

    // 3. Install
    run_helm(&args, kubeconfig, cancel).await?;
    Ok(())
}
```

**Port-forward management:**

```rust
struct PortForwardManager {
    handles: Vec<(String, tokio::process::Child)>,
    tracker: TaskTracker,
    cancel: CancellationToken,
}
```

Each port-forward runs as a tracked task with its own reconnection loop. On `devrig stop`, cancel the token → all port-forward tasks exit. On `devrig delete`, cancel token + `helm uninstall` for each addon.

#### 2c. Integrate addons into orchestrator startup

In `src/orchestrator/mod.rs`, extend Phase 3 (cluster) or add Phase 3.5:

```
Phase 3: Cluster
  3a. k3d cluster create (existing)
  3b. Connect network (existing)
  3c. Install addons (NEW)
  3d. Start port-forwards for addon UIs (NEW)
  3e. Build + push images (existing)
  3f. Apply manifests (existing)
```

Addons install after the cluster is created but before user services are deployed, since services might depend on addon functionality (e.g., Traefik for ingress).

#### 2d. Extend state tracking

Add to `ClusterState` in `src/orchestrator/state.rs`:

```rust
pub struct ClusterState {
    // existing fields...
    #[serde(default)]
    pub installed_addons: BTreeMap<String, AddonState>,
}

pub struct AddonState {
    pub addon_type: String,
    pub installed_at: DateTime<Utc>,
    pub namespace: String,
}
```

#### 2e. Extend validation

In `src/config/validate.rs`:
- Validate addon port-forward ports don't conflict with service/infra/dashboard ports
- Validate Helm chart strings are non-empty
- Validate manifest/kustomize paths exist (relative to config dir)
- Validate addon names don't conflict with deploy names

#### 2f. Add addons to startup summary

In `src/ui/summary.rs`, add an "Addons" section showing installed addons with their port-forwarded URLs:

```
  Addons
    traefik   http://localhost:9000 (dashboard)  ● ready
    cert-mgr                                     ● ready
```

### Feature 3: Config Editor in Dashboard

#### 3a. Backend API endpoints

New file: `src/dashboard/routes/config.rs`

Three endpoints:

**`GET /api/config`** — Returns current devrig.toml content and path:
```json
{ "content": "...", "path": "/path/to/devrig.toml", "hash": "abc123..." }
```

The hash (SHA-256 of content) enables optimistic concurrency: the PUT request includes the hash, and the server rejects if the file has changed since the editor loaded it.

**`POST /api/config/validate`** — Validates TOML content without saving:
```json
// Request: text/plain body with TOML content
// Response:
{ "valid": true }
// or:
{
  "valid": false,
  "errors": [
    {
      "offset": 145,
      "length": 5,
      "severity": "error",
      "message": "unknown dependency `postres`",
      "help": "did you mean `postgres`?"
    }
  ]
}
```

Uses the existing `validate()` function from `src/config/validate.rs`. The `SourceSpan` (offset + length) from `miette` diagnostics maps directly to CodeMirror's `Diagnostic` `from`/`to` positions.

**`PUT /api/config`** — Saves validated content to disk:
- Validates first (rejects invalid)
- Checks hash for concurrent modification
- Creates backup (`devrig.toml.bak`)
- Writes new content atomically (write to `.tmp`, rename)
- The existing `ConfigWatcher` detects the change and triggers hot-reload

Extend `DashboardState` (or `AppState`) with `config_path: PathBuf`.

#### 3b. Frontend config editor view

New files:
- `dashboard/src/views/ConfigView.tsx` — Main view with editor + validation status + save button
- `dashboard/src/components/ConfigEditor.tsx` — CodeMirror wrapper using `solid-codemirror`

Modified files:
- `dashboard/src/components/Sidebar.tsx` — Add "Config" nav item
- `dashboard/src/App.tsx` — Add `#/config` route
- `dashboard/src/api.ts` — Add `getConfig()`, `validateConfig()`, `saveConfig()` functions
- `dashboard/package.json` — Add new npm dependencies

**Editor setup:**

```typescript
import { createCodeMirror, createEditorControlledValue } from "solid-codemirror";
import { StreamLanguage } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { linter, lintGutter } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup } from "codemirror";
import { parse as parseToml } from "smol-toml";
```

**Validation pipeline:**
1. On keystroke → 300ms debounce → `smol-toml.parse()` for instant syntax feedback
2. If syntax valid → 800ms debounce → `POST /api/config/validate` for semantic validation
3. Map errors to `@codemirror/lint` `Diagnostic[]` with severity, from, to, message

**Theme:** Use `@codemirror/theme-one-dark` for dark mode (matching the zinc-900 dashboard theme). Support light mode via dynamic theme extension swap.

#### 3c. WebSocket integration for external edits

When the config file is edited externally (e.g., in a text editor), the existing `ConfigWatcher` fires. Extend the WebSocket `TelemetryEvent` enum with a `ConfigChanged` variant:

```rust
pub enum TelemetryEvent {
    // existing variants...
    ConfigChanged { content: String },
}
```

The frontend receives this event and updates the editor content via `createEditorControlledValue`, with a prompt asking the user whether to accept the external change or keep their edits.

### Feature 4: Traefik Preference (ADR Implementation)

The PRD already has `docs/adr/005-traefik-over-nginx.md`. The implementation simply means:

1. Documentation and examples use Traefik as the default ingress addon
2. The getting-started guide for cluster addons shows Traefik configuration first
3. k3d clusters can optionally disable the built-in Traefik (`--k3s-arg "--disable=traefik@server:0"`) and install a custom version via the addon system

**k3d built-in Traefik vs addon Traefik:**
- k3d ships Traefik by default in `kube-system` namespace
- For simple setups, the built-in Traefik is sufficient — no addon needed
- For custom configuration (specific versions, dashboard, values), users should disable the built-in and use a Helm addon
- Document both approaches in `docs/guides/cluster-setup.md`

---

## Testing Strategy

### Integration Tests for `devrig skill install`

File: `tests/integration/skill_install.rs`

```rust
#[tokio::test]
async fn skill_install_project_local() {
    let dir = TempDir::new().unwrap();
    write_minimal_config(&dir);

    let output = Command::new(env!("CARGO_BIN_EXE_devrig"))
        .args(["skill", "install", "-f", dir.path().join("devrig.toml").to_str().unwrap()])
        .current_dir(dir.path())
        .output().await.unwrap();

    assert!(output.status.success());
    assert!(dir.path().join(".claude/skills/devrig/SKILL.md").exists());

    let content = tokio::fs::read_to_string(
        dir.path().join(".claude/skills/devrig/SKILL.md")
    ).await.unwrap();
    assert!(content.contains("devrig"));
    assert!(content.contains("query traces"));
}

#[tokio::test]
async fn skill_install_global() {
    let home = TempDir::new().unwrap();
    let dir = TempDir::new().unwrap();
    write_minimal_config(&dir);

    let output = Command::new(env!("CARGO_BIN_EXE_devrig"))
        .args(["skill", "install", "--global"])
        .env("HOME", home.path())
        .current_dir(dir.path())
        .output().await.unwrap();

    assert!(output.status.success());
    assert!(home.path().join(".claude/skills/devrig/SKILL.md").exists());
}

#[tokio::test]
async fn skill_install_idempotent() {
    // Install twice, verify second succeeds and content matches
}
```

### Integration Tests for Addon Install/Teardown

File: `tests/integration/addon_lifecycle.rs`

Gated behind `#[cfg(feature = "integration")]` with `k3d_available()` skip guard.

```rust
#[tokio::test]
async fn addon_helm_traefik_lifecycle() {
    // Guard: skip if k3d/helm not available
    if !k3d_available() || !helm_available() { return; }

    let result = tokio::time::timeout(Duration::from_secs(300), async {
        let dir = TempDir::new().unwrap();
        write_config(&dir, ADDON_CONFIG); // config with [cluster.addons.traefik]
        let _cleanup = scopeguard::guard((), |_| { k3d_cleanup_sync(&slug); });

        // Start devrig
        let mut child = spawn_devrig(&dir).await;

        // Wait for cluster + addon
        wait_for_cluster(&slug, Duration::from_secs(120)).await;

        // Verify Traefik is deployed
        let pods = kubectl_get_pods(&kubeconfig, "traefik").await;
        assert!(pods.contains("traefik"), "Traefik pod not found");

        // Verify port-forward works (TCP connect to forwarded port)
        assert!(wait_for_port(9000, Duration::from_secs(30)).await);

        // Delete and verify cleanup
        send_delete(&mut child).await;
        assert!(!wait_for_port(9000, Duration::from_secs(5)).await,
            "Port-forward should be gone after delete");
    }).await;

    assert!(result.is_ok(), "Test timed out");
}
```

**Timeout considerations:** Helm chart pulls can take 30-60s in CI. Use 5-minute overall test timeout. Use `--wait --timeout 5m` on `helm upgrade --install`.

### Playwright E2E for Config Editor

File: `e2e/dashboard/config-editor.test.ts`

```typescript
test('config editor loads current config', async ({ page }) => {
  await page.goto('/#/config');
  const editor = page.locator('.cm-editor');
  await expect(editor).toBeVisible({ timeout: 5000 });
  // Verify content loaded from API
  const content = await page.evaluate(() =>
    (document.querySelector('.cm-content') as HTMLElement)?.textContent
  );
  expect(content).toContain('[project]');
});

test('shows validation error for invalid config', async ({ page }) => {
  await page.goto('/#/config');
  const editor = page.locator('.cm-editor');
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('[project\nname = invalid');
  await page.waitForTimeout(1000); // Wait for debounced validation
  const errorMarker = page.locator('.cm-lint-error');
  await expect(errorMarker.first()).toBeVisible({ timeout: 3000 });
});

test('save button persists changes', async ({ page }) => {
  await page.goto('/#/config');
  // Edit, validate, save, reload, verify
});
```

**CodeMirror testing note:** CodeMirror renders content in `<div class="cm-content">` not a `<textarea>`. Standard Playwright `fill()` doesn't work. Use `keyboard.press('Control+a')` + `keyboard.type()` instead.

### Skill Validation Testing

**Layer 1 (automated, CI):** Verify every command mentioned in SKILL.md is a real devrig subcommand:

```rust
#[test]
fn skill_commands_are_valid_subcommands() {
    let skill_md = include_str!("../../skill/claude-code/SKILL.md");
    let command_pattern = regex::Regex::new(r"`devrig (\w[\w\s-]+)`").unwrap();
    for cap in command_pattern.captures_iter(skill_md) {
        let cmd = &cap[1];
        let args: Vec<&str> = cmd.split_whitespace().collect();
        // Verify --help works for each referenced command
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_devrig"))
            .args(&args).arg("--help")
            .output().unwrap();
        assert!(!String::from_utf8_lossy(&output.stderr).contains("unrecognized"),
            "Command `devrig {}` not recognized", cmd);
    }
}
```

**Layer 2 (automated, needs running stack):** Start devrig with OTel data, run query commands, verify JSON output.

**Layer 3 (manual, release gate):** Developer runs `devrig skill install`, opens Claude Code, asks "What services are running?" — verifies Claude uses devrig query commands to answer. This cannot be automated economically.

### Test Matrix Summary

| Feature | Test Type | Automation | CI Gate |
|---------|-----------|------------|---------|
| `devrig skill install` (local) | Rust integration | Full | Yes |
| `devrig skill install` (global) | Rust integration | Full | Yes |
| Skill idempotent overwrite | Rust integration | Full | Yes |
| Skill commands valid | Rust unit | Full | Yes |
| Helm addon install | Rust integration + k3d | Full | Yes (needs k3d+helm) |
| Addon port-forward | Rust integration + k3d | Full | Yes (needs k3d) |
| Addon cleanup on delete | Rust integration + k3d | Full | Yes (needs k3d) |
| Config editor load | Playwright E2E | Full | Yes (needs browser) |
| Config editor validation | Playwright E2E | Full | Yes (needs browser) |
| Config editor save | Playwright E2E | Full | Yes (needs browser) |
| Skill + Claude Code e2e | Manual script | Semi | No (manual gate) |

---

## Risks and Considerations

### 1. Helm Binary Availability and Version Skew

**Risk:** Users may not have `helm` installed, or may have Helm 3 vs Helm 4 with renamed flags.

**Mitigation:**
- `devrig doctor` checks for `helm` and reports version
- Use only flags common to both Helm 3 and 4 (`upgrade --install`, `--wait`, `--timeout`, `--namespace`, `--create-namespace`, `--set`)
- Avoid `--atomic` (renamed to `--rollback-on-failure` in Helm 4) — use `--wait` instead, which is sufficient for dev environments
- Clear error message if `helm` is not found: "helm is required for cluster addons. Install from https://helm.sh"

### 2. Port-Forward Stability

**Risk:** `kubectl port-forward` is inherently fragile — dies on pod restart, network hiccup, or API server reconnection.

**Mitigation:**
- Exponential backoff reconnection loop (1s → 30s max)
- `kill_on_drop(true)` prevents zombie processes
- Health check via TCP probe detects dead tunnels
- Clear status in dashboard/terminal showing port-forward state
- Consider using `--address 127.0.0.1` explicitly to avoid binding to all interfaces

### 3. Addon Installation Timeout in CI

**Risk:** Helm chart pulls (especially first-time) can take 60+ seconds. k3d cluster creation adds 15-30s. Integration tests may timeout.

**Mitigation:**
- Use `tokio::time::timeout(Duration::from_secs(300), ...)` on integration tests
- Use `helm upgrade --install --wait --timeout 5m` for addon installation
- Per-step timeouts with descriptive errors ("Helm install timed out after 5m — check network connectivity")
- CI caching for Helm chart downloads if possible

### 4. TOML Values Mapping to Helm `--set`

**Risk:** TOML value types (strings, booleans, integers, floats, arrays, inline tables) need correct mapping to `helm --set` syntax.

**Mitigation:**
- Implement `toml_value_to_helm_set()` function that handles:
  - `String` → quoted value
  - `Boolean` → `true`/`false`
  - `Integer`/`Float` → numeric string
  - Nested tables → dot notation (`a.b.c=value`)
  - Arrays → `{val1,val2,val3}` (Helm set syntax)
- Add unit tests for each value type mapping
- For complex values, recommend `values_file` over inline `values`

### 5. Config Editor Concurrent Modification

**Risk:** User edits config in dashboard while also editing it in a text editor.

**Mitigation:**
- Content hash (`sha2`) included in GET response and checked on PUT
- If hash mismatch: return 409 Conflict with current content
- Frontend shows modal: "Config was modified externally. Load latest or overwrite?"
- WebSocket `ConfigChanged` event updates editor when external changes detected

### 6. CodeMirror TOML Highlighting Limitations

**Risk:** The legacy TOML mode provides basic syntax highlighting but lacks advanced features (folding, structural navigation, auto-indent).

**Mitigation:**
- Basic highlighting (keys, values, strings, comments, tables, arrays) is sufficient for a config editor
- The server-side semantic validation compensates for what the editor doesn't catch
- If a Lezer-based TOML grammar becomes available in the future, it can replace the legacy mode via the `createExtension` reactive swap

### 7. Skill File Embedding for Binary Distribution

**Risk:** `cargo install devrig` produces a standalone binary. Skill files at `skill/claude-code/SKILL.md` won't exist on the user's disk.

**Mitigation:**
- Use `include_str!()` to embed skill files in the binary at compile time
- `devrig skill install` writes the embedded content to disk
- Keep skill files small enough that embedding is negligible for binary size
- Alternative: use `rust-embed` (already a dependency) if the skill directory grows beyond a couple of files

### 8. BTreeMap Ordering for Addon Installation

**Risk:** Addons may have implicit dependencies (e.g., cert-manager CRDs must exist before a certificate is created by another addon).

**Mitigation:**
- BTreeMap provides alphabetical ordering (deterministic)
- Document that addons install in alphabetical order by key name
- For explicit ordering, users can prefix names: `01-cert-manager`, `02-traefik`
- Future enhancement: add optional `depends_on` to addon config (not needed for v0.6 — keep it simple)

### 9. k3d Built-in Traefik Conflict

**Risk:** If a user installs Traefik as an addon but doesn't disable k3d's built-in Traefik, there will be two instances competing for the same ports.

**Mitigation:**
- Document clearly: if using `[cluster.addons.traefik]`, add `--disable=traefik` to k3d args
- Consider adding a `k3s_args` field to `[cluster]` config: `k3s_args = ["--disable=traefik"]`
- Alternatively: detect the built-in Traefik and warn if an addon Traefik is also configured
- For v0.6, documentation is sufficient — automatic conflict detection can come later

### 10. Dashboard State Extension

**Risk:** Adding `config_path` to `DashboardState`/`AppState` requires threading the config file path through the orchestrator startup.

**Mitigation:**
- The config file path is already known in `Orchestrator::start()` (it's the resolved path from `-f` flag or directory walk)
- Pass it through to `DashboardState` during Phase 4.5 (dashboard startup)
- The existing `AppState` struct pattern makes this a single field addition

---

## References

### Claude Code Skills
- [Extend Claude with skills — Claude Code Docs](https://code.claude.com/docs/en/skills)
- [Skill authoring best practices — Claude API Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Inside Claude Code Skills — Mikhail Shilkov](https://mikhail.io/2025/10/claude-code-skills/)
- [Claude Skills: A First Principles Deep Dive](https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/)
- [Anthropic Engineering Blog: Equipping agents for the real world](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Anthropic Skills Repository](https://github.com/anthropics/skills)
- [Skills Directory — Installing Skills](https://www.skillsdirectory.com/docs/installing-skills)

### Helm
- [Helm Upgrade Documentation](https://helm.sh/docs/helm/helm_upgrade/)
- [Helm Best Practices](https://codersociety.com/blog/articles/helm-best-practices)
- [Helm 4 Released — Migration Guide](https://helm.sh/blog/helm-4-released/)
- [helm-wrapper-rs crate](https://crates.io/crates/helm-wrapper-rs) (evaluated, not recommended — shell-out preferred)

### Traefik
- [Traefik Kubernetes Quick Start](https://doc.traefik.io/traefik/getting-started/kubernetes/)
- [Install Traefik with Helm](https://traefik.io/blog/install-and-configure-traefik-with-helm)
- [Traefik Helm Chart GitHub](https://github.com/traefik/traefik-helm-chart)
- [k3d Ingress Explained](https://rob-mengert.medium.com/understanding-k3d-ingress-b94697638f3b)
- [K3s Networking Services](https://docs.k3s.io/networking/networking-services)

### Kustomize
- [Kustomize Official Site](https://kustomize.io/)
- [Kubernetes Kustomize Documentation](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)

### kubectl Port-Forward
- [kubectl port-forward Documentation](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_port-forward/)
- [kftray — kubectl port-forward manager](https://github.com/hcavarsan/kftray)
- [kube-forward crate](https://crates.io/crates/kube-forward)

### CodeMirror 6
- [CodeMirror 6 Official](https://codemirror.net/)
- [solid-codemirror](https://github.com/riccardoperra/solid-codemirror)
- [@codemirror/legacy-modes](https://www.npmjs.com/package/@codemirror/legacy-modes) (TOML support)
- [@codemirror/lint](https://www.npmjs.com/package/@codemirror/lint)
- [@codemirror/merge](https://www.npmjs.com/package/@codemirror/merge)
- [CodeMirror vs Monaco comparison — Sourcegraph](https://sourcegraph.com/blog/migrating-monaco-codemirror)

### TOML Parsing
- [smol-toml (JavaScript)](https://github.com/squirrelchat/smol-toml)
- [toml crate (Rust)](https://crates.io/crates/toml)

### Testing
- [Playwright Best Practices 2026](https://www.browserstack.com/guide/playwright-best-practices)
- [Monaco and Playwright testing patterns](https://giacomocerquone.com/notes/monaco-playwright/)
- [tokio::process documentation](https://docs.rs/tokio/latest/tokio/process/)
- [Tokio Unit Testing guide](https://tokio.rs/tokio/topics/testing)
- [scopeguard crate](https://docs.rs/scopeguard/)
