import {
  Difficulty,
  Game,
  GameMode,
  GameType,
  Player,
  PlayerID,
  PlayerType,
  Relation,
  Structures,
  UnitType,
} from "../../core/game/Game";
import { PseudoRandom } from "../../core/PseudoRandom";
import { simpleHash } from "../../core/Util";
import { Models } from "./Models";

// Nation parameters from gameID, gate predicates, alliance forecast and the
// relation tracker (spec §2.4). Nation players can appear after construction
// (nations spawn in tick 2), so everything per nation is computed lazily.
//
// Read-only: only getters. `N.nearby()` and `unitCount()` write memos keyed
// by territory and unit versions (spec §2.1 allows them); nothing else here
// writes to the game. Tests: tests/agent/apex/NationModel.test.ts (each
// predicate against the real code, forked accuracy), Relations.test.ts, and
// the pins AllianceRecallEmbargo (N3), LightningRod (N9), FreeLandLockSend
// (C13), NationParams (N1).
//
// Where this departs from spec §2.4 (the real code wins):
// - troopsAt steps the regrowth exactly instead of a straight line, which
//   undershoots below ~0.42 of the cap.
// - At a decision, a neighbour with a pending alliance request to or from
//   the nation is left out of its send cap (it may be friendly by its
//   maybeAttack); the forked accuracy test caught a missed attack without.
// - gates' "locked" also covers the structure-tribe pre-gate.
// - The inferred fallback keeps reserve 0.30 and trigger 0.50: observed
//   sends bound them only from above, the unsafe side.
//
// Constants that Config does not expose are copied from the code that holds
// them, each with its source line. Formulas the Config exposes (maxTroops,
// troopIncreaseRate, numSpawnPhaseTurns, ...) are always called.

// ── §2.4.1 Parameters ────────────────────────────────────────────────────

export interface AiParams {
  /** Shares of cap. */
  trigger: number;
  reserve: number;
  expand: number;
  /** Decides when tick % rate == phase. */
  rate: number;
  phase: number;
  source: "gameID" | "inferred" | "default";
}

/** NationExecution.getAttackRate (NationExecution.ts:92-107): nextInt's
 *  [min, max) per difficulty. Private there, so copied here; the N1 pin
 *  checks every difficulty against live executions. */
const NATION_RATE: Record<Difficulty, readonly [number, number]> = {
  [Difficulty.Easy]: [65, 100],
  [Difficulty.Medium]: [55, 70],
  [Difficulty.Hard]: [45, 60],
  [Difficulty.Impossible]: [30, 50],
};

/** Replays the first five draws of NationExecution: PseudoRandom(simpleHash(id) +
 *  simpleHash(gameID)); trigger nextInt(50,60)/100, reserve nextInt(30,40)/100,
 *  expand nextInt(10,20)/100 (constructor, NationExecution.ts:72-78), then
 *  rate = difficulty range (Impossible nextInt(30,50), :92-107), phase =
 *  nextInt(0, rate) (:84). Exact (`source: "gameID"`), pinned by
 *  tests/agent/mechanics/NationParams.test.ts (N1). */
export function nationParams(
  gameID: string,
  nationID: PlayerID,
  d: Difficulty,
): AiParams {
  // The constructor's three draws, then init()'s two; nothing else draws
  // from this generator in between (init runs at the end of tick 0).
  const r = new PseudoRandom(simpleHash(nationID) + simpleHash(gameID));
  const trigger = r.nextInt(50, 60) / 100;
  const reserve = r.nextInt(30, 40) / 100;
  const expand = r.nextInt(10, 20) / 100;
  const [lo, hi] = NATION_RATE[d];
  const rate = r.nextInt(lo, hi);
  const phase = r.nextInt(0, rate);
  return { trigger, reserve, expand, rate, phase, source: "gameID" };
}

/** TribeExecution.ts:35-40: PseudoRandom(simpleHash(tribeID)): rate
 *  nextInt(40,80), phase nextInt(0, rate), trigger, reserve, expand. Needs
 *  no gameID. Exact, so `source` is "gameID" (the exact replay) although no
 *  game ID goes in. Pinned by NationParams.test.ts (N1). */
export function tribeParams(tribeID: PlayerID): AiParams {
  const r = new PseudoRandom(simpleHash(tribeID));
  const rate = r.nextInt(40, 80);
  const phase = r.nextInt(0, rate);
  const trigger = r.nextInt(50, 60) / 100;
  const reserve = r.nextInt(30, 40) / 100;
  const expand = r.nextInt(10, 20) / 100;
  return { trigger, reserve, expand, rate, phase, source: "gameID" };
}

/** First tick >= from with tick % rate == phase. */
export function nextDecision(p: AiParams, from: number): number {
  const off = (((p.phase - from) % p.rate) + p.rate) % p.rate;
  return from + off;
}

/** Last tick <= at with tick % rate == phase. */
function prevDecision(p: AiParams, at: number): number {
  const off = (((at - p.phase) % p.rate) + p.rate) % p.rate;
  return at - off;
}

/**
 * Worst case until a nation's parameters are known (spec §2.4.1: "the worst
 * case is assumed"): the lowest reserve and trigger (it can send the most,
 * from the least), the highest expand (its free-land lock holds the least),
 * and a decision on every tick (rate 1).
 */
function defaultParams(d: Difficulty): AiParams {
  void d;
  return {
    trigger: 0.5,
    reserve: 0.3,
    expand: 0.19,
    rate: 1,
    phase: 0,
    source: "default",
  };
}

// ── §2.4.2 State and refresh ─────────────────────────────────────────────

/**
 * Spec §2.4.2 lists more fields (attack sums, silos and SAMs, structure
 * levels, the nearby maxima, the last send, troops 20 ticks ago). No
 * decision read them, and each refresh paid for them (a loop over N.units(),
 * a troop sample per nation every 10 ticks), so they are left out until a
 * reader exists (strike windows W3 and W5, §5.2.2).
 */
export interface NationState {
  id: PlayerID;
  smallID: number;
  params: AiParams;
  /** Home troops. */
  T: number;
  /** Cap. */
  M: number;
  tiles: number;
  gold: bigint;
  alliances: number;
  /** N.nearby().some(n => !n.isPlayer()). */
  bordersFreeLand: boolean;
  /** N.sharesBorderWith(me). */
  sharesBorderWithUs: boolean;
  /** min(T − reserve·M, sendCap) for its bots strategy. */
  tribeBudget: number;
  /** Nearby tribes with 2·D ≤ T − reserve·M and sendCap ≥ 1
   *  (calculateBotAttackTroops :1149-1166). */
  affordableTribes: number;
  refreshedAt: number;
  full: boolean;
}

/**
 * "locked" also covers a decision that its structure pre-gate spends on
 * tribes (attackBestTarget :285-287): either way it attacks no player of
 * ours that decision.
 */
export type Gate = "locked" | "belowReserve" | "belowTrigger" | "open";

/** The Impossible strategy that would pick us (AiAttackBehavior.ts:426-428).
 *  "betray" is not in spec §2.4.2: an ally of ours that breaks the alliance
 *  and attacks (maybeBetray, NationAllianceBehavior.ts:404-462). */
export type TargetReason =
  | "retaliate"
  | "veryWeak"
  | "betray"
  | "assist"
  | "victim"
  | "traitor"
  | "juicy"
  | "hated"
  | "weakest"
  | "island";

// ── §2.4.4 RelationTracker ───────────────────────────────────────────────

/** N's relation **to us**, which the game does not expose (C20). */
export interface RelationTracker {
  /** Estimated value in [−100, 100] at tick t, with decay applied. */
  value(n: PlayerID, t: number): number;
  /** The same, as the band N.relation(me) would report. */
  band(n: PlayerID, t: number): Relation;
  /** Called by NationModel.observe. `tick` is the ctx tick the change is
   *  first visible at (it happened in turn tick − 1). */
  onEvent(n: PlayerID, tick: number, delta: number, cause: RelationCause): void;
  /** Whether N's −20 embargo malus is applied now, and what it will be at d:
   *  the change N's updateRelationsFromEmbargos makes at its decision d
   *  (−20, +20 or 0), given our embargo stop sent at `stoppedBy`. */
  embargoMalus(n: PlayerID): {
    applied: boolean;
    atDecision(d: number, stoppedBy: number | null): number;
  };
  /** Not in spec §2.4.4: records whether we embargo N (read by
   *  embargoMalus). NationModel.observe calls it every tick. */
  noteEmbargo(n: PlayerID, on: boolean): void;
  /** Compares with the real band each full refresh. On mismatch, clamps the
   *  estimate into the band and logs. */
  reconcile(n: PlayerID, real: Relation, t: number): void;
  /** Not in spec §2.4.4: whether N's estimate comes from a reconcile clamp
   *  (the value is only known to lie in the band) rather than from tracked
   *  events. An event clears it. */
  clamped(n: PlayerID): boolean;
  /** Plain data for ApexState (cloneable). */
  toData(): RelationData;
}

export type RelationCause =
  | "ourAttack"
  | "ourBoatLanding"
  | "target"
  | "counterAccept"
  | "embargoMalus"
  | "embargoRestore"
  | "assist"
  | "nuke"
  | "break"
  | "neighbourBreak"
  | "emoji"
  | "donation"
  | "warship";

