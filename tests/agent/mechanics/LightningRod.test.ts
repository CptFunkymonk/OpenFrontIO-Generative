/**
 * Pins apex spec N9 (§6.1 "LightningRod"; the buffer penalty of §3.6.4
 * rests on it) against a real NationExecution.
 *
 * The claim under test: a nation with an affordable bordering tribe attacks
 * the tribe, not a juicy us (our home troops T_us = 0.5 x its troops T_N),
 * until the tribe is gone.
 *
 * The rules (the code is the spec; AiAttackBehavior.ts unless named):
 * - Impossible's strategy list is [retaliate, bots, veryWeak, betray,
 *   assist, victim, traitor, juicy, afk, nuked, hated, weakest, island,
 *   donate] (:426-428); the first strategy that sends wins (:301-303).
 * - bots = attackBots (:484-520): every non-friendly nearby() tribe,
 *   structures first, then by density, each sized by calculateAttackTroops
 *   (:1041-1096) through calculateBotAttackTroops (:1149-1166): 4 x the
 *   tribe's troops D, or all of T - reserve x cap if that is less but at
 *   least 2 x D, else nothing; then min(., troopSendCap()) and the 20%
 *   floor. It returns true (ending the list) iff some troops went.
 * - So with an affordable tribe (2D <= T - reserve x cap and a send cap >= 1)
 *   the list never reaches juicy (:669-674, we qualify at <= 0.75 x its
 *   troops) or weakest (:388-398).
 *
 * VERDICT: TRUE, on 4 game IDs, with refinements the buffer penalty needs:
 * - While an affordable tribe borders it, every send of every decision
 *   goes to the tribe, sized exactly min(4D, T - reserve x cap) >= 2D; none
 *   goes to us although we are juicy (0.5 x its troops). At the first
 *   decision that sends after the tribe is gone, it attacks us (juicy).
 * - The shield lasts about one decision: a send of >= 2D finished every
 *   tribe tried here (100 tiles at 5k, 300 tiles at 15k) before the next
 *   decision (30-49 ticks). Two affordable tribes are attacked in parallel
 *   in the same decision (attackBots, up to 100 at Impossible) and shield
 *   no longer than one.
 * - A tribe it cannot afford (2D > T - reserve x cap) shields nothing: it
 *   attacks us at once.
 * - At our home >= T / 0.9 its send cap is 0 (NationSendCap): it attacks
 *   neither the tribe nor us, so a rod is moot there.
 * - The pin re-arms its troops before each decision. In a live game the
 *   send also drains its home by up to its whole reserve surplus, often
 *   below its trigger, where the list runs only 1 decision in 10 and a
 *   send at us may be under 20% of our home (too weak) until it regrows.
 *
 * Setting: the real Config class as createGameRunner builds it
 * (GameRunner.ts:46), FFA, Singleplayer, Impossible, 400 tribes in the
 * config; the game built as tests/util/Setup.ts builds it (createGame,
 * endSpawnPhase at tick 0) on a synthesized all-plains 40 x 20 map with no
 * free land (so the nation never locks on free land, before or after it
 * eats the tribe): the nation holds x 0-9 (200 tiles), the tribe x 10-19 of
 * rows 10-19 (100 tiles), we hold the rest (500 tiles; 600 in the control
 * without the tribe), so both border it. The tribe has no TribeExecution
 * (it never attacks or grows). No PlayerExecution runs: troops stay where the test puts them.
 * Before each of its decisions the test sets its troops to 62% of its cap
 * (above every trigger) and ours to half of that; every attack or boat is
 * recorded as it is constructed (the decision), before AttackExecution.init
 * adjusts it.
 */
import { Config } from "../../../src/core/configuration/Config";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { TransportShipExecution } from "../../../src/core/execution/TransportShipExecution";
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
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { GameConfig } from "../../../src/core/Schemas";

const AGENT_CLIENT = "AGENTCL1";
const AGENT_ID = "AGENTID1";
const NATION_ID = "NATION01";
const TRIBE_IDS = ["TRIBE001", "TRIBE002"];

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
const WIDTH = 60;
const HEIGHT = 20;
/** Its troops before each decision, as a share of its cap. */
const NATION_SHARE = 0.62;
/** Our home as a share of its troops (the claim's T_us = 0.5 T_N). */
const US_SHARE = 0.5;

interface NationInternals {
  attackRate: number;
  attackTick: number;
  reserveRatio: number;
  triggerRatio: number;
  behaviorsInitialized: boolean;
}

interface Sent {
  tick: number;
  from: PlayerID;
  /** Target player id; null for free land. */
  to: PlayerID | null;
  troops: number;
  boat: boolean;
}

