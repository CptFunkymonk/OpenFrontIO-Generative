# 01 — The map, terrain and choosing a spawn

## 1.1 Tile encoding

`TileRef = number` — a raw grid index (`GameMap.ts:5`). There are no x/y lookup
tables; the arithmetic is deliberate (`GameMap.ts:119-123`).

| Operation | Formula | Source |
|---|---|---|
| `ref(x, y)` | `y * width + x` (throws on bad coords) | `GameMap.ts:167-172` |
| `x(ref)` | `ref % width` | `GameMap.ts:180-182` |
| `y(ref)` | `(ref / width) \| 0` | `GameMap.ts:184-186` |
| `isValidRef(ref)` | integer, `0 <= ref < width*height` | `GameMap.ts:174-176` |

Two parallel buffers, each `width*height` (`GameMap.ts:114-115`):

**`terrain: Uint8Array`** — from the map file, mutable only by water nukes:

| Bits | Mask | Meaning |
|---|---|---|
| 7 | `0x80` | `IS_LAND_BIT` |
| 6 | `0x40` | `SHORELINE_BIT` |
| 5 | `0x20` | `OCEAN_BIT` |
| 0–4 | `0x1F` | `MAGNITUDE_MASK` (0–31) |

`GameMap.ts:127-130`. `IMPASSABLE_MAGNITUDE = 31` (`:135`).

**`state: Uint16Array`** — mutable game state:

| Bits | Mask | Meaning |
|---|---|---|
| 0–11 | `0xFFF` | smallID of the owner; `0` = TerraNullius. **Max 4095 players** |
| 13 | `0x2000` | `FALLOUT_BIT` |
| 14 | `0x4000` | `DEFENSE_BONUS_BIT` — **dead, never set by the sim** |

`GameMap.ts:140-143`, `296-326`.

Derived predicates:
- `isShore(ref)` = `isLand && isShoreline` (`GameMap.ts:387-389`). The shoreline bit is set on **both
  sides** of a coast — land tiles next to water *and* water tiles next to land
  (`map_generator.go:312-352`). Impassable tiles never get it.
- `isOceanShore(ref)` = land tile with a 4-neighbour whose **ocean bit** is set
  (`GameMap.ts:226-236`).
- `isBorder(ref)` is **ownership-only**: any 4-neighbour with a different owner.
  Water (owner 0) beside unowned land is not a border (`GameMap.ts:357-368`).
- `isOnEdgeOfMap(ref)` — map boundary **or adjacent to impassable**. Impassable
  terrain behaves like the map edge for enclosure checks (`GameMap.ts:343-355`).

## 1.2 Terrain types

```
enum TerrainType { Plains, Highland, Mountain, Ocean, Impassable }
```
`Game.ts:365-371`. Derivation — `terrainType`, `GameMap.ts:397-407`:

| Condition | Type |
|---|---|
| land, magnitude ≥ 31 | `Impassable` |
| land, magnitude < 10 | `Plains` |
| land, magnitude < 20 | `Highland` |
| land, magnitude ≥ 20 | `Mountain` |
| not land | `Ocean` (**including lakes** — ocean-vs-lake is the separate `OCEAN_BIT`) |

Magnitude means elevation on land (0–30 from the PNG blue channel) and
**distance to the nearest land** on water (`ceil(manhattan/2)`, capped 31;
shoreline water = 0) — `map_generator.go:156-161, 355-402`.

### Combat consequence — the only one that matters

`terrainAttackBase` (`Config.ts:172-188`) — **verified against source**:

| Terrain | `mag` (drives attacker losses) | `tileCost` (drives slowness) |
|---|---|---|
| Plains | 80 | 16.5 |
| Highland | 100 | 20 |
| Mountain | 120 | 25 |
| Impassable | **throws** | — |

Attacking *into* mountain costs 1.5× the troops of plains and is ~1.5× slower.
The penalty is paid by the attacker, always.

### What impassable terrain blocks

Cannot be conquered, attacked, nuke-*targeted*, included in a blast, flooded by
water nukes, crossed by rail, or built on. Not counted in `numLandTiles`. Acts as
the map edge for the encirclement check.

> **It does NOT block nuke trajectories.** `GameMap.ts:131-134` and
> `map-generator/README.md:91` both claim it does. Both are wrong in this
> checkout — `tests/ImpassableTerrain.test.ts:324-336` asserts a nuke flies over
> impassable terrain and detonates. No trajectory-blocking code exists.

