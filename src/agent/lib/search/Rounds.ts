import type { PlayerID } from "../../../core/game/Game";
import type { BaseView, Candidate } from "./Registry";
import type {
  AllianceEnd,
  AttackSeen,
  BorderNation,
  SendState,
} from "./Runner";
import { Danger, Snap, value, ValueParams } from "./Value";

// Package WP2 (docs/14-m4-plan.md §2.5): the rounds of one search, over
// rollouts the caller opens (Runner, or synthetic series in the tests).
//
// - Round 1: the base and every candidate to H1; a candidate more than
//   `prune` below the base's tiles there (or dead) is dropped.
// - Round 2: the best `keep` non-break candidates by V at H1, and the base,
//   to each one's judged horizon: max(H, ⌈lastSend + H⌉) on a `grid`, or
//   lastSend + HStrong when the plan's target holds ≥ strongShare of our
//   home troops at its send (read in the rollout).
// - Round 3 (breaks, stepwise): the best break by V at H1 and the base go
//   to HBreak[0]; while the break leads by the margin they go on to the
//   next step. At the last step the break is judged, unless it leads and
//   the danger gate fires: then both go to HBreakGated and it is judged
//   there. The gate (§2.5): (a) an alliance of ours held at the fork,
//   other than the target's, ended early while we were a traitor in the
//   break world and is still gone; (b) the break world has an unallied
//   bordering nation with maxTroops ≥ 1.1 × ours that the base world holds
//   allied or does not border.
// - The budget (Budget.ts) priced round 2's horizons (a strong target's
//   when known at the search) and the break's whole stepwise look up front;
//   the looks it could not price (a strong target at a later send, the
//   gated look) are bought as they come (`afford`, given all that is still
//   to spend), and a plan the budget cannot look further at is dropped,
//   never judged short.
// - Round 2b (defensive): when the base, by its longest horizon, shows a
//   nation attacking us or a loss of more than lossShare of our tiles, the
//   r2b generators' candidates go to that horizon.
// - The choice: the finalist with the highest gain V − V_base at its
//   horizon (minus rival·(top − top_base)), skipping any that dipped more
//   than `dip` below the base's tiles at a common checkpoint; played if
//   the gain beats `need` (ties and smaller gains keep the base).
// With H1 150, prune 0.03, H 600, HStrong 600, HBreak [1200], HBreakGated
// 0, keep 2, dip 0.2 and a 50-tick grid this is the act3 prototype's
// evaluation exactly.

/** A rollout as the rounds use it (Runner implements it). */
export interface Roll {
  readonly name: string;
  readonly h: number;
  readonly dead: boolean;
  readonly snaps: readonly Snap[];
  readonly attackers: ReadonlyMap<PlayerID, AttackSeen>;
  readonly sent: SendState | null;
  readonly ended: readonly AllianceEnd[];
  readonly land0: number;
  /** Steps to `to` (or the death); a snap at `to` unless snapEnd is off. */
  advance(to: number, snapEnd?: boolean): Snap;
  last(): Snap;
  at(h: number): Snap;
  landAt(h: number): number;
  /** The danger terms at the snap at or before h (null: none). */
  dangerAt?(h: number): Danger | null;
  bordering(minContact: number): readonly BorderNation[];
  alliedWith(id: PlayerID): boolean;
  /** config.maxTroops(our player) now. */
  capNow(): number;
}

export interface RoundsParams {
  H1: number;
  prune: number;
  H: number;
  HStrong: number;
  strongShare: number;
  /** Ascending break steps; the last is the break's horizon. */
  HBreak: readonly number[];
  /** 0 = off. */
  HBreakGated: number;
  keep: number;
  dip: number;
  /** The acting margin in V (max(marginAbs, margin·tiles)). */
  need: number;
  rival: number;
  value: ValueParams;
  /** Judged horizons are rounded up to a multiple of this. */
  grid: number;
  /** Bordering, for the gate. */
  minContact: number;
  /** Our tiles at the search (round 2b's loss test). */
  tiles0: number;
  /** Round 2b fires on a base loss above this share of tiles0. */
  lossShare: number;
  /** Whether the budget pays for `te` more live-tick equivalents than the
   *  rollouts have spent so far (asked with everything still to spend when
   *  a look it did not price comes up); absent: always. */
  afford?: (te: number) => boolean;
}

