/**
 * Package WP10b: with the leader guard on (o.leaderGuard), a rollout copy
 * of the live apex policy still plays the live game exactly (the claim
 * tests/agent/RolloutFidelity.test.ts pins for the defaults, package WP1):
 * the guard's memory (ApexState.leader: gold samples, lines, floor) rides in
 * the state the copy clones, and its reads of NationModel go to the copy's
 * clone, so the search's rollouts play the guard as the live game will.
 *
 * Setting: the arena path (tests/agent/util/ApexArena.ts) on World as quick
 * game 0 plays it (arena-results/quick20-int), forked at the start of live
 * ticks 900 (expansion: many sends, 2 bordering allies) and 2,400 (the
 * plan's first window: 6 bordering allies, apex idle at its cap) and
 * stepped in lockstep for 300 ticks each, as RolloutFidelity.test.ts does
 * (claims 1 and 2: intents tick by tick, hashes, the full snapshots at the
 * end). The lines are all 0 there (the allies' other neighbours hold more
 * than a third of their troops), so this pins the carrying of the guard's
 * state, not a binding floor (LeaderBetrayal.test.ts pins that).
 */
import { AgentContext, AgentIntent } from "../../../src/agent/Agent";
import type { LeaderMemory } from "../../../src/agent/agents/apex/LeaderHook";
import {
  LiveSearch,
  RolloutCopy,
  SearchHost,
} from "../../../src/agent/agents/apex/policy";
import { GameFork } from "../../../src/agent/Fork";
import { BudgetMirror, stepRollout } from "../../../src/agent/lib/Lookahead";
import { GameMapType, Player } from "../../../src/core/game/Game";
import { snapshotGame } from "../../../src/core/snapshot/GameSnapshot";
import { diffSnapshots } from "../../util/Snapshot";
import { ApexArena, apexArena, gameHash } from "../util/ApexArena";

const WINDOW = 300;
const WINDOWS = [900, 2400];

/** Forks at the next live tick and keeps what each tick sent. */
class ForkingSearch implements LiveSearch {
  action: ((ctx: AgentContext, host: SearchHost) => void) | null = null;
  lastSent: AgentIntent[] = [];

  tick(ctx: AgentContext, host: SearchHost): void {
    const a = this.action;
    this.action = null;
    a?.(ctx, host);
  }

  afterTick(_ctx: AgentContext, sent: readonly AgentIntent[]): void {
    this.lastSent = [...sent];
  }
}

interface Rollout {
  fork: GameFork;
  me: Player;
  copy: RolloutCopy;
  mirror: BudgetMirror;
}

/** Forks and copies the policy at the start of the live tick the arena is
 *  at, then the live policy acts on it. */
function start(arena: ApexArena, search: ForkingSearch): Rollout {
  const made: { r: Rollout | null } = { r: null };
  search.action = (ctx, host) => {
    const fork = ctx.fork();
    const mirror = BudgetMirror.fromContext(ctx);
    const copy = host.forRolloutWith({});
    const me = fork.game.playerByClientID(ctx.clientID);
    if (me === null) throw new Error("no player in the fork");
    made.r = { fork, me, copy, mirror };
  };
  arena.act();
  const r = made.r;
  if (r === null) throw new Error("the search did not run");
  return r;
}

describe("WP10b leader guard: rollout fidelity on World", () => {
  beforeAll(() => {
    console.debug = () => {};
    console.warn = () => {};
  });

  test(`copies made at ticks ${WINDOWS.join(", ")} with the guard on play the live game exactly for ${WINDOW} ticks`, async () => {
    const search = new ForkingSearch();
    const arena = await apexArena({
      gameID: "G0avyeoz",
      map: GameMapType.World,
      options: { leaderGuard: true },
      search,
    });
    const gameID = arena.gameStart.gameID;
    let sent = 0;
    for (const t0 of WINDOWS) {
      if (arena.game.ticks() !== t0) {
        if (t0 !== WINDOWS[0]) arena.act();
        arena.playTo(t0);
      }
      expect(arena.inFlight()).toEqual([]);
      const { fork, me, copy, mirror } = start(arena, search);
      const live = arena.host.me();
      let firstIntentDiff: string | null = null;
      let firstHashDiff: number | null = null;
      for (let h = 1; h <= WINDOW; h++) {
        const tick = arena.game.ticks();
        const rolled = stepRollout(fork, me, gameID, copy, mirror);
        sent += search.lastSent.length;
        if (
          firstIntentDiff === null &&
          JSON.stringify(rolled) !== JSON.stringify(search.lastSent)
        ) {
          firstIntentDiff =
            `tick ${tick}: rollout ${JSON.stringify(rolled).slice(0, 300)} ` +
            `live ${JSON.stringify(search.lastSent).slice(0, 300)}`;
        }
        arena.runTurn();
        if (
          firstHashDiff === null &&
          gameHash(fork.game) !== gameHash(arena.game)
        ) {
          firstHashDiff = arena.game.ticks();
        }
        if (h < WINDOW) arena.act();
      }
      expect(firstIntentDiff).toBeNull();
      expect(firstHashDiff).toBeNull();
      expect(
        diffSnapshots(
          snapshotGame(fork.game, { gameID }),
          snapshotGame(arena.game, { gameID }),
        ),
      ).toEqual([]);
      expect(me.troops()).toBe(live.troops());
      // The guard ran in both: the same lines, floor, gold samples and
      // danger at the last decision (the log time is live only).
      const liveMem = arena.state.leader as LeaderMemory;
      const copyMem = copy.state().leader as LeaderMemory;
      expect(liveMem).toBeDefined();
      expect(copyMem.at).toBe(liveMem.at);
      expect(copyMem.lines).toEqual(liveMem.lines);
      expect(copyMem.lines.length).toBeGreaterThan(0);
      expect(copyMem.floor).toBe(liveMem.floor);
      expect(copyMem.gold).toEqual(liveMem.gold);
      expect(copyMem.danger).toEqual(liveMem.danger);
      console.log(
        `World ${t0}: sent ${sent} so far; leader lines ` +
          `${liveMem.lines.length}, floor ${Math.round(liveMem.floor)}`,
      );
    }
    // The windows were not quiet: the copies matched a playing policy.
    expect(sent).toBeGreaterThan(10);
  }, 900_000);
});
