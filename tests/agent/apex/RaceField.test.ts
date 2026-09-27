import path from "path";
import { APEX_DEFAULTS } from "../../../src/agent/agents/apex/options";
import {
  ArenaGameSpec,
  arenaGameStart,
  seatClientID,
} from "../../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../../src/agent/arena/NodeMapLoader";
import {
  allySlots,
  arrivalTicks,
  boatTargets,
  buildRaceGrid,
  cellOf,
  expectedLand,
  GROWTH_TICKS,
  growthRadius,
  idleArrival,
  idleSample,
  MIN_DISC_FREE,
  OWNER_WATER,
  ownerGrid,
  ownerSampleTile,
  RaceFieldOptions,
  RaceGrid,
  raceScore,
  reachCells,
  spawnCandidates,
  spawnDiscFree,
  staticArrival,
  tribeArrivalTicks,
} from "../../../src/agent/lib/RaceField";
import { planSpawn } from "../../../src/agent/lib/SpawnPlanner";
import { Config } from "../../../src/core/configuration/Config";
import { getSpawnTiles } from "../../../src/core/execution/Util";
import {
  Cell,
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Nation,
  Player,
  PlayerInfo,
  PlayerType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl, TileRef } from "../../../src/core/game/GameMap";
import { UserSettings } from "../../../src/core/game/UserSettings";
import { createGameRunner } from "../../../src/core/GameRunner";
import { GameConfig } from "../../../src/core/Schemas";
import { snapshotGame } from "../../../src/core/snapshot/GameSnapshot";
import { diffSnapshots } from "../../util/Snapshot";

// RaceField (spec §2.7, §3.2.1-3.2.3; build step 4). Synthetic maps are
// built in memory as the mechanics pins build them (NationSendCap.test.ts):
// the real Config at Impossible, players placed by conquering tiles, no
// executions. Real maps come from resources/maps, built as the arena builds
// them (arenaGameStart → createGameRunner, the map's nations, 400 tribes)
// and stepped to tick 3, where the SpawnController decides: tribes landed in
// tick 1 and nations in tick 2 (SpawnPhaseSingleplayer pin).

const MAPS = path.join(__dirname, "../../../resources/maps");
const ME = seatClientID(0);
const TIMEOUT = 120_000;

// ── Synthetic games ─────────────────────────────────────────────────────

/** Terrain bytes (GameMapImpl): land bit 0x80 plus a magnitude; ocean 0x20;
 *  shoreline 0x40, as NationSendCap.test.ts writes them. */
const PLAINS = 0x80 | 5;
const HIGHLAND = 0x80 | 15;
const MOUNTAIN = 0x80 | 25;
const OCEAN = 0x20;
const SHORELINE = 0x40;

type Terrain = "plains" | "highland" | "mountain" | "water";

const GAME_CONFIG: GameConfig = {
  gameMap: GameMapType.Asia,
  gameMapSize: GameMapSize.Normal,
  gameMode: GameMode.FFA,
  gameType: GameType.Singleplayer,
  difficulty: Difficulty.Impossible,
  nations: "default",
  donateGold: false,
  donateTroops: false,
  bots: 400,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: false,
};

interface Synth {
  game: Game;
  me: Player;
  nations: Player[];
  tribes: Player[];
}

function withShoreline(t: Uint8Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const land = (t[y * w + x] & 0x80) !== 0;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (((t[ny * w + nx] & 0x80) !== 0) !== land) {
          t[y * w + x] |= SHORELINE;
          break;
        }
      }
    }
  }
}

function bytes(
  w: number,
  h: number,
  at: (x: number, y: number) => Terrain,
): { t: Uint8Array; land: number } {
  const t = new Uint8Array(w * h);
  let land = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = at(x, y);
      t[y * w + x] =
        k === "water"
          ? OCEAN
          : k === "plains"
            ? PLAINS
            : k === "highland"
              ? HIGHLAND
              : MOUNTAIN;
      if (k !== "water") land++;
    }
  }
  withShoreline(t, w, h);
  return { t, land };
}

/** A synthetic game: our unspawned human, `nations` nations and `tribes`
 *  tribes, none placed yet. */
