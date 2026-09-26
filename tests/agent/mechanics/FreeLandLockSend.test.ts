/**
 * Pins apex spec C13 (§6.1 "FreeLandLockSend"; NationModel.gates, §2.4.3,
 * rests on it) against a real NationExecution.
 *
 * The claim under test: a nation bordering free land stays "locked" on
 * free land (attacks nothing else) only while its free-land send succeeds,
 * which needs T - expand x cap >= 1; with T < expand x cap it does not stay
 * locked. And a bordering tribe that owns a structure is attacked before
 * the reserve gate.
 *
 * The rules (the code is the spec; AiAttackBehavior.ts unless named):
 * - maybeAttack (:98-157): with unowned, un-nuked land in nearby() it calls
 *   sendAttack(terra nullius) and returns only if that succeeds (:135-141).
 *   sendAttack -> sendLandAttack -> calculateAttackTroops (:1041-1096):
 *   terra nullius is not a player, so the kept share is expandRatio, the
 *   send T - expand x cap, capped by troopSendCapForExpansion (:1035-1039,
 *   never below ceil(5% of T)); under 1 troop it returns null (:1076) and
 *   the send fails.
 * - A failed free-land send falls through: the 1-in-10 random boat, the
 *   alliance requests, then attackBestTarget (:278-304), which first
 *   attacks tribes that own a structure (hasNeighboringBotWithStructures
 *   :434-444 -> attackBots :484-520, sized with expandRatio for those,
 *   :1049-1051), then stops below reserveRatio x cap (:290).
 * - expandRatio (10-19%) is always below reserveRatio (30-39%), so a
 *   nation that fails the free-land send is also below its reserve.
 *
 * Setting: the real Config class as createGameRunner builds it
 * (GameRunner.ts:46), FFA, Singleplayer, Impossible, 400 tribes in the
 * config; the game built as tests/util/Setup.ts builds it (createGame,
 * endSpawnPhase at tick 0) on a synthesized all-plains 40 x 20 map: the
 * nation holds x 0-9 (200 tiles); x 10-19 of rows 10-19 (100 tiles) is free
 * land or a tribe; we hold the rest (500 tiles). No PlayerExecution runs:
 * troops stay where the test puts them, before each decision. The nation's
 * AiAttackBehavior is instrumented (test only) by wrapping its sendAttack
 * and attackBestTarget on the instance, to see how far each decision got;
 * every attack is also recorded as it is constructed.
 *
 * VERDICT: TRUE, exactly at the line T - expand x cap >= 1:
 * - At T = ceil(expand x cap) + 1 and above (up to 62% of its cap, with us
 *   juicy at half its troops) every decision sends to free land and ends
 *   there: attackBestTarget is never reached, nothing is sent at us.
 * - At T = floor(expand x cap) and below the free-land send fails at every
 *   decision and the decision goes on to attackBestTarget, which returns at
 *   the reserve gate: the nation is not locked, but it cannot attack a
 *   player either (expand < reserve). What does escape the lock there: its
 *   alliance requests (maybeSendAllianceRequests), and on a map with water
 *   the 1-in-10 random boat (troops/5, not reserve-gated).
 * - A tribe that owns a structure (a City here) is attacked below the
 *   reserve, sized with the expand ratio (4D here), before the reserve
 *   gate; a structureless tribe in the same position is not. The free-land
 *   lock, when it holds, comes first: a structure tribe beside free land
 *   is not attacked while the free-land send succeeds.
 * - For NationModel.gates: "locked" iff it borders free land and
 *   T(d) - expand x cap >= 1, or a structure tribe takes the decision;
 *   otherwise the reserve and trigger gates as usual.
 */
