import path from "path";
import { Agent } from "../../../src/agent/Agent";
import { AgentHost } from "../../../src/agent/AgentHost";
import { parseApexOptions } from "../../../src/agent/agents/apex/options";
import { ApexPolicy, LiveSearch } from "../../../src/agent/agents/apex/policy";
import { ApexState, createState } from "../../../src/agent/agents/apex/state";
import {
  arenaGameStart,
  seatClientID,
  type ArenaGameSpec,
} from "../../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../../src/agent/arena/NodeMapLoader";
import { TerrainSource } from "../../../src/agent/Fork";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameType,
} from "../../../src/core/game/Game";
import { createGameRunner, GameRunner } from "../../../src/core/GameRunner";
import { GameStartInfo, StampedIntent } from "../../../src/core/Schemas";

// One apex seat in an arena game, built as the arena builds it
// (arenaGameStart -> createGameRunner, NodeMapLoader on resources/maps,
// Normal size, the map's default nations and 400 tribes at Impossible, the
// seat's intents queued by turn with runArenaGame's latency rule, the rate
// limiter on game time), with the ApexPolicy in the test's hands. Tick
// bookkeeping as tests/agent/ForkFidelity.test.ts pins it: turn i runs in
// tick i, after it game.ticks() is i + 1, and the agent acts on it then; an
// intent it sends goes into turn i + latency.

const MAPS = path.join(__dirname, "../../../resources/maps");
export const ME = seatClientID(0);

export interface ApexArena {
  gameStart: GameStartInfo;
  runner: GameRunner;
  game: Game;
  host: AgentHost;
  policy: ApexPolicy;
  state: ApexState;
  /** Runs the next turn and returns its intents; the agent does not act. */
  runTurn(): StampedIntent[];
  /** The agent acts on the tick that just ran. */
  act(): void;
  /** Plays `ticks` turns, the agent acting after each. */
  play(ticks: number): void;
  /** Plays until game.ticks() is `tick` after a turn, the agent not yet
   *  acting on it: the start of live tick `tick`. */
  playTo(tick: number): void;
  /** Intents queued for turns that have not run yet. */
  inFlight(): StampedIntent[];
}

export async function apexArena(opts: {
  gameID: string;
  map: GameMapType;
  options?: Record<string, unknown>;
  search?: LiveSearch;
  latencyTicks?: number;
}): Promise<ApexArena> {
  const latency = Math.max(1, opts.latencyTicks ?? 1);
  const spec: Pick<
    ArenaGameSpec,
    | "gameID"
    | "map"
    | "mapSize"
    | "gameType"
    | "difficulty"
    | "nations"
    | "bots"
    | "seats"
  > = {
    gameID: opts.gameID,
    map: opts.map,
    mapSize: GameMapSize.Normal,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Impossible,
    nations: "default",
    bots: 400,
    seats: [{ agent: "apex" }],
  };
  const gameStart = arenaGameStart(spec as ArenaGameSpec);
  const loader = new NodeMapLoader(MAPS);
  let fatal: string | null = null;
  const runner = await createGameRunner(gameStart, undefined, loader, (gu) => {
    if ("errMsg" in gu) fatal ??= gu.errMsg;
  });
  const terrain = await TerrainSource.load(
    loader,
    opts.map,
    GameMapSize.Normal,
  );
  const game = runner.game;
  const state = createState();
  const policy = new ApexPolicy(
    parseApexOptions(opts.options),
    state,
    opts.search ?? null,
  );
  const agent: Agent = {
    name: "apex",
    tick: (ctx) => policy.tick(ctx),
    gameOver: (ctx, outcome) => policy.gameOver(ctx, outcome),
  };
  const queue = new Map<number, StampedIntent[]>();
  let executed = 0;
  const host = new AgentHost({
    agent,
    clientID: ME,
    gameStart,
    runner,
    terrain,
    deliver: (intent) => {
      const turn = executed - 1 + latency;
      const list = queue.get(turn) ?? [];
      list.push({ ...intent, clientID: ME });
      queue.set(turn, list);
    },
    nowMs: () => game.ticks() * 100,
    strict: true,
  });
  const arena: ApexArena = {
    gameStart,
    runner,
    game,
    host,
    policy,
    state,
    runTurn() {
      const intents = queue.get(executed) ?? [];
      queue.delete(executed);
      runner.addTurn({ turnNumber: executed, intents });
      if (!runner.executeNextTick() || fatal !== null) {
        throw new Error(fatal ?? `tick ${game.ticks()} did not execute`);
      }
      executed++;
      return intents;
    },
    act() {
      host.tick();
    },
    play(ticks) {
      for (let i = 0; i < ticks; i++) {
        arena.runTurn();
        arena.act();
      }
    },
    playTo(tick) {
      if (game.ticks() >= tick) {
        throw new Error(`playTo(${tick}) at tick ${game.ticks()}`);
      }
      while (game.ticks() < tick - 1) {
        arena.runTurn();
        arena.act();
      }
      arena.runTurn();
    },
    inFlight() {
      return [...queue.keys()]
        .filter((turn) => turn >= executed)
        .sort((a, b) => a - b)
        .flatMap((turn) => queue.get(turn)!);
    },
  };
  return arena;
}

/** game.hash() (troops and tiles per player, unit ids, types and tiles;
 *  GameImpl.hash, private there). */
export function gameHash(game: Game): number {
  return (game as unknown as { hash(): number }).hash();
}
