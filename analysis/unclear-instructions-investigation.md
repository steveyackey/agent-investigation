# Unclear Instructions Investigation

How 10 AI agent variants interpreted ambiguous areas in the Mood Radio PRD.

## Prompt Differences: SDK vs CLI

Two distinct prompts were used:
- **`prompt.md`** (SDK variants: v0, v1, v2, v0-sonnet, v0-sonnet-skill, v0-sonnet-teams, v0-sonnet-skill-teams, v0-haiku): The raw PRD with detailed inline comments in the project structure, example messages, example response JSON, milestones, and build/run instructions. More verbose and prescriptive.
- **`cli-prompt.md`** (CLI variants: cli-opus, cli-sonnet): The PRD wrapped in a `<prd>` tag, preceded by explicit build-verification commands (`cargo fmt --check`, `cargo clippy`, `cargo build`, `cargo test`, `cd web && bun install && bun run build`) and a `<design-skill>` section demanding "bold design choices" and rejecting "generic AI aesthetics."

The CLI prompt stripped inline code comments from the project structure and reduced field-level comments in the data model. The design skill injection is the most significant difference -- it explicitly told CLI variants to avoid generic aesthetics and choose unique typography, which visibly affected their output.

---

## Ambiguity 1: In-Memory Storage Architecture

**What the PRD said:** "Use `Arc<RwLock<Vec<Vibe>>>` for the in-memory store" (both prompts, explicit).

**Despite the explicit instruction, variants diverged on abstraction level:**

| Variant | Type Alias / Struct | Insertion Strategy | 50-Cap Enforcement |
|---------|-------------------|-------------------|-------------------|
| v0 (Opus SDK) | `type VibeStore = Arc<RwLock<Vec<Vibe>>>` + free functions (`add_vibe`, `get_history`) | `insert(0, vibe)` (prepend, newest-first in vec) | Limit passed as parameter to `get_history(store, 50)` -- vec grows unbounded |
| v1 (Pipeline Opus) | `type VibeStore = Arc<RwLock<Vec<Vibe>>>` inside `AppState` struct | `push` (append) | `iter().rev().take(50)` in route handler -- vec grows unbounded |
| v2 (Optimized Pipeline) | `type VibeStore = Arc<RwLock<Vec<Vibe>>>` + free function `new_store()` | `push` (append) | `reverse() + truncate(50)` in route handler -- vec grows unbounded |
| v0-sonnet | `struct VibeStore { vibes: Arc<RwLock<Vec<Vibe>>> }` with methods | `push` (append) | `iter().rev().take(50)` then re-sort by `created_at` -- double-work, vec grows unbounded |
| v0-sonnet-skill | `type VibeStore = Arc<RwLock<Vec<Vibe>>>` + free functions | `insert(0, vibe)` (prepend) | `truncate(50)` after insert -- **only variant that bounds memory in store** |
| v0-sonnet-teams | `struct VibeStore` with methods | `push` (append) | `saturating_sub(50)` slice -- vec grows unbounded, **returns in wrong order (oldest first)** |
| v0-sonnet-skill-teams | `struct VibeStore` with methods + `Default` impl | `push` (append) | `clone + reverse + truncate(50)` -- vec grows unbounded |
| v0-haiku | `struct VibeStore` with methods + manual `Default` | `insert(0, vibe)` (prepend) | `truncate(50)` after insert -- bounds memory in store |
| cli-opus | `type VibeStore = Arc<RwLock<Vec<Vibe>>>` + free functions + `MAX_HISTORY` const | `insert(0, vibe)` (prepend) | `truncate(MAX_HISTORY)` after insert -- bounds memory in store, clean constant |
| cli-sonnet | `type Store = Arc<RwLock<Vec<Vibe>>>` + free function | `insert(0, vibe)` in route handler directly | `truncate(50)` in route handler -- bounds memory |

**Key divergence:** Whether to enforce the 50-item cap at the **store level** (bounding the Vec) vs at the **read level** (just returning the last 50 from an unbounded Vec). Only v0-sonnet-skill, v0-haiku, cli-opus, and cli-sonnet bound memory at the store. The rest let the Vec grow forever -- a subtle memory leak.

