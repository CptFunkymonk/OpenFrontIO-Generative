import {
  Game,
  Player,
  PlayerID,
  PlayerType,
  TerrainType,
} from "../../../../core/game/Game";
import type { PlanKind } from "../../../lib/Ledger";
import type { Models, TerrainMix } from "../../../lib/Models";
import { IntentClass, Prio, Proposal, SpendKind } from "../../../lib/Scheduler";
import type { NeighborInfo } from "../../../lib/WorldModel";
import type { ApexOptions } from "../options";
import type { Controller, View } from "../policy";
import type { ApexState } from "../state";

// The allocator (spec §3.6): every decision it spends the Purse in the
// order below, each item through scheduler.offer. A budget refusal stops the
// allocator for the decision; a class-cap refusal stops that class; a purse
// refusal skips the item.
//
//   §3.6.1 snacks          tribes of <= 100 tiles fall to their first lost tile
//   §3.6.5 pokes           an enclosed inland tribe is ours after one tile
//   §3.6.2 top-ups         running tribe/snipe/strike attacks below the clamp
//   §3.6.3 free land (TN)  cadence and minimum chunk
//   §3.6.4 tribe launches  clamp-sized, by land per troop, one per tribe
//   §3.6.6 stall mode      tribes at stallRatio when nothing else takes troops
//   §3.6.7 cap headroom    no launch whose refund would be clamped away (C2)
//
// Pokes run second, not fifth as in §3.6: a poke costs pokeTroops and takes
// the whole tribe, a launch on the same tribe would lock its clamp stack.
//
// Every send to a tribe that is attacking us carries that attack's troops
// on top of its own stack: the new attack cancels it 1:1 at init and dies
// there if it is the smaller (AttackExecution.ts:157-170) [PIN AttackMerge].
// Without this, snacks on counter-attacking tribes were cancelled at launch
// and launches started below their clamp (Europe, arena apex-k1).
//
// Pure given (View, ApexState): no ctx.random, no clock, no memory outside
// ApexState. `s.nearTribes` is a by-product of the last decision's border
// scans that the policy adds to its NationModel refresh list (package WP1
// moved it into the state, docs/14-m4-plan.md §2.2).

/** A tribe of at most this many tiles falls to its first lost tile:
 *  handleDeadDefender conquers a player left under 100 tiles
 *  (AttackExecution.ts:448-449), gold included [PIN TribeStats: "a 100-tile
 *  one (not a 101-tile one)"; spec §3.6.1 says "< 100"]. A rule of the
 *  attack loop, not a config value. */
export const SNACK_TILES = 100;
/** The tiles a tribe attack pays for are n − KILL_FREE: the last 99
 *  collapse with the tile that takes it under 100 (the same rule). */
export const KILL_FREE = 99;
/** Mean of the border jitter nextInt(0, 5) (AttackExecution.ts:291). */
export const BORDER_JITTER = 2;
/** Ticks between two poke windows of one tribe: longer than the 20-tick
 *  cluster check (PlayerExecution.ts:27, :120-133) plus the latency, so a
 *  poked tribe is absorbed before its next window. The window is a pure
 *  function of (tick, smallID), so no memory is needed. */
export const POKE_EVERY = 30;
/** Spreads the tribes' poke windows over POKE_EVERY. */
const POKE_STRIDE = 7;
/** Tribes whose contest and buffer weights (one border scan each) are
 *  computed per decision: the best by unweighted score. */
export const MAX_WEIGHTED = 16;
/** Smallest partial top-up, as a share of the full one. A partial top-up
 *  still lowers the loss of every remaining tile, and its troops come home
 *  at the kill. */
export const MIN_TOPUP_SHARE = 0.25;
/** Ticks the target's own attacks run before a snack sent now takes its
 *  first tile: the intent inits at the end of turn T, the tile falls in
 *  turn T + 1, and the tribe's executions tick first in both (spec §2.1). */
const SNACK_LEAD_TICKS = 2;
/** A free-land stack this many times the saturation point is saturated
 *  (used to read the saturated pace back from attackLogic). */
const SATURATED = 4;

/** What the sizing formulas read about a tribe (or, for a strike plan's
 *  top-ups, a nation). */
export interface TribeTarget {
  /** Default Bot. attackLogic cuts the defender's losses to 0.7 only
   *  against a Bot (BOT_DEFENDER_LOSS_MULT, Config.ts:913-920), so a
   *  nation typed as a Bot would cost 30% too little. */
  type?: PlayerType;
  tiles: number;
  troops: number;
  isTraitor: boolean;
  /** Adjacency pairs with our border (NeighborInfo.contact). */
  contact: number;
  contactMix: TerrainMix;
}

