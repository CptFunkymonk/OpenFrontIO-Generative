/**
 * Pins what we get from a nation we conquer (package WP10-PIN,
 * docs/13-mechanics.md §2.13): its gold, its silos and its cities. The code
 * is the spec:
 *
 * - Gold moves only on annexation: GameImpl.conquerPlayer (GameImpl.ts:
 *   1549-1606) gives the conqueror conquerGoldAmount (Config.ts:735-744):
 *   all of a nation's or tribe's gold, half of a human's (none from a human
 *   who never attacked). It is called when an attack leaves the target
 *   under 100 tiles (AttackExecution.handleDeadDefender, AttackExecution.ts:
 *   447-482) or when a cluster that is the whole territory is enclosed
 *   (PlayerExecution.ts:505-513; EnclosePoke.test.ts). Taking tiles moves no
 *   gold. A player that dies otherwise (its last tiles nuked) has its gold
 *   deleted (PlayerExecution.removeOnDeath, :760-777): nobody gets it.
 * - On annexation the rest of its tiles are handed out in up to 100 passes:
 *   a tile bordering the attacker goes to the attacker, else to a
 *   bordering player that is not the target's friend (AttackExecution.ts:
 *   454-481).
 * - Structures: every tick, the owner's PlayerExecution hands each of its
 *   structures whose tile another player now owns to that player
 *   (captureUnit: level, and a silo's or SAM's reload queue, kept), except
 *   defense posts, which are destroyed; a structure on a tile nobody owns is
 *   deleted (PlayerExecution.ts:57-77; UnitImpl.setOwner :247-280). A
 *   captured City counts in our cap at once (Config.ts:1024-1056) and in
 *   the MIRV city ranking (unitCount), but not in our City price, which
 *   counts min(owned, built by us) (costWrapper, Config.ts:755-773).
 *
 * Setting: tests/agent/mechanics/LeaderWorld.ts.
 */
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import { PlayerType, UnitType } from "../../../src/core/game/Game";
import {
  pastImmunity,
  price,
  send,
  setGold,
  settle,
  siloAt,
  structureAt,
  tick,
  World,
  world,
} from "./LeaderWorld";

/**
 * 200 x 100: us at x < 80; the nation N on x 80-89, rows 40-54 (150
 * tiles); the human Z at x >= 90 (so N borders us and Z); the rest
 * unowned.
 */
function smallNation(): World {
  return world(
    200,
    100,
    { US: PlayerType.Human, N: PlayerType.Nation, Z: PlayerType.Human },
    (x, y) => {
      if (x < 80) return "US";
      if (x >= 90) return "Z";
      if (y >= 40 && y < 55) return "N";
      return null;
    },
  );
}

describe("WP10 conquest: gold (GameImpl.conquerPlayer)", () => {
  it("taking tiles moves no gold; the tick our attack leaves the nation under 100 tiles we get ALL its gold, and the rest of its land goes to us first (a tile next to ours is ours; only tiles that touch another neighbour and not us go to it)", () => {
    const w = smallNation();
    const { US, N, Z } = w.p;
    setGold(N, 5_000_000n);
    N.setTroops(0);
    US.setTroops(100_000);
    pastImmunity(w);
    expect(US.gold()).toBe(0n);
    send(w, "US", { type: "attack", targetID: N.id(), troops: 50_000 });
    let annexed = -1;
    for (let i = 0; i < 100 && N.isAlive(); i++) {
      tick(w);
      if (N.numTilesOwned() >= 100) {
        // Tiles only, so far: no gold.
        expect(N.numTilesOwned()).toBeLessThanOrEqual(150);
        expect(US.gold()).toBe(0n);
      } else if (annexed < 0) {
        annexed = w.game.ticks() - 1;
      }
    }
    expect(annexed).toBeGreaterThan(0);
    expect(N.isAlive()).toBe(false);
    expect(US.gold()).toBe(5_000_000n);
    expect(N.gold()).toBe(0n);
    // The remnant is handed out tile by tile in the order N holds them;
    // each tile it gives us makes the next one border us, so here all of
    // N's 150 tiles are ours and Z, which borders N too, got none.
    let ours = 0;
    for (let x = 80; x < 90; x++)
      for (let y = 40; y < 55; y++)
        if (w.game.owner(w.game.ref(x, y)) === US) ours++;
    expect(ours).toBe(150);
    expect(Z.numTilesOwned()).toBe(110 * 100);
  });

  it("a nation that dies without an annex (its last tiles nuked) takes its gold with it: nobody gets it", () => {
    // N on a 7 x 7 block, all within an atom bomb's 12-tile inner radius.
    const w = world(
      200,
      100,
      { US: PlayerType.Human, N: PlayerType.Nation, Z: PlayerType.Human },
      (x, y) => {
        if (x < 40) return "US";
        if (x >= 150) return "Z";
        if (x >= 97 && x < 104 && y >= 47 && y < 54) return "N";
        return null;
      },
    );
    const { US, N, Z } = w.p;
    siloAt(w, US, 20, 50);
    setGold(US, 1_000_000n);
    setGold(N, 5_000_000n);
    w.game.addExecution(new PlayerExecution(N));
    pastImmunity(w);
    send(w, "US", {
      type: "build_unit",
      unit: UnitType.AtomBomb,
      tile: w.game.ref(100, 50),
    });
    settle(w, 5);
    tick(w, 2);
    expect(N.isAlive()).toBe(false);
    expect(N.gold()).toBe(0n);
    expect(US.gold()).toBe(1_000_000n - 750_000n);
    expect(Z.gold()).toBe(0n);
  });
});

