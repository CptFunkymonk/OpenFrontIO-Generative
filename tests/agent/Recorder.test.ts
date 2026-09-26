import path from "path";
import { runArenaGame } from "../../src/agent/arena/ArenaGame";
import {
  ArenaRecorder,
  AttackLog,
  AttackSighting,
  AttackTick,
  BoatSighting,
  IncomingLog,
  MAX_ATTACK_RECORDS,
  median,
  PlayerLookup,
  STANDING_MINUTES,
  standingPoint,
} from "../../src/agent/arena/Recorder";
import { AttackExecution } from "../../src/core/execution/AttackExecution";
import { NukeExecution } from "../../src/core/execution/NukeExecution";
import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import { TransportShipExecution } from "../../src/core/execution/TransportShipExecution";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { setup } from "../util/Setup";
import { constructionExecution } from "../util/utils";

const MAPS = path.join(__dirname, "../testdata/maps");
const TIMEOUT = 120_000;

describe("standings", () => {
  test("median counts every value, dead nations as 0", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([0, 0, 0.2, 0.4])).toBe(0.1);
  });

  test("rank, median and top nation over the whole field", () => {
    const field = [
      { name: "me", nation: false, share: 0.1 },
      { name: "other human", nation: false, share: 0.3 },
      { name: "big", nation: true, share: 0.2 },
      { name: "small", nation: true, share: 0.05 },
      { name: "dead", nation: true, share: 0 },
      { name: "dead too", nation: true, share: 0 },
    ];
    expect(standingPoint(3, 1800, 0.1, field)).toEqual({
      minute: 3,
      tick: 1800,
      share: 0.1,
      rank: 3,
      players: 6,
      nationsAlive: 2,
      medianNationShare: 0.025,
      topNation: { name: "big", share: 0.2 },
    });
    // Eliminated: behind everyone with land, level with the dead.
    const out = standingPoint(10, 6000, 0, field);
    expect(out.rank).toBe(5);
    expect(standingPoint(1, 600, 0.5, field.slice(0, 2)).topNation).toBeNull();
  });
});

const TN = { name: "TerraNullius", type: "TerraNullius" };

function lookup(dead: Set<number> = new Set()): PlayerLookup {
  return {
    describe: (id) =>
      id === 0 ? TN : { name: `P${id}`, type: PlayerType.Nation },
    alive: (id) => !dead.has(id),
  };
}

function observe(log: AttackLog, tick: number, t: Partial<AttackTick>) {
  log.observe({
    tick,
    attacks: [],
    boats: [],
    counters: new Set(),
    gains: [],
    ...t,
  });
}

function land(
  id: string,
  target: number,
  troops: number,
  retreating = false,
): AttackSighting {
  return { id, target, sourceTile: null, troops, retreating };
}

function landed(id: string, target: number, tile: number, troops: number) {
  return { id, target, sourceTile: tile, troops, retreating: false };
}

function boat(
  unit: number,
  target: number,
  dst: number,
  troops: number,
  retreating = false,
): BoatSighting {
  return { unit, target, dst, troops, retreating };
}