export interface RelationData {
  /** `clamped` (absent = false): see RelationTracker.clamped. */
  values: Record<PlayerID, { v: number; at: number; clamped?: boolean }>;
  malusApplied: PlayerID[];
  /** Not in spec §2.10: the nations we embargoed at the last observe. */
  embargoed?: PlayerID[];
  /** Not in spec §2.10: reconcile mismatches so far (for logs). */
  mismatches?: number;
}

/** PlayerImpl.decayRelations (PlayerImpl.ts:978-988): 0.05 a tick toward 0,
 *  snapping to 0 below 0.1. Private there. */
const RELATION_DECAY = 0.05;
/** updateRelation clamps to [−100, 100] (PlayerImpl.ts:969-976). */
const RELATION_MIN = -100;
const RELATION_MAX = 100;
/** updateRelationsFromEmbargos (NationExecution.ts:313-333). */
const EMBARGO_MALUS = -20;
/** Band edges of relationFromValue (PlayerImpl.ts:946-958). */
const HOSTILE_BELOW = -50;
const DISTRUSTFUL_BELOW = 0;
const NEUTRAL_BELOW = 50;

/** Causes applied inside the nation's own NationExecution tick, which runs
 *  before its PlayerExecution's decay in the same turn; everything else
 *  comes from executions added later, after the decay. */
const PRE_DECAY: ReadonlySet<RelationCause> = new Set<RelationCause>([
  "embargoMalus",
  "embargoRestore",
  "assist",
  "warship",
]);

function relationBand(v: number): Relation {
  if (v < HOSTILE_BELOW) return Relation.Hostile;
  if (v < DISTRUSTFUL_BELOW) return Relation.Distrustful;
  if (v < NEUTRAL_BELOW) return Relation.Neutral;
  return Relation.Friendly;
}

/** `turns` decays, bit for bit as PlayerImpl.decayRelations. */
function decayed(v: number, turns: number): number {
  for (let i = 0; i < turns && v !== 0; i++) {
    const sign = -1 * Math.sign(v);
    v += sign * RELATION_DECAY;
    if (Math.abs(v) < RELATION_DECAY * 2) v = 0;
  }
  return v;
}

function clampRelation(v: number): number {
  return Math.min(Math.max(v, RELATION_MIN), RELATION_MAX);
}

/** Ticks a reconciled estimate stays inside the real band under decay
 *  alone: longer than a nation's decision interval (30-49 ticks), so the
 *  band holds at its next decision. */
const RECONCILE_HOLD_TICKS = 50;
/** Distance kept from the band edge that decay moves a value towards (plus
 *  decay's snap to 0 below 2·RELATION_DECAY). */
const RECONCILE_MARGIN = (RECONCILE_HOLD_TICKS + 2) * RELATION_DECAY;

/**
 * The value closest to v inside band r, at least RECONCILE_MARGIN inside
 * the edge nearer 0 (the one decay drifts towards). Right at that edge the
 * estimate would leave the band at the next tick: −0.05 decays straight to
 * 0 (|v| < 0.1 snaps to 0), 50 to 49.95, so the reconcile never converged
 * and every refresh logged the same mismatch. The real value is somewhere
 * inside the band and decays at the same rate; a later reconcile corrects
 * the estimate again if the real value leaves first.
 */
function intoBand(v: number, r: Relation): number {
  switch (r) {
    case Relation.Hostile:
      return Math.min(v, HOSTILE_BELOW - RECONCILE_MARGIN);
    case Relation.Distrustful:
      return Math.min(
        Math.max(v, HOSTILE_BELOW),
        DISTRUSTFUL_BELOW - RECONCILE_MARGIN,
      );
    case Relation.Neutral:
      // 0 is Neutral and decay stops there; 50 is approached from above.
      return Math.min(
        Math.max(v, DISTRUSTFUL_BELOW),
        NEUTRAL_BELOW - RELATION_DECAY,
      );
    case Relation.Friendly:
      return Math.max(v, NEUTRAL_BELOW + RECONCILE_MARGIN);
  }
}

interface TrackedValue {
  v: number;
  at: number;
  clamped?: boolean;
}

class Tracker implements RelationTracker {
  private readonly values = new Map<PlayerID, TrackedValue>();
  private readonly malus = new Set<PlayerID>();
  private readonly embargo = new Set<PlayerID>();
  private mismatchCount = 0;

  constructor(d?: RelationData) {
    if (d === undefined) return;
    for (const [id, e] of Object.entries(d.values)) {
      this.values.set(
        id,
        e.clamped === true ? { v: e.v, at: e.at, clamped: true } : { ...e },
      );
    }
    for (const id of d.malusApplied) this.malus.add(id);
    for (const id of d.embargoed ?? []) this.embargo.add(id);
    this.mismatchCount = d.mismatches ?? 0;
  }

  value(n: PlayerID, t: number): number {
    const e = this.values.get(n);
    if (e === undefined) return 0;
    return t > e.at ? decayed(e.v, t - e.at) : e.v;
  }

  band(n: PlayerID, t: number): Relation {
    return relationBand(this.value(n, t));
  }

  onEvent(n: PlayerID, tick: number, delta: number, cause: RelationCause) {
    // The change happened in turn tick − 1: decay up to that turn, then the
    // turn's own decay either after (a pre-decay cause) or before it.
    const e = this.values.get(n) ?? { v: 0, at: tick - 1 };
    let { v, at } = e;
    if (PRE_DECAY.has(cause)) {
      if (at < tick - 1) {
        v = decayed(v, tick - 1 - at);
        at = tick - 1;
      }
      v = clampRelation(v + delta);
      if (at < tick) {
        v = decayed(v, 1);
        at = tick;
      }
    } else {
      if (at < tick) {
        v = decayed(v, tick - at);
        at = tick;
      }
      v = clampRelation(v + delta);
    }
    this.values.set(n, { v, at });
    if (cause === "embargoMalus") this.malus.add(n);
    if (cause === "embargoRestore") this.malus.delete(n);
  }

  embargoMalus(n: PlayerID) {
    const applied = this.malus.has(n);
    const on = this.embargo.has(n);
    return {
      applied,
      atDecision(d: number, stoppedBy: number | null): number {
        // A stop sent at s takes effect in turn s + 1, after the nation's
        // tick, so decisions d >= s + 2 no longer see the embargo (§2.1).
        const embargoAtD = on && !(stoppedBy !== null && d >= stoppedBy + 2);
        if (embargoAtD && !applied) return EMBARGO_MALUS;
        if (!embargoAtD && applied) return -EMBARGO_MALUS;
        return 0;
      },
    };
  }

  noteEmbargo(n: PlayerID, on: boolean): void {
    if (on) this.embargo.add(n);
    else this.embargo.delete(n);
  }

  reconcile(n: PlayerID, real: Relation, t: number): void {
    const v = this.value(n, t);
    if (relationBand(v) === real) return;
    this.mismatchCount++;
    this.values.set(n, { v: intoBand(v, real), at: t, clamped: true });
  }

  clamped(n: PlayerID): boolean {
    return this.values.get(n)?.clamped === true;
  }

  /** Reconcile mismatches so far. */
  mismatches(): number {
    return this.mismatchCount;
  }

  toData(): RelationData {
    const values: RelationData["values"] = {};
    for (const [id, e] of this.values) {
      values[id] =
        e.clamped === true
          ? { v: e.v, at: e.at, clamped: true }
          : { v: e.v, at: e.at };
    }
    return {
      values,
      malusApplied: [...this.malus],
      embargoed: [...this.embargo],
      mismatches: this.mismatchCount,
    };
  }
}

export function relationTracker(d?: RelationData): RelationTracker {
  return new Tracker(d);
}

// ── §2.4.5 Alliance forecast ─────────────────────────────────────────────

export interface AllianceQuery {
  kind: "request" | "extension";
  /** Turn the request is created (= ctx.tick of sending). */
  createdAt: number;
  /** The decision that will answer it. */
  atTick: number;
  /** ctx.tick our embargo stop is sent, if any. */
  embargoStoppedBy: number | null;
  /** Default: now. */
  ourHome?: number;
  /** Default: now. */
  ourOutgoing?: number;
  /** Default 0.1: troop tests evaluated with 10% slack (the nation's troops
   *  count 1 + margin times in every troop comparison). */
  margin?: number;
}

export interface AllianceForecast {
  /** Probability of acceptance at atTick. */
  p: number;
  branch:
    | "spawnPhase"
    | "tooMany"
    | "traitor"
    | "threat"
    | "hostile"
    | "friendly"
    | "enough"
    | "early"
    | "similar"
    | "no";
  /** No random draw of the nation changes the answer (p is 0 or 1). */
  deterministic: boolean;
}

// ── Constants of the nation AI that Config does not expose ──────────────

/** troopSendCap retainFraction (AiAttackBehavior.ts:993-1002). */
const RETAIN: Partial<Record<Difficulty, number>> = {
  [Difficulty.Hard]: 0.75,
  [Difficulty.Impossible]: 0.9,
};
/** isAttackTooWeak (AiAttackBehavior.ts:961-973): < 20% of the target. */
const TOO_WEAK_SHARE = 0.2;

/**
 * Our deterrence line against a nation's land attack, as a divisor: it may
 * send at most T − retain·H (troopSendCap) and never less than 0.2·H
 * (isAttackTooWeak), so with T troops it can land-attack us only while
 * T ≥ (retain + 0.2)·H, and we are safe while H > T / sendCapSafe(d)
 * (1.1 at Impossible, 0.95 at Hard) [PIN NationSendCap]. Infinity at Easy
 * and Medium, where neither rule applies (troopSendCap returns Infinity and
 * isAttackTooWeak is off): no home is safe there.
 */
