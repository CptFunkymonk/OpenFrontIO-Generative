/**
 * Pins roadmap H3's tribe mechanics (docs/11-roadmap.md §11.3; the risk table
 * asks for every mechanic an agent relies on to be pinned here).
 *
 * The claim under test ("TribeStats"): there are 400 tribes (PlayerType.Bot)
 * in the default solo game; tribes have a third of a player's troop cap and
 * half its regrowth; attacking them costs the attacker x0.7 losses; once free
 * land runs out, Impossible nations attack up to 100 tribes at once
 * (getBotAttackMaxParallelism). Also: what tribes do (attack us or expand?),
 * how their troops grow, and how fast nations eat them in a real game.
 *
 * VERDICT PARTIAL. The rules (the code is the spec):
 *
 * - 400 tribes: TRUE. The arena and the solo modal default to 400, the schema
 *   maximum (Arena.ts:289, SinglePlayerModal.ts:99, Schemas.ts:534).
 *   GameRunner.init adds TribeSpawner.spawnTribes(config.bots())
 *   (GameRunner.ts:180-184, TribeSpawner.ts:32-87). Each tribe lands in tick
 *   1 on a full 52-tile disc (clipped at the map edge) at a random free tile
 *   (SpawnExecution.getSpawn, SpawnExecution.ts:150-197, requireAllValid) and
 *   gets a PlayerExecution and a TribeExecution (SpawnExecution.ts:112-117).
 *   A tribe that finds no site in 1,000 tries gets neither (:102-106); not
 *   seen on World or Pangaea. Start: 10,000 troops, 0 gold
 *   (Config.startManpower :1003-1006, startingGold :439-444).
 * - A third of the cap: TRUE. maxTroops divides the shared base
 *   2 * (tiles^0.6 * 1000 + 50,000) + cities by 3 for a Bot
 *   (Config.ts:1024-1038), so a tribe has 1/3 of our cap and 1/3.75 of an
 *   Impossible nation's at equal tiles (40,470 at 52 tiles).
 * - Half the regrowth: PARTIAL. troopIncreaseRate multiplies
 *   (10 + T^0.73/4) * (1 - T/max) by 0.5 (Config.ts:1058-1068), but max is
 *   the tribe's own, a third of ours. In effect a tribe regrows 0.41x our rate
 *   at equal troops and tiles, and its peak (at ~41% of its cap) is
 *   0.226-0.228x ours and 0.183-0.185x an Impossible nation's. It is applied
 *   every tick, floored (PlayerExecution.ts:97-98, PlayerImpl.ts:1369-1375),
 *   with 50 gold a tick against our 100 (Config.ts:1092-1101).
 * - x0.7 losses: TRUE, narrowly. attackLogic scales mag by
 *   BOT_DEFENDER_LOSS_MULT = 0.7 only when the attacker is Human or Nation and
 *   the defender a Bot (Config.ts:135, 914-921). It cuts the attacker's loss
 *   only: speed (tickFraction) and the tribe's own loss are unchanged, and a
 *   tribe attacking anyone (a tribe included) gets nothing.
 * - Up to 100 tribes once free land runs out: PARTIAL. The cap is 100 at
 *   Impossible, 3 at Hard (getBotAttackMaxParallelism,
 *   AiAttackBehavior.ts:522-538), taken from the bordering tribes sorted by
 *   density (attackBots, :484-520). But:
 *   (a) "free land runs out" is per nation, not global: maybeAttack sends the
 *       free-land attack and returns while the nation's own border (or a
 *       <= 4-tile river, PlayerImpl.ts:626-690) touches free land
 *       (AiAttackBehavior.ts:135-141). In the Pangaea game below the first
 *       nation->tribe land attack came at tick 217 with 1.5% of the map
 *       still free (16% on World when this harness was run there), and none
 *       of 630 came from a nation that saw free land.
 *   (b) The troop budget binds, not the 100: each tribe gets 4x its troops,
 *       or all that is left if that is >= 2x, else it is skipped, out of
 *       troops - reserveRatio (30-39%) x cap (calculateAttackTroops :1041-1096,
 *       calculateBotAttackTroops :1149-1166). A nation at its trigger has
 *       (trigger - reserve) x cap, ~20% of its cap: two attacks on fresh
 *       10,000-troop tribes (pinned below), none on a 35,000-troop tribe
 *       until its cap passes 350k. The most tribes one nation attacked at
 *       once in the real game was 11 (9 on World).
 *   (c) It runs only past the reserve and trigger gates (the trigger is
 *       skipped 10% of the time) and after `retaliate`, which answers
 *       non-tribe attackers first (attackBestTarget :278-304, order :428);
 *       a bordering tribe that owns structures jumps the gates (:285-287).
 *       Tribes across water get boat attacks (sendAttack :822-840).
 *
 * What tribes do (TribeExecution.ts:51-137, AiAttackBehavior):
 * - They decide every attackRate = 40-79 ticks (TribeExecution.ts:36-37, 52),
 *   at ticks and with ratios drawn from PseudoRandom(simpleHash(id)) alone
 *   (:35-40), so an agent can replay them from the tribe's id.
 *   The first decision always tries a free-land attack (:60-73). Then, while
 *   any free land is nearby, every decision is a free-land attack
 *   (:128-134; once a decision finds none the tribe never looks again),
 *   sized troops - expandRatio (10-19%) x cap (AiAttackBehavior.ts:
 *   1052-1053). docs/06 §6.6's "attackAmount = troops/20" only fills in a
 *   null troop count (AttackExecution.ts:130-132); tribes always pass their
 *   own. So tribes expand first and do not attack us while they border free
 *   land (a traitor neighbour aside, 1/3 chance, :113-126).
 * - With no free land nearby they attack, but only at >= triggerRatio
 *   (50-59%) x cap (attackRandomTarget, AiAttackBehavior.ts:765-798): first
 *   they answer the largest incoming attack, ours included (a tribe does not
 *   skip humans, :463-467), then a traitor (1/3), then a shuffled neighbour,
 *   skipping each Human or Nation with chance 1/2 but never a tribe
 *   (:784-797). They send troops - reserveRatio (30-39%) x cap; there is no
 *   send cap and no "too weak" check for tribes (:962, 987). Their answer to
 *   our attack cancels it 1:1 at init (AttackExecution.ts:157-170). Tribes
 *   ignore our spawn immunity; we can attack them from the first tick, they
 *   are never immune (PlayerImpl.ts:1907-1926).
 * - Not in the claim, and the biggest lever found: a player with fewer than
 *   100 tiles after losing a tile is conquered whole (handleDeadDefender,
 *   AttackExecution.ts:448-482): every tile touching the attacker chains
 *   over (the rest goes to its other neighbours), the attack stops paying
 *   and refunds its stack, and the attacker takes all of a tribe's gold
 *   (GameImpl.conquerPlayer, Config.conquerGoldAmount :735-744). A fresh
 *   52-tile tribe falls to one tile's losses (~136 troops with a 5,000
 *   stack, ~41 once the stack is >= 1/0.6 of its troops). On Pangaea a spawn
 *   touching a fresh tribe plus an attack on the first tick doubles our land
 *   to 104 tiles two ticks after the spawn phase ends. The rule cuts both
 *   ways: the idle 52-tile human in the real game died the tick after the
 *   first attack reached it.
 * - How fast nations eat them (Pangaea, 29 nations, fixed seed): 298 of 400
 *   tribes alive at minute 1 holding 64% of the land (nations 35%, free
 *   0.6%); 26 alive (4.6%) at minute 2; 6 (1.1%) at minute 3 (nations 99%).
 *   On World (72 nations) this harness measured 230 / 44 / 0. Tribes attack
 *   free land most, then each other, then nations.
 *
 * Setting: the real Config everywhere (not TestConfig). The pure tests call
 * Config as createGameRunner builds it (GameRunner.ts:46). The synthetic
 * scenarios build an all-plains field the way setup() builds a game
 * (createGame, endSpawnPhase) and run the real AiAttackBehavior and
 * TribeExecution; they set troops and tiles, which only tests may do. The
 * real game is built exactly as the arena builds it (arenaGameStart into
 * createGameRunner, NodeMapLoader on resources/maps), FFA singleplayer,
 * Impossible, default nations, 400 tribes, Normal size, with one idle human
 * that spawns on a fixed free site and then sends nothing.
 */
