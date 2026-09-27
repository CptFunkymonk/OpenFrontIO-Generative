import { Config } from "../../../src/core/configuration/Config";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { Game, GameMode, UnitType } from "../../../src/core/game/Game";
import { GameImpl } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { PlayerImpl } from "../../../src/core/game/PlayerImpl";
import { TileSet } from "../../../src/core/game/TileSet";
import { GameRunner } from "../../../src/core/GameRunner";
import {
  AbstractGraph,
  AbstractGraphBuilder,
} from "../../../src/core/pathfinding/algorithms/AbstractGraph";
import { ConnectedComponents } from "../../../src/core/pathfinding/algorithms/ConnectedComponents";
import { GameConfig, GameStartInfo } from "../../../src/core/Schemas";
import {
  cloneGame,
  copySnapshotData,
  GameCloneSource,
} from "../../../src/core/snapshot/GameClone";
import { snapshotGameData } from "../../../src/core/snapshot/GameSnapshot";
import {
  decodeSnapshotValue,
  encodeSnapshotValue,
} from "../../../src/core/snapshot/SnapshotCodec";
import {
  SnapshotReader,
  SnapshotWriter,
} from "../../../src/core/snapshot/SnapshotContext";
import {
  createScriptedRunner,
  restoreScriptedRunner,
  scriptedGameStart,
  stepScripted,
} from "../../util/ScriptedGame";
import {
  bytesEqual,
  DERIVED_FIELDS,
  diffGraphs,
  diffSnapshots,
} from "../../util/Snapshot";

/**
 * The structural clone (src/core/snapshot/GameClone.ts) must be an exact copy
 * of its game: stepped with the same intents, the two stay identical tick for
 * tick, through nukes, ships and water nukes, and chains of clones stay on
 * the straight run's track through a whole game. It must also be what a
 * snapshot restore gives: the same snapshot bytes, the same map arrays and
 * the same object graph, but for the water graph once water nukes have
 * rebuilt it. A restore builds that graph afresh, in another edge order and
 * without the paths the game cached, and can then route ships differently
 * from the game (WaterManager.restoreSnapshot); the clone keeps the game's
 * own, and is held to the game there. The game is the scripted one of
 * FullGameSnapshot.test.ts, which exercises every intent and execution type,
 * with the same variants.
 */

const MAP = "world";
const TEST_TIMEOUT = 300_000;
// A clone is compared with its game and with a restore every 100 ticks, up
// to here: past the first water-graph rebuilds a restore gets wrong (1,600).
const GRAPH_TICKS = 2000;
// Nukes and ships in flight at the clone, then this long in lockstep.
const LOCKSTEP_TICKS = 600;
const BYTES_EVERY = 50;
const CHECK_EVERY = 100;
const WINDOW_START = 700;
const WINDOW_TICKS = 40;
// The straight run goes on this long after the winner.
const AFTER_WIN = 100;

interface Variant {
  name: string;
  overrides: Partial<GameConfig>;
  /** The straight run's end, if no winner comes first. */
  maxTicks: number;
  /** Whether the straight run has a winner by maxTicks. */
  winner: boolean;
}

const VARIANTS: Variant[] = [
  // A winner at tick 5,021.
  { name: "free for all", overrides: {}, maxTicks: 6000, winner: true },
  // Water nukes rewrite terrain and the water graph mid-game (no winner by
  // tick 8,000).
  {
    name: "water nukes",
    overrides: { waterNukes: true },
    maxTicks: 3000,
    winner: false,
  },
  // A winner at tick 2,481.
  {
    name: "teams",
    overrides: { gameMode: GameMode.Team, playerTeams: 2 },
    maxTicks: 3000,
    winner: true,
  },
];

