/**
 * Pins how fast, and how bloodily, a land attack takes a PLAYER's tiles
 * (tribe or nation) compared with free land (docs/11-roadmap.md §11.3, H3;
 * the risk table asks for every mechanic an agent relies on to be pinned
 * here).
 *
 * The claim under test ("PlayerAttackSpeed", H3 [DERIVED]): against a player
 * defender, a stack of >= 1.22x the defender's troops takes tiles ~1.6x faster
 * per unit of frontage than free land: speedCost bottoms out at a troop ratio
 * of 0.82, giving ~0.63 tiles per tick per border tile against free land's
 * 0.4. Also pinned: the attacker's and defender's troop losses per tile as a
 * function of troop ratio and defender density, and the x0.7 attacker losses
 * against tribes (PlayerType.Bot).
 *
 * VERDICT: TRUE on plains, terrain-dependent elsewhere. The 0.82 floor, the
 * 1/0.82 = 1.22x threshold, 0.632 vs 0.4 tiles per tick per border tile and
 * the 1.58x ratio are exact on plains. Free land's saturated pace is 0.4 on
 * EVERY terrain while the player pace scales with tileCost, so the edge is
 * only 1.30x on highland and 1.04x on mountains (the claim's "1.6x" is a
 * plains number).
 *
 * The rules (src/core/configuration/Config.ts, attackLogic :882-973):
 *   - :172-188 terrainAttackBase: {mag, tileCost} = plains 80/16.5, highland
 *     100/20, mountain 120/25.
 *   - :896-908 terra nullius: attacker loss mag/5 (mag/10 for a Bot attacker),
 *     no defender loss, tickFraction = within(2000*tileCost/attackTroops, 5,
 *     100) / (2*borderSize). Saturates (cost 5) at attackTroops >=
 *     2000*tileCost/5 = 6600 / 8000 / 10000 troops.
 *   - :914-920 mag *= 0.7 (BOT_DEFENDER_LOSS_MULT, :135) when the attacker is
 *     Human or Nation and the defender is a Bot. mag only feeds losses.
 *   - :937 defenderTroopLoss = defender.troops / defender.numTiles (density).
 *   - :943-949 troopRatio = defender.troops / attackTroops;
 *     attackerTroopLoss = mag * traitorLossMod * within(troopRatio, 0.6, 2) *
 *     (0.463 * largeAttackerBonus * largeDefenderBonus + 0.0039 * density)
 *     (ATTACKER_LOSS_BASE / _PER_DENSITY, :144-145).
 *   - :955-957 speedCost = within(troopRatio, 0.82, 7.5) *
 *     within(troopRatio / 20, 1, 50) / 8.55 (SPEED_COST_DIVISOR, :149).
 *   - :958-972 tickFraction = speedCost * tileCost * largeAttackerSpeedBonus *
 *     largeDefenderBonus * traitorCostMod / borderSize.
 *   - :160-170 largeTerritoryBonus(n, depth) = 1 - depth * sigmoid(log n, 2.5,
 *     log 300k); depths 0.7 / 0.3 / 0.73 (:133-134, :154).
 *   - :886-889 defense post: mag x5, tileCost x3 (:381-387); :933-934 traitor
 *     defender: losses x0.5, cost x0.8 (:287-292).
 * The loop (src/core/execution/AttackExecution.ts, tick :258-343):
 *   - :291 borderSize = attack.borderSize() + nextInt(0, 5), i.e. +0..4
 *     (PseudoRandom.nextInt excludes max, PseudoRandom.ts:61-65), fixed for
 *     the tick.
 *   - :293-342 each conquered tile subtracts its tickFraction from a budget of
 *     1; the loop runs while budget > 0, so a tick takes the smallest n tiles
 *     whose fractions reach 1 (ceil(b / cost) at constant cost). Skipped
 *     tiles (:319-327) cost nothing.
 *   - :332, :345-387 attackLogicInput: attackTroops is the LIVE stack
 *     (troopCount, decremented per tile at :335), defender.troops is the
 *     defender's live home troops (:376).
 *   - :335-336 the stack loses attackerTroopLoss as a float
 *     (AttackImpl.setTroops, AttackImpl.ts:49-51); :337-339 the defender loses
 *     it through PlayerImpl.removeTroops (PlayerImpl.ts:1376-1383), which
 *     floors it (toInt, src/core/Util.ts:401-408).
 *
 * Setting: the real Config class exactly as createGameRunner builds it
 * (src/core/GameRunner.ts:46: new Config(gameConfig, null, false)), FFA,
 * Singleplayer, Impossible, the agent as a Human. The simulation cases wrap
 * Config only to record attackLogic's inputs and results (super call,
 * nothing changed). Intents go through IntentSchema and Executor.createExec
 * (src/core/execution/ExecutionManager.ts:64-71), the path ctx.send takes.
 * Maps are synthetic single-terrain fields, so the frontier is an exact
 * straight line. No PlayerExecution runs, so no one regrows troops and the
 * numbers isolate the attack; nation spawn immunity (which binds Human
 * attackers only, PlayerImpl.ts:1907-1926) is waited out first.
 */