**Abstraction divergence:** Five variants (v0-sonnet, v0-sonnet-teams, v0-sonnet-skill-teams, v0-haiku) wrapped the `Arc<RwLock<Vec<Vibe>>>` in a named struct with methods. Five variants (v0, v1, v2, v0-sonnet-skill, cli-opus) used a bare type alias. cli-sonnet used a minimalist type alias `Store` instead of `VibeStore`. v1 wrapped it in an `AppState` struct.

**Bug:** v0-sonnet-teams has a likely ordering bug -- `history()` returns `vibes[start..]` which is the **oldest** 50 items, not the newest 50. It takes from the tail of a push-appended Vec without reversing.

---

## Ambiguity 2: The 5 Integration Tests

**What the PRD said:** 5 specific test scenarios enumerated by number:
1. GET /api/moods returns all 8 moods with correct fields
2. POST /api/vibe with valid mood returns a vibe with all fields
3. POST /api/vibe with invalid mood returns 400
4. GET /api/history is empty initially, then has entries after posting
5. History returns newest first and caps at 50

**The SDK prompt added:** "Use `axum::test` helpers (or build the app and use `tower::ServiceExt` + `hyper` for test requests)."

| Variant | Test Framework | Test Count | Fresh App Per Test | Ordering Verification |
|---------|---------------|------------|-------------------|----------------------|
| v0 (Opus SDK) | tower::ServiceExt + oneshot | 5 functions | Yes (shared store for tests 4-5) | Checks first item is "happy" (index 54 is even) |
| v1 (Pipeline Opus) | tower::ServiceExt + oneshot | 5 functions | Yes (AppState::new each time) | Checks `first_ts >= last_ts` |
| v2 (Optimized Pipeline) | tower::ServiceExt + oneshot | 5 functions | Yes (create_app() creates internal store) | Checks `first_ts >= last_ts` |
| v0-sonnet | tower::ServiceExt + oneshot | 5 functions | Yes | Checks `created_at` descending order across all pairs |
| v0-sonnet-skill | **axum-test** crate `TestServer` | 5 functions | Yes | Checks first is "chill" (last posted) |
| v0-sonnet-teams | **axum-test** crate `TestServer` | 5 functions | Yes | **Separate `test_history_empty` from populated** = 5 tests but test 4 is split into 2 functions, making 6 effective test scenarios |
| v0-sonnet-skill-teams | tower::ServiceExt + oneshot + manual Router construction in tests | 5 functions | Yes | Checks store directly (`history[0].id == "vibe-59"`) |
| v0-haiku | tower::Service trait + `call()` | 5 functions | Yes | Checks `vibe-59` is first (direct store manipulation) |
| cli-opus | **reqwest** HTTP client + `TcpListener::bind(":0")` | 5 functions | Yes (spawns actual server on random port) | Checks `created_at` descending across all pairs |
| cli-sonnet | **axum-test** crate `TestServer` | 5 functions | Yes | Posts 51 chill then 1 happy; checks first is "happy", rest are "chill" |

**Key divergences:**

- **Test approach:** Most used tower::ServiceExt with oneshot (the "build the app" approach). Three used the `axum-test` crate (v0-sonnet-skill, v0-sonnet-teams, cli-sonnet). cli-opus was unique in spawning a real HTTP server with reqwest -- true integration testing vs the others' in-process testing.
- **v0-sonnet-teams split test 4 into two separate functions:** `test_history_empty` and `test_history_ordering_and_cap`. This is arguably more test granularity than requested.
- **v0-haiku and v0-sonnet-skill-teams bypassed the API for the cap test:** They added vibes directly to the store struct, then checked the store directly. This tests the store logic, not the API integration.
- **Cap testing approach:** Most posted 51 or 55 vibes then checked len == 50. The number of vibes posted ranged from 51 to 60.

**Bug in v0-sonnet-skill-teams:** The test checks `history[0]["mood"]` is `"sad"` with comment "index 54 is odd" -- but index 54 is even (0-indexed), so the assertion is wrong. The test likely passes by coincidence depending on timing, or there is an off-by-one error in the reasoning.

---

## Ambiguity 3: Themed Response Messages

