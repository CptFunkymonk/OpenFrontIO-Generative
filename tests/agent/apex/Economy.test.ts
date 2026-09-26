import { AgentIntent } from "../../../src/agent/Agent";
import {
  affordableLevels,
  borderDepth,
  CityAction,
  DEPTH_CAP,
  EconomyController,
  exposedSite,
  finishedCityLevels,
  inboundNukeLevels,
  interiorSites,
  planCity,
} from "../../../src/agent/agents/apex/controllers/EconomyController";
import { inStall } from "../../../src/agent/agents/apex/controllers/ExpansionController";
import {
  ApexOptions,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import { ApexPolicy, nukeThreat } from "../../../src/agent/agents/apex/policy";
import { createState } from "../../../src/agent/agents/apex/state";
import { createModels } from "../../../src/agent/lib/Models";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import { addTribe, Field, field, Harness, own, rect, submit } from "./Field";

// Spec §3.8 and §4 step 5 (Economy.test): the EconomyController never
// builds within cityMinDepth of a border; it upgrades before building when
// it can; the cap rises by config.cityTroopIncrease() per finished city
// level. Synthetic plains fields (tests/agent/apex/Field.ts); the test
// hands out gold and land directly (agents never may). Depth is checked by
// brute force: the Manhattan distance to every tile of me.borderTiles().

const D = parseApexOptions().cityMinDepth;

/** Only the economy runs; everything that would spend troops is off. */
const ECONOMY_ONLY: ApexOptions = parseApexOptions({
  expansion: false,
  defense: false,
  diplomacy: false,
  strike: false,
  endgame: false,
  boats: false,
});
/** The spec's §3.8 stacking: every level on one site, no level cap. */
const STACKED: ApexOptions = {
  ...ECONOMY_ONLY,
  cityMaxLevel: 0,
  citySpread: false,
};

/** The Manhattan distance from `tile` to our nearest border tile. */
function bruteDepth(game: Game, me: Player, tile: TileRef): number {
  let best = Infinity;
  me.borderTiles().forEach((b) => {
    const d = game.manhattanDist(tile, b);
    if (d < best) best = d;
  });
  return best;
}

const gameHash = (game: Game) => (game as unknown as { hash(): number }).hash();

/** Our land: [x0, x1) × [y0, y1) less the given holes. */
async function territory(
  w: number,
  h: number,
  box: [number, number, number, number],
  holes: [number, number, number, number][] = [],
  terrain?: Parameters<typeof field>[0]["terrain"],
): Promise<Field> {
  const f = await field({ width: w, height: h, terrain });
  const [x0, y0, x1, y1] = box;
  own(
    f.me,
    rect(f.game, x0, y0, x1, y1).filter((t) => f.game.isLand(t)),
  );
  holes.forEach(([a, b, c, d], i) => {
    addTribe(
      f,
      `HOLE${String(i).padStart(4, "0")}`,
      rect(f.game, a, b, c, d),
      1000,
      false,
    );
  });
  return f;
}

/** A random blob: the union of discs, less random other owners. */
async function blob(seed: number): Promise<Field> {
  const W = 110;
  const H = 90;
  const r = new PseudoRandom(seed);
  // A lake in some fields, so water borders count too.
  const lake = seed % 2 === 0;
  const f = await field({
    width: W,
    height: H,
    terrain: (x, y) =>
      lake && (x - 55) ** 2 + (y - 45) ** 2 < 36 ? "lake" : "plains",
  });
  const discs = r.nextInt(2, 6);
  const mine: TileRef[] = [];
  for (let k = 0; k < discs; k++) {
    const cx = r.nextInt(10, W - 10);
    const cy = r.nextInt(10, H - 10);
    const rad = r.nextInt(12, 40);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 < rad * rad) {
          const t = f.game.ref(x, y);
          if (f.game.isLand(t) && !f.me.tiles().has(t)) {
            f.me.conquer(t);
            mine.push(t);
          }
        }
      }
    }
  }
  const holes = r.nextInt(0, 4);
  for (let k = 0; k < holes; k++) {
    const x = r.nextInt(0, W - 6);
    const y = r.nextInt(0, H - 6);
    const s = r.nextInt(2, 6);
    addTribe(
      f,
      `BLOB${seed}${k}`.padEnd(8, "0").slice(0, 8),
      rect(f.game, x, y, x + s, y + s),
      100,
      false,
    );
  }
  return f;
}

