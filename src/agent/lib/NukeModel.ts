import { Game, Player, PlayerID, UnitType } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { NationModel } from "./NationModel";

// Nuke-rule replica and exposure (spec §2.9). M3: the interface is fixed now,
// the implementation comes later. Types only: the M3 implementation is a
// class with the NukeModelConstructor signature, e.g.
// `class NukeModelImpl implements NukeModel`, or this interface turned into
// the class of the same name.

export type NukeReason =
  | "twoPlayers"
  | "largestAttacker"
  | "dense"
  | "crown50"
  | "allyTarget"
  | "hated"
  | "crownLead"
  | "runnerUp";

export interface NukeExposure {
  nation: PlayerID;
  reason: NukeReason;
  canPay: "atom" | "hydro" | null;
  hasSilo: boolean;
}

export interface NukeModel {
  /** findBestNukeTarget replica (NationNukeBehavior.ts:222-316, 351-417):
   *  who N aims at. */
  aimOf(n: PlayerID): { target: PlayerID | null; reason: NukeReason | null };
  /** Perceived prices: 750k·1.5^atoms, 5M·1.25^hydros launched by N (counted
   *  from observed units). */
  perceivedCost(
    n: PlayerID,
    t: UnitType.AtomBomb | UnitType.HydrogenBomb,
  ): bigint;
  /** Nations that would fire at us now if we owned value (silo ∧ gold ≥ cost
   *  ∧ aim = us). */
  exposures(): NukeExposure[];
  /** True if some aim point of radius R has every ring tile ours or unowned
   *  (isValidNukeTile :686-704) and scores > 0 for this structure set, with
   *  no SAM-interceptable trajectory. */
  nukeable(
    structureTiles: TileRef[],
    bomb: UnitType.AtomBomb | UnitType.HydrogenBomb,
  ): boolean;
}

/** The spec's `constructor(game, me, nm)`. */
export type NukeModelConstructor = new (
  game: Game,
  me: Player,
  nm: NationModel,
) => NukeModel;
