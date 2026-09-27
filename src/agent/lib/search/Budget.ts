import PHI from "./phi.json";
import type { Candidate } from "./Registry";
import { roundUp } from "./Rounds";

// Package WP2 (docs/14-m4-plan.md §2.6): the search's budget, in live-tick
// equivalents (never milliseconds, so arena runs replay):
//
//   C_search = Σ over the search's rollouts (φ + ticks advanced)
//   Σ C ≤ R·(t − searchFrom) + BUDGET_SLACK
//
// φ is a fork's cost in live ticks, from the committed per-map table
// phi.json (measured once; the fallback for a map it lacks). Before its
// rollouts a search is priced to its first looks (rounds 1 and 2, and the
// break round's first step); one that would exceed the cap degrades, in
// order: drop the plans sized by a share below 1 of the purse; drop breaks;
// keep only lapse, keep and defensive plans; skip. The break round's later
// steps, and the gated look, are bought one at a time from what is left
// (Rounds' `afford`): a break the cap cannot look further at is dropped.
// Every decision here is a function of the candidate list, the table and
// the ticks, so it is deterministic.

/** Live-tick equivalents granted at searchFrom (the first searches). */
export const BUDGET_SLACK = 3000;

/** How the search forks: ctx.fork() for every rollout (a snapshot and
 *  restore each), or one ctx.fork() per search whose structural clones
 *  (GameFork.source) the rollouts play on. */
export type ForkMode = "restore" | "clone";

/** φ of a search's first fork and of each other fork. */
export interface Phi {
  first: number;
  each: number;
}

interface PhiRow {
  restore: number;
  take: number;
  clone: number;
}

/** The table's row for `map`, or the fallback. */
export function phiRow(map: string): PhiRow {
  const maps = PHI.maps as Record<string, PhiRow>;
  return Object.prototype.hasOwnProperty.call(maps, map)
    ? maps[map]
    : PHI.fallback;
}

/** φ for `map` in `mode`: every restore costs `restore`; a clone search
 *  pays one restore, the take and a clone for its first rollout, and a
 *  clone for each other. */
export function phiFor(map: string, mode: ForkMode): Phi {
  const r = phiRow(map);
  return mode === "restore"
    ? { first: r.restore, each: r.restore }
    : { first: r.restore + r.take + r.clone, each: r.clone };
}

/** What a search's rounds may spend (RoundsParams' horizons). */
export interface CostModel {
  phi: Phi;
  H1: number;
  H: number;
  HStrong: number;
  /** The break round's first step (its later looks are bought as it
   *  goes). */
  breakFirst: number;
  keep: number;
  grid: number;
}

/** The longest horizon `c` is taken to up front (a break: its first
 *  step). */
export function horizonBound(c: Candidate, m: CostModel): number {
  if (c.isBreak) return m.breakFirst;
  const post = c.strongCheck ? Math.max(m.H, m.HStrong) : m.H;
  return Math.max(m.H, roundUp(c.lastSend + post, m.grid));
}

/**
 * An upper bound of what a search costs up front, after the base's round 1
 * (whose φ + H1 is spent before the candidates exist): each candidate's
 * fork and round 1, the `keep` longest non-break horizons, the break
 * round's first step, and the base to the longest of them.
 */
export function restCost(cands: readonly Candidate[], m: CostModel): number {
  let cost = 0;
  let maxH = m.H;
  let hasBreak = false;
  const nonBreak: number[] = [];
  for (const c of cands) {
    cost += m.phi.each + m.H1;
    const h = horizonBound(c, m);
    if (c.isBreak) hasBreak = true;
    else nonBreak.push(h);
    maxH = Math.max(maxH, h);
  }
  nonBreak.sort((a, b) => b - a);
  for (const h of nonBreak.slice(0, Math.max(1, m.keep))) cost += h - m.H1;
  if (hasBreak) cost += m.breakFirst - m.H1;
  return cost + (maxH - m.H1);
}

/** The degrade levels, in order (the log names). */
export const DEGRADE = [
  "full",
  "whole",
  "nobreak",
  "defensive",
  "skip",
] as const;

const KEEP: readonly ((c: Candidate) => boolean)[] = [
  () => true,
  (c) => c.frac === undefined || c.frac >= 1,
  (c) => (c.frac === undefined || c.frac >= 1) && !c.isBreak,
  (c) => c.defensive,
];

/**
 * The first degrade level whose candidates' restCost fits in `room`, the
 * candidates it keeps (in order) and that cost. Level 4 ("skip") keeps
 * none. An empty level is passed over: a search needs a plan.
 */
export function degrade(
  cands: readonly Candidate[],
  m: CostModel,
  room: number,
): { level: number; kept: Candidate[]; cost: number } {
  for (let level = 0; level < KEEP.length; level++) {
    const kept = cands.filter(KEEP[level]);
    if (kept.length === 0) continue;
    const cost = restCost(kept, m);
    if (cost <= room) return { level, kept, cost };
  }
  return { level: DEGRADE.length - 1, kept: [], cost: 0 };
}

/** The restCost of the cheapest non-empty degrade level (what a refused
 *  search would have needed at least); Infinity for no candidate. */
export function cheapest(cands: readonly Candidate[], m: CostModel): number {
  let least = Infinity;
  for (const keep of KEEP) {
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

  charge(te: number): void {
    this.spent += te;
  }
}
