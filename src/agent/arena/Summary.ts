/**
 * Arena statistics and results directories: the per-entrant summary the
 * arena prints and writes to summary.json, the milestone metrics of
 * docs/11-roadmap.md §11.6, and readRun, which loads a results directory back
 * for the report tools, runs recorded before a field existed included.
 *
 *   const run = readRun("arena-results/dev-champion");
 *   const labels = run.config!.entrants;
 *   console.log(summaryTable(summarizeEntrants(labels, run.games, run.crashes)));
 *
 * A results directory holds summary.json (the SummaryFile below), and
 * games/gameNNN.json (a StoredGame each) with games/gameNNN.log beside it.
 * NNN is the job index: g × entrants + entrant, or g with --together. Pair
 * games between runs by gameID, which depends only on the seed and g.
 */
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import type {
  Difficulty,
  GameMapSize,
  GameMapType,
} from "../../core/game/Game";
import type { ArenaGameResult, SeatResult, StandingPoint } from "./ArenaGame";

export const TICKS_PER_MINUTE = 600;

// ── Statistics ───────────────────────────────────────────────────────────

/** Wilson score interval for a binomial proportion, 95%. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Arithmetic mean; 0 for no values. */
export const mean = (xs: readonly number[]) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Median (the mean of the middle two for an even count); null for none. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The fields of a StandingPoint the milestone metrics read. */
export type StandingSample = Pick<
  StandingPoint,
  "minute" | "share" | "rank" | "medianNationShare" | "topNation"
>;

/** What the summary reads of a seat: a SeatResult and a stored seat fit. */
export type SummarySeat = Pick<
  SeatResult,
  "result" | "eliminatedAtTick" | "placement" | "peakShare" | "finalShare"
> & {
  stats: {
    errors: number;
    intentsRateLimited: number;
    thinkMs: { p95: number };
  };
  /** Missing from runs recorded before standings existed. */
  standings?: readonly StandingSample[];
};

/** What the summary reads of a game: an ArenaGameResult and a StoredGame fit. */
export interface SummaryGame {
  ticks: number;
  gameMinutes: number;
  seats: readonly SummarySeat[];
  /** Why the game stopped early: an agent exception under --strict, a
   *  replica divergence under --isolate, a simulation error. Null or missing
   *  (older files) if it ran to its end. */
  error?: string | null;
}

/**
 * Per-game progress toward victory: 1 for a win, otherwise the peak land
 * share as a fraction of the 80% needed to win (capped below 1).
 */
export function progress(r: SummaryGame, seat: number): number {
  const s = r.seats[seat];
  if (s.result === "win") return 1;
  return Math.min(0.99, s.peakShare / 0.8);
}

/**
 * A seat's standing at a game minute. A seat eliminated by then is behind
 * ("out") whether or not the minute was sampled: --play-out and --together
 * games go on sampling a dead seat, whose land rank among few survivors can
 * look good. Otherwise the sample, or, when the game stopped before the
 * minute, "won" for a seat that won (ahead) and null (unknown) for the rest,
 * as for every minute of a run recorded without standings.
 */
export function standingAt(
  r: SummaryGame,
  seat: number,
  minute: number,
): StandingSample | "out" | "won" | null {
  const s = r.seats[seat];
  if (s.standings === undefined) return null;
  const tick = minute * TICKS_PER_MINUTE;
  if (s.eliminatedAtTick !== null && s.eliminatedAtTick <= tick) return "out";
  const point = s.standings.find((p) => p.minute === minute);
  if (point !== undefined) return point;
  if (s.result === "win") return "won";
  return null;
}

/**
 * Whether a seat lost before minute 20 (tick 12000), for any cause: it was
 * eliminated before then, or another player won before then while it was
 * still in the game, which M3's eliminated-before-20 counts as survival.
 * Otherwise false if it won or the game reached minute 20, and null
 * (unknown) if the game stopped earlier without a result: a shorter cap, an
 * error.
 */
export function lostBefore20(r: SummaryGame, seat: number): boolean | null {
  const s = r.seats[seat];
  const tick = 20 * TICKS_PER_MINUTE;
  if (s.eliminatedAtTick !== null && s.eliminatedAtTick < tick) return true;
  if (s.result === "loss" && r.ticks < tick) return true;
  return s.result === "win" || r.ticks >= tick ? false : null;
}

