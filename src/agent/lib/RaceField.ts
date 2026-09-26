import {
  Difficulty,
  Game,
  Player,
  PlayerID,
  PlayerType,
  TerrainType,
} from "../../core/game/Game";
import { GameMap, TileRef } from "../../core/game/GameMap";
import { createModels } from "./Models";
import { planSpawn } from "./SpawnPlanner";

// Coarse grid, arrival fields, spawn candidates, reach and boat targets
// (spec §2.7, used by §3.2 and §3.7). Read-only: every function only calls
// getters on the game it is given.
//
// Units: distances are in tiles weighted by the free-land price of the
// terrain (a plains tile is 1, a mountain tile 1.5), times are in ticks.
// Arrival times come from the spawnGrowth table: a blob that holds G(t) tiles
// at tick t has the radius r(t) = sqrt(G(t)/π); T(d) is its inverse.

/**
 * The options RaceField reads: a subset of ApexOptions, which extends this
 * interface, so lib code never imports the agent. Every key is documented
 * in src/agent/agents/apex/options.ts.
 */
export interface RaceFieldOptions {
  spawnCellTarget: number;
  /** Our expected land at ticks 0, 300, 600, 900, 1200, 1800. */
  spawnGrowth: readonly number[];
  spawnTribeDelayTicks: number;
  spawnMarginTicks: number;
  spawnK0: number;
  spawnBeta: number;
  spawnThreatLambda: number;
  spawnSnackBonus: number;
  spawnIdleTicks: number;
  /** θ = min(2, webTarget) needs webTarget (§3.4.1). */
  allySlotsReserve: number;
  /** Below this land share, spawn tiles near an ocean shore are not
   *  penalised (§3.2.3 step 4). */
  waterMapLand: number;
}

export interface RaceGrid {
  /** cell = max(3, round(sqrt(W·H/spawnCellTarget))). */
  cell: number;
  cw: number;
  ch: number;
  /** Passable land tiles per cell. */
  land: Uint16Array;
  /** Unowned passable land tiles per cell, when the grid was built. */
  free: Uint16Array;
  /** Mean tnPrice / tnPrice(plains) over the cell's land (0 without land). */
  cost: Float32Array;
  /** Ocean shore flag: 1 if a tile of the cell is an ocean shore. */
  shore: Uint8Array;
  /** Landmass id (4-connected land cells, see `links`); −1 without land. */
  comp: Int32Array;
  /** Passable land tiles per landmass id. */
  compLand: Map<number, number>;
  /**
   * Not in spec §2.7. Tile-level connectivity across cell edges: bit
   * LINK_EAST if a passable land tile on the cell's east edge touches one in
   * the cell to the east, LINK_SOUTH likewise to the south. `comp` and every
   * cell search walk these links, so a strait on a cell edge separates two
   * landmasses. (A strait inside one cell cannot be seen at this grain.)
   */
  links: Uint8Array;
}

/** RaceGrid.links bits. */
export const LINK_EAST = 1;
export const LINK_SOUTH = 2;

/** Ticks of the spawnGrowth table (spec §3.2.2). */
export const GROWTH_TICKS: readonly number[] = [0, 300, 600, 900, 1200, 1800];
/** A counts the land we win by our tick 900, B by 1,800 (§3.2.3). */
const A_HORIZON = 900;
const B_HORIZON = 1800;
/** threat counts the nations within r(1200) + 2 cells of a site (§3.2.3). */
const THREAT_TICK = 1200;
const THREAT_EXTRA_CELLS = 2;
/** θ = min(2, webTarget): we ally up to two nations (§3.2.3). */
const THETA_MAX = 2;
/** A tribe's expected size: 650 tiles at 600 ticks (§3.2.2). */
const TRIBE_TILES = 650;
const TRIBE_TICKS = 600;
/** Race candidates are at least this many cells apart (Chebyshev). */
const CANDIDATE_SEPARATION = 3;
/**
 * The spawn disc. getSpawnTiles(gm, t) floods euclDistFN(t, 4, true)
 * (execution/Util.ts:130-159, GameMap.ts:715-735): the root is shifted by
 * −0.5, so (dx + 0.5)² + (dy + 0.5)² ≤ 16 for dx, dy in −4..3, 52 tiles
 * clipped by the map edge. Pinned against getSpawnTiles in RaceField.test.
 */
const DISC_RADIUS = 4;
/** A spawn tile's disc must hold this many free passable tiles (§3.2.3
 *  step 4). */
export const MIN_DISC_FREE = 45;
/** Prefer spawn tiles more than this far (Euclidean) from an ocean shore
 *  (§3.2.3 step 4). */
const SHORE_AVOID = 6;
/** Island candidates when the largest landmass holds less than this share
 *  of the land, for the next ISLANDS landmasses (§3.2.3 step 3). */
const MAINLAND_SHARE = 0.6;
const ISLANDS = 2;
/** Cells of a landmass exact-scored for its island candidate. */
const ISLAND_TRIES = 4;
/** A fresh tribe, one a spawn disc can snack: under 100 tiles (§3.6.1). */
const FRESH_TRIBE_TILES = 100;
/** The snack variant lies 8-9 tiles from the tribe's spawn tile (§3.2.3),
 *  first within 60° of the line toward the best cell, then anywhere. */
const SNACK_MIN = 7.5;
const SNACK_MAX = 9.5;
const SNACK_AIM = 8.5;
const SNACK_CONE_COS = 0.5;
/** Arrival times above this count as equal when breaking proxy ties. */
const ISOLATION_CAP = 1e6;
/** idleArrival: a cell is someone's once half of its samples are
 *  (§3.2.2). */
const IDLE_OWNED = 0.5;
/** Owner of an OwnerGrid sample that is water or impassable. */
export const OWNER_WATER = -1;
/** boatTargets: the smallest free-plus-tribe land (tiles) a landmass needs
 *  to be worth a boat. */
const BOAT_MIN_FOOD = 1;
/** boatTargets: Manhattan distance added to the centroid distance (§3.7). */
const BOAT_DIST_OFFSET = 50;
/** boatTargets: landing searches per target asked for (bounds the cost when
 *  the best samples' shores belong to someone else). */
const BOAT_TRIES_PER_TARGET = 4;

/** The disc offsets (dx, dy), flattened. */
const DISC: Int8Array = (() => {
  const out: number[] = [];
  const r2 = DISC_RADIUS * DISC_RADIUS;
  for (let dy = -DISC_RADIUS; dy <= DISC_RADIUS; dy++) {
    for (let dx = -DISC_RADIUS; dx <= DISC_RADIUS; dx++) {
      const fx = dx + 0.5;
      const fy = dy + 0.5;
      if (fx * fx + fy * fy <= r2) out.push(dx, dy);
    }
  }
  return Int8Array.from(out);
})();

// ── The grid ──────────────────────────────────────────────────────────────

