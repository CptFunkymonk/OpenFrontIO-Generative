/**
 * Pins roadmap H7 (docs/11-roadmap.md §11.3; the risk table asks for every
 * mechanic an agent relies on to be pinned here).
 *
 * The claim under test ("EconomyGold"): gold income is a flat 100 per tick
 * plus trade; one city level adds 250,000 to the troop cap; the first
 * 125,000 gold arrives near tick 1,250; Port and Factory share a cost ladder;
 * attacking a nation makes it embargo us for 5 minutes (AttackExecution.init).
 *
 * VERDICT PARTIAL. The rules (the code is the spec;
 * src/core/configuration/Config.ts unless named):
 *
 * - Income: TRUE for wages, but "plus trade" leaves out the larger early
 *   source, conquest. goldAdditionRate (:1092-1101) is 100 for a Human or a
 *   Nation, 50 for a tribe (Bot), times goldMultiplier (1; the arena sets
 *   none, :436-438). No tiles, no difficulty, no cities: an Impossible nation
 *   earns exactly our 100. PlayerExecution.tick pays it every tick
 *   (src/core/execution/PlayerExecution.ts:95-100), never in the spawn phase
 *   (:44-46). Starting gold is 0 for all (startingGold :439-444, 746-753).
 *   Other income: trade ships pay tradeShipGold(distance) (:516-521) to BOTH
 *   port owners (TradeShipExecution.ts:184-222), trains (TrainStation.ts:
 *   30-45), and conquest: the conqueror takes ALL of a tribe's or nation's
 *   gold, half a human's, nothing from a human who never attacked
 *   (GameImpl.conquerPlayer :1540-1596, conquerGoldAmount :735-744). A tribe
 *   banks 50 a tick and never spends, so one taken t ticks after the phase
 *   carries ~50 t. A player under 100 tiles is "conquered", gold and all, by
 *   every tile it loses, even if some of its land survives
 *   (AttackExecution.handleDeadDefender, AttackExecution.ts:448-482).
 * - Troop cap: TRUE for us. maxTroops (:1024-1053) is
 *   2 (tiles^0.6 x 1000 + 50,000) + (sum of FINISHED city levels) x
 *   cityTroopIncrease() = 250,000 (:358-360); a city under construction adds
 *   nothing. The whole sum is x1.25 for an Impossible nation (312,500 per
 *   city level), x0.5/0.75/1 at Easy/Medium/Hard, /3 for a tribe. One level
 *   equals 3,125 tiles of cap at 0 tiles, 5,175 at 1,000 (the claim's
 *   "~5,100 tiles mid-game"), 9,604 at 10,000.
 * - First 125,000 near tick 1,250: TRUE for our wages, FALSE as the pace of
 *   the game. Our idle gold in the arena game below is exactly
 *   100 x (ticks since the phase ended) every tick, so the first City (or
 *   Port) is affordable at spawnEnd + 1,250 = tick 1,255. But Impossible
 *   nations eat tribes and pocket their gold: 71 of 72 nations had bought a
 *   City by tick 1,305, 67 of them before our tick 1,255, the first at tick
 *   471, half by 657; every first purchase was a City. Their 370 conquests
 *   in those 130 s paid 12.65M against 9.36M of wages; no trade or train
 *   gold yet. Their wage, every tick, was exactly 100.
 * - Cost ladders: TRUE that Port and Factory share one. costWrapper
 *   (:755-773) counts, over the listed types, min(unitsOwned,
 *   unitsConstructed) (PlayerImpl.ts:520-567): levels of finished units plus
 *   1 per unit under construction, capped by the builds and upgrades ever
 *   paid for. So a lost structure makes the next one cheaper and a captured
 *   one does not raise the price. unitInfo (:564-702):
 *     City         min(1M, 2^n x 125k): 125k, 250k, 500k, 1M, 1M (:670-679)
 *     Port/Factory the same, n = Ports + Factories (:597-607, :680-690)
 *     DefensePost  min(250k, (n+1) x 50k): 50k .. 250k             (:648-656)
 *     SAMLauncher  min(3M, (n+1) x 1.5M): 1.5M, 3M, 3M             (:657-668)
 *     MissileSilo  1M flat                                          (:641-647)
 *     Warship min(1M, (n+1) x 250k); AtomBomb 750k; HydrogenBomb 5M; MIRV
 *     25M + 15M per MIRV anyone launched (:577-630).
 *   An upgrade (UpgradeStructureExecution.init, PlayerImpl.upgradeUnit
 *   :1496-1501) costs the next step of the same ladder and is instant; a
 *   unit under construction cannot be upgraded (:1470-1494).
 * - Build times (constructionDuration, ticks): City 20, Factory 20, Port 50,
 *   DefensePost 50, MissileSilo 100, SAMLauncher 300 (SAM_CONSTRUCTION_TICKS
 *   :204). ConstructionExecution (src/core/execution/ConstructionExecution.ts
 *   :55-108) takes the price current at its first tick, the tick after the
 *   intent's, after that tick's wages; the structure is done duration + 2
 *   ticks after the intent's tick. Short of gold then, the build is dropped
 *   without a trace (:67-72).
 * - Embargo: TRUE that it lasts 5 minutes, but it is wider. AttackExecution
 *   .init (AttackExecution.ts:113-122) makes the TARGET embargo the attacker
 *   (temporary) whenever neither is a tribe: a nation we attack embargoes us,
 *   and we embargo a nation that attacks us (which costs us 20 points with
 *   it, NationExecution.ts:313-334). It is set before the attack is checked
 *   (:124-127), so an attack refused by spawn immunity (the first 50 ticks,
 *   :189, GameImpl.ts:959-975) still costs the embargo. canTrade is false if
 *   either side embargoes the other (PlayerImpl.ts:1228-1232): no trade ships
 *   between us (PortExecution.tradingPorts :107-117), ships already sailing
 *   sink (TradeShipExecution.ts:101-108), no train gold (TrainStation.ts:
 *   81-84). temporaryEmbargoDuration() = 3,000 (:820-822); the target's
 *   PlayerExecution lifts it once ticks - createdAt > 3,000
 *   (PlayerExecution.ts:111-119): 3,001 ticks, restarted by every new attack
 *   (PlayerImpl.addEmbargo :1238-1254). At Impossible the attack also puts
 *   the nation's relation to us at -100 (AttackExecution.ts:188-210),
 *   Hostile (< -50, PlayerImpl.ts:946-957) for ~1,000 ticks as it decays
 *   0.05 a tick (:978-988). The trap: a nation Hostile to us with NO
 *   embargo in place embargoes us PERMANENTLY at its next decision, and an
 *   Impossible nation never lifts it (Hard lifts at Friendly, Easy/Medium at
 *   Neutral; NationExecution.handleEmbargoesToHostileNations :336-382). An
 *   attack alone does not trigger it (its embargo outlives the hostility),
 *   but -100 with no attack does: a nuke on it (NukeExecution.ts:194), a
 *   broken alliance (BreakAllianceExecution.ts:46), the middle-finger emoji
 *   (NationEmojiBehavior.ts:330). An alliance ends a temporary embargo only
 *   on the crossing-requests path (AllianceRequestExecution.ts:45-62), not
 *   when a nation accepts our request (NationAllianceBehavior.ts:72).
 *
 * Setting: the real Config everywhere (not TestConfig). The pure tests call
 * Config as createGameRunner builds it (GameRunner.ts:46) from the arena's
 * own GameStartInfo (ArenaGame.arenaGameStart). The synthetic scenarios use
 * tests/util/Setup.ts's setup() with ConfigClass = Config and the arena's
 * game config (bots only matter to GameRunner, which setup does not use) on
 * the plains and half_land_half_ocean test maps, and add only the executions
 * they need; they set gold, troops, tiles and relations, which only tests may
 * do. The real game is built exactly as the arena builds it (arenaGameStart
 * into createGameRunner, NodeMapLoader on resources/maps): World, FFA
 * singleplayer, Impossible, default nations, 400 tribes, Normal size, with
 * one idle human that spawns on a fixed free site and then sends nothing.
 *
 * Tick bookkeeping: an execution added before executeNextTick of tick t is
 * init()ed at the end of tick t and first tick()ed in tick t + 1; after tick
 * t has run, game.ticks() === t + 1 (GameImpl.ts:526-582).
 */
