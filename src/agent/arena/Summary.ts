/**
 * Arena statistics and results directories: the per-entrant summary the
 * arena prints and writes to summary.json, the milestone metrics of
 * docs/11-roadmap.md §11.6, the troop-flow, strike, bomb, gold and search
 * metrics of the M4 plan (§2.10), and readRun, which loads a results
 * directory back for the report tools, runs recorded before a field existed
 * included.
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
import {
  PlayerType,
  type Difficulty,
  type GameMapSize,
  type GameMapType,
} from "../../core/game/Game";
import type {
  ArenaGameResult,
  AttackRecord,
  Received,
  SeatResult,
  StandingPoint,
  TimelinePoint,
} from "./ArenaGame";

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

/** The q-quantile, interpolating between the order statistics (so the
 *  0.5-quantile is the median); null for none. */
export function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = Math.min(1, Math.max(0, q)) * (s.length - 1);
  const lo = Math.floor(at);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (at - lo);
}

/** The fields of a StandingPoint the milestone metrics read. */
export type StandingSample = Pick<
  StandingPoint,
  "minute" | "share" | "rank" | "medianNationShare" | "topNation"
>;

/** The fields of a TimelinePoint the flow and gold metrics read. */
export type TimelineSample = Pick<
  TimelinePoint,
  "tick" | "tiles" | "share" | "troops" | "maxTroops" | "gold" | "alive"
>;

/** The fields of an AttackRecord the strike metrics read. */
export type StrikeSample = Pick<
  AttackRecord,
  "startTick" | "target" | "boat" | "troopsLost" | "tilesGained"
>;

/** The fields of Received the pile-on and bomb metrics read. */
export type ReceivedSample = Pick<Received, "attacks" | "nukes"> &
  Partial<
    Pick<
      Received,
      | "launches"
      | "launchesDropped"
      | "landings"
      | "landingsDropped"
      | "nukeLog"
    >
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
  // Read by the flow, strike, bomb and gold metrics. Every result has a
  // timeline; the attack log and received were added in M1.
  timeline?: readonly TimelineSample[];
  attacks?: readonly StrikeSample[];
  received?: ReceivedSample;
  /** Read by the search metrics: a SeatResult's log in memory, or what
   *  storedGame and readRun read out of it (seatLogStats). */
  logs?: readonly string[];
  logStats?: SeatLogStats;
};

/** A timeline's top three contenders, as LeaderPoint records them. */
export interface LeaderSample {
  tick: number;
  leaders: readonly { type: string; share: number }[];
}

