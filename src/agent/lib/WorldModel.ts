import { Game, Player, PlayerID, PlayerType } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { TerrainMix } from "./Models";

// One border scan per decision (spec §2.3).
//
// Contract: one pass over `me.borderTiles()` with `forEachNeighbor`, the same
// pass as `Perception.scanBorder`, plus `outgoingAttacks()`,
// `incomingAttacks()` and `unitCount`. O(border × 4), under 0.1 ms at 100k
// tiles. `prev` carries `firstSeen` for incoming attacks. The scan never
// calls `nearby()` on other players.

export interface NeighborInfo {
  smallID: number;
  id: PlayerID;
  type: PlayerType;
  /** Adjacency pairs: our border tile -> its tile. */
  contact: number;
  /** Terrain of ITS tiles in those pairs. */
  contactMix: TerrainMix;
  troops: number;
  tiles: number;
  density: number;
  gold: bigint;
  /** me.isFriendly(p). */
  friendly: boolean;
  /** me.canAttackPlayer(p) (nations are immune for 50 ticks). */
  attackable: boolean;
  /** Troops of nation attacks on it (for snipes); tribes only. */
  incomingFromNations: number;
}

export interface OurAttack {
  id: string;
  /** 0 = TN. */
  targetSmallID: number;
  troops: number;
  /** sourceTile !== null. */
  boat: boolean;
  retreating: boolean;
}

export interface IncomingAttack {
  id: string;
  attackerSmallID: number;
  attackerType: PlayerType;
  troops: number;
  boat: boolean;
  firstSeen: number;
}

export interface WorldModel {
  tick: number;
  home: number;
  cap: number;
  regrowth: number;
  tiles: number;
  gold: bigint;
  /** Non-fallout unowned land adjacency. */
  freeFrontier: number;
  freeMix: TerrainMix;
  /** me.nearby() has TerraNullius and freeFrontier == 0. */
  freeAcrossWater: boolean;
  neighbors: Map<number, NeighborInfo>;
  /** Type Bot, attackable, !friendly. */
  tribes: NeighborInfo[];
  /** Type Nation or Human. */
  nations: NeighborInfo[];
  outgoing: OurAttack[];
  /** Sum of land TN attacks. */
  tnStack: number;
  incoming: IncomingAttack[];
  incomingNationSum: number;
  /** me.unitCount(TransportShip). */
  boatsInFlight: number;
  /** ≤ 64 ocean-shore border tiles. */
  shoreSample: TileRef[];
  borderSize: number;
}

export function scanWorld(
  game: Game,
  me: Player,
  prev: WorldModel | null,
): WorldModel {
  // TODO(spec §2.3): implement; tests in tests/agent/apex/WorldModel.test.ts (§4 step 1).
  throw new Error("not implemented: scanWorld");
}