import path from "path";
import {
  arenaGameStart,
  seatClientID,
  type ArenaGameSpec,
} from "../../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../../src/agent/arena/NodeMapLoader";
import {
  Config,
  SAM_CONSTRUCTION_TICKS,
} from "../../../src/core/configuration/Config";
import { pow } from "../../../src/core/DetMath";
import { AllianceRequestExecution } from "../../../src/core/execution/alliance/AllianceRequestExecution";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { ConstructionExecution } from "../../../src/core/execution/ConstructionExecution";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import { PortExecution } from "../../../src/core/execution/PortExecution";
import { UpgradeStructureExecution } from "../../../src/core/execution/UpgradeStructureExecution";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameType,
  Nation,
  Player,
  PlayerInfo,
  PlayerType,
  Relation,
  Unit,
  UnitType,
} from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import {
  DisplayMessageUpdate,
  GameUpdateType,
} from "../../../src/core/game/GameUpdates";
import { createGameRunner } from "../../../src/core/GameRunner";
import { GameConfig, GameStartInfo, Intent } from "../../../src/core/Schemas";
import { GOLD_INDEX_WORK } from "../../../src/core/StatsSchemas";
import { setup } from "../../util/Setup";

const MAPS = path.join(__dirname, "../../../resources/maps");

/** The arena's setting (Arena.ts:284-292, ArenaGame.arenaGameStart). */
const SPEC: Pick<
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
  gameID: "GOLDPIN1",
  map: GameMapType.World,
  mapSize: GameMapSize.Normal,
  gameType: GameType.Singleplayer,
  difficulty: Difficulty.Impossible,
  nations: "default",
  bots: 400,
  seats: [{ agent: "idle" }],
};
const START: GameStartInfo = arenaGameStart(SPEC as ArenaGameSpec);
const ARENA_CONFIG: GameConfig = START.config;

/** The config createGameRunner builds (GameRunner.ts:46). */
const configAt = (difficulty: Difficulty = Difficulty.Impossible) =>
  new Config({ ...ARENA_CONFIG, difficulty }, null, false, START.listed);
const CONFIG = configAt();

const ALL_DIFFICULTIES = [
  Difficulty.Easy,
  Difficulty.Medium,
  Difficulty.Hard,
  Difficulty.Impossible,
];

// ---------------------------------------------------------------------------
// Stubs with just the fields the Config functions read.

interface StubCity {
  level: number;
  building?: boolean;
}

/** For goldAdditionRate / maxTroops (Config.ts:1024-1101). */
function stub(type: PlayerType, tiles: number, cities: StubCity[] = []) {
  return {
    type: () => type,
    numTilesOwned: () => tiles,
    troops: () => 0,
    isLobbyCreator: () => false,
    units: (t: UnitType) =>
      t === UnitType.City
        ? cities.map((c) => ({
            isUnderConstruction: () => c.building === true,
            level: () => c.level,
          }))
        : [],
  } as unknown as Player;
}

type Counts = Partial<Record<UnitType, number>>;

/** For costWrapper (Config.ts:755-773): owned counts levels, built counts purchases. */
function buyer(owned: Counts, built: Counts = owned): Player {
  return {
    type: () => PlayerType.Human,
    isLobbyCreator: () => false,
    unitsOwned: (t: UnitType) => owned[t] ?? 0,
    unitsConstructed: (t: UnitType) => built[t] ?? 0,
  } as unknown as Player;
}

const NO_GAME = { mirvsLaunched: () => 0 } as unknown as Game;

const cost = (
  type: UnitType,
  p: Player,
  game: Game = NO_GAME,
  extra = 0,
): number => Number(CONFIG.unitInfo(type).cost(game, p, extra));

/** The first `k` prices of `type`, each bought after the previous ones. */
function ladder(type: UnitType, k: number): number[] {
  const out: number[] = [];
  for (let n = 0; n < k; n++) out.push(cost(type, buyer({ [type]: n })));
  return out;
}

// ---------------------------------------------------------------------------
// Synthetic games: the test maps, the real Config, the arena's game config.

