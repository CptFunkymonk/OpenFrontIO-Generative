# 04 — Every unit and structure

Nukes and SAMs have their own chapter (`05-strategic-weapons.md`). Costs and
ladders are in `03-economy.md §3.3`.

## 4.1 The unit table

`UnitType` — `Game.ts:195-212`. Groupings — `Game.ts:220-253`.

| Enum | String | Group | You can build it? |
|---|---|---|---|
| `TransportShip` | `"Transport"` | PlayerBuildable | yes (not in the build menu — it is the boat-attack intent) |
| `Warship` | `"Warship"` | BuildableAttacks | yes |
| `Shell` | `"Shell"` | — | no (warships spawn them) |
| `SAMMissile` | `"SAMMissile"` | — | no |
| `Port` | `"Port"` | Structures | yes |
| `AtomBomb` | `"Atom Bomb"` | Nukes, BuildableAttacks | yes |
| `HydrogenBomb` | `"Hydrogen Bomb"` | Nukes, BuildableAttacks | yes |
| `TradeShip` | `"Trade Ship"` | — | no (ports spawn them) |
| `MissileSilo` | `"Missile Silo"` | Structures | yes |
| `DefensePost` | `"Defense Post"` | Structures | yes |
| `SAMLauncher` | `"SAM Launcher"` | Structures | yes |
| `City` | `"City"` | Structures | yes |
| `MIRV` | `"MIRV"` | Nukes, BuildableAttacks | yes |
| `MIRVWarhead` | `"MIRV Warhead"` | Nukes | no |
| `Train` | `"Train"` | — | no (factories spawn them) |
| `Factory` | `"Factory"` | Structures | yes |

`Structures = [City, DefensePost, SAMLauncher, MissileSilo, Port, Factory]`.
**Anything without `maxHealth` dies to a single hit** (`UnitImpl.ts:233-235`) —
that is everything except the Warship.

## 4.2 Build time and placement

| Structure | Build ticks | Seconds |
|---|---|---|
| City | 20 | 2 |
| Factory | 20 | 2 |
| Port | 50 | 5 |
| Defense Post | 50 | 5 |
| Missile Silo | 100 | 10 |
| **SAM Launcher** | **300** | **30** |
| Warship, nukes, MIRV | 0 — delegate immediately | — |

`instantBuild` sets all of these to 0.

**Lifecycle**: the structure is created on the **first tick after** the intent,
marked `underConstruction`, then counts down. **If the tile is captured mid-build,
the execution re-points at the new owner and finishes it for the captor.**

While under construction: ports spawn no trade ships, silos do not reload and are
not valid launch platforms, SAMs do not target, the unit **cannot be upgraded**,
and it counts as **1** toward the cost ladder rather than its level.

### Placement rules

`structureMinDist() = 15`.

**Land structures** (City, Factory, MissileSilo, DefensePost, SAMLauncher) —
`PlayerImpl.ts:1734-1805`:
1. The clicked tile must be **owned by you**, or there is no placement at all.
2. Flood your own tiles within Euclidean **15** of the click.
3. Reject any candidate within Euclidean **15** of *any* structure of *any* owner,
   including under-construction ones.
4. Sort by distance to the click — the structure **auto-snaps to the nearest
   surviving tile**.

**Port** — BFS out to `radiusPortSpawn() = 20` manhattan, keep owned `isShore`
tiles, take the nearest that also passes the 15-tile spacing rule.

**Warship** — the **clicked tile must be water**; the ship spawns at your nearest
active, non-under-construction **Port in the same water component**. No port means
no warship. The clicked tile becomes the patrol tile.

**Global gates**: not in `disabledUnits`; `gold >= cost`; player alive; and
**nothing at all is buildable during the spawn phase**.

## 4.3 Upgrades

`upgradable: true` on **Port, City, Factory, MissileSilo, SAMLauncher** only.
**Defense Post is not upgradable.** Neither are warships or nukes.

**Trigger**: when you place a structure type and already own one of that type
within **15** tiles of the click, the click becomes an **upgrade of the nearest
one** — `canUpgrade` wins over `canBuild`. The cost is the next rung of the same
ladder.

`increaseLevel()` (`UnitImpl.ts:738-757`):
- For **MissileSilo and SAMLauncher**, the new missile slot **starts on cooldown**.
- For **SAMLauncher**, range interpolates linearly to the new value over
  `samUpgradeDuration() = 45` ticks.

