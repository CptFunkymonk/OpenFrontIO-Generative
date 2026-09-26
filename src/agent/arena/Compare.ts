/**
 * The paired report (docs/11-roadmap.md §11.5, Comparisons): how entrant B
 * did against entrant A in the games both played, read from two results
 * directories run with the same seed. Games pair by gameID and must be on the
 * same map, so a stored champion run, merged shards and runs from different
 * commits compare without frozen copies of the champion in the registry.
 *
 *   npm run arena:compare -- arena-results/dev-champion arena-results/dev-x
 *   npm run arena:compare -- arena-results/ab arena-results/ab \
 *     --entrant-a baseline --entrant-b 1
 *
 * For B − A: wins, with an exact sign test on the discordant games; mean
 * Δprogress, Δpeak land and Δsurvival with seeded bootstrap 95% intervals
 * and the better/worse/tie split; the milestone metrics of both; breakdowns
 * by map category and by map; the games B lost most in, with the command
 * that reruns each with images; and which code each side ran, with a warning
 * when it had local changes or is not HEAD. A game that crashed, or stopped
 * early on an error, on either side is left out of the pairs and warned of.
 * Writes compare.md and compare.json into --out (default: B's directory) and
 * prints compare.md.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { maps as MAP_INFO, mapCategoryOrder } from "../../core/game/Game";
import { PseudoRandom } from "../../core/PseudoRandom";
import { isMain } from "./Cli";
import {
  CrashedGame,
  DECISIVE_PATHS,
  EntrantSummary,
  mean,
  pct,
  progress,
  provenance,
  readRun,
  Run,
  RunConfig,
  StoredGame,
  StoredSeat,
  summarize,
  summaryTable,
  TICKS_PER_MINUTE,
} from "./Summary";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");

export const BOOTSTRAP_RESAMPLES = 10_000;
/** Fixed, so the same two directories always give the same intervals. */
export const BOOTSTRAP_SEED = 20260926;
/** Games listed under "where B lost most". */
const WORST_GAMES = 5;
/** Fewer pairs than this and compare.md says the interval is not to be
 *  trusted: a percentile bootstrap runs narrow on small samples. */
const FEW_PAIRS = 20;
/** Unpaired games listed in compare.md (compare.json has all). */
const UNPAIRED_SHOWN = 20;

/** Config fields that change how a game plays; a difference is warned of. */
const PLAY_SETTINGS: readonly (keyof RunConfig)[] = [
  "together",
  "difficulty",
  "nations",
  "bots",
  "size",
  "maxMinutes",
  "latency",
  "rateLimit",
  "playOut",
  "strict",
];

// ── Statistics ───────────────────────────────────────────────────────────

/**
 * Exact two-sided sign test: the probability, with no difference between
 * the entrants, of a split of the discordant games at least as uneven as
 * `aOnly` against `bOnly` (binomial, p = 1/2). 1 when there are none.
 */
export function signTest(aOnly: number, bOnly: number): number {
  const n = aOnly + bOnly;
  const k = Math.min(aOnly, bOnly);
  // Exact in integers: 2 × Σ_{i ≤ k} C(n, i) / 2^n.
  let c = 1n;
  let tail = 0n;
  for (let i = 0; i <= k; i++) {
    tail += c;
    c = (c * BigInt(n - i)) / BigInt(i + 1);
  }
  // Scale both below 2^1024 so they convert to doubles.
  const shift = Math.max(0, n - 1000);
  const p = Number((2n * tail) >> BigInt(shift)) / 2 ** (n - shift);
  return Math.min(1, p);
}

/**
 * Percentile bootstrap 95% interval of the mean of `values`: the 2.5th and
 * 97.5th percentiles of the means of `resamples` resamples with replacement,
 * drawn from a PseudoRandom seeded with `seed`, so the interval is the same
 * on every run. Null for no values.
 */
export function bootstrapMeanCI(
  values: readonly number[],
  resamples = BOOTSTRAP_RESAMPLES,
  seed = BOOTSTRAP_SEED,
): [number, number] | null {
  const n = values.length;
  if (n === 0) return null;
  const rng = new PseudoRandom(seed);
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[rng.nextInt(0, n)];
    means[r] = sum / n;
  }
  means.sort();
  return [
    means[Math.floor(0.025 * resamples)],
    means[Math.ceil(0.975 * resamples) - 1],
  ];
}

