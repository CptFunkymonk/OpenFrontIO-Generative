# 09 — Playbook: spawn to last one standing

> **Everything in this chapter is [DERIVED]** — reasoning from the mechanics in
> chapters 01–07, not statements in the code. Where a claim rests on a specific
> formula, the chapter is cited. Treat it as a prior to be tested, not as fact.

## 9.1 The five facts that should drive every decision

1. **Territory is the win condition and territory does not make gold.** Passive
   income is flat 100/tick forever (§03). Expansion buys `maxTroops`, structure
   space, coastline, and victory — not income.
2. **Troops are cheap and time-bounded; `maxTroops` is the real constraint.**
   Troops refill to 99% of cap in **~500 ticks at spawn size, ~1,100 at a 1M cap,
   ~1,360 at 2M** (§03 table). Never hoard troops; a full pool is a wasted pool,
   because growth is zero at the cap and peaks at 42%.
3. **Frontage sets your speed in both directions.** `tickFraction` divides by
   `borderSize` (§02). Wide contact = fast conquest and fast collapse.
4. **One city level (+250,000 max troops) is worth roughly 5,100 tiles at
   mid-game margins** (§03). Cities are the only super-linear military purchase.
5. **A port with a ≥300-tile sea route is ~13× your entire economy; a port with a
   short coastal hop is worth 4%** (§03). Route length, not port count, is the
   economic game.

## 9.2 Phase 0 — spawn selection (ticks 0–200)

Nothing accrues during the spawn phase. Spend the whole 20 seconds choosing.

**Score a candidate on, in order:**

| Weight  | Criterion                                                                             | Mechanic                                                                |
| ------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Highest | Contiguous **unowned land** reachable in the first ~60 s                              | terra nullius is flat 16–24 troops/tile with zero defender loss (§02.7) |
| High    | **Coast on a large water component**, with a buildable shore tile within 20 manhattan | ports/trade/warships/boats all gate on it (§01.5)                       |
| High    | Low **border-to-area ratio** of the region you can plausibly claim                    | halving your border halves the rate you can be eaten (§02.5)            |
| Medium  | Distance to the nearest human or nation `spawnTile`                                   | manual picks have **no minimum distance** — proximity is a choice       |
| Medium  | Mountain/highland on the likely invasion axis, plains on your expansion axis          | terrain penalty is paid by the attacker (§01.2)                         |
| Low     | Map edge / impassable adjacency                                                       | exempts you from encirclement auto-annexation (§02.5)                   |

**Concrete heuristic:** click 4–5 tiles inland from a coastline that faces a large
ocean, with a bay or peninsula behind you and open neutral land in front. That
keeps the full 52-tile disc (§01.7), guarantees port access, minimises border, and
maximises free expansion.

**Manual vs random spawn.** Under `randomSpawn` all 52 tiles must be land, so you
are **never coastal at the start** and you cannot re-roll. Under manual spawn
there is no distance check at all — you can deliberately spawn on top of a weak
neighbour to snowball, or in a far corner to farm.

**Do not click impassable terrain.** The client gate uses `isLand`, which is true
for impassable, so the click succeeds and you end up owning only the valid subset
while your recorded `spawnTile` is a tile you do not own (§99).

## 9.3 Phase 1 — the land grab (ticks 200 → ~1,300)

**This is the highest-return phase in the game and it is short.**

The arithmetic: against terra nullius, attacker loss is a flat `mag/5` per tile —
16 on plains, 20 on highland, 24 on mountain — with **zero** defender loss, on a
**doubled** tick budget. Speed saturates once your stack exceeds `400 × tileCost`:
6,600 troops on plains.

**Therefore:**

- Attack neutral land **continuously**, in stacks of ~7,000–10,000. More than that
  buys nothing per attack (the cost clamps at 5) — it only buys more simultaneous
  frontage, which _does_ help, so run several attacks in parallel rather than one
  huge one.
- Take **whatever is adjacent, regardless of terrain.** Once your stack is above
  the clamp, terrain no longer slows neutral expansion at all. Terrain only starts
  to matter when you fight players or are troop-poor.
