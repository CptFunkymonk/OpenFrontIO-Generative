import type {
  Attack,
  Execution,
  MutableAlliance,
  Player,
  TerraNullius,
  Unit,
} from "../game/Game";
import type { GameImpl } from "../game/GameImpl";
import type { TileRef } from "../game/GameMap";
import type { Railroad } from "../game/Railroad";
import { TileSet } from "../game/TileSet";
import type { Cluster, TrainStation } from "../game/TrainStation";
import { PseudoRandom } from "../PseudoRandom";
import { SnapshotError, SnapshotType, Versioned } from "./SnapshotType";

/** A stored execution: its registered type name plus a versioned record. */
export interface ExecRecord extends Versioned {
  t: string;
}

/**
 * Assigns table indexes to objects in first-reference order. Serializing one
 * object can reference more, so rows are drained until the table is closed.
 */
export class RefTable<T> {
  private readonly index = new Map<T, number>();
  readonly items: T[] = [];

  ref(obj: T): number {
    let i = this.index.get(obj);
    if (i === undefined) {
      i = this.items.length;
      this.index.set(obj, i);
      this.items.push(obj);
    }
    return i;
  }

  has(obj: T): boolean {
    return this.index.has(obj);
  }
}

/**
 * Collects everything a snapshot needs while objects serialize themselves.
 *
 * Nothing in a snapshot holds an object pointer. Players are their small id,
 * tiles are TileRefs, and every other shared object (units, attacks,
 * alliances, alliance requests, executions, train stations, railroads,
 * clusters) becomes an index into a table that the writer fills in
 * first-reference order. Dead objects that are still referenced land in the
 * tables like live ones.
 */
export class SnapshotWriter {
  readonly units = new RefTable<Unit>();
  readonly attacks = new RefTable<Attack>();
  readonly alliances = new RefTable<MutableAlliance>();
  readonly allianceRequests = new RefTable<object>();
  readonly execs = new RefTable<Execution>();
  readonly stations = new RefTable<TrainStation>();
  readonly railroads = new RefTable<Railroad>();
  readonly clusters = new RefTable<Cluster>();
  /**
   * Structural mode (GameClone): a set written with `tileSet` is not listed.
   * `tileSet` returns an empty placeholder and records the set under it
   * here; the clone copies the set itself (SnapshotReader.tileSet). Null
   * when writing a snapshot.
   */
  readonly tileSets: Map<Uint32Array, TileSet> | null;

  constructor(
    readonly game: GameImpl,
    opts: { structural?: boolean } = {},
  ) {
    this.tileSets = opts.structural === true ? new Map() : null;
  }

  player(p: Player): number {
    return p.smallID();
  }

  owner(p: Player | TerraNullius): number {
    return p.smallID();
  }

  playerOrNull(p: Player | null | undefined): number | null {
    return p ? p.smallID() : null;
  }

  unit(u: Unit): number {
    return this.units.ref(u);
  }

  unitOrNull(u: Unit | null | undefined): number | null {
    return u ? this.units.ref(u) : null;
  }

  attack(a: Attack): number {
    return this.attacks.ref(a);
  }

  alliance(a: MutableAlliance): number {
    return this.alliances.ref(a);
  }

  allianceRequest(r: object): number {
    return this.allianceRequests.ref(r);
  }

  exec(e: Execution): number {
    return this.execs.ref(e);
  }

  station(s: TrainStation): number {
    return this.stations.ref(s);
  }

  railroad(r: Railroad): number {
    return this.railroads.ref(r);
  }

  cluster(c: Cluster): number {
    return this.clusters.ref(c);
  }

  random(r: PseudoRandom): [number, number, number, number] {
    return r.getState();
  }

  /** A tile list, in iteration order. */
  tiles(tiles: Iterable<TileRef>): Uint32Array {
    return tiles instanceof TileSet
      ? tiles.toUint32Array()
      : Uint32Array.from(tiles);
  }

