/**
 * Package WP10b, the leader guard's lines (src/agent/lib/LeaderGuard.ts)
 * against hand-computed cases and against the real rules they copy:
 * NationAllianceBehavior.maybeBetray / isSafeToBetray / findJuiciestAlly
 * (the betrayal line, pinned by tests/agent/mechanics/Betrayal.test.ts) and
 * NationMIRVBehavior's three target rules (pinned by
 * NationMirvTargeting.test.ts and NukeThreat.test.ts).
 *
 * Settings: tests/agent/mechanics/LeaderWorld.ts (the real Config,
 * Impossible, FFA, all-plains maps built in memory). No PlayerExecution
 * runs, so troops stay where a test puts them; the nations sit at their cap
 * so that NationModel.troopsAt (their regrowth to the next decision) is
 * their troops now.
 */
import {
  BETRAY_SAFE_SHARE,
  betrayalFloor,
  BetrayalLine,
  betrayalLines,
  BetrayalParams,
  emptyGoldHistory,
  EXACT_BETRAYAL,
  goldRate,
  levelsFor,
  mirvAim,
  mirvDanger,
  mirvLines,
  mirvWorld,
  noteGold,
  safeTotal,
} from "../../../src/agent/lib/LeaderGuard";
import { createModels } from "../../../src/agent/lib/Models";
import { NationModel } from "../../../src/agent/lib/NationModel";
import { Player, PlayerType, UnitType } from "../../../src/core/game/Game";
import {
  ally,
  brains,
  pastImmunity,
  price,
  send,
  setGold,
  siloAt,
  structureAt,
  tick,
  World,
  world,
} from "../mechanics/LeaderWorld";

/**
 * 120 x 60 (Betrayal.test.ts's betrayWorld): the ally B at x < 20; us at x
 * 20-79 on rows 0-29; B's other ally A2 at x 20-79 on rows 30-49; a tribe T
 * at x 20-79 on rows 50-59; a human Q at x >= 80 (not bordering B); with
 * `free`, the columns x < 3 unowned (B borders free land).
 */
function betrayWorld(gameID: string, free = false): World {
  return world(
    120,
    60,
    {
      B: PlayerType.Nation,
      US: PlayerType.Human,
      A2: PlayerType.Nation,
      T: PlayerType.Bot,
      Q: PlayerType.Human,
    },
    (x, y) => {
      if (free && x < 3) return null;
      if (x < 20) return "B";
      if (x >= 80) return "Q";
      if (y < 30) return "US";
      if (y < 50) return "A2";
      return "T";
    },
    { gameID },
  );
}

/** A phantom attack of `troops` (the Attack object alone, as
 *  Betrayal.test.ts's outgoing()). */
function outgoing(w: World, p: Player, troops: number): void {
  p.createAttack(w.game.terraNullius(), troops, null, new Set());
}

function modelOf(w: World, gameID: string): NationModel {
  return new NationModel(w.game, w.p.US, gameID, createModels(w.game));
}

/** B allied with us and A2, at its cap; A2 and the tribe at `a2` and `t`
 *  troops, Q at 0. */
function setup(gameID: string, a2 = 20_000, t = 30_000, free = false) {
  const w = betrayWorld(gameID, free);
  const { B, US, A2, T, Q } = w.p;
  ally(B, US);
  ally(B, A2);
  B.setTroops(Math.floor(w.config.maxTroops(B)));
  A2.setTroops(a2);
  T.setTroops(t);
  Q.setTroops(0);
  US.setTroops(0);
  const nm = modelOf(w, gameID);
  nm.refresh(B.id(), "full");
  return { w, nm };
}

function lineOf(
  w: World,
  nm: NationModel,
  p: BetrayalParams = EXACT_BETRAYAL,
): BetrayalLine {
  const lines = betrayalLines(
    { game: w.game, me: w.p.US, nm, tick: w.game.ticks() },
    p,
  );
  expect(lines.map((l) => l.id)).toEqual([w.p.B.id()]);
  return lines[0];
}

describe("LeaderGuard: safeTotal", () => {
  test("the least integer total with total + others >= share x T, in floats", () => {
    // 300,000 x 0.33 = 98,999.99999999999 in floats: 99,000 is the edge.
    expect(safeTotal(300_000, 0, BETRAY_SAFE_SHARE)).toBe(99_000);
    expect(99_000 >= 300_000 * 0.33).toBe(true);
    expect(98_999 >= 300_000 * 0.33).toBe(false);
    expect(safeTotal(300_000, 50_000, BETRAY_SAFE_SHARE)).toBe(49_000);
    expect(safeTotal(300_000, 120_000, BETRAY_SAFE_SHARE)).toBe(0);
    expect(safeTotal(1_000_000, 1, 0.33)).toBe(329_999);
  });
});

