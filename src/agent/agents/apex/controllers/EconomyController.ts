import {
  Game,
  MAX_UPGRADE_AMOUNT,
  Player,
  PlayerType,
  Structures,
  Unit,
  UnitType,
} from "../../../../core/game/Game";
import { TileRef } from "../../../../core/game/GameMap";
import { Bomb, NukeModel, NukeReason } from "../../../lib/NukeModel";
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
  | "nukeModel"
  | "nukeCities"
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
 * With `ignoreSams` (package B3, a doomed hub) our SAMs cover nothing.
 */
export function exposedSite(
  game: Game,
  me: Player,
  site: TileRef,
  wide = false,
  ignoreSams = false,
): boolean {
  const config = game.config();
  for (const sam of ignoreSams ? [] : me.units(UnitType.SAMLauncher)) {
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
  accept?: (c: Unit) => boolean,
): { unit: Unit; depth: number } | null {
  let best: { unit: Unit; depth: number } | null = null;
  for (const c of me.units(UnitType.City)) {
    if (c.level() >= maxLevel) continue;
    if (c.isUnderConstruction() || !me.canUpgradeUnit(c)) continue;
    // Deeper than minDepth only matters for the ranking; capped as for
    // sites.
    const depth = borderDepth(game, me, c.tile(), DEPTH_CAP * minDepth);
    if (depth < minDepth) continue;
    if (accept !== undefined && !accept(c)) continue;
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
  nukes?: NukePlan,
): CityAction | CityIdle {
  if (!o.cities) return "off";
  if (o.structurePolicy === "never") return "policy";
  const gold = me.gold();
  const cost = game.config().unitInfo(UnitType.City).cost(game, me);
  if (gold < cost) return "gold";
  if (o.nukeModel && nukes !== undefined && o.structurePolicy === "exposure") {
    return planCityModel(game, me, o, nukes, gold, cost);
  }
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

// ── Package B3: nukes and SAMs (spec §2.9, §5.1 item 5; chapter 13 §2.11,
//    §5.10) ─────────────────────────────────────────────────────────────
// With o.nukeModel (and structurePolicy "exposure"), NukeModel lists the
// *threats*: nations with a silo whose nuke ladder names us (now; latent,
// remembered for o.nukeMemory ticks, or by o.nukeRankGuard, with
// o.nukeLatent), and whose gold, projected o.nukeHorizon ticks ahead,
// reaches o.nukePayShare of a bomb's perceived price (a hydrogen bomb also
// for o.nukeMemory ticks after the nation fired one). A threat is *firing*
// when it answers us now, with a finished silo and the gold for a bomb.
// Arena quick@20 and showcase-m2 (package B3 notes): 16 of the 19 bombs at
// apex came from the land leader aiming at us as its runner-up, each one
// taking the city it was aimed at; the ladder named us 3-40 ticks before
// the first bomb, silo and gold ready.
//
// Cities (planCityModel): outside a SAM hub the legacy rule (exposedSite)
// still decides, and a firing threat able to aim at the site
// (NukeModel.nukeable: rings clear, no SAM reaching the aim point) refuses
// it too; inside a hub's covered ring every threat counts, anticipated
// hydrogen bombs included. o.nukeCities lets the model alone decide
// everywhere (ab1: that spent the idle gold and lost, see options.ts).
//
// The SAM hub (o.samHub). While threatened by atoms only, one SAM farther
// than an atom's outer radius from every structure of ours, and new cities
// in its covered ring: an aim point within an atom's outer radius of a
// city there is within the SAM's range, so its trajectory is interceptable
// and the nation skips it (NNB :197-204); finding no aim point it throws an
// atom salvo at the SAM instead (maybeDestroyEnemySam, :836-1061: level + 1
// bombs, from ready silo slots, at the real price, or it upgrades a silo
// first), and a blast deletes only units strictly inside its outer radius
// (NukeExecution.ts:467-483), so the ring's cities survive it. Hub cities
// keep o.citySpread's spacing (one bomb, one city once the SAM is gone).
// No SAM while a threat has, or will soon have, the gold for a hydrogen
// bomb: it outranges SAMs below level 5 and scores them 100k a level (NNB
// :750-775); one took a whole hub in ab1 and ab2 (Bering Strait).
//
// The SAM's lifetime (package B3 review; o.samHorizon, o.hubDoom). One
// check at the order does not cover the hub's life: a nation short of
// launch slots buys a silo level (1M, instant) at one decision and salvoes
// at a later one, and latent threats turn current with no warning. So
// every threat, latent ones included, with the gold (read o.samHorizon
// ticks ahead; 0: now) for the salvo line (NukeModel.salvoLine: a level
// per missing slot plus the salvo's atoms) or o.nukePayShare of its
// perceived hydrogen price, or that fired a hydrogen bomb or a salvo at
// our SAMs within o.nukeMemory ticks, refuses the SAM; and once a SAM
// stands, the same test at every city check (against the hub's
// interceptors) dooms the hub for o.nukeMemory ticks: no more levels in
// its ring, and our SAMs exempt no site from the legacy rule. conf1 g39
// (Bering Strait): the SAM, ordered at 1925 against a latent Alaska at
// 0.35M, drew two silo upgrades (2447, 2496) and a 2-atom salvo (2545)
// once 31 conquered tribes had raised Alaska to 4M; the hub's cities then
// fell to aimed atoms and a hydrogen bomb, and apex was eliminated; the
// champion lost the same cities earlier and survived. No gold projection
// foresaw that windfall (Alaska attacked no one at the order), and at 300
// or 600 ticks one would have refused the SAM in 4 of the 5 round-1 games
// where it helped, so the default reads the gold now.

/** A nation that could nuke a structure of ours (see nukeThreats). */
export interface NukeThreat {
  nation: Player;
  /** The bombs it could fire at us, now or soon (o.nukePayShare): only a
   *  hydrogen bomb once its gold covers that perceived price (the type
   *  choice never falls back to atoms, NNB :139-155); else an atom bomb,
   *  and a hydrogen bomb too once its gold reaches o.nukePayShare of that
   *  price or it fired one within o.nukeMemory ticks (quick@20 Bering
   *  Strait: Alaska went from 2.8M to 6M in 500 ticks and one hydrogen bomb
   *  took a SAM hub, 6 levels). */
  bombs: Bomb[];
  reason: NukeReason;
  /** Named below the rung that answers now, or by the rank guard. */
  latent: boolean;
  /** Ready launch slots of its finished silos. */
  slots: number;
  /** It would fire at us at its next ready decision: named on the rung
   *  that answers now, a finished silo, and the gold for a bomb at its
   *  perceived price now. */
  firing: boolean;
}

/** The model and this check's threats. */
export interface NukePlan {
  model: NukeModel;
  threats: NukeThreat[];
  /** A threat can destroy our SAM hub soon (o.hubDoom, samKiller): no more
   *  levels in its ring, and our SAMs exempt no site. */
  doomed?: boolean;
}

/** A threat able to destroy our SAMs (samKiller): by an atom salvo (its
 *  gold reaches the salvo line), a hydrogen bomb (o.nukePayShare of its
 *  perceived price), or proven by a launch within o.nukeMemory ticks (a
 *  salvo at our SAMs, a hydrogen bomb at anyone). */
export interface SamKiller {
  nation: Player;
  why: "salvo" | "hydro" | "salvoed" | "hydroFired";
  /** Its gold projected at the horizon, and the line it reaches (0 for
   *  the launch proofs). */
  gold: bigint;
  line: bigint;
}

/** What the B3 rules read of ApexOptions. */
export type NukeOptions = Pick<
  ApexOptions,
  | "nukeModel"
  | "nukeLatent"
  | "nukePayShare"
  | "nukeRankGuard"
  | "nukeMemory"
  | "nukeHorizon"
  | "samHub"
  | "samMax"
  | "samMinLevels"
  | "samSlotGate"
  | "samHorizon"
  | "hubDoom"
  | "samRebuild"
  | "cityMinDepth"
  | "citySpread"
>;

/**
 * This check's threats: every exposure (NukeModel.exposures) with a silo,
 * current or (o.nukeLatent) latent, whose gold covers the bomb it would
 * pick or at least o.nukePayShare of its perceived atom price; with
 * o.nukeMemory, as latent, every nation whose ladder named us within that
 * many ticks; with o.nukeRankGuard, while we rank first or second in land
 * among humans and nations (tribes, which the crown rungs also rank, are
 * eaten first), every other unfriendly nation with a silo in their top
 * three, latent. Latent threats count only with o.nukeLatent.
 */
export function nukeThreats(
  game: Game,
  me: Player,
  model: NukeModel,
  o: NukeOptions,
): NukeThreat[] {
  const out: NukeThreat[] = [];
  const share = BigInt(Math.round(o.nukePayShare * 1000));
  const since = game.ticks() - o.nukeMemory;
  const near = (N: Player, t: Bomb) =>
    model.projectedGold(N.id(), o.nukeHorizon) * 1000n >=
      model.perceivedCost(N.id(), t) * share ||
    // Paid for one within nukeMemory ticks (package B3 review).
    (t === UnitType.HydrogenBomb &&
      o.nukeMemory > 0 &&
      model.hydroSince(N.id(), since));
  const firing = (N: Player, latent: boolean): boolean =>
    !latent &&
    model.bombFor(N.id()) !== null &&
    N.units(UnitType.MissileSilo).some((u) => !u.isUnderConstruction());
  const pick = (N: Player): Bomb[] | null => {
    const now = model.bombFor(N.id());
    if (now === UnitType.HydrogenBomb) return [now];
    const bombs: Bomb[] = [];
    if (now === UnitType.AtomBomb || near(N, UnitType.AtomBomb)) {
      bombs.push(UnitType.AtomBomb);
    }
    if (near(N, UnitType.HydrogenBomb)) bombs.push(UnitType.HydrogenBomb);
    return bombs.length > 0 ? bombs : null;
  };
  for (const e of model.exposures()) {
    if (!e.hasSilo || (e.latent && !o.nukeLatent)) continue;
    const N = game.player(e.nation);
    const bombs = pick(N);
    if (bombs === null) continue;
    out.push({
      nation: N,
      bombs,
      reason: e.reason,
      latent: e.latent,
      slots: e.slots,
      firing: firing(N, e.latent),
    });
  }
  const latent = (N: Player, reason: NukeReason): void => {
    if (N === me || !N.isAlive() || N.type() !== PlayerType.Nation) return;
    if (N.isFriendly(me) || out.some((t) => t.nation === N)) return;
    const s = model.slots(N);
    if (s.silos === 0) return;
    const bombs = pick(N);
    if (bombs === null) return;
    out.push({
      nation: N,
      bombs,
      reason,
      latent: true,
      slots: s.now,
      firing: false,
    });
  };
  if (o.nukeLatent && o.nukeMemory > 0) {
    for (const n of model.namedSince(game.ticks() - o.nukeMemory)) {
      if (game.hasPlayer(n.nation)) latent(game.player(n.nation), n.reason);
    }
  }
  if (o.nukeLatent && o.nukeRankGuard) {
    const rank = model.nonBotRank();
    const ours = rank.indexOf(me);
    if (ours === 0 || ours === 1) {
      for (const N of rank.slice(0, 3)) {
        latent(N, ours === 0 ? "crownLead" : "runnerUp");
      }
    }
  }
  return out;
}

/** The first threat (of `among`, default all) with a bomb that has an aim
 *  point at `tile`, or null. */
export function threatAt(
  plan: NukePlan,
  tile: TileRef,
  among: readonly NukeThreat[] = plan.threats,
): NukeThreat | null {
  for (const t of among) {
    for (const b of t.bombs) {
      if (plan.model.nukeable([tile], b, t.nation)) return t;
    }
  }
  return null;
}

/**
 * The first threat (plan.threats, latent ones included) able to destroy
 * our SAMs of `levels` interceptors in all within `horizon` ticks, or null
 * (package B3 review, finding 1): one that fired an atom bomb at our SAMs
 * ("salvoed") or a hydrogen bomb at anyone ("hydroFired") within
 * o.nukeMemory ticks; one whose gold projected `horizon` ticks ahead
 * (NukeModel.projectedGold; 0: its gold now) reaches o.nukePayShare of
 * its perceived hydrogen price ("hydro": it outranges SAMs below level 5)
 * or the salvo line (NukeModel.salvoLine, "salvo"). Without `salvoed`, a
 * past salvo alone does not count (o.samRebuild).
 */
export function samKiller(
  game: Game,
  plan: NukePlan,
  o: NukeOptions,
  levels: number,
  horizon: number,
  salvoed = true,
): SamKiller | null {
  const m = plan.model;
  const since = game.ticks() - o.nukeMemory;
  const share = BigInt(Math.round(o.nukePayShare * 1000));
  for (const t of plan.threats) {
    const n = t.nation.id();
    if (salvoed && o.nukeMemory > 0 && m.salvoSince(n, since)) {
      return { nation: t.nation, why: "salvoed", gold: 0n, line: 0n };
    }
    if (o.nukeMemory > 0 && m.hydroSince(n, since)) {
      return { nation: t.nation, why: "hydroFired", gold: 0n, line: 0n };
    }
    const gold = m.projectedGold(n, horizon);
    const hydro = m.perceivedCost(n, UnitType.HydrogenBomb);
    if (
      !game.config().isUnitDisabled(UnitType.HydrogenBomb) &&
      gold * 1000n >= hydro * share
    ) {
      return { nation: t.nation, why: "hydro", gold, line: hydro };
    }
    const line = m.salvoLine(n, levels);
    if (gold >= line) return { nation: t.nation, why: "salvo", gold, line };
  }
  return null;
}

/** Interceptors a salvo at our weakest finished SAM must beat: the least,
 *  over our finished SAMs, of the levels of those of ours whose range
 *  covers it (findEnemySamsCoveringTile), or 0 without one. */
export function hubLevels(game: Game, me: Player): number {
  const config = game.config();
  const sams = me
    .units(UnitType.SAMLauncher)
    .filter((u) => !u.isUnderConstruction() && u.isActive());
  let least = 0;
  for (const s of sams) {
    let levels = 0;
    for (const c of sams) {
      const r = config.samRange(c.level());
      if (game.euclideanDistSquared(c.tile(), s.tile()) <= r * r) {
        levels += c.level();
      }
    }
    if (least === 0 || levels < least) least = levels;
  }
  return least;
}

/**
 * The covered ring of a SAM of `level` (config.samRange): a city there is
 * outside the atom salvo aimed at the SAM (distance ≥ outer radius + 1),
 * and every aim point within an atom's outer radius of it is within the
 * SAM's range (distance ≤ range − outer radius).
 */
export function hubRing(game: Game, level = 1): { min: number; max: number } {
  const config = game.config();
  const outer = config.nukeMagnitudes(UnitType.AtomBomb).outer;
  return { min: outer + 1, max: Math.floor(config.samRange(level)) - outer };
}

/** Integer offsets (dx, dy) with min ≤ |(dx, dy)| ≤ max, in raster order,
 *  every `stride`-th. */
function ringOffsets(
  min: number,
  max: number,
  stride: number,
): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  for (let dy = -max; dy <= max; dy++) {
    for (let dx = -max; dx <= max; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 < min * min || d2 > max * max) continue;
      if (i++ % stride === 0) out.push([dx, dy]);
    }
  }
  return out;
}

/** Ring samples per SAM or city for hub sites (about 60 of the ring's
 *  ~2,000 tiles at level 1). */
const HUB_SAMPLES = 60;

/**
 * City sites in the covered ring (hubRing, of each SAM's level) of our
 * finished SAMs: ours, at least o.cityMinDepth deep, and with o.citySpread
 * farther than twice an atom's outer radius from our other cities; deepest
 * first (ties: lowest tile).
 */
export function hubSites(
  game: Game,
  me: Player,
  o: Pick<ApexOptions, "cityMinDepth" | "citySpread">,
): { tile: TileRef; depth: number }[] {
  const sams = me
    .units(UnitType.SAMLauncher)
    .filter((u) => !u.isUnderConstruction() && u.isActive());
  if (sams.length === 0) return [];
  const us = me.smallID();
  const spread = 2 * game.config().nukeMagnitudes(UnitType.AtomBomb).outer;
  const cities = o.citySpread
    ? me.units(UnitType.City).map((c) => c.tile())
    : [];
  const seen = new Set<TileRef>();
  const out: { tile: TileRef; depth: number }[] = [];
  for (const sam of sams) {
    const ring = hubRing(game, sam.level());
    const all = ringOffsets(ring.min, ring.max, 1).length;
    const offsets = ringOffsets(
      ring.min,
      ring.max,
      Math.max(1, Math.floor(all / HUB_SAMPLES)),
    );
    const sx = game.x(sam.tile());
    const sy = game.y(sam.tile());
    for (const [dx, dy] of offsets) {
      const x = sx + dx;
      const y = sy + dy;
      if (!game.isValidCoord(x, y)) continue;
      const t = game.ref(x, y);
      if (seen.has(t) || game.ownerID(t) !== us) continue;
      seen.add(t);
      if (
        cities.some((c) => game.euclideanDistSquared(c, t) <= spread * spread)
      ) {
        continue;
      }
      const depth = borderDepth(game, me, t, DEPTH_CAP * o.cityMinDepth);
      if (depth >= o.cityMinDepth) out.push({ tile: t, depth });
    }
  }
  out.sort((a, b) => b.depth - a.depth || a.tile - b.tile);
  return out.slice(0, EXACT_SITES);
}

/** Whether `tile` lies in the covered ring (hubRing) of a finished SAM of
 *  ours. */
export function inHub(game: Game, me: Player, tile: TileRef): boolean {
  for (const sam of me.units(UnitType.SAMLauncher)) {
    if (sam.isUnderConstruction() || !sam.isActive()) continue;
    const ring = hubRing(game, sam.level());
    const d2 = game.euclideanDistSquared(sam.tile(), tile);
    if (d2 >= ring.min * ring.min && d2 <= ring.max * ring.max) return true;
  }
  return false;
}

/**
 * planCity under the model (o.nukeModel). In a hub's covered ring
 * (inHub), an upgrade or a build needs a tile no threat can aim at
 * (threatAt over every threat, latent and anticipated bombs included: the
 * hub concentrates levels). Elsewhere, unless o.nukeCities, it needs
 * exposedSite's consent (the legacy rule) and no firing threat able to aim
 * there; with o.nukeCities, the model alone decides, over every threat.
 * Sites: the hub sites first (hubSites), then the usual ones. Never a new
 * city within hubRing().min of a SAM of ours: the salvo a SAM draws would
 * take it. A doomed hub (plan.doomed, o.hubDoom) is no hub: its ring gets
 * no levels, and our SAMs exempt no site from exposedSite.
 */
function planCityModel(
  game: Game,
  me: Player,
  o: CityOptions,
  plan: NukePlan,
  gold: bigint,
  cost: bigint,
): CityAction | CityIdle {
  let exposed = false;
  const firing = plan.threats.filter((t) => t.firing);
  const doomed = plan.doomed === true;
  const safe = (t: TileRef): boolean => {
    const hub = inHub(game, me, t);
    if (doomed && hub) {
      exposed = true;
      return false;
    }
    const legacy = !o.nukeCities && !hub;
    if (legacy && exposedSite(game, me, t, o.exposureWide, doomed)) {
      exposed = true;
      return false;
    }
    const among = legacy ? firing : plan.threats;
    if (among.length > 0 && threatAt(plan, t, among) !== null) {
      exposed = true;
      return false;
    }
    return true;
  };
  const maxLevel = levelCap(o);
  if (o.cityUpgradeFirst) {
    const up = upgradeTarget(game, me, o.cityMinDepth, maxLevel, (c) =>
      safe(c.tile()),
    );
    if (up !== null) {
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
  const sams = me.units(UnitType.SAMLauncher).map((u) => u.tile());
  const salvoR2 = hubRing(game).min ** 2;
  const clearOfSams = (t: TileRef) =>
    sams.every((sam) => game.euclideanDistSquared(sam, t) >= salvoR2);
  const sites = [
    ...(doomed ? [] : hubSites(game, me, o)),
    ...citySites(game, me, o),
  ].filter((site) => clearOfSams(site.tile));
  let probes = 0;
  for (const site of sites) {
    if (probes >= BUILD_PROBES) break;
    probes++;
    const spawn = me.canBuild(UnitType.City, site.tile);
    if (spawn === false) continue;
    const depth =
      spawn === site.tile
        ? site.depth
        : borderDepth(game, me, spawn, site.depth);
    if (depth < o.cityMinDepth) continue;
    if (!clearOfSams(spawn) || !safe(spawn)) continue;
    return { kind: "build", tile: spawn, cost, depth };
  }
  return exposed ? "exposed" : "noSite";
}

/** A SAM build of the hub rule. */
export interface SamAction {
  kind: "sam";
  tile: TileRef;
  cost: bigint;
  /** Finished city levels in its covered ring. */
  covered: number;
  depth: number;
}

/** Why the hub rule builds no SAM (logs and tests). */
export type SamIdle =
  | "off"
  | "noThreat"
  | "hydro"
  | "max"
  | "salvo"
  | "salvoed"
  | "gold"
  | "small"
  | "noSite";

/**
 * The SAM hub rule (o.samHub): with threats, none with a hydrogen bomb
 * among its bombs (nukeThreats), fewer than o.samMax SAMs of ours
 * (finished or not), and gold for one, the site farther than
 * hubRing().min from every structure of ours
 * (a salvo at it spares them) whose covered ring holds the most finished
 * city levels (then the deepest, then the lowest tile), at least
 * o.cityMinDepth deep; built only if it covers o.samMinLevels levels or our
 * gold also pays the next city level. With o.samSlotGate, none while a
 * current threat could salvo it at once: two ready slots and real gold for
 * two atoms, or one of each while nothing else of ours is nukeable (a SAM
 * under construction covers nothing, so one bomb takes it). With
 * o.samHorizon ≥ 0, none while samKiller finds a threat, latent ones
 * included, able to destroy a level-1 SAM with its gold read that many
 * ticks ahead ("hydro", "salvo"), or one that fired a salvo at our SAMs
 * within o.nukeMemory ticks, unless o.samRebuild ("salvoed").
 */
export function planSam(
  game: Game,
  me: Player,
  o: CityOptions & NukeOptions,
  plan: NukePlan,
): SamAction | SamIdle {
  if (!o.samHub) return "off";
  if (plan.threats.length === 0) return "noThreat";
  if (plan.threats.some((t) => t.bombs.includes(UnitType.HydrogenBomb))) {
    return "hydro";
  }
  if (me.units(UnitType.SAMLauncher).length >= o.samMax) return "max";
  if (o.samHorizon >= 0) {
    const k = samKiller(game, plan, o, 1, o.samHorizon, !o.samRebuild);
    if (k !== null) {
      return k.why === "salvo" || k.why === "salvoed" ? k.why : "hydro";
    }
  }
  const config = game.config();
  if (o.samSlotGate) {
    const scored = me
      .units(Structures.types)
      .filter(
        (u) => u.type() !== UnitType.SAMLauncher && !u.isUnderConstruction(),
      )
      .map((u) => u.tile());
    for (const t of plan.threats) {
      if (t.latent) continue;
      const atom = config.unitInfo(UnitType.AtomBomb).cost(game, t.nation);
      const gold = t.nation.gold();
      if (t.slots >= 2 && gold >= 2n * atom) return "salvo";
      if (
        t.slots >= 1 &&
        gold >= atom &&
        !t.bombs.some((b) => plan.model.nukeable(scored, b, t.nation))
      ) {
        return "salvo";
      }
    }
  }
  const cost = config.unitInfo(UnitType.SAMLauncher).cost(game, me);
  const gold = me.gold();
  if (gold < cost) return "gold";
  const ring = hubRing(game, 1);
  const structures = me.units(Structures.types).map((u) => u.tile());
  const cities = me
    .units(UnitType.City)
    .filter((c) => !c.isUnderConstruction());
  const clear = (t: TileRef) =>
    structures.every(
      (s) => game.euclideanDistSquared(s, t) >= ring.min * ring.min,
    );
  const covered = (t: TileRef): number => {
    let levels = 0;
    for (const c of cities) {
      const d2 = game.euclideanDistSquared(c.tile(), t);
      if (d2 >= ring.min * ring.min && d2 <= ring.max * ring.max) {
        levels += c.level();
      }
    }
    return levels;
  };
  const us = me.smallID();
  const cands = new Map<TileRef, number>();
  const consider = (t: TileRef) => {
    if (cands.has(t) || game.ownerID(t) !== us || !clear(t)) return;
    cands.set(t, covered(t));
  };
  // Around each finished city (it is then in the ring), and the deepest
  // sites clear of our structures (a hub to fill).
  const all = ringOffsets(ring.min, ring.max, 1).length;
  const around = ringOffsets(
    ring.min,
    ring.max,
    Math.max(1, Math.floor(all / 24)),
  );
  for (const c of cities) {
    const cx = game.x(c.tile());
    const cy = game.y(c.tile());
    for (const [dx, dy] of around) {
      if (game.isValidCoord(cx + dx, cy + dy)) {
        consider(game.ref(cx + dx, cy + dy));
      }
    }
  }
  for (const s of interiorSites(game, me, o.cityMinDepth, clear)) {
    consider(s.tile);
  }
  const ranked: { tile: TileRef; covered: number; depth: number }[] = [];
  for (const [tile, levels] of cands) {
    const depth = borderDepth(game, me, tile, DEPTH_CAP * o.cityMinDepth);
    if (depth >= o.cityMinDepth) ranked.push({ tile, covered: levels, depth });
  }
  ranked.sort(
    (a, b) => b.covered - a.covered || b.depth - a.depth || a.tile - b.tile,
  );
  const next = config.unitInfo(UnitType.City).cost(game, me);
  let probes = 0;
  let small = false;
  for (const r of ranked) {
    if (probes >= BUILD_PROBES) break;
    if (r.covered < o.samMinLevels && gold < cost + next) {
      small = true;
      break;
    }
    probes++;
    const spawn = me.canBuild(UnitType.SAMLauncher, r.tile);
    if (spawn === false) continue;
    if (spawn !== r.tile && !clear(spawn)) continue;
    const depth =
      spawn === r.tile
        ? r.depth
        : borderDepth(game, me, spawn, DEPTH_CAP * o.cityMinDepth);
    if (depth < o.cityMinDepth) continue;
    const levels = spawn === r.tile ? r.covered : covered(spawn);
    if (levels < o.samMinLevels && gold < cost + next) continue;
    return { kind: "sam", tile: spawn, cost, covered: levels, depth };
  }
  return small ? "small" : "noSite";
}

/**
 * Cities from loot (spec §3.8); the SAM rule from M3 (§5.1.5). Enabled by
 * `o.economy`; cities by `o.cities`, upgrade-first by `o.cityUpgradeFirst`,
 * the site rule by `o.cityMinDepth`, the cadence by `o.cityEvery` and the
 * nuke rule by `o.structurePolicy`.
 */
export class EconomyController implements Controller {
  readonly name = "economy";
  /** Package B3 (o.hubDoom): the last city check that found a threat able
   *  to destroy our SAM hub (samKiller), and that threat. */
  private doomAt = Number.NEGATIVE_INFINITY;
  private doomBy: SamKiller | null = null;

  decide(v: View, s: ApexState): void {
    const { o } = v;
    if (!o.cities || o.structurePolicy === "never") return;
    if (v.tick - s.timers.lastCity < o.cityEvery) return;
    // Package B3: the nuke model's threats, and the SAM hub before cities
    // (spec §5.0 gold priority: the SAM first).
    const nukes: NukePlan | undefined =
      o.nukeModel && v.nukes !== undefined && o.structurePolicy === "exposure"
        ? {
            model: v.nukes,
            threats: nukeThreats(v.game, v.me, v.nukes, o),
          }
        : undefined;
    if (nukes !== undefined && o.hubDoom) this.doom(v, nukes);
    if (nukes !== undefined && this.sam(v, s, nukes)) return;
    const plan = planCity(v.game, v.me, o, nukes);
    if (typeof plan === "string") {
      // Once a minute (the first check in it), why a threat blocks cities.
      if (
        nukes !== undefined &&
        nukes.threats.length > 0 &&
        Math.floor(v.tick / 600) !== Math.floor(s.timers.lastCity / 600)
      ) {
        v.log?.(
          `${v.tick} city ${plan}: threats ${threatList(nukes)} ` +
            `sam=${planSam(v.game, v.me, o, nukes) as string}` +
            (nukes.doomed === true ? ` doom=${killerText(this.doomBy)}` : "") +
            ` gold=${v.me.gold()}`,
        );
      }
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
          `depth=${plan.depth} cost=${plan.cost} gold=${gold} levels=${levels + plan.amount}` +
          (nukes !== undefined && nukes.threats.length > 0
            ? ` threats ${threatList(nukes)}`
            : ""),
      );
    } else {
      v.log?.(
        `${v.tick} city build at ${v.game.x(plan.tile)},${v.game.y(plan.tile)} ` +
          `depth=${plan.depth} cost=${plan.cost} gold=${gold} levels=${levels}` +
          (nukes !== undefined && nukes.threats.length > 0
            ? ` threats ${threatList(nukes)}`
            : ""),
      );
    }
  }

  /**
   * The hub's upkeep (o.hubDoom): with a finished SAM of ours, a threat
   * that samKiller finds able to destroy it (gold read o.samHorizon ticks
   * ahead, at least 0) dooms the hub for o.nukeMemory ticks (plan.doomed).
   * Logged when it starts and once a minute while it holds.
   */
  private doom(v: View, nukes: NukePlan): void {
    const { o } = v;
    const levels = hubLevels(v.game, v.me);
    if (levels > 0) {
      const k = samKiller(v.game, nukes, o, levels, Math.max(0, o.samHorizon));
      if (k !== null) {
        const fresh = v.tick - this.doomAt > o.nukeMemory;
        if (
          fresh ||
          Math.floor(v.tick / 600) !== Math.floor(this.doomAt / 600)
        ) {
          v.log?.(
            `${v.tick} hub doomed${fresh ? "" : " still"}: ${killerText(k)} ` +
              `interceptors=${levels} threats ${threatList(nukes)}`,
          );
        }
        this.doomAt = v.tick;
        this.doomBy = k;
      }
    }
    nukes.doomed = v.tick - this.doomAt <= o.nukeMemory;
  }

  /** The SAM hub rule (planSam): offers the SAM and returns true if it was
   *  accepted. */
  private sam(v: View, s: ApexState, nukes: NukePlan): boolean {
    const plan = planSam(v.game, v.me, v.o, nukes);
    if (typeof plan === "string") return false;
    const accepted = v.scheduler.offer({
      intent: {
        type: "build_unit",
        unit: UnitType.SAMLauncher,
        tile: plan.tile,
      },
      prio: Prio.Build,
      cls: "build",
      key: "build:sam",
    });
    if (!accepted) return false;
    s.timers.lastCity = v.tick;
    v.log?.(
      `${v.tick} sam build at ${v.game.x(plan.tile)},${v.game.y(plan.tile)} ` +
        `covered=${plan.covered} depth=${plan.depth} cost=${plan.cost} ` +
        `gold=${v.me.gold()} threats ${threatList(nukes)}`,
    );
    return true;
  }
}

/** A SamKiller for a log line: name, why, projected gold against the line. */
function killerText(k: SamKiller | null): string {
  if (k === null) return "-";
  return k.line > 0n
    ? `${k.nation.name()}:${k.why} ${k.gold}>=${k.line}`
    : `${k.nation.name()}:${k.why}`;
}

/** The threats for a log line: name, rung, bomb, slots. */
function threatList(plan: NukePlan): string {
  return (
    "[" +
    plan.threats
      .map(
        (t) =>
          `${t.nation.name()}:${t.reason}${t.latent ? "~" : ""}:` +
          t.bombs
            .map((b) => (b === UnitType.HydrogenBomb ? "H" : "A"))
            .join("") +
          `${t.slots}`,
      )
      .join(",") +
    "]"
  );
}
