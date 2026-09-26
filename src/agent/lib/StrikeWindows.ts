// Strike windows on a nation and the stack a strike needs (spec §5.2.2-3,
// docs/13-mechanics.md §2.8, §5.3, §5.7-5.8). Pure functions over plain
// numbers, so each window is unit-tested on constructed values
// (tests/agent/apex/StrikeWindows.test.ts); the StrikeController reads the
// numbers from NationModel and the game.
//
// The mechanics every rule here rests on [PIN NationRetaliate]:
// - A nation decides only at ticks with tick % rate == phase, and an attack
//   of ours that inits after its decision d is first seen at its next one.
// - At a decision it answers the largest single non-tribe attack on it with
//   min(T − reserve·M, max(T − ceil(0.9·H), sum of incoming)), where the
//   incoming sum includes our stack S. So once S > T − reserve·M the answer
//   is exactly T − reserve·M: it cancels that much of our stack 1:1 at init
//   and nothing lands on us; below it our stack is deleted whole and the
//   rest of the answer attacks us.
// - Below reserve·M it never answers (the gate returns before the list);
//   below trigger·M it runs the list 1 decision in 10; a free-land send that
//   succeeds (or a structure tribe) ends its decision first (gates "locked").
// Cheapest conquest [PIN PlayerAttackSpeed]: the attacker's loss per tile is
// flat for a troop ratio r = defender/stack ≤ 0.6, so after the answer the
// stack should be ≥ (T − answer)/0.6.

/** A window that lets a strike go (spec §5.2.2; W4 was dropped):
 *  - W1: troops at its first decision after the launch below reserve·M;
 *  - W2: that decision is locked (free land or a structure tribe first);
 *  - W3: below trigger·M there (answers about 1 decision in 10);
 *  - W5 vulture: hit hard by others (troops down, very weak, or attacked
 *    by more than half its troops);
 *  - W6 decoy: another player's single attack on it is larger than ours
 *    will be, so it answers that one;
 *  - overwhelm: our stack is larger than any answer it can send. */
export type StrikeWindowName = "W1" | "W2" | "W3" | "W5" | "W6" | "overwhelm";

export const STRIKE_WINDOW_NAMES: readonly StrikeWindowName[] = [
  "W1",
  "W2",
  "W3",
  "W5",
  "W6",
  "overwhelm",
];

/** Windows with no answer to us at the first decision (the stack needs no
 *  room for one). */
const NO_ANSWER: ReadonlySet<StrikeWindowName> = new Set(["W1", "W2", "W6"]);

/** What a window check reads about nation N. Troops and caps in troops,
 *  ratios as shares of its cap. */
export interface WindowInput {
  /** Its reserve and trigger ratios (NationModel.params). */
  reserve: number;
  trigger: number;
  /** Its cap M. */
  M: number;
  /** Troops now. */
  T: number;
  /** troopsAt(N, d1): troops at its first decision after a launch now
   *  (regrowth only; our attack only lowers it). */
  T1: number;
  /** gates(N, d1) === "locked". */
  locked1: boolean;
  /** Its troops at an earlier sample (its previous decision), or null. */
  Tprev: number | null;
  /** Troops of every attack on it now but ours (tribes' included). */
  incomingOthers: number;
  /** The largest single attack on it now by a player that its retaliate
   *  would pick over us: not a tribe, not us, not friendly with it. */
  largestOther: number;
}

/** The window thresholds (ApexOptions, package A1). */
export interface WindowOptions {
  /** Windows in use. */
  windows: readonly StrikeWindowName[];
  /** W5: troops down by this share since the previous sample ... */
  vultureDrop: number;
  /** ... or below this share of its cap ... */
  vultureLow: number;
  /** ... or incoming attacks above this share of its troops. */
  vultureIncoming: number;
  /** W6: another attack must be this many times our stack. */
  decoyMargin: number;
}

/** The windows that hold for a strike of S troops. */
export interface WindowVerdict {
  /** Every enabled window that holds. */
  open: StrikeWindowName[];
  /** The one the strike is sized by: the first open no-answer window, else
   *  the first open one; null if none holds. */
  window: StrikeWindowName | null;
  /** The answer the stack must survive at the first decision: 0 in a
   *  no-answer window, else retaliationBound(T1). */
  answer: number;
}

