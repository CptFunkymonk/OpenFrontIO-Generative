import type { AgentIntent } from "../../../src/agent/Agent";
import {
  boatTrigger,
  farTargets,
  foodProjection,
  landmassFood,
  LandmassFood,
  localFoodLow,
  NavalController,
  navalMemory,
  nearWarship,
  recordFood,
  routeNearWarship,
  surplus,
} from "../../../src/agent/agents/apex/controllers/NavalController";
import { homeFloors } from "../../../src/agent/agents/apex/HomeTarget";
import {
  ApexOptions,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import type { View } from "../../../src/agent/agents/apex/policy";
import { ApexState, createState } from "../../../src/agent/agents/apex/state";
import { seatClientID } from "../../../src/agent/arena/ArenaGame";
import { IntentBudget } from "../../../src/agent/IntentBudget";
import { Ledger } from "../../../src/agent/lib/Ledger";
import { createModels, Models } from "../../../src/agent/lib/Models";
import { NationModel } from "../../../src/agent/lib/NationModel";
import {
  boatTargets,
  buildRaceGrid,
  cellOf,
  FarReach,
  nationLandDistance,
  nationReach,
  OWNER_WATER,
  OwnerGrid,
  ownerGrid,
  RaceGrid,
  voyageField,
  voyageRoute,
} from "../../../src/agent/lib/RaceField";
import {
  createPurse,
  Purse,
  Scheduler,
} from "../../../src/agent/lib/Scheduler";
import { scanWorld, WorldModel } from "../../../src/agent/lib/WorldModel";
import { Config } from "../../../src/core/configuration/Config";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { UserSettings } from "../../../src/core/game/UserSettings";
import { GameConfig } from "../../../src/core/Schemas";

// Package A2, the naval midgame (o.boatsMidgame; spec §3.7, §5.4; chapter
// 13 §2.12, §5.11). The "surplus" trigger, the warship guard on the
// estimated sea route (voyageRoute, o.boatMidRouteGuard), and, with
// o.boatMidFar, far targets past boatMaxVoyage (in the midgame only) when
// their landmass keeps food and no nation can get to the landing first
// (nationReach), the food trend and the far tribe's sizing. Synthetic maps
// as in Naval.test.ts: the real Config at Impossible; no PlayerExecution
// runs, so troops stay where the test puts them. Tests may mutate the game;
// the agent never does.

const ME = seatClientID(0);
const MY_ID = "AGENTID1";
const GAME_ID = "NAVALMID";

const GAME_CONFIG: GameConfig = {
  gameMap: GameMapType.Asia,
  gameMapSize: GameMapSize.Normal,
  gameMode: GameMode.FFA,
  gameType: GameType.Singleplayer,
  difficulty: Difficulty.Impossible,
  nations: "default",
  donateGold: false,
  donateTroops: false,
  bots: 0,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: false,
};

const LAND = 0x80 | 5;
const OCEAN = 0x20;
const SHORELINE = 0x40;

function terrain(
  w: number,
  h: number,
  isLand: (x: number, y: number) => boolean,
): { t: Uint8Array; land: number } {
  const t = new Uint8Array(w * h);
  let land = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = isLand(x, y);
      t[y * w + x] = l ? LAND : OCEAN;
      if (l) land++;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = (t[y * w + x] & 0x80) !== 0;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (((t[ny * w + nx] & 0x80) !== 0) !== l) {
          t[y * w + x] |= SHORELINE;
          break;
        }
      }
    }
  }
  return { t, land };
}

function synthGame(
  w: number,
  h: number,
  isLand: (x: number, y: number) => boolean,
): Game {
  const main = terrain(w, h, isLand);
  const mw = Math.ceil(w / 2);
  const mh = Math.ceil(h / 2);
  const mini = terrain(mw, mh, (x, y) => {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const X = 2 * x + dx;
        const Y = 2 * y + dy;
        if (X < w && Y < h && !isLand(X, Y)) return false;
      }
    }
    return true;
  });
  const game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, ME, MY_ID)],
    [],
    new GameMapImpl(w, h, main.t, main.land),
    new GameMapImpl(mw, mh, mini.t, mini.land),
    new Config(GAME_CONFIG, new UserSettings(), false),
  );
  game.endSpawnPhase();
  return game;
}

function fill(
  game: Game,
  p: Player,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = game.ref(x, y);
      if (game.isLand(t)) p.conquer(t);
    }
  }
}

interface Rig {
  game: Game;
  me: Player;
  o: ApexOptions;
  s: ApexState;
  models: Models;
  nm: NationModel;
  ledger: Ledger;
  scheduler: Scheduler;
  budget: IntentBudget;
  race: RaceGrid;
  owners: OwnerGrid | null;
  wm: WorldModel | null;
  ctrl: NavalController;
  sent: AgentIntent[];
}

