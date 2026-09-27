# 99 — Quirks, dead code and traps

Everything here was found by reading this checkout. It is the list of things that
will mislead an agent built from intuition, from upstream docs, or from the
repo's own comments.

## 99.1 Fork divergences from upstream OpenFront

| Divergence                                                                                                                                                                          | Consequence                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **No population / worker system.** `maxPopulation`, `populationIncreaseRate`, `targetTroopRatio`, `troopAdjustmentRate`, `player.population()`, `player.workers()` **do not exist** | Any strategy built on the worker/troop split is meaningless here                                         |
| `goldAdditionRate` is a **flat constant**, not worker-derived                                                                                                                       | Territory produces no gold. The variable `goldFromWorkers` (`PlayerExecution.ts:99`) is a vestigial name |
| One `Config.ts`, no `DefaultConfig`/`DevConfig`/`PreprodConfig` split                                                                                                               | —                                                                                                        |
| Alliance duration is host-configurable (1–15 min; `0` disables alliances)                                                                                                           | —                                                                                                        |
| Nation AI split into 7 behaviour modules + shared `AiAttackBehavior`                                                                                                                | Bots ("tribes") use only `AiAttackBehavior`                                                              |
| **zbin positional binary wire**, no version byte                                                                                                                                    | An agent written against upstream docs will mis-parse frames                                             |
| Hard `gitCommit` equality gate at join                                                                                                                                              | A stale client is refused outright                                                                       |
| Doomsday Clock, Overtime, `hostCheats`, `trusted`, allowlists, `anonymizeNames`, `rankedType`, `publicGameModifiers`, tribes, spectator mode, lobby listing                         | All fork additions                                                                                       |
| `WinCheckExecution.HARD_TIME_LIMIT_SECONDS = 10,200`                                                                                                                                | Fork-specific forced finish                                                                              |

## 99.2 Documentation that is wrong

