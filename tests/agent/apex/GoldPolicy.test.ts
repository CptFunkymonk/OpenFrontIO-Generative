import { AgentIntent } from "../../../src/agent/Agent";
import {
  CityAction,
  planCity,
} from "../../../src/agent/agents/apex/controllers/EconomyController";
import {
  APEX_DEFAULTS,
  ApexOptions,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import { ApexPolicy } from "../../../src/agent/agents/apex/policy";
import { createState } from "../../../src/agent/agents/apex/state";
import {
  cityGate,
  densityLine,
  firingThreats,
  GOLD_POLICIES,
  GoldPolicyArm,
  hydroRoom,
  steamrollLine,
  unalliedArmed,
} from "../../../src/agent/lib/GoldPolicy";
import { createModels } from "../../../src/agent/lib/Models";
import { NationModel } from "../../../src/agent/lib/NationModel";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import {
  Cell,
  Game,
  Nation,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import { addTribe, Field, field, Harness, own, rect } from "./Field";
import {
  ally,
  brain,
  columns,
  GAME_ID,
  model,
  pastImmunity,
  setGold,
  siloAt,
  tick,
  World,
  world,
} from "./NukeWorld";

// Package WP8 (docs/14-m4-plan.md §2.8 items 1-2; lib/GoldPolicy.ts): the
// gold arms that decide when idle gold buys City levels, through the gate
// EconomyController.planCity takes. Synthetic plains fields
// (tests/agent/apex/Field.ts, NukeWorld.ts); the tests hand out gold, land
// and structures directly (agents never may). The rule the arms rely on is
// pinned by tests/agent/mechanics/NukeStructures.test.ts.

/** Only the economy runs. */
const ECONOMY_ONLY: ApexOptions = parseApexOptions({
  expansion: false,
  defense: false,
  diplomacy: false,
  strike: false,
  endgame: false,
  boats: false,
});

/** The economy with gold arm `goldPolicy`, from tick 0. */
function arm(
  goldPolicy: GoldPolicyArm,
  extra: Partial<ApexOptions> = {},
): ApexOptions {
  return { ...ECONOMY_ONLY, goldPolicy, goldFrom: 0, ...extra };
}

const RESERVE = BigInt(APEX_DEFAULTS.goldReserve);

const price = (game: Game, p: Player, t: UnitType) =>
  game.config().unitInfo(t).cost(game, p);

/** The check's plan under `o`'s gate at the game's tick. */
function plan(game: Game, me: Player, o: ApexOptions) {
  const gate = cityGate(game, me, o, game.ticks()) ?? undefined;
  return planCity(game, me, o, undefined, gate);
}

/**
 * Us on [0, 100) × [0, 80), a nation on [110, 140) × [0, 80) with a
 * finished silo and the gold for an atom bomb (the "exposure" rule refuses
 * every site), and a tribe in the far corner, so three players live (with
 * two, even an ally aims at us).
 */
async function armedWorld(): Promise<{ f: Field; nation: Player }> {
  const f = await field({ width: 160, height: 80 });
  const { game, me } = f;
  own(me, rect(game, 0, 0, 100, 80));
  const nation = game.addPlayer(
    new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
  );
  own(nation, rect(game, 110, 0, 140, 80));
  addTribe(f, "TRIBE001", rect(game, 150, 70, 160, 80), 1000, false);
  nation.buildUnit(UnitType.MissileSilo, game.ref(125, 40), {});
  setGold(nation, price(game, nation, UnitType.AtomBomb));
  return { f, nation };
}

describe("apex gold policy (WP8): options", () => {
  test('the defaults: "exposure" from minute 4, a 1.5M reserve, the guard on', () => {
    expect(APEX_DEFAULTS.goldPolicy).toBe("exposure");
    expect(APEX_DEFAULTS.goldFrom).toBe(2400);
    expect(APEX_DEFAULTS.goldReserve).toBe(1_500_000);
    expect(APEX_DEFAULTS.goldGuard).toBe(true);
    for (const a of GOLD_POLICIES) {
      expect(parseApexOptions({ goldPolicy: a }).goldPolicy).toBe(a);
    }
    expect(() => parseApexOptions({ goldPolicy: "never" })).toThrow(
      /goldPolicy/,
    );
  });

  test('"exposure", and every arm before goldFrom, is today\'s rule: no gate', async () => {
    const { f } = await armedWorld();
    const { game, me } = f;
    setGold(me, 10_000_000n);
    const t = game.ticks();
    expect(cityGate(game, me, arm("exposure"), t)).toBeNull();
    for (const a of ["model", "allied", "free"] as const) {
      expect(cityGate(game, me, arm(a, { goldFrom: t + 1 }), t)).toBeNull();
    }
    expect(cityGate(game, me, arm("free", { goldFrom: t }), t)).not.toBeNull();
    // "model" without a model: today's rule too.
    expect(cityGate(game, me, arm("model"), t)).toBeNull();
    // Today's rule refuses every site here.
    expect(plan(game, me, arm("exposure"))).toBe("exposed");
    expect(planCity(game, me, arm("free"))).toBe("exposed");
  });
});

describe('apex gold policy (WP8): "free"', () => {
  test("builds while an unallied nation is armed, from the gold above goldReserve only", async () => {
    const { f } = await armedWorld();
    const { game, me } = f;
    const city = price(game, me, UnitType.City);
    setGold(me, RESERVE + city - 1n);
    expect(plan(game, me, arm("free"))).toBe("gold");
    setGold(me, RESERVE + city);
    const p = plan(game, me, arm("free"));
    expect(p).toMatchObject({ kind: "build", cost: city });
    // Without a reserve the same gold buys it too.
    setGold(me, city);
    expect(plan(game, me, arm("free", { goldReserve: 0 }))).toMatchObject({
      kind: "build",
    });
  });

  test("upgrades first, as many levels as the budget covers, up to cityMaxLevel", async () => {
    const { f } = await armedWorld();
    const { game, me } = f;
    me.buildUnit(UnitType.City, game.ref(50, 40), {});
    // The next two levels cost 250k and 500k (the ladder, EconomyGold).
    setGold(me, RESERVE + 750_000n);
    const up = plan(game, me, arm("free")) as CityAction;
    expect(up).toMatchObject({ kind: "upgrade", amount: 2, cost: 750_000n });
    setGold(me, RESERVE + 749_999n);
    expect(plan(game, me, arm("free"))).toMatchObject({
      kind: "upgrade",
      amount: 1,
    });
    // At cityMaxLevel (3) the next buy is a new city.
    const c = me.units(UnitType.City)[0];
    c.increaseLevel();
    c.increaseLevel();
    setGold(me, 10_000_000n);
    expect(plan(game, me, arm("free"))).toMatchObject({ kind: "build" });
  });
});

describe('apex gold policy (WP8): "allied"', () => {
  test("refuses while an unallied nation has a finished silo and atom gold, builds once it is our ally", async () => {
    const { f, nation } = await armedWorld();
    const { game, me } = f;
    setGold(me, 10_000_000n);
    const gate = cityGate(game, me, arm("allied"), game.ticks())!;
    expect(gate.blockers).toEqual(["nation"]);
    expect(plan(game, me, arm("allied"))).toBe("exposed");
    // Short of the atom by one: no threat.
    setGold(nation, price(game, nation, UnitType.AtomBomb) - 1n);
    expect(plan(game, me, arm("allied"))).toMatchObject({ kind: "build" });
    setGold(nation, 10_000_000n);
    ally(nation, me);
    expect(unalliedArmed(game, me)).toEqual([]);
    expect(plan(game, me, arm("allied"))).toMatchObject({ kind: "build" });
  });

  test("with two players left an ally counts (it aims at us then)", async () => {
    const f = await field({ width: 160, height: 80 });
    const { game, me } = f;
    own(me, rect(game, 0, 0, 100, 80));
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
    );
    own(nation, rect(game, 110, 0, 140, 80));
    nation.buildUnit(UnitType.MissileSilo, game.ref(125, 40), {});
    setGold(nation, 10_000_000n);
    ally(nation, me);
    expect(game.players()).toHaveLength(2);
    expect(unalliedArmed(game, me)).toEqual([nation]);
    setGold(me, 10_000_000n);
    expect(plan(game, me, arm("allied"))).toBe("exposed");
  });

  test("silo owners count, a silo under construction too; gold for a silo and a bomb without one does not (unlike exposedSite's wide rule)", async () => {
    const f = await field({ width: 160, height: 80 });
    const { game, me } = f;
    own(me, rect(game, 0, 0, 100, 80));
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
    );
    own(nation, rect(game, 110, 0, 140, 80));
    addTribe(f, "TRIBE001", rect(game, 150, 70, 160, 80), 1000, false);
    const bomb = price(game, nation, UnitType.AtomBomb);
    const silo = price(game, nation, UnitType.MissileSilo);
    setGold(nation, bomb + silo);
    setGold(me, 10_000_000n);
    expect(unalliedArmed(game, me)).toEqual([]);
    expect(plan(game, me, arm("allied"))).toMatchObject({ kind: "build" });
    // Today's rule (exposureWide) refuses it.
    expect(plan(game, me, arm("exposure"))).toBe("exposed");
    const s = nation.buildUnit(UnitType.MissileSilo, game.ref(125, 40), {});
    s.setUnderConstruction(true);
    setGold(nation, bomb);
    expect(unalliedArmed(game, me)).toEqual([nation]);
    expect(plan(game, me, arm("allied"))).toBe("exposed");
  });

  test("a finished SAM of ours lifts the refusal at the sites it covers", async () => {
    const { f } = await armedWorld();
    const { game, me } = f;
    const sam = me.buildUnit(UnitType.SAMLauncher, game.ref(50, 40), {});
    setGold(me, 10_000_000n);
    const p = plan(game, me, arm("allied"));
    expect(p).toMatchObject({ kind: "build" });
    if (typeof p === "string" || p.kind !== "build") return;
    const r = game.config().samRange(sam.level());
    expect(game.euclideanDistSquared(sam.tile(), p.tile)).toBeLessThanOrEqual(
      r * r,
    );
    // Under construction it covers nothing.
    sam.setUnderConstruction(true);
    expect(plan(game, me, arm("allied"))).toBe("exposed");
  });
});