describe("AttackLog", () => {
  test("a land attack gains tiles from its target while active", () => {
    const log = new AttackLog(lookup());
    observe(log, 1, {
      attacks: [land("a", 0, 100)],
      gains: [10, 0, 11, 0, 12, 5], // tile 12 came from someone else
    });
    observe(log, 2, { attacks: [land("a", 0, 60)], gains: [13, 0] });
    // Gone after this tick, but it was active during it.
    observe(log, 3, { gains: [14, 0] });
    observe(log, 4, { gains: [15, 0] });
    expect(log.records).toEqual([
      {
        id: "a",
        startTick: 1,
        endTick: 3,
        target: TN,
        boat: false,
        troopsSent: 100,
        tilesGained: 4,
        end: "exhausted",
      },
    ]);
  });

  test("a new land attack on the same target continues the record", () => {
    const log = new AttackLog(lookup());
    observe(log, 1, { attacks: [land("a", 7, 100), land("o", 8, 10)] });
    observe(log, 2, { attacks: [land("a", 7, 80), land("o", 8, 10)] });
    // "b" absorbed a's 80 troops and added 50.
    observe(log, 3, {
      attacks: [land("b", 7, 130), land("o", 8, 10)],
      gains: [1, 7],
    });
    observe(log, 4, { attacks: [land("b", 7, 120, true)] });
    observe(log, 5, {});
    expect(log.records.map((r) => [r.id, r.troopsSent, r.tilesGained])).toEqual(
      [
        ["a", 150, 1],
        ["o", 10, 0],
      ],
    );
    expect(log.records[0]).toMatchObject({ end: "retreated", endTick: 5 });
    expect(log.records[1]).toMatchObject({ end: "exhausted", endTick: 4 });
  });

  test("an attack ends countered or with its target dead", () => {
    const log = new AttackLog(lookup(new Set([8])));
    observe(log, 1, { attacks: [land("a", 7, 100), land("b", 8, 100)] });
    observe(log, 2, { counters: new Set([7]) });
    expect(log.records.map((r) => r.end)).toEqual(["countered", "target_dead"]);
  });

  test("a boat carries on into the attack it lands", () => {
    const log = new AttackLog(lookup());
    observe(log, 1, {
      attacks: [land("l", 7, 100)],
      boats: [boat(42, 7, 500, 300)],
    });
    observe(log, 2, {
      attacks: [land("l", 7, 100)],
      boats: [boat(42, 7, 500, 300)],
    });
    // Landed: the landing tile is the boat's, the rest the land attack's.
    observe(log, 3, {
      attacks: [land("l", 7, 90), landed("x", 7, 500, 300)],
      gains: [500, 7, 501, 7],
    });
    observe(log, 4, {
      attacks: [land("l", 7, 90), landed("x", 7, 500, 280)],
      gains: [502, 7],
    });
    observe(log, 5, { attacks: [landed("x", 7, 500, 280)] });
    // Without a land attack on the target, its gains go to the boat.
    observe(log, 6, { attacks: [landed("x", 7, 500, 270)], gains: [503, 7] });
    observe(log, 7, { counters: new Set([7]) });
    expect(log.records).toEqual([
      {
        id: "l",
        startTick: 1,
        endTick: 5,
        target: { name: "P7", type: PlayerType.Nation },
        boat: false,
        troopsSent: 100,
        tilesGained: 2,
        end: "exhausted",
      },
      {
        id: "boat:42",
        startTick: 1,
        endTick: 7,
        target: { name: "P7", type: PlayerType.Nation },
        boat: true,
        troopsSent: 300,
        tilesGained: 2,
        end: "countered",
      },
    ]);
  });

  test("a boat that sinks, turns back, or lands without an attack", () => {
    const log = new AttackLog(lookup());
    observe(log, 1, {
      boats: [boat(1, 7, 100, 10), boat(2, 7, 200, 10), boat(3, 7, 300, 10)],
    });
    observe(log, 2, {
      boats: [
        boat(1, 7, 100, 10),
        boat(2, 7, 50, 10, true),
        boat(3, 7, 300, 10),
      ],
    });
    // 1 sinks, 2 gets home, 3 lands on a friend: the tile, no attack.
    observe(log, 3, { gains: [300, 7] });
    expect(
      log.records.map((r) => [r.id, r.end, r.endTick, r.tilesGained]),
    ).toEqual([
      ["boat:1", "exhausted", 3, 0],
      ["boat:2", "retreated", 3, 0],
      ["boat:3", "exhausted", 3, 1],
    ]);
  });

  test("a land attack that absorbs a boat's attack continues its record", () => {
    const log = new AttackLog(lookup());
    observe(log, 1, { boats: [boat(5, 7, 900, 200)] });
    observe(log, 2, { attacks: [landed("x", 7, 900, 200)] });
    // "n" absorbed x's 200 and added 150.
    observe(log, 3, { attacks: [land("n", 7, 350)], gains: [901, 7] });
    expect(log.records).toHaveLength(1);
    expect(log.records[0]).toMatchObject({
      id: "boat:5",
      boat: true,
      troopsSent: 350,
      tilesGained: 1,
      end: "running",
      endTick: null,
    });
  });

  test("with a land record too, both ride in the absorbing attack", () => {
    const log = new AttackLog(lookup());
    observe(log, 1, {
      attacks: [land("l", 7, 100)],
      boats: [boat(6, 7, 800, 50)],
    });
    observe(log, 2, { attacks: [land("l", 7, 90), landed("x", 7, 800, 50)] });
    // "n" absorbed 90 + 50 and added 100.
    observe(log, 3, { attacks: [land("n", 7, 240)], gains: [801, 7] });
    observe(log, 4, { counters: new Set([7]) });
    expect(
      log.records.map((r) => [r.id, r.troopsSent, r.tilesGained, r.end]),
    ).toEqual([
      ["l", 200, 1, "countered"],
      ["boat:6", 50, 0, "countered"],
    ]);
  });

  test("keeps the first MAX_ATTACK_RECORDS records and counts the rest", () => {
    const log = new AttackLog(lookup());
    const n = MAX_ATTACK_RECORDS + 5;
    // Distinct targets, so no attack absorbs the one before.
    for (let i = 0; i < n; i++) {
      observe(log, i + 1, { attacks: [land(`a${i}`, i + 1, 10)] });
    }
    const last = land(`a${n - 1}`, n, 10);
    observe(log, n + 1, { attacks: [last] });
    observe(log, n + 2, { attacks: [last] });
    expect(log.records).toHaveLength(MAX_ATTACK_RECORDS);
    expect(log.dropped).toBe(5);
    expect(log.records[MAX_ATTACK_RECORDS - 1].end).toBe("exhausted");
  });
});