/** §3.6.4, for one tribe at one ratio. */
export interface TribeSizing {
  /** D / ratio: the stack at the loss clamp. */
  A0: number;
  /** Loss per tile at A0 (models.hitMix). */
  p: number;
  /** Tiles per tick at A0. */
  v: number;
  /** Tiles paid for: max(0, n − 99). */
  k: number;
  /** Ticks to the kill: k / v. */
  tau: number;
  /** Clamp headroom lost per tile: max(0, p − d/ratio). */
  drift: number;
  /** The launch stack S_b. */
  S: number;
  /** p·k. */
  cost: number;
  /** max(0, S − cost), home at the kill. */
  refund: number;
}

/**
 * §3.6.4:
 *   A0 = D/ratio; r = hitMix(us, {Bot, n, D}, A0, mix, c + 2);
 *   p = r.loss, v = r.tilesPerTick, k = max(0, n − 99), τ = k/v,
 *   drift = max(0, p − d/ratio),
 *   S = margin·(D + g·τ)/ratio + drift·min(k, v·burnWindow),
 *   cost = p·k, refund = max(0, S − cost).
 */
export function tribeSizing(
  models: Models,
  ourTiles: number,
  b: TribeTarget,
  regrowth: number,
  ratio: number,
  o: Pick<ApexOptions, "tribeMargin" | "tribeBurnWindow">,
): TribeSizing {
  const D = b.troops;
  const n = b.tiles;
  const d = D / Math.max(1, n);
  const A0 = D / ratio;
  const r = models.hitMix(
    ourTiles,
    {
      type: b.type ?? PlayerType.Bot,
      tiles: n,
      troops: D,
      isTraitor: b.isTraitor,
    },
    A0,
    b.contactMix,
    b.contact + BORDER_JITTER,
  );
  const p = r.loss;
  const v = r.tilesPerTick;
  const k = Math.max(0, n - KILL_FREE);
  const tau = k / v;
  const drift = Math.max(0, p - d / ratio);
  const S =
    (o.tribeMargin * (D + Math.max(0, regrowth) * tau)) / ratio +
    drift * Math.min(k, v * o.tribeBurnWindow);
  const cost = p * k;
  return { A0, p, v, k, tau, drift, S, cost, refund: Math.max(0, S - cost) };
}

/**
 * §3.6.2 for a running attack of A troops:
 *   need = margin·D/ratio; if A < topUpAt·need:
 *   add = need − A + drift·min(k, v·burnWindow)   (drift, k, v as in §3.6.4).
 * Returns add = 0 when no top-up is due by the stack.
 */
export function topUpSizing(
  models: Models,
  ourTiles: number,
  b: TribeTarget,
  A: number,
  ratio: number,
  o: Pick<ApexOptions, "tribeMargin" | "tribeBurnWindow" | "tribeTopUpAt">,
): { need: number; add: number; p: number; k: number } {
  const D = b.troops;
  const n = b.tiles;
  const need = (o.tribeMargin * D) / ratio;
  const k = Math.max(0, n - KILL_FREE);
  const r = models.hitMix(
    ourTiles,
    {
      type: b.type ?? PlayerType.Bot,
      tiles: n,
      troops: D,
      isTraitor: b.isTraitor,
    },
    need,
    b.contactMix,
    b.contact + BORDER_JITTER,
  );
  if (!(A < o.tribeTopUpAt * need)) return { need, add: 0, p: r.loss, k };
  const drift = Math.max(0, r.loss - D / Math.max(1, n) / ratio);
  const add =
    need - A + drift * Math.min(k, r.tilesPerTick * o.tribeBurnWindow);
  return { need, add: Math.max(0, add), p: r.loss, k };
}

/** The costliest terrain present in a mix (plains when empty). */
function worstTerrain(mix: TerrainMix): TerrainType {
  if (mix.mountain > 0) return TerrainType.Mountain;
  if (mix.highland > 0) return TerrainType.Highland;
  return TerrainType.Plains;
}

/**
 * §3.6.1: s = min(snackMax, ceil(snackSafety·firstTileLoss) + 1), with the
 * first-tile loss on the costliest terrain of the contact. The attack pays
 * min(s, that loss) and the rest comes home [PIN TribeStats: any stack of
 * >= 1 troop takes the first tile, so snackSafety 0 (s = 1) is the cheapest
 * snack].
 */