/** Runs a planned action through the agent's intent path and `turns`
 *  turns. */
function execute(f: Field, a: CityAction, turns: number): void {
  const intent: AgentIntent =
    a.kind === "upgrade"
      ? {
          type: "upgrade_structure",
          unit: UnitType.City,
          unitId: a.unitId,
          amount: a.amount,
        }
      : { type: "build_unit", unit: UnitType.City, tile: a.tile };
  submit(f, intent);
  for (let i = 0; i < turns; i++) f.game.executeNextTick();
}

describe("apex economy (§3.8): depth", () => {
  test("borderDepth equals the brute-force distance to our border, holes, lake and map edge included", async () => {
    const f = await territory(
      90,
      70,
      [0, 0, 70, 60],
      [
        [30, 20, 38, 28],
        [50, 40, 52, 58],
      ],
      (x, y) => ((x - 15) ** 2 + (y - 45) ** 2 < 25 ? "lake" : "plains"),
    );
    const { game, me } = f;
    let checked = 0;
    me.tiles().forEach((t) => {
      const brute = bruteDepth(game, me, t);
      expect(borderDepth(game, me, t, 1000)).toBe(brute);
      expect(borderDepth(game, me, t, 5)).toBe(Math.min(5, brute));
      checked++;
    });
    expect(checked).toBeGreaterThan(3000);
    // Not ours: -1.
    expect(borderDepth(game, me, game.ref(80, 65), 10)).toBe(-1);
  });

  test("interiorSites: every site is ours, at least cityMinDepth deep, with its exact depth, deepest first", async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const f = await blob(seed);
      const { game, me } = f;
      const sites = interiorSites(game, me, D);
      for (const s of sites) {
        expect(game.ownerID(s.tile)).toBe(me.smallID());
        expect(s.depth).toBe(
          Math.min(DEPTH_CAP * D, bruteDepth(game, me, s.tile)),
        );
        expect(s.depth).toBeGreaterThanOrEqual(D);
      }
      for (let i = 1; i < sites.length; i++) {
        expect(sites[i - 1].depth).toBeGreaterThanOrEqual(sites[i].depth);
      }
      // A roomy territory always yields a site.
      let deepest = 0;
      me.tiles().forEach((t) => {
        deepest = Math.max(deepest, bruteDepth(game, me, t));
      });
      if (deepest >= 2 * D) expect(sites.length).toBeGreaterThan(0);
    }
  });

  test("land that reaches the map edge beyond the border's box is searched too (the edge is no border)", async () => {
    // Our land touches three map edges; the only border is the column
    // x = 109, so the border's box is one column wide.
    const f = await territory(120, 90, [0, 0, 110, 90]);
    const { game, me } = f;
    me.borderTiles().forEach((b) => expect(game.x(b)).toBe(109));
    const sites = interiorSites(game, me, D);
    expect(sites.length).toBeGreaterThan(0);
    expect(sites[0].depth).toBe(DEPTH_CAP * D);
    for (const s of sites) {
      expect(109 - game.x(s.tile)).toBeGreaterThanOrEqual(s.depth);
    }
  });
});

