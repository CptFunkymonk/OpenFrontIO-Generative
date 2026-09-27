import path from "path";
import type { AgentIntent } from "../../../src/agent/Agent";
import { AgentHost } from "../../../src/agent/AgentHost";
import { createAgent } from "../../../src/agent/agents";
import {
  BROWSER_SPAWN_WALL_MS,
  isBrowserSpawn,
  RESEND_TICKS,
  rolloutPool,
  spawnTick,
} from "../../../src/agent/agents/apex/controllers/SpawnController";
import {
  APEX_DEFAULTS,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import {
  ArenaGameSpec,
  arenaGameStart,
  seatClientID,
} from "../../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../../src/agent/arena/NodeMapLoader";
import { TerrainSource } from "../../../src/agent/Fork";
import {
  buildRaceGrid,
  MIN_DISC_FREE,
  SpawnCandidate,
  spawnCandidates,
  spawnDiscFree,
  staticArrival,
} from "../../../src/agent/lib/RaceField";
import { planSpawn } from "../../../src/agent/lib/SpawnPlanner";
import { getSpawnTiles } from "../../../src/core/execution/Util";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameType,
  Player,
  PlayerType,
} from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import { createGameRunner, GameRunner } from "../../../src/core/GameRunner";
import { StampedIntent } from "../../../src/core/Schemas";

// SpawnController (spec §3.2, §3.2.6-3.2.7; build steps 1, 4 and 8). The
// games are the arena's (arenaGameStart → createGameRunner: FFA
// singleplayer, Impossible, the map's nations, 400 tribes), and the agent
// runs in a real AgentHost with the arena's turn plumbing (latency 1: an
// intent sent at ctx.tick T goes into turn T, ArenaGame.ts). Tests may
// mutate the game (to take a disc away); the agent never does.
//
// The spawn preview (package A3, on by default; SpawnPreview.test.ts) plans
// at the first call, tick 1, and sends there when an erasure site verifies.
// The tests of the spawn planned and sent at spawnDelay pin it off
// (NO_PREVIEW); the browser tests need not, since the preview never runs
// in the browser.

const MAPS = path.join(__dirname, "../../../resources/maps");
const ME = seatClientID(0);
const TIMEOUT = 180_000;
/** Apex's spawn without package A3: planned and sent at spawnDelay. */
const NO_PREVIEW = { spawnPreview: false, spawnErase: false };

interface Sent {
  tick: number;
  intent: AgentIntent;
}

interface Run {
  runner: GameRunner;
  game: Game;
  me: Player;
  host: AgentHost;
  sent: Sent[];
  /** Executes the next turn; then, unless `agent` is false, the agent's
   *  tick. */
  step(agent?: boolean): void;
  spawns(): Sent[];
}

async function start(
  map: GameMapType,
  options: Record<string, unknown>,
  gameID = "SPAWNCTL",
): Promise<Run> {
  const spec = {
    gameID,
    map,
    mapSize: GameMapSize.Normal,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Impossible,
    nations: "default",
    bots: 400,
    seats: [{ agent: "apex", options }],
  } as unknown as ArenaGameSpec;
  const gameStart = arenaGameStart(spec);
  const loader = new NodeMapLoader(MAPS);
  const runner = await createGameRunner(gameStart, undefined, loader, (gu) => {
    if ("errMsg" in gu) throw new Error(gu.errMsg);
  });
  const terrain = await TerrainSource.load(loader, map, GameMapSize.Normal);
  const game = runner.game;
  const queue = new Map<number, StampedIntent[]>();
  const sent: Sent[] = [];
  let executed = 0;
  const host = new AgentHost({
    agent: createAgent("apex", options),
    clientID: ME,
    gameStart,
    runner,
    terrain,
    deliver: (intent) => {
      // ArenaGame's deliver at latency 1: the next turn to execute.
      const list = queue.get(executed) ?? [];
      list.push({ ...intent, clientID: ME } as StampedIntent);
      queue.set(executed, list);
      sent.push({ tick: game.ticks(), intent });
    },
    nowMs: () => game.ticks() * 100,
    strict: true,
  });
  const me = game.playerByClientID(ME)!;
  return {
    runner,
    game,
    me,
    host,
    sent,
    step(agent = true) {
      runner.addTurn({
        turnNumber: executed,
        intents: queue.get(executed) ?? [],
      });
      queue.delete(executed);
      if (!runner.executeNextTick()) throw new Error(`turn ${executed}`);
      executed++;
      if (agent) host.tick();
    },
    spawns: () => sent.filter((s) => s.intent.type === "spawn"),
  };
}

