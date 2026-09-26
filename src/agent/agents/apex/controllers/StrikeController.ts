import type { Controller, View } from "../policy";
import type { ApexState } from "../state";

/**
 * Strikes on nations (spec §3.5 in M2, §5.2 in M4). Enabled by `o.strike`;
 * in M2 it does nothing unless `o.stallStrike` is on (step 9).
 */
export class StrikeController implements Controller {
  readonly name = "strike";

  onTick(v: View, s: ApexState): void {
    // TODO(spec §3.5, §5.2.3): timed launches need tick precision: a strike
    // launches at ctx.tick = d_prev + 1, one tick after the nation's
    // decision, which a decide every o.thinkEvery ticks would miss.
  }

  decide(v: View, s: ApexState): void {
    // TODO(spec §3.5, §4 step 9): in stall mode only (§3.6.6), with
    // o.stallStrike: a W1 or W2 strike on a bordering unallied nation,
    // S = min(purse.available("strike"), (T_N/0.6)·o.tribeMargin), only if
    // S >= T_N.
    // M4 (§5.2): windows o.strikeWindows (E13), sizing, o.strikeFork,
    // steering (o.steering, o.steerGoldShare, E14), bombs (o.bombs, E15).
  }
}
