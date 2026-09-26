import { AgentContext, AgentIntent } from "../../../src/agent/Agent";
import {
  exposedSite,
  hubRing,
  hubSites,
  NukePlan,
  nukeThreats,
  planCity,
  planSam,
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
    let p = plan(w, "H");
    expect(p.threats).toHaveLength(1);
    // (toBe, not inside toMatchObject: its subset walk descends into the
    // whole Player graph.)
    expect(p.threats[0].nation).toBe(w.p.N);
    expect(p.threats[0]).toMatchObject({
      bomb: UnitType.AtomBomb,
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
  it("a threat blocks a nukeable site; a silo owner aiming elsewhere does not, where exposedSite blocks", () => {
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
    const act = planCity(w.game, w.p.H, O, p);
    expect(typeof act).not.toBe("string");
    expect(exposedSite(w.game, w.p.H, w.game.ref(260, 60), true)).toBe(true);
    expect(planCity(w.game, w.p.H, { ...O, nukeModel: false })).toBe("exposed");
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
    // Without threats the usual order upgrades the other one.
    const free = planCity(w.game, H, O, { model: p.model, threats: [] });
    if (typeof free === "string") throw new Error(`no action: ${free}`);
    expect(free).toMatchObject({ kind: "upgrade", unitId: outside.id() });
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
    expect(typeof planSam(w.game, H, { ...O, samSlotGate: false }, p)).toBe(
      "object",
    );
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
