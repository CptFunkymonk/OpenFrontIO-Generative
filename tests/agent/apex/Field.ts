import {
  AgentContext,
  AgentIntent,
  SendResult,
} from "../../../src/agent/Agent";
import { IntentBudget } from "../../../src/agent/IntentBudget";
import { Config } from "../../../src/core/configuration/Config";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Player,
  PlayerInfo,
  PlayerType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { TileRef } from "../../../src/core/game/GameMap";
import { genTerrainFromBin } from "../../../src/core/game/TerrainMapLoader";
import { UserSettings } from "../../../src/core/game/UserSettings";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import { GameConfig, IntentSchema } from "../../../src/core/Schemas";

// Synthetic fields for the apex allocator tests, built the way the pins
// build theirs (tests/agent/mechanics/*: the real Config, createGame,
// endSpawnPhase; intents through IntentSchema and Executor.createExec, the
// path of ctx.send). Tests may set troops and tiles directly; agents may not.

export const AGENT_CLIENT = "AGENTCL1";
export const AGENT_ID = "AGENTID1";
export const GAME_ID = "apexfield";

/** The arena's setting (tests/agent/mechanics/FreeLandCost.test.ts). */
export const GAME_CONFIG: GameConfig = {
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

/** "water" is ocean; "lake" is water without the ocean bit. */
export type Terrain = "plains" | "highland" | "mountain" | "water" | "lake";

/** Terrain bytes (GameMap.ts:127-129): bit 7 land, 6 shoreline, 5 ocean,
 *  low 5 bits the magnitude (plains < 10, highland < 20, mountain < 31). */
const MAGNITUDE: Record<Exclude<Terrain, "water" | "lake">, number> = {
  plains: 5,
  highland: 15,
  mountain: 25,
};
const LAND = 0x80;
const SHORELINE = 0x40;
const OCEAN = 0x20;

function terrainBytes(
  w: number,
  h: number,
  at: (x: number, y: number) => Terrain,
): { data: Uint8Array; land: number } {
  const data = new Uint8Array(w * h);
  let land = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = at(x, y);
      if (t === "water") data[y * w + x] = OCEAN;
      else if (t === "lake") data[y * w + x] = 0;
      else {
        data[y * w + x] = LAND | MAGNITUDE[t];
        land++;
      }
    }
  }
  // Shoreline: land next to water and water next to land.
  const isLand = (i: number) => (data[i] & LAND) !== 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const n = [
        x > 0 ? i - 1 : -1,
        x < w - 1 ? i + 1 : -1,
        y > 0 ? i - w : -1,
        y < h - 1 ? i + w : -1,
      ];
      if (n.some((j) => j >= 0 && isLand(j) !== isLand(i))) {
        data[i] |= SHORELINE;
      }
    }
  }
  return { data, land };
}

export interface Field {
  game: Game;
  config: Config;
  me: Player;
  executor: Executor;
}

export interface FieldOptions {
  width: number;
  height: number;
  /** Default: plains everywhere. */
  terrain?: (x: number, y: number) => Terrain;
  /** Default: the real Config. */
  ConfigClass?: typeof Config;
}

/** A field with the agent (a Human, nothing owned yet), spawn phase over. */
export async function field(o: FieldOptions): Promise<Field> {
  const at = o.terrain ?? (() => "plains" as const);
  const big = terrainBytes(o.width, o.height, at);
  const mw = Math.ceil(o.width / 2);
  const mh = Math.ceil(o.height / 2);
  const mini = terrainBytes(mw, mh, (x, y) => at(2 * x, 2 * y));
  const map = await genTerrainFromBin(
    { width: o.width, height: o.height, num_land_tiles: big.land },
    big.data,
  );
  const miniMap = await genTerrainFromBin(
    { width: mw, height: mh, num_land_tiles: mini.land },
    mini.data,
  );
  const ConfigClass = o.ConfigClass ?? Config;
  const config = new ConfigClass(GAME_CONFIG, new UserSettings(), false);
  const game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    [],
    map,
    miniMap,
    config,
  );
  game.endSpawnPhase();
  return {
    game,
    config,
    me: game.player(AGENT_ID),
    executor: new Executor(game, GAME_ID, undefined),
  };
}

