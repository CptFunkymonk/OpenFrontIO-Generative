import { Config } from "../core/configuration/Config";
import { Executor } from "../core/execution/ExecutionManager";
import {
  Game,
  GameMapSize,
  GameMapType,
  TeamGameSpawnAreas,
} from "../core/game/Game";
import { GameMapImpl } from "../core/game/GameMap";
import { GameMapLoader } from "../core/game/GameMapLoader";
import { ErrorUpdate, GameUpdateViewData } from "../core/game/GameUpdates";
import { loadTerrainMap, MapMetadata } from "../core/game/TerrainMapLoader";
import { GameRunner } from "../core/GameRunner";
import {
  ClientID,
  GameConfig,
  GameStartInfo,
  StampedIntent,
} from "../core/Schemas";
import { GameCloneSource } from "../core/snapshot/GameClone";
import { restoreGame } from "../core/snapshot/GameSnapshot";
import type { AgentIntent } from "./Agent";

interface TerrainBytes {
  meta: MapMetadata;
  bytes: Uint8Array;
}

/**
 * Pristine terrain for one map, loaded once. A snapshot can only be restored
 * onto unplayed maps, so every fork builds fresh maps from these bytes; that
 * is synchronous, which lets an agent fork inside its tick.
 */
export class TerrainSource {
  private constructor(
    private readonly main: TerrainBytes,
    private readonly mini: TerrainBytes,
    readonly teamGameSpawnAreas: TeamGameSpawnAreas | undefined,
  ) {}

  static async load(
    loader: GameMapLoader,
    map: GameMapType,
    size: GameMapSize,
  ): Promise<TerrainSource> {
    const files = loader.getMapData(map);
    const manifest = await files.manifest();
    // Same map/minimap pairing as loadTerrainMap.
    const main: TerrainBytes =
      size === GameMapSize.Normal
        ? { meta: manifest.map, bytes: await files.mapBin() }
        : { meta: manifest.map4x, bytes: await files.map4xBin() };
    const mini: TerrainBytes =
      size === GameMapSize.Normal
        ? { meta: manifest.map4x, bytes: await files.map4xBin() }
        : { meta: manifest.map16x, bytes: await files.map16xBin() };
    // Spawn areas are rescaled for compact maps; reuse the loader's logic.
    const { teamGameSpawnAreas } = await loadTerrainMap(
      map,
      size,
      loader,
      false,
      true,
    );
    return new TerrainSource(
      { meta: main.meta, bytes: main.bytes.slice() },
      { meta: mini.meta, bytes: mini.bytes.slice() },
      teamGameSpawnAreas,
    );
  }

  freshMaps(): { gameMap: GameMapImpl; miniGameMap: GameMapImpl } {
    const build = ({ meta, bytes }: TerrainBytes) =>
      new GameMapImpl(
        meta.width,
        meta.height,
        bytes.slice(),
        meta.num_land_tiles,
      );
    return { gameMap: build(this.main), miniGameMap: build(this.mini) };
  }
}

/**
 * An independent copy of a game, for simulating ahead. It shares nothing with
 * the game it was forked from: stepping it never affects the real game.
 *
 * Other players' future intents are unknowable, so a fork only simulates
 * what is already in motion (attacks, boats, nukes, the AI's own decisions,
 * which are part of the simulation) plus the intents you give it.
 *
 * Two ways to make one:
 * - `new GameFork(source, snapshot, terrain, ...)` restores snapshot bytes of
 *   `source` onto fresh maps from `terrain`;
 * - `GameFork.clone(source, ...)` and `ForkSource` copy `source` directly
 *   (a structural clone, src/core/snapshot/GameClone.ts), several times
 *   faster on large maps, with no TerrainSource.
 * Both give the snapshot's game and stay identical to `source` stepped with
 * the same intents; with water nukes only the clone does (it keeps the
 * game's own water graph, GameClone.ts).
 *
 * Intents the agent sent before forking that have not run yet belong in the
 * fork's steps too (`replay`); forks made from a fork (`source`, `clones`)
 * carry those still queued.
 */
export class GameFork {
  private lastError: ErrorUpdate | null = null;
  private turnNumber: number;
  private readonly runner: GameRunner;
  /** Intents sent as this agent ahead of a coming step, by turn (replay). */
  private readonly pending = new Map<number, AgentIntent[]>();
  /** Steps run so far (GameFork.prototype.step). */
  private stepsRun = 0;

  /** Restores `snapshot`, taken of `source` at its current tick. */
  constructor(
    source: Game,
    snapshot: Uint8Array,
    terrain: TerrainSource,
    gameStart: GameStartInfo,
    clientID: ClientID,
  );
  /** Wraps `game`, already a copy of `source` (see ForkSource). */
  constructor(
    source: Game,
    game: Game,
    terrain: null,
    gameStart: GameStartInfo,
    clientID: ClientID,
  );
  constructor(
    source: Game,
    snapshot: Uint8Array | Game,
    terrain: TerrainSource | null,
    private readonly gameStart: GameStartInfo,
    private readonly clientID: ClientID,
  ) {
    const game =
      snapshot instanceof Uint8Array
        ? restoreGame(snapshot, {
            config: forkConfig(gameStart),
            ...terrain!.freshMaps(),
            teamGameSpawnAreas: terrain!.teamGameSpawnAreas,
          })
        : snapshot;
    this.runner = new GameRunner(
      game,
      new Executor(
        game,
        gameStart.gameID,
        clientID,
        gameStart.tribes?.map((t) => t.name),
      ),
      (gu: GameUpdateViewData | ErrorUpdate) => {
        if ("errMsg" in gu) this.lastError = gu;
      },
    );
    this.turnNumber = source.ticks();
  }

