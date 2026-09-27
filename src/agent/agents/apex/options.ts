import { GOLD_POLICIES, GoldPolicyArm } from "../../lib/GoldPolicy";
import { RaceFieldOptions } from "../../lib/RaceField";
import { IntentClass, SchedulerOptions } from "../../lib/Scheduler";

// Every option of the apex agent (spec §3.9). Keys are flat, so an arena
// entrant reads `apex:{"homeX":0.25}` and a gallery label `homeX 0.25`.
// Every feature has an enable flag, so an ablation is an A/B of
// `apex:{"<feature>":false}`. Defaults follow the M2 build order (spec §4):
// the features of steps 1-7 are on; rollout spawn (step 8), stall strike
// (step 9) and everything of M3-M5 are off until an experiment adopts them.
// The flags of features not built yet (UNBUILT below) are refused when set
// to anything but their default, so no run plays the defaults under a
// feature's label.

/** §3.2: plan = SpawnPlanner.planSpawn; race = race field (§3.2.4); idle =
 *  race field on a 900-tick idle fork (§3.2.2); rollout = successive-halving
 *  rollouts (§3.2.5). */
export type SpawnMode = "plan" | "race" | "idle" | "rollout";
/** §3.8, §5.1.5: exposure = build only while no nuke rule points at us (or a
 *  SAM covers the site); free = ignore nukes; never = build nothing. */
export type StructurePolicy = "exposure" | "free" | "never";
/** §3.4.2, E7: how allySet is ranked. danger = danger·(1 + contactShare);
 *  nearest = OwnerGrid cell distance. */
export type WebRank = "danger" | "nearest";
/** §5.2.2: the strike windows (W4 was dropped). */
export type StrikeWindow = "W1" | "W2" | "W3" | "W5" | "W6";

export const SPAWN_MODES: readonly SpawnMode[] = [
  "plan",
  "race",
  "idle",
  "rollout",
];
export const STRUCTURE_POLICIES: readonly StructurePolicy[] = [
  "exposure",
  "free",
  "never",
];
export const WEB_RANKS: readonly WebRank[] = ["danger", "nearest"];
export const STRIKE_WINDOWS: readonly StrikeWindow[] = [
  "W1",
  "W2",
  "W3",
  "W5",
  "W6",
];
// A Record so the compiler insists on every IntentClass.
const INTENT_CLASSES: Record<IntentClass, true> = {
  spawn: true,
  defense: true,
  diplomacy: true,
  snack: true,
  topup: true,
  tn: true,
  tribe: true,
  boat: true,
  strike: true,
  build: true,
};

export interface ApexOptions extends RaceFieldOptions, SchedulerOptions {
  // ── Pacing (§3.0) ────────────────────────────────────────────────────
  /** Ticks between decisions, paced by elapsed ticks. Nations decide every
   *  30-49 ticks, tribes every 40-79; reflexes run every tick. E11. */
  thinkEvery: number;
  /** Full NationModel refreshes (one N.nearby() each, linear in the
   *  nation's border) per tick, round-robin over bordering and reachable
   *  nations, under a border-tile budget (policy.refreshNations). About 1 ms
   *  a tick in the opening; a late-game nation with a 15-25k-tile border
   *  costs 3-5 ms alone, so it is refreshed on a tick without a decision. */
  nationRefreshPerTick: number;
  /** Refresh each nation once per decision interval, in the
   *  REFRESH_LEAD ticks before its next decision (the state its answer is
   *  forecast from), instead of every 10 ticks (3-5 times per interval).
   *  Off: the fixed 10-tick cadence. */
  refreshBeforeDecision: boolean;
  /** Ticks between diplomacy plans (§3.4.2) and tribe-contest caches. */
  planEvery: number;

  // ── Spawn (§3.2; SpawnController has no enable flag: spawnMode "plan"
  //    is its lowest setting) ───────────────────────────────────────────
  /** How the spawn is chosen. E4. */
  spawnMode: SpawnMode;
  /** Spawn-phase tick to decide at: tribes land in tick 1, nations in 2. */
  spawnDelay: number;
  /** Target cell count of the race grid; keeps its full scan under 0.6 s. */
  spawnCellTarget: number;
  /** Cells kept after the proxy score for the exact BFS (about 60 ms). */
  spawnK0: number;
  /** Weight of the nation-free pie B against our free land A. E4b. */
  spawnBeta: number;
  /** Slack in ticks against hops and jitter when we "arrive first". */
  spawnMarginTicks: number;
  /** Mean first-act delay of a tribe, in ticks. */
  spawnTribeDelayTicks: number;
  /** Score factor exp(−λ·(threat − θ)) per extra strong nation in reach. */
  spawnThreatLambda: number;
  /** Score bonus for a site that can snack a fresh tribe (one tribe = 52
   *  tiles). */
  spawnSnackBonus: number;
  /** Our expected land at ticks 0, 300, 600, 900, 1200, 1800 (about 0.55 of
   *  the ODE ceiling). Six numbers. Refit in E3. */
  spawnGrowth: number[];
  /** Ticks the idle fork is stepped (spawnMode "idle"). */
  spawnIdleTicks: number;
  /** Best race candidates rolled out, plus planSpawn's site and islands. */
  spawnRolloutK: number;
  /** Ticks of the first rollout round. E4c. */
  spawnRound1: number;
  /** Candidates kept after round 1. */
  spawnKeep: number;
  /** Tick the kept rollouts are extended to. */
  spawnFinal: number;
  /** Wall-clock cap of the spawn search in ms. The browser autopilot should
   *  pass 20,000 (§3.2.6; rollouts are off there). */
  spawnWallBudgetMs: number;

  // ── Package A3 SPAWN PREVIEW (H1; chapter 13 §2.1, §5.1;
  //    SpawnController.previewPlan, lib/SpawnErase.ts). Off by default; the
  //    options after spawnErase act only when spawnPreview is on. ──
  /** Plan the spawn at the agent's first call (ctx.tick 1) on a fork
   *  advanced 2 ticks without us: the tribes (tick 1) and every nation
   *  (tick 2) are on the ground there, exactly as they will be, and a spawn
   *  sent then lands in tick 2, ahead of every nation. It acts through
   *  spawnErase: without a verified erasure (or if a fork fails) the spawn
   *  is planned and sent at spawnDelay as without the preview, so such a
   *  game replays apex exactly (see spawnPreviewEarly). Singleplayer
   *  outside the browser only: the browser autopilot cannot count on turn 1
   *  (chapter 13 §2.1 Open), so arena numbers with this on include an
   *  opening the browser does not get. */
  spawnPreview: boolean;
  /** With spawnPreview: also consider spawning on exactly a nation's pick,
   *  which covers its disc so it is never placed. Scored as a race site on
   *  the arrival field without that nation (A and B capped by the land
   *  connected to the site when that land is landlocked), and verified in
   *  a second fork (the nation disappears and no other nation is cut).
   *  A3 round 2, with the defaults below, against apex @20: the gain is in
   *  the opening and the peak, not in survival. quick (32 games): progress
   *  +0.035 [+0.022, +0.051], 25/4, peak +2.8 points, top 3 at minute 10
   *  7 → 14 (8-1), but final land +1.5 [−1.1, +4.3], survival +0.4 min
   *  [−0.5, +1.5], lost before minute 20 (any cause) 14 → 14. dev, out of
   *  sample (46 games: maps with 4 or fewer nations and the margin band):
   *  progress +0.040 [+0.017, +0.064], final land +4.4 [+1.0, +8.3],
   *  survival +0.1 min [−1.1, +1.3]. */
  spawnErase: boolean;
  /** An erasure site must score above (1 + this) × the best race
   *  candidate's score. Tuned in-sample on quick@4 (+0.1 < 0 < −0.1 <
   *  −0.25); on dev @20, out of sample, the games only −0.25 erases (score
   *  0.75-0.9× the race best, 38 games) gain progress +0.032 [+0.010,
   *  +0.056] (survival −0.3 min [−1.7, +1.1]), and those only −0.4 would
   *  add (0.6-0.75×, 14 games) lose −0.027 [−0.087, +0.030]. */
  spawnEraseMargin: number;
  /** Most erasure sites scored exactly (each a full nation search). */
  spawnEraseK: number;
  /** Nations that must be left after an erasure (the layout's placed
   *  nations minus the erased ones). 2 never leaves a duel, where every
   *  nation attack is ours and, once only two players (tribes included)
   *  are alive, every nuke too (NationNukeBehavior): 4 of the 5 Bering
   *  Strait erasures seen lost by minute 6.1-7.0 against 9.5-19.1 for
   *  apex. 3 would also keep 3-nation maps, where erasures went 2 worse
   *  (Onion) and 2 better (Tourney 3 Teams). 0: no guard (round 1). */
  spawnEraseMinLeft: number;
  /** Without a verified erasure, send the preview's race best at tick 1
   *  anyway (round 1). It is apex's tile, but landing in tick 2 instead of
   *  4 shifts the whole game and runs our PlayerExecution ahead of the
   *  nations', for no measured gain (quick@4 progress −0.001 [−0.021,
   *  +0.026], 11/21). */
  spawnPreviewEarly: boolean;

  // ── HomeTarget and floors (§3.1) ─────────────────────────────────────
  /** Home target as a share of the cap (H_econ). E3. */
  homeX: number;
  /** Floor for snacks and defense as a share of the cap (veryWeak line 0.15
   *  plus margin). */
  vwGuard: number;
  /** TN floor as a share of H: lets home dip to tnKeep·homeX of the cap for
   *  free land. E3. */
  tnKeep: number;
  /** Margin on the food-list floor (T_N(d_N) + 1)/1.1. */
  foodMargin: number;
  /** A food-list term above detCap·cap drops that nation from the list. */
  detCap: number;

  // ── Controller enable flags (§3.0) ───────────────────────────────────
  /** ExpansionController (§3.6), the allocator. */
  expansion: boolean;
  /** DefenseController (§3.3): reflexes every tick. */
  defense: boolean;
  /** DiplomacyController (§3.4). */
  diplomacy: boolean;
  /** StrikeController (§3.5, §5.2); its features have their own flags. */
  strike: boolean;
  /** EconomyController (§3.8). */
  economy: boolean;
  /** EndgameController (§5.3). A stub until M5, so false changes nothing
   *  (tests use it to trim the controller list); its features have their
   *  own flags. */
  endgame: boolean;

  // ── Expansion: free land (§3.6.3) ────────────────────────────────────
  /** Free-land (terra nullius) sends. */
  tn: boolean;
  /** TN stack as a multiple of the saturation stack. */
  tnSat: number;
  /** Ticks of TN burn a send covers; also its minimum cadence. */
  tnHorizon: number;
  /** Smallest TN send as a share of `want` (or S_sat if smaller). */
  tnMinChunk: number;
  /** Pace TN sends to the tn class cap: the early trigger (A < 0.5·S_sat)
   *  fires only while the sends it adds leave the tnHorizon cadence under
   *  the cap for the rest of the minute (Scheduler.paceOk), and the cadence
   *  counts from the last TN send after its plan ended. Without it, small
   *  purse-limited sends go out every 12 ticks and hit the 30/min cap
   *  before minute 1 on Alps, The Box and Middle East, stopping free land
   *  for 70-147 ticks. Off by default: on arena quick@4 it gained 10-24%
   *  of the land at minute 1 on those maps but lost progress by minute 4
   *  (tnPace off +0.003 [+0.001, +0.006], 13 better, 2 worse; a 60/min tn
   *  cap instead: −0.001). */
  tnPace: boolean;

  // ── Expansion: snacks and tribes (§3.6.1-3.6.4, §3.6.7) ──────────────
  /** Snacks: tribes under 100 tiles fall to their first lost tile. E9. */
  snacks: boolean;
  /** Snack stack as a multiple of the first-tile loss. */
  snackSafety: number;
  /** Largest snack stack. */
  snackMax: number;
  /** Top-ups of running tribe, snipe and strike attacks (§3.6.2). */
  topUps: boolean;
  /** Tribe launches (§3.6.4). */
  tribes: boolean;
  /** Attack-to-defender ratio at launch (the 0.6 loss clamp). */
  tribeRatio: number;
  /** Stack margin that covers drift between top-ups. */
  tribeMargin: number;
  /** Ticks of drift a launch or top-up covers. */
  tribeBurnWindow: number;
  /** Top up when the attack holds less than this share of `need`. */
  tribeTopUpAt: number;
  /** Minimum ticks between top-ups of one attack. */
  tribeTopUpEvery: number;
  /** Skip tribes whose loss per tile exceeds this multiple of the TN price. */
  tribeMaxPrice: number;
  /** Most tribe launches per decision. */
  maxTribeLaunches: number;
  /** Most tribe attacks running at once. */
  maxTribeAttacks: number;
  /** Weight of a tribe's gold (paid at the kill) in its score. E5. */
  lambdaGold: number;
  /** Contest weight: prefer tribes a nation will eat next. E9. */
  contest: boolean;
  /** Score factor for a contested tribe. */
  contestBonus: number;
  /** Lightning rods: keep a dangerous nation's last affordable tribe. E9. */
  buffer: boolean;
  /** Score factor for a lightning-rod tribe. */
  bufferPenalty: number;
  /** Snipes: prefer small tribes a nation is attacking. E9. */
  snipes: boolean;
  /** A tribe under this many tiles can be sniped. */
  snipeTiles: number;
  /** Score factor for a snipe. */
  snipeBonus: number;
  /** Enclose-and-poke (§3.6.5). E9. */
  pokes: boolean;
  /** Troops of a poke (about 4 dense tiles). */
  pokeTroops: number;
  /** Never launch if the refunds would lift home above the cap
   *  (§3.6.7, C2). */
  headroom: boolean;
  /** Cap headroom slack as a share of the cap. */
  headroomSlack: number;