**What the PRD said:** "Each mood should have at least 5 different themed messages to pick from randomly. Messages should be poetic, fun, and personality-driven." The SDK prompt included 8 example messages (one per mood). The CLI prompt included the same examples.

| Variant | Messages Per Mood | Message Style | Reuses PRD Examples? |
|---------|-----------------|---------------|---------------------|
| v0 (Opus SDK) | 5 | Poetic, personality-driven | Yes, all 8 PRD examples included verbatim |
| v1 (Pipeline Opus) | 5 | Slightly different tone, still poetic | Yes, all 8 PRD examples included |
| v2 (Optimized Pipeline) | 5 | Shorter, punchier -- "Sunshine vibes incoming!" | **No** -- entirely original, less poetic, more casual |
| v0-sonnet | 5 | Long-form, thoughtful | Yes, all 8 PRD examples included |
| v0-sonnet-skill | **6** | Rich, evocative, original | Yes, first message per mood is often the PRD example |
| v0-sonnet-teams | 5 | Simple, generic -- "Joy is your default state" | Yes, first message per mood is the PRD example |
| v0-sonnet-skill-teams | **6** | Most creative -- "Entropy called, she says you're her favorite child" | **No** -- entirely original, very literary/radio-themed |
| v0-haiku | **6** | Radio/frequency-themed -- "Static is just signals that haven't found their pattern" | **No** -- entirely original, strongest thematic coherence (radio metaphor throughout) |
| cli-opus | 5 | Radio-themed -- "Old broadcasts still echo through the atmosphere" | **No** -- entirely original, heavy radio/signal metaphor |
| cli-sonnet | **6** | Literary, distinctive -- "Clouds are just the sky being honest" | Partially -- first message for some moods matches PRD |

**Key insight:** The design skill injection (cli-prompt variants and v0-sonnet-skill-teams) produced the most thematically coherent messages. v0-haiku stands out as having the most consistent "radio broadcast" metaphor across all messages despite being the weakest model. v2 produced the least interesting messages ("Lightning in a bottle!", "Can't stop, won't stop!"). v0-sonnet-teams had the most generic messages.

**Message count:** The PRD said "at least 5." Four variants went beyond to 6 per mood (v0-sonnet-skill, v0-sonnet-skill-teams, v0-haiku, cli-sonnet). No variant went below 5.

---

## Ambiguity 4: Dark Mode

**What the PRD said:** "Dark mode by default -- deep charcoal background" (the SDK prompt also gave a specific hex: `#1a1a2e`). The CLI prompt said "deep charcoal background (`#1a1a2e`), soft white text."

**The question:** Is this a static dark theme, or a toggle-able dark/light mode?

| Variant | Implementation | Background Color | Toggle? |
|---------|---------------|-----------------|---------|
| v0 (Opus SDK) | CSS variable `--color-bg: #1a1a2e` | `#1a1a2e` | No |
| v1 (Pipeline Opus) | Tailwind gradient `from-[#1a1a2e] via-[#16213e] to-[#0f3460]` | Multi-color gradient | No |
| v2 (Optimized Pipeline) | CSS variable `--color-bg: #0f0e17` | `#0f0e17` (deeper/darker) | No |
| v0-sonnet | Inline style + CSS `background-color: #1a1a2e` | `#1a1a2e` | No |
| v0-sonnet-skill | CSS variable `--color-bg-base: #0a0a0f` | `#0a0a0f` (near-black) | No |
| v0-sonnet-teams | Inline + CSS `#1a1a2e` | `#1a1a2e` | No |
| v0-sonnet-skill-teams | `radial-gradient(ellipse at 20% 0%, #1a1040, #0d0d1a)` | Gradient from deep purple to near-black | No |
| v0-haiku | Tailwind gradient `from-gray-950 to-gray-900` + `--color-gray-950: #030712` | `#030712` (almost pure black) | No |
| cli-opus | CSS variables `--color-void: #07060b` + radial gradients with purple | `#07060b` with subtle purple/blue gradients | No |
| cli-sonnet | CSS variables `--color-void: #050509` | `#050509` (near-black) | No |

**Consensus:** Every single variant interpreted "dark mode by default" as a static dark theme. None implemented a light mode toggle. The phrasing "by default" did not trigger any variant to build a toggle.