interface World {
  game: Game;
  config: Config;
  us: Player;
  nation: Player;
  tribes: Player[];
  exec: NationExecution;
  n: NationInternals;
  sent: Sent[];
}

/** tribeTroops: one entry per tribe (at most 2); they split x 10-39 of rows
 *  10-19 into horizontal bands, each touching the nation's x = 9 edge. */
function world(gameID: string, tribeTroops: number[]): World {
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
  const tribes = tribeTroops.map((_, i) =>
    game.addPlayer(
      new PlayerInfo(`tribe${i}`, PlayerType.Bot, null, TRIBE_IDS[i]),
    ),
  );
  const band = tribes.length > 0 ? 10 / tribes.length : 0;
  for (let x = 0; x < WIDTH; x++) {
    for (let y = 0; y < HEIGHT; y++) {
      const tile = game.ref(x, y);
      if (x < 10) nation.conquer(tile);
      else if (x < 40 && y >= 10 && tribes.length > 0) {
        tribes[Math.floor((y - 10) / band)].conquer(tile);
      } else us.conquer(tile);
    }
  }
  tribes.forEach((tr, i) => tr.setTroops(tribeTroops[i]));
  const sent: Sent[] = [];
  const add = game.addExecution.bind(game);
  game.addExecution = (...execs: Execution[]) => {
    for (const e of execs) {
      if (e instanceof AttackExecution) {
        const v = e as unknown as { _owner: Player; startTroops: number };
        sent.push({
          tick: game.ticks(),
          from: v._owner.id(),
          to: e.targetID() === game.terraNullius().id() ? null : e.targetID(),
          troops: v.startTroops,
          boat: false,
        });
      } else if (e instanceof TransportShipExecution) {
        const v = e as unknown as { attacker: Player; troops: number };
        sent.push({
          tick: game.ticks(),
          from: v.attacker.id(),
          to: null,
          troops: v.troops,
          boat: true,
        });
      }
    }
    add(...execs);
  };
  const exec = new NationExecution(gameID, nationObj);
  return {
    game,
    config,
    us,
    nation,
    tribes,
    exec,
    n: exec as unknown as NationInternals,
    sent,
  };
}

function tick(w: World, n = 1): void {
  for (let i = 0; i < n; i++) w.game.executeNextTick();
}

function isDecision(w: World, t: number): boolean {
  return t % w.n.attackRate === w.n.attackTick;
}

function nextDecisionTurn(w: World, from: number): number {
  let d = from;
  while (!isDecision(w, d)) d++;
  return d;
}

/** Starts the nation (init, behaviours, the forced opening send). */
function start(w: World): void {
  while (w.game.ticks() < 750) tick(w);
  w.game.addExecution(w.exec);
  tick(w, 3);
  expect(w.n.behaviorsInitialized).toBe(true);
  w.sent.length = 0;
}

interface Decision {
  turn: number;
  /** Tribes alive when it decided, with their troops. */
  alive: { id: PlayerID; troops: number }[];
  /** Every live tribe was affordable (2D <= T - reserve x cap, less what
   *  the tribes before it in attackBots' order took). */
  affordable: boolean;
  /** Its reserve surplus T - reserve x cap at the decision. */
  surplus: number;
  /** Its sends in that decision. */
  sends: Sent[];
}

/** Arms both sides and runs its next decision. */
function decide(w: World, ourShare = US_SHARE): Decision {
  const d = nextDecisionTurn(w, w.game.ticks());
  while (w.game.ticks() < d) tick(w);
  const T = Math.floor(w.config.maxTroops(w.nation) * NATION_SHARE);
  w.nation.setTroops(T);
  w.us.setTroops(Math.floor(T * ourShare));
  const M = w.config.maxTroops(w.nation);
  const surplus = T - M * w.n.reserveRatio;
  const alive = w.tribes
    .filter((tr) => tr.isAlive())
    .map((tr) => ({ id: tr.id(), troops: tr.troops() }));
  // attackBots' order is by density; with equal tiles, by troops.
  let left = surplus;
  let affordable = true;
  for (const a of [...alive].sort((x, y) => x.troops - y.troops)) {
    if (2 * a.troops > left) affordable = false;
    left -= Math.min(4 * a.troops, left);
  }
  const before = w.sent.length;
  tick(w);
  return {
    turn: d,
    alive,
    affordable,
    surplus,
    sends: w.sent.slice(before).filter((s) => s.from === NATION_ID),
  };
}

/** Its decisions until the first send after every tribe died. */
function runRod(w: World): Decision[] {
  const decisions: Decision[] = [];
  for (let k = 0; k < 30; k++) {
    const dec = decide(w);
    decisions.push(dec);
    if (dec.alive.length === 0 && dec.sends.length > 0) break;
  }
  return decisions;
}