/** Steps (with the agent) until game.ticks() === tick. */
function stepTo(r: Run, tick: number, agent = true): void {
  while (r.game.ticks() < tick) r.step(agent);
}

function spawnTile(s: Sent): TileRef {
  if (s.intent.type !== "spawn") throw new Error("not a spawn");
  return s.intent.tile;
}

/** The race candidates on the game as it is now (what mode race plans on). */
function raceCandidates(game: Game, me: Player): SpawnCandidate[] {
  const o = APEX_DEFAULTS;
  const grid = buildRaceGrid(game, o);
  return spawnCandidates(grid, staticArrival(grid, game, o), game, me, o);
}

beforeAll(() => {
  console.debug = () => {};
  console.warn = () => {};
});

describe("helpers", () => {
  test("spawn tick, browser signal, rollout pool", () => {
    expect(isBrowserSpawn(APEX_DEFAULTS)).toBe(false);
    expect(
      isBrowserSpawn(
        parseApexOptions({ spawnWallBudgetMs: BROWSER_SPAWN_WALL_MS }),
      ),
    ).toBe(true);
    const c = (score: number, source: SpawnCandidate["source"]) =>
      ({ tile: score, source, score }) as unknown as SpawnCandidate;
    const cands = [
      c(9, "race"),
      c(8, "snack"),
      c(7, "race"),
      c(6, "island"),
      c(5, "planSpawn"),
      c(4, "race"),
    ];
    expect(rolloutPool(cands, 2).map((x) => x.score)).toEqual([9, 8, 6, 5]);
    expect(rolloutPool(cands, 5).map((x) => x.score)).toEqual([9, 8, 7, 6, 5]);
  });
});

describe("mode race (default), without the preview", () => {
  // Race candidates beat planSpawn's tile on the race score on 16 of 20
  // maps surveyed at tick 3 (World ×7.2, Japan ×2.5, Alps ×1.2); on Europe
  // (0.93), Mena (0.90), Asia (0.94) and ArchipelagoSea (0.98) planSpawn's
  // site (or the snack variant) scores higher, and since it is always a
  // candidate the controller spawns there: the choice is never below
  // planSpawn's on the race score.
  test.each([
    [GameMapType.World, true],
    [GameMapType.Alps, true],
    [GameMapType.Japan, true],
    [GameMapType.Europe, false],
  ])(
    "%s: sent at tick spawnDelay on the best candidate; race beats planSpawn: %s",
    async (map, raceWins) => {
      const r = await start(map, NO_PREVIEW);
      expect(spawnTick(r.game, APEX_DEFAULTS)).toBe(APEX_DEFAULTS.spawnDelay);
      stepTo(r, APEX_DEFAULTS.spawnDelay - 1);
      expect(r.spawns()).toHaveLength(0);
      // The state the agent plans on at ctx.tick = spawnDelay.
      r.step(false);
      const cands = raceCandidates(r.game, r.me);
      r.host.tick();
      expect(r.host.stats.errors).toBe(0);
      const spawns = r.spawns();
      expect(spawns).toHaveLength(1);
      expect(spawns[0].tick).toBe(APEX_DEFAULTS.spawnDelay);
      expect(spawnTile(spawns[0])).toBe(cands[0].tile);

      const plan = cands.find((c) => c.source === "planSpawn")!;
      const race = cands.find((c) => c.source === "race")!;
      console.log(
        `${map}: race best A ${race.free} B ${race.pie} threat ${race.threat} ` +
          `score ${race.score.toFixed(0)}; planSpawn A ${plan.free} B ` +
          `${plan.pie} threat ${plan.threat} score ${plan.score.toFixed(0)}`,
      );
      expect(cands[0].score).toBeGreaterThanOrEqual(plan.score);
      if (raceWins) expect(race.score).toBeGreaterThan(plan.score);
      else expect(cands[0].source).toBe("planSpawn");

      // It lands in the next tick and ends the phase; nothing is resent.
      stepTo(r, APEX_DEFAULTS.spawnDelay + RESEND_TICKS + 5);
      expect(r.me.hasSpawned()).toBe(true);
      expect(r.me.spawnTile()).toBe(cands[0].tile);
      expect(r.game.inSpawnPhase()).toBe(false);
      expect(r.spawns()).toHaveLength(1);
    },
    TIMEOUT,
  );
});

