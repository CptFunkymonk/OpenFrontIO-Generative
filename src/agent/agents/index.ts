import { Agent, AgentContext, AgentFactory } from "../Agent";
import { planSpawn } from "../lib/SpawnPlanner";
import { ApexAgent } from "./apex";
import { parseApexOptions } from "./apex/options";
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
  apex: (options) => new ApexAgent(parseApexOptions(options)),
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
  // A misspelled option would silently run the defaults under its label, so
  // an A/B could measure a change that never happened. Check the keys
  // against a default instance: agents may copy unknown keys into their own.
  const given = Object.keys(options ?? {});
  if (given.length > 0) {
    const defaults = factory().options;
    const unknown = given.filter(
      (k) =>
        defaults === undefined ||
        !Object.prototype.hasOwnProperty.call(defaults, k),
    );
    if (unknown.length > 0) {
      throw new Error(
        `${name} has no option ${unknown.map((k) => `"${k}"`).join(", ")}` +
          (defaults === undefined
            ? " (it takes none)"
            : ` (it has ${Object.keys(defaults).join(", ")})`),
      );
    }
  }
  return factory(options);
}