- **Keep your troop pool near 42% of max**, not near 100%. That is where regrowth
  peaks. A pool sitting at cap is producing nothing. Early on, with a cap near
  120k, a spent pool is back to 99% in ~500 ticks; later, at a 1–2M cap, budget
  1,100–1,400 ticks.
- Retreating from terra nullius is **free** — if an attack stalls on a bad
  frontier, cancel it and re-launch elsewhere at no cost.

**Do not build anything yet.** Nothing is worth buying before ~125,000 gold, which
arrives at tick ~1,250 on base income alone.

**Spawn immunity is 50 ticks and only binds humans.** Nations and bots will attack
you through it. Do not plan around it.

## 9.4 Phase 2 — the economic pivot (~tick 1,250 onward)

At 125,000 gold you make the single most consequential purchase of the game.

**If you have a coastline with a plausible ≥300-tile sea route: build a Port.**
Payback is ~9 seconds of operation (§03). Your income goes from 60,000/min to
~800,000/min. Every subsequent structure is 20–40 seconds away instead of minutes.

**If you are landlocked: build a Factory**, then a City within 110 tiles of it so
the factory has a trade destination. But note the trap: **Ports and Factories
share one cost ladder.** A Factory built first makes your first Port cost 250,000.
If you expect to reach a coast, buy the Port first even if it sits idle briefly.

**If your only water is a short coastal hop or a small lake: do not build a port
at all yet.** 62,370/min against a 60,000/min baseline is not worth 125,000 gold.
Build cities and fight instead.

**Then, in rough order:**

1. Ports until the global trade fleet saturation knee (~330 world ships) flattens
   the curve. Upgrade existing ports as readily as building new ones — port levels
   are superlinear because the pity counter climbs `level` times faster (§03).
2. Cities, once income is running. A city is a **military** purchase: zero gold,
   +250,000 max troops. At 800,000 gold/min a 1,000,000-gold city is ~75 seconds.
3. Factories only up to ~10 levels. Past that the `sat·F/(15(F+10))` asymptote
   makes each additional factory worth under 3% more trains (§03).
4. An early ally with a shared rail cluster: 35,000/stop instead of 10,000
   self-trade, **paid to both of you** (§03).

## 9.5 Phase 3 — fighting players

### Before you commit a stack

Compute, from §02:

```
troopRatio        = defender.troops / yourStack
attackerLoss/tile ≈ mag · clamp(troopRatio, 0.6, 2) · (0.463·bonuses + 0.0039·defenderDensity)
tiles/tick        ≈ borderSize / (speedCost · tileCost · bonuses)
tilesYouCanTake   ≈ yourStack / attackerLoss_per_tile
```

**Sanity checks before attacking:**

- Is `tilesYouCanTake` worth the entire stack? **You will spend all of it.** PvP
  attacks burn out; they do not return troops on success.
- Is the defender's **density** (`troops / tiles`) low? Density is their real
  armour. A sprawling empire at 0.5 troops/tile costs you ~39/tile; a turtle at
  1,000 troops/tile costs ~194/tile and loses nothing per tile (floored).
- Is there a **defense post** within 30 tiles of the front? That is ×5 losses and
  ×3 time. The scenario data: one post held a 10k attack to 39 tiles.
- Is the front **wide**? Attack across the widest contact you have; never open a
  second narrow front when you could widen an existing one.

### While attacking

- **Cancel before you die, not after.** Below 1 troop the attack deletes and you
  lose everything. Cancelling costs 20 frozen ticks and 25% of what remains. If
  an attack is clearly stalling, cancel it — at 20% remaining that is 15% of the
  original stack recovered instead of 0%.
- **Attacking someone who is attacking you annihilates both stacks 1:1** at
  creation time. That is either a disaster or a defensive tool, depending on which
  stack is bigger.
- **Do not launch a land attack at a target where you have a live beachhead.** The
  new attack absorbs and destroys the beachhead's spread-out frontier (§02.2).

### Finishing a player

Below 100 defender tiles the next tile triggers instant elimination — **and their
remaining tiles that do not touch you are handed to whichever third party borders
them.** If a rival shares a border with the corpse, finishing the kill feeds them.
Consider taking the bordering tiles first.

