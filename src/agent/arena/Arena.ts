/**
 * The arena: pits agents against the built-in AI on random maps, headless and
 * in parallel, and reports how they did. Every game is deterministic in its
 * spec, so the same --seed reproduces the same games exactly.
 *
 *   npm run arena -- --games 16 --agent baseline
 *   npm run arena -- --agent baseline --agent 'baseline:{"attackRatio":0.7}'
 *   npm run arena -- --help
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
import { AGENTS } from "../agents";
import { ArenaGameResult, ArenaGameSpec, SeatSpec } from "./ArenaGame";
import type { ArenaWorkerRequest } from "./ArenaWorker";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const MAPS_DIR = path.join(ROOT, "resources/maps");

const HELP = `Usage: npm run arena -- [options]

Agents
  --agent NAME[:JSON]    Entrant; repeat to compare. JSON = agent options.
                         Available: ${Object.keys(AGENTS).join(", ")}. Default: baseline
  --together             Seat all entrants in the same games (FFA between them)
                         instead of giving each its own copy of every game.

Games
  --games N              Games per entrant (default 8)
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

Output
  --out DIR              Results directory (default arena-results/<seed>-<time>)
  --images               Write a final territory PNG per game
  --image-every M        Also write one every M game minutes
  --timeline-every S     Seconds of game time between timeline samples (30)
  --jobs J               Games in parallel (default: CPU count)
  --verbose              Keep the simulation's console output
  --quiet                Only print the summary
`;

interface Entrant {
  label: string;
  seat: SeatSpec;
}

interface Options {
  entrants: Entrant[];
  together: boolean;
  games: number;
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
  return { label: arg, seat: { agent: name, options } };
}

function parseArgs(argv: string[]): Options {
  const list = (v: string) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  const entrants: Entrant[] = [];
  let onlyMaps: string[] | null = null;
  let categories: string[] | null = null;
  let exclude: string[] = [];
  let out: string | null = null;
  const o: Omit<Options, "entrants" | "maps" | "out"> = {
    together: false,
    games: 8,
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
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
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
      case "--agent":
        entrants.push(parseEntrant(next()));
        break;
      case "--together":
        o.together = true;
        break;
      case "--games":
        o.games = int();
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
  return {
    ...o,
    entrants,
    maps: pool,
    out: path.resolve(
      out ?? path.join(ROOT, "arena-results", `${o.seed}-${stamp}`),
    ),
  };
}

/** 8 alphanumerics, derived from the run seed and game index. */
function gameIDFor(seed: string, index: number): string {
  const h = simpleHash(`${seed}:${index}`) >>> 0;
  return `G${h.toString(36).padStart(7, "0").slice(-7)}`;
}

function makeSpecs(o: Options): { spec: ArenaGameSpec; entrant: number }[] {
  const rng = new PseudoRandom(simpleHash(o.seed));
  const jobs: { spec: ArenaGameSpec; entrant: number }[] = [];
  for (let g = 0; g < o.games; g++) {
    const map = o.maps[rng.nextInt(0, o.maps.length)];
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
        }),
      );
    }
  }
  return jobs;
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

// ── Statistics ───────────────────────────────────────────────────────────

/** Wilson score interval for a binomial proportion, 95%. */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const mean = (xs: number[]) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Per-game progress toward victory: 1 for a win, otherwise the peak land
 * share as a fraction of the 80% needed to win (capped below 1).
 */
function progress(r: ArenaGameResult, seat: number): number {
  const s = r.seats[seat];
  if (s.result === "win") return 1;
  return Math.min(0.99, s.peakShare / 0.8);
}

interface EntrantSummary {
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
  crashed: number;
  agentErrors: number;
  intentsRateLimited: number;
  thinkMsP95Max: number;
}

