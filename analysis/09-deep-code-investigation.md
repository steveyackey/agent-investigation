# Deep Code Investigation: 8 Mood Radio Variants

A senior-engineer-level source code review across all 8 builds, focusing on code quality patterns rather than feature completeness.

---

## 1. Per-Variant Deep Dives

### v0 (Opus bare prompt) -- $1.62, 6m27s

**Backend:** Clean, well-structured separation. `lib.rs` owns the `create_app()` factory with CORS, API routes nested under `/api`, and `ServeDir` fallback for SPA. The `Mood` enum has dedicated methods (`name()`, `emoji()`, `color()`, `label()`, `messages()`) -- five match arms per method is verbose but readable. The `Mood::parse()` method returns `Option<Mood>` which is fine but not idiomatic Rust -- `FromStr` would be the standard trait. The `Vibe.mood` field is `String`, not `Mood` enum, which loses type safety after construction.

**Store:** Simple `Arc<RwLock<Vec<Vibe>>>` type alias. Free functions `add_vibe()` and `get_history()` -- functional style, not OOP. `add_vibe` does `insert(0, vibe)` to prepend (newest first in storage), so `get_history` just takes the first 50. This is correct but O(n) on every insert.

**Routes:** `post_vibe` returns `Result<Json<Vibe>, StatusCode>` -- good, uses `?` operator with `ok_or`. Uses `rand::thread_rng()` which is deprecated in newer `rand` versions.

**Tests:** All 5 required tests present. The `test_history_newest_first_and_cap_at_50` test posts 55 vibes alternating happy/sad and asserts the first result is "happy" (index 54, even). Clever verification of ordering. Tests use shared state via `store.clone()` where needed. The `body_json` extraction is inlined (repeated pattern).

**Frontend:** Uses `createSignal` + `onMount` for data fetching instead of `createResource` -- works but misses SolidJS's built-in loading/error states. No `res.ok` checking in API calls -- silently returns undefined on error. `hexToRgb` utility is duplicated between `MoodPicker.tsx` and `VibeCard.tsx`. CSS uses `@theme` correctly for Tailwind v4. The `.glass` utility class is well-defined.

**CSS:** Proper Tailwind v4 with `@theme` block. Three custom animations (`fade-in`, `slide-in`, `pulse-wave`). CSS variables for colors. Clean glassmorphism implementation. 57 lines total -- minimal and effective.

---

### v1 (Opus pipeline) -- $12.77, 42m36s

