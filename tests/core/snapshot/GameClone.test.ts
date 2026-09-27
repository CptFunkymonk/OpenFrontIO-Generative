import { Config } from "../../../src/core/configuration/Config";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { Game, UnitType } from "../../../src/core/game/Game";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { GameRunner } from "../../../src/core/GameRunner";
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
 * byte-identical tick by tick, through nukes, ships and water nukes. The
 * game is the scripted one of FullGameSnapshot.test.ts, which exercises
 * every intent and execution type.
 */

const MAP = "world";
const TEST_TIMEOUT = 300_000;
// Nukes and ships in flight at the clone, then this long in lockstep.
const LOCKSTEP_TICKS = 600;
const BYTES_EVERY = 50;

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

describe.each<[string, Partial<GameConfig>]>([
  ["free for all", {}],
  ["water nukes", { waterNukes: true }],
])("structural clone: %s", (_, overrides) => {
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
});
