import path from "path";
import { AgentHost } from "../../../src/agent/AgentHost";
import { createAgent } from "../../../src/agent/agents";
import {
  ArenaGameSpec,
  arenaGameStart,
  seatClientID,
} from "../../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../../src/agent/arena/NodeMapLoader";
import { TerrainMix } from "../../../src/agent/lib/Models";
import {
  NeighborInfo,
  scanWorld,
  SHORE_SAMPLE,
  WorldModel,
} from "../../../src/agent/lib/WorldModel";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameType,
  Player,
  PlayerType,
  TerrainType,
  UnitType,
} from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import { createGameRunner } from "../../../src/core/GameRunner";
import { StampedIntent } from "../../../src/core/Schemas";

// scanWorld (spec §2.3) against a brute-force recount on a real small map in
// mid-game: Pangaea (1000×1000) as the arena builds it, Impossible nations
// and 400 tribes, with the baseline agent playing our seat through AgentHost
// at latency 1. The recount walks every tile of the map by coordinates,
// finds each player's border tiles itself (a tile with a 4-neighbour of
// another owner, water included: GameMap.isBorder) and counts adjacency
// pairs into passable land. It checks every living player, not only ours.

const MAPS = path.join(__dirname, "../../../resources/maps");
const ME = seatClientID(0);
/** Checked at 15 s, in the free-land race (on Pangaea 430 players fill the
 *  free land by tick 225), and at minute 1.5 (tribes half eaten, attacks
 *  everywhere). */
const EARLY_TICK = 150;
const LATE_TICK = 900;

interface Recount {
  border: number;
  free: number;
  freeMix: TerrainMix;
  contacts: Map<number, { contact: number; mix: TerrainMix }>;
  oceanShore: Set<TileRef>;
}

function mix(): TerrainMix {
  return { plains: 0, highland: 0, mountain: 0 };
}

function add(m: TerrainMix, t: TerrainType): void {
  if (t === TerrainType.Plains) m.plains++;
  else if (t === TerrainType.Highland) m.highland++;
  else if (t === TerrainType.Mountain) m.mountain++;
  else throw new Error(`counted a ${TerrainType[t]} tile`);
}

/** Every owner's border, free frontier and contacts, from one raster pass. */
function recount(game: Game): Map<number, Recount> {
  const out = new Map<number, Recount>();
  const W = game.width();
  const H = game.height();
  const around: [number, number][] = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];
  const nb: TileRef[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = game.ref(x, y);
      const o = game.ownerID(t);
      if (o === 0) continue;
      nb.length = 0;
      for (const [dx, dy] of around) {
        if (game.isValidCoord(x + dx, y + dy))
          nb.push(game.ref(x + dx, y + dy));
      }
      if (!nb.some((n) => game.ownerID(n) !== o)) continue;
      let r = out.get(o);
      if (r === undefined) {
        r = {
          border: 0,
          free: 0,
          freeMix: mix(),
          contacts: new Map(),
          oceanShore: new Set(),
        };
        out.set(o, r);
      }
      r.border++;
      if (nb.some((n) => game.isOcean(n))) r.oceanShore.add(t);
      for (const n of nb) {
        if (!game.isLand(n) || game.isImpassable(n)) continue;
        const on = game.ownerID(n);
        if (on === o) continue;
        if (on === 0) {
          if (game.hasFallout(n)) continue;
          r.free++;
          add(r.freeMix, game.terrainType(n));
          continue;
        }
        let c = r.contacts.get(on);
        if (c === undefined) {
          c = { contact: 0, mix: mix() };
          r.contacts.set(on, c);
        }
        c.contact++;
        add(c.mix, game.terrainType(n));
      }
    }
  }
  return out;
}

function nationTroopsOn(p: Player, me: Player): number {
  return p
    .incomingAttacks()
    .filter(
      (a) =>
        a.attacker() !== me &&
        (a.attacker().type() === PlayerType.Nation ||
          a.attacker().type() === PlayerType.Human),
    )
    .reduce((s, a) => s + a.troops(), 0);
}