export function sendCapSafe(d: Difficulty): number {
  const retain = RETAIN[d];
  return retain === undefined ? Infinity : retain + TOO_WEAK_SHARE;
}
/** troopSendCapForExpansion (AiAttackBehavior.ts:1035-1039). */
const EXPANSION_FLOOR_SHARE = 0.05;
/** calculateBotAttackTroops (AiAttackBehavior.ts:1149-1166). */
const BOT_ATTACK_MULT = 4;
const BOT_ATTACK_MIN_MULT = 2;
/** getBotAttackMaxParallelism (AiAttackBehavior.ts:522-538); Medium draws
 *  1 or 2, taken as 2 (the most it can eat). */
const BOT_PARALLEL: Record<Difficulty, number> = {
  [Difficulty.Easy]: 1,
  [Difficulty.Medium]: 2,
  [Difficulty.Hard]: 3,
  [Difficulty.Impossible]: 100,
};
/** Strategy thresholds (AiAttackBehavior.ts: veryWeak :655-667, victim
 *  :636-653, traitor :570-581, juicy :669-674, afk :333-344, hated
 *  :369-378, weakest :388-398). */
const VERY_WEAK_CAP_SHARE = 0.15;
const FFA_STRONGER_GUARD = 1.2;
const VICTIM_INCOMING_SHARE = 0.5;
const JUICY_SHARE = 0.75;
const AFK_GUARD = 3;
const HATED_GUARD = 3;
/** maybeBetray / isSafeToBetray (NationAllianceBehavior.ts:404-491). */
const BETRAY_SAFE_SHARE = 0.33;
const BETRAY_TRAITOR_GUARD = 1.2;
const BETRAY_ONLY_NEIGHBOUR_MULT = 3;
/** Relation deltas (AttackExecution.ts:190-210, per difficulty). */
const ATTACK_RELATION: Record<Difficulty, number> = {
  [Difficulty.Easy]: -60,
  [Difficulty.Medium]: -70,
  [Difficulty.Hard]: -80,
  [Difficulty.Impossible]: -100,
};
/** TargetPlayerExecution.ts:34. */
const TARGET_RELATION = -40;
/** AllianceRequestExecution.ts:55-56. */
const COUNTER_ACCEPT_RELATION = 100;
/** BreakAllianceExecution.ts:46, :55. */
const BREAK_RELATION = -100;
const NEIGHBOUR_BREAK_RELATION = -40;
/** NukeExecution.ts:194. */
const NUKE_RELATION = -100;
/** assistAllies (AiAttackBehavior.ts:561). */
const ASSIST_RELATION = -20;
/** maybeRetaliateWithWarship (NationWarshipBehavior.ts:264-297): a warship
 *  built at a transport of ours bound for its land costs −15 with us (−7.5
 *  for a captured trade ship; we build none). */
const WARSHIP_RELATION = -15;
/** trackIncomingTransportsAndRetaliate (NationWarshipBehavior.ts:219-226):
 *  a transport closer than this (Manhattan) to its landing is let be. */
const WARSHIP_TRACK_MIN = 20;
/** Ticks a nation stays watched after our last transport to its land left:
 *  its retaliation warship appears two turns after its decision to build
 *  (ConstructionExecution, then WarshipExecution.init), by when our boat
 *  may have turned back or landed. */
const WARSHIP_WATCH_TICKS = 5;

/** getAllianceDecision's per-difficulty numbers (NationAllianceBehavior.ts
 *  :119-400). Probabilities are the share of nextInt(0, 100) draws that
 *  pass. */
interface AllianceRules {
  /** isConfused: 1 in n (0: never). */
  confusedOneIn: number;
  traitorAccept: number;
  /** hasTooManyAlliances share (0: no limit). */
  tooManyShare: number;
  friendlyAccept: number;
  /** checkAlreadyEnoughAlliances nextInt(lo, hi) (null: never). */
  enough: readonly [number, number] | null;
  /** The neighbour rule of checkAlreadyEnoughAlliances (Hard, Impossible). */
  enoughNeighbourRule: boolean;
  /** isEarlygame window past numSpawnPhaseTurns, and acceptance. */
  earlyTicks: number;
  earlyAccept: number;
  /** shouldRejectInTeamGame. */
  teamReject: number;
  troopRange: readonly [number, number];
  tileRange: readonly [number, number];
}
const ALLIANCE_RULES: Record<Difficulty, AllianceRules> = {
  [Difficulty.Easy]: {
    confusedOneIn: 10,
    traitorAccept: 0.1,
    tooManyShare: 0,
    friendlyAccept: 1,
    enough: null,
    enoughNeighbourRule: false,
    earlyTicks: 3000,
    earlyAccept: 0.9,
    teamReject: 0.25,
    troopRange: [60, 70],
    tileRange: [70, 80],
  },
  [Difficulty.Medium]: {
    confusedOneIn: 20,
    traitorAccept: 0.1,
    tooManyShare: 0,
    friendlyAccept: 1,
    enough: [4, 6],
    enoughNeighbourRule: false,
    earlyTicks: 1800,
    earlyAccept: 0.7,
    teamReject: 0.5,
    troopRange: [70, 80],
    tileRange: [80, 90],
  },
  [Difficulty.Hard]: {
    confusedOneIn: 40,
    traitorAccept: 0.1,
    tooManyShare: 0.5,
    friendlyAccept: 0.83,
    enough: [3, 5],
    enoughNeighbourRule: true,
    earlyTicks: 1800,
    earlyAccept: 0.5,
    teamReject: 0.75,
    troopRange: [75, 85],
    tileRange: [85, 95],
  },
  [Difficulty.Impossible]: {
    confusedOneIn: 0,
    traitorAccept: 0.1,
    tooManyShare: 0.25,
    friendlyAccept: 0.67,
    enough: [2, 4],
    enoughNeighbourRule: true,
    earlyTicks: 600,
    earlyAccept: 0.3,
    teamReject: 1,
    troopRange: [80, 90],
    tileRange: [90, 100],
  },
};
const DEFAULT_MARGIN = 0.1;

/** Ticks between refreshes of the nation list and the non-bot count. */
const PLAYER_LIST_EVERY = 10;

// ── NationModel ──────────────────────────────────────────────────────────

/** Per-nation memory beyond the public NationState. */
interface Tracked {
  st: NationState;
  /** SmallIDs of N.nearby()'s players (every type), in nearby() order. */
  nearby: number[];
  /** Finished city levels (capAt / regrowthAt). */
  cityLevels: number;
  /** Outgoing attack IDs at the last scan (new ones are sends). */
  attackIDs: Set<string>;
  /** Transport ship IDs at the last scan (for the inferred fallback). */
  boatIDs: Set<number>;
  /** Last processed decision turn (embargo malus). */
  lastDecision: number;
  /** Decision turns seen (land sends and boat launches), for inference. */
  seenDecisions: number[];
  /** Troops at the previous observe (inference only). */
  prevT: number;
  prevM: number;
  /** Smallest share of its cap kept after a free-land send (inference). */
  minExpand: number;
}

/** The bits of a player the target and cap replicas read. */
interface Seat {
  p: Player;
  troops: number;
  isUs: boolean;
}

export class NationModel {
  relations: RelationTracker;
  /** Reconcile mismatches and other surprises (newest last, at most 50). */
  readonly log: string[] = [];

  private readonly byId = new Map<PlayerID, Tracked>();
  private readonly paramsCache = new Map<PlayerID, AiParams>();
  private readonly difficulty: Difficulty;
  private readonly ffa: boolean;
  private readonly team: boolean;
  private readonly singleplayer: boolean;
  private nationList: Player[] = [];
  private nonBotAlive = 0;
  private listAt = Number.NEGATIVE_INFINITY;
  private lastObserve: number | null = null;
  private firstDecision: number | null = null;
  // Our side, as at the previous observe.
  private ourAttackIDs = new Set<string>();
  private allies = new Set<PlayerID>();
  private requestsToUs = new Set<PlayerID>();
  private ourRequests = new Set<PlayerID>();
  private ourTargets = new Set<PlayerID>();
  private ourNukeIDs = new Set<number>();
  /** Set by observeNukes: a nuke of ours launched since the last observe. */
  private nukeLaunched = false;
  /** observeWarships: nations a transport of ours is (or was, within
   *  WARSHIP_WATCH_TICKS) bound for, with their warship ids. */
  private warshipWatch = new Map<
    PlayerID,
    { ids: Set<number>; until: number }
  >();
  private allyExpiry = new Map<PlayerID, number>();
  /** Alliances that ended before expiry since the last observe. */
  private broken: PlayerID[] = [];
  private betrayals = 0;
  /** troopsAt memo: nation -> troops after k regrowth steps from `now`. */
  private readonly troopPath = new Map<
    PlayerID,
    { tick: number; T: number[] }
  >();

  constructor(
    private readonly game: Game,
    private readonly me: Player,
    private readonly gameID: string | null,
    private readonly models: Models,
  ) {
    this.relations = relationTracker();
    const gc = game.config().gameConfig();
    this.difficulty = gc.difficulty;
    this.ffa = gc.gameMode === GameMode.FFA;
    this.team = gc.gameMode === GameMode.Team;
    this.singleplayer = gc.gameType === GameType.Singleplayer;
    this.betrayals = me.betrayals();
  }

  // ── Observation ────────────────────────────────────────────────────────