/** NukeWorld: the nation N on x < 60, Z on 60-119, us (H) on the rest, H
 *  more than half the land (N's crown50 rung names H); N owns a finished
 *  silo, past spawn immunity. */
function crownWorld(): World {
  const w = world(
    300,
    200,
    { N: PlayerType.Nation, H: PlayerType.Human, Z: PlayerType.Human },
    columns([
      ["N", 60],
      ["Z", 60],
      ["H", 180],
    ]),
  );
  siloAt(w, w.p.N, 20, 100);
  pastImmunity(w);
  return w;
}

describe('apex gold policy (WP8): "model"', () => {
  test("refuses a site a firing nation can aim at; a latent ladder, an ally or a nation short of bomb gold does not", () => {
    const w = crownWorld();
    const { game } = w;
    const { N, H, Z } = w.p;
    const nukes = model(w, "H");
    const o = arm("model");
    const planned = () =>
      planCity(
        game,
        H,
        o,
        undefined,
        cityGate(game, H, o, game.ticks(), nukes) ?? undefined,
      );
    setGold(H, 10_000_000n);
    setGold(N, price(game, N, UnitType.AtomBomb));
    expect(firingThreats(game, nukes).map((t) => [t.nation, t.bomb])).toEqual([
      [N, UnitType.AtomBomb],
    ]);
    expect(cityGate(game, H, o, game.ticks(), nukes)!.blockers).toEqual([
      "N:A",
    ]);
    expect(planned()).toBe("exposed");
    // Short of the atom: not firing. (The model caches its exposures per
    // tick, so each change gets a tick.)
    setGold(N, price(game, N, UnitType.AtomBomb) - 1n);
    tick(w);
    expect(firingThreats(game, nukes)).toEqual([]);
    expect(planned()).toMatchObject({ kind: "build" });
    // Z attacks N: the retaliation rung answers first and H is latent.
    setGold(N, price(game, N, UnitType.AtomBomb));
    const hit = Z.createAttack(N, 1000, null, new Set<TileRef>());
    tick(w);
    expect(nukes.aimOf(N.id()).target).toBe(Z.id());
    expect(firingThreats(game, nukes)).toEqual([]);
    expect(planned()).toMatchObject({ kind: "build" });
    // Allied (the attack gone): the ladder names no one.
    hit.delete();
    ally(N, H);
    tick(w);
    expect(nukes.aimOf(N.id()).target).toBeNull();
    expect(firingThreats(game, nukes)).toEqual([]);
    expect(planned()).toMatchObject({ kind: "build" });
  });
});

