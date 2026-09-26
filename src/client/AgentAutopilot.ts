import type {
  AgentWorkerIn,
  AgentWorkerOut,
} from "../agent/browser/AgentWorkerMessages";
import { getCdnBase } from "../core/AssetUrls";
import { EventBus } from "../core/EventBus";
import { ClientID, GameStartInfo, Turn } from "../core/Schemas";
import { SendAgentIntentEvent } from "./Transport";

// Lets an AI agent play for the local player. The agent runs in its own Web
// Worker with its own replica of the game (see src/agent/browser), so the
// main thread's whole cost is forwarding each turn and each outgoing intent:
// no DOM scraping, no synthetic clicks, and no agent code on the thread that
// renders. Its intents take the same path as the player's own clicks.
//
// Turn it on for a tab with ?agent=<name> (optionally
// &agentOptions=<url-encoded JSON>), off with ?agent=off. The choice is kept
// in sessionStorage, so it survives the client's own URL changes.

const STORAGE_KEY = "openfront.autopilot";

export interface AutopilotSettings {
  agent: string;
  options?: Record<string, unknown>;
  rateLimit: boolean;
}

function readSettings(): AutopilotSettings | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const agent = params.get("agent");
    if (agent !== null) {
      if (agent === "" || agent === "off") {
        sessionStorage.removeItem(STORAGE_KEY);
      } else {
        const rawOptions = params.get("agentOptions");
        const settings: AutopilotSettings = {
          agent,
          ...(rawOptions ? { options: JSON.parse(rawOptions) } : {}),
          rateLimit: params.get("agentRateLimit") !== "off",
        };
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      }
    }
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored === null ? null : (JSON.parse(stored) as AutopilotSettings);
  } catch (e) {
    console.warn("[agent] ignoring autopilot settings:", e);
    return null;
  }
}

// Read at startup, before the client rewrites the URL.
const settingsAtLoad: AutopilotSettings | null =
  typeof window === "undefined" ? null : readSettings();

async function createAgentWorker(): Promise<Worker> {
  // Inlined as a same-origin Blob, like the game worker (see WorkerClient),
  // and split into its own chunk so it is only fetched when enabled.
  const { default: AgentWorker } =
    await import("../agent/browser/AgentWorker.worker.ts?worker&inline");
  return new AgentWorker();
}

export class AgentAutopilot {
  private worker: Worker | null = null;
  private stopped = false;
  /** Turns that arrive while the worker is still loading. */
  private backlog: Turn[] = [];

  private constructor(
    private readonly settings: AutopilotSettings,
    private readonly eventBus: EventBus,
  ) {}

  /** Starts an autopilot if this tab asked for one, else returns null. */
  static maybeStart(
    gameStartInfo: GameStartInfo,
    clientID: ClientID | undefined,
    eventBus: EventBus,
    isReplayOrSpectator: boolean,
  ): AgentAutopilot | null {
    if (settingsAtLoad === null || clientID === undefined) return null;
    if (isReplayOrSpectator) return null;
    const pilot = new AgentAutopilot(settingsAtLoad, eventBus);
    void pilot.start(gameStartInfo, clientID);
    return pilot;
  }

  private async start(
    gameStartInfo: GameStartInfo,
    clientID: ClientID,
  ): Promise<void> {
    console.log(`[agent] starting autopilot "${this.settings.agent}"`);
    const worker = await createAgentWorker();
    if (this.stopped) {
      worker.terminate();
      return;
    }
    this.worker = worker;
    worker.addEventListener("message", (e: MessageEvent<AgentWorkerOut>) =>
      this.onMessage(e.data),
    );
    worker.addEventListener("error", (e) =>
      console.error("[agent] worker error:", e.message),
    );
    this.post({
      type: "init",
      gameStartInfo,
      clientID,
      agent: this.settings.agent,
      ...(this.settings.options ? { agentOptions: this.settings.options } : {}),
      cdnBase: getCdnBase(),
      rateLimit: this.settings.rateLimit,
    });
    for (const turn of this.backlog) this.post({ type: "turn", turn });
    this.backlog = [];
  }

  private post(msg: AgentWorkerIn): void {
    this.worker?.postMessage(msg);
  }

  /** Forward every turn the game worker receives, in order. */
  sendTurn(turn: Turn): void {
    if (this.stopped) return;
    if (this.worker === null) {
      this.backlog.push(turn);
      return;
    }
    this.post({ type: "turn", turn });
  }

  /** Forward the real game's hashes so the worker can detect divergence. */
  sendHash(tick: number, hash: number): void {
    if (this.worker !== null && !this.stopped) {
      this.post({ type: "hash", tick, hash });
    }
  }

  private onMessage(msg: AgentWorkerOut): void {
    switch (msg.type) {
      case "intent":
        this.eventBus.emit(new SendAgentIntentEvent(msg.intent));
        break;
      case "log":
        console.log(`[agent] ${msg.line}`);
        break;
      case "ready":
        console.log("[agent] ready");
        break;
      case "status":
        console.debug(
          `[agent] tick ${msg.tick}, behind ${msg.pendingTurns}, ` +
            `sent ${msg.intentsSent}, rate-limited ${msg.intentsRateLimited}, ` +
            `last think ${msg.thinkMsLast.toFixed(1)} ms, errors ${msg.errors}`,
        );
        break;
      case "error":
        console.error(`[agent] stopped: ${msg.message}`);
        this.stop();
        break;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.post({ type: "stop" });
    this.worker?.terminate();
    this.worker = null;
    this.backlog = [];
  }
}