You collect 100% of a bot's or nation's gold, **50% of a human's** — and **0% if
that human never launched an attack** (the anti-farm rule).

### Amphibious play

Boats are **free in gold, capped at 3 concurrent, with no cooldown** (§02.6). The
landing tile is taken free with no combat. But the beachhead starts with a
≤4-tile frontier, so it is glacial until it spreads.

Use boats to:

- Open a second front on a player whose land border you cannot widen.
- Take an island or a disconnected landmass no one contests.
- Land behind a defense post's 30-tile radius.

Do not use boats as your main offensive — the frontier penalty is severe.

## 9.6 Phase 4 — diplomacy as a weapon

- **Ask AI nations for alliances early.** The earlygame free pass is the biggest
  single acceptance term and it closes at tick 1,800+spawn for Medium and Hard,
  and **tick 600+spawn for Impossible** (§06).
- **Bots accept every alliance request unconditionally.** Free allies, forever.
- **Target (`targetPlayer`) is how you command an AI ally.** Allies read your
  `targets()` and act on them, for attacks and for nukes. It costs −40 relation
  from the target and has a 150-tick cooldown.
- **🖕 to a nation is −100 relation instantly** — it drives them to Hostile, which
  triggers their auto-embargo, their `hated` attack strategy and their nuke
  targeting. It is a precision tool for pointing an AI at someone else.
- **Quick chat does literally nothing.** Do not spend intents on it.
- **Extend alliances late, not early.** `extend()` sets
  `expiresAt = now + duration` — agreeing early **truncates** your remaining time.

### The disconnection surface

`isFriendly` returns false for a disconnected player. So against a disconnected
ally or teammate you can attack with **no alliance break, no traitor mark**, and
against a disconnected **teammate** specifically, `mag = 0` — **the conquest costs
you zero troops** and you inherit their warships and transports (§06.5).

### Betrayal arithmetic

Being a traitor costs you 30 seconds during which attackers lose **half** the
troops and move **25% faster** against you, plus −100 from the victim and −40 from
every nearby non-teammate. Breaking with an already-traitor or disconnected player
costs **nothing at all**.

Time a betrayal so the 300 ticks expire before anyone can mount a real offensive,
and never betray while you have an exposed border with a third party.

## 9.7 Phase 5 — staying out of the crosshairs

Nation AI targets you by measurable thresholds. Stay outside them:

| Threshold                                                                      | Stay                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `veryWeak`: `troops < maxTroops × 0.15`                                        | **above 15% of your cap**                              |
| `juicy`: `troops <= theirs × 0.75`                                             | **above 75% of the strongest neighbour's troops**      |
| `victim`: incoming attacks `> your troops × 0.5`                               | do not let attacks pile up                             |
| FFA nuke crown gap: Easy 40% / Med 30% / Hard 20% / **Imp 10%** land lead      | below the gap, or accept nukes                         |
| MIRV victory denial: Easy 75% / Med 65% / Hard 55% / **Imp 40%** of total land | **crossing 40% invites a MIRV in an Impossible lobby** |
| MIRV steamroll: cities > 8–20 **and** ≥1.15–2× second place                    | do not lead cities by that margin                      |

