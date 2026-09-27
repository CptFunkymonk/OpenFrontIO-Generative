import type { Game, Player, PlayerID } from "../../../core/game/Game";
import type { DirectiveStep } from "../../agents/apex/state";
import type { Candidate } from "./Registry";

// Package SLICE (docs/14-m4-plan.md §2.6 "Browser"): a search spread over
// live ticks. The rounds are a generator (Rounds.roundsSteps) that yields
// between the ticks of its rollouts; the Slicer runs it until the rounds
// finish or the slice's wall time is spent, and the SearchController calls
// it once per live tick until it finishes. The slice decides only WHEN the
// work happens: the rollouts are forks of the tick the search started at
// (t0), judged against each other and priced in live-tick equivalents
// exactly as an unsliced search (Budget.ts), so the arena, whose clock is
// game time, leaves searchSliceMs 0 and replays; the browser autopilot sets
// it to keep its worker's tick short. Wall time (performance.now) is read
// here and nowhere else in the search.
//
// A plan chosen k ticks after t0 is re-based (rebasePlan): the steps of a
// plan anchored to its fork ("strike at +0", a break, an alliance request)
// shift by k, so do its foe marks' ends; a plan anchored to an event (a
// lapse's strike at the alliance's expiry, a keep's extension at its window
// and renewal after it: EVENT_KINDS) keeps its absolute ticks, and only a
// step at t0 ("now") moves to t0 + k. It is dropped when its target changed
// state materially since t0 (died, changed alliance state with us, had its
// alliance term extended, began attacking us), when one of its absolute
// steps is already past, or when a step due now has a `when` that no
// longer holds.

/** Runs a generator in slices of at most `ms` wall time. */
export class Slicer<T> {
  /** The generator's result, once it finished. */
  result: T | null = null;
  finished = false;
  /** Slices run, and the wall ms they took in all. */
  slices = 0;
  ms = 0;
  /** Yields taken (rollout ticks and forks) in all. */
  steps = 0;

