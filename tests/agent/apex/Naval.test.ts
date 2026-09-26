import type { AgentIntent, SendResult } from "../../../src/agent/Agent";
import {
  ExpansionController,
  tribeSizing,
} from "../../../src/agent/agents/apex/controllers/ExpansionController";
import {
  beachheadFront,
  blocked,
  BOAT_TARGETS,
  boatTrigger,
  busyTargets,
  freePocket,
  hostileWarships,
  landmassFood,
  NavalController,
  navalMemory,
  nearWarship,
  PROBE_TTL,
  tribeEaten,
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
  OwnerGrid,
  ownerGrid,
  RaceGrid,
  voyageAt,
  voyageField,
} from "../../../src/agent/lib/RaceField";
import { createPurse, Prio, Scheduler } from "../../../src/agent/lib/Scheduler";
import { scanWorld, WorldModel } from "../../../src/agent/lib/WorldModel";
import { Config } from "../../../src/core/configuration/Config";
import { Executor } from "../../../src/core/execution/ExecutionManager";
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
  TerrainType,
  UnitType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl, TileRef } from "../../../src/core/game/GameMap";
import { UserSettings } from "../../../src/core/game/UserSettings";
import { GameConfig, IntentSchema } from "../../../src/core/Schemas";
import { setup } from "../../util/Setup";

// NavalController (spec §3.7, §5.4; build step 6). The controller runs
// through a View built here as the policy builds it (scanWorld, HomeTarget
// floors, a Purse, the Scheduler with a real IntentBudget on the arena's
// game clock, the race grid and an OwnerGrid refreshed every 100 ticks), so
// the tests hold whatever the policy's wiring does. Intents go through
// IntentSchema and Executor.createExec, the path of ctx.send. Games use the
// real Config at Impossible; no PlayerExecution runs, so our troops stay
// where the test puts them. Tests may mutate the game; the agent never does.

const ME = seatClientID(0);
const MY_ID = "AGENTID1";
const GAME_ID = "NAVALGME";

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

// ── Synthetic maps (as the mechanics pins write them) ───────────────────

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
  // A minimap block is water if any of its tiles is (the generator's rule).
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

/** 4×4 islands at these top-left corners. */
function islands(corners: [number, number][]) {
  return (x: number, y: number) =>
    corners.some(([cx, cy]) => x >= cx && x < cx + 4 && y >= cy && y < cy + 4);
}

// ── The rig: a View as the policy builds it ─────────────────────────────

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
  executor: Executor;
  race: RaceGrid;
  owners: OwnerGrid | null;
  wm: WorldModel | null;
  ctrl: NavalController;
  /** Accepted sends, with the tick they were sent at. */
  sent: { tick: number; intent: AgentIntent }[];
  /** canBuild(TransportShip) calls per decide call. */
  probes: number[];
  /** Cells probed, with the tick. */
  probed: { tick: number; cell: number }[];
  /** Inside ctrl.decide (TransportShipExecution.init probes too). */
  deciding: boolean;
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
    executor: new Executor(game, GAME_ID, ME),
    race: buildRaceGrid(game, o),
    owners: null,
    wm: null,
    ctrl: new NavalController(),
    sent: [],
    probes: [],
    probed: [],
    deciding: false,
  };
  r.s.spawn.endTick = game.ticks();
  // Count the controller's probes (tests may wrap a game object).
  const canBuild = me.canBuild.bind(me);
  me.canBuild = (type, tile, valid) => {
    if (type === UnitType.TransportShip && r.deciding) {
      r.probes[r.probes.length - 1]++;
      r.probed.push({ tick: game.ticks(), cell: cellOf(r.race, game, tile) });
    }
    return canBuild(type, tile, valid);
  };
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

/** One agent tick (a decision every thinkEvery ticks), then one game tick. */
function tick(r: Rig): void {
  const v = view(r);
  r.ctrl.onTick(v, r.s);
  if (v.tick - r.s.timers.lastThink >= r.o.thinkEvery) {
    r.s.timers.lastThink = v.tick;
    r.probes.push(0);
    r.deciding = true;
    r.ctrl.decide(v, r.s);
    r.deciding = false;
  }
  const send = (intent: AgentIntent): SendResult => {
    expect(IntentSchema.safeParse(intent).success).toBe(true);
    if (!r.budget.tryConsume()) return "rate_limited";
    r.game.addExecution(
      r.executor.createExec({ ...intent, clientID: ME } as never),
    );
    r.sent.push({ tick: v.tick, intent });
    return "ok";
  };
  r.scheduler.flush(send, r.ledger, v.tick);
  r.game.executeNextTick();
}