**Backend:** Different architecture -- `lib.rs` just re-exports (`pub use routes::api_router; pub use store::AppState;`). The `AppState` struct wraps the store (vs v0's type alias). Routes are not nested under `/api` in the router module -- the `/api` prefix is applied in `main.rs`. The `Mood` enum stores the mood directly in `Vibe.mood: Mood` (not String) -- stronger typing. Uses `serde_json::to_value(m).unwrap()` to get the lowercase name from the enum, which is clever but fragile -- ties name generation to serde serialization. Uses `rand::seq::IndexedRandom` (newer rand API) vs v0's `SliceRandom`.

**Store:** `AppState` struct with `#[derive(Clone)]` -- cleaner than a bare type alias. But the store logic is inline in routes (`state.store.write().unwrap().push(vibe.clone())`) rather than encapsulated in store methods. History uses `store.iter().rev().take(50)` -- items stored in insertion order, reversed at read time.

**Routes:** Returns `Result<Json<Vibe>, (StatusCode, String)>` with error message -- better error responses than bare `StatusCode`. The `get_moods` handler is a one-liner delegating to `Mood::all()`.

**Tests:** Clean `fresh_app()` helper and reusable `body_json()` extractor. Tests include descriptive assertion messages (`"missing 'name' field"`). The `test_history_ordering_and_cap` posts 51 vibes and verifies timestamps are descending -- the strongest ordering test across all variants.

**Frontend:** Uses `createResource` for both moods and history -- idiomatic SolidJS. SVG radio wave animation in the header is hand-crafted with staggered `<animate>` elements -- the most sophisticated header animation across all variants. The `api.ts` module uses a `fetchJSON<T>()` generic wrapper that checks `res.ok` and throws on error -- the only variant with a proper typed fetch abstraction. The `Mood` type union (`"happy" | "sad" | ...`) adds compile-time safety. `relativeTime()` uses `Intl.RelativeTimeFormat` -- proper i18n-ready implementation vs hand-rolled strings in other variants.

**CSS:** Tailwind v4 with animations registered inside `@theme` block using `--animate-*` custom properties -- the correct Tailwind v4 way. Four distinct animations. Custom dark variant declaration. Body styles include font-smoothing. 67 lines.

---

### v2 (Opus optimized pipeline) -- $5.24, ~25m

**Backend:** Cleanest `lib.rs` -- `create_app()` takes no arguments, creates store internally. Uses `CorsLayer::permissive()` -- one-liner vs manual `.allow_origin(Any).allow_methods(Any).allow_headers(Any)`. Uses `not_found_service` for SPA fallback (same as `fallback` but semantically clearer). The `Mood` enum implements `FromStr` and `Display` -- the most idiomatic Rust approach, using standard library traits. Also has standalone `get_mood_info()` and `get_mood_messages()` functions plus a `const ALL_MOODS: [Mood; 8]` array -- the only variant using a const array instead of constructing a Vec each call.

**Store:** Minimal -- 9 lines, just the type alias and constructor. No store methods; route handlers do `store.write().unwrap().push()` and `store.read().unwrap().clone()` directly.

**Routes:** The `get_history` implementation clones the entire Vec, reverses it, then truncates -- allocates twice (clone + reverse). Uses `rand::RngExt` and `random_range()` instead of `SliceRandom::choose()` -- unusual choice, more manual.

**Tests:** `body_json()` helper returns `Value` cleanly. `create_app()` creates fresh internal state each call -- tests are naturally isolated without needing to pass shared state. The ordering test verifies `first_ts >= last_ts` which is the minimum viable ordering check. 189 lines.

**Frontend:** Uses `createResource` for both moods and history. The MoodPicker has a loading skeleton placeholder (`Array.from({ length: 8 })` shimmer cards) -- the only variant with a loading skeleton. Semantic color system in CSS: `--color-surface`, `--color-surface-hover`, `--color-text`, `--color-text-muted`, `--color-border` -- a proper design system. Also defines per-mood color variables (`--color-mood-happy`, etc.) though these aren't used in components. Radio wave animation using CSS `scale()` transform on concentric circles -- creative.

**CSS:** The most complete design system. Font declaration, 4 animations inside `@keyframes`, semantic color tokens, dedicated `font-sans` variable. 77 lines. Body styles properly applied.

---

### v0-sonnet (Sonnet bare prompt) -- $1.36, 6m41s

**Backend:** Nearly identical structure to v0. `build_app()` takes a `VibeStore` parameter. The `VibeStore` is a struct with methods (`new()`, `add()`, `history()`) -- proper encapsulation. **BUG:** The `history()` method does `vibes.iter().rev().take(50).cloned().collect()` then `result.sort_by(|a, b| b.created_at.cmp(&a.created_at))` -- this double-sorts: first reverses insertion order, then sorts by timestamp string comparison. This is redundant (insertion order IS timestamp order) and the string comparison could fail with different timestamp formats. Also implements `FromStr` for `Mood` -- idiomatic.

**Store:** Struct-based store with encapsulated methods. Items appended (`push`), reversed on read. The redundant sort is the main issue.

**Routes:** `post_vibe` returns `impl IntoResponse` and manually constructs `(StatusCode::BAD_REQUEST, Json(None::<Vibe>))` -- returns a null body on error, which is unusual. Clients must handle `null` JSON responses.

**Tests:** The `test_history_ordering_and_cap` test directly adds 55 vibes to the store (bypassing HTTP) with synthetic timestamps like `"2026-02-23T10:{i%60}:00Z"` -- this tests the store layer directly. It then verifies every consecutive pair is ordered. This is actually a clever test because it catches the store's sort behavior. **However**, because minutes are formatted with `i % 60`, after 60 vibes the timestamps wrap. With 55 vibes this works fine, but it's a subtle fragility.

**Frontend:** Uses `createResource` + `refetchHistory()`. Error handling has `catch (e) { console.error(e) }`. Uses inline `onMouseEnter`/`onMouseLeave` for hover effects instead of CSS `:hover` -- anti-pattern for maintainability and performance. The `glass` class and `history-fade` mask are defined in CSS. Radio wave uses `scaleY` transform bars.

**CSS:** Clean Tailwind v4 setup with `@theme`. Defines `.glass` and `.history-fade` utility classes. Radio bar animation with staggered delays. 71 lines.

---

### v0-sonnet-skill (Sonnet + frontend-design skill) -- $1.57, 7m3s

**Backend:** `lib.rs` exposes `create_app()` and a convenience `create_app_with_store()` that returns both the app and store -- used by tests. Static file serving is NOT in `lib.rs` but in `main.rs` -- the only variant that splits SPA serving from the API router factory. The model has 6 messages per mood (vs 5 in most others).

**Store:** Function-based store with `add_vibe` doing `insert(0, vibe)` then `truncate(50)` -- truncation at write time, not read time. This means old vibes are actually discarded, which is more memory-efficient for long-running instances.

**Routes:** Standard `Result<Json<Vibe>, StatusCode>` return. Uses `SliceRandom::choose()` with a `.copied().unwrap_or("The universe has a message for you.")` fallback -- defensive programming against empty message slices.

**Tests:** Uses `axum_test::TestServer` -- the only variant using this higher-level test framework. Tests are significantly more concise (114 lines vs 175-195 elsewhere). The API is cleaner: `server.post("/api/vibe").json(&json!({...})).await` vs manual Request building. **BUT** the `test_history_ordering_and_cap` test posts 55 "chaotic" vibes then 1 "chill" vibe and asserts `history[0]["mood"] == "chill"` -- this only verifies the most recent item is first, not the full ordering.

**Frontend:** **By far the most visually distinctive.** Uses CSS custom properties extensively with custom fonts (Libre Baskerville for display, Space Mono for monospace). Features a "Live" broadcast badge, film grain SVG overlay, scanline effect, section labels styled as code comments (`// tune your frequency`). The VibeCard has a `color-mix()` CSS function for dynamic color mixing. `relativeTime()` is exported from `api.ts` (shared between components). The `vibe-card-glow` and `vibe-card-border` are separate overlay divs. Shows vibe ID hash (`vibe().id.slice(0, 8)`) -- a unique detail.

**CSS:** 331 lines -- more than 4x any other variant. Film grain via inline SVG data URL. Scanline overlay via repeating-linear-gradient. Custom scrollbar styling. `color-mix()` usage (cutting-edge CSS). Seven distinct animation keyframes. This is the most opinionated and designed CSS across all variants.

---

### v0-sonnet-teams (Sonnet + subagents) -- $2.18, 8m18s

**Backend:** **Unusual architecture.** `lib.rs` is just 3 lines (`pub mod` declarations). Everything is wired in `main.rs`, including CORS. The `models.rs` is minimal (37 lines) -- just struct definitions, no `Mood` enum methods. All mood data (emojis, colors, messages) is inlined in `routes.rs` as a massive `mood_data()` function returning `Option<(&str, &str, Vec<&str>)>`. This is the worst separation of concerns across all variants -- route handlers contain domain data. The CORS config only allows `CONTENT_TYPE` header instead of `Any` -- more restrictive but potentially breaking for some clients.

**Store:** Struct-based with private field. `history()` returns `vibes[start..].to_vec()` using `saturating_sub(50)` -- **BUG: returns items in insertion order (oldest first), not newest first.** The last 50 items are the 50 most recent, but they're returned in chronological order, not reverse-chronological. The test has a wrong assertion (`assert_eq!(history[0]["mood"]...unwrap(), "sad")` with the comment "index 54 is odd") when index 54 is actually even -- the test would fail or the comment is wrong, depending on the actual behavior.

**Tests:** Rebuilds the full router in each test function rather than using a shared factory -- massive code duplication. Each test creates `VibeStore::new()`, builds `Router::new()`, adds routes, layers, and state. The `make_app()` function exists but recreates the router inline. Uses `axum::body::to_bytes` instead of `http_body_util::BodyExt` -- different approach.

**Frontend:** Uses `createResource` for moods but `createSignal` + `onMount` for history. The `handleMoodSelect` optimistically updates history locally: `setHistory((prev) => [vibe, ...prev.slice(0, 49)])` -- avoids a refetch round-trip. This is the smartest state update pattern across all variants. Uses inline `onMouseEnter`/`onMouseLeave` for hover effects. Radio wave animation uses Tailwind classes.

**CSS:** 52 lines -- the most minimal CSS. Just `@theme` variables, 4 keyframe animations, and utility classes. No `.glass` class or special effects. Body background hardcoded.

---

### v0-sonnet-skill-teams (Sonnet + skill + subagents) -- $2.06, 5m57s

**Backend:** Well-structured `lib.rs` with `create_app()` taking a `VibeStore`. Uses `not_found_service` for SPA fallback. Like v0-sonnet-teams, all mood data is inlined in `routes.rs` via a match expression inside `post_vibe` -- but this version has it directly in the handler, not in a separate function. The `get_moods` handler constructs `MoodInfo` structs literally -- 58 lines of hardcoded data in the handler. `Mood` enum has `Display` impl but no `FromStr`.

**Store:** Struct-based store with `add_vibe()` using `push()` then `get_history()` doing `clone() + reverse() + truncate(50)` -- correct but allocates the full Vec each time.

**Tests:** Creates fresh app per test via `make_app()` but also shares store via `VibeStore::new()` + `create_app(store.clone())` in stateful tests. The `test_history_ordering_and_cap` verifies every consecutive pair has `t1 >= t2` -- thorough ordering check. Tests create new app instances per request in the ordering test loop (55 iterations of `create_app(store.clone())`) -- wasteful but functionally correct.

**Frontend:** Very similar to v0-sonnet-skill's design language. Uses `RadioWave` component extracted in `App.tsx`. `props.vibe!` non-null assertions in VibeCard -- TypeScript knows it's inside a `Show when={!props.loading && props.vibe}` but using `!` is still a code smell. Uses `.map()` in JSX (anti-pattern in SolidJS -- breaks reactivity). History items use `onMouseEnter`/`onMouseLeave` for hover. Shows mood label and relative time in a stacked layout per history item.

**CSS:** 158 lines. Shares the same design DNA as v0-sonnet-skill: scanline overlay, noise texture, glass card class, wave-bar animations. But slightly less polished (no `color-mix()`, no custom scrollbar, no broadcast badge).

---

### v0-haiku (Haiku bare prompt) -- $0.97, 8m23s

**Backend:** **Major structural issue.** `main.rs` uses `mod models; mod routes; mod store;` (private modules) while `lib.rs` uses `pub mod models; pub mod routes; pub mod store;`. This means both `main.rs` and `lib.rs` declare the same modules -- `main.rs` has its own private copies while tests import from `lib.rs`. There is no `create_app()` function in `lib.rs`. The SPA fallback is broken: `ServeDir::new(&dist_dir).fallback(ServeDir::new(&dist_dir).not_found_service(ServeDir::new(dist_dir.join("index.html"))))` -- nests three ServeDir instances incorrectly instead of using `ServeFile`. Includes `DefaultBodyLimit::max(1024)` -- a body size limit that exists in no other variant. The `Mood` enum derives `Copy` -- the only variant to do so (correct since it's a fieldless enum). Has a proper `MoodParseError` struct for `FromStr`. Uses `chrono::SecondsFormat::Secs` in `to_rfc3339_opts` -- produces cleaner timestamps.

**Store:** Struct with `insert(0, vibe)` + `truncate(50)` -- same write-time truncation as v0-sonnet-skill. Also implements `Default` manually (though `#[derive(Default)]` would suffice).

**Routes:** `get_moods` uses `format!("{:?}", mood).to_lowercase()` to derive name from Debug representation -- **fragile**: if `#[derive(Debug)]` output changes, names break. Returns `Result<Json<Vibe>, (StatusCode, String)>` with error messages.

**Tests:** **Does not use the lib crate's `create_app`.** Each test builds the router from scratch, duplicating CORS, DefaultBodyLimit, routing, and state setup. This is the worst test DRY violation across all variants. The `test_history_empty` and `test_history_ordering_and_cap` are split into separate tests (not combined as in other variants). The ordering test adds vibes directly to the store and checks `history[0].id == "vibe-59"` -- the most precise ordering assertion.

**Frontend:** Uses `.map()` in MoodPicker instead of `<For>` -- breaks SolidJS reactivity (entire list re-renders on any change). Has a `createEffect(() => { refetchHistory(); })` that runs on every render -- this would cause an infinite loop or at minimum unnecessary refetches. Uses `Component` type annotation pattern (`const App: Component = () => {...}`). Animated background blobs (purple/blue) with `mix-blend-screen` and `blur-3xl`. Uses gray-scale Tailwind colors throughout (no custom design system).

**CSS:** 72 lines. Uses `@layer base` and `@layer utilities` -- proper Tailwind v4 layer usage. Custom selection color. Scrollbar utility classes. Simple animations (fadeIn, slideIn, pulseSoft). No glassmorphism or special effects.

---

## 2. Cross-Variant Comparison Tables

### 2.1 Rust Backend Quality

| Dimension | v0 | v1 | v2 | v0-sonnet | v0-sonnet-skill | v0-sonnet-teams | v0-sonnet-skill-teams | v0-haiku |
|-----------|----|----|----|-----------|-----------------|-----------------|-----------------------|----------|
| `FromStr` for Mood | No (custom `parse()`) | No (custom `from_name()`) | Yes | Yes | No (custom `parse()`) | N/A (no enum methods) | No (match in handler) | Yes |
| `Vibe.mood` type | `String` | `Mood` enum | `Mood` enum | `String` | `String` | `String` | `String` | `Mood` enum |
| Error return type | `StatusCode` | `(StatusCode, String)` | `StatusCode` | `impl IntoResponse` | `StatusCode` | `StatusCode` | `StatusCode` | `(StatusCode, String)` |
| Store encapsulation | Free functions | Inline in routes | Inline in routes | Struct methods | Free functions | Struct methods | Struct methods | Struct methods |
| CORS approach | Manual 3-line | Manual 3-line | `permissive()` | Manual 3-line | Manual 3-line | `allow_headers([CONTENT_TYPE])` | Manual 3-line | `permissive()` |
| SPA fallback | `fallback(ServeFile)` | `fallback(ServeFile)` | `not_found_service(ServeFile)` | `fallback(ServeFile)` | `not_found_service(ServeFile)` | `fallback(ServeFile)` | `not_found_service(ServeFile)` | Broken (nested ServeDir) |
| History impl | insert(0) + take(50) | push + rev().take(50) | push + clone/rev/truncate | push + rev/take + sort | insert(0) + truncate(50) | push + slice[-50:] (wrong order) | push + clone/rev/truncate | insert(0) + truncate(50) |
| Data/logic separation | Enum methods | Enum methods | Standalone functions | Struct methods (mixed) | Enum methods | All in routes.rs | All in routes.rs | Enum methods |
| Backend quality score | 8/10 | 8/10 | 9/10 | 7/10 | 7/10 | 5/10 | 6/10 | 5/10 |

### 2.2 Test Quality

| Dimension | v0 | v1 | v2 | v0-sonnet | v0-sonnet-skill | v0-sonnet-teams | v0-sonnet-skill-teams | v0-haiku |
|-----------|----|----|----|-----------|-----------------|-----------------|-----------------------|----------|
| All 5 tests? | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes (5+) |
| Fresh state per test? | Mixed | Yes | Yes (implicit) | Mixed | Yes | Yes | Mixed | Yes |
| Helper extraction | `app()` | `fresh_app()` + `body_json()` | `body_json()` | `fresh_app()` + `body_json()` | `make_server()` | `make_app()` | `make_app()` | `call_service()` |
| Ordering verification | Last mood check | Timestamp comparison | Timestamp comparison | Full pairwise check | Most-recent-only | Wrong assertion | Full pairwise check | ID check |
| Assertion messages | No | Yes | No | Yes | Yes (implicit) | No | Some | No |
| DRY violations | Low | Low | Low | Low | None | High (builds router per test) | Medium | Very high |
| Test lines | 195 | 175 | 189 | 180 | 114 | 192 | 187 | 183 |
| Test quality score | 8/10 | 9/10 | 8/10 | 8/10 | 7/10 | 5/10 | 8/10 | 6/10 |

### 2.3 Frontend Code Quality

| Dimension | v0 | v1 | v2 | v0-sonnet | v0-sonnet-skill | v0-sonnet-teams | v0-sonnet-skill-teams | v0-haiku |
|-----------|----|----|----|-----------|-----------------|-----------------|-----------------------|----------|
| Data fetching | onMount | createResource | createResource | createResource | createResource | createResource + onMount | createResource + onMount | createResource |
| API error handling | None | Throws on !ok | None | Throws on !ok | Throws on !ok | Throws on !ok | Throws on !ok | Throws on !ok |
| Loading state | Yes | No | No | Yes | Yes | Yes | Yes | Yes |
| `<For>` usage | 100% | 100% | 100% | 100% | 100% | 100% | Mixed (.map) | Mixed (.map) |
| Type safety | Good | Best (Mood union) | Good | Good | Good | Good | Good | Good |
| Code duplication | hexToRgb x2 | None | None | None | None | Hover handlers x2 | Hover handlers x2 | None |
| SolidJS anti-patterns | None | None | None | Inline event handlers | Inline event handlers | Inline event handlers | .map + !assertions | createEffect loop |
| Frontend quality score | 7/10 | 9/10 | 8/10 | 7/10 | 7/10 | 7/10 | 6/10 | 5/10 |

### 2.4 Frontend Design & CSS Quality

| Dimension | v0 | v1 | v2 | v0-sonnet | v0-sonnet-skill | v0-sonnet-teams | v0-sonnet-skill-teams | v0-haiku |
|-----------|----|----|----|-----------|-----------------|-----------------|-----------------------|----------|
| CSS approach | Tailwind + custom | Tailwind + custom | Tailwind + custom | Tailwind + custom | Mostly custom CSS | Tailwind + custom | Mostly custom CSS | Tailwind + layers |
| Tailwind v4 @theme | Yes | Yes (correct) | Yes (best) | Yes | Yes | Yes | Yes | Yes |
| Animation count | 3 | 4 | 4 | 4 | 7 | 4 | 5 | 3 |
| Glassmorphism | .glass class | Inline backdrop-blur | Inline + border | .glass class | .glass-card + glow | None | .glass-card | None |
| Color system | 3 CSS vars | 3 CSS vars | 10 CSS vars | 4 CSS vars | 11 CSS vars + fonts | 4 CSS vars | 10 CSS vars | 2 CSS vars |
| Responsive design | grid-cols-2/sm:4 | grid-cols-2/sm:4 | grid-cols-2/sm:4 | grid-cols-4 only | grid-cols-4 only | grid-cols-4 only | grid-cols-4 only | grid-cols-2/sm:4 |
| Special effects | Pulse wave bars | SVG radio waves | Radio wave circles | Animated bars | Film grain + scanlines | Radio wave bars | Scanlines + noise | Animated bg blobs |
| CSS lines | 57 | 67 | 77 | 71 | 331 | 52 | 158 | 72 |
| Aesthetic score (1-10) | 7 | 9 | 8 | 7 | 10 | 6 | 8 | 5 |

### 2.5 Maintainability

| Dimension | v0 | v1 | v2 | v0-sonnet | v0-sonnet-skill | v0-sonnet-teams | v0-sonnet-skill-teams | v0-haiku |
|-----------|----|----|----|-----------|-----------------|-----------------|-----------------------|----------|
| Module boundaries | Clear | Clear | Clear | Clear | Clear | Blurred | Blurred | Broken |
| Naming consistency | Good | Good | Good | Good | Good | Mixed | Mixed | Good |
| Code duplication | hexToRgb x2 | Low | Low | Redundant sort | Low | Router in tests x5 | Data in handlers | Router in tests x5 |
| Comments | None needed | JSX comments | JSX comments | None | JSX comments | JSX comments | JSX comments | None |
| New dev readability | High | High | High | High | Medium (big CSS) | Medium | Medium (big CSS) | Low (bugs) |
| Maintainability score | 8/10 | 9/10 | 9/10 | 7/10 | 7/10 | 5/10 | 6/10 | 4/10 |

### 2.6 Complexity & Size

| Variant | Rust LOC | Frontend LOC | CSS LOC | Total LOC | Test LOC |
|---------|----------|-------------|---------|-----------|----------|
| v0 | 287 | 221 | 57 | 565 | 195 |
| v1 | 253 | 373 | 67 | 693 | 175 |
| v2 | 260 | 241 | 77 | 578 | 189 |
| v0-sonnet | 301 | 256 | 71 | 628 | 180 |
| v0-sonnet-skill | 307 | 527 | 331 | 1165 | 114 |
| v0-sonnet-teams | 286 | 242 | 52 | 580 | 192 |
| v0-sonnet-skill-teams | 311 | 576 | 158 | 1045 | 187 |
| v0-haiku | 309 | 266 | 72 | 647 | 183 |

---

## 3. Best and Worst Code Patterns

### Best Patterns Found

**1. v2's `FromStr` + `Display` + `const` array (most idiomatic Rust)**
```rust
// v2/app/src/models.rs
impl FromStr for Mood {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s { "happy" => Ok(Mood::Happy), /* ... */ _ => Err(format!("Unknown mood: {s}")) }
    }
}
impl fmt::Display for Mood {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { /* ... */ }
}
const ALL_MOODS: [Mood; 8] = [ Mood::Happy, /* ... */ ];
```
Using standard traits means any Rust developer immediately understands the parsing/display contract. The `const` array avoids allocating a `Vec` on every call.

**2. v1's typed fetch wrapper (best API layer)**
```typescript
// v1/app/web/src/api.ts
async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
  return res.json();
}
export const api = {
  getMoods: (): Promise<MoodInfo[]> => fetchJSON("/moods"),
  postVibe: (mood: string): Promise<Vibe> =>
    fetchJSON("/vibe", { method: "POST", body: JSON.stringify({ mood }) }),
  getHistory: (): Promise<Vibe[]> => fetchJSON("/history"),
};
```
Single error-handling point. Generic type parameter. Namespace object. This is production-quality API code.

**3. v0-sonnet-skill's test framework usage (most concise tests)**
```rust
// v0-sonnet-skill/app/tests/api_tests.rs
let server = make_server();
let response = server.post("/api/vibe").json(&json!({ "mood": "chill" })).await;
response.assert_status_ok();
let body: Value = response.json();
```
114 lines vs 195 lines for the same test coverage. `axum_test::TestServer` eliminates all the `Request::builder()` boilerplate.

**4. v0-sonnet-teams' optimistic history update (smartest state management)**
```typescript
// v0-sonnet-teams/app/web/src/App.tsx
const vibe = await submitVibe(mood);
setCurrentVibe(vibe);
setHistory((prev) => [vibe, ...prev.slice(0, 49)]);
```
Instead of refetching history from the server after posting a vibe, this prepends the new vibe locally. Reduces latency and network calls.

**5. v2's loading skeleton (best UX detail)**
```tsx
// v2/app/web/src/components/MoodPicker.tsx
<Show when={props.moods} fallback={
  <For each={Array.from({ length: 8 })}>
    {() => <div class="h-24 animate-pulse rounded-2xl bg-surface" />}
  </For>
}>
```
The only variant that shows placeholder cards while moods are loading. Every other variant either shows nothing or a blank space.

**6. v0-sonnet-skill's CSS design system (most distinctive aesthetic)**
```css
/* Film grain overlay */
body::before {
  background-image: url("data:image/svg+xml,...feTurbulence...");
  opacity: 0.4;
}
/* Scanline effect */
body::after {
  background: repeating-linear-gradient(0deg, transparent, transparent 2px,
    rgba(0, 0, 0, 0.03) 2px, rgba(0, 0, 0, 0.03) 4px);
}
```
The only variant that feels like a designed product rather than a developer prototype.

### Worst Patterns Found

**1. v0-haiku's broken SPA fallback**
```rust
// v0-haiku/app/src/main.rs
let serve_dir = ServeDir::new(&dist_dir).fallback(
    ServeDir::new(&dist_dir).not_found_service(ServeDir::new(dist_dir.join("index.html"))),
);
```
Three nested `ServeDir` instances. The innermost one serves a directory from `web/dist/index.html` path as if it were a directory -- this would fail for SPA routing. Should be `ServeFile::new("web/dist/index.html")`.

**2. v0-haiku's Debug-based name derivation**
```rust
// v0-haiku/app/src/routes.rs
name: format!("{:?}", mood).to_lowercase(),
```
Using `Debug` trait output for user-facing data. If someone adds a field or changes the derive, the API breaks silently.

**3. v0-haiku's createEffect infinite refetch**
```typescript
// v0-haiku/app/web/src/App.tsx
createEffect(() => {
    refetchHistory();
});
```
This creates an effect that calls `refetchHistory()` every time any tracked signal changes (and `refetchHistory` itself triggers signal changes). This is a potential infinite loop or at minimum causes unnecessary refetches on every render cycle.

**4. v0-sonnet-teams' history ordering bug**
```rust
// v0-sonnet-teams/app/src/store.rs
pub fn history(&self) -> Vec<Vibe> {
    let vibes = self.vibes.read().unwrap();
    let start = vibes.len().saturating_sub(50);
    vibes[start..].to_vec()  // Returns oldest-first, not newest-first!
}
```
Items are `push()`ed (appended), so `vibes[start..]` returns them in chronological order. The API contract requires newest-first. The test comment is also wrong: `"index 54 is odd"` when 54 is even.

**5. v0-sonnet's redundant double-sort**
```rust
// v0-sonnet/app/src/store.rs
let mut result: Vec<Vibe> = store.iter().rev().take(50).cloned().collect();
result.sort_by(|a, b| b.created_at.cmp(&a.created_at));
```
`.rev().take(50)` already gives newest-first (since items are appended). The subsequent `sort_by` on `created_at` strings is O(n log n) for no reason. Worse, string comparison of RFC 3339 timestamps works accidentally (lexicographic order matches chronological order for this format) but is not semantically correct.

**6. v0-sonnet-teams/v0-haiku test router duplication**
```rust
// v0-haiku/app/tests/api_tests.rs (repeated 5 times)
let store = VibeStore::new();
let cors = CorsLayer::permissive();
let api_routes = Router::new()
    .route("/moods", get(routes::get_moods))
    .route("/vibe", post(routes::post_vibe))
    .route("/history", get(routes::get_history));
let app = Router::new()
    .nest("/api", api_routes)
    .layer(cors)
    .layer(DefaultBodyLimit::max(1024))
    .with_state(store);
```
This 10-line router construction is copy-pasted in every single test function. A `make_app()` helper would reduce this to 1 line.

**7. v0-sonnet-skill-teams' non-null assertions**
```typescript
// v0-sonnet-skill-teams/app/web/src/components/VibeCard.tsx
{props.vibe!.emoji}
{props.vibe!.message}
{props.vibe!.color}
```
Using TypeScript `!` non-null assertion operator instead of SolidJS's `Show` callback pattern `{(vibe) => vibe().emoji}`. The component is inside `<Show when={!props.loading && props.vibe}>` but the callback-based narrowing is safer.

---

## 4. Final Rankings

### Overall Code Quality Ranking

| Rank | Variant | Score | Justification |
|------|---------|-------|---------------|
| 1 | **v1 (Opus pipeline)** | 9.0 | Best API layer, idiomatic SolidJS, SVG animations, proper `createResource`, typed Mood union, descriptive test assertions. The $12.77 shows in the polish. |
| 2 | **v2 (Opus optimized)** | 8.5 | Most idiomatic Rust (`FromStr`/`Display`/`const`), best CSS design system, loading skeletons, `CorsLayer::permissive()`. Slightly less frontend polish than v1. |
| 3 | **v0 (Opus bare)** | 7.5 | Solid across all dimensions for $1.62. No major bugs. Clean separation. Only weakness is manual data fetching and duplicated `hexToRgb`. |
| 4 | **v0-sonnet (Sonnet bare)** | 7.0 | Good structure, proper `FromStr`, encapsulated store. Dragged down by redundant sort in history and inline event handlers. |
| 5 | **v0-sonnet-skill (Sonnet + skill)** | 7.0 | Best aesthetic design by far (10/10 visual). But massive CSS footprint, store-logic split across files, and weaker ordering test. The skill clearly influenced visual quality but not code quality. |
| 6 | **v0-sonnet-skill-teams (Sonnet + skill + teams)** | 6.0 | Decent backend, good design DNA inherited from skill variant. But `!` assertions, `.map()` anti-pattern, mood data inlined in routes, verbose test setup. |
| 7 | **v0-sonnet-teams (Sonnet + teams)** | 5.0 | Has the smartest frontend pattern (optimistic update) but the **history ordering bug** and worst backend separation (all data in routes.rs) are serious. Wrong test assertion compounds the issue. |
| 8 | **v0-haiku (Haiku bare)** | 4.0 | Multiple bugs: broken SPA fallback, Debug-based name generation, createEffect infinite loop, module double-declaration. Massive test duplication. The $0.97 price tag shows. |

### Best-in-Class Awards

| Category | Winner | Runner-up |
|----------|--------|-----------|
| Most idiomatic Rust | v2 | v0-haiku (for Copy derive, FromStr, error type) |
| Best test suite | v1 | v0 |
| Best API/fetch layer | v1 | v0-sonnet |
| Best SolidJS patterns | v1 | v2 |
| Best visual design | v0-sonnet-skill | v0-sonnet-skill-teams |
| Best CSS architecture | v2 | v0-sonnet-skill |
| Most maintainable | v2 | v1 |
| Best value (quality/$) | v0 ($1.62) | v0-sonnet ($1.36) |
| Fewest bugs | v0, v1, v2 (tie) | -- |

---

## 5. Surprising Findings

### 1. Subagents (teams) consistently degraded code quality

Both team variants (v0-sonnet-teams, v0-sonnet-skill-teams) have worse backend architecture than their non-team counterparts. The pattern: mood data gets inlined directly in route handlers instead of being on the enum. This suggests that when work is parallelized across agents, the "backend agent" may not have had full context on model design conventions. The v0-sonnet-teams variant has an actual **correctness bug** in history ordering that its non-team sibling (v0-sonnet) does not.

### 2. The "skill" improved aesthetics but not code quality

v0-sonnet-skill has the most beautiful CSS (331 lines, film grain, scanlines, custom fonts, broadcast badge) but its backend and test quality are middling. v0-sonnet (no skill) has cleaner backend code with better test coverage of ordering. The frontend-design skill appears to be a purely visual multiplier -- it does not improve TypeScript patterns, SolidJS idioms, or component architecture.

### 3. Opus bare ($1.62) beats most Sonnet variants

v0 (Opus bare, $1.62) ranks #3 overall and beats every Sonnet variant except arguably v0-sonnet-skill on aesthetics. For pure code quality, a single Opus prompt without pipelines or skills outperforms Sonnet with skill, Sonnet with teams, and Sonnet with both.

### 4. Pipeline cost does not linearly scale with quality

v1 ($12.77) is the best overall but only marginally better than v2 ($5.24). The 2.4x cost increase from v2 to v1 buys maybe a 5% quality improvement -- mainly in test assertion messages and the SVG header animation. The jump from v0 ($1.62) to v2 ($5.24) is where the most value-per-dollar exists.

### 5. Every variant passes the "unwrap audit" identically

All variants use `.unwrap()` on `RwLock::write()` and `RwLock::read()` -- none handle poisoned locks. All use `.unwrap()` on `TcpListener::bind()`. This is acceptable for a simple in-memory app but reveals that no variant, regardless of cost, considered lock poisoning recovery. The lock unwrap count ranges from 4-6 across all variants -- nearly identical.

### 6. Haiku's `createEffect` bug is subtle and dangerous

```typescript
createEffect(() => { refetchHistory(); });
```
This is the kind of bug that might not cause visible problems in some scenarios (if SolidJS's batching prevents infinite loops) but represents a fundamental misunderstanding of SolidJS reactivity. It's the only variant with a reactivity bug that could cause runtime issues. The $0.97 cost ceiling appears to have a real impact on framework-specific knowledge.

### 7. The `Vibe.mood: Mood` vs `Vibe.mood: String` split is model-vs-pragma

v1, v2, and v0-haiku store `mood: Mood` (enum) in the Vibe struct. v0, v0-sonnet, v0-sonnet-skill, v0-sonnet-teams, and v0-sonnet-skill-teams store `mood: String`. The enum approach is type-safer but requires careful serde handling. Neither approach caused actual bugs -- it's a design preference that reveals how the model thinks about type boundaries.

### 8. No variant implemented proper CORS

Every variant either uses `CorsLayer::permissive()` or `allow_origin(Any)` -- wide open. The one exception is v0-sonnet-teams which restricts to `allow_headers([CONTENT_TYPE])` but still allows any origin. For a real deployment, none of these would pass a security review.

### 9. Responsive design was inconsistently handled

Only v0, v1, v2, and v0-haiku use `grid-cols-2 sm:grid-cols-4` for the mood picker grid. The four Sonnet variants all hardcode `grid-cols-4`, which would squeeze buttons on small screens. This is a UX detail that Opus models consistently handled while Sonnet models did not.

### 10. The most expensive variant (v1) has the only i18n-ready time formatting

v1's `relativeTime()` uses `Intl.RelativeTimeFormat` -- the browser's built-in localization API. Every other variant hand-rolls strings like `"3m ago"`. If these apps needed to support non-English locales, v1 would be the only one ready. This is the kind of "production thinking" that correlates with higher cost.