/** Asserts that `wm` is what the recount and the game's getters say. */
function checkScan(game: Game, p: Player, wm: WorldModel, r: Recount): void {
  expect(wm.tick).toBe(game.ticks());
  expect(wm.home).toBe(p.troops());
  expect(wm.tiles).toBe(p.numTilesOwned());
  expect(wm.gold).toBe(p.gold());

  expect(wm.borderSize).toBe(r.border);
  expect(wm.borderSize).toBe(p.borderTiles().size);
  expect(wm.freeFrontier).toBe(r.free);
  expect(wm.freeMix).toEqual(r.freeMix);
  // Fields spec §2.3 has and the scan leaves out (nothing read them;
  // freeAcrossWater cost a me.nearby() every decision).
  for (const k of [
    "cap",
    "regrowth",
    "tnStack",
    "incomingNationSum",
    "freeAcrossWater",
  ]) {
    expect(k in wm).toBe(false);
  }

  const ids = [...r.contacts.keys()].sort((a, b) => a - b);
  expect([...wm.neighbors.keys()]).toEqual(ids);
  const tribes: number[] = [];
  const nations: number[] = [];
  for (const id of ids) {
    const n = game.playerBySmallID(id) as Player;
    const info = wm.neighbors.get(id)!;
    const c = r.contacts.get(id)!;
    const want: NeighborInfo = {
      smallID: id,
      id: n.id(),
      type: n.type(),
      contact: c.contact,
      contactMix: c.mix,
      troops: n.troops(),
      tiles: n.numTilesOwned(),
      density: n.troops() / n.numTilesOwned(),
      gold: n.gold(),
      friendly: p.isFriendly(n),
      attackable: p.canAttackPlayer(n),
      incomingFromNations:
        n.type() === PlayerType.Bot ? nationTroopsOn(n, p) : 0,
    };
    expect(info).toEqual(want);
    if (n.type() === PlayerType.Bot && want.attackable && !want.friendly) {
      tribes.push(id);
    }
    if (n.type() === PlayerType.Nation || n.type() === PlayerType.Human) {
      nations.push(id);
    }
  }
  expect(wm.tribes.map((n) => n.smallID)).toEqual(tribes);
  expect(wm.nations.map((n) => n.smallID)).toEqual(nations);
  for (const n of [...wm.tribes, ...wm.nations]) {
    expect(n).toBe(wm.neighbors.get(n.smallID));
  }

  expect(wm.shoreSample).toHaveLength(
    Math.min(SHORE_SAMPLE, r.oceanShore.size),
  );
  expect(new Set(wm.shoreSample).size).toBe(wm.shoreSample.length);
  for (const t of wm.shoreSample) expect(r.oceanShore.has(t)).toBe(true);

  const out = p.outgoingAttacks();
  expect(wm.outgoing).toEqual(
    out.map((a) => ({
      id: a.id(),
      targetSmallID: a.target().isPlayer() ? a.target().smallID() : 0,
      troops: a.troops(),
      boat: a.sourceTile() !== null,
      retreating: a.retreating(),
    })),
  );
  const inc = p.incomingAttacks();
  expect(wm.incoming.map((a) => a.id)).toEqual(inc.map((a) => a.id()));
  for (let i = 0; i < inc.length; i++) {
    expect(wm.incoming[i]).toMatchObject({
      attackerSmallID: inc[i].attacker().smallID(),
      attackerType: inc[i].attacker().type(),
      troops: inc[i].troops(),
      boat: inc[i].sourceTile() !== null,
    });
  }
  expect(wm.boatsInFlight).toBe(p.units(UnitType.TransportShip).length);
}

function hash(game: Game): number {
  return (game as unknown as { hash(): number }).hash();
}