describe("apex economy (§3.8): never builds within cityMinDepth of a border", () => {
  test("on random territories, every build (one after another until no site is left) lands at depth ≥ cityMinDepth", async () => {
    const o = { ...ECONOMY_ONLY, cityUpgradeFirst: false };
    let builds = 0;
    let exhausted = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const f = await blob(seed);
      const { game, me } = f;
      me.addGold(100_000_000n);
      for (let k = 0; k < 30; k++) {
        const before = gameHash(game);
        const plan = planCity(game, me, o);
        expect(gameHash(game)).toBe(before);
        if (typeof plan === "string") {
          expect(plan).toBe("noSite");
          exhausted++;
          break;
        }
        expect(plan.kind).toBe("build");
        if (plan.kind !== "build") break;
        const depth = bruteDepth(game, me, plan.tile);
        expect(depth).toBeGreaterThanOrEqual(D);
        expect(plan.depth).toBe(Math.min(DEPTH_CAP * D, depth));
        // The game builds exactly at the tile asked for.
        expect(me.canBuild(UnitType.City, plan.tile)).toBe(plan.tile);
        const n = me.units(UnitType.City).length;
        execute(f, plan, 2);
        const cities = me.units(UnitType.City);
        expect(cities.length).toBe(n + 1);
        expect(cities[cities.length - 1].tile()).toBe(plan.tile);
        builds++;
      }
    }
    expect(builds).toBeGreaterThan(20);
    expect(exhausted).toBe(12);
  });

  test("a territory thinner than 2·cityMinDepth + 1 gets no city", async () => {
    // 24 rows (10-33): the middle rows are 11 from the far border row.
    const f = await territory(120, 60, [0, 10, 120, 10 + 2 * D]);
    f.me.addGold(10_000_000n);
    expect(planCity(f.game, f.me, ECONOMY_ONLY)).toBe("noSite");
    // Five rows more: rows 12-14 deep in the middle.
    const g = await territory(120, 60, [0, 10, 120, 15 + 2 * D]);
    g.me.addGold(10_000_000n);
    const plan = planCity(g.game, g.me, ECONOMY_ONLY);
    expect(plan).toMatchObject({ kind: "build" });
    if (typeof plan === "object" && plan.kind === "build") {
      expect(bruteDepth(g.game, g.me, plan.tile)).toBeGreaterThanOrEqual(D);
      expect(Math.min(DEPTH_CAP * D, bruteDepth(g.game, g.me, plan.tile))).toBe(
        plan.depth,
      );
    }
  });

  test("a site the game would move is taken as moved, and only if the moved tile is deep enough", async () => {
    // An existing structure blocks a 15-tile disc: the game moves a city
    // asked for inside it to the nearest free tile, which must be deep.
    const f = await territory(110, 110, [0, 0, 100, 100]);
    const { game, me } = f;
    me.buildUnit(UnitType.City, game.ref(50, 50), {});
    me.addGold(10_000_000n);
    const o = { ...ECONOMY_ONLY, cityUpgradeFirst: false };
    for (let k = 0; k < 10; k++) {
      const plan = planCity(game, me, o);
      if (typeof plan === "string") break;
      if (plan.kind !== "build") throw new Error("expected a build");
      expect(bruteDepth(game, me, plan.tile)).toBeGreaterThanOrEqual(D);
      for (const c of me.units(UnitType.City)) {
        expect(
          game.euclideanDistSquared(c.tile(), plan.tile),
        ).toBeGreaterThanOrEqual(game.config().structureMinDist() ** 2);
      }
      execute(f, plan, 2);
    }
    expect(me.units(UnitType.City).length).toBeGreaterThan(3);
  });
});