function debug(lines: string[]): void {
  if (process.env.N9_DEBUG) process.stderr.write(lines.join("\n") + "\n");
}

const GAME_IDS = ["rod-a", "rod-b", "rod-c", "rod-d"];

describe("LightningRod (N9)", () => {
  test("control: without the tribe it attacks us at its first decision that sends (juicy)", () => {
    for (const id of GAME_IDS) {
      const w = world(id, []);
      start(w);
      let first: Decision | null = null;
      for (let k = 0; k < 10 && first === null; k++) {
        const dec = decide(w);
        if (dec.sends.length > 0) first = dec;
      }
      expect(first).not.toBeNull();
      expect(first!.sends.map((s) => s.to)).toEqual([AGENT_ID]);
      // We were juicy: at most 0.75 x its troops.
      expect(US_SHARE).toBeLessThanOrEqual(0.75);
    }
  });

  test("an affordable tribe draws every send until it is gone; then it attacks us", () => {
    const lines: string[] = [];
    for (const [id, D] of GAME_IDS.flatMap((g) =>
      [5_000, 15_000].map((d) => [g, d] as const),
    )) {
      const w = world(id, [D]);
      start(w);
      const decisions = runRod(w);
      const whileAlive = decisions.filter((d) => d.alive.length > 0);
      const after = decisions.filter((d) => d.alive.length === 0);
      expect(whileAlive.length).toBeGreaterThan(0);
      for (const d of whileAlive) {
        expect(d.affordable).toBe(true);
        for (const s of d.sends) {
          expect(s.to).toBe(TRIBE_IDS[0]);
          // calculateBotAttackTroops: 4D, or the whole surplus if it is
          // less (and at least 2D).
          const D0 = d.alive[0].troops;
          expect(s.troops).toBeCloseTo(Math.min(4 * D0, d.surplus), 6);
          expect(s.troops).toBeGreaterThanOrEqual(2 * D0);
        }
      }
      expect(whileAlive.some((d) => d.sends.length > 0)).toBe(true);
      const firstAfter = after.find((d) => d.sends.length > 0);
      expect(firstAfter).toBeDefined();
      expect(firstAfter!.sends.map((s) => s.to)).toEqual([AGENT_ID]);
      lines.push(
        `${id} D=${D}: ${whileAlive.length} decision(s) with the tribe alive, then us at turn ${firstAfter!.turn}`,
      );
    }
    debug(lines);
  });

  test("two affordable tribes are attacked in parallel in one decision: no longer a shield than one", () => {
    const lines: string[] = [];
    for (const id of GAME_IDS) {
      const w = world(id, [5_000, 5_000]);
      start(w);
      const decisions = runRod(w);
      const first = decisions.find((d) => d.sends.length > 0)!;
      // attackBots sends to every affordable tribe (Impossible: up to 100).
      expect(first.alive).toHaveLength(2);
      expect(new Set(first.sends.map((s) => s.to))).toEqual(new Set(TRIBE_IDS));
      const firstAfter = decisions.find(
        (d) => d.alive.length === 0 && d.sends.length > 0,
      );
      expect(firstAfter!.sends.map((s) => s.to)).toEqual([AGENT_ID]);
      lines.push(
        `${id} 2 tribes: ${decisions.filter((d) => d.alive.length > 0).length} decision(s) shielded`,
      );
    }
    debug(lines);
  });

  test("a tribe the nation cannot afford (2D > T - reserve x cap) is no rod: it attacks us", () => {
    for (const id of GAME_IDS) {
      // 2D above every reserve surplus (62% - 30..39% of its cap).
      const w = world(id, [40_000]);
      start(w);
      let first: Decision | null = null;
      for (let k = 0; k < 10 && first === null; k++) {
        const dec = decide(w);
        if (dec.sends.length > 0) first = dec;
      }
      expect(first).not.toBeNull();
      expect(first!.alive).toHaveLength(1);
      expect(first!.affordable).toBe(false);
      expect(first!.sends.map((s) => s.to)).toEqual([AGENT_ID]);
    }
  });

  test("frozen: at our home >= T / 0.9 its send cap is 0, and it attacks neither the tribe nor us", () => {
    for (const id of GAME_IDS) {
      const w = world(id, [5_000]);
      start(w);
      for (let k = 0; k < 6; k++) {
        const dec = decide(w, 1 / 0.9 + 0.001);
        expect(dec.alive).toHaveLength(1);
        expect(dec.sends).toEqual([]);
      }
    }
  });
});
