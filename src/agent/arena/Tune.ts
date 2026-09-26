/**
 * Successive halving over agent option sets (docs/11-roadmap.md §11.6,
 * tuning): every config plays the first K games of a suite; after each round
 * the best 1/eta by mean progress over all their games so far go on, and play
 * the next games, eta times as many in all. When the next cut would leave one
 * config, the configs left are the finalists and play the rest of the suite,
 * so the last decision is made on all of it.
 *
 *   npm run tune -- --configs sweep.json
 *   npm run tune -- --configs sweep.json --suite quick --start-games 8 --eta 2 --jobs 4
 *
 * sweep.json is a list of entrants, each an arena --agent string or an object:
 *
 *   ["baseline", "baseline:{\"expandTrigger\":0.25}",
 *    {"agent": "baseline", "options": {"expandReserve": 0.1}, "label": "low reserve"}]
 *
 * Each round is one arena invocation (a child process) with every surviving
 * config as an entrant and --range selecting only the round's new game
 * numbers, into DIR/round-N/. The same seed gives game g the same map and game
 * id in every round, so a config's earlier results stay valid and are reused.
 * Writes tune.md (the ranked table) and tune.json into DIR after every round.
 * Rerunning the same command resumes: a round whose directory holds a
 * finished arena run of the same games (the same parsed flags, in any order,
 * pictures and speed aside) is read back instead of played.
 *
 * The rounds are prefixes of the suite's game numbers, not samples of it, so
 * halving assumes the suite's order is already mixed: a suite whose maps
 * were grouped by kind would make its first, biggest cut on one kind. quick
 * is ordered for this (Suites.ts); dev and holdout play the generated map
 * list's order, which is alphabetical.
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AGENTS, createAgent } from "../agents";
import { makeSpecs, Options, parseArgs } from "./Arena";
import { isMain } from "./Cli";
import {
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  bootstrapMeanCI,
} from "./Compare";
import {
  codeFingerprint,
  EntrantSummary,
  pct,
  progress,
  provenance,
  readRun,
  StoredGame,
  summarize,
  SummaryFile,
  SummaryGame,
} from "./Summary";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");

const DEFAULT_SUITE = "quick";
const DEFAULT_START_GAMES = 8;
const DEFAULT_ETA = 2;

/** Arena flags that choose the games themselves: with none of them the tune
 *  plays DEFAULT_SUITE, so a custom pool is never recorded as that suite. */
const GAME_CHOICE = new Set([
  "--suite",
  "--maps",
  "--categories",
  "--exclude",
  "--games",
  "--each-map",
]);

/** Arena flags each round's invocation sets itself. */
const TUNE_SETS = new Set([
  "--agent",
  "--together",
  "--shard",
  "--range",
  "--game",
  "--from",
]);

const HELP = `Usage: npm run tune -- --configs FILE.json [options] [arena flags]

Successive halving over agent configs: every config plays the first K games of
the suite; after each round the best 1/eta by mean progress over all their
games so far (ties: wins, then mean peak land) play the next games, eta times
as many in all. When the next cut would leave one config, the ones left are
the finalists and play the rest of the suite.

  --configs FILE     JSON list of entrants, each "name", "name:{json options}"
                     or {"agent": "name", "options": {...}, "label": "..."}
  --start-games K    Games per config in round 1 (default ${DEFAULT_START_GAMES})
  --eta E            Keep the best 1/E each round; E times the games (default
                     ${DEFAULT_ETA}, at least 2)
  --out DIR          Where tune.md, tune.json and each round's arena results
                     (DIR/round-N/) go (default arena-results/tune-<seed>-<time>)

Every other flag goes to each round's arena (npm run arena -- --help), e.g.
--suite, --jobs, --max-minutes, --seed. The suite is ${DEFAULT_SUITE} unless those
flags choose the games (--suite, --maps, --categories, --exclude, --games or
--each-map). The tune sets --agent, --together, --shard, --range, --game and
--from itself.

Rerun the same command to resume: finished rounds are read back, not replayed.
A round is read back if its arena flags parse to the same games, in any order;
--jobs, --quiet, --verbose and the picture flags may change.
`;