function synth(
  w: number,
  h: number,
  at: (x: number, y: number) => Terrain,
  nations = 0,
  tribes = 0,
): Synth {
  const main = bytes(w, h, at);
  const mw = Math.ceil(w / 2);
  const mh = Math.ceil(h / 2);
  const mini = bytes(mw, mh, (x, y) => at(2 * x, 2 * y));
  const config = new Config(GAME_CONFIG, new UserSettings(), false);
  const nationList = Array.from(
    { length: nations },
    (_, i) =>
      new Nation(
        new Cell(0, 0),
        new PlayerInfo(`nation${i}`, PlayerType.Nation, null, `NATION0${i}`),
      ),
  );
  const game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, ME, "AGENTID1")],
    nationList,
    new GameMapImpl(w, h, main.t, main.land),
    new GameMapImpl(mw, mh, mini.t, mini.land),
    config,
  );
  const tribeList: Player[] = [];
  for (let i = 0; i < tribes; i++) {
    tribeList.push(
      game.addPlayer(
        new PlayerInfo(`tribe${i}`, PlayerType.Bot, null, `TRIBE00${i}`),
      ),
    );
  }
  return {
    game,
    me: game.player("AGENTID1"),
    nations: nationList.map((n) => game.player(n.playerInfo.id)),
    tribes: tribeList,
  };
}

/** Places a player as SpawnExecution does: its disc's free land, and the
 *  spawn tile. */
function place(game: Game, p: Player, x: number, y: number): void {
  const t = game.ref(x, y);
  for (const u of getSpawnTiles(game, t, false)) p.conquer(u);
  p.setSpawnTile(t);
}

const allPlains = (): Terrain => "plains";

/** Octile distance in tiles between two cells of a uniform-cost grid. */
function octile(grid: RaceGrid, a: number, b: number): number {
  const dx = Math.abs((a % grid.cw) - (b % grid.cw));
  const dy = Math.abs(Math.floor(a / grid.cw) - Math.floor(b / grid.cw));
  return (
    grid.cell *
    (Math.max(dx, dy) - Math.min(dx, dy) + Math.SQRT2 * Math.min(dx, dy))
  );
}

/** The options with a cell size of 4 on a w×h map. */
function opts(w: number, h: number, over: Partial<RaceFieldOptions> = {}) {
  return { ...APEX_DEFAULTS, spawnCellTarget: (w * h) / 16, ...over };
}

// ── Real maps at the spawn decision ─────────────────────────────────────

interface SpawnGame {
  game: Game;
  me: Player;
}

const spawnGames = new Map<GameMapType, Promise<SpawnGame>>();

/** The arena's game on `map` at tick 3, before our spawn. */
function spawnGame(map: GameMapType): Promise<SpawnGame> {
  let p = spawnGames.get(map);
  if (p === undefined) {
    p = (async () => {
      const spec = {
        gameID: "RACEFLD1",
        map,
        mapSize: GameMapSize.Normal,
        gameType: GameType.Singleplayer,
        difficulty: Difficulty.Impossible,
        nations: "default",
        bots: 400,
        seats: [{ agent: "apex" }],
      } as unknown as ArenaGameSpec;
      const runner = await createGameRunner(
        arenaGameStart(spec),
        undefined,
        new NodeMapLoader(MAPS),
        () => {},
      );
      for (let turn = 0; turn < APEX_DEFAULTS.spawnDelay; turn++) {
        runner.addTurn({ turnNumber: turn, intents: [] });
        if (!runner.executeNextTick()) throw new Error(`turn ${turn} failed`);
      }
      const game = runner.game;
      return { game, me: game.playerByClientID(ME)! };
    })();
    spawnGames.set(map, p);
  }
  return p;
}