/** One full tile pass. */
export function buildRaceGrid(game: Game, o: RaceFieldOptions): RaceGrid {
  const map = game.map();
  const W = map.width();
  const H = map.height();
  const cell = Math.max(
    3,
    Math.round(Math.sqrt((W * H) / Math.max(1, o.spawnCellTarget))),
  );
  const cw = Math.ceil(W / cell);
  const ch = Math.ceil(H / cell);
  const n = cw * ch;
  const land = new Uint16Array(n);
  const free = new Uint16Array(n);
  const highland = new Uint16Array(n);
  const mountain = new Uint16Array(n);
  const shore = new Uint8Array(n);
  const links = new Uint8Array(n);
  const cellX = new Int32Array(W);
  for (let x = 0; x < W; x++) cellX[x] = Math.floor(x / cell);
  let prevRow = new Uint8Array(W);
  let row = new Uint8Array(W);

  for (let y = 0; y < H; y++) {
    const cy = Math.floor(y / cell);
    const base = cy * cw;
    const topEdge = y > 0 && y % cell === 0;
    const rowRef = map.ref(0, y);
    let prev = 0;
    for (let x = 0; x < W; x++) {
      const t = rowRef + x;
      const tt = map.terrainType(t);
      const pass =
        tt === TerrainType.Plains ||
        tt === TerrainType.Highland ||
        tt === TerrainType.Mountain
          ? 1
          : 0;
      row[x] = pass;
      if (pass === 1) {
        const c = base + cellX[x];
        land[c]++;
        if (tt === TerrainType.Highland) highland[c]++;
        else if (tt === TerrainType.Mountain) mountain[c]++;
        if (!map.hasOwner(t)) free[c]++;
        if (shore[c] === 0 && map.isOceanShore(t)) shore[c] = 1;
        // prev is 0 at x = 0, so c − 1 is the cell to the west.
        if (prev === 1 && x % cell === 0) links[c - 1] |= LINK_EAST;
        if (topEdge && prevRow[x] === 1) links[c - cw] |= LINK_SOUTH;
      }
      prev = pass;
    }
    const swap = prevRow;
    prevRow = row;
    row = swap;
  }

  // cost: the mean free-land price of the cell's land over plains'.
  const models = createModels(game);
  const plainsPrice = models.tnPrice({ plains: 1, highland: 0, mountain: 0 });
  const cost = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    if (land[c] === 0) continue;
    cost[c] =
      models.tnPrice({
        plains: land[c] - highland[c] - mountain[c],
        highland: highland[c],
        mountain: mountain[c],
      }) / plainsPrice;
  }

  // comp: flood fill over the links.
  const comp = new Int32Array(n).fill(-1);
  const compLand = new Map<number, number>();
  const stack = new Int32Array(n);
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (land[s] === 0 || comp[s] !== -1) continue;
    const id = next++;
    let total = 0;
    let top = 0;
    stack[top++] = s;
    comp[s] = id;
    while (top > 0) {
      const c = stack[--top];
      total += land[c];
      const cx = c % cw;
      const push = (d: number) => {
        if (comp[d] === -1) {
          comp[d] = id;
          stack[top++] = d;
        }
      };
      if ((links[c] & LINK_EAST) !== 0) push(c + 1);
      if ((links[c] & LINK_SOUTH) !== 0) push(c + cw);
      if (cx > 0 && (links[c - 1] & LINK_EAST) !== 0) push(c - 1);
      if (c >= cw && (links[c - cw] & LINK_SOUTH) !== 0) push(c - cw);
    }
    compLand.set(id, total);
  }

  return { cell, cw, ch, land, free, cost, shore, comp, compLand, links };
}

/** The cell index of a tile. */
export function cellOf(grid: RaceGrid, game: Game, tile: TileRef): number {
  return (
    Math.floor(game.y(tile) / grid.cell) * grid.cw +
    Math.floor(game.x(tile) / grid.cell)
  );
}

// ── Growth ────────────────────────────────────────────────────────────────

/** G(t): our expected land at tick t, linear between the spawnGrowth points
 *  (GROWTH_TICKS) and past the last one with the last segment's slope. */
export function expectedLand(o: RaceFieldOptions, t: number): number {
  const g = monotoneGrowth(o);
  if (t <= 0) return g[0];
  const last = GROWTH_TICKS.length - 1;
  for (let i = 1; i <= last; i++) {
    if (t <= GROWTH_TICKS[i] || i === last) {
      const t0 = GROWTH_TICKS[i - 1];
      const t1 = GROWTH_TICKS[i];
      return g[i - 1] + ((g[i] - g[i - 1]) * (t - t0)) / (t1 - t0);
    }
  }
  return g[last];
}

/** r(t) = sqrt(G(t)/π), in tiles. */
export function growthRadius(o: RaceFieldOptions, t: number): number {
  return Math.sqrt(expectedLand(o, t) / Math.PI);
}

/** T_us(d): the tick our blob's radius reaches d (the inverse of r); 0
 *  inside the starting disc. Nations use it too (§3.2.2). */
export function arrivalTicks(o: RaceFieldOptions, d: number): number {
  const g = monotoneGrowth(o);
  const area = Math.PI * d * d;
  if (area <= g[0]) return 0;
  const last = GROWTH_TICKS.length - 1;
  for (let i = 1; i <= last; i++) {
    if (area <= g[i] || i === last) {
      const span = g[i] - g[i - 1];
      const t0 = GROWTH_TICKS[i - 1];
      const t1 = GROWTH_TICKS[i];
      if (span <= 0) return t1;
      return t0 + ((area - g[i - 1]) * (t1 - t0)) / span;
    }
  }
  return GROWTH_TICKS[last];
}

/** A tribe's arrival at distance d > 0 from its land: its first-act delay
 *  plus the inverse of r_tribe(t) = sqrt(650·t/600/π) (§3.2.2). */
export function tribeArrivalTicks(o: RaceFieldOptions, d: number): number {
  if (d <= 0) return 0;
  return o.spawnTribeDelayTicks + (Math.PI * d * d * TRIBE_TICKS) / TRIBE_TILES;
}

/** spawnGrowth made non-decreasing (a user override may not be). */
function monotoneGrowth(o: RaceFieldOptions): number[] {
  const out: number[] = [];
  let m = 0;
  for (let i = 0; i < GROWTH_TICKS.length; i++) {
    m = Math.max(m, o.spawnGrowth[i] ?? m);
    out.push(m);
  }
  return out;
}

// ── Cell searches ─────────────────────────────────────────────────────────

/**
 * Dijkstra over the land cells of a grid, 8-connected along `links` (a
 * diagonal step needs one linked L-path), edge weight cell × mean cost of
 * the two cells (× √2 diagonally). Arrays are reused between searches.
 */
class CellSearch {
  readonly dist: Float64Array;
  private readonly mark: Int32Array;
  private stamp = 0;
  private keys: Float64Array;
  private vals: Int32Array;
  private size = 0;

  constructor(private readonly g: RaceGrid) {
    const n = g.cw * g.ch;
    this.dist = new Float64Array(n);
    this.mark = new Int32Array(n);
    this.keys = new Float64Array(Math.max(16, n));
    this.vals = new Int32Array(Math.max(16, n));
  }

  begin(): void {
    this.stamp++;
    this.size = 0;
  }

  get(c: number): number {
    return this.mark[c] === this.stamp ? this.dist[c] : Infinity;
  }

  offer(c: number, d: number): void {
    if (d < this.get(c)) {
      this.dist[c] = d;
      this.mark[c] = this.stamp;
      this.push(d, c);
    }
  }

  /** Settles cells in order of distance up to `bound`. `visit` returns
   *  false to settle a cell without expanding it. */
  run(bound: number, visit: (c: number, d: number) => boolean): void {
    const { cw, ch, links, cost, cell } = this.g;
    const diag = Math.SQRT2 * cell;
    while (this.size > 0) {
      const d = this.keys[0];
      const c = this.vals[0];
      this.pop();
      if (d > this.dist[c]) continue; // stale entry
      if (d > bound) break;
      if (!visit(c, d)) continue;
      const cx = c % cw;
      const cy = (c - cx) / cw;
      const k = cost[c];
      const lc = links[c];
      const hasE = cx + 1 < cw;
      const hasW = cx > 0;
      const hasS = cy + 1 < ch;
      const hasN = cy > 0;
      const e = hasE && (lc & LINK_EAST) !== 0;
      const w = hasW && (links[c - 1] & LINK_EAST) !== 0;
      const s = hasS && (lc & LINK_SOUTH) !== 0;
      const nn = hasN && (links[c - cw] & LINK_SOUTH) !== 0;
      if (e) this.offer(c + 1, d + (cell * (k + cost[c + 1])) / 2);
      if (w) this.offer(c - 1, d + (cell * (k + cost[c - 1])) / 2);
      if (s) this.offer(c + cw, d + (cell * (k + cost[c + cw])) / 2);
      if (nn) this.offer(c - cw, d + (cell * (k + cost[c - cw])) / 2);
      // A diagonal step needs one of its two L-paths linked.
      if (
        (e && (links[c + 1] & LINK_SOUTH) !== 0) ||
        (s && hasE && (links[c + cw] & LINK_EAST) !== 0)
      ) {
        this.offer(c + cw + 1, d + (diag * (k + cost[c + cw + 1])) / 2);
      }
      if (
        (w && (links[c - 1] & LINK_SOUTH) !== 0) ||
        (s && hasW && (links[c + cw - 1] & LINK_EAST) !== 0)
      ) {
        this.offer(c + cw - 1, d + (diag * (k + cost[c + cw - 1])) / 2);
      }
      if (
        (e && hasN && (links[c - cw + 1] & LINK_SOUTH) !== 0) ||
        (nn && (links[c - cw] & LINK_EAST) !== 0)
      ) {
        this.offer(c - cw + 1, d + (diag * (k + cost[c - cw + 1])) / 2);
      }
      if (
        (w && hasN && (links[c - cw - 1] & LINK_SOUTH) !== 0) ||
        (nn && hasW && (links[c - cw - 1] & LINK_EAST) !== 0)
      ) {
        this.offer(c - cw - 1, d + (diag * (k + cost[c - cw - 1])) / 2);
      }
    }
  }

