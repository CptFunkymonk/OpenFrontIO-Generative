# 11 — Roadmap: beating Impossible nations on any map

> The plan of record for `src/agent/`. Written 2026-09-26 at commit `7b52b78`
> from the measurements in §11.1 and a reading of the Nation AI's source.
> Update the status column of §11.6 and append to
> [`12-ledger.md`](12-ledger.md) as work lands. Change the rest only when a
> measurement contradicts it.

## 11.1 Starting point

### The environment works (verified 2026-09-26)

| Check                                                   | Result                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionStart hook                                       | Node 24.21.0, npm 12.1.0, `npm ci`, Playwright 1.56.1, all provisioned                                                                            |
| `npx vitest tests/agent --run`                          | 13/13 pass in ~4 s                                                                                                                                |
| `npm run arena`                                         | 4 games in parallel on 4 cores; 100–780 ticks/s per game (median 280); a played-out game takes ~48 s of wall time: **~4.8 games per wall minute** |
| Browser autopilot (`autopilot.mjs baseline Iceland 60`) | spawned unaided at tick 8, 7,911 tiles by tick 404, replica never behind, no divergence. Headless SwiftShader runs the client at ~0.7× real time  |
| Machine                                                 | 4 cores, 15 GB RAM                                                                                                                                |

### The baseline loses every game

Arena defaults (FFA solo, Impossible nations, 400 tribes, normal size), 24
random maps, seeds `plan-check` and `plan-bench`:

| agent                         | games | wins | eliminated | eliminated at (median) | peak land (mean / max) | placement (mean) |
| ----------------------------- | ----- | ---- | ---------- | ---------------------- | ---------------------- | ---------------- |
| `baseline`                    | 24    | 0    | 15         | 8.5 min                | 6.7% / 25.9%           | 8.8              |
| `idle` (spawns, then nothing) | 24    | 0    | 24         | 2.9 min                | 0%                     | 18.2             |

Against the leading nation, the baseline holds a median **3.8% vs 8.3%** of
the land at minute 3 and **2.9% vs 18.7%** at minute 10. It was never ahead
of the top nation at either checkpoint.

### The clock

With `--play-out`, **an Impossible nation took 80% and won all 40 games**:
median 22.9 game minutes, quartiles 20.6–27.6, fastest 10.2 (Bering Strait,
2 nations), slowest 57.8. No game reached the 60-minute cap.

So beating the Nation AI means **reaching 80% before the fastest nation
does, usually inside 15–25 game minutes**. Surviving is necessary and nowhere
near enough: the agent has to be the one that snowballs.

## 11.2 The goal, made measurable

| Term     | Definition                                                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Win      | the arena records `win`: the agent held > 80% of non-fallout land (`WinCheckExecution`)                                                                                                                               |
| Setting  | arena defaults, the browser's solo mode against the strongest AI: FFA, Singleplayer, Impossible, the map's default nations, 400 tribes, normal size, 1 turn of latency, 10/s and 150/min intent limits, 60-minute cap |
| Any map  | the default pool: the 127 maps that have nations. Judged per map and per category, not only on average                                                                                                                |
| **Done** | `holdout` (§11.5): **≥ 90% wins, every map won in ≥ 2 of 3 seeds**, and the same agent plays unchanged as the browser autopilot                                                                                       |

Robustness to other lobbies (Hard, compact maps, fewer tribes, random spawn,
team modes) is a hardening pass after Done, not part of the goal.

## 11.3 Strategy: where an agent beats the Nation AI

The Nation AI is in this repo (`NationExecution.ts`, `nation/*.ts`,
`utils/AiAttackBehavior.ts`) and runs inside the deterministic simulation.
Its advantages are stats: ×1.25 `maxTroops`, ×1.05 regrowth, 31,250 starting
troops against our 25,000, zero latency. Ours are information and decisions:
every threshold it uses is readable state, we can act every tick while it
decides every 30–50, we may spawn anywhere, and in singleplayer `ctx.fork()`
predicts the future exactly (H10).

