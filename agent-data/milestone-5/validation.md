# Validation Criteria — v0.6: Claude Code Skill + Cluster Addons

## Standard Build Checks

| # | Check | Command | Expected |
|---|-------|---------|----------|
| 1 | Code formatting | `cargo fmt --check` | Exit 0, no differences |
| 2 | Lint warnings | `cargo clippy -- -D warnings` | Exit 0, zero warnings |
| 3 | Full build | `cargo build` | Exit 0 |
| 4 | Unit tests | `cargo test -- --quiet` | All pass (211+ tests, 0 failures) |
| 5 | Frontend build | `cd dashboard && npm run build` | Exit 0, dist/ produced |

## Feature 1: Claude Code Skill

| # | Check | Command / Method | Expected |
|---|-------|------------------|----------|
| 6 | SKILL.md exists | `test -f skill/claude-code/SKILL.md` | File exists |
| 7 | SKILL.md has frontmatter | `head -5 skill/claude-code/SKILL.md` | Contains `name: devrig` |
| 8 | SKILL.md has description | `grep -q 'description:' skill/claude-code/SKILL.md` | Present |
| 9 | SKILL.md has allowed-tools | `grep -q 'allowed-tools' skill/claude-code/SKILL.md` | Present |
| 10 | SKILL.md references query commands | `grep -c 'devrig query' skill/claude-code/SKILL.md` | >= 5 occurrences |
| 11 | SKILL.md under 300 lines | `wc -l < skill/claude-code/SKILL.md` | < 300 |
| 12 | Skill commands are valid subcommands | `cargo test --features integration skill_commands_are_valid` | Pass |

## Feature 2: `devrig skill install` Command

| # | Check | Command / Method | Expected |
|---|-------|------------------|----------|
| 13 | CLI command registered | `cargo run -- skill install --help` | Exit 0, shows --global flag |
| 14 | Skill module exists | `test -f src/commands/skill.rs` | File exists |
| 15 | include_str! embeds SKILL.md | `grep -q 'include_str!' src/commands/skill.rs` | Present |
| 16 | Project-local install test | `cargo test --features integration skill_install_project_local` | Pass |
| 17 | Global install test | `cargo test --features integration skill_install_global` | Pass |
| 18 | Idempotent install test | `cargo test --features integration skill_install_idempotent` | Pass |

## Feature 3: Cluster Addons

| # | Check | Command / Method | Expected |
|---|-------|------------------|----------|
| 19 | AddonConfig in model | `grep -q 'AddonConfig' src/config/model.rs` | Present |
| 20 | Serde tag dispatch | `grep -q 'serde(tag = "type")' src/config/model.rs` | Present on AddonConfig |
| 21 | Addons field on ClusterConfig | `grep -q 'addons' src/config/model.rs` | Present |
| 22 | Backwards compat (serde default) | `grep -A1 'addons' src/config/model.rs \| grep -q 'serde(default)'` | Present |
| 23 | Addon config parsing tests | `cargo test config::model::tests::parse_addon -- --quiet` | Pass (3+ tests) |
| 24 | Addon validation tests | `cargo test config::validate::tests::validate_addon -- --quiet` | Pass (3+ tests) |
| 25 | AddonState in state.rs | `grep -q 'AddonState' src/orchestrator/state.rs` | Present |
| 26 | Addon module exists | `test -f src/cluster/addon.rs` | File exists |
| 27 | Helm set conversion tests | `cargo test cluster::addon -- --quiet` | Pass (5+ tests) |
| 28 | Helm doctor check | `grep -q 'helm' src/commands/doctor.rs` | Present |
| 29 | Addon integration test exists | `test -f tests/integration/addon_lifecycle.rs` | File exists |
| 30 | Addon lifecycle test (if k3d+helm) | `cargo test --features integration addon_helm -- --quiet` | Pass (or skip if no k3d/helm) |

## Feature 4: Config Editor

### Backend

| # | Check | Command / Method | Expected |
|---|-------|------------------|----------|
| 31 | Config routes module exists | `test -f src/dashboard/routes/config.rs` | File exists |
| 32 | GET /api/config route | `grep -q '/api/config' src/dashboard/routes/mod.rs` | Present |
| 33 | POST /api/config/validate route | `grep -q 'config/validate' src/dashboard/routes/mod.rs` | Present |
| 34 | PUT /api/config route | `grep -q 'put.*config\|config.*put' src/dashboard/routes/mod.rs` | Present |
| 35 | DashboardState has config_path | `grep -q 'config_path' src/dashboard/routes/mod.rs` | Present |
| 36 | SHA-256 hash used | `grep -q 'sha2\|Sha256' src/dashboard/routes/config.rs` | Present |

