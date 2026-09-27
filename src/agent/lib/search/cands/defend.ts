import { PlayerID, PlayerType } from "../../../../core/game/Game";
import type { DirectiveStep } from "../../../agents/apex/state";
import { Prio } from "../../Scheduler";
import type {
  BaseView,
  Candidate,
  CandidateGenerator,
  SearchView,
} from "../Registry";
import { foeClear, keepCandidates } from "./keep";

// Package WP3 (docs/14-m4-plan.md §2.4, §2.5 round 2b, §3 WP3): the
// defensive plans of round 2b, for the nations the base rollout shows
// attacking us anywhere in its horizon. The core's alliance requests come
// only from the attackers of the base's first searchH1 ticks (act3's rule):
// on Africa g11 at tick 9,600 the base showed Yemen, unallied with 2.55× our
// home, attacking at +403 and taking all our land by +600, and no plan
// asked it for an alliance. Round 2b runs when the base, by its longest
// horizon, shows a nation attacking us or a loss of over 10% of our tiles
// (Rounds.ts); its plans are rolled to that horizon (the SearchController
// buys each fork and look from the budget left, in this order).
//
// For each nation attacking us in the base, largest first attack first:
// - an ally at the search (it attacks once its alliance ends: Tunica on
//   Mississippi g10, every base rollout from tick 7,200 on): keep:N and
//   keep:N+gift (keep.ts), whatever the web's keep list, unless its attack
//   comes before the expiry (a betrayal no extension stops);
// - any other nation: an alliance request now, as the Defense recall
//   sends it: its foe mark (a plan of ours) cleared, our embargo on it
//   stopped (an embargo costs −20 relation at each decision that sees it;
//   a stop sent at s is seen from decision s + 2 on, NationModel
//   embargoMalus), and the request a tick later when the nation decides
//   in the next turn (the recall's rule). Named ally:N when those are the
//   core's steps exactly (then the core's plan of round 1 stands), else
//   ally:N:stop. Not made when it cannot pass: a request we cannot send
//   (pending, or in the 300-tick cooldown), or a forecast of 0 that no draw
//   changes (the private NationModel: too many alliances, a hostile
//   relation).
// Tribes (bots) never count: the Runner records nations and humans only.

/** The alliance request of an ally:N plan (the recall's proposal). */
export function requestStep(id: PlayerID, at: number): DirectiveStep {
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

/** An embargo stop (DefenseController.offerEmbargoStop's proposal). */
export function stopStep(id: PlayerID, at: number): DirectiveStep {
  return {
    at,
    label: `unembargo ${id}`,
    p: {
      intent: { type: "embargo", targetID: id, action: "stop" },
      prio: Prio.Recall,
      cls: "defense",
      key: `embargo:${id}`,
    },
  };
}

/** The ally plan for unallied attacker `id`, or null when it cannot
 *  pass (see the header). */
export function allyCandidate(sv: SearchView, id: PlayerID): Candidate | null {
  const { game, me, t } = sv;
  if (!game.hasPlayer(id)) return null;
  const N = game.player(id);
  if (!N.isAlive() || N.type() !== PlayerType.Nation) return null;
  if (me.isAlliedWith(N) || !me.canSendAllianceRequest(N)) return null;
  const unfoe = foeClear(sv, id);
  const stop = sv.o.embargoStop && me.hasEmbargoAgainst(N);
  const nm = sv.host.nationModel();
  // The recall's timing: a stop sent at t is seen from decision t + 2 on.
  const late =
    stop && nm !== null && nm.nextDecision(id, t + 1) < t + 2 ? 1 : 0;
  const at = t + late;
  if (nm !== null) {
    const f = nm.acceptsAlliance(id, {
      kind: "request",
      createdAt: at,
      atTick: nm.nextDecision(id, at + 1),
      embargoStoppedBy: stop ? t : null,
    });
    if (f.p === 0 && f.deterministic) return null;
  }
  const steps: DirectiveStep[] = [
    ...unfoe,
    ...(stop ? [stopStep(id, t)] : []),
    requestStep(id, at),
  ];
  const plain = unfoe.length === 0 && !stop;
  return {
    name: plain ? `ally:${id}` : `ally:${id}:stop`,
    kind: "ally",
    target: id,
    steps,
    lastSend: late,
    isBreak: false,
    strongCheck: false,
    defensive: true,
  };
}

export const DEFEND: CandidateGenerator = {
  name: "defend",
  phase: "r2b",
  kinds: ["ally", "keep"],
  generate(sv: SearchView, base: BaseView): Candidate[] {
    const { o, game, me, t, kinds } = sv;
    if (!o.searchDefend) return [];
    // Largest first attack first; then the earliest; then by id.
    const attackers = [...base.attackers]
      .map(([id, a]) => ({ id, ...a }))
      .sort((a, b) => b.troops - a.troops || a.h - b.h || cmp(a.id, b.id));
    const out: Candidate[] = [];
    for (const a of attackers) {
      if (!game.hasPlayer(a.id)) continue;
      const N = game.player(a.id);
      if (!N.isAlive() || N.type() !== PlayerType.Nation) continue;
      const al = me.allianceWith(N);
      if (al !== null) {
        if (!kinds.has("keep")) continue;
        const e = al.expiresAt();
        // Its attack before the expiry is a betrayal: no keep stops it.
        if (t + a.h < e) continue;
        out.push(...keepCandidates(sv, { N, e }, true));
        continue;
      }
      if (!kinds.has("ally")) continue;
      const c = allyCandidate(sv, a.id);
      if (c !== null) out.push(c);
    }
    return out;
  },
};

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
