import { Agent, AgentIntent, SendResult } from "../../src/agent/Agent";
import { AgentHost, AgentHostOptions } from "../../src/agent/AgentHost";
import { TerrainSource } from "../../src/agent/Fork";
import { planSpawn } from "../../src/agent/lib/SpawnPlanner";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import { createGameRunner, GameRunner } from "../../src/core/GameRunner";
import { GameStartInfo } from "../../src/core/Schemas";
import { TestDataMapLoader } from "../util/ScriptedGame";

const CID = "AGENT000";

const gameStart: GameStartInfo = {
  gameID: "HOSTTEST",
  lobbyCreatedAt: 0,
  config: {
    gameMap: GameMapType.World,
    gameMapSize: GameMapSize.Compact,
    gameMode: GameMode.FFA,
    gameType: GameType.Private,
    difficulty: Difficulty.Hard,
    nations: 3,
    bots: 5,
    donateGold: false,
    donateTroops: false,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
  },
  players: [{ clientID: CID, username: "tester", clanTag: null }],
};

function hash(game: Game): number {
  return (game as unknown as { hash(): number }).hash();
}

async function newRunner(): Promise<GameRunner> {
  return createGameRunner(
    gameStart,
    CID,
    new TestDataMapLoader("world"),
    () => {},
  );
}

function step(runner: GameRunner, intents: AgentIntent[] = []): void {
  runner.addTurn({
    turnNumber: runner.game.ticks(),
    intents: intents.map((i) => ({ ...i, clientID: CID })),
  });
  expect(runner.executeNextTick()).toBe(true);
}

function makeHost(
  runner: GameRunner,
  tick: Agent["tick"],
  extra: Partial<AgentHostOptions> = {},
) {
  const delivered: AgentIntent[] = [];
  const host = new AgentHost({
    agent: { name: "test", tick },
    clientID: CID,
    gameStart,
    runner,
    deliver: (i) => delivered.push(i),
    nowMs: () => 0,
    ...extra,
  });
  return { host, delivered };
}

describe("AgentHost", () => {
  let runner: GameRunner;
  beforeAll(async () => {
    console.debug = () => {};
    runner = await newRunner();
    step(runner);
  });

  test("delivers valid intents and rejects forbidden or malformed ones", () => {
    const results: SendResult[] = [];
    const { host, delivered } = makeHost(runner, (ctx) => {
      results.push(ctx.send({ type: "attack", targetID: null, troops: 100 }));
      results.push(
        ctx.send({
          type: "toggle_pause",
          paused: true,
        } as unknown as AgentIntent),
      );
      results.push(ctx.send({ type: "attack", targetID: null, troops: -5 }));
      results.push(ctx.send({ type: "spawn", tile: 1.5 }));
    });
    host.tick();
    expect(results).toEqual(["ok", "invalid", "invalid", "invalid"]);
    expect(delivered).toEqual([
      { type: "attack", targetID: null, troops: 100 },
    ]);
    expect(host.stats.intentsInvalid).toBe(3);
    expect(host.stats.intentsByType).toEqual({ attack: 1 });
  });

  test("enforces the server's intent rate limit", () => {
    const results: SendResult[] = [];
    const { host } = makeHost(runner, (ctx) => {
      for (let i = 0; i < 11; i++) {
        results.push(ctx.send({ type: "embargo_all", action: "start" }));
      }
    });
    host.tick();
    expect(results.filter((r) => r === "ok")).toHaveLength(10);
    expect(results[10]).toBe("rate_limited");
    expect(host.stats.intentsRateLimited).toBe(1);
  });

  test("records agent exceptions, and rethrows them when strict", () => {
    const boom = () => {
      throw new Error("boom");
    };
    const { host } = makeHost(runner, boom);
    expect(() => host.tick()).not.toThrow();
    expect(host.stats.errors).toBe(1);
    expect(host.stats.firstErrors[0]).toContain("boom");

    // Strict counts it too, so the seat's stats agree with the game error.
    const strict = makeHost(runner, boom, { strict: true }).host;
    expect(() => strict.tick()).toThrow("boom");
    expect(strict.stats.errors).toBe(1);
    expect(strict.stats.firstErrors[0]).toContain("boom");
  });

  test("gives the agent its own player before it has spawned", () => {
    let seen = false;
    const { host } = makeHost(runner, (ctx) => {
      seen = ctx.me.clientID() === CID && !ctx.me.hasSpawned();
    });
    host.tick();
    expect(seen).toBe(true);
  });
});

describe("GameFork", () => {
  test("simulates ahead without touching the real game", async () => {
    const runner = await newRunner();
    for (let i = 0; i < 5; i++) step(runner);
    const terrain = await TerrainSource.load(
      new TestDataMapLoader("world"),
      GameMapType.World,
      GameMapSize.Compact,
    );
    const { host } = makeHost(runner, () => {}, { terrain });
    const tick = runner.game.ticks();
    const before = hash(runner.game);
    const me = host.me();
    const spawn = planSpawn(runner.game, me)!;

    const fork = host.fork();
    fork.step([{ type: "spawn", tile: spawn }]);
    fork.advance(30);
    expect(fork.game.ticks()).toBe(tick + 31);
    expect(fork.game.playerByClientID(CID)!.hasSpawned()).toBe(true);

    // The real game is exactly as it was.
    expect(runner.game.ticks()).toBe(tick);
    expect(hash(runner.game)).toBe(before);
    expect(me.hasSpawned()).toBe(false);

    // Forks of the same state are deterministic.
    const again = host.fork();
    again.step([{ type: "spawn", tile: spawn }]);
    again.advance(30);
    expect(hash(again.game)).toBe(hash(fork.game));
    expect(host.stats.forks).toBe(2);
    expect(host.stats.forkMs.count).toBe(2);
  });

  test("reports time inside ctx.fork() apart from think time", async () => {
    const runner = await newRunner();
    step(runner);
    const terrain = await TerrainSource.load(
      new TestDataMapLoader("world"),
      GameMapType.World,
      GameMapSize.Compact,
    );
    const busy = (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end);
    };
    let forks = 2;
    const { host } = makeHost(
      runner,
      (ctx) => {
        busy(5);
        for (; forks > 0; forks--) ctx.fork();
      },
      { terrain },
    );
    const start = performance.now();
    host.tick();
    const wall = performance.now() - start;
    const { forkMs, thinkMs } = host.stats;
    expect(forkMs.count).toBe(2);
    expect(forkMs.total).toBeGreaterThan(0);
    expect(forkMs.max).toBeLessThanOrEqual(forkMs.total);
    expect(forkMs.max * 2).toBeGreaterThanOrEqual(forkMs.total);
    // Think time is what is left: at least the busy wait, and with the fork
    // time no more than the whole tick.
    expect(thinkMs[0]).toBeGreaterThanOrEqual(5);
    expect(thinkMs[0] + forkMs.total).toBeLessThanOrEqual(wall);

    // A tick without a fork takes nothing off.
    host.tick();
    expect(host.stats.forkMs.count).toBe(2);
    expect(thinkMs[1]).toBeGreaterThanOrEqual(5);
  });
});
