# 07 — The action API, tick loop and netcode

This is the chapter you emit commands from.

## 7.1 The envelope

```ts
ClientIntentMessageSchema = z.object({
  // Schemas.ts:1159
  type: z.literal("intent"),
  intent: IntentSchema, // discriminated union on "type"
});
```

**The client never sends `clientID`.** The server stamps it from the
authenticated socket (`GameServer.ts:337`):

```ts
StampedIntent = Intent & { clientID: ClientID }; // Schemas.ts:817-820
```

`MappedID` is a dictionary-encoded clientID matching `/^[A-Za-z0-9]{8,10}$/`. The
dictionary is seeded on both peers from `GameStartInfo.players` **in array
order**, so that order is part of the simulation contract.

Numeric primitives: `zb.uint` = varint, `zb.int` = zigzag varint, `zb.float` =
bit-exact float64 (8 bytes, fractions allowed).

## 7.2 Complete intent catalog

25 types. **22** map to an Execution; **3** are server-only control intents that
never enter the turn log.

### Gameplay intents

| `type`              | Schema                                                                              | Notes and preconditions                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attack`            | `{ targetID: MappedID \| null, troops: float(min 0) \| null }`                      | **`targetID: null` means attack TerraNullius.** `troops: null` falls back to `troops/5` (human) or `/20` (bot). Clamped to your troops; the actual **floored deducted** amount is used |
| `cancel_attack`     | `{ attackID: string }`                                                              | `attackID` comes from `AttackUpdate.id` in `PlayerUpdate.outgoingAttacks`. Retreat completes 20 ticks later. **Unbounded string** — only the 2 KB frame cap limits it                  |
| `boat`              | `{ troops: float(min 0) /*required*/, dst: uint }`                                  | Fails silently and deterministically if: 3 boats already in flight, target is your own tile, `!canAttackPlayer`, no landing tile, or no launch port                                    |
| `cancel_boat`       | `{ unitID: uint }`                                                                  | Must be one of your own outgoing boats                                                                                                                                                 |
| `move_warship`      | `{ unitIds: int[] (nonempty), tile: uint }`                                         | ⚠️ **no max array length**. Each warship must exist, be active, and **share a water component with the target** — others are silently skipped                                          |
| `spawn`             | `{ tile: uint }`                                                                    | Must be _queued during_ the spawn phase. Under `randomSpawn`, no re-rolls                                                                                                              |
| `build_unit`        | `{ unit: UnitType, tile: uint, rocketDirectionUp?: boolean, amount?: uint(1..50) }` | Rejected if the unit is disabled, the tile is invalid, no legal spawn tile exists, or gold is insufficient                                                                             |
| `upgrade_structure` | `{ unit: UnitType, unitId: uint, amount?: uint(1..50) }`                            | ⚠️ **`unit` is accepted and then ignored** by the executor. The structure must be yours                                                                                                |
| `delete_unit`       | `{ unitId: uint }`                                                                  | Yours, active, on land, on your own territory, not in the spawn phase, past the 300-tick cooldown                                                                                      |
| `allianceRequest`   | `{ recipient: MappedID }`                                                           | See `06-diplomacy-and-ai.md §6.1`                                                                                                                                                      |
| `allianceReject`    | `{ requestor: MappedID }`                                                           | **No relation penalty for rejecting**                                                                                                                                                  |
| `allianceExtension` | `{ recipient: MappedID }`                                                           |                                                                                                                                                                                        |
| `breakAlliance`     | `{ recipient: MappedID }`                                                           | Marks you a traitor for 300 ticks                                                                                                                                                      |
| `targetPlayer`      | `{ target: MappedID }`                                                              | Not self, not friendly, 150-tick cooldown. **−40 relation.** Lasts 100 ticks                                                                                                           |
| `emoji`             | `{ recipient: MappedID \| "AllPlayers", emoji: uint(0..59) }`                       | 12 rows × 5 = 60 entries, so **max index 59**. 50-tick cooldown per recipient                                                                                                          |
| `quick_chat`        | `{ recipient: MappedID, quickChatKey: string, target?: MappedID }`                  | `"<category>.<key>"` from `resources/QuickChat.json`. **No mechanical effect**                                                                                                         |
| `donate_gold`       | `{ recipient: MappedID, gold: float(min 0) \| null }`                               | Requires `isFriendly`. 100-tick cooldown per recipient. `null` → `gold/3`                                                                                                              |
| `donate_troops`     | `{ recipient: MappedID, troops: float(min 0) \| null }`                             | Same gate. Capped at the recipient's headroom                                                                                                                                          |
| `embargo`           | `{ targetID: MappedID, action: "start" \| "stop" }`                                 | Always permanent                                                                                                                                                                       |
| `embargo_all`       | `{ action: "start" \| "stop" }`                                                     | 100-tick cooldown; skips self, bots and teammates                                                                                                                                      |
| `toggle_pause`      | `{ paused: boolean }` (`.default(false)`)                                           | Lobby creator or admin only; refused on listed games                                                                                                                                   |
| `mark_disconnected` | `{ isDisconnected: boolean }`                                                       | **Server-internal.** A client sending it is rejected 400                                                                                                                               |

### Control intents (never simulated)

| `type`                    | Schema                                 | Authorization                                                                                 |
| ------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `kick_player`             | `{ targetClientID?, targetPublicID? }` | Lobby creator or admin; **refused on a publicly listed lobby unless admin**; 400 on self-kick |
| `update_game_config`      | `{ config: partial GameConfig }`       | Creator or admin bot; 403 public; 409 started; 409 on listed/host-cheats/whitelist            |
| `toggle_game_start_timer` | `{}`                                   | Creator or admin bot; 403 public; 409 started/queued                                          |

> ⚠️ **`ExecutionManager.createExec` has no case for those three** and falls
> through to `default: throw`. On a real server this is unreachable (the server
> returns before queueing them). **But `LocalServer` — singleplayer and replays —
> pushes every non-pause intent into the turn unconditionally**, and `createExecs`
> is called _outside_ `GameRunner.executeNextTick`'s try/catch. An agent driving
> `LocalServer` directly must never emit those three.

> `ExecutionManager.createExec` also requires `playerByClientID` to resolve;
> otherwise it returns a `NoOpExecution`.

## 7.3 The tick loop

### Server: turn batching

```
setInterval(endTurn, 100ms)
endTurn():
  if paused: return                            // paused = no turn at all
  turns.push({ turnNumber: turns.length, intents })
  intents = []
  handleSynchronization()                      // desync check, every 10 turns
  checkDisconnectedStatus()                    // every 5 turns
  broadcast {type:"turn", turn} to every active client
