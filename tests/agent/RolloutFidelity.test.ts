/**
 * Package WP1 (docs/14-m4-plan.md §2.2, §3 WP1): a rollout copy of the live
 * apex policy plays the live game exactly. In singleplayer against nations
 * and tribes our intents are the only input from outside the simulation, a
 * fork stepped with the live intents stays identical to the live game
 * (tests/agent/ForkFidelity.test.ts, H10), so a fork stepped with an exact
 * copy of the live policy is the future the live game will have: before a
 * plan, and with one.
 *
 * Setting: the arena path (tests/agent/util/ApexArena.ts) with apex at its
 * defaults, on World and Onion as the quick suite plays them (games 0 and
 * 20 of quick@20, arena-results/quick20-int). A LiveSearch given to the
 * policy forks at the start of a live tick, before the tick's run, takes
 * ApexPolicy.forRolloutWith and BudgetMirror.fromContext there, as WP2's
 * SearchController does, and the test steps the fork with the copy
 * (stepRollout) in lockstep with the live game.
 *
 * At ticks 2,400 and 4,800 (the plan's), 1,800 (the tribe phase, where the
 * copy of the policy before package WP1 diverged within 6 ticks on Onion:
 * /tmp/claude-0/growth/search.md §2.2) and 600 (the opening, whose sends
 * run near the rate limits the exact BudgetMirror copies):
 * 1. the copy's intents equal the live intents, tick by tick, for 300
 *    ticks (the plan asks 100);
 * 2. the hashes agree after every tick, and tiles, troops and gold at +50,
 *    +150 and +300, with the full snapshots equal at +300;
 * 3. then (not after the opening's window), from the tick that ends that
 *    window: a directive strike with the whole strike purse on the largest
 *    unallied bordering nation (a break and a strike the next tick if every
 *    neighbour is an ally), in the copy and, adopted, live: the same
 *    claims, the strike seen going out live.
 */
import { AgentContext, AgentIntent } from "../../src/agent/Agent";
import {
  LiveSearch,
  RolloutCopy,
  RolloutSpec,
  SearchHost,
} from "../../src/agent/agents/apex/policy";
import { DirectiveStep } from "../../src/agent/agents/apex/state";
import { GameFork } from "../../src/agent/Fork";
import { BudgetMirror, stepRollout } from "../../src/agent/lib/Lookahead";
import { Prio } from "../../src/agent/lib/Scheduler";
import { GameMapType, Player, PlayerType } from "../../src/core/game/Game";
import { snapshotGame } from "../../src/core/snapshot/GameSnapshot";
import { diffSnapshots } from "../util/Snapshot";
import { ApexArena, apexArena, gameHash } from "./util/ApexArena";

const WINDOW = 300;
const CHECKS = [50, 150, 300];
/** The windows: each window's tick, and whether a strike window follows. */
type Windows = readonly (readonly [number, boolean])[];
const WINDOWS: Windows = [
  [600, false],
  [1800, true],
  [2400, true],
  [4800, true],
];
/** Onion as quick game 4 plays it, where the copy of the policy before
 *  package WP1 sent two boats the live policy did not at tick 1,806 (the
 *  prototype's probe, /tmp/claude-0/search/c0t: 2 intent diffs; c0t5 with
 *  the four leaks carried: 0). */
const LEAK_WINDOWS: Windows = [[1800, false]];
// Each test plays a real game to tick 5,400 with apex (and its spawn
// preview) and two 300-tick rollouts per window, on a machine the suite
// may share with arena runs.
const TIMEOUT = 900_000;

/** A LiveSearch that runs one action at the next live tick, and keeps what
 *  each tick sent. */
class ForkingSearch implements LiveSearch {
  action: ((ctx: AgentContext, host: SearchHost) => void) | null = null;
  lastSent: AgentIntent[] = [];
  calls = 0;

