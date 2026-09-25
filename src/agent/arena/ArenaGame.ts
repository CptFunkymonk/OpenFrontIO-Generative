import fs from "fs";
import path from "path";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Player,
  PlayerType,
} from "../../core/game/Game";
import {
  ErrorUpdate,
  GameUpdateType,
  GameUpdateViewData,
  HashUpdate,
} from "../../core/game/GameUpdates";
import { createGameRunner, GameRunner } from "../../core/GameRunner";
import {
  GameStartInfo,
  GameStartInfoSchema,
  StampedIntent,
  Turn,
} from "../../core/Schemas";
import { AgentOutcome } from "../Agent";
import { AgentHost, AgentHostStats } from "../AgentHost";
import { createAgent } from "../agents";
import { TerrainSource } from "../Fork";
import { landShare, maxTroops } from "../lib/Perception";
import { NodeMapLoader } from "./NodeMapLoader";
import { renderTerritory } from "./TerritoryImage";

export interface SeatSpec {
  agent: string;
  options?: Record<string, unknown>;
}

/** Everything that determines one arena game. Same spec, same game. */
export interface ArenaGameSpec {
  /** Position in the run; also names the output files. */
  index: number;
  gameID: string;
  map: GameMapType;
  mapSize: GameMapSize;
  difficulty: Difficulty;
  nations: "default" | "disabled" | number;
  bots: number;
  /** Singleplayer mirrors the browser's solo mode (the phase ends when the
   *  first human spawns); Private has the 200-tick spawn timer. */
  gameType: GameType.Singleplayer | GameType.Private;
  seats: SeatSpec[];
  maxTicks: number;
  /** Turns between an agent deciding and its intent executing (>= 1). */
  latencyTicks: number;
  rateLimit: boolean;
  /** Give each agent its own replica and verify it never diverges. */
  isolate: boolean;
  timelineEvery: number;
  /** Keep simulating after every agent is out, to learn who wins. */
  playOut: boolean;
  /** Rethrow agent exceptions (default: record and continue). */
  strict: boolean;
  /** Write territory PNGs here; null for none. */
  imagesDir: string | null;
  /** Also write a PNG every this many ticks (0 = final image only). */
  imageEvery: number;
}

export interface TimelinePoint {
  tick: number;
  tiles: number;
  share: number;
  troops: number;
  maxTroops: number;
  gold: number;
  alive: boolean;
}

export interface LeaderPoint {
  tick: number;
  leaders: { name: string; type: PlayerType; share: number }[];
}

export interface SeatResult {
  agent: string;
  options?: Record<string, unknown>;
  clientID: string;
  result: AgentOutcome["result"] | "error";
  eliminatedAtTick: number | null;
  /** Rank among humans and nations: by land if alive at the end, otherwise
   *  1 + how many were still alive when this seat was eliminated. */
  placement: number | null;
  finalShare: number;
  peakShare: number;
  peakShareTick: number;
  stats: Omit<AgentHostStats, "thinkMs"> & {
    thinkMs: { mean: number; p50: number; p95: number; max: number };
  };
  timeline: TimelinePoint[];
  logTail: string[];
  logs: string[];
}

export interface ArenaGameResult {
  index: number;
  gameID: string;
  map: GameMapType;
  mapSize: GameMapSize;
  difficulty: Difficulty;
  gameType: GameType;
  nationsInGame: number;
  bots: number;
  ticks: number;
  gameMinutes: number;
  wallMs: number;
  ticksPerSecond: number;
  winner: { name: string; type: PlayerType | "team"; isAgent: boolean } | null;
  seats: SeatResult[];
  leaders: LeaderPoint[];
  images: string[];
  error: string | null;
}

const LOG_TAIL = 40;

interface Seat {
  spec: SeatSpec;
  clientID: string;
  host: AgentHost;
  replica: GameRunner | null;
  replicaHashes: Map<number, number>;
  outcome: AgentOutcome | null;
  placement: number | null;
  peakShare: number;
  peakShareTick: number;
  timeline: TimelinePoint[];
}

export function seatClientID(i: number): string {
  return `AGENT${String(i).padStart(3, "0")}`;
}

/** The seat's player in the authoritative game (not its replica). */
function seatPlayer(game: Game, s: Seat): Player {
  const p = game.playerByClientID(s.clientID);
  if (p === null) throw new Error(`no player for seat ${s.clientID}`);
  return p;
}

