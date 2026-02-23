# Milestone Deep-Dives

## Milestone 0 — v0.1: Local Process Orchestration

**Cost: $16.61 | Attempts: 1 | Checks: 19/19**

This was the **best-performing milestone** — first-pass success, lowest cost, and the most impactful research.

### Research Phase: A+
- 1,459 lines of foundational research
- Every crate recommendation (clap, toml, petgraph, tokio, nix, owo-colors) held through v0.6
- Design patterns (supervisor loop, phased startup, template resolution) became the project skeleton
- Zero wasted research — every section was used

### Architecture Phase: A
- 15 well-ordered steps across 4 phases
- Clean dependency ordering
- 21 source files, 10 test files, 16 doc files planned

### Execution: A
- Clean first-attempt pass
- No fixes needed
- 45 unit tests, 9 integration tests all passing

### Verdict
This is what the pipeline looks like when it works optimally. The research was genuinely novel (no prior codebase to reference), the plan was well-scoped, and the execution was clean.

---

## Milestone 1 — v0.2: Infrastructure Containers

**Cost: $28.36 | Attempts: 2 | Checks: 30/30**

### Research Phase: A
- 1,283 lines covering bollard, backon, reqwest
- Correctly identified bollard (Docker API) and backon (retries) — both used through v0.6
- Service discovery pattern was well-designed

### Architecture Phase: B+
- 23 steps across 6 phases
- Slightly ambitious — gaps in documentation paths and integration test coverage

### Execution: B
- First pass completed all implementation but failed 7 checks:
  - `cargo fmt` drift (17 files)
  - Test race conditions
  - Missing integration test files
  - Wrong documentation paths
- Fix pass addressed all issues

### Key Waste: `cargo fmt`
If the execute agent had run `cargo fmt` before finishing, this milestone would have been a first-pass success. The other failures (missing test files, wrong paths) were planning gaps, not execution failures.

**Estimated preventable cost: ~$10-12**

---

## Milestone 2 — v0.3: k3d Cluster Support

**Cost: $25.42 | Attempts: 2 | Checks: 42/42**

### Research Phase: A-
- 822 lines
- **Best decision of the entire pipeline:** Rejected kube-rs (Rust K8s client) in favor of shelling out to kubectl
- This saved enormous complexity and the pattern scaled cleanly through v0.6

### Architecture Phase: A-
- 20 steps across 4 phases
- Missed the kubeconfig port-0 edge case that k3d produces

### Execution: B+
- 3 genuine runtime issues:
  1. k3d writes `server: https://0.0.0.0:0` before real port assigned → needed polling loop
  2. Async cleanup in scopeguard → double panic
  3. Stale container name conflicts

### Key Insight
These were **real bugs**, not mechanical failures. The fix pass addressed genuine runtime issues that couldn't have been caught by linting. This is the fix cycle working as designed.

**Preventable cost: ~$0** (legitimate retry)

---

## Milestone 3 — v0.4: Developer Experience Polish

**Cost: $34.74 | Attempts: 3 | Checks: 34/34**

### Research Phase: B+
- 609 lines
- Good: Rejected ratatui (overkill) — kept UI simple
- Minor gap: Underestimated broadcast channel migration effort

### Architecture Phase: A-
- 18 steps, conservative scope
- Pragmatic simplification: byte-offset TOML search instead of `Spanned<T>` refactor

### Execution: C+
- **Three attempts needed:**
  - Fix 1: `cargo fmt`, 74 clippy errors, broadcast migration issues, test timeouts
  - Fix 2: Flaky integration test with 10s timeout → increased to 30s
- **74 clippy errors** — the worst mechanical failure in the pipeline

### Key Waste: Clippy Explosion
74 clippy errors on a single milestone is a pipeline design failure. The execute phase prompt should mandate `cargo clippy` before completion. This single failure consumed an entire retry cycle.

**Estimated preventable cost: ~$12-15**

---

## Milestone 4 — v0.5: Observability + Dashboard