async function testGame(
  map: "plains" | "half_land_half_ocean",
  difficulty: Difficulty = Difficulty.Impossible,
): Promise<Game> {
  // setup(map, gameConfig, humans, currentDir, ConfigClass) ends the spawn
  // phase at tick 0 (tests/util/Setup.ts:80-81).
  return setup(map, { ...ARENA_CONFIG, difficulty }, [], undefined, Config);
}

const addPlayer = (game: Game, id: string, type: PlayerType) =>
  game.addPlayer(new PlayerInfo(id, type, null, id));

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

/** Runs ticks until game.ticks() reaches `tick`. */
function runTo(game: Game, tick: number) {
  while (game.ticks() < tick) game.executeNextTick();
}

/** Raw relation value (PlayerImpl.relations, read only). */
const relationValue = (of: Player, to: Player): number =>
  (of as unknown as { relations: Map<Player, number> }).relations.get(to) ?? 0;

interface Build {
  unit: Unit;
  /** Gold taken in the tick the unit appeared (no income in these games). */
  charged: bigint;
  /** Price the ladder quoted just before the intent's tick. */
  quoted: bigint;
  /** Ticks from the intent's tick to the tick in which the unit was finished. */
  ticksToFinish: number;
  /** Ticks the unit spent under construction. */
  ticksUnderConstruction: number;
}

/** A build as a build_unit intent makes it (ExecutionManager.ts:111-122). */
function build(game: Game, p: Player, type: UnitType, tile: TileRef): Build {
  const quoted = game.unitInfo(type).cost(game, p);
  const before = new Set(p.units(type));
  const intentTick = game.ticks();
  game.addExecution(new ConstructionExecution(p, type, tile));
  let unit: Unit | undefined;
  let charged = 0n;
  let under = 0;
  for (let i = 0; i < 1000; i++) {
    const gold = p.gold();
    game.executeNextTick();
    if (unit === undefined) {
      unit = p.units(type).find((u) => !before.has(u));
      if (unit !== undefined) charged = gold - p.gold();
    }
    if (unit !== undefined) {
      if (!unit.isUnderConstruction()) {
        return {
          unit,
          charged,
          quoted,
          // executeNextTick ran tick game.ticks() - 1 (GameImpl.ts:582).
          ticksToFinish: game.ticks() - 1 - intentTick,
          ticksUnderConstruction: under,
        };
      }
      under++;
    }
  }
  throw new Error(`${type} never finished`);
}

// ---------------------------------------------------------------------------
// The real game: built exactly as the arena builds it.

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

const COST_TYPES = Object.values(UnitType) as UnitType[];
const CONQUEST_GOLD = "events_display.received_gold_from_conquest";

interface NationBook {
  gold: bigint;
  earned: bigint;
  other: bigint;
  built: number[];
}

interface RealGame {
  spawnEnd: number;
  /** Ticks at which our gold was not 100 x (ticks - spawnEnd). */
  meOff: number[];
  meGoldAt1250: bigint;
  cityPriceAt1250: bigint;
  portPriceAt1250: bigint;
  meWorkStat: bigint;
  meGoldEnd: bigint;
  meAlive: boolean;
  nations: number;
  nationTicks: number;
  /** Nation-ticks whose income, minus trade/train/piracy, was not 100 (+ loot). */
  incomeOff: string[];
  /** Nation-ticks with loot from players conquered that tick, and its total. */
  conquestTicks: number;
  conquestGold: bigint;
  /** Nation-ticks whose spending was not the ladder price of what they bought. */
  spendOff: string[];
  /** Nation-ticks where a nation that stayed alive had its gold taken. */
  lootedAlive: number;
  /** Trade, train and piracy gold of all nations together. */
  nationTradeGold: bigint;
  firstBuild: Map<Player, { tick: number; types: UnitType[] }>;
}