describe("apex economy (§3.8): upgrades before building", () => {
  async function withCity(level: number) {
    const f = await territory(110, 90, [0, 0, 100, 80]);
    const { game, me } = f;
    const city = me.buildUnit(UnitType.City, game.ref(50, 40), {});
    for (let l = 1; l < level; l++) city.increaseLevel();
    // buildUnit took no gold here (there was none); start from 0.
    expect(me.gold()).toBe(0n);
    return { f, game, me, city };
  }

  test("a finished deep city is upgraded, not a new one built; the gold buys every level it covers in one intent", async () => {
    const { f, game, me, city } = await withCity(1);
    const cost1 = game.config().unitInfo(UnitType.City).cost(game, me);
    me.addGold(cost1);
    const one = planCity(game, me, STACKED);
    expect(one).toMatchObject({
      kind: "upgrade",
      unitId: city.id(),
      amount: 1,
    });
    // Gold for three levels (the next three steps of the ladder).
    const info = game.config().unitInfo(UnitType.City);
    const three =
      info.cost(game, me, 0) + info.cost(game, me, 1) + info.cost(game, me, 2);
    me.addGold(three - cost1);
    expect(affordableLevels(game, me, me.gold())).toEqual({
      amount: 3,
      cost: three,
    });
    // cityMaxLevel (3 by default) stops the one intent at level 3.
    expect(planCity(game, me, ECONOMY_ONLY)).toMatchObject({
      kind: "upgrade",
      unitId: city.id(),
      amount: 2,
    });
    const plan = planCity(game, me, STACKED);
    expect(plan).toMatchObject({
      kind: "upgrade",
      unitId: city.id(),
      amount: 3,
    });
    if (typeof plan === "string") return;
    const cap = game.config().maxTroops(me);
    execute(f, plan, 1);
    expect(city.level()).toBe(4);
    expect(me.gold()).toBe(0n);
    expect(game.config().maxTroops(me) - cap).toBe(
      3 * game.config().cityTroopIncrease(),
    );
  });

  test("with cityUpgradeFirst off, it builds instead", async () => {
    const { game, me } = await withCity(1);
    me.addGold(10_000_000n);
    const plan = planCity(game, me, {
      ...ECONOMY_ONLY,
      cityUpgradeFirst: false,
    });
    expect(plan).toMatchObject({ kind: "build" });
  });

  test("a city that is now shallow is not upgraded; a deep site gets a new city", async () => {
    const { f, game, me, city } = await withCity(3);
    // A tribe takes land 5 tiles from the city.
    addTribe(f, "NEAR0001", rect(game, 55, 38, 58, 42), 100, false);
    expect(bruteDepth(game, me, city.tile())).toBeLessThan(D);
    me.addGold(10_000_000n);
    const plan = planCity(game, me, ECONOMY_ONLY);
    expect(plan).toMatchObject({ kind: "build" });
    if (typeof plan === "string" || plan.kind !== "build") return;
    expect(bruteDepth(game, me, plan.tile)).toBeGreaterThanOrEqual(D);
  });

  test("of two deep cities the one with more levels is upgraded, below cityMaxLevel", async () => {
    const { game, me, city } = await withCity(1);
    const big = me.buildUnit(UnitType.City, game.ref(25, 40), {});
    big.increaseLevel();
    me.addGold(10_000_000n);
    expect(planCity(game, me, ECONOMY_ONLY)).toMatchObject({
      kind: "upgrade",
      unitId: big.id(),
      amount: 1,
    });
    // At the cap (level 3) it is left alone; the stacked spec goes on.
    big.increaseLevel();
    expect(planCity(game, me, ECONOMY_ONLY)).toMatchObject({
      kind: "upgrade",
      unitId: city.id(),
      amount: 2,
    });
    expect(planCity(game, me, STACKED)).toMatchObject({
      kind: "upgrade",
      unitId: big.id(),
    });
  });

  test("citySpread: a new city goes beyond twice an atom bomb's outer radius from our others when a site allows", async () => {
    const { game, me, city } = await withCity(3);
    me.addGold(10_000_000n);
    const o = { ...ECONOMY_ONLY, cityUpgradeFirst: false };
    const r = 2 * game.config().nukeMagnitudes(UnitType.AtomBomb).outer;
    const spread = planCity(game, me, o);
    expect(spread).toMatchObject({ kind: "build" });
    if (typeof spread === "string" || spread.kind !== "build") return;
    expect(game.euclideanDistSquared(spread.tile, city.tile())).toBeGreaterThan(
      r * r,
    );
    // Without it: the deepest site, next to the city.
    const deep = planCity(game, me, { ...o, citySpread: false });
    if (typeof deep === "string" || deep.kind !== "build") throw new Error();
    expect(bruteDepth(game, me, deep.tile)).toBeGreaterThanOrEqual(
      bruteDepth(game, me, spread.tile),
    );
  });

  test("a city under construction cannot be upgraded; a free deep site gets a city", async () => {
    const f = await territory(110, 90, [0, 0, 100, 80]);
    const { game, me } = f;
    me.addGold(125_000n);
    const first = planCity(game, me, ECONOMY_ONLY);
    expect(first).toMatchObject({ kind: "build" });
    if (typeof first === "string") return;
    execute(f, first, 2);
    const c = me.units(UnitType.City)[0];
    expect(c.isUnderConstruction()).toBe(true);
    me.addGold(10_000_000n);
    const plan = planCity(game, me, ECONOMY_ONLY);
    expect(plan).toMatchObject({ kind: "build" });
  });
});

