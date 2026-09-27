import {
  boatLine,
  deterrenceFloor,
  firmExit,
  FloorWhy,
  regrowLine,
  REMNANT_SHARE,
  REPLICA_STEPS,
  replicaLine,
  strikeBudget,
  transientExit,
  VICTIM_SHARE,
} from "../../../src/agent/agents/apex/controllers/StrikeController";
import {
  APEX_DEFAULTS,
  ApexOptions,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import type { View } from "../../../src/agent/agents/apex/policy";
import { createModels } from "../../../src/agent/lib/Models";
import { NationModel } from "../../../src/agent/lib/NationModel";
import { buildRaceGrid, ownerGrid } from "../../../src/agent/lib/RaceField";
import { createPurse, HomeFloors } from "../../../src/agent/lib/Scheduler";
import { scanWorld } from "../../../src/agent/lib/WorldModel";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { Player, PlayerInfo, PlayerType } from "../../../src/core/game/Game";
import { addTribe, field, Field, GAME_ID, own, rect, Terrain } from "./Field";

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
const FIRM: ApexOptions = parseApexOptions({
  strikeFloorReplica: true,
  strikeFloorReplicaFirm: true,
});

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
    expect(APEX_DEFAULTS.strikeFloorReplicaFirm).toBe(false);
    expect(APEX_DEFAULTS.strikeFloorReplicaBoats).toBe(false);
    expect(APEX_DEFAULTS.strikeFloorReplicaRegrow).toBe(false);
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
    // Its pick above A's troops is A, our target: strikeFloorReplicaFirm
    // keeps B's land line (the strike takes A).
    const why: FloorWhy = { bind: null, kept: [] };
    expect(deterrenceFloor(w.v(FIRM), A.id(), [], why)).toBeCloseTo(land, 6);
    expect(why).toEqual({ bind: B.id(), kept: [`${B.id()}:target`] });
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
        parseApexOptions({
          strikeFloorReplicaSteady: true,
          strikeFloorReplicaFirm: true,
          strikeFloorReplicaBoats: true,
          strikeFloorReplicaRegrow: true,
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

  // ── Review of WP7b: strikeFloorReplicaFirm (F1, F2, F5) and
  //    strikeFloorReplicaBoats (F4) ──────────────────────────────────────

  test("strikeFloorReplicaFirm keeps a line that rests on B's own choice of a steady land neighbour, and B's land line when that neighbour is our target", async () => {
    const { f, P } = await scene(COLUMNS);
    const { NATIONB1: B, NATIONC1: C, NATIOND1: D } = P;
    const { config, me } = f;
    B.setTroops(Math.round(0.9 * config.maxTroops(B)));
    C.setTroops(Math.round(0.8 * B.troops()));
    D.setTroops(Math.round(0.5 * config.maxTroops(D)));
    me.setTroops(Math.round(0.95 * config.maxTroops(me)));
    const { nm, v } = look(f);
    const cap = config.maxTroops(me);
    const lo = 0.35 * cap;
    const dB = nm.nextDecision(B.id(), f.game.ticks());
    const land = (nm.troopsAt(B.id(), dB) + 1) / nm.sendCapSafe();
    // B picks us below C's troops (juicy, then weakest) and C above them.
    const line = replicaLine(v(R1), B.id(), dB, lo, land);
    expect(line).toBeGreaterThan(lo);
    expect(line).toBeLessThan(land);
    expect(Math.abs(line - C.troops())).toBeLessThanOrEqual(
      (land - lo) / 2 ** REPLICA_STEPS,
    );
    expect(nm.wouldTargetUs(B.id(), line)).toBeNull();
    // A strike on D: C borders B by land, is not the target and nobody's
    // victim; nothing attacks B and it borders no tribe. The line holds.
    expect(firmExit(v(FIRM), B, dB, line, D.id())).toBeNull();
    const why: FloorWhy = { bind: null, kept: [] };
    expect(deterrenceFloor(v(FIRM), D.id(), [], why)).toBe(line);
    expect(why).toEqual({ bind: B.id(), kept: [] });
    expect(deterrenceFloor(v(R1), D.id(), [])).toBe(line);
    // A strike on C: B's pick is the target, which the strike takes.
    expect(firmExit(v(FIRM), B, dB, line, C.id())).toBe("target");
    expect(deterrenceFloor(v(R1), C.id(), [])).toBe(line);
    expect(deterrenceFloor(v(FIRM), C.id(), [])).toBeCloseTo(land, 6);
  });

  test("strikeFloorReplicaFirm: a line that rests on a third nation's troops (B's send cap) keeps B's land line; once that nation launches, B can attack us there and picks us", async () => {
    // Review of WP7b F1 (its scratch Wp7bThirdParty): X the target, B
    // under it, C right of both; C holds 1.1x B's troops.
    const { f, P } = await scene({
      width: 120,
      height: 40,
      us: [0, 0, 40, 40],
      nations: [
        ["NATIONX1", [40, 0, 80, 20]],
        ["NATIONB1", [40, 20, 80, 40]],
        ["NATIONC1", [80, 0, 120, 40]],
      ],
    });
    const { NATIONX1: X, NATIONB1: B, NATIONC1: C } = P;
    const { config, me } = f;
    me.setTroops(Math.round(0.9 * config.maxTroops(me)));
    B.setTroops(Math.round(0.9 * config.maxTroops(B)));
    X.setTroops(Math.round(0.5 * config.maxTroops(X)));
    C.setTroops(Math.round(1.1 * B.troops()));
    const a = look(f);
    const cap = config.maxTroops(me);
    const lo = 0.35 * cap;
    const d = a.nm.nextDecision(B.id(), f.game.ticks());
    const land = (a.nm.troopsAt(B.id(), d) + 1) / a.nm.sendCapSafe();
    expect(land).toBeGreaterThan(lo);
    // T_B − ⌈0.9·T_C⌉ is under 20% of any home from lo up: "cannot".
    expect(a.nm.canLandAttackUs(B.id(), lo, d)).toBe(false);
    expect(deterrenceFloor(a.v(R1), X.id(), [])).toBe(lo);
    expect(firmExit(a.v(FIRM), B, d, lo, X.id())).toBe("cannot");
    const why: FloorWhy = { bind: null, kept: [] };
    expect(deterrenceFloor(a.v(FIRM), X.id(), [], why)).toBeCloseTo(land, 6);
    expect(deterrenceFloor(a.v(UE), X.id(), [])).toBeCloseTo(land, 6);
    expect(why.kept).toEqual([`${B.id()}:cannot`]);
    // C launches elsewhere and its home drops: at lo B can attack us, and
    // its list picks us.
    C.setTroops(Math.round(0.8 * C.troops()));
    const b = look(f);
    const d2 = b.nm.nextDecision(B.id(), f.game.ticks());
    expect(b.nm.canLandAttackUs(B.id(), lo, d2)).toBe(true);
    expect(b.nm.wouldTargetUs(B.id(), lo)).not.toBeNull();
  });

  test("strikeFloorReplicaFirm: B borders the target (the strike takes its pick), is attacked by another nation, borders a tribe, or has a victim for an enemy: B keeps its land line", async () => {
    // "target" (review F2, its scratch Wp7bTarget, the Strikes.test.ts
    // e2e scene): T, under its reserve, over B. B's veryWeak picks T at any
    // home of ours; once the strike takes T, it picks us at lo.
    {
      const { f, P } = await scene({
        width: 120,
        height: 40,
        us: [0, 0, 30, 40],
        nations: [
          ["NATIONT1", [30, 0, 120, 20]],
          ["NATIONB1", [30, 20, 120, 40]],
        ],
      });
      const { NATIONT1: T, NATIONB1: B } = P;
      const { config, me, game } = f;
      B.setTroops(Math.round(0.9 * config.maxTroops(B)));
      T.setTroops(Math.round(0.08 * config.maxTroops(T)));
      me.setTroops(Math.round(0.95 * config.maxTroops(me)));
      const a = look(f);
      const lo = 0.35 * config.maxTroops(me);
      const dB = a.nm.nextDecision(B.id(), game.ticks());
      const land = (a.nm.troopsAt(B.id(), dB) + 1) / a.nm.sendCapSafe();
      expect(land).toBeGreaterThan(me.troops());
      expect(deterrenceFloor(a.v(R1), T.id())).toBe(lo);
      expect(firmExit(a.v(FIRM), B, dB, lo, T.id())).toBe("target");
      expect(deterrenceFloor(a.v(FIRM), T.id())).toBeCloseTo(land, 6);
      own(me, rect(game, 30, 0, 120, 20));
      game.executeNextTick();
      expect(T.isAlive()).toBe(false);
      const b = look(f);
      const dB2 = b.nm.nextDecision(B.id(), game.ticks());
      expect(b.nm.canLandAttackUs(B.id(), lo, dB2)).toBe(true);
      expect(b.nm.wouldTargetUs(B.id(), lo)).not.toBeNull();
    }
    // Us | B | C | D, the strike on D; C holds 0.8 of B's troops (as in the
    // first test, where B's line held).
    const base = async () => {
      const { f, P } = await scene(COLUMNS);
      const { config, me } = f;
      P.NATIONB1.setTroops(Math.round(0.9 * config.maxTroops(P.NATIONB1)));
      P.NATIONC1.setTroops(Math.round(0.8 * P.NATIONB1.troops()));
      P.NATIOND1.setTroops(Math.round(0.5 * config.maxTroops(P.NATIOND1)));
      me.setTroops(Math.round(0.95 * config.maxTroops(me)));
      return { f, P };
    };
    const check = (f: Field, P: Record<string, Player>, reason: string) => {
      const { nm, v } = look(f);
      const B = P.NATIONB1;
      const D = P.NATIOND1;
      const dB = nm.nextDecision(B.id(), f.game.ticks());
      const land = (nm.troopsAt(B.id(), dB) + 1) / nm.sendCapSafe();
      const r1 = deterrenceFloor(v(R1), D.id(), []);
      expect(r1).toBeLessThan(land);
      expect(firmExit(v(FIRM), B, dB, r1, D.id())).toBe(reason);
      const why: FloorWhy = { bind: null, kept: [] };
      expect(deterrenceFloor(v(FIRM), D.id(), [], why)).toBeCloseTo(land, 6);
      expect(why.kept).toEqual([`${B.id()}:${reason}`]);
    };
    // "attacked": C attacks B with a fifth of B's troops (no remnant): the
    // replica has B answer C at any home.
    {
      const { f, P } = await base();
      const { NATIONB1: B, NATIONC1: C } = P;
      const sent = Math.round(0.2 * B.troops());
      C.setTroops(C.troops() + sent);
      f.game.addExecution(new AttackExecution(sent, C, B.id()));
      f.game.executeNextTick();
      const { nm, v } = look(f);
      expect(transientExit(v(R1), B, nm.refresh(B.id(), "full"))).toBeNull();
      check(f, P, "attacked");
    }
    // "tribes": a tribe cut out of B's corner.
    {
      const { f, P } = await base();
      addTribe(f, "TRIBE001", rect(f.game, 56, 36, 60, 40), 500, false);
      check(f, P, "tribes");
    }
    // "victim": D attacks C with more than half of C's troops.
    {
      const { f, P } = await base();
      const { NATIONC1: C, NATIOND1: D } = P;
      C.setTroops(Math.round(0.3 * f.config.maxTroops(C)));
      const sent = Math.round(1.2 * VICTIM_SHARE * C.troops());
      D.setTroops(D.troops() + sent);
      f.game.addExecution(new AttackExecution(sent, D, C.id()));
      f.game.executeNextTick();
      let inc = 0;
      for (const a of C.incomingAttacks()) inc += a.troops();
      expect(inc).toBeGreaterThan(VICTIM_SHARE * C.troops());
      check(f, P, "victim");
    }
  });

  test("strikeFloorReplicaFirm: a pick off B's land border (an enemy over a river, a Hostile relation, an ally's target) keeps B's land line", async () => {
    // "overWater" (review F5): C across a 3-tile river from B, in B's
    // nearby() (shore reach up to 4 water tiles) but no land border: a send
    // there is a boat of T/5 that can fail.
    {
      const { f, P } = await scene({
        width: 123,
        height: 40,
        terrain: (x) => (x >= 60 && x < 63 ? "water" : "plains"),
        us: [0, 0, 30, 40],
        nations: [
          ["NATIONB1", [30, 0, 60, 40]],
          ["NATIONC1", [63, 0, 93, 40]],
          ["NATIOND1", [93, 0, 123, 40]],
        ],
      });
      const { NATIONB1: B, NATIONC1: C, NATIOND1: D } = P;
      const { config, me } = f;
      B.setTroops(Math.round(0.9 * config.maxTroops(B)));
      C.setTroops(Math.round(0.8 * B.troops()));
      me.setTroops(Math.round(0.95 * config.maxTroops(me)));
      const { nm, v } = look(f);
      const dB = nm.nextDecision(B.id(), f.game.ticks());
      const land = (nm.troopsAt(B.id(), dB) + 1) / nm.sendCapSafe();
      expect(nm.nearbyOf(B.id())).toContain(C.smallID());
      expect(B.sharesBorderWith(C)).toBe(false);
      // The replica sends B's troops to C by land: the line is C's troops.
      const r1 = deterrenceFloor(v(R1), D.id(), []);
      expect(r1).toBeLessThan(land);
      expect(Math.abs(r1 - C.troops())).toBeLessThanOrEqual(
        (land - 0.35 * config.maxTroops(me)) / 2 ** REPLICA_STEPS,
      );
      expect(firmExit(v(FIRM), B, dB, r1, D.id())).toBe("overWater");
      expect(deterrenceFloor(v(FIRM), D.id(), [])).toBeCloseTo(land, 6);
    }
    // "hated" and "assist": picks at any distance. Us | B | C | D.
    const { f, P } = await scene(COLUMNS);
    const { NATIONB1: B, NATIONC1: C, NATIOND1: D } = P;
    const { config, me } = f;
    B.setTroops(Math.round(0.9 * config.maxTroops(B)));
    C.setTroops(Math.round(0.8 * B.troops()));
    me.setTroops(Math.round(0.95 * config.maxTroops(me)));
    const lo = 0.35 * config.maxTroops(me);
    const at = () => {
      const { nm, v } = look(f);
      return { v, dB: nm.nextDecision(B.id(), f.game.ticks()) };
    };
    {
      const { v, dB } = at();
      expect(firmExit(v(FIRM), B, dB, lo, null)).toBeNull();
    }
    // B hates D (not its neighbour).
    B.updateRelation(D, -100);
    {
      const { v, dB } = at();
      expect(firmExit(v(FIRM), B, dB, lo, null)).toBe("hated");
      // Our target: "target".
      expect(firmExit(v(FIRM), B, dB, lo, D.id())).toBe("target");
    }
    B.updateRelation(D, 100);
    // B allied with C, whose target is D.
    C.createAllianceRequest(B)!.accept();
    C.target(D);
    {
      const { v, dB } = at();
      expect(firmExit(v(FIRM), B, dB, lo, null)).toBe("assist");
    }
  });

  test("strikeFloorReplicaBoats: a lowered floor is at least the troops of an unallied nation that can boat us, up to A1's floor", async () => {
    // Land band (y < 40): us | B | W; sea (40 <= y < 60); K below it. B's
    // veryWeak picks W at every home: R1's floor is lo. K (over the sea,
    // within 150 tiles, on the ocean shore as we are) can boat us.
    const sea = (x: number, y: number): Terrain =>
      y >= 40 && y < 60 ? "water" : "plains";
    const { f, P } = await scene({
      width: 80,
      height: 100,
      terrain: sea,
      us: [0, 0, 40, 40],
      nations: [
        ["NATIONB1", [40, 0, 70, 40]],
        ["NATIONW1", [70, 0, 80, 40]],
        ["NATIONK1", [0, 60, 80, 100]],
      ],
    });
    const { NATIONB1: B, NATIONW1: W, NATIONK1: K } = P;
    const { config, me } = f;
    B.setTroops(Math.round(0.9 * config.maxTroops(B)));
    W.setTroops(Math.round(0.05 * config.maxTroops(W)));
    me.setTroops(Math.round(0.95 * config.maxTroops(me)));
    const lo = 0.35 * config.maxTroops(me);
    const BOATS = parseApexOptions({
      strikeFloorReplica: true,
      strikeFloorReplicaBoats: true,
    });
    const at = (grids: boolean) => {
      const { nm, v } = look(f, grids);
      const dB = nm.nextDecision(B.id(), f.game.ticks());
      return { v, land: (nm.troopsAt(B.id(), dB) + 1) / nm.sendCapSafe() };
    };
    let { land } = at(true);
    expect(land).toBeGreaterThan(lo);
    K.setTroops(Math.round((lo + land) / 2));
    let v: ReturnType<typeof at>["v"];
    ({ v, land } = at(true));
    expect(deterrenceFloor(v(R1), null)).toBe(lo);
    expect(deterrenceFloor(v(UE), null)).toBeCloseTo(land, 6);
    // K and W (on the shore, within reach) can boat us; B borders us.
    expect(boatLine(v(BOATS), 0)).toBe(K.troops());
    const why: FloorWhy = { bind: null, kept: [] };
    expect(deterrenceFloor(v(BOATS), null, undefined, why)).toBe(K.troops());
    expect(why.bind).toBe("boats");
    // Never above A1's floor.
    K.setTroops(Math.round(2 * land));
    ({ v, land } = at(true));
    expect(deterrenceFloor(v(BOATS), null)).toBeCloseTo(land, 6);
    // An ally of ours does not count; without the grids, reach is unknown:
    // A1's floor.
    K.setTroops(Math.round((lo + land) / 2));
    ({ v, land } = at(false));
    expect(boatLine(v(BOATS), 0)).toBe(Infinity);
    expect(deterrenceFloor(v(BOATS), null)).toBeCloseTo(land, 6);
    me.createAllianceRequest(K)!.accept();
    ({ v } = at(true));
    expect(boatLine(v(BOATS), 0)).toBe(W.troops());
    expect(deterrenceFloor(v(BOATS), null)).toBe(lo);
    // Off: R1's floor.
    expect(deterrenceFloor(v(R1), null)).toBe(lo);
  });

  test("strikeFloorReplicaRegrow: a lowered line is at least the home that regrows to B's land line at its decision after next; a nation whose land line tops our cap keeps it", async () => {
    const { f, P } = await scene(COLUMNS);
    const { NATIONB1: B, NATIONC1: C, NATIOND1: D } = P;
    const { config, me, game } = f;
    // B mid-cap (a nation's cap is 1.25x ours on the same land here): its
    // land line is half our cap. C, weaker, is juicier than us at any home
    // from lo up, so the replica line is lo.
    B.setTroops(Math.round(0.45 * config.maxTroops(B)));
    C.setTroops(Math.round(0.5 * B.troops()));
    D.setTroops(Math.round(0.5 * config.maxTroops(D)));
    me.setTroops(Math.round(0.95 * config.maxTroops(me)));
    const REGROW = parseApexOptions({
      strikeFloorReplica: true,
      strikeFloorReplicaFirm: true,
      strikeFloorReplicaRegrow: true,
    });
    const { nm, v } = look(f);
    const tick = game.ticks();
    const safe = nm.sendCapSafe();
    const d = nm.nextDecision(B.id(), tick);
    const d2 = nm.nextDecision(B.id(), d + 1);
    expect(d2).toBeGreaterThan(d);
    const land = (nm.troopsAt(B.id(), d) + 1) / safe;
    const L2 = (nm.troopsAt(B.id(), d2) + 1) / safe;
    // Firm's line (B's pick above C's troops is C, a steady land neighbour).
    const line = deterrenceFloor(v(FIRM), D.id(), []);
    expect(line).toBeLessThan(land);
    // From regrowLine our home, regrowing tick by tick (floored), reaches
    // B's land line at d2 by d2, and from a little below it does not.
    const H0 = regrowLine(v(REGROW), B.id(), d, safe);
    expect(H0).toBeLessThan(L2);
    const models = createModels(game);
    const regrow = (H: number) => {
      for (let t = 0; t < d2 - tick; t++) {
        H += Math.floor(models.regrowthAt(me.type(), H, me.numTilesOwned(), 0));
      }
      return H;
    };
    expect(regrow(H0)).toBeGreaterThanOrEqual(L2 - 2);
    expect(regrow(H0 - 0.01 * L2)).toBeLessThan(L2);
    // Here the bound binds between the two: our regrowth over the two
    // decisions outruns B's growth.
    expect(line).toBeLessThan(H0);
    expect(H0).toBeLessThan(land);
    const why: FloorWhy = { bind: null, kept: [] };
    expect(deterrenceFloor(v(REGROW), D.id(), [], why)).toBeCloseTo(H0, 6);
    expect(why).toEqual({ bind: B.id(), kept: [] });
    // A nation whose land line at d2 tops our cap: no home of ours regrows
    // there, and it keeps its land line.
    B.setTroops(Math.round(2.2 * config.maxTroops(me)));
    C.setTroops(Math.round(0.5 * config.maxTroops(me)));
    const g = look(f);
    const dg = g.nm.nextDecision(B.id(), tick);
    const landG = (g.nm.troopsAt(B.id(), dg) + 1) / safe;
    expect(landG).toBeGreaterThan(config.maxTroops(me));
    expect(regrowLine(g.v(REGROW), B.id(), dg, safe)).toBe(Infinity);
    const lowered = deterrenceFloor(g.v(FIRM), D.id(), []);
    expect(lowered).toBeLessThan(landG);
    const whyG: FloorWhy = { bind: null, kept: [] };
    expect(deterrenceFloor(g.v(REGROW), D.id(), [], whyG)).toBeCloseTo(
      landG,
      6,
    );
    expect(whyG.kept).toEqual([`${B.id()}:regrow`]);
  });

  test("boatLine: no ocean shore of ours, no boats", async () => {
    const { f, P } = await scene(COLUMNS);
    const { v } = look(f, true);
    expect(P.NATIONB1.isAlive()).toBe(true);
    expect(boatLine(v(R1), 0)).toBe(0);
  });
});

type Box = [number, number, number, number];

/** Us | B | C | D, 30 columns each, 40 high: B borders us and C, C borders
 *  B and D. */
const COLUMNS: {
  width: number;
  height: number;
  us: Box;
  nations: [string, Box][];
} = {
  width: 120,
  height: 40,
  us: [0, 0, 30, 40],
  nations: [
    ["NATIONB1", [30, 0, 60, 40]],
    ["NATIONC1", [60, 0, 90, 40]],
    ["NATIOND1", [90, 0, 120, 40]],
  ],
};

/** Us and nations on rectangles of land, past the nations' 50-tick
 *  immunity. */
async function scene(o: {
  width: number;
  height: number;
  terrain?: (x: number, y: number) => Terrain;
  us: Box;
  nations: [string, Box][];
}): Promise<{ f: Field; P: Record<string, Player> }> {
  const f = await field({
    width: o.width,
    height: o.height,
    terrain: o.terrain,
  });
  own(f.me, rect(f.game, ...o.us));
  const P: Record<string, Player> = {};
  for (const [id, box] of o.nations) {
    const n = f.game.addPlayer(new PlayerInfo(id, PlayerType.Nation, null, id));
    own(n, rect(f.game, ...box));
    P[id] = n;
  }
  for (let i = 0; i < 60; i++) f.game.executeNextTick();
  return { f, P };
}

/** A fresh model and scan at the current tick; with `grids`, the race and
 *  owner grids too (boatLine). */
function look(f: Field, grids = false) {
  const { game, me } = f;
  const models = createModels(game);
  const nm = new NationModel(game, me, GAME_ID, models);
  const tick = game.ticks();
  nm.observe(tick);
  const wm = scanWorld(game, me, null);
  const race = grids ? buildRaceGrid(game, APEX_DEFAULTS) : null;
  const owners = race !== null ? ownerGrid(game, race, 2) : null;
  return {
    nm,
    v: (o: ApexOptions) => ({
      o,
      wm,
      nm,
      game,
      me,
      tick,
      models,
      race,
      owners,
    }),
  };
}
