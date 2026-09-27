import { Agent, AgentContext, AgentOutcome } from "../../Agent";
import { SearchController } from "./controllers/SearchController";
import { ApexOptions, parseApexOptions } from "./options";
import { ApexPolicy } from "./policy";
import { createState } from "./state";

/**
 * The agent meant to beat the Impossible nations (docs/11-roadmap.md; the §
 * references in src/agent/agents/apex/ are to the apex implementation
 * spec). Host glue only (spec §2.10): all decisions are in ApexPolicy, all
 * memory in ApexState.
 */
export class ApexAgent implements Agent {
  readonly name = "apex";
  private readonly policy: ApexPolicy;

  constructor(private readonly o: ApexOptions = parseApexOptions()) {
    // Package WP2: the live search, when o.search is on.
    this.policy = new ApexPolicy(
      o,
      createState(),
      o.search ? new SearchController(o) : null,
    );
  }

  get options(): Readonly<Record<string, unknown>> {
    return { ...structuredClone(this.o) };
  }

  tick(ctx: AgentContext): void {
    this.policy.tick(ctx);
  }

  /** Logs the Scheduler's totals (sent, refused, rate limited). */
  gameOver(ctx: AgentContext, outcome: AgentOutcome): void {
    this.policy.gameOver(ctx, outcome);
  }
}
