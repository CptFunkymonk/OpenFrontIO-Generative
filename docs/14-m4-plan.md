# 14 — M4 plan: grow by exact search

> The build plan for apex's midgame, written 2026-09-27 by a design panel
> (three independent designs: troop flow, predator, search; scored by three
> judges; synthesized). The winning design uses exact search: fork the live
> game, roll candidate plans forward with an exact copy of the live policy,
> and play the best. Its prototype ("act3") is preserved as
> [`prototypes/act3-search.patch`](prototypes/act3-search.patch) (apply to
> `2e6293f`). Paths under `/tmp/claude-0/` below are the panel's scratch
> runs and scripts; they do not outlive the container. Results that matter
> are copied into [`12-ledger.md`](12-ledger.md) as they are confirmed.

Written 2026-09-27 at `5a66571`. Apex's defaults are "UE": the A1 window
strikes with their round-2 fixes plus A3 spawn erasure, adopted at `4f1913c`.
The base design is `search.md`, ranked first by all three audits. `flow.md`
and the predator scratch code supply the grafts. Every point an audit disputed
was checked again for this plan (§1.9). The analysis scripts are in
`/tmp/claude-0/growth/plan-ana/`.

Sources, cited in brackets:

- **[UE]** `arena-results/quick20-int`, entrant 3: UE on the 32 quick@20
  games. **[UE-dev]** `arena-results/dev20-int`, entrant 1: UE on dev@20,
  still running (188 of 254 games at 03:05).
- **[S-in]** The act3 search on 9 quick games: World g0, Alps g2, Europe g6,
  Japan g8, The Box g9, Africa g11, Middle East g13, North America g15 and
  Onion g20 (`/tmp/claude-0/search/act3-g*`). Its rules were tuned on these
  games.
- **[S-oos]** The same act3 options on 10 other quick games: Bering g3 and
  g19, Mississippi g10 and g26, Yellow Sea g12 and g28, World g16, Alps g18,
  Four Islands g23 and Japan g24. This is the audit's run, in the session
  scratchpad under `oos/`.
- **[S-hb]** act3 with breaks judged at 1,800 ticks instead of 1,200, on 6 of
  those games. This plan's run, in the scratchpad under `plan-hb/`.
- **[A45]** Alps g2 played to 45 minutes with the act2 search
  (`/tmp/claude-0/search/act-g2-45`).
- **[flow]** `flow.md`: 29 replays of quick20-champion and 9 paired rule
  variants.
- **[A1] [A2] [B1] [B2] [B3]** The package notes in `/tmp/claude-0/pkg-*`.
- **[F]** The `Config.ts` formulas, as pinned in chapter 13 §5.
- **[code]** A cited source line in `src/core`.

Labels:

- **Proven**: measured, or exact from the formulas or the code.
- **Derived**: computed from proven parts under a stated assumption.
- **Guess**: not measured.

Other conventions:

- Intervals are 95% paired-bootstrap intervals.
- "Land" is our share of the map's land, as the arena reports it.
- A share "at minute m" for a game that ended earlier is the final share, and
  0 if we were eliminated.

---

## 0. The plan in brief

1. **Safe targets limit growth, not troops or price.**
   - UE idles at its troop cap in 83-85% of minutes 5-15. It realizes 10-12%
     of its peak regrowth.
   - At the prices apex already pays, that flow is worth about twice the top
     nation's growth: 38k net tiles a minute against the top nation's 19k
     (§1.3).
   - What is missing is a target that brings no pile-on. Alliances veto 79% of
     strike evaluations. Rules that opened the strike gates, or dropped or
     trimmed the web, lost land. The one floor change that helped (R1) is
     weak.
2. **Exact search unlocks it. Pooled over 19 quick@20 games, paired with
   UE:**
   - Progress +0.199 [+0.107, +0.305].
   - Peak land +16.0 points, better in 15 games and worse in 2.
   - Land at minute 10 +8.2 points [+2.2, +16.2].
   - 2 wins (Japan g8 and Japan g24) against none.
   - Regrowth utilization 0.39-0.47 against 0.10-0.12.
   - Out of sample, land at minute 20 is not yet shown: +10.8 [−3.5, +28.5],
     median 0.
3. **The failures are specific, and each has a fix:**
   - Breaks whose collapse comes after the 1,200-tick look (Alps g18). Fix: a
     longer, danger-gated look for breaks. In this plan's 6-game run, an
     ungated 1,800-tick look was better or equal at minute 20 in all 6 games
     (both arms won Japan g24), with one elimination fewer (§4.2).
   - Giants with no defensive plan (Africa g11, Mississippi g10). Fix:
     defensive candidates from the base rollout's whole horizon.
   - No land neighbour at all (29 of 130 out-of-sample searches). Fix: boat
     candidates.
   - Leaders that collapse: Onion g20, Mississippi g26 (a MIRV) and [A45].
     Fix: the leader-phase work, and the measurement that decides it.
4. **The design.** Search.md's SearchController, with five changes:
   - danger-gated break horizons;
   - defensive and naval candidates;
   - a value that can price danger (off until fitted);
   - a budget capped at 2.5× game time;
   - leader-phase work on gold and structures. Impossible nations only bomb
     tiles whose blast covers one of our structures, and the search arm ends
     games holding a median 9M gold.
5. **Nine work packages on disjoint files, and a tenth for later (§3).**
   Exactness (WP1) is the only hard prerequisite. Two measurement packages
   start on day 1 on the scratch trees: WP4, the long-horizon regret study,
   and WP9, the 60-minute play-out of the minute-20 leaders.
6. **Expected effect:**
   - M3's top-3 bar (≥ 70%) is likely met. It was 74% on the 19 games,
     against UE's 58%.
   - The elimination bar (< 10%) is borderline.
   - M4's "first wins" is already shown on quick@20: 2 in 19 games. It needs
     only the port (WP1 and WP2).
   - "≥ 25% on dev" depends on converting the lead into wins. The only
     played-out lead, [A45], was lost. WP9 decides whether the next round is
     more growth or leader-phase work (§4).

---

## 1. Diagnosis in numbers

### 1.1 Where UE stands [UE, proven]

UE on quick@20, 32 games:

| measure                                    | UE                            |
| ------------------------------------------ | ----------------------------- |
| progress                                   | 0.212                         |
| peak land                                  | 17.0%                         |
| final land                                 | 8.2%                          |
| eliminated                                 | 4 (12.5% before minute 20)    |
| top 3 at minute 10                         | 58.1% (18 of 31)              |
| at minute 3: ≥ median nation, ≥ top nation | 100%, 65.6%                   |
| wins                                       | 0                             |
| games lost before minute 20                | 12 of 32, at 8.9-19.3 minutes |

