# Deep Code Investigation: CLI Mood Radio Variants

A senior-engineer-level source code review of the two CLI-mode builds (cli-opus and cli-sonnet), focusing on code quality patterns, idiomatic usage, and architectural decisions.

---

## 1. Per-Variant Deep Dives

### cli-opus (Claude Code with Opus)

**Backend:** Clean four-file separation: `models.rs` (190 lines), `routes.rs` (40 lines), `store.rs` (21 lines), `lib.rs` (24 lines). The `Mood` enum uses `#[serde(rename_all = "lowercase")]` and stores `mood: Mood` in the `Vibe` struct -- strong typing that carries the enum through to JSON serialization. `Mood::parse()` returns `Option<Mood>` which works but is not idiomatic -- `FromStr` would be the standard trait. The `Mood::info()` method is wasteful: it calls `Self::all()` to construct all 8 `MoodInfo` structs, then linear-searches by name with `into_iter().find(|m| m.name == name).unwrap()` -- this allocates 8 heap strings just to look up emoji and color for one mood. A direct match arm returning `(&str, &str)` would be zero-allocation. The `MoodInfo` struct uses owned `String` fields even though all values are static literals. Six messages per mood -- above the typical five.

The `lib.rs` exposes a clean `create_router(vibe_store: store::VibeStore) -> Router` factory. Routes are defined as `/api/moods`, `/api/vibe`, `/api/history` directly in the router (not nested under `/api` prefix). CORS uses manual three-line `allow_origin(Any).allow_methods(Any).allow_headers(Any)`. SPA fallback uses `ServeDir::new("web/dist").fallback(ServeFile::new("web/dist/index.html"))` -- correct pattern. The `main.rs` is minimal at 12 lines.

**Dependencies:** Uses `axum 0.8`, `rand 0.9`, `tower-http 0.6` -- the **newest versions** of all three. Uses `rand::seq::IndexedRandom` (the new `rand 0.9` API) via `messages.choose(&mut rng).unwrap()`. Tests use `reqwest` for real HTTP testing.

**Store:** Type alias `VibeStore = Arc<RwLock<Vec<Vibe>>>` with free functions `add_vibe()` and `get_history()`. The `add_vibe` does `insert(0, vibe)` then `truncate(MAX_HISTORY)` -- write-time truncation with newest-first storage. This means `get_history` can simply `clone()` the vec and it's already in the correct order. Clean separation with a `MAX_HISTORY` constant. Uses `.unwrap()` on the lock.

**Routes:** `post_vibe` returns `Result<Json<Vibe>, StatusCode>` -- the minimal error type. Uses `?` operator with `ok_or(StatusCode::BAD_REQUEST)`. The `messages.choose(&mut rng).unwrap()` is safe because messages is a hardcoded non-empty Vec, but the `unwrap()` is still a code smell -- `.expect("mood has messages")` would be more defensive.

**Tests:** Uses `reqwest` to make real HTTP requests against a spawned server. The `spawn_app()` helper binds to port 0, spawns the server in a background task, and returns the base URL. This is a well-known integration test pattern in the Rust ecosystem (popularized by "Zero to Production in Rust"). Five tests present:

1. `test_get_moods` -- verifies 8 moods with all fields present, checks all 8 names explicitly
2. `test_post_vibe_valid` -- posts "chill", verifies all fields and mood value
3. `test_post_vibe_invalid` -- posts "nonexistent", expects 400
4. `test_history_empty_then_populated` -- checks empty, posts 2, checks len 2
5. `test_history_ordering_and_cap` -- posts 55 vibes, verifies len 50, then **checks every consecutive pair has `a >= b` timestamps** -- the strongest ordering verification pattern

The ordering test is thorough -- it doesn't just check the first/last item but walks the entire list comparing adjacent timestamps. No assertion messages on most tests (just `assert!` and `assert_eq!` without custom messages). The `test_history_ordering_and_cap` does include `"History should be newest first"`.

**Frontend:** Uses `createSignal` for `currentVibe`, `history`, `loading`, and `activeMood`. Uses `createResource` for moods in `MoodPicker.tsx` only. The `handlePick` function fetches the vibe, then immediately refetches history from the server (`getHistory()`) -- a network round-trip that could be avoided with optimistic local update. No error handling beyond `finally { setLoading(false) }` -- if `submitVibe` throws, the error is silently swallowed (no `catch` block).

The `api.ts` has **no `res.ok` checking** -- all three functions just call `res.json()` without verifying the response status. If the server returns a 400 or 500, `res.json()` may throw or return unexpected data.