describe('apex gold policy (WP8): "model" in a rollout', () => {
  test("the gate reads the model's memory (launch counts behind the perceived prices), and a rollout's clone (NukeModel.cloneFor) carries it", () => {
    const w = crownWorld();
    const { game } = w;
    const { N, H } = w.p;
    const live = model(w, "H");
    // N fires one atom (at bare land of ours): its perceived atom price
    // rises to 1.5x (NNB :814-818), which the live model counts.
    setGold(N, 5_000_000n);
    brain(w, "N", false).sendNuke(game.ref(250, 100), UnitType.AtomBomb, H);
    tick(w, 2);
    live.observe();
    expect(live.launched(N.id())).toEqual({ atoms: 1, hydros: 0 });
    // Gold above the real atom price, below the perceived one.
    setGold(N, 1_000_000n);
    setGold(H, 10_000_000n);
    tick(w);
    const copy = live.cloneFor(
      game,
      H,
      new NationModel(game, H, GAME_ID, createModels(game)),
    );
    const cold = model(w, "H");
    const o = arm("model");
    const [a, b, c] = [live, copy, cold].map((m) =>
      planCity(
        game,
        H,
        o,
        undefined,
        cityGate(game, H, o, game.ticks(), m) ?? undefined,
      ),
    );
    // The live model knows N cannot pay its perceived price: not firing.
    expect(a).toMatchObject({ kind: "build" });
    expect(b).toEqual(a);
    // A model that missed the launch thinks N fires.
    expect(c).toBe("exposed");
  });
});