export function arenaGameStart(spec: ArenaGameSpec): GameStartInfo {
  return GameStartInfoSchema.parse({
    gameID: spec.gameID,
    lobbyCreatedAt: 0,
    config: {
      gameMap: spec.map,
      gameMapSize: spec.mapSize,
      gameMode: GameMode.FFA,
      gameType: spec.gameType,
      difficulty: spec.difficulty,
      nations: spec.nations,
      bots: spec.bots,
      donateGold: false,
      donateTroops: false,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
    },
    players: spec.seats.map((s, i) => ({
      clientID: seatClientID(i),
      username: `${s.agent}${i}`.padEnd(3, "_").slice(0, 27),
      clanTag: null,
      isLobbyCreator: i === 0,
    })),
  });
}

/** Runs one arena game to its end. Never throws for game-level failures. */
export async function runArenaGame(
  spec: ArenaGameSpec,
  mapsDir: string,
): Promise<ArenaGameResult> {
  const wallStart = performance.now();
  const loader = new NodeMapLoader(mapsDir);
  const gameStart = arenaGameStart(spec);

  let fatal: string | null = null;
  const authHashes = new Map<number, number>();
  const hashSink =
    (hashes: Map<number, number>, label: string) =>
    (gu: GameUpdateViewData | ErrorUpdate) => {
      if ("errMsg" in gu) {
        fatal ??= `${label}: ${gu.errMsg}\n${gu.stack ?? ""}`;
        return;
      }
      for (const h of gu.updates[GameUpdateType.Hash] as HashUpdate[]) {
        hashes.set(h.tick, h.hash);
      }
    };

  const runner = await createGameRunner(
    gameStart,
    undefined,
    loader,
    hashSink(authHashes, "game"),
  );
  const game = runner.game;
  const terrain = await TerrainSource.load(loader, spec.map, spec.mapSize);

  // Intents waiting for their turn, keyed by turn number.
  const queue = new Map<number, StampedIntent[]>();
  let executed = 0;

  const seats: Seat[] = [];
  for (let i = 0; i < spec.seats.length; i++) {
    const seatSpec = spec.seats[i];
    const clientID = seatClientID(i);
    const replicaHashes = new Map<number, number>();
    const replica = spec.isolate
      ? await createGameRunner(
          gameStart,
          clientID,
          loader,
          hashSink(replicaHashes, `replica ${i}`),
        )
      : null;
    const host = new AgentHost({
      agent: createAgent(seatSpec.agent, seatSpec.options),
      clientID,
      gameStart,
      runner: replica ?? runner,
      terrain,
      deliver: (intent) => {
        const turn = executed - 1 + Math.max(1, spec.latencyTicks);
        const list = queue.get(turn) ?? [];
        list.push({ ...intent, clientID });
        queue.set(turn, list);
      },
      nowMs: () => game.ticks() * 100,
      rateLimit: spec.rateLimit,
      strict: spec.strict,
    });
    seats.push({
      spec: seatSpec,
      clientID,
      host,
      replica,
      replicaHashes,
      outcome: null,
      placement: null,
      peakShare: 0,
      peakShareTick: 0,
      timeline: [],
    });
  }

  const highlight = new Set<number>();
  const images: string[] = [];
  const writeImage = (label: string) => {
    if (spec.imagesDir === null) return;
    if (highlight.size === 0) {
      for (const s of seats) highlight.add(seatPlayer(game, s).smallID());
    }
    fs.mkdirSync(spec.imagesDir, { recursive: true });
    const file = path.join(
      spec.imagesDir,
      `game${String(spec.index).padStart(3, "0")}-${label}.png`,
    );
    fs.writeFileSync(file, renderTerritory(game, highlight));
    images.push(file);
  };

  const leaders: LeaderPoint[] = [];
  let error: string | null = null;
  try {
    while (true) {
      const turn: Turn = {
        turnNumber: executed,
        intents: queue.get(executed) ?? [],
      };
      queue.delete(executed);
      runner.addTurn(turn);
      if (!runner.executeNextTick() || fatal !== null) {
        throw new Error(fatal ?? `tick ${game.ticks()} did not execute`);
      }
      for (const s of seats) {
        if (s.replica === null) continue;
        s.replica.addTurn(structuredClone(turn));
        if (!s.replica.executeNextTick() || fatal !== null) {
          throw new Error(fatal ?? `replica tick ${game.ticks()} failed`);
        }
      }
      executed++;
      verifyReplicas(seats, authHashes);

      for (const s of seats) s.host.tick();

      const tick = game.ticks();
      for (const s of seats) {
        const share = landShare(game, seatPlayer(game, s));
        if (share > s.peakShare) {
          s.peakShare = share;
          s.peakShareTick = tick;
        }
        if (s.outcome === null) {
          s.outcome = s.host.checkOutcome();
          if (s.outcome !== null && s.outcome.eliminatedAtTick !== null) {
            s.placement = 1 + contenders(game).length;
          }
        }
      }
      if (tick % spec.timelineEvery === 0) {
        sampleTimeline(game, seats, leaders);
      }
      if (spec.imageEvery > 0 && tick % spec.imageEvery === 0) {
        writeImage(`t${tick}`);
      }

      if (game.getWinner() !== null) break;
      if (!spec.playOut && seats.every((s) => s.outcome !== null)) break;
      if (tick >= spec.maxTicks) break;
    }
  } catch (e) {
    error = e instanceof Error ? (e.stack ?? e.message) : String(e);
  }

  sampleTimeline(game, seats, leaders);
  const standings = contenders(game);
  for (const s of seats) {
    if (error !== null && s.outcome === null) continue;
    s.outcome ??= s.host.timeout();
    s.placement ??= standings.indexOf(seatPlayer(game, s)) + 1 || null;
  }
  try {
    writeImage("final");
  } catch (e) {
    error ??= `image: ${String(e)}`;
  }

  const winner = game.getWinner();
  const agentPlayers = new Set(seats.map((s) => seatPlayer(game, s)));
  const wallMs = performance.now() - wallStart;
  return {
    index: spec.index,
    gameID: spec.gameID,
    map: spec.map,
    mapSize: spec.mapSize,
    difficulty: spec.difficulty,
    gameType: spec.gameType,
    nationsInGame: game
      .allPlayers()
      .filter((p) => p.type() === PlayerType.Nation).length,
    bots: spec.bots,
    ticks: game.ticks(),
    gameMinutes: game.ticks() / 600,
    wallMs,
    ticksPerSecond: game.ticks() / (wallMs / 1000),
    winner:
      winner === null
        ? null
        : typeof winner === "string"
          ? { name: winner, type: "team", isAgent: false }
          : {
              name: winner.name(),
              type: winner.type(),
              isAgent: agentPlayers.has(winner),
            },
    seats: seats.map((s) => seatResult(game, s, error)),
    leaders,
    images,
    error,
  };
}

