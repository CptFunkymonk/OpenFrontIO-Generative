/**
 * Package WP1 (docs/14-m4-plan.md §2.2): the pieces of policy memory a
 * rollout copy must carry, each alone. RolloutFidelity.test.ts checks them
 * together, on real games.
 *
 * - Scheduler.copyFrom carries the per-class send windows and the cancel
 *   guard; Scheduler.veto refuses a key for one tick.
 * - BudgetMirror built from IntentBudget.state() limits a rollout exactly
 *   as the live budget would; built from remaining() alone it can grant
 *   less (a window the live limiter restarts sooner).
 * - A naval memo hits on a cloned OwnerGrid with the copied memos (keyed by
 *   stamp), and a copy's own grids stay its own.
 * - NukeModel.cloneFor carries the launch counts and gold samples.
 * - NationModel.cloneFor forecasts what the original forecasts, on its
 *   game and on a fork of it (the arena path on Onion to tick 900).
 */
import { AgentIntent, SendResult } from "../../../src/agent/Agent";
import {
  NavalMemos,
  voyageOf,
} from "../../../src/agent/agents/apex/controllers/NavalController";
import {
  APEX_DEFAULTS,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import { View } from "../../../src/agent/agents/apex/policy";
import { IntentBudget } from "../../../src/agent/IntentBudget";
import { Ledger } from "../../../src/agent/lib/Ledger";
import { BudgetMirror } from "../../../src/agent/lib/Lookahead";
import { createModels, Models } from "../../../src/agent/lib/Models";
import { NationModel } from "../../../src/agent/lib/NationModel";
import {
  buildRaceGrid,
  ownerGrid,
  voyageField,
} from "../../../src/agent/lib/RaceField";
import {
  createPurse,
  DUP_GUARD_TICKS,
  HomeFloors,
  Prio,
  Proposal,
  Scheduler,
} from "../../../src/agent/lib/Scheduler";
import {
  GameMapType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import { apexArena, ME } from "../util/ApexArena";
import { field, own, rect } from "./Field";
import {
  brain,
  columns,
  idOf,
  model,
  pastImmunity,
  setGold,
  siloAt,
  tick,
  world,
} from "./NukeWorld";

const FLOORS: HomeFloors = {
  cap: 1e9,
  econ: 0,
  vw: 0,
  food: 0,
  H: 0,
  tn: 0,
  strike: 0,
};
const ALL = { perSecond: 100, perMinute: 1000 };

const boat = (key: string): Proposal => ({
  intent: { type: "boat", troops: 10, dst: 1 },
  prio: Prio.Boat,
  cls: "boat",
  key,
});

function sendAll(s: Scheduler, tick: number): AgentIntent[] {
  const out: AgentIntent[] = [];
  const ledger = { recordSend: () => undefined } as unknown as Ledger;
  s.flush(
    (i): SendResult => {
      out.push(i);
      return "ok";
    },
    ledger,
    tick,
  );
  return out;
}

describe("Scheduler.copyFrom and veto (package WP1)", () => {
  const o = {
    ...APEX_DEFAULTS,
    classCapsPerMinute: { ...APEX_DEFAULTS.classCapsPerMinute, boat: 2 },
  };

  test("a copy starts with the live send windows: capped where live is, free where live is", () => {
    const live = new Scheduler(o, 100);
    live.begin(100, ALL, createPurse(1e6, FLOORS));
    expect(live.offer(boat("b1"))).toBe(true);
    expect(live.offer(boat("b2"))).toBe(true);
    expect(sendAll(live, 100)).toHaveLength(2);

    const copy = new Scheduler(o, 100);
    copy.copyFrom(live);
    const fresh = new Scheduler(o, 100);
    for (const s of [live, copy, fresh])
      s.begin(101, ALL, createPurse(1e6, FLOORS));
    expect(live.offer(boat("b3"))).toBe(false);
    expect(live.lastRefusal).toBe("classCap");
    expect(copy.offer(boat("b3"))).toBe(false);
    expect(copy.lastRefusal).toBe("classCap");
    // Without the windows, the copy would send what live is capped out of.
    expect(fresh.offer(boat("b3"))).toBe(true);
    expect(copy.lastSent("boat")).toBe(100);

    // A minute later both age out alike; the copy's sends stay its own.
    for (const s of [live, copy]) s.begin(700, ALL, createPurse(1e6, FLOORS));
    expect(live.lastSent("boat")).toBeNull();
    expect(copy.lastSent("boat")).toBeNull();
    expect(copy.offer(boat("b4"))).toBe(true);
    sendAll(copy, 700);
    expect(copy.lastSent("boat")).toBe(700);
    expect(live.lastSent("boat")).toBeNull();
  });

  test("a copy keeps the cancel guard (DUP_GUARD_TICKS)", () => {
    const live = new Scheduler(o, 100);
    live.begin(200, ALL, createPurse(1e6, FLOORS));
    expect(
      live.offer({
        intent: { type: "cancel_attack", attackID: "a1" },
        prio: Prio.Recall,
        cls: "defense",
      }),
    ).toBe(true);
    sendAll(live, 200);
    const copy = new Scheduler(o, 100);
    copy.copyFrom(live);
    const at = 200 + DUP_GUARD_TICKS[0];
    copy.begin(at, ALL, createPurse(1e6, FLOORS));
    const attack: Proposal = {
      intent: { type: "attack", targetID: null, troops: 10 },
      prio: Prio.TN,
      cls: "tn",
    };
    expect(copy.offer(attack)).toBe(false);
    expect(copy.lastRefusal).toBe("dupGuard");
  });

  test("veto refuses a key until the next begin, as a taken key", () => {
    const s = new Scheduler(o, 100);
    s.begin(10, ALL, createPurse(1e6, FLOORS));
    s.veto("ally:X");
    const ally = (id: string): Proposal => ({
      intent: { type: "allianceRequest", recipient: id },
      prio: Prio.Diplomacy,
      cls: "diplomacy",
      key: `ally:${id}`,
    });
    expect(s.offer(ally("X"))).toBe(false);
    expect(s.lastRefusal).toBe("key");
    expect(s.stats.vetoed).toBe(1);
    expect(s.offer(ally("Y"))).toBe(true);
    s.begin(11, ALL, createPurse(1e6, FLOORS));
    expect(s.offer(ally("X"))).toBe(true);
  });
});

describe("BudgetMirror from the live limiter's state (package WP1)", () => {
  /** Tries one send at each time; the results in order. */
  function schedule(
    tryAt: (ms: number) => boolean,
    times: readonly number[],
  ): boolean[] {
    return times.map((t) => tryAt(t));
  }

  test("exact where the remaining-only mirror is not: a minute window the live limiter restarts sooner", () => {
    let now = 0;
    const live = new IntentBudget(() => now);
    // 100 intents in the first 15 s (the bucket refills 10 a second).
    for (let i = 0; i < 100; i++) {
      now = i * 150;
      expect(live.tryConsume()).toBe(true);
    }
    now = 50_000;
    const remaining = live.remaining();
    expect(remaining.perMinute).toBe(50);
    const exact = BudgetMirror.fromLive(remaining, now, live.state());
    const guess = BudgetMirror.fromLive(remaining, now);
    // 60 sends from 61 s on, 10 a second: the live window restarted at
    // 60 s, the guess assumes it began at 50 s.
    const times = Array.from({ length: 60 }, (_, i) => 61_000 + i * 100);
    const liveRuns = schedule((t) => {
      now = t;
      return live.tryConsume();
    }, times);
    expect(liveRuns.every((x) => x)).toBe(true);
    expect(schedule((t) => exact.tryConsume(t), times)).toEqual(liveRuns);
    expect(
      schedule((t) => guess.tryConsume(t), times).filter((x) => x),
    ).toHaveLength(50);
  });

  test("the state is a copy, read without moving the limiter; off gives no limits", () => {
    let now = 5_000;
    const live = new IntentBudget(() => now);
    live.tryConsume();
    const s1 = live.state()!;
    now = 70_000;
    const s2 = live.state()!;
    // Reading at a later clock moved neither the bucket nor the window.
    expect(s2.perMinute).toEqual(s1.perMinute);
    expect(s2.nowMs).toBe(70_000);
    s2.perSecond.content = -99;
    expect(live.state()!.perSecond.content).not.toBe(-99);
    const off = new IntentBudget(() => now, false);
    expect(off.state()).toBeNull();
    const m = BudgetMirror.fromLive(off.remaining(), now, off.state());
    expect(m.remaining(now)).toEqual({
      perSecond: Infinity,
      perMinute: Infinity,
    });
  });
});

describe("naval memos keyed by OwnerGrid stamp (package WP1)", () => {
  test("a copy's cloned grid hits the live memo; a View keyed by grid object misses", async () => {
    // Our land x < 40 with an ocean band x 40..79, land beyond.
    const f = await field({
      width: 120,
      height: 60,
      terrain: (x) => (x >= 40 && x < 80 ? "water" : "plains"),
    });
    own(f.me, rect(f.game, 0, 0, 40, 60));
    const o = parseApexOptions();
    const race = buildRaceGrid(f.game, o);
    const og = ownerGrid(f.game, race, 4);
    const shore = (y: number): TileRef => f.game.ref(39, y);
    const view = (sample: TileRef[], memos: NavalMemos | undefined) =>
      ({
        game: f.game,
        me: f.me,
        wm: { shoreSample: sample },
        navalMemos: memos,
      }) as unknown as Pick<View, "game" | "me" | "wm" | "navalMemos">;

    // Plain arrays: the test environment's structuredClone makes typed
    // arrays of another realm, which toEqual tells apart.
    const plain = (x: { dist: Int32Array; cell: number }) => ({
      cell: x.cell,
      dist: Array.from(x.dist),
    });
    const liveMemos = new NavalMemos();
    const live = view([shore(2)], liveMemos);
    const f1 = voyageOf(live, race, og);
    expect(plain(f1)).toEqual(plain(voyageField(f.game, race, [shore(2)])));
    // What a later scan (another shore sample) would compute.
    const later = plain(voyageField(f.game, race, [shore(57)]));
    expect(later).not.toEqual(plain(f1));

    // A rollout copy: its grid is a clone of live's (same stamp), its
    // memos a copy, its scan later.
    const og2 = structuredClone(og);
    const copyMemos = liveMemos.copy();
    const copy = view([shore(57)], copyMemos);
    const f2 = voyageOf(copy, race, og2);
    expect(plain(f2)).toEqual(plain(f1));
    expect(f2).not.toBe(f1);
    // Keyed by the grid object instead (a View without the memos), the
    // clone misses and computes the later field.
    expect(plain(voyageOf(view([shore(57)], undefined), race, og2))).toEqual(
      later,
    );
    // The copy's own next grid: computed fresh, and live keeps its memo.
    const og3 = { ...og2, stamp: og2.stamp + 100 };
    expect(plain(voyageOf(copy, race, og3))).toEqual(later);
    expect(voyageOf(live, race, og)).toBe(f1);
  });
});

describe("NukeModel.cloneFor (package WP1)", () => {
  test("carries the launch counts and gold samples; the copy then observes on its own", () => {
    const w = world(
      200,
      100,
      { N: PlayerType.Nation, H: PlayerType.Human },
      columns([
        ["N", 60],
        [null, 40],
        ["H", 100],
      ]),
    );
    const { N, H } = w.p;
    siloAt(w, N, 10, 50, 5);
    pastImmunity(w);
    const nuke = brain(w, "N", false);
    const m = model(w, "H");
    w.game.addPlayer(new PlayerInfo("X", PlayerType.Nation, null, idOf("X")));
    w.game.player(idOf("X")).conquer(w.game.ref(80, 0));
    setGold(N, 20_000_000n);
    m.exposures();
    for (const type of [UnitType.AtomBomb, UnitType.HydrogenBomb]) {
      nuke.sendNuke(w.game.ref(150, 50), type, H);
      tick(w, 2);
      m.observe();
    }
    setGold(N, 30_000_000n);
    tick(w, 50);
    m.exposures();
    const nm = new NationModel(w.game, H, "nuke-model", createModels(w.game));
    const c = m.cloneFor(w.game, H, nm);
    expect(c.launched(N.id())).toEqual(m.launched(N.id()));
    expect(c.launched(N.id())).toEqual({ atoms: 1, hydros: 1 });
    for (const t of [UnitType.AtomBomb, UnitType.HydrogenBomb] as const) {
      expect(c.perceivedCost(N.id(), t)).toBe(m.perceivedCost(N.id(), t));
    }
    expect(c.projectedGold(N.id(), 300)).toBe(m.projectedGold(N.id(), 300));
    expect(c.projectedGold(N.id(), 300)).toBeGreaterThan(N.gold());
    // A cold model has no samples: it projects today's gold.
    expect(model(w, "H").projectedGold(N.id(), 300)).toBe(N.gold());
    // Bombs already counted are not counted again; a new one once each.
    nuke.sendNuke(w.game.ref(150, 50), UnitType.AtomBomb, H);
    tick(w, 2);
    c.observe();
    expect(c.launched(N.id())).toEqual({ atoms: 2, hydros: 1 });
    expect(m.launched(N.id())).toEqual({ atoms: 1, hydros: 1 });
    m.observe();
    expect(m.launched(N.id())).toEqual(c.launched(N.id()));
  });
});

describe("NationModel.cloneFor (package WP1)", () => {
  beforeAll(() => {
    console.debug = () => {};
    console.warn = () => {};
  });

  test("the copy forecasts what the live model forecasts, on its game and on a fork", async () => {
    const arena = await apexArena({
      gameID: "WP1CLONE",
      map: GameMapType.Onion,
    });
    arena.playTo(900);
    const rt = (
      arena.policy as unknown as {
        rt: { nm: NationModel; models: Models; refreshList: string[] };
      }
    ).rt;
    const live = rt.nm;
    const me = arena.host.me();
    const game = arena.game;
    const fork = arena.host.fork();
    const forkMe = fork.game.playerByClientID(ME)!;
    const same = live.cloneFor(game, me, rt.models);
    const onFork = live.cloneFor(fork.game, forkMe, createModels(fork.game));
    const t = game.ticks();
    const home = me.troops();
    const nations = game
      .players()
      .filter((p) => p.type() === PlayerType.Nation && p.isAlive())
      .map((p) => p.id());
    expect(nations.length).toBeGreaterThan(0);
    expect(rt.refreshList.length).toBeGreaterThan(0);
    const forecast = (nm: NationModel) =>
      nations.map((n) => {
        const d1 = nm.nextDecision(n, t + 1);
        const d2 = nm.nextDecision(n, d1 + 1);
        return {
          n,
          st: nm.get(n) ?? null,
          d1,
          d2,
          T1: nm.troopsAt(n, d1),
          T2: nm.troopsAt(n, d2),
          gate: nm.gates(n, d1),
          cap: nm.sendCap(n, home),
          land: nm.canLandAttackUs(n, home, d1),
          target: nm.wouldTargetUs(n, home),
          ally: nm.acceptsAlliance(n, {
            kind: "request",
            createdAt: t,
            atTick: d1,
            embargoStoppedBy: null,
          }),
          rel: nm.relations.value(n, t),
        };
      });
    // The clones first: a forecast may fill the original's memos.
    const a = forecast(same);
    const b = forecast(onFork);
    const want = forecast(live);
    expect(a).toEqual(want);
    expect(b).toEqual(want);
    // Something was tracked: refreshed nations and relation values.
    expect(want.some((x) => x.st !== null && x.st.full)).toBe(true);
    expect(live.log).toEqual(same.log);
  }, 300_000);
});
