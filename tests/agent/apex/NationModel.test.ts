/**
 * NationModel (apex spec §2.4, §4 step 3): each predicate against the real
 * code path on constructed scenarios, and the forked accuracy of
 * canLandAttackUs on real maps.
 *
 * Synthetic worlds (the first blocks): the real Config class as
 * createGameRunner builds it (GameRunner.ts:46: new Config(gameConfig, null,
 * false)), FFA, Singleplayer, Impossible, 400 tribes in the config; the game
 * built as tests/util/Setup.ts builds it (createGame, endSpawnPhase at tick
 * 0) on synthesized all-plains maps laid out per test; the nation runs its
 * real NationExecution, seeded as in a game (gameID + id). Unless a test
 * says so no PlayerExecution runs, so troops stay where the test puts them,
 * always before a decision. The nation's private fields are read through
 * casts (test only) to compare with the model; the model itself only reads
 * the game. Every attack is recorded as it is constructed (the decision).
 *
 * The forked accuracy test (last block, spec §4 step 3 reduced to fit in
 * about 25 s): Pangaea and BosphorusStraits through the arena path
 * (arenaGameStart -> createGameRunner, NodeMapLoader), the baseline agent
 * playing our seat through AgentHost; at 12 moments per map (ticks 600 to
 * 1,700) every bordering nation is predicted on the live game (read-only:
 * its snapshot bytes are unchanged afterwards), and a fork (GameFork) is
 * stepped with no intents of ours to its decision. Measured (88 samples, 3
 * attacks on us):
 *   our home now:            accuracy 0.909, safe side 1.000 of 65
 *   our home at the decision: accuracy 0.932, safe side 1.000 of 71
 *   nowcast on the eve:       accuracy 0.977, safe side 1.000 of 73
 * "Predicted attack" = canLandAttackUs && gate open && wouldTargetUs names
 * us; "safe side" = the share of canLandAttackUs = false with no attack.
 * The same run infers every nation's rate and phase with no gameID (50 of
 * 50 exact by tick 1,800; expand exact for 49, never below the truth).
 */
import path from "path";
import { AgentHost } from "../../../src/agent/AgentHost";
import { createAgent } from "../../../src/agent/agents";
import {
  arenaGameStart,
  seatClientID,
  type ArenaGameSpec,
} from "../../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../../src/agent/arena/NodeMapLoader";
import { GameFork, TerrainSource } from "../../../src/agent/Fork";
import { createModels } from "../../../src/agent/lib/Models";
import {
  AllianceForecast,
  NationModel,
  nationParams,
  nextDecision,
} from "../../../src/agent/lib/NationModel";
import { Config } from "../../../src/core/configuration/Config";
import { AllianceRequestExecution } from "../../../src/core/execution/alliance/AllianceRequestExecution";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import { TransportShipExecution } from "../../../src/core/execution/TransportShipExecution";
import {
  AllianceRequest,
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
import { createGameRunner, GameRunner } from "../../../src/core/GameRunner";
import {
  GameConfig,
  GameStartInfo,
  Intent,
  IntentSchema,
  StampedIntent,
} from "../../../src/core/Schemas";

const AGENT_CLIENT = "AGENTCL1";
const AGENT_ID = "AGENTID1";
const NATION_ID = "NATION01";
const THIRD_ID = "THIRD001";
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

type Seat = "nation" | "us" | "third" | "tribe" | "free";

interface Spec {
  width?: number;
  height?: number;
  /** Who holds (x, y); default: the nation x 0-9, us the rest. */
  seat?: (x: number, y: number) => Seat;
  /** The third player's type (a Nation seat has no NationExecution). */
  third?: PlayerType.Nation | PlayerType.Human;
  gameID?: string;
}

interface NationInternals {
  attackRate: number;
  attackTick: number;
  triggerRatio: number;
  reserveRatio: number;
  expandRatio: number;
  behaviorsInitialized: boolean;
  attackBehavior: {
    troopSendCap(): number;
    sendAttack(target: Player | TerraNullius, force?: boolean): boolean;
    attackBestTarget(friends: Player[], enemies: Player[]): void;
  };
}

interface Sent {
  tick: number;
  from: PlayerID;
  to: PlayerID | null;
  troops: number;
  boat: boolean;
}

interface World {
  gameID: string;
  game: Game;
  config: Config;
  us: Player;
  nation: Player;
  third: Player | null;
  tribe: Player | null;
  exec: NationExecution;
  n: NationInternals;
  executor: Executor;
  sent: Sent[];
  nm: NationModel;
}

function world(spec: Spec = {}): World {
  const width = spec.width ?? 60;
  const height = spec.height ?? 20;
  const gameID = spec.gameID ?? "nation-model";
  const seat = spec.seat ?? ((x) => (x < 10 ? "nation" : "us"));
  const t = new Uint8Array(width * height).fill(LAND);
  const mw = Math.ceil(width / 2);
  const mh = Math.ceil(height / 2);
  const m = new Uint8Array(mw * mh).fill(LAND);
  const map = new GameMapImpl(width, height, t, width * height);
  const mini = new GameMapImpl(mw, mh, m, mw * mh);
  const config = new Config(GAME_CONFIG, null, false);
  const nationObj = new Nation(
    new Cell(0, 0),
    new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
  );
  const humans = [
    new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID),
  ];
  const nations = [nationObj];
  if (spec.third === PlayerType.Human) {
    humans.push(
      new PlayerInfo("rival", PlayerType.Human, "THIRDCL1", THIRD_ID),
    );
  } else if (spec.third === PlayerType.Nation) {
    nations.push(
      new Nation(
        new Cell(0, 0),
        new PlayerInfo("rival", PlayerType.Nation, null, THIRD_ID),
      ),
    );
  }
  const game = createGame(humans, nations, map, mini, config);
  game.endSpawnPhase();
  const us = game.player(AGENT_ID);
  const nation = game.player(NATION_ID);
  const third = spec.third === undefined ? null : game.player(THIRD_ID);
  let tribe: Player | null = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = seat(x, y);
      const tile = game.ref(x, y);
      if (s === "nation") nation.conquer(tile);
      else if (s === "us") us.conquer(tile);
      else if (s === "third") third!.conquer(tile);
      else if (s === "tribe") {
        tribe ??= game.addPlayer(
          new PlayerInfo("tribe", PlayerType.Bot, null, TRIBE_ID),
        );
        tribe.conquer(tile);
      }
    }
  }
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
    gameID,
    game,
    config,
    us,
    nation,
    third,
    tribe,
    exec,
    n: exec as unknown as NationInternals,
    executor: new Executor(game, gameID, undefined),
    sent,
    nm: new NationModel(game, us, gameID, createModels(game)),
  };
}

