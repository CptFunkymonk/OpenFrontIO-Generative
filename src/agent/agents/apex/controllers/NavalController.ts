import {
  Game,
  Player,
  PlayerType,
  TerrainType,
  UnitType,
} from "../../../../core/game/Game";
import { TileRef } from "../../../../core/game/GameMap";
import type { TerrainMix } from "../../../lib/Models";
import {
  BoatTarget,
  boatTargets,
  cellOf,
  expectedLand,
  OWNER_WATER,
  OwnerGrid,
  RaceGrid,
  VoyageField,
  voyageField,
} from "../../../lib/RaceField";
import { Prio } from "../../../lib/Scheduler";
import type { Controller, View } from "../policy";
import { type ApexState, noteLine } from "../state";
import {
  activeTribePlans,
  headroomOk,
  inStall,
  ledgerBusy,
  scanTribe,
  SNACK_TILES,
  snackSend,
  tribeLaunch,
  tribeSizing,
} from "./ExpansionController";

// Boats (spec §3.7, §5.4). Every o.boatEvery ticks, while fewer than
// config.boatMaxNumber() of our boats are at sea and the Purse has
// o.boatMinTroops for a boat, it sends boats to unowned land and tribes we
// do not touch (RaceField.boatTargets on the policy's race and owner grids)
// when one of three triggers holds:
// - "blocked" (land maps): no free land borders us (F = 0) and the land
//   allocator has no tribe to launch at;
// - "stall": stall mode (§3.6.6, rule 2), with o.stallBoats;
// - "water" (water priority, §3.7): the map has less land than
//   o.waterMapLand, or our landmass's free plus tribe land is under twice
//   what we expect to take in 30 s. Boats then run alongside the tribes, to
//   other landmasses only.
// A target is tried only after a me.canBuild(TransportShip) probe, at most
// o.boatProbes per decision; a failed probe is remembered per race-grid cell
// in s.probes for PROBE_TTL ticks, and the target query leaves those cells
// out, as it does targets a boat of ours is bound for. One boat per landmass
// of free land and one per tribe at a time. Troops (§3.7): free land
// max(tnSat·S_sat, min(avail/3, p_TN·free)); a tribe S_b + o.beachheadExtra,
// skipped when it does not fit (never a partial stack).
//
// Not in the spec, from the arena (quick@4, showcase), each behind its own
// option:
// - Warships (o.boatAvoidWarships; the spec leaves them to M6): a target is
//   skipped when its landing tile, or the straight route from the launch
//   tile, passes within config.warshipTargettingRange() + o.boatWarshipMargin
//   of a warship whose owner may shoot our boats (WarshipExecution
//   .findBestTarget: transports first). Boats sunk 10-30 ticks after launch
//   cost 550-940k troops on Onion and Four Islands. With o.boatRoutePrecheck
//   the route is judged before the ~2 ms canBuild probe, from the launch
//   tile the last probe to that landmass returned (s.naval.launch) or our
//   shore tile nearest the landing.
// - Voyages (o.boatVoyageScore, o.boatMaxVoyage): targets are scored by a
//   sea-distance estimate (RaceField.voyageField, one BFS per OwnerGrid)
//   instead of the distance from our centroid, and farther ones dropped.
// - Tribes nations are eating (o.boatAvoidEatenTribes): a transport's
//   target is the landing tile's owner at launch
//   (TransportShipExecution.ts:75); a tile a nation takes during the voyage
//   makes the nation build a warship at us and drop 15
//   (NationWarshipBehavior.ts:188-297), and a tile it took before launch
//   makes the boat attack the nation.
// - After launch (onTick): o.boatCancelOnFlip turns back a boat whose
//   landing an unallied nation now owns; o.boatCancelDead one whose target
//   lost the landing, far out.
// - Troops (o.boatPocket): free land counts the pocket around the landing,
//   not the whole landmass; o.boatHeadroom applies §3.6.7 outside stall.
// - Busy (busyTargets): a ship keeps its send's landmass or tribe busy
//   (Ledger ships) whoever owns its landing now, a landed free-land boat's
//   landmass for o.boatLandmassHold ticks, and this decision's land
//   launches (Scheduler.hasKey) count; without o.boatBorderTribes, tribes
//   that border us are the land allocator's.

/** A failed canBuild probe is remembered this long, per race-grid cell. */
export const PROBE_TTL = 200;
/** Boat targets per query; the probes pick among them. */
export const BOAT_TARGETS = 8;
/** Water priority: food on our landmass under TAKE_FACTOR × what we take in
 *  TAKE_TICKS (30 s). */
