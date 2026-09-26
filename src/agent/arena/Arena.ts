/**
 * The arena: pits agents against the built-in AI on random maps, headless and
 * in parallel, and reports how they did. Every game is deterministic in its
 * spec, so the same --seed reproduces the same games exactly.
 *
 *   npm run arena -- --games 16 --agent baseline
 *   npm run arena -- --agent baseline --agent 'baseline:{"attackRatio":0.7}'
 *   npm run arena -- --suite dev --shard 0/4
 *   npm run arena -- --from arena-results/dev-x --game 7 --image-every 1
 *   npm run arena -- --help
 *
 * Statistics and the results-directory format are in Summary.ts, the named
 * suites in Suites.ts.
 */
import { ChildProcess, fork } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameType,
  maps as MAP_INFO,
} from "../../core/game/Game";
import { PseudoRandom } from "../../core/PseudoRandom";
import { simpleHash } from "../../core/Util";
import { AGENTS, createAgent } from "../agents";
import { ArenaGameResult, ArenaGameSpec, SeatSpec } from "./ArenaGame";
import type { ArenaWorkerRequest } from "./ArenaWorker";
import { isMain } from "./Cli";
import { parseSuiteName, suiteArgs, SuiteName, suitesHelp } from "./Suites";
import {
  codeFingerprint,
  CrashedGame,
  gameEntry,
  pct,
  provenance,
  RunConfig,
  Shard,
  StoredGame,
  storedGame,
  summarizeEntrants,
  SummaryFile,
  summaryTable,
} from "./Summary";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const MAPS_DIR = path.join(ROOT, "resources/maps");

const HELP = `Usage: npm run arena -- [options]

Agents
  --agent NAME[:JSON]    Entrant; repeat to compare. JSON = agent options.
                         Available: ${Object.keys(AGENTS).join(", ")}. Default: baseline
  --together             Seat all entrants in the same games (FFA between them)
                         instead of giving each its own copy of every game.

Suites
  --suite NAME           A named preset of maps, seed and flags (docs/11-roadmap.md
                         §11.5). A flag given explicitly overrides the suite's
                         value wherever it appears (on/off flags it sets stay
                         on); --games N turns its --each-map into N random
                         draws from its maps. A run whose flags change which
                         games the suite plays, or how, is recorded as
                         "NAME (modified)".
${suitesHelp("    ")}

Games
  --games N              Games per entrant (default 8)
  --each-map             Instead of --games random draws, one game per map in
                         the pool, in pool order (--maps order if given)
  --repeat R             With --each-map: play the whole pool R times (default 1)
  --seed S               Run seed: picks maps and game ids (default "arena")
  --maps a,b             Only these maps (enum keys, e.g. Europe,World). The
                         default pool is every map that has nations.
  --categories a,b       Only maps in these picker categories (e.g. featured)
  --exclude a,b          Never these maps
  --difficulty D         Easy | Medium | Hard | Impossible (default Impossible)
  --nations N            Nation count, "default" or "disabled" (default default)
  --bots N               Tribes (default 400, the solo default)
  --size S               normal | compact (default normal)
  --max-minutes M        Game-time cap in minutes (default 60)
  --latency T            Ticks from decision to execution, >= 1 (default 1)
  --no-rate-limit        Do not enforce the server's 10/s, 150/min intent limits
  --isolate              Each agent reads its own replica; abort on divergence
  --play-out             Keep simulating after every agent is out
  --strict               An agent exception aborts its game

Selecting games (never change which map or game id a game gets; g is the game
number, counted before each entrant gets its copy)
  --shard I/N            Only the games with g % N == I, every entrant's copy:
                         N sessions running shards 0/N..N-1/N play the run
  --range A:B            Only the games A <= g < B
  --game N               Only job N, the one written to games/gameNNN.json
  --from DIR             Start from the flags of the run in DIR (the argv in its
                         summary.json, with the map pool it played pinned)
                         without its --out, --shard, --range and --game. Flags
                         given with --from, before or after it, override
                         them, and any --agent replaces that run's entrants.
                         Refuses if this checkout would put a game of that run
                         on another map or game id. To look at game 7 of a run:
                           --from DIR --game 7 --images --image-every 1 --verbose

Output
  --out DIR              Results directory (default arena-results/<seed>-<time>)
  --images               Write a final territory PNG per game
  --image-every M        Also write one every M game minutes
  --timeline-every S     Seconds of game time between timeline samples (30)
  --jobs J               Games in parallel (default: CPU count)
  --verbose              Keep the simulation's console output
  --quiet                Only print the summary

summary.json records the git commit, whether src, resources or the package
files had local changes (or changed while the run played), the suite, the
selection and the command line. Under --strict or --isolate the arena exits
with code 2 if a game stopped on an error or a worker crashed.
`;

