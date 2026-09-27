import { Config } from "../../../src/core/configuration/Config";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { Game, GameMode, UnitType } from "../../../src/core/game/Game";
import { GameImpl } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { TileSet } from "../../../src/core/game/TileSet";
import { GameRunner } from "../../../src/core/GameRunner";
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
 * The structural clone (src/core/snapshot/GameClone.ts) must be exactly a
 * snapshot restore, only faster: for the same game, the clone and
 * restoreGame(snapshotGame(game)) have the same object graph, the same
 * snapshot bytes and the same map arrays, and they stay hash- and
 * byte-identical tick by tick, through nukes, ships and water nukes. Clones
 * of clones, and of restored games, stay on the straight run's track for a
 * whole game. The game is the scripted one of FullGameSnapshot.test.ts,
 * which exercises every intent and execution type, with the same variants.
 */

const MAP = "world";
const TEST_TIMEOUT = 300_000;
// Nukes and ships in flight at the clone, then this long in lockstep.
const LOCKSTEP_TICKS = 600;
const BYTES_EVERY = 50;
// The straight run that chains of clones are held to, as in
// FullGameSnapshot.test.ts.
const TICKS = 1500;
const CHECK_EVERY = 100;
const WINDOW_START = 700;
const WINDOW_TICKS = 40;

const VARIANTS: [string, Partial<GameConfig>][] = [
  ["free for all", {}],
  // Water nukes rewrite terrain and the water graph mid-game.
  ["water nukes", { waterNukes: true }],
  ["teams", { gameMode: GameMode.Team, playerTeams: 2 }],
];

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
 * elements, and Map and Set entries (functions are not followed).
 */
function reachable(root: unknown): Set<object> {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v !== "object" || v === null || seen.has(v)) continue;
    seen.add(v);
    if (ArrayBuffer.isView(v)) continue;
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

describe.each(VARIANTS)("structural clone: %s", (_, overrides) => {
  const start = scriptedGameStart(overrides);

  test(
    "a clone is the restored game: object graph, snapshot bytes and maps, every 100 ticks",
    async () => {
      const runner = await createScriptedRunner(MAP, start);
      while (runner.game.ticks() <= 1200) {
        if (runner.game.ticks() % 100 === 0) {
          // Before the snapshot, which caches the map file's hash on the
          // live map (a derived value; see the last test).
          const clone = cloneRunner(runner, start);
          const bytes = runner.snapshot();
          const restored = await restoreScriptedRunner(MAP, start, bytes);
          const tick = runner.game.ticks();
          expect(
            diffGraphs(clone.game, restored.game, {
              ignore: new Set([...DERIVED_FIELDS, "pristineHashCache"]),
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
      lockstep([restored, clone, runner], LOCKSTEP_TICKS);
      expectSameMaps(clone.game, restored.game);
    },
    TEST_TIMEOUT,
  );

  test(
    `cloned before any nuke landed, identical through the ones that follow (${LOCKSTEP_TICKS} ticks)`,
    async () => {
      // Before tick 400 no bomb has landed: the clone copies the water
      // graph instead of rebuilding it, then meets the first water nukes.
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
      lockstep([restored, clone, runner], LOCKSTEP_TICKS);
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

interface Reference {
  hashes: number[];
  checkpoints: Map<number, Uint8Array>;
  final: Uint8Array;
  winnerTick: number | null;
}

/** The game played straight through: every hash, and bytes every 100 ticks. */
async function playReference(start: GameStartInfo): Promise<Reference> {
  const runner = await createScriptedRunner(MAP, start);
  const hashes: number[] = [];
  const checkpoints = new Map<number, Uint8Array>();
  let winnerTick: number | null = null;
  while (runner.game.ticks() < TICKS) {
    const tick = runner.game.ticks();
    if (tick % CHECK_EVERY === 0) checkpoints.set(tick, runner.snapshot());
    stepScripted(runner);
    hashes[runner.game.ticks()] = hash(runner.game);
    if (winnerTick === null && runner.game.getWinner() !== null) {
      winnerTick = runner.game.ticks();
    }
  }
  return { hashes, checkpoints, final: runner.snapshot(), winnerTick };
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
  "structural clone chained through a game: %s",
  (_, overrides) => {
    const start = scriptedGameStart(overrides);
    let reference: Reference;

    beforeAll(async () => {
      reference = await playReference(start);
    }, TEST_TIMEOUT);

    test(
      "cloning every 100 ticks, each clone from the last, continues exactly like the straight run",
      async () => {
        let runner = await createScriptedRunner(MAP, start);
        let winnerTick: number | null = null;
        while (runner.game.ticks() < TICKS) {
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
    "a clone shares no writable object with its game, and neither do two clones",
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
      expect(
        diffGraphs(clone.game, restored.game, {
          ignore: new Set([...DERIVED_FIELDS, "pristineHashCache"]),
        }),
      ).toEqual([]);
      lockstep([restored, clone], 50);
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
    "the water graph is copied only while a restore would rebuild the same",
    async () => {
      const runner = await createScriptedRunner(MAP, start);
      playUntil(runner, 200, () => false);
      expect(runner.game.miniMap().waterVersion()).toBe(0);
      const cloneFor = vi.spyOn(ConnectedComponents.prototype, "cloneFor");
      try {
        const deps = {
          config: (gc: GameConfig) => new Config(gc, null, false, start.listed),
        };
        cloneGame(runner.game, deps);
        expect(cloneFor).toHaveBeenCalledTimes(1);
        cloneFor.mockClear();

        // Components added without the minimap changing (finalizeWaterChanges
        // on a minimap tile whose setWater is a no-op): a restore's fresh
        // labeling no longer matches the live one, so the clone must build.
        const wm = (
          runner.game as unknown as {
            _waterManager: {
              _miniWaterCC: ConnectedComponents;
              _waterGraphDirty: boolean;
              _dirtyMiniTiles: Set<number>;
            };
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
        expect(cloneFor).not.toHaveBeenCalled();
        const restored = await restoreScriptedRunner(
          MAP,
          start,
          runner.snapshot(),
        );
        expect(
          diffGraphs(clone.game, restored.game, {
            ignore: new Set([...DERIVED_FIELDS, "pristineHashCache"]),
          }),
        ).toEqual([]);
        lockstep([restored, clone], 60);
      } finally {
        cloneFor.mockRestore();
      }
    },
    TEST_TIMEOUT,
  );
});
