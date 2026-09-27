import { Game, Player } from "../core/game/Game";
import { GameRunner } from "../core/GameRunner";
import { PseudoRandom } from "../core/PseudoRandom";
import { ClientID, GameStartInfo, IntentSchema } from "../core/Schemas";
import { simpleHash } from "../core/Util";
import {
  Agent,
  AgentContext,
  AgentIntent,
  AgentOutcome,
  SendResult,
} from "./Agent";
import { GameFork, TerrainSource } from "./Fork";
import {
  FORBIDDEN_INTENTS,
  IntentBudget,
  MAX_INTENT_BYTES,
} from "./IntentBudget";

const MAX_LOG_LINES = 2000;
const MAX_RECORDED_ERRORS = 5;

export interface AgentHostOptions {
  agent: Agent;
  clientID: ClientID;
  gameStart: GameStartInfo;
  /** The runner whose game the agent reads. */
  runner: GameRunner;
  /** Needed for `ctx.fork()` by snapshot restore (forkMode "restore"). */
  terrain?: TerrainSource;
  /**
   * How `ctx.fork()` copies the game. "clone" (the default): a structural
   * clone (GameFork.clone, src/core/snapshot/GameClone.ts), several times
   * faster on large maps and with no TerrainSource. "restore": the game's
   * snapshot restored onto fresh maps from `terrain`. Both give the game the
   * snapshot holds; with water nukes only the clone keeps the game's water
   * graph, and a restore can route ships differently from the game.
   */
  forkMode?: "clone" | "restore";
  /** Delivers an accepted intent to the game (turn queue or transport). */
  deliver: (intent: AgentIntent) => void;
  /** Clock for the rate limiter, in ms. Arena: game time. Browser: wall. */
  nowMs: () => number;
  /** Enforce the server's intent limits (default true). */
  rateLimit?: boolean;
  /** Rethrow agent exceptions instead of recording them (default false). */
  strict?: boolean;
  /** Receives every log line as it is written. */
  onLog?: (line: string) => void;
}

export interface AgentHostStats {
  intentsSent: number;
  intentsRateLimited: number;
  intentsInvalid: number;
  /** Intent counts by type, accepted only. */
  intentsByType: Record<string, number>;
  /** Wall-clock milliseconds spent in `agent.tick`, one sample per call,
   *  not counting the time inside `ctx.fork()` (that is `forkMs`). */
  thinkMs: number[];
  errors: number;
  firstErrors: string[];
  forks: number;
  /** Wall-clock milliseconds spent inside `ctx.fork()`, one sample per
   *  fork (the copy; stepping the fork afterwards is think time). */
  forkMs: { count: number; total: number; max: number };
}

/**
 * Runs one agent against one game: builds its context each tick, validates
 * and rate-limits what it sends, and detects when the game ends for it.
 * Environment-neutral — the arena and the browser worker both use it.
 */
export class AgentHost {
  readonly stats: AgentHostStats = {
    intentsSent: 0,
    intentsRateLimited: 0,
    intentsInvalid: 0,
    intentsByType: {},
    thinkMs: [],
    errors: 0,
    firstErrors: [],
    forks: 0,
    forkMs: { count: 0, total: 0, max: 0 },
  };
  readonly logs: string[] = [];

  private readonly budget: IntentBudget;
  private readonly random: PseudoRandom;
  private finished: AgentOutcome | null = null;
  private eliminatedAtTick: number | null = null;
  // Fork time inside the current agent.tick, taken out of its think time.
  private tickForkMs = 0;

  constructor(private readonly opts: AgentHostOptions) {
    this.budget = new IntentBudget(opts.nowMs, opts.rateLimit ?? true);
    this.random = new PseudoRandom(
      simpleHash(opts.gameStart.gameID) ^ simpleHash(opts.clientID),
    );
  }

  get agent(): Agent {
    return this.opts.agent;
  }

  get game(): Game {
    return this.opts.runner.game;
  }

  me(): Player {
    const me = this.game.playerByClientID(this.opts.clientID);
    if (me === null) {
      throw new Error(`no player with clientID ${this.opts.clientID}`);
    }
    return me;
  }

  /** Lets the agent act on the tick that just executed. */
  tick(): void {
    if (this.finished !== null) return;
    const ctx = this.context();
    this.tickForkMs = 0;
    const start = performance.now();
    try {
      this.opts.agent.tick(ctx);
    } catch (e) {
      this.recordError(e);
    } finally {
      const ms = performance.now() - start - this.tickForkMs;
      this.stats.thinkMs.push(Math.max(0, ms));
    }
  }