/** The gate's cap ratio: an unallied bordering nation this much above
 *  our cap is undeterrable at our cap (§2.5 (b)). */
export const GATE_CAP_RATIO = 1.1;

/** One candidate's fate in the rounds. */
export interface Judged {
  cand: Candidate;
  roll: Roll;
  /** The round it was last judged in. */
  round: 1 | 2 | 3 | 4;
  /** Its judged horizon (null: dropped before one was set). */
  h: number | null;
  /** V and the base's V at h, and the gain (V − V_base − the rival
   *  term); NaN until judged. */
  v: number;
  vb: number;
  gain: number;
  dipped: boolean;
  /** Why it is out: "pruned" (round 1), "cut" (not a finalist),
   *  "trail" (a break that stopped leading at a step), "budget" (a look it
   *  needed that the budget could not pay: a strong target's, the gated
   *  one), "dip"; null for a finalist. */
  drop: string | null;
  /** A break's gain at each step. */
  steps: { h: number; gain: number }[];
  /** The target was strong at the send (round 2). */
  strong: boolean;
  /** The gate extended it (round 3). */
  gated: boolean;
}

export interface RoundsResult {
  /** Every candidate, in candidate order, then round 2b's. */
  judged: Judged[];
  /** The base's V at each horizon it was judged at. */
  baseAt: ReadonlyMap<number, number>;
  best: Judged | null;
  /** best, if its gain beats the margin: the plan to play. */
  chosen: Judged | null;
  /** The break gate's verdict, if it was asked. */
  gate: { a: boolean; b: boolean } | null;
  /** Whether round 2b ran. */
  defended: boolean;
}

/** `x` rounded up to a multiple of `grid` (grid ≤ 1: x). */
export function roundUp(x: number, grid: number): number {
  return grid > 1 ? Math.ceil(x / grid) * grid : x;
}

/** V of a roll's snap. */
function valueAt(r: Roll, s: Snap, p: RoundsParams): number {
  return value(s, p.value, r.land0, r.landAt(s.h), r.dangerAt?.(s.h) ?? null);
}

/**
 * The gain of `r` at `h` over the base, and whether it dipped: a snap of r
 * more than `dip` below the base's tiles where both have one.
 */
export function gainOver(
  r: Roll,
  base: Roll,
  h: number,
  vb: number,
  p: RoundsParams,
): { v: number; gain: number; dipped: boolean } {
  const s = r.at(h);
  const v = r.dead ? -Infinity : valueAt(r, s, p);
  let dipped = false;
  for (const sn of r.snaps) {
    const b = base.at(sn.h);
    if (b.h === sn.h && sn.tiles < (1 - p.dip) * b.tiles) dipped = true;
  }
  let gain = v - vb;
  if (p.rival !== 0) gain -= p.rival * (s.top - base.at(h).top);
  return { v, gain, dipped };
}

/**
 * The break gate at the break's last step, with `brk` and `base` at the
 * same tick: (a) an alliance held at the fork (the Runner tracks no other),
 * other than `target`'s, ended early while we were a traitor and is still
 * gone; (b) an unallied bordering nation at ≥ GATE_CAP_RATIO of our cap in
 * the break world is allied or not bordering in the base world.
 */
export function breakGate(
  brk: Roll,
  base: Roll,
  target: PlayerID | null,
  minContact: number,
): { a: boolean; b: boolean } {
  const a = brk.ended.some(
    (e) =>
      e.id !== target && e.early && e.traitor && !brk.alliedWith(e.id),
  );
  let b = false;
  if (!brk.dead) {
    const cap = brk.capNow();
    const strong = brk
      .bordering(minContact)
      .filter((n) => !n.allied && n.maxTroops >= GATE_CAP_RATIO * cap);
    if (strong.length > 0) {
      const inBase = new Map(base.bordering(minContact).map((n) => [n.id, n]));
      b = strong.some((n) => {
        const there = inBase.get(n.id);
        return there === undefined || there.allied || base.alliedWith(n.id);
      });
    }
  }
  return { a, b };
}