function summarize(
  label: string,
  rows: { r: ArenaGameResult; seat: number }[],
  crashed: number,
): EntrantSummary {
  const seats = rows.map(({ r, seat }) => r.seats[seat]);
  const wins = seats.filter((s) => s.result === "win").length;
  const eliminated = seats.filter((s) => s.eliminatedAtTick !== null);
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
    meanSurvivalMinutes: mean(eliminated.map((s) => s.eliminatedAtTick! / 600)),
    crashed,
    agentErrors: seats.reduce((a, s) => a + s.stats.errors, 0),
    intentsRateLimited: seats.reduce(
      (a, s) => a + s.stats.intentsRateLimited,
      0,
    ),
    thinkMsP95Max: Math.max(0, ...seats.map((s) => s.stats.thinkMs.p95)),
  };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function summaryTable(summaries: EntrantSummary[]): string {
  const header =
    "| entrant | games | wins | win rate (95% CI) | progress | peak land | final land | placement | eliminated | agent errors | think p95 |";
  const rule = `|${header
    .split("|")
    .slice(1, -1)
    .map(() => "---")
    .join("|")}|`;
  const rows = summaries.map(
    (s) =>
      `| ${s.label} | ${s.games} | ${s.wins} | ${pct(s.winRate)} (${pct(s.winRate95[0])}–${pct(s.winRate95[1])}) | ` +
      `${s.meanProgress.toFixed(3)} | ${pct(s.meanPeakShare)} | ${pct(s.meanFinalShare)} | ` +
      `${s.meanPlacement.toFixed(1)} | ${s.eliminated} | ${s.agentErrors} | ${s.thinkMsP95Max.toFixed(1)} ms |`,
  );
  return [header, rule, ...rows].join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const jobs = makeSpecs(o);
  fs.mkdirSync(path.join(o.out, "games"), { recursive: true });
  const say = (line: string) => {
    if (!o.quiet) console.log(line);
  };
  say(
    `Arena: ${jobs.length} games, ${o.entrants.map((e) => e.label).join(" vs ")}, ` +
      `${o.difficulty} nations, ${o.bots} bots, ${o.maps.length} maps in pool, ` +
      `${o.jobs} parallel → ${path.relative(process.cwd(), o.out) || "."}`,
  );

  const results: {
    job: (typeof jobs)[number];
    res: ArenaGameResult | { crash: string };
  }[] = [];
  let nextJob = 0;
  let done = 0;
  const started = performance.now();
  const worker = async () => {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob++];
      const res = await runJob(job.spec, o);
      results.push({ job, res });
      done++;
      const tag = `[${done}/${jobs.length}]`;
      if ("crash" in res) {
        say(
          `${tag} game ${job.spec.index} ${job.spec.map}: CRASH ${res.crash.split("\n")[0]}`,
        );
        continue;
      }
      const name = `game${String(res.index).padStart(3, "0")}`;
      const { seats, ...rest } = res;
      fs.writeFileSync(
        path.join(o.out, "games", `${name}.json`),
        JSON.stringify(
          { ...rest, seats: seats.map(({ logs, ...s }) => s) },
          null,
          1,
        ),
      );
      fs.writeFileSync(
        path.join(o.out, "games", `${name}.log`),
        seats
          .map((s) => [`## ${s.agent} (${s.clientID})`, ...s.logs].join("\n"))
          .join("\n\n"),
      );
      seats.forEach((s, i) => {
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
  results.sort((a, b) => a.job.spec.index - b.job.spec.index);

  const summaries = o.together
    ? o.entrants.map((e, i) =>
        summarize(
          e.label,
          results.flatMap(({ res }) =>
            "crash" in res ? [] : [{ r: res, seat: i }],
          ),
          results.filter(({ res }) => "crash" in res).length,
        ),
      )
    : o.entrants.map((e, i) => {
        const mine = results.filter(({ job }) => job.entrant === i);
        return summarize(
          e.label,
          mine.flatMap(({ res }) =>
            "crash" in res ? [] : [{ r: res, seat: 0 }],
          ),
          mine.filter(({ res }) => "crash" in res).length,
        );
      });

  const games = results.map(({ job, res }) =>
    "crash" in res
      ? {
          index: job.spec.index,
          map: job.spec.map,
          gameID: job.spec.gameID,
          crash: res.crash,
        }
      : {
          index: res.index,
          map: res.map,
          gameID: res.gameID,
          minutes: Number(res.gameMinutes.toFixed(2)),
          winner: res.winner,
          error: res.error,
          seats: res.seats.map((s) => ({
            agent: s.agent,
            options: s.options,
            result: s.result,
            placement: s.placement,
            peakShare: s.peakShare,
            finalShare: s.finalShare,
            eliminatedAtTick: s.eliminatedAtTick,
          })),
        },
  );
  const wallSeconds = (performance.now() - started) / 1000;
  const { entrants, ...config } = o;
  fs.writeFileSync(
    path.join(o.out, "summary.json"),
    JSON.stringify(
      {
        config: { ...config, entrants: entrants.map((e) => e.label) },
        wallSeconds,
        summaries,
        games,
      },
      null,
      1,
    ),
  );
  const table = summaryTable(summaries);
  fs.writeFileSync(
    path.join(o.out, "summary.md"),
    `# Arena ${o.seed}\n\n${o.difficulty} nations, ${o.bots} bots, ${o.size} maps, ` +
      `cap ${o.maxMinutes} min, latency ${o.latency} tick(s).\n\n${table}\n`,
  );
  console.log(
    `\n${table}\n\nWall time ${wallSeconds.toFixed(0)}s. Results: ${o.out}`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
