import { Agent, AgentContext } from "../../Agent";
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
    this.policy = new ApexPolicy(o, createState());
  }

  get options(): Readonly<Record<string, unknown>> {
    return { ...structuredClone(this.o) };
  }

  tick(ctx: AgentContext): void {
    this.policy.tick(ctx);
  }
}
