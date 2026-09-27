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
 *
 * Forks come in two kinds with the same contract: a snapshot restore
 * (ctx.fork(), new GameFork with bytes) and a structural clone
 * (GameFork.clone, ForkSource and forkMany: one take of the game, any number
 * of forks). The last tests hold the clones to the same standard, and check
 * that forks branched from a fork (GameFork.clones, GameFork.source) carry
 * the intents it still has to replay (GameFork.replay).
 */
import path from "path";
import { Agent, AgentContext, AgentIntent } from "../../src/agent/Agent";
import { AgentHost } from "../../src/agent/AgentHost";
import { createAgent } from "../../src/agent/agents";
import { BASELINE_DEFAULTS } from "../../src/agent/agents/BaselineAgent";
import {
  arenaGameStart,
  seatClientID,
  type ArenaGameSpec,
} from "../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../src/agent/arena/NodeMapLoader";
import {
  forkMany,
  ForkSource,
  GameFork,
  TerrainSource,
} from "../../src/agent/Fork";
import { Lookahead } from "../../src/agent/lib/Lookahead";
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
// Generous: each test plays a real game tick by tick (World to tick 3,000
// in the last), on a machine the suite may share with arena runs (17-84 s
// a test at load 17 on 4 cores).
const TIMEOUT = 300_000;

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
  terrain: TerrainSource;
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
    terrain,
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

/**
 * A fork by snapshot and restore, whatever ctx.fork() is wired to: the
 * reference the structural clones are held to.
 */