/** One tick, then the model observes, as the apex policy runs it. */
function tick(w: World, n = 1): void {
  for (let i = 0; i < n; i++) {
    w.game.executeNextTick();
    w.nm.observe(w.game.ticks());
  }
}

function advanceTo(w: World, t: number): void {
  while (w.game.ticks() < t) tick(w);
}

function send(w: World, intent: Intent): void {
  expect(IntentSchema.safeParse(intent).success).toBe(true);
  w.game.addExecution(
    w.executor.createExec({ ...intent, clientID: AGENT_CLIENT }),
  );
}

/** Adds the nation's execution past tick 750 and runs its opening. */
function startNation(w: World): void {
  advanceTo(w, 750);
  w.game.addExecution(w.exec);
  tick(w, 3);
  expect(w.n.behaviorsInitialized).toBe(true);
}

function isDecision(w: World, t: number): boolean {
  return t % w.n.attackRate === w.n.attackTick;
}

function nextDecisionTurn(w: World, from: number): number {
  let d = from;
  while (!isDecision(w, d)) d++;
  return d;
}

/** Runs its decision d (game.ticks() === d before), returning its sends. */
function runDecision(w: World): Sent[] {
  const before = w.sent.length;
  tick(w);
  return w.sent.slice(before).filter((s) => s.from === NATION_ID);
}

describe("NationModel: parameters and troops", () => {
  test("params and nextDecision match the NationExecution", () => {
    for (const gameID of ["nm-a", "nm-b", "nm-c"]) {
      const w = world({ gameID });
      startNation(w);
      const p = w.nm.params(NATION_ID);
      expect(p).toEqual(nationParams(gameID, NATION_ID, Difficulty.Impossible));
      expect(p.rate).toBe(w.n.attackRate);
      expect(p.phase).toBe(w.n.attackTick);
      expect(p.trigger).toBe(w.n.triggerRatio);
      expect(p.reserve).toBe(w.n.reserveRatio);
      expect(p.expand).toBe(w.n.expandRatio);
      const t = w.game.ticks();
      for (let from = t; from < t + 120; from += 7) {
        expect(w.nm.nextDecision(NATION_ID, from)).toBe(
          nextDecisionTurn(w, from),
        );
        expect(nextDecision(p, from)).toBe(nextDecisionTurn(w, from));
      }
    }
  });

  test("troopsAt(d) equals its troops at d when it only regrows (below, near and above its cap)", () => {
    // No neighbour to attack but a player it cannot afford to (below its
    // reserve), so its home changes only by PlayerExecution's regrowth.
    for (const share of [0.05, 0.2, 0.28, 1.05]) {
      const w = world({ gameID: `troops-${share}` });
      w.game.addExecution(new PlayerExecution(w.nation));
      advanceTo(w, 200);
      const M = w.config.maxTroops(w.nation);
      w.nation.setTroops(Math.floor(M * share));
      // Our troops high enough that its send cap is 0 (frozen).
      w.us.setTroops(Math.floor(M * 2));
      w.nm.refresh(NATION_ID, "full");
      const now = w.game.ticks();
      const predicted = [1, 5, 20, 49, 120].map((k) => ({
        k,
        T: w.nm.troopsAt(NATION_ID, now + k),
      }));
      const actual = new Map<number, number>();
      for (let k = 1; k <= 120; k++) {
        tick(w);
        actual.set(k, w.nation.troops());
      }
      for (const { k, T } of predicted) expect(T).toBe(actual.get(k));
      if (share > 1) {
        // C2: cut to ceil(cap) on the next tick.
        expect(actual.get(1)).toBe(Math.ceil(M));
      }
    }
  });
});

describe("NationModel: sendCap", () => {
  test("equals troopSendCap in every scenario", () => {
    interface Case {
      name: string;
      spec: Spec;
      setup?: (w: World) => void;
      H: number;
      T: number;
    }
    const band = (x: number, y: number): Seat =>
      x < 10 ? "nation" : y < 10 ? "us" : "third";
    const cases: Case[] = [
      { name: "us only", spec: {}, H: 50_000, T: 100_000 },
      { name: "us strong", spec: {}, H: 200_000, T: 100_000 },
      {
        name: "a stronger third nation",
        spec: { seat: band, third: PlayerType.Nation },
        setup: (w) => w.third!.setTroops(150_000),
        H: 50_000,
        T: 100_000,
      },
      {
        name: "a weaker third human",
        spec: { seat: band, third: PlayerType.Human },
        setup: (w) => w.third!.setTroops(10_000),
        H: 50_000,
        T: 100_000,
      },
      {
        name: "the stronger third is its ally",
        spec: { seat: band, third: PlayerType.Nation },
        setup: (w) => {
          w.third!.setTroops(150_000);
          w.game.addExecution(
            new AllianceRequestExecution(w.nation, THIRD_ID),
            new AllianceRequestExecution(w.third!, NATION_ID),
          );
          tick(w);
          expect(w.nation.isAlliedWith(w.third!)).toBe(true);
        },
        H: 50_000,
        T: 100_000,
      },
      {
        name: "a tribe does not count",
        spec: { seat: (x, y) => (x < 10 ? "nation" : y < 10 ? "us" : "tribe") },
        setup: (w) => w.tribe!.setTroops(500_000),
        H: 50_000,
        T: 100_000,
      },
      {
        name: "under attack: at least the incoming troops",
        spec: {},
        setup: (w) => {
          send(w, { type: "attack", targetID: NATION_ID, troops: 30_000 });
          tick(w);
          expect(w.nation.incomingAttacks()).toHaveLength(1);
        },
        H: 200_000,
        T: 100_000,
      },
    ];
    for (const c of cases) {
      const w = world({ gameID: "cap", ...c.spec });
      startNation(w);
      w.us.setTroops(c.H + (c.name.startsWith("under") ? 30_000 : 0));
      c.setup?.(w);
      w.nation.setTroops(c.T);
      w.nm.refresh(NATION_ID, "full");
      const real = w.n.attackBehavior.troopSendCap();
      expect({
        name: c.name,
        cap: w.nm.sendCap(NATION_ID, w.us.troops()),
      }).toEqual({ name: c.name, cap: real });
    }
  });
});

