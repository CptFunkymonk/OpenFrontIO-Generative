/**
 * Package WP10b, the leader guard live (apex o.leaderGuard; lib/
 * LeaderGuard.ts, LeaderHook.ts): with it on, apex keeps its home at a
 * strong ally's betrayal line while it expands; without it, the ally
 * betrays it.
 *
 * Mechanics [PIN Betrayal]: at a decision that reaches its strategy list,
 * an Impossible ally whose only bordering player is us betrays us (rule
 * (c), NationAllianceBehavior.maybeBetray :450-457) once 3 x our home
 * troops < its troops, and attacks at once; rule (a) (:414-423) betrays
 * the juiciest bordering ally when its troops + attacks and the others'
 * are under 0.33 of the nation's.
 *
 * Setting: a synthetic 200 x 100 plains field (as WebKeep.test.ts): a
 * tribe on x < 60, rows 10-99 (at its cap, 149k troops), free land on x <
 * 60, rows 0-9, us on [60, 120), the ally Z on [120, 200) (it borders only
 * us: no free land, no tribe) with one City (cap 987k, 2.1x ours) at its
 * cap, run by the real NationExecution; PlayerExecutions regrow our troops
 * and the tribe's. Apex plays its defaults. Without the guard it sends
 * 273k troops at the tribe in tick 0 (its H floor is 0.3 of our cap):
 * home 232k at Z's first decision, under T/3 = 329k. With it, H is Z's
 * line, 1.05 T/3 = 345k (0.73 of our cap): the tribe's stack does not fit
 * (a tribe that does not fit is skipped), and apex takes the free strip
 * only.
 */
import { AgentIntent } from "../../../src/agent/Agent";
import {
  BREAK_LAG,
  type LeaderMemory,
} from "../../../src/agent/agents/apex/LeaderHook";
import { parseApexOptions } from "../../../src/agent/agents/apex/options";
import { ApexPolicy } from "../../../src/agent/agents/apex/policy";
import { ApexState, createState } from "../../../src/agent/agents/apex/state";
import {
  attackStep,
  breakStep,
} from "../../../src/agent/lib/search/cands/core";
import { Config } from "../../../src/core/configuration/Config";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import {
  Cell,
  Game,
  Nation,
  PlayerInfo,
  PlayerType,
  UnitType,
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
const Z = "NATIONZZ";

interface Run {
  /** Tick the alliance with Z ended (null: it held). */
  brokeAt: number | null;
  /** Z turned traitor (it broke the alliance). */
  zTraitor: boolean;
  /** Our home troops and Z's troops at each of Z's decision ticks while
   *  allied. */
  decisions: { tick: number; home: number; T: number }[];
  tiles0: number;
  tiles: number;
  sent: AgentIntent[];
  s: ApexState;
  cap: number;
}

/** The field, apex with `options`, stepped `ticks` ticks. */
function play(options: Record<string, unknown>, ticks: number): Run {
  const t = new Uint8Array(W * H).fill(LAND);
  const m = new Uint8Array((W / 2) * (H / 2)).fill(LAND);
  const map = new GameMapImpl(W, H, t, W * H);
  const mini = new GameMapImpl(W / 2, H / 2, m, (W * H) / 4);
  const config = new Config(GAME_CONFIG, null, false);
  const game: Game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    [
      new Nation(
        new Cell(160, 50),
        new PlayerInfo("zeta", PlayerType.Nation, null, Z),
      ),
    ],
    map,
    mini,
    config,
  );
  game.endSpawnPhase();
  const us = game.player(AGENT_ID);
  const z = game.player(Z);
  const tribe = game.addPlayer(
    new PlayerInfo("tribe", PlayerType.Bot, null, "TRIBE001"),
  );
  for (let y = 0; y < H; y++) {
    if (y >= 10) for (let x = 0; x < 60; x++) tribe.conquer(game.ref(x, y));
    for (let x = 60; x < 120; x++) us.conquer(game.ref(x, y));
    for (let x = 120; x < W; x++) z.conquer(game.ref(x, y));
  }
  z.buildUnit(UnitType.City, game.ref(170, 50), {});
  const req = z.createAllianceRequest(us);
  if (req === null) throw new Error("no alliance request");
  req.accept();
  us.setTroops(Math.floor(config.maxTroops(us)));
  z.setTroops(Math.floor(config.maxTroops(z)));
  tribe.setTroops(Math.floor(config.maxTroops(tribe)));
  game.addExecution(new PlayerExecution(us));
  game.addExecution(new PlayerExecution(tribe));
  const nation = new NationExecution(
    GAME_ID,
    new Nation(new Cell(160, 50), z.info()),
  );
  game.addExecution(nation);
  const f: Field = {
    game,
    config,
    me: us,
    executor: new Executor(game, GAME_ID, undefined),
  };
  const s = createState();
  const policy = new ApexPolicy(parseApexOptions(options), s);
  const h = new Harness(f, (ctx) => policy.tick(ctx));
  const n = nation as unknown as { attackRate: number; attackTick: number };
  const run: Run = {
    brokeAt: null,
    zTraitor: false,
    decisions: [],
    tiles0: us.numTilesOwned(),
    tiles: 0,
    sent: [],
    s,
    cap: config.maxTroops(us),
  };
  for (let i = 0; i < ticks; i++) {
    const tick = game.ticks();
    // Z decides in the tick `tick` runs (its NationExecution reads the
    // state the last tick left, as our home is now).
    if (
      run.brokeAt === null &&
      n.attackRate !== undefined &&
      tick % n.attackRate === n.attackTick
    ) {
      run.decisions.push({ tick, home: us.troops(), T: z.troops() });
    }
    run.sent.push(...h.step());
    if (run.brokeAt === null && !us.isAlliedWith(z)) {
      run.brokeAt = game.ticks();
      run.zTraitor = z.isTraitor();
    }
  }
  run.tiles = us.numTilesOwned();
  return run;
}

