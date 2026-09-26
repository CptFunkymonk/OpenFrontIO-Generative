import { AgentIntent } from "../../../src/agent/Agent";
import {
  StrikeController,
  strikeStack,
  strikeWindow,
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
import { createPurse, Scheduler } from "../../../src/agent/lib/Scheduler";
import { scanWorld } from "../../../src/agent/lib/WorldModel";
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
} from "../../../src/core/game/Game";
import { Field, field, GAME_ID, own, rect, submit } from "./Field";

// Spec §3.5 and §4 step 9 (StrikeWindow.test): a strike launched at d + 1
// on a nation that stays below its reserve through its next two decisions
// draws no retaliation. A synthetic plains field (tests/agent/apex/Field.ts)
// with us on the left half and one Impossible nation, run by its real
// NationExecution seeded from the field's game ID, on the right; both
// regrow (PlayerExecution). The StrikeController runs through a View built
// as the policy builds it, with stall mode forced on (s.stall.since); what
// it offers goes through the agent's intent path. Tests set troops and land
// directly; agents never may.

const W = 120;
const H = 60;
const NATION_ID = "NATION01";

interface Scene {
  f: Field;
  nation: Player;
  exec: NationExecution;
  rate: number;
  phase: number;
  /** Ticks at which the nation created an attack on us (its decision; an
   *  answer that the 1:1 cancel absorbs whole never shows as incoming). */
  answers: number[];
}

async function scene(opts: { freeCols?: number } = {}): Promise<Scene> {
  const f = await field({ width: W, height: H });
  const { game, me } = f;
  const free = opts.freeCols ?? 0;
  own(me, rect(game, 0, 0, 60, H));
  const nationObj = new Nation(
    new Cell(90, 30),
    new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
  );
  const nation = game.addPlayer(nationObj.playerInfo);
  own(nation, rect(game, 60, 0, W - free, H));
  game.addExecution(new PlayerExecution(me));
  game.addExecution(new PlayerExecution(nation));
  const exec = new NationExecution(GAME_ID, nationObj);
  game.addExecution(exec);
  const n = exec as unknown as { attackRate: number; attackTick: number };
  // Every attack the nation creates on us, recorded as it is constructed
  // (the field is all land, so no boats).
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
  return { f, nation, exec, rate: n.attackRate, phase: n.attackTick, answers };
}

const STRIKE_ON: ApexOptions = parseApexOptions({ stallStrike: true });

/** One onTick of the StrikeController over a View as the policy builds it;
 *  returns what it offered (flushed as the policy flushes). */
function strikeTick(
  sc: Scene,
  o: ApexOptions,
  s: ApexState,
  nm: NationModel,
  ledger: Ledger,
): AgentIntent[] {
  const { game, me } = sc.f;
  const tick = game.ticks();
  const models = createModels(game);
  ledger.observe(me, tick);
  nm.observe(tick);
  const wm = scanWorld(game, me, null);
  const floors = homeFloors({ tick, o, me, models, nm }, s);
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
    wm,
    nm,
    ledger,
    race: null,
    owners: null,
    scheduler,
    purse,
    lookahead: null,
    forRollout: null,
    live: null,
  };
  new StrikeController().onTick(v, s);
  const sent: AgentIntent[] = [];
  scheduler.flush(
    (i) => {
      sent.push(i);
      return "ok";
    },
    ledger,
    tick,
  );
  return sent;
}

/** Stall mode on since long ago. */
function stalled(): ApexState {
  const s = createState();
  s.stall.since = 0;
  return s;
}

/** The nation's attacks on us. */
const incomingFrom = (me: Player, n: Player) =>
  me.incomingAttacks().filter((a) => a.attacker() === n);

/** Sets troops at the start of a tick (tests only). */
function setShare(p: Player, share: number, cap: number): void {
  p.setTroops(Math.round(share * cap));
}

