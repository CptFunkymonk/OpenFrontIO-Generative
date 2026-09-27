/**
 * Pins what our own launches need and do (package WP10-PIN, the leader
 * phase: docs/13-mechanics.md §2.13). The code is the spec:
 *
 * - The path (ExecutionManager.ts:111-118): build_unit makes a
 *   ConstructionExecution. Its init (ConstructionExecution.ts:37-53) checks
 *   only that the unit is enabled and the tile valid; its first tick
 *   (:55-65, :109-136) adds one NukeExecution per bomb (`amount`, 1 by
 *   default) or one MirvExecution, and charges nothing. That execution's
 *   first tick (NukeExecution.ts:199-230, MIRVExecution.ts:94-107) calls
 *   canBuild and, if it passes, buildUnit, which charges the price
 *   (PlayerImpl.ts:1392-1415). So the bomb exists, paid, in the second tick
 *   after the tick its build_unit was added; a failed check drops it with a
 *   console warning, nothing charged, nothing retried.
 * - canBuild (PlayerImpl.ts:1573-1583, :1449-1464, :1585-1600): the unit
 *   enabled, gold >= the price, the player alive; a MIRV needs an OWNED
 *   target tile (:1591-1595); then nukeSpawn (:1625-1675): no spawn
 *   immunity, a target tile that is not impassable (water and unowned land
 *   are fine), not a teammate's (none in FFA), and a ready silo: active, not
 *   under construction, not in cooldown. The nearest ready silo by
 *   Manhattan distance to the target fires (:1666-1674).
 * - Slots: a silo of level L has L slots (isInCooldown: queue length ==
 *   level, UnitImpl.ts:558-573); each launch fills one (silo.launch,
 *   NukeExecution.ts:264-267, MIRVExecution.ts:156-162), and
 *   MissileSiloExecution frees the oldest once SiloCooldown() = 90 ticks
 *   have passed (MissileSiloExecution.ts:24-46, Config.ts:373-375). An
 *   upgrade (upgrade_structure, UpgradeStructureExecution.ts:17-39, 1M,
 *   Config.ts:641-647) adds a level whose slot starts in use
 *   (UnitImpl.ts:738-757).
 * - Price (Config.ts:608-630): AtomBomb 750k and HydrogenBomb 5M flat (the
 *   cost function ignores the count costWrapper passes, :755-773); MIRV
 *   25M + 15M x game.mirvsLaunched(), a game-wide counter bumped when ANY
 *   player's MIRV spawns (MIRVExecution.ts:103-107, GameImpl.ts:1397-1402),
 *   after buildUnit charged the old price.
 * - Flight (NukeExecution.ts:55-64, :282-309; PathFinder.Parabola.ts:15-54,
 *   :88-103; utilities/Line.ts:64-82): 10 tiles a tick (Config.ts:1119-1130)
 *   along a Bezier arc of height max(d/3, 50) tiles (clamped to the map's
 *   top edge), one precomputed point per tick; the bomb detonates on the
 *   tick it runs out of points, trajectory().length - 1 ticks after it
 *   spawned. A MIRV's carrier flies at a speed normalised toward 14 ticks
 *   (MIRVExecution.ts:320-393, Config.ts:1132-1134) to a separation point
 *   above the target (:122-124); its warheads (speed 22-26, a wait of
 *   0-14 ticks after separation, :226-249) land afterwards.
 * - SAMs (SAMLauncherExecution.ts:197-215): any nuke whose owner is not
 *   friendly with the SAM's owner is a target, so an ally's SAM never fires
 *   at our bombs; a bomb aimed at an ally breaks the alliance at launch
 *   (NukeExecution.ts:148-197, :232-234) when the blast weighs > 100 of its
 *   tiles or reaches one of its structures, after which its SAMs shoot.
 *   Interception is certain when a targetable trajectory tile is in range
 *   (:97-186; NukeThreat.test.ts pins range, capacity and the 150-tile
 *   targetable ends).
 *
 * Setting: tests/agent/mechanics/LeaderWorld.ts (the real Config, FFA,
 * Singleplayer, Impossible; all-plains maps unless a test says otherwise;
 * no PlayerExecution, so no income: gold stays where the test puts it).
 */
