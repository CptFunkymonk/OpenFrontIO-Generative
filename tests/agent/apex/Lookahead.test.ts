import path from "path";
import { Agent, AgentContext, AgentIntent } from "../../../src/agent/Agent";
import { AgentHost } from "../../../src/agent/AgentHost";
import { createAgent } from "../../../src/agent/agents";
import { APEX_DEFAULTS } from "../../../src/agent/agents/apex/options";
import {
  ArenaGameSpec,
  arenaGameStart,
  seatClientID,
} from "../../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../../src/agent/arena/NodeMapLoader";
import { GameFork, TerrainSource } from "../../../src/agent/Fork";
import { IntentBudget } from "../../../src/agent/IntentBudget";
import {
  BudgetMirror,
  Lookahead,
  RolloutPolicy,
  RolloutResult,
  SimView,
  value,
} from "../../../src/agent/lib/Lookahead";
import {
  buildRaceGrid,
  cellOf,
  idleArrival,
  IdleSample,
  idleSample,
} from "../../../src/agent/lib/RaceField";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameType,
  PlayerType,
} from "../../../src/core/game/Game";
import { createGameRunner, GameRunner } from "../../../src/core/GameRunner";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import { GameStartInfo, StampedIntent } from "../../../src/core/Schemas";
import { snapshotGame } from "../../../src/core/snapshot/GameSnapshot";
import { diffSnapshots } from "../../util/Snapshot";

// Lookahead (spec §2.8). The games are built as ForkFidelity.test.ts builds
// them, which is how the arena does: arenaGameStart → createGameRunner, the
// baseline agent in our seat through AgentHost (strict), latency 1 (an
// intent sent after tick T ran goes into turn T), the rate limiter on the
// game clock (tick × 100 ms). Onion at Normal size, its nations at
// Impossible, 400 tribes. The Lookahead forks from inside the agent's tick
// through ctx, as a controller would.

const MAPS = path.join(__dirname, "../../../resources/maps");
const ME = seatClientID(0);
const FORK_AT = 300;
const ROLLOUT_TICKS = 200;
const LOCKSTEP_TICKS = 50;
const TIMEOUT = 120_000;

function hash(game: Game): number {
  return (game as unknown as { hash(): number }).hash();
}

function unstamped(intents: StampedIntent[]): AgentIntent[] {
  return intents.map(({ clientID: _, ...intent }) => intent as AgentIntent);
}

interface Arena {
  gameStart: GameStartInfo;
  runner: GameRunner;
  game: Game;
  host: AgentHost;
  /** Runs the next turn and returns its intents; the agent does not act. */
  runTurn(): StampedIntent[];
  /** Plays `ticks` turns, the agent acting after each. */
  play(ticks: number): void;
}

async function newArena(
  gameID: string,
  wrap: (inner: Agent) => Agent,
): Promise<Arena> {
  const map = GameMapType.Onion;
  const spec = {
    gameID,
    map,
    mapSize: GameMapSize.Normal,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Impossible,
    nations: "default",
    bots: 400,
    seats: [{ agent: "baseline" }],
  } as unknown as ArenaGameSpec;
  const gameStart = arenaGameStart(spec);
  const loader = new NodeMapLoader(MAPS);
  let fatal: string | null = null;
  const runner = await createGameRunner(gameStart, undefined, loader, (gu) => {
    if ("errMsg" in gu) fatal ??= gu.errMsg;
  });
  const terrain = await TerrainSource.load(loader, map, GameMapSize.Normal);
  const game = runner.game;
  const queue = new Map<number, StampedIntent[]>();
  let executed = 0;
  const host = new AgentHost({
    agent: wrap(createAgent("baseline")),
    clientID: ME,
    gameStart,
    runner,
    terrain,
    deliver: (intent) => {
      const turn = executed;
      const list = queue.get(turn) ?? [];
      list.push({ ...intent, clientID: ME });
      queue.set(turn, list);
    },
    nowMs: () => game.ticks() * 100,
    strict: true,
  });
  const arena: Arena = {
    gameStart,
    runner,
    game,
    host,
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
    play(ticks) {
      for (let i = 0; i < ticks; i++) {
        arena.runTurn();
        host.tick();
      }
    },
  };
  return arena;
}

