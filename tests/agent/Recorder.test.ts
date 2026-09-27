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
import { landShare } from "../../src/agent/lib/Perception";
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
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { StampedIntent } from "../../src/core/Schemas";
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
    // Before any attack, gains are the spawn.
    observe(log, 0, { gains: [9, 0, 8, 0] });
    observe(log, 1, {
      attacks: [land("a", 0, 100)],
      gains: [10, 0, 11, 0, 12, 5], // tile 12 came from someone else
    });
    observe(log, 2, { attacks: [land("a", 0, 60)], gains: [13, 0] });
    // Gone after this tick, but it was active during it; 60 troops came
    // home (the frontier emptied).
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
        troopsCancelledAtLaunch: 0,
        troopsLost: 40,
        tilesGained: 4,
        end: "frontier_emptied",
      },
    ]);
    expect([log.spawnTiles, log.tilesUncredited]).toEqual([2, 2]);
  });

  test("an attack gone with under a troop burned out; its troops are lost", () => {
    const log = new AttackLog(lookup());
    // The live attack is read once it is gone: deleting it keeps troops.
    const live = { troops: () => 55 };
    observe(log, 1, { attacks: [{ ...land("a", 0, 100), ref: live }] });
    observe(log, 2, { attacks: [{ ...land("a", 0, 60), ref: live }] });
    live.troops = () => 0.4;
    observe(log, 3, {});
    expect(log.records[0]).toMatchObject({
      end: "burned_out",
      troopsLost: 100,
    });
    // One that went with troops left emptied its frontier: they came home.
    const other = { troops: () => 70 };
    observe(log, 4, { attacks: [{ ...land("b", 0, 90), ref: other }] });
    observe(log, 5, {});
    expect(log.records[1]).toMatchObject({
      end: "frontier_emptied",
      troopsLost: 20,
    });
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
    // A retreat from a player brings three quarters of the 120 home.
    expect(log.records[0]).toMatchObject({
      end: "retreated",
      endTick: 5,
      troopsLost: 150 - 90,
    });
    expect(log.records[1]).toMatchObject({
      end: "frontier_emptied",
      endTick: 4,
      troopsLost: 0,
    });
  });

  test("an attack ends countered or with its target dead", () => {
    const log = new AttackLog(lookup(new Set([8])));
    observe(log, 1, { attacks: [land("a", 7, 100), land("b", 8, 100)] });
    observe(log, 2, { counters: new Set([7]) });
    expect(log.records.map((r) => [r.end, r.troopsLost])).toEqual([
      ["countered", 100],
      ["target_dead", 0],
    ]);
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
        troopsCancelledAtLaunch: 0,
        troopsLost: 10,
        tilesGained: 2,
        end: "frontier_emptied",
      },
      {
        id: "boat:42",
        startTick: 1,
        endTick: 7,
        target: { name: "P7", type: PlayerType.Nation },
        boat: true,
        troopsSent: 300,
        troopsCancelledAtLaunch: 0,
        troopsLost: 300,
        tilesGained: 2,
        end: "countered",
      },
    ]);
  });

  test("a boat that sinks, turns back, or lands without an attack", () => {
    const log = new AttackLog(lookup());
    const sunk = { wasDestroyedByEnemy: () => false };
    const afloat = { wasDestroyedByEnemy: () => false };
    const boats = (retreat: boolean) => [
      { ...boat(1, 7, 100, 40), ref: sunk },
      { ...boat(2, 7, retreat ? 50 : 200, 40, retreat), ref: afloat },
      { ...boat(3, 7, 300, 40), ref: afloat },
      { ...boat(4, 7, 400, 40), ref: afloat },
    ];
    observe(log, 1, { boats: boats(false) });
    observe(log, 2, { boats: boats(true) });
    // 1 is sunk, 2 gets home, 3 lands on a friend (the tile, no attack), 4
    // reaches our own shore (the tile was ours already).
    sunk.wasDestroyedByEnemy = () => true;
    observe(log, 3, { gains: [300, 7] });
    expect(
      log.records.map((r) => [
        r.id,
        r.end,
        r.endTick,
        r.tilesGained,
        r.troopsLost,
      ]),
    ).toEqual([
      ["boat:1", "sunk", 3, 0, 40],
      ["boat:2", "retreated", 3, 0, 10],
      ["boat:3", "returned", 3, 1, 0],
      ["boat:4", "returned", 3, 0, 10],
    ]);
  });

  test("launches cancelled by the target's attack on us", () => {
    const log = new AttackLog(lookup());
    const opposing = new Map([[7, 500]]);
    // Our launch at 7 never appeared, but the stats count 200 troops sent:
    // 7's attack on us took them all.
    observe(log, 1, { launched: [7], committed: 200, opposing });
    // A launch of 300 appeared with 180: 7's attack took 120 of it.
    observe(log, 2, {
      attacks: [land("b", 7, 180)],
      launched: [7],
      committed: 300,
      opposing,
    });
    // A launch the game refused (a friend, say): nothing committed.
    observe(log, 3, {
      attacks: [land("b", 7, 170)],
      launched: [8],
      committed: 0,
      opposing,
    });
    // A boat that landed (took its tile) but whose attack was cancelled at
    // once: its 50 troops are in the stats, and no attack appeared.
    observe(log, 4, {
      attacks: [land("b", 7, 160)],
      boats: [boat(9, 7, 900, 50)],
    });
    observe(log, 5, {
      attacks: [land("b", 7, 150)],
      gains: [900, 7],
      committed: 50,
      opposing,
    });
    expect(
      log.records.map((r) => [
        r.id,
        r.end,
        r.startTick,
        r.endTick,
        r.troopsSent,
        r.troopsCancelledAtLaunch,
        r.troopsLost,
        r.tilesGained,
      ]),
    ).toEqual([
      ["launch:1:7", "cancelled_at_launch", 1, 1, 200, 200, 200, 0],
      ["b", "running", 2, null, 300, 120, null, 0],
      ["boat:9", "cancelled_at_launch", 4, 5, 50, 50, 50, 1],
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
      log.records.map((r) => [
        r.id,
        r.troopsSent,
        r.tilesGained,
        r.end,
        r.troopsLost,
      ]),
    ).toEqual([
      ["l", 200, 1, "countered", 200],
      ["boat:6", 50, 0, "countered", 50],
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
    expect(log.records[MAX_ATTACK_RECORDS - 1].end).toBe("frontier_emptied");
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
    // What a launch of ours at each could meet: last tick's, and the new.
    expect(log.opposing).toEqual(
      new Map([
        [3, 80 + 130],
        [4, 20],
      ]),
    );
    log.launched(PlayerType.Human, 70);
    expect(log.attacks).toEqual({ nation: 2, bot: 0, human: 1 });
    expect(log.attackTroops).toEqual({ nation: 150, bot: 0, human: 70 });
  });

  test("lists each launch it counts, at the tick it came", () => {
    const log = new IncomingLog();
    const nation = (id: string, troops: number) => ({
      id,
      attacker: 3,
      attackerType: PlayerType.Nation,
      troops,
      boat: false,
    });
    log.observe([nation("a", 100)], 40);
    log.observe([nation("a", 90)], 41);
    // A boat is listed when it sails (the recorder's unit updates), not
    // when its attack appears at the landing.
    log.launched(PlayerType.Bot, 25.4, { tick: 42, attacker: 5, boat: true });
    log.observe([nation("b", 150), { ...nation("c", 25), boat: true }], 60);
    expect(log.launches).toEqual([
      {
        tick: 40,
        attacker: 3,
        type: PlayerType.Nation,
        troops: 100,
        boat: false,
      },
      { tick: 42, attacker: 5, type: PlayerType.Bot, troops: 25, boat: true },
      // b absorbed a's 90: only the 60 it added is a launch.
      {
        tick: 60,
        attacker: 3,
        type: PlayerType.Nation,
        troops: 60,
        boat: false,
      },
    ]);
    expect(log.launchesDropped).toBe(0);
    // The boat's attack is listed where it appeared, as a landing.
    expect(log.landings).toEqual([
      {
        tick: 60,
        attacker: 3,
        type: PlayerType.Nation,
        troops: 25,
        boat: true,
      },
    ]);
    // Past the cap they are counted, not listed.
    for (let i = log.launches.length; i < MAX_ATTACK_RECORDS + 3; i++) {
      log.launched(PlayerType.Nation, 1, { tick: i, attacker: 3, boat: false });
    }
    expect(log.launches).toHaveLength(MAX_ATTACK_RECORDS);
    expect(log.launchesDropped).toBe(3);
    expect(log.attacks.nation).toBe(2 + MAX_ATTACK_RECORDS + 3 - 3);
  });

  test("lists each boat attack when it lands, counted once at sea", () => {
    const log = new IncomingLog();
    const boat = (id: string, troops: number) => ({
      id,
      attacker: 7,
      attackerType: PlayerType.Nation,
      troops,
      boat: true,
    });
    log.observe([boat("x", 500.4)], 10);
    log.observe([boat("x", 450)], 11);
    log.observe([boat("x", 400), boat("y", 90)], 12);
    expect(log.landings.map((l) => [l.tick, l.troops])).toEqual([
      [10, 500],
      [12, 90],
    ]);
    // Counted when they sailed (the recorder's unit updates), not here.
    expect(log.attacks.nation).toBe(0);
    expect(log.launches).toEqual([]);
    for (let i = 0; i < MAX_ATTACK_RECORDS; i++) {
      log.observe([boat(`z${i}`, 1)], 100 + i);
    }
    expect(log.landings).toHaveLength(MAX_ATTACK_RECORDS);
    expect(log.landingsDropped).toBe(2);
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
    // Listed when the boat set sail, the tick of our record's start.
    expect(received.launches).toEqual([
      {
        tick: attacks[1].startTick,
        by: { name: "seat a", type: PlayerType.Human },
        troops: 5000,
        boat: true,
      },
    ]);
    expect(received.launchesDropped).toBe(0);
    // And when it landed: its attack on b's land began later.
    expect(received.landings).toHaveLength(1);
    expect(received.landings![0]).toMatchObject({
      by: { name: "seat a", type: PlayerType.Human },
      boat: true,
    });
    expect(received.landings![0].tick).toBeGreaterThan(attacks[1].startTick);
    expect(received.landings![0].troops).toBeLessThanOrEqual(5000);
    expect(received.landingsDropped).toBe(0);
    expect(recorder.records(0).received.landings).toEqual([]);
    expect(received.eliminatedBy).toEqual({
      name: "seat a",
      type: PlayerType.Human,
    });
    expect(recorder.records(0).received.attacks.human).toBe(0);
    expectOwnersInSync(game, recorder);
  });

  test("a nuke aimed at a seat's land counts once, for that seat", async () => {
    const { game, a, b, recorder, step } = await islandGame();
    constructionExecution(game, a, 3, 7, UnitType.MissileSilo, 0);
    for (let i = 0; i < 5; i++) step();
    expect(a.units(UnitType.MissileSilo)).toHaveLength(1);

    game.addExecution(
      new NukeExecution(UnitType.AtomBomb, a, game.ref(15, 7), null),
    );
    let launched: number | null = null;
    let share = 0;
    let gold = 0n;
    for (let i = 0; i < 60; i++) {
      step();
      if (launched === null && a.units(UnitType.AtomBomb).length > 0) {
        launched = game.ticks(); // as the arena counts: ticks executed
        share = landShare(game, game.player(b.id()));
        gold = a.gold();
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
    // The bomb with our share and the sender's gold when it was launched.
    expect(share).toBeGreaterThan(0);
    expect(received.nukeLog).toEqual([
      {
        tick: launched,
        type: "atom",
        by: { name: "seat a", type: PlayerType.Human },
        share: Math.round(share * 10000) / 10000,
        gold: Number(gold),
      },
    ]);
    expect(recorder.records(0).received.nukes.atom).toBe(0);
    expect(recorder.records(0).received.nukeLog).toEqual([]);
    expectOwnersInSync(game, recorder);
  });
});

describe("attack endings in the simulation", () => {
  // plains: 100 × 100 land. Seat a owns the columns x < 10; b owns the
  // columns from `bFrom` on, the rest is TerraNullius. Nothing regrows
  // troops (no spawn, so no PlayerExecution): what a has is what came back.
  async function plains(bFrom: number) {
    const infoA = new PlayerInfo("seat a", PlayerType.Human, "CLIENT_A", "a");
    const infoB = new PlayerInfo("seat b", PlayerType.Human, "CLIENT_B", "b");
    const game = await setup("plains", {}, [infoA, infoB]);
    const a = game.player(infoA.id);
    const b = game.player(infoB.id);
    for (let x = 0; x < 100; x++) {
      for (let y = 0; y < 100; y++) {
        if (x < 10) a.conquer(game.ref(x, y));
        else if (x >= bFrom) b.conquer(game.ref(x, y));
      }
    }
    a.addTroops(1_000_000);
    b.addTroops(1_000_000);
    const recorder = new ArenaRecorder(game, [a, b]);
    const step = (intents: StampedIntent[] = []) => {
      const updates = game.executeNextTick();
      recorder.update({
        tick: game.ticks(),
        updates,
        packedTileUpdates: game.drainPackedTileUpdates(),
      });
      recorder.afterTick(intents);
    };
    const until = (done: () => boolean) => {
      for (let i = 0; i < 2000 && !done(); i++) step();
      expect(done()).toBe(true);
    };
    return { game, a, b, recorder, step, until };
  }

  test("burned out loses its troops; frontier emptied brings them home", async () => {
    const { game, a, recorder, until } = await plains(20);
    const attacks = () => recorder.records(0).attacks;

    // 150 troops into open land run out after a few tiles.
    const before = a.troops();
    game.addExecution(new AttackExecution(150, a, game.terraNullius().id()));
    until(
      () => attacks()[0]?.end !== undefined && attacks()[0].end !== "running",
    );
    expect(attacks()[0]).toMatchObject({
      end: "burned_out",
      troopsSent: 150,
      troopsLost: 150,
    });
    expect(a.troops()).toBe(before - 150);

    // 400k into the 10-column strip of TerraNullius left between a and b:
    // it takes the strip, runs out of frontier and retreats with the rest.
    const strip = 10 * 100 - attacks()[0].tilesGained;
    const start = a.troops();
    game.addExecution(
      new AttackExecution(400_000, a, game.terraNullius().id()),
    );
    until(
      () => attacks()[1]?.end !== undefined && attacks()[1].end !== "running",
    );
    const r = attacks()[1];
    expect(r).toMatchObject({
      end: "frontier_emptied",
      troopsSent: 400_000,
      tilesGained: strip,
    });
    expect(r.troopsLost).toBeGreaterThan(0);
    expect(r.troopsLost).toBeLessThan(400_000);
    // What did not come back is exactly what the owner is short of.
    expect(Math.abs(start - r.troopsLost! - a.troops())).toBeLessThanOrEqual(1);
  });

  const attackIntent = (from: Player, target: Player, troops: number) =>
    ({
      type: "attack",
      clientID: from.clientID()!,
      targetID: target.id(),
      troops,
    }) as StampedIntent;

  test("a launch cancelled whole by a larger attack on us is recorded", async () => {
    const { game, a, b, recorder, step } = await plains(10);
    game.addExecution(new AttackExecution(50_000, b, a.id()));
    step();
    const incoming = a.incomingAttacks()[0].troops();

    // Our 20k meets b's attack in AttackExecution.init and vanishes.
    game.addExecution(new AttackExecution(20_000, a, b.id()));
    step([attackIntent(a, b, 20_000)]);
    expect(a.outgoingAttacks()).toHaveLength(0);
    expect(a.incomingAttacks()[0].troops()).toBeLessThan(incoming - 19_000);
    const tick = game.ticks();
    expect(recorder.records(0).attacks).toEqual([
      {
        id: `launch:${tick}:${b.smallID()}`,
        startTick: tick,
        endTick: tick,
        target: { name: "seat b", type: PlayerType.Human },
        boat: false,
        troopsSent: 20_000,
        troopsCancelledAtLaunch: 20_000,
        troopsLost: 20_000,
        tilesGained: 0,
        end: "cancelled_at_launch",
      },
    ]);
  });

  test("a launch cancelled in part records what it committed", async () => {
    const { game, a, b, recorder, step } = await plains(10);
    game.addExecution(new AttackExecution(10_000, b, a.id()));
    step();

    // Our 30k cancels b's attack and goes on with the rest.
    game.addExecution(new AttackExecution(30_000, a, b.id()));
    step([attackIntent(a, b, 30_000)]);
    expect(a.incomingAttacks()).toHaveLength(0);
    const seen = a.outgoingAttacks()[0].troops();
    expect(seen).toBeLessThan(21_000);
    const [r] = recorder.records(0).attacks;
    expect(r.end).toBe("running");
    expect(Math.abs(r.troopsSent - 30_000)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(r.troopsCancelledAtLaunch - (30_000 - seen)),
    ).toBeLessThanOrEqual(1);
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
        expect(a.troopsLost === null).toBe(a.end === "running");
        expect(a.troopsLost ?? 0).toBeLessThanOrEqual(a.troopsSent);
        expect(a.troopsCancelledAtLaunch).toBeLessThanOrEqual(a.troopsSent);
        if (a.endTick !== null) {
          expect(a.endTick).toBeGreaterThanOrEqual(a.startTick);
        }
      }
      expect(seat.attacksDropped).toBe(0);
      expect(seat.spawnTiles).toBeGreaterThan(0);
      expect(seat.tilesUncredited).toBeGreaterThanOrEqual(0);

      const rec = seat.received!;
      for (const k of ["nation", "bot", "human"] as const) {
        if (rec.attacks[k] === 0) expect(rec.attackTroops[k]).toBe(0);
      }
      // Every counted launch is listed, in order, with the troops counted.
      const listed = rec.launches!;
      expect(listed.length + rec.launchesDropped!).toBe(
        rec.attacks.nation + rec.attacks.bot + rec.attacks.human,
      );
      const byType = (t: PlayerType) =>
        listed.filter((l) => l.by.type === t).reduce((x, l) => x + l.troops, 0);
      expect(
        Math.abs(byType(PlayerType.Bot) - rec.attackTroops.bot),
      ).toBeLessThanOrEqual(listed.length);
      expect(
        Math.abs(byType(PlayerType.Nation) - rec.attackTroops.nation),
      ).toBeLessThanOrEqual(listed.length);
      for (let i = 1; i < listed.length; i++) {
        expect(listed[i].tick).toBeGreaterThanOrEqual(listed[i - 1].tick);
      }
      expect(rec.nukeLog!.length).toBe(
        rec.nukes.atom + rec.nukes.hydrogen + rec.nukes.mirv,
      );
      // Boat attacks at their landing, in order.
      expect(rec.landingsDropped).toBe(0);
      for (const [i, l] of rec.landings!.entries()) {
        expect(l.boat).toBe(true);
        if (i > 0)
          expect(l.tick).toBeGreaterThanOrEqual(rec.landings![i - 1].tick);
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