  /** Every tick, O(nations deciding this tick + new attack IDs): records
   *  sends, decision ticks, relation events (2.4.4). */
  observe(tick: number): void {
    if (tick - this.listAt >= PLAYER_LIST_EVERY) this.refreshPlayerList(tick);
    const first = this.lastObserve === null;
    const last = this.lastObserve ?? tick;
    const infer = this.gameID === null;
    const me = this.me;

    // Pre-decay events of the turns since the last observe: the embargo
    // malus of every nation that decided, judged on our embargo as we last
    // saw it (exact when observes are consecutive: the nation's tick in
    // turn d reads the embargo state at ctx tick d).
    for (const N of this.nationList) {
      const tr = this.track(N);
      const p = this.params(N.id());
      if (infer) this.inferStep(N, tr, tick, first);
      if (first || p.source === "default") continue;
      const d = prevDecision(p, tick - 1);
      if (d < last || d <= tr.lastDecision || d < this.firstDecisionTurn()) {
        continue;
      }
      tr.lastDecision = d;
      const embargo = this.relations.embargoMalus(N.id());
      const delta = embargo.atDecision(d, null);
      if (delta !== 0) {
        this.relations.onEvent(
          N.id(),
          d + 1,
          delta,
          delta < 0 ? "embargoMalus" : "embargoRestore",
        );
      }
      if (!infer) {
        const targets = this.scanSends(N, tr);
        this.observeAssist(N, targets, d);
      }
    }

    // Post-decay events: our own actions and alliances.
    this.observeOurAttacks(tick, first);
    this.observeAlliances(tick, first);
    this.observeTargets(tick, first);
    this.observeNukes(tick, first);
    this.observeWarships(tick);
    this.observeBetrayals(tick);

    // Our embargo state as the next decisions will see it.
    for (const N of this.nationList) {
      this.relations.noteEmbargo(N.id(), me.hasEmbargoAgainst(N));
    }
    this.lastObserve = tick;
  }

  private refreshPlayerList(tick: number): void {
    this.listAt = tick;
    const nations: Player[] = [];
    let nonBot = 0;
    for (const p of this.game.players()) {
      if (p.type() !== PlayerType.Bot) nonBot++;
      if (p.type() === PlayerType.Nation) nations.push(p);
    }
    this.nationList = nations;
    this.nonBotAlive = nonBot;
  }

  /** The targets of N's new outgoing land attacks (created in its decision
   *  turn). */
  private scanSends(N: Player, tr: Tracked): Player[] {
    const ids = new Set<string>();
    const targets: Player[] = [];
    for (const a of N.outgoingAttacks()) {
      ids.add(a.id());
      if (!tr.attackIDs.has(a.id()) && a.sourceTile() === null) {
        const t = a.target();
        if (t.isPlayer()) targets.push(t);
      }
    }
    tr.attackIDs = ids;
    return targets;
  }

  /** An ally of ours that attacks one of our targets costs itself −20 with
   *  us (assistAllies, AiAttackBehavior.ts:540-567), in its own tick. */
  private observeAssist(N: Player, targets: Player[], d: number): void {
    if (targets.length === 0 || this.ourTargets.size === 0) return;
    if (!this.allies.has(N.id())) return;
    if (targets.some((t) => this.ourTargets.has(t.id()))) {
      this.relations.onEvent(N.id(), d + 1, ASSIST_RELATION, "assist");
    }
  }

  private observeOurAttacks(tick: number, first: boolean): void {
    const ids = new Set<string>();
    for (const a of this.me.outgoingAttacks()) {
      ids.add(a.id());
      if (first || this.ourAttackIDs.has(a.id())) continue;
      const t = a.target();
      if (!t.isPlayer() || t.type() !== PlayerType.Nation) continue;
      this.relations.onEvent(
        t.id(),
        tick,
        ATTACK_RELATION[this.difficulty],
        a.sourceTile() === null ? "ourAttack" : "ourBoatLanding",
      );
    }
    this.ourAttackIDs = ids;
  }

  private observeAlliances(tick: number, first: boolean): void {
    const me = this.me;
    const allies = new Set<PlayerID>();
    const expiry = new Map<PlayerID, number>();
    for (const a of me.alliances()) {
      const other = a.other(me);
      allies.add(other.id());
      expiry.set(other.id(), a.expiresAt());
      // A new alliance with a nation whose request to us was pending: we
      // counter-accepted (AllianceRequestExecution.ts:45-63), +100. An
      // accepted request of ours changes no relation (GameImpl.ts:439-473).
      if (
        !first &&
        !this.allies.has(other.id()) &&
        other.type() === PlayerType.Nation &&
        this.requestsToUs.has(other.id())
      ) {
        this.relations.onEvent(
          other.id(),
          tick,
          COUNTER_ACCEPT_RELATION,
          "counterAccept",
        );
      }
    }
    // Alliances gone before their expiry (a break by either side, or a
    // nuke), for observeBetrayals.
    this.broken = [];
    for (const id of this.allies) {
      if (allies.has(id)) continue;
      const at = this.allyExpiry.get(id);
      if (at !== undefined && at > tick - 1) this.broken.push(id);
    }
    this.allies = allies;
    this.allyExpiry = expiry;
    const incoming = new Set<PlayerID>();
    for (const r of me.incomingAllianceRequests()) {
      incoming.add(r.requestor().id());
    }
    this.requestsToUs = incoming;
    const outgoing = new Set<PlayerID>();
    for (const r of me.outgoingAllianceRequests()) {
      outgoing.add(r.recipient().id());
    }
    this.ourRequests = outgoing;
  }

  private observeTargets(tick: number, first: boolean): void {
    const targets = this.me.targets();
    if (targets.length === 0 && this.ourTargets.size === 0) return;
    const now = new Set<PlayerID>();
    for (const t of targets) {
      now.add(t.id());
      if (
        !first &&
        !this.ourTargets.has(t.id()) &&
        t.type() === PlayerType.Nation
      ) {
        this.relations.onEvent(t.id(), tick, TARGET_RELATION, "target");
      }
    }
    this.ourTargets = now;
  }

  /** A nuke of ours angers every player listNukeBreakAlliance names at its
   *  launch (NukeExecution.ts:148-197): −100, unless our request to it was
   *  pending (then the request is rejected instead). Approximated by the
   *  owner of the target tile. */
  private observeNukes(tick: number, first: boolean): void {
    const me = this.me;
    this.nukeLaunched = false;
    if (
      me.unitCount(UnitType.AtomBomb) +
        me.unitCount(UnitType.HydrogenBomb) +
        me.unitCount(UnitType.MIRV) ===
      0
    ) {
      if (this.ourNukeIDs.size > 0) this.ourNukeIDs = new Set();
      return;
    }
    const ids = new Set<number>();
    for (const u of me.units(
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
      UnitType.MIRV,
    )) {
      ids.add(u.id());
      if (first || this.ourNukeIDs.has(u.id())) continue;
      this.nukeLaunched = true;
      const target = u.targetTile();
      if (target === undefined) continue;
      const owner = this.game.owner(target);
      if (!owner.isPlayer() || owner.type() !== PlayerType.Nation) continue;
      if (this.ourRequests.has(owner.id())) continue;
      this.relations.onEvent(owner.id(), tick, NUKE_RELATION, "nuke");
    }
    this.ourNukeIDs = ids;
  }

  /**
   * Warship retaliation (not in spec §2.4.4): a nation that owns the landing
   * tile of a transport of ours (not retreating, WARSHIP_TRACK_MIN or more
   * tiles out, not allied with us) builds a warship at it 80% of the time at
   * Impossible and drops its relation to us by 15, in its own tick
   * (NationWarshipBehavior.ts:188-297). The draw and the no-warship-near
   * test are not visible, the warship is: every new warship of a nation
   * while it is watched counts as one retaliation (a warship it builds for
   * itself then counts too, the pessimistic side). A reconcile corrects a
   * miss.
   */
  private observeWarships(tick: number): void {
    const me = this.me;
    const watch = this.warshipWatch;
    if (me.unitCount(UnitType.TransportShip) > 0) {
      for (const u of me.units(UnitType.TransportShip)) {
        const dst = u.targetTile();
        if (dst === undefined || u.transportShipState().isRetreating) continue;
        const N = this.game.owner(dst);
        if (!N.isPlayer() || N === me || N.type() !== PlayerType.Nation) {
          continue;
        }
        if (me.isAlliedWith(N)) continue;
        if (this.game.manhattanDist(u.tile(), dst) < WARSHIP_TRACK_MIN) {
          continue;
        }
        const w = watch.get(N.id());
        if (w === undefined) {
          const ids = new Set<number>();
          for (const x of N.units(UnitType.Warship)) ids.add(x.id());
          watch.set(N.id(), { ids, until: tick + WARSHIP_WATCH_TICKS });
        } else {
          w.until = tick + WARSHIP_WATCH_TICKS;
        }
      }
    }
    if (watch.size === 0) return;
    for (const [id, w] of watch) {
      const N = this.nation(id);
      if (N === null || !N.isAlive() || tick > w.until) {
        watch.delete(id);
        continue;
      }
      for (const x of N.units(UnitType.Warship)) {
        if (w.ids.has(x.id())) continue;
        w.ids.add(x.id());
        // Built in its tick two turns ago (see WARSHIP_WATCH_TICKS).
        this.relations.onEvent(id, tick - 1, WARSHIP_RELATION, "warship");
        this.log.push(`t${tick}: ${id} built a warship at our transport`);
        this.trimLog();
      }
    }
  }

