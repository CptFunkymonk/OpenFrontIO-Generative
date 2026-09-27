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
// A plan chosen k ticks after t0 is re-based (rebasePlan): its steps'
// absolute ticks shift by k ("strike at +0" adopted at t0 + k means send
// now), so do its foe marks' ends; it is dropped when its target changed
// state materially since t0 (died, changed alliance state with us, began
// attacking us) or when its first step's `when` no longer holds.

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
   * whether it finished. ms ≤ 0: runs to the end.
   */
  run(): boolean {
    if (this.finished) return true;
    const start = this.now();
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
      this.ms += this.now() - start;
    }
  }
}

/** A plan target's state, read at the search (t0) and at the adoption. */
export interface TargetState {
  alive: boolean;
  allied: boolean;
  /** One of its attacks is on us. */
  attacking: boolean;
}

/** `id`'s state towards `me` in `game` (a dead or unknown player: not
 *  alive, not allied, not attacking). */
export function targetState(
  game: Game,
  me: Player,
  id: PlayerID,
): TargetState {
  if (!game.hasPlayer(id)) {
    return { alive: false, allied: false, attacking: false };
  }
  const N = game.player(id);
  if (!N.isAlive()) return { alive: false, allied: false, attacking: false };
  return {
    alive: true,
    allied: me.isAlliedWith(N),
    attacking: me.incomingAttacks().some((a) => a.attacker() === N),
  };
}

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
 * The plan `cand` as adopted `k` ticks after its search: its steps shifted
 * by k, or the reason it is dropped ("died", "allied", "unallied",
 * "attacked": its target's state changed since t0; "window": its first
 * step's `when` no longer holds live). `before`: the target's state at t0
 * (null: no target); `now`: its state at the adoption; `alliedNow`:
 * whether we are allied with a player live (the `when` test).
 */
export function rebasePlan(
  cand: Candidate,
  k: number,
  before: TargetState | null,
  now: TargetState | null,
  alliedNow: (id: PlayerID) => boolean,
): { steps: DirectiveStep[] } | { drop: string } {
  if (before !== null && now !== null) {
    if (before.alive && !now.alive) return { drop: "died" };
    if (before.allied && !now.allied) return { drop: "unallied" };
    if (!before.allied && now.allied) return { drop: "allied" };
    if (!before.attacking && now.attacking) return { drop: "attacked" };
  }
  const first = cand.steps[0];
  const w = first?.when;
  if (w !== undefined) {
    if (w.allied !== undefined && !alliedNow(w.allied)) {
      return { drop: "window" };
    }
    if (w.unallied !== undefined && alliedNow(w.unallied)) {
      return { drop: "window" };
    }
  }
  return { steps: shiftSteps(cand.steps, k) };
}