// ── Configs ──────────────────────────────────────────────────────────────

/** One entrant of the tune. */
export interface TuneConfig {
  /** How reports name it: the label given, or `arg`. */
  label: string;
  agent: string;
  /** Overrides of the agent's defaults; null for none. */
  options: Record<string, unknown> | null;
  /** The arena --agent value: `agent` or `agent:{json options}`. */
  arg: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON with sorted keys, so the same options compare equal in any order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * The configs of a --configs file's parsed JSON. `where` names the file in
 * errors. Rejects unknown agents, and options an agent that reports its
 * options (Agent.options) does not have or gives another type, so a typo
 * fails here instead of silently tuning the default.
 */
export function parseConfigs(list: unknown, where: string): TuneConfig[] {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${where}: expected a non-empty JSON list of configs`);
  }
  const configs = list.map((entry: unknown, i): TuneConfig => {
    const at = `${where}[${i}]`;
    let agent: unknown;
    let options: unknown = undefined;
    let label: unknown = undefined;
    if (typeof entry === "string") {
      const colon = entry.indexOf(":");
      agent = colon < 0 ? entry : entry.slice(0, colon);
      if (colon >= 0) {
        try {
          options = JSON.parse(entry.slice(colon + 1));
        } catch (e) {
          // eslint-disable-next-line preserve-caught-error -- no Error cause before ES2022
          throw new Error(`${at}: bad options JSON in "${entry}": ${e}`);
        }
      }
    } else if (isObject(entry)) {
      const extra = Object.keys(entry).filter(
        (k) => k !== "agent" && k !== "options" && k !== "label",
      );
      if (extra.length > 0) {
        throw new Error(
          `${at}: unknown field(s) ${extra.join(", ")} (a config has agent, options and label)`,
        );
      }
      ({ agent, options, label } = entry);
    } else {
      throw new Error(`${at}: a config is "name", "name:{json}" or an object`);
    }
    if (typeof agent !== "string" || AGENTS[agent] === undefined) {
      throw new Error(
        `${at}: unknown agent ${JSON.stringify(agent)}. Available: ${Object.keys(AGENTS).join(", ")}`,
      );
    }
    if (options !== undefined && !isObject(options)) {
      throw new Error(`${at}: options must be a JSON object`);
    }
    if (label !== undefined && (typeof label !== "string" || label === "")) {
      throw new Error(`${at}: label must be a non-empty string`);
    }
    const overrides =
      options === undefined || Object.keys(options).length === 0
        ? null
        : options;
    const defaults = createAgent(agent).options;
    if (overrides !== null && defaults !== undefined) {
      for (const [k, v] of Object.entries(overrides)) {
        if (!Object.prototype.hasOwnProperty.call(defaults, k)) {
          throw new Error(
            `${at}: ${agent} has no option "${k}" (it has ${Object.keys(defaults).join(", ")})`,
          );
        }
        const want = typeof defaults[k];
        const scalar =
          want === "number" || want === "string" || want === "boolean";
        if (scalar && typeof v !== want) {
          throw new Error(
            `${at}: ${agent} option "${k}" is a ${want}, got ${JSON.stringify(v)}`,
          );
        }
      }
    }
    const arg =
      overrides === null ? agent : `${agent}:${JSON.stringify(overrides)}`;
    return { label: label ?? arg, agent, options: overrides, arg };
  });
  const seen = new Map<string, number>();
  const labels = new Map<string, number>();
  configs.forEach((c, i) => {
    const key = `${c.agent}:${canonical(c.options ?? {})}`;
    const same = seen.get(key);
    if (same !== undefined) {
      throw new Error(
        `${where}: configs ${same} and ${i} are the same (${c.arg})`,
      );
    }
    seen.set(key, i);
    const named = labels.get(c.label);
    if (named !== undefined) {
      throw new Error(
        `${where}: configs ${named} and ${i} share the label "${c.label}"`,
      );
    }
    labels.set(c.label, i);
  });
  return configs;
}

/** The configs in a --configs file. */
export function readConfigs(file: string): TuneConfig[] {
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // eslint-disable-next-line preserve-caught-error -- no Error cause before ES2022
    throw new Error(`--configs ${file}: ${e instanceof Error ? e.message : e}`);
  }
  return parseConfigs(json, path.basename(file));
}

// ── The schedule ─────────────────────────────────────────────────────────

/** One round of successive halving. */
export interface RoundPlan {
  /** From 1. */
  round: number;
  /** Configs that play it. */
  configs: number;
  /** The new game numbers it plays, from <= g < to; every config playing it
   *  has then played games 0 to to - 1. */
  from: number;
  to: number;
  /** Configs kept for the next round; all of them after the last. */
  keep: number;
  /** The last round: its configs are the finalists, and have played the
   *  whole suite by its end. */
  final: boolean;
}

/**
 * The rounds of successive halving for `configs` configs over a suite of
 * `games` games: round r plays games up to ceil(startGames × eta^(r-1)), then
 * keeps ceil(n / eta) of its n configs. When that would keep one, the round
 * plays to the end of the suite instead and its configs are the finalists, as
 * are those of a round that reaches the end anyway. Which configs survive
 * depends on the results; how many does not, so the whole plan is known
 * before a game is played.
 */
export function halvingSchedule(
  configs: number,
  games: number,
  startGames: number,
  eta: number,
): RoundPlan[] {
  if (!Number.isInteger(configs) || configs < 1) {
    throw new Error(`need at least one config, got ${configs}`);
  }
  if (!Number.isInteger(games) || games < 1) {
    throw new Error(`the suite has no games`);
  }
  if (!Number.isInteger(startGames) || startGames < 1) {
    throw new Error(`--start-games needs a positive integer`);
  }
  if (!(eta >= 2)) throw new Error(`--eta needs a number >= 2`);
  const rounds: RoundPlan[] = [];
  let n = configs;
  let from = 0;
  for (let round = 1; from < games; round++) {
    const lastCut = Math.ceil(n / eta) <= 1;
    const to = lastCut
      ? games
      : Math.min(games, Math.ceil(startGames * eta ** (round - 1)));
    const final = to === games;
    const keep = final ? n : Math.ceil(n / eta);
    rounds.push({ round, configs: n, from, to, keep, final });
    n = keep;
    from = to;
  }
  return rounds;
}

// ── Ranking ──────────────────────────────────────────────────────────────

/** A config's results over every game it has played. */
export interface ConfigScore {
  /** Index into the config list. */
  config: number;
  summary: EntrantSummary;
  /** Progress in each game, for the interval. */
  progress: number[];
}

/** The score of config `config` from its games (seat `seat` of each). */
export function scoreConfig(
  config: number,
  label: string,
  rows: { r: SummaryGame; seat: number }[],
  crashed: number,
): ConfigScore {
  return {
    config,
    summary: summarize(label, rows, crashed),
    progress: rows.map(({ r, seat }) => progress(r, seat)),
  };
}

/** Negative if `a` ranks above `b`: mean progress, then wins (as a rate, so
 *  a crashed game does not count as a loss), then mean peak land, then the
 *  config file's order. */
export function compareScores(a: ConfigScore, b: ConfigScore): number {
  return (
    b.summary.meanProgress - a.summary.meanProgress ||
    b.summary.winRate - a.summary.winRate ||
    b.summary.meanPeakShare - a.summary.meanPeakShare ||
    a.config - b.config
  );
}

/** Best first. */
export function rankScores(scores: readonly ConfigScore[]): ConfigScore[] {
  return [...scores].sort(compareScores);
}

/**
 * The whole tune's order: configs still in (or the finalists) first, then
 * those cut in later rounds before those cut earlier; within a round by
 * compareScores, over the games that round's configs all played.
 */
export function rankAll<T extends { score: ConfigScore; out: number | null }>(
  entries: readonly T[],
): T[] {
  const round = (e: T) => e.out ?? Infinity;
  return [...entries].sort(
    (a, b) => round(b) - round(a) || compareScores(a.score, b.score),
  );
}

// ── Command line ─────────────────────────────────────────────────────────

export interface TuneOptions {
  configsFile: string;
  configs: TuneConfig[];
  startGames: number;
  eta: number;
  /** The tune directory. */
  out: string;
  /** Flags every round's arena gets before its --agent, --range and --out:
   *  the suite, if the tune picked it, then the pass-through flags. */
  arenaArgs: string[];
  /** What the arena makes of arenaArgs. */
  suite: string | null;
  seed: string;
  /** Game numbers in the suite: 0 to totalGames - 1. */
  totalGames: number;
}

/** The --agent flags of `configs`. */
const agentFlags = (configs: readonly TuneConfig[]) =>
  configs.flatMap((c) => ["--agent", c.arg]);

export function parseTuneArgs(argv: string[]): TuneOptions {
  let configsFile: string | null = null;
  let startGames = DEFAULT_START_GAMES;
  let eta = DEFAULT_ETA;
  let out: string | null = null;
  const pass: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--help":
      case "-h":
        process.stdout.write(HELP);
        process.exit(0);
        break;
      case "--configs":
        configsFile = path.resolve(next());
        break;
      case "--start-games": {
        const v = Number(next());
        if (!Number.isInteger(v) || v < 1) {
          throw new Error(`--start-games needs a positive integer`);
        }
        startGames = v;
        break;
      }
      case "--eta": {
        const v = Number(next());
        if (!(v >= 2)) throw new Error(`--eta needs a number >= 2`);
        eta = v;
        break;
      }
      case "--out":
        out = next();
        break;
      default:
        if (TUNE_SETS.has(arg)) {
          throw new Error(
            `${arg}: the tune sets it for each round (see --help)`,
          );
        }
        pass.push(arg);
    }
  }
  if (configsFile === null) {
    throw new Error(`--configs FILE.json is required (see --help)`);
  }
  const configs = readConfigs(configsFile);
  const arenaArgs = pass.some((a) => GAME_CHOICE.has(a))
    ? pass
    : ["--suite", DEFAULT_SUITE, ...pass];
  // The arena checks every flag now, before any game is played.
  const o = parseArgs([...arenaArgs, ...agentFlags(configs)]);
  const jobs = makeSpecs(o);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    configsFile,
    configs,
    startGames,
    eta,
    out: path.resolve(
      out ?? path.join(ROOT, "arena-results", `tune-${o.seed}-${stamp}`),
    ),
    arenaArgs,
    suite: o.suite,
    seed: o.seed,
    totalGames: jobs.length === 0 ? 0 : jobs[jobs.length - 1].game + 1,
  };
}

// ── Running ──────────────────────────────────────────────────────────────

/** Plays one round: the arena with `argv`, writing into `dir`. */
export type PlayRound = (argv: string[], dir: string) => Promise<void>;

/** The arena exits with this when it finished, but a game failed under
 *  --strict or --isolate: the round's results are written all the same. */
const ARENA_GAMES_FAILED = 2;

/** The arena as a child process, its output shown as it plays. */
export const playArena: PlayRound = (argv) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(HERE, "Arena.ts"), ...argv],
      { cwd: ROOT, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 || code === ARENA_GAMES_FAILED
        ? resolve()
        : reject(
            new Error(`the arena exited (code ${code}, signal ${signal})`),
          ),
    );
  });

/**
 * What decides the games of an arena command line: its parsed options
 * without where and how fast or loudly it wrote them, and without its
 * pictures (frames and timeline samples only read the game; the tune's
 * scores do not use them). Throws if the arena cannot parse it.
 */
function gamesKey(argv: readonly string[]): string {
  const o: Options = parseArgs([...argv]);
  return JSON.stringify([
    o.entrants.map((e) => [e.seat.agent, canonical(e.seat.options ?? {})]),
    o.together,
    o.eachMap ? null : o.games,
    o.eachMap,
    o.eachMap ? o.repeat : null,
    o.seed,
    o.maps,
    o.difficulty,
    o.nations,
    o.bots,
    o.size,
    o.maxMinutes,
    o.latency,
    o.rateLimit,
    o.isolate,
    o.playOut,
    o.strict,
    o.suite,
    o.shard,
    o.range,
    o.onlyGame,
  ]);
}

/** True if `dir` holds this round, finished; false if it holds nothing.
 *  Throws if it holds anything else. */
export function finishedRound(dir: string, argv: readonly string[]): boolean {
  const file = path.join(dir, "summary.json");
  if (!fs.existsSync(file)) {
    if (!fs.existsSync(path.join(dir, "games"))) return false;
    throw new Error(
      `${dir} holds an unfinished arena run: remove it to play the round again`,
    );
  }
  const recorded = (JSON.parse(fs.readFileSync(file, "utf8")) as SummaryFile)
    .argv;
  let why = "";
  if (recorded !== undefined) {
    try {
      if (gamesKey(recorded) === gamesKey(argv)) return true;
    } catch (e) {
      why = ` (its flags no longer parse: ${e instanceof Error ? e.message : e})`;
    }
  }
  throw new Error(
    `${dir} holds another arena run than this round's${why}: choose another --out or remove it`,
  );
}