  // ── Expansion: stall mode (§3.6.6) ───────────────────────────────────
  /** Stall mode. E10. */
  stall: boolean;
  /** Stall trigger: home above this share of the cap ... */
  stallFrac: number;
  /** ... for this many consecutive ticks (or no accepted offer for as
   *  long). */
  stallTicks: number;
  /** Stall rule 1: tribes at this ratio. */
  stallRatio: number;
  /** Stall rule 1 on/off. E10. */
  stallTribes: boolean;
  /** Stall rule 2: big boats. E10. */
  stallBoats: boolean;
  /** Stall rule 3: a W1 or W2 strike (§3.5). Step 9, off. E10. */
  stallStrike: boolean;
  /** The stall strike sends every idle troop above the strike floor
   *  (purse.available("strike")) instead of the tribe clamp
   *  (T/tribeRatio)·tribeMargin: at the cap they are idle anyway. Still
   *  sent only if at least T after the 1:1 cancel. */
  stallStrikeFromHome: boolean;
  /** In stall mode, the diplomacy plan measures danger against our home now
   *  (at most the cap) when it exceeds homeX of the projected cap: a
   *  neighbour that cannot out-send what we hold idle at the cap is food
   *  (§3.4.2), which the stall strike may hit, not an ally. Off: danger
   *  against homeX of the projected cap only (the spec). */
  stallDangerHome: boolean;

  // ── Naval (§3.7) ─────────────────────────────────────────────────────
  /** NavalController: boats. E6. */
  boats: boolean;
  /** Ticks between boat decisions. */
  boatEvery: number;
  /** Most canBuild(TransportShip) probes per decision (p95). */
  boatProbes: number;
  /** Smallest available troops before a boat goes. E6. */
  boatMinTroops: number;
  /** Troops a tribe landing carries on top of the tribe's stack S_b. */
  beachheadExtra: number;
  /** Maps with less land than this share are water maps. */
  waterMapLand: number;
  /** Skip a boat whose landing tile, or straight route from its launch
   *  tile, lies within a hostile warship's targeting range (not in the
   *  spec, which leaves warships to M6: arena quick@4 lost up to 900k
   *  troops in 4 minutes to boats sunk right after launch). */
  boatAvoidWarships: boolean;
  /** Tiles added to config.warshipTargettingRange() (130) for that check:
   *  warships move while a boat sails. */
  boatWarshipMargin: number;
  /** Check the route guard before the canBuild probe (each about 2 ms on
   *  GiantWorldMap), from the launch tile the last probe to that landmass
   *  returned or, without one, our ocean-shore border tile nearest the
   *  landing on its water body. 94% of probes ended at the guard. */
  boatRoutePrecheck: boolean;
  /** Skip a tribe that nations are eating: one attacks it, a nation's tile
   *  lies within boatEatenRadius of the landing, or a nation touching it
   *  has boatEatenRatio × its troops above its reserve. The transport's
   *  target is the landing tile's owner when it is launched
   *  (TransportShipExecution.ts:75), and a nation that owns the landing
   *  tile builds a warship at us (80% at Impossible) and drops its relation
   *  by 15 (NationWarshipBehavior.ts:188-297). */
  boatAvoidEatenTribes: boolean;
  /** Tiles (Chebyshev) around a tribe landing that must hold no nation
   *  tile. */
  boatEatenRadius: number;
  /** A nation touching the tribe with this many times its troops above its
   *  own reserve (T − reserve·M) eats it before a boat arrives. */
  boatEatenRatio: number;
  /** Tribes that border us get no boat unless the trigger is "water": the
   *  land allocator owns them, and a boat and a land launch could go to one
   *  tribe in the same decision. */
  boatBorderTribes: boolean;
  /** Turn back a boat of ours, not retreating, whose landing tile an
   *  unallied nation now owns and that is still at least 20 tiles out: a
   *  retreating transport leaves the nation's tracking (no retaliation
   *  warship, no −15), and a landing there fights next to the nation. The
   *  cancel costs 25% of the troops (malusForRetreat). */
  boatCancelOnFlip: boolean;
  /** Turn back a boat whose landing tile no longer belongs to its target
   *  (the tribe died or lost it, or the free land was taken) while it is
   *  still more than boatCancelFar tiles out. Off: such a landing refunds
   *  its troops in full, a cancel keeps 75% of them. E6. */
  boatCancelDead: boolean;
  /** Tiles (Manhattan) still to sail above which boatCancelDead turns a boat
   *  back. */
  boatCancelFar: number;
  /** Score boat targets by an estimated voyage (a BFS over race-grid cells
   *  holding water, from our ocean-shore border) instead of the Manhattan
   *  distance from our centroid (§3.7): boats sail 1 tile a tick, and
   *  centroid distances sent boats on 900-1,800-tick voyages. */
  boatVoyageScore: boolean;
  /** Most estimated voyage, in ticks, for a boat target (with
   *  boatVoyageScore). Voyages of 400+ ticks landed on dead tribes 27 times
   *  in 28 (arena quick@4). */
  boatMaxVoyage: number;
  /** §3.6.7 cap headroom for boats outside stall mode: skip a boat when
   *  home − troops + expected refunds (ships at sea included) + its refund
   *  exceeds cap·(1 + headroomSlack). */
  boatHeadroom: boolean;
  /** Ticks a free-land boat's landmass stays busy after its ship is gone
   *  (landed): a land TN send absorbs the landing attack (no source tile
   *  then), and the OwnerGrid shows the landing only at its next refresh
   *  (100 ticks). */
  boatLandmassHold: number;
  /** Size a free-land boat by the free land connected to its landing tile
   *  (a flood fill bounded by what the boat can pay for) instead of all the
   *  free land on its landmass; on our own landmass, at most tnSat·S_sat
   *  (nations take such pockets during the voyage). */
  boatPocket: boolean;

  // ── Package A2 NAVAL MIDGAME (H9; spec §3.7, §5.4; chapter 13 §2.12,
  //    §5.11; NavalController, RaceField.boatTargets). Off by default. ───
  /** Boats in the midgame: a "surplus" trigger when the Purse holds
   *  boatMidSurplus of the cap after the land allocator; in stall mode the
   *  tribe price limit times boatMidStallPrice (the troops are idle at the
   *  cap); far targets only with boatMidFar, their sea routes checked for
   *  warships; near ones too with boatMidRouteGuard. Needs
   *  boatVoyageScore. */
  boatsMidgame: boolean;
  /** With boatsMidgame and boatAvoidWarships, a far boat is not sent when
   *  a hostile warship lies near its estimated sea route
   *  (RaceField.voyageRoute), not only near the straight line; with this,
   *  a near boat neither. Off: package A2's screen ab4 (quick 0:12 at 20
   *  minutes) had it remove only near boats, 0 games better, 3 worse and 9
   *  tied against the flag without it. */
  boatMidRouteGuard: boolean;
  /** With boatsMidgame: far targets, past boatMaxVoyage up to
   *  boatMidMaxVoyage, only in stall mode or once our landmass's free plus
   *  tribe land is nearly gone (water priority's own-landmass test), when
   *  the landing's landmass is projected to still hold boatMidMinFood free
   *  plus tribe tiles and no nation can get there first, by land
   *  (boatMidFront) or by its random boats (boatMidNationBoat); a far
   *  tribe is sized for its regrowth during the voyage. Off: in three
   *  quick@20 screens no far boat took land the flag-off side did not take
   *  later. */
  boatMidFar: boolean;
  /** Longest estimated voyage, tiles (1 per tick), for a far target. */
  boatMidMaxVoyage: number;
  /** Smallest projected free plus tribe tiles of the landing's landmass
   *  when a far boat lands. */
  boatMidMinFood: number;
  /** Ticks of OwnerGrid history the landmass food trend is read over. */
  boatMidRateTicks: number;
  /** Multiple of the measured food loss per tick in the projection
   *  (nations eat faster as they grow). */
  boatMidRateMargin: number;
  /** Tiles per tick a nation's front is assumed to advance: a far landing
   *  needs every nation seed (its land, and the land its random boats
   *  reach) at least boatMidFront·(voyage + 50 + boatMidHold) tiles away
   *  by land (RaceField.nationReach), and a landing no seed reaches at the
   *  OwnerGrid's grain a landmass without one. A nation attacking a tribe
   *  paces 0.632 tiles a tick per border tile at r ≤ 0.82 on plains
   *  (chapter 13 §5.3; free land 0.4 when saturated, §5.2), and annexing
   *  tribes under 100 tiles jumps ahead: Alaska's front (quick@20 Bering
   *  Strait) covered 400 tiles in about 500 ticks, 0.8 a tick. */
  boatMidFront: number;
  /** Tiles (Chebyshev) around a nation's ocean-shore land counted as its
   *  reach for far targets: its random boat lands on a random tile within
   *  ±150 tiles of one of its shore tiles, unowned or tribe land first
   *  (AiAttackBehavior.ts:180-220; a literal there, not a Config value).
   *  0 turns it off. */
  boatMidNationBoat: number;
  /** Ticks a far landing must stay out of every nation's reach after it
   *  lands (its first fight). */
  boatMidHold: number;
  /** "surplus" trigger: boat troops available after the land allocator
   *  at or above this share of the cap. 0 turns it off. */
  boatMidSurplus: number;
  /** In stall mode a boat's tribe may cost up to this multiple of the
   *  tribeMaxPrice limit per tile. */
  boatMidStallPrice: number;

  // ── Diplomacy (§3.4) ─────────────────────────────────────────────────
  /** Alliance requests to the web (allySet). E2. */
  web: boolean;
  /** How allySet is ranked. E7. */
  webRank: WebRank;
  /** Keep weak reachable nations unallied as food. E7. */
  foodList: boolean;
  /** Slots kept free below A_ext (webTarget = A_ext − this). */
  allySlotsReserve: number;
  /** danger ≥ this: ally; below: food. E7. */
  allyDangerMin: number;
  /** Reach in OwnerGrid cells; null = ceil(150 / cell), about 150 tiles. */
  allyReachCells: number | null;
  /** Smallest forecast acceptance probability worth a request. */
  allyMinP: number;
  /** Most alliance requests per second. */
  allyPerSecond: number;
  /** Counter-accept requests from nations outside the food list
   *  (§3.4.4). E8. */
  counterAccept: boolean;
  /** Ask extensions for allies still in allySet (§3.4.5). */
  extensions: boolean;
  /** Ask the extension this many ticks before expiry. */
  extendLead: number;
  /** Alliance oracle: fork and request every "maybe" nation (§5.1.7). M3,
   *  off. E17. */
  allyOracle: boolean;