import {
  AttackLogicInput,
  AttackLogicResult,
  Config,
} from "../../../src/core/configuration/Config";
import { Executor } from "../../../src/core/execution/ExecutionManager";
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
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { genTerrainFromBin } from "../../../src/core/game/TerrainMapLoader";
import { GameConfig, IntentSchema } from "../../../src/core/Schemas";

const AGENT_CLIENT = "AGENTCL1";
const AGENT_ID = "AGENTID1";
const DEFENDER_ID = "DEFENDR1";

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

// The arena's config (GameRunner.ts:46).
const config = new Config(GAME_CONFIG, null, false);

const TERRAINS = [
  TerrainType.Plains,
  TerrainType.Highland,
  TerrainType.Mountain,
] as const;

// Small territories, where the large-territory bonuses (Config.ts:160-170)
// are ~1: an opening-phase agent and a tribe.
const ATTACKER_TILES = 2_000;
const DEFENDER_TILES = 1_000;

interface PvpInput {
  attackTroops: number;
  defenderTroops: number;
  defenderTiles?: number;
  defenderType?: PlayerType;
  attackerType?: PlayerType;
  attackerTiles?: number;
  terrain?: TerrainType;
  borderSize?: number;
  defensePost?: boolean;
  traitor?: boolean;
}

function pvp(o: PvpInput): AttackLogicResult {
  return config.attackLogic({
    terrain: o.terrain ?? TerrainType.Plains,
    attackTroops: o.attackTroops,
    attacker: {
      type: o.attackerType ?? PlayerType.Human,
      numTiles: o.attackerTiles ?? ATTACKER_TILES,
    },
    defender: {
      type: o.defenderType ?? PlayerType.Nation,
      numTiles: o.defenderTiles ?? DEFENDER_TILES,
      troops: o.defenderTroops,
      isTraitor: o.traitor ?? false,
      isDisconnectedTeammate: false,
    },
    defenderHasDefensePost: o.defensePost ?? false,
    falloutRatio: null,
    borderSize: o.borderSize ?? 100,
  });
}

function free(o: {
  attackTroops: number;
  terrain?: TerrainType;
  attackerType?: PlayerType;
  borderSize?: number;
}): AttackLogicResult {
  return config.attackLogic({
    terrain: o.terrain ?? TerrainType.Plains,
    attackTroops: o.attackTroops,
    attacker: {
      type: o.attackerType ?? PlayerType.Human,
      numTiles: ATTACKER_TILES,
    },
    defender: null,
    defenderHasDefensePost: false,
    falloutRatio: null,
    borderSize: o.borderSize ?? 100,
  });
}

/** Tiles per tick per border tile at a constant per-tile cost. */
function pace(r: AttackLogicResult, borderSize = 100): number {
  return 1 / (r.tickFraction * borderSize);
}

/** The tick loop at a constant fraction (AttackExecution.ts:293-342). */
function tilesPerTick(tickFraction: number): number {
  let budget = 1;
  let n = 0;
  while (budget > 0) {
    budget -= tickFraction;
    n++;
  }
  return n;
}

const D = 10_000; // defender troops for the pure cases
/** A stack that faces troopRatio r against D troops. */
const stack = (r: number) => D / r;