import { MirvExecution } from "../../../src/core/execution/MIRVExecution";
import { PlayerType, UnitType } from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import { UniversalPathFinding } from "../../../src/core/pathfinding/PathFinder";
import {
  ally,
  brains,
  dist,
  IMPASSABLE,
  pastImmunity,
  PLAINS,
  price,
  samAt,
  send,
  setGold,
  settle,
  siloAt,
  tick,
  WATER,
  World,
  world,
} from "./LeaderWorld";

type Bomb = UnitType.AtomBomb | UnitType.HydrogenBomb | UnitType.MIRV;
const BOMBS: Bomb[] = [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV];

/**
 * 240 x 120: us at x < 80 with a finished silo at (20, 60) and 100M gold,
 * the nation N at x >= 160, a tribe T on (100-109, 50-59), a lake on
 * (120-125, 20-25) and an impassable patch on (130-132, 90-92); the rest is
 * unowned land.
 */
function ownWorld(opts: { silo?: boolean } = {}): World {
  const w = world(
    240,
    120,
    { US: PlayerType.Human, N: PlayerType.Nation, T: PlayerType.Bot },
    (x, y) => {
      if (x < 80) return "US";
      if (x >= 160) return "N";
      if (x >= 100 && x < 110 && y >= 50 && y < 60) return "T";
      return null;
    },
    {
      terrain: (x, y) => {
        if (x >= 120 && x < 126 && y >= 20 && y < 26) return WATER;
        if (x >= 130 && x < 133 && y >= 90 && y < 93) return IMPASSABLE;
        return PLAINS;
      },
    },
  );
  if (opts.silo ?? true) siloAt(w, w.p.US, 20, 60);
  setGold(w.p.US, 100_000_000n);
  return w;
}

/** Sends a build_unit and runs the three ticks after which it has spawned. */
function launch(w: World, unit: Bomb, tile: TileRef, amount?: number) {
  const before = w.p.US.units(unit).length;
  const gold = w.p.US.gold();
  send(w, "US", {
    type: "build_unit",
    unit,
    tile,
    ...(amount === undefined ? {} : { amount }),
  });
  tick(w, 3);
  return {
    spawned: w.p.US.units(unit).length - before,
    paid: gold - w.p.US.gold(),
  };
}

