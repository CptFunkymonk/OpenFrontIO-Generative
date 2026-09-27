import { PlayerID, PlayerType } from "../../../../core/game/Game";
import type { DirectiveStep } from "../../../agents/apex/state";
import { Prio } from "../../Scheduler";
import type { NeighborInfo } from "../../WorldModel";
import type {
  BaseView,
  Candidate,
  CandidateGenerator,
  SearchView,
} from "../Registry";

// Package WP2 (docs/14-m4-plan.md §2.4): the core candidates, ported from
// the act3 prototype (/tmp/claude-0/search-wt3, SearchProbe.ts,
// candidates2) so that the search replays it:
// - the bordering nations with at least searchMinContact contact pairs,
//   plus every nation whose attacks reach us in the base rollout's first
//   searchH1 ticks, by contact (ties: ascending smallID), until searchK are
//   counted:
//   - unallied and attackable: strike:N:f, attack N now with share f of
//     purse.available("strike") at the send, f in searchFracs (counts 1);
//   - allied, expiring within searchLapseLead ticks: lapse:N:1, a foe mark
//     from the next tick to the expiry + 900 (no extension, request or
//     counter-accept), then attack N with the whole purse at the expiry + 2
//     (counts 1);
//   - allied: break:N:f, break the alliance now and attack N the next tick
//     with share f (counts 1 for all shares; so an expiring ally with both
//     counts 2, as in act3);
// - ally:N, an alliance request now, to each nation in the base's first
//   ticks' attackers we are not allied with, in the order they attacked.
// Humans are never candidates (act3's filter is PlayerType.Nation).

/** The foe mark of a lapse holds this many ticks past the expiry. */
export const LAPSE_FOE_TICKS = 900;
/** A lapse strikes this many ticks after the expiry. */
export const LAPSE_STRIKE_DELAY = 2;
/** A break's foe-mark variant (searchBreakFoe) holds this long. */
export const BREAK_FOE_TICKS = 900;

/** An attack on `id` sized at the send as share `frac` of the strike
 *  purse (the directive sets its troops, spend and clamp). */
export function attackStep(
  id: PlayerID,
  smallID: number,
  at: number,
  frac: number,
): DirectiveStep {
  return {
    at,
    frac,
    label: `attack ${id} ${frac}`,
    p: {
      intent: { type: "attack", targetID: id, troops: 1 },
      prio: Prio.Strike,
      cls: "strike",
      key: `attack:${smallID}`,
      spend: { kind: "strike", troops: 1 },
      plan: "strike",
      meta: { target: smallID, clampTroops: 1, expectedRefund: 0 },
    },
  };
}

export function breakStep(id: PlayerID, at: number): DirectiveStep {
  return {
    at,
    label: `break ${id}`,
    p: {
      intent: { type: "breakAlliance", recipient: id },
      prio: Prio.Diplomacy,
      cls: "diplomacy",
      key: `break:${id}`,
    },
  };
}

export function allyStep(id: PlayerID, at: number): DirectiveStep {
  return {
    at,
    label: `ally ${id}`,
    p: {
      intent: { type: "allianceRequest", recipient: id },
      prio: Prio.Recall,
      cls: "defense",
      key: `ally:${id}`,
    },
  };
}

/** Troops of `n`'s attacks on us now. */
function incomingFrom(sv: SearchView, n: NeighborInfo): number {
  let inc = 0;
  for (const a of sv.me.incomingAttacks()) {
    if (a.attacker().id() === n.id) inc += a.troops();
  }
  return inc;
}

export const CORE: CandidateGenerator = {
  name: "core",
  phase: "r1",
  kinds: ["strike", "lapse", "break", "ally"],
  generate(sv: SearchView, base: BaseView): Candidate[] {
    const { o, game, me, t, kinds } = sv;
    const out: Candidate[] = [];
    const attackers = base.attackers;
    const nations = sv.wm.nations
      .filter((n) => n.type === PlayerType.Nation && game.hasPlayer(n.id))
      .filter((n) => n.contact >= o.searchMinContact || attackers.has(n.id))
      .sort((a, b) => b.contact - a.contact);
    const avail = sv.host.available("strike");
    let k = 0;
    for (const n of nations) {
      if (k >= o.searchK) break;
      const N = game.player(n.id);
      if (!N.isAlive()) continue;
      const al = me.allianceWith(N);
      if (al === null) {
        if (!n.attackable) continue;
        k++;
        if (!kinds.has("strike")) continue;
        const need = N.troops() + incomingFrom(sv, n);
        for (const f of o.searchFracs) {
          out.push({
            name: `strike:${n.id}:${f}`,
            kind: "strike",
            target: n.id,
            steps: [attackStep(n.id, n.smallID, t, f)],
            lastSend: 0,
            isBreak: false,
            strongCheck: true,
            frac: f,
            defensive: false,
            gate: { S: Math.floor(f * avail), need },
          });
        }
        continue;
      }
      const left = al.expiresAt() - t;
      if (kinds.has("lapse") && left <= o.searchLapseLead) {
        k++;
        const strikeAt = left + LAPSE_STRIKE_DELAY;
        out.push({
          name: `lapse:${n.id}:1`,
          kind: "lapse",
          target: n.id,
          // act3 recorded the foe mark in its search tick's run after that
          // run's veto, so it held from the next tick (WP1's port).
          steps: [
            {
              at: t + 1,
              foe: { id: n.id, until: al.expiresAt() + LAPSE_FOE_TICKS },
            },
            attackStep(n.id, n.smallID, t + strikeAt, 1),
          ],
          lastSend: strikeAt,
          isBreak: false,
          strongCheck: true,
          frac: 1,
          defensive: true,
        });
      }
      if (kinds.has("break")) {
        k++;
        for (const f of o.searchFracs) {
          const steps: DirectiveStep[] = [breakStep(n.id, t)];
          if (o.searchBreakFoe) {
            steps.push({
              at: t,
              foe: { id: n.id, until: t + BREAK_FOE_TICKS },
            });
          }
          steps.push(attackStep(n.id, n.smallID, t + 1, f));
          out.push({
            name: `break:${n.id}:${f}${o.searchBreakFoe ? "+foe" : ""}`,
            kind: "break",
            target: n.id,
            steps,
            lastSend: 1,
            isBreak: true,
            strongCheck: false,
            frac: f,
            defensive: false,
          });
        }
      }
    }
    if (kinds.has("ally")) {
      for (const [id] of attackers) {
        if (!game.hasPlayer(id)) continue;
        const N = game.player(id);
        if (N.type() !== PlayerType.Nation || !N.isAlive()) continue;
        if (me.isAlliedWith(N)) continue;
        out.push({
          name: `ally:${id}`,
          kind: "ally",
          target: id,
          steps: [allyStep(id, t)],
          lastSend: 0,
          isBreak: false,
          strongCheck: false,
          defensive: true,
        });
      }
    }
    return out;
  },
};