MoodPicker uses `<For>` correctly. Uses `classList` for conditional classes and inline `style` for dynamic color values -- clean pattern. The `isActive` and `isLoading` derived signals are good SolidJS practice. Responsive grid: `grid-cols-2 sm:grid-cols-4`.

VibeCard uses `<Show when={props.vibe}>` with the callback pattern `{(vibe) => (...)}` -- **correct SolidJS narrowing pattern** that avoids `!` non-null assertions. Multiple ambient glow divs with `blur-3xl` and `animate-pulse-soft`. The radio wave bars in the bottom accent are dynamically colored from `vibe().color`.

History uses `<For>` correctly. Has a `timeAgo()` utility function that handles seconds, minutes, hours, and days. Animation delay is staggered per item via `animation-delay: ${i() * 0.04}s`. Uses `.map()` for the radio wave bars inside `App.tsx` and `VibeCard.tsx` -- `.map()` on static arrays is fine since they never re-render, but `<For>` would be more idiomatic.

**CSS:** 94 lines. Tailwind v4 with `@theme` block defining a comprehensive design system: custom fonts (Space Grotesk display, Libre Baskerville serif), semantic color tokens (`--color-void`, `--color-surface`, `--color-surface-raised`, `--color-surface-glass`, three text tiers, two border tiers), per-mood color variables (8 total), and 6 animation definitions registered via `--animate-*` custom properties. Body background uses stacked radial gradients over the void color. Custom scrollbar styling. Uses `box-sizing: border-box` on `*`. No `@layer` directives -- everything is in the default layer.

The design language is dark, atmospheric, and refined -- serif italics for "editorial" feel, tiny tracking-widest uppercase labels, ambient glow effects. The radio metaphor is carried through the copy ("tune into your emotional frequency", "recent transmissions", "broadcasting on all frequencies").

---

### cli-sonnet (Claude Code with Sonnet)

**Backend:** Four-file separation with a very different weight distribution: `routes.rs` (179 lines), `models.rs` (53 lines), `lib.rs` (31 lines), `store.rs` (8 lines). The bulk of the logic has migrated into `routes.rs` -- mood metadata (`get_moods`), mood messages (`mood_messages`), and mood emoji/color lookups (`mood_meta`) are all defined as functions in the routes module rather than on the `Mood` enum. This is a deliberate architectural choice: the model is thin (just data structures + parse) while the routes module acts as a "service layer."

The `Mood` enum uses `#[serde(rename_all = "lowercase")]` and stores `mood: Mood` in `Vibe` -- same strong typing as cli-opus. `Mood::parse()` returns `Option<Mood>` -- same non-idiomatic pattern. But `MoodInfo` is only defined in `models.rs` without any mood data -- the data lives in `routes.rs`. This means `models.rs` is pure data structures (53 lines) with no business logic.

`mood_messages()` returns `&'static [&'static str]` -- a static slice reference, which is more efficient than cli-opus's `Vec<&'static str>`. The `mood_meta()` function returns a tuple `(&'static str, &'static str)` for (emoji, color) -- again, zero allocation vs cli-opus's `MoodInfo` struct with owned Strings. Functionally superior to cli-opus's `info()` method.

**Dependencies:** Uses `axum 0.7`, `rand 0.8`, `tower-http 0.5` -- **older major versions** of all three. Uses `rand::Rng::gen_range()` (rand 0.8 API) instead of `IndexedRandom::choose()`. Tests use `axum-test` instead of `reqwest`. Explicitly declares `[lib]` and `[[bin]]` sections in Cargo.toml -- slightly more verbose but more explicit.

**Store:** Minimal -- just a type alias `Store = Arc<RwLock<Vec<Vibe>>>` and `new_store()`. No store methods at all. All store manipulation is inline in routes:

```rust
// In post_vibe:
let mut store = store.write().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
store.insert(0, vibe.clone());
if store.len() > 50 { store.truncate(50); }