beforeAll(() => {
  console.debug = () => {};
  console.warn = () => {};
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("RaceField grid", () => {
  test("cell size, land, free and cost per cell; cost is the free-land price over plains'", () => {
    // Columns of plains, highland and mountain, 8 tiles wide; one tile of
    // water in the top-left cell; one owned tile.
    const w = 24;
    const h = 24;
    const { game, nations } = synth(
      w,
      h,
      (x, y) =>
        x === 0 && y === 0
          ? "water"
          : x < 8
            ? "plains"
            : x < 16
              ? "highland"
              : "mountain",
      1,
    );
    nations[0].conquer(game.ref(5, 5));
    const grid = buildRaceGrid(game, opts(w, h));
    expect(grid.cell).toBe(4);
    expect([grid.cw, grid.ch]).toEqual([6, 6]);
    expect(grid.land[0]).toBe(15);
    expect(grid.free[0]).toBe(15);
    expect(grid.land[1 * 6 + 1]).toBe(16);
    expect(grid.free[1 * 6 + 1]).toBe(15);
    // Real Config: 16/20/24 troops per tile (FreeLandCost pin).
    expect(grid.cost[0]).toBeCloseTo(1, 6);
    expect(grid.cost[2]).toBeCloseTo(20 / 16, 6);
    expect(grid.cost[5]).toBeCloseTo(24 / 16, 6);
    expect(grid.shore[0]).toBe(1);
    expect(grid.shore[7]).toBe(0);
    // The cell target: max(3, round(sqrt(W·H/target))).
    expect(buildRaceGrid(game, opts(w, h, { spawnCellTarget: 1e9 })).cell).toBe(
      3,
    );
  });

  test("comp labels islands, and a one-tile strait on a cell edge separates two", () => {
    // 120×64: island I1 x 4..43; I2 x 52..91; I3 x 93..115, with the strait
    // x = 92 on the edge of cells 22 (88..91) and 23 (92..95). y 8..55.
    const w = 120;
    const h = 64;
    const island = (x: number) =>
      x >= 4 && x <= 43
        ? 1
        : x >= 52 && x <= 91
          ? 2
          : x >= 93 && x <= 115
            ? 3
            : 0;
    const { game } = synth(w, h, (x, y) =>
      y >= 8 && y <= 55 && island(x) > 0 ? "plains" : "water",
    );
    const grid = buildRaceGrid(game, opts(w, h));
    expect(grid.cell).toBe(4);
    const idOf = new Map<number, Set<number>>();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = island(x);
        if (k === 0 || y < 8 || y > 55) continue;
        const c = cellOf(grid, game, game.ref(x, y));
        const set = idOf.get(k) ?? new Set();
        set.add(grid.comp[c]);
        idOf.set(k, set);
      }
    }
    const ids = [1, 2, 3].map((k) => [...idOf.get(k)!]);
    for (const list of ids) expect(list).toHaveLength(1);
    expect(new Set(ids.map((l) => l[0])).size).toBe(3);
    expect(grid.compLand.get(ids[0][0])).toBe(40 * 48);
    expect(grid.compLand.get(ids[1][0])).toBe(40 * 48);
    expect(grid.compLand.get(ids[2][0])).toBe(23 * 48);
    expect(grid.compLand.size).toBe(3);
    // Water cells have no landmass.
    expect(grid.comp[cellOf(grid, game, game.ref(47, 30))]).toBe(-1);
  });

  test(
    "the spawn disc count equals getSpawnTiles' on a real map, edges and coasts included",
    async () => {
      const { game } = await spawnGame(GameMapType.World);
      let seed = 12345;
      const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
      const tiles: TileRef[] = [
        game.ref(0, 0),
        game.ref(game.width() - 1, game.height() - 1),
        game.ref(3, 500),
      ];
      for (let i = 0; i < 3000; i++) {
        tiles.push(game.ref(next() % game.width(), next() % game.height()));
      }
      for (const p of game.players()) tiles.push(p.spawnTile()!);
      for (const t of tiles) {
        expect(spawnDiscFree(game, t)).toBe(
          getSpawnTiles(game, t, false).length,
        );
      }
    },
    TIMEOUT,
  );
});

