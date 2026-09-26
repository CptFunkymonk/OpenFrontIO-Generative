import { salvoBombs } from "../../../src/agent/lib/NukeModel";
import { PlayerInfo, PlayerType, UnitType } from "../../../src/core/game/Game";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import { boundingBoxTiles } from "../../../src/core/Util";
import {
  ally,
  attack,
  brain,
  columns,
  idOf,
  model,
  pastImmunity,
  runs,
  samAt,
  setGold,
  siloAt,
  tick,
  World,
  world,
} from "./NukeWorld";

// Package B3: NukeModel (spec §2.9) against the real NationNukeBehavior
// (NNB), on the worlds of NukeWorld.ts.

const SIDE = 100;

describe("NukeModel.aimOf: findBestNukeTarget's ladder (NNB:222-316, 351-417)", () => {
  it("runner-up: the land leader aims at #2 at any margin, never at a friend", () => {
    const w = world(
      SIDE,
      SIDE,
      { N: PlayerType.Nation, H: PlayerType.Human, B: PlayerType.Nation },
      runs(SIDE, [
        ["N", 3000],
        ["H", 2900],
        ["B", 1000],
      ]),
    );
    const { N, H } = w.p;
    const m = model(w, "H");
    expect(brain(w, "N").findBestNukeTarget()).toBe(H);
    expect(m.aimOf(N.id())).toEqual({ target: H.id(), reason: "runnerUp" });
    ally(N, H);
    expect(brain(w, "N").findBestNukeTarget()).toBe(null);
    expect(m.aimOf(N.id())).toEqual({ target: null, reason: null });
  });

  it("crown lead: > 0.1 of non-fallout land ahead of the nation, in the code's floating point", () => {
    const w = world(
      SIDE,
      SIDE,
      {
        H: PlayerType.Human,
        B: PlayerType.Nation,
        N: PlayerType.Nation,
        C: PlayerType.Nation,
      },
      runs(SIDE, [
        ["H", 4000],
        ["B", 3100], // 0.09 behind
        ["N", 2000], // 0.20 behind
        ["C", 900],
      ]),
    );
    const { H, B, N } = w.p;
    const m = model(w, "H");
    expect(brain(w, "N").findBestNukeTarget()).toBe(H);
    expect(m.aimOf(N.id())).toEqual({ target: H.id(), reason: "crownLead" });
    expect(brain(w, "B").findBestNukeTarget()).toBe(null);
    expect(m.aimOf(B.id()).target).toBe(null);
    // Exactly 0.1 behind is 0.4 − 0.3 = 0.10000000000000003 > 0.1 in the
    // code's two divisions (:394-395): it aims.
    B.relinquish([...B.tiles()][0]);
    for (let i = 0; i < 99; i++) B.relinquish([...B.tiles()][0]);
    expect(B.numTilesOwned()).toBe(3000);
    expect(brain(w, "B").findBestNukeTarget()).toBe(H);
    expect(m.aimOf(B.id())).toEqual({ target: H.id(), reason: "crownLead" });
  });

  it("the largest single incoming attack comes first and hides the crown rung (exposures: latent)", () => {
    const w = world(
      SIDE,
      SIDE,
      {
        N: PlayerType.Nation,
        H: PlayerType.Human,
        A: PlayerType.Human,
        T: PlayerType.Bot,
      },
      runs(SIDE, [
        ["N", 3000],
        ["H", 2000],
        ["A", 1000],
        ["T", 500],
      ]),
    );
    const { N, H, A, T } = w.p;
    N.buildUnit(UnitType.MissileSilo, w.game.ref(10, 5), {});
    setGold(N, 1_000_000n);
    const m = model(w, "H");
    attack(A, N, 5000);
    attack(T, N, 9000); // a tribe's: ignored
    expect(brain(w, "N").findBestNukeTarget()).toBe(A);
    expect(m.aimOf(N.id())).toEqual({
      target: A.id(),
      reason: "largestAttacker",
    });
    const e = m.exposures();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      nation: N.id(),
      reason: "runnerUp",
      latent: true,
      hasSilo: true,
      canPay: "atom",
      slots: 1,
    });
    void H;
  });

  it("two players, majority, hated: each rung as the code orders it", () => {
    // Two players left: the other, even an ally.
    let w = world(
      SIDE,
      SIDE,
      { N: PlayerType.Nation, H: PlayerType.Human },
      runs(SIDE, [
        ["N", 3000],
        ["H", 1000],
      ]),
    );
    ally(w.p.N, w.p.H);
    expect(brain(w, "N").findBestNukeTarget()).toBe(w.p.H);
    expect(model(w, "H").aimOf(w.p.N.id())).toEqual({
      target: w.p.H.id(),
      reason: "twoPlayers",
    });
    // Majority: > 50% of non-fallout land.
    w = world(
      SIDE,
      SIDE,
      {
        H: PlayerType.Human,
        N: PlayerType.Nation,
        B: PlayerType.Nation,
      },
      runs(SIDE, [
        ["H", 5100],
        ["N", 3000],
        ["B", 1000],
      ]),
    );
    expect(brain(w, "N").findBestNukeTarget()).toBe(w.p.H);
    expect(model(w, "H").aimOf(w.p.N.id()).reason).toBe("crown50");
    // Hated: Hostile, unless the nation's cap is 2x ours or more.
    w = world(
      SIDE,
      SIDE,
      {
        B: PlayerType.Nation,
        H: PlayerType.Human,
        N: PlayerType.Nation,
      },
      runs(SIDE, [
        ["B", 3000],
        ["H", 2500],
        ["N", 2400],
      ]),
    );
    w.p.N.updateRelation(w.p.H, -100);
    expect(brain(w, "N").findBestNukeTarget()).toBe(w.p.H);
    expect(model(w, "H").aimOf(w.p.N.id())).toEqual({
      target: w.p.H.id(),
      reason: "hated",
    });
  });

  it("agrees with findBestNukeTarget for every nation on random worlds", () => {
    const r = new PseudoRandom(20260926);
    let checked = 0;
    for (let k = 0; k < 30; k++) {
      const keys = ["H", "N1", "N2", "N3", "N4", "T1", "T2"];
      const types: Record<string, PlayerType> = {
        H: PlayerType.Human,
        N1: PlayerType.Nation,
        N2: PlayerType.Nation,
        N3: PlayerType.Nation,
        N4: PlayerType.Nation,
        T1: PlayerType.Bot,
        T2: PlayerType.Bot,
      };
      const sizes: [string, number][] = keys.map((key) => [
        key,
        r.nextInt(100, 2000),
      ]);
      const w = world(SIDE, SIDE, types, runs(SIDE, sizes));
      const nations = ["N1", "N2", "N3", "N4"];
      const all = keys.map((key) => w.p[key]);
      // Grudges, alliances, attacks.
      for (const a of nations) {
        for (const b of keys) {
          if (a === b) continue;
          const roll = r.nextInt(0, 10);
          if (roll === 0) w.p[a].updateRelation(w.p[b], -100);
          if (roll === 1 && types[b] !== PlayerType.Bot) {
            if (!w.p[a].isAlliedWith(w.p[b])) {
              const req = w.p[a].createAllianceRequest(w.p[b]);
              req?.accept();
            }
          }
          if (roll === 2) attack(w.p[b], w.p[a], r.nextInt(1, 5000));
          if (roll === 3) w.p[a].updateRelation(w.p[b], 100);
        }
      }
      const m = model(w, "H");
      for (const n of nations) {
        const real = brain(w, n).findBestNukeTarget();
        expect(m.aimOf(w.p[n].id()).target).toBe(real?.id() ?? null);
        checked++;
      }
      void all;
    }
    expect(checked).toBe(120);
  });
});

