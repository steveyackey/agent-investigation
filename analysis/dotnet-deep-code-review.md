# Deep Code Review: Raw Prompt vs Structured Agent — .NET CLI Apps

## Background

Both apps were built by AI agents given the same core prompt:

> "create a .net cli with clean arch and ddd that allows you to track the next most important task. use ascii art."

- **Raw**: Agent received only the raw prompt. No planning artifacts, no PRD, no task breakdown.
- **Structured**: Agent first generated a PRD (`prd.md`), then a task breakdown (`tasks.yml`) with acceptance criteria, then executed task-by-task with verification.

This review compares the resulting codebases across seven dimensions.

---

## File Inventory

### Raw App (`NextTask.*`) — 15 source files, 0 test files

| Layer | Files |
|---|---|
| Domain | `TaskItem.cs`, `Priority.cs`, `TaskStatus.cs`, `ITaskRepository.cs` |
| Application | `TaskDto.cs`, `TaskMapper.cs`, `AddTaskUseCase.cs`, `GetNextTaskUseCase.cs`, `ListTasksUseCase.cs`, `CompleteTaskUseCase.cs`, `StartTaskUseCase.cs`, `DeleteTaskUseCase.cs` |
| Infrastructure | `TaskRecord.cs`, `JsonTaskRepository.cs` |
| CLI | `AsciiArt.cs`, `ConsoleRenderer.cs`, `Program.cs` |

### Structured App (`NextUp.*`) — 14 source files, 7 test files

| Layer | Files |
|---|---|
| Domain | `TaskItem.cs`, `Priority.cs`, `TaskRank.cs`, `TaskRankingService.cs` |
| Application | `ITaskRepository.cs`, `AddTaskCommand.cs`, `CompleteTaskCommand.cs`, `RemoveTaskCommand.cs`, `GetNextTaskQuery.cs`, `ListTasksQuery.cs`, `GetTaskByIdQuery.cs` |
| Infrastructure | `TaskDto.cs`, `JsonTaskRepository.cs` |
| CLI | `AsciiRenderer.cs`, `Program.cs` |
| Tests (Domain) | `PriorityTests.cs`, `TaskItemTests.cs`, `TaskRankingServiceTests.cs` |
| Tests (Application) | `FakeTaskRepository.cs`, `AddTaskCommandTests.cs`, `CompleteTaskCommandTests.cs`, `QueryTests.cs` |

---

## 1. Clean Architecture Adherence

### Rating: Raw 5/10, Structured 9/10

### Raw App — Structural Violations

**The repository interface lives in the wrong layer.** `ITaskRepository` is defined in `NextTask.Domain.Repositories`, which means the Domain layer defines persistence contracts. In strict Clean Architecture, the Domain layer should contain only entities, value objects, and domain services — it should not know about persistence concepts at all. Repository interfaces belong in the Application layer (the "ports" in ports-and-adapters).

**Project reference chain:**
```
Domain       → (none)          ✓ correct
Application  → Domain          ✓ correct
Infrastructure → Application   ✓ correct (gets Domain transitively)
Cli          → Application + Infrastructure  ✓ correct
```

The raw app's reference chain is technically valid, but the misplaced interface means the Domain project implicitly carries a persistence concern. Any consumer of Domain is now aware of `ITaskRepository`.

**The DTO and mapper live in Application.** `TaskDto` and `TaskMapper` in the Application layer is fine — this is a reasonable place for presentation-facing data shapes. However, the DTO is tightly coupled to the rendering layer's needs (it carries `PriorityIndicator` and `StatusIcon` strings) which leaks presentation concerns into Application.

### Structured App — Clean Boundaries

**Repository interface correctly placed in Application.** `ITaskRepository` lives in `NextUp.Application.Interfaces`, which is the canonical Clean Architecture position. The Domain layer has zero outward dependencies and zero knowledge of persistence.

**Project reference chain:**
```
Domain       → (none)          ✓ correct
Application  → Domain          ✓ correct
Infrastructure → Application + Domain  ✓ correct
Cli          → Application + Infrastructure + Domain  ✓ correct
```

Infrastructure references both Application (for the interface) and Domain (for entity types). This is textbook.