describe("IncomingLog", () => {
  test("counts each launch once, and only the troops it added", () => {
    const log = new IncomingLog();
    const nation = (id: string, troops: number) => ({
      id,
      attacker: 3,
      attackerType: PlayerType.Nation,
      troops,
      boat: false,
    });
    expect([...log.observe([nation("a", 100)])]).toEqual([3]);
    expect([...log.observe([nation("a", 80)])]).toEqual([]);
    // "b" absorbed a's 80; a bot's boat lands (counted when it sailed).
    const landing = {
      id: "c",
      attacker: 4,
      attackerType: PlayerType.Bot,
      troops: 20,
      boat: true,
    };
    expect([...log.observe([nation("b", 130), landing])]).toEqual([3, 4]);
    log.launched(PlayerType.Human, 70);
    expect(log.attacks).toEqual({ nation: 2, bot: 0, human: 1 });
    expect(log.attackTroops).toEqual({ nation: 150, bot: 0, human: 70 });
  });
});

describe("ArenaRecorder", () => {
  // ocean_and_land: land in columns 0-7 with a shore at x = 7, and a
  // 7-tile island around (15, 7).
  async function islandGame() {
    const game = await setup("ocean_and_land", {
      infiniteGold: true,
      instantBuild: true,
      infiniteTroops: true,
    });
    const infoA = new PlayerInfo("seat a", PlayerType.Human, null, "seat_a");
    const infoB = new PlayerInfo("seat b", PlayerType.Human, null, "seat_b");
    game.addPlayer(infoA);
    game.addPlayer(infoB);
    game.addExecution(
      new SpawnExecution("game_id", infoA, game.ref(3, 7)),
      new SpawnExecution("game_id", infoB, game.ref(15, 7)),
    );
    const a = game.player(infoA.id);
    const b = game.player(infoB.id);
    const recorder = new ArenaRecorder(game, [a, b]);
    let out = false;
    const step = () => {
      const updates = game.executeNextTick();
      recorder.update({
        tick: game.ticks(),
        updates,
        packedTileUpdates: game.drainPackedTileUpdates(),
      });
      recorder.afterTick();
      if (!out && b.hasSpawned() && !b.isAlive()) {
        out = true;
        recorder.eliminated(1);
      }
    };
    step();
    step();
    return { game, a, b, recorder, step };
  }

  function expectOwnersInSync(game: Game, recorder: ArenaRecorder) {
    const owner = (recorder as unknown as { owner: Uint16Array }).owner;
    let mismatches = 0;
    for (let t = 0; t < game.width() * game.height(); t++) {
      if (owner[t] !== game.ownerID(t)) mismatches++;
    }
    expect(mismatches).toBe(0);
  }

  test("a boat invasion: its record, the defender's side, who eliminated it", async () => {
    const { game, a, b, recorder, step } = await islandGame();
    game.addExecution(new AttackExecution(1000, a, game.terraNullius().id()));
    for (let i = 0; i < 30; i++) step();
    const islandTiles = b.numTilesOwned();
    expect(islandTiles).toBeGreaterThan(0);

    game.addExecution(new TransportShipExecution(a, game.ref(14, 7), 5000));
    for (let i = 0; i < 200 && b.isAlive(); i++) step();
    expect(b.isAlive()).toBe(false);
    for (let i = 0; i < 5; i++) step();

    const attacks = recorder.records(0).attacks;
    expect(attacks[0]).toMatchObject({ target: TN, boat: false });
    expect(attacks[0].tilesGained).toBeGreaterThan(0);
    expect(attacks[1]).toMatchObject({
      target: { name: "seat b", type: PlayerType.Human },
      boat: true,
      troopsSent: 5000,
      tilesGained: islandTiles,
      end: "target_dead",
    });
    expect(attacks[1].id).toMatch(/^boat:/);

    const received = recorder.records(1).received;
    expect(received.attacks).toEqual({ nation: 0, bot: 0, human: 1 });
    expect(received.attackTroops.human).toBe(5000);
    expect(received.eliminatedBy).toEqual({
      name: "seat a",
      type: PlayerType.Human,
    });
    expect(recorder.records(0).received.attacks.human).toBe(0);
    expectOwnersInSync(game, recorder);
  });

  test("a nuke aimed at a seat's land counts once, for that seat", async () => {
    const { game, a, recorder, step } = await islandGame();
    constructionExecution(game, a, 3, 7, UnitType.MissileSilo, 0);
    for (let i = 0; i < 5; i++) step();
    expect(a.units(UnitType.MissileSilo)).toHaveLength(1);

    game.addExecution(
      new NukeExecution(UnitType.AtomBomb, a, game.ref(15, 7), null),
    );
    let launched: number | null = null;
    for (let i = 0; i < 60; i++) {
      step();
      if (launched === null && a.units(UnitType.AtomBomb).length > 0) {
        launched = game.ticks(); // as the arena counts: ticks executed
      }
    }
    expect(launched).not.toBeNull();
    const received = recorder.records(1).received;
    expect(received.nukes).toEqual({
      atom: 1,
      hydrogen: 0,
      mirv: 0,
      mirvWarhead: 0,
    });
    expect(received.firstNukeTick).toBe(launched);
    expect(recorder.records(0).received.nukes.atom).toBe(0);
    expectOwnersInSync(game, recorder);
  });
});

