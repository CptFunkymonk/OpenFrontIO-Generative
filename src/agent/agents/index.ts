import { Agent, AgentContext, AgentFactory } from "../Agent";
import { planSpawn } from "../lib/SpawnPlanner";
import { BaselineAgent, BaselineOptions } from "./BaselineAgent";

/** Spawns on the best-scored tile, then does nothing. A lower bound. */
class IdleAgent implements Agent {
  readonly name = "idle";
  private sent = false;
  tick(ctx: AgentContext): void {
    if (this.sent || !ctx.game.inSpawnPhase() || ctx.tick < 3) return;
    const tile = planSpawn(ctx.game, ctx.me);
    if (tile !== null) this.sent = ctx.send({ type: "spawn", tile }) === "ok";
  }
}

/**
 * Every agent the arena and the browser autopilot can run, by name. Add new
 * agents here; options arrive as parsed JSON (`--agent-options` in the
 * arena, `?agentOptions=` in the browser).
 */
export const AGENTS: Record<string, AgentFactory> = {
  baseline: (options) =>
    new BaselineAgent((options ?? {}) as Partial<BaselineOptions>),
  idle: () => new IdleAgent(),
};

export function createAgent(
  name: string,
  options?: Record<string, unknown>,
): Agent {
  const factory = AGENTS[name];
  if (factory === undefined) {
    throw new Error(
      `unknown agent "${name}". Available: ${Object.keys(AGENTS).join(", ")}`,
    );
  }
  return factory(options);
}
