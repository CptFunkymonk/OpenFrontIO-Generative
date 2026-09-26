import { Game, Player, PlayerType } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";

export interface SpawnWeights {
  /** Unowned land within a few cells: room for the land grab. */
  freeLand: number;
  /** Ocean shore nearby: ports, trade, boats. */
  coast: number;
  /** Distance from the nearest nation or human. */
  isolation: number;
}

export const DEFAULT_SPAWN_WEIGHTS: SpawnWeights = {
  freeLand: 1,
  coast: 0.25,
  isolation: 0.5,
};

// Target cell count for the coarse grid; the map pass itself is strided.
const TARGET_CELLS = 4000;
const NEIGHBORHOOD_CELLS = 3;
const COAST_CELLS = 2;

/**
 * Picks a spawn tile by scoring the map on a coarse grid. One strided pass
 * over the map, so it is affordable once per spawn decision even on the
 * largest maps.
 */
export function planSpawn(
  game: Game,
  me: Player,
  weights: SpawnWeights = DEFAULT_SPAWN_WEIGHTS,
): TileRef | null {
  const w = game.width();
  const h = game.height();
  const cell = Math.max(4, Math.round(Math.sqrt((w * h) / TARGET_CELLS)));
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const free = new Float32Array(cw * ch);
  const shore = new Uint8Array(cw * ch);

  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const t = game.ref(x, y);
      if (!game.isLand(t) || game.isImpassable(t)) continue;
      const c = Math.floor(y / cell) * cw + Math.floor(x / cell);
      if (!game.hasOwner(t)) free[c]++;
      if (game.isOceanShore(t)) shore[c] = 1;
    }
  }

  const threats: TileRef[] = [];
  for (const p of game.allPlayers()) {
    if (p === me || p.type() === PlayerType.Bot) continue;
    const s = p.spawnTile();
    if (s !== undefined) threats.push(s);
  }
  const isolationScale = cell * 12;

  // Normalizer: a fully free neighborhood.
  const span = 2 * NEIGHBORHOOD_CELLS + 1;
  const maxFree = span * span * (cell / 2) * (cell / 2);

  let best: TileRef | null = null;
  let bestScore = -Infinity;
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      if (free[cy * cw + cx] === 0) continue;
      const center = validTileNear(game, cx, cy, cell);
      if (center === null) continue;

      let freeNear = 0;
      let coast = 0;
      for (let dy = -NEIGHBORHOOD_CELLS; dy <= NEIGHBORHOOD_CELLS; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= ch) continue;
        for (let dx = -NEIGHBORHOOD_CELLS; dx <= NEIGHBORHOOD_CELLS; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= cw) continue;
          freeNear += free[y * cw + x];
          if (
            Math.abs(dx) <= COAST_CELLS &&
            Math.abs(dy) <= COAST_CELLS &&
            shore[y * cw + x] === 1
          ) {
            coast = 1;
          }
        }
      }

      let nearest = Infinity;
      for (const s of threats) {
        const d = Math.sqrt(game.euclideanDistSquared(center, s));
        if (d < nearest) nearest = d;
      }
      const isolation = Math.min(1, nearest / isolationScale);

      const score =
        weights.freeLand * (freeNear / maxFree) +
        weights.coast * coast +
        weights.isolation * isolation;
      if (score > bestScore) {
        bestScore = score;
        best = center;
      }
    }
  }
  return best;
}

/** The spawnable tile nearest the middle of a grid cell, if any. */
function validTileNear(
  game: Game,
  cx: number,
  cy: number,
  cell: number,
): TileRef | null {
  const mx = cx * cell + Math.floor(cell / 2);
  const my = cy * cell + Math.floor(cell / 2);
  const spawnable = (x: number, y: number): TileRef | null => {
    if (!game.isValidCoord(x, y)) return null;
    const t = game.ref(x, y);
    return game.isLand(t) && !game.isImpassable(t) && !game.hasOwner(t)
      ? t
      : null;
  };
  // Walk square rings outward from the cell middle, perimeter only.
  for (let r = 0; r <= Math.floor(cell / 2); r++) {
    for (let d = -r; d <= r; d++) {
      const t =
        spawnable(mx + d, my - r) ??
        spawnable(mx + d, my + r) ??
        spawnable(mx - r, my + d) ??
        spawnable(mx + r, my + d);
      if (t !== null) return t;
    }
  }
  return null;
}