/** Fraction of the known values that are true, and how many were known. */
function known(values: (boolean | null)[]): {
  rate: number | null;
  games: number;
} {
  const k = values.filter((v) => v !== null);
  return {
    rate: k.length === 0 ? null : k.filter((v) => v).length / k.length,
    games: k.length,
  };
}

export interface EntrantSummary {
  label: string;
  games: number;
  wins: number;
  winRate: number;
  winRate95: [number, number];
  meanProgress: number;
  meanPeakShare: number;
  meanFinalShare: number;
  meanPlacement: number;
  eliminated: number;
  meanSurvivalMinutes: number;
  /** Jobs whose worker died: no result, not among `games`. */
  crashed: number;
  /** Games that stopped early on an error (SummaryGame.error), among
   *  `games`: under --strict an agent exception, which agentErrors does not
   *  always count, under --isolate a divergence. */
  errored: number;
  agentErrors: number;
  intentsRateLimited: number;
  thinkMsP95Max: number;
  // Milestone metrics (§11.6). Each rate is over the games where it is known,
  // counted beside it, and null when none is: runs recorded before standings
  // existed know none, and a game that stopped before the minute cannot say
  // unless the seat was out by then (behind) or had won (ahead).
  /** M2: land share at minute 3 ≥ the median nation's. */
  m3AboveMedian: number | null;
  /** M2: land share at minute 3 ≥ the top nation's (true if no nation). */
  m3AboveTop: number | null;
  /** Games that know the minute-3 standing. */
  m3Games: number;
  /** M3: eliminated before minute 20 (tick 12000). Known when eliminated,
   *  when the game reached minute 20, or when it was won or lost. */
  eliminatedBefore20: number | null;
  eliminatedBefore20Games: number;
  /** Lost before minute 20 for any cause (lostBefore20): eliminated, or
   *  still in when another player won before minute 20, which
   *  eliminatedBefore20 counts as survival. Known in the same games, so the
   *  two compare directly. */
  lostBefore20: number | null;
  lostBefore20Games: number;
  /** M3: rank ≤ 3 among nations and humans by land at minute 10. */
  top3At10: number | null;
  top3At10Games: number;
  /** M5: median game minutes of the games won; null if none was. */
  medianWinMinutes: number | null;
}

export function summarize(
  label: string,
  rows: { r: SummaryGame; seat: number }[],
  crashed: number,
): EntrantSummary {
  const seats = rows.map(({ r, seat }) => r.seats[seat]);
  const wins = seats.filter((s) => s.result === "win").length;
  const eliminated = seats.filter((s) => s.eliminatedAtTick !== null);
  const at = (minute: number) =>
    rows.map(({ r, seat }) => standingAt(r, seat, minute));
  const at3 = at(3);
  const above = (bar: (p: StandingSample) => number) =>
    known(
      at3.map((p) =>
        p === null
          ? null
          : typeof p === "string"
            ? p === "won"
            : p.share >= bar(p),
      ),
    );
  const aboveMedian = above((p) => p.medianNationShare);
  const aboveTop = above((p) => p.topNation?.share ?? 0);
  const top3 = known(
    at(10).map((p) =>
      p === null ? null : typeof p === "string" ? p === "won" : p.rank <= 3,
    ),
  );
  const out20 = known(
    rows.map(({ r, seat }) => {
      const s = r.seats[seat];
      const tick = 20 * TICKS_PER_MINUTE;
      if (s.eliminatedAtTick !== null) return s.eliminatedAtTick < tick;
      const over = s.result === "win" || s.result === "loss";
      return over || r.ticks >= tick ? false : null;
    }),
  );
  const lost20 = known(rows.map(({ r, seat }) => lostBefore20(r, seat)));
  return {
    label,
    games: rows.length,
    wins,
    winRate: rows.length ? wins / rows.length : 0,
    winRate95: wilson(wins, rows.length),
    meanProgress: mean(rows.map(({ r, seat }) => progress(r, seat))),
    meanPeakShare: mean(seats.map((s) => s.peakShare)),
    meanFinalShare: mean(seats.map((s) => s.finalShare)),
    meanPlacement: mean(
      seats.filter((s) => s.placement !== null).map((s) => s.placement!),
    ),
    eliminated: eliminated.length,
    meanSurvivalMinutes: mean(
      eliminated.map((s) => s.eliminatedAtTick! / TICKS_PER_MINUTE),
    ),
    crashed,
    errored: rows.filter(({ r }) => (r.error ?? null) !== null).length,
    agentErrors: seats.reduce((a, s) => a + s.stats.errors, 0),
    intentsRateLimited: seats.reduce(
      (a, s) => a + s.stats.intentsRateLimited,
      0,
    ),
    thinkMsP95Max: Math.max(0, ...seats.map((s) => s.stats.thinkMs.p95)),
    m3AboveMedian: aboveMedian.rate,
    m3AboveTop: aboveTop.rate,
    m3Games: aboveMedian.games,
    eliminatedBefore20: out20.rate,
    eliminatedBefore20Games: out20.games,
    lostBefore20: lost20.rate,
    lostBefore20Games: lost20.games,
    top3At10: top3.rate,
    top3At10Games: top3.games,
    medianWinMinutes: median(
      rows
        .filter(({ r, seat }) => r.seats[seat].result === "win")
        .map(({ r }) => r.gameMinutes),
    ),
  };
}