  // ── Package B2: diplomacy through the midgame (DiplomacyController;
  //    spec §5.1 item 1, §5.2 item 6; chapter 13 §2.9, §5.9). Every
  //    option here is off (or inert) by default. ────────────────────────
  /** The web through the midgame (spec §5.1 item 1): from webFrom on, the
   *  plan ranks every nation that can reach us (by land, or by boat with
   *  webBoatReach) by its midgame danger dmid and keeps the top slots
   *  (A_max with webSlotsMax, else A_ext) allied: requests to the unallied
   *  ones, extensions for the allied ones, a fresh request at the lapse of
   *  a kept alliance whose extension failed (webRenew), counter-accepts
   *  that leave room for them; every other ally lapses (never a break).
   *  Its requests and counter-accepts never take us past A_ext alliances
   *  (A_max refuses every extension of ours). Off: the spec web (allySet
   *  by §3.4.2 danger, extensions of allySet allies only). */
  webMidgame: boolean;
  /** Tick the midgame web takes over from the spec web (the opening's
   *  requests are the spec's); its first plan is the first decision from
   *  here. */
  webFrom: number;
  /** dmid(N) = max(T_N + out_N, trigger_N·M_N^+) / (safe·H_ref), H_ref =
   *  max(homeX·cap^+, min(home, cap)): its stack now or at its trigger on
   *  its projected land, against our deterrence line at the home we hold.
   *  Nations below this are not kept (they lapse as food). */
  webDangerMin: number;
  /** The midgame web may fill A_max (the recall slot too): extensions then
   *  fail on hasTooManyAlliances and webRenew re-requests at each lapse.
   *  Off: A_ext, so extensions can pass (A_max where A_ext is 0: small
   *  maps never extend anyway). */
  webSlotsMax: boolean;
  /** Ask a kept ally's extension once this many ticks or fewer are left
   *  (instead of extendLead). The request stays asked and the nation
   *  re-decides it at each of its decisions, agreeing at the first where it
   *  would accept us, and the term restarts from there [PIN NationAlliance
   *  "allianceExtension works any time"; chapter 13 §2.9 "ask early"]: 600
   *  gives it 12-20 decisions. An ask cannot be withdrawn, so the earlier
   *  it goes the likelier the keep set has dropped the ally by the time it
   *  agrees. Arena quick@20 v2 (1,800): of 320 extensions asked at A_ext or
   *  fewer alliances, 270 passed at the first decision and 305 within 600
   *  ticks; the longer lead only waited for lapses above A_ext. */
  webExtendLead: number;
  /** An ally is asked to extend only once it has been in every plan's keep
   *  set for this many ticks running (3 plans): v2 won 127 of its 529
   *  extensions for allies the keep set dropped within 600 ticks. */
  webExtendStable: number;
  /** Reach includes, while we own an ocean shore, the nations on one that
   *  would boat at us though they cannot reach us by land: islanders (no
   *  bordering enemy or free land on the OwnerGrid) that count us among
   *  the two nearest players they would boat at
   *  (AiAttackBehavior.findNearestIslandEnemy), their dmid scaled by
   *  webBoatDiscount. Every other nation attacks players it borders (or
   *  lands random boats within 150 tiles, inside the land reach). v2 kept
   *  every ocean-shore nation at any distance: 143 boat-only requests in 32
   *  games, 4 of those nations attacked apex in the paired baseline games,
   *  and the refresh list doubled on GiantWorldMap. */
  webBoatReach: boolean;
  /** dmid factor of a nation reached by boat only (a boat carries T/5; the
   *  beachhead's land attacks then send the full cap: 14 of the 67 nations
   *  that attacked apex in quick@20 opened with a boat). */
  webBoatDiscount: number;
  /** Re-request a kept ally at once when its alliance lapses: a fresh
   *  request is decided with our alliances one fewer (hasTooManyAlliances
   *  passes where the extension failed at A_max) and without us counted
   *  as its friend, so the extension trap (§2.9) refuses it only when
   *  every other non-bot neighbour of the nation is its friend (a request
   *  is refused while at most one bordering non-bot player is not its
   *  friend). Arena quick@20 v2: 37 renews sent, 32 accepted. */
  webRenew: boolean;
  /** Smallest forecast for a renew request. */
  webRenewMinP: number;
  /** The renew may restore A_max alliances (the count before the lapse):
   *  at A_max at least one ally is outside the keep set (A_ext at most), so
   *  the spell ends when it lapses. Off: the renew too stops at A_ext.
   *  Arena quick@20 and a dev shard (v4, 64 games): 23 renews restored
   *  A_max on maps with A_ext >= 1, all accepted, and none of those
   *  nations attacked apex later; not screened on its own. */
  webRenewOver: boolean;
  /** Only while a strike feature is on (strikes, stallStrike or
   *  strikeWindows): in stall mode with no unallied bordering nation left
   *  to eat, the weakest bordering kept ally is dropped from the keep set
   *  so it lapses and becomes a target (never a break). Inert otherwise. */
  webLapseTarget: boolean;
  /** Keep-set stability: an allied (or asked) nation ranks at dmid times
   *  this, so it keeps its slot until another is clearly more dangerous,
   *  and stays eligible down to webDangerMin / webKeepBonus. Without it
   *  the keep set flipped every plan between nations of similar dmid
   *  (arena quick@20 Four Islands, ArchipelagoSea), and allies requested
   *  one plan fell out of it the next. */
  webKeepBonus: number;
  /** Keep-set stability: a nation ranks at its peak dmid, the peak losing
   *  (1 − this) of itself per plan (50 ticks) unless a new dmid exceeds
   *  it; 0 ranks by the plan's dmid alone. A nation's stack swings ±30%
   *  between plans as its attacks go out and come back (arena quick@20
   *  Four Islands: Sylvoria 0.62-0.87, Korinthal 0.58-0.74). */
  webPeakKeep: number;
  /** An unallied nation takes a keep slot only if a request sent now
   *  would pass (forecast >= allyMinP; a few forecasts per plan): a nation
   *  that refuses us leaves the slot to the next one (arena The Box: the
   *  slot waited on Train Trader, who refused, while Front Manager lapsed). */
  webKeepFeasible: boolean;
  /** Keep set size A_ext − ⌊this·A_max⌋ (at least 1): A_max shrinks as
   *  nations die (by 15-30% within an alliance's term from minute 3, arena
   *  quick@20), and while we hold more than A_ext every extension fails on
   *  hasTooManyAlliances (arena North America: 15 alliances against an
   *  A_max down from 17 to 13; Nunavut and Alaska lapsed). 0: off (0.25
   *  was screened only together with another change, package B2 ab4). */
  webSlotSpare: number;
  /** Buy the extension of a dangerous kept ally with its friendship: when
   *  its extension is still refused webFriendLead ticks before expiry
   *  (the trap, or not similarly strong), donate ceil(M_N/5) + 1 troops
   *  (the top of the +50 draw at Impossible, DonateTroopExecution.ts) timed
   *  to land in the turn before one of its decisions, so it judges the
   *  pending extension Friendly (relation >= 50: accepted 67% of the time)
   *  before decay takes the value under 50 again. At most one per
   *  donateCooldown(); only from home at webFriendHome of the cap or more,
   *  and never below floor(strike). Needs webMidgame; webFriendGold goes
   *  first when both are on. */
  webFriend: boolean;
  /** The same with gold (DonateGoldExecution: +5 relation per chunk of
   *  25,000·(1 + t/3,100) gold at Impossible, at most +100): enough to keep
   *  it Friendly from the next decision until 60 ticks past the expiry, so
   *  the pending extension gets its 67% at every decision left and the
   *  renew at the lapse (a fresh request, decided with the same Friendly
   *  branch before the trap and the strength tests) gets one more. An
   *  extension refused as "tooMany" (hasTooManyAlliances goes before
   *  Friendly) gains only the renew's chance. For a bordering kept ally
   *  only, one gift per term, from at most webFriendGoldShare of our gold.
   *  Needs webMidgame. */
  webFriendGold: boolean;
  /** Most of our gold one gift may take. */
  webFriendGoldShare: number;
  /** Ticks before expiry from which friendship is bought. */
  webFriendLead: number;
  /** Smallest dmid of an ally worth a gift (1: its stack out-sends our
   *  deterrence line). */
  webFriendMinDanger: number;
  /** Donate only while the extension forecast is below this. */
  webFriendMinP: number;
  /** Smallest home, as a share of the cap, for a troop donation. */
  webFriendHome: number;
  /** Diagnostic log lines only (`dip web`): the unallied nations that
   *  matter, with their forecast. Decides nothing (it may refresh
   *  NationModel entries lazily, so it is off for A/B runs). */
  webDiag: boolean;

  // ── Package WP7a WEB KEEP: keep the strong bordering allies
  //    (DiplomacyController planStrong, extensions, renewStrong,
  //    keepGifts; docs/14-m4-plan.md §2.7 item 7a). A base rule: the
  //    search's rollouts copy it. Off by default. ────────────────────────
  /** Keep the strong bordering allies (land contact; maxTroops(Z) at
   *  least webKeepCapRatio times ours, or troops(Z) at least
   *  webKeepTroopRatio times our cap), in allySet (or the midgame keep
   *  set) or not: a fresh request the tick their alliance lapses
   *  (webKeepRenew), gold for the friendship of one still refusing its
   *  asked extension (webKeepGift), and, with webKeepAsk, the extension
   *  asks themselves at the web's lead, sooner for webKeepGap; none of it
   *  for an ally that could betray us at our cap (webKeepBetrayShare).
   *  Arena quick@20, UE's 32 games: former allies sent 214M of the 435M
   *  nation troops sent at apex (51M after a lapse never asked, 162M after
   *  a refused extension); 11 of the 13 unasked allies that attacked after
   *  their lapse held 1.1x our cap or more. The sub-options default to the
   *  arm screened on quick@20 (32 games against UE, package WP7a v7: land
   *  at minute 20 +0.9 points [−0.03, +1.95], but the gain sat in kept
   *  alliances outliving the 20-minute cap; Δprogress −0.006 [−0.020,
   *  +0.004], eliminations before minute 20 4 against 4) with the review's
   *  guards (webKeepRenewMinP 0.8, webKeepBetrayShare, no gift for an
   *  extension refused for our alliance count). */
  webKeepStrong: boolean;
  /** The strong rule's own extension asks (at the lead, sooner for
   *  webKeepGap). Off: a strong ally is asked only when the web keeps it
   *  (allySet, or the midgame keep set), and webKeepRenew and webKeepGift
   *  still apply. Screened quick@20 0:16 with it on (package WP7a v5):
   *  asks for strong allies outside the web postponed their lapse into
   *  the midgame, when they were bigger (Japan g8 −10.7 points at minute
   *  20, Africa g11, Middle East g13 eliminated). */
  webKeepAsk: boolean;
  /** Strong by cap: maxTroops(Z) at least this multiple of ours. */
  webKeepCapRatio: number;
  /** Strong by troops: troops(Z) at least this multiple of our cap (not
   *  our home, which swings with expansion and strikes: against the home,
   *  nearly every ally was strong in the opening, arena Alps g2). */
  webKeepTroopRatio: number;
  /** No two strong allies' next terms end within this many ticks: the
   *  earlier one is asked sooner, gap before the later one's ask (a passed
   *  extension restarts the term at the nation's yes), but never more than
   *  gap before its own lead. 0: asks at the lead only. */
  webKeepGap: number;
  /** A strong bordering ally whose alliance lapsed gets a fresh request
   *  the first tick we see it gone: decided with our alliances one fewer
   *  and without the extension trap (we are not its friend any more), and
   *  answered before the nation's attacks at its next decision. Sent below
   *  A_max alliances with a forecast of at least webKeepRenewMinP. Needs
   *  webKeepStrong. */
  webKeepRenew: boolean;
  /** Smallest forecast for the webKeepRenew request. A refused request
   *  starts Config.allianceRequestCooldown (300 ticks) for every request
   *  to that nation, the recall's too (PlayerImpl.canSendAllianceRequest),
   *  so the default is recallMinP's 0.8: arena quick@20 Box g25, a renew
   *  at p = 0.67 refused at tick 10,524, the recall of the same nation's
   *  7.5M attack at 10,698 on cooldown; Africa g11, a renew at p = 0.70
   *  accepted at 4,192 whose term lapsed at 7,198 with no renew possible
   *  (p = 0), the nation's attacks from 7,671. */
  webKeepRenewMinP: number;
  /** Renew also when the nation would accept only because we threaten it
   *  (the forecast's branch "threat": our home out-troops it by the
   *  Impossible nation's own test, so it cannot attack us now, and its
   *  lapse is our strike's opening). Off: no renew then. On in the
   *  package's v6 screens: the threat renews of Kazakhstan (Europe g22,
   *  UE struck it 2 ticks after the lapse; −9.4 points at minute 20) and
   *  Tunica (Mississippi g10, −9.9) cost UE's strikes. */
  webKeepRenewThreat: boolean;
  /** Gold for the friendship of a strong bordering ally whose asked
   *  extension would still be refused (forecast below webKeepGiftMinP; the
   *  strength tests or the extension trap, not treachery): webKeepGiftLead
   *  ticks before its expiry, gold that keeps it Friendly until 60 ticks
   *  past the expiry (B2's webFriendGold without the midgame web; Friendly
   *  is accepted 67% of the time at each decision, before those tests). One
   *  gift a term, while its relation is Neutral. Needs webKeepStrong. */
  webKeepGift: boolean;
  /** Ticks before the expiry from which the webKeepGift is given. */
  webKeepGiftLead: number;
  /** Most of our gold one webKeepGift may take. */
  webKeepGiftShare: number;
  /** Give only while the extension forecast is below this. */
  webKeepGiftMinP: number;
  /** No webKeepRenew request and no webKeepGift for a strong ally that
   *  could betray us at our cap: its betrayal line (DiplomacyController
   *  keepBetrayalLine; the Hard and Impossible nation breaks its alliance
   *  with its juiciest bordering ally while that ally's troops and attacks,
   *  with those of its other bordering players, are under 0.33 of its own,
   *  or with its only bordering player while three times that player's
   *  troops are under its own [PIN Betrayal]) at its next decision, or at
   *  the end of the term the request or gift buys (Config.allianceDuration
   *  on, its troops regrown to its cap: NationModel.troopsAt), is at least
   *  this share of our cap. A kept giant ends the alliance itself at the
   *  first decision that finds our home under the line (arena quick@20 v7:
   *  Thailand at 16.1M against our 2.53M cap, 1,111 ticks after its second
   *  gift; Antarctica at 6.5x our cap, 862 ticks after its third; Hellsö at
   *  its 2.8x cap, 780 ticks after its gift). 0: no guard. */
  webKeepBetrayShare: number;