describe(
  "LeaderGuard: the betrayal line against NationAllianceBehavior",
  { timeout: 60_000 },
  () => {
    test("rule (a): the total is the least home + attacks at which isSafeToBetray is false; a bordering tribe and B's other ally count, a player not bordering B does not", () => {
      const { w, nm } = setup("lg-a");
      const T = w.p.B.troops();
      const l = lineOf(w, nm);
      expect(l.T).toBe(T);
      expect(l.others).toBe(20_000 + 30_000);
      expect(l.alone).toBe(false);
      expect(l.rule).toBe("safe");
      expect(l.total).toBe(safeTotal(T, 50_000, 0.33));
      // Hand-computed: ceil(0.33 T) - 50,000 (T x 0.33 is not an integer).
      expect(l.total).toBe(Math.ceil(T * 0.33) - 50_000);
      expect(l.home).toBe(l.total);
      // The real rule at the edge, in fresh worlds (as Betrayal.test.ts).
      const safeAt = (ours: number) => {
        const s = setup("lg-a");
        s.w.p.US.setTroops(ours);
        const { B, US, A2, T: tribe } = s.w.p;
        void B;
        return brains(s.w, "B", "lg-a").alliance.isSafeToBetray(
          US,
          [US, A2],
          [tribe],
        );
      };
      expect(safeAt(l.total - 1)).toBe(true);
      expect(safeAt(l.total)).toBe(false);
    });

    test("rule (a) with our attacks: they count in the nation's sum, so home + attacks holds the line; ourOut credits them in the home floor", () => {
      const { w, nm } = setup("lg-out");
      outgoing(w, w.p.US, 10_000);
      const exact = lineOf(w, nm);
      expect(exact.home).toBe(exact.total - 10_000);
      const home = lineOf(w, nm, { ...EXACT_BETRAYAL, ourOut: 0 });
      expect(home.home).toBe(home.total);
      const half = lineOf(w, nm, { ...EXACT_BETRAYAL, ourOut: 0.5 });
      expect(half.home).toBe(half.total - 5_000);
      // The real rule: home at exact.home with the 10,000 out is not safe,
      // one less is.
      const safeAt = (ours: number) => {
        const s = setup("lg-out");
        s.w.p.US.setTroops(ours);
        outgoing(s.w, s.w.p.US, 10_000);
        const { US, A2, T } = s.w.p;
        return brains(s.w, "B", "lg-out").alliance.isSafeToBetray(
          US,
          [US, A2],
          [T],
        );
      };
      expect(safeAt(exact.home - 1)).toBe(true);
      expect(safeAt(exact.home)).toBe(false);
    });

    test("rule (b): a traitor is betrayed under 1.2x the nation's troops, and its other allies no longer count in rule (a)", () => {
      const { w, nm } = setup("lg-b");
      w.p.US.markTraitor();
      const T = w.p.B.troops();
      const l = lineOf(w, nm);
      expect(l.others).toBe(30_000);
      expect(l.total).toBe(Math.ceil(T * 0.33) - 30_000);
      expect(l.rule).toBe("traitor");
      expect(l.home).toBe(Math.ceil(T * 1.2));
      expect(l.base).toBe(l.total);
      const betrays = (ours: number) => {
        const s = setup("lg-b");
        s.w.p.US.markTraitor();
        s.w.p.US.setTroops(ours);
        const { US, A2, T: tribe } = s.w.p;
        const a = brains(s.w, "B", "lg-b").alliance;
        const friends = [US, A2];
        return a.maybeBetray(US, a.findJuiciestAlly(friends), friends, [tribe]);
      };
      expect(betrays(l.home - 1)).toBe(true);
      expect(betrays(l.home)).toBe(false);
    });

    test("rule (c): the only bordering player is held at ceil(T/3), above rule (a)'s 0.33", () => {
      const w = world(
        60,
        40,
        { B: PlayerType.Nation, US: PlayerType.Human },
        (x) => (x < 20 ? "B" : "US"),
        { gameID: "lg-c" },
      );
      const { B, US } = w.p;
      ally(B, US);
      B.setTroops(Math.floor(w.config.maxTroops(B)));
      const nm = modelOf(w, "lg-c");
      nm.refresh(B.id(), "full");
      const T = B.troops();
      const l = lineOf(w, nm);
      expect(l.alone).toBe(true);
      expect(l.others).toBe(0);
      expect(l.rule).toBe("alone");
      expect(l.home).toBe(Math.ceil(T / 3));
      expect(l.home).toBeGreaterThan(l.total);
      const betrays = (ours: number) => {
        const s = world(
          60,
          40,
          { B: PlayerType.Nation, US: PlayerType.Human },
          (x) => (x < 20 ? "B" : "US"),
          { gameID: "lg-c" },
        );
        ally(s.p.B, s.p.US);
        s.p.B.setTroops(T);
        s.p.US.setTroops(ours);
        const a = brains(s, "B", "lg-c").alliance;
        return a.maybeBetray(s.p.US, s.p.US, [s.p.US], []);
      };
      expect(betrays(l.home - 1)).toBe(true);
      expect(betrays(l.home)).toBe(false);
    });

    test("the margin scales the nation's troops, allyOut adds its attacks, and gates leave out an ally bound for free land", () => {
      const { w, nm } = setup("lg-m");
      const T = w.p.B.troops();
      const m = lineOf(w, nm, { ...EXACT_BETRAYAL, margin: 1.05 });
      expect(m.total).toBe(safeTotal(T * 1.05, 50_000, 0.33));
      outgoing(w, w.p.B, 40_000);
      const out = lineOf(w, nm, { ...EXACT_BETRAYAL, allyOut: 0.5 });
      expect(out.T).toBe(T + 20_000);
      // B next to free land: locked at its next decision (it sends there
      // and returns before its strategy list).
      const f = setup("lg-free", 20_000, 30_000, true);
      const kept = lineOf(f.w, f.nm);
      expect(kept.gate).toBe("locked");
      expect(
        betrayalLines(
          { game: f.w.game, me: f.w.p.US, nm: f.nm, tick: f.w.game.ticks() },
          { ...EXACT_BETRAYAL, gates: true },
        ),
      ).toEqual([]);
    });

    test("juiciest: the flag follows findJuiciestAlly over B's bordering allies (structure levels, empty share of cap, tiles)", () => {
      for (const [ours, theirs] of [
        [0, 3],
        [3, 0],
      ]) {
        const { w, nm } = setup(`lg-j${ours}`, 0, 0);
        const { US, A2 } = w.p;
        // We hold more tiles (1,800 against 1,200) and half our cap (A2 is
        // empty: its gap is the larger); the cities decide.
        US.setTroops(Math.floor(w.config.maxTroops(US) / 2));
        for (let i = 0; i < ours; i++) {
          structureAt(w, US, UnitType.City, 30 + 10 * i, 10);
        }
        for (let i = 0; i < theirs; i++) {
          structureAt(w, A2, UnitType.City, 30 + 10 * i, 40);
        }
        const l = lineOf(w, nm);
        const real = brains(w, "B", "lg-j").alliance.findJuiciestAlly([US, A2]);
        expect(l.juiciest).toBe(real === US);
        expect(l.juiciest).toBe(ours > theirs);
      }
    });

    test("no line for an ally that does not border us, or without the model's refresh (nearby() read directly)", () => {
      const w = world(
        120,
        60,
        {
          B: PlayerType.Nation,
          US: PlayerType.Human,
          F: PlayerType.Nation,
        },
        (x) => (x < 20 ? "B" : x < 80 ? "US" : x >= 100 ? "F" : null),
        { gameID: "lg-far" },
      );
      const { B, US, F } = w.p;
      ally(B, US);
      ally(F, US);
      const nm = modelOf(w, "lg-far");
      // No full refresh: B.nearby() is read directly.
      const lines = betrayalLines(
        { game: w.game, me: US, nm, tick: w.game.ticks() },
        EXACT_BETRAYAL,
      );
      expect(lines.map((l) => l.id)).toEqual([B.id()]);
    });
  },
);