/**
 * One summary per entrant label. A game whose `entrant` is a number is that
 * entrant's copy (its seat 0); a --together game (entrant null) seats every
 * entrant, entrant i in seat i. A crash counts against its entrant, or
 * against every entrant for a --together game.
 */
export function summarizeEntrants(
  labels: readonly string[],
  games: readonly (SummaryGame & { entrant: number | null })[],
  crashes: readonly { entrant: number | null }[] = [],
): EntrantSummary[] {
  return labels.map((label, i) =>
    summarize(
      label,
      games.flatMap((r) =>
        r.entrant === null
          ? i < r.seats.length
            ? [{ r, seat: i }]
            : []
          : r.entrant === i
            ? [{ r, seat: 0 }]
            : [],
      ),
      crashes.filter((c) => c.entrant === null || c.entrant === i).length,
    ),
  );
}

export const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** A milestone rate with the games it is over, "–" if unknown. */
const rateOf = (rate: number | null, games: number) =>
  rate === null ? "–" : `${pct(rate)} of ${games}`;

/**
 * The summary as a Markdown table, one row per entrant. "out < 20 min" is
 * M3's rate (eliminated), "lost < 20 min" also counts the games another
 * player won before minute 20. "errored" counts the games among `games` that
 * stopped early on an error, "crashed" the jobs whose worker died. An
 * entrant with no games (another entrant's --game rerun) shows "–" where a
 * mean over nothing would read as a result.
 */
export function summaryTable(summaries: readonly EntrantSummary[]): string {
  const header =
    "| entrant | games | wins | win rate (95% CI) | progress | peak land | final land | placement | eliminated | " +
    "≥ median @3 | ≥ top @3 | top 3 @10 | out < 20 min | lost < 20 min | win time | agent errors | errored | crashed | think p95 |";
  const rule = `|${header
    .split("|")
    .slice(1, -1)
    .map(() => "---")
    .join("|")}|`;
  const rows = summaries.map((s) => {
    const some = (text: string) => (s.games === 0 ? "–" : text);
    return (
      `| ${s.label} | ${s.games} | ${s.wins} | ${some(`${pct(s.winRate)} (${pct(s.winRate95[0])}–${pct(s.winRate95[1])})`)} | ` +
      `${some(s.meanProgress.toFixed(3))} | ${some(pct(s.meanPeakShare))} | ${some(pct(s.meanFinalShare))} | ` +
      `${some(s.meanPlacement.toFixed(1))} | ${s.eliminated} | ` +
      `${rateOf(s.m3AboveMedian, s.m3Games)} | ${rateOf(s.m3AboveTop, s.m3Games)} | ` +
      `${rateOf(s.top3At10, s.top3At10Games)} | ${rateOf(s.eliminatedBefore20, s.eliminatedBefore20Games)} | ` +
      `${rateOf(s.lostBefore20, s.lostBefore20Games)} | ` +
      `${s.medianWinMinutes === null ? "–" : `${s.medianWinMinutes.toFixed(1)} min`} | ` +
      `${s.agentErrors} | ${s.errored} | ${s.crashed} | ${some(`${s.thinkMsP95Max.toFixed(1)} ms`)} |`
    );
  });
  return [header, rule, ...rows].join("\n");
}

// ── Results directories ──────────────────────────────────────────────────

