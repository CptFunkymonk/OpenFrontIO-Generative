# 15 — M4 status: the build, its evidence, and what remains

> The state of the M4 build on 2026-09-27, written at `19d8e60` so that the
> next session can resume without the scratch trees. Chapter 14 is the plan;
> this chapter says which of its work packages are built, what each one
> measured, what is still running, and which decision rules remain. Every
> number carries its source in parentheses (the key is in §0). Paths under
> `/tmp/claude-0/` and `/root/.claude/` are scratch: they do not outlive the
> container, so what matters is also in [`12-ledger.md`](12-ledger.md).

## 0. Sources

Package reports, in the order they finished. "Journal" means the workflow
journal that holds each agent's final report as a `{"type":"result"}` line,
under
`/root/.claude/projects/-home-user-OpenFrontIO-Generative/2beef8cb-aeac-5f5e-9010-da7778a731d3/subagents/workflows/`.

| tag           | file                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [plan]        | [`14-m4-plan.md`](14-m4-plan.md) (the checked-in copy of `/tmp/claude-0/growth/plan.md`; the section numbers are the same)                        |
| [WP1-r2]      | WP1 round 2, journal `wf_42102631-d61`; notes `/tmp/claude-0/pkg-WP1/NOTES.md`                                                                    |
| [WP2-b]       | WP2 build report, journal `wf_42102631-d61`                                                                                                       |
| [WP2-r2]      | WP2 round 2, journal `wf_42102631-d61`; runs `/tmp/claude-0/pkg-WP2/r2/`                                                                          |
| [WP3-n]       | `/tmp/claude-0/pkg-WP3/NOTES.md` (in progress)                                                                                                    |
| [WP4]         | `/tmp/claude-0/pkg-WP4/FINAL.md`                                                                                                                  |
| [WP5-r2]      | WP5 round 2, journal `wf_483f1995-7fe`                                                                                                            |
| [WP6-r2]      | WP6 round 2, journal `wf_483f1995-7fe`                                                                                                            |
| [WP7a-b]      | WP7a build report, journal `wf_4c5b4051-5e7`; notes `/tmp/claude-0/pkg-WP7a/NOTES.md`                                                             |
| [WP7a-rev]    | WP7a review, journal `wf_4c5b4051-5e7`; scratch `/tmp/claude-0/review-WP7a/`                                                                      |
| [WP7b-b]      | `/tmp/claude-0/pkg-WP7b/BUILD.md`                                                                                                                 |
| [WP7b-rev]    | `/tmp/claude-0/pkg-WP7b-REVIEW.md`                                                                                                                |
| [WP7b-n]      | `/tmp/claude-0/pkg-WP7b/NOTES.md` (round 2); compares `/tmp/claude-0/pkg-WP7b/cmp-r2-screen/out.txt`, `cmp-r3-screen/out.txt`                     |
| [WP8-1]       | `/tmp/claude-0/pkg-WP8/FINAL.md` (round 1)                                                                                                        |
| [WP8-2]       | `/tmp/claude-0/pkg-WP2/FINAL.md` (the WP8 round-2 report; it sits in the WP2 folder)                                                              |
| [WP9]         | `/tmp/claude-0/pkg-WP9/FINAL.md`; tables `/tmp/claude-0/pkg-WP9/ana/table9.txt`, `numbers9.json`; runs `/tmp/claude-0/pkg-WP9/runs/g*/`           |
| [WP10-pin]    | `/tmp/claude-0/pkg-WP10-pin-FINAL.md`                                                                                                             |
| [WP10b-b]     | WP10b report, journal `wf_59caff15-430`; notes `/tmp/claude-0/pkg-WP10b/NOTES.md`; runs `/tmp/claude-0/pkg-WP10b/runs/`                           |
| [WP10b-rev]   | WP10b review, journal `wf_59caff15-430`; scratch `/tmp/claude-0/review-WP10b/`                                                                    |
| [WP10n-rev]   | WP10n review, journal `wf_59caff15-430`; scratch `/tmp/claude-0/review-WP10n/`                                                                    |
| [WP10n-r2]    | WP10n round 2, journal `wf_59caff15-430`; notes `/tmp/claude-0/pkg-WP10n/NOTES.md`; runs `/tmp/claude-0/pkg-WP10n/runs2/` (`status.txt`, `*.log`) |
| [S1p]         | `/tmp/claude-0/m4-screen/s1-84ae424-partial14.txt` (the old S1 on 14 games against [UE]; `peek.py` beside it makes the table)                     |
| [screen-calc] | `<scratchpad>/status/partial.py`, this chapter's script over the game JSON files of `/tmp/claude-0/m4-screen/s1-84ae424` and `s0-84ae424`         |
| [ledger]      | [`12-ledger.md`](12-ledger.md)                                                                                                                    |
| [git]         | `git log --oneline` and `git status` at `19d8e60`                                                                                                 |
| [ps]          | the process list and `uptime` at 20:35 UTC on 2026-09-27                                                                                          |

