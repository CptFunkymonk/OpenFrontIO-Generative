/**
 * Pins roadmap H2's free-land mechanics (docs/11-roadmap.md §11.3; the risk
 * table asks for every mechanic an agent relies on to be pinned here).
 *
 * The claim under test ("FreeLandCost"): a free-land (terra nullius) attack
 * costs a flat 16/20/24 troops per plains/highland/mountain tile, and its
 * speed saturates at ~400 x tileCost troops (6,600 on plains), beyond which
 * only frontage (border size) adds speed.
 *
 * The rules (the code is the spec):
 * - Terrain classes, GameMapImpl.terrainType (src/core/game/GameMap.ts:397-407):
 *   land magnitude < 10 is Plains, < 20 Highland, < 31 Mountain, 31 Impassable.
 * - Base values, terrainAttackBase (src/core/configuration/Config.ts:172-188):
 *   {mag, tileCost} = Plains 80/16.5, Highland 100/20, Mountain 120/25.
 * - Config.attackLogic (Config.ts:882-910), the terra nullius branch (:896-909):
 *     attackerTroopLoss = mag / (attacker is Bot ? 10 : 5)
 *     tickFraction = within(2000 * tileCost / attackTroops, 5, 100)
 *                    / (borderSize * 2)
 *   with the constants TERRA_NULLIUS_COST_SCALE/MIN_COST/MAX_COST (:136-138).
 *   Before it, fallout multiplies mag and tileCost by falloutDefenseModifier
 *   = 5 - 2 * falloutRatio (:890-894, :362-366). The defense-post multiplier
 *   needs `defender !== null` (:886), so it never applies to free land. The
 *   branch reads nothing else: not the game config, not the attacker's size,
 *   not the attacker's type except Bot for the loss.
 * - AttackExecution.tick (src/core/execution/AttackExecution.ts:258-343):
 *     :291     borderSize = attack.borderSize() + random.nextInt(0, 5), once per
 *              tick; nextInt is half-open (src/core/PseudoRandom.ts:61-65), so
 *              the jitter is 0..4.
 *     :293-295 tickBudget = 1, reset every tick (nothing carries over), and the
 *              loop runs while it is > 0, so every tick takes at least one tile
 *              and the last tile may overshoot the budget.
 *     :296-300 a stack below 1 troop is deleted (nothing refunded).
 *     :302-306 no free land left to take: the stack retreats, refunded in full
 *              (retreat() defaults to a 0% malus, :224-256).
 *     :309     each dequeued tile leaves the attack's border set.
 *     :329-336 per tile: attackLogic on the LIVE stack (troopCount), then
 *              budget -= tickFraction and stack -= attackerTroopLoss.
 *     :311-325 stale or duplicate heap entries are skipped without spending
 *              budget, so only conquered tiles count.
 *   attack.borderSize() counts the distinct target tiles the attack found next
 *   to our land (AttackImpl.ts:90-110): seeded from our whole border at init
 *   (refreshToConquer, AttackExecution.ts:213-222) and grown from each tile it
 *   conquers (addNeighbors, :398-445).
 * - Timing (GameImpl.executeNextTick, src/core/game/GameImpl.ts:526-551):
 *   running executions tick first, new ones init after, so the tick an attack
 *   intent arrives in only deducts its troops (AttackExecution.ts:130-139);
 *   its first tiles fall in the next tick.
 *
 * So a free-land stack of T troops with frontage b = borderSize + 0..4 takes,
 * per tick, the smallest n with sum_{i<n} within(2000*tileCost/(T - i*loss),
 * 5, 100) / (2b) >= 1:
 *   saturated  T >= 400 * tileCost (6,600 / 8,000 / 10,000):  ceil(0.4 * b)
 *   linear     20 * tileCost < T < 400 * tileCost:     ~b * T / (1000 * tileCost)
 *   floor      T <= 20 * tileCost (330 / 400 / 500):             ceil(b / 50)
 * and never fewer than 1 tile. Each tile spends the flat loss from the stack.
 *
 * VERDICT TRUE, with refinements pinned below: the flat loss is for Human and
 * Nation attackers (a tribe pays half); the saturation point uses tileCost
 * (16.5/20/25), not the loss (16/20/24); speed is computed on the live,
 * shrinking stack, so a stack at exactly 6,600 is saturated for one tile only.
 * It refutes docs/02-territory-and-combat.md §2.5 ("the same 400 troops on a
 * 200-tile front outrun 400 troops on a 4-tile front by ~50x", in fact ~4x:
 * the one-tile-per-tick floor) and §2.7's table row "Posts / fallout: still
 * apply" for terra nullius (posts do not apply, Config.ts:886).
 *
 * Setting: the real Config class (not TestConfig, whose attackLogic returns a
 * constant, tests/util/TestConfig.ts:77-79), FFA, Singleplayer, Impossible,
 * 400 tribes, Normal size, built the way setup() builds a game
 * (tests/util/Setup.ts: new ConfigClass(gameConfig, new UserSettings(), false),
 * createGame, endSpawnPhase); the arena makes the same class
 * (src/core/GameRunner.ts:46). The maps are synthesized in memory so a single
 * terrain class covers the field. RecordingConfig only logs each attackLogic
 * call and returns the real result; one test checks it changes nothing. The
 * agent's attacks go through IntentSchema and Executor.createExec
 * (src/core/execution/ExecutionManager.ts:64-71), the path of ctx.send;
 * nation and tribe attacks are built as AiAttackBehavior.sendLandAttack builds
 * them (src/core/execution/utils/AiAttackBehavior.ts:1107-1113). No
 * PlayerExecution runs, so no troops regrow during a test.
 */