**Background color divergence:** Despite `#1a1a2e` being given explicitly, only 3 variants (v0, v0-sonnet, v0-sonnet-teams) used that exact color. The others chose darker backgrounds -- the "skill" and CLI variants especially went darker (`#0a0a0f`, `#07060b`, `#050509`), which reflects the design skill's push for bold, distinctive choices. v1 used a three-color gradient instead of a flat color.

---

## Ambiguity 5: Glassmorphism

**What the PRD said:** "Glassmorphism cards -- frosted glass effect with backdrop-blur."

| Variant | Implementation | Where Applied |
|---------|---------------|---------------|
| v0 (Opus SDK) | `.glass` CSS class: `rgba(255,255,255,0.05)` bg + `backdrop-filter: blur(12px)` + `1px solid rgba(255,255,255,0.1)` border | VibeCard, History container |
| v1 (Pipeline Opus) | Tailwind classes inline: `bg-white/5 backdrop-blur-xl border-white/10` | Header, VibeCard (both empty and filled), MoodPicker buttons |
| v2 (Optimized Pipeline) | No explicit glassmorphism class. Surface colors defined as `rgba(255,255,255,0.04)`. | No backdrop-blur used at all |
| v0-sonnet | `.glass` CSS class: `rgba(255,255,255,0.05)` + `blur(16px)` + `border-radius: 1.5rem` | VibeCard, History |
| v0-sonnet-skill | `.glass-card` CSS class: `rgba(255,255,255,0.04)` + `blur(20px)` + film grain + scanline overlay | Broader application, plus noise/scanline effects |
| v0-sonnet-teams | No glass class. Simple `rgba` backgrounds with `border-radius`. | No backdrop-blur |
| v0-sonnet-skill-teams | `body::before` noise + `body::after` scanline. Uses radial gradients. | No traditional glassmorphism, replaced with noise/grain aesthetic |
| v0-haiku | No glass class. Uses `bg-gray-900 bg-opacity-50 backdrop-blur-xl` on header. Standard card styling. | Minimal -- only on header |
| cli-opus | CSS variables for glass surfaces. `border-dim` / `border-glow`. Radial gradients with color. | Replaced glassmorphism with layered-surface aesthetic |
| cli-sonnet | No glass effect. Clean, border-focused design. `--color-panel: #0f0f20`. | No glassmorphism at all |

**Key insight:** True glassmorphism (backdrop-blur + semi-transparent bg + visible border) was implemented by only 4 variants: v0, v1, v0-sonnet, v0-sonnet-skill. The "skill" variants (v0-sonnet-skill, v0-sonnet-skill-teams, cli-opus, cli-sonnet) largely abandoned glassmorphism in favor of more distinctive approaches (noise textures, scanlines, opaque dark panels). v2, v0-sonnet-teams, and v0-haiku simply didn't implement it.

---

## Ambiguity 6: Lo-Fi Radio Aesthetic

**What the PRD said:** "Lo-fi radio aesthetic -- rounded corners, soft shadows, warm tones."

| Variant | Interpretation | Distinctive Elements |
|---------|---------------|---------------------|
| v0 (Opus SDK) | Minimal radio reference. Clean dark UI with emoji and pulse-wave bars. | 5 animated bars in header, satellite dish emoji, "tune into your frequency" tagline |
| v1 (Pipeline Opus) | SVG radio wave animation with expanding/fading circles. | Animated concentric circles radiating from center dot (true radio wave visual) |
| v2 (Optimized Pipeline) | Subtle dots/bars as radio decoration. | Static dots in header, section labels ("Select Frequency", "Current Signal", "Recent Broadcasts") |
| v0-sonnet | Animated radio bars (`radio-bar` class with scaleY animation). | 5 bars with staggered animation, radio emoji, "tune into your frequency" |
| v0-sonnet-skill | Film grain overlay, scanline effect, "Live" broadcast badge, wave bars. | **Most committed:** grain texture, scanlines, "Libre Baskerville" serif + "Space Mono" fonts, broadcast badge with pulsing dot, section labels like "BROADCAST" |
| v0-sonnet-teams | Animated bars with scaleY. Simple. | Purple bars, basic radio-bar animation |
| v0-sonnet-skill-teams | Radio wave bars with amber color + "Space Mono" monospace font. | "MOOD RADIO" split title, "broadcasting your inner frequency" tagline, amber accent color, DM Sans + Space Mono fonts |
| v0-haiku | Radio emoji + "Turn your mood into a vibe" subtitle. Animated purple/blue background blobs. | Background blob animation, sticky header with backdrop-blur, "How are you feeling?" prompt |
| cli-opus | Wave bars with "Space Grotesk" display font + "Libre Baskerville" serif. Section labels. Footer with "broadcasting on all frequencies." | Gradient text header, serif italic tagline, mood-colored accent bars |
| cli-sonnet | **Most radio-authentic:** "88.7 FM" indicator, "Syne" display font, amber accent, wave bars, "TUNE IN TO YOUR FREQUENCY", section labels ("BROADCAST", "CURRENT VIBE", "TRANSMISSIONS"). | Fake FM frequency number, left-border accent on vibe card, grid-based history layout, mono labels |

