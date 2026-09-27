/**
 * Pins exactly when an Impossible nation MIRVs us (package WP10-PIN,
 * docs/13-mechanics.md §2.13; NukeThreat.test.ts pins the ladder's edges in
 * isolation, this file pins it against us, live). The code is the spec
 * (NationMIRVBehavior.ts, NMB):
 *
 * - When: once per decision tick, before its structures and attacks
 *   (NationExecution.ts:200-228: considerMIRV at :222).
 * - Gates (considerMIRV :133-168): MIRVs enabled; at least one silo of any
 *   state (:138, units() includes silos under construction); gold >= the
 *   REAL price, 25M + 15M x MIRVs launched (:141, Config.ts:618-630); then
 *   random.chance(16) hesitates (:145, :66-80).
 * - Targets, first match, each skipped if a nation MIRVed it in the last
 *   300 ticks (:149-165, :257-265): whoever has a MIRV in flight at it
 *   (:171-179); the largest holder of tiles x 100 >= numLandTiles() x 40
 *   (:181-225; fallout stays in the denominator); the holder of the most
 *   city levels if > 8 and >= 1.15 x the runner-up's (:227-254). Players
 *   are the living ones, tribes included in the city ranking (:233-237);
 *   valid targets exclude only itself, tribes and teammates (:268-279), so
 *   allies are targets.
 * - City levels are unitCount(City) (:311-313): the sum of the levels of
 *   every City the player holds, cities under construction included (1
 *   each, PlayerImpl.ts:528-545), unlike the troop cap, which counts
 *   finished cities only (Config.ts:1024-1056).
 * - The launch (maybeSendMIRV :297-309): the MIRV needs canBuild (a ready
 *   silo and the gold) at the aim, calculateTerritoryCenter(target)
 *   (execution/Util.ts:306-354); MirvExecution spawns it in the next tick
 *   (MIRVExecution.ts:94-107), charging the price, and in that same tick
 *   breaks our alliance (the nation turns traitor) and sets -100 both ways
 *   (:110-121). There is no earlier break: the alliance holds until the
 *   MIRV exists.
 *
 * Setting: tests/agent/mechanics/LeaderWorld.ts; the live tests run the
 * real NationExecution (no PlayerExecution: no income, no decay).
 */
import { calculateTerritoryCenter } from "../../../src/core/execution/Util";
import { PlayerType, UnitType } from "../../../src/core/game/Game";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import {
  ally,
  brains,
  isDecisionTick,
  nationOf,
  pastImmunity,
  price,
  relationValue,
  send,
  setGold,
  siloAt,
  startNation,
  structureAt,
  tick,
  World,
  world,
} from "./LeaderWorld";

/**
 * 300 x 200 (60,000 land tiles): us at x < `usWidth`; the nation N at
 * x >= 230 with a finished silo at (260, 100); an inert nation Z at
 * x 140-179; a tribe T at x 190-199; the rest unowned.
 */