// ── Gates and canLandAttackUs ────────────────────────────────────────────

interface Probe {
  /** Results of sendAttack(terra nullius) in the decision. */
  freeLand: boolean[];
  reachedBestTarget: boolean;
}

/** Wraps its AiAttackBehavior (test only) to see how far a decision got. */
function instrument(w: World): () => Probe {
  const ab = w.n.attackBehavior;
  let current: Probe = { freeLand: [], reachedBestTarget: false };
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
  return () => {
    const p = current;
    current = { freeLand: [], reachedBestTarget: false };
    return p;
  };
}

/** Frees x 10-19 of rows 10-19 again (whoever took it). */
function freePocket(w: World): void {
  for (let x = 10; x < 20; x++) {
    for (let y = 10; y < 20; y++) {
      const tile = w.game.ref(x, y);
      const owner = w.game.owner(tile);
      if (owner.isPlayer()) owner.relinquish(tile);
    }
  }
}

describe("NationModel: gates", () => {
  test("gates at a decision match how far the real decision gets", () => {
    interface Case {
      name: string;
      seat: (x: number, y: number) => Seat;
      pocket: boolean;
      /** Its troops as a function of its cap and ratios. */
      T: (M: number, n: NationInternals) => number;
      tribeCity?: boolean;
    }
    const pocketSeat = (x: number, y: number): Seat =>
      x < 10 ? "nation" : x < 20 && y >= 10 ? "us" : "us";
    const tribeSeat = (x: number, y: number): Seat =>
      x < 10 ? "nation" : x < 20 && y >= 10 ? "tribe" : "us";
    const cases: Case[] = [
      {
        name: "free land, above the lock line",
        seat: pocketSeat,
        pocket: true,
        T: (M, n) => Math.ceil(n.expandRatio * M) + 1,
      },
      {
        name: "free land, rich",
        seat: pocketSeat,
        pocket: true,
        T: (M) => Math.floor(0.62 * M),
      },
      {
        name: "free land, below the lock line",
        seat: pocketSeat,
        pocket: true,
        T: (M, n) => Math.floor(n.expandRatio * M) - 1,
      },
      {
        name: "no free land, below reserve",
        seat: pocketSeat,
        pocket: false,
        T: (M, n) => Math.floor(n.reserveRatio * M) - 1,
      },
      {
        name: "no free land, between reserve and trigger",
        seat: pocketSeat,
        pocket: false,
        T: (M, n) => Math.floor(((n.reserveRatio + n.triggerRatio) / 2) * M),
      },
      {
        name: "no free land, open",
        seat: pocketSeat,
        pocket: false,
        T: (M, n) => Math.ceil(n.triggerRatio * M) + 1,
      },
      {
        name: "a structure tribe below reserve",
        seat: tribeSeat,
        pocket: false,
        T: (M, n) => Math.floor(((n.expandRatio + n.reserveRatio) / 2) * M),
        tribeCity: true,
      },
    ];
    const counts: Record<string, Record<string, number>> = {};
    for (const c of cases) {
      for (const gameID of ["g-a", "g-b", "g-c"]) {
        const w = world({ gameID, seat: c.seat });
        if (w.tribe !== null) {
          w.tribe.setTroops(2_000);
          if (c.tribeCity)
            w.tribe.buildUnit(UnitType.City, w.game.ref(15, 15), {});
        }
        startNation(w);
        const probe = instrument(w);
        for (let k = 0; k < 10; k++) {
          const d = nextDecisionTurn(w, w.game.ticks());
          advanceTo(w, d);
          // Its attacks eat us (and the tribe); stop once they are gone.
          if (!w.nation.sharesBorderWith(w.us)) break;
          if (c.tribeCity && !w.tribe!.isAlive()) break;
          if (c.pocket) freePocket(w);
          const M = w.config.maxTroops(w.nation);
          const T = c.T(M, w.n);
          w.nation.setTroops(T);
          // Juicy and weakest: it attacks us whenever it reaches the list.
          w.us.setTroops(Math.floor(T / 2));
          w.nm.refresh(NATION_ID, "full");
          const gate = w.nm.gates(NATION_ID, d);
          probe();
          const sends = runDecision(w);
          const p = probe();
          counts[c.name] ??= {};
          counts[c.name][gate] = (counts[c.name][gate] ?? 0) + 1;
          const toUs = sends.filter((s) => s.to === AGENT_ID).length;
          switch (gate) {
            case "locked":
              expect(toUs).toBe(0);
              if (c.pocket) {
                expect(p.freeLand).toEqual([true]);
                expect(p.reachedBestTarget).toBe(false);
              } else {
                expect(sends.map((s) => s.to)).toEqual([TRIBE_ID]);
              }
              break;
            case "belowReserve":
              expect(sends).toEqual([]);
              break;
            case "belowTrigger":
              // The list runs 1 decision in 10 (AiAttackBehavior.ts:293).
              expect(sends.every((s) => s.to === AGENT_ID)).toBe(true);
              break;
            case "open":
              // A random boat attempt ends 1 decision in 10 (no shore here).
              expect(sends.every((s) => s.to === AGENT_ID)).toBe(true);
              if (!p.reachedBestTarget) expect(sends).toEqual([]);
              else expect(toUs).toBe(1);
              break;
          }
        }
      }
    }
    // Each case got the gate it was built for.
    expect(Object.keys(counts["free land, above the lock line"])).toEqual([
      "locked",
    ]);
    expect(Object.keys(counts["free land, rich"])).toEqual(["locked"]);
    expect(Object.keys(counts["free land, below the lock line"])).toEqual([
      "belowReserve",
    ]);
    expect(Object.keys(counts["no free land, below reserve"])).toEqual([
      "belowReserve",
    ]);
    expect(
      Object.keys(counts["no free land, between reserve and trigger"]),
    ).toEqual(["belowTrigger"]);
    expect(Object.keys(counts["no free land, open"])).toEqual(["open"]);
    expect(Object.keys(counts["a structure tribe below reserve"])).toEqual([
      "locked",
    ]);
  });
});