### What a level actually buys

| Structure | Effect of level |
|---|---|
| **City** | `maxTroops += 250,000` per level. Under-construction cities excluded |
| **Port** | (a) trade-ship rolls per 10-tick check = level; (b) trade-partner weight = level; (c) warship docking capacity = level; (d) docked healing pool = `level × 5` HP/tick shared |
| **Factory** | train-spawn rolls per tick = level; counted level-weighted in `trainSpawnRate` |
| **Missile Silo** | **number of simultaneously ready missiles** |
| **SAM Launcher** | ready interceptors = level, **and** range |
| Defense Post | n/a — always level 1 |

## 4.4 Capture, destruction and deletion

### When the tile under a structure changes hands (`PlayerExecution.ts:57-78`, every tick)

| Structure | Fate |
|---|---|
| City, Port, Factory, Missile Silo, SAM Launcher | **captured intact at their current level** |
| **Defense Post** | **destroyed**, credited to the captor |
| Any structure whose tile becomes **unowned** (nuked into fallout/water) | **destroyed**, no credit |

Capture clears any pending voluntary deletion, removes the unit from the old
owner's list, and moves **both players' cost ladders**. A captured structure keeps
its train station.

**Ships are not structures** and are unaffected by territory change. The only
capture path for warships and transports is eliminating a **disconnected
teammate** (`GameImpl.ts:1540-1553`). Trade ships are captured by warships.

**Player elimination**: gold is zeroed and remaining non-nuke units are deleted.

### Voluntary deletion (`DeleteUnitExecution.ts`)

Preconditions: the unit exists, is yours, is active, is **on your own territory**,
**on land**, not during the spawn phase, and the cooldown has elapsed.

| Constant | Value |
|---|---|
| `deleteUnitCooldown()` | **300 ticks (30 s)** between deletions, per player |
| `deletionMarkDuration()` | **300 ticks** — the unit keeps working for 30 s, then dies |

> **There is no gold refund.** None. Deleting a level-N structure destroys the
> whole thing, not one level; `decreaseLevel()` has no caller anywhere in
> `src/core`.

## 4.5 City

Its entire tick logic is: on the first tick, if a Factory is within
`trainStationMaxRange() = 110`, become a train station. That is all it *does*.

Its value is `+250,000 maxTroops per level` and being a train **trade
destination** (25,000–35,000 gold per visiting train, paid to both parties).

## 4.6 Port

- Becomes a train station if a Factory is within 110.
- Rolls for a trade ship every **10 ticks**, `level` rolls. See `03-economy.md §3.2`.
- Is the **only** warship spawn point and repair base.
- Is the launch anchor for nothing else — transports launch from any shore tile.

## 4.7 Factory

On its first tick it becomes a train station **with `spawnTrains = true`**, and
promotes every City/Port/Factory within 110 into a station. **It is the only unit
type that generates trains — no Factory means no rail at all.**

## 4.8 Missile Silo

A pure ammo store. Holds `level` missiles; `isInCooldown()` iff the queue is full.
Each tick, if the **front** of the queue is older than `SiloCooldown() = 90` ticks
(9 s), one slot reloads. Stacked same-tick purchases stagger their departures by
one tick each.

`nukeSpawn` picks your **nearest (manhattan) ready silo**: active, not in
cooldown, not under construction. No ready silo = no nuke.

## 4.9 Defense Post

Covered in `02-territory-and-combat.md §2.8`. Summary: range 30, ×5 attacker
losses, ×3 slower, does not stack, destroyed on capture, not upgradable, and
**never fires** (its shooting code is commented out).

## 4.10 Warships

| Property | Value |
|---|---|
| Base max health | **1000** |
| Cost | `min(1M, (n+1) × 250k)` |
| Patrol range | 100 |
| Targeting range | 130 |
| Shell reload | 20 ticks (fires every 21) — **but transport-ship targets are exempt: `lastShellAttack` is not updated, so a warship shelling transports fires every tick** (`WarshipExecution.ts:656-661`) |
| Docking range | 5 |
| Passive heal | **+1 HP/tick** within **150** of any of your ports, in any state |
| Docked heal pool | `portLevel × 5` HP/tick, split across docked ships |
| Retreat threshold | health < **75%** of veterancy-adjusted max |
| Shell lifetime after the firing unit dies | 50 ticks |