```

Intents are appended in **socket arrival order**, and that is the deterministic
execution order for the turn.

### `GameImpl.executeNextTick()` — exact ordering (`GameImpl.ts:526-584`)

1. Clear the updates map and tile-update pairs.
2. **Tick every initialized execution** in array order, gated on
   `(!inSpawnPhase || activeDuringSpawnPhase) && isActive()`.
3. **Init pending executions**, same gate. Those that don't init stay queued.
4. `removeInactiveExecutions()` — compacts in place.
5. Append newly-inited executions.
6. Per player: record stats, then `player.toUpdate()`.
7. **Every 10 ticks**: emit `HashUpdate { tick, hash = 1 + Σ player.hash() }`.
8. `waterManager.tick()`.
9. `this._ticks++` — **the increment is last**, so the `tick` field of updates
   emitted this pass is the pre-increment value.

> **Critical latency fact.** An execution created from a turn-_N_ intent is pushed
> to `unInitExecs`; step 2 only ticks _already-initialized_ executions. So its
> first `tick()` is on **tick N+1**. Many one-shot executions do all their work in
> `init()` and report `isActive() === false` — those do take effect on tick N.
> Budget **≥2 ticks (200 ms) plus RTT** for anything that needs a `tick()`.

### Spawn phase

`inSpawnPhase() ⇔ startTick === null`.

- Multiplayer: `SpawnTimerExecution` ends it when `ticks() > numSpawnPhaseTurns()`.
- Singleplayer: there is **no timer**; `SpawnExecution.tick` ends the phase as
  soon as a Human spawns. **If a singleplayer human never spawns, the spawn phase
  never ends.**
- `randomSpawn`: spawns are pre-queued per human.

Executions **disabled** during the spawn phase include `AttackExecution`,
`TransportShipExecution`, `ConstructionExecution`, `RetreatExecution`,
`DeleteUnitExecution`, `WinCheckExecution` and everything economic. Active:
`SpawnExecution`, `SpawnTimerExecution`, `PauseExecution`.

## 7.4 Observation

### Per-tick payload

```ts
interface GameUpdateViewData {
  // GameUpdates.ts:21-76
  tick: number;
  updates: GameUpdates; // Record<GameUpdateType, Update[]>
  packedTileUpdates: Uint32Array; // [tileRef, (state & 0xffff) | (terrain << 16)] pairs
  packedMotionPlans?: Uint32Array;
  packedPlayerUpdates?: Float64Array; // QUINTS: [smallID, tilesOwned, gold, troops, goldEarned]
  packedAttackUpdates?: Float64Array; // quads: [ownerSmallID, direction(0=out,1=in), index, troops]
  playerNameViewData?: Record<string, NameViewData>;
  tickExecutionDuration?: number;
  pendingTurns?: number;
  packedNukeImpacts?: Uint32Array;
}
```

### `GameUpdateType` values

`Tile` (**never emitted** — tiles go via `packedTileUpdates`), `Unit`, `Player`,
`DisplayEvent`, `DisplayChatEvent`, `AllianceRequest`, `AllianceRequestReply`,
`BrokeAlliance`, `AllianceExpired`, `AllianceExtension`, `TargetPlayer`, `Emoji`,
`Win`, `Hash`, `UnitIncoming`, `BonusEvent`, `RailroadDestructionEvent`,
`RailroadConstructionEvent`, `RailroadSnapEvent`, `ConquestEvent`, `EmbargoEvent`,
`SpawnPhaseEnd`, `GamePaused`, `DonateEvent`.

### The ones that matter

- **`PlayerUpdate` is a diff.** Only `type` and `id` are guaranteed; every other
  field is omitted when unchanged. **Consumers must merge, not overwrite.** Hot
  numeric fields (`tilesOwned`, `gold`, `troops`, `goldEarned`) normally arrive via
  `packedPlayerUpdates` instead.
- **`UnitUpdate`** — full per-unit state: `id`, `ownerID` (smallID), `pos`,
  `lastPos`, `isActive`, `troops`, `health`, `level`, `underConstruction`,
  `markedForDeletion`, `warshipState`/`transportShipState`/`nukeState`,
  `targetTile`, `targetUnitId`, `missileTimerQueue`, `samUpgrade`. **Suppressed
  for plan-driven (path-interpolated) units.**
- **`AttackUpdate`** — `{ attackerID, targetID, troops, id, retreating }`. `id` is
  what `cancel_attack` takes.
- **`HashUpdate`** — every 10 ticks; the client must echo it back.

### Reconstructing state

The reference implementation is `GameView.update()` (`GameView.ts:280+`):
apply packed tile updates → nuke impacts and motion plans → `SpawnPhaseEnd` and
`Win` → name data → **two passes** over `updates[Player]` (all smallIDs must be
registered before embargo PlayerIDs can be translated).

`ticks()` = `lastUpdate.tick`; `inSpawnPhase()` = `startTick === null`.

### The legality oracle

Synchronous RPCs to the worker: `player_actions`, `player_buildables`,
`player_profile`, `player_border_tiles`, `attack_clustered_positions`,
`transport_ship_spawn`, `snapshot`.

**`playerActions(playerID, x, y, units)` is the canonical "what may I legally do
here" oracle.** It returns `canAttack`, `buildableUnits[]`,
`canSendEmojiAllPlayers`, `canEmbargoAll`, plus an `interaction` block with
`sharedBorder`, `canSendEmoji`, `canTarget`, `canSendAllianceRequest`,
`canBreakAlliance`, `canDonateGold`, `canDonateTroops`, `canEmbargo` and
`allianceInfo`. Use it rather than reimplementing the precondition logic.

> **There is no fog of war.** Zero hits for `fog` across `src/`. Every client
> holds complete authoritative state. The only hidden things are display-only
> (name anonymization) and PII.

## 7.5 Connection lifecycle

### Client → server messages

| type                                                | Schema                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `join`                                              | `{ token, gameID, username, clanTag, cosmetics?, turnstileToken, spectator?, gitCommit?, platform? }` |
| `rejoin`                                            | `{ gameID, lastTurn: uint, token, gitCommit? }`                                                       |
| `intent`                                            | `{ intent }`                                                                                          |
| `ping`                                              | `{ sentAt: uint }`                                                                                    |
| `hash`                                              | `{ hash: float, turnNumber: uint }`                                                                   |
| `winner`, `live_stats`, `spectate`, `report`, `log` | —                                                                                                     |

Constraints: username 3–27 chars over `[ _.\-a-zA-Z0-9À-ÿ]` with ≥1 non-space;
clan tag `/^[a-zA-Z0-9]{2,5}$/`; `gameID` `/^[A-Za-z0-9]{8,10}$/`.

### Server → client messages

`lobby_info` (broadcast **every 1 s** while in lobby), `prestart` (~2 s before
start), `start` (turns + `GameStartInfo`), `turn` (every 100 ms), `desync`,
`error`, `new_lobby`, `pong`, `ping`.

### Join sequence

1. Open `wss://<host>/w<N>` where `N = simpleHash(gameID) % numWorkers`. Frames
   are `arrayBuffer` zbin.