describe("NationModel: canLandAttackUs", () => {
  test("the H* = T/1.1 line and the frozen line T/0.9, against its real decisions", () => {
    const rows: string[] = [];
    for (const gameID of ["h-a", "h-b", "h-c"]) {
      for (const f of [
        0.5,
        0.85,
        1 / 1.1 - 0.002,
        1 / 1.1 + 0.002,
        0.95,
        1 / 0.9 + 0.01,
      ]) {
        const w = world({ gameID });
        startNation(w);
        let predicted: boolean | null = null;
        let attacked = 0;
        for (let k = 0; k < 6; k++) {
          const d = nextDecisionTurn(w, w.game.ticks());
          advanceTo(w, d);
          if (!w.nation.sharesBorderWith(w.us)) break;
          const M = w.config.maxTroops(w.nation);
          const T = Math.floor(0.62 * M);
          w.nation.setTroops(T);
          const H = Math.floor(T * f);
          w.us.setTroops(H);
          w.nm.refresh(NATION_ID, "full");
          const can = w.nm.canLandAttackUs(NATION_ID, H, d);
          predicted ??= can;
          expect(can).toBe(predicted);
          const sends = runDecision(w);
          const toUs = sends.filter((s) => s.to === AGENT_ID);
          if (toUs.length > 0) {
            attacked++;
            // Its send: min(T - reserve x cap, troopSendCap).
            const s = Math.min(
              T - w.n.reserveRatio * M,
              Math.max(0, T - Math.ceil(0.9 * H)),
            );
            expect(toUs[0].troops).toBeCloseTo(s, 6);
          }
        }
        rows.push(
          `${gameID} H/T=${f.toFixed(3)} can=${predicted} attacked=${attacked}/6`,
        );
        if (process.env.NM_DEBUG)
          process.stderr.write(rows[rows.length - 1] + "\n");
        if (predicted) expect(attacked).toBeGreaterThan(0);
        else expect(attacked).toBe(0);
        expect(predicted).toBe(f < 1 / 1.1);
      }
    }
    expect(rows).toHaveLength(18);
  });

  test("under attack (a tribe pokes it) the 20% floor lifts; allied or not bordering it cannot", () => {
    const tribeSeat = (x: number, y: number): Seat =>
      x < 10 ? "nation" : x < 20 && y >= 10 ? "tribe" : "us";
    const w = world({ gameID: "u-a", seat: tribeSeat });
    w.tribe!.setTroops(500_000);
    startNation(w);
    const d = nextDecisionTurn(w, w.game.ticks());
    advanceTo(w, d - 1);
    const M = w.config.maxTroops(w.nation);
    const T = Math.floor(0.62 * M);
    // Our home 0.95 T: its cap T - ceil(0.855 T) = 0.145 T < 0.2 x 0.95 T,
    // too weak unless it is under attack.
    const H = Math.floor(0.95 * T);
    w.nation.setTroops(T);
    w.us.setTroops(H);
    w.nm.refresh(NATION_ID, "full");
    expect(w.nm.canLandAttackUs(NATION_ID, H, d)).toBe(false);
    // A phantom tribe attack on it (the Attack object, no execution).
    w.tribe!.createAttack(w.nation, 1_000, null, new Set());
    expect(w.nation.incomingAttacks()).toHaveLength(1);
    w.nm.refresh(NATION_ID, "full");
    expect(w.nm.canLandAttackUs(NATION_ID, H, d)).toBe(true);
    // Allied: never.
    const w2 = world({ gameID: "u-b" });
    startNation(w2);
    w2.game.addExecution(new AllianceRequestExecution(w2.nation, AGENT_ID));
    send(w2, { type: "allianceRequest", recipient: NATION_ID });
    tick(w2, 2);
    expect(w2.us.isAlliedWith(w2.nation)).toBe(true);
    w2.nation.setTroops(Math.floor(0.62 * w2.config.maxTroops(w2.nation)));
    w2.nm.refresh(NATION_ID, "full");
    expect(
      w2.nm.canLandAttackUs(
        NATION_ID,
        1_000,
        w2.nm.nextDecision(NATION_ID, w2.game.ticks()),
      ),
    ).toBe(false);
  });
});

// ── wouldTargetUs ────────────────────────────────────────────────────────

describe("NationModel: wouldTargetUs", () => {
  test("the Impossible list: each reason, and whether its real decisions attack us", () => {
    interface Case {
      name: string;
      spec?: Spec;
      /** Our home as a share of its troops T. */
      H: (T: number, w: World) => number;
      /** Called before each decision, after troops are set. */
      before?: (w: World, d: number) => void;
      /** Once, after the nation started. */
      once?: (w: World) => void;
      reason: string | null;
    }
    const withThird = (x: number): Seat =>
      x < 10 ? "nation" : x < 30 ? "us" : "third";
    const withTribe = (x: number, y: number): Seat =>
      x < 10 ? "nation" : x < 20 && y >= 10 ? "tribe" : "us";
    const cases: Case[] = [
      { name: "weakest", H: (T) => 0.85 * T, reason: "weakest" },
      { name: "juicy", H: (T) => 0.5 * T, reason: "juicy" },
      {
        name: "veryWeak",
        H: (_T, w) => 0.1 * w.config.maxTroops(w.us),
        reason: "veryWeak",
      },
      {
        name: "bots first",
        spec: { seat: withTribe },
        once: (w) => w.tribe!.setTroops(2_000),
        H: (T) => 0.5 * T,
        reason: null,
      },
      {
        name: "retaliate",
        H: (T) => 1.05 * T,
        before: (w) => {
          // A running attack of ours on it (a phantom Attack, no execution).
          if (w.nation.incomingAttacks().length === 0) {
            w.us.createAttack(w.nation, 30_000, null, new Set());
          }
        },
        reason: "retaliate",
      },
      {
        name: "victim",
        spec: { seat: withThird, third: PlayerType.Nation },
        H: (T) => 0.85 * T,
        before: (w) => {
          w.third!.setTroops(1_000_000);
          if (w.us.incomingAttacks().length === 0) {
            w.third!.createAttack(w.us, 1_000_000, null, new Set());
          }
        },
        reason: "victim",
      },
      {
        name: "hated",
        H: (T) => 0.8 * T,
        before: (w) => {
          w.nation.updateRelation(w.us, -100);
        },
        reason: "hated",
      },
      {
        name: "traitor",
        spec: { seat: withThird, third: PlayerType.Nation },
        once: (w) => {
          w.third!.setTroops(1_000_000);
          w.game.addExecution(new AllianceRequestExecution(w.third!, AGENT_ID));
          send(w, { type: "allianceRequest", recipient: THIRD_ID });
          tick(w, 2);
          send(w, { type: "breakAlliance", recipient: THIRD_ID });
          tick(w, 2);
          expect(w.us.isTraitor()).toBe(true);
          // The break's -40 is not Hostile: not "hated".
        },
        H: (T) => 0.8 * T,
        reason: "traitor",
      },
      { name: "none", H: (T) => 1.2 * T, reason: null },
    ];
    for (const c of cases) {
      for (const gameID of ["t-a", "t-b"]) {
        const w = world({ gameID, ...c.spec });
        startNation(w);
        c.once?.(w);
        let predicted: string | null | undefined;
        let attacked = 0;
        let can = false;
        for (let k = 0; k < 4; k++) {
          const d = nextDecisionTurn(w, w.game.ticks());
          advanceTo(w, d);
          if (!w.nation.sharesBorderWith(w.us)) break;
          if (c.name === "traitor" && !w.us.isTraitor()) break;
          if (w.tribe !== null && !w.tribe.isAlive()) break;
          const T = Math.floor(0.62 * w.config.maxTroops(w.nation));
          w.nation.setTroops(T);
          const H = Math.floor(c.H(T, w));
          w.us.setTroops(H);
          c.before?.(w, d);
          w.nm.refresh(NATION_ID, "full");
          const reason = w.nm.wouldTargetUs(NATION_ID, H);
          predicted ??= reason;
          expect({ name: c.name, reason }).toEqual({
            name: c.name,
            reason: c.reason,
          });
          can = w.nm.canLandAttackUs(NATION_ID, H, d);
          const sends = runDecision(w);
          if (sends.some((s) => s.to === AGENT_ID)) attacked++;
        }
        expect(predicted).toBe(c.reason);
        // Attacks happen iff a reason names us and it can land-attack us.
        if (c.reason !== null && can) expect(attacked).toBeGreaterThan(0);
        else
          expect({ name: c.name, attacked }).toEqual({
            name: c.name,
            attacked: 0,
          });
      }
    }
  });
});