function targetWorld(usWidth: number, gameID = "mirv-targeting"): World {
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

/**
 * A seed under which `key`'s next MIRV decision does not hesitate: the
 * hesitation is the first draw considerMIRV makes once the silo and gold
 * gates pass (NMB :145), so a copy of the fresh brain's PRNG predicts it
 * (as NukeThreat.test.ts does).
 */
function willing(w: World, key: string, prefix: string): string {
  for (let i = 0; i < 40; i++) {
    const id = `${prefix}-${i}`;
    const b = brains(w, key, id).mirv as unknown as { random: PseudoRandom };
    if (!PseudoRandom.fromState(b.random.getState()).chance(16)) return id;
  }
  throw new Error("always hesitates");
}

describe(
  "WP10 nation MIRV targeting: live, against us",
  { timeout: 60_000 },
  () => {
    it("an ALLY with a silo and the price MIRVs us at a decision tick once we hold 40% of the land; the MIRV spawns in the next tick, aimed at our territory's centre, and only then does the alliance break (it turns traitor), -100 both ways, the price paid", () => {
      // 130 of 300 columns: 26,000 of 60,000 tiles = 43.3%.
      const w = targetWorld(130, "ally-mirv");
      const { US, N } = w.p;
      expect(US.numTilesOwned() * 100).toBeGreaterThanOrEqual(
        w.game.numLandTiles() * 40,
      );
      ally(US, N);
      const nation = nationOf(w, "N", "ally-mirv");
      pastImmunity(w);
      startNation(w, nation);
      const cost = price(w, UnitType.MIRV, N);
      expect(cost).toBe(25_000_000n);
      let decided = -1;
      for (let i = 0; i < 400 && N.units(UnitType.MIRV).length === 0; i++) {
        const t = w.game.ticks();
        if (isDecisionTick(nation, t)) {
          // The price, set on the eve of each decision (no income here).
          setGold(N, cost);
          decided = t;
        }
        tick(w);
        if (N.units(UnitType.MIRV).length === 0) {
          // Until the MIRV exists, the alliance holds.
          expect(US.isAlliedWith(N)).toBe(true);
        }
      }
      const [mirv] = N.units(UnitType.MIRV);
      expect(mirv).toBeDefined();
      const spawned = w.game.ticks() - 1;
      expect(spawned).toBe(decided + 1);
      expect(mirv.targetTile()).toBe(calculateTerritoryCenter(w.game, US));
      expect(w.game.owner(mirv.targetTile()!)).toBe(US);
      expect(US.isAlliedWith(N)).toBe(false);
      expect(N.isTraitor()).toBe(true);
      expect(US.isTraitor()).toBe(false);
      expect([relationValue(US, N), relationValue(N, US)]).toEqual([
        -100, -100,
      ]);
      expect(N.gold()).toBe(0n);
      expect(w.game.mirvsLaunched()).toBe(1);
      expect(w.game.nationMirvTargets().get(US.id())).toBe(decided);
    });

    it("the 40% gate is our tiles x 100 >= numLandTiles() x 40: 24,000 of 60,000 is a target, 23,999 is not, and 1,000 fallout tiles do not change that (they stay in the land count)", () => {
      const at = (tiles: number, fallout: number) => {
        const w = targetWorld(120);
        const { US } = w.p;
        if (tiles < US.numTilesOwned()) US.relinquish(w.game.ref(0, 0));
        for (let i = 0; i < fallout; i++)
          w.game.setFallout(
            w.game.ref(200 + (i % 30), Math.floor(i / 30)),
            true,
          );
        expect(US.numTilesOwned()).toBe(tiles);
        expect(w.game.numTilesWithFallout()).toBe(fallout);
        expect(w.game.numLandTiles()).toBe(60_000);
        return brains(w, "N", "edge").mirv.selectVictoryDenialTarget() === US;
      };
      expect(at(24_000, 0)).toBe(true);
      expect(at(23_999, 0)).toBe(false);
      expect(at(23_999, 1_000)).toBe(false);
    });
  },
);

describe(
  "WP10 nation MIRV targeting: the city leader (NMB :227-254)",
  { timeout: 60_000 },
  () => {
    /** Us at 25% of the land (not a 40% target), 20M gold for cities. */
    function cityWorld() {
      const w = targetWorld(75);
      setGold(w.p.US, 20_000_000n);
      setGold(w.p.N, 25_000_000n);
      pastImmunity(w);
      return w;
    }

    it("cities under construction count, one level each: nine City intents make us the city leader 2 ticks later, while our cap has not moved", () => {
      const w = cityWorld();
      const { US } = w.p;
      const cap = w.config.maxTroops(US);
      for (let i = 0; i < 9; i++) {
        send(w, "US", {
          type: "build_unit",
          unit: UnitType.City,
          tile: w.game.ref(10 + 20 * (i % 3), 20 + 20 * Math.floor(i / 3)),
        });
      }
      const seed = willing(w, "N", "city");
      expect(brains(w, "N", seed).mirv.selectSteamrollStopTarget()).toBeNull();
      tick(w, 2);
      const cities = US.units(UnitType.City);
      expect(cities).toHaveLength(9);
      expect(cities.every((c) => c.isUnderConstruction())).toBe(true);
      expect(US.unitCount(UnitType.City)).toBe(9);
      expect(w.config.maxTroops(US)).toBe(cap);
      const b = brains(w, "N", seed).mirv;
      expect(b.selectVictoryDenialTarget()).toBeNull();
      expect(b.selectSteamrollStopTarget()).toBe(US);
      w.dryRun = true;
      w.game.nationMirvTargets().clear();
      expect(brains(w, "N", seed).mirv.considerMIRV()).toBe(true);
      const last = w.weapons[w.weapons.length - 1];
      expect([last.kind, last.from]).toEqual(["mirv", w.p.N]);
      expect(w.game.owner(last.dst)).toBe(US);
    });

    it("levels, not cities; more than 8; at least 1.15 x the runner-up, who may be a tribe or the nation itself; the leader must be a valid target", () => {
      const leader = (
        ours: number[],
        other: "N" | "Z" | "T" | null,
        theirs: number[],
      ) => {
        const w = cityWorld();
        const put = (key: string, levels: number[]) => {
          const p = w.p[key];
          const tiles = [...p.tiles()];
          levels.forEach((l, i) =>
            structureAt(
              w,
              p,
              UnitType.City,
              w.game.x(tiles[i * 97]),
              w.game.y(tiles[i * 97]),
              l,
            ),
          );
        };
        put("US", ours);
        if (other !== null) put(other, theirs);
        const who = brains(w, "N", "leader").mirv.selectSteamrollStopTarget();
        return who === w.p.US ? "US" : who === null ? null : "other";
      };
      const ones = (n: number) => Array<number>(n).fill(1);
      expect(leader([3, 3, 3], null, [])).toBe("US"); // 3 cities, 9 levels
      expect(leader(ones(8), null, [])).toBeNull(); // 8 is not > 8
      expect(leader(ones(9), "Z", ones(7))).toBe("US"); // 9 >= 8.05
      expect(leader(ones(9), "Z", ones(8))).toBeNull(); // 9 < 9.2
      expect(leader(ones(9), "N", ones(8))).toBeNull(); // the nation 2nd
      expect(leader(ones(9), "T", ones(8))).toBeNull(); // a tribe 2nd
      // A tribe on top blocks the rule for everyone below it.
      expect(leader(ones(9), "T", ones(12))).toBeNull();
      // The nation on top: it never MIRVs itself.
      expect(leader(ones(5), "N", ones(12))).toBeNull();
    });
  },
);

describe(
  "WP10 nation MIRV targeting: the ladder against us",
  { timeout: 60_000 },
  () => {
    it("counter-MIRV first: while our MIRV flies at it, the nation MIRVs us even when another player holds 40% of the land", () => {
      const w = targetWorld(60, "counter");
      const { US, N, Z } = w.p;
      // Z takes 40% of the land.
      for (let x = 60; x < 140; x++)
        for (let y = 0; y < 200; y++) Z.conquer(w.game.ref(x, y));
      expect(Z.numTilesOwned() * 100).toBeGreaterThanOrEqual(
        w.game.numLandTiles() * 40,
      );
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
      setGold(N, price(w, UnitType.MIRV, N));
      w.dryRun = true;
      const seed = willing(w, "N", "counter");
      const b = brains(w, "N", seed).mirv;
      expect(b.selectCounterMirvTarget()).toBe(US);
      expect(b.selectVictoryDenialTarget()).toBe(Z);
      w.game.nationMirvTargets().clear();
      expect(brains(w, "N", seed).mirv.considerMIRV()).toBe(true);
      const last = w.weapons[w.weapons.length - 1];
      expect(w.game.owner(last.dst)).toBe(US);
    });

    it("gold: the real price at the decision; one gold short, nothing (and each MIRV launched by anyone adds 15M)", () => {
      const w = targetWorld(130);
      const { N } = w.p;
      pastImmunity(w);
      w.dryRun = true;
      setGold(N, 25_000_000n);
      const seed = willing(w, "N", "gold");
      setGold(N, 25_000_000n - 1n);
      w.game.nationMirvTargets().clear();
      const n = w.weapons.length;
      expect(brains(w, "N", seed).mirv.considerMIRV()).toBe(false);
      expect(w.weapons).toHaveLength(n);
      setGold(N, 25_000_000n);
      w.game.nationMirvTargets().clear();
      expect(brains(w, "N", seed).mirv.considerMIRV()).toBe(true);
      expect(w.weapons).toHaveLength(n + 1);
    });
  },
);
