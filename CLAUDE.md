# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run inst             # Install deps (uses npm ci --ignore-scripts — do NOT use npm install)
npm run dev              # Run client + server in dev mode with hot reload
npm run start:client     # Client only
npm run start:server-dev # Server only
npm test                 # Run all tests (Vitest)
npm run test:coverage    # Tests with coverage
npm run lint             # Oxlint + ESLint
npm run lint:fix         # Oxlint + ESLint with auto-fix
npm run format           # Prettier
npm run build-prod       # Production build
npm run arena            # AI agent vs Impossible nations on random maps, headless
```

Cloud sessions get Node 24 + npm 12 (required by `engines`) from
`.claude/hooks/session-start.sh`; the image's default Node 22 fails `npm ci`.

**Run a single test file:**

```bash
npx vitest tests/YourTest.test.ts --run
npx vitest NationAllianceBehavior --run # match by name pattern
```

## Architecture

OpenFront.io is a real-time multiplayer territorial strategy game. There are four components:

1. **`src/core/`** — Deterministic game simulation. Pure TypeScript with **no external dependencies**. Must remain fully deterministic (seeded PRNG, no floating-point math). Runs in a Web Worker thread. All `src/core` changes **must** include tests.
2. **`src/client/`** — Rendering (Pixi.js/WebGL), UI (Lit web components + Tailwind CSS 4), WebSocket communication.
3. **`src/server/`** — Game coordination, intent relay, WebSocket management (Node.js/Express/ws).
4. **API** — Closed-source Cloudflare Worker handling auth, stats, cosmetics, monetization. Not in this repo.

### Simulation Flow (Intent → Execution)

The game simulation runs **on each client**, not the server. The server only relays intents.

1. Player action → client creates an **Intent** → sent to server
2. Server bundles all intents for the tick into a **Turn** → relays to all clients
3. Client forwards Turn to the Core worker
4. Core creates an **Execution** for each intent
5. Core calls `executeNextTick()` — all executions run and mutate game state
6. Core sends **GameUpdates** back to client → client renders

Intents and all wire messages are Zod-validated schemas defined in `src/core/Schemas.ts`.
Every WebSocket frame is a compact binary encoding of those schemas
(`src/core/ZbinWire.ts`, library docs in `zbin/README.md`). HTTP stays JSON.

### CDN / Static Assets

The game server only serves `index.html` and the WebSocket. All other assets (JS bundle, images, maps, worker) come from a CDN bucket. `CDN_BASE` is an empty string in dev (falls back to same-origin) and a full origin (e.g. `https://cdn.example.com`) in production. It is set as both a Vite build-time variable and a server runtime env var.

## Key Files

| File                        | Purpose                                |
| --------------------------- | -------------------------------------- |
| `src/core/Schemas.ts`       | All intent/message types (Zod schemas) |
| `src/core/GameRunner.ts`    | Simulation orchestrator                |
| `src/core/game/GameImpl.ts` | Game state implementation              |
| `src/server/GameServer.ts`  | Main WebSocket server, game loop       |
| `src/server/Master.ts`      | Lobby and game registry                |
| `tests/util/Setup.ts`       | Test helper — creates test games       |
| `docs/Architecture.md`      | Architecture overview                  |
| `zbin/README.md`            | Binary wire format for zod schemas     |
| `docs/Auth.md`              | JWT/auth flow                          |
| `docs/API.md`               | Public API endpoints                   |
| `vite.config.ts`            | Build config, CDN handling             |

## UI Text / i18n

All user-visible text must go through `translateText()` and have a corresponding entry added to `resources/lang/en.json`. Translations are managed via Crowdin. DO NOT modify any other translation files.

## AI Agent (`src/agent/`)

This fork exists to build an AI that beats the built-in Nation AI on any map.
Guide: `docs/10-agent-interface.md`; game mechanics: `docs/00-overview.md`
onward (chapter 09 is strategy). The plan and milestone status are in
`docs/11-roadmap.md` and results in `docs/12-ledger.md`: read both before agent
work, and append a ledger row when you adopt a change. Pictures of games:
`npm run arena:gallery`, filed with `npm run arena:progress` into
`docs/progress/` and shown on the page linked from roadmap §11.5.

- An agent implements `Agent` (`src/agent/Agent.ts`): it reads `ctx.game`, the
  full simulation state, and acts only through `ctx.send(intent)`, rate
  limited like a real client. **Never call a mutating method on `ctx.game`**;
  verify with `--isolate`.
- One agent runs unchanged in the headless arena (Node) and in the browser as
  an autopilot in its own Web Worker (`?agent=<name>`). Never put agent logic
  on the page's main thread.
- Register agents in `src/agent/agents/index.ts`; keep `src/agent/` free of
  DOM and Node APIs, except `src/agent/arena/` (Node only).

```bash
npm run arena -- --games 16                                   # vs Impossible nations, random maps
npm run arena -- --agent a --agent b --games 32               # paired A/B on identical games
npm run arena -- --isolate --games 2                          # proves an agent never mutates the game
npm run arena -- --images --image-every 5                     # territory PNGs to inspect
npm run arena -- --suite quick --agent a --shard 0/2          # suites: smoke showcase quick dev holdout
npm run arena:compare -- dirA dirB                            # paired report (arena:merge joins shards)
npm run arena -- --from DIR --game 7 --images --image-every 1 # rerun one stored game
npx vitest tests/agent --run
```

## Testing Patterns

Tests use a `setup()` helper from `tests/util/Setup.ts` that creates a full game instance with map data from `tests/testdata/maps/`. Write tests that exercise the core simulation directly — not mocks.

## Tech Stack

- **Bundler:** Vite + TypeScript 5.7
- **Rendering:** Pixi.js (WebGL)
- **UI Components:** Lit (LitElement) + Tailwind CSS 4
- **Audio:** Howler.js
- **Schemas/Validation:** Zod
- **Testing:** Vitest
- **Server:** Node.js, Express, ws (WebSocket)
