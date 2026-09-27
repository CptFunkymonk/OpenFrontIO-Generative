/**
 * Pins what an atom or hydrogen bomb of ours does to a nation's silo, and
 * to the nation (package WP10-PIN, docs/13-mechanics.md §2.13: MIRV denial
 * by striking silos). The code is the spec:
 *
 * - Units: the detonation deletes every unit strictly inside the bomb's
 *   outer radius, whatever its type, owner or level (NukeExecution.ts:
 *   464-483: euclideanDistSquared < outer^2; nukes and SAM missiles
 *   excepted). Outer radii: AtomBomb 30, HydrogenBomb 100 (Config.ts:
 *   1103-1113).
 * - Troops: for each of a player's tiles the blast takes, it loses
 *   nukeDeathFactor = 5 x troops / tiles left (Config.ts:1177-1185,
 *   NukeExecution.ts:416-462; floored, PlayerImpl.ts:1376-1383), so taking
 *   k of n tiles leaves about ((n - k) / n)^5 of its troops.
 * - SAMs: interception is certain once a targetable trajectory tile is in
 *   range (SAMLauncherExecution.ts:97-186, NukeThreat.test.ts): a silo
 *   under a level-L SAM needs L + 1 bombs at once, or a hydrogen bomb aimed
 *   outside the SAM's range whose 100-tile blast still covers both.
 * - The nation afterwards: considerMIRV needs a silo (NationMIRVBehavior.ts:
 *   138-140; one under construction counts) and then a ready one for the
 *   launch (canBuild in maybeSendMIRV, :297-309); a MIRV decision that
 *   fails at the launch sends nothing and records no 300-tick skip, but
 *   returns true. maybeSendNuke stops at once without a silo
 *   (NationNukeBehavior.ts:114-124).
 * - Diplomacy at launch (NukeExecution.ts:148-197, :232-234;
 *   listNukeBreakAlliance, execution/Util.ts:96-129): every player whose
 *   blast weight (1 a tile within inner, 0.5 out to outer) exceeds 100, or
 *   who has a structure within the outer radius, turns -100 toward us and,
 *   if allied, loses the alliance (we turn traitor). Nobody else moves. A
 *   Hostile nation embargoes us for good at its next decision
 *   (NationExecution.ts:360-366).
 *
 * Setting: tests/agent/mechanics/LeaderWorld.ts.
 */
import { ConstructionExecution } from "../../../src/core/execution/ConstructionExecution";
import { PlayerType, UnitType } from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import {
  ally,
  brains,
  dist,
  isDecisionTick,
  nationOf,
  pastImmunity,
  relationValue,
  samAt,
  send,
  setGold,
  settle,
  siloAt,
  startNation,
  structureAt,
  tick,
  World,
  world,
} from "./LeaderWorld";

/**
 * 400 x 200: us at x < `usWidth` with three silos at x = 30 and 100M gold;
 * the nation N holds x >= 200 (40,000 tiles); a small human Y holds 10
 * tiles at (205-209, 125-126) inside N; a human Z holds the one tile
 * (190, 100); the rest is unowned.
 */
function strikeWorld(usWidth = 60, gameID = "silo-strike"): World {
  const w = world(
    400,
    200,
    {
      US: PlayerType.Human,
      N: PlayerType.Nation,
      Y: PlayerType.Human,
      Z: PlayerType.Human,
    },
    (x, y) => {
      if (x < usWidth) return "US";
      if (x === 190 && y === 100) return "Z";
      if (x >= 205 && x < 210 && y >= 125 && y < 127) return "Y";
      if (x >= 200) return "N";
      return null;
    },
    { gameID },
  );
  for (const y of [60, 100, 140]) siloAt(w, w.p.US, 30, y);
  setGold(w.p.US, 100_000_000n);
  return w;
}

function bomb(
  w: World,
  unit: UnitType.AtomBomb | UnitType.HydrogenBomb,
  tile: TileRef,
  amount = 1,
): void {
  send(w, "US", { type: "build_unit", unit, tile, amount });
  tick(w, 3);
  expect(w.p.US.units(unit)).toHaveLength(amount);
}

