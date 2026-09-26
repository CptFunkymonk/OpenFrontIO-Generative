/**
 * Joins the shard directories of one arena run into one results directory,
 * as if a single session had played every game (docs/11-roadmap.md §11.5,
 * Compute): the game files, logs and images copied over, summary.json and
 * summary.md rebuilt.
 *
 *   npm run arena -- --suite dev --shard 0/4 --out arena-results/dev-x-0  # ... 3/4
 *   npm run arena:merge -- --out arena-results/dev-x arena-results/dev-x-?
 *   npm run arena:compare -- arena-results/dev-champion arena-results/dev-x
 *
 * The directories must be parts of the same run: the same commit, seed,
 * entrants and every flag that decides the games, differing only in which
 * games they played (--shard, --range, --game) and where and how fast they
 * wrote them (--out, --jobs, --verbose, --quiet); --force merges them anyway.
 * A game file in two directories is always refused. A crash in one that
 * another played (a --game rerun) gives way to the game, and game numbers
 * that no directory played are reported. The merged config and command line
 * come from a part that played a shard or range, not a --game rerun, whatever
 * the order the parts are given in.
 */
import fs from "fs";
import path from "path";
import { isMain } from "./Cli";
import {
  CrashedGame,
  gameEntry,
  readRun,
  Run,
  RunConfig,
  Shard,
  StoredGame,
  summarizeEntrants,
  SummaryFile,
  summaryTable,
} from "./Summary";

/** Config fields that may differ between parts of a run: where the results
 *  went and how the session played them, never what was played. Images are
 *  among them, so a crashed game can be rerun with frames and merged in. */
const PER_PART: ReadonlySet<string> = new Set<keyof RunConfig>([
  "out",
  "jobs",
  "verbose",
  "quiet",
  "onlyGame",
  "images",
  "imageEvery",
]);

/** Flags the merged argv leaves out, as `--from` does (Arena.ts
 *  FROM_DROPPED): each takes a value. */
const SELECTION_FLAGS = new Set(["--out", "--shard", "--range", "--game"]);

/** The frame flags, left out of the merged argv when the parts disagree on
 *  them: --image-every takes a value, --images none. */
const FRAME_FLAGS = new Set(["--images", "--image-every"]);

/** One of the directories a merged run was joined from. */
export interface MergeSource {
  dir: string;
  commit: string | null;
  dirty: boolean | null;
  shard: Shard | null;
  range: [number, number] | null;
  /** --game N: the one job it played. */
  onlyGame: number | null;
  /** Game files and crashes taken from it. */
  games: number;
  crashes: number;
}

/** summary.json of a merged run. */
export type MergedSummary = Omit<SummaryFile, "argv"> & {
  /** The reference part's command line (see mergeRuns) without --out, the
   *  selection flags, and the frame flags if the parts disagree on them;
   *  missing if it predates argv (`--from` then rebuilds it from config). */
  argv?: string[];
  mergedFrom: MergeSource[];
  /** Game numbers g with a job that no part played or crashed. */
  missingGames: number[];
};

export interface MergeResult {
  summary: MergedSummary;
  /** Parts that disagree (only with force), missing games, crashes. */
  warnings: string[];
}

/** A directory as messages name it: relative below the working directory. */
function shown(dir: string): string {
  const rel = path.relative(process.cwd(), dir);
  return rel === "" ? "." : rel.startsWith("..") ? dir : rel;
}

const gameFile = (index: number) => `game${String(index).padStart(3, "0")}`;

