import { Game, Player } from "../../core/game/Game";
import { ClientID } from "../../core/Schemas";
import { AgentContext, AgentIntent, IntentBudgetRemaining } from "../Agent";
import { GameFork } from "../Fork";

// Forks, idle future, rollouts, BudgetMirror and the value function
// (spec §2.8).
//
// Budget rules:
// - The spawn search is exempt from `msPer10s` but capped by `wallBudgetMs`.
// - Every other fork counts against `msPer10s` (default 1,000 ms per 10 s,
//   roadmap §11.4). Wall time only decides whether a fork is refused. A
//   refused fork falls back to the rule, never to waiting.
// - In the arena the refusal depends on wall time, so `strikeFork` and
//   `allyOracle` default to off for reproducible A/B runs.

export interface SimView {
  game: Game;
  me: Player;
  tick: number;
  gameID: string;
  budget: BudgetMirror;
}

export interface RolloutPolicy {
  /** Intents for the next fork step. Pure given (view, internal state). */
  step(v: SimView): AgentIntent[];
}

/** IntentBudget semantics (IntervalLimiter ×2) on the fork clock tick×100 ms. */
export class BudgetMirror {
  static fromLive(
    remaining: IntentBudgetRemaining,
    nowMs: number,
  ): BudgetMirror {
    // TODO(spec §2.8): implement.
    throw new Error("not implemented: BudgetMirror.fromLive");
  }

  remaining(nowMs: number): IntentBudgetRemaining {
    throw new Error("not implemented: BudgetMirror.remaining");
  }

  tryConsume(nowMs: number): boolean {
    throw new Error("not implemented: BudgetMirror.tryConsume");
  }

  clone(): BudgetMirror {
    throw new Error("not implemented: BudgetMirror.clone");
  }
}

export interface RolloutResult {
  ticks: number;
  alive: boolean;
  tiles: number;
  home: number;
  outgoing: number;
  incomingNation: number;
  ms: number;
}

/** The Lookahead's options (ApexOptions.forkMsPer10s and
 *  ApexOptions.spawnWallBudgetMs). */
export interface LookaheadOptions {
  msPer10s: number;
  wallBudgetMs: number;
}

export class Lookahead {
  constructor(o: LookaheadOptions) {
    // TODO(spec §2.8, §3.2.5): implement (§4 step 8).
    throw new Error("not implemented: Lookahead");
  }

  /** Refuses (null) when over budget. Must be called before any ctx.send
   *  this tick, or `replay` must hold what was sent (Ledger.sentThisTick()). */
  fork(ctx: AgentContext, replay: readonly AgentIntent[]): GameFork | null {
    throw new Error("not implemented: Lookahead.fork");
  }

  /** Spawn phase: ends the phase on the fork (fork.game.endSpawnPhase(); the
   *  fork only), steps `ticks`, and calls sample every `every` ticks. */
  idleFuture(
    f: GameFork,
    ticks: number,
    every: number,
    sample: (g: Game, t: number) => void,
  ): void {
    throw new Error("not implemented: Lookahead.idleFuture");
  }

  rollout(
    f: GameFork,
    clientID: ClientID,
    policy: RolloutPolicy,
    ticks: number,
    inject?: Map<number, AgentIntent[]>,
  ): RolloutResult {
    throw new Error("not implemented: Lookahead.rollout");
  }
}

/** V = tiles + β·(home+outgoing)/c̄ − α·incomingNation/c̄; −Infinity if dead. */
export function value(
  r: RolloutResult,
  cbar: number,
  beta = 0.5,
  alpha = 0.5,
): number {
  throw new Error("not implemented: value");
}