const TAKE_TICKS = 300;
const TAKE_FACTOR = 2;
/** A nation lets be a transport closer than this (Manhattan) to its
 *  landing (NationWarshipBehavior.ts:219-226). */
export const NATION_TRACK_MIN = 20;
/** Ticks a cancel_boat stays in flight (the retreat shows two ticks on). */
const CANCEL_IN_FLIGHT = 5;
/** Largest free-land pocket flood-filled around a landing; a larger one is
 *  sized by its landmass's free land. */
export const POCKET_MAX = 4096;

export type BoatTrigger = "blocked" | "stall" | "water";

/** A boat's troops; for a tribe also its clamp stack and expected refund
 *  (Ledger plan fields). */
export interface BoatSend {
  troops: number;
  clamp?: number;
  refund?: number;
}

/** Free and tribe land by landmass (from the OwnerGrid samples, × stride²),
 *  and the landmasses we hold a sample on. */
export interface LandmassFood {
  ours: Set<number>;
  free: Map<number, number>;
  tribe: Map<number, number>;
}

/** Our memory (spec §2.10: controllers keep none of their own); plain data,
 *  created on first use. */
export interface NavalMemory {
  /** The launch tile the last probe to each target landmass returned. */
  launch: Record<string, { src: TileRef; at: number }>;
  /** Boats we asked to turn back: unit id -> tick. */
  cancelled: Record<string, number>;
  /** Counts for logs and tests; never read by decisions. */
  stats: {
    cancels: number;
    eaten: number;
    headroom: number;
    prechecks: number;
  };
}

declare module "../state" {
  interface ApexState {
    /** NavalController memory (NavalController.ts). */
    naval?: NavalMemory;
  }
}

export function navalMemory(s: ApexState): NavalMemory {
  s.naval ??= {
    launch: {},
    cancelled: {},
    stats: { cancels: 0, eaten: 0, headroom: 0, prechecks: 0 },
  };
  return s.naval;
}

/** The voyage field of an OwnerGrid's decisions (one BFS per grid), from
 *  our ocean-shore border then: a memo of plain data. */
const voyageMemo = new WeakMap<OwnerGrid, { mine: number; f: VoyageField }>();

function voyageOf(v: View, grid: RaceGrid, og: OwnerGrid): VoyageField {
  const mine = v.me.smallID();
  const memo = voyageMemo.get(og);
  if (memo !== undefined && memo.mine === mine) return memo.f;
  const f = voyageField(v.game, grid, v.wm.shoreSample);
  voyageMemo.set(og, { mine, f });
  return f;
}

export class NavalController implements Controller {
  readonly name = "naval";

  /** After launch: turn back boats whose landing went wrong (o.boatCancelOnFlip,
   *  o.boatCancelDead). A few ships a tick. */
  onTick(v: View, s: ApexState): void {
    const { o, game, me, tick } = v;
    if (!o.boatCancelOnFlip && !o.boatCancelDead) return;
    if (me.unitCount(UnitType.TransportShip) === 0) return;
    const mem = navalMemory(s);
    for (const [id, at] of Object.entries(mem.cancelled)) {
      if (tick - at >= CANCEL_IN_FLIGHT) delete mem.cancelled[id];
    }
    for (const u of me.units(UnitType.TransportShip)) {
      const dst = u.targetTile();
      if (dst === undefined || u.transportShipState().isRetreating) continue;
      if (mem.cancelled[String(u.id())] !== undefined) continue;
      const rec = v.ledger.ship(u.id());
      if (rec === undefined) continue;
      const owner = game.owner(dst);
      const ownerID = owner.isPlayer() ? owner.smallID() : 0;
      if (ownerID === rec.target) continue;
      const left = game.manhattanDist(u.tile(), dst);
      const nation =
        owner.isPlayer() &&
        owner !== me &&
        owner.type() === PlayerType.Nation &&
        !me.isAlliedWith(owner);
      let why: string | null = null;
      if (o.boatCancelOnFlip && nation && left >= NATION_TRACK_MIN) {
        why = `landing now ${owner.isPlayer() ? owner.name() : "?"}'s`;
      } else if (o.boatCancelDead && left > o.boatCancelFar) {
        why = `target ${rec.target} lost the landing`;
      }
      if (why === null) continue;
      const ok = v.scheduler.offer({
        intent: { type: "cancel_boat", unitID: u.id() },
        prio: Prio.Recall,
        cls: "defense",
        key: `cancel_boat:${u.id()}`,
      });
      if (!ok) continue;
      mem.cancelled[String(u.id())] = tick;
      mem.stats.cancels++;
      this.note(
        v,
        s,
        `boat cancel #${u.id()} ${Math.round(u.troops())} (${why}, ${left} tiles out)`,
      );
    }
  }