// What a clone holds differently from its game, on purpose: caches (the
// test util's DERIVED_FIELDS, and the map file's hash), stamp-based BFS
// scratch that WaterManager makes on its first water change (a fresh array
// visits exactly as a used one), and the manager's own marker.
const NOT_COPIED = new Set([
  ...DERIVED_FIELDS,
  "pristineHashCache",
  "_waterDistArr",
  "_waterStampArr",
  "_waterStamp",
  "_miniDistArr",
  "_miniStampArr",
  "_miniStamp",
  "copiedFromSource",
  // A water pathfinder's search chain (PathFinder.ts sharedWaterChain): a
  // ship waiting out its stagger countdown after a water-graph rebuild holds
  // the chain object of the version it had, a clone's (and a restore's) the
  // current one. Chains are stateless wrappers of the game's one water
  // search (AStarWaterHierarchical, whose graph the rebuild swapped), so
  // both search alike; only the object differs. (A trade ship's chain is a
  // route memo, which can differ: the snapshot README's known gaps.)
  "finder",
]);
// And from a restore: the paths the game cached on its water graph, which a
// restore starts without; with water nukes, the whole graph, which a restore
// rebuilds (WaterManager.restoreSnapshot).
const RESTORE_UNCACHED = new Set([...NOT_COPIED, "_pathCache"]);
const RESTORE_REBUILT = new Set([...NOT_COPIED, "_miniWaterGraph"]);

function hash(game: Game): number {
  return (game as unknown as { hash(): number }).hash();
}

function cloneRunner(runner: GameRunner, start: GameStartInfo): GameRunner {
  const game = cloneGame(runner.game, {
    config: (gc) => new Config(gc, null, false, start.listed),
  });
  return runnerFor(game, start);
}

function runnerFor(game: Game, start: GameStartInfo): GameRunner {
  return new GameRunner(
    game,
    new Executor(
      game,
      start.gameID,
      undefined,
      start.tribes?.map((t) => t.name),
    ),
    () => {},
  );
}

interface MapArrays {
  terrain: Uint8Array;
  state: Uint16Array;
}

function mapArrays(game: Game): { map: MapArrays; mini: MapArrays } {
  const arrays = (m: GameMapImpl) => m as unknown as MapArrays;
  return {
    map: arrays(game.map() as GameMapImpl),
    mini: arrays(game.miniMap() as GameMapImpl),
  };
}

/** The clone and the restore hold the same maps, byte for byte. */
function expectSameMaps(a: Game, b: Game): void {
  const x = mapArrays(a);
  const y = mapArrays(b);
  for (const k of ["map", "mini"] as const) {
    expect(bytesEqual(x[k].terrain, y[k].terrain), `${k} terrain`).toBe(true);
    const sx = new Uint8Array(x[k].state.buffer);
    const sy = new Uint8Array(y[k].state.buffer);
    expect(bytesEqual(sx, sy), `${k} state`).toBe(true);
  }
}

const MOVING = [
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.MIRVWarhead,
] as const;
const SHIPS = [
  UnitType.TransportShip,
  UnitType.Warship,
  UnitType.TradeShip,
] as const;

function inFlight(game: Game): { nukes: number; ships: number } {
  return {
    nukes: game.units(MOVING).length,
    ships: game.units(SHIPS).length,
  };
}

/**
 * Steps each runner with the scripted intents (a pure function of the game
 * and tick, so equal games get equal intents) and checks every tick's hash
 * against the first runner, and the snapshot bytes every BYTES_EVERY ticks
 * and at the end.
 */
function lockstep(runners: GameRunner[], ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const r of runners) stepScripted(r);
    const expected = hash(runners[0].game);
    const tick = runners[0].game.ticks();
    runners.forEach((r, n) => {
      if (hash(r.game) !== expected) {
        throw new Error(`runner ${n}: hash diverged at tick ${tick}`);
      }
    });
    if ((i + 1) % BYTES_EVERY !== 0 && i + 1 !== ticks) continue;
    const bytes = runners[0].snapshot();
    runners.slice(1).forEach((r, n) => {
      const diffs = diffSnapshots(r.snapshot(), bytes);
      if (diffs.length > 0) {
        throw new Error(
          `runner ${n + 1}: state diverged at tick ${tick}:\n${diffs.join("\n")}`,
        );
      }
    });
  }
}