## 1.3 Map roster and sizes

128 maps, generated into `src/core/game/Maps.gen.ts` (do not edit). Dimensions
and land counts live only in `resources/maps/<folder>/manifest.json`.

**`GameMapSize`** (`Game.ts:151-154`):

| | game map | pathfinding minimap |
|---|---|---|
| `Normal` | `map.bin` (W×H) | `map4x.bin` (W/2 × H/2) |
| `Compact` | `map4x.bin` (W/2 × H/2) | `map16x.bin` (W/4 × H/4) |

`TerrainMapLoader.ts:95-106`. **The minimap is always exactly half the game map's
dimensions**, which is why `MiniMapTransformer` unconditionally divides by 2.

Compact also halves nation and team-spawn-area coordinates, and on **public**
games uses only 25% of manifest nations (min 1) — `NationCreation.ts:86-95`.
Compact has ~¼ the land but the **same** `minDistanceBetweenPlayers() = 30` and
the **same** 52-tile start, so players are ~4× more densely packed.

### Notable maps

| Category | Maps |
|---|---|
| **All land — no boats, ports, trade or warships possible** | `Alps` (2000×1836, 3,672,000 land, 100%), `TheBox` (2048², 4,194,304, 100%) |
| Smallest | `Onion` 512×512, 210,555 land |
| Most water-dominated | `ArchipelagoSea` 6%, `Hawaii` 6%, `Japan` 8%, `Sol` 8%, `Caribbean` 10% |
| Extreme aspect | `MississippiRiver` 400×4200, `Passage` 6000×400, `AmazonRiver` 5536×276 |
| Most nations | `GiantWorldMap` 107, `WorldInverted` 93, `Dyslexdria` 82, `Russia` 82 |
| Common | `World` 2000×1000 / 651,569 land / 72 nations; `Europe` 2904×1672 / 2,345,907 / 52 |

21 maps define `teamGameSpawnAreas`, keyed by team count as a string
(`GameImpl.ts:1069-1081`). `Alps` forces water nukes at 75%, `ArchipelagoSea` and
`Baikal` at 50% (`Maps.gen.ts` `forcedModifiers`).

## 1.4 Pathfinding and unit speeds

| Domain | Algorithm | Map used |
|---|---|---|
| Water (boats, trade, warships) | HPA* over 32×32 clusters, flat `AStarWater` fallback | **minimap** |
| Rail / trains | generic A* + `RailAdapter` | **minimap** |
| Air (shells, SAM missiles) | seeded random 4-dir greedy walk, **no obstacle awareness** | full map |
| Nukes / MIRV | cubic Bézier arc, no map awareness | full map |

`PathFinder.ts:168-205`.

**Water cost** (`AStar.Water.ts:5-15`), `BASE_COST = 100`:

| Water magnitude | penalty |
|---|---|
| `< 3` (within ~5 tiles of shore) | **+1000** (11× a normal step) |
| `3..10` | 0 — the sweet spot |
| `> 10` (deep) | +100 |

Ships hug the 3–10 magnitude band, i.e. **6–20 tiles offshore**. Heuristics are
weighted (5× for `AStarWater`) and therefore **inadmissible** — paths are fast,
not optimal.

### Speeds, tiles per tick

| Unit | Speed | Source |
|---|---|---|
| Transport ship (boat) | **1** | `TransportShipExecution.ts:38` |
| Trade ship | **1** | `TradeShipExecution.ts:145-168` |
| Warship patrolling/retreating | **1** | `WarshipExecution.ts:745-755` |
| Warship hunting a trade ship | **2**, captures at manhattan ≤ 5 | `WarshipExecution.ts:681-691` |
| Train | **2** rail tiles | `TrainExecution.ts:34` |
| Shell | **3** | `ShellExecution.ts:67` |
| SAM missile | **12** | `Config.ts:1172-1174` |
| Atom / Hydrogen bomb | **10** arc units | `Config.ts:1123` |
| MIRV carrier | **15** | `Config.ts:1125` |
| MIRV warhead | **22** (+0..4 by index) | `Config.ts:1127` |

Caveats: a ship "step" is a path node from the upscaled minimap path, so diagonal
steps give ≈1.41 tiles/tick Euclidean. Nuke speed is along the **arc**, whose
height is `max(distance/3, 50)` — short-range nukes are much slower over ground
than the nominal number suggests.