describe("apex economy (§3.8): options and the structure policy", () => {
  test("cities off, policy never, not enough gold: nothing", async () => {
    const f = await territory(110, 90, [0, 0, 100, 80]);
    const { game, me } = f;
    expect(planCity(game, me, ECONOMY_ONLY)).toBe("gold");
    me.addGold(10_000_000n);
    expect(planCity(game, me, { ...ECONOMY_ONLY, cities: false })).toBe("off");
    expect(
      planCity(game, me, { ...ECONOMY_ONLY, structurePolicy: "never" }),
    ).toBe("policy");
    expect(planCity(game, me, ECONOMY_ONLY)).toMatchObject({ kind: "build" });
  });

  test('"exposure": a nation with a finished silo and bomb gold blocks cities, unless our SAM covers the site', async () => {
    const f = await territory(140, 80, [0, 0, 100, 80]);
    const { game, me } = f;
    me.addGold(10_000_000n);
    const o = { ...ECONOMY_ONLY, structurePolicy: "exposure" as const };
    expect(planCity(game, me, o)).toMatchObject({ kind: "build" });
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
    );
    own(nation, rect(game, 110, 0, 140, 80));
    nation.buildUnit(UnitType.MissileSilo, game.ref(125, 40), {});
    // A silo without bomb gold: no threat.
    expect(planCity(game, me, o)).toMatchObject({ kind: "build" });
    nation.addGold(
      game.config().unitInfo(UnitType.AtomBomb).cost(game, nation),
    );
    expect(planCity(game, me, o)).toBe("exposed");
    // "free" ignores it.
    expect(
      planCity(game, me, { ...ECONOMY_ONLY, structurePolicy: "free" }),
    ).toMatchObject({ kind: "build" });
    // A finished SAM of ours covering the interior lifts it there.
    const sam = me.buildUnit(UnitType.SAMLauncher, game.ref(50, 40), {});
    const plan = planCity(game, me, o);
    expect(plan).toMatchObject({ kind: "build" });
    if (typeof plan === "string" || plan.kind !== "build") return;
    const r = game.config().samRange(sam.level());
    expect(
      game.euclideanDistSquared(sam.tile(), plan.tile),
    ).toBeLessThanOrEqual(r * r);
    expect(exposedSite(game, me, game.ref(2, 2))).toBe(
      game.euclideanDistSquared(sam.tile(), game.ref(2, 2)) > r * r,
    );
  });

  test("exposureWide: a silo under construction with bomb gold, or gold for a silo and a bomb, counts too", async () => {
    const f = await territory(140, 80, [0, 0, 100, 80]);
    const { game, me } = f;
    const site = game.ref(50, 40);
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
    );
    own(nation, rect(game, 110, 0, 140, 80));
    const config = game.config();
    const bomb = config.unitInfo(UnitType.AtomBomb).cost(game, nation);
    const silo = config.unitInfo(UnitType.MissileSilo).cost(game, nation);
    nation.addGold(bomb + silo - 1n);
    expect(exposedSite(game, me, site, true)).toBe(false);
    nation.addGold(1n);
    // No silo yet: only the wide rule sees it.
    expect(exposedSite(game, me, site, false)).toBe(false);
    expect(exposedSite(game, me, site, true)).toBe(true);
    const o = { ...ECONOMY_ONLY, structurePolicy: "exposure" as const };
    expect(o.exposureWide).toBe(true);
    me.addGold(10_000_000n);
    expect(planCity(game, me, o)).toBe("exposed");
    expect(planCity(game, me, { ...o, exposureWide: false })).toMatchObject({
      kind: "build",
    });
    // A silo under construction and bomb gold (not silo gold); buildUnit
    // takes the silo's price.
    const s = nation.buildUnit(UnitType.MissileSilo, game.ref(125, 40), {});
    s.setUnderConstruction(true);
    nation.removeGold(nation.gold());
    nation.addGold(bomb);
    expect(exposedSite(game, me, site, false)).toBe(false);
    expect(exposedSite(game, me, site, true)).toBe(true);
  });
});