  // ── Defense (§3.3) ───────────────────────────────────────────────────
  /** Recall an incoming nation attack by alliance (§3.3.2). E8. */
  recall: boolean;
  /** Smallest forecast acceptance probability for a recall. E8. */
  recallMinP: number;
  /** Embargo stops: the recall's pre-request stop (§3.3.2) and embargo
   *  hygiene (§3.3.4). Off: recall requests go without a stop (the N3
   *  negative control). */
  embargoStop: boolean;
  /** Free TN cancel when incoming nation troops exceed home − H_vw
   *  (§3.3.3). */
  cancelTnOnThreat: boolean;
  /** Counter-attack a nation whose fresh land attack we absorb (no
   *  alliance possible) when its estimated take is at least counterShare of
   *  our tiles and home sits at counterNearCap of the cap or more. The
   *  counter is smaller than its attack (counterMargin of it), so it is
   *  deleted at init and skips the −100 relation hit [PIN AttackMerge], but
   *  cancels that much of the invasion 1:1; home stays at or above H. Not
   *  in the spec (§3.3.5 rules counter-attacks out of M2). Off until A/B'd
   *  (ungated it halved Bering's land). */
  counter: boolean;
  /** Smallest estimated take, as a share of our tiles, worth a counter. */
  counterShare: number;
  /** Smallest home, as a share of the cap, for a counter (troops idle at
   *  the cap). */
  counterNearCap: number;
  /** Counter troops as a share of the attack's troops. */
  counterMargin: number;
  /** Soft deterrence floor (§5.1.2). M3, off. */
  softFloor: boolean;
  /** Defense search over {absorb, recall, cancel TN, counter} (§5.1.7). M3,
   *  off. E18. */
  defenseSearch: boolean;

  // ── Package B1: survival (HomeTarget, DefenseController,
  //    lib/Deterrence.ts; spec §5.1 items 2-4, chapter 13 §2.6-2.9 and
  //    §5.7-5.9). Every behaviour here is off by default. ─────────────────
  /** Deterrence floor: raise H (the tribe, boat and strike floor) to the
   *  land line (T_N(d) + 1)/1.1·detMargin of every bordering unallied
   *  nation that could land-attack us at the floor we would keep without
   *  it and whose strategy list would pick us (NationModel.canLandAttackUs,
   *  wouldTargetUs at its next decision d), and to detBetrayShare·T_A(d)
   *  for every bordering ally at or above its reserve. Lines above
   *  detMaxShare of the cap are dropped (we could not hold them without
   *  freezing). The TN floor stays max(H_vw, tnKeep·H): free land may
   *  spend down to tnKeep of the line (HomeTarget.ts). Not adopted
   *  (package B1 A/B, quick@20 0:32 from a frozen snapshot, with
   *  detCapLines and detHold 300): progress −0.003 [−0.006, −0.001], 2
   *  better and 8 worse of 32; eliminated 6 → 7 (1 discordant game, sign
   *  test p = 1); ≥ top nation at minute 3 50% → 41%. Its cost is growth:
   *  in the expansion phase the lines of bordering nations are above our
   *  home, so it stops tribe attacks (Middle East: a floor of 0.5-1.3M
   *  from tick 737, 21-31k tiles against 44-101k, eliminated at 2582
   *  against 8751). And most invasions that kill come from nations whose
   *  line T/1.1 is above our cap, which no floor can hold. */
  deterrence: boolean;
  /** Margin on the land line (T_N(d) + 1)/1.1. */
  detMargin: number;
  /** A line above this share of our cap is dropped (or capped, below). */
  detMaxShare: number;
  /** Hold a line above detMaxShare·cap at detMaxShare·cap instead of
   *  dropping it: dropping sets free for spending the home that the
   *  strongest neighbour is about to hit (arena quick Onion: H jumped
   *  between 0.3 and 0.62 of the cap as Outer Enclave's line crossed 0.8). */
  detCapLines: boolean;
  /** Betrayal guard: H ≥ this·T_A for bordering allies at or above their
   *  reserve (NationAllianceBehavior.ts:404-491 betrays under 1/3); 0 turns
   *  the guard off. */
  detBetrayShare: number;
  /** Keep a nation's land line only if wouldTargetUs names us at the probe
   *  home (a nation whose list picks another player first is no threat
   *  that decision). */
  detTargetCheck: boolean;
  /** With detTargetCheck, a nation with at most this many affordable tribes
   *  keeps its line anyway (it runs out of tribes before home regrows). */
  detTribeSlack: number;
  /** Ticks a nation's land line is held after it was last computed, at
   *  the highest value computed meanwhile (0: off). A nation's own attack
   *  or a tribe it turns to drops its line for a few decisions, and the
   *  spending that frees brings home down as it regrows (arena quick
   *  Onion: 5 drops to 0 in 1,000 ticks, each followed by tribe attacks). */
  detHold: number;
  /** Counter an invasion when the counter wins: send an unallied nation
   *  ceil(S·detCounterSize) + 1 troops, S the total of its attacks on us
   *  (retreating and landed boats included), which deletes them all at our
   *  attack's init (AttackExecution.ts:157-170) and keeps our tiles, when
   *  home minus that stays at or above max(detCounterKeep·cap, H_vw) and
   *  (detCounterNoUnlock) exposes us to no other nation. Never while a
   *  recall to it is pending. Harmful in the A/B (package B1, quick@20:
   *  3 of 6 games eliminated): a nation sending T − ceil(0.9·H) keeps 0.9·H
   *  after it, so each counter makes its next send 0.9 of the last while
   *  our home sinks, and the lower home turns other nations on us
   *  (juicy). Keep off. */
  detCounter: boolean;
  /** Counter size as a multiple of their total stack; below 1 the counter
   *  is deleted after cancelling that much and skips the −100 relation
   *  hit (a lost counter: chapter 13 §2.3). */
  detCounterSize: number;
  /** Home kept after a counter, as a share of the cap. */
  detCounterKeep: number;
  /** Live (not retreating) stacks under this share of our home are
   *  absorbed, not countered. */
  detCounterMin: number;
  /** No counter that exposes us to another nation (lib/Deterrence.
   *  unlockedBy): one that cannot land-attack us at our home but could at
   *  home minus the counter, or a bordering ally whose betrayal line
   *  detBetrayShare·T the counter crosses. */
  detCounterNoUnlock: boolean;
  /** Counter only when it is decisive: with home minus the counter, the
   *  nation cannot land-attack us at its next decision
   *  (NationModel.canLandAttackUs on its troops after its send). A send
   *  capped by troopSendCap never passes this (its troops left are about
   *  0.9·H); one sized T − reserve·M leaves it at its reserve and does. */
  detCounterDecisive: boolean;
  /** Defense posts (×5 attacker losses, ×3 time within 30 tiles,
   *  Config.ts:377-387) on the front with a bordering unallied nation that
   *  our home now cannot deter (detPostProactive), or that attacks us by
   *  land (detPostReactive): one per 20 ticks while gold pays for it. Not
   *  adopted (package B1 A/B, quick@20 0:32, 31 valid pairs: final land
   *  +0.5 pp, 15 better and 8 worse, but eliminated 5 → 8, discordant 1
   *  against 4, sign test p = 0.375): posts ordered on a front under
   *  attack are destroyed before or soon after they are built (a conquered
   *  post is deleted, PlayerExecution.ts:72-74; arena quick Europe: 12
   *  ordered, at most 4 standing). */
  detPosts: boolean;
  /** Build posts before an attack, against an undeterred threat. */
  detPostProactive: boolean;
  /** Build posts against a running land attack (it overruns a post before
   *  its 50 ticks of construction end, and the post is deleted with the
   *  tile: arena smoke Onion lost 20 posts so). */
  detPostReactive: boolean;
  /** Proactive posts only against a nation whose list would pick us now
   *  (wouldTargetUs, or at most detTribeSlack affordable tribes left) or
   *  that attacked us in the last 600 ticks; off, against every nation
   *  that could land-attack us. */
  detPostTargetCheck: boolean;
  /** Proactive posts only against a nation whose potential land send at
   *  us, min(T − reserve·M, troopSendCap), is at least this share of our
   *  home (a nation under attack passes canLandAttackUs with a send the
   *  size of its incoming: arena quick Japan spent 1.1M on posts against
   *  Tohoku, 0.7M troops against our 3.1M). */
  detPostMinThreat: number;
  /** Proactive posts test the nations against our home (after an inbound
   *  bomb, the cap it leaves) less this share: a post is up before a
   *  regrowing nation crosses the land line. */
  detPostLead: number;
  /** A post must cover at least this many uncovered front tiles. */
  detPostMinCover: number;
  /** A post must cover at least this share of the front with its nation
   *  (0: any): on a long front a post covers too little to matter (arena
   *  quick The Box: one post covered 97 of Front Manager's 1,577 front
   *  tiles; Alps and Passage: 8-15% each). */
  detPostMinShare: number;
  /** Most defense posts ordered in a game. */
  detPostsMax: number;
  /** Tiles a post goes behind the front. */
  detPostDepth: number;

  // ── Economy (§3.8) ───────────────────────────────────────────────────
  /** Cities from loot. E5. */
  cities: boolean;
  /** Upgrade a deep finished city before building a new one. E5. */
  cityUpgradeFirst: boolean;
  /** Smallest distance of a city site from our border, in tiles. */
  cityMinDepth: number;
  /** Ticks between economy checks. */
  cityEvery: number;
  /** Most levels one city is upgraded to (0: no cap). An atom bomb deletes
   *  every unit within its outer radius whatever its level
   *  (NukeExecution.ts:464-483) [PIN NukeThreat], and nations aim at the
   *  city with the most levels, so stacked levels were lost 5-9 at a time
   *  before minute 4 (arena quick@4 and showcase). */
  cityMaxLevel: number;
  /** New cities go more than twice the atom's outer radius
   *  (config.nukeMagnitudes) from our other cities when such a site
   *  exists, so one bomb takes one city. */
  citySpread: boolean;
  /** When structures may be built. E12. "exposure" (the §3.9 table's
   *  default; §4 step 5 had "free" until NukeModel exists): no new city or
   *  level while a nation could nuke the site (exposedSite). Measured
   *  against "free" (both with cityMaxLevel and citySpread): quick@4
   *  −0.001 [−0.004, 0.000] (idle gold, up to 5.5M at minute 4), but at
   *  10-12 minutes on smoke and showcase final land 1.106 against 0.982
   *  summed over 10 maps (Onion 37.3% with 2 bombs against 23.6% with 5). */
  structurePolicy: StructurePolicy;
  /** exposedSite also counts a nation with gold for a silo and an atom bomb
   *  (config.unitInfo), or a silo under construction: nations built the
   *  silo and fired within one 100-tick window (Hokkaido, Rosedale). */
  exposureWide: boolean;
  /** While an enemy atom or hydrogen bomb is in flight to within its outer
   *  radius of one of our cities, the allocator spends as in stall mode
   *  (headroom off): the troops above the cap left after the blast are cut
   *  the tick after it lands [PIN TroopCapClamp]. */
  nukeReflex: boolean;
  /** Delete the most exposed captured structure (§5.1.6). M3, off. E12. */
  deleteCaptured: boolean;

  // ── Strike (§3.5, §5.2) ──────────────────────────────────────────────
  /** Strike windows in use (§5.2.2). M4; [] = none. E13. */
  strikeWindows: StrikeWindow[];
  /** Fork go/no-go check before a big strike (§5.2.4). Off for reproducible
   *  A/B runs. E13. */
  strikeFork: boolean;
  /** Steer Friendly allies at our target (§5.2.6). M4, off. E14. */
  steering: boolean;
  /** Share of spare gold that steering may donate. E14. */
  steerGoldShare: number;
  /** Hydrogen bomb plus W1 on the largest army (§5.2.7). M4, off. E15. */
  bombs: boolean;