  /** Our break of an alliance (BreakAllianceExecution.ts:33-59): −100 from
   *  the betrayed, −40 from every player in our nearby() (the betrayed
   *  too, if it borders us). A break by a nuke of ours (NukeExecution.ts:
   *  186-195) costs only its −100, counted by observeNukes. */
  private observeBetrayals(tick: number): void {
    const b = this.me.betrayals();
    if (b === this.betrayals) return;
    this.betrayals = b;
    if (this.nukeLaunched) return;
    for (const id of this.broken) {
      if (this.nation(id)?.type() !== PlayerType.Nation) continue;
      this.relations.onEvent(id, tick, BREAK_RELATION, "break");
    }
    for (const n of this.me.nearby()) {
      if (!n.isPlayer() || n.type() !== PlayerType.Nation) continue;
      this.relations.onEvent(
        n.id(),
        tick,
        NEIGHBOUR_BREAK_RELATION,
        "neighbourBreak",
      );
    }
    this.log.push(`t${tick}: we broke an alliance (${b} betrayals)`);
    this.trimLog();
  }

  // ── Parameters ─────────────────────────────────────────────────────────

  /** sendCapSafe at this game's difficulty. */
  sendCapSafe(): number {
    return sendCapSafe(this.difficulty);
  }

  params(n: PlayerID): AiParams {
    const cached = this.paramsCache.get(n);
    if (cached !== undefined) return cached;
    const p =
      this.gameID !== null
        ? nationParams(this.gameID, n, this.difficulty)
        : defaultParams(this.difficulty);
    this.paramsCache.set(n, p);
    return p;
  }

  /** The first turn a nation can decide in: the one after the turn that
   *  built its behaviours (NationExecution.ts:193-198), which is the first
   *  turn past the spawn phase, or the one after in singleplayer (our spawn
   *  ends the phase after the nations' tick, SpawnExecution.ts:121-128; the
   *  timer of other game types runs before them, GameRunner.ts:171-176). */
  firstDecisionTurn(): number {
    if (this.firstDecision !== null) return this.firstDecision;
    const g = this.game;
    if (g.inSpawnPhase()) return Number.POSITIVE_INFINITY;
    const start = g.ticks() - Math.round(g.elapsedGameSeconds() * 10);
    this.firstDecision = start + (this.singleplayer ? 1 : 0) + 1;
    return this.firstDecision;
  }

  nextDecision(n: PlayerID, from: number): number {
    const p = this.params(n);
    const f = Math.max(from, this.firstDecisionTurn());
    if (!Number.isFinite(f)) return from;
    return nextDecision(p, f);
  }

  // ── Inferred fallback (no gameID), spec §2.4.1 ───────────────────────

  private inferStep(N: Player, tr: Tracked, tick: number, first: boolean) {
    const T = N.troops();
    const M = this.models.cap(N);
    if (!first && this.lastObserve === tick - 1) {
      const d = tick - 1;
      let landSend = false;
      let tnSend = false;
      const ids = new Set<string>();
      for (const a of N.outgoingAttacks()) {
        ids.add(a.id());
        if (tr.attackIDs.has(a.id()) || a.sourceTile() !== null) continue;
        landSend = true;
        if (!a.target().isPlayer()) tnSend = true;
      }
      tr.attackIDs = ids;
      const boats = new Set<number>();
      let launch = false;
      for (const u of N.units(UnitType.TransportShip)) {
        boats.add(u.id());
        if (!tr.boatIDs.has(u.id())) launch = true;
      }
      tr.boatIDs = boats;
      // The forced opening send is not on a decision (N1 pin).
      if ((landSend || launch) && d >= this.firstDecisionTurn()) {
        tr.seenDecisions.push(d);
        if (tr.seenDecisions.length > 12) tr.seenDecisions.shift();
        if (tnSend && tr.prevM > 0) {
          // In turn d its PlayerExecution adds the regrowth of T_before,
          // then the attack's init takes T_before - expand x cap: what is
          // left is expand x cap plus that regrowth. A send the cap limited
          // leaves more, so the minimum only errs high (the safe side).
          const r = this.models.regrowthAt(
            PlayerType.Nation,
            tr.prevT,
            N.numTilesOwned(),
            tr.cityLevels,
          );
          const kept = T - (r >= 0 ? Math.floor(r) : -Math.floor(-r));
          tr.minExpand = Math.min(tr.minExpand, kept / tr.prevM);
        }
        this.inferParams(N.id(), tr);
      }
    } else {
      tr.attackIDs = new Set(N.outgoingAttacks().map((a) => a.id()));
      tr.boatIDs = new Set(N.units(UnitType.TransportShip).map((u) => u.id()));
    }
    tr.prevT = T;
    tr.prevM = M;
  }

  /** Rates in the difficulty's range that divide every gap between seen
   *  decisions; one left fixes rate and phase. Ratios keep the worst case:
   *  reserve 0.30 and trigger 0.50 (observed sends bound them only from
   *  above, which is the unsafe side), expand the smallest seen after a
   *  free-land send (it errs high, the safe side), at most 0.19. */
  private inferParams(n: PlayerID, tr: Tracked): void {
    const [lo, hi] = NATION_RATE[this.difficulty];
    const ds = tr.seenDecisions;
    const prev = this.params(n);
    const expand = Number.isFinite(tr.minExpand)
      ? Math.min(0.19, Math.max(0.1, Math.round(tr.minExpand * 100) / 100))
      : 0.19;
    const next: AiParams = { ...prev, trigger: 0.5, reserve: 0.3, expand };
    if (ds.length >= 2) {
      const cands: number[] = [];
      for (let r = lo; r < hi; r++) {
        if (ds.every((d) => (d - ds[0]) % r === 0)) cands.push(r);
      }
      if (cands.length === 1) {
        next.rate = cands[0];
        next.phase = ds[0] % cands[0];
        next.source = "inferred";
      }
    }
    this.paramsCache.set(n, next);
    tr.st.params = next;
  }

  // ── State and refresh ──────────────────────────────────────────────────

  private track(N: Player): Tracked {
    const id = N.id();
    let tr = this.byId.get(id);
    if (tr === undefined) {
      tr = {
        st: {
          id,
          smallID: N.smallID(),
          params: this.params(id),
          T: N.troops(),
          M: 0,
          tiles: 0,
          gold: 0n,
          alliances: 0,
          bordersFreeLand: false,
          sharesBorderWithUs: false,
          tribeBudget: 0,
          affordableTribes: 0,
          refreshedAt: Number.NEGATIVE_INFINITY,
          full: false,
        },
        nearby: [],
        cityLevels: 0,
        attackIDs: new Set(N.outgoingAttacks().map((a) => a.id())),
        boatIDs: new Set(),
        lastDecision: Number.NEGATIVE_INFINITY,
        seenDecisions: [],
        prevT: N.troops(),
        prevM: 0,
        minExpand: Number.POSITIVE_INFINITY,
      };
      this.byId.set(id, tr);
    }
    return tr;
  }

  private nation(n: PlayerID): Player | null {
    if (!this.game.hasPlayer(n)) return null;
    return this.game.player(n);
  }

  /** cheap: troops, cap, tiles, gold, attack sums. full: also nearby(),
   *  borders, tribes (one N.nearby() call; allowed at most
   *  `nationRefreshPerTick` per tick). */
  refresh(n: PlayerID, level: "cheap" | "full"): NationState {
    const N = this.nation(n);
    if (N === null) throw new Error(`NationModel: no player ${n}`);
    const tr = this.track(N);
    const st = tr.st;
    const t = this.game.ticks();
    st.params = this.params(n);
    st.T = N.troops();
    st.M = this.models.cap(N);
    st.tiles = N.numTilesOwned();
    st.gold = N.gold();
    st.alliances = N.alliances().length;
    let cities = 0;
    for (const u of N.units(UnitType.City)) {
      if (!u.isUnderConstruction()) cities += u.level();
    }
    tr.cityLevels = cities;
    st.refreshedAt = t;
    if (level === "full" || !st.full) this.fullRefresh(N, tr);
    return st;
  }

  private fullRefresh(N: Player, tr: Tracked): void {
    const st = tr.st;
    const me = this.me;
    const nearby = N.nearby();
    const ids: number[] = [];
    let tn = false;
    let usNearby = false;
    for (const x of nearby) {
      if (!x.isPlayer()) {
        tn = true;
        continue;
      }
      ids.push(x.smallID());
      if (x === me) usNearby = true;
    }
    tr.nearby = ids;
    st.bordersFreeLand = tn;
    // sharesBorderWith is symmetric (4-neighbours both ways) and implies
    // nearby(); scan the smaller border.
    st.sharesBorderWithUs =
      usNearby &&
      (N.borderTiles().size <= me.borderTiles().size
        ? N.sharesBorderWith(me)
        : me.sharesBorderWith(N));
    const T = N.troops();
    const M = st.M;
    const cap = this.sendCapAt(N, tr, me.troops(), T);
    st.tribeBudget = Math.max(0, Math.min(T - st.params.reserve * M, cap));
    st.affordableTribes = this.botAttacks(N, tr, T, M, cap).count;
    st.full = true;
    this.reconcile(N);
  }

  /** Checks the estimate against N.relation(me); logs and clamps on a
   *  mismatch. */
  private reconcile(N: Player): void {
    const t = this.game.ticks();
    const real = N.relation(this.me);
    if (this.relations.band(N.id(), t) === real) return;
    this.log.push(
      `t${t}: relation of ${N.id()} is ${Relation[real]}, estimate ${this.relations.value(N.id(), t).toFixed(2)}`,
    );
    this.trimLog();
    this.relations.reconcile(N.id(), real, t);
  }