import path from "path";
import {
  arenaGameStart,
  seatClientID,
  type ArenaGameSpec,
} from "../../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../../src/agent/arena/NodeMapLoader";
import {
  AttackLogicInput,
  Config,
} from "../../../src/core/configuration/Config";
import { pow } from "../../../src/core/DetMath";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { NationAllianceBehavior } from "../../../src/core/execution/nation/NationAllianceBehavior";
import { NationEmojiBehavior } from "../../../src/core/execution/nation/NationEmojiBehavior";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { TribeExecution } from "../../../src/core/execution/TribeExecution";
import { AiAttackBehavior } from "../../../src/core/execution/utils/AiAttackBehavior";
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
import { createGame, GameImpl } from "../../../src/core/game/GameImpl";
import { TileRef } from "../../../src/core/game/GameMap";
import { genTerrainFromBin } from "../../../src/core/game/TerrainMapLoader";
import { UserSettings } from "../../../src/core/game/UserSettings";
import { createGameRunner } from "../../../src/core/GameRunner";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import { GameConfig, Intent, IntentSchema } from "../../../src/core/Schemas";
import { simpleHash } from "../../../src/core/Util";

const MAPS = path.join(__dirname, "../../../resources/maps");
const TRIBES = 400;
/** 10 ticks a second (ArenaGame.ts: nowMs = ticks * 100, gameMinutes = ticks / 600). */
const MINUTE = 600;

/** The arena's setting (Arena.ts:284-292, ArenaGame.arenaGameStart). */
const GAME_CONFIG: GameConfig = {
  gameMap: GameMapType.World,
  gameMapSize: GameMapSize.Normal,
  gameMode: GameMode.FFA,
  gameType: GameType.Singleplayer,
  difficulty: Difficulty.Impossible,
  nations: "default",
  donateGold: false,
  donateTroops: false,
  bots: TRIBES,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: false,
};

/** The config createGameRunner builds (GameRunner.ts:46). */
const CONFIG = new Config(GAME_CONFIG, null, false);

/** Just the fields maxTroops / troopIncreaseRate read (Config.ts:1024-1090). */
function stub(type: PlayerType, tiles: number, troops = 0): Player {
  return {
    type: () => type,
    numTilesOwned: () => tiles,
    troops: () => troops,
    units: () => [],
    isLobbyCreator: () => false,
  } as unknown as Player;
}

const relErr = (a: number, b: number) => Math.abs(a / b - 1);

// ---------------------------------------------------------------------------
// Synthetic fields: all plains, built as setup() builds a game but with the
// real Config (TestConfig overrides the troop and attack rules,
// tests/util/TestConfig.ts).

/** Land bit 0x80 (GameMap.ts:127) + magnitude 5 = plains (GameMap.ts:397-407). */
const PLAINS_BYTE = 0x80 | 5;

async function plainsGame(
  width: number,
  height: number,
  difficulty: Difficulty = Difficulty.Impossible,
  humans: PlayerInfo[] = [],
): Promise<Game> {
  const land = (w: number, h: number) =>
    genTerrainFromBin(
      { width: w, height: h, num_land_tiles: w * h },
      new Uint8Array(w * h).fill(PLAINS_BYTE),
    );
  const config = new Config(
    { ...GAME_CONFIG, difficulty },
    new UserSettings(),
    false,
  );
  const game = createGame(
    humans,
    [],
    await land(width, height),
    await land(Math.ceil(width / 2), Math.ceil(height / 2)),
    config,
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
) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) p.conquer(game.ref(x, y));
  }
}

const addPlayer = (game: Game, id: string, type: PlayerType) =>
  game.addPlayer(new PlayerInfo(id.toLowerCase(), type, null, id));

/** TribeExecution's private knobs, drawn in its constructor (TribeExecution.ts:34-41). */
interface TribeKnobs {
  attackRate: number;
  attackTick: number;
  triggerRatio: number;
  reserveRatio: number;
  expandRatio: number;
}

/** A tribe run by its real TribeExecution (as SpawnExecution.ts:112-117 adds it). */
function runTribe(game: Game, tribe: Player): TribeKnobs {
  const exec = new TribeExecution(tribe);
  game.addExecution(exec);
  game.executeNextTick(); // init() runs at the end of this tick
  return exec as unknown as TribeKnobs;
}

/**
 * Ticks until the tribe's decision (TribeExecution.ts:52) is `ahead` ticks
 * away: with ahead = 0 the next executeNextTick() is the decision.
 */
function toDecision(game: Game, k: TribeKnobs, ahead = 0) {
  while ((game.ticks() + ahead) % k.attackRate !== k.attackTick) {
    game.executeNextTick();
  }
}

// ---------------------------------------------------------------------------
// The real game: built exactly as the arena builds it.

interface NationKnobs {
  attackRate: number;
  attackTick: number;
  player: Player | null;
}

interface Standing {
  minute: number;
  tribesAlive: number;
  tribeShare: number;
  nationShare: number;
  freeShare: number;
  meanTribeTiles: number;
  /** Alive tribes at >= 50% of their cap (the lowest possible triggerRatio). */
  tribesAtTrigger: number;
  minTribeGold: bigint;
}

interface RealGame {
  game: Game;
  me: Player;
  meStartTiles: number;
  spawnEnd: number;
  tribes: Player[];
  start: { tiles: number; disc: number; troops: number; gold: bigint }[];
  tribeExecs: number;
  standings: Standing[];
  /** Attack launches by "ATTACKER->TARGET" type (a new attack id each). */
  launches: Map<string, number>;
  nationBotLand: {
    total: number;
    whileBorderingFreeLand: number;
    unscheduled: number;
  };
  firstNationBotTick: number;
  freeShareAtFirstNationBot: number;
  peakNationBotParallel: number;
  quiet: { samples: number; troops: number; gold: number };
  meFirstHit: { tick: number; by: PlayerType; troops: number } | null;
  meDeathTick: number | null;
}

/**
 * The spawn disc: euclDistFN(center, 4, true) (GameMap.ts:715-735) floods the
 * 8x8 box x-4..x+3, y-4..y+3 minus 3 tiles at each corner, 52 tiles, clipped
 * by the map edge (same derivation as SpawnPhaseSingleplayer.test.ts).
 */
