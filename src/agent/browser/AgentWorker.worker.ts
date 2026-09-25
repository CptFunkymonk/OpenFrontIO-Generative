import { assetUrl } from "../../core/AssetUrls";
import { FetchGameMapLoader } from "../../core/game/FetchGameMapLoader";
import { GameUpdateType, HashUpdate } from "../../core/game/GameUpdates";
import { createGameRunner, GameRunner } from "../../core/GameRunner";
import { AgentHost } from "../AgentHost";
import { createAgent } from "../agents";
import { TerrainSource } from "../Fork";
import { CachingMapLoader } from "../lib/CachingMapLoader";
import type { AgentWorkerIn, AgentWorkerOut } from "./AgentWorkerMessages";

// The browser autopilot. This worker runs its own replica of the game, fed
// the same turns as the real one, and runs the agent against it. Nothing
// here shares a thread with rendering or with the real simulation, so an
// agent can think for as long as it likes without the game stuttering; if
// it thinks longer than a turn, the replica simply catches up afterwards.

const ctx = self as unknown as Worker;
globalThis.__ASSET_MANIFEST__ = __ASSET_MANIFEST__;

const STATUS_EVERY_TICKS = 50;
// Keep this many ticks of hashes around while waiting for the other side's.
const HASH_WINDOW_TICKS = 2000;

let setup: Promise<{ runner: GameRunner; host: AgentHost }> | null = null;
let stopped = false;
let draining = false;
let drainScheduled = false;
let lastStatusTick = -Infinity;
const replicaHashes = new Map<number, number>();
const realHashes = new Map<number, number>();

function post(msg: AgentWorkerOut): void {
  ctx.postMessage(msg);
}

function fail(message: string): void {
  if (stopped) return;
  stopped = true;
  post({ type: "error", message });
}

async function init(
  msg: Extract<AgentWorkerIn, { type: "init" }>,
): Promise<{ runner: GameRunner; host: AgentHost }> {
  // Map fetches resolve against the CDN; workers have no `window`.
  globalThis.__CDN_BASE__ = msg.cdnBase;
  const loader = new CachingMapLoader(
    new FetchGameMapLoader((p) => assetUrl(`maps/${p}`)),
  );
  const runner = await createGameRunner(
    msg.gameStartInfo,
    msg.clientID,
    loader,
    (gu) => {
      if ("errMsg" in gu) {
        fail(`replica tick failed: ${gu.errMsg}`);
        return;
      }
      for (const h of gu.updates[GameUpdateType.Hash] as HashUpdate[]) {
        replicaHashes.set(h.tick, h.hash);
      }
    },
  );
  const { gameMap, gameMapSize } = msg.gameStartInfo.config;
  const terrain = await TerrainSource.load(loader, gameMap, gameMapSize);
  const host = new AgentHost({
    agent: createAgent(msg.agent, msg.agentOptions),
    clientID: msg.clientID,
    gameStart: msg.gameStartInfo,
    runner,
    terrain,
    deliver: (intent) => post({ type: "intent", intent }),
    nowMs: () => performance.now(),
    rateLimit: msg.rateLimit,
    onLog: (line) => post({ type: "log", line }),
  });
  post({ type: "ready" });
  return { runner, host };
}

/** Compares hashes both sides have produced; any mismatch is fatal. */
function verifyHashes(): void {
  for (const [tick, mine] of replicaHashes) {
    const real = realHashes.get(tick);
    if (real === undefined) continue;
    if (real !== mine) {
      fail(
        `replica diverged from the real game at tick ${tick}; the agent ` +
          `stopped (did it mutate the game state?)`,
      );
      return;
    }
    replicaHashes.delete(tick);
    realHashes.delete(tick);
  }
}

function prune(map: Map<number, number>, latest: number): void {
  for (const tick of map.keys()) {
    if (tick < latest - HASH_WINDOW_TICKS) map.delete(tick);
  }
}

function scheduleDrain(): void {
  if (drainScheduled || stopped) return;
  drainScheduled = true;
  setTimeout(() => {
    drainScheduled = false;
    void drain().catch((e) => fail(`agent worker crashed: ${String(e)}`));
  }, 0);
}

async function drain(): Promise<void> {
  if (draining || stopped || setup === null) return;
  draining = true;
  const { runner, host } = await setup;
  try {
    // Catch up on every queued turn first, then let the agent act once on
    // the newest state rather than on each stale intermediate one.
    let ran = 0;
    while (!stopped && runner.pendingTurns() > 0) {
      if (!runner.executeNextTick()) {
        fail(`replica could not execute tick ${runner.game.ticks()}`);
        return;
      }
      ran++;
    }
    if (ran === 0 || stopped) return;
    verifyHashes();
    if (stopped) return;

    host.tick();
    const tick = runner.game.ticks();
    const outcome = host.checkOutcome();
    if (tick - lastStatusTick >= STATUS_EVERY_TICKS || outcome !== null) {
      lastStatusTick = tick;
      const s = host.stats;
      post({
        type: "status",
        tick,
        pendingTurns: runner.pendingTurns(),
        intentsSent: s.intentsSent,
        intentsRateLimited: s.intentsRateLimited,
        thinkMsLast: s.thinkMs[s.thinkMs.length - 1] ?? 0,
        errors: s.errors,
      });
      prune(replicaHashes, tick);
      prune(realHashes, tick);
    }
    if (outcome !== null) {
      post({ type: "log", line: `game over for the agent: ${outcome.result}` });
      stopped = true;
    }
  } finally {
    draining = false;
    if (runner.pendingTurns() > 0) scheduleDrain();
  }
}

ctx.addEventListener("message", (e: MessageEvent<AgentWorkerIn>) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      setup = init(msg);
      setup.catch((err) => fail(`agent init failed: ${String(err)}`));
      break;
    case "turn":
      if (setup === null || stopped) return;
      void setup.then(({ runner }) => {
        runner.addTurn(msg.turn);
        scheduleDrain();
      });
      break;
    case "hash":
      realHashes.set(msg.tick, msg.hash);
      break;
    case "stop":
      // The main thread terminates the worker right after this.
      stopped = true;
      break;
  }
});