  get(n: PlayerID): NationState | undefined {
    return this.byId.get(n)?.st;
  }

  /** The tracked state after at least one full refresh (one lazily if none
   *  happened yet). */
  private full(n: PlayerID): { N: Player; tr: Tracked } | null {
    const N = this.nation(n);
    if (N === null) return null;
    const tr = this.track(N);
    if (!tr.st.full) this.refresh(n, "full");
    return { N, tr };
  }

  /** T at its decision d (its tick in turn d reads the troops at ctx tick
   *  d): the troops d − now regrowth steps from now, each step
   *  Config.troopIncreaseRate through models.regrowthAt and floored as
   *  PlayerImpl.addTroops floors it, at its current tiles and cities. Exact
   *  when nothing else moves its troops; losses to attackers and its own
   *  sends only lower it, refunds of its attacks raise it. Spec §2.4.2 has
   *  T + (d − now)·troopIncreaseRate(N) as an upper bound, but the rate
   *  rises with T up to about 0.42·M, so that line undershoots there. */
  troopsAt(n: PlayerID, d: number): number {
    const N = this.nation(n);
    if (N === null) return 0;
    const now = this.game.ticks();
    const steps = Math.max(0, Math.floor(d - now));
    let path = this.troopPath.get(n);
    if (path === undefined || path.tick !== now || path.T[0] !== N.troops()) {
      path = { tick: now, T: [N.troops()] };
      this.troopPath.set(n, path);
    }
    const Ts = path.T;
    if (Ts.length <= steps) {
      const tr = this.track(N);
      if (!tr.st.full) this.refresh(n, "full");
      const tiles = N.numTilesOwned();
      let T = Ts[Ts.length - 1];
      while (Ts.length <= steps) {
        const r = this.models.regrowthAt(
          PlayerType.Nation,
          T,
          tiles,
          tr.cityLevels,
        );
        T += r >= 0 ? Math.floor(r) : -Math.floor(-r);
        Ts.push(T);
        if (Ts.length > 4000) break;
      }
    }
    return Ts[Math.min(steps, Ts.length - 1)];
  }

  // ── §2.4.3 Predicates ─────────────────────────────────────────────────

  /** Replica of troopSendCap (§2.4.3). */
  sendCap(n: PlayerID, ourHome: number): number {
    const f = this.full(n);
    if (f === null) return 0;
    return this.sendCapAt(f.N, f.tr, ourHome, f.N.troops());
  }

  /** troopSendCap (AiAttackBehavior.ts:986-1032) with N's troops T and our
   *  troops ourHome, over the nearby list of the last full refresh.
   *  `atDecision`: evaluated for N's coming decision, where it answers its
   *  pending alliance requests (handleAllianceRequests, :220) before
   *  maybeAttack, and nations deciding before it in the turn may accept its
   *  own: a neighbour with a pending request either way may be friendly by
   *  then, so it is left out of the maximum (the cap can only rise, the
   *  safe side for canLandAttackUs). */
  private sendCapAt(
    N: Player,
    tr: Tracked,
    ourHome: number,
    T: number,
    atDecision = false,
  ): number {
    if (N.type() === PlayerType.Bot || this.team) return Infinity;
    const retain = RETAIN[this.difficulty];
    if (retain === undefined) return Infinity;
    const pending = atDecision ? this.pendingPartners(N) : null;
    let m = 0;
    for (const id of tr.nearby) {
      const x = this.game.playerBySmallID(id);
      if (!x.isPlayer() || x.type() === PlayerType.Bot) continue;
      if (N.isFriendly(x)) continue;
      if (pending !== null && x !== this.me && pending.has(x)) continue;
      const troops = x === this.me ? ourHome : x.troops();
      if (troops > m) m = troops;
    }
    let cap = m === 0 ? Infinity : Math.max(0, T - Math.ceil(m * retain));
    const incoming = N.incomingAttacks();
    if (incoming.length > 0) {
      let sum = 0;
      for (const a of incoming) sum += a.troops();
      cap = Math.max(cap, sum);
    }
    return cap;
  }

  /** Players with a pending alliance request to or from N. */
  private pendingPartners(N: Player): Set<Player> | null {
    const inc = N.incomingAllianceRequests();
    const out = N.outgoingAllianceRequests();
    if (inc.length === 0 && out.length === 0) return null;
    const s = new Set<Player>();
    for (const r of inc) s.add(r.requestor());
    for (const r of out) s.add(r.recipient());
    return s;
  }

  /** isAttackTooWeak (AiAttackBehavior.ts:961-973). */
  private tooWeak(N: Player, troops: number, targetTroops: number): boolean {
    if (this.team) return false;
    if (N.incomingAttacks().length > 0) return false;
    return (
      (this.difficulty === Difficulty.Hard ||
        this.difficulty === Difficulty.Impossible) &&
      troops < targetTroops * TOO_WEAK_SHARE
    );
  }

  /** attackBots (AiAttackBehavior.ts:484-520) sized as
   *  calculateAttackTroops / calculateBotAttackTroops size it: how many
   *  tribes it would send to, and how much. */
  private botAttacks(
    N: Player,
    tr: Tracked,
    T: number,
    M: number,
    sendCap: number,
  ): { count: number; sent: number } {
    const p = this.params(N.id());
    const bots: Player[] = [];
    for (const id of tr.nearby) {
      const x = this.game.playerBySmallID(id);
      if (!x.isPlayer() || x.type() !== PlayerType.Bot) continue;
      if (!x.isAlive() || N.isFriendly(x)) continue;
      bots.push(x);
    }
    if (bots.length === 0) return { count: 0, sent: 0 };
    // Structures first, then by density (a stable sort, as the code's).
    const keyed = bots.map((b) => ({
      b,
      owns: b.units().some((u) => Structures.has(u.type())),
      density: b.troops() / b.numTilesOwned(),
    }));
    keyed.sort((a, b) => {
      if (a.owns !== b.owns) return a.owns ? -1 : 1;
      return a.density - b.density;
    });
    let sent = 0;
    let count = 0;
    const easy = this.difficulty === Difficulty.Easy;
    const n = Math.min(keyed.length, BOT_PARALLEL[this.difficulty]);
    for (let i = 0; i < n; i++) {
      const { b, owns } = keyed[i];
      const ratio = owns ? p.expand : p.reserve;
      const avail = T - M * ratio - sent;
      const D = b.troops();
      let troops: number;
      if (easy) {
        troops = avail;
      } else {
        troops = D * BOT_ATTACK_MULT;
        if (troops > avail)
          troops = avail < D * BOT_ATTACK_MIN_MULT ? 0 : avail;
      }
      troops = Math.min(troops, sendCap);
      if (troops < 1) continue;
      if (this.tooWeak(N, troops, D)) continue;
      sent += troops;
      count++;
    }
    return { count, sent };
  }

  /** hasNeighboringBotWithStructures (AiAttackBehavior.ts:434-444). */
  private botWithStructures(N: Player, tr: Tracked): boolean {
    for (const id of tr.nearby) {
      const x = this.game.playerBySmallID(id);
      if (!x.isPlayer() || x.type() !== PlayerType.Bot) continue;
      if (N.isFriendly(x)) continue;
      if (x.units().some((u) => Structures.has(u.type()))) return true;
    }
    return false;
  }

  /** maybeAttack :98-157 and attackBestTarget :278-304 at N's decision d:
   *  - locked: it borders free land (nearby()) and the free-land send
   *    succeeds: min(T(d) − expand·M, troopSendCapForExpansion) ≥ 1 [C13];
   *    or a nearby tribe owns a structure and attackBots sends before the
   *    ratio gates (:285-287);
   *  - belowReserve: T(d) < reserve·M;
   *  - belowTrigger: T(d) < trigger·M (the list runs 1 decision in 10);
   *  - open (about 9 in 10 reach the list: a random boat first 1 in 10).
   *  Free land seen only across a river is sent to by boat, which can fail;
   *  it counts as locked here as it does in nearby(). The send cap is the
   *  one of now (pending alliance partners counted): a lower cap locks
   *  less, the safe side. */
  gates(n: PlayerID, d: number): Gate {
    const f = this.full(n);
    if (f === null) return "belowReserve";
    const { N, tr } = f;
    const p = this.params(n);
    const T = this.troopsAt(n, d);
    const M = this.models.cap(N);
    const cap = this.sendCapAt(N, tr, this.me.troops(), T);
    if (tr.st.bordersFreeLand) {
      // calculateAttackTroops for free land: T - expand x cap, capped by
      // troopSendCapForExpansion (:1035-1039), under 1 troop no send.
      const expansionCap = cap > 0 ? cap : Math.ceil(T * EXPANSION_FLOOR_SHARE);
      if (Math.min(T - p.expand * M, expansionCap) >= 1) return "locked";
    }
    if (this.botWithStructures(N, tr)) {
      if (this.botAttacks(N, tr, T, M, cap).count > 0) return "locked";
    }
    if (T < p.reserve * M) return "belowReserve";
    if (T < p.trigger * M) return "belowTrigger";
    return "open";
  }