2. Send `join` or `rejoin`. **Before join, only `ping`/`join`/`rejoin` are
   accepted; anything else is dropped.**
3. Worker checks: correct worker (else close `4007`), then **`gitCommit` must
   equal the server's** — or be the literal string `"desktop"`, which bypasses the
   gate (`Worker.ts:536-537`) — else `error: "version_mismatch"`.
4. Turnstile / account verification, allowlist, trust gate.
5. `joinClient`: allowlist, trust gate, late-join rules, lobby cap, **max 3
   concurrent clients per IP on public games outside Dev**, prod duplicate-
   persistentID eviction.
6. `lobby_info` every second until start.
7. `prestart`, then **2,000 ms later** `start`, which freezes the roster into
   `GameStartInfo` and starts the 100 ms turn interval.
8. Spawn phase. Send your `spawn` intent inside it.

**Late join**: a reconnect keeps its seat; a non-spectator within
`LATE_JOIN_GRACE_MS = 5000` gets `error: "game-started"`; anyone later is
silently converted to a **spectator**.

### Client behaviour worth copying

- On connect the in-game client sends **`rejoin(turnsSeen)`**, not `join`.
- `start` backfills: turns below `turnsSeen` are skipped, gaps are filled with
  synthetic empty turns.
- `turn` messages assert `turnsSeen === turn.turnNumber`, else log and **drop**.
- Ping every 5,000 ms. Silence watchdog: after a 20 s warm-up, reconnect if no
  server message for >5,000 ms.