**Cost: $41.90 | Attempts: 3 | Checks: 69/69**

The most expensive and complex milestone — full-stack with gRPC server, HTTP server, ring buffer storage, WebSocket, REST API, SolidJS dashboard, and 76 E2E tests.

### Research Phase: B
- 705 lines
- **Version mismatch:** Recommended opentelemetry-proto 0.31 + tonic 0.14, but the plan had to correct to 0.27 + 0.12 for dependency compatibility with existing axum 0.8
- Frontend research (SolidJS, solid-uplot) was accurate

### Architecture Phase: A
- 27 steps across 10 phases — largest plan
- Well-structured despite massive scope
- Smart E2E validation: `--list` (discoverability) instead of full execution

### Execution: B
- Implementation was architecturally correct on first pass
- Fix passes were minor — mainly the E2E validation approach adjustment
- High cost reflects volume (largest codebase delta by far), not failure count

### Key Insight: Research Version Recommendations
The research phase recommended bleeding-edge crate versions without checking transitive dependency compatibility. The architect phase caught and corrected this. This suggests the research phase should include a `cargo add --dry-run` or dependency resolution check.

**Estimated preventable cost: ~$5-8** (from version correction back-and-forth)

---

## Milestone 5 — v0.6: Claude Code Skill + Cluster Addons

**Cost: $30.67 | Attempts: 3 | Checks: 58-59/59**

### Research Phase: C+
- 871 lines, but ~50% was codebase state assessment (documenting existing architecture)
- Zero new Rust crates needed — the research documented what already existed
- Only genuinely new research: CodeMirror 6, smol-toml, helm patterns

### Architecture Phase: B+
- 18 steps in 7 phases
- Four distinct features packed into one milestone — well-bounded individually

### Execution: B-
- **Three attempts, two fix rounds:**
  - Round 1: 8 compilation and integration issues
  - Round 2: 6 fixes for a single root cause — `BTreeMap<String, String>` key type errors in one test file
- The pipeline treated 6 symptoms of one bug as separate fixes

### Key Waste: Research + Single-Root-Cause Fix
1. Research phase spent ~400 lines documenting architecture that's already in prior milestone reports
2. Fix round 2 burned an entire retry cycle on 6 symptoms of one type error

**Estimated preventable cost: ~$15-20**

---

## Summary Table

```
Milestone  Version  Attempts  Cost     First-Pass  Primary Waste
────────── ──────── ───────── ──────── ─────────── ─────────────────────
0          v0.1     1         $16.61   PASS        None
1          v0.2     2         $28.36   FAIL        cargo fmt (17 files)
2          v0.3     2         $25.42   FAIL        None (legitimate bugs)
3          v0.4     3         $34.74   FAIL        74 clippy errors
4          v0.5     3         $41.90   FAIL        Version mismatch
5          v0.6     3         $30.67   FAIL        Redundant research + type errors
```

## Test Growth Across Milestones

```
  Tests by milestone (cumulative)
  400 ┤
  350 ┤                                    ████  367
  300 ┤                              ████  ████
  250 ┤                              ████  ████
  200 ┤                        ████  ████  ████
  150 ┤                  ████  ████  ████  ████
  100 ┤            ████  ████  ████  ████  ████
   50 ┤      ████  ████  ████  ████  ████  ████
    0 ┤ ████ ████  ████  ████  ████  ████  ████
      └─────────────────────────────────────────
        v0.1  v0.2  v0.3  v0.4  v0.5  v0.6

        ░░░░ Unit  ▓▓▓▓ Integration  ████ E2E
```

| Version | Unit | Integration | E2E | Total |
|---------|------|-------------|-----|-------|
| v0.1 | 45 | 9 | 0 | 54 |
| v0.2 | 98 | 28 | 0 | 126 |
| v0.3 | 127 | 31 | 0 | 158 |
| v0.4 | 173 | 43 | 0 | 216 |
| v0.5 | 211 | 51 | 76 | 338 |
| v0.6 | 228 | 60 | 79 | 367 |
