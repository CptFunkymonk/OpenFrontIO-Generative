import {
  deterrenceFloor,
  REMNANT_SHARE,
  REPLICA_STEPS,
  replicaLine,
  strikeBudget,
  transientExit,
} from "../../../src/agent/agents/apex/controllers/StrikeController";
import {
  APEX_DEFAULTS,
  ApexOptions,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import type { View } from "../../../src/agent/agents/apex/policy";
import { createModels } from "../../../src/agent/lib/Models";
import { NationModel } from "../../../src/agent/lib/NationModel";
import { createPurse, HomeFloors } from "../../../src/agent/lib/Scheduler";
import { scanWorld } from "../../../src/agent/lib/WorldModel";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { Player, PlayerInfo, PlayerType } from "../../../src/core/game/Game";
import { addTribe, field, Field, GAME_ID, own, rect } from "./Field";

// Package WP7b R1 FLOOR (docs/14-m4-plan.md §2.7 item 7b, §3 WP7): the
// strike floor's replica line (StrikeController.replicaLine), ported from
// the flow-wt5 prototype. A bordering unallied nation B's line on our home
// is the lowest home in [strikeFlowFloor·cap, its land line] at which
// NationModel's replica says B cannot land-attack us at its next decision
// or its Impossible strategy list picks another player first; the floor
// is never below strikeFlowFloor·cap. Real Config and real nation
// parameters (seeded from the field's game ID); no regrowth runs (no
// PlayerExecution), so troops stay where the test sets them. Tests set
// troops directly; agents never may.
//
// The strategy list [PIN NationTargeting, docs/13-mechanics.md §5.8]:
// veryWeak (< 0.15 of its own cap), then juicy (≤ 0.75 of B's troops),
// then weakest (the fewest troops of B's bordering enemies). With the
// target A next to B holding 0.8 of B's troops, B picks us while our home
// is under A's troops (juicy, then weakest) and A above it: the replica
// line is A's troops, between 0.35 of our cap and B's land line T_B/1.1.

const R1: ApexOptions = parseApexOptions({ strikeFloorReplica: true });
const UE: ApexOptions = parseApexOptions({});

interface World {
  f: Field;
  A: Player;
  B: Player;
  nm: NationModel;
  v: (
    o: ApexOptions,
  ) => Pick<View, "o" | "wm" | "nm" | "game" | "me" | "tick" | "models">;
}

/** Us on the left half; A top right, B bottom right: B borders us and A,
 *  A borders us and B. The whole field is owned (no free land, no tribes:
 *  no gate locks B). */
async function world(aShare: number, bShare: number): Promise<World> {
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
  // Past the nations' 50-tick immunity.
  for (let i = 0; i < 60; i++) game.executeNextTick();
  A.setTroops(Math.round(aShare * config.maxTroops(A)));
  B.setTroops(Math.round(bShare * config.maxTroops(B)));
  me.setTroops(Math.round(0.95 * config.maxTroops(me)));
  const models = createModels(game);
  const nm = new NationModel(game, me, GAME_ID, models);
  const tick = game.ticks();
  nm.observe(tick);
  const wm = scanWorld(game, me, null);
  return {
    f,
    A,
    B,
    nm,
    v: (o) => ({ o, wm, nm, game, me, tick, models }),
  };
}

/** B's picked(H), as replicaLine reads it. */
function picked(w: World, H: number): boolean {
  const d = w.nm.nextDecision(w.B.id(), w.f.game.ticks());
  return (
    w.nm.canLandAttackUs(w.B.id(), H, d) &&
    w.nm.wouldTargetUs(w.B.id(), H) !== null
  );
}

describe("apex strike floor replica (package WP7b R1 FLOOR)", () => {
  test("off by default, at 0.35 of the cap, the target's neighbours at their land lines, no floor minimum", () => {
    expect(APEX_DEFAULTS.strikeFloorReplica).toBe(false);
    expect(APEX_DEFAULTS.strikeFlowFloor).toBe(0.35);
    expect(APEX_DEFAULTS.strikeFloorReplicaUnseen).toBe(false);
    expect(APEX_DEFAULTS.strikeFlowFloorMin).toBe(false);
    expect(APEX_DEFAULTS.strikeFloorReplicaSteady).toBe(false);
    expect(REPLICA_STEPS).toBe(8);
  });

  test("the bisection returns the replica line: B picks us below A's troops and A above them", async () => {
    const w = await world(0.8, 0.9);
    const { A, B, nm, f } = w;
    // A holds 0.8 of B's troops: not juicy to B (> 0.75), and under B's
    // land line (1/1.1).
    A.setTroops(Math.round(0.8 * B.troops()));
    const tick = f.game.ticks();
    const dB = nm.nextDecision(B.id(), tick);
    expect(nm.gates(B.id(), dB)).toBe("open");
    const cap = f.config.maxTroops(f.me);
    const lo = 0.35 * cap;
    const land = (nm.troopsAt(B.id(), dB) + 1) / nm.sendCapSafe();
    expect(lo).toBeLessThan(A.troops());
    expect(A.troops()).toBeLessThan(land);
    // The replica: juicy, then weakest, below A's troops; A above them.
    expect(nm.wouldTargetUs(B.id(), 0.7 * B.troops())).toBe("juicy");
    expect(nm.wouldTargetUs(B.id(), A.troops() - 1000)).toBe("weakest");
    expect(nm.wouldTargetUs(B.id(), A.troops() + 1000)).toBeNull();
    // Monotone on [lo, land]: picked, then not, with one switch.
    const n = 64;
    const scan = Array.from({ length: n + 1 }, (_, i) =>
      picked(w, lo + ((land - lo) * i) / n),
    );
    const flips = scan.filter((x, i) => i > 0 && x !== scan[i - 1]).length;
    expect(scan[0]).toBe(true);
    expect(scan[n]).toBe(false);
    expect(flips).toBe(1);
    // Bisection: the unpicked end of a (land − lo)/256 bracket around A's
    // troops.
    const step = (land - lo) / 2 ** REPLICA_STEPS;
    const line = replicaLine(w.v(R1), B.id(), dB, lo, land);
    expect(picked(w, line)).toBe(false);
    expect(picked(w, line - step)).toBe(true);
    expect(Math.abs(line - A.troops())).toBeLessThanOrEqual(step);
    expect(line).toBeGreaterThan(lo);
    expect(line).toBeLessThan(land);
    // deterrenceFloor (a strike on A; no target neighbour reached): B's
    // replica line with R1, its land line without.
    expect(deterrenceFloor(w.v(R1), A.id(), [])).toBe(line);
    expect(deterrenceFloor(w.v(UE), A.id(), [])).toBeCloseTo(land, 6);
    // strikeBudget spends the difference: home − floor, under the purse.
    const floors: HomeFloors = {
      cap,
      econ: 0,
      vw: 0,
      food: 0,
      H: 0,
      tn: 0,
      strike: 0,
    };
    const budget = (o: ApexOptions) =>
      strikeBudget(
        {
          ...w.v(o),
          purse: createPurse(f.me.troops(), floors),
        } as unknown as View,
        A.id(),
        [],
      );
    expect(budget(R1)).toBeCloseTo(f.me.troops() - line, 6);
    expect(budget(UE)).toBeCloseTo(f.me.troops() - land, 6);
    expect(budget(R1) - budget(UE)).toBeGreaterThan(0.1 * cap);
  });

  test("never below strikeFlowFloor·cap: a nation that picks another player at every home still leaves 0.35 of the cap", async () => {
    // A very weak (under 0.15 of its cap): B's veryWeak picks A at any home
    // of ours at or above 0.35 of our cap.
    const w = await world(0.1, 0.9);
    const { A, B, nm, f } = w;
    const cap = f.config.maxTroops(f.me);
    const dB = nm.nextDecision(B.id(), f.game.ticks());
    const land = (nm.troopsAt(B.id(), dB) + 1) / nm.sendCapSafe();
    expect(nm.canLandAttackUs(B.id(), 0.35 * cap, dB)).toBe(true);
    expect(nm.wouldTargetUs(B.id(), 0.35 * cap)).toBeNull();
    expect(replicaLine(w.v(R1), B.id(), dB, 0.35 * cap, land)).toBe(0.35 * cap);
    expect(deterrenceFloor(w.v(R1), A.id(), [])).toBe(0.35 * cap);
    // strikeFlowFloor moves it.
    const half = parseApexOptions({
      strikeFloorReplica: true,
      strikeFlowFloor: 0.5,
    });
    expect(deterrenceFloor(w.v(half), A.id(), [])).toBe(0.5 * cap);
    // Without R1: B's land line.
    expect(deterrenceFloor(w.v(UE), A.id(), [])).toBeCloseTo(land, 6);
    // A land line under lo: the land line itself (the interval is empty).
    expect(replicaLine(w.v(R1), B.id(), dB, 0.35 * cap, 0.2 * cap)).toBe(
      0.2 * cap,
    );
    // No nation with a line at all (B below its reserve): no floor, with or
    // without R1; with strikeFlowFloorMin (the prototype's), lo.
    const min = parseApexOptions({
      strikeFloorReplica: true,
      strikeFlowFloorMin: true,
    });
    expect(deterrenceFloor(w.v(min), A.id(), [])).toBe(0.35 * cap);
    B.setTroops(Math.round(0.1 * f.config.maxTroops(B)));
    expect(nm.gates(B.id(), nm.nextDecision(B.id(), f.game.ticks()))).toBe(
      "belowReserve",
    );
    expect(deterrenceFloor(w.v(UE), A.id(), [])).toBe(0);
    expect(deterrenceFloor(w.v(R1), A.id(), [])).toBe(0);
    expect(deterrenceFloor(w.v(R1), A.id())).toBe(0);
    expect(deterrenceFloor(w.v(min), A.id(), [])).toBe(0.35 * cap);
    expect(deterrenceFloor(w.v(min), A.id())).toBe(0.35 * cap);
    // strikeDeterrence off: no floor either way.
    const noDet = parseApexOptions({
      strikeFloorReplica: true,
      strikeDeterrence: false,
    });
    expect(deterrenceFloor(w.v(noDet), A.id(), [])).toBe(0);
  });

  test("with the option off nothing changes: the land-line floor, whatever the R1 sub-options say", async () => {
    for (const [aShare, bShare] of [
      [0.8, 0.9],
      [0.1, 0.9],
      [0.95, 0.62],
      [0.5, 0.2],
    ]) {
      const w = await world(aShare, bShare);
      const { A, B, nm, f } = w;
      const tick = f.game.ticks();
      // The floor as it was before package WP7b: B's land line where its
      // gates are open or below trigger, else 0; the same for a strike on
      // B with A's.
      const landOf = (N: Player) => {
        const d = nm.nextDecision(N.id(), tick);
        const g = nm.gates(N.id(), d);
        if (g === "locked" || g === "belowReserve") return 0;
        return (nm.troopsAt(N.id(), d) + 1) / nm.sendCapSafe();
      };
      for (const o of [
        UE,
        parseApexOptions({ strikeFlowFloor: 0.9 }),
        parseApexOptions({ strikeFloorReplicaUnseen: true }),
        parseApexOptions({ strikeFlowFloorMin: true }),
        parseApexOptions({
          strikeFlowFloor: 0,
          strikeFloorReplicaUnseen: true,
          strikeFlowFloorMin: true,
        }),
      ]) {
        expect(deterrenceFloor(w.v(o), A.id(), [])).toBe(landOf(B));
        expect(deterrenceFloor(w.v(o), B.id(), [])).toBe(landOf(A));
        expect(deterrenceFloor(w.v(o), A.id())).toBe(
          deterrenceFloor(w.v(UE), A.id()),
        );
        expect(deterrenceFloor(w.v(o), null)).toBe(
          deterrenceFloor(w.v(UE), null),
        );
      }
      // R1 never raises the floor, and lowers it no further than 0.35 of
      // the cap; with strikeFlowFloorMin the floor is at least that.
      const cap = f.config.maxTroops(f.me);
      const r1 = deterrenceFloor(w.v(R1), A.id(), []);
      expect(r1).toBeLessThanOrEqual(landOf(B));
      expect(r1).toBeGreaterThanOrEqual(Math.min(landOf(B), 0.35 * cap));
      const min = parseApexOptions({
        strikeFloorReplica: true,
        strikeFlowFloorMin: true,
      });
      expect(deterrenceFloor(w.v(min), A.id(), [])).toBe(
        Math.max(r1, 0.35 * cap),
      );
    }
  });

  test("the target's neighbours keep their land lines; strikeFloorReplicaUnseen reads them through the replica, which drops them to 0.35 of the cap", async () => {
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
    const models = createModels(game);
    const nm = new NationModel(game, me, GAME_ID, models);
    const tick = game.ticks();
    nm.observe(tick);
    const wm = scanWorld(game, me, null);
    const v = (o: ApexOptions) => ({ o, wm, nm, game, me, tick, models });
    const cap = config.maxTroops(me);
    const dX = nm.nextDecision(X.id(), tick);
    const land = (nm.troopsAt(X.id(), dX) + 1) / nm.sendCapSafe();
    expect(land).toBeGreaterThan(0.35 * cap);
    // A1's near-target floor: X's land line, with and without R1.
    expect(deterrenceFloor(v(UE), T.id())).toBeCloseTo(land, 6);
    expect(deterrenceFloor(v(R1), T.id())).toBeCloseTo(land, 6);
    expect(deterrenceFloor(v(R1), T.id(), [X])).toBeCloseTo(land, 6);
    // The replica reads today's borders: X shares none with us, so it
    // "cannot attack" at any home, and the prototype's reading drops its
    // line to lo.
    expect(nm.get(X.id())?.full).toBe(true);
    expect(nm.get(X.id())?.sharesBorderWithUs).toBe(false);
    expect(nm.canLandAttackUs(X.id(), 1, dX)).toBe(false);
    const proto = parseApexOptions({
      strikeFloorReplica: true,
      strikeFloorReplicaUnseen: true,
    });
    expect(deterrenceFloor(v(proto), T.id())).toBe(0.35 * cap);
    // Below its reserve X adds nothing either way; only strikeFlowFloorMin
    // keeps lo.
    X.setTroops(Math.round(0.1 * config.maxTroops(X)));
    expect(deterrenceFloor(v(UE), T.id())).toBe(0);
    expect(deterrenceFloor(v(R1), T.id())).toBe(0);
    expect(deterrenceFloor(v(proto), T.id())).toBe(0);
    const exact = parseApexOptions({
      strikeFloorReplica: true,
      strikeFloorReplicaUnseen: true,
      strikeFlowFloorMin: true,
    });
    expect(deterrenceFloor(v(exact), T.id())).toBe(0.35 * cap);
  });

  test("a bordering nation whose last full refresh did not see our border keeps its land line until a refresh sees it", async () => {
    // Us | A | B, then B takes the bottom of A's strip and borders us: the
    // scan sees it at once, NationModel only at B's next full refresh (up
    // to a decision interval later: once before each decision).
    const f = await field({ width: 80, height: 40 });
    const { game, me, config } = f;
    own(me, rect(game, 0, 0, 40, 40));
    const add = (id: string, x0: number, x1: number) => {
      const n = game.addPlayer(new PlayerInfo(id, PlayerType.Nation, null, id));
      own(n, rect(game, x0, 0, x1, 40));
      return n;
    };
    const A = add("NATIONA1", 40, 60);
    const B = add("NATIONB1", 60, 80);
    for (let i = 0; i < 60; i++) game.executeNextTick();
    const models = createModels(game);
    const nm = new NationModel(game, me, GAME_ID, models);
    nm.observe(game.ticks());
    nm.refresh(B.id(), "full");
    expect(nm.get(B.id())?.sharesBorderWithUs).toBe(false);
    own(B, rect(game, 40, 30, 60, 40));
    A.setTroops(Math.round(0.9 * config.maxTroops(A)));
    B.setTroops(Math.round(0.9 * config.maxTroops(B)));
    me.setTroops(Math.round(0.95 * config.maxTroops(me)));
    const tick = game.ticks();
    const wm = scanWorld(game, me, null);
    expect(wm.nations.map((n) => n.id).sort()).toEqual([A.id(), B.id()]);
    expect(nm.get(B.id())?.sharesBorderWithUs).toBe(false);
    const v = (o: ApexOptions) => ({ o, wm, nm, game, me, tick, models });
    const cap = config.maxTroops(me);
    const dB = nm.nextDecision(B.id(), tick);
    const land = (nm.troopsAt(B.id(), dB) + 1) / nm.sendCapSafe();
    expect(land).toBeGreaterThan(0.35 * cap);
    // Unseen: the replica would say "cannot attack" (no border in its
    // refresh). R1 keeps B's land line; the prototype's reading drops it.
    expect(nm.canLandAttackUs(B.id(), 0.35 * cap, dB)).toBe(false);
    expect(deterrenceFloor(v(UE), A.id(), [])).toBeCloseTo(land, 6);
    expect(deterrenceFloor(v(R1), A.id(), [])).toBeCloseTo(land, 6);
    const unseen = parseApexOptions({
      strikeFloorReplica: true,
      strikeFloorReplicaUnseen: true,
    });
    expect(deterrenceFloor(v(unseen), A.id(), [])).toBe(0.35 * cap);
    // B's next full refresh sees the border: its replica line. B picks us
    // (juicy, then weakest) below A's troops, A above them.
    nm.refresh(B.id(), "full");
    expect(nm.get(B.id())?.sharesBorderWithUs).toBe(true);
    const line = replicaLine(v(R1), B.id(), dB, 0.35 * cap, land);
    expect(line).toBeGreaterThan(0.35 * cap);
    expect(line).toBeLessThan(land);
    expect(Math.abs(line - A.troops())).toBeLessThanOrEqual(
      (land - 0.35 * cap) / 2 ** REPLICA_STEPS,
    );
    expect(deterrenceFloor(v(R1), A.id(), [])).toBe(line);
    expect(deterrenceFloor(v(unseen), A.id(), [])).toBe(line);
  });

  test("strikeFloorReplicaSteady: a remnant attack on B, or B's last tribe, keeps B's land line", async () => {
    const steadyO = parseApexOptions({
      strikeFloorReplica: true,
      strikeFloorReplicaSteady: true,
    });
    // A fresh model and scan at the current tick.
    const at = (w: World) => {
      const { game, me } = w.f;
      const models = createModels(game);
      const nm = new NationModel(game, me, GAME_ID, models);
      const tick = game.ticks();
      nm.observe(tick);
      const wm = scanWorld(game, me, null);
      return {
        nm,
        v: (o: ApexOptions) => ({ o, wm, nm, game, me, tick, models }),
      };
    };
    for (const troops of [1000, 0.2]) {
      // A attacks B (the replica's retaliate step: B answers A first). 1k
      // is a remnant; a fifth of B's troops is not.
      const w = await world(0.8, 0.9);
      const { A, B, f } = w;
      A.setTroops(Math.round(0.8 * B.troops()));
      const sent = troops < 1 ? Math.round(troops * B.troops()) : troops;
      A.setTroops(A.troops() + sent);
      f.game.addExecution(new AttackExecution(sent, A, B.id()));
      f.game.executeNextTick();
      const inc = B.incomingAttacks().filter((a) => a.attacker() === A);
      expect(inc.length).toBe(1);
      const { nm, v } = at(w);
      const cap = f.config.maxTroops(f.me);
      const dB = nm.nextDecision(B.id(), f.game.ticks());
      const land = (nm.troopsAt(B.id(), dB) + 1) / nm.sendCapSafe();
      // The replica: B retaliates against A at any home of ours.
      expect(nm.wouldTargetUs(B.id(), 0.35 * cap)).toBeNull();
      expect(deterrenceFloor(v(R1), A.id(), [])).toBe(0.35 * cap);
      const remnant = inc[0].troops() < REMNANT_SHARE * B.troops();
      expect(remnant).toBe(troops === 1000);
      expect(transientExit(v(steadyO), B, nm.get(B.id())!)).toBe(
        remnant ? "remnant" : null,
      );
      if (remnant) {
        expect(deterrenceFloor(v(steadyO), A.id(), [])).toBeCloseTo(land, 6);
      } else {
        expect(deterrenceFloor(v(steadyO), A.id(), [])).toBe(0.35 * cap);
      }
    }
    // B's last tribe (its bots step): a small tribe carved out of B.
    const w = await world(0.8, 0.9);
    const { A, B, f } = w;
    A.setTroops(Math.round(0.8 * B.troops()));
    addTribe(f, "TRIBE001", rect(f.game, 76, 36, 80, 40), 500, false);
    const { nm, v } = at(w);
    nm.refresh(B.id(), "full");
    expect(nm.get(B.id())?.affordableTribes).toBe(1);
    const cap = f.config.maxTroops(f.me);
    const dB = nm.nextDecision(B.id(), f.game.ticks());
    const land = (nm.troopsAt(B.id(), dB) + 1) / nm.sendCapSafe();
    expect(nm.gates(B.id(), dB)).toBe("open");
    expect(nm.wouldTargetUs(B.id(), 0.35 * cap)).toBeNull();
    expect(deterrenceFloor(v(R1), A.id(), [])).toBe(0.35 * cap);
    expect(transientExit(v(steadyO), B, nm.get(B.id())!)).toBe("lastTribe");
    expect(deterrenceFloor(v(steadyO), A.id(), [])).toBeCloseTo(land, 6);
  });

  test("without a full refresh of the nation the replica keeps its land line", async () => {
    const w = await world(0.8, 0.9);
    const fresh = new NationModel(
      w.f.game,
      w.f.me,
      GAME_ID,
      createModels(w.f.game),
    );
    expect(fresh.get(w.B.id())).toBeUndefined();
    const v = { ...w.v(R1), nm: fresh };
    const d = fresh.nextDecision(w.B.id(), w.f.game.ticks());
    expect(replicaLine(v, w.B.id(), d, 1000, 200_000)).toBe(200_000);
    // It read nothing: still no state for B.
    expect(fresh.get(w.B.id())).toBeUndefined();
  });
});