// ── acceptsAlliance ──────────────────────────────────────────────────────

/**
 * An alliance world: the nation x 0-9 (200 tiles), us x 10-17 (160 tiles,
 * under 0.9 x its tiles, so only the troop draw of the similar-strength
 * test counts), inert Nation seats ("others", no NationExecution) on x 18+
 * away from it. Its troops are set below its reserve before each request,
 * so it attacks nothing before the answering decision; it regrows (its
 * PlayerExecution runs), which troopsAt predicts.
 */
function allianceWorld(
  gameID: string,
  opts: { others?: number; otherBesideIt?: boolean; startAt?: number } = {},
): World & { others: Player[] } {
  const others = opts.others ?? 0;
  const w = world({
    gameID,
    width: 20 + 2 * others,
    seat: (x, y) =>
      x < 10
        ? "nation"
        : x < 18
          ? opts.otherBesideIt && x === 10 && y === 19
            ? "free"
            : "us"
          : "free",
  });
  const list: Player[] = [];
  for (let i = 0; i < others; i++) {
    const p = w.game.addPlayer(
      new PlayerInfo(`other${i}`, PlayerType.Nation, null, `OTHER00${i}`),
    );
    for (let x = 18 + 2 * i; x < 20 + 2 * i; x++) {
      for (let y = 0; y < 20; y++) p.conquer(w.game.ref(x, y));
    }
    list.push(p);
  }
  // The free pocket at the far right edge (x 18-19 when no others) belongs
  // to nobody the nation touches.
  if (opts.otherBesideIt) list[0].conquer(w.game.ref(10, 19));
  advanceTo(w, opts.startAt ?? 750);
  // Its execution first, then its PlayerExecution (regrowth, decay), in a
  // game's order; ours does not run, so our home stays as set.
  w.game.addExecution(w.exec);
  w.game.addExecution(new PlayerExecution(w.nation));
  tick(w, 3);
  return { ...w, others: list };
}

/** A relation change the test makes by hand, reported to the tracker as
 *  an observed event would be. */
function setRelation(w: World, delta: number): void {
  w.nation.updateRelation(w.us, delta);
  w.nm.relations.onEvent(NATION_ID, w.game.ticks(), delta, "donation");
}

function allyPair(w: World, a: Player, b: Player): void {
  w.game.addExecution(
    new AllianceRequestExecution(a, b.id()),
    new AllianceRequestExecution(b, a.id()),
  );
  tick(w);
  expect(a.isAlliedWith(b)).toBe(true);
}

interface Asked {
  f: AllianceForecast;
  accepted: boolean;
  answeredAt: number;
  predictedAt: number;
}

/**
 * Sends our request now (after an optional embargo stop), runs to the eve
 * of the answering decision, sets the troops there (its below its reserve,
 * so it attacks nothing; ours from it), forecasts with margin 0 from that
 * tick, and runs the decision. troopsAt's horizon is tested on its own
 * above; here the forecast of the decision itself is exact.
 */
function ask(
  w: World,
  opts: { H: (T: number) => number; stop?: boolean },
): Asked {
  // A request of its own to us would counter-accept ours: refuse it.
  if (w.us.incomingAllianceRequests().some((r) => r.requestor() === w.nation)) {
    send(w, { type: "allianceReject", requestor: NATION_ID });
    tick(w);
  }
  // The answering decision must be at least 2 turns out, so a stop sent
  // now counts.
  const t = w.game.ticks();
  if (w.nm.nextDecision(NATION_ID, t + 1) < t + 2) tick(w);
  const now = w.game.ticks();
  if (opts.stop) {
    send(w, { type: "embargo", targetID: NATION_ID, action: "stop" });
  }
  send(w, { type: "allianceRequest", recipient: NATION_ID });
  tick(w);
  const req = w.nation
    .incomingAllianceRequests()
    .find((r) => r.requestor() === w.us) as AllianceRequest;
  expect(req).toBeDefined();
  const atTick = w.nm.nextDecision(NATION_ID, now + 1);
  advanceTo(w, atTick);
  expect(req.status()).toBe("pending");
  const M = w.config.maxTroops(w.nation);
  const T = Math.floor(0.2 * M);
  expect(T).toBeLessThan(w.n.reserveRatio * M);
  w.nation.setTroops(T);
  w.us.setTroops(Math.floor(opts.H(T)));
  w.nm.refresh(NATION_ID, "full");
  const f = w.nm.acceptsAlliance(NATION_ID, {
    kind: "request",
    createdAt: now,
    atTick,
    embargoStoppedBy: opts.stop ? now : null,
    margin: 0,
  });
  tick(w);
  expect(req.status()).not.toBe("pending");
  return {
    f,
    accepted: req.status() === "accepted",
    answeredAt: w.game.ticks() - 1,
    predictedAt: atTick,
  };
}

