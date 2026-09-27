import { AgentIntent } from "../../../src/agent/Agent";
import {
  BETRAY_SHARE,
  contactAtLeast,
  deterrenceFloor,
  exposedNations,
  postCover,
  reachableTiles,
  STRIKE_REST,
  StrikeController,
  strikeMemory,
  targetNeighbours,
  TOPUP_LEAD,
} from "../../../src/agent/agents/apex/controllers/StrikeController";
import { homeFloors } from "../../../src/agent/agents/apex/HomeTarget";
import {
  ApexOptions,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import { homeAvailable, View } from "../../../src/agent/agents/apex/policy";
import { ApexState, createState } from "../../../src/agent/agents/apex/state";
import { Ledger } from "../../../src/agent/lib/Ledger";
import { createModels } from "../../../src/agent/lib/Models";
import { NationModel } from "../../../src/agent/lib/NationModel";
import { createPurse, Prio, Scheduler } from "../../../src/agent/lib/Scheduler";
import { scanWorld, WorldModel } from "../../../src/agent/lib/WorldModel";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import {
  Cell,
  Execution,
  Nation,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../../src/core/game/Game";
import { Field, field, GAME_ID, own, rect, submit } from "./Field";

// Window strikes (spec §5.2, package A1) against a real Impossible nation:
// a plains field (tests/agent/apex/Field.ts, the real Config) with us on
// the left 100 columns and one nation, run by its real NationExecution
// seeded from the field's game ID, on the right 20; both regrow
// (PlayerExecution). The StrikeController runs over a View built as the
// policy builds it, with stall mode forced on; what it offers goes through
// the agent's intent path. Tests set troops directly; agents never may.
//
// Pinned here: a W1 strike launched at d + 1 draws no answer through the
// nation's next two decisions; an overwhelming strike above its trigger is
// answered at a decision, but the answer is cancelled whole by our stack
// (nothing lands on us) and our attack goes on; allies, allySet nations and
// non-stall ticks are never struck; the top-up goes TOPUP_LEAD ticks before
// a decision.

const W = 120;
const H = 60;
const US = 100;
const NATION_ID = "NATION01";

interface Scene {
  f: Field;
  nation: Player;
  rate: number;
  phase: number;
  /** Ticks at which the nation created an attack on us. */
  answers: number[];
}

/** `gap`: a lake column at x = US between us and the nation, open only
 *  in rows [28, 28 + gap), so the front is `gap` tiles wide (a lake, not
 *  ocean: no boats). `split`: a lake column at x = split across the whole
 *  field, which cuts the nation's land in two. */
async function scene(
  gap: number | null = null,
  split: number | null = null,
): Promise<Scene> {
  const f = await field({
    width: W,
    height: H,
    terrain: (x, y) =>
      (gap !== null && x === US && (y < 28 || y >= 28 + gap)) || x === split
        ? "lake"
        : "plains",
  });
  const { game, me } = f;
  own(me, rect(game, 0, 0, US, H));
  const nationObj = new Nation(
    new Cell(110, 30),
    new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
  );
  const nation = game.addPlayer(nationObj.playerInfo);
  own(
    nation,
    rect(game, US, 0, W, H).filter((t) => game.isLand(t)),
  );
  game.addExecution(new PlayerExecution(me));
  game.addExecution(new PlayerExecution(nation));
  const exec = new NationExecution(GAME_ID, nationObj);
  game.addExecution(exec);
  const n = exec as unknown as { attackRate: number; attackTick: number };
  const answers: number[] = [];
  const add = game.addExecution.bind(game);
  game.addExecution = (...execs: Execution[]) => {
    for (const e of execs) {
      if (!(e instanceof AttackExecution)) continue;
      const owner = (e as unknown as { _owner: Player })._owner;
      if (owner === nation && e.targetID() === me.id()) {
        answers.push(game.ticks());
      }
    }
    add(...execs);
  };
  // Past the nations' spawn immunity and the nation's opening send.
  for (let i = 0; i < 70; i++) game.executeNextTick();
  return { f, nation, rate: n.attackRate, phase: n.attackTick, answers };
}

/** Apex's defaults since package A1's adoption (strikes on, with
 *  strikeMinContact 8, strikeDetNearTarget, strikeDetNearReach and
 *  strikeLiveCheck); tests that need a sub-option off pin it. */
const STRIKES: ApexOptions = parseApexOptions({ strikes: true });
/** The small field holds a nation at 0.8 of its cap at a density of about
 *  200 troops a tile (real nations: 20-40), so tiles are dear there: the
 *  value rule is off where the answer's mechanics are the point. */
const ANY_VALUE: ApexOptions = parseApexOptions({
  strikes: true,
  strikeMinValue: 0,
});

interface Run {
  s: ApexState;
  nm: NationModel;
  ledger: Ledger;
  wm: WorldModel | null;
  logs: string[];
}

function run(sc: Scene, s: ApexState): Run {
  const { game, me } = sc.f;
  return {
    s,
    nm: new NationModel(game, me, GAME_ID, createModels(game)),
    ledger: new Ledger(),
    wm: null,
    logs: [],
  };
}

/** One onTick of the StrikeController over a View as the policy builds it;
 *  returns what it offered (flushed as the policy flushes). `before` runs
 *  first, as the controllers that tick before it do (Defense, Diplomacy). */
function strikeTick(
  sc: Scene,
  o: ApexOptions,
  r: Run,
  before?: (v: View) => void,
  apply: (i: AgentIntent) => boolean = () => true,
): AgentIntent[] {
  const { game, me } = sc.f;
  const tick = game.ticks();
  const models = createModels(game);
  r.ledger.observe(me, tick, game);
  r.nm.observe(tick);
  r.wm = scanWorld(game, me, r.wm);
  const floors = homeFloors({ tick, o, me, models, nm: r.nm }, r.s);
  const purse = createPurse(homeAvailable(me, floors), floors);
  const scheduler = new Scheduler(o, game.config().msPerTick());
  scheduler.begin(tick, { perSecond: 10, perMinute: 150 }, purse);
  const v: View = {
    game,
    me,
    tick,
    gameID: GAME_ID,
    o,
    models,
    wm: r.wm,
    nm: r.nm,
    ledger: r.ledger,
    race: null,
    owners: null,
    scheduler,
    purse,
    lookahead: null,
    forRollout: null,
    live: null,
    log: (line) => r.logs.push(line),
  };
  before?.(v);
  new StrikeController().onTick(v, r.s);
  const sent: AgentIntent[] = [];
  scheduler.flush(
    (i) => {
      sent.push(i);
      return "ok";
    },
    r.ledger,
    tick,
  );
  for (const x of sent) if (apply(x)) submit(sc.f, x);
  return sent;
}

/** Stall mode on since long ago. */
function stalled(): ApexState {
  const s = createState();
  s.stall.since = 0;
  return s;
}

const incomingFrom = (me: Player, n: Player) =>
  me.incomingAttacks().filter((a) => a.attacker() === n);
const ourAttackOn = (me: Player, n: Player) =>
  me.outgoingAttacks().filter((a) => a.target() === n);

/** Runs strikeTick every tick, holding both sides' troops at these shares
 *  of their caps until the first launch; returns the launch tick and
 *  intent (or null after `ticks`). */
function untilLaunch(
  sc: Scene,
  r: Run,
  o: ApexOptions,
  nationShare: number,
  ticks: number,
): { tick: number; intent: AgentIntent } | null {
  const { game, me, config } = sc.f;
  for (let i = 0; i < ticks; i++) {
    sc.nation.setTroops(Math.round(nationShare * config.maxTroops(sc.nation)));
    me.setTroops(Math.round(0.95 * config.maxTroops(me)));
    const tick = game.ticks();
    const sent = strikeTick(sc, o, r);
    if (sent.length > 0) {
      game.executeNextTick();
      return { tick, intent: sent[0] };
    }
    game.executeNextTick();
  }
  return null;
}

describe("apex window strikes (§5.2, package A1)", () => {
  test("W1: launched one tick after the nation's decision with the conquest stack; no answer through its next two decisions", async () => {
    const sc = await scene();
    const { game, me, config } = sc.f;
    const r = run(sc, stalled());
    expect(r.nm.params(NATION_ID)).toMatchObject({
      rate: sc.rate,
      phase: sc.phase,
    });
    const M = config.maxTroops(sc.nation);
    const reserve = r.nm.params(NATION_ID).reserve;
    const launch = untilLaunch(sc, r, STRIKES, 0.08, 3 * sc.rate);
    expect(launch).not.toBeNull();
    const t0 = launch!.tick;
    // One tick after its decision.
    expect((t0 - 1) % sc.rate).toBe(sc.phase);
    const line = r.logs.find((l) => l.includes("wstrike"))!;
    expect(line).toContain(" W1 ");
    // The stack: T1/0.6·1.1 at least (the kill cost may ask more), and
    // well under what the purse holds.
    const T = 0.08 * M;
    const troops = (launch!.intent as { troops: number }).troops;
    expect(troops).toBeGreaterThanOrEqual(Math.floor((T / 0.6) * 1.1));
    expect(troops).toBeLessThan(0.5 * config.maxTroops(me));
    expect(strikeMemory(r.s).stats.launches).toBe(1);
    expect(ourAttackOn(me, sc.nation).length).toBe(1);
    const tilesAtLaunch = sc.nation.numTilesOwned();
    // Its next two decisions see our attack and answer neither time (its
    // troops stay below its reserve: our attack only lowers them).
    let decisions = 0;
    while (game.ticks() <= t0 - 1 + 2 * sc.rate) {
      if (game.ticks() % sc.rate === sc.phase) {
        decisions++;
        expect(sc.nation.troops()).toBeLessThan(reserve * M);
      }
      strikeTick(sc, STRIKES, r);
      game.executeNextTick();
      expect(incomingFrom(me, sc.nation)).toEqual([]);
    }
    expect(decisions).toBe(2);
    expect(sc.answers).toEqual([]);
    expect(sc.nation.numTilesOwned()).toBeLessThan(tilesAtLaunch);
  });

  test("overwhelm: above its trigger the nation answers, but our stack cancels the answer whole and goes on", async () => {
    // A 4-tile front, so the nation lives to its decisions (on the open
    // field the stack annexes it within its rate − 1 unseen ticks). That is
    // under the default strikeMinContact (8), which skips it before any
    // window is read: 0 here.
    const sc = await scene(4);
    const { game, me, config } = sc.f;
    const r = run(sc, stalled());
    const M = config.maxTroops(sc.nation);
    const p = r.nm.params(NATION_ID);
    const front4 = (o: ApexOptions): ApexOptions => ({
      ...o,
      strikeMinContact: 0,
    });
    // At the default value rule it is not worth it.
    const dear = run(sc, stalled());
    expect(
      untilLaunch(sc, dear, front4(STRIKES), 0.8, sc.rate + 2),
    ).toBeNull();
    expect(strikeMemory(dear.s).stats.skips.value).toBeGreaterThan(0);
    const launch = untilLaunch(sc, r, front4(ANY_VALUE), 0.8, 3 * sc.rate);
    expect(launch).not.toBeNull();
    const t0 = launch!.tick;
    const line = r.logs.find((l) => l.includes("wstrike"))!;
    expect(line).toContain(" overwhelm ");
    const S = (launch!.intent as { troops: number }).troops;
    // At least its troops (ratio ≤ 1 after the answer), more than the
    // answer bound T − reserve·M.
    expect(S).toBeGreaterThan(0.8 * M);
    // Up to three decisions (a random boat pre-empts 1 in 10). Its troops
    // are held at 0.8 of its cap (a test lever): at ~200 a tile our attack
    // would drain it below its reserve before it decides.
    while (sc.answers.length === 0 && game.ticks() <= t0 - 1 + 3 * sc.rate) {
      sc.nation.setTroops(Math.round(0.8 * M));
      game.executeNextTick();
      expect(incomingFrom(me, sc.nation)).toEqual([]);
    }
    expect(sc.answers.length).toBeGreaterThan(0);
    expect(sc.answers[0] % sc.rate).toBe(sc.phase);
    for (let i = 0; i < 3; i++) {
      game.executeNextTick();
      // The answer never reaches our land: the 1:1 cancel deleted it.
      expect(incomingFrom(me, sc.nation)).toEqual([]);
    }
    const ours = ourAttackOn(me, sc.nation);
    expect(ours.length).toBe(1);
    expect(ours[0].troops()).toBeGreaterThan(0);
    // It kept about its reserve at home (it sent T − reserve·M).
    expect(sc.nation.troops()).toBeLessThan((p.reserve + 0.05) * M);
  });

  test("never an ally, an allySet nation, or outside stall mode; on by default, never with strikes false", async () => {
    const sc = await scene();
    const { game, me } = sc.f;
    // On by default since package A1's adoption, with the review's launch
    // filters: STRIKES are apex's defaults.
    expect(parseApexOptions()).toEqual(STRIKES);
    expect(STRIKES).toMatchObject({
      strikes: true,
      strikeMinContact: 8,
      strikeDetNearTarget: true,
      strikeDetNearReach: true,
      strikeLiveCheck: true,
    });
    const cases: { o: ApexOptions; s: () => ApexState }[] = [
      { o: parseApexOptions({ strikes: false }), s: stalled },
      { o: STRIKES, s: createState },
      {
        o: STRIKES,
        s: () => {
          const s = stalled();
          s.web.allySet = [NATION_ID];
          return s;
        },
      },
    ];
    for (const c of cases) {
      const r = run(sc, c.s());
      for (let i = 0; i < sc.rate + 2; i++) {
        expect(strikeTick(sc, c.o, r)).toEqual([]);
        game.executeNextTick();
      }
    }
    me.createAllianceRequest(sc.nation)!.accept();
    expect(me.isAlliedWith(sc.nation)).toBe(true);
    const r = run(sc, stalled());
    expect(untilLaunch(sc, r, STRIKES, 0.08, sc.rate + 2)).toBeNull();
  });

  test("top-up: TOPUP_LEAD ticks before the nation's decision, a stack short of the conquest stack is raised", async () => {
    const sc = await scene();
    const { game, me, config } = sc.f;
    const r = run(sc, stalled());
    const M = config.maxTroops(sc.nation);
    const launch = untilLaunch(sc, r, STRIKES, 0.08, 3 * sc.rate);
    expect(launch).not.toBeNull();
    // The nation regains troops (a test lever: think of a refund); our
    // stack is now short of T/0.6·1.1.
    sc.nation.setTroops(Math.round(0.25 * M));
    me.setTroops(Math.round(0.95 * config.maxTroops(me)));
    let topUpAt = -1;
    for (let i = 0; i < sc.rate + 2 && topUpAt < 0; i++) {
      const tick = game.ticks();
      const sent = strikeTick(sc, STRIKES, r);
      if (sent.length > 0) {
        topUpAt = tick;
        expect(sent[0]).toMatchObject({ type: "attack", targetID: NATION_ID });
      }
      game.executeNextTick();
    }
    expect(topUpAt).toBeGreaterThan(0);
    expect((topUpAt + TOPUP_LEAD) % sc.rate).toBe(sc.phase);
    expect(strikeMemory(r.s).stats.topUps).toBe(1);
    expect(r.logs.some((l) => l.includes("wtopup"))).toBe(true);
    // One attack (the top-up absorbed the first), larger than the nation.
    const ours = ourAttackOn(me, sc.nation);
    expect(ours.length).toBe(1);
    expect(ours[0].troops()).toBeGreaterThan(sc.nation.troops() / 0.6);
  });

  test("deterrence: a strike keeps home above every other bordering nation's land line, and the betrayal line of an ally", async () => {
    // Us on the left half; nation A top right, nation B bottom right.
    const f = await field({ width: 80, height: 40 });
    const { game, me, config } = f;
    own(me, rect(game, 0, 0, 40, 40));
    const add = (id: string, y0: number) => {
      const n = game.addPlayer(new PlayerInfo(id, PlayerType.Nation, null, id));
      own(n, rect(game, 40, y0, 80, y0 + 20));
      return n;
    };
    const A = add("NATIONA1", 0);
    const B = add("NATIONB1", 20);
    for (let i = 0; i < 60; i++) game.executeNextTick();
    A.setTroops(Math.round(0.2 * config.maxTroops(A)));
    B.setTroops(Math.round(0.95 * config.maxTroops(B)));
    me.setTroops(Math.round(0.9 * config.maxTroops(me)));
    const nm = new NationModel(game, me, GAME_ID, createModels(game));
    const tick = game.ticks();
    nm.observe(tick);
    const v = {
      o: STRIKES,
      wm: scanWorld(game, me, null),
      nm,
      game,
      me,
      tick,
      models: createModels(game),
    };
    expect(v.wm.nations.map((n) => n.id).sort()).toEqual([
      "NATIONA1",
      "NATIONB1",
    ]);
    // B above its trigger, nothing locking it: its line binds a strike on
    // A; A (below its reserve) never binds a strike on B.
    const dB = nm.nextDecision(B.id(), tick);
    expect(nm.gates(B.id(), dB)).toBe("open");
    expect(deterrenceFloor(v, A.id())).toBeCloseTo(
      (nm.troopsAt(B.id(), dB) + 1) / nm.sendCapSafe(),
      6,
    );
    expect(nm.gates(A.id(), nm.nextDecision(A.id(), tick))).toBe(
      "belowReserve",
    );
    expect(deterrenceFloor(v, B.id())).toBe(0);
    // The line is tight: B cannot land-attack the home a strike leaves at
    // the floor, and can 20% below it.
    const floor = deterrenceFloor(v, A.id());
    expect(nm.canLandAttackUs(B.id(), floor + 1, dB)).toBe(false);
    expect(nm.canLandAttackUs(B.id(), 0.8 * floor, dB)).toBe(true);
    // Off: no floor.
    expect(
      deterrenceFloor(
        {
          ...v,
          o: parseApexOptions({ strikes: true, strikeDeterrence: false }),
        },
        A.id(),
      ),
    ).toBe(0);
    // An ally: the betrayal line instead.
    me.createAllianceRequest(B)!.accept();
    expect(deterrenceFloor(v, A.id())).toBeCloseTo(
      BETRAY_SHARE * B.troops(),
      6,
    );
  });

  test("postCover: the share of the contact within 30 tiles of the target's finished defense posts", async () => {
    const sc = await scene();
    const { game, me } = sc.f;
    const info = () =>
      scanWorld(game, me, null).nations.find((n) => n.id === NATION_ID)!;
    // Our column x = 99 meets its column x = 100 in each of the 60 rows.
    expect(info().contact).toBe(60);
    expect(postCover(game, me, sc.nation, info().contact)).toBe(0);
    // A post 19 columns behind the front covers rows 0..28 of it (19² +
    // dy² ≤ 30²): 29 of 60 pairs.
    const far = sc.nation.buildUnit(UnitType.DefensePost, game.ref(119, 5), {});
    expect(postCover(game, me, sc.nation, info().contact)).toBeCloseTo(
      29 / 60,
      9,
    );
    // Under construction it covers nothing (AttackExecution counts only
    // finished posts).
    far.setUnderConstruction(true);
    expect(postCover(game, me, sc.nation, info().contact)).toBe(0);
    far.setUnderConstruction(false);
    // A second post 10 columns behind the front adds rows 29..58; a tile in
    // range of both counts once.
    sc.nation.buildUnit(UnitType.DefensePost, game.ref(110, 30), {});
    expect(postCover(game, me, sc.nation, info().contact)).toBeCloseTo(
      59 / 60,
      9,
    );
  });

  test("retreat: one tick after its decision, a strike into a posted front that cannot kill is called back; nothing meets it, most comes home, and the nation rests", async () => {
    const sc = await scene();
    const { game, me } = sc.f;
    const r = run(sc, stalled());
    const launch = untilLaunch(sc, r, STRIKES, 0.08, 3 * sc.rate);
    expect(launch).not.toBeNull();
    // The nation posts the whole front (as it does against any attack above
    // 35% of its troops).
    sc.nation.buildUnit(UnitType.DefensePost, game.ref(110, 30), {});
    sc.nation.buildUnit(UnitType.DefensePost, game.ref(110, 5), {});
    sc.nation.buildUnit(UnitType.DefensePost, game.ref(110, 55), {});
    const RETREAT = parseApexOptions({ strikes: true, strikeRetreat: true });
    let cancelAt = -1;
    let stack = 0;
    for (let i = 0; i < sc.rate + 2 && cancelAt < 0; i++) {
      const tick = game.ticks();
      stack = ourAttackOn(me, sc.nation).reduce((x, a) => x + a.troops(), 0);
      const sent = strikeTick(sc, RETREAT, r);
      if (sent.some((x) => x.type === "cancel_attack")) cancelAt = tick;
      game.executeNextTick();
    }
    expect(cancelAt).toBeGreaterThan(0);
    // At d + 1: it decided in the turn before.
    expect((cancelAt - 1) % sc.rate).toBe(sc.phase);
    expect(
      r.logs.some((l) => l.includes("wretreat") && l.includes("posts")),
    ).toBe(true);
    expect(strikeMemory(r.s).stats.retreats).toBe(1);
    const before = me.troops();
    // The retreat takes 20 ticks and ends before its next decision.
    for (let i = 0; i < 25; i++) {
      strikeTick(sc, RETREAT, r);
      game.executeNextTick();
    }
    expect(game.ticks()).toBeLessThan(cancelAt + sc.rate);
    expect(ourAttackOn(me, sc.nation)).toEqual([]);
    expect(sc.answers).toEqual([]);
    // 75% of the stack came home (less our regrowth-free cap clamp: well
    // above half of it).
    expect(me.troops() - before).toBeGreaterThan(0.5 * stack);
    // No new strike on it while it rests.
    const mem = strikeMemory(r.s);
    expect(mem.rest[NATION_ID]).toBe(cancelAt);
    const skips = mem.stats.skips.rest ?? 0;
    while (game.ticks() < cancelAt + 2 * sc.rate + 2) {
      sc.nation.setTroops(Math.round(0.08 * sc.f.config.maxTroops(sc.nation)));
      expect(
        strikeTick(sc, RETREAT, r).filter((x) => x.type === "attack"),
      ).toEqual([]);
      game.executeNextTick();
    }
    expect(mem.stats.skips.rest ?? 0).toBeGreaterThan(skips);
    expect(game.ticks()).toBeLessThan(cancelAt + STRIKE_REST);
  });

  test("posts: no top-up into a front posted at strikePostCover that the stack cannot kill", async () => {
    for (const posted of [false, true]) {
      const sc = await scene();
      const { game, me, config } = sc.f;
      const r = run(sc, stalled());
      const o = parseApexOptions({ strikes: true, strikePosts: true });
      const M = config.maxTroops(sc.nation);
      expect(untilLaunch(sc, r, STRIKES, 0.08, 3 * sc.rate)).not.toBeNull();
      if (posted) {
        sc.nation.buildUnit(UnitType.DefensePost, game.ref(110, 30), {});
      }
      // As in the top-up test: its troops rise, our stack falls short.
      sc.nation.setTroops(Math.round(0.25 * M));
      me.setTroops(Math.round(0.95 * config.maxTroops(me)));
      let topUps = 0;
      for (let i = 0; i < sc.rate + 2; i++) {
        topUps += strikeTick(sc, o, r).length;
        game.executeNextTick();
      }
      expect(topUps).toBe(posted ? 0 : 1);
    }
  });

  test("strikeMinContact and strikeDetHorizon", async () => {
    const sc = await scene();
    const { game } = sc.f;
    // A 60-pair front: 61 asked, no launch.
    const r = run(sc, stalled());
    const narrow = parseApexOptions({ strikes: true, strikeMinContact: 61 });
    expect(untilLaunch(sc, r, narrow, 0.08, sc.rate + 2)).toBeNull();
    expect(strikeMemory(r.s).stats.skips.contact).toBeGreaterThan(0);
    // The horizon reads a third nation's troops at its decision that many
    // ticks ahead: its regrowth raises the line.
    const f = await field({ width: 80, height: 40 });
    const { me, config } = f;
    own(me, rect(f.game, 0, 0, 40, 40));
    const add = (id: string, y0: number) => {
      const n = f.game.addPlayer(
        new PlayerInfo(id, PlayerType.Nation, null, id),
      );
      own(n, rect(f.game, 40, y0, 80, y0 + 20));
      return n;
    };
    const A = add("NATIONA1", 0);
    const B = add("NATIONB1", 20);
    f.game.addExecution(new PlayerExecution(B));
    for (let i = 0; i < 60; i++) f.game.executeNextTick();
    A.setTroops(Math.round(0.2 * config.maxTroops(A)));
    B.setTroops(Math.round(0.62 * config.maxTroops(B)));
    me.setTroops(Math.round(0.9 * config.maxTroops(me)));
    const nm = new NationModel(f.game, me, GAME_ID, createModels(f.game));
    const tick = f.game.ticks();
    nm.observe(tick);
    const v = (h: number) => ({
      o: parseApexOptions({ strikes: true, strikeDetHorizon: h }),
      wm: scanWorld(f.game, me, null),
      nm,
      game: f.game,
      me,
      tick,
      models: createModels(f.game),
    });
    const d0 = nm.nextDecision(B.id(), tick);
    const d150 = nm.nextDecision(B.id(), tick + 150);
    expect(nm.gates(B.id(), d150)).toBe("open");
    expect(deterrenceFloor(v(0), A.id())).toBeCloseTo(
      (nm.troopsAt(B.id(), d0) + 1) / nm.sendCapSafe(),
      6,
    );
    expect(deterrenceFloor(v(150), A.id())).toBeCloseTo(
      (nm.troopsAt(B.id(), d150) + 1) / nm.sendCapSafe(),
      6,
    );
    expect(deterrenceFloor(v(150), A.id())).toBeGreaterThan(
      deterrenceFloor(v(0), A.id()),
    );
    void game;
  });

  // ── Review of A1 (round 2) ─────────────────────────────────────────────

  test("strikeDetNearTarget: the floor covers the nations bordering the target, which the conquest makes ours", async () => {
    // Us | T | X: X borders T, not us.
    const f = await field({ width: 120, height: 40 });
    const { game, me, config } = f;
    own(me, rect(game, 0, 0, 30, 40));
    const add = (id: string, x0: number, x1: number) => {
      const n = game.addPlayer(new PlayerInfo(id, PlayerType.Nation, null, id));
      own(n, rect(game, x0, 0, x1, 40));
      return n;
    };
    const T = add("NATIONT1", 30, 60);
    const X = add("NATIONX1", 60, 120);
    for (let i = 0; i < 60; i++) game.executeNextTick();
    T.setTroops(Math.round(0.08 * config.maxTroops(T)));
    X.setTroops(Math.round(0.95 * config.maxTroops(X)));
    me.setTroops(Math.round(0.95 * config.maxTroops(me)));
    const nm = new NationModel(game, me, GAME_ID, createModels(game));
    const tick = game.ticks();
    nm.observe(tick);
    const v = (o: ApexOptions) => ({
      o,
      wm: scanWorld(game, me, null),
      nm,
      game,
      me,
      tick,
      models: createModels(game),
    });
    const near = parseApexOptions({ strikes: true, strikeDetNearTarget: true });
    // The option is on by default.
    const bordering = parseApexOptions({
      strikes: true,
      strikeDetNearTarget: false,
    });
    expect(v(STRIKES).wm.nations.map((n) => n.id)).toEqual([T.id()]);
    expect(targetNeighbours(v(near), T.id()).map((p) => p.id())).toEqual([
      X.id(),
    ]);
    // Without the option no bordering nation but the target: no floor.
    expect(deterrenceFloor(v(bordering), T.id())).toBe(0);
    // With it, X's land line at its decision.
    const dX = nm.nextDecision(X.id(), tick);
    expect(deterrenceFloor(v(near), T.id())).toBeCloseTo(
      (nm.troopsAt(X.id(), dX) + 1) / nm.sendCapSafe(),
      6,
    );
    // Below its reserve X cannot attack: no line.
    X.setTroops(Math.round(0.1 * config.maxTroops(X)));
    expect(deterrenceFloor(v(near), T.id())).toBe(0);
    // An ally: the betrayal line.
    X.setTroops(Math.round(0.95 * config.maxTroops(X)));
    me.createAllianceRequest(X)!.accept();
    expect(deterrenceFloor(v(near), T.id())).toBeCloseTo(
      BETRAY_SHARE * X.troops(),
      6,
    );
  });

  test("strikeDetNearTarget: a W1 strike that would leave home under a far neighbour's line does not go", async () => {
    for (const on of [false, true]) {
      const f = await field({ width: 120, height: 40 });
      const { game, me, config } = f;
      own(me, rect(game, 0, 0, 30, 40));
      const nationObj = new Nation(
        new Cell(45, 20),
        new PlayerInfo("t", PlayerType.Nation, null, "NATIONT1"),
      );
      const T = game.addPlayer(nationObj.playerInfo);
      own(T, rect(game, 30, 0, 60, 40));
      const X = game.addPlayer(
        new PlayerInfo("x", PlayerType.Nation, null, "NATIONX1"),
      );
      own(X, rect(game, 60, 0, 120, 40));
      for (let i = 0; i < 60; i++) game.executeNextTick();
      X.setTroops(config.maxTroops(X));
      const sc: Scene = { f, nation: T, rate: 0, phase: 0, answers: [] };
      const r = run(sc, stalled());
      const p = r.nm.params(T.id());
      sc.rate = p.rate;
      sc.phase = p.phase;
      const o = parseApexOptions({ strikes: true, strikeDetNearTarget: on });
      const launch = untilLaunch(sc, r, o, 0.08, 3 * sc.rate);
      if (on) {
        expect(launch).toBeNull();
        const skips = strikeMemory(r.s).stats.skips;
        expect((skips.stack ?? 0) + (skips.budget ?? 0)).toBeGreaterThan(0);
      } else {
        expect(launch).not.toBeNull();
      }
    }
  });

  test("strikeDetNearReach: only the target's neighbours next to the land the stack can reach", async () => {
    // Us | T (80 columns) | X: X meets T only at T's far side.
    const f = await field({ width: 120, height: 40 });
    const { game, me, config } = f;
    own(me, rect(game, 0, 0, 30, 40));
    const add = (id: string, x0: number, x1: number) => {
      const n = game.addPlayer(new PlayerInfo(id, PlayerType.Nation, null, id));
      own(n, rect(game, x0, 0, x1, 40));
      return n;
    };
    const T = add("NATIONT1", 30, 110);
    const X = add("NATIONX1", 110, 120);
    for (let i = 0; i < 60; i++) game.executeNextTick();
    X.setTroops(config.maxTroops(X));
    me.setTroops(Math.round(0.95 * config.maxTroops(me)));
    const nm = new NationModel(game, me, GAME_ID, createModels(game));
    const tick = game.ticks();
    nm.observe(tick);
    const v = {
      o: parseApexOptions({
        strikes: true,
        strikeDetNearTarget: true,
        strikeDetNearReach: true,
      }),
      wm: scanWorld(game, me, null),
      nm,
      game,
      me,
      tick,
      models: createModels(game),
    };
    // The walk meets X after 79 of T's 80 columns.
    const exposed = new Map<number, number>();
    expect(reachableTiles(game, me, T, undefined, undefined, exposed)).toBe(
      80 * 40,
    );
    expect(exposed.get(X.smallID())).toBeGreaterThanOrEqual(78 * 40);
    expect(exposed.get(X.smallID())).toBeLessThanOrEqual(80 * 40);
    // A stack that can take 1,000 tiles does not reach it; one that can
    // take the whole of T does.
    expect(exposedNations(v, T, exposed, 1000)).toEqual([]);
    expect(exposedNations(v, T, exposed, 80 * 40).map((p) => p.id())).toEqual([
      X.id(),
    ]);
    // The floor: X's line only when reached.
    expect(deterrenceFloor(v, T.id(), [])).toBe(0);
    const dX = nm.nextDecision(X.id(), tick);
    expect(deterrenceFloor(v, T.id(), [X])).toBeCloseTo(
      (nm.troopsAt(X.id(), dX) + 1) / nm.sendCapSafe(),
      6,
    );
  });

  test("reachableTiles: the target's land an attack of ours can reach, capped", async () => {
    // A lake column at x = 104 cuts the nation's land: 4 columns (240
    // tiles) next to us, 15 (900) behind the lake.
    const sc = await scene(null, 104);
    const { game, me } = sc.f;
    expect(sc.nation.numTilesOwned()).toBe(240 + 900);
    expect(reachableTiles(game, me, sc.nation)).toBe(240);
    // The walk stops at its cap: at least that many.
    expect(reachableTiles(game, me, sc.nation, 100)).toBe(Infinity);
    // Undivided: all of it.
    const open = await scene();
    expect(reachableTiles(open.f.game, open.f.me, open.nation)).toBe(
      open.nation.numTilesOwned(),
    );
  });

  test("strikeReachModel: a strike on a pocket is valued as one, and it does end with the pocket, the rest coming home", async () => {
    const sc = await scene(null, 104);
    const { game, me } = sc.f;
    const REACH = parseApexOptions({ strikes: true, strikeReachModel: true });
    const r = run(sc, stalled());
    const launch = untilLaunch(sc, r, REACH, 0.08, 3 * sc.rate);
    expect(launch).not.toBeNull();
    const line = r.logs.find((l) => l.includes(" wstrike "))!;
    expect(line).toContain(" W1 ");
    expect(line).toContain("kill=n");
    expect(line).toContain("reach=240 pocket");
    const sid = sc.nation.smallID();
    expect(r.ledger.plan(sid)?.expectedRefund).toBeGreaterThan(0);
    // The old model saw a kill the attack cannot make.
    const sc2 = await scene(null, 104);
    const r2 = run(sc2, stalled());
    expect(untilLaunch(sc2, r2, STRIKES, 0.08, 3 * sc2.rate)).not.toBeNull();
    expect(r2.logs.find((l) => l.includes(" wstrike "))).toContain("kill=y");
    // The attack takes the pocket and ends; what is left comes home.
    const S = (launch!.intent as { troops: number }).troops;
    const before = me.troops();
    for (let i = 0; i < 40 && ourAttackOn(me, sc.nation).length > 0; i++) {
      game.executeNextTick();
    }
    expect(ourAttackOn(me, sc.nation)).toEqual([]);
    expect(sc.nation.numTilesOwned()).toBe(900);
    expect(me.troops() - before).toBeGreaterThan(0.5 * S);
  });

  test("contactAtLeast: a live count of the pairs our land shares with the target", async () => {
    const sc = await scene(4);
    const { game, me } = sc.f;
    expect(contactAtLeast(game, me, sc.nation, 4)).toBe(true);
    expect(contactAtLeast(game, me, sc.nation, 5)).toBe(false);
    expect(contactAtLeast(game, me, sc.nation, 0)).toBe(true);
  });

  test("strikeLiveCheck: no launch next to an alliance request queued this tick", async () => {
    for (const on of [false, true]) {
      const sc = await scene();
      const r = run(sc, stalled());
      const o = parseApexOptions({ strikes: true, strikeLiveCheck: on });
      const { game, me, config } = sc.f;
      let launched = false;
      for (let i = 0; i < 3 * sc.rate && !launched; i++) {
        sc.nation.setTroops(Math.round(0.08 * config.maxTroops(sc.nation)));
        me.setTroops(Math.round(0.95 * config.maxTroops(me)));
        const sent = strikeTick(
          sc,
          o,
          r,
          (v) => {
            // The DefenseController's recall (Prio.Recall, key ally:<id>).
            v.scheduler.offer({
              intent: { type: "allianceRequest", recipient: NATION_ID },
              prio: Prio.Recall,
              cls: "defense",
              key: `ally:${NATION_ID}`,
            });
          },
          // Not applied: a pending request blocks the launch in any case.
          (x) => x.type !== "allianceRequest",
        );
        launched = sent.some((x) => x.type === "attack");
        game.executeNextTick();
      }
      expect(launched).toBe(!on);
      if (on) {
        expect(strikeMemory(r.s).stats.skips.request ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