/** The MIRV and nuke behaviours of nation `key`, wired by the real
 *  NationExecution.initializeBehaviors (private members through casts). */
function brains(w: World, key: string) {
  const exec = new NationExecution(
    GAME_ID,
    new Nation(new Cell(0, 0), w.p[key].info()),
  );
  exec.init(w.game);
  const x = exec as unknown as {
    initializeBehaviors(): void;
    mirvBehavior: { selectSteamrollStopTarget(): Player | null };
    nukeBehavior: { findHighDensityTarget(): Player | null };
  };
  x.initializeBehaviors();
  return { mirv: x.mirvBehavior, nuke: x.nukeBehavior };
}

/** Gives `p` `n` cities of one level each, 12 tiles apart in rows of 5
 *  from (x0, 20). */
function cities(w: World, p: Player, n: number, x0: number): void {
  for (let i = 0; i < n; i++) {
    p.buildUnit(
      UnitType.City,
      w.game.ref(x0 + 12 * (i % 5), 20 + 12 * Math.floor(i / 5)),
      {},
    );
  }
}

describe("apex gold policy (WP8): the guard's lines are the nations' own", () => {
  test("steamrollLine: the most City levels short of the MIRV steamroll rung (> 8 and >= 1.15x the runner-up)", () => {
    for (const runner of [0, 7, 10, 20]) {
      const w = crownWorld();
      const { N, H } = w.p;
      cities(w, N, runner, 5);
      const line = steamrollLine(w.game, H);
      expect(line).toBe(Math.max(8, Math.ceil(runner * 1.15) - 1));
      const { mirv } = brains(w, "N");
      // At the line the rung passes us over; one level more and it names us.
      cities(w, H, line, 130);
      expect(mirv.selectSteamrollStopTarget()).toBeNull();
      cities(w, H, 1, 250);
      expect(mirv.selectSteamrollStopTarget()).toBe(H);
    }
  });

  test("densityLine: the most City levels short of the dense-target rung (> 1/75 structure levels a tile, >= 5)", () => {
    const w = world(
      200,
      100,
      { N: PlayerType.Nation, H: PlayerType.Human, Z: PlayerType.Human },
      (x, y) => (x < 60 ? "N" : x < 120 ? "Z" : y < 25 && x < 160 ? "H" : null),
    );
    const { N, H } = w.p;
    expect(H.numTilesOwned()).toBe(1000);
    // 1,000 tiles: 13 levels (13/1000 <= 1/75 < 14/1000).
    expect(densityLine(H)).toBe(13);
    // Other structures count too: a SAM and a defense post leave 11.
    H.buildUnit(UnitType.SAMLauncher, w.game.ref(125, 5), {});
    H.buildUnit(UnitType.DefensePost, w.game.ref(155, 20), {});
    expect(densityLine(H)).toBe(11);
    setGold(N, 1_000_000_000n); // the richest nation
    const { nuke } = brains(w, "N");
    for (let i = 0; i < 11; i++) {
      H.buildUnit(
        UnitType.City,
        w.game.ref(121 + 3 * (i % 12), 2 + 3 * Math.floor(i / 12)),
        {},
      );
    }
    expect(nuke.findHighDensityTarget()).toBeNull();
    H.buildUnit(UnitType.City, w.game.ref(157, 12), {});
    expect(nuke.findHighDensityTarget()).toBe(H);
  });

  test("planCity holds the line: no build at it, and an upgrade's levels capped to it", async () => {
    const { f } = await armedWorld();
    const { game, me } = f;
    setGold(me, 100_000_000n);
    // No other player holds a city: the line is 8.
    const c = me.buildUnit(UnitType.City, game.ref(50, 40), {});
    const gate = cityGate(game, me, arm("free"), game.ticks())!;
    expect(gate.maxLevels).toBe(8);
    // Two more cities at cityMaxLevel (3), so c (level 1) is the one to
    // upgrade, with room for 2 levels under the cap.
    for (const [x, y] of [
      [15, 15],
      [85, 65],
    ]) {
      const u = me.buildUnit(UnitType.City, game.ref(x, y), {});
      u.increaseLevel();
      u.increaseLevel();
    }
    // 7 levels: one to the line, so the upgrade buys 1, not 2.
    expect(me.unitCount(UnitType.City)).toBe(7);
    expect(plan(game, me, arm("free"))).toMatchObject({
      kind: "upgrade",
      unitId: c.id(),
      amount: 1,
    });
    c.increaseLevel();
    expect(plan(game, me, arm("free"))).toBe("guard");
    expect(plan(game, me, arm("free", { goldGuard: false }))).toMatchObject({
      kind: "upgrade",
    });
  });
});