- Reconnect budget: 10 attempts, `min(15000, 1000 × 2^(n-2))` with ±25% jitter,
  ~68–113 s total.
- Terminal closes (no retry): `1000`, `1002`, or any `4000-4999`.

### Close codes

`1000` Normal, `1002` ProtocolError, `1011` InternalError, `1013` TryAgainLater,
`4000` BadRequest, `4001` Unauthorized, `4002` Forbidden, `4003` Banned,
`4004` GameNotFound, `4005` GameClosed, `4006` LobbyFull, `4007` WrongWorker,
`4008` GameStarted, `4100` RankedLimitReached, `4101` InvalidClan,
`4102` ClanVerificationFailed.

### Rate limits — hard numbers

| Constant             | Value                                    | Effect on breach            |
| -------------------- | ---------------------------------------- | --------------------------- |
| `INTENTS_PER_SECOND` | **10**                                   | intent **silently dropped** |
| `INTENTS_PER_MINUTE` | **150**                                  | silently dropped            |
| `MAX_INTENT_SIZE`    | **2,000 bytes**                          | **kick**                    |
| `REJOINS_PER_MINUTE` | 5                                        | dropped                     |
| `TOTAL_BYTES`        | **5 MiB** cumulative per client per game | **kick**                    |
| HTTP API             | 20 req/IP/s                              | —                           |

