import type { Controller, View } from "../policy";
import type { ApexState } from "../state";

/**
 * Closing and the MIRV problem (spec §5.3, M5). A stub returning nothing
 * until then. Enabled by `o.endgame`; its features have their own flags.
 */
export class EndgameController implements Controller {
  readonly name = "endgame";

  decide(v: View, s: ApexState): void {
    // TODO(spec §5.3, M5): MIRV watch every 50 ticks; the 38% gate
    // (o.mirvGate, E16); steamroll rule; crossing; if MIRVed.
  }
}