/** What the summary reads of a game: an ArenaGameResult and a StoredGame fit. */
export interface SummaryGame {
  ticks: number;
  gameMinutes: number;
  seats: readonly SummarySeat[];
  /** Why the game stopped early: an agent exception under --strict, a
   *  replica divergence under --isolate, a simulation error. Null or missing
   *  (older files) if it ran to its end. */
  error?: string | null;
  // Read by the nation and search metrics; hand-made results may lack them.
  wallMs?: number;
  /** type is a PlayerType or "team". */
  winner?: { type: string } | null;
  leaders?: readonly LeaderSample[];
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

/**
 * A player won the game, so nothing followed its last tick: its winner, or
 * (hand-made results without one) a seat that won, or lost without being
 * eliminated, which only another's win does.
 */
export function gameWon(r: SummaryGame): boolean {
  if ((r.winner ?? null) !== null) return true;
  return r.seats.some(
    (s) =>
      s.result === "win" ||
      (s.result === "loss" && s.eliminatedAtTick === null),
  );
}

/**
 * The game stopped before its end, so what the others did afterwards is
 * unknown: on an error, or, without --play-out, when every seat was out
 * before anyone won (the arena stops there). A game that ran to its cap or
 * to a win is not.
 */
export function cutShort(r: SummaryGame): boolean {
  if ((r.error ?? null) !== null) return true;
  if (gameWon(r)) return false;
  let last = -1;
  for (const s of r.seats) {
    if (s.eliminatedAtTick === null) return false;
    last = Math.max(last, s.eliminatedAtTick);
  }
  return r.seats.length > 0 && r.ticks <= last;
}

/**
 * A seat's land share at a game minute, as the M4 plan reports it: its
 * standing then (or the timeline sample at that tick); for a game that
 * ended before the minute, the final share, or 0 if the seat was eliminated
 * by then. Null when the game was cut short before it (a cap, an error) and
 * for a minute nothing recorded.
 */
export function shareAt(
  r: SummaryGame,
  seat: number,
  minute: number,
): number | null {
  const s = r.seats[seat];
  const tick = minute * TICKS_PER_MINUTE;
  if (s.eliminatedAtTick !== null && s.eliminatedAtTick <= tick) return 0;
  const point = s.standings?.find((p) => p.minute === minute);
  if (point !== undefined) return point.share;
  const sample = s.timeline?.find((p) => p.tick === tick);
  if (sample !== undefined) return sample.share;
  return s.result === "win" || s.result === "loss" ? s.finalShare : null;
}

/**
 * Out before `minute`: eliminated before it. False for a seat that won,
 * lived to the minute, or lost otherwise (another player won); null when
 * the game was cut short before it (a cap, an error) with the seat alive.
 */
export function outBefore(
  r: SummaryGame,
  seat: number,
  minute: number,
): boolean | null {
  const s = r.seats[seat];
  const tick = minute * TICKS_PER_MINUTE;
  if (s.eliminatedAtTick !== null) return s.eliminatedAtTick < tick;
  const over = s.result === "win" || s.result === "loss";
  return over || r.ticks >= tick ? false : null;
}

/**
 * Lost before `minute`, any cause: eliminated before it, or another player
 * won before it (a nation's win counts as a loss). False for a seat that
 * won or lived to the minute; null when the game was cut short before it.
 */
export function lostBefore(
  r: SummaryGame,
  seat: number,
  minute: number,
): boolean | null {
  const s = r.seats[seat];
  const tick = minute * TICKS_PER_MINUTE;
  // A loss without an elimination came when the game ended: someone won.
  const lostAt = s.eliminatedAtTick ?? (s.result === "loss" ? r.ticks : null);
  if (lostAt !== null) return lostAt < tick;
  return s.result === "win" || r.ticks >= tick ? false : null;
}

/** Top 3 by land at `minute` (known as for the M3 rate; see standingAt). */
export function top3At(
  r: SummaryGame,
  seat: number,
  minute: number,
): boolean | null {
  const p = standingAt(r, seat, minute);
  return p === null ? null : typeof p === "string" ? p === "won" : p.rank <= 3;
}

// ── Troop flow, strikes, bombs and gold ──────────────────────────────────

/** The flow metrics' window, in game minutes: [5, 15). */
export const FLOW_MINUTES: readonly [number, number] = [5, 15];
/** Home troops at or above this share of the cap are idle. */
export const IDLE_SHARE = 0.95;
/** A nation attack on us this many ticks after a strike's launch, or
 *  sooner, piles on. */
export const PILE_ON_TICKS = 300;
/** The all-in price needs more net tiles than this over the window (the M4
 *  plan's srate.py): a seat that barely grew has a ratio of noise, one that
 *  gained 21 tiles "paid" 12,133 a tile. flowmetrics.py priced every gain
 *  (seatFlow's minTiles 0 reproduces it). */
export const PRICE_MIN_TILES = 1000;
/** Minutes at which the gold held is reported. */
export const GOLD_MINUTES = [10, 15, 20] as const;

/**
 * Regrowth per tick of home troops `troops` under the cap `cap`:
 * `troopIncreaseRate` for a Human, which every seat is (docs/13-mechanics.md
 * §5.5): (10 + T^0.73 / 4) × (1 − T / M), and 0 at or above the cap.
 */
export function regrowth(troops: number, cap: number): number {
  if (cap <= 0 || troops >= cap) return 0;
  return (10 + Math.max(0, troops) ** 0.73 / 4) * (1 - troops / cap);
}

/** The most regrowth the cap allows: at the best home, near 0.42 × cap
 *  (regrowth is concave in T; a golden-section search finds it). */
export function peakRegrowth(cap: number): number {
  if (cap <= 0) return 0;
  const g = (Math.sqrt(5) - 1) / 2;
  let lo = 0;
  let hi = cap;
  let x1 = hi - g * (hi - lo);
  let x2 = lo + g * (hi - lo);
  let f1 = regrowth(x1, cap);
  let f2 = regrowth(x2, cap);
  for (let i = 0; i < 64; i++) {
    if (f1 < f2) {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + g * (hi - lo);
      f2 = regrowth(x2, cap);
    } else {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - g * (hi - lo);
      f1 = regrowth(x1, cap);
    }
  }
  return Math.max(f1, f2);
}

/** One seat's troop flow over a window, its strikes and what followed. */
export interface SeatFlow {
  /** Σ regrowth ÷ Σ peak regrowth at the timeline's regular samples in
   *  the window with the seat alive: how much of its possible regrowth it
   *  had. Null without such a sample. */
  utilization: number | null;
  /** The share of those samples with home ≥ IDLE_SHARE of the cap. */
  idleShare: number | null;
  /** What home paid per net tile over the window, attacks on us included:
   *  allInCost ÷ allInTiles, (∫ regrowth − Δhome) ÷ Δtiles from its start to
   *  its end or the game's (a win, or another's), whichever came first, the
   *  integral a left sum over the samples between. Null unless the seat was
   *  alive at the start, not eliminated by the end, and gained more than
   *  seatFlow's minTiles (PRICE_MIN_TILES) net tiles; the two parts are null
   *  with it. */
  allInPrice: number | null;
  allInCost: number | null;
  allInTiles: number | null;
  /** Land attacks on nations launched all game (boats are not strikes),
   *  and the troops lost and tiles gained by those that ended, and how many
   *  ended. */
  strikes: number;
  strikesEnded: number;
  strikeTroopsLost: number;
  strikeTilesGained: number;
  /** Nation attacks on our land (nationAttackTicks) that began within
   *  PILE_ON_TICKS after a strike's launch, counted once for each strike
   *  they follow. Null when it is not known when nations attacked. */
  pileOns: number | null;
}

/**
 * Ticks of the nation attacks on our land, or null if unknown: each land
 * attack when it began, each boat's when it landed (a ship that never did
 * attacked no land), as flowmetrics.py reads them from apex's `def why`
 * lines. From the recorder's launches and landings; for a run recorded
 * before landings, from the `def why` lines if the log times them
 * (SeatLogStats.defWhy) and was not cut, else the launches if no nation
 * came by boat (land attacks are all there is); none if the recorder
 * counted no nation attack at all. A list the recorder cut at
 * MAX_ATTACK_RECORDS is not known.
 */
export function nationAttackTicks(s: SummarySeat): number[] | null {
  const r = s.received;
  const nation = (l: { by: { type: string } }) =>
    l.by.type === PlayerType.Nation;
  const cut = (r?.launchesDropped ?? 0) > 0 || (r?.landingsDropped ?? 0) > 0;
  const land = r?.launches?.filter((l) => nation(l) && !l.boat);
  if (land !== undefined && r?.landings !== undefined) {
    if (cut) return null;
    return [...land, ...r.landings.filter(nation)]
      .map((l) => l.tick)
      .sort((a, b) => a - b);
  }
  const log = logStatsOf(s);
  if (log !== undefined && log.defWhy !== null && !log.truncated) {
    return log.defWhy;
  }
  if (land !== undefined && !cut) {
    if (!r!.launches!.some((l) => nation(l) && l.boat)) {
      return land.map((l) => l.tick);
    }
  }
  return r?.attacks.nation === 0 ? [] : null;
}

/** The timeline's regular samples, one every --timeline-every: all but the
 *  extra one the arena takes where a game ends between two (the first
 *  sample is at the interval, as ticks count from 1). */
function regularSamples(
  timeline: readonly TimelineSample[],
): readonly TimelineSample[] {
  if (timeline.length < 2 || timeline[0].tick <= 0) return timeline;
  const every = timeline[0].tick;
  return timeline.filter((p) => p.tick % every === 0);
}

export function seatFlow(
  r: SummaryGame,
  seat: number,
  minutes: readonly [number, number] = FLOW_MINUTES,
  minTiles = PRICE_MIN_TILES,
): SeatFlow {
  const s = r.seats[seat];
  const t0 = minutes[0] * TICKS_PER_MINUTE;
  const t1 = minutes[1] * TICKS_PER_MINUTE;
  const timeline = regularSamples(s.timeline ?? []);
  let grown = 0;
  let possible = 0;
  let samples = 0;
  let idle = 0;
  for (const p of timeline) {
    if (p.tick < t0 || p.tick >= t1 || !p.alive) continue;
    grown += regrowth(p.troops, p.maxTroops);
    possible += peakRegrowth(p.maxTroops);
    samples++;
    if (p.troops >= IDLE_SHARE * p.maxTroops) idle++;
  }
  // The price runs to the window's end or the game's, whichever is first,
  // over every sample, the game's last one included.
  const played = (s.timeline ?? []).filter(
    (p) => p.tick >= t0 && p.tick <= t1 && p.alive,
  );
  const first = played[0];
  const last = played[played.length - 1];
  const out = s.eliminatedAtTick !== null && s.eliminatedAtTick <= t1;
  let allInCost: number | null = null;
  let allInTiles: number | null = null;
  if (
    first?.tick === t0 &&
    !out &&
    last.tiles - first.tiles > Math.max(0, minTiles)
  ) {
    let integral = 0;
    for (let i = 0; i + 1 < played.length; i++) {
      const p = played[i];
      integral +=
        regrowth(p.troops, p.maxTroops) * (played[i + 1].tick - p.tick);
    }
    allInCost = integral - (last.troops - first.troops);
    allInTiles = last.tiles - first.tiles;
  }
  const strikes = (s.attacks ?? []).filter(
    (a) => a.target.type === PlayerType.Nation && !a.boat,
  );
  const ended = strikes.filter((a) => a.troopsLost !== null);
  const attacks = nationAttackTicks(s);
  return {
    utilization: possible > 0 ? grown / possible : null,
    idleShare: samples > 0 ? idle / samples : null,
    allInPrice:
      allInCost === null || allInTiles === null ? null : allInCost / allInTiles,
    allInCost,
    allInTiles,
    strikes: strikes.length,
    strikesEnded: ended.length,
    strikeTroopsLost: ended.reduce((a, x) => a + x.troopsLost!, 0),
    strikeTilesGained: ended.reduce((a, x) => a + x.tilesGained, 0),
    pileOns:
      attacks === null
        ? null
        : strikes.reduce(
            (n, a) =>
              n +
              attacks.filter(
                (t) => t >= a.startTick && t <= a.startTick + PILE_ON_TICKS,
              ).length,
            0,
          ),
  };
}

/** A seat's timeline sample at a game minute, with the seat alive; null
 *  otherwise (out or over by then, or not sampled). */
export function sampleAt(
  r: SummaryGame,
  seat: number,
  minute: number,
): TimelineSample | null {
  const tick = minute * TICKS_PER_MINUTE;
  const p = r.seats[seat].timeline?.find((x) => x.tick === tick);
  return p?.alive ? p : null;
}

/** The gold a seat held at a game minute (sampleAt). */
export function goldAt(
  r: SummaryGame,
  seat: number,
  minute: number,
): number | null {
  return sampleAt(r, seat, minute)?.gold ?? null;
}

/**
 * The first game minute a nation held `share` of the land, by the
 * timeline's leaders (so to the timeline's resolution), or the minute a
 * nation won if that came first: the win is at 80%. Null if no nation did,
 * or the game records no leaders.
 */
export function nationReached(r: SummaryGame, share: number): number | null {
  let tick: number | null = null;
  for (const p of r.leaders ?? []) {
    if (
      p.leaders.some((l) => l.type === PlayerType.Nation && l.share >= share)
    ) {
      tick = p.tick;
      break;
    }
  }
  if (r.winner?.type === PlayerType.Nation && share <= 0.8) {
    tick = Math.min(tick ?? r.ticks, r.ticks);
  }
  return tick === null ? null : tick / TICKS_PER_MINUTE;
}

/**
 * A nation held `share` of the land before `minute` (nationReached), in the
 * game (every seat sees the same): false if no nation did by then in a game
 * that reached the minute or that a player won earlier; null if it stopped
 * before the minute otherwise (a cap, an error, or every seat out: without
 * --play-out the arena stops there, and what the nations did next is
 * unknown), or records no leaders.
 */
export function nationBefore(
  r: SummaryGame,
  share: number,
  minute: number,
): boolean | null {
  if (r.leaders === undefined && r.winner === undefined) return null;
  const at = nationReached(r, share);
  if (at !== null && at < minute) return true;
  return gameWon(r) || r.ticks >= minute * TICKS_PER_MINUTE ? false : null;
}

// ── Search, from the agent's log ─────────────────────────────────────────

/** Lines AgentHost keeps of a seat's log (its MAX_LOG_LINES): a log this
 *  long may have lost later lines, so the counts read from it are short. */
export const LOG_LINES_KEPT = 2000;

/**
 * Searches, as the agent logged them. The SearchController logs one line a
 * search, `search <t> <trigger> cands=<n> chosen=<plan> gain=<ΔV> base=<V>
 * h=<h> te=<tick-equivalents> ms=<ms>` (a refused one without `chosen=`, a
 * log-only one with `mode=plans`), `search-none <t> <trigger>` for a
 * trigger with no candidate, and `search-check <t0> +<h> ok|MISMATCH` for
 * each checkpoint of a chosen rollout against the live game.
 */
export interface SearchLogStats {
  /** What logged them: the SearchController's `search <t> <trigger> ...`
   *  lines (plan.md §2.10), or the act3 prototype's `PROBE {json}`. */
  format: "search" | "probe";
  /** Searches run, by the trigger that fired each (the prototype logs its
   *  mode instead). */
  searches: number;
  byTrigger: Record<string, number>;
  /** Searches the budget refused: `search` lines without a chosen plan. */
  skipped: number;
  /** Triggers that found no candidate, so forked nothing: the
   *  SearchController's `search-none <t> <trigger>` lines. */
  none: number;
  /** Searches that chose a plan other than the base, by the plan's kind
   *  (its name up to the first ":"). */
  acts: number;
  actsByKind: Record<string, number>;
  /** The predicted gains (ΔV over the base) of the acts, added up. */
  gain: number;
  /** What the searches cost: wall milliseconds, and tick-equivalents (null
   *  for the prototype, which logs none). */
  ms: number;
  te: number | null;
  /** Checkpoints of the chosen rollouts against the live game, and those
   *  that did not match. */
  checks: number;
  mismatches: number;
}

/** What the summary reads out of a seat's log. */
export interface SeatLogStats {
  lines: number;
  /** The log reached LOG_LINES_KEPT: lines after it were not kept. */
  truncated: boolean;
  /** Ticks of apex's `def why` lines, one for each nation attack on it
   *  (a land attack, or a boat's when it lands): the pile-on fallback for
   *  runs recorded before Received.landings. Null unless the log has a
   *  `def why` or a `def boat` line (every apex since 829bfcb logs a ship
   *  at sea bound for it, and each attack that lands): an agent that does
   *  not log them, apex before it did (its `def in` lines alone), or a seat
   *  no nation came at. Empty: apex saw nations' ships, none landed. */
  defWhy: number[] | null;
  /** Null if the seat logged no search. */
  search: SearchLogStats | null;
}

const LOG_LINE = /^\[(\d+)\] (?:\d+ )?(.*)$/;

/** Reads a seat's log lines (as AgentHost writes them, `[tick] message`). */
export function seatLogStats(lines: readonly string[]): SeatLogStats {
  const defWhy: number[] = [];
  // apex logs a `def why` for each nation attack on its land since 92ebf90,
  // and a `def boat` for each nation ship at sea bound for it since
  // 829bfcb: either line shows the log would hold every nation attack.
  let times = false;
  let search: SearchLogStats | null = null;
  const searches = (format: SearchLogStats["format"]): SearchLogStats => {
    search ??= {
      format,
      searches: 0,
      byTrigger: {},
      skipped: 0,
      none: 0,
      acts: 0,
      actsByKind: {},
      gain: 0,
      ms: 0,
      te: null,
      checks: 0,
      mismatches: 0,
    };
    if (format === "search") search.format = "search";
    return search;
  };
  const num = (v: unknown) => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  };
  const act = (s: SearchLogStats, chosen: string, gain: unknown) => {
    s.acts++;
    const kind = chosen.split(":")[0];
    s.actsByKind[kind] = (s.actsByKind[kind] ?? 0) + 1;
    s.gain += num(gain);
  };
  for (const line of lines) {
    const m = LOG_LINE.exec(line);
    if (m === null) continue;
    const msg = m[2];
    if (msg.startsWith("def why ")) {
      times = true;
      defWhy.push(Number(m[1]));
    } else if (msg.startsWith("def boat ")) {
      times = true;
    } else if (msg.startsWith("search ")) {
      // search <t> <trigger> cands=<n> chosen=<plan> gain=<ΔV> base=<V>
      //   h=<h> te=<tick-equivalents> ms=<ms>
      const words = msg.split(" ").slice(2);
      const kv: Record<string, string> = {};
      for (const w of words) {
        const eq = w.indexOf("=");
        if (eq > 0) kv[w.slice(0, eq)] = w.slice(eq + 1);
      }
      const s = searches("search");
      const trigger = words.find((w) => !w.includes("=")) ?? "?";
      if (kv.chosen === undefined) {
        s.skipped++;
        continue;
      }
      s.searches++;
      s.byTrigger[trigger] = (s.byTrigger[trigger] ?? 0) + 1;
      // Log-only searches (searchMode "plans") choose but never act.
      if (kv.chosen !== "base" && kv.mode !== "plans") {
        act(s, kv.chosen, kv.gain);
      }
      s.ms += num(kv.ms);
      if (kv.te !== undefined) s.te = (s.te ?? 0) + num(kv.te);
    } else if (msg.startsWith("search-check ")) {
      // search-check <t0> +<h> ok|MISMATCH
      const s = searches("search");
      s.checks++;
      if (/\bMISMATCH\b/.test(msg)) s.mismatches++;
    } else if (msg.startsWith("search-none ")) {
      // search-none <t> <trigger>
      searches("search").none++;
    } else if (msg.startsWith("PROBE {")) {
      const p = parseJson(msg.slice(6));
      if (p === null || typeof p.chosen !== "string") continue;
      const s = searches("probe");
      s.searches++;
      const mode = typeof p.mode === "string" ? p.mode : "?";
      s.byTrigger[mode] = (s.byTrigger[mode] ?? 0) + 1;
      // "plans" rolls out and logs, never acts.
      if (p.chosen !== "base" && mode !== "plans") act(s, p.chosen, p.gain);
      s.ms += num(p.totalMs);
    } else if (msg.startsWith("PROBE_CHECK {")) {
      const c = parseJson(msg.slice(12));
      if (c === null) continue;
      const s = searches("probe");
      s.checks++;
      if (!sameSnap(c.pred, c.live)) s.mismatches++;
    }
  }
  return {
    lines: lines.length,
    truncated: lines.length >= LOG_LINES_KEPT,
    defWhy: times ? defWhy : null,
    search,
  };
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The prototype's checkpoint: predicted and live tiles, home, outgoing. */
function sameSnap(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].every((k) => x[k] === y[k]);
}