/**
 * Every object reachable from `root` through own properties, array
 * elements, and Map and Set entries (functions are not followed), and the
 * buffer behind every typed array, so that two views on one buffer count as
 * sharing it.
 */
function reachable(root: unknown): Set<object> {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v !== "object" || v === null || seen.has(v)) continue;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      stack.push(v.buffer);
      continue;
    }
    if (v instanceof ArrayBuffer) continue;
    if (v instanceof Map) {
      for (const [k, x] of v) stack.push(k, x);
    } else if (v instanceof Set) {
      for (const x of v) stack.push(x);
    }
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else {
      for (const k of Object.keys(v)) {
        stack.push((v as Record<string, unknown>)[k]);
      }
    }
  }
  return seen;
}

/** Objects both graphs reach that could be written: not frozen. */
function sharedMutable(a: unknown, b: unknown): object[] {
  const inA = reachable(a);
  return [...reachable(b)].filter((o) => inA.has(o) && !Object.isFrozen(o));
}

/** Plays until `until` holds (checked between ticks), at most `max` ticks. */
function playUntil(
  runner: GameRunner,
  max: number,
  until: (game: Game) => boolean,
): void {
  while (runner.game.ticks() < max && !until(runner.game)) {
    stepScripted(runner);
  }
}

/** A full build of the game's water graph, as a restore makes it. */
function fullBuild(game: Game): AbstractGraph {
  const wm = waterManager(game);
  const mini = game.miniMap();
  return new AbstractGraphBuilder(
    mini,
    AbstractGraphBuilder.CLUSTER_SIZE,
    undefined,
    undefined,
    wm._miniWaterCC.cloneFor(mini),
  ).build();
}

interface WaterManagerView {
  _miniWaterGraph: AbstractGraph;
  _miniWaterCC: ConnectedComponents;
  _waterGraphDirty: boolean;
  _dirtyMiniTiles: Set<number>;
  _waterGraphVersion: number;
}

function waterManager(game: Game): WaterManagerView {
  return (game as unknown as { _waterManager: WaterManagerView })._waterManager;
}

function edgeOrder(g: AbstractGraph): string[] {
  return g.getAllEdges().map((e) => `${e.nodeA}-${e.nodeB}:${e.cost}`);
}

