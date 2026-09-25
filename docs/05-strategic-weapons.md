# 05 — Nukes, fallout, MIRV and air defence

## 5.1 The nuke table

| | Atom Bomb | Hydrogen Bomb | MIRV (carrier) | MIRV Warhead |
|---|---|---|---|---|
| Cost | 750,000 | 5,000,000 | `25M + 15M × global launches` | free |
| Inner radius | **12** | **80** | n/a (never detonates) | **12** |
| Outer radius | **30** | **100** | n/a | **18** |
| Speed | 10 | 10 | 15 | 22 (+0..4) |
| Interceptable | yes | yes | **NO** | yes |
| Breaks alliances | yes | yes | yes (on launch) | **no** |
| Warning message | `NUKE_INBOUND` | `HYDROGEN_BOMB_INBOUND` | `MIRV_INBOUND` | **none** |

`Config.ts:1103-1113` (magnitudes), `:1119-1130` (speeds). The MIRV cost counter
`mirvsLaunched` is **game-global across all players** — every MIRV anyone fires
raises the price for everyone.

## 5.2 Launch preconditions (`PlayerImpl.ts:1625-1675`)

- **Blocked during spawn immunity** (spawn phase + the first 50 ticks).
- Target tile must not be impassable.
- Cannot target a same-team player's territory unless the game is over and it is
  not singleplayer.
- In **Team mode**, an Atom/Hydrogen strike is refused if any *teammate-owned
  structure* lies within the nuke's **outer** radius. **MIRV is exempt.**
- **MIRV additionally requires the target tile to have an owner.**
- Launch platform = your nearest ready silo. No ready silo = no launch.

Nuking a **formal ally** is allowed — only *teammates* are protected. It breaks
the alliance and marks you a traitor.

## 5.3 Flight and the interception window

Nukes fly a cubic Bézier parabola, advancing `speed` units of **arc length** per
tick. Arc height is `max(distance/3, 50)`, so flight time is noticeably longer
than `straightDistance / speed` — short-range nukes are much slower over ground
than the nominal speed suggests.

> **The single most important nuke mechanic**: each trajectory tile is flagged
> `targetable` only if it is within `defaultNukeTargetableRange() = 150` of **the
> target tile** *or* within 150 of **the launch silo** (`NukeExecution.ts:347-385`).
> **A nuke on a long flight is untargetable in the middle of its arc.** SAMs can
> only engage near the launcher or near the impact point.

### Who sees it coming

`displayIncomingUnit` goes to **the owner of the target tile only**. **No alert at
all if the target tile is unowned.** MIRV warheads send no alert. On detonation,
a message goes to every player who lost tiles.

But there is **no fog of war** — the missile is a normal unit in the update
stream, drawn for everyone. "Warning time" in practice is just flight time, which
is not a constant.

## 5.4 Detonation (`NukeExecution.ts:387-515`)

1. **Blast shape** (default path, `NukeExecution.ts:132-139`): BFS from the
   target. Every non-impassable tile with `d² ≤ outer²` is hit if `d² ≤ inner²`
   **or** a 1-in-2 coin flip passes. So: **solid destruction inside `inner`, ~50%
   speckle out to `outer`.** In **`waterNukes` mode the shape is different**
   (`:82-130`): a 16-sample smoothed irregular radius between inner and outer over
   a bounding box — no BFS, no coin flip.
2. Each hit tile is relinquished from its owner.
3. Every hit **land** tile becomes fallout (or, in `waterNukes` mode, is converted
   to **water** next tick if still land, unowned and passable).
4. **Troop kill**: for each affected player, loop once **per impacted tile**, each
   iteration removing `nukeDeathFactor` troops with a diminishing tile count:
   - Atom / Hydrogen: `5 × troops / max(1, tilesOwned)`
   - **MIRV warhead**: `500 × (1 - e^(-2 · max(0, troops - 0.03·maxTroops) / maxTroops))`
     — this drives troops toward **3% of max regardless of territory**.
   - The same factor is applied to every one of that player's **outgoing attacks**
     and to the troop load of **every transport ship they own anywhere on the
     map**, not just those in the blast.
5. **Unit destruction**: every unit of any owner with `d² < outer²` is deleted,
   except other nukes and SAM missiles. Structures, warships, transports, trade
   ships and trains all die. A friendly unit's loss is not credited as a kill.

## 5.5 Fallout

- Created on hit land tiles by a nuke, and also by **Doomsday Clock territory rot**
  when that mode is enabled (`DoomsdayClockExecution.ts:359-360`). `setFallout`
  **throws if the tile has an owner**, so fallout exists only on unowned land.
- **There is no time-based decay anywhere in the codebase.** The only removals are
  conquering the tile (`GameImpl.ts:819`) and converting it to water. Fallout
  persists indefinitely.
- Effect: `falloutRatio = numTilesWithFallout / numLandTiles` is a **global**
  ratio; `falloutDefenseModifier(r) = 5 - 2r`, giving a multiplier in **[3, 5]**
  applied to **both** `mag` and `tileCost`. Attacking across fallout costs 3–5×
  the troops and is 3–5× slower.
- Fallout tiles are skipped when computing border and attack tiles.