/** A round as played. */
export interface PlayedRound {
  plan: RoundPlan;
  dir: string;
  /** Read back from an earlier tune instead of played. */
  reused: boolean;
  commit: string | null;
  dirty: boolean | null;
  wallSeconds: number;
  /** The configs that played it, best first after it, with their scores
   *  over every game they had played by then. */
  standings: {
    config: number;
    label: string;
    games: number;
    wins: number;
    meanProgress: number;
    meanPeakShare: number;
    kept: boolean;
  }[];
}

/** A row of the ranked table. */
export interface RankedConfig {
  rank: number;
  config: number;
  label: string;
  agent: string;
  options: Record<string, unknown> | null;
  games: number;
  wins: number;
  meanProgress: number;
  /** Bootstrap 95% interval of meanProgress; null without games. */
  progress95: [number, number] | null;
  meanPeakShare: number;
  m3AboveMedian: number | null;
  m3Games: number;
  crashed: number;
  /** Its games that stopped early on an error. */
  errored: number;
  agentErrors: number;
  /** The round after which it was cut; null if still in (a finalist once
   *  the tune is done). */
  out: number | null;
  summary: EntrantSummary;
}

/** tune.json. */
export interface TuneReport {
  /** Every round played: false while the tune is still running. */
  done: boolean;
  configsFile: string;
  configs: TuneConfig[];
  suite: string | null;
  seed: string;
  totalGames: number;
  startGames: number;
  eta: number;
  arenaArgs: string[];
  /** The checkout the tune ran from. */
  commit: string | null;
  dirty: boolean | null;
  schedule: RoundPlan[];
  rounds: PlayedRound[];
  ranking: RankedConfig[];
  warnings: string[];
  bootstrap: { resamples: number; seed: number };
  wallSeconds: number;
}