export function snackStack(
  models: Models,
  ourTiles: number,
  b: Pick<TribeTarget, "tiles" | "troops" | "isTraitor" | "contactMix">,
  o: Pick<ApexOptions, "snackSafety" | "snackMax">,
): number {
  const loss = models.firstTileLoss(
    ourTiles,
    {
      type: PlayerType.Bot,
      tiles: b.tiles,
      troops: b.troops,
      isTraitor: b.isTraitor,
    },
    worstTerrain(b.contactMix),
  );
  return Math.max(1, Math.min(o.snackMax, Math.ceil(o.snackSafety * loss) + 1));
}

/** §3.6.3's numbers for one decision. */
export interface TnPlan {
  sat: number;
  price: number;
  burn: number;
  want: number;
  due: boolean;
  /** Troops to send (0: nothing is due). */
  send: number;
}

/**
 * §3.6.3:
 *   S_sat = tnSaturation(mix), p_TN = tnPrice(mix),
 *   burn = p_TN·pace(F + 2)·tnHorizon (pace: the saturated tiles per tick,
 *          ceil(0.4·border), read back from attackLogic),
 *   want = tnSat·S_sat + burn,
 *   due = no plan ∨ tick − lastSend ≥ tnHorizon ∨ A_TN < 0.5·S_sat,
 *   if F > 0 ∧ due ∧ A_TN < 0.6·want: send = min(want − A_TN, available),
 *   sent only if ≥ min(tnMinChunk·want, S_sat).
 * `early` false drops the A_TN < 0.5·S_sat clause (o.tnPace, when the tn
 * class cap could not carry the sends it adds).
 */
export function tnPlan(
  models: Models,
  F: number,
  mix: TerrainMix,
  A: number,
  lastSend: number | null,
  tick: number,
  available: number,
  o: Pick<ApexOptions, "tnSat" | "tnHorizon" | "tnMinChunk">,
  early = true,
): TnPlan {
  const sat = models.tnSaturation(mix);
  const price = models.tnPrice(mix);
  const pace = models.tilesPerTick(
    models.tn(TerrainType.Plains, sat * SATURATED, F + BORDER_JITTER),
  );
  const burn = price * pace * o.tnHorizon;
  const want = o.tnSat * sat + burn;
  const due =
    lastSend === null ||
    tick - lastSend >= o.tnHorizon ||
    (early && A < 0.5 * sat);
  let send = 0;
  if (F > 0 && due && A < 0.6 * want) {
    const s = Math.min(want - A, available);
    if (s >= Math.min(o.tnMinChunk * want, sat)) send = Math.floor(s);
  }
  return { sat, price, burn, want, due, send };
}

/** Whether apex is in stall mode (§3.6.6): the stall condition has held for
 *  o.stallTicks. The ExpansionController updates s.stall.since each
 *  decision; controllers after it (Naval, Strike) read this. Also while an
 *  enemy bomb in flight will cut the cap below home (o.nukeReflex, s.nuke,
 *  set by the policy each decision): the troops above the cap left after
 *  the blast are lost the tick after it lands [PIN TroopCapClamp], so they
 *  are spent as at the cap. */
export function inStall(s: ApexState, tick: number, o: ApexOptions): boolean {
  if (o.nukeReflex && s.nuke !== null && s.nuke !== undefined) return true;
  return (
    o.stall && s.stall.since !== null && tick - s.stall.since >= o.stallTicks
  );
}

// ── Launch eligibility, shared with NavalController.blocked ─────────────

/** Tribe and snipe plans running (what maxTribeAttacks counts). */
export function activeTribePlans(v: Pick<View, "ledger">): number {
  let active = 0;
  for (const plan of v.ledger.allPlans()) {
    if (plan.kind === "tribe" || plan.kind === "snipe") active++;
  }
  return active;
}

/** Whether the Ledger holds a plan, a stack (live or pending) or a
 *  retreating attack on the target. */
export function ledgerBusy(v: Pick<View, "ledger">, sid: number): boolean {
  const l = v.ledger;
  return (
    l.plan(sid) !== undefined || l.stackOn(sid) > 0 || l.retreatingOn(sid) > 0
  );
}

/**
 * Troops of the target's attacks on us. A new attack on it first cancels
 * them 1:1 at init, and dies there if they are larger
 * (AttackExecution.ts:157-170) [PIN AttackMerge], so every send to it
 * carries them on top of its own stack.
 */
export function incomingFrom(v: Pick<View, "wm">, sid: number): number {
  let sum = 0;
  for (const a of v.wm.incoming) {
    if (a.attackerSmallID === sid) sum += a.troops;
  }
  return sum;
}