  tick(ctx: AgentContext, host: SearchHost): void {
    this.calls++;
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
  /** The plan's target, when there is one. */
  target: Player | null;
  /** Wall ms of forRolloutWith (logs only). */
  copyMs: number;
}

interface Point {
  tiles: number;
  troops: number;
  gold: bigint;
}

interface Lockstep {
  firstIntentDiff: string | null;
  firstHashDiff: number | null;
  checks: { h: number; live: Point; roll: Point }[];
  snapshotDiffs: string[];
  liveTypes: Record<string, number>;
}

const point = (p: Player): Point => ({
  tiles: p.numTilesOwned(),
  troops: p.troops(),
  gold: p.gold(),
});

/**
 * At the start of the live tick the arena is at: forks and copies the
 * policy with `plan`'s spec (adopted live when `adopt`), then the live
 * policy acts on the tick.
 */
function start(
  arena: ApexArena,
  search: ForkingSearch,
  plan: (
    ctx: AgentContext,
    host: SearchHost,
  ) => {
    spec: RolloutSpec;
    target: Player | null;
  },
  adopt: boolean,
): Rollout {
  let r: Rollout | null = null;
  search.action = (ctx, host) => {
    const fork = ctx.fork();
    const mirror = BudgetMirror.fromContext(ctx);
    const { spec, target } = plan(ctx, host);
    const t0 = performance.now();
    const copy = host.forRolloutWith(spec);
    const copyMs = performance.now() - t0;
    if (adopt) host.adopt(spec);
    const me = fork.game.playerByClientID(ctx.clientID);
    if (me === null) throw new Error("no player in the fork");
    r = { fork, me, copy, mirror, target, copyMs };
  };
  arena.act();
  if (r === null) throw new Error("the search did not run");
  return r;
}

/**
 * Steps the copy on its fork in lockstep with the live game for WINDOW
 * ticks from the live tick it was made at (the live policy has acted on
 * it), comparing intents and hashes every tick and state at CHECKS. Ends at
 * the start of live tick +WINDOW, the live policy not yet acting on it.
 */
function lockstep(
  arena: ApexArena,
  search: ForkingSearch,
  r: Rollout,
): Lockstep {
  const out: Lockstep = {
    firstIntentDiff: null,
    firstHashDiff: null,
    checks: [],
    snapshotDiffs: [],
    liveTypes: {},
  };
  const live = arena.host.me();
  const gameID = arena.gameStart.gameID;
  for (let h = 1; h <= WINDOW; h++) {
    const tick = arena.game.ticks();
    const rolled = stepRollout(r.fork, r.me, gameID, r.copy, r.mirror);
    const sent = search.lastSent;
    for (const i of sent)
      out.liveTypes[i.type] = (out.liveTypes[i.type] ?? 0) + 1;
    if (
      out.firstIntentDiff === null &&
      JSON.stringify(rolled) !== JSON.stringify(sent)
    ) {
      out.firstIntentDiff =
        `tick ${tick}: rollout ${JSON.stringify(rolled).slice(0, 400)} ` +
        `live ${JSON.stringify(sent).slice(0, 400)}`;
    }
    arena.runTurn();
    expect(r.fork.game.ticks()).toBe(arena.game.ticks());
    if (
      out.firstHashDiff === null &&
      gameHash(r.fork.game) !== gameHash(arena.game)
    ) {
      out.firstHashDiff = arena.game.ticks();
    }
    if (CHECKS.includes(h)) {
      out.checks.push({ h, live: point(live), roll: point(r.me) });
    }
    if (h < WINDOW) arena.act();
  }
  out.snapshotDiffs = diffSnapshots(
    snapshotGame(r.fork.game, { gameID }),
    snapshotGame(arena.game, { gameID }),
  );
  return out;
}

function expectExact(l: Lockstep): void {
  expect(l.firstIntentDiff).toBeNull();
  expect(l.firstHashDiff).toBeNull();
  expect(l.checks.map((c) => c.h)).toEqual(CHECKS);
  for (const c of l.checks) expect(c.roll).toEqual(c.live);
  expect(l.snapshotDiffs).toEqual([]);
}

/** A directive strike with the whole strike purse at `at`. */
function strikeStep(N: Player, at: number): DirectiveStep {
  return {
    at,
    label: `strike:${N.id()}:1`,
    frac: 1,
    p: {
      intent: { type: "attack", targetID: N.id(), troops: 1 },
      prio: Prio.Strike,
      cls: "strike",
      key: `attack:${N.smallID()}`,
      spend: { kind: "strike", troops: 1 },
      plan: "strike",
      meta: { target: N.smallID(), clampTroops: 1, expectedRefund: 0 },
    },
  };
}

/** The strike plan of claim 3, from the last decision's scan. */
function strikePlan(
  ctx: AgentContext,
  host: SearchHost,
): { spec: RolloutSpec; target: Player | null } {
  const wm = host.wm();
  if (wm === null) throw new Error("no scan");
  const bordering = wm.nations
    .filter((n) => n.type === PlayerType.Nation && n.contact >= 8)
    .filter((n) => ctx.game.hasPlayer(n.id))
    .sort((a, b) => b.tiles - a.tiles || a.smallID - b.smallID);
  const t = ctx.tick;
  const open = bordering.find(
    (n) => n.attackable && !ctx.me.isAlliedWith(ctx.game.player(n.id)),
  );
  if (open !== undefined) {
    const N = ctx.game.player(open.id);
    return { spec: { steps: [strikeStep(N, t)] }, target: N };
  }
  const ally = bordering.find((n) =>
    ctx.me.isAlliedWith(ctx.game.player(n.id)),
  );
  if (ally === undefined) return { spec: {}, target: null };
  const N = ctx.game.player(ally.id);
  return {
    spec: {
      steps: [
        {
          at: t,
          label: `break:${N.id()}`,
          p: {
            intent: { type: "breakAlliance", recipient: N.id() },
            prio: Prio.Diplomacy,
            cls: "diplomacy",
            key: `break:${N.id()}`,
          },
        },
        strikeStep(N, t + 1),
      ],
    },
    target: N,
  };
}

describe.each([
  ["World", GameMapType.World, "G0avyeoz", WINDOWS],
  ["Onion", GameMapType.Onion, "G0hmxmad", WINDOWS],
  ["Onion (quick game 4)", GameMapType.Onion, "G0avyep3", LEAK_WINDOWS],
] as const)(
  "rollout fidelity on %s (package WP1)",
  (name, map, gameID, windows) => {
    beforeAll(() => {
      console.debug = () => {};
      // Nations and tribes warn about failed boats and builds; not our concern.
      console.warn = () => {};
    });

    test(
      `at ticks ${windows.map((w) => w[0]).join(", ")}: the copy plays the live game exactly${windows.some((w) => w[1]) ? ", before a plan and with a strike" : ""}`,
      async () => {
        const search = new ForkingSearch();
        const arena = await apexArena({ gameID, map, search });
        let sent = 0;
        for (const [t0, withPlan] of windows) {
          // At the start of live tick t0, the live policy not yet acting on
          // it (where the last window ended, or played to).
          if (arena.game.ticks() !== t0) {
            arena.act();
            arena.playTo(t0);
          }
          expect(arena.inFlight()).toEqual([]);
          const me = arena.host.me();
          expect(me.isAlive()).toBe(true);

          // Claims 1 and 2: no plan.
          const r0 = start(
            arena,
            search,
            () => ({ spec: {}, target: null }),
            false,
          );
          const base = lockstep(arena, search, r0);
          expectExact(base);
          for (const n of Object.values(base.liveTypes)) sent += n;
          const head =
            `${name} ${t0}: copy ${r0.copyMs.toFixed(1)} ms, base window ` +
            `sent ${JSON.stringify(base.liveTypes)}`;
          if (!withPlan) {
            console.log(head);
            continue;
          }

          // Claim 3: a strike, in the copy and live.
          const t1 = arena.game.ticks();
          const r = start(arena, search, strikePlan, true);
          const N = r.target;
          const struck = search.lastSent.find(
            (i) =>
              (i.type === "attack" && i.targetID === N?.id()) ||
              (i.type === "breakAlliance" && i.recipient === N?.id()),
          );
          const plan = lockstep(arena, search, r);
          console.log(
            `${head}; ` +
              `plan at ${t1} on ${N?.name() ?? "-"} (${JSON.stringify(struck ?? null)}), ` +
              `window sent ${JSON.stringify(plan.liveTypes)}, tiles at ` +
              plan.checks.map((c) => `+${c.h} ${c.live.tiles}`).join(", "),
          );
          expect(N).not.toBeNull();
          expect(struck).toBeDefined();
          expect(r.copy.state().search.stats.offered).toBeGreaterThan(0);
          expectExact(plan);
          for (const n of Object.values(plan.liveTypes)) sent += n;
        }
        arena.act();
        // The windows were not quiet: the copies matched a playing policy.
        expect(sent).toBeGreaterThan(10);
        // The search ran once per live tick past the spawn phase, and never
        // inside a copy.
        expect(search.calls).toBe(
          arena.game.ticks() - arena.state.spawn.endTick! + 1,
        );
      },
      TIMEOUT,
    );
  },
);
