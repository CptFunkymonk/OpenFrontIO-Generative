import {
  AttackLogicInput,
  AttackLogicResult,
  Config,
} from "../../core/configuration/Config";
import {
  Game,
  Player,
  PlayerType,
  TerrainType,
  UnitType,
} from "../../core/game/Game";

// Wrappers and read-only shims around game.config() formulas (spec §2.2).
// Pure and allocation-light: each `hit` is one attackLogic call. Border sizes
// passed in include the mean jitter +2 (AttackExecution.ts:291:
// `borderSize() + nextInt(0, 5)`). Never copy a constant the config exposes.

/** Tile counts by terrain. */
export interface TerrainMix {
  plains: number;
  highland: number;
  mountain: number;
}

export interface DefenderStats {
  type: PlayerType;
  tiles: number;
  troops: number;
  isTraitor: boolean;
  /** Default false. */
  hasDefensePost?: boolean;
}

/** A number means "us": a Human with that many tiles. */
export type AttackerStats = number | { type: PlayerType; tiles: number };

export interface Models {
  readonly config: Config;
  /** config.maxTroops(p). */
  cap(p: Player): number;
  /** maxTroops of a hypothetical player via a read-only shim (type,
   *  numTilesOwned, units(City) with finished levels, isLobbyCreator=false).
   *  Must equal cap(p) for live players (unit test). */
  capAt(type: PlayerType, tiles: number, cityLevels: number): number;
  /** config.troopIncreaseRate(p): troops added next tick (may be negative
   *  above cap). */
  regrowth(p: Player): number;
  regrowthAt(
    type: PlayerType,
    troops: number,
    tiles: number,
    cityLevels: number,
  ): number;
  /** Free land: attackLogic with defender null. */
  tn(terrain: TerrainType, stack: number, border: number): AttackLogicResult;
  /** Mean TN attackerTroopLoss over the mix (16/20/24; mag/5). */
  tnPrice(mix: TerrainMix): number;
  /** Troops at which the TN speed stops rising: 2000·tileCost/5
   *  (6,600/8,000/10,000). tileCost is read back as
   *  tickFraction(2000 troops)·2·border, never hard-coded. */
  tnSaturation(mix: TerrainMix): number;
  /** attackLogic against a player defender (falloutRatio null). */
  hit(
    attacker: AttackerStats,
    d: DefenderStats,
    stack: number,
    terrain: TerrainType,
    border: number,
  ): AttackLogicResult;
  /** Mix-weighted hit(): loss and tiles/tick averaged over the contact
   *  terrain. */
  hitMix(
    attacker: AttackerStats,
    d: DefenderStats,
    stack: number,
    mix: TerrainMix,
    border: number,
  ): { loss: number; tilesPerTick: number };
  /** Tiles one tick takes at this constant cost: the smallest n with
   *  n·tickFraction ≥ 1, i.e. ceil(1 / tickFraction), and at least 1 (every
   *  tick takes at least one tile). */
  tilesPerTick(r: AttackLogicResult): number;
  /** Largest possible first-tile loss (ratio clamped at 2): attackLogic with
   *  stack 1. */
  firstTileLoss(
    attacker: AttackerStats,
    d: DefenderStats,
    terrain: TerrainType,
  ): number;
  /** config.unitInfo(t).cost(game, me). */
  unitCost(me: Player, t: UnitType): bigint;
}

/** The land terrains of a TerrainMix, in field order. */
const MIX_TERRAINS = [
  TerrainType.Plains,
  TerrainType.Highland,
  TerrainType.Mountain,
] as const;

/** Stack at which the TN tile cost is read back (spec §2.2). It lies in the
 *  linear range of within(scale·tileCost/stack, min, max) on every land
 *  terrain, which the tests check. */
const TN_PROBE_STACK = 2000;
/** A stack far past every saturation point: its tickFraction is the floor. */
const TN_HUGE_STACK = 1e12;
/** Any border works for the read-back: tickFraction scales as 1/border. */
const PROBE_BORDER = 100;
/** Slack for ceil(1/f) when 1/f is an integer up to rounding
 *  (5/60 → 12.000000000000002 must count 12 tiles, as the pins do). */
