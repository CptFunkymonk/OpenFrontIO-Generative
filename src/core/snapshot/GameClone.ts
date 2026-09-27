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
 * Structural clone: an exact copy of a game, the game `restoreGame(
 * snapshotGame(game))` gives, made without the byte encoding and without
 * rebuilding what the map already holds. Stepped with the same intents, a
 * clone stays identical to its game, tick for tick; so does a restore,
 * except with water nukes (the water graph, below), where only the clone
 * does.
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
 * - Player tile sets are not listed: a set written with
 *   `SnapshotWriter.tileSet` is a placeholder in structural mode, and
 *   `SnapshotReader.tileSet` copies the set (`TileSet.clone`). A placeholder
 *   read any other way would read as no tiles, so the clone checks that
 *   every one was read back (`checkTileSetsRead`).
 * - Both maps are copied (`GameMapImpl.clone`): terrain with its edits, owner,
 *   fallout and defense bits. A restore rebuilds the same arrays: it writes
 *   the owners from the players' tile sets, which the simulation keeps in
 *   step with the map (GameImpl.conquer and relinquish).
 * - The water components and graph are copied as the game holds them, the
 *   graph with its path cache (`WaterManager` constructor). A restore
 *   rebuilds the graph from the components instead, which is the same graph
 *   only until water is added: then the game routes on its stale graph until
 *   the throttled rebuild, and an incremental rebuild orders the edges
 *   differently from a full one, so ship routes can break ties differently
 *   (WaterManager.restoreSnapshot). The graph is not in the snapshot, so the
 *   clone's snapshot bytes are the restore's all the same.
 *
 * The tests (tests/core/snapshot/GameClone.test.ts) hold a clone to a
 * restore: the same object graph (the water graph aside, which is held to
 * the game's), the same snapshot bytes, the same map arrays, the same hashes
 * and bytes for 600 ticks with nukes and ships in flight; and to the game:
 * chains of clones on a straight run's track through a whole game, with
 * water nukes too.
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
 * What changes when a game's big parts do, which a clone reads from the game
 * itself (GameCloneSource): its tick, and the counters that tile ownership,
 * fallout and water edits advance (conquer, relinquish, setFallout,
 * setWater, and the water conversions of a tick).
 */
interface BigPartsStamp {
  tick: number;
  territory: number;
  water: number;
  miniWater: number;
}

function bigPartsStamp(g: GameImpl): BigPartsStamp {
  return {
    tick: g.ticks(),
    territory: g.territoryVersion(),
    water: g.map().waterVersion(),
    miniWater: g.miniMap().waterVersion(),
  };
}

/**
 * A game's state taken once, between ticks, and cloned any number of times.
 * The records are written once; each clone copies them and the maps anew,
 * so clones share nothing with each other or with the game.
 *
 * The big parts are read from the game itself when a clone is made, so
 * every clone must be made before the game ticks again, and before anything
 * changes its territory or water between ticks (both checked). To clone the
 * same state later, keep a clone and take a source from it.
 */
export class GameCloneSource {
  private constructor(
    private readonly game: GameImpl,
    private readonly stamp: BigPartsStamp,
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
      bigPartsStamp(g),
      // Canonical (schema) key order, as the snapshot stores it.
      GameConfigSchema.parse(g.config().gameConfig()),
      records,
      w.tileSets!,
    );
  }

  /** The tick the source was taken at. */
  ticks(): number {
    return this.stamp.tick;
  }

  /** A new, independent game in the source's state. */
  clone(deps: CloneDeps): Game {
    const g = this.game;
    const now = bigPartsStamp(g);
    if (now.tick !== this.stamp.tick) {
      throw new SnapshotError(
        `clone source taken at tick ${this.stamp.tick}, but the game is at tick ${now.tick}`,
      );
    }
    if (
      now.territory !== this.stamp.territory ||
      now.water !== this.stamp.water ||
      now.miniWater !== this.stamp.miniWater
    ) {
      throw new SnapshotError(
        `clone source taken at tick ${this.stamp.tick}: the game's territory or water changed since`,
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
 * copied, strings (keys too) as their UTF-8 round trip gives them,
 * primitives kept, and no identity preserved. Anything else throws, as the
 * encoder does. Keys of `keep` (structural placeholders) are returned as
 * they are.
 */
export function copySnapshotData(
  v: unknown,
  keep: ReadonlyMap<object, unknown>,
): unknown {
  return copy(v, keep);
}

// The typed arrays SnapshotCodec encodes (Uint32Array, any subclass
// included, as a tile list; the others by exact class).
const CODEC_TYPED_ARRAYS: ReadonlySet<unknown> = new Set([
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
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
      return v;
    case "string":
      return codecString(v);
    case "object": {
      if (v === null) return null;
      if (Array.isArray(v)) {
        const out = new Array(v.length);
        for (let i = 0; i < v.length; i++) out[i] = copy(v[i], keep);
        return out;
      }
      if (ArrayBuffer.isView(v)) {
        if (keep.has(v)) return v;
        if (v instanceof Uint32Array) return new Uint32Array(v);
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
        const key = codecString(k);
        if (key === "__proto__") {
          throw new SnapshotCodecError("invalid object key __proto__");
        }
        out[key] = copy((v as Record<string, unknown>)[k], keep);
      }
      return out;
    }
    default:
      throw new SnapshotCodecError(`cannot encode a ${typeof v}`);
  }
}

const SURROGATE = /[\ud800-\udfff]/;

/**
 * A string as the codec's UTF-8 round trip returns it: TextEncoder writes
 * each lone surrogate as U+FFFD, and the decoder (TextDecoder, ignoreBOM
 * off) drops one leading U+FEFF.
 */
function codecString(s: string): string {
  const out = SURROGATE.test(s) ? wellFormed(s) : s;
  return out.charCodeAt(0) === 0xfeff ? out.slice(1) : out;
}

/** `s` with each lone surrogate replaced by U+FFFD (String.toWellFormed). */
function wellFormed(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
        continue;
      }
    }
    out += c >= 0xd800 && c <= 0xdfff ? "\ufffd" : s[i];
  }
  return out;
}
