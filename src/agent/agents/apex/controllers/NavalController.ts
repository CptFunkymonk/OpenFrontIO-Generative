import type { Controller, View } from "../policy";
import type { ApexState } from "../state";

/**
 * Boats (spec §3.7, §5.4). Enabled by `o.boats`.
 */
export class NavalController implements Controller {
  readonly name = "naval";

  decide(v: View, s: ApexState): void {
    // TODO(spec §3.7, §4 step 6): every o.boatEvery ticks (s.timers.lastBoat)
    // while wm.boatsInFlight < config.boatMaxNumber() and
    // purse.available("boat") >= o.boatMinTroops; trigger "blocked", stall
    // mode (o.stallBoats) or water priority (o.waterMapLand); targets from
    // RaceField.boatTargets on v.race / v.owners; at most o.boatProbes
    // canBuild(TransportShip) probes per decision, cached in s.probes for
    // 200 ticks; troops per §3.7 (o.beachheadExtra for tribe targets).
  }
}