  private push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const v = new Int32Array(this.size * 2);
      v.set(this.vals);
      this.vals = v;
    }
    const keys = this.keys;
    const vals = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] < key || (keys[p] === key && vals[p] <= val)) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  private pop(): void {
    const keys = this.keys;
    const vals = this.vals;
    const n = --this.size;
    if (n === 0) return;
    const key = keys[n];
    const val = vals[n];
    let i = 0;
    for (;;) {
      let m = 2 * i + 1;
      if (m >= n) break;
      if (
        m + 1 < n &&
        (keys[m + 1] < keys[m] ||
          (keys[m + 1] === keys[m] && vals[m + 1] < vals[m]))
      ) {
        m++;
      }
      if (key < keys[m] || (key === keys[m] && val <= vals[m])) break;
      keys[i] = keys[m];
      vals[i] = vals[m];
      i = m;
    }
    keys[i] = key;
    vals[i] = val;
  }
}

// ── Arrival fields ────────────────────────────────────────────────────────

/** Arrival time (ticks) of the others at each cell. */
export interface ArrivalField {
  nation: Float32Array;
  tribe: Float32Array;
  /**
   * Not in spec §2.7: the cells each nation holds, for spawnCandidates'
   * `threat`. staticArrival: its spawn cell; idleArrival: the cells it holds
   * at the last sample.
   */
  nationCells: Map<PlayerID, number[]>;
}

/**
 * Mode `race` (§3.2.2): a multi-source search from every non-tribe player's
 * spawn tile, converted with T_us; and one from every tribe tile, delayed by
 * spawnTribeDelayTicks and converted with the tribe's growth. Call it before
 * we spawn: a player of ours with land would count as a nation. Unreachable
 * cells are Infinity.
 */
export function staticArrival(
  grid: RaceGrid,
  game: Game,
  o: RaceFieldOptions,
): ArrivalField {
  const n = grid.cw * grid.ch;
  const nation = new Float32Array(n).fill(Infinity);
  const tribe = new Float32Array(n).fill(Infinity);
  const nationCells = new Map<PlayerID, number[]>();
  const search = new CellSearch(grid);

  search.begin();
  for (const p of game.players()) {
    if (p.type() === PlayerType.Bot) continue;
    const s = p.spawnTile() ?? firstTile(p);
    if (s === null) continue;
    const c = cellOf(grid, game, s);
    nationCells.set(p.id(), [c]);
    if (grid.land[c] > 0) search.offer(c, 0);
  }
  search.run(Infinity, (c, d) => {
    nation[c] = arrivalTicks(o, d);
    return true;
  });

  search.begin();
  for (const p of game.players()) {
    if (p.type() !== PlayerType.Bot) continue;
    for (const t of p.tiles()) {
      const c = cellOf(grid, game, t);
      if (grid.land[c] > 0) search.offer(c, 0);
    }
  }
  search.run(Infinity, (c, d) => {
    tribe[c] = tribeArrivalTicks(o, d);
    return true;
  });

  return { nation, tribe, nationCells };
}

function firstTile(p: Player): TileRef | null {
  for (const t of p.tiles()) return t;
  return null;
}

/**
 * Mode `idle` (§3.2.2): per cell, the first sample tick at which at least
 * half of its sampled land is held by nations (tribes), else Infinity. Feed
 * it samples from idleSample, including one at tick 0 (Lookahead.idleFuture
 * takes one there). `o` is unused; it is kept for the spec's signature.
 */
export function idleArrival(
  grid: RaceGrid,
  samples: IdleSample[],
  o: RaceFieldOptions,
): ArrivalField {
  const n = grid.cw * grid.ch;
  const nation = new Float32Array(n).fill(Infinity);
  const tribe = new Float32Array(n).fill(Infinity);
  const sorted = [...samples].sort((a, b) => a.tick - b.tick);
  for (const s of sorted) {
    for (let c = 0; c < n; c++) {
      if (nation[c] === Infinity && s.nationOwned[c] >= IDLE_OWNED) {
        nation[c] = s.tick;
      }
      if (tribe[c] === Infinity && s.tribeOwned[c] >= IDLE_OWNED) {
        tribe[c] = s.tick;
      }
    }
  }
  const last = sorted.length > 0 ? sorted[sorted.length - 1] : undefined;
  const nationCells = new Map<PlayerID, number[]>();
  if (last !== undefined) {
    for (const [id, cells] of last.nationCells) nationCells.set(id, [...cells]);
  }
  return { nation, tribe, nationCells };
}

export interface IdleSample {
  tick: number;
  nationOwned: Float32Array;
  tribeOwned: Float32Array;
  nationTroops: Map<PlayerID, number>;
  nationCells: Map<PlayerID, number[]>;
}

/**
 * Not in spec §2.7: one IdleSample of a (forked) game, for
 * Lookahead.idleFuture's callback. Reads 4 tiles per cell (a 2×2 lattice at
 * the cell's quarter points); the owned shares are over the sampled
 * passable land. nationCells lists every cell where a non-tribe player holds
 * a sample; nationTroops every living non-tribe player's troops.
 */
export function idleSample(
  game: Game,
  grid: RaceGrid,
  tick: number,
): IdleSample {
  const map = game.map();
  const { cell, cw, ch } = grid;
  const W = map.width();
  const H = map.height();
  const n = cw * ch;
  const nationOwned = new Float32Array(n);
  const tribeOwned = new Float32Array(n);
  const kind = ownerKinds(game);
  const ids = ownerIds(game);
  const nationCells = new Map<PlayerID, number[]>();
  const lastCell = new Int32Array(kind.length).fill(-1);
  const offs = [Math.floor(cell / 4), Math.floor((3 * cell) / 4)];
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const c = cy * cw + cx;
      if (grid.land[c] === 0) continue;
      let landN = 0;
      let nat = 0;
      let tri = 0;
      for (const oy of offs) {
        const y = cy * cell + oy;
        if (y >= H) continue;
        for (const ox of offs) {
          const x = cx * cell + ox;
          if (x >= W) continue;
          const t = map.ref(x, y);
          if (!map.isLand(t) || map.isImpassable(t)) continue;
          landN++;
          const id = map.ownerID(t);
          if (id === 0 || id >= kind.length) continue;
          if (kind[id] === KIND_BOT) {
            tri++;
          } else if (kind[id] === KIND_NATION) {
            nat++;
            if (lastCell[id] !== c) {
              lastCell[id] = c;
              const pid = ids[id];
              let list = nationCells.get(pid);
              if (list === undefined) {
                list = [];
                nationCells.set(pid, list);
              }
              list.push(c);
            }
          }
        }
      }
      if (landN > 0) {
        nationOwned[c] = nat / landN;
        tribeOwned[c] = tri / landN;
      }
    }
  }
  const nationTroops = new Map<PlayerID, number>();
  for (const p of game.players()) {
    if (p.type() !== PlayerType.Bot) nationTroops.set(p.id(), p.troops());
  }
  return { tick, nationOwned, tribeOwned, nationTroops, nationCells };
}

const KIND_NONE = 0;
const KIND_NATION = 1;
const KIND_BOT = 2;

/** Owner kind by smallID: KIND_BOT for tribes, KIND_NATION for every other
 *  player (nations and humans). */
function ownerKinds(game: Game): Uint8Array {
  let max = 0;
  const players = game.allPlayers();
  for (const p of players) max = Math.max(max, p.smallID());
  const kind = new Uint8Array(max + 1).fill(KIND_NONE);
  for (const p of players) {
    kind[p.smallID()] = p.type() === PlayerType.Bot ? KIND_BOT : KIND_NATION;
  }
  return kind;
}

function ownerIds(game: Game): PlayerID[] {
  const ids: PlayerID[] = [];
  for (const p of game.allPlayers()) ids[p.smallID()] = p.id();
  return ids;
}

// ── Alliance slots (§3.4.1) ───────────────────────────────────────────────

export interface AllySlots {
  /** A_max: the most alliances we can hold. */
  max: number;
  /** A_ext = A_max − 1: the most at which extensions still pass (C5). */
  ext: number;
  /** max(0, A_ext − reserve). */
  webTarget: number;
}

/**
 * Not in spec §2.7: the alliance slots of §3.4.1, which spawnCandidates
 * needs for θ. A nation refuses us once our alliances reach share·N, N the
 * living non-tribe players (NationAllianceBehavior.hasTooManyAlliances,
 * :180-199: 0.25 at Impossible, 0.5 at Hard, no cap below). We count
 * ourselves in N before we spawn.
 */