async function playRealGame(ticksAfterSpawn: number): Promise<RealGame> {
  // Conquest gold this tick by conqueror smallID and by conquered name, from
  // the message GameImpl.conquerPlayer shows the conqueror
  // (GameImpl.ts:1576-1592).
  const loot = new Map<number, bigint>();
  const lost = new Map<string, bigint>();
  const runner = await createGameRunner(
    START,
    undefined,
    new NodeMapLoader(MAPS),
    (gu) => {
      if ("errMsg" in gu) throw new Error(gu.errMsg);
      const shown = gu.updates[GameUpdateType.DisplayEvent];
      for (const u of shown as DisplayMessageUpdate[]) {
        if (u.message !== CONQUEST_GOLD || u.playerID === null) continue;
        loot.set(u.playerID, (loot.get(u.playerID) ?? 0n) + u.goldAmount!);
        const name = String(u.params!.name);
        lost.set(name, (lost.get(name) ?? 0n) + u.goldAmount!);
      }
    },
  );
  const game = runner.game;
  const ME = seatClientID(0);
  const me = game.playerByClientID(ME);
  if (me === null) throw new Error("no seat player");
  const step = (intents: Intent[] = []) => {
    runner.addTurn({
      turnNumber: game.ticks(),
      intents: intents.map((i) => ({ ...i, clientID: ME })),
    });
    if (!runner.executeNextTick()) throw new Error("tick failed");
  };

  // Tick 0 inits the tribes' SpawnExecutions, tick 1 lands them, tick 2 the
  // nations (SpawnPhaseSingleplayer.test.ts). Then we spawn and do nothing.
  step();
  step();
  step();
  step([{ type: "spawn", tile: freeInlandSite(game) }]);
  step(); // our spawn lands and ends the phase (SpawnExecution.ts:121-128)
  if (game.inSpawnPhase()) throw new Error("spawn phase did not end");
  const spawnEnd = game.ticks();

  const nations = game
    .allPlayers()
    .filter((p) => p.type() === PlayerType.Nation);
  const out: RealGame = {
    spawnEnd,
    meOff: [],
    meGoldAt1250: -1n,
    cityPriceAt1250: -1n,
    portPriceAt1250: -1n,
    meWorkStat: -1n,
    meGoldEnd: -1n,
    meAlive: false,
    nations: nations.length,
    nationTicks: 0,
    incomeOff: [],
    conquestTicks: 0,
    conquestGold: 0n,
    spendOff: [],
    lootedAlive: 0,
    nationTradeGold: 0n,
    firstBuild: new Map(),
  };
  if (me.gold() !== 0n) out.meOff.push(spawnEnd);

  const book = (n: Player): NationBook => ({
    gold: n.gold(),
    earned: n.goldEarned(),
    other: n.tradeGold() + n.trainGold() + n.piracyGold(),
    built: COST_TYPES.map((t) => n.unitsConstructed(t)),
  });

  while (game.ticks() < spawnEnd + ticksAfterSpawn) {
    const before = new Map(
      nations.filter((n) => n.isAlive()).map((n) => [n, book(n)]),
    );
    // What each purchase would cost now, for the 1st and 2nd of a type.
    const prices = new Map(
      [...before.keys()].map((n) => [
        n,
        COST_TYPES.map((t) => [
          game.unitInfo(t).cost(game, n, 0),
          game.unitInfo(t).cost(game, n, 1),
        ]),
      ]),
    );
    loot.clear();
    lost.clear();
    step();
    const tick = game.ticks();

    if (me.gold() !== 100n * BigInt(tick - spawnEnd)) out.meOff.push(tick);
    if (tick === spawnEnd + 1250) {
      out.meGoldAt1250 = me.gold();
      out.cityPriceAt1250 = game.unitInfo(UnitType.City).cost(game, me);
      out.portPriceAt1250 = game.unitInfo(UnitType.Port).cost(game, me);
    }

    for (const [n, b] of before) {
      if (!n.isAlive()) continue;
      out.nationTicks++;
      const a = book(n);
      const income = a.earned - b.earned - (a.other - b.other);
      out.nationTradeGold += a.other - b.other;
      const conquest = loot.get(n.smallID()) ?? 0n;
      if (conquest > 0n) {
        out.conquestTicks++;
        out.conquestGold += conquest;
      }
      if (income !== 100n + conquest) {
        out.incomeOff.push(`${n.name()}@${tick}: ${income} (${conquest})`);
      }
      // A player under 100 tiles is "conquered" by every tile it loses, and
      // stripped of its gold, even when some of its land survives
      // (AttackExecution.handleDeadDefender, AttackExecution.ts:448-482).
      const taken = lost.get(n.displayName()) ?? 0n;
      if (taken > 0n) out.lootedAlive++;
      const spent = a.earned - b.earned - (a.gold - b.gold) - taken;
      const p = prices.get(n)!;
      let price = 0n;
      const types: UnitType[] = [];
      COST_TYPES.forEach((t, i) => {
        const k = a.built[i] - b.built[i];
        if (k > 0) types.push(t);
        for (let j = 0; j < k; j++) price += p[i][Math.min(j, 1)];
      });
      if (spent !== price) {
        out.spendOff.push(`${n.name()}@${tick}: spent ${spent} for ${price}`);
      }
      if (price > 0n && !out.firstBuild.has(n)) {
        out.firstBuild.set(n, { tick, types });
      }
    }
  }
  out.meWorkStat =
    game.stats().getPlayerStats(me)?.gold?.[GOLD_INDEX_WORK] ?? -1n;
  out.meGoldEnd = me.gold();
  out.meAlive = me.isAlive();
  return out;
}

// ---------------------------------------------------------------------------

describe("H7 economy: worker gold", () => {
  test("100 a tick for us and every nation at every difficulty, 50 for a tribe, whatever the land", () => {
    for (const difficulty of ALL_DIFFICULTIES) {
      const config = configAt(difficulty);
      for (const tiles of [1, 1_000, 100_000]) {
        const rate = (t: PlayerType) =>
          config.goldAdditionRate(stub(t, tiles, [{ level: 5 }]));
        expect(rate(PlayerType.Human)).toBe(100n);
        expect(rate(PlayerType.Nation)).toBe(100n);
        expect(rate(PlayerType.Bot)).toBe(50n);
      }
    }
    // No starting gold for anyone in the arena (Config.ts:439-444, 746-753).
    const info = (type: PlayerType) =>
      new PlayerInfo("x", type, type === PlayerType.Human ? "C1" : null, "x");
    expect(CONFIG.startingGold(info(PlayerType.Human))).toBe(0n);
    expect(CONFIG.startingGold(info(PlayerType.Nation))).toBe(0n);
    expect(CONFIG.startingGold(info(PlayerType.Bot))).toBe(0n);
    expect(CONFIG.goldMultiplier()).toBe(1);
  });

  test("the simulation pays it every tick through PlayerExecution, blind to land, difficulty and cities", async () => {
    for (const difficulty of [Difficulty.Easy, Difficulty.Impossible]) {
      const game = await testGame("plains", difficulty);
      const human = addPlayer(game, "human", PlayerType.Human);
      const nation = addPlayer(game, "nation", PlayerType.Nation);
      const tribe = addPlayer(game, "tribe", PlayerType.Bot);
      fill(game, human, 0, 1, 0, 1); // 1 tile
      fill(game, nation, 10, 70, 10, 70); // 3,600 tiles
      fill(game, tribe, 80, 100, 80, 100); // 400 tiles
      const ps = [human, nation, tribe];
      for (const p of ps) game.addExecution(new PlayerExecution(p));
      game.executeNextTick(); // init at the end of this tick
      const start = ps.map((p) => p.gold());
      for (let i = 0; i < 200; i++) game.executeNextTick();
      expect(ps.map((p, i) => p.gold() - start[i])).toEqual([
        20_000n,
        20_000n,
        10_000n,
      ]);
      // The price is checked at the build's first tick, after that tick's
      // worker gold (PlayerExecution was added first and runs first,
      // GameImpl.ts:529-536): 200 short when sent is enough, 201 is not.
      for (const short of [201n, 200n]) {
        human.removeGold(human.gold());
        human.addGold(125_000n - short);
        game.addExecution(
          new ConstructionExecution(human, UnitType.City, game.ref(0, 0)),
        );
        game.executeNextTick(); // +100, then init
        game.executeNextTick(); // +100, then the build
      }
      expect(human.units(UnitType.City)).toHaveLength(1);
      expect(human.gold()).toBe(0n);
      // A finished city changes nothing.
      nation.addGold(125_000n);
      build(game, nation, UnitType.City, game.ref(40, 40));
      const g = nation.gold();
      game.executeNextTick();
      expect(nation.gold() - g).toBe(100n);
    }
  });

  test("trade ships pay tradeShipGold(distance) to both port owners; conquest takes a tribe's or nation's gold whole", () => {
    // Config.ts:516-521: 75,000 / (1 + e^(-0.03 (d - 300))) + 50 d, floored.
    const us = stub(PlayerType.Human, 1);
    const pay = (d: number) => Number(CONFIG.tradeShipGold(d, us));
    expect(CONFIG.tradeShipShortRangeDebuff()).toBe(300);
    expect([100, 200, 300, 400, 500, 1000].map(pay)).toEqual([
      5_185, 13_556, 52_500, 91_443, 99_814, 124_999,
    ]);
    // Config.ts:735-744.
    const holder = (type: PlayerType) =>
      ({ type: () => type, gold: () => 10_000n }) as unknown as Player;
    expect(CONFIG.conquerGoldAmount(holder(PlayerType.Bot))).toBe(10_000n);
    expect(CONFIG.conquerGoldAmount(holder(PlayerType.Nation))).toBe(10_000n);
    expect(CONFIG.conquerGoldAmount(holder(PlayerType.Human))).toBe(5_000n);
  });
});