describe("NationModel: acceptsAlliance", () => {
  test("deterministic branches agree with its real answer", () => {
    interface Case {
      name: string;
      H: (T: number) => number;
      setup?: (w: World & { others: Player[] }) => void;
      others?: number;
      otherBesideIt?: boolean;
      stop?: boolean;
      p: number;
      branch: string;
    }
    const cases: Case[] = [
      { name: "similar, sure", H: (T) => 0.95 * T, p: 1, branch: "similar" },
      { name: "similar, never", H: (T) => 0.75 * T, p: 0, branch: "no" },
      {
        name: "threat beats a hostile relation",
        H: (T) => 1.6 * T,
        setup: (w) => setRelation(w, -100),
        p: 1,
        branch: "threat",
      },
      {
        name: "hostile",
        H: (T) => 0.95 * T,
        setup: (w) => setRelation(w, -60),
        p: 0,
        branch: "hostile",
      },
      {
        name: "our embargo, no stop: the malus lands first",
        H: (T) => 0.95 * T,
        setup: (w) => {
          send(w, { type: "embargo", targetID: NATION_ID, action: "start" });
          tick(w, 2);
        },
        p: 0,
        branch: "hostile",
      },
      {
        name: "our embargo, stopped in time",
        H: (T) => 0.95 * T,
        setup: (w) => {
          send(w, { type: "embargo", targetID: NATION_ID, action: "start" });
          tick(w, 2);
        },
        stop: true,
        p: 1,
        branch: "similar",
      },
      {
        name: "tooMany: our alliances >= 25% of the non-bot players",
        others: 1,
        H: (T) => 0.95 * T,
        setup: (w) => allyPair(w, w.us, w.others[0]),
        p: 0,
        branch: "tooMany",
      },
      {
        name: "enough: we are its last unallied non-bot neighbour",
        others: 3,
        otherBesideIt: true,
        H: (T) => 0.95 * T,
        setup: (w) => allyPair(w, w.nation, w.others[0]),
        p: 0,
        branch: "enough",
      },
      {
        name: "enough: 3 alliances already",
        others: 3,
        H: (T) => 0.95 * T,
        setup: (w) => {
          for (const o of w.others) allyPair(w, w.nation, o);
        },
        p: 0,
        branch: "enough",
      },
    ];
    for (const c of cases) {
      for (const gameID of ["a-a", "a-b", "a-c"]) {
        const w = allianceWorld(gameID, {
          others: c.others,
          otherBesideIt: c.otherBesideIt,
        });
        c.setup?.(w);
        const a = ask(w, { H: c.H, stop: c.stop });
        expect(a.answeredAt).toBe(a.predictedAt);
        expect({ name: c.name, p: a.f.p, branch: a.f.branch }).toEqual({
          name: c.name,
          p: c.p,
          branch: c.branch,
        });
        expect(a.f.deterministic).toBe(true);
        expect({ name: c.name, accepted: a.accepted }).toEqual({
          name: c.name,
          accepted: c.p === 1,
        });
      }
    }
    // A request created in the spawn phase (+1) is refused, threats too.
    const w = allianceWorld("a-s");
    const f = w.nm.acceptsAlliance(NATION_ID, {
      kind: "request",
      createdAt: w.config.numSpawnPhaseTurns() + 1,
      atTick: w.game.ticks() + 10,
      embargoStoppedBy: null,
      ourHome: 1e9,
    });
    expect(f).toEqual({ p: 0, branch: "spawnPhase", deterministic: true });
  });

  test("random branches: the forecast p matches the realised acceptance over a seed sweep", () => {
    interface Case {
      name: string;
      H: (T: number) => number;
      setup?: (w: World & { others: Player[] }) => void;
      others?: number;
      startAt?: number;
      p: number;
      branch: string;
    }
    const cases: Case[] = [
      // Troop draw nextInt(80, 90): 84.5% passes k = 80..84.
      { name: "similar, half", H: (T) => 0.845 * T, p: 0.5, branch: "similar" },
      {
        name: "friendly",
        H: (T) => 0.75 * T,
        setup: (w) => setRelation(w, 60),
        p: 0.67,
        branch: "friendly",
      },
      {
        name: "early game",
        startAt: 300,
        H: (T) => 0.75 * T,
        p: 0.3,
        branch: "early",
      },
      {
        name: "two alliances: nextInt(2, 4) refuses half",
        others: 2,
        H: (T) => 0.95 * T,
        setup: (w) => {
          for (const o of w.others) allyPair(w, w.nation, o);
        },
        p: 0.5,
        branch: "enough",
      },
      {
        name: "traitor",
        others: 1,
        H: (T) => 0.95 * T,
        setup: (w) => {
          allyPair(w, w.us, w.others[0]);
          send(w, { type: "breakAlliance", recipient: w.others[0].id() });
          tick(w, 2);
          expect(w.us.isTraitor()).toBe(true);
          // The break's -40 from its neighbours, the nation included: undo
          // it so the relation gate stays open.
          setRelation(w, 40);
        },
        p: 0.1,
        branch: "traitor",
      },
    ];
    const SEEDS = 60;
    const rows: string[] = [];
    for (const c of cases) {
      let accepted = 0;
      let pSum = 0;
      for (let i = 0; i < SEEDS; i++) {
        const w = allianceWorld(`sweep-${i}`, {
          others: c.others,
          startAt: c.startAt,
        });
        c.setup?.(w);
        const a = ask(w, { H: c.H });
        expect(a.answeredAt).toBe(a.predictedAt);
        expect({ name: c.name, branch: a.f.branch }).toEqual({
          name: c.name,
          branch: c.branch,
        });
        expect(a.f.deterministic).toBe(false);
        pSum += a.f.p;
        if (a.accepted) accepted++;
      }
      const p = pSum / SEEDS;
      const rate = accepted / SEEDS;
      rows.push(`${c.name}: p ${p.toFixed(3)}, realised ${rate.toFixed(3)}`);
      expect(p).toBeCloseTo(c.p, 6);
      // 60 draws: sigma <= 0.065; allow about 2.5 sigma.
      expect(Math.abs(rate - p)).toBeLessThan(0.17);
    }
    if (process.env.NM_DEBUG) process.stderr.write(rows.join("\n") + "\n");
    // Generous: 300 worlds, 9 s at load 17 on 4 cores (the suite may share
    // the machine with arena runs).
  }, 120_000);
});

