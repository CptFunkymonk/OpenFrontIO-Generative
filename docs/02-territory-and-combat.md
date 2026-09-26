# 02 — Territory and combat

This is the core loop. Every number here was verified directly against
`Config.ts:882-973` and `AttackExecution.ts`.

## 2.1 The attack resolution formula

`attackLogic(input) -> {attackerTroopLoss, defenderTroopLoss, tickFraction}` is a
**pure function** — it receives no Game or Player objects (`Config.ts:91-121`).

### Inputs

| Field                    | Source                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `terrain`                | terrain of the tile being taken                                                             |
| `attackTroops`           | the **live, decreasing** stack (`AttackExecution.ts:332`)                                   |
| `attacker`               | `{type, numTiles}`                                                                          |
| `defender`               | `null` for TerraNullius, else `{type, numTiles, troops, isTraitor, isDisconnectedTeammate}` |
| `defenderHasDefensePost` | boolean — any active defender post within **30**                                            |
| `falloutRatio`           | `numTilesWithFallout / numLandTiles` — a **global** ratio, not local                        |
| `borderSize`             | `attack.borderSize() + rand(0..4)`, **computed once per tick**                              |

### Modifier order (`Config.ts:882-920`)

```
1. {mag, tileCost} = terrainAttackBase(terrain)        // 80/16.5, 100/20, 120/25
2. if (defender && defenderHasDefensePost):  mag *= 5 ; tileCost *= 3
3. if (falloutRatio !== null):
      f = 5 - falloutRatio*2                            // in [3, 5]
      mag *= f ; tileCost *= f
4. if (defender === null) -> TERRA NULLIUS branch, see §2.7
5. if (defender.isDisconnectedTeammate): mag = 0
6. if ((attacker is Human || Nation) && defender is Bot): mag *= 0.7
```

### Player-vs-player result (`Config.ts:922-971`)

```
largeTerritoryBonus(n, depth) = 1 - depth * sigmoid(log(n), 2.5, log(300_000))

largeAttackerBonus      = largeTerritoryBonus(attacker.numTiles, 0.7 )
largeDefenderBonus      = largeTerritoryBonus(defender.numTiles, 0.3 )
largeAttackerSpeedBonus = largeTerritoryBonus(attacker.numTiles, 0.73)

traitorLossMod = defender.isTraitor ? 0.5 : 1
traitorCostMod = defender.isTraitor ? 0.8 : 1

troopRatio = defender.troops / attackTroops

defenderTroopLoss = defender.troops / defender.numTiles          // PER TILE

attackerTroopLoss = mag
                  * traitorLossMod
                  * clamp(troopRatio, 0.6, 2)
                  * (0.463 * largeAttackerBonus * largeDefenderBonus
                     + 0.0039 * defenderTroopLoss)                // PER TILE

speedCost    = clamp(troopRatio, 0.82, 7.5) * clamp(troopRatio/20, 1, 50) / 8.55

tickFraction = speedCost * tileCost
             * largeAttackerSpeedBonus * largeDefenderBonus * traitorCostMod
             / borderSize
```

**Tiles taken per tick ≈ `1 / tickFraction`** ≈
`borderSize / (speedCost · tileCost · bonuses)`.

### Properties that matter

- `defenderTroopLoss` depends on **nothing but the defender**. Not terrain, not
  defense posts, not traitor status, not who is attacking. It is floored to a
  bigint by `removeTroops`, so **a defender with <1 troop per tile loses zero**.
- Defense posts and fallout multiply `mag` **and** `tileCost` by the same factor —
  they raise your losses and slow you down in equal proportion.
- Traitor status is a pure defensive debuff: the defender kills **half** as many
  attackers and dies **25% faster**.
- `attackerTroopLoss` is **per tile**, not per tick.
- `attackTroops` fed into the formula is the live count, so losses and speed both
  worsen _within_ a single tick as the stack burns down.

### Golden values (pinned in `tests/__snapshots__/AttackLogicGolden.test.ts.snap`)

Baseline: Plains, attacker 20k tiles, defender 20k tiles / 100k troops, attack
100k troops, `borderSize` 100.

