import path from "path";
import type { AgentIntent } from "../../../src/agent/Agent";
import { AgentHost } from "../../../src/agent/AgentHost";
import { createAgent } from "../../../src/agent/agents";
import {
  BROWSER_SPAWN_WALL_MS,
  PREVIEW_ADVANCE,
  PREVIEW_TICK,
} from "../../../src/agent/agents/apex/controllers/SpawnController";
import {
  APEX_DEFAULTS,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import {
  ArenaGameSpec,
  arenaGameStart,
  seatClientID,
} from "../../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../../src/agent/arena/NodeMapLoader";
import { TerrainSource } from "../../../src/agent/Fork";
import {
  buildRaceGrid,
  SpawnCandidate,
  spawnCandidates,
  staticArrival,
} from "../../../src/agent/lib/RaceField";
import {
  capToReach,
  DISC_OFFSETS,
  discTiles,
  eraseCandidates,
  eraseLayout,
  landReach,
  rankErasures,
  reachScore,
  scoreErasure,
  siteScore,
} from "../../../src/agent/lib/SpawnErase";
import { getSpawnTiles } from "../../../src/core/execution/Util";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameType,
  Player,
  PlayerType,
} from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import { createGameRunner, GameRunner } from "../../../src/core/GameRunner";
import { StampedIntent } from "../../../src/core/Schemas";

// The spawn preview and erasure (package A3; chapter 13 §2.1 and §5.1;
// SpawnController.previewPlan, lib/SpawnErase.ts). The games are the
// arena's (arenaGameStart → createGameRunner: FFA singleplayer, Impossible,
// the map's nations, 400 tribes), on game IDs of the quick suite, and the
// agent runs in a real AgentHost with the arena's turn plumbing (latency 1:
// an intent sent at ctx.tick T goes into turn T, ArenaGame.ts). A "layout"
// is a second copy of the game stepped to tick 3 with no agent: the tribes
// and nations on the ground, the state the preview fork shows at tick 1.

const MAPS = path.join(__dirname, "../../../resources/maps");
const ME = seatClientID(0);
const TIMEOUT = 240_000;
/** Game IDs of the quick suite (seed "quick"): World game 0, Europe game 6
 *  (erasure: Siberia 1.40× the race best on World; nothing on Europe). */
const WORLD_ID = "G0avyeoz";
const EUROPE_ID = "G0avyep5";
const LAYOUT_TICK = PREVIEW_TICK + PREVIEW_ADVANCE;

interface Sent {
  tick: number;
  intent: AgentIntent;
}

interface Run {
  runner: GameRunner;
  game: Game;
  me: Player;
  host: AgentHost;
  sent: Sent[];
  /** Executes the next turn; then, unless `agent` is false, the agent's
   *  tick. */
  step(agent?: boolean): void;
  spawns(): Sent[];
}

async function start(
  map: GameMapType,
  options: Record<string, unknown>,
  gameID: string,
): Promise<Run> {
  const spec = {
    gameID,
    map,
    mapSize: GameMapSize.Normal,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Impossible,
    nations: "default",
    bots: 400,
    seats: [{ agent: "apex", options }],
  } as unknown as ArenaGameSpec;
  const gameStart = arenaGameStart(spec);
  const loader = new NodeMapLoader(MAPS);
  const runner = await createGameRunner(gameStart, undefined, loader, (gu) => {
    if ("errMsg" in gu) throw new Error(gu.errMsg);
  });
  const terrain = await TerrainSource.load(loader, map, GameMapSize.Normal);
  const game = runner.game;
  const queue = new Map<number, StampedIntent[]>();
  const sent: Sent[] = [];
  let executed = 0;
  const host = new AgentHost({
    agent: createAgent("apex", options),
    clientID: ME,
    gameStart,
    runner,
    terrain,
    deliver: (intent) => {
      // ArenaGame's deliver at latency 1: the next turn to execute.
      const list = queue.get(executed) ?? [];
      list.push({ ...intent, clientID: ME } as StampedIntent);
      queue.set(executed, list);
      sent.push({ tick: game.ticks(), intent });
    },
    nowMs: () => game.ticks() * 100,
    strict: true,
  });
  const me = game.playerByClientID(ME)!;
  return {
    runner,
    game,
    me,
    host,
    sent,
    step(agent = true) {
      runner.addTurn({
        turnNumber: executed,
        intents: queue.get(executed) ?? [],
      });
      queue.delete(executed);
      if (!runner.executeNextTick()) throw new Error(`turn ${executed}`);
      executed++;
      if (agent) host.tick();
    },
    spawns: () => sent.filter((s) => s.intent.type === "spawn"),
  };
}

