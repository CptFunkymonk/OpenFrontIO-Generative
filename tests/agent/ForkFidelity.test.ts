/**
 * Pins roadmap H10 (docs/11-roadmap.md §11.3; tooling backlog §11.7 item 8):
 * in singleplayer against nations and tribes the agent's intents are the only
 * input from outside the simulation, so a fork (ctx.fork(), src/agent/Fork.ts)
 * stepped with the same intents as the real game stays identical to it, tick
 * for tick. Nations' and tribes' decisions are executions inside the
 * simulation, seeded from the game ID, and their state is in the snapshot.
 *
 * The game is built as the arena builds it: arenaGameStart feeds
 * createGameRunner with no clientID, the baseline agent plays through
 * AgentHost (strict), and accepted intents wait in a queue keyed by turn,
 * with runArenaGame's latency rule (src/agent/arena/ArenaGame.ts). Maps come
 * from resources/maps at Normal size, with the map's default nations and 400
 * tribes at Impossible: the arena's defaults.
 *
 * Tick bookkeeping: turn i runs in tick i, and after it game.ticks() is i + 1.
 * An intent the agent sends after tick i ran goes into turn i + latencyTicks.
 * A fork is a snapshot at the tick boundary, and turns queued but not run yet
 * are not in it (GameRunner.snapshot). That is the caveat: intents in flight
 * when the fork is taken must be given to the fork in the step of the turn
 * they were queued for, which at latency 1 is its first step.
 *
 * Compared after every tick: game.hash() (troops and tiles per player, unit
 * ids, types and tiles; GameImpl.hash). Every CHECK_EVERY ticks and at the
 * end: the full snapshot bytes, which cover what the hash does not (gold,
 * relations, attacks, executions and their PRNG state); diffSnapshots names
 * any difference.
 */
import path from "path";
import { Agent, AgentIntent } from "../../src/agent/Agent";
import { AgentHost } from "../../src/agent/AgentHost";
import { createAgent } from "../../src/agent/agents";
import { BASELINE_DEFAULTS } from "../../src/agent/agents/BaselineAgent";
import {
  arenaGameStart,
  seatClientID,
  type ArenaGameSpec,
} from "../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../src/agent/arena/NodeMapLoader";
import { GameFork, TerrainSource } from "../../src/agent/Fork";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameType,
  UnitType,
} from "../../src/core/game/Game";
import { createGameRunner, GameRunner } from "../../src/core/GameRunner";
import { GameStartInfo, StampedIntent } from "../../src/core/Schemas";
import { snapshotGame } from "../../src/core/snapshot/GameSnapshot";
import { diffSnapshots } from "../util/Snapshot";

const MAPS = path.join(__dirname, "../../resources/maps");
const ME = seatClientID(0);
const BOTS = 400;
const WARMUP_TICKS = 300;
// The first tick boundary the baseline spawns at in singleplayer.
const SPAWN_DELAY = BASELINE_DEFAULTS.spawnDelay;
const LOCKSTEP_TICKS = 600;
const CHECK_EVERY = 100;
// Where §10.6 measured the fork: World at tick 3,000.
const WORLD_FORK_TICK = 3000;
const WORLD_LOCKSTEP_TICKS = 100;
const TIMEOUT = 60_000;

function hash(game: Game): number {
  return (game as unknown as { hash(): number }).hash();
}

/** The agent's queued intents as it sent them, without the sender stamp. */
function unstamped(intents: StampedIntent[]): AgentIntent[] {
  return intents.map(({ clientID: _, ...intent }) => intent as AgentIntent);
}

interface Arena {
  gameStart: GameStartInfo;
  runner: GameRunner;
  game: Game;
  host: AgentHost;
  /** Intents waiting for their turn, keyed by turn number. */
  queue: Map<number, StampedIntent[]>;
  /** Hash after every tick, indexed by game.ticks(). */
  hashes: number[];
  /** Runs the next turn and returns its intents; the agent does not act. */
  runTurn(): StampedIntent[];
  /** Plays `ticks` turns, the agent acting after each, as in the arena. */
  play(ticks: number): void;
  /** Intents sent for turns that have not run yet. */
  inFlight(): StampedIntent[];
}

