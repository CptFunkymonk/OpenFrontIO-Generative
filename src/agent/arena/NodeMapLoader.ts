import fs from "fs";
import path from "path";
import { GameMapType } from "../../core/game/Game";
import { GameMapLoader, MapData } from "../../core/game/GameMapLoader";
import { MapManifest } from "../../core/game/TerrainMapLoader";

/**
 * Reads production maps from resources/maps/<lowercased enum key>/, the
 * layout the client's loaders use. File contents are cached per loader, so
 * the authoritative game, isolated replicas and lookahead forks of one arena
 * game read each file once. Callers must not mutate the returned bytes
 * (loadTerrainMap copies them when it needs to).
 */
export class NodeMapLoader implements GameMapLoader {
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(private readonly mapsDir: string) {}

  static dirName(map: GameMapType): string {
    const key = Object.keys(GameMapType).find(
      (k) => GameMapType[k as keyof typeof GameMapType] === map,
    );
    if (key === undefined) throw new Error(`unknown map: ${map}`);
    return key.toLowerCase();
  }

  getMapData(map: GameMapType): MapData {
    const dir = path.join(this.mapsDir, NodeMapLoader.dirName(map));
    const cached =
      <T>(file: string, read: (p: string) => T) =>
      () => {
        const key = path.join(dir, file);
        let hit = this.cache.get(key) as Promise<T> | undefined;
        if (hit === undefined) {
          hit = fs.promises.access(key).then(() => read(key));
          this.cache.set(key, hit);
        }
        return hit;
      };
    const bin = (file: string) =>
      cached(file, (p) => new Uint8Array(fs.readFileSync(p)));
    return {
      mapBin: bin("map.bin"),
      map4xBin: bin("map4x.bin"),
      map16xBin: bin("map16x.bin"),
      manifest: cached(
        "manifest.json",
        (p) => JSON.parse(fs.readFileSync(p, "utf8")) as MapManifest,
      ),
      webpPath: path.join(dir, "thumbnail.webp"),
      layerPng: async () => {
        throw new Error("map layers are not loaded headless");
      },
    };
  }
}