import {
  AttackLogicInput,
  AttackLogicResult,
  Config,
} from "../../../src/core/configuration/Config";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import {
  Attack,
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
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { TileRef } from "../../../src/core/game/GameMap";
import { genTerrainFromBin } from "../../../src/core/game/TerrainMapLoader";
import { UserSettings } from "../../../src/core/game/UserSettings";
import { GameConfig, IntentSchema } from "../../../src/core/Schemas";

const AGENT_CLIENT = "AGENTCL1";
const AGENT_ID = "AGENTID1";
const NATION_ID = "NATION01";
const TRIBE_ID = "TRIBE001";

/** The arena's setting (the rest as tests/util/Setup.ts defaults it). */
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

/** One magnitude per class (GameMap.ts:397-407); bit 7 is IS_LAND_BIT (GameMap.ts:127). */
const TERRAINS = [
  { terrain: TerrainType.Plains, magnitude: 5 },
  { terrain: TerrainType.Highland, magnitude: 15 },
  { terrain: TerrainType.Mountain, magnitude: 25 },
] as const;
type TerrainCase = (typeof TERRAINS)[number];
const PLAINS = TERRAINS[0];

/** A Config built with no game at all: attackLogic must not need one. */
const PURE = new Config({} as GameConfig, null, false);
const REAL = new Config(GAME_CONFIG, new UserSettings(), false);

function freeLand(
  config: Config,
  o: Partial<AttackLogicInput> & { attackTroops: number },
): AttackLogicResult {
  return config.attackLogic({
    terrain: TerrainType.Plains,
    attacker: { type: PlayerType.Human, numTiles: 100 },
    defender: null,
    defenderHasDefensePost: false,
    falloutRatio: null,
    borderSize: 100,
    ...o,
  });
}

/** Smallest integer troops in [lo, hi] for which pred holds (pred monotone). */
function firstTrue(lo: number, hi: number, pred: (n: number) => boolean) {
  expect(pred(hi)).toBe(true);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Saturation point: the fewest troops whose tile cost is already the minimum. */
function saturation(terrain: TerrainType): number {
  const min = freeLand(PURE, { terrain, attackTroops: 1e12 }).tickFraction;
  return firstTrue(
    1,
    1e7,
    (t) => freeLand(PURE, { terrain, attackTroops: t }).tickFraction === min,
  );
}

/** Floor point: the most troops whose tile cost is still the maximum. */
function floorPoint(terrain: TerrainType): number {
  const max = freeLand(PURE, { terrain, attackTroops: 1 }).tickFraction;
  return (
    firstTrue(
      1,
      1e7,
      (t) => freeLand(PURE, { terrain, attackTroops: t }).tickFraction < max,
    ) - 1
  );
}

function lossPerTile(terrain: TerrainType, type: PlayerType): number {
  return freeLand(PURE, {
    terrain,
    attackTroops: 10_000,
    attacker: { type, numTiles: 100 },
  }).attackerTroopLoss;
}

/**
 * The tick loop of AttackExecution.ts:293-343 replayed on the pure function:
 * how many tiles a stack of `troops` takes in one tick at frontage `b`.
 */
function predictTick(
  troops: number,
  b: number,
  terrain: TerrainType,
  type: PlayerType = PlayerType.Human,
): number {
  let budget = 1;
  let n = 0;
  while (budget > 0 && troops >= 1) {
    const r = freeLand(PURE, {
      terrain,
      attackTroops: troops,
      attacker: { type, numTiles: 100 },
      borderSize: b,
    });
    budget -= r.tickFraction;
    troops -= r.attackerTroopLoss;
    n++;
  }
  return n;
}

interface LogicCall {
  input: AttackLogicInput;
  result: AttackLogicResult;
}

/** The real Config, logging each attackLogic call; results are untouched. */
class RecordingConfig extends Config {
  readonly calls: LogicCall[] = [];
  attackLogic(input: AttackLogicInput): AttackLogicResult {
    const result = super.attackLogic(input);
    this.calls.push({ input, result });
    return result;
  }
}

interface Field {
  game: Game;
  calls: LogicCall[];
  agent: Player;
  executor: Executor;
}

/**
 * A width x height field of one terrain class, all terra nullius except the
 * agent's starting land: the full column x = 0 (a straight front of exactly
 * `height` tiles), or only the tile (0, 0) when `corner` is set.
 */
async function field(
  width: number,
  height: number,
  t: TerrainCase = PLAINS,
  opts: { corner?: boolean; ConfigClass?: typeof Config } = {},
): Promise<Field> {
  const land = (w: number, h: number) =>
    genTerrainFromBin(
      { width: w, height: h, num_land_tiles: w * h },
      new Uint8Array(w * h).fill(0x80 | t.magnitude),
    );
  const map = await land(width, height);
  const miniMap = await land(Math.ceil(width / 2), Math.ceil(height / 2));
  const ConfigClass = opts.ConfigClass ?? RecordingConfig;
  const config = new ConfigClass(GAME_CONFIG, new UserSettings(), false);
  const game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    [],
    map,
    miniMap,
    config,
  );
  game.endSpawnPhase();
  const agent = game.player(AGENT_ID);
  if (opts.corner) agent.conquer(game.ref(0, 0));
  else for (let y = 0; y < height; y++) agent.conquer(game.ref(0, y));
  agent.setTroops(100_000_000);
  expect(game.map().terrainType(game.ref(width - 1, height - 1))).toBe(
    t.terrain,
  );
  return {
    game,
    calls: config instanceof RecordingConfig ? config.calls : [],
    agent,
    executor: new Executor(game, "game", undefined),
  };
}

/**
 * The agent's path: IntentSchema (AgentHost.isValid, src/agent/AgentHost.ts:
 * 197-202), then Executor.createExec. Runs the intent's tick, in which the
 * attack only takes its troops.
 */
function sendFreeLandAttack(f: Field, troops: number): Attack {
  const intent = { type: "attack" as const, targetID: null, troops };
  expect(IntentSchema.safeParse(intent).success).toBe(true);
  f.game.addExecution(
    f.executor.createExec({ ...intent, clientID: AGENT_CLIENT }),
  );
  const tiles = f.agent.numTilesOwned();
  const troopsBefore = f.agent.troops();
  f.game.executeNextTick();
  expect(f.agent.numTilesOwned()).toBe(tiles);
  expect(f.agent.troops()).toBe(troopsBefore - troops);
  const attacks = f.agent.outgoingAttacks();
  expect(attacks).toHaveLength(1);
  expect(attacks[0].target().isPlayer()).toBe(false);
  expect(attacks[0].troops()).toBe(troops);
  return attacks[0];
}

interface TickObs {
  /** attack.borderSize() before the tick. */
  border: number;
  /** The stack before the tick. */
  troops: number;
  /** Tiles the agent gained in the tick. */
  gained: number;
  /** attackLogic calls of the tick (one per conquered tile). */
  calls: LogicCall[];
}

function step(f: Field, attack: Attack): TickObs {
  const border = attack.borderSize();
  const troops = attack.troops();
  const tiles = f.agent.numTilesOwned();
  const c0 = f.calls.length;
  f.game.executeNextTick();
  return {
    border,
    troops,
    gained: f.agent.numTilesOwned() - tiles,
    calls: f.calls.slice(c0),
  };
}

/** The frontage attackLogic saw in a tick: one value for every tile, B + 0..4. */
function frontage(o: TickObs): number {
  expect(o.calls.length).toBeGreaterThan(0);
  const b = o.calls[0].input.borderSize;
  for (const c of o.calls) expect(c.input.borderSize).toBe(b);
  expect(b - o.border).toBeGreaterThanOrEqual(0);
  expect(b - o.border).toBeLessThanOrEqual(4);
  return b;
}

function ownedTiles(p: Player): TileRef[] {
  return Array.from(p.tiles()).sort((a, b) => a - b);
}

describe("FreeLandCost: Config.attackLogic on terra nullius is a pure function", () => {
  test("terrain classes: land magnitude 0-9 is plains, 10-19 highland, 20-30 mountain, 31 impassable", async () => {
    const magnitudes = Array.from({ length: 32 }, (_, m) => m);
    const map = await genTerrainFromBin(
      { width: 32, height: 1, num_land_tiles: 32 },
      Uint8Array.from(magnitudes, (m) => 0x80 | m),
    );
    const classOf = (m: number) => map.terrainType(map.ref(m, 0));
    expect(magnitudes.filter((m) => classOf(m) === TerrainType.Plains)).toEqual(
      magnitudes.slice(0, 10),
    );
    expect(
      magnitudes.filter((m) => classOf(m) === TerrainType.Highland),
    ).toEqual(magnitudes.slice(10, 20));
    expect(
      magnitudes.filter((m) => classOf(m) === TerrainType.Mountain),
    ).toEqual(magnitudes.slice(20, 31));
    expect(classOf(31)).toBe(TerrainType.Impassable);
  });

  test("its result depends only on the input: no game, game config, attacker size or type (for speed), or post flag", () => {
    const base = { attackTroops: 3000, borderSize: 37 };
    const ref = freeLand(PURE, base);
    // Same numbers from a gameless Config with an empty game config and from
    // the arena's config; repeated calls agree; the input is not mutated.
    const input: AttackLogicInput = {
      terrain: TerrainType.Plains,
      attacker: { type: PlayerType.Human, numTiles: 100 },
      defender: null,
      defenderHasDefensePost: false,
      falloutRatio: null,
      ...base,
    };
    const frozen = JSON.stringify(input);
    expect(REAL.attackLogic(input)).toEqual(ref);
    expect(REAL.attackLogic(input)).toEqual(ref);
    expect(JSON.stringify(input)).toBe(frozen);

    // No territory-size curve on free land (those are in the player branch,
    // Config.ts:924-931 and :958-961).
    for (const numTiles of [1, 50_000, 300_000, 5_000_000]) {
      expect(
        freeLand(PURE, {
          ...base,
          attacker: { type: PlayerType.Human, numTiles },
        }),
      ).toEqual(ref);
    }
    // A Nation pays and moves exactly like a Human; a tribe (Bot) moves at
    // the same speed but pays half.
    const nation = freeLand(PURE, {
      ...base,
      attacker: { type: PlayerType.Nation, numTiles: 100 },
    });
    expect(nation).toEqual(ref);
    const tribe = freeLand(PURE, {
      ...base,
      attacker: { type: PlayerType.Bot, numTiles: 100 },
    });
    expect(tribe.tickFraction).toBe(ref.tickFraction);
    expect(tribe.attackerTroopLoss).toBe(ref.attackerTroopLoss / 2);
    expect(ref.defenderTroopLoss).toBe(0);

    // Refutes docs/02 §2.7's "Posts / fallout: still apply" for terra
    // nullius: the post multiplier needs a defender (Config.ts:886), and
    // AttackExecution never sets the flag without one (AttackExecution.ts:
    // 355-361).
    expect(freeLand(PURE, { ...base, defenderHasDefensePost: true })).toEqual(
      ref,
    );
  });

  test("the troop loss per tile is flat: 16/20/24 for a Human or Nation, 8/10/12 for a tribe", () => {
    const loss = (type: PlayerType) =>
      TERRAINS.map((t) => lossPerTile(t.terrain, type));
    expect(loss(PlayerType.Human)).toEqual([16, 20, 24]);
    expect(loss(PlayerType.Nation)).toEqual([16, 20, 24]);
    expect(loss(PlayerType.Bot)).toEqual([8, 10, 12]);
    // Flat: neither the stack nor the frontage changes it.
    for (const t of TERRAINS) {
      const l = lossPerTile(t.terrain, PlayerType.Human);
      for (const attackTroops of [1, 330, 6600, 1e6, 1e9]) {
        for (const borderSize of [1, 10, 1000]) {
          expect(
            freeLand(PURE, { terrain: t.terrain, attackTroops, borderSize })
              .attackerTroopLoss,
          ).toBe(l);
        }
      }
    }
    // Impassable and water cannot be attacked at all (Config.ts:183-187).
    expect(() =>
      freeLand(PURE, { terrain: TerrainType.Impassable, attackTroops: 1000 }),
    ).toThrow();
    expect(() =>
      freeLand(PURE, { terrain: TerrainType.Ocean, attackTroops: 1000 }),
    ).toThrow();
  });

  test("speed saturates at exactly 400 x tileCost = 6,600 / 8,000 / 10,000 troops and floors at 20 x tileCost = 330 / 400 / 500", () => {
    const sat = TERRAINS.map((t) => saturation(t.terrain));
    const floor = TERRAINS.map((t) => floorPoint(t.terrain));
    // 400 and 20 x tileCost = 16.5 / 20 / 25 (Config.ts:172-188, :136-138).
    // Not 400 x the troop loss: that would put plains at 6,400 and mountain
    // at 9,600.
    expect(sat).toEqual([6600, 8000, 10_000]);
    expect(floor).toEqual([330, 400, 500]);

    for (const [i, t] of TERRAINS.entries()) {
      const f = (attackTroops: number, borderSize = 100) =>
        freeLand(PURE, { terrain: t.terrain, attackTroops, borderSize })
          .tickFraction;
      // Saturated: 5 / (2 b) whatever the stack, the same on every terrain,
      // i.e. 0.4 tiles per tick per frontage tile.
      for (const troops of [sat[i], sat[i] * 10, 1e9]) {
        expect(f(troops)).toBe(f(sat[i]));
        expect(f(troops, 250)).toBeCloseTo(5 / (2 * 250), 15);
      }
      expect(f(sat[i] - 1)).toBeGreaterThan(f(sat[i]));
      // Floor: 100 / (2 b), 0.02 tiles per tick per frontage tile.
      for (const troops of [1, floor[i] / 2, floor[i]]) {
        expect(f(troops)).toBe(f(1));
        expect(f(troops, 250)).toBeCloseTo(100 / (2 * 250), 15);
      }
      expect(f(floor[i] + 1)).toBeLessThan(f(floor[i]));
    }
    // A plains-saturated stack is not saturated on highland or mountain.
    const plainsMin = freeLand(PURE, { attackTroops: sat[0] }).tickFraction;
    expect(
      freeLand(PURE, { terrain: TerrainType.Mountain, attackTroops: sat[0] })
        .tickFraction,
    ).toBeCloseTo(plainsMin * (sat[2] / sat[0]), 12);
  });

  test("between the clamps, tiles per tick are proportional to troops x frontage", () => {
    for (const t of TERRAINS) {
      const sat = saturation(t.terrain);
      const speed = (attackTroops: number, borderSize: number) =>
        1 /
        freeLand(PURE, { terrain: t.terrain, attackTroops, borderSize })
          .tickFraction;
      // tiles/tick at a constant stack = b * T / (1000 * tileCost), and
      // 1000 * tileCost = 2.5 * sat.
      for (const troops of [sat / 16, sat / 4, sat / 2, sat]) {
        for (const b of [5, 50, 500]) {
          expect(speed(troops, b)).toBeCloseTo((b * troops) / (2.5 * sat), 9);
        }
      }
      // Frontage multiplies speed at every stack size, saturated included.
      for (const troops of [100, sat / 3, sat * 50]) {
        expect(speed(troops, 200)).toBeCloseTo(2 * speed(troops, 100), 9);
      }
    }
  });

  test("fallout multiplies both the loss and tileCost by 5 - 2 x falloutRatio", () => {
    for (const falloutRatio of [0, 0.25, 1]) {
      const m = REAL.falloutDefenseModifier(falloutRatio);
      expect(m).toBe(5 - 2 * falloutRatio);
      for (const t of TERRAINS) {
        const clean = (troops: number) =>
          freeLand(PURE, { terrain: t.terrain, attackTroops: troops });
        const dirty = (troops: number) =>
          freeLand(PURE, {
            terrain: t.terrain,
            attackTroops: troops,
            falloutRatio,
          });
        expect(dirty(5000).attackerTroopLoss).toBeCloseTo(
          clean(5000).attackerTroopLoss * m,
          9,
        );
        // Same cost as a clean tile with m times fewer troops, so the
        // saturation point moves to m x 400 x tileCost.
        const sat = saturation(t.terrain);
        expect(dirty(sat * m).tickFraction).toBeCloseTo(
          clean(sat).tickFraction,
          12,
        );
        expect(dirty(sat).tickFraction).toBeCloseTo(
          clean(sat / m).tickFraction,
          12,
        );
      }
    }
  });
});

describe("FreeLandCost: a real free-land attack in the simulation", () => {
  test("every tile costs the flat loss on each terrain, for a Human, a Nation and a tribe, whatever the stack", async () => {
    for (const t of TERRAINS) {
      const f = await field(300, 100, t);
      const nation = f.game.addPlayer(
        new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
      );
      const tribe = f.game.addPlayer(
        new PlayerInfo("tribe", PlayerType.Bot, null, TRIBE_ID),
      );
      // Nation on the east edge, tribe in the middle: none meet in 8 ticks.
      for (let y = 0; y < 100; y++) {
        nation.conquer(f.game.ref(299, y));
        tribe.conquer(f.game.ref(150, y));
      }
      nation.setTroops(1_000_000);
      tribe.setTroops(1_000_000);

      const agentAttack = sendFreeLandAttack(f, 2000);
      // AiAttackBehavior.sendLandAttack (AiAttackBehavior.ts:1107-1113).
      f.game.addExecution(
        new AttackExecution(200_000, nation, f.game.terraNullius().id()),
      );
      f.game.addExecution(
        new AttackExecution(20_000, tribe, f.game.terraNullius().id()),
      );
      f.game.executeNextTick();
      const [nationAttack] = nation.outgoingAttacks();
      const [tribeAttack] = tribe.outgoingAttacks();

      const cases = [
        { p: f.agent, a: agentAttack, type: PlayerType.Human },
        { p: nation, a: nationAttack, type: PlayerType.Nation },
        { p: tribe, a: tribeAttack, type: PlayerType.Bot },
      ];
      const start = cases.map((c) => ({
        tiles: c.p.numTilesOwned(),
        troops: c.a.troops(),
      }));
      for (let i = 0; i < 8; i++) f.game.executeNextTick();

      for (const [i, c] of cases.entries()) {
        const gained = c.p.numTilesOwned() - start[i].tiles;
        expect(gained).toBeGreaterThan(20);
        expect(start[i].troops - c.a.troops()).toBe(
          gained * lossPerTile(t.terrain, c.type),
        );
      }
      // Every call the simulation made reported that same flat loss.
      for (const call of f.calls) {
        expect(call.input.defender).toBeNull();
        expect(call.input.terrain).toBe(t.terrain);
        expect(call.result.attackerTroopLoss).toBe(
          lossPerTile(t.terrain, call.input.attacker.type),
        );
      }
    }
  });

  test("above saturation a bigger stack buys no speed: 10x and 1000x saturation take the same tiles, tick for tick", async () => {
    for (const t of TERRAINS) {
      const sat = saturation(t.terrain);
      const loss = lossPerTile(t.terrain, PlayerType.Human);
      const small = await field(300, 100, t);
      const big = await field(300, 100, t);
      // The unrecorded real Config: the recorder changes nothing.
      const plain = await field(300, 100, t, { ConfigClass: Config });
      const aSmall = sendFreeLandAttack(small, sat * 10);
      const aBig = sendFreeLandAttack(big, sat * 1000);
      const aPlain = sendFreeLandAttack(plain, sat * 10);

      const minFraction = (b: number) =>
        freeLand(PURE, {
          terrain: t.terrain,
          attackTroops: 1e12,
          borderSize: b,
        }).tickFraction;
      for (let i = 0; i < 40; i++) {
        const o = step(small, aSmall);
        const ob = step(big, aBig);
        const op = step(plain, aPlain);
        expect(ob.gained).toBe(o.gained);
        expect(op.gained).toBe(o.gained);
        // Still saturated at the last tile of the tick, so every tile had
        // the minimum cost: ceil(0.4 b) tiles, give or take the float sum.
        expect(aSmall.troops()).toBeGreaterThanOrEqual(sat);
        const b = frontage(o);
        for (const c of o.calls)
          expect(c.result.tickFraction).toBe(minFraction(b));
        expect(o.gained).toBeGreaterThanOrEqual(0.4 * b - 1e-9);
        expect(o.gained).toBeLessThanOrEqual(0.4 * b + 1 + 1e-9);
        expect(o.troops - aSmall.troops()).toBe(o.gained * loss);
      }
      expect(ownedTiles(big.agent)).toEqual(ownedTiles(small.agent));
      expect(ownedTiles(plain.agent)).toEqual(ownedTiles(small.agent));
    }
  });

  test("each tick replays the pure function on the live stack, with the frontage drawn once as borderSize + 0..4", async () => {
    const sat = saturation(TerrainType.Plains);
    const loss = lossPerTile(TerrainType.Plains, PlayerType.Human);
    for (const troops of [sat / 2, sat, sat * 3]) {
      const f = await field(300, 100);
      const attack = sendFreeLandAttack(f, troops);
      // The straight 100-tile column seeds exactly 100 border tiles.
      expect(attack.borderSize()).toBe(100);
      let ticks = 0;
      while (attack.isActive() && ticks < 80) {
        const o = step(f, attack);
        ticks++;
        if (o.gained === 0) break;
        const b = frontage(o);
        expect(o.calls).toHaveLength(o.gained);
        // attackTroops is the live stack: the tick's first tile sees the
        // stack as it was, each later one the stack minus the losses so far.
        o.calls.forEach((c, i) =>
          expect(c.input.attackTroops).toBe(o.troops - loss * i),
        );
        expect(o.gained).toBe(predictTick(o.troops, b, TerrainType.Plains));
      }
      expect(ticks).toBeGreaterThan(10);
    }
  });

  test("tiles per tick against troops and frontage: saturated ~0.4 b, then proportional to troops, floored at ~b / 50", async () => {
    const sat = saturation(TerrainType.Plains);
    const floor = floorPoint(TerrainType.Plains);
    const loss = lossPerTile(TerrainType.Plains, PlayerType.Human);
    const first: Record<string, { n: number; b: number }> = {};
    for (const height of [25, 50, 100, 200]) {
      for (const troops of [sat * 100, sat, sat / 2, sat / 4, floor]) {
        const f = await field(40, height);
        const attack = sendFreeLandAttack(f, troops);
        expect(attack.borderSize()).toBe(height);
        const o = step(f, attack);
        const b = frontage(o);
        expect(o.gained).toBe(predictTick(troops, b, TerrainType.Plains));
        first[`${height}/${troops}`] = { n: o.gained, b };
      }
    }
    for (const height of [25, 50, 100, 200]) {
      const at = (troops: number) => first[`${height}/${troops}`];
      // Saturated: ceil(0.4 b) (float may add one).
      const s = at(sat * 100);
      expect(s.n).toBeGreaterThanOrEqual(0.4 * s.b - 1e-9);
      expect(s.n).toBeLessThanOrEqual(0.4 * s.b + 1 + 1e-9);
      // A stack exactly at saturation is saturated for its first tile only:
      // same frontage draw (the PRNG sequence does not depend on troops), at
      // most as many tiles, and on the widest front visibly fewer.
      expect(at(sat).b).toBe(s.b);
      expect(at(sat).n).toBeLessThanOrEqual(s.n);
      if (height === 200) expect(at(sat).n).toBeLessThan(s.n - 4);
      // Below saturation, tiles per tick = b * T / (1000 * tileCost), where
      // 1000 * tileCost = 2.5 * sat, on the live stack: it lies between the
      // rate at the stack before the tick's last tile and the rate at the
      // stack the tick started with. So half the stack, about half the speed.
      for (const troops of [sat / 2, sat / 4]) {
        const { n, b } = at(troops);
        const rate = (t: number) => (b * t) / (2.5 * sat);
        expect(n).toBeGreaterThanOrEqual(rate(troops - loss * (n - 1)));
        expect(n).toBeLessThan(rate(troops) + 1);
      }
      // Floor: ceil(b / 50).
      const fl = at(floor);
      expect(fl.n).toBe(Math.ceil(fl.b / 50 - 1e-9));
    }
    // At saturation, doubling the frontage doubles the speed (within the
    // 0..4 jitter).
    const sat25 = first[`25/${sat * 100}`].n;
    const sat200 = first[`200/${sat * 100}`].n;
    expect(sat200 / sat25).toBeGreaterThan(6);
    expect(sat200 / sat25).toBeLessThanOrEqual(8.5);
  });

  test("never below one tile per tick: 400 troops take free land ~4x faster on a 200-tile front than on a 4-tile one, not ~50x", async () => {
    const floor = floorPoint(TerrainType.Plains);
    // A tiny stack on a two-tile front (the corner): the formula says one
    // tile per ~20 ticks, the loop takes one every tick (AttackExecution.ts:
    // 293-295).
    const corner = await field(100, 100, PLAINS, { corner: true });
    const cAttack = sendFreeLandAttack(corner, floor);
    expect(cAttack.borderSize()).toBe(2);
    for (let i = 0; i < 10; i++) {
      const o = step(corner, cAttack);
      const b = frontage(o);
      expect(o.calls[0].result.tickFraction).toBeGreaterThan(1);
      expect(b).toBeLessThan(50);
      expect(o.gained).toBe(1);
    }

    // Refutes docs/02 §2.5 ("The same 400 troops on a 200-tile front outrun
    // 400 troops on a 4-tile front by ~50x"). Both stacks take the same
    // ceil(400 / 16) = 25 tiles; the narrow one at the one-tile floor.
    const ticksToSpend = async (width: number, height: number) => {
      const f = await field(width, height);
      const attack = sendFreeLandAttack(f, 400);
      expect(attack.borderSize()).toBe(height);
      let ticks = 0;
      for (let i = 0; i < 100 && attack.isActive(); i++) {
        if (step(f, attack).gained > 0) ticks++;
      }
      expect(attack.isActive()).toBe(false);
      expect(f.agent.numTilesOwned() - height).toBe(Math.ceil(400 / 16));
      return ticks;
    };
    const narrow = await ticksToSpend(300, 4);
    const wide = await ticksToSpend(50, 200);
    expect(narrow).toBe(25);
    expect(wide).toBeGreaterThanOrEqual(5);
    expect(wide).toBeLessThanOrEqual(6);
    expect(narrow / wide).toBeLessThan(6);
  });

  test("a stack takes ceil(T / loss) tiles and dies with nothing refunded; if the land runs out the rest comes home in full", async () => {
    const loss = lossPerTile(TerrainType.Plains, PlayerType.Human);
    // Unbounded land: the stack is spent to the last troop. The final tile
    // is taken with fewer troops than it costs (1000 - 62 * 16 = 8), since
    // only a stack below 1 stops (AttackExecution.ts:296-300).
    const f = await field(300, 100);
    const before = f.agent.troops();
    const attack = sendFreeLandAttack(f, 1000);
    for (let i = 0; i < 30 && attack.isActive(); i++) f.game.executeNextTick();
    expect(attack.isActive()).toBe(false);
    expect(f.agent.outgoingAttacks()).toHaveLength(0);
    expect(f.agent.numTilesOwned() - 100).toBe(Math.ceil(1000 / loss));
    expect(f.agent.troops()).toBe(before - 1000);

    // A closed pocket of 190 free tiles: the stack pays 190 x 16 and the
    // surplus returns with no malus (AttackExecution.ts:302-306, :224-256).
    const pocket = await field(20, 10);
    const pBefore = pocket.agent.troops();
    const pAttack = sendFreeLandAttack(pocket, 10_000);
    for (let i = 0; i < 200 && pAttack.isActive(); i++)
      pocket.game.executeNextTick();
    expect(pAttack.isActive()).toBe(false);
    expect(pocket.agent.numTilesOwned()).toBe(200);
    expect(pocket.agent.troops()).toBe(pBefore - 190 * loss);
  });
});
