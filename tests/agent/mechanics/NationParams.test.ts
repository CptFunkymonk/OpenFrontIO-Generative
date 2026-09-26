/**
 * Pins apex spec N1 (§6.1 "NationParams", §2.4.1): a nation's and a tribe's
 * attack parameters and decision ticks can be computed by any client from
 * public data, and every nation attack is created on a decision tick.
 *
 * The claim under test: nationParams(gameID, id, difficulty) and
 * tribeParams(id) (src/agent/lib/NationModel.ts) reproduce every
 * NationExecution's and TribeExecution's trigger, reserve, expand, rate and
 * phase; and every attack of theirs is created in a turn d with
 * d % rate == phase.
 *
 * The rules (the code is the spec):
 * - NationExecution (src/core/execution/NationExecution.ts):
 *     :72-78  constructor: random = PseudoRandom(simpleHash(nation id) +
 *             simpleHash(gameID)); triggerRatio = nextInt(50, 60)/100,
 *             reserveRatio = nextInt(30, 40)/100, expandRatio =
 *             nextInt(10, 20)/100.
 *     :81-84  init (end of tick 0, activeDuringSpawnPhase): attackRate =
 *             getAttackRate(), attackTick = nextInt(0, attackRate). Nothing
 *             draws from this generator in between.
 *     :92-107 getAttackRate: nextInt(65, 100) Easy, (55, 70) Medium,
 *             (45, 60) Hard, (30, 50) Impossible.
 *     :126-131 spawn phase: a spawned nation re-spawns ("hops") only when
 *             ticks % attackRate == attackTick; the hop's SpawnExecution is
 *             queued in that tick.
 *     :193-198 the first tick after the spawn phase initialises the
 *             behaviours and force-sends troops/2 at free land
 *             (AiAttackBehavior.forceSendAttack, :812-820): the ONE nation
 *             attack not made on a decision tick.
 *     :200-227 every other tick with ticks % attackRate != attackTick
 *             returns before maybeAttack (only structures at 1/3 and 2/3 of
 *             the interval); maybeAttack (the only caller of sendAttack,
 *             sendBoatAttack and the random boat) runs on decision ticks.
 *   The gameID is the ExecutionManager's (ExecutionManager.ts:165), which
 *   GameRunner builds from gameStart.gameID (GameRunner.ts:86-94): the value
 *   the agent reads as ctx.gameID (AgentHost.context()).
 * - TribeExecution (src/core/execution/TribeExecution.ts):
 *     :35-40  random = PseudoRandom(simpleHash(tribe id)); attackRate =
 *             nextInt(40, 80), attackTick = nextInt(0, attackRate), then
 *             trigger, reserve, expand as a nation's. No game ID.
 *     :52     tick() returns unless ticks % attackRate == attackTick, so
 *             every tribe action, the first free-land send included, is on
 *             a decision tick.
 * - Timing (GameImpl.executeNextTick, GameImpl.ts:526-551): executions tick
 *   with the game's tick count t, and the executions they add are init()ed
 *   at the end of the same call, outside the spawn phase. AttackExecution.init
 *   creates the Attack (AttackExecution.ts:141-146), so an attack made at a
 *   decision tick d appears after the call that ran tick d, when
 *   game.ticks() == d + 1. A boat's TransportShip unit is built in its
 *   execution's init the same way. A boat LANDING creates a new attack with
 *   a source tile on whatever tick the boat arrives
 *   (TransportShipExecution.ts:271-283); it is excluded.
 *
 * VERDICT TRUE. Every NationExecution's and TribeExecution's five fields
 * equal the functions' on 3 maps x 2 game IDs (and every difficulty), every
 * nation land attack after the forced first send and every nation or tribe
 * boat launch is on d % rate == phase, and every spawn-phase hop is queued
 * on a decision tick.
 *
 * Setting: the arena's (arenaGameStart -> createGameRunner, as
 * SpawnPhaseSingleplayer builds it): FFA, Singleplayer, Impossible, the
 * maps' default nations, 400 tribes, Normal size, one Human seat that
 * spawns at SPAWN_TURN and then sends nothing. Private fields of the
 * executions are read through a cast, test only.
 */