  constructor(
    private readonly gen: Generator<void, T, void>,
    private readonly sliceMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /**
   * Runs until the generator finishes or `sliceMs` of wall time passed
   * (checked at each yield; a step that overruns is not cut), and returns
   * whether it finished. ms ≤ 0: runs to the end. `spentMs`: wall time this
   * slice's tick already spent before the call (the search's pre-phase),
   * counted against the slice, so a first yield right after a long
   * pre-phase ends it (review D6: the forks then take their own ticks).
   */
  run(spentMs = 0): boolean {
    if (this.finished) return true;
    const start = this.now() - spentMs;
    this.slices++;
    try {
      for (;;) {
        const r = this.gen.next();
        if (r.done) {
          this.result = r.value;
          this.finished = true;
          return true;
        }
        this.steps++;
        if (this.sliceMs > 0 && this.now() - start >= this.sliceMs) {
          return false;
        }
      }
    } finally {
      this.ms += this.now() - start - spentMs;
    }
  }
}

/** A plan target's state, read at the search (t0) and at the adoption. */
export interface TargetState {
  alive: boolean;
  allied: boolean;
  /** The alliance's expiry tick, when allied (an extension moves it). */
  expiresAt: number | null;
  /** One of its attacks is on us. */
  attacking: boolean;
}

/** `id`'s state towards `me` in `game` (a dead or unknown player: not
 *  alive, not allied, not attacking). */
export function targetState(game: Game, me: Player, id: PlayerID): TargetState {
  const none = {
    alive: false,
    allied: false,
    expiresAt: null,
    attacking: false,
  };
  if (!game.hasPlayer(id)) return none;
  const N = game.player(id);
  if (!N.isAlive()) return none;
  const al = me.allianceWith(N);
  return {
    alive: true,
    allied: al !== null,
    expiresAt: al === null ? null : al.expiresAt(),
    attacking: me.incomingAttacks().some((a) => a.attacker() === N),
  };
}

/** The plan kinds whose steps are anchored to an event, not to the fork:
 *  the lapse's strike goes at its alliance's expiry (cands/core.ts), the
 *  keep's gift, extension and renewal at the term's window and end
 *  (cands/keep.ts). Every other kind's steps count from the fork. */
export const EVENT_KINDS: ReadonlySet<string> = new Set(["lapse", "keep"]);
/** A step of an event-anchored plan due within this many ticks of the fork
 *  counts from the fork ("now": the lapse's foe mark at t0 +
 *  searchLapseFoeAt, a keep's extension asked at once); T1 fires more than
 *  300 ticks before the term, so no step at the term comes this early. */
export const NEAR_FORK = 10;

/** The steps shifted by `k` ticks: `at`, and a foe mark's `until` (so its
 *  span after the step is kept; a clearing mark stays before its step). */
export function shiftSteps(
  steps: readonly DirectiveStep[],
  k: number,
): DirectiveStep[] {
  if (k === 0) return [...steps];
  return steps.map((d) => ({
    ...d,
    at: d.at + k,
    ...(d.foe === undefined
      ? {}
      : { foe: { id: d.foe.id, until: d.foe.until + k } }),
  }));
}

/**
 * The steps of a plan of kind `kind`, made at `t0`, as adopted `k` ticks
 * later: a fork-anchored kind's steps shift by k (shiftSteps); an
 * event-anchored kind's keep their absolute ticks and marks, but a step
 * within NEAR_FORK of t0 ("now") shifts by k, and a clearing foe mark
 * (`until` before its step) stays before it. Null when a step of an
 * event-anchored plan is already past (it should have gone out during the
 * search).
 */
export function rebaseSteps(
  kind: string,
  steps: readonly DirectiveStep[],
  t0: number,
  k: number,
): DirectiveStep[] | null {
  if (!EVENT_KINDS.has(kind)) return shiftSteps(steps, k);
  const tk = t0 + k;
  const out: DirectiveStep[] = [];
  for (const d of steps) {
    const at = d.at - t0 < NEAR_FORK ? d.at + k : d.at;
    if (at < tk) return null;
    out.push({
      ...d,
      at,
      ...(d.foe === undefined || d.foe.until >= d.at
        ? {}
        : { foe: { id: d.foe.id, until: at - 1 } }),
    });
  }
  return out;
}

/**
 * The plan `cand` as adopted `k` ticks after its search at `t0`: its steps
 * re-based (rebaseSteps), or the reason it is dropped: "died", "allied",
 * "unallied", "extended", "attacked" (its target's state changed since
 * t0), "past" (an event-anchored step is already due), "window" (a step
 * due now has a `when` that does not hold live). `before`: the target's
 * state at t0 (null: no target); `now`: its state at the adoption;
 * `alliedNow`: whether we are allied with a player live (the `when` test).
 */
export function rebasePlan(
  cand: Candidate,
  t0: number,
  k: number,
  before: TargetState | null,
  now: TargetState | null,
  alliedNow: (id: PlayerID) => boolean,
): { steps: DirectiveStep[] } | { drop: string } {
  if (before !== null && now !== null) {
    if (before.alive && !now.alive) return { drop: "died" };
    if (before.allied && !now.allied) return { drop: "unallied" };
    if (!before.allied && now.allied) return { drop: "allied" };
    if (before.allied && now.allied && before.expiresAt !== now.expiresAt) {
      return { drop: "extended" };
    }
    if (!before.attacking && now.attacking) return { drop: "attacked" };
  }
  const steps = rebaseSteps(cand.kind, cand.steps, t0, k);
  if (steps === null) return { drop: "past" };
  const tk = t0 + k;
  for (const d of steps) {
    const w = d.when;
    if (w === undefined || d.at !== tk) continue;
    if (w.allied !== undefined && !alliedNow(w.allied)) {
      return { drop: "window" };
    }
    if (w.unallied !== undefined && alliedNow(w.unallied)) {
      return { drop: "window" };
    }
  }
  return { steps };
}