describe("NukeModel prices and observation (NNB:487-531, :814-823)", () => {
  it("perceivedCost follows the behaviour's own counters through observed launches", () => {
    const w = world(
      200,
      100,
      { N: PlayerType.Nation, H: PlayerType.Human },
      columns([
        ["N", 60],
        [null, 40],
        ["H", 100],
      ]),
    );
    const { N, H } = w.p;
    siloAt(w, N, 10, 50, 5);
    pastImmunity(w);
    const nuke = brain(w, "N", false);
    const m = model(w, "H");
    // Two players left would use the real price: add a bystander.
    w.game.addPlayer(new PlayerInfo("X", PlayerType.Nation, null, idOf("X")));
    w.game.player(idOf("X")).conquer(w.game.ref(80, 0));
    setGold(N, 20_000_000n);
    const types = [
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
      UnitType.AtomBomb,
      UnitType.AtomBomb,
    ];
    for (const type of types) {
      nuke.sendNuke(w.game.ref(150, 50), type, H);
      tick(w, 2); // init, then the first tick builds the bomb
      m.observe();
      for (const t of [UnitType.AtomBomb, UnitType.HydrogenBomb] as const) {
        expect(m.perceivedCost(N.id(), t)).toBe(nuke.getPerceivedNukeCost(t));
      }
    }
    expect(m.launched(N.id())).toEqual({ atoms: 3, hydros: 1 });
    expect(m.firesAtoms(N.id())).toBe(true);
    // Under heavy attack (incoming >= its troops) the real price applies.
    attack(H, N, N.troops() + 1);
    expect(m.perceivedCost(N.id(), UnitType.AtomBomb)).toBe(
      nuke.getPerceivedNukeCost(UnitType.AtomBomb),
    );
    expect(m.perceivedCost(N.id(), UnitType.AtomBomb)).toBe(
      w.game.unitInfo(UnitType.AtomBomb).cost(w.game, N),
    );
  });

  it("projectedGold: the net gain since the oldest sample of the window, carried forward; exposures() lists silo owners only but samples every nation", () => {
    const w = world(
      SIDE,
      SIDE,
      { N: PlayerType.Nation, H: PlayerType.Human, B: PlayerType.Nation },
      runs(SIDE, [
        ["N", 3000],
        ["H", 2000],
        ["B", 1000],
      ]),
    );
    const { N, B } = w.p;
    siloAt(w, N, 10, 5);
    setGold(N, 1_000_000n);
    setGold(B, 9_000_000n);
    const m = model(w, "H");
    expect(m.exposures().map((e) => e.nation)).toEqual([N.id()]);
    tick(w, 100);
    setGold(N, 1_500_000n);
    m.exposures();
    // +500k in 100 ticks: +1.5M over the next 300.
    expect(m.projectedGold(N.id(), 300)).toBe(3_000_000n);
    expect(m.projectedGold(N.id(), 0)).toBe(1_500_000n);
    // No silo, sampled all the same: B rose 400k over the 100 ticks.
    setGold(B, 9_400_000n);
    expect(m.projectedGold(B.id(), 100)).toBe(9_800_000n);
    // Spending other than on bombs leaves no rate.
    tick(w, 30);
    setGold(N, 200_000n);
    m.exposures();
    expect(m.projectedGold(N.id(), 300)).toBe(200_000n);
  });

  it("projectedGold: a bomb bought in the window keeps the rate (package B3 review: a hydrogen bomb read its buyer as earning nothing)", () => {
    const w = world(
      200,
      100,
      { N: PlayerType.Nation, H: PlayerType.Human },
      columns([
        ["N", 60],
        [null, 40],
        ["H", 100],
      ]),
    );
    const { N, H } = w.p;
    w.game.addPlayer(new PlayerInfo("X", PlayerType.Nation, null, idOf("X")));
    w.game.player(idOf("X")).conquer(w.game.ref(80, 0));
    siloAt(w, N, 10, 50, 5);
    pastImmunity(w);
    setGold(N, 8_000_000n);
    const m = model(w, "H");
    m.exposures();
    tick(w, 100);
    setGold(N, 9_000_000n);
    m.exposures();
    expect(m.projectedGold(N.id(), 300)).toBe(12_000_000n);
    const nuke = brain(w, "N", false);
    nuke.sendNuke(w.game.ref(150, 50), UnitType.HydrogenBomb, H);
    tick(w, 2); // init, then the first tick builds the bomb: 5M paid
    m.observe();
    m.exposures();
    expect(N.gold()).toBe(4_000_000n);
    // Had it kept the 5M: 9M, 1M above the first sample, 102 ticks ago.
    expect(m.projectedGold(N.id(), 300)).toBe(
      4_000_000n + (1_000_000n * 300n) / 102n,
    );
  });

  it("salvoLine: the salvo's atoms at the real price, a silo level (1M) per missing launch slot, and at least the perceived atom price", () => {
    const w = world(
      200,
      100,
      { N: PlayerType.Nation, H: PlayerType.Human },
      columns([
        ["N", 60],
        [null, 40],
        ["H", 100],
      ]),
    );
    const { N, H } = w.p;
    // Two players left would use the real price: add a bystander.
    w.game.addPlayer(new PlayerInfo("X", PlayerType.Nation, null, idOf("X")));
    w.game.player(idOf("X")).conquer(w.game.ref(80, 0));
    siloAt(w, N, 10, 50);
    const m = model(w, "H");
    const atom = w.game.unitInfo(UnitType.AtomBomb).cost(w.game, N);
    const silo = w.game.unitInfo(UnitType.MissileSilo).cost(w.game, N);
    expect([atom, silo]).toEqual([750_000n, 1_000_000n]);
    // Level L of interceptors: L + 1 bombs, and one more per five.
    expect([1, 2, 3, 4, 9].map(salvoBombs)).toEqual([2, 3, 4, 6, 12]);
    // One level-1 silo against a level-1 SAM: one upgrade, two atoms.
    expect(m.salvoLine(N.id(), 1)).toBe(silo + 2n * atom);
    expect(m.salvoLine(N.id(), 2)).toBe(2n * silo + 3n * atom);
    // A SAM under construction covers nothing: one atom.
    expect(m.salvoLine(N.id(), 0)).toBe(atom);
    // A second silo: the slots are there.
    siloAt(w, N, 10, 60);
    expect(m.salvoLine(N.id(), 1)).toBe(2n * atom);
    // After three atoms the perceived price (750k x 1.5^3) is above the
    // salvo's: the type choice needs it.
    pastImmunity(w);
    setGold(N, 20_000_000n);
    const nuke = brain(w, "N", false);
    for (let i = 0; i < 3; i++) {
      nuke.sendNuke(w.game.ref(150, 50), UnitType.AtomBomb, H);
      tick(w, 2);
      m.observe();
      tick(w, w.config.SiloCooldown());
    }
    setGold(N, 1_000_000n);
    const perceived = nuke.getPerceivedNukeCost(UnitType.AtomBomb);
    expect(perceived).toBe(2_531_250n);
    expect(m.salvoLine(N.id(), 1)).toBe(perceived);
  });

  it("remembers each nation's last hydrogen bomb and its last atom at one of our SAMs (a salvo)", () => {
    const w = world(
      200,
      100,
      { N: PlayerType.Nation, H: PlayerType.Human },
      columns([
        ["N", 60],
        [null, 40],
        ["H", 100],
      ]),
    );
    const { N, H } = w.p;
    w.game.addPlayer(new PlayerInfo("X", PlayerType.Nation, null, idOf("X")));
    w.game.player(idOf("X")).conquer(w.game.ref(80, 0));
    siloAt(w, N, 10, 50, 5);
    const sam = samAt(w, H, 190, 90);
    pastImmunity(w);
    setGold(N, 20_000_000n);
    const nuke = brain(w, "N", false);
    const m = model(w, "H");
    const t0 = w.game.ticks();
    expect(m.hydroSince(N.id(), 0)).toBe(false);
    expect(m.salvoSince(N.id(), 0)).toBe(false);
    // An atom at our land away from the SAM: no salvo.
    nuke.sendNuke(w.game.ref(120, 10), UnitType.AtomBomb, H);
    tick(w, 2);
    m.observe();
    expect(m.salvoSince(N.id(), t0)).toBe(false);
    nuke.sendNuke(w.game.ref(120, 50), UnitType.HydrogenBomb, H);
    tick(w, 2);
    m.observe();
    const t1 = w.game.ticks();
    expect(m.hydroSince(N.id(), t0)).toBe(true);
    expect(m.hydroSince(N.id(), t1 + 1)).toBe(false);
    // At the SAM's tile: a salvo.
    nuke.sendNuke(sam.tile(), UnitType.AtomBomb, H);
    tick(w, 2);
    m.observe();
    expect(m.salvoSince(N.id(), t1)).toBe(true);
    expect(m.launched(N.id())).toEqual({ atoms: 2, hydros: 1 });
  });

  it("bombFor: a hydrogen bomb when the gold covers its perceived price, else an atom bomb, else none", () => {
    const w = world(
      SIDE,
      SIDE,
      { N: PlayerType.Nation, H: PlayerType.Human, B: PlayerType.Nation },
      runs(SIDE, [
        ["N", 3000],
        ["H", 2000],
        ["B", 1000],
      ]),
    );
    const { N } = w.p;
    const m = model(w, "H");
    setGold(N, 700_000n);
    expect(m.bombFor(N.id())).toBe(null);
    setGold(N, 750_000n);
    expect(m.bombFor(N.id())).toBe(UnitType.AtomBomb);
    setGold(N, 5_000_000n);
    expect(m.bombFor(N.id())).toBe(UnitType.HydrogenBomb);
  });
});