/** Steps (with the agent) until game.ticks() === tick. */
function stepTo(r: Run, tick: number, agent = true): void {
  while (r.game.ticks() < tick) r.step(agent);
}

/** The game at tick 3 with no agent: what the preview fork shows. */
async function layoutOf(map: GameMapType, gameID: string): Promise<Run> {
  const r = await start(map, {}, gameID);
  stepTo(r, LAYOUT_TICK, false);
  return r;
}

function spawnTile(s: Sent): TileRef {
  if (s.intent.type !== "spawn") throw new Error("not a spawn");
  return s.intent.tile;
}

function nations(game: Game): Player[] {
  return game.players().filter((p) => p.type() === PlayerType.Nation);
}

function raceCandidates(game: Game, me: Player): SpawnCandidate[] {
  const o = APEX_DEFAULTS;
  const grid = buildRaceGrid(game, o);
  return spawnCandidates(grid, staticArrival(grid, game, o), game, me, o);
}

/** Unowned passable land (RaceField's free tile). */
function freeLand(game: Game): (t: TileRef) => boolean {
  return (t) => game.isLand(t) && !game.isImpassable(t) && !game.hasOwner(t);
}

beforeAll(() => {
  console.debug = () => {};
  console.warn = () => {};
});

describe("SpawnErase", () => {
  test(
    "the disc is getSpawnTiles' 52 tiles; a nation's own pick covers its disc and nothing else",
    async () => {
      expect(DISC_OFFSETS.length).toBe(2 * 52);
      const L = await layoutOf(GameMapType.World, WORLD_ID);
      const game = L.game;
      // Every nation holds getSpawnTiles(pick) minus what tribes and
      // earlier nations took, all inside discTiles(pick).
      let checked = 0;
      for (const n of nations(game)) {
        if (!n.isAlive()) continue;
        const pick = n.spawnTile()!;
        const disc = new Set(discTiles(game, pick));
        for (const t of n.tiles()) expect(disc.has(t)).toBe(true);
        const layout = eraseLayout(game, n, pick);
        if (layout !== null) {
          // What we would take is exactly what it holds, plus any whole
          // nation inside the disc.
          let also = 0;
          for (const id of layout.also) also += game.player(id).numTilesOwned();
          expect(layout.disc).toBe(n.numTilesOwned() + also);
          checked++;
        }
        // A full disc one tile east: its west edge is no longer covered.
        if (n.numTilesOwned() === 52) {
          expect(eraseLayout(game, n, pick + 1)).toBeNull();
        }
      }
      expect(checked).toBeGreaterThan(40);

      // On an open patch of land the disc is getSpawnTiles' exactly.
      const fresh = await start(GameMapType.World, {}, WORLD_ID);
      fresh.step(false);
      const g = fresh.game;
      let tile: TileRef | null = null;
      for (let t = 0; t < g.width() * g.height() && tile === null; t += 97) {
        const all = getSpawnTiles(g, t, true);
        if (all !== null && all.length === 52) tile = t;
      }
      expect(tile).not.toBeNull();
      expect(new Set(discTiles(g, tile!))).toEqual(
        new Set(getSpawnTiles(g, tile!, true)),
      );
    },
    TIMEOUT,
  );

  test(
    "siteScore is RaceField's score for every race candidate (World and Europe layouts)",
    async () => {
      for (const [map, id] of [
        [GameMapType.World, WORLD_ID],
        [GameMapType.Europe, EUROPE_ID],
      ] as const) {
        const L = await layoutOf(map, id);
        const o = APEX_DEFAULTS;
        const grid = buildRaceGrid(L.game, o);
        const arr = staticArrival(grid, L.game, o);
        const cands = spawnCandidates(grid, arr, L.game, L.me, o);
        expect(cands.length).toBeGreaterThan(20);
        for (const c of cands) {
          const s = siteScore(
            grid,
            arr,
            L.game,
            L.me,
            o,
            c.tile,
            freeLand(L.game),
          );
          expect(s.A).toBe(c.free);
          expect(s.B).toBe(c.pie);
          expect(s.threat).toBe(c.threat);
          expect(s.snack).toBe(c.snack);
          expect(s.score).toBeCloseTo(c.score, 6);
        }
      }
    },
    TIMEOUT,
  );

  test(
    "the bound is at least the exact score of every erasure site, and eraseCandidates returns the exact best (World, Alps)",
    async () => {
      for (const [map, id] of [
        [GameMapType.World, WORLD_ID],
        [GameMapType.Alps, "G0avyep1"],
      ] as const) {
        const L = await layoutOf(map, id);
        const o = APEX_DEFAULTS;
        const grid = buildRaceGrid(L.game, o);
        const arr = staticArrival(grid, L.game, o);
        const ranked = rankErasures(grid, arr, L.game, L.me, o);
        expect(ranked.length).toBeGreaterThan(nations(L.game).length / 2);
        let best = -Infinity;
        let bestTile: TileRef | null = null;
        for (const r of ranked) {
          const exact = scoreErasure(grid, arr, L.game, L.me, o, r);
          expect(r.bound + 1e-6).toBeGreaterThanOrEqual(exact.score);
          if (exact.score > best) {
            best = exact.score;
            bestTile = r.tile;
          }
        }
        const cands = eraseCandidates(grid, arr, L.game, L.me, o, -Infinity);
        expect(cands.length).toBeLessThanOrEqual(o.spawnEraseK);
        expect(cands[0].tile).toBe(bestTile);
        expect(cands[0].site.score).toBeCloseTo(best, 6);
        // A floor at the best bound cuts every site.
        expect(
          eraseCandidates(grid, arr, L.game, L.me, o, ranked[0].bound),
        ).toEqual([]);
      }
    },
    TIMEOUT,
  );
});