function discSize(game: Game, center: TileRef): number {
  const cx = game.x(center);
  const cy = game.y(center);
  let n = 0;
  for (let y = cy - 4; y <= cy + 3; y++) {
    for (let x = cx - 4; x <= cx + 3; x++) {
      if (!game.isValidCoord(x, y)) continue;
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      if (dx * dx + dy * dy <= 16) n++;
    }
  }
  return n;
}

/** First tile, in a fixed raster scan, with a 20x20 box of free land around it. */
function freeInlandSite(game: Game): TileRef {
  for (let y = 40; y < game.height() - 40; y += 7) {
    for (let x = 40; x < game.width() - 40; x += 7) {
      let ok = true;
      for (let dy = -10; dy < 10 && ok; dy++) {
        for (let dx = -10; dx < 10 && ok; dx++) {
          const t = game.ref(x + dx, y + dy);
          ok = game.isLand(t) && !game.isImpassable(t) && !game.hasOwner(t);
        }
      }
      if (ok) return game.ref(x, y);
    }
  }
  throw new Error("no free inland site");
}

const kind = (t: Player | { isPlayer(): boolean }): string =>
  t.isPlayer() ? (t as Player).type() : "TERRA_NULLIUS";

interface ArenaSim {
  game: Game;
  me: Player;
  /** Runs the next turn (= the next tick) with these intents from us. */
  step(intents?: Intent[]): void;
}

/** A game built exactly as the arena builds it, one seat for us. */
async function arenaSim(map: GameMapType): Promise<ArenaSim> {
  // The fields arenaGameStart reads; the rest of ArenaGameSpec only steers
  // the arena's loop, which this test replaces with its own.
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
    gameID: "TRIBEPIN",
    map,
    mapSize: GameMapSize.Normal,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Impossible,
    nations: "default",
    bots: TRIBES,
    seats: [{ agent: "idle" }],
  };
  const runner = await createGameRunner(
    arenaGameStart(spec as ArenaGameSpec),
    undefined,
    new NodeMapLoader(MAPS),
    (gu) => {
      if ("errMsg" in gu) throw new Error(gu.errMsg);
    },
  );
  const game = runner.game;
  const ME = seatClientID(0);
  const me = game.playerByClientID(ME);
  if (me === null) throw new Error("no seat player");
  return {
    game,
    me,
    step(intents: Intent[] = []) {
      runner.addTurn({
        turnNumber: game.ticks(),
        intents: intents.map((i) => ({ ...i, clientID: ME })),
      });
      if (!runner.executeNextTick()) throw new Error("tick failed");
    },
  };
}