/** The most a nation with T troops can send back at a strike that exceeds
 *  it: T − reserve·M (0 below its reserve). */
export function retaliationBound(T: number, reserve: number, M: number) {
  return Math.max(0, T - reserve * M);
}

/** W5's test on the numbers (enabled or not). */
export function isVulture(inp: WindowInput, o: WindowOptions): boolean {
  if (inp.T < o.vultureLow * inp.M) return true;
  if (inp.incomingOthers > o.vultureIncoming * inp.T) return true;
  return (
    inp.Tprev !== null &&
    inp.Tprev > 0 &&
    inp.T <= (1 - o.vultureDrop) * inp.Tprev
  );
}

/**
 * The enabled windows that hold for a strike of S troops launched now (it
 * inits after the nation's last decision, so d1 is the first decision that
 * sees it).
 */
export function strikeWindows(
  inp: WindowInput,
  S: number,
  o: WindowOptions,
): WindowVerdict {
  const on = new Set(o.windows);
  const bound = retaliationBound(inp.T1, inp.reserve, inp.M);
  const holds: Record<StrikeWindowName, boolean> = {
    W1: inp.T1 < inp.reserve * inp.M,
    W2: inp.locked1,
    W3: inp.T1 < inp.trigger * inp.M,
    W5: isVulture(inp, o),
    W6: S > 0 && inp.largestOther >= o.decoyMargin * S,
    overwhelm: S > bound,
  };
  const open = STRIKE_WINDOW_NAMES.filter((w) => on.has(w) && holds[w]);
  const quiet = open.find((w) => NO_ANSWER.has(w));
  const window = quiet ?? open[0] ?? null;
  return { open, window, answer: quiet !== undefined ? 0 : bound };
}

/**
 * The stack for the fastest cheapest conquest of a nation with T troops
 * that answers `answer` at its next decision: the answer cancels 1:1, and
 * what is left must be (T − answer)/ratio, times margin for its regrowth
 * and our drift. Plus the troops of its attacks on us, which our new attack
 * cancels 1:1 at init [PIN AttackMerge].
 */
export function conquestStack(
  T: number,
  answer: number,
  incomingFromIt: number,
  o: { ratio: number; margin: number },
): number {
  const a = Math.min(Math.max(0, answer), T);
  return a + ((T - a) / o.ratio) * o.margin + Math.max(0, incomingFromIt);
}

/**
 * The smallest stack worth sending: after the answer and the cancel of its
 * attacks on us, at most maxRatio of its troops to ours (above about 0.82 an
 * attack slows, above 0.6 each tile costs more [PIN PlayerAttackSpeed]).
 */
export function minimumStack(
  T: number,
  answer: number,
  incomingFromIt: number,
  maxRatio: number,
): number {
  const a = Math.min(Math.max(0, answer), T);
  return a + (T - a) / maxRatio + Math.max(0, incomingFromIt);
}

/** A strike decision: the stack, and why. */
export interface StrikePlan {
  /** Troops to send (0: no strike). */
  S: number;
  verdict: WindowVerdict;
  /** The stack wanted and the smallest one accepted. */
  want: number;
  min: number;
}

/** planStrike's options (ApexOptions, package A1). */
export interface StrikeSizing extends WindowOptions {
  /** Ratio the stack is sized for (0.6: the cheapest per tile). */
  ratio: number;
  /** Margin on that stack. */
  margin: number;
  /** Worst ratio a purse-limited stack may start at. */
  maxRatio: number;
}

/**
 * Sizes a strike under `budget` and checks its windows. The stack wanted is
 * the conquest stack with no answer (its whole T1 at the ratio: an answer
 * only makes it go further, since it cancels 1:1 and leaves the nation
 * weaker), and at least the kill cost when one is given (the loss of every
 * tile it pays for, times the margin, on top of the answer the window
 * leaves room for). It sends min(want, budget) if that holds an enabled
 * window and is at least the minimum stack for that window's answer; else
 * S = 0.
 */