export function allySlots(game: Game, me: Player, reserve: number): AllySlots {
  let n = 0;
  for (const p of game.players()) if (p.type() !== PlayerType.Bot) n++;
  if (!me.isAlive()) n++;
  const difficulty = game.config().gameConfig().difficulty;
  const share =
    difficulty === Difficulty.Impossible
      ? 0.25
      : difficulty === Difficulty.Hard
        ? 0.5
        : null;
  const max = share === null ? Math.max(0, n - 1) : Math.ceil(share * n);
  const ext = Math.max(0, max - 1);
  return { max, ext, webTarget: Math.max(0, ext - reserve) };
}

// ── Spawn candidates ──────────────────────────────────────────────────────

export interface SpawnCandidate {
  tile: TileRef;
  cell: number;
  /** Ours, A. */
  free: number;
  /** B. */
  pie: number;
  threat: number;
  snack: boolean;
  source: "race" | "planSpawn" | "island" | "snack";
  score: number;
}

/** What raceScore returns. */
export interface RaceScore {
  /** Land (tiles) we win before anyone, by our tick 900. */
  A: number;
  /** Land we win before any nation, by our tick 1,800. */
  B: number;
  /** With `withRegion`: per cell, 0 lost or out of reach, 1 won before
   *  every nation (counts in B), 2 also before every tribe by tick 900
   *  (counts in A too). */
  region: Uint8Array | null;
}

/**
 * Not in spec §2.7 (exported for tests and the SpawnController): the exact
 * score of a site at `cell` (§3.2.3 step 2). A search from the cell up to
 * our tick 1,800 gives t_c(x) = T_us(dist); it expands only through cells we
 * reach spawnMarginTicks before every nation (land behind a nation is not
 * ours), counts them in B, and in A those also reached before every tribe by
 * our tick 900.
 */
export function raceScore(
  grid: RaceGrid,
  arr: ArrivalField,
  cell: number,
  o: RaceFieldOptions,
  withRegion = false,
): RaceScore {
  return scoreCell(grid, arr, cell, o, withRegion, new CellSearch(grid));
}

function scoreCell(
  grid: RaceGrid,
  arr: ArrivalField,
  cell: number,
  o: RaceFieldOptions,
  withRegion: boolean,
  s: CellSearch,
): RaceScore {
  const m = o.spawnMarginTicks;
  const region = withRegion ? new Uint8Array(grid.cw * grid.ch) : null;
  let A = 0;
  let B = 0;
  s.begin();
  if (grid.land[cell] > 0) s.offer(cell, 0);
  s.run(growthRadius(o, B_HORIZON), (x, d) => {
    const t = arrivalTicks(o, d);
    if (!(t + m < arr.nation[x])) return false;
    B += grid.land[x];
    let won = 1;
    if (t <= A_HORIZON && t + m < arr.tribe[x]) {
      A += grid.land[x];
      won = 2;
    }
    if (region !== null) region[x] = won;
    return true;
  });
  return { A, B, region };
}

/** Sorted by score, descending (ties: lowest tile). */
export function spawnCandidates(
  grid: RaceGrid,
  arr: ArrivalField,
  game: Game,
  me: Player,
  o: RaceFieldOptions,
): SpawnCandidate[] {
  const ctx = new CandidateContext(grid, arr, game, me, o);
  const n = grid.cw * grid.ch;
  const half = (grid.cell * grid.cell) / 2;

  // Step 1: the proxy for every roomy cell.
  const proxy = new Float64Array(n);
  const roomy: number[] = [];
  for (let c = 0; c < n; c++) {
    if (grid.free[c] < half) continue;
    proxy[c] = ctx.proxy(c);
    roomy.push(c);
  }
  const iso = new Float64Array(n);
  for (const c of roomy) iso[c] = ctx.isolation(c);
  roomy.sort((a, b) => proxy[b] - proxy[a] || iso[b] - iso[a] || a - b);

  // Step 2: the best spawnK0 roomy cells, CANDIDATE_SEPARATION apart, that
  // hold a spawn tile, exact-scored.
  const out = new Map<TileRef, SpawnCandidate>();
  const blocked = new Uint8Array(n);
  const sep = CANDIDATE_SEPARATION - 1;
  let picked = 0;
  for (const c of roomy) {
    if (picked >= o.spawnK0) break;
    if (blocked[c] === 1) continue;
    const tile = ctx.tileForCell(c);
    if (tile === null) continue;
    // The tile may lie in a neighbouring cell; keep that one apart too.
    const tc = cellOf(grid, game, tile);
    if (blocked[tc] === 1) continue;
    out.set(tile, ctx.evaluate(tile, "race"));
    picked++;
    for (const b of [c, tc]) {
      const cx = b % grid.cw;
      const cy = (b - cx) / grid.cw;
      const y1 = Math.min(grid.ch - 1, cy + sep);
      const x1 = Math.min(grid.cw - 1, cx + sep);
      for (let y = Math.max(0, cy - sep); y <= y1; y++) {
        for (let x = Math.max(0, cx - sep); x <= x1; x++) {
          blocked[y * grid.cw + x] = 1;
        }
      }
    }
  }

  // Step 3: the extra candidates. Each keeps its source even when a race
  // candidate already has its tile (the later source wins).
  const add = (cand: SpawnCandidate | null) => {
    if (cand === null) return;
    const had = out.get(cand.tile);
    if (had === undefined) out.set(cand.tile, cand);
    else had.source = cand.source;
  };
  let best: SpawnCandidate | null = null;
  for (const c of out.values()) {
    if (best === null || better(c, best)) best = c;
  }
  if (best !== null) add(ctx.snackVariant(best.tile));
  for (const cand of ctx.islandCandidates(proxy)) add(cand);
  add(ctx.planSpawnCandidate());

  return [...out.values()].sort((a, b) => b.score - a.score || a.tile - b.tile);
}

/** Summed-area table of a per-cell count, (cw + 1) × (ch + 1). */
function integral(grid: RaceGrid, v: Uint16Array): Float64Array {
  const { cw, ch } = grid;
  const w = cw + 1;
  const sum = new Float64Array(w * (ch + 1));
  for (let y = 0; y < ch; y++) {
    let row = 0;
    for (let x = 0; x < cw; x++) {
      row += v[y * cw + x];
      sum[(y + 1) * w + x + 1] = sum[y * w + x + 1] + row;
    }
  }
  return sum;
}