// ── Forked accuracy (spec §4 step 3, reduced) ───────────────────────────

const MAPS_DIR = path.join(__dirname, "../../../resources/maps");
const ME = seatClientID(0);

interface Arena {
  gameStart: GameStartInfo;
  runner: GameRunner;
  game: Game;
  terrain: TerrainSource;
  host: AgentHost;
  queue: Map<number, StampedIntent[]>;
  executed: () => number;
  /** Plays `ticks` turns, the agent acting after each; `after` runs after
   *  each tick too. */
  play(ticks: number, after?: () => void): void;
}

/** One arena seat played by the baseline agent (the ForkFidelity loop). */
async function newArena(map: GameMapType, gameID: string): Promise<Arena> {
  const spec: Pick<
    ArenaGameSpec,
    | "gameID"
    | "map"
    | "mapSize"
    | "gameType"
    | "difficulty"
    | "nations"
    | "bots"
    | "seats"
  > = {
    gameID,
    map,
    mapSize: GameMapSize.Normal,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Impossible,
    nations: "default",
    bots: 400,
    seats: [{ agent: "baseline" }],
  };
  const gameStart = arenaGameStart(spec as ArenaGameSpec);
  const loader = new NodeMapLoader(MAPS_DIR);
  let fatal: string | null = null;
  const runner = await createGameRunner(gameStart, undefined, loader, (gu) => {
    if ("errMsg" in gu) fatal ??= gu.errMsg;
  });
  const terrain = await TerrainSource.load(loader, map, GameMapSize.Normal);
  const game = runner.game;
  const queue = new Map<number, StampedIntent[]>();
  let executed = 0;
  const host = new AgentHost({
    agent: createAgent("baseline"),
    clientID: ME,
    gameStart,
    runner,
    terrain,
    deliver: (intent) => {
      const turn = executed;
      const list = queue.get(turn) ?? [];
      list.push({ ...intent, clientID: ME });
      queue.set(turn, list);
    },
    nowMs: () => game.ticks() * 100,
    strict: true,
  });
  return {
    gameStart,
    runner,
    game,
    terrain,
    host,
    queue,
    executed: () => executed,
    play(ticks, after) {
      for (let i = 0; i < ticks; i++) {
        const intents = queue.get(executed) ?? [];
        queue.delete(executed);
        runner.addTurn({ turnNumber: executed, intents });
        if (!runner.executeNextTick() || fatal !== null) {
          throw new Error(fatal ?? `tick ${game.ticks()} did not execute`);
        }
        executed++;
        host.tick();
        after?.();
      }
    },
  };
}

interface Sample {
  map: string;
  tick: number;
  nation: PlayerID;
  decision: number;
  /** Its gate at the decision, predicted at the moment. */
  gate: string;
  /** Predicted at the moment, with our home at the moment (the horizon
   *  forecast: our home only grows until then in the fork, by regrowth and
   *  refunds, so this errs on the safe side). */
  can: boolean;
  would: string | null;
  /** Predicted at the moment, with the home we hold at its decision (what
   *  a caller planning its home passes). */
  canPlanned: boolean;
  wouldPlanned: string | null;
  /** Nowcast on the eve of the decision. */
  canAtD: boolean;
  wouldAtD: string | null;
  attacked: boolean;
}

/**
 * One moment: a fork of the live game stepped to each bordering nation's
 * next decision with no intents of ours but those in flight, recording our
 * home on each eve, a nowcast there, and whether it created a land attack
 * on us in its decision turn. The moment's predictions are made on the
 * live game itself, read-only, before it moves on.
 */
function sampleMoment(a: Arena, mapName: string): Sample[] {
  const live = a.game;
  const liveMe = live.playerByClientID(ME);
  if (liveMe === null || !liveMe.isAlive()) return [];
  const t0 = live.ticks();
  const bordering = liveMe
    .nearby()
    .filter(
      (p): p is Player =>
        p.isPlayer() &&
        p.type() === PlayerType.Nation &&
        liveMe.sharesBorderWith(p),
    )
    .map((p) => p.id());
  if (bordering.length === 0) return [];
  const gameID = a.gameStart.gameID;

  // The fork: to each decision.
  const snapshot = a.runner.snapshot();
  const fork = new GameFork(live, snapshot, a.terrain, a.gameStart, ME);
  const g = fork.game;
  const me = g.playerByClientID(ME)!;
  const nmF = new NationModel(g, me, gameID, createModels(g));
  nmF.observe(g.ticks());
  const decisions = new Map<PlayerID, number>();
  for (const id of bordering) {
    decisions.set(id, nmF.nextDecision(id, t0));
  }
  const last = Math.max(...decisions.values());
  const outcome = new Map<
    PlayerID,
    { H: number; canAtD: boolean; wouldAtD: string | null; attacked: boolean }
  >();
  const inFlight = a.queue.get(a.executed()) ?? [];
  let first = true;
  while (g.ticks() <= last) {
    const t = g.ticks();
    const deciding = bordering.filter((id) => decisions.get(id) === t);
    const before = new Map<PlayerID, Set<string>>();
    for (const id of deciding) {
      nmF.refresh(id, "full");
      const H = me.troops();
      outcome.set(id, {
        H,
        canAtD: nmF.canLandAttackUs(id, H, t),
        wouldAtD: nmF.wouldTargetUs(id, H),
        attacked: false,
      });
      before.set(
        id,
        new Set(
          g
            .player(id)
            .outgoingAttacks()
            .map((x) => x.id()),
        ),
      );
    }
    fork.step([], first ? inFlight : []);
    first = false;
    nmF.observe(g.ticks());
    for (const id of deciding) {
      const old = before.get(id)!;
      outcome.get(id)!.attacked = g
        .player(id)
        .outgoingAttacks()
        .some(
          (x) =>
            !old.has(x.id()) && x.target() === me && x.sourceTile() === null,
        );
    }
  }

  // The moment's predictions, on the live game (read-only: its snapshot,
  // which holds relations, attacks, executions and PRNG states, is the
  // same bytes afterwards).
  const nm = new NationModel(live, liveMe, gameID, createModels(live));
  nm.observe(t0);
  const H0 = liveMe.troops();
  const out = bordering.map((id) => {
    nm.refresh(id, "full");
    const d = decisions.get(id)!;
    const o = outcome.get(id)!;
    return {
      map: mapName,
      tick: t0,
      nation: id,
      decision: d,
      gate: nm.gates(id, d),
      can: nm.canLandAttackUs(id, H0, d),
      would: nm.wouldTargetUs(id, H0),
      canPlanned: nm.canLandAttackUs(id, o.H, d),
      wouldPlanned: nm.wouldTargetUs(id, o.H),
      canAtD: o.canAtD,
      wouldAtD: o.wouldAtD,
      attacked: o.attacked,
    };
  });
  for (const id of bordering) {
    nm.acceptsAlliance(id, {
      kind: "request",
      createdAt: t0,
      atTick: nm.nextDecision(id, t0 + 1),
      embargoStoppedBy: t0,
    });
  }
  expect(Buffer.from(a.runner.snapshot()).equals(Buffer.from(snapshot))).toBe(
    true,
  );
  return out;
}