  decide(v: View, s: ApexState): void {
    const { o, game, me, tick, wm, race, owners } = v;
    if (!o.boats) return;
    if (tick - s.timers.lastBoat < o.boatEvery) return;
    const max = game.config().boatMaxNumber();
    if (wm.boatsInFlight >= max) return;
    if (v.purse.available("boat") < o.boatMinTroops) return;
    if (race === null || owners === null) return;
    // No send could go out (class cap, budget): no probes either.
    if (v.scheduler.classLeft("boat") < 1) return;
    if (v.scheduler.intentsLeft(Prio.Boat) < 1) return;
    const food = landmassFood(game, race, owners, me);
    const trigger = boatTrigger(v, s, food);
    if (trigger === null) return;
    s.timers.lastBoat = tick;
    pruneProbes(s, tick);
    const mem = navalMemory(s);

    const busy = busyTargets(v, race, trigger);
    const failed = new Set<number>();
    for (const [cell, at] of Object.entries(s.probes)) {
      if (tick - at < PROBE_TTL) failed.add(Number(cell));
    }
    // A target is skipped when on water priority's own landmass, bound for
    // by a boat of ours (one per landmass of free land, one per tribe), or
    // in a cell whose probe failed. The query leaves those samples out, so
    // they never use up the BOAT_TARGETS best; it is asked again only when
    // this decision's sends and failures have used its list up.
    const mask: OwnerMask = {
      comps: trigger === "water" ? food.ours : null,
      freeComps: busy.comps,
      owners: busy.tribes,
      cells: failed,
    };
    const skip = (comp: number, owner: number, cell: number) =>
      mask.comps?.has(comp) === true ||
      (owner === 0 ? busy.comps.has(comp) : busy.tribes.has(owner)) ||
      failed.has(cell);
    const guard = o.boatAvoidWarships ? hostileWarships(game, me) : [];
    const reach = game.config().warshipTargettingRange() + o.boatWarshipMargin;
    const voyage = o.boatVoyageScore
      ? { field: voyageOf(v, race, owners), max: o.boatMaxVoyage }
      : undefined;
    let guarded = 0;
    const markGuarded = (cell: number) => {
      guarded++;
      s.probes[String(cell)] = tick;
      failed.add(cell);
    };
    let inFlight = wm.boatsInFlight;
    let probes = 0;
    let rounds = 0;
    while (probes < o.boatProbes && inFlight < max && rounds <= o.boatProbes) {
      rounds++;
      const og = maskOwners(game, race, owners, me.smallID(), mask);
      const list = boatTargets(game, race, og, me, BOAT_TARGETS, voyage);
      let fresh = false;
      for (const t of list) {
        if (probes >= o.boatProbes || inFlight >= max) return;
        if (v.purse.available("boat") < o.boatMinTroops) return;
        const cell = cellOf(race, game, t.tile);
        // (The landing may lie in a neighbour of its sample's cell.)
        if (skip(t.comp, t.tribeSmallID ?? 0, cell)) continue;
        if (nearWarship(game, guard, t.tile, t.tile, reach)) {
          markGuarded(cell);
          continue;
        }
        if (o.boatRoutePrecheck && guard.length > 0) {
          const est = this.launchEstimate(v, mem, t);
          if (est !== null && nearWarship(game, guard, est, t.tile, reach)) {
            mem.stats.prechecks++;
            markGuarded(cell);
            continue;
          }
        }
        const send = this.sizing(v, s, t, food, trigger);
        if (send === null) continue;
        fresh = true;
        probes++;
        const src = me.canBuild(UnitType.TransportShip, t.tile);
        if (src === false) {
          s.probes[String(cell)] = tick;
          failed.add(cell);
          continue;
        }
        mem.launch[String(t.comp)] = { src, at: tick };
        if (nearWarship(game, guard, src, t.tile, reach)) {
          markGuarded(cell);
          continue;
        }
        if (!this.send(v, s, trigger, t, send, guarded)) return;
        inFlight++;
        if (t.tribeSmallID !== null) busy.tribes.add(t.tribeSmallID);
        else busy.comps.add(t.comp);
      }
      // Nothing in the list was worth a probe: a new query finds the same.
      if (!fresh) break;
    }
    // (A send's own line counts the targets skipped before it.)
    if (guarded > 0 && inFlight === wm.boatsInFlight) {
      this.note(
        v,
        s,
        `boat (${trigger}) none: ${guarded} targets guarded by ${guard.length / 2} warships`,
      );
    }
  }