/**
 * Runs rounds 1-3 and 2b. `base` is the base rollout (advanced to H1 here
 * if it is not yet); `open` makes a candidate's rollout; `defend` makes
 * round 2b's candidates from the base's whole horizon (none: no round 2b).
 */
export function runRounds(
  p: RoundsParams,
  base: Roll,
  cands: readonly Candidate[],
  open: (c: Candidate) => Roll,
  defend?: (b: BaseView) => Candidate[],
): RoundsResult {
  const fresh = (cand: Candidate, roll: Roll): Judged => ({
    cand,
    roll,
    round: 1,
    h: null,
    v: NaN,
    vb: NaN,
    gain: NaN,
    dipped: false,
    drop: null,
    steps: [],
    strong: false,
    gated: false,
  });

  // Round 1.
  base.advance(p.H1);
  const baseT1 = base.last().tiles;
  const judged = cands.map((c) => {
    const r = open(c);
    r.advance(p.H1);
    return fresh(c, r);
  });
  const v1 = (j: Judged) => valueAt(j.roll, j.roll.last(), p);
  const alive1 = judged.filter((j) => {
    const sn = j.roll.last();
    const ok = sn.alive && sn.tiles >= (1 - p.prune) * baseT1;
    if (!ok) j.drop = "pruned";
    return ok;
  });
  const byV1 = (a: Judged, b: Judged) => v1(b) - v1(a);
  const nonBreaks = alive1.filter((j) => !j.cand.isBreak).sort(byV1);
  const breaks = alive1.filter((j) => j.cand.isBreak).sort(byV1);
  const keptS = nonBreaks.slice(0, Math.max(1, p.keep));
  const keptB = breaks.slice(0, 1);
  for (const j of [...nonBreaks.slice(keptS.length), ...breaks.slice(1)]) {
    j.drop = "cut";
  }

  // Round 3's break: the best by V at H1, priced up front to its whole
  // stepwise look (brkTo; 0 once it is out).
  const steps = [...p.HBreak].filter((h) => h > 0).sort((a, b) => a - b);
  let brk: Judged | null = steps.length > 0 ? (keptB[0] ?? null) : null;
  if (keptB[0] !== undefined && brk === null) keptB[0].drop = "cut";
  let brkTo = brk === null ? 0 : steps[steps.length - 1];

  // What the looks planned so far still cost: each finalist to its judged
  // horizon, the break to brkTo, and the base to the longest of them. A
  // look nobody priced up front is bought only if the budget pays for all
  // of it (`afford`, given everything still to spend).
  const finals = [...keptS];
  const outstanding = (): number => {
    let te = 0;
    let to = p.H;
    for (const j of finals) {
      te += Math.max(0, j.h! - j.roll.h);
      to = Math.max(to, j.h!);
    }
    if (brk !== null) {
      te += Math.max(0, brkTo - brk.roll.h);
      to = Math.max(to, brkTo);
    }
    return te + Math.max(0, to - base.h);
  };
  const affordable = () => p.afford === undefined || p.afford(outstanding());

  // Round 2's judged horizons. A target strong at the send (read as the
  // rollout passes it) is judged HStrong after it; a strong look the
  // budget did not price up front (Candidate.strong unset: a send later
  // than now) is bought here, or the plan is dropped, never judged short.
  const bought: Judged[] = [];
  for (const j of keptS) {
    j.round = 2;
    j.h = Math.max(p.H, roundUp(j.cand.lastSend + p.H, p.grid));
    if (!j.cand.strongCheck || p.HStrong <= p.H) continue;
    j.roll.advance(j.cand.lastSend + 1, false);
    const s = j.roll.sent;
    if (s === null || !s.targetAlive || s.targetTroops < p.strongShare * s.home) {
      continue;
    }
    j.strong = true;
    if (j.cand.strong === true) {
      j.h = Math.max(p.H, roundUp(j.cand.lastSend + p.HStrong, p.grid));
    } else bought.push(j);
  }
  for (const j of bought) {
    const short = j.h!;
    j.h = Math.max(p.H, roundUp(j.cand.lastSend + p.HStrong, p.grid));
    if (affordable()) continue;
    j.h = short;
    j.drop = "budget";
    finals.splice(finals.indexOf(j), 1);
  }

  // The finalists go to their horizons now (the rollouts are independent,
  // so the order changes nothing), so that the break round buys its looks
  // from what they leave. The base goes through every horizon in ascending
  // order; round 3's break steps are judged as the base reaches them.
  for (const j of finals) j.roll.advance(j.h!);
  let step = 0;
  const pending = new Set<number>([p.H]);
  for (const j of finals) pending.add(j.h!);
  if (brk !== null) {
    brk.round = 3;
    pending.add(steps[0]);
  }
  const baseAt = new Map<number, number>();
  let gate: { a: boolean; b: boolean } | null = null;
  while (pending.size > 0) {
    const h = Math.min(...pending);
    pending.delete(h);
    base.advance(h);
    baseAt.set(h, valueAt(base, base.last(), p));
    if (brk === null) continue;
    if (brk.gated) {
      if (h === brk.h) brk.roll.advance(h);
      continue;
    }
    if (step >= steps.length || steps[step] !== h) continue;
    brk.roll.advance(h);
    const g = gainOver(brk.roll, base, h, baseAt.get(h)!, p);
    brk.steps.push({ h, gain: g.gain });
    const leads = !g.dipped && g.gain > p.need;
    if (step < steps.length - 1) {
      // The rest of the look was priced up front: the check only keeps
      // the cap whatever was bought since.
      if (!leads || !affordable()) {
        brk.h = h;
        brk.drop = g.dipped ? "dip" : leads ? "budget" : "trail";
        brk = null;
        continue;
      }
      step++;
      pending.add(steps[step]);
      continue;
    }
    step++;
    brk.h = h;
    if (leads && p.HBreakGated > h) {
      gate = breakGate(brk.roll, base, brk.cand.target, p.minContact);
      if (gate.a || gate.b) {
        brkTo = p.HBreakGated;
        if (!affordable()) {
          // Danger, and no budget to see past it: not played.
          brk.drop = "budget";
          brk = null;
          continue;
        }
        brk.gated = true;
        brk.h = p.HBreakGated;
        pending.add(p.HBreakGated);
      }
    }
  }

  // Round 2b.
  let defended = false;
  const extra: Judged[] = [];
  if (defend !== undefined) {
    const lost = base.last().tiles < (1 - p.lossShare) * p.tiles0;
    if (base.attackers.size > 0 || lost) {
      defended = true;
      const hmax = base.h;
      if (!baseAt.has(hmax)) baseAt.set(hmax, valueAt(base, base.last(), p));
      const view: BaseView = {
        h: hmax,
        attackers: base.attackers,
        snaps: base.snaps,
      };
      for (const c of defend(view)) {
        const r = open(c);
        r.advance(hmax);
        const j = fresh(c, r);
        j.round = 4;
        j.h = hmax;
        extra.push(j);
      }
    }
  }

  // The choice.
  let best: Judged | null = null;
  let bestGain = -Infinity;
  const finalists = [...finals];
  if (brk !== null) finalists.push(brk);
  finalists.push(...extra);
  for (const j of finalists) {
    const h = j.h!;
    const vb = baseAt.get(h);
    if (vb === undefined) continue;
    const g = gainOver(j.roll, base, h, vb, p);
    j.v = g.v;
    j.vb = vb;
    j.gain = g.gain;
    j.dipped = g.dipped;
    if (g.dipped) {
      j.drop = "dip";
      continue;
    }
    if (g.gain > bestGain) {
      bestGain = g.gain;
      best = j;
    }
  }
  const chosen = best !== null && bestGain > p.need ? best : null;
  return {
    judged: [...judged, ...extra],
    baseAt,
    best,
    chosen,
    gate,
    defended,
  };
}