import path from "path";
import {
  arenaGameStart,
  seatClientID,
  type ArenaGameSpec,
} from "../../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../../src/agent/arena/NodeMapLoader";
import {
  AiParams,
  nationParams,
  tribeParams,
} from "../../../src/agent/lib/NationModel";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { SpawnExecution } from "../../../src/core/execution/SpawnExecution";
import { TribeExecution } from "../../../src/core/execution/TribeExecution";
import {
  Attack,
  Difficulty,
  Execution,
  Game,
  GameMapSize,
  GameMapType,
  GameType,
  Nation,
  Player,
  PlayerID,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../../../src/core/game/Game";
import { GameImpl } from "../../../src/core/game/GameImpl";
import { TileRef } from "../../../src/core/game/GameMap";
import { createGameRunner, GameRunner } from "../../../src/core/GameRunner";
import { Intent } from "../../../src/core/Schemas";

const MAPS_DIR = path.join(__dirname, "../../../resources/maps");
const MAPS = [
  GameMapType.Onion,
  GameMapType.BosphorusStraits,
  GameMapType.Pangaea,
];
const GAME_IDS = ["NPARAMS1", "Zq7xK2pA"];
const ME = seatClientID(0);
/** Our spawn intent's turn: the phase stays open until then, so hops show. */
const SPAWN_TURN = 120;
/** Last tick run: about 70 s of play after the spawn. */
const END_TICK = 820;
const TIMEOUT = 120_000;

/** The fields read from a live NationExecution (private, test only). */
interface NationFields {
  gameID: string;
  nation: Nation;
  attackRate: number;
  attackTick: number;
  triggerRatio: number;
  reserveRatio: number;
  expandRatio: number;
}
/** The same from a TribeExecution. */
interface TribeFields {
  tribe: Player;
  attackRate: number;
  attackTick: number;
  triggerRatio: number;
  reserveRatio: number;
  expandRatio: number;
}

const params = (f: NationFields | TribeFields): AiParams => ({
  trigger: f.triggerRatio,
  reserve: f.reserveRatio,
  expand: f.expandRatio,
  rate: f.attackRate,
  phase: f.attackTick,
  source: "gameID",
});

const executions = (game: Game): Execution[] => (game as GameImpl).executions();

interface Sim {
  runner: GameRunner;
  game: Game;
  step(intents?: Intent[]): void;
}

async function newSim(
  map: GameMapType,
  gameID: string,
  difficulty = Difficulty.Impossible,
): Promise<Sim> {
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
    difficulty,
    nations: "default",
    bots: 400,
    seats: [{ agent: "apex" }],
  };
  const runner = await createGameRunner(
    arenaGameStart(spec as ArenaGameSpec),
    undefined,
    new NodeMapLoader(MAPS_DIR),
    (gu) => {
      if ("errMsg" in gu) throw new Error(gu.errMsg);
    },
  );
  const game = runner.game;
  return {
    runner,
    game,
    step(intents: Intent[] = []) {
      runner.addTurn({
        turnNumber: game.ticks(),
        intents: intents.map((i) => ({ ...i, clientID: ME })),
      });
      expect(runner.executeNextTick()).toBe(true);
    },
  };
}

/** First tile, in a coarse raster scan, whose 9x9 box is free land. */
function freeSite(game: Game): TileRef {
  const free = (x: number, y: number) => {
    if (!game.isValidCoord(x, y)) return false;
    const t = game.ref(x, y);
    return game.isLand(t) && !game.hasOwner(t) && !game.isImpassable(t);
  };
  for (let y = 5; y < game.height() - 5; y += 3) {
    for (let x = 5; x < game.width() - 5; x += 3) {
      let ok = true;
      for (let dy = -4; dy <= 4 && ok; dy++) {
        for (let dx = -4; dx <= 4 && ok; dx++) ok = free(x + dx, y + dy);
      }
      if (ok) return game.ref(x, y);
    }
  }
  throw new Error("no free site");
}

