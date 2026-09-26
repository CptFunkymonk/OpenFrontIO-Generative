import { AttackLogicResult, Config } from "../../core/configuration/Config";
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
  /** 1 / tickFraction, floored at 1 (every tick takes at least one tile). */
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

export function createModels(game: Game): Models {
  // TODO(spec §2.2): implement; tests in tests/agent/apex/Models.test.ts (§4 step 1).
  throw new Error("not implemented: createModels");
}