  /**
   * Where a boat to `t` would likely leave from, before a probe says: the
   * launch tile the last probe to its landmass returned (within PROBE_TTL),
   * else our ocean-shore border tile (WorldModel.shoreSample) nearest the
   * landing on the landing's water body; null if none.
   */
  private launchEstimate(
    v: View,
    mem: NavalMemory,
    t: BoatTarget,
  ): TileRef | null {
    const { game, tick } = v;
    const known = mem.launch[String(t.comp)];
    if (known !== undefined && tick - known.at < PROBE_TTL) return known.src;
    const wc = game.getWaterComponent(t.tile);
    let best: TileRef | null = null;
    let bestD = Infinity;
    for (const x of v.wm.shoreSample) {
      if (wc !== null && !game.hasWaterComponent(x, wc)) continue;
      const d = game.manhattanDist(x, t.tile);
      if (d < bestD || (d === bestD && best !== null && x < best)) {
        best = x;
        bestD = d;
      }
    }
    return best;
  }

  /** Offers the boat; false when the Scheduler refuses it. */
  private send(
    v: View,
    s: ApexState,
    trigger: BoatTrigger,
    t: BoatTarget,
    send: BoatSend,
    guarded = 0,
  ): boolean {
    const tribe = t.tribeSmallID;
    const accepted = v.scheduler.offer({
      intent: { type: "boat", troops: send.troops, dst: t.tile },
      prio: Prio.Boat,
      cls: "boat",
      key: `boat:${t.tile}`,
      spend: { kind: "boat", troops: send.troops },
      ...(tribe !== null
        ? {
            plan: "boat" as const,
            meta: {
              target: tribe,
              clampTroops: send.clamp,
              expectedRefund: send.refund,
            },
          }
        : {}),
    });
    if (!accepted) return false;
    const { game } = v;
    this.note(
      v,
      s,
      `boat (${trigger}) ${send.troops} to ${tribe !== null ? `tribe ${tribe}` : "free land"} at ${game.x(t.tile)},${game.y(t.tile)} (landmass ${t.comp}, food ${t.food}, ${Math.round(t.dist)} tiles)${guarded > 0 ? `, ${guarded} guarded skipped` : ""}`,
    );
    return true;
  }

  /** Troops for a boat to `t`, or null when the target is taken, eaten,
   *  not attackable, or does not fit the Purse or the cap headroom. */
  private sizing(
    v: View,
    s: ApexState,
    t: BoatTarget,
    food: LandmassFood,
    trigger: BoatTrigger,
  ): BoatSend | null {
    const { o, game, me, models } = v;
    const avail = v.purse.available("boat");
    const mix = tileMix(game, t.tile);
    if (t.tribeSmallID === null) {
      const sat = o.tnSat * models.tnSaturation(mix);
      const price = models.tnPrice(mix);
      let free = food.free.get(t.comp) ?? 0;
      if (o.boatPocket) {
        if (food.ours.has(t.comp)) {
          // Our own landmass: its free land is specks inside nations'
          // land, taken during the voyage.
          free = 0;
        } else {
          const limit = Math.min(POCKET_MAX, Math.ceil(avail / 3 / price));
          const pocket = freePocket(game, t.tile, limit);
          if (pocket < limit) free = pocket;
        }
      }
      const troops = Math.max(sat, Math.min(avail / 3, price * free));
      return { troops: Math.floor(Math.min(troops, avail)) };
    }
    const b = game.playerBySmallID(t.tribeSmallID);
    if (!b.isPlayer() || !b.isAlive() || b.type() !== PlayerType.Bot) {
      return null;
    }
    if (me.isFriendly(b) || !me.canAttackPlayer(b)) return null;
    if (o.boatAvoidEatenTribes && tribeEaten(v, b, t.tile) !== null) {
      navalMemory(s).stats.eaten++;
      return null;
    }
    const sz = tribeSizing(
      models,
      me.numTilesOwned(),
      {
        tiles: b.numTilesOwned(),
        troops: b.troops(),
        isTraitor: b.isTraitor(),
        contact: beachheadFront(b.numTilesOwned()),
        contactMix: mix,
      },
      models.regrowth(b),
      o.tribeRatio,
      o,
    );
    if (sz.p > o.tribeMaxPrice * models.tnPrice(mix)) return null;
    const troops = Math.ceil(sz.S + o.beachheadExtra);
    if (troops > avail) return null;
    const refund = Math.max(0, troops - sz.cost);
    // §3.6.7 outside stall: the refund would come home above the cap.
    if (
      o.boatHeadroom &&
      refund > 0 &&
      trigger !== "stall" &&
      !inStall(s, v.tick, o) &&
      !headroomOk(v, troops, refund)
    ) {
      navalMemory(s).stats.headroom++;
      return null;
    }
    return { troops, clamp: sz.A0 * o.tribeMargin, refund };
  }

