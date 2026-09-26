import { Game, Player, PlayerID, PlayerType } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import {
  allySlots,
  ArrivalField,
  cellOf,
  growthRadius,
  MIN_DISC_FREE,
  RaceFieldOptions,
  RaceGrid,
  raceScore,
  SpawnCandidate,
  staticArrival,
} from "./RaceField";

// Erasure candidates for the spawn preview (package A3; chapter 13 §2.1 and
// §5.1). A spawn sent at the agent's first call (ctx.tick === 1) lands in
// tick 2, before every nation; the nations then land on their tick-1 picks
// with only the free part of their disc, and one whose disc we cover
// entirely is never placed [PIN SpawnPhaseSingleplayer 9-12]. Our disc and a
// nation's are the same shape (getSpawnTiles), so a spawn on exactly a
// nation's pick covers its disc: that nation is erased, and we start where it
// would have, without it in the race.
//
// Read-only, like RaceField: every function only calls getters on the game
// it is given. `game` is the preview's layout: a fork of the tick-1 game
// advanced 2 ticks without our spawn, so the tribes and every nation are on
// the ground (each nation's spawnTile() is its pick).
//
// Scoring is RaceField's (spec §3.2.3 step 2) on the arrival field without
// the erased nation: the land that nation would have raced us for counts as
// ours. RaceField keeps its site score private (CandidateContext.evaluate),
// so siteScore mirrors it; SpawnPreview.test pins the two equal on real maps.

/** Mirrors RaceField's private constants: threat counts the nations within
 *  r(1200) + 2 cells, θ = min(2, webTarget), a fresh (snackable) tribe
 *  holds fewer than 100 tiles. */
const THREAT_TICK = 1200;
const THREAT_EXTRA_CELLS = 2;
const THETA_MAX = 2;
const FRESH_TRIBE_TILES = 100;

/**
 * raceScore's margin for the bound. On the full field (the nation still in
 * it) the nation's own arrival at a cell equals ours from its pick, so a
 * margin just below 0 lets us through its land and stops us wherever another
 * nation arrives first: an optimistic version of the field without it, for
 * one bounded search instead of a full nation search. Not a strict upper
 * bound (a cell whose shortest path from the pick crosses another nation's
 * land compares our longer detour with the nation's straight arrival), but
 * it held for every nation of the 16 quick maps, where the exact best was
 * first or second by it; SpawnPreview.test checks World and Alps.
 */
const BOUND_MARGIN = -1e-3;

/**
 * The spawn disc: getSpawnTiles(gm, t) floods euclDistFN(t, 4, true)
 * (execution/Util.ts), (dx + 0.5)² + (dy + 0.5)² ≤ 16 for dx, dy in −4..3,
 * 52 tiles, clipped by the map edge. Flattened (dx, dy) pairs; pinned
 * against getSpawnTiles in SpawnPreview.test.
 */
export const DISC_OFFSETS: Int8Array = (() => {
  const out: number[] = [];
  const r = 4;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const fx = dx + 0.5;
      const fy = dy + 0.5;
      if (fx * fx + fy * fy <= r * r) out.push(dx, dy);
    }
  }
  return Int8Array.from(out);
})();

/** The disc's tiles around `tile`, clipped by the map (any terrain). */
export function discTiles(game: Game, tile: TileRef): TileRef[] {
  const map = game.map();
  const W = map.width();
  const H = map.height();
  const x = map.x(tile);
  const y = map.y(tile);
  const out: TileRef[] = [];
  for (let i = 0; i < DISC_OFFSETS.length; i += 2) {
    const nx = x + DISC_OFFSETS[i];
    const ny = y + DISC_OFFSETS[i + 1];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    out.push(map.ref(nx, ny));
  }
  return out;
}

/** Whether `t` lies in the disc around `center`. */
function inDisc(game: Game, center: TileRef, t: TileRef): boolean {
  const fx = game.x(t) - game.x(center) + 0.5;
  const fy = game.y(t) - game.y(center) + 0.5;
  return fx * fx + fy * fy <= 16;
}

/**
 * A view of `game` whose players() leaves out the players `hidden` accepts;
 * every other member is the game's own. For staticArrival (its sources) and
 * allySlots (its player count). Read-only.
 */