interface Entrant {
  label: string;
  seat: SeatSpec;
}

export interface Options {
  entrants: Entrant[];
  together: boolean;
  games: number;
  eachMap: boolean;
  repeat: number;
  seed: string;
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
  /** The suite, `name (modified)` if explicit flags change which games it
   *  plays or how (anything but the entrants, the selection and the
   *  output); null for none. */
  suite: string | null;
  shard: Shard | null;
  /** [from, to): the games from <= g < to. */
  range: [number, number] | null;
  /** --game N: the one job index to play. */
  onlyGame: number | null;
  /** The command line with --from expanded (the suite stays a name). */
  argv: string[];
  /** The run --from replays, null without --from. */
  from: FromRun | null;
}

/** The earlier run a --from command line replays. */
export interface FromRun {
  dir: string;
  /** Its flags as --from loads them, before the flags given with --from:
   *  the command line that replays it. */
  argv: string[];
}

/** One game for one worker: an entrant's copy of game g. */
export interface ArenaJob {
  spec: ArenaGameSpec;
  /** Index into Options.entrants; -1 with --together (every entrant). */
  entrant: number;
  /** The game number g; its map and game id depend only on it and the seed. */
  game: number;
}

function mapByName(name: string): GameMapType {
  const info = MAP_INFO.find(
    (m) =>
      m.id.toLowerCase() === name.toLowerCase() ||
      m.type.toLowerCase() === name.toLowerCase(),
  );
  if (info === undefined) {
    throw new Error(`unknown map "${name}"`);
  }
  return info.type;
}

function parseEntrant(arg: string): Entrant {
  const colon = arg.indexOf(":");
  const name = colon < 0 ? arg : arg.slice(0, colon);
  if (AGENTS[name] === undefined) {
    throw new Error(
      `unknown agent "${name}". Available: ${Object.keys(AGENTS).join(", ")}`,
    );
  }
  if (colon < 0) return { label: name, seat: { agent: name } };
  const options = JSON.parse(arg.slice(colon + 1)) as Record<string, unknown>;
  createAgent(name, options); // refuses unknown options before any game plays
  return { label: arg, seat: { agent: name, options } };
}

/** Flags of an earlier run that --from leaves out: where its results went and
 *  which of its games it played. Each takes a value. */
const FROM_DROPPED = ["--out", "--shard", "--range", "--game"];

/** summary.json as --from reads it: runs from before --each-map lack eachMap
 *  and repeat, runs from before M1 the provenance, argv and game numbers. */
type RecordedRun = Partial<
  Pick<SummaryFile, "argv" | "commit" | "dirty" | "games">
> & {
  config?: Omit<RunConfig, "eachMap" | "repeat"> &
    Partial<Pick<RunConfig, "eachMap" | "repeat">>;
};