  private note(v: View, s: ApexState, line: string): void {
    noteLine(v, s, line);
  }
}

/**
 * Why tribe `b` is being eaten by nations around landing `tile`
 * (o.boatAvoidEatenTribes), or null: the landing is not its own (live), a
 * nation attacks it, a nation's tile lies within o.boatEatenRadius
 * (Chebyshev) of the landing, or a nation touching it has
 * o.boatEatenRatio × its troops above its own reserve (T − reserve·M, the
 * tribe budget of calculateBotAttackTroops, AiAttackBehavior.ts:1149-1166).
 */
export function tribeEaten(
  v: Pick<View, "game" | "me" | "models" | "nm" | "o">,
  b: Player,
  tile: TileRef,
): string | null {
  const { game, me, o } = v;
  if (game.ownerID(tile) !== b.smallID()) return "landing not its own";
  const isNation = (p: Player) => p !== me && p.type() === PlayerType.Nation;
  for (const a of b.incomingAttacks()) {
    if (isNation(a.attacker())) return `attacked by ${a.attacker().name()}`;
  }
  const r = Math.max(0, Math.floor(o.boatEatenRadius));
  const x0 = game.x(tile);
  const y0 = game.y(tile);
  for (
    let y = Math.max(0, y0 - r);
    y <= Math.min(game.height() - 1, y0 + r);
    y++
  ) {
    for (
      let x = Math.max(0, x0 - r);
      x <= Math.min(game.width() - 1, x0 + r);
      x++
    ) {
      const id = game.ownerID(game.ref(x, y));
      if (id === 0 || id === b.smallID() || id === me.smallID()) continue;
      const p = game.playerBySmallID(id);
      if (p.isPlayer() && isNation(p)) return `${p.name()} near the landing`;
    }
  }
  const D = b.troops();
  for (const n of scanTribe(game, b, me.smallID()).nations) {
    const N = game.playerBySmallID(n);
    if (!N.isPlayer() || N === me) continue;
    const free = N.troops() - v.nm.params(N.id()).reserve * v.models.cap(N);
    if (free >= o.boatEatenRatio * D) return `${N.name()} can eat it`;
  }
  return null;
}

/** Unowned passable land connected (4-neighbours) to `tile`, counted up to
 *  `limit` (a flood fill of at most `limit` tiles; `limit` means "at least").
 *  Fallout tiles do not count, as free land is taken around them. */
export function freePocket(game: Game, tile: TileRef, limit: number): number {
  if (limit <= 0) return 0;
  const free = (t: TileRef) =>
    game.isLand(t) &&
    !game.isImpassable(t) &&
    !game.hasOwner(t) &&
    !game.hasFallout(t);
  if (!free(tile)) return 0;
  const seen = new Set<TileRef>([tile]);
  const stack: TileRef[] = [tile];
  while (stack.length > 0 && seen.size < limit) {
    const t = stack.pop()!;
    game.forEachNeighbor(t, (n) => {
      if (seen.size >= limit || seen.has(n) || !free(n)) return;
      seen.add(n);
      stack.push(n);
    });
  }
  return Math.min(seen.size, limit);
}

/** Positions (x, y pairs) of the warships that may shoot our boats: active,
 *  not ours, and owned by a player not friendly to us (the warship's own
 *  test is owner.canAttackPlayer(us, true), WarshipExecution.ts:295-305). */