**The DTO is in Infrastructure, not Application.** `TaskDto` in `NextUp.Infrastructure.Persistence` serves only as a serialization shape — it has no rendering-specific fields. The CLI layer works directly with `TaskItem` domain entities, which is a debatable but defensible choice (the CLI is an adapter layer that can touch domain types).

**Minor quibble:** The CLI's `BuildAddCommand` etc. methods accept `JsonTaskRepository` (the concrete type) rather than `ITaskRepository`. This is a composition root concern and not a serious violation since `Program.cs` is the composition root, but passing the interface would be cleaner.

**Verdict:** The structured agent's PRD explicitly laid out the layer boundaries and what belongs where. The `tasks.yml` task 1 had acceptance criteria: "Project references follow Clean Architecture (Domain has no project refs, App refs Domain, Infra refs App+Domain, Cli refs all)." This specificity paid off. The raw agent made the common mistake of putting the repository interface in Domain — a mistake that many experienced developers also make, but one that the PRD prevented.

---

## 2. DDD Patterns

### Rating: Raw 6/10, Structured 8/10

### Shared Strengths

Both apps implement:
- **Entities** with factory methods (`TaskItem.Create(...)`) and private setters
- **Value Objects** as `sealed record` types (`Priority`)
- **Encapsulated state transitions** (`Complete()` method with guard clauses)
- **No anemic domain models** — entities enforce their own invariants

### Raw App — Additional DDD Surface Area

The raw app has an extra value object, `TaskStatus`, which models the task lifecycle states (Pending, InProgress, Done) as a proper value object with labels and icons:

```csharp
public static readonly TaskStatus Pending = new("Pending", "[ ]");
public static readonly TaskStatus InProgress = new("In Progress", "[~]");
public static readonly TaskStatus Done = new("Done", "[x]");
```

This is a richer domain model — the raw agent independently decided to add a `Start()` transition and a three-state lifecycle. The structured app only has two states: active and completed (modeled via `CompletedAt` being null or not). The raw app's `TaskStatus` value object is a more complete DDD implementation because it explicitly models the concept rather than deriving it from a nullable timestamp.

The raw app also has a `Reprioritize()` and `UpdateTitle()` method on the entity, showing intention-revealing operations that go beyond the prompt requirements. These are genuine DDD-style behaviors on the aggregate.

### Structured App — Domain Service and Ranking Value Object

The structured app has two DDD elements the raw app completely lacks:

1. **`TaskRank` value object** — wraps the computed score as a proper domain concept implementing `IComparable<TaskRank>`. This means the ranking score is not a raw `double` floating through the system; it is a named type with domain semantics.

2. **`TaskRankingService` domain service** — a stateless service that computes urgency factors and ranks tasks. This is textbook DDD: when logic does not naturally belong to a single entity, it goes in a domain service. The ranking algorithm is explicit, testable, and documented through its method signatures.

The raw app has no domain service. Its ranking logic is inline in `GetNextTaskUseCase`:

```csharp
var next = all
    .Where(t => !t.Status.IsComplete)
    .OrderBy(t => t.Priority)
    .ThenBy(t => t.CreatedAt)
    .FirstOrDefault();
```

This is a simpler ranking (just priority weight ordering), but critically, the ranking logic lives in the Application layer rather than the Domain layer. If ranking is a core domain concept (and for a "next most important task" app, it is), it should be in the Domain.

### Structured App — Reconstitute Pattern

The structured app's `TaskItem.Reconstitute(...)` static method is a clean DDD pattern for hydrating entities from persistence without going through the factory method's validation and side effects (like generating a new `Guid`). The raw app uses reflection (`SetPrivate()`) to achieve the same thing, which is more fragile and couples the infrastructure to the entity's internal property names.

```csharp
// Structured: Clean reconstitution
TaskItem.Reconstitute(dto.Id, dto.Title, dto.Description, ...);

// Raw: Reflection-based hydration
var item = TaskItem.Create(r.Title, Priority.Parse(r.Priority), r.Description);
SetPrivate(item, nameof(TaskItem.Id), r.Id);
SetPrivate(item, nameof(TaskItem.CreatedAt), r.CreatedAt);
```