The hypotheses are ordered by when to test them. Each gives the mechanism and
the arena measurement that confirms or kills it. The rules quoted were checked
against source on 2026-09-26; conclusions drawn from them are **[DERIVED]**
and must be pinned by a scenario test before an agent depends on them.

Treat chapter 09 as a prior, not a spec. For example, its advice to run 2–3
parallel land attacks on free land buys nothing: a new land attack on the same
target absorbs every earlier one (`AttackExecution.init`).

**H1 — The spawn is the largest single decision.** In singleplayer the spawn
phase ends only when we spawn (`SpawnExecution.tick`) and nothing grows until
then, so the choice is untimed. Tribes are placed on the first tick; nations
hop within ±25 tiles of their manifest positions
(`NationExecution.randomSpawnLand`). Score candidates by the free land we win
in a race against every other spawn (multi-source flood fill on a coarse grid,
weighted by starting troops and terrain), plus coast on a large water body and
nearby tribes as food. Then check the top few by forking and simulating
60–90 s of expansion. _Measure:_ land share and rank among nations at
minute 3.

**H2 — The land grab is limited by troop income and frontage, not stack
size.** A free-land attack costs a flat 16/20/24 troops per plains, highland
or mountain tile. Its speed saturates at ~400 × tileCost troops (6,600 on
plains), beyond which only frontage adds speed (`Config.attackLogic`, §02.7).
Regrowth peaks with home troops at ~42% of the cap (§03), but every tile also
raises the cap, so the best home level is an empirical question. Nations keep
only 10–20% at home (`expandRatio`). A first sweep of the baseline (10% and 42%
home against its 20%) changed nothing measurable (ledger), so the home level
must be tuned with the rest of the expansion policy, not read off the formula.
Keep the free-land stack at saturation and send the surplus to separate
targets. _Measure:_ tiles at minutes 1, 2, 3.

**H3 — Tribes are the second land grab.** There are 400 tribes with a third of
the cap and half the regrowth, and we take ×0.7 attacker losses against them
(§02.1, §03). Once free land runs out, Impossible nations attack up to 100
tribes at once (`getBotAttackMaxParallelism`). Attacks on different targets
never merge, so run one per bordering tribe, sized to finish it, lowest density
and widest contact first, starting while free land remains. [DERIVED] A stack
of ≥ 1.22× the defender's troops takes player tiles ~1.6× faster per unit of
frontage than free land: `speedCost` bottoms out at a troop ratio of 0.82,
giving ~0.63 tiles per tick per border tile against free land's 0.4.
_Measure:_ land at minutes 5 and 10; share of tribe land we took.

**H4 — Be unattackable instead of defending.** In FFA an Impossible nation
sends at most `troops − 0.9 × (strongest non-allied, non-bot nearby player's
troops)` (`troopSendCap`). It refuses to send < 20% of the target's troops
unless it is itself under attack (`isAttackTooWeak`). While it borders free
land it launches no other land or boat attack (`maybeAttack`). [DERIVED] So
it cannot attack us by land while our **home** troops exceed ~0.91× its
troops, or by boat (it sends troops/5) while they exceed its troops. At 1.11×
even a nation under attack is capped at the size of the attack it faces. Also
stay out of `veryWeak` (< 15% of our cap), `juicy` (≤ 75% of its troops) and
`victim` (incoming > 50% of our troops). This puts a floor on attack sizing:
never send troops that drop home below the deterrence level of a nation that
can reach us. _Measure:_ nation attacks received; eliminations.

**H5 — Strike nations when they cannot answer.** Impossible's first strategy is
`retaliate`: it answers the largest incoming attack with `troops − reserveRatio
× cap` (reserve 30–40%), and that new attack cancels ours 1:1 when it is
created (`AttackExecution.init`). It skips its whole strategy list while it
borders free land or is below its reserve, and 90% of the time when below its
trigger of 50–60% of cap (`maybeAttack`, `attackBestTarget`). [DERIVED] So
strike when it is below its trigger (for instance just after it launched a big
attack), or with more troops than it holds above its reserve. Strike across
the widest shared border, with a stack of ≥ 1.67× its troops: the `troopRatio`
clamp at 0.6 makes that the cheapest per tile. Predict with
`config().attackLogic()` (a pure function) and confirm big strikes with a
fork. Finishing a player hands its unreached remnant to third parties
(`handleDeadDefender`, §02.4). _Measure:_ tiles gained per troop spent against
nations; how often they retaliate.

