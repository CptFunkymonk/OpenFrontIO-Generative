/**
 * apex lib/Models.ts (spec §2.2; §4 step 1): every wrapper equals the
 * game.config() formula it wraps, and the shims (capAt, regrowthAt) equal
 * the live formulas on real players.
 *
 * Setting: the real Config class as the arena builds it (FFA, Singleplayer,
 * Impossible, GameRunner.ts:46), on a synthetic all-plains field large enough
 * for a 100,000-tile player. Players get their tiles through conquer(), with
 * no executions running, so nothing but the test changes them.
 *
 * Pins this rests on: FreeLandCost (the TN loss 16/20/24, saturation at
 * 400·tileCost = 6,600/8,000/10,000, and "a tick takes the smallest n tiles
 * whose fractions reach 1": ceil(0.4·b) saturated) and PlayerAttackSpeed
 * (0.632 tiles per tick per border tile at the 0.82 speed floor, plains).
 */
import {
  createModels,
  DefenderStats,
  Models,
  TerrainMix,
} from "../../../src/agent/lib/Models";
import {
  AttackLogicInput,
  Config,
} from "../../../src/core/configuration/Config";
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
import { createGame } from "../../../src/core/game/GameImpl";
import { genTerrainFromBin } from "../../../src/core/game/TerrainMapLoader";
import { UserSettings } from "../../../src/core/game/UserSettings";
import { GameConfig } from "../../../src/core/Schemas";

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

const SIDE = 320; // 102,400 tiles
const TILE_COUNTS = [52, 1_000, 10_000, 100_000];
const TYPES = [PlayerType.Human, PlayerType.Nation, PlayerType.Bot] as const;
const LAND = [
  TerrainType.Plains,
  TerrainType.Highland,
  TerrainType.Mountain,
] as const;
const DIFFICULTIES = [
  Difficulty.Easy,
  Difficulty.Medium,
  Difficulty.Hard,
  Difficulty.Impossible,
];

const pure = (t: TerrainType): TerrainMix => ({
  plains: t === TerrainType.Plains ? 1 : 0,
  highland: t === TerrainType.Highland ? 1 : 0,
  mountain: t === TerrainType.Mountain ? 1 : 0,
});

interface Field {
  game: Game;
  models: Models;
  players: Record<PlayerType, Player>;
}

async function field(): Promise<Field> {
  const land = (w: number, h: number) =>
    genTerrainFromBin(
      { width: w, height: h, num_land_tiles: w * h },
      // bit 7 is land, magnitude 5 is Plains (GameMap.ts:127, :397-407).
      new Uint8Array(w * h).fill(0x80 | 5),
    );
  const config = new Config(GAME_CONFIG, new UserSettings(), false);
  const game = createGame(
    [new PlayerInfo("human", PlayerType.Human, "CLIENT01", "HUMAN001")],
    [],
    await land(SIDE, SIDE),
    await land(SIDE / 2, SIDE / 2),
    config,
  );
  game.endSpawnPhase();
  const players = {
    [PlayerType.Human]: game.player("HUMAN001"),
    [PlayerType.Nation]: game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "NATION01"),
    ),
    [PlayerType.Bot]: game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "TRIBE001"),
    ),
  };
  return { game, models: createModels(game), players };
}

/** Gives `p` exactly the first `n` tiles in raster order and nothing else
 *  (tiles pass between players, so one field serves every type). */
function ownTiles(game: Game, p: Player, n: number) {
  for (let i = 0; i < SIDE * SIDE; i++) {
    const t = game.ref(i % SIDE, Math.floor(i / SIDE));
    if (i < n) {
      if (game.owner(t) !== p) p.conquer(t);
    } else if (game.owner(t) === p) {
      p.relinquish(t);
    }
  }
  expect(p.numTilesOwned()).toBe(n);
}

/** GameImpl's private per-tick hash (GameImpl.ts:661). */
const gameHash = (game: Game) => (game as unknown as { hash(): number }).hash();

/** A Models over another Config: createModels reads only game.config()
 *  (and passes the game to unit costs, unused here). */
function modelsFor(config: Config): Models {
  return createModels({ config: () => config } as unknown as Game);
}

/** The attack tick loop (AttackExecution.ts:293-342) at a constant cost:
 *  tiles taken while the budget of 1 is > 0. */
function replayTick(f: number): number {
  let budget = 1;
  let n = 0;
  while (budget > 0) {
    budget -= f;
    n++;
  }
  return n;
}