export function planStrike(
  inp: WindowInput,
  incomingFromIt: number,
  budget: number,
  o: StrikeSizing,
  killCost = 0,
): StrikePlan {
  const conquest = conquestStack(inp.T1, 0, incomingFromIt, o);
  const bound = retaliationBound(inp.T1, inp.reserve, inp.M);
  const kill =
    killCost > 0
      ? bound + Math.max(0, incomingFromIt) + killCost * o.margin
      : 0;
  const want = Math.max(conquest, kill);
  const S = Math.floor(Math.min(want, budget));
  const verdict = strikeWindows(inp, Math.max(0, S), o);
  const min = minimumStack(inp.T1, verdict.answer, incomingFromIt, o.maxRatio);
  // The stack must beat the answer once the cancel of its attacks on us is
  // paid (else it is deleted whole and the rest of the answer lands).
  const beats = S - Math.max(0, incomingFromIt) > verdict.answer;
  const go = S >= 1 && verdict.window !== null && S >= min && beats;
  return { S: go ? S : 0, verdict, want, min };
}

/** What a strike expects to buy (package A1, o.strikeReachModel). */
export interface StrikeYield {
  /** It takes every tile it pays for: the target dies and its gold is ours. */
  kill: boolean;
  /** The land it can reach runs out first (an island or an enclave of the
   *  target, land behind a third party): the frontier empties, and the rest
   *  of the stack comes home. */
  pocket: boolean;
  /** Tiles expected. */
  tiles: number;
  /** Troops expected spent: the tiles' losses and the 1:1 cancel of the
   *  answer and of its attacks on us when the rest comes home (kill,
   *  pocket); the whole stack when it burns out. */
  spent: number;
  /** Troops expected home. */
  refund: number;
}

/**
 * The yield of a stack `S` on a nation of `tiles` tiles, `reach` of them
 * reachable by land from our border (Infinity: at least what the stack can
 * pay for), `left` = S − answer − its attacks on us after the 1:1 cancels
 * (the answer assumed, as the stack is sized), at `p` troops lost per tile
 * (at the stack's real ratio then):
 * - kill: all but the `killFree` tiles of the annex line are reachable and
 *   `left` pays for them [PIN TribeStats: the last 99 fall with the one that
 *   takes it under 100];
 * - pocket: fewer tiles reachable than `left` pays for: it takes them, and
 *   the rest comes home when the frontier empties (AttackExecution.ts
 *   :302-305; arena quick@20: 29 of 42 strikes ended so, most far short of
 *   the target's size);
 * - else it burns out after left/p tiles.
 * A kill or a pocket spends its tiles' losses and `expectedCancel`, the
 * cancels expected (default S − left, the answer for certain; below its
 * trigger a nation answers 1 decision in 10), and the rest comes home.
 */
export function strikeYield(
  S: number,
  left: number,
  p: number,
  tiles: number,
  reach: number,
  killFree: number,
  expectedCancel: number = S - left,
): StrikeYield {
  const none = { kill: false, pocket: false, tiles: 0, spent: S, refund: 0 };
  if (!(left > 0) || !(p > 0)) return none;
  const cancel = Math.min(Math.max(0, expectedCancel), S);
  const need = Math.max(0, tiles - killFree);
  if (reach >= need && left >= p * need) {
    const cost = p * need;
    return {
      kill: true,
      pocket: false,
      tiles,
      spent: cost + cancel,
      refund: S - cancel - cost,
    };
  }
  const afford = left / p;
  if (reach < afford) {
    const cost = p * reach;
    return {
      kill: false,
      pocket: true,
      tiles: reach,
      spent: cost + cancel,
      refund: S - cancel - cost,
    };
  }
  return {
    kill: false,
    pocket: false,
    tiles: Math.min(tiles, afford),
    spent: S,
    refund: 0,
  };
}