/** A seat's log stats: as stored, else read from its log in memory. */
export function logStatsOf(s: SummarySeat): SeatLogStats | undefined {
  return (
    s.logStats ?? (s.logs === undefined ? undefined : seatLogStats(s.logs))
  );
}

/** A game log (games/gameNNN.log) split into each seat's lines, by the
 *  `## agent (clientID)` line the arena writes before them. */
export function splitGameLog(text: string): Map<string, string[]> {
  const seats = new Map<string, string[]>();
  let lines: string[] | null = null;
  for (const line of text.split("\n")) {
    const head = /^## .* \(([^()\s]+)\)$/.exec(line);
    if (head !== null) {
      lines = [];
      seats.set(head[1], lines);
    } else if (lines !== null && line.length > 0) {
      lines.push(line);
    }
  }
  return seats;
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
  /** M3: rank ≤ 3 among nations and humans by land at minute 10. */
  top3At10: number | null;
  top3At10Games: number;
  /** M5: median game minutes of the games won; null if none was. */
  medianWinMinutes: number | null;
  // The M4 plan's metrics (plan.md §2.10). Runs recorded before a field
  // existed count as unknown, as above.
  /** Lost before minute 20, any cause: eliminated, or another player won
   *  (a nation's win counts). Known as eliminatedBefore20 is. */
  lostBefore20: number | null;
  lostBefore20Games: number;
  /** Troop flow over FLOW_MINUTES (seatFlow): the mean per-game regrowth
   *  utilization and idle share, over the games alive in the window. */
  utilization: number | null;
  idleShare: number | null;
  flowGames: number;
  /** The median per-game all-in price over the window, troops per net
   *  tile, over the games that gained more than PRICE_MIN_TILES net tiles
   *  in it (SeatFlow.allInPrice). */
  allInPrice: number | null;
  allInPriceGames: number;
  /** Land attacks on nations, all game; troops lost per tile gained, over
   *  those that ended (null if they gained none). */
  strikes: number;
  strikePrice: number | null;
  /** Nation attacks on us within PILE_ON_TICKS after a strike, per strike,
   *  over the games that know when nations attacked; null if none does or
   *  they launched no strike. */
  pileOnsPerStrike: number | null;
  pileOns: number;
  pileOnStrikes: number;
  /** Atom and hydrogen bombs, and MIRVs, aimed at us. */
  bombsReceived: number;
  mirvsReceived: number;
  /** Our land share when each was launched, median over all of them, from
   *  the games that recorded the nuke log (null if none did or none came). */
  shareAtBombs: number | null;
  shareAtMirvs: number | null;
  /** Gold held at GOLD_MINUTES, over the games alive and sampled then. */
  gold: {
    minute: number;
    games: number;
    median: number | null;
    p75: number | null;
    max: number | null;
  }[];
  /** Games in which a nation held half the land, and the median first
   *  minute it did (nationReached); the same for a nation's win (80%).
   *  `known` counts the games that record leaders or a winner, less those
   *  cut short (cutShort: every seat out, no --play-out) before a nation
   *  got there: what the nations did after the arena stopped is unknown. */
  nationHalf: { games: number; known: number; medianMinute: number | null };
  nationWin: { games: number; known: number; medianMinute: number | null };
  /** Seats whose log reached LOG_LINES_KEPT: their log-read counts (search,
   *  and the `def why` pile-on fallback) may be short. */
  truncatedLogs: number;
  /** The searches the seats logged; null if none did. */
  search: SearchSummary | null;
}

