# 08 — Running the game headless

Every command in this chapter was **executed and verified** on this checkout
(node v22.22.2). Verification notes are marked `VERIFIED`.

## 8.1 Install — the gotcha you will hit first

`package.json` requires `node >=24.15.0 <25` and `npm >=12.1.0 <13`, and
`.npmrc` sets `engine-strict=true`, so `npm ci` fails with `EBADENGINE` on the
cloud image's default node 22. CI and the Dockerfile use Node 24 with
`npm install --global npm@12.1.0`.

In Claude Code on the web, `.claude/hooks/session-start.sh` provisions exactly
that (Node 24.21.0 into `/opt/node24`, npm 12.1.0, `npm run inst`, and the
Playwright that matches the pre-installed Chromium) and puts Node 24 on the
session's PATH. It is idempotent: a cached container starts in ~0.2 s, a fresh
one in ~16 s.

```bash
CLAUDE_CODE_REMOTE=true .claude/hooks/session-start.sh   # by hand, if needed
```

Do **not** use `npm install` — repo policy; `npm run inst` is the blessed alias.

> Fallback without the hook: `npm ci --ignore-scripts --engine-strict=false`
> on node 22 also runs the full suite green (verified before the hook existed).

## 8.2 Test suite — VERIFIED

`npm test` = `vitest run && vitest run tests/server`. Vitest config lives inside
`vite.config.ts:311` (jsdom, `tests/setup.ts`).

| Command | Result on this machine |
|---|---|
| `npx vitest run` | **527 files, 6,790 passed, 1 skipped, ~18 min** |
| `npx vitest run tests/server` | 73 files, 820 passed, 119 s |
| `npx vitest tests/core/snapshot/CoreSnapshot.test.ts --run` | 2 passed, 3.7 s |
| `npx vitest NationAllianceBehavior --run` | name-pattern form |

Ignorable noise: `Lit is in dev mode`, `MaxListenersExceededWarning`, and a
`Failed to parse URL from /maps/australia/manifest.json` in
`tests/client/InventoryModal.test.ts` (jsdom `fetch` has no origin). No CPU, GPU
or network required.

`npm run test:matchmaking*` are **not** headless — they need `npm run dev` on port
9000 and Playwright.

## 8.3 Loading a map outside the browser

| Loader | Maps |
|---|---|
| `tests/perf/fullgame/NodeGameMapLoader.ts` | the **real production maps** in `resources/maps/<lowercased key>/` (**128** maps) |
| `tests/util/ScriptedGame.ts` → `TestDataMapLoader` | `tests/testdata/maps/{world,plains,big_plains,giantworldmap,ocean_and_land,half_land_half_ocean}` |
| `tests/util/Setup.ts` → `setup()` | the same test maps, but builds a `Game` directly with no `GameRunner` |

```ts
import { loadTerrainMap } from "src/core/game/TerrainMapLoader";
import { NodeGameMapLoader } from "tests/perf/fullgame/NodeGameMapLoader";
import { GameMapType, GameMapSize } from "src/core/game/Game";

const t = await loadTerrainMap(
  GameMapType.Europe, GameMapSize.Compact,
  new NodeGameMapLoader("resources/maps"), /* loadLayerImages */ false);
// t.gameMap, t.miniGameMap, t.nations, t.additionalNations, t.teamGameSpawnAreas
```

> `FullGamePerf.ts --map <name>` matches `GameMapType` **keys**, not test-data
> directory names. `--map plains` errors; use `--map iceland`, `--map world`.

## 8.4 Existing harnesses

### (a) Full-game perf / soak — VERIFIED

```bash
npx tsx tests/perf/fullgame/FullGamePerf.ts --map iceland --ticks 60 --bots 10 \
  --no-cpu-profile --no-exec-profile --no-gc-profile --no-alloc-profile
# VERIFIED → "Spawn phase done: 202 turns in 179ms, 18 players spawned"
#            "Final hash: 341743576266886"
# The turn count, player count and hash are deterministic and reproduce exactly.
# Throughput and heap are machine-dependent (observed 341 and 535 ticks/sec,
# 39 and 43 MB peak, on two different runs) — do not treat them as constants.
```

Flags: `--ticks --bots --nations --seed --top --window --footprint --snapshot-at`.
Deterministic per `(map, seed, bots)` and it prints a final state hash — use that
to prove a change did not alter simulation behaviour.

### (b) Scripted humans exercising every intent type

`tests/util/ScriptedGame.ts` is the closest thing in the repo to a bot playing.

