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
} from "../../../lib/RaceField";
import { Prio } from "../../../lib/Scheduler";
import type { Controller, View } from "../policy";
import { type ApexState, stateLog } from "../state";
import { inStall, SNACK_TILES, tribeSizing } from "./ExpansionController";

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
// out, as it does targets a boat of ours is bound for. One boat per landmass of free land and one
// per tribe at a time. Troops (§3.7): free land max(tnSat·S_sat, min(avail/3,
// p_TN·islandFree)); a tribe S_b + o.beachheadExtra, skipped when it does
// not fit (never a partial stack).

/** A failed canBuild probe is remembered this long, per race-grid cell. */
export const PROBE_TTL = 200;
/** Boat targets per query; the probes pick among them. */
export const BOAT_TARGETS = 8;
/** Water priority: food on our landmass under TAKE_FACTOR × what we take in
 *  TAKE_TICKS (30 s). */
const TAKE_TICKS = 300;
const TAKE_FACTOR = 2;

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

export class NavalController implements Controller {
  readonly name = "naval";

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

    const busy = busyTargets(v, race);
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
    let inFlight = wm.boatsInFlight;
    let probes = 0;
    let rounds = 0;
    while (probes < o.boatProbes && inFlight < max && rounds <= o.boatProbes) {
      rounds++;
      const og = maskOwners(game, race, owners, me.smallID(), mask);
      const list = boatTargets(game, race, og, me, BOAT_TARGETS);
      let fresh = false;
      for (const t of list) {
        if (probes >= o.boatProbes || inFlight >= max) return;
        if (v.purse.available("boat") < o.boatMinTroops) return;
        const cell = cellOf(race, game, t.tile);
        // (The landing may lie in a neighbour of its sample's cell.)
        if (skip(t.comp, t.tribeSmallID ?? 0, cell)) continue;
        const send = this.sizing(v, t, food);
        if (send === null) continue;
        fresh = true;
        probes++;
        if (me.canBuild(UnitType.TransportShip, t.tile) === false) {
          s.probes[String(cell)] = tick;
          failed.add(cell);
          continue;
        }
        if (!this.send(v, s, trigger, t, send)) return;
        inFlight++;
        if (t.tribeSmallID !== null) busy.tribes.add(t.tribeSmallID);
        else busy.comps.add(t.comp);
      }
      // Nothing in the list was worth a probe: a new query finds the same.
      if (!fresh) return;
    }
  }

  /** Offers the boat; false when the Scheduler refuses it. */
  private send(
    v: View,
    s: ApexState,
    trigger: BoatTrigger,
    t: BoatTarget,
    send: BoatSend,
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
      `boat (${trigger}) ${send.troops} to ${tribe !== null ? `tribe ${tribe}` : "free land"} at ${game.x(t.tile)},${game.y(t.tile)} (landmass ${t.comp}, food ${t.food})`,
    );
    return true;
  }

  /** Troops for a boat to `t`, or null when the target is taken, not
   *  attackable, or does not fit the Purse. */
  private sizing(v: View, t: BoatTarget, food: LandmassFood): BoatSend | null {
    const { o, game, me, models } = v;
    const avail = v.purse.available("boat");
    const mix = tileMix(game, t.tile);
    if (t.tribeSmallID === null) {
      const islandFree = food.free.get(t.comp) ?? 0;
      const troops = Math.max(
        o.tnSat * models.tnSaturation(mix),
        Math.min(avail / 3, models.tnPrice(mix) * islandFree),
      );
      return { troops: Math.floor(Math.min(troops, avail)) };
    }
    const b = game.playerBySmallID(t.tribeSmallID);
    if (!b.isPlayer() || !b.isAlive() || b.type() !== PlayerType.Bot) {
      return null;
    }
    if (me.isFriendly(b) || !me.canAttackPlayer(b)) return null;
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
    return {
      troops,
      clamp: sz.A0 * o.tribeMargin,
      refund: Math.max(0, troops - sz.cost),
    };
  }

  private note(v: View, s: ApexState, line: string): void {
    if (v.log !== undefined) {
      v.log(line);
      return;
    }
    stateLog(s, `[${v.tick}] ${line}`);
    v.live?.log(line);
  }
}