  // ── Package A1 STRIKES: window strikes on bordering nations (§5.2,
  //    StrikeController.windowStrikes, lib/StrikeWindows.ts) ───────────
  /** Window strikes: launch at a bordering unallied nation one tick after
   *  its decision when a window below is open and the purse pays for the
   *  conquest stack; top it up before each of its decisions. Off. A/B on
   *  quick 0:12 at 20 min (package A1 ab1): progress +0.027 [+0.015,
   *  +0.040], 9 better / 1 worse, final land 4.3% -> 9.8%. */
  strikes: boolean;
  /** W1: below reserve·cap at its next decision (never answers). */
  strikeW1: boolean;
  /** W2: its next decision is locked (free land, structure tribe). */
  strikeW2: boolean;
  /** W3: below trigger·cap there (answers about 1 decision in 10). */
  strikeW3: boolean;
  /** W5 vulture: hit hard by others (also a score bonus). */
  strikeW5: boolean;
  /** W6 decoy: another attack on it is larger than ours will be. */
  strikeW6: boolean;
  /** Overwhelm: our stack beats any answer, T − reserve·M. */
  strikeOverwhelm: boolean;
  /** Troop ratio (defender / stack) the stack is sized for after the
   *  answer: 0.6 is the cheapest per tile [PIN PlayerAttackSpeed]. */
  strikeRatio: number;
  /** Margin on that stack (regrowth, drift until the first top-up). */
  strikeMargin: number;
  /** Worst ratio after the answer that a purse-limited stack may start at
   *  (1: never fewer troops than it keeps). */
  strikeMaxRatio: number;
  /** Most strikes running at once. */
  strikeMaxActive: number;
  /** Launch only in stall mode (idle troops at the cap); top-ups always. */
  strikeStallOnly: boolean;
  /** Keep home above the land deterrence line of every other unallied
   *  bordering nation that can attack (troopsAt/1.1) and 0.34× each
   *  bordering ally's troops (the betrayal line). */
  strikeDeterrence: boolean;
  /** Never strike a nation with a finished silo and the gold for an atom
   *  bomb while we own a city (it nukes the largest attacker first). */
  strikeNukeVeto: boolean;
  /** Smallest expected value per troop spent: tiles (all of them and its
   *  gold on a kill, where only the tiles' losses and the answer are
   *  spent) per troop. */
  strikeMinValue: number;
  /** Gold worth one tile in that value. */
  strikeGoldPerTile: number;
  /** Defense posts: the share of the front within range of the target's
   *  finished posts costs ×5 a tile in the value and kill cost, the value
   *  reads the loss at the stack's real ratio after the answer, and no
   *  top-up goes into a front posted at strikePostCover short of a kill.
   *  Nations post the front of any land attack above 35% of their troops.
   *  Off: v1 (the loss at the sizing ratio, posts ignored). Tested only
   *  with strikeRetreat (A1 ab2: no gain over v1). */
  strikePosts: boolean;
  /** Share of the front under posts that stops top-ups (strikePosts) and
   *  calls a strike back (strikeRetreat). */
  strikePostCover: number;
  /** One tick after the target's decision, call back (cancel_attack) a
   *  strike that can no longer kill when posts cover strikePostCover of the
   *  front or the target holds strikeRetreatRatio× our stack: the retreat
   *  ends before its next decision, 75% comes home. Off: A1 ab2 cut long
   *  strikes that were still buying land (The Box: v1 took 124k tiles in
   *  one 622-tick strike) and lost survival (out < 20 min 17% -> 33%). */
  strikeRetreat: boolean;
  /** Target troops over our live stack at which a strike is called back. */
  strikeRetreatRatio: number;
  /** Ticks ahead at which strikeDeterrence reads third nations' troops
   *  (their regrowth while our home refills); 0 = their next decision.
   *  150 left World without a single strike (A1 ab2). */
  strikeDetHorizon: number;
  /** Smallest contact (adjacency pairs) with a nation for a launch; 0 =
   *  any. 8 skips fronts of a tile or two, where a strike takes a tile and
   *  only makes the nation Hostile (A1 ab3: ArchipelagoSea final land
   *  1.6% -> 4.2%; same progress as v1 over 12 games). */
  strikeMinContact: number;
  /** strikeDeterrence also covers the nations that border the target
   *  (its nearby() nations): a conquest makes them ours while home is down
   *  by the stack. Unallied ones at their land line unless below their
   *  reserve at their decision, allies at the betrayal line. Review of A1
   *  (quick@20 g3: Alaska, Russia's neighbour, land-attacked 1.87M 70
   *  ticks after a 3.05M strike on Russia with the floor at 0). Use it with
   *  strikeDetNearReach: all of them blocked the strikes that kept apex
   *  alive (A1 round 2 ab4, quick 0:12: Alps budget 2443k -> 759k, no
   *  strike, 6 nation attacks and 0.5% land against 0 and 4.5%). */
  strikeDetNearTarget: boolean;
  /** With strikeDetNearTarget, only the target's neighbours next to the
   *  land the stack can reach: a walk from our border through the target
   *  (reachableTiles), as deep as the budget before their lines pays for
   *  (at most REACH_CAP tiles), at launch and at each top-up. A1 round 2
   *  ab6 (quick 0:12, with strikeLiveCheck, against the same strikes
   *  without): Bering Strait delays the Russia strike until Alaska's line
   *  allows it (survival 14.2 -> 19.2 min, peak 30.5% -> 47.1%). */
  strikeDetNearReach: boolean;
  /** A top-up that only saves the stack from an answer that would delete
   *  it goes only where the answer is certain (gate open; below trigger the
   *  list runs 1 decision in 10) and the saved stack keeps strikeMaxRatio
   *  or can kill. Review of A1: 8 of 42 top-ups (3.19M) were such saves,
   *  all below trigger, leaving stacks at ratio 1.8-20. Off: no gain in
   *  A1 round 2 (ab5 against ab6, quick 0:12: 2 better, 1 worse). */
  strikeSaveOpenOnly: boolean;
  /** The value and kill test read the loss per tile at the stack's real
   *  ratio after the answer (strikePosts did, without posts), and only the
   *  target's land reachable from our border (a capped BFS): a pocket that
   *  runs out first is a partial win whose rest comes home, a kill needs
   *  all of it reachable. A kill or a pocket is valued at the answer
   *  expected (1 decision in 10 below the trigger), the stack still sized
   *  for it. Review of A1: 22 strikes predicted a kill, 3 killed; 29 of 42
   *  ended with the frontier emptied. The reach it predicts is exact
   *  (World: 3790 and 674 predicted, 3790 and 674 taken), but off: under
   *  strikeMinValue it drops pocket strikes whose worth is not their land
   *  (A1 round 2 ab6: Onion, the W5 pocket at 2309 skipped, eliminated at
   *  6537 against 37.2% land). */
  strikeReachModel: boolean;
  /** Launch only while our land touches the target in at least
   *  max(1, strikeMinContact) pairs now (the scan may be thinkEvery − 1
   *  ticks old) and no alliance request to it is queued this tick (the
   *  DefenseController's recall runs first). Review of A1: quick@20 g17
   *  6730, 724k sent at Hellsö next to a recall, 0 tiles. */
  strikeLiveCheck: boolean;

  // ── Package WP7b R1 FLOOR: the replica strike floor (docs/14-m4-plan.md
  //    §2.7 item 7b; StrikeController.deterrenceFloor and replicaLine,
  //    ported from the flow-wt5 prototype, flow.md §5-6). A base rule: the
  //    search's rollouts copy it ────────────────────────────────────────
  /** strikeDeterrence's line for each unallied bordering nation whose land
   *  line is above strikeFlowFloor·cap, and whose last full NationModel
   *  refresh saw it on our border, is the lowest home in
   *  [strikeFlowFloor·cap, its land line] at which NationModel's replica
   *  says it cannot land-attack us at its next decision or its strategy
   *  list picks another player first (canLandAttackUs, wouldTargetUs;
   *  bisection in 8 steps). So the floor is never above A1's. Off. The
   *  prototype (flow R1: this with strikeFloorReplicaUnseen and
   *  strikeFlowFloorMin), quick@20 32 pairs against UE: 63 launches against
   *  45 at 40 troops a tile against 44, land at minute 15 +1.8 points
   *  [−0.2, +4.0], 4 eliminated against 4. */
  strikeFloorReplica: boolean;
  /** With strikeFloorReplica: the replica's lowest home, as a share of our
   *  cap (regrowth there is 98% of its peak). */
  strikeFlowFloor: number;
  /** With strikeFloorReplica, read through the replica the nations its
   *  last full refresh did not see on our border too, as the prototype did:
   *  the target's neighbours (strikeDetNearTarget), and bordering nations
   *  whose border with us is newer than that refresh (up to a decision
   *  interval old). The replica's canLandAttackUs needs that border, so
   *  their lines drop to strikeFlowFloor·cap and A1's near-target floor is
   *  gone. Prototype, quick@20 Bering Strait g3: the strike on Russia at
   *  5330 went with Alaska, Russia's neighbour, at 1577k instead of its land
   *  line 2485k; at 5374 Alaska bordered us but its refresh did not know;
   *  it land-attacked 1.87M at 5401. Off: those keep their land lines. */
  strikeFloorReplicaUnseen: boolean;
  /** With strikeFloorReplica, the floor itself is at least
   *  strikeFlowFloor·cap, as the prototype's was: it binds only where every
   *  line is lower (the purse keeps homeX·cap anyway), and there it only
   *  shrinks or stops strikes. In the prototype it stopped or cut the
   *  first strike of three of its four named losses (quick@20 Mississippi
   *  River g10 at 4538, Europe g22 at 3596, North America g31 at 4254).
   *  Off: only the replica lines are bounded by it. */
  strikeFlowFloorMin: boolean;
  /** With strikeFloorReplica, keep the land line of a nation whose "another
   *  player first" may rest on a state that ends before its decision
   *  (StrikeController.transientExit): the largest attack on it but ours is
   *  a remnant under 5% of its troops (the replica's retaliate step), or it
   *  has 1 affordable tribe left (its bots step). quick@20 Bering Strait g3
   *  at 5471: a 1k remnant of Russia's attack on Alaska ended at 5488, and
   *  Alaska land-attacked us at its decision at 5504. Off. */
  strikeFloorReplicaSteady: boolean;
  /** With strikeFloorReplica (review of WP7b, F1, F2, F5): keep a nation's
   *  land line unless its replica line rests on its own choice of another
   *  player that the strike leaves alone (StrikeController.firmExit). The
   *  replica reads one decision, but a lowered home stays low for several,
   *  and most of its exits rest on something that ends within one or two:
   *  a send cap bound by a third nation's troops (they drop when it
   *  launches), an attack on the nation (its retaliation cancels it), its
   *  tribes (it attacks all of them at once), a victim (it dies), our
   *  target (the strike takes it), or a player it can reach only by boat
   *  (the replica sizes that send as a land attack). R1 screen, quick@20:
   *  of 13 lowered launches, 4 of the 9 resting on another nation's state
   *  were followed by that nation's attack on us within 34-139 ticks (The
   *  Box g9 3361 and 5300, Alps g2 8447, Bering Strait g3 5471). A
   *  preference that passes this guard can still turn within a decision
   *  or two (strikeFloorReplicaRegrow). Implies strikeFloorReplicaSteady's
   *  guard. Off. */
  strikeFloorReplicaFirm: boolean;
  /** With strikeFloorReplica (review of WP7b, F4): the floor is at least
   *  min(A1's floor, the troops at its next decision of every unallied
   *  nation that does not border us but can boat us: within 150 tiles,
   *  water counted, and both on an ocean shore; StrikeController.boatLine).
   *  A nation's random boat skips a player with more troops than its own
   *  and never sends under 20% of our home, so A1's floor, which ignores
   *  boats, kept them out only while it held our home above their troops.
   *  R1 screen, quick@20 Europe g6 at 11227: home 4.35M to 1.65M, and
   *  Kazakhstan (2.69M, no land border with us) landed 446k at 11252.
   *  Off. */
  strikeFloorReplicaBoats: boolean;
  /** With strikeFloorReplica: trust the replica for a nation's next
   *  decision d only. A lowered line is at least the home from which ours
   *  regrows, spending nothing, to the nation's land line at its decision
   *  after d by then (StrikeController.regrowLine), so from that decision
   *  on A1's land line holds again. A preference is a knife edge: the
   *  replica line is where the nation's pick turns to us, and its regrowth
   *  moves that point up. quick@20 The Box g9, R1 with Firm and Boats: at
   *  7213 Evan The Dev's line was 1988k (juicy on Box Fighter) against its
   *  land line 6364k and our cap 5022k; by 7283 it was 2419k, above our
   *  home 2367k, and Evan attacked with 3.44M at 7300. Off. */
  strikeFloorReplicaRegrow: boolean;

  // ── Package B3 NUKES AND SAMs (H8; spec §2.9, §5.1 item 5; chapter 13
  //    §2.11, §5.10; lib/NukeModel.ts, EconomyController) ──────────────
  /** Master flag; off, every option of this block is ignored and the
   *  structure policy reads exposedSite alone. On (with structurePolicy
   *  "exposure"), the nuke-rule replica (NukeModel) lists the threats: the
   *  nations whose nuke ladder names us (now, latent, remembered, or by the
   *  rank guard), with a silo and (nearly) the gold for their bomb. A city
   *  or an upgrade then also needs a tile no threat can aim at (both rings
   *  clear, no SAM of ours reaching the aim point), and the SAM hub
   *  (samHub) may build a SAM whose covered ring takes cities exposedSite
   *  would refuse. Arena quick@20 and showcase-m2: 16 of the 19 bombs at
   *  apex came from the land leader aiming at us as its runner-up, each
   *  taking the city it was aimed at. */
  nukeModel: boolean;
  /** The model alone decides where cities go (package B3 ab1, "v1"): off,
   *  a site outside a SAM hub's covered ring also needs exposedSite's
   *  consent. v1 spent the idle gold (1.2M -> 0.5M on average) with no
   *  gain: quick 0:12 at 20 min Δprogress -0.004 [-0.011, +0.001],
   *  eliminated 5 against 3 (more structure levels make us the juiciest
   *  target, NationUtils.findJuiciestTarget). */
  nukeCities: boolean;
  /** Latent exposures count: the ladder names us below the rung that
   *  answers now (its bombs go elsewhere until that rung clears). */
  nukeLatent: boolean;
  /** A nation whose gold is short of its perceived atom price still counts
   *  from this share of it. */
  nukePayShare: number;
  /** While we hold rank 1 or 2 in land among humans and nations, an
   *  unfriendly nation with a silo in their top 3 counts as exposed through
   *  the crown rung: the runner-up flip came with no warning (quick@20
   *  Mississippi: Rosedale aimed at us 21 ticks before its first bomb, silo
   *  and gold ready). */
  nukeRankGuard: boolean;
  /** Ticks a nation whose ladder named us keeps counting (latent) after it
   *  stops: the land ranking flips back and forth. 0 = none. */
  nukeMemory: number;
  /** Ticks ahead at which nukePayShare reads a threat's gold, at its recent
   *  rate of gain (NukeModel.projectedGold). ab2: Alaska crossed from under
   *  2.5M to 6M in about 300 ticks and a hydrogen bomb took the hub cities
   *  built in between. 0 = gold now. */
  nukeHorizon: number;
  /** SAM hub: while threatened by atoms only, one SAM farther than an
   *  atom's outer radius from every structure of ours, then cities in its
   *  covered ring (atom outer < d ≤ samRange − atom outer): aimed atoms
   *  there are interceptable, and the salvo a SAM draws (NNB
   *  maybeDestroyEnemySam) spares them. Skipped while a threat has, or
   *  nearly has (nukePayShare), the gold for a hydrogen bomb: it outranges
   *  SAMs below level 5, scores them 100k a level, and one took a whole hub
   *  in ab1 (Bering Strait). */
  samHub: boolean;
  /** Most SAMs we own at once. */
  samMax: number;
  /** A SAM is built only if it covers at least this many finished city
   *  levels, or our gold also pays the next city level (a hub to fill). */
  samMinLevels: number;
  /** No SAM while a shooter could salvo it at once: ready slots and real
   *  gold for the salvo (2 atoms, 1 while it is under construction and
   *  nothing else of ours is nukeable). */
  samSlotGate: boolean;
  /** The SAM's lifetime (B3 review, round 2): no SAM while a threat,
   *  latent ones included, has the gold for the salvo line
   *  (NukeModel.salvoLine: a 1M silo level per missing launch slot plus
   *  the salvo's atoms) or nukePayShare of its perceived hydrogen price,
   *  read this many ticks ahead (NukeModel.projectedGold; 0 = its gold
   *  now), or fired a salvo at our SAMs within nukeMemory ticks; hubDoom
   *  repeats the test at every city check.
   *  conf1 g39: a latent Alaska took 2 silo upgrades and salvoed the hub
   *  600 ticks after the order. No projection foresaw it (Alaska attacked
   *  no one at the order and had gained nothing for 300 ticks; then it ate
   *  31 tribes): in a shadow run over the 9 games round 1 changed, 300 or
   *  600 ticks refused none of the SAMs that 0 allows except one that
   *  helped (dev216, at 600): 0. -1 = round 1's gate only (samSlotGate). */
  samHorizon: number;
  /** The hub's upkeep: once a SAM stands, the samHorizon test at every
   *  city check (against its interceptors) dooms the hub for nukeMemory
   *  ticks: no more levels in its ring, and our SAMs exempt no site from
   *  exposedSite. */
  hubDoom: boolean;
  /** Build a SAM again while a nation that salvoed ours within nukeMemory
   *  ticks is still a threat (off: dev216, two SAMs rebuilt under the
   *  shooter covered nothing). */
  samRebuild: boolean;