describe("LeaderGuard: betrayalFloor and levelsFor", () => {
  const line = (
    id: string,
    home: number,
    base: number,
    rule: BetrayalLine["rule"],
  ): BetrayalLine => ({
    id,
    smallID: 0,
    d: 0,
    gate: "open",
    T: 0,
    others: 0,
    alone: false,
    juiciest: true,
    total: base,
    home,
    rule,
    base,
  });

  test("holdable lines (at most maxShare x cap) make the floor; a traitor's line above it falls back to its base; the others count in capShort", () => {
    const lines = [
      line("a", 1_000_000, 1_000_000, "safe"),
      line("b", 3_000_000, 500_000, "traitor"),
      line("c", 5_000_000, 5_000_000, "alone"),
    ];
    // cap 4M: max 3.2M; b's 3M holds; c needs 5M / 0.8 = 6.25M of cap.
    expect(betrayalFloor(lines, 4_000_000, { maxShare: 0.8 })).toEqual({
      floor: 3_000_000,
      by: "b",
      capShort: 2_250_000,
      shortBy: "c",
    });
    // cap 3M: max 2.4M; b falls back to 0.5M; a's 1M is the floor.
    expect(betrayalFloor(lines, 3_000_000, { maxShare: 0.8 })).toEqual({
      floor: 1_000_000,
      by: "a",
      capShort: 3_250_000,
      shortBy: "c",
    });
    expect(betrayalFloor([], 3_000_000, { maxShare: 0.8 })).toEqual({
      floor: 0,
      by: null,
      capShort: 0,
      shortBy: null,
    });
  });

  test("levelsFor: the City levels (250k of a human's cap each, cities under construction counted) that reach a cap", () => {
    const w = betrayWorld("lg-lv");
    const US = w.p.US;
    const models = createModels(w.game);
    const cap = models.cap(US);
    expect(levelsFor(models, US, cap)).toBe(0);
    expect(levelsFor(models, US, cap + 600_000)).toBe(3);
    expect(levelsFor(models, US, cap + 750_000)).toBe(3);
    expect(levelsFor(models, US, cap + 750_001)).toBe(4);
    // A city under construction already counts toward the target.
    US.buildUnit(UnitType.City, w.game.ref(40, 10), {});
    const u = US.units(UnitType.City)[0];
    u.setUnderConstruction(true);
    expect(models.cap(US)).toBe(cap);
    expect(levelsFor(models, US, cap + 600_000)).toBe(2);
  });
});

