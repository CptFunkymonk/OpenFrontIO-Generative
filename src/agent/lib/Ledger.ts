import { Game, Player, PlayerID, UnitType } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { AgentIntent } from "../Agent";

// Our attacks by target, plans, and the sends of this tick (spec §2.5).
//
// One plan per target (smallID, 0 = TN). A plan is made by the first send
// that names a PlanKind and lives while an attack of ours on the target is
// running, a send to it is still pending, or (boat plans) one of our boats
// may still be carrying it: a ship of ours, not retreating, whose landing
// tile the target owns (with `game`; without it, any ship of ours at sea).
// `observe` drops the rest.
//
// Attacks merge [PIN AttackMerge]: a new land attack absorbs every earlier
// attack of ours on the same target, boat landings and retreating attacks
// included, under a NEW attack id. So a send is "pending" from the tick it is
// sent until the first observe that sees a new land-attack id on its target
// (the next tick at latency 1: a send at ctx.tick T runs in turn T, spec
// §2.1), and `stackOn` counts it until then. A send whose attack never
// appears (refused at init, or cancelled by a larger counter-attack) stops
// counting after PENDING_TTL ticks.
//
// Ships (not in spec §2.5): each of our transports is matched, the first
// tick it is seen, to the boat send it carries (by landing tile), and keeps
// that send's target and expected refund while at sea (`ships`), and for
// GONE_TTL ticks after (landed, sunk or home). The landing tile's owner can
// change during the voyage while the ship's target does not (it is read at
// launch, TransportShipExecution.ts:75), so a ship is judged against its
// send, not against whoever owns the landing now. `expectedRefunds` counts
// ships at sea too: a plan's refund counts only while its attack, retreat
// or send is in play, and a ship at sea is none of these.

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

/** One transport of ours and the boat send it carries. Plain data. */
export interface ShipRecord {
  /** Unit id. */
  id: number;
  /** The send's target smallID (0 = free land; the landing tile's owner at
   *  the first sight if no send matched). */
  target: number;
  /** The ship's landing tile. */
  dst: TileRef;
  /** Tick of the send (of the first sight if none matched). */
  sentAt: number;
  /** Troops when last seen at sea. */
  troops: number;
  /** The send's expected refund (a tribe landing's S − cost; 0 for free
   *  land). */
  refund: number;
  /** Troops expected home from it, at the last observe (expectedRefunds). */
  expect: number;
  retreating: boolean;
  /** Tick it was first missing (landed, sunk or home); null at sea. */
  goneAt: number | null;
}

/** A boat send not yet matched to a ship. Plain data. */
export interface BoatSend {
  dst: TileRef;
  target: number;
  troops: number;
  refund: number;
  tick: number;
}

export interface LedgerData {
  plans: TargetPlan[];
  sentThisTick: AgentIntent[];
  tick: number;
  /** Sends not yet seen as attacks (absent = none). */
  pending?: PendingSend[];
  /** Our attack ids at the last observe (absent = none). */
  seen?: string[];
  /** Our ships, at sea and gone for less than GONE_TTL (absent = none). */
  ships?: ShipRecord[];
  /** Boat sends not yet matched to a ship (absent = none). */
  boatSends?: BoatSend[];
}

/**
 * The smallIDs (0 = TN) owning the landing tiles of our ships at sea, not
 * retreating: the targets a boat plan may still be waiting on. A ship's
 * landing tile is where it conquers and starts its attack
 * (TransportShipExecution.ts:246-280), so its owner there is the target;
 * a retreating ship heads to our own shore. Without `game` a tile's owner
 * is unknown: "any" if a ship of ours is at sea (every boat plan lives).
 *
 * Keyed by ship rather than kept for any ship at sea: with 3 ships always
 * out on a water map, boat plans on tribes whose landing had long ended
 * piled up (7-11 open on North America and Passage, arena quick@4), and
 * each one kept its tribe busy for land launches, snacks and boats.
 */
function shipTargets(
  me: Player,
  game: Game | undefined,
): ReadonlySet<number> | "any" {
  if (game === undefined) {
    return me.unitCount(UnitType.TransportShip) > 0 ? "any" : new Set();
  }
  const out = new Set<number>();
  for (const u of me.units(UnitType.TransportShip)) {
    const dst = u.targetTile();
    if (dst === undefined || u.transportShipState().isRetreating) continue;
    out.add(game.ownerID(dst));
  }
  return out;
}

/** PendingSend.target of an attack whose target smallID is not known yet. */
export const UNRESOLVED = -1;
/** Ticks a send counts in stackOn, and keeps its plan, without its attack
 *  showing. At latency 1 every accepted attack shows the next tick, so this
 *  only covers a longer browser latency, and refused sends. */
export const PENDING_TTL = 5;
/** A tick before every real tick (and, unlike -Infinity, JSON-safe). */
const BEFORE_GAME = -1;
/** Ticks a ship's record is kept after it is gone (NavalController holds a
 *  landed free-land boat's landmass for up to this long). */
export const GONE_TTL = 200;
/** Share of a transport's troops that dies when it arrives on our own tile
 *  or retreats home (malusForRetreat, TransportShipExecution.ts:32; private
 *  there) [PIN BoatsAndWin]. */
