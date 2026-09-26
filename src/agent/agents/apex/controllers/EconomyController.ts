import {
  Game,
  MAX_UPGRADE_AMOUNT,
  Player,
  PlayerType,
  Unit,
  UnitType,
} from "../../../../core/game/Game";
import { TileRef } from "../../../../core/game/GameMap";
import { Prio } from "../../../lib/Scheduler";
import type { ApexOptions } from "../options";
import type { Controller, View } from "../policy";
import type { ApexState } from "../state";

// Cities from loot (spec §3.8, §4 step 5). Every o.cityEvery ticks, with
// o.cities on and a structure policy that allows it:
// - cost = the City price ladder, min(1M, 2^k·125k) (config.unitInfo).
// - If our gold covers it and o.cityUpgradeFirst is on, upgrade our finished
//   city with the most levels below o.cityMaxLevel (then the deepest, then
//   the lowest unit id) whose depth is still at least o.cityMinDepth: one
//   upgrade_structure intent buys every level the gold covers (its
//   `amount`), up to o.cityMaxLevel, and the levels count in the cap at once
//   (UpgradeStructureExecution.init) [PIN EconomyGold: an upgrade costs the
//   next step of the same ladder and is instant].
// - Else build a city on the deepest interior tile we can find whose depth is
//   at least o.cityMinDepth, as the tile canBuild(City) returns (the game
//   builds at the nearest valid tile to the one asked for); with
//   o.citySpread, first among the sites farther than twice an atom bomb's
//   outer radius from our other cities. A new city counts in the cap once
//   finished, in turn constructionDuration + 2 = 22 after the intent's [PIN
//   EconomyGold].
// Why the cap and the spread (not in spec §3.8, which stacks every level on
// one site for M3's SAM umbrella): a bomb deletes every unit within its
// outer radius whatever its level (NukeExecution.ts:464-483) [PIN
// NukeThreat], and nations value a city at 25,000 per level
// (NationNukeBehavior.ts:720), so the stacked city was the target; arena
// quick@4 and showcase games lost 5-9 levels to one atom bomb before minute
// 4, and the troops above the smaller cap were cut the tick after [PIN
// TroopCapClamp].
// A check that finds nothing to do waits o.cityEvery ticks; one whose offer
// the Scheduler refuses (intent budget, build class cap) retries at the next
// decision.
// Depth is the Manhattan distance to our nearest border tile, the game's
// border (GameMap.isBorder: a 4-neighbour with another owner, water
// included; the map edge is not a border). Tribes capture structures on
// their border and delete them (TribeExecution.ts:99-106), and nations
// attack tribes that hold structures first (AiAttackBehavior.ts:285-287).
// Gold is not in the Purse: in M2 the economy is its only spender.

/** Grid points sampled over the bounding box of our land (the border's
 *  box, widened to the map edge where our land reaches it). */
const SITE_GRID = 1024;
/** Border tiles sampled for the approximate depth of each grid point. */
const BORDER_SAMPLE = 256;
/** Sites returned: the deepest found among the candidates measured. */
const EXACT_SITES = 16;
/** Candidates, by approximate depth, whose exact depth is measured at most.
 *  One next to a border tile the sample missed fails in a few rings. */
const EXACT_MEASURED = 96;
/** Depths are measured up to this multiple of cityMinDepth: deeper sites
 *  rank as equal (then by the sampled bound), which keeps a measure to a few
 *  thousand tile reads. */
export const DEPTH_CAP = 4;
/** canBuild(City) calls per check (each floods about 700 tiles). */
const BUILD_PROBES = 8;

/** A city action for one check. */
export type CityAction =
  | {
      kind: "upgrade";
      unitId: number;
      /** Levels bought by the one intent (UpgradeStructureIntent.amount). */
      amount: number;
      /** Gold for all of them. */
      cost: bigint;
      level: number;
      depth: number;
    }
  | { kind: "build"; tile: TileRef; cost: bigint; depth: number };

/** Why a check does nothing (logs and tests). */
export type CityIdle = "off" | "policy" | "gold" | "exposed" | "noSite";