```ts
import { createScriptedRunner, scriptedGameStart, stepScripted }
  from "tests/util/ScriptedGame";

const runner = await createScriptedRunner("world", scriptedGameStart({ bots: 10, nations: 4 }));
for (let i = 0; i < 300; i++) stepScripted(runner);
const snap = runner.snapshot();       // Uint8Array
// VERIFIED: "tick 300 spawnPhase false alive 17 / snapshot bytes: 61809"
```

`scriptedTurn(game)` is a **deterministic pure function of (state, tick)**
producing a `Turn`; `playIntent` is a 22-case switch covering every gameplay
intent. **Read this file first.**

### (c) Replay an archived record

```bash
npm run replay:game -- <gameID>                 # fetches the public API
npm run replay:game -- path/to/record.json      # local file
```

Exits non-zero on divergence. VERIFIED: unknown id → `HTTP 403` (network-gated in
this sandbox).

## 8.5 Driving the loop with synthetic intents — the minimal shape

**No browser, no worker, no server.** This is the recipe an agent author wants.

```ts
import path from "path";
import { createGameRunner } from "src/core/GameRunner";
import { GameUpdateType, HashUpdate } from "src/core/game/GameUpdates";
import { Difficulty, GameMapSize, GameMapType, GameMode, GameType, UnitType }
  from "src/core/game/Game";
import { GameStartInfo, StampedIntent, Turn } from "src/core/Schemas";
import { NodeGameMapLoader } from "tests/perf/fullgame/NodeGameMapLoader";

const CID = "AGENT001";                       // 8 alphanumerics, schema-validated
const gameStart: GameStartInfo = {
  gameID: "HEADLES1",                         // 8 alphanumerics
  lobbyCreatedAt: 0,
  config: {
    gameMap: GameMapType.Europe, gameMapSize: GameMapSize.Compact,
    gameMode: GameMode.FFA, gameType: GameType.Private,   // NOT Singleplayer, see below
    difficulty: Difficulty.Medium, nations: "default", bots: 20,
    donateGold: false, donateTroops: false, infiniteGold: false,
    infiniteTroops: false, instantBuild: false, randomSpawn: false,
  },
  players: [{ clientID: CID, username: "agent", clanTag: null, isLobbyCreator: true }],
};

const runner = await createGameRunner(
  gameStart, CID,
  new NodeGameMapLoader(path.join(ROOT, "resources/maps")),
  (gu) => {                                   // ← the observation channel
    if ("errMsg" in gu) { console.error(gu.errMsg); return; }
    for (const h of gu.updates[GameUpdateType.Hash] as HashUpdate[]) { /* … */ }
    // gu.updates[Player|Unit|Win|…], gu.packedTileUpdates,
    // gu.packedPlayerUpdates, gu.packedAttackUpdates, gu.packedNukeImpacts
  },
);
// createGameRunner already calls runner.init()

const game = runner.game;
let turnNumber = 0;
const step = (intents: StampedIntent[] = []) => {
  runner.addTurn({ turnNumber: turnNumber++, intents } satisfies Turn);
  if (!runner.executeNextTick()) throw new Error("tick failed");
};

// 1. spawn
const tile = /* first t with isLand(t) && !isImpassable(t) && !hasOwner(t) */;
step([{ type: "spawn", tile, clientID: CID }]);
while (game.inSpawnPhase()) step();

// 2. play
const me = game.playerByClientID(CID)!;
for (let i = 0; i < 200; i++) {
  const actions = runner.playerActions(me.id(), x, y, [UnitType.City, UnitType.Port]);
  const intents: StampedIntent[] = [];
  if (actions.canAttack)
    intents.push({ type: "attack", targetID: null, troops: me.troops()/4, clientID: CID });
  step(intents);
}
```

**VERIFIED output of exactly this shape** (Europe/Compact, 20 bots, 207 ticks):

```
map 1452x836, players=0, spawnPhase=true
spawn tile: 4689 coords 333 3
my player: mipg6agl spawned: true tiles: 18
playerActions: {"canAttack":false,"buildables":[{"t":"City","canBuild":false,"cost":"125000"},…]}
done: tick=207 errors=0
me: tiles: 33 troops: 93077 gold: 20500 units: []
alive players: 21
```

### Pitfalls, all hit during verification