const CEIL_EPS = 1e-9;

/** The finished-city stand-in: one "city" carrying every level. */
interface CityShim {
  lvl: number;
  isUnderConstruction(): boolean;
  level(): number;
}

/**
 * A read-only stand-in for a Player with exactly the methods that
 * Config.maxTroops and Config.troopIncreaseRate read (Config.ts:1024-1090):
 * type, numTilesOwned, troops, units(City) (isUnderConstruction, level) and
 * isLobbyCreator (host cheats only). One instance is reused per Models.
 */
class PlayerShim {
  kind: PlayerType = PlayerType.Human;
  tiles = 0;
  troopCount = 0;
  cities: CityShim[] = [];
  private readonly none: CityShim[] = [];
  private readonly one: CityShim[];
  private readonly city: CityShim = {
    lvl: 0,
    isUnderConstruction: () => false,
    level: () => this.city.lvl,
  };

  constructor() {
    this.one = [this.city];
  }

  set(type: PlayerType, troops: number, tiles: number, cityLevels: number) {
    this.kind = type;
    this.troopCount = troops;
    this.tiles = Math.max(0, tiles);
    if (cityLevels > 0) {
      this.city.lvl = cityLevels;
      this.cities = this.one;
    } else {
      this.cities = this.none;
    }
    return this as unknown as Player;
  }

  type(): PlayerType {
    return this.kind;
  }
  numTilesOwned(): number {
    return this.tiles;
  }
  troops(): number {
    return this.troopCount;
  }
  units(): CityShim[] {
    return this.cities;
  }
  isLobbyCreator(): boolean {
    return false;
  }
}

function mixTotal(mix: TerrainMix): number {
  return mix.plains + mix.highland + mix.mountain;
}

function mixCount(mix: TerrainMix, i: number): number {
  return i === 0 ? mix.plains : i === 1 ? mix.highland : mix.mountain;
}

class ModelsImpl implements Models {
  readonly config: Config;
  private readonly shim = new PlayerShim();
  /** TN loss and saturation by MIX_TERRAINS index (a Human attacker). */
  private readonly tnLoss: number[];
  private readonly tnSat: number[];
  // One input object reused by every attackLogic call (it is read, never
  // kept, by the config).
  private readonly attacker = { type: PlayerType.Human, numTiles: 1 };
  private readonly defender = {
    type: PlayerType.Bot,
    numTiles: 1,
    troops: 0,
    isTraitor: false,
    isDisconnectedTeammate: false,
  };
  private readonly input: AttackLogicInput = {
    terrain: TerrainType.Plains,
    attackTroops: 1,
    attacker: this.attacker,
    defender: null,
    defenderHasDefensePost: false,
    falloutRatio: null,
    borderSize: 1,
  };

  constructor(private readonly game: Game) {
    this.config = game.config();
    this.tnLoss = MIX_TERRAINS.map(
      (t) => this.tn(t, TN_PROBE_STACK, PROBE_BORDER).attackerTroopLoss,
    );
    this.tnSat = MIX_TERRAINS.map((t) => {
      // tickFraction = within(scale·tileCost/stack, min, max) / (2·border):
      // at the probe stack it is scale·tileCost/probe/(2b), past saturation
      // min/(2b), so the saturation stack scale·tileCost/min is their ratio
      // times the probe.
      const probe = this.tn(t, TN_PROBE_STACK, PROBE_BORDER).tickFraction;
      const floor = this.tn(t, TN_HUGE_STACK, PROBE_BORDER).tickFraction;
      return (TN_PROBE_STACK * probe) / floor;
    });
  }

  cap(p: Player): number {
    return this.config.maxTroops(p);
  }

  capAt(type: PlayerType, tiles: number, cityLevels: number): number {
    return this.config.maxTroops(this.shim.set(type, 0, tiles, cityLevels));
  }

  regrowth(p: Player): number {
    return this.config.troopIncreaseRate(p);
  }