describe(
  "WP10 own launches: what build_unit needs (PlayerImpl.canBuild, nukeSpawn)",
  { timeout: 60_000 },
  () => {
    it.each(BOMBS)(
      "%s: spawns, and is paid, in the second tick after the tick its build_unit is added, from the silo's slot",
      (unit) => {
        const w = ownWorld();
        pastImmunity(w);
        const [silo] = w.p.US.units(UnitType.MissileSilo);
        const target = w.game.ref(200, 60); // N's land
        const gold = w.p.US.gold();
        const cost = price(w, unit, w.p.US);
        const t = w.game.ticks();
        send(w, "US", { type: "build_unit", unit, tile: target });
        tick(w, 2); // ticks t and t + 1: nothing yet, nothing paid
        expect(w.p.US.units(unit)).toHaveLength(0);
        expect(w.p.US.gold()).toBe(gold);
        tick(w); // tick t + 2
        expect(w.p.US.units(unit)).toHaveLength(1);
        expect(w.p.US.gold()).toBe(gold - cost);
        expect(silo.missileTimerQueue()).toEqual([t + 2]);
        expect(silo.isInCooldown()).toBe(true);
      },
    );

    type Fail = (w: World) => { unit: Bomb; tile: TileRef };
    const failures: [string, Fail][] = [
      [
        "no silo",
        (w) => {
          w.p.US.units(UnitType.MissileSilo)[0].delete(false);
          return { unit: UnitType.AtomBomb, tile: w.game.ref(200, 60) };
        },
      ],
      [
        "gold one short of the price",
        (w) => {
          setGold(w.p.US, price(w, UnitType.HydrogenBomb, w.p.US) - 1n);
          return { unit: UnitType.HydrogenBomb, tile: w.game.ref(200, 60) };
        },
      ],
      [
        "the silo's only slot in use",
        (w) => {
          w.p.US.units(UnitType.MissileSilo)[0].launch();
          return { unit: UnitType.AtomBomb, tile: w.game.ref(200, 60) };
        },
      ],
      [
        "an impassable target tile",
        (w) => ({ unit: UnitType.AtomBomb, tile: w.game.ref(131, 91) }),
      ],
      [
        "a MIRV at an unowned tile",
        (w) => ({ unit: UnitType.MIRV, tile: w.game.ref(140, 60) }),
      ],
      [
        "a MIRV at a water tile",
        (w) => ({ unit: UnitType.MIRV, tile: w.game.ref(122, 22) }),
      ],
    ];

    it.each(failures)(
      "dropped silently, nothing paid, never retried: %s",
      (_name, fail) => {
        const w = ownWorld();
        pastImmunity(w);
        const { unit, tile } = fail(w);
        const gold = w.p.US.gold();
        const r = launch(w, unit, tile);
        tick(w, 20);
        expect(r.spawned).toBe(0);
        expect(w.p.US.units(unit)).toHaveLength(0);
        expect(w.p.US.gold()).toBe(gold);
      },
    );

    it("dropped during spawn immunity (the 50 ticks after the spawn phase), for every player", () => {
      const w = ownWorld();
      expect(w.game.isSpawnImmunityActive()).toBe(true);
      const r = launch(w, UnitType.AtomBomb, w.game.ref(200, 60));
      expect(r).toEqual({ spawned: 0, paid: 0n });
      expect(w.config.spawnImmunityDuration()).toBe(50);
      pastImmunity(w);
      expect(launch(w, UnitType.AtomBomb, w.game.ref(200, 60)).spawned).toBe(1);
    });

    it("a silo under construction has no slot: 100 ticks after its build_unit it is finished and fires", () => {
      const w = ownWorld({ silo: false });
      pastImmunity(w);
      const t = w.game.ticks();
      send(w, "US", {
        type: "build_unit",
        unit: UnitType.MissileSilo,
        tile: w.game.ref(20, 60),
      });
      tick(w, 2);
      const [silo] = w.p.US.units(UnitType.MissileSilo);
      expect(silo.isUnderConstruction()).toBe(true);
      expect(launch(w, UnitType.AtomBomb, w.game.ref(200, 60)).spawned).toBe(0);
      expect(w.config.unitInfo(UnitType.MissileSilo).constructionDuration).toBe(
        100,
      );
      // Finished at the intent tick + duration + 2 (EconomyGold pins the
      // timing of every build).
      while (silo.isUnderConstruction()) tick(w);
      expect(w.game.ticks() - 1).toBe(t + 102);
      expect(launch(w, UnitType.AtomBomb, w.game.ref(200, 60)).spawned).toBe(1);
    });

    it("targets: an atom or hydrogen bomb may be aimed at any passable tile (a nation's, a tribe's, our own, unowned land, water); a MIRV at any OWNED tile, a tribe's and our own included", () => {
      const tiles: [string, (w: World) => TileRef][] = [
        ["nation", (w) => w.game.ref(200, 60)],
        ["tribe", (w) => w.game.ref(105, 55)],
        ["own", (w) => w.game.ref(60, 100)],
        ["unowned", (w) => w.game.ref(140, 60)],
        ["water", (w) => w.game.ref(122, 22)],
      ];
      const fired = (unit: Bomb) =>
        tiles
          .filter(([, at]) => {
            const w = ownWorld();
            pastImmunity(w);
            return launch(w, unit, at(w)).spawned === 1;
          })
          .map(([name]) => name);
      const all = tiles.map(([name]) => name);
      expect(fired(UnitType.AtomBomb)).toEqual(all);
      expect(fired(UnitType.HydrogenBomb)).toEqual(all);
      expect(fired(UnitType.MIRV)).toEqual(["nation", "tribe", "own"]);
    });

    it("slots: the nearest ready silo (Manhattan) fires; a level-L silo has L slots; `amount` sends that many bombs, each needing a slot and the gold; a slot is free again 90 ticks after its launch", () => {
      const w = ownWorld();
      const [far] = w.p.US.units(UnitType.MissileSilo); // (20, 60)
      const near = siloAt(w, w.p.US, 70, 60, 2);
      pastImmunity(w);
      const target = w.game.ref(200, 60);
      // amount 3: the level-2 silo 50 tiles nearer fires twice, then the far
      // one; 3 x 750k paid.
      const t = w.game.ticks();
      const r = launch(w, UnitType.AtomBomb, target, 3);
      expect(r).toEqual({ spawned: 3, paid: 3n * 750_000n });
      expect(near.missileTimerQueue()).toEqual([t + 2, t + 2]);
      expect(far.missileTimerQueue()).toEqual([t + 2]);
      // All slots in use: a 4th is dropped.
      expect(launch(w, UnitType.AtomBomb, target).spawned).toBe(0);
      // Gold for one bomb only: amount 2 sends one.
      setGold(w.p.US, 750_000n);
      expect(w.p.US.units(UnitType.MissileSilo).map((s) => s.level())).toEqual([
        1, 2,
      ]);
      // A slot frees when 90 ticks have passed since its launch (tick t + 2),
      // one per silo per tick: a bomb spawning in tick t + 91 is dropped, one
      // spawning in tick t + 92 fires (from the nearer silo).
      while (w.game.ticks() < t + 89) tick(w);
      const send2 = () =>
        send(w, "US", {
          type: "build_unit",
          unit: UnitType.AtomBomb,
          tile: target,
          amount: 2,
        });
      send2(); // spawns in tick t + 91
      tick(w);
      send2(); // spawns in tick t + 92
      tick(w, 3);
      // (The first three detonated long ago.)
      expect(w.p.US.units(UnitType.AtomBomb)).toHaveLength(1);
      expect(near.missileTimerQueue()).toEqual([t + 2, t + 92]);
      expect(far.missileTimerQueue()).toEqual([]);
      expect(w.p.US.gold()).toBe(0n);
    });

    it("an upgrade adds a slot for 1M, usable 90 ticks after the upgrade", () => {
      const w = ownWorld();
      const [silo] = w.p.US.units(UnitType.MissileSilo);
      pastImmunity(w);
      expect(price(w, UnitType.MissileSilo, w.p.US)).toBe(1_000_000n);
      const gold = w.p.US.gold();
      const t = w.game.ticks();
      send(w, "US", {
        type: "upgrade_structure",
        unit: UnitType.MissileSilo,
        unitId: silo.id(),
      });
      tick(w); // UpgradeStructureExecution upgrades at init, in tick t
      expect(silo.level()).toBe(2);
      expect(w.p.US.gold()).toBe(gold - 1_000_000n);
      expect(silo.missileTimerQueue()).toEqual([t]);
      // One free slot now: amount 2 sends one.
      expect(launch(w, UnitType.AtomBomb, w.game.ref(200, 60), 2).spawned).toBe(
        1,
      );
      expect(price(w, UnitType.MissileSilo, w.p.US)).toBe(1_000_000n);
    });
  },
);