export const BOAT_RETREAT_MALUS = 0.25;

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
  private ships = new Map<number, ShipRecord>();
  private boatSends: BoatSend[] = [];

  /** `tick`: the tick sentThisTick belongs to (default: before the game). */
  constructor(tick = BEFORE_GAME) {
    this.tick = tick;
  }

  /** Every tick: reconciles plans with me.outgoingAttacks(); drops finished
   *  ones. `game` tells a boat plan's ships apart from other boats' (without
   *  it, every boat plan lives while any ship of ours is at sea). */
  observe(me: Player, tick: number, game?: Game): void {
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

    this.observeShips(me, tick, game);

    let ships: ReadonlySet<number> | "any" | null = null;
    for (const [t, plan] of this.plans) {
      if (live.has(t) || retreat.has(t) || this.pendingOn(t) > 0) continue;
      if (plan.kind === "boat") {
        if (tick - plan.lastSend <= PENDING_TTL) continue;
        ships ??= shipTargets(me, game);
        if (ships === "any" || ships.has(t)) continue;
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
    } else if (intent.type === "boat") {
      this.boatSends.push({
        dst: intent.dst,
        target: meta?.target ?? 0,
        troops: intent.troops ?? 0,
        refund: meta?.expectedRefund ?? 0,
        tick,
      });
      if (meta?.target !== undefined) {
        this.upsert(meta.target, kind ?? "boat", tick, meta, true);
      }
    }
  }

  /** Our ships at sea (goneAt null) and gone for less than GONE_TTL, by
   *  unit id. */
  allShips(): readonly ShipRecord[] {
    return [...this.ships.values()].sort((a, b) => a.id - b.id);
  }

  /** The record of our ship `id`, if any. */
  ship(id: number): ShipRecord | undefined {
    return this.ships.get(id);
  }

  /**
   * Matches new ships to boat sends (the send whose landing tile is the
   * ship's, else the nearest, else the oldest), marks gone ones, and prices
   * each ship at sea for expectedRefunds:
   * - retreating: its troops less BOAT_RETREAT_MALUS;
   * - landing tile still its target's: min(refund, troops) (a free-land
   *   landing spends its troops: 0);
   * - landing tile ours now: it lands home with the malus;
   * - anyone else's: all its troops (the landing attack on the old target
   *   finds nothing next to it and comes home in full,
   *   TransportShipExecution.ts:271-283, AttackExecution.ts:302-305).
   * Without `game` a landing's owner is unknown: priced as its target's.
   */
  private observeShips(me: Player, tick: number, game?: Game): void {
    this.boatSends = this.boatSends.filter((b) => tick - b.tick <= PENDING_TTL);
    const here = new Set<number>();
    if (me.unitCount(UnitType.TransportShip) > 0) {
      const mine = me.smallID();
      for (const u of me.units(UnitType.TransportShip)) {
        const id = u.id();
        here.add(id);
        const dst = u.targetTile() ?? -1;
        let r = this.ships.get(id);
        if (r === undefined) {
          const b = this.matchSend(dst, game);
          r = {
            id,
            target:
              b?.target ??
              (game !== undefined && dst >= 0 ? game.ownerID(dst) : 0),
            dst,
            sentAt: b?.tick ?? tick,
            troops: u.troops(),
            refund: b?.refund ?? 0,
            expect: 0,
            retreating: false,
            goneAt: null,
          };
          this.ships.set(id, r);
        }
        r.troops = u.troops();
        r.retreating = u.transportShipState().isRetreating;
        r.goneAt = null;
        const owner =
          game !== undefined && dst >= 0 ? game.ownerID(dst) : r.target;
        if (r.retreating || owner === mine) {
          r.expect = r.troops * (1 - BOAT_RETREAT_MALUS);
        } else if (owner === r.target) {
          r.expect = r.target === 0 ? 0 : Math.min(r.refund, r.troops);
        } else {
          r.expect = r.troops;
        }
      }
    }
    for (const [id, r] of this.ships) {
      if (here.has(id)) continue;
      r.goneAt ??= tick;
      r.expect = 0;
      if (tick - r.goneAt > GONE_TTL) this.ships.delete(id);
    }
  }

  /** Takes the boat send that ship landing tile `dst` belongs to. */
  private matchSend(dst: TileRef, game?: Game): BoatSend | undefined {
    if (this.boatSends.length === 0) return undefined;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.boatSends.length; i++) {
      const b = this.boatSends[i];
      const d =
        b.dst === dst
          ? -1
          : game !== undefined && dst >= 0
            ? game.manhattanDist(b.dst, dst)
            : Infinity;
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return this.boatSends.splice(best, 1)[0];
  }

  /** Troops expected home when our plans end: each plan's expectedRefund,
   *  at most the troops still in its attacks and pending sends, and each
   *  ship's at sea (observeShips). */
  expectedRefunds(): number {
    let sum = 0;
    for (const r of this.ships.values()) {
      if (r.goneAt === null) sum += r.expect;
    }
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
      ships: [...this.allShips()],
      boatSends: this.boatSends,
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
    for (const r of data.ships ?? []) l.ships.set(r.id, r);
    l.boatSends = data.boatSends ?? [];
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
