import { Game, Player } from "../core/game/Game";
import { PseudoRandom } from "../core/PseudoRandom";
import { ClientID, Intent } from "../core/Schemas";
import { GameFork } from "./Fork";

/**
 * The contract between an AI player and the game.
 *
 * An agent is a *player*, not part of the simulation. It reads the complete
 * game state (there is no fog of war: every client holds all of it) and acts
 * only by sending the intents a human's clicks would produce, subject to the
 * same latency and rate limits. The same agent object runs unchanged in the
 * headless arena (Node) and in the browser autopilot (its own Web Worker),
 * so agent code must not touch the DOM or any Node API.
 *
 * Read-only rule: `ctx.game` is the live simulation. Never call a mutating
 * method on it or on anything reachable from it (`conquer`, `addGold`,
 * `setTroops`, `buildUnit`, `addExecution`, `toUpdate`, ...). In the browser
 * a mutation desyncs the agent's replica from the real game; in the arena it
 * changes the outcome in a way no real player could. Run the arena with
 * `--isolate` to prove an agent is read-only.
 */
export interface Agent {
  /** Stable identifier, e.g. "baseline". Shown in arena reports. */
  readonly name: string;

  /**
   * Called once per game tick after it executed, starting with the first
   * spawn-phase tick. Act by calling `ctx.send`.
   *
   * In the browser the agent is called once per batch of ticks when its
   * replica falls behind, so do not assume consecutive tick numbers.
   */
  tick(ctx: AgentContext): void;

  /** Called once when the game ends for this agent (win, loss or timeout). */
  gameOver?(ctx: AgentContext, outcome: AgentOutcome): void;
}

export interface AgentContext {
  /** The full game state. READ-ONLY, see the rule on `Agent`. */
  readonly game: Game;
  readonly clientID: ClientID;
  /** This agent's player. Exists from the first tick, before spawning. */
  readonly me: Player;
  /** Current game tick (`game.ticks()`). */
  readonly tick: number;
  /** Seeded per game and seat, so arena runs are reproducible. */
  readonly random: PseudoRandom;

  /**
   * Queues an intent for the next turn. Returns "ok", or why it was not
   * sent. Sending is subject to the server's limits (10 intents per second,
   * 150 per minute); a rejected intent is dropped, never retried.
   */
  send(intent: AgentIntent): SendResult;

  /** Intents that can still be sent right now without being rate limited. */
  budget(): IntentBudgetRemaining;

  /**
   * Copies the game at this tick into an independent simulation that can be
   * stepped forward with hypothetical intents, for lookahead. Expensive on
   * large maps (a full snapshot and restore), so use it deliberately.
   */
  fork(): GameFork;

  /** Debug output, captured per game by the arena. */
  log(message: string): void;
}

/**
 * Every gameplay intent. Excluded: server-internal and lobby-control intents
 * (a real server rejects or kicks for them, and `LocalServer` crashes on
 * some), and pausing.
 */
export type AgentIntent = Exclude<
  Intent,
  {
    type:
      | "mark_disconnected"
      | "kick_player"
      | "update_game_config"
      | "toggle_game_start_timer"
      | "toggle_pause";
  }
>;

export type SendResult =
  | "ok"
  /** Over the per-second or per-minute budget. */
  | "rate_limited"
  /** Failed schema validation, is a forbidden type, or is oversized. */
  | "invalid"
  /** The game already ended for this agent. */
  | "game_over";

export interface IntentBudgetRemaining {
  perSecond: number;
  perMinute: number;
}

export interface AgentOutcome {
  result: "win" | "loss" | "timeout";
  /** Tick this agent's player was eliminated at, if it was. */
  eliminatedAtTick: number | null;
}

export type AgentFactory = (options?: Record<string, unknown>) => Agent;