describe("H3 speed: Config.attackLogic (Config.ts:882-973)", () => {
  test("speedCost bottoms out at troopRatio 0.82: every stack >= 1/0.82 = 1.22x the defender moves at ~0.632 tiles per tick per border tile on plains, whatever the defender's type, density or size", () => {
    const floor = pace(pvp({ attackTroops: stack(0.82), defenderTroops: D }));
    // 8.55 / (0.82 * 16.5): SPEED_COST_DIVISOR / (floor * plains tileCost).
    expect(floor).toBeCloseTo(0.6319, 4);
    expect(1 / 0.82).toBeCloseTo(1.2195, 4);

    for (const r of [0.001, 0.1, 0.3, 0.5, 0.6, 0.7, 0.82]) {
      expect(pace(pvp({ attackTroops: stack(r), defenderTroops: D }))).toBe(
        floor,
      );
    }
    // Just past the floor the pace drops.
    expect(
      pace(pvp({ attackTroops: stack(0.83), defenderTroops: D })),
    ).toBeCloseTo((floor * 0.82) / 0.83, 12);

    // Only the RATIO matters, not the army size.
    for (const d of [100, 1_000, 1_000_000]) {
      expect(
        pace(pvp({ attackTroops: (d / 0.82) * 1.5, defenderTroops: d })),
      ).toBe(floor);
    }
    // Defender type (tribe vs nation) and attacker type do not touch speed:
    // the Bot multiplier (:914-920) scales mag, which only feeds losses.
    for (const defenderType of [
      PlayerType.Bot,
      PlayerType.Nation,
      PlayerType.Human,
    ]) {
      for (const attackerType of [
        PlayerType.Human,
        PlayerType.Nation,
        PlayerType.Bot,
      ]) {
        expect(
          pace(
            pvp({
              attackTroops: stack(0.5),
              defenderTroops: D,
              defenderType,
              attackerType,
            }),
          ),
        ).toBe(floor);
      }
    }
    // Density (tiles for the same troops) does not enter speed either; the
    // defender's tile count only moves the large-territory bonus (~1 here).
    for (const defenderTiles of [10, 100, 5_000]) {
      expect(
        pace(
          pvp({ attackTroops: stack(0.5), defenderTroops: D, defenderTiles }),
        ),
      ).toBeCloseTo(floor, 4);
    }
  });

  test("above the floor the pace falls as 0.82/troopRatio up to 7.5, is flat from 7.5 to 20, and falls again past 20", () => {
    const at = (r: number) =>
      pace(pvp({ attackTroops: stack(r), defenderTroops: D }));
    const floor = at(0.5);
    for (const r of [0.82, 1, 1.22, 2, 5, 7.5]) {
      expect(at(r)).toBeCloseTo((floor * 0.82) / r, 12);
    }
    // Parity: a stack equal to the defender's troops.
    expect(at(1)).toBeCloseTo(0.5182, 4);
    // Flat between 7.5 and 20 (both clamps saturated/neutral).
    expect(at(10)).toBeCloseTo(at(7.5), 12);
    expect(at(20)).toBeCloseTo(at(7.5), 12);
    // Second ramp (within(r/20, 1, 50)).
    expect(at(40)).toBeCloseTo(at(20) / 2, 12);
  });

  test("free land saturates at 0.4 tiles per tick per border tile on every terrain; the player floor is 1.58x that on plains but 1.30x on highland and 1.04x on mountains", () => {
    const ratios: number[] = [];
    // Saturation = 2000 * tileCost / 5 (Config.ts:902-906 with :172-188).
    const saturation = [6_600, 8_000, 10_000];
    TERRAINS.forEach((terrain, i) => {
      const freePace = pace(free({ attackTroops: 1_000_000, terrain }));
      expect(freePace).toBeCloseTo(0.4, 12);
      expect(pace(free({ attackTroops: saturation[i], terrain }))).toBeCloseTo(
        0.4,
        12,
      );
      expect(
        pace(free({ attackTroops: saturation[i] * 0.99, terrain })),
      ).toBeLessThan(0.4);
      const playerFloor = pace(
        pvp({ attackTroops: stack(0.5), defenderTroops: D, terrain }),
      );
      ratios.push(playerFloor / freePace);
    });
    expect(ratios[0]).toBeCloseTo(1.58, 2); // plains: the claim's 1.6x
    expect(ratios[1]).toBeCloseTo(1.3, 2); // highland
    expect(ratios[2]).toBeCloseTo(1.04, 2); // mountain

    // Break-even on plains: a player tile is as fast as saturated free land
    // at troopRatio 0.82 * 1.58 = 1.30, i.e. a stack of only 0.77x the
    // defender's troops. Any bigger stack out-paces free land on plains.
    const rStar = 0.82 * ratios[0];
    expect(rStar).toBeCloseTo(1.295, 3);
    expect(
      pace(pvp({ attackTroops: stack(rStar), defenderTroops: D })),
    ).toBeCloseTo(0.4, 6);
    // On mountains the break-even is ~1.22x -> 0.85x: almost no margin.
    expect(0.82 * ratios[2]).toBeCloseTo(0.855, 3);
  });

  test("narrow fronts: a tick takes the smallest n tiles whose fractions reach 1, so tiles per tick is ceil(b / cost) and the ratio to free land swings between 1x and 2x on 1-8 tile fronts", () => {
    const player: number[] = [];
    const freeLand: number[] = [];
    for (let b = 1; b <= 8; b++) {
      player.push(
        tilesPerTick(
          pvp({ attackTroops: stack(0.5), defenderTroops: D, borderSize: b })
            .tickFraction,
        ),
      );
      freeLand.push(
        tilesPerTick(
          free({ attackTroops: 1_000_000, borderSize: b }).tickFraction,
        ),
      );
    }
    // b is attack.borderSize() + 0..4 of jitter (AttackExecution.ts:291).
    expect(player).toEqual([1, 2, 2, 3, 4, 4, 5, 6]);
    expect(freeLand).toEqual([1, 1, 2, 2, 2, 3, 3, 4]);
    // A 100-tile front, as in the simulation case below.
    expect(
      tilesPerTick(
        pvp({ attackTroops: stack(0.5), defenderTroops: D }).tickFraction,
      ),
    ).toBe(64);
    expect(tilesPerTick(free({ attackTroops: 1_000_000 }).tickFraction)).toBe(
      40,
    );
  });

  test("territory size: below 20k tiles on both sides the bonuses move the pace by < 0.2%; a 300k-tile attacker is 1/(1 - 0.73/2) = 1.57x faster", () => {
    const base = pace(pvp({ attackTroops: stack(0.5), defenderTroops: D }));
    const at20k = pace(
      pvp({
        attackTroops: stack(0.5),
        defenderTroops: D,
        attackerTiles: 20_000,
        defenderTiles: 20_000,
      }),
    );
    expect(at20k / base).toBeGreaterThan(1);
    expect(at20k / base).toBeLessThan(1.002);
    const giant = pace(
      pvp({
        attackTroops: stack(0.5),
        defenderTroops: D,
        attackerTiles: 300_000,
      }),
    );
    expect(giant / base).toBeCloseTo(1 / (1 - 0.73 / 2), 3);
  });

  test("traps: a defense post in range makes a tile 3x slower (0.21/border tile, about half of free land) and 5x bloodier; a traitor defender is 1.25x faster and half as bloody", () => {
    const plain = pvp({ attackTroops: stack(0.5), defenderTroops: D });
    const post = pvp({
      attackTroops: stack(0.5),
      defenderTroops: D,
      defensePost: true,
    });
    expect(post.tickFraction / plain.tickFraction).toBeCloseTo(
      config.defensePostSpeedBonus(),
      12,
    );
    expect(pace(post)).toBeCloseTo(0.2106, 4);
    expect(post.attackerTroopLoss / plain.attackerTroopLoss).toBeCloseTo(
      config.defensePostDefenseBonus(),
      12,
    );
    const traitor = pvp({
      attackTroops: stack(0.5),
      defenderTroops: D,
      traitor: true,
    });
    expect(pace(traitor) / pace(plain)).toBeCloseTo(
      1 / config.traitorSpeedDebuff(),
      12,
    );
    expect(traitor.attackerTroopLoss / plain.attackerTroopLoss).toBeCloseTo(
      config.traitorDefenseDebuff(),
      12,
    );
  });
});