interface Rates {
  accuracy: number;
  safe: number;
  negatives: number;
  predicted: number;
}

function rates(
  samples: Sample[],
  can: (s: Sample) => boolean,
  would: (s: Sample) => string | null,
): Rates {
  // An attack is predicted when it can, its list runs for sure (open; below
  // its trigger it runs 1 decision in 10) and a strategy names us.
  const predicted = (s: Sample) =>
    can(s) && s.gate === "open" && would(s) !== null;
  const right = samples.filter((s) => predicted(s) === s.attacked).length;
  const neg = samples.filter((s) => !can(s));
  return {
    accuracy: right / samples.length,
    safe: neg.filter((s) => !s.attacked).length / Math.max(1, neg.length),
    negatives: neg.length,
    predicted: samples.filter(predicted).length,
  };
}

describe("NationModel: forked accuracy of canLandAttackUs", () => {
  test("mid-game moments on 2 maps: predictions against a fork stepped to each decision", async () => {
    const start = performance.now();
    const samples: Sample[] = [];
    const runs: [GameMapType, string, string][] = [
      [GameMapType.Pangaea, "Pangaea", "NMACC001"],
      [GameMapType.BosphorusStraits, "BosphorusStraits", "NMACC002"],
    ];
    const inferred: string[] = [];
    for (const [map, name, gameID] of runs) {
      const a = await newArena(map, gameID);
      // The fallback without a gameID (§2.4.1), observing from the start
      // of play: its rates and phases against the exact ones.
      const me = a.game.playerByClientID(ME)!;
      const blind = new NationModel(a.game, me, null, createModels(a.game));
      const watch = () => {
        if (!a.game.inSpawnPhase()) blind.observe(a.game.ticks());
      };
      a.play(600, watch);
      for (let k = 0; k < 12; k++) {
        samples.push(...sampleMoment(a, name));
        a.play(100, watch);
      }
      let right = 0;
      let fixed = 0;
      let expandExact = 0;
      const nations = a.game
        .players()
        .filter((p) => p.type() === PlayerType.Nation);
      for (const N of nations) {
        const p = blind.params(N.id());
        if (p.source !== "inferred") continue;
        fixed++;
        const exact = nationParams(gameID, N.id(), Difficulty.Impossible);
        if (p.rate === exact.rate && p.phase === exact.phase) right++;
        // Ratios on the safe side: reserve and trigger never above the
        // truth, expand never below it.
        expect(p.reserve).toBeLessThanOrEqual(exact.reserve + 1e-9);
        expect(p.trigger).toBeLessThanOrEqual(exact.trigger + 1e-9);
        expect(p.expand).toBeGreaterThanOrEqual(exact.expand - 1e-9);
        if (p.expand === exact.expand) expandExact++;
      }
      inferred.push(
        `${name}: ${fixed} of ${nations.length} nations inferred by tick ${a.game.ticks()}, ${right} with the exact rate and phase, ${expandExact} with the exact expand`,
      );
      expect(right).toBe(fixed);
      expect(fixed).toBeGreaterThan(nations.length / 2);
    }
    const n = samples.length;
    const attacks = samples.filter((s) => s.attacked).length;
    const horizon = rates(
      samples,
      (s) => s.can,
      (s) => s.would,
    );
    const planned = rates(
      samples,
      (s) => s.canPlanned,
      (s) => s.wouldPlanned,
    );
    const nowcast = rates(
      samples,
      (s) => s.canAtD,
      (s) => s.wouldAtD,
    );
    const fmt = (name: string, r: Rates) =>
      `${name}: accuracy ${r.accuracy.toFixed(3)} (${r.predicted} predicted), safe side ${r.safe.toFixed(3)} of ${r.negatives}`;
    const report = [
      `samples ${n} on ${runs.length} maps, attacks ${attacks}, wall ${((performance.now() - start) / 1000).toFixed(1)} s`,
      fmt("our home now", horizon),
      fmt("our home at the decision", planned),
      fmt("nowcast on the eve", nowcast),
      ...inferred,
      ...samples
        .filter((s) => s.attacked || s.can || s.canPlanned)
        .map(
          (s) =>
            `  ${s.map} t${s.tick} ${s.nation} d${s.decision} gate=${s.gate} can=${s.can}/${s.canPlanned}/${s.canAtD} would=${s.would}/${s.wouldPlanned}/${s.wouldAtD} attacked=${s.attacked}`,
        ),
    ];
    if (process.env.NM_DEBUG) process.stderr.write(report.join("\n") + "\n");
    expect(n).toBeGreaterThan(40);
    expect(attacks).toBeGreaterThan(0);
    // Spec §4 step 3: >= 90% accuracy, >= 98% on the safe side
    // (predicted false => no attack).
    expect(planned.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(planned.safe).toBeGreaterThanOrEqual(0.98);
    expect(horizon.safe).toBeGreaterThanOrEqual(0.98);
    expect(nowcast.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(nowcast.safe).toBeGreaterThanOrEqual(0.98);
    // Generous: two real games played 1,800 turns, each forked at 12
    // moments, took over 120 s at load 17 on 4 cores (the suite may share
    // the machine with arena runs); the wall time is in the NM_DEBUG report.
  }, 600_000);
});
