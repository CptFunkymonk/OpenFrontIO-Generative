/**
 * Pins what a MIRV does to its target and to everyone around it (package
 * WP10-PIN, docs/13-mechanics.md §2.13): our own MIRV at a nation, and what
 * that nation does next. The code is the spec:
 *
 * - Warheads (MIRVExecution.ts:50-53, :175-224, :259-306): targets are
 *   drawn in a 1,500-tile disc around the aim tile, on land the target owns,
 *   at least 55 tiles apart (Manhattan), the aim tile first, at most 350;
 *   from 20 to 11 ticks before separation, then re-checked for ownership and
 *   topped up 10 ticks before (:206-217). Each is a NukeExecution of type
 *   MIRVWarhead (:226-249) with magnitude inner 12, outer 18
 *   (Config.ts:1103-1106).
 * - A warhead's blast (NukeExecution.ts:70-142, :387-515): a BFS from the
 *   aim that takes every passable tile within 12 and, beyond, each tile with
 *   a coin flip (so the 12-18 ring is patchy); every owned tile hit is
 *   relinquished and turns to fallout (GameImpl.ts:298-308, waterNukes off);
 *   for each tile hit, its owner, its outgoing attacks and its boats lose
 *   nukeDeathFactor (Config.ts:1177-1193): for a warhead 500 x (1 -
 *   e^(-2x/M)) with x = troops above 3% of the owner's cap M (M taken after
 *   the warhead's tiles are gone); every unit strictly within 18 tiles is
 *   deleted, any owner's, any level (:464-483).
 * - Diplomacy: at launch the MIRV breaks our alliance with the owner of the
 *   aim tile and sets -100 both ways (MIRVExecution.ts:110-121; the breaker
 *   turns traitor unless the other is one, GameImpl.ts:878-906). Warheads
 *   never break alliances or move relations (NukeExecution.ts:152-155,
 *   :232-234). Nothing else moves: no -40 from neighbours (only
 *   BreakAllianceExecution gives that, BreakAllianceExecution.ts:45-56).
 * - The target nation: its relation to us is Hostile, so at its next
 *   decision it embargoes us for good (isTemporary false), and at
 *   Impossible it never lifts that embargo (NationExecution.ts:336-382).
 *   Its nukes name us as the most hostile player unless its cap is >= 2x
 *   ours (NationNukeBehavior.ts:289-301). Its strategy list needs troops >=
 *   reserveRatio x cap (AiAttackBehavior.ts:289-290), which a MIRV takes
 *   away. It can counter-MIRV only while our carrier is in the air
 *   (selectCounterMirvTarget reads units(MIRV), NationMIRVBehavior.ts:
 *   171-179, :281-294).
 * - The 300-tick skip (NationMIRVBehavior.ts:32, :257-265, :303-305) is
 *   written only by a nation's MIRV; ours writes nothing, so a nation may
 *   MIRV the target we just MIRVed.
 *
 * Setting: tests/agent/mechanics/LeaderWorld.ts (the real Config, FFA,
 * Singleplayer, Impossible, all-plains maps; no PlayerExecution unless a
 * test adds one).
 */
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import { PlayerType, UnitType } from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import {
  ally,
  brains,
  dist,
  isDecisionTick,
  nationOf,
  pastImmunity,
  price,
  relationValue,
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

interface Scene {
  w: World;
  /** V's block: x0 <= x < x0 + vw, y0 <= y < y0 + vh. */
  x0: number;
  y0: number;
  aim: TileRef;
}

/**
 * Us (US) at x < 60 with a silo near the bottom and 100M gold; the target
 * nation V a vw x vh block starting 100 columns east of us; our ally Z a
 * 40-column strip east of V on the same rows; a tribe T in the top-right
 * corner. The rest is unowned land.
 */
function scene(vw: number, vh: number, gameID = "mirv-effect"): Scene {
  const x0 = 160;
  const W = x0 + vw + 60;
  const H = Math.max(vh + 40, 700);
  const y0 = H - vh - 10;
  const w = world(
    W,
    H,
    {
      US: PlayerType.Human,
      V: PlayerType.Nation,
      Z: PlayerType.Nation,
      T: PlayerType.Bot,
    },
    (x, y) => {
      if (x < 60) return "US";
      const rows = y >= y0 && y < y0 + vh;
      if (rows && x >= x0 && x < x0 + vw) return "V";
      if (rows && x >= x0 + vw && x < x0 + vw + 40) return "Z";
      if (x >= W - 5 && y < 5) return "T";
      return null;
    },
    { gameID },
  );
  siloAt(w, w.p.US, 30, H - 50);
  setGold(w.p.US, 100_000_000n);
  const aim = w.game.ref(x0 + Math.floor(vw / 2), y0 + Math.floor(vh / 2));
  return { w, x0, y0, aim };
}

function fire(s: Scene): void {
  send(s.w, "US", { type: "build_unit", unit: UnitType.MIRV, tile: s.aim });
  tick(s.w, 3);
  expect(s.w.p.US.units(UnitType.MIRV)).toHaveLength(1);
}

const warheads = (w: World) =>
  w.weapons.filter((x) => x.type === UnitType.MIRVWarhead);

describe("WP10 MIRV effect: the warheads (MIRVExecution)", () => {
  it.each([
    [200, 200],
    [400, 300],
  ])(
    "a %ix%i target gets one warhead per ~2,400 tiles of a compact territory (16 and 51 here), all on its land, at least 55 apart (Manhattan), the aim tile first",
    (vw, vh) => {
      const s = scene(vw, vh);
      const { w } = s;
      const own = new Set(w.p.V.tiles());
      pastImmunity(w);
      fire(s);
      settle(w);
      const dsts = warheads(w).map((x) => x.dst);
      expect(dsts).toContain(s.aim);
      for (const d of dsts) expect(own.has(d)).toBe(true);
      let closest = Infinity;
      for (let i = 0; i < dsts.length; i++)
        for (let j = i + 1; j < dsts.length; j++)
          closest = Math.min(closest, w.game.manhattanDist(dsts[i], dsts[j]));
      expect(closest).toBeGreaterThanOrEqual(55);
      // Random packing: well under the 55-tile lattice's ~1 per 1,512.
      const perWarhead = (vw * vh) / dsts.length;
      expect(perWarhead).toBeGreaterThan(2_100);
      expect(perWarhead).toBeLessThan(2_700);
    },
    60_000,
  );

  it("a small target gets few warheads, so a MIRV does not bring it down to 3%: a 60 x 60 one gets three here and keeps 8% of its cap (a big one ~3%)", () => {
    const s = scene(60, 60);
    const { w } = s;
    const V = w.p.V;
    V.addTroops(300_000 - V.troops());
    pastImmunity(w);
    fire(s);
    settle(w);
    const n = warheads(w).length;
    expect(n).toBe(3);
    const left = V.troops() / w.config.maxTroops(V);
    expect(left).toBeGreaterThan(0.07);
    expect(left).toBeLessThan(0.09);
  }, 60_000);

  it("each warhead takes every tile within 12 and a patchy ring out to 18; the tiles hit turn to fallout; a compact target keeps about 70% of its land", () => {
    const s = scene(200, 200);
    const { w } = s;
    const before = w.p.V.numTilesOwned();
    pastImmunity(w);
    fire(s);
    settle(w);
    const dsts = warheads(w).map((x) => x.dst);
    const inner = w.config.nukeMagnitudes(UnitType.MIRVWarhead).inner;
    const outer = w.config.nukeMagnitudes(UnitType.MIRVWarhead).outer;
    expect([inner, outer]).toEqual([12, 18]);
    let within12 = 0;
    let ring = 0;
    let ringHit = 0;
    let beyond = 0;
    w.game.forEachTile((t) => {
      const d = Math.min(...dsts.map((a) => dist(w, a, t)));
      const hit = w.game.hasFallout(t);
      if (d <= inner) {
        within12++;
        expect(hit).toBe(true);
      } else if (d <= outer) {
        ring++;
        if (hit) ringHit++;
      } else if (hit) beyond++;
    });
    expect(beyond).toBe(0);
    expect(within12).toBeGreaterThan(0);
    // The coin-flip ring: well under all of it, well over none of it.
    expect(ringHit / ring).toBeGreaterThan(0.2);
    expect(ringHit / ring).toBeLessThan(0.8);
    const kept = w.p.V.numTilesOwned() / before;
    expect(kept).toBeGreaterThan(0.65);
    expect(kept).toBeLessThan(0.75);
  }, 60_000);

  it("troops: each tile hit kills 500 x (1 - e^(-2x/M)) of its owner's troops (x = troops above 3% of its cap M), its outgoing attacks' likewise: the target is left with about 3% of its cap", () => {
    const c = scene(10, 10).w.config;
    const M = 1_000_000;
    const f = (troops: number) =>
      c.nukeDeathFactor(UnitType.MIRVWarhead, troops, 5_000, M);
    expect(f(0.03 * M)).toBe(0);
    expect(f(0.02 * M)).toBe(0);
    for (const troops of [40_000, 100_000, 500_000, 1_000_000, 3_000_000]) {
      const x = troops - 0.03 * M;
      expect(f(troops)).toBeCloseTo(500 * (1 - Math.exp((-2 * x) / M)), 6);
    }
    expect(f(1e12)).toBeCloseTo(500, 6);
    // Live, on a 400 x 300 target with 1M troops and a 400k attack out.
    const s = scene(400, 300);
    const { w } = s;
    const V = w.p.V;
    V.addTroops(1_000_000 - V.troops());
    const out = V.createAttack(w.game.terraNullius(), 400_000, null, new Set());
    pastImmunity(w);
    fire(s);
    settle(w);
    const cap = w.config.maxTroops(V);
    expect(V.troops() / cap).toBeGreaterThan(0.03);
    expect(V.troops() / cap).toBeLessThan(0.035);
    expect(out.troops() / cap).toBeLessThan(0.035);
  }, 60_000);

  it("structures: a unit survives unless it stands strictly within 18 tiles of a warhead: more than half of 300 level-3 silos on a 20-tile grid survive (179 here)", () => {
    const s = scene(400, 300);
    const { w, x0, y0 } = s;
    const silos = [];
    for (let x = x0 + 10; x < x0 + 400; x += 20)
      for (let y = y0 + 10; y < y0 + 300; y += 20)
        silos.push(structureAt(w, w.p.V, UnitType.MissileSilo, x, y, 3));
    pastImmunity(w);
    fire(s);
    settle(w);
    const dsts = warheads(w).map((x) => x.dst);
    const outer = w.config.nukeMagnitudes(UnitType.MIRVWarhead).outer;
    let alive = 0;
    for (const u of silos) {
      const d = Math.min(...dsts.map((a) => dist(w, a, u.tile())));
      expect(u.isActive()).toBe(d >= outer);
      if (u.isActive()) {
        alive++;
        expect(u.level()).toBe(3);
      }
    }
    expect(silos).toHaveLength(300);
    expect(alive / 300).toBeGreaterThan(0.5);
    expect(alive / 300).toBeLessThan(0.75);
  }, 60_000);
});

describe("WP10 MIRV effect: diplomacy", () => {
  it("the launch breaks the alliance with the target (we turn traitor) and sets -100 both ways; warheads that hit an ally of ours next to the target cost it tiles and troops but move neither the alliance nor any relation", () => {
    const s = scene(400, 300);
    const { w } = s;
    const { US, V, Z } = w.p;
    ally(US, V);
    ally(US, Z);
    Z.addTroops(500_000 - Z.troops());
    pastImmunity(w);
    const zTiles = Z.numTilesOwned();
    const others = () => [
      relationValue(Z, US),
      relationValue(US, Z),
      relationValue(Z, V),
      relationValue(V, Z),
    ];
    const before = others();
    fire(s);
    expect(US.isAlliedWith(V)).toBe(false);
    expect(US.isTraitor()).toBe(true);
    expect([relationValue(V, US), relationValue(US, V)]).toEqual([-100, -100]);
    settle(w);
    expect(Z.numTilesOwned()).toBeLessThan(zTiles);
    expect(Z.troops()).toBeLessThan(500_000);
    expect(US.isAlliedWith(Z)).toBe(true);
    expect(others()).toEqual(before);
  }, 60_000);

  it("the target nation embargoes us for good at its next decision and never lifts it (Impossible), even once decay has taken its relation back above Hostile; with a ready silo and bomb gold it answers with a bomb at our structures", () => {
    const s = scene(300, 300, "mirv-react");
    const { w } = s;
    const { US, V } = w.p;
    structureAt(w, US, UnitType.City, 20, 300);
    // A silo in V's far corner, beyond every warhead here.
    const vsilo = siloAt(w, V, s.x0 + 295, s.y0 + 295);
    US.addTroops(2_000_000 - US.troops());
    V.addTroops(1_500_000 - V.troops());
    const nation = nationOf(w, "V", "mirv-react");
    pastImmunity(w);
    startNation(w, nation);
    w.game.addExecution(new PlayerExecution(V));
    const t = w.game.ticks();
    fire(s);
    let embargoAt = -1;
    for (let i = 0; embargoAt < 0 && i < 60; i++) {
      tick(w);
      if (V.hasEmbargoAgainst(US)) embargoAt = w.game.ticks() - 1;
    }
    expect(embargoAt).toBeGreaterThan(t + 2);
    expect(isDecisionTick(nation, embargoAt)).toBe(true);
    const embargo = V.getEmbargoes().find((e) => e.target === US)!;
    expect(embargo.isTemporary).toBe(false);
    // Bomb gold at each decision from now on.
    let bombs: UnitType[] = [];
    for (let i = 0; i < 1200; i++) {
      if (isDecisionTick(nation, w.game.ticks())) setGold(V, 10_000_000n);
      tick(w);
    }
    bombs = w.weapons.filter((x) => x.from === V).map((x) => x.type);
    expect(vsilo.isActive()).toBe(true);
    expect(bombs.length).toBeGreaterThan(0);
    expect(US.units(UnitType.City)).toHaveLength(0);
    // 1,200 ticks of decay (0.05 a tick) took -100 back above -50.
    expect(relationValue(V, US)).toBeGreaterThan(-50);
    expect(V.hasEmbargoAgainst(US)).toBe(true);
    expect(V.getEmbargoes().find((e) => e.target === US)!.createdAt).toBe(
      embargo.createdAt,
    );
  }, 60_000);

  it("the MIRVed nation cannot attack any player until its troops regrow to its reserve ratio (30-39% of its cap): walled in, with no free land to spend on, it took 271 ticks after the warheads landed to regrow from 3% to its 30%", () => {
    // V (300 x 300, on the bottom edge of the map) walled in by Z, which
    // holds every other tile but our strip, and has troops enough that V's
    // attack on it is no snack. (On the map edge V's clusters are never
    // "surrounded by one player", PlayerExecution.ts:366-421, so Z cannot
    // annex it whole; EnclosePoke.test.ts pins that rule.)
    const W = 620;
    const H = 700;
    const w = world(
      W,
      H,
      { US: PlayerType.Human, V: PlayerType.Nation, Z: PlayerType.Nation },
      (x, y) => {
        if (x < 60) return "US";
        if (x >= 160 && x < 460 && y >= 400) return "V";
        return "Z";
      },
      { gameID: "mirv-paralysis-0" },
    );
    siloAt(w, w.p.US, 30, 650);
    setGold(w.p.US, 100_000_000n);
    const { V, Z } = w.p;
    V.addTroops(1_500_000 - V.troops());
    Z.addTroops(5_000_000 - Z.troops());
    const nation = nationOf(w, "V", "mirv-paralysis-0");
    pastImmunity(w);
    startNation(w, nation);
    w.game.addExecution(new PlayerExecution(V));
    const s: Scene = { w, x0: 160, y0: 400, aim: w.game.ref(310, 550) };
    fire(s);
    settle(w);
    const landed = w.game.ticks();
    const ratio = () => V.troops() / w.config.maxTroops(V);
    expect(ratio()).toBeLessThan(0.05);
    let attackedPlayer = false;
    let back = -1;
    for (let i = 0; i < 2000 && back < 0; i++) {
      tick(w);
      if (ratio() >= nation.n.reserveRatio) back = w.game.ticks();
      else if (V.outgoingAttacks().some((a) => a.target().isPlayer()))
        attackedPlayer = true;
    }
    expect(nation.n.reserveRatio).toBe(0.3);
    expect(back).toBeGreaterThan(0);
    expect(attackedPlayer).toBe(false);
    expect(back - landed).toBe(271);
  }, 60_000);

  it("counter-MIRV: while our carrier is in the air the target, with a silo and the new price, MIRVs us back; once it has separated that rung is gone", () => {
    const s = scene(300, 300);
    const { w } = s;
    const { US, V } = w.p;
    siloAt(w, V, s.x0 + 295, s.y0 + 295);
    pastImmunity(w);
    fire(s);
    setGold(V, price(w, UnitType.MIRV, V)); // 40M after our launch
    expect(price(w, UnitType.MIRV, V)).toBe(40_000_000n);
    w.dryRun = true;
    const decide = (gameID: string) => {
      w.game.nationMirvTargets().clear();
      const b = brains(w, "V", gameID).mirv;
      return { target: b.selectCounterMirvTarget(), fired: b.considerMIRV() };
    };
    // A seed that does not hesitate (1 in 16).
    const seed = [...Array(20).keys()]
      .map((i) => `counter-${i}`)
      .find((id) => decide(id).fired);
    expect(seed).toBeDefined();
    const last = w.weapons[w.weapons.length - 1];
    expect([last.kind, last.from]).toEqual(["mirv", V]);
    expect(w.game.owner(last.dst)).toBe(US);
    // After separation: no MIRV of ours in the air, no counter target, and
    // we are neither a 40% holder nor the city leader.
    w.dryRun = false;
    while (US.units(UnitType.MIRV).length > 0) tick(w);
    w.dryRun = true;
    expect(decide(seed!)).toEqual({ target: null, fired: false });
  }, 60_000);

  it("our MIRV writes no 300-tick skip: a nation MIRVs the target we just MIRVed at its next decision (a nation's MIRV would have blocked every nation for 300 ticks)", () => {
    // V holds 400 x 600 of the 620 x 700 land: 55%.
    const s = scene(400, 600);
    const { w } = s;
    const { V, Z } = w.p;
    expect(V.numTilesOwned() * 100).toBeGreaterThanOrEqual(
      w.game.numLandTiles() * 40,
    );
    siloAt(w, Z, s.x0 + 420, s.y0 + 300);
    pastImmunity(w);
    fire(s);
    expect(w.game.nationMirvTargets().has(V.id())).toBe(false);
    setGold(Z, price(w, UnitType.MIRV, Z));
    w.dryRun = true;
    const seed = [...Array(20).keys()]
      .map((i) => `pile-${i}`)
      .find((id) => {
        w.game.nationMirvTargets().clear();
        return brains(w, "Z", id).mirv.considerMIRV();
      });
    expect(seed).toBeDefined();
    const last = w.weapons[w.weapons.length - 1];
    expect([last.kind, last.from]).toEqual(["mirv", Z]);
    expect(w.game.owner(last.dst)).toBe(V);
    // Z's own MIRV (recorded) blocks a second nation MIRV at V for 300 ticks.
    expect(w.game.nationMirvTargets().get(V.id())).toBe(w.game.ticks());
    expect(brains(w, "Z", seed!).mirv.considerMIRV()).toBe(false);
  }, 60_000);
});
