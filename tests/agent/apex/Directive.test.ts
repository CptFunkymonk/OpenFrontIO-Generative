/**
 * Package WP1 (docs/14-m4-plan.md §2.1, §2.2): the directive a search plays
 * through the live policy, and the hook it runs from.
 *
 * Claims:
 * - A step is offered in the run of its tick (a missed tick: the next run),
 *   after scheduler.begin and before the reflexes, and an attack sized by
 *   `frac` gets floor(frac × purse.available(kind)) of that tick's purse.
 * - A skipped step (below minTroops, or its `when` fails) and a refused one
 *   are logged, counted and dropped.
 * - A foe mark vetoes our alliance requests (the web's), counter-accepts
 *   and extensions with the nation until its tick, and no longer.
 * - forRolloutWith keeps the pending steps unless `replace`; adopt plays
 *   the same edit live and refuses plans that cannot be played; the
 *   LiveSearch runs before the tick's run, sees what it sent afterwards,
 *   and an error it throws comes out after the run.
 * - Round 2 (the review of package WP1): the host's Ledger and
 *   NationModel copies are observed at the tick (F2); a copy spends no
 *   budget on an invalid intent (F3) and records a directive attack
 *   without meta.target against its target at the send, as live (F4); a
 *   copy plays one game only (F5); the states the search reads hold the
 *   Ledger's data of the last run. A copy stepped on the live game itself
 *   (it only reads the game) must send what the live policy sends.
 *
 * Setting: a synthetic 200x100 plains field (as Diplomacy.test.ts builds
 * it) with the agent on x < 100 and four nations with no nation AI (the
 * test makes their requests): A (5,000 tiles, bordering us), B (20 tiles
 * inside our land), C and D beyond A. Expansion, boats, economy, strikes
 * and the endgame are off unless a test turns them on.
 */
import { AgentContext, AgentIntent } from "../../../src/agent/Agent";
import { parseApexOptions } from "../../../src/agent/agents/apex/options";
import {
  ApexPolicy,
  LiveSearch,
  RolloutCopy,
  SearchHost,
} from "../../../src/agent/agents/apex/policy";
import {
  ApexState,
  createState,
  DirectiveStep,
} from "../../../src/agent/agents/apex/state";
import { PendingSend, UNRESOLVED } from "../../../src/agent/lib/Ledger";
import { BudgetMirror } from "../../../src/agent/lib/Lookahead";
import { NationModel } from "../../../src/agent/lib/NationModel";
import { Prio, Proposal } from "../../../src/agent/lib/Scheduler";
import { Config } from "../../../src/core/configuration/Config";
import { AllianceRequestExecution } from "../../../src/core/execution/alliance/AllianceRequestExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import {
  Cell,
  Game,
  Nation,
  Player,
  PlayerID,
  PlayerInfo,
  PlayerType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import {
  AGENT_CLIENT,
  AGENT_ID,
  Field,
  GAME_CONFIG,
  GAME_ID,
  Harness,
} from "./Field";

const W = 200;
const H = 100;
const LAND = 0x80 | 5;
const NATIONS = [
  { id: "NATIONAA", rect: [100, 0, 150, H], troops: 100_000 },
  { id: "NATIONBB", rect: [50, 0, 52, 10], troops: 5_000 },
  { id: "NATIONCC", rect: [150, 0, 175, H], troops: 80_000 },
  { id: "NATIONDD", rect: [175, 0, 200, H], troops: 80_000 },
] as const;
const A = NATIONS[0].id;

interface World {
  f: Field;
  game: Game;
  us: Player;
  s: ApexState;
  policy: ApexPolicy;
  h: Harness;
  nation(id: string): Player;
  /** Every intent the policy sent, with its tick. */
  sent(): { tick: number; intent: AgentIntent }[];
}