/** The searches an entrant's seats logged (SearchLogStats), added up. */
export interface SearchSummary {
  /** Games with a search logged. */
  games: number;
  format: "search" | "probe" | "mixed";
  searches: number;
  skipped: number;
  none: number;
  byTrigger: Record<string, number>;
  acts: number;
  actsByKind: Record<string, number>;
  /** The acts' predicted gains, added up. */
  gain: number;
  ms: number;
  /** Search time ÷ the game's own time (plan.md §1.8): Σ search ms ÷
   *  Σ (wall ms − search ms), over the games with a search and a wall time,
   *  and its range by game. */
  R: number | null;
  rangeR: [number, number] | null;
  /** Σ tick-equivalents ÷ Σ ticks played, over the games whose search lines
   *  log them: R in tick-equivalents, which replays, over the whole game.
   *  Not the budget's own ratio (§2.6), whose cap counts from searchFrom
   *  and allows 3,000 more. */
  ticksR: number | null;
  checks: number;
  mismatches: number;
  /** Of `games`, those whose log reached LOG_LINES_KEPT: their later
   *  searches, checks and mismatches were not kept, so a mismatch count of 0
   *  proves nothing for them. */
  truncated: number;
}

const add = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

function searchSummary(
  rows: readonly { r: SummaryGame; seat: number }[],
): SearchSummary | null {
  const games = rows.flatMap(({ r, seat }) => {
    const log = logStatsOf(r.seats[seat]);
    const s = log?.search ?? null;
    return s === null ? [] : [{ r, s, cut: log!.truncated }];
  });
  if (games.length === 0) return null;
  const formats = new Set(games.map((g) => g.s.format));
  const byTrigger: Record<string, number> = {};
  const actsByKind: Record<string, number> = {};
  for (const { s } of games) {
    add(byTrigger, s.byTrigger);
    add(actsByKind, s.actsByKind);
  }
  const sum = (f: (s: SearchLogStats) => number) =>
    games.reduce((a, g) => a + f(g.s), 0);
  const timed = games.filter(
    ({ r, s }) => r.wallMs !== undefined && r.wallMs > s.ms,
  );
  const ratios = timed.map(({ r, s }) => s.ms / (r.wallMs! - s.ms));
  const own = timed.reduce((a, { r, s }) => a + r.wallMs! - s.ms, 0);
  const ticked = games.filter(({ s }) => s.te !== null);
  const ticks = ticked.reduce((a, { r }) => a + r.ticks, 0);
  return {
    games: games.length,
    format: formats.size === 1 ? [...formats][0] : "mixed",
    searches: sum((s) => s.searches),
    skipped: sum((s) => s.skipped),
    // Stored by the first parser, which did not count them: none.
    none: sum((s) => s.none ?? 0),
    byTrigger,
    acts: sum((s) => s.acts),
    actsByKind,
    gain: sum((s) => s.gain),
    ms: sum((s) => s.ms),
    R: timed.length === 0 ? null : timed.reduce((a, g) => a + g.s.ms, 0) / own,
    rangeR:
      ratios.length === 0 ? null : [Math.min(...ratios), Math.max(...ratios)],
    ticksR:
      ticked.length === 0 || ticks === 0
        ? null
        : ticked.reduce((a, g) => a + g.s.te!, 0) / ticks,
    checks: sum((s) => s.checks),
    mismatches: sum((s) => s.mismatches),
    truncated: games.filter((g) => g.cut).length,
  };
}