| Case                                    | atk loss/tile | def loss/tile | `tickFraction`                          |
| --------------------------------------- | ------------- | ------------- | --------------------------------------- |
| baseline                                | 38.56         | 5             | 0.01928 (≈52 tiles/tick)                |
| defender has a defense post             | 192.79 (5×)   | 5             | 0.05783 (3×)                            |
| defender is a traitor                   | 19.28 (0.5×)  | 5             | 0.01542 (0.8×)                          |
| human/nation attacks a Bot              | 26.99 (0.7×)  | 5             | unchanged                               |
| **bot attacks human**                   | 38.56         | 5             | unchanged — **no bot-attacker penalty** |
| **bot attacks bot**                     | 38.56         | 5             | unchanged — the 0.7× does NOT apply     |
| disconnected teammate                   | **0**         | 5             | unchanged                               |
| fallout 10% (f = 4.8)                   | 185.08        | 5             | 0.09252                                 |
| fallout 100% (f = 3)                    | 115.67        | 5             | 0.05783                                 |
| Mountain + post + fallout 0.5 + traitor | 578.36        | 5             | 0.28037                                 |

### End-to-end scenarios (`tests/__snapshots__/AttackScenarios.test.ts.snap`)

100×100 plains map, two ~5,000-tile rectangles, no troop regen:

| Scenario                                                   | ticks | tiles taken | atk loss/tile |
| ---------------------------------------------------------- | ----- | ----------- | ------------- |
| 50k vs 50k, attack 10k                                     | 24    | 125         | 80            |
| 50k vs 50k, attack 50k (all-in)                            | 43    | 805         | 62.1          |
| 200k vs 20k, attack 40k                                    | 30    | 1,184       | 33.8          |
| 20k vs 200k, attack 4k                                     | 27    | 41          | 97.6          |
| vs bot defender, attack 10k                                | 34    | 178         | 56.2          |
| vs traitor defender, attack 10k                            | 39    | 249         | 40.2          |
| one defense post at the border, attack 10k                 | 13    | 39          | 256.4         |
| three posts covering the whole border, attack 10k          | 11    | 25          | 400           |
| **vs terra nullius, attack 2k (human)**                    | 25    | 125         | **16 flat**   |
| **vs terra nullius, attack 2k (bot)**                      | 50    | 250         | **8 flat**    |
| 400-tile turtle, 4M troops, under a post, attacked with 1M | 17    | 32          | 31,250        |

Note the pattern: **in PvP the attack always spends its entire stack** unless it
runs out of frontier first.

## 2.2 Creating an attack

`AttackExecution.init()` (`AttackExecution.ts:75-211`), in order:

1. Target must exist; cannot attack self; cannot attack a friendly (ally or same
   team). `isFriendly` returns **false for a disconnected ally**.
2. If neither side is a Bot: the target **auto-embargoes you temporarily** (5 min)
   and your pending alliance requests to them are rejected.
3. `canAttackPlayer`: **only Human attackers respect spawn immunity.** Nations and
   Bots attack through it (`PlayerImpl.ts:1917-1926`).
4. `startTroops ??= config.attackAmount(...)` — `troops/5` for humans, `/20` for bots.
5. If `removeTroops` (default true): clamp to your troops, deduct, and use the
   **actually deducted floored integer**. Sub-1-troop attacks cost and deliver
   nothing (pinned by `tests/Attack.test.ts:690-723`).
6. Frontier seeding: with a `sourceTile` (boat landing) only that tile's
   neighbours; otherwise **every** border tile you own.
7. **Mutual cancellation**: for each incoming attack whose attacker is your
   target, troops cancel **1:1** and the smaller attack is deleted.
8. **Merging**: any other outgoing attack of yours against the same target is
   absorbed — **but only if the new attack's `sourceTile === null`**.
9. Relation penalty on the defender: Easy −60, Medium −70, Hard −80, Impossible −100.

### How much is sent

The live game never uses `Config.attackAmount()` for humans — it is a `??=`
fallback. The client sends `uiState.attackRatio * player.troops()`, default
**0.2**, clamped to `[0.01, 1]` (`ControlPanel.ts:97-120`, `UserSettings.ts:987`).
Do not model attack sizing from `attackAmount()`.

## 2.3 The per-tick loop

`AttackExecution.tick()` (`:258-343`):

