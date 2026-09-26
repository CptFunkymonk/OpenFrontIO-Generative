import fs from "fs";
import path from "path";
import {
  ArenaJob,
  makeSpecs,
  parseArgs,
  selectJobs,
} from "../../../src/agent/arena/Arena";
import {
  CrashedGame,
  gameEntry,
  RunConfig,
  StoredGame,
  StoredSeat,
  summarizeEntrants,
  SummaryFile,
} from "../../../src/agent/arena/Summary";

// Results directories written the way the arena writes them, for the report
// tools' tests: the jobs (maps, game ids, indices) come from the arena's own
// parseArgs and makeSpecs, only the results are made up, so no game is played.

export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** A seat's stored result: a timeout at 1% peak land unless overridden. */
export function seat(
  agent: string,
  i: number,
  overrides: Partial<StoredSeat> = {},
): StoredSeat {
  return {
    agent,
    clientID: `AGENT${String(i).padStart(3, "0")}`,
    result: "timeout",
    eliminatedAtTick: null,
    placement: 3,
    finalShare: 0.01,
    peakShare: 0.01,
    peakShareTick: 600,
    stats: {
      intentsSent: 0,
      intentsRateLimited: 0,
      intentsInvalid: 0,
      intentsByType: {},
      errors: 0,
      firstErrors: [],
      forks: 0,
      thinkMs: { mean: 0.1, p50: 0.1, p95: 0.2, max: 1 },
      forkMs: { count: 0, total: 0, max: 0 },
    },
    timeline: [],
    standings: [],
    attacks: [],
    attacksDropped: 0,
    logTail: [],
    ...overrides,
  };
}

export interface RunSketch {
  /** Each seat's result fields. */
  seat?: (job: ArenaJob, seat: number) => Partial<StoredSeat>;
  /** Each game's length in ticks (default 36000, the 60-minute cap). */
  ticks?: (job: ArenaJob) => number;
  /** Job indices whose worker crashed. */
  crash?: number[];
  /** Each game's error, as when it stopped early (default none). */
  error?: (job: ArenaJob) => string | null;
  /** Frame names (game000-t600.png) each game wrote into images/. */
  images?: (job: ArenaJob) => string[];
  commit?: string | null;
  dirty?: boolean | null;
}

/**
 * Writes the results directory of `npm run arena -- ...argv --out dir` with
 * made-up results, as Arena.ts main() writes it; returns its summary.json.
 */
export function writeRun(
  dir: string,
  argv: string[],
  sketch: RunSketch = {},
): SummaryFile {
  const o = parseArgs([...argv, "--out", dir]);
  const jobs = selectJobs(o, makeSpecs(o));
  fs.mkdirSync(path.join(dir, "games"), { recursive: true });
  const played: StoredGame[] = [];
  const crashes: CrashedGame[] = [];
  for (const job of jobs) {
    const place = {
      index: job.spec.index,
      game: job.game,
      entrant: o.together ? null : job.entrant,
    };
    if (sketch.crash?.includes(job.spec.index)) {
      crashes.push({
        ...place,
        map: job.spec.map,
        gameID: job.spec.gameID,
        crash: "worker exited (code 1, signal null)",
      });
      continue;
    }
    const images = (sketch.images?.(job) ?? []).map((f) =>
      path.join(o.out, "images", f),
    );
    for (const f of images) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `png of ${path.basename(f)}`);
    }
    const ticks = sketch.ticks?.(job) ?? 36000;
    const stored: StoredGame = {
      ...place,
      gameID: job.spec.gameID,
      map: job.spec.map,
      mapSize: job.spec.mapSize,
      difficulty: job.spec.difficulty,
      gameType: job.spec.gameType,
      nationsInGame: 3,
      bots: job.spec.bots,
      ticks,
      gameMinutes: ticks / 600,
      wallMs: 1000,
      ticksPerSecond: ticks,
      winner: null,
      seats: job.spec.seats.map((s, i) =>
        seat(s.agent, i, {
          ...(s.options ? { options: s.options } : {}),
          ...sketch.seat?.(job, i),
        }),
      ),
      leaders: [],
      images,
      error: sketch.error?.(job) ?? null,
    };
    played.push(stored);
    const name = `game${String(stored.index).padStart(3, "0")}`;
    fs.writeFileSync(
      path.join(dir, "games", `${name}.json`),
      JSON.stringify(stored, null, 1),
    );
    fs.writeFileSync(path.join(dir, "games", `${name}.log`), `## ${name}`);
  }
  const { entrants, suite, shard, range, argv: args, from, ...config } = o;
  const labels = entrants.map((e) => e.label);
  const summary: SummaryFile = {
    config: { ...config, entrants: labels } satisfies RunConfig,
    commit: sketch.commit === undefined ? COMMIT : sketch.commit,
    dirty: sketch.dirty === undefined ? false : sketch.dirty,
    suite,
    shard,
    range,
    argv: args,
    from: from?.dir ?? null,
    changedDuringRun: false,
    wallSeconds: 10,
    summaries: summarizeEntrants(labels, played, crashes),
    games: [...played.map(gameEntry), ...crashes].sort(
      (a, b) => a.index - b.index,
    ),
  };
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify(summary, null, 1),
  );
  return summary;
}
