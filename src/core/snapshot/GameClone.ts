import { Config } from "../configuration/Config";
import { Game } from "../game/Game";
import { GameImpl, GameSnapshot } from "../game/GameImpl";
import { GameMapImpl } from "../game/GameMap";
import type { TileSet } from "../game/TileSet";
import { GameConfig, GameConfigSchema } from "../Schemas";
import {
  newRestoredGame,
  restoreSnapshotRecords,
  SnapshotRecords,
  writeSnapshotRecords,
} from "./GameSnapshot";
import { SnapshotCodecError } from "./SnapshotCodec";
import { SnapshotWriter } from "./SnapshotContext";
import { readVersioned, SnapshotError } from "./SnapshotType";

/**
 * Structural clone: a copy of a game that is exactly what
 * `restoreGame(snapshotGame(game))` gives, made without the byte encoding and
 * without rebuilding what the map already holds.
 *
 * A snapshot restore costs time in proportion to the map and the owned
 * land: every owned tile is listed, encoded, decoded, hashed into a TileSet
 * and written back as an owner, the map is loaded fresh and scanned, and the
 * water graph is rebuilt. The clone instead copies those parts as they are
 * (typed arrays), and takes everything else through the snapshot's own
 * records:
 *
 * - The small object graph (players, units, attacks, alliances, executions,
 *   PRNG states, stats) goes through each class's `snapshot()` and
 *   `restoreSnapshot()`, as a restore does. The records are copied with the
 *   codec's semantics (`copySnapshotData`) and read with `readVersioned`, so
 *   `restoreSnapshot` sees the same data it would after decoding.
 * - Player tile sets are not listed: the writer's structural mode leaves a
 *   placeholder and the reader copies the set (`TileSet.clone`).
 * - Both maps are copied (`GameMapImpl.clone`): terrain with its edits, owner,
 *   fallout and defense bits. A restore rebuilds the same arrays.
 * - The water components and graph are copied while the minimap still has
 *   the map file's water, when a rebuild would compute the same; after water
 *   nukes they are rebuilt as a restore does (`WaterManager` constructor).
 *
 * The tests (tests/core/snapshot/GameClone.test.ts) hold a clone to a
 * restore: the same object graph, the same snapshot bytes, the same map
 * arrays, and the same hashes and bytes for 600 ticks with nukes and ships
 * in flight.
 */

/**
 * What a clone needs besides the game (see RestoreDeps). The maps, and the
 * map's team spawn areas, come from the game itself.
 */
export interface CloneDeps {
  /** The clone's Config, from the game config, as a restore makes it. */
  config: (gameConfig: GameConfig) => Config;
}

/**
 * A game's state taken once, between ticks, and cloned any number of times.
 * The records are written once; each clone copies them and the maps anew,
 * so clones share nothing with each other or with the game.
 *
 * The big parts are read from the game itself when a clone is made, so
 * every clone must be made before the game ticks again (checked). To clone
 * the same state later, keep a clone and take a source from it.
 */
export class GameCloneSource {
  private constructor(
    private readonly game: GameImpl,
    private readonly tick: number,
    private readonly gameConfig: GameConfig,
    private readonly records: SnapshotRecords,
    private readonly tileSets: ReadonlyMap<Uint32Array, TileSet>,
  ) {}

  /** Takes `game` as it is now. Call between ticks. */
  static take(game: Game): GameCloneSource {
    const g = game as GameImpl;
    const w = new SnapshotWriter(g, { structural: true });
    const records = writeSnapshotRecords(g, w);
    return new GameCloneSource(
      g,
      g.ticks(),
      // Canonical (schema) key order, as the snapshot stores it.
      GameConfigSchema.parse(g.config().gameConfig()),
      records,
      w.tileSets!,
    );
  }

  /** The tick the source was taken at. */
  ticks(): number {
    return this.tick;
  }

  /** A new, independent game in the source's state. */
  clone(deps: CloneDeps): Game {
    const g = this.game;
    if (g.ticks() !== this.tick) {
      throw new SnapshotError(
        `clone source taken at tick ${this.tick}, but the game is at tick ${g.ticks()}`,
      );
    }
    const data = copySnapshotData(
      this.records,
      this.tileSets,
    ) as SnapshotRecords;
    const gameConfig = GameConfigSchema.parse(
      copySnapshotData(this.gameConfig, this.tileSets),
    );
    const config = deps.config(gameConfig);
    const state = readVersioned(GameSnapshot, data.game);
    const game = newRestoredGame(
      state,
      config,
      {
        gameMap: (g.map() as GameMapImpl).clone(),
        miniGameMap: (g.miniMap() as GameMapImpl).clone(),
        teamGameSpawnAreas: g.teamGameSpawnAreas(),
      },
      g,
    );
    // The copied map already holds every owner: no owner pass, unlike a
    // restore, which writes them from the players' tile lists.
    restoreSnapshotRecords(game, state, data, this.tileSets);
    return game;
  }
}

/** `GameCloneSource.take(game).clone(deps)`. */
export function cloneGame(game: Game, deps: CloneDeps): Game {
  return GameCloneSource.take(game).clone(deps);
}

/**
 * A deep copy of snapshot data with the byte codec's semantics, that is
 * `decodeSnapshotValue(encodeSnapshotValue(v))`: plain objects and arrays
 * rebuilt in key and index order (holes read as undefined), typed arrays
 * copied, primitives kept, and no identity preserved. Anything else throws,
 * as the encoder does. Keys of `keep` (structural placeholders) are
 * returned as they are.
 */
export function copySnapshotData(
  v: unknown,
  keep: ReadonlyMap<object, unknown>,
): unknown {
  return copy(v, keep);
}

// The typed arrays SnapshotCodec encodes.
const CODEC_TYPED_ARRAYS: ReadonlySet<unknown> = new Set([
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
]);

// No path is tracked (the encoder names one in its errors): this runs over
// every record of every clone.
function copy(v: unknown, keep: ReadonlyMap<object, unknown>): unknown {
  switch (typeof v) {
    case "undefined":
    case "boolean":
    case "number":
    case "bigint":
    case "string":
      return v;
    case "object": {
      if (v === null) return null;
      if (Array.isArray(v)) {
        const out = new Array(v.length);
        for (let i = 0; i < v.length; i++) out[i] = copy(v[i], keep);
        return out;
      }
      if (ArrayBuffer.isView(v)) {
        if (keep.has(v)) return v;
        if (!CODEC_TYPED_ARRAYS.has(v.constructor)) {
          throw new SnapshotCodecError(
            `unsupported binary view ${v.constructor.name}`,
          );
        }
        return (v as Uint8Array).slice();
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new SnapshotCodecError(
          `snapshot data must be plain; got ${proto?.constructor?.name ?? "unknown"}`,
        );
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) {
        if (k === "__proto__") {
          throw new SnapshotCodecError("invalid object key __proto__");
        }
        out[k] = copy((v as Record<string, unknown>)[k], keep);
      }
      return out;
    }
    default:
      throw new SnapshotCodecError(`cannot encode a ${typeof v}`);
  }
}