/** a > b in lexicographic order. */
function lexGreater(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function better(a: SpawnCandidate, b: SpawnCandidate): boolean {
  return a.score > b.score || (a.score === b.score && a.tile < b.tile);
}

/** The per-call state of spawnCandidates. */
class CandidateContext {
  private readonly map: GameMap;
  private readonly W: number;
  private readonly H: number;
  private readonly search: CellSearch;
  /** 1 for a smallID that is a fresh tribe (snackable). */
  private readonly freshTribe: Uint8Array;
  private readonly waterMap: boolean;
  private readonly theta: number;
  private readonly threatR2: number;
  /** Proxy windows (half-widths in cells) and their integral images. */
  private readonly hA: number;
  private readonly hB: number;
  private readonly freeSum: Float64Array;
  private readonly landSum: Float64Array;

  constructor(
    private readonly grid: RaceGrid,
    private readonly arr: ArrivalField,
    private readonly game: Game,
    private readonly me: Player,
    private readonly o: RaceFieldOptions,
  ) {
    this.map = game.map();
    this.W = this.map.width();
    this.H = this.map.height();
    this.search = new CellSearch(grid);
    let max = 0;
    for (const p of game.allPlayers()) max = Math.max(max, p.smallID());
    this.freshTribe = new Uint8Array(max + 1);
    for (const p of game.players()) {
      if (
        p.type() === PlayerType.Bot &&
        p.numTilesOwned() < FRESH_TRIBE_TILES
      ) {
        this.freshTribe[p.smallID()] = 1;
      }
    }
    let land = 0;
    for (const v of grid.compLand.values()) land += v;
    this.waterMap = land < o.waterMapLand * this.W * this.H;
    this.theta = Math.min(
      THETA_MAX,
      allySlots(game, me, o.allySlotsReserve).webTarget,
    );
    const r = growthRadius(o, THREAT_TICK) / grid.cell + THREAT_EXTRA_CELLS;
    this.threatR2 = r * r;
    this.hA = Math.max(1, Math.round(growthRadius(o, A_HORIZON) / grid.cell));
    this.hB = Math.max(1, Math.round(growthRadius(o, B_HORIZON) / grid.cell));
    this.freeSum = integral(grid, grid.free);
    this.landSum = integral(grid, grid.land);
  }

  /**
   * §3.2.3 step 1, weighted by land: ρ_A·min(t_O, 900)² + β·ρ_B·min(t_N,
   * 1800)², ρ_A the free-land and ρ_B the land share of the square of
   * half-width r(900) (r(1800)) around the cell. The spec's unweighted
   * formula saturates on large maps: every cell no one reaches by 900 ties,
   * and the ties went to the map's top rows (GiantWorldMap: the best race
   * candidate scored a third of planSpawn's site).
   */
  proxy(c: number): number {
    const tN = this.arr.nation[c];
    const tO = Math.min(tN, this.arr.tribe[c]);
    const a = Math.min(tO, A_HORIZON);
    const b = Math.min(tN, B_HORIZON);
    return (
      this.freeShare(c, this.hA) * a * a +
      this.o.spawnBeta * this.landShare(c, this.hB) * b * b
    );
  }

  /** Breaks proxy ties: the later the others arrive, the better. */
  isolation(c: number): number {
    const tN = Math.min(this.arr.nation[c], ISOLATION_CAP);
    return Math.min(tN, this.arr.tribe[c]) + tN;
  }

  private freeShare(c: number, h: number): number {
    return this.share(this.freeSum, c, h);
  }

  private landShare(c: number, h: number): number {
    return this.share(this.landSum, c, h);
  }

  /** The window's sum over its area in tiles (cells past the map count as
   *  empty). */
  private share(sum: Float64Array, c: number, h: number): number {
    const { cw, ch, cell } = this.grid;
    const cx = c % cw;
    const cy = (c - cx) / cw;
    const x0 = Math.max(0, cx - h);
    const y0 = Math.max(0, cy - h);
    const x1 = Math.min(cw, cx + h + 1);
    const y1 = Math.min(ch, cy + h + 1);
    const w = cw + 1;
    const total =
      sum[y1 * w + x1] - sum[y0 * w + x1] - sum[y1 * w + x0] + sum[y0 * w + x0];
    const side = 2 * h + 1;
    return total / (side * side * cell * cell);
  }

  /** Scores the site `tile` (step 2). */
  evaluate(tile: TileRef, source: SpawnCandidate["source"]): SpawnCandidate {
    const { grid, o } = this;
    const cell = cellOf(grid, this.game, tile);
    const { A, B } = scoreCell(grid, this.arr, cell, o, false, this.search);
    const threat = this.threat(cell);
    const snack = this.snack(tile);
    const score =
      (A + o.spawnBeta * B) *
        Math.exp(-o.spawnThreatLambda * Math.max(0, threat - this.theta)) +
      (snack ? o.spawnSnackBonus : 0);
    return { tile, cell, free: A, pie: B, threat, snack, source, score };
  }

  /** Nations with a cell within r(1200) + 2 cells of `cell`. */
  private threat(cell: number): number {
    const { cw } = this.grid;
    const cx = cell % cw;
    const cy = (cell - cx) / cw;
    let count = 0;
    for (const cells of this.arr.nationCells.values()) {
      for (const c of cells) {
        const x = c % cw;
        const dx = x - cx;
        const dy = (c - x) / cw - cy;
        if (dx * dx + dy * dy <= this.threatR2) {
          count++;
          break;
        }
      }
    }
    return count;
  }

  /** Step 4 for a cell: the best spawn tile in the cell, else within one
   *  cell of its centre. */
  tileForCell(c: number): TileRef | null {
    const { cell, cw } = this.grid;
    const cx = c % cw;
    const cy = (c - cx) / cw;
    const x0 = cx * cell;
    const y0 = cy * cell;
    const mx = Math.min(this.W - 1, x0 + Math.floor(cell / 2));
    const my = Math.min(this.H - 1, y0 + Math.floor(cell / 2));
    return (
      this.bestTile(x0, y0, x0 + cell - 1, y0 + cell - 1, mx, my) ??
      this.bestTile(
        x0 - cell,
        y0 - cell,
        x0 + 2 * cell - 1,
        y0 + 2 * cell - 1,
        mx,
        my,
      )
    );
  }

  /**
   * Step 4: in the rectangle, the free passable tile whose disc holds the
   * most free passable tiles (at least MIN_DISC_FREE); among equals one more
   * than SHORE_AVOID from an ocean shore (unless a water map), then the one
   * nearest (mx, my), then the lowest tile.
   */
  private bestTile(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    mx: number,
    my: number,
  ): TileRef | null {
    const map = this.map;
    const xa = Math.max(0, x0);
    const ya = Math.max(0, y0);
    const xb = Math.min(this.W - 1, x1);
    const yb = Math.min(this.H - 1, y1);
    let bestDisc = MIN_DISC_FREE;
    const tied: TileRef[] = [];
    for (let y = ya; y <= yb; y++) {
      const rowRef = map.ref(0, y);
      for (let x = xa; x <= xb; x++) {
        const t = rowRef + x;
        if (!this.freeLand(t)) continue;
        const disc = this.discFree(x, y);
        if (disc < bestDisc) continue;
        if (disc > bestDisc) {
          bestDisc = disc;
          tied.length = 0;
        }
        tied.push(t);
      }
    }
    let best: TileRef | null = null;
    let bestFar = false;
    let bestD2 = Infinity;
    for (const t of tied) {
      const x = map.x(t);
      const y = map.y(t);
      const far = this.waterMap || this.farFromShore(x, y);
      const d2 = (x - mx) * (x - mx) + (y - my) * (y - my);
      if (
        best === null ||
        (far && !bestFar) ||
        (far === bestFar && (d2 < bestD2 || (d2 === bestD2 && t < best)))
      ) {
        best = t;
        bestFar = far;
        bestD2 = d2;
      }
    }
    return best;
  }

  private freeLand(t: TileRef): boolean {
    const map = this.map;
    return map.isLand(t) && !map.isImpassable(t) && !map.hasOwner(t);
  }

  /** Free passable tiles of the spawn disc around (x, y). */
  discFree(x: number, y: number): number {
    let n = 0;
    for (let i = 0; i < DISC.length; i += 2) {
      const nx = x + DISC[i];
      const ny = y + DISC[i + 1];
      if (nx < 0 || ny < 0 || nx >= this.W || ny >= this.H) continue;
      if (this.freeLand(this.map.ref(nx, ny))) n++;
    }
    return n;
  }

  /** No ocean-shore tile within SHORE_AVOID (Euclidean) of (x, y). */
  private farFromShore(x: number, y: number): boolean {
    const { cell, cw, ch, shore } = this.grid;
    const r = SHORE_AVOID;
    let any = false;
    const cxa = Math.max(0, Math.floor((x - r) / cell));
    const cxb = Math.min(cw - 1, Math.floor((x + r) / cell));
    const cya = Math.max(0, Math.floor((y - r) / cell));
    const cyb = Math.min(ch - 1, Math.floor((y + r) / cell));
    for (let cy = cya; cy <= cyb && !any; cy++) {
      for (let cx = cxa; cx <= cxb; cx++) {
        if (shore[cy * cw + cx] === 1) {
          any = true;
          break;
        }
      }
    }
    if (!any) return true;
    for (let dy = -r; dy <= r; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= this.H) continue;
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= this.W || dx * dx + dy * dy > r * r) continue;
        if (this.map.isOceanShore(this.map.ref(nx, ny))) return false;
      }
    }
    return true;
  }

  /** The disc around `tile` touches a fresh tribe: a free tile of it has a
   *  4-neighbour the tribe owns (§3.6.1: it falls to one attack). */
  snack(tile: TileRef): boolean {
    const map = this.map;
    const x = map.x(tile);
    const y = map.y(tile);
    for (let i = 0; i < DISC.length; i += 2) {
      const nx = x + DISC[i];
      const ny = y + DISC[i + 1];
      if (nx < 0 || ny < 0 || nx >= this.W || ny >= this.H) continue;
      const t = map.ref(nx, ny);
      if (!this.freeLand(t)) continue;
      for (const [ax, ay] of [
        [nx - 1, ny],
        [nx + 1, ny],
        [nx, ny - 1],
        [nx, ny + 1],
      ]) {
        if (ax < 0 || ay < 0 || ax >= this.W || ay >= this.H) continue;
        const id = map.ownerID(map.ref(ax, ay));
        if (id < this.freshTribe.length && this.freshTribe[id] === 1) {
          return true;
        }
      }
    }
    return false;
  }

  /** Step 3: the spawnable tile 8-9 tiles from the tribe spawn nearest the
   *  best site, toward it, whose disc touches a fresh tribe. */
  snackVariant(bestTile: TileRef): SpawnCandidate | null {
    const map = this.map;
    const bx = map.x(bestTile);
    const by = map.y(bestTile);
    let src: TileRef | null = null;
    let srcD2 = Infinity;
    let srcID = Infinity;
    for (const p of this.game.players()) {
      if (p.type() !== PlayerType.Bot || this.freshTribe[p.smallID()] !== 1) {
        continue;
      }
      const s = p.spawnTile();
      if (s === undefined) continue;
      const dx = map.x(s) - bx;
      const dy = map.y(s) - by;
      const d2 = dx * dx + dy * dy;
      if (d2 < srcD2 || (d2 === srcD2 && p.smallID() < srcID)) {
        src = s;
        srcD2 = d2;
        srcID = p.smallID();
      }
    }
    if (src === null) return null;
    const sx = map.x(src);
    const sy = map.y(src);
    const len = Math.sqrt(srcD2);
    const ux = len > 0 ? (bx - sx) / len : 1;
    const uy = len > 0 ? (by - sy) / len : 0;
    for (const minCos of [SNACK_CONE_COS, -1]) {
      let best: TileRef | null = null;
      let bestKey: [number, number, number, number] | null = null;
      const r = Math.ceil(SNACK_MAX);
      for (let dy = -r; dy <= r; dy++) {
        const y = sy + dy;
        if (y < 0 || y >= this.H) continue;
        for (let dx = -r; dx <= r; dx++) {
          const x = sx + dx;
          if (x < 0 || x >= this.W) continue;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < SNACK_MIN || d > SNACK_MAX) continue;
          const cos = (dx * ux + dy * uy) / d;
          if (cos < minCos) continue;
          const t = map.ref(x, y);
          if (!this.freeLand(t)) continue;
          const disc = this.discFree(x, y);
          if (disc < MIN_DISC_FREE || !this.snack(t)) continue;
          // Most free disc, then closest to the aim line, then to 8.5
          // tiles, then the lowest tile.
          const key: [number, number, number, number] = [
            disc,
            cos,
            -Math.abs(d - SNACK_AIM),
            -t,
          ];
          if (bestKey === null || lexGreater(key, bestKey)) {
            best = t;
            bestKey = key;
          }
        }
      }
      if (best !== null) return this.evaluate(best, "snack");
    }
    return null;
  }

  /** Step 3: if the largest landmass holds < 60% of the land, the best site
   *  of each of the next two landmasses. */
  islandCandidates(proxy: Float64Array): SpawnCandidate[] {
    const { grid } = this;
    const comps = [...grid.compLand.entries()].sort(
      (a, b) => b[1] - a[1] || a[0] - b[0],
    );
    let total = 0;
    for (const [, v] of comps) total += v;
    if (comps.length < 2 || comps[0][1] >= MAINLAND_SHARE * total) return [];
    const out: SpawnCandidate[] = [];
    const n = grid.cw * grid.ch;
    const half = (grid.cell * grid.cell) / 2;
    for (const [id] of comps.slice(1, 1 + ISLANDS)) {
      const roomy: number[] = [];
      const any: number[] = [];
      for (let c = 0; c < n; c++) {
        if (grid.comp[c] !== id || grid.free[c] === 0) continue;
        if (grid.free[c] >= half) roomy.push(c);
        else any.push(c);
      }
      const cells = roomy.length > 0 ? roomy : any;
      const key = (c: number) => (proxy[c] > 0 ? proxy[c] : this.proxy(c));
      cells.sort((a, b) => key(b) - key(a) || a - b);
      let best: SpawnCandidate | null = null;
      let tried = 0;
      for (const c of cells) {
        if (tried >= ISLAND_TRIES) break;
        const tile = this.tileForCell(c);
        if (tile === null) continue;
        tried++;
        const cand = this.evaluate(tile, "island");
        if (best === null || better(cand, best)) best = cand;
      }
      if (best !== null) out.push(best);
    }
    return out;
  }

  /** Step 3: planSpawn's tile, as is when its disc holds MIN_DISC_FREE free
   *  tiles, else the best spawn tile within one cell of it. */
  planSpawnCandidate(): SpawnCandidate | null {
    const t0 = planSpawn(this.game, this.me);
    if (t0 === null) return null;
    const x = this.map.x(t0);
    const y = this.map.y(t0);
    const r = this.grid.cell;
    const tile =
      this.freeLand(t0) && this.discFree(x, y) >= MIN_DISC_FREE
        ? t0
        : this.bestTile(x - r, y - r, x + r, y + r, x, y);
    return tile === null ? null : this.evaluate(tile, "planSpawn");
  }
}