/**
 * Plays the tune `t` round by round with `play`, writing tune.md and
 * tune.json into t.out after each; returns the final report.
 */
export async function runTune(
  t: TuneOptions,
  play: PlayRound = playArena,
  log: (line: string) => void = console.log,
): Promise<TuneReport> {
  const started = performance.now();
  const schedule = halvingSchedule(
    t.configs.length,
    t.totalGames,
    t.startGames,
    t.eta,
  );
  const { commit, dirty } = provenance(ROOT);
  // Each round's arena loads src/ afresh: note if the code changes between
  // the start and a later round, which `dirty` alone does not show once the
  // checkout has local changes.
  const code = codeFingerprint(ROOT);
  // Assigned in checkCode: typed so the narrowing to null does not stick.
  let changed = null as string | null;
  const checkCode = (when: string) => {
    if (code !== null && changed === null && codeFingerprint(ROOT) !== code) {
      changed = when;
    }
  };
  const rows = t.configs.map(() => [] as { r: StoredGame; seat: number }[]);
  const crashed = t.configs.map(() => 0);
  const out: (number | null)[] = t.configs.map(() => null);
  const score = (i: number) =>
    scoreConfig(i, t.configs[i].label, rows[i], crashed[i]);
  const rounds: PlayedRound[] = [];
  const warnings: string[] = [];
  fs.mkdirSync(t.out, { recursive: true });
  const planned = schedule.reduce((a, r) => a + r.configs * (r.to - r.from), 0);
  log(
    `Tune: ${t.configs.length} configs, ${t.suite === null ? "" : `suite ${t.suite}, `}` +
      `seed ${t.seed}, ${t.totalGames} games, eta ${t.eta}: ${schedule.length} ` +
      `round(s), ${planned} games in all → ${shownDir(t.out)}`,
  );

  let alive = t.configs.map((_, i) => i);
  for (const plan of schedule) {
    const dir = path.join(t.out, `round-${plan.round}`);
    const argv = [
      ...t.arenaArgs,
      ...agentFlags(alive.map((i) => t.configs[i])),
      ...["--range", `${plan.from}:${plan.to}`],
      ...["--out", dir],
    ];
    const games = `games ${plan.from}-${plan.to - 1}`;
    const reused = finishedRound(dir, argv);
    if (reused) {
      log(
        `\nRound ${plan.round}/${schedule.length}: ${games} read back from ${shownDir(dir)}`,
      );
    } else {
      log(
        `\nRound ${plan.round}/${schedule.length}: ${plan.configs} configs on ${games} ` +
          `(${plan.configs * (plan.to - plan.from)} games)`,
      );
      checkCode(`before round ${plan.round}`);
      await play(argv, dir);
    }

    // Entrant e of the round is its e-th surviving config.
    const run = readRun(dir);
    const counts = alive.map(() => 0);
    for (const game of run.games) {
      if (game.entrant === null || alive[game.entrant] === undefined) {
        throw new Error(
          `${dir}: game ${game.index} is not one of this round's entrants`,
        );
      }
      if (game.game < plan.from || game.game >= plan.to) {
        throw new Error(
          `${dir}: game ${game.index} is g ${game.game}, outside ${games}`,
        );
      }
      rows[alive[game.entrant]].push({ r: game, seat: 0 });
      counts[game.entrant]++;
    }
    for (const c of run.crashes) {
      if (c.entrant === null || alive[c.entrant] === undefined) continue;
      crashed[alive[c.entrant]]++;
      counts[c.entrant]++;
    }
    alive.forEach((i, e) => {
      if (counts[e] !== plan.to - plan.from) {
        warnings.push(
          `round ${plan.round}: ${t.configs[i].label} has ${counts[e]} of its ` +
            `${plan.to - plan.from} games in ${shownDir(dir)}`,
        );
      }
    });
    const crashedHere = run.crashes.length;
    if (crashedHere > 0) {
      warnings.push(
        `round ${plan.round}: ${crashedHere} game(s) crashed; the configs are ` +
          `ranked on the games they played`,
      );
    }
    const erroredHere = run.games.filter((g) => g.error !== null).length;
    if (erroredHere > 0) {
      warnings.push(
        `round ${plan.round}: ${erroredHere} game(s) stopped early on an ` +
          `error and count with their results cut short`,
      );
    }

    const ranked = rankScores(alive.map(score));
    const kept = new Set(ranked.slice(0, plan.keep).map((s) => s.config));
    for (const s of ranked) {
      if (!plan.final && !kept.has(s.config)) out[s.config] = plan.round;
    }
    const summaryFile = JSON.parse(
      fs.readFileSync(path.join(dir, "summary.json"), "utf8"),
    ) as SummaryFile;
    rounds.push({
      plan,
      dir,
      reused,
      commit: run.commit,
      dirty: run.dirty,
      wallSeconds: summaryFile.wallSeconds,
      standings: ranked.map((s) => ({
        config: s.config,
        label: s.summary.label,
        games: s.summary.games,
        wins: s.summary.wins,
        meanProgress: s.summary.meanProgress,
        meanPeakShare: s.summary.meanPeakShare,
        kept: kept.has(s.config),
      })),
    });
    for (const [i, s] of ranked.entries()) {
      log(
        `  ${String(i + 1).padStart(2)}. ${kept.has(s.config) ? (plan.final ? "final" : "kept ") : "out  "} ` +
          `progress ${s.summary.meanProgress.toFixed(3)}  wins ${s.summary.wins}/${s.summary.games}  ` +
          `peak ${pct(s.summary.meanPeakShare).padStart(6)}  ${s.summary.label}`,
      );
    }
    alive = alive.filter((i) => kept.has(i));

    const done = rounds.length === schedule.length;
    if (done) checkCode("after the last round");
    const notes =
      changed === null
        ? warnings
        : [
            ...warnings,
            `the code under src, resources or the package files changed ` +
              `during the tune, ${changed}: rounds from then on may have run ` +
              `other code than the ones before`,
          ];
    const report = tuneReport(t, schedule, rounds, score, out, notes, {
      done,
      commit,
      dirty: changed === null ? dirty : true,
      wallSeconds: (performance.now() - started) / 1000,
    });
    fs.writeFileSync(
      path.join(t.out, "tune.json"),
      JSON.stringify(report, null, 1),
    );
    fs.writeFileSync(path.join(t.out, "tune.md"), tuneMarkdown(report));
    if (report.done) return report;
  }
  throw new Error("the schedule has no rounds");
}

