# .NET CLI Experiment: Raw vs Structured Comparison

Two identical prompts ("build a .NET CLI task tracker with clean architecture, DDD, and ASCII art") were run with Claude Opus 4.6 via `claude -p --output-format stream-json --verbose`. The difference: the **structured** run was given a system prompt instructing it to first write a PRD, then a tasks.yml, then execute against those plans. The **raw** run was given no such instructions and went straight to coding.

Both sessions: model `claude-opus-4-6`, permission mode `bypassPermissions`, Claude Code v2.1.51.

---

## Summary Table

| Metric                        | Raw ("dotnet-raw")     | Structured ("dotnet-structured") | Delta              |
|-------------------------------|------------------------|----------------------------------|--------------------|
| **Total cost**                | $1.5665                | $2.2744                          | +$0.71 (+45.2%)    |
| **Wall-clock duration**       | 8.1 min (486s)         | 10.6 min (634s)                  | +2.5 min (+30.3%)  |
| **API time**                  | 4.4 min (267s)         | 6.5 min (391s)                   | +2.1 min (+46.4%)  |
| **API turns**                 | 61                     | 63                               | +2                 |
| **Total tool calls**          | 60                     | 62                               | +2                 |
| **Output tokens (Opus)**      | 14,931                 | 22,753                           | +7,822 (+52.4%)    |
| **Cache read tokens (Opus)**  | 1,976,409              | 2,833,438                        | +857,029 (+43.4%)  |
| **Cache creation (Opus)**     | 29,838                 | 42,991                           | +13,153 (+44.1%)   |
| **Files created**             | 16                     | 23                               | +7                 |
| **Test files written**        | 0                      | 7                                | +7                 |
| **Tests passing**             | 0 (no tests)           | 37 (26 domain + 11 application)  | +37                |
| **Errors encountered**        | 6                      | 6                                | same               |
| **Used plan mode**            | No                     | No                               | same               |
| **Planning artifacts**        | None                   | prd.md, tasks.yml                | +2 artifacts       |
| **Start time (ntfy)**         | 23:05:04               | 23:05:02                         | (concurrent)       |
| **End time (ntfy)**           | 23:12:48               | 23:15:15                         | +2m 27s            |

---

## 1. Cost Breakdown

### Raw
| Model                   | Input    | Output  | Cache Read  | Cache Create | Cost     |
|-------------------------|----------|---------|-------------|--------------|----------|
| claude-opus-4-6         | 49       | 14,931  | 1,976,409   | 29,838       | $1.5482  |
| claude-haiku-4-5-20251001 | 13,117 | 1,034   | 0           | 0            | $0.0183  |
| **Total**               |          |         |             |              | **$1.5665** |

### Structured
| Model                   | Input    | Output  | Cache Read  | Cache Create | Cost     |
|-------------------------|----------|---------|-------------|--------------|----------|
| claude-opus-4-6         | 63       | 22,753  | 2,833,438   | 42,991       | $2.2546  |
| claude-haiku-4-5-20251001 | 15,265 | 913     | 0           | 0            | $0.0198  |
| **Total**               |          |         |             |              | **$2.2744** |

The structured run cost 45% more, driven almost entirely by higher Opus output tokens (+52%) and cache read volume (+43%). The planning artifacts (PRD + tasks.yml) and 7 test files account for the extra output tokens.

---

## 2. Duration

| Measure      | Raw      | Structured | Delta        |
|--------------|----------|------------|--------------|
| Wall clock   | 486.5s   | 633.7s     | +147s (+30%) |
| API time     | 266.9s   | 391.0s     | +124s (+46%) |
| Non-API time | 219.6s   | 242.7s     | +23s (+10%)  |

The non-API time (dotnet build/restore, file I/O) was similar. The extra wall time is dominated by more API round-trips and higher output token generation.

---

## 3. Tool Usage

### Raw (60 tool calls)
| Tool      | Count |
|-----------|-------|
| Bash      | 29    |
| Write     | 17    |
| TodoWrite | 7     |
| Read      | 3     |
| Glob      | 2     |
| Edit      | 2     |

### Structured (62 tool calls)
| Tool      | Count |
|-----------|-------|
| Bash      | 28    |
| Write     | 25    |
| TodoWrite | 5     |
| Read      | 2     |
| Glob      | 1     |
| Edit      | 1     |

Key difference: the structured run used 8 more Write calls (25 vs 17), reflecting the extra files it created (prd.md, tasks.yml, and 7 test files). The raw run used slightly more Bash and TodoWrite calls.

Neither run used EnterPlanMode or ExitPlanMode.

---

## 4. Tool Batching Behavior

### Raw
- **47 unique assistant messages** contained tool calls
- **42 turns** had exactly 1 tool call
- **5 turns** had 2+ tool calls (batched)
- Batch sizes: 8, 4, 2, 2, 2
- Average tools per turn: **1.28**
- Max tools in one turn: **8**

The raw run batched aggressively in two key moments:
- 8 Write calls in one turn (writing all application use cases at once)
- 4 Write calls in one turn (domain entities + value objects)

