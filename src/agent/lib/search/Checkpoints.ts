import type { Snap } from "./Value";

// Package WP2 (docs/14-m4-plan.md §2.2): the standing leak test. After a
// search, the live game must follow the rollout it plays (the chosen plan's,
// or the base's): at each of that rollout's snaps, the live tiles, home and
// outgoing troops at the start of the live tick fork + h equal the
// rollout's. A later act changes that future, so it drops the checks still
// pending. Any mismatch is a leak: policy state a copy did not carry.

/** The three numbers a checkpoint compares. */
export interface CheckSnap {
  tiles: number;
  home: number;
  out: number;
}

interface Check {
  tick: number;
  h: number;
  t0: number;
  pred: CheckSnap;
}

export class Checkpoints {
  private pending: Check[] = [];
  checks = 0;
  mismatches = 0;

  /** The checks of a rollout forked at `t0`: one per snap (the living
   *  ones; a dead rollout has no live game to compare). */
  add(t0: number, snaps: readonly Snap[]): void {
    for (const s of snaps) {
      if (!s.alive) continue;
      this.pending.push({
        tick: t0 + s.h,
        h: s.h,
        t0,
        pred: { tiles: s.tiles, home: s.home, out: s.out },
      });
    }
  }

  /** An act at `t` changed the future: the checks after it are dropped. */
  invalidate(t: number): void {
    this.pending = this.pending.filter((c) => c.tick <= t);
  }

  /** Pending checks. */
  get size(): number {
    return this.pending.length;
  }

  /**
   * The checks due at live tick `t` against `live`, as log lines
   * (`search-check <t0> +<h> ok|MISMATCH ...`); checks whose tick passed
   * unverified (no live run then) are dropped.
   */
  verify(t: number, live: () => CheckSnap): string[] {
    if (this.pending.length === 0) return [];
    const lines: string[] = [];
    const keep: Check[] = [];
    let now: CheckSnap | null = null;
    for (const c of this.pending) {
      if (c.tick !== t) {
        if (c.tick > t) keep.push(c);
        continue;
      }
      now ??= live();
      this.checks++;
      const ok =
        now.tiles === c.pred.tiles &&
        now.home === c.pred.home &&
        now.out === c.pred.out;
      if (ok) {
        lines.push(`search-check ${c.t0} +${c.h} ok`);
      } else {
        this.mismatches++;
        const f = (s: CheckSnap) => `${s.tiles}/${s.home}/${s.out}`;
        lines.push(
          `search-check ${c.t0} +${c.h} MISMATCH pred=${f(c.pred)} live=${f(now)}`,
        );
      }
    }
    this.pending = keep;
    return lines;
  }
}
