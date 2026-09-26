import { GameMapType } from "../../core/game/Game";
import { GameMapLoader, MapData } from "../../core/game/GameMapLoader";

/**
 * Memoizes another loader's file reads, so a replica and its lookahead forks
 * download each map file once. Consumers must not mutate the returned bytes;
 * loadTerrainMap (with `fresh`) and TerrainSource copy before mutating.
 */
export class CachingMapLoader implements GameMapLoader {
  private readonly cache = new Map<GameMapType, MapData>();

  constructor(private readonly inner: GameMapLoader) {}

  getMapData(map: GameMapType): MapData {
    const hit = this.cache.get(map);
    if (hit !== undefined) return hit;
    const data = this.inner.getMapData(map);
    const once = <T>(load: () => Promise<T>): (() => Promise<T>) => {
      let p: Promise<T> | null = null;
      return () => (p ??= load());
    };
    const cached: MapData = {
      ...data,
      mapBin: once(data.mapBin),
      map4xBin: once(data.map4xBin),
      map16xBin: once(data.map16xBin),
      manifest: once(data.manifest),
    };
    this.cache.set(map, cached);
    return cached;
  }
}