const boats = (r: Rig) =>
  r.sent.filter((x) => x.intent.type === "boat") as {
    tick: number;
    intent: Extract<AgentIntent, { type: "boat" }>;
  }[];

beforeAll(() => {
  console.debug = () => {};
  console.warn = () => {};
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("NavalController", () => {
  test("ocean_and_land: blocked on the mainland, the island gets a boat within 100 ticks and becomes ours", async () => {
    // 16×16: mainland x 0-7 (all ours: no free land, no tribe), an island of
    // 6 tiles at x 14-15, y 6-8.
    const game = await setup(
      "ocean_and_land",
      GAME_CONFIG,
      [new PlayerInfo("agent", PlayerType.Human, ME, MY_ID)],
      undefined,
      Config,
    );
    const r = rig(game);
    fill(game, r.me, 0, 8, 0, 16);
    r.me.setSpawnTile(game.ref(3, 8));
    r.me.setTroops(60_000);
    const island: TileRef[] = [];
    for (let y = 6; y <= 8; y++) {
      for (let x = 14; x <= 15; x++) island.push(game.ref(x, y));
    }
    const start = game.ticks();
    const v = view(r);
    expect(v.wm.freeFrontier).toBe(0);
    expect(blocked(v)).toBe(true);
    expect(
      boatTrigger(v, r.s, landmassFood(game, r.race, r.owners!, r.me)),
    ).toBe("blocked");

    while (game.ticks() < start + 100) tick(r);
    const sent = boats(r);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0].tick - start).toBeLessThan(100);
    expect(island).toContain(sent[0].intent.dst);
    // Free land: max(tnSat·S_sat, min(avail/3, p_TN·islandFree)).
    expect(sent[0].intent.troops).toBeGreaterThanOrEqual(
      r.o.tnSat *
        r.models.tnSaturation({ plains: 1, highland: 0, mountain: 0 }) -
        1,
    );
    expect(r.s.log.some((l) => l.includes("boat (blocked)"))).toBe(true);
    expect(island.every((t) => game.ownerID(t) === r.me.smallID())).toBe(true);
    // The island was the only target: one boat, none after it fell.
    expect(sent).toHaveLength(1);
  });

  test("warships: no boat while a hostile warship guards the route; an ally's does not count, and the option turns the guard off", async () => {
    for (const mode of ["hostile", "allied", "off"] as const) {
      const game = await setup(
        "ocean_and_land",
        GAME_CONFIG,
        [new PlayerInfo("agent", PlayerType.Human, ME, MY_ID)],
        undefined,
        Config,
      );
      const r = rig(game, mode === "off" ? { boatAvoidWarships: false } : {});
      fill(game, r.me, 0, 8, 0, 16);
      r.me.setSpawnTile(game.ref(3, 8));
      r.me.setTroops(60_000);
      const navy = game.addPlayer(
        new PlayerInfo("navy", PlayerType.Nation, null, "NATION01"),
      );
      navy.conquer(game.ref(0, 0));
      // Mid-channel, between our shore (x 7) and the island (x 14-15). No
      // WarshipExecution runs, so it never moves or shoots.
      const sea = game.ref(11, 8);
      expect(game.isWater(sea)).toBe(true);
      navy.buildUnit(UnitType.Warship, sea, { patrolTile: sea });
      if (mode === "allied") navy.createAllianceRequest(r.me)!.accept();
      expect(hostileWarships(game, r.me)).toEqual(
        mode === "allied" ? [] : [11, 8],
      );
      const start = game.ticks();
      while (game.ticks() < start + 100) tick(r);
      if (mode === "hostile") {
        expect(boats(r)).toHaveLength(0);
        expect(r.s.log.some((l) => l.includes("guarded by 1 warships"))).toBe(
          true,
        );
      } else {
        expect(boats(r).length).toBeGreaterThanOrEqual(1);
      }
    }
    // The route test: distance from the segment, not from its ends.
    const game = synthGame(400, 10, (x) => x < 2);
    const a = game.ref(0, 0);
    const b = game.ref(399, 0);
    const range = game.config().warshipTargettingRange();
    expect(nearWarship(game, [200, 9], a, b, range)).toBe(true);
    expect(nearWarship(game, [200, 9], a, a, range)).toBe(false);
    expect(nearWarship(game, [], a, b, range)).toBe(false);
  });

  test("at most boatProbes canBuild probes per decision; a failed cell is not probed again for PROBE_TTL ticks", () => {
    // 96×32: us on x 0-15, ocean A x 16-23, a nation's strip x 24-31, then
    // ocean B (not connected to A) with 7 free islands we cannot reach.
    const isl = islands([
      [42, 4],
      [42, 24],
      [58, 4],
      [58, 24],
      [74, 4],
      [74, 24],
      [88, 14],
    ]);
    const game = synthGame(
      96,
      32,
      (x, y) => x < 16 || (x >= 24 && x < 32) || isl(x, y),
    );
    // The voyage field (o.boatVoyageScore) sees ocean B out of reach and
    // offers no target, so the probe cap is tested without it.
    for (const probesPer of [2, 1]) {
      const r = rig(
        game,
        probesPer === 2
          ? { boatVoyageScore: false }
          : { boatVoyageScore: false, boatProbes: probesPer },
      );
      if (r.me.numTilesOwned() === 0) {
        fill(game, r.me, 0, 16, 0, 32);
        r.me.setSpawnTile(game.ref(8, 16));
        const n = game.addPlayer(
          new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
        );
        fill(game, n, 24, 32, 0, 32);
      }
      r.me.setTroops(100_000);
      const v0 = view(r);
      expect(blocked(v0)).toBe(true);
      const targets = boatTargets(game, r.race, r.owners!, r.me, BOAT_TARGETS);
      expect(targets.length).toBeGreaterThanOrEqual(4);

      const start = game.ticks();
      while (game.ticks() < start + 600) tick(r);
      expect(boats(r)).toHaveLength(0);
      expect(Math.max(...r.probes)).toBeLessThanOrEqual(probesPer);
      expect(r.probed.length).toBeGreaterThan(probesPer);
      // Every probe of a cell is at least PROBE_TTL after its last one.
      const last = new Map<number, number>();
      for (const p of r.probed) {
        const prev = last.get(p.cell);
        if (prev !== undefined) {
          expect(p.tick - prev).toBeGreaterThanOrEqual(PROBE_TTL);
        }
        last.set(p.cell, p.tick);
      }
      // Some cell was probed again once its entry expired.
      expect(new Set(r.probed.map((p) => p.cell)).size).toBeLessThan(
        r.probed.length,
      );
      // Probes run only on boat decisions, every boatEvery ticks.
      const ticks = [...new Set(r.probed.map((p) => p.tick))];
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i] - ticks[i - 1]).toBeGreaterThanOrEqual(r.o.boatEvery);
      }
    }
    // With the voyage field no probe is spent on the unreachable ocean.
    const r = rig(game);
    r.me.setTroops(100_000);
    const start = game.ticks();
    while (game.ticks() < start + 300) tick(r);
    expect(r.probed).toHaveLength(0);
    expect(boats(r)).toHaveLength(0);
  });

  test("never more than boatMaxNumber at sea, one per island; water priority keeps them going", () => {
    // 96×32: us on x 0-15; one ocean with 9 free islands.
    const corners: [number, number][] = [
      [30, 4],
      [30, 24],
      [46, 4],
      [46, 24],
      [62, 4],
      [62, 24],
      [78, 4],
      [78, 24],
      [90, 14],
    ];
    const game = synthGame(96, 32, (x, y) => x < 16 || islands(corners)(x, y));
    // More probes than boats: the boatMaxNumber cap must bind.
    const r = rig(game, { boatProbes: 5 });
    fill(game, r.me, 0, 16, 0, 32);
    r.me.setSpawnTile(game.ref(8, 16));
    r.me.setTroops(1_000_000);
    const max = game.config().boatMaxNumber();
    let peak = 0;
    const start = game.ticks();
    while (game.ticks() < start + 900) {
      tick(r);
      const atSea = r.me.unitCount(UnitType.TransportShip);
      expect(atSea).toBeLessThanOrEqual(max);
      peak = Math.max(peak, atSea);
      // One boat per island at a time.
      const dst = r.me
        .units(UnitType.TransportShip)
        .map((u) => r.race.comp[cellOf(r.race, game, u.targetTile()!)]);
      expect(new Set(dst).size).toBe(dst.length);
    }
    expect(peak).toBe(max);
    expect(boats(r).length).toBeGreaterThan(max);
    // Water map (< 25% land): the trigger after the first islands fell.
    expect(r.s.log.some((l) => l.includes("boat (water)"))).toBe(true);
    // Every island is ours by the end.
    for (const [cx, cy] of corners) {
      expect(game.ownerID(game.ref(cx + 1, cy + 1))).toBe(r.me.smallID());
    }
  });

  test("a tribe island gets S_b + beachheadExtra; a tribe that does not fit is skipped for free land", () => {
    // 96×32: us on x 0-15; 144-tile islands of a weak tribe (x 28-39) and
    // a strong one (x 44-55), a free 16-tile island at x 70.
    const game = synthGame(
      96,
      32,
      (x, y) =>
        x < 16 ||
        (x >= 28 && x < 40 && y >= 10 && y < 22) ||
        (x >= 44 && x < 56 && y >= 10 && y < 22) ||
        islands([[70, 14]])(x, y),
    );
    const r = rig(game);
    fill(game, r.me, 0, 16, 0, 32);
    r.me.setSpawnTile(game.ref(8, 16));
    const weak = game.addPlayer(
      new PlayerInfo("weak", PlayerType.Bot, null, "TRIBE001"),
    );
    fill(game, weak, 28, 40, 10, 22);
    weak.setTroops(2_000);
    const strong = game.addPlayer(
      new PlayerInfo("strong", PlayerType.Bot, null, "TRIBE002"),
    );
    fill(game, strong, 44, 56, 10, 22);
    strong.setTroops(400_000);
    r.me.setTroops(100_000);

    const v = view(r);
    const sizing = (b: Player) =>
      tribeSizing(
        r.models,
        r.me.numTilesOwned(),
        {
          tiles: b.numTilesOwned(),
          troops: b.troops(),
          isTraitor: false,
          contact: beachheadFront(b.numTilesOwned()),
          contactMix: { plains: 1, highland: 0, mountain: 0 },
        },
        r.models.regrowth(b),
        r.o.tribeRatio,
        r.o,
      );
    const wantWeak = Math.ceil(sizing(weak).S + r.o.beachheadExtra);
    expect(wantWeak).toBeLessThan(v.purse.available("boat"));
    expect(sizing(strong).S + r.o.beachheadExtra).toBeGreaterThan(
      v.purse.available("boat"),
    );
    expect(game.terrainType(game.ref(31, 11))).toBe(TerrainType.Plains);

    r.ctrl.decide(v, r.s);
    r.scheduler.flush(
      (intent) => {
        r.sent.push({ tick: v.tick, intent });
        return "ok";
      },
      r.ledger,
      v.tick,
    );
    const sent = boats(r);
    const toWeak = sent.filter(
      (b) => game.ownerID(b.intent.dst) === weak.smallID(),
    );
    const toStrong = sent.filter(
      (b) => game.ownerID(b.intent.dst) === strong.smallID(),
    );
    const toFree = sent.filter((b) => game.ownerID(b.intent.dst) === 0);
    expect(toWeak).toHaveLength(1);
    expect(toWeak[0].intent.troops).toBe(wantWeak);
    expect(toStrong).toHaveLength(0);
    expect(toFree.length).toBeLessThanOrEqual(1);
    // The tribe landing is a "boat" plan on the tribe.
    expect(r.ledger.plan(weak.smallID())?.kind).toBe("boat");
  });

  test("blocked: no free land and no tribe the allocator could launch at", () => {
    // 96×32: us x 0-15, a tribe on x 16-39 (the rest of our landmass, 768
    // tiles: F = 0), a free island at x 70.
    const game = synthGame(
      96,
      32,
      (x, y) => x < 40 || islands([[70, 14]])(x, y),
    );
    const me = game.player(MY_ID);
    fill(game, me, 0, 16, 0, 32);
    me.setSpawnTile(game.ref(8, 16));
    me.setTroops(100_000);
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "TRIBE001"),
    );
    fill(game, tribe, 16, 40, 0, 32);
    const check = (troops: number, over: Record<string, unknown> = {}) => {
      tribe.setTroops(troops);
      const r = rig(game, over);
      const v = view(r);
      expect(v.wm.freeFrontier).toBe(0);
      expect(v.wm.tribes.map((t) => t.smallID)).toEqual([tribe.smallID()]);
      return blocked(v);
    };
    // Affordable (S_b well under the Purse): the allocator launches, so
    // no boat is due.
    expect(check(1_000)).toBe(false);
    // S_b ≈ 1.1·D/0.6 far over the Purse: blocked.
    expect(check(1_000_000)).toBe(true);
    // Allocator tribes off: nothing launches at it.
    expect(check(1_000, { tribes: false })).toBe(true);
    expect(check(1_000, { expansion: false })).toBe(true);
  });

  test("gates: boats off, too few troops, all boats at sea, free land bordering us", () => {
    // 200×100: land x 0-119, y 10-99 (54% of the map), ours its east end
    // x 104-119 (on the ocean at x 119 and y 10), the rest free: F > 0, and
    // 9,360 free tiles on our landmass, with a free north coast; a free
    // island at x 160.
    const game = synthGame(
      200,
      100,
      (x, y) => (x < 120 && y >= 10) || islands([[160, 48]])(x, y),
    );
    const me = game.player(MY_ID);
    fill(game, me, 104, 120, 10, 100);
    me.setSpawnTile(game.ref(112, 50));
    me.setTroops(100_000);
    const run = (over: Record<string, unknown>) => {
      const r = rig(game, over);
      const v = view(r);
      r.ctrl.decide(v, r.s);
      r.scheduler.flush(
        (intent) => {
          r.sent.push({ tick: v.tick, intent });
          return "ok";
        },
        r.ledger,
        v.tick,
      );
      return { r, v };
    };
    // Land map (> 25% land) with free land bordering us and plenty on our
    // landmass: no trigger.
    const base = run({});
    expect(base.v.wm.freeFrontier).toBeGreaterThan(0);
    expect(
      boatTrigger(
        base.v,
        base.r.s,
        landmassFood(game, base.r.race, base.r.owners!, me),
      ),
    ).toBe(null);
    expect(boats(base.r)).toHaveLength(0);
    // Water priority by map share: the island gets a boat alongside.
    const water = run({ waterMapLand: 0.9 });
    expect(boats(water.r)).toHaveLength(1);
    // ...and only to another landmass.
    const dst = boats(water.r)[0].intent.dst;
    expect(game.x(dst)).toBeGreaterThanOrEqual(160);
    expect(boats(run({ waterMapLand: 0.9, boats: false }).r)).toHaveLength(0);
    expect(
      boats(run({ waterMapLand: 0.9, boatMinTroops: 90_000 }).r),
    ).toHaveLength(0);
  });

  test("a tribe that a nation eats gets no boat (the landing would be the nation's by launch or during the voyage)", () => {
    // 96×32: us x 0-15; an island of a weak tribe (x 40-51) that a rich
    // nation (x 52-59) touches.
    const game = synthGame(
      96,
      32,
      (x, y) => x < 16 || (x >= 40 && x < 60 && y >= 10 && y < 22),
    );
    const me = game.player(MY_ID);
    fill(game, me, 0, 16, 0, 32);
    me.setSpawnTile(game.ref(8, 16));
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "TRIBE001"),
    );
    fill(game, tribe, 40, 52, 10, 22);
    tribe.setTroops(2_000);
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
    );
    fill(game, nation, 52, 60, 10, 22);
    nation.setTroops(400_000);
    const run = (over: Record<string, unknown>) => {
      me.setTroops(100_000);
      const r = rig(game, over);
      const start = game.ticks();
      while (game.ticks() < start + 30) tick(r);
      return r;
    };
    const eaten = run({});
    expect(boats(eaten)).toHaveLength(0);
    expect(navalMemory(eaten.s).stats.eaten).toBeGreaterThan(0);
    const v = view(eaten);
    const land = game.ref(40, 15);
    expect(tribeEaten(v, tribe, land)).toMatch(/can eat it/);
    // A poor nation next to it: only the radius rule, at the far shore.
    nation.setTroops(100);
    expect(tribeEaten(v, tribe, land)).toBeNull();
    expect(tribeEaten(v, tribe, game.ref(51, 10))).toMatch(/near the landing/);
    nation.setTroops(400_000);
    // Off: the boat goes to the tribe.
    const off = run({ boatAvoidEatenTribes: false });
    expect(
      boats(off).filter((b) => {
        const x = game.x(b.intent.dst);
        return x >= 40 && x < 52;
      }),
    ).toHaveLength(1);
  });

  test("a boat whose landing a nation takes during the voyage is turned back (boatCancelOnFlip)", () => {
    for (const on of [true, false]) {
      // 96×32: us x 0-15; a tribe island x 70-81; a nation's islet x 90-95.
      const game = synthGame(
        96,
        32,
        (x, y) => x < 16 || (x >= 70 && x < 82 && y >= 10 && y < 22) || x >= 90,
      );
      const r = rig(game, on ? {} : { boatCancelOnFlip: false });
      fill(game, r.me, 0, 16, 0, 32);
      r.me.setSpawnTile(game.ref(8, 16));
      r.me.setTroops(100_000);
      const tribe = game.addPlayer(
        new PlayerInfo("tribe", PlayerType.Bot, null, "TRIBE001"),
      );
      fill(game, tribe, 70, 82, 10, 22);
      tribe.setTroops(2_000);
      const nation = game.addPlayer(
        new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
      );
      fill(game, nation, 90, 96, 0, 32);
      const start = game.ticks();
      while (
        game.ticks() < start + 40 &&
        r.me.unitCount(UnitType.TransportShip) === 0
      ) {
        tick(r);
      }
      const ship = r.me.units(UnitType.TransportShip)[0];
      expect(ship).toBeDefined();
      const dst = ship.targetTile()!;
      expect(game.ownerID(dst)).toBe(tribe.smallID());
      expect(game.manhattanDist(ship.tile(), dst)).toBeGreaterThanOrEqual(20);
      // The nation takes the landing tile (the test's hand).
      nation.conquer(dst);
      for (let i = 0; i < 5; i++) tick(r);
      const cancels = r.sent.filter((x) => x.intent.type === "cancel_boat");
      if (on) {
        expect(cancels).toHaveLength(1);
        expect(cancels[0].intent).toEqual({
          type: "cancel_boat",
          unitID: ship.id(),
        });
        expect(ship.transportShipState().isRetreating).toBe(true);
        expect(r.s.log.some((l) => l.includes("boat cancel"))).toBe(true);
      } else {
        expect(cancels).toHaveLength(0);
        expect(ship.transportShipState().isRetreating).toBe(false);
      }
    }
  });

  test("busy targets: tribes that border us, this decision's land launch, and a landed free-land boat's landmass", () => {
    // 96×32: us x 0-15 (on the ocean at y 16-31), a tribe x 16-23, y 0-15
    // bordering us, a free island at x 60.
    const game = synthGame(
      96,
      32,
      (x, y) => x < 16 || (x < 24 && y < 16) || islands([[60, 14]])(x, y),
    );
    const r = rig(game);
    fill(game, r.me, 0, 16, 0, 32);
    r.me.setSpawnTile(game.ref(8, 16));
    r.me.setTroops(100_000);
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "TRIBE001"),
    );
    fill(game, tribe, 16, 24, 0, 16);
    const sid = tribe.smallID();
    const v = view(r);
    expect(v.wm.tribes.map((t) => t.smallID)).toEqual([sid]);
    // Default: the land allocator's (not on water priority).
    expect(busyTargets(v, r.race, "blocked").tribes.has(sid)).toBe(true);
    expect(busyTargets(v, r.race, "water").tribes.has(sid)).toBe(false);
    // With boatBorderTribes, only a land launch this decision makes it busy.
    const r2 = rig(game, { boatBorderTribes: true });
    const v2 = view(r2);
    expect(busyTargets(v2, r2.race, "stall").tribes.has(sid)).toBe(false);
    expect(
      v2.scheduler.offer({
        intent: { type: "attack", targetID: tribe.id(), troops: 1000 },
        prio: Prio.Tribe,
        cls: "tribe",
        key: `attack:${sid}`,
      }),
    ).toBe(true);
    expect(busyTargets(v2, r2.race, "stall").tribes.has(sid)).toBe(true);
    expect(blocked(v2)).toBe(false);

    // A free-land boat to the island: its landmass stays busy while it
    // sails and boatLandmassHold ticks after it landed.
    const island = r.race.comp[cellOf(r.race, game, game.ref(61, 15))];
    tribe.setTroops(1_000_000); // too strong to launch at: blocked
    const r3 = rig(game);
    let landed = -1;
    const start = game.ticks();
    while (game.ticks() < start + 300) {
      tick(r3);
      const gone = r3.ledger.allShips().find((x) => x.goneAt !== null);
      if (gone !== undefined) {
        landed = gone.goneAt!;
        break;
      }
    }
    expect(landed).toBeGreaterThan(0);
    expect(boats(r3)).toHaveLength(1);
    const now = view(r3);
    expect(busyTargets(now, r3.race, "blocked").comps.has(island)).toBe(true);
    while (game.ticks() <= landed + r3.o.boatLandmassHold) {
      game.executeNextTick();
    }
    const later = view(r3);
    expect(busyTargets(later, r3.race, "blocked").comps.has(island)).toBe(
      false,
    );
  });

  test("voyages: the field follows the sea route; a target past boatMaxVoyage gets no boat", () => {
    // 400×20: us x 0-9, an island at x 380-383 (a 370-tile voyage).
    const game = synthGame(
      400,
      20,
      (x, y) => x < 10 || islands([[380, 8]])(x, y),
    );
    const run = (over: Record<string, unknown>) => {
      const r = rig(game, over);
      if (r.me.numTilesOwned() === 0) {
        fill(game, r.me, 0, 10, 0, 20);
        r.me.setSpawnTile(game.ref(5, 10));
      }
      r.me.setTroops(100_000);
      const v = view(r);
      const f = voyageField(game, r.race, v.wm.shoreSample);
      const d = voyageAt(f, r.race, cellOf(r.race, game, game.ref(380, 9)));
      r.ctrl.decide(v, r.s);
      r.scheduler.flush(
        (intent) => {
          r.sent.push({ tick: v.tick, intent });
          return "ok";
        },
        r.ledger,
        v.tick,
      );
      return { r, d };
    };
    const far = run({});
    // About the 370 tiles of open sea (a cell is 3 tiles here).
    expect(far.d).toBeGreaterThanOrEqual(360);
    expect(far.d).toBeLessThanOrEqual(380);
    expect(boats(far.r)).toHaveLength(1);
    expect(boats(run({ boatMaxVoyage: 300 }).r)).toHaveLength(0);
    expect(
      boats(run({ boatVoyageScore: false, boatMaxVoyage: 300 }).r),
    ).toHaveLength(1);
  });

  test("route precheck: a warship on the route from our nearest shore skips the target with no canBuild probe", () => {
    // 400×20: us x 0-9, an island at x 380; a warship mid-way on the route
    // (190 tiles from the landing, out of reach of the landing check).
    for (const precheck of [true, false]) {
      const game = synthGame(
        400,
        20,
        (x, y) =>
          x < 10 ||
          islands([
            [380, 8],
            [396, 0],
          ])(x, y),
      );
      const r = rig(game, { boatRoutePrecheck: precheck });
      fill(game, r.me, 0, 10, 0, 20);
      r.me.setSpawnTile(game.ref(5, 10));
      r.me.setTroops(100_000);
      const navy = game.addPlayer(
        new PlayerInfo("navy", PlayerType.Nation, null, "NATION01"),
      );
      navy.conquer(game.ref(398, 1));
      const sea = game.ref(190, 10);
      navy.buildUnit(UnitType.Warship, sea, { patrolTile: sea });
      const start = game.ticks();
      while (game.ticks() < start + 60) tick(r);
      expect(boats(r)).toHaveLength(0);
      if (precheck) {
        expect(r.probed).toHaveLength(0);
        expect(navalMemory(r.s).stats.prechecks).toBeGreaterThan(0);
      } else {
        expect(r.probed.length).toBeGreaterThan(0);
      }
    }
  });

  test("free-land sizing: the pocket at the landing, and on our own landmass only tnSat·S_sat", () => {
    // 96×32: land y 4-31 with ocean above; us x 0-15, a nation x 16-47
    // (F = 0), free land x 48-95 behind it on our landmass.
    const game = synthGame(96, 32, (_x, y) => y >= 4);
    const troopsWith = (over: Record<string, unknown>) => {
      const r = rig(game, over);
      if (r.me.numTilesOwned() === 0) {
        fill(game, r.me, 0, 16, 4, 32);
        r.me.setSpawnTile(game.ref(8, 16));
        const n = game.addPlayer(
          new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
        );
        fill(game, n, 16, 48, 4, 32);
      }
      r.me.setTroops(100_000);
      const v = view(r);
      expect(v.wm.freeFrontier).toBe(0);
      r.ctrl.decide(v, r.s);
      r.scheduler.flush(
        (intent) => {
          r.sent.push({ tick: v.tick, intent });
          return "ok";
        },
        r.ledger,
        v.tick,
      );
      const b = boats(r);
      expect(b).toHaveLength(1);
      expect(game.x(b[0].intent.dst)).toBeGreaterThanOrEqual(48);
      return { troops: b[0].intent.troops, r };
    };
    const plains = { plains: 1, highland: 0, mountain: 0 };
    const pocket = troopsWith({});
    const sat = pocket.r.o.tnSat * pocket.r.models.tnSaturation(plains);
    expect(pocket.troops).toBe(Math.floor(sat));
    const whole = troopsWith({ boatPocket: false });
    expect(whole.troops).toBeGreaterThan(1.5 * sat);
    // freePocket counts the connected free land, up to its limit.
    const t = game.ref(60, 10);
    expect(freePocket(game, t, 100)).toBe(100);
    expect(freePocket(game, t, 1e6)).toBe(48 * 28);
    expect(freePocket(game, game.ref(5, 10), 100)).toBe(0);
  });

  test("boat headroom: a tribe landing whose refund would come home over the cap waits, outside stall", () => {
    const game = synthGame(
      96,
      32,
      (x, y) => x < 16 || (x >= 28 && x < 40 && y >= 10 && y < 22),
    );
    const me = game.player(MY_ID);
    fill(game, me, 0, 16, 0, 32);
    me.setSpawnTile(game.ref(8, 16));
    const weak = game.addPlayer(
      new PlayerInfo("weak", PlayerType.Bot, null, "TRIBE001"),
    );
    fill(game, weak, 28, 40, 10, 22);
    weak.setTroops(2_000);
    const run = (over: Record<string, unknown>) => {
      const r = rig(game, over);
      // Home far over the cap: every refund would be cut.
      me.setTroops(3 * r.models.cap(me));
      const v = view(r);
      r.ctrl.decide(v, r.s);
      r.scheduler.flush(
        (intent) => {
          r.sent.push({ tick: v.tick, intent });
          return "ok";
        },
        r.ledger,
        v.tick,
      );
      return r;
    };
    const held = run({});
    expect(boats(held)).toHaveLength(0);
    expect(navalMemory(held.s).stats.headroom).toBeGreaterThan(0);
    expect(boats(run({ boatHeadroom: false }))).toHaveLength(1);
  });

  test("blocked() agrees with the allocator: a tribe whose counter-attack the launch must also cancel does not fit", () => {
    // 96×32: us x 0-15, a tribe on x 16-39 (F = 0), a free island at x 70.
    const game = synthGame(
      96,
      32,
      (x, y) => x < 40 || islands([[70, 14]])(x, y),
    );
    const me = game.player(MY_ID);
    fill(game, me, 0, 16, 0, 32);
    me.setSpawnTile(game.ref(8, 16));
    me.setTroops(100_000);
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "TRIBE001"),
    );
    fill(game, tribe, 16, 40, 0, 32);
    tribe.setTroops(3_000);
    const r = rig(game);
    const v = view(r);
    expect(blocked(v)).toBe(false);
    // Its attack on us, as the scan would list it: the launch must carry
    // it on top (it cancels 1:1 at init) and no longer fits.
    const avail = v.purse.available("tribe");
    v.wm.incoming.push({
      id: "counter",
      attackerSmallID: tribe.smallID(),
      attackerType: PlayerType.Bot,
      troops: avail,
      boat: false,
      firstSeen: v.tick,
    });
    expect(blocked(v)).toBe(true);
    // The allocator, on the same View, launches nothing at it either.
    new ExpansionController().decide(v, r.s);
    expect(v.scheduler.hasKey(`attack:${tribe.smallID()}`)).toBe(false);
  });
});