Of those 12 games, a nation won 8: Onion g4 and g20, Yellow Sea g12 and g28,
Bering g3 and g19, Four Islands g23 and Japan g24. UE was eliminated in the
other 4: Four Islands g7, The Box g9 and g25, and Passage g21 (corrected by
WP6's review, 2026-09-27). The top nation's median share is
11.3% at minute 5, 17.7% at minute 10, 20.6% at minute 15 and 30.5% at minute 20. The 75th percentiles are 16.8%, 26.2%, 36.9% and 43.1%.

The race is decided early. A nation that snowballs does not slow down:

- On Alps g18, Novara held 13.1% at minute 10 and 80% at minute 19.9, which
  is 6.7 points a minute [S-hb].
- The large-territory bonuses make big attackers cheaper and faster (§1.3).

### 1.2 The troop flow is idle [F, flow, proven]

The formulas, all from `game.config()`:

- **Cap.** C = `config.maxTroops(me)` = 2·(tiles^0.6·1000 + 50,000) +
  250,000·(finished city levels). An Impossible nation's cap is ×1.25.
- **Regrowth.** `config.troopIncreaseRate(me)` = (10 + H^0.73/4)·(1 − H/C) a
  tick, for home troops H. An Impossible nation's is ×1.05.
- **Peak.** It is at H = 0.73/1.73·C = 0.42·C, and worth about 0.077·C^0.73 a
  tick. That is 1.1, 1.8, 2.5, 3.1, 4.1 and 6.0M a minute at caps of 1, 2, 3,
  4, 6 and 10M.
- **At the cap** regrowth is 0.

**UE, minutes 5-15.** Utilization (Σ regrowth ÷ Σ peak regrowth over the
timeline samples) is 0.12 on the [S-in] games and 0.10 on the [S-oos] games.
83-85% of the samples are at ≥ 95% of the cap. That forgoes 4-10 caps of
troops per surviving game [flow].

**The top nation** keeps 0.49-0.50 of its cap at home (quartiles 0.48-0.52).
It turns 93% of its regrowth into land [flow, 29 replays].

### 1.3 How fast land could come [derived]

The model, `growth.py` and `growth2.py`:

- It starts from UE's land at minute 5, in its 25 games alive at minute 15.
- Home is held at 0.5 of the cap, which is 0.98 of peak regrowth.
- The cap comes from land only.
- Every troop of regrowth is spent at P troops per net tile.
- It is integrated over the 10 minutes from minute 5 to minute 15.

| price model                                        | apex net tiles/min (median) | apex ≥ top nation at m15 | 80% of the land by m15 |
| -------------------------------------------------- | --------------------------- | ------------------------ | ---------------------- |
| P = 45 flat                                        | 70.0k                       | 25 of 25                 | –                      |
| P = 90                                             | 31.2k                       | 19                       | –                      |
| P = 136                                            | 18.9k                       | 11                       | –                      |
| P = 193 (the top nation's own all-in price [flow]) | 12.6k                       | 5                        | –                      |
| gross price from `attackLogic`, all-in = 2× gross  | 38.1k                       | 24                       | 8                      |
| the same, all-in = 3× gross                        | 26.0k                       | 16                       | 0                      |
| **measured: the top nation**                       | **19.2k**                   | –                        | –                      |
| **measured: UE**                                   | **0.6k**                    | –                        | –                      |
| **measured: search [S-in] / [S-oos]**              | **15.4k / 3.8k**            | –                        | –                      |

**The gross price**, for a stack about equal to the target's troops (r = 1)
and a defender density of 28 (the median bordering nation in minutes 4-15
[flow]), is

    80·r·(0.463·bA·bD + 0.0039·d),
    b(n, depth) = 1 − depth/(1 + (300,000/n)^2.5)   (depth 0.7 attacker, 0.3 defender)

That is 44 troops a tile at 50k of our tiles, 40 at 150k, 32 at 300k, 23 at
600k and 20 at 1.2M.

**The all-in price** is what home loses per net tile, attacks on us included:

- The search's measured all-in price, over minutes 5-15, is a median 82 per
  net tile [S-in] and 93 [S-oos]. That is about 2× gross.
- UE's window strikes pay 44 gross (45 launches, stacks 1.35× the target's
  troops) [flow].
- **The break-even price P\*** is the price at which apex matches the top
  nation's land at minute 15. It is a median 128 per tile (quartiles 88-154).
  (This is recomputed. Flow's `ode.py` table ran 11 minutes from the minute-5
  land and overstated growth by 15-20%.)

**So the flow is worth about 2× the top nation's growth at the price apex
already pays.** The search realizes 40% of it in sample and 10% out of
sample. The gap is supply and disasters (§1.4-1.7), not troops or price.

### 1.4 What limits it: safe targets [flow, A1, proven unless marked]

**The box.**

- 79% of 19,741 strike evaluations are vetoed by alliances: 68% "ally" and
  11% "allySet".
- In only 31% of samples is there an unallied bordering nation the strike band
  can pay for.
- In A1's stall diagnosis, 63% of evaluations were allied and 14% allySet. Of
  the eligible ones, 86% were above their trigger.
- The opening alliances last 3,000 ticks (`config.allianceDuration()`). They
  are made at ticks 100-1,800 and expire in minutes 5-8.
- Of the 185 lapses after minute 4 in 32 games, 18 were struck within 600
  ticks, 60 were re-allied within 900, and 107 neither.

**A low home is picked.**

- At home 0.5, 0.6, 0.7, 0.8 and 1.0 of the cap, some bordering nation can
  land-attack us in 94%, 90%, 83%, 74% and 46% of samples [flow].
- One such attack costs 27%, 22%, 15%, 12% and 8% of our land at home 0.5,
  0.6, 0.7, 0.8 and 0.9 [derived, `pileon.py`]. That takes our cap as 3M on
  140k tiles, and the neighbour at 1.05× our cap in troops and 1.5× in cap, on
  254k tiles. It is recomputed with `attackLogic`'s territory bonuses: flow's
  20/16/11/8% assumed b = 1 and understated the cost by about a third.
- A nation's send is min(T − r·M, T − ⌈0.9·H⌉), refused under 0.2·H
  (`AiAttackBehavior.ts:961-1054`). So it can land-attack us while H < T/1.1.

**Loosening by rule loses.** [flow, 16-32 pairs each]

- Opening the gates doubles the price, from 41 to 86-108 per tile. That is the
  regime where the stack is smaller than the target's troops. It draws 1.0-1.7
  attacks per strike.
- Dropping the web (X) loses 4.5 points at minute 15 [−7.0, −2.0], and
  eliminations go from 2 to 6.
- The derived troop web (T55) loses: eliminations 2 → 6.

**Nations outgrow us.**

- A nation has ×1.25 cap and ×1.05 regrowth. City levels are 54% of the top
  nation's cap growth in minutes 5-15 [flow].
- On Alps [A45], Veneto held a ~20M cap on 1.18M tiles. Land alone gives a
  nation there about 11.1M, so that is ~36 city levels. Apex held 14.3M on
  1.33M tiles.
- In 5 of the champion's 6 eliminations, the killer's land line T/1.1 was
  above apex's whole cap [B1]. No home deters that.

### 1.5 What exact search changes [S-in, S-oos, proven]

The act3 search is paired with UE on the same games. It is identical to UE
until its first act, at tick 2,400. Values are points of land (`paired19.py`).

| measure           | [S-in], 9 games                        | [S-oos], 10 games                        | all 19                      |
| ----------------- | -------------------------------------- | ---------------------------------------- | --------------------------- |
| land at minute 10 | +8.9 [+1.0, +21.8], 8 better / 1 worse | +7.6 [+1.1, +17.4], 6 / 1                | +8.2 [+2.2, +16.2], 14 / 2  |
| land at minute 15 | +16.1 [+7.8, +27.2], 9 / 0             | +11.6 [+0.2, +25.7], 6 / 3               | +13.7 [+6.1, +22.7], 15 / 3 |
| land at minute 20 | +19.2 [+9.3, +31.0], 8 / 1             | **+10.8 [−3.5, +28.5], 4 / 4, median 0** | +14.8 [+5.3, +25.3], 12 / 5 |
| peak land         | +20.9 [+12.0, +31.2], 9 / 0            | +11.5 [+1.0, +24.5], 6 / 2               | +16.0 [+8.5, +24.6], 15 / 2 |
| progress          | +0.260 [+0.150, +0.383]                | +0.144 [+0.013, +0.305]                  | +0.199 [+0.107, +0.305]     |

Counts on the 19 games, search against UE:

| count                              | search                                                                       | UE                                        |
| ---------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- |
| wins                               | 2 (Japan g8 at minute 9.1; Japan g24 at 80.3%, where a nation won UE's game) | 0                                         |
| eliminated before minute 20        | 2 (Africa g11, Alps g18)                                                     | 1 (The Box g9, which the search survived) |
| top 3 at minute 10                 | 14                                                                           | 11                                        |
| a nation won                       | 7                                                                            | 8                                         |
| bombs received (atom and hydrogen) | 98, plus 1 MIRV of 330 warheads                                              | 20                                        |
| nation attacks received            | 186                                                                          | 133                                       |

Minutes 5-15, search against UE:

| measure                                              | search                               | UE         |
| ---------------------------------------------------- | ------------------------------------ | ---------- |
| regrowth utilization                                 | 0.47 [S-in], 0.39 [S-oos]            | 0.12, 0.10 |
| share of samples at ≥ 95% of the cap                 | 0.28 [S-in], 0.43 [S-oos]            | 0.83, 0.84 |
| net land, median                                     | 15.4k tiles/min [S-in], 3.8k [S-oos] | –          |
| the top nation's net land, median, in the same games | 17.9k, 24.1k                         | –          |

The acts:

- [S-in]: 75 acts in 134 searches: 27 breaks, 44 strikes, 4 lapses.
- [S-oos]: 42 in 130: 15 breaks, 24 strikes, 2 lapses, 1 alliance request.
- Every live checkpoint equalled the chosen rollout: 937 [S-in] and 914
  [S-oos] (recounted from the `PROBE_CHECK` lines; 0 mismatches).
- The search won or led at minute 20 in 5 of the 19 games: World g0, Alps g2
  and Europe g6 led, and Japan g8 and g24 were won. It was second at minute
  20 in 5 more: Bering g3, The Box g9, North America g15, World g16 and
  Mississippi g26.

The 9 in-sample games are land maps where UE did badly: UE's mean peak there
is 13.2%, against 18.5% on the other 23 games. The out-of-sample 10 include
the water maps. **Minute 10, minute 15, peak and progress are robust. Minute
20 is not shown for a fair sample.**

### 1.6 Where the search fails [proven, from the probe logs]

1. **No land neighbour.**
   - 29 of the 130 out-of-sample searches had no bordering nation at all, so
     the candidate set was empty: Four Islands g23 11 of 11, Bering g3 8 of
     17, Yellow Sea g12 5 of 17, Mississippi g26 4 of 17 (after it held 55%),
     Yellow Sea g28 1. In sample it was 2 of 134.
   - On Mississippi g26 apex held 55.6% at minute 13. Everything else lay
     across the river.
2. **A break whose collapse comes after the look.** Alps g18, tick 3,000:
   - The search broke with Veneto. Judged at 1,200 ticks it was +9.6%
     (218,802 tiles against 199,607), and that came true.
   - Within 27 and 267 ticks Piedmont and Bergamo also ended their alliances,
     because we were a traitor (`dip ally- … broken by us`, logged while
     `me.isTraitor()`).
   - From tick 4,234 Piedmont attacked again and again, picking us as
     "weakest" (at ticks 4,234, 4,513, 4,699, 4,854, …). It held T 4.67M and
     a 4.94M cap, against our cap of 4.30M.
   - The live game followed the break rollout to tick 5,400. At +1,800 ticks
     it was 6.5% below UE and at +2,400 69% below. Apex was eliminated at tick
     6,648. UE held 5.4% all game.
3. **A giant with no defensive plan.**
   - **Africa g11.** Yemen, unallied and holding 2.55× our home, appeared in
     the base rollout at +403 ticks. No `ally:Yemen` candidate existed: they
     were generated only from the first 150 ticks.
   - **Mississippi g10.** Tunica was an ally with a 14.0M cap on 777k tiles,
     against our 5.87M on 464k.
     - From tick 7,200, every base rollout showed it attacking right after its
       alliance expired at tick 8,153. At 7,200 that was at +978 ticks, with
       17M troops.
     - No candidate could keep it: no `keep` plan existed. The least bad plan
       was to lapse it and strike, chosen at 7,800. Tunica answered with
       three 4-5M attacks.
     - Tunica won at minute 13.9. UE held 35.9% in its own game.
4. **The leader collapses.**
   - **Onion g20.** Peak 50.9%, and a nation won at minute 15.7.
   - **Mississippi g26.** Apex held 55.6% at minute 13, then sat 6 minutes at
     the cap with no land neighbour while its gold grew from 11M to 37M. It
     took 1 MIRV (330 warheads) and 17 bombs, and was at 40.2% at minute 20;
     Tunica held 53.7%.
   - **[A45].** Apex led with 36.2% at minute 20. At minute 22 two ex-allies
     holding 18M and 20M troops attacked with 34M, and it lost at minute 32.2
     with 13-16M gold idle.
5. **Stall with no good plan.** Middle East g13: 9 searches in a row found
   nothing better than the base.
6. **The policy-iteration gap** (observed once, [S-hb]). A rollout is "the
   plan, then the rules". It cannot see follow-up searches.
   - On Japan g24, the tick-4,200 break with Kanto was +8% at 1,200 ticks and
     −2.4% at 1,800.
   - act3 took it, and the chain of acts that followed won at minute 12.1.
     With the 1,800 look the win came at minute 19.4.

### 1.7 The leader phase [code, proven; data]

**Nations bomb structures, not land.**

- On Impossible, `NationNukeBehavior.maybeSendNuke` sends an atom or hydrogen
  bomb only if the best tile scores above 0 (`NationNukeBehavior.ts:172,
214`).
- The score counts 25k per level of a City, 5k for a DefensePost, 50k for a
  MissileSilo and 15k each for a Port or Factory within the outer radius
  (`:706-731`). A hydrogen bomb also scores SAMs it outranges.
- **A player with no structures is never atom- or hydrogen-bombed by an
  Impossible nation.** With only SAMs, it draws the salvo of
  `maybeDestroyEnemySam`.
- So every bomb the search arm drew had a structure in its blast: apex's own
  cities, or the ones it captured. That was 13 on World g0, 18 on Europe g6
  and 17 on Mississippi g26. Apex itself built only 1-5 cities a game, with
  2-10 upgrades.

**Who bombs**, in order (`findBestNukeTarget`, `:222-316`):

1. the other player, when two are left;
2. whoever attacks the nation: our strikes;
3. the richest nation, one time in two, picks a structure-dense target
   (> 1/75 levels a tile, ≥ 5 levels);
4. a crown holding over 50% of the non-fallout land;
5. an ally's target;
6. the most hated player;
7. the land leader when it is more than 10 points ahead, or, if the nation
   itself leads, the runner-up.

Allies are never bombed (`isFriendly`), except by a MIRV.

**MIRV** (`NationMIRVBehavior`):

- It needs a silo and gold ≥ 25M + 15M × MIRVs launched in the game
  (`Config.ts:627`). A nation hesitates 1 time in 16.
- Targets, in order: the sender of a MIRV in flight; anyone holding ≥ 40% of
  all land tiles (`:86-96`); a city leader with > 8 cities and 1.15× the
  runner-up's.
- It carries 350 warheads.

**Gold.**

- The search arm holds a median 2.2, 3.0 and 9.0M at minutes 10, 15 and 20.
  The 75th percentiles are 5.0, 14.9 and 44.9M, and the maximum 84M. Most of
  it is conquest gold: a killed nation's whole purse.
- UE holds 0.9, 1.2 and 1.6M.
- A City level costs min(1M, 2^n·125k). So 9M buys about 9 levels, +2.25M of
  cap.
- Win check: `tiles·100 > (numLandTiles − fallout)·80`. **Fallout on
  someone else's land raises our share.**

### 1.8 Cost [proven]

- **R**, the search time ÷ the game's own time: 4.16 [S-in] (2.49-4.76 by
  game), 3.13 [S-oos] (0.79-4.30), 2.47 for act2.
- A search blocks its tick for 6-54 s.
- **The fork cost depends on the map, not only its size** (loaded machine),
  in ms per million map tiles:

  | map             | ms per million map tiles |
  | --------------- | ------------------------ |
  | Onion           | 540-1,300                |
  | Alps            | 320-800                  |
  | Europe          | 330-540                  |
  | Japan           | 250-280                  |
  | Giant World Map | 170-330                  |
  | World           | 210-400                  |

  The snapshot is 2.2 bytes a map tile on Alps and 1.0 on World.

- **Arena cost.** UE plays dev@20 at 108 s a game. With the search,
  1 + R ≈ 5.2 makes dev@20 about 9.9 h on one container at 4 jobs; R = 2.5
  brings it to 6.7 h; four shards to 1.7-2.5 h. dev@60 is about 2-3× that.

### 1.9 What this plan drops or corrects [each checked here]

| claim                                                                    | verdict                       | evidence                                                                                                           |
| ------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| search: "proven on 9 games"                                              | in sample, on a biased subset | §1.5: out of sample, minute 20 is +10.8 [−3.5, +28.5], median 0                                                    |
| search: "breaks judged at 1,200 ticks are safe"                          | refuted                       | Alps g18 (§1.6 item 2)                                                                                             |
| search: a fork costs "200-380 ms per million tiles", "~2.2 bytes a tile" | wrong                         | per-map table, §1.8                                                                                                |
| search: flow's "seven" variants were "neutral or worse"                  | wrong                         | nine variants; R1 moved land the right way (+1.8 at minute 15 [−0.2, +4.0], sign test p = 0.02, but 1 of 36 tests) |
| search: the value, V = tiles + troops/300 − incoming/300, is enough      | incomplete                    | no danger, traitor or position terms: §2.5 adds a danger term, off until fitted                                    |
| flow: growth table (806k tiles on World at P = 45)                       | inflated 15-20%               | 11 minutes integrated, not 10; §1.3                                                                                |
| flow: pile-on damage 20/16/11/8%                                         | understated                   | 27/22/15/12% with the territory bonuses                                                                            |
| flow: "keep today's web", strikeFork at 300 ticks                        | superseded                    | the web stays as the rollout policy, but the search decides each alliance's end; horizons count from the last send |
| predator.md                                                              | never written                 | only the prey score and `killsim.py` are used, as ranking priors                                                   |
| [A]'s utilization and share at the cap: 0.37 and 0.45                    | minor                         | recomputed as 0.34 and 0.50                                                                                        |

---

## 2. The design

### 2.0 The midgame policy in one paragraph

The opening is unchanged: rules plus A3 erasure, with M2 met by rules. From
tick 2,400 apex plays UE's rules and, at the events of §2.3, runs a search:

- It forks the live game. Each fork is rolled forward with an exact copy of
  the live policy plus one plan:
  - strike a neighbour with half or all of the strike purse;
  - let an ally lapse and strike it at expiry;
  - keep an ally, with a gold gift if needed;
  - break with an ally;
  - ally a nation the base rollout shows attacking us;
  - land a boat stack on a nation across water.
- Each plan is judged 600 ticks after its last send. It is 1,200 if the
  target holds ≥ 0.9 of our home troops, and 1,200 to 1,800 for a break,
  gated on danger.
- Apex plays the plan whose value beats the rules' by a margin.

Troops at the cap are spent only by plans, with no floors of their own. The
opening web stays as the shield, and the search decides how each alliance
ends. Gold goes to cities under a rule set by the WP8 A/B. Rules decide when
to search, never what to play (the lapse rule gained +2.6 points of peak and
+0.3 at minute 20, 8.2 points below the search).

### 2.0b The design questions, answered

- **Which targets.**
  - Unallied bordering nations, the two best by the rank prior (WP3).
  - Allies at their expiry, by lapse.
  - Allies mid-term, by break, only when the danger-gated look approves.
  - Nations across water, by boat, when no land neighbour exists.
  - Not tribes or free land: the opening allocator already prices those from
    the formulas.
- **How much to send.** ½ or all of `purse.available("strike")`, which is
  home minus A1's deterrence floor: the land lines of the open unallied
  neighbours and of the target's reachable neighbours. Candidates are
  ordered by the stack gate: the stack must be at least the target's troops
  plus its attacks on us, `minimumStack(T, answer, inc, 1)`. Below it the
  price doubles.
- **When to send.**
  - A strike goes now; its top-ups follow A1's timing.
  - A lapse strikes at expiry + 2.
  - A break strikes the tick after the break.
  - Each plan is judged 600 ticks after its last send, 1,200 for strong
    targets, and 1,200 to 1,800 for breaks.
  - Searches run at the events of §2.3.
- **The idle troops.** They get no floor of their own. Stall is a trigger
  (T3). The plans that win recover their price by 1,200 ticks, at −35 to +40
  troops a tile, because the land raises the cap and the stack refills at
  near-peak regrowth. The rollout spends the stack only where the reply does
  not come within the horizon.
- **Alliances.**
  - The opening web stays: it is a proven shield (X, without it, lost 4.5
    points and had 3× the eliminations).
  - At every alliance end (T1), the search compares lapse, keep, keep with a
    gift, and the rules. In stall it compares breaks.
  - The web is what boxes apex in, and the search is how apex leaves the box,
    one ally at a time, on its rollout's say-so.
- **Nations that outgrow us** (cap ≥ 1.1× ours, which no home deters):
  - keep them allied: `keep:Z`, `webKeepStrong`, a gift to Friendly;
  - strike them only in the windows a rollout shows safe;
  - outgrow them per tile, with cities from the idle gold (WP8);
  - make them cost something in the value: the D_cap term, once fitted;
  - never break with them by rule.
- **How to measure it.** §2.10 lists the metrics and §3 the decision rules.

### 2.1 Where it sits, and what it changes in the existing controllers

Order inside `ApexPolicy.run`, live only (a rollout copy never searches):

1. **`SearchController.tick(ctx, view, state)`** runs first, before the
   reflexes, at most one search a tick:
   - It verifies the pending checkpoints.
   - It checks the triggers and runs a search if the budget allows.
   - If it acts, it sets the directive.
2. **Directive steps due this tick are offered** through the same Scheduler,
   Purse and Ledger as every send, so the live game follows the chosen
   rollout.
3. **Foe marks are applied**: `Scheduler.veto` gets `ally:<id>` and
   `ext:<id>`, and the counter-accept skips foes.
4. **Reflexes and decisions are unchanged:** Defense, Diplomacy's recall and
   counter-accept, Strike, Expansion, Naval, Economy, then Diplomacy's upkeep.

How each existing controller and feature interacts with the search:

| controller                 | interaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| StrikeController (A1)      | A directive attack goes out as spend kind `strike`, plan `strike`, `meta.target`, so A1's machinery applies exactly as in the rollout: top-ups before the target's decisions, `strikeLiveCheck`, and the web's `underStrike` exclusion. Its size is `frac × purse.available("strike")` at the send. The strike floor is A1's deterrence floor (`strikeDeterrence`, `strikeDetNearTarget`, `strikeDetNearReach`). A1's own window strikes keep running: they are part of the base. |
| DiplomacyController (web)  | Foe marks veto our requests, extensions and counter-accepts with a nation. `keep:Z` sends its extension and renewal as directive steps, so no Diplomacy change is needed. Recall (an alliance request answering an attack) stays the reflex. UE's web re-allies broken nations: Finland was re-allied twice on Europe, and the search broke it each time. That is why `break` has a foe-mark variant.                                                                             |
| DefenseController          | No change. A nation attack on us starting ("def in") is trigger T4.                                                                                                                                                                                                                                                                                                                                                                                                               |
| ExpansionController        | Its stall mode (home > 0.85 of the cap for 50 ticks, `inStall`) is trigger T3. `nearTribes` moves into ApexState (WP1).                                                                                                                                                                                                                                                                                                                                                           |
| NavalController            | A `boat:N` step uses the ordinary boat intent and class cap (boat 9 a minute). The memos move to stamp keys (WP1). A2's midgame boats stay off: tribes and free land across water had no supply [A2].                                                                                                                                                                                                                                                                             |
| EconomyController          | `doomAt`/`doomBy` move into ApexState (WP1). The WP8 GoldPolicy hook sits in `decide`.                                                                                                                                                                                                                                                                                                                                                                                            |
| A3 erasure and the opening | Untouched. The search starts at `searchFrom` = 2,400.                                                                                                                                                                                                                                                                                                                                                                                                                             |

### 2.2 Exact rollouts (WP1) [proven by 1,851 checkpoints; pinned by a test]

`ApexPolicy.forRolloutWith(spec)` returns a copy of the live policy and runs a
directive. Its state is copied as follows:

- **ApexState**: `structuredClone`, as today.
- **Scheduler**: `copyFrom(live)` carries the per-class send windows (boat 9 a
  minute, tn 30, strike 10, …) and the cancel duplicate guard. A fresh
  Scheduler starts its class caps empty and sends what the live policy is
  capped out of.
- **NationModel**: `cloneFor(game, me, models)` carries the refresh data,
  `troopPath`, decision history, and our attack and alliance sets.
- **ExpansionController.nearTribes** moves into ApexState.
- **The three naval memos** (`voyageMemo`, `nationReachMemo`, `foodMemo`)
  are keyed by `OwnerGrid.stamp`, not object identity. Without this the copy
  launched two boats the live policy judged guarded.
- **`EconomyController.doomAt`/`doomBy` and NukeModel's launch counts** move
  into ApexState, or are carried.
- **BudgetMirror is made exact.** `ctx.budgetState()` exposes the
  IntentBudget windows read-only; today the mirror assumes both windows began
  at the fork. It never bound in the midgame probes, but will in the opening.
- **Latency.** In the arena at latency 1, a fork at the start of a live tick
  has nothing in flight. At latency L, the queued intents replay on their
  turns (`Lookahead.fork`, ForkFidelity).
- **Checkpoints as a standing leak test.** After every search the live state
  is compared with the chosen rollout (tiles, home, outgoing) at +50, +150,
  +300, +600 and the judged horizon. Checks are dropped when a later act
  changes the future. Any mismatch is logged as `search-check MISMATCH` and
  counted in the summary. The target is 0.

### 2.3 Triggers: when to search

A fired search counts under the first trigger it matches, in the table's
order.

| #   | trigger           | rule                                                                                                                                                       | evidence                                                          |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| T1  | alliance end      | a bordering ally Z with `expiresAt − t ≤ 500`, before UE would ask (`extendLead` 300); once per alliance term                                              | lapse and keep plans; 13 of act2's 49 acts                        |
| T2  | chain             | 600 ticks after an act                                                                                                                                     | a new plan found in 16 of 36 [A] and 33 of 55 [S-in]              |
| T3  | stall             | stall onset, then every 1,200 ticks in stall, or sooner when a bordering nation's alliance status changes or its troops change > 25% since the last search | breaks start here                                                 |
| T4  | attack on us      | a nation attack on us starts with troops ≥ 0.1·H, and no search ran in the last 300 ticks                                                                  | 1.9 a game in UE's games                                          |
| T5  | foresight         | the last base rollout showed a nation attacking us within the next 300 ticks                                                                               | Pakistan struck at its lapse on World [A]                         |
| T6  | naval (new)       | no bordering nation with contact ≥ 8, home ≥ 0.8·C for ≥ 600 ticks, and a nation across water within `searchBoatMaxVoyage`; every 1,200 ticks              | 29 of 130 searches had no land candidate                          |
| T7  | floor clock (new) | 1,800 ticks since the last search                                                                                                                          | catches strikes outside stall, which T1-T5 missed (14 of 75 acts) |

Searches are only ever run from tick `searchFrom` = 2,400. They are never
run in the spawn phase, inside a rollout, or for top-ups, tribes, free land
or anything every tick.

**Derived.** Replayed on the closed loops' own searches, T1-T5 fire at 107 of
[S-in]'s 134 searches and cover 86% of the predicted gain, at 22% less cost.

### 2.4 Candidates (K ≤ 8 besides the base)

Up to two bordering nations get candidates. They are chosen by the rank
prior of WP3, with contact ≥ 8 (today: by contact). Nations the base rollout
shows attacking us are added on top.

| candidate                | directive steps                                                                                                                                                                                                                                                            | generated when                                                                                                                                              | evidence                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `base`                   | none                                                                                                                                                                                                                                                                       | always                                                                                                                                                      | –                                                                                                       |
| `strike:N:f`, f ∈ {½, 1} | `attack(N)` now, troops = f × `purse.available("strike")` at the send                                                                                                                                                                                                      | N unallied, `attackable`. Ordered by the stack gate: S ≥ `minimumStack(T_N, answer_N, inc_N, 1)` (= T_N + inc_N) first; gated-out ones only if room is left | 44 of [S-in]'s 75 acts; below the gate, strikes cost 86-108 a tile [flow]                               |
| `lapse:Z`                | `foe(Z, until = expiry + 900)` now; `attack(Z, f = 1)` at expiry + 2                                                                                                                                                                                                       | Z allied, expiring within 500 ticks                                                                                                                         | 13 of act2's 49 acts, 4 of 75 in [S-in]                                                                 |
| `keep:Z` (WP3)           | `allianceExtension(Z)` at expiry − `extendLead`; `allianceRequest(Z)` at expiry + 1 if it lapsed. Variant `keep:Z+gift`: first `donate_gold(Z, g)`, with g = B2's `friendPoints` to Friendly (≥ 50) at the decision, when NationModel's forecast of the extension is < 0.5 | Z allied, expiring within 500, outside UE's keep set; or Z in the base rollout's attackers                                                                  | Tunica (Mississippi g10), Lucerne/Veneto [A45]. Friendly nations extend 67% of the time [B2]. **Guess** |
| `break:Z:f`, f ∈ {½, 1}  | `breakAlliance(Z)` now; `attack(Z, f)` next tick. Variant `+foe` (no re-ally for 900 ticks)                                                                                                                                                                                | Z allied; up to 2 by rank                                                                                                                                   | 27 of [S-in]'s acts, including the Japan win                                                            |
| `ally:N` (round 2b, WP3) | `embargo stop` (as Defense's recall does), then `allianceRequest(N)`                                                                                                                                                                                                       | N attacks us anywhere in the base rollout's horizon, or the base loses > 10% of its tiles                                                                   | Africa g11 needed it at +403. **Guess**                                                                 |
| `boat:N:f` (WP3)         | `boat(dst, troops = f × purse.available("strike"))`, spend kind `strike`; dst = the landing tile on N's shore nearest our coast on the voyage field (`RaceField.voyageRoute`)                                                                                              | trigger T6, or no land candidate                                                                                                                            | Mississippi g26, Four Islands, Bering, Yellow Sea. **Guess**                                            |
| `hold`                   | dropped                                                                                                                                                                                                                                                                    | –                                                                                                                                                           | it never beat the base (0 of 18 probes in the log-only plan runs)                                       |

Later candidates, not in this round:

- **`city:site`.** The value does not price the cap, so cities go by rule
  (§2.8).
- **Our own `hydro:N:tile` and `mirv:N` (M5).** The rollout is exact for our
  own bombs, and the value's share term (§2.5) sees the fallout lower the
  win bar.
- **`assist:N`** (`targetPlayer`, to point Friendly allies at N).

### 2.5 Evaluation

**Round 1.** The base and every candidate roll to H1 = 150 ticks. A candidate
more than 3% below the base's tiles is dropped. In the log-only plan runs this
dropped 9 of 18 losing breaks and none of 14 winners.

**Round 2.** The best two non-break candidates by V at 150, and the base, go
to each candidate's **judged horizon**:

    h = lastSend + 600,  or lastSend + 1,200 if T_target ≥ 0.9·H at the send
    (a strike now: 600; a lapse: expiry + 2 + 600)

**Round 2b (defensive).** If the base, by its longest horizon so far, shows a
nation attacking us or a loss of more than 10% of its tiles, `ally:N`, `keep:N`
and `keep:N+gift` go to the same horizon.

**Round 3 (breaks, stepwise).** The best break and the base go to 600. If the
break leads by the margin, both go to 1,200.

**The danger-gated extension to 1,800 [derived from Alps g18 and Japan g24;
decided by WP2's A/B].** At 1,200, the break's rollout extends to 1,800 if
either holds:

- (a) an alliance of ours other than Z ended early during our traitor window,
  that is, a cascade (in the fork, alliances present at the fork and gone at
  1,200 with `expiresAt > t`);
- (b) the break world has an unallied bordering nation N with
  `maxTroops(N) ≥ 1.1·maxTroops(me)` (undeterrable at our cap) that the base
  world holds allied or does not border.

On Alps g18, (a) fires: Piedmont and Bergamo ended their alliances 27 and 267
ticks after the break. (b) does not: in the base world Piedmont's alliance
also lapsed, at tick 4,197, with its extension refused. On Japan g24's
tick-4,200 break neither fires: no other alliance ended until tick 6,189, and
no bordering nation came near 1.1× our cap (the largest cap, Mount Fuji's,
was 2.55M against our 6.49M). So the gate keeps act3's win at minute 12.1
instead of 19.4.

**Value at horizon h** (`lib/search/Value.ts`):

    V = tiles_h·(L_0 / L_h) + ½·(home_h + out_h)/c̄ − ½·inc_h/c̄
        − λ_now·D_now(h) − λ_cap·D_cap(h)
    V = −∞ if dead;  c̄ = 150;  L = numLandTiles − numTilesWithFallout

- **The share factor L_0/L_h.** It is 1 unless fallout changes. It makes the
  value count the win bar's denominator, for M5's bombs.
- **The danger terms** (`lib/search/Danger.ts`) are expected tiles lost to one
  land attack by each unallied bordering nation N:
  - D_now at the horizon state:

        S_N = min(T_N − r_N·M_N, T_N − ⌈0.9·H⌉), counted if S_N ≥ 0.2·H
        D_now = Σ_N S_N / p_N
        p_N = models.hit({type: Nation, tiles: n_N}, {type: Human,
              tiles: n_us, troops: H, isTraitor: me.isTraitor()}, S_N,
              Plains, border).attackerTroopLoss

    n_N and n_us are the two players' tile counts. `me.isTraitor()` makes
    p half (`traitorDefenseDebuff`). r_N = `nm.params(N).reserve` and
    M_N = `config.maxTroops(N)`.

  - D_cap is the same with T_N = M_N and H = C: both at their caps. This is
    the steady-state exposure to a nation that outgrows us.

- **Defaults λ_now = λ_cap = 0**, until WP4 fits them.
  - At λ = 1 the Alps g18 break would still pass, by 2.6k over the margin:
    D_cap is 17k tiles for Piedmont. One attack's worth understates repeated
    attacks, so only the long look is proven.
  - Both terms are computed and logged in every search from day one, so WP4
    can fit them on the logs.
- **Margin.** Act only if V_best − V_base > max(0.01·tiles, 300).
- **Dip guard.** Drop a plan whose tiles fall more than 20% below the base's
  at any checkpoint.
- **Ties** keep the base.
- **Option `searchRival` (κ, default 0).** Subtract κ·(the top nation's tiles
  at h − the base's). It makes plans that slow the snowballer worth something,
  since a nation won 8 of 32 UE games before minute 20. **Guess**, to
  A/B.

### 2.6 Budget and scheduling (deterministic)

**Unit.** Live-tick equivalents, never milliseconds, so arena runs replay:

    C_search = Σ_runners (φ_map + ticks advanced)

φ_map is a fork's cost in live ticks. It comes from a committed per-map table,
`lib/search/phi.json`, measured once for the 127 maps. The fallback is φ =
300, the high end of the measured 70-400. Map area alone does not predict φ
(§1.8).

**Cap.**

    Σ C ≤ searchR·(t − searchFrom) + 3,000

`searchR` = 2.5 in the arena, and 2.0 once WP5's structural fork lands.

**Degrade in order** when a search would exceed the cap:

1. drop the ½ fractions;
2. drop breaks;
3. keep only lapse, keep and defensive candidates;
4. skip the search (logged).

**Levers, by measured or derived payoff:**

| lever                                                            | payoff                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| event triggers (107 searches where the clock ran 134, on [S-in]) | −22% [derived]                                        |
| the stepwise break round                                         | −9% of [S-in]'s cost, and no choice changed [derived] |
| `forkMany` (snapshot once, restore n times)                      | −8% [derived]                                         |
| structural fork (WP5), φ to 10-20 ticks                          | −16% to −24% [guess]                                  |
| reuse the chosen rollout as the next chained search's base       | saves a fork and up to 600 ticks [guess]              |

**Browser (M7, not this round).** Rollouts are resumable (`Runner.advance`),
so a search can be time-sliced over live ticks. It then forks at t, runs the
rules to t + Δ in every rollout, and applies the plan at t + Δ, as the live
game will. The roadmap's 1 s per 10 s lookahead budget (R ≈ 2) needs WP5.

### 2.7 The base rules (the rollout policy)

Every base-rule change changes every rollout. So base rules are A/B'd
**without** search, at normal cost, and re-screened with search after
adoption. This round's candidates (WP7):

- **7a `webKeepStrong`** [guess]:
  - Ask the extension of every bordering ally Z with `maxTroops(Z) ≥
1.1·maxTroops(me)` or `troops(Z) ≥ H`.
  - Never let two such alliances expire within 600 ticks of each other: ask
    the earlier one sooner.
  - Evidence: in B2's accounting, former allies sent 213M of the 375M troops
    sent at us; 60M of them were never asked. The Tunica and Lucerne/Veneto
    cases (§1.6).
- **7b R1 replica floor** (`strikeFloorReplica`, `strikeFlowFloor` 0.35,
  from `flow-wt5`) [measured, weak]:
  - Each nation's line is the lowest home in [0.35·C, land line] at which
    `nm.canLandAttackUs(N, H, d_N)` is false or `nm.wouldTargetUs(N, H)`
    picks another target; found by bisection in 8 steps.
  - 63 launches against 45, 40 troops a tile, land at minute 15 +1.8
    [−0.2, +4.0].
- **Not changed:** the opening web (X lost 4.5 points), the stack gate
  (`strikeMaxRatio` 1), and the danger reference (D1 and D065 were neutral).

### 2.8 The leader phase

The gold policy (item 1) applies from minute 4. The rest of this section
matters once apex is rank ≤ 2 by land, or holds ≥ 25% of the land: that is
when the crown and runner-up rules aim nations' bombs at it.

1. **Gold to cap (WP8)** [guess; the evidence is idle gold of 9M median, 45M
   at p75, at minute 20, and nations' ~36 levels]. `GoldPolicy` decides when
   idle gold above a reserve buys city levels. Arms:
   - `exposure`: today; almost never builds in the midgame;
   - `model`: B3's NukeModel; build where no firing ladder names us;
   - `allied`: build only when every silo owner holding the atom's price is
     our ally, since allies never atom- or hydrogen-bomb us;
   - `free`: build whenever affordable, with `citySpread` and
     `cityMaxLevel` 3.
2. **Structures and bombs.** The rule of §1.7 is pinned by a test first. The
   bombs cost apex its cities' cap: troops above the new cap are clamped at
   once. Whether to keep captured structures is decided by the A/B, not by
   argument, since each captured City level is also 250k of cap.
3. **MIRV exposure (measure now, act in M5).** Log every MIRV sent at us:
   our share of land at the time, the sender and its gold. Log each tick at
   which some silo owner's gold ≥ the MIRV price while we hold ≥ 35%.
   - The countermeasures are M5's: our own first MIRV raises everyone's next
     price by 15M; kill or drain the richest silo owner first (conquest takes
     its gold); cross 40% → 80% fast. The rollout judges them exactly.
4. **The leader's alliances.** `keep` and `ally:N` candidates (WP3) and
   `webKeepStrong` (WP7a) are the first defence. At minute 22 in [A45], both
   ex-allies were outside UE's keep set.

### 2.9 Options and defaults

The new options live in an options block **"Search"** in
`src/agent/agents/apex/options.ts`. Each work package owns its own sub-block.

| option                                                | default                             | meaning                                                |
| ----------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| `search`                                              | false (true after adoption)         | the SearchController                                   |
| `searchMode`                                          | "act"                               | "plans" is log-only: roll out and log, never act (WP4) |
| `searchFrom`                                          | 2400                                | first tick                                             |
| `searchKinds`                                         | "strike,lapse,keep,break,ally,boat" | candidate kinds                                        |
| `searchK`                                             | 2                                   | nations with strike or break candidates                |
| `searchMinContact`                                    | 8                                   | contact pairs to count as bordering                    |
| `searchFracs`                                         | [0.5, 1]                            | purse shares                                           |
| `searchStackGate`                                     | true                                | order strikes by `minimumStack(…, 1)`                  |
| `searchH1`, `searchPrune`                             | 150, 0.03                           | round 1                                                |
| `searchH`, `searchHStrong`, `searchStrongShare`       | 600, 1200, 0.9                      | judged horizons                                        |
| `searchHBreak`                                        | [600, 1200]                         | stepwise break round                                   |
| `searchHBreakGated`                                   | 1800                                | extension when the gate (a or b) fires; 0 = off        |
| `searchKeepFinalists`                                 | 2                                   | round-2 finalists                                      |
| `searchMargin`, `searchMarginAbs`                     | 0.01, 300                           | acting margin                                          |
| `searchDip`                                           | 0.2                                 | dip guard                                              |
| `searchCbar`, `searchBeta`, `searchAlpha`             | 150, 0.5, 0.5                       | value                                                  |
| `searchDangerNow`, `searchDangerCap`                  | 0, 0                                | λ (WP4 fits)                                           |
| `searchRival`                                         | 0                                   | κ                                                      |
| `searchR`                                             | 2.5                                 | budget ratio                                           |
| `searchLapseLead`                                     | 500                                 | T1 window                                              |
| `searchChain`, `searchStallEvery`, `searchFloorTicks` | 600, 1200, 1800                     | T2, T3, T7                                             |
| `searchAttackMin`                                     | 0.1                                 | T4: attack troops ÷ H                                  |
| `searchBoatMaxVoyage`                                 | 1500                                | T6 and boat candidates                                 |
| `searchBreakFoe`                                      | false                               | foe-mark variant of break                              |
| `searchKeepGift`                                      | true                                | `keep:Z+gift`                                          |
| `webKeepStrong` (WP7a)                                | false                               | base rule                                              |
| `strikeFloorReplica`, `strikeFlowFloor` (WP7b)        | false, 0.35                         | base rule                                              |
| `goldPolicy` (WP8)                                    | "exposure"                          | "model", "allied", "free"                              |
| `goldReserve` (WP8)                                   | 1.5M                                | gold kept back: one SAM's price                        |

### 2.10 Logs, and what the arena records

Log lines:

- **`search <t> <trigger> cands=<n> chosen=<plan> gain=<ΔV> base=<V>
h=<h> te=<tick-equivalents> ms=<ms>`**, one a search.
- **`search-feat <json>`**: the state features for learning when to search.
  They are home/cap, T_N/H, M_N/C, contact, allies and expiries, stall age,
  rank, top share, map category and D_now/D_cap, with the choice and, later,
  the realized outcome.
- **`search-check <t0> +<h> ok|MISMATCH`**.

`Recorder` and `Summary` gain (WP6):

- searches, and acts by kind;
- the predicted gain, summed over acts;
- R;
- checkpoint mismatches;
- utilization over minutes 5-15, and idle share (≥ 95% of the cap);
- strike price, and all-in price over minutes 5-15;
- pile-ons per strike (nation attacks within 300 ticks of a launch);
- bombs and MIRVs received, with our share at each;
- gold at minutes 10, 15 and 20;
- the minute a nation reaches 50% and 80%.

`Compare` reports, with every A/B, the count of identical games and a sign
test [flow].

---

## 3. Work packages

File ownership is disjoint:

- `options.ts` is shared, but each package appends its own named block.
- The only cross-package file is `policy.ts`, and WP1 owns it. It provides
  the directive API and a `LiveSearch` hook interface, which WP2 implements.

### Suites, A sides and decision rules for every package

**Reference runs (A sides)**, all stored and reused (§11.5 of the roadmap):

- UE quick@20: [UE], `arena-results/quick20-int` entrant 3.
- UE dev@20: [UE-dev], `dev20-int` entrant 1, when finished.
- UE dev@60: to run once, about 4 h at 4 jobs.
- WP1's acceptance first checks that HEAD's defaults replay [UE]
  byte-identically. If they do not, [UE] is rerun at HEAD.

**Screening** is on quick@20: 32 pairs. With the search, one entrant takes
2.5-4 h at 2 jobs under load. WP2's three entrants are sharded 4 ways
(`--shard i/4`, then `arena:merge`), about 2 h.

**Adoption** is on dev@20: 254 pairs, sharded 4 ways, with the showcase
gallery.

**M4** is measured on dev@60, sharded 8 ways.

**Reporting.** Every A/B reports:

- Δprogress, and land at minutes 10, 15 and 20, with intervals;
- wins with Wilson intervals;
- eliminations before minute 20, and top 3 at minute 10;
- the identical-game count and sign tests;
- the per-category split (land, water, few-nation);
- R, and checkpoint mismatches.

### WP1: exact rollouts and the directive API (the foundation)

- **Files:**
  - `src/agent/agents/apex/policy.ts`: `forRolloutWith(spec)`,
    `setDirective(steps)`, the directive executor (steps offered after
    `scheduler.begin`, before the reflexes; an attack's size resolved from
    the purse at the send), foe marks into `Scheduler.veto`, and the
    `LiveSearch` hook;
  - `state.ts`: `search: {foes, directive, chainAt, lastSearch}`,
    `economy: {doomAt, doomBy}`, `nearTribes`;
  - `lib/Scheduler.ts`: `copyFrom`, `veto`;
  - `lib/NationModel.ts`: `cloneFor`;
  - `lib/NukeModel.ts`: clone of the counts;
  - `controllers/ExpansionController.ts`: `nearTribes` into state;
  - `controllers/NavalController.ts`: stamp-keyed memos;
  - `controllers/EconomyController.ts`: doom state into ApexState, nothing
    else;
  - `lib/Lookahead.ts` (exact BudgetMirror), `src/agent/Agent.ts`,
    `AgentHost.ts`, `IntentBudget.ts`: a read-only `budgetState()`.
- **Port from:** `/tmp/claude-0/search-wt3`, the `policy.ts`, `Scheduler`,
  `NationModel` and `NavalController` diffs (about 300 lines).
- **Tests:**
  - `tests/agent/RolloutFidelity.test.ts`. The ForkFidelity harness with apex
    defaults, at ticks 2,400 and 4,800 on World and Onion:
    - (1) the copy's intents equal the live intents tick by tick for 100
      ticks;
    - (2) tiles, troops and gold are equal at +300;
    - (3) with a directive strike on the largest unallied neighbour, the
      live game with the directive equals the rollout with it at +50, +150
      and +300.
  - `tests/agent/apex/Directive.test.ts`: a step's timing, its purse sizing,
    a foe veto of `ally:`, `ext:` and the counter-accept, and a refused step
    logged.
  - Unit tests: `Scheduler.copyFrom` carries the class windows;
    `NationModel.cloneFor` forecasts equal the original's; a naval memo hits
    on a cloned grid.
- **Decision (behaviour-preserving, no A/B):**
  - HEAD with `search` off replays [UE]'s 32 games byte-identically:
    `arena:compare` 32 identical, the timelines equal.
  - `--isolate` smoke passes.
  - The port of act3 on the new API (`searchMode` "act", act3's options)
    replays [S-in]'s Japan g8: the same 5 acts and the win at tick 5,471.
- **Effort:** 2-3 days.

### WP2: SearchController core

- **Files, all new:**
  - `controllers/SearchController.ts`;
  - `lib/search/Runner.ts`: a resumable rollout, with snapshots, attackers,
    and alliance-end detection for the break gate;
  - `lib/search/Rounds.ts`: rounds 1-3, judged horizons, the gate, the dip
    guard, the margin;
  - `lib/search/Value.ts`: V; it calls `Danger` when λ > 0;
  - `lib/search/Budget.ts`, `lib/search/phi.json`;
  - `lib/search/Triggers.ts`;
  - `lib/search/Checkpoints.ts`;
  - `lib/search/Registry.ts`, the candidate interface
    `generate(view, state, base) → Candidate[]`;
  - `lib/search/cands/core.ts`: strike, lapse, break, and ally from the
    first 150 ticks, ported from act3;
  - the options block "Search".
- **Tests:**
  - `tests/agent/apex/SearchRounds.test.ts` is pure, on synthetic snapshot
    series. It covers pruning, judged horizons for strike, lapse, strong
    target and break, the gate's (a) and (b), the margin, the dip guard, and
    ties keeping the base.
  - `SearchBudget.test.ts` checks that the degrade order is deterministic.
  - `SearchController.test.ts` plays a small map with a strike that the
    search takes: checkpoints match, and a budget refusal is logged.
- **A/B, quick@20, 32 pairs against [UE]:**

  | entrant | options                                                            |
  | ------- | ------------------------------------------------------------------ |
  | S0      | act3 exactly: clock every 600 ticks, breaks at 1,200               |
  | S1      | events plus budget, breaks 600 → 1,200 stepwise, the gate to 1,800 |
  | S2      | S1 with breaks always at 1,800                                     |

  S0 must reproduce the 19 known games; that is port fidelity.

- **Decision rules:**
  - **To dev@20:** S1 − UE has Δprogress ≥ +0.05, interval excluding 0; out
    before minute 20 ≤ UE + 1 game (≤ 5); top 3 at minute 10 ≥ UE's; land at
    minute 20 point estimate ≥ 0; 0 mismatches; R ≤ 3.
  - **S1 against S0:** the same or better land at minute 20 (sign test not
    against it at p < 0.1), and R at least 20% lower. Otherwise ship S0's
    clock.
  - **S2 against S1:** adopt the 1,800 break look everywhere only if S2 is
    better at minute 20 in the sign test (p < 0.1). §4.2 has the 6-game
    precursor.
  - **Adopt on dev@20:** Δprogress > 0 with the interval excluding 0, out
    before minute 20 not worse by more than 2 points (sign test on
    discordant eliminations), no category with Δprogress < −0.02, smoke and
    `--isolate` green, and the showcase gallery agrees.
- **Effort:** 3-4 days, then about 2 days of wall time for the runs.

### WP3: candidate generators

- **Files, all new, registered in WP2's registry:**
  - `lib/search/cands/keep.ts`: `keep:Z`, `keep:Z+gift`, with B2's
    `friendPoints` and `goldChunk` for the gift;
  - `cands/defend.ts`: round 2b, `ally:N` and `keep:N` from the whole base
    horizon, with `embargo stop` before the request;
  - `cands/boat.ts`: `boat:N:f`. The landing tile comes from the voyage field
    (`RaceField` read-only). It skips routes guarded by warships
    (`routeNearWarship`) and voyages over `searchBoatMaxVoyage`;
  - `cands/rank.ts`: the prior that picks the two nations. It uses A1's
    `strikeYield`, the predator's prey score (`preyScore`: kill cost per
    tile, (n − 99)·(22.2 + 0.187·d)·1.1 + the answer bound + 0.2·T, over n,
    times (1 + τ/150) with τ = n/(0.63·contact)), and a port of `killsim.py`.
- **Tests:**
  - generator unit tests on synthetic states;
  - a scenario test that `keep:Z` sends the extension at expiry − 300 and
    the renewal at expiry + 1;
  - the gift pricing against B2's pinned `friendPoints`;
  - the boat landing-tile choice on the Four Islands test map.
- **A/B,** each generator as an option on WP2's S1:
  - **Stage 1: the named failure games.** Africa g11, Mississippi g10 and
    Alps g18 for defend and keep; Four Islands g7 and g23, Bering g3 and g19,
    Yellow Sea g12 and g28, and Mississippi g26 for boat.
  - **Stage 2: quick@20, paired against S1.**
  - `rank`: Q6. On S1's logs, how often the rank's top two contain the
    rollout's best strike. Adopt if it is ≥ 80% and allows K − 2 at equal
    land.
- **Decision:** adopt a generator if, on the games where it acts, the sign
  test on land at minute 20 favours it (p < 0.1) or eliminations fall, with R
  up by less than 15%. Report the identical-game count.
- **Effort:** 3-4 days.

### WP4: value and horizon study (measurement; starts day 1)

- **Data:**
  - Now: the scratch trees' log-only mode (`probeMode` "plans" in
    `search-wt3`). 30 quick and dev games, 3 probes each (ticks 3,000, 4,800
    and 6,600), every candidate rolled 2,400 ticks. That is about 50k
    rollout ticks a game, about 2 h at 2 jobs.
  - Later: WP2's `searchMode` "plans".
- **Files:** `lib/search/Danger.ts` (D_now, D_cap; see §2.5) with
  `tests/agent/apex/SearchDanger.test.ts`. The tests hand-compute S_N and p_N
  against `models.hit` for three cases: deterred, able to attack, traitor.
- **Output:**
  - The selector regret by decision horizon (150, 600, 1,200, 1,800, 2,400),
    by candidate kind and by target strength.
  - The fitted λ_now and λ_cap: the regret at 2,400 of a selector that
    decides at 600 or 1,200 with the D terms.
  - The policy-iteration gap: for each act in [S-in] and [S-oos], the
    rollout's value at the judged horizon against the realized value of the
    chained game.
- **Decision:**
  - Set λ > 0 if it cuts regret at 2,400 by ≥ 25% against λ = 0 at the same
    horizons, or matches the 1,800 look's regret at 1,200 (a cost cut).
  - Otherwise λ stays 0 and the gate stays.
- **Effort:** 1 day of runs and 1 day of analysis.

### WP5: fork speed (a `src/core` change, tests required)

- **Files:**
  - `src/agent/Fork.ts`: `forkMany(n)`, one snapshot restored n times;
  - `src/core/game/GameImpl.ts`, `PlayerImpl.ts`, `TileSet.ts` and the
    snapshot code: a structural clone that copies the `TileSet` typed arrays
    and the map's state array, and clones the small object graph (players,
    attacks, executions, PRNG states);
  - `tests/agent/ForkFidelity.test.ts`, extended to `forkMany` and the clone;
  - `tests/core/snapshot/*`: clone ≡ snapshot-restore, by hash, after 600
    ticks with nukes and ships in flight.
- **Decision:**
  - φ drops by ≥ 50% on Alps, Giant World Map and Japan.
  - ForkFidelity is green.
  - S1's choices are identical on 4 replayed games (logs equal except
    timing).
  - Then `searchR` defaults to 2.0.
- **Effort:** 4-6 days. It is independent of everything else.

### WP6: arena metrics and statistics

- **Files:** `src/agent/arena/Summary.ts`, `Compare.ts`, `Recorder.ts`, with
  tests in `tests/agent/arena/`.
- **Content:** the metrics of §2.10, the identical-game count, and the sign
  test on discordant pairs for every metric.
- **Decision (tooling):** it reproduces `flowmetrics.py` on quick20-int
  within ±0.01, and `paired19.py`'s tables on [S-in] and [S-oos].
- **Effort:** 2 days.

### WP7: base rules, the rollout policy (no search)

- **7a `webKeepStrong`**: in `DiplomacyController.extensions` and `renew`,
  with the options sub-block "Web keep". Tests are added to
  `DiplomacyMidgame.test.ts`: a strong ally is asked at the lead, and two
  strong expiries are kept 600 apart.
- **7b R1**: `StrikeController.deterrenceFloor`, ported from `flow-wt5`. Tests
  are added to `Strikes.test.ts`: the bisection returns the replica line, and
  it is never below 0.35·C.
- **A/B:** each against [UE-dev] on dev@20. There is no search, so the cost
  is normal: 254 games, about 2 h at 4 jobs. The roadmap's adoption rule
  applies.
- **After adoption:** re-screen WP2's S1 with the new base on quick@20,
  since the rollouts change.
- **Effort:** 1-2 days each.

### WP8: gold and structures (the leader's economy)

- **Files:**
  - `src/agent/lib/GoldPolicy.ts`, new;
  - a hook in `EconomyController.decide` (after WP1's small edit lands);
  - the options sub-block "Gold";
  - `tests/agent/mechanics/NukeStructures.test.ts`, a pin. An Impossible
    nation with a silo and atom gold, aiming at us by the crown rule, sends
    no atom or hydrogen bomb while we own no structure. It sends one once we
    build a City. With only a SAM, it salvos the SAM;
  - `tests/agent/apex/GoldPolicy.test.ts`.
- **A/B, stage 1: on the search arm, no new code.** The scratch act3 tree
  already has `structurePolicy` "free" and `nukeModel` + `nukeCities`. Run
  act3 against act3 + "free" and act3 + "model" on quick@20.
- **Stage 2:** WP2's S1 with `goldPolicy` arms.
- **Measure:** bombs received, city levels lost, cap at minutes 15 and 20,
  land at minute 20, eliminations and wins.
- **Decision:** adopt an arm if land at minute 20 is +1 point or more with the
  sign test not against it, and bombs no more than 1.5× the base arm's.
- **Effort:** 3 days, plus runs.

### WP9: the leader play-out (measurement; starts day 1)

- **Runs:** the scratch act3 with the options of [S-oos] and `--max-minutes
60`, on the minute-20 leaders and near-leaders: World g0 and g16, Alps g2,
  Europe g6, Mississippi g26, Bering g3 and Onion g20. Japan g8 and g24 were
  already won. Later, the same with S1.
- **Measure:**
  - wins, and the minute of each;
  - the minute the lead is lost, and its cause: the ex-allies' attacks, an
    unallied giant, bombs, a MIRV, a snowballer elsewhere;
  - gold idle;
  - the share at every MIRV.
- **Decision:** it sets the next round's priority (§4.3). It needs no code.
  A game takes 30-60 minutes of wall time, so the 7 games take 2-4 h at 2
  jobs.

### WP10 (later: M5 and M7, not scheduled here)

- Our own `hydro` and `mirv` candidates, and the MIRV countermeasures.
- A time-sliced search for the browser.
- A fitted "when to search" classifier from the `search-feat` logs. It
  decides when to search, never what to play.

### Dependencies and order

- **Days 1-3:** WP1, WP5, WP6, and the runs of WP4 and WP9. WP7a and WP7b
  build and start their dev@20 runs.
- **Days 3-7:** WP2 on WP1's API; WP3 against the registry interface; WP8
  stage 1.
- **Days 7-10:**
  - the WP2 screen (S0, S1, S2), then WP3's generators;
  - dev@20 for the adopted combination;
  - WP9 again with S1;
  - dev@60 for M4, sharded 8 ways.

---

## 4. Expected effects, open questions, and what would change the plan

### 4.1 Expected effect on M3 and M4

| metric                    | UE, quick@20 (32) | search on the 19 games (UE on the same games) | this plan, expected on quick@20                                      | milestone bar   |
| ------------------------- | ----------------- | --------------------------------------------- | -------------------------------------------------------------------- | --------------- |
| top 3 at minute 10        | 58.1%             | 74% (58%)                                     | 70-78% [derived: the 19-game lift, shrunk for selection]             | ≥ 70% (M3)      |
| out before minute 20      | 12.5%             | 10.5% (5.3%)                                  | 6-12% [guess: the gate and round 2b target both search eliminations] | < 10% (M3)      |
| progress                  | 0.212             | +0.199 [+0.107, +0.305]                       | +0.10 to +0.15 [derived]                                             | –               |
| land at minute 20         | 8.2%              | +14.8 points (+10.8 out of sample, not shown) | +5 to +12 points [guess]                                             | –               |
| wins at 20 minutes        | 0                 | 2 of 19                                       | 5-12% [guess]                                                        | first wins (M4) |
| wins on dev@60            | not run           | –                                             | 10-25% [guess: set by WP9's conversion rate]                         | ≥ 25% (M4)      |
| utilization, minutes 5-15 | 0.10-0.12         | 0.39-0.47                                     | ≥ 0.45                                                               | ≥ 0.5 [flow]    |
| R                         | 0                 | 3.1-4.2                                       | ≤ 2.5 (≤ 2.0 after WP5)                                              | –               |

How the M4 bar breaks down:

- The first wins come where apex is boxed with few, weak neighbours: Japan
  twice.
- 25% on dev needs about 64 wins in 254 games. Water maps are 20 of 127, and
  boats are unproven there, so that means about 30% of the land-map games.
- The search won or led at minute 20 in 5 of 19 games, and was second in 5
  more (§1.5). Suppose WP9 converts half the leads and a third of the
  seconds: that is about 2 + 1.5 + 1.7 = 5.2 wins in 19 games, 27%, so 25% is
  in reach this round. If it converts under a third of the leads, 25% is not
  in reach, and M4's second half moves behind the leader-phase work.

### 4.2 The break-horizon precursor [S-hb, 6 games, suggestive]

act3 with every break judged at 1,800 ticks instead of 1,200:

| game              | act3 (breaks at 1,200)                       | act3, breaks at 1,800                                                    | UE            |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------ | ------------- |
| Japan g8          | won at minute 9.1                            | won at minute 9.1 (same acts)                                            | 23.1%         |
| Japan g24         | won at minute 12.1                           | won at minute 19.4 (it refused the tick-4,200 break: −2.4% at 1,800)     | lost, 7.3%    |
| Alps g18          | eliminated at minute 11.1                    | peak 11.6%; Novara won at minute 19.9                                    | 5.4%          |
| Mississippi g10   | Tunica won at minute 13.9; 18.3%             | 39.6% at minute 20, peak 41.1%                                           | 35.9%         |
| North America g15 | 16.8% at minute 20                           | 16.8%: the same 12 acts, all 6 breaks passed the 1,800 look              | 5.7%          |
| Europe g6         | 12.5% / 33.1% at minutes 10 / 20, peak 34.4% | 17.8% / 34.7%, peak 35.7% (it refused act3's first break, at tick 2,400) | 15.3% / 15.6% |

Paired with act3 (1,800 look minus 1,200 look), in points:

| measure           | results                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| land at minute 20 | +21.3 (Mississippi g10), +1.6 (Europe g6), 0 in the other four                        |
| peak              | +9.2 (Mississippi g10), +5.1 (Alps g18), +1.3 (Europe g6), about 0 in the other three |
| wins              | 2 and 2; Japan g24's came 7.3 minutes later                                           |
| eliminations      | 0 against 1                                                                           |

What it cost: on the two games whose acts were identical, rollout ticks rose
from 13.8k to 16.2k on Japan g8 (+17%) and from 46.4k to 58.4k on North
America g15 (+26%). On Europe g6 they rose +11%. The scratch code extends
every break finalist straight to the horizon. The stepwise, gated round of
§2.5 extends only breaks that still lead at 1,200 and show a danger signal,
so it costs less.

What it shows:

- The long look removes the break cascade (Alps g18, and Mississippi g10
  through a different path). It kept every break that was sound (Japan g8,
  North America g15). It cost speed where the break set up later acts (Japan
  g24).
- It was better or equal in all 6 games at minute 20; on Japan g24 both arms
  won. Six games cannot separate this from chance.
- Hence the gate (§2.5), which on these cases picks the better column.
- The A/B of WP2 (S1 against S2) decides it. If the gate cannot be built
  cleanly, S2 (always 1,800) is the fallback default, not act3's 1,200.

### 4.3 What would change the plan

- **WP9 converts fewer than 1 in 3 minute-20 leads.** Then growth is not the
  bottleneck for M4. The next round moves to the leader phase:
  - WP8's gold arms;
  - keep and ally as first-class candidates;
  - our own bombs and MIRV denial, pulled forward from M5.
- **WP2's S1 on the fair 32 games gives land at minute 20 ≤ UE**, even with
  progress up. Then the in-sample minute-20 gain was selection, and the
  search mostly buys peaks it cannot hold. Prioritize WP3's defend and keep,
  and WP8, before more offensive candidates.
- **Checkpoint mismatches that WP1 cannot remove.** The search's credit and
  its horizons assume exactness. Until they are fixed, act only on 600-tick
  plans, which are least sensitive to small divergences.
- **R cannot be brought under about 2.5.** Keep only T1 (alliance ends) and
  T3 (stall onset), which cover most breaks and lapses. Fit the `search-feat`
  classifier to skip the searches that never act: 59 of 134 chose the base
  with candidates.
- **WP4 finds λ > 0 matching the long look at 1,200.** Then drop the
  1,800-tick extension. The ungated extension cost +17% to +26% in rollout
  ticks (§4.2).
- **Boat candidates never beat the base on the water maps.** Then drop them.
  Water maps (20 of 127) move to M6, with A2's finding that there is no
  supply there.
- **WP7a (`webKeepStrong`) loses without search** (more extensions, fewer
  targets, as T55 did). Then keep it only as a search candidate (`keep:Z`),
  never as a rule.

### 4.4 Proven, derived, guessed, and the experiment that decides each

| #   | claim                                                                                        | status                                                                                                                  | deciding experiment                                              |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | with the leaks carried, a policy copy replays the live game exactly, before and after acting | proven (1,851 checkpoints)                                                                                              | WP1: `RolloutFidelity.test.ts`, and the checkpoints in every run |
| 2   | the search beats UE on progress, peak land and land at minute 10                             | proven (19 games; intervals exclude 0)                                                                                  | WP2 on quick@20 (32), then dev@20 (254)                          |
| 3   | it beats UE on land at minute 20                                                             | in sample only (+19.2); out of sample +10.8 [−3.5, +28.5], median 0                                                     | WP2's dev@20                                                     |
| 4   | idle troops are free: the winning plans cost −35 to +40 troops a tile by 1,200 ticks         | proven (14 winners of the log-only plan runs)                                                                           | –                                                                |
| 5   | the danger-gated 1,800 look removes break cascades without losing the break wins             | suggestive ([S-hb]: the ungated 1,800 look was better or equal in all 6 games at minute 20; Japan g24's win came later) | WP2: S1 against S2 against S0                                    |
| 6   | defensive candidates from the whole horizon prevent the giant-neighbour losses               | guess (Africa g11, Mississippi g10, [A45])                                                                              | WP3 stage 1 on those games, then quick@20                        |
| 7   | boat candidates find supply when there is no land neighbour                                  | guess (29 of 130 empty searches)                                                                                        | WP3 stage 1 on the water maps, then dev's water category         |
| 8   | a danger term improves selection at shorter horizons                                         | guess                                                                                                                   | WP4 regret study                                                 |
| 9   | the policy-iteration gap costs speed                                                         | observed once (Japan g24)                                                                                               | WP4: rollout value against the chained realized value, per act   |
| 10  | event triggers keep 86% of the gain at 22% less cost                                         | derived (a replay of the closed loops' own searches)                                                                    | WP2: S0 (clock) against S1 (events)                              |
| 11  | a structural fork cuts φ to 10-20 ticks                                                      | guess (the TileSet layout)                                                                                              | WP5 benchmark                                                    |
| 12  | Impossible nations never atom- or hydrogen-bomb a player with no structures                  | proven from code (`NationNukeBehavior.ts:172, 214, 706-731`)                                                            | WP8 pin test                                                     |
| 13  | idle gold turned into cities raises the cap more than the bombs it draws cost                | guess (9M median gold at minute 20; nations' ~36 levels)                                                                | WP8 stages 1-2                                                   |
| 14  | the minute-20 leaders convert to wins at 60 minutes                                          | unknown (the one played-out lead, [A45], lost)                                                                          | WP9                                                              |
| 15  | `webKeepStrong` cuts attacks by ex-allies                                                    | guess (213M of 375M troops came from former allies [B2])                                                                | WP7a on dev@20                                                   |
| 16  | the R1 floor adds land                                                                       | weak (+1.8 [−0.2, +4.0] at minute 15; 1 of 36 tests)                                                                    | WP7b on dev@20                                                   |
| 17  | the MIRV gate at 40% caps the lead                                                           | proven for the mechanism (330 warheads took Mississippi g26 from 55.6% to 40.2%); frequency unknown                     | WP9's MIRV log; M5                                               |