describe("apex stall strike (§3.5)", () => {
  test("W1: launched one tick after the nation's decision, with S = min(available, T/0.6·margin); no retaliation through its next two decisions", async () => {
    const sc = await scene();
    const { game, me, config } = sc.f;
    const s = stalled();
    const models = createModels(game);
    const nm = new NationModel(game, me, GAME_ID, models);
    const ledger = new Ledger();
    // NationModel's replay of the nation's schedule is the real one.
    expect(nm.params(NATION_ID)).toMatchObject({
      rate: sc.rate,
      phase: sc.phase,
    });
    const M = config.maxTroops(sc.nation);
    const reserve = nm.params(NATION_ID).reserve;
    let launched: { tick: number; intent: AgentIntent } | null = null;
    for (let i = 0; i < 3 * sc.rate && launched === null; i++) {
      // Far below its reserve, so regrowth keeps it there; us near our cap.
      setShare(sc.nation, 0.08, M);
      setShare(me, 0.95, config.maxTroops(me));
      const tick = game.ticks();
      const sent = strikeTick(sc, STRIKE_ON, s, nm, ledger);
      const decidedLastTurn = (tick - 1) % sc.rate === sc.phase;
      if (!decidedLastTurn) expect(sent).toEqual([]);
      if (sent.length > 0) {
        launched = { tick, intent: sent[0] };
        const T = sc.nation.troops();
        const w = strikeWindow(nm, NATION_ID, tick, M);
        expect(w.window).toBe("W1");
        expect(w.T2).toBeLessThan(reserve * M);
        expect(w.d1).toBe(tick - 1 + sc.rate);
        expect(w.d2).toBe(tick - 1 + 2 * sc.rate);
        const floors = homeFloors({ tick, o: STRIKE_ON, me, models, nm }, s);
        const avail = homeAvailable(me, floors) - floors.strike;
        expect(sent[0]).toEqual({
          type: "attack",
          targetID: NATION_ID,
          troops: strikeStack(T, 0, avail, STRIKE_ON),
        });
        expect(strikeStack(T, 0, avail, STRIKE_ON)).toBeGreaterThanOrEqual(T);
        for (const x of sent) submit(sc.f, x);
      }
      game.executeNextTick();
    }
    expect(launched).not.toBeNull();
    const t0 = launched!.tick;
    // Our attack exists; the nation decides at t0 - 1 + rate and
    // t0 - 1 + 2·rate and answers neither time.
    expect(me.outgoingAttacks().some((a) => a.target() === sc.nation)).toBe(
      true,
    );
    let decisions = 0;
    while (game.ticks() <= t0 - 1 + 2 * sc.rate) {
      if (game.ticks() % sc.rate === sc.phase) decisions++;
      game.executeNextTick();
      expect(incomingFrom(me, sc.nation)).toEqual([]);
    }
    expect(decisions).toBe(2);
    expect(sc.answers).toEqual([]);
  });

  test("negative control: above its trigger no window opens, and a forced strike is answered", async () => {
    const sc = await scene();
    const { game, me, config } = sc.f;
    const s = stalled();
    const nm = new NationModel(game, me, GAME_ID, createModels(game));
    const ledger = new Ledger();
    const M = config.maxTroops(sc.nation);
    let forced = -1;
    for (let i = 0; i < 3 * sc.rate && forced < 0; i++) {
      setShare(sc.nation, 0.8, M);
      setShare(me, 0.95, config.maxTroops(me));
      const tick = game.ticks();
      expect(strikeTick(sc, STRIKE_ON, s, nm, ledger)).toEqual([]);
      if ((tick - 1) % sc.rate === sc.phase) {
        expect(strikeWindow(nm, NATION_ID, tick, M).window).toBeNull();
        forced = tick;
        submit(sc.f, {
          type: "attack",
          targetID: NATION_ID,
          troops: Math.round(0.9 * me.troops()),
        });
      }
      game.executeNextTick();
    }
    expect(forced).toBeGreaterThan(0);
    // Answered at one of its next three decisions (9 in 10 per decision
    // above the trigger [PIN NationRetaliate]), on a decision tick.
    expect(sc.answers).toEqual([]);
    while (game.ticks() <= forced - 1 + 3 * sc.rate) game.executeNextTick();
    expect(sc.answers.length).toBeGreaterThan(0);
    expect(sc.answers[0] % sc.rate).toBe(sc.phase);
  });

  test("W2: a nation bordering free land is struck above its reserve and does not answer at its next decision", async () => {
    const sc = await scene({ freeCols: 20 });
    const { game, me, config } = sc.f;
    const s = stalled();
    const nm = new NationModel(game, me, GAME_ID, createModels(game));
    const ledger = new Ledger();
    const M = () => config.maxTroops(sc.nation);
    let t0 = -1;
    for (let i = 0; i < 3 * sc.rate && t0 < 0; i++) {
      // Above its reserve at its next decision, so only the free-land
      // branch keeps it from answering; the free land comes back each tick.
      for (const t of rect(game, W - 20, 0, W, H)) {
        const o = game.owner(t);
        if (o.isPlayer()) o.relinquish(t);
      }
      setShare(sc.nation, 0.45, M());
      setShare(me, 0.95, config.maxTroops(me));
      const tick = game.ticks();
      const sent = strikeTick(sc, STRIKE_ON, s, nm, ledger);
      if (sent.length > 0) {
        const w = strikeWindow(nm, NATION_ID, tick, M());
        expect(w.window).toBe("W2");
        expect(w.T1).toBeGreaterThanOrEqual(w.reserveTroops);
        t0 = tick;
        for (const x of sent) submit(sc.f, x);
      }
      game.executeNextTick();
    }
    expect(t0).toBeGreaterThan(0);
    while (game.ticks() <= t0 - 1 + sc.rate) {
      game.executeNextTick();
      expect(incomingFrom(me, sc.nation)).toEqual([]);
    }
    expect(sc.answers).toEqual([]);
  });

  test("off by default, and only in stall mode", async () => {
    const sc = await scene();
    const { game, me, config } = sc.f;
    const nm = new NationModel(game, me, GAME_ID, createModels(game));
    const ledger = new Ledger();
    const M = config.maxTroops(sc.nation);
    const defaults = parseApexOptions();
    expect(defaults.stallStrike).toBe(false);
    for (let i = 0; i < 2 * sc.rate; i++) {
      setShare(sc.nation, 0.08, M);
      setShare(me, 0.95, config.maxTroops(me));
      expect(strikeTick(sc, defaults, stalled(), nm, ledger)).toEqual([]);
      // Not stalled: stall.since null.
      expect(strikeTick(sc, STRIKE_ON, createState(), nm, ledger)).toEqual([]);
      game.executeNextTick();
    }
  });

  test("strikeStack: the 1:1 cancel of the nation's attacks on us is added, and ratio > 1 sends nothing", () => {
    const o = { tribeRatio: 0.6, tribeMargin: 1.1 };
    expect(strikeStack(60_000, 0, 1e9, o)).toBe(110_000);
    expect(strikeStack(60_000, 5_000, 1e9, o)).toBe(115_000);
    expect(strikeStack(60_000, 0, 70_000, o)).toBe(70_000);
    expect(strikeStack(60_000, 0, 59_999, o)).toBe(0);
    expect(strikeStack(60_000, 5_000, 64_000, o)).toBe(0);
    // stallStrikeFromHome: every available troop, still ≥ T after the cancel.
    const home = { ...o, stallStrikeFromHome: true };
    expect(strikeStack(60_000, 0, 1e6, home)).toBe(1e6);
    expect(strikeStack(60_000, 5_000, 2e6, home)).toBe(2e6);
    expect(strikeStack(60_000, 5_000, 64_000, home)).toBe(0);
  });
});