describe("apex gold policy (WP8): goldHydroCap", () => {
  test("hydroRoom counts our other cities closer than twice a hydrogen bomb's outer radius (200 tiles), levels and cities under construction alike", () => {
    const w = world(
      500,
      100,
      { N: PlayerType.Nation, H: PlayerType.Human, Z: PlayerType.Human },
      columns([
        ["N", 30],
        ["Z", 20],
        ["H", 450],
      ]),
    );
    const { H } = w.p;
    const r = w.config.nukeMagnitudes(UnitType.HydrogenBomb).outer;
    expect(2 * r).toBe(200);
    const a = H.buildUnit(UnitType.City, w.game.ref(60, 50), {});
    a.increaseLevel();
    const b = H.buildUnit(UnitType.City, w.game.ref(160, 50), {});
    b.setUnderConstruction(true);
    const at = (x: number) => hydroRoom(w.game, H, w.game.ref(x, 50), 6);
    // 199 tiles from a (2 levels) and 99 from b (1): 3 of the 6 taken.
    expect(at(259)).toBe(3);
    // Exactly 200 from a: one bomb cannot hold both strictly inside.
    expect(at(260)).toBe(5);
    // A city's own levels are not its neighbours'.
    expect(hydroRoom(w.game, H, a.tile(), 6, a)).toBe(5);
  });

  test("planCity builds and upgrades only up to the cap within one hydrogen bomb's reach", async () => {
    const { f } = await armedWorld();
    const { game, me } = f;
    setGold(me, 100_000_000n);
    // Our land is 100 x 80: every site is within 200 of every other.
    const a = me.buildUnit(UnitType.City, game.ref(20, 40), {});
    a.increaseLevel();
    a.increaseLevel();
    const o = arm("free", { goldHydroCap: 4 });
    // a is at cityMaxLevel: the buy is a new city, room 4 - 3 = 1.
    const p = plan(game, me, o);
    expect(p).toMatchObject({ kind: "build" });
    if (typeof p === "string" || p.kind !== "build") return;
    const b = me.buildUnit(UnitType.City, p.tile, {});
    // b's room is 4 - 3 = 1: no upgrade; no other site either.
    expect(plan(game, me, o)).toBe("exposed");
    // Off (0), the arm upgrades b.
    expect(plan(game, me, arm("free"))).toMatchObject({
      kind: "upgrade",
      unitId: b.id(),
    });
    // Room 5: b goes to level 2, one level, not 2 (cityMaxLevel 3).
    expect(plan(game, me, arm("free", { goldHydroCap: 5 }))).toMatchObject({
      kind: "upgrade",
      unitId: b.id(),
      amount: 1,
    });
  });
});