**H6 — Alliances on demand close fronts.** Impossible accepts a request from
anyone with 1.5× its troops, or with more troops and 1.5× its cap or tiles
(`isAlliancePartnerThreat`). It refuses traitors (90% of the time) and anyone
already allied with ≥ 25% of the non-bot players. Before tick 700 in
singleplayer it accepts 30% of other requests too (`isEarlygame`). Allies
cannot attack each other, and alliances lapse after 5 minutes at no cost.
[DERIVED] Fight one front at a time and ally the rest. Let alliances lapse
rather than break them: breaking makes us a traitor for 30 s (half attacker
losses and 25% faster attacks against us, −40 from neighbours). Use
`targetPlayer` to point allies at our target. _Measure:_ hostile fronts over
time; attacks received.

**H7 — Gold becomes cap.** Income is a flat 100/tick plus trade (§03). One city
level adds 250,000 to the cap, worth ~5,100 tiles mid-game. The first 125,000
gold arrives near tick 1,250: build a Port if a ≥ 300-tile route to a
tradeable foreign port exists (~13× income), else a City. Port levels are
superlinear, and Ports and Factories share one cost ladder. Attacking a nation
makes it embargo us for 5 minutes (`AttackExecution.init`), so our trade
partners are the nations we are not fighting. _Measure:_ gold per minute; cap
at minutes 5, 10, 15 against the top nation.

**H8 — The endgame has a MIRV problem.** Impossible nations MIRV anyone holding
≥ 40% of all land tiles (fallout included), and the city leader once it has
more than 8 cities and 1.15× the runner-up's (`NationMIRVBehavior`), if they
own a silo and can pay. A MIRV cannot be intercepted and costs 25M gold,
rising by 15M per launch (§05). Plan the run from 40% to 80%: impoverish or
kill the richest nations first, cross the gap fast, and build SAMs against
ordinary nukes. _Measure first:_ how often MIRVs are launched at
the agent in the arena, and at what land share.

**H9 — Water maps are boat maps.** 20 of the 127 maps are under 25% land.
Boats are free, 3 at a time, with no cooldown, and take their landing tile
without combat (§02.6); a later land attack on the same target absorbs the
beachhead. Use boats for free land and tribes on other landmasses during the
land grab, not only when landlocked. _Measure:_ results per map category.

**H10 — Lookahead is exact; spend it on large decisions.** Against nations in
singleplayer our intents are the only input from outside the simulation, and
snapshots restore byte-identically
(`tests/core/snapshot/FullGameSnapshot.test.ts`). A fork stepped with our
intents therefore _is_ the future, with two caveats. Intents sent but not yet
executed are not in the snapshot, so replay them into the fork's first step.
And it is expensive: ~0.3 s to fork plus ~4 ms per tick on World mid-game
(§10.6). Use it for the spawn (H1), strike go/no-go (H5) and alliance timing
(H6), never per tick.

## 11.4 Agent architecture

Build a new agent beside `baseline`, which stays unchanged as the reference.

```
src/agent/agents/<name>/
  index.ts        the Agent; each decision: perceive → safety → controllers → schedule
  options.ts      every tunable with its default, overridable as JSON (--agent <name>:{...})
  controllers/    spawn, expansion, tribes, defense, strike, diplomacy, economy, naval, nuclear
src/agent/lib/    shared read-only helpers (existing: Perception.ts, SpawnPlanner.ts)
  WorldModel.ts   one scan per decision: neighbours with contact, troops, density, cap
                  and ratios; free-land frontier; free land across water; game phase
  Models.ts       predictions straight from game.config(): attackLogic, maxTroops,
                  troopIncreaseRate, unit costs
  NationModel.ts  each nation's gates as predicates: borders free land? above reserve
                  or trigger? able to attack us (H4)? would accept an alliance (H6)?
                  MIRV risk (H8)?
  Scheduler.ts    proposed intents by priority under 10/s and 150/min, deduplicated
  Lookahead.ts    fork, replay pending intents, roll forward, score; within a budget
```

