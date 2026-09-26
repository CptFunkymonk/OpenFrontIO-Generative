import {
  Game,
  Player,
  PlayerID,
  PlayerType,
  TerrainType,
  UnitType,
} from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { TerrainMix } from "./Models";

// One border scan per decision (spec §2.3).
//
// Contract: one pass over `me.borderTiles()` with `forEachNeighbor`, the same
// pass as `Perception.scanBorder`, plus `outgoingAttacks()`,
// `incomingAttacks()` and `unitCount`. O(border × 4), under 0.1 ms at 100k
// tiles. `prev` carries `firstSeen` for incoming attacks. The scan never
// calls `nearby()`.
//
// Not in the scan, unlike spec §2.3: `cap`, `regrowth`, `tnStack`,
// `incomingNationSum` and `freeAcrossWater`. Nothing read them, and
// `freeAcrossWater` cost a `me.nearby()` recompute (O(our border)) every
// decision once no free land touched us: 14% of apex's think time on
// GiantWorldMap. Callers that need one compute it (`models.cap(me)`,
// `me.nearby().some((p) => !p.isPlayer())`).
//
// Read-only: only getters. `me.unitCount()` writes a memo keyed by the unit
// version, a pure function of the game state (the kind spec §2.1 allows).

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
  /** troops / tiles. */
  density: number;
  gold: bigint;
  /** me.isFriendly(p). */
  friendly: boolean;
  /** me.canAttackPlayer(p) (nations are immune for 50 ticks). */
  attackable: boolean;
  /** Troops of nation attacks on it (for snipes); tribes only, 0 for
   *  others. "Nation" means an attacker of type Nation or Human other than
   *  us, as in `nations`. */
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
  /** The tick of the first scan that saw this attack (carried by `prev`). */
  firstSeen: number;
}

export interface WorldModel {
  tick: number;
  /** me.troops(). */
  home: number;
  tiles: number;
  gold: bigint;
  /** Non-fallout unowned land adjacency (pairs, as `contact`). */
  freeFrontier: number;
  /** Terrain of the unowned tiles in those pairs. */
  freeMix: TerrainMix;
  /** Every player whose land touches our border, by smallID, ascending. */
  neighbors: Map<number, NeighborInfo>;
  /** Type Bot, attackable, !friendly; ascending smallID. */
  tribes: NeighborInfo[];
  /** Type Nation or Human (friendly ones included); ascending smallID. */
  nations: NeighborInfo[];
  outgoing: OurAttack[];
  incoming: IncomingAttack[];
  /** me.unitCount(TransportShip). */
  boatsInFlight: number;
  /** ≤ SHORE_SAMPLE ocean-shore border tiles, spread evenly over all of
   *  them in border order. */
  shoreSample: TileRef[];
  borderSize: number;
}

/** Most ocean-shore tiles kept in `shoreSample`. */
export const SHORE_SAMPLE = 64;

/** Reused between scans (the scan is synchronous and never re-entered). */
const shoreScratch: TileRef[] = [];

function emptyMix(): TerrainMix {
  return { plains: 0, highland: 0, mountain: 0 };
}

function addTerrain(mix: TerrainMix, t: TerrainType): void {
  if (t === TerrainType.Plains) mix.plains++;
  else if (t === TerrainType.Highland) mix.highland++;
  else if (t === TerrainType.Mountain) mix.mountain++;
}

/** Nations for the WorldModel: anyone who is not a tribe. */
function isNationType(t: PlayerType): boolean {
  return t === PlayerType.Nation || t === PlayerType.Human;
}

interface Contact {
  contact: number;
  mix: TerrainMix;
}