describe("land reach (landlocked pockets)", () => {
  test("capToReach cuts A and B to the reach and rescores; above it nothing changes", () => {
    const o = APEX_DEFAULTS;
    const s = {
      A: 14_000,
      B: 57_000,
      threat: 0,
      snack: true,
      discount: 0.5,
      score: (14_000 + o.spawnBeta * 57_000) * 0.5 + o.spawnSnackBonus,
    };
    expect(capToReach(s, 60_000, o)).toBe(s);
    const cut = capToReach(s, 12_800, o);
    expect(cut.A).toBe(12_800);
    expect(cut.B).toBe(12_800);
    expect(cut.reach).toBe(12_800);
    expect(cut.score).toBeCloseTo(
      (12_800 + o.spawnBeta * 12_800) * 0.5 + o.spawnSnackBonus,
      9,
    );
  });

  test(
    "Africa game 27: Iraq's pick sits in a river pocket the race grid cannot see; its capped score loses to the race best",
    async () => {
      const L = await layoutOf(GameMapType.Africa, "G0hmxma6");
      const o = APEX_DEFAULTS;
      const grid = buildRaceGrid(L.game, o);
      const arr = staticArrival(grid, L.game, o);
      const iraq = nations(L.game).find((n) => n.name() === "Iraq")!;
      const ranked = rankErasures(grid, arr, L.game, L.me, o);
      const r = ranked.find((x) => x.nation === iraq.id())!;
      const site = scoreErasure(grid, arr, L.game, L.me, o, r);
      // The pocket: the 12,784 tiles of land connected to the pick, none an
      // ocean shore, while the race grid's cells reach past the rivers.
      expect(site.reach).toBe(12_784);
      expect(landReach(L.game, iraq.spawnTile()!, 200_000)).toBe(12_784);
      const race = spawnCandidates(grid, arr, L.game, L.me, o)[0];
      expect(site.score).toBeLessThan(reachScore(L.game, race, o));
      // An open site is not capped: the race best reaches past its A and B.
      expect(reachScore(L.game, race, o)).toBe(race.score);
      expect(
        eraseCandidates(grid, arr, L.game, L.me, o, -Infinity).some(
          (e) => e.nation === iraq.id() && e.site.score > race.score,
        ),
      ).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "Europe game 6: the race best's 32k-tile pocket touches the ocean, so boats get off it and its score stands",
    async () => {
      const L = await layoutOf(GameMapType.Europe, EUROPE_ID);
      const o = APEX_DEFAULTS;
      const race = raceCandidates(L.game, L.me)[0];
      expect(race.pie).toBeGreaterThan(60_000);
      expect(landReach(L.game, race.tile, 1e7)).toBe(1e7);
      expect(reachScore(L.game, race, o)).toBe(race.score);
    },
    TIMEOUT,
  );
});

describe("spawnPreview", () => {
  test(
    "World: sent at tick 1 on the race best of the tick-3 layout; lands in tick 2 ahead of every nation, which land as in the layout",
    async () => {
      const L = await layoutOf(GameMapType.World, WORLD_ID);
      const want = raceCandidates(L.game, L.me)[0].tile;
      const r = await start(
        GameMapType.World,
        { spawnPreview: true },
        WORLD_ID,
      );
      r.step();
      expect(r.host.stats.errors).toBe(0);
      const spawns = r.spawns();
      expect(spawns).toHaveLength(1);
      expect(spawns[0].tick).toBe(PREVIEW_TICK);
      expect(spawnTile(spawns[0])).toBe(want);
      expect(r.host.stats.forks).toBe(1);
      expect(r.host.logs.some((l) => l.includes("spawn (race, preview)"))).toBe(
        true,
      );
      // The live game was only read: nothing is placed before tick 1 runs.
      expect(r.game.players().every((p) => p.numTilesOwned() === 0)).toBe(true);

      stepTo(r, LAYOUT_TICK, false);
      expect(r.me.hasSpawned()).toBe(true);
      expect(r.me.spawnTile()).toBe(want);
      expect(r.game.inSpawnPhase()).toBe(false);
      const ours = new Set(r.me.tiles());
      // Every nation on its layout pick, holding its layout tiles but ours.
      for (const n of nations(L.game)) {
        const p = r.game.player(n.id());
        expect(p.spawnTile()).toBe(n.spawnTile());
        const tiles = new Set(p.tiles());
        for (const t of n.tiles()) expect(tiles.has(t)).toBe(!ours.has(t));
        expect(tiles.size).toBe(
          [...n.tiles()].filter((t) => !ours.has(t)).length,
        );
      }
      // The tribes as in the layout.
      for (const b of L.game.players()) {
        if (b.type() !== PlayerType.Bot) continue;
        expect(r.game.player(b.id()).numTilesOwned()).toBe(b.numTilesOwned());
      }
    },
    TIMEOUT,
  );

  test(
    "off by default, off in the browser, and not at a first call after tick 1: the spawn goes out as before",
    async () => {
      expect(APEX_DEFAULTS.spawnPreview).toBe(false);
      expect(APEX_DEFAULTS.spawnErase).toBe(false);
      expect(
        parseApexOptions({ spawnPreview: true, spawnErase: true }).spawnErase,
      ).toBe(true);

      const off = await start(GameMapType.Onion, {}, "G0avyep3");
      stepTo(off, APEX_DEFAULTS.spawnDelay);
      expect(off.spawns().map((s) => s.tick)).toEqual([
        APEX_DEFAULTS.spawnDelay,
      ]);

      // The browser's budget: planned at T* = spawnDelay + 10 + 20, sent at
      // T* − 1 (§3.2.6), never at tick 1.
      const browser = await start(
        GameMapType.Onion,
        { spawnPreview: true, spawnWallBudgetMs: BROWSER_SPAWN_WALL_MS },
        "G0avyep3",
      );
      stepTo(browser, APEX_DEFAULTS.spawnDelay + 30);
      expect(browser.spawns().map((s) => s.tick)).toEqual([
        APEX_DEFAULTS.spawnDelay + 29,
      ]);
      expect(browser.host.logs.some((l) => l.includes("preview"))).toBe(false);

      // The first call at tick 2 (a batched host): planned at spawnDelay.
      const late = await start(
        GameMapType.Onion,
        { spawnPreview: true },
        "G0avyep3",
      );
      late.step(false);
      stepTo(late, APEX_DEFAULTS.spawnDelay);
      expect(late.spawns().map((s) => s.tick)).toEqual([
        APEX_DEFAULTS.spawnDelay,
      ]);
      expect(late.host.stats.forks).toBe(0);
      expect(late.host.logs.some((l) => l.includes("preview"))).toBe(false);
    },
    TIMEOUT,
  );
});

describe("spawnErase", () => {
  test(
    "World: Siberia's pick beats the race best; sent at tick 1, verified in a second fork; Siberia is never placed and every other nation lands as in the layout",
    async () => {
      const L = await layoutOf(GameMapType.World, WORLD_ID);
      const siberia = nations(L.game).find((n) => n.name() === "Siberia")!;
      const pick = siberia.spawnTile()!;
      const r = await start(
        GameMapType.World,
        { spawnPreview: true, spawnErase: true },
        WORLD_ID,
      );
      r.step();
      expect(r.host.stats.errors).toBe(0);
      const spawns = r.spawns();
      expect(spawns).toHaveLength(1);
      expect(spawns[0].tick).toBe(PREVIEW_TICK);
      expect(spawnTile(spawns[0])).toBe(pick);
      // The layout fork and the verification fork.
      expect(r.host.stats.forks).toBe(2);
      const logs = r.host.logs;
      expect(
        logs.some((l) => l.includes("erase Siberia") && l.includes("verified")),
      ).toBe(true);
      expect(
        logs.some((l) => l.includes("spawn (race, preview, erase Siberia)")),
      ).toBe(true);

      stepTo(r, LAYOUT_TICK, false);
      expect(r.game.inSpawnPhase()).toBe(false);
      expect(r.me.spawnTile()).toBe(pick);
      expect(r.me.numTilesOwned()).toBe(siberia.numTilesOwned());
      const gone = r.game.player(siberia.id());
      expect(gone.isAlive()).toBe(false);
      expect(gone.hasSpawned()).toBe(false);
      for (const n of nations(L.game)) {
        if (n === siberia) continue;
        const p = r.game.player(n.id());
        expect(p.spawnTile()).toBe(n.spawnTile());
        expect(p.numTilesOwned()).toBe(n.numTilesOwned());
      }

      // It stays erased: its execution waits for a spawn that never lands.
      stepTo(r, 300);
      expect(r.game.player(siberia.id()).isAlive()).toBe(false);
      expect(r.game.player(siberia.id()).numTilesOwned()).toBe(0);
      expect(r.me.isAlive()).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "Europe at margin 0: no erasure site beats the race best, so the preview's race best goes out, with one fork",
    async () => {
      const L = await layoutOf(GameMapType.Europe, EUROPE_ID);
      const want = raceCandidates(L.game, L.me)[0].tile;
      // Russia scores 0.91× the race best: the default margin (−0.25)
      // erases it, margin 0 does not.
      const r = await start(
        GameMapType.Europe,
        { spawnPreview: true, spawnErase: true, spawnEraseMargin: 0 },
        EUROPE_ID,
      );
      r.step();
      const spawns = r.spawns();
      expect(spawns).toHaveLength(1);
      expect(spawns[0].tick).toBe(PREVIEW_TICK);
      expect(spawnTile(spawns[0])).toBe(want);
      expect(r.host.stats.forks).toBe(1);
      expect(r.host.logs.some((l) => l.includes("erase: no site above"))).toBe(
        true,
      );
      stepTo(r, LAYOUT_TICK, false);
      for (const n of nations(L.game)) {
        expect(r.game.player(n.id()).isAlive()).toBe(true);
      }
    },
    TIMEOUT,
  );

  test(
    "Europe at the default margin: Russia, 0.91× the race best, is erased",
    async () => {
      expect(APEX_DEFAULTS.spawnEraseMargin).toBe(-0.25);
      const L = await layoutOf(GameMapType.Europe, EUROPE_ID);
      const russia = nations(L.game).find((n) => n.name() === "Russia")!;
      const r = await start(
        GameMapType.Europe,
        { spawnPreview: true, spawnErase: true },
        EUROPE_ID,
      );
      r.step();
      expect(spawnTile(r.spawns()[0])).toBe(russia.spawnTile());
      expect(r.host.stats.forks).toBe(2);
      stepTo(r, LAYOUT_TICK, false);
      expect(r.game.player(russia.id()).isAlive()).toBe(false);
      expect(r.game.player(russia.id()).hasSpawned()).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "spawnEraseMargin: a margin above the erasure's lead keeps the race best",
    async () => {
      const r = await start(
        GameMapType.World,
        { spawnPreview: true, spawnErase: true, spawnEraseMargin: 0.5 },
        WORLD_ID,
      );
      r.step();
      // Siberia scores 1.40× the race best: under 1.5×, so no site passes.
      expect(r.host.logs.some((l) => l.includes("erase: no site above"))).toBe(
        true,
      );
      expect(r.host.stats.forks).toBe(1);
      expect(r.spawns()).toHaveLength(1);
      expect(
        r.host.logs.some((l) => l.includes("spawn (race, preview) at")),
      ).toBe(true);
    },
    TIMEOUT,
  );
});

describe("preview with the lookahead modes", () => {
  test(
    "idle and rollout also plan on the preview's layout and send at tick 1; the spawn lands in tick 2",
    async () => {
      // idle: the arrival times come from a second fork, advanced to the
      // layout and stepped on with the phase ended.
      const idle = await start(
        GameMapType.Pangaea,
        { spawnMode: "idle", spawnIdleTicks: 150, spawnPreview: true },
        "SPAWNCTL",
      );
      idle.step();
      expect(idle.host.stats.errors).toBe(0);
      expect(idle.spawns().map((s) => s.tick)).toEqual([PREVIEW_TICK]);
      expect(idle.host.stats.forks).toBe(2);
      expect(
        idle.host.logs.some((l) => l.includes("spawn (idle, preview)")),
      ).toBe(true);
      stepTo(idle, LAYOUT_TICK, false);
      expect(idle.me.hasSpawned()).toBe(true);
      expect(idle.game.inSpawnPhase()).toBe(false);

      // rollout: each rolled-out candidate forks the live game at tick 1
      // with the spawn in turn 1, so it lands in the fork's tick 2 too.
      const roll = await start(
        GameMapType.Pangaea,
        {
          spawnMode: "rollout",
          spawnRolloutK: 2,
          spawnKeep: 1,
          spawnRound1: 30,
          spawnFinal: 30,
          spawnPreview: true,
          spawnErase: true,
          spawnEraseMargin: -1,
        },
        "SPAWNCTL",
      );
      roll.step();
      expect(roll.host.stats.errors).toBe(0);
      expect(roll.spawns().map((s) => s.tick)).toEqual([PREVIEW_TICK]);
      const logs = roll.host.logs;
      const r1 = logs.filter((l) => l.includes("rollout r1"));
      expect(r1.length).toBeGreaterThanOrEqual(2);
      // Every rolled-out spawn landed: none of them is dead at once.
      for (const l of r1) expect(l).not.toContain(" dead");
      expect(logs.some((l) => l.includes("spawn (rollout, preview"))).toBe(
        true,
      );
      stepTo(roll, LAYOUT_TICK, false);
      expect(roll.me.hasSpawned()).toBe(true);
      expect(roll.me.spawnTile()).toBe(spawnTile(roll.spawns()[0]));
    },
    TIMEOUT,
  );
});