/** The player's troops against the rule (c) line at each decision. */
function underLine(r: Run): { tick: number; home: number; T: number }[] {
  return r.decisions.filter((d) => 3 * d.home < d.T);
}

describe("WP10b leader guard: a strong ally's betrayal line, live", () => {
  test(
    "without the guard, apex's free-land sends take home under the ally's line and the ally betrays it",
    { timeout: 120_000 },
    () => {
      const r = play({}, 600);
      // The tribe attack: most of our home.
      const big = r.sent.filter(
        (i) => i.type === "attack" && i.targetID === "TRIBE001",
      );
      expect(big.length).toBeGreaterThan(0);
      expect(underLine(r).length).toBeGreaterThan(0);
      expect(r.brokeAt).not.toBeNull();
      expect(r.brokeAt!).toBeLessThan(100);
      // Z broke it (it turned traitor): a betrayal, not an expiry.
      expect(r.zTraitor).toBe(true);
      expect(r.s.leader).toBeUndefined();
    },
  );

  test(
    "with the guard, home stays at the line at every decision of the ally, the alliance holds, and apex still expands",
    { timeout: 120_000 },
    () => {
      const r = play({ leaderGuard: true }, 600);
      expect(r.brokeAt).toBeNull();
      expect(r.decisions.length).toBeGreaterThan(10);
      expect(underLine(r)).toEqual([]);
      expect(r.tiles).toBeGreaterThan(r.tiles0);
      // The guard's memory is plain data: JSON keeps the whole state.
      expect(JSON.parse(JSON.stringify(r.s))).toEqual(r.s);
      const mem = r.s.leader as LeaderMemory;
      expect(mem.lines).toHaveLength(1);
      expect(mem.lines[0]).toMatchObject({ id: Z, rule: "alone" });
      // The floor is the rule (c) line with the margin, holdable (under
      // 0.8 of our cap), so no cap is asked for.
      expect(mem.floor).toBe(mem.lines[0].home);
      expect(mem.floor).toBe(Math.ceil((mem.lines[0].T * 1.05) / 3));
      expect(mem.floor).toBeGreaterThan(0.7 * r.cap);
      expect(mem.capShort).toBe(0);
      // No attack on the tribe: its stack does not fit above the floor.
      expect(
        r.sent.some((i) => i.type === "attack" && i.targetID === "TRIBE001"),
      ).toBe(false);
    },
  );
});

