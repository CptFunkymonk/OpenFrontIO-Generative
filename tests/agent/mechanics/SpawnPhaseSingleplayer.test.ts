/**
 * Pins roadmap H1 (docs/11-roadmap.md §11.3): the spawn-phase mechanics an
 * agent's spawn choice rests on, in the arena's setting (FFA singleplayer,
 * Impossible, the map's default nations, 400 tribes, Normal size). The game
 * is built exactly as the arena builds it: arenaGameStart
 * (src/agent/arena/ArenaGame.ts) feeds createGameRunner
 * (src/core/GameRunner.ts:40-98), which makes the real Config; nothing here
 * goes through tests/util/TestConfig. Map: World from resources/maps.
 *
 * Tick bookkeeping used throughout: turn i runs in tick i. Executions created
 * from a turn are init()ed at the end of that tick and first tick()ed in the
 * next one (GameImpl.executeNextTick, GameImpl.ts:529-547), so a spawn intent
 * in turn t lands in tick t+1. After tick i has run, game.ticks() === i + 1
 * (GameImpl.ts:582).
 *
 * The claim and what the code does instead:
 * - TRUE, the phase is untimed. GameRunner.init adds SpawnTimerExecution only
 *   when gameType !== Singleplayer (GameRunner.ts:170-173); the phase ends in
 *   SpawnExecution.tick when a Human spawns (SpawnExecution.ts:121-128).
 *   Config.numSpawnPhaseTurns() answers 100 for singleplayer
 *   (Config.ts:856-859) but no timer uses it, so the docs/01 §1.6 row
 *   "Spawn phase, singleplayer: 100 ticks" is wrong for this setting. It is
 *   not free to wait, though: game.ticks() keeps counting, and nation
 *   diplomacy compares absolute ticks with that 100 (alliance requests
 *   created by tick 101 are rejected, NationAllianceBehavior.ts:67;
 *   Impossible's early-game acceptance ends at tick 700,
 *   NationAllianceBehavior.ts:218-245). Win and overtime clocks
 *   (elapsedGameSeconds, GameImpl.ts:966-983) start at the phase end.
 * - TRUE, nothing grows. PlayerExecution, TribeExecution and AttackExecution
 *   return false from activeDuringSpawnPhase (PlayerExecution.ts:44,
 *   TribeExecution.ts:43, AttackExecution.ts:71), and executeNextTick neither
 *   ticks nor init()s those during the phase (GameImpl.ts:529-547).
 * - PARTIAL, "tribes are placed on the first tick": tick 0 only init()s the
 *   tribes' SpawnExecutions; they land in tick 1. Nations pick a tile in
 *   tick 1 (NationExecution.tick, NationExecution.ts:126-180), before the
 *   tribes exist, and land in tick 2, so a tribe can cut their disc.
 * - PARTIAL, "±25 tiles of the manifest position": randomSpawnLand draws
 *   nextInt(c - 25, c + 25), which is half-open (PseudoRandom.ts:61-65), so
 *   the spawn tile is in [c-25, c+24] on each axis
 *   (NationExecution.ts:282-311). The claim leaves out that nations hop to a
 *   fresh draw every attackRate ticks (nextInt(30, 50) at Impossible,
 *   NationExecution.ts:102-103; hop at :127-134) for as long as the phase
 *   lasts, and that a hop decided in the tick we spawn lands one tick after
 *   the phase ended (internal spawns skip the intent gate,
 *   SpawnExecution.ts:45-48, 87-89).
 * - TRUE, starting troops: us 25,000, Impossible nations 31,250, tribes
 *   10,000 (Config.startManpower, Config.ts:1003-1022, applied once in
 *   GameImpl.addPlayer, GameImpl.ts:718-724).
 * - Our spawn takes the free passable land of a 52-tile disc around the
 *   chosen tile and never an owned tile (getSpawnTiles(.., false),
 *   execution/Util.ts:140-159; SpawnExecution.getSpawn, :139-148). Neither
 *   the centre's owner nor its terrain is checked. A disc with no free land
 *   fails silently and leaves the phase open (SpawnExecution.ts:102-106).
 */
