import { PlayerID, PlayerType } from "../../../core/game/Game";
import {
  Deterrence,
  deterrence,
  DeterrenceTerm,
  NO_DETERRENCE,
} from "../../lib/Deterrence";
import { HomeFloors } from "../../lib/Scheduler";
import type { View } from "./policy";
import { ApexState } from "./state";

// HomeTarget and the floors every spend uses (spec §3.1). The policy calls
// homeFloors once per decision, before the Purse is built.

declare module "../../lib/Scheduler" {
  interface HomeFloors {
    /** o.deterrence (package B1): the deterrence floor included in H (0
     *  when off or when no nation needs it), the nation behind it, and
     *  every kept line (lib/Deterrence.ts), for controllers that spend
     *  below H, e.g. the counter, which keeps every other nation's line.
     *  Declared here (Scheduler.ts belongs to another package). */
    det?: number;
    detBy?: PlayerID | null;
    detTerms?: readonly DeterrenceTerm[];
  }
}

declare module "./state" {
  interface ApexState {
    /** o.deterrence (package B1): the nations that bordered us at the last
     *  decision (WorldModel.nations, type Nation), noted by the
     *  DefenseController's onTick (noteBorderNations) for the next
     *  homeFloors, which the policy calls before the scan reaches the
     *  controllers. Plain data. */
    deterrence?: { cands: PlayerID[]; at: number };
  }
}

/** What homeFloors reads. */
export type HomeTargetInputs = Pick<
  View,
  "tick" | "o" | "me" | "models" | "nm"
> & {
  /** The bordering nations for o.deterrence. The policy passes none today,
   *  so homeFloors reads the ones noted in ApexState (noteBorderNations,
   *  one decision old); passing `wm: v.wm` from policy.ts would use the
   *  decision's own scan. */
  wm?: View["wm"];
};

/** o.deterrence: notes the nations of the decision's scan for the next
 *  homeFloors (called by the DefenseController's onTick; cheap: once per
 *  scan). */
export function noteBorderNations(v: Pick<View, "o" | "wm">, s: ApexState) {
  if (!v.o.deterrence) return;
  if (s.deterrence !== undefined && s.deterrence.at === v.wm.tick) return;
  const cands: PlayerID[] = [];
  for (const n of v.wm.nations) {
    if (n.type === PlayerType.Nation) cands.push(n.id);
  }
  s.deterrence = { cands, at: v.wm.tick };
}

/** Floors of the spawn phase, where nothing is spent but the spawn. */
export const NO_FLOORS: HomeFloors = Object.freeze({
  cap: 0,
  econ: 0,
  vw: 0,
  food: 0,
  H: 0,
  tn: 0,
  strike: 0,
  det: 0,
  detBy: null,
  detTerms: [],
});

/**
 * §3.1:
 *   H_econ = homeX·cap, H_vw = vwGuard·cap,
 *   H_food = max over food-list nations bordering us of
 *            (troopsAt(N, d_N) + 1)/1.1·foodMargin,
 *   H = max(H_econ, H_vw, H_food);
 *   floor(snack, defense) = H_vw, floor(tn) = max(H_vw, tnKeep·H),
 *   floor(tribe, boat) = H, floor(strike) = H (M4: max(H, H_det_all)).
 * A food term above detCap·cap removes that nation from s.web.food instead.
 * 1.1 is nm.sendCapSafe() at Impossible (0.95 at Hard); at Easy and Medium
 * no home deters a land attack (sendCapSafe is Infinity), so H_food is 0.
 *
 * o.deterrence (spec §5.1 items 2-3, package B1): H also covers
 * H_det = deterrenceFloor (lib/Deterrence.ts), probed at the H above: every
 * bordering unallied nation that could land-attack us there and would pick
 * us adds its land line (T_N(d) + 1)/1.1·detMargin, every bordering ally at
 * or above its reserve detBetrayShare·T_A(d), lines above detMaxShare·cap
 * dropped. So tribes, boats, strikes and (through tnKeep) free land never
 * spend home below the line of a nation that could then attack us.
 */
export function homeFloors(v: HomeTargetInputs, s: ApexState): HomeFloors {
  const { o, models, me, nm, tick } = v;
  const cap = models.cap(me);
  const econ = o.homeX * cap;
  const vw = o.vwGuard * cap;
  let food = 0;
  let kept: PlayerID[] | null = null;
  const list = s.web.food;
  const safe = nm.sendCapSafe();
  for (let i = 0; Number.isFinite(safe) && i < list.length; i++) {
    const id = list[i];
    if (nm.get(id)?.sharesBorderWithUs === true) {
      const T = nm.troopsAt(id, nm.nextDecision(id, tick));
      const term = ((T + 1) / safe) * o.foodMargin;
      if (term > o.detCap * cap) {
        kept ??= list.slice(0, i);
        continue;
      }
      food = Math.max(food, term);
    }
    kept?.push(id);
  }
  if (kept !== null) s.web.food = kept;
  const low = Math.max(econ, vw, food);
  const det = deterrenceFloor(v, s, low);
  const H = Math.max(low, det.floor);
  // TODO(spec §5.2, M4): floor(strike) = max(H, H_det_all).
  return {
    cap,
    econ,
    vw,
    food,
    H,
    tn: Math.max(vw, o.tnKeep * H),
    strike: H,
    det: det.floor,
    detBy: det.by,
    detTerms: det.terms,
  };
}

/** o.deterrence's floor at probe home `low`, or none. */
function deterrenceFloor(
  v: HomeTargetInputs,
  s: ApexState,
  low: number,
): Deterrence {
  const { o } = v;
  if (!o.deterrence) return NO_DETERRENCE;
  const cands =
    v.wm !== undefined
      ? v.wm.nations
          .filter((n) => n.type === PlayerType.Nation)
          .map((n) => n.id)
      : (s.deterrence?.cands ?? []);
  return deterrence(v.me, v.nm, v.models, v.tick, low, cands, {
    margin: o.detMargin,
    maxShare: o.detMaxShare,
    capLines: o.detCapLines,
    betrayShare: o.detBetrayShare,
    targetCheck: o.detTargetCheck,
    tribeSlack: o.detTribeSlack,
  });
}