  /**
   * The outcome once the game has ended for this agent, else null. Checks
   * the win condition and elimination; call it after every tick.
   */
  checkOutcome(): AgentOutcome | null {
    if (this.finished !== null) return this.finished;
    const game = this.game;
    const me = this.me();
    if (
      this.eliminatedAtTick === null &&
      !game.inSpawnPhase() &&
      me.hasSpawned() &&
      !me.isAlive()
    ) {
      this.eliminatedAtTick = game.ticks();
    }
    const winner = game.getWinner();
    if (winner !== null) {
      const won =
        typeof winner === "string" ? me.team() === winner : winner === me;
      return this.finish(won ? "win" : "loss");
    }
    if (this.eliminatedAtTick !== null) {
      return this.finish("loss");
    }
    return null;
  }

  /** Ends the game for this agent without a result, e.g. at a tick cap. */
  timeout(): AgentOutcome {
    return this.finished ?? this.finish("timeout");
  }

  outcome(): AgentOutcome | null {
    return this.finished;
  }

  private finish(result: AgentOutcome["result"]): AgentOutcome {
    const outcome: AgentOutcome = {
      result,
      eliminatedAtTick: this.eliminatedAtTick,
    };
    this.finished = outcome;
    try {
      this.opts.agent.gameOver?.(this.context(), outcome);
    } catch (e) {
      this.recordError(e);
    }
    return outcome;
  }

  send(intent: AgentIntent): SendResult {
    if (this.finished !== null) return "game_over";
    if (!this.isValid(intent)) {
      this.stats.intentsInvalid++;
      return "invalid";
    }
    if (!this.budget.tryConsume()) {
      this.stats.intentsRateLimited++;
      return "rate_limited";
    }
    this.stats.intentsSent++;
    this.stats.intentsByType[intent.type] =
      (this.stats.intentsByType[intent.type] ?? 0) + 1;
    this.opts.deliver(intent);
    return "ok";
  }

  private isValid(intent: AgentIntent): boolean {
    if (FORBIDDEN_INTENTS.has((intent as { type: string }).type)) {
      this.log(`rejected forbidden intent ${intent.type}`);
      return false;
    }
    const parsed = IntentSchema.safeParse(intent);
    if (!parsed.success) {
      this.log(
        `rejected invalid ${intent.type} intent: ${parsed.error.message}`,
      );
      return false;
    }
    // JSON is never smaller than the binary wire encoding, so this bound is
    // conservative: nothing that passes can get the client kicked.
    if (JSON.stringify(intent).length > MAX_INTENT_BYTES) {
      this.log(`rejected oversized ${intent.type} intent`);
      return false;
    }
    return true;
  }

  fork(): GameFork {
    const { terrain, runner, gameStart, clientID } = this.opts;
    const restore = this.opts.forkMode === "restore";
    if (restore && terrain === undefined) {
      throw new Error("forking by restore needs a TerrainSource");
    }
    this.stats.forks++;
    const start = performance.now();
    try {
      return restore
        ? new GameFork(
            runner.game,
            runner.snapshot(),
            terrain!,
            gameStart,
            clientID,
          )
        : GameFork.clone(runner.game, gameStart, clientID);
    } finally {
      const ms = performance.now() - start;
      const forkMs = this.stats.forkMs;
      forkMs.count++;
      forkMs.total += ms;
      forkMs.max = Math.max(forkMs.max, ms);
      this.tickForkMs += ms;
    }
  }

  log(message: string): void {
    const line = `[${this.game.ticks()}] ${message}`;
    if (this.logs.length < MAX_LOG_LINES) this.logs.push(line);
    this.opts.onLog?.(line);
  }

  /** Counts and logs an agent exception; rethrows it when strict, after
   *  counting, so the seat's stats agree with the game's error. */
  private recordError(e: unknown): void {
    this.stats.errors++;
    const text = e instanceof Error ? (e.stack ?? e.message) : String(e);
    if (this.stats.firstErrors.length < MAX_RECORDED_ERRORS) {
      this.stats.firstErrors.push(`tick ${this.game.ticks()}: ${text}`);
    }
    this.log(`agent error: ${text.split("\n")[0]}`);
    if (this.opts.strict) throw e;
  }

  private context(): AgentContext {
    const game = this.game;
    return {
      game,
      clientID: this.opts.clientID,
      gameID: this.opts.gameStart.gameID,
      me: this.me(),
      tick: game.ticks(),
      random: this.random,
      send: (intent) => this.send(intent),
      budget: () => this.budget.remaining(),
      budgetState: () => this.budget.state(),
      fork: () => this.fork(),
      log: (message) => this.log(message),
    };
  }
}
