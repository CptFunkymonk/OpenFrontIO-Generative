import { AgentIntent, IntentBudgetRemaining, SendResult } from "../Agent";
import { Ledger, PlanKind, SendMeta } from "./Ledger";

// Proposals, priorities, reserves and class caps; the Purse (spec §2.6).
//
// Semantics: `offer` is the only way to spend troops or intents. Controllers
// check the return value, and never re-propose the same key in the same tick.
//
// The intent budget (§3.10) is the host's IntentBudget: a 10/s token bucket
// plus a fixed 150/min window, both checked before either is consumed. Within
// one agent tick the host's clock does not move in the arena (game time) and
// only moves forward in the browser (wall time), and both limits only refill
// as time passes. So `ctx.budget()` read at `begin` is a lower bound on what
// `ctx.send` will accept at `flush`, and accepting at most that many intents
// per tick is never rate limited.

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
  /** Not in spec §2.6: passed to Ledger.recordSend with the plan. Set
   *  `meta.target` (the target's smallID, 0 = TN) on attack and boat
   *  proposals: a boat intent names only a tile, and an attack's plan
   *  exists from the send instead of from its first observed attack. */
  meta?: SendMeta;
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
  /** Home troops still unspent this tick (me.troops() less every take). */
  readonly home: number;
  /** §3.1. */
  readonly floors: HomeFloors;
  /** home − floor(k), ≥ 0. */
  available(k: SpendKind): number;
  /** Debits, or false with no debit. A take of more than available(k) (or
   *  of a negative or non-finite amount) is refused. */
  take(k: SpendKind, troops: number): boolean;
}

/** The floor each spend kind must leave at home (§3.1). */
export function floorOf(floors: HomeFloors, k: SpendKind): number {
  switch (k) {
    case "snack":
    case "defense":
      return floors.vw;
    case "tn":
      return floors.tn;
    case "tribe":
    case "boat":
      return floors.H;
    case "strike":
      return floors.strike;
  }
}

class HomePurse implements Purse {
  constructor(
    private left: number,
    readonly floors: HomeFloors,
  ) {}

  get home(): number {
    return this.left;
  }

  available(k: SpendKind): number {
    return Math.max(0, this.left - floorOf(this.floors, k));
  }

  take(k: SpendKind, troops: number): boolean {
    if (!(troops >= 0) || !Number.isFinite(troops)) return false;
    if (troops > this.available(k)) return false;
    this.left -= troops;
    return true;
  }
}

/**
 * A Purse over `home` troops with these floors: floor(snack) = floor(defense)
 * = vw, floor(tn) = tn, floor(tribe) = floor(boat) = H, floor(strike) =
 * strike (§3.1). The policy builds one per tick from `me.troops()` and the
 * floors of the last decision. Every take lowers `home` for all kinds.
 */
export function createPurse(home: number, floors: HomeFloors): Purse {
  return new HomePurse(home, floors);
}

/** The Scheduler's options (a subset of ApexOptions, §3.9-3.10). */
export interface SchedulerOptions {
  reservePerSecond: number;
  reservePerMinute: number;
  classCapsPerMinute: Partial<Record<IntentClass, number>>;
}

/** Why the last refused offer was refused (for tests and logs). */
export type Refusal =
  | "key"
  | "budget"
  | "classCap"
  | "purse"
  | "notBegun"
  | "dupGuard";

/**
 * A land attack that inits exactly 20 ticks after a cancel_attack on the same
 * target absorbs the already-retreated stack while its refund is still paid,
 * so the troops exist twice (a simulation bug pinned by
 * tests/agent/mechanics/AttackMerge.test.ts, docs/13-mechanics.md §2.3). We
 * never exploit it: after any cancel we send, no attack goes out in this
 * window of ticks, which also covers a tick or two of latency jitter in the
 * browser. cancel_boat followed by a land click is covered too.
 */
export const DUP_GUARD_TICKS: readonly [number, number] = [17, 23];

export interface SchedulerStats {
  offered: number;
  accepted: number;
  refused: Record<Refusal, number>;
  /** Class-cap refusals by class (logs only). */
  classCapped: Partial<Record<IntentClass, number>>;
  /** Refusals by a vetoed key, counted under refused.key too (logs and
   *  tests). */
  vetoed: number;
  sent: number;
  rateLimited: number;
  invalid: number;
}

/** Log lines the Scheduler keeps until takeLog() (a bound, not a ring). */
const MAX_LOG = 50;
/** Config.msPerTick() today; used only when the caller passes none. */
const DEFAULT_MS_PER_TICK = 100;

