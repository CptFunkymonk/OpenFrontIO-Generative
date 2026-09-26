import { PlayerID } from "../../../core/game/Game";
import { HomeFloors } from "../../lib/Scheduler";
import type { View } from "./policy";
import { ApexState } from "./state";

// HomeTarget and the floors every spend uses (spec §3.1). The policy calls
// homeFloors once per decision, before the Purse is built.

/** What homeFloors reads. */
export type HomeTargetInputs = Pick<
  View,
  "tick" | "o" | "me" | "models" | "nm"
>;

/** Floors of the spawn phase, where nothing is spent but the spawn. */
export const NO_FLOORS: HomeFloors = Object.freeze({
  cap: 0,
  econ: 0,
  vw: 0,
  food: 0,
  H: 0,
  tn: 0,
  strike: 0,
});

// A nation with T troops can land-attack us only while it may send at least
// 0.2·H (isAttackTooWeak) out of T − 0.9·H (troopSendCap): safe iff
// H > T/1.1 [PIN NationSendCap].
const SEND_CAP_SAFE = 1.1;

/**
 * §3.1:
 *   H_econ = homeX·cap, H_vw = vwGuard·cap,
 *   H_food = max over food-list nations bordering us of
 *            (troopsAt(N, d_N) + 1)/1.1·foodMargin,
 *   H = max(H_econ, H_vw, H_food);
 *   floor(snack, defense) = H_vw, floor(tn) = max(H_vw, tnKeep·H),
 *   floor(tribe, boat) = H, floor(strike) = H (M4: max(H, H_det_all)).
 * A food term above detCap·cap removes that nation from s.web.food instead.
 */
export function homeFloors(v: HomeTargetInputs, s: ApexState): HomeFloors {
  const { o, models, me, nm, tick } = v;
  const cap = models.cap(me);
  const econ = o.homeX * cap;
  const vw = o.vwGuard * cap;
  let food = 0;
  let kept: PlayerID[] | null = null;
  const list = s.web.food;
  for (let i = 0; i < list.length; i++) {
    const id = list[i];
    if (nm.get(id)?.sharesBorderWithUs === true) {
      const T = nm.troopsAt(id, nm.nextDecision(id, tick));
      const term = ((T + 1) / SEND_CAP_SAFE) * o.foodMargin;
      if (term > o.detCap * cap) {
        kept ??= list.slice(0, i);
        continue;
      }
      food = Math.max(food, term);
    }
    kept?.push(id);
  }
  if (kept !== null) s.web.food = kept;
  const H = Math.max(econ, vw, food);
  // TODO(spec §5.1.2, M3): the soft deterrence floor (o.softFloor) raises
  // floor(tribe/boat). TODO(spec §5.2, M4): floor(strike) = max(H, H_det_all).
  return { cap, econ, vw, food, H, tn: Math.max(vw, o.tnKeep * H), strike: H };
}