describe.each(VARIANTS)("structural clone: $name", ({ overrides }) => {
  const start = scriptedGameStart(overrides);

  test(
    "a clone is its game, and the restored game but for the water graph: object graph, snapshot bytes and maps, every 100 ticks",
    async () => {
      const runner = await createScriptedRunner(MAP, start);
      while (runner.game.ticks() <= GRAPH_TICKS) {
        if (runner.game.ticks() % 100 === 0) {
          const tick = runner.game.ticks();
          const clone = cloneRunner(runner, start);
          expect(
            diffGraphs(clone.game, runner.game, { ignore: NOT_COPIED }),
            `tick ${tick}`,
          ).toEqual([]);
          const bytes = runner.snapshot();
          const restored = await restoreScriptedRunner(MAP, start, bytes);
          expect(
            diffGraphs(clone.game, restored.game, {
              ignore: overrides.waterNukes ? RESTORE_REBUILT : RESTORE_UNCACHED,
            }),
            `tick ${tick}`,
          ).toEqual([]);
          expect(
            diffSnapshots(clone.snapshot(), bytes),
            `tick ${tick}`,
          ).toEqual([]);
          expectSameMaps(clone.game, restored.game);
        }
        stepScripted(runner);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    `with nukes and ships in flight, the clone, the restore and the game stay identical for ${LOCKSTEP_TICKS} ticks`,
    async () => {
      const runner = await createScriptedRunner(MAP, start);
      playUntil(runner, 3000, (g) => {
        const f = inFlight(g);
        return g.ticks() >= 400 && f.nukes > 0 && f.ships > 0;
      });
      const at = inFlight(runner.game);
      expect(at.nukes).toBeGreaterThan(0);
      expect(at.ships).toBeGreaterThan(0);
      const clone = cloneRunner(runner, start);
      const restored = await restoreScriptedRunner(
        MAP,
        start,
        runner.snapshot(),
      );
      expect(hash(clone.game)).toBe(hash(runner.game));
      lockstep([runner, clone, restored], LOCKSTEP_TICKS);
      expectSameMaps(clone.game, restored.game);
    },
    TEST_TIMEOUT,
  );

  test(
    `cloned before any nuke landed, identical through the ones that follow (${LOCKSTEP_TICKS} ticks)`,
    async () => {
      // Before tick 400 no bomb has landed: the clone copies a water graph
      // that was never rebuilt, then meets the first water nukes.
      const runner = await createScriptedRunner(MAP, start);
      playUntil(runner, 300, () => false);
      expect(runner.game.miniMap().waterVersion()).toBe(0);
      const fallout = runner.game.numTilesWithFallout();
      const clone = cloneRunner(runner, start);
      const restored = await restoreScriptedRunner(
        MAP,
        start,
        runner.snapshot(),
      );
      lockstep([runner, clone, restored], LOCKSTEP_TICKS);
      if (overrides.waterNukes) {
        expect(clone.game.miniMap().waterVersion()).toBeGreaterThan(0);
      } else {
        expect(clone.game.numTilesWithFallout()).toBeGreaterThan(fallout);
      }
      expectSameMaps(clone.game, restored.game);
    },
    TEST_TIMEOUT,
  );
});

describe("structural clone: water nukes, where a restore goes astray", () => {
  const start = scriptedGameStart({ waterNukes: true });
  const FORK_LOCKSTEP = 400;

  test(
    "forked after incremental graph rebuilds and inside a stale-graph window, a clone stays identical to the game",
    async () => {
      // Found by forking every 50 ticks from 300 to 3,000 and stepping 400
      // ticks: a restore left the game's track at 14 of those points, the
      // first at tick 1,600 (at 1,800 nine ticks after the fork); a clone
      // at none. Before the fix the clone rebuilt the graph like a restore
      // and failed at the same points.
      const runner = await createScriptedRunner(MAP, start);
      const points: number[] = [];
      const astray: number[] = [];
      // Each fork point after the last one's lockstep (the game plays on).
      for (const at of [1800, "dirty", 3000] as const) {
        if (at === "dirty") {
          // Water added, and the graph not yet rebuilt: the game routes on
          // the stale graph and its cached paths.
          playUntil(runner, 4000, (g) => waterManager(g)._waterGraphDirty);
          expect(waterManager(runner.game)._waterGraphDirty).toBe(true);
        } else {
          playUntil(runner, at, () => false);
        }
        const tick = runner.game.ticks();
        points.push(tick);
        const live = waterManager(runner.game);
        expect(live._waterGraphVersion).toBeGreaterThan(1);
        const clone = cloneRunner(runner, start);
        const restored = await restoreScriptedRunner(
          MAP,
          start,
          runner.snapshot(),
        );
        // The clone holds the game's graph, edge for edge and with its
        // cached paths; a full build (a restore's) orders the edges
        // differently.
        const copied = waterManager(clone.game)._miniWaterGraph;
        expect(
          diffGraphs(copied, live._miniWaterGraph, { ignore: NOT_COPIED }),
        ).toEqual([]);
        expect(edgeOrder(fullBuild(runner.game))).not.toEqual(
          edgeOrder(live._miniWaterGraph),
        );
        // The game plays on, the clone and the restore alongside.
        let restoredAt: number | null = null;
        for (let i = 0; i < FORK_LOCKSTEP; i++) {
          stepScripted(runner);
          stepScripted(clone);
          stepScripted(restored);
          const expected = hash(runner.game);
          if (hash(clone.game) !== expected) {
            throw new Error(
              `clone of tick ${tick} diverged at tick ${runner.game.ticks()}`,
            );
          }
          if (restoredAt === null && hash(restored.game) !== expected) {
            restoredAt = runner.game.ticks();
          }
          if ((i + 1) % BYTES_EVERY === 0) {
            expect(diffSnapshots(clone.snapshot(), runner.snapshot())).toEqual(
              [],
            );
          }
        }
        if (restoredAt !== null) astray.push(tick);
      }
      console.log(
        `water nukes: clones of ticks ${points.join(", ")} stayed on the game's track ` +
          `for ${FORK_LOCKSTEP} ticks; restores left it from ${astray.join(", ")}`,
      );
      // The points still test what they say: restores go astray there.
      expect(astray.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );
});

interface Reference {
  hashes: number[];
  checkpoints: Map<number, Uint8Array>;
  final: Uint8Array;
  /** The tick the straight run ended at. */
  end: number;
  winnerTick: number | null;
}

/**
 * The game played straight through, to AFTER_WIN ticks past its winner or
 * to `maxTicks`: every hash, and bytes every 100 ticks.
 */
async function playReference(
  start: GameStartInfo,
  maxTicks: number,
): Promise<Reference> {
  const runner = await createScriptedRunner(MAP, start);
  const hashes: number[] = [];
  const checkpoints = new Map<number, Uint8Array>();
  let winnerTick: number | null = null;
  const done = () =>
    runner.game.ticks() >= maxTicks ||
    (winnerTick !== null && runner.game.ticks() >= winnerTick + AFTER_WIN);
  while (!done()) {
    const tick = runner.game.ticks();
    if (tick % CHECK_EVERY === 0) checkpoints.set(tick, runner.snapshot());
    stepScripted(runner);
    hashes[runner.game.ticks()] = hash(runner.game);
    if (winnerTick === null && runner.game.getWinner() !== null) {
      winnerTick = runner.game.ticks();
    }
  }
  return {
    hashes,
    checkpoints,
    final: runner.snapshot(),
    end: runner.game.ticks(),
    winnerTick,
  };
}

function expectOnTrack(runner: GameRunner, ref: Reference): void {
  const tick = runner.game.ticks();
  if (hash(runner.game) !== ref.hashes[tick]) {
    throw new Error(`hash diverged at tick ${tick}`);
  }
  const checkpoint = ref.checkpoints.get(tick);
  if (checkpoint !== undefined) {
    const diffs = diffSnapshots(runner.snapshot(), checkpoint);
    if (diffs.length > 0) {
      throw new Error(`state diverged at tick ${tick}:\n${diffs.join("\n")}`);
    }
  }
}

describe.each(VARIANTS)(
  "structural clone chained through a game: $name",
  ({ overrides, maxTicks, winner }) => {
    const start = scriptedGameStart(overrides);
    let reference: Reference;

    beforeAll(async () => {
      reference = await playReference(start, maxTicks);
    }, TEST_TIMEOUT);

    test(
      winner
        ? "cloning every 100 ticks, each clone from the last, continues exactly like the straight run, through its winner"
        : `cloning every 100 ticks, each clone from the last, continues exactly like the straight run for ${maxTicks} ticks`,
      async () => {
        // Else the winner check below would compare null with null.
        expect(reference.winnerTick !== null).toBe(winner);
        let runner = await createScriptedRunner(MAP, start);
        let winnerTick: number | null = null;
        while (runner.game.ticks() < reference.end) {
          stepScripted(runner);
          expectOnTrack(runner, reference);
          if (winnerTick === null && runner.game.getWinner() !== null) {
            winnerTick = runner.game.ticks();
          }
          if (runner.game.ticks() % CHECK_EVERY === 0) {
            runner = cloneRunner(runner, start);
          }
        }
        expect(diffSnapshots(runner.snapshot(), reference.final)).toEqual([]);
        expect(winnerTick).toBe(reference.winnerTick);
      },
      TEST_TIMEOUT,
    );

    test(
      "cloning at every tick of a mid-game window, from a restored game, stays on track",
      async () => {
        const from = Math.floor(WINDOW_START / CHECK_EVERY) * CHECK_EVERY;
        let runner = await restoreScriptedRunner(
          MAP,
          start,
          reference.checkpoints.get(from)!,
        );
        while (runner.game.ticks() < WINDOW_START) stepScripted(runner);
        while (runner.game.ticks() < WINDOW_START + WINDOW_TICKS) {
          runner = cloneRunner(runner, start);
          stepScripted(runner);
          expectOnTrack(runner, reference);
        }
      },
      TEST_TIMEOUT,
    );
  },
);

describe("structural clone: sources", () => {
  const start = scriptedGameStart();

  test(
    "one source makes many independent clones (forkMany), and refuses once the game ticked",
    async () => {
      const runner = await createScriptedRunner(MAP, start);
      playUntil(runner, 900, () => false);
      const bytes = runner.snapshot();
      const source = GameCloneSource.take(runner.game);
      const deps = {
        config: (gc: GameConfig) => new Config(gc, null, false, start.listed),
      };
      const [a, b, c] = [0, 1, 2].map(() =>
        runnerFor(source.clone(deps), start),
      );
      // Stepping one clone leaves the others, and the game, where they were.
      lockstep([a], 100);
      expect(diffSnapshots(b.snapshot(), bytes)).toEqual([]);
      expect(diffSnapshots(c.snapshot(), bytes)).toEqual([]);
      expect(diffSnapshots(runner.snapshot(), bytes)).toEqual([]);
      // Stepped alike, they agree with each other and with the game.
      lockstep([runner, b, c], 100);
      expect(diffSnapshots(a.snapshot(), runner.snapshot())).toEqual([]);

      expect(() => source.clone(deps)).toThrow(/tick/);
      // A clone kept aside serves later clones of its state.
      const kept = GameCloneSource.take(a.game);
      const later = runnerFor(kept.clone(deps), start);
      lockstep([a, later], 20);
    },
    TEST_TIMEOUT,
  );

  test(
    "a source refuses to clone once the game's territory or water changed between ticks",
    async () => {
      // A clone reads the tile sets, the maps and the water graph from the
      // game when it is made, and everything else from the take: made after
      // such a change it would be neither moment. (No agent may change the
      // game; a tool or a test might.)
      const runner = await createScriptedRunner(MAP, start);
      playUntil(runner, 300, () => false);
      const game = runner.game as GameImpl;
      const deps = {
        config: (gc: GameConfig) => new Config(gc, null, false, start.listed),
      };
      const [big, other] = game
        .players()
        .sort((x, y) => y.numTilesOwned() - x.numTilesOwned()) as PlayerImpl[];
      let source = GameCloneSource.take(game);
      game.conquer(other, [...big.tiles()][0]);
      expect(() => source.clone(deps)).toThrow(/changed/);

      source = GameCloneSource.take(game);
      const map = game.map();
      let land = -1;
      for (let t = 0; t < map.width() * map.height(); t++) {
        if (map.isLand(t) && !map.hasOwner(t) && !map.isImpassable(t)) {
          land = t;
          break;
        }
      }
      expect(land).toBeGreaterThanOrEqual(0);
      game.setWater(land);
      expect(() => source.clone(deps)).toThrow(/changed/);

      // Taken again, the clone is the game as it is now.
      const clone = runnerFor(GameCloneSource.take(game).clone(deps), start);
      expect(diffSnapshots(clone.snapshot(), runner.snapshot())).toEqual([]);
      lockstep([runner, clone], 20);
    },
    TEST_TIMEOUT,
  );

  test(
    "a clone shares no writable object or buffer with its game, and neither do two clones",
    async () => {
      const runner = await createScriptedRunner(MAP, start);
      playUntil(runner, 700, () => false);
      const source = GameCloneSource.take(runner.game);
      const deps = {
        config: (gc: GameConfig) => new Config(gc, null, false, start.listed),
      };
      const a = source.clone(deps);
      const b = source.clone(deps);
      // The map's team spawn areas are the one thing shared on purpose:
      // map-file data, never written (a restore shares its loader's too).
      const allowed = reachable(
        (
          runner.game as unknown as { teamGameSpawnAreas(): unknown }
        ).teamGameSpawnAreas(),
      );
      const shared = (x: unknown, y: unknown) =>
        sharedMutable(x, y)
          .filter((o) => !allowed.has(o))
          .map((o) => o.constructor?.name ?? "Object");
      expect(shared(runner.game, a)).toEqual([]);
      expect(shared(a, b)).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  test(
    "a clone of a game that was never snapshotted differs only in derived caches",
    async () => {
      const runner = await createScriptedRunner(MAP, start);
      playUntil(runner, 300, () => false);
      const clone = cloneRunner(runner, start);
      const restored = await restoreScriptedRunner(
        MAP,
        start,
        runner.snapshot(),
      );
      // The water graph too: never rebuilt, so a restore's full build is the
      // same graph; only the paths the game cached are the clone's alone.
      expect(
        diffGraphs(clone.game, restored.game, { ignore: RESTORE_UNCACHED }),
      ).toEqual([]);
      lockstep([runner, restored, clone], 50);
    },
    TEST_TIMEOUT,
  );

  test("copySnapshotData is the codec round trip", async () => {
    const runner = await createScriptedRunner(MAP, start);
    playUntil(runner, 200, () => false);
    const data = snapshotGameData(runner.game);
    const viaCodec = decodeSnapshotValue(encodeSnapshotValue(data));
    const copied = copySnapshotData(data, new Map());
    expect(
      bytesEqual(encodeSnapshotValue(copied), encodeSnapshotValue(viaCodec)),
    ).toBe(true);
    expect(diffGraphs(copied, viaCodec)).toEqual([]);
    expect(() => copySnapshotData({ f: () => 1 }, new Map())).toThrow();
    expect(() => copySnapshotData({ d: new Date() }, new Map())).toThrow();
  });

  test("copySnapshotData matches the codec on values the codec rewrites", () => {
    class TileList extends Uint32Array {}
    const words = new Uint32Array([7, 8, 9, 10]);
    const holes: unknown[] = [1, , 3]; // eslint-disable-line no-sparse-arrays
    const bare = Object.create(null) as Record<string, unknown>;
    bare.k = 1;
    const odd = {
      // TextEncoder writes lone surrogates as U+FFFD; the decoder drops a
      // leading byte order mark. Keys too, and they may then collide.
      strings: ["\ufeffabc", "\ufeff\ufeffx", "a\ud800b", "\udc00", "x\ud83d"],
      pair: "\ud83d\ude00 ok",
      "\ufeffkey": 1,
      "a\ud800": 2,
      "a\ufffd": 3,
      numbers: [-0, NaN, Infinity, 2 ** 53 + 2, -(2 ** 53) + 1, 1.5],
      big: [0n, -(2n ** 70n)],
      holes,
      missing: undefined,
      bare,
      sub: words.subarray(1, 3),
      list: new TileList([4, 5]),
      f64: new Float64Array([-0, NaN]),
    };
    const viaCodec = decodeSnapshotValue(encodeSnapshotValue(odd));
    const copied = copySnapshotData(odd, new Map());
    expect(
      bytesEqual(encodeSnapshotValue(copied), encodeSnapshotValue(viaCodec)),
    ).toBe(true);
    expect(diffGraphs(copied, viaCodec)).toEqual([]);
    expect(Object.keys(copied as object)).toEqual(
      Object.keys(viaCodec as object),
    );
    const c = copied as typeof odd;
    expect(c.strings).toEqual((viaCodec as typeof odd).strings);
    expect(Object.getPrototypeOf(c.list)).toBe(Uint32Array.prototype);
    expect([...c.sub]).toEqual([8, 9]);
    expect(Object.is(c.numbers[0], -0)).toBe(true);
    expect(() => copySnapshotData({ "\ufeff__proto__": 1 }, new Map())).toThrow(
      /__proto__/,
    );
    expect(() =>
      decodeSnapshotValue(encodeSnapshotValue({ "\ufeff__proto__": 1 })),
    ).toThrow(/__proto__/);
  });

  test("a tile set written for a clone must be read back as a tile set", () => {
    const game = {} as unknown as GameImpl;
    const set = new TileSet([5, 3, 9]);
    const tables = {
      units: [],
      attacks: [],
      alliances: [],
      allianceRequests: [],
      execs: [],
      stations: [],
      railroads: [],
      clusters: [],
      playerIds: new Map<number, string>(),
    };
    // A snapshot lists the set; a clone's writer leaves a placeholder.
    expect([...new SnapshotWriter(game).tileSet(set)]).toEqual([5, 3, 9]);
    const w = new SnapshotWriter(game, { structural: true });
    const placeholder = w.tileSet(set);
    expect(placeholder.length).toBe(0);
    // A plain tile list is always listed, TileSet or not.
    expect([...w.tiles(set)]).toEqual([5, 3, 9]);
    expect(w.tileSets!.size).toBe(1);

    const unread = new SnapshotReader(game, {
      ...tables,
      tileSets: w.tileSets!,
    });
    expect(() => unread.checkTileSetsRead()).toThrow(/not read back/);
    const r = new SnapshotReader(game, { ...tables, tileSets: w.tileSets! });
    const copy = r.tileSet(placeholder);
    expect(copy).not.toBe(set);
    expect([...copy]).toEqual([5, 3, 9]);
    r.checkTileSetsRead();
    // A listed set reads back as itself.
    expect([...r.tileSet(Uint32Array.from([2, 1]))]).toEqual([2, 1]);
  });

  test(
    "the water components and graph are the game's own, even where a restore rebuilds different ones",
    async () => {
      const runner = await createScriptedRunner(MAP, start);
      playUntil(runner, 200, () => false);
      const cloneFor = vi.spyOn(ConnectedComponents.prototype, "cloneFor");
      try {
        // Components added without the minimap changing (finalizeWaterChanges
        // on a minimap tile whose setWater is a no-op): a restore labels the
        // minimap afresh (the snapshot stores no components while the
        // minimap's waterVersion is 0), so it no longer has the game's.
        const wm = (
          runner.game as unknown as {
            _waterManager: WaterManagerView;
          }
        )._waterManager;
        const mini = runner.game.miniMap();
        let land = -1;
        for (let t = 0; t < mini.width() * mini.height(); t++) {
          if (mini.isLand(t) && !mini.isImpassable(t)) {
            land = t;
            break;
          }
        }
        expect(land).toBeGreaterThanOrEqual(0);
        wm._miniWaterCC.addWaterTiles([land]);
        wm._waterGraphDirty = true;
        wm._dirtyMiniTiles.add(land);
        expect(mini.waterVersion()).toBe(0);

        const clone = cloneRunner(runner, start);
        expect(cloneFor).toHaveBeenCalledTimes(1);
        expect(
          diffGraphs(clone.game, runner.game, { ignore: NOT_COPIED }),
        ).toEqual([]);
        // Through the rebuild the dirty flag asks for, and on.
        lockstep([runner, clone], 60);
        expect(waterManager(clone.game)._waterGraphVersion).toBe(
          waterManager(runner.game)._waterGraphVersion,
        );
        expect(waterManager(clone.game)._waterGraphDirty).toBe(false);
      } finally {
        cloneFor.mockRestore();
      }
    },
    TEST_TIMEOUT,
  );
});