### Shell damage (`ShellExecution.ts:96-114`)

```
roll             = random.nextInt(1, 6)                 // 1..5
damageMultiplier = (roll - 1) * 25 + 200                // 200|225|250|275|300
if veterancy > 0: damageMultiplier = floor(dm * (100 + vet*20) / 100)
damage           = round((250 / 250) * damageMultiplier)
```

A fresh warship needs **4–5 hits** to kill another fresh warship. Shells travel 3
tiles/tick.

### Targeting priority (`WarshipExecution.ts:271-357`)

Within 130 tiles, lower priority wins:

1. **TransportShip** → shoot
2. **Warship** → shoot
3. **TradeShip** → **hunt and capture**, never shoot

Ties break by squared distance. **Enemy warships that are `docked` are skipped.**

Extra trade-ship filters: you must have a reachable active port in the same water
component; the trade ship must not be `isSafeFromPirates()`; its destination port
must not belong to you or a friendly; and it must lie within **100 tiles of your
patrol tile** (not of your ship).

> `isSafeFromPirates()` is set whenever a trade ship steps on a **shoreline water
> tile**, lasting 20 ticks. **Hugging the coast makes a trade ship almost
> permanently unpiratable** — and this deliberately fights the pathfinder, which
> charges +1000 for magnitude <3 water.

### Capture, not destroy

Warships **capture** trade ships: close at 2 steps/tick, greedy movement inside 20
tiles, **capture at manhattan ≤ 5**. The ship reroutes to the captor's nearest
port and on arrival the **captor alone** receives `tradeShipGold(tilesTravelled)`
as piracy gold. If the original owner recaptures it, they get the payout and
nobody is credited with piracy.

### Patrol

Idle warships pick a random water tile at `patrolTile ± 50` on each axis,
rejecting non-water, shoreline, and different-component tiles. After 500 failures
the range grows 50%, up to 3 expansions.

`MoveWarshipExecution` sets `patrolTile` for a set of warship ids — and
**silently skips any warship in a different water component**. Setting a new
patrol tile also disables repair-retreat for 50 ticks.

### Veterancy (`UnitImpl.ts:651-727`)

| Constant | Value |
|---|---|
| Max veterancy | **3** |
| Health bonus | **+20% of base max HP per level** |
| Shell damage bonus | **+20% per level** |
| Transport kills per level | **10** |
| Trade captures per level | **25** |

**Killing an enemy Warship (the final blow) = instant +1 level**, and it **wipes**
the partial progress meter. Transports and captures share one meter worth 250
points per level: a transport kill is 25 points, a capture is 10. Overflow carries.

| Vet | Max HP | Retreat threshold | Shell damage range |
|---|---|---|---|
| 0 | 1000 | 750 | 200–300 |
| 1 | 1200 | 900 | 240–360 |
| 2 | 1400 | 1050 | 280–420 |
| 3 | 1600 | 1200 | 320–480 |

Gaining a level does **not** heal the ship. Veterancy lives in `warshipState` and
therefore **survives capture**. Only warships have it.

## 4.11 Transport ships (boats)

Covered in `02-territory-and-combat.md §2.6`. Summary: free, 3 concurrent, **no
cooldown**, 1 tile/tick, landing tile taken free, beachhead attack starts with a
4-tile frontier.

## 4.12 Trains and rail

Trains are **free, auto-spawned, non-combat gold generators**. A "train" is
actually **7 units** — one Engine, one TailEngine, five Carriages.

### Building the network

1. A **Factory** always becomes a station and promotes every City/Port/Factory
   within **110** into one.
2. A City or Port becomes a station only if a Factory is already within 110.
3. New stations splice into an existing railway within radius 3, else connect to
   nearby stations.
4. Connect only to candidates **farther than `trainStationMinRange() = 15`** and
   not already within 4 graph hops. Max 5 connections per new station.
5. A rail path is accepted only if its length `< railroadMaxSize() = 155.56`.
6. Destroying a station-bearing structure deletes its rails and marks the cluster
   dirty.

### Movement and earnings

Speed 2 rail tiles/tick. Deleted silently when it reaches its destination, or when
either station dies, or when trade becomes unavailable.

Earnings: see `03-economy.md §3.2`. The key numbers are 35,000/stop to an **ally**
versus 25,000 to a teammate or stranger and 10,000 to yourself, with a −5,000
penalty per stop from the 11th onward, floored at 5,000.