The raw approach is a code smell — it calls `Create()` (which generates a new `Guid` and sets `CreatedAt` to `DateTime.UtcNow`) and then immediately overwrites those values via reflection. This means the entity temporarily exists in an inconsistent state.

**Verdict:** The raw app has a slightly richer entity model (TaskStatus value object, more behaviors), but the structured app has better DDD architecture (domain service, ranking value object, clean reconstitution). The PRD specified `TaskRank` and `TaskRankingService` explicitly, and the agent built them. The raw agent invented `TaskStatus` and `Start()` on its own initiative, which is creative but put the ranking logic in the wrong layer.

---

## 3. CLI UX

### Rating: Raw 6/10, Structured 9/10

### Command Framework

**Raw app: Hand-rolled argument parsing.** `Program.cs` is a top-level statements file with a `switch (args[0])` dispatcher. No argument library. No type-safe parsing. No auto-generated help.

```csharp
case "add":
    if (args.Length < 3)
    {
        ConsoleRenderer.ShowError("Usage: nexttask add <title> <priority> [description]");
        return 1;
    }
    var description = args.Length > 3 ? args[3] : null;
    var added = await addTask.ExecuteAsync(args[1], args[2], description);
```

This approach has problems:
- Priority is a positional arg (string name like "critical"), not an option flag
- No `-d` or `--description` option syntax; description is the 4th positional arg
- No `--due` date support at all (despite "next most important task" being the core feature)
- Help text is manually maintained in `ShowHelp()`
- Error messages for wrong argument counts are ad-hoc

**Structured app: `System.CommandLine`.** The structured app uses Microsoft's official `System.CommandLine` library with proper `Argument<T>`, `Option<T>`, typed handlers, and auto-generated help:

```csharp
var titleArg = new Argument<string>("title", "Task title");
var descOption = new Option<string?>(["-d", "--description"], "Task description");
var priorityOption = new Option<int>(["-p", "--priority"], () => 3, "Priority 1-5");
var dueOption = new Option<DateTimeOffset?>("--due", "Due date (e.g. 2026-03-01)");
```

Advantages:
- Type-safe parsing (priority is `int`, due date is `DateTimeOffset?`)
- Named options with short aliases (`-d`, `-p`)
- Default values (`() => 3` for priority)
- Auto-generated `--help` output with descriptions
- Tab completion support (built into System.CommandLine)

### Commands Available

| Command | Raw | Structured |
|---|---|---|
| add | yes (positional args) | yes (named options) |
| next | yes | yes |
| list | yes (`--all` flag) | yes |
| done | yes | yes (shows next task after completion) |
| delete/remove | yes (called `delete`) | yes (called `remove`) |
| start | yes (unique to raw) | no |
| show | no | yes |
| help | yes (manual) | yes (auto-generated) |

The raw app added `start` (marking a task as in-progress) which is creative but was not requested. The structured app added `show` (view task details) per the PRD specification.

Notable structured UX detail: after completing a task with `done`, it automatically shows the next task. This is a thoughtful "what matters next" UX touch that the PRD specified ("Complete a task, which archives it and surfaces the new top task").

### Error Handling

The raw app uses a global catch for specific exception types:
```csharp
catch (Exception ex) when (ex is ArgumentException or KeyNotFoundException or InvalidOperationException)
```

The structured app catches exceptions per-command handler:
```csharp
catch (Exception ex)
{
    AsciiRenderer.PrintError(ex.Message);
}
```

Both approaches work. The raw app's pattern catch is slightly more idiomatic for a CLI entry point. The structured app catches `Exception` broadly within each handler, which is less precise but ensures no unhandled crash reaches the user.

### Short ID Resolution

Both apps support short IDs (first N characters of a GUID). Both handle the ambiguous-match case. The structured app returns `null` on error (and prints the message inline), while the raw app throws, letting the global catch handle it. Both work, but the structured approach is cleaner per-handler.

**Verdict:** The structured app's use of `System.CommandLine` is a significant UX advantage. The PRD specified it explicitly ("Uses `System.CommandLine` for argument parsing"), and the tasks.yml task 9 required all 6 commands. The raw agent rolled its own parser, which works but is less professional and harder to extend.

---

## 4. Code Quality