describe("arrival times", () => {
  test("T_us inverts r(t) at the table points; tribes grow to 650 tiles at 600 ticks", () => {
    const o = APEX_DEFAULTS;
    for (let i = 0; i < GROWTH_TICKS.length; i++) {
      expect(expectedLand(o, GROWTH_TICKS[i])).toBe(o.spawnGrowth[i]);
      if (i > 0) {
        expect(arrivalTicks(o, growthRadius(o, GROWTH_TICKS[i]))).toBeCloseTo(
          GROWTH_TICKS[i],
          6,
        );
      }
    }
    // Between points: linear in land; past the last one: its slope.
    expect(expectedLand(o, 150)).toBeCloseTo((52 + 3000) / 2, 6);
    expect(expectedLand(o, 2400)).toBeCloseTo(90_000 + 50_000, 6);
    expect(arrivalTicks(o, 2)).toBe(0);
    const r600 = Math.sqrt(650 / Math.PI);
    expect(tribeArrivalTicks(o, r600)).toBeCloseTo(
      o.spawnTribeDelayTicks + 600,
      6,
    );
    expect(tribeArrivalTicks(o, 0)).toBe(0);
  });

  test("on a synthetic two-nation field our region is the Voronoi half by arrival time", () => {
    // 200×200 plains, cell 4. Us at (150, 100), one nation at (50, 100):
    // with no margin, we win every cell nearer to us than to it (the octile
    // metric of an 8-connected grid), which is the right half exactly.
    const w = 200;
    const h = 200;
    const { game, nations } = synth(w, h, allPlains, 1);
    place(game, nations[0], 50, 100);
    const o = opts(w, h, { spawnMarginTicks: 0 });
    const grid = buildRaceGrid(game, o);
    const arr = staticArrival(grid, game, o);
    const us = cellOf(grid, game, game.ref(150, 100));
    const them = cellOf(grid, game, nations[0].spawnTile()!);
    // The nation field is T_us of the octile distance.
    for (let c = 0; c < grid.cw * grid.ch; c++) {
      expect(arr.nation[c]).toBeCloseTo(
        arrivalTicks(o, octile(grid, c, them)),
        2,
      );
      expect(arr.tribe[c]).toBe(Infinity);
    }
    const { A, B, region } = raceScore(grid, arr, us, o, true);
    let won = 0;
    for (let c = 0; c < grid.cw * grid.ch; c++) {
      const right = c % grid.cw >= grid.cw / 2;
      expect(region![c] > 0).toBe(right);
      if (region![c] > 0) won++;
    }
    expect(won).toBe((grid.cw * grid.ch) / 2);
    // B: all of it (every cell is within r(1800) = 169 tiles of us); A: the
    // part we reach by tick 900 (r(900) = 84 tiles).
    expect(B).toBe(won * 16);
    let a = 0;
    for (let c = 0; c < grid.cw * grid.ch; c++) {
      if (region![c] > 0 && arrivalTicks(o, octile(grid, us, c)) <= 900)
        a += 16;
    }
    expect(A).toBe(a);
    expect(A).toBeGreaterThan(0);
    expect(A).toBeLessThan(B);
  });

  test("with two nations, a margin and a tribe: the region is our octile Voronoi cell; A leaves the tribe's side to it", () => {
    const w = 200;
    const h = 200;
    const { game, nations, tribes } = synth(w, h, allPlains, 2, 1);
    place(game, nations[0], 50, 50);
    place(game, nations[1], 150, 150);
    place(game, tribes[0], 170, 40);
    const o = opts(w, h, { spawnMarginTicks: 60 });
    const grid = buildRaceGrid(game, o);
    const arr = staticArrival(grid, game, o);
    const us = cellOf(grid, game, game.ref(150, 50));
    const srcs = nations.map((n) => cellOf(grid, game, n.spawnTile()!));
    const { A, B, region } = raceScore(grid, arr, us, o, true);
    const bound = growthRadius(o, 1800);
    let checked = 0;
    let b = 0;
    let tribeSide = 0;
    for (let c = 0; c < grid.cw * grid.ch; c++) {
      const dUs = octile(grid, us, c);
      const dThem = Math.min(...srcs.map((s) => octile(grid, s, c)));
      const tUs = arrivalTicks(o, dUs);
      const tThem = arrivalTicks(o, dThem);
      // Skip cells within float noise of a boundary.
      if (Math.abs(tUs + o.spawnMarginTicks - tThem) < 1e-3) continue;
      if (Math.abs(dUs - bound) < 1e-6) continue;
      checked++;
      const expected = dUs <= bound && tUs + o.spawnMarginTicks < tThem;
      expect(region![c] > 0).toBe(expected);
      if (expected) b += grid.land[c];
      if (region![c] === 1 && arr.tribe[c] <= tUs + o.spawnMarginTicks) {
        tribeSide++;
      }
    }
    expect(checked).toBeGreaterThan(2400);
    expect(B).toBe(b);
    // The margin shrinks the region below the plain Voronoi half-diagonal.
    expect(B).toBeLessThan((grid.cw * grid.ch * 16) / 2);
    // Cells the tribe reaches first count in B but not in A.
    expect(tribeSide).toBeGreaterThan(0);
    const tribeCell = cellOf(grid, game, tribes[0].spawnTile()!);
    expect(region![tribeCell]).toBe(1);
    expect(A).toBeLessThan(B);
  });

  test("idleArrival: the first sample with half the cell held; nationCells from the last sample", () => {
    const w = 64;
    const h = 64;
    const { game, nations, tribes } = synth(w, h, allPlains, 1, 1);
    const own = (p: Player, x0: number, x1: number) => {
      for (let y = 0; y < h; y++) {
        for (let x = x0; x <= x1; x++) p.conquer(game.ref(x, y));
      }
    };
    own(nations[0], 0, 15);
    own(tribes[0], 48, 63);
    const o = opts(w, h);
    const grid = buildRaceGrid(game, o);
    const s0 = idleSample(game, grid, 0);
    // Samples at x = 4cx + 1 and 4cx + 3: owning x ≤ 17 holds half of cell 4.
    own(nations[0], 16, 17);
    const s150 = idleSample(game, grid, 150);
    own(nations[0], 18, 23);
    const s300 = idleSample(game, grid, 300);
    const arr = idleArrival(grid, [s300, s0, s150], o);
    for (let c = 0; c < grid.cw * grid.ch; c++) {
      const cx = c % grid.cw;
      expect(arr.nation[c]).toBe(
        cx < 4 ? 0 : cx === 4 ? 150 : cx === 5 ? 300 : Infinity,
      );
      expect(arr.tribe[c]).toBe(cx >= 12 ? 0 : Infinity);
    }
    const cells = arr.nationCells.get(nations[0].id())!;
    expect(new Set(cells.map((c) => c % grid.cw))).toEqual(
      new Set([0, 1, 2, 3, 4, 5]),
    );
    expect(cells).toHaveLength(6 * grid.ch);
    expect(s300.nationTroops.get(nations[0].id())).toBe(nations[0].troops());
    expect(s300.nationTroops.has(tribes[0].id())).toBe(false);
  });
});