// ── Entrants and pairing ─────────────────────────────────────────────────

/** Entrant labels of a run: its config's, or for a run that did not finish,
 *  each entrant's agent and options as its games record them. */
export function entrantLabels(run: Run): string[] {
  if (run.config !== null) return run.config.entrants;
  const labels: (string | undefined)[] = [];
  for (const g of run.games) {
    const seats: [number, StoredSeat][] =
      g.entrant === null
        ? g.seats.map((s, i) => [i, s])
        : [[g.entrant, g.seats[0]]];
    for (const [i, s] of seats) {
      labels[i] ??= s.options
        ? `${s.agent}:${JSON.stringify(s.options)}`
        : s.agent;
    }
  }
  return Array.from(labels, (l, i) => l ?? `entrant ${i}`);
}

/**
 * The entrant `choice` names, by label or index; null picks the only one.
 * `flag` is the option that chooses it, for the error message.
 */
export function selectEntrant(
  labels: readonly string[],
  choice: string | null,
  flag: string,
): number {
  const list = labels.map((l, i) => `${i}: ${l}`).join(", ");
  if (labels.length === 0) throw new Error(`${flag}: the run has no entrants`);
  if (choice === null) {
    if (labels.length === 1) return 0;
    throw new Error(
      `the run has ${labels.length} entrants (${list}): choose one with ${flag}`,
    );
  }
  const byLabel = labels.indexOf(choice);
  if (byLabel >= 0) return byLabel;
  if (/^\d+$/.test(choice) && Number(choice) < labels.length) {
    return Number(choice);
  }
  throw new Error(`${flag} ${choice}: no such entrant (${list})`);
}

/** An entrant's result in one game: which stored game, which seat of it. */
export interface SideGame {
  game: StoredGame;
  seat: number;
}

/** Entrant `entrant`'s games of `run`: its own copies, or its seat of each
 *  --together game (as summarizeEntrants counts them). */
export function sideGames(run: Run, entrant: number): SideGame[] {
  return run.games.flatMap((game) =>
    game.entrant === null
      ? entrant < game.seats.length
        ? [{ game, seat: entrant }]
        : []
      : game.entrant === entrant
        ? [{ game, seat: 0 }]
        : [],
  );
}

/** Entrant `entrant`'s crashed jobs of `run`. */
export function sideCrashes(run: Run, entrant: number): CrashedGame[] {
  return run.crashes.filter((c) => c.entrant === null || c.entrant === entrant);
}

/** A game that could not be paired, and why. */
export interface Unpaired {
  gameID: string;
  game: number;
  map: string;
  reason: string;
  /** Each side's job index for the game, null where it has none. */
  a: number | null;
  b: number | null;
}

export interface Pairing {
  pairs: { a: SideGame; b: SideGame }[];
  unpaired: Unpaired[];
  /** Game ids a side has twice; the lower job index is used. */
  duplicates: string[];
}

/**
 * Pairs A's and B's games by gameID, in game-number order. A game id both
 * have on different maps (the same seed with a different pool or draw) does
 * not pair. Neither does a game that crashed on a side (its other side's
 * game, or the crash alone if it crashed on both) or stopped early on an
 * error there: its result is cut short, and would count as a quick loss.
 */