/** What planCity reads of ApexOptions. */
export type CityOptions = Pick<
  ApexOptions,
  | "cities"
  | "cityUpgradeFirst"
  | "cityMinDepth"
  | "cityMaxLevel"
  | "citySpread"
  | "structurePolicy"
  | "exposureWide"
>;

/**
 * The exact depth of `tile` (ours): the Manhattan distance to our nearest
 * border tile, searched ring by ring up to `limit` (returned if no border
 * tile is nearer). −1 if the tile is not ours.
 *
 * A border tile has a 4-neighbour with another owner, so every tile within
 * distance r − 1 of `tile` is ours and not border exactly when every tile
 * on the map within distance r is ours: the depth is the radius of the
 * first ring holding a tile that is not ours, minus one. Off-map positions
 * are skipped, as the map edge is no border.
 */
export function borderDepth(
  game: Game,
  me: Player,
  tile: TileRef,
  limit: number,
): number {
  const us = me.smallID();
  if (game.ownerID(tile) !== us) return -1;
  const w = game.width();
  const h = game.height();
  const x = game.x(tile);
  const y = game.y(tile);
  for (let r = 1; r <= limit; r++) {
    for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      const dy = r - Math.abs(dx);
      const y1 = y + dy;
      if (y1 >= 0 && y1 < h && game.ownerID(game.ref(nx, y1)) !== us) {
        return r - 1;
      }
      const y2 = y - dy;
      if (dy !== 0 && y2 >= 0 && y2 < h) {
        if (game.ownerID(game.ref(nx, y2)) !== us) return r - 1;
      }
    }
  }
  return limit;
}

/** Whether no border tile of ours lies within distance < `depth` of
 *  `tile` (a tile of ours). */
export function deepEnough(
  game: Game,
  me: Player,
  tile: TileRef,
  depth: number,
): boolean {
  return borderDepth(game, me, tile, depth) >= depth;
}

/** Levels of our finished cities, the sum Config.maxTroops counts. */
export function finishedCityLevels(me: Player): number {
  let levels = 0;
  for (const c of me.units(UnitType.City)) {
    if (!c.isUnderConstruction()) levels += c.level();
  }
  return levels;
}

/**
 * Interior sites of depth ≥ `minDepth`, deepest first (ties: lowest
 * TileRef), at most EXACT_SITES. Grid points over the bounding box of our
 * border that are ours are ranked by their distance to an even sample of
 * our border tiles, an upper bound on the depth; in that order, up to
 * EXACT_MEASURED of them get their exact depth (borderDepth, capped at the
 * bound and at DEPTH_CAP·minDepth; `depth` is that capped value, ties go to
 * the larger bound) until EXACT_SITES reach `minDepth`. Linear in the border plus
 * SITE_GRID × BORDER_SAMPLE; no ctx.random. The grid can miss a ridge
 * narrower than its stride, so a territory whose only deep enough tiles
 * form such a ridge may get no site.
 */