describe(
  "WP10 silo strike: what the blast does (NukeExecution.detonate)",
  { timeout: 60_000 },
  () => {
    it("every unit strictly inside the outer radius is deleted, a level-5 silo included: 29 tiles from an atom bomb's aim goes, 30 stays; 99 from a hydrogen bomb's goes, 100 stays", () => {
      for (const [unit, outer] of [
        [UnitType.AtomBomb, 30],
        [UnitType.HydrogenBomb, 100],
      ] as const) {
        const w = strikeWorld();
        const N = w.p.N;
        const aim = w.game.ref(250, 100);
        const inside = structureAt(
          w,
          N,
          UnitType.MissileSilo,
          250 + outer - 1,
          100,
          5,
        );
        const edge = structureAt(
          w,
          N,
          UnitType.MissileSilo,
          250,
          100 - outer,
          5,
        );
        const city = structureAt(w, N, UnitType.City, 250 - outer + 1, 100, 3);
        const sam = structureAt(
          w,
          N,
          UnitType.SAMLauncher,
          250,
          100 + outer - 1,
          2,
        );
        expect(dist(w, aim, edge.tile())).toBe(outer);
        pastImmunity(w);
        bomb(w, unit, aim);
        settle(w);
        expect(w.game.hasFallout(aim)).toBe(true);
        expect([inside, city, sam].map((u) => u.isActive())).toEqual([
          false,
          false,
          false,
        ]);
        expect(edge.isActive()).toBe(true);
        expect(edge.level()).toBe(5);
      }
    });

    it("troops: each tile taken costs its owner 5 x troops / tiles left, so taking k of n tiles leaves about ((n - k) / n)^5 of its troops", () => {
      const w = strikeWorld();
      const c = w.config;
      for (const unit of [UnitType.AtomBomb, UnitType.HydrogenBomb] as const) {
        expect(c.nukeDeathFactor(unit, 100_000, 400, 1e9)).toBe(1_250);
        expect(c.nukeDeathFactor(unit, 100_000, 0, 1e9)).toBe(500_000);
      }
      const N = w.p.N;
      N.addTroops(1_000_000 - N.troops());
      pastImmunity(w);
      const n = N.numTilesOwned();
      bomb(w, UnitType.HydrogenBomb, w.game.ref(300, 100));
      settle(w);
      const k = n - N.numTilesOwned();
      // The loop replayed (NukeExecution.ts:427-437), floors included.
      let troops = 1_000_000;
      for (let i = 0; i < k; i++) troops -= Math.floor((5 * troops) / (n - i));
      expect(N.troops()).toBe(troops);
      expect(N.troops() / 1_000_000).toBeCloseTo(((n - k) / n) ** 5, 2);
      // A hydrogen bomb deep inside a 40,000-tile nation takes 69% of its
      // land and leaves under 0.5% of its troops.
      expect([k, n, N.troops()]).toEqual([27_548, 39_990, 4_623]);
    });
  },
);

describe("WP10 silo strike: through a SAM", { timeout: 60_000 }, () => {
  /** N's silo at (260, 100) under its level-1 SAM at (300, 100). */
  function covered() {
    const w = strikeWorld();
    const silo = siloAt(w, w.p.N, 260, 100);
    const sam = samAt(w, w.p.N, 300, 100, 1);
    pastImmunity(w);
    return { w, silo, sam };
  }

  it("one atom bomb at the silo is shot down; two at once get through (one is downed) and kill it", () => {
    let { w, silo, sam } = covered();
    bomb(w, UnitType.AtomBomb, silo.tile());
    settle(w);
    expect(silo.isActive()).toBe(true);
    expect(sam.missileTimerQueue()).toHaveLength(1);
    ({ w, silo, sam } = covered());
    bomb(w, UnitType.AtomBomb, silo.tile(), 2);
    settle(w);
    expect(silo.isActive()).toBe(false);
    // The SAM, 40 tiles off, is outside the atom's 30.
    expect(sam.isActive()).toBe(true);
  });

  it("a hydrogen bomb aimed 80 tiles north of the silo, 89 from the SAM, is never in the SAM's range and kills both", () => {
    const { w, silo, sam } = covered();
    const aim = w.game.ref(260, 20);
    expect(dist(w, aim, silo.tile())).toBe(80);
    expect(dist(w, aim, sam.tile())).toBeGreaterThan(w.config.samRange(1));
    bomb(w, UnitType.HydrogenBomb, aim);
    const [h] = w.p.US.units(UnitType.HydrogenBomb);
    const closest = Math.min(
      ...h.trajectory().map((t) => dist(w, t.tile, sam.tile())),
    );
    expect(closest).toBeGreaterThan(w.config.samRange(1));
    settle(w);
    expect(silo.isActive()).toBe(false);
    expect(sam.isActive()).toBe(false);
    expect(sam.missileTimerQueue()).toEqual([]);
  });
});

