# 13 — Mechanics, pinned

> Every mechanic the agent relies on, checked against the real simulation by a
> scenario test in `tests/agent/mechanics/`. Written 2026-09-26 at commit
> `f33c228` by twelve pinning agents, each challenged by two skeptics (one
> re-deriving the truth from source, one trying to break the test), with
> disputes resolved. Where this chapter and chapters 00–09 disagree, this one
> is right; where it and the code disagree, the tests say which. Roadmap
> [§11.3](11-roadmap.md) quotes the hypotheses; §3 below corrects them.

**Date:** 2026-09-26.

**Setting pinned throughout:**

- FFA, `GameType.Singleplayer`, `Difficulty.Impossible`, the map's default nations, 400 tribes, Normal map size.
- The real `Config` class, as `createGameRunner` builds it for the arena. `TestConfig` is not used.

**Sources:** twelve claims from `docs/11-roadmap.md` section 11.3 were pinned with scenario tests in `tests/agent/mechanics/`. Skeptics challenged each one, and the disputes were resolved (the resolved verdicts are the ones below).

**Line numbers:** `file:line` cites refer to the working tree on this date. `src/core` has no uncommitted edits, so its cites are stable. `src/agent/arena` line numbers were re-read today.

---

## 0. Test status

| Check                                        | Result                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `npx vitest tests/agent/mechanics --run`     | 17 files, 292 tests, all pass. Run 5 times with identical results (about 31 s wall time on each run). |
| `npx tsc --noEmit -p . \| grep mechanics`    | no output (no type errors in these files)                                                             |
| `npx oxlint tests/agent/mechanics`           | exit 0                                                                                                |
| `npx eslint tests/agent/mechanics`           | exit 0                                                                                                |
| `npx prettier --check tests/agent/mechanics` | "All matched files use Prettier code style!"                                                          |

No test failed or was flaky, so no file was edited.

**Timing:**

- Every test that runs longer than about 1 s sets an explicit timeout:
  - `EconomyGold`, `NationTargeting` and `TribeStats`: 60 s on their real-game hooks and tests.
  - `SpawnPhaseSingleplayer`: 20 s per test.
  - `NationParams`: 120 s per test.
- So none of them can hit Vitest's 5 s default.
- One file breaks the 20 s budget: `NationParams.test.ts`, which is not one of the twelve (see the appendix). Under parallel load it takes 21-26 s for the file.
- The slowest single test is `EconomyGold`'s real-game test at about 11 s.

The twelve pins:

| #   | Hypothesis                            | Test file                        | Tests | Verdict                                                                           |
| --- | ------------------------------------- | -------------------------------- | ----- | --------------------------------------------------------------------------------- |
| 1   | H1 spawn phase                        | `SpawnPhaseSingleplayer.test.ts` | 12    | PARTIAL                                                                           |
| 2   | H2 free-land cost                     | `FreeLandCost.test.ts`           | 12    | TRUE (refined)                                                                    |
| 3   | 11.3 preamble, H3, H9: attack merging | `AttackMerge.test.ts`            | 28    | TRUE for the claim; the test also found a troop-duplication bug in the simulation |
| 4   | H3 player attack speed                | `PlayerAttackSpeed.test.ts`      | 12    | PARTIAL (the 1.6x holds on plains only)                                           |
| 5   | H3 tribes                             | `TribeStats.test.ts`             | 24    | PARTIAL                                                                           |
| 6   | H4 send cap                           | `NationSendCap.test.ts`          | 32    | PARTIAL                                                                           |
| 7   | H4 targeting                          | `NationTargeting.test.ts`        | 33    | PARTIAL                                                                           |
| 8   | H5 retaliation                        | `NationRetaliate.test.ts`        | 13    | PARTIAL                                                                           |
| 9   | H6 alliances                          | `NationAlliance.test.ts`         | 33    | PARTIAL                                                                           |
| 10  | H7 gold                               | `EconomyGold.test.ts`            | 16    | PARTIAL                                                                           |
| 11  | H8 nukes                              | `NukeThreat.test.ts`             | 30    | PARTIAL                                                                           |
| 12  | H9 boats and the win                  | `BoatsAndWin.test.ts`            | 22    | PARTIAL                                                                           |

All test files are in `/home/user/OpenFrontIO-Generative/tests/agent/mechanics/`.

---

## 1. Headline findings (what changes the plan)

1. **A spawn sent in turn 1 beats every nation to the ground.** The agent's first call is at `ctx.tick === 1`. There, `ctx.fork().advance(2)` (about 150 ms on World) shows the real tribes and each nation's first pick. A spawn sent in that call lands in tick 2, before every nation, and ends the phase.
   - Every nation then lands on its tick-1 pick with only the free part of its disc.
   - A nation whose disc we cover completely is never placed: one Impossible opponent and its 31,250 troops disappear.
   - From turn 2 on, the nations land first. (SpawnPhaseSingleplayer, cases 9-12.)