export function pairGames(
  a: readonly SideGame[],
  b: readonly SideGame[],
  aCrashes: readonly CrashedGame[] = [],
  bCrashes: readonly CrashedGame[] = [],
): Pairing {
  const duplicates: string[] = [];
  const byID = (games: readonly SideGame[]) => {
    const m = new Map<string, SideGame>();
    for (const g of [...games].sort((x, y) => x.game.index - y.game.index)) {
      if (m.has(g.game.gameID)) duplicates.push(g.game.gameID);
      else m.set(g.game.gameID, g);
    }
    return m;
  };
  const crashIDs = (crashes: readonly CrashedGame[]) =>
    new Map(crashes.map((c) => [c.gameID, c]));
  const as = byID(a);
  const bs = byID(b);
  const aCrashed = crashIDs(aCrashes);
  const bCrashed = crashIDs(bCrashes);
  const pairs: Pairing["pairs"] = [];
  const unpaired: Unpaired[] = [];
  const failed = (g: SideGame) => (g.game.error ?? null) !== null;
  const ids = [
    ...new Set([
      ...as.keys(),
      ...bs.keys(),
      ...aCrashed.keys(),
      ...bCrashed.keys(),
    ]),
  ];
  for (const id of ids) {
    const x = as.get(id);
    const y = bs.get(id);
    const missing = (side: "A" | "B", crashed: Map<string, CrashedGame>) =>
      `${crashed.has(id) ? "crashed" : "not"} in ${side}`;
    let reason: string;
    if (x !== undefined && y !== undefined) {
      if (x.game.map !== y.game.map) {
        reason = `maps differ: ${x.game.map} in A, ${y.game.map} in B`;
      } else if (failed(x) || failed(y)) {
        reason = `errored in ${failed(x) ? (failed(y) ? "both" : "A") : "B"}`;
      } else {
        pairs.push({ a: x, b: y });
        continue;
      }
    } else if (x === undefined && y === undefined) {
      reason =
        aCrashed.has(id) && bCrashed.has(id)
          ? "crashed in both"
          : `${missing("A", aCrashed)}, ${missing("B", bCrashed)}`;
    } else {
      reason =
        x === undefined ? missing("A", aCrashed) : missing("B", bCrashed);
    }
    const g = x?.game ?? y?.game ?? aCrashed.get(id) ?? bCrashed.get(id)!;
    unpaired.push({
      gameID: id,
      game: g.game,
      map: g.map,
      reason,
      a: x?.game.index ?? aCrashed.get(id)?.index ?? null,
      b: y?.game.index ?? bCrashed.get(id)?.index ?? null,
    });
  }
  const order = (g: { game: number; gameID: string }, h: typeof g) =>
    g.game - h.game || (g.gameID < h.gameID ? -1 : g.gameID > h.gameID ? 1 : 0);
  pairs.sort((p, q) => order(p.a.game, q.a.game));
  unpaired.sort(order);
  return { pairs, unpaired, duplicates };
}

// ── The report ───────────────────────────────────────────────────────────

/** One side's result in a paired game. */
export interface Outcome {
  /** The job index: `--game` reruns it. */
  index: number;
  result: StoredSeat["result"];
  eliminatedAtTick: number | null;
  minutes: number;
  progress: number;
  peakShare: number;
  /** Game minutes until eliminated: a seat never eliminated survived the
   *  whole game, a winner the whole cap. */
  survivalMinutes: number;
}

export interface PairRow {
  game: number;
  gameID: string;
  map: string;
  categories: string[];
  a: Outcome;
  b: Outcome;
  /** B − A. */
  delta: { progress: number; peakShare: number; survivalMinutes: number };
}

/** A per-game metric for both sides and their paired difference B − A. */
export interface DeltaStats {
  meanA: number;
  meanB: number;
  meanDelta: number;
  /** Bootstrap 95% interval of the mean difference; null with no pairs. */
  ci95: [number, number] | null;
  /** Games where B's value is above, below or equal to A's. */
  better: number;
  worse: number;
  ties: number;
}

/** Paired results over a subset of games: a map category or one map. */
export interface Breakdown {
  name: string;
  games: number;
  winsA: number;
  winsB: number;
  progressA: number;
  progressB: number;
  meanDelta: number;
  better: number;
  worse: number;
  ties: number;
}

export interface SideInfo {
  dir: string;
  label: string;
  entrant: number;
  /** The entrant's games in the directory, and its crashed jobs. */
  games: number;
  crashed: number;
  seed: string | null;
  suite: string | null;
  commit: string | null;
  dirty: boolean | null;
  /** Its code changed while it played (Summary.ts codeFingerprint). */
  changedDuringRun: boolean;
}

export interface WorstGame extends PairRow {
  /** Rerun commands, with images a minute, for each side's copy. */
  rerunA: string;
  rerunB: string;
}