### Minimap downscaling — consequences you will hit

2×2 block reduction with priority **Water > Impassable > Land** ("water always
wins so narrow rivers are preserved", `map_generator.go:261-308`). Therefore:

1. **Water is dilated.** A 1-tile land isthmus can vanish, so a boat path may
   cross it. The repo's own test suite has a `describe("Known bugs")` block
   asserting exactly this (`tests/core/pathfinding/PathFinding.Water.test.ts:246-277`).
2. All ship paths are quantised to even coordinates before interpolation.
3. **Rail paths are minimap-quantised too** — easy to miss.
4. Warship hunting bypasses the pipeline inside 20 tiles with greedy stepping
   because upscaled diagonal paths fail to converge (`WarshipExecution.ts:695-702`).

## 1.5 Water components

A component is a runtime connectivity label over water tiles of the **minimap**,
4-neighbour flood fill (`ConnectedComponents.ts:71-116`). Distinct from the ocean
bit, which is a static "part of the largest water body" flag.

`getWaterComponent(tile)` maps to minimap, then checks the tile, then 1-hop, then
2-hop neighbours "for narrow straits" (`WaterManager.ts:229-257`).

**What components gate:**

| Mechanic | Rule |
|---|---|
| Warship construction | your port must share the target water tile's component |
| Warship move order | **silently skipped** if the ship is in a different component |
| Warship docking/retreat | ports in the same component only |
| Trade partners | ports sharing a component with this port's water neighbours |
| Transport launch | your shore tiles filtered to the destination's component |
| Transport target | target shore must be on a component adjacent to your shoreline, `maxDist = 50` |
| AI port siting | ocean, or a lake component ≥ **3,000** full-map tiles (except on Easy) |

A spawn on a lake-only coast gets a port that can only trade with players on the
**same lake**.

## 1.6 The spawn phase

| Setting | Value | Source |
|---|---|---|
| Spawn phase, singleplayer | 100 ticks | `Config.ts:856-859` |
| Spawn phase, random spawn | 150 ticks | `Config.ts:860-862` |
| Spawn phase, otherwise | **200 ticks** | `Config.ts:863` |
| `minDistanceBetweenPlayers()` | **30** (manhattan) | `Config.ts:823-825` |
| `MAX_SPAWN_TRIES` | 1,000 | `SpawnExecution.ts:38` |
| `RELAX_MIN_DIST_AT` | 750 — after try 750 the distance check is dropped | `SpawnExecution.ts:39` |
| Spawn immunity | 50 ticks | `Config.ts:189` |

## 1.7 The starting territory: exactly 52 tiles

`getSpawnTiles(gm, tile, requireAllValid)` (**`src/core/execution/Util.ts:130-159`**
— note: *execution*/Util.ts, not `src/core/Util.ts`) BFS-floods
`euclDistFN(tile, 4, center=true)`, which shifts the circle centre to
`(x-0.5, y-0.5)` and tests `dx² + dy² <= 16` (`GameMap.ts:715-735`).

**Exact shape: 52 tiles**, bounding box `x-4 .. x+3` × `y-4 .. y+3` (8×8), row
widths top to bottom `4, 6, 8, 8, 8, 8, 6, 4`. **The disc is biased up-and-left
of the clicked tile by half a tile.**

Two modes:
- `requireAllValid = true` → `null` if **any** of the 52 is owned, non-land or
  impassable. Used by the random-spawn search.
- `requireAllValid = false` → the valid subset, possibly fewer than 52. Used for
  an explicitly chosen tile.

### Explicit (clicked) spawn

`SpawnExecution.ts:139-148`. **No min-distance check, no border check, no land
check on the centre itself.** Fails only if the filtered set is empty.

Client-side gating before the intent is sent: `isLand && !hasOwner &&
inSpawnPhase && !isRandomSpawn` (`ClientGameRunner.ts:1216-1224`).

Server-side gates on the intent path (`SpawnExecution.ts:60-94`):
- invalid `TileRef` → no-op
- the intent must have been **queued during** the spawn phase (captured in
  `init()`). An intent sent on the last spawn tick still lands; later ones do not.
- under random spawn, a player who already spawned cannot re-roll
- re-spawning relinquishes previous tiles first, restoring them if the new spawn fails

### Random spawn search

Up to 1,000 tries (`SpawnExecution.ts:150-198`). Each try: pick a uniform random
tile (within the team spawn area if any); reject if not land, owned, or
`isBorder`; if `tries <= 750` reject if any other player's `spawnTile()` is within
manhattan 30; then require **all 52 tiles** valid.

Because of that last requirement the **disc itself** contains no water, no
impassable terrain and nobody else's land. It does **not** follow that the spawn
is inland: nothing constrains the tiles *outside* the disc, and the disc's outer
ring is 4-adjacent to them, so a disc-edge tile beside water is a shore tile and a
Port can be built on it at once. Measured: **5 of 500** valid random-spawn discs
on Iceland (Normal) contained an `isShore` tile. Coastal random spawns are rare,
not impossible. If all 1,000 tries fail the player is simply not placed.

### Who gets spawned

| Population | Trigger |
|---|---|
| Humans | **only when `isRandomSpawn()`** are spawns pre-created (`PlayerSpawner.ts:13-23`) |
| Nations | one `NationExecution` each when `spawnNations()` |
| Bots (tribes) | `TribeSpawner.spawnTribes(bots())` when `bots() > 0` |

> With random spawn **off**, a human who never sends a spawn intent is never
> placed. There is no end-of-phase fallback anywhere.

Nations place near their manifest cell: `delta = 25`, up to 50 tries, and they
**reject a Mountain tile with 1/2 probability** (`NationExecution.ts:282-311`).
They pass the tile as an explicit centre, so **nations can start with fewer than
52 tiles**. Nations that already spawned also **re-spawn periodically** during the
spawn phase — they visibly hop around.

## 1.8 What makes a spawn good — **[DERIVED]**

Ranked, with the mechanic each claim rests on.

**1. Contiguous unowned land reachable in the first ~60 s.** Terra nullius costs a
flat 16/20/24 troops per tile with zero defender loss, and the tick cost clamps
out at ~6,600 troops on plains (§02). Early free land is the cheapest territory
you will ever get, and territory is the win condition.

**2. Border-to-area ratio.** `tickFraction ∝ tileCost / borderSize` and the
attacker's budget is 1 per tick. **Halving your exposed border roughly halves the
rate at which enemies eat you** — and equally halves your own outward expansion.
Peninsulas, isthmuses and valley mouths are quantitatively good. A chokepoint
narrower than ~15 tiles can be covered by a single defense post, which is the best
possible structures-per-border ratio (`structureMinDist() = 15`).

**3. At least one shore tile within 20 tiles of a buildable spot**, touching a
large water component. No coast in your territory = no port, no trade income, no
warships, no naval transport, ever. Ports need an owned `isShore` tile found by
BFS within `radiusPortSpawn() = 20` manhattan.

Note the tension: under random spawn all 52 tiles must be land, so a random spawn
is **usually, but not always, inland** (~1% carried a shore tile in a 500-sample
test on Iceland). Manual pickers who want port access should click ~4–5 tiles
inland from the coast to keep the full disc, or accept a smaller start.

**4. Distance to neighbours.** Random spawns are ≥30 apart; manual picks have **no
floor at all**. You can deliberately spawn adjacent to a weak neighbour to
snowball, or far from everyone to farm neutral land.

**5. Terrain on the likely invasion axis.** Owning mountains is defensively
excellent and offensively irrelevant — the 1.5× penalty is paid by whoever attacks
into them, including you if you ever have to retake them. The attack-front
priority heap prefers low-`mag` tiles, so an attack naturally flows around
mountains along plains corridors: **a plains corridor through a mountain belt is a
predictable invasion route and the right place for a defense post.**

**6. Coast and map edge are a defensive bonus, conditionally.**
`surroundedBySamePlayer` returns false immediately if any cluster tile
`isOceanShore` or `isOnEdgeOfMap` (`PlayerExecution.ts:384-386`) — coastal,
map-edge and impassable-adjacent territory **cannot be auto-annexed when
encircled**. The cost is that coastline is a second attack surface: enemy boats
land on any shore tile reachable within 50 tiles of their target.

**7. Terrain does not affect economy at all.** Gold is flat; troop growth depends
only on tile *count*. **Land quantity beats land quality for economy; land quality
only buys defence.**

**8. Nations avoid mountains 50% of the time**, so mountain-adjacent spawns tend
to have fewer immediate AI neighbours.
