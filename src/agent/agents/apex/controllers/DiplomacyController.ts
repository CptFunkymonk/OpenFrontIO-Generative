import type { Controller, View } from "../policy";
import type { ApexState } from "../state";

/**
 * The alliance web, food list, counter-accept, extensions (spec §3.4).
 * Enabled by `o.diplomacy`.
 */
export class DiplomacyController implements Controller {
  readonly name = "diplomacy";

  onTick(v: View, s: ApexState): void {
    // TODO(spec §3.4.4, §4 step 3): counter-accept (o.counterAccept)
    // requests from nations outside s.web.food while our alliances < A_max
    // (Prio.Diplomacy). Requests from food-list nations are left to expire.
  }

  decide(v: View, s: ApexState): void {
    // TODO(spec §3.4, §4 step 3), "Diplomacy upkeep", last in §3.0 step 4:
    // - §3.4.1 slots A_max, A_ext, webTarget (o.allySlotsReserve).
    // - §3.4.2 plan every o.planEvery ticks: reach (v.owners, reachCells,
    //   o.allyReachCells), danger, s.web.allySet ranked by o.webRank, and
    //   s.web.food (o.foodList).
    // - §3.4.3 requests (o.web) from tick numSpawnPhaseTurns() + 2, p >=
    //   o.allyMinP, at most o.allyPerSecond per second.
    // - §3.4.5 extensions (o.extensions, o.extendLead).
    // - §3.4.6 never break, never request tribes.
    // M3: alliance oracle (§5.1.7, o.allyOracle).
  }
}