/** Our territory with one finished city of `level` levels at 50,40. */
async function withCityLevels(level: number) {
  const f = await territory(110, 90, [0, 0, 100, 80]);
  const { game, me } = f;
  const city = me.buildUnit(UnitType.City, game.ref(50, 40), {});
  for (let l = 1; l < level; l++) city.increaseLevel();
  return { f, game, me, city };
}

describe("apex economy: the nuke reflex (o.nukeReflex)", () => {
  test("a bomb in flight to a city counts its levels; above the cap left after it, the allocator is in stall mode", async () => {
    const { game, me, city } = await withCityLevels(3);
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
    );
    own(nation, rect(game, 105, 0, 110, 10));
    const models = createModels(game);
    const s = createState();
    const o = parseApexOptions();
    expect(inboundNukeLevels(game, me)).toBe(0);
    expect(nukeThreat(game, me, models, 10)).toBeNull();
    // An atom bomb aimed 20 tiles off the city (outer radius 30).
    const aim = game.ref(game.x(city.tile()) + 20, game.y(city.tile()));
    nation.buildUnit(UnitType.AtomBomb, game.ref(107, 5), {
      targetTile: aim,
      trajectory: [],
    });
    expect(inboundNukeLevels(game, me)).toBe(3);
    const after = models.capAt(PlayerType.Human, me.numTilesOwned(), 0);
    me.setTroops(after - 1);
    expect(nukeThreat(game, me, models, 10)).toBeNull();
    me.setTroops(after + 50_000);
    s.nuke = nukeThreat(game, me, models, 10);
    expect(s.nuke).toEqual({ lost: 3, capAfter: after, at: 10 });
    expect(inStall(s, 10, o)).toBe(true);
    expect(inStall(s, 10, { ...o, nukeReflex: false })).toBe(false);
    // A bomb aimed 40 tiles off misses the city.
    const g2 = await withCityLevels(2);
    const n2 = g2.game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
    );
    own(n2, rect(g2.game, 105, 0, 110, 10));
    const far = g2.game.ref(
      g2.game.x(g2.city.tile()) + 40,
      g2.game.y(g2.city.tile()),
    );
    n2.buildUnit(UnitType.AtomBomb, g2.game.ref(107, 5), {
      targetTile: far,
      trajectory: [],
    });
    expect(inboundNukeLevels(g2.game, g2.me)).toBe(0);
  });
});