function tuneReport(
  t: TuneOptions,
  schedule: RoundPlan[],
  rounds: PlayedRound[],
  score: (i: number) => ConfigScore,
  out: (number | null)[],
  warnings: string[],
  meta: Pick<TuneReport, "done" | "commit" | "dirty" | "wallSeconds">,
): TuneReport {
  // A round read back from an earlier tune may predate a change.
  const version = (commit: string | null, dirty: boolean | null) =>
    commit === null ? "unknown" : `${commit.slice(0, 7)}${dirty ? "+" : ""}`;
  const now = version(meta.commit, meta.dirty);
  const other = rounds.filter((r) => version(r.commit, r.dirty) !== now);
  const all = [...warnings];
  if (other.length > 0) {
    all.push(
      `round(s) ${other.map((r) => `${r.plan.round} (${version(r.commit, r.dirty)})`).join(", ")} ` +
        `ran on other code than the checkout (${now}): the configs are ranked ` +
        `on results from code that has since changed`,
    );
  }
  const ranking = rankAll(
    t.configs.map((_, i) => ({ score: score(i), out: out[i] })),
  ).map(({ score: s, out: o }, rank): RankedConfig => {
    const c = t.configs[s.config];
    return {
      rank: rank + 1,
      config: s.config,
      label: c.label,
      agent: c.agent,
      options: c.options,
      games: s.summary.games,
      wins: s.summary.wins,
      meanProgress: s.summary.meanProgress,
      progress95: bootstrapMeanCI(s.progress),
      meanPeakShare: s.summary.meanPeakShare,
      m3AboveMedian: s.summary.m3AboveMedian,
      m3Games: s.summary.m3Games,
      crashed: s.summary.crashed,
      errored: s.summary.errored,
      agentErrors: s.summary.agentErrors,
      out: o,
      summary: s.summary,
    };
  });
  return {
    ...meta,
    configsFile: t.configsFile,
    configs: t.configs,
    suite: t.suite,
    seed: t.seed,
    totalGames: t.totalGames,
    startGames: t.startGames,
    eta: t.eta,
    arenaArgs: t.arenaArgs,
    schedule,
    rounds,
    ranking,
    warnings: all,
    bootstrap: { resamples: BOOTSTRAP_RESAMPLES, seed: BOOTSTRAP_SEED },
  };
}

