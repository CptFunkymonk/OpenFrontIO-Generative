import { Game, Player, PlayerType, UnitType } from "../../core/game/Game";
import { ClientID, IntentSchema } from "../../core/Schemas";
import {
  AgentContext,
  AgentIntent,
  IntentBudgetRemaining,
  IntentBudgetState,
  LimiterState,
} from "../Agent";
import { GameFork } from "../Fork";
import {
  FORBIDDEN_INTENTS,
  INTENTS_PER_MINUTE,
  INTENTS_PER_SECOND,
  MAX_INTENT_BYTES,
} from "../IntentBudget";

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
//
// Wall time (performance.now) is read here and only here (spec §2.1): it
// decides whether a fork is refused, never what a rollout does.

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

/**
 * One interval of the server's RateLimiter, as IntentBudget's private
 * IntervalLimiter implements it: a token bucket (capacity N, refilled
 * continuously at N per interval) plus a fixed window of at most N removals,
 * restarted by the first call at least one interval after it began.
 */
class Limiter {
  constructor(
    readonly perInterval: number,
    readonly intervalMs: number,
    private content: number,
    private lastDripMs: number,
    private windowStartMs: number,
    private usedInWindow: number,
  ) {}

  private advance(nowMs: number): void {
    if (
      nowMs < this.windowStartMs ||
      nowMs - this.windowStartMs >= this.intervalMs
    ) {
      this.windowStartMs = nowMs;
      this.usedInWindow = 0;
    }
    const elapsed = nowMs - this.lastDripMs;
    if (elapsed > 0) {
      this.content = Math.min(
        this.perInterval,
        this.content + (elapsed * this.perInterval) / this.intervalMs,
      );
    }
    this.lastDripMs = nowMs;
  }

  available(nowMs: number): number {
    this.advance(nowMs);
    return Math.max(
      0,
      Math.min(Math.floor(this.content), this.perInterval - this.usedInWindow),
    );
  }

  take(): void {
    this.content -= 1;
    this.usedInWindow += 1;
  }

  clone(): Limiter {
    return new Limiter(
      this.perInterval,
      this.intervalMs,
      this.content,
      this.lastDripMs,
      this.windowStartMs,
      this.usedInWindow,
    );
  }
}

/**
 * IntentBudget semantics (IntervalLimiter ×2) on the fork clock tick×100 ms.
 *
 * Exact (package WP1, docs/14-m4-plan.md §2.2) when built from the live
 * limiters' state (`fromLive(remaining, now, state)`, `fromContext`): the
 * mirror starts as the live budget is, times moved onto the fork clock, so
 * a rollout's sends are limited exactly as the live policy's would be.
 * Without the state (a context that does not expose it), `fromLive`
 * assumes both windows began at `now` and that every intent missing from
 * each limit was spent in them: the mirror never grants more than the live
 * budget in its first second and minute, but can grant less than it later
 * (a window the live limiter restarts sooner). Built from a full budget it
 * is exactly a new IntentBudget created at `now`. A non-finite `remaining`
 * or a null state (rate limiting off) gives a mirror without limits.
 */
export class BudgetMirror {
  private constructor(
    private readonly perSecond: Limiter | null,
    private readonly perMinute: Limiter | null,
  ) {}

  /** The live budget of `ctx` at its tick, on the fork clock (tick ×
   *  msPerTick): exact when the context exposes budgetState. */
  static fromContext(ctx: AgentContext): BudgetMirror {
    const nowMs = ctx.tick * ctx.game.config().msPerTick();
    const remaining = ctx.budget();
    const state = ctx.budgetState?.();
    return BudgetMirror.fromLive(remaining, nowMs, state);
  }

  /** `state` (IntentBudget.state(), as AgentContext.budgetState returns
   *  it): null means rate limiting is off; undefined means unknown, and
   *  the mirror is built from `remaining` alone. */
  static fromLive(
    remaining: IntentBudgetRemaining,
    nowMs: number,
    state?: IntentBudgetState | null,
  ): BudgetMirror {
    if (state === null) return new BudgetMirror(null, null);
    if (state !== undefined) {
      // The live clock's reading maps to `nowMs` on the fork clock (the
      // same in the arena, where both count game time).
      const shift = nowMs - state.nowMs;
      const exact = (n: number, intervalMs: number, l: LimiterState) =>
        new Limiter(
          n,
          intervalMs,
          l.content,
          l.lastDripMs + shift,
          l.windowStartMs + shift,
          l.usedInWindow,
        );
      return new BudgetMirror(
        exact(INTENTS_PER_SECOND, 1000, state.perSecond),
        exact(INTENTS_PER_MINUTE, 60_000, state.perMinute),
      );
    }
    if (!isFinite(remaining.perSecond) || !isFinite(remaining.perMinute)) {
      return new BudgetMirror(null, null);
    }
    const limiter = (n: number, intervalMs: number, left: number) => {
      const r = Math.max(0, Math.min(n, Math.floor(left)));
      return new Limiter(n, intervalMs, r, nowMs, nowMs, n - r);
    };
    return new BudgetMirror(
      limiter(INTENTS_PER_SECOND, 1000, remaining.perSecond),
      limiter(INTENTS_PER_MINUTE, 60_000, remaining.perMinute),
    );
  }