[UE] is `arena-results/quick20-int` entrant 3 (the `4f1913c` defaults on the
32 `quick@20` games), [UE-dev] is `arena-results/dev20-int` entrant 1, as in
chapter 14. act3's own runs are [S-in] (`/tmp/claude-0/search/act3-g*`) and
[S-oos] (the session scratchpad's `oos/g*`).

## 1. What M4 is, and the bar

Roadmap §11.6 defines M4 as "Conquest and economy" (H5, H7) with the exit
criterion **first wins; ≥ 25% wins on `dev`**, measured on `dev@60` (plan §3,
"M4 is measured on dev@60, sharded 8 ways"). M3, still open, wants
**eliminated before minute 20 in < 10% of `dev` games and top-3 land at
minute 10 in ≥ 70%**; the last `dev@20` run has 40.7% and 22.0% ([ledger],
the `4f1913c` row). M5 later wants ≥ 60% on `dev`.

The build follows chapter 14: fork the live game, roll candidate plans
forward with an exact copy of the live policy, play the best (the "search"),
plus the base rules for the leader phase. Chapter 14 §3 splits it into WP1
to WP9; WP10 (our own bombs, MIRV denial, the leader guard) was pulled
forward from M5 when WP9 showed that growth is not the bottleneck (§3.3
below). Ten packages were built by parallel agents between 2026-09-27 05:00
and 14:00 UTC, each reviewed by a second agent and fixed in a round 2. Every
package is behind an option that defaults to **off**, so the defaults still
play [UE]: WP1 replays all 32 [UE] games byte-identically ([WP1-r2]), and
each later package repeated the off-replay on its own games.

## 2. The work packages

All options live in `src/agent/agents/apex/options.ts`, one named block per
package; defaults quoted from that file at `19d8e60`. Test counts are the
reports' own. "Entrant" is the exact `--agent` value the evidence was
measured with.

| WP                                       | Status                                                                                                                                                       | Files (main tree)                                                                                                                                                                                    | Options (default)                                                                                                                                                                                                                                                                                                                          | Tests                                                                                                                                                                                            | Decisive evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Entrant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WP1** exact rollouts, directive API    | done; reviewed (5 findings), round 2 fixed; the review's F1 patch landed as `62ebe07` ([git])                                                                | `apex/policy.ts`, `apex/state.ts`, `lib/Scheduler.ts`, `lib/Lookahead.ts`, `src/agent/IntentBudget.ts`, `src/agent/AgentHost.ts`; block "Package WP1, the hook"                                      | none besides the `LiveSearch` hook (`ApexPolicy.forRolloutWith`, `setDirective`)                                                                                                                                                                                                                                                           | `tests/agent/apex/Directive.test.ts` (15), `RolloutCopy.test.ts`, `tests/agent/RolloutFidelity.test.ts` (3)                                                                                      | HEAD with search off replays [UE] 32 of 32 identical, logs byte for byte; the act3 port on the new API equals the prototype on Japan g8 (6/6 choices, 28/28 rollouts, 38/38 checks, win at tick 5,471) and The Box g9 (17/17, 84/84, 115/115) ([WP1-r2])                                                                                                                                                                                                                                                                            | `apex` (must equal [UE])                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **WP2** SearchController core            | done; reviewed (12 findings), round 2 fixed, last change in `833721c` ([WP2-r2]); the full screen is running (§4)                                            | `apex/controllers/SearchController.ts`; `lib/search/{Runner,Rounds,Value,Budget,Triggers,Checkpoints,Registry}.ts`, `cands/core.ts`, `phi.json`; block "Search: package WP2"                         | `search` false; `searchR` 2.5, `searchSlack` 4500, `searchReserve` 2500, `searchHStrong` 1200, `searchStackGate` true, `searchHBreak` [600, 1200], `searchHBreakGated` 1800; act3's quirks behind `searchClock`, `searchLapseLead`, `searchLapseFoeAt`, `searchShare`, `searchOutBoats`, `searchOnTop`, `searchCheckAll`, `searchGateVeto` | `tests/agent/apex/SearchBudget` (7), `SearchRounds` (12), `SearchTriggers` (13 + WP10n's 5), `SearchCandidates` (6), `SearchController` (3), `SearchRunner` (3): 74 pass at `6841de8` ([WP2-r2]) | Old S1 on 14 games against [UE]: land at minute 20 +6.4 points, 8 better / 4 tied / 2 worse (one of the two is Japan g8, a win scored 0 at minute 20), 0 mismatches ([S1p]). Fixed S1 on 6 games: better than [UE] on 6/6/5 of 6 at minutes 10/15/20, never worse; but behind S0 at minute 20 on 4 of 6; cost 1.96–2.22 tick-equivalents per tick against S0's 2.63–4.17; S0 equals act3 exactly on g8 and g2 ([WP2-r2])                                                                                                            | S1 `apex:{"search":true}`; S0 `apex:{"search":true,"searchClock":600,"searchR":0,"searchHBreak":[1200],"searchHBreakGated":0,"searchHStrong":600,"searchStackGate":false,"searchOnTop":false,"searchLapseLead":498,"searchLapseFoeAt":1,"searchShare":false,"searchOutBoats":false,"searchCheckAll":true}`; S2 `apex:{"search":true,"searchHBreak":[600,1200,1800],"searchHBreakGated":0}`; S1-R3 `apex:{"search":true,"searchR":3}`; S1-long `apex:{"search":true,"searchH":1800,"searchHStrong":1800,"searchHBreak":[1800],"searchHBreakGated":0,"searchR":4,"searchSlack":10000,"searchReserve":5000}` ([WP2-r2]) |
| **WP3** candidate generators             | **in progress**: the four generators and the options block exist; tests and stage 1 are being built; S1 baselines and a boat run are playing ([WP3-n], [ps]) | `lib/search/cands/{keep,defend,boat,rank}.ts`; `tests/agent/apex/SearchKeep.test.ts`, `SearchWorld.ts` (staged, uncommitted, [git]); block "Package WP3"                                             | `searchKeep` false, `searchKeepMinShare` 0.9, `searchKeepGift` true, `searchKeepGiftP` 0.5, `searchKeepGiftShare` 0.9, `searchDefend` false, `searchBoat` false, `searchBoatMaxVoyage` 1500, `searchRank` "contact"                                                                                                                        | in progress                                                                                                                                                                                      | none yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | planned, each on S1: `apex:{"search":true,"searchKeep":true}`, `…"searchDefend":true`, `…"searchBoat":true`, `…"searchRank":"prey"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **WP4** value and horizon study          | done: λ_now and λ_cap stay 0 ([WP4])                                                                                                                         | `lib/search/Danger.ts`; `tests/agent/apex/SearchDanger.test.ts`                                                                                                                                      | `searchDangerNow` 0, `searchDangerCap` 0                                                                                                                                                                                                                                                                                                   | `SearchDanger.test.ts` (10)                                                                                                                                                                      | 30 games, 498 plans rolled 2,400 ticks: the fitted λ cuts regret by 5.1% in sample and −10.9% leave-one-game-out (bar 25%); D_cap predicts later losses with R² 0.16–0.20; judging every plan 1,800 ticks after its last send cuts regret from 1.19 (S1's rounds) to 0.34 at 2.5× the rollout cost ([WP4])                                                                                                                                                                                                                          | none (log-only mode in `/tmp/claude-0/wp4-wt`); its finding became WP2's S1-long                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **WP5** fork speed                       | done; reviewed (8 findings), round 2 fixed; `ctx.fork()` wired to the clone in `84ae424` ([git])                                                             | `src/agent/Fork.ts`, `src/core/snapshot/GameClone.ts` (+ `GameSnapshot.ts`, `SnapshotContext.ts`, `GameImpl.ts`, `GameMap.ts`, `PlayerImpl.ts`, `TileSet.ts`, `WaterManager.ts`, pathfinding graphs) | none in apex (AgentHost `forkMode`, "clone")                                                                                                                                                                                                                                                                                               | `tests/core/snapshot/GameClone.test.ts` (24), `tests/agent/ForkFidelity.test.ts` (14)                                                                                                            | fork cost φ down 79–95% on 12 map/tick pairs (clone ÷ restore 0.06–0.19 interleaved); act3 replays identical on Japan g8, Onion g20, Alps g2, Africa g11; with water nukes the clone follows the live game where a restore diverges ([WP5-r2])                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **WP6** arena metrics                    | done; reviewed (8 findings), round 2 fixed ([WP6-r2])                                                                                                        | `src/agent/arena/{Recorder,Summary,Compare}.ts`                                                                                                                                                      | — (`arena:compare --drop-errors` restores the old pairing rule)                                                                                                                                                                                                                                                                            | `tests/agent/ArenaMetrics` (31), `Compare` (19), `Recorder` (21), `Summary` (12)                                                                                                                 | reproduces `flowmetrics.py` on quick20-int and `paired19.py` on the 19 act3 games; the 0.1-point tie rule moved the `4f1913c` dev row from 196/49/9 to 191/45/18 ([WP6-r2], [ledger])                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **WP7a** `webKeepStrong`                 | built and reviewed (2 major, 3 minor); **held**; round 2 (v8: betrayal guard, gift rule, renew at recall's p) in progress ([WP7a-rev], [WP7a-n])             | `apex/controllers/DiplomacyController.ts` (modified, uncommitted round-2 work, [git]); block "Package WP7a WEB KEEP"                                                                                 | `webKeepStrong` false; `webKeepAsk` true, `webKeepCapRatio` 1.1, `webKeepTroopRatio` 1, `webKeepGap` 600, `webKeepRenew` true, `webKeepRenewMinP` 0.25, `webKeepRenewThreat` true, `webKeepGift` false, `webKeepGiftLead` 120, `webKeepGiftShare` 0.9, `webKeepGiftMinP` 0.5                                                               | `tests/agent/apex/WebKeep.test.ts` (19)                                                                                                                                                          | the plan's rule (v5) on `quick@20` 0:16: Δprogress −0.004 [−0.017, +0.005], land at minute 20 −0.8, out before 20 2 → 5. v7 on 32 (composite): Δprogress −0.0055 [−0.020, +0.004], land at minute 20 +0.9 [−0.03, +1.95], 14/6/12 ([WP7a-b]). Review: g21 and g30 supply 13.1 of the 29.1 summed points and vanish by minute 25–30; without them +0.53 [−0.28, +1.47]; top 3 at minute 10 18 → 16 ([WP7a-rev])                                                                                                                      | v7 `apex:{"webKeepStrong":true,"webKeepAsk":false,"webKeepGift":true,"webKeepRenewThreat":false}`; v5 `apex:{"webKeepStrong":true}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **WP7b** R1 replica strike floor         | built and reviewed (F1–F3 major, F4–F5 minor); **held**; round 2 done: the guarded variant is identical to [UE] on 20 of 20 games ([WP7b-rev], [WP7b-n])     | `apex/controllers/StrikeController.ts`; block "Package WP7b R1 FLOOR"                                                                                                                                | `strikeFloorReplica` false, `strikeFlowFloor` 0.35, `strikeFloorReplicaUnseen` false, `strikeFlowFloorMin` false, `strikeFloorReplicaSteady` false, `strikeFloorReplicaFirm` false, `strikeFloorReplicaBoats` false, `strikeFloorReplicaRegrow` false                                                                                      | `tests/agent/apex/StrikeReplicaFloor.test.ts` (15 after round 2), `Strikes.test.ts` (+1) ([WP7b-n])                                                                                              | R1 + Steady on 0:16: Δprogress +0.041 [+0.001, +0.098], 4/0/12, land at minute 20 +4.0 ([WP7b-b]); the review found 4 of 9 third-party-dependent lowerings followed by that nation's attack within 34–139 ticks, and The Box g9's gain to be alliance luck (without it +0.021, 3/0) ([WP7b-rev]). Round 2: Firm + Boats +0.010 [+0.000, +0.031], 1/0/15, 14 of 16 identical, g9 lost earlier (tick 8758 against 8896); adding Regrow: 16 of 16 identical, 4 of 4 named games identical ([WP7b-n], `cmp-r2-screen`, `cmp-r3-screen`) | round 1 `apex:{"strikeFloorReplica":true,"strikeFloorReplicaSteady":true}`; FB `apex:{"strikeFloorReplica":true,"strikeFloorReplicaFirm":true,"strikeFloorReplicaBoats":true}`; FBR = FB + `"strikeFloorReplicaRegrow":true`                                                                                                                                                                                                                                                                                                                                                                                         |
| **WP8** gold and structures              | built and reviewed (8 findings), round 2 fixed; **not adopted** ([WP8-2])                                                                                    | `lib/GoldPolicy.ts`, `apex/controllers/EconomyController.ts` (gate hook); block "Package WP8 GOLD"                                                                                                   | `goldPolicy` "exposure" (off), `goldFrom` 2400, `goldReserve` 1,500,000, `goldGuard` true, `goldHydroCap` 0                                                                                                                                                                                                                                | `tests/agent/apex/GoldPolicy.test.ts` (25), `tests/agent/mechanics/NukeStructures.test.ts` (13)                                                                                                  | `quick@20`, 32 games, no search: "model" land at minute 20 +2.02 [+0.10, +5.33], 7/3; "free" +1.74 [−0.31, +5.13], 6/4; Yellow Sea g28 alone is +48, without it +0.53 and +0.25; Δprogress +0.001 [−0.025, +0.035], 3/5; few-nation maps −0.063; City levels lost to bombs 43 → 56 ("model") and 60 ("free") ([WP8-2]). "allied" acted in 1 of 16 games ([WP8-1])                                                                                                                                                                   | `apex:{"goldPolicy":"model"}`, `apex:{"goldPolicy":"free"}`, `apex:{"goldPolicy":"allied"}` (block defaults otherwise)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **WP9** the leader play-out              | done, measurement only, no code in the tree ([WP9])                                                                                                          | scratch: `/tmp/claude-0/wp9-wt` (= `2e6293f` + `docs/prototypes/act3-search.patch`), observer patch `/tmp/claude-0/pkg-WP9/wp9-observer.patch`                                                       | —                                                                                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                | 1 win in 9 sixty-minute games (Alps g2 at minute 33.0); every loss came through a current or recent ally: MIRVs (g26 at 19.5, g0 at 22.3 in a replay, g6 inferred), an ally's bombs when two players were left (g20), bomb collateral breaking the alliance (g16), an ex-ally giant after expiry (g15, g3); gold idle 84–325M at the collapses ([WP9])                                                                                                                                                                              | act3 with the [S-oos] options, `--max-minutes 60`, one `--range g:g+1` job per game                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **WP10-PIN** leader-phase mechanics      | done: 60 tests pass; chapter 13 §2.13–2.18, §5.12 ([WP10-pin])                                                                                               | `tests/agent/mechanics/{LeaderWorld.ts,OwnNukes,MirvEffect,SiloStrike,NationMirvTargeting,Betrayal,ConquestSpoils}.test.ts`; [`13-mechanics.md`](13-mechanics.md)                                    | —                                                                                                                                                                                                                                                                                                                                          | 24 + 11 + 7 + 6 + 6 + 6 = 60                                                                                                                                                                     | a bomb exists at t+2 or never; MIRV price 25M + 15M × MIRVs launched by anyone; a nation MIRVs us with probability 15/16 at ≥ 40% land or > 8 City levels and ≥ 1.15× the runner-up, alliance or not; betrayal is safe below 0.33 × its troops; a MIRVed target keeps 65–75% of its land at about 3% of its cap ([WP10-pin])                                                                                                                                                                                                        | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **WP10b** leader guard (base rules)      | built and reviewed (2 major, 5 minor); round 2 (F1: protect the break's own strike) in progress ([WP10b-rev], [WP10b-b] notes 13:40)                         | `lib/LeaderGuard.ts`, `apex/LeaderHook.ts`, hooks in `apex/HomeTarget.ts`, `policy.ts`, `EconomyController.ts`, `lib/NationModel.ts`; block "Package WP10b LEADER GUARD"                             | `leaderGuard` false; `leaderMargin` 1.05, `leaderAllyOut` 0.5, `leaderOurOut` 0, `leaderMaxShare` 0.8, `leaderGates` true, `leaderCap` true, `leaderCapFree` false, `leaderGoldWindow` 600                                                                                                                                                 | `tests/agent/apex/LeaderGuard` (14, 20 in round 2), `LeaderBetrayal` (3, 5 in round 2), `LeaderFidelity` (1)                                                                                     | off: 2 of 2 games byte-identical to [UE]; on, `quick@20` 0:8: 7 identical, 1 better (Bering Strait, which the review reads as chaos, not the mechanism); World g16 with S1: the guard cut the betrayals after our own break from 5 to 2 but the game ended earlier (eliminated at 28.5 min against 32.4); no WP9 failure mode occurs in its data ([WP10b-b], [WP10b-rev])                                                                                                                                                           | `apex:{"leaderGuard":true}`; with search `apex:{"search":true,"leaderGuard":true}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **WP10n** nuke candidates for the search | built and reviewed (7 major, 3 minor); round 2 fixed (`821226b`, `6841de8`); one clean stage-1 win; the g6 pair must be rerun (§4) ([WP10n-r2])              | `lib/search/cands/nuke.ts`, `nukeWatch.ts`; small gated edits in `Registry.ts`, `Triggers.ts`, `SearchController.ts`; block "Package WP10n NUKES"                                                    | `searchNukes` false; `searchNukeMirv`, `searchNukeDeny`, `searchNukeMirvDeny`, `searchNukeSilo` true, `searchNukeK` 2, `searchNukeLead` 600, `searchNukeLandShare` 0.35, `searchNukeCityLead` 1, `searchNukeCapRatio` 1.1, `searchNukeMaxBombs` 8, `searchNukeSiloReady` 110, `searchNukeStrikeGap` 20, `searchNukeWindow` 600             | `tests/agent/apex/SearchNukes` (17), `SearchTriggers` (18, 5 for T8), `LeaderRollout` (1)                                                                                                        | Mississippi g26, both arms from one tree, 60 minutes: S1 lost (Tunica won at 29.2 min, apex second at 19.3%, peak 57.9%); S1 + nukes won 80.1% at 28.2 min after T8 fired at 15.0 min (`mirv:otbqjjqa` with its follow-up conquest) and a second MIRV at 20.3; 0 mismatches; R 2.31 against 2.34. World g0: both lost, eliminated at 24.5 → 38.0 min ([WP10n-r2], `runs2/*/summary.md`)                                                                                                                                             | `apex:{"search":true,"searchNukes":true}` against `apex:{"search":true}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Off-replays done by the packages themselves: WP1 32 of 32 ([WP1-r2]); WP8
16 of 16 ([WP8-1]); WP7a 4 of 4 ([WP7a-b]) and g21, g30 by the reviewer
([WP7a-rev]); WP7b 4 of 4, twice ([WP7b-b], [WP7b-n]); WP10b 2 of 2
([WP10b-b]); WP10n's every path is gated on `searchNukes` ([WP10n-r2]).
`--isolate --strict` smoke runs passed for S1 ([WP2-r2]), the WP8 arms
([WP8-2]), WP7b ([WP7b-b]), WP10b ([WP10b-b]) and WP10n ([WP10n-r2]).

## 3. What the evidence says so far

### 3.1 M3 is still unmet

The only `dev@20` measurement is the `4f1913c` one: top 3 at minute 10 in
40.7%, out before minute 20 in 22.0% ([ledger]). No `dev@20` run with any M4
option on exists. On the partial 14-game screen the old S1 was in the top 3
at minute 10 in 9 of 13 ranked games against [UE]'s 7, and lost before
minute 20 in 4 games against [UE]'s 5 ([S1p], [screen-calc]); that is a
`quick` sample, not the `dev` bar.

### 3.2 The search beats UE on every game measured, and trails act3's S0 on some

- **Old S1 (WP2 round 1) at `84ae424`, 14 games against [UE]:** land at
  minute 20 +6.4 points, 8 better / 4 tied / 2 worse; Δprogress +0.118,
  11 / 3 / 0; one win (Japan g8 at minute 15.2); progress 0.363 against
  0.245, peak land 29.1% against 19.6%, eliminated before minute 20 1 against
  2; 0 mismatches in 1,101 checkpoints ([S1p], [screen-calc]). The two worse games are Mississippi g10 (a nation won before minute 20; UE held 35.9%) and Japan g8, which the table scores as 0 at minute 20 because apex had already won, so the +6.4 understates the gap ([S1p], [screen-calc]).
- **Fixed S1 (WP2 round 2), 6 games:** land at minutes 10/15/20 ([WP2-r2]):

  | game       | UE             | S0 (= act3)    | S1                       |
  | ---------- | -------------- | -------------- | ------------------------ |
  | g0 World   | 8.9/0.3/0.3    | 13.5/21.8/32.6 | 11.2/18.4/18.9           |
  | g2 Alps    | 6.0/10.5/9.8   | 11.4/22.7/33.7 | 10.2/25.2/45.9           |
  | g6 Europe  | 15.3/15.3/15.6 | 12.5/25.4/33.1 | 19.6/30.3/29.1           |
  | g8 Japan   | 23.6/26.2/23.1 | win at 5471    | win at 9161              |
  | g9 The Box | 12.6/0/0       | 12.9/17.5/16.7 | 16.2/5.5/0 (out at 9331) |
  | g18 Alps   | 5.4/5.4/5.5    | out at 6648    | 9.4/11.0/13.3            |

  Means at minute 20: UE 9.0, S0 32.9, S1 31.3. S1 against S0 at minute 20:
  2 better, 4 worse (Japan counts as worse, both win). S1 spends 1.96–2.22
  tick-equivalents per tick (cap 2.5); S0 2.63 on g8 and 4.17 on g2. The
  budget is the suspected cause: 26 of 45 alliance-end triggers were refused
  and the gated 1,800 look was never affordable ([WP2-r2]).

- **S0 at `84ae424` on the 13 `quick` games act3 never played** (games 1, 4,
  5, 7, 14, 17, 21, 22, 25, 27, 29, 30, 31), against [UE]: Δprogress +0.034,
  9 better / 2 tied / 2 worse; land at minute 20 +5.7 points, 8 / 3 / 2;
  0 wins; eliminated before minute 20 2 against 3; worse on Europe g22 (7.4%
  against 10.4%) and The Box g25 (out, peak 8.6% against 14.0%)
  ([screen-calc] over `/tmp/claude-0/m4-screen/s0-84ae424/g*/games/*.json`).
  With act3's own 19 games ([S-in], [S-oos]) this completes S0 on all 32.

- **The horizon:** WP4's regret table says the long look works better than
  any danger term (0.34 against 1.19 for S1's rounds, at 2.5× the cost)
  ([WP4]); WP2's S1-long won Japan at tick 7261 and reached 32.7% on Europe
  at minute 20, at 3.5–3.7 tick-equivalents per tick with 5 of 11 and 22 of
  33 searches refused ([WP2-r2]). The S1 / S1-R3 / S1-long screen decides
  it (§4).

### 3.3 The leader phase

- **WP9:** of the 3 games act3 led at minute 20 it won 1 (Alps g2); of the
  5 where it was second it won 0; Onion g20 was lost before minute 20. Over
  all 19 act3 games, 3 wins (16%, interval 5.5–38%) against the 27% that plan
  §4.1 needed for the 25% bar ([WP9]). Every loss came through an ally or a
  just-expired one, by rules that ignore alliances: Tunica's MIRV at us at
  minute 19.5 with our share at 55.6% (g26), Antarctica's MIRV at 22.3 by the
  city-leader rule with 52 levels against its 29 (g0, base-line replay),
  Portugal's inferred MIRV (g6), Leafer's hydrogen bomb when two players were
  left (g20), Spain's bomb collateral breaking the alliance (g16), and
  ex-ally giants after expiry (g3, g15, g9) ([WP9], `table9.txt`). Gold sat
  idle: 84M at minute 20 on World g0, 264M at most on Europe g6, 325M on
  World g16, enough for 2, 3 and 5 MIRVs when each collapse began ([WP9]).
- **Plan §4.3 was triggered** ("WP9 converts fewer than 1 in 3 minute-20
  leads"): the next round moved to the leader phase, in WP9's order: MIRV
  denial and our own bombs first (WP10n), idle gold into cap under the MIRV
  lines (WP8), boats for water standoffs (WP3), keep and ally plans last
  (WP3) ([WP9], [plan] §4.3).
- **WP10n flipped the one decisive game.** In a clean single-tree A/B at
  60 minutes, Mississippi g26 went from a loss (nation won at 29.2 min, apex
  second at 19.3%) to a win (80.1% at 28.2 min) with `searchNukes`; World
  g0 stayed a loss with apex surviving 24.5 → 38.0 min; Europe g6's S1 arm
  lost (nation won at 36.4 min, peak 34.2%) and the nuke arm crashed (worker
  SIGKILL under load 17) ([WP10n-r2], `runs2/status.txt`, `n2-g6.log`). One
  seed decides nothing on its own; the reviewer's round-1 verdict, "two games
  of four decide nothing", stands until the screen ([WP10n-rev]).
- **The same games with S1 instead of act3** (plan WP9's "later, the same
  with S1") exist as WP10n's baselines: g26 lost at 29.2 min, g0 eliminated
  at 24.5, g6 lost at 36.4: 0 wins in 3 ([WP10n-r2] `runs2/s1b-g*`).
- **WP10b's guard** is exactly off when off, inert while its lines are 0
  (every line on World g16 without search), and in the one binding stretch
  (the 300-tick traitor window after our own break) it blocked two top-ups
  and kept 6 allies against 3, yet that game ended earlier; the killer in
  every g16 run was an ally attacking after its alliance expired, which the
  guard does not model ([WP10b-rev]).

### 3.4 WP8 not adopted, WP7 held

- WP8's arms pass the plan's rule on paper (+2.02 and +1.74 points at minute
  20, sign tests not against, bombs 1.17× and 1.13×) but one game carries
  the gain, progress does not move, few-nation maps lose 0.063, and the arms
  lose 30–40% more City levels to bombs; the arms were also measured without
  search, which is neither of the plan's stages ([WP8-2]).
- WP7a's rule as written lost; its best variant's minute-20 gain comes mostly
  from giant allies attacking after the 20-minute cap ([WP7a-rev]). Plan
  §4.3's clause "WP7a loses without search → keep it only as a search
  candidate (`keep:Z`)" applies; that candidate is WP3's `searchKeep`.
- WP7b's floor either acts on transient state and gets us attacked (F1, F2)
  or, once guarded, changes nothing on 20 of 20 games ([WP7b-rev],
  [WP7b-n]).

### 3.5 Cost and the browser

S1's search costs about 2 tick-equivalents per live tick, inside the 2.5
cap, with wall R 1.29–2.51 ([WP2-r2]); the structural clone made forks
8–41 live ticks each on the `quick` maps ([WP2-b]) so rollout simulation, not
forking, is now the cost ([WP5-r2]). One search can block the agent's
worker for up to 64 s, so search stays arena-only until it is time-sliced
(M7) ([WP2-r2] F11).

## 4. Runs in flight, killed, or still to do

The container restarted at about 20:25 UTC on 2026-09-27 (`uptime` 10 min at
20:35, load 18 on 4 cores) ([ps]). Every run below is restart-safe the same
way: rerun the missing games with `--range a:b` into a `-rest` directory and
join with `npm run arena:merge -- --force`.

| run                                                   | where                                                                                                                                                              | state at 20:35 UTC                                                                                                                                | how to finish                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| fixed S1 screen, `quick@20`, 32 games, `6841de8`      | `/tmp/claude-0/m4-screen/s1-6841de8` (worktree `wt-6841de8`, script `run-s1-r2.sh`)                                                                                | **running**, restarted after the reboot; 1 game on disk (g1, land at minute 20 22.5% against UE's 5.9%) ([ps], [screen-calc])                     | when `summary.json` exists: `npm run arena:compare -- arena-results/quick20-int /tmp/claude-0/m4-screen/s1-6841de8 --entrant-a 3 --entrant-b 'apex:{"search":true}'`; then S1 against S0 (below) with the WP2 rule                                                             |
| old S1 screen at `84ae424`                            | `/tmp/claude-0/m4-screen/s1-84ae424` (14 games, `EXIT 143`)                                                                                                        | killed at 14 of 32 by an earlier restart; superseded by the fixed S1 ([S1p], [WP2-r2])                                                            | do not resume; keep for the ledger row                                                                                                                                                                                                                                         |
| S0 on all 32 games                                    | 13 games in `/tmp/claude-0/m4-screen/s0-84ae424/g*/` (complete, `s0-laneA.log` ALLDONE); act3's 19 in `/tmp/claude-0/search/act3-g*` and the scratchpad's `oos/g*` | done; not yet merged or compared with S1                                                                                                          | merge the 13 with act3's 19 (WP2's `cmp_s0_all.py` reads the 19; `arena:merge` joins the 13), then compare with the fixed S1: "the same or better land at minute 20, sign test not against it at p < 0.1, and R at least 20% lower; otherwise ship S0's clock" ([plan] §3 WP2) |
| round-2 screen S1 / S1-R3 / S1-long, `6841de8`        | `/tmp/claude-0/m4-screen/r2-6841de8` (`run-r2.sh`, 3 entrants, `--jobs 3`)                                                                                         | 3 game files on disk; not running after the reboot ([ps])                                                                                         | rerun `run-r2.sh` once the S1 screen has the CPU; it separates the budget (R 3) from the look (S1-long) ([WP2-r2] open problem 1)                                                                                                                                              |
| [UE-dev60], `apex` at `84ae424`, `dev`, 60-minute cap | `arena-results/dev60-ue-84ae424` (`run-dev60-ue.sh`, `--jobs 2`, nice 15)                                                                                          | 40 of 254 games on disk; not running after the reboot ([ps])                                                                                      | `--range 40:254` into `dev60-ue-84ae424-rest`, merge; about 4 h at 4 jobs ([plan] §3). It is the A side for M4's win rate                                                                                                                                                      |
| WP10n stage 1                                         | `/tmp/claude-0/pkg-WP10n/runs2/` (`treeB2`, both arms; `run2.sh`, `ana2.py`)                                                                                       | g26 and g0 pairs done; `s1b-g6` done, `n2-g6` crashed (SIGKILL); g16 not run ([WP10n-r2], `status.txt`)                                           | rerun `n2-g6` and the g16 pair with the machine less loaded; then stage 2: S1 against `apex:{"search":true,"searchNukes":true}` on `quick@20` ([WP10n-r2] recommendation)                                                                                                      |
| WP3 stage 1                                           | `/tmp/claude-0/pkg-WP3/runs/` (`lane.sh`, `q-base-a.txt`, `q-base-b.txt`)                                                                                          | S1 baselines on the named failure games and a `searchBoat` run on Four Islands g23 are playing ([ps])                                             | plan §3 WP3 stage 1 (Africa g11, Mississippi g10, Alps g18 for defend and keep; Four Islands g7 and g23, Bering g3 and g19, Yellow Sea g12 and g28, Mississippi g26 for boat), then stage 2 on `quick@20`                                                                      |
| WP7a round 2 (v8)                                     | `/tmp/claude-0/pkg-WP7a/` (`tree6` planned), reviewer's off-replay g3 running in `/tmp/claude-0/review-WP7a/off-g3`                                                | building; eval plan: off-replay 0:4, screen 0:16 at 20 min, key games at 30 min, `dev` 0:32 at 30 min against the truncated [UE-dev60] ([WP7a-n]) | decide on a horizon of at least 30 minutes ([WP7a-rev] fix 1)                                                                                                                                                                                                                  |
| WP7b round 2                                          | `/tmp/claude-0/pkg-WP7b/` (`r2`, `r3` trees; `cmp-r2-*`, `cmp-r3-*`; `iso.done`)                                                                                   | done: FBR identical to [UE] on 20 of 20; recommendation "do not run dev@20" ([WP7b-n]); a reviewer off-replay on g2 was running ([ps])            | nothing to run; keep the options off                                                                                                                                                                                                                                           |
| WP10b round 2                                         | main tree (`LeaderGuard.ts`, `LeaderHook.ts`, `policy.ts` hook; `LeaderFidelity.test.ts` modified, [git])                                                          | fix v2 for F1 (a break off the decision cadence) being built ([WP10b-b] notes 13:40)                                                              | rerun the off-replay, `LeaderBetrayal`'s F1 scenario, and World g16 with S1; the reviewer's stop-gap test is `/tmp/claude-0/review-WP10b/tree/tests/agent/review/BreakStrike.test.ts` ([WP10b-rev])                                                                            |
| WP9's 60-minute games                                 | `/tmp/claude-0/pkg-WP9/runs/g{0,2,3,6,9,15,16,20,26}/`                                                                                                             | done ([WP9])                                                                                                                                      | reruns with a chosen entrant: `cd /tmp/claude-0/wp9-wt && npx tsx src/agent/arena/Arena.ts --suite quick --range g:g+1 --max-minutes 60 --agent <entrant> --jobs 1` (WP9's `lane.sh`); the observer needs `WP9_PROBE_DIR`                                                      |

## 5. The decision rules that remain, and the next steps

From chapter 14 §3 and §4.3, in the order they now apply:

1. **WP2, S1 against S0** (needs the S1 screen and the merged S0): S1 ships
   as the default search only if its land at minute 20 is the same or better
   (sign test not against it at p < 0.1) and its R is at least 20% lower;
   otherwise ship S0's clock. S2 (breaks always at 1,800) replaces the gate
   only if it beats S1 at minute 20 in the sign test (p < 0.1) ([plan] §3
   WP2). If S1 trails S0, the round-2 screen (S1-R3, S1-long) tells whether
   the budget or the rules are the cause ([WP2-r2]).
2. **WP2 to `dev@20`:** S1 − UE has Δprogress ≥ +0.05 with the interval
   excluding 0; out before minute 20 ≤ UE + 1 game (≤ 5 of 32); top 3 at
   minute 10 ≥ UE's; land at minute 20 ≥ 0; 0 mismatches; R ≤ 3 ([plan] §3
   WP2). On the 14 partial games every clause held except that the interval
   was never computed on a full run ([S1p]).
3. **Adopt on `dev@20`** (254 pairs against [UE-dev]): Δprogress > 0 with the
   interval excluding 0, out before minute 20 not worse by more than 2
   points, no map category with Δprogress < −0.02, smoke and `--isolate`
   green, and the showcase gallery agrees ([plan] §3 WP2). This is the run
   that can move M3's numbers.
4. **WP10n stage 2** on the adopted search: S1 against
   `apex:{"search":true,"searchNukes":true}` on `quick@20`; adopt by WP3's
   generator rule ("on the games where it acts, the sign test on land at
   minute 20 favours it at p < 0.1 or eliminations fall, with R up by less
   than 15%") since it is a generator ([plan] §3 WP3; [WP10n-r2]).
5. **WP3** stage 1 on the named games, then stage 2 paired against S1, the
   same rule; `rank` by its Q6 test (top two contain the rollout's best
   strike ≥ 80% of the time) ([plan] §3 WP3).
6. **WP8 stage 2:** S1 against S1 + `goldPolicy` "model"; the rule is land at
   minute 20 +1 point or more with the sign test not against it and bombs
   ≤ 1.5× ([plan] §3 WP8; [WP8-2] "the next test").
7. **M4 itself:** the adopted combination on `dev@60` against [UE-dev60]:
   first wins, then ≥ 25% (roadmap §11.6). WP9's arithmetic says 25% needs
   about 64 wins in 254, or 30% of the land-map games ([plan] §4.1).
8. **WP7a and WP7b stay off.** WP7a's idea lives on as `searchKeep`; WP7b's
   guarded variant is inert. Neither needs a `dev@20` run ([WP7a-rev],
   [WP7b-n]).

Plan §4.3's other triggers, checked: "S1 land at minute 20 ≤ UE" did not
fire (+6.4 on 14 games, [S1p]); "R cannot be brought under 2.5" did not fire
(S1 at 1.96–2.22, [WP2-r2]); "WP4 finds λ > 0" did not fire ([WP4]); "boat
candidates never beat the base" is not yet measured (WP3).

## 6. Known defects and open problems

Each item names the package whose files hold the fix.

**Search core (WP2)**

- S1 may lose to S0 on the full screen through the budget: 26 of 45
  alliance-end triggers refused, the gated look never affordable at R 2.5
  ([WP2-r2]).
- The Box g9 is unstable under S1: eliminated after a +233k strike and a
  pile-on that began inside the look; four S1 variants gave out / 23.5% /
  out / out; it wants WP3's defend and keep plans or a longer look
  ([WP2-r2]).
- A search can block the agent's worker for up to 64 s; the browser needs a
  time-sliced search (M7) ([WP2-r2] F11).
- `docs/10-agent-interface.md` does not mention `ctx.budgetState()` ([WP1-r2]);
  WP6's `Summary.ts` doc still says the budget slack is 3,000 (it is
  `searchSlack` 4,500) ([WP2-r2]).

**Exactness (WP1, WP5)**

- A latent last-bit difference in `Ledger.expectedRefunds` (live keeps plans
  in creation order, a copy sorted); never seen to change a decision; the fix
  is in `lib/Ledger.ts`, which no package owns ([WP1-r2]).
- Games with water nukes rebuild the water graph on every clone (170–200 ms
  on Japan and Giant World Map); the arena has water nukes off ([WP5-r2]).
- The Lookahead branch patch (`Lookahead.branch`, `f.replay`) was handed over
  as a patch; whether it was applied is not recorded in the reports
  ([WP5-r2]).

**Value and horizon (WP4)**

- The log-only probes sample UE's states, not the search's own states after a
  break; the 2,400-tick benchmark is itself "plan, then rules" and is biased
  against plans that set up follow-ups (the policy-iteration gap: chained
  acts gained 1.33–1.36× their predicted gain) ([WP4]).
- The danger terms miss the biggest losses, attacks by former allies
  1,400–2,150 ticks out ([WP4]).

**Leader phase (WP10b, WP10n, WP8)**

- WP10b F1: the guard does not hold the traitor line for the strike that
  follows our own break (sized at t+1 from floors computed at t); the fix in
  WP10b's own files is in progress. Expiry-then-attack, nuke-collateral
  breaks and the two-players-left bombs are not modelled; `mirvDanger` is
  computed but nothing consumes it; the lines rarely bind on big maps
  ([WP10b-rev], [WP10b-b]).
- WP10n: only g26 is fully in hand; `n2-g6` crashed and g16 was never run;
  the MIRV land-time estimate is an affine fit that a clipped arc could
  mistime ([WP10n-r2]). Before round 2 the T8 threat trigger had fired 0
  times in the data ([WP10n-rev]); after it, once (g26) ([WP10n-r2]).
- WP8: one game carries the gain; the minute-4 buys on Bering draw the land
  leader's bombs before its ladder names us; a buy at the exact end of a silo
  reload was bombed 8 ticks later; a hydrogen bomb took 9 levels on g28;
  the 1.5M reserve was never tuned ([WP8-2]).
- WP9: Europe g6's MIRV is inferred, not observed (the confirming replay was
  killed by the out-of-memory limit at tick 21,000); nine games is a small
  sample ([WP9]).
- WP10-PIN gaps: the MIRV's 350-warhead cap and 1,500-tile range, arcs
  clipped at the map's top edge, how fast a nation rebuilds a silo, and team
  mode ([WP10-pin]).

**Base rules (WP7a, WP7b)**

- WP7a: kept giants betray once our home is below a third of their troops
  (gifts only buy time); 9 of 18 gifts went to extensions refused for our
  alliance count; a refused renew blocks the recall for 300 ticks; the
  sub-option defaults are the rejected variant ([WP7a-rev]).
- WP7b: the replica's preference exits sit on a knife edge (the switch point
  rose above our home within 70 ticks of the strike on The Box g9 at 7213);
  with the Regrow guard the option changes nothing ([WP7b-n]).

**Infrastructure**

- Container restarts killed the old S1 screen at 14 of 32 games and
  [UE-dev60] at 40 of 254; an oversubscribed machine (load 17–18) SIGKILLs
  arena workers (WP10n `n2-g6`) and times out the older mechanics pins'
  `beforeAll` (60 s) ([S1p], [ps], [WP10n-r2], [WP10-pin]).
- `tests/agent/apex/Options.test.ts` requires every controller to have a flag
  that defaults to true; `search` and `spawn` are listed as exceptions
  ([WP2-b]).
- At `19d8e60` the working tree holds uncommitted round-2 work: WP7a's
  `DiplomacyController.ts`, WP10b's `LeaderFidelity.test.ts`, and WP3's
  `SearchKeep.test.ts` and `SearchWorld.ts` (staged) ([git]). The checkpoint
  commits (`84ae424` … `19d8e60`) are snapshots of several packages at once,
  not per-package commits.