describe("apex gold policy (WP8): the live policy", () => {
  /** City intents the policy sends in `steps` turns. */
  function cityIntents(f: Field, o: ApexOptions, steps: number) {
    const policy = new ApexPolicy(o, createState());
    const h = new Harness(f, (ctx) => policy.tick(ctx));
    const out: { tick: number; intent: AgentIntent }[] = [];
    for (let i = 0; i < steps; i++) {
      const at = f.game.ticks();
      for (const intent of h.step()) {
        const city =
          (intent.type === "build_unit" ||
            intent.type === "upgrade_structure") &&
          intent.unit === UnitType.City;
        if (city) out.push({ tick: at, intent });
      }
    }
    return { out, logs: h.logs };
  }

  test('by default ("exposure") no city while the nation is armed; "free" builds from goldFrom on, not before', async () => {
    const { f } = await armedWorld();
    setGold(f.me, 10_000_000n);
    expect(cityIntents(f, ECONOMY_ONLY, 120).out).toEqual([]);
    const g = await armedWorld();
    setGold(g.f.me, 10_000_000n);
    const from = g.f.game.ticks() + 60;
    const free = cityIntents(g.f, arm("free", { goldFrom: from }), 120);
    expect(free.out.length).toBeGreaterThan(0);
    expect(free.out[0].tick).toBeGreaterThanOrEqual(from);
    expect(free.out[0].intent.type).toBe("build_unit");
    expect(free.logs.some((l) => / city build at .* arm=free$/.test(l))).toBe(
      true,
    );
  });

  test("an arm only adds buys: where today's rule builds, it builds the same, reserve and guard aside", async () => {
    // No armed nation: today's rule builds with all our gold.
    const f = await field({ width: 160, height: 80 });
    own(f.me, rect(f.game, 0, 0, 100, 80));
    addTribe(f, "TRIBE001", rect(f.game, 150, 70, 160, 80), 1000, false);
    const g = await field({ width: 160, height: 80 });
    own(g.me, rect(g.game, 0, 0, 100, 80));
    addTribe(g, "TRIBE001", rect(g.game, 150, 70, 160, 80), 1000, false);
    // 1M: less than the 1.5M reserve, so a gated buy could not pay.
    setGold(f.me, 1_000_000n);
    setGold(g.me, 1_000_000n);
    const today = cityIntents(f, ECONOMY_ONLY, 200).out;
    const free = cityIntents(g, arm("free"), 200).out;
    expect(today.length).toBeGreaterThan(0);
    expect(free).toEqual(today);
  });

  test('"allied" logs the nation it holds gold back for, once a minute', async () => {
    const { f } = await armedWorld();
    setGold(f.me, 10_000_000n);
    const { out, logs } = cityIntents(f, arm("allied"), 700);
    expect(out).toEqual([]);
    const held = logs.filter((l) => / gold allied exposed: \[nation\]/.test(l));
    expect(held.length).toBeGreaterThanOrEqual(1);
    expect(held.length).toBeLessThanOrEqual(2);
  });
});