async function playRealGame(map: GameMapType): Promise<RealGame> {
  const { game, me, step } = await arenaSim(map);
  const config = game.config();

  // Tick 0 inits the tribes' SpawnExecutions, tick 1 lands them, tick 2 the
  // nations (SpawnPhaseSingleplayer.test.ts). Then we spawn and do nothing.
  step();
  step();
  step();
  step([{ type: "spawn", tile: freeInlandSite(game) }]);
  step(); // our spawn lands and ends the phase (SpawnExecution.ts:121-128)
  if (game.inSpawnPhase()) throw new Error("spawn phase did not end");
  const spawnEnd = game.ticks();

  const tribes = game.allPlayers().filter((p) => p.type() === PlayerType.Bot);
  const nations = game
    .allPlayers()
    .filter((p) => p.type() === PlayerType.Nation);
  const execs = (game as GameImpl).executions();
  const nationKnobs = execs
    .filter((e) => e instanceof NationExecution)
    .map((e) => e as unknown as NationKnobs);

  const result: RealGame = {
    game,
    me,
    meStartTiles: me.numTilesOwned(),
    spawnEnd,
    tribes,
    start: tribes.map((t) => ({
      tiles: t.numTilesOwned(),
      disc: discSize(game, t.spawnTile()!),
      troops: t.troops(),
      gold: t.gold(),
    })),
    tribeExecs: execs.filter((e) => e instanceof TribeExecution).length,
    standings: [],
    launches: new Map(),
    nationBotLand: { total: 0, whileBorderingFreeLand: 0, unscheduled: 0 },
    firstNationBotTick: -1,
    freeShareAtFirstNationBot: -1,
    peakNationBotParallel: 0,
    quiet: { samples: 0, troops: 0, gold: 0 },
    meFirstHit: null,
    meDeathTick: null,
  };

  const land = game.numLandTiles();
  const share = (ps: Player[]) =>
    ps.reduce((s, p) => s + p.numTilesOwned(), 0) / land;
  const freeShare = () => 1 - share(game.allPlayers());
  const seen = new Set<string>();
  // Attacks move troops, and so do boats (troops leave at launch,
  // TransportShipExecution): a tribe with either is not quiet.
  const busy = (p: Player) =>
    p.outgoingAttacks().length + p.incomingAttacks().length > 0 ||
    p.units(UnitType.TransportShip).length > 0;

  while (game.ticks() < spawnEnd + 3 * MINUTE) {
    const tick = game.ticks();
    // Nations whose maybeAttack runs this tick (NationExecution.ts:200, 226),
    // and whether it sees free land (AiAttackBehavior.ts:135-141): nearby()
    // lists TerraNullius exactly when a border tile, or the far bank of a
    // <= 4-tile river, is unowned non-fallout land (PlayerImpl.ts:626-690).
    // NationExecutions tick before any attack does, so this is the state the
    // nation decides on.
    const bordersFree = new Map<Player, boolean>();
    for (const k of nationKnobs) {
      if (k.player === null || !k.player.isAlive()) continue;
      if (tick % k.attackRate !== k.attackTick) continue;
      bordersFree.set(
        k.player,
        k.player.nearby().some((n) => !n.isPlayer()),
      );
    }
    const quiet =
      tick % 50 === 0
        ? tribes
            .filter((t) => t.isAlive() && !busy(t))
            .map((t) => ({
              t,
              troops: t.troops(),
              gold: t.gold(),
              tiles: t.numTilesOwned(),
              rate: config.troopIncreaseRate(t),
              income: config.goldAdditionRate(t),
            }))
        : [];

    step();

    for (const q of quiet) {
      if (!q.t.isAlive() || busy(q.t) || q.t.numTilesOwned() !== q.tiles) {
        continue;
      }
      result.quiet.samples++;
      if (q.t.troops() - q.troops === Math.floor(q.rate)) result.quiet.troops++;
      if (q.t.gold() - q.gold === q.income) result.quiet.gold++;
    }

    for (const p of game.allPlayers()) {
      let onTribes = 0;
      for (const a of p.outgoingAttacks()) {
        const target = a.target();
        const boat = a.sourceTile() !== null;
        const toTribe =
          target.isPlayer() && (target as Player).type() === PlayerType.Bot;
        if (p.type() === PlayerType.Nation && toTribe) onTribes++;
        if (seen.has(a.id())) continue;
        seen.add(a.id());
        const key = `${p.type()}->${kind(target)}${boat ? " (boat)" : ""}`;
        result.launches.set(key, (result.launches.get(key) ?? 0) + 1);
        if (target === me && result.meFirstHit === null) {
          result.meFirstHit = {
            tick: game.ticks(),
            by: p.type(),
            troops: a.troops(),
          };
        }
        if (p.type() === PlayerType.Nation && toTribe && !boat) {
          result.nationBotLand.total++;
          const free = bordersFree.get(p);
          if (free === undefined) result.nationBotLand.unscheduled++;
          else if (free) result.nationBotLand.whileBorderingFreeLand++;
          if (result.firstNationBotTick < 0) {
            result.firstNationBotTick = game.ticks();
            result.freeShareAtFirstNationBot = freeShare();
          }
        }
      }
      result.peakNationBotParallel = Math.max(
        result.peakNationBotParallel,
        onTribes,
      );
    }
    if (result.meDeathTick === null && !me.isAlive()) {
      result.meDeathTick = game.ticks();
    }

    const elapsed = game.ticks() - spawnEnd;
    if (elapsed % MINUTE === 0) {
      const alive = tribes.filter((t) => t.isAlive());
      result.standings.push({
        minute: elapsed / MINUTE,
        tribesAlive: alive.length,
        tribeShare: share(alive),
        nationShare: share(nations.filter((n) => n.isAlive())),
        freeShare: freeShare(),
        meanTribeTiles:
          alive.length === 0 ? 0 : (share(alive) * land) / alive.length,
        tribesAtTrigger: alive.filter(
          (t) => t.troops() >= 0.5 * config.maxTroops(t),
        ).length,
        minTribeGold: alive.reduce(
          (m, t) => (t.gold() < m ? t.gold() : m),
          alive[0]?.gold() ?? 0n,
        ),
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------

describe("TribeStats (H3): tribes in the arena setting", () => {
  beforeAll(() => {
    console.debug = () => {};
  });

  describe("the Config rules (pure)", () => {
    test("cap: exactly a third of a human's, and 1/3.75 of an Impossible nation's, at equal tiles", () => {
      for (const n of [1, 52, 100, 1_150, 5_000, 100_000]) {
        const tribe = CONFIG.maxTroops(stub(PlayerType.Bot, n));
        const human = CONFIG.maxTroops(stub(PlayerType.Human, n));
        const nation = CONFIG.maxTroops(stub(PlayerType.Nation, n));
        // Config.ts:1024-1038: base = 2 * (n^0.6 * 1000 + 50,000) + cities.
        expect(relErr(human, 2 * (pow(n, 0.6) * 1000 + 50_000))).toBeLessThan(
          1e-12,
        );
        expect(relErr(tribe * 3, human)).toBeLessThan(1e-12);
        expect(relErr(tribe * 3.75, nation)).toBeLessThan(1e-12);
      }
      // A fresh 52-tile tribe: 40,470 against our 121,411 and an Impossible
      // nation's 151,764.
      expect(Math.round(CONFIG.maxTroops(stub(PlayerType.Bot, 52)))).toBe(
        40_470,
      );
      expect(Math.round(CONFIG.maxTroops(stub(PlayerType.Human, 52)))).toBe(
        121_411,
      );
      // Start: 10,000 troops and no gold (Config.ts:439-444, 1003-1006).
      const info = new PlayerInfo("t", PlayerType.Bot, null, "TRIBE001");
      expect(CONFIG.startManpower(info)).toBe(10_000);
      expect(CONFIG.startingGold(info)).toBe(0n);
      // Income: 50 gold a tick against our 100 (Config.ts:1092-1101).
      expect(CONFIG.goldAdditionRate(stub(PlayerType.Bot, 52))).toBe(50n);
      expect(CONFIG.goldAdditionRate(stub(PlayerType.Human, 52))).toBe(100n);
    });

    test("regrowth: the human formula x0.5, but on the tribe's own (a third) cap, so ~0.23x ours at the peak", () => {
      // Config.ts:1058-1090: toAdd = (10 + T^0.73 / 4) * (1 - T / max),
      // x0.5 for a Bot (:1066-1068), clamped to max.
      for (const [n, T] of [
        [52, 10_000],
        [52, 30_000],
        [1_150, 35_000],
        [5_000, 1_000],
      ]) {
        const max = CONFIG.maxTroops(stub(PlayerType.Bot, n));
        const formula = 0.5 * (10 + pow(T, 0.73) / 4) * (1 - T / max);
        const rate = CONFIG.troopIncreaseRate(stub(PlayerType.Bot, n, T));
        expect(relErr(rate, Math.min(T + formula, max) - T)).toBeLessThan(
          1e-12,
        );
      }
      // Above the cap the rate is negative (troops bleed back to it).
      const cap = CONFIG.maxTroops(stub(PlayerType.Bot, 52));
      expect(
        CONFIG.troopIncreaseRate(stub(PlayerType.Bot, 52, cap + 1000)),
      ).toBeLessThan(0);

      const rate = (type: PlayerType, n: number, T: number) =>
        CONFIG.troopIncreaseRate(stub(type, n, T));
      // "Half" holds only against a human with the tribe's cap. At equal
      // troops and tiles the (1 - T/max) factor bites 3x harder: 0.41x.
      const equal = rate(PlayerType.Bot, 52, 10_000);
      expect(equal / rate(PlayerType.Human, 52, 10_000)).toBeCloseTo(0.41, 2);
      // At the start: 82.0 a tick against our 330.3 (0.25x).
      expect(equal).toBeCloseTo(82.04, 2);
      expect(rate(PlayerType.Human, 52, 25_000)).toBeCloseTo(330.27, 2);

      // Peak regrowth (at ~41-42% of each one's own cap, docs/03 §3.1):
      // 0.226-0.228x ours and 0.183-0.185x an Impossible nation's.
      const peak = (type: PlayerType, n: number) => {
        const max = CONFIG.maxTroops(stub(type, n));
        let best = 0;
        let at = 0;
        for (let i = 0; i <= 4000; i++) {
          const T = (max * i) / 4000;
          const r = rate(type, n, T);
          if (r > best) {
            best = r;
            at = T / max;
          }
        }
        return { best, at };
      };
      for (const n of [52, 1_000, 5_000]) {
        const tribe = peak(PlayerType.Bot, n);
        const human = peak(PlayerType.Human, n);
        const nation = peak(PlayerType.Nation, n);
        expect(tribe.at).toBeGreaterThan(0.41);
        expect(tribe.at).toBeLessThan(0.42);
        expect(tribe.best / human.best).toBeGreaterThan(0.225);
        expect(tribe.best / human.best).toBeLessThan(0.229);
        expect(tribe.best / nation.best).toBeGreaterThan(0.182);
        expect(tribe.best / nation.best).toBeLessThan(0.186);
      }

      // Refill in the game's integer steps (PlayerImpl.addTroops floors,
      // PlayerImpl.ts:1369-1375): a fresh 52-tile tribe from 10,000 reaches
      // 50/90/99% of its cap after 116/394/744 ticks; we (52 tiles, 25,000)
      // after 94/282/506.
      const refill = (type: PlayerType, n: number, T0: number) => {
        const max = CONFIG.maxTroops(stub(type, n));
        const marks: number[] = [];
        let T = T0;
        for (let t = 1; marks.length < 3 && t < 5_000; t++) {
          T += Math.floor(rate(type, n, T));
          while (
            marks.length < 3 &&
            T >= [0.5, 0.9, 0.99][marks.length] * max
          ) {
            marks.push(t);
          }
        }
        return marks;
      };
      expect(refill(PlayerType.Bot, 52, 10_000)).toEqual([116, 394, 744]);
      expect(refill(PlayerType.Human, 52, 25_000)).toEqual([94, 282, 506]);
    });

    test("x0.7: only the attacker's losses, only for Human and Nation attackers against a Bot", () => {
      const input = (
        attacker: PlayerType,
        defender: PlayerType,
        o: Partial<AttackLogicInput> = {},
        isTraitor = false,
      ): AttackLogicInput => ({
        terrain: TerrainType.Plains,
        attackTroops: 140_000,
        attacker: { type: attacker, numTiles: 3_000 },
        defender: {
          type: defender,
          numTiles: 1_150,
          troops: 35_000,
          isTraitor,
          isDisconnectedTeammate: false,
        },
        defenderHasDefensePost: false,
        falloutRatio: null,
        borderSize: 100,
        ...o,
      });
      const variants: [Partial<AttackLogicInput>, boolean][] = [
        [{}, false],
        [{ attackTroops: 5_000 }, false],
        [{ attackTroops: 1_000_000 }, false],
        [{ terrain: TerrainType.Mountain }, false],
        [{ defenderHasDefensePost: true }, false],
        [{ falloutRatio: 0.2 }, false],
        [{}, true],
      ];
      for (const [o, traitor] of variants) {
        for (const attacker of [PlayerType.Human, PlayerType.Nation]) {
          const vsTribe = CONFIG.attackLogic(
            input(attacker, PlayerType.Bot, o, traitor),
          );
          for (const other of [PlayerType.Human, PlayerType.Nation]) {
            const vsOther = CONFIG.attackLogic(
              input(attacker, other, o, traitor),
            );
            // Config.ts:914-921 scales mag, and the loss is linear in mag.
            expect(
              relErr(
                vsTribe.attackerTroopLoss,
                0.7 * vsOther.attackerTroopLoss,
              ),
            ).toBeLessThan(1e-12);
            // Speed and the tribe's own losses are untouched.
            expect(vsTribe.tickFraction).toBe(vsOther.tickFraction);
            expect(vsTribe.defenderTroopLoss).toBe(vsOther.defenderTroopLoss);
          }
        }
        // A tribe gets no discount attacking anyone, a tribe included.
        const humanVsHuman = CONFIG.attackLogic(
          input(PlayerType.Human, PlayerType.Human, o, traitor),
        );
        for (const defender of [PlayerType.Bot, PlayerType.Human]) {
          expect(
            CONFIG.attackLogic(input(PlayerType.Bot, defender, o, traitor)),
          ).toEqual(humanVsHuman);
        }
      }

      // What eating a typical minute-1 tribe costs (1,150 tiles, 35,000
      // troops, 30.4 a tile) with the 4x stack nations send
      // (AiAttackBehavior.ts:1149-1166): 19.5 troops a tile, against 27.9
      // for the same numbers as a Human or Nation defender and 16 on free
      // plains. The tribe loses its density (30.4) with every tile, so its
      // density holds while it shrinks.
      const typical = CONFIG.attackLogic(
        input(PlayerType.Human, PlayerType.Bot),
      );
      expect(typical.attackerTroopLoss).toBeCloseTo(19.54, 2);
      expect(typical.defenderTroopLoss).toBeCloseTo(35_000 / 1_150, 9);
      expect(
        CONFIG.attackLogic(input(PlayerType.Human, PlayerType.Nation))
          .attackerTroopLoss,
      ).toBeCloseTo(27.92, 2);
      expect(
        CONFIG.attackLogic({
          ...input(PlayerType.Human, PlayerType.Bot),
          defender: null,
        }).attackerTroopLoss,
      ).toBe(16);
    });
  });

  describe("nations against tribes (synthetic plains, real Config and AiAttackBehavior)", () => {
    // NationExecution draws trigger 50-59%, reserve 30-39%, expand 10-19%
    // (NationExecution.ts:76-78); these are the lowest draws.
    const TRIGGER = 0.5;
    const RESERVE = 0.3;
    const EXPAND = 0.1;
    const W = 60;
    const H = 200;
    const NX = 10;

    /**
     * A nation owning the strip x < NX, with 200 one-row tribes (x >= NX,
     * 50 tiles each) along its whole border and no free land unless
     * `freeTile`. Tribe troops are a permutation of base..base+199, so row
     * order is not density order.
     */
    async function nationAmongTribes(
      difficulty: Difficulty,
      base: number,
      freeTile = false,
    ) {
      const game = await plainsGame(W, H, difficulty);
      const nation = addPlayer(game, "NATION01", PlayerType.Nation);
      const tribes: Player[] = [];
      for (let y = 0; y < H; y++) {
        tribes.push(
          addPlayer(game, `TRIBE${String(y).padStart(3, "0")}`, PlayerType.Bot),
        );
      }
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (freeTile && x === NX && y === 0) continue;
          (x < NX ? nation : tribes[y]).conquer(game.ref(x, y));
        }
      }
      tribes.forEach((t, y) => t.setTroops(base + ((y * 37) % H)));
      // One PRNG shared by the behaviours, as NationExecution does. With
      // this seed maybeAttack's 1-in-10 random boat branch
      // (AiAttackBehavior.ts:148-151) is not taken.
      const random = new PseudoRandom(7);
      const emoji = new NationEmojiBehavior(random, game, nation);
      const alliance = new NationAllianceBehavior(random, game, nation, emoji);
      const behavior = new AiAttackBehavior(
        random,
        game,
        nation,
        TRIGGER,
        RESERVE,
        EXPAND,
        alliance,
        emoji,
      );
      // Density = troops / tiles (AiAttackBehavior.ts:500); every tribe has
      // 50 tiles (one has 49 with freeTile), so ascending density is
      // ascending troops.
      const byDensity = [...tribes].sort(
        (a, b) =>
          a.troops() / a.numTilesOwned() - b.troops() / b.numTilesOwned(),
      );
      return { game, nation, tribes, behavior, byDensity };
    }

    test("Impossible: one maybeAttack launches 100 tribe attacks (of 200 bordering), lowest density first, 4x each tribe's troops; Hard: 3", async () => {
      for (const [difficulty, cap] of [
        [Difficulty.Impossible, 100], // AiAttackBehavior.ts:532-534
        [Difficulty.Hard, 3], // :529-530
      ] as const) {
        const { game, nation, byDensity, behavior } = await nationAmongTribes(
          difficulty,
          100,
        );
        nation.setTroops(10_000_000);
        const before = new Map(byDensity.map((t) => [t, t.troops()]));
        behavior.maybeAttack();
        game.executeNextTick(); // the attacks init at the end of this tick
        const attacks = nation.outgoingAttacks();
        expect(attacks).toHaveLength(cap);
        // attackBots sorts by density, then slices (AiAttackBehavior.ts:
        // 500-511); every attack is a land attack of 4x the tribe's troops
        // (calculateBotAttackTroops, :1149-1166), paid at init.
        expect(new Set(attacks.map((a) => a.target()))).toEqual(
          new Set(byDensity.slice(0, cap)),
        );
        let sent = 0;
        for (const a of attacks) {
          expect(a.sourceTile()).toBeNull();
          expect(a.troops()).toBe(4 * before.get(a.target() as Player)!);
          sent += a.troops();
        }
        expect(nation.troops()).toBe(10_000_000 - sent);
      }
    });

    test("the troop budget binds long before 100: troops - reserve x cap, 4x per tribe, the rest if >= 2x, else skipped", async () => {
      // Tribes at their starting 10,000 (+0..199); the nation exactly at its
      // trigger, so the budget is (trigger - reserve) x cap = 72.8k.
      const { game, nation, byDensity, behavior } = await nationAmongTribes(
        Difficulty.Impossible,
        10_000,
      );
      const cap = game.config().maxTroops(nation);
      expect(nation.numTilesOwned()).toBe(NX * H);
      expect(Math.round(cap)).toBe(364_088);
      const troops = Math.ceil(TRIGGER * cap);
      nation.setTroops(troops);

      // calculateAttackTroops / calculateBotAttackTroops replayed
      // (AiAttackBehavior.ts:1041-1096, 1149-1166).
      const expected: number[] = [];
      let sent = 0;
      for (const t of byDensity.slice(0, 100)) {
        const left = troops - RESERVE * cap - sent;
        let s = 4 * t.troops();
        if (s > left) s = left < 2 * t.troops() ? 0 : left;
        if (s < 1) continue;
        expected.push(Math.floor(s));
        sent += s;
      }
      expect(expected).toHaveLength(2);

      behavior.maybeAttack();
      game.executeNextTick();
      const attacks = nation.outgoingAttacks();
      expect(attacks.map((a) => a.troops())).toEqual(expected);
      expect(attacks.map((a) => a.target())).toEqual(byDensity.slice(0, 2));
      // Home falls to the reserve, not below.
      expect(nation.troops() / cap).toBeCloseTo(RESERVE, 4);
    });

    test("while the nation borders any free land it sends the free-land attack and no tribe attack", async () => {
      const { game, nation, behavior } = await nationAmongTribes(
        Difficulty.Impossible,
        100,
        true,
      );
      nation.setTroops(10_000_000);
      const cap = game.config().maxTroops(nation);
      expect(nation.nearby().some((n) => !n.isPlayer())).toBe(true);
      behavior.maybeAttack();
      game.executeNextTick();
      const attacks = nation.outgoingAttacks();
      // AiAttackBehavior.ts:139-141 returns after the free-land attack,
      // sized troops - expandRatio x cap (:1052-1053).
      expect(attacks).toHaveLength(1);
      expect(attacks[0].target().isPlayer()).toBe(false);
      expect(attacks[0].troops()).toBe(Math.floor(10_000_000 - EXPAND * cap));
    });
  });

  describe("what tribes do (synthetic plains, real TribeExecution)", () => {
    test("they expand first: while free land is nearby every decision is a free-land attack of troops - expandRatio x cap, even at full troops next to us", async () => {
      const game = await plainsGame(200, 200);
      const tribe = addPlayer(game, "TRIBE001", PlayerType.Bot);
      const human = addPlayer(game, "HUMANID1", PlayerType.Human);
      fill(game, tribe, 90, 100, 90, 100); // 100 tiles
      fill(game, human, 100, 120, 90, 110); // 400 tiles, bordering it
      human.setTroops(1_000);
      const k = runTribe(game, tribe);
      // Every knob is the tribe's public id run through the constructor's
      // draws (TribeExecution.ts:35-40), so an agent can replay them and
      // know each tribe's decision ticks and ratios without reading state.
      const r = new PseudoRandom(simpleHash(tribe.id()));
      const attackRate = r.nextInt(40, 80);
      expect(k).toMatchObject({
        attackRate,
        attackTick: r.nextInt(0, attackRate),
        triggerRatio: r.nextInt(50, 60) / 100,
        reserveRatio: r.nextInt(30, 40) / 100,
        expandRatio: r.nextInt(10, 20) / 100,
      });

      for (let decision = 0; decision < 3; decision++) {
        toDecision(game, k);
        const cap = game.config().maxTroops(tribe);
        tribe.setTroops(Math.floor(cap)); // full, far above its trigger
        expect(tribe.nearby().some((n) => !n.isPlayer())).toBe(true);
        game.executeNextTick();
        const attacks = tribe.outgoingAttacks();
        // One free-land attack, the later ones merged into it
        // (AttackExecution.ts:171-181); nothing at the weak human.
        expect(attacks).toHaveLength(1);
        expect(attacks[0].target().isPlayer()).toBe(false);
        expect(human.incomingAttacks()).toHaveLength(0);
        if (decision === 0) {
          // The first decision (TribeExecution.ts:60-73) sends
          // troops - expandRatio x cap (AiAttackBehavior.ts:1052-1053),
          // not Config.attackAmount's troops/20 (Config.ts:995-1001).
          expect(attacks[0].troops()).toBe(
            Math.floor(Math.floor(cap) - k.expandRatio * cap),
          );
        }
      }
    });

    test("with no free land they attack us: only at >= triggerRatio x cap, each decision a coin flip for a human neighbour, sending troops - reserveRatio x cap", async () => {
      const game = await plainsGame(100, 50);
      const tribe = addPlayer(game, "TRIBE001", PlayerType.Bot);
      const human = addPlayer(game, "HUMANID1", PlayerType.Human);
      fill(game, tribe, 0, 50, 0, 50);
      fill(game, human, 50, 100, 0, 50);
      human.setTroops(50_000);
      const k = runTribe(game, tribe);
      const cap = game.config().maxTroops(tribe);

      // Below the trigger: nothing, ever (AiAttackBehavior.ts:765-767).
      tribe.setTroops(Math.floor(k.triggerRatio * cap) - 1);
      for (let d = 0; d < 6; d++) {
        toDecision(game, k);
        game.executeNextTick();
        expect(tribe.outgoingAttacks()).toHaveLength(0);
      }

      // At the cap: the shuffled neighbour list skips a Human or Nation
      // with chance 1/2 per decision (:784-797), so it may take a few.
      tribe.setTroops(Math.floor(cap));
      let decisions = 0;
      while (tribe.outgoingAttacks().length === 0 && decisions < 20) {
        toDecision(game, k);
        game.executeNextTick();
        decisions++;
      }
      const attacks = tribe.outgoingAttacks();
      expect(attacks).toHaveLength(1);
      expect(attacks[0].target()).toBe(human);
      expect(attacks[0].sourceTile()).toBeNull();
      expect(attacks[0].troops()).toBe(
        Math.floor(Math.floor(cap) - k.reserveRatio * cap),
      );
    });

    test("a tribe neighbour is never skipped: the first decision after the free-land check attacks it", async () => {
      const game = await plainsGame(100, 50);
      const tribe = addPlayer(game, "TRIBE001", PlayerType.Bot);
      const other = addPlayer(game, "TRIBE002", PlayerType.Bot);
      fill(game, tribe, 0, 50, 0, 50);
      fill(game, other, 50, 100, 0, 50);
      const k = runTribe(game, tribe);
      tribe.setTroops(Math.floor(game.config().maxTroops(tribe)));
      // Decision 1 builds the behaviour; its free-land attack finds neither
      // free land nor a shore to boat from (TribeExecution.ts:60-73).
      toDecision(game, k);
      game.executeNextTick();
      expect(tribe.outgoingAttacks()).toHaveLength(0);
      // Decision 2: attackRandomTarget, no coin flip for a tribe.
      toDecision(game, k);
      game.executeNextTick();
      expect(tribe.outgoingAttacks().map((a) => a.target())).toEqual([other]);
    });

    test("they retaliate: a small attack on a tribe at >= its trigger is cancelled 1:1 by its counter-attack of troops - reserveRatio x cap", async () => {
      const CLIENT = "AGENTCL1";
      const game = await plainsGame(100, 50, Difficulty.Impossible, [
        new PlayerInfo("agent", PlayerType.Human, CLIENT, "AGENTID1"),
      ]);
      const human = game.player("AGENTID1");
      const tribe = addPlayer(game, "TRIBE001", PlayerType.Bot);
      fill(game, tribe, 0, 50, 0, 50);
      fill(game, human, 50, 100, 0, 50);
      human.setTroops(50_000);
      const k = runTribe(game, tribe);
      const cap = game.config().maxTroops(tribe);
      tribe.setTroops(Math.floor(cap));
      toDecision(game, k);
      game.executeNextTick(); // decision 1 builds the behaviour only
      expect(tribe.outgoingAttacks()).toHaveLength(0);

      // Our attack, sent through the agent's path (IntentSchema, then
      // Executor.createExec), inits the tick before the tribe's decision.
      toDecision(game, k, 1);
      const intent = {
        type: "attack" as const,
        targetID: tribe.id(),
        troops: 1_000,
      };
      expect(IntentSchema.safeParse(intent).success).toBe(true);
      game.addExecution(
        new Executor(game, "game", undefined).createExec({
          ...intent,
          clientID: CLIENT,
        }),
      );
      game.executeNextTick();
      expect(human.outgoingAttacks()).toHaveLength(1);
      expect(human.troops()).toBe(49_000);
      const R = Math.floor(tribe.troops() - k.reserveRatio * cap);

      // The decision tick. The tribe decides first: findIncomingAttackPlayer
      // does not skip humans for a tribe (AiAttackBehavior.ts:458-479) and
      // sendAttack(.., force) sizes the answer troops - reserve x cap. Our
      // attack then takes its first tile, paying `loss`. At the end of the
      // tick the answer inits and cancels ours (AttackExecution.ts:157-170).
      const loss = CONFIG.attackLogic({
        terrain: TerrainType.Plains,
        attackTroops: 1_000,
        attacker: { type: PlayerType.Human, numTiles: 2_500 },
        defender: {
          type: PlayerType.Bot,
          numTiles: 2_500,
          troops: Math.floor(cap),
          isTraitor: false,
          isDisconnectedTeammate: false,
        },
        defenderHasDefensePost: false,
        falloutRatio: null,
        borderSize: 50,
      }).attackerTroopLoss;
      game.executeNextTick();
      expect(human.numTilesOwned()).toBe(2_501);
      expect(human.outgoingAttacks()).toHaveLength(0);
      const counter = tribe.outgoingAttacks();
      expect(counter).toHaveLength(1);
      expect(counter[0].target()).toBe(human);
      expect(counter[0].troops()).toBeCloseTo(R - (1_000 - loss), 6);
      expect(human.incomingAttacks()).toEqual(counter);
      expect(human.troops()).toBe(49_000); // nothing comes back
    });

    test("under 100 tiles a player is annexed whole: a fresh 52-tile tribe falls to one tile's losses, during our spawn immunity, and hands over all its gold", async () => {
      const CLIENT = "AGENTCL1";
      const game = await plainsGame(60, 60, Difficulty.Impossible, [
        new PlayerInfo("agent", PlayerType.Human, CLIENT, "AGENTID1"),
      ]);
      const human = game.player("AGENTID1");
      const tribe = addPlayer(game, "TRIBE001", PlayerType.Bot);
      fill(game, human, 0, 20, 0, 60); // 1,200 tiles
      fill(game, tribe, 20, 22, 0, 26); // 52 tiles, starting troops
      expect(tribe.troops()).toBe(10_000);
      tribe.addGold(12_345n);
      human.setTroops(100_000);
      // Tribes are never immune (PlayerImpl.ts:1907-1915).
      expect(game.isSpawnImmunityActive()).toBe(true);
      expect(tribe.isImmune()).toBe(false);
      game.addExecution(
        new Executor(game, "game", undefined).createExec({
          type: "attack",
          targetID: tribe.id(),
          troops: 5_000,
          clientID: CLIENT,
        }),
      );
      game.executeNextTick(); // init: 5,000 leave home
      // The first tile's loss, from attackLogic on the live stack.
      const lossAt = (attackTroops: number) =>
        game.config().attackLogic({
          terrain: TerrainType.Plains,
          attackTroops,
          attacker: { type: PlayerType.Human, numTiles: 1_200 },
          defender: {
            type: PlayerType.Bot,
            numTiles: 52,
            troops: 10_000,
            isTraitor: false,
            isDisconnectedTeammate: false,
          },
          defenderHasDefensePost: false,
          falloutRatio: null,
          borderSize: 26,
        }).attackerTroopLoss;
      const loss = lossAt(5_000);
      expect(loss).toBeCloseTo(135.9, 1);
      // With >= 10,000 / 0.6 troops the ratio clamp (Config.ts:947) makes
      // it 40.8.
      expect(lossAt(16_667)).toBeCloseTo(40.8, 1);
      game.executeNextTick();
      // handleDeadDefender (AttackExecution.ts:448-482): below 100 tiles the
      // target is conquered (GameImpl.conquerPlayer: all of a tribe's gold,
      // Config.ts:735-744) and every tile touching us chains over.
      expect(tribe.isAlive()).toBe(false);
      expect(human.numTilesOwned()).toBe(1_252);
      expect(human.gold()).toBe(12_345n);
      // The attack found nothing left, retreated and refunded the rest
      // (AttackExecution.ts:302-306): the 52 tiles cost one tile's loss.
      expect(human.outgoingAttacks()).toHaveLength(0);
      expect(human.troops()).toBe(95_000 + Math.floor(5_000 - loss));
    });

    test("the threshold is < 100, for anyone: a 150-tile tribe is taken tile by tile until it would drop below 100, then all at once; a 52-tile human dies to its first lost tile", async () => {
      const game = await plainsGame(60, 60);
      const nation = addPlayer(game, "NATION01", PlayerType.Nation);
      const tribe = addPlayer(game, "TRIBE001", PlayerType.Bot);
      fill(game, nation, 0, 20, 0, 60);
      fill(game, tribe, 20, 30, 0, 15); // 150 tiles, a 15-tile face
      nation.setTroops(1_000_000);
      // Built as AiAttackBehavior.sendLandAttack builds it (:1107-1113).
      game.addExecution(new AttackExecution(20_000, nation, tribe.id()));
      const seen: number[] = [];
      for (let i = 0; i < 200 && tribe.isAlive(); i++) {
        game.executeNextTick();
        if (tribe.isAlive()) seen.push(tribe.numTilesOwned());
      }
      expect(tribe.isAlive()).toBe(false);
      expect(nation.numTilesOwned()).toBe(1_200 + 150);
      expect(Math.min(...seen)).toBeGreaterThanOrEqual(100);
      expect(seen.some((n) => n < 150)).toBe(true);

      // The same rule against us: a tribe takes one tile of our 52 and we
      // are gone. Tribes ignore our spawn immunity (PlayerImpl.ts:1921-1924).
      const g2 = await plainsGame(60, 60);
      const t2 = addPlayer(g2, "TRIBE001", PlayerType.Bot);
      const h2 = addPlayer(g2, "HUMANID1", PlayerType.Human);
      fill(g2, t2, 0, 20, 0, 60);
      fill(g2, h2, 20, 22, 0, 26); // 52 tiles
      h2.setTroops(25_000);
      t2.setTroops(30_000);
      expect(g2.isSpawnImmunityActive()).toBe(true);
      g2.addExecution(new AttackExecution(5_000, t2, h2.id()));
      g2.executeNextTick();
      g2.executeNextTick();
      expect(h2.isAlive()).toBe(false);
      expect(t2.numTilesOwned()).toBe(1_200 + 52);
    });
  });

  describe("a real 3-minute game (Pangaea, arena setting, an idle human)", () => {
    // Pangaea: all land, 29 nations, one of the faster maps to simulate
    // (~7 s for 1,800 ticks here; World takes ~13 s).
    let real: RealGame;
    beforeAll(async () => {
      real = await playRealGame(GameMapType.Pangaea);
    }, 60_000);

    test("400 tribes on 52-tile discs (clipped at the map edge), 10,000 troops, no gold, each with its TribeExecution", () => {
      const { game, tribes, start } = real;
      expect(game.config().bots()).toBe(TRIBES);
      expect(tribes).toHaveLength(TRIBES);
      expect(real.tribeExecs).toBe(TRIBES);
      for (const s of start) {
        expect(s.tiles).toBe(s.disc);
        expect(s.troops).toBe(10_000);
        expect(s.gold).toBe(0n);
      }
      expect(start.filter((s) => s.tiles === 52).length).toBeGreaterThan(390);
      expect(real.meStartTiles).toBe(52);
    });

    test("a quiet tribe grows floor(troopIncreaseRate) troops and 50 gold every tick", () => {
      expect(real.quiet.samples).toBeGreaterThan(1_000);
      expect(real.quiet.troops).toBe(real.quiet.samples);
      expect(real.quiet.gold).toBe(real.quiet.samples);
      // PlayerExecution ticks from the tick after the phase ended, so a
      // tribe that has conquered no one holds exactly 50 x 600 gold at
      // minute 1, all of it the conqueror's.
      expect(real.standings[0].minTribeGold).toBe(50n * BigInt(MINUTE));
    });

    test("nations eat the tribes: most are alive and hold most of the land at minute 1, ~90% are gone by minute 2", () => {
      const [m1, m2, m3] = real.standings;
      expect(real.standings.map((s) => s.minute)).toEqual([1, 2, 3]);
      // Minute 1 (measured: 298 alive, 64% tribes, 35% nations, 0.6% free,
      // ~906 tiles a tribe, 97 at >= 50% of their cap).
      expect(m1.tribesAlive).toBeGreaterThan(TRIBES / 2);
      expect(m1.tribeShare).toBeGreaterThan(m1.nationShare);
      expect(m1.freeShare).toBeLessThan(0.02);
      expect(m1.meanTribeTiles).toBeGreaterThan(500);
      expect(m1.tribesAtTrigger).toBeGreaterThan(0);
      expect(m1.tribesAtTrigger).toBeLessThan(m1.tribesAlive / 2);
      // Minute 2 (26 alive, 4.6%) and 3 (6 alive, 1.1%; nations 99%).
      expect(m2.tribesAlive).toBeLessThan(TRIBES * 0.15);
      expect(m2.tribeShare).toBeLessThan(0.1);
      expect(m3.tribesAlive).toBeLessThan(TRIBES * 0.05);
      expect(m3.tribeShare).toBeLessThan(0.03);
      expect(m3.nationShare).toBeGreaterThan(0.95);
    });

    test("nations attack tribes only from a border without free land, never near 100 at once", () => {
      const nb = real.nationBotLand;
      expect(nb.total).toBeGreaterThan(100); // measured 630
      expect(nb.unscheduled).toBe(0);
      expect(nb.whileBorderingFreeLand).toBe(0);
      // Free land still existed elsewhere when the first one came (tick 217,
      // 1.5% of the map): "free land runs out" is per nation.
      expect(real.freeShareAtFirstNationBot).toBeGreaterThan(0.005);
      expect(real.firstNationBotTick).toBeGreaterThan(real.spawnEnd + 100);
      // Measured 11 tribes at once, at most, for any nation.
      expect(real.peakNationBotParallel).toBeGreaterThan(1);
      expect(real.peakNationBotParallel).toBeLessThan(25);
    });

    test("tribes expand most, then fight each other and the nations; one ended our idle 52-tile spawn the tick after its attack reached it", () => {
      const n = (k: string) => real.launches.get(k) ?? 0;
      // Measured: 1,187 on free land, 1,050 on tribes, 157 on nations.
      expect(n("BOT->TERRA_NULLIUS")).toBeGreaterThan(n("BOT->BOT"));
      expect(n("BOT->BOT")).toBeGreaterThan(n("BOT->NATION"));
      expect(n("BOT->NATION")).toBeGreaterThan(0);
      expect(n("NATION->BOT")).toBeGreaterThan(n("NATION->NATION"));
      // We sent nothing and were at 52 tiles: the first attack to arrive
      // (a tribe's, 15.5k troops at tick 735) took one tile and all the rest.
      expect(real.meFirstHit?.by).toBe(PlayerType.Bot);
      expect(real.meDeathTick).toBe(real.meFirstHit!.tick + 1);
      expect(real.me.isAlive()).toBe(false);
    });

    test("the opening lever on the real map: spawn touching a fresh tribe, attack on the first tick, and all 52 of its tiles are ours for one tile's loss", async () => {
      const { game, me, step } = await arenaSim(GameMapType.Pangaea);
      step();
      step();
      step(); // tribes landed in tick 1, nations in tick 2
      // The first tribe (in player order) on a full disc with free land in
      // the 8x8 box 8 tiles to its east: our disc there shares its east
      // face, the four full-width rows y-2..y+1 (GameMap.ts:715-735).
      const free = (x: number, y: number) => {
        if (!game.isValidCoord(x, y)) return false;
        const t = game.ref(x, y);
        return game.isLand(t) && !game.isImpassable(t) && !game.hasOwner(t);
      };
      const tribe = game
        .allPlayers()
        .filter((p) => p.type() === PlayerType.Bot)
        .find((t) => {
          const c = t.spawnTile()!;
          if (t.numTilesOwned() !== 52) return false;
          for (let dy = -4; dy < 4; dy++) {
            for (let dx = 4; dx < 12; dx++) {
              if (!free(game.x(c) + dx, game.y(c) + dy)) return false;
            }
          }
          return true;
        })!;
      expect(tribe).toBeDefined();
      const c = tribe.spawnTile()!;
      step([{ type: "spawn", tile: game.ref(game.x(c) + 8, game.y(c)) }]);
      step(); // our spawn lands and ends the phase
      expect(game.inSpawnPhase()).toBe(false);
      expect(me.numTilesOwned()).toBe(52);
      expect(me.sharesBorderWith(tribe)).toBe(true);
      expect(tribe.numTilesOwned()).toBe(52);

      step([{ type: "attack", targetID: tribe.id(), troops: 20_000 }]);
      expect(me.outgoingAttacks()).toHaveLength(1); // 20,000 left home
      step(); // its first tile, then the whole tribe
      expect(tribe.isAlive()).toBe(false);
      expect(me.numTilesOwned()).toBe(104);
      expect(me.outgoingAttacks()).toHaveLength(0); // refunded
      // Two ticks of regrowth (~330 each) outweigh the one tile's ~41.
      expect(me.troops()).toBeGreaterThan(25_000);
    });
  });
});