import fs from "fs";
import path from "path";
import {
  arenaGameStart,
  seatClientID,
  type ArenaGameSpec,
} from "../../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../../src/agent/arena/NodeMapLoader";
import { SpawnTimerExecution } from "../../../src/core/execution/SpawnTimerExecution";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Player,
  PlayerType,
} from "../../../src/core/game/Game";
import { GameImpl } from "../../../src/core/game/GameImpl";
import { TileRef } from "../../../src/core/game/GameMap";
import {
  GameUpdateType,
  GameUpdateViewData,
  SpawnPhaseEndUpdate,
} from "../../../src/core/game/GameUpdates";
import { createGameRunner, GameRunner } from "../../../src/core/GameRunner";
import { Intent } from "../../../src/core/Schemas";

const MAPS = path.join(__dirname, "../../../resources/maps");
const MAP = GameMapType.World;
const BOTS = 400;
const ME = seatClientID(0);
const TIMEOUT = 20_000;

interface Sim {
  runner: GameRunner;
  game: Game;
  me: Player;
  /** Runs the next turn (= the next tick) with these intents from us. */
  step(intents?: Intent[]): GameUpdateViewData;
}

async function newSim(gameID = "SPAWNPIN"): Promise<Sim> {
  // The fields arenaGameStart reads; the rest of ArenaGameSpec only steers
  // the arena's loop, which this test replaces with its own.
  const spec: Pick<
    ArenaGameSpec,
    | "gameID"
    | "map"
    | "mapSize"
    | "gameType"
    | "difficulty"
    | "nations"
    | "bots"
    | "seats"
  > = {
    gameID,
    map: MAP,
    mapSize: GameMapSize.Normal,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Impossible,
    nations: "default",
    bots: BOTS,
    seats: [{ agent: "baseline" }],
  };
  let last: GameUpdateViewData | null = null;
  const runner = await createGameRunner(
    arenaGameStart(spec as ArenaGameSpec),
    undefined,
    new NodeMapLoader(MAPS),
    (gu) => {
      if ("errMsg" in gu) throw new Error(gu.errMsg);
      last = gu;
    },
  );
  const game = runner.game;
  const me = game.playerByClientID(ME);
  if (me === null) throw new Error("no seat player");
  return {
    runner,
    game,
    me,
    step(intents: Intent[] = []) {
      runner.addTurn({
        turnNumber: game.ticks(),
        intents: intents.map((i) => ({ ...i, clientID: ME })),
      });
      last = null;
      expect(runner.executeNextTick()).toBe(true);
      if (last === null) throw new Error("no update");
      return last;
    },
  };
}

const spawnAt = (tile: TileRef): Intent => ({ type: "spawn", tile });

/**
 * The spawn disc, re-derived from the geometry rather than by calling
 * getSpawnTiles: euclDistFN(center, 4, true) (GameMap.ts:715-735) shifts the
 * root by -0.5 and keeps dx^2 + dy^2 <= 16, and getSpawnTiles BFS-floods it
 * (execution/Util.ts:140-159). That is the 8x8 box x-4..x+3, y-4..y+3 minus
 * 3 tiles at each corner: 52 tiles, clipped by the map edge.
 */
function disc(game: Game, center: TileRef): TileRef[] {
  const cx = game.x(center);
  const cy = game.y(center);
  const out: TileRef[] = [];
  for (let y = cy - 4; y <= cy + 3; y++) {
    for (let x = cx - 4; x <= cx + 3; x++) {
      if (!game.isValidCoord(x, y)) continue;
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      if (dx * dx + dy * dy <= 16) out.push(game.ref(x, y));
    }
  }
  return out;
}