/** One arena seat playing `agent`, wrapped by `wrap` if given. */
async function newArena(opts: {
  gameID: string;
  map: GameMapType;
  latencyTicks?: number;
  wrap?: (inner: Agent) => Agent;
}): Promise<Arena> {
  const latency = Math.max(1, opts.latencyTicks ?? 1);
  // The fields arenaGameStart reads; the rest of ArenaGameSpec only steers
  // the arena's loop, which this test replaces with its own.
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
    bots: BOTS,
    seats: [{ agent: "baseline" }],
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
  const queue = new Map<number, StampedIntent[]>();
  let executed = 0;
  const inner = createAgent("baseline");
  const host = new AgentHost({
    agent: opts.wrap?.(inner) ?? inner,
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
  const hashes: number[] = [];
  const arena: Arena = {
    gameStart,
    runner,
    game,
    host,
    queue,
    hashes,
    runTurn() {
      const intents = queue.get(executed) ?? [];
      queue.delete(executed);
      runner.addTurn({ turnNumber: executed, intents });
      if (!runner.executeNextTick() || fatal !== null) {
        throw new Error(fatal ?? `tick ${game.ticks()} did not execute`);
      }
      executed++;
      hashes[game.ticks()] = hash(game);
      return intents;
    },
    play(ticks) {
      for (let i = 0; i < ticks; i++) {
        arena.runTurn();
        host.tick();
      }
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

interface ForkUnderTest {
  fork: GameFork;
  /** What the fork is given for the real game's turn; default: the same. */
  intentsFor?: (turn: number, real: StampedIntent[]) => StampedIntent[];
}

interface Lockstep {
  /** First tick after which the hashes differed, or null. */
  firstDivergence: number | null;
  ticksCompared: number;
  intentsGiven: number;
  intentTypes: Record<string, number>;
  /** From the first checkpoint whose snapshots differed. */
  snapshotDiffs: string[];
  /** Wall time in fork.step, all ticks. */
  stepMs: number;
}

// Units whose motion a fork must reproduce, counted to show what a window
// exercised.
const MOVING: readonly UnitType[] = [
  UnitType.TransportShip,
  UnitType.Warship,
  UnitType.TradeShip,
  UnitType.Train,
  UnitType.Shell,
  UnitType.SAMMissile,
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.MIRVWarhead,
];

interface Activity {
  /** Most attacks in progress at once, over all players. */
  maxAttacks: number;
  /** Moving units alive after each tick, summed over ticks, by type. */
  unitTicks: Record<string, number>;
}

/**
 * Plays the real game `ticks` more turns, the agent acting after each, and
 * steps every fork in lockstep with the intents of the same turn (or what
 * its `intentsFor` makes of them), comparing hashes after every tick and
 * snapshots every CHECK_EVERY ticks.
 */
function lockstep(
  arena: Arena,
  forks: ForkUnderTest[],
  ticks: number,
): { results: Lockstep[]; activity: Activity } {
  const results: Lockstep[] = forks.map(() => ({
    firstDivergence: null,
    ticksCompared: 0,
    intentsGiven: 0,
    intentTypes: {},
    snapshotDiffs: [],
    stepMs: 0,
  }));
  const activity: Activity = { maxAttacks: 0, unitTicks: {} };
  const gameID = arena.gameStart.gameID;
  for (let i = 0; i < ticks; i++) {
    const turn = arena.game.ticks();
    const intents = arena.runTurn();
    const tick = arena.game.ticks();
    const expected = arena.hashes[tick];
    const checkpoint = (i + 1) % CHECK_EVERY === 0 || i === ticks - 1;
    const real = checkpoint ? snapshotGame(arena.game, { gameID }) : null;
    forks.forEach(({ fork, intentsFor }, f) => {
      const r = results[f];
      const given = intentsFor?.(turn, intents) ?? intents;
      const start = performance.now();
      fork.step(unstamped(given));
      r.stepMs += performance.now() - start;
      r.intentsGiven += given.length;
      for (const x of given) {
        r.intentTypes[x.type] = (r.intentTypes[x.type] ?? 0) + 1;
      }
      expect(fork.game.ticks()).toBe(tick);
      r.ticksCompared++;
      if (r.firstDivergence === null && hash(fork.game) !== expected) {
        r.firstDivergence = tick;
      }
      if (real !== null && r.snapshotDiffs.length === 0) {
        const diffs = diffSnapshots(snapshotGame(fork.game, { gameID }), real);
        r.snapshotDiffs = diffs.map((d) => `tick ${tick}: ${d}`);
      }
    });
    let attacks = 0;
    for (const p of arena.game.players()) attacks += p.outgoingAttacks().length;
    activity.maxAttacks = Math.max(activity.maxAttacks, attacks);
    for (const u of arena.game.units(MOVING)) {
      activity.unitTicks[u.type()] = (activity.unitTicks[u.type()] ?? 0) + 1;
    }
    arena.host.tick();
  }
  return { results, activity };
}

/**
 * Wraps the agent so that it also sends an attack on free land on each of the
 * `latency` ticks up to `at`, which puts that many turns in flight at `at`,
 * and then forks `count` times from inside its tick at `at`, the way a
 * lookahead would.
 */
function forkingAgent(
  at: number,
  latency: number,
  count: number,
  forks: GameFork[],
): (inner: Agent) => Agent {
  return (inner) => ({
    name: "forking",
    tick(ctx) {
      inner.tick(ctx);
      if (ctx.tick <= at - latency || ctx.tick > at) return;
      // An attack takes its troops in the tick its turn runs
      // (AttackExecution.init), so leaving one out shows at once.
      const troops = Math.floor(ctx.me.troops() / 10);
      expect(ctx.send({ type: "attack", targetID: null, troops })).toBe("ok");
      if (ctx.tick === at) {
        for (let i = 0; i < count; i++) forks.push(ctx.fork());
      }
    },
  });
}

describe("fork fidelity (H10)", () => {
  beforeAll(() => {
    console.debug = () => {};
    // Nations and tribes warn about failed boats and builds; not our concern.
    console.warn = () => {};
  });

  test(
    "a fork stepped with the real game's intents stays identical for 600 ticks, and never touches the real game",
    async () => {
      const arena = await newArena({
        gameID: "FORKFID1",
        map: GameMapType.Onion,
      });
      arena.play(WARMUP_TICKS);
      expect(arena.host.me().hasSpawned()).toBe(true);
      expect(arena.game.inSpawnPhase()).toBe(false);

      // Between a turn and the agent acting, nothing is in flight at
      // latency 1: everything the fork is given was decided after it.
      expect(arena.inFlight()).toEqual([]);
      const fork = arena.host.fork();
      expect(fork.game.ticks()).toBe(arena.game.ticks());
      expect(hash(fork.game)).toBe(hash(arena.game));

      const {
        results: [r],
        activity,
      } = lockstep(arena, [{ fork }], LOCKSTEP_TICKS);
      console.log(
        `Onion ticks ${WARMUP_TICKS}-${arena.game.ticks()}: fork ` +
          `${arena.host.stats.forkMs.total.toFixed(0)} ms, given ` +
          `${JSON.stringify(r.intentTypes)}, ${JSON.stringify(activity)}`,
      );
      expect(r.ticksCompared).toBe(LOCKSTEP_TICKS);
      expect(r.firstDivergence).toBeNull();
      expect(r.snapshotDiffs).toEqual([]);
      // The window was not quiet: the agent kept playing, and so did the AI.
      expect(r.intentTypes.attack ?? 0).toBeGreaterThan(0);
      expect(activity.maxAttacks).toBeGreaterThan(1);

      // The same game without the fork, hash for hash from tick 1: forking
      // and stepping a fork left the real game (and its agent) untouched.
      const twin = await newArena({
        gameID: "FORKFID1",
        map: GameMapType.Onion,
      });
      twin.play(WARMUP_TICKS + LOCKSTEP_TICKS);
      expect(twin.hashes).toEqual(arena.hashes);
      expect(
        diffSnapshots(twin.runner.snapshot(), arena.runner.snapshot()),
      ).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a fork taken in the spawn phase, before the agent spawns, stays identical through the spawn",
    async () => {
      // Lookahead for the spawn (H1) forks here. Singleplayer's phase is
      // untimed and ends when the agent's spawn lands; the baseline sends it
      // after tick SPAWN_DELAY - 1 ran (BaselineAgent.spawn).
      const arena = await newArena({
        gameID: "FORKSPWN",
        map: GameMapType.Onion,
      });
      arena.play(SPAWN_DELAY - 1);
      arena.runTurn();
      expect(arena.game.ticks()).toBe(SPAWN_DELAY);
      expect(arena.game.inSpawnPhase()).toBe(true);
      expect(arena.host.me().hasSpawned()).toBe(false);
      expect(arena.inFlight()).toEqual([]);
      const fork = arena.host.fork();
      expect(fork.game.inSpawnPhase()).toBe(true);
      arena.host.tick();

      const {
        results: [r],
      } = lockstep(arena, [{ fork }], LOCKSTEP_TICKS / 2);
      expect(r.intentTypes.spawn).toBe(1);
      expect(arena.game.inSpawnPhase()).toBe(false);
      expect(fork.game.inSpawnPhase()).toBe(false);
      expect(fork.game.playerByClientID(ME)!.hasSpawned()).toBe(true);
      expect(r.firstDivergence).toBeNull();
      expect(r.snapshotDiffs).toEqual([]);
    },
    TIMEOUT,
  );

  test.each([1, 3])(
    "intents in flight at the fork must be replayed into its first steps (latency %i)",
    async (latency) => {
      const forks: GameFork[] = [];
      const arena = await newArena({
        gameID: `FORKFLT${latency}`,
        map: GameMapType.Onion,
        latencyTicks: latency,
        wrap: forkingAgent(WARMUP_TICKS, latency, 3, forks),
      });
      arena.play(WARMUP_TICKS);
      expect(forks).toHaveLength(3);
      expect(arena.host.stats.forks).toBe(3);
      const forkTick = arena.game.ticks();
      expect(forks[0].game.ticks()).toBe(forkTick);

      // One extra attack per turn in flight, at turns forkTick ..
      // forkTick + latency - 1; the agent's own intents may add more.
      const inFlight = new Set(arena.inFlight());
      const turnsInFlight = [...arena.queue.keys()].filter(
        (t) => t >= forkTick,
      );
      expect(turnsInFlight.sort((a, b) => a - b)).toEqual(
        Array.from({ length: latency }, (_, i) => forkTick + i),
      );
      const notInFlight = (real: StampedIntent[]) =>
        real.filter((x) => !inFlight.has(x));

      const {
        results: [replayed, dropped, early],
      } = lockstep(
        arena,
        [
          // Each in-flight intent in the step of the turn it was queued for.
          { fork: forks[0] },
          // Left out: the fork plays a game the real one never will.
          { fork: forks[1], intentsFor: (_, real) => notInFlight(real) },
          // All of them in the first step: right only at latency 1.
          {
            fork: forks[2],
            intentsFor: (turn, real) =>
              turn === forkTick
                ? [...inFlight, ...notInFlight(real)]
                : notInFlight(real),
          },
        ],
        LOCKSTEP_TICKS / 2,
      );
      console.log(
        `Onion latency ${latency}: ${inFlight.size} intents in flight ` +
          `over ${latency} turn(s); left out, the hash diverges after tick ` +
          `${dropped.firstDivergence}; all in the first step, after tick ` +
          `${early.firstDivergence}`,
      );
      expect(replayed.firstDivergence).toBeNull();
      expect(replayed.snapshotDiffs).toEqual([]);
      // Documented expectation: without the replay the fork is wrong from
      // the tick the first in-flight intent would have run.
      expect(dropped.firstDivergence).toBe(forkTick + 1);
      expect(dropped.snapshotDiffs).not.toEqual([]);
      if (latency === 1) {
        // At latency 1 "the fork's first step" is exactly right.
        expect(early.firstDivergence).toBeNull();
      } else {
        // At higher latency the replay must keep each intent's turn.
        expect(early.firstDivergence).toBe(forkTick + 1);
      }
    },
    TIMEOUT,
  );

  test(
    "fork time on World mid-game, and fidelity there",
    async () => {
      const arena = await newArena({
        gameID: "FORKWRLD",
        map: GameMapType.World,
      });
      arena.play(WORLD_FORK_TICK);
      const game = arena.game;
      const alive = game.players().filter((p) => p.isAlive()).length;
      const units = game.units().length;

      const snapStart = performance.now();
      const bytes = arena.runner.snapshot();
      const snapshotMs = performance.now() - snapStart;
      expect(arena.inFlight()).toEqual([]);
      const fork = arena.host.fork();
      // What the arena reports as forkMs: snapshot and restore.
      const forkMs = arena.host.stats.forkMs.total;

      const {
        results: [r],
        activity,
      } = lockstep(arena, [{ fork }], WORLD_LOCKSTEP_TICKS);
      console.log(
        `World tick ${WORLD_FORK_TICK} (${alive} players alive, ${units} ` +
          `units, snapshot ${(bytes.length / 1e6).toFixed(2)} MB): snapshot ` +
          `${snapshotMs.toFixed(0)} ms, fork ${forkMs.toFixed(0)} ms, fork ` +
          `step ${(r.stepMs / r.ticksCompared).toFixed(1)} ms/tick, ` +
          `${JSON.stringify(activity)}`,
      );
      // §10.6 and H10 claim ~0.3 s; the bound only catches a regression by
      // an order of magnitude on a busy machine.
      expect(forkMs).toBeLessThan(5000);
      expect(r.firstDivergence).toBeNull();
      expect(r.snapshotDiffs).toEqual([]);
    },
    TIMEOUT,
  );
});