/**
 * The loss per tile over a front of which `cover` (0..1) lies within range
 * of the defender's finished defense posts, as a factor of the post-free
 * loss: tiles in range cost `bonus` times as much
 * (Config.defensePostDefenseBonus, 5) [chapter 13 §5.3]. They also fall
 * defensePostSpeedBonus (3) times slower, which this leaves out.
 */
export function postLossFactor(cover: number, bonus: number): number {
  const c = Math.min(1, Math.max(0, cover));
  return 1 + (bonus - 1) * c;
}

/** A running strike as its d + 1 review reads it. */
export interface StrikeReview {
  /** Share of the front within range of its finished defense posts. */
  cover: number;
  /** Its troops now, and our live stack on it. */
  T: number;
  A: number;
  /** The stack can still take every tile (the kill, all its gold). */
  kill: boolean;
}

/**
 * Why a running strike should be called back one tick after the target's
 * decision, or null (package A1, o.strikeRetreat). Called back then, the
 * retreat (20 ticks, RetreatExecution) ends before its next decision (rate
 * ≥ 30 ticks), so no answer can cancel the retreating stack, and 75% of it
 * comes home [PIN AttackMerge: 25% malus against a player]. Never while the
 * stack can still kill. Else when defense posts cover postCover of the
 * front (spec §5.2.3: every tile there costs ×5, ×3 slower), or when the
 * target holds `ratio` times our live stack (each tile costs up to 3.3×
 * the cheapest, and its next answer may delete the stack whole).
 */
export function retreatReason(
  r: StrikeReview,
  o: { postCover: number; ratio: number },
): "posts" | "ratio" | null {
  if (r.kill || !(r.A > 0)) return null;
  if (r.cover >= o.postCover) return "posts";
  if (r.T >= o.ratio * r.A) return "ratio";
  return null;
}

/** A top-up the StrikeController weighs before the target's decision. */
export interface TopUpCase {
  /** Our live stack, the top-up, and the conquest stack wanted. */
  A: number;
  add: number;
  need: number;
  /** Its troops and its answer at that decision, its attacks on us. */
  Td: number;
  answer: number;
  inc: number;
}

/**
 * Why a top-up goes, or null (StrikeController.topUps):
 * - "ratio": it restores a ratio of at most maxRatio after the answer
 *   (beyond it each tile costs up to 3.3× the cheapest [PIN
 *   PlayerAttackSpeed]) and is at least minShare of the shortfall;
 * - "save": the answer would delete the stack whole (the rest of it lands
 *   on us) and the top-up lifts the stack above it. With saveOpenOnly only
 *   where the answer is certain (`open`: above its trigger; below it the
 *   list runs 1 decision in 10 [PIN NationRetaliate]) and only to a stack
 *   within maxRatio or able to kill (`canKill`, asked last): else the save
 *   buys an attack that burns out (review of A1: 8 of 42 top-ups, all below
 *   trigger, left stacks at ratio 1.8-20).
 */
export function topUpReason(
  t: TopUpCase,
  o: { maxRatio: number; minShare: number; saveOpenOnly: boolean },
  open: boolean,
  canKill: () => boolean,
): "ratio" | "save" | null {
  const within = t.A + t.add >= minimumStack(t.Td, t.answer, t.inc, o.maxRatio);
  if (within && t.add >= o.minShare * (t.need - t.A)) return "ratio";
  const saves = t.A - t.inc <= t.answer && t.A + t.add - t.inc > t.answer;
  if (!saves) return null;
  if (!o.saveOpenOnly) return "save";
  return open && (within || canKill()) ? "save" : null;
}

/**
 * The top-up of a running strike of A troops before the nation's next
 * decision, where it holds Td troops and answers `answer` (0 in a no-answer
 * window): the conquest stack for that answer, if A is below topUpAt of it.
 * At most `budget`; 0 when none is due.
 */
export function strikeTopUp(
  A: number,
  Td: number,
  answer: number,
  incomingFromIt: number,
  budget: number,
  o: { ratio: number; margin: number; topUpAt: number },
): number {
  const need = conquestStack(Td, answer, incomingFromIt, o);
  if (A >= o.topUpAt * need) return 0;
  return Math.max(0, Math.floor(Math.min(need - A, budget)));
}