  regrowthAt(
    type: PlayerType,
    troops: number,
    tiles: number,
    cityLevels: number,
  ): number {
    return this.config.troopIncreaseRate(
      this.shim.set(type, troops, tiles, cityLevels),
    );
  }

  tn(terrain: TerrainType, stack: number, border: number): AttackLogicResult {
    const input = this.input;
    this.attacker.type = PlayerType.Human;
    this.attacker.numTiles = 1;
    input.terrain = terrain;
    input.attackTroops = stack;
    input.defender = null;
    input.defenderHasDefensePost = false;
    input.borderSize = border;
    return this.config.attackLogic(input);
  }

  tnPrice(mix: TerrainMix): number {
    return this.mixMean(mix, this.tnLoss);
  }

  tnSaturation(mix: TerrainMix): number {
    return this.mixMean(mix, this.tnSat);
  }

  hit(
    attacker: AttackerStats,
    d: DefenderStats,
    stack: number,
    terrain: TerrainType,
    border: number,
  ): AttackLogicResult {
    const input = this.input;
    if (typeof attacker === "number") {
      this.attacker.type = PlayerType.Human;
      this.attacker.numTiles = Math.max(1, attacker);
    } else {
      this.attacker.type = attacker.type;
      this.attacker.numTiles = Math.max(1, attacker.tiles);
    }
    const def = this.defender;
    def.type = d.type;
    def.numTiles = Math.max(1, d.tiles);
    def.troops = d.troops;
    def.isTraitor = d.isTraitor;
    input.terrain = terrain;
    // A stack below 1 troop is deleted before it takes a tile
    // (AttackExecution.ts:296-300); the clamp also keeps 0/0 out.
    input.attackTroops = Math.max(1, stack);
    input.defender = def;
    input.defenderHasDefensePost = d.hasDefensePost ?? false;
    input.borderSize = border;
    return this.config.attackLogic(input);
  }

  hitMix(
    attacker: AttackerStats,
    d: DefenderStats,
    stack: number,
    mix: TerrainMix,
    border: number,
  ): { loss: number; tilesPerTick: number } {
    const total = mixTotal(mix);
    if (total <= 0) {
      const r = this.hit(attacker, d, stack, TerrainType.Plains, border);
      return { loss: r.attackerTroopLoss, tilesPerTick: this.tilesPerTick(r) };
    }
    // Tiles fall in proportion to the mix: loss is the mean per tile, and a
    // tick takes tiles until the mean fraction adds up to 1.
    let loss = 0;
    let fraction = 0;
    for (let i = 0; i < MIX_TERRAINS.length; i++) {
      const n = mixCount(mix, i);
      if (n <= 0) continue;
      const r = this.hit(attacker, d, stack, MIX_TERRAINS[i], border);
      loss += (n / total) * r.attackerTroopLoss;
      fraction += (n / total) * r.tickFraction;
    }
    return { loss, tilesPerTick: tilesFor(fraction) };
  }

  tilesPerTick(r: AttackLogicResult): number {
    return tilesFor(r.tickFraction);
  }

  firstTileLoss(
    attacker: AttackerStats,
    d: DefenderStats,
    terrain: TerrainType,
  ): number {
    return this.hit(attacker, d, 1, terrain, 1).attackerTroopLoss;
  }

  unitCost(me: Player, t: UnitType): bigint {
    return this.config.unitInfo(t).cost(this.game, me);
  }

  /** Count-weighted mean of a per-terrain value; plains for an empty mix. */
  private mixMean(mix: TerrainMix, byTerrain: number[]): number {
    const total = mixTotal(mix);
    if (total <= 0) return byTerrain[0];
    return (
      (mix.plains * byTerrain[0] +
        mix.highland * byTerrain[1] +
        mix.mountain * byTerrain[2]) /
      total
    );
  }
}

/** Tiles one tick takes at a constant tickFraction f (AttackExecution.ts:
 *  293-342: the loop runs while the budget of 1 is > 0), at least 1. */
function tilesFor(f: number): number {
  if (!(f > 0)) return 1;
  return Math.max(1, Math.ceil(1 / f - CEIL_EPS));
}

export function createModels(game: Game): Models {
  return new ModelsImpl(game);
}