Conversely, **to freeze a Hard/Impossible nation**: park a large stack on its
border (`troopSendCap` retains 75–90% of the strongest neighbour's troops), and
leave unowned land touching it (terra nullius short-circuits its decision tick
before any attack strategy runs).

## 9.8 Phase 6 — the endgame

The bar is **80% of non-fallout land**, checked once per second, strict `>`.

**Three levers:**

1. **The denominator excludes fallout.** Nuking _neutral_ land permanently removes
   it from the win denominator (fallout never decays). If you hold the most
   remaining land, every neutral tile you irradiate moves the bar toward you. This
   is the most under-appreciated mechanic in the game.
2. **Overtime, if enabled, drops the bar 2 points per minute** after
   `startMinutes`, floored at 0. A stalled game always ends — position to be the
   tile leader when the bar falls past you.
3. **The hard finish at 170 minutes** awards the game to whoever leads. Any
   `maxTimerValue` does the same, earlier.

**Nuclear endgame:**

- MIRV is **uninterceptable** and drives a target to 3% of max troops, map-wide,
  including every transport they own. It is the hard counter to a turtle. It costs
  25M and raises the global price by 15M for everyone.
- SAMs are deterministic — no interception roll. Build them for **coverage of the
  targetable window** (within 150 of your own structures), not density. A level-1
  SAM has range 70 and sits inside a hydrogen bomb's 100-tile outer radius.
- Silos hold `level` missiles with a 90-tick reload. Upgrade one silo to level 3+
  rather than building three, unless you need geographic spread (nuke flight time
  is arc length ÷ speed, and a distant silo has an untargetable midcourse).

**Winning is a vote.** Your client's `WinUpdate` has to survive an IP-weighted
tally — `votes × 2 > totalUniqueIPs`. In a 1v1, **both players must agree**, and a
desynced client's vote is discarded. If your agent desyncs, it cannot be recorded
as the winner even if it held 100% of the map.

## 9.9 A decision loop you can implement

Once per decision cycle (every ~10–20 ticks; you have 10 intents/s, 150/min):

```
1. OBSERVE
   merge PlayerUpdate diffs; apply packedPlayerUpdates and packedTileUpdates
   me = {tiles, troops, maxTroops, gold, units, outgoingAttacks, incomingAttacks}

2. SAFETY
   if incomingAttackTroops > troops * 0.35 and Hard/Impossible neighbours exist:
        build a Defense Post covering the widest threatened border segment
   if troops / maxTroops < 0.15:  stop attacking, let regrowth run
   if any outgoing attack has troops < 5% of its start:  cancel_attack

3. ECONOMY   (gold is the gate, not troops)
   if no Port and a shore tile exists with a >=300-tile route:  build Port
   elif gold >= nextCityCost and income is running:             build/upgrade City
   elif landlocked and factories < ~10 levels:                  build Factory + City
   elif gold >= samCost and enemy silos exist within ~150:      build SAM

4. EXPANSION  (troops are the gate, not gold)
   if terra nullius borders me and troops > 7000:
        attack(targetID=null, troops = min(troops*0.4, 12000))   // run 2-3 in parallel
        -> this is almost always the highest-value action available

5. AGGRESSION  (only when 3 and 4 are exhausted)
   score each bordering enemy by:
        density = troops / tiles          (lower is better)
        sharedBorder width                (wider is better)
        hasDefensePost within 30          (disqualifying unless you must)
        isTraitor / isDisconnected        (0.5x loss / 0x loss)
   attack the best if projected tiles gained justifies the whole stack

6. DIPLOMACY  (cheap, do it every cycle)
   allianceRequest to every bordering nation while tick < 1800 + spawnTicks
   targetPlayer(x) to point allies at your chosen enemy
   extend alliances only inside the last 30 ticks of their window

7. ENDGAME
   if myShare > 0.5 * remainingLand:  nuke NEUTRAL land to shrink the denominator
   if a rival crosses the MIRV thresholds: let the AI handle them, stay under the bar
```

## 9.10 Ten exploits worth knowing

1. **Free alliance with every bot in the lobby** — they accept unconditionally.
2. **Zero-cost conquest of disconnected teammates** (`mag = 0`), and you inherit
   their fleet.
3. **Free alliance-breaking** against anyone already a traitor or disconnected.
4. **Freeze Hard/Impossible nations** by leaving neutral land on their border.
5. **Free retreats from terra nullius** — cancel and re-aim at no cost.
6. **Fallout shrinks the win denominator** permanently and never decays.
7. **Coast-hugging trade ships are almost unpiratable** (`safeFromPirates` refreshes
   on every shoreline water tile).
8. **Mutual attack annihilation** — attacking an incoming attacker cancels both
   stacks 1:1 before a tile moves.
9. **Upgrade, don't build**: placing a structure within 15 tiles of your own same
   type silently becomes an upgrade at the same ladder price — and city _levels_,
   not city _count_, drive `maxTroops`.
10. **Structures survive capture** (except defense posts), so taking a developed
    enemy tile hands you the city, port, factory, silo or SAM standing on it, at
    its current level.