import { Config } from "../../../src/core/configuration/Config";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import {
  Cell,
  Difficulty,
  Execution,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Nation,
  Player,
  PlayerID,
  PlayerInfo,
  PlayerType,
  TerraNullius,
  UnitType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { GameConfig } from "../../../src/core/Schemas";

const AGENT_CLIENT = "AGENTCL1";
const AGENT_ID = "AGENTID1";
const NATION_ID = "NATION01";
const TRIBE_ID = "TRIBE001";

const GAME_CONFIG: GameConfig = {
  gameMap: GameMapType.Asia,
  gameMapSize: GameMapSize.Normal,
  gameMode: GameMode.FFA,
  gameType: GameType.Singleplayer,
  difficulty: Difficulty.Impossible,
  nations: "default",
  donateGold: false,
  donateTroops: false,
  bots: 400,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: false,
};

const LAND = 0x80 | 5;
const WIDTH = 40;
const HEIGHT = 20;

/** What x 10-19 of rows 10-19 holds; "both": free land in rows 10-14 and a
 *  tribe with a City in rows 15-19. */
type Pocket = "free" | "tribe" | "structureTribe" | "both";

interface NationInternals {
  attackRate: number;
  attackTick: number;
  reserveRatio: number;
  triggerRatio: number;
  expandRatio: number;
  behaviorsInitialized: boolean;
  attackBehavior: {
    sendAttack(target: Player | TerraNullius, force?: boolean): boolean;
    attackBestTarget(friends: Player[], enemies: Player[]): void;
  };
}

interface Sent {
  from: PlayerID;
  to: PlayerID | null;
  troops: number;
}

interface World {
  pocket: Pocket;
  game: Game;
  config: Config;
  us: Player;
  nation: Player;
  tribe: Player | null;
  exec: NationExecution;
  n: NationInternals;
  sent: Sent[];
}

function world(gameID: string, pocket: Pocket): World {
  const t = new Uint8Array(WIDTH * HEIGHT).fill(LAND);
  const m = new Uint8Array((WIDTH / 2) * (HEIGHT / 2)).fill(LAND);
  const map = new GameMapImpl(WIDTH, HEIGHT, t, WIDTH * HEIGHT);
  const mini = new GameMapImpl(WIDTH / 2, HEIGHT / 2, m, m.length);
  const config = new Config(GAME_CONFIG, null, false);
  const nationObj = new Nation(
    new Cell(0, 0),
    new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
  );
  const game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    [nationObj],
    map,
    mini,
    config,
  );
  game.endSpawnPhase();
  const us = game.player(AGENT_ID);
  const nation = game.player(NATION_ID);
  const tribe =
    pocket === "free"
      ? null
      : game.addPlayer(new PlayerInfo("tribe", PlayerType.Bot, null, TRIBE_ID));
  for (let x = 0; x < WIDTH; x++) {
    for (let y = 0; y < HEIGHT; y++) {
      const tile = game.ref(x, y);
      const inPocket = x >= 10 && x < 20 && y >= (pocket === "both" ? 15 : 10);
      if (x < 10) nation.conquer(tile);
      else if (inPocket && tribe !== null) tribe.conquer(tile);
      // Free land is ours until each decision frees it (freePocket).
      else us.conquer(tile);
    }
  }
  if (tribe !== null) {
    tribe.setTroops(2_000);
    if (pocket === "structureTribe" || pocket === "both") {
      tribe.buildUnit(UnitType.City, game.ref(15, 17), {});
    }
  }
  const sent: Sent[] = [];
  const add = game.addExecution.bind(game);
  game.addExecution = (...execs: Execution[]) => {
    for (const e of execs) {
      if (e instanceof AttackExecution) {
        const v = e as unknown as { _owner: Player; startTroops: number };
        sent.push({
          from: v._owner.id(),
          to: e.targetID() === game.terraNullius().id() ? null : e.targetID(),
          troops: v.startTroops,
        });
      }
    }
    add(...execs);
  };
  const exec = new NationExecution(gameID, nationObj);
  return {
    pocket,
    game,
    config,
    us,
    nation,
    tribe,
    exec,
    n: exec as unknown as NationInternals,
    sent,
  };
}

function tick(w: World, n = 1): void {
  for (let i = 0; i < n; i++) w.game.executeNextTick();
}

function nextDecisionTurn(w: World, from: number): number {
  let d = from;
  while (d % w.n.attackRate !== w.n.attackTick) d++;
  return d;
}

interface Probe {
  /** Results of sendAttack(terra nullius) in the decision. */
  freeLand: boolean[];
  reachedBestTarget: boolean;
  sends: Sent[];
}

/** Starts the nation and wraps its AiAttackBehavior (test only). */
function start(w: World): { probe: () => Probe } {
  while (w.game.ticks() < 750) tick(w);
  w.game.addExecution(w.exec);
  tick(w, 3);
  expect(w.n.behaviorsInitialized).toBe(true);
  const ab = w.n.attackBehavior;
  let current: Probe = { freeLand: [], reachedBestTarget: false, sends: [] };
  const sendAttack = ab.sendAttack.bind(ab);
  ab.sendAttack = (target, force) => {
    const r = sendAttack(target, force);
    if (!target.isPlayer()) current.freeLand.push(r);
    return r;
  };
  const best = ab.attackBestTarget.bind(ab);
  ab.attackBestTarget = (friends, enemies) => {
    current.reachedBestTarget = true;
    best(friends, enemies);
  };
  return {
    probe: () => {
      const p = current;
      current = { freeLand: [], reachedBestTarget: false, sends: [] };
      return p;
    },
  };
}