/**
 * The cap signal (o.leaderCap): a tribe on x < 10 (a third player: with two
 * left an ally bombs us, NNB :224-233), us on [10, 120) (11,000 tiles, cap
 * 632k, gold 3M), the ally Z on [120, 200) with a level-3 City (cap 1.61M)
 * at its cap, a finished silo and 1M gold, inert (no NationExecution: its
 * gold stays). Z borders only us, so its line is rule (c)'s, 1.05 T/3 =
 * 564k, above 0.8 of our cap (506k): it asks for cap, and (review F4) our
 * home at the cap holds it, so it is the floor meanwhile. Today's City rule
 * refuses every site (a nation with a finished silo and an atom's gold,
 * EconomyController.exposedSite); with the guard the gold arm's gate
 * ("model": Z, our ally, aims no bomb at us) buys the one level that makes
 * the line holdable (632k + 250k: 0.8 x 882k = 706k).
 */
function playCap(options: Record<string, unknown>, ticks: number) {
  const t = new Uint8Array(W * H).fill(LAND);
  const m = new Uint8Array((W / 2) * (H / 2)).fill(LAND);
  const map = new GameMapImpl(W, H, t, W * H);
  const mini = new GameMapImpl(W / 2, H / 2, m, (W * H) / 4);
  const config = new Config(GAME_CONFIG, null, false);
  const game: Game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    [
      new Nation(
        new Cell(160, 50),
        new PlayerInfo("zeta", PlayerType.Nation, null, Z),
      ),
    ],
    map,
    mini,
    config,
  );
  game.endSpawnPhase();
  const us = game.player(AGENT_ID);
  const z = game.player(Z);
  // A third player (else two are left, and an ally bombs, NNB :224-233).
  const tribe = game.addPlayer(
    new PlayerInfo("tribe", PlayerType.Bot, null, "TRIBE001"),
  );
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < 10; x++) tribe.conquer(game.ref(x, y));
    for (let x = 10; x < 120; x++) us.conquer(game.ref(x, y));
    for (let x = 120; x < W; x++) z.conquer(game.ref(x, y));
  }
  tribe.setTroops(Math.floor(config.maxTroops(tribe)));
  const city = z.buildUnit(UnitType.City, game.ref(170, 50), {});
  city.increaseLevel();
  city.increaseLevel();
  z.buildUnit(UnitType.MissileSilo, game.ref(180, 20), {});
  z.addGold(1_000_000n);
  us.addGold(3_000_000n);
  const req = z.createAllianceRequest(us);
  if (req === null) throw new Error("no alliance request");
  req.accept();
  us.setTroops(Math.floor(config.maxTroops(us)));
  z.setTroops(Math.floor(config.maxTroops(z)));
  game.addExecution(new PlayerExecution(us));
  const f: Field = {
    game,
    config,
    me: us,
    executor: new Executor(game, GAME_ID, undefined),
  };
  const s = createState();
  const policy = new ApexPolicy(parseApexOptions(options), s);
  const h = new Harness(f, (ctx) => policy.tick(ctx));
  const cap0 = config.maxTroops(us);
  const shorts: number[] = [];
  const floors: number[] = [];
  for (let i = 0; i < ticks; i++) {
    h.step();
    if (s.leader !== undefined) {
      shorts.push(s.leader.capShort);
      floors.push(s.leader.floor);
    }
  }
  return {
    us,
    z,
    s,
    cap0,
    cap: config.maxTroops(us),
    shorts,
    floors,
    logs: h.logs,
  };
}

