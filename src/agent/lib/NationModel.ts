import {
  Difficulty,
  Game,
  Player,
  PlayerID,
  Relation,
} from "../../core/game/Game";
import { Models } from "./Models";

// Nation parameters from gameID, gate predicates, alliance forecast and the
// relation tracker (spec §2.4). Nation players can appear after construction
// (nations spawn in tick 2), so everything per nation is computed lazily.

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

/** Replays the first five draws of NationExecution: PseudoRandom(simpleHash(id) +
 *  simpleHash(gameID)); trigger nextInt(50,60)/100, reserve nextInt(30,40)/100,
 *  expand nextInt(10,20)/100 (constructor, NationExecution.ts:72-78), then
 *  rate = difficulty range (Impossible nextInt(30,50), :92-107), phase =
 *  nextInt(0, rate) (:84). */
export function nationParams(
  gameID: string,
  nationID: PlayerID,
  d: Difficulty,
): AiParams {
  // TODO(spec §2.4.1): implement; pin tests/agent/mechanics/NationParams.test.ts (§4 step 0).
  throw new Error("not implemented: nationParams");
}

/** TribeExecution.ts:35-40: PseudoRandom(simpleHash(tribeID)): rate
 *  nextInt(40,80), phase nextInt(0, rate), trigger, reserve, expand. Needs
 *  no gameID. */
export function tribeParams(tribeID: PlayerID): AiParams {
  // TODO(spec §2.4.1)
  throw new Error("not implemented: tribeParams");
}

/** First tick >= from with tick % rate == phase. */
export function nextDecision(p: AiParams, from: number): number {
  // TODO(spec §2.4.1)
  throw new Error("not implemented: nextDecision");
}

// ── §2.4.2 State and refresh ─────────────────────────────────────────────

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
  outgoingSum: number;
  incomingSum: number;
  underAttack: boolean;
  alliances: number;
  alliedWithUs: boolean;
  silos: number;
  sams: number;
  structureLevels: number;
  /** SmallIDs from N.nearby(), non-bot players. */
  nearbyNonBot: number[];
  /** Max troops over nearby non-friendly non-bot players, us included. */
  nearbyMax: number;
  nearbyMaxExUs: number;
  /** N.nearby().some(n => !n.isPlayer()). */
  bordersFreeLand: boolean;
  /** N.sharesBorderWith(me). */
  sharesBorderWithUs: boolean;
  /** min(T − reserve·M, sendCap) for its bots strategy. */
  tribeBudget: number;
  /** Nearby tribes with 2·D ≤ T − reserve·M and sendCap ≥ 1
   *  (calculateBotAttackTroops :1149-1166). */
  affordableTribes: number;
  /** From new outgoing attack IDs. */
  lastSendTick: number;
  lastSendTroops: number;
  /** For the vulture window. */
  troops20ago: number;
  refreshedAt: number;
  full: boolean;
}

export type Gate = "locked" | "belowReserve" | "belowTrigger" | "open";

export type TargetReason =
  | "retaliate"
  | "veryWeak"
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
  /** Called by NationModel.observe. */
  onEvent(n: PlayerID, tick: number, delta: number, cause: RelationCause): void;
  /** Whether N's −20 embargo malus is applied now, and what it will be at d. */
  embargoMalus(n: PlayerID): {
    applied: boolean;
    atDecision(d: number, stoppedBy: number | null): number;
  };
  /** Compares with the real band each full refresh. On mismatch, clamps the
   *  estimate into the band and logs. */
  reconcile(n: PlayerID, real: Relation, t: number): void;
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
  | "donation";

export interface RelationData {
  values: Record<PlayerID, { v: number; at: number }>;
  malusApplied: PlayerID[];
}

export function relationTracker(d?: RelationData): RelationTracker {
  // TODO(spec §2.4.4): implement; tests in tests/agent/apex/Relations.test.ts (§4 step 3).
  throw new Error("not implemented: relationTracker");
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
  /** Default 0.1: troop tests evaluated with 10% slack. */
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
  deterministic: boolean;
}

// ── NationModel ──────────────────────────────────────────────────────────

export class NationModel {
  relations: RelationTracker;

  constructor(game: Game, me: Player, gameID: string | null, models: Models) {
    // TODO(spec §2.4): implement; tests in tests/agent/apex/NationModel.test.ts (§4 step 3).
    throw new Error("not implemented: NationModel");
  }

  /** Every tick, O(nations deciding this tick + new attack IDs): records
   *  sends, decision ticks, relation events (2.4.4). */
  observe(tick: number): void {
    throw new Error("not implemented: NationModel.observe");
  }

  /** cheap: troops, cap, tiles, gold, attack sums. full: also nearby(),
   *  borders, tribes (one N.nearby() call; allowed at most
   *  `nationRefreshPerTick` per tick). */
  refresh(n: PlayerID, level: "cheap" | "full"): NationState {
    throw new Error("not implemented: NationModel.refresh");
  }

  get(n: PlayerID): NationState | undefined {
    throw new Error("not implemented: NationModel.get");
  }

  params(n: PlayerID): AiParams {
    throw new Error("not implemented: NationModel.params");
  }

  nextDecision(n: PlayerID, from: number): number {
    throw new Error("not implemented: NationModel.nextDecision");
  }

  /** T at its next decision d: T + (d − now)·troopIncreaseRate(N), an upper
   *  bound. */
  troopsAt(n: PlayerID, d: number): number {
    throw new Error("not implemented: NationModel.troopsAt");
  }

  /** Replica of troopSendCap (§2.4.3). */
  sendCap(n: PlayerID, ourHome: number): number {
    throw new Error("not implemented: NationModel.sendCap");
  }

  gates(n: PlayerID, d: number): Gate {
    throw new Error("not implemented: NationModel.gates");
  }

  canLandAttackUs(n: PlayerID, ourHome: number, d: number): boolean {
    throw new Error("not implemented: NationModel.canLandAttackUs");
  }

  wouldTargetUs(n: PlayerID, ourHome: number): TargetReason | null {
    throw new Error("not implemented: NationModel.wouldTargetUs");
  }

  acceptsAlliance(n: PlayerID, q: AllianceQuery): AllianceForecast {
    throw new Error("not implemented: NationModel.acceptsAlliance");
  }
}