/** Makes the pocket free land again (whoever took it). */
function freePocket(w: World): void {
  const rows = w.pocket === "both" ? 15 : HEIGHT;
  for (let x = 10; x < 20; x++) {
    for (let y = 10; y < rows; y++) {
      const tile = w.game.ref(x, y);
      const owner = w.game.owner(tile);
      if (owner.isPlayer()) owner.relinquish(tile);
    }
  }
}

/** Runs its next decision with its troops at troops(its cap) and ours at
 *  half of that; a free pocket is freed again just before. */
function decide(
  w: World,
  probe: () => Probe,
  troops: (M: number) => number,
): Probe & { turn: number; T: number; M: number } {
  const d = nextDecisionTurn(w, w.game.ticks());
  while (w.game.ticks() < d) tick(w);
  if (w.pocket === "free" || w.pocket === "both") freePocket(w);
  const M = w.config.maxTroops(w.nation);
  const T = troops(M);
  w.nation.setTroops(T);
  w.us.setTroops(Math.floor(T / 2));
  probe();
  const before = w.sent.length;
  tick(w);
  const p = probe();
  p.sends = w.sent.slice(before).filter((s) => s.from === NATION_ID);
  return { ...p, turn: d, T, M };
}

const GAME_IDS = ["lock-a", "lock-b", "lock-c", "lock-d"];

describe("FreeLandLockSend (C13)", () => {
  test("locked while T - expand x cap >= 1: free land only, attackBestTarget never reached", () => {
    for (const id of GAME_IDS) {
      const w = world(id, "free");
      const { probe } = start(w);
      const e = w.n.expandRatio;
      for (const troops of [
        (M: number) => Math.ceil(e * M) + 1,
        (M: number) => Math.floor(M * 0.4),
        (M: number) => Math.floor(M * 0.62),
      ]) {
        for (let k = 0; k < 3; k++) {
          const p = decide(w, probe, troops);
          expect(p.T - e * p.M).toBeGreaterThanOrEqual(1);
          expect(p.freeLand).toEqual([true]);
          expect(p.reachedBestTarget).toBe(false);
          expect(p.sends.map((s) => s.to)).toEqual([null]);
        }
      }
    }
  });

  test("not locked below the line: the free-land send fails and the decision goes on, but stops at the reserve gate", () => {
    for (const id of GAME_IDS) {
      const w = world(id, "free");
      const { probe } = start(w);
      const e = w.n.expandRatio;
      expect(e).toBeLessThan(w.n.reserveRatio);
      for (const troops of [
        (M: number) => Math.floor(e * M),
        (M: number) => Math.floor((e * M) / 2),
        () => 1_000,
      ]) {
        // 9 decisions in 10 reach attackBestTarget; the other is a random
        // boat attempt, which finds no shore here and sends nothing.
        let reached = 0;
        for (let k = 0; k < 10; k++) {
          const p = decide(w, probe, troops);
          expect(p.T - e * p.M).toBeLessThan(1);
          expect(p.freeLand).toEqual([false]);
          expect(p.sends).toEqual([]);
          if (p.reachedBestTarget) reached++;
        }
        expect(reached).toBeGreaterThan(0);
      }
    }
  });

  test("a tribe with a structure is attacked below the reserve (expand sizing); a plain tribe is not", () => {
    for (const id of GAME_IDS) {
      for (const pocket of ["structureTribe", "tribe"] as const) {
        const w = world(id, pocket);
        const { probe } = start(w);
        // Between expand x cap + 2D and reserve x cap.
        const mid = (w.n.expandRatio + w.n.reserveRatio) / 2;
        const p = decide(w, probe, (M) => Math.floor(mid * M));
        expect(p.T).toBeLessThan(w.n.reserveRatio * p.M);
        expect(p.T - w.n.expandRatio * p.M).toBeGreaterThan(4 * 2_000);
        expect(p.freeLand).toEqual([]);
        if (pocket === "structureTribe") {
          expect(p.sends.map((s) => s.to)).toEqual([TRIBE_ID]);
          // calculateBotAttackTroops: 4D here (4D < T - expand x cap).
          expect(p.sends[0].troops).toBe(4 * 2_000);
        } else {
          expect(p.sends).toEqual([]);
        }
      }
    }
  });

  test("the lock comes first: a structure tribe beside free land is not attacked while the free-land send succeeds", () => {
    for (const id of GAME_IDS) {
      const w = world(id, "both");
      const { probe } = start(w);
      for (let k = 0; k < 3; k++) {
        const p = decide(w, probe, (M) => Math.floor(M * 0.62));
        expect(p.freeLand).toEqual([true]);
        expect(p.reachedBestTarget).toBe(false);
        expect(p.sends.map((s) => s.to)).toEqual([null]);
      }
    }
  });
});