export interface CompareReport {
  a: SideInfo;
  b: SideInfo;
  /** The checkout the report was made in. */
  head: { commit: string | null; dirty: boolean | null };
  warnings: string[];
  paired: number;
  wins: {
    a: number;
    b: number;
    /** Discordant games: won by one side only. */
    aOnly: number;
    bOnly: number;
    signTestP: number;
  };
  progress: DeltaStats;
  peakShare: DeltaStats;
  survivalMinutes: DeltaStats;
  bootstrap: { resamples: number; seed: number };
  /** The arena summary of each side over the paired games only. */
  milestones: { a: EntrantSummary; b: EntrantSummary };
  categories: Breakdown[];
  /** B's worst first. */
  maps: Breakdown[];
  worst: WorstGame[];
  unpaired: Unpaired[];
  pairs: PairRow[];
}

export interface Side {
  run: Run;
  entrant: number;
}

function outcome(g: SideGame, capMinutes: number | null): Outcome {
  const s = g.game.seats[g.seat];
  return {
    index: g.game.index,
    result: s.result,
    eliminatedAtTick: s.eliminatedAtTick,
    minutes: g.game.gameMinutes,
    progress: progress(g.game, g.seat),
    peakShare: s.peakShare,
    survivalMinutes:
      s.eliminatedAtTick !== null
        ? s.eliminatedAtTick / TICKS_PER_MINUTE
        : s.result === "win"
          ? Math.max(capMinutes ?? 0, g.game.gameMinutes)
          : g.game.gameMinutes,
  };
}

function deltaStats(
  rows: readonly PairRow[],
  metric: keyof PairRow["delta"],
): DeltaStats {
  const deltas = rows.map((r) => r.delta[metric]);
  return {
    meanA: mean(rows.map((r) => r.a[metric])),
    meanB: mean(rows.map((r) => r.b[metric])),
    meanDelta: mean(deltas),
    ci95: bootstrapMeanCI(deltas),
    better: deltas.filter((d) => d > 0).length,
    worse: deltas.filter((d) => d < 0).length,
    ties: deltas.filter((d) => d === 0).length,
  };
}

function breakdown(name: string, rows: readonly PairRow[]): Breakdown {
  const d = rows.map((r) => r.delta.progress);
  return {
    name,
    games: rows.length,
    winsA: rows.filter((r) => r.a.result === "win").length,
    winsB: rows.filter((r) => r.b.result === "win").length,
    progressA: mean(rows.map((r) => r.a.progress)),
    progressB: mean(rows.map((r) => r.b.progress)),
    meanDelta: mean(d),
    better: d.filter((x) => x > 0).length,
    worse: d.filter((x) => x < 0).length,
    ties: d.filter((x) => x === 0).length,
  };
}

const short = (commit: string) => commit.slice(0, 7);

/** A directory as a command or the report shows it: relative to the
 *  repository root (where npm runs) when inside it. */
function shownDir(dir: string, root: string): string {
  const rel = path.relative(root, dir);
  return rel === "" ? "." : rel.startsWith("..") ? dir : rel;
}

const shellWord = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** The command that replays job `index` of the run in `dir` with images. */
export function rerunCommand(dir: string, index: number, root = ROOT): string {
  return (
    `npm run arena -- --from ${shellWord(shownDir(dir, root))} ` +
    `--game ${index} --images --image-every 1`
  );
}

/** Files that decide games changed between `commit` and HEAD, null if git
 *  cannot tell (no git, or the commit is not in this checkout). */
function changedSince(commit: string, root: string): string[] | null {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", commit, "HEAD", "--", ...DECISIVE_PATHS],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.split("\n").filter((l) => l.length > 0);
  } catch {
    return null;
  }
}

