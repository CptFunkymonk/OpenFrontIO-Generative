import { Player, PlayerID, UnitType } from "../../core/game/Game";
import { AgentIntent } from "../Agent";

// Our attacks by target, plans, and the sends of this tick (spec §2.5).
//
// One plan per target (smallID, 0 = TN). A plan is made by the first send
// that names a PlanKind and lives while an attack of ours on the target is
// running, a send to it is still pending, or (boat plans) one of our boats
// may still be carrying it. `observe` drops the rest.
//
// Attacks merge [PIN AttackMerge]: a new land attack absorbs every earlier
// attack of ours on the same target, boat landings and retreating attacks
// included, under a NEW attack id. So a send is "pending" from the tick it is
// sent until the first observe that sees a new land-attack id on its target
// (the next tick at latency 1: a send at ctx.tick T runs in turn T, spec
// §2.1), and `stackOn` counts it until then. A send whose attack never
// appears (refused at init, or cancelled by a larger counter-attack) stops
// counting after PENDING_TTL ticks.

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

/** What a send adds to its plan beyond the intent. All optional. */
export interface SendMeta {
  /** The target's smallID (0 = TN). A boat intent names only a tile, so a
   *  boat send makes or updates a plan only with this. An attack without it
   *  is matched to its targetID when its attack first appears. */
  target?: number;
  clampTroops?: number;
  expectedRefund?: number;
}

/** A send not yet seen as a new attack id. Plain data. */
export interface PendingSend {
  /** smallID (0 = TN), or UNRESOLVED until an attack on targetID shows. */
  target: number;
  targetID: PlayerID | null;
  troops: number;
  tick: number;
  /** For a send whose target was unresolved: applied to the plan when it
   *  resolves. */
  kind: PlanKind | null;
  clampTroops?: number;
  expectedRefund?: number;
}

export interface LedgerData {
  plans: TargetPlan[];
  sentThisTick: AgentIntent[];
  tick: number;
  /** Sends not yet seen as attacks (absent = none). */
  pending?: PendingSend[];
  /** Our attack ids at the last observe (absent = none). */
  seen?: string[];
}

/** PendingSend.target of an attack whose target smallID is not known yet. */
export const UNRESOLVED = -1;
/** Ticks a send counts in stackOn, and keeps its plan, without its attack
 *  showing. At latency 1 every accepted attack shows the next tick, so this
 *  only covers a longer browser latency, and refused sends. */
export const PENDING_TTL = 5;
/** A tick before every real tick (and, unlike -Infinity, JSON-safe). */
const BEFORE_GAME = -1;

export class Ledger {
  private readonly plans = new Map<number, TargetPlan>();
  private pending: PendingSend[] = [];
  private seen = new Set<string>();
  private sent: AgentIntent[] = [];
  private tick: number;
  /** Troops of live, non-retreating attacks by target (last observe). */
  private live = new Map<number, number>();
  /** Troops of live retreating attacks by target (last observe). */
  private retreat = new Map<number, number>();
  /** PlayerID -> smallID, learnt from sends with a target and from our
   *  attacks' targets. */
  private readonly smallOf = new Map<PlayerID, number>();

  /** `tick`: the tick sentThisTick belongs to (default: before the game). */
  constructor(tick = BEFORE_GAME) {
    this.tick = tick;
  }

  /** Every tick: reconciles plans with me.outgoingAttacks(); drops finished
   *  ones. */
  observe(me: Player, tick: number): void {
    this.roll(tick);
    const live = new Map<number, number>();
    const retreat = new Map<number, number>();
    const fresh = new Set<number>(); // targets with a new land-attack id
    const seen = new Set<string>();
    for (const a of me.outgoingAttacks()) {
      const target = a.target();
      const t = target.isPlayer() ? target.smallID() : 0;
      if (target.isPlayer()) this.smallOf.set(target.id(), t);
      const id = a.id();
      seen.add(id);
      if (a.sourceTile() === null && !this.seen.has(id)) fresh.add(t);
      const into = a.retreating() ? retreat : live;
      into.set(t, (into.get(t) ?? 0) + a.troops());
    }
    this.live = live;
    this.retreat = retreat;
    this.seen = seen;

    const keep: PendingSend[] = [];
    for (const p of this.pending) {
      if (p.target === UNRESOLVED && p.targetID !== null) {
        const t = this.smallOf.get(p.targetID);
        if (t !== undefined) {
          p.target = t;
          this.upsert(t, p.kind, p.tick, p, false);
        }
      }
      const shown = p.target !== UNRESOLVED && fresh.has(p.target);
      if (p.tick < tick && shown) continue;
      if (tick - p.tick > PENDING_TTL) continue;
      keep.push(p);
    }
    this.pending = keep;

    let boatsChecked = false;
    let boatsOut = false;
    for (const [t, plan] of this.plans) {
      if (live.has(t) || retreat.has(t) || this.pendingOn(t) > 0) continue;
      if (plan.kind === "boat") {
        if (tick - plan.lastSend <= PENDING_TTL) continue;
        if (!boatsChecked) {
          boatsOut = me.unitCount(UnitType.TransportShip) > 0;
          boatsChecked = true;
        }
        if (boatsOut) continue;
      }
      this.plans.delete(t);
    }
  }