> The comment at `Config.ts:363-364` claims the range is `[5, 2.5]`. The formula
> `5 - r*2` gives `[3, 5]`. The comment is wrong.

## 5.6 Alliance breaking

Weighted tile count in the blast — inner weight 1, outer weight 0.5 — against
`nukeAllianceBreakThreshold() = 100`, **or** any allied structure inside the outer
radius. Affected allies have the alliance broken and relation set to −100, and
their pending alliance requests are auto-rejected.

**MIRV warheads never break alliances.** The MIRV *carrier* breaks the alliance
with the target player at launch.

## 5.7 MIRV specifics

| Property | Value |
|---|---|
| Warhead count | **350** |
| Range | 1,500 |
| Minimum spread between warhead targets | 55 manhattan |
| Carrier flight time | normalised to ~14 ticks |

Every warhead target must be land, owned by the **original target player**, within
1,500 of the aim point, and ≥55 from every other chosen target. Targets are
re-validated and topped up at T−10, then sorted farthest-first. Warheads are
instantiated at T−10 with staggered speeds and `waitTicks`, so they arrive spread
out.

The carrier flies to a separation point high above the map. **It cannot be
intercepted** — SAMs only search `[AtomBomb, HydrogenBomb, MIRVWarhead]`.
Destroying the carrier by other means cancels all its warhead executions.

## 5.8 SAM launchers

| Property | Value |
|---|---|
| Cost | `min(3M, (n+1) × 1.5M)` |
| Build time | **300 ticks (30 s)** — the longest in the game |
| Reload | 90 ticks; ready interceptors = level |
| Interceptor speed | 12 tiles/tick, straight line |
| Detection sweep | `maxSamRange × 4 = 600` |

### Range

```
samRange(level) = 150 - 480 / (level + 5)
```

| Level | 1 | 2 | 3 | 4 | 5 | 6 | 10 |
|---|---|---|---|---|---|---|---|
| Range | **70** | 81.4 | 90 | 96.7 | 102 | 106.4 | 118 |

Asymptotically approaches 150 and never reaches it. During an upgrade the
effective range **interpolates linearly** over 45 ticks. A level gained by upgrade
arrives **already on cooldown**.

### Interception is deterministic

> **There is no interception chance.** `SAMLauncherExecution` constructs a
> `PseudoRandom` and **never uses it**. If the targeting system produces a valid
> interception tile and a missile is ready, the launch happens; when the SAM
> missile reaches that tile, the nuke is deleted unconditionally.

### Targeting algorithm (`SAMLauncherExecution.ts:50-303`)

1. Skip entirely if no nukes exist anywhere.
2. Sweep radius 600 over `[AtomBomb, HydrogenBomb, MIRVWarhead]`.
3. Exclude nukes already `targetedBySAM` by another SAM, your own nukes, and
   friendly nukes.
4. `computeInterceptionTile` walks the remaining trajectory and picks the **first**
   tile that is flagged `targetable`, is within range at the projected arrival
   tick, **and** is reachable in time (`samTicks = ceil(manhattanDist / 12)`).
   This is a **pre-shot** — range is strictly enforced against a future position.
5. Results are cached per nuke: `-1` = unreachable at this level (re-evaluated on
   level-up), `-2` = permanently out of reach.
6. Multiple targets are ranked: **Hydrogen bomb bonus +70,001**, then
   `max(0, 200_000 - distToImpact × 1000)`, then `max(0, 10_000 - ticksToExplode × 100)`.
   The SAM fires as many missiles as it has ready slots, best-scored first.

Safety net on the nuke side: a nuke about to detonate is suppressed if any enemy
SAM missile locked onto it is within 12 tiles of the impact point.

### What a SAM cannot intercept

- **MIRV carriers** (excluded from the whitelist)
- Nukes on the untargetable middle stretch of a long arc
- Nukes whose trajectory never enters `samRange(level)`
- Nukes already claimed by another SAM this tick
- Anything that is not a nuke — no ships, no shells

## 5.9 Practical consequences — **[DERIVED]**

1. **Range 70 at level 1 is small.** Against a hydrogen bomb (outer radius 100),
   a level-1 SAM sitting on the thing it protects is *inside* the blast radius of
   a strike that lands short of it. SAM levels below 5 are explicitly targeted by
   Impossible nations for exactly this reason (+100,000 score per outranged SAM).
2. **The targetable window is exploitable in both directions.** Launching from far
   away means the midcourse is untargetable, but the terminal 150 tiles are still
   defended. Launching from *close* means the whole flight is in the target's SAM
   envelope. Long-range silos are safer.
3. **A SAM's 300-tick build time is a real window.** Thirty seconds is three silo
   reloads.
4. **MIRV is uninterceptable and drives a player to 3% of max troops.** It is the
   hard counter to a turtle. It costs 25M and raises the global price 15M for
   everyone including you.
5. **Fallout is a permanent wall you can build.** No decay, 3–5× cost, and it
   disappears the instant someone conquers the tile. Nuking neutral land between
   you and an enemy is a durable terrain edit.
6. **Nuking a tile with no owner produces no warning at all.**
7. **Nukes hit every transport ship a player owns, map-wide.** Timing a nuke
   against a naval invasion is far stronger than it looks.