describe("spawn candidates", () => {
  test.each([
    GameMapType.Pangaea,
    GameMapType.World,
    GameMapType.ArchipelagoSea,
  ])(
    "%s: every candidate has a disc of >= 45 free tiles, planSpawn's tile is one, and islands are",
    async (map) => {
      const { game, me } = await spawnGame(map);
      expect(game.inSpawnPhase()).toBe(true);
      expect(me.hasSpawned()).toBe(false);
      const before = snapshotGame(game, { gameID: "RACEFLD1" });
      const o = APEX_DEFAULTS;
      const grid = buildRaceGrid(game, o);
      const arr = staticArrival(grid, game, o);
      const cands = spawnCandidates(grid, arr, game, me, o);
      // Read-only: everything RaceField exports leaves the game as it was.
      const og = ownerGrid(game, grid, 7);
      const nation = game
        .players()
        .find((p) => p.type() === PlayerType.Nation)!;
      reachCells(og, grid, nation.smallID(), 40);
      boatTargets(game, grid, og, nation, 8);
      idleSample(game, grid, 0);
      allySlots(game, me, 0);
      expect(
        diffSnapshots(snapshotGame(game, { gameID: "RACEFLD1" }), before),
      ).toEqual([]);
      expect(cands.length).toBeGreaterThan(o.spawnK0 / 2);
      expect(new Set(cands.map((c) => c.tile)).size).toBe(cands.length);
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        expect(
          getSpawnTiles(game, c.tile, false).length,
        ).toBeGreaterThanOrEqual(MIN_DISC_FREE);
        expect(game.isLand(c.tile) && !game.hasOwner(c.tile)).toBe(true);
        expect(c.cell).toBe(cellOf(grid, game, c.tile));
        if (i > 0) expect(c.score).toBeLessThanOrEqual(cands[i - 1].score);
        if (c.source === "snack") expect(c.snack).toBe(true);
      }
      // planSpawn's tile is always a candidate (moved to a >= 45 disc
      // nearby when its own disc is smaller).
      const ps = planSpawn(game, me)!;
      const mine = cands.filter((c) => c.source === "planSpawn");
      expect(mine).toHaveLength(1);
      if (spawnDiscFree(game, ps) >= MIN_DISC_FREE) {
        expect(mine[0].tile).toBe(ps);
      } else {
        expect(game.manhattanDist(mine[0].tile, ps)).toBeLessThanOrEqual(
          2 * grid.cell,
        );
      }
      // Race candidates keep 3 cells apart.
      const race = cands.filter((c) => c.source === "race");
      for (const a of race) {
        for (const b of race) {
          if (a === b) continue;
          const dx = Math.abs((a.cell % grid.cw) - (b.cell % grid.cw));
          const dy = Math.abs(
            Math.floor(a.cell / grid.cw) - Math.floor(b.cell / grid.cw),
          );
          expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(3);
        }
      }
      // Islands: when the largest landmass holds < 60% of the land, the
      // next two landmasses each get a candidate.
      const comps = [...grid.compLand.entries()].sort((a, b) => b[1] - a[1]);
      const total = comps.reduce((s, [, v]) => s + v, 0);
      const islands = cands.filter((c) => c.source === "island");
      if (comps[0][1] < 0.6 * total) {
        expect(islands.length).toBeGreaterThanOrEqual(1);
        for (const c of islands) {
          expect(grid.comp[c.cell]).not.toBe(comps[0][0]);
        }
      } else {
        expect(islands).toHaveLength(0);
      }
      console.log(
        `${map}: cell ${grid.cell}, ${cands.length} candidates, best ` +
          `${cands[0].source} A ${cands[0].free} B ${cands[0].pie} threat ` +
          `${cands[0].threat}; planSpawn's scores ${mine[0].score.toFixed(0)} ` +
          `vs ${cands[0].score.toFixed(0)}; islands ${islands.length}`,
      );
    },
    TIMEOUT,
  );

  test(
    "GiantWorldMap: grid, static arrival and candidates in under 5 s (under 1 s on an idle machine)",
    async () => {
      const { game, me } = await spawnGame(GameMapType.GiantWorldMap);
      const o = APEX_DEFAULTS;
      let best = Infinity;
      let parts = "";
      for (let run = 0; run < 2; run++) {
        const t0 = performance.now();
        const grid = buildRaceGrid(game, o);
        const t1 = performance.now();
        const arr = staticArrival(grid, game, o);
        const t2 = performance.now();
        const cands = spawnCandidates(grid, arr, game, me, o);
        const t3 = performance.now();
        expect(cands.length).toBeGreaterThan(0);
        if (t3 - t0 < best) {
          best = t3 - t0;
          parts =
            `grid ${(t1 - t0).toFixed(0)} ms, arrival ${(t2 - t1).toFixed(0)} ` +
            `ms, candidates ${(t3 - t2).toFixed(0)} ms (cell ${grid.cell}, ` +
            `${grid.cw}×${grid.ch})`;
        }
      }
      console.log(
        `GiantWorldMap spawn search: ${best.toFixed(0)} ms: ${parts}`,
      );
      // Wall time, on a machine the suite may share with arena runs (3.1 s
      // at load 17 on 4 cores): the bound only catches a regression by
      // several times. The time is logged above.
      expect(best).toBeLessThan(5000);
    },
    TIMEOUT,
  );

  test(
    "GiantWorldMap: OwnerGrid, reach and boat targets fit the 100-tick cadence",
    async () => {
      // At the spawn tick, for the largest nation: the policy's stride
      // √(W·H/40,000) (§3.0) and the diplomacy reach ceil(150/cell).
      const { game } = await spawnGame(GameMapType.GiantWorldMap);
      const grid = buildRaceGrid(game, APEX_DEFAULTS);
      const stride = Math.round(
        Math.sqrt((game.width() * game.height()) / 40_000),
      );
      const nation = game
        .players()
        .filter((p) => p.type() === PlayerType.Nation)
        .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())[0];
      // Best of 10: the first runs measure the JIT, not the code.
      let best = { og: Infinity, reach: Infinity, boats: Infinity };
      for (let run = 0; run < 10; run++) {
        const t0 = performance.now();
        const og = ownerGrid(game, grid, stride);
        const t1 = performance.now();
        const reach = reachCells(
          og,
          grid,
          nation.smallID(),
          Math.ceil(150 / grid.cell),
        );
        const t2 = performance.now();
        const boats = boatTargets(game, grid, og, nation, 16);
        const t3 = performance.now();
        expect(reach.size).toBeGreaterThan(0);
        expect(boats.length).toBeGreaterThan(0);
        best = {
          og: Math.min(best.og, t1 - t0),
          reach: Math.min(best.reach, t2 - t1),
          boats: Math.min(best.boats, t3 - t2),
        };
      }
      console.log(
        `GiantWorldMap stride ${stride}: ownerGrid ${best.og.toFixed(2)} ms, ` +
          `reachCells ${best.reach.toFixed(2)} ms, boatTargets ` +
          `${best.boats.toFixed(2)} ms`,
      );
      expect(best.og + best.reach + best.boats).toBeLessThan(20);
    },
    TIMEOUT,
  );

  test("threat above θ discounts a site; a snack site gets the bonus", () => {
    // 200×200 plains: 3 nations around one site; θ = min(2, webTarget) = 0
    // here (4 players: A_max 1, A_ext 0).
    const w = 200;
    const h = 200;
    const { game, me, nations, tribes } = synth(w, h, allPlains, 3, 1);
    place(game, nations[0], 20, 20);
    place(game, nations[1], 180, 20);
    place(game, nations[2], 20, 180);
    place(game, tribes[0], 150, 150);
    expect(allySlots(game, me, 0)).toEqual({ max: 1, ext: 0, webTarget: 0 });
    const o = opts(w, h);
    const grid = buildRaceGrid(game, o);
    const arr = staticArrival(grid, game, o);
    const cands = spawnCandidates(grid, arr, game, me, o);
    for (const c of cands) {
      const s = raceScore(grid, arr, c.cell, o);
      expect([c.free, c.pie]).toEqual([s.A, s.B]);
      const want =
        (s.A + o.spawnBeta * s.B) *
          Math.exp(-o.spawnThreatLambda * Math.max(0, c.threat - 0)) +
        (c.snack ? o.spawnSnackBonus : 0);
      expect(c.score).toBeCloseTo(want, 6);
    }
    const snack = cands.find((c) => c.source === "snack")!;
    expect(snack.snack).toBe(true);
    const d = Math.sqrt(
      game.euclideanDistSquared(snack.tile, tribes[0].spawnTile()!),
    );
    expect(d).toBeGreaterThanOrEqual(7.5);
    expect(d).toBeLessThanOrEqual(9.5);
  });
});

