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
import type { AgentIntent } from "../../../src/agent/Agent";
import {
  alliancesEndedBy,
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

describe(
  "LeaderGuard: review round 2 (F1 our pending breaks, F3 stale lists, F5 the span)",
  { timeout: 60_000 },
  () => {
    const brk = (id: string): AgentIntent => ({
      type: "breakAlliance",
      recipient: id,
    });
    const bomb = (w: World, unit: UnitType, x: number, y: number) =>
      ({ type: "build_unit", unit, tile: w.game.ref(x, y) }) as AgentIntent;

    test("alliancesEndedBy: a break with an ally, a MIRV at its tile, a bomb at its structure end it; a break with a traitor ally leaves no traitor mark", () => {
      const { w } = setup("lg-end");
      const { B, US, A2, Q } = w.p;
      ally(A2, US);
      const none = { traitor: false, leaving: [] };
      expect(alliancesEndedBy(w.game, US, [brk(B.id())])).toEqual({
        traitor: true,
        leaving: [B.id()],
      });
      // Not allied: nothing ends.
      expect(alliancesEndedBy(w.game, US, [brk(Q.id())])).toEqual(none);
      // A MIRV breaks with the owner of its tile (MIRVExecution): B's
      // land, not the tribe's or ours.
      expect(
        alliancesEndedBy(w.game, US, [bomb(w, UnitType.MIRV, 10, 30)]),
      ).toEqual({ traitor: true, leaving: [B.id()] });
      expect(
        alliancesEndedBy(w.game, US, [bomb(w, UnitType.MIRV, 50, 55)]),
      ).toEqual(none);
      expect(
        alliancesEndedBy(w.game, US, [bomb(w, UnitType.MIRV, 50, 10)]),
      ).toEqual(none);
      // An atom (outer radius 30) at Q's land, 31 tiles from ours and
      // A2's: nothing; 14 tiles from a City of A2's: A2.
      expect(
        alliancesEndedBy(w.game, US, [bomb(w, UnitType.AtomBomb, 110, 30)]),
      ).toEqual(none);
      structureAt(w, A2, UnitType.City, 60, 40);
      expect(
        alliancesEndedBy(w.game, US, [bomb(w, UnitType.AtomBomb, 60, 26)]),
      ).toEqual({ traitor: true, leaving: [A2.id()] });
      expect(
        alliancesEndedBy(w.game, US, [
          brk(B.id()),
          bomb(w, UnitType.AtomBomb, 60, 26),
        ]),
      ).toEqual({ traitor: true, leaving: [A2.id(), B.id()].sort() });
      // Breaking with a traitor marks us none (GameImpl.breakAlliance).
      B.markTraitor();
      expect(alliancesEndedBy(w.game, US, [brk(B.id())])).toEqual({
        traitor: false,
        leaving: [B.id()],
      });
    });

    test("traitorSoon and leaving give the lines the break will give: rule (b) for the ally left, B's other allies out of rule (a)'s sum", () => {
      const { w, nm } = setup("lg-soon");
      const { B, US, A2 } = w.p;
      ally(A2, US);
      nm.refresh(A2.id(), "full");
      const at = { game: w.game, me: US, nm, tick: w.game.ticks() };
      expect(
        betrayalLines(at, EXACT_BETRAYAL)
          .map((l) => l.id)
          .sort(),
      ).toEqual([A2.id(), B.id()].sort());
      const soon = betrayalLines(
        { ...at, traitorSoon: true, leaving: [A2.id()] },
        EXACT_BETRAYAL,
      );
      expect(soon.map((l) => l.id)).toEqual([B.id()]);
      const T = B.troops();
      // B's ally A2 no longer counts (we are a traitor): the tribe alone.
      expect(soon[0]).toMatchObject({
        rule: "traitor",
        home: Math.ceil(T * 1.2),
        others: 30_000,
        total: safeTotal(T, 30_000, 0.33),
      });
      // The real break (BreakAllianceExecution, the turn after the send).
      send(w, "US", { type: "breakAlliance", recipient: A2.id() });
      tick(w, 2);
      expect(US.isTraitor()).toBe(true);
      expect(US.isAlliedWith(A2)).toBe(false);
      const after = betrayalLines(
        { game: w.game, me: US, nm, tick: w.game.ticks() },
        EXACT_BETRAYAL,
      );
      const rules = (ls: BetrayalLine[]) =>
        ls.map(({ id, rule, T, others, total, home, base, alone }) => ({
          id,
          rule,
          T,
          others,
          total,
          home,
          base,
          alone,
        }));
      expect(rules(after)).toEqual(rules(soon));
    });

    test("F3: a refresh from before the ally's previous decision is stale, and the lines read Z.nearby() now (a border lost, a border gained)", () => {
      const { w, nm } = setup("lg-stale");
      const { B, US } = w.p;
      const id = B.id();
      const lines = () =>
        betrayalLines(
          { game: w.game, me: US, nm, tick: w.game.ticks() },
          EXACT_BETRAYAL,
        );
      const pastDecision = () => {
        const d = nm.nextDecision(id, w.game.ticks() + 1);
        tick(w, d - w.game.ticks() + 1);
        const prev =
          nm.nextDecision(id, w.game.ticks() + 1) - nm.params(id).rate;
        expect(nm.nearbyAt(id)).toBeLessThan(prev);
      };
      // We leave B's border: a strip of free land between us.
      for (let x = 20; x < 25; x++) {
        for (let y = 0; y < 30; y++) US.relinquish(w.game.ref(x, y));
      }
      expect(B.nearby().includes(US)).toBe(false);
      // The refresh of this tick is fresh: its list still has us.
      expect(nm.nearbyAt(id)).toBe(w.game.ticks());
      expect(lines().map((l) => [l.id, l.fresh])).toEqual([[id, true]]);
      // Past B's next decision it is stale: B.nearby() now, no line.
      pastDecision();
      expect(lines()).toEqual([]);
      // Back at its border, with a fresh refresh that has us not: none;
      // stale, B.nearby() has us again: the line.
      nm.refresh(id, "full");
      for (let x = 20; x < 25; x++) {
        for (let y = 0; y < 30; y++) US.conquer(w.game.ref(x, y));
      }
      expect(lines()).toEqual([]);
      pastDecision();
      expect(lines().map((l) => [l.id, l.fresh])).toEqual([[id, false]]);
    });

    test('F3: with a stale list, a "locked" gate (read from the same refresh) skips the ally only while it borders free land now', () => {
      const f = setup("lg-lock", 20_000, 30_000, true);
      const { B, US } = f.w.p;
      const id = B.id();
      const gated = { ...EXACT_BETRAYAL, gates: true };
      const lines = () =>
        betrayalLines(
          { game: f.w.game, me: US, nm: f.nm, tick: f.w.game.ticks() },
          gated,
        );
      // Fresh, next to free land: locked, left out.
      expect(lines()).toEqual([]);
      // B takes the free land; past its next decision the list is stale.
      for (let x = 0; x < 3; x++) {
        for (let y = 0; y < 60; y++) B.conquer(f.w.game.ref(x, y));
      }
      const d = f.nm.nextDecision(id, f.w.game.ticks() + 1);
      tick(f.w, d - f.w.game.ticks() + 1);
      // The model still says locked (its refresh saw free land) ...
      const d1 = f.nm.nextDecision(id, f.w.game.ticks() + 1);
      expect(f.nm.gates(id, d1)).toBe("locked");
      // ... but B.nearby() holds none now: the line is kept.
      expect(lines().map((l) => [l.id, l.fresh, l.gate])).toEqual([
        [id, false, "locked"],
      ]);
    });

    test("F5: with a span, T is the larger of the next decision's and the first at or after tick + span", () => {
      const { w, nm } = setup("lg-span");
      const { B, US } = w.p;
      B.setTroops(Math.floor(w.config.maxTroops(B) / 2));
      const id = B.id();
      const t = w.game.ticks();
      const d = nm.nextDecision(id, t + 1);
      const one = lineOf(w, nm);
      expect(one).toMatchObject({ d, d2: d, T: nm.troopsAt(id, d) });
      // tick + span = d + 1: the decision after d.
      const span = d - t + 1;
      const [l] = betrayalLines(
        { game: w.game, me: US, nm, tick: t, span },
        EXACT_BETRAYAL,
      );
      const d2 = d + nm.params(id).rate;
      expect(nm.nextDecision(id, t + span)).toBe(d2);
      expect(l).toMatchObject({ d, d2, T: nm.troopsAt(id, d2) });
      expect(l.T).toBeGreaterThan(one.T);
      expect(l.total).toBe(safeTotal(nm.troopsAt(id, d2), 50_000, 0.33));
      // A span that ends before d changes nothing.
      const [same] = betrayalLines(
        { game: w.game, me: US, nm, tick: t, span: d - t },
        EXACT_BETRAYAL,
      );
      expect(same).toMatchObject({ d, d2: d, T: one.T });
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
    d2: 0,
    gate: "open",
    fresh: true,
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

  test("review F4: a line above maxShare x cap that home holds now stays the floor and still asks for cap; one home is under drops out", () => {
    const lines = [line("a", 3_500_000, 3_500_000, "alone")];
    // cap 4M: max 3.2M; 3.5M / 0.8 - 4M = 375k of cap asked either way.
    expect(
      betrayalFloor(lines, 4_000_000, { maxShare: 0.8 }, 3_600_000),
    ).toEqual({
      floor: 3_500_000,
      by: "a",
      capShort: 375_000,
      shortBy: "a",
    });
    expect(
      betrayalFloor(lines, 4_000_000, { maxShare: 0.8 }, 3_500_000).floor,
    ).toBe(3_500_000);
    expect(
      betrayalFloor(lines, 4_000_000, { maxShare: 0.8 }, 3_499_999),
    ).toEqual({
      floor: 0,
      by: null,
      capShort: 375_000,
      shortBy: "a",
    });
    // A traitor's line: held while home holds it, else its base; it asks
    // for no cap (it lasts only while we are a traitor).
    const t = [line("b", 3_500_000, 500_000, "traitor")];
    expect(betrayalFloor(t, 4_000_000, { maxShare: 0.8 }, 3_600_000)).toEqual({
      floor: 3_500_000,
      by: "b",
      capShort: 0,
      shortBy: null,
    });
    expect(betrayalFloor(t, 4_000_000, { maxShare: 0.8 }, 3_400_000)).toEqual({
      floor: 500_000,
      by: "b",
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
      // Both hold 25M or more: the richest is the first of the two.
      expect(d.richest?.id).toBe(Z.id());
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
