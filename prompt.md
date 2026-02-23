# Mood Radio — Product Requirements Document

## What Is This?

**Mood Radio** is a tiny full-stack app that turns your current mood into a personalized "vibe" — a themed response with a matching personality, color, and emoji. Pick how you're feeling, get a fun cosmic reading, and browse your vibe history. Think fortune cookies meets a mood ring meets lo-fi radio aesthetics.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Rust + Axum |
| Frontend | SolidJS + Vite + Tailwind CSS v4 |
| Storage | In-memory (no database) |
| Backend tests | `cargo test` |
| Frontend build | `bun run build` (in `web/` directory) |

## Project Structure

```
mood-radio/
├── Cargo.toml              # Rust project
├── src/
│   ├── main.rs             # Axum server entry, static file serving, CORS
│   ├── routes.rs           # API route handlers
│   ├── models.rs           # Data types (Mood, Vibe, VibeResponse)
│   └── store.rs            # Thread-safe in-memory store
├── tests/
│   └── api_tests.rs        # Integration tests for all 3 API routes
└── web/
    ├── package.json        # SolidJS + Vite + Tailwind
    ├── index.html          # SPA entry (dark background, app title)
    ├── vite.config.ts      # Dev server proxy to backend
    └── src/
        ├── index.tsx        # Mount App, import global CSS
        ├── App.tsx          # Layout: header, MoodPicker, VibeCard, History
        ├── api.ts           # Fetch wrapper for backend routes
        └── components/
            ├── MoodPicker.tsx   # Mood selection grid
            ├── VibeCard.tsx     # Animated vibe display
            └── History.tsx      # Scrolling history list
```

## Backend Specification

### Data Model

```rust
// Available moods the user can pick from
pub enum Mood {
    Happy, Sad, Energetic, Chill, Anxious, Creative, Nostalgic, Chaotic
}

// A vibe response generated for a mood
pub struct Vibe {
    pub id: String,          // UUID
    pub mood: Mood,
    pub message: String,     // The themed response text
    pub emoji: String,       // Matching emoji
    pub color: String,       // Hex color code
    pub created_at: String,  // ISO 8601 timestamp
}
```

### API Routes

#### `GET /api/moods`
Returns the list of available moods with their display info.

**Response:**
```json
[
  { "name": "happy", "emoji": "☀️", "color": "#FFD700", "label": "Happy" },
  { "name": "sad", "emoji": "🌧️", "color": "#4A90D9", "label": "Sad" },
  { "name": "energetic", "emoji": "⚡", "color": "#FF6B35", "label": "Energetic" },
  { "name": "chill", "emoji": "🌊", "color": "#7EC8E3", "label": "Chill" },
  { "name": "anxious", "emoji": "🌀", "color": "#9B59B6", "label": "Anxious" },
  { "name": "creative", "emoji": "🎨", "color": "#E74C3C", "label": "Creative" },
  { "name": "nostalgic", "emoji": "📻", "color": "#D4A373", "label": "Nostalgic" },
  { "name": "chaotic", "emoji": "🔥", "color": "#FF1493", "label": "Chaotic" }
]
```

#### `POST /api/vibe`
Submit a mood, get back a themed vibe response. The backend picks a random message from a pool of themed responses for that mood.

**Request:**
```json
{ "mood": "chill" }
```

**Response:**
```json
{
  "id": "a1b2c3d4-...",
  "mood": "chill",
  "message": "The universe is a lazy river today. Float with it.",
  "emoji": "🌊",
  "color": "#7EC8E3",
  "created_at": "2026-02-23T10:30:00Z"
}
```

Each mood should have at least 5 different themed messages to pick from randomly. Messages should be poetic, fun, and personality-driven. Examples:

- **Happy:** "The sun wrote you a personal letter today. It says: you're doing great."
- **Sad:** "Rain is just the sky being honest. Let it wash through."
- **Energetic:** "You're a comet with a coffee addiction. Go make something shake."
- **Chill:** "The universe is a lazy river today. Float with it."
- **Anxious:** "Your thoughts are a browser with 47 tabs open. Let's close a few."
- **Creative:** "Your brain is a disco ball throwing ideas in every direction."
- **Nostalgic:** "Somewhere, a song you forgot is still playing on repeat."
- **Chaotic:** "The plan is there is no plan. Buckle up, buttercup."

#### `GET /api/history`
Returns the last 50 vibes, newest first.

**Response:**
```json
[
  {
    "id": "a1b2c3d4-...",
    "mood": "chill",
    "message": "The universe is a lazy river today. Float with it.",
    "emoji": "🌊",
    "color": "#7EC8E3",
    "created_at": "2026-02-23T10:30:00Z"
  }
]
```

### Backend Implementation Details

- Use `Arc<RwLock<Vec<Vibe>>>` for the in-memory store, passed as Axum state
- CORS middleware: allow all origins, allow `Content-Type` header
- Serve on `0.0.0.0:3000`
- Use `uuid` crate for ID generation
- Use `chrono` crate for timestamps
- Use `serde` + `serde_json` for serialization
- Use `rand` crate to pick random messages
- Use `tower-http` for CORS middleware
- Serve the built frontend from `web/dist/` as static files at `/` (fallback to `index.html` for SPA routing)
- API routes are nested under `/api`

### Tests