describe("mode plan", () => {
  test(
    "World: planSpawn's tile, sent at tick spawnDelay",
    async () => {
      const r = await start(GameMapType.World, {
        ...NO_PREVIEW,
        spawnMode: "plan",
      });
      stepTo(r, APEX_DEFAULTS.spawnDelay, false);
      const want = planSpawn(r.game, r.me);
      r.host.tick();
      const spawns = r.spawns();
      expect(spawns).toHaveLength(1);
      expect(spawns[0].tick).toBe(APEX_DEFAULTS.spawnDelay);
      expect(spawnTile(spawns[0])).toBe(want);
      stepTo(r, APEX_DEFAULTS.spawnDelay + 3);
      expect(r.me.hasSpawned()).toBe(true);
      expect(r.host.logs.some((l) => l.includes("spawn (plan)"))).toBe(true);
    },
    TIMEOUT,
  );
});

describe("failure modes (§3.2.7)", () => {
  test(
    "a disc taken before the spawn lands: resent RESEND_TICKS later on the next candidate whose disc is free",
    async () => {
      const r = await start(GameMapType.World, NO_PREVIEW);
      stepTo(r, APEX_DEFAULTS.spawnDelay, false);
      const cands = raceCandidates(r.game, r.me);
      r.host.tick();
      const first = spawnTile(r.spawns()[0]);
      expect(first).toBe(cands[0].tile);

      // A tribe takes the whole disc before turn spawnDelay runs: the spawn
      // finds no free tile and fails silently, the phase stays open
      // [PIN SpawnPhaseSingleplayer]. And the second candidate's disc is cut
      // below MIN_DISC_FREE, so the resend skips it too.
      const tribe = r.game.players().find((p) => p.type() === PlayerType.Bot)!;
      for (const t of getSpawnTiles(r.game, first, false)) tribe.conquer(t);
      const second = cands[1].tile;
      const cut = getSpawnTiles(r.game, second, false);
      for (const t of cut.slice(0, cut.length - MIN_DISC_FREE + 1)) {
        tribe.conquer(t);
      }
      expect(spawnDiscFree(r.game, second)).toBeLessThan(MIN_DISC_FREE);
      const want = cands
        .slice(2)
        .find((c) => spawnDiscFree(r.game, c.tile) >= MIN_DISC_FREE)!.tile;

      const resendAt = APEX_DEFAULTS.spawnDelay + RESEND_TICKS;
      stepTo(r, resendAt - 1);
      expect(r.me.hasSpawned()).toBe(false);
      expect(r.game.inSpawnPhase()).toBe(true);
      expect(r.spawns()).toHaveLength(1);
      r.step();
      const spawns = r.spawns();
      expect(spawns).toHaveLength(2);
      expect(spawns[1].tick).toBe(resendAt);
      expect(spawnTile(spawns[1])).toBe(want);
      stepTo(r, resendAt + 3);
      expect(r.me.hasSpawned()).toBe(true);
      expect(r.me.spawnTile()).toBe(want);
      expect(r.game.inSpawnPhase()).toBe(false);
      expect(r.host.stats.errors).toBe(0);
    },
    TIMEOUT,
  );
});