  /**
   * A TileSet, stored as its tile list; read it back with
   * SnapshotReader.tileSet only. In structural mode it is an empty
   * placeholder instead, standing for the set (see `tileSets`).
   */
  tileSet(set: TileSet): Uint32Array {
    if (this.tileSets === null) return set.toUint32Array();
    const placeholder = new Uint32Array(0);
    this.tileSets.set(placeholder, set);
    return placeholder;
  }

  versioned<S>(type: SnapshotType<S>, data: S): Versioned {
    return { v: type.version, d: data };
  }
}

/** Resolves the ids and table indexes a SnapshotWriter produced. */
export class SnapshotReader {
  // Structural-mode placeholders resolved by tileSet (checkTileSetsRead).
  private readonly placeholdersRead = new Set<Uint32Array>();

  constructor(
    readonly game: GameImpl,
    private readonly tables: {
      units: Unit[];
      attacks: Attack[];
      alliances: MutableAlliance[];
      allianceRequests: object[];
      execs: Execution[];
      stations: TrainStation[];
      railroads: Railroad[];
      clusters: Cluster[];
      /** Player id by small id, readable before player shells are filled. */
      playerIds: Map<number, string>;
      /** Structural mode: the sets behind SnapshotWriter.tileSets placeholders. */
      tileSets?: ReadonlyMap<Uint32Array, TileSet>;
    },
  ) {}

  private row<T>(table: T[], i: number, what: string): T {
    const v = table[i];
    if (v === undefined) {
      throw new SnapshotError(`reference to missing ${what} #${i}`);
    }
    return v;
  }

  player(id: number): Player {
    const p = this.game.playerBySmallID(id);
    if (p === undefined || !p.isPlayer()) {
      throw new SnapshotError(`reference to missing player ${id}`);
    }
    return p;
  }

  /** A player's PlayerID, without touching the (possibly unfilled) shell. */
  playerID(smallID: number): string {
    const id = this.tables.playerIds.get(smallID);
    if (id === undefined) {
      throw new SnapshotError(`reference to missing player ${smallID}`);
    }
    return id;
  }

  owner(id: number): Player | TerraNullius {
    return id === 0 ? this.game.terraNullius() : this.player(id);
  }

  playerOrNull(id: number | null): Player | null {
    return id === null ? null : this.player(id);
  }

  unit(i: number): Unit {
    return this.row(this.tables.units, i, "unit");
  }

  unitOrNull(i: number | null): Unit | null {
    return i === null ? null : this.unit(i);
  }

  attack(i: number): Attack {
    return this.row(this.tables.attacks, i, "attack");
  }

  alliance(i: number): MutableAlliance {
    return this.row(this.tables.alliances, i, "alliance");
  }

  allianceRequest<T = object>(i: number): T {
    return this.row(this.tables.allianceRequests, i, "alliance request") as T;
  }

  exec<T extends Execution = Execution>(i: number): T {
    return this.row(this.tables.execs, i, "execution") as T;
  }

  station(i: number): TrainStation {
    return this.row(this.tables.stations, i, "train station");
  }

  railroad(i: number): Railroad {
    return this.row(this.tables.railroads, i, "railroad");
  }

  cluster(i: number): Cluster {
    return this.row(this.tables.clusters, i, "cluster");
  }

  random(state: readonly number[]): PseudoRandom {
    return PseudoRandom.fromState(state);
  }

  /**
   * A TileSet holding `tiles` in their order (SnapshotWriter.tileSet), or,
   * for a structural-mode placeholder, a copy of the set it stands for.
   */
  tileSet(tiles: Uint32Array): TileSet {
    const source = this.tables.tileSets?.get(tiles);
    if (source === undefined) return new TileSet(tiles);
    this.placeholdersRead.add(tiles);
    return source.clone();
  }

  /**
   * Structural mode: throws unless every placeholder was read back through
   * tileSet. A placeholder read any other way reads as an empty tile list.
   */
  checkTileSetsRead(): void {
    const expected = this.tables.tileSets?.size ?? 0;
    if (this.placeholdersRead.size !== expected) {
      throw new SnapshotError(
        `structural clone: ${expected - this.placeholdersRead.size} of ${expected} tile sets were not read back with SnapshotReader.tileSet`,
      );
    }
  }
}
