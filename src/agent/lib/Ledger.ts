import { Player } from "../../core/game/Game";
import { AgentIntent } from "../Agent";

// Our attacks by target, plans, and the sends of this tick (spec §2.5).

export type PlanKind =
  | "tn"
  | "tribe"
  | "snack"
  | "snipe"
  | "poke"
  | "boat"
  | "strike";

export interface TargetPlan {
  /** 0 = TN. */
  targetSmallID: number;
  kind: PlanKind;
  launchedAt: number;
  lastSend: number;
  /** D/ratio·margin at the last evaluation. */
  clampTroops: number;
  /** S − cost, for cap headroom (§3.6.7). */
  expectedRefund: number;
}

export interface LedgerData {
  plans: TargetPlan[];
  sentThisTick: AgentIntent[];
  tick: number;
}

export class Ledger {
  /** Every tick: reconciles plans with me.outgoingAttacks(); drops finished
   *  ones. */
  observe(me: Player, tick: number): void {
    // TODO(spec §2.5): implement.
    throw new Error("not implemented: Ledger.observe");
  }

  /** Troops in our live attacks on the target plus sends made this tick. */
  stackOn(targetSmallID: number): number {
    throw new Error("not implemented: Ledger.stackOn");
  }

  plan(targetSmallID: number): TargetPlan | undefined {
    throw new Error("not implemented: Ledger.plan");
  }

  /** Called by the Scheduler for every intent that ctx.send accepted. */
  recordSend(intent: AgentIntent, tick: number, kind: PlanKind | null): void {
    throw new Error("not implemented: Ledger.recordSend");
  }

  expectedRefunds(): number {
    throw new Error("not implemented: Ledger.expectedRefunds");
  }

  /** For replay into a fork (latency 1). */
  sentThisTick(): readonly AgentIntent[] {
    throw new Error("not implemented: Ledger.sentThisTick");
  }

  /** Plain data for ApexState (cloneable). */
  toData(): LedgerData {
    throw new Error("not implemented: Ledger.toData");
  }

  static fromData(d: LedgerData): Ledger {
    throw new Error("not implemented: Ledger.fromData");
  }
}