  remaining(nowMs: number): IntentBudgetRemaining {
    if (this.perSecond === null || this.perMinute === null) {
      return { perSecond: Infinity, perMinute: Infinity };
    }
    return {
      perSecond: this.perSecond.available(nowMs),
      perMinute: this.perMinute.available(nowMs),
    };
  }

  /** Consumes one intent's worth of budget if both limits allow it. */
  tryConsume(nowMs: number): boolean {
    if (this.perSecond === null || this.perMinute === null) return true;
    const { perSecond, perMinute } = this.remaining(nowMs);
    if (perSecond < 1 || perMinute < 1) return false;
    this.perSecond.take();
    this.perMinute.take();
    return true;
  }

  clone(): BudgetMirror {
    return new BudgetMirror(
      this.perSecond?.clone() ?? null,
      this.perMinute?.clone() ?? null,
    );
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

/** Game time over which `msPer10s` is counted. */
const WINDOW_MS = 10_000;

/** What a fork made by Lookahead.fork carries. */
interface ForkInfo {
  /** Taken in the spawn phase: charged to the spawn search's budget. */
  spawn: boolean;
  /** The live tick of the fork. */
  tick: number;
  gameID: string;
  /** The live budget at the fork, on the fork clock. Rollouts spend it. */
  budget: BudgetMirror;
}

export class Lookahead {
  private readonly info = new WeakMap<GameFork, ForkInfo>();
  /** Wall ms spent on spawn-phase forks. */
  private spawnSpent = 0;
  /** Wall ms spent on other forks, by the live tick they were charged at. */
  private charges: { tick: number; ms: number }[] = [];
  /** ctx.fork() threw (no TerrainSource): refuse from then on. */
  private unavailable = false;

  constructor(private readonly o: LookaheadOptions) {}

  /** Wall ms spent in the spawn search so far. */
  spawnMs(): number {
    return this.spawnSpent;
  }

  /** Wall ms charged to msPer10s over the 10 s of game time up to `tick`. */
  recentMs(game: Game, tick: number): number {
    this.prune(game, tick);
    let ms = 0;
    for (const c of this.charges) ms += c.ms;
    return ms;
  }

  /** Whether fork() would be allowed now (budget only). */
  canFork(ctx: AgentContext): boolean {
    if (this.unavailable) return false;
    if (ctx.game.inSpawnPhase()) return this.spawnSpent < this.o.wallBudgetMs;
    return this.recentMs(ctx.game, ctx.tick) < this.o.msPer10s;
  }

  /** Refuses (null) when over budget. Must be called before any ctx.send
   *  this tick, or `replay` must hold what was sent (Ledger.sentThisTick()).
   *  The replay goes into the fork's first step, ahead of what that step is
   *  given (the arena's latency of 1 turn: an intent sent at ctx.tick = T
   *  runs in turn T, the fork's first); forks branched from it before that
   *  step get it too (GameFork.replay, branch). */
  fork(ctx: AgentContext, replay: readonly AgentIntent[]): GameFork | null {
    if (!this.canFork(ctx)) return null;
    const spawn = ctx.game.inSpawnPhase();
    const start = performance.now();
    let f: GameFork;
    try {
      f = ctx.fork();
    } catch (e) {
      this.unavailable = true;
      ctx.log(`lookahead: fork failed, forks off: ${String(e)}`);
      return null;
    }
    f.replay(replay);
    this.info.set(f, {
      spawn,
      tick: ctx.tick,
      gameID: ctx.gameID,
      budget: BudgetMirror.fromContext(ctx),
    });
    this.charge(f, performance.now() - start);
    return f;
  }

  /**
   * `n` forks of this tick: one fork (as `fork`), and `n - 1` branched from
   * it (`branch`). Null when `fork` refuses.
   */
  forkMany(
    ctx: AgentContext,
    replay: readonly AgentIntent[],
    n: number,
  ): GameFork[] | null {
    const f = this.fork(ctx, replay);
    if (f === null) return null;
    return n <= 1 ? [f] : [f, ...this.branch(f, n - 1)];
  }

  /**
   * `n` forks of `f` as it is now (GameFork.clones: the replay it still has
   * queued included), each registered as `f` is, with its own copy of `f`'s
   * budget as spent so far, so they roll out like `f` would from here. The
   * time is charged as `f`'s.
   */
  branch(f: GameFork, n: number): GameFork[] {
    const info = this.info.get(f);
    if (info === undefined) {
      throw new Error("Lookahead.branch: the fork was not made by fork()");
    }
    const start = performance.now();
    const out = f.clones(n);
    for (const c of out) {
      this.info.set(c, { ...info, budget: info.budget.clone() });
    }
    this.charge(f, performance.now() - start);
    return out;
  }

  /** Spawn phase: ends the phase on the fork (fork.game.endSpawnPhase(); the
   *  fork only), steps `ticks`, and calls sample every `every` ticks. The
   *  first call is at t = 0, before any step; t counts the ticks stepped. */
  idleFuture(
    f: GameFork,
    ticks: number,
    every: number,
    sample: (g: Game, t: number) => void,
  ): void {
    const start = performance.now();
    try {
      if (f.game.inSpawnPhase()) f.game.endSpawnPhase();
      sample(f.game, 0);
      for (let t = 1; t <= ticks; t++) {
        f.step();
        if (every > 0 && t % every === 0) sample(f.game, t);
      }
    } finally {
      this.charge(f, performance.now() - start);
    }
  }

  /**
   * Steps the fork `ticks` times with `policy` playing `clientID`: each step
   * sends inject.get(turn) (keyed by the fork's game tick before the step,
   * which is the turn they run in; not charged to the budget), then what the
   * policy returns, dropping invalid intents as AgentHost does. The policy's
   * sends spend the fork's BudgetMirror (SimView.budget). Stops early once
   * the player has spawned and died.
   */
  rollout(
    f: GameFork,
    clientID: ClientID,
    policy: RolloutPolicy,
    ticks: number,
    inject?: Map<number, AgentIntent[]>,
  ): RolloutResult {
    const info = this.info.get(f);
    if (info === undefined) {
      throw new Error("Lookahead.rollout: the fork was not made by fork()");
    }
    const start = performance.now();
    const me = f.game.playerByClientID(clientID);
    if (me === null) throw new Error(`no player with clientID ${clientID}`);
    let n = 0;
    try {
      while (n < ticks) {
        if (me.hasSpawned() && !me.isAlive()) break;
        const g = f.game;
        const tick = g.ticks();
        const view: SimView = {
          game: g,
          me,
          tick,
          gameID: info.gameID,
          budget: info.budget,
        };
        const intents = [...(inject?.get(tick) ?? []), ...policy.step(view)];
        f.step(intents.filter(isValidIntent));
        n++;
      }
    } finally {
      this.charge(f, performance.now() - start);
    }
    return { ...measure(me), ticks: n, ms: performance.now() - start };
  }

  private charge(f: GameFork, ms: number): void {
    const info = this.info.get(f);
    // fork() charges after registering; an unknown fork is charged as play.
    if (info?.spawn === true) {
      this.spawnSpent += ms;
      return;
    }
    this.charges.push({ tick: info?.tick ?? 0, ms });
  }

  private prune(game: Game, tick: number): void {
    const window = WINDOW_MS / game.config().msPerTick();
    this.charges = this.charges.filter((c) => c.tick > tick - window);
  }
}

/** AgentHost.isValid: not a forbidden type, the wire schema and the size
 *  bound. AgentHost refuses such an intent before it touches the budget, so
 *  a rollout's sends must too (ApexPolicy's rollout step does). */
export function isValidIntent(intent: AgentIntent): boolean {
  return (
    !FORBIDDEN_INTENTS.has((intent as { type: string }).type) &&
    IntentSchema.safeParse(intent).success &&
    JSON.stringify(intent).length <= MAX_INTENT_BYTES
  );
}

/**
 * Package WP1: one rollout tick, as Lookahead.rollout steps it. `policy`
 * plays `me` (the fork's player) at the fork's tick, its sends limited by
 * `budget` on the fork clock; the valid intents it returns are what the
 * fork's next step is given, as AgentHost would deliver them at latency 1.
 * Returns those intents.
 */
export function stepRollout(
  f: GameFork,
  me: Player,
  gameID: string,
  policy: RolloutPolicy,
  budget: BudgetMirror,
): AgentIntent[] {
  const g = f.game;
  const view: SimView = { game: g, me, tick: g.ticks(), gameID, budget };
  const intents = policy.step(view).filter(isValidIntent);
  f.step(intents);
  return intents;
}

/** The result fields read from the player at the end of a rollout. */
function measure(me: Player): Omit<RolloutResult, "ticks" | "ms"> {
  let outgoing = 0;
  for (const a of me.outgoingAttacks()) outgoing += a.troops();
  for (const u of me.units(UnitType.TransportShip)) outgoing += u.troops();
  let incomingNation = 0;
  for (const a of me.incomingAttacks()) {
    if (a.attacker().type() !== PlayerType.Bot) incomingNation += a.troops();
  }
  return {
    alive: me.isAlive(),
    tiles: me.numTilesOwned(),
    home: me.troops(),
    outgoing,
    incomingNation,
  };
}

/** V = tiles + β·(home+outgoing)/c̄ − α·incomingNation/c̄; −Infinity if dead.
 *  incomingNation counts every non-tribe attacker (nations and humans). */
export function value(
  r: RolloutResult,
  cbar: number,
  beta = 0.5,
  alpha = 0.5,
): number {
  if (!r.alive) return -Infinity;
  const c = cbar > 0 ? cbar : 1;
  return (
    r.tiles +
    (beta * (r.home + r.outgoing)) / c -
    (alpha * r.incomingNation) / c
  );
}