### Rating: Raw 7/10, Structured 8/10

### Naming

Both apps use idiomatic C# naming: PascalCase for types and members, camelCase for locals, descriptive names. Both use `sealed` classes and records appropriately.

**Structured app naming is more aligned with CQRS.** Commands (`AddTaskCommand`, `CompleteTaskCommand`, `RemoveTaskCommand`) and Queries (`GetNextTaskQuery`, `ListTasksQuery`, `GetTaskByIdQuery`) are clearly separated by naming convention and directory structure. The raw app uses the generic `*UseCase` suffix for everything.

### Modern C# Features

Both apps use:
- Primary constructors: `public sealed class AddTaskUseCase(ITaskRepository repo)`
- Collection expressions: `_cache = [];`
- Raw string literals: `"""..."""`
- File-scoped namespaces
- Pattern matching: `switch` expressions, `is null`, `is not null`
- Nullable reference types enabled

The raw app uses top-level statements for `Program.cs`, while the structured app uses an explicit `static class Program` with `Main`. Both are valid; the explicit class is slightly more conventional for production code.

### Specific Issues

**Raw — DateTime vs DateTimeOffset.** The raw app uses `DateTime.UtcNow` and `DateTime` throughout. This is a minor issue, but `DateTimeOffset` (used by the structured app) is preferred for persistence because it unambiguously carries timezone information.

**Raw — Reflection for hydration.** The `SetPrivate()` method in `JsonTaskRepository` is fragile:
```csharp
private static void SetPrivate(object obj, string propertyName, object? value)
{
    var prop = obj.GetType().GetProperty(propertyName)!;
    prop.SetValue(obj, value);
}
```
This will break silently if property names change. The `nameof()` usage helps somewhat, but the reflection is unnecessary given the alternative `Reconstitute` pattern.

**Raw — `.Result` on async tasks.** In `Program.cs`:
```csharp
var startId = ResolveId(args[1], repo).Result;
```
Calling `.Result` inside an already-async context risks deadlocks in some environments. It should be `await ResolveId(...)` since the enclosing scope is already async.

**Raw — `System.Threading.Tasks.Task` disambiguation.** In `DeleteTaskUseCase.cs`:
```csharp
public async System.Threading.Tasks.Task ExecuteAsync(Guid id)
```
The full namespace qualification suggests a naming conflict between `Task` (the entity concept) and `Task` (the async type). The structured app avoids this because its entity is `TaskItem`, not `Task`.

**Structured — Broad exception catch.** Each command handler catches `Exception` rather than specific types. This masks unexpected errors (like `NullReferenceException`) behind friendly error messages when they should crash loudly in development.

**Structured — `show` command efficiency.** The `show` command calls `ListTasksQuery` to get all ranked tasks, then searches for the one by ID. It should use `GetTaskByIdQuery` instead — the current approach ranks all tasks just to find one by ID.

**Verdict:** Both codebases are clean and idiomatic. The structured app edges ahead on naming conventions (CQRS-aligned), time handling (`DateTimeOffset`), and avoiding reflection. The raw app has the `.Result` issue and the reflection-based hydration, but compensated with a richer domain model.

---

## 5. Testing

### Rating: Raw 0/10, Structured 8/10

### Raw App — No Tests at All

The raw app has no `tests/` directory, no test projects, no test files. Zero automated verification. The solution file (`NextTask.slnx`) contains only the 4 source projects.

This is the single largest quality gap between the two apps.

### Structured App — 21 Test Cases Across 2 Projects

**Domain Tests (3 files, 12 test methods):**

| File | Tests | What's Covered |
|---|---|---|
| `PriorityTests.cs` | 4 | Valid levels (1-5 with labels), invalid levels (0, 6, -1), static property correctness, value equality |
| `TaskItemTests.cs` | 5 | Create with all fields, empty/whitespace/null title rejection, completion sets timestamp, double-complete throws, title trimming |
| `TaskRankingServiceTests.cs` | 8 | All 6 urgency tiers (no due, overdue, <24h, <3d, <7d, far out), rank = priority * urgency, RankAll sorting, completed task exclusion |

**Application Tests (3 files + 1 fake, 9 test methods):**