/** Loud notes on which code a side ran: local changes, not HEAD, unknown. */
function codeWarnings(
  name: "A" | "B",
  s: SideInfo,
  head: CompareReport["head"],
  root: string,
): string[] {
  const out: string[] = [];
  if (s.commit === null) {
    out.push(
      `${name} records no commit (run before the arena recorded it, or ` +
        `without git): which code played its games is unknown.`,
    );
    return out;
  }
  if (s.dirty === true) {
    out.push(
      `${name} ran on ${short(s.commit)} with local changes to src, ` +
        `resources or the package files: its games may not replay from ` +
        `that commit.` +
        (s.changedDuringRun
          ? ` They changed while it played, so its later games may have ` +
            `run other code than its earlier ones.`
          : ""),
    );
  }
  if (head.commit !== null && s.commit !== head.commit) {
    const changed = changedSince(s.commit, root);
    const core = changed?.filter((f) => f.startsWith("src/core/")).length;
    out.push(
      `${name} ran on ${short(s.commit)}, not HEAD ${short(head.commit)}` +
        (changed === null
          ? ` (that commit is not in this checkout).`
          : changed.length === 0
            ? `, but no file that decides games changed since.`
            : `: ${changed.length} file(s) under src, resources and the ` +
              `package files changed since, ${core} of them the simulation ` +
              `(src/core).`),
    );
  }
  return out;
}

/**
 * The paired report of B against A. `head` is the checkout's provenance
 * (default: this repository's), `root` where git and rerun paths start.
 */
