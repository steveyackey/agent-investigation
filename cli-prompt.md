You are building a full-stack app called "Mood Radio" from scratch.

Build EVERYTHING described in the PRD below. The project root is your current working directory.

Create the complete Rust backend (Axum) and SolidJS frontend in this directory.
When done, ensure ALL of these pass:
- cargo fmt --check
- cargo clippy -- -D warnings
- cargo build
- cargo test
- cd web && bun install && bun run build

IMPORTANT: When building the frontend, follow the design skill guidelines below.
The frontend should be visually distinctive, polished, and production-grade.
Avoid generic AI aesthetics. Make bold design choices.

<design-skill>
This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc.
- **Differentiation**: What makes this UNFORGETTABLE?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision.

## Frontend Aesthetics Guidelines

- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables. Dominant colors with sharp accents.
- **Motion**: CSS animations for effects and micro-interactions. Staggered reveals, scroll-triggering, hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, grain overlays.

NEVER use generic AI aesthetics like overused fonts (Inter, Roboto, Arial), purple gradients on white, predictable layouts.

Interpret creatively. No design should be the same. NEVER converge on common choices.
</design-skill>

<prd>
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
├── Cargo.toml
├── src/
│   ├── main.rs
│   ├── routes.rs
│   ├── models.rs
│   └── store.rs
├── tests/
│   └── api_tests.rs
└── web/
    ├── package.json
    ├── index.html
    ├── vite.config.ts
    └── src/
        ├── index.tsx
        ├── App.tsx
        ├── api.ts
        └── components/
            ├── MoodPicker.tsx
            ├── VibeCard.tsx
            └── History.tsx
```

## Backend Specification

### Data Model

```rust
pub enum Mood {
    Happy, Sad, Energetic, Chill, Anxious, Creative, Nostalgic, Chaotic
}

pub struct Vibe {
    pub id: String,
    pub mood: Mood,
    pub message: String,
    pub emoji: String,
    pub color: String,
    pub created_at: String,
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
Submit a mood, get back a themed vibe response.

**Request:** `{ "mood": "chill" }`

Each mood should have at least 5 different themed messages to pick from randomly. Messages should be poetic, fun, and personality-driven.

#### `GET /api/history`
Returns the last 50 vibes, newest first.

### Backend Implementation Details

- Use `Arc<RwLock<Vec<Vibe>>>` for the in-memory store
- CORS middleware: allow all origins, allow `Content-Type` header
- Serve on `0.0.0.0:3000`
- Use `uuid`, `chrono`, `serde`, `serde_json`, `rand`, `tower-http` crates
- Serve built frontend from `web/dist/` as static files at `/` (SPA fallback)

### Tests

Write integration tests in `tests/api_tests.rs`:
1. GET /api/moods returns all 8 moods with correct fields
2. POST /api/vibe with valid mood returns a vibe with all fields
3. POST /api/vibe with invalid mood returns 400
4. GET /api/history is empty initially, then has entries after posting
5. History returns newest first and caps at 50

## Frontend Specification

### Design Language

- **Dark mode by default** — deep charcoal background, soft white text
- **Glassmorphism** cards — frosted glass effect with backdrop-blur
- **Smooth animations** — fade in/out for vibe cards, slide-in for history
- **Gradient accents** — mood colors as gradient accents
- **Lo-fi radio aesthetic** — rounded corners, soft shadows, warm tones
- **Responsive** — works on mobile and desktop

### Components

#### `MoodPicker.tsx`
Grid of mood buttons (2x4 or responsive). Each shows emoji, label, mood-tinted background. Hover scale + color. Click triggers vibe API.

#### `VibeCard.tsx`
Animated vibe display with fade-in, emoji, message, gradient background, glassmorphism. Empty state: "Pick a mood to tune in..."

#### `History.tsx`
Scrolling list of past vibes with emoji, truncated message, relative time. Slide-in animation. Max height with overflow scroll.

#### `App.tsx`
Header with "Mood Radio" + radio wave animation. MoodPicker, VibeCard, History sections.

#### `api.ts`
Typed fetch wrapper: `getMoods()`, `submitVibe(mood)`, `getHistory()`. Base URL: `/api`.

### Frontend Build

- Vite proxy `/api` to `http://localhost:3000` in dev
- `bun run build` outputs to `web/dist/`
- Tailwind CSS v4 (CSS-first config via `@theme`)
- `solid-js` and `vite-plugin-solid`
</prd>