// In get_history:
let store = store.read().unwrap_or_else(|e| e.into_inner());
Json(store.clone())
```

**This is the most notable difference from any other variant reviewed so far**: the lock error handling is actually meaningful. `post_vibe` uses `.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?` to return a 500 if the write lock is poisoned, and `get_history` uses `.unwrap_or_else(|e| e.into_inner())` to **recover from a poisoned read lock** by extracting the inner data. This is the only variant across all 10 (including the 8 in the original review) that handles lock poisoning at all.

**Routes:** `get_moods` constructs `MoodInfo` structs inline (58 lines of literal data in the handler). This is the same anti-pattern seen in v0-sonnet-teams from the original review -- mood metadata in route handlers instead of on the model. However, the `mood_messages` and `mood_meta` are separate functions (not inlined in `post_vibe`), which is better encapsulation than the teams variants. The `post_vibe` returns `Result<Json<Vibe>, StatusCode>`.

**Tests:** Uses `axum_test::TestServer` -- the higher-level test framework. The `make_server()` helper is 3 lines. Five tests present:

1. `test_get_moods` -- verifies 8 moods, checks all names, checks each mood has emoji/color/label. **Includes descriptive assertion messages** like `"missing mood: {name}"`, `"missing emoji in {:?}"`.
2. `test_post_vibe_valid` -- posts "chill", checks all fields with assertion messages.
3. `test_post_vibe_invalid` -- posts "completely_fake_mood", asserts BAD_REQUEST.
4. `test_history_empty_then_populated` -- checks empty, posts happy, checks len 1 and mood value. Has assertion messages.
5. `test_history_ordering_and_cap` -- posts 51 "chill" vibes then 1 "happy", verifies cap at 50, newest (happy) is first, remaining 49 are all chill. Verifies the full content.

The ordering test strategy is different from cli-opus: instead of timestamp comparison across all pairs, it uses a semantic approach -- post distinguishable data and verify the exact ordering. This is actually a very smart test design: it catches ordering bugs and also verifies that truncation removes the oldest items (the initial chill vibes at the end). It would not catch a bug where items 2-50 were in wrong order relative to each other, but that scenario is essentially impossible with an `insert(0)` + `truncate` implementation.

Tests are 126 lines vs cli-opus's 160 -- 21% fewer lines for the same coverage. The `axum_test` framework eliminates all the `reqwest::Client` and `spawn_app()` boilerplate.

**Frontend:** Uses `createResource` for moods and `createSignal` for history -- hybrid approach. The `handleMoodSelect` function does an **optimistic local update**: `setHistory((prev) => [vibe, ...prev.slice(0, 49)])` -- it prepends the new vibe locally without refetching from the server. This is the smartest state update pattern, reducing network round-trips. Has `catch (err) { console.error(...) }` for error handling.

The `api.ts` checks `res.ok` on all three functions and throws descriptive errors (`"Failed to fetch moods"`, `"Failed to submit vibe"`, `"Failed to fetch history"`). Also uses `as Promise<T>` type assertions on `res.json()` -- explicit about the cast.

**The App.tsx uses almost entirely inline styles instead of Tailwind classes.** This is a stark architectural choice -- the component tree reads like a styled-components approach without the abstraction. The header has `style={{ "font-family": "var(--font-display)", "font-size": "clamp(2.8rem, 8vw, 4.5rem)", ... }}` with 6+ CSS properties per element. This is more verbose but gives very precise control. Uses CSS custom properties from the theme via `var(--color-*)`.

MoodPicker uses `<For>` correctly. Uses `.mood-btn` CSS class with `--mood-color` custom property per button -- the `color-mix()` CSS function is used in the stylesheet to derive border and background colors from the mood color. This is cutting-edge CSS (Level 5 Color). Clean component -- 46 lines.

VibeCard handles three states explicitly with three `<Show>` blocks: loading, empty, and populated. Uses the callback pattern `{(getVibe) => (...)}` for SolidJS type narrowing. The `.vibe-card` class uses a left border accent colored by `--vibe-color`. The `.vibe-tag` is styled like a badge. Loading state shows animated pulse bars with "TUNING IN" text. Empty state shows a faded satellite emoji with "PICK A MOOD TO TUNE IN".

History uses `<For>` correctly. Has a `relativeTime()` utility. Manually truncates messages: `entry.message.length > 58 ? entry.message.slice(0, 58) + "..." : entry.message` -- this is redundant since the CSS also has `text-overflow: ellipsis` on `.entry-message`. Shows "NO TRANSMISSIONS YET" as a fallback.

The `index.tsx` uses `const root = document.getElementById("app"); if (root) { render(...) }` with a null check -- slightly safer than cli-opus's `document.getElementById("root")!` with the non-null assertion.

**CSS:** 246 lines. Uses `@theme`, `@layer base`, and `@layer components` -- proper Tailwind v4 layer structure. This is the only CLI variant using `@layer` directives. Defines 3 custom fonts (Syne for display, Space Mono for monospace), 9 semantic color tokens (void, deep, panel, line, ghost, muted, text, bright, amber), and 4 animation keyframes.

The design language is brutalist/editorial: sharp edges (no border-radius), monospaced labels, amber accent color, section dividers with `border-bottom`. The `.mood-btn` uses `color-mix(in srgb, var(--mood-color) 22%, var(--color-line))` for borders -- cutting-edge CSS. The `.vibe-card` has a left-border accent (like a blockquote). History entries use a grid layout with left-border color accent. No glassmorphism, no blur effects, no ambient glows -- deliberately flat and typographic.

The `.section-label` class creates consistent section headers throughout the app. Custom scrollbar via `scrollbar-width: thin; scrollbar-color: var(--color-line) transparent` -- standards-based (Firefox) approach vs cli-opus's WebKit-specific `::-webkit-scrollbar`.

---

## 2. Comparison Tables

### 2.1 Backend Quality

| Dimension | cli-opus | cli-sonnet |
|-----------|----------|------------|
| Axum version | 0.8 (latest) | 0.7 (previous) |
| `FromStr` for Mood | No (custom `parse()`) | No (custom `parse()`) |
| `Vibe.mood` type | `Mood` enum | `Mood` enum |
| Error return type | `StatusCode` | `StatusCode` |
| Lock error handling | `.unwrap()` | `.map_err()` + `.unwrap_or_else()` |
| Store encapsulation | Free functions (`add_vibe`, `get_history`) | Inline in routes |
| Mood data location | `Mood::all()` + `Mood::info()` + `Mood::messages()` on enum | `get_moods()` literal + `mood_messages()` + `mood_meta()` in routes |
| Message allocation | `Vec<&'static str>` per call | `&'static [&'static str]` (zero-alloc) |
| Info allocation | `MoodInfo` struct with owned Strings | `(&'static str, &'static str)` tuple |
| CORS approach | Manual 3-line | Manual 3-line |
| SPA fallback | `fallback(ServeFile)` | `fallback(ServeFile)` |
| History impl | `insert(0)` + `truncate(50)`, clone on read | `insert(0)` + conditional `truncate(50)`, clone on read |
| Cargo.toml explicitness | Implicit lib/bin | Explicit `[lib]` and `[[bin]]` |
| Backend quality score | **7.5/10** | **7.5/10** |

### 2.2 Store Quality

| Dimension | cli-opus | cli-sonnet |
|-----------|----------|------------|
| Type | `Arc<RwLock<Vec<Vibe>>>` alias | `Arc<RwLock<Vec<Vibe>>>` alias |
| Encapsulation | Free functions with `MAX_HISTORY` const | No functions; inline in routes |
| Lock handling | `.unwrap()` everywhere | `.map_err()` on write, `.unwrap_or_else(into_inner)` on read |
| Write strategy | `insert(0)` + `truncate(MAX_HISTORY)` | `insert(0)` + `if len > 50 { truncate(50) }` |
| Read strategy | `clone()` (already newest-first) | `clone()` (already newest-first) |
| Store lines | 21 | 8 |
| Store quality score | **7/10** | **7/10** |

cli-opus's store has better encapsulation (the `MAX_HISTORY` const and dedicated functions), while cli-sonnet's store has better error handling (the only variant to handle poisoned locks). Both are correct. cli-sonnet's conditional `if store.len() > 50 { store.truncate(50) }` is marginally wasteful -- the check is unnecessary since `truncate` is a no-op if the vec is already at or below the target length.

### 2.3 Test Quality

| Dimension | cli-opus | cli-sonnet |
|-----------|----------|------------|
| All 5 tests? | Yes | Yes |
| Test framework | `reqwest` (real HTTP) | `axum_test::TestServer` |
| Fresh state per test? | Yes (via `spawn_app()`) | Yes (via `make_server()`) |
| Helper extraction | `spawn_app()` | `make_server()` |
| Ordering verification | Full pairwise timestamp comparison | Semantic: distinguishable data + position check |
| Assertion messages | One test only | All tests |
| Cap verification | Verifies len == 50 only | Verifies len == 50 AND oldest items dropped |
| DRY violations | Low | None |
| Test lines | 160 | 126 |
| Test quality score | **8/10** | **8.5/10** |

### 2.4 Frontend Quality

| Dimension | cli-opus | cli-sonnet |
|-----------|----------|------------|
| Data fetching (moods) | `createResource` | `createResource` |
| Data fetching (history) | `createSignal` + refetch from server | `createSignal` + optimistic local update |
| API error handling | None (`res.json()` without `res.ok` check) | Throws on `!res.ok` with descriptive messages |
| Loading state | Implicit (activeMood-based) | Explicit placeholder with "TUNING IN" animation |
| Empty state | Radio emoji + "Pick a mood to tune in..." | Satellite emoji + "PICK A MOOD TO TUNE IN" |
| `<For>` usage | Yes (MoodPicker, History) | Yes (MoodPicker, History) |
| `.map()` usage | Static arrays in App/VibeCard (acceptable) | Static array in VibeCard loading (acceptable) |
| Show callback narrowing | Yes (VibeCard) | Yes (VibeCard) |
| Styling approach | Tailwind utility classes | Inline styles + CSS classes (hybrid) |
| Type safety | Good | Good (explicit `as Promise<T>` casts) |
| `index.tsx` safety | `!` non-null assertion | `if (root)` null check |
| SolidJS anti-patterns | None | None |
| Frontend lines | 383 | 364 |
| Frontend quality score | **7.5/10** | **8/10** |

### 2.5 CSS/Design Quality

| Dimension | cli-opus | cli-sonnet |
|-----------|----------|------------|
| CSS approach | Tailwind utility classes + `@theme` | `@layer base` + `@layer components` + `@theme` |
| Tailwind v4 idiom | `@theme` with `--animate-*` properties | `@theme` + `@layer` (more correct) |
| Animation count | 6 (fade-in, slide-up, pulse-soft, radio-wave, float, shimmer) | 4 (wave-bar, fade-in, slide-up, pulse-bar) |
| Color system | 11 semantic tokens + 8 mood colors = 19 | 9 semantic tokens + per-component `--mood-color` / `--vibe-color` |
| Typography | Space Grotesk + Libre Baskerville | Syne + Space Mono |
| Design language | Dark atmospheric, serif italics, glassmorphism, ambient glows | Brutalist editorial, sharp edges, monospace labels, amber accent |
| Responsive design | `grid-cols-2 sm:grid-cols-4` | Hardcoded `repeat(4, 1fr)` |
| Special effects | Radial gradient backgrounds, blur effects, glow shadows | `color-mix()` Level 5 CSS, left-border accents |
| Custom scrollbar | WebKit-specific (`::-webkit-scrollbar`) | Standards-based (`scrollbar-width: thin`) |
| CSS lines | 94 | 246 |
| Aesthetic score | **8/10** | **8/10** |

### 2.6 Complexity & Size

| Metric | cli-opus | cli-sonnet |
|--------|----------|------------|
| Rust LOC (src/) | 287 | 282 |
| Frontend LOC | 383 | 364 |
| CSS LOC | 94 | 246 |
| Test LOC | 160 | 126 |
| Total LOC | 924 | 1,018 |

---

## 3. Best and Worst Patterns

### Best Patterns Found

**1. cli-sonnet's lock poisoning recovery (unique across all 10 variants)**
```rust
// cli-sonnet/app/src/routes.rs
let mut store = store.write().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
// ...
let store = store.read().unwrap_or_else(|e| e.into_inner());
```
This is the **only variant out of all 10 reviewed** (8 original + 2 CLI) that handles `RwLock` poisoning. The write path returns a 500 error. The read path recovers by extracting the inner data from the poisoned lock. While lock poisoning is rare in practice, this demonstrates production-level thinking about failure modes.

**2. cli-sonnet's static slice message return**
```rust
// cli-sonnet/app/src/routes.rs
fn mood_messages(mood: &Mood) -> &'static [&'static str] {
    match mood {
        Mood::Happy => &["...", "...", ...],
```
Returns a reference to a static slice -- zero heap allocation. cli-opus's `messages()` returns `Vec<&'static str>` which allocates a Vec on every call just to hold pointers to static data.

**3. cli-sonnet's optimistic history update**
```typescript
// cli-sonnet/app/web/src/App.tsx
const vibe = await submitVibe(mood);
setCurrentVibe(vibe);
setHistory((prev) => [vibe, ...prev.slice(0, 49)]);
```
Prepends the new vibe locally instead of refetching from the server. Reduces latency and eliminates a network round-trip.

**4. cli-opus's full pairwise ordering test**
```rust
// cli-opus/app/tests/api_tests.rs
for i in 0..history.len() - 1 {
    let a = history[i]["created_at"].as_str().unwrap();
    let b = history[i + 1]["created_at"].as_str().unwrap();
    assert!(a >= b, "History should be newest first");
}
```
Walks every adjacent pair in the history, verifying global descending order. This catches any ordering bug, not just head/tail issues.

**5. cli-opus's VibeCard Show callback narrowing**
```tsx
// cli-opus/app/web/src/components/VibeCard.tsx
<Show when={props.vibe}>
  {(vibe) => (
    <div style={{ "border-color": `${vibe().color}25` }}>
```
Uses SolidJS's `<Show>` callback to get a narrowed, non-null accessor. No `!` assertions needed. cli-sonnet also does this correctly.

**6. cli-sonnet's `@layer` CSS structure**
```css
// cli-sonnet/app/web/src/index.css
@layer base { ... }
@layer components { ... }
```
Using `@layer` with Tailwind v4 is the correct way to manage specificity. cli-opus omits layers entirely, relying on Tailwind's default ordering which works but is less explicit.

**7. cli-sonnet's `color-mix()` for dynamic theming**
```css
// cli-sonnet/app/web/src/index.css
.mood-btn {
  border: 1px solid color-mix(in srgb, var(--mood-color, #888) 22%, var(--color-line));
  background: color-mix(in srgb, var(--mood-color, #888) 6%, transparent);
}
```
Uses CSS Level 5 `color-mix()` to derive border and background colors from a per-button custom property. This is the most modern CSS technique in either variant. The fallback `#888` is also a nice defensive detail.

### Worst Patterns Found

**1. cli-opus's wasteful `Mood::info()` method**
```rust
// cli-opus/app/src/models.rs
pub fn info(&self) -> MoodInfo {
    let all = Self::all();  // Allocates 8 MoodInfo structs with owned Strings
    let name = match self { Mood::Happy => "happy", ... };
    all.into_iter().find(|m| m.name == name).unwrap()  // Linear search
}
```
Constructs all 8 `MoodInfo` structs (each with 4 `String` heap allocations = 32 allocations), then linear-searches for one. This runs on every `post_vibe` request. A direct `match` returning `(&str, &str, &str)` would be zero-allocation. cli-sonnet's `mood_meta()` function solves this correctly.

**2. cli-opus's missing API error handling**
```typescript
// cli-opus/app/web/src/api.ts
export async function submitVibe(mood: string): Promise<Vibe> {
  const res = await fetch(`${BASE}/vibe`, { ... });
  return res.json();  // No res.ok check!
}
```
All three API functions in cli-opus skip `res.ok` checking. A 400 response (e.g., invalid mood) would attempt to parse the error body as a `Vibe`, producing undefined behavior in the UI. cli-sonnet correctly checks `res.ok` on all three.

**3. cli-opus's missing catch block**
```typescript
// cli-opus/app/web/src/App.tsx
async function handlePick(mood: string) {
  setLoading(true);
  try {
    const vibe = await submitVibe(mood);
    setCurrentVibe(vibe);
    const h = await getHistory();
    setHistory(h);
  } finally {
    setLoading(false);
  }
  // No catch -- errors silently disappear
}
```
The `try/finally` without `catch` means any error is swallowed. Combined with the missing `res.ok` check in the API layer, network errors produce no user feedback at all.

**4. cli-sonnet's mood data in routes instead of model**
```rust
// cli-sonnet/app/src/routes.rs
pub async fn get_moods() -> Json<Vec<MoodInfo>> {
    Json(vec![
        MoodInfo { name: "happy".into(), emoji: "...".into(), color: "#FFD700".into(), label: "Happy".into() },
        // ... 58 lines of literal data in a route handler
    ])
}
```
The mood metadata, messages, and emoji/color lookups are all in `routes.rs`. This means `models.rs` is anemic -- it defines `MoodInfo` but has no idea what moods exist or what their properties are. If a new route needed mood data, it would have to import from `routes` or duplicate it.

**5. cli-sonnet's hardcoded grid (no responsive breakpoint)**
```tsx
// cli-sonnet/app/web/src/components/MoodPicker.tsx
<div style={{ display: "grid", "grid-template-columns": "repeat(4, 1fr)", gap: "0.5rem" }}>
```
Always renders 4 columns, even on narrow mobile screens where buttons would be tiny. cli-opus uses `grid-cols-2 sm:grid-cols-4` for responsive behavior. This is a real UX issue on small screens.

**6. cli-sonnet's redundant message truncation**
```tsx
// cli-sonnet/app/web/src/components/History.tsx
<span class="entry-message">
  {entry.message.length > 58 ? entry.message.slice(0, 58) + "..." : entry.message}
</span>
```
And in CSS:
```css
.entry-message {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```
JS truncation at 58 characters AND CSS `text-overflow: ellipsis` -- double truncation. The CSS approach is better because it adapts to container width. The JS truncation should be removed.

**7. cli-sonnet's excessive inline styles**
```tsx
// cli-sonnet/app/web/src/App.tsx
<h1 style={{
  "font-family": "var(--font-display)",
  "font-size": "clamp(2.8rem, 8vw, 4.5rem)",
  "font-weight": "800",
  color: "var(--color-bright)",
  "letter-spacing": "-0.03em",
  "line-height": "0.92",
  margin: "0 0 0.75rem 0",
}}>
```
Inline styles throughout `App.tsx` mix presentation into the component tree. This makes it hard to adjust the design without touching component code. The CSS already defines `.section-label`, `.vibe-card`, etc. in `@layer components`, so the infrastructure for class-based styling exists but isn't consistently used.

---

## 4. Bugs and Issues

### cli-opus

| Severity | Issue | Location |
|----------|-------|----------|
| Medium | No API error handling (`res.ok` not checked) | `web/src/api.ts` |
| Medium | Silent error swallowing (try/finally without catch) | `web/src/App.tsx:14-25` |
| Low | `Mood::info()` allocates 32 strings + linear search per call | `src/models.rs:107-119` |
| Low | `messages.choose().unwrap()` on non-empty vec (correct but undocumented assumption) | `src/routes.rs:23` |
| Cosmetic | `Mood::parse()` instead of `FromStr` trait | `src/models.rs:93` |
| Cosmetic | Owned `String` fields in `MoodInfo` for static data | `src/models.rs:17-22` |

### cli-sonnet

| Severity | Issue | Location |
|----------|-------|----------|
| Medium | No responsive breakpoint on mood grid (hardcoded 4 columns) | `web/src/components/MoodPicker.tsx:13` |
| Medium | Mood domain data (metadata, messages, emoji/color) in routes instead of model | `src/routes.rs:9-142` |
| Low | Redundant JS message truncation when CSS already handles it | `web/src/components/History.tsx:50-52` |
| Low | Excessive inline styles in App.tsx (inconsistent with CSS-class approach elsewhere) | `web/src/App.tsx` |
| Low | Conditional `if store.len() > 50 { truncate(50) }` is unnecessary | `src/routes.rs:169-171` |
| Cosmetic | `Mood::parse()` instead of `FromStr` trait | `src/models.rs:17` |
| Cosmetic | Uses older dependency versions (axum 0.7, rand 0.8) | `Cargo.toml` |

No **correctness bugs** in either variant. Both produce correct history ordering, correct cap at 50, and correct mood validation. This is notable -- the original review found correctness bugs in 3 of the 8 variants (v0-sonnet's redundant sort, v0-sonnet-teams' wrong ordering, v0-haiku's broken SPA fallback). Both CLI variants are bug-free.

---

## 5. Overall Scores

### cli-opus

| Category | Score | Notes |
|----------|-------|-------|
| Backend architecture | 7.5/10 | Good separation but wasteful `info()` method |
| Store implementation | 7/10 | Clean encapsulation, unwrap on locks |
| Test quality | 8/10 | Strong ordering test, real HTTP, missing assertion messages |
| Frontend quality | 7.5/10 | Correct SolidJS patterns, missing error handling |
| CSS/Design quality | 8/10 | Comprehensive design system, atmospheric aesthetic |
| Maintainability | 8/10 | Clean module boundaries, good naming |
| **Overall** | **7.7/10** | |

### cli-sonnet

| Category | Score | Notes |
|----------|-------|-------|
| Backend architecture | 7.5/10 | Best lock handling ever, but data/logic in wrong module |
| Store implementation | 7/10 | Minimal but correct, unique poisoning recovery |
| Test quality | 8.5/10 | Concise, smart semantic assertions, descriptive messages |
| Frontend quality | 8/10 | Optimistic updates, error handling, safe index.tsx |
| CSS/Design quality | 8/10 | Distinctive brutalist design, cutting-edge CSS |
| Maintainability | 7/10 | Inline styles hurt, data in routes hurts |
| **Overall** | **7.7/10** | |

---

## 6. Comparative Summary

These two variants are remarkably close in overall quality -- both score 7.7/10 -- but they achieve it through **complementary strengths and weaknesses**.

### Where cli-opus is stronger:
- **Module boundaries**: Mood data lives on the `Mood` enum where it belongs
- **Responsive design**: `grid-cols-2 sm:grid-cols-4` handles mobile screens
- **Dependency freshness**: Latest versions of axum (0.8), rand (0.9), tower-http (0.6)
- **CSS consistency**: All styling through Tailwind utility classes -- no inline style soup
- **Store encapsulation**: Dedicated functions with `MAX_HISTORY` constant

### Where cli-sonnet is stronger:
- **Error handling**: Lock poisoning recovery, API `res.ok` checks, catch block, safe `index.tsx`
- **Test quality**: Descriptive assertion messages, `axum_test` conciseness, smart semantic ordering test
- **Allocation efficiency**: `&'static [&'static str]` messages, `(&str, &str)` tuples instead of owned structs
- **State management**: Optimistic local history update avoids network round-trip
- **CSS technique**: `color-mix()`, `@layer`, `scrollbar-width` (standards-based)
- **Design distinctiveness**: Brutalist editorial aesthetic is a genuine aesthetic choice, not a default

### Shared weaknesses:
- Both use `Mood::parse()` instead of implementing `FromStr`
- Neither handles CORS restrictively (both use `allow_origin(Any)`)
- Both use `String` timestamps instead of `DateTime<Utc>` in the `Vibe` struct
- Both rely on string comparison for timestamp ordering (works with RFC 3339 but is semantically fragile)

---

## 7. What Makes Each Distinctive

### cli-opus's identity
cli-opus feels like **an experienced Rust developer's first pass** -- clean module structure, correct patterns, comprehensive frontend with ambient effects. It's the variant that a senior developer would write when they want something that "just works" and looks polished. The atmospheric dark aesthetic with serif italics, ambient glows, and radio metaphor copy ("recent transmissions", "broadcasting on all frequencies") creates a cohesive product feeling. Its weakness is that it doesn't think about failure modes -- no error handling in the API layer, no catch blocks, no lock poisoning handling.

### cli-sonnet's identity
cli-sonnet feels like **a more cautious, production-minded developer who happens to have strong design opinions**. The lock poisoning recovery, `res.ok` checks, null-safe `index.tsx`, and optimistic updates show someone thinking about what happens when things go wrong. The brutalist editorial CSS -- sharp edges, monospace labels, amber accent, `color-mix()` -- is a deliberate departure from the glassmorphism that every other variant defaults to. Its weakness is organizational: mood data scattered across routes, inline styles mixed with CSS classes, and older dependency versions.

### Head-to-head verdict
If forced to choose one for production use, **cli-sonnet's error handling and efficiency patterns** edge it slightly ahead for backend robustness, while **cli-opus's module organization and responsive design** make it more maintainable long-term. They represent two valid philosophies: cli-opus prioritizes structure and aesthetics, cli-sonnet prioritizes resilience and efficiency. Both are in the top tier of all 10 variants reviewed.

---

## 8. Placement in the Full Ranking

Incorporating these two CLI variants into the original ranking from `09-deep-code-investigation.md`:

| Rank | Variant | Score | Change |
|------|---------|-------|--------|
| 1 | v1 (Opus pipeline) | 9.0 | -- |
| 2 | v2 (Opus optimized) | 8.5 | -- |
| 3 | **cli-opus** | **7.7** | New |
| 4 | **cli-sonnet** | **7.7** | New |
| 5 | v0 (Opus bare) | 7.5 | was #3 |
| 6 | v0-sonnet | 7.0 | was #4 |
| 7 | v0-sonnet-skill | 7.0 | was #5 |
| 8 | v0-sonnet-skill-teams | 6.0 | was #6 |
| 9 | v0-sonnet-teams | 5.0 | was #7 |
| 10 | v0-haiku | 4.0 | was #8 |

Both CLI variants slot in between the pipeline/optimized Opus builds and the bare prompt builds. They outperform the original v0 (bare Opus) primarily through better test strategies (cli-sonnet's `axum_test` usage, cli-opus's pairwise ordering check) and more polished frontend implementations. Neither reaches v1 or v2 territory -- v1's typed fetch wrapper, `createResource` everywhere, and SVG radio wave animation set a higher bar; v2's `FromStr`/`Display`/`const` array and loading skeletons demonstrate deeper Rust and SolidJS idiom mastery.

The most striking finding: Claude Code (the CLI agent) produces consistently bug-free code regardless of model. Both cli-opus and cli-sonnet have zero correctness bugs, matching only v0, v1, and v2 from the original review. The API-based Sonnet variants (v0-sonnet, v0-sonnet-teams) each had bugs. This suggests that the Claude Code agent's iterative development loop -- where it can run the code, see errors, and fix them -- catches the kinds of issues that a single-shot API call misses.