  // ── Endgame (§5.3) ───────────────────────────────────────────────────
  /** The 38% MIRV gate (§5.3.2). M5, off. E16. */
  mirvGate: boolean;

  // ── Scheduler (§2.6, §3.10) ──────────────────────────────────────────
  /** Intents per second kept for Prio.Emergency and Prio.Recall. */
  reservePerSecond: number;
  /** Intents per minute kept for Prio.Emergency and Prio.Recall. */
  reservePerMinute: number;
  /** Intents per minute by class. An override is merged into these, so
   *  {"classCapsPerMinute":{"tn":20}} changes only tn. */
  classCapsPerMinute: Partial<Record<IntentClass, number>>;

  // ── Lookahead (§2.8) ─────────────────────────────────────────────────
  /** Fork budget outside the spawn search, in ms per 10 s of game time
   *  (roadmap §11.4). */
  forkMsPer10s: number;

  // ── Search (docs/14-m4-plan.md §2.9; each package appends its own
  // sub-block) ───────────────────────────────────────────────────────────
  // Package WP1, the hook: exact rollout copies (ApexPolicy.forRolloutWith)
  // and the directive (setDirective) are always built; they act only when
  // a LiveSearch plays a plan.
  /** The live search (WP2's SearchController, a LiveSearch given to the
   *  policy by ApexAgent): off, the policy never forks for a search. On
   *  without a LiveSearch, the policy throws at its first tick. */
  search: boolean;

  // Package WP2, the SearchController (controllers/SearchController.ts,
  // lib/search/; docs/14-m4-plan.md §2.3-2.6): from searchFrom on, at the
  // triggers (or on a clock), fork the live game, roll the base and each
  // candidate plan forward with an exact copy of the live policy, and play
  // the plan whose value beats the base's by the margin. Off until an A/B
  // adopts it; a search blocks its live tick for seconds to minutes, so it
  // stays arena-only until it is time-sliced (M7). The defaults are the
  // plan's S1 (§2.9, §3 WP2); the act3 prototype (S0) is them with
  // {"searchClock":600,"searchR":0,"searchHBreak":[1200],
  // "searchHBreakGated":0,"searchHStrong":600,"searchStackGate":false,
  // "searchOnTop":false,"searchLapseLead":498,"searchLapseFoeAt":1,
  // "searchShare":false,"searchOutBoats":false,"searchCheckAll":true}.
  /** "act": play the chosen plan. "plans": roll out and log, never act
   *  (package WP4's log-only study). */
  searchMode: string;
  /** First live tick a search may run at. */
  searchFrom: number;
  /** 0: search at the triggers T1-T7 (lib/search/Triggers.ts). N > 0:
   *  every N ticks from searchFrom, triggers off (act3's clock), and a
   *  search runs even when no plan exists (its base feeds the checks). */
  searchClock: number;
  /** Candidate kinds, a comma list of strike, lapse, keep, break, ally,
   *  boat (keep and boat: package WP3's generators). */
  searchKinds: string;
  /** Nations given strike, lapse or break candidates, by contact. */
  searchK: number;
  /** The plan's "on top" (§2.4): every expiring ally's lapse and every
   *  attacker's strikes come on top of the searchK nations (the lapses and
   *  the alliance requests first). Off (act3): a lapse counts 1 of searchK
   *  (an expiring ally with a lapse and breaks counts 2), and the nations
   *  past the first searchK get nothing. */
  searchOnTop: boolean;
  /** Contact pairs for a nation to count as bordering. */
  searchMinContact: number;
  /** Purse shares of the strikes and breaks (purse.available("strike") at
   *  the send). */
  searchFracs: number[];
  /** Order the strikes by the stack gate: a stack below the target's
   *  troops plus its attacks on us (minimumStack(T, answer, inc, 1)) goes
   *  after every other plan, so the cut to searchMaxCands drops it first. */
  searchStackGate: boolean;
  /** Most candidates besides the base (round 1). */
  searchMaxCands: number;
  /** Round 1's horizon (ticks after the fork). */
  searchH1: number;
  /** Round 1 drops a plan more than this share below the base's tiles. */
  searchPrune: number;
  /** A plan is judged this many ticks after its last send ... */
  searchH: number;
  /** ... or this many when its target holds at least searchStrongShare of
   *  our home troops at the send (= searchH: off). */
  searchHStrong: number;
  /** The strong target's troops as a share of our home troops. */
  searchStrongShare: number;
  /** The break round's steps (ticks after the fork): a break goes on to
   *  the next step only while it leads the base by the margin; it is
   *  judged at the last. */
  searchHBreak: number[];
  /** A break still leading at its last step goes on to this horizon when
   *  the danger gate fires (an early alliance end in our traitor window,
   *  or an undeterrable unallied neighbour the base world does not face);
   *  0 = off. */
  searchHBreakGated: number;
  /** When the gate fires and the budget cannot pay the gated look: drop
   *  the break (a veto). Off: judge it at its last step, as without the
   *  gate (package WP4's probes: the gated look never changed a choice). */
  searchGateVeto: boolean;
  /** Round 2's finalists (non-break plans). */
  searchKeepFinalists: number;
  /** Act only if V beats the base's by max(searchMargin·tiles,
   *  searchMarginAbs) ... */
  searchMargin: number;
  /** ... in tiles (V's unit). */
  searchMarginAbs: number;
  /** Drop a plan whose tiles fall more than this share below the base's
   *  at a common checkpoint. */
  searchDip: number;
  /** Value V = tiles + β·(home + out)/c̄ − α·inc/c̄: c̄ (troops per
   *  tile) ... */
  searchCbar: number;
  /** ... β, the weight of our home and outgoing troops ... */
  searchBeta: number;
  /** ... and α, of the nation attacks' troops on us. */
  searchAlpha: number;
  /** λ_now: the weight of the danger now at the horizon (package WP4
   *  fits it; nonzero needs its DangerModel) ... */
  searchDangerNow: number;
  /** ... λ_cap: of the danger with both sides at their caps. */
  searchDangerCap: number;
  /** κ: a plan loses κ·(the top nation's tiles − the base's) at its
   *  horizon. */
  searchRival: number;
  /** The share factor L0/Lh (land net of fallout) on V's tiles (§2.5; 1
   *  unless fallout changes the win bar's land). */
  searchShare: boolean;
  /** V's out counts our transport ships' troops at sea too (act3: attacks
   *  only); so do the checkpoints. */
  searchOutBoats: boolean;
  /** The budget: Σ search cost ≤ searchR·(t − searchFrom) + searchSlack
   *  live-tick equivalents (φ per fork from lib/search/phi.json, plus the
   *  ticks advanced); 0 = no cap. */
  searchR: number;
  /** The budget's grant at searchFrom: the first search's whole break look
   *  and its gated extension. */
  searchSlack: number;
  /** Live-tick equivalents a low-priority search (the stall re-searches,
   *  T6, every T7 but the first) may not spend: kept for the alliance
   *  ends, chains, attacks, foresight and stall onsets. */
  searchReserve: number;
  /** T1: a bordering ally expiring within this many ticks (and before the
   *  web asks its extension); a lapse candidate needs as few left (498:
   *  act3's, whose lapse struck within its first 600 ticks less 100). */
  searchLapseLead: number;
  /** A lapse's foe mark starts this many ticks after the search (act3's
   *  port: 1, the plan's "now": 0). */
  searchLapseFoeAt: number;
  /** T2: a search this many ticks after an act. */
  searchChain: number;
  /** T3: every this many ticks in stall. */
  searchStallEvery: number;
  /** T7: at least one search this often. */
  searchFloorTicks: number;
  /** T4: a nation attack on us of at least this share of our home troops. */
  searchAttackMin: number;
  /** Least ticks between two tries at the triggers (T1 is exempt; T4 and
   *  T5 count from the last search that ran). */
  searchMinGap: number;
  /** A break's foe-mark variant: no re-alliance with the broken ally for
   *  900 ticks (the web re-allies broken nations). */
  searchBreakFoe: boolean;
  /** Check the live game against every snap of the rollout it follows (as
   *  act3 did), not only the plan's +50, +150, +300, +600 and the judged
   *  horizon (§2.2): about twice the search-check lines. */
  searchCheckAll: boolean;

  // Package WP3, the candidate generators (lib/search/cands/keep.ts,
  // defend.ts, boat.ts, rank.ts; docs/14-m4-plan.md §2.4, §2.5 round 2b,
  // §3 WP3), registered in lib/search/Registry.ts. Each is off until an
  // A/B adopts it; with all of them off the search is WP2's exactly.
  /** keep:Z (keep.ts): at an alliance end (a bordering ally expiring
   *  within searchLapseLead ticks), ask its extension at the expiry −
   *  extendLead and, if the alliance lapses anyway, a fresh alliance
   *  request the tick after the expiry. For strong allies (see
   *  searchKeepMinShare) whose extension the web has not asked yet
   *  (s.web.extensionAsked); the search decides which of them to keep. */
  searchKeep: boolean;
  /** An ally is strong for keep plans when its troops are at least this
   *  share of our home troops, or its cap at least 1.1 × ours (no home
   *  deters it once the alliance ends); 0: every bordering ally. */
  searchKeepMinShare: number;
  /** keep:Z+gift (with searchKeep or searchDefend): the keep plan with a
   *  gold gift first, worth DiplomacyController.friendPoints: it holds the
   *  ally Friendly (then it accepts 67% of the time at each decision) to 60
   *  ticks past the expiry. Made for a strong ally, kept by the web or
   *  not, whose extension forecast is below searchKeepGiftP. */
  searchKeepGift: boolean;
  /** keep:Z+gift only while the NationModel's extension forecast is below
   *  this. */
  searchKeepGiftP: number;
  /** The most of our gold a keep gift may take. */
  searchKeepGiftShare: number;
  /** Round 2b (defend.ts; §2.5): when the base rollout, by its longest
   *  horizon, shows a nation attacking us (or a loss of over 10% of our
   *  tiles), plans for each attacker, judged at that horizon: keep:N (and
   *  keep:N+gift) for an ally at the search, ally:N:2b (clear its foe mark,
   *  stop our embargo on it, then ask the alliance now) for the others. */
  searchDefend: boolean;
  /** boat:N:f (boat.ts): while no nation borders us, send share f
   *  (searchFracs) of purse.available("strike") by boat to the shore tile
   *  of a nation across water nearest our coast on the voyage field, the
   *  route and landing clear of hostile warships; trigger T6 asks it. */
  searchBoat: boolean;
  /** The longest voyage (tiles, on the voyage field) a boat plan takes. */
  searchBoatMaxVoyage: number;
  /** rank.ts: the prior that picks the searchK nations given strike and
   *  break plans: "contact" (as WP2's core: by contact), "prey" (the
   *  predator's kill cost per tile, lowest first), "yield" (A1's
   *  strikeYield per troop of the strike purse, highest first), "killsim"
   *  (a 600-tick conquest simulation's tiles per troop, highest first). */
  searchRank: string;

