import { AgentContext, AgentIntent } from "../../../src/agent/Agent";
import {
  exposedSite,
  hubLevels,
  hubRing,
  hubSites,
  inHub,
  NukePlan,
  nukeThreats,
  planCity,
  planSam,
  samKiller,
  threatAt,
} from "../../../src/agent/agents/apex/controllers/EconomyController";
import {
  ApexOptions,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import { ApexPolicy } from "../../../src/agent/agents/apex/policy";
import { createState } from "../../../src/agent/agents/apex/state";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { PlayerType, UnitType } from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import {
  ally,
  attack,
  brain,
  columns,
  GAME_ID,
  model,
  pastImmunity,
  samAt,
  setGold,
  siloAt,
  tick,
  World,
  world,
} from "./NukeWorld";

// Package B3: the nuke-model structure rules of the EconomyController
// (o.nukeModel): threats, exposure of sites and upgrades, the SAM hub.
// Worlds of NukeWorld.ts (the real Config, tiles and gold handed out).

/** Only the economy runs; the B3 model on. */
const O: ApexOptions = parseApexOptions({
  expansion: false,
  defense: false,
  diplomacy: false,
  strike: false,
  endgame: false,
  boats: false,
  nukeModel: true,
});

/**
 * 300 x 120: N (the leader, 14,000 tiles) holds columns [0, 120); H (us,
 * second, 9,600) holds [120, 200), 40 tiles deep at most; the rest
 * [200, 300) unowned. B, a small nation, owns a corner of N's side. N has
 * a finished silo of `siloLevel` and `gold`; with `ready`, spawn immunity
 * is over (nukeSpawn refuses before) and the silo reloaded.
 * (120 rows keep H's border at 240 tiles, under interiorSites' 256-tile
 * sample: with two border tiles a row in raster order, a stride of 2 would
 * sample only the left column; see the package B3 report.)
 */
function leaderWorld(gold: bigint, siloLevel = 1, ready = false): World {
  const w = world(
    300,
    120,
    { N: PlayerType.Nation, H: PlayerType.Human, B: PlayerType.Nation },
    (x, y) => {
      if (x < 20 && y < 20) return "B";
      if (x < 120) return "N";
      if (x < 200) return "H";
      return null;
    },
  );
  siloAt(w, w.p.N, 60, 60, siloLevel);
  if (ready) pastImmunity(w);
  setGold(w.p.N, gold);
  return w;
}

function plan(w: World, key: string, o: ApexOptions = O): NukePlan {
  const m = model(w, key);
  return { model: m, threats: nukeThreats(w.game, w.p[key], m, o) };
}

function dist(w: World, a: TileRef, b: TileRef): number {
  return Math.sqrt(w.game.euclideanDistSquared(a, b));
}

describe("B3 threats (nukeThreats)", () => {
  it("the leader aiming at us as runner-up with a silo and atom gold is a threat; allied, without a silo, or far from the price it is not", () => {
    let w = leaderWorld(1_000_000n);
    const p = plan(w, "H");
    expect(p.threats).toHaveLength(1);
    // (toBe, not inside toMatchObject: its subset walk descends into the
    // whole Player graph.)
    expect(p.threats[0].nation).toBe(w.p.N);
    expect(p.threats[0]).toMatchObject({
      bombs: [UnitType.AtomBomb],
      reason: "runnerUp",
      latent: false,
      slots: 1,
    });
    ally(w.p.N, w.p.H);
    expect(plan(w, "H").threats).toHaveLength(0);
    // Half the perceived atom price (o.nukePayShare) still counts.
    w = leaderWorld(375_000n);
    expect(plan(w, "H").threats).toHaveLength(1);
    w = leaderWorld(374_000n);
    expect(plan(w, "H").threats).toHaveLength(0);
    // No silo: no threat.
    w = world(
      300,
      120,
      { N: PlayerType.Nation, H: PlayerType.Human },
      columns([
        ["N", 120],
        ["H", 80],
      ]),
    );
    setGold(w.p.N, 1_000_000n);
    expect(plan(w, "H").threats).toHaveLength(0);
  });

  it("bombs: a hydrogen bomb joins the atom once the gold reaches nukePayShare of its perceived price; paying it, the hydrogen bomb alone (no fallback to atoms)", () => {
    const bombs = (gold: bigint) => {
      const w = leaderWorld(gold);
      const p = plan(w, "H");
      expect(p.threats).toHaveLength(1);
      return p.threats[0].bombs;
    };
    expect(bombs(2_400_000n)).toEqual([UnitType.AtomBomb]);
    expect(bombs(2_500_000n)).toEqual([
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
    ]);
    expect(bombs(5_000_000n)).toEqual([UnitType.HydrogenBomb]);
    // The SAM hub stays off against the nearly-hydro threat.
    const w = leaderWorld(2_500_000n);
    w.p.H.buildUnit(UnitType.City, w.game.ref(160, 60), {});
    setGold(w.p.H, 5_000_000n);
    expect(planSam(w.game, w.p.H, O, plan(w, "H"))).toBe("hydro");
  });

  it("latent: an incoming attack hides the crown rung but the nation still counts; the rank guard and the memory count too, and each can be switched off", () => {
    const w = leaderWorld(1_000_000n);
    const { N, B } = w.p;
    attack(B, N, 5000);
    let p = plan(w, "H");
    expect(p.threats.map((t) => [t.reason, t.latent])).toEqual([
      ["runnerUp", true],
    ]);
    expect(plan(w, "H", { ...O, nukeLatent: false }).threats).toHaveLength(0);
    // Memory: the model saw N name us; once N no longer does (we fall to
    // third behind B), it counts for nukeMemory ticks.
    const m = model(w, "H");
    const o = { ...O, nukeRankGuard: false };
    expect(nukeThreats(w.game, w.p.H, m, o)).toHaveLength(1);
    for (let x = 200; x < 300; x++) {
      for (let y = 0; y < 120; y++) B.conquer(w.game.ref(x, y));
    }
    // B: 12,400 tiles, second; we are third: N's runner-up is B.
    expect(m.aimOf(N.id()).target).toBe(B.id());
    p = { model: m, threats: nukeThreats(w.game, w.p.H, m, o) };
    expect(p.threats.map((t) => [t.reason, t.latent])).toEqual([
      ["runnerUp", true],
    ]);
    tick(w, O.nukeMemory + 1);
    expect(nukeThreats(w.game, w.p.H, m, o)).toHaveLength(0);
  });

  it("rank guard: first or second among humans and nations, a silo owner in their top three counts before its ladder names us", () => {
    // H leads N by less than 0.1: N's crown rung names nobody.
    const w = world(
      300,
      200,
      { H: PlayerType.Human, N: PlayerType.Nation, C: PlayerType.Nation },
      columns([
        ["H", 110],
        ["N", 100],
        ["C", 90],
      ]),
    );
    siloAt(w, w.p.N, 150, 100);
    setGold(w.p.N, 1_000_000n);
    const m = model(w, "H");
    expect(m.aimOf(w.p.N.id()).target).toBe(null);
    const threats = nukeThreats(w.game, w.p.H, m, O);
    expect(threats.map((t) => [t.nation, t.reason, t.latent])).toEqual([
      [w.p.N, "crownLead", true],
    ]);
    expect(
      nukeThreats(w.game, w.p.H, m, { ...O, nukeRankGuard: false }),
    ).toHaveLength(0);
  });
});

describe("B3 exposure of cities (planCity with the model)", () => {
  it("a threat blocks a nukeable site; a silo owner aiming elsewhere blocks only through exposedSite, which nukeCities drops", () => {
    // Threat: N aims at us.
    let w = leaderWorld(1_000_000n);
    setGold(w.p.H, 2_000_000n);
    let p = plan(w, "H");
    const site = w.game.ref(160, 60);
    expect(threatAt(p, site)).not.toBe(null);
    expect(planCity(w.game, w.p.H, O, p)).toBe("exposed");
    // N aims at B, the runner-up; we are third.
    w = world(
      300,
      120,
      {
        N: PlayerType.Nation,
        B: PlayerType.Nation,
        H: PlayerType.Human,
      },
      columns([
        ["N", 120],
        ["B", 100],
        ["H", 80],
      ]),
    );
    siloAt(w, w.p.N, 60, 60);
    setGold(w.p.N, 1_000_000n);
    setGold(w.p.H, 2_000_000n);
    p = plan(w, "H");
    expect(p.threats).toHaveLength(0);
    // The legacy rule (the default: nukeCities off) still refuses: N has a
    // silo and bomb gold.
    expect(exposedSite(w.game, w.p.H, w.game.ref(260, 60), true)).toBe(true);
    expect(planCity(w.game, w.p.H, O, p)).toBe("exposed");
    expect(planCity(w.game, w.p.H, { ...O, nukeModel: false })).toBe("exposed");
    // The model alone (nukeCities, "v1") builds.
    const act = planCity(w.game, w.p.H, { ...O, nukeCities: true }, p);
    expect(typeof act).not.toBe("string");
  });

  it("the real nation agrees: under a threat nothing planCity would build is aimed at", () => {
    const w = leaderWorld(1_000_000n, 1, true);
    const { N, H } = w.p;
    setGold(H, 2_000_000n);
    // A SAM hub: finished SAM at (160, 100); the ring [31, 40] is covered.
    samAt(w, H, 160, 60);
    tick(w);
    const p = plan(w, "H");
    expect(p.threats).toHaveLength(1);
    const act = planCity(w.game, H, O, p);
    if (typeof act === "string") throw new Error(`no build: ${act}`);
    expect(act.kind).toBe("build");
    if (act.kind !== "build") return;
    const d = dist(w, act.tile, w.game.ref(160, 60));
    const ring = hubRing(w.game);
    expect(d).toBeGreaterThanOrEqual(ring.min);
    expect(d).toBeLessThanOrEqual(ring.max);
    H.buildUnit(UnitType.City, act.tile, {});
    w.dryRun = true;
    const nuke = brain(w, "N", false);
    expect(nuke.findBestNukeTarget()).toBe(H);
    nuke.maybeSendNuke();
    expect(w.nukes).toHaveLength(0);
    // Its silo has one slot, the salvo needs two: it upgrades the silo.
    expect(w.upgrades).toEqual([N]);
  });

  it("hub sites keep citySpread's spacing: at most one city within twice an atom's outer radius", () => {
    const w = leaderWorld(1_000_000n);
    const { H } = w.p;
    samAt(w, H, 160, 60);
    tick(w);
    const first = hubSites(w.game, H, O);
    expect(first.length).toBeGreaterThan(0);
    H.buildUnit(UnitType.City, first[0].tile, {});
    const outer = w.config.nukeMagnitudes(UnitType.AtomBomb).outer;
    for (const s of hubSites(w.game, H, O)) {
      expect(dist(w, s.tile, first[0].tile)).toBeGreaterThan(2 * outer);
    }
  });

  it("upgrades under a threat go only to cities no threat can aim at", () => {
    const w = leaderWorld(1_000_000n);
    const { H } = w.p;
    samAt(w, H, 135, 100);
    // One city in the hub ring (35 tiles from the SAM), one far outside it
    // with more levels, so first by the usual order: its own tile is an aim
    // point 105 tiles from the SAM with both rings clear.
    const inRing = H.buildUnit(UnitType.City, w.game.ref(170, 100), {});
    const outside = H.buildUnit(UnitType.City, w.game.ref(185, 8), {});
    outside.increaseLevel();
    tick(w);
    setGold(H, 2_000_000n);
    const p = plan(w, "H");
    expect(threatAt(p, outside.tile())).not.toBe(null);
    expect(threatAt(p, inRing.tile())).toBe(null);
    const act = planCity(w.game, H, O, p);
    if (typeof act === "string") throw new Error(`no action: ${act}`);
    expect(act).toMatchObject({ kind: "upgrade", unitId: inRing.id() });
    // Without threats and with the model alone (nukeCities), the usual
    // order upgrades the other one; with the legacy rule, exposedSite still
    // refuses it (N has a silo and bomb gold) but not the hub city.
    const legacy = planCity(w.game, H, O, { model: p.model, threats: [] });
    expect(legacy).toMatchObject({ kind: "upgrade", unitId: inRing.id() });
    const free = planCity(
      w.game,
      H,
      { ...O, nukeCities: true },
      { model: p.model, threats: [] },
    );
    if (typeof free === "string") throw new Error(`no action: ${free}`);
    expect(free).toMatchObject({ kind: "upgrade", unitId: outside.id() });
  });
});

describe("B3 v3: firing threats outside hubs, every threat inside", () => {
  it("a threat that cannot pay yet (not firing) does not refuse a city exposedSite allows", () => {
    const w = leaderWorld(400_000n);
    const { H } = w.p;
    setGold(H, 2_000_000n);
    const p = plan(w, "H");
    expect(p.threats).toHaveLength(1);
    expect(p.threats[0].firing).toBe(false);
    expect(p.threats[0].bombs).toEqual([UnitType.AtomBomb]);
    expect(exposedSite(w.game, H, w.game.ref(160, 60), true)).toBe(false);
    const act = planCity(w.game, H, O, p);
    expect(typeof act).toBe("object");
    // Paying now, it fires: refused.
    setGold(w.p.N, 1_000_000n);
    const q = plan(w, "H");
    expect(q.threats[0].firing).toBe(true);
    expect(planCity(w.game, H, O, q)).toBe("exposed");
  });

  it("inside a hub an anticipated hydrogen bomb refuses the site when its rings are clear; an atom-only threat does not", () => {
    // 600 x 300: N (75,000 tiles) leads; H (59,800) at x in [300, 530),
    // y in [20, 280), unowned land around it, so hydrogen rings are clear.
    const make = (gold: bigint) => {
      const w = world(
        600,
        300,
        { N: PlayerType.Nation, H: PlayerType.Human },
        (x, y) => {
          if (x < 250) return "N";
          if (x >= 300 && x < 530 && y >= 20 && y < 280) return "H";
          return null;
        },
      );
      siloAt(w, w.p.N, 100, 150);
      setGold(w.p.N, gold);
      samAt(w, w.p.H, 415, 150);
      tick(w);
      setGold(w.p.H, 2_000_000n);
      return w;
    };
    const site = (w: World) => w.game.ref(415, 185);
    // Atom only (1M): the hub site is covered, the build goes there.
    let w = make(1_000_000n);
    let p = plan(w, "H");
    expect(p.threats[0].bombs).toEqual([UnitType.AtomBomb]);
    expect(threatAt(p, site(w))).toBe(null);
    const act = planCity(w.game, w.p.H, O, p);
    if (typeof act === "string" || act.kind !== "build") {
      throw new Error(`no build: ${JSON.stringify(act)}`);
    }
    expect(inHub(w.game, w.p.H, act.tile)).toBe(true);
    // 2.6M: a hydrogen bomb is near (half its 5M): the ring is refused,
    // and exposedSite refuses the rest.
    w = make(2_600_000n);
    p = plan(w, "H");
    expect(p.threats[0].bombs).toEqual([
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
    ]);
    expect(threatAt(p, site(w))).not.toBe(null);
    expect(planCity(w.game, w.p.H, O, p)).toBe("exposed");
  });
});

describe("B3 the SAM hub (planSam)", () => {
  it("places the SAM beyond an atom's outer radius from every structure, with our city in its covered ring", () => {
    const w = leaderWorld(1_000_000n);
    const { H } = w.p;
    const city = H.buildUnit(UnitType.City, w.game.ref(160, 60), {});
    city.increaseLevel();
    city.increaseLevel();
    setGold(H, 2_000_000n);
    const act = planSam(w.game, H, O, plan(w, "H"));
    if (typeof act === "string") throw new Error(`no SAM: ${act}`);
    const ring = hubRing(w.game);
    const d = dist(w, act.tile, city.tile());
    expect(d).toBeGreaterThanOrEqual(ring.min);
    expect(d).toBeLessThanOrEqual(ring.max);
    expect(act.covered).toBe(3);
    expect(act.cost).toBe(
      w.game.unitInfo(UnitType.SAMLauncher).cost(w.game, H),
    );
    // Built, the city is covered: no threat can aim at it.
    samAt(w, H, w.game.x(act.tile), w.game.y(act.tile));
    tick(w);
    expect(threatAt(plan(w, "H"), city.tile())).toBe(null);
  });

  it("no SAM: without a threat, against a hydrogen bomb, at samMax, short of gold, or when it would cover too little", () => {
    let w = leaderWorld(1_000_000n);
    const { H } = w.p;
    H.buildUnit(UnitType.City, w.game.ref(160, 60), {}).increaseLevel();
    setGold(H, 2_000_000n);
    expect(planSam(w.game, H, { ...O, samHub: false }, plan(w, "H"))).toBe(
      "off",
    );
    ally(w.p.N, H);
    expect(planSam(w.game, H, O, plan(w, "H"))).toBe("noThreat");
    // Hydrogen: 5M covers its perceived price.
    w = leaderWorld(5_000_000n);
    setGold(w.p.H, 2_000_000n);
    expect(planSam(w.game, w.p.H, O, plan(w, "H"))).toBe("hydro");
    // Short of gold.
    w = leaderWorld(1_000_000n);
    w.p.H.buildUnit(UnitType.City, w.game.ref(160, 60), {});
    setGold(w.p.H, 1_000_000n);
    expect(planSam(w.game, w.p.H, O, plan(w, "H"))).toBe("gold");
    // A level-1 city (< samMinLevels) and gold for the SAM only.
    setGold(w.p.H, 1_600_000n);
    expect(planSam(w.game, w.p.H, O, plan(w, "H"))).toBe("small");
    // With gold for the next city too, a hub to fill.
    setGold(w.p.H, 3_000_000n);
    expect(typeof planSam(w.game, w.p.H, O, plan(w, "H"))).toBe("object");
    // samMax.
    samAt(w, w.p.H, 185, 112);
    expect(planSam(w.game, w.p.H, O, plan(w, "H"))).toBe("max");
  });

  it("samSlotGate: no SAM while the threat could salvo it at once (two slots and gold for two atoms)", () => {
    const w = leaderWorld(1_600_000n, 2);
    const { H } = w.p;
    const c = H.buildUnit(UnitType.City, w.game.ref(160, 60), {});
    c.increaseLevel();
    c.increaseLevel();
    tick(w, w.config.SiloCooldown() + 1);
    setGold(H, 2_000_000n);
    const p = plan(w, "H");
    expect(p.threats[0].slots).toBe(2);
    expect(planSam(w.game, H, O, p)).toBe("salvo");
    // The lifetime gate (samHorizon) refuses it on its own: the salvo line
    // of a two-slot nation is two atoms, 1.5M.
    expect(planSam(w.game, H, { ...O, samSlotGate: false }, p)).toBe("salvo");
    expect(
      typeof planSam(
        w.game,
        H,
        { ...O, samSlotGate: false, samHorizon: -1 },
        p,
      ),
    ).toBe("object");
  });
});

describe("B3 round 2: the SAM's lifetime (samHorizon, hubDoom, samRebuild)", () => {
  // nukePayShare 0.8: the hydrogen share (4M) stays above the 2.5M salvo
  // line of these worlds, so the salvo rule is what refuses.
  const O2: ApexOptions = { ...O, nukePayShare: 0.8 };

  /** leaderWorld with a finished SAM of ours at (160, 60) and a level-3
   *  city in its covered ring. */
  function hubWorld(gold: bigint): { w: World; sam: TileRef } {
    const w = leaderWorld(gold, 1, true);
    const { H } = w.p;
    const sam = samAt(w, H, 160, 60).tile();
    const city = H.buildUnit(UnitType.City, w.game.ref(160, 95), {});
    city.increaseLevel();
    city.increaseLevel();
    tick(w);
    return { w, sam };
  }

  it("one launch slot and 2.5M: the nation upgrades its silo, then salvoes the hub; the model's salvo line is exactly that gold", () => {
    const { w, sam } = hubWorld(2_500_000n);
    const { N, H } = w.p;
    const p = plan(w, "H", O2);
    expect(hubLevels(w.game, H)).toBe(1);
    expect(p.model.salvoLine(N.id(), 1)).toBe(2_500_000n);
    expect(samKiller(w.game, p, O2, 1, 0)).toMatchObject({
      why: "salvo",
      gold: 2_500_000n,
      line: 2_500_000n,
    });
    // At the default nukePayShare (0.5) the same gold is also half a
    // hydrogen bomb, which the killer test reads first.
    expect(samKiller(w.game, plan(w, "H"), O, 1, 0)?.why).toBe("hydro");
    // The real nation: no aim point at the covered city, one slot short.
    const nuke = brain(w, "N", false);
    expect(nuke.findBestNukeTarget()).toBe(H);
    nuke.maybeSendNuke();
    expect(w.nukes).toHaveLength(0);
    expect(w.upgrades).toEqual([N]);
    tick(w);
    const silo = N.units(UnitType.MissileSilo)[0];
    expect(silo.level()).toBe(2);
    expect(N.gold()).toBe(1_500_000n);
    // The new slot reloads (UnitImpl.increaseLevel queues it), then the
    // salvo: two atoms at the SAM, all the gold left.
    tick(w, w.config.SiloCooldown() + 1);
    w.dryRun = true;
    nuke.maybeSendNuke();
    expect(w.nukes.map((n) => [n.type, n.dst])).toEqual([
      [UnitType.AtomBomb, sam],
      [UnitType.AtomBomb, sam],
    ]);
  });

  it("one gold short of the line: the nation upgrades but cannot fire, and the model finds no killer", () => {
    const { w } = hubWorld(2_499_999n);
    const { N } = w.p;
    const p = plan(w, "H", O2);
    expect(samKiller(w.game, p, O2, 1, 0)).toBe(null);
    const nuke = brain(w, "N", false);
    nuke.maybeSendNuke();
    expect(w.upgrades).toEqual([N]);
    tick(w, w.config.SiloCooldown() + 2);
    w.dryRun = true;
    nuke.maybeSendNuke();
    expect(w.nukes).toHaveLength(0);
  });

  it("the order gate counts latent threats and silo upgrades (round 1 checked current threats' ready slots only)", () => {
    const w = leaderWorld(2_500_000n, 1, true);
    const { N, H, B } = w.p;
    const city = H.buildUnit(UnitType.City, w.game.ref(160, 60), {});
    city.increaseLevel();
    city.increaseLevel();
    setGold(H, 2_000_000n);
    // Current, one ready slot: round 1 let the SAM through (the city is
    // nukeable, so no one-bomb salvo at a SAM under construction).
    expect(planSam(w.game, H, O2, plan(w, "H", O2))).toBe("salvo");
    const r1 = { ...O2, samHorizon: -1 };
    expect(typeof planSam(w.game, H, r1, plan(w, "H", r1))).toBe("object");
    // Latent: B's attack hides N's crown rung.
    attack(B, N, 5000);
    const p = plan(w, "H", O2);
    expect(p.threats.map((t) => [t.nation, t.latent])).toEqual([[N, true]]);
    expect(planSam(w.game, H, O2, p)).toBe("salvo");
    expect(typeof planSam(w.game, H, r1, plan(w, "H", r1))).toBe("object");
  });

  it("with samHorizon > 0 the order gate reads income: 1.5M rising 500k a 100 ticks reaches the 2.5M line", () => {
    const w = leaderWorld(1_000_000n, 1, true);
    const { N, H } = w.p;
    const city = H.buildUnit(UnitType.City, w.game.ref(160, 60), {});
    city.increaseLevel();
    city.increaseLevel();
    setGold(H, 2_000_000n);
    const m = model(w, "H");
    const at = () => ({ model: m, threats: nukeThreats(w.game, H, m, O2) });
    at();
    tick(w, 100);
    setGold(N, 1_500_000n);
    // 1.5M + 500k x 300 / 100 = 3M: past the 2.5M line.
    expect(planSam(w.game, H, { ...O2, samHorizon: 300 }, at())).toBe("salvo");
    // 600 ticks: 4.5M, past the hydrogen share too (0.8 x 5M).
    expect(planSam(w.game, H, { ...O2, samHorizon: 600 }, at())).toBe("hydro");
    // 1.5M + 500k x 50 / 100 = 1.75M: short; so is the gold now (the
    // default, samHorizon 0).
    expect(typeof planSam(w.game, H, { ...O2, samHorizon: 50 }, at())).toBe(
      "object",
    );
    expect(typeof planSam(w.game, H, O2, at())).toBe("object");
  });

  it("a hydrogen bomb at anyone, or a salvo at our SAM, within nukeMemory refuses the next SAM; samRebuild ignores the salvo", () => {
    const w = leaderWorld(1_000_000n, 5, true);
    const { N, H } = w.p;
    const city = H.buildUnit(UnitType.City, w.game.ref(160, 95), {});
    city.increaseLevel();
    city.increaseLevel();
    const sam = samAt(w, H, 160, 60);
    tick(w);
    const m = model(w, "H");
    const at = (o: ApexOptions) => ({
      model: m,
      threats: nukeThreats(w.game, H, m, o),
    });
    const nuke = brain(w, "N", false);
    setGold(N, 6_000_000n);
    nuke.sendNuke(sam.tile(), UnitType.AtomBomb, H);
    tick(w, 2);
    m.observe();
    // The SAM is gone (the salvo, say); 1M left: no killer by gold.
    sam.delete(false);
    setGold(N, 1_000_000n);
    setGold(H, 3_000_000n);
    expect(samKiller(w.game, at(O2), O2, 1, O2.samHorizon)).toMatchObject({
      why: "salvoed",
    });
    expect(planSam(w.game, H, O2, at(O2))).toBe("salvoed");
    const rebuild = { ...O2, samRebuild: true };
    expect(typeof planSam(w.game, H, rebuild, at(rebuild))).toBe("object");
    tick(w, O2.nukeMemory + 1);
    expect(typeof planSam(w.game, H, O2, at(O2))).toBe("object");
    // A hydrogen bomb, even at someone else: "hydro" for nukeMemory ticks,
    // and the threats' bombs carry it.
    setGold(N, 6_000_000n);
    nuke.sendNuke(w.game.ref(10, 10), UnitType.HydrogenBomb, w.p.B);
    tick(w, 2);
    m.observe();
    setGold(N, 1_000_000n);
    const q = at(O2);
    expect(q.threats[0].bombs).toContain(UnitType.HydrogenBomb);
    expect(planSam(w.game, H, O2, q)).toBe("hydro");
  });

  it("a doomed hub gets no more levels, and our SAM exempts no site from exposedSite", () => {
    const { w } = hubWorld(1_000_000n);
    const { H } = w.p;
    setGold(H, 2_000_000n);
    const p = plan(w, "H", O2);
    // Not doomed: a new city in the ring (the level-3 one is at
    // cityMaxLevel), where no threat can aim.
    const act = planCity(w.game, H, O2, p);
    if (typeof act === "string" || act.kind !== "build") {
      throw new Error(`no build: ${JSON.stringify(act)}`);
    }
    expect(inHub(w.game, H, act.tile)).toBe(true);
    const doomed = { ...p, doomed: true };
    expect(planCity(w.game, H, O2, doomed)).toBe("exposed");
    // exposedSite: the SAM covers (160, 95) unless ignored.
    const site = w.game.ref(160, 95);
    expect(exposedSite(w.game, H, site, true)).toBe(false);
    expect(exposedSite(w.game, H, site, true, true)).toBe(true);
  });

  it("the live policy dooms its hub once the shooter reaches the salvo line: logged, and no city intent follows", () => {
    const { w } = hubWorld(1_000_000n);
    const { N, H } = w.p;
    setGold(H, 6_000_000n);
    const before = live(w, "H", O2, 60);
    expect(before.sent.some((s) => s.intent.type === "upgrade_structure")).toBe(
      true,
    );
    expect(before.logs.some((l) => l.includes("hub doomed"))).toBe(false);
    setGold(N, 2_500_000n);
    setGold(H, 6_000_000n);
    const after = live(w, "H", O2, 120);
    expect(after.logs.some((l) => l.includes("hub doomed: N:salvo"))).toBe(
      true,
    );
    expect(
      after.sent.filter(
        (s) =>
          s.intent.type === "upgrade_structure" ||
          (s.intent.type === "build_unit" && s.intent.unit === UnitType.City),
      ),
    ).toEqual([]);
  });
});

/** Runs the live policy on `key` for `ticks` ticks, intents through the
 *  Executor as ctx.send delivers them (latency 1). */
function live(w: World, key: string, o: ApexOptions, ticks: number) {
  const me = w.p[key];
  const policy = new ApexPolicy(o, createState());
  const exec = new Executor(w.game, GAME_ID, undefined);
  const sent: { tick: number; intent: AgentIntent }[] = [];
  const logs: string[] = [];
  const random = new PseudoRandom(1);
  for (let i = 0; i < ticks; i++) {
    const pending: AgentIntent[] = [];
    const ctx: AgentContext = {
      game: w.game,
      clientID: me.clientID()!,
      gameID: GAME_ID,
      me,
      tick: w.game.ticks(),
      random,
      send: (intent) => {
        pending.push(intent);
        sent.push({ tick: w.game.ticks(), intent });
        return "ok";
      },
      budget: () => ({ perSecond: 10, perMinute: 150 }),
      fork: () => {
        throw new Error("no forks here");
      },
      log: (m) => logs.push(m),
    };
    policy.tick(ctx);
    for (const intent of pending) {
      w.game.addExecution(
        exec.createExec({ ...intent, clientID: me.clientID()! }),
      );
    }
    w.game.executeNextTick();
  }
  return { sent, logs };
}

describe("B3 the live policy", () => {
  it("under a runner-up threat: a SAM first, then cities only in its covered ring; the nation never aims at them", () => {
    const w = leaderWorld(1_000_000n, 1, true);
    const { N, H } = w.p;
    const city = H.buildUnit(UnitType.City, w.game.ref(160, 60), {});
    city.increaseLevel();
    city.increaseLevel();
    setGold(H, 6_000_000n);
    const sam = w.config.unitInfo(UnitType.SAMLauncher);
    const { sent, logs } = live(w, "H", O, 400);
    const builds = sent.filter((s) => s.intent.type === "build_unit");
    expect(builds.length).toBeGreaterThanOrEqual(2);
    const first = builds[0].intent;
    expect(first).toMatchObject({ unit: UnitType.SAMLauncher });
    expect(logs.some((l) => l.includes("sam build"))).toBe(true);
    const sams = H.units(UnitType.SAMLauncher);
    expect(sams).toHaveLength(1);
    expect(sams[0].isUnderConstruction()).toBe(false);
    // Every new city is in the ring, built after the SAM finished
    // (constructionDuration + 2 ticks after its intent).
    const duration = sam.constructionDuration!;
    const ring = hubRing(w.game);
    for (const b of builds.slice(1)) {
      if (b.intent.type !== "build_unit") continue;
      expect(b.intent.unit).toBe(UnitType.City);
      expect(b.tick).toBeGreaterThanOrEqual(builds[0].tick + duration + 2);
      const d = dist(w, b.intent.tile, sams[0].tile());
      expect(d).toBeGreaterThanOrEqual(ring.min);
      expect(d).toBeLessThanOrEqual(ring.max);
    }
    // The nation finds no aim point at any of our cities.
    w.dryRun = true;
    const nuke = brain(w, "N", false);
    expect(nuke.findBestNukeTarget()).toBe(H);
    for (let i = 0; i < 3; i++) nuke.maybeSendNuke();
    expect(w.nukes).toHaveLength(0);
    void N;
  });

  it("with nukeModel off (the default) the policy never builds a SAM", () => {
    const w = leaderWorld(1_000_000n);
    const { H } = w.p;
    H.buildUnit(UnitType.City, w.game.ref(160, 60), {});
    setGold(H, 6_000_000n);
    const { sent } = live(w, "H", { ...O, nukeModel: false }, 200);
    expect(
      sent.some(
        (s) =>
          s.intent.type === "build_unit" &&
          s.intent.unit === UnitType.SAMLauncher,
      ),
    ).toBe(false);
  });
});