describe("WP10b leader guard: a line above our cap buys City levels", () => {
  test(
    "without the guard no City goes up (today's rule refuses every site); with it, the one level that makes the ally's line holdable",
    { timeout: 120_000 },
    () => {
      const off = playCap({}, 200);
      expect(off.us.unitCount(UnitType.City)).toBe(0);
      expect(off.cap).toBe(off.cap0);
      const on = playCap({ leaderGuard: true }, 200);
      // The line asked for cap first (held by home at the cap meanwhile) ...
      expect(on.shorts[0]).toBeGreaterThan(0);
      expect(on.floors[0]).toBeGreaterThan(0.8 * on.cap0);
      // ... one City level went up and finished ...
      expect(on.us.unitCount(UnitType.City)).toBe(1);
      expect(on.cap).toBe(on.cap0 + 250_000);
      // ... and the line is holdable now: the floor, no cap asked.
      const mem = on.s.leader as LeaderMemory;
      expect(mem.capShort).toBe(0);
      expect(mem.floor).toBe(mem.lines[0].home);
      expect(mem.floor).toBeGreaterThan(0.8 * on.cap0);
      expect(mem.floor).toBeLessThanOrEqual(0.8 * on.cap);
      expect(on.logs.some((l) => / city build .*arm=model/.test(l))).toBe(true);
    },
  );
});

/**
 * Review F1: the strike that follows our own break. The search's break
 * candidate (lib/search/cands/core.ts) breaks with an ally Y at t and
 * attacks it at t + 1 with half of purse.available("strike"), and the
 * break makes us a traitor only in turn t + 1 (BreakAllianceExecution), so
 * me.isTraitor() is false until t + 2 and the floors of the decision at t
 * did not count it: the strike took home under the 1.2 T line of rule (b)
 * of our other bordering ally Z, which betrayed us at its next decision.
 * The guard now reads the directive's steps due before the next recompute
 * (LeaderHook.pendingIntents, lib/LeaderGuard.alliancesEndedBy) and holds
 * the traitor lines already.
 *
 * Setting (the reviewer's scratch test): 200 x 100 plains; Y (inert, 20k
 * troops) on x < 40, us on [40, 150), Z on [150, 200) with 0.6 of our cap
 * in troops, run by the real NationExecution; both allied with us; only
 * our troops regrow. Z borders only us. The directive is set `lead` ticks
 * before a decision of Z's, at one of our decision ticks or `off` ticks
 * after one (the search acts at any tick: LeaderHook.leaderRefloor puts
 * the break on the floors then; with off 2 our next decision falls on the
 * strike's tick, when the break is gone from the directive and not yet in
 * the game, so the pending break is carried in s.leader).
 */
const Y = "NATIONYY";