```
if attack.retreated():   retreat(targetIsPlayer ? 25 : 0); stop
if attack.retreating():  return                  // FROZEN: no tiles, no losses
if !attack.isActive():   stop
if owner.isFriendly(target): retreat(0)          // alliance formed mid-attack: free

borderSize = attack.borderSize() + rand(0..4)
tickBudget = 1
while tickBudget > 0:
   if troopCount < 1:      attack.delete(); stop        // ALL TROOPS LOST
   if toConquer.empty():   refreshToConquer(); retreat(0); return   // free refund
   tile = toConquer.dequeue()
   attack.removeBorderTile(tile)
   skip (NO budget spent) if: no 4-neighbour owned by attacker,
                              or ownerID(tile) !== target,
                              or not land, or impassable
   addNeighbors(tile)
   {atkLoss, defLoss, tickFraction} = attackLogic(...)
   tickBudget -= tickFraction
   troopCount -= atkLoss ; attack.setTroops(troopCount)
   target.removeTroops(defLoss)
   owner.conquer(tile)
   handleDeadDefender()
```

Notes: the budget can overshoot — the last tile is taken even if it exceeds the
remainder, so a valid frontier yields **at least 1 tile per tick**. Skipped stale
heap entries cost nothing, so the loop can churn many duplicates in one tick.

## 2.4 How an attack ends

| Situation                      | Outcome                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `troops < 1`                   | `attack.delete()` — **every remaining troop is lost, nothing refunded** |
| Frontier empties               | `retreat(0)` — **100% of remaining troops returned, free**              |
| Alliance formed mid-attack     | `retreat(0)` — free                                                     |
| You cancel vs a player         | 20 ticks frozen, then **25% of the remaining stack dies**               |
| You cancel vs TerraNullius     | 20 ticks frozen, then **free**                                          |
| Defender drops below 100 tiles | `handleDeadDefender()`                                                  |

### `handleDeadDefender()` (`:448-481`)

Triggers when `target.numTilesOwned() < 100`. Calls `conquerPlayer` (gold
transfer, kill stats), then up to 100 passes over the defender's remaining tiles:
any tile bordering **you** is yours; otherwise any tile bordering a **third**
non-friendly player is conquered by _that_ player.

> Finishing a player instantly wipes their last <100 tiles and **partially gifts
> them to your neighbours**. If a rival borders the corpse, you are feeding them.

### Retreat mechanics (`RetreatExecution.ts`)

`cancelDelay = 20` ticks. First tick sets `_retreating` — from that moment the
attack is **completely frozen**: conquers nothing, loses nothing, and its troops
are still off your books. After 20 ticks `_retreated` is set and the next
`AttackExecution` tick applies `malusForRetreat = 25` (percent) **only if the
target is a Player**.

Real cost of cancelling a land attack: ~20 ticks of dead troops plus 25% of what
is left. Compare with letting it die at <1 troop: **100% loss**. Retreating at 2%
remaining refunds 75% of that 2%; dying refunds nothing.

## 2.5 Border mechanics — you cannot steer an attack

`toConquer` is a **min-heap** (lowest priority dequeued first). For each
4-neighbour `n` of a just-taken tile (`AttackExecution.ts:398-446`):

```
numOwnedByMe = how many of n's 4 neighbours the attacker owns   (0..4)
mag          = Plains 1, Highland 1.5, Mountain 2, else 0
priority     = (rand(0..6) + 10) * (1 - numOwnedByMe*0.5 + mag/2) + currentTick
```

Consequences:

- `+ currentTick` means earlier-discovered tiles win ties — the frontier is
  roughly FIFO across ticks.
- The `(1 - numOwnedByMe*0.5 + mag/2)` factor shrinks as you surround a tile, so
  **concave pockets and salients are eaten first**, before the front advances. It
  first reaches ≤0 at `numOwnedByMe = 3` on plains (`mag/2 = 0.5`, giving
  exactly 0) and is strictly negative only at 4; on mountain (`mag/2 = 1`) it is
  never negative. At `numOwnedByMe = 2` it is still +0.5 on plains.
- Mountains get a larger positive multiplier than plains, so **the attack prefers
  flat land and routes around mountains**.
- The PRNG is `new PseudoRandom(123)` — **the same fixed seed for every attack in
  every game**. It is variety, not unpredictability.