/** Free passable tiles of the spawn disc around `tile` (what our spawn would
 *  take, getSpawnTiles(game, tile, false).length). */
export function spawnDiscFree(game: Game, tile: TileRef): number {
  const map = game.map();
  const W = map.width();
  const H = map.height();
  const x = map.x(tile);
  const y = map.y(tile);
  let n = 0;
  for (let i = 0; i < DISC.length; i += 2) {
    const nx = x + DISC[i];
    const ny = y + DISC[i + 1];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const t = map.ref(nx, ny);
    if (map.isLand(t) && !map.isImpassable(t) && !map.hasOwner(t)) n++;
  }
  return n;
}

// ── OwnerGrid, reach and boat targets ─────────────────────────────────────

/** Every 100 ticks: coarse owner grid for reach and boat targets. */
export interface OwnerGrid {
  /**
   * One sample per stride × stride block, at the block's middle tile
   * (clipped to the map): the owner's smallID, 0 for unowned passable land,
   * OWNER_WATER (−1) for water or impassable. A player that no sample hits
   * gets the block of its spawn tile, if it still owns that tile, so every
   * player with land near its spawn is on the grid.
   */
  owner: Int32Array;
  stamp: number;
  /** Not in spec §2.7: the sampling lattice. */
  stride: number;
  ow: number;
  oh: number;
}

/** The sample tile of an OwnerGrid block. */
export function ownerSampleTile(
  og: OwnerGrid,
  game: Game,
  block: number,
): TileRef {
  const bx = block % og.ow;
  const by = (block - bx) / og.ow;
  const half = Math.floor(og.stride / 2);
  return game.ref(
    Math.min(game.width() - 1, bx * og.stride + half),
    Math.min(game.height() - 1, by * og.stride + half),
  );
}

export function ownerGrid(
  game: Game,
  grid: RaceGrid,
  stride: number,
): OwnerGrid {
  const map = game.map();
  const W = map.width();
  const H = map.height();
  const s = Math.max(1, Math.floor(stride));
  const ow = Math.ceil(W / s);
  const oh = Math.ceil(H / s);
  const owner = new Int32Array(ow * oh);
  const half = Math.floor(s / 2);
  let maxID = 0;
  for (let by = 0; by < oh; by++) {
    const rowRef = map.ref(0, Math.min(H - 1, by * s + half));
    for (let bx = 0; bx < ow; bx++) {
      const t = rowRef + Math.min(W - 1, bx * s + half);
      if (!map.isLand(t) || map.isImpassable(t)) {
        owner[by * ow + bx] = OWNER_WATER;
      } else {
        const id = map.ownerID(t);
        owner[by * ow + bx] = id;
        if (id > maxID) maxID = id;
      }
    }
  }
  const players = game.players();
  for (const p of players) maxID = Math.max(maxID, p.smallID());
  const seen = new Uint8Array(maxID + 1);
  for (let i = 0; i < owner.length; i++) if (owner[i] > 0) seen[owner[i]] = 1;
  for (const p of players) {
    if (seen[p.smallID()] === 1) continue;
    const t = p.spawnTile();
    if (t === undefined || map.ownerID(t) !== p.smallID()) continue;
    const bx = Math.floor(map.x(t) / s);
    const by = Math.floor(map.y(t) / s);
    owner[by * ow + bx] = p.smallID();
  }
  return { owner, stamp: game.ticks(), stride: s, ow, oh };
}

/**
 * smallID -> cell distance: every owner within maxCells race-grid cells of
 * the samples `fromSmallID` holds, at its nearest sample. The distance is a
 * 3-4 chamfer transform over every sample, water included (boats cross it),
 * converted to race-grid cells (× stride / cell) and rounded. Empty when no
 * sample is `fromSmallID`'s.
 */