/**
 * 300 x 200 (60,000 land tiles, NationMirvTargeting.test.ts's targetWorld):
 * us at x < `usWidth`; the nation N at x >= 230 with a finished silo; an
 * inert nation Z at x 140-179; a tribe at x 190-199; the rest unowned.
 */
function targetWorld(usWidth: number, gameID: string): World {
  const w = world(
    300,
    200,
    {
      US: PlayerType.Human,
      N: PlayerType.Nation,
      Z: PlayerType.Nation,
      T: PlayerType.Bot,
    },
    (x) => {
      if (x < usWidth) return "US";
      if (x >= 230) return "N";
      if (x >= 140 && x < 180) return "Z";
      if (x >= 190 && x < 200) return "T";
      return null;
    },
    { gameID },
  );
  siloAt(w, w.p.N, 260, 100);
  return w;
}

describe(
  "LeaderGuard: the MIRV lines against NationMIRVBehavior",
  { timeout: 60_000 },
  () => {
    test("the 40% rule: 24,000 of 60,000 tiles is on the line (room 0) and names us; 23,999 has room 1 and does not", () => {
      const w = targetWorld(120, "lg-land");
      const { US, N } = w.p;
      const at = mirvLines(w.game, US);
      expect(at).toMatchObject({
        land: 60_000,
        tiles: 24_000,
        landLine: 24_000,
        landRoom: 0,
      });
      expect(mirvAim(mirvWorld(w.game), N)).toEqual({
        target: US,
        rule: "land",
      });
      expect(brains(w, "N", "lg-land").mirv.selectVictoryDenialTarget()).toBe(
        US,
      );
      US.relinquish(w.game.ref(0, 0));
      expect(mirvLines(w.game, US).landRoom).toBe(1);
      expect(mirvAim(mirvWorld(w.game), N)).toBeNull();
      expect(
        brains(w, "N", "lg-land").mirv.selectVictoryDenialTarget(),
      ).toBeNull();
      // A nation's MIRV at us within 300 ticks skips us (NMB :257-265).
      const w2 = targetWorld(120, "lg-skip");
      w2.game.nationMirvTargets().set(w2.p.US.id(), w2.game.ticks());
      expect(mirvAim(mirvWorld(w2.game), w2.p.N)).toBeNull();
    });

    test("the city rule: 23 levels against a runner-up's 20 name us, 22 do not; the line is 22", () => {
      const w = targetWorld(60, "lg-city");
      const { US, N, Z } = w.p;
      for (let i = 0; i < 5; i++) {
        structureAt(w, Z, UnitType.City, 145 + 6 * i, 20, 4);
      }
      for (let i = 0; i < 7; i++) {
        structureAt(w, US, UnitType.City, 10 + 6 * i, 20, 3);
      }
      structureAt(w, US, UnitType.City, 10, 60, 1);
      // Z 20 levels, us 22.
      expect(Z.unitCount(UnitType.City)).toBe(20);
      expect(US.unitCount(UnitType.City)).toBe(22);
      const l = mirvLines(w.game, US);
      expect(l).toMatchObject({ levels: 22, runner: 20, cityLine: 22 });
      expect(l.cityRoom).toBe(0);
      expect(mirvAim(mirvWorld(w.game), N)).toBeNull();
      expect(
        brains(w, "N", "lg-city").mirv.selectSteamrollStopTarget(),
      ).toBeNull();
      structureAt(w, US, UnitType.City, 16, 60, 1);
      expect(mirvLines(w.game, US).cityRoom).toBe(-1);
      expect(mirvAim(mirvWorld(w.game), N)).toEqual({
        target: US,
        rule: "city",
      });
      expect(brains(w, "N", "lg-city").mirv.selectSteamrollStopTarget()).toBe(
        US,
      );
    });

    test("counter first: while our MIRV flies at N, N aims at us though Z holds 40% of the land", () => {
      const w = targetWorld(60, "lg-counter");
      const { US, N, Z } = w.p;
      for (let x = 60; x < 140; x++) {
        for (let y = 0; y < 200; y++) Z.conquer(w.game.ref(x, y));
      }
      expect(mirvAim(mirvWorld(w.game), N)).toEqual({
        target: Z,
        rule: "land",
      });
      siloAt(w, US, 30, 100);
      setGold(US, 100_000_000n);
      pastImmunity(w);
      send(w, "US", {
        type: "build_unit",
        unit: UnitType.MIRV,
        tile: w.game.ref(265, 100),
      });
      tick(w, 3);
      expect(US.units(UnitType.MIRV)).toHaveLength(1);
      expect(mirvAim(mirvWorld(w.game), N)).toEqual({
        target: US,
        rule: "counter",
      });
      expect(brains(w, "N", "lg-counter").mirv.selectCounterMirvTarget()).toBe(
        US,
      );
    });

    test("danger: each silo owner's gold against its price, its net gold rate, the ticks to the price and the decision after; first is the earliest that aims at us", () => {
      const w = targetWorld(130, "lg-danger");
      const { US, N, Z } = w.p;
      const nm = new NationModel(w.game, US, "lg-danger", createModels(w.game));
      const h = emptyGoldHistory();
      const t0 = w.game.ticks();
      setGold(N, 20_000_000n);
      setGold(Z, 3_000_000n);
      noteGold(h, w.game, t0, 30, 600);
      // Too soon: no second sample.
      noteGold(h, w.game, t0 + 29, 30, 600);
      expect(h.byId[N.id()].t).toEqual([t0]);
      tick(w, 30);
      const t1 = w.game.ticks();
      setGold(N, 20_300_000n);
      noteGold(h, w.game, t1, 30, 600);
      expect(goldRate(h, N.id(), t1, 20_300_000)).toBe(10_000);
      expect(goldRate(h, Z.id(), t1, 3_000_000)).toBe(0);
      const cost = Number(price(w, UnitType.MIRV, N));
      expect(cost).toBe(25_000_000);
      const eta = Math.ceil((cost - 20_300_000) / 10_000);
      expect(eta).toBe(470);
      let d = mirvDanger(w.game, US, nm, h, t1);
      // Z has no silo: not a threat.
      expect(d.threats.map((x) => x.id)).toEqual([N.id()]);
      expect(d.first).toMatchObject({
        id: N.id(),
        gold: 20_300_000,
        price: cost,
        silos: 1,
        slots: 1,
        rate: 10_000,
        eta,
        at: nm.nextDecision(N.id(), t1 + eta),
        rule: "land",
      });
      // Z with a silo and the price now fires first (its next decision).
      siloAt(w, Z, 160, 100);
      setGold(Z, 25_000_000n);
      d = mirvDanger(w.game, US, nm, h, t1);
      expect(d.threats.map((x) => x.id)).toEqual([N.id(), Z.id()]);
      expect(d.first).toMatchObject({
        id: Z.id(),
        eta: 0,
        at: nm.nextDecision(Z.id(), t1 + 1),
        rule: "land",
      });
      // Below 40% (119 of 130 columns: 23,800 tiles): nobody aims at us.
      for (let x = 0; x < 11; x++) {
        for (let y = 0; y < 200; y++) US.relinquish(w.game.ref(x, y));
      }
      expect(mirvLines(w.game, US).landRoom).toBe(200);
      d = mirvDanger(w.game, US, nm, h, t1);
      expect(d.first).toBeNull();
      expect(d.threats.every((x) => x.rule === null)).toBe(true);
    });
  },
);