**Key insight:** The "lo-fi radio aesthetic" was the most creatively interpreted ambiguity. Variants ranged from "just add some animated bars" (v0, v0-sonnet) to "full radio station UI with FM frequency indicators and broadcast badges" (cli-sonnet, v0-sonnet-skill). The design-skill-injected variants consistently produced more thematic coherence.

**Warm tones:** Most variants ignored "warm tones" entirely, sticking with cool purples and blues. Only v0-sonnet-skill (golden accent `#c9a84c`), v0-sonnet-skill-teams (amber `#f59e0b`), and cli-sonnet (amber `#e8a020`) meaningfully incorporated warm accents.

---

## Ambiguity 7: History Scrolling

**What the PRD said:** "Max height with overflow scroll" and "Fades at the bottom edge."

| Variant | Max Height | Overflow | Bottom Fade | Slide-in Animation |
|---------|-----------|----------|-------------|-------------------|
| v0 (Opus SDK) | `max-h-80` (320px) | `overflow-y-auto` | CSS mask-image gradient | `slide-in` animation class |
| v1 (Pipeline Opus) | `max-h-96` (384px) | `overflow-y-auto` | No fade | `slide-in-left` animation |
| v2 (Optimized Pipeline) | `max-h-72` (288px) | `overflow-y-auto` | No fade | `slide-up` animation |
| v0-sonnet | `max-height: 280px` (inline) | `overflow-y-auto` | `.history-fade` CSS mask | `animate-slide-up` |
| v0-sonnet-skill | `max-height: 280px` (inline) + container with `overflow: hidden` | Nested scroll div inside overflow-hidden container | `.history-fade` absolute gradient overlay | `animate-slide-in` |
| v0-sonnet-teams | `max-h-64` (256px) | `overflow-y-auto` | No fade | No slide animation |
| v0-sonnet-skill-teams | `max-height: 280px` (inline) | `overflow-y-auto` | No explicit fade | `slide-in-left` |
| v0-haiku | `max-h-96` (384px) | `overflow-y-auto` | No fade | `animate-slide-in` |
| cli-opus | `max-h-80` (320px) | `overflow-y-auto` | No fade | `animate-slide-up` |
| cli-sonnet | `max-height: 320px` (via `.history-list` class) | `overflow-y: auto` via `scrollbar-width: thin` | No fade (but styled scrollbar) | `slide-up` animation per entry with staggered delay |

**Bottom fade:** Only 3 of 10 variants implemented the requested bottom-edge fade: v0, v0-sonnet, and v0-sonnet-skill. The rest ignored it.

**Max height values:** Ranged from 256px to 384px, with no consistency. The PRD didn't specify a value.

---

## Ambiguity 8: Frontend Component Architecture

**What the PRD said:** Exactly 4 components (MoodPicker, VibeCard, History, App) + 1 utility (api.ts). Structure was given in the project tree.