describe("H3 losses per tile: Config.attackLogic (Config.ts:914-949)", () => {
  /** A defender with density d (troops per tile) facing troop ratio r. */
  const loss = (r: number, d: number, o: Partial<PvpInput> = {}) => {
    const defenderTroops = d * DEFENDER_TILES;
    return pvp({
      // d = 0 means no troops; the ratio is then 0 and clamps to 0.6.
      attackTroops: defenderTroops === 0 ? 1_000 : defenderTroops / r,
      defenderTroops,
      ...o,
    });
  };

  test("attacker loss = mag * within(troopRatio, 0.6, 2) * (0.463 + 0.0039 * density); defender loss = density exactly", () => {
    const mag = 80; // plains (Config.ts:178)
    // Derive the two constants from the function itself.
    const base = loss(0.6, 0).attackerTroopLoss / (mag * 0.6);
    const perDensity =
      (loss(0.6, 100).attackerTroopLoss - loss(0.6, 0).attackerTroopLoss) /
      (mag * 0.6 * 100);
    expect(base).toBeCloseTo(0.463, 5); // ATTACKER_LOSS_BASE
    expect(perDensity).toBeCloseTo(0.0039, 7); // ATTACKER_LOSS_PER_DENSITY

    for (const d of [0.5, 1, 10, 50, 100, 400]) {
      for (const r of [0.1, 0.3, 0.6, 0.82, 1, 1.5, 2, 3, 10]) {
        const res = loss(r, d);
        expect(res.attackerTroopLoss).toBeCloseTo(
          mag * Math.min(Math.max(r, 0.6), 2) * (base + perDensity * d),
          8,
        );
        expect(res.defenderTroopLoss).toBe(d);
      }
      // Flat below 0.6 (stacks >= 1.67x) and above 2 (stacks <= 0.5x).
      expect(loss(0.1, d).attackerTroopLoss).toBe(
        loss(0.6, d).attackerTroopLoss,
      );
      expect(loss(10, d).attackerTroopLoss).toBe(loss(2, d).attackerTroopLoss);
    }
    // Sample values an agent can use (plains, human vs nation).
    expect(loss(0.6, 0).attackerTroopLoss).toBeCloseTo(22.22, 2); // cheapest
    expect(loss(0.82, 10).attackerTroopLoss).toBeCloseTo(32.93, 2);
    expect(loss(0.6, 50).attackerTroopLoss).toBeCloseTo(31.58, 2);
    expect(loss(1, 100).attackerTroopLoss).toBeCloseTo(68.24, 2);

    // Terrain scales attacker loss by mag 80 : 100 : 120; the defender's
    // loss depends only on the defender (Config.ts:937).
    const plains = loss(0.8, 20);
    const highland = loss(0.8, 20, { terrain: TerrainType.Highland });
    const mountain = loss(0.8, 20, { terrain: TerrainType.Mountain });
    expect(highland.attackerTroopLoss / plains.attackerTroopLoss).toBeCloseTo(
      1.25,
      12,
    );
    expect(mountain.attackerTroopLoss / plains.attackerTroopLoss).toBeCloseTo(
      1.5,
      12,
    );
    expect(highland.defenderTroopLoss).toBe(20);
    expect(mountain.defenderTroopLoss).toBe(20);
  });

  test("x0.7 attacker losses against tribes (PlayerType.Bot) for Human and Nation attackers only; a tribe attacking a tribe pays full; speed and defender loss unchanged", () => {
    for (const [r, d] of [
      [0.3, 5],
      [0.82, 20],
      [1.5, 80],
    ]) {
      const vsNation = loss(r, d);
      for (const attackerType of [PlayerType.Human, PlayerType.Nation]) {
        const vsTribe = loss(r, d, {
          defenderType: PlayerType.Bot,
          attackerType,
        });
        expect(
          vsTribe.attackerTroopLoss / vsNation.attackerTroopLoss,
        ).toBeCloseTo(0.7, 12);
        expect(vsTribe.defenderTroopLoss).toBe(vsNation.defenderTroopLoss);
        expect(vsTribe.tickFraction).toBe(vsNation.tickFraction);
      }
      const tribeOnTribe = loss(r, d, {
        defenderType: PlayerType.Bot,
        attackerType: PlayerType.Bot,
      });
      expect(tribeOnTribe.attackerTroopLoss).toBe(vsNation.attackerTroopLoss);
      // A tribe attacking a human pays full too (no attacker-side discount).
      expect(
        loss(r, d, {
          attackerType: PlayerType.Bot,
          defenderType: PlayerType.Human,
        }).attackerTroopLoss,
      ).toBe(vsNation.attackerTroopLoss);
    }
  });

  test("against free land: 16/20/24 per tile for Human/Nation (mag/5), half for a Bot; a nation tile never costs less than 22.2, a tribe tile beats free land only below density 3.4 with a >= 1.67x stack", () => {
    const perTerrain = TERRAINS.map(
      (terrain) => free({ attackTroops: 100_000, terrain }).attackerTroopLoss,
    );
    expect(perTerrain).toEqual([16, 20, 24]);
    expect(
      free({ attackTroops: 100_000, attackerType: PlayerType.Nation })
        .attackerTroopLoss,
    ).toBe(16);
    expect(
      free({ attackTroops: 100_000, attackerType: PlayerType.Bot })
        .attackerTroopLoss,
    ).toBe(8);
    // Free-land loss does not depend on the stack.
    expect(free({ attackTroops: 500 }).attackerTroopLoss).toBe(16);

    const freeLoss = perTerrain[0];
    // Cheapest possible nation tile: ratio clamped at 0.6, zero density.
    expect(loss(0.6, 0).attackerTroopLoss).toBeGreaterThan(freeLoss);
    // Tribe tiles at the 0.6 clamp are linear in density; solve for the
    // density where they cost as much as free land.
    const tribe = { defenderType: PlayerType.Bot };
    const l0 = loss(0.6, 0, tribe).attackerTroopLoss;
    const l1 = loss(0.6, 1, tribe).attackerTroopLoss;
    expect(l0).toBeCloseTo(15.56, 2);
    const breakEven = (freeLoss - l0) / (l1 - l0);
    expect(breakEven).toBeCloseTo(3.4, 1);
  });
});