Write integration tests in `tests/api_tests.rs` that:
1. Test `GET /api/moods` returns all 8 moods with correct fields
2. Test `POST /api/vibe` with a valid mood returns a vibe with all fields
3. Test `POST /api/vibe` with an invalid mood returns 400
4. Test `GET /api/history` is empty initially, then has entries after posting vibes
5. Test that history returns newest first and caps at 50

Use `axum::test` helpers (or build the app and use `tower::ServiceExt` + `hyper` for test requests). Each test should create a fresh app instance with a fresh store.

## Frontend Specification

### Design Language

- **Dark mode by default** — deep charcoal background (`#1a1a2e`), soft white text
- **Glassmorphism** cards — frosted glass effect with backdrop-blur
- **Smooth animations** — fade in/out for vibe cards, slide-in for history items
- **Gradient accents** — mood colors used as gradient accents on cards
- **Lo-fi radio aesthetic** — rounded corners, soft shadows, warm tones
- **Responsive** — works on mobile and desktop

### Components

#### `MoodPicker.tsx`
A grid of mood buttons (2x4 or responsive grid). Each button shows:
- The mood's emoji (large, centered)
- The mood's label (small, below emoji)
- Background tinted with the mood's color (subtle, 10-20% opacity)
- Hover: scale up slightly, increase color opacity
- Click: triggers the vibe API call

#### `VibeCard.tsx`
Displays the current vibe response. When a new vibe arrives:
- Card fades/slides in with animation
- Shows the emoji (huge, top)
- Shows the message (centered, stylized text)
- Background gradient using the vibe's color
- Glassmorphism effect (backdrop-blur, semi-transparent)
- When empty (no vibe yet): show a subtle prompt like "Pick a mood to tune in..."

#### `History.tsx`
A scrolling list of past vibes below the main card:
- Each entry shows: emoji, truncated message, relative time ("2m ago")
- Subtle dividers between entries
- Slide-in animation for new entries
- Max height with overflow scroll
- Fades at the bottom edge

#### `App.tsx`
Main layout:
- Header with app name "Mood Radio" and a subtle radio wave icon/animation
- MoodPicker section
- VibeCard section (main focus, centered)
- History section (below, collapsible or always visible)

#### `api.ts`
Typed fetch wrapper:
- `getMoods(): Promise<MoodInfo[]>`
- `submitVibe(mood: string): Promise<Vibe>`
- `getHistory(): Promise<Vibe[]>`
- Base URL: `/api` (proxied in dev, served by Axum in prod)

### Frontend Build

- `vite.config.ts` should proxy `/api` to `http://localhost:3000` during development
- `bun run build` outputs to `web/dist/`
- Use Tailwind CSS v4 (CSS-first config via `@theme` in CSS, no `tailwind.config.js`)
- Use `solid-js` and `vite-plugin-solid`

## Milestones

### v0.1 — Backend API + Tests

Build the complete Rust backend:

- Initialize Cargo project with required dependencies (`axum`, `tokio`, `serde`, `serde_json`, `uuid`, `chrono`, `rand`, `tower-http`)
- Implement `Mood` enum with serde serialization (lowercase names)
- Implement `Vibe` struct with all fields
- Implement thread-safe in-memory `VibeStore` using `Arc<RwLock<Vec<Vibe>>>`
- Implement `GET /api/moods` returning all 8 moods with emoji, color, label
- Implement `POST /api/vibe` — validate mood, pick random message, create Vibe, store it, return it
- Implement `GET /api/history` — return last 50 vibes, newest first
- Add CORS middleware (allow all origins, Content-Type header)
- Write all 5 integration tests in `tests/api_tests.rs`
- Ensure `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo build`, and `cargo test` all pass

**Tests:**
- GET /api/moods returns 8 moods with emoji, color, label fields
- POST /api/vibe with valid mood returns complete Vibe
- POST /api/vibe with invalid mood returns 400
- GET /api/history empty then populated after POST
- History ordering (newest first) and cap (50 max)

**Docs:** None for this milestone

### v0.2 — Frontend + Static File Serving

Build the SolidJS frontend and wire it to the backend:

- Initialize SolidJS + Vite project in `web/` with `bun create vite web --template solid-ts`
- Add Tailwind CSS v4 (`@tailwindcss/vite` plugin, CSS-first config)
- Create `api.ts` with typed fetch functions
- Build `MoodPicker.tsx` — responsive emoji grid, hover effects, click handler
- Build `VibeCard.tsx` — glassmorphism card, fade-in animation, gradient background
- Build `History.tsx` — scrolling list, relative timestamps, slide-in animation
- Build `App.tsx` — dark mode layout, header with radio wave aesthetic, all sections
- Style with Tailwind: dark background, glassmorphism, gradients, animations
- Configure `vite.config.ts` with `/api` proxy to `localhost:3000`
- Add static file serving to Axum (`tower-http` ServeDir for `web/dist/`, SPA fallback)
- Verify `bun run build` in `web/` succeeds
- Verify the full stack works: Axum serves both API and frontend

**Tests:**
- `bun run build` completes without errors in `web/`
- All existing `cargo test` still pass after adding static file serving

**Docs:** None for this milestone

## Build & Run

```bash
# Backend
cargo build
cargo test
cargo run          # starts on :3000

# Frontend (dev)
cd web && bun install && bun run dev   # Vite on :5173, proxies /api to :3000

# Frontend (build)
cd web && bun run build    # outputs to web/dist/

# Full stack (production)
cargo run   # serves API + static files from web/dist/
```