describe(
  "WP10 own launches: the price (Config.ts:608-630)",
  { timeout: 60_000 },
  () => {
    it("an atom bomb costs 750k and a hydrogen bomb 5M however many we have bought", () => {
      const w = ownWorld();
      for (let i = 0; i < 3; i++) siloAt(w, w.p.US, 20, 10 + 20 * i, 3);
      pastImmunity(w);
      const target = w.game.ref(200, 60);
      for (const [unit, cost] of [
        [UnitType.AtomBomb, 750_000n],
        [UnitType.HydrogenBomb, 5_000_000n],
      ] as const) {
        for (let i = 0; i < 4; i++) {
          expect(price(w, unit, w.p.US)).toBe(cost);
          expect(launch(w, unit, target)).toEqual({ spawned: 1, paid: cost });
        }
        expect(w.p.US.unitsConstructed(unit)).toBe(4);
        expect(price(w, unit, w.p.US)).toBe(cost);
      }
    });

    it("a MIRV costs 25M + 15M per MIRV anyone has launched; the counter moves when a MIRV spawns, after it paid the old price, for every player", () => {
      const w = ownWorld();
      siloAt(w, w.p.N, 220, 60);
      setGold(w.p.N, 100_000_000n);
      pastImmunity(w);
      const cost = () => [w.p.US, w.p.N].map((p) => price(w, UnitType.MIRV, p));
      expect(cost()).toEqual([25_000_000n, 25_000_000n]);
      expect(launch(w, UnitType.MIRV, w.game.ref(200, 60))).toEqual({
        spawned: 1,
        paid: 25_000_000n,
      });
      expect(w.game.mirvsLaunched()).toBe(1);
      expect(cost()).toEqual([40_000_000n, 40_000_000n]);
      // The nation's MIRV at us moves it for us too.
      w.game.addExecution(new MirvExecution(w.p.N, w.game.ref(40, 60)));
      tick(w, 2);
      expect(w.p.N.units(UnitType.MIRV)).toHaveLength(1);
      expect(w.p.N.gold()).toBe(100_000_000n - 40_000_000n);
      expect(cost()).toEqual([55_000_000n, 55_000_000n]);
    });

    it("MIRV denial by price: our MIRV at a tribe raises the nation's price by 15M, and a nation that could pay for its MIRV at us no longer can", () => {
      // We hold 80 of 240 columns = 33%: give us more so the nation's 40%
      // rule (NationMIRVBehavior.ts:181-225) names us.
      const w = ownWorld();
      for (let x = 80; x < 100; x++)
        for (let y = 0; y < 120; y++) w.p.US.conquer(w.game.ref(x, y));
      expect(w.p.US.numTilesOwned() * 100).toBeGreaterThanOrEqual(
        w.game.numLandTiles() * 40,
      );
      siloAt(w, w.p.N, 220, 60);
      setGold(w.p.N, 30_000_000n);
      pastImmunity(w);
      w.dryRun = true; // the nation's MIRVs are recorded, not run
      const decide = (gameID: string) => {
        w.game.nationMirvTargets().clear();
        return brains(w, "N", gameID).mirv.considerMIRV();
      };
      // A seed whose first MIRV decision does not hesitate (1 in 16).
      const seed = [...Array(20).keys()]
        .map((i) => `denial-${i}`)
        .find((id) => decide(id));
      expect(seed).toBeDefined();
      const planned = w.weapons[w.weapons.length - 1];
      expect(planned.kind).toBe("mirv");
      expect(planned.from).toBe(w.p.N);
      expect(w.game.owner(planned.dst)).toBe(w.p.US);
      // Our MIRV at the tribe spawns (for real) and moves the price to 40M.
      w.dryRun = false;
      expect(launch(w, UnitType.MIRV, w.game.ref(105, 55)).spawned).toBe(1);
      w.dryRun = true;
      expect(price(w, UnitType.MIRV, w.p.N)).toBe(40_000_000n);
      const n = w.weapons.length;
      expect(decide(seed!)).toBe(false); // the gold gate (NMB :141-143)
      expect(w.weapons.length).toBe(n);
    });
  },
);