| Claim                                                                                                      | Reality                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GameMap.ts:129-132` and `map-generator/README.md:91`: "nuke trajectories cannot cross impassable terrain" | **False.** `tests/ImpassableTerrain.test.ts:324-336` asserts a nuke flies over and detonates. No trajectory-blocking code exists |
| `Config.ts:363-364`: `falloutDefenseModifier` range is `[5, 2.5]`                                          | The formula `5 - r*2` gives **`[3, 5]`**                                                                                         |
| `GameImpl.ts:127`: `packedPlayerUpdates` described as `[smallID, tilesOwned, gold, troops] quads`          | It is **5 lanes**: `[smallID, tilesOwned, gold, troops, goldEarned]`. `GameUpdates.ts:38-47` has it right                        |
| `Config.traitorSpeedDebuff()` (the name)                                                                   | 0.8 multiplies `tickFraction`, so attacks _against_ a traitor go **faster**                                                      |
| `src/client/render/CLAUDE.md` references `src/client/graphics/`                                            | That directory does not exist; it is `src/client/hud/`. The pass list is also stale                                              |
| `package.json` engines: `node >=24.15.0`                                                                   | node 22 runs the full suite green; `engine-strict=true` makes this a hard install failure                                        |

## 99.3 Dead code — present, plausible, never executed

| Thing                                                                                                                                  | Status                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Defense posts never fire.** `DefensePostExecution.shoot()` has no live caller; the ship-targeting block is commented out (`:64-106`) | `defensePostShellAttackRate() = 100` and `defensePostTargettingRange() = 75` are unreachable config |
| **SAM interception has no random roll.** `SAMLauncherExecution` constructs a `PseudoRandom` and never reads it                         | Interception is fully deterministic                                                                 |
| `GameMap.hasDefenseBonus` / `setDefenseBonus` (state bit 14)                                                                           | Allocated, snapshotted, rendered — **never set by the simulation**                                  |
| `GameMap.cost(ref)`                                                                                                                    | Proxied by `GameImpl` and `GameView`, **no callers**. Pathfinding uses its own costs                |
| `src/core/game/TerrainSearchMap.ts` (65 lines)                                                                                         | **Zero references** anywhere in `src/` or `tests/`                                                  |
| `Player.expiredAlliances()`                                                                                                            | Declared, returned, snapshotted — **nothing ever pushes to it**. Always `[]`                        |
| `decreaseLevel()`                                                                                                                      | Implemented, **no caller in `src/core`**. Partial demolition never happens                          |
| `warshipShellLifetime()` = 20                                                                                                          | Unused; shells use `shellLifetime()` = 50                                                           |
| `PathFinding.WaterSimple`                                                                                                              | A no-op alias for `PathFinding.Water`                                                               |
| `UpgradeStructureExecution.cost`                                                                                                       | Declared, never assigned. The real charge is in `PlayerImpl.upgradeUnit`                            |
| `GameUpdateType.Tile`                                                                                                                  | In the enum, **never emitted** — tiles travel in `packedTileUpdates`                                |
| `upgrade_structure.unit`                                                                                                               | Accepted by the schema, **ignored** by the executor                                                 |

## 99.4 Traps that will cost you a game

### `ExecutionManager` throws on three intent types

`kick_player`, `update_game_config` and `toggle_game_start_timer` have no case in
`createExec` and fall to `default: throw`. Over the network this is unreachable
(the server returns before queueing them). **But `LocalServer` — singleplayer and
replays — queues every non-pause intent unconditionally, and `createExecs` runs
outside `GameRunner.executeNextTick`'s try/catch.** The exception escapes the
worker drain loop. **Never emit those three when driving `LocalServer`.**

### Spawn phase never ends in Singleplayer without a human spawn

`SpawnTimerExecution` is added only when `gameType !== Singleplayer`. In a
headless harness, use `GameType.Private`, or call `game.endSpawnPhase()` yourself.

### With random spawn off, a human who never spawns is never placed

There is no end-of-phase fallback anywhere.

### Clicking impassable terrain "works"

The client gate uses `isLand`, which is **true for impassable tiles**. The click
passes, the server filters the 52-tile disc, and you end up owning only the valid
subset while `player.setSpawnTile()` records a tile you do not own — and that tile
is what every later min-distance check reads.

### `attackRatio` is a fraction, except once

`GameRenderer.ts:62` seeds `uiState.attackRatio = 20` — a _percent_. It is
overwritten by `ControlPanel.init()`, but an intent emitted before that would
request `20 × troops`.

### `game.players()` excludes dead players

It returns **0** before anyone spawns. Use `game.allPlayers()` for the roster.

### `PlayerUpdate` is a diff

Only `type` and `id` are guaranteed. **Merge, never overwrite.**

### A new land attack destroys your own beachhead

The merge check inspects **your** new attack's `sourceTile`, not the victim's. A
land attack against a target where you have a boat beachhead absorbs it and throws
away its frontier.

### A boat arriving on a tile you now own loses 25%

`TransportShipExecution` keys the "return" branch on `owner(dst) === attacker`. If
you captured the landing tile by land while the boat was in flight, a normal
outbound trip is taxed as a retreat.

### Extending an alliance early truncates it

`extend()` sets `expiresAt = ticks() + duration`, not `expiresAt + duration`.

### Attacks all share one PRNG seed

`new PseudoRandom(123)` is hardcoded per `AttackExecution`. Tile-order jitter is
identical for every attack in every game.

### `GameStartInfo.players` order is a simulation input

Player ids are assigned by consuming `random.nextID()` in array order. Reordering
desyncs.

### `move_warship` silently skips ships in the wrong water component

No error, no feedback. Check components yourself.

### There is no gold refund, anywhere

Not for deleting, not for losing a structure, not for a build cancelled by capture
(the captor finishes it and keeps it).

### Nation team assignment can bypass balancing

`NationExecution.init` calls `addPlayer` with no team, falling through to
`playerTeams[simpleHash(id) % n]` instead of `assignTeams`. Affects HvN and
dynamic-nation games.

## 99.5 Behaviour that is correct but counterintuitive

| Behaviour                                                               | Why                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| The 0.7× bot-defender discount **does not apply to bot attackers**      | Golden values confirm bot-vs-bot and bot-vs-human are baseline                                                           |
| Spawn immunity binds **only humans**                                    | Nations and bots attack through it                                                                                       |
| Nuking a formal **ally** is allowed; nuking a **teammate** is not       | Only the team check exists in `nukeSpawn`                                                                                |
| Teammates get **no** train bonus; allies get 35,000 vs 25,000           | `rel` classification treats `team` and `other` identically                                                               |
| One-sided embargoes block trade **both ways**                           | `canTrade` checks both directions                                                                                        |
| Ports and Factories **share one cost ladder**                           | `costWrapper` sums both types                                                                                            |
| Conquering **clears fallout**                                           | `GameImpl.conquer` calls `setFallout(tile, false)`                                                                       |
| Defense posts are **destroyed** on capture, everything else is captured | Explicit special case in `PlayerExecution`                                                                               |
| Warship **veterancy survives capture**                                  | It lives in `warshipState`, untouched by `setOwner`                                                                      |
| Water paths can cross 1-tile land barriers                              | The 2×2 minimap downsample lets water win. The repo has a `describe("Known bugs")` block for it                          |
| Rail paths are minimap-quantised too                                    | Easy to miss                                                                                                             |
| Trade ships hugging the coast are near-unpiratable                      | `safeFromPirates` refreshes on every shoreline water tile                                                                |
| Port **levels** are superlinear in trade output                         | The pity counter increments once per failed roll, so a level-3 port's counter climbs 3× faster. Undocumented in the code |

## 99.6 Open questions I did not resolve

1. **Alliance acceptance is asymmetric.** The `+100` relation, the temporary-
   embargo clearing and the in-flight nuke cancellation live only in the
   _counter-request_ path (`src/core/execution/alliance/AllianceRequestExecution.ts:45-65`). A plain accept via
   `AllianceRequestImpl.accept()` gets none of it. Whether the client's accept
   button routes through an `AllianceRequestExecution` was not traced. **Treat as
   unverified.**
2. `AttackExecution.ts:302-306` calls `refreshToConquer()` immediately before
   `retreat()`, which deletes the attack. Appears vestigial.
3. `AttackExecution.ts:239-244` — the `removeTroops === false && sourceTile ===
null` refund branch is unreachable with current callers.
4. `NationExecution.handleEmbargoesToHostileNations` branch 3 is shadowed by
   branch 2 for Easy/Medium, so it only ever fires for Hard.
5. `TribeExecution.maybeAttack`'s alliance-break branch is near-unreachable — the
   traitor filter already excludes friendlies.
6. **Nuke warning time is not a constant.** It is arc length ÷ speed plus per-silo
   `waitTicks`. No fixed warning value exists anywhere.
7. `sentDonations` is an append-only array scanned linearly by every
   `canDonate*` call and never pruned — correct, but O(donations ever sent).