export function reachCells(
  og: OwnerGrid,
  grid: RaceGrid,
  fromSmallID: number,
  maxCells: number,
): Map<number, number> {
  const { ow, oh, owner } = og;
  const n = ow * oh;
  const INF = 0x3fffffff;
  const dt = new Int32Array(n).fill(INF);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (owner[i] === fromSmallID) {
      dt[i] = 0;
      any = true;
    }
  }
  const out = new Map<number, number>();
  if (!any) return out;
  // Forward pass: W, NW, N, NE.
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const i = y * ow + x;
      let d = dt[i];
      if (x > 0) d = Math.min(d, dt[i - 1] + 3);
      if (y > 0) {
        d = Math.min(d, dt[i - ow] + 3);
        if (x > 0) d = Math.min(d, dt[i - ow - 1] + 4);
        if (x + 1 < ow) d = Math.min(d, dt[i - ow + 1] + 4);
      }
      dt[i] = d;
    }
  }
  // Backward pass: E, SE, S, SW.
  for (let y = oh - 1; y >= 0; y--) {
    for (let x = ow - 1; x >= 0; x--) {
      const i = y * ow + x;
      let d = dt[i];
      if (x + 1 < ow) d = Math.min(d, dt[i + 1] + 3);
      if (y + 1 < oh) {
        d = Math.min(d, dt[i + ow] + 3);
        if (x + 1 < ow) d = Math.min(d, dt[i + ow + 1] + 4);
        if (x > 0) d = Math.min(d, dt[i + ow - 1] + 4);
      }
      dt[i] = d;
    }
  }
  const scale = og.stride / 3 / grid.cell;
  for (let i = 0; i < n; i++) {
    const id = owner[i];
    if (id <= 0 || id === fromSmallID) continue;
    const d = dt[i] * scale;
    if (d > maxCells) continue;
    const had = out.get(id);
    if (had === undefined || d < had) out.set(id, d);
  }
  for (const [id, d] of out) out.set(id, Math.round(d));
  return out;
}

export interface BoatTarget {
  tile: TileRef;
  comp: number;
  food: number;
  tn: boolean;
  tribeSmallID: number | null;
  score: number;
  /** The estimated voyage in tiles (with a VoyageField), else the Manhattan
   *  distance from our centroid. */
  dist: number;
  /** Past the voyage limit, let in by a FarReach (then `food` is the
   *  landmass's projected food at the landing). */
  far: boolean;
}

/**
 * Not in spec §2.7 (o.boatsMidgame): targets past `voyage.max`, up to
 * `max` tiles, when their landmass will still hold food when the boat lands
 * and no nation's land is close enough to reach the landing first.
 */
export interface FarReach {
  /** Longest estimated voyage, tiles. */
  max: number;
  /** Free plus tribe tiles landmass `comp` is projected to keep `ticks`
   *  from now (the caller's trend); asked for the voyage plus `hold`. */
  foodAt: (comp: number, ticks: number) => number;
  /** Smallest projected food for a far target. */
  minFood: number;
  /** nationLandDistance of the OwnerGrid (per sample), or null. */
  nationDist: Int32Array | null;
  /** Tiles a nation's front advances per tick: a far target needs its
   *  sample at least front·(voyage + hold) tiles (by land) from every
   *  nation. */
  front: number;
  /** Ticks past the voyage the landing must stay clear of nations and its
   *  landmass keep minFood. */
  hold: number;
}

/**
 * Not in spec §2.7 (o.boatsMidgame): per OwnerGrid sample, the land
 * distance in tiles to the nearest sample a Nation owns (`me` excluded):
 * a 4-connected BFS over land samples, water samples being walls, stride
 * tiles a step. −1 where no nation's land reaches (a landmass without a
 * nation). Nations take tribes and free land by land, so this bounds how
 * soon one can reach a landing. O(samples).
 */
export function nationLandDistance(
  game: Game,
  og: OwnerGrid,
  me: Player,
): Int32Array {
  const kind = ownerKinds(game);
  const mine = me.smallID();
  const { owner, ow, oh, stride } = og;
  const n = owner.length;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const id = owner[i];
    if (id <= 0 || id === mine || id >= kind.length) continue;
    if (kind[id] !== KIND_NATION) continue;
    dist[i] = 0;
    queue[tail++] = i;
  }
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const d = dist[i] + stride;
    const x = i % ow;
    const y = (i - x) / ow;
    // Inlined 4-neighbours (W, E, N, S).
    if (x > 0) {
      const e = i - 1;
      if (dist[e] < 0 && owner[e] !== OWNER_WATER) {
        dist[e] = d;
        queue[tail++] = e;
      }
    }
    if (x + 1 < ow) {
      const e = i + 1;
      if (dist[e] < 0 && owner[e] !== OWNER_WATER) {
        dist[e] = d;
        queue[tail++] = e;
      }
    }
    if (y > 0) {
      const e = i - ow;
      if (dist[e] < 0 && owner[e] !== OWNER_WATER) {
        dist[e] = d;
        queue[tail++] = e;
      }
    }
    if (y + 1 < oh) {
      const e = i + ow;
      if (dist[e] < 0 && owner[e] !== OWNER_WATER) {
        dist[e] = d;
        queue[tail++] = e;
      }
    }
  }
  return dist;
}

/**
 * Not in spec §2.7: estimated sea distances over the race grid. `dist[c]` is
 * the tiles a boat sails from our shore to cell c: a BFS over the cells
 * holding water (a cell with fewer passable land tiles than tiles),
 * 4-connected, cell tiles per step, from the cells of `sources` (and their
 * water neighbours). −1 where the BFS does not reach. A cell of land only is
 * reached through its nearest water neighbour (voyageAt).
 */
export interface VoyageField {
  dist: Int32Array;
  cell: number;
}

export function voyageField(
  game: Game,
  grid: RaceGrid,
  sources: readonly TileRef[],
): VoyageField {
  const { cw, ch, cell } = grid;
  const n = cw * ch;
  const W = game.width();
  const H = game.height();
  // Water: fewer passable land tiles than tiles (edge cells are cut).
  const full = cell * cell;
  const lastW = W - (cw - 1) * cell;
  const lastH = H - (ch - 1) * cell;
  const water = new Uint8Array(n);
  for (let cy = 0; cy < ch; cy++) {
    const h = cy === ch - 1 ? lastH : cell;
    const row = cy * cw;
    for (let cx = 0; cx < cw; cx++) {
      const area = cx === cw - 1 ? lastW * h : h === cell ? full : cell * h;
      if (grid.land[row + cx] < area) water[row + cx] = 1;
    }
  }
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let tail = 0;
  for (const t of sources) {
    const c = cellOf(grid, game, t);
    if (c < 0 || c >= n) continue;
    const cx = c % cw;
    // The source cell and its water neighbours.
    const seeds = [c];
    if (cx > 0 && water[c - 1] === 1) seeds.push(c - 1);
    if (cx + 1 < cw && water[c + 1] === 1) seeds.push(c + 1);
    if (c >= cw && water[c - cw] === 1) seeds.push(c - cw);
    if (c + cw < n && water[c + cw] === 1) seeds.push(c + cw);
    for (const e of seeds) {
      if (dist[e] >= 0) continue;
      dist[e] = 0;
      queue[tail++] = e;
    }
  }
  // 4-connected BFS, inlined (a closure per cell cost ~50 ms on 142k).
  for (let head = 0; head < tail; head++) {
    const c = queue[head];
    const d = dist[c] + cell;
    const cx = c % cw;
    let e = c - 1;
    if (cx > 0 && water[e] === 1 && dist[e] < 0) {
      dist[e] = d;
      queue[tail++] = e;
    }
    e = c + 1;
    if (cx + 1 < cw && water[e] === 1 && dist[e] < 0) {
      dist[e] = d;
      queue[tail++] = e;
    }
    e = c - cw;
    if (e >= 0 && water[e] === 1 && dist[e] < 0) {
      dist[e] = d;
      queue[tail++] = e;
    }
    e = c + cw;
    if (e < n && water[e] === 1 && dist[e] < 0) {
      dist[e] = d;
      queue[tail++] = e;
    }
  }
  return { dist, cell };
}

/** Sea tiles to cell c: its own distance, else one step past its nearest
 *  reached neighbour (a land cell on the shore); −1 if none. */
export function voyageAt(f: VoyageField, grid: RaceGrid, c: number): number {
  if (f.dist[c] >= 0) return f.dist[c];
  const { cw } = grid;
  const n = f.dist.length;
  const cx = c % cw;
  let best = -1;
  const take = (e: number) => {
    const d = f.dist[e];
    if (d >= 0 && (best < 0 || d < best)) best = d;
  };
  if (cx > 0) take(c - 1);
  if (cx + 1 < cw) take(c + 1);
  if (c >= cw) take(c - cw);
  if (c + cw < n) take(c + cw);
  return best < 0 ? -1 : best + f.cell;
}