/** getSpawnTiles' validity test (execution/Util.ts:147-148). */
const takeable = (game: Game, t: TileRef) =>
  !game.hasOwner(t) && game.isLand(t) && !game.isImpassable(t);

const sorted = (tiles: Iterable<TileRef>) =>
  Array.from(tiles).sort((a, b) => a - b);

/** Every tile of the box around `center` (half-width r) passes `ok`. */
function boxAll(
  game: Game,
  center: TileRef,
  r: number,
  ok: (t: TileRef) => boolean,
): boolean {
  const cx = game.x(center);
  const cy = game.y(center);
  for (let y = cy - r; y < cy + r; y++) {
    for (let x = cx - r; x < cx + r; x++) {
      if (!game.isValidCoord(x, y) || !ok(game.ref(x, y))) return false;
    }
  }
  return true;
}

/** First tile, in a fixed raster scan, whose surroundings are free land. */
function freeInlandSite(game: Game, avoid: TileRef[] = []): TileRef {
  for (let y = 40; y < game.height() - 40; y += 7) {
    for (let x = 40; x < game.width() - 40; x += 7) {
      const t = game.ref(x, y);
      if (avoid.some((a) => game.manhattanDist(a, t) < 40)) continue;
      if (boxAll(game, t, 10, (u) => takeable(game, u))) return t;
    }
  }
  throw new Error("no free inland site");
}

const byType = (game: Game, type: PlayerType) =>
  game.allPlayers().filter((p) => p.type() === type);

interface ManifestNation {
  name: string;
  coordinates: [number, number];
}
const manifestNations = (
  JSON.parse(
    fs.readFileSync(path.join(MAPS, "world", "manifest.json"), "utf8"),
  ) as { nations: ManifestNation[] }
).nations;