describe("NukeModel aim points: rings (isValidNukeTile) and SAM cover", () => {
  it("ringsClear equals isValidNukeTile over both square rings at random aim points", () => {
    const r = new PseudoRandom(7);
    const w = world(
      SIDE,
      SIDE,
      {
        H: PlayerType.Human,
        N: PlayerType.Nation,
        T: PlayerType.Bot,
      },
      (x, y) => {
        if ((x - 50) ** 2 + (y - 50) ** 2 < 30 ** 2) return "H";
        if (x < 12) return "N";
        if (y > 88 && x > 60) return "T";
        return null;
      },
    );
    const { H } = w.p;
    const nuke = brain(w, "N");
    const m = model(w, "H");
    let clear = 0;
    for (let i = 0; i < 300; i++) {
      const t = w.game.ref(r.nextInt(0, SIDE), r.nextInt(0, SIDE));
      for (const bomb of [UnitType.AtomBomb, UnitType.HydrogenBomb] as const) {
        const range = w.config.nukeMagnitudes(bomb).outer;
        const tiles = boundingBoxTiles(w.game, t, range).concat(
          boundingBoxTiles(w.game, t, Math.floor(range / 2)),
        );
        const real = tiles.every((x) => nuke.isValidNukeTile(x, H));
        expect(m.ringsClear(t, bomb)).toBe(real);
        if (real) clear++;
      }
    }
    expect(clear).toBeGreaterThan(20);
  });
});