interface Observed {
  /** Nation land attacks, by nation: the ticks they were created in. */
  nationAttacks: Map<PlayerID, number[]>;
  /** Tribe land attacks created, by tribe. */
  tribeAttacks: Map<PlayerID, number[]>;
  /** Boat launches (TransportShip units built), by owner. */
  boats: Map<PlayerID, number[]>;
  /** Spawn-phase hops queued (after the first spawn), by nation. */
  hops: Map<PlayerID, number[]>;
  /** Boat landings seen (excluded from the claim). */
  landings: number;
  /** The tick in which the spawn phase ended. */
  phaseEnd: number;
}

const push = (m: Map<PlayerID, number[]>, id: PlayerID, t: number) => {
  const a = m.get(id);
  if (a === undefined) m.set(id, [t]);
  else a.push(t);
};

/** Runs the game to END_TICK, recording when every attack, boat and hop
 *  was created. `after(d)` runs after each tick d. */
function observe(sim: Sim, after: (d: number) => void): Observed {
  const { game } = sim;
  const o: Observed = {
    nationAttacks: new Map(),
    tribeAttacks: new Map(),
    boats: new Map(),
    hops: new Map(),
    landings: 0,
    phaseEnd: -1,
  };
  const seenAttacks = new WeakSet<Attack>();
  const seenUnits = new WeakSet<Unit>();
  const seenSpawns = new WeakSet<Execution>();
  const spawnedOnce = new Set<PlayerID>();

  while (game.ticks() < END_TICK) {
    const intents: Intent[] =
      game.ticks() === SPAWN_TURN
        ? [{ type: "spawn", tile: freeSite(game) }]
        : [];
    const wasSpawnPhase = game.inSpawnPhase();
    sim.step(intents);
    const d = game.ticks() - 1; // the tick just run
    if (wasSpawnPhase && !game.inSpawnPhase()) o.phaseEnd = d;
    after(d);

    if (game.inSpawnPhase() || o.phaseEnd === d) {
      // Hops: SpawnExecutions queued in this tick for nations.
      for (const e of executions(game)) {
        if (!(e instanceof SpawnExecution) || seenSpawns.has(e)) continue;
        seenSpawns.add(e);
        const info = (e as unknown as { playerInfo: PlayerInfo }).playerInfo;
        if (info.playerType !== PlayerType.Nation) continue;
        if (spawnedOnce.has(info.id)) push(o.hops, info.id, d);
        spawnedOnce.add(info.id);
      }
    }

    for (const p of game.allPlayers()) {
      const type = p.type();
      if (type === PlayerType.Human) continue;
      for (const a of p.outgoingAttacks()) {
        if (seenAttacks.has(a)) continue;
        seenAttacks.add(a);
        if (a.sourceTile() !== null) {
          o.landings++;
          continue;
        }
        push(
          type === PlayerType.Nation ? o.nationAttacks : o.tribeAttacks,
          p.id(),
          d,
        );
      }
      for (const u of p.units(UnitType.TransportShip)) {
        if (seenUnits.has(u)) continue;
        seenUnits.add(u);
        push(o.boats, p.id(), d);
      }
    }
  }
  return o;
}

const onDecision = (p: AiParams, ticks: number[]) =>
  ticks.filter((t) => t % p.rate !== p.phase);