  // Package WP10n NUKES: our own MIRV and bomb candidates for the search,
  // and the MIRV-threat trigger T8 (lib/search/cands/nuke.ts,
  // lib/search/Triggers.ts; docs/14-m4-plan.md §2.4, §2.8 item 3;
  // docs/13-mechanics.md §2.13-2.16, §5.12). WP9 found every lost lead fell
  // to an ally or rival that out-capped us, through the nation MIRV rule, a
  // two-players-left bomb, or a betrayal. Off by default; when on it adds
  // the kinds mirv, hydro, atom and silo to the search and fires T8 when a
  // silo owner is about to be able to MIRV us. The rollout judges whether a
  // plan denies the MIRV and whether the base policy then takes the land.
  /** The master switch: our MIRV/bomb candidates and T8. Off: byte-identical
   *  to search without them. */
  searchNukes: boolean;
  /** mirv:N — our MIRV at the most dangerous nation (breaks the alliance,
   *  cripples it, raises everyone's next MIRV by 15M). */
  searchNukeMirv: boolean;
  /** hydro:N / atom:N — a salvo at a nation's finished silos to remove its
   *  MIRV (MIRV denial). */
  searchNukeDeny: boolean;
  /** mirvx — an alliance-preserving price-denial MIRV at the nearest tribe
   *  tile: it breaks no alliance and makes us no traitor, but raises every
   *  nation's next MIRV by 15M (review F7). */
  searchNukeMirvDeny: boolean;
  /** silo+launch — when we own no silo, build one and launch a MIRV/bomb at
   *  the silo-ready tick (the combined candidate). The pure-cost standalone
   *  silo candidate was removed in review F5. */
  searchNukeSilo: boolean;
  /** Most nations given a denial salvo (mirv:N is always just the single
   *  most dangerous one). */
  searchNukeK: number;
  /** A nation is a MIRV threat when its gold ≥ the MIRV price − this many
   *  ticks of its income (T8 and the denial targets: "the gold approaches
   *  the price soon"); one minute at 10 ticks/second. */
  searchNukeLead: number;
  /** T8's magnet gate: we are a MIRV target when we hold at least this
   *  share of all land tiles (fallout counted, the 40% nation rule's
   *  denominator). */
  searchNukeLandShare: number;
  /** T8's magnet gate: or we are within this many City levels of the
   *  city-leader MIRV rung (> 8 levels and 1.15× the runner-up). */
  searchNukeCityLead: number;
  /** A rival counts as a mirv:N target (out-caps us) when its cap is at
   *  least this many times ours. */
  searchNukeCapRatio: number;
  /** Cap on bombs in one denial candidate (its steps' amounts summed),
   *  besides our ready-slot and gold limits. */
  searchNukeMaxBombs: number;
  /** Ticks after building a silo before the combined silo+launch candidate
   *  fires its MIRV/bomb (a new silo is ready at intent + 102; OwnNukes). */
  searchNukeSiloReady: number;
  /** Ticks between the follow-up attack waves a MIRV plan schedules on the
   *  crippled nation, one per searchFracs share (review F1). */
  searchNukeStrikeGap: number;
  /** The window (ticks) the NukeWatch measures a nation's income over, for
   *  T8's ticks-to-price lead and the generator's target choice (review
   *  F2). */
  searchNukeWindow: number;

  // Package SLICE, the time-sliced search (controllers/SearchController.ts,
  // lib/search/Slicer.ts, lib/search/Rounds.ts roundsSteps; docs/14-m4-plan.md
  // §2.6 "Browser"): a search spreads its rollouts over the live ticks after
  // its trigger and acts when its rounds finish. The slice decides only WHEN
  // the work happens: the rollouts are forks of the trigger's tick, judged
  // and priced (live-tick equivalents, the degrade order) as an unsliced
  // search. Off by default: the arena's clock is game time and its runs
  // replay; the browser autopilot (docs/10-agent-interface.md §10.5) sets
  // searchSliceMs so its worker's tick stays short.
  /** > 0: at most this many ms of wall time (performance.now, in the
   *  agent's thread) of search work per live tick; the search acts at the
   *  tick its rounds finish (the log's k=). 0: a search runs whole in its
   *  tick, blocking it for seconds to minutes. */
  searchSliceMs: number;
  /** A sliced search still running this many ticks after its trigger is
   *  given up (logged `skipped=slice`; what it spent is charged). */
  searchSliceMaxTicks: number;
  /** A plan chosen k > 0 ticks after its search is re-based to the tick it
   *  is adopted (its steps' ticks and foe marks shift by k) unless its
   *  target died, changed alliance state with us or began attacking us
   *  since, or its first step's `when` no longer holds (dropped, logged
   *  `dropped=`). Off: such a plan is dropped (`dropped=stale`). */
  searchSliceRebase: boolean;

  // Package WP8 GOLD, the leader's economy (docs/14-m4-plan.md §2.8 items
  // 1-2; lib/GoldPolicy.ts, EconomyController.planCity): when idle gold
  // buys City levels. Pinned by tests/agent/mechanics/NukeStructures: an
  // Impossible nation aims atom and hydrogen bombs only at our structures
  // (a lone SAM draws a salvo), and never at an ally.
  /** The gold arm: from goldFrom on, when the structure policy (or
   *  nukeModel) above refuses every site, the arm may still buy, under its
   *  gate; it only adds buys. "exposure": today's rule alone. "model": no
   *  level at a site that a nation answering us can aim at (NukeModel: its
   *  ladder names us on the rung that answers now, a silo, the gold for its
   *  bomb now or soon by nukePayShare/nukeHorizon; or a bomb of its in
   *  flight at us). "allied": no level while a silo owner holding the
   *  atom's price is not our ally (allies never aim at us; our finished
   *  SAMs exempt the sites they cover; an alliance ending within extendLead
   *  ticks no longer counts). "free": no nuke gate. Every arm: no level an
   *  enemy bomb in flight will hit, no buy at all while one flies at our
   *  land or while the attacks on us carry our home troops, no new city
   *  within a salvo's reach of our SAMs. The SAM hub (nukeModel) still runs
   *  first. quick@20 without search (package WP8 round 2, 32 games): land
   *  at minute 20 +2.0 points ("model") and +1.7 ("free"), both carried by
   *  Yellow Sea g28 (+48); progress +0.001, few-nation maps -0.06, City
   *  levels lost to bombs +30-40%: not adopted. */
  goldPolicy: GoldPolicyArm;
  /** First tick of the gold arm: minute 4 (the opening's cities stay
   *  today's). */
  goldFrom: number;
  /** Gold the arm keeps back: one SAM's price, and more than a web gift
   *  costs in the midgame (webFriendGold, offered before the economy
   *  decides). */
  goldReserve: number;
  /** The arm never crosses the MIRV steamroll line (NationMIRVBehavior:
   *  more than 8 City levels and 1.15x the runner-up's) or the richest
   *  nation's dense-target line (more than 1/75 structure levels a tile,
   *  at least 5). */
  goldGuard: boolean;
  /** While a hydrogen threat names us (a silo owner whose nuke ladder
   *  names us, latent included, with nukePayShare of its perceived
   *  hydrogen price, or one fired within nukeMemory ticks), the arm's buys
   *  keep the City levels one hydrogen bomb can take (our cities within
   *  twice its outer radius of each other) at most this many; 0 = off.
   *  quick@20 Mississippi ("free" without it): one hydrogen bomb took 15
   *  levels of cities 64 tiles apart. */
  goldHydroCap: number;

  // Package WP10b LEADER GUARD, base rules for the leader phase
  // (docs/14-m4-plan.md §2.8; lib/LeaderGuard.ts, LeaderHook.ts, called by
  // HomeTarget.homeFloors and EconomyController.decide). Pinned by
  // tests/agent/mechanics/Betrayal and NationMirvTargeting. Off by default.
  /** Leader guard: every tribe, boat, free-land and strike send keeps home
   *  at the betrayal line of each bordering allied nation, at its next
   *  decision (NationAllianceBehavior.maybeBetray: rule (a) home + our
   *  attacks + its other bordering players' troops < 0.33 of its troops,
   *  rule (c) the only neighbour under a third, rule (b) a traitor under
   *  1.2x); lines above leaderMaxShare of our cap are left out and, with
   *  leaderCap, buy City levels. Also reads the MIRV lines (40% of the
   *  land, the City-level leader) and who could MIRV us when, for the log
   *  and s.leader. */
  leaderGuard: boolean;
  /** Multiplies the ally's troops in every line (1: the nation's edge). */
  leaderMargin: number;
  /** Share of the ally's own attack troops counted in its troops (an
   *  attack that ends brings its survivors home). */
  leaderAllyOut: number;
  /** Share of our attack troops credited to rule (a) in the home floor
   *  (0: home alone holds the line; attacks lose troops as they go). */
  leaderOurOut: number;
  /** A line above this share of our cap is not held (holding it would
   *  freeze every send); with leaderCap it buys cap instead. */
  leaderMaxShare: number;
  /** Leave out an ally that sends at free land (or at a tribe holding
   *  structures) at its next decision (NationModel.gates "locked"). */
  leaderGates: boolean;
  /** With leaderGuard: when today's City rule refuses every site and a
   *  line is above leaderMaxShare of our cap, the gold arm's gate buys
   *  City levels up to the cap that holds it, within the MIRV city-leader
   *  and dense-target lines (goldGuard). */
  leaderCap: boolean;
  /** leaderCap's arm: "free" instead of "model" (lib/GoldPolicy). */
  leaderCapFree: boolean;
  /** Ticks of gold history behind each silo owner's net gold rate (the
   *  MIRV danger's time to its price). */
  leaderGoldWindow: number;
}

