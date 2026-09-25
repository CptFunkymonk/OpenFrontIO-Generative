import { Game, Player, PlayerType, UnitType } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { PseudoRandom } from "../../core/PseudoRandom";

// Read-only helpers shared by agents. Everything here only reads the game.

export interface Neighbor {
  player: Player;
  /** Tile adjacencies between our border and theirs (a frontage measure). */
  contact: number;
}

export interface BorderScan {
  /** Adjacencies between our border and conquerable unowned land. */
  freeFrontier: number;
  /** Players we share a land border with, keyed by smallID. */
  neighbors: Map<number, Neighbor>;
  /** Our border tiles that touch the ocean: candidate port sites. */
  oceanShore: TileRef[];
  borderSize: number;
}

/** One pass over our border tiles. Cost is linear in the border length. */
export function scanBorder(game: Game, me: Player): BorderScan {
  const neighbors = new Map<number, Neighbor>();
  const oceanShore: TileRef[] = [];
  const mySmallID = me.smallID();
  let freeFrontier = 0;
  let borderSize = 0;
  for (const tile of me.borderTiles()) {
    borderSize++;
    if (game.isOceanShore(tile)) oceanShore.push(tile);
    game.forEachNeighbor(tile, (n) => {
      if (!game.isLand(n) || game.isImpassable(n)) return;
      const owner = game.ownerID(n);
      if (owner === mySmallID) return;
      if (owner === 0) {
        if (!game.hasFallout(n)) freeFrontier++;
        return;
      }
      const entry = neighbors.get(owner);
      if (entry !== undefined) {
        entry.contact++;
      } else {
        const player = game.playerBySmallID(owner);
        if (player.isPlayer()) neighbors.set(owner, { player, contact: 1 });
      }
    });
  }
  return { freeFrontier, neighbors, oceanShore, borderSize };
}

export function maxTroops(game: Game, p: Player): number {
  return game.config().maxTroops(p);
}

/** Share of the land that counts toward the 80% win condition. */
export function landShare(game: Game, p: Player): number {
  const land = game.numLandTiles() - game.numTilesWithFallout();
  return land > 0 ? p.numTilesOwned() / land : 0;
}

export function unitCost(game: Game, me: Player, type: UnitType): bigint {
  return game.config().unitInfo(type).cost(game, me);
}

export function isBot(p: Player): boolean {
  return p.type() === PlayerType.Bot;
}

export function incomingTroops(me: Player): number {
  let sum = 0;
  for (const a of me.incomingAttacks()) sum += a.troops();
  return sum;
}

/** Troops committed to our attacks on unowned land. */
export function troopsAttackingFreeLand(me: Player): number {
  let sum = 0;
  for (const a of me.outgoingAttacks()) {
    if (!a.target().isPlayer()) sum += a.troops();
  }
  return sum;
}

/** Up to `count` tiles spread evenly over a tile set. */
export function sampleTiles(
  tiles: Iterable<TileRef>,
  size: number,
  count: number,
): TileRef[] {
  const stride = Math.max(1, Math.floor(size / count));
  const out: TileRef[] = [];
  let i = 0;
  for (const t of tiles) {
    if (i++ % stride === 0) out.push(t);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * A tile of ours far from our border: the safest place for a structure.
 * Approximate (sampled), so it costs O(samples^2), not O(territory).
 */
export function pickInteriorTile(
  game: Game,
  me: Player,
  random: PseudoRandom,
  accept: (tile: TileRef) => boolean = () => true,
  samples = 64,
): TileRef | null {
  const border = sampleTiles(me.borderTiles(), me.borderTiles().size, samples);
  const candidates = sampleTiles(me.tiles(), me.numTilesOwned(), samples * 4);
  let best: TileRef | null = null;
  let bestDist = -1;
  for (const c of candidates) {
    if (!accept(c)) continue;
    let nearest = Infinity;
    for (const b of border) {
      const d = game.manhattanDist(c, b);
      if (d < nearest) nearest = d;
    }
    // Small jitter so ties do not always pick the same corner.
    const score = nearest + random.nextInt(0, 3);
    if (score > bestDist) {
      bestDist = score;
      best = c;
    }
  }
  return best;
}