export class Scheduler {
  readonly stats: SchedulerStats = {
    offered: 0,
    accepted: 0,
    refused: {
      key: 0,
      budget: 0,
      classCap: 0,
      purse: 0,
      notBegun: 0,
      dupGuard: 0,
    },
    classCapped: {},
    vetoed: 0,
    sent: 0,
    rateLimited: 0,
    invalid: 0,
  };
  /** Why the last refused offer was refused. */
  lastRefusal: Refusal | null = null;

  private readonly ticksPerMinute: number;
  private perSecond = 0;
  private perMinute = 0;
  private purse: Purse | null = null;
  private accepted: Proposal[] = [];
  private readonly keys = new Set<string>();
  /** Keys refused for the rest of the tick (veto); cleared by begin. */
  private readonly vetoedKeys = new Set<string>();
  private readonly acceptedByClass = new Map<IntentClass, number>();
  /** Ticks of sends in the last minute, by class (oldest first). */
  private readonly window = new Map<IntentClass, number[]>();
  private log: string[] = [];
  private tick = 0;
  /** Tick of our last cancel_attack or cancel_boat send (DUP_GUARD_TICKS). */
  private lastCancel = -Infinity;

  /**
   * `msPerTick`: pass `game.config().msPerTick()`; class caps count sends in
   * the last 60,000/msPerTick ticks of game time. (Not in spec §2.6, which
   * leaves the minute's length unsaid. The default, for callers without a
   * game, is what Config.msPerTick returns today.)
   */
  constructor(
    private readonly o: SchedulerOptions,
    msPerTick: number = DEFAULT_MS_PER_TICK,
  ) {
    this.ticksPerMinute = Math.max(1, Math.round(60_000 / msPerTick));
  }

  /**
   * Package WP1 (docs/14-m4-plan.md §2.2): takes the memory another
   * Scheduler carries from tick to tick, the per-class send windows and the
   * tick of the last cancel (DUP_GUARD_TICKS), so a rollout copy of the
   * policy starts where the live one is. A fresh Scheduler starts its class
   * caps empty and would send what the live one is capped out of. Stats and
   * everything begin resets are not copied.
   */
  copyFrom(other: Scheduler): void {
    this.window.clear();
    for (const [cls, ticks] of other.window) this.window.set(cls, [...ticks]);
    this.lastCancel = other.lastCancel;
  }

  /**
   * Package WP1: refuses offers with this key until the next begin, as if
   * the key had been taken this tick (Refusal "key"; stats.vetoed counts
   * them). The policy vetoes `ally:<id>` and `ext:<id>` of the search's foe
   * marks after each begin: no alliance request, extension or
   * counter-accept goes to a foe.
   */
  veto(key: string): void {
    this.vetoedKeys.add(key);
  }

  /** Start of tick: copies ctx.budget(). Drops whatever an earlier tick
   *  accepted and did not flush, and the last tick's vetoes. */
  begin(tick: number, remaining: IntentBudgetRemaining, purse: Purse): void {
    this.tick = tick;
    this.perSecond = remaining.perSecond;
    this.perMinute = remaining.perMinute;
    this.purse = purse;
    this.accepted = [];
    this.keys.clear();
    this.vetoedKeys.clear();
    this.acceptedByClass.clear();
    const oldest = tick - this.ticksPerMinute;
    for (const ticks of this.window.values()) {
      let drop = 0;
      while (drop < ticks.length && ticks[drop] <= oldest) drop++;
      if (drop > 0) ticks.splice(0, drop);
    }
  }

  /** Accepts if the budget allows (Prio ≥ Snack must leave the reserves
   *  free) and the class cap allows, then debits the purse. False: nothing
   *  reserved, try later. */
  offer(p: Proposal): boolean {
    this.stats.offered++;
    const refusal = this.check(p);
    if (refusal !== null) {
      this.lastRefusal = refusal;
      this.stats.refused[refusal]++;
      if (refusal === "classCap") {
        const c = this.stats.classCapped;
        c[p.cls] = (c[p.cls] ?? 0) + 1;
      }
      return false;
    }
    this.accepted.push(p);
    if (p.key !== undefined) this.keys.add(p.key);
    this.acceptedByClass.set(p.cls, (this.acceptedByClass.get(p.cls) ?? 0) + 1);
    this.stats.accepted++;
    return true;
  }

  /** Intents a proposal of this priority could still get this tick. */
  intentsLeft(prio: Prio): number {
    const used = this.accepted.length;
    if (prio >= Prio.Snack) {
      return Math.max(
        0,
        Math.min(
          this.perSecond - this.o.reservePerSecond,
          this.perMinute - this.o.reservePerMinute,
        ) - used,
      );
    }
    return Math.max(0, Math.min(this.perSecond, this.perMinute) - used);
  }