/**
 * Wraps the agent: at tick `at` it plays its tick through a context that
 * records what it sends, sends one more attack (so something is always in
 * flight), then calls `act` with that context and everything sent.
 */
function at(
  tick: number,
  act: (ctx: AgentContext, sent: AgentIntent[]) => void,
  before = false,
): (inner: Agent) => Agent {
  return (inner) => ({
    name: "lookahead-test",
    tick(ctx) {
      if (ctx.tick !== tick) {
        inner.tick(ctx);
        return;
      }
      const sent: AgentIntent[] = [];
      const rec: AgentContext = {
        ...ctx,
        send: (i) => {
          const r = ctx.send(i);
          if (r === "ok") sent.push(i);
          return r;
        },
      };
      if (before) {
        act(rec, sent);
        inner.tick(rec);
        return;
      }
      inner.tick(rec);
      const troops = Math.floor(ctx.me.troops() / 10);
      expect(rec.send({ type: "attack", targetID: null, troops })).toBe("ok");
      act(rec, sent);
    },
  });
}

/** Attacks free land with a fifth of its troops every 10th tick, paying
 *  from the view's budget. */
class EveryTenth implements RolloutPolicy {
  steps = 0;
  step(v: SimView): AgentIntent[] {
    this.steps++;
    if (v.tick % 10 !== 0) return [];
    const troops = Math.floor(v.me.troops() / 5);
    const nowMs = v.tick * v.game.config().msPerTick();
    if (troops < 1 || !v.budget.tryConsume(nowMs)) return [];
    return [{ type: "attack", targetID: null, troops }];
  }
}

/** The result with its wall time zeroed, for comparisons. */
function withoutMs(r: RolloutResult): RolloutResult {
  return { ...r, ms: 0 };
}

beforeAll(() => {
  console.debug = () => {};
  console.warn = () => {};
});

describe("BudgetMirror", () => {
  test("equals IntentBudget over a random stream, and a clone continues identically", () => {
    const rnd = new PseudoRandom(20260926);
    let now = 5_000;
    const live = new IntentBudget(() => now);
    // A full budget at `now` is a new IntentBudget created then.
    const mirrors = [
      BudgetMirror.fromLive({ perSecond: 10, perMinute: 150 }, now),
    ];
    let granted = 0;
    let refused = 0;
    for (let i = 0; i < 20_000; i++) {
      // Bursts (no time passing), short gaps and the odd long pause.
      const r = rnd.nextInt(0, 100);
      now +=
        r < 40 ? 0 : r < 90 ? rnd.nextInt(1, 200) : rnd.nextInt(200, 20_000);
      if (rnd.nextInt(0, 4) === 0) {
        const want = live.remaining();
        for (const m of mirrors) expect(m.remaining(now)).toEqual(want);
      } else {
        const ok = live.tryConsume();
        for (const m of mirrors) expect(m.tryConsume(now)).toBe(ok);
        if (ok) granted++;
        else refused++;
      }
      if (i === 10_000) mirrors.push(mirrors[0].clone());
    }
    // The stream exercised both limits.
    expect(granted).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(1000);
  });

  test("a clone is independent of its original", () => {
    const m = BudgetMirror.fromLive({ perSecond: 10, perMinute: 150 }, 0);
    const c = m.clone();
    for (let i = 0; i < 10; i++) expect(c.tryConsume(0)).toBe(true);
    expect(c.tryConsume(0)).toBe(false);
    expect(m.remaining(0)).toEqual({ perSecond: 10, perMinute: 150 });
  });

  test("from a used live budget it never grants more than the live one had left", () => {
    const rnd = new PseudoRandom(7);
    for (let trial = 0; trial < 50; trial++) {
      let now = 0;
      const live = new IntentBudget(() => now);
      const until = rnd.nextInt(1_000, 90_000);
      while (now < until) {
        now += rnd.nextInt(0, 400);
        live.tryConsume();
      }
      const left = live.remaining();
      const mirror = BudgetMirror.fromLive(left, now);
      expect(mirror.remaining(now)).toEqual(left);
      const start = now;
      let inSecond = 0;
      let inMinute = 0;
      while (now < start + 60_000) {
        if (mirror.tryConsume(now)) {
          if (now < start + 1_000) inSecond++;
          inMinute++;
        }
        now += rnd.nextInt(0, 300);
      }
      expect(inSecond).toBeLessThanOrEqual(left.perSecond);
      expect(inMinute).toBeLessThanOrEqual(left.perMinute);
    }
  });

  test("without rate limits (Infinity) it grants everything", () => {
    const m = BudgetMirror.fromLive(
      { perSecond: Infinity, perMinute: Infinity },
      0,
    );
    for (let i = 0; i < 1000; i++) expect(m.tryConsume(0)).toBe(true);
    expect(m.remaining(0)).toEqual({
      perSecond: Infinity,
      perMinute: Infinity,
    });
  });
});