/** "3-5, 9": sorted integers as runs. */
export function ranges(xs: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < xs.length; ) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    parts.push(i === j ? `${xs[i]}` : `${xs[i]}-${xs[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

/** Every job index of the run `c` describes, by game number. */
function expectedJobs(c: RunConfig): { game: number; index: number }[] {
  // Runs from before --each-map lack eachMap and repeat.
  const games = c.eachMap ? c.maps.length * (c.repeat ?? 1) : c.games;
  const per = c.together ? 1 : c.entrants.length;
  const jobs: { game: number; index: number }[] = [];
  for (let g = 0; g < games; g++) {
    for (let e = 0; e < per; e++) jobs.push({ game: g, index: g * per + e });
  }
  return jobs;
}

/** Why `run` is not a part of the same run as `ref`; empty if it is. */
function disagreements(ref: Run, run: Run): string[] {
  const who = shown(run.dir);
  if (run.config === null) {
    return [`${who} has no summary.json (did the run finish?)`];
  }
  const out: string[] = [];
  const differ = (what: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push(
        `${who}: ${what} ${JSON.stringify(b)}, but ${shown(ref.dir)} has ${JSON.stringify(a)}`,
      );
    }
  };
  differ("commit", ref.commit, run.commit);
  differ("dirty", ref.dirty, run.dirty);
  differ("suite", ref.suite, run.suite);
  const a = ref.config as unknown as Record<string, unknown>;
  const b = run.config as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!PER_PART.has(key)) differ(key, a[key], b[key]);
  }
  return out;
}

/**
 * Joins the results directories `dirs` into `out` (see the file comment).
 * Throws, writing nothing, if a game file is in two of them, if `out`
 * already holds a run, or, unless `force`, if they are not parts of one run.
 */
export function mergeRuns(
  dirs: readonly string[],
  out: string,
  force = false,
): MergeResult {
  if (dirs.length === 0) throw new Error("no results directories to merge");
  out = path.resolve(out);
  const resolved = dirs.map((d) => path.resolve(d));
  if (new Set(resolved).size < resolved.length) {
    throw new Error("a directory is given twice");
  }
  if (resolved.includes(out)) {
    throw new Error(`--out ${shown(out)} is one of the directories merged`);
  }
  const outGames = path.join(out, "games");
  if (
    fs.existsSync(path.join(out, "summary.json")) ||
    (fs.existsSync(outGames) &&
      fs.readdirSync(outGames).some((f) => f.endsWith(".json")))
  ) {
    throw new Error(`${shown(out)} already holds a run: merge into a new one`);
  }
  const runs = resolved.map(readRun);
  // The reference is a part that played a shard or range when there is one:
  // a --game rerun's frames (or anything else per part) are not the run's.
  const withConfig = runs.filter((r) => r.config !== null);
  const whole = withConfig.filter((r) => (r.config!.onlyGame ?? null) === null);
  const ref = whole[0] ?? withConfig[0];
  if (ref === undefined) {
    throw new Error("none of the directories has a summary.json to merge");
  }

  // Conflicts --force overrides: parts of different runs (checked first, as
  // a different entrant count also makes job indices collide), or games that
  // disagree on their map or game id.
  const refuse = (problems: string[]) => {
    if (problems.length > 0 && !force) {
      throw new Error(
        `these directories are not parts of one run:\n` +
          problems.map((p) => `  - ${p}`).join("\n") +
          `\n(--force merges them anyway)`,
      );
    }
    return problems;
  };
  const problems = refuse(
    runs.flatMap((r) => (r === ref ? [] : disagreements(ref, r))),
  );
  const byIndex = new Map<number, { run: Run; game: StoredGame }>();
  const byGame = new Map<
    number,
    { map: string; gameID: string; dir: string }
  >();
  const conflicts: string[] = [];
  for (const run of runs) {
    for (const game of run.games) {
      const seen = byIndex.get(game.index);
      if (seen !== undefined) {
        throw new Error(
          `games/${gameFile(game.index)}.json is in both ${shown(seen.run.dir)} ` +
            `and ${shown(run.dir)}: remove one`,
        );
      }
      byIndex.set(game.index, { run, game });
      const first = byGame.get(game.game);
      if (first === undefined) {
        byGame.set(game.game, {
          map: game.map,
          gameID: game.gameID,
          dir: run.dir,
        });
      } else if (first.map !== game.map || first.gameID !== game.gameID) {
        conflicts.push(
          `game ${game.game} is ${game.map} ${game.gameID} in ${shown(run.dir)} ` +
            `but ${first.map} ${first.gameID} in ${shown(first.dir)}`,
        );
      }
    }
  }
  refuse(conflicts);
  const warnings = [...problems, ...conflicts].map(
    (p) => `merged despite: ${p}`,
  );
  const frames = (parts: Run[]) =>
    new Set(parts.map((r) => `${r.config!.images}/${r.config!.imageEvery}`));
  if (frames(withConfig).size > 1) {
    warnings.push(
      `the parts wrote different images (--images, --image-every): ` +
        `a gallery of the merged run lacks frames for some games`,
    );
  }
  // The run's frame settings are those its shards or ranges agree on (all
  // parts if there are only reruns); if they disagree, none, so that --from
  // the merged run does not replay every game with one part's frames.
  const framesAgree = frames(whole.length > 0 ? whole : withConfig).size === 1;
  const config: RunConfig = framesAgree
    ? ref.config!
    : { ...ref.config!, images: false, imageEvery: 0 };

  // A crash gives way to a game another part played; one crash per job.
  const crashes = new Map<number, { run: Run; crash: CrashedGame }>();
  for (const run of runs) {
    for (const crash of run.crashes) {
      if (!byIndex.has(crash.index) && !crashes.has(crash.index)) {
        crashes.set(crash.index, { run, crash });
      }
    }
  }
  const missingGames = [
    ...new Set(
      expectedJobs(config)
        .filter((j) => !byIndex.has(j.index) && !crashes.has(j.index))
        .map((j) => j.game),
    ),
  ];
  const total = new Set(expectedJobs(config).map((j) => j.game)).size;
  if (missingGames.length > 0) {
    warnings.push(
      `no part played ${missingGames.length} of the run's ${total} games: ` +
        `g ${ranges(missingGames)}`,
    );
  }
  if (crashes.size > 0) {
    warnings.push(
      `${crashes.size} job(s) crashed: ${ranges([...crashes.keys()].sort((a, b) => a - b))} ` +
        `(rerun each with --from ${shown(out)} --game N --out NEW, then merge ` +
        `NEW with the parts into a fresh directory)`,
    );
  }

  // Write: game files point at the merged images/, logs and images copied.
  const games = [...byIndex.values()].sort(
    (a, b) => a.game.index - b.game.index,
  );
  fs.mkdirSync(outGames, { recursive: true });
  const imagesOut = path.join(out, "images");
  const played: StoredGame[] = [];
  for (const { run, game } of games) {
    const stored: StoredGame = {
      ...game,
      images: game.images.map((f) => path.join(imagesOut, path.basename(f))),
    };
    played.push(stored);
    const name = gameFile(game.index);
    fs.writeFileSync(
      path.join(outGames, `${name}.json`),
      JSON.stringify(stored, null, 1),
    );
    const log = path.join(run.dir, "games", `${name}.log`);
    if (fs.existsSync(log)) {
      fs.copyFileSync(log, path.join(outGames, `${name}.log`));
    }
  }
  // Frames belong to the part that holds their game's file; a crashed
  // game's frames come from the first part that has them.
  const copied = new Set<string>();
  for (const run of runs) {
    const dir = path.join(run.dir, "images");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      const m = /^game(\d+)-/.exec(f);
      const owner = m === null ? undefined : byIndex.get(Number(m[1]));
      if (copied.has(f) || (owner !== undefined && owner.run !== run)) continue;
      fs.mkdirSync(imagesOut, { recursive: true });
      fs.copyFileSync(path.join(dir, f), path.join(imagesOut, f));
      copied.add(f);
    }
  }

  const crashed = [...crashes.values()]
    .map(({ crash }) => crash)
    .sort((a, b) => a.index - b.index);
  const entries = [
    ...played.map(gameEntry),
    ...crashed.map((c) => ({ ...c })),
  ].sort((a, b) => a.index - b.index);
  const same = <T>(values: T[]): T | null =>
    values.every((v) => v === values[0]) ? values[0] : null;
  const dirty = withConfig.map((r) => r.dirty);
  const wallSeconds = runs.reduce((sum, r) => {
    const file = path.join(r.dir, "summary.json");
    if (!fs.existsSync(file)) return sum;
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as {
      wallSeconds?: number;
    };
    return sum + (s.wallSeconds ?? 0);
  }, 0);
  const argv = ref.argv?.filter(
    (a, i, all) =>
      !SELECTION_FLAGS.has(a) &&
      !SELECTION_FLAGS.has(all[i - 1]) &&
      (framesAgree || (!FRAME_FLAGS.has(a) && all[i - 1] !== "--image-every")),
  );
  const summary: MergedSummary = {
    config: { ...config, out, onlyGame: null },
    commit: same(withConfig.map((r) => r.commit)),
    dirty: dirty.includes(true) ? true : same(dirty),
    changedDuringRun: runs.some((r) => r.changedDuringRun),
    suite: same(withConfig.map((r) => r.suite)),
    shard: null,
    range: null,
    ...(argv === undefined ? {} : { argv }),
    // The parts' wall time added up: what one session would have taken.
    wallSeconds,
    summaries: summarizeEntrants(config.entrants, played, crashed),
    games: entries,
    mergedFrom: runs.map((r) => ({
      dir: r.dir,
      commit: r.commit,
      dirty: r.dirty,
      shard: r.shard,
      range: r.range,
      onlyGame: r.config?.onlyGame ?? null,
      games: games.filter((g) => g.run === r).length,
      crashes: crashed.filter((c) => crashes.get(c.index)!.run === r).length,
    })),
    missingGames,
  };
  fs.writeFileSync(
    path.join(out, "summary.json"),
    JSON.stringify(summary, null, 1),
  );
  fs.writeFileSync(
    path.join(out, "summary.md"),
    mergedMarkdown(summary, warnings),
  );
  return { summary, warnings };
}

