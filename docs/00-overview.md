# 00 — Overview: the machine you are playing

> Audience: an autonomous agent. Everything here is derived from source at commit
> `22722df` (2026-09-24). Numbers without a citation are wrong; distrust them.
> Sections marked **[DERIVED]** are reasoning, not code.

## 0.1 The thirty-second model

OpenFront is a **deterministic lockstep territorial RTS**. The server runs **no
simulation at all**. It batches intents into numbered turns and broadcasts them;
every client runs an identical `GameImpl` and arrives at identical state.

| Fact | Value | Source |
|---|---|---|
| Tick length | **100 ms** → 10 ticks/s | `Config.ts:367` |
| Turn ↔ tick | 1:1. Turn *N* executes as tick *N* | `GameRunner.ts:200` |
| Fog of war | **None.** Zero hits for `fog` in `src/`. Every client holds full state | — |
| Wire format | zbin positional binary, no version byte | `ZbinWire.ts:1-20` |
| Version gate | client `gitCommit` must equal the server's, **or be the literal `"desktop"`**, or join is refused | `Worker.ts:535-558` |
| Intent budget | **10/s, 150/min, ≤2 KB each, ≤5 MB per game** | `ClientMsgRateLimiter.ts:4-12` |

You win by **holding 80% of non-fallout land** (or leading when a timer expires).
Everything else is instrumental to that.

## 0.2 The four resources

There are only four quantities you manage. Note what is *absent*.

| Quantity | Type | Grows by | Spent on |
|---|---|---|---|
| **Territory** (tiles) | int | attacking | raises `maxTroops`; hosts structures; **is the win condition** |
| **Troops** | bigint | passive logistic regrowth | attacks, boats, donations |
| **Gold** | bigint | flat 100/tick + trade + trains + conquest | structures, warships, nukes |
| **Relations** | float per-pair, [-100,100] | diplomacy events | AI behaviour only |

> **There is no population and no worker/troop split in this fork.** `maxPopulation`,
> `populationIncreaseRate`, `targetTroopRatio` and `troopAdjustmentRate` do not exist
> anywhere in the repo. If you know upstream OpenFront, unlearn that model. The
> variable `goldFromWorkers` at `PlayerExecution.ts:99` is a vestigial name for a
> flat constant.

> **Territory does not produce gold.** `goldAdditionRate` is a flat `100n` per tick
> (`50n` for bots), independent of tiles, troops and structures (`Config.ts:1092-1101`).
> A 50-tile player and a 100,000-tile player have identical passive income. This is
> the single most counterintuitive fact in the game.

## 0.3 The causal graph

```
                 ┌──────────────── +250,000 per city LEVEL ──────────────┐
                 │                                                        │
  tiles ──(2000·n^0.6 + 100,000)──► maxTroops ──(logistic)──► troops ──┐  │
    ▲                                                                  │  │
    │                                                                  │  │
    └──────────────────── attack ◄─────────────────────────────────────┘  │
    ·                                                                     │
    · (no edge: tiles → gold)                                             │
                                                                          │
  gold ──┬── City ────────────────────────────────────────────────────────┘
         ├── Port ──► trade ships ──► gold      (needs coast + foreign port)
         ├── Factory ──► trains ──► gold        (needs City/Port within 110)
         ├── Missile Silo ──► nukes ──► denial
         └── conquest ──► gold                  (one-shot, on kill)
    ▲
    └── flat 100/tick, forever, regardless of anything
```

Read that missing edge carefully. **Conquest is not an economic strategy.** It buys
`maxTroops` headroom, structure real estate, coastline, and the win condition —
but not income, except the one-shot gold drop when you finish a player.

## 0.4 Phases of a game

| Phase | Ticks | What is possible |
|---|---|---|
| **Spawn phase** | 0 → 100 (SP) / 150 (random spawn) / **200** (default) | Only `spawn` intents. **No gold accrues, no troops grow** — `PlayerExecution.activeDuringSpawnPhase()` is `false` (`PlayerExecution.ts:44`) |
| **Immunity** | +50 ticks after spawn phase | Humans cannot attack you; **Nations and Bots can** (`PlayerImpl.ts:1917-1926`). No nukes buildable (`PlayerImpl.ts:1627`) |
| **Land grab** | ~200 → ~1,500 | Terra nullius is nearly free. Troops refill in ~500 ticks. Gold accumulates toward the first 125,000 structure |
| **Economy** | ~1,250 onward | First Port (if coastal) multiplies income ~13×. Cities begin to matter |
| **Attrition** | mid | PvP attacks burn stacks completely. Defense posts, warships, first nukes |
| **Endgame** | to 80% land, or timer | MIRVs, doomsday clock (if enabled), hard finish at 170 min |

## 0.5 Time constants worth memorising

| Thing | Ticks | Seconds |
|---|---|---|
| Tick | 1 | 0.1 |
| Spawn immunity | 50 | 5 |
| Spawn phase (default) | 200 | 20 |
| Emoji cooldown / display | 50 | 5 |
| Donation cooldown (per recipient) | 100 | 10 |
| Retreat delay before the 25% tax | 20 | 2 |
| Target duration / cooldown | 100 / 150 | 10 / 15 |
| Traitor duration | 300 | 30 |
| Delete-unit cooldown & mark delay | 300 | 30 |
| Alliance request expiry | 200 | 20 |
| Alliance request cooldown | 300 | 30 |
| Silo & SAM reload | 90 | 9 |
| Alliance duration (default) | 3,000 | 300 (5 min) |
| Temporary embargo | 3,000 | 300 |
| Hard game end | 102,000 | 10,200 (170 min) |

## 0.6 What this guide covers

| File | Subsystem |
|---|---|
| `01-spawn-and-map.md` | Tile encoding, terrain, map roster, pathfinding, spawn selection |
| `02-territory-and-combat.md` | Attack math, borders, retreat, amphibious assault, defense posts |
| `03-economy.md` | Troops, gold, trade ships, trains, cost ladders, donations |
| `04-units-and-structures.md` | Complete buildable catalog, upgrades, veterancy, warships |
| `05-strategic-weapons.md` | Nukes, fallout, MIRV, SAM interception |
| `06-diplomacy-and-ai.md` | Alliances, betrayal, relations, embargoes, teams, the AI's decision tree |
| `07-action-api.md` | Every intent schema, tick ordering, observation stream, netcode, win conditions |
| `08-running-headless.md` | Verified recipes for driving the sim without a browser |
| `09-playbook.md` | **[DERIVED]** Opening to endgame, exploits, decision heuristics |
| `99-quirks-and-traps.md` | Dead code, bugs, fork divergences, things that will mislead you |