describe("Lookahead forks and rollouts", () => {
  test(
    "a rollout with a trivial policy is deterministic and equals stepping the fork by hand; the replay keeps a fork identical to the game",
    async () => {
      const la = new Lookahead({ msPer10s: 1e9, wallBudgetMs: 1e9 });
      const forks: GameFork[] = [];
      let replay: AgentIntent[] = [];
      let budgetAt: { perSecond: number; perMinute: number } | null = null;
      let gameID = "";
      const arena = await newArena(
        "LOOKAHD1",
        at(FORK_AT, (ctx, sent) => {
          replay = [...sent];
          budgetAt = ctx.budget();
          gameID = ctx.gameID;
          // A, B: rollouts; C: by hand; D: lockstep with the game; E: no
          // replay; F, G: inject by rollout and by hand.
          for (let i = 0; i < 5; i++) forks.push(la.fork(ctx, sent)!);
          forks.push(la.fork(ctx, [])!);
          forks.push(la.fork(ctx, sent)!);
        }),
      );
      arena.play(FORK_AT);
      expect(forks).toHaveLength(7);
      expect(forks.every((f) => f !== null)).toBe(true);
      expect(replay.length).toBeGreaterThan(0);
      const [A, B, C, D, F, E, G] = forks;
      expect(arena.host.me().hasSpawned()).toBe(true);

      // D and E in lockstep with the game: D (with the replay) stays
      // identical; E (without it) plays a turn the game never did.
      let eDiverged: number | null = null;
      for (let i = 0; i < LOCKSTEP_TICKS; i++) {
        const intents = unstamped(arena.runTurn());
        D.step(i === 0 ? [] : intents);
        E.step(i === 0 ? [] : intents);
        expect(hash(D.game)).toBe(hash(arena.game));
        if (eDiverged === null && hash(E.game) !== hash(arena.game)) {
          eDiverged = arena.game.ticks();
        }
        arena.host.tick();
      }
      expect(eDiverged).toBe(FORK_AT + 1);
      expect(
        diffSnapshots(
          snapshotGame(D.game, { gameID }),
          snapshotGame(arena.game, { gameID }),
        ),
      ).toEqual([]);

      // Read-only: rollouts and hand-stepping below touch only the forks.
      const live = snapshotGame(arena.game, { gameID });
      const rA = la.rollout(A, ME, new EveryTenth(), ROLLOUT_TICKS);
      const rB = la.rollout(B, ME, new EveryTenth(), ROLLOUT_TICKS);
      expect(rA.ticks).toBe(ROLLOUT_TICKS);
      expect(A.game.ticks()).toBe(FORK_AT + ROLLOUT_TICKS);
      expect(withoutMs(rB)).toEqual(withoutMs(rA));
      expect(hash(B.game)).toBe(hash(A.game));
      expect(
        diffSnapshots(
          snapshotGame(B.game, { gameID }),
          snapshotGame(A.game, { gameID }),
        ),
      ).toEqual([]);
      expect(rA.alive).toBe(true);
      expect(rA.tiles).toBeGreaterThan(0);

      // By hand: the same policy and a mirror of the same live budget.
      const policy = new EveryTenth();
      const mirror = BudgetMirror.fromLive(budgetAt!, FORK_AT * 100);
      const me = C.game.playerByClientID(ME)!;
      for (let i = 0; i < ROLLOUT_TICKS; i++) {
        const tick = C.game.ticks();
        C.step(policy.step({ game: C.game, me, tick, gameID, budget: mirror }));
      }
      expect(hash(C.game)).toBe(hash(A.game));
      expect(me.numTilesOwned()).toBe(rA.tiles);
      expect(me.troops()).toBe(rA.home);

      // inject: extra intents at a turn, by rollout and by hand.
      const extraTurn = FORK_AT + 5;
      const extra: AgentIntent[] = [
        { type: "attack", targetID: null, troops: 1000 },
      ];
      const rF = la.rollout(
        F,
        ME,
        new EveryTenth(),
        ROLLOUT_TICKS,
        new Map([[extraTurn, extra]]),
      );
      const byHand = new EveryTenth();
      const mirrorG = BudgetMirror.fromLive(budgetAt!, FORK_AT * 100);
      const meG = G.game.playerByClientID(ME)!;
      for (let i = 0; i < ROLLOUT_TICKS; i++) {
        const tick = G.game.ticks();
        const mine = byHand.step({
          game: G.game,
          me: meG,
          tick,
          gameID,
          budget: mirrorG,
        });
        G.step(tick === extraTurn ? [...extra, ...mine] : mine);
      }
      expect(hash(G.game)).toBe(hash(F.game));
      expect(rF.tiles).toBe(meG.numTilesOwned());
      expect(hash(F.game)).not.toBe(hash(A.game));
      expect(diffSnapshots(snapshotGame(arena.game, { gameID }), live)).toEqual(
        [],
      );
      console.log(
        `Onion rollout ${ROLLOUT_TICKS} ticks from ${FORK_AT}: ` +
          `${rA.ms.toFixed(0)} ms, tiles ${rA.tiles}, home ${rA.home}, ` +
          `outgoing ${rA.outgoing}, incoming ${rA.incomingNation}, value ` +
          `${value(rA, 17).toFixed(0)}`,
      );
    },
    TIMEOUT,
  );

  test(
    "the fork is refused over budget, and allowed again once the window passes",
    async () => {
      const tight = new Lookahead({ msPer10s: 1, wallBudgetMs: 0 });
      const noPlay = new Lookahead({ msPer10s: 0, wallBudgetMs: 1e9 });
      const got: Record<string, boolean> = {};
      let forksBefore = 0;
      const record = (name: string, f: GameFork | null) => {
        got[name] = f !== null;
      };
      const arena = await newArena("LOOKAHD2", (inner) => ({
        name: "budget-test",
        tick(ctx) {
          if (ctx.tick === 2) {
            // Spawn phase: the spawn search's wall budget, not msPer10s.
            expect(ctx.game.inSpawnPhase()).toBe(true);
            forksBefore = arena.host.stats.forks;
            expect(tight.canFork(ctx)).toBe(false);
            record("spawnTight", tight.fork(ctx, []));
            expect(arena.host.stats.forks).toBe(forksBefore);
            record("spawnNoPlay", noPlay.fork(ctx, []));
            expect(noPlay.spawnMs()).toBeGreaterThan(0);
          }
          if (ctx.tick === FORK_AT) {
            record("noPlay", noPlay.fork(ctx, []));
            record("first", tight.fork(ctx, []));
            expect(tight.recentMs(ctx.game, ctx.tick)).toBeGreaterThan(1);
            forksBefore = arena.host.stats.forks;
            record("second", tight.fork(ctx, []));
            expect(arena.host.stats.forks).toBe(forksBefore);
          }
          // Charged at tick 300: inside the 10 s (100 ticks) window until
          // tick 400.
          if (ctx.tick === FORK_AT + 50)
            record("inWindow", tight.fork(ctx, []));
          if (ctx.tick === FORK_AT + 100) {
            record("windowEdge", tight.fork(ctx, []));
          }
          if (ctx.tick === FORK_AT + 101) record("after", tight.fork(ctx, []));
          inner.tick(ctx);
        },
      }));
      arena.play(FORK_AT + 102);
      expect(got).toEqual({
        spawnTight: false,
        spawnNoPlay: true,
        noPlay: false,
        first: true,
        second: false,
        inWindow: false,
        windowEdge: true,
        after: false,
      });
    },
    TIMEOUT,
  );

  test(
    "idleFuture ends the spawn phase on the fork only and samples every `every` ticks from 0",
    async () => {
      const la = new Lookahead({ msPer10s: 0, wallBudgetMs: 1e9 });
      const samples: IdleSample[] = [];
      let liveInSpawn = false;
      let gridCells = 0;
      let spawnCells: number[] = [];
      const arena = await newArena(
        "LOOKAHD3",
        at(
          APEX_DEFAULTS.spawnDelay,
          (ctx) => {
            const grid = buildRaceGrid(ctx.game, APEX_DEFAULTS);
            gridCells = grid.cw * grid.ch;
            spawnCells = ctx.game
              .players()
              .filter((p) => p.type() === PlayerType.Nation)
              .map((p) => cellOf(grid, ctx.game, p.spawnTile()!));
            const f = la.fork(ctx, [])!;
            expect(f).not.toBeNull();
            la.idleFuture(f, 300, 150, (g, t) => {
              samples.push(idleSample(g, grid, t));
              expect(g.inSpawnPhase()).toBe(false);
            });
            expect(f.game.ticks()).toBe(ctx.tick + 300);
            liveInSpawn = ctx.game.inSpawnPhase();
            // A tribe landed first can cut a nation's disc (the
            // SpawnPhaseSingleplayer pin), so most, not all, spawn cells.
            const arr = idleArrival(grid, samples, APEX_DEFAULTS);
            const atZero = spawnCells.filter((c) => arr.nation[c] === 0);
            expect(atZero.length).toBeGreaterThanOrEqual(
              0.8 * spawnCells.length,
            );
          },
          true,
        ),
      );
      arena.play(APEX_DEFAULTS.spawnDelay + 1);
      expect(liveInSpawn).toBe(true);
      expect(samples.map((s) => s.tick)).toEqual([0, 150, 300]);
      const held = (s: IdleSample) => {
        let n = 0;
        for (let c = 0; c < gridCells; c++) n += s.nationOwned[c];
        return n;
      };
      // Nations grow in the fork while we have not spawned.
      expect(held(samples[1])).toBeGreaterThan(held(samples[0]));
      expect(held(samples[2])).toBeGreaterThan(held(samples[1]));
      expect(spawnCells.length).toBeGreaterThan(0);
      expect(la.spawnMs()).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test("value: tiles plus troops over c̄, minus incoming; dead is -Infinity", () => {
    const r: RolloutResult = {
      ticks: 900,
      alive: true,
      tiles: 1000,
      home: 3400,
      outgoing: 1700,
      incomingNation: 340,
      ms: 5,
    };
    expect(value(r, 17)).toBeCloseTo(
      1000 + (0.5 * 5100) / 17 - (0.5 * 340) / 17,
      9,
    );
    expect(value(r, 17, 1, 0)).toBeCloseTo(1000 + 5100 / 17, 9);
    expect(value({ ...r, alive: false }, 17)).toBe(-Infinity);
  });
});