function world(
  options: Record<string, unknown>,
  o2: { search?: LiveSearch; allianceMinutes?: number } = {},
): World {
  const t = new Uint8Array(W * H).fill(LAND);
  const m = new Uint8Array((W / 2) * (H / 2)).fill(LAND);
  const map = new GameMapImpl(W, H, t, W * H);
  const mini = new GameMapImpl(W / 2, H / 2, m, (W * H) / 4);
  const config = new Config(
    o2.allianceMinutes === undefined
      ? GAME_CONFIG
      : { ...GAME_CONFIG, customAllianceDuration: o2.allianceMinutes },
    null,
    false,
  );
  const nations = NATIONS.map(
    (n, i) =>
      new Nation(
        new Cell(n.rect[0], i),
        new PlayerInfo(n.id.toLowerCase(), PlayerType.Nation, null, n.id),
      ),
  );
  const game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    nations,
    map,
    mini,
    config,
  );
  game.endSpawnPhase();
  const us = game.player(AGENT_ID);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < 100; x++) us.conquer(game.ref(x, y));
  }
  for (const n of NATIONS) {
    const p = game.player(n.id);
    const [x0, y0, x1, y1] = n.rect;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) p.conquer(game.ref(x, y));
    }
    p.setTroops(n.troops);
  }
  us.setTroops(400_000);
  const f: Field = {
    game,
    config,
    me: us,
    executor: new Executor(game, GAME_ID, undefined),
  };
  const o = parseApexOptions({
    expansion: false,
    boats: false,
    economy: false,
    strike: false,
    endgame: false,
    web: false,
    spawnMode: "plan",
    ...options,
  });
  const s = createState();
  const policy = new ApexPolicy(o, s, o2.search ?? null);
  const h = new Harness(f, (ctx) => policy.tick(ctx));
  return {
    f,
    game,
    us,
    s,
    policy,
    h,
    nation: (id) => game.player(id),
    sent: () => h.sentLog,
  };
}

/** A strike proposal on `N` (as a search's candidate makes it). */
function strike(N: Player, troops = 1): Proposal {
  return {
    intent: { type: "attack", targetID: N.id(), troops },
    prio: Prio.Strike,
    cls: "strike",
    key: `attack:${N.smallID()}`,
    spend: { kind: "strike", troops },
    plan: "strike",
    meta: { target: N.smallID(), clampTroops: troops, expectedRefund: 0 },
  };
}

/** A LiveSearch that records what the host offered at each call. */
class Probe implements LiveSearch {
  readonly calls: string[] = [];
  /** host.available("strike") after each tick's run: that tick's purse
   *  before any take (the run changes neither troops nor floors after). */
  readonly strikeAfter = new Map<number, number>();
  host: SearchHost | null = null;
  onTick: ((ctx: AgentContext, host: SearchHost) => void) | null = null;

  tick(ctx: AgentContext, host: SearchHost): void {
    this.host = host;
    this.calls.push(`tick ${ctx.tick}`);
    this.onTick?.(ctx, host);
  }

  afterTick(ctx: AgentContext, sent: readonly AgentIntent[]): void {
    this.calls.push(`after ${ctx.tick} ${sent.length}`);
    this.strikeAfter.set(ctx.tick, this.host!.available("strike"));
  }
}

const attacksOn = (w: World, id: PlayerID) =>
  w
    .sent()
    .filter((x) => x.intent.type === "attack" && x.intent.targetID === id);

/** One step of `copy` on the live game at its current tick (the copy only
 *  reads it), with a BudgetMirror of the live budget now. */
function stepOnLive(w: World, copy: RolloutCopy): AgentIntent[] {
  return copy.step({
    game: w.game,
    me: w.us,
    tick: w.game.ticks(),
    gameID: GAME_ID,
    budget: BudgetMirror.fromContext(w.h.context()),
  });
}

/** Our live Ledger's pending sends, written into the state (by a copy). */
function livePending(w: World): PendingSend[] {
  w.policy.forRolloutWith();
  return w.s.ledger.pending ?? [];
}

/** Steps past the nations' spawn immunity (50 ticks), before which no
 *  attack of ours on a nation starts. */
function pastImmunity(w: World): void {
  while (w.game.ticks() <= 55) w.h.step();
}

/** Troops of our non-retreating attacks on `N` in the game. */
function inFlightOn(w: World, N: Player): number {
  let n = 0;
  for (const a of w.us.outgoingAttacks()) {
    if (!a.retreating() && a.target() === N) n += a.troops();
  }
  return n;
}