function playBreak(options: Record<string, unknown>, lead: number, off = 0) {
  const t = new Uint8Array(W * H).fill(LAND);
  const m = new Uint8Array((W / 2) * (H / 2)).fill(LAND);
  const map = new GameMapImpl(W, H, t, W * H);
  const mini = new GameMapImpl(W / 2, H / 2, m, (W * H) / 4);
  const config = new Config(GAME_CONFIG, null, false);
  const game: Game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    [
      new Nation(
        new Cell(175, 50),
        new PlayerInfo("zeta", PlayerType.Nation, null, Z),
      ),
      new Nation(
        new Cell(20, 50),
        new PlayerInfo("ypsilon", PlayerType.Nation, null, Y),
      ),
    ],
    map,
    mini,
    config,
  );
  game.endSpawnPhase();
  const us = game.player(AGENT_ID);
  const z = game.player(Z);
  const y = game.player(Y);
  for (let yy = 0; yy < H; yy++) {
    for (let x = 0; x < 40; x++) y.conquer(game.ref(x, yy));
    for (let x = 40; x < 150; x++) us.conquer(game.ref(x, yy));
    for (let x = 150; x < W; x++) z.conquer(game.ref(x, yy));
  }
  for (const other of [z, y]) {
    const req = other.createAllianceRequest(us);
    if (req === null) throw new Error("no alliance request");
    req.accept();
  }
  us.setTroops(Math.floor(config.maxTroops(us)));
  z.setTroops(Math.floor(0.6 * config.maxTroops(us)));
  y.setTroops(20_000);
  game.addExecution(new PlayerExecution(us));
  const nation = new NationExecution(
    GAME_ID,
    new Nation(new Cell(175, 50), z.info()),
  );
  game.addExecution(nation);
  const f: Field = {
    game,
    config,
    me: us,
    executor: new Executor(game, GAME_ID, undefined),
  };
  const s = createState();
  const policy = new ApexPolicy(parseApexOptions(options), s);
  const h = new Harness(f, (ctx) => policy.tick(ctx));
  const n = nation as unknown as { attackRate: number; attackTick: number };
  const think = parseApexOptions(options).thinkEvery;
  // Play to `off` ticks after one of our decisions, `lead` ticks before
  // one of Z's.
  let t0 = -1;
  for (let i = 0; i < 400 && t0 < 0; i++) {
    const tick = game.ticks();
    if (
      n.attackRate !== undefined &&
      tick > 60 &&
      tick - s.timers.lastThink === (off === 0 ? think : off)
    ) {
      const off =
        (((n.attackTick - tick) % n.attackRate) + n.attackRate) %
        n.attackRate;
      if (off === lead) {
        t0 = tick;
        break;
      }
    }
    h.step();
  }
  expect(t0).toBeGreaterThan(0);
  policy.setDirective([
    breakStep(Y, t0),
    attackStep(Y, y.smallID(), t0 + 1, 0.5),
  ]);
  let brokeAt: number | null = null;
  let strike = 0;
  let pending: LeaderMemory["pending"] | undefined;
  const decisions: { tick: number; home: number; T: number }[] = [];
  for (let i = 0; i < 120; i++) {
    const tick = game.ticks();
    if (
      brokeAt === null &&
      us.isTraitor() &&
      tick % n.attackRate === n.attackTick
    ) {
      decisions.push({ tick, home: us.troops(), T: z.troops() });
    }
    for (const it of h.step()) {
      if (it.type === "attack" && it.targetID === Y && tick === t0 + 1) {
        strike = it.troops ?? 0;
      }
    }
    if (tick === t0) pending = s.leader?.pending;
    if (brokeAt === null && !us.isAlliedWith(z)) brokeAt = game.ticks();
  }
  return { t0, brokeAt, strike, pending, decisions, us, y, z, s };
}

describe("WP10b leader guard: the strike after our own break (review F1)", () => {
  for (const [lead, at] of [
    [4, 0],
    [8, 0],
    [4, 1],
    [4, 2],
  ]) {
    test(
      `Z decides ${lead} ticks after a break ${at} ticks after our decision: off, the strike takes home under Z's traitor line and Z betrays; on, the strike is sized above it and the alliance holds`,
      { timeout: 120_000 },
      () => {
        const off = playBreak({}, lead, at);
        expect(off.us.isAlliedWith(off.y)).toBe(false);
        expect(off.strike).toBeGreaterThan(0);
        expect(off.decisions.length).toBeGreaterThan(0);
        const first = off.decisions[0];
        expect(first.home).toBeLessThan(1.2 * first.T);
        expect(off.brokeAt).not.toBeNull();
        expect(off.brokeAt!).toBeLessThanOrEqual(first.tick + 1);

        const on = playBreak({ leaderGuard: true }, lead, at);
        expect(on.t0).toBe(off.t0);
        expect(on.us.isAlliedWith(on.y)).toBe(false);
        // The floors of the break's tick counted us a traitor already,
        // until the game shows the break ...
        expect(on.pending).toEqual({
          traitor: true,
          leaving: [Y],
          until: on.t0 + BREAK_LAG,
        });
        // ... so the strike went out, smaller, above Z's rule (b) line.
        expect(on.strike).toBeGreaterThan(0);
        expect(on.strike).toBeLessThan(off.strike);
        expect(on.decisions.length).toBeGreaterThan(0);
        for (const d of on.decisions) {
          expect(d.home).toBeGreaterThanOrEqual(1.2 * d.T);
        }
        expect(on.brokeAt).toBeNull();
        expect(on.us.isAlliedWith(on.z)).toBe(true);
      },
    );
  }
});