/** Tiles per tick the tribe's own land attacks take now (an upper-ish
 *  estimate: every attack at its saturated or current pace). */
export function tribeGrowthPerTick(models: Models, p: Player): number {
  let sum = 0;
  for (const a of p.outgoingAttacks()) {
    if (a.sourceTile() !== null || a.retreating()) continue;
    const r = models.tn(
      TerrainType.Plains,
      a.troops(),
      a.borderSize() + BORDER_JITTER,
    );
    sum += models.tilesPerTick(r);
  }
  return sum;
}

/** What the sizing formulas read about bordering tribe `b`. */
export function tribeTarget(b: NeighborInfo, p: Player): TribeTarget {
  return {
    type: p.type(),
    tiles: b.tiles,
    troops: b.troops,
    isTraitor: p.isTraitor(),
    contact: b.contact,
    contactMix: b.contactMix,
  };
}

/**
 * §3.6.1: the snack stack for bordering tribe `b` (player `p`), or null:
 * over SNACK_TILES, growing past it before our first tile falls, or its
 * stack (plus its attacks on us) over purse.available("snack").
 */
export function snackSend(
  v: Pick<View, "models" | "wm" | "purse" | "o">,
  b: NeighborInfo,
  p: Player,
): number | null {
  if (b.tiles > SNACK_TILES) return null;
  // Still under the line when our first tile falls?
  if (
    b.tiles + SNACK_LEAD_TICKS * tribeGrowthPerTick(v.models, p) >
    SNACK_TILES
  ) {
    return null;
  }
  const troops =
    snackStack(v.models, v.wm.tiles, tribeTarget(b, p), v.o) +
    Math.ceil(incomingFrom(v, b.smallID));
  return troops > v.purse.available("snack") ? null : troops;
}

/** A tribe launch that fits: its sizing and the troops of its attacks on
 *  us, which the send carries on top. */
export interface TribeLaunch {
  sizing: TribeSizing;
  cancel: number;
}

/**
 * §3.6.4 eligibility of bordering tribe `b` at `ratio`: over SNACK_TILES,
 * S_b plus its attacks on us within purse.available("tribe"), and a loss per
 * tile within tribeMaxPrice·priceScale of the free-land price. Null
 * otherwise. (Not busy, the launch count and cap headroom are the
 * caller's.)
 */
export function tribeLaunch(
  v: Pick<View, "models" | "wm" | "purse" | "o">,
  b: NeighborInfo,
  p: Player,
  ratio: number,
  priceScale: number,
): TribeLaunch | null {
  const { o, models } = v;
  if (b.tiles <= SNACK_TILES) return null;
  const sizing = tribeSizing(
    models,
    v.wm.tiles,
    tribeTarget(b, p),
    models.regrowth(p),
    ratio,
    o,
  );
  const cancel = incomingFrom(v, b.smallID);
  if (sizing.S + cancel > v.purse.available("tribe")) return null;
  const maxPrice = o.tribeMaxPrice * priceScale * models.tnPrice(b.contactMix);
  if (sizing.p > maxPrice) return null;
  return { sizing, cancel };
}

/**
 * §3.6.7: whether a launch of S troops with expected refund `refund`
 * leaves home plus every expected refund (the Ledger's, `extra` more)
 * within cap·(1 + headroomSlack).
 */
export function headroomOk(
  v: Pick<View, "purse" | "ledger" | "o">,
  S: number,
  refund: number,
  extra = 0,
): boolean {
  const cap = v.purse.floors.cap;
  return (
    v.purse.home - S + v.ledger.expectedRefunds() + extra + refund <=
    cap + v.o.headroomSlack * cap
  );
}

/** One pass over a tribe's border tiles. */
export interface TribeScan {
  /** The PlayerExecution cluster check would hand it to us (§3.6.5, C10):
   *  no border tile on an ocean shore or the map edge, and every
   *  4-neighbour of a border tile is the tribe's or ours (no unowned land,
   *  no water, no other owner). */
  enclosed: boolean;
  /** smallIDs of the Nation-type players touching it, ascending. */
  nations: number[];
}