/** Humans and nations still alive, most land first. */
function contenders(game: Game): Player[] {
  return game
    .players()
    .filter((p) => p.type() !== PlayerType.Bot && p.isAlive())
    .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
}

function verifyReplicas(seats: Seat[], authHashes: Map<number, number>): void {
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    if (s.replica === null) continue;
    for (const [tick, hash] of s.replicaHashes) {
      const expected = authHashes.get(tick);
      if (expected !== undefined && expected !== hash) {
        throw new Error(
          `seat ${i} (${s.spec.agent}) diverged from the game at tick ${tick}: ` +
            `the agent mutated its view of the game state`,
        );
      }
    }
    s.replicaHashes.clear();
  }
}

function sampleTimeline(game: Game, seats: Seat[], leaders: LeaderPoint[]) {
  const tick = game.ticks();
  for (const s of seats) {
    if (s.timeline[s.timeline.length - 1]?.tick === tick) continue;
    const me = seatPlayer(game, s);
    s.timeline.push({
      tick,
      tiles: me.numTilesOwned(),
      share: round(landShare(game, me), 4),
      troops: Math.round(me.troops()),
      maxTroops: Math.round(maxTroops(game, me)),
      gold: Number(me.gold()),
      alive: me.isAlive(),
    });
  }
  if (leaders[leaders.length - 1]?.tick === tick) return;
  leaders.push({
    tick,
    leaders: contenders(game)
      .slice(0, 3)
      .map((p) => ({
        name: p.name(),
        type: p.type(),
        share: round(landShare(game, p), 4),
      })),
  });
}

function seatResult(game: Game, s: Seat, error: string | null): SeatResult {
  const { thinkMs, ...stats } = s.host.stats;
  const sorted = [...thinkMs].sort((a, b) => a - b);
  const pct = (q: number) =>
    sorted.length === 0
      ? 0
      : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    agent: s.spec.agent,
    ...(s.spec.options ? { options: s.spec.options } : {}),
    clientID: s.clientID,
    result: s.outcome?.result ?? (error !== null ? "error" : "timeout"),
    eliminatedAtTick: s.outcome?.eliminatedAtTick ?? null,
    placement: s.placement,
    finalShare: round(landShare(game, seatPlayer(game, s)), 4),
    peakShare: round(s.peakShare, 4),
    peakShareTick: s.peakShareTick,
    stats: {
      ...stats,
      thinkMs: {
        mean: round(sorted.length ? sum / sorted.length : 0, 3),
        p50: round(pct(0.5), 3),
        p95: round(pct(0.95), 3),
        max: round(sorted[sorted.length - 1] ?? 0, 3),
      },
    },
    timeline: s.timeline,
    logTail: s.host.logs.slice(-LOG_TAIL),
    logs: s.host.logs,
  };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
