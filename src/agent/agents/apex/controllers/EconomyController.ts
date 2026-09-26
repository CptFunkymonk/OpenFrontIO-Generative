import type { Controller, View } from "../policy";
import type { ApexState } from "../state";

/**
 * Cities from loot (spec §3.8); the SAM rule from M3 (§5.1.5). Enabled by
 * `o.economy`.
 */
export class EconomyController implements Controller {
  readonly name = "economy";

  decide(v: View, s: ApexState): void {
    // TODO(spec §3.8, §4 step 5): every o.cityEvery ticks (s.timers.lastCity),
    // if o.cities and o.structurePolicy allows (§3.8; "exposure" needs
    // NukeModel, M3): upgrade a finished city at depth >= o.cityMinDepth
    // first (o.cityUpgradeFirst), else build a city on the deepest interior
    // tile (deterministic tie-break, never ctx.random). Prio.Build.
    // M3: SAM umbrella (§5.1.5), captured structures (§5.1.6,
    // o.deleteCaptured).
  }
}