export function scanTribe(game: Game, b: Player, us: number): TribeScan {
  const bid = b.smallID();
  let enclosed = true;
  const others = new Set<number>();
  const visit = (n: number) => {
    const owner = game.ownerID(n);
    if (owner === bid || owner === us) return;
    enclosed = false;
    if (owner !== 0) others.add(owner);
  };
  b.borderTiles().forEach((t) => {
    if (enclosed && (game.isOceanShore(t) || game.isOnEdgeOfMap(t))) {
      enclosed = false;
    }
    game.forEachNeighbor(t, visit);
  });
  const nations: number[] = [];
  for (const id of others) {
    const p = game.playerBySmallID(id);
    if (p.isPlayer() && p.type() === PlayerType.Nation) nations.push(id);
  }
  nations.sort((a, c) => a - c);
  return { enclosed, nations };
}

/** A tribe the launch step considers. */
interface Candidate {
  info: NeighborInfo;
  player: Player;
  sizing: TribeSizing;
  /** Troops of its attacks on us, cancelled first by the launch. */
  cancel: number;
  snipe: boolean;
  /** value·n/S·(snipe bonus), before contest and buffer. */
  base: number;
  score: number;
}

export class ExpansionController implements Controller {
  readonly name = "expansion";

  /** Nations touching the tribes scanned at the last decision, into
   *  s.nearTribes (for the policy's NationModel refresh list: contest and
   *  buffer read their NationState). */
  decide(v: View, s: ApexState): void {
    const run = new AllocatorRun(v, s);
    run.all();
    s.nearTribes = run.nearNations();
  }
}

/** One decision of the allocator. */
class AllocatorRun {
  private stopAll = false;
  private readonly stopped = new Set<IntentClass>();
  /** Targets given an attack this decision (one attack per tribe). */
  private readonly touched = new Set<number>();
  /** Expected refunds of the launches of this decision (§3.6.7). */
  private newRefunds = 0;
  private launches = 0;
  /** Whether a non-stall Expansion offer was accepted (§3.6.6 trigger). */
  private worked = false;
  private readonly scans = new Map<number, TribeScan>();
  private readonly o: ApexOptions;
  private readonly us: number;

  constructor(
    private readonly v: View,
    private readonly s: ApexState,
  ) {
    this.o = v.o;
    this.us = v.me.smallID();
  }

  all(): void {
    const { o, v, s } = this;
    const stallBefore = inStall(s, v.tick, o);
    // The streak's age crossed stallTicks since the last decision.
    if (stallBefore && !inStall(s, v.tick - o.thinkEvery, o)) {
      this.log("stall on");
    }
    if (o.snacks) this.snacks();
    if (o.pokes) this.pokes();
    if (o.topUps) this.topUps(stallBefore);
    if (o.tn) this.freeLand();
    if (o.tribes) this.tribes(o.tribeRatio, 1, !stallBefore && o.headroom);
    this.updateStall();
    const stall = inStall(s, v.tick, o);
    if (stallBefore && !stall) this.log("stall off");
    if (stall && o.stallTribes && o.tribes) {
      // Rule 1: tribes at stallRatio; the price is ×stallRatio/tribeRatio
      // but the troops would otherwise sit idle at the cap. Headroom is off.
      this.tribes(o.stallRatio, o.stallRatio / o.tribeRatio, false);
    }
  }

  nearNations(): PlayerID[] {
    const ids = new Set<number>();
    for (const sc of this.scans.values()) {
      for (const n of sc.nations) ids.add(n);
    }
    const out: PlayerID[] = [];
    for (const n of [...ids].sort((a, b) => a - b)) {
      const p = this.v.game.playerBySmallID(n);
      if (p.isPlayer()) out.push(p.id());
    }
    return out;
  }

  // ── Offers ─────────────────────────────────────────────────────────────

  private offer(p: Proposal): boolean {
    if (this.stopAll || this.stopped.has(p.cls)) return false;
    const sch = this.v.scheduler;
    if (sch.offer(p)) return true;
    const why = sch.lastRefusal;
    if (why === "budget" || why === "notBegun") this.stopAll = true;
    else if (why === "classCap") this.stopped.add(p.cls);
    return false;
  }

  /** Offers an attack on `sid` (0 = free land, id null). */
  private attack(
    sid: number,
    id: PlayerID | null,
    troops: number,
    o: {
      prio: Prio;
      cls: IntentClass;
      kind: SpendKind;
      plan?: PlanKind;
      clampTroops?: number;
      expectedRefund?: number;
    },
  ): boolean {
    const meta: Proposal["meta"] = { target: sid };
    if (o.clampTroops !== undefined) meta.clampTroops = o.clampTroops;
    if (o.expectedRefund !== undefined) meta.expectedRefund = o.expectedRefund;
    const ok = this.offer({
      intent: { type: "attack", targetID: id, troops },
      prio: o.prio,
      cls: o.cls,
      key: `attack:${sid}`,
      spend: { kind: o.kind, troops },
      plan: o.plan,
      meta,
    });
    if (ok) this.touched.add(sid);
    return ok;
  }