function rig(game: Game, over: Record<string, unknown> = {}): Rig {
  const me = game.player(MY_ID);
  const o = parseApexOptions(over);
  const models = createModels(game);
  const r: Rig = {
    game,
    me,
    o,
    s: createState(),
    models,
    nm: new NationModel(game, me, GAME_ID, models),
    ledger: new Ledger(),
    scheduler: new Scheduler(o, game.config().msPerTick()),
    budget: new IntentBudget(() => game.ticks() * game.config().msPerTick()),
    race: buildRaceGrid(game, o),
    owners: null,
    wm: null,
    ctrl: new NavalController(),
    sent: [],
  };
  r.s.spawn.endTick = game.ticks();
  return r;
}

function view(r: Rig): View {
  const { game, me, o, s, models, nm } = r;
  const tick = game.ticks();
  r.ledger.observe(me, tick, game);
  r.wm = scanWorld(game, me, r.wm);
  if (r.owners === null || tick - r.owners.stamp >= 100) {
    const stride = Math.max(
      1,
      Math.round(Math.sqrt((game.width() * game.height()) / 40_000)),
    );
    r.owners = ownerGrid(game, r.race, stride);
  }
  const purse = createPurse(
    me.troops(),
    homeFloors({ tick, o, me, models, nm }, s),
  );
  r.scheduler.begin(tick, r.budget.remaining(), purse);
  return {
    game,
    me,
    tick,
    gameID: GAME_ID,
    o,
    models,
    wm: r.wm,
    nm,
    ledger: r.ledger,
    race: r.race,
    owners: r.owners,
    scheduler: r.scheduler,
    purse,
    lookahead: null,
    forRollout: null,
    live: null,
  };
}

/** One decision: decide, then the Scheduler's flush (nothing executes). */
function decideOnce(r: Rig): void {
  const v = view(r);
  r.ctrl.decide(v, r.s);
  r.scheduler.flush(
    (intent) => {
      r.sent.push(intent);
      return "ok";
    },
    r.ledger,
    v.tick,
  );
}

const boats = (r: Rig) =>
  r.sent.filter((x) => x.type === "boat") as Extract<
    AgentIntent,
    { type: "boat" }
  >[];

beforeAll(() => {
  console.debug = () => {};
  console.warn = () => {};
});

/** 700×20: us x 0 to ours − 1, a far island x 600-699 (the map's east
 *  edge), so its only ocean shore faces west, 540-590 tiles of sea from
 *  us. */
function farGame(ours = 10): Game {
  const game = synthGame(700, 20, (x) => x < ours || x >= 600);
  const me = game.player(MY_ID);
  fill(game, me, 0, ours, 0, 20);
  me.setSpawnTile(game.ref(5, 10));
  return game;
}