/** What a part played: "shard 0/4", "games 0-31", "job 7", or "all". */
function partLabel(s: MergeSource): string {
  const parts = [
    s.shard === null ? null : `shard ${s.shard.index}/${s.shard.count}`,
    s.range === null ? null : `games ${s.range[0]}-${s.range[1] - 1}`,
    s.onlyGame === null ? null : `job ${s.onlyGame}`,
  ].filter((p) => p !== null);
  return parts.length === 0 ? "all" : parts.join(", ");
}

/** summary.md of a merged run, in the arena's layout. */
export function mergedMarkdown(
  s: MergedSummary,
  warnings: readonly string[],
): string {
  const c = s.config;
  const version =
    s.commit !== null
      ? `${s.commit.slice(0, 7)}${s.dirty ? "+" : ""}`
      : s.mergedFrom.some((m) => m.commit !== null)
        ? "mixed commits"
        : "no git";
  const parts = s.mergedFrom
    .map(
      (m) =>
        `- ${shown(m.dir)}: ${partLabel(m)}, ${m.games} game file(s)` +
        (m.crashes > 0 ? `, ${m.crashes} crash(es)` : "") +
        (m.commit === null
          ? ""
          : `, ${m.commit.slice(0, 7)}${m.dirty ? "+" : ""}`),
    )
    .join("\n");
  return (
    `# Arena ${s.suite === null ? c.seed : `${s.suite} (seed ${c.seed})`}, ` +
    `merged from ${s.mergedFrom.length} parts\n\n` +
    `${c.difficulty} nations, ${c.bots} bots, ${c.size} maps, ` +
    `cap ${c.maxMinutes} min, latency ${c.latency} tick(s), ${version}.\n\n` +
    `${summaryTable(s.summaries)}\n\n${parts}\n` +
    (warnings.length === 0
      ? ""
      : `\n${warnings.map((w) => `**Warning:** ${w}`).join("\n\n")}\n`)
  );
}