// ---------------------------------------------------------------------------
// The same rules in the running simulation.

interface LogicCall {
  input: AttackLogicInput;
  result: AttackLogicResult;
}

/** The real Config; records attackLogic's inputs and results unchanged. */
class RecordingConfig extends Config {
  readonly calls: LogicCall[] = [];
  attackLogic(input: AttackLogicInput): AttackLogicResult {
    const result = super.attackLogic(input);
    this.calls.push({ input, result });
    return result;
  }
}

interface Front {
  game: Game;
  config: RecordingConfig;
  agent: Player;
  defender: Player | null;
  executor: Executor;
}

const WIDTH = 200;
const HEIGHT = 100; // the front's length
const AGENT_COLS = 5;
const DEFENDER_COLS = 100;

/**
 * A WIDTH x HEIGHT field of one terrain: the agent owns x < 5, the defender
 * (if any) 5 <= x < 105 (10,000 tiles), terra nullius the rest. The front is
 * the straight line x = 5, HEIGHT tiles long.
 */
async function front(
  defenderType: PlayerType | null,
  defenderTroops: number,
): Promise<Front> {
  const magnitude = 5; // plains (< 10, GameMap.ts:397-407)
  const data = new Uint8Array(WIDTH * HEIGHT).fill(0x80 | magnitude);
  const mw = Math.ceil(WIDTH / 2);
  const mh = Math.ceil(HEIGHT / 2);
  const mini = new Uint8Array(mw * mh).fill(0x80 | magnitude);
  const map = await genTerrainFromBin(
    { width: WIDTH, height: HEIGHT, num_land_tiles: WIDTH * HEIGHT },
    data,
  );
  const miniMap = await genTerrainFromBin(
    { width: mw, height: mh, num_land_tiles: mw * mh },
    mini,
  );
  const rc = new RecordingConfig(GAME_CONFIG, null, false);
  const game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    [],
    map,
    miniMap,
    rc,
  );
  game.endSpawnPhase();
  const agent = game.player(AGENT_ID);
  for (let x = 0; x < AGENT_COLS; x++)
    for (let y = 0; y < HEIGHT; y++) agent.conquer(game.ref(x, y));
  let defender: Player | null = null;
  if (defenderType !== null) {
    defender = game.addPlayer(
      new PlayerInfo("defender", defenderType, null, DEFENDER_ID),
    );
    for (let x = AGENT_COLS; x < AGENT_COLS + DEFENDER_COLS; x++)
      for (let y = 0; y < HEIGHT; y++) defender.conquer(game.ref(x, y));
    let ticks = 0;
    while (defender.isImmune()) {
      game.executeNextTick();
      ticks++;
    }
    expect(ticks).toBeLessThanOrEqual(rc.nationSpawnImmunityDuration());
    defender.setTroops(defenderTroops);
  }
  agent.setTroops(10_000_000);
  return {
    game,
    config: rc,
    agent,
    defender,
    executor: new Executor(game, "game", undefined),
  };
}