describe("H1: the singleplayer spawn phase (World, Normal, Impossible, 400 tribes)", () => {
  beforeAll(() => {
    console.debug = () => {};
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test(
    "setting: no spawn timer, default nations at manifest cells, starting troops from Config.startManpower",
    async () => {
      const { game, me } = await newSim();
      const config = game.config();
      const gc = config.gameConfig();
      expect(gc.gameType).toBe(GameType.Singleplayer);
      expect(gc.gameMode).toBe(GameMode.FFA);
      expect(gc.difficulty).toBe(Difficulty.Impossible);
      expect(gc.randomSpawn).toBe(false);
      expect(config.bots()).toBe(BOTS);

      // GameRunner.init (GameRunner.ts:170-173): no SpawnTimerExecution in
      // singleplayer, although numSpawnPhaseTurns() still answers 100.
      expect(
        (game as GameImpl)
          .executions()
          .some((e) => e instanceof SpawnTimerExecution),
      ).toBe(false);
      expect(config.numSpawnPhaseTurns()).toBe(100);

      // nations: "default" outside Public games is every manifest nation at
      // its manifest cell (NationCreation.ts:98; unscaled at Normal size,
      // TerrainMapLoader.ts:108-127 halves only Compact).
      expect(game.nations().length).toBe(manifestNations.length);
      for (const n of game.nations()) {
        const m = manifestNations.find((x) => x.name === n.playerInfo.name)!;
        expect([n.spawnCell!.x, n.spawnCell!.y]).toEqual(m.coordinates);
      }

      // Starting troops are fixed when the player is added
      // (GameImpl.addPlayer, GameImpl.ts:718-724). Humans and nations exist
      // from game creation (GameImpl.addPlayers, GameImpl.ts:201-206).
      expect(config.startManpower(me.info())).toBe(25_000);
      expect(me.troops()).toBe(config.startManpower(me.info()));
      const nations = byType(game, PlayerType.Nation);
      expect(nations.length).toBe(manifestNations.length);
      for (const n of nations) {
        expect(config.startManpower(n.info())).toBe(31_250);
        expect(n.troops()).toBe(31_250);
      }
      // Tribes are only created when their SpawnExecution ticks.
      expect(byType(game, PlayerType.Bot).length).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "placement order: tribes land in tick 1 on full discs, nations in tick 2 and may be cut by tribes",
    async () => {
      const sim = await newSim();
      const { game } = sim;
      const config = game.config();

      sim.step(); // tick 0: executions are only init()ed
      expect(byType(game, PlayerType.Bot).length).toBe(0);
      expect(byType(game, PlayerType.Nation).some((n) => n.hasSpawned())).toBe(
        false,
      );

      sim.step(); // tick 1: every tribe spawns; nations only pick a tile
      const tribes = byType(game, PlayerType.Bot);
      expect(tribes.length).toBe(BOTS);
      for (const t of tribes) {
        expect(t.hasSpawned()).toBe(true);
        expect(t.troops()).toBe(config.startManpower(t.info()));
        expect(t.troops()).toBe(10_000);
        // Random spawn requires every disc tile valid (getSpawnTiles(.., true),
        // SpawnExecution.ts:188-192): the tribe owns its whole disc, which is
        // 52 tiles except where the map edge clips it.
        expect(sorted(t.tiles())).toEqual(sorted(disc(game, t.spawnTile()!)));
      }
      const clipped = tribes.filter((t) => t.numTilesOwned() !== 52);
      for (const t of clipped) {
        const y = game.y(t.spawnTile()!);
        const x = game.x(t.spawnTile()!);
        expect(
          y < 4 || y > game.height() - 4 || x < 4 || x > game.width() - 4,
        ).toBe(true);
      }
      // minDistanceBetweenPlayers() (30, Config.ts:823-825) held for every
      // tribe pair here; the code only enforces it for the first 750 of
      // 1,000 tries (SpawnExecution.ts:166-186), so it is not a guarantee.
      const minDist = config.minDistanceBetweenPlayers();
      for (let i = 0; i < tribes.length; i++) {
        for (let j = i + 1; j < tribes.length; j++) {
          expect(
            game.manhattanDist(tribes[i].spawnTile()!, tribes[j].spawnTile()!),
          ).toBeGreaterThanOrEqual(minDist);
        }
      }
      const nations = byType(game, PlayerType.Nation);
      expect(nations.some((n) => n.hasSpawned())).toBe(false);

      sim.step(); // tick 2: every nation lands on the tile picked in tick 1
      for (const n of nations) {
        expect(n.hasSpawned()).toBe(true);
        // An explicit centre takes only the free part of its disc
        // (getSpawnTiles(.., false), SpawnExecution.ts:139-148).
        const d = new Set(disc(game, n.spawnTile()!));
        for (const t of n.tiles()) expect(d.has(t)).toBe(true);
        expect(n.troops()).toBe(31_250);
      }
      // The tile was picked before the tribes existed, so some nations lose
      // part of their disc to a tribe, and a few are centred on tribe land.
      const cut = nations.filter((n) => n.numTilesOwned() < 52);
      expect(cut.length).toBeGreaterThan(0);
      const onTribe = nations.filter((n) => {
        const o = game.owner(n.spawnTile()!);
        return o.isPlayer() && o.type() === PlayerType.Bot;
      });
      expect(onTribe.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test(
    "untimed and frozen: 1,000 ticks without our spawn; nothing grows, nations hop within [c-25, c+24]",
    async () => {
      const sim = await newSim();
      const { game, me } = sim;
      const config = game.config();
      sim.step();
      sim.step();
      sim.step();
      const tribes = byType(game, PlayerType.Bot);
      const nations = byType(game, PlayerType.Nation);
      const tribeTiles = new Map(tribes.map((t) => [t, sorted(t.tiles())]));
      const nationGold = new Map(nations.map((n) => [n, n.gold()]));
      const cell = new Map(
        game.nations().map((n) => [n.playerInfo.id, n.spawnCell!]),
      );
      const lastSpawn = new Map(nations.map((n) => [n, n.spawnTile()!]));
      const hops = new Map<Player, number[]>(nations.map((n) => [n, []]));

      const TICKS = 1_000; // 10x numSpawnPhaseTurns(), 5x the multiplayer 200
      for (let i = 0; i < TICKS; i++) {
        const tick = game.ticks();
        sim.step();
        expect(game.inSpawnPhase()).toBe(true);
        expect(game.isSpawnImmunityActive()).toBe(true);
        expect(game.elapsedGameSeconds()).toBe(0);
        for (const n of nations) {
          const s = n.spawnTile()!;
          const c = cell.get(n.id())!;
          const dx = game.x(s) - c.x;
          const dy = game.y(s) - c.y;
          expect(dx >= -25 && dx <= 24 && dy >= -25 && dy <= 24).toBe(true);
          expect(n.troops()).toBe(31_250);
          if (s !== lastSpawn.get(n)) {
            hops.get(n)!.push(tick);
            lastSpawn.set(n, s);
            // A hop relinquishes the old disc first (SpawnExecution.ts:96-97).
            const d = new Set(disc(game, s));
            for (const t of n.tiles()) expect(d.has(t)).toBe(true);
          }
        }
      }
      expect(game.ticks()).toBe(TICKS + 3);

      // We are still waiting to be placed, untouched.
      expect(me.hasSpawned()).toBe(false);
      expect(me.numTilesOwned()).toBe(0);
      expect(me.troops()).toBe(config.startManpower(me.info()));
      // Tribes never grew, never lost a tile to a hopping nation, never
      // attacked; nations neither grew nor earned gold.
      for (const t of tribes) {
        expect(sorted(t.tiles())).toEqual(tribeTiles.get(t));
        expect(t.troops()).toBe(10_000);
        expect(t.gold()).toBe(0n);
      }
      for (const n of nations) expect(n.gold()).toBe(nationGold.get(n));
      for (const p of game.allPlayers()) {
        expect(p.outgoingAttacks().length).toBe(0);
      }
      expect(game.units().length).toBe(0);

      // Every nation hops on a fixed period: ticks % attackRate === attackTick,
      // attackRate = nextInt(30, 50) at Impossible (NationExecution.ts:102-103,
      // 127-134). Seen here as equal gaps between spawn-tile changes.
      for (const n of nations) {
        const h = hops.get(n)!;
        expect(h.length).toBeGreaterThanOrEqual(Math.floor(TICKS / 50));
        const gaps = h.slice(1).map((t, i) => t - h[i]);
        const period = gaps[0];
        expect(period).toBeGreaterThanOrEqual(30);
        expect(period).toBeLessThanOrEqual(49);
        expect(gaps.every((g) => g === period)).toBe(true);
      }
    },
    TIMEOUT,
  );

  test(
    "our spawn on free land: the 52-tile disc at 25,000 troops, the phase ends that tick, growth and nation attacks start after",
    async () => {
      const sim = await newSim();
      const { game, me } = sim;
      const config = game.config();
      for (let i = 0; i < 300; i++) sim.step(); // waiting costs nothing
      const site = freeInlandSite(game);
      const other = freeInlandSite(game, [site]);

      const turn = game.ticks();
      // Our first attack can ride in the same turn as the spawn: it waits,
      // un-init()ed, until the phase ends (AttackExecution.ts:71).
      sim.step([
        spawnAt(site),
        { type: "attack", targetID: null, troops: 5_000 },
      ]);
      expect(me.hasSpawned()).toBe(false); // init()ed only
      expect(game.inSpawnPhase()).toBe(true);
      const expected = disc(game, site).filter((t) => takeable(game, t));
      expect(expected.length).toBe(52);

      // Tick turn + 1: we land. A second spawn intent issued in this very
      // turn is init()ed after the phase ended in this tick's tick() loop, so
      // it is dropped (SpawnExecution.ts:57, 78-89, queuedDuringSpawnPhase).
      const u = sim.step([spawnAt(other)]);
      expect(me.hasSpawned()).toBe(true);
      expect(me.spawnTile()).toBe(site);
      expect(sorted(me.tiles())).toEqual(sorted(expected));
      expect(game.inSpawnPhase()).toBe(false);
      const end = u.updates[
        GameUpdateType.SpawnPhaseEnd
      ] as SpawnPhaseEndUpdate[];
      expect(end.map((e) => e.startTick)).toEqual([turn + 1]);
      // Our attack was init()ed at the end of this tick; nobody grew yet.
      expect(me.outgoingAttacks().length).toBe(1);
      expect(me.outgoingAttacks()[0].target().isPlayer()).toBe(false);
      expect(me.troops()).toBe(config.startManpower(me.info()) - 5_000);
      const nations = byType(game, PlayerType.Nation);
      for (const n of nations) {
        expect(n.troops()).toBe(31_250);
        expect(n.outgoingAttacks().length).toBe(0);
      }
      for (const t of byType(game, PlayerType.Bot)) {
        expect(t.troops()).toBe(10_000);
      }

      sim.step(); // tick turn + 2
      // The dropped second intent moved nothing.
      expect(me.spawnTile()).toBe(site);
      expect(game.hasOwner(other)).toBe(false);
      // Growth has started (PlayerExecution is init()ed at the end of the
      // tick the phase ended in).
      expect(me.troops()).toBeGreaterThan(
        config.startManpower(me.info()) - 5_000,
      );
      // Every nation opens with forceSendAttack(terraNullius) at half its
      // troops, one tick after our spawn (NationExecution.ts:194-196,
      // AiAttackBehavior.forceSendAttack, AiAttackBehavior.ts:812-820). It
      // first moves in tick turn + 3; ours already moved in turn + 2.
      for (const n of nations) {
        const attacks = n.outgoingAttacks();
        expect(attacks.length).toBe(1);
        expect(attacks[0].target().isPlayer()).toBe(false);
        expect(attacks[0].troops()).toBe(config.startManpower(n.info()) / 2);
      }
      expect(me.numTilesOwned()).toBeGreaterThan(52);
      // Tribes grow from here on too. The few whose TribeExecution phase
      // (ticks % attackRate === attackTick, attackRate 40..79,
      // TribeExecution.ts:36-37, 52) falls on this tick sent their opening
      // attack instead; the rest wait up to 79 ticks for it.
      const tribes = byType(game, PlayerType.Bot);
      for (const t of tribes) {
        if (t.outgoingAttacks().length === 0) {
          expect(t.troops()).toBeGreaterThan(10_000);
        }
      }
      expect(
        tribes.filter((t) => t.outgoingAttacks().length === 0).length,
      ).toBeGreaterThan(BOTS / 2);

      // Spawn immunity is counted from the phase end, not from tick 0, and
      // lasts spawnImmunityDuration() ticks (GameImpl.isSpawnImmunityActive
      // and ticksSinceStart, GameImpl.ts:959-983; Config.ts:189, 335-339).
      const startTick = turn + 1;
      expect(game.isSpawnImmunityActive()).toBe(true);
      while (game.isSpawnImmunityActive()) sim.step();
      expect(game.ticks() - startTick).toBe(config.spawnImmunityDuration());
      expect(config.spawnImmunityDuration()).toBe(50);
      // The game clock the win check reads runs from the phase end too.
      expect(game.elapsedGameSeconds()).toBe((game.ticks() - startTick) / 10);
    },
    TIMEOUT,
  );

  test(
    "spawning onto a nation: its tiles are excluded the same way",
    async () => {
      const sim = await newSim();
      const { game, me } = sim;
      sim.step();
      sim.step();
      sim.step();
      // Wait for a nation that owns its centre to hop, so it stays put for
      // at least 29 ticks (period >= 30) while our spawn lands.
      const nations = byType(game, PlayerType.Nation);
      const last = new Map(nations.map((n) => [n, n.spawnTile()!]));
      let nation: Player | null = null;
      while (nation === null) {
        sim.step();
        nation =
          nations.find(
            (n) =>
              n.spawnTile() !== last.get(n) &&
              game.owner(n.spawnTile()!) === n &&
              n.numTilesOwned() >= 40,
          ) ?? null;
        for (const n of nations) last.set(n, n.spawnTile()!);
      }
      const nationTiles = sorted(nation.tiles());
      const at = nation.spawnTile()!;
      const site = game.ref(game.x(at) + 3, game.y(at));
      sim.step([spawnAt(site)]);
      const expected = disc(game, site).filter((t) => takeable(game, t));
      const nationSet = new Set(nationTiles);
      const overlap = disc(game, site).filter((t) => nationSet.has(t));
      expect(overlap.length).toBeGreaterThan(0);
      sim.step();
      expect(me.hasSpawned()).toBe(true);
      expect(sorted(me.tiles())).toEqual(sorted(expected));
      expect(me.tiles().size).toBeLessThanOrEqual(52 - overlap.length);
      expect(sorted(nation.tiles())).toEqual(nationTiles);
      expect(nation.spawnTile()).toBe(at);
    },
    TIMEOUT,
  );

  test(
    "spawning onto a tribe: never takes owned tiles; on a fully owned disc the spawn fails silently and the phase stays open",
    async () => {
      const sim = await newSim();
      const { game, me } = sim;
      sim.step();
      sim.step();
      sim.step();
      // A tribe on a full disc in open land, with no one else nearby.
      const tribe = byType(game, PlayerType.Bot).find(
        (t) =>
          t.numTilesOwned() === 52 &&
          boxAll(
            game,
            t.spawnTile()!,
            14,
            (u) =>
              game.isLand(u) &&
              !game.isImpassable(u) &&
              (!game.hasOwner(u) || game.owner(u) === t),
          ),
      )!;
      expect(tribe).toBeDefined();
      const center = tribe.spawnTile()!;
      const tribeTiles = sorted(tribe.tiles());

      // 1. Centred on the tribe: every disc tile is owned, getSpawnTiles
      // returns [], getSpawn returns undefined, and tick() returns before
      // endSpawnPhase (SpawnExecution.ts:102-106, 139-145).
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      sim.step([spawnAt(center)]);
      sim.step();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("SpawnExecution: cannot spawn"),
      );
      expect(me.hasSpawned()).toBe(false);
      expect(me.numTilesOwned()).toBe(0);
      expect(game.inSpawnPhase()).toBe(true);
      expect(sorted(tribe.tiles())).toEqual(tribeTiles);

      // 2. Retry 3 tiles east. The centre is still tribe land (nothing checks
      // the centre's owner), the discs overlap by 28 tiles, and we get the
      // other 24 while the tribe keeps all 52.
      const site = game.ref(game.x(center) + 3, game.y(center));
      expect(game.owner(site)).toBe(tribe);
      const tribeSet = new Set(tribeTiles);
      expect(disc(game, site).filter((t) => tribeSet.has(t)).length).toBe(28);
      sim.step([spawnAt(site)]);
      // What our SpawnExecution sees next tick: nothing that runs before it
      // in that tick changes ownership during the phase.
      const expected = disc(game, site).filter((t) => takeable(game, t));
      expect(expected.length).toBe(52 - 28);
      sim.step();
      expect(me.hasSpawned()).toBe(true);
      expect(me.spawnTile()).toBe(site);
      expect(game.owner(site)).toBe(tribe);
      expect(sorted(me.tiles())).toEqual(sorted(expected));
      expect(sorted(tribe.tiles())).toEqual(tribeTiles);
      expect(game.inSpawnPhase()).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "a water centre is accepted: we get only the takeable land of the disc",
    async () => {
      const sim = await newSim();
      const { game, me } = sim;
      sim.step();
      sim.step();
      sim.step();
      let site: TileRef | null = null;
      for (let y = 40; site === null && y < game.height() - 40; y += 3) {
        for (let x = 40; x < game.width() - 40; x += 3) {
          const t = game.ref(x, y);
          if (game.isLand(t)) continue;
          const d = disc(game, t);
          const land = d.filter((u) => game.isLand(u)).length;
          if (land >= 20 && d.every((u) => !game.hasOwner(u))) {
            site = t;
            break;
          }
        }
      }
      expect(site).not.toBeNull();
      const expected = disc(game, site!).filter((t) => takeable(game, t));
      expect(expected.length).toBeLessThan(52);
      sim.step([spawnAt(site!)]);
      sim.step();
      expect(me.hasSpawned()).toBe(true);
      expect(game.isLand(me.spawnTile()!)).toBe(false);
      expect(sorted(me.tiles())).toEqual(sorted(expected));
      expect(game.inSpawnPhase()).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "a nation hop decided in the tick we spawn lands one tick after the phase ended",
    async () => {
      const sim = await newSim();
      const { game, me } = sim;
      sim.step();
      sim.step();
      sim.step();
      const nations = byType(game, PlayerType.Nation);
      const last = new Map(nations.map((n) => [n, n.spawnTile()!]));
      /** Ticks in which each nation's spawn tile changed. */
      const moved = new Map<Player, number[]>(nations.map((n) => [n, []]));
      const watch = (intents: Intent[] = []) => {
        const tick = game.ticks();
        sim.step(intents);
        for (const n of nations) {
          if (n.spawnTile() !== last.get(n)) {
            moved.get(n)!.push(tick);
            last.set(n, n.spawnTile()!);
          }
        }
      };
      const nation = nations[0];
      while (moved.get(nation)!.length < 2) watch();
      // The nation moves in ticks m, m + p, m + 2p, ...; the SpawnExecution
      // for a move in tick c is queued by NationExecution.tick in tick c - 1
      // (NationExecution.ts:127-134, 169-179) and runs in c.
      const [m1, m2] = moved.get(nation)!;
      const period = m2 - m1;
      let move = m2 + period;
      while (move - 2 < game.ticks()) move += period;
      const decide = move - 1;

      // Our spawn must run in tick `decide`, so its intent goes in turn
      // decide - 1.
      while (game.ticks() < decide - 1) watch();
      const site = freeInlandSite(
        game,
        nations.map((n) => n.spawnTile()!),
      );
      const before = nation.spawnTile();
      watch([spawnAt(site)]); // turn decide - 1
      expect(game.inSpawnPhase()).toBe(true);
      watch(); // tick decide: the nation queues its hop, then we land
      expect(me.hasSpawned()).toBe(true);
      const ours = sorted(me.tiles());
      expect(game.inSpawnPhase()).toBe(false);
      expect(nation.spawnTile()).toBe(before);
      // Internal spawns skip the spawn-phase gate (fromIntent = false,
      // SpawnExecution.ts:45-48, 87-89), so the queued hop still runs.
      watch(); // tick move
      expect(nation.spawnTile()).not.toBe(before);
      const nationMoves = moved.get(nation)!;
      expect(nationMoves[nationMoves.length - 1]).toBe(move);
      const d = new Set(disc(game, nation.spawnTile()!));
      for (const t of nation.tiles()) expect(d.has(t)).toBe(true);
      // It still never takes owned tiles: our disc is intact.
      expect(sorted(me.tiles())).toEqual(ours);
      // Every nation that relocated after the phase ended did so in tick
      // `move`; after that no nation ever hops again.
      const lateMovers = nations.filter((n) => moved.get(n)!.includes(move));
      expect(lateMovers).toContain(nation);
      for (let i = 0; i < 100; i++) watch(); // > 2 periods of any nation
      for (const n of nations) {
        expect(moved.get(n)!.filter((t) => t > decide)).toEqual(
          lateMovers.includes(n) ? [move] : [],
        );
      }
    },
    TIMEOUT,
  );
});