const HELP = `Usage: npm run arena:merge -- --out DIR PART_DIR [PART_DIR...] [--force]

Joins the results directories of one run (--shard, --range or --game parts,
e.g. from several sessions) into DIR: game files, logs and images, with
summary.json and summary.md rebuilt for the whole run.

  --out DIR   The merged results directory (must not hold a run yet)
  --force     Merge parts that disagree on the commit, local changes, suite,
              seed, entrants or another flag that decides the games
`;

function main(): void {
  const argv = process.argv.slice(2);
  const dirs: string[] = [];
  let out: string | null = null;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      return;
    } else if (arg === "--out") {
      out = argv[++i];
      if (out === undefined) throw new Error("missing value for --out");
    } else if (arg === "--force") {
      force = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown argument "${arg}" (see --help)`);
    } else {
      dirs.push(arg);
    }
  }
  if (out === null) throw new Error(`--out is required\n\n${HELP}`);
  if (dirs.length === 0) throw new Error(`no directories to merge\n\n${HELP}`);
  const { summary, warnings } = mergeRuns(dirs, out, force);
  for (const w of warnings) console.warn(`Warning: ${w}`);
  const played = summary.games.filter((g) => !("crash" in g)).length;
  console.log(
    `\n${summaryTable(summary.summaries)}\n\n` +
      `Merged ${played} game file(s) from ${dirs.length} directories → ${summary.config.out}`,
  );
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