describe("H7 economy: troop cap", () => {
  const base = (tiles: number) => 2 * (pow(tiles, 0.6) * 1000 + 50_000);

  test("maxTroops = 2 (tiles^0.6 x 1000 + 50,000) + 250,000 per finished city level, x difficulty for nations, /3 for tribes", () => {
    expect(CONFIG.cityTroopIncrease()).toBe(250_000);
    const cities: StubCity[] = [
      { level: 1 },
      { level: 3 },
      { level: 2, building: true },
    ];
    for (const tiles of [1, 52, 1_000, 25_000]) {
      // Levels 1 + 3 finished; the city under construction counts 0.
      expect(CONFIG.maxTroops(stub(PlayerType.Human, tiles, cities))).toBe(
        base(tiles) + 4 * 250_000,
      );
      expect(CONFIG.maxTroops(stub(PlayerType.Bot, tiles, cities))).toBe(
        (base(tiles) + 4 * 250_000) / 3,
      );
    }
    const mult: Record<Difficulty, number> = {
      [Difficulty.Easy]: 0.5,
      [Difficulty.Medium]: 0.75,
      [Difficulty.Hard]: 1,
      [Difficulty.Impossible]: 1.25,
    };
    for (const d of ALL_DIFFICULTIES) {
      const config = configAt(d);
      const nation = (lv: number) =>
        config.maxTroops(stub(PlayerType.Nation, 1_000, [{ level: lv }]));
      expect(nation(0)).toBe(base(1_000) * mult[d]);
      expect(nation(1) - nation(0)).toBeCloseTo(250_000 * mult[d], 6);
      // Ours does not depend on difficulty.
      expect(config.maxTroops(stub(PlayerType.Human, 1_000))).toBe(base(1_000));
    }
    // So an Impossible nation gets 312,500 a city level against our 250,000.
    const imp = (lv: number) =>
      CONFIG.maxTroops(stub(PlayerType.Nation, 1_000, [{ level: lv }]));
    expect(imp(1) - imp(0)).toBe(312_500);
  });

  test("one city level is worth 3,125 tiles of cap at 0 tiles, ~5,175 at 1,000, more later", () => {
    // Smallest x with maxTroops(T + x tiles) >= maxTroops(T tiles + a city).
    const equiv = (T: number) => {
      const withCity = CONFIG.maxTroops(
        stub(PlayerType.Human, T, [{ level: 1 }]),
      );
      let lo = 0;
      let hi = 1_000_000;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (CONFIG.maxTroops(stub(PlayerType.Human, T + mid)) < withCity) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      return hi;
    };
    expect([0, 1_000, 2_000, 5_000, 10_000].map(equiv)).toEqual([
      3_125, 5_175, 6_057, 7_759, 9_604,
    ]);
  });
});

describe("H7 economy: cost ladders", () => {
  test("City doubles from 125k to a 1M cap; Port and Factory share that ladder, City has its own", () => {
    expect(ladder(UnitType.City, 6)).toEqual([
      125_000, 250_000, 500_000, 1_000_000, 1_000_000, 1_000_000,
    ]);
    expect(ladder(UnitType.Port, 6)).toEqual(ladder(UnitType.City, 6));
    expect(ladder(UnitType.Factory, 6)).toEqual(ladder(UnitType.City, 6));
    // Shared: every Factory raises the Port price and vice versa.
    expect(cost(UnitType.Port, buyer({ [UnitType.Factory]: 1 }))).toBe(250_000);
    expect(cost(UnitType.Factory, buyer({ [UnitType.Port]: 2 }))).toBe(500_000);
    expect(
      cost(UnitType.Port, buyer({ [UnitType.Port]: 1, [UnitType.Factory]: 1 })),
    ).toBe(500_000);
    // City is on its own ladder.
    const industry = { [UnitType.Port]: 3, [UnitType.Factory]: 3 };
    expect(cost(UnitType.City, buyer(industry))).toBe(125_000);
    expect(cost(UnitType.Port, buyer({ [UnitType.City]: 3 }))).toBe(125_000);
  });

  test("DefensePost +50k to 250k, SAM 1.5M then 3M, Silo 1M flat, Warship +250k to 1M, nukes", () => {
    expect(ladder(UnitType.DefensePost, 6)).toEqual([
      50_000, 100_000, 150_000, 200_000, 250_000, 250_000,
    ]);
    expect(ladder(UnitType.SAMLauncher, 4)).toEqual([
      1_500_000, 3_000_000, 3_000_000, 3_000_000,
    ]);
    expect(ladder(UnitType.MissileSilo, 3)).toEqual([
      1_000_000, 1_000_000, 1_000_000,
    ]);
    expect(ladder(UnitType.Warship, 5)).toEqual([
      250_000, 500_000, 750_000, 1_000_000, 1_000_000,
    ]);
    expect(ladder(UnitType.AtomBomb, 2)).toEqual([750_000, 750_000]);
    expect(ladder(UnitType.HydrogenBomb, 2)).toEqual([5_000_000, 5_000_000]);
    // MIRV: 25M + 15M per MIRV launched by anyone (Config.ts:618-630).
    const mirv = (launched: number) =>
      cost(UnitType.MIRV, buyer({}), {
        mirvsLaunched: () => launched,
      } as unknown as Game);
    expect([0, 1, 2].map(mirv)).toEqual([25_000_000, 40_000_000, 55_000_000]);
    expect(ladder(UnitType.TransportShip, 2)).toEqual([0, 0]);
  });

  test("the ladder counts min(owned, bought): a loss makes it cheaper, a capture does not raise it", () => {
    const city = (owned: number, built: number) =>
      cost(
        UnitType.City,
        buyer({ [UnitType.City]: owned }, { [UnitType.City]: built }),
      );
    expect(city(1, 2)).toBe(250_000); // two bought, one lost
    expect(city(3, 0)).toBe(125_000); // three captured, none bought
    // Bulk upgrades price step n as if n more were owned (PlayerImpl.ts:1542-1553).
    const p = buyer({ [UnitType.City]: 1 });
    expect([0, 1, 2].map((n) => cost(UnitType.City, p, NO_GAME, n))).toEqual([
      250_000, 500_000, 1_000_000,
    ]);
  });
});