export function compareRuns(
  a: Side,
  b: Side,
  opts: {
    head?: CompareReport["head"];
    root?: string;
  } = {},
): CompareReport {
  const root = opts.root ?? ROOT;
  const head = opts.head ?? provenance(root);
  const info = (s: Side): SideInfo => ({
    dir: s.run.dir,
    label: entrantLabels(s.run)[s.entrant] ?? `entrant ${s.entrant}`,
    entrant: s.entrant,
    games: sideGames(s.run, s.entrant).length,
    crashed: sideCrashes(s.run, s.entrant).length,
    seed: s.run.config?.seed ?? null,
    suite: s.run.suite,
    commit: s.run.commit,
    dirty: s.run.dirty,
    changedDuringRun: s.run.changedDuringRun,
  });
  const ai = info(a);
  const bi = info(b);
  const pairing = pairGames(
    sideGames(a.run, a.entrant),
    sideGames(b.run, b.entrant),
    sideCrashes(a.run, a.entrant),
    sideCrashes(b.run, b.entrant),
  );
  const capA = a.run.config?.maxMinutes ?? null;
  const capB = b.run.config?.maxMinutes ?? null;
  const rows: PairRow[] = pairing.pairs.map(({ a: x, b: y }) => {
    const oa = outcome(x, capA);
    const ob = outcome(y, capB);
    return {
      game: x.game.game,
      gameID: x.game.gameID,
      map: x.game.map,
      categories: [
        ...(MAP_INFO.find((m) => m.type === x.game.map)?.categories ?? [
          "unknown",
        ]),
      ],
      a: oa,
      b: ob,
      delta: {
        progress: ob.progress - oa.progress,
        peakShare: ob.peakShare - oa.peakShare,
        survivalMinutes: ob.survivalMinutes - oa.survivalMinutes,
      },
    };
  });

  const warnings = [
    ...codeWarnings("A", ai, head, root),
    ...codeWarnings("B", bi, head, root),
  ];
  if (a.run.config !== null && b.run.config !== null) {
    const ca = a.run.config;
    const cb = b.run.config;
    const differ = PLAY_SETTINGS.filter(
      (k) => JSON.stringify(ca[k]) !== JSON.stringify(cb[k]),
    ).map(
      (k) =>
        `${k} ${JSON.stringify(ca[k])} in A, ${JSON.stringify(cb[k])} in B`,
    );
    if (differ.length > 0) {
      warnings.push(
        `The runs were played with different settings, so paired games ` +
          `are not the same contest: ${differ.join("; ")}.`,
      );
    }
    if (ca.seed !== cb.seed) {
      warnings.push(
        `Different seeds (${ca.seed} in A, ${cb.seed} in B): games pair ` +
          `only where their game ids happen to match.`,
      );
    }
  }
  const stopped = pairing.unpaired.flatMap((u) => {
    const why = (s: Side, index: number | null, name: string) => {
      const e = s.run.games.find((g) => g.index === index)?.error ?? null;
      return e === null ? [] : [`in ${name} ${e.split("\n")[0]}`];
    };
    const sides = [...why(a, u.a, "A"), ...why(b, u.b, "B")];
    return sides.length === 0
      ? []
      : [`game ${u.game} (${u.map}) ${sides.join(", ")}`];
  });
  if (stopped.length > 0) {
    warnings.push(
      `${stopped.length} game(s) stopped early on an error and are left out ` +
        `of the pairs, where each would weigh in as a quick loss: ` +
        `${stopped.join("; ")}.`,
    );
  }
  if (pairing.duplicates.length > 0) {
    warnings.push(
      `A game id appears twice on one side (${[...new Set(pairing.duplicates)].join(", ")}): ` +
        `the lower job index is used.`,
    );
  }
  if (rows.length === 0) {
    warnings.push(
      `No paired games: were both runs played with the same seed and maps?`,
    );
  }

  const winA = (r: PairRow) => r.a.result === "win";
  const winB = (r: PairRow) => r.b.result === "win";
  const aOnly = rows.filter((r) => winA(r) && !winB(r)).length;
  const bOnly = rows.filter((r) => winB(r) && !winA(r)).length;

  const categoryOrder = (c: string) => {
    const i = (mapCategoryOrder as readonly string[]).indexOf(c);
    return i < 0 ? mapCategoryOrder.length : i;
  };
  const categories = [...new Set(rows.flatMap((r) => r.categories))]
    .sort((x, y) => categoryOrder(x) - categoryOrder(y))
    .map((c) =>
      breakdown(
        c,
        rows.filter((r) => r.categories.includes(c)),
      ),
    );
  const maps = [...new Set(rows.map((r) => r.map))]
    .map((m) =>
      breakdown(
        m,
        rows.filter((r) => r.map === m),
      ),
    )
    .sort(
      (x, y) =>
        x.meanDelta - y.meanDelta ||
        (x.name < y.name ? -1 : x.name > y.name ? 1 : 0),
    );
  const worst = rows
    .filter((r) => r.delta.progress < 0)
    .sort(
      (x, y) =>
        x.delta.progress - y.delta.progress ||
        x.delta.peakShare - y.delta.peakShare ||
        x.game - y.game,
    )
    .slice(0, WORST_GAMES)
    .map((r) => ({
      ...r,
      rerunA: rerunCommand(a.run.dir, r.a.index, root),
      rerunB: rerunCommand(b.run.dir, r.b.index, root),
    }));
  const seatsOf = (side: "a" | "b") =>
    pairing.pairs.map((p) => ({ r: p[side].game, seat: p[side].seat }));

  return {
    a: ai,
    b: bi,
    head,
    warnings,
    paired: rows.length,
    wins: {
      a: rows.filter(winA).length,
      b: rows.filter(winB).length,
      aOnly,
      bOnly,
      signTestP: signTest(aOnly, bOnly),
    },
    progress: deltaStats(rows, "progress"),
    peakShare: deltaStats(rows, "peakShare"),
    survivalMinutes: deltaStats(rows, "survivalMinutes"),
    bootstrap: { resamples: BOOTSTRAP_RESAMPLES, seed: BOOTSTRAP_SEED },
    milestones: {
      a: summarize(`A: ${ai.label}`, seatsOf("a"), 0),
      b: summarize(`B: ${bi.label}`, seatsOf("b"), 0),
    },
    categories,
    maps,
    worst,
    unpaired: pairing.unpaired,
    pairs: rows,
  };
}

// ── Markdown ─────────────────────────────────────────────────────────────

/** "+0.012", "-0.004": a signed number rounded to `digits`. */
function signed(v: number, digits: number): string {
  const r = Number(v.toFixed(digits));
  return `${r < 0 ? "-" : "+"}${Math.abs(r).toFixed(digits)}`;
}

const pValue = (p: number) =>
  p === 1 ? "1" : p < 0.0001 ? "< 0.0001" : p.toFixed(4);

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(header),
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map(line),
  ].join("\n");
}

function outcomeText(o: Outcome): string {
  const at = (ticks: number) => (ticks / TICKS_PER_MINUTE).toFixed(1);
  const how =
    o.result === "win"
      ? `won at ${o.minutes.toFixed(1)} min`
      : o.eliminatedAtTick !== null
        ? `out at ${at(o.eliminatedAtTick)} min`
        : o.result === "timeout"
          ? `alive at ${o.minutes.toFixed(1)} min`
          : `${o.result} at ${o.minutes.toFixed(1)} min`;
  return `${how}, peak ${pct(o.peakShare)}`;
}

