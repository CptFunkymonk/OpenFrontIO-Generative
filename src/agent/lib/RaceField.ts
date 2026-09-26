import { Game, Player, PlayerID } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";

// Coarse grid, arrival fields, spawn candidates, reach and boat targets
// (spec §2.7, used by §3.2 and §3.7).

/**
 * The options RaceField reads: a subset of ApexOptions, which extends this
 * interface, so lib code never imports the agent. Every key is documented
 * in src/agent/agents/apex/options.ts.
 */
export interface RaceFieldOptions {
  spawnCellTarget: number;
  /** Our expected land at ticks 0, 300, 600, 900, 1200, 1800. */
  spawnGrowth: readonly number[];
  spawnTribeDelayTicks: number;
  spawnMarginTicks: number;
  spawnK0: number;
  spawnBeta: number;
  spawnThreatLambda: number;
  spawnSnackBonus: number;
  spawnIdleTicks: number;
  /** θ = min(2, webTarget) needs webTarget (§3.4.1). */
  allySlotsReserve: number;
  /** Below this land share, spawn tiles near an ocean shore are not
   *  penalised (§3.2.3 step 4). */
  waterMapLand: number;
}

export interface RaceGrid {
  /** cell = max(3, round(sqrt(W·H/spawnCellTarget))). */
  cell: number;
  cw: number;
  ch: number;
  /** Passable land tiles per cell. */
  land: Uint16Array;
  /** Unowned passable land tiles per cell. */
  free: Uint16Array;
  /** Mean tnPrice / tnPrice(plains). */
  cost: Float32Array;
  /** Ocean shore flag. */
  shore: Uint8Array;
  /** Landmass id (4-connected land cells). */
  comp: Int32Array;
  compLand: Map<number, number>;
}

/** One full tile pass. */
export function buildRaceGrid(game: Game, o: RaceFieldOptions): RaceGrid {
  // TODO(spec §2.7, §3.2.1): implement; tests in tests/agent/apex/RaceField.test.ts (§4 step 4).
  throw new Error("not implemented: buildRaceGrid");
}

/** Arrival time (ticks) of the others at each cell. */
export interface ArrivalField {
  nation: Float32Array;
  tribe: Float32Array;
}

export function staticArrival(
  grid: RaceGrid,
  game: Game,
  o: RaceFieldOptions,
): ArrivalField {
  // TODO(spec §3.2.2)
  throw new Error("not implemented: staticArrival");
}

export function idleArrival(
  grid: RaceGrid,
  samples: IdleSample[],
  o: RaceFieldOptions,
): ArrivalField {
  // TODO(spec §3.2.2, step 8)
  throw new Error("not implemented: idleArrival");
}

export interface IdleSample {
  tick: number;
  nationOwned: Float32Array;
  tribeOwned: Float32Array;
  nationTroops: Map<PlayerID, number>;
  nationCells: Map<PlayerID, number[]>;
}

export interface SpawnCandidate {
  tile: TileRef;
  cell: number;
  /** Ours, A. */
  free: number;
  /** B. */
  pie: number;
  threat: number;
  snack: boolean;
  source: "race" | "planSpawn" | "island" | "snack";
  score: number;
}

/** Sorted by score, descending. */
export function spawnCandidates(
  grid: RaceGrid,
  arr: ArrivalField,
  game: Game,
  me: Player,
  o: RaceFieldOptions,
): SpawnCandidate[] {
  // TODO(spec §3.2.3)
  throw new Error("not implemented: spawnCandidates");
}

/** Every 100 ticks: coarse owner grid for reach and boat targets. */
export interface OwnerGrid {
  /** smallID or 0. */
  owner: Int32Array;
  stamp: number;
}

export function ownerGrid(
  game: Game,
  grid: RaceGrid,
  stride: number,
): OwnerGrid {
  // TODO(spec §2.7, §3.0 cadence table)
  throw new Error("not implemented: ownerGrid");
}

/** smallID -> cell distance. */
export function reachCells(
  og: OwnerGrid,
  grid: RaceGrid,
  fromSmallID: number,
  maxCells: number,
): Map<number, number> {
  // TODO(spec §3.4.2)
  throw new Error("not implemented: reachCells");
}

export interface BoatTarget {
  tile: TileRef;
  comp: number;
  food: number;
  tn: boolean;
  tribeSmallID: number | null;
  score: number;
}

export function boatTargets(
  game: Game,
  grid: RaceGrid,
  og: OwnerGrid,
  me: Player,
  max: number,
): BoatTarget[] {
  // TODO(spec §3.7): implement; tests in tests/agent/apex/Naval.test.ts (§4 step 6).
  throw new Error("not implemented: boatTargets");
}
