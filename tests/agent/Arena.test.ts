import path from "path";
import zlib from "zlib";
import { AGENTS } from "../../src/agent/agents";
import { ArenaGameSpec, runArenaGame } from "../../src/agent/arena/ArenaGame";
import { encodePng } from "../../src/agent/arena/TerritoryImage";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameType,
} from "../../src/core/game/Game";

// tests/testdata/maps/world is laid out like resources/maps, so the arena's
// map loader can serve it for GameMapType.World.
const MAPS = path.join(__dirname, "../testdata/maps");
const TIMEOUT = 120_000;

function spec(overrides: Partial<ArenaGameSpec> = {}): ArenaGameSpec {
  return {
    index: 0,
    gameID: "ARENATST",
    map: GameMapType.World,
    mapSize: GameMapSize.Compact,
    difficulty: Difficulty.Impossible,
    nations: 4,
    bots: 10,
    gameType: GameType.Singleplayer,
    seats: [{ agent: "baseline" }],
    maxTicks: 600,
    latencyTicks: 1,
    rateLimit: true,
    isolate: false,
    timelineEvery: 100,
    playOut: false,
    strict: true,
    imagesDir: null,
    imageEvery: 0,
    ...overrides,
  };
}

describe("arena", () => {
  beforeAll(() => {
    console.debug = () => {};
  });

  test(
    "the baseline agent spawns and expands against the built-in AI",
    async () => {
      const r = await runArenaGame(spec(), MAPS);
      expect(r.error).toBeNull();
      const seat = r.seats[0];
      expect(seat.stats.errors).toBe(0);
      expect(seat.stats.intentsByType.spawn).toBe(1);
      expect(seat.stats.intentsRateLimited).toBe(0);
      const last = seat.timeline[seat.timeline.length - 1];
      expect(last.tick).toBe(600);
      expect(last.tiles).toBeGreaterThan(500);
      expect(seat.peakShare).toBeGreaterThan(0);
      expect(seat.result).toBe("timeout");
      expect(r.nationsInGame).toBe(4);
    },
    TIMEOUT,
  );

  test(
    "the same spec replays the same game",
    async () => {
      const a = await runArenaGame(spec({ maxTicks: 400 }), MAPS);
      const b = await runArenaGame(spec({ maxTicks: 400 }), MAPS);
      expect(b.seats[0].timeline).toEqual(a.seats[0].timeline);
      expect(b.leaders).toEqual(a.leaders);
    },
    TIMEOUT,
  );

  test(
    "isolation passes a read-only agent and catches a mutating one",
    async () => {
      const clean = await runArenaGame(
        spec({ isolate: true, maxTicks: 400 }),
        MAPS,
      );
      expect(clean.error).toBeNull();

      AGENTS.cheater = () => ({
        name: "cheater",
        tick(ctx) {
          if (ctx.game.inSpawnPhase() && !ctx.me.hasSpawned()) {
            AGENTS.baseline().tick(ctx);
          } else if (ctx.me.hasSpawned()) {
            ctx.me.addTroops(1000); // forbidden: mutates the game
          }
        },
      });
      try {
        const dirty = await runArenaGame(
          spec({ isolate: true, maxTicks: 400, seats: [{ agent: "cheater" }] }),
          MAPS,
        );
        expect(dirty.error).toMatch(/diverged/);
      } finally {
        delete AGENTS.cheater;
      }
    },
    TIMEOUT,
  );
});

describe("encodePng", () => {
  test("writes a valid RGB PNG", () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    const png = encodePng(2, 2, rgb);
    expect([...png.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(png.readUInt32BE(16)).toBe(2); // IHDR width
    expect(png.readUInt32BE(20)).toBe(2); // IHDR height
    const idatLen = png.readUInt32BE(33);
    expect(png.toString("ascii", 37, 41)).toBe("IDAT");
    const raw = zlib.inflateSync(png.subarray(41, 41 + idatLen));
    // Two scanlines, each a filter byte plus 2 RGB pixels.
    expect([...raw]).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 9, 9, 9]);
  });
});