describe("WP10 conquest: structures (PlayerExecution capture)", () => {
  /**
   * N holds x 80-119 on all rows (4,000 tiles) with a City (level 3), a
   * silo (level 2, one slot fired), a SAM (level 2), a Factory and a
   * defense post; its PlayerExecution runs.
   */
  function fortified() {
    const w = world(
      200,
      100,
      { US: PlayerType.Human, N: PlayerType.Nation, Z: PlayerType.Human },
      (x) => (x < 80 ? "US" : x < 120 ? "N" : x >= 190 ? "Z" : null),
    );
    const { N } = w.p;
    const city = structureAt(w, N, UnitType.City, 85, 50, 3);
    const silo = siloAt(w, N, 95, 50, 2);
    const sam = structureAt(w, N, UnitType.SAMLauncher, 105, 50, 2);
    const factory = structureAt(w, N, UnitType.Factory, 115, 50);
    const post = structureAt(w, N, UnitType.DefensePost, 100, 20);
    w.game.addExecution(new PlayerExecution(N));
    pastImmunity(w);
    silo.launch();
    const fired = w.game.ticks();
    return { w, city, silo, sam, factory, post, fired };
  }

  it("the tick after we take a structure's tile it is ours, level kept (a silo keeps its reload queue); a defense post is destroyed instead", () => {
    const { w, city, silo, sam, factory, post, fired } = fortified();
    const { US, N } = w.p;
    for (const u of [city, silo, sam, factory, post]) US.conquer(u.tile());
    expect(city.owner()).toBe(N);
    tick(w);
    expect([city, silo, sam, factory].map((u) => u.owner())).toEqual([
      US,
      US,
      US,
      US,
    ]);
    expect([city, silo, sam, factory].map((u) => u.level())).toEqual([
      3, 2, 2, 1,
    ]);
    expect(silo.missileTimerQueue()).toEqual([fired]);
    expect(post.isActive()).toBe(false);
    expect(N.isAlive()).toBe(true);
  });

  it("a captured City counts in our cap at once and in the MIRV city ranking, but not in our City price", () => {
    const { w, city } = fortified();
    const { US } = w.p;
    const cap = w.config.maxTroops(US);
    const cityPrice = price(w, UnitType.City, US);
    expect(cityPrice).toBe(125_000n);
    US.conquer(city.tile());
    tick(w);
    expect(city.owner()).toBe(US);
    // One tile more of land, and 3 levels x 250k.
    expect(w.config.maxTroops(US)).toBeGreaterThan(cap + 3 * 250_000);
    expect(w.config.maxTroops(US)).toBeLessThan(cap + 3 * 250_000 + 100);
    expect(US.unitCount(UnitType.City)).toBe(3);
    expect(price(w, UnitType.City, US)).toBe(cityPrice);
  });

  it("a captured silo fires our bombs: its free slot at once, its fired slot on the old schedule (90 ticks after the nation's launch)", () => {
    const { w, silo, fired } = fortified();
    const { US } = w.p;
    setGold(US, 10_000_000n);
    US.conquer(silo.tile());
    tick(w);
    expect(silo.owner()).toBe(US);
    const atom = () => {
      send(w, "US", {
        type: "build_unit",
        unit: UnitType.AtomBomb,
        tile: w.game.ref(150, 50),
      });
      tick(w, 3);
    };
    const ours = w.game.ticks() + 2; // our first bomb's spawn tick
    atom();
    expect(US.units(UnitType.AtomBomb)).toHaveLength(1);
    expect(silo.missileTimerQueue()).toEqual([fired, ours]);
    // Both slots in use now: dropped. The nation's slot frees at fired + 90.
    atom();
    expect(silo.missileTimerQueue()).toEqual([fired, ours]);
    while (w.game.ticks() < fired + 88) tick(w);
    atom(); // spawns in tick fired + 90
    expect(silo.missileTimerQueue()).toEqual([ours, fired + 90]);
  });

  it("a structure on a tile its owner lost to nobody (relinquished) is deleted at the owner's next tick", () => {
    const { w, city } = fortified();
    w.p.N.relinquish(city.tile());
    expect(city.isActive()).toBe(true);
    tick(w);
    expect(city.isActive()).toBe(false);
  });
});
