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
import { ClientID, GameStartInfo, StampedIntent } from "../core/Schemas";
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
 */
export class GameFork {
  private lastError: ErrorUpdate | null = null;
  private turnNumber: number;
  private readonly runner: GameRunner;

  constructor(
    source: Game,
    snapshot: Uint8Array,
    terrain: TerrainSource,
    gameStart: GameStartInfo,
    private readonly clientID: ClientID,
  ) {
    const game = restoreGame(snapshot, {
      config: (gc) => new Config(gc, null, false, gameStart.listed),
      ...terrain.freshMaps(),
      teamGameSpawnAreas: terrain.teamGameSpawnAreas,
    });
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

  get game(): Game {
    return this.runner.game;
  }

  /**
   * Executes one tick. `mine` are sent as this agent; `others` must already
   * carry their sender's clientID.
   */
  step(mine: AgentIntent[] = [], others: StampedIntent[] = []): void {
    const intents: StampedIntent[] = [
      ...mine.map((i) => ({ ...i, clientID: this.clientID })),
      ...others,
    ];
    this.runner.addTurn({ turnNumber: this.turnNumber++, intents });
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
