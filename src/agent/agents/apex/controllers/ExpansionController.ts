import type { Controller, View } from "../policy";
import type { ApexState } from "../state";

/**
 * The allocator (spec §3.6): every decision it spends the Purse in the order
 * below; each item goes through scheduler.offer and stops when an offer
 * fails. Enabled by `o.expansion`.
 */
export class ExpansionController implements Controller {
  readonly name = "expansion";

  decide(v: View, s: ApexState): void {
    // TODO(spec §3.6):
    // - §3.6.1 snacks (o.snacks), floor "snack" (§4 step 2).
    // - §3.6.2 top-ups (o.topUps) of tribe, snipe and strike plans (step 2).
    // - §3.6.3 free land (o.tn): TN cadence and minimum chunk (step 1).
    // - §3.6.4 tribe launches (o.tribes), step 2; contest (o.contest), buffer
    //   (o.buffer) and snipe (o.snipes) weights, step 7.
    // - §3.6.5 enclose-and-poke (o.pokes), step 7.
    // - §3.6.6 stall mode (o.stall; rules o.stallTribes, o.stallBoats,
    //   o.stallStrike), trigger kept in s.stall.since (step 2).
    // - §3.6.7 cap headroom (o.headroom, o.headroomSlack), off in stall mode.
  }
}