**Non-intent messages (`ping`, `hash`, `winner`, `live_stats`, `spectate`,
`report`) have no per-count limit** — only the 5 MiB cap.

Practical ceiling: **10 intents/s, 150/min**. At 150/min over a 3 h maximum you
get ~27,000 intents, well inside the byte cap.

A **malformed** frame is a kick, not a drop.

### Disconnect handling

No ping for 30,000 ms → marked disconnected via an injected `mark_disconnected`
intent. No ping for 60,000 ms → socket closed with `1013`, but the roster keeps
the reconnect mapping. `maxGameDuration = 3 h`; `emptyGameTimeout = 10 min`.

## 7.6 Game modes and lobby options

| Enum          | Values                                      |
| ------------- | ------------------------------------------- |
| `GameType`    | `Singleplayer` / `Public` / `Private`       |
| `GameMode`    | `FFA` / `Team`                              |
| `RankedType`  | `OneVOne` (`"1v1"`) / `TwoVTwo` (`"2v2"`)   |
| `Difficulty`  | `Easy` / `Medium` / `Hard` / `Impossible`   |
| `GameMapSize` | `Compact` / `Normal`                        |
| `PlayerType`  | `Bot` / `Human` / `Nation`                  |
| Team presets  | `Duos`, `Trios`, `Quads`, `HumansVsNations` |

### `GameConfigSchema` — every field

```ts
{
  gameMap, difficulty, gameType, gameMode, gameMapSize      // required
  donateGold: boolean, donateTroops: boolean                // required; gate HUMAN recipients only
  nations: uint(1..400) | "default" | "disabled"            // required
  bots: uint(max 400)                                       // required
  infiniteGold, infiniteTroops, instantBuild: boolean       // required
  randomSpawn: boolean                                      // required
  rankedType?, doomsdayClock?: {enabled?, speed?}
  overtime?: { enabled?, startMinutes?: uint(1..120) }
  publicGameModifiers?: { isCompact?, isRandomSpawn?, isCrowded?, isHardNations?,
      startingGold?, goldMultiplier?: float(0.1..1000),
      isAlliancesDisabled?, isPortsDisabled?, isNukesDisabled?, isSAMsDisabled?,
      isPeaceTime?, isWaterNukes?, isDoomsdayClock? }
  disableNavMesh?, disableAlliances?, disableClanTags?, liveStatsEnabled?
  anonymizeNames?, nameReveals?, nameRevealPublicIds?, waterNukes?
  maxPlayers?, allowedPublicIds?, trusted?
  maxTimerValue?: uint(1..120) | null                       // MINUTES
  customAllianceDuration?: uint(max 15) | null              // MINUTES; 0 DISABLES alliances
  startDelay?: uint(max 600) | null                         // SECONDS
  spawnImmunityDuration?: uint | null                       // TICKS
  disabledUnits?: UnitType[]
  playerTeams?: uint | "Duos" | "Trios" | "Quads" | "Humans Vs Nations"
  goldMultiplier?, startingGold?
  hostCheats?: { infiniteGold?, infiniteTroops?, goldMultiplier?, startingGold? }
}
```

`hostCheats` apply **only** to the lobby creator and block public listing.

## 7.7 Win conditions

`WinCheckExecution` runs **only when `ticks % 10 === 0`** (once per second), and
only after the spawn phase.

### The threshold predicate

Returns true if **any** of:

1. `maxTimerValue` is set and `elapsedGameSeconds >= maxTimerValue * 60` — the
   leader wins.
2. `elapsedGameSeconds >= 10,200` (**170 minutes**) — a hard forced finish 10
   minutes before the server's 3 h kill.
3. `tilesOwned * 100 > (numLandTiles - numTilesWithFallout) * percentageTilesOwnedToWin`
   — exact integer cross-multiplication, **strict `>`**, and the denominator
   **excludes fallout tiles**.

`percentageTilesOwnedToWin` is **80 in every mode**. With `overtime.enabled`, it
drops by **2 points per minute** after `startMinutes` (default 30), floored at 0 —
so a stalled game always ends.