  /** Sends of this class the cap still allows this tick (Infinity if
   *  uncapped). */
  classLeft(cls: IntentClass): number {
    const cap = this.o.classCapsPerMinute[cls];
    if (cap === undefined) return Infinity;
    const used =
      (this.window.get(cls)?.length ?? 0) +
      (this.acceptedByClass.get(cls) ?? 0);
    return Math.max(0, cap - used);
  }

  /** Whether a proposal with this key was accepted this tick (not in spec
   *  §2.6: lets a later controller see an earlier one's target, e.g. a boat
   *  skips a tribe the allocator launched at by land this decision). */
  hasKey(key: string): boolean {
    return this.keys.has(key);
  }

  /** Tick of the newest send of `cls` in the last minute, or null (not in
   *  spec §2.6). */
  lastSent(cls: IntentClass): number | null {
    const ticks = this.window.get(cls);
    return ticks === undefined || ticks.length === 0
      ? null
      : ticks[ticks.length - 1];
  }

  /**
   * Whether one more send of `cls` now, then one every `interval` ticks,
   * keeps the class within its cap at every tick of the coming minute, the
   * sends in the window aging out as they do (not in spec §2.6). Checked
   * now and at the last tick each send in the window still counts, where
   * the count peaks. True if the class is uncapped.
   */
  paceOk(cls: IntentClass, tick: number, interval: number): boolean {
    const cap = this.o.classCapsPerMinute[cls];
    if (cap === undefined) return true;
    const W = this.ticksPerMinute;
    const old = this.window.get(cls) ?? [];
    const now = (this.acceptedByClass.get(cls) ?? 0) + 1;
    const step = Math.max(1, interval);
    const at = (tau: number) => {
      let n = now + Math.floor((tau - tick) / step);
      for (const ts of old) if (ts > tau - W) n++;
      return n;
    };
    if (at(tick) > cap) return false;
    for (const ts of old) {
      const tau = ts + W - 1;
      if (tau >= tick && at(tau) > cap) return false;
    }
    return at(tick + W - 1) <= cap;
  }

  /** Sends the accepted proposals in priority order via ctx.send and
   *  records them in the Ledger. A "rate_limited" result (should never
   *  happen) is logged and ends the flush. */
  flush(
    send: (i: AgentIntent) => SendResult,
    ledger: Ledger,
    tick: number,
  ): void {
    // Array.prototype.sort is stable: equal priorities keep offer order.
    const queue = this.accepted.slice().sort((a, b) => a.prio - b.prio);
    this.accepted = [];
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      const r = send(p.intent);
      if (r === "ok") {
        this.stats.sent++;
        if (
          p.intent.type === "cancel_attack" ||
          p.intent.type === "cancel_boat"
        ) {
          this.lastCancel = tick;
        }
        ledger.recordSend(p.intent, tick, p.plan ?? null, p.meta);
        let ticks = this.window.get(p.cls);
        if (ticks === undefined) {
          ticks = [];
          this.window.set(p.cls, ticks);
        }
        ticks.push(tick);
        continue;
      }
      if (r === "invalid") {
        this.stats.invalid++;
        this.note(`[${tick}] invalid ${p.cls} ${p.intent.type}`);
        continue;
      }
      if (r === "rate_limited") {
        this.stats.rateLimited++;
        this.note(
          `[${tick}] rate limited at ${p.cls} ${p.intent.type}; ` +
            `dropped ${queue.length - i} of ${queue.length}`,
        );
      }
      return; // rate_limited or game_over: nothing later can go out
    }
  }

  /** Log lines since the last call (rate-limited and invalid sends). */
  takeLog(): string[] {
    const out = this.log;
    this.log = [];
    return out;
  }

  private check(p: Proposal): Refusal | null {
    if (this.purse === null) return "notBegun";
    if (p.key !== undefined && this.keys.has(p.key)) return "key";
    if (p.key !== undefined && this.vetoedKeys.has(p.key)) {
      this.stats.vetoed++;
      return "key";
    }
    if (p.intent.type === "attack") {
      const since = this.tick - this.lastCancel;
      if (since >= DUP_GUARD_TICKS[0] && since <= DUP_GUARD_TICKS[1]) {
        return "dupGuard";
      }
    }
    if (this.intentsLeft(p.prio) < 1) return "budget";
    if (this.classLeft(p.cls) < 1) return "classCap";
    if (p.spend !== undefined && !this.purse.take(p.spend.kind, p.spend.troops))
      return "purse";
    return null;
  }

  private note(line: string): void {
    if (this.log.length < MAX_LOG) this.log.push(line);
  }
}