  private log(line: string): void {
    this.v.log?.(`${this.v.tick} ${line}`);
  }

  /** Whether we already have an attack, a pending send or a plan on it. */
  private busy(sid: number): boolean {
    return this.touched.has(sid) || ledgerBusy(this.v, sid);
  }

  private tribePlayer(sid: number): Player | null {
    const p = this.v.game.playerBySmallID(sid);
    return p.isPlayer() && p.isAlive() ? p : null;
  }

  private incomingFrom(sid: number): number {
    return incomingFrom(this.v, sid);
  }

  private scan(p: Player): TribeScan {
    const sid = p.smallID();
    let sc = this.scans.get(sid);
    if (sc === undefined) {
      sc = scanTribe(this.v.game, p, this.us);
      this.scans.set(sid, sc);
    }
    return sc;
  }

  // ── §3.6.1 Snacks ──────────────────────────────────────────────────────

  private snacks(): void {
    const { v } = this;
    for (const b of v.wm.tribes) {
      if (this.stopAll || this.stopped.has("snack")) return;
      if (b.tiles > SNACK_TILES || this.busy(b.smallID)) continue;
      const p = this.tribePlayer(b.smallID);
      if (p === null) continue;
      const troops = snackSend(v, b, p);
      if (troops === null) continue;
      if (
        this.attack(b.smallID, b.id, troops, {
          prio: Prio.Snack,
          cls: "snack",
          kind: "snack",
          plan: "snack",
          expectedRefund: 0,
        })
      ) {
        this.worked = true;
        this.log(`snack ${b.id} n=${b.tiles} s=${troops}`);
      }
    }
  }

  // ── §3.6.5 Enclose-and-poke ────────────────────────────────────────────

  private pokes(): void {
    const { v, o } = this;
    for (const b of v.wm.tribes) {
      if (this.stopAll || this.stopped.has("snack")) return;
      if (b.tiles <= SNACK_TILES || this.busy(b.smallID)) continue;
      // Its window: one decision in every POKE_EVERY ticks.
      if ((v.tick + POKE_STRIDE * b.smallID) % POKE_EVERY >= o.thinkEvery) {
        continue;
      }
      const p = this.tribePlayer(b.smallID);
      if (p === null || !this.scan(p).enclosed) continue;
      const troops =
        Math.max(1, Math.ceil(o.pokeTroops)) +
        Math.ceil(this.incomingFrom(b.smallID));
      if (troops > v.purse.available("snack")) continue;
      if (
        this.attack(b.smallID, b.id, troops, {
          prio: Prio.Snack,
          cls: "snack",
          kind: "snack",
          plan: "poke",
          expectedRefund: 0,
        })
      ) {
        this.worked = true;
        this.log(`poke ${b.id} n=${b.tiles} D=${Math.round(b.troops)}`);
      }
    }
  }

  // ── §3.6.2 Top-ups ─────────────────────────────────────────────────────

  private topUps(stall: boolean): void {
    const { v, o } = this;
    for (const plan of v.ledger.allPlans()) {
      if (this.stopAll || this.stopped.has("topup")) return;
      const kind = plan.kind;
      if (kind !== "tribe" && kind !== "snipe" && kind !== "strike") continue;
      // Package A1 (review F3): with window strikes on, the StrikeController
      // owns strike top-ups (timed before each decision of the target, under
      // its deterrence floor).
      if (kind === "strike" && o.strikes) continue;
      const sid = plan.targetSmallID;
      if (sid === 0 || this.touched.has(sid)) continue;
      if (v.tick - plan.lastSend < o.tribeTopUpEvery) continue;
      const A = v.ledger.stackOn(sid);
      if (A <= 0) continue;
      const p = this.tribePlayer(sid);
      if (p === null) continue;
      const info = v.wm.neighbors.get(sid);
      const b: TribeTarget = {
        type: p.type(),
        tiles: p.numTilesOwned(),
        troops: p.troops(),
        isTraitor: p.isTraitor(),
        contact: info?.contact ?? 0,
        contactMix: info?.contactMix ?? { plains: 0, highland: 0, mountain: 0 },
      };
      const ratio = stall && kind !== "strike" ? o.stallRatio : o.tribeRatio;
      const t = topUpSizing(v.models, v.wm.tiles, b, A, ratio, o);
      if (t.add <= 0) continue;
      const spend: SpendKind = kind === "strike" ? "strike" : "tribe";
      const add = t.add + this.incomingFrom(sid);
      const troops = Math.ceil(Math.min(add, v.purse.available(spend)));
      if (troops < MIN_TOPUP_SHARE * add || troops < 1) continue;
      const refund = Math.max(0, A + troops - t.p * t.k);
      if (
        this.attack(sid, p.id(), troops, {
          prio: Prio.TopUp,
          cls: "topup",
          kind: spend,
          clampTroops: t.need,
          expectedRefund: refund,
        })
      ) {
        this.worked = true;
        this.log(
          `topup ${p.id()} +${troops} A=${Math.round(A)} need=${Math.round(t.need)}`,
        );
      }
    }
  }