/**
 * §3.7: landing tiles on unowned land and tribes. Candidates are the
 * OwnerGrid samples on unowned land or a tribe whose race cell has an ocean
 * shore; each is moved to the nearest ocean-shore tile of the same owner
 * within one stride that no tile of ours touches (a boat lands on the
 * target's shore, TransportShipUtils.targetTransportTile). Scored by
 * food(comp) / (Manhattan distance from our centroid + 50), food being the
 * free plus tribe land of the landmass, estimated from the samples (×
 * stride²). Best first, one per landing tile, at most `max` (from at most
 * 4·max landing searches); empty while we hold no sample. Whether a boat
 * can reach a target is for the caller's canBuild probes.
 *
 * With `voyage` (not in the spec): the distance is the sample cell's
 * estimated voyage (voyageAt) instead, and a sample the field does not
 * reach, or farther than `voyage.max` tiles, is no candidate. With
 * `voyage.far` (o.boatsMidgame), a sample past `voyage.max` but within
 * `far.max` is one when its landmass's food projected to far.hold ticks
 * after the landing (far.foodAt) is at least far.minFood and no nation's
 * land lies within far.front·(voyage + far.hold) tiles of it
 * (far.nationDist); it is scored by that projected food.
 */
export function boatTargets(
  game: Game,
  grid: RaceGrid,
  og: OwnerGrid,
  me: Player,
  max: number,
  voyage?: { field: VoyageField; max: number; far?: FarReach },
): BoatTarget[] {
  if (max <= 0) return [];
  const map = game.map();
  const W = map.width();
  const H = map.height();
  const kind = ownerKinds(game);
  const mine = me.smallID();
  const { owner, ow, oh, stride } = og;
  const { cell, cw } = grid;
  const half = Math.floor(stride / 2);
  const n = owner.length;
  const sampleX = (bx: number) => Math.min(W - 1, bx * stride + half);
  const sampleY = (by: number) => Math.min(H - 1, by * stride + half);

  // Food per landmass and our centroid, from the samples.
  const food = new Map<number, number>();
  const comps = new Int32Array(n).fill(-1);
  let sx = 0;
  let sy = 0;
  let ours = 0;
  for (let by = 0; by < oh; by++) {
    const y = sampleY(by);
    const rowCell = Math.floor(y / cell) * cw;
    for (let bx = 0; bx < ow; bx++) {
      const i = by * ow + bx;
      const id = owner[i];
      if (id === OWNER_WATER) continue;
      const x = sampleX(bx);
      if (id === mine) {
        sx += x;
        sy += y;
        ours++;
        continue;
      }
      if (id !== 0 && (id >= kind.length || kind[id] !== KIND_BOT)) continue;
      const c = rowCell + Math.floor(x / cell);
      const comp = grid.comp[c];
      if (comp < 0 || grid.shore[c] !== 1) {
        if (comp >= 0) food.set(comp, (food.get(comp) ?? 0) + stride * stride);
        continue;
      }
      comps[i] = comp;
      food.set(comp, (food.get(comp) ?? 0) + stride * stride);
    }
  }
  if (ours === 0) return [];
  const mx = sx / ours;
  const my = sy / ours;

  // The best K candidates (samples on a shore cell), by a bounded min-heap.
  const K = BOAT_TRIES_PER_TARGET * max;
  const heapScore = new Float64Array(K);
  const heapBlock = new Int32Array(K);
  const heapDist = new Float64Array(K);
  // A far candidate's projected food (−1: a near one, scored by food).
  const heapFood = new Float64Array(K);
  let size = 0;
  // Min-heap order: lower score first, then higher block (worse).
  const worse = (a: number, b: number) =>
    heapScore[a] < heapScore[b] ||
    (heapScore[a] === heapScore[b] && heapBlock[a] > heapBlock[b]);
  const swap = (a: number, b: number) => {
    const s0 = heapScore[a];
    heapScore[a] = heapScore[b];
    heapScore[b] = s0;
    const b0 = heapBlock[a];
    heapBlock[a] = heapBlock[b];
    heapBlock[b] = b0;
    const d0 = heapDist[a];
    heapDist[a] = heapDist[b];
    heapDist[b] = d0;
    const f0 = heapFood[a];
    heapFood[a] = heapFood[b];
    heapFood[b] = f0;
  };
  const down = (i: number) => {
    for (;;) {
      const l = 2 * i + 1;
      if (l >= size) return;
      let m = l;
      if (l + 1 < size && worse(l + 1, l)) m = l + 1;
      if (!worse(m, i)) return;
      swap(i, m);
      i = m;
    }
  };
  for (let i = 0; i < n; i++) {
    const comp = comps[i];
    if (comp < 0) continue;
    let f = food.get(comp) ?? 0;
    if (f < BOAT_MIN_FOOD) continue;
    const bx = i % ow;
    const by = (i - bx) / ow;
    let dist: number;
    let projected = -1;
    if (voyage !== undefined) {
      const c =
        Math.floor(sampleY(by) / cell) * cw + Math.floor(sampleX(bx) / cell);
      dist = voyageAt(voyage.field, grid, c);
      if (dist < 0) continue;
      if (dist > voyage.max) {
        const far = voyage.far;
        if (far === undefined || dist > far.max) continue;
        const nd = far.nationDist === null ? -1 : far.nationDist[i];
        if (nd >= 0 && nd < far.front * (dist + far.hold)) continue;
        projected = far.foodAt(comp, dist + far.hold);
        if (!(projected >= far.minFood)) continue;
        f = projected;
      }
    } else {
      dist = Math.abs(sampleX(bx) - mx) + Math.abs(sampleY(by) - my);
    }
    const score = f / (dist + BOAT_DIST_OFFSET);
    if (size < K) {
      heapScore[size] = score;
      heapBlock[size] = i;
      heapDist[size] = dist;
      heapFood[size] = projected;
      let j = size++;
      while (j > 0) {
        const p = (j - 1) >> 1;
        if (!worse(j, p)) break;
        swap(j, p);
        j = p;
      }
    } else if (
      score > heapScore[0] ||
      (score === heapScore[0] && i < heapBlock[0])
    ) {
      heapScore[0] = score;
      heapBlock[0] = i;
      heapDist[0] = dist;
      heapFood[0] = projected;
      down(0);
    }
  }
  const order = Array.from({ length: size }, (_, j) => j).sort(
    (a, b) => heapScore[b] - heapScore[a] || heapBlock[a] - heapBlock[b],
  );

  const out: BoatTarget[] = [];
  const used = new Set<TileRef>();
  for (const j of order) {
    if (out.length >= max) break;
    const block = heapBlock[j];
    const id = owner[block];
    const bx = block % ow;
    const by = (block - bx) / ow;
    const landing = shoreNear(map, sampleX(bx), sampleY(by), id, mine, stride);
    if (landing === null || used.has(landing)) continue;
    used.add(landing);
    const comp = comps[block];
    const far = heapFood[j] >= 0;
    out.push({
      tile: landing,
      comp,
      food: far ? heapFood[j] : (food.get(comp) ?? 0),
      tn: id === 0,
      tribeSmallID: id === 0 ? null : id,
      score: heapScore[j],
      dist: heapDist[j],
      far,
    });
  }
  return out;
}

/** The ocean-shore tile owned by `id` (0 = unowned) nearest (x, y) within
 *  `r` (Chebyshev window, Manhattan distance), not touching a tile of
 *  `mine`; ties: lowest tile. */
function shoreNear(
  map: GameMap,
  x: number,
  y: number,
  id: number,
  mine: number,
  r: number,
): TileRef | null {
  const W = map.width();
  const H = map.height();
  let best: TileRef | null = null;
  let bestD = Infinity;
  for (let ny = Math.max(0, y - r); ny <= Math.min(H - 1, y + r); ny++) {
    const rowRef = map.ref(0, ny);
    for (let nx = Math.max(0, x - r); nx <= Math.min(W - 1, x + r); nx++) {
      const u = rowRef + nx;
      if (map.ownerID(u) !== id || !map.isOceanShore(u)) continue;
      const d = Math.abs(nx - x) + Math.abs(ny - y);
      if (d > bestD || (d === bestD && best !== null && u > best)) continue;
      let touches = false;
      map.forEachNeighbor(u, (v) => {
        if (map.ownerID(v) === mine) touches = true;
      });
      if (touches) continue;
      best = u;
      bestD = d;
    }
  }
  return best;
}
