# 03 — Economy: troops, gold and the compounding loop

> Read §0.2 first. There is **no population or worker system in this fork**. Two
> independent scalars per player — `_troops: bigint` and `_gold: bigint`
> (`PlayerImpl.ts:140-141`) — that never convert into each other.

## 3.1 Troops

### Starting troops (`Config.ts:1003-1022`)

| Player | Troops |
|---|---|
| Bot | 10,000 |
| Nation, Easy / Medium / Hard / Impossible | 12,500 / 18,750 / 25,000 / 31,250 |
| Human | 25,000 (1,000,000 with `infiniteTroops`) |

### `maxTroops` (`Config.ts:1024-1056`) — verified

```
base = 2 * (numTilesOwned^0.6 * 1000 + 50_000)
     + (sum of LEVELS of cities that are not under construction) * 250_000

     = 2000 * n^0.6  +  100_000  +  250_000 * C
```

Then a type/difficulty multiplier: Human ×1, **Bot ÷3**, Nation Easy ×0.5,
Medium ×0.75, Hard ×1.0, Impossible ×1.25. (`maxTroops` is therefore **not
necessarily an integer** — downstream code handles floats.)

A player with **zero tiles still has `maxTroops = 100,000`.**

| tiles | maxTroops (0 cities) | marginal per tile |
|---|---|---|
| 50 | 120,913 | 250.0 |
| 100 | 131,698 | 189.8 |
| 500 | 183,255 | 99.9 |
| 1,000 | 226,191 | 75.7 |
| 5,000 | 431,445 | 39.8 |
| 20,000 | 861,462 | 22.8 |
| 100,000 | 2,100,000 | 12.0 |

`d(maxTroops)/dn = 1200 · n^-0.4` — the marginal value of a tile **halves every
~5.6× territory**.

> **One city level = +250,000 max troops, flat, forever.** To match that from land
> alone starting at zero you need ~3,128 tiles; at the margin around n≈3,000 you
> would need **~5,100 extra tiles**. A city costs at most 1,000,000 gold. This is
> the strongest lever in the troop economy by a wide margin.

### Troop regrowth (`Config.ts:1058-1090`) — verified

```
toAdd = 10 + T^0.73 / 4          // T = current troops; sub-linear self-reinforcement
toAdd *= (1 - T / max)           // logistic saturation
if Bot:    toAdd *= 0.5
if Nation: toAdd *= {Easy 0.9, Medium 0.95, Hard 1.0, Impossible 1.05}
return min(T + toAdd, max) - T   // hard clamp; NEGATIVE if T > max
```

Applied **every tick, to every alive player** (`PlayerExecution.ts:97-103`).

**[DERIVED]** Maximising `(T^0.73/4)(1 - T/M)` gives `T*/M = 0.73/1.73 = 0.422` —
**growth always peaks at ~42% of max**, at `≈ 0.0769 · M^0.73` troops/tick.

**[DERIVED]** Time to saturate from T = 25,000:

| maxTroops | to 50% | to 90% | to 99% |
|---|---|---|---|
| 121,411 (spawn territory) | 94 | 281 | 502 |
| 300,000 | 193 | 434 | 717 |
| 1,000,000 | 360 | 694 | 1,088 |
| 2,000,000 | 482 | 886 | 1,361 |

**Troops refill to ~99% of cap in under two minutes of game time. Troops are never
the long-run bottleneck — `maxTroops` is.**

### Troops can exceed the cap

`addTroops` does **not** clamp. Returning attack survivors and boat unloads can
push you over; `troopIncreaseRate` then returns a negative delta and pulls you
back down.

## 3.2 Gold

**There is no gold cap.** `_gold` is an unbounded bigint; `addGold` only adds.

### Every income source