/** The run's options as summary.json records them. */
export interface RunConfig {
  /** Entrant labels, as given to --agent: `name` or `name:JSON`. */
  entrants: string[];
  together: boolean;
  games: number;
  eachMap: boolean;
  repeat: number;
  seed: string;
  /** The map pool in draw order (GameMapType values). */
  maps: GameMapType[];
  difficulty: Difficulty;
  nations: "default" | "disabled" | number;
  bots: number;
  size: GameMapSize;
  maxMinutes: number;
  latency: number;
  rateLimit: boolean;
  isolate: boolean;
  playOut: boolean;
  strict: boolean;
  out: string;
  images: boolean;
  imageEvery: number;
  timelineEvery: number;
  jobs: number;
  verbose: boolean;
  quiet: boolean;
  /** --game N: the one job index played. Missing in older runs. */
  onlyGame?: number | null;
}

/** --shard i/n: the games g with g % count === index. */
export interface Shard {
  index: number;
  count: number;
}

/**
 * A seat as stored in games/gameNNN.json: its SeatResult without the full
 * log (that is in gameNNN.log). The fields SeatResult marks as added later
 * (standings, received, attacks, stats.forkMs) are missing from older files.
 */
export type StoredSeat = Omit<SeatResult, "logs">;

/** A game as stored in games/gameNNN.json. */
export type StoredGame = Omit<ArenaGameResult, "seats"> & {
  /** The game number g; gameID and map depend only on it and the seed. */
  game: number;
  /** The entrant this copy of game g was played by, or null for a
   *  --together game, which seats every entrant (entrant i in seat i). */
  entrant: number | null;
  seats: StoredSeat[];
};

/** Where a job sits in its run. */
interface JobPlace {
  index: number;
  game: number;
  entrant: number | null;
  map: GameMapType;
  gameID: string;
}

/** A game of summary.json's games[]: the headline of a result, or a crash. */
export type GameEntry = JobPlace &
  (
    | { crash: string }
    | {
        minutes: number;
        winner: ArenaGameResult["winner"];
        error: string | null;
        seats: Pick<
          SeatResult,
          | "agent"
          | "options"
          | "result"
          | "placement"
          | "peakShare"
          | "finalShare"
          | "eliminatedAtTick"
        >[];
      }
  );

export type CrashedGame = JobPlace & { crash: string };

/** summary.json. */
export interface SummaryFile {
  config: RunConfig;
  /** git HEAD of the checkout that ran the games; null without git. */
  commit: string | null;
  /** Local changes to src, resources or the package files; null without git.
   *  True as well if they changed while the run played. */
  dirty: boolean | null;
  /** The code (codeFingerprint) changed while the run played, so later
   *  games may have run other code than earlier ones. Missing in older runs. */
  changedDuringRun?: boolean;
  /** The suite played, `name (modified)` when explicit flags changed which
   *  games it plays or how, null for none. */
  suite: string | null;
  shard: Shard | null;
  /** --range a:b: the games a <= g < b. */
  range: [number, number] | null;
  /** The arena's command line, with --from expanded. */
  argv: string[];
  /** The results directory whose run --from replayed; null for none,
   *  missing in older runs. */
  from?: string | null;
  wallSeconds: number;
  summaries: EntrantSummary[];
  games: GameEntry[];
}

/** A game result as games/gameNNN.json stores it. */
export function storedGame(
  r: ArenaGameResult,
  game: number,
  entrant: number | null,
): StoredGame {
  const { index, seats, ...rest } = r;
  return {
    index,
    game,
    entrant,
    ...rest,
    seats: seats.map(({ logs, ...s }) => s),
  };
}

/** summary.json's games[] entry for a finished game. */
export function gameEntry(r: StoredGame): GameEntry {
  return {
    index: r.index,
    game: r.game,
    entrant: r.entrant,
    map: r.map,
    gameID: r.gameID,
    minutes: Number(r.gameMinutes.toFixed(2)),
    winner: r.winner,
    error: r.error,
    seats: r.seats.map((s) => ({
      agent: s.agent,
      options: s.options,
      result: s.result,
      placement: s.placement,
      peakShare: s.peakShare,
      finalShare: s.finalShare,
      eliminatedAtTick: s.eliminatedAtTick,
    })),
  };
}

/** The files whose changes decide games: what `dirty` and codeFingerprint
 *  look at. */