export function hostileWarships(game: Game, me: Player): number[] {
  const out: number[] = [];
  for (const w of game.units(UnitType.Warship)) {
    if (!w.isActive()) continue;
    const owner = w.owner();
    if (owner === me || owner.isFriendly(me, true)) continue;
    const t = w.tile();
    out.push(game.x(t), game.y(t));
  }
  return out;
}

/** Whether a warship of `ws` (x, y pairs) lies within `range` (Euclidean,
 *  as its targeting, GameImpl.nearbyUnits) of the segment a-b. */
export function nearWarship(
  game: Game,
  ws: readonly number[],
  a: TileRef,
  b: TileRef,
  range: number,
): boolean {
  if (ws.length === 0) return false;
  const ax = game.x(a);
  const ay = game.y(a);
  const dx = game.x(b) - ax;
  const dy = game.y(b) - ay;
  const len2 = dx * dx + dy * dy;
  const r2 = range * range;
  for (let i = 0; i < ws.length; i += 2) {
    const px = ws[i] - ax;
    const py = ws[i + 1] - ay;
    const u =
      len2 === 0 ? 0 : Math.min(1, Math.max(0, (px * dx + py * dy) / len2));
    const ex = px - u * dx;
    const ey = py - u * dy;
    if (ex * ex + ey * ey <= r2) return true;
  }
  return false;
}

/** Which trigger holds (§3.7), most permissive first; null: none. */
export function boatTrigger(
  v: View,
  s: ApexState,
  food: LandmassFood,
): BoatTrigger | null {
  if (blocked(v, s)) return "blocked";
  if (v.o.stallBoats && inStall(s, v.tick, v.o)) return "stall";
  if (waterPriority(v, s, food)) return "water";
  return null;
}

/**
 * "Blocked": no free land borders us, and no tribe launch is open to the
 * land allocator. The allocator's own tests (ExpansionController:
 * ledgerBusy, snackSend, tribeLaunch, headroomOk, activeTribePlans), so the
 * two never disagree: every bordering tribe it may attack is busy, a snack
 * it would skip (growing past 100 tiles first, or over the snack purse with
 * its attacks on us), or a launch it would skip (over the tribe purse with
 * its attacks on us, too dense, or, outside stall mode with o.headroom,
 * over the cap headroom). A tribe the allocator launched at this decision
 * means not blocked. With the allocator's tribes off, no free land is
 * enough. `s` gives stall mode (headroom off); without it, not in stall.
 */
export function blocked(v: View, s?: ApexState): boolean {
  const { o, wm } = v;
  if (wm.freeFrontier > 0) return false;
  if (!o.expansion) return true;
  const active = activeTribePlans(v);
  const headroom = o.headroom && !(s !== undefined && inStall(s, v.tick, o));
  for (const b of wm.tribes) {
    const sid = b.smallID;
    if (v.scheduler.hasKey(`attack:${sid}`)) return false;
    if (ledgerBusy(v, sid)) continue;
    const p = v.game.playerBySmallID(sid);
    if (!p.isPlayer() || !p.isAlive()) continue;
    if (b.tiles <= SNACK_TILES) {
      if (o.snacks && snackSend(v, b, p) !== null) return false;
      continue;
    }
    if (!o.tribes || active >= o.maxTribeAttacks) continue;
    const launch = tribeLaunch(v, b, p, o.tribeRatio, 1);
    if (launch === null) continue;
    const S = Math.ceil(launch.sizing.S + launch.cancel);
    if (headroom && !headroomOk(v, S, launch.sizing.refund)) continue;
    return false;
  }
  return true;
}

/** Water priority (§3.7): a water map, or our landmass nearly eaten. */
export function waterPriority(
  v: View,
  s: ApexState,
  food: LandmassFood,
): boolean {
  const { o, game, tick } = v;
  const mapLand = game.numLandTiles() / (game.width() * game.height());
  if (mapLand < o.waterMapLand) return true;
  const age = Math.max(0, tick - (s.spawn.endTick ?? tick));
  const take = expectedLand(o, age + TAKE_TICKS) - expectedLand(o, age);
  let left = 0;
  for (const c of food.ours) {
    left += (food.free.get(c) ?? 0) + (food.tribe.get(c) ?? 0);
  }
  return left < TAKE_FACTOR * take;
}

/** The race-grid cell of every OwnerGrid sample (−1 for water), memoised
 *  per OwnerGrid: both are plain data that never change once built (the
 *  policy builds a new OwnerGrid every 100 ticks), so this is a pure memo. */
const sampleCellMemo = new WeakMap<
  OwnerGrid,
  { grid: RaceGrid; cells: Int32Array }