function restoreFork(arena: Arena): GameFork {
  return new GameFork(
    arena.game,
    arena.runner.snapshot(),
    arena.terrain,
    arena.gameStart,
    ME,
  );
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
  // How to fork from inside the tick; default ctx.fork(), `count` times.
  make?: (ctx: AgentContext, count: number) => GameFork[],
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
        if (make !== undefined) {
          forks.push(...make(ctx, count));
        } else {
          for (let i = 0; i < count; i++) forks.push(ctx.fork());
        }
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
      // The structural clone too: spawn-phase lookahead forks here.
      const clone = GameFork.clone(arena.game, arena.gameStart, ME);
      expect(fork.game.inSpawnPhase()).toBe(true);
      expect(clone.game.inSpawnPhase()).toBe(true);
      arena.host.tick();

      const { results } = lockstep(
        arena,
        [{ fork }, { fork: clone }],
        LOCKSTEP_TICKS / 2,
      );
      expect(arena.game.inSpawnPhase()).toBe(false);
      for (const [r, f] of results.map(
        (x, i) => [x, [fork, clone][i]] as const,
      )) {
        expect(r.intentTypes.spawn).toBe(1);
        expect(f.game.inSpawnPhase()).toBe(false);
        expect(f.game.playerByClientID(ME)!.hasSpawned()).toBe(true);
        expect(r.firstDivergence).toBeNull();
        expect(r.snapshotDiffs).toEqual([]);
      }
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
  test(
    "structural clones (GameFork.clone, forkMany) stay identical for 600 ticks like a restore, and never touch the real game",
    async () => {
      const arena = await newArena({
        gameID: "FORKFID1",
        map: GameMapType.Onion,
      });
      arena.play(WARMUP_TICKS);
      expect(arena.inFlight()).toEqual([]);
      const { gameStart, game } = arena;
      const restored = restoreFork(arena);
      const cloned = GameFork.clone(game, gameStart, ME);
      const many = forkMany(game, gameStart, ME, 3);
      for (const f of [cloned, ...many]) {
        expect(f.game.ticks()).toBe(game.ticks());
        expect(hash(f.game)).toBe(hash(game));
        expect(
          diffSnapshots(snapshotGame(f.game), snapshotGame(restored.game)),
        ).toEqual([]);
      }

      const { results } = lockstep(
        arena,
        [restored, cloned, ...many].map((fork) => ({ fork })),
        LOCKSTEP_TICKS,
      );
      for (const r of results) {
        expect(r.ticksCompared).toBe(LOCKSTEP_TICKS);
        expect(r.firstDivergence).toBeNull();
        expect(r.snapshotDiffs).toEqual([]);
      }

      // Hash for hash with the same game never forked: five forks, four of
      // them clones and three of those from one take, left the real game
      // exactly as it was.
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
    "forks of one take are independent: one given other intents diverges, the rest do not",
    async () => {
      const arena = await newArena({
        gameID: "FORKMANY",
        map: GameMapType.Onion,
      });
      arena.play(WARMUP_TICKS);
      const { game, gameStart } = arena;
      const source = new ForkSource(game, gameStart, ME);
      const [ahead, odd, a] = source.forks(3);
      const bytes = snapshotGame(a.game, { gameID: gameStart.gameID });
      // One fork stepped ahead alone changes neither its siblings nor what
      // the source hands out next.
      ahead.advance(50);
      const b = source.fork();
      for (const f of [a, b]) {
        expect(
          diffSnapshots(
            snapshotGame(f.game, { gameID: gameStart.gameID }),
            bytes,
          ),
        ).toEqual([]);
      }
      const forkTick = game.ticks();
      const troops = Math.floor(arena.host.me().troops() / 2);
      const {
        results: [rOdd, rA, rB],
      } = lockstep(
        arena,
        [
          // An extra attack in its first step, sent as the agent.
          {
            fork: odd,
            intentsFor: (turn, real) =>
              turn === forkTick
                ? [
                    ...real,
                    { type: "attack", targetID: null, troops, clientID: ME },
                  ]
                : real,
          },
          { fork: a },
          { fork: b },
        ],
        LOCKSTEP_TICKS / 2,
      );
      expect(rOdd.firstDivergence).toBe(forkTick + 1);
      for (const r of [rA, rB]) {
        expect(r.firstDivergence).toBeNull();
        expect(r.snapshotDiffs).toEqual([]);
      }
      // The source refuses once the game has moved on.
      expect(() => source.fork()).toThrow(/tick/);
    },
    TIMEOUT,
  );

  test(
    "a fork branched mid-rollout (GameFork.clones) gives forks identical to it and to the real game",
    async () => {
      const arena = await newArena({
        gameID: "FORKBRCH",
        map: GameMapType.Onion,
      });
      arena.play(WARMUP_TICKS);
      // A restored fork (what ctx.fork() gives today) runs 50 ticks, then
      // branches in two, the way a search reuses a rollout as its next base.
      const base = restoreFork(arena);
      const {
        results: [before],
      } = lockstep(arena, [{ fork: base }], 50);
      expect(before.firstDivergence).toBeNull();
      const branches = base.clones(2);
      for (const b of branches) {
        expect(b.game.ticks()).toBe(arena.game.ticks());
        expect(hash(b.game)).toBe(hash(arena.game));
      }
      const { results } = lockstep(
        arena,
        [base, ...branches].map((fork) => ({ fork })),
        LOCKSTEP_TICKS / 2,
      );
      for (const r of results) {
        expect(r.firstDivergence).toBeNull();
        expect(r.snapshotDiffs).toEqual([]);
      }
    },
    TIMEOUT,
  );

  test.each([1, 3])(
    "clones made from inside the agent's tick need the same replay of intents in flight (latency %i)",
    async (latency) => {
      const forks: GameFork[] = [];
      // Read when the agent forks, during play: set by then.
      let start: GameStartInfo | null = null;
      const arena = await newArena({
        gameID: `FORKCLN${latency}`,
        map: GameMapType.Onion,
        latencyTicks: latency,
        wrap: forkingAgent(WARMUP_TICKS, latency, 2, forks, (ctx, n) =>
          new ForkSource(ctx.game, start!, ctx.clientID).forks(n),
        ),
      });
      start = arena.gameStart;
      arena.play(WARMUP_TICKS);
      expect(forks).toHaveLength(2);
      const forkTick = arena.game.ticks();
      expect(forks[0].game.ticks()).toBe(forkTick);
      const inFlight = new Set(arena.inFlight());
      expect(inFlight.size).toBeGreaterThanOrEqual(latency);
      const notInFlight = (real: StampedIntent[]) =>
        real.filter((x) => !inFlight.has(x));
      const {
        results: [replayed, dropped],
      } = lockstep(
        arena,
        [
          { fork: forks[0] },
          { fork: forks[1], intentsFor: (_, real) => notInFlight(real) },
        ],
        LOCKSTEP_TICKS / 2,
      );
      expect(replayed.firstDivergence).toBeNull();
      expect(replayed.snapshotDiffs).toEqual([]);
      expect(dropped.firstDivergence).toBe(forkTick + 1);
    },
    TIMEOUT,
  );

  test(
    "clone time on World mid-game against a restore, and fidelity there",
    async () => {
      const arena = await newArena({
        gameID: "FORKWRLD",
        map: GameMapType.World,
      });
      arena.play(WORLD_FORK_TICK);
      expect(arena.inFlight()).toEqual([]);
      const { game, gameStart } = arena;
      const median = (xs: number[]) =>
        [...xs].sort((x, y) => x - y)[xs.length >> 1];
      const restoreMs: number[] = [];
      const cloneMs: number[] = [];
      let fork: GameFork | null = null;
      for (let i = 0; i < 3; i++) {
        let t = performance.now();
        restoreFork(arena);
        restoreMs.push(performance.now() - t);
        t = performance.now();
        fork = GameFork.clone(game, gameStart, ME);
        cloneMs.push(performance.now() - t);
      }
      const t = performance.now();
      const many = new ForkSource(game, gameStart, ME).forks(3);
      const manyMs = (performance.now() - t) / 3;
      const {
        results: [r, ...rm],
      } = lockstep(
        arena,
        [fork!, ...many].map((f) => ({ fork: f })),
        WORLD_LOCKSTEP_TICKS,
      );
      // Timings are logged, not asserted: the suite shares its machine.
      console.log(
        `World tick ${WORLD_FORK_TICK}: fork by snapshot and restore ` +
          `${median(restoreMs).toFixed(0)} ms, by structural clone ` +
          `${median(cloneMs).toFixed(0)} ms, ${manyMs.toFixed(0)} ms each ` +
          `for 3 from one take (medians of 3)`,
      );
      for (const x of [r, ...rm]) {
        expect(x.firstDivergence).toBeNull();
        expect(x.snapshotDiffs).toEqual([]);
      }
    },
    TIMEOUT,
  );

  test.each([1, 3])(
    "intents queued with GameFork.replay run in their turn's step, and forks branched before it carry them (latency %i)",
    async (latency) => {
      const forks: GameFork[] = [];
      const arena = await newArena({
        gameID: `FORKRPL${latency}`,
        map: GameMapType.Onion,
        latencyTicks: latency,
        wrap: forkingAgent(WARMUP_TICKS, latency, 1, forks),
      });
      arena.play(WARMUP_TICKS);
      const [fork] = forks;
      const forkTick = arena.game.ticks();
      // Every turn in flight at the fork, queued for the turn it runs in.
      const turns = [...arena.queue.keys()]
        .filter((t) => t >= forkTick)
        .sort((a, b) => a - b);
      expect(turns).toEqual(
        Array.from({ length: latency }, (_, i) => forkTick + i),
      );
      for (const t of turns) fork.replay(unstamped(arena.queue.get(t)!), t);
      expect([...fork.queued().keys()]).toEqual(turns);
      const inFlight = new Set(arena.inFlight());
      const notInFlight = (real: StampedIntent[]) =>
        real.filter((x) => !inFlight.has(x));

      // Branched before the fork's first step: both ways carry the queue.
      const [branch] = fork.clones(1);
      const fromSource = fork.source().fork();
      for (const f of [branch, fromSource]) {
        expect(f.queued()).toEqual(fork.queued());
      }
      const { results } = lockstep(
        arena,
        [fork, branch, fromSource].map((f) => ({
          fork: f,
          intentsFor: (_: number, real: StampedIntent[]) => notInFlight(real),
        })),
        LOCKSTEP_TICKS / 2,
      );
      for (const r of results) {
        expect(r.firstDivergence).toBeNull();
        expect(r.snapshotDiffs).toEqual([]);
      }
      expect(fork.queued().size).toBe(0);
      expect(() => fork.replay([], forkTick)).toThrow(/already ran/);
    },
    TIMEOUT,
  );

  test(
    "a Lookahead fork with a replay branches only with its replay: refused or carried, never dropped",
    async () => {
      // Lookahead.fork(ctx, sent) puts the intents sent this tick into the
      // fork's first step. Branched before that step, the branch must get
      // them too, or refuse; losing them silently is the failure (the
      // branch would play a game without the agent's last send).
      const la = new Lookahead({ msPer10s: 1e9, wallBudgetMs: 1e9 });
      let fork: GameFork | null = null;
      let refused: string | null = null;
      let early: GameFork[] = [];
      const arena = await newArena({
        gameID: "FORKLKAH",
        map: GameMapType.Onion,
        wrap: (inner) => ({
          name: "lookahead",
          tick(ctx) {
            // At the fork tick the attack is the only send, so it is all
            // the replay has to hold (Lookahead.fork's contract).
            if (ctx.tick !== WARMUP_TICKS) return inner.tick(ctx);
            const troops = Math.floor(ctx.me.troops() / 5);
            const attack: AgentIntent = {
              type: "attack",
              targetID: null,
              troops,
            };
            expect(ctx.send(attack)).toBe("ok");
            fork = la.fork(ctx, [attack]);
            try {
              early = fork!.clones(1);
            } catch (e) {
              refused = String(e);
            }
          },
        }),
      });
      arena.play(WARMUP_TICKS);
      expect(fork).not.toBeNull();
      const f = fork as unknown as GameFork;
      if (refused !== null) expect(refused).toMatch(/replay/);
      // Everything the fork is given comes through its own step; the attack
      // is in flight, so the lockstep gives what is not.
      const inFlight = new Set(arena.inFlight());
      expect(inFlight.size).toBeGreaterThan(0);
      const notInFlight = (real: StampedIntent[]) =>
        real.filter((x) => !inFlight.has(x));
      const first = lockstep(
        arena,
        [f, ...early].map((x) => ({
          fork: x,
          intentsFor: (_: number, real: StampedIntent[]) => notInFlight(real),
        })),
        1,
      );
      for (const r of first.results) expect(r.firstDivergence).toBeNull();
      // After its first step the fork branches freely.
      const late = f.clones(1);
      const { results } = lockstep(
        arena,
        [f, ...early, ...late].map((x) => ({ fork: x })),
        LOCKSTEP_TICKS / 4,
      );
      for (const r of results) {
        expect(r.firstDivergence).toBeNull();
        expect(r.snapshotDiffs).toEqual([]);
      }
    },
    TIMEOUT,
  );
});