  /** [PIN NationSendCap: exact]
   *  sharesBorderWithUs && not friendly && gates ∈ {open, belowTrigger}
   *  && s := min(T(d) − reserve·M, sendCap(N, H)) ≥ 1
   *  && (N.underAttack || s ≥ 0.2·H)   (isAttackTooWeak :961-973). */
  canLandAttackUs(n: PlayerID, ourHome: number, d: number): boolean {
    const f = this.full(n);
    if (f === null) return false;
    const { N, tr } = f;
    if (!N.isAlive() || !tr.st.sharesBorderWithUs) return false;
    if (N.isFriendly(this.me)) return false;
    const g = this.gates(n, d);
    if (g === "locked" || g === "belowReserve") return false;
    const p = this.params(n);
    const T = this.troopsAt(n, d);
    const M = this.models.cap(N);
    const s = Math.min(
      T - p.reserve * M,
      this.sendCapAt(N, tr, ourHome, T, true),
    );
    if (s < 1) return false;
    return !this.tooWeak(N, s, ourHome);
  }

  /** First match in the Impossible list (AiAttackBehavior.ts:426-428),
   *  evaluated at N's next decision with our home at ourHome. A strategy
   *  that picks another player ends the list when that send would pass the
   *  cap and the 20% floor (sends to non-bordering players are assumed to
   *  fail, which keeps the list going toward us); a failed send falls
   *  through as in the code (:301-303). Advisory: never trust it without
   *  canLandAttackUs. */
  wouldTargetUs(n: PlayerID, ourHome: number): TargetReason | null {
    const f = this.full(n);
    if (f === null) return null;
    const { N, tr } = f;
    if (!N.isAlive()) return null;
    const me = this.me;
    const p = this.params(n);
    const d = this.nextDecision(n, this.game.ticks());
    const T = this.troopsAt(n, d);
    const M = this.models.cap(N);
    // The safe side both ways: the higher cap (pending alliance partners
    // left out) for a send at us, the cap of now for sends elsewhere.
    const capUs = this.sendCapAt(N, tr, ourHome, T, true);
    const cap = this.sendCapAt(N, tr, ourHome, T);
    const landUs = Math.min(T - p.reserve * M, capUs);
    const boatUs = Math.min(T / 5, capUs);
    const land = Math.min(T - p.reserve * M, cap);
    const bordersUs = tr.st.sharesBorderWithUs;
    const troopsOf = (x: Player) => (x === me ? ourHome : x.troops());
    const sends = (x: Player): boolean => {
      if (x === me) {
        const s = bordersUs ? landUs : boatUs;
        return s >= 1 && !this.tooWeak(N, s, ourHome);
      }
      return land >= 1 && !this.tooWeak(N, land, x.troops());
    };
    const ffa = this.ffa;

    // Bordering players (nearby() order, then a stable sort by troops).
    const enemies: Seat[] = [];
    const friends: Seat[] = [];
    for (const id of tr.nearby) {
      const x = this.game.playerBySmallID(id);
      if (!x.isPlayer() || !x.isAlive()) continue;
      const seat = { p: x, troops: troopsOf(x), isUs: x === me };
      if (N.isFriendly(x)) friends.push(seat);
      else enemies.push(seat);
    }
    enemies.sort((a, b) => a.troops - b.troops);
    friends.sort((a, b) => a.troops - b.troops);

    // 1 retaliate: the largest non-friendly, non-bot incoming attack.
    let largest = 0;
    let attacker: Player | null = null;
    for (const a of N.incomingAttacks()) {
      const x = a.attacker();
      if (N.isFriendly(x) || x.type() === PlayerType.Bot) continue;
      if (a.troops() <= largest) continue;
      largest = a.troops();
      attacker = x;
    }
    if (attacker !== null) {
      if (attacker === me) {
        if (sends(me)) return "retaliate";
      } else if (sends(attacker)) {
        return null;
      }
    }
    // 2 bots.
    if (this.botAttacks(N, tr, T, M, cap).count > 0) return null;
    // 3 veryWeak.
    const vw = enemies.find(
      (e) =>
        e.troops < this.models.cap(e.p) * VERY_WEAK_CAP_SHARE &&
        (!ffa || e.troops < T * FFA_STRONGER_GUARD),
    );
    if (vw !== undefined) {
      if (vw.isUs) {
        if (sends(me)) return "veryWeak";
      } else if (sends(vw.p)) {
        return null;
      }
    }
    // 4 betray (only allies of N).
    const betrayed = this.betrayTarget(N, T, friends, enemies);
    if (betrayed !== null) {
      if (betrayed === me) return sends(me) ? "betray" : null;
      return null;
    }
    // 5 assist.
    if (!this.game.config().disableAlliances()) {
      for (const ally of N.allies()) {
        const targets = ally.targets();
        if (targets.length === 0) continue;
        if (N.relation(ally) < Relation.Friendly) continue;
        let done = false;
        for (const x of targets) {
          if (x === N || N.isFriendly(x)) continue;
          if (x === me) {
            if (sends(me)) return "assist";
            continue;
          }
          if (sends(x)) {
            done = true;
            break;
          }
        }
        if (done) return null;
      }
    }
    // 6 victim.
    const victim = enemies.find((e) => {
      if (ffa && e.troops > T * FFA_STRONGER_GUARD) return false;
      let sum = 0;
      for (const a of e.p.incomingAttacks()) sum += a.troops();
      return sum > e.troops * VICTIM_INCOMING_SHARE;
    });
    if (victim !== undefined) {
      if (victim.isUs) {
        if (sends(me)) return "victim";
      } else if (sends(victim.p)) {
        return null;
      }
    }
    // 7 traitor.
    if (!this.game.config().disableAlliances()) {
      const tt = enemies.find(
        (e) => e.p.isTraitor() && (!ffa || e.troops < T * FFA_STRONGER_GUARD),
      );
      if (tt !== undefined) {
        if (tt.isUs) {
          if (sends(me)) return "traitor";
        } else if (sends(tt.p)) {
          return null;
        }
      }
    }
    // 8 juicy.
    const juicy = this.juiciest(
      enemies.filter((e) => e.troops <= T * JUICY_SHARE),
    );
    if (juicy !== null) {
      if (juicy.isUs) {
        if (sends(me)) return "juicy";
      } else if (sends(juicy.p)) {
        return null;
      }
    }
    // 9 afk.
    const afk = enemies.find(
      (e) => e.p.isDisconnected() && (!ffa || e.troops < T * AFK_GUARD),
    );
    if (afk !== undefined && !afk.isUs && sends(afk.p)) return null;
    // 10 nuked: a free-land send; assumed to fail.
    // 11 hated: the most hostile relation of N, at any distance.
    for (const r of N.allRelationsSorted()) {
      if (r.relation !== Relation.Hostile) continue;
      const x = r.player;
      if (N.isFriendly(x)) continue;
      if (ffa && troopsOf(x) > T * HATED_GUARD) continue;
      if (x === me) {
        if (sends(me)) return "hated";
      } else if (sends(x)) {
        return null;
      }
      break;
    }
    // 12 weakest.
    if (enemies.length > 0) {
      const w = enemies[0];
      if (!ffa || w.troops < T) {
        if (w.isUs) {
          if (sends(me)) return "weakest";
        } else if (sends(w.p)) {
          return null;
        }
      }
    }
    // 13 island: no bordering enemy, and we are weaker (nearest-first
    // and boat reach are not checked: the conservative side).
    if (enemies.length === 0 && (!ffa || ourHome < T) && sends(me)) {
      return "island";
    }
    return null;
  }

  /** findJuiciestTarget (NationUtils.ts:52-100) over seats, our troops
   *  replaced by the hypothetical home. */
  private juiciest(cands: Seat[]): Seat | null {
    if (cands.length === 0) return null;
    const stats = cands.map((c) => {
      let structures = 0;
      for (const u of c.p.units()) {
        const ty = u.type();
        if (
          Structures.has(ty) &&
          ty !== UnitType.DefensePost &&
          ty !== UnitType.MissileSilo
        ) {
          structures += u.level();
        }
      }
      const max = this.models.cap(c.p);
      return {
        c,
        structures,
        gap: max > 0 ? 1 - c.troops / max : 0,
        tiles: c.p.numTilesOwned(),
      };
    });
    const norm = (v: number, all: number[]) => {
      const min = Math.min(...all);
      const max = Math.max(...all);
      return max > min ? (v - min) / (max - min) : 0;
    };
    const ss = stats.map((s) => s.structures);
    const gs = stats.map((s) => s.gap);
    const ts = stats.map((s) => s.tiles);
    let best: Seat | null = null;
    let bestScore = -Infinity;
    for (const s of stats) {
      const score =
        norm(s.structures, ss) + norm(s.gap, gs) + norm(s.tiles, ts);
      if (score > bestScore) {
        bestScore = score;
        best = s.c;
      }
    }
    return best;
  }

  /** The ally maybeBetrayAndAttack would betray (Impossible and Hard,
   *  NationAllianceBehavior.ts:404-491), or null. */
  private betrayTarget(
    N: Player,
    T: number,
    friends: Seat[],
    enemies: Seat[],
  ): Player | null {
    if (this.game.config().disableAlliances() || friends.length === 0) {
      return null;
    }
    const allied = friends.filter((f) => N.isAlliedWith(f.p));
    const juiciestAlly = this.juiciest(allied)?.p ?? null;
    const hardOrImpossible =
      this.difficulty === Difficulty.Hard ||
      this.difficulty === Difficulty.Impossible;
    const total = (x: Seat) => {
      let out = 0;
      for (const a of x.p.outgoingAttacks()) out += a.troops();
      return x.troops + out;
    };
    for (const f of friends) {
      if (!N.isAlliedWith(f.p)) continue;
      if (hardOrImpossible && juiciestAlly === f.p) {
        const others = f.p.isTraitor()
          ? []
          : friends.filter((o) => o !== f && N.isAlliedWith(o.p));
        let threat = 0;
        for (const x of [f, ...enemies, ...others]) threat += total(x);
        if (threat < T * BETRAY_SAFE_SHARE) return f.p;
      }
      if (
        this.difficulty !== Difficulty.Easy &&
        f.p.isTraitor() &&
        f.troops < T * BETRAY_TRAITOR_GUARD
      ) {
        return f.p;
      }
      if (
        this.difficulty !== Difficulty.Easy &&
        friends.length + enemies.length === 1 &&
        f.troops * BETRAY_ONLY_NEIGHBOUR_MULT < T
      ) {
        return f.p;
      }
    }
    return null;
  }