/** The agent's path: IntentSchema, then Executor.createExec; one tick inits. */
function launch(f: Front, troops: number) {
  const intent = {
    type: "attack" as const,
    targetID: f.defender === null ? null : f.defender.id(),
    troops,
  };
  expect(IntentSchema.safeParse(intent).success).toBe(true);
  f.game.addExecution(
    f.executor.createExec({ ...intent, clientID: AGENT_CLIENT }),
  );
  f.game.executeNextTick();
  expect(f.agent.outgoingAttacks()).toHaveLength(1);
  expect(f.agent.outgoingAttacks()[0].troops()).toBe(troops);
}

interface TickRow {
  /** attack.borderSize() at the start of the tick. */
  border: number;
  /** borderSize attackLogic saw: border + jitter. */
  inputBorder: number;
  gained: number;
  attackBefore: number;
  attackAfter: number;
  defenderBefore: number;
  defenderAfter: number;
  calls: LogicCall[];
}

function runTicks(f: Front, n: number): TickRow[] {
  const rows: TickRow[] = [];
  for (let t = 0; t < n; t++) {
    const attack = f.agent.outgoingAttacks()[0];
    const border = attack.borderSize();
    const attackBefore = attack.troops();
    const defenderBefore = f.defender?.troops() ?? 0;
    const c0 = f.config.calls.length;
    const tiles = f.agent.numTilesOwned();
    f.game.executeNextTick();
    const calls = f.config.calls.slice(c0);
    rows.push({
      border,
      inputBorder: calls[0].input.borderSize,
      gained: f.agent.numTilesOwned() - tiles,
      attackBefore,
      attackAfter: attack.troops(),
      defenderBefore,
      defenderAfter: f.defender?.troops() ?? 0,
      calls,
    });
  }
  return rows;
}