/** Games in which a nation reached `share`, and the median minute, over the
 *  games that know: those that record leaders or a winner, unless cut short
 *  (cutShort) before a nation reached it. */
function nationStat(
  rows: readonly { r: SummaryGame }[],
  share: number,
): EntrantSummary["nationHalf"] {
  const known = rows.flatMap(({ r }) => {
    if (r.leaders === undefined && r.winner === undefined) return [];
    const at = nationReached(r, share);
    return at !== null || !cutShort(r) ? [at] : [];
  });
  const minutes = known.filter((m) => m !== null);
  return {
    games: minutes.length,
    known: known.length,
    medianMinute: median(minutes),
  };
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
  const top3 = known(rows.map(({ r, seat }) => top3At(r, seat, 10)));
  const out20 = known(rows.map(({ r, seat }) => outBefore(r, seat, 20)));
  const lost20 = known(rows.map(({ r, seat }) => lostBefore(r, seat, 20)));

  const flows = rows.map(({ r, seat }) => seatFlow(r, seat));
  const utilization = flows.flatMap((f) =>
    f.utilization === null ? [] : [f.utilization],
  );
  const idle = flows.flatMap((f) =>
    f.idleShare === null ? [] : [f.idleShare],
  );
  const prices = flows.flatMap((f) =>
    f.allInPrice === null ? [] : [f.allInPrice],
  );
  const lost = flows.reduce((a, f) => a + f.strikeTroopsLost, 0);
  const gained = flows.reduce((a, f) => a + f.strikeTilesGained, 0);
  const piled = flows.filter((f) => f.pileOns !== null);
  const pileOnStrikes = piled.reduce((a, f) => a + f.strikes, 0);
  const pileOns = piled.reduce((a, f) => a + f.pileOns!, 0);

  const nukes = seats.map((s) => s.received?.nukes);
  const logged = seats.flatMap((s) => s.received?.nukeLog ?? []);
  const shareAtType = (bombs: boolean) =>
    median(
      logged.filter((n) => (n.type === "mirv") !== bombs).map((n) => n.share),
    );
  const gold = GOLD_MINUTES.map((minute) => {
    const held = rows.flatMap(({ r, seat }) => {
      const g = goldAt(r, seat, minute);
      return g === null ? [] : [g];
    });
    return {
      minute,
      games: held.length,
      median: median(held),
      p75: quantile(held, 0.75),
      max: held.length === 0 ? null : Math.max(...held),
    };
  });
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
    top3At10: top3.rate,
    top3At10Games: top3.games,
    medianWinMinutes: median(
      rows
        .filter(({ r, seat }) => r.seats[seat].result === "win")
        .map(({ r }) => r.gameMinutes),
    ),
    lostBefore20: lost20.rate,
    lostBefore20Games: lost20.games,
    utilization: utilization.length === 0 ? null : mean(utilization),
    idleShare: idle.length === 0 ? null : mean(idle),
    flowGames: utilization.length,
    allInPrice: median(prices),
    allInPriceGames: prices.length,
    strikes: flows.reduce((a, f) => a + f.strikes, 0),
    strikePrice: gained > 0 ? lost / gained : null,
    pileOnsPerStrike: pileOnStrikes > 0 ? pileOns / pileOnStrikes : null,
    pileOns,
    pileOnStrikes,
    bombsReceived: nukes.reduce(
      (a, n) => a + (n === undefined ? 0 : n.atom + n.hydrogen),
      0,
    ),
    mirvsReceived: nukes.reduce((a, n) => a + (n?.mirv ?? 0), 0),
    shareAtBombs: shareAtType(true),
    shareAtMirvs: shareAtType(false),
    gold,
    nationHalf: nationStat(rows, 0.5),
    nationWin: nationStat(rows, 0.8),
    truncatedLogs: seats.filter((s) => logStatsOf(s)?.truncated === true)
      .length,
    search: searchSummary(rows),
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

/** 1.2M, 340k, 12: an amount of gold or troops, short. */
export function amount(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return v.toFixed(0);
}

/** "44 strike, 27 break": counts by name, most first. */
function counts(by: Record<string, number>): string {
  const list = Object.entries(by).sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  return list.length === 0 ? "–" : list.map(([k, v]) => `${v} ${k}`).join(", ");
}

function markdownTable(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(header),
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map(line),
  ].join("\n");
}