export function interiorSites(
  game: Game,
  me: Player,
  minDepth: number,
  accept?: (tile: TileRef) => boolean,
): { tile: TileRef; depth: number }[] {
  const border = me.borderTiles();
  const n = border.size;
  if (n === 0) return [];
  const stride = Math.max(1, Math.ceil(n / BORDER_SAMPLE));
  const bx: number[] = [];
  const by: number[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let i = 0;
  border.forEach((t) => {
    const x = game.x(t);
    const y = game.y(t);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (i++ % stride === 0) {
      bx.push(x);
      by.push(y);
    }
  });
  // The map edge is no border, so our land can reach past the border's box
  // toward an edge. It then fills that whole strip: a tile of ours left of
  // x0 is no border tile, so its 4-neighbours are ours or off the map, and
  // so on across the strip. One tile tells.
  const us = me.smallID();
  const w = game.width();
  const h = game.height();
  const ours = (x: number, y: number) => game.ownerID(game.ref(x, y)) === us;
  const ax = x0;
  const ay = y0;
  if (x0 > 0 && ours(x0 - 1, ay)) x0 = 0;
  if (x1 < w - 1 && ours(x1 + 1, ay)) x1 = w - 1;
  if (y0 > 0 && ours(ax, y0 - 1)) y0 = 0;
  if (y1 < h - 1 && ours(ax, y1 + 1)) y1 = h - 1;
  const area = (x1 - x0 + 1) * (y1 - y0 + 1);
  const g = Math.max(1, Math.ceil(Math.sqrt(area / SITE_GRID)));
  const cands: { tile: TileRef; bound: number }[] = [];
  // Grid points centred in their cells.
  const ox = x0 + Math.floor(g / 2);
  const oy = y0 + Math.floor(g / 2);
  for (let y = oy; y <= y1; y += g) {
    for (let x = ox; x <= x1; x += g) {
      const t = game.ref(x, y);
      if (game.ownerID(t) !== us) continue;
      if (accept !== undefined && !accept(t)) continue;
      let bound = Infinity;
      for (let k = 0; k < bx.length; k++) {
        const d = Math.abs(bx[k] - x) + Math.abs(by[k] - y);
        if (d < bound) {
          bound = d;
          if (bound < minDepth) break;
        }
      }
      if (bound >= minDepth) cands.push({ tile: t, bound });
    }
  }
  cands.sort((a, b) => b.bound - a.bound || a.tile - b.tile);
  const cap = DEPTH_CAP * minDepth;
  const out: { tile: TileRef; depth: number; bound: number }[] = [];
  for (const c of cands.slice(0, EXACT_MEASURED)) {
    const depth = borderDepth(game, me, c.tile, Math.min(c.bound, cap));
    if (depth >= minDepth) out.push({ tile: c.tile, depth, bound: c.bound });
    if (out.length >= EXACT_SITES) break;
  }
  out.sort((a, b) => b.depth - a.depth || b.bound - a.bound || a.tile - b.tile);
  return out.map(({ tile, depth }) => ({ tile, depth }));
}

/**
 * Levels one upgrade intent can buy with `gold`: the next steps of the
 * City ladder, cost(me, n) for n = 0, 1, ... (config.unitInfo(City).cost with
 * extra units, as PlayerImpl.buildableUnits sums them), up to
 * MAX_UPGRADE_AMOUNT.
 */
export function affordableLevels(
  game: Game,
  me: Player,
  gold: bigint,
  max = MAX_UPGRADE_AMOUNT,
): { amount: number; cost: bigint } {
  const info = game.config().unitInfo(UnitType.City);
  let total = 0n;
  let amount = 0;
  const most = Math.min(MAX_UPGRADE_AMOUNT, max);
  while (amount < most) {
    const next = total + info.cost(game, me, amount);
    if (next > gold) break;
    total = next;
    amount++;
  }
  return { amount, cost: total };
}

/**
 * Whether a nation could nuke a structure at `site` now: a conservative
 * stand-in for NukeModel.exposures() (spec §2.9, M3, not built yet), which
 * lists only nations aiming at us. Here any living nation with a finished
 * missile silo and gold for an atom bomb at its real price (its perceived
 * price is never lower, NationNukeBehavior.ts:814-823) counts, unless a
 * finished SAM of ours covers the site (config.samRange of its level).
 * With `wide` (o.exposureWide) also a nation with a silo under construction
 * and bomb gold, or with gold for a silo and a bomb: nations built the silo
 * and fired within one check window (arena quick@4: Hokkaido, Rosedale).
 */
export function exposedSite(
  game: Game,
  me: Player,
  site: TileRef,
  wide = false,
): boolean {
  const config = game.config();
  for (const sam of me.units(UnitType.SAMLauncher)) {
    if (sam.isUnderConstruction()) continue;
    const r = config.samRange(sam.level());
    if (game.euclideanDistSquared(sam.tile(), site) <= r * r) return false;
  }
  const atom = config.unitInfo(UnitType.AtomBomb);
  const silo = config.unitInfo(UnitType.MissileSilo);
  for (const p of game.players()) {
    if (p === me || p.type() !== PlayerType.Nation || !p.isAlive()) continue;
    const bomb = atom.cost(game, p);
    const gold = p.gold();
    const silos = p.units(UnitType.MissileSilo);
    if (silos.some((u) => !u.isUnderConstruction()) && gold >= bomb) {
      return true;
    }
    if (!wide) continue;
    if (silos.length > 0 && gold >= bomb) return true;
    if (gold >= bomb + silo.cost(game, p)) return true;
  }
  return false;
}

/**
 * Our finished city levels that enemy bombs in flight will delete: every
 * city within a bomb's outer radius (config.nukeMagnitudes) of its target
 * tile (NukeExecution.ts:464-483) [PIN NukeThreat]. Bombs fly for about 120
 * ticks, and the levels leave the cap at impact (o.nukeReflex).
 */
export function inboundNukeLevels(game: Game, me: Player): number {
  if (me.unitCount(UnitType.City) === 0) return 0;
  const bombs = game.units(
    UnitType.AtomBomb,
    UnitType.HydrogenBomb,
    UnitType.MIRVWarhead,
  );
  if (bombs.length === 0) return 0;
  const cities = me
    .units(UnitType.City)
    .filter((c) => !c.isUnderConstruction());
  const hit = new Set<number>();
  let lost = 0;
  const config = game.config();
  for (const b of bombs) {
    if (b.owner() === me || !b.isActive()) continue;
    const t = b.targetTile();
    if (t === undefined) continue;
    const r = config.nukeMagnitudes(b.type()).outer;
    for (const c of cities) {
      if (hit.has(c.id())) continue;
      if (game.euclideanDistSquared(c.tile(), t) >= r * r) continue;
      hit.add(c.id());
      lost += c.level();
    }
  }
  return lost;
}

/** Levels of a city past which o.cityMaxLevel stops upgrades (Infinity for
 *  0: no cap). */
function levelCap(o: Pick<ApexOptions, "cityMaxLevel">): number {
  return o.cityMaxLevel > 0 ? o.cityMaxLevel : Infinity;
}

/** The upgrade target of §3.8: finished, upgradable now, below `maxLevel`,
 *  depth ≥ minDepth; the most levels, then the deepest, then the lowest
 *  id. */
function upgradeTarget(
  game: Game,
  me: Player,
  minDepth: number,
  maxLevel: number,
): { unit: Unit; depth: number } | null {
  let best: { unit: Unit; depth: number } | null = null;
  for (const c of me.units(UnitType.City)) {
    if (c.level() >= maxLevel) continue;
    if (c.isUnderConstruction() || !me.canUpgradeUnit(c)) continue;
    // Deeper than minDepth only matters for the ranking; capped as for
    // sites.
    const depth = borderDepth(game, me, c.tile(), DEPTH_CAP * minDepth);
    if (depth < minDepth) continue;
    if (
      best === null ||
      c.level() > best.unit.level() ||
      (c.level() === best.unit.level() &&
        (depth > best.depth ||
          (depth === best.depth && c.id() < best.unit.id())))
    ) {
      best = { unit: c, depth };
    }
  }
  return best;
}

/**
 * The interior sites (interiorSites) a build tries: with o.citySpread, the
 * deepest farther than twice an atom bomb's outer radius
 * (config.nukeMagnitudes) from every city of ours (built or not), so no one
 * bomb takes two, and only if there are none the deepest of all.
 */
export function citySites(
  game: Game,
  me: Player,
  o: Pick<ApexOptions, "cityMinDepth" | "citySpread">,
): { tile: TileRef; depth: number }[] {
  const cities = o.citySpread
    ? me.units(UnitType.City).map((c) => c.tile())
    : [];
  if (cities.length === 0) return interiorSites(game, me, o.cityMinDepth);
  // Twice the radius: a bomb aimed between two cities closer than that
  // takes both (arena quick@4, Onion: 31.6 tiles apart, one atom, 6 levels).
  const r = 2 * game.config().nukeMagnitudes(UnitType.AtomBomb).outer;
  const far = (t: TileRef) =>
    cities.every((c) => game.euclideanDistSquared(c, t) > r * r);
  const spread = interiorSites(game, me, o.cityMinDepth, far);
  if (spread.length > 0) return spread;
  return interiorSites(game, me, o.cityMinDepth);
}

/**
 * One §3.8 check: what to buy now, or why nothing. Pure in the game (only
 * getters, canBuild and canUpgradeUnit); the caller offers the intent.
 */
export function planCity(
  game: Game,
  me: Player,
  o: CityOptions,
): CityAction | CityIdle {
  if (!o.cities) return "off";
  if (o.structurePolicy === "never") return "policy";
  const gold = me.gold();
  const cost = game.config().unitInfo(UnitType.City).cost(game, me);
  if (gold < cost) return "gold";
  const exposure = o.structurePolicy === "exposure";
  const maxLevel = levelCap(o);
  let exposed = false;
  if (o.cityUpgradeFirst) {
    const up = upgradeTarget(game, me, o.cityMinDepth, maxLevel);
    if (up !== null) {
      if (exposure && exposedSite(game, me, up.unit.tile(), o.exposureWide)) {
        exposed = true;
      } else {
        const room = maxLevel - up.unit.level();
        const { amount, cost: total } = affordableLevels(game, me, gold, room);
        return {
          kind: "upgrade",
          unitId: up.unit.id(),
          amount: Math.max(1, amount),
          cost: total,
          level: up.unit.level(),
          depth: up.depth,
        };
      }
    }
  }
  let probes = 0;
  for (const site of citySites(game, me, o)) {
    if (probes >= BUILD_PROBES) break;
    probes++;
    const spawn = me.canBuild(UnitType.City, site.tile);
    if (spawn === false) continue;
    // The game builds at the valid tile nearest the one asked for; ask for
    // that one, and only if it is deep enough itself.
    const depth =
      spawn === site.tile
        ? site.depth
        : borderDepth(game, me, spawn, site.depth);
    if (depth < o.cityMinDepth) continue;
    if (exposure && exposedSite(game, me, spawn, o.exposureWide)) {
      exposed = true;
      continue;
    }
    return { kind: "build", tile: spawn, cost, depth };
  }
  return exposed ? "exposed" : "noSite";
}

/**
 * Cities from loot (spec §3.8); the SAM rule from M3 (§5.1.5). Enabled by
 * `o.economy`; cities by `o.cities`, upgrade-first by `o.cityUpgradeFirst`,
 * the site rule by `o.cityMinDepth`, the cadence by `o.cityEvery` and the
 * nuke rule by `o.structurePolicy`.
 */
export class EconomyController implements Controller {
  readonly name = "economy";

  decide(v: View, s: ApexState): void {
    const { o } = v;
    if (!o.cities || o.structurePolicy === "never") return;
    if (v.tick - s.timers.lastCity < o.cityEvery) return;
    const plan = planCity(v.game, v.me, o);
    if (typeof plan === "string") {
      s.timers.lastCity = v.tick;
      return;
    }
    const accepted =
      plan.kind === "upgrade"
        ? v.scheduler.offer({
            intent: {
              type: "upgrade_structure",
              unit: UnitType.City,
              unitId: plan.unitId,
              ...(plan.amount > 1 ? { amount: plan.amount } : {}),
            },
            prio: Prio.Build,
            cls: "build",
            key: `upgrade:${plan.unitId}`,
          })
        : v.scheduler.offer({
            intent: {
              type: "build_unit",
              unit: UnitType.City,
              tile: plan.tile,
            },
            prio: Prio.Build,
            cls: "build",
            key: "build:city",
          });
    // Refused (intent budget or the build class cap): try again at the
    // next decision instead of in cityEvery ticks.
    if (!accepted) return;
    s.timers.lastCity = v.tick;
    const levels = finishedCityLevels(v.me);
    const gold = v.me.gold();
    if (plan.kind === "upgrade") {
      v.log?.(
        `${v.tick} city upgrade #${plan.unitId} L${plan.level}+${plan.amount} ` +
          `depth=${plan.depth} cost=${plan.cost} gold=${gold} levels=${levels + plan.amount}`,
      );
    } else {
      v.log?.(
        `${v.tick} city build at ${v.game.x(plan.tile)},${v.game.y(plan.tile)} ` +
          `depth=${plan.depth} cost=${plan.cost} gold=${gold} levels=${levels}`,
      );
    }
  }
}