const ratioOf = (c: LogicCall) =>
  c.input.defender === null
    ? 0
    : c.input.defender.troops / c.input.attackTroops;

/** Checks the per-tick loop semantics on recorded calls. */
function checkLoop(rows: TickRow[]) {
  for (const row of rows) {
    // Jitter +0..4, fixed for the tick (AttackExecution.ts:291).
    expect(row.inputBorder - row.border).toBeGreaterThanOrEqual(0);
    expect(row.inputBorder - row.border).toBeLessThanOrEqual(4);
    for (const c of row.calls) expect(c.input.borderSize).toBe(row.inputBorder);
    // One attackLogic call per conquered tile.
    expect(row.gained).toBe(row.calls.length);
    // Budget of 1, loop while > 0 (AttackExecution.ts:293-342).
    let budget = 1;
    row.calls.forEach((c, i) => {
      expect(budget).toBeGreaterThan(0);
      budget -= c.result.tickFraction;
      if (i === row.calls.length - 1) expect(budget).toBeLessThanOrEqual(0);
    });
  }
}

const TICKS = 10;

describe("H3 in the simulation: a straight 100-tile plains front", () => {
  test("a stack of 2x (>= 1.22x) takes ~0.64 tiles per tick per border tile from a nation and a tribe alike, 1.59x free land's 0.40", async () => {
    // Density 10, stack 200k vs 100k: troopRatio 0.5, under the 0.82 floor.
    const nation = await front(PlayerType.Nation, 100_000);
    const tribe = await front(PlayerType.Bot, 100_000);
    const freeLand = await front(null, 0);
    launch(nation, 200_000);
    launch(tribe, 200_000);
    launch(freeLand, 200_000);
    const nRows = runTicks(nation, TICKS);
    const tRows = runTicks(tribe, TICKS);
    const fRows = runTicks(freeLand, TICKS);
    for (const rows of [nRows, tRows, fRows]) checkLoop(rows);

    const pvpFloorCost = (b: number) =>
      pvp({
        attackTroops: stack(0.5),
        defenderTroops: D,
        attackerTiles: 600,
        defenderTiles: 10_000,
        borderSize: b,
      }).tickFraction;
    for (const rows of [nRows, tRows]) {
      for (const row of rows) {
        for (const c of row.calls) {
          // The live ratio stays under the floor all along ...
          expect(ratioOf(c)).toBeLessThan(0.82);
          // ... so every tile costs the floor cost (bonuses ~1 at these sizes).
          expect(c.result.tickFraction).toBeCloseTo(
            pvpFloorCost(row.inputBorder),
            6,
          );
        }
      }
    }
    for (const row of fRows) {
      for (const c of row.calls) {
        expect(c.result.tickFraction * row.inputBorder).toBeCloseTo(2.5, 12);
      }
    }

    // The front starts as exactly the 100 contact tiles.
    expect(nRows[0].border).toBe(HEIGHT);
    expect(fRows[0].border).toBe(HEIGHT);

    // Same PRNG stream, same costs: tribe and nation go tile for tile.
    expect(tRows.map((r) => r.gained)).toEqual(nRows.map((r) => r.gained));

    const perBorder = (rows: TickRow[]) =>
      rows.reduce((s, r) => s + r.gained, 0) /
      rows.reduce((s, r) => s + r.inputBorder, 0);
    const playerPace = perBorder(nRows);
    const freePace = perBorder(fRows);
    // ceil() rounding adds up to one tile per tick on top of 0.632 / 0.4.
    expect(playerPace).toBeGreaterThanOrEqual(0.632);
    expect(playerPace).toBeLessThan(0.632 + 1 / HEIGHT);
    expect(freePace).toBeGreaterThanOrEqual(0.4);
    expect(freePace).toBeLessThan(0.4 + 1 / HEIGHT);
    expect(playerPace / freePace).toBeGreaterThan(1.55);
    expect(playerPace / freePace).toBeLessThan(1.62);
    // Pinned values of this deterministic run.
    expect(playerPace).toBeCloseTo(0.6388, 4);
    expect(freePace).toBeCloseTo(0.4018, 4);
  });

  test("losses: the stack drops by the sum of attackerTroopLoss, the defender by the sum of floor(density); tribes cost 0.7x; the live ratio drifts up against the nation and down against the tribe", async () => {
    // Density 10.5: the defender loses floor(10.5) = 10 per tile.
    const nation = await front(PlayerType.Nation, 105_000);
    const tribe = await front(PlayerType.Bot, 105_000);
    launch(nation, 210_000);
    launch(tribe, 210_000);
    const nRows = runTicks(nation, 5);
    const tRows = runTicks(tribe, 5);

    for (const rows of [nRows, tRows]) {
      for (const row of rows) {
        const aLoss = row.calls.reduce(
          (s, c) => s + c.result.attackerTroopLoss,
          0,
        );
        expect(row.attackBefore - row.attackAfter).toBeCloseTo(aLoss, 6);
        const dLoss = row.calls.reduce(
          (s, c) => s + Math.floor(c.result.defenderTroopLoss),
          0,
        );
        expect(row.defenderBefore - row.defenderAfter).toBe(dLoss);
        // Density stays in [10.5, 11): the floor is always 10.
        expect(dLoss).toBe(10 * row.gained);
      }
    }
    // Flooring leaves the defender's density creeping up as it loses tiles.
    const density = (f: Front) =>
      f.defender!.troops() / f.defender!.numTilesOwned();
    expect(density(nation)).toBeGreaterThan(10.5);

    // Identical state on the first tile: the tribe costs exactly 0.7x.
    const n0 = nRows[0].calls[0];
    const t0 = tRows[0].calls[0];
    expect(t0.input.attackTroops).toBe(n0.input.attackTroops);
    expect(t0.input.defender!.troops).toBe(n0.input.defender!.troops);
    expect(
      t0.result.attackerTroopLoss / n0.result.attackerTroopLoss,
    ).toBeCloseTo(0.7, 12);
    // 80 * 0.6 * (0.463 + 0.0039 * 10.5) and 0.7x that.
    expect(n0.result.attackerTroopLoss).toBeCloseTo(24.19, 2);
    expect(t0.result.attackerTroopLoss).toBeCloseTo(16.93, 2);

    // The ratio (defender / stack) rises when the stack loses a larger share
    // of itself per tile than the defender does: attackerLoss > density / r.
    // Nation: 24.19 > 10.5 / 0.5 = 21, so the stack's edge erodes. Tribe:
    // 16.93 < 21, so the edge grows.
    const first = (rows: TickRow[]) => ratioOf(rows[0].calls[0]);
    const last = (rows: TickRow[]) => {
      const calls = rows[rows.length - 1].calls;
      return ratioOf(calls[calls.length - 1]);
    };
    expect(last(nRows)).toBeGreaterThan(first(nRows));
    expect(last(tRows)).toBeLessThan(first(tRows));
  });

  test("a defender with fewer troops than tiles loses no troops at all to lost tiles (removeTroops floors density < 1 to 0)", async () => {
    const tribe = await front(PlayerType.Bot, 5_000); // density 0.5
    launch(tribe, 50_000);
    const rows = runTicks(tribe, 3);
    const lost = rows.reduce((s, r) => s + r.gained, 0);
    expect(lost).toBeGreaterThan(100);
    expect(tribe.defender!.troops()).toBe(5_000);
    for (const row of rows) {
      for (const c of row.calls)
        expect(c.result.defenderTroopLoss).toBeLessThan(1);
    }
  });
});