/** Which trigger holds (§3.7), most permissive first; null: none. */
export function boatTrigger(
  v: View,
  s: ApexState,
  food: LandmassFood,
): BoatTrigger | null {
  if (blocked(v)) return "blocked";
  if (v.o.stallBoats && inStall(s, v.tick, v.o)) return "stall";
  if (waterPriority(v, s, food)) return "water";
  return null;
}

/**
 * "Blocked": no free land borders us, and no tribe launch is open to the
 * land allocator: every bordering tribe it may attack has a plan, costs
 * more than the Purse holds for tribes, or is too dense (the §3.6.4
 * eligibility, with the ExpansionController's own sizing). A snack counts
 * as a launch. With the allocator's tribes off, no free land is enough.
 */
export function blocked(v: View): boolean {
  const { o, wm, models } = v;
  if (wm.freeFrontier > 0) return false;
  if (!o.expansion) return true;
  let active = 0;
  for (const plan of v.ledger.allPlans()) {
    if (plan.kind === "tribe" || plan.kind === "snipe") active++;
  }
  const avail = v.purse.available("tribe");
  const l = v.ledger;
  for (const b of wm.tribes) {
    // Busy as the allocator counts it: a plan, or troops on it.
    const sid = b.smallID;
    if (l.plan(sid) !== undefined || l.stackOn(sid) > 0) continue;
    if (l.retreatingOn(sid) > 0) continue;
    if (b.tiles <= SNACK_TILES) {
      if (o.snacks) return false;
      continue;
    }
    if (!o.tribes || active >= o.maxTribeAttacks) continue;
    const p = v.game.playerBySmallID(b.smallID);
    if (!p.isPlayer()) continue;
    const sz = tribeSizing(
      models,
      wm.tiles,
      {
        tiles: b.tiles,
        troops: b.troops,
        isTraitor: p.isTraitor(),
        contact: b.contact,
        contactMix: b.contactMix,
      },
      models.regrowth(p),
      o.tribeRatio,
      o,
    );
    if (sz.S > avail) continue;
    if (sz.p > o.tribeMaxPrice * models.tnPrice(b.contactMix)) continue;
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
    if (comp < 0) continue;
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
  for (const c of mask.comps ?? []) if (c >= 0) compOff[c] |= 1;
  for (const c of mask.freeComps) if (c >= 0) compOff[c] |= 2;
  const cellOff = new Uint8Array(grid.cw * grid.ch);
  for (const c of mask.cells) if (c >= 0 && c < cellOff.length) cellOff[c] = 1;
  const ownerOff = mask.owners;
  const cells = sampleCells(game, grid, og);
  const owner = og.owner.slice();
  for (let i = 0; i < owner.length; i++) {
    const id = owner[i];
    const cell = cells[i];
    if (id === OWNER_WATER || id === mine || cell < 0) continue;
    const comp = grid.comp[cell];
    const off = comp >= 0 ? compOff[comp] : 0;
    if (
      (off & 1) !== 0 ||
      cellOff[cell] === 1 ||
      (id === 0 ? (off & 2) !== 0 : ownerOff.has(id))
    ) {
      owner[i] = OWNER_WATER;
    }
  }
  return { ...og, owner };
}

/** Landmasses with our free-land boat heading there, and tribes with a
 *  boat of ours or any plan (one boat per landmass, one per tribe). */
function busyTargets(
  v: View,
  grid: RaceGrid,
): { comps: Set<number>; tribes: Set<number> } {
  const { game, me } = v;
  const comps = new Set<number>();
  const tribes = new Set<number>();
  for (const plan of v.ledger.allPlans()) {
    if (plan.targetSmallID !== 0) tribes.add(plan.targetSmallID);
  }
  for (const u of me.units(UnitType.TransportShip)) {
    const t = u.targetTile();
    if (t === undefined) continue;
    const owner = game.ownerID(t);
    if (owner === 0) comps.add(grid.comp[cellOf(grid, game, t)]);
    else tribes.add(owner);
  }
  // A landing still fighting: its landmass is being taken (the OwnerGrid,
  // up to 100 ticks old, may not show it as ours yet).
  for (const a of me.outgoingAttacks()) {
    const src = a.sourceTile();
    if (src === null) continue;
    if (!a.target().isPlayer()) comps.add(grid.comp[cellOf(grid, game, src)]);
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