export function withoutPlayers(
  game: Game,
  hidden: (p: Player) => boolean,
): Game {
  return new Proxy(game, {
    get(target, prop) {
      if (prop === "players") {
        return () => target.players().filter((p) => !hidden(p));
      }
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** RaceField's site score, spec §3.2.3 step 2. */
export interface SiteScore {
  /** Land we win before anyone by our tick 900. */
  A: number;
  /** Land we win before any nation by our tick 1,800. */
  B: number;
  threat: number;
  snack: boolean;
  /** exp(−λ·max(0, threat − θ)). */
  discount: number;
  score: number;
  /** Set by capToReach when the connected land cut A or B. */
  reach?: number;
}

/**
 * CandidateContext.evaluate (RaceField) for a site: (A + β·B) ·
 * exp(−λ·max(0, threat − θ)) + snackBonus·[snack]. `mine` says which disc
 * tiles the spawn takes (RaceField: unowned passable land); `skip` leaves
 * nations out of the threat count.
 */
export function siteScore(
  grid: RaceGrid,
  arr: ArrivalField,
  game: Game,
  me: Player,
  o: RaceFieldOptions,
  tile: TileRef,
  mine: (t: TileRef) => boolean,
  margin: number = o.spawnMarginTicks,
  skip: ReadonlySet<PlayerID> = new Set(),
): SiteScore {
  const cell = cellOf(grid, game, tile);
  const { A, B } =
    margin === o.spawnMarginTicks
      ? raceScore(grid, arr, cell, o)
      : raceScore(grid, arr, cell, { ...o, spawnMarginTicks: margin });
  const threat = threatAt(grid, arr, cell, o, skip);
  const theta = Math.min(
    THETA_MAX,
    allySlots(game, me, o.allySlotsReserve).webTarget,
  );
  const snack = touchesFreshTribe(game, tile, mine);
  const discount = Math.exp(-o.spawnThreatLambda * Math.max(0, threat - theta));
  const score =
    (A + o.spawnBeta * B) * discount + (snack ? o.spawnSnackBonus : 0);
  return { A, B, threat, snack, discount, score };
}

/**
 * Passable land 4-connected to the disc around `tile`, whoever holds it
 * (land attacks cross it; water and impassable terrain stop them), counted
 * up to `cap`; `cap` as soon as that land touches an ocean shore, since
 * boats get off it (quick@4 Europe, game 6: the race best sat on a 32k-tile
 * coastal pocket, and apex boated to the mainland from minute 1 and held
 * 115k tiles at minute 3). The race grid links cells, so a river a tile or
 * two wide inside a cell does not split a landmass there (RaceGrid.links),
 * and a site walled in by rivers is scored on the land beyond them: quick@4
 * Africa, game 27, Iraq's pick scored B = 57k tiles, and its landlocked
 * pocket held the 12,784 tiles we sat on from minute 1 to 4.
 */
export function landReach(game: Game, tile: TileRef, cap: number): number {
  const map = game.map();
  const W = map.width();
  const H = map.height();
  const seen = new Set<TileRef>();
  const queue: TileRef[] = [];
  // Refs are row-major (map.ref(x, y) = y·W + x, as buildRaceGrid reads).
  const visit = (t: TileRef) => {
    if (!seen.has(t) && map.isLand(t) && !map.isImpassable(t)) {
      seen.add(t);
      queue.push(t);
    }
  };
  for (const t of discTiles(game, tile)) visit(t);
  for (let i = 0; i < queue.length && seen.size < cap; i++) {
    const t = queue[i];
    if (map.isOceanShore(t)) return cap;
    const x = map.x(t);
    const y = map.y(t);
    if (x > 0) visit(t - 1);
    if (x < W - 1) visit(t + 1);
    if (y > 0) visit(t - W);
    if (y < H - 1) visit(t + W);
  }
  return Math.min(seen.size, cap);
}

/** `s` with A and B at most `reach` tiles (landReach), rescored. */
export function capToReach(
  s: SiteScore,
  reach: number,
  o: RaceFieldOptions,
): SiteScore {
  if (s.A <= reach && s.B <= reach) return s;
  const A = Math.min(s.A, reach);
  const B = Math.min(s.B, reach);
  const score =
    (A + o.spawnBeta * B) * s.discount + (s.snack ? o.spawnSnackBonus : 0);
  return { ...s, A, B, score, reach };
}

/**
 * A race candidate's score with its A and B capped by landReach: the floor
 * an erasure site must beat. Its discount is read off its own score.
 */
export function reachScore(
  game: Game,
  c: SpawnCandidate,
  o: RaceFieldOptions,
): number {
  const snack = c.snack ? o.spawnSnackBonus : 0;
  const base = c.free + o.spawnBeta * c.pie;
  const discount = base > 0 ? (c.score - snack) / base : 1;
  const reach = landReach(game, c.tile, Math.max(c.free, c.pie) + 1);
  const site: SiteScore = {
    A: c.free,
    B: c.pie,
    threat: c.threat,
    snack: c.snack,
    discount,
    score: c.score,
  };
  return capToReach(site, reach, o).score;
}

/** Nations (but `skip`) with a cell within r(1200) + 2 cells of `cell`. */
function threatAt(
  grid: RaceGrid,
  arr: ArrivalField,
  cell: number,
  o: RaceFieldOptions,
  skip: ReadonlySet<PlayerID>,
): number {
  const { cw } = grid;
  const r = growthRadius(o, THREAT_TICK) / grid.cell + THREAT_EXTRA_CELLS;
  const r2 = r * r;
  const cx = cell % cw;
  const cy = (cell - cx) / cw;
  let count = 0;
  for (const [id, cells] of arr.nationCells) {
    if (skip.has(id)) continue;
    for (const c of cells) {
      const x = c % cw;
      const dx = x - cx;
      const dy = (c - x) / cw - cy;
      if (dx * dx + dy * dy <= r2) {
        count++;
        break;
      }
    }
  }
  return count;
}

/** A disc tile the spawn takes has a 4-neighbour held by a fresh tribe
 *  (§3.6.1: it falls to one attack). */
function touchesFreshTribe(
  game: Game,
  tile: TileRef,
  mine: (t: TileRef) => boolean,
): boolean {
  const map = game.map();
  const W = map.width();
  const H = map.height();
  for (const t of discTiles(game, tile)) {
    if (!mine(t)) continue;
    const x = map.x(t);
    const y = map.y(t);
    for (const [ax, ay] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
      const a = map.ref(ax, ay);
      if (!map.hasOwner(a)) continue;
      const p = game.playerBySmallID(map.ownerID(a));
      if (
        p.isPlayer() &&
        p.type() === PlayerType.Bot &&
        p.numTilesOwned() < FRESH_TRIBE_TILES
      ) {
        return true;
      }
    }
  }
  return false;
}

/** One erasure site: a spawn on `nation`'s pick. */
export interface EraseCandidate {
  /** The nation's pick (its spawn tile in the layout). */
  tile: TileRef;
  nation: PlayerID;
  name: string;
  /** Other nations whose whole disc lies inside ours: erased as well. */
  also: PlayerID[];
  /** Tiles our spawn takes: the disc's passable land that no tribe holds. */
  disc: number;
  /** The optimistic score it was ranked by (BOUND_MARGIN). */
  bound: number;
  /** The site's score on the field without the erased nations. */
  site: SiteScore;
}

/** The options eraseCandidates reads (ApexOptions has them). */
export interface EraseOptions extends RaceFieldOptions {
  /** Most erasure sites scored exactly. */
  spawnEraseK: number;
  /** Nations that must be left after an erasure (placedNations minus the
   *  erased ones); a site that would leave fewer is not considered. */
  spawnEraseMinLeft: number;
}

/** The nations placed in the layout: alive once their spawn tick has run. */
export function placedNations(game: Game): number {
  let n = 0;
  for (const p of game.players()) {
    if (p.type() === PlayerType.Nation && p.isAlive()) n++;
  }
  return n;
}

/** What spawning on `tile` does to the layout's nations, or null when it
 *  would cut one (a partial overlap leaves a small nation with all its
 *  troops on our border) or take fewer than MIN_DISC_FREE tiles. */
export function eraseLayout(
  game: Game,
  nation: Player,
  tile: TileRef,
): { also: PlayerID[]; disc: number } | null {
  const map = game.map();
  let disc = 0;
  const touched = new Set<Player>();
  for (const t of discTiles(game, tile)) {
    if (!map.isLand(t) || map.isImpassable(t)) continue;
    if (map.hasOwner(t)) {
      const p = game.playerBySmallID(map.ownerID(t));
      if (!p.isPlayer() || p.type() === PlayerType.Bot) continue;
      touched.add(p);
    }
    disc++;
  }
  if (disc < MIN_DISC_FREE || !touched.has(nation)) return null;
  const also: PlayerID[] = [];
  for (const p of touched) {
    for (const t of p.tiles()) {
      if (!inDisc(game, tile, t)) return null;
    }
    if (p !== nation) also.push(p.id());
  }
  return { also, disc };
}

/** An erasure site before its exact score. */
export type RankedErasure = Omit<EraseCandidate, "site">;

/** What our spawn takes in the layout: passable land no tribe holds (a
 *  nation's tiles are still free when we land, in tick 2 before it). */
function takes(game: Game): (t: TileRef) => boolean {
  const map = game.map();
  return (t: TileRef) => {
    if (!map.isLand(t) || map.isImpassable(t)) return false;
    if (!map.hasOwner(t)) return true;
    const p = game.playerBySmallID(map.ownerID(t));
    return p.isPlayer() && p.type() !== PlayerType.Bot;
  };
}

/**
 * Every placed nation's pick that eraseLayout accepts, ranked by the
 * optimistic bound: raceScore on the full field `arr` at BOUND_MARGIN, the
 * threat without the erased nations (one bounded search each). Best first.
 */
export function rankErasures(
  grid: RaceGrid,
  arr: ArrivalField,
  game: Game,
  me: Player,
  o: RaceFieldOptions,
): RankedErasure[] {
  const mine = takes(game);
  const ranked: RankedErasure[] = [];
  for (const n of game.players()) {
    if (n.type() !== PlayerType.Nation || !n.isAlive()) continue;
    const tile = n.spawnTile();
    if (tile === undefined) continue;
    const layout = eraseLayout(game, n, tile);
    if (layout === null) continue;
    const skip = new Set([n.id(), ...layout.also]);
    const bound = siteScore(
      grid,
      arr,
      game,
      me,
      o,
      tile,
      mine,
      BOUND_MARGIN,
      skip,
    ).score;
    ranked.push({ tile, nation: n.id(), name: n.name(), ...layout, bound });
  }
  return ranked.sort((a, b) => b.bound - a.bound || a.tile - b.tile);
}

/** The exact score of an erasure site: siteScore on the field without the
 *  erased nations (a full nation search; the tribes' field is unchanged),
 *  its A and B capped by the land connected to the site (landReach). */
export function scoreErasure(
  grid: RaceGrid,
  arr: ArrivalField,
  game: Game,
  me: Player,
  o: RaceFieldOptions,
  r: RankedErasure,
): SiteScore {
  const hidden = new Set([r.nation, ...r.also]);
  const nations = staticArrival(
    grid,
    withoutPlayers(
      game,
      (p) => hidden.has(p.id()) || p.type() === PlayerType.Bot,
    ),
    o,
  );
  const without: ArrivalField = {
    nation: nations.nation,
    tribe: arr.tribe,
    nationCells: nations.nationCells,
  };
  const view = withoutPlayers(game, (p) => hidden.has(p.id()));
  const site = siteScore(grid, without, view, me, o, r.tile, takes(game));
  const reach = landReach(game, r.tile, Math.max(site.A, site.B) + 1);
  return capToReach(site, reach, o);
}

/**
 * The erasure sites worth considering, exact-scored, best first: in the
 * order of rankErasures, while a site's bound beats both `floor` and the
 * best exact score so far, at most o.spawnEraseK of them. A site that would
 * leave fewer than o.spawnEraseMinLeft nations is skipped.
 */
export function eraseCandidates(
  grid: RaceGrid,
  arr: ArrivalField,
  game: Game,
  me: Player,
  o: EraseOptions,
  floor: number,
): EraseCandidate[] {
  const out: EraseCandidate[] = [];
  const placed = placedNations(game);
  let best = -Infinity;
  for (const r of rankErasures(grid, arr, game, me, o)) {
    if (out.length >= o.spawnEraseK) break;
    if (r.bound <= Math.max(floor, best)) break;
    if (placed - 1 - r.also.length < o.spawnEraseMinLeft) continue;
    const site = scoreErasure(grid, arr, game, me, o, r);
    out.push({ ...r, site });
    best = Math.max(best, site.score);
  }
  return out.sort((a, b) => b.site.score - a.site.score || a.tile - b.tile);
}