describe("browser: plan at T*, send at T* − 1 (§3.2.6)", () => {
  const o = { spawnWallBudgetMs: BROWSER_SPAWN_WALL_MS };
  // W = 1 s for race: T* = spawnDelay + 10 + 20.
  const tStar = APEX_DEFAULTS.spawnDelay + 10 + 20;

  test(
    "World: planned on the fork at T*, which is the real game at T*",
    async () => {
      const r = await start(GameMapType.World, o);
      stepTo(r, tStar - 2);
      expect(r.spawns()).toHaveLength(0);
      r.step();
      const spawns = r.spawns();
      expect(spawns).toHaveLength(1);
      expect(spawns[0].tick).toBe(tStar - 1);
      // Nations hop in the fork exactly as in the game: the plan equals the
      // candidates of a second copy of the game stepped to T* untouched.
      const twin = await start(GameMapType.World, o);
      stepTo(twin, tStar, false);
      expect(spawnTile(spawns[0])).toBe(
        raceCandidates(twin.game, twin.me)[0].tile,
      );
      stepTo(r, tStar + 3);
      expect(r.me.hasSpawned()).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "a replica past T* sends at once",
    async () => {
      const r = await start(GameMapType.World, o);
      stepTo(r, APEX_DEFAULTS.spawnDelay); // plans at spawnDelay
      expect(r.spawns()).toHaveLength(0);
      stepTo(r, tStar + 20, false); // the replica catches up in one batch
      r.host.tick();
      const spawns = r.spawns();
      expect(spawns).toHaveLength(1);
      expect(spawns[0].tick).toBe(tStar + 20);
    },
    TIMEOUT,
  );
});

describe("lookahead modes (§3.2.2, §3.2.5)", () => {
  test(
    "idle: arrival from the idle fork; sent at spawnDelay; the live game is only touched by our spawn",
    async () => {
      const r = await start(GameMapType.Pangaea, {
        ...NO_PREVIEW,
        spawnMode: "idle",
        spawnIdleTicks: 300,
      });
      stepTo(r, APEX_DEFAULTS.spawnDelay);
      const spawns = r.spawns();
      expect(spawns).toHaveLength(1);
      expect(spawns[0].tick).toBe(APEX_DEFAULTS.spawnDelay);
      expect(r.host.stats.forks).toBe(1);
      expect(r.host.logs.some((l) => l.includes("spawn (idle)"))).toBe(true);
      expect(r.game.ticks()).toBe(APEX_DEFAULTS.spawnDelay);
      stepTo(r, APEX_DEFAULTS.spawnDelay + 3);
      expect(r.me.hasSpawned()).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "rollout: successive halving picks the round-2 run with most tiles; deterministic",
    async () => {
      const o = {
        ...NO_PREVIEW,
        spawnMode: "rollout",
        spawnRolloutK: 2,
        spawnKeep: 2,
        spawnRound1: 30,
        spawnFinal: 60,
      };
      const tiles: TileRef[] = [];
      for (let run = 0; run < 2; run++) {
        const r = await start(GameMapType.Pangaea, o);
        stepTo(r, APEX_DEFAULTS.spawnDelay);
        expect(r.host.stats.errors).toBe(0);
        const spawns = r.spawns();
        expect(spawns).toHaveLength(1);
        expect(spawns[0].tick).toBe(APEX_DEFAULTS.spawnDelay);
        const logs = r.host.logs;
        expect(logs.some((l) => l.includes("spawn (rollout)"))).toBe(true);
        // One fork per rolled-out candidate: K plus planSpawn's and islands.
        const r1 = logs.filter((l) => l.includes("rollout r1"));
        const r2 = logs.filter((l) => l.includes("rollout r2"));
        expect(r1.length).toBe(r.host.stats.forks);
        expect(r1.length).toBeGreaterThanOrEqual(2);
        expect(r2.length).toBe(Math.min(2, r1.length));
        // The winner: most tiles at spawnFinal.
        const tilesOf = (l: string) => Number(/tiles (\d+)/.exec(l)![1]);
        const best = r2.reduce((a, b) => (tilesOf(b) > tilesOf(a) ? b : a));
        const at = /at (\d+),(\d+)/.exec(best)!;
        const tile = spawnTile(spawns[0]);
        expect(`${r.game.x(tile)},${r.game.y(tile)}`).toBe(`${at[1]},${at[2]}`);
        tiles.push(tile);
      }
      expect(tiles[0]).toBe(tiles[1]);
    },
    TIMEOUT,
  );
});
