import PHI from "./phi.json";
import type { Candidate } from "./Registry";
import { roundUp } from "./Rounds";

// Package WP2 (docs/14-m4-plan.md §2.6): the search's budget, in live-tick
// equivalents (never milliseconds, so arena runs replay):
//
//   C_search = Σ over the search's rollouts (φ + ticks advanced)
//   Σ C ≤ R·(t − searchFrom) + slack   (searchSlack)
//
// φ is a fork's cost in live ticks, from the committed per-map table
// phi.json (measured once; the fallback for a map it lacks). A search forks
// the live game once (ctx.fork(), a structural clone of it: a take of its
// state and a clone) and clones that fork for each rollout (one take of it,
// then a clone each): its first rollout costs φ.first (ctx.fork(), the
// take and a clone), every other one φ.each (a clone).
//
// Before its rollouts a search is priced to every look it plans (restCost):
// each candidate's fork and round 1, round 2's `keep` longest horizons (a
// strike now on a target already strong at its long horizon), the break
// round's whole stepwise look, and the base to the longest of them. A search
// whose price exceeds what it may spend degrades, in order: drop the plans
// sized by a share below 1 of the purse; drop breaks; keep only lapse, keep
// and defensive plans; keep only the trigger's own plan (a T1 search's
// lapse of its ally, an attack trigger's alliance request); skip. The looks
// only a rollout reveals (a target strong at a later send, the danger-gated
// break look) are bought as they come from what is left (Rounds'
// `afford`): a plan the budget cannot look further at is dropped, never
// judged short. Every decision here is a function of the candidate list,
// the table and the ticks, so it is deterministic.

/** Live-tick equivalents granted at searchFrom (the first searches), the
 *  searchSlack default: the first search's whole break look (about 2,900
 *  on Europe at 2,400) and its danger-gated extension (1,200 more). */
export const BUDGET_SLACK = 4500;

/** φ of a search's first fork and of each other fork. */
export interface Phi {
  first: number;
  each: number;
}

/** φ for `map`: the table's row (measured in situ, phi.json), or the
 *  fallback for a map it lacks. */
export function phiFor(map: string): Phi {
  const maps = PHI.maps as Record<string, Phi>;
  const r = Object.prototype.hasOwnProperty.call(maps, map)
    ? maps[map]
    : PHI.fallback;
  return { first: r.first, each: r.each };
}

/** What a search's rounds may spend (RoundsParams' horizons). */
export interface CostModel {
  phi: Phi;
  H1: number;
  H: number;
  HStrong: number;
  /** The break round's whole look: its last step. */
  breakLast: number;
  keep: number;
  grid: number;
}

/** The longest horizon `c` is priced to up front: a break its whole
 *  stepwise look; a plan whose target is known to be strong at its send
 *  (Candidate.strong) lastSend + HStrong; any other lastSend + H. */
export function horizonBound(c: Candidate, m: CostModel): number {
  if (c.isBreak) return Math.max(m.H1, m.breakLast);
  const post =
    c.strongCheck && c.strong === true ? Math.max(m.H, m.HStrong) : m.H;
  return Math.max(m.H, roundUp(c.lastSend + post, m.grid));
}

/**
 * What a search costs up front, after the base's round 1 (whose φ + H1 is
 * spent before the candidates exist): each candidate's fork and round 1,
 * the `keep` longest non-break horizons, the best break's whole look, and
 * the base to the longest of them. An upper bound of every look but those
 * bought later (Rounds' `afford`).
 */
export function restCost(cands: readonly Candidate[], m: CostModel): number {
  let cost = 0;
  let maxH = m.H;
  let breakTo = 0;
  const nonBreak: number[] = [];
  for (const c of cands) {
    cost += m.phi.each + m.H1;
    const h = horizonBound(c, m);
    if (c.isBreak) breakTo = Math.max(breakTo, h);
    else nonBreak.push(h);
    maxH = Math.max(maxH, h);
  }
  nonBreak.sort((a, b) => b - a);
  for (const h of nonBreak.slice(0, Math.max(1, m.keep))) cost += h - m.H1;
  if (breakTo > 0) cost += breakTo - m.H1;
  return cost + (maxH - m.H1);
}

/** The degrade levels, in order (the log names). */
export const DEGRADE = [
  "full",
  "whole",
  "nobreak",
  "defensive",
  "focus",
  "skip",
] as const;

/** The levels' filters; `focus` is the trigger's own plan (a T1 search's
 *  lapse of its ally, an attack trigger's alliance request), if any. */
function keeps(
  focus?: (c: Candidate) => boolean,
): ((c: Candidate) => boolean)[] {
  return [
    () => true,
    (c) => c.frac === undefined || c.frac >= 1,
    (c) => (c.frac === undefined || c.frac >= 1) && !c.isBreak,
    (c) => c.defensive,
    (c) => focus !== undefined && focus(c),
  ];
}

/**
 * The first degrade level whose candidates' restCost fits in `room`, the
 * candidates it keeps (in order) and that cost. The last ("skip") keeps
 * none. An empty level is passed over: a search needs a plan. `focus`:
 * the trigger's own plan, the last level kept before skipping.
 */
export function degrade(
  cands: readonly Candidate[],
  m: CostModel,
  room: number,
  focus?: (c: Candidate) => boolean,
): { level: number; kept: Candidate[]; cost: number } {
  const levels = keeps(focus);
  for (let level = 0; level < levels.length; level++) {
    const kept = cands.filter(levels[level]);
    if (kept.length === 0) continue;
    const cost = restCost(kept, m);
    if (cost <= room) return { level, kept, cost };
  }
  return { level: DEGRADE.length - 1, kept: [], cost: 0 };
}

/** The restCost of the cheapest non-empty degrade level (what a refused
 *  search would have needed at least); Infinity for no candidate. */
export function cheapest(
  cands: readonly Candidate[],
  m: CostModel,
  focus?: (c: Candidate) => boolean,
): number {
  let least = Infinity;
  for (const keep of keeps(focus)) {
    const kept = cands.filter(keep);
    if (kept.length > 0) least = Math.min(least, restCost(kept, m));
  }
  return least;
}

/** The running total and the cap. R ≤ 0: no cap. */
export class SearchBudget {
  /** Live-tick equivalents spent so far. */
  spent = 0;

  constructor(
    private readonly R: number,
    private readonly from: number,
    private readonly slack = BUDGET_SLACK,
  ) {}

  get capped(): boolean {
    return this.R > 0;
  }

  /** The cap at tick `t` (Infinity without one). */
  cap(t: number): number {
    if (!this.capped) return Infinity;
    return this.R * Math.max(0, t - this.from) + this.slack;
  }

  /** What is left at tick `t`. */
  room(t: number): number {
    return this.cap(t) - this.spent;
  }

  /** The first tick from `t` on at which the room reaches `need` if
   *  nothing more is spent (t itself if it already does, or no cap). */
  affordableAt(t: number, need: number): number {
    if (!this.capped || this.room(t) >= need) return t;
    // R·(u − from) + slack − spent ≥ need.
    const u = this.from + Math.ceil((need + this.spent - this.slack) / this.R);
    return Math.max(t + 1, u);
  }

  charge(te: number): void {
    this.spent += te;
  }
}