| File | Tests | What's Covered |
|---|---|---|
| `AddTaskCommandTests.cs` | 3 | Valid add + persistence verification, invalid priority, empty title |
| `CompleteTaskCommandTests.cs` | 3 | Complete existing task, not found, already completed |
| `QueryTests.cs` | 5 | Empty backlog returns null, highest-ranked returned first, list sorted by rank, get by ID found, get by ID not found |

**Test Quality Assessment:**

The `FakeTaskRepository` is a clean in-memory implementation of `ITaskRepository` — no mocking framework needed. This is the preferred approach for testing application services because it exercises real collection semantics without coupling to mock setup syntax.

Tests cover all the PRD's acceptance criteria:
- Priority validation boundaries (1-5)
- Task lifecycle (create, complete, double-complete guard)
- Ranking algorithm (all urgency factor tiers from the PRD)
- Query ordering (highest rank first)
- Error paths (not found, invalid input)

**What's missing:**
- No tests for `RemoveTaskCommand` (only 3 commands have dedicated test files)
- No tests for `GetTaskByIdQuery` not-found case exercised through the command (it is tested in `QueryTests`)
- No infrastructure tests (JSON serialization round-trip)
- No CLI integration tests

**Verdict:** The tasks.yml explicitly called for "Domain unit tests" (task 4) and "Application layer unit tests" (task 6) with specific acceptance criteria listing what to test. The agent delivered exactly what was specified. The raw agent, with no test requirements in its instructions, produced zero tests. This is the clearest demonstration that structured planning produces measurably better output.

---

## 6. Persistence

### Rating: Raw 7/10, Structured 7/10

### Both Apps

Both use `System.Text.Json` with `WriteIndented = true` and `CamelCase` naming policy. Both store data in `~/.<appname>/tasks.json`. Both create the directory if it does not exist.

### Raw App — Caching Layer

The raw app has an in-memory cache:
```csharp
private List<TaskRecord>? _cache;

private async Task<List<TaskRecord>> LoadAsync()
{
    if (_cache is not null) return _cache;
    // ...file read...
}
```

This avoids re-reading the file on every operation within a single CLI invocation. For a CLI tool (single invocation per command), this is a micro-optimization, but it demonstrates awareness of I/O cost.

### Raw App — Separate Persistence Model

The raw app has a clean separation: `TaskRecord` is the persistence DTO and `TaskItem` is the domain entity. The `ToRecord`/`ToEntity` mapping methods handle the translation. However, as noted above, `ToEntity` uses reflection to hydrate the entity, which is fragile.

### Structured App — Clean Mapping

The structured app also separates persistence (`TaskDto`) from domain (`TaskItem`), and uses the `Reconstitute` factory method for hydration. The mapping is explicit and requires no reflection:

```csharp
return dtos.Select(dto => TaskItem.Reconstitute(
    dto.Id, dto.Title, dto.Description,
    Priority.Create(dto.Priority),
    dto.DueDate, dto.CreatedAt, dto.CompletedAt
)).ToList();
```

### Data Model Differences

| Field | Raw (`TaskRecord`) | Structured (`TaskDto`) |
|---|---|---|
| Priority | `string` ("Medium") | `int` (3) |
| Status | `string` ("Pending") | (none — derived from `CompletedAt`) |
| DueDate | absent | `DateTimeOffset?` |
| DateTime types | `DateTime` | `DateTimeOffset` |

The structured app serializes priority as an integer, which is more compact and avoids parsing. The raw app serializes it as the label string, which is more human-readable but requires a `Parse()` step on load.

Neither app handles concurrent access (file locking). The tasks.yml acceptance criterion for task 7 specified "Handles concurrent access safely (file locking)" but the implementation does not include any locking mechanism. This is a gap between the plan and the execution.

### No Caching in Structured App

The structured app reads the file on every operation. For a CLI tool this is fine — each command invocation is short-lived.

**Verdict:** Roughly equivalent. The structured app is cleaner (no reflection, `DateTimeOffset`, integer priority), while the raw app has a caching optimization and human-readable serialization. Neither handles concurrent access.

---

## 7. "Next Most Important Task" Logic

### Rating: Raw 3/10, Structured 9/10