> Nuking neutral land _lowers the denominator_, making the 80% threshold easier to
> reach for whoever holds the most remaining land. **[DERIVED]**

### FFA

Sort alive players by tiles descending, take the leader, apply the predicate.
Ranked 1v1 additionally ends the moment only one alive connected human remains.
**Nations and bots can win FFA.**

### Team

Sum tiles per team over alive players; the top team wins if the predicate holds —
**except the Bot team, which can never win**. Ranked 2v2 additionally ends when
only one team has a connected alive human.

Team winner roster: a player is listed if their clientID is non-null and they have
spawned, and either they are still connected, or their disconnect snapshot shows
their team held ≥**70%** of the land at that moment.

### Ties

**There is no tie resolution.** The winner is `sorted[0]` after a plain descending
sort over `players()` (insertion order). Deterministic across clients, but
arbitrary.

### From `WinUpdate` to an archived game

The server has no simulation, so the **winner is settled by an IP-weighted vote
among clients**. Each client emits its `WinUpdate` result; desynced and kicked
clients are ignored; a candidate wins on `votes * 2 > totalUniqueIPs` — a **strict**
majority of unique IPs, so in a 1v1 **both players must agree**. The tally is
re-run whenever the electorate shrinks, so you cannot vote for yourself and
disconnect.

### The Doomsday Clock (opt-in anti-stall)

Each side must hold a rising share of the map. The bar rises in waves after a
**600 s grace**, up to **35%**, reaching the ceiling at `normal` **35:00**,
`slow` **45:00**, `fast` **25:00**, `veryfast` **15:00**
(`DoomsdayClock.ts:63-93`). A side below the bar is skulled, bleeds troops
after a 30 s warning down to a decaying floor, and after **150 s** its territory
has fully rotted away — eliminated. Warships under it cannot heal and never
retreat, bleeding 1%→50% max HP per second.

## 7.8 Determinism, PRNG and replays

### Seeding — everything derives from `gameID`

| Seed                                             | Consumer                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `simpleHash(gameID)`                             | the master random that assigns `PlayerInfo.id` per human, then nation creation |
| `simpleHash(gameID) + 1`                         | `Executor.random`                                                              |
| `simpleHash(gameID) + 2`                         | `TribeSpawner`                                                                 |
| `simpleHash(playerInfo.id) + simpleHash(gameID)` | each `SpawnExecution`                                                          |
| **hardcoded `123`**                              | **every `AttackExecution`**                                                    |

The PRNG is **sfc32**, all 32-bit integer ops, seed expanded through splitmix32
with 12 warm-up calls. `nextInt(min, max)` is **max-exclusive**.
`chance(n) = nextInt(0, n) === 0`.

> **`GameStartInfo.players` array order is part of the simulation contract**, not
> just the wire dictionary. Reordering it desyncs.

### Hash and desync detection

Clients emit `HashUpdate` every 10 ticks and forward it as a `hash` message.
Hashes are **fractional** (they multiply by troops), hence the float wire type.
The server compares the turn **10 back**, requires ≥2 active clients, and takes
the modal hash. A desynced client is notified **once** and its winner and
live-stats votes are ignored thereafter.

### Snapshots

`GameRunner.snapshot()` serializes at a tick boundary and throws if a tick is
mid-execution. Turns added but not executed are **not** part of it.
`createGameRunnerFromSnapshot` restores and **skips `init()`**.

### Replays

Archived records require an **exact `gitCommit` match**. `PlayerRecord` must keep
`teamIndex`, `friends` and `isLobbyCreator` — they are simulation _inputs_.
`toggle_pause` intents are stripped during replay.

### Simulating ahead — the caveats

1. You cannot predict other players' intents; you can only simulate _your_ intents
   against current state.
2. An intent lands in whichever turn is open when the server receives it, and its
   execution `init()`s on that tick and first `tick()`s on the next. **Budget ≥2
   ticks plus RTT.**
3. Turn ordering within a turn is server arrival order — not reproducible
   client-side before the `turn` message arrives.
4. `ticksSinceStart()` is `0` during the spawn phase.
5. `pendingTurns` tells you how far behind the sim is; `isCatchingUp()` is
   `pendingTurns > 1`.