describe("H7 economy: construction in the simulation", () => {
  test("build times, when the gold goes, when a city raises the cap, and instant upgrades", async () => {
    const game = await testGame("plains");
    const me = addPlayer(game, "me", PlayerType.Human);
    fill(game, me, 0, 100, 0, 100);
    me.addGold(20_000_000n);
    runTo(game, 60);

    const durations: Partial<Record<UnitType, number>> = {};
    const results: Partial<Record<UnitType, Build>> = {};
    const sites: [UnitType, number, number][] = [
      [UnitType.City, 10, 10],
      [UnitType.Factory, 40, 10],
      [UnitType.DefensePost, 70, 10],
      [UnitType.MissileSilo, 10, 40],
      [UnitType.SAMLauncher, 40, 40],
    ];
    const capBefore = game.config().maxTroops(me);
    for (const [type, x, y] of sites) {
      durations[type] = CONFIG.unitInfo(type).constructionDuration ?? -1;
      results[type] = build(game, me, type, game.ref(x, y));
    }
    expect(durations).toEqual({
      [UnitType.City]: 20,
      [UnitType.Factory]: 20,
      [UnitType.DefensePost]: 50,
      [UnitType.MissileSilo]: 100,
      [UnitType.SAMLauncher]: 300,
    });
    expect(SAM_CONSTRUCTION_TICKS).toBe(300);
    for (const [type] of sites) {
      const r = results[type]!;
      // The quoted price is taken when the unit appears (the tick after the
      // intent's), and it is finished duration + 2 ticks after the intent's.
      expect(r.charged).toBe(r.quoted);
      expect(r.ticksUnderConstruction).toBe(durations[type]! + 1);
      expect(r.ticksToFinish).toBe(durations[type]! + 2);
    }
    expect(sites.map(([t]) => results[t]!.charged)).toEqual([
      125_000n,
      125_000n,
      50_000n,
      1_000_000n,
      1_500_000n,
    ]);
    // The finished city is +250,000 on our cap; the factory raised the Port.
    expect(game.config().maxTroops(me) - capBefore).toBe(250_000);
    expect(game.unitInfo(UnitType.Port).cost(game, me)).toBe(250_000n);

    // A city under construction adds nothing and already raises the price.
    const city = results[UnitType.City]!.unit;
    game.addExecution(
      new ConstructionExecution(me, UnitType.City, game.ref(70, 40)),
    );
    game.executeNextTick(); // init
    const cap = game.config().maxTroops(me);
    game.executeNextTick(); // the second city appears, under construction
    const second = me.units(UnitType.City).find((u) => u !== city)!;
    expect(second.isUnderConstruction()).toBe(true);
    expect(game.config().maxTroops(me)).toBe(cap);
    expect(game.unitInfo(UnitType.City).cost(game, me)).toBe(500_000n);
    expect(me.canUpgradeUnit(second)).toBe(false); // PlayerImpl.ts:1470-1481
    runTo(game, game.ticks() + 21);
    expect(second.isUnderConstruction()).toBe(false);
    expect(game.config().maxTroops(me)).toBe(cap + 250_000);

    // An upgrade is instant (UpgradeStructureExecution.init) and costs the
    // next step of the same ladder: 2 city levels owned -> 500,000.
    const gold = me.gold();
    const cap2 = game.config().maxTroops(me);
    game.addExecution(new UpgradeStructureExecution(me, city.id()));
    game.executeNextTick(); // init at the end of this tick
    expect(city.level()).toBe(2);
    expect(gold - me.gold()).toBe(500_000n);
    expect(game.config().maxTroops(me)).toBe(cap2 + 250_000);
    expect(game.unitInfo(UnitType.City).cost(game, me)).toBe(1_000_000n);

    // A build we cannot afford at its first tick is dropped: no debt, no unit.
    const factoryPrice = game.unitInfo(UnitType.Factory).cost(game, me);
    expect(factoryPrice).toBe(250_000n);
    me.removeGold(me.gold() - (factoryPrice - 1n));
    game.addExecution(
      new ConstructionExecution(me, UnitType.Factory, game.ref(70, 70)),
    );
    runTo(game, game.ticks() + 5);
    expect(me.units(UnitType.Factory)).toHaveLength(1);
    expect(me.gold()).toBe(factoryPrice - 1n);
  });

  test("a Port takes 50 ticks and costs the first step of the Port/Factory ladder", async () => {
    const game = await testGame("half_land_half_ocean");
    const me = addPlayer(game, "me", PlayerType.Human);
    fill(game, me, 0, 8, 0, 16); // the land half; x = 7 is the shore
    me.addGold(125_000n);
    runTo(game, 60);
    const port = build(game, me, UnitType.Port, game.ref(7, 3));
    expect(CONFIG.unitInfo(UnitType.Port).constructionDuration).toBe(50);
    expect(port.charged).toBe(125_000n);
    expect(port.ticksToFinish).toBe(52);
    expect(me.gold()).toBe(0n);
    expect(game.unitInfo(UnitType.Factory).cost(game, me)).toBe(250_000n);
    expect(game.unitInfo(UnitType.City).cost(game, me)).toBe(125_000n);
  });
});