describe("apex economy (§3.8): the live policy", () => {
  test("stacked (the spec's §3.8): builds deep, then upgrades; the cap rises by cityTroopIncrease() per finished level, exactly when it finishes", async () => {
    const f = await territory(120, 90, [0, 0, 110, 90]);
    const { game, me } = f;
    const policy = new ApexPolicy(STACKED, createState());
    const h = new Harness(f, (ctx) => policy.tick(ctx));
    const inc = game.config().cityTroopIncrease();
    const models = createModels(game);
    me.addGold(3_000_000n);
    const base = models.capAt(PlayerType.Human, me.numTilesOwned(), 0);
    expect(game.config().maxTroops(me)).toBe(base);
    const actions: { tick: number; intent: AgentIntent }[] = [];
    let levels = 0;
    for (let i = 0; i < 200; i++) {
      const tick = game.ticks();
      const sent = h.step();
      for (const intent of sent) {
        actions.push({ tick, intent });
        if (intent.type === "build_unit") {
          // Depth at the moment it was sent (nothing moved since).
          expect(bruteDepth(game, me, intent.tile)).toBeGreaterThanOrEqual(D);
        }
      }
      // After every turn: the cap is the land part plus 250k per finished
      // level, and a level counts from the turn it finishes.
      const now = finishedCityLevels(me);
      expect(now).toBeGreaterThanOrEqual(levels);
      levels = now;
      expect(game.config().maxTroops(me)).toBe(base + inc * levels);
      expect(models.capAt(PlayerType.Human, me.numTilesOwned(), levels)).toBe(
        game.config().maxTroops(me),
      );
    }
    // The first action builds (no city yet); every later one upgrades that
    // city, which stays deep: upgrades before builds.
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(actions[0].intent.type).toBe("build_unit");
    for (const a of actions.slice(1)) {
      expect(a.intent.type).toBe("upgrade_structure");
    }
    // No two actions within cityEvery ticks.
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i].tick - actions[i - 1].tick).toBeGreaterThanOrEqual(
        ECONOMY_ONLY.cityEvery,
      );
    }
    const cities = me.units(UnitType.City);
    expect(cities.length).toBe(1);
    // 3M buys the 125k city, then 250k + 500k + 1M + 1M of upgrades.
    expect(cities[0].level()).toBe(5);
    expect(me.gold()).toBe(3_000_000n - 125_000n - 2_750_000n);
    expect(game.config().maxTroops(me)).toBe(base + 5 * inc);
  });

  test("by default: cities of at most cityMaxLevel, spread beyond twice an atom bomb's radius", async () => {
    const f = await territory(120, 90, [0, 0, 110, 90]);
    const { game, me } = f;
    const policy = new ApexPolicy(ECONOMY_ONLY, createState());
    const h = new Harness(f, (ctx) => policy.tick(ctx));
    const inc = game.config().cityTroopIncrease();
    const base = game.config().maxTroops(me);
    me.addGold(3_000_000n);
    for (let i = 0; i < 300; i++) h.step();
    const cities = me.units(UnitType.City);
    // 125k (L1) + 250k + 500k (L3), 1M (a second city), 1M (its L2).
    expect(cities.map((c) => c.level()).sort()).toEqual([2, 3]);
    const r = 2 * game.config().nukeMagnitudes(UnitType.AtomBomb).outer;
    expect(
      game.euclideanDistSquared(cities[0].tile(), cities[1].tile()),
    ).toBeGreaterThan(r * r);
    expect(game.config().maxTroops(me)).toBe(base + 5 * inc);
    expect(me.gold()).toBe(3_000_000n - 125_000n - 750_000n - 2_000_000n);
  });

  test("the cap rises only when the new city finishes (in turn constructionDuration + 2 after the intent's)", async () => {
    const f = await territory(120, 90, [0, 0, 110, 90]);
    const { game, me } = f;
    const policy = new ApexPolicy(ECONOMY_ONLY, createState());
    const h = new Harness(f, (ctx) => policy.tick(ctx));
    me.addGold(125_000n);
    const cap0 = game.config().maxTroops(me);
    const inc = game.config().cityTroopIncrease();
    const duration = game
      .config()
      .unitInfo(UnitType.City).constructionDuration!;
    const t0 = game.ticks();
    let sentAt = -1;
    const caps: number[] = [];
    for (let i = 0; i < 40; i++) {
      const tick = game.ticks();
      if (h.step().some((x) => x.type === "build_unit")) sentAt = tick;
      caps.push(game.config().maxTroops(me));
    }
    // The first decision builds.
    expect(sentAt).toBe(t0);
    expect(duration).toBe(20);
    // caps[i] is the cap at ctx.tick = sentAt + i + 1, after turn
    // sentAt + i. The city finishes in turn sentAt + duration + 2 [PIN
    // EconomyGold], so it counts from ctx.tick sentAt + duration + 3.
    for (let i = 0; i < caps.length; i++) {
      const turn = sentAt + i;
      expect(caps[i]).toBe(turn >= sentAt + duration + 2 ? cap0 + inc : cap0);
    }
  });

  test('with cities off the live policy sends no economy intent (the "cities" ablation)', async () => {
    const f = await territory(120, 90, [0, 0, 110, 90]);
    const o = { ...ECONOMY_ONLY, cities: false };
    const policy = new ApexPolicy(o, createState());
    const h = new Harness(f, (ctx) => policy.tick(ctx));
    f.me.addGold(3_000_000n);
    for (let i = 0; i < 100; i++) expect(h.step()).toEqual([]);
    expect(new EconomyController().name).toBe("economy");
  });
});