>();

export function sampleCells(
  game: Game,
  grid: RaceGrid,
  og: OwnerGrid,
): Int32Array {
  const memo = sampleCellMemo.get(og);
  if (memo !== undefined && memo.grid === grid) return memo.cells;
  const W = game.width();
  const H = game.height();
  const { owner, ow, oh, stride } = og;
  const half = Math.floor(stride / 2);
  const cells = new Int32Array(owner.length).fill(-1);
  for (let by = 0; by < oh; by++) {
    const y = Math.min(H - 1, by * stride + half);
    const row = Math.floor(y / grid.cell) * grid.cw;
    for (let bx = 0; bx < ow; bx++) {
      const i = by * ow + bx;
      if (owner[i] === OWNER_WATER) continue;
      cells[i] =
        row + Math.floor(Math.min(W - 1, bx * stride + half) / grid.cell);
    }
  }
  sampleCellMemo.set(og, { grid, cells });
  return cells;
}

/** One pass over the OwnerGrid samples. */
export function landmassFood(
  game: Game,
  grid: RaceGrid,
  og: OwnerGrid,
  me: Player,
): LandmassFood {
  let maxID = 0;
  const players = game.allPlayers();
  for (const p of players) maxID = Math.max(maxID, p.smallID());
  const bot = new Uint8Array(maxID + 1);
  for (const p of players) {
    if (p.type() === PlayerType.Bot) bot[p.smallID()] = 1;
  }
  let maxComp = -1;
  for (const c of grid.compLand.keys()) maxComp = Math.max(maxComp, c);
  const free = new Float64Array(maxComp + 1);
  const tribe = new Float64Array(maxComp + 1);
  const ours = new Uint8Array(maxComp + 1);
  const mine = me.smallID();
  const cells = sampleCells(game, grid, og);
  const { owner } = og;
  for (let i = 0; i < owner.length; i++) {
    const cell = cells[i];
    if (cell < 0) continue;
    const comp = grid.comp[cell];
    if (comp < 0 || comp > maxComp) continue;
    const id = owner[i];
    if (id === mine) ours[comp] = 1;
    else if (id === 0) free[comp]++;
    else if (id < bot.length && bot[id] === 1) tribe[comp]++;
  }
  const area = og.stride * og.stride;
  const out: LandmassFood = {
    ours: new Set(),
    free: new Map(),
    tribe: new Map(),
  };
  for (let c = 0; c <= maxComp; c++) {
    if (ours[c] === 1) out.ours.add(c);
    if (free[c] > 0) out.free.set(c, free[c] * area);
    if (tribe[c] > 0) out.tribe.set(c, tribe[c] * area);
  }
  return out;
}

/** What maskOwners leaves out. */
export interface OwnerMask {
  /** Landmasses: every sample on them (but ours). */
  comps: ReadonlySet<number> | null;
  /** Landmasses: their unowned samples. */
  freeComps: ReadonlySet<number>;
  /** Owners (tribes): their samples. */
  owners: ReadonlySet<number>;
  /** Race-grid cells: every sample in them (but ours). */
  cells: ReadonlySet<number>;
}

/** A copy of the OwnerGrid with the samples `mask` names (other than ours
 *  and water) turned to water. */
export function maskOwners(
  game: Game,
  grid: RaceGrid,
  og: OwnerGrid,
  mine: number,
  mask: OwnerMask,
): OwnerGrid {
  let maxComp = -1;
  for (const c of grid.compLand.keys()) maxComp = Math.max(maxComp, c);
  const compOff = new Uint8Array(maxComp + 2);
  for (const c of mask.comps ?? []) if (c >= 0 && c <= maxComp) compOff[c] |= 1;
  for (const c of mask.freeComps) if (c >= 0 && c <= maxComp) compOff[c] |= 2;
  const cellOff = new Uint8Array(grid.cw * grid.ch);
  for (const c of mask.cells) if (c >= 0 && c < cellOff.length) cellOff[c] = 1;
  let maxOwner = 0;
  for (const id of mask.owners) maxOwner = Math.max(maxOwner, id);
  const ownerOff = new Uint8Array(maxOwner + 1);
  for (const id of mask.owners) if (id > 0) ownerOff[id] = 1;
  const cells = sampleCells(game, grid, og);
  const owner = og.owner.slice();
  for (let i = 0; i < owner.length; i++) {
    const id = owner[i];
    const cell = cells[i];
    if (id === OWNER_WATER || id === mine || cell < 0) continue;
    const comp = grid.comp[cell];
    const off = comp >= 0 && comp <= maxComp ? compOff[comp] : 0;
    if (
      (off & 1) !== 0 ||
      cellOff[cell] === 1 ||
      (id === 0 ? (off & 2) !== 0 : id <= maxOwner && ownerOff[id] === 1)
    ) {
      owner[i] = OWNER_WATER;
    }
  }
  return { ...og, owner };
}