describe("OwnerGrid, reach and boat targets", () => {
  // 96×96: island A x 0..59, water x 60..67, island B x 68..95. We hold a
  // disc on A at (10, 48); a nation holds A's x 40..59, A's whole shore; a
  // tribe holds B's x 68..95 for y < 48. The rest is free.
  function scene() {
    const w = 96;
    const h = 96;
    const s = synth(
      w,
      h,
      (x) => (x >= 60 && x <= 67 ? "water" : "plains"),
      1,
      1,
    );
    const { game, me, nations, tribes } = s;
    place(game, me, 10, 48);
    for (let y = 0; y < h; y++) {
      for (let x = 40; x <= 59; x++) nations[0].conquer(game.ref(x, y));
      if (y < 48) {
        for (let x = 68; x <= 95; x++) tribes[0].conquer(game.ref(x, y));
      }
    }
    nations[0].setSpawnTile(game.ref(50, 48));
    tribes[0].setSpawnTile(game.ref(88, 24));
    const grid = buildRaceGrid(game, opts(w, h));
    return { ...s, grid, w, h };
  }

  test("ownerGrid samples the middle of each block; reach is the chamfer distance in cells", () => {
    const { game, me, nations, tribes, grid, w } = scene();
    const og = ownerGrid(game, grid, 4);
    expect([og.stride, og.ow, og.oh, og.stamp]).toEqual([
      4,
      24,
      24,
      game.ticks(),
    ]);
    for (let i = 0; i < og.owner.length; i++) {
      const t = ownerSampleTile(og, game, i);
      expect(game.x(t) % 4).toBe(2);
      const want = game.isLand(t) ? game.ownerID(t) : OWNER_WATER;
      expect(og.owner[i]).toBe(want);
    }
    const reach = reachCells(og, grid, me.smallID(), 100);
    // Our disc x 6..13 is sampled at x = 6 and 10; the nation's nearest
    // sample is x = 42: 32 tiles = 8 cells. The tribe: x = 70 → 60 tiles,
    // 15 cells, across the water.
    expect(reach.get(nations[0].smallID())).toBe(8);
    expect(reach.get(tribes[0].smallID())).toBe(15);
    expect(reach.has(me.smallID())).toBe(false);
    const near = reachCells(og, grid, me.smallID(), 10);
    expect([...near.keys()]).toEqual([nations[0].smallID()]);
    expect(reachCells(og, grid, 999, 100).size).toBe(0);
    void w;
  });

  test("a player no sample hits is stamped at its spawn block", () => {
    const { game, me, grid } = scene();
    // Stride 16: samples at x = 8, 24, ...; our disc x 6..13, y 44..51 is
    // hit at (8, 40)? No: rows are sampled at y = 8, 24, 40, 56, so no
    // sample is ours, and the spawn block gets our id.
    const og = ownerGrid(game, grid, 16);
    const ours = [...og.owner].filter((id) => id === me.smallID()).length;
    expect(ours).toBe(1);
    const block = Math.floor(48 / 16) * og.ow + Math.floor(10 / 16);
    expect(og.owner[block]).toBe(me.smallID());
  });

  test("boatTargets land on unowned or tribe shore we do not touch, best first", () => {
    const { game, me, tribes, grid } = scene();
    const og = ownerGrid(game, grid, 4);
    const targets = boatTargets(game, grid, og, me, 12);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.length).toBeLessThanOrEqual(12);
    const islandB = grid.comp[cellOf(grid, game, game.ref(90, 90))];
    let tribe = 0;
    let onB = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      expect(game.isOceanShore(t.tile)).toBe(true);
      const id = game.ownerID(t.tile);
      expect(id === 0 || id === tribes[0].smallID()).toBe(true);
      expect(t.tn).toBe(id === 0);
      expect(t.tribeSmallID).toBe(id === 0 ? null : id);
      for (const n of game.neighbors(t.tile)) {
        expect(game.ownerID(n)).not.toBe(me.smallID());
      }
      expect(t.comp).toBe(grid.comp[cellOf(grid, game, t.tile)]);
      if (i > 0) expect(t.score).toBeLessThanOrEqual(targets[i - 1].score);
      if (id !== 0) tribe++;
      if (t.comp === islandB) onB++;
    }
    expect(tribe).toBeGreaterThan(0);
    expect(onB).toBe(targets.length);
    expect(new Set(targets.map((t) => t.tile)).size).toBe(targets.length);
    // Food: island B's free plus tribe land, from the samples (×16).
    const samples = [...og.owner.keys()].filter((i) => {
      const t = ownerSampleTile(og, game, i);
      return (
        grid.comp[cellOf(grid, game, t)] === islandB &&
        og.owner[i] !== OWNER_WATER
      );
    }).length;
    expect(targets[0].food).toBe(samples * 16);
    expect(boatTargets(game, grid, og, me, 0)).toEqual([]);
  });

  test(
    "allySlots on World: 72 nations and us give A_max 19, webTarget 18",
    async () => {
      const { game, me } = await spawnGame(GameMapType.World);
      const nonBots = game.players().filter((p) => p.type() !== PlayerType.Bot);
      expect(nonBots).toHaveLength(72);
      expect(allySlots(game, me, 0)).toEqual({
        max: 19,
        ext: 18,
        webTarget: 18,
      });
      expect(allySlots(game, me, 1).webTarget).toBe(17);
    },
    TIMEOUT,
  );
});