/** Tiles of the rectangle [x0, x1) × [y0, y1). */
export function rect(
  game: Game,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): TileRef[] {
  const out: TileRef[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) out.push(game.ref(x, y));
  }
  return out;
}

/** Gives `p` these tiles. */
export function own(p: Player, tiles: Iterable<TileRef>): void {
  for (const t of tiles) p.conquer(t);
}

/** A tribe (PlayerType.Bot) on these tiles with these troops; with
 *  `execution` it regrows and runs its cluster checks (PlayerExecution),
 *  as SpawnExecution gives every player. It never attacks: no
 *  TribeExecution. */
export function addTribe(
  f: Field,
  id: string,
  tiles: Iterable<TileRef>,
  troops: number,
  execution = true,
): Player {
  const p = f.game.addPlayer(new PlayerInfo(id, PlayerType.Bot, null, id));
  own(p, tiles);
  p.setTroops(troops);
  if (execution) f.game.addExecution(new PlayerExecution(p));
  return p;
}

/** The agent's path for one intent: IntentSchema (AgentHost.isValid), then
 *  Executor.createExec. It inits at the end of the next executeNextTick. */
export function submit(f: Field, intent: AgentIntent): void {
  const parsed = IntentSchema.safeParse({ ...intent, clientID: AGENT_CLIENT });
  if (!parsed.success) throw new Error(`invalid intent: ${parsed.error}`);
  f.game.addExecution(
    f.executor.createExec({ ...intent, clientID: AGENT_CLIENT }),
  );
}

/**
 * Runs an agent-like `tick(ctx)` on the field as the arena does at latency
 * 1: after each executed turn the agent reads the state at ctx.tick =
 * game.ticks(), and what it sends goes into the next turn. The rate limiter
 * is the host's IntentBudget on the game clock (tick × msPerTick).
 */
export class Harness {
  readonly sentLog: { tick: number; intent: AgentIntent }[] = [];
  readonly logs: string[] = [];
  private readonly budget: IntentBudget;
  private readonly random = new PseudoRandom(1);
  private pending: AgentIntent[] = [];

  constructor(
    readonly f: Field,
    private readonly tickFn: (ctx: AgentContext) => void,
  ) {
    const ms = f.game.config().msPerTick();
    this.budget = new IntentBudget(() => f.game.ticks() * ms, true);
  }

  /** The context of the current tick; `onSend` sees each accepted intent
   *  before it is queued. */
  context(onSend?: (i: AgentIntent) => void): AgentContext {
    const { game, me } = this.f;
    return {
      game,
      clientID: AGENT_CLIENT,
      gameID: GAME_ID,
      me,
      tick: game.ticks(),
      random: this.random,
      send: (intent: AgentIntent): SendResult => {
        if (
          !IntentSchema.safeParse({ ...intent, clientID: AGENT_CLIENT }).success
        ) {
          return "invalid";
        }
        if (!this.budget.tryConsume()) return "rate_limited";
        onSend?.(intent);
        this.pending.push(intent);
        this.sentLog.push({ tick: game.ticks(), intent });
        return "ok";
      },
      budget: () => this.budget.remaining(),
      fork: () => {
        throw new Error("no forks in the Harness");
      },
      log: (m: string) => {
        this.logs.push(`[${game.ticks()}] ${m}`);
      },
    };
  }

  /** One agent tick, then one executed turn carrying what it sent. Returns
   *  the intents of that tick. */
  step(onSend?: (i: AgentIntent) => void): AgentIntent[] {
    this.tickFn(this.context(onSend));
    const sent = this.pending;
    this.pending = [];
    for (const i of sent) submit(this.f, i);
    this.f.game.executeNextTick();
    return sent;
  }
}