This is the core feature of the application. The prompt says "track the next most important task." How each app determines what is most important is the single most consequential design decision.

### Raw App — Priority-Only Sorting

```csharp
// GetNextTaskUseCase.cs
var next = all
    .Where(t => !t.Status.IsComplete)
    .OrderBy(t => t.Priority)       // sorts by Priority.Weight (1=Critical, 4=Low)
    .ThenBy(t => t.CreatedAt)        // ties broken by creation time
    .FirstOrDefault();
```

The raw app sorts solely by the priority value object's `Weight` property (1 = Critical, 2 = High, 3 = Medium, 4 = Low), with creation date as tiebreaker. There is:

- **No due date field on the entity.** The raw app's `TaskItem` has no `DueDate` property at all.
- **No urgency factor.** Without due dates, there is no concept of "this task is overdue" or "this is due tomorrow."
- **No ranking algorithm.** The "next task" is simply the highest-priority, oldest task.

This means two tasks with the same priority are distinguished only by age. A "Medium" priority task due tomorrow will never surface above a "High" priority task due in 6 months. The app cannot express time-sensitivity at all.

For a tool whose entire purpose is "what should I do next?", ignoring temporal urgency is a significant limitation.

### Structured App — Priority * Urgency Ranking Algorithm

```csharp
// TaskRankingService.cs
public static TaskRank ComputeRank(TaskItem task, DateTimeOffset now)
{
    var urgency = ComputeUrgencyFactor(task.DueDate, now);
    return new TaskRank(task.Priority.Level * urgency);
}

public static double ComputeUrgencyFactor(DateTimeOffset? dueDate, DateTimeOffset now)
{
    if (dueDate is null) return 1.0;
    var remaining = dueDate.Value - now;
    if (remaining.TotalHours < 0)  return 2.0;  // overdue
    if (remaining.TotalHours <= 24) return 1.8;  // due within 24h
    if (remaining.TotalDays <= 3)   return 1.5;  // due within 3 days
    if (remaining.TotalDays <= 7)   return 1.2;  // due within 7 days
    return 1.0;                                   // far out or no due date
}
```

The structured app implements the exact ranking algorithm from the PRD:

```
rank = priority_level * urgency_factor
```

This means:
- A **Medium (3)** priority task that is **overdue** scores `3 * 2.0 = 6.0`
- A **High (4)** priority task with **no due date** scores `4 * 1.0 = 4.0`
- The overdue medium-priority task surfaces first

This is a much more useful "next task" determination. It captures the intuition that deadlines create urgency that can override base importance.

The ranking is also exposed in the list view — users can see the computed rank score next to each task, making the algorithm transparent.

### The PRD's Influence

The PRD specified the ranking algorithm in detail:
```
urgency_factor =
  if no due date -> 1.0
  if overdue -> 2.0
  if due within 24h -> 1.8
  ...
rank = priority_level * urgency_factor
```

The tasks.yml task 3 ("Domain layer - ranking service") had acceptance criteria:
- Computes urgency factor based on due date proximity
- Rank = priority level * urgency factor
- Handles null due dates
- Handles overdue tasks

And task 4 required tests for "all urgency tiers." The agent delivered all of this.

The raw agent, with no such specification, made the reasonable but inferior decision to sort only by priority weight. It did not even add a due date field.

**Verdict:** This is the dimension where the structured planning made the largest difference. The ranking algorithm is the core domain logic of the application, and the PRD specified it completely. The raw agent built a functional but shallow implementation. The structured agent built the exact algorithm the PRD described, with a domain service, value object, and full test coverage.

---

## Summary Scorecard

| Dimension | Raw | Structured | Delta |
|---|---|---|---|
| Clean Architecture | 5/10 | 9/10 | +4 |
| DDD Patterns | 6/10 | 8/10 | +2 |
| CLI UX | 6/10 | 9/10 | +3 |
| Code Quality | 7/10 | 8/10 | +1 |
| Testing | 0/10 | 8/10 | +8 |
| Persistence | 7/10 | 7/10 | 0 |
| Core Ranking Logic | 3/10 | 9/10 | +6 |
| **Total** | **34/70** | **58/70** | **+24** |

---