// ── Report ───────────────────────────────────────────────────────────────

/** A directory as the report shows it: relative to the repository root
 *  (where npm runs) when inside it. */
function shownDir(dir: string): string {
  const rel = path.relative(ROOT, dir);
  return rel === "" ? "." : rel.startsWith("..") ? dir : rel;
}

const shellWord = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

const cell = (s: string) => s.replace(/\|/g, "\\|");

/** The ranked table, as tune.md shows it and the tune prints it. */
export function rankingTable(r: TuneReport): string {
  const header = [
    "rank",
    "config",
    "games",
    "wins",
    "progress (95% CI)",
    "peak land",
    "≥ median @3",
    "round eliminated",
  ];
  const f = (v: number) => v.toFixed(3);
  const rows = r.ranking.map((c) => [
    String(c.rank),
    cell(c.label),
    String(c.games),
    String(c.wins),
    `${f(c.meanProgress)}${c.progress95 === null ? "" : ` [${f(c.progress95[0])}, ${f(c.progress95[1])}]`}`,
    pct(c.meanPeakShare),
    c.m3AboveMedian === null ? "–" : `${pct(c.m3AboveMedian)} of ${c.m3Games}`,
    c.out !== null ? String(c.out) : r.done ? "finalist" : "still in",
  ]);
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(header),
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map(line),
  ].join("\n");
}