> **Attack direction is not "toward the capital".** You choose where an attack
> _starts_ (via a boat) and how many troops it gets. You do not choose where it
> goes.

**`borderSize` is a first-class resource.** `tickFraction` divides by it, so tiles
per tick scales ~linearly with contact width. The same 400 troops on a 200-tile
front outrun 400 troops on a 4-tile front by ~50×.

### When a tile changes hands (`GameImpl.conquer`, `:799-821`)

Ownership moves, borders are recomputed for the tile and its 4 neighbours, and
**fallout is cleared**. Nuked land is self-repairing for whoever takes it.

**Structures on a captured tile** (`PlayerExecution.ts:57-78`): everything
transfers to the new owner at its current level — **except a Defense Post, which
is destroyed**. A structure whose tile becomes _unowned_ is destroyed outright.

### Disconnected territory

Non-contiguous territory is **not penalised at all** — no upkeep, no decay. Auto-
surrender requires a lot (`PlayerExecution.ts:379-514`), checked only every 20
ticks (every tick under 100 tiles): the cluster must be fully land-locked with no
unclaimed neighbours, bordered by exactly **one** enemy whose bounding box
encloses it, with no shore and no map edge, and `isEnclosed` must find no path to
water or the map edge through own-or-unclaimed land.

## 2.6 Amphibious assault

| Property         | Value                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Gold cost        | **0**                                                                                                                                    |
| Troop cost       | deducted at departure                                                                                                                    |
| Concurrent boats | **3** (`boatMaxNumber()`), 0 if TransportShip is disabled                                                                                |
| **Cooldown**     | **none — there is no boat cooldown anywhere in `src/core`**                                                                              |
| Speed            | 1 tile/tick, water A\*                                                                                                                   |
| Landing search   | nearest shore within manhattan **50** of the click, owned by the owner of the clicked tile, on a water component touching your shoreline |

**On arrival** (`TransportShipExecution.ts:239-292`):

- Target tile owned by **you** → treated as a return: **25% of the troops die**.
  This fires even on a normal outbound trip if you captured the landing tile by
  land in the meantime.
- Target friendly → troops returned — but note `conquer(dst)` runs **before** the
  friendly test (`TransportShipExecution.ts:271-274`), so **the landing tile is
  still taken from your friend**; only the follow-on attack is skipped.
- Otherwise → `conquer(dst)` — **the landing tile is taken free, no combat** —
  then a new `AttackExecution` with `sourceTile = dst` and `removeTroops = false`.

The resulting beachhead starts with a frontier of at most 4 tiles, so its
`borderSize` is tiny and it is **very slow** until it spreads.

Other paths: if the destination becomes water (nuked), the boat auto-retreats. If
no path is found, the boat is deleted and troops are returned **in full**.
`BoatRetreatExecution` has **no 20-tick delay** — it re-targets home immediately
and loses 25% on arrival, or returns everything if no retreat destination exists.

Nukes reduce the troop load of **every transport ship you own anywhere on the
map**, not just those in the blast (`NukeExecution.ts:448-461`).

## 2.7 Terra nullius vs a player

```
if (defender === null) {
  tickBudget = borderSize * 2
  attackerTroopLoss = mag / (attacker is Bot ? 10 : 5)
  defenderTroopLoss = 0
  tickFraction = clamp(2000 * tileCost / attackTroops, 5, 100) / tickBudget
}
```

|                              | TerraNullius                                                                | Player                                           |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| Attacker loss/tile           | **flat**: Plains 16, Highland 20, Mountain 24 (human/nation); half for bots | scales with troop ratio, density, territory size |
| Effect of stack size on loss | **none**                                                                    | bigger stack is cheaper per tile                 |
| Defender loss                | 0                                                                           | `troops / numTiles` per tile                     |
| Tick budget                  | `borderSize * 2` (**double**)                                               | 1                                                |
| Posts / fallout              | **still apply**                                                             | apply                                            |
| Traitor / territory curves   | do **not** apply                                                            | apply                                            |
| Retreat malus                | **0%**                                                                      | 25%                                              |

**The expansion speed saturates.** The per-tile cost clamps at 5 once
`attackTroops >= 400 * tileCost`:

| Terrain  | troops to saturate | max tiles/tick     |
| -------- | ------------------ | ------------------ |
| Plains   | 6,600              | `0.4 × borderSize` |
| Highland | 8,000              | `0.4 × borderSize` |
| Mountain | 10,000             | `0.4 × borderSize` |

Past ~10k troops, throwing more at neutral land buys nothing but more simultaneous
frontage. Confirmed by scenario data: 2k troops → 125 tiles in 25 ticks (5/tick);
20k troops → 1,250 tiles in 56 ticks (22/tick), not 10×.

An `AttackExecution` **can** expand into nuked neutral land (paying the 3–5×
fallout multiplier); only the AI avoids it.

## 2.8 Defense posts

| Property                       | Value                                          |
| ------------------------------ | ---------------------------------------------- |
| Range                          | **30** tiles, Euclidean (`distSquared <= 900`) |
| Attacker-loss multiplier       | **×5**                                         |
| Attacker-speed multiplier      | **×3** slower                                  |
| Cost                           | `min(250_000, (n+1) * 50_000)`                 |
| Build time                     | 50 ticks                                       |
| Min spacing from any structure | 15 tiles                                       |
| On tile capture                | **destroyed**, not captured                    |
| Upgradable                     | **no**                                         |

**Posts do not stack.** `defenderHasDefensePost` is a boolean that short-circuits
on the first match. Two overlapping posts give exactly the same 5×/3× as one. The
only value of extra posts is **coverage area** — and the scenario data proves it:
1 post at the border held a 10k attack to 39 tiles, 3 posts covering the whole
border held it to 25.

Under-construction posts do not count. A post must belong to the defender.

> **Defense posts never fire.** `DefensePostExecution.shoot()` has no live caller;
> the ship-targeting block is commented out (`:64-106`). `defensePostShellAttackRate()`
> and `defensePostTargettingRange()` are dead config.

## 2.9 Twenty things intuition gets wrong

1. **Attacks do not "win" — they burn out.** In PvP the stack is almost always
   fully consumed. Success returns nothing.
2. **Dropping below 1 troop destroys the attack and loses every remaining troop.**
   Retreating at 2% left refunds 75% of it.
3. **Frontage is the master speed variable.** Tiles/tick scales ~linearly with
   `borderSize`. A boat beachhead starts at ≤4 border tiles and is therefore
   glacial for its first ticks.
4. **Cancelling costs 20 frozen ticks _before_ the 25% tax.**
5. **Retreating from unclaimed land is free; from a player it costs 25%.**
6. **A new land attack eats your existing boat beachhead** against the same
   target — the merge checks _your_ `sourceTile`, not the victim's. The spread-out
   beachhead frontier is thrown away.
7. **Simultaneous opposing attacks annihilate 1:1** at creation. Attacking someone
   who is attacking you can cancel both stacks before a tile moves.
8. **Defense posts don't stack** — coverage, not density. And a post on a captured
   tile is destroyed, not captured.
9. **Posts and fallout slow you as much as they bleed you** (same multiplier on
   both terms).
10. **Defender per-tile loss is fixed at `troops/tiles`** regardless of everything
    else. A turtle with 10k troops/tile loses 10k per tile; a sprawler with 0.5
    loses 0 (floored).
11. **Troop density is the defender's real armour, not troop count.** The
    `0.0039 × density` term means 400k troops on 400 tiles costs an attacker
    ~194/tile; the same 400k on 20k tiles costs ~39/tile.
12. **Big empires are easier to attack AND better at attacking.**
    `largeTerritoryBonus` cuts attacker losses to 0.3× and speeds them up at giant
    size. This is deliberately anti-turtle.
13. **Bots only get the 0.7× discount as _defenders_ against Human/Nation
    attackers.** Bot-attacks-bot and bot-attacks-human get nothing.
14. **Spawn immunity binds only Human attackers.** Nations and Bots ignore it.
15. **Fewer than 100 defender tiles = instant elimination** on the next tile, and
    third parties grab the leftovers.
16. **You cannot steer an attack.** Only its start point and size.
17. **Conquering clears fallout.**
18. **Encirclement auto-capture is very hard to trigger** and is checked only
    every 20 ticks.
19. **Troops are floored bigints on the player but floats inside the attack.**
20. **There is no boat cooldown** — only the 3-boat cap.