| Variant | Components Created | Extra Components/Functions | Data Fetching Strategy |
|---------|-------------------|--------------------------|----------------------|
| v0 (Opus SDK) | MoodPicker, VibeCard, History, App | None | `onMount` with `Promise.all` for initial load; manual `getHistory()` after submit |
| v1 (Pipeline Opus) | MoodPicker, VibeCard, History, App | None | `createResource` for moods and history; `refetch` after submit |
| v2 (Optimized Pipeline) | MoodPicker, VibeCard, History, App | None | `createResource` for moods and history; `refetch` after submit |
| v0-sonnet | MoodPicker, VibeCard, History, App | None | `createResource` for moods and history; `refetch` after submit |
| v0-sonnet-skill | MoodPicker, VibeCard, History, App | None | `createResource` for moods and history; section labels added |
| v0-sonnet-teams | MoodPicker, VibeCard, History, App | None | `onMount` + manual history; optimistic update (`setHistory(prev => [vibe, ...prev.slice(0, 49)])`) |
| v0-sonnet-skill-teams | MoodPicker, VibeCard, History, App | `RadioWave` inline component in App.tsx | `createResource` for moods; `onMount` for history; optimistic update |
| v0-haiku | MoodPicker, VibeCard, History, App | None | `createResource` for moods and history; `refetch` after submit; `createEffect` for initial refetch |
| cli-opus | MoodPicker, VibeCard, History, App | None | `createSignal` only; `onMount` for history; manual `getHistory()` after submit |
| cli-sonnet | MoodPicker, VibeCard, History, App | None | `createResource` for moods; `createSignal` for history; optimistic update |

**Consensus:** Every variant followed the exact component structure. No variant added extra component files. v0-sonnet-skill-teams was the only one to add an inline helper component (`RadioWave`). The spec was unambiguous here and all variants complied.

**Data fetching divergence:** Three approaches emerged:
1. **createResource + refetch** (v1, v2, v0-sonnet, v0-sonnet-skill, v0-haiku) -- SolidJS-idiomatic
2. **createSignal + onMount + manual fetch** (v0, cli-opus) -- more React-like
3. **Optimistic update** (v0-sonnet-teams, v0-sonnet-skill-teams, cli-sonnet) -- prepend the new vibe to local state without re-fetching. Most performant but diverges from server state if anything goes wrong.

---

## Ambiguity 9: API Error Handling

**What the PRD said:** "POST /api/vibe with invalid mood returns 400." No detail on error response body format.

| Variant | Error Return Type | Error Body Content | Mood Parsing |
|---------|------------------|-------------------|-------------|
| v0 (Opus SDK) | `Result<Json<Vibe>, StatusCode>` | Empty body, just status 400 | `Mood::parse()` -> `Option` |
| v1 (Pipeline Opus) | `Result<Json<Vibe>, (StatusCode, String)>` | `"invalid mood"` string body | `Mood::from_name()` -> `Option` |
| v2 (Optimized Pipeline) | `Result<Json<Vibe>, StatusCode>` | Empty body, just status 400 | `FromStr` impl -> `Result` |
| v0-sonnet | `impl IntoResponse` with tuple | `Json(None::<Vibe>)` -- a JSON null body | `FromStr` impl -> `Result` |
| v0-sonnet-skill | `Result<Json<Vibe>, StatusCode>` | Empty body, just status 400 | `Mood::parse()` -> `Option` |
| v0-sonnet-teams | `Result<Json<Vibe>, StatusCode>` | Empty body, just status 400 | Match on raw string in route handler |
| v0-sonnet-skill-teams | `Result<Json<Vibe>, StatusCode>` | Empty body, just status 400 | `Mood::parse()` -> `Option` (with `to_lowercase()` preprocessing) |
| v0-haiku | `Result<Json<Vibe>, (StatusCode, String)>` | `"Invalid mood"` string body | `FromStr` impl -> `Result` |
| cli-opus | `Result<Json<Vibe>, StatusCode>` | Empty body, just status 400 | `Mood::parse()` -> `Option` |
| cli-sonnet | `Result<Json<Vibe>, StatusCode>` | Empty body, just status 400 | `Mood::parse()` -> `Option` |

**Key divergences:**
- **Error body:** Most returned an empty 400. Two (v1, v0-haiku) returned a descriptive error string. v0-sonnet returned `Json(None)` which would serialize as `null`.
- **Case sensitivity:** v0-sonnet-teams preprocessed with `to_lowercase()`, making mood parsing case-insensitive. All others are case-sensitive (matching "chill" but rejecting "Chill").
- **Mood parsing location:** Some put parsing in the Mood model (parse/from_str methods), while v0-sonnet-teams put the mood-to-data mapping entirely in the route handler (`mood_data()` function returning a tuple of emoji, color, and messages).
- **RwLock error handling:** cli-sonnet was the only variant that handled RwLock poisoning gracefully with `unwrap_or_else(|e| e.into_inner())`. All others used `.unwrap()` which would panic on a poisoned lock.

