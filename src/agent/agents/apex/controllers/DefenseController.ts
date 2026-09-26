import type { Controller, View } from "../policy";
import type { ApexState } from "../state";

/**
 * Reflexes, every tick, highest priority (spec §3.3). Enabled by
 * `o.defense`. Default: absorb; never cancel by reflex (C12).
 */
export class DefenseController implements Controller {
  readonly name = "defense";

  onTick(v: View, s: ApexState): void {
    // TODO(spec §3.3, §4 step 3):
    // - §3.3.2 recall by alliance (o.recall, o.recallMinP): embargo stop
    //   (o.embargoStop) + allianceRequest at tReq, both Prio.Recall; re-offer
    //   the stop every tick in (tReq, d − 2] while me.hasEmbargoAgainst(N).
    // - §3.3.3 free TN cancel (o.cancelTnOnThreat), at most one per 50 ticks.
    // - §3.3.4 embargo hygiene (o.embargoStop): stop within 20 ticks of a
    //   nation attack, unless N is a strike target.
    // - §3.3.5 never counter-attack, break alliances, or let home fall below
    //   H_vw except through snacks.
    // M3: the soft floor (§5.1.2, o.softFloor) belongs in HomeTarget; the
    // defense search (§5.1.7, o.defenseSearch) forks via v.lookahead.
  }
}