describe("apex directive (package WP1)", () => {
  test("a step goes in the run of its tick, sized from that tick's purse", () => {
    const probe = new Probe();
    const w = world({}, { search: probe });
    const N = w.nation(A);
    for (let i = 0; i < 5; i++) w.h.step();
    const at = w.game.ticks() + 4;
    w.policy.setDirective([
      { at, label: "strike:A:0.5", frac: 0.5, p: strike(N) },
    ]);
    expect(w.s.search.directive).toHaveLength(1);
    for (let i = 0; i < 8; i++) w.h.step();
    const sends = attacksOn(w, A);
    expect(sends.map((x) => x.tick)).toEqual([at]);
    const avail = probe.strikeAfter.get(at)!;
    expect(avail).toBeGreaterThan(2_000);
    expect(sends[0].intent).toEqual({
      type: "attack",
      targetID: A,
      troops: Math.floor(0.5 * avail),
    });
    // Offered once, then gone; the log names it.
    expect(w.s.search.directive).toEqual([]);
    expect(w.s.search.stats).toEqual({ offered: 1, refused: 0, skipped: 0 });
    expect(w.h.logs.some((l) => l.includes("directive strike:A:0.5 S="))).toBe(
      true,
    );
    // It went out as a strike plan: the ledger (synced into the state by
    // forRolloutWith) holds a plan of kind strike on A, as the window
    // strikes' are (A1's top-ups and the web's underStrike read it).
    w.policy.forRolloutWith();
    expect(
      w.s.ledger.plans.find((p) => p.targetSmallID === N.smallID())?.kind,
    ).toBe("strike");
  });

  test("a step whose tick has passed goes at the next run; skips are logged", () => {
    const w = world({});
    const N = w.nation(A);
    w.h.step();
    const t = w.game.ticks();
    w.policy.setDirective([
      // Already past: offered in this run.
      { at: t - 10, label: "late", p: strike(N, 5_000) },
      // Below its minimum: skipped.
      { at: t + 1, label: "small", frac: 0.5, minTroops: 1e9, p: strike(N) },
      // A condition that fails: we are not allied with A.
      { at: t + 1, label: "if-allied", when: { allied: A }, p: strike(N, 10) },
    ]);
    w.h.step();
    w.h.step();
    const sends = attacksOn(w, A);
    expect(sends).toEqual([
      { tick: t, intent: { type: "attack", targetID: A, troops: 5_000 } },
    ]);
    expect(w.s.search.stats).toEqual({ offered: 1, refused: 0, skipped: 2 });
    expect(
      w.h.logs.some((l) => /directive small skipped \(S=\d+\)/.test(l)),
    ).toBe(true);
    expect(
      w.h.logs.some((l) =>
        l.includes(`directive if-allied skipped (not allied with ${A})`),
      ),
    ).toBe(true);
    expect(w.s.search.directive).toEqual([]);
  });

  test("a refused step is logged and dropped, never retried", () => {
    const w = world({});
    const N = w.nation(A);
    w.h.step();
    const t = w.game.ticks();
    w.policy.setDirective([
      // More than the purse holds: the Scheduler refuses it ("purse").
      { at: t, label: "too-big", p: strike(N, 1e12) },
      // The same key twice in a tick: the second is refused ("key").
      { at: t + 1, label: "first", p: strike(N, 1_000) },
      { at: t + 1, label: "second", p: strike(N, 2_000) },
    ]);
    for (let i = 0; i < 4; i++) w.h.step();
    expect(attacksOn(w, A).map((x) => x.intent)).toEqual([
      { type: "attack", targetID: A, troops: 1_000 },
    ]);
    expect(w.s.search.stats).toEqual({ offered: 3, refused: 2, skipped: 0 });
    expect(
      w.h.logs.some((l) => l.includes("directive too-big refused purse")),
    ).toBe(true);
    expect(
      w.h.logs.some((l) => l.includes("directive second refused key")),
    ).toBe(true);
    expect(w.s.search.directive).toEqual([]);
  });

  test("a foe mark vetoes the web's request to the nation", () => {
    // Without it the web asks A at tick 102 (Diplomacy.test.ts).
    const plain = world({ web: true });
    for (let i = 0; i < 110; i++) plain.h.step();
    const asked = (w: World) =>
      w
        .sent()
        .filter(
          (x) =>
            x.intent.type === "allianceRequest" && x.intent.recipient === A,
        );
    expect(asked(plain).map((x) => x.tick)).toEqual([102]);

    const foe = world({ web: true });
    foe.policy.setDirective([{ at: 0, foe: { id: A, until: 105 } }]);
    for (let i = 0; i < 110; i++) foe.h.step();
    expect(asked(foe)).toEqual([]);
    expect(foe.s.search.foes).toEqual({});
    // Past the mark the web may ask again (after its own cooldown).
    for (let i = 0; i < 400; i++) foe.h.step();
    expect(asked(foe).length).toBeGreaterThan(0);
    expect(asked(foe)[0].tick).toBeGreaterThan(105);
  });

  test("a foe mark vetoes the counter-accept until its tick", () => {
    const w = world({});
    for (let i = 0; i < 10; i++) w.h.step();
    const t = w.game.ticks();
    w.policy.setDirective([{ at: t, foe: { id: A, until: t + 20 } }]);
    w.game.addExecution(new AllianceRequestExecution(w.nation(A), AGENT_ID));
    const accepts = () =>
      w
        .sent()
        .filter(
          (x) =>
            x.intent.type === "allianceRequest" && x.intent.recipient === A,
        );
    for (let i = 0; i < 15; i++) w.h.step();
    expect(w.us.incomingAllianceRequests().length).toBe(1);
    expect(accepts()).toEqual([]);
    expect(w.us.isAlliedWith(w.nation(A))).toBe(false);
    for (let i = 0; i < 10; i++) w.h.step();
    // The first run past the mark accepts.
    expect(accepts().map((x) => x.tick)).toEqual([t + 21]);
    w.h.step();
    expect(w.us.isAlliedWith(w.nation(A))).toBe(true);
  });

  test("replace keeps the foe marks; a foe step with until before its tick clears one", () => {
    const w = world({});
    for (let i = 0; i < 10; i++) w.h.step();
    const t = w.game.ticks();
    w.policy.setDirective([{ at: t, foe: { id: A, until: t + 500 } }]);
    w.game.addExecution(new AllianceRequestExecution(w.nation(A), AGENT_ID));
    for (let i = 0; i < 5; i++) w.h.step();
    // A new plan with replace: the pending steps go, the mark stays.
    w.policy.setDirective([], true);
    for (let i = 0; i < 5; i++) w.h.step();
    expect(w.s.search.foes).toEqual({ [A]: t + 500 });
    expect(w.us.isAlliedWith(w.nation(A))).toBe(false);
    // A plan that allies A clears the mark first: accepted in that run.
    const at = w.game.ticks();
    w.policy.setDirective([{ at, foe: { id: A, until: at - 1 } }], true);
    w.h.step();
    expect(w.s.search.foes).toEqual({});
    expect(
      w
        .sent()
        .filter(
          (x) =>
            x.intent.type === "allianceRequest" && x.intent.recipient === A,
        )
        .map((x) => x.tick),
    ).toEqual([at]);
  });

  test("a foe mark vetoes the extension", () => {
    // One-minute alliances: the web asks A's extension 300 ticks before
    // expiry (extendLead), A being in the ally set.
    const run = (foe: boolean) => {
      const w = world({}, { allianceMinutes: 1 });
      for (let i = 0; i < 10; i++) w.h.step();
      w.game.addExecution(new AllianceRequestExecution(w.nation(A), AGENT_ID));
      for (let i = 0; i < 5; i++) w.h.step();
      const al = w.us.allianceWith(w.nation(A));
      expect(al).not.toBeNull();
      if (foe) {
        w.policy.setDirective([
          { at: w.game.ticks(), foe: { id: A, until: al!.expiresAt() + 10 } },
        ]);
      }
      while (w.game.ticks() < al!.expiresAt() - 100) w.h.step();
      return w
        .sent()
        .filter(
          (x) =>
            x.intent.type === "allianceExtension" && x.intent.recipient === A,
        );
    };
    const asked = run(false);
    expect(asked).toHaveLength(1);
    expect(run(true)).toEqual([]);
  });

  test("forRolloutWith keeps the pending steps, replace drops them; adopt plays the same edit", () => {
    const probe = new Probe();
    const w = world({}, { search: probe });
    const N = w.nation(A);
    w.h.step();
    const t = w.game.ticks();
    const pending: DirectiveStep = {
      at: t + 50,
      label: "pending",
      p: strike(N),
    };
    const plan: DirectiveStep = { at: t + 60, label: "plan", p: strike(N) };
    w.policy.setDirective([pending]);
    const kept = w.policy.forRolloutWith({ steps: [plan] });
    const replaced = w.policy.forRolloutWith({ steps: [plan], replace: true });
    const base = w.policy.forRolloutWith();
    expect(kept.state().search.directive.map((d) => d.label)).toEqual([
      "pending",
      "plan",
    ]);
    expect(replaced.state().search.directive.map((d) => d.label)).toEqual([
      "plan",
    ]);
    expect(base.state().search.directive.map((d) => d.label)).toEqual([
      "pending",
    ]);
    // Copies share nothing with the live state.
    expect(kept.state().search).not.toBe(w.s.search);
    expect(w.s.search.directive.map((d) => d.label)).toEqual(["pending"]);

    // adopt, through the host the search sees: the edit the copy got.
    const host = probe.host!;
    host.adopt({ steps: [plan], replace: true });
    expect(w.s.search.directive).toEqual(replaced.state().search.directive);
    expect(() => host.adopt({ steps: [plan], o: { strikes: false } })).toThrow(
      /cannot be played live/,
    );
    expect(() => host.adopt({ steps: [plan], shift: 1 })).toThrow(
      /cannot be played live/,
    );
    // A step due before this tick would go out later than in its rollout.
    expect(() => host.adopt({ steps: [{ ...plan, at: t - 1 }] })).toThrow(
      /before tick/,
    );
  });

  test("the search runs before the tick's run and sees its sends after; its error comes out after the run", () => {
    const probe = new Probe();
    const w = world({}, { search: probe });
    const N = w.nation(A);
    w.h.step();
    const t = w.game.ticks();
    probe.onTick = (ctx, host) => {
      if (ctx.tick !== t) return;
      // The state is the last tick's: no decision of this tick yet.
      expect(host.state.timers.lastThink).toBeLessThan(t);
      host.setDirective([{ at: t, label: "now", p: strike(N, 3_000) }]);
    };
    w.h.step();
    expect(probe.calls.slice(-2)).toEqual([`tick ${t}`, `after ${t} 1`]);
    expect(attacksOn(w, A).map((x) => x.tick)).toEqual([t]);

    // An error: the tick still runs (its step goes out), then it throws.
    const t2 = w.game.ticks();
    probe.onTick = () => {
      throw new Error("search broke");
    };
    w.policy.setDirective([{ at: t2, label: "still", p: strike(N, 2_000) }]);
    const sent: AgentIntent[] = [];
    const ctx = w.h.context((i) => sent.push(i));
    expect(() => w.policy.tick(ctx)).toThrow("search broke");
    expect(sent).toEqual([{ type: "attack", targetID: A, troops: 2_000 }]);
  });

  test("no search in the spawn phase or in a copy; search on without one throws", () => {
    const probe = new Probe();
    const w = world({}, { search: probe });
    w.h.step();
    const copy = w.policy.forRolloutWith();
    void copy;
    // A copy has no search: stepping it never calls the probe (checked in
    // RolloutFidelity.test.ts on real forks); here the live one is called
    // once per live tick.
    w.h.step();
    expect(probe.calls.filter((c) => c.startsWith("tick"))).toHaveLength(2);

    const bare = new ApexPolicy(
      parseApexOptions({ search: true }),
      createState(),
    );
    const h = new Harness(w.f, (ctx) => bare.tick(ctx));
    expect(() => h.step()).toThrow(/no LiveSearch was given/);
  });
});

