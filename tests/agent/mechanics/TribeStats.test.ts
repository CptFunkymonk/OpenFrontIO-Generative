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
 *   maximum (Arena.ts:399 and its --bots help :83, SinglePlayerModal.ts:99,
 *   Schemas.ts:534). GameRunner.init adds TribeSpawner.spawnTribes(
 *   config.bots()) (GameRunner.ts:180-184, TribeSpawner.ts:32-87). Each tribe
 *   lands in tick 1 on a full 52-tile disc (clipped at the map edge) at a
 *   random free tile >= 30 (Manhattan) from every earlier spawn, relaxed
 *   after 750 tries (SpawnExecution.getSpawn :139-197, :166-184,
 *   minDistanceBetweenPlayers Config.ts:823-825), and gets a PlayerExecution
 *   and a TribeExecution (SpawnExecution.ts:112-117); one that finds no site
 *   gets neither (:102-106). Start: 10,000 troops, 0 gold
 *   (Config.startManpower :1003-1006, startingGold :439-444).
 * - A third of the cap: TRUE. maxTroops divides the shared base
 *   2 x (tiles^0.6 x 1000 + 50,000) + cities by 3 for a Bot
 *   (Config.ts:1024-1038): 1/3 of ours, 1/3.75 of an Impossible nation's.
 * - Half the regrowth: PARTIAL. troopIncreaseRate multiplies
 *   (10 + T^0.73/4) x (1 - T/max) by 0.5 (Config.ts:1058-1068), but max is
 *   the tribe's own cap, a third of ours (M). At equal troops T and tiles the
 *   ratio to our rate is 0.5 (1 - 3T/M) / (1 - T/M): 0.5 at T = 0, 0.41 at
 *   a fresh tribe's 10,000 on 52 tiles, 0 at the tribe's cap. Peak to peak
 *   (at ~41% of each cap) it is 0.226-0.228x ours, 0.183-0.185x an
 *   Impossible nation's. Applied every tick, floored (PlayerExecution.ts:
 *   97-98, PlayerImpl.ts:1369-1375), with 50 gold a tick against our 100
 *   (Config.ts:1092-1101).
 * - x0.7 losses: TRUE, narrowly. attackLogic scales mag by
 *   BOT_DEFENDER_LOSS_MULT = 0.7 only when the attacker is Human or Nation and
 *   the defender a Bot (Config.ts:135, 914-921): the attacker's loss only,
 *   not the speed nor the tribe's loss. A tribe attacking a player (a tribe
 *   included) gets nothing, but on free land it pays mag/10 a tile against
 *   mag/5 for everyone else (Config.ts:896-900): 8 against our 16 on plains.
 *   With a stack >= the tribe's troops / 0.6 (the ratio clamp, :947) a tile
 *   of a tribe costs K x (0.463 x bonuses + 0.0039 x its density), K = mag x
 *   0.7 x 0.6 = 33.6 / 42 / 50.4 on plains / highland / mountain (mag
 *   80/100/120, terrainAttackBase :172-188).
 * - Up to 100 tribes once free land runs out: PARTIAL. The cap is 100 at
 *   Impossible, 3 at Hard (getBotAttackMaxParallelism,
 *   AiAttackBehavior.ts:522-538), taken from the bordering tribes sorted by
 *   density (attackBots, :484-520). But:
 *   (a) "Free land runs out" is per nation: maybeAttack sends the free-land
 *       attack and returns while the nation's border, or the far bank of a
 *       <= 4-tile river (PlayerImpl.ts:605-695), shows free land, and only if
 *       that send succeeds (:135-141). Across a river it is a boat
 *       (sendBoatAttackToNearbyTerraNullius :879-930); if no boat can go
 *       (boat cap, no shore in range, boats disabled) it falls through to
 *       attackBots although free land is in sight (pinned).
 *   (b) The size of each tribe attack (calculateAttackTroops :1041-1096):
 *         min(calculateBotAttackTroops(tribe, troops - reserveRatio x cap -
 *             sentSoFar), troopSendCap()),
 *       dropped below 1 troop, or below 0.2x the tribe's troops unless the
 *       nation is under attack (isAttackTooWeak :961-973, applied
 *       :1081-1083). calculateBotAttackTroops (:1149-1166) gives 4x the
 *       tribe's troops, or all that is left if that is >= 2x, else 0.
 *       troopSendCap (:986-1032) is troops - ceil(0.9 x the most troops of
 *       any nearby non-friendly non-Bot player), >= 0, Infinity with none;
 *       it reads home troops, which fall only when the attacks init at the
 *       end of the tick, so every attack of one pass may take the whole cap.
 *       Under attack (by anyone, a tribe included) it is at least the sum of
 *       the incoming attacks and the 0.2x floor is off (:966, :1024-1029).
 *       So: with no non-bot neighbour a nation at a 50% trigger with a 30%
 *       reserve funds two attacks on fresh tribes (40,000 and 32,818); next
 *       to a rival (us included) at 0.96x / 1.04x / 1.09x its troops the same
 *       budget becomes 3 / 5 / 16 smaller attacks, and at ~1.1x (cap under
 *       0.2x a fresh tribe) or more it sends no tribe attack at all, nor any
 *       other player attack, until something attacks it. In the real game
 *       below, the cap cut 449 of 669 nation sends on tribes (67%), 311 were
 *       under 2x the tribe's troops, only 132 (20%) were the full 4x, and the
 *       cap or the floor killed another 623 sends the budget allowed. The
 *       most tribes one nation attacked at once was 11 (9 on World).
 *   (c) It runs only past the reserve and trigger gates (the trigger is
 *       skipped 10% of the time) and after `retaliate`, which answers
 *       non-tribe attackers first (attackBestTarget :278-304, order :428);
 *       a bordering tribe that owns structures jumps the gates (:285-287).
 *       Tribes across water get boat attacks (sendAttack :822-840).
 *
 * What tribes do (TribeExecution.ts:51-137, AiAttackBehavior):
 * - They decide at the ticks t with t % attackRate === attackTick, attackRate
 *   40-79 and attackTick 0..attackRate-1, drawn with the three ratios from
 *   PseudoRandom(simpleHash(id)) alone (TribeExecution.ts:35-40, 52), and
 *   only once the spawn phase is over (activeDuringSpawnPhase :43-45). So an
 *   agent can replay every tribe's schedule from its id, and its first
 *   decision comes 0 to attackRate - 1 ticks after the phase ends (measured
 *   0-76, median 31), not "after 40-79 ticks".
 * - Expansion first. The first decision builds the behaviour and sends a
 *   free-land attack (:60-73); while free land is nearby every later decision
 *   does the same (:128-134), sized troops - expandRatio (10-19%) x cap
 *   (AiAttackBehavior.ts:1052-1053; docs/06 §6.6's "attackAmount =
 *   troops/20" only fills in a null troop count, AttackExecution.ts:130-132).
 *   The first decision that finds no free land latches neighborsTerraNullius
 *   off for good (:131-132): free land that opens later is never taken. A
 *   traitor neighbour (1/3 chance, :113-126) comes before all of this.
 * - With no free land they attack, but only at >= triggerRatio (50-59%) x
 *   cap (attackRandomTarget, AiAttackBehavior.ts:765-798): first the largest
 *   incoming attack, ours included (a tribe does not skip humans, :458-479,
 *   :769-773), then a traitor (1/3), then a shuffled neighbour, skipping
 *   each Human or Nation with chance 1/2 (16 of 40 tribe ids attacked us at
 *   the first chance) but never a tribe (40 of 40) (:784-797). They send
 *   troops - reserveRatio (30-39%) x cap, with no send cap and no 0.2x floor
 *   (:962, :987). Their answer to our attack cancels it 1:1 at init
 *   (AttackExecution.ts:157-170). Only human attackers respect spawn
 *   immunity, and tribes are never immune (PlayerImpl.ts:1907-1926).
 * - Not in the claim, and the biggest lever found: one troop takes a player
 *   of up to 100 tiles. AttackExecution.tick checks troopCount < 1 only
 *   before each tile (:296-300), so any attack of >= 1 troop that shares a
 *   border takes its first tile; if that leaves the target under 100 tiles
 *   (:449), handleDeadDefender (:448-482) conquers it whole (the tiles
 *   touching the attacker chain over, the rest go to its other neighbours)
 *   and the attacker gets all of a tribe's gold (GameImpl.conquerPlayer,
 *   Config.conquerGoldAmount :735-744). The cost is min(stack, that tile's
 *   loss): a stack left under 1 troop is deleted, nothing refunded
 *   (:296-300); a bigger one finds nothing left and retreats with the rest
 *   (:302-306). So 1 troop takes a fresh 52-tile tribe, or a 100-tile one
 *   (not a 101-tile one); a 5,000 stack pays 136, a 20,000 one 41. Stacks
 *   leave home at init (:133-140), before any refund: from 25,000, three
 *   16,667 attacks start at 16,667 / 8,333 / 0 and the third tribe survives,
 *   while three 1-troop attacks take all three. The window: a tribe passes
 *   100 tiles 7-84 ticks after the phase ends (median 37), 5-67 ticks after
 *   its own first decision (median 6). On a real map a spawn disc touches at
 *   most one fresh tribe (two need centres <= 22 apart; tribes spawn >= 30
 *   apart). The rule cuts both ways: the idle 52-tile human in the real game
 *   died the tick after the first attack (a tribe's) reached it.
 * - How fast nations eat them (Pangaea, 29 nations, fixed seed): 298 of 400
 *   tribes alive at minute 1 holding 64% of the land (nations 35%, free
 *   0.6%); 26 alive (4.6%) at minute 2; 6 (1.1%) at minute 3 (nations 99%).
 *   On World (72 nations) this harness measured 230 / 44 / 0. Tribes attack
 *   free land most, then each other, then nations.
 *
 * Setting: the real Config everywhere (not TestConfig). The pure tests call
 * Config as createGameRunner builds it (GameRunner.ts:46). The synthetic
 * scenarios build a plains field the way setup() builds a game (createGame,
 * endSpawnPhase) and run the real AiAttackBehavior and TribeExecution; they
 * set troops and tiles, which only tests may do. Per-id behaviour (coin
 * flips, retaliation) is sampled over 40 tribe ids, not one seed. The real
 * game is built exactly as the arena builds it (arenaGameStart into
 * createGameRunner, NodeMapLoader on resources/maps), FFA singleplayer,
 * Impossible, default nations, 400 tribes, Normal size, with one idle human
 * that spawns on a fixed free site and then sends nothing; it observes the
 * nations' sizing by wrapping AiAttackBehavior's private methods (calling
 * through, restored afterwards), which changes nothing in the game.
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
  TerraNullius,
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

/** The arena's setting (Arena.ts:392-400, ArenaGame.arenaGameStart). */
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

/** A fixed list of tribe ids, so per-id coin flips are sampled, not one seed. */
const TRIBE_IDS = Array.from(
  { length: 40 },
  (_, i) => `TRIBE${String(i + 1).padStart(3, "0")}`,
);

// ---------------------------------------------------------------------------
// Synthetic fields: all plains (plus water where asked), built as setup()
// builds a game but with the real Config (TestConfig overrides the troop and
// attack rules, tests/util/TestConfig.ts).

// Terrain bytes (GameMap.ts:127-130: bit 7 land, bit 6 shoreline, bit 5
// ocean, bits 0-4 magnitude; land magnitude < 10 is Plains, :397-407).
const PLAINS_BYTE = 0x80 | 5;
const OCEAN = 0x20;
const SHORELINE = 0x40;

type Water = (x: number, y: number) => boolean;

/** A map and its half-size minimap, shoreline set on both sides of a coast. */
async function terrain(w: number, h: number, water: Water) {
  const t = new Uint8Array(w * h);
  let land = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      t[y * w + x] = water(x, y) ? OCEAN : PLAINS_BYTE;
      if (!water(x, y)) land++;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (water(nx, ny) !== water(x, y)) {
          t[y * w + x] |= SHORELINE;
          break;
        }
      }
    }
  }
  return genTerrainFromBin({ width: w, height: h, num_land_tiles: land }, t);
}