describe("N1: nation and tribe parameters from public data", () => {
  beforeAll(() => {
    console.debug = () => {};
    console.warn = () => {};
  });

  for (const map of MAPS) {
    for (const gameID of GAME_IDS) {
      test(
        `${map}, ${gameID}: params equal every execution's; attacks, boats and hops fall on decision ticks`,
        async () => {
          const sim = await newSim(map, gameID);
          const { game } = sim;
          const difficulty = game.config().gameConfig().difficulty;

          // Nation executions init() at the end of tick 0; tribe executions
          // are queued when the tribes land in tick 1. Read both after tick
          // 1, before any tribe can die and drop its execution.
          let nations: NationFields[] = [];
          let tribes: TribeFields[] = [];
          const o = observe(sim, (d) => {
            if (d !== 1) return;
            nations = executions(game)
              .filter((e) => e instanceof NationExecution)
              .map((e) => e as unknown as NationFields);
            tribes = executions(game)
              .filter((e) => e instanceof TribeExecution)
              .map((e) => e as unknown as TribeFields);
          });
          expect(o.phaseEnd).toBe(SPAWN_TURN + 1);

          expect(nations.length).toBe(game.nations().length);
          expect(nations.length).toBeGreaterThan(0);
          const nationP = new Map<PlayerID, AiParams>();
          for (const n of nations) {
            expect(n.gameID).toBe(gameID);
            const id = n.nation.playerInfo.id;
            const want = params(n);
            expect(nationParams(gameID, id, difficulty)).toEqual(want);
            nationP.set(id, want);
          }

          const bots = game
            .allPlayers()
            .filter((p) => p.type() === PlayerType.Bot);
          expect(tribes.length).toBe(bots.length);
          expect(tribes.length).toBeGreaterThan(0);
          const tribeP = new Map<PlayerID, AiParams>();
          for (const t of tribes) {
            const want = params(t);
            expect(tribeParams(t.tribe.id())).toEqual(want);
            tribeP.set(t.tribe.id(), want);
          }
          const paramsOf = (id: PlayerID): AiParams => {
            const p = nationP.get(id) ?? tribeP.get(id);
            if (p === undefined) throw new Error(`no execution for ${id}`);
            return p;
          };

          // Nations: the first land attack is the forced send, in the tick
          // after the phase ended; every later one is on a decision tick.
          let nationAttacks = 0;
          for (const [id, ticks] of o.nationAttacks) {
            const p = paramsOf(id);
            expect(ticks[0]).toBe(o.phaseEnd + 1);
            expect(onDecision(p, ticks.slice(1))).toEqual([]);
            nationAttacks += ticks.length - 1;
          }
          expect(o.nationAttacks.size).toBe(nations.length);
          expect(nationAttacks).toBeGreaterThan(nations.length);

          let tribeAttacks = 0;
          for (const [id, ticks] of o.tribeAttacks) {
            expect(onDecision(paramsOf(id), ticks)).toEqual([]);
            tribeAttacks += ticks.length;
          }
          expect(tribeAttacks).toBeGreaterThan(0);

          for (const [id, ticks] of o.boats) {
            expect(onDecision(paramsOf(id), ticks)).toEqual([]);
          }

          let hops = 0;
          for (const [id, ticks] of o.hops) {
            expect(onDecision(paramsOf(id), ticks)).toEqual([]);
            hops += ticks.length;
          }
          // About SPAWN_TURN / 40 hops per nation.
          expect(hops).toBeGreaterThanOrEqual(nations.length);
        },
        TIMEOUT,
      );
    }
  }

  test(
    "every difficulty's rate range (NationExecution.getAttackRate)",
    async () => {
      for (const d of [
        Difficulty.Easy,
        Difficulty.Medium,
        Difficulty.Hard,
        Difficulty.Impossible,
      ]) {
        for (const gameID of GAME_IDS) {
          const sim = await newSim(GameMapType.Onion, gameID, d);
          sim.step();
          const nations = executions(sim.game)
            .filter((e) => e instanceof NationExecution)
            .map((e) => e as unknown as NationFields);
          expect(nations.length).toBeGreaterThan(0);
          for (const n of nations) {
            expect(nationParams(gameID, n.nation.playerInfo.id, d)).toEqual(
              params(n),
            );
          }
        }
      }
    },
    TIMEOUT,
  );
});