| Source | Amount | Site |
|---|---|---|
| **Passive** | **100/tick** (50 for bots) × `goldMultiplier` — **flat, independent of everything** | `Config.ts:1092-1101` |
| Trade ship arrival | `tradeShipGold(tilesTravelled)` to **each** of the source and destination port owners — not split | `TradeShipExecution.ts:214-215` |
| Trade ship piracy | full amount to the captor | `TradeShipExecution.ts:195-196` |
| Train stop | `trainGold(rel, stops)` to the train owner **and** the station owner | `TrainStation.ts:38-42` |
| Conquest | 100% of a bot's/nation's gold, **50%** of a human's | `Config.ts:735-744` |
| Donation | whatever the ally sends | `PlayerImpl.ts:1175` |
| Starting gold | `gameConfig.startingGold ?? 0`; bots always 0 | `PlayerImpl.ts:217` |

**Human base income = 100 gold/tick = 1,000/s = 60,000/min.** Pinned by
`tests/economy/ConstructionGold.test.ts:54`.

Conquest has an anti-farm rule: if the conquered player is Human **and has sent
zero attacks**, the entire transfer is skipped (`GameImpl.ts:1555-1564`). The
conquered player always loses 100% of their gold; half of a human's is destroyed.

**There is no refund for deleting a structure.** No `addGold` exists anywhere in
the delete path.

### Trade ships

`tradeShipGold(dist)` (`Config.ts:516-521`):
```
75_000 / (1 + e^(-0.03 * (dist - 300)))  +  50 * dist
```
`dist` is **tiles actually travelled**, not straight-line.

| dist | gold |
|---|---|
| 100 | 5,185 |
| 200 | 13,556 |
| **300** (inflection) | 52,500 |
| 400 | 91,443 |
| 500 | 99,814 |
| 1,000 | 124,999 |
| 2,000 | 175,000 |
| 5,000 | 325,000 |

The sigmoid centred on 300 is a brutal punishment for short hops. Past ~500 tiles
only the linear `50·dist` term still grows.

**Spawn cadence**: each port checks every 10 ticks (phase-offset at init) and
rolls once **per port level**, each with probability `1/tradeShipSpawnRate`:

```
tradeShipSpawnRate(rejections, worldShips) =
    max(1, floor( (100 / (rejections+1)) / tradeShipSaturation(worldShips) ))

tradeShipSaturation(n) = (1 + 0.45·e^(-n/120))
                       · max( 1 - sigmoid(n, ln2/50,  330),
                              0.25 · (1 - sigmoid(n, ln2/100, 800)) )
```

`n` is the **global** trade-ship count across all players — your income is
throttled by everyone else's ports. Consecutive failures raise the odds (a pity
timer), which square-roots the effect of saturation.

| world fleet | saturation | rate | **[DERIVED]** sec/ship at a level-1 port |
|---|---|---|---|
| 0 | 1.435 | 69 | 9.7 |
| 100 | 1.148 | 87 | 11.0 |
| 300 | 0.625 | 160 | 15.2 |
| 500 | 0.224 | 446 | 25.8 |
| 800 | 0.125 | 799 | 34.8 |

> The pity counter is per-port and increments once per *failed roll*, so a level-3
> port's counter climbs 3× as fast as a level-1 port's. **Port levels are
> superlinear in trade output** — the repo's own scenario data shows a level-3 port
> earning 1,485,000/min against a level-1's 800,700/min. This is not documented in
> the code.

**Partner selection** (`PortExecution.ts:107-151`): all ports of players you
`canTrade` with, sharing a water component. Weight is **additive, not
multiplicative** (`:133-148`): a port gets `level` entries, **plus** `level` more
if it is in the nearest `clamp(totalPorts/3, 4, totalPorts)` **and** farther than
300 tiles, **plus** `level` more if the owner is friendly — and the friendly bonus
is gated on the same `!tooClose` check, so **a friendly port closer than 300 tiles
gets no bonus at all**. Maximum weight is `3 × level`.

### Trains