  /** Troops in our live attacks on the target plus sends made this tick
   *  (and earlier sends whose attack has not shown yet). Retreating attacks
   *  are not counted: see retreatingOn. */
  stackOn(targetSmallID: number): number {
    let sum = this.live.get(targetSmallID) ?? 0;
    for (const p of this.pending) {
      if (p.target === targetSmallID) sum += p.troops;
    }
    return sum;
  }

  /** Troops of our retreating attacks on the target. A new land send
   *  absorbs them [PIN AttackMerge], so it cancels the retreat. */
  retreatingOn(targetSmallID: number): number {
    return this.retreat.get(targetSmallID) ?? 0;
  }

  /** The ledger's own record: a controller that re-evaluates a plan may set
   *  its clampTroops and expectedRefund. */
  plan(targetSmallID: number): TargetPlan | undefined {
    return this.plans.get(targetSmallID);
  }

  /** Every plan, by ascending target smallID. */
  allPlans(): TargetPlan[] {
    return [...this.plans.values()].sort(
      (a, b) => a.targetSmallID - b.targetSmallID,
    );
  }

  /** Called by the Scheduler for every intent that ctx.send accepted.
   *  An attack updates the target's plan (lastSend; kind if given), or
   *  makes one when `kind` is given. A boat send (with meta.target) makes a
   *  "boat"-kind plan or updates one, but never changes a land plan. */
  recordSend(
    intent: AgentIntent,
    tick: number,
    kind: PlanKind | null,
    meta?: SendMeta,
  ): void {
    this.roll(tick);
    this.sent.push(intent);
    if (intent.type === "attack") {
      const targetID = intent.targetID;
      let target = meta?.target;
      if (target !== undefined && targetID !== null) {
        this.smallOf.set(targetID, target);
      }
      target ??=
        targetID === null ? 0 : (this.smallOf.get(targetID) ?? UNRESOLVED);
      const p: PendingSend = {
        target,
        targetID,
        troops: intent.troops ?? 0,
        tick,
        kind,
      };
      if (meta?.clampTroops !== undefined) p.clampTroops = meta.clampTroops;
      if (meta?.expectedRefund !== undefined) {
        p.expectedRefund = meta.expectedRefund;
      }
      this.pending.push(p);
      if (target !== UNRESOLVED) this.upsert(target, kind, tick, meta, false);
    } else if (intent.type === "boat" && meta?.target !== undefined) {
      this.upsert(meta.target, kind ?? "boat", tick, meta, true);
    }
  }

  /** Troops expected home when our plans end: each plan's expectedRefund,
   *  at most the troops still in its attacks and pending sends. */
  expectedRefunds(): number {
    let sum = 0;
    for (const [t, plan] of this.plans) {
      if (!(plan.expectedRefund > 0)) continue;
      const inPlay =
        (this.live.get(t) ?? 0) +
        (this.retreat.get(t) ?? 0) +
        this.pendingOn(t, true);
      sum += Math.min(plan.expectedRefund, inPlay);
    }
    return sum;
  }

  /** For replay into a fork (latency 1): what was sent at the ledger's
   *  current tick. */
  sentThisTick(): readonly AgentIntent[] {
    return this.sent;
  }

  /** Plain data for ApexState (cloneable). */
  toData(): LedgerData {
    return structuredClone({
      plans: this.allPlans(),
      sentThisTick: this.sent,
      tick: this.tick,
      pending: this.pending,
      seen: [...this.seen],
    });
  }

  /** A ledger from toData(). Its live-attack view is empty until the first
   *  observe, which a policy runs before reading it. */
  static fromData(d: LedgerData): Ledger {
    const data = structuredClone(d);
    const l = new Ledger(data.tick);
    for (const p of data.plans) l.plans.set(p.targetSmallID, p);
    l.sent = data.sentThisTick;
    l.pending = data.pending ?? [];
    l.seen = new Set(data.seen ?? []);
    for (const p of l.pending) {
      if (p.targetID !== null && p.target !== UNRESOLVED) {
        l.smallOf.set(p.targetID, p.target);
      }
    }
    return l;
  }

  /** A new tick starts a new sentThisTick. */
  private roll(tick: number): void {
    if (tick !== this.tick) {
      this.tick = tick;
      this.sent = [];
    }
  }

  /** Pending sends on the target: their troops (troops = true) or count. */
  private pendingOn(t: number, troops = false): number {
    let n = 0;
    for (const p of this.pending) {
      if (p.target === t) n += troops ? p.troops : 1;
    }
    return n;
  }

  private upsert(
    t: number,
    kind: PlanKind | null,
    tick: number,
    meta: SendMeta | PendingSend | undefined,
    boat: boolean,
  ): void {
    let plan = this.plans.get(t);
    if (plan === undefined) {
      if (kind === null) return;
      plan = {
        targetSmallID: t,
        kind,
        launchedAt: tick,
        lastSend: tick,
        clampTroops: 0,
        expectedRefund: 0,
      };
      this.plans.set(t, plan);
    } else {
      if (boat && plan.kind !== "boat") return;
      plan.lastSend = Math.max(plan.lastSend, tick);
      if (kind !== null) plan.kind = kind;
    }
    if (meta?.clampTroops !== undefined) plan.clampTroops = meta.clampTroops;
    if (meta?.expectedRefund !== undefined) {
      plan.expectedRefund = meta.expectedRefund;
    }
  }
}
