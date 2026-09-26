import { AgentIntent, IntentBudgetRemaining, SendResult } from "../Agent";
import { Ledger, PlanKind } from "./Ledger";

// Proposals, priorities, reserves and class caps; the Purse (spec §2.6).
//
// Semantics: `offer` is the only way to spend troops or intents. Controllers
// check the return value, and never re-propose the same key in the same tick.

export enum Prio {
  Emergency = 0,
  Recall = 1,
  Snack = 2,
  TopUp = 3,
  Strike = 4,
  TN = 5,
  Tribe = 6,
  Boat = 7,
  Diplomacy = 8,
  Build = 9,
}

export type IntentClass =
  | "spawn"
  | "defense"
  | "diplomacy"
  | "snack"
  | "topup"
  | "tn"
  | "tribe"
  | "boat"
  | "strike"
  | "build";

export interface Proposal {
  intent: AgentIntent;
  prio: Prio;
  cls: IntentClass;
  /** Dedupe within a tick, e.g. "attack:417". */
  key?: string;
  spend?: { kind: SpendKind; troops: number };
  plan?: PlanKind;
}

export type SpendKind =
  | "snack"
  | "defense"
  | "tn"
  | "tribe"
  | "boat"
  | "strike";

/** §3.1. All in troops; recomputed every decision. */
export interface HomeFloors {
  cap: number;
  econ: number;
  vw: number;
  food: number;
  H: number;
  tn: number;
  strike: number;
}

export interface Purse {
  readonly home: number;
  /** §3.1. */
  readonly floors: HomeFloors;
  /** home − floor(k), ≥ 0. */
  available(k: SpendKind): number;
  /** Debits, or false with no debit. */
  take(k: SpendKind, troops: number): boolean;
}

/**
 * A Purse over `home` troops with these floors: floor(snack) = floor(defense)
 * = vw, floor(tn) = tn, floor(tribe) = floor(boat) = H, floor(strike) =
 * strike (§3.1). The policy builds one per tick from `me.troops()` and the
 * floors of the last decision.
 */
export function createPurse(home: number, floors: HomeFloors): Purse {
  // TODO(spec §2.6, §3.1): implement.
  throw new Error("not implemented: createPurse");
}

/** The Scheduler's options (a subset of ApexOptions, §3.9-3.10). */
export interface SchedulerOptions {
  reservePerSecond: number;
  reservePerMinute: number;
  classCapsPerMinute: Partial<Record<IntentClass, number>>;
}

export class Scheduler {
  constructor(o: SchedulerOptions) {
    // TODO(spec §2.6): implement; tests in tests/agent/apex/Scheduler.test.ts (§4 step 1).
    throw new Error("not implemented: Scheduler");
  }

  /** Start of tick: copies ctx.budget(). */
  begin(tick: number, remaining: IntentBudgetRemaining, purse: Purse): void {
    throw new Error("not implemented: Scheduler.begin");
  }

  /** Accepts if the budget allows (Prio ≥ Snack must leave the reserves free)
   *  and the class cap allows, then debits the purse. False: nothing
   *  reserved, try later. */
  offer(p: Proposal): boolean {
    throw new Error("not implemented: Scheduler.offer");
  }

  /** Sends the accepted proposals in priority order via ctx.send and records
   *  them in the Ledger. A "rate_limited" result (should never happen) is
   *  logged. */
  flush(
    send: (i: AgentIntent) => SendResult,
    ledger: Ledger,
    tick: number,
  ): void {
    throw new Error("not implemented: Scheduler.flush");
  }
}