describe("WP10 own launches: flight time", { timeout: 60_000 }, () => {
  it("an atom or hydrogen bomb detonates trajectory().length - 1 ticks after it spawns: 8, 10, 14, 18, 24, 35, 47, 70, 93, 116, 139 ticks at 20 ... 1,200 tiles; the trajectory is the Parabola path an agent can compute beforehand", () => {
    const D = [20, 50, 100, 150, 200, 300, 400, 600, 800, 1000, 1200];
    const FLIGHT = [8, 10, 14, 18, 24, 35, 47, 70, 93, 116, 139];
    for (const unit of [UnitType.AtomBomb, UnitType.HydrogenBomb] as const) {
      // One silo per distance, 20 rows apart, each nearest to its target.
      const w = world(
        1300,
        900,
        { US: PlayerType.Human, Z: PlayerType.Human },
        (x, y) => (x < 60 ? "US" : x >= 1290 && y < 10 ? "Z" : null),
      );
      setGold(w.p.US, 1_000_000_000n);
      const rows = D.map((_, i) => 880 - 20 * i);
      const silos = rows.map((y) => siloAt(w, w.p.US, 30, y));
      pastImmunity(w);
      const dsts = D.map((d, i) => w.game.ref(30 + d, rows[i]));
      // The path an agent can compute before launching.
      const planned = dsts.map(
        (dst, i) =>
          UniversalPathFinding.Parabola(w.game, {
            increment: w.config.nukeSpeed(unit),
          }).findPath(silos[i].tile(), dst)!.length,
      );
      const t = w.game.ticks();
      for (const dst of dsts)
        send(w, "US", { type: "build_unit", unit, tile: dst });
      tick(w, 3);
      const bombs = w.p.US.units(unit);
      expect(bombs).toHaveLength(D.length);
      const mine = dsts.map(
        (dst) => bombs.find((b) => b.targetTile() === dst)!,
      );
      const trajectory = mine.map((b) => b.trajectory().length);
      expect(trajectory).toEqual(planned);
      // (Fallout at the aim tile would not do: a hydrogen bomb's 100-tile
      // blast reaches the neighbouring rows' aim tiles.)
      const detonated: number[] = D.map(() => -1);
      for (let i = 0; i < 200; i++) {
        tick(w);
        mine.forEach((b, k) => {
          if (detonated[k] < 0 && !b.isActive()) {
            detonated[k] = w.game.ticks() - 1;
            expect(b.reachedTarget()).toBe(true);
          }
        });
      }
      const flight = detonated.map((d) => d - (t + 2));
      expect(flight).toEqual(FLIGHT);
      expect(flight).toEqual(trajectory.map((n) => n - 1));
      expect(w.config.nukeSpeed(unit)).toBe(10);
    }
  });

  it("a MIRV: the carrier separates 22 ticks after it spawns here (300 tiles out), its 16 warheads land 46-67 ticks after the build_unit; the target's counter-MIRV window is the carrier's flight", () => {
    // Us x < 60 (silo at (30, 650)), the target V a 200 x 200 block at
    // x 260-459, y 500-699, aimed at its centre (360, 600).
    const w = world(
      520,
      720,
      { US: PlayerType.Human, V: PlayerType.Nation, Z: PlayerType.Human },
      (x, y) => {
        if (x < 60) return "US";
        if (x >= 260 && x < 460 && y >= 500 && y < 700) return "V";
        if (x >= 510 && y < 10) return "Z";
        return null;
      },
    );
    siloAt(w, w.p.US, 30, 650);
    setGold(w.p.US, 100_000_000n);
    pastImmunity(w);
    const t = w.game.ticks();
    send(w, "US", {
      type: "build_unit",
      unit: UnitType.MIRV,
      tile: w.game.ref(360, 600),
    });
    let spawn = -1;
    let separated = -1;
    const landed: number[] = [];
    let heads = 0;
    for (let i = 0; i < 200; i++) {
      tick(w);
      const now = w.game.ticks() - 1;
      const carrier = w.p.US.units(UnitType.MIRV).length;
      if (carrier > 0 && spawn < 0) spawn = now;
      if (spawn >= 0 && carrier === 0 && separated < 0) separated = now;
      const alive = w.p.US.units(UnitType.MIRVWarhead).length;
      for (let k = alive; k < heads; k++) landed.push(now);
      heads = alive;
      if (separated >= 0 && alive === 0) break;
    }
    expect(spawn - t).toBe(2);
    expect(separated - spawn).toBe(22);
    // 16 warheads on this 200 x 200 target, landing over 22 ticks.
    expect(landed).toHaveLength(16);
    expect(Math.min(...landed) - t).toBe(46);
    expect(Math.max(...landed) - t).toBe(67);
  });
});