- **Rule-based controllers with model-based sizing and tuned parameters**, plus
  lookahead for a few decisions. Not reinforcement learning: at ~290 games an
  hour on 4 cores, against 0.2–4.2M land tiles of state, there is not enough
  simulation for it. Revisit only with a compact state abstraction and far more
  compute.
- Read `ctx.game`, act only through `ctx.send`, `--isolate` on every change.
  Call the `game.config()` formulas instead of copying them, so rule changes
  flow through.
- Budgets: p95 `tick()` < 5 ms on the largest maps (the browser worker is one
  thread); lookahead ≤ ~1 s per 10 s of game time, switchable off with an option
  for fast A/B runs.
- No DOM or Node APIs: the same code runs in the arena and in the browser
  worker.

## 11.5 Evaluation protocol

### Suites

| Suite     | Contents                                    | Wall time per entrant | Use                         |
| --------- | ------------------------------------------- | --------------------- | --------------------------- |
| `smoke`   | 4 small maps, `--isolate --strict`          | ~1 min                | every change                |
| `dev`     | 16 maps × 2 seeds (below)                   | ~8–12 min             | every A/B                   |
| `full`    | all 127 maps × 1 seed                       | ~30–45 min            | milestone checks            |
| `holdout` | all 127 maps × 3 seeds never used in tuning | ~1.5–2.5 h            | milestone sign-off and Done |

`dev` maps, chosen to span the pool: World, Europe, Africa, NorthAmerica,
GiantWorldMap (107 nations), Alps and TheBox (all land, no ports),
MiddleEast (3.4M land tiles), ArchipelagoSea and Japan (6–8% land),
FourIslands, BeringStrait and YellowSea (2 and 8 nations, won by a nation in
10–21 and 15 min), Onion (smallest), MississippiRiver and Passage (400 tiles
wide).

### Metrics

Primary: win rate with its Wilson interval. Until wins exist: `progress`
(peak land ÷ 0.8), land share and rank among nations at minutes 3, 10 and
15, eliminations, survival time. Once winning: time to win, against the minute
a nation wins the same game with `idle` in our seat.

### Comparisons

The same seed gives every entrant the same maps and game IDs, so comparisons
are paired. Report discordant wins (sign test) and mean Δprogress with a
bootstrap 95% interval. Adopt a change only when the `dev` difference is
positive with the interval excluding zero and `smoke` passes. Confirm
milestone claims on `holdout`. Tuning touches only `dev` seeds.

Calibration from the first sweep: 20 paired games resolve only differences of
about ±0.04 in mean progress, and a mean can hide a change that loses most
games (+0.028, yet worse in 14 of 20). Use 64+ paired games for anything
smaller, and always read the better/worse split beside the mean.

### The ledger

`arena-results/` is git-ignored and containers are reclaimed. Every adopted
change and milestone measurement appends a row to
[`12-ledger.md`](12-ledger.md).

### Compute

At ~4.8 games per wall minute, a 32-game paired A/B takes ~15 min and a
16-config × 32-game sweep ~2 h. For bigger sweeps, fan out to several cloud
sessions with the same seeds and merge their `summary.json` files.

## 11.6 Milestones