## Did the Planning Artifacts Actually Help?

**Yes, significantly.** The evidence is strongest in three areas:

### 1. The PRD prevented architectural mistakes

The PRD explicitly stated that `ITaskRepository` belongs in the Application layer. The raw agent put it in Domain — a common mistake. The PRD also specified the `Reconstitute` pattern (implicitly, via the data model), preventing the reflection-based hydration the raw agent used.

### 2. The tasks.yml enforced completeness

Task 4 ("Domain unit tests") and task 6 ("Application layer unit tests") with explicit acceptance criteria produced 21 test cases. The raw agent produced zero. The task dependency graph (tests depend on implementation, CLI depends on use cases + infrastructure + renderer) ensured nothing was skipped.

### 3. The PRD defined the core algorithm

The ranking algorithm — the single most important piece of domain logic — was specified in the PRD with exact urgency factor values. The raw agent had to invent its own approach and chose a simplistic priority-only sort without due dates.

### Where the raw agent did well despite no planning

- **Richer entity model.** The raw agent independently created `TaskStatus` as a value object and added a `Start()` state transition. The structured app's binary completed/not-completed model is simpler.
- **Extra behaviors.** `Reprioritize()` and `UpdateTitle()` methods show the raw agent thinking about the entity's full lifecycle.
- **Short ID resolution.** Both agents implemented this, but it was not in the PRD — the raw agent matched this feature without guidance.
- **Caching.** The raw agent added an in-memory cache for the repository, which the structured agent did not.

### The structured approach's one failure

The tasks.yml task 7 acceptance criteria specified "Handles concurrent access safely (file locking)" but the implementation has no file locking. This shows that planning artifacts do not guarantee every criterion is met — the agent can still skip requirements during execution.

---

## Qualitative Observations

### The raw app feels like a prototype

It works, it has personality (the ASCII art is clean, the priority indicators like `!!!` are charming), and it was probably faster to produce. But it lacks the core algorithmic sophistication that makes the app genuinely useful. Sorting by static priority alone makes it a basic to-do list, not a "what matters next" tool.

### The structured app feels like a v1.0

It has the architecture to evolve: the ranking algorithm can be tuned without touching other layers, the tests verify the algorithm works, the CLI uses a proper command framework that supports extensibility, and the `System.CommandLine` integration provides professional help output.

### The ASCII art tells a story

The raw app's ASCII art is modest — clean box-drawing with a small banner:
```
╔═══════════════════════════════════════════════╗
║   _  _         _  _____         _             ║
║  | \| |_____ _| ||_   _|_ _ ___| |__          ║
║  | .` / -_) \ /  _| | / _` (_-<| / /          ║
║  |_|\_\___/_\_\\__| |_\__,_/__/|_\_\          ║
╚═══════════════════════════════════════════════╝
```

The structured app uses large block-character ASCII art with ANSI color codes:
```
███╗   ██╗███████╗██╗  ██╗████████╗██╗   ██╗██████╗
████╗  ██║██╔════╝╚██╗██╔╝╚══██╔══╝██║   ██║██╔══██╗
```

It also has a creative "inbox zero" celebration with a checkmark/trophy shape, priority bars (`█████`, `████░`), and priority dots (`●●●●●`, `●●●●○`) in the list view. The visual polish is noticeably higher, likely because the PRD specified "box-drawn card showing task details with priority indicator" and "celebratory ASCII art when no tasks remain."

### The naming reveals intent

The raw app is called **NextTask** — generic. The structured app is called **NextUp** — branded, with a tagline ("focus on what matters next"). The PRD set this naming from the start, giving the structured app a cohesive identity.

---

## Conclusion

The structured approach (PRD then tasks.yml then execute then verify) produced a measurably better application across almost every dimension. The largest gaps were in **testing** (+8 delta), **core algorithm** (+6 delta), and **clean architecture** (+4 delta) — exactly the areas where explicit planning specifications provide the most value.

The raw approach produced working software faster and with some creative additions (TaskStatus value object, Start command, caching), suggesting that unstructured agents are better at "improvisation" while structured agents are better at "execution against requirements."

For production software, the structured approach wins decisively. For prototyping and exploration, the raw approach has merits.