/** Why a rerun on this checkout may not replay a side's game exactly. */
function replayNote(s: SideInfo, head: CompareReport["head"]): string {
  if (s.commit === null) return " (its commit is unknown)";
  if (head.commit !== null && s.commit !== head.commit) {
    return ` (check out ${short(s.commit)} first: HEAD is not the code that played it)`;
  }
  return s.dirty ? " (it ran with local changes)" : "";
}

/** What the interval says about B against A. */
function verdict(ci: [number, number] | null): string {
  if (ci === null) return "no paired games";
  if (ci[0] > 0) return "B better (the interval excludes 0)";
  if (ci[1] < 0) return "B worse (the interval excludes 0)";
  return "no difference shown (the interval includes 0)";
}

export function compareMarkdown(r: CompareReport, root = ROOT): string {
  const side = (name: string, s: SideInfo) =>
    `- **${name}**: ${s.label} in ${shownDir(s.dir, root)} ` +
    `(${s.games} game(s)${s.crashed > 0 ? `, ${s.crashed} crashed` : ""}; ` +
    `seed ${s.seed ?? "?"}${s.suite === null ? "" : `, suite ${s.suite}`}; ` +
    `${s.commit === null ? "commit unknown" : `${short(s.commit)}${s.dirty ? " with local changes" : ""}`})`;
  const ci = (d: DeltaStats, f: (v: number) => string) =>
    d.ci95 === null ? "–" : `[${f(d.ci95[0])}, ${f(d.ci95[1])}]`;
  const metric = (
    name: string,
    d: DeltaStats,
    each: (v: number) => string,
    diff: (v: number) => string,
  ) => [
    name,
    each(d.meanA),
    each(d.meanB),
    diff(d.meanDelta),
    ci(d, diff),
    `${d.better} / ${d.worse} / ${d.ties}`,
  ];
  const prog = (v: number) => v.toFixed(3);
  const dProg = (v: number) => signed(v, 3);
  const pp = (v: number) => `${signed(v * 100, 1)} pp`;
  const min = (v: number) => `${v.toFixed(1)} min`;
  const dMin = (v: number) => `${signed(v, 1)} min`;
  const breakdownRows = (bs: Breakdown[]) =>
    bs.map((x) => [
      x.name,
      String(x.games),
      String(x.winsA),
      String(x.winsB),
      prog(x.progressA),
      prog(x.progressB),
      dProg(x.meanDelta),
      `${x.better} / ${x.worse} / ${x.ties}`,
    ]);
  const breakdownHeader = [
    "",
    "games",
    "wins A",
    "wins B",
    "progress A",
    "progress B",
    "Δ",
    "B better / worse / tie",
  ];

  const out: string[] = [
    `# ${r.b.label} (B) against ${r.a.label} (A)`,
    "",
    side("A", r.a),
    side("B", r.b),
    `- HEAD: ${r.head.commit === null ? "unknown" : `${short(r.head.commit)}${r.head.dirty ? " with local changes" : ""}`}`,
    "",
  ];
  if (r.warnings.length > 0) {
    out.push(r.warnings.map((w) => `> **WARNING:** ${w}`).join("\n>\n"), "");
  }
  out.push(
    `**${r.paired} paired game${r.paired === 1 ? "" : "s"}** (A has ${r.a.games}, B ${r.b.games}; ` +
      `${r.unpaired.length} unpaired). ` +
      `Δprogress (B − A) ${dProg(r.progress.meanDelta)}, 95% CI ${ci(r.progress, dProg)}: ` +
      `${verdict(r.progress.ci95)}.` +
      (r.paired > 0 && r.paired < FEW_PAIRS
        ? ` Only ${r.paired} pair${r.paired === 1 ? "" : "s"}: too few to trust a bootstrap interval.`
        : ""),
    "",
    `Wins: A ${r.wins.a}, B ${r.wins.b}. Discordant: A only ${r.wins.aOnly}, ` +
      `B only ${r.wins.bOnly}; sign test p = ${pValue(r.wins.signTestP)}.`,
    "",
    table(
      ["", "A", "B", "B − A", "95% CI", "B better / worse / tie"],
      [
        metric("progress", r.progress, prog, dProg),
        metric("peak land", r.peakShare, pct, pp),
        metric("survival", r.survivalMinutes, min, dMin),
      ],
    ),
    "",
    `Intervals: percentile bootstrap of the mean paired difference, ` +
      `${r.bootstrap.resamples} resamples, seed ${r.bootstrap.seed}. Progress is ` +
      `1 for a win, else peak land ÷ 0.8; survival counts a seat never ` +
      `eliminated as surviving the game, a winner the cap.`,
    "",
    `## Milestones (paired games)`,
    "",
    summaryTable([r.milestones.a, r.milestones.b]),
    "",
    `## By map category`,
    "",
    `A map counts in each of its categories.`,
    "",
    table(breakdownHeader, breakdownRows(r.categories)),
    "",
    `## By map, B's worst first`,
    "",
    table(breakdownHeader, breakdownRows(r.maps)),
    "",
    `## Where B lost most`,
    "",
  );
  if (r.worst.length === 0) {
    out.push(`B lost progress in no paired game.`, "");
  } else {
    for (const [i, w] of r.worst.entries()) {
      out.push(
        `${i + 1}. **${w.map}** ${w.gameID} (game ${w.game}): ` +
          `Δprogress ${dProg(w.delta.progress)}. A ${outcomeText(w.a)}; B ${outcomeText(w.b)}.`,
        `   - B: \`${w.rerunB}\`${replayNote(r.b, r.head)}`,
        `   - A: \`${w.rerunA}\`${replayNote(r.a, r.head)}`,
      );
    }
    out.push("");
  }
  out.push(`## Unpaired games`, "");
  if (r.unpaired.length === 0) {
    out.push(`None: every game of both sides paired.`, "");
  } else {
    out.push(
      table(
        ["game", "map", "game id", "why"],
        r.unpaired
          .slice(0, UNPAIRED_SHOWN)
          .map((u) => [String(u.game), u.map, u.gameID, u.reason]),
      ),
      "",
    );
    if (r.unpaired.length > UNPAIRED_SHOWN) {
      out.push(
        `… and ${r.unpaired.length - UNPAIRED_SHOWN} more (compare.json lists all).`,
        "",
      );
    }
  }
  return out.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

const HELP = `Usage: npm run arena:compare -- A_DIR B_DIR [options]

The paired report of entrant B against entrant A, from two arena results
directories run with the same seed (merged shards included). The same
directory can be given twice to compare two of its entrants.

  --entrant-a E   A's entrant, by label or index (needed if A_DIR has several)
  --entrant-b E   B's entrant, likewise
  --out DIR       Where to write compare.md and compare.json (default: B_DIR)
`;

function main(): void {
  const argv = process.argv.slice(2);
  const dirs: string[] = [];
  let entrantA: string | null = null;
  let entrantB: string | null = null;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      return;
    } else if (arg === "--entrant-a") {
      entrantA = next();
    } else if (arg === "--entrant-b") {
      entrantB = next();
    } else if (arg === "--out") {
      out = path.resolve(next());
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown argument "${arg}" (see --help)`);
    } else {
      dirs.push(path.resolve(arg));
    }
  }
  if (dirs.length !== 2) {
    throw new Error(`need two results directories, A and B\n\n${HELP}`);
  }
  const [runA, runB] = dirs.map(readRun);
  const a = {
    run: runA,
    entrant: selectEntrant(entrantLabels(runA), entrantA, "--entrant-a"),
  };
  const b = {
    run: runB,
    entrant: selectEntrant(entrantLabels(runB), entrantB, "--entrant-b"),
  };
  const report = compareRuns(a, b);
  const md = compareMarkdown(report);
  const dir = out ?? runB.dir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "compare.md"), md);
  fs.writeFileSync(
    path.join(dir, "compare.json"),
    JSON.stringify(report, null, 1),
  );
  console.log(md);
  console.log(`Wrote ${path.join(dir, "compare.md")} and compare.json`);
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