  /** One fork of `source` at its current tick, by structural clone. */
  static clone(
    source: Game,
    gameStart: GameStartInfo,
    clientID: ClientID,
  ): GameFork {
    return new ForkSource(source, gameStart, clientID).fork();
  }

  get game(): Game {
    return this.runner.game;
  }

  /**
   * Forks of this fork as it is now, from one take of its state: a
   * ForkSource (by structural clone) on the fork's game, whose forks also
   * get the intents still queued here (`replay`). The fork itself can then
   * step on; forks are made before it does (ForkSource checks). Use it to
   * branch a rollout, or to clone a fork that ctx.fork() made.
   *
   * Throws if `step` was replaced on this fork and it has not stepped yet:
   * what the replacement would add to its first step (the way Lookahead.fork
   * used to replay intents) cannot be carried into other forks; queue such
   * intents with `replay`.
   */
  source(): ForkSource {
    if (
      this.stepsRun === 0 &&
      Object.prototype.hasOwnProperty.call(this, "step")
    ) {
      throw new Error(
        "GameFork.source: step() is replaced on this fork, which has not stepped yet; " +
          "forks made from it would miss what the replacement adds (use GameFork.replay)",
      );
    }
    return new ForkSource(
      this.game,
      this.gameStart,
      this.clientID,
      this.pending,
    );
  }

  /** `n` independent forks of this fork as it is now (see `source`). */
  clones(n: number): GameFork[] {
    return this.source().forks(n);
  }

  /**
   * Queues `intents`, sent as this agent, ahead of whatever the step that
   * runs `turn` is given; by default the next step. For intents in flight
   * at the fork: sent on the live tick the fork was made at (or earlier)
   * and not run yet, which at the arena's latency of 1 run in the fork's
   * first step. Forks made from this one carry what is still queued.
   */
  replay(intents: readonly AgentIntent[], turn = this.turnNumber): void {
    if (turn < this.turnNumber) {
      throw new Error(
        `GameFork.replay: turn ${turn} already ran (next is ${this.turnNumber})`,
      );
    }
    if (intents.length === 0) return;
    const list = this.pending.get(turn) ?? [];
    list.push(...intents);
    this.pending.set(turn, list);
  }

  /** The intents queued by `replay`, by turn, in turn order. */
  queued(): ReadonlyMap<number, readonly AgentIntent[]> {
    return new Map(
      [...this.pending].sort(([a], [b]) => a - b).map(([t, l]) => [t, [...l]]),
    );
  }

  /**
   * Executes one tick. `mine` are sent as this agent, after what `replay`
   * queued for this turn; `others` must already carry their sender's
   * clientID.
   */
  step(mine: AgentIntent[] = [], others: StampedIntent[] = []): void {
    const turn = this.turnNumber++;
    const queued = this.pending.get(turn) ?? [];
    this.pending.delete(turn);
    const intents: StampedIntent[] = [
      ...[...queued, ...mine].map((i) => ({ ...i, clientID: this.clientID })),
      ...others,
    ];
    this.runner.addTurn({ turnNumber: turn, intents });
    this.stepsRun++;
    this.lastError = null;
    if (!this.runner.executeNextTick()) {
      const err = this.lastError as ErrorUpdate | null;
      throw new Error(
        `fork tick ${this.game.ticks()} failed: ${err?.errMsg ?? "unknown"}`,
      );
    }
  }

  /** Executes `ticks` ticks with no new intents. */
  advance(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }
}

/** A fork's Config, as a restore of the game's snapshot would make it. */
function forkConfig(gameStart: GameStartInfo) {
  return (gc: GameConfig) => new Config(gc, null, false, gameStart.listed);
}

/**
 * Forks of one game at one tick: the game's state is taken once (its
 * snapshot records), and each fork is a structural clone of it, the game a
 * restore of its snapshot gives (GameClone.ts). Forks share nothing with
 * each other or with the game.
 *
 * Every fork must be made before the game ticks again, or has its territory
 * or water changed (`fork()` throws otherwise); forks can be stepped in
 * between. To fork the same state later, keep a fork unstepped and make a
 * ForkSource of it (GameFork.source).
 */
export class ForkSource {
  private readonly source: GameCloneSource;
  private readonly pending: ReadonlyMap<number, readonly AgentIntent[]>;

  /** `pending`: intents each fork gets queued, by turn (GameFork.replay). */
  constructor(
    private readonly game: Game,
    private readonly gameStart: GameStartInfo,
    private readonly clientID: ClientID,
    pending: ReadonlyMap<number, readonly AgentIntent[]> = new Map(),
  ) {
    this.source = GameCloneSource.take(game);
    this.pending = new Map([...pending].map(([t, l]) => [t, [...l]]));
  }

  /** The tick the forks start at. */
  ticks(): number {
    return this.source.ticks();
  }

  fork(): GameFork {
    const game = this.source.clone({ config: forkConfig(this.gameStart) });
    const f = new GameFork(
      this.game,
      game,
      null,
      this.gameStart,
      this.clientID,
    );
    for (const [turn, intents] of this.pending) f.replay(intents, turn);
    return f;
  }

  forks(n: number): GameFork[] {
    return Array.from({ length: n }, () => this.fork());
  }
}

/** `n` independent forks of `game` at its current tick: one take of its
 *  state, cloned `n` times (see ForkSource). */
export function forkMany(
  game: Game,
  gameStart: GameStartInfo,
  clientID: ClientID,
  n: number,
): GameFork[] {
  return new ForkSource(game, gameStart, clientID).forks(n);
}