/** N (8,000 tiles) leads; H's strip x in [100, 125) is second; tribes
 *  flank it when `flanked`. N's finished silo, 1M gold, aim H. */
function stripWorld(flanked: boolean): World {
  const w = world(
    200,
    100,
    {
      N: PlayerType.Nation,
      H: PlayerType.Human,
      T1: PlayerType.Bot,
      T2: PlayerType.Bot,
    },
    columns([
      ["N", 80],
      [flanked ? "T1" : null, 20],
      ["H", 25],
      [flanked ? "T2" : null, 20],
    ]),
  );
  w.p.N.buildUnit(UnitType.MissileSilo, w.game.ref(10, 50), {});
  pastImmunity(w);
  return w;
}

describe("NukeModel.nukeable against maybeSendNuke (dry run)", () => {
  it("a city in a strip flanked by third-party land has no aim point: the model says so and the nation throws nothing", () => {
    const w = stripWorld(true);
    const { N, H } = w.p;
    const city = w.game.ref(112, 50);
    H.buildUnit(UnitType.City, city, {});
    setGold(N, 1_000_000n);
    w.dryRun = true;
    const nuke = brain(w, "N", false);
    expect(nuke.findBestNukeTarget()).toBe(H);
    const m = model(w, "H");
    expect(m.nukeable([city], UnitType.AtomBomb, N)).toBe(false);
    for (let i = 0; i < 5; i++) nuke.maybeSendNuke();
    expect(w.nukes).toHaveLength(0);
  });

  it("the same city with unowned land around it is nukeable, and the nation hits it", () => {
    const w = stripWorld(false);
    const { N, H } = w.p;
    const city = w.game.ref(112, 50);
    H.buildUnit(UnitType.City, city, {});
    setGold(N, 1_000_000n);
    w.dryRun = true;
    const nuke = brain(w, "N", false);
    const m = model(w, "H");
    expect(m.nukeable([city], UnitType.AtomBomb, N)).toBe(true);
    const aim = m.aimPoint(city, UnitType.AtomBomb, N);
    expect(aim).not.toBe(null);
    nuke.maybeSendNuke();
    expect(w.nukes).toHaveLength(1);
    expect(w.nukes[0].type).toBe(UnitType.AtomBomb);
    const outer = w.config.nukeMagnitudes(UnitType.AtomBomb).outer;
    expect(
      w.game.euclideanDistSquared(w.nukes[0].dst, city),
    ).toBeLessThanOrEqual(outer * outer);
  });

  it("a finished SAM of ours within samRange − atom outer radius of the city covers every aim point: no aimed atom, the nation turns to its silo (the salvo needs 2 slots)", () => {
    const w = stripWorld(false);
    const { N, H } = w.p;
    const city = w.game.ref(112, 50);
    H.buildUnit(UnitType.City, city, {});
    // 35 tiles away: inside the covered ring [31, 40] of a level-1 SAM.
    H.buildUnit(UnitType.SAMLauncher, w.game.ref(112, 85), {});
    setGold(N, 2_000_000n);
    w.dryRun = true;
    const nuke = brain(w, "N", false);
    const m = model(w, "H");
    expect(m.nukeable([city], UnitType.AtomBomb, N)).toBe(false);
    expect(m.ourSams()).toHaveLength(1);
    nuke.maybeSendNuke();
    expect(w.nukes).toHaveLength(0);
    // Lacking the second slot, it upgrades its silo instead (:1056-1060).
    expect(w.upgrades).toEqual([N]);
  });
});