| Pitfall | Detail |
|---|---|
| **Spawn phase never ends in Singleplayer** | `GameRunner.init()` adds `SpawnTimerExecution` only when `gameType !== Singleplayer`. With `Singleplayer` you must call `game.endSpawnPhase()` yourself. **Use `GameType.Private`** to get the timer |
| **~200 wasted ticks** | `numSpawnPhaseTurns()` is 100 (SP) / 150 (randomSpawn) / **200** |
| **`game.players()` filters to alive** | It returns **0** before anyone spawns. Use `game.allPlayers()` for the full roster |
| **Intents must carry `clientID`** | The real server stamps it; headless, you stamp it yourself. An unknown clientID becomes a harmless `NoOpExecution` |
| **IDs are schema-validated** | `gameID` and `clientID` must be 8 alphanumerics; usernames ≥3 chars; clan tags 2–5. See `cid()` in `tests/util/GameServerHarness.ts:28` |
| **`executeNextTick()` returns false** | when no turn is queued or a tick is already executing. Always `addTurn` first. Errors arrive through the callback as `ErrorUpdate`, **not** as a throw |
| **Silence the logging** | `console.debug = () => {}` — the sim is chatty per tick |
| **No build step needed** | `npx tsx` works directly |
| **Never emit `kick_player` / `update_game_config` / `toggle_game_start_timer`** | `LocalServer` queues them and `createExec` throws outside the try/catch. See `07-action-api.md §7.2` |

## 8.6 Snapshot / restore

```ts
const bytes: Uint8Array = runner.snapshot(gitCommit?);   // tick boundary only
const restored = await createGameRunnerFromSnapshot(gameStart, bytes, clientID, mapLoader, cb);
```

Throws if called mid-tick. `tests/core/snapshot/FullGameSnapshot.test.ts` is the
oracle: a 1,500-tick scripted game snapshotted every 100 ticks, restored, and
required to agree on both per-tick hashes and snapshot bytes.

## 8.7 Record → replay round trip — VERIFIED

A `GameRecord` built from a headless run (turns + per-turn hashes + `info` +
`version: "v0.0.2"` + `gitCommit`) fed back to the replay harness:

```
$ npx tsx tests/replay/ReplayGame.ts record.json
Replaying RECORDG1: Iceland (Compact), Free For All, 1 players, 602 turns
Compared 61 hash checkpoints in 0.9s: 61 match, 0 mismatch.
Replay is IN SYNC with the recorded game.
```

Hashes are emitted on a subset of ticks (61 of 602). `createPartialGameRecord`
drops turns with neither intents nor a hash; `decompressGameRecord` re-inflates
the gaps.

## 8.8 Server in process, no sockets

`tests/util/GameServerHarness.ts` + `tests/util/Wire.ts` drive a real
`GameServer` with a mock `ws` — `emit(ClientMessage)` in, `sent(ctx)` decoded out.
Use it to test join/rejoin/kick/intent-authorization/turn-relay without a network.
The binary wire rejects placeholder ids; use the `cid("p1")` helper.

A real local server: `npm run start:server-dev`. `ECONNREFUSED "Error polling
lobby"` is expected — the closed-source API worker is not in this repo.

## 8.9 Browser-driven headless

The repo ships a Playwright harness at **`.claude/skills/run-openfront/`**
(`SKILL.md`, `setup.sh`, `driver.mjs`, `game.mjs`, `autopilot.mjs`). In the
cloud environment Chromium is pre-installed and the session hook installs the
matching Playwright, so `setup.sh` is only needed on other hosts:

```bash
(npm run dev > /tmp/dev.log 2>&1 &)             # vite on :9000, NOT 5173
node .claude/skills/run-openfront/game.mjs
node .claude/skills/run-openfront/autopilot.mjs baseline Iceland 90   # an agent plays, see 10-agent-interface.md
```

Exported helpers: `startSoloGame`, `gameState`, `findSpawnTile`, `spawn`,
`waitForSpawnPhaseEnd`, `waitForTick`, `findExpansionTile`, `attack`,
`clickWorld`, `panTo`, `setAttackRatio`, `openRadialMenu`.

Critical notes from that skill:
- **The client refuses software WebGL** (`src/client/render/gl/initGL.ts`
  requests `failIfMajorPerformanceCaveat` and rejects SwiftShader/llvmpipe
  renderer strings), and headless Chromium only has SwiftShader.
  `driver.mjs`'s `launch()` masks both in the test browser and passes
  `--enable-unsafe-swiftshader`; without it the game never starts
  (`GLUnavailableError: WebGL2 unavailable: software`).