  // ── §3.6.3 Free land ───────────────────────────────────────────────────

  private freeLand(): void {
    const { v, o } = this;
    const F = v.wm.freeFrontier;
    if (F <= 0) return;
    // A retreating TN attack was cancelled on purpose (§3.3.3); a new TN
    // send would absorb it and undo the cancel [PIN AttackMerge].
    if (v.ledger.retreatingOn(0) > 0) return;
    // The land TN stack: a landed boat's free-land attack works its own
    // beachhead until a land send absorbs it [PIN AttackMerge], so it does
    // not feed our frontier, and a boat plan's send is not a TN send.
    let boats = 0;
    for (const a of v.wm.outgoing) {
      if (a.boat && a.targetSmallID === 0 && !a.retreating) boats += a.troops;
    }
    const A = Math.max(0, v.ledger.stackOn(0) - boats);
    const plan = v.ledger.plan(0);
    // o.tnPace: the early trigger only while the class cap can carry it and
    // the tnHorizon cadence after it (a decision every thinkEvery ticks).
    // The cadence counts from the last TN send even after its plan ended
    // (an attack that burnt out is no reason to send at once).
    const cadence = Math.ceil(o.tnHorizon / o.thinkEvery) * o.thinkEvery;
    const early = !o.tnPace || v.scheduler.paceOk("tn", v.tick, cadence);
    const last =
      plan?.kind === "tn"
        ? plan.lastSend
        : o.tnPace
          ? v.scheduler.lastSent("tn")
          : null;
    const t = tnPlan(
      v.models,
      F,
      v.wm.freeMix,
      A,
      last,
      v.tick,
      v.purse.available("tn"),
      o,
      early,
    );
    if (t.send <= 0) return;
    if (
      this.attack(0, null, t.send, {
        prio: Prio.TN,
        cls: "tn",
        kind: "tn",
        plan: "tn",
      })
    ) {
      this.worked = true;
      this.log(
        `tn ${t.send} A=${Math.round(A)} want=${Math.round(t.want)} F=${F}`,
      );
    }
  }

  // ── §3.6.4 Tribe launches ──────────────────────────────────────────────

  /**
   * Launches at `ratio`. `priceScale` scales tribeMaxPrice (stall rule 1
   * pays ×stallRatio/tribeRatio); `headroom` applies §3.6.7.
   */
  private tribes(ratio: number, priceScale: number, headroom: boolean): void {
    const { v, o } = this;
    if (this.stopAll || this.stopped.has("tribe")) return;
    if (v.purse.available("tribe") <= 0) return;
    let active = activeTribePlans(v);
    if (active >= o.maxTribeAttacks) return;

    const list: Candidate[] = [];
    for (const b of v.wm.tribes) {
      if (b.tiles <= SNACK_TILES || this.busy(b.smallID)) continue;
      const p = this.tribePlayer(b.smallID);
      if (p === null) continue;
      const launch = tribeLaunch(v, b, p, ratio, priceScale);
      if (launch === null) continue;
      const { sizing: sz, cancel } = launch;
      const value = 1 + (o.lambdaGold * Number(b.gold)) / Math.max(1, sz.cost);
      const snipe =
        o.snipes && b.incomingFromNations > 0 && b.tiles < o.snipeTiles;
      const base = ((value * b.tiles) / sz.S) * (snipe ? o.snipeBonus : 1);
      list.push({
        info: b,
        player: p,
        sizing: sz,
        cancel,
        snipe,
        base,
        score: base,
      });
    }
    if (list.length === 0) return;
    const byScore = (a: Candidate, b: Candidate) =>
      b.score - a.score || a.info.smallID - b.info.smallID;
    list.sort(byScore);
    if (o.contest || o.buffer) {
      for (let i = 0; i < list.length && i < MAX_WEIGHTED; i++) {
        list[i].score = list[i].base * this.weight(list[i]);
      }
      list.sort(byScore);
    }

    for (const c of list) {
      if (this.stopAll || this.stopped.has("tribe")) return;
      if (this.launches >= o.maxTribeLaunches) return;
      if (active >= o.maxTribeAttacks) return;
      const S = Math.ceil(c.sizing.S + c.cancel);
      // Never a partial clamp: a tribe that does not fit is skipped.
      if (S > v.purse.available("tribe")) continue;
      if (headroom && !headroomOk(v, S, c.sizing.refund, this.newRefunds)) {
        continue;
      }
      const ok = this.attack(c.info.smallID, c.info.id, S, {
        prio: Prio.Tribe,
        cls: "tribe",
        kind: "tribe",
        plan: c.snipe ? "snipe" : "tribe",
        clampTroops: c.sizing.A0 * o.tribeMargin,
        expectedRefund: c.sizing.refund,
      });
      if (!ok) continue;
      this.launches++;
      active++;
      this.newRefunds += c.sizing.refund;
      if (ratio === o.tribeRatio) this.worked = true;
      this.log(
        `${ratio === o.tribeRatio ? "tribe" : "stall-tribe"}${c.snipe ? " snipe" : ""} ` +
          `${c.info.id} n=${c.info.tiles} D=${Math.round(c.info.troops)} ` +
          `S=${S} p=${c.sizing.p.toFixed(1)} tau=${c.sizing.tau.toFixed(0)} ` +
          `w=${(c.score / c.base).toFixed(2)}`,
      );
    }
  }