/**
 * The summary as Markdown: the milestone table, one row per entrant, then
 * the flow, strike, bomb, gold, nation and search table (flowTable).
 * "errored" counts the games among `games` that stopped early on an error,
 * "crashed" the jobs whose worker died. An entrant with no games (another
 * entrant's --game rerun) shows "–" where a mean over nothing would read as
 * a result.
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
  return [[header, rule, ...rows].join("\n"), flowTable(summaries)].join(
    "\n\n",
  );
}

/**
 * The M4 plan's metrics as a Markdown table, one row per entrant: troop flow
 * over minutes 5-15 (the all-in price a median over the games that grew
 * more than PRICE_MIN_TILES), strikes (their price pooled: all troops lost
 * ÷ all tiles gained) and the pile-ons after them, bombs received, gold, the
 * minute a nation took half the land or won, and the searches logged. "–"
 * where nothing is known.
 */
export function flowTable(summaries: readonly EntrantSummary[]): string {
  const [m0, m1] = FLOW_MINUTES;
  const header = [
    "entrant",
    `utilization m${m0}-${m1}`,
    `idle m${m0}-${m1}`,
    `all-in price m${m0}-${m1}`,
    "strikes",
    "pile-ons / strike",
    "bombs (MIRVs) in",
    "our share at bombs",
    `gold @${GOLD_MINUTES.join("/")}`,
    "nation ≥ 50%",
    "nation won",
    "searches",
    "acts",
    "predicted gain",
    "R",
    "checks",
    "logs cut",
  ];
  const na = "–";
  const rows = summaries.map((s) => {
    const search = s.search;
    const nation = (n: EntrantSummary["nationHalf"]) =>
      n.known === 0
        ? na
        : `${n.games} of ${n.known}` +
          (n.medianMinute === null ? "" : `, ${n.medianMinute.toFixed(1)} min`);
    return [
      s.label,
      s.utilization === null
        ? na
        : `${s.utilization.toFixed(3)} of ${s.flowGames}`,
      s.idleShare === null ? na : pct(s.idleShare),
      s.allInPrice === null
        ? na
        : `${s.allInPrice.toFixed(0)} of ${s.allInPriceGames}`,
      `${s.strikes}${s.strikePrice === null ? "" : `, ${s.strikePrice.toFixed(1)}/tile`}`,
      s.pileOnsPerStrike === null
        ? na
        : `${s.pileOnsPerStrike.toFixed(2)} (${s.pileOns} in ${s.pileOnStrikes})`,
      `${s.bombsReceived}${s.mirvsReceived ? ` (${s.mirvsReceived})` : ""}`,
      s.shareAtBombs === null && s.shareAtMirvs === null
        ? na
        : [
            s.shareAtBombs === null ? null : pct(s.shareAtBombs),
            s.shareAtMirvs === null ? null : `MIRVs ${pct(s.shareAtMirvs)}`,
          ]
            .filter((t) => t !== null)
            .join("; "),
      s.gold
        .map((g) => (g.median === null ? na : amount(g.median)))
        .join(" / "),
      nation(s.nationHalf),
      nation(s.nationWin),
      search === null
        ? na
        : `${search.searches}` +
          (search.skipped || search.none
            ? ` (${[
                ...(search.skipped ? [`${search.skipped} skipped`] : []),
                ...(search.none ? [`${search.none} with no candidate`] : []),
              ].join(", ")})`
            : ""),
      search === null
        ? na
        : `${search.acts}${search.acts > 0 ? `: ${counts(search.actsByKind)}` : ""}`,
      search === null ? na : amount(search.gain),
      search === null || search.R === null
        ? na
        : `${search.R.toFixed(2)}` +
          (search.rangeR === null || search.games < 2
            ? ""
            : ` (${search.rangeR[0].toFixed(2)}-${search.rangeR[1].toFixed(2)})`) +
          (search.ticksR === null ? "" : `, ticks ${search.ticksR.toFixed(2)}`),
      search === null
        ? na
        : `${search.checks}, ${search.mismatches} mismatch${search.mismatches === 1 ? "" : "es"}` +
          (search.truncated > 0
            ? ` (${search.truncated} log${search.truncated === 1 ? "" : "s"} cut: more may be missing)`
            : ""),
      String(s.truncatedLogs),
    ];
  });
  return markdownTable(header, rows);
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
 * log (that is in gameNNN.log), with what the summary reads out of the log.
 * The fields SeatResult marks as added later (standings, received, attacks,
 * stats.forkMs) are missing from older files, and so is logStats, which
 * readRun then reads from gameNNN.log.
 */
export type StoredSeat = Omit<SeatResult, "logs"> & { logStats?: SeatLogStats };

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
    seats: seats.map(({ logs, ...s }) => ({
      ...s,
      logStats: seatLogStats(logs),
    })),
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
 * A stored game whose seats all have their logStats: those recorded without
 * (runs from before it existed) read them from the game's log beside it. A
 * seat the log has no lines under, or a game without a log, stays without.
 */
function withLogStats<T extends { seats: StoredSeat[] }>(
  game: T,
  logFile: string,
): T {
  if (game.seats.every((s) => s.logStats !== undefined)) return game;
  if (!fs.existsSync(logFile)) return game;
  const bySeat = splitGameLog(fs.readFileSync(logFile, "utf8"));
  for (const s of game.seats) {
    const lines = bySeat.get(s.clientID);
    if (s.logStats === undefined && lines !== undefined) {
      s.logStats = seatLogStats(lines);
    }
  }
  return game;
}

/**
 * Loads a results directory. Runs recorded before a field existed load with
 * it null (provenance) or missing (the M1 seat fields); their game files get
 * `game` and `entrant` from the index and the entrant count, the only place
 * that ever has to derive them, and their seats' logStats from the logs.
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
      withLogStats(
        place(
          JSON.parse(fs.readFileSync(path.join(gamesDir, f), "utf8")) as Omit<
            StoredGame,
            "game" | "entrant"
          > &
            Partial<Pick<StoredGame, "game" | "entrant">>,
        ),
        path.join(gamesDir, f.replace(/\.json$/, ".log")),
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