describe(
  "WP10 silo strike: the nation without its silo",
  { timeout: 60_000 },
  () => {
    it("no silo: its MIRV decision stops at the silo gate and its nuke decision at once; a silo under construction passes the gate, but the launch check fails: nothing is sent and no 300-tick skip is recorded", () => {
      // We hold 42.5% of the land (x < 170), a MIRV target by the 40% rule.
      const w = strikeWorld(170);
      const { US, N } = w.p;
      expect(US.numTilesOwned() * 100).toBeGreaterThanOrEqual(
        w.game.numLandTiles() * 40,
      );
      const silo = siloAt(w, N, 300, 100);
      setGold(N, 26_000_000n);
      pastImmunity(w);
      w.dryRun = true;
      const decide = (gameID: string) => {
        w.game.nationMirvTargets().clear();
        return brains(w, "N", gameID).mirv.considerMIRV();
      };
      const seed = [...Array(20).keys()]
        .map((i) => `silo-${i}`)
        .find((id) => decide(id));
      expect(seed).toBeDefined();
      expect(w.weapons.map((x) => [x.kind, x.from])).toEqual([["mirv", N]]);
      expect(w.game.owner(w.weapons[0].dst)).toBe(US);
      // The silo destroyed (as a blast deletes it).
      silo.delete(true, US);
      expect(decide(seed!)).toBe(false);
      const nuke = brains(w, "N", seed!).nuke;
      setGold(N, 26_000_000n);
      nuke.maybeSendNuke();
      expect(w.weapons).toHaveLength(1);
      // A new silo under construction (100 ticks): the gate passes, the
      // launch does not.
      w.game.addExecution(
        new ConstructionExecution(
          N,
          UnitType.MissileSilo,
          w.game.ref(350, 100),
        ),
      );
      tick(w, 2);
      const [fresh] = N.units(UnitType.MissileSilo);
      expect(fresh.isUnderConstruction()).toBe(true);
      setGold(N, 26_000_000n);
      w.game.nationMirvTargets().clear();
      expect(brains(w, "N", seed!).mirv.considerMIRV()).toBe(true);
      expect(w.weapons).toHaveLength(1);
      expect(w.game.nationMirvTargets().size).toBe(0);
    });
  },
);

describe(
  "WP10 silo strike: diplomacy (listNukeBreakAlliance)",
  { timeout: 60_000 },
  () => {
    it("a bomb at an ally's silo breaks the alliance at launch (we turn traitor) and turns it and any third party with a structure in the blast -100; a bystander with a few tiles in the ring and no structure is untouched", () => {
      const w = strikeWorld();
      const { US, N, Y, Z } = w.p;
      // Z's defense post on its one tile, 15 from the aim.
      structureAt(w, Z, UnitType.DefensePost, 190, 100);
      const silo = siloAt(w, N, 205, 100);
      ally(US, N);
      pastImmunity(w);
      const before = [N, Y, Z].map((p) => relationValue(p, US));
      bomb(w, UnitType.AtomBomb, silo.tile());
      expect(US.isAlliedWith(N)).toBe(false);
      expect(US.isTraitor()).toBe(true);
      const delta = [N, Y, Z].map((p, i) => relationValue(p, US) - before[i]);
      expect(delta).toEqual([-100, 0, -100]);
      settle(w);
      expect(silo.isActive()).toBe(false);
      // Whatever the patchy ring took of Y, its relation did not move.
      expect(relationValue(Y, US)).toBe(before[1]);
    });

    it("the nation we bombed embargoes us for good at its next decision (Impossible)", () => {
      const w = strikeWorld(60, "silo-embargo");
      const { US, N } = w.p;
      const silo = siloAt(w, N, 250, 100);
      const nation = nationOf(w, "N", "silo-embargo");
      pastImmunity(w);
      startNation(w, nation);
      const t = w.game.ticks();
      bomb(w, UnitType.AtomBomb, silo.tile());
      expect(relationValue(N, US)).toBe(-100);
      let at = -1;
      for (let i = 0; i < 60 && at < 0; i++) {
        tick(w);
        if (N.hasEmbargoAgainst(US)) at = w.game.ticks() - 1;
      }
      expect(at).toBeGreaterThan(t + 2);
      expect(isDecisionTick(nation, at)).toBe(true);
      const e = N.getEmbargoes().find((x) => x.target === US)!;
      expect(e.isTemporary).toBe(false);
    });
  },
);