`trainGold(rel, citiesVisited)` (`Config.ts:481-504`):
```
citiesVisited = max(0, citiesVisited - 9)          // the first 10 stops are free
base = { ally: 35_000, team: 25_000, other: 25_000, self: 10_000 }[rel]
gold = max(5_000, base - citiesVisited * 5_000)
```

| stops | self | team/other | **ally** |
|---|---|---|---|
| 0–9 | 10,000 | 25,000 | **35,000** |
| 10 | 5,000 | 20,000 | 30,000 |
| 12 | 5,000 | 10,000 | 20,000 |
| ≥15 | 5,000 | 5,000 | 5,000 |

Both the train owner and the station owner get the full amount. Only City and Port
stations pay; Factory stops pay nothing and do not increment the counter.

**Teammates get no train bonus; allies do** (35,000 vs 25,000). A shared rail
cluster with a formal ally is a 3.5× multiplier over self-trade, for both parties.

**Spawn**: only Factory stations spawn trains. Per tick, `level` rolls with
probability `1/trainSpawnRate`, min 10-tick gap between trains:
```
trainSpawnRate(F, n) = max(1, floor( (F + 10) * 15 / trainSaturation(n) ))
    F = YOUR factory levels, n = GLOBAL train-unit count (a train is 7 units)
```

**[DERIVED]** Expected spawns per tick = `saturation · F / (15(F+10))` → the
asymptote is `saturation/15`, i.e. **at most ~1 train per 15 ticks per player, no
matter how many factories you build**. At F=10 you are already at half the
asymptote. **Factories have severe self-inflicted diminishing returns.**

## 3.3 Structure cost ladders

`costWrapper` (`Config.ts:755-774`):
```
numUnits = Σ over the listed types of min( unitsOwned(type), unitsConstructed(type) )
cost     = costFn(numUnits + extraUnits)
```
`unitsOwned` counts **levels** for completed units, so an *upgrade* advances the
same ladder as a new build. Losing units **lowers the price again**.

| Unit | Formula | Shares ladder with | Ladder |
|---|---|---|---|
| City | `min(1e6, 2^k · 125,000)` | — | 125k → 250k → 500k → **1M flat** |
| Port | `min(1e6, 2^k · 125,000)` | **Factory** | same |
| Factory | `min(1e6, 2^k · 125,000)` | **Port** | same |
| Defense Post | `min(250,000, (k+1) · 50,000)` | — | 50k, 100k, 150k, 200k, 250k |
| Missile Silo | flat 1,000,000 | — | — |
| SAM Launcher | `min(3e6, (k+1) · 1,500,000)` | — | 1.5M, 3M, 3M… |
| Warship | `min(1e6, (k+1) · 250,000)` | — | 250k, 500k, 750k, 1M… |
| Atom Bomb | flat 750,000 | — | — |
| Hydrogen Bomb | flat 5,000,000 | — | — |
| MIRV | `25M + 15M × game.mirvsLaunched()` | **global, all players** | 25M, 40M, 55M… |
| Transport, Trade Ship, Train, Shell, SAM Missile, MIRV Warhead | **0** | — | — |

> **Ports and Factories share one counter.** Your first Factory costs 125,000 only
> if you own no Ports. Build three Ports and the next Factory costs 1,000,000.

Bulk purchase: an intent may carry `amount` 1..50. Upgrades use the escalating
cumulative array; flat-cost nukes scale linearly.

## 3.4 Donations

| Check | Rule |
|---|---|
| Relationship | must be `isFriendly` — **a formal ally or a teammate, and not disconnected** |
| Human recipient | blocked unless the lobby enables `donateGold` / `donateTroops` |
| Cooldown | **100 ticks, per recipient** — you can donate to three allies in the same tick |
| Gold default | `sender.gold() / 3`; **no cap** |
| Troop default | `floor(sender.troops() / 3)`; **capped at `maxTroops(recipient) - recipient.troops()`** |