export function scanWorld(
  game: Game,
  me: Player,
  prev: WorldModel | null,
): WorldModel {
  const mySmallID = me.smallID();
  const contacts = new Map<number, Contact>();
  const freeMix = emptyMix();
  let freeFrontier = 0;
  let borderSize = 0;
  shoreScratch.length = 0;

  // Same rules as Perception.scanBorder and PlayerImpl.computeNearby: only
  // passable land counts, unowned land only without fallout.
  const visit = (n: TileRef) => {
    if (!game.isLand(n) || game.isImpassable(n)) return;
    const owner = game.ownerID(n);
    if (owner === mySmallID) return;
    if (owner === 0) {
      if (game.hasFallout(n)) return;
      freeFrontier++;
      addTerrain(freeMix, game.terrainType(n));
      return;
    }
    let c = contacts.get(owner);
    if (c === undefined) {
      c = { contact: 0, mix: emptyMix() };
      contacts.set(owner, c);
    }
    c.contact++;
    addTerrain(c.mix, game.terrainType(n));
  };
  // forEach walks the dense storage (the values() generator is slower).
  me.borderTiles().forEach((tile) => {
    borderSize++;
    if (game.isOceanShore(tile)) shoreScratch.push(tile);
    game.forEachNeighbor(tile, visit);
  });

  const neighbors = new Map<number, NeighborInfo>();
  const tribes: NeighborInfo[] = [];
  const nations: NeighborInfo[] = [];
  const ids = [...contacts.keys()].sort((a, b) => a - b);
  for (const smallID of ids) {
    const p = game.playerBySmallID(smallID);
    if (!p.isPlayer()) continue;
    const c = contacts.get(smallID)!;
    const type = p.type();
    const tiles = p.numTilesOwned();
    const troops = p.troops();
    const friendly = me.isFriendly(p);
    const attackable = me.canAttackPlayer(p);
    const info: NeighborInfo = {
      smallID,
      id: p.id(),
      type,
      contact: c.contact,
      contactMix: c.mix,
      troops,
      tiles,
      density: tiles > 0 ? troops / tiles : 0,
      gold: p.gold(),
      friendly,
      attackable,
      incomingFromNations:
        type === PlayerType.Bot ? nationTroopsOn(p, mySmallID) : 0,
    };
    neighbors.set(smallID, info);
    if (type === PlayerType.Bot) {
      if (attackable && !friendly) tribes.push(info);
    } else if (isNationType(type)) {
      nations.push(info);
    }
  }

  const outgoing: OurAttack[] = [];
  for (const a of me.outgoingAttacks()) {
    const target = a.target();
    outgoing.push({
      id: a.id(),
      targetSmallID: target.isPlayer() ? target.smallID() : 0,
      troops: a.troops(),
      boat: a.sourceTile() !== null,
      retreating: a.retreating(),
    });
  }

  const tick = game.ticks();
  const incoming: IncomingAttack[] = [];
  for (const a of me.incomingAttacks()) {
    const attacker = a.attacker();
    const id = a.id();
    const attackerType = attacker.type();
    const troops = a.troops();
    let firstSeen = tick;
    if (prev !== null) {
      for (const old of prev.incoming) {
        if (old.id === id) {
          firstSeen = old.firstSeen;
          break;
        }
      }
    }
    incoming.push({
      id,
      attackerSmallID: attacker.smallID(),
      attackerType,
      troops,
      boat: a.sourceTile() !== null,
      firstSeen,
    });
  }

  return {
    tick,
    home: me.troops(),
    tiles: me.numTilesOwned(),
    gold: me.gold(),
    freeFrontier,
    freeMix,
    neighbors,
    tribes,
    nations,
    outgoing,
    incoming,
    boatsInFlight: me.unitCount(UnitType.TransportShip),
    shoreSample: spread(shoreScratch, SHORE_SAMPLE),
    borderSize,
  };
}

/** Troops of Nation and Human attacks on `p`, ours excluded. */
function nationTroopsOn(p: Player, mySmallID: number): number {
  let sum = 0;
  for (const a of p.incomingAttacks()) {
    const attacker = a.attacker();
    if (attacker.smallID() === mySmallID) continue;
    if (isNationType(attacker.type())) sum += a.troops();
  }
  return sum;
}

/** Up to `max` entries spread evenly over `all` (a copy). */
function spread(all: readonly TileRef[], max: number): TileRef[] {
  if (all.length <= max) return all.slice();
  const out: TileRef[] = new Array<TileRef>(max);
  for (let i = 0; i < max; i++) {
    out[i] = all[Math.floor((i * all.length) / max)];
  }
  return out;
}
