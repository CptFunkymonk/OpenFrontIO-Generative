import type { Game, Player, PlayerID } from "../../../core/game/Game";
import type { AgentContext } from "../../Agent";
import type { ApexOptions } from "../../agents/apex/options";
import type { SearchHost } from "../../agents/apex/policy";
import type { DirectiveStep } from "../../agents/apex/state";
import type { HomeFloors } from "../Scheduler";
import type { WorldModel } from "../WorldModel";
import { CORE } from "./cands/core";
import type { AttackSeen } from "./Runner";
import type { DangerModel, Snap } from "./Value";

// Package WP2 (docs/14-m4-plan.md §2.4, §3 WP2): the candidate plans a
// search rolls out, and the generators that make them. A generator reads
// the live game (through the SearchView) and the base rollout, and returns
// plans as directive steps; the SearchController rolls each one out with an
// exact copy of the live policy and plays the best (Rounds.ts).
//
// To add a generator (package WP3: keep, defend, boat, rank), append it to
// GENERATORS below. Order matters: round 1's candidates are the "r1"
// generators' outputs in this order, cut to searchMaxCands. Round 2b
// ("r2b") runs after round 2 when the base rollout shows a nation attacking
// us or a loss of more than 10% of our tiles (§2.5).

/** When a generator runs: round 1 (after the base's first searchH1 ticks),
 *  or round 2b (after round 2, on the base's whole horizon). */
export type Phase = "r1" | "r2b";

/** One plan: directive steps and what the rounds need to judge it. */
export interface Candidate {
  /** Unique in the search, "<kind>:<nation>[:<frac>]" (the arena counts
   *  acts by the kind before the first ":"). */
  name: string;
  /** strike, lapse, keep, break, ally, boat, ... */
  kind: string;
  /** The nation the plan acts on (null: none). */
  target: PlayerID | null;
  /** The directive steps, at absolute live ticks (DirectiveStep). */
  steps: DirectiveStep[];
  /** Ticks after the fork of the plan's last send: its judged horizon
   *  counts from it (§2.5 round 2). */
  lastSend: number;
  /** Judged in the stepwise break round (round 3) instead of round 2. */
  isBreak: boolean;
  /** The strong-target horizon applies: the last send attacks `target`,
   *  whose troops are read at the send (searchHStrong). */
  strongCheck: boolean;
  /** Share of the purse its attack is sized by, if any (the budget's
   *  degrade drops the shares below 1 first). */
  frac?: number;
  /** Kept when the budget keeps only lapse, keep and defensive plans. */
  defensive: boolean;
  /** The stack gate (searchStackGate): the stack the plan's attack gets
   *  now, and the least stack worth sending, minimumStack(T, answer, inc,
   *  1) = T + inc. Gated-out plans go last. */
  gate?: { S: number; need: number };
}

/** The live game as a generator sees it at the search (read only). */
export interface SearchView {
  ctx: AgentContext;
  host: SearchHost;
  o: ApexOptions;
  t: number;
  game: Game;
  me: Player;
  /** The last decision's scan. */
  wm: WorldModel;
  floors: HomeFloors;
  /** searchKinds, after the budget's degrade. */
  kinds: ReadonlySet<string>;
}

/** The base rollout as a generator sees it. */
export interface BaseView {
  /** Ticks advanced: searchH1 in round 1, its longest horizon in 2b. */
  h: number;
  /** Nations whose attacks reached us so far, first attack first. */
  attackers: ReadonlyMap<PlayerID, AttackSeen>;
  snaps: readonly Snap[];
}

export interface CandidateGenerator {
  readonly name: string;
  readonly phase: Phase;
  /** Kinds it makes; it runs only if searchKinds has one of them. */
  readonly kinds: readonly string[];
  generate(sv: SearchView, base: BaseView): Candidate[];
  /** Trigger T6 (naval, §2.3): whether this generator has a plan across
   *  the water now (e.g. a nation within searchBoatMaxVoyage); asked only
   *  while no nation borders us and home idles near the cap. */
  wantsNaval?(ctx: AgentContext, host: SearchHost): boolean;
}

/** Every generator, in candidate order. */
export const GENERATORS: readonly CandidateGenerator[] = [CORE];

/** Package WP4's danger terms (Danger.ts), once built: V subtracts
 *  λ·D when searchDangerNow or searchDangerCap is set. Null: the terms are
 *  0 (and a λ > 0 is refused by the SearchController). */
export const DANGER: DangerModel | null = null;

/** The generators of `phase` that make one of `kinds`. */
export function generatorsFor(
  phase: Phase,
  kinds: ReadonlySet<string>,
  all: readonly CandidateGenerator[] = GENERATORS,
): CandidateGenerator[] {
  return all.filter(
    (g) => g.phase === phase && g.kinds.some((k) => kinds.has(k)),
  );
}

/**
 * Round 1's candidates: every generator's, in order, names made unique
 * (the first kept), gated-out strikes moved last when `stackGate`, cut to
 * `max`.
 */
export function roundOneCandidates(
  lists: readonly Candidate[][],
  stackGate: boolean,
  max: number,
): Candidate[] {
  const seen = new Set<string>();
  const all: Candidate[] = [];
  for (const list of lists) {
    for (const c of list) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      all.push(c);
    }
  }
  const ordered = stackGate
    ? [
        ...all.filter((c) => c.gate === undefined || c.gate.S >= c.gate.need),
        ...all.filter((c) => c.gate !== undefined && c.gate.S < c.gate.need),
      ]
    : all;
  return ordered.slice(0, Math.max(0, max));
}