async function plainsGame(
  width: number,
  height: number,
  difficulty: Difficulty = Difficulty.Impossible,
  humans: PlayerInfo[] = [],
  opts: { water?: Water; disabledUnits?: UnitType[] } = {},
): Promise<Game> {
  const water = opts.water ?? (() => false);
  const config = new Config(
    { ...GAME_CONFIG, difficulty, disabledUnits: opts.disabledUnits },
    new UserSettings(),
    false,
  );
  const game = createGame(
    humans,
    [],
    await terrain(width, height, water),
    await terrain(Math.ceil(width / 2), Math.ceil(height / 2), (x, y) =>
      [0, 1].some((dy) => [0, 1].some((dx) => water(2 * x + dx, 2 * y + dy))),
    ),
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

/** The same knobs replayed from the tribe's public id (TribeExecution.ts:35-40). */
function replayKnobs(id: string): TribeKnobs {
  const r = new PseudoRandom(simpleHash(id));
  const attackRate = r.nextInt(40, 80);
  return {
    attackRate,
    attackTick: r.nextInt(0, attackRate),
    triggerRatio: r.nextInt(50, 60) / 100,
    reserveRatio: r.nextInt(30, 40) / 100,
    expandRatio: r.nextInt(10, 20) / 100,
  };
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

/** Runs the tribe's next decision tick. */
function decide(game: Game, k: TribeKnobs) {
  toDecision(game, k);
  game.executeNextTick();
}

/**
 * A nation's tribe attacks of one attackBots pass, replayed from
 * calculateAttackTroops (AiAttackBehavior.ts:1041-1096): the reserve budget
 * troops - reserveRatio x cap - sentSoFar, sized by calculateBotAttackTroops
 * (:1149-1166: 4x the tribe's troops, or the rest if that is >= 2x, else 0),
 * then min() with troopSendCap (:1071-1074), dropped below 1 troop (:1076)
 * or below 0.2x the tribe's troops unless under attack (isAttackTooWeak,
 * :961-973, :1081-1083). The attack holds the floor (removeTroops,
 * PlayerImpl.ts:1376-1383); the budget counts the unfloored send (:1091-1093).
 */
function replayTribeSends(
  troops: number,
  maxTroops: number,
  reserveRatio: number,
  byDensity: Player[],
  sendCap = Infinity,
  underAttack = false,
): { target: Player; troops: number }[] {
  const out: { target: Player; troops: number }[] = [];
  let sent = 0;
  for (const t of byDensity.slice(0, 100)) {
    const left = troops - reserveRatio * maxTroops - sent;
    let s = 4 * t.troops();
    if (s > left) s = left < 2 * t.troops() ? 0 : left;
    s = Math.min(s, sendCap);
    if (s < 1) continue;
    if (!underAttack && s < 0.2 * t.troops()) continue;
    out.push({ target: t, troops: Math.floor(s) });
    sent += s;
  }
  return out;
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

/** Every calculateAttackTroops call a nation made on a tribe, classified. */
interface NationTribeSends {
  /** Calls where the reserve budget and the 2x rule allowed a send. */
  eligible: number;
  /** Of those, troopSendCap was below that amount. */
  capped: number;
  /** Of those, nothing was sent (cap < 1 or < 20% of the tribe's troops). */
  blocked: number;
  sent: number;
  /** Sent, but cut by troopSendCap. */
  sentCapped: number;
  sent4x: number;
  sentBelow2x: number;
  sentBelow1x: number;
}

interface RealGame {
  game: Game;
  me: Player;
  meStartTiles: number;
  spawnEnd: number;
  tribes: Player[];
  start: { tiles: number; disc: number; troops: number; gold: bigint }[];
  tribeExecs: number;
  /** TribeExecutions whose private knobs equal replayKnobs(tribe id). */
  knobsReplayed: number;
  /** Per tribe: its first decision (replayed from its id) - spawnEnd. */
  firstDecision: number[];
  /** Per tribe: the tick its first attack or boat was sent - spawnEnd (-1 never). */
  firstLaunch: number[];
  /** Per tribe: ticks after spawnEnd when it first held > 100 tiles (-1 never). */
  over100: number[];
  standings: Standing[];
  /** Attack launches by "ATTACKER->TARGET" type (a new attack id each). */
  launches: Map<string, number>;
  nationBotLand: {
    total: number;
    whileBorderingFreeLand: number;
    unscheduled: number;
  };
  nationSends: NationTribeSends;
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

/** AiAttackBehavior's private sizing methods (AiAttackBehavior.ts:986-1166). */
interface SendSizing {
  player: Player;
  calculateAttackTroops(
    target: Player | TerraNullius,
    nonBotTroops: (targetTroops: number) => number,
  ): number | null;
  calculateBotAttackTroops(target: Player, maxTroops: number): number;
  troopSendCap(): number;
}

/**
 * Observes (calls through, changes nothing) every calculateAttackTroops a
 * nation makes on a tribe, with the calculateBotAttackTroops and troopSendCap
 * values it combined. Returns the function that restores the prototype.
 */
function observeNationTribeSends(out: NationTribeSends): () => void {
  const proto = AiAttackBehavior.prototype as unknown as SendSizing;
  const orig = {
    calculateAttackTroops: proto.calculateAttackTroops,
    calculateBotAttackTroops: proto.calculateBotAttackTroops,
    troopSendCap: proto.troopSendCap,
  };
  let bot = NaN;
  let cap = NaN;
  proto.calculateBotAttackTroops = function (this: SendSizing, t, m) {
    bot = orig.calculateBotAttackTroops.call(this, t, m);
    return bot;
  };
  proto.troopSendCap = function (this: SendSizing) {
    cap = orig.troopSendCap.call(this);
    return cap;
  };
  proto.calculateAttackTroops = function (this: SendSizing, target, nonBot) {
    bot = NaN;
    cap = NaN;
    const r = orig.calculateAttackTroops.call(this, target, nonBot);
    if (
      this.player.type() === PlayerType.Nation &&
      target.isPlayer() &&
      target.type() === PlayerType.Bot &&
      bot >= 1
    ) {
      const t = target.troops();
      out.eligible++;
      if (cap < bot) out.capped++;
      if (r === null) {
        out.blocked++;
      } else {
        out.sent++;
        if (cap < bot) out.sentCapped++;
        if (r === 4 * t) out.sent4x++;
        if (r < 2 * t) out.sentBelow2x++;
        if (r < t) out.sentBelow1x++;
      }
    }
    return r;
  };
  return () => {
    Object.assign(proto, orig);
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
  const tribeExecs = execs.filter((e) => e instanceof TribeExecution);
  const actualKnobs = new Map(
    tribeExecs.map((e) => {
      const k = e as unknown as TribeKnobs & { tribe: Player };
      return [k.tribe, k] as const;
    }),
  );
  const knobs = tribes.map((t) => replayKnobs(t.id()));

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
    tribeExecs: tribeExecs.length,
    knobsReplayed: tribes.filter((t, i) => {
      const a = actualKnobs.get(t);
      const k = knobs[i];
      return (
        a !== undefined &&
        a.attackRate === k.attackRate &&
        a.attackTick === k.attackTick &&
        a.triggerRatio === k.triggerRatio &&
        a.reserveRatio === k.reserveRatio &&
        a.expandRatio === k.expandRatio
      );
    }).length,
    // TribeExecution ticks from spawnEnd on (activeDuringSpawnPhase false,
    // TribeExecution.ts:43-45; GameImpl.executeNextTick :529-536) and decides
    // when ticks % attackRate === attackTick (:52).
    firstDecision: knobs.map((k) => {
      let t = spawnEnd;
      while (t % k.attackRate !== k.attackTick) t++;
      return t - spawnEnd;
    }),
    firstLaunch: tribes.map(() => -1),
    over100: tribes.map(() => -1),
    standings: [],
    launches: new Map(),
    nationBotLand: { total: 0, whileBorderingFreeLand: 0, unscheduled: 0 },
    nationSends: {
      eligible: 0,
      capped: 0,
      blocked: 0,
      sent: 0,
      sentCapped: 0,
      sent4x: 0,
      sentBelow2x: 0,
      sentBelow1x: 0,
    },
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

  const restore = observeNationTribeSends(result.nationSends);
  try {
    while (game.ticks() < spawnEnd + 3 * MINUTE) {
      const tick = game.ticks();
      // Nations whose maybeAttack runs this tick (NationExecution.ts:200,
      // 226), and whether it sees free land (AiAttackBehavior.ts:135-141):
      // nearby() lists TerraNullius exactly when a border tile, or the far
      // bank of a <= 4-tile river, is unowned non-fallout land
      // (PlayerImpl.ts:626-690). NationExecutions tick before any attack
      // does, so this is the state the nation decides on.
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
        if (q.t.troops() - q.troops === Math.floor(q.rate)) {
          result.quiet.troops++;
        }
        if (q.t.gold() - q.gold === q.income) result.quiet.gold++;
      }

      const elapsed = game.ticks() - spawnEnd;
      if (elapsed <= 200) {
        tribes.forEach((t, i) => {
          if (
            result.firstLaunch[i] < 0 &&
            (t.outgoingAttacks().length > 0 ||
              t.units(UnitType.TransportShip).length > 0)
          ) {
            result.firstLaunch[i] = tick - spawnEnd;
          }
          if (result.over100[i] < 0 && t.numTilesOwned() > 100) {
            result.over100[i] = elapsed;
          }
        });
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
  } finally {
    restore();
  }
  return result;
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const quantile = (xs: number[], q: number) =>
  sorted(xs)[Math.floor(q * (xs.length - 1))];

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

    test("regrowth: the human formula x0.5, but on the tribe's own (a third) cap: 0.5x ours at 0 troops, 0.41x at the start, 0 at its cap, ~0.23x at the peaks", () => {
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
      // troops T and tiles the ratio is 0.5 (1 - 3T/M) / (1 - T/M), M our
      // cap: 0.5 at T = 0, falling to 0 at the tribe's cap M/3. The 0.41 is
      // one point on that curve (10,000 troops on 52 tiles).
      for (const n of [52, 1_150]) {
        const M = CONFIG.maxTroops(stub(PlayerType.Human, n));
        for (const f of [0.001, 0.05, 0.1, 0.2, 0.3]) {
          const T = f * M;
          expect(
            relErr(
              rate(PlayerType.Bot, n, T) / rate(PlayerType.Human, n, T),
              (0.5 * (1 - (3 * T) / M)) / (1 - T / M),
            ),
          ).toBeLessThan(1e-9);
        }
        expect(
          rate(PlayerType.Bot, n, 1) / rate(PlayerType.Human, n, 1),
        ).toBeCloseTo(0.5, 4);
        expect(rate(PlayerType.Bot, n, M / 3)).toBeCloseTo(0, 9);
      }
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

    test("x0.7: only the attacker's losses, only for Human and Nation attackers against a Bot; a tribe pays half on free land", () => {
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
        // A tribe gets no discount attacking a player, a tribe included.
        const humanVsHuman = CONFIG.attackLogic(
          input(PlayerType.Human, PlayerType.Human, o, traitor),
        );
        for (const defender of [PlayerType.Bot, PlayerType.Human]) {
          expect(
            CONFIG.attackLogic(input(PlayerType.Bot, defender, o, traitor)),
          ).toEqual(humanVsHuman);
        }
      }

      // On free land it is the other way round: mag / 10 a tile for a Bot,
      // mag / 5 for anyone else (Config.ts:896-900), mag = 80/100/120 on
      // plains/highland/mountain (terrainAttackBase :172-188).
      for (const [terrain, mag] of [
        [TerrainType.Plains, 80],
        [TerrainType.Highland, 100],
        [TerrainType.Mountain, 120],
      ] as const) {
        const free = (attacker: PlayerType) =>
          CONFIG.attackLogic({
            ...input(attacker, PlayerType.Human),
            terrain,
            defender: null,
          });
        expect(free(PlayerType.Bot).attackerTroopLoss).toBe(mag / 10);
        for (const other of [PlayerType.Human, PlayerType.Nation]) {
          expect(free(other).attackerTroopLoss).toBe(mag / 5);
          // Same speed: only the loss depends on the attacker's type.
          expect(free(other).tickFraction).toBe(
            free(PlayerType.Bot).tickFraction,
          );
        }

        // Against a tribe with a stack >= its troops / 0.6 (the ratio clamp,
        // Config.ts:947) the loss per tile is K x (0.463 x bonuses + 0.0039 x
        // density) with K = mag x 0.7 x 0.6: 33.6 / 42 / 50.4. The report's
        // 33.6 is plains only. K from the slope in density:
        const at = (troops: number) =>
          CONFIG.attackLogic({
            ...input(PlayerType.Human, PlayerType.Bot),
            terrain,
            attackTroops: 10_000_000,
            defender: {
              type: PlayerType.Bot,
              numTiles: 1_000,
              troops,
              isTraitor: false,
              isDisconnectedTeammate: false,
            },
          }).attackerTroopLoss;
        const K = (at(40_000) - at(20_000)) / (0.0039 * 20);
        expect(K).toBeCloseTo(mag * 0.7 * 0.6, 9);
      }

      // What eating a typical minute-1 tribe costs (1,150 tiles, 35,000
      // troops, 30.4 a tile) with a 4x stack (AiAttackBehavior.ts:
      // 1149-1166): 19.5 troops a tile, against 27.9 for the same numbers as
      // a Human or Nation defender and 16 on free plains. The tribe loses
      // its density (30.4) with every tile, so its density holds while it
      // shrinks.
      const typical = CONFIG.attackLogic(
        input(PlayerType.Human, PlayerType.Bot),
      );
      expect(typical.attackerTroopLoss).toBeCloseTo(19.54, 2);
      expect(typical.defenderTroopLoss).toBeCloseTo(35_000 / 1_150, 9);
      expect(
        CONFIG.attackLogic(input(PlayerType.Human, PlayerType.Nation))
          .attackerTroopLoss,
      ).toBeCloseTo(27.92, 2);
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
    /** Rows 0..RIVER-1 of the river field: water at NX..NX+3, free land after. */
    const RIVER = 10;
    /** An Impossible nation's cap on NX x H tiles (Config.ts:1024-1056). */
    const NATION_CAP = CONFIG.maxTroops(stub(PlayerType.Nation, NX * H));
    /** The reserve budget of a nation exactly at a 50% trigger. */
    const AT_TRIGGER = Math.ceil(TRIGGER * NATION_CAP);
    const BUDGET = AT_TRIGGER - RESERVE * NATION_CAP;

    /**
     * A nation owning the strip x < NX, with one-row tribes (x >= NX, 50
     * tiles each) along its whole border and no free land, unless asked:
     * `freeTile` leaves one tile of row 0 free; `rival` gives the last row to
     * a player of that type; `river` makes rows 0..9 water at x = NX..NX+3
     * and free land beyond, seen across the river but not bordered.
     * Tribe troops are a permutation of base..base+199, so row order is not
     * density order.
     */
    async function nationAmongTribes(
      difficulty: Difficulty,
      base: number,
      opts: {
        freeTile?: boolean;
        rival?: PlayerType.Human | PlayerType.Nation;
        river?: boolean;
        disabledUnits?: UnitType[];
      } = {},
    ) {
      const water: Water = (x, y) =>
        opts.river === true && y < RIVER && x >= NX && x < NX + 4;
      const game = await plainsGame(W, H, difficulty, [], {
        water,
        disabledUnits: opts.disabledUnits,
      });
      const nation = addPlayer(game, "NATION01", PlayerType.Nation);
      const rival =
        opts.rival === undefined
          ? null
          : addPlayer(game, "RIVAL001", opts.rival);
      const rows: (Player | null)[] = [];
      for (let y = 0; y < H; y++) {
        if (opts.river === true && y < RIVER) rows.push(null);
        else if (rival !== null && y === H - 1) rows.push(rival);
        else {
          rows.push(
            addPlayer(
              game,
              `TRIBE${String(y).padStart(3, "0")}`,
              PlayerType.Bot,
            ),
          );
        }
      }
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (opts.freeTile === true && x === NX && y === 0) continue;
          if (water(x, y)) continue;
          const owner = x < NX ? nation : rows[y];
          if (owner !== null) owner.conquer(game.ref(x, y));
        }
      }
      const tribes: Player[] = [];
      rows.forEach((p, y) => {
        if (p === null || p === rival) return;
        p.setTroops(base + ((y * 37) % H));
        tribes.push(p);
      });
      // One PRNG shared by the behaviours, as NationExecution does. With
      // this seed maybeAttack's 1-in-10 random boat branch
      // (AiAttackBehavior.ts:148-151), its first draw, is not taken.
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
      if (difficulty === Difficulty.Impossible) {
        expect(game.config().maxTroops(nation)).toBe(NATION_CAP);
      }
      return { game, nation, rival, tribes, behavior, byDensity };
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

    test("with no non-bot neighbour the reserve budget binds: 4x per tribe, the rest only if it is >= 2x, else skipped", async () => {
      // Tribes at their starting 10,000 (+0..199); the nation exactly at its
      // trigger, so the budget is (trigger - reserve) x cap = 72.8k: two
      // attacks on fresh tribes.
      {
        const { game, nation, byDensity, behavior } = await nationAmongTribes(
          Difficulty.Impossible,
          10_000,
        );
        expect(Math.round(NATION_CAP)).toBe(364_088);
        nation.setTroops(AT_TRIGGER);
        const expected = replayTribeSends(
          AT_TRIGGER,
          NATION_CAP,
          RESERVE,
          byDensity,
        );
        expect(expected.map((e) => e.troops)).toEqual([40_000, 32_818]);
        behavior.maybeAttack();
        game.executeNextTick();
        const attacks = nation.outgoingAttacks();
        expect(attacks.map((a) => a.troops())).toEqual(
          expected.map((e) => e.troops),
        );
        expect(attacks.map((a) => a.target())).toEqual(byDensity.slice(0, 2));
        // Home falls to the reserve, not below.
        expect(nation.troops() / NATION_CAP).toBeCloseTo(RESERVE, 4);
      }

      // The 2x floor itself (:1157-1163): tribes sized so the rest after the
      // first 4x attack is 2.5x the next tribe (sent) or 1.9x (skipped, and
      // every later tribe too). A 3x floor would drop the first, 1.5x would
      // send the second.
      for (const [rest, count] of [
        [2.5, 2],
        [1.9, 1],
      ] as const) {
        const base = Math.floor(BUDGET / (4 + rest));
        const { game, nation, byDensity, behavior } = await nationAmongTribes(
          Difficulty.Impossible,
          base,
        );
        nation.setTroops(AT_TRIGGER);
        const left = BUDGET - 4 * base;
        const next = byDensity[1].troops();
        expect(next).toBe(base + 1);
        if (count === 2) {
          expect(left / next).toBeGreaterThan(2);
          expect(left / next).toBeLessThan(3);
        } else {
          expect(left / next).toBeGreaterThan(1.5);
          expect(left / next).toBeLessThan(2);
        }
        const expected = replayTribeSends(
          AT_TRIGGER,
          NATION_CAP,
          RESERVE,
          byDensity,
        );
        expect(expected).toHaveLength(count);
        behavior.maybeAttack();
        game.executeNextTick();
        expect(nation.outgoingAttacks().map((a) => a.troops())).toEqual(
          expected.map((e) => e.troops),
        );
        expect(nation.outgoingAttacks()[0].troops()).toBe(4 * base);
      }
    });

    test("next to a rival (or us) troopSendCap splits the budget into small attacks, and at ~1.1x the nation's troops none are sent at all", async () => {
      // troopSendCap (AiAttackBehavior.ts:986-1032): troops - ceil(0.9 x the
      // most troops of a nearby non-friendly non-Bot player), >= 0. It reads
      // home troops, which only fall when the attacks init at the end of the
      // tick, so every attack of the pass may take the whole cap; the
      // reserve budget and the 2x floor still count down (:1064, :1091-1093).
      const counts: number[] = [];
      for (const [k, type] of [
        [0.8, PlayerType.Human],
        [0.96, PlayerType.Human],
        [1.04, PlayerType.Human],
        [1.04, PlayerType.Nation],
        [1.09, PlayerType.Human],
        [1.1, PlayerType.Human],
        [1.12, PlayerType.Human],
        [1.2, PlayerType.Nation],
      ] as const) {
        const { game, nation, rival, byDensity, behavior } =
          await nationAmongTribes(Difficulty.Impossible, 10_000, {
            rival: type,
          });
        nation.setTroops(AT_TRIGGER);
        rival!.setTroops(Math.round(k * AT_TRIGGER));
        const cap = Math.max(0, AT_TRIGGER - Math.ceil(0.9 * rival!.troops()));
        const expected = replayTribeSends(
          AT_TRIGGER,
          NATION_CAP,
          RESERVE,
          byDensity,
          cap,
        );
        behavior.maybeAttack();
        game.executeNextTick();
        const attacks = nation.outgoingAttacks();
        expect(attacks.map((a) => a.troops())).toEqual(
          expected.map((e) => e.troops),
        );
        expect(attacks.map((a) => a.target())).toEqual(
          expected.map((e) => e.target),
        );
        for (const a of attacks) expect(a.troops()).toBeLessThanOrEqual(cap);
        // Nothing else either: every player attack goes through the same cap.
        expect(rival!.incomingAttacks()).toHaveLength(0);
        counts.push(attacks.length);
      }
      // 0.8x: the cap (51k) is above 4x a tribe, no effect. 0.96x: three of
      // ~24.8k. 1.04x: five of 11.7k (a Nation rival is the same). 1.09x: 16
      // of 3.5k (0.35x a tribe). 1.1x: the cap (1,820) is under 20% of a
      // tribe, too weak. 1.12x and more: the cap is 0.
      expect(counts).toEqual([2, 3, 5, 5, 16, 0, 0, 0]);
    });

    test("under attack the cap rises to the incoming troops and the 20% floor goes: even a tribe's attack unfreezes a capped nation", async () => {
      const { game, nation, rival, byDensity, behavior } =
        await nationAmongTribes(Difficulty.Impossible, 10_000, {
          rival: PlayerType.Nation,
        });
      nation.setTroops(AT_TRIGGER);
      rival!.setTroops(Math.round(1.2 * AT_TRIGGER)); // cap 0: frozen
      // The densest tribe attacks the nation with 1,000 (below 20% of a
      // tribe's troops); it is not among the nation's targets.
      const attacker = byDensity[byDensity.length - 1];
      attacker.setTroops(50_000);
      game.addExecution(new AttackExecution(1_000, attacker, nation.id()));
      game.executeNextTick(); // init only
      expect(nation.incomingAttacks().map((a) => a.troops())).toEqual([1_000]);
      // Nations ignore tribe attackers when retaliating (:462-467), so the
      // decision goes on to attackBots, capped at max(0, 1,000) (:1024-1029)
      // with isAttackTooWeak off (:966).
      const expected = replayTribeSends(
        AT_TRIGGER,
        NATION_CAP,
        RESERVE,
        byDensity.slice(0, -1),
        1_000,
        true,
      );
      expect(expected.length).toBeGreaterThan(50);
      behavior.maybeAttack();
      game.executeNextTick();
      const onTribes = nation
        .outgoingAttacks()
        .filter((a) => a.target() !== attacker);
      expect(onTribes.map((a) => a.troops())).toEqual(
        expected.map((e) => e.troops),
      );
      expect(onTribes.every((a) => a.troops() === 1_000)).toBe(true);
    });

    test("while the nation borders any free land it sends the free-land attack and no tribe attack", async () => {
      const { game, nation, behavior } = await nationAmongTribes(
        Difficulty.Impossible,
        100,
        { freeTile: true },
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

    test("free land seen only across a river: a boat that sails returns, one that cannot falls through to the tribe attacks", async () => {
      for (const boats of [true, false]) {
        const { game, nation, byDensity, behavior } = await nationAmongTribes(
          Difficulty.Impossible,
          100,
          {
            river: true,
            disabledUnits: boats ? undefined : [UnitType.TransportShip],
          },
        );
        nation.setTroops(10_000_000);
        // nearby() sees the free bank 5 tiles out (PlayerImpl.ts:652-695);
        // no border tile touches free land (hasLandBorderWithTerraNullius,
        // AiAttackBehavior.ts:842-863), so sendAttack takes the boat path
        // (sendBoatAttackToNearbyTerraNullius :879-930).
        expect(nation.nearby().some((n) => !n.isPlayer())).toBe(true);
        behavior.maybeAttack();
        game.executeNextTick();
        const attacks = nation.outgoingAttacks();
        if (boats) {
          // The boat left (TransportShipExecution) and maybeAttack returned
          // (:139-141): no tribe attack.
          expect(nation.units(UnitType.TransportShip)).toHaveLength(1);
          expect(attacks).toHaveLength(0);
        } else {
          // sendAttack(terra nullius) failed, so maybeAttack went on to
          // attackBots although free land is in sight.
          expect(nation.units(UnitType.TransportShip)).toHaveLength(0);
          expect(attacks).toHaveLength(100);
          expect(new Set(attacks.map((a) => a.target()))).toEqual(
            new Set(byDensity.slice(0, 100)),
          );
        }
      }
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
      expect(k).toMatchObject(replayKnobs(tribe.id()));

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

    test("once a decision finds no free land the tribe never expands again: free land that opens later is ignored", async () => {
      const game = await plainsGame(100, 50);
      const tribe = addPlayer(game, "TRIBE001", PlayerType.Bot);
      const other = addPlayer(game, "TRIBE002", PlayerType.Bot);
      fill(game, tribe, 0, 50, 0, 50);
      fill(game, other, 50, 100, 0, 50);
      const k = runTribe(game, tribe);
      const cap = game.config().maxTroops(tribe);
      tribe.setTroops(Math.floor(k.triggerRatio * cap) - 1);
      decide(game, k); // builds the behaviour; its free-land attack fails
      // No free land nearby: neighborsTerraNullius latches false
      // (TribeExecution.ts:128-134); below the trigger nothing is sent.
      decide(game, k);
      expect(tribe.outgoingAttacks()).toHaveLength(0);
      // Free land opens next to the tribe, and it is full.
      tribe.relinquish(game.ref(0, 0));
      tribe.setTroops(Math.floor(game.config().maxTroops(tribe)));
      expect(tribe.nearby().some((n) => !n.isPlayer())).toBe(true);
      decide(game, k);
      // attackRandomTarget (AiAttackBehavior.ts:765-798) only attacks
      // players: the tribe neighbour, never the free tile.
      expect(tribe.outgoingAttacks().map((a) => a.target())).toEqual([other]);
      expect(game.hasOwner(game.ref(0, 0))).toBe(false);
    });

    test("with no free land they attack us only at >= triggerRatio x cap, each decision a fair coin flip for a human neighbour, sending troops - reserveRatio x cap", async () => {
      let attacked = 0;
      for (const id of TRIBE_IDS) {
        const game = await plainsGame(100, 50);
        const tribe = addPlayer(game, id, PlayerType.Bot);
        const human = addPlayer(game, "HUMANID1", PlayerType.Human);
        fill(game, tribe, 0, 50, 0, 50);
        fill(game, human, 50, 100, 0, 50);
        human.setTroops(50_000);
        const k = runTribe(game, tribe);
        const cap = game.config().maxTroops(tribe);

        // Below the trigger: nothing (AiAttackBehavior.ts:765-767).
        tribe.setTroops(Math.floor(k.triggerRatio * cap) - 1);
        decide(game, k); // builds the behaviour
        decide(game, k);
        decide(game, k);
        expect(tribe.outgoingAttacks()).toHaveLength(0);

        // At the cap: the only neighbour is a Human, skipped with chance
        // 1/2 (:784-797).
        tribe.setTroops(Math.floor(cap));
        decide(game, k);
        const attacks = tribe.outgoingAttacks();
        if (attacks.length === 0) continue;
        attacked++;
        expect(attacks).toHaveLength(1);
        expect(attacks[0].target()).toBe(human);
        expect(attacks[0].sourceTile()).toBeNull();
        expect(attacks[0].troops()).toBe(
          Math.floor(Math.floor(cap) - k.reserveRatio * cap),
        );
      }
      // A coin flip, not a certainty either way (measured 16 of 40).
      expect(attacked).toBeGreaterThan(TRIBE_IDS.length / 4);
      expect(attacked).toBeLessThan((3 * TRIBE_IDS.length) / 4);
    });

    test("a tribe neighbour is never skipped: for every tribe id, the first decision after the free-land check attacks it", async () => {
      for (const id of TRIBE_IDS) {
        const game = await plainsGame(100, 50);
        const tribe = addPlayer(game, id, PlayerType.Bot);
        const other = addPlayer(game, "TRIBE999", PlayerType.Bot);
        fill(game, tribe, 0, 50, 0, 50);
        fill(game, other, 50, 100, 0, 50);
        const k = runTribe(game, tribe);
        tribe.setTroops(Math.floor(game.config().maxTroops(tribe)));
        // Decision 1 builds the behaviour; its free-land attack finds neither
        // free land nor a shore to boat from (TribeExecution.ts:60-73).
        decide(game, k);
        expect(tribe.outgoingAttacks()).toHaveLength(0);
        // Decision 2: attackRandomTarget, no coin flip for a tribe.
        decide(game, k);
        expect(tribe.outgoingAttacks().map((a) => a.target())).toEqual([other]);
      }
    });

    test("they retaliate: for every tribe id, a small attack on a tribe at >= its trigger is answered at its next decision, not its tribe neighbour attacked, and cancelled 1:1", async () => {
      const CLIENT = "AGENTCL1";
      for (const id of TRIBE_IDS) {
        const game = await plainsGame(150, 50, Difficulty.Impossible, [
          new PlayerInfo("agent", PlayerType.Human, CLIENT, "AGENTID1"),
        ]);
        const human = game.player("AGENTID1");
        const tribe = addPlayer(game, id, PlayerType.Bot);
        // A second neighbour that is never skipped (see above): without
        // retaliation the decision's random pick lands on it about half the
        // time.
        const other = addPlayer(game, "TRIBE999", PlayerType.Bot);
        fill(game, other, 0, 50, 0, 50);
        fill(game, tribe, 50, 100, 0, 50);
        fill(game, human, 100, 150, 0, 50);
        human.setTroops(50_000);
        const k = runTribe(game, tribe);
        const cap = game.config().maxTroops(tribe);
        tribe.setTroops(Math.floor(cap));
        decide(game, k); // decision 1 builds the behaviour only
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
        // attackRandomTarget answers it before any random pick (:769-773),
        // sized troops - reserve x cap. Our attack then takes its first tile,
        // paying `loss`. At the end of the tick the answer inits and cancels
        // ours (AttackExecution.ts:157-170).
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
        expect(counter.map((a) => a.target())).toEqual([human]);
        expect(counter[0].troops()).toBeCloseTo(R - (1_000 - loss), 6);
        expect(human.incomingAttacks()).toEqual(counter);
        expect(other.incomingAttacks()).toHaveLength(0);
        expect(human.troops()).toBe(49_000); // nothing comes back
      }
    });

    test("any attack that takes one tile ends a player left under 100 tiles: the cost is min(stack, that tile's loss)", async () => {
      const CLIENT = "AGENTCL1";
      /** A human (x < 20, 1,600 tiles) and tribes of these sizes along x = 20..21. */
      async function field(sizes: number[], humanTroops: number) {
        const game = await plainsGame(60, 80, Difficulty.Impossible, [
          new PlayerInfo("agent", PlayerType.Human, CLIENT, "AGENTID1"),
        ]);
        const human = game.player("AGENTID1");
        fill(game, human, 0, 20, 0, 80);
        human.setTroops(humanTroops);
        let y0 = 0;
        const tribes = sizes.map((n, i) => {
          const t = addPlayer(game, `TRIBE00${i + 1}`, PlayerType.Bot);
          for (let j = 0; j < n; j++) {
            t.conquer(game.ref(20 + (j % 2), y0 + Math.floor(j / 2)));
          }
          y0 += Math.ceil(n / 2);
          return t;
        });
        const attack = (t: Player, troops: number) =>
          game.addExecution(
            new Executor(game, "game", undefined).createExec({
              type: "attack",
              targetID: t.id(),
              troops,
              clientID: CLIENT,
            }),
          );
        return { game, human, tribes, attack };
      }
      // The first tile's loss, from attackLogic on the live stack.
      const lossAt = (attackTroops: number) =>
        CONFIG.attackLogic({
          terrain: TerrainType.Plains,
          attackTroops,
          attacker: { type: PlayerType.Human, numTiles: 1_600 },
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
      // 135.9 up to a stack of 5,000 (the ratio clamp at 2, Config.ts:947),
      // 40.8 from 10,000 / 0.6 up (the clamp at 0.6).
      expect(lossAt(1)).toBeCloseTo(135.9, 1);
      expect(lossAt(5_000)).toBeCloseTo(135.9, 1);
      expect(lossAt(16_667)).toBeCloseTo(40.8, 1);

      // AttackExecution.tick checks troopCount < 1 only before each tile
      // (:296-300), so the first tile is taken whatever it costs; then
      // handleDeadDefender (:448-482) conquers a target left under 100
      // tiles. A stack left under 1 troop is deleted, nothing refunded
      // (:296-300); a bigger one finds nothing left and retreats with the
      // rest (:302-306). So the cost is the stack, up to one tile's loss.
      for (const stack of [1, 10, 50, 100, 1_000, 5_000, 20_000]) {
        const { game, human, tribes, attack } = await field([52], 100_000);
        tribes[0].addGold(12_345n);
        // Tribes are never immune (PlayerImpl.ts:1907-1915).
        expect(game.isSpawnImmunityActive()).toBe(true);
        expect(tribes[0].isImmune()).toBe(false);
        expect(tribes[0].troops()).toBe(10_000);
        attack(tribes[0], stack);
        for (let i = 0; i < 3; i++) game.executeNextTick();
        expect(tribes[0].isAlive()).toBe(false);
        expect(human.numTilesOwned()).toBe(1_600 + 52);
        // All of a tribe's gold (GameImpl.conquerPlayer, Config.ts:735-744).
        expect(human.gold()).toBe(12_345n);
        expect(human.outgoingAttacks()).toHaveLength(0);
        const left = stack - lossAt(stack);
        const cost = left >= 1 ? stack - Math.floor(left) : stack;
        expect(human.troops()).toBe(100_000 - cost);
        if (stack <= 100) expect(cost).toBe(stack);
        else expect(cost).toBe(Math.ceil(lossAt(stack)));
      }

      // The threshold is < 100 after the tile: one troop takes a 100-tile
      // tribe whole, but only one tile of a 101-tile one.
      for (const [n, dies] of [
        [100, true],
        [101, false],
      ] as const) {
        const { game, human, tribes, attack } = await field([n], 100_000);
        attack(tribes[0], 1);
        for (let i = 0; i < 3; i++) game.executeNextTick();
        expect(tribes[0].isAlive()).toBe(!dies);
        expect(tribes[0].numTilesOwned()).toBe(dies ? 0 : 100);
        expect(human.numTilesOwned()).toBe(1_600 + (dies ? n : 1));
        expect(human.troops()).toBe(100_000 - 1);
        expect(human.outgoingAttacks()).toHaveLength(0);
      }

      // Several at once: every stack is paid at init (AttackExecution.ts:
      // 133-140), before any refund. From 25,000, three attacks of 16,667
      // start with 16,667, 8,333 and 0, and the third tribe survives; three
      // attacks of 1 troop take all three for 3 troops.
      {
        const { game, human, tribes, attack } = await field(
          [52, 52, 52],
          25_000,
        );
        for (const t of tribes) attack(t, 16_667);
        game.executeNextTick();
        expect(human.outgoingAttacks().map((a) => a.troops())).toEqual([
          16_667, 8_333, 0,
        ]);
        for (let i = 0; i < 3; i++) game.executeNextTick();
        expect(tribes.map((t) => t.isAlive())).toEqual([false, false, true]);
        expect(tribes[2].numTilesOwned()).toBe(52);
      }
      {
        const { game, human, tribes, attack } = await field(
          [52, 52, 52],
          25_000,
        );
        for (const t of tribes) attack(t, 1);
        for (let i = 0; i < 3; i++) game.executeNextTick();
        expect(tribes.every((t) => !t.isAlive())).toBe(true);
        expect(human.numTilesOwned()).toBe(1_600 + 3 * 52);
        expect(human.troops()).toBe(25_000 - 3);
      }
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
      // are gone. Tribes ignore our spawn immunity (PlayerImpl.ts:1917-1926).
      const g2 = await plainsGame(60, 60);
      const t2 = addPlayer(g2, "TRIBE001", PlayerType.Bot);
      const h2 = addPlayer(g2, "HUMANID1", PlayerType.Human);
      fill(g2, t2, 0, 20, 0, 60);
      fill(g2, h2, 20, 22, 0, 26); // 52 tiles
      h2.setTroops(25_000);
      t2.setTroops(30_000);
      expect(g2.isSpawnImmunityActive()).toBe(true);
      g2.addExecution(new AttackExecution(1, t2, h2.id()));
      for (let i = 0; i < 3; i++) g2.executeNextTick();
      expect(h2.isAlive()).toBe(false);
      expect(t2.numTilesOwned()).toBe(1_200 + 52);
      expect(t2.troops()).toBe(30_000 - 1);
    });
  });

  describe("a real 3-minute game (Pangaea, arena setting, an idle human)", () => {
    // Pangaea: all land, 29 nations, one of the faster maps to simulate
    // (~7 s for 1,800 ticks here; World takes ~13 s).
    let real: RealGame;
    beforeAll(async () => {
      real = await playRealGame(GameMapType.Pangaea);
      // 180 s: the 1,800-tick game blew a 60 s hook under load 27 on 4 cores.
    }, 180_000);

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

    test("each tribe's first decision replays from its id, 0 to attackRate - 1 ticks after the phase; it passes 100 tiles about 5 ticks later", () => {
      const n = real.tribes.length;
      // Every TribeExecution's private knobs equal the replay from the id.
      expect(real.knobsReplayed).toBe(n);
      real.tribes.forEach((t, i) => {
        const k = replayKnobs(t.id());
        expect(real.firstDecision[i]).toBeGreaterThanOrEqual(0);
        expect(real.firstDecision[i]).toBeLessThan(k.attackRate);
      });
      // Measured 0..76, median 31: not "40-79 ticks".
      expect(Math.min(...real.firstDecision)).toBe(0);
      expect(quantile(real.firstDecision, 0.5)).toBeGreaterThan(20);
      expect(quantile(real.firstDecision, 0.5)).toBeLessThan(45);

      // No tribe launches before its predicted first decision, and all but
      // a few launch exactly then (measured 398 of 400; one sent nothing
      // then, one launched later).
      const pairs = real.firstLaunch.map((l, i) => [l, real.firstDecision[i]]);
      expect(pairs.filter(([l, d]) => l >= 0 && l < d)).toHaveLength(0);
      expect(pairs.filter(([l, d]) => l === d).length).toBeGreaterThan(n - 5);

      // The one-troop annex window (see the synthetic tests) is open while
      // a tribe holds <= 100 tiles. Measured: 398 tribes passed 100 tiles,
      // 7 to 84 ticks after the phase ended (10% by 14, 25% by 22, median
      // 37), 5 to 67 ticks after their own first decision (median 6).
      const over = real.over100.filter((v) => v >= 0);
      expect(over.length).toBeGreaterThan(n - 10);
      expect(Math.min(...over)).toBeGreaterThanOrEqual(5);
      expect(quantile(over, 0.1)).toBeLessThan(20);
      expect(quantile(over, 0.5)).toBeGreaterThan(25);
      expect(quantile(over, 0.5)).toBeLessThan(50);
      expect(Math.max(...over)).toBeLessThan(120);
      const lead = real.over100
        .map((v, i) => v - real.firstDecision[i])
        .filter((_, i) => real.over100[i] >= 0);
      expect(Math.min(...lead)).toBeGreaterThanOrEqual(3);
      expect(quantile(lead, 0.5)).toBeLessThanOrEqual(8);
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

    test("nations attack tribes only from a border without free land (observed, not a rule), never near 100 at once", () => {
      const nb = real.nationBotLand;
      expect(nb.total).toBeGreaterThan(100); // measured 630
      expect(nb.unscheduled).toBe(0);
      // Observed 0. Not guaranteed: free land seen only across a river
      // falls through to the tribe attacks when the boat fails (synthetic
      // test above).
      expect(nb.whileBorderingFreeLand).toBe(0);
      // Free land still existed elsewhere when the first one came (tick 217,
      // 1.5% of the map): "free land runs out" is per nation.
      expect(real.freeShareAtFirstNationBot).toBeGreaterThan(0.005);
      expect(real.firstNationBotTick).toBeGreaterThan(real.spawnEnd + 100);
      // Measured 11 tribes at once, at most, for any nation.
      expect(real.peakNationBotParallel).toBeGreaterThan(1);
      expect(real.peakNationBotParallel).toBeLessThan(25);
    });

    test("in the real game troopSendCap, not the 4x/2x rule, sizes most nation attacks on tribes", () => {
      const s = real.nationSends;
      // Measured: 1,292 calls where the reserve budget and the 2x rule
      // allowed a send; the cap or the 20% floor then killed 623; of the
      // 669 sent, the cap cut 449 (67%), 311 were under 2x the tribe's
      // troops, 171 under 1x, and only 132 (20%) were the full 4x.
      expect(s.sent).toBeGreaterThan(300);
      expect(s.eligible).toBe(s.sent + s.blocked);
      expect(s.blocked / s.eligible).toBeGreaterThan(0.3);
      expect(s.sentCapped / s.sent).toBeGreaterThan(0.5);
      expect(s.sentBelow2x / s.sent).toBeGreaterThan(0.3);
      expect(s.sentBelow1x / s.sent).toBeGreaterThan(0.15);
      expect(s.sent4x / s.sent).toBeLessThan(0.35);
      // Every send that was not capped is the 4x/2x amount, so "under 2x"
      // is always the cap's doing.
      expect(s.sentBelow2x).toBeLessThanOrEqual(s.sentCapped);
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

    test("the opening lever on the real map: spawn touching a fresh tribe, a 1-troop attack on the first tick, and all 52 of its tiles are ours for 1 troop", async () => {
      const { game, me, step } = await arenaSim(GameMapType.Pangaea);
      step();
      step();
      step(); // tribes landed in tick 1, nations in tick 2
      // Tribes spawn >= 30 apart (Manhattan, SpawnExecution.getSpawn
      // :166-184, minDistanceBetweenPlayers Config.ts:823-825, relaxed only
      // after 750 tries). One spawn disc can touch two tribes only if their
      // centres are <= 22 apart (a brute force over the 52-tile disc shape),
      // so no spawn touches two fresh tribes here:
      const tribes = game
        .allPlayers()
        .filter((p) => p.type() === PlayerType.Bot);
      let closest = Infinity;
      for (const a of tribes) {
        for (const b of tribes) {
          if (a === b) continue;
          const d = game.manhattanDist(a.spawnTile()!, b.spawnTile()!);
          if (d < closest) closest = d;
        }
      }
      expect(closest).toBeGreaterThan(22);

      // The first tribe (in player order) on a full disc with free land in
      // the 8x8 box 8 tiles to its east: our disc there shares its east
      // face, the four full-width rows y-2..y+1 (GameMap.ts:715-735).
      const free = (x: number, y: number) => {
        if (!game.isValidCoord(x, y)) return false;
        const t = game.ref(x, y);
        return game.isLand(t) && !game.isImpassable(t) && !game.hasOwner(t);
      };
      const tribe = tribes.find((t) => {
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

      const T0 = me.troops();
      const regrowth = Math.floor(game.config().troopIncreaseRate(me));
      step([{ type: "attack", targetID: tribe.id(), troops: 1 }]);
      // One troop left home at init (AttackExecution.ts:133-140), after
      // this tick's regrowth (PlayerExecution.ts:97-98).
      expect(me.outgoingAttacks().map((a) => a.troops())).toEqual([1]);
      expect(me.troops()).toBe(T0 + regrowth - 1);
      step(); // its first tile, and with it the whole tribe
      expect(tribe.isAlive()).toBe(false);
      expect(me.numTilesOwned()).toBe(104);
      step(); // the spent stack is deleted, nothing refunded
      expect(me.outgoingAttacks()).toHaveLength(0);
      expect(me.troops()).toBeGreaterThan(T0);
    });
  });
});