---

## Ambiguity 10: CORS Configuration

**What the PRD said:** "CORS middleware: allow all origins, allow `Content-Type` header." The SDK prompt also said: "Use `tower-http` for CORS middleware."

| Variant | CORS Approach | Headers Allowed | Setup Location |
|---------|-------------|-----------------|---------------|
| v0 (Opus SDK) | `CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any)` | All | lib.rs |
| v1 (Pipeline Opus) | `CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any)` | All | main.rs |
| v2 (Optimized Pipeline) | `CorsLayer::permissive()` | All (permissive = everything) | lib.rs |
| v0-sonnet | `CorsLayer::new().allow_origin(Any).allow_headers(Any).allow_methods(Any)` | All | lib.rs |
| v0-sonnet-skill | `CorsLayer::new().allow_origin(Any).allow_headers(Any).allow_methods(Any)` | All | lib.rs |
| v0-sonnet-teams | `CorsLayer::new().allow_origin(Any).allow_headers([CONTENT_TYPE])` | **Only Content-Type** | main.rs |
| v0-sonnet-skill-teams | `CorsLayer::new().allow_origin(Any).allow_headers(Any).allow_methods(Any)` | All | lib.rs |
| v0-haiku | `CorsLayer::permissive()` | All (permissive) | main.rs |
| cli-opus | `CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any)` | All | lib.rs |
| cli-sonnet | `CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any)` | All | lib.rs |

**Key divergence:** The PRD said "allow `Content-Type` header" -- only v0-sonnet-teams took this literally and restricted `allow_headers` to just `[CONTENT_TYPE]`. All others used `Any` for headers, which is more permissive than specified but safer for real usage. v2 and v0-haiku used `CorsLayer::permissive()` which enables everything including credentials -- arguably over-permissive.

---

## Ambiguity 11: Vibe.mood Field Type (Not in Original 10, But Notable)

**What the PRD said:** The Rust struct shows `pub mood: Mood` (the enum), but the JSON response shows `"mood": "chill"` (a string).

| Variant | Vibe.mood Rust Type | Serialization |
|---------|-------------------|---------------|
| v0 (Opus SDK) | `String` | Stores mood name as string directly |
| v1 (Pipeline Opus) | `Mood` (enum) | serde `rename_all = "lowercase"` serializes to string |
| v2 (Optimized Pipeline) | `Mood` (enum) | serde `rename_all = "lowercase"` |
| v0-sonnet | `String` | Stores mood name as string directly |
| v0-sonnet-skill | `String` | Stores mood name as string directly |
| v0-sonnet-teams | `String` | Stores mood name as string directly |
| v0-sonnet-skill-teams | `String` | Stores mood name as string directly |
| v0-haiku | `Mood` (enum) | serde `rename_all = "lowercase"` |
| cli-opus | `Mood` (enum) | serde `rename_all = "lowercase"` + `Copy` derive |
| cli-sonnet | `Mood` (enum) | serde `rename_all = "lowercase"` |

**Split:** 5 variants stored the mood as a `String` in the Vibe struct, 5 stored it as the `Mood` enum. The String approach is simpler but loses type safety. The enum approach requires proper serde serialization but is cleaner. This is a direct consequence of the PRD showing the struct with `Mood` type but the JSON with a string value.

---

## Ambiguity 12: Font Choices and Typography

**What the CLI prompt's design skill said:** "Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter."