describe("H7 economy: the embargo an attack triggers", () => {
  /** Us (rows 0-6) and a nation (rows 8-15), a free row between, each with a Port. */
  async function border(difficulty = Difficulty.Impossible) {
    const game = await testGame("half_land_half_ocean", difficulty);
    const me = addPlayer(game, "me", PlayerType.Human);
    const nation = addPlayer(game, "nation", PlayerType.Nation);
    // A free row between us: our attacks find no tile to take and retreat
    // at their first tick (AttackExecution.ts:301-305), so nobody loses land
    // (a player under 100 tiles would be conquered whole, :448-482).
    fill(game, me, 0, 8, 0, 7);
    fill(game, nation, 0, 8, 8, 16);
    for (const p of [me, nation]) game.addExecution(new PlayerExecution(p));
    // Ports placed directly (tests may); the shore is x = 7.
    const myPort = me.buildUnit(UnitType.Port, game.ref(7, 2), {});
    nation.buildUnit(UnitType.Port, game.ref(7, 13), {});
    const portExec = new PortExecution(myPort);
    game.executeNextTick(); // the PlayerExecutions init
    portExec.init(game, game.ticks());
    // Owners of the ports our port may send a trade ship to.
    const partners = () =>
      new Set(portExec.tradingPorts().map((p) => p.owner().id()));
    return { game, me, nation, partners };
  }

  /** An attack as an attack intent makes it (ExecutionManager). */
  function attack(game: Game, from: Player, to: Player, troops = 100) {
    game.addExecution(new AttackExecution(troops, from, to.id(), null));
    game.executeNextTick(); // init at the end of this tick
  }

  /** Two private steps of a nation's decision tick (NationExecution.ts:218-225). */
  interface NationSteps {
    updateRelationsFromEmbargos(): void;
    handleEmbargoesToHostileNations(): void;
  }
  const nationSteps = (game: Game, id = "nation"): NationSteps => {
    const exec = new NationExecution(
      START.gameID,
      new Nation(undefined, new PlayerInfo(id, PlayerType.Nation, null, id)),
    );
    exec.init(game); // takes the existing player
    return exec as unknown as NationSteps;
  };
  const nationExec = (game: Game) => {
    const steps = nationSteps(game);
    return () => steps.handleEmbargoesToHostileNations();
  };

  test("our attack: the nation embargoes us for 3,001 ticks, trade stops both ways, it is Hostile for 1,000", async () => {
    const { game, me, nation, partners } = await border();
    runTo(game, 60); // past spawn immunity (50 ticks)
    expect(partners()).toEqual(new Set([nation.id()]));
    expect(me.canTrade(nation)).toBe(true);

    const t0 = game.ticks();
    attack(game, me, nation);
    const e = nation.getEmbargoes().find((x) => x.target === me);
    expect(e).toMatchObject({ createdAt: t0, isTemporary: true });
    // One-sided, but canTrade reads both sides (PlayerImpl.ts:1228-1232).
    expect(me.hasEmbargoAgainst(nation)).toBe(false);
    expect(me.canTrade(nation)).toBe(false);
    expect(nation.canTrade(me)).toBe(false);
    expect(partners()).toEqual(new Set());
    // Impossible: relation -100 at once, Hostile below -50.
    expect(relationValue(nation, me)).toBe(-100);
    expect(nation.relation(me)).toBe(Relation.Hostile);
    expect(game.config().temporaryEmbargoDuration()).toBe(3_000);

    runTo(game, t0 + 990);
    expect(nation.relation(me)).toBe(Relation.Hostile);
    runTo(game, t0 + 1_010);
    expect(nation.relation(me)).toBe(Relation.Distrustful);
    runTo(game, t0 + 2_100);
    expect(relationValue(nation, me)).toBe(0);

    // Lifted in the tick where ticks - createdAt > 3,000.
    runTo(game, t0 + 3_001); // ticks t0 .. t0 + 3,000 have run
    expect(nation.hasEmbargoAgainst(me)).toBe(true);
    game.executeNextTick(); // tick t0 + 3,001
    expect(nation.hasEmbargoAgainst(me)).toBe(false);
    expect(me.canTrade(nation)).toBe(true);
    expect(partners()).toEqual(new Set([nation.id()]));
    // Relations had recovered, so no permanent embargo follows.
    nationExec(game)();
    expect(nation.hasEmbargoAgainst(me)).toBe(false);
  });

  test("every new attack restarts the 3,001 ticks", async () => {
    const { game, me, nation } = await border();
    runTo(game, 60);
    const t0 = game.ticks();
    attack(game, me, nation);
    runTo(game, t0 + 2_000);
    const t1 = game.ticks();
    attack(game, me, nation);
    expect(nation.getEmbargoes()[0].createdAt).toBe(t1);
    runTo(game, t1 + 3_001);
    expect(nation.hasEmbargoAgainst(me)).toBe(true);
    game.executeNextTick();
    expect(nation.hasEmbargoAgainst(me)).toBe(false);
  });

  test("the target embargoes the attacker, tribes never take part, and a refused attack still counts", async () => {
    const { game, me, nation } = await border();
    // Attacks in the first 50 ticks hit spawn immunity (Config.ts:189,
    // GameImpl.ts:959-975) and are refused (AttackExecution.ts:124-127), but
    // the embargo is already set (:113-122). No troops, no relation change.
    expect(game.isNationSpawnImmunityActive()).toBe(true);
    const troops = me.troops();
    attack(game, me, nation);
    expect(me.outgoingAttacks()).toHaveLength(0);
    expect(me.troops()).toBeGreaterThanOrEqual(troops); // nothing was sent
    expect(nation.hasEmbargoAgainst(me)).toBe(true);
    expect(relationValue(nation, me)).toBe(0);

    runTo(game, 60);
    // A nation attacking us: WE embargo IT (temporary), not the reverse.
    const n2 = addPlayer(game, "nation2", PlayerType.Nation);
    const tribe = addPlayer(game, "tribe", PlayerType.Bot);
    n2.conquer(game.ref(0, 15));
    tribe.conquer(game.ref(2, 15));
    attack(game, n2, me);
    expect(me.getEmbargoes().find((x) => x.target === n2)).toMatchObject({
      isTemporary: true,
    });
    expect(n2.hasEmbargoAgainst(me)).toBe(false);
    // ... and our embargo costs us 20 points with it at its next decision,
    // given back when the embargo ends (NationExecution.ts:313-334).
    const steps = nationSteps(game, "nation2");
    steps.updateRelationsFromEmbargos();
    expect(relationValue(n2, me)).toBe(-20);
    me.stopEmbargo(n2);
    steps.updateRelationsFromEmbargos();
    expect(relationValue(n2, me)).toBe(0);
    // Tribes: attacking one, or being attacked by one, embargoes nobody.
    attack(game, me, tribe);
    attack(game, tribe, me);
    attack(game, tribe, nation);
    expect(me.hasEmbargoAgainst(tribe)).toBe(false);
    expect(nation.hasEmbargoAgainst(tribe)).toBe(false);
    expect(tribe.getEmbargoes()).toHaveLength(0);
  });

  test("an alliance ends the temporary embargo only on the mutual-request path", async () => {
    // A nation accepting our request (NationAllianceBehavior.ts:72 calls
    // AllianceRequest.accept) leaves the embargo in place.
    const a = await border();
    runTo(a.game, 60);
    attack(a.game, a.me, a.nation);
    runTo(a.game, a.game.ticks() + 20);
    a.me.createAllianceRequest(a.nation)!.accept();
    expect(a.me.isAlliedWith(a.nation)).toBe(true);
    expect(a.nation.hasEmbargoAgainst(a.me)).toBe(true);
    expect(a.me.canTrade(a.nation)).toBe(false);

    // Crossing requests through AllianceRequestExecution end it (:45-62).
    const b = await border();
    runTo(b.game, 60);
    attack(b.game, b.me, b.nation);
    runTo(b.game, b.game.ticks() + 20);
    b.nation.createAllianceRequest(b.me);
    b.game.addExecution(new AllianceRequestExecution(b.me, b.nation.id()));
    b.game.executeNextTick();
    expect(b.me.isAlliedWith(b.nation)).toBe(true);
    expect(b.nation.hasEmbargoAgainst(b.me)).toBe(false);
    expect(b.me.canTrade(b.nation)).toBe(true);
  });

  test("a Hostile nation with no embargo on us embargoes us for good; Impossible never lifts it", async () => {
    const lifted: Record<string, { neutral: boolean; friendly: boolean }> = {};
    for (const d of ALL_DIFFICULTIES) {
      const { game, me, nation } = await border(d);
      runTo(game, 60);
      const decide = nationExec(game);
      // -100 without an attack's temporary embargo: what a nuke on it
      // (NukeExecution.ts:194) or a broken alliance
      // (BreakAllianceExecution.ts:46) does.
      nation.updateRelation(me, -100);
      decide();
      const e = nation.getEmbargoes().find((x) => x.target === me);
      expect(e?.isTemporary).toBe(false);
      // Permanent: PlayerExecution only lifts temporary ones. Meanwhile the
      // relation decays back to 0 (Neutral).
      runTo(game, game.ticks() + 3_100);
      expect(nation.hasEmbargoAgainst(me)).toBe(true);
      expect(relationValue(nation, me)).toBe(0);
      decide();
      const neutral = !nation.hasEmbargoAgainst(me);
      nation.updateRelation(me, 100); // Friendly
      decide();
      const friendly = !nation.hasEmbargoAgainst(me);
      lifted[d] = { neutral, friendly };
    }
    expect(lifted).toEqual({
      [Difficulty.Easy]: { neutral: true, friendly: true },
      [Difficulty.Medium]: { neutral: true, friendly: true },
      [Difficulty.Hard]: { neutral: false, friendly: true },
      [Difficulty.Impossible]: { neutral: false, friendly: false },
    });

    // While an attack's temporary embargo stands, a Hostile nation adds no
    // permanent one (NationExecution.ts:361-367 needs !hasEmbargoAgainst).
    const { game, me, nation } = await border();
    runTo(game, 60);
    attack(game, me, nation);
    nationExec(game)();
    expect(nation.relation(me)).toBe(Relation.Hostile);
    expect(
      nation.getEmbargoes().find((x) => x.target === me)?.isTemporary,
    ).toBe(true);
  });
});