describe("apex WorldModel (§2.3)", () => {
  let game: Game;
  let me: Player;
  /** Plays (the baseline in our seat) until game.ticks() = tick. */
  let playTo: (tick: number) => void;
  /** Our seat scanned at tick 0, before it spawned. */
  let unspawned: WorldModel;

  beforeAll(async () => {
    const spec = {
      gameID: "WORLDMDL",
      map: GameMapType.Pangaea,
      mapSize: GameMapSize.Normal,
      gameType: GameType.Singleplayer,
      difficulty: Difficulty.Impossible,
      nations: "default",
      bots: 400,
      seats: [{ agent: "baseline" }],
    } as ArenaGameSpec;
    const gameStart = arenaGameStart(spec);
    const runner = await createGameRunner(
      gameStart,
      undefined,
      new NodeMapLoader(MAPS),
      (gu) => {
        if ("errMsg" in gu) throw new Error(gu.errMsg);
      },
    );
    game = runner.game;
    const queue = new Map<number, StampedIntent[]>();
    const host = new AgentHost({
      agent: createAgent("baseline"),
      clientID: ME,
      gameStart,
      runner,
      // Latency 1: an intent sent after tick i ran goes into turn i + 1.
      deliver: (intent) => {
        const turn = game.ticks();
        queue.set(turn, [
          ...(queue.get(turn) ?? []),
          { ...intent, clientID: ME },
        ]);
      },
      nowMs: () => game.ticks() * 100,
      strict: true,
    });
    const p = game.playerByClientID(ME);
    if (p === null) throw new Error("no seat player");
    me = p;
    unspawned = scanWorld(game, me, null);
    playTo = (tick) => {
      while (game.ticks() < tick) {
        const turn = game.ticks();
        runner.addTurn({ turnNumber: turn, intents: queue.get(turn) ?? [] });
        queue.delete(turn);
        if (!runner.executeNextTick()) throw new Error("tick failed");
        host.tick();
      }
    };
    playTo(EARLY_TICK);
  }, 120_000);

  /** Checks every living player; returns what the check covered. */
  function checkAll() {
    expect(game.inSpawnPhase()).toBe(false);
    expect(me.isAlive()).toBe(true);
    const before = hash(game);
    const r = recount(game);
    const seen = {
      checked: 0,
      withFree: 0,
      withTribes: 0,
      withNations: 0,
      rough: 0,
      incoming: 0,
      outgoing: 0,
    };
    for (const p of game.players()) {
      if (!p.isAlive()) continue;
      const wm = scanWorld(game, p, null);
      checkScan(game, p, wm, r.get(p.smallID())!);
      seen.checked++;
      if (wm.freeFrontier > 0) seen.withFree++;
      if (wm.tribes.length > 0) seen.withTribes++;
      if (wm.nations.length > 0) seen.withNations++;
      for (const n of wm.neighbors.values()) {
        if (n.contactMix.highland + n.contactMix.mountain > 0) seen.rough++;
      }
      seen.incoming += wm.incoming.length;
      seen.outgoing += wm.outgoing.length;
    }
    // Read-only.
    expect(hash(game)).toBe(before);
    return seen;
  }

  test("at 15 s every living player's scan equals the brute-force recount and the game's getters", () => {
    expect(game.ticks()).toBe(EARLY_TICK);
    const seen = checkAll();
    // A varied position, not an empty map: the race for free land.
    expect(seen.checked).toBeGreaterThan(100);
    expect(seen.withFree).toBeGreaterThan(200);
    expect(seen.withTribes).toBeGreaterThan(20);
    expect(seen.rough).toBeGreaterThan(10);
    expect(seen.outgoing).toBeGreaterThan(20);
    const mine = scanWorld(game, me, null);
    expect(mine.freeFrontier).toBeGreaterThan(0);
    expect(mine.outgoing.length).toBeGreaterThan(0);
  });

  test("at minute 1.5 too: free land gone, tribes eaten under attack", () => {
    playTo(LATE_TICK);
    const seen = checkAll();
    expect(seen.checked).toBeGreaterThan(50);
    expect(seen.withTribes).toBeGreaterThan(20);
    expect(seen.withNations).toBeGreaterThan(20);
    expect(seen.rough).toBeGreaterThan(10);
    expect(seen.incoming).toBeGreaterThan(5);
    const mine = scanWorld(game, me, null);
    expect(mine.tiles).toBeGreaterThan(1000);
    expect(mine.neighbors.size).toBeGreaterThan(0);
    // It plays the game on to minute 1.5 first: near the 5 s default
    // when the suite runs in parallel.
  }, 60_000);

  test("the scan is deterministic, and `prev` carries firstSeen for incoming attacks that are still running", () => {
    const victim = game
      .players()
      .find((p) => p.isAlive() && p.incomingAttacks().length >= 2);
    expect(victim).toBeDefined();
    const fresh = scanWorld(game, victim!, null);
    expect(scanWorld(game, victim!, null)).toEqual(fresh);
    for (const a of fresh.incoming) expect(a.firstSeen).toBe(game.ticks());

    const prev: WorldModel = {
      ...fresh,
      incoming: [
        { ...fresh.incoming[0], firstSeen: 123 },
        { ...fresh.incoming[0], id: "gone", firstSeen: 7 },
      ],
    };
    const next = scanWorld(game, victim!, prev);
    expect(next.incoming[0].firstSeen).toBe(123);
    for (const a of next.incoming.slice(1)) {
      expect(a.firstSeen).toBe(game.ticks());
    }
    expect(next.incoming.some((a) => a.id === "gone")).toBe(false);
  });

  test("the scan never calls nearby() (a recompute over the whole border)", () => {
    let calls = 0;
    const players = game.allPlayers().filter((p) => p.isAlive());
    const saved = players.map((p) => p.nearby);
    for (const p of players) {
      const f = p.nearby.bind(p);
      p.nearby = () => {
        calls++;
        return f();
      };
    }
    try {
      for (const p of players) scanWorld(game, p, null);
    } finally {
      players.forEach((p, i) => (p.nearby = saved[i]));
    }
    expect(players.length).toBeGreaterThan(1);
    expect(calls).toBe(0);
  });

  test("a player that has not spawned scans to zeros", () => {
    expect(unspawned).toMatchObject({
      tick: 0,
      tiles: 0,
      borderSize: 0,
      freeFrontier: 0,
      tribes: [],
      nations: [],
      outgoing: [],
      incoming: [],
      shoreSample: [],
      boatsInFlight: 0,
    });
    expect(unspawned.neighbors.size).toBe(0);
  });
});
