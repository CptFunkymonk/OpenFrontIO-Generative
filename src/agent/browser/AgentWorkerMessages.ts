import { ClientID, GameStartInfo, Turn } from "../../core/Schemas";
import type { AgentIntent } from "../Agent";

/** Main thread → agent worker. */
export type AgentWorkerIn =
  | {
      type: "init";
      gameStartInfo: GameStartInfo;
      clientID: ClientID;
      agent: string;
      agentOptions?: Record<string, unknown>;
      cdnBase: string;
      rateLimit: boolean;
    }
  | { type: "turn"; turn: Turn }
  /** A hash from the real game, to check the replica has not diverged. */
  | { type: "hash"; tick: number; hash: number }
  | { type: "stop" };

/** Agent worker → main thread. */
export type AgentWorkerOut =
  | { type: "ready" }
  | { type: "intent"; intent: AgentIntent }
  | { type: "log"; line: string }
  | {
      type: "status";
      tick: number;
      pendingTurns: number;
      intentsSent: number;
      intentsRateLimited: number;
      thinkMsLast: number;
      errors: number;
    }
  /** Fatal: the agent has stopped. */
  | { type: "error"; message: string };