describe("WP10 own launches: the target's SAM", { timeout: 60_000 }, () => {
  /**
   * 400 x 200: us x < 60 (silos at (30, 100) and (30, 140)); the nation N
   * holds x >= 200, y < 135 with a SAM at (300, 100); the human Z holds
   * x >= 200, y >= 135, so Z's land comes within 35 tiles of N's SAM.
   */
  function samWorld(level = 1) {
    const w = world(
      400,
      200,
      { US: PlayerType.Human, N: PlayerType.Nation, Z: PlayerType.Human },
      (x, y) => (x < 60 ? "US" : x < 200 ? null : y < 135 ? "N" : "Z"),
    );
    siloAt(w, w.p.US, 30, 100);
    siloAt(w, w.p.US, 30, 140);
    setGold(w.p.US, 100_000_000n);
    const sam = samAt(w, w.p.N, 300, 100, level);
    pastImmunity(w);
    return { w, sam };
  }

  it("a hostile SAM downs every atom and hydrogen bomb of ours aimed within its range, one interceptor each, L per 90 ticks", () => {
    for (const unit of [UnitType.AtomBomb, UnitType.HydrogenBomb] as const) {
      const { w, sam } = samWorld(1);
      const dst = w.game.ref(250, 100); // 50 < 70 from the SAM
      launch(w, unit, dst);
      settle(w);
      expect(w.game.hasFallout(dst)).toBe(false);
      expect(sam.isActive()).toBe(true);
      expect(sam.missileTimerQueue()).toHaveLength(1);
    }
    // Two at once beat a level-1 SAM: one is downed, the other lands 10
    // tiles from the SAM and kills it.
    const { w, sam } = samWorld(1);
    const dst = w.game.ref(290, 100);
    launch(w, UnitType.AtomBomb, dst, 2);
    settle(w);
    expect(w.game.hasFallout(dst)).toBe(true);
    expect(sam.isActive()).toBe(false);
  });

  it("an allied player's SAM never fires at our bombs: the same atom bomb on Z's land 65 tiles from N's SAM is downed while N is not our ally and lands while it is", () => {
    const run = (allied: boolean) => {
      const { w, sam } = samWorld(1);
      if (allied) ally(w.p.US, w.p.N);
      // Its 30-tile blast holds only Z's land and reaches no structure of
      // N's, so the launch does not break the alliance (NationAlliance pins
      // the rule).
      const dst = w.game.ref(300, 165);
      expect(dist(w, dst, sam.tile())).toBe(65);
      launch(w, UnitType.AtomBomb, dst);
      settle(w);
      return {
        allied: w.p.US.isAlliedWith(w.p.N),
        landed: w.game.hasFallout(dst),
        shots: sam.missileTimerQueue().length,
      };
    };
    expect(run(false)).toEqual({ allied: false, landed: false, shots: 1 });
    expect(run(true)).toEqual({ allied: true, landed: true, shots: 0 });
  });

  it("a bomb aimed at an ally's structure breaks the alliance at launch, so the ally's SAM shoots it down", () => {
    const { w, sam } = samWorld(1);
    ally(w.p.US, w.p.N);
    const silo = siloAt(w, w.p.N, 260, 100);
    launch(w, UnitType.AtomBomb, silo.tile());
    // Broken in the spawn tick (the silo is within the 30-tile radius).
    expect(w.p.US.isAlliedWith(w.p.N)).toBe(false);
    expect(w.p.US.isTraitor()).toBe(true);
    settle(w);
    expect(w.game.hasFallout(silo.tile())).toBe(false);
    expect(silo.isActive()).toBe(true);
    expect(sam.missileTimerQueue()).toHaveLength(1);
  });

  it("a hydrogen bomb aimed beyond a level-1 SAM's 70 tiles, its whole trajectory out of range, is not intercepted and destroys the SAM inside its 100-tile blast (an atom bomb's blast is 30)", () => {
    const { w, sam } = samWorld(1);
    // 80 tiles north of the SAM; the arc comes in from the north-west.
    const dst = w.game.ref(300, 20);
    expect(dist(w, dst, sam.tile())).toBe(80);
    launch(w, UnitType.HydrogenBomb, dst);
    const [bomb] = w.p.US.units(UnitType.HydrogenBomb);
    const closest = Math.min(
      ...bomb.trajectory().map((t) => dist(w, t.tile, sam.tile())),
    );
    expect(closest).toBeGreaterThan(w.config.samRange(1));
    settle(w);
    expect(w.game.hasFallout(dst)).toBe(true);
    expect(sam.isActive()).toBe(false);
    expect(sam.missileTimerQueue()).toEqual([]);
    expect(w.config.nukeMagnitudes(UnitType.HydrogenBomb).outer).toBe(100);
    expect(w.config.nukeMagnitudes(UnitType.AtomBomb).outer).toBe(30);
    expect(w.config.samRange(1)).toBe(70);
  });

  it("our MIRV: the carrier is never a target; a level-L SAM downs L warheads, in the order they come into reach: aimed at the SAM itself, the MIRV killed a level-1 SAM here, and levels 2 and 3 downed the warhead aimed at them and survived", () => {
    const run = (level: number) => {
      const { w, sam } = samWorld(level);
      const aim = w.game.ref(300, 100);
      launch(w, UnitType.MIRV, aim);
      expect(w.p.US.units(UnitType.MIRV)).toHaveLength(1);
      settle(w);
      const heads = w.weapons.filter((x) => x.type === UnitType.MIRVWarhead);
      expect(heads.map((x) => x.dst)).toContain(aim);
      return {
        downed: heads.filter((x) => !w.game.hasFallout(x.dst)).length,
        alive: sam.isActive(),
      };
    };
    expect([1, 2, 3].map(run)).toEqual([
      { downed: 1, alive: false },
      { downed: 2, alive: true },
      { downed: 3, alive: true },
    ]);
  });
});