2. **Any player at 100 tiles or fewer is annexed by the loss of one tile.** If a tile loss leaves a player under 100 tiles, the attacker takes it whole, with all of a tribe's or nation's gold (`AttackExecution.ts:448-482`). The first tile is always taken whatever it costs, so the price is min(stack, one tile's loss).
   - This makes a 1-troop attack a kill on a fresh 52-tile tribe.
   - It also makes any attack of 1 troop or more a kill on us while we hold 100 tiles or fewer.
   - Tribes and nations ignore spawn immunity, because only human attackers respect it (`PlayerImpl.ts:1917-1926`). (TribeStats.)
3. **Our home troops throttle the nations we border.** A nation sends at most `T - ceil(0.9 x H)`, where H is our home troops, and never less than 20% of the target's troops (`AiAttackBehavior.ts:961-1032`).
   - At H above about T/1.1, a bordering nation cannot attack us by land.
   - At H of T/0.9 or more (about 1.11 T), it cannot attack tribes either; it only trickles `ceil(5% of T)` into free land each decision.
   - All of this holds only while nothing is attacking that nation. Any incoming attack on it, a tribe's included, lifts the floor and raises the cap to at least the incoming total. (NationSendCap, TribeStats.)
4. **Touching a nation at all is expensive.** A 100-troop poke, or a boat landing with 0 troops, has these effects:
   - The nation embargoes us for 3,001 ticks.
   - Its relation to us drops to -100, which is Hostile for 1,001 ticks. The `hated` strategy then reaches us by boat at up to 3x its troops.
   - The poke lifts its 20% floor, and it retaliates first at its next decision.
     (NationSendCap, NationTargeting, NationRetaliate, EconomyGold, BoatsAndWin.)
5. **Free land and tribe attacks:**
   - Free land costs a flat 16, 20 or 24 per tile on plains, highland or mountain.
   - It saturates at 6,600, 8,000 or 10,000 troops, at 0.4 tiles per border tile per tick.
   - Player tiles at a stack of 1.22x the defender or more are 1.58x faster only on plains: 1.30x on highland, 1.04x on mountains. (FreeLandCost, PlayerAttackSpeed.)
6. **Alliances are not a shield.**
   - An Impossible ally above its reserve betrays and attacks a weak ally in the same decision, for example if we are its only neighbour with home troops under 1/3 of its troops.
   - A MIRV targets allies too.
   - An extension is re-decided in full: with a second non-allied neighbour, the nation refuses to extend unless we are a threat or its relation to us is Friendly. (NationAlliance, NukeThreat.)
7. **Owning a SAM invites an atom salvo aimed at the SAM tile.** The salvo ignores the clear-land rings; in a pinned case a nation blasted 304 of its own tiles. Hydro nations do this too. (NukeThreat.)
8. **The simulation duplicates troops at one tick.**
   - The bug: suppose a land click on a target inits exactly 20 ticks after a `cancel_attack` on our attack on that target inits. The new attack keeps the whole stack, and the old attack's retreat refund is paid anyway: 175% of the stack against a player, 200% against free land.
   - A fixed 10- or 20-tick decision cadence can hit this by accident.
   - The troop cap limits how much of the refund stays at home (`TroopCapClamp.test.ts`).
   - Exploiting it would inflate results against nations; a human has to decide whether that is allowed. (AttackMerge.)
9. **An arena game has one win condition: more than 80% of non-fallout land before the cap.** The cap is 36,000 absolute ticks by default, spawn phase included. Otherwise the game is recorded as a "timeout". WinCheck's 170-minute rule never fires in the arena. (BoatsAndWin.)
10. **Nations get their early gold from tribes.** On World, 67 of 72 nations bought a City before tick 1,255, the first at tick 471. Each Impossible City level is worth 312,500 of cap. (EconomyGold.)
11. **Every nation decides on a fixed, replayable schedule:** once every 30-49 ticks, at a fixed phase that is seeded by the gameID and the nation's id. Between decisions it cannot react, which leaves windows an agent can compute. (NationTargeting, NationRetaliate, and `NationParams.test.ts`.)

---

## 2. Per-claim findings

### 2.1 H1 — the singleplayer spawn phase (`SpawnPhaseSingleplayer.test.ts`)

**Claim:** the spawn phase ends only when our seat spawns (`SpawnExecution.tick`), so the choice is untimed and nothing grows until then. Tribes are placed on the first tick. Nations spawn within ±25 tiles of their manifest positions (`NationExecution.randomSpawnLand`).

**VERDICT: PARTIAL.**

**Truth:**

- **No timer (TRUE).**
  - `SpawnTimerExecution` is added only when the game is not Singleplayer (`GameRunner.ts:170-173`).
  - The phase ends only in `SpawnExecution.tick`, when a Human spawns (`SpawnExecution.ts:121-128`).
  - `numSpawnPhaseTurns()` still returns 100 (`Config.ts:856-859`), but no timer uses it.
- **Nothing grows (TRUE).**
  - `PlayerExecution`, `TribeExecution` and `AttackExecution` are inactive during the phase (`PlayerExecution.ts:44`, `TribeExecution.ts:43`, `AttackExecution.ts:71`; `GameImpl.ts:529-547`).
  - Attack intents from any turn up to the landing turn are held back. They are initialised together at the end of the landing tick and merge into one attack (`AttackExecution.ts:171-180`).
- **Waiting is not free.** `ticks()` keeps counting through the phase, and several rules read absolute ticks:
  - Alliance requests created at tick 101 or earlier are rejected (`NationAllianceBehavior.ts:64-70`).
  - Impossible nations' 30% early acceptance ends at tick 700 (`:218-245`).
  - The arena cap counts absolute ticks (`ArenaGame.ts:363`, `Arena.ts:401, :626`).
  - Spawn immunity and `elapsedGameSeconds` start at the end of the phase (`GameImpl.ts:959-983`).
- **Tribes (PARTIAL: tick 1, not tick 0).**
  - Tick 0 only initialises their spawn executions, and all 400 land in tick 1.
  - Each needs its whole disc to be free, and its centre must not be a border tile. They are kept at least 30 apart (Manhattan) for the first 750 of 1,000 tries (`SpawnExecution.ts:153-192`, `Config.ts:823-825`).
- **Nations (PARTIAL).**
  - They pick a tile in tick 1, before the tribes exist, and land in tick 2.
  - The pick is `nextInt(c-25, c+25)`, which excludes its upper bound (`PseudoRandom.ts:61-65`), so each axis spans [c-25, c+24] (`NationExecution.ts:282-311`).
  - While the phase lasts they hop to a new pick every `attackRate` ticks, 30 to 49 (`:102-103`, `:127-134`). If all 50 tries of `randomSpawnLand` fail, that hop is skipped and the gap doubles (`:169-174`).
  - Nations with no manifest coordinates pick anywhere on the map (`:136-143`). This happens on dyslexdria, milkyway, morethanluck, titan and worldinverted.
  - On seed SPAWNPIN (World), 19 of 72 nations have fewer than 52 tiles after tick 2. For 9 of them tribes took part of the disc; the other 10 lost tiles only to terrain.
- **Turn-1 pre-emption (new).**
  - `deliver` queues an intent for turn `executed - 1 + max(1, latency)` (`ArenaGame.ts:268-269`), so turn 1 is the earliest turn the agent can use.
  - That turn's executions are queued before tick 1 runs (`GameRunner.ts:209-211`). The nations' first spawn executions are queued only during tick 1 (`NationExecution.ts:168-179`). Queued executions are initialised in order (`GameImpl.ts:537-551`).
  - So our spawn lands first, in tick 2, and ends the phase.
  - The nations then land as internal spawns on their frozen tick-1 picks, keeping only the free part of their disc.
  - A nation whose disc we cover entirely logs `cannot spawn`, never retries (`NationExecution.ts:183-186`), and has `isAlive() === false`.
  - Tribes land in tick 1, so they can never be pre-empted.
- **Our disc.**
  - It has 52 tiles: x-4..x+3 by y-4..y+3, minus 3 tiles at each corner (`GameMap.ts:715-735`, `execution/Util.ts:140-159`).
  - We get only the tiles that are unowned, land and passable (`SpawnExecution.getSpawn`, `:139-148`). The centre's owner and terrain are not checked.
  - A disc with no free tile fails with a warning and the phase stays open (`:102-106`).
  - If two spawns arrive in one turn, the last one wins (`:96-97`).
  - A spawn intent initialised after the phase has ended is dropped (`:57, :87-89`).
- **Starting troops (TRUE):** 25,000 for us, 31,250 for an Impossible nation, 10,000 for a tribe (`Config.ts:1003-1022`).
- **Spawn immunity** lasts 50 ticks from the end of the phase (`Config.ts:189, :335-342`), but only human attackers respect it (`PlayerImpl.ts:1907-1926`). So we cannot attack nations for 50 ticks, while nations and tribes can attack us at once.

**Test:** 12 cases on World, built as the arena builds it:

- **Setting:** no timer, 72 nations on their manifest cells.
- **Placement without a turn-1 spawn:** tick 0 places nothing, tick 1 places 400 full tribe discs, and tick 2 places the nations, with every shortfall classified.
- **Frozen:** 1,000 ticks without our spawn. Nothing grows, and every nation stays inside [c-25, c+24] with a constant hop period.
- **Our spawn:** the exact 52-tile disc. Attacks sent in three turns merge into one 10,000-troop attack, the nations open with `startManpower/2`, and immunity lasts 50 ticks.
- **Overlaps:**
  - A spawn on a tribe's centre fails silently. A retry 3 tiles east takes 24 tiles.
  - A spawn on a water centre gets only the land.
  - A hop decided in our spawn tick lands one tick after the phase ends.
- **Turn 1 through the real `AgentHost`:**
  - Covering a nation's full disc erases it for good.
  - A spawn 3 tiles east of a nation's pick leaves it 24 tiles.
  - Turn 2 is too late.
  - With two spawns in one turn, the last one wins.

**Agent implications:**

- **Spawn in turn 1.** At `ctx.tick === 1`, fork and advance 2 ticks, score sites on the exact tribe and nation layout, then send the spawn.
- **Either cover a nation's full disc or keep away from it.** A partial overlap leaves a 24-tile nation on our border with 31,250 troops and a 15,625-troop opener.
- **Check `hasSpawned()` and resend if the spawn failed.** Send one spawn per turn.
- **Send the opening attack in the spawn turn.** It inits at the end of the landing tick and moves one tick before the nations' openers.
- **Model a nation as present only if `hasSpawned() && isAlive()`.**
- **Nothing protects us after the phase,** so passing 100 tiles quickly is urgent (section 2.5).

**Open:**

- One seed and one map were used.
- It is not verified that the browser autopilot can reach turn 1.
- Whether an erased nation affects anything that counts nations is not checked.

### 2.2 H2 — free-land attack cost and speed (`FreeLandCost.test.ts`)

**Claim:** free land costs a flat 16, 20 or 24 troops per plains, highland or mountain tile. The speed saturates at 400 x tileCost troops (6,600 on plains), and beyond that only frontage adds speed.

**VERDICT: TRUE,** with refinements.

**Truth:**

- **Terrain classes.** `GameMapImpl.terrainType` (`GameMap.ts:397-407`) sorts land by magnitude: 0-9 plains, 10-19 highland, 20-30 mountain, 31 impassable.
- **Base values.** `terrainAttackBase` (`Config.ts:172-188`) gives mag / tileCost of 80 / 16.5, 100 / 20 and 120 / 25.
- **The free-land branch of `Config.attackLogic`** (`Config.ts:896-909`, constants at `:136-138`):
  - `attackerTroopLoss = mag / 5`, which is 16, 20 or 24, for a Human or a Nation. A tribe pays `mag / 10` (8, 10 or 12). It depends on neither stack size nor frontage.
  - `tickFraction = within(2000 x tileCost / troops, 5, 100) / (2 x borderSize)`.
- **Saturation uses tileCost, not the loss:** exactly 6,600, 8,000 or 10,000 troops (400 x tileCost). Below 20 x tileCost troops (330, 400 or 500), the cost per tile stops rising.
- **Defense posts** need `defender !== null`, so they never apply to free land (`Config.ts:886`).
- **Fallout** multiplies both mag and tileCost by `5 - 2 x falloutRatio` (`Config.ts:890-894`, `:362-366`), and moves saturation to that multiple of 400 x tileCost.
- **The tick loop** (`AttackExecution.ts:258-343`):
  - Frontage is `b = borderSize + nextInt(0, 5)`, drawn once per tick. The jitter is 0 to 4 (`:291`).
  - The budget resets to 1 each tick, and at least one tile is taken per tick (`:293-295`).
  - Each tile is costed on the live, shrinking stack (`:329-336`).
  - A stack under 1 troop is deleted with no refund (`:296-300`).
  - With no free land left, the stack retreats and is refunded in full (`:302-306`).
- **Tiles per tick:**
  - saturated: `ceil(0.4 x b)`
  - linear region: about `b x T / (1000 x tileCost)`
  - floor: `ceil(b / 50)`
  - never fewer than 1

**Test:** 12 cases.

- **Pure-function cases:** class boundaries, purity, loss per tile for each attacker type, saturation and floor, proportionality in the linear region, and the fallout multiplier.
- **Simulation cases:** the stack drops by exactly tiles x loss. Stacks of 10x and 1000x saturation take identical tiles on every tick. The simulation matches a replay of the loop tick for tick.
- **First-tick table:** a 100-tile front takes 40, 39, 20, 10 or 2 tiles for stacks of 660k, 6,600, 3,300, 1,650 or 330.
- **Floor case:** 400 troops take 25 ticks on a 4-tile front and 6 on a 200-tile front. That refutes docs/02 §2.5's "~50x".
- **End of an attack:** a stack runs dry and dies with no refund; a closed pocket refunds the surplus.

**Agent implications:**

- **Land yield is fixed.** A stack of S troops buys S/16 plains tiles, S/20 highland tiles or S/24 mountain tiles. Only the speed varies.
- **Staying saturated for a whole tick** needs at least `6,600 + 16 x ceil(0.4 x b)` troops on plains (10,000+ on mountains). More troops add no speed; they only keep the stack saturated longer.
- **Below saturation the stack decays exponentially,** with a time constant of about 1031/b ticks on plains.
- **Frontage is the only lever at saturation.** A re-click re-seeds the attack from our whole border.
- **Traps:**
  - fallout costs up to 5x
  - troops leave in the intent's tick, and the first tile falls in the next tick
  - tiny stacks still take 1 tile per tick

**Open:**

- Mixed-terrain fronts were not run.
- Fallout was checked only in the pure function, not with a real nuke.
- Frontage on real, blob-shaped spawns was not measured.

### 2.3 Section 11.3 preamble, H3, H9 — attack merging, cancelling, retreat (`AttackMerge.test.ts`)

**Claim:** a new land attack (`sourceTile === null`) absorbs every earlier attack of ours on the same target. Parallel land attacks on one target therefore buy nothing, while attacks on different targets never merge. A new attack on a player that is attacking us cancels troops 1:1 at creation. A later land attack absorbs a boat landing's attack.

**VERDICT: TRUE for the claim.** The test also found a troop-duplication bug in the simulation.

**Truth:**

- **The merge** (`AttackExecution.ts:171-181`) absorbs land attacks, boat landings, attacks that are retreating and attacks that have already retreated. A boat landing never absorbs anything.
- **Cancellation** (`:157-170`):
  - Opposing attacks cancel 1:1 when the new one initialises. The smaller one is deleted, with no refund (`AttackImpl.delete`, `AttackImpl.ts:60-73`).
  - A lost counter still applies the embargo, the rejection of alliance requests and the attack stats (`:113-123`, `:155`). Only the relation penalty is skipped.
- **The merged attack** seeds itself from every border tile we own, the beachhead included. That refutes docs/02 §2.3 item 6 and docs/09 ("the beachhead frontier is thrown away").
- **Retreat:**
  - `cancel_attack` creates a `RetreatExecution` with `cancelDelay = 20` (`RetreatExecution.ts:11`, `:23-37`). In the step where `ticks() >= startTick + 20`, it calls `executeRetreat` (`PlayerImpl.ts:714-721`), which sets the retreated flag.
  - The retreat pays troops minus `malusForRetreat`: 25% against a player (`AttackExecution.ts:37`), 0% against free land (`:224-256`).
- **The bug.**
  - `AttackImpl.delete` leaves both `troops()` and `_retreated` as they are.
  - `AttackExecution.tick` checks `retreated()` (`:266-274`) before `!isActive()` (`:280-283`).
  - Within a step, running executions tick first, then new ones init (`GameImpl.ts:526-551`).
  - Suppose a re-click on the same target inits in the step where the retreat fires, exactly 20 steps after the cancel. It absorbs an attack that has already retreated. On the next tick, the absorbed execution refunds that stack anyway, while the merged attack keeps it:
    - Against a nation: a frozen stack of 17,262.56 gives +12,946 at home, and the merged attack still holds 16,654.
    - Against free land: +19,376 at home, and the merged attack keeps 19,216.
  - The re-click's timing decides the outcome:
    - 1-19 steps after the cancel: a clean rescue, with no refund. The old execution is leaked but has no effect.
    - 21 steps or more: the refund comes first, and there is nothing left to absorb.
  - The same hole exists when an enemy attack cancels our retreated attack in that step.
- **The cap limits the gain.** Above the cap, `troopIncreaseRate` returns `max - T` (`Config.ts:1089`), so home troops are cut back to `ceil(max)` on the next tick (`TroopCapClamp.test.ts`). The duplicated stack inside the attack is not capped.

**Test:** 28 cases.

- **Merge and cancel rules:**
  - Land attacks, boats and retreating attacks are absorbed.
  - Different targets stay parallel.
  - Cancellation both ways and ties.
  - The embargo and relation effects of a lost counter.
  - The re-seeded frontier.
- **The retreat flag:** it is set 20 steps after the cancel inits.
- **Re-click timing:** 19, 20 and 21 steps, against a nation and against free land.
- **Repeats:** three duplication cycles.
- **Regrowth interplay:** with regrowth running, the refund stays at or below `maxTroops`.
- **Enemy counter:** an enemy counter at 19 steps and at 20 steps.
- **Mutation checks:** six source mutations each fail at least one case.

**Agent implications:**

- **Keep one land stack per target and top it up by re-clicking.** Get parallelism only from different targets or from boat landings.
- **Counter only with more troops than their current stack.** A lost counter loses everything sent and still costs the embargo.
- **A rescue re-click must init 1 to 19 steps after the cancel.** Track the newest attack id, since `cancel_attack` with an id that has been absorbed does nothing.
- **Never let a re-click on a cancelled target init exactly 20 steps after the cancel,** or model the duplicate refund in the troop accounting. Exploiting the bug needs a human decision; we recommend forbidding it and reporting it upstream.

**Open:**

- The same hole via `cancel_boat` followed by a land click at 20 steps is untested. By the code it gives a 100% refund.
- Whether the rate limiter in `AgentHost` can move an intent onto the 20-step case is unexamined.

### 2.4 H3 — speed of player attacks compared with free land (`PlayerAttackSpeed.test.ts`)

**Claim:** against a tribe or a nation, a stack of at least 1.22x the defender's troops takes tiles about 1.6x faster per border tile than free land. `speedCost` bottoms out at a troop ratio of 0.82, which gives about 0.63 tiles per tick per border tile against free land's 0.4.

**VERDICT: PARTIAL.** Every number is exact on plains. The edge is 1.30x on highland and 1.04x on mountains.

**Truth:**

- **Speed** (`Config.ts:955-972`):
  - `speedCost = within(r, 0.82, 7.5) x within(r/20, 1, 50) / 8.55`, with `r = defender troops / stack`.
  - The per-tile cost is `speedCost x tileCost x bonuses x traitorFactor / borderSize`.
  - For r ≤ 0.82 (a stack of at least 1/0.82 = 1.2195x the defender), the pace is `8.55 / (0.82 x tileCost)` per border tile: 0.632 on plains, 0.521 on highland, 0.417 on mountains.
  - Free land saturates at 0.4 on every terrain, so the ratios are 1.58, 1.30 and 1.04.
  - Speed does not depend on density or player type. The pace falls as 1/r up to r = 7.5, is flat to 20, then falls again.
- **Break-even with saturated free land:** r = 1.295 on plains, i.e. a stack of 0.77x the defender. On mountains the stack must be 1.17x.
- **Losses per tile** (`Config.ts:937, :943-949`):
  - The attacker loses `mag x within(r, 0.6, 2) x (0.463 x bonuses + 0.0039 x density)`, as a float.
  - The defender loses `floor(density)`, with density = troops / tiles (`PlayerImpl.removeTroops`, `:1376-1383`). A defender with density under 1 loses nothing.
  - The x0.7 on attacker loss (`Config.ts:914-921`) applies only when a Human or a Nation attacks a Bot. It changes neither speed nor the defender's loss.
- **Defense post:** x3 cost and x5 attacker loss (`Config.ts:886-889`, `:381-387`), which brings the pace down to 0.21.
- **Traitor defender:** x0.8 cost and x0.5 attacker loss (`Config.ts:287-292`, `:933-934`).
- **Large territories:** the bonuses (`Config.ts:160-170`) change the pace by less than 0.2% while both sides hold under 20k tiles. A 300k-tile attacker is 1.57x faster.
- **Narrow fronts:** with the 0..4 jitter and rounding up, a 1-tile contact takes 1 to 4 tiles a tick.

**Test:** 12 cases.

- **Pure-function cases:**
  - the floor
  - the shape of the curve
  - the free-land ratio for each terrain, and break-even
  - tiles per tick on fronts of 1-8 tiles
  - the territory bonuses
  - the post and traitor multipliers
  - the loss grid (0.463 and 0.0039 recovered from the function)
  - the x0.7 matrix
  - free-land losses
- **Simulation cases** (a 100-tile straight front):
  - A pace of 0.6388 against 0.4018 (ratio 1.59), with tribes and nations gaining the same tiles.
  - Exact loss sums on both sides.
  - A tribe at density 0.5 loses more than 100 tiles and keeps all its troops.

**Agent implications:**

- **Stack size:**
  - At 1.22x the target's live home troops the attack reaches its top speed. At 1.67x (r ≤ 0.6) it also pays the lowest loss per tile.
  - More buys nothing, but launch with a margin: r drifts up during an attack against nations with density under about 31 and tribes with density under about 20.
- **Cost per tile at r ≤ 0.6 on plains:**
  - tribe: 15.6 + 0.131 x density
  - nation: 22.2 + 0.187 x density
  - free land: 16
- **Terrain:** the speed edge over free land is a plains fact; on mountains it is gone.
- **Predict with `config().attackLogic()`,** which is pure; the simulation matches it tile for tile.

**Open:**

- No regrowth ran in these scenarios (in a real game the defender regrows and r rises).
- Only straight fronts were run.
- Nation and Bot attackers were checked only in the pure function.

### 2.5 H3 — tribes (`TribeStats.test.ts`)

**Claim:** there are 400 tribes, each with a third of a player's cap and half the regrowth. Human and Nation attackers pay x0.7 losses against them. Once free land runs out, Impossible nations attack up to 100 tribes at once. Also asked: what tribes do, and how fast nations eat them.

**VERDICT: PARTIAL.**

**Truth:**

- **400 tribes (TRUE).**
  - The default comes from `Arena.ts:399` and `SinglePlayerModal.ts:99`; the schema maximum is 400 (`Schemas.ts:534`). They are created in `GameRunner.ts:180-184`.
  - Each starts with a 52-tile disc, 10,000 troops and 0 gold.
- **A third of the cap (TRUE).** `maxTroops` is divided by 3 for a Bot (`Config.ts:1036-1037`).
- **Half the regrowth (PARTIAL).** The rate is multiplied by 0.5, but on the tribe's own, smaller cap (`Config.ts:1066-1068`).
  - At equal troops T and tiles, the ratio to our rate is `0.5 x (1 - 3T/M) / (1 - T/M)`, where M is our cap. That is 0.5 at T = 0, 0.41 for a fresh tribe, and 0 at the tribe's cap.
  - Gold is 50 a tick against our 100 (`Config.ts:1092-1101`).
- **x0.7 (TRUE, narrow).**
  - It applies only to the attacker's loss, and only for Human or Nation attackers (`Config.ts:135, :914-921`).
  - On free land a tribe pays mag/10 per tile against mag/5 for everyone else (`Config.ts:899`).
  - At a stack of at least the tribe's troops / 0.6, a tribe tile costs `K x (0.463 x bonuses + 0.0039 x density)`, with K = 33.6 on plains, 42 on highland and 50.4 on mountain.
- **Up to 100 at once (PARTIAL).**
  - The cap is 100 at Impossible and 3 at Hard (`AiAttackBehavior.ts:522-538`).
  - Free land is checked per nation, and the free-land branch returns only if its send succeeds (`:135-141`). A boat that fails falls through to tribe attacks.
  - **How each tribe attack is sized:**
    - The amount is min(`calculateBotAttackTroops`, `troopSendCap()`) (`:1041-1096`, `:1149-1166`).
    - `calculateBotAttackTroops` gives 4x the tribe's troops, or the whole remaining budget if that is at least 2x the tribe's troops, otherwise nothing.
    - The budget is `T - reserve x cap - already sent`.
    - The attack is dropped under 0.2x the tribe's troops unless the nation is under attack (`:961-973`).
  - **Sequence pinned with a rival (Human or Nation) next to the nation:**
    - At 0.8x, 0.96x, 1.04x and 1.09x of the nation's troops, the nation sends 2, 3, 5 and 16 tribe attacks.
    - At 1.1x or more it sends none.
    - An incoming 1,000-troop attack unfreezes it.
  - **Real Pangaea game:**
    - `troopSendCap` cut 67% of the nation sends on tribes. Only 20% were the full 4x.
    - The most tribes one nation attacked at once was 11.
- **What tribes do:**
  - **Schedule:** knobs from `PseudoRandom(simpleHash(id))`; they decide at `tick % attackRate == attackTick` (`TribeExecution.ts:35-40, :52`). The first decision comes 0-76 ticks after the phase ends (median 31).
  - **Expansion first,** sized `troops - expandRatio x cap` (`:60-73`, `:128-134`). The first decision that finds no free land latches that search off for good.
  - **With no free land,** they attack only at their trigger ratio of cap or above (`AiAttackBehavior.ts:765-798`):
    - first they answer the largest incoming attack, ours included, which cancels it 1:1;
    - then a random neighbour: a Human or Nation neighbour is skipped half the time, a tribe never.
- **The annex rule (the biggest lever).**
  - `troopCount < 1` is checked only before each tile (`AttackExecution.ts:296-300`), so any attack of 1 troop or more that shares a border takes one tile.
  - If that leaves the target under 100 tiles, the attacker conquers it whole, with all of a tribe's gold (`:448-482`; `Config.ts:735-744`).
  - The cost is min(stack, that tile's loss): 1, 10, 50 or 100 troops for stacks of that size, 136 for stacks of 1,000-5,000, and 41 for 20,000.
  - Our troops leave home when each attack starts, so three 16,667-troop attacks from 25,000 home troops start with 16,667, 8,333 and 0 troops, and the third tribe survives. Three 1-troop attacks take all three.
  - Tribes pass 100 tiles 7-84 ticks after the phase ends (median 37).
  - A spawn disc can touch two tribes only if their centres are at most 22 apart. On Pangaea the closest pair is further apart than that.
- **How fast nations eat tribes (Pangaea, 29 nations):**

  | Minute | Tribes alive | Tribe land | Nation land |
  | ------ | ------------ | ---------- | ----------- |
  | 1      | 298          | 64%        | 35%         |
  | 2      | 26           | 4.6%       |             |
  | 3      | 6            | 1.1%       | 99%         |

  An idle 52-tile human died the tick after a tribe's first attack reached it.

**Test:** 24 cases.

- **Pure Config cases:** cap and regrowth curves, the x0.7 variants, and K for each terrain.
- **Synthetic nation cases:** parallelism, the budget and the 2x floor, the `troopSendCap` sequence, being under attack, the free-land gate, and the boat fall-through.
- **Synthetic tribe cases:**
  - expansion and the latch
  - the coin flip over 40 ids, and tribe neighbours never skipped
  - retaliation over 40 ids
  - annex costs for 7 stack sizes, and the 100-tile and 101-tile cases
  - three 16,667-troop attacks against three 1-troop attacks
  - our 52-tile spawn dies to a 1-troop tribe attack
- **Real Pangaea game:** statistics for all 400 tribes, schedule replay, the pass-100 window, nation sizing, the standings table, and an opening annex that gives us 104 tiles.

**Agent implications:**

- **Opening:**
  - Spawn with our disc touching one fresh tribe and attack it with 1 troop, not 16,667, before its first decision plus about 5 ticks.
  - The deadline can be computed from the tribe's id. The earliest pass observed was 7 ticks after the phase ends.
- **Never hold 100 tiles or fewer while anyone borders us.**
- **Predicting nations:**
  - They take the lowest-density tribes first, each attack sized min(4x, or the rest if that is at least 2x, cap).
  - In practice they run at most about 11 attacks at once.
  - Our troops freeze a bordering nation's tribe-eating at about 1.1x its troops.
- **Retaliation trap:** a tribe at or above its trigger with no free land answers our attack at its next decision. Hit tribes that still border free land or are below half their cap, or time the attack from the replayed schedule.

**Open:**

- One seed per map.
- Private fields are read through casts.
- Reaching a second tribe after the opening annex is untested.
- Crowded maps may break the 22-tile spacing argument.

### 2.6 H4 — the nation send cap (`NationSendCap.test.ts`)

**Claim:** an Impossible nation sends at most `troops - 0.9 x (strongest non-allied, non-bot nearby player's troops)` (`troopSendCap`). It refuses sends under 20% of the target's troops unless it is under attack (`isAttackTooWeak`). While it borders free land it launches no other attack (`maybeAttack`). The claim then derives three things:

- no land attack while our home troops exceed about 0.91 T
- no boat attack while they exceed T
- at 1.11 T, even a nation under attack is capped at the size of the attack it faces

**VERDICT: PARTIAL.** The land line is exact while nothing attacks the nation. The boat line and the free-land clause hold only under extra conditions.

**Truth** (in `AiAttackBehavior.ts`):

- **Routing:** a send goes by land if the nation shares a border with the target (`PlayerImpl.ts:572-585`), otherwise by boat (`:822-840`).
- **Size:**
  - by land: `T - reserveRatio x maxTroops` (`:1052-1054`)
  - by boat: `T / 5` (`:1135-1138`)
  - then cut to `troopSendCap()` (`:1071-1074`)
  - nothing below 1 troop (`:1076`)
  - refused under 0.2x the target's troops unless `incomingAttacks()` is non-empty, where any attacker counts, a tribe included (`:961-973`)
- **`troopSendCap`** is `max(0, T - ceil(0.9 x Hmax))` (`:986-1032`). With no qualifying neighbour it is Infinity. Under attack it becomes `max(cap, sum of incoming)`.
- **"Nearby"** (`PlayerImpl.nearby`, `:605-695`) means land tiles 4-adjacent to the border, plus the land tile 5 steps across water, probed from every 10th shore tile.
- **Land line (TRUE):** the nation attacks us only if `T - ceil(0.9 x Hmax) ≥ 0.2 x H`, so the largest H it attacks is H\* ≈ T/1.1. A third player can only lower the cap.
- **The 1.11x clause** holds only if we are in the nation's nearby set. If we are not, our troops never enter its cap.
- **Boats:**
  - If nothing attacks the nation, H > T is safe.
  - If something does, only each strategy's own target filter protects us:
    - random boat: skips H > T (`:243-250`)
    - island: skips H ≥ T (`:695-700`)
    - hated: skips only H > 3T (`:369-378`)
    - retaliate and assist: no filter
  - Any attack of ours sets the nation's relation to us to -100 (`AttackExecution.ts:190-209`), which stays Hostile for 1,001 ticks (`PlayerImpl.ts:946-988`).
- **The free-land gate** returns only if the free-land send succeeds, which needs `T ≥ expandRatio x cap + 1` (`:135-141`).
  - Below that it falls through to the random boat (`:143-151`).
  - Land attacks on players stay blocked, because `reserveRatio` is always greater than `expandRatio` (`:290`).
- **A cap of 0 does not freeze a nation.** Free-land sends use `ceil(5% of T)` instead (`:1035-1039`), and its territory keeps growing.
- **Below its reserve** a nation still sends random boats, and still attacks tribes that own a structure, keeping back only its expand ratio (`:285-287`, `:1046-1054`).

**Test:** 32 cases:

- **The land line:** H\* exact at the boundary.
- **Shields:**
  - A rival at T/0.9 or more gives a cap of 0.
  - A rival at 1.05T still leaves a cap of 9,505, and the nation attacks us with it.
  - The shield line R\* ≈ 1.0889T with us at 0.1T.
- **The free-land gate:** the gate boundary, the fall-through to a T/5 boat, and cap-0 throttling (401 → 1,406 tiles).
- **Grudges:**
  - A 100-troop poke makes the nation Hostile for 1,001 ticks.
  - With a grudge, the nation boats us at 1.5T and at 3T when a tribe attacks it, but not at 3T + 1.
  - With no grudge, it does not boat us.
- **Below reserve:** a tribe that owns a City is attacked with exactly 4,000 troops.

**Agent implications:**

- **Against a bordering nation, keep H > H\*(T), about T/1.1,** measured against its home troops at its decision tick. This holds only while nothing attacks it.
- **Nations we are not nearby:**
  - H > T is safe only while nobody attacks them.
  - With 400 tribes around, "under attack" is common, and then only the target filters protect us.
- **Never poke a nation.** A poke means about 1,000 ticks of Hostile, an immediate lift of its floor, and retaliation sized `max(cap, incoming)`, which is Infinity if we are not nearby.
- **A third player is a shield only if its troops R > (T - 0.2 x H) / 0.9.**
- **A weak nation next to free land still sends random boats.**

**Open:**

- River-only free land with 3 boats out is derived, not tested.
- The every-10th shore-tile sampling is not tested.
- How often nations are under tribe attack in a real game is not measured.

### 2.7 H4 — nation targeting (`NationTargeting.test.ts`)

**Claim:** in FFA an Impossible nation attacks anyone, but prefers:

- `veryWeak`: troops < 15% of our cap
- `juicy`: our troops ≤ 75% of its own
- `victim`: incoming attacks > 50% of our troops

It decides every 30-50 ticks.

**VERDICT: PARTIAL.**

**Truth:**

- **Cadence:**
  - The whole decision runs only on ticks where `ticks % attackRate === attackTick` (`NationExecution.ts:200-228`).
  - `attackRate = nextInt(30, 50)`, which is 30 to 49 ticks (`:102-103`).
  - The rate, the phase and the ratios (trigger 50-59%, reserve 30-39%, expand 10-19%) are fixed for the game, seeded by `PseudoRandom(simpleHash(id) + simpleHash(gameID))` (`:73-84`).
  - Structures are handled again at 1/3 and 2/3 of the interval.
  - The first tick after its spawn, it sends troops/2 at free land (`:194-198`).
- **Gates, in order** (`AiAttackBehavior.ts`):
  1. If a free-land send succeeds, the decision ends (`:135-141`).
  2. A random boat: 1 decision in 10 with a bordering enemy, which ends the decision (`:147-151`); 1 in 5 without one, and the decision goes on (`:143-146`).
  3. A bordering tribe that owns a structure is attacked (`:285-287`).
  4. Below reserve x cap, stop (`:290`).
  5. Below trigger x cap, run the list only 1 decision in 10 (`:293`).
- **The Impossible strategy list** (`:426-428`), in order: retaliate, bots, veryWeak, betray, assist, victim, traitor, juicy, afk, nuked, hated, weakest, island, donate. The first strategy that actually sends wins; a send refused by sizing falls through to the next.
  - **veryWeak:** < 0.15 x the target's own `maxTroops`, strictly, and < 1.2x the nation's troops, strictly (`:655-666`).
  - **victim:** the sum of all incoming attacks on the target (the nation's own and tribes' included) > 0.5x its troops, strictly, and the target ≤ 1.2x the nation's troops (`:636-651`).
  - **juicy:** ≤ 0.75x, inclusive. Among candidates it picks the juiciest (`NationUtils.ts:52-104`), scored on structures (cities, ports, factories and SAMs, by level), the share of cap that is empty, and tile count. Ties go to the weaker.
  - **weakest:** < 1x (`:388-398`).
  - **hated:** relation < -50 and ≤ 3x, at any distance (`:369-378`).
  - **island:** only with no bordering enemy (`:676-749`).
- **"Avoids nobody"** is true only by player type: `shouldAttack` never spares a human at Hard or Impossible (`:932-954`). But each strategy that targets players, apart from retaliate, bots, betray and assist, has its own strength guard.
- **Real game (Pangaea, 3 minutes):** of 1,329 decisions, 756 reached the list. The winning strategies:

  | Strategy  | Wins                     |
  | --------- | ------------------------ |
  | bots      | 273                      |
  | retaliate | 88                       |
  | juicy     | 56 (+1 on our idle seat) |
  | victim    | 28                       |
  | hated     | 12                       |
  | weakest   | 9                        |
  | veryWeak  | 1                        |
  | island    | 1                        |

  No nation sent anything off its schedule.

**Test:** 33 cases:

- **Cadence:** rate ranges over 1,500 gameIDs per difficulty; live schedule adherence.
- **Gates:** statistical gate rates.
- **Strategies:** the strategy names for each difficulty; a ladder of 13 worlds proving the priority order; exact predicate edges.
- **Live consequences:** island's choice of the second nearest; victim merging into a running attack; betrayal edges.
- **Real game:** the census.

**Agent implications:**

- **Stay off its list:**
  - Keep home troops at 15% or more of our own cap, or at 1.2x or more of its troops.
  - Keep home troops above 0.75x its troops, and at 1x or more so we are never its weakest.
  - Never let incoming attacks exceed 50% of our home troops while we hold 1.2x or less of its troops.
- **Deterrence is mostly not attacking it.** In real games, retaliate and bots dominate.
- **It cannot react between decisions,** and its rate and phase can be inferred or replayed.
- **While it borders free land it only expands.** Below its reserve it does not even retaliate.
- **Tribes are a shield:** a nation bordering tribes spends its decisions on them.

**Open:**

- The synthetic worlds run no `PlayerExecution`.
- One census seed.
- Team mode is not covered.

### 2.8 H5 — retaliation (`NationRetaliate.test.ts`)

**Claim:** Impossible's first strategy is retaliate: it answers the largest incoming attack with `troops - reserveRatio x cap` (reserve 30-40%), and that new attack cancels ours 1:1 at init. The nation skips its whole strategy list while it borders free land or is below its reserve, and 90% of the time when below its trigger of 50-60% of cap.

**VERDICT: PARTIAL.**

**Truth:**

- **Order:** retaliate is first in the list (`:426-428`), but two things can pre-empt it:
  - a nearby tribe that owns a structure is attacked first (`:285-287`)
  - 1 decision in 10, a random boat ends the decision (`:148-151`)
- **Gates:**
  - A free-land send that succeeds ends the decision (`:135-141`).
  - Below reserve: nothing (`:290`).
  - Below trigger: only if `chance(10)` passes (`:293`).
  - The ranges are trigger 0.50-0.59, reserve 0.30-0.39 and expand 0.10-0.19 (`NationExecution.ts:76-78`).
- **Whom:** the attacker of the largest single attack, by troops at decision time, ignoring friends and tribes (`findIncomingAttackPlayer`, `:458-479`). It is sent with `force=true`.
- **Size (the correction):** `min(T - reserveRatio x M, troopSendCap())`, where `troopSendCap = max(T - ceil(0.9 x Hmax), sum of all incoming attacks, tribes' included)` (`:1052-1054`, `:1071-1074`, `:986-1032`). The 20% floor is lifted while the nation is under attack.
- **Cancellation:** 1:1 at init, and nothing is refunded (`AttackExecution.ts:157-170`).
- **Timing:** running executions tick before new ones init (`GameImpl.ts:526-551`). So an attack of ours created in a decision tick is first seen at the next decision, `attackRate` ticks later.

**Test:** 13 cases (one seed: trigger 0.53, reserve 0.34, rate 30):

- **Home strong or weak:**
  - With our home at 3.5x, the answer comes exactly `attackRate` ticks later and equals the incoming total.
  - With our home at 0.25 of its cap, the answer is exactly `T - r x M`.
- **Retreat trap:** a `cancel_attack` does not save the stack.
- **Strike sizing:** a strike of 1.25x the nation's surplus survives and pushes it below its reserve.
- **Two attackers:** the nation answers the larger one with the sum of both.
- **Tribe attacks:** they enlarge the answer to us.
- **Frequencies over 200 decisions:** 0 answers below reserve, about 1 in 11 between reserve and trigger, and every decision past the boat roll above trigger.
- **Pre-emption:** a tribe with a City goes first; free land pre-empts retaliation.
- **Live game with income:** a live game with regrowth.

**Agent implications:**

- **Predict the answer** as `min(T - r x M, max(T - ceil(0.9 x H), total incoming))`. Assume the worst-case r = 0.30.
- **To survive the answer,** our attack's current troops must exceed `T - 0.30 x M`.
- **With H ≥ (T - incoming)/0.9 (about 1.11 T),** nothing extra lands on us.
- **Launch so that our attack inits in its decision tick.** That gives the longest free window, `attackRate` ticks.
- **Windows with no answer:**
  - while it borders free land
  - below its reserve
  - about 91% of decisions below its trigger
  - when a nearby tribe owns a structure
- **Traps:**
  - cancelling inside the 20-tick delay
  - tribes attacking it
  - its fast regrowth after our strike empties our home

**Open:**

- One seed.
- Retaliation by boat is untested.
- Free land reachable only across water is untested.

### 2.9 H6 — alliances (`NationAlliance.test.ts`)

**Claim:** an Impossible nation accepts a request from anyone with more than 1.5x its troops, or with more troops and more than 1.5x its cap or tiles. It refuses traitors 90% of the time, and anyone allied with at least 25% of the non-bot players. Before tick 700 it accepts 30% of other requests. Further:

- Allies cannot attack each other.
- Alliances lapse after 5 minutes at no cost.
- Breaking one makes the breaker a traitor for 30 s: attacks on it lose half the troops and are 25% faster, and its neighbours give -40.

**VERDICT: PARTIAL.**

**Truth** (in `NationAllianceBehavior.ts` unless named):

- **When it answers:** only at its decisions (`NationExecution.ts:219-221`). Requests created at tick 101 or earlier are rejected (`:64-70`).
- **`getAllianceDecision` (`:119-179`), first match wins:**
  1. Traitor: refused 90% of the time.
  2. `hasTooManyAlliances`: our alliances ≥ 0.25x the living non-bot players.
  3. Threat, with strict comparisons on home troops (`:251-279`).
  4. Relation < 0: refused.
  5. Friendly: accepted 67% of the time.
  6. `checkAlreadyEnoughAlliances` (`:313-332`).
  7. Early game: absolute tick < 700, accepted 30% of the time.
  8. Similarly strong (`:361-400`).
- **Attacks and requests:**
  - Its attack on us rejects our pending request (`AttackExecution.ts:113-122`).
  - Every answered request blocks the next one to the same player for 300 ticks after its creation (`Config.ts:810-812`).
- **Relations:**
  - Its attack on us makes us embargo it automatically, which costs -20 once and gives +20 back when the embargo lifts (`NationExecution.ts:313-334`).
  - Relations decay 0.05 per tick, so the -20 fades in about 397 ticks.
- **Duration:** `createdAt + 3000` ticks, expiring at no cost (`AllianceImpl.ts:23`, `Config.ts:813-819`).
- **Extensions:** re-decided in full, with us already counted as its bordering friend. With neighbours [us, X] and X not allied, the extension is refused unless we are a threat or Friendly.
- **What allies can do to each other:**
  - Land attacks are blocked, and a running one retreats in full.
  - New boats are refused, but a boat at sea still takes its landing tile.
  - Atom and Hydrogen bombs break the alliance if the blast weighs more than 100 of the ally's tiles, or if an ally structure is within the outer radius: 30 tiles for an Atom bomb, 100 for a Hydrogen bomb (`Util.ts:100-129`).
  - A MIRV always breaks the alliance and costs -100 both ways (`MIRVExecution.ts:110-120`).
- **Breaking:**
  - The breaker becomes a traitor for 300 ticks, unless the other side already is one (`GameImpl.ts:887`, `PlayerImpl.ts:869-879`).
  - The betrayed gives -100 and every player in the breaker's nearby set gives -40, even when breaking with a traitor (`BreakAllianceExecution.ts:45-56`).
- **The nation betraying us:** only when it is at or above its reserve, and at its trigger or on a 1-in-10 chance. It goes through `maybeBetrayAndAttack` (`AiAttackBehavior.ts:583-608`) and attacks in the same decision. The rules (`:404-491`) are:
  - **(a) Juiciest ally:** betrayed if ally + bordering non-allies + other allies together hold < 0.33x its troops.
  - **(b) Traitor:** betrayed if it holds < 1.2x its troops.
  - **(c) Only bordering player:** betrayed if its home troops x3 < the nation's troops.

**Test:** 33 cases:

- **Acceptance:** each acceptance rule at its edge; seed sweeps (12, 71 and 30 per 100).
- **Timing:** the spawn guard, the cooldown and the lapse.
- **Extensions:** the extension trap and its control.
- **Relations:** the embargo malus and its decay.
- **Nukes:** H-bomb and Atom bomb geometry; the MIRV.
- **Breaking:** the cost of breaking with a traitor.
- **Betrayal:** a table at N = 0.9 of its cap. Our home troops at 0.32 are betrayed, at 0.34 are not, and at 0.20 home + 0.20 in flight are betrayed under rule (c).

**Agent implications:**

- **Getting in:**
  - Our troops plus troops in flight must be ≥ 0.90x its troops, with relation ≥ 0. A threat is home troops > 1.5x its troops.
  - Never request before tick 102, or while it is attacking us.
  - After an answer, wait 300 ticks from the request's creation.
- **Allied is not safe.** Keep home troops ≥ 0.34x each bordering Impossible ally's troops. When it betrays us it becomes the traitor, so counter-attack at once for x0.5 losses.
- **Extensions:** ask early, and plan for lapses.
- **Nukes:** never MIRV an ally. Check `listNukeBreakAlliance` with the right magnitude.
- **Never break an alliance:** it costs -100 plus -40 from every neighbour, which turns them Distrustful for about 800 ticks.

**Open:**

- How often a real ally is above its reserve.
- Only tested at Impossible, in FFA.

### 2.10 H7 — gold (`EconomyGold.test.ts`)

**Claim:** income is a flat 100 per tick plus trade. One City level adds 250,000 to the cap. The first 125,000 gold arrives near tick 1,250. Port and Factory share one cost ladder. Attacking a nation makes it embargo us for 5 minutes.

**VERDICT: PARTIAL.**

**Truth** (in `Config.ts` unless named):

- **Worker gold (TRUE).**
  - `goldAdditionRate` gives 100 to a Human or Nation and 50 to a tribe (`:1092-1101`). It does not depend on tiles, difficulty or cities.
  - It is paid every tick, but not during the spawn phase (`PlayerExecution.ts:44-46, :95-100`). Starting gold is 0 (`:439-444`).
- **Other sources:**
  - Trade: `tradeShipGold(d)` goes to both port owners (`:516-521`): 5,185 at 100 tiles, 52,500 at 300, 99,814 at 500.
  - Conquest: the conqueror takes all of a tribe's or nation's gold and half of a human's, or nothing from a human who never attacked (`GameImpl.conquerPlayer`, `:1540-1596`; `:735-744`).
- **Cap (TRUE).**
  - `maxTroops = 2 x (tiles^0.6 x 1000 + 50,000) + (sum of finished City levels) x 250,000` (`:1024-1053`). An Impossible nation gets 1.25x of all of it, i.e. 312,500 per level.
  - In tiles of cap, one level is worth 3,125 at 0 tiles, 5,175 at 1,000, 6,057 at 2,000, 7,759 at 5,000 and 9,604 at 10,000.
- **First 125,000 near tick 1,250: TRUE for our wages, FALSE as the pace of the game.**
  - We get it 1,250 ticks after the phase ends.
  - On World, 67 of 72 nations had bought a City by tick 1,255, the first at tick 471 and the median at 657. Their 370 conquests paid 12.65M against 9.36M of wages.
- **Ladders (TRUE).**
  - Port and Factory share `min(1M, 2^n x 125k)` with n = Ports + Factories. City has its own ladder with the same formula.
  - n = min(`unitsOwned`, `unitsConstructed`), counting levels plus units under construction (`costWrapper`, `:755-773`).
  - The other structures and weapons:

    | Item          | Cost                                              |
    | ------------- | ------------------------------------------------- |
    | Defense post  | min(250k, (n+1) x 50k)                            |
    | SAM           | min(3M, (n+1) x 1.5M)                             |
    | Silo          | 1M flat                                           |
    | Warship       | +250k per unit, up to 1M                          |
    | Atom bomb     | 750k                                              |
    | Hydrogen bomb | 5M                                                |
    | MIRV          | 25M + 15M x MIRVs launched by anyone (`:577-690`) |

  - Upgrades are instant and priced on the same ladder.

- **Build times (ticks):**

  | Structure    | Ticks |
  | ------------ | ----- |
  | City         | 20    |
  | Factory      | 20    |
  | Port         | 50    |
  | Defense post | 50    |
  | Silo         | 100   |
  | SAM          | 300   |
  - The price is charged at the build's first tick, one tick after the intent, after that tick's wages. So an intent sent 200 gold short still builds, and 201 short does not.
  - The structure is finished at duration + 2 ticks.
  - A build that cannot be afforded at its first tick is dropped silently (`ConstructionExecution`, `:55-108`).

- **Embargo (TRUE, and it reaches further).**
  - Any attack between two non-tribe players makes the target embargo the attacker (`AttackExecution.ts:113-122`), even when spawn immunity refuses the attack.
  - It lifts once `ticks - createdAt > 3000`, which is 3,001 ticks, and every new attack restarts it (`PlayerExecution.ts:111-119`).
  - `canTrade` then fails (`PlayerImpl.ts:1228-1232`): no new trade ships, ships at sea sink, and train gold stops.
  - At Impossible the attack also leaves the nation Hostile for about 1,000 ticks.
  - A permanent embargo follows a nuke, a broken alliance or the middle-finger emoji (`NationExecution.ts:336-382`).
  - An accepted alliance request does not end the embargo; only crossing requests do (`AllianceRequestExecution.ts:45-62`).

**Test:** 16 cases:

- **Income:** worker gold for each player type.
- **Cap:** the cap formula and the tile-equivalent table.
- **Ladders:** all ladders, and pricing by min(owned, bought).
- **Construction:** real builds with exact timing; the 200-gold slack; an unaffordable build is dropped.
- **Embargo:** duration, restart, refused-attack embargo, reverse embargo, tribes exempt, the alliance paths, and the permanent-embargo rules.
- **Real arena game:** 1,300 ticks with every nation's gold accounted for on every tick.

**Agent implications:**

- **Budget 100 gold per tick.** Tribes are the fastest early gold: a tribe holds about 50 x (ticks since the phase), and we get all of it, even from a player under 100 tiles that keeps some land.
- **Expect Impossible nations' first City at ticks 470-1,270.**
- **A City level beats land** until we hold several thousand tiles.
- **Send build intents up to 2 ticks before we can afford them.**
- **Do not attack a nation in the first 50 ticks:** the attack is refused, and we are embargoed anyway.
- **Never nuke a trade partner or break an alliance with one:** either makes the embargo permanent.

**Open:**

- Trade volume (the "~13x income"), how fast Port levels rise, and train income are not measured.
- One seed on World.

### 2.11 H8 — nukes and MIRVs (`NukeThreat.test.ts`)

**Claim:** nations nuke the largest incoming attacker first. An Impossible nation also nukes the land leader when the leader is more than 10 points ahead of it, unless they are allied (`findFFACrownTarget`). It MIRVs anyone holding 40% or more of the land (fallout included), and the city leader at more than 8 cities and 1.15x the runner-up's, given a silo and the gold. A MIRV cannot be intercepted and costs 25M + 15M per launch.

**VERDICT: PARTIAL.** Every number is right; the framing is not.

**Truth** (in `NationNukeBehavior.ts`, NNB, and `NationMIRVBehavior.ts`, NMB):

- **When:** one MIRV decision, then one nuke decision, per decision tick (`NationExecution.ts:200-228`).
- **Nuke target, first match** (NNB `:222-316`): 0. With exactly two players alive: the other one, even an ally.
  1. The sender of the largest single incoming attack; allies and tribes are ignored, and attacks are not summed.
  2. For the richest nation, 1 decision in 2: the player with the densest structures, > 1/75 levels per tile strictly and at least 5 levels (`:341-343`).
  3. A player holding more than 50% of (land - fallout), strictly.
  4. The current target of an ally it rates Friendly.
  5. Its most hostile player, unless its own `maxTroops` is at least 2x theirs.
  6. The crown (`:351-417`): the leader, when the leader's share of (land - fallout) minus its own exceeds 0.1, strictly. Tribes count in the ranking, and there is no fallback when the leader is allied. A nation that leads targets the runner-up at any margin.
- **What it fires** (`maybeSendNuke`, `:114-220`):
  - It needs a silo. A tribe target ends the decision.
  - **Type:** a Hydrogen bomb if it can pay the perceived price. Otherwise an Atom bomb, if it can pay and either is not a hydro nation (a hydro nation is 1 in 3) or is under heavy attack (incoming ≥ its troops, `:533-544`).
  - **Perceived prices** rise 25% per hydro and 50% per atom it has launched (`:814-823`). The real price applies again above MIRV + hydro gold, with two players left, or under heavy attack.
  - **No valid aim tile:** an Impossible nation fires an Atom salvo at the target's SAM tile instead (`maybeDestroyEnemySam`, `:217-218`, `:836-1061`). The salvo ignores the rings and the hydro-nation flag.
- **Aiming:**
  - Candidates are 30 random tiles plus structure tiles.
  - Both square ring perimeters must be the target's land or unowned: 30 and 15 tiles for an Atom bomb, 100 and 50 for a Hydrogen bomb (`:175-184`). Land strictly between the rings is not checked.
  - The nation must have a ready silo (`canBuild`), and no enemy SAM may reach the trajectory.
  - **Aim score** (`:706-804`):
    - per structure level within the outer radius: city 25k, silo 50k, port 15k, factory 15k, defense post 5k, SAM 0
    - hydro only: +100k per level for each SAM of level 1-4 within 100 tiles that is outside its own range
    - -30 per tile of distance to its nearest silo, keeping at least 20%
    - -1M for each recent aim point within the bomb's inner radius; a point stays recent for 600 ticks
- **MIRVs** (NMB):
  - **Gates:** a silo, then the gold, then `chance(16)` hesitation.
  - **Targets, in order:**
    - whoever has a MIRV in flight at it
    - the largest holder of ≥ 40% of `numLandTiles()`
    - the holder of > 8 city levels and ≥ 1.15x the runner-up's levels
  - Allies are valid targets. After any nation MIRVs a target, every nation skips it for 300 ticks.
  - **Price:** 25M + 15M x `mirvsLaunched()` (`Config.ts:618-630`).
- **SAMs** (`Config.ts:1136-1151`):
  - Range is `150 - 480/(L+5)`: 70, 81.4, 90, 96.7 and 102 for levels 1-5.
  - There is no hit roll. A level-L SAM has L interceptors, each reloading in 90 ticks.
  - Only the parts of a flight within 150 tiles of the launch or aim point are targetable.
  - SAMs ignore the MIRV carrier but do target its warheads (`SAMLauncherExecution.ts:262-267`). A MIRV has up to 350 warheads (`MIRVExecution.ts:53`).
  - Cost: 1.5M for the first SAM, then 3M. Build time 300 ticks.

**Test:** 30 cases.

- **Target order:**
  - real merged attacks against boat landings
  - steps 3-6 all live at once
  - the density edges in isolation
- **Pricing:**
  - the perceived price (37.25M after 9 hydros)
  - the exact edge of heavy attack
  - the hydro-nation rate (94 of 300)
- **Aiming:**
  - the ring enclave at distances 30, 15, 20 and none
  - the salvo, including 304 of the nation's own tiles lost
  - the score table
- **MIRVs:**
  - steamroll at 23 vs 20 (fires) and 57 vs 50 (does not)
  - exact prediction of each hesitation
- **Robustness:** 35 source mutations are all caught.

**Agent implications:**

- **A SAM makes us a salvo target.** Overlapping SAMs raise the number of bombs a salvo needs above the nation's ready silo slots, so it upgrades a silo instead of firing.
- **Rings are perimeters,** so land 16-29 tiles or 51-99 tiles from an aim point is not protected by them.
- **Only a level-5 SAM, or overlapping SAMs, are safe from hydro hunting.**
- **All-in attacks trigger atoms from hydro nations.**
- **Splitting land attacks does not dodge nukes,** because the attacks merge. Only boat landings stay separate.

**Open:**

- No full arena game was run.
- Team mode is not covered.
- The salvo's timing and its upgrade fallback beyond one SAM are not pinned.

### 2.12 H9 — boats and the win (`BoatsAndWin.test.ts`)

**Claim:** a transport ship costs no gold. A player can have at most 3 at sea, with no cooldown, and a ship takes its landing tile without combat. A nation's boat carries troops/5. In FFA the win is holding more than 80% of the non-fallout land.

**VERDICT: PARTIAL.**

**Truth:**

- **Cost:** 0 gold (`Config.ts:572-575`). The troops leave home at launch, floored (`PlayerImpl.ts:1403-1416`, `:1376-1383`).
- **Cap:** `boatMaxNumber() = 3` (`Config.ts:850-855`). The check involves no time (`TransportShipExecution.ts:79-92`), so a new launch succeeds in the very tick a ship lands.
- **Troops:** exactly the intent's troops, clamped to home troops (`:114-117`).
- **Launch:** rejects the target's pending alliance request to us (`:94-102`). It adds no embargo and changes no relation.
- **Landing:**
  - `conquer(dst)` whoever holds the tile, with no combat (`:271`).
  - If the original target has become friendly, the troops come home and the tile is still taken (`:272-274`). A free-land boat's target is terra nullius, so it takes the tile even from an ally.
  - Otherwise the landing starts an `AttackExecution` with `sourceTile = dst` (`:275-285`). Its init runs even with 0 troops: embargo, alliance-request rejection and -100 relation (`AttackExecution.ts:113-122`, `:190-210`).
  - It also nets 1:1 against the target's attacks on us (`:157-170`), and any attack the target starts later deletes it the same way.
- **Landing on our own tile, or `cancel_boat`:** 25% of the troops are lost (`:32`, `:248-270`).
- **Speed:** one path step per tick (`:38`), and the landing takes one more tick. Routes move only in the 4 main directions (`PathFinder.ts:47-66`; `SmoothingWaterTransformer.ts:296-333`).
- **Nation boat sizing** (`AiAttackBehavior.ts`):
  - at a player: T/5, capped, with the 20% floor (`:1117-1147`)
  - at a tribe via `sendAttack`: 4x the tribe's troops within the bot budget (`:1149-1165`)
  - the random boat: `min(T/5, cap)` (`:192-196`)
  - The bot budget resets only when a tribe is nearby (`:494-498`).
- **The win** (`WinCheckExecution.ts:38-40, :118-142, :198-200`; `Config.ts:255`):
  - `tiles x 100 > (numLandTiles - fallout) x 80`.
  - Checked on ticks divisible by 10, after the phase, for the player with the most tiles (of any type).
  - The 170-minute rule counts from the end of the phase. Overtime is off by default (`Config.ts:262-266`).
  - The arena stops at `maxMinutes x 600` absolute ticks, 36,000 by default (`Arena.ts:401, :626`; `ArenaGame.ts:363, :373`). The result is then "timeout" with no winner.
  - `numLandTiles` excludes impassable tiles, and `landShare > 0.8` is exactly the win test.

**Test:** 22 cases:

- **Basics:** 0 gold; the 4th boat refused; relaunch in the landing tick; exact troops.
- **Cost of a 0-troop landing:** an embargo, and the nation turned Hostile.
- **Speed:** a 65-step A\* route and a 442-step HPA route for a Manhattan distance of 438.
- **Landings:** a full refund on free land; netting at landing and later; the real retaliation deletes the beachhead.
- **Traps:** landing on our own tile, `cancel_boat`, an ally made mid-voyage, a free-land boat taking an ally's tile.
- **Nation boats:** replay of the bot budget over 60 calls.
- **The win:** 73 of 91 tiles; fallout; a tribe can win.
- **Time:** the arena cap and the 170-minute rule; the land count.

**Agent implications:**

- **Boat ETA** ≈ 4-direction route length + 1 ticks.
- **Keep 3 boats in flight.**
- **Probe with 0 troops only on free land, tribes or existing enemies.**
- **A beachhead on a nation is at best an exchange.** But it can cancel an attack on our homeland troop for troop.
- **Do not race our own boats or cancel them.**
- **In the arena, only > 80% before the cap counts.**

**Open:**

- Route lengths on other maps.
- How often beachheads are retaliated against.
- Warships and nukes on boats.

---

## 3. Corrections to the roadmap (docs/11-roadmap.md section 11.3)

Each item quotes the sentence, says what is wrong, and gives corrected text with the test that pins it. Sentences not listed were either confirmed or are strategy rather than mechanics.

**Confirmed as written:**

- "Regrowth peaks with home troops at ~42% of the cap": the analytic peak is 0.73/1.73 = 0.42; pinned in TribeStats.
- "Strike across the widest shared border, with a stack of ≥ 1.67× its troops: the `troopRatio` clamp at 0.6 makes that the cheapest per tile": PlayerAttackSpeed.
- "It refuses traitors (90% of the time) and anyone already allied with ≥ 25% of the non-bot players": NationAlliance.

**Not pinned by these tests:**

- H10.
- "20 of the 127 maps are under 25% land".

### Section preamble

1. **"Its advantages are stats: ×1.25 `maxTroops`, ×1.05 regrowth, 31,250 starting troops against our 25,000, zero latency."**
   - **Imprecise.** The x1.25 covers the whole cap, city levels included. The x1.05 multiplies a rate that is already computed on that larger cap. And the list leaves out the biggest early advantage: gold from the tribes it eats.
   - **Corrected:** "Its advantages are stats: ×1.25 `maxTroops` on the whole formula (312,500 per City level), regrowth ×1.05 on top of that larger cap, 31,250 starting troops against our 25,000, decisions made in the tick it observes, and gold from the tribes it annexes (most Impossible nations buy their first City between ticks 470 and 1,270)."
   - **Evidence:** `Config.ts:1024-1090`; EconomyGold.
2. **"every threshold it uses is readable state, we can act every tick while it decides every 30–50, we may spawn anywhere"**
   - **Imprecise.** The ratios are private, but they can be replayed from gameID and nation id. The rate is 30-49. The first post-spawn send is off-schedule, and structures are also handled at 1/3 and 2/3 of the interval. "Anywhere" means anywhere with free land in the 52-tile disc.
   - **Corrected:** "every threshold it uses is readable or replayable from the gameID and the nation id; we can act every tick while it decides once every 30–49 ticks at a fixed phase; and we may spawn on any site with free land in our 52-tile disc, landing before every nation if the spawn goes in turn 1."
   - **Evidence:** NationTargeting, `NationParams.test.ts`, SpawnPhaseSingleplayer case 9.
3. **"a new land attack on the same target absorbs every earlier one (`AttackExecution.init`)."**
   - **True, but incomplete.** It absorbs boat landings and retreating attacks too, and there is one exception, a simulation bug.
   - **Corrected:** add "(boat landings and retreating attacks included). Exception: a click that inits exactly 20 ticks after a `cancel_attack` on that target keeps the whole stack and the retreat refund is paid anyway, so the troops exist twice; an agent must avoid that tick."
   - **Evidence:** AttackMerge.

### H1

4. **"In singleplayer the spawn phase ends only when we spawn (`SpawnExecution.tick`) and nothing grows until then, so the choice is untimed."**
   - **Imprecise.** There is no timer, but waiting has costs.
   - **Corrected:** "…so there is no timer. Waiting still costs: from turn 2 on the nations land before us and get first claim on contested tiles, and absolute-tick rules keep counting (requests created by tick 101 are refused, the 30% early-alliance window closes at tick 700, and the arena's tick cap includes the spawn phase)."
   - **Evidence:** SpawnPhaseSingleplayer cases 3, 9, 11.
5. **"Tribes are placed on the first tick; nations hop within ±25 tiles of their manifest positions (`NationExecution.randomSpawnLand`)."**
   - **Imprecise.**
   - **Corrected:** "All 400 tribes land in tick 1 on full 52-tile discs at least 30 tiles apart. Nations pick in tick 1 and land in tick 2 at [c−25, c+24] on each axis around their manifest position, hopping to a new pick every `attackRate` (30–49) ticks until we spawn; nations with no manifest coordinates pick anywhere. A spawn sent in turn 1, at the agent's first call, lands before every nation: the nations then land on their tick-1 picks with only the free part of their disc, and one whose disc we cover entirely is never placed."
   - **Evidence:** SpawnPhaseSingleplayer cases 2, 3, 9-11.
6. **"…plus coast on a large water body and nearby tribes as food."**
   - **Imprecise.** "Food" undersells it: a bordering fresh tribe is a 1-troop kill.
   - **Corrected:** "…plus coast on a large water body, and one bordering fresh tribe, which a 1-troop attack annexes whole (tribes stay under 100 tiles until 7–84 ticks after the phase, and at most one tribe can touch a disc where tribes are 30 apart). Score sites on the exact state seen by `ctx.fork().advance(2)` at `ctx.tick === 1`."
   - **Evidence:** TribeStats (annex, pass-100 window, spacing), SpawnPhaseSingleplayer case 9.

### H2

7. **"A free-land attack costs a flat 16/20/24 troops per plains, highland or mountain tile."**
   - **Imprecise.** That figure is for a Human or Nation attacker only, and fallout raises it.
   - **Corrected:** add "(for a Human or Nation attacker; a tribe pays 8/10/12; fallout multiplies the cost by 5 − 2 × falloutRatio)."
   - **Evidence:** FreeLandCost cases 3, 6.
8. **"Its speed saturates at ~400 × tileCost troops (6,600 on plains), beyond which only frontage adds speed."**
   - **True; the pace was missing.**
   - **Corrected:** add "(8,000 highland, 10,000 mountain). Saturated, it takes ceil(0.4 × (borderSize + 0..4)) tiles a tick, never fewer than 1. Speed is computed on the live stack, so staying saturated for a whole tick needs 6,600 + 16 × ceil(0.4 × b) on plains."
   - **Evidence:** FreeLandCost cases 4, 8, 10, 11.
9. **"Nations keep only 10–20% at home (`expandRatio`)."**
   - **Imprecise.** This applies only to free land, and the range is 10-19%.
   - **Corrected:** "Expanding into free land, a nation sends troops − expandRatio × cap (expandRatio 10–19%, capped so that it never sends less than ceil(5% of troops)); against players and tribes it keeps reserveRatio × cap (30–39%) at home."
   - **Evidence:** NationSendCap, NationTargeting, `FreeLandLockSend.test.ts`.
10. **"Keep the free-land stack at saturation and send the surplus to separate targets."**
    - **Imprecise.** All free land is one target, terra nullius, so a second free-land attack merges into the first.
    - **Corrected:** "…and send the surplus to tribes, the only other targets (a second free-land attack merges into the first)."
    - **Evidence:** AttackMerge.

### H3

11. **"There are 400 tribes with a third of the cap and half the regrowth, and we take ×0.7 attacker losses against them."**
    - **Imprecise on regrowth,** and the x0.7 needs its scope.
    - **Corrected:** "…a third of the cap and a ×0.5 regrowth rate on that smaller cap (0.41× ours for a fresh tribe, 0 at its cap). Human and Nation attackers pay ×0.7 losses against them (speed is unchanged). On free land a tribe pays half our cost per tile."
    - **Evidence:** TribeStats.
12. **"Once free land runs out, Impossible nations attack up to 100 tribes at once (`getBotAttackMaxParallelism`)."**
    - **Imprecise.** 100 is only the upper limit.
    - **Corrected:** "Once its own free-land send fails, an Impossible nation at its reserve (and at its trigger, or 1 decision in 10) can attack up to 100 tribes in one decision. Each attack is min(4× the tribe's troops, or the whole remaining budget if that is at least 2×, `troopSendCap`), dropped below 0.2× the tribe's troops unless the nation is under attack. In a real game `troopSendCap` cut two thirds of these sends and no nation ran more than 11 at once. A nation bordering a non-bot player with ≥ ~1.1× its troops sends none."
    - **Evidence:** TribeStats.
13. **"Attacks on different targets never merge, so run one per bordering tribe, sized to finish it, lowest density and widest contact first, starting while free land remains."**
    - **Misses the biggest lever.**
    - **Corrected:** "Attacks on different targets never merge, so run one per bordering tribe. A player left under 100 tiles is annexed whole, gold included, so a tribe of 100 tiles or fewer costs one tile's loss and 1 troop is enough. For a tribe of n > 100 tiles, 'sized to finish it' means n − 99 tiles at about 15.6 + 0.131 × density troops each (plains, stack ≥ 1.67× its troops). A tribe at or above its trigger with no free land answers our attack at its next decision and cancels it 1:1; hit tribes that still border free land or are below half their cap."
    - **Evidence:** TribeStats, PlayerAttackSpeed.
14. **"[DERIVED] A stack of ≥ 1.22× the defender's troops takes player tiles ~1.6× faster per unit of frontage than free land: `speedCost` bottoms out at a troop ratio of 0.82, giving ~0.63 tiles per tick per border tile against free land's 0.4."**
    - **True on plains only.**
    - **Corrected:** add "…on plains. The floor is 8.55/(0.82 × tileCost): 0.632, 0.521 and 0.417 per border tile on plains, highland and mountain, against free land's 0.4 on every terrain, so 1.58×, 1.30× and 1.04×. Break-even with saturated free land is a stack of 0.77× the defender on plains and 1.17× on mountains."
    - **Evidence:** PlayerAttackSpeed case 3.

### H4

15. **"In FFA an Impossible nation sends at most `troops − 0.9 × (strongest non-allied, non-bot nearby player's troops)` (`troopSendCap`)."**
    - **Imprecise.**
    - **Corrected:** "…at most max(0, troops − ceil(0.9 × Hmax)), where nearby means 4-adjacent land plus land 5 tiles across water; with no such player there is no cap. While any attack is incoming (a tribe's included) the cap is max(cap, sum of incoming attacks). Free-land sends are never capped below ceil(5% of troops)."
    - **Evidence:** NationSendCap.
16. **"While it borders free land it launches no other land or boat attack (`maybeAttack`)."**
    - **Wrong** below the expand ratio.
    - **Corrected:** "While its free-land send succeeds (troops ≥ expandRatio × cap + 1) it launches nothing else that decision. Below that it falls through: player land attacks are still blocked by the reserve gate, but its 1-in-5 random boat can hit a player that is not nearby and has no more troops than it."
    - **Evidence:** NationSendCap (fall-through case), `FreeLandLockSend.test.ts`.
17. **"[DERIVED] So it cannot attack us by land while our home troops exceed ~0.91× its troops, or by boat (it sends troops/5) while they exceed its troops."**
    - **True only while nothing attacks the nation.**
    - **Corrected:** "So while nothing is attacking it, it cannot attack us by land while our home troops H exceed H\*(T) ≈ T/1.1, nor by boat while H > T. Any attack on it, a tribe's included, lifts its 20% floor. Then only each strategy's own filter protects us from boats: random boat and island skip H > T, hated skips only H > 3T, and retaliate and assist have no filter. Any attack of ours makes it Hostile to us for 1,001 ticks."
    - **Evidence:** NationSendCap (grudge cases).
18. **"At 1.11× even a nation under attack is capped at the size of the attack it faces."**
    - **True only if we are nearby.**
    - **Corrected:** "If we are in its nearby set, at H ≥ T/0.9 its cap is 0, so under attack it sends at most the sum of the attacks it faces. If we are not nearby, our troops never enter its cap."
    - **Evidence:** NationSendCap.
19. **"Also stay out of `veryWeak` (< 15% of our cap), `juicy` (≤ 75% of its troops) and `victim` (incoming > 50% of our troops)."**
    - **Imprecise,** and it misses two strategies.
    - **Corrected:** "Also stay out of `veryWeak` (troops < 15% of our own cap and < 1.2× its troops), `juicy` (≤ 0.75× its troops), `victim` (all incoming attacks, its own and tribes' included, > 0.5× our troops while we hold ≤ 1.2× its troops), `weakest` (< 1× its troops) and `hated` (relation < −50, ≤ 3× its troops, reached by boat)."
    - **Evidence:** NationTargeting.

### H5

20. **"Impossible's first strategy is `retaliate`: it answers the largest incoming attack with `troops − reserveRatio × cap` (reserve 30–40%), and that new attack cancels ours 1:1 when it is created (`AttackExecution.init`)."**
    - **Wrong size, and incomplete.**
    - **Corrected:** "`retaliate` is first in Impossible's strategy list, though a nearby tribe that owns a structure, and 1 decision in 10 a random boat, come before it. It answers the attacker of the largest single non-tribe attack with min(troops − reserveRatio × cap, max(troops − ceil(0.9 × Hmax), sum of all incoming attacks)), reserve 30–39%. The answer inits at the end of its decision tick and cancels ours 1:1 with no refund. An attack of ours that inits in a decision tick is first seen at the next decision."
    - **Evidence:** NationRetaliate cases 2, 4, 6, 7, 11.
21. **"It skips its whole strategy list while it borders free land or is below its reserve, and 90% of the time when below its trigger of 50–60% of cap (`maybeAttack`, `attackBestTarget`)."**
    - **Imprecise.**
    - **Corrected:** "…while its free-land send succeeds, or below its reserve (30–39% of cap), and 9 decisions in 10 below its trigger (50–59%)."
    - **Evidence:** NationRetaliate cases 8-10, 12.
22. **"[DERIVED] So strike when it is below its trigger (for instance just after it launched a big attack), or with more troops than it holds above its reserve."**
    - **Imprecise.**
    - **Corrected:** "So strike when it is below its reserve (it never answers), or below its trigger (it answers about 1 decision in 10), or with a stack larger than its answer, min(T − 0.30·M, max(T − ceil(0.9·H), incoming)). With our home H ≥ ~1.11× its troops the answer is at most the incoming total, so nothing extra lands on us. `cancel_attack` does not save a stack: the attack stays in its incoming list during the 20-tick delay and is answered."
    - **Evidence:** NationRetaliate cases 3, 5, 8-10.
23. **"Finishing a player hands its unreached remnant to third parties (`handleDeadDefender`, §02.4)."**
    - **Imprecise.**
    - **Corrected:** "When a player drops below 100 tiles the attacker annexes it and takes its gold. Then, in up to 100 passes, each remaining tile goes to the attacker if it borders the attacker, otherwise to a bordering player not friendly with the target; tiles touching neither stay where they are. So the remnant is split by a flood from every bordering player, and the attacker goes first in each pass."
    - **Evidence:** `AttackExecution.ts:448-482`. The annex itself is pinned by TribeStats; the split to third parties is code-cited only.

### H6

24. **"Impossible accepts a request from anyone with 1.5× its troops, or with more troops and 1.5× its cap or tiles (`isAlliancePartnerThreat`)."**
    - **Imprecise.**
    - **Corrected:** "…with home troops strictly above 1.5× its troops, or above its troops with a cap or tile count above 1.5× its own, unless the requester is a traitor (refused 90%) or allied with ≥ 25% of the living non-bot players, both checked first. It answers only at its decisions, refuses requests created at tick 101 or earlier, and its own attack on us rejects our pending request."
    - **Evidence:** NationAlliance.
25. **"Before tick 700 in singleplayer it accepts 30% of other requests too (`isEarlygame`)."**
    - **Imprecise.**
    - **Corrected:** "Before absolute tick 700 it accepts 30% of the requests that passed the relation check (≥ 0), the Friendly check (which accepts 67% of Friendly requesters) and `checkAlreadyEnoughAlliances`. After that it accepts only threats, 67% of Friendly requesters, and similarly strong requesters (troops + outgoing > 0.80–0.89× its troops, or tiles > 0.90–0.99× its tiles with troops > 0.5×)."
    - **Evidence:** NationAlliance.
26. **"Allies cannot attack each other, and alliances lapse after 5 minutes at no cost."**
    - **Imprecise.**
    - **Corrected:** "Allies cannot start land attacks or boats against each other (a running attack retreats in full), but a boat already at sea still takes its landing tile. An Atom or Hydrogen bomb breaks the alliance if its blast weighs more than 100 of the ally's tiles or an ally structure is within its outer radius (30 / 100 tiles); a MIRV always breaks it. Alliances lapse after `allianceDuration()` = 3,000 ticks at no cost. An extension is decided afresh, with us counted as its bordering friend, so a nation with a second, non-allied non-bot neighbour refuses to extend unless we are a threat or Friendly."
    - **Evidence:** NationAlliance, BoatsAndWin.
27. **"[DERIVED] Fight one front at a time and ally the rest."**
    - **Misses betrayal.**
    - **Corrected:** add "An Impossible ally above its reserve betrays and attacks us in the same decision if we are its only bordering player with home troops < 1/3 of its troops, if we plus its other neighbours and allies total < 0.33× its troops, or if we are a traitor with < 1.2× its troops. Keep home troops ≥ 0.34× each bordering Impossible ally's troops."
    - **Evidence:** NationAlliance betrayal table.
28. **"Let alliances lapse rather than break them: breaking makes us a traitor for 30 s (half attacker losses and 25% faster attacks against us, −40 from neighbours)."**
    - **Incomplete.**
    - **Corrected:** add "…plus −100 from the betrayed. The −40 comes from every player in our nearby set, even when we break with a traitor (only the traitor mark is skipped), and leaves them Distrustful for about 800 ticks."
    - **Evidence:** NationAlliance.
29. **"Use `targetPlayer` to point allies at our target."**
    - **Imprecise.**
    - **Corrected:** "Allies follow our target only through `assist`, 5th in the list after retaliate, bots, veryWeak and betray. It needs the nation's relation to us to be Friendly (≥ 50) and the target set within the last 100 ticks, and each assist costs 20 of that relation."
    - **Evidence:** `AiAttackBehavior.ts:540-567`. NationTargeting pins the order and the 100-tick window; the −20 is code-cited only.

### H7

30. **"Income is a flat 100/tick plus trade (§03)."**
    - **Incomplete.**
    - **Corrected:** "Worker income is a flat 100 gold a tick from the end of the spawn phase, independent of land, difficulty and cities. On top come trade (both port owners get `tradeShipGold(d)`, 52,500 at 300 tiles) and conquest (all of a tribe's or nation's gold, half of a human's), which is where nations get their early gold."
    - **Evidence:** EconomyGold.
31. **"One city level adds 250,000 to the cap, worth ~5,100 tiles mid-game."**
    - **Imprecise.**
    - **Corrected:** "One finished City level adds 250,000 to our cap (312,500 for an Impossible nation; a City under construction adds nothing, an upgrade adds it at once), worth 3,125 tiles of cap at 0 tiles, 5,175 at 1,000 tiles, 6,057 at 2,000, 7,759 at 5,000 and 9,604 at 10,000."
    - **Evidence:** EconomyGold.
32. **"The first 125,000 gold arrives near tick 1,250: build a Port if a ≥ 300-tile route to a tradeable foreign port exists (~13× income), else a City."**
    - **Imprecise,** and partly unmeasured.
    - **Corrected:** "Our first 125,000 arrives 1,250 ticks after the spawn phase ends, sooner if we annex tribes (each holds about 50 gold per tick since the phase). Impossible nations get theirs from tribe gold: on World 67 of 72 had bought a City (always their first build) by tick 1,255. The Port's '~13× income' is not measured yet."
    - **Evidence:** EconomyGold.
33. **"Port levels are superlinear, and Ports and Factories share one cost ladder."**
    - **The first half is not measured.**
    - **Corrected:** "Ports and Factories share one ladder, min(1M, 2^n × 125k) with n counting both kinds (levels plus units under construction, capped at the number ever built); City has its own ladder with the same formula. How Port income scales with level is not measured."
    - **Evidence:** EconomyGold.
34. **"Attacking a nation makes it embargo us for 5 minutes (`AttackExecution.init`), so our trade partners are the nations we are not fighting."**
    - **Incomplete.**
    - **Corrected:** "Any attack between two non-tribe players makes the target embargo the attacker for 3,001 ticks, restarted by every new attack and set even when spawn immunity refuses the attack. So a nation that attacks us gets embargoed by us too, which costs −20 on its relation to us until the embargo lifts. At Impossible the attack also sets the target's relation to −100 (Hostile for 1,001 ticks). An accepted alliance does not lift the embargo, and a nuke, a broken alliance or a middle-finger emoji makes it permanent. Our trade partners are the nations neither side has attacked in the last 3,000 ticks."
    - **Evidence:** EconomyGold.

### H8

35. **"Nations nuke the largest incoming attacker first, and an Impossible nation also nukes the land leader once the leader is more than 10 points of land ahead of it, unless the two are allied (`NationNukeBehavior.findFFACrownTarget`)."**
    - **Imprecise order.**
    - **Corrected:** "Target order, first match: with two players alive, the other; the sender of the largest single incoming attack (tribes and allies ignored, land attacks merged); for the richest nation 1 decision in 2, the densest-structure player (> 1/75 levels per tile, ≥ 5 levels); a holder of > 50% of non-fallout land; a Friendly ally's target; its most hostile player unless its maxTroops is ≥ 2× theirs; last, the land leader when the leader's share of non-fallout land exceeds its own by more than 0.1 (never an ally), or the runner-up at any margin if it leads itself. Every step needs a silo and the gold for the chosen bomb at its perceived price, which rises 25% per Hydrogen bomb and 50% per Atom bomb it has launched."
    - **Evidence:** NukeThreat.
36. **"So the moment we lead, nearly every nation is aiming at us"**
    - **[DERIVED] and overstated.**
    - **Corrected:** "So once we lead by more than 0.1 of the non-fallout land, every nation that has a silo and the gold, and for which none of the earlier steps applies, aims at us; and any SAM we own draws an Atom salvo aimed at the SAM tile, which ignores the clear-land rings."
    - **Evidence:** NukeThreat.
37. **"Impossible nations also MIRV anyone holding ≥ 40% of all land tiles (fallout included), and the city leader once it has more than 8 cities and 1.15× the runner-up's (`NationMIRVBehavior`), if they own a silo and can pay."**
    - **Imprecise.**
    - **Corrected:** "…first whoever has a MIRV in flight at them; then the largest holder of ≥ 40% of `numLandTiles()`; then the holder of more than 8 city levels (levels, not cities) and ≥ 1.15× the runner-up's levels. Allies are valid targets. They hesitate 1 decision in 16, and a target MIRVed by any nation is skipped by all nations for 300 ticks."
    - **Evidence:** NukeThreat.
38. **"A MIRV cannot be intercepted and costs 25M gold, rising by 15M per launch (§05)."**
    - **Imprecise.**
    - **Corrected:** "SAMs ignore the MIRV carrier but can shoot its warheads (up to 350 per MIRV; a level-L SAM has L interceptors, each reloading in 90 ticks), so in practice a MIRV gets through. It costs 25M + 15M × MIRVs launched by anyone in the game."
    - **Evidence:** NukeThreat; `SAMLauncherExecution.ts:262-267`, `MIRVExecution.ts:53`.
39. **"Plan the run from 40% to 80%: impoverish or kill the richest nations first, cross the gap fast, and build SAMs against ordinary nukes."**
    - **Imprecise** on the win and on SAMs.
    - **Corrected:** "In the arena the only win is > 80% of non-fallout land before the tick cap (36,000 absolute ticks by default, spawn phase included); anything else is a 'timeout'. SAMs stop ordinary nukes with certainty in range (70 / 81.4 / 90 / 96.7 / 102 tiles for levels 1–5; only flight parts within 150 tiles of launch or aim are targetable). But owning one makes us the target of an Atom salvo aimed at the SAM tile, and Hydrogen-bomb nations hunt SAMs of level 1–4 within 100 tiles."
    - **Evidence:** BoatsAndWin, NukeThreat.

### H9

40. **"Boats are free, 3 at a time, with no cooldown, and take their landing tile without combat (§02.6); a later land attack on the same target absorbs the beachhead."**
    - **True but incomplete.**
    - **Corrected:** add "A landing's attack nets 1:1 against any attack the target has on us, and any attack the target starts later deletes it 1:1 with no refund; an Impossible nation retaliates first, so a beachhead on a nation is at best an exchange. Every launch rejects the target's pending alliance request to us, and every landing on a nation, even with 0 troops, embargoes us and makes it Hostile. A boat aimed at free land takes its landing tile from whoever holds it, an ally included. `cancel_boat` and landing on our own tile cost 25% of the troops aboard. ETA ≈ the 4-direction route length + 1 ticks."
    - **Evidence:** BoatsAndWin.

---

## 4. Chapter errors found in passing (docs/00-09)

These are not in section 11.3, but the tests refute them.

| Where                                  | Says                                                                                  | Truth                                                                                                                    | Test                   |
| -------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| docs/01 §1.6                           | "Spawn phase, singleplayer: 100 ticks"                                                | There is no timer in singleplayer; the phase ends when we spawn (`GameRunner.ts:170-173`).                               | SpawnPhaseSingleplayer |
| docs/02 §2.3 item 6, docs/09           | the beachhead frontier is thrown away when attacks merge                              | The merged attack re-seeds from every border tile we own, the beachhead included (`AttackExecution.ts:151`, `:213-222`). | AttackMerge            |
| docs/02 §2.5                           | "the same 400 troops on a 200-tile front outrun 400 troops on a 4-tile front by ~50x" | About 4x (6 ticks against 25), because of the one-tile-per-tick floor.                                                   | FreeLandCost case 11   |
| docs/02 §2.7                           | "Posts / fallout: still apply" to terra nullius                                       | Defense posts do not apply to free land (`Config.ts:886`); fallout does.                                                 | FreeLandCost           |
| docs/06 §6.6                           | tribes' "attackAmount = troops/20"                                                    | That value only fills in a null troop count (`AttackExecution.ts:130-132`). Tribes send `troops - expandRatio x cap`.    | TribeStats             |
| docs/09 (already noted in the roadmap) | run 2-3 parallel land attacks on free land                                            | They merge into one.                                                                                                     | AttackMerge            |

---

## 5. Design constants for the agent

Cite shorthand:

- `Cfg` = `src/core/configuration/Config.ts`
- `AE` = `src/core/execution/AttackExecution.ts`
- `AAB` = `src/core/execution/utils/AiAttackBehavior.ts`
- `NE` = `src/core/execution/NationExecution.ts`
- `NAB` = `src/core/execution/nation/NationAllianceBehavior.ts`
- `NNB` = `.../nation/NationNukeBehavior.ts`
- `NMB` = `.../nation/NationMIRVBehavior.ts`
- `TSE` = `src/core/execution/TransportShipExecution.ts`

Test names are files in `tests/agent/mechanics/`.

### 5.1 Spawn and opening

| Name                         | Value or formula                                                                                                          | Source                                                                         | Pinned by                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------- |
| Earliest spawn turn          | turn 1: send at the agent's first call (`ctx.tick === 1`); it lands in tick 2, ahead of every nation                      | `ArenaGame.ts:268-269`; `GameRunner.ts:209-211`; `NE:168-179`                  | SpawnPhaseSingleplayer 9                  |
| Look-ahead for the spawn     | `ctx.fork().advance(2)` at tick 1 (about 150 ms on World) shows the exact tribe and nation tick-1 layout                  | SpawnPhaseSingleplayer probe                                                   | SpawnPhaseSingleplayer 9                  |
| Spawn disc                   | 52 tiles: x-4..x+3 by y-4..y+3, minus 3 tiles at each corner; only unowned, passable land is taken                        | `GameMap.ts:715-735`; `execution/Util.ts:140-159`; `SpawnExecution.ts:139-148` | SpawnPhaseSingleplayer 4-7                |
| Nation spawn window          | [c-25, c+24] on each axis; hops every `attackRate` during the phase                                                       | `NE:282-311`, `:127-134`; `PseudoRandom.ts:61-65`                              | SpawnPhaseSingleplayer 3                  |
| Tribe spacing                | ≥ 30 Manhattan (for the first 750 of 1,000 tries)                                                                         | `SpawnExecution.ts:166-186`; `Cfg:823-825`                                     | SpawnPhaseSingleplayer 2, TribeStats      |
| Starting troops              | us 25,000; Impossible nation 31,250; tribe 10,000                                                                         | `Cfg:1003-1022`                                                                | SpawnPhaseSingleplayer 1-2                |
| Nation opening send          | troops/2 at free land on the first tick after its spawn (15,625)                                                          | `NE:194-198`                                                                   | SpawnPhaseSingleplayer 4, NationTargeting |
| Spawn immunity               | 50 ticks after the phase ends; it binds only human attackers (we cannot attack nations; nations and tribes can attack us) | `Cfg:189, :335-342`; `PlayerImpl.ts:1907-1926`                                 | SpawnPhaseSingleplayer 4, EconomyGold     |
| Alliance-request spawn guard | requests with `createdAt ≤ numSpawnPhaseTurns() + 1 = 101` are refused                                                    | `NAB:64-70`                                                                    | NationAlliance                            |
| Early-alliance window        | absolute tick < 600 + 100 = 700, accepts 30%                                                                              | `NAB:218-245`                                                                  | NationAlliance                            |
| Arena tick cap               | `maxMinutes x 600` absolute ticks (default 36,000), spawn phase included; the result is then "timeout"                    | `Arena.ts:401, :626`; `ArenaGame.ts:363, :373`                                 | BoatsAndWin (time)                        |

### 5.2 Free land

| Name                                  | Value or formula                                                                             | Source                    | Pinned by         |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------- | ----------------- |
| Loss per tile                         | mag/5 = 16 / 20 / 24 (Human, Nation); mag/10 = 8 / 10 / 12 (tribe)                           | `Cfg:896-909`, `:172-188` | FreeLandCost 3, 7 |
| Saturation stack                      | 400 x tileCost = 6,600 / 8,000 / 10,000                                                      | `Cfg:136-138`, `:896-909` | FreeLandCost 4    |
| Floor stack                           | 20 x tileCost = 330 / 400 / 500                                                              | same                      | FreeLandCost 4    |
| Tiles per tick                        | saturated `ceil(0.4 b)`; linear about `b T / (1000 tileCost)`; floor `ceil(b/50)`; minimum 1 | `AE:291-342`              | FreeLandCost 8-11 |
| Frontage b                            | `attack.borderSize() + nextInt(0, 5)` (jitter 0-4), fixed within a tick                      | `AE:291`                  | FreeLandCost 9    |
| Stack that stays saturated for a tick | `6,600 + 16 x ceil(0.4 b)` on plains (scale by terrain)                                      | derived from the above    | FreeLandCost 10   |
| Fallout multiplier                    | `5 - 2 x falloutRatio` on mag and tileCost                                                   | `Cfg:362-366`, `:890-894` | FreeLandCost 6    |
| Out of free land                      | the stack retreats and is refunded in full                                                   | `AE:302-306`              | FreeLandCost 12   |

### 5.3 Player attacks

| Name                             | Value or formula                                                                                                   | Source                                 | Pinned by                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ----------------------------------- |
| Troop ratio                      | `r = defender troops / live stack`                                                                                 | `Cfg:943`                              | PlayerAttackSpeed 10-11             |
| Fastest stack                    | `r ≤ 0.82`, i.e. stack ≥ 1.2195x the defender                                                                      | `Cfg:955-957`                          | PlayerAttackSpeed 1                 |
| Pace at the floor                | `8.55 / (0.82 x tileCost)` per border tile: 0.632 / 0.521 / 0.417                                                  | `Cfg:149`, `:955-972`                  | PlayerAttackSpeed 1, 3              |
| Edge over free land              | 1.58x / 1.30x / 1.04x (plains / highland / mountain)                                                               | derived                                | PlayerAttackSpeed 3                 |
| Cheapest stack                   | `r ≤ 0.6`, i.e. stack ≥ 1.667x the defender                                                                        | `Cfg:943-949`                          | PlayerAttackSpeed 7                 |
| Attacker loss per tile           | `mag x within(r, 0.6, 2) x (0.463 x bonuses + 0.0039 x density)`; x0.7 for a Human or Nation attacking a tribe     | `Cfg:135, :144-145, :914-949`          | PlayerAttackSpeed 7-9               |
| Cost per tile at r ≤ 0.6, plains | tribe `15.6 + 0.131 x density`; nation `22.2 + 0.187 x density`                                                    | derived                                | PlayerAttackSpeed 9                 |
| Defender loss per tile           | `floor(troops / tiles)` (nothing below density 1)                                                                  | `Cfg:937`; `PlayerImpl.ts:1376-1383`   | PlayerAttackSpeed 11-12             |
| Defense post in range            | tile cost x3, attacker loss x5                                                                                     | `Cfg:381-387`, `:886-889`              | PlayerAttackSpeed 6                 |
| Traitor defender                 | time x0.8, attacker loss x0.5, for 300 ticks                                                                       | `Cfg:287-295`, `:933-934`              | PlayerAttackSpeed 6, NationAlliance |
| Annex line                       | the target drops below 100 tiles after one of our tiles → conquered whole (100 tiles is still annexed, 101 is not) | `AE:448-482`                           | TribeStats                          |
| Cost of an annex                 | min(stack, one tile's loss): a 1-troop attack kills a fresh tribe                                                  | `AE:296-300, :341`                     | TribeStats                          |
| Conquest gold                    | all of a tribe's or nation's gold; half of a human's (0 if that human never attacked)                              | `Cfg:735-744`; `GameImpl.ts:1540-1596` | EconomyGold, TribeStats             |

### 5.4 Merging, retreating, cancelling

| Name                 | Value or formula                                                                                                          | Source                                | Pinned by                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------- |
| Merge                | a new land attack absorbs every earlier attack of ours on the same target (boat landings and retreating attacks included) | `AE:171-181`                          | AttackMerge                  |
| Opposing attacks     | cancel 1:1 at init; the smaller one is deleted with no refund                                                             | `AE:157-170`; `AttackImpl.ts:60-73`   | AttackMerge, NationRetaliate |
| Retreat delay        | 20 ticks (`cancelDelay`)                                                                                                  | `RetreatExecution.ts:11, :34-37`      | AttackMerge                  |
| Retreat malus        | 25% against a player, 0% against free land                                                                                | `AE:37, :224-256, :266-274`           | AttackMerge                  |
| Safe rescue re-click | it must init 1-19 steps after the cancel inits; exactly 20 duplicates the stack (sim bug)                                 | `AE:266-283`; `GameImpl.ts:526-551`   | AttackMerge (timing cases)   |
| Troops above the cap | cut to `ceil(max)` on the next tick                                                                                       | `Cfg:1089`; `PlayerImpl.ts:1369-1383` | TroopCapClamp                |

### 5.5 Troops and gold

| Name                           | Value or formula                                                                                                                   | Source                                                           | Pinned by               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------- |
| Cap                            | `2 x (tiles^0.6 x 1000 + 50,000) + (sum of finished City levels) x 250,000`; x1.25 for an Impossible nation; /3 for a tribe        | `Cfg:1024-1056`, `:358-360`                                      | EconomyGold, TribeStats |
| Regrowth per tick              | `(10 + T^0.73/4) x (1 - T/M)`, x0.5 tribe, x1.05 Impossible nation, clamped to M                                                   | `Cfg:1058-1090`                                                  | TribeStats              |
| Regrowth peak                  | T at about 42% of M (analytic 0.73/1.73)                                                                                           | same                                                             | TribeStats              |
| Gold income                    | 100 per tick (Human, Nation), 50 (tribe), none during the spawn phase, starting gold 0                                             | `Cfg:1092-1101`, `:439-444`; `PlayerExecution.ts:44-46, :95-100` | EconomyGold             |
| Value of a City level in tiles | 3,125 / 5,175 / 6,057 / 7,759 / 9,604 at 0 / 1k / 2k / 5k / 10k tiles                                                              | derived from the cap                                             | EconomyGold             |
| City / Port+Factory ladder     | `min(1M, 2^n x 125k)`, n = min(owned, built), counting levels and units under construction                                         | `Cfg:597-607, :670-690, :755-773`                                | EconomyGold             |
| Other costs                    | Defense post `min(250k, (n+1) x 50k)`; SAM `min(3M, (n+1) x 1.5M)`; Silo 1M; Atom 750k; Hydrogen 5M; MIRV `25M + 15M x launched`   | `Cfg:577-668`                                                    | EconomyGold, NukeThreat |
| Build times (ticks)            | City 20, Factory 20, Port 50, Defense post 50, Silo 100, SAM 300; finished at duration + 2 after the intent tick                   | `Cfg:204`; `ConstructionExecution.ts:55-108`                     | EconomyGold             |
| Build slack                    | the price is charged one tick after the intent, after that tick's wages: an intent 200 short builds, 201 short is dropped silently | same                                                             | EconomyGold             |
| Trade ship gold                | 5,185 / 52,500 / 99,814 at 100 / 300 / 500 tiles, paid to both owners                                                              | `Cfg:516-521`                                                    | EconomyGold             |
| Structure spacing              | ≥ 15 tiles                                                                                                                         | `Cfg:1195-1197`                                                  | EconomyGold (cited)     |

### 5.6 Relations and embargoes

| Name                            | Value or formula                                                                                                                                 | Source                                                    | Pinned by                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------- |
| Relation change from one attack | -100 at Impossible (clamped to [-100, 100])                                                                                                      | `AE:188-210`; `PlayerImpl.ts:969-976`                     | NationSendCap, EconomyGold            |
| Relation bands                  | Hostile < -50 ≤ Distrustful < 0 ≤ Neutral < 50 ≤ Friendly                                                                                        | `PlayerImpl.ts:946-957`                                   | NationAlliance                        |
| Relation decay                  | 0.05 per tick toward 0, so Hostile from -100 lasts 1,001 ticks                                                                                   | `PlayerImpl.ts:978-988`; `PlayerExecution.ts:57`          | NationSendCap, NationTargeting        |
| Temporary embargo               | lifts when `ticks - createdAt > 3000` (3,001 ticks); restarted by every attack; set even when immunity refuses the attack; never involves tribes | `Cfg:820-822`; `PlayerExecution.ts:111-119`; `AE:113-127` | EconomyGold                           |
| Embargo malus                   | -20 once on the nation's relation to us while we embargo it; +20 when the embargo lifts                                                          | `NE:313-334`                                              | NationAlliance, AllianceRecallEmbargo |

### 5.7 Nation parameters and send sizing

| Name                      | Value or formula                                                                                                                    | Source                      | Pinned by                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------- |
| Decision rate and phase   | `attackRate = nextInt(30, 50)` (30-49); `attackTick = nextInt(0, rate)`; decides when `tick % rate == attackTick`                   | `NE:84, :102-103, :200-228` | NationTargeting, NationParams    |
| Ratios                    | trigger 0.50-0.59; reserve 0.30-0.39; expand 0.10-0.19; seeded by `PseudoRandom(simpleHash(id) + simpleHash(gameID))`               | `NE:73-78`                  | NationRetaliate 1, NationParams  |
| Send cap                  | `max(0, T - ceil(0.9 x Hmax))` (Infinity with no qualifying neighbour); under attack `max(cap, sum of incoming)`                    | `AAB:986-1032`              | NationSendCap                    |
| Free-land send cap        | the send cap, but never below `ceil(0.05 x T)`                                                                                      | `AAB:1035-1039`             | NationSendCap                    |
| 20% floor                 | a send under `0.2 x target troops` is refused unless any attack is incoming                                                         | `AAB:961-973`               | NationSendCap                    |
| Land deterrence line      | H\* = largest H with `T - ceil(0.9 H) ≥ 0.2 H` ≈ T/1.1 (0.909 T), valid while nothing attacks the nation                            | derived                     | NationSendCap                    |
| Full freeze               | our H or a rival's R ≥ T/0.9 (1.111 T) gives a cap of 0                                                                             | derived                     | NationSendCap, TribeStats        |
| Third-party shield        | R > (T - 0.2 H) / 0.9 (e.g. R\* ≈ 1.0889 T when H = 0.1 T)                                                                          | derived                     | NationSendCap                    |
| Land send                 | `T - reserveRatio x M` against players and tribes; `T - expandRatio x M` against free land and against tribes that own structures   | `AAB:1041-1054`             | NationSendCap, FreeLandLockSend  |
| Boat send                 | T/5 to a player; min(T/5, cap) for the random boat                                                                                  | `AAB:1117-1147`, `:192-196` | BoatsAndWin, NationSendCap       |
| Tribe attack size         | 4x the tribe's troops, or the rest of the budget if ≥ 2x, else skip; then min with the cap; budget `T - reserve x M - already sent` | `AAB:1149-1166`             | TribeStats, LightningRod         |
| Tribe parallelism         | ≤ 100 (Impossible), 3 (Hard); about 11 observed at most                                                                             | `AAB:522-538`               | TribeStats                       |
| Random boat               | 1 decision in 10 with a bordering enemy (ends the decision); 1 in 5 without one                                                     | `AAB:143-151`               | NationTargeting                  |
| Reserve and trigger gates | below reserve: nothing; below trigger: the strategy list 1 decision in 10                                                           | `AAB:290, :293`             | NationTargeting, NationRetaliate |

### 5.8 Nation targeting and retaliation

| Name               | Value or formula                                                                                              | Source                                 | Pinned by                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------ |
| Strategy order     | retaliate, bots, veryWeak, betray, assist, victim, traitor, juicy, afk, nuked, hated, weakest, island, donate | `AAB:426-428`                          | NationTargeting                |
| veryWeak           | troops < 0.15 x own M and < 1.2 x nation troops (both strict)                                                 | `AAB:655-666`                          | NationTargeting                |
| victim             | sum of incoming > 0.5 x troops, and ≤ 1.2 x nation troops                                                     | `AAB:636-651`                          | NationTargeting                |
| juicy              | ≤ 0.75 x nation troops (then the juiciest by score)                                                           | `AAB:669-674`; `NationUtils.ts:52-104` | NationTargeting                |
| weakest            | < 1 x nation troops                                                                                           | `AAB:388-398`                          | NationTargeting                |
| hated              | relation < -50 and ≤ 3 x nation troops, at any distance                                                       | `AAB:369-378`                          | NationTargeting, NationSendCap |
| Retaliation answer | `min(T - r x M, max(T - ceil(0.9 H), sum of incoming))`; plan with r = 0.30                                   | `AAB:313-319, :1052-1074`              | NationRetaliate                |
| Survive the answer | our live stack > T - 0.30 x M                                                                                 | derived                                | NationRetaliate 5              |
| Retaliation delay  | an attack that inits in a decision tick is first answered `attackRate` ticks later                            | `GameImpl.ts:526-551`                  | NationRetaliate 2              |

### 5.9 Alliances

| Name                         | Value or formula                                                                                                                      | Source                                                     | Pinned by      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------- |
| Threat (accepted)            | H > 1.5 T_N; or H > T_N and (M > 1.5 M_N or tiles > 1.5 tiles_N)                                                                      | `NAB:251-279`                                              | NationAlliance |
| Similarly strong (accepted)  | troops + outgoing > (0.80-0.89) T_N; or tiles > (0.90-0.99) tiles_N with troops > 0.5 T_N                                             | `NAB:361-400`                                              | NationAlliance |
| Too many alliances (refused) | ≥ 0.25 x living non-bot players                                                                                                       | `NAB:181-200`                                              | NationAlliance |
| Request cooldown             | 300 ticks from the request's creation                                                                                                 | `Cfg:810-812`                                              | NationAlliance |
| Alliance duration            | 3,000 ticks                                                                                                                           | `Cfg:813-819`; `AllianceImpl.ts:23`                        | NationAlliance |
| Betrayal lines               | only neighbour with 3 H < T_N; isSafeToBetray total < 0.33 T_N; traitor < 1.2 T_N → keep H ≥ 0.34 T_N                                 | `NAB:404-491`                                              | NationAlliance |
| Cost of breaking             | traitor for 300 ticks; -100 from the betrayed; -40 from everyone nearby                                                               | `BreakAllianceExecution.ts:45-56`; `PlayerImpl.ts:869-879` | NationAlliance |
| Nuke breaks an alliance      | blast weight > 100 of the ally's tiles, or an ally structure within the outer radius (Atom 30, Hydrogen 100); a MIRV always breaks it | `Util.ts:100-129`; `MIRVExecution.ts:110-120`              | NationAlliance |

### 5.10 Nukes and SAMs

| Name                        | Value or formula                                                                                                              | Source                                                       | Pinned by                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------- |
| Crown lead                  | the leader's share of (land - fallout) minus the nation's own > 0.1                                                           | `NNB:351-417`                                                | NukeThreat                 |
| Majority                    | > 0.5 of (land - fallout)                                                                                                     | `NNB:256-274`                                                | NukeThreat                 |
| Structure density           | > 1/75 levels per tile and ≥ 5 levels (richest nation, 1 in 2)                                                                | `NNB:318-343`                                                | NukeThreat                 |
| Heavy attack                | sum of incoming ≥ nation troops (unlocks atoms for hydro nations and the real price)                                          | `NNB:533-544`                                                | NukeThreat                 |
| Perceived price             | +25% per Hydrogen bomb and +50% per Atom bomb the nation has launched                                                         | `NNB:814-823`                                                | NukeThreat                 |
| Aim rings                   | Atom 30 / 15; Hydrogen 100 / 50 (perimeters only)                                                                             | `NNB:175-184`; `Util.ts:165-201`                             | NukeThreat                 |
| Blast radii (inner / outer) | Atom 12 / 30; Hydrogen 80 / 100; MIRV warhead 12 / 18                                                                         | `Cfg:1103-1117`                                              | NationAlliance, NukeThreat |
| SAM salvo                   | (sum of the covering SAMs' levels + 1) atoms, plus 1 per 5                                                                    | `NNB:945-1060`                                               | NukeThreat                 |
| MIRV land share             | ≥ 40% of `numLandTiles()`                                                                                                     | `NMB:86-99`                                                  | NukeThreat                 |
| MIRV city lead              | > 8 city levels and ≥ 1.15x the runner-up's                                                                                   | `NMB:102-128`                                                | NukeThreat                 |
| MIRV gates                  | a silo, the gold, hesitation 1 in 16, 300-tick per-target cooldown; allies are valid targets                                  | `NMB:32, :133-147`                                           | NukeThreat                 |
| SAM range                   | `150 - 480/(L+5)` = 70 / 81.4 / 90 / 96.7 / 102                                                                               | `Cfg:1136-1151`                                              | NukeThreat                 |
| SAM interception            | no hit roll; L interceptors, 90-tick reload; targetable only within 150 tiles of launch or aim; warheads yes, MIRV carrier no | `Cfg:370-372, :1136-1147`; `SAMLauncherExecution.ts:262-267` | NukeThreat                 |

### 5.11 Boats and the win

| Name                                              | Value or formula                                                                      | Source                                            | Pinned by   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------- |
| Boat cost and cap                                 | 0 gold; ≤ 3 at sea; no cooldown                                                       | `Cfg:572-575, :850-855`; `TSE:79-92`              | BoatsAndWin |
| Boat speed                                        | 1 path step per tick in 4 directions; ETA ≈ route length + 1                          | `TSE:38`; `PathFinder.ts:47-66`                   | BoatsAndWin |
| Loss landing on our own tile, or on `cancel_boat` | 25%                                                                                   | `TSE:32, :248-270`                                | BoatsAndWin |
| Win                                               | `tiles x 100 > (numLandTiles - fallout) x 80`, checked every 10 ticks after the phase | `WinCheckExecution.ts:38-40, :118-142`; `Cfg:255` | BoatsAndWin |

---

## 6. Still unpinned (derived or cited from code only)

- **Opening combination.** A turn-1 spawn next to a fresh tribe, with a 1-troop attack on that tribe in the same turn, should annex it in tick 3 (the attack inits when the phase ends, `AE:71`, and tribes are not immune). Each half is pinned (SpawnPhaseSingleplayer 4 and 9; TribeStats), but the sequence has not been run as one.
- **Boxing a nation.** Suppose a partially covered nation is left under 100 tiles with no free land; after the 50-tick immunity, a 1-troop attack would annex it. This follows from `AE:448-482` but is untested, and the nation would attack us first.
- **Remnant split.** How `handleDeadDefender` splits a remnant between the attacker and third parties.
- **Economy.** Port trade volume, how Port income scales with level, and train gold.
- **Duplication via boats.** The 20-step duplication through `cancel_boat` followed by a land click.
- **Rate limiter.** Whether `AgentHost`'s rate limiter can move an intent onto the 20-step case.
- **Real-game frequencies.** How often nations are under tribe attack, below their expand ratio, or holding grudges; how often they retaliate against a beachhead.
- **Map and mode coverage.** River-only free land; mixed-terrain fronts; fallout with real nukes; team mode; lower difficulties.
- **Browser autopilot.** Whether it reaches turn 1 depends on how the local server times turns.
- **Erased nations.** Whether an erased (never placed) nation affects the win check or anything that counts nations.
- **Assist cost.** The -20 relation cost of `assist` (`AAB:561`).
- **Roadmap H10 and "20 of 127 maps".** Not covered by these twelve files. ForkFidelity covers H10.

---

## Appendix: the other five files in `tests/agent/mechanics/`

These pins come from the apex spec, not from section 11.3. They pass with the rest:

| File                            | Tests | What it pins                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AllianceRecallEmbargo.test.ts` | 5     | A nation attacking us accepts a similar-strength request only if our `embargo stop` takes effect at least one turn before its answering decision. On acceptance its attack retreats in full.                                                                                                                |
| `FreeLandLockSend.test.ts`      | 4     | The free-land "lock" holds only while `T - expand x cap ≥ 1`. A tribe that owns a structure is attacked before the reserve gate.                                                                                                                                                                            |
| `LightningRod.test.ts`          | 5     | A nation with an affordable bordering tribe attacks the tribe, not a juicy us, until the tribe is gone (about one decision per tribe).                                                                                                                                                                      |
| `NationParams.test.ts`          | 7     | `nationParams(gameID, id, difficulty)` and `tribeParams(id)` (`src/agent/lib/NationModel.ts`) reproduce every execution's ratios, rate and phase; every nation attack, boat and hop falls on a decision tick. It takes 21-26 s under parallel load, over the 20 s budget, but has a 120 s per-test timeout. |
| `TroopCapClamp.test.ts`         | 4     | Troops above the cap are cut to `ceil(max)` on the next tick, whether from a refund or anything else, for Humans and Nations alike.                                                                                                                                                                         |