  // ── §2.4.5 Alliance forecast ──────────────────────────────────────────

  /** getAllianceDecision (NationAllianceBehavior.ts:119-179) for our
   *  request (handleAllianceRequests :60-77) or extension (:79-94), at the
   *  decision q.atTick. Every branch in source order; the draws are
   *  independent, so p multiplies out. */
  acceptsAlliance(n: PlayerID, q: AllianceQuery): AllianceForecast {
    const f = this.full(n);
    const done = (
      p: number,
      branch: AllianceForecast["branch"],
    ): AllianceForecast => ({ p, branch, deterministic: p === 0 || p === 1 });
    if (f === null) return done(0, "no");
    const { N, tr } = f;
    const me = this.me;
    const config = this.game.config();
    const rules = ALLIANCE_RULES[this.difficulty];
    if (config.disableAlliances() || !N.isAlive()) return done(0, "no");
    // 1 requests created in the spawn phase (+1) are refused (:64-70).
    if (
      q.kind === "request" &&
      q.createdAt <= config.numSpawnPhaseTurns() + 1
    ) {
      return done(0, "spawnPhase");
    }
    const margin = q.margin ?? DEFAULT_MARGIN;
    const slack = 1 + margin;
    const H = q.ourHome ?? me.troops();
    let ourOut = q.ourOutgoing;
    if (ourOut === undefined) {
      ourOut = 0;
      for (const a of me.outgoingAttacks()) ourOut += a.troops();
    }
    const T = this.troopsAt(n, q.atTick);
    let theirOut = 0;
    for (const a of N.outgoingAttacks()) theirOut += a.troops();

    // p = P(accept | not confused) folded as the code runs: `mult` is the
    // share of draws still undecided, `acc` what is already accepted.
    let first: AllianceForecast["branch"] | null = null;
    let mult = 1;
    // 2 traitor: refused if nextInt(0, 100) >= 10.
    if (me.isTraitor()) {
      mult *= rules.traitorAccept;
      first = "traitor";
    }
    // 3 hasTooManyAlliances: our alliances vs the living non-bot players.
    if (rules.tooManyShare > 0) {
      const players = this.nonBotCount();
      if (me.alliances().length >= players * rules.tooManyShare) {
        return this.confused(done(0, "tooMany"), rules);
      }
    }
    // 4 isAlliancePartnerThreat.
    if (this.isThreat(H, T * slack, me, N)) {
      return this.confused(done(mult, first ?? "threat"), rules);
    }
    // 5 team games.
    if (this.team) {
      const p = mult * (1 - rules.teamReject);
      if (p === 0) return this.confused(done(0, "no"), rules);
      mult = p;
    }
    // 6 relation below Neutral, with the embargo malus of that decision.
    this.reconcile(N);
    const now = this.game.ticks();
    // An estimate from a reconcile clamp is only the band edge nearest 0
    // (less RECONCILE_MARGIN): the real value may lie anywhere in the band.
    // While that band is below Neutral, decay alone must not carry the
    // estimate across 0 by atTick (it did, 49 ticks past a clamp, and the
    // forecast said p = 1 for nations at −21 and −3.6 that refused, arena
    // quick@4): the value stays where it is now, unless a tracked event
    // (the embargo restore) lifts it.
    const clampedBelow =
      this.relations.clamped(n) && N.relation(me) < Relation.Neutral;
    const base = clampedBelow
      ? Math.min(
          this.relations.value(n, now),
          this.relations.value(n, q.atTick),
        )
      : this.relations.value(n, q.atTick);
    const v =
      base +
      this.relations.embargoMalus(n).atDecision(q.atTick, q.embargoStoppedBy);
    const band = relationBand(clampRelation(v));
    // Past here the answer rests on a guessed value when clampedBelow.
    const known = (f: AllianceForecast): AllianceForecast =>
      clampedBelow ? { ...f, deterministic: false } : f;
    if (band < Relation.Neutral) {
      return known(this.confused(done(0, "hostile"), rules));
    }
    let acc = 0;
    // 7 Friendly.
    if (band === Relation.Friendly) {
      acc += mult * rules.friendlyAccept;
      mult *= 1 - rules.friendlyAccept;
      first ??= "friendly";
      if (mult === 0) return known(this.confused(done(acc, first), rules));
    }
    // 8 checkAlreadyEnoughAlliances.
    const pass = this.enoughPass(N, tr, rules);
    if (pass === 0) {
      return known(
        this.confused(
          done(acc, acc > 0 && first !== null ? first : "enough"),
          rules,
        ),
      );
    }
    if (pass < 1) first ??= "enough";
    mult *= pass;
    // 9 isEarlygame: game.ticks() at the decision.
    if (q.atTick < rules.earlyTicks + config.numSpawnPhaseTurns()) {
      acc += mult * rules.earlyAccept;
      mult *= 1 - rules.earlyAccept;
      first ??= "early";
    }
    // 10 isAlliancePartnerSimilarlyStrong.
    const sim = this.similar(
      H + ourOut,
      (T + theirOut) * slack,
      me.numTilesOwned(),
      N.numTilesOwned(),
      rules,
    );
    acc += mult * sim;
    first ??= sim > 0 ? "similar" : "no";
    return known(this.confused(done(acc, first), rules));
  }

  /** isConfused (Easy/Medium/Hard): 1 in n decisions answer by a coin. */
  private confused(
    f: AllianceForecast,
    rules: AllianceRules,
  ): AllianceForecast {
    if (rules.confusedOneIn === 0) return f;
    const c = 1 / rules.confusedOneIn;
    const p = c * 0.5 + (1 - c) * f.p;
    return { p, branch: f.branch, deterministic: false };
  }

  private nonBotCount(): number {
    if (this.game.ticks() - this.listAt >= PLAYER_LIST_EVERY) {
      this.refreshPlayerList(this.game.ticks());
    }
    return this.nonBotAlive;
  }

  /** isAlliancePartnerThreat (NationAllianceBehavior.ts:251-283): our home
   *  troops against its (with slack). */
  private isThreat(H: number, T: number, me: Player, N: Player): boolean {
    const config = this.game.config();
    switch (this.difficulty) {
      case Difficulty.Easy:
        return false;
      case Difficulty.Medium:
        return H > T * 2.5;
      case Difficulty.Hard:
        return H > T && config.maxTroops(me) > config.maxTroops(N) * 2;
      case Difficulty.Impossible:
        return (
          H > T * 1.5 ||
          (H > T && config.maxTroops(me) > config.maxTroops(N) * 1.5) ||
          (H > T && me.numTilesOwned() > N.numTilesOwned() * 1.5)
        );
    }
  }

  /** checkAlreadyEnoughAlliances (NationAllianceBehavior.ts:305-337): the
   *  share of draws that pass. */
  private enoughPass(N: Player, tr: Tracked, rules: AllianceRules): number {
    if (rules.enough === null) return 1;
    const me = this.me;
    if (rules.enoughNeighbourRule) {
      let players = 0;
      let friends = 0;
      let usThere = false;
      for (const id of tr.nearby) {
        const x = this.game.playerBySmallID(id);
        if (!x.isPlayer() || x.type() === PlayerType.Bot) continue;
        players++;
        if (N.isFriendly(x)) friends++;
        if (x === me) usThere = true;
      }
      if (players >= 2 && usThere) return players <= friends + 1 ? 0 : 1;
    }
    const k = N.alliances().length;
    const [lo, hi] = rules.enough;
    // Refused when k >= nextInt(lo, hi): passes for draws above k.
    let passing = 0;
    for (let draw = lo; draw < hi; draw++) if (k < draw) passing++;
    return passing / (hi - lo);
  }

  /** isAlliancePartnerSimilarlyStrong (NationAllianceBehavior.ts:361-400):
   *  the troop draw and the tile draw are independent. */
  private similar(
    ourTotal: number,
    theirTotal: number,
    ourTiles: number,
    theirTiles: number,
    rules: AllianceRules,
  ): number {
    const [tlo, thi] = rules.troopRange;
    const [glo, ghi] = rules.tileRange;
    let troop = 0;
    for (let k = tlo; k < thi; k++) {
      if (ourTotal > theirTotal * (k / 100)) troop++;
    }
    let tile = 0;
    if (ourTotal > theirTotal * 0.5) {
      for (let k = glo; k < ghi; k++) {
        if (ourTiles > theirTiles * (k / 100)) tile++;
      }
    }
    const pTroop = troop / (thi - tlo);
    const pTile = tile / (ghi - glo);
    return 1 - (1 - pTroop) * (1 - pTile);
  }

  private trimLog(): void {
    if (this.log.length > 50) this.log.splice(0, this.log.length - 50);
  }
}