/**
 * Landmasses and tribes a boat must not go to now (one boat per landmass of
 * free land, one per tribe):
 * - tribes with a plan of ours, or given an attack this decision (the
 *   allocator's offers are flushed after Naval decides: Scheduler.hasKey);
 * - each ship of ours (Ledger ships): its send's tribe, or for a free-land
 *   send its landing's landmass, whoever owns the landing now; a free-land
 *   ship landed less than o.boatLandmassHold ticks ago keeps its landmass
 *   (a land TN send absorbs the landing attack, which then has no source
 *   tile, AttackExecution.ts:171-181, and the OwnerGrid shows the landing
 *   only at its next refresh);
 * - landmasses where a landing of ours still fights (an attack with a
 *   source tile on free land);
 * - without o.boatBorderTribes, unless the trigger is "water", every tribe
 *   that borders us (the land allocator's).
 */
export function busyTargets(
  v: View,
  grid: RaceGrid,
  trigger: BoatTrigger,
): { comps: Set<number>; tribes: Set<number> } {
  const { game, me, o, tick } = v;
  const comps = new Set<number>();
  const tribes = new Set<number>();
  const compOf = (t: TileRef) => grid.comp[cellOf(grid, game, t)];
  for (const plan of v.ledger.allPlans()) {
    if (plan.targetSmallID !== 0) tribes.add(plan.targetSmallID);
  }
  for (const b of v.wm.tribes) {
    if (v.scheduler.hasKey(`attack:${b.smallID}`)) tribes.add(b.smallID);
    else if (!o.boatBorderTribes && trigger !== "water") tribes.add(b.smallID);
  }
  for (const r of v.ledger.allShips()) {
    if (r.dst < 0) continue;
    if (r.goneAt === null) {
      if (r.target !== 0) tribes.add(r.target);
      else comps.add(compOf(r.dst));
    } else if (r.target === 0 && tick - r.goneAt < o.boatLandmassHold) {
      comps.add(compOf(r.dst));
    }
  }
  for (const u of me.units(UnitType.TransportShip)) {
    const t = u.targetTile();
    if (t === undefined) continue;
    const owner = game.ownerID(t);
    if (owner === 0) comps.add(compOf(t));
    else tribes.add(owner);
  }
  // A landing still fighting: its landmass is being taken (the OwnerGrid,
  // up to 100 ticks old, may not show it as ours yet).
  for (const a of me.outgoingAttacks()) {
    const src = a.sourceTile();
    if (src === null) continue;
    if (!a.target().isPlayer()) comps.add(compOf(src));
  }
  return { comps, tribes };
}

/** Drops failed probes older than PROBE_TTL. */
function pruneProbes(s: ApexState, tick: number): void {
  let stale = false;
  for (const at of Object.values(s.probes)) {
    if (tick - at >= PROBE_TTL) stale = true;
  }
  if (!stale) return;
  s.probes = Object.fromEntries(
    Object.entries(s.probes).filter(([, at]) => tick - at < PROBE_TTL),
  );
}

/** A one-tile mix of the landing tile's terrain. */
function tileMix(game: Game, t: TileRef): TerrainMix {
  const terrain = game.terrainType(t);
  return {
    plains: terrain === TerrainType.Plains ? 1 : 0,
    highland: terrain === TerrainType.Highland ? 1 : 0,
    mountain: terrain === TerrainType.Mountain ? 1 : 0,
  };
}

/**
 * The contact a landing attack on an n-tile tribe fights with, on average:
 * it starts from one tile (the landing, [PIN BoatsAndWin]) and its front
 * grows to about the tribe's radius, so half of √n. Not in spec §3.7, which
 * sizes a tribe landing as S_b + beachheadExtra without saying which
 * contact S_b's pace uses; the land contact (1 tile here) would make the
 * regrowth term g·τ several times too large.
 */
export function beachheadFront(n: number): number {
  return Math.max(1, Math.round(Math.sqrt(n) / 2));
}
