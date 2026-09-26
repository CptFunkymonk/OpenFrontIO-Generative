import type { AgentIntent, SendResult } from "../../../src/agent/Agent";
import { tribeSizing } from "../../../src/agent/agents/apex/controllers/ExpansionController";
import {
  beachheadFront,
  blocked,
  BOAT_TARGETS,
  boatTrigger,
  landmassFood,
  NavalController,
  PROBE_TTL,
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
} from "../../../src/agent/lib/RaceField";
import { createPurse, Scheduler } from "../../../src/agent/lib/Scheduler";
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
  r.ledger.observe(me, tick);
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
    for (const probesPer of [2, 1]) {
      const r = rig(game, probesPer === 2 ? {} : { boatProbes: probesPer });
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
});