describe("apex directive, review round 2 (package WP1)", () => {
  test("F2: the host's Ledger shows our attacks in flight, and its copies are observed at the tick", () => {
    const probe = new Probe();
    const w = world({}, { search: probe });
    const N = w.nation(A);
    pastImmunity(w);
    const t = w.game.ticks();
    w.policy.setDirective([{ at: t, label: "strike", p: strike(N, 20_000) }]);
    const seen: {
      tick: number;
      stack: number;
      inFlight: number;
      observed: number | null;
    }[] = [];
    probe.onTick = (ctx, host) => {
      const nm = host.nationModel() as unknown as {
        lastObserve: number | null;
      };
      seen.push({
        tick: ctx.tick,
        stack: host.ledger()!.stackOn(N.smallID()),
        inFlight: inFlightOn(w, N),
        observed: nm.lastObserve,
      });
    };
    for (let i = 0; i < 12; i++) w.h.step();
    // From the tick after the send's attack showed, the copy's stack is
    // what is in flight (unobserved it was 0: its pending send gone, its
    // view of the attacks empty).
    const later = seen.filter((x) => x.tick >= t + 2);
    expect(later).toHaveLength(10);
    for (const x of later) {
      expect(x.inFlight).toBeGreaterThan(0);
      expect(x.stack).toBe(x.inFlight);
    }
    // Both copies are observed at the tick the search runs in.
    for (const x of seen) expect(x.observed).toBe(x.tick);
    // A private copy: querying it moved nothing live.
    const live = (w.policy as unknown as { rt: { nm: NationModel } }).rt.nm;
    expect(probe.host!.nationModel()).not.toBe(live);
  });

  test("F3: an invalid step spends no budget in a copy, as live; the next step goes out in both", () => {
    const w = world({});
    const N = w.nation(A);
    pastImmunity(w);
    const t = w.game.ticks();
    // Eight attacks the wire schema refuses (troops < 0; no spend, so the
    // Scheduler accepts them), then an intent the next tick that needs the
    // per-second budget they would have spent.
    const steps: DirectiveStep[] = [];
    for (let i = 0; i < 8; i++) {
      steps.push({
        at: t,
        label: `bad${i}`,
        p: {
          intent: { type: "attack", targetID: N.id(), troops: -1 },
          prio: Prio.Strike,
          cls: "strike",
          key: `bad:${i}`,
        },
      });
    }
    steps.push({
      at: t + 1,
      label: "good",
      p: {
        intent: { type: "embargo", targetID: N.id(), action: "start" },
        prio: Prio.Strike,
        cls: "strike",
        key: "good",
      },
    });
    const copy = w.policy.forRolloutWith({ steps });
    w.policy.setDirective(steps);
    for (let i = 0; i < 4; i++) {
      const rolled = stepOnLive(w, copy);
      const live = w.h.step();
      expect(rolled).toEqual(live);
    }
    expect(
      w
        .sent()
        .filter((x) => x.intent.type === "embargo")
        .map((x) => x.tick),
    ).toEqual([t + 1]);
    expect(copy.state().search.stats).toEqual(w.s.search.stats);
    expect(w.s.search.stats).toEqual({ offered: 9, refused: 0, skipped: 0 });
  });

  test("F4: a directive attack without meta.target is pending on its target at the send, in a copy as live", () => {
    const w = world({});
    const N = w.nation(A);
    pastImmunity(w);
    const t0 = w.game.ticks();
    // A strike with meta.target: the live Ledger learns A's smallID at
    // the send; a copy's Ledger, from LedgerData, only from sends still
    // pending and, at its observes, from our attacks running: none, once
    // this one has ended.
    w.policy.setDirective([{ at: t0, label: "first", p: strike(N, 500) }]);
    w.h.step();
    w.h.step();
    expect(inFlightOn(w, N)).toBeGreaterThan(0);
    for (let i = 0; i < 300 && w.us.outgoingAttacks().length > 0; i++) {
      w.h.step();
    }
    expect(w.us.outgoingAttacks()).toEqual([]);
    w.h.step(); // its observe drops the plan
    expect(livePending(w)).toEqual([]);
    expect(w.s.ledger.plans).toEqual([]);
    const t = w.game.ticks();
    const bare: Proposal = {
      intent: { type: "attack", targetID: N.id(), troops: 1_000 },
      prio: Prio.Strike,
      cls: "strike",
      key: `attack:${N.smallID()}`,
      spend: { kind: "strike", troops: 1_000 },
      plan: "strike",
    };
    const steps: DirectiveStep[] = [{ at: t, label: "bare", p: bare }];
    const copy = w.policy.forRolloutWith({ steps });
    w.policy.setDirective(steps);
    expect(stepOnLive(w, copy)).toEqual(w.h.step());
    const mine = (ps: readonly PendingSend[] | undefined) =>
      (ps ?? []).filter((p) => p.tick === t);
    const live = mine(livePending(w));
    expect(live).toHaveLength(1);
    expect(live[0].target).toBe(N.smallID());
    expect(live[0].target).not.toBe(UNRESOLVED);
    expect(mine(copy.state().ledger.pending)).toEqual(live);
    expect(copy.state().ledger.plans).toEqual(w.s.ledger.plans);
  });

  test("F5: a copy plays the game of its first step only", () => {
    const w = world({});
    const other = world({});
    w.h.step();
    other.h.step();
    const copy = w.policy.forRolloutWith();
    stepOnLive(w, copy);
    stepOnLive(w, copy);
    expect(() => stepOnLive(other, copy)).toThrow(
      /plays only the game of its first step/,
    );
    // A fresh copy steps anywhere once.
    expect(() => stepOnLive(other, w.policy.forRolloutWith())).not.toThrow();
  });

  test("the states the search reads hold the Ledger's data of the last run", () => {
    const probe = new Probe();
    const w = world({}, { search: probe });
    const N = w.nation(A);
    pastImmunity(w);
    const t = w.game.ticks();
    const hasPlan = (s: Readonly<ApexState>) =>
      s.ledger.plans.some(
        (p) => p.targetSmallID === N.smallID() && p.kind === "strike",
      );
    // A copy stepped with a strike: state() shows the copy's plan.
    const steps = [{ at: t, label: "strike", p: strike(N, 5_000) }];
    const copy = w.policy.forRolloutWith({ steps });
    expect(hasPlan(copy.state())).toBe(false);
    stepOnLive(w, copy);
    expect(hasPlan(copy.state())).toBe(true);
    // Live: the plan the run made shows in host.state at the next tick.
    w.policy.setDirective(steps);
    let seen: boolean | null = null;
    probe.onTick = (ctx, host) => {
      if (ctx.tick === t + 1) seen = hasPlan(host.state);
    };
    w.h.step();
    expect(hasPlan(w.s)).toBe(false);
    w.h.step();
    expect(seen).toBe(true);
  });

  // Review F1: counterAccept counted the vetoed key's refusal ("key") as
  // a slot the recall took, so a foe's pending request held a slot and the
  // next nation's request was not accepted; it asks Scheduler.vetoed first.
  test("F1: a foe's pending request holds no counter-accept slot", () => {
    // Impossible: ceil(0.25 * 5 players) = 2 slots. D takes one.
    const w = world({});
    const [nA, , C, D] = NATIONS.map((n) => w.nation(n.id));
    for (let i = 0; i < 10; i++) w.h.step();
    w.game.addExecution(new AllianceRequestExecution(D, AGENT_ID));
    for (let i = 0; i < 5; i++) w.h.step();
    expect(w.us.isAlliedWith(D)).toBe(true);
    const t = w.game.ticks();
    w.policy.setDirective([{ at: t, foe: { id: nA.id(), until: t + 500 } }]);
    w.game.addExecution(new AllianceRequestExecution(nA, AGENT_ID));
    w.game.addExecution(new AllianceRequestExecution(C, AGENT_ID));
    for (let i = 0; i < 30; i++) w.h.step();
    expect(w.us.isAlliedWith(nA)).toBe(false);
    expect(w.us.isAlliedWith(C)).toBe(true);
  });
});
