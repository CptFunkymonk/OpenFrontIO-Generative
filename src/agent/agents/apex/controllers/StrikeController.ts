import { PlayerID, PlayerType } from "../../../../core/game/Game";
import type { NationModel } from "../../../lib/NationModel";
import { Prio } from "../../../lib/Scheduler";
import type { Controller, View } from "../policy";
import type { ApexState } from "../state";
import { inStall } from "./ExpansionController";

// Strikes on nations (spec §3.5 in M2, §5.2 in M4).
//
// M2, the stall strike (§3.5, §3.6.6 rule 3, §4 step 9): only with
// o.stallStrike (off by default) and only in stall mode, strike a bordering
// unallied nation N one tick after its decision (ctx.tick = d_prev + 1, so
// the attack runs rate − 1 ticks before N next decides) when a window says N
// cannot answer [PIN NationRetaliate: below its reserve it never answers,
// and while it borders free land it answers nothing]:
// - W1: troopsAt(N, d) < reserve·M at its next two decisions d1, d2
//   (the reserve gate returns before retaliate, AiAttackBehavior.ts:290);
// - W2: N borders free land now (a fresh full refresh) and NationModel.gates
//   says the free-land branch locks its decision d1 (:139-141).
// Stack S = min(purse.available("strike"), (T_N/tribeRatio)·tribeMargin),
// sent only if S ≥ T_N (ratio ≤ 1). tribeRatio is the 0.6 loss clamp of
// attackLogic. N's attacks on us are added on top: a new attack on N cancels
// them 1:1 at init [PIN AttackMerge]. With o.stallStrikeFromHome (not in
// the spec) S is every troop purse.available("strike") holds: in stall
// mode they idle at the cap, and the tribe clamp sent 30k of a 2.79M home
// (arena showcase, Mena). One strike per tick, on a nation with
// no plan or stack of ours. Top-ups are the ExpansionController's (§3.6.2,
// plans of kind "strike").
//
// It runs in onTick, not decide: the launch tick is exact, and a decide
// every o.thinkEvery ticks would miss it. The work is one modulo per
// bordering nation per tick except on a nation's decision tick + 1.
//
// M4 (§5.2) is not built: windows o.strikeWindows (E13), sizing with the
// answer, o.strikeFork, steering (o.steering, o.steerGoldShare, E14) and
// bombs (o.bombs, E15). decide() is their place.

/** Nations whose windows are evaluated per tick (each costs a full
 *  NationModel refresh, one N.nearby()). */
const STRIKE_EVALS = 2;

/** The window that makes a strike launched now unanswerable, or null. */
export interface StrikeWindowCheck {
  window: "W1" | "W2" | null;
  /** N's next two decisions after a launch now. */
  d1: number;
  d2: number;
  /** troopsAt(N, d1), troopsAt(N, d2), reserve·M. */
  T1: number;
  T2: number;
  reserveTroops: number;
}

/**
 * §3.5's windows for a strike on nation `id` sent at `tick` (it exists from
 * the end of turn `tick`, so N first sees it at its first decision after
 * `tick`). Refreshes N in full first, so bordersFreeLand is current.
 */
export function strikeWindow(
  nm: NationModel,
  id: PlayerID,
  tick: number,
  cap: number,
): StrikeWindowCheck {
  const st = nm.refresh(id, "full");
  const d1 = nm.nextDecision(id, tick + 1);
  const d2 = nm.nextDecision(id, d1 + 1);
  const reserveTroops = st.params.reserve * cap;
  const T1 = nm.troopsAt(id, d1);
  const T2 = nm.troopsAt(id, d2);
  let window: StrikeWindowCheck["window"] = null;
  if (T1 < reserveTroops && T2 < reserveTroops) window = "W1";
  else if (st.bordersFreeLand && nm.gates(id, d1) === "locked") window = "W2";
  return { window, d1, d2, T1, T2, reserveTroops };
}

/** Strike stack for a nation with `T` troops and `incoming` troops of
 *  attacks on us: min(available, (T/ratio)·margin + incoming), or all of
 *  `available` with o.stallStrikeFromHome; 0 when the part left after the
 *  1:1 cancel is below T (ratio > 1). */
export function strikeStack(
  T: number,
  incoming: number,
  available: number,
  o: { tribeRatio: number; tribeMargin: number; stallStrikeFromHome?: boolean },
): number {
  const want =
    o.stallStrikeFromHome === true
      ? available
      : (T / o.tribeRatio) * o.tribeMargin + incoming;
  const S = Math.floor(Math.min(available, want));
  return S - incoming >= T ? S : 0;
}

/**
 * Strikes on nations (spec §3.5 in M2, §5.2 in M4). Enabled by `o.strike`;
 * in M2 it does nothing unless `o.stallStrike` is on (step 9).
 */
export class StrikeController implements Controller {
  readonly name = "strike";

  onTick(v: View, s: ApexState): void {
    const { o } = v;
    if (!o.stallStrike || !inStall(s, v.tick, o)) return;
    let evals = 0;
    for (const info of v.wm.nations) {
      if (evals >= STRIKE_EVALS) return;
      if (info.type !== PlayerType.Nation) continue;
      if (info.friendly || !info.attackable) continue;
      // §5.0: a nation is either in allySet or a strike target.
      if (s.web.allySet.includes(info.id)) continue;
      const sid = info.smallID;
      const l = v.ledger;
      if (
        l.plan(sid) !== undefined ||
        l.stackOn(sid) > 0 ||
        l.retreatingOn(sid) > 0
      ) {
        continue;
      }
      // One tick after its decision: it decided in turn tick − 1.
      if (v.nm.nextDecision(info.id, v.tick - 1) !== v.tick - 1) continue;
      if (!v.game.hasPlayer(info.id)) continue;
      const N = v.game.player(info.id);
      if (!N.isAlive() || !v.me.sharesBorderWith(N)) continue;
      evals++;
      const w = strikeWindow(v.nm, info.id, v.tick, v.models.cap(N));
      if (w.window === null) continue;
      let incoming = 0;
      for (const a of v.wm.incoming) {
        if (a.attackerSmallID === sid) incoming += a.troops;
      }
      const T = N.troops();
      const S = strikeStack(T, incoming, v.purse.available("strike"), o);
      if (S <= 0) continue;
      const accepted = v.scheduler.offer({
        intent: { type: "attack", targetID: info.id, troops: S },
        prio: Prio.Strike,
        cls: "strike",
        key: `attack:${sid}`,
        spend: { kind: "strike", troops: S },
        plan: "strike",
        meta: {
          target: sid,
          clampTroops: (T / o.tribeRatio) * o.tribeMargin,
          expectedRefund: 0,
        },
      });
      if (!accepted) return;
      v.log?.(
        `${v.tick} strike ${info.id} ${w.window} S=${S} T=${Math.round(T)} ` +
          `T(d1=${w.d1})=${Math.round(w.T1)} T(d2=${w.d2})=${Math.round(w.T2)} ` +
          `reserve=${Math.round(w.reserveTroops)}`,
      );
      return;
    }
  }

  decide(v: View, s: ApexState): void {
    // M4 (§5.2): windows o.strikeWindows (E13), sizing with the answer,
    // o.strikeFork, steering (o.steering, o.steerGoldShare, E14), bombs
    // (o.bombs, E15). Nothing in M2.
    void v;
    void s;
  }
}