export function tuneMarkdown(r: TuneReport): string {
  const version =
    r.commit === null
      ? "commit unknown"
      : `${r.commit.slice(0, 7)}${r.dirty ? " with local changes" : ""}`;
  const where =
    r.suite === null ? `seed ${r.seed}` : `${r.suite} (seed ${r.seed})`;
  const out: string[] = [
    `# Tune: ${r.configs.length} configs on ${where}` +
      (r.done
        ? ""
        : ` (after round ${r.rounds.length} of ${r.schedule.length})`),
    "",
    `Successive halving: ${r.startGames} games in round 1, eta ${r.eta}, ` +
      `${r.totalGames} games in the suite; ${version}. ` +
      `Arena flags: \`${r.arenaArgs.map(shellWord).join(" ")}\`.`,
    "",
  ];
  if (r.warnings.length > 0) {
    out.push(r.warnings.map((w) => `> **WARNING:** ${w}`).join("\n>\n"), "");
  }
  out.push(
    rankingTable(r),
    "",
    `Progress is 1 for a win, else peak land ÷ 0.8, averaged over every game a ` +
      `config played; the interval is a percentile bootstrap of that mean ` +
      `(${r.bootstrap.resamples} resamples, seed ${r.bootstrap.seed}). Configs ` +
      `cut in the same round played the same games and are ranked by progress, ` +
      `then wins, then peak land; later rounds rank above earlier ones.`,
    "",
  );
  const troubled = r.ranking.filter(
    (c) => c.crashed > 0 || c.errored > 0 || c.agentErrors > 0,
  );
  for (const c of troubled) {
    out.push(
      `- ${c.label}: ${c.crashed} crashed game(s), ${c.errored} stopped on ` +
        `an error, ${c.agentErrors} agent error(s)`,
    );
  }
  if (troubled.length > 0) out.push("");
  out.push(`## Rounds`, "");
  for (const p of r.schedule) {
    const played = r.rounds.find((x) => x.plan.round === p.round);
    const cut = p.final
      ? `${p.configs} finalist${p.configs === 1 ? "" : "s"}`
      : `${p.configs} configs, the best ${p.keep} kept`;
    out.push(
      `${p.round}. games ${p.from}–${p.to - 1} (${p.to - p.from} new): ${cut}` +
        (played === undefined
          ? " (not played yet)"
          : ` (\`${shownDir(played.dir)}\`, ` +
            `${played.reused ? "read back" : `${played.wallSeconds.toFixed(0)} s`})`),
    );
  }
  out.push("");
  if (r.done && r.suite !== "dev" && r.suite !== "holdout") {
    const finalists = r.ranking.filter((c) => c.out === null);
    out.push(
      `## Next`,
      "",
      `Play the finalists on \`dev\` (§11.5 adopts a change only there):`,
      "",
      "```bash",
      `npm run arena -- --suite dev ${finalists
        .map((c) => `--agent ${shellWord(r.configs[c.config].arg)}`)
        .join(" ")}`,
      "```",
      "",
    );
  }
  return out.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const t = parseTuneArgs(process.argv.slice(2));
  const report = await runTune(t);
  console.log(`\n${rankingTable(report)}`);
  for (const w of report.warnings) console.log(`WARNING: ${w}`);
  console.log(
    `\nWall time ${report.wallSeconds.toFixed(0)}s. Report: ${path.join(t.out, "tune.md")}`,
  );
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