describe("H7 economy: the arena game", () => {
  test("our idle gold is 100 x ticks since the phase; nations earn the same 100 plus tribe loot and buy Cities early", async () => {
    const g = await playRealGame(1_300);
    expect(g.spawnEnd).toBe(5);
    expect(g.meAlive).toBe(true);
    expect(g.meOff).toEqual([]);
    // The first City (or Port) is affordable 1,250 ticks after the phase.
    expect(g.meGoldAt1250).toBe(125_000n);
    expect(g.cityPriceAt1250).toBe(125_000n);
    expect(g.portPriceAt1250).toBe(125_000n);
    expect(g.meWorkStat).toBe(g.meGoldEnd);

    // Nations: every tick of every nation, income minus trade/train/piracy
    // is exactly 100, or 100 plus the gold of players conquered that tick;
    // and every gold drop is the ladder price of what it bought.
    expect(g.nations).toBe(72);
    expect(g.incomeOff).toEqual([]);
    expect(g.spendOff).toEqual([]);

    // Every first purchase was a City, most long before our tick 1,255.
    const firsts = [...g.firstBuild.values()];
    expect(firsts.every((f) => f.types.join() === UnitType.City)).toBe(true);
    const ticks = firsts.map((f) => f.tick).sort((a, b) => a - b);
    const early = ticks.filter((t) => t < g.spawnEnd + 1250).length;
    expect({
      built: firsts.length,
      early,
      first: ticks[0],
      median: ticks[ticks.length >> 1],
    }).toEqual({ built: 71, early: 67, first: 471, median: 657 });
    // Loot outweighs wages: 12.65M from 370 conquests against 72 x 130,000
    // = 9.36M of worker gold. Once, a nation under 100 tiles was stripped of
    // its gold and survived.
    expect(g.conquestTicks).toBe(370);
    expect(g.conquestGold).toBe(12_652_000n);
    expect(g.lootedAlive).toBe(1);
    // No trade or train gold at all in the first 130 s.
    expect(g.nationTradeGold).toBe(0n);
  }, 60_000);
});