Relation gained: gold gives `min(100, 5 · floor(goldSent / adjustedChunk))` where
the chunk inflates with game time (`chunk × (1 + ticks/(3000 + spawnTicks))`) —
**late donations buy proportionally less goodwill**. Troops give a flat +50 if
above a randomised threshold (a fraction of the *recipient's* `maxTroops`,
deliberately random so you cannot probe it).

## 3.5 Economic tick rates

| Update | Cadence |
|---|---|
| Passive gold + troop growth | **every tick, per alive player** |
| Alliance / embargo expiry sweeps | every tick |
| Territory cluster recalc | every 20 ticks, or **every tick under 100 tiles** — and skipped entirely unless `lastTileChange() >= lastCalc` (`PlayerExecution.ts:121-125`) |
| Trade-ship spawn roll | every 10 ticks per port, `level` rolls |
| Train spawn roll | every tick per factory station, `level` rolls, 10-tick min gap |
| Donate cooldown | 100 ticks |
| Delete-unit cooldown / mark delay | 300 / 300 ticks |

> **Nothing economic runs during the spawn phase.** `PlayerExecution`,
> `PortExecution`, `FactoryExecution`, `CityExecution`, `TrainStationExecution`,
> `TradeShipExecution` and both donate executions all return `false` from
> `activeDuringSpawnPhase()`. The economy starts at tick 100/150/200.

## 3.6 Where the loop actually breaks — **[DERIVED]**

| Bottleneck | Why |
|---|---|
| **1. Coastline + a willing foreign port** | One ocean-crossing port pair is ~13× base income. Landlocked or universally embargoed, you are stuck at 60,000/min plus trains |
| **2. Trade distance ≥ ~300 tiles** | Below the debuff the sigmoid collapses — a short coastal hop earns ~62,000/min, barely above base, for a 125,000 investment |
| **3. Global fleet saturation** | In a big lobby `tradeShipSaturation` falls toward 0.25 regardless of your play |
| **4. Factory count past ~10** | `sat·F/(15(F+10))`: 10 → 20 factories buys ~33% more trains for ~10M gold |
| **5. Tiles past a few thousand** | Marginal max-troop yield drops below 40/tile; one city level is worth ~5,100 tiles at that margin |
| **6. The flat 1M cost cap** | Past the 4th structure on a ladder, marginal cost is constant and marginal benefit is roughly constant. **The loop goes linear, not compounding** |

### Measured income (from the repo's own committed snapshots)

`tests/__snapshots__/TradeTrainScenarios.test.ts.snap` — gold/min per side:

| Setup | gold/min | × base |
|---|---|---|
| Passive only | 60,000 | 1.0 |
| 1 Port each, short coastal hop (~60 tiles) | 62,370 | **1.04** |
| 1 Port each, across the ocean (~300 tiles) | 800,700 | 13.3 |
| Port lvl-3 vs lvl-1, across the ocean | 1,485,000 | 24.8 |
| 1 Port each, ~800 tiles | 1,136,000 | 18.9 |
| 10 Ports each, across the ocean | 9,053,000 | 151 |
| 50 Ports each, long route | 24,290,000 | 405 |
| 1 Factory + 1 City (self-trade) | 46,000 | 0.77 |
| 1 Factory + 4 Cities | 42,000 | 0.70 |
| 1 Factory + an **ally** City in cluster | 76,000 (+250,000 to the ally) | 1.27 |

Read the second row again. **A port with only a short coastal route is worth
almost nothing.** Route length is the whole game.

### Payback periods — **[DERIVED]**, at base income, first structure = 125,000

| First purchase | Income added | Payback |
|---|---|---|
| Port with an ocean partner ≥300 tiles away | +800,700/min | **~9 seconds of operation** |
| Port with only a short coastal hop | +2,370/min | ~53 minutes |
| Factory + City (250,000 total) | +46,000/min | ~5.4 minutes |
| City alone | +0 gold, +250,000 maxTroops | never — it is a military purchase |