describe("naval midgame (o.boatsMidgame)", () => {
  test("nationLandDistance: stride tiles a land step from nation samples, walls at water, −1 off their landmass", () => {
    // 60×10: land x 0-19 and x 40-59; a nation holds x 0-3 of the west one.
    const game = synthGame(60, 10, (x) => x < 20 || x >= 40);
    const n = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
    );
    fill(game, n, 0, 4, 0, 10);
    const bot = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "BOT00001"),
    );
    fill(game, bot, 50, 54, 0, 10);
    const me = game.player(MY_ID);
    const race = buildRaceGrid(game, parseApexOptions());
    const og = ownerGrid(game, race, 2);
    const d = nationLandDistance(game, og, me);
    const at = (x: number, y: number) =>
      d[Math.floor(y / 2) * og.ow + Math.floor(x / 2)];
    // Samples at x = 1, 3, 5, ...: the nation's are 0, then 2 tiles a step.
    expect(at(0, 4)).toBe(0);
    expect(at(2, 4)).toBe(0);
    expect(at(4, 4)).toBe(2);
    expect(at(18, 4)).toBe(16);
    // Water and the other landmass (a tribe, no nation) are out of reach.
    expect(og.owner[Math.floor(4 / 2) * og.ow + 15]).toBe(OWNER_WATER);
    expect(at(30, 4)).toBe(-1);
    expect(at(50, 4)).toBe(-1);
    expect(at(58, 4)).toBe(-1);
    // Our own land never seeds it; a map without nations is all −1.
    const bare = synthGame(60, 10, (x) => x < 20 || x >= 40);
    fill(bare, bare.player(MY_ID), 0, 4, 0, 10);
    const og2 = ownerGrid(bare, buildRaceGrid(bare, parseApexOptions()), 2);
    expect([...nationLandDistance(bare, og2, bare.player(MY_ID))]).toEqual(
      new Array(og2.owner.length).fill(-1),
    );
  });

  test("boatTargets: a target past voyage.max only with a FarReach whose projection, limit and nation distance allow it", () => {
    const game = farGame();
    const me = game.player(MY_ID);
    const race = buildRaceGrid(game, parseApexOptions());
    const og = ownerGrid(game, race, 1);
    const field = voyageField(game, race, [game.ref(9, 10)]);
    const none = boatTargets(game, race, og, me, 8, { field, max: 400 });
    expect(none).toHaveLength(0);
    const reach = (over: Partial<FarReach>) => {
      const far: FarReach = {
        max: 2400,
        foodAt: (_c: number, _v: number) => 2000,
        minFood: 1000,
        nation: null,
        front: 0.15,
        hold: 0,
        ...over,
      };
      return boatTargets(game, race, og, me, 8, { field, max: 400, far });
    };
    const held = new Uint8Array(race.compLand.size);
    const got = reach({});
    expect(got.length).toBeGreaterThan(0);
    for (const t of got) {
      expect(t.far).toBe(true);
      expect(t.tribeSmallID).toBeNull();
      expect(t.dist).toBeGreaterThan(400);
      expect(t.food).toBe(2000);
      expect(game.x(t.tile)).toBe(600);
    }
    // The projection is asked with the voyage; too little food, or a voyage
    // over far.max, leaves it out.
    const asked: number[] = [];
    reach({
      hold: 1000,
      foodAt: (_c, v) => {
        asked.push(v);
        return 2000;
      },
    });
    // Asked for the voyage plus the hold.
    expect(Math.min(...asked)).toBeGreaterThan(1400);
    expect(reach({ foodAt: () => 999 })).toHaveLength(0);
    expect(reach({ max: 500 })).toHaveLength(0);
    // A nation 50 tiles (by land) from every candidate: in reach of a front
    // of 0.15 tiles a tick over a ~590-tile voyage, not of 0.05.
    const nation = {
      dist: new Int32Array(og.owner.length).fill(50),
      held,
    };
    expect(reach({ nation })).toHaveLength(0);
    expect(reach({ nation, front: 0.05 }).length).toBeGreaterThan(0);
    // The hold: 0.05 × (~590 + 500) tiles is past 50.
    expect(reach({ nation, front: 0.05, hold: 500 })).toHaveLength(0);
    // A sample no seed reaches is nation-free only on a landmass without
    // one.
    const unreached = new Int32Array(og.owner.length).fill(-1);
    expect(reach({ nation: { dist: unreached, held } }).length).toBeGreaterThan(
      0,
    );
    expect(
      reach({ nation: { dist: unreached, held: held.slice().fill(1) } }),
    ).toHaveLength(0);
    // Near targets are untouched by a FarReach.
    const near = boatTargets(game, race, og, me, 8, {
      field,
      max: 2400,
      far: {
        max: 2400,
        foodAt: () => 0,
        minFood: 1e9,
        nation: { dist: new Int32Array(og.owner.length).fill(0), held },
        front: 1,
        hold: 0,
      },
    });
    expect(near.length).toBeGreaterThan(0);
    expect(near.every((t) => !t.far)).toBe(true);
  });

  test("food trend: one snapshot per OwnerGrid stamp; the projection subtracts margin × loss rate over voyage + slack", () => {
    const s = createState();
    const mem = navalMemory(s);
    const food = (free: number, tribe: number): LandmassFood => ({
      ours: new Set(),
      free: new Map([[3, free]]),
      tribe: new Map([[3, tribe]]),
    });
    const o = { boatMidRateTicks: 300, boatMidRateMargin: 2 };
    recordFood(mem, food(1000, 9000), 100);
    // Without an older snapshot no loss is assumed.
    expect(foodProjection(mem, food(1000, 9000), 100, o)(3, 500)).toBe(10000);
    recordFood(mem, food(1000, 9000), 100);
    expect(mem.foodSeen).toHaveLength(1);
    recordFood(mem, food(500, 7500), 300);
    expect(mem.foodSeen).toHaveLength(2);
    // 2,000 lost in 200 ticks: 10 a tick, doubled, over 500 ticks.
    const at = foodProjection(mem, food(500, 7500), 300, o);
    expect(at(3, 500)).toBeCloseTo(8000 - 2 * 10 * 500);
    expect(at(7, 500)).toBe(0);
    // A snapshot older than boatMidRateTicks is not read.
    recordFood(mem, food(500, 7500), 700);
    expect(foodProjection(mem, food(500, 7500), 700, o)(3, 100)).toBe(8000);
    // A landmass gaining food projects its food now.
    recordFood(mem, food(2000, 7500), 800);
    expect(foodProjection(mem, food(2000, 7500), 800, o)(3, 100)).toBe(9500);
    // The history is bounded.
    for (let t = 900; t < 3000; t += 100) recordFood(mem, food(1, 1), t);
    expect(mem.foodSeen.length).toBeLessThanOrEqual(8);
    // Plain data: the state survives a structuredClone.
    expect(structuredClone(s).naval?.foodSeen).toEqual(mem.foodSeen);
  });

  test('"surplus": only with the flag, once the Purse holds boatMidSurplus of the cap for boats', () => {
    const purse = (avail: number, cap: number) =>
      ({
        floors: { cap },
        available: () => avail,
      }) as unknown as Purse;
    const on = parseApexOptions({ boatsMidgame: true });
    expect(surplus({ o: on, purse: purse(150_000, 1_000_000) })).toBe(true);
    expect(surplus({ o: on, purse: purse(149_999, 1_000_000) })).toBe(false);
    expect(surplus({ o: on, purse: purse(150_000, 0) })).toBe(false);
    const zero = parseApexOptions({ boatsMidgame: true, boatMidSurplus: 0 });
    expect(surplus({ o: zero, purse: purse(1e9, 1_000_000) })).toBe(false);
    const off = parseApexOptions();
    expect(surplus({ o: off, purse: purse(1e9, 1_000_000) })).toBe(false);

    // Through boatTrigger: a free island next to us (food on our side of
    // the water: not blocked by land, no stall), troops idle at home.
    // 200×64: our landmass x 0-119 (7,168 free tiles, not water
    // priority), an island x 180-199.
    const game = synthGame(200, 64, (x) => x < 120 || x >= 180);
    fill(game, game.player(MY_ID), 0, 8, 0, 64);
    game.player(MY_ID).setSpawnTile(game.ref(4, 32));
    for (const [over, want] of [
      [{ boatsMidgame: true }, "surplus"],
      [{}, null],
    ] as const) {
      const r = rig(game, over);
      r.me.setTroops(400_000);
      const v = view(r);
      expect(v.wm.freeFrontier).toBeGreaterThan(0);
      const f = landmassFood(game, r.race, r.owners!, r.me);
      expect(boatTrigger(v, r.s, f)).toBe(want);
    }
  });

  test("a far free island gets a boat only with boatsMidgame and boatMidFar; the send is logged far", () => {
    const game = farGame();
    const far = { boatsMidgame: true, boatMidFar: true };
    for (const [over, want] of [
      [{}, 0],
      // Far targets are off by default under the flag.
      [{ boatsMidgame: true }, 0],
      [{ boatMidFar: true }, 0],
      [far, 1],
      // Its 2,000 tiles never reach a boatMidMinFood of 2,500.
      [{ ...far, boatMidMinFood: 2500 }, 0],
      // A voyage (about 590 tiles) past boatMidMaxVoyage.
      [{ ...far, boatMidMaxVoyage: 500 }, 0],
    ] as const) {
      const r = rig(game, over);
      r.me.setTroops(100_000);
      const lines: string[] = [];
      const v = view(r);
      v.log = (line) => lines.push(line);
      r.ctrl.decide(v, r.s);
      r.scheduler.flush(
        (intent) => {
          r.sent.push(intent);
          return "ok";
        },
        r.ledger,
        v.tick,
      );
      expect(boats(r)).toHaveLength(want);
      if (want === 1) {
        expect(game.x(boats(r)[0].dst)).toBe(600);
        expect(lines.some((l) => /far, projected food/.test(l))).toBe(true);
        expect(navalMemory(r.s).stats.far).toBe(1);
      }
    }
  });

  test("a far island whose food is being eaten fast gets no far boat", () => {
    const game = farGame();
    const r = rig(game, {
      boatsMidgame: true,
      boatMidFar: true,
      boatMidMinFood: 500,
    });
    r.me.setTroops(100_000);
    // The island held 12,000 food tiles 200 ticks ago: 50 a tick lost, so
    // nothing is left at the landing ~640 ticks out.
    const mem = navalMemory(r.s);
    mem.foodSeen.push({ stamp: game.ticks() - 200, food: {} });
    const v = view(r);
    const comp = r.race.comp[cellOf(r.race, game, game.ref(650, 10))];
    expect(comp).toBeGreaterThanOrEqual(0);
    mem.foodSeen[0].food[String(comp)] = 12_000;
    r.ctrl.decide(v, r.s);
    r.scheduler.flush(
      (intent) => {
        r.sent.push(intent);
        return "ok";
      },
      r.ledger,
      v.tick,
    );
    expect(boats(r)).toHaveLength(0);
  });

  test("a far tribe is sized for its regrowth during the voyage", () => {
    // The tribe holds the far island's west part (all of its ocean shore);
    // the rest is free land.
    const troopsWith = (over: Record<string, unknown>) => {
      // 1,200 tiles of ours: a cap (about 241k) the boat fits under.
      const game = farGame(60);
      const b = game.addPlayer(
        new PlayerInfo("tribe", PlayerType.Bot, null, "BOT00001"),
      );
      fill(game, b, 600, 640, 0, 20);
      b.setTroops(5_000);
      const r = rig(game, {
        boatsMidgame: true,
        boatMidFar: true,
        boatMidMinFood: 500,
        ...over,
      });
      r.me.setTroops(Math.floor(r.models.cap(r.me)));
      decideOnce(r);
      const bs = boats(r);
      expect(bs).toHaveLength(1);
      expect(game.owner(bs[0].dst)).toBe(b);
      return bs[0].troops;
    };
    // The same tribe as a near target (boatMaxVoyage past the voyage).
    const near = troopsWith({ boatMaxVoyage: 2400 });
    const far = troopsWith({});
    expect(far).toBeGreaterThan(near);
  });

  test("in stall mode a dense far tribe passes the price limit only with boatMidStallPrice", () => {
    const sent = (price: number) => {
      const game = farGame();
      const b = game.addPlayer(
        new PlayerInfo("tribe", PlayerType.Bot, null, "BOT00001"),
      );
      fill(game, b, 600, 640, 0, 20);
      // 800 tiles at 300 troops a tile.
      b.setTroops(240_000);
      const r = rig(game, {
        boatsMidgame: true,
        boatMidMinFood: 500,
        boatMaxVoyage: 2400,
        boatMidStallPrice: price,
      });
      r.me.setTroops(3_000_000);
      r.s.stall.since = game.ticks() - 1000;
      decideOnce(r);
      return boats(r).filter((x) => game.owner(x.dst) === b).length;
    };
    expect(sent(1)).toBe(0);
    expect(sent(100)).toBe(1);
  });

  test("voyageRoute and routeNearWarship: the sea route bends around land; a warship off the straight line but on the route guards it", () => {
    // 600×300: us x 0-19; a nation's wall x 270-329, y 0-209; a free
    // island x 540-599, y 0-29. The sea route from the island runs west
    // along its south shore, south past the wall's east face (x 330), then
    // west under it (y 210+), far from the straight line along the top.
    const game = synthGame(
      600,
      300,
      (x, y) =>
        x < 20 || (x >= 270 && x < 330 && y < 210) || (x >= 540 && y < 30),
    );
    const me = game.player(MY_ID);
    fill(game, me, 0, 20, 0, 300);
    const wall = game.addPlayer(
      new PlayerInfo("navy", PlayerType.Nation, null, "NATION01"),
    );
    fill(game, wall, 270, 330, 0, 210);
    const race = buildRaceGrid(game, parseApexOptions());
    const shore: number[] = [];
    for (let y = 0; y < 300; y += 5) shore.push(game.ref(19, y));
    const field = voyageField(game, race, shore);
    const landing = game.ref(560, 29);
    const c = cellOf(race, game, landing);
    const route = voyageRoute(field, race, c, 2000);
    expect(route.length).toBeGreaterThan(10);
    // Each step is a 4-neighbour one cell nearer our shore, down to 0.
    for (let k = 1; k < route.length; k++) {
      const d = Math.abs(route[k] - route[k - 1]);
      expect(d === 1 || d === race.cw).toBe(true);
      expect(field.dist[route[k]]).toBe(field.dist[route[k - 1]] - race.cell);
    }
    expect(field.dist[route[route.length - 1]]).toBe(0);
    // It passes under the wall.
    expect(route.some((q) => Math.floor(q / race.cw) * race.cell >= 210)).toBe(
      true,
    );
    // At most maxSteps cells; nothing for a cell the field does not reach.
    expect(voyageRoute(field, race, c, 5)).toHaveLength(5);
    expect(
      voyageRoute(field, race, cellOf(race, game, game.ref(300, 100)), 50),
    ).toEqual([]);
    // A warship 30 tiles east of the wall's east face: off the straight
    // line from our shore at the top (90 tiles away), on the route.
    const ws = [360, 120];
    expect(nearWarship(game, ws, game.ref(19, 29), landing, 40)).toBe(false);
    expect(routeNearWarship(game, race, field, landing, ws, 40)).toBe(true);
    // Far from both.
    expect(routeNearWarship(game, race, field, landing, [590, 290], 40)).toBe(
      false,
    );
    expect(routeNearWarship(game, race, field, landing, [], 40)).toBe(false);
  });

  test("a far boat, and with boatMidRouteGuard a near one, whose sea route passes a hostile warship is not sent", () => {
    const sent = (
      flag: boolean,
      at: [number, number],
      guard = true,
      over: Record<string, unknown> = { boatMaxVoyage: 2400 },
    ) => {
      const game = synthGame(
        600,
        300,
        (x, y) =>
          x < 20 || (x >= 270 && x < 330 && y < 210) || (x >= 540 && y < 30),
      );
      const r = rig(game, {
        boatsMidgame: flag,
        boatMidRouteGuard: guard,
        boatMidMinFood: 500,
        ...over,
      });
      fill(game, r.me, 0, 20, 0, 300);
      r.me.setSpawnTile(game.ref(10, 150));
      r.me.setTroops(400_000);
      const navy = game.addPlayer(
        new PlayerInfo("navy", PlayerType.Nation, null, "NATION01"),
      );
      fill(game, navy, 270, 330, 0, 210);
      const sea = game.ref(at[0], at[1]);
      expect(game.isWater(sea)).toBe(true);
      navy.buildUnit(UnitType.Warship, sea, { patrolTile: sea });
      decideOnce(r);
      return {
        boats: boats(r).length,
        routed: navalMemory(r.s).stats.routes > 0,
      };
    };
    // Under the wall's south end: over 150 tiles from the landing and from
    // the line along the top, next to the route.
    expect(sent(true, [400, 250])).toEqual({ boats: 0, routed: true });
    // Without the flag, or with the route guard off, only the straight line
    // is checked: the boat goes.
    expect(sent(false, [400, 250])).toEqual({ boats: 1, routed: false });
    expect(sent(true, [400, 250], false)).toEqual({ boats: 1, routed: false });
    // The SE corner guards nothing.
    expect(sent(true, [590, 290])).toEqual({ boats: 1, routed: false });
    // At the default boatMaxVoyage the island (about 700 tiles of sea) is a
    // far target (boatMidFar; our land is all ours, so the midgame gate
    // holds): its route is checked with the near boats' guard off.
    const far = { boatMidFar: true };
    expect(sent(true, [400, 250], false, far)).toEqual({
      boats: 0,
      routed: true,
    });
    expect(sent(true, [590, 290], false, far)).toEqual({
      boats: 1,
      routed: false,
    });
  });

  test("at the default front a far landmass a nation holds gets no boat; a nation-free one does", () => {
    const sent = (nation: boolean) => {
      const game = farGame();
      if (nation) {
        // A nation on the island's east end, about 80 tiles by land from
        // its west shore, where every landing lies.
        const n = game.addPlayer(
          new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
        );
        fill(game, n, 680, 700, 0, 20);
      }
      const r = rig(game, {
        boatsMidgame: true,
        boatMidFar: true,
        boatMidMinFood: 500,
      });
      r.me.setTroops(100_000);
      decideOnce(r);
      return boats(r).length;
    };
    expect(sent(false)).toBe(1);
    expect(sent(true)).toBe(0);
  });

  test("nationReach: nation samples and the land within boatBox of a nation's shore seed it; held marks their landmasses", () => {
    // 200×20: land x 0-19 (a nation holds its shore side, x 10-19), x
    // 100-119 (free) and x 180-199 (a tribe). The nation's shore (x 19) is
    // 81 tiles (Chebyshev) from the free landmass and 161 from the tribe's.
    const game = synthGame(
      200,
      20,
      (x) => x < 20 || (x >= 100 && x < 120) || x >= 180,
    );
    const n = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
    );
    fill(game, n, 10, 20, 0, 20);
    const bot = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "BOT00001"),
    );
    fill(game, bot, 180, 200, 0, 20);
    const me = game.player(MY_ID);
    const race = buildRaceGrid(game, parseApexOptions());
    const og = ownerGrid(game, race, 2);
    const at = (d: Int32Array, x: number) =>
      d[Math.floor(10 / 2) * og.ow + Math.floor(x / 2)];
    const comp = (x: number) => race.comp[cellOf(race, game, game.ref(x, 10))];
    // boatBox 0: the land BFS alone, as nationLandDistance. Samples at x =
    // 1, 3, ...: the nation's from x = 11, 2 tiles a step.
    const land = nationReach(game, race, og, me, 0);
    expect([...land.dist]).toEqual([...nationLandDistance(game, og, me)]);
    expect(at(land.dist, 12)).toBe(0);
    expect(at(land.dist, 0)).toBe(10);
    expect(at(land.dist, 110)).toBe(-1);
    expect(land.held[comp(5)]).toBe(1);
    expect(land.held[comp(110)]).toBe(0);
    expect(land.held[comp(190)]).toBe(0);
    // boatBox 150: the free landmass lies in the nation's boat box, its
    // samples seeds (0); the tribe's, 161 tiles out, do not.
    const boat = nationReach(game, race, og, me, 150);
    expect(at(boat.dist, 100)).toBe(0);
    expect(at(boat.dist, 118)).toBe(0);
    expect(boat.held[comp(110)]).toBe(1);
    expect(at(boat.dist, 190)).toBe(-1);
    expect(boat.held[comp(190)]).toBe(0);
    // A nation without a shore launches no boat: no box.
    const inland = synthGame(
      200,
      20,
      (x) => x < 20 || (x >= 100 && x < 120) || x >= 180,
    );
    const n2 = inland.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
    );
    fill(inland, n2, 0, 10, 0, 20);
    const race2 = buildRaceGrid(inland, parseApexOptions());
    const og2 = ownerGrid(inland, race2, 2);
    const r2 = nationReach(inland, race2, og2, inland.player(MY_ID), 150);
    expect(r2.dist[Math.floor(10 / 2) * og2.ow + 50]).toBe(-1);
    // Our land is never a seed, nor seeded by the box: our samples x = 101
    // and 103 are 4 and 2 tiles from the free sample x = 105.
    fill(game, me, 100, 104, 0, 20);
    const og3 = ownerGrid(game, race, 2);
    const mine = nationReach(game, race, og3, me, 150);
    expect(mine.dist[Math.floor(10 / 2) * og3.ow + 50]).toBe(4);
    expect(mine.dist[Math.floor(10 / 2) * og3.ow + 51]).toBe(2);
    expect(mine.dist[Math.floor(10 / 2) * og3.ow + 52]).toBe(0);
  });

  test("a far tribe on a spit the OwnerGrid cuts off from its nation's landmass gets no far boat", () => {
    // 700×20: us x 0-59; a far landmass x 600-699, a tribe on its west
    // part (x 600-639) and on a spit: a strip along row 12 (x 570-599)
    // with a stub up to (570, 10). At stride 4 (samples at 4k + 2) the
    // stub's sample (570, 10) has only water samples around it; by tiles
    // it is the landmass's (race-grid links). A nation holds x 640-699.
    const run = (nation: boolean, over: Record<string, unknown> = {}) => {
      const game = synthGame(
        700,
        20,
        (x, y) =>
          x < 60 ||
          x >= 600 ||
          (y === 12 && x >= 570) ||
          (x === 570 && y >= 10 && y <= 12),
      );
      const me = game.player(MY_ID);
      fill(game, me, 0, 60, 0, 20);
      me.setSpawnTile(game.ref(5, 10));
      const b = game.addPlayer(
        new PlayerInfo("tribe", PlayerType.Bot, null, "BOT00001"),
      );
      fill(game, b, 570, 640, 0, 20);
      b.setTroops(5_000);
      if (nation) {
        const n = game.addPlayer(
          new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
        );
        fill(game, n, 640, 700, 0, 20);
      }
      const r = rig(game, {
        boatsMidgame: true,
        boatMidFar: true,
        boatMidMinFood: 500,
        ...over,
      });
      r.me.setTroops(Math.floor(r.models.cap(r.me)));
      r.owners = ownerGrid(game, r.race, 4);
      return { game, r, b };
    };
    // The precondition: the stub's sample is the tribe's, unreached by the
    // land BFS (the old far test read that as nation-free), on the
    // nation's landmass.
    {
      const { game, r, b } = run(true, { boatMidNationBoat: 0 });
      const og = r.owners!;
      const spit = Math.floor(10 / 4) * og.ow + Math.floor(570 / 4);
      expect(og.owner[spit]).toBe(b.smallID());
      expect(nationLandDistance(game, og, r.me)[spit]).toBe(-1);
      const reach = nationReach(game, r.race, og, r.me, 0);
      expect(reach.dist[spit]).toBe(-1);
      const comp = r.race.comp[cellOf(r.race, game, game.ref(570, 10))];
      expect(comp).toBe(r.race.comp[cellOf(r.race, game, game.ref(650, 10))]);
      expect(reach.held[comp]).toBe(1);
      // Without held (the old test) the spit is a far candidate.
      const field = voyageField(game, r.race, [game.ref(59, 10)]);
      const far = (held: Uint8Array): FarReach => ({
        max: 1500,
        foodAt: () => 3000,
        minFood: 500,
        nation: { dist: reach.dist, held },
        front: 0.8,
        hold: 150,
      });
      const old = boatTargets(game, r.race, og, r.me, 8, {
        field,
        max: 400,
        far: far(new Uint8Array(reach.held.length)),
      });
      expect(old.some((t) => game.x(t.tile) <= 572)).toBe(true);
      const now = boatTargets(game, r.race, og, r.me, 8, {
        field,
        max: 400,
        far: far(reach.held),
      });
      expect(now).toHaveLength(0);
      decideOnce(r);
      expect(boats(r)).toHaveLength(0);
    }
    // With the nation's boat box too (the default).
    {
      const { r } = run(true);
      decideOnce(r);
      expect(boats(r)).toHaveLength(0);
    }
    // Without the nation the tribe gets its far boat.
    {
      const { game, r, b } = run(false);
      decideOnce(r);
      expect(boats(r)).toHaveLength(1);
      expect(game.owner(boats(r)[0].dst)).toBe(b);
    }
  });

  test("a far island within a nation's boat box (boatMidNationBoat) gets no far boat", () => {
    // farGame(60)'s map (us x 0-59, a free far island x 600-699) and a
    // nation on a small island (20 tiles wide, y 0-9) whose east shore
    // lies `gap` tiles west of the far island.
    const sent = (gap: number, box?: number) => {
      const x1 = 600 - gap;
      const game = synthGame(
        700,
        20,
        (x, y) => x < 60 || x >= 600 || (x >= x1 - 20 && x < x1 && y < 10),
      );
      const me = game.player(MY_ID);
      fill(game, me, 0, 60, 0, 20);
      me.setSpawnTile(game.ref(5, 10));
      const n = game.addPlayer(
        new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
      );
      fill(game, n, x1 - 20, x1, 0, 10);
      const r = rig(game, {
        boatsMidgame: true,
        boatMidFar: true,
        boatMidMinFood: 500,
        ...(box !== undefined ? { boatMidNationBoat: box } : {}),
      });
      r.me.setTroops(100_000);
      decideOnce(r);
      return boats(r).filter((x) => game.x(x.dst) >= 600).length;
    };
    // 131 tiles: inside the default ±150 box.
    expect(sent(131)).toBe(0);
    expect(sent(131, 0)).toBe(1);
    // 281 tiles: outside it.
    expect(sent(281)).toBe(1);
  });

  test("far targets only in the midgame: stall mode, or our landmass's food nearly gone (farTargets)", () => {
    const o = parseApexOptions({ boatsMidgame: true, boatMidFar: true });
    const v = { o, tick: 5000 } as unknown as View;
    const food = (left: number): LandmassFood => ({
      ours: new Set([0]),
      free: new Map([[0, left]]),
      tribe: new Map(),
    });
    const s = createState();
    s.spawn.endTick = 5000;
    // At age 0 we expect to take about 2,950 tiles in 300 ticks; twice that
    // is "nearly gone".
    expect(localFoodLow(v, s, food(10_000))).toBe(false);
    expect(localFoodLow(v, s, food(1_000))).toBe(true);
    expect(farTargets(v, s, food(10_000), "blocked")).toBe(false);
    expect(farTargets(v, s, food(10_000), "surplus")).toBe(false);
    expect(farTargets(v, s, food(1_000), "blocked")).toBe(true);
    expect(farTargets(v, s, food(10_000), "stall")).toBe(true);
    s.stall.since = 5000 - o.stallTicks;
    expect(farTargets(v, s, food(10_000), "blocked")).toBe(true);
    for (const over of [{ boatsMidgame: true }, { boatMidFar: true }]) {
      const off = { ...v, o: parseApexOptions(over) } as View;
      expect(farTargets(off, s, food(1_000), "stall")).toBe(false);
    }

    // Through decide: our landmass (x 0-249, y 0-29) holds a tribe of 7,200
    // tiles next to us; a far free island x 600-699. Troops idle at home
    // (a trigger holds), but the far island gets its boat only in stall
    // mode.
    const far = (stall: boolean) => {
      const game = synthGame(
        700,
        40,
        (x, y) => (x < 250 && y < 30) || x >= 600,
      );
      const me = game.player(MY_ID);
      fill(game, me, 0, 10, 0, 30);
      me.setSpawnTile(game.ref(5, 15));
      const b = game.addPlayer(
        new PlayerInfo("tribe", PlayerType.Bot, null, "BOT00001"),
      );
      fill(game, b, 10, 250, 0, 30);
      b.setTroops(1_000_000);
      const r = rig(game, {
        boatsMidgame: true,
        boatMidFar: true,
        boatMidMinFood: 500,
      });
      r.me.setTroops(400_000);
      if (stall) r.s.stall.since = game.ticks() - 1000;
      const v2 = view(r);
      const f = landmassFood(game, r.race, r.owners!, r.me);
      expect(localFoodLow(v2, r.s, f)).toBe(false);
      expect(boatTrigger(v2, r.s, f)).not.toBeNull();
      r.ctrl.decide(v2, r.s);
      r.scheduler.flush(
        (intent) => {
          r.sent.push(intent);
          return "ok";
        },
        r.ledger,
        v2.tick,
      );
      return boats(r).filter((x) => game.x(x.dst) >= 600).length;
    };
    expect(far(false)).toBe(0);
    expect(far(true)).toBe(1);
  });
});