  /**
   * §3.6.4 contest and buffer weights from one border scan of the tribe:
   * - bufferPenalty if it touches an unallied nation of the ally set that
   *   borders us and has it as its last affordable tribe (lightning rod);
   * - else contestBonus if it touches a nation that will eat tribes (allied
   *   with us, or its free-land lock is off) with a tribe budget ≥ 2·D;
   * - else 1.
   * Only nations with a full NationModel refresh are judged; the others
   * are handed to the policy's refresh list (s.nearTribes).
   */
  private weight(c: Candidate): number {
    const { v, o } = this;
    const sc = this.scan(c.player);
    const D = c.info.troops;
    if (o.buffer) {
      for (const n of sc.nations) {
        const N = v.game.playerBySmallID(n);
        if (!N.isPlayer() || v.me.isAlliedWith(N)) continue;
        if (!this.s.web.allySet.includes(N.id())) continue;
        const st = v.nm.get(N.id());
        if (st === undefined || !st.full || !st.sharesBorderWithUs) continue;
        if (
          st.affordableTribes <= 1 &&
          st.tribeBudget >= 1 &&
          2 * D <= st.T - st.params.reserve * st.M
        ) {
          return o.bufferPenalty;
        }
      }
    }
    if (o.contest) {
      for (const n of sc.nations) {
        const N = v.game.playerBySmallID(n);
        if (!N.isPlayer()) continue;
        const st = v.nm.get(N.id());
        if (st === undefined || !st.full) continue;
        if (st.tribeBudget < 2 * D) continue;
        if (
          !v.me.isAlliedWith(N) &&
          v.nm.gates(N.id(), v.nm.nextDecision(N.id(), v.tick)) === "locked"
        ) {
          continue;
        }
        return o.contestBonus;
      }
    }
    return 1;
  }

  // ── §3.6.6 Stall mode ──────────────────────────────────────────────────

  /**
   * The trigger, evaluated each decision: home > stallFrac·cap, or home
   * above the tribe floor while nothing takes troops: no Expansion offer
   * accepted this decision outside stall mode, no free land in reach of a
   * TN send, no boat at sea. s.stall.since is the first decision of the
   * current streak; stall mode is a streak of o.stallTicks (inStall).
   */
  private updateStall(): void {
    const { v, o, s } = this;
    if (!o.stall) {
      s.stall.since = null;
      return;
    }
    // Home at the scan (this decision), counted up to the cap only (C2).
    const cap = v.purse.floors.cap;
    const home = Math.min(v.wm.home, Math.ceil(cap));
    const full = home > o.stallFrac * cap;
    const idle =
      // Package WP10b: H without the leader floor (o.leaderGuard).
      home > (v.purse.floors.Hbase ?? v.purse.floors.H) &&
      !this.worked &&
      v.wm.boatsInFlight === 0 &&
      !(o.tn && v.wm.freeFrontier > 0);
    if (full || idle) {
      s.stall.since ??= v.tick;
    } else {
      s.stall.since = null;
    }
  }
}
