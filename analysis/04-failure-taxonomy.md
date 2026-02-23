# Failure Taxonomy

Every failure across all 14 attempts, classified by root cause.

## Classification

### Category 1: Mechanical (Preventable by Tooling)

These failures have nothing to do with the agent's intelligence or the task's complexity. They are process failures that should never reach the verification phase.

| Milestone | Failure | Root Cause | Cost Impact |
|-----------|---------|-----------|-------------|
| v0.2 | 17 files need `cargo fmt` | Execute phase didn't run formatter | ~$10 |
| v0.4 | 74 clippy warnings/errors | Execute phase didn't run linter | ~$12 |
| v0.4 | Additional `cargo fmt` drift | Same root cause | (included above) |
| v0.6 | `cargo fmt` issues | Same root cause | ~$5 |

**Total mechanical waste: ~$27**

**Prevention:** Add two lines to the execute phase prompt:
```
Before declaring implementation complete:
1. Run `cargo fmt` to fix formatting
2. Run `cargo clippy -- -D warnings` and fix any warnings
```

Or better: add a pre-verify gate in the pipeline that runs these automatically and feeds any errors back to the execute agent before invoking the verify phase.

### Category 2: Planning Gaps (Preventable by Better Plans)

The architect phase specified the wrong file paths, missed test files, or underspecified integration tests.

| Milestone | Failure | Root Cause | Cost Impact |
|-----------|---------|-----------|-------------|
| v0.2 | Missing 7 integration test files | Plan listed tests but didn't specify file creation | ~$5 |
| v0.2 | Wrong documentation paths | Plan used incorrect directory structure | ~$3 |
| v0.2 | Configuration guide gaps | Plan underspecified doc content | ~$2 |
| v0.5 | E2E validation approach wrong | Plan assumed tests could run without infrastructure | ~$5 |

**Total planning waste: ~$15**

**Prevention:** The architect phase should:
1. Verify every planned file path exists or can be created
2. Run `ls` / `find` to confirm directory structures before planning into them
3. Explicitly list every file to be created (not just "tests for X")
4. Include a "pre-flight check" step that validates the plan's assumptions

### Category 3: Type Errors in Tests (Preventable by Review)

The agent writes correct production code but makes type errors in test assertions, especially in integration tests that work with serialized data.

| Milestone | Failure | Root Cause | Cost Impact |
|-----------|---------|-----------|-------------|
| v0.3 | Kubeconfig port type mismatch | Used `u16` where test expected `String` | ~$3 |
| v0.5 | Option comparison without deref | `Option<String>` vs `&str` comparison | ~$3 |
| v0.6 | BTreeMap key types (6 instances) | Integer keys where map expects String | ~$8 |
| v0.6 | Temporary value lifetime issues | Chained expressions dropped too early | (included) |

**Total type error waste: ~$14**

**Prevention:**
1. Execute phase should compile and run tests before declaring completion
2. Fix phase should identify shared root causes instead of treating each compiler error as independent
3. Integration tests should be given extra review attention in the execute prompt

### Category 4: Runtime/Environmental (Legitimate Failures)

Genuine runtime issues that couldn't have been predicted from code review alone. These are the fix cycle working as designed.

| Milestone | Failure | Root Cause | Cost Impact |
|-----------|---------|-----------|-------------|
| v0.3 | k3d port 0 issue | k3d writes placeholder port before real allocation | ~$5 |
| v0.3 | scopeguard double panic | Async cleanup in blocking context | ~$3 |
| v0.3 | Container name conflicts | Stale containers from previous test runs | ~$2 |
| v0.4 | Test race condition | Broadcast channel migration timing | ~$4 |
| v0.4 | Flaky 10s timeout | Init scripts need 30s on slow systems | ~$3 |
| v0.2 | Docker resource leak | Containers not cleaned up after test | ~$3 |

**Total legitimate failure cost: ~$20**

**Prevention:** These cannot be fully prevented — they're the "real work" of the fix cycle. However, some could be mitigated:
- Container name conflicts → always force-remove before create
- Flaky timeouts → use longer timeouts by default (30s not 10s)
- Test race conditions → the agent should prefer `await` patterns over timing assumptions

### Category 5: Context/Research Waste (Preventable by Pipeline Design)

Tokens spent on redundant context that doesn't contribute to the milestone.

| Milestone | Waste | Root Cause | Cost Impact |
|-----------|-------|-----------|-------------|
| v0.4 | Version mismatch correction | Research recommended incompatible crate versions | ~$5 |
| v0.6 | 400 lines of codebase assessment | Research re-documented known architecture | ~$8 |
| v0.3-v0.6 | Growing prior context | Full reports from all prior milestones in every prompt | ~$12 |

**Total context waste: ~$25**

**Prevention:** See [Optimization Playbook](05-optimization-playbook.md) for adaptive research and context summarization strategies.

## Failure Distribution

```
  Failures by category (estimated cost impact)

  Mechanical:     ████████████████████████████  $27  (33%)
  Context waste:  ██████████████████████████     $25  (31%)
  Legitimate:     ████████████████████           $20  (25%)
  Planning gaps:  ████████████████               $15  (18%)  (note: some overlap)
  Type errors:    ██████████████                 $14  (17%)

  Note: Categories can overlap. Total > 100% because
  some failures belong to multiple categories.
```

## Key Pattern: Failure Rate by Attempt Number

```
  What happens on each attempt:

  Attempt 1 (execute):   1/6 pass  (17%)  — Only v0.1 passed first try
  Attempt 2 (fix):       2/5 pass  (40%)  — v0.2 and v0.3 fixed in one round
  Attempt 3 (fix):       3/3 pass  (100%) — All remaining passed on final attempt
```

This shows that:
1. The execute phase almost never produces clean output (83% failure rate)
2. Most issues are fixable in 1-2 fix rounds
3. No milestone exhausted its retry budget and blocked the pipeline

## The "Fix Cascade" Anti-Pattern

In milestone 5, fix round 2 addressed 6 separate compiler errors that all stemmed from one root cause: using integer literals as `BTreeMap<String, String>` keys in a test file. The pipeline treated each as an independent fix, wasting context and tokens.

**A smarter fix phase would:**
1. Group compiler errors by file
2. Identify shared root causes (e.g., "all errors in `addon_lifecycle.rs` are type mismatches")
3. Fix the root cause once instead of treating each error message independently

This pattern also appeared in milestone 3 (clippy errors) where the fix phase addressed 74 warnings individually rather than identifying the 3-4 root causes.