export const DECISIVE_PATHS = [
  "src",
  "resources",
  "package.json",
  "package-lock.json",
];

const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });

/** The checkout's commit and whether the files that decide a game differ. */
export function provenance(root: string): {
  commit: string | null;
  dirty: boolean | null;
} {
  try {
    const commit = git(root, "rev-parse", "HEAD").trim();
    const status = git(root, "status", "--porcelain", "--", ...DECISIVE_PATHS);
    return { commit, dirty: status.trim().length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}

/**
 * A hash of the code a game would run now: HEAD, and the path and content of
 * every file under DECISIVE_PATHS that differs from it or is untracked. A
 * worker loads src/ when it is forked, so the arena takes this before every
 * fork: unlike `dirty`, it changes on each further edit of a file that was
 * already dirty. Null without git.
 */
export function codeFingerprint(root: string): string | null {
  try {
    const hash = createHash("sha1");
    hash.update(git(root, "rev-parse", "HEAD"));
    const list = (...args: string[]) =>
      git(root, ...args, "-z", "--", ...DECISIVE_PATHS)
        .split("\0")
        .filter((f) => f.length > 0);
    const files = [
      ...list("diff", "HEAD", "--name-only"),
      ...list("ls-files", "--others", "--exclude-standard"),
    ].sort();
    for (const f of files) {
      const file = path.join(root, f);
      hash.update(`\0${f}\0`);
      hash.update(fs.existsSync(file) ? fs.readFileSync(file) : "(deleted)");
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/** A results directory, as readRun loads it. */
export interface Run {
  dir: string;
  /** null if summary.json is missing (the run did not finish). */
  config: RunConfig | null;
  commit: string | null;
  dirty: boolean | null;
  /** False for runs recorded before it was. */
  changedDuringRun: boolean;
  suite: string | null;
  shard: Shard | null;
  range: [number, number] | null;
  argv: string[] | null;
  /** Every games/gameNNN.json, by index. */
  games: StoredGame[];
  /** Jobs whose worker crashed: no game file, only a summary.json entry. */
  crashes: CrashedGame[];
}

/**
 * Loads a results directory. Runs recorded before a field existed load with
 * it null (provenance) or missing (the M1 seat fields); their game files get
 * `game` and `entrant` from the index and the entrant count, the only place
 * that ever has to derive them.
 */
export function readRun(dir: string): Run {
  const gamesDir = path.join(dir, "games");
  if (!fs.existsSync(gamesDir)) {
    throw new Error(`${dir} has no games/ directory: not an arena results dir`);
  }
  const summaryFile = path.join(dir, "summary.json");
  const summary = fs.existsSync(summaryFile)
    ? (JSON.parse(
        fs.readFileSync(summaryFile, "utf8"),
      ) as Partial<SummaryFile> & { config: RunConfig })
    : null;
  const config = summary?.config ?? null;
  const place = <T extends { index: number }>(
    g: T & Partial<Pick<JobPlace, "game" | "entrant">>,
  ): T & Pick<JobPlace, "game" | "entrant"> => {
    if (g.game !== undefined && g.entrant !== undefined) {
      return { ...g, game: g.game, entrant: g.entrant };
    }
    if (config === null) {
      throw new Error(
        `${dir}: game ${g.index} does not record its game number and there ` +
          `is no summary.json to derive it from`,
      );
    }
    if (config.together) return { ...g, game: g.index, entrant: null };
    const n = config.entrants.length;
    return { ...g, game: Math.floor(g.index / n), entrant: g.index % n };
  };
  const games = fs
    .readdirSync(gamesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) =>
      place(
        JSON.parse(fs.readFileSync(path.join(gamesDir, f), "utf8")) as Omit<
          StoredGame,
          "game" | "entrant"
        > &
          Partial<Pick<StoredGame, "game" | "entrant">>,
      ),
    )
    .sort((a, b) => a.index - b.index);
  const crashes = (summary?.games ?? [])
    .filter((g): g is JobPlace & { crash: string } => "crash" in g)
    .map((g) => place(g));
  return {
    dir,
    config,
    commit: summary?.commit ?? null,
    dirty: summary?.dirty ?? null,
    changedDuringRun: summary?.changedDuringRun ?? false,
    suite: summary?.suite ?? null,
    shard: summary?.shard ?? null,
    range: summary?.range ?? null,
    argv: summary?.argv ?? null,
    games,
    crashes,
  };
}
