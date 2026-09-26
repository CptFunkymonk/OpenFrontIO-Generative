import { RaceFieldOptions } from "../../lib/RaceField";
import { IntentClass, SchedulerOptions } from "../../lib/Scheduler";

// Every option of the apex agent (spec §3.9). Keys are flat, so an arena
// entrant reads `apex:{"homeX":0.25}` and a gallery label `homeX 0.25`.
// Every feature has an enable flag, so an ablation is an A/B of
// `apex:{"<feature>":false}`. Defaults follow the M2 build order (spec §4):
// the features of steps 1-7 are on; rollout spawn (step 8), stall strike
// (step 9) and everything of M3-M5 are off until an experiment adopts them.

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
  /** Full NationModel refreshes (one N.nearby() each) per tick, round-robin
   *  over bordering and reachable nations. Keeps them under 1 ms. */
  nationRefreshPerTick: number;
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
  /** EndgameController (§5.3); a stub until M5, its features have their own
   *  flags. */
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
  /** Soft deterrence floor (§5.1.2). M3, off. */
  softFloor: boolean;
  /** Defense search over {absorb, recall, cancel TN, counter} (§5.1.7). M3,
   *  off. E18. */
  defenseSearch: boolean;

  // ── Economy (§3.8) ───────────────────────────────────────────────────
  /** Cities from loot. E5. */
  cities: boolean;
  /** Upgrade a deep finished city before building a new one. E5. */
  cityUpgradeFirst: boolean;
  /** Smallest distance of a city site from our border, in tiles. */
  cityMinDepth: number;
  /** Ticks between economy checks. */
  cityEvery: number;
  /** When structures may be built. E12. Default "free" per §4 step 5 until
   *  NukeModel exists (M3); the §3.9 table's target default is
   *  "exposure". */
  structurePolicy: StructurePolicy;
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

  boats: true,
  boatEvery: 20,
  boatProbes: 2,
  boatMinTroops: 8000,
  beachheadExtra: 5000,
  waterMapLand: 0.25,

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

  recall: true,
  recallMinP: 0.8,
  embargoStop: true,
  cancelTnOnThreat: true,
  softFloor: false,
  defenseSearch: false,

  cities: true,
  cityUpgradeFirst: true,
  cityMinDepth: 12,
  cityEvery: 30,
  structurePolicy: "free",
  deleteCaptured: false,

  strikeWindows: [],
  strikeFork: false,
  steering: false,
  steerGoldShare: 0.3,
  bombs: false,

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
} satisfies ApexOptions);

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
    out[key] = checked(key as keyof ApexOptions, v);
  }
  return o;
}