function deepFreeze<T>(o: T): T {
  if (typeof o === "object" && o !== null) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** The resolved defaults, frozen: parseApexOptions copies them. */
export const APEX_DEFAULTS: Readonly<ApexOptions> = deepFreeze({
  thinkEvery: 3,
  nationRefreshPerTick: 4,
  refreshBeforeDecision: true,
  planEvery: 50,

  spawnMode: "race",
  spawnDelay: 3,
  spawnCellTarget: 150_000,
  spawnK0: 64,
  spawnBeta: 0.25,
  spawnMarginTicks: 60,
  spawnTribeDelayTicks: 30,
  spawnThreatLambda: 0.5,
  spawnSnackBonus: 52,
  spawnGrowth: [52, 3000, 10000, 22000, 40000, 90000],
  spawnIdleTicks: 900,
  spawnRolloutK: 4,
  spawnRound1: 900,
  spawnKeep: 2,
  spawnFinal: 1800,
  spawnWallBudgetMs: 120_000,

  // Package A3 SPAWN PREVIEW.
  spawnPreview: true,
  spawnErase: true,
  spawnEraseMargin: -0.25,
  spawnEraseK: 4,
  spawnEraseMinLeft: 2,
  spawnPreviewEarly: false,

  homeX: 0.3,
  vwGuard: 0.17,
  tnKeep: 0.5,
  foodMargin: 1.05,
  detCap: 0.5,

  expansion: true,
  defense: true,
  diplomacy: true,
  strike: true,
  economy: true,
  endgame: true,

  tn: true,
  tnSat: 1.2,
  tnHorizon: 20,
  tnMinChunk: 0.3,
  tnPace: false,

  snacks: true,
  snackSafety: 2,
  snackMax: 1000,
  topUps: true,
  tribes: true,
  tribeRatio: 0.6,
  tribeMargin: 1.1,
  tribeBurnWindow: 20,
  tribeTopUpAt: 0.95,
  tribeTopUpEvery: 10,
  tribeMaxPrice: 1.5,
  maxTribeLaunches: 4,
  maxTribeAttacks: 40,
  lambdaGold: 0.5,
  contest: true,
  contestBonus: 1.5,
  buffer: true,
  bufferPenalty: 0.4,
  snipes: true,
  snipeTiles: 400,
  snipeBonus: 2,
  pokes: true,
  pokeTroops: 300,
  headroom: true,
  headroomSlack: 0.1,

  stall: true,
  stallFrac: 0.85,
  stallTicks: 50,
  stallRatio: 1.0,
  stallTribes: true,
  stallBoats: true,
  stallStrike: false,
  stallStrikeFromHome: true,
  stallDangerHome: true,

  boats: true,
  boatEvery: 20,
  boatProbes: 2,
  boatMinTroops: 8000,
  beachheadExtra: 5000,
  waterMapLand: 0.25,
  boatAvoidWarships: true,
  boatWarshipMargin: 20,
  boatRoutePrecheck: true,
  boatAvoidEatenTribes: true,
  boatEatenRadius: 10,
  boatEatenRatio: 2,
  boatBorderTribes: false,
  boatCancelOnFlip: true,
  boatCancelDead: false,
  boatCancelFar: 200,
  boatVoyageScore: true,
  boatMaxVoyage: 400,
  boatHeadroom: true,
  boatLandmassHold: 100,
  boatPocket: true,

  // Package A2 NAVAL MIDGAME.
  boatsMidgame: false,
  boatMidRouteGuard: false,
  boatMidFar: false,
  boatMidMaxVoyage: 1500,
  boatMidMinFood: 1500,
  boatMidRateTicks: 300,
  boatMidRateMargin: 2,
  boatMidFront: 0.8,
  boatMidNationBoat: 150,
  boatMidHold: 100,
  boatMidSurplus: 0.15,
  boatMidStallPrice: 3,

  web: true,
  webRank: "danger",
  foodList: true,
  allySlotsReserve: 0,
  allyDangerMin: 0.8,
  allyReachCells: null,
  allyMinP: 0.25,
  allyPerSecond: 4,
  counterAccept: true,
  extensions: true,
  extendLead: 300,
  allyOracle: false,

  // Package B2 (diplomacy through the midgame).
  webMidgame: false,
  webFrom: 1800,
  webDangerMin: 0.5,
  webSlotsMax: false,
  webExtendLead: 600,
  webExtendStable: 150,
  webBoatReach: true,
  webBoatDiscount: 0.75,
  webRenew: true,
  webRenewMinP: 0.25,
  webRenewOver: true,
  webLapseTarget: true,
  webKeepBonus: 1.3,
  webPeakKeep: 0.9,
  webKeepFeasible: true,
  webSlotSpare: 0,
  webFriend: false,
  webFriendGold: true,
  webFriendGoldShare: 0.9,
  webFriendLead: 120,
  webFriendMinDanger: 1,
  webFriendMinP: 0.5,
  webFriendHome: 0.8,
  webDiag: false,

  // Package WP7a WEB KEEP.
  webKeepStrong: false,
  webKeepAsk: false,
  webKeepCapRatio: 1.1,
  webKeepTroopRatio: 1,
  webKeepGap: 600,
  webKeepRenew: true,
  webKeepRenewMinP: 0.8,
  webKeepRenewThreat: false,
  webKeepGift: true,
  webKeepGiftLead: 120,
  webKeepGiftShare: 0.9,
  webKeepGiftMinP: 0.5,
  webKeepBetrayShare: 1,

  recall: true,
  recallMinP: 0.8,
  embargoStop: true,
  cancelTnOnThreat: true,
  counter: false,
  counterShare: 0.2,
  counterNearCap: 0.9,
  counterMargin: 0.8,
  softFloor: false,
  defenseSearch: false,

  // Package B1 (survival: deterrence floor, betrayal guard, counters,
  // defense posts). Every behaviour off.
  deterrence: false,
  detMargin: 1.05,
  detMaxShare: 0.8,
  detCapLines: false,
  detBetrayShare: 0.34,
  detTargetCheck: true,
  detTribeSlack: 1,
  detHold: 0,
  detCounter: false,
  detCounterSize: 1.02,
  detCounterKeep: 0.3,
  detCounterMin: 0.05,
  detCounterNoUnlock: true,
  detCounterDecisive: false,
  detPosts: false,
  detPostProactive: true,
  detPostReactive: false,
  detPostTargetCheck: true,
  detPostMinThreat: 0.15,
  detPostLead: 0.1,
  detPostMinCover: 8,
  detPostMinShare: 0,
  detPostsMax: 12,
  detPostDepth: 15,

  cities: true,
  cityUpgradeFirst: true,
  cityMinDepth: 12,
  cityEvery: 30,
  cityMaxLevel: 3,
  citySpread: true,
  structurePolicy: "exposure",
  exposureWide: true,
  nukeReflex: true,
  deleteCaptured: false,

  strikeWindows: [],
  strikeFork: false,
  steering: false,
  steerGoldShare: 0.3,
  bombs: false,

  // Package A1 STRIKES.
  strikes: true,
  strikeW1: true,
  strikeW2: true,
  strikeW3: true,
  strikeW5: true,
  strikeW6: true,
  strikeOverwhelm: true,
  strikeRatio: 0.6,
  strikeMargin: 1.1,
  strikeMaxRatio: 1,
  strikeMaxActive: 2,
  strikeStallOnly: true,
  strikeDeterrence: true,
  strikeNukeVeto: true,
  strikeMinValue: 1 / 60,
  strikeGoldPerTile: 200,
  strikePosts: false,
  strikePostCover: 0.5,
  strikeRetreat: false,
  strikeRetreatRatio: 1.5,
  strikeDetHorizon: 0,
  strikeMinContact: 8,
  strikeDetNearTarget: true,
  strikeDetNearReach: true,
  strikeSaveOpenOnly: false,
  strikeReachModel: false,
  strikeLiveCheck: true,

  // Package WP7b R1 FLOOR.
  strikeFloorReplica: false,
  strikeFlowFloor: 0.35,
  strikeFloorReplicaUnseen: false,
  strikeFlowFloorMin: false,
  strikeFloorReplicaSteady: false,
  strikeFloorReplicaFirm: false,
  strikeFloorReplicaBoats: false,
  strikeFloorReplicaRegrow: false,

  // Package B3 NUKES AND SAMs.
  nukeModel: false,
  nukeCities: false,
  nukeLatent: true,
  nukePayShare: 0.5,
  nukeRankGuard: true,
  nukeMemory: 600,
  nukeHorizon: 300,
  samHub: true,
  samMax: 1,
  samMinLevels: 3,
  samSlotGate: true,
  samHorizon: 0,
  hubDoom: true,
  samRebuild: false,

  mirvGate: false,

  reservePerSecond: 2,
  reservePerMinute: 15,
  classCapsPerMinute: {
    tn: 30,
    tribe: 45,
    topup: 30,
    snack: 10,
    boat: 9,
    diplomacy: 30,
    build: 6,
    strike: 10,
  },

  forkMsPer10s: 1000,

  // Search: package WP1 (the hook).
  search: false,

  // Search: package WP2, the SearchController (the plan's S1: the
  // triggers, the budget, the stepwise break round and its gate, the
  // strong-target horizon, the stack gate, plans on top of searchK).
  searchMode: "act",
  searchFrom: 2400,
  searchClock: 0,
  searchKinds: "strike,lapse,keep,break,ally,boat",
  searchK: 2,
  searchOnTop: true,
  searchMinContact: 8,
  searchFracs: [0.5, 1],
  searchStackGate: true,
  searchMaxCands: 8,
  searchH1: 150,
  searchPrune: 0.03,
  searchH: 600,
  searchHStrong: 1200,
  searchStrongShare: 0.9,
  searchHBreak: [600, 1200],
  searchHBreakGated: 1800,
  searchGateVeto: false,
  searchKeepFinalists: 2,
  searchMargin: 0.01,
  searchMarginAbs: 300,
  searchDip: 0.2,
  searchCbar: 150,
  searchBeta: 0.5,
  searchAlpha: 0.5,
  searchDangerNow: 0,
  searchDangerCap: 0,
  searchRival: 0,
  searchShare: true,
  searchOutBoats: true,
  searchR: 2.5,
  searchSlack: 4500,
  searchReserve: 2500,
  searchLapseLead: 500,
  searchLapseFoeAt: 0,
  searchChain: 600,
  searchStallEvery: 1200,
  searchFloorTicks: 1800,
  searchAttackMin: 0.1,
  searchMinGap: 300,
  searchBreakFoe: false,
  searchCheckAll: false,

  // Package WP3, the candidate generators (off).
  searchKeep: false,
  searchKeepMinShare: 0.9,
  searchKeepGift: true,
  searchKeepGiftP: 0.5,
  searchKeepGiftShare: 0.9,
  searchDefend: false,
  searchBoat: false,
  searchBoatMaxVoyage: 1500,
  searchRank: "contact",

  // Package WP10n NUKES (off).
  searchNukes: false,
  searchNukeMirv: true,
  searchNukeDeny: true,
  searchNukeMirvDeny: true,
  searchNukeSilo: true,
  searchNukeK: 2,
  searchNukeLead: 600,
  searchNukeLandShare: 0.35,
  searchNukeCityLead: 1,
  searchNukeCapRatio: 1.1,
  searchNukeMaxBombs: 8,
  searchNukeSiloReady: 110,
  searchNukeStrikeGap: 20,
  searchNukeWindow: 600,

  // Package SLICE, the time-sliced search (off: the arena replays).
  searchSliceMs: 0,
  searchSliceMaxTicks: 300,
  searchSliceRebase: true,

  // Package WP8 GOLD.
  goldPolicy: "exposure",
  goldFrom: 2400,
  goldReserve: 1_500_000,
  goldGuard: true,
  goldHydroCap: 0,

  // Package WP10b LEADER GUARD (off).
  leaderGuard: false,
  leaderMargin: 1.05,
  leaderAllyOut: 0.5,
  leaderOurOut: 0,
  leaderMaxShare: 0.8,
  leaderGates: true,
  leaderCap: true,
  leaderCapFree: false,
  leaderGoldWindow: 600,
} satisfies ApexOptions);

/**
 * Options of features that are not built yet, with the milestone that
 * builds them (spec §3.9, §5). Any value but the default is refused: the
 * run would play the defaults under the feature's label. Delete a key when
 * its code lands.
 */
export const UNBUILT: Readonly<Partial<Record<keyof ApexOptions, string>>> =
  Object.freeze({
    softFloor: "M3 (spec §5.1.2)",
    allyOracle: "M3 (spec §5.1.7)",
    defenseSearch: "M3 (spec §5.1.7)",
    deleteCaptured: "M3 (spec §5.1.6)",
    strikeWindows: "M4 (spec §5.2.2)",
    strikeFork: "M4 (spec §5.2.4)",
    steering: "M4 (spec §5.2.6)",
    steerGoldShare: "M4 (spec §5.2.6, with steering)",
    bombs: "M4 (spec §5.2.7)",
    mirvGate: "M5 (spec §5.3.2)",
  });

/** The keys of the boolean (enable) options. */
export type BooleanOption = {
  [K in keyof ApexOptions]: ApexOptions[K] extends boolean ? K : never;
}[keyof ApexOptions];

const hasOwn = (o: object, k: string) =>
  Object.prototype.hasOwnProperty.call(o, k);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function oneOf<T extends string>(
  key: string,
  v: unknown,
  allowed: readonly T[],
): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new Error(
      `apex option "${key}" must be one of ${allowed.join(", ")}, got ${JSON.stringify(v)}`,
    );
  }
  return v as T;
}

function finite(key: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(
      `apex option "${key}" must be a finite number, got ${JSON.stringify(v)}`,
    );
  }
  return v;
}

/** Checks one override against its default's type; returns the value to
 *  store (a fresh copy for arrays and objects). */
function checked(key: keyof ApexOptions, v: unknown): unknown {
  switch (key) {
    case "spawnMode":
      return oneOf(key, v, SPAWN_MODES);
    case "structurePolicy":
      return oneOf(key, v, STRUCTURE_POLICIES);
    case "goldPolicy":
      return oneOf(key, v, GOLD_POLICIES);
    case "webRank":
      return oneOf(key, v, WEB_RANKS);
    case "spawnGrowth": {
      const want = APEX_DEFAULTS.spawnGrowth.length;
      if (!Array.isArray(v) || v.length !== want) {
        throw new Error(
          `apex option "spawnGrowth" must be ${want} numbers (tiles at ticks 0, 300, 600, 900, 1200, 1800), got ${JSON.stringify(v)}`,
        );
      }
      return v.map((x) => finite(key, x));
    }
    case "strikeWindows": {
      if (!Array.isArray(v)) {
        throw new Error(
          `apex option "strikeWindows" must be a list of ${STRIKE_WINDOWS.join(", ")}, got ${JSON.stringify(v)}`,
        );
      }
      const windows = v.map((w) => oneOf(key, w, STRIKE_WINDOWS));
      return [...new Set(windows)];
    }
    case "classCapsPerMinute": {
      if (!isRecord(v)) {
        throw new Error(
          `apex option "classCapsPerMinute" must be an object, got ${JSON.stringify(v)}`,
        );
      }
      const caps = { ...APEX_DEFAULTS.classCapsPerMinute };
      for (const [cls, cap] of Object.entries(v)) {
        if (!hasOwn(INTENT_CLASSES, cls)) {
          throw new Error(
            `apex option "classCapsPerMinute" has no class "${cls}" (it has ${Object.keys(INTENT_CLASSES).join(", ")})`,
          );
        }
        caps[cls as IntentClass] = finite(`classCapsPerMinute.${cls}`, cap);
      }
      return caps;
    }
    case "allyReachCells":
      return v === null ? null : finite(key, v);
    default: {
      const want = typeof APEX_DEFAULTS[key];
      if (want === "number") return finite(key, v);
      if (typeof v !== want) {
        throw new Error(
          `apex option "${key}" must be a ${want}, got ${JSON.stringify(v)}`,
        );
      }
      return v;
    }
  }
}

/**
 * The defaults with `given` applied. Refuses unknown keys and values of the
 * wrong type, so a misspelled or mistyped option never runs the defaults
 * under its label.
 */
export function parseApexOptions(given?: Record<string, unknown>): ApexOptions {
  const o = structuredClone(APEX_DEFAULTS) as ApexOptions;
  const out = o as unknown as Record<string, unknown>;
  for (const [key, v] of Object.entries(given ?? {})) {
    if (!hasOwn(APEX_DEFAULTS, key)) {
      throw new Error(
        `apex has no option "${key}" (see src/agent/agents/apex/options.ts)`,
      );
    }
    const k = key as keyof ApexOptions;
    out[key] = checked(k, v);
    const milestone = UNBUILT[k];
    if (
      milestone !== undefined &&
      JSON.stringify(out[key]) !== JSON.stringify(APEX_DEFAULTS[k])
    ) {
      throw new Error(
        `apex option "${key}" is not built until ${milestone}: ` +
          `${JSON.stringify(v)} would play the default ${JSON.stringify(APEX_DEFAULTS[k])}`,
      );
    }
  }
  return o;
}