describe("arena records", () => {
  beforeAll(() => {
    console.debug = () => {};
  });

  test(
    "standings, attacks and received counts from a real game",
    async () => {
      const r = await runArenaGame(
        {
          index: 0,
          gameID: "RECORDTS",
          map: GameMapType.World,
          mapSize: GameMapSize.Compact,
          difficulty: Difficulty.Impossible,
          nations: 4,
          bots: 10,
          gameType: GameType.Singleplayer,
          seats: [{ agent: "baseline" }],
          maxTicks: 1900,
          latencyTicks: 1,
          rateLimit: true,
          isolate: false,
          timelineEvery: 100,
          playOut: false,
          strict: true,
          imagesDir: null,
          imageEvery: 0,
        },
        MAPS,
      );
      expect(r.error).toBeNull();
      const seat = r.seats[0];
      const reached = STANDING_MINUTES.filter((m) => m * 600 <= r.ticks);
      expect(seat.standings!.map((p) => p.minute)).toEqual(reached);
      for (const p of seat.standings!) {
        expect(p.tick).toBe(p.minute * 600);
        expect(p.players).toBe(r.nationsInGame + 1);
        expect(p.rank).toBeGreaterThanOrEqual(1);
        expect(p.rank).toBeLessThanOrEqual(p.players);
        expect(p.nationsAlive).toBeLessThanOrEqual(r.nationsInGame);
        expect(p.topNation!.share).toBeGreaterThanOrEqual(p.medianNationShare);
        const sample = seat.timeline.find((t) => t.tick === p.tick);
        expect(p.share).toBe(sample!.share);
      }

      const attacks = seat.attacks!;
      expect(attacks.length).toBeGreaterThan(0);
      expect(attacks.length).toBeLessThanOrEqual(
        seat.stats.intentsByType.attack + (seat.stats.intentsByType.boat ?? 0),
      );
      expect(attacks.some((a) => a.tilesGained > 0)).toBe(true);
      for (const a of attacks) {
        expect(a.troopsSent).toBeGreaterThan(0);
        expect(a.endTick === null).toBe(a.end === "running");
        if (a.endTick !== null) {
          expect(a.endTick).toBeGreaterThanOrEqual(a.startTick);
        }
      }
      expect(seat.attacksDropped).toBe(0);

      const rec = seat.received!;
      for (const k of ["nation", "bot", "human"] as const) {
        if (rec.attacks[k] === 0) expect(rec.attackTroops[k]).toBe(0);
      }
      expect(rec.attacks.human).toBe(0);
      const nukes = Object.values(rec.nukes).reduce((x, y) => x + y, 0);
      expect(rec.firstNukeTick === null).toBe(nukes === 0);
      if (seat.eliminatedAtTick === null) expect(rec.eliminatedBy).toBeNull();

      expect(seat.stats.forkMs).toEqual({ count: 0, total: 0, max: 0 });
    },
    TIMEOUT,
  );
});