function readRecorded(dir: string): RecordedRun {
  const file = path.join(dir, "summary.json");
  if (!fs.existsSync(file)) {
    throw new Error(`--from: ${file} not found (did that run finish?)`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as RecordedRun;
}

/**
 * The command line of the run in `dir`: its recorded argv, or for a run from
 * before argv was recorded, the flags its config stands for (the map pool in
 * draw order, so random draws replay).
 */
export function runArgv(dir: string): string[] {
  return recordedArgv(readRecorded(dir), dir);
}

function recordedArgv(summary: RecordedRun, dir: string): string[] {
  if (summary.argv !== undefined) return summary.argv;
  const c = summary.config;
  if (c === undefined) {
    throw new Error(`--from: ${dir}/summary.json records no command line`);
  }
  const flag = (on: boolean | undefined, name: string) => (on ? [name] : []);
  return [
    ...c.entrants.flatMap((e) => ["--agent", e]),
    ...flag(c.together, "--together"),
    ...["--games", String(c.games)],
    ...flag(c.eachMap, "--each-map"),
    ...["--repeat", String(c.repeat ?? 1)],
    ...["--seed", c.seed],
    ...["--maps", c.maps.join(",")],
    ...["--difficulty", c.difficulty],
    ...["--nations", String(c.nations)],
    ...["--bots", String(c.bots)],
    ...["--size", c.size.toLowerCase()],
    ...["--max-minutes", String(c.maxMinutes)],
    ...["--latency", String(c.latency)],
    ...flag(!c.rateLimit, "--no-rate-limit"),
    ...flag(c.isolate, "--isolate"),
    ...flag(c.playOut, "--play-out"),
    ...flag(c.strict, "--strict"),
    ...["--timeline-every", String(c.timelineEvery)],
  ];
}

/**
 * Replaces `--from DIR` with that run's flags (see --help), followed by the
 * flags given with it, before or after it, so those win. The map pool of a
 * run that played the default pool (dev, holdout) is pinned unless the flags
 * given choose maps themselves: a map added to the generated list since
 * would otherwise move every later game to another map under the same id.
 */
function expandFrom(argv: string[]): { args: string[]; from: FromRun | null } {
  const at = argv.indexOf("--from");
  if (at < 0) return { args: argv, from: null };
  if (argv.indexOf("--from", at + 1) >= 0) {
    throw new Error("--from can only be given once");
  }
  const value = argv[at + 1];
  if (value === undefined) throw new Error("missing value for --from");
  const dir = path.resolve(value);
  const given = [...argv.slice(0, at), ...argv.slice(at + 2)];
  const dropped = new Set(FROM_DROPPED);
  if (given.includes("--agent")) dropped.add("--agent");
  const summary = readRecorded(dir);
  const loaded = recordedArgv(summary, dir);
  const replay: string[] = [];
  for (let i = 0; i < loaded.length; i++) {
    if (dropped.has(loaded[i])) i++;
    else replay.push(loaded[i]);
  }
  // A run that named its maps is pinned already.
  const maps = summary.config?.maps;
  if (
    Array.isArray(maps) &&
    maps.length > 0 &&
    !replay.includes("--maps") &&
    !given.includes("--maps") &&
    !given.includes("--suite")
  ) {
    replay.push("--maps", maps.join(","));
  }
  return { args: [...replay, ...given], from: { dir, argv: replay } };
}

/** The options that decide which games a run plays and how they play. */
type GameOptions = Pick<
  Options,
  | "maps"
  | "seed"
  | "eachMap"
  | "repeat"
  | "games"
  | "difficulty"
  | "nations"
  | "bots"
  | "size"
  | "maxMinutes"
  | "latency"
  | "rateLimit"
  | "playOut"
  | "strict"
>;

function sameGames(a: GameOptions, b: GameOptions): boolean {
  const key = (o: GameOptions) =>
    JSON.stringify([
      o.maps,
      o.seed,
      o.eachMap,
      o.eachMap ? o.repeat : o.games,
      o.difficulty,
      o.nations,
      o.bots,
      o.size,
      o.maxMinutes,
      o.latency,
      o.rateLimit,
      o.playOut,
      o.strict,
    ]);
  return key(a) === key(b);
}

export function parseArgs(argv: string[]): Options {
  const { args, from } = expandFrom(argv);
  const o = resolveArgs(args);
  // A suite whose games the flags changed is recorded as modified, so
  // summary.md, compare and merge do not pass the run off as the suite.
  const suite =
    o.suite === null || sameGames(o, resolveArgs(["--suite", o.suite]))
      ? o.suite
      : `${o.suite} (modified)`;
  return { ...o, suite, from };
}

/** parseArgs without --from, with the suite as given. */
function resolveArgs(
  args: string[],
): Omit<Options, "suite" | "from"> & { suite: SuiteName | null } {
  const list = (v: string) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  // A suite's flags are read before the command line's, so an explicit flag
  // overrides the suite's value wherever it is given.
  let suite: SuiteName | null = null;
  for (let i = args.indexOf("--suite"); i >= 0; ) {
    const name = args[i + 1];
    if (name === undefined) throw new Error("missing value for --suite");
    suite = parseSuiteName(name);
    i = args.indexOf("--suite", i + 2);
  }
  const preset = suite === null ? [] : suiteArgs(suite);
  const all = [...preset, ...args];
  let explicitGames = false;
  let explicitEachMap = false;

  const entrants: Entrant[] = [];
  let onlyMaps: string[] | null = null;
  let categories: string[] | null = null;
  let exclude: string[] = [];
  let out: string | null = null;
  const o: Omit<
    Options,
    "entrants" | "maps" | "out" | "suite" | "argv" | "from"
  > = {
    together: false,
    games: 8,
    eachMap: false,
    repeat: 1,
    seed: "arena",
    difficulty: Difficulty.Impossible,
    nations: "default",
    bots: 400,
    size: GameMapSize.Normal,
    maxMinutes: 60,
    latency: 1,
    rateLimit: true,
    isolate: false,
    playOut: false,
    strict: false,
    images: false,
    imageEvery: 0,
    timelineEvery: 30,
    jobs: os.availableParallelism(),
    verbose: false,
    quiet: false,
    shard: null,
    range: null,
    onlyGame: null,
  };
  for (let i = 0; i < all.length; i++) {
    const arg = all[i];
    const explicit = i >= preset.length;
    const next = () => {
      const v = all[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    const int = () => {
      const v = Number(next());
      if (!Number.isInteger(v) || v < 0) {
        throw new Error(`${arg} needs a non-negative integer`);
      }
      return v;
    };
    switch (arg) {
      case "--help":
      case "-h":
        process.stdout.write(HELP);
        process.exit(0);
        break;
      case "--suite":
        next(); // read above
        break;
      case "--agent":
        entrants.push(parseEntrant(next()));
        break;
      case "--together":
        o.together = true;
        break;
      case "--games":
        o.games = int();
        explicitGames ||= explicit;
        break;
      case "--each-map":
        o.eachMap = true;
        explicitEachMap ||= explicit;
        break;
      case "--repeat":
        o.repeat = Math.max(1, int());
        break;
      case "--seed":
        o.seed = next();
        break;
      case "--maps":
        onlyMaps = list(next());
        break;
      case "--categories":
        categories = list(next());
        break;
      case "--exclude":
        exclude = list(next());
        break;
      case "--difficulty": {
        const v = next();
        const d = Object.values(Difficulty).find(
          (x) => x.toLowerCase() === v.toLowerCase(),
        );
        if (d === undefined) throw new Error(`unknown difficulty "${v}"`);
        o.difficulty = d;
        break;
      }
      case "--nations": {
        const v = next();
        o.nations = v === "default" || v === "disabled" ? v : Number(v);
        break;
      }
      case "--bots":
        o.bots = int();
        break;
      case "--size": {
        const v = next().toLowerCase();
        if (v !== "normal" && v !== "compact") {
          throw new Error(`--size must be normal or compact`);
        }
        o.size = v === "normal" ? GameMapSize.Normal : GameMapSize.Compact;
        break;
      }
      case "--max-minutes":
        o.maxMinutes = int();
        break;
      case "--latency":
        o.latency = Math.max(1, int());
        break;
      case "--no-rate-limit":
        o.rateLimit = false;
        break;
      case "--isolate":
        o.isolate = true;
        break;
      case "--play-out":
        o.playOut = true;
        break;
      case "--strict":
        o.strict = true;
        break;
      case "--shard": {
        const m = /^(\d+)\/(\d+)$/.exec(next());
        const [index, count] = m === null ? [NaN, NaN] : [+m[1], +m[2]];
        if (!(count >= 1 && index < count)) {
          throw new Error(`--shard needs I/N with 0 <= I < N, e.g. 0/4`);
        }
        o.shard = { index, count };
        break;
      }
      case "--range": {
        const m = /^(\d+):(\d+)$/.exec(next());
        const [from, to] = m === null ? [NaN, NaN] : [+m[1], +m[2]];
        if (!(from < to)) {
          throw new Error(`--range needs A:B with 0 <= A < B, e.g. 0:32`);
        }
        o.range = [from, to];
        break;
      }
      case "--game":
        o.onlyGame = int();
        break;
      case "--from":
        throw new Error("--from can only be given once");
      case "--out":
        out = next();
        break;
      case "--images":
        o.images = true;
        break;
      case "--image-every":
        o.imageEvery = int();
        o.images = true;
        break;
      case "--timeline-every":
        o.timelineEvery = Math.max(1, int());
        break;
      case "--jobs":
        o.jobs = Math.max(1, int());
        break;
      case "--verbose":
        o.verbose = true;
        break;
      case "--quiet":
        o.quiet = true;
        break;
      default:
        throw new Error(`unknown argument "${arg}" (see --help)`);
    }
  }
  if (entrants.length === 0) entrants.push(parseEntrant("baseline"));
  // An explicit --games asks for random draws, over a suite's --each-map.
  if (explicitGames && !explicitEachMap) o.eachMap = false;

  // With default nations, a map without any is a game against tribes only,
  // which measures nothing about the built-in AI: leave those out unless
  // asked for by name.
  let pool = MAP_INFO.filter(
    (m) => o.nations !== "default" || m.defaultNationCount > 0,
  ).map((m) => m.type);
  if (onlyMaps !== null) pool = onlyMaps.map(mapByName);
  if (categories !== null) {
    const wanted = new Set(categories);
    pool = pool.filter((t) =>
      MAP_INFO.find((m) => m.type === t)!.categories.some((c) => wanted.has(c)),
    );
  }
  const excluded = new Set(exclude.map(mapByName));
  pool = pool.filter((t) => !excluded.has(t));
  if (pool.length === 0) throw new Error("the map pool is empty");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const selected = [
    o.shard === null ? "" : `-shard${o.shard.index}of${o.shard.count}`,
    o.range === null ? "" : `-games${o.range[0]}to${o.range[1]}`,
    o.onlyGame === null ? "" : `-game${o.onlyGame}`,
  ].join("");
  return {
    ...o,
    entrants,
    maps: pool,
    out: path.resolve(
      out ?? path.join(ROOT, "arena-results", `${o.seed}${selected}-${stamp}`),
    ),
    suite,
    argv: args,
  };
}

/** 8 alphanumerics, derived from the run seed and game index. */
function gameIDFor(seed: string, index: number): string {
  const h = simpleHash(`${seed}:${index}`) >>> 0;
  return `G${h.toString(36).padStart(7, "0").slice(-7)}`;
}

/** Every job of the run, before --shard, --range and --game select. */
export function makeSpecs(o: Options): ArenaJob[] {
  const rng = new PseudoRandom(simpleHash(o.seed));
  const jobs: ArenaJob[] = [];
  const games = o.eachMap ? o.maps.length * o.repeat : o.games;
  for (let g = 0; g < games; g++) {
    // Random draws only consume the PRNG when used, so existing seeds keep
    // replaying the same maps.
    const map = o.eachMap
      ? o.maps[g % o.maps.length]
      : o.maps[rng.nextInt(0, o.maps.length)];
    const seats = (entrants: Entrant[]) => entrants.map((e) => e.seat);
    const base = {
      gameID: gameIDFor(o.seed, g),
      map,
      mapSize: o.size,
      difficulty: o.difficulty,
      nations: o.nations,
      bots: o.bots,
      maxTicks: o.maxMinutes * 600,
      latencyTicks: o.latency,
      rateLimit: o.rateLimit,
      isolate: o.isolate,
      timelineEvery: o.timelineEvery * 10,
      playOut: o.playOut,
      strict: o.strict,
      imagesDir: o.images ? path.join(o.out, "images") : null,
      imageEvery: o.imageEvery * 600,
    };
    if (o.together) {
      jobs.push({
        spec: {
          ...base,
          index: g,
          gameType:
            o.entrants.length > 1 ? GameType.Private : GameType.Singleplayer,
          seats: seats(o.entrants),
        },
        entrant: -1,
        game: g,
      });
    } else {
      o.entrants.forEach((e, i) =>
        jobs.push({
          spec: {
            ...base,
            index: g * o.entrants.length + i,
            gameType: GameType.Singleplayer,
            seats: [e.seat],
          },
          entrant: i,
          game: g,
        }),
      );
    }
  }
  return jobs;
}

/** The jobs this invocation plays: `jobs` narrowed by --shard, --range and
 *  --game. Throws if nothing is left. */
export function selectJobs(o: Options, jobs: ArenaJob[]): ArenaJob[] {
  const picked = jobs.filter(
    (j) =>
      (o.shard === null || j.game % o.shard.count === o.shard.index) &&
      (o.range === null || (j.game >= o.range[0] && j.game < o.range[1])) &&
      (o.onlyGame === null || j.spec.index === o.onlyGame),
  );
  if (picked.length === 0) {
    const games = jobs.length === 0 ? 0 : jobs[jobs.length - 1].game + 1;
    throw new Error(
      o.onlyGame !== null && !jobs.some((j) => j.spec.index === o.onlyGame)
        ? `--game ${o.onlyGame}: the run has jobs 0-${jobs.length - 1}`
        : `the selection leaves none of the run's ${games} games`,
    );
  }
  return picked;
}

function runJob(
  spec: ArenaGameSpec,
  o: Options,
): Promise<ArenaGameResult | { crash: string }> {
  return new Promise((resolve) => {
    const child: ChildProcess = fork(path.join(HERE, "ArenaWorker.ts"), [], {
      execArgv: ["--import", "tsx"],
      stdio: o.verbose ? "inherit" : ["ignore", "ignore", "inherit", "ipc"],
    });
    let settled = false;
    child.on("message", (m: { result?: ArenaGameResult; crash?: string }) => {
      settled = true;
      resolve(m.result ?? { crash: m.crash ?? "unknown crash" });
    });
    child.on("exit", (code, signal) => {
      if (!settled) {
        resolve({ crash: `worker exited (code ${code}, signal ${signal})` });
      }
    });
    const req: ArenaWorkerRequest = {
      spec,
      mapsDir: MAPS_DIR,
      verbose: o.verbose,
    };
    child.send(req);
  });
}

/**
 * The selection as the run header and summary.md describe it, "" for all:
 * --shard and --range pick games (of the run's game numbers), --game a job
 * (of its jobs, one per entrant per game unless --together).
 */
export function selection(o: Options, all: readonly ArenaJob[]): string {
  const games = all.length === 0 ? 0 : all[all.length - 1].game + 1;
  const picked = [
    o.shard === null ? null : `shard ${o.shard.index}/${o.shard.count}`,
    o.range === null ? null : `games ${o.range[0]}-${o.range[1] - 1}`,
  ].filter((p) => p !== null);
  const parts = [
    ...(picked.length === 0 ? [] : [`${picked.join(", ")} of ${games} games`]),
    ...(o.onlyGame === null ? [] : [`job ${o.onlyGame} of ${all.length} jobs`]),
  ];
  return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
}

/** What `jobs` play: "3 games", or "1 game × 2 entrants" when each game is
 *  played once per entrant. */
export function playing(jobs: readonly ArenaJob[]): string {
  const games = new Set(jobs.map((j) => j.game)).size;
  const copies = games === 0 ? 0 : jobs.length / games;
  return (
    `${games} game${games === 1 ? "" : "s"}` +
    (copies > 1 ? ` × ${copies} entrants` : "")
  );
}

/** summary.md's list of the jobs that did not run to their end: games that
 *  stopped on an error, and crashed workers. */
export function failedJobs(
  played: readonly StoredGame[],
  crashes: readonly CrashedGame[],
): string[] {
  const first = (text: string) => text.split("\n")[0];
  return [
    ...played.flatMap((g) =>
      g.error === null
        ? []
        : [
            {
              index: g.index,
              line:
                `- job ${g.index}, ${g.map} ${g.gameID}: stopped at ` +
                `${g.gameMinutes.toFixed(1)} min on an error: ${first(g.error)}`,
            },
          ],
    ),
    ...crashes.map((c) => ({
      index: c.index,
      line: `- job ${c.index}, ${c.map} ${c.gameID}: crashed: ${first(c.crash)}`,
    })),
  ]
    .sort((a, b) => a.index - b.index)
    .map((f) => f.line);
}

/**
 * Checks a --from rerun against the run it replays. Game g of the run's own
 * flags (without those given with --from) must still be on the map and game
 * id the run recorded for it, or this checkout draws differently now (a
 * default or a suite changed) and the rerun would be another game: throws,
 * naming the games. Returns warnings when the code may differ from what
 * played the run.
 */
export function checkReplay(
  from: FromRun,
  selected: readonly ArenaJob[],
  head: { commit: string | null; dirty: boolean | null },
): string[] {
  const run = readRecorded(from.dir);
  // Runs from before M1 record no game number: derive it from the index.
  const perGame = () =>
    run.config === undefined || run.config.together
      ? 1
      : run.config.entrants.length;
  const recorded = new Map<number, { map: string; gameID: string }>();
  for (const g of run.games ?? []) {
    const game =
      (g as { game?: number }).game ?? Math.floor(g.index / perGame());
    recorded.set(game, g);
  }
  const replay = new Map<number, ArenaJob>();
  for (const j of makeSpecs(parseArgs(from.argv))) {
    if (!replay.has(j.game)) replay.set(j.game, j);
  }
  const moved: string[] = [];
  for (const g of new Set(selected.map((j) => j.game))) {
    const was = recorded.get(g);
    if (was === undefined) continue;
    const now = replay.get(g)?.spec;
    if (now?.map !== was.map || now.gameID !== was.gameID) {
      moved.push(
        `game ${g} was ${was.map} ${was.gameID}, now ` +
          (now === undefined ? "not in the run" : `${now.map} ${now.gameID}`),
      );
    }
  }
  const short = (c: string | null | undefined) => c?.slice(0, 7) ?? "unknown";
  if (moved.length > 0) {
    throw new Error(
      `--from ${from.dir}: this checkout does not replay that run's games ` +
        `(it ran on ${short(run.commit)}; a default or a suite changed since):\n` +
        moved.map((m) => `  - ${m}`).join("\n"),
    );
  }
  const warnings: string[] = [];
  if (run.commit !== undefined && run.commit !== head.commit) {
    warnings.push(
      `--from: that run played on ${short(run.commit)}, this checkout is ` +
        `${short(head.commit)}: its games may not replay exactly`,
    );
  }
  if (run.dirty === true) {
    warnings.push(`--from: that run played with local changes`);
  }
  if (head.dirty === true) {
    warnings.push(`--from: this checkout has local changes`);
  }
  return warnings;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const allJobs = makeSpecs(o);
  const jobs = selectJobs(o, allJobs);
  const { commit, dirty } = provenance(ROOT);
  if (o.from !== null) {
    for (const w of checkReplay(o.from, jobs, { commit, dirty })) {
      console.warn(`Warning: ${w}`);
    }
  }
  fs.mkdirSync(path.join(o.out, "games"), { recursive: true });
  const say = (line: string) => {
    if (!o.quiet) console.log(line);
  };
  const version =
    commit === null ? "no git" : `${commit.slice(0, 7)}${dirty ? "+" : ""}`;
  say(
    `Arena${o.suite === null ? "" : ` suite ${o.suite}`}: ` +
      `${playing(jobs)}${selection(o, allJobs)}, ` +
      `${o.entrants.map((e) => e.label).join(" vs ")}, ` +
      `${o.difficulty} nations, ${o.bots} bots, ${o.maps.length} maps in pool, ` +
      `seed ${o.seed}, ${version}, ${o.jobs} parallel → ` +
      `${path.relative(process.cwd(), o.out) || "."}`,
  );

  // Each worker loads src/ when it is forked: check before every fork, and
  // once after the last, that the code is still what the run started on.
  const code = codeFingerprint(ROOT);
  // Assigned in checkCode: typed so the narrowing to null does not stick.
  let changed = null as string | null;
  const checkCode = (when: string) => {
    if (code !== null && changed === null && codeFingerprint(ROOT) !== code) {
      changed = when;
    }
  };

  const results: { job: ArenaJob; res: StoredGame | CrashedGame }[] = [];
  let nextJob = 0;
  let done = 0;
  const started = performance.now();
  const worker = async () => {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob++];
      checkCode(`before job ${job.spec.index} started`);
      const res = await runJob(job.spec, o);
      done++;
      const tag = `[${done}/${jobs.length}]`;
      const place = {
        index: job.spec.index,
        game: job.game,
        entrant: o.together ? null : job.entrant,
      };
      if ("crash" in res) {
        results.push({
          job,
          res: {
            ...place,
            map: job.spec.map,
            gameID: job.spec.gameID,
            crash: res.crash,
          },
        });
        say(
          `${tag} game ${job.spec.index} ${job.spec.map}: CRASH ${res.crash.split("\n")[0]}`,
        );
        continue;
      }
      const name = `game${String(res.index).padStart(3, "0")}`;
      const stored = storedGame(res, place.game, place.entrant);
      results.push({ job, res: stored });
      fs.writeFileSync(
        path.join(o.out, "games", `${name}.json`),
        JSON.stringify(stored, null, 1),
      );
      fs.writeFileSync(
        path.join(o.out, "games", `${name}.log`),
        res.seats
          .map((s) => [`## ${s.agent} (${s.clientID})`, ...s.logs].join("\n"))
          .join("\n\n"),
      );
      res.seats.forEach((s, i) => {
        const entrant = o.entrants[o.together ? i : job.entrant].label;
        const label =
          entrant.length > 24 ? `${entrant.slice(0, 23)}…` : entrant;
        say(
          `${tag} ${label.padEnd(24)} ${res.map.padEnd(22)} ${s.result.padEnd(7)} ` +
            `place ${String(s.placement ?? "-").padStart(2)}/${res.nationsInGame + res.seats.length}  ` +
            `peak ${pct(s.peakShare).padStart(6)}  final ${pct(s.finalShare).padStart(6)}  ` +
            `${res.gameMinutes.toFixed(1)} min in ${(res.wallMs / 1000).toFixed(0)}s` +
            (res.error ? `  ERROR ${res.error.split("\n")[0]}` : "") +
            (s.stats.errors ? `  (${s.stats.errors} agent errors)` : ""),
        );
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(o.jobs, jobs.length) }, worker),
  );
  checkCode("after the last job started");
  results.sort((a, b) => a.job.spec.index - b.job.spec.index);

  const played = results.flatMap(({ res }) => ("crash" in res ? [] : [res]));
  const crashes = results.flatMap(({ res }) => ("crash" in res ? [res] : []));
  const summaries = summarizeEntrants(
    o.entrants.map((e) => e.label),
    played,
    crashes,
  );
  const wallSeconds = (performance.now() - started) / 1000;
  const changedDuringRun = changed !== null;
  const notes: string[] = [];
  if (changedDuringRun) {
    notes.push(
      `The code under src, resources or the package files changed during ` +
        `the run, ${changed}: games started after the change may have run ` +
        `other code, so the run is recorded as having local changes.`,
    );
  }
  const failed = failedJobs(played, crashes);
  if (failed.length > 0) {
    notes.push(
      `${failed.length} of ${jobs.length} job(s) did not run to their end:\n\n` +
        failed.join("\n"),
    );
  }
  const { entrants, suite, shard, range, argv, from, ...config } = o;
  const summary: SummaryFile = {
    config: {
      ...config,
      entrants: entrants.map((e) => e.label),
    } satisfies RunConfig,
    commit,
    dirty: changedDuringRun ? true : dirty,
    changedDuringRun,
    suite,
    shard,
    range,
    argv,
    from: from?.dir ?? null,
    wallSeconds,
    summaries,
    games: results.map(({ res }) => ("crash" in res ? res : gameEntry(res))),
  };
  fs.writeFileSync(
    path.join(o.out, "summary.json"),
    JSON.stringify(summary, null, 1),
  );
  const table = summaryTable(summaries);
  const finalVersion = changedDuringRun
    ? `${version}, changed during the run`
    : version;
  fs.writeFileSync(
    path.join(o.out, "summary.md"),
    `# Arena ${o.suite === null ? o.seed : `${o.suite} (seed ${o.seed})`}` +
      `${selection(o, allJobs)}\n\n` +
      `${o.difficulty} nations, ${o.bots} bots, ${o.size} maps, ` +
      `cap ${o.maxMinutes} min, latency ${o.latency} tick(s), ${finalVersion}.\n\n${table}\n` +
      notes.map((n) => `\n**Warning:** ${n}\n`).join(""),
  );
  console.log(
    `\n${table}\n\nWall time ${wallSeconds.toFixed(0)}s. Results: ${o.out}`,
  );
  for (const n of notes) console.warn(`\nWarning: ${n}`);
  // Under --strict or --isolate (the smoke suite) a failed game fails the
  // run, after its results are written.
  if ((o.strict || o.isolate) && failed.length > 0) {
    console.error(
      `\n${failed.length} job(s) failed under --strict/--isolate: exit code 2`,
    );
    process.exitCode = 2;
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