- **`launch({ rafIntervalMs: 3000 }) is mandatory in-game.** SwiftShader needs
  seconds per frame; unthrottled rAF starves the main thread and the singleplayer
  turn loop drops to ~0.3 ticks/s instead of 10.
- Ground truth without repo changes: `document.querySelector("build-menu").game`
  is a live `GameView`; `.transformHandler` is the camera.
- Solo-modal options are element properties: `document.querySelector("single-player-modal").bots = 50`.
- **Click tile centres** (`+0.5, +0.5`) — `screenToWorldCoordinates` floors, and
  clicking your own tile is a silent no-op.
- HUD elements swallow canvas clicks; verify `document.elementFromPoint` hits
  `#game-input-overlay`, and call `transformHandler.clearTarget()` first because
  the camera animates after spawn.
- **Attack ratio is a fraction**: `document.querySelector("control-panel").uiState.attackRatio = 0.5`.

## 8.10 How the UI builds intents

`src/client/hud/layers/PlayerActionHandler.ts` (96 lines) is the complete adapter
between clicks and intents. Every method just emits a `Send*IntentEvent`:

| Method | Emits |
|---|---|
| `handleAttack(player, targetId)` | `SendAttackIntentEvent(targetId, uiState.attackRatio * player.troops())` — `targetId = null` means TerraNullius |
| `handleBoatAttack(player, tile)` | `SendBoatAttackIntentEvent(tile, attackRatio * troops)` |
| `handleSpawn`, `handleAllianceRequest`, `handleExtendAlliance`, `handleBreakAlliance`, `handleTargetPlayer`, `handleEmbargo`, `handleEmoji`, `handleDeleteUnit` | the corresponding events |
| `handleDonateGold(recipient)` | amount always `null` — the modal picks it |
| `handleDonateTroops(recipient, troops?)` | **drops the call if `troops <= 0`** |

Build and upgrade intents bypass this class and come from `BuildMenu` /
`RadialMenuElements`.

### Attack ratio semantics

`uiState.attackRatio` is a **fraction in [0.01, 1.0]**, and it is the only thing
converting a click into a troop count. Default **0.2**. Slider is `min=1 max=100`
with `value/100`. Keyboard steps by 10 percentage points; stepping up from 0.01
lands on **0.10, not 0.11**.

> ⚠️ `GameRenderer.ts:62` seeds `uiState.attackRatio = 20` — a *percent*. It is
> overwritten by `ControlPanel.init()`, but any intent emitted before that would
> request `20 × troops`.

### Build menu gating

Three layers, all must pass: config (`isUnitDisabled` filters the table), worker
(`buildables(tile, types)` returns `{type, cost, canBuild: TileRef|false,
canUpgrade: number|false}`), and the button (enabled iff either is non-false).

**Upgrade wins over build**: if `canUpgrade !== false` the click emits
`SendUpgradeStructureIntentEvent`, else `BuildUnitIntentEvent`.
`rocketDirectionUp` is attached only for AtomBomb and HydrogenBomb.

Bulk submenu slots: `[1, ...steps, maxAmount]` where steps are
`NUKE_BULK_STEPS = [2,5]` for stackable atom bombs and
`STRUCTURE_BULK_STEPS = [5,10]` otherwise. **If `maxAmount <= 1` the submenu is
empty and the click falls through to an immediate x1 action.**

### Radial menu centre button

- Spawn phase + non-random-spawn + unowned land → spawn
- Friendly and connected target → `handleDonateTroops(target, floor(attackRatio * troops))`
- Otherwise → `handleAttack(myPlayer, selected?.id() ?? null)`

Delete is offered only for your own land, outside the spawn phase, with cooldown
at 0, and at least one of your non-under-construction unmarked structures within
**manhattan 5** — it deletes the closest.

## 8.11 Automation detection

There is **no behavioural anti-bot system** — no input-timing analysis, no APM
heuristics, no client attestation. What exists:

1. **Cloudflare Turnstile at join** — the real gate. Single-use token, never
   retried; failures fail open with a locally censored name.
2. The rate limits in `07-action-api.md §7.5`.
3. **Max 3 concurrent clients per IP** on public games outside Dev; in prod a
   second socket with the same `persistentID` **evicts the first**.
4. `MultiTabDetector` — a `localStorage` lock, purely client-side, an
   anti-multibox nuisance rather than a control.
5. **Player reporting** (`botting`, `teaming`, `inappropriate_username`,
   `griefing`) rides the archived record to human moderation. This is the real
   path by which a visibly-automated player gets actioned.
6. Name screening, and an admin-bot API that is explicitly **forbidden from
   sending gameplay intents**.

Practical read: an agent that respects the rate limits, plays one account per
socket and passes Turnstile is not detected mechanically. The exposure is social.