### Structured
- **61 unique assistant messages** contained tool calls
- **60 turns** had exactly 1 tool call
- **1 turn** had 2 tool calls (batched)
- Batch size: 2 (initial ls + dotnet --version)
- Average tools per turn: **1.02**
- Max tools in one turn: **2**

The structured run was almost entirely serial -- one tool per turn. It did NOT batch file writes, even when writing sequential files in the same layer.

**Conclusion:** The raw run was significantly more aggressive at tool batching. It wrote 4-8 files per turn when building a layer, while the structured run wrote files one at a time.

---

## 5. Plan Mode

Neither run used `EnterPlanMode` or `ExitPlanMode` tool calls.

However, there is an important distinction:
- **Raw** used `TodoWrite` to create a 6-item checklist directly, then began coding immediately.
- **Structured** first wrote two planning artifacts (`prd.md` with full PRD, `tasks.yml` with 10 dependency-ordered tasks), then used `TodoWrite` as a 4-item high-level tracker while executing against the task plan.

The structured run's "planning" was done through file creation, not through the built-in plan mode.

---

## 6. Intermediate Artifacts

### Raw
- **None.** Went directly from prompt to `dotnet new sln` + coding. Used `TodoWrite` as its only planning mechanism (6 in-memory checklist items).

### Structured
- **prd.md** -- Full product requirements document (4,607 bytes) covering: overview, user stories, architecture diagram, data model, ranking algorithm, CLI commands, acceptance criteria.
- **tasks.yml** -- 10 dependency-ordered implementation tasks with acceptance criteria. Each task had: id, name, description, acceptance criteria, dependencies, done flag.

The structured run read `tasks.yml` once during execution (to mark all tasks as done at the end) but never re-read `prd.md`. The PRD and task plan were effectively consumed through the context window during creation, not by re-reading them later.

---

## 7. Errors and Recovery

### Raw (6 errors)
1. **MSB1009** -- Solution file not found (the `.slnx` vs `.sln` name issue). Used `Glob` to find it.
2. **Runtime crash (exit 134)** -- `System.AggregateException` when testing the CLI. Fixed by debugging the JSON deserialization issue and rewriting the persistence layer.
3. **Build warnings (CS8618)** -- Non-nullable property warnings. Fixed by adding required modifier.

### Structured (6 errors)
1. **MSB1009** -- Same `.slnx` vs `.sln` issue. Used `ls`, `Glob`, then `pwd` to find it (took 3 turns to resolve vs 1 for raw).
2. **File not read yet** -- Tried to `Edit` tasks.yml without reading it first. Recovered by reading then editing.
3. **Build error** -- Compilation error in CLI layer. Fixed by modifying the code.

Both runs hit the same .NET 10 `.slnx` naming issue. The raw run recovered faster (1 turn) while the structured run took 3 turns to diagnose the same problem.

---

## 8. Output Quality Differences

### Raw ("NextTask")
- 4 projects: Domain, Application, Infrastructure, Cli
- No test projects
- 4 priority levels: Critical, High, Medium, Low
- Simple priority-based ordering (no urgency/due dates)
- 6 CLI commands: next, add, list, start, done, delete
- ASCII art with box-drawing characters
- 16 source files created

### Structured ("NextUp")
- 6 projects: Domain, Application, Infrastructure, Cli + 2 test projects
- **37 unit tests** (26 domain, 11 application)
- 5 priority levels: Someday, Low, Medium, High, Critical (1-5 scale)
- Ranking algorithm: priority x urgency factor (with due date proximity tiers)
- 6 CLI commands: add, next, list, done, remove, show
- ASCII art with ANSI color codes and box-drawing
- System.CommandLine for argument parsing (NuGet package)
- 23 source files created

The structured run produced a more complete application with unit tests, a ranking algorithm, and proper CLI argument parsing via a NuGet library. The raw run skipped tests entirely and used manual argument parsing.

---

## 9. Key Takeaways

1. **Structured is 45% more expensive and 30% slower** -- the planning phase (PRD + tasks.yml) adds cost without reducing implementation time.

2. **Structured produces higher-quality output** -- unit tests (37 passing), more sophisticated ranking algorithm, proper CLI library usage. The PRD front-loaded design decisions that led to a more complete product.

3. **Raw batches tools more aggressively** -- 1.28 tools/turn vs 1.02 tools/turn. Raw wrote up to 8 files in a single turn; structured never batched writes.

4. **Neither used plan mode** -- both used TodoWrite for tracking, but the structured run's real "planning" was done through prd.md and tasks.yml file creation.

5. **Planning artifacts were write-once** -- the structured run never re-read prd.md during execution. tasks.yml was only read once at the end to mark tasks done. The planning value came from forcing the model to think through the design before coding, not from referencing the artifacts during implementation.

6. **Error recovery was similar** -- both hit 6 errors with similar recovery patterns. The raw run was slightly faster at recovering from the .slnx naming issue.

7. **The token cost difference is primarily output tokens** -- the structured run generated 52% more output tokens (22,753 vs 14,931), reflecting the PRD, tasks.yml, test files, and more verbose implementation.