### Frontend

| # | Check | Command / Method | Expected |
|---|-------|------------------|----------|
| 37 | ConfigEditor component exists | `test -f dashboard/src/components/ConfigEditor.tsx` | File exists |
| 38 | ConfigView exists | `test -f dashboard/src/views/ConfigView.tsx` | File exists |
| 39 | CodeMirror in package.json | `grep -q 'codemirror' dashboard/package.json` | Present |
| 40 | smol-toml in package.json | `grep -q 'smol-toml' dashboard/package.json` | Present |
| 41 | Config route in App.tsx | `grep -q 'config' dashboard/src/App.tsx` | Present |
| 42 | Config nav in Sidebar | `grep -q 'Config' dashboard/src/components/Sidebar.tsx` | Present |
| 43 | Frontend builds with new deps | `cd dashboard && npm run build` | Exit 0 |

### E2E Tests

| # | Check | Command / Method | Expected |
|---|-------|------------------|----------|
| 44 | E2E test file exists | `test -f e2e/dashboard/config-editor.test.ts` | File exists |
| 45 | E2E tests discoverable | `cd e2e && npx playwright test --list 2>/dev/null \| grep -c config-editor` | >= 3 tests |

## Documentation

| # | Check | Command / Method | Expected |
|---|-------|------------------|----------|
| 46 | Skill guide exists | `test -f docs/guides/claude-code-skill.md` | File exists |
| 47 | Skill guide has install instructions | `grep -q 'devrig skill install' docs/guides/claude-code-skill.md` | Present |
| 48 | Skill guide has example prompts | `grep -q 'Why is the API slow' docs/guides/claude-code-skill.md` | Present |
| 49 | Config guide has addons section | `grep -q 'cluster.addons' docs/guides/configuration.md` | Present |
| 50 | Config guide has Traefik example | `grep -q '[Tt]raefik' docs/guides/configuration.md` | Present |

## Backwards Compatibility

| # | Check | Command / Method | Expected |
|---|-------|------------------|----------|
| 51 | Existing unit tests pass | `cargo test -- --quiet` | 211+ tests pass, 0 failures |
| 52 | Existing integration tests pass | `cargo test --features integration start_stop -- --quiet` | Pass |
| 53 | Config without addons parses | Parse `[project]\nname = "test"\n[cluster]` — addons defaults to empty | No parse error |
| 54 | Config without dashboard parses | Parse `[project]\nname = "test"` — dashboard is None | No parse error |
| 55 | No new Rust crate dependencies | `diff` Cargo.toml — no new `[dependencies]` entries | No new crates |

## Integration Test Module Registration

| # | Check | Command / Method | Expected |
|---|-------|------------------|----------|
| 56 | skill_install in integration.rs | `grep -q 'skill_install' tests/integration.rs` | Present |
| 57 | addon_lifecycle in integration.rs | `grep -q 'addon_lifecycle' tests/integration.rs` | Present |

## Resource Leak Check

| # | Check | Command / Method | Expected |
|---|-------|------------------|----------|
| 58 | No leaked Docker containers | `docker ps --filter label=devrig.project -q \| wc -l` | 0 (after test cleanup) |
| 59 | No leaked k3d clusters | `k3d cluster list -o json 2>/dev/null \| grep -c devrig-test` | 0 (after test cleanup) |

---

## Summary

**Total checks: 59**

- Standard build: 5
- Claude Code skill: 7
- Skill install command: 6
- Cluster addons: 12
- Config editor backend: 6
- Config editor frontend: 7
- Config editor E2E: 2
- Documentation: 5
- Backwards compatibility: 5
- Integration test registration: 2
- Resource leak check: 2

### Pass Criteria

- **Required for pass:** Checks 1–5 (build quality), 6–18 (skill), 19–28 (addon config/unit), 31–43 (config editor), 46–57 (docs + compat)
- **Conditional:** Check 30 (addon integration) — passes if k3d+helm available, skips otherwise
- **Post-test:** Checks 44–45 (E2E discoverable), 58–59 (resource leaks)