describe("apex Models", () => {
  let f: Field;
  beforeAll(async () => {
    f = await field();
  }, 30_000);

  describe("cap and regrowth", () => {
    it("cap and capAt equal config.maxTroops at 52/1e3/1e4/1e5 tiles for Human, Nation and Bot", () => {
      const { game, models } = f;
      const config = game.config();
      for (const type of TYPES) {
        const p = f.players[type];
        for (const n of TILE_COUNTS) {
          ownTiles(game, p, n);
          const want = config.maxTroops(p);
          expect(models.cap(p)).toBe(want);
          expect(models.capAt(type, n, 0)).toBe(want);
          // Nations scale with the difficulty (Config.ts:1044-1056).
          for (const d of DIFFICULTIES) {
            const other = new Config(
              { ...GAME_CONFIG, difficulty: d },
              new UserSettings(),
              false,
            );
            expect(modelsFor(other).capAt(type, n, 0)).toBe(other.maxTroops(p));
          }
        }
      }
      // Arena spot values: a fresh 52-tile spawn (spec §3.1).
      expect(models.capAt(PlayerType.Human, 52, 0)).toBeCloseTo(121_411, 0);
    });

    it("capAt counts finished city levels only, as maxTroops does", () => {
      const { game, models } = f;
      const p = f.players[PlayerType.Human];
      ownTiles(game, p, 1_000);
      const a = p.buildUnit(UnitType.City, game.ref(0, 0), {});
      a.increaseLevel();
      a.increaseLevel(); // level 3
      const b = p.buildUnit(UnitType.City, game.ref(5, 0), {}); // level 1
      const c = p.buildUnit(UnitType.City, game.ref(10, 0), {});
      c.setUnderConstruction(true); // does not count
      expect(models.cap(p)).toBe(game.config().maxTroops(p));
      expect(models.capAt(PlayerType.Human, 1_000, 4)).toBe(models.cap(p));
      expect(models.capAt(PlayerType.Human, 1_000, 4)).toBe(
        models.capAt(PlayerType.Human, 1_000, 0) +
          4 * game.config().cityTroopIncrease(),
      );
      for (const u of [a, b, c]) u.delete(false);
      expect(models.cap(p)).toBe(models.capAt(PlayerType.Human, 1_000, 0));
    });

    it("regrowth and regrowthAt equal config.troopIncreaseRate, below and above the cap", () => {
      const { game, models } = f;
      const config = game.config();
      for (const type of TYPES) {
        const p = f.players[type];
        for (const n of TILE_COUNTS) {
          ownTiles(game, p, n);
          const M = config.maxTroops(p);
          for (const share of [0, 0.01, 0.2, 0.42, 0.9, 0.999, 1, 1.3]) {
            const T = Math.floor(share * M);
            p.setTroops(T);
            const want = config.troopIncreaseRate(p);
            expect(models.regrowth(p)).toBe(want);
            expect(models.regrowthAt(type, T, n, 0)).toBe(want);
            if (T > M) expect(want).toBeCloseTo(M - T, 6); // C2: cut to cap
          }
        }
      }
    });

    it("the regrowth peak lies in [0.41, 0.43]·M", () => {
      const { models } = f;
      for (const type of TYPES) {
        for (const n of TILE_COUNTS) {
          for (const cities of [0, 4]) {
            const M = models.capAt(type, n, cities);
            let best = -Infinity;
            let at = 0;
            for (let i = 0; i <= 1_000; i++) {
              const T = (i / 1_000) * M;
              const g = models.regrowthAt(type, T, n, cities);
              if (g > best) {
                best = g;
                at = T;
              }
            }
            expect(at / M).toBeGreaterThanOrEqual(0.41);
            expect(at / M).toBeLessThanOrEqual(0.43);
          }
        }
      }
    });
  });

  describe("free land", () => {
    it("tn is attackLogic with no defender", () => {
      const { game, models } = f;
      for (const terrain of LAND) {
        for (const stack of [1, 300, 2_000, 6_600, 50_000]) {
          for (const border of [1, 7, 30, 200]) {
            const input: AttackLogicInput = {
              terrain,
              attackTroops: stack,
              attacker: { type: PlayerType.Human, numTiles: 1 },
              defender: null,
              defenderHasDefensePost: false,
              falloutRatio: null,
              borderSize: border,
            };
            expect(models.tn(terrain, stack, border)).toEqual(
              game.config().attackLogic(input),
            );
          }
        }
      }
    });

    it("tnPrice is 16/20/24 and the count-weighted mean of a mix", () => {
      const { models } = f;
      expect(LAND.map((t) => models.tnPrice(pure(t)))).toEqual([16, 20, 24]);
      for (const t of LAND) {
        expect(models.tnPrice(pure(t))).toBe(
          models.tn(t, 5_000, 30).attackerTroopLoss,
        );
      }
      expect(models.tnPrice({ plains: 1, highland: 1, mountain: 1 })).toBe(20);
      expect(
        models.tnPrice({ plains: 30, highland: 10, mountain: 0 }),
      ).toBeCloseTo((30 * 16 + 10 * 20) / 40, 9);
      // No free land in view: plains.
      expect(models.tnPrice({ plains: 0, highland: 0, mountain: 0 })).toBe(16);
    });

    it("tnSaturation is 6,600/8,000/10,000: the fewest troops at the minimum tile cost", () => {
      const { models } = f;
      const sat = LAND.map((t) => models.tnSaturation(pure(t)));
      expect(sat[0]).toBeCloseTo(6_600, 6);
      expect(sat[1]).toBeCloseTo(8_000, 6);
      expect(sat[2]).toBeCloseTo(10_000, 6);
      for (const [i, t] of LAND.entries()) {
        const floor = models.tn(t, 1e9, 30).tickFraction;
        const S = Math.round(sat[i]);
        expect(models.tn(t, S, 30).tickFraction).toBe(floor);
        expect(models.tn(t, S - 1, 30).tickFraction).toBeGreaterThan(floor);
      }
      expect(
        models.tnSaturation({ plains: 1, highland: 0, mountain: 1 }),
      ).toBeCloseTo(8_300, 6);
      expect(
        models.tnSaturation({ plains: 0, highland: 0, mountain: 0 }),
      ).toBeCloseTo(6_600, 6);
    });

    it("a saturated TN tick takes ceil(0.4·b) tiles (FreeLandCost)", () => {
      const { models } = f;
      for (const t of LAND) {
        for (let b = 1; b <= 300; b++) {
          const r = models.tn(t, 20_000, b);
          expect(models.tilesPerTick(r)).toBe(Math.ceil(0.4 * b - 1e-9));
        }
        // The floor: 20·tileCost troops or fewer take ceil(b/50).
        expect(models.tilesPerTick(models.tn(t, 1, 120))).toBe(3);
        expect(models.tilesPerTick(models.tn(t, 1, 10))).toBe(1);
      }
    });
  });

  describe("player defenders", () => {
    const defenders: DefenderStats[] = [
      { type: PlayerType.Bot, tiles: 52, troops: 10_000, isTraitor: false },
      { type: PlayerType.Bot, tiles: 3_000, troops: 9_000, isTraitor: false },
      {
        type: PlayerType.Nation,
        tiles: 20_000,
        troops: 400_000,
        isTraitor: true,
      },
      {
        type: PlayerType.Human,
        tiles: 900_000,
        troops: 2e6,
        isTraitor: false,
        hasDefensePost: true,
      },
    ];
    const attackers = [
      500,
      80_000,
      { type: PlayerType.Nation, tiles: 5_000 },
      { type: PlayerType.Bot, tiles: 700 },
    ] as const;

    const inputFor = (
      a: (typeof attackers)[number],
      d: DefenderStats,
      stack: number,
      terrain: TerrainType,
      border: number,
    ): AttackLogicInput => ({
      terrain,
      attackTroops: stack,
      attacker:
        typeof a === "number"
          ? { type: PlayerType.Human, numTiles: a }
          : { type: a.type, numTiles: a.tiles },
      defender: {
        type: d.type,
        numTiles: d.tiles,
        troops: d.troops,
        isTraitor: d.isTraitor,
        isDisconnectedTeammate: false,
      },
      defenderHasDefensePost: d.hasDefensePost ?? false,
      falloutRatio: null,
      borderSize: border,
    });

    it("hit is one attackLogic call on the same input", () => {
      const { game, models } = f;
      for (const a of attackers) {
        for (const d of defenders) {
          for (const terrain of LAND) {
            for (const stack of [1, 900, 16_667, 1e6]) {
              for (const border of [3, 40]) {
                expect(models.hit(a, d, stack, terrain, border)).toEqual(
                  game
                    .config()
                    .attackLogic(inputFor(a, d, stack, terrain, border)),
                );
              }
            }
          }
        }
      }
    });

    it("hitMix equals hit on a pure mix and the tile-weighted mean on a mixed one", () => {
      const { models } = f;
      for (const a of attackers) {
        for (const d of defenders) {
          for (const stack of [900, 16_667]) {
            for (const t of LAND) {
              const r = models.hit(a, d, stack, t, 12);
              expect(models.hitMix(a, d, stack, pure(t), 12)).toEqual({
                loss: r.attackerTroopLoss,
                tilesPerTick: models.tilesPerTick(r),
              });
            }
            const mix = { plains: 5, highland: 3, mountain: 2 };
            const rs = LAND.map((t) => models.hit(a, d, stack, t, 12));
            const loss =
              (5 * rs[0].attackerTroopLoss +
                3 * rs[1].attackerTroopLoss +
                2 * rs[2].attackerTroopLoss) /
              10;
            const frac =
              (5 * rs[0].tickFraction +
                3 * rs[1].tickFraction +
                2 * rs[2].tickFraction) /
              10;
            const got = models.hitMix(a, d, stack, mix, 12);
            expect(got.loss).toBeCloseTo(loss, 9);
            expect(got.tilesPerTick).toBe(
              Math.max(1, Math.ceil(1 / frac - 1e-9)),
            );
          }
        }
      }
    });

    it("a stack at the 0.6 clamp takes ~0.632 tiles per tick per border tile on plains (PlayerAttackSpeed)", () => {
      const { models } = f;
      const tribe = defenders[1];
      for (const border of [3, 10, 30, 100]) {
        const r = models.hit(
          1_000,
          tribe,
          tribe.troops / 0.6,
          TerrainType.Plains,
          border,
        );
        expect(1 / r.tickFraction / border).toBeCloseTo(0.632, 2);
        expect(models.tilesPerTick(r)).toBe(Math.ceil(border / 1.5825));
      }
    });

    it("tilesPerTick replays the tick loop at a constant cost, at least 1", () => {
      const { models } = f;
      for (let i = 1; i <= 2_000; i++) {
        // Irrational steps stay clear of exact 1/k, where float rounding in
        // the replay (not the game) decides the count.
        const frac = (i * Math.SQRT2) / 1_000;
        const r = { attackerTroopLoss: 0, defenderTroopLoss: 0 };
        expect(models.tilesPerTick({ ...r, tickFraction: frac })).toBe(
          replayTick(frac),
        );
      }
      const r = { attackerTroopLoss: 0, defenderTroopLoss: 0 };
      expect(models.tilesPerTick({ ...r, tickFraction: 5 })).toBe(1);
      expect(models.tilesPerTick({ ...r, tickFraction: 0.25 })).toBe(4);
    });

    it("firstTileLoss is attackLogic at stack 1 (ratio clamped at 2)", () => {
      const { game, models } = f;
      for (const a of attackers) {
        for (const d of defenders) {
          for (const t of LAND) {
            expect(models.firstTileLoss(a, d, t)).toBe(
              game.config().attackLogic(inputFor(a, d, 1, t, 1))
                .attackerTroopLoss,
            );
          }
        }
      }
      // A fresh tribe (10,000 troops on 52 tiles, density 192), spec §3.6.1:
      // 80·0.7·2·(0.463 + 0.0039·192) ≈ 136 on plains, ≈ 204 on mountains.
      const fresh = defenders[0];
      expect(models.firstTileLoss(52, fresh, TerrainType.Plains)).toBeCloseTo(
        136,
        -1,
      );
      expect(models.firstTileLoss(52, fresh, TerrainType.Mountain)).toBeCloseTo(
        204,
        -1,
      );
    });
  });

  it("unitCost is config.unitInfo(t).cost(game, me)", () => {
    const { game, models } = f;
    const p = f.players[PlayerType.Human];
    for (const t of [UnitType.City, UnitType.Port, UnitType.MissileSilo]) {
      expect(models.unitCost(p, t)).toBe(
        game.config().unitInfo(t).cost(game, p),
      );
    }
    expect(models.unitCost(p, UnitType.City)).toBe(125_000n);
  });

  it("reads only: the game's hash is unchanged by every call", () => {
    const { game, models } = f;
    const p = f.players[PlayerType.Nation];
    ownTiles(game, p, 500);
    const before = gameHash(game);
    const troops = p.troops();
    models.cap(p);
    models.capAt(PlayerType.Nation, 1e5, 3);
    models.regrowth(p);
    models.regrowthAt(PlayerType.Bot, 5_000, 200, 1);
    models.hitMix(
      300,
      { type: PlayerType.Bot, tiles: 200, troops: 2_000, isTraitor: false },
      4_000,
      { plains: 1, highland: 2, mountain: 3 },
      9,
    );
    models.unitCost(p, UnitType.City);
    expect(gameHash(game)).toBe(before);
    expect(p.troops()).toBe(troops);
  });
});