| Variant | Primary Font | Display/Accent Font | Google Fonts Import? |
|---------|-------------|---------------------|---------------------|
| v0 (Opus SDK) | system-ui (implicit) | None | No |
| v1 (Pipeline Opus) | system-ui | None | No |
| v2 (Optimized Pipeline) | "Inter" (explicitly in CSS!) | None | No (defined in `--font-sans`) |
| v0-sonnet | system-ui | None | No |
| v0-sonnet-skill | "Libre Baskerville" (serif) | "Space Mono" (monospace) | Likely (declared in CSS) |
| v0-sonnet-teams | system-ui | None | No |
| v0-sonnet-skill-teams | "DM Sans" | "Space Mono" (monospace) | Likely |
| v0-haiku | system-ui (Tailwind default) | None | No |
| cli-opus | "Space Grotesk" | "Libre Baskerville" (serif) | Likely |
| cli-sonnet | "Syne" | "Space Mono" (monospace) | Likely |

**Key insight:** The design skill's font directive was effective. All skill-injected variants (v0-sonnet-skill, v0-sonnet-skill-teams, cli-opus, cli-sonnet) chose distinctive typography. v2 (Optimized Pipeline) ironically declared `Inter` as its font -- exactly what the design skill says to avoid, but v2 didn't receive the design skill.

---

## Ambiguity 13: Visual Texture and Background Details

The design skill asked for "Gradient meshes, noise textures, geometric patterns, layered transparencies."

| Variant | Noise/Grain | Scanlines | Gradient Background | Extra Visual Layers |
|---------|------------|-----------|--------------------|--------------------|
| v0 (Opus SDK) | No | No | No (flat color) | None |
| v1 (Pipeline Opus) | No | No | Yes (3-color gradient) | None |
| v2 (Optimized Pipeline) | No | No | No (flat color) | Radio-wave keyframe animation |
| v0-sonnet | No | No | No (flat color) | `.history-fade` mask |
| v0-sonnet-skill | **Yes** (SVG feTurbulence) | **Yes** (repeating-linear-gradient) | No | Film grain + scanlines over everything |
| v0-sonnet-teams | No | No | No (flat color) | None |
| v0-sonnet-skill-teams | **Yes** (SVG feTurbulence) | **Yes** (repeating-linear-gradient) | Yes (radial gradient) | Noise + scanlines + glass-card |
| v0-haiku | No | No | No (Tailwind gradient) | Animated purple/blue blobs with mix-blend-screen |
| cli-opus | No | No | Yes (radial gradients with purple/blue) | Styled scrollbar |
| cli-sonnet | No | No | No (flat near-black) | Wave bars, styled scrollbar |

**Only 2 variants implemented noise/grain textures:** v0-sonnet-skill and v0-sonnet-skill-teams. Both used the same technique -- SVG `feTurbulence` filter encoded as a data URI in a `body::before` pseudo-element, with scanlines in `body::after`. These were the two variants that had the design skill AND were Sonnet SDK variants.

---

## Summary of Findings

### Most Faithfully Interpreted the PRD
**v0 (Opus SDK bare)** -- followed nearly every specification literally, including the exact data structure, store pattern, color values, and glassmorphism implementation. Made minimal creative choices.

### Most Creative Interpretation
**cli-sonnet** -- "88.7 FM" frequency indicator, "Syne" font, amber accent theme, "TRANSMISSIONS" section labels. Treated the app as an actual radio station interface while still meeting all functional requirements.

### Most Technically Sound
**cli-opus** -- `MAX_HISTORY` constant, memory-bounded store, graceful RwLock handling, reqwest-based true integration tests, and clean separation of concerns.

### Most Bugs/Issues
**v0-sonnet-teams** -- history ordering bug (returns oldest instead of newest), split test structure, no glassmorphism, generic messages. Also the only variant to restrict CORS headers to just Content-Type.

### Strongest Pattern: Design Skill Impact
The 4 variants that received the design skill (v0-sonnet-skill, v0-sonnet-skill-teams, cli-opus, cli-sonnet) consistently produced:
- Custom typography (not system-ui)
- Warm accent colors (gold/amber)
- Radio-station metaphors in UI copy
- More distinctive visual identity
- More creative/literary vibe messages

The design skill was the single most impactful variable in output differentiation.

### No Variant Asked for Clarification
As expected (they couldn't), no variant expressed uncertainty in their approach. Every variant made definitive choices on every ambiguity and proceeded without hedging. The only sign of "uncertainty" is when variants fell back to the most common/safe interpretation (e.g., `allow_headers(Any)` instead of trying to parse the spec's "allow Content-Type header" literally).