|     | Milestone            | Deliverables                                                          | Exit criterion                                                                               | Status              |
| --- | -------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------- |
| M0  | Ground truth         | environment verified, baseline measured, this plan, the ledger        | —                                                                                            | **done** 2026-09-26 |
| M1  | Measurement          | the §11.7 tooling; the baseline's `dev` numbers in the ledger         | one command per suite; paired report; fork-fidelity test green                               |                     |
| M2  | Opening              | H1, H2, H3 in a new agent                                             | at minute 3, land ≥ the median nation's in ≥ 80% of `dev` games, ≥ the top nation's in ≥ 50% |                     |
| M3  | Survival             | H4, defensive H6                                                      | eliminated before minute 20 in < 10% of `dev` games; top-3 land at minute 10 in ≥ 70%        |                     |
| M4  | Conquest and economy | H5, H7                                                                | first wins; ≥ 25% on `dev`                                                                   |                     |
| M5  | Closing              | H8, a faster snowball                                                 | ≥ 60% on `dev`; median time to win under 22.9 min (the nations' median)                      |                     |
| M6  | Any map              | H9, the weakest categories fixed, big-map think time                  | `full` ≥ 80%, no category under 60%, no map lost on every seed                               |                     |
| M7  | Browser              | the autopilot plays to a win on 3 maps including World, within budget | a recorded run per map, no divergence                                                        |                     |
| —   | **Done**             |                                                                       | `holdout` ≥ 90%, every map won in ≥ 2 of 3 seeds                                             |                     |

Cross-cutting from M2 on: **tuning** (`npm run tune`, successive halving over
option sets on `dev`) and **lookahead** (H10). Both are adopted only through
the same paired test.

## 11.7 Tooling backlog (M1)

In order, in `src/agent/arena/` unless noted:

1. `--each-map [--repeat R]`: every map in the pool once per repeat, instead
   of random draws with replacement.
2. `--suite smoke|dev|full|holdout`: named presets for maps, seeds and flags
   (§11.5).
3. `--game N`: rerun one game of a run by index with verbose agent logs, to
   debug a loss.
4. Timeline: land share and rank among nations at fixed minutes; the leading
   nation's share; attacks received by attacker type; nukes and MIRVs
   received; who took our last tiles.
5. Attack log per game: target, troops sent, tiles gained, troops lost, and
   how it ended (burned out, retreated, frontier emptied, cancelled by a
   counter-attack).
6. `npm run arena:compare -- dirA dirB`: the paired report from two result
   directories run with the same seed, so versions from different commits
   compare without keeping frozen copies in the registry.
7. A fork-fidelity test (`tests/agent/`): fork, step the fork and the real game
   with identical intents for N ticks, compare hashes.
8. Fork time reported separately from think time.
9. `npm run tune`: successive halving over a JSON list of option sets on `dev`,
   writing a ranked table.

## 11.8 Risks

| Risk                                                                           | Mitigation                                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Chapters 00–09 were written by a model; chapter 09 already has one wrong claim | pin every mechanic an agent relies on with a scenario test against the real simulation, in the style of `tests/__snapshots__/Attack*` |
| 4 cores make A/B runs slow and small differences invisible                     | paired seeds, shaped metrics before wins exist, `dev` rather than `full`, more sessions for sweeps                                    |
| Overfitting the `dev` seeds                                                    | tune only on `dev`; sign off on `holdout`                                                                                             |
| Lookahead is too slow on big maps or in the browser                            | a budget per game minute, an off switch, fork time measured separately (§11.7 item 8)                                                 |
| The 150/min intent limit caps micromanagement                                  | the scheduler prioritises; top-ups of a free-land attack merge into one anyway                                                        |
| Upstream merges change the mechanics                                           | after each upstream merge, rerun `full` and the golden tests; the mechanics docs are pinned to `22722df`                              |
| An agent mutates the game and desyncs the browser replica                      | `--isolate` in `smoke`; agents never call a mutating method                                                                           |

## 11.9 How a session works

1. Read `CLAUDE.md`, this file and the tail of `12-ledger.md`. Take the first
   open item of the earliest unfinished milestone.
2. Branch from `main`: one milestone step per branch and PR.
3. Pin the mechanic you rely on with a test, then build the change as a new
   agent or behind an option.
4. Run `npx vitest tests/agent --run`, `npm run lint`, the `smoke` suite, then
   the paired `dev` A/B against the current best agent.
5. Adopt only on a clear paired gain: append the ledger row, update §11.6,
   commit, push.
6. Long runs (`full`, `holdout`, sweeps) go in the background; commit their
   summaries to the ledger before the container is reclaimed.
