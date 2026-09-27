import {
  Player,
  PlayerID,
  PlayerType,
  Relation,
} from "../../../../core/game/Game";
import {
  friendPoints,
  goldChunk,
} from "../../../agents/apex/controllers/DiplomacyController";
import type { DirectiveStep } from "../../../agents/apex/state";
import { Prio } from "../../Scheduler";
import type {
  BaseView,
  Candidate,
  CandidateGenerator,
  SearchView,
} from "../Registry";

// Package WP3 (docs/14-m4-plan.md §2.4, §3 WP3): keep:Z and keep:Z+gift,
// the plans that keep an ally the web would let lapse (Tunica on
// Mississippi g10, Lucerne and Veneto on Alps g2 at minute 22, Thailand on
// World g0: each came off its alliance unasked and attacked us within 40
// ticks, while no plan of the search could keep it).
//
// keep:Z, for a bordering ally Z expiring within searchLapseLead ticks:
// - its extension (`allianceExtension`, key `ext:<id>`, as the web asks)
//   at the expiry − extendLead, the web's own lead, while still allied. The
//   nation re-decides a pending extension at each of its decisions until
//   the expiry, in full, with us counted as its bordering friend
//   (NationAllianceBehavior.handleAllianceExtensionRequests; PIN
//   NationAlliance);
// - if the alliance lapses anyway, a fresh request (`allianceRequest`, key
//   `ally:<id>`, as the web's renew) at the expiry + 1: PlayerExecution
//   expires an alliance in game tick e (expiresAt <= ticks), so from live
//   tick e + 1 on it is gone. The request is decided afresh at the nation's
//   next decision, with one alliance fewer (hasTooManyAlliances passes
//   where the extension failed at A_max) and without the extension trap.
// - first, if a plan of ours marked Z a foe (a lapse's mark vetoes
//   `ext:<id>` and `ally:<id>`), a foe step ending the mark (`until` before
//   its tick; `replace` keeps the marks in force).
// Made for strong allies only (troops ≥ searchKeepMinShare of our home, or
// a cap ≥ KEEP_CAP_RATIO × ours: a nation land-attacks us once unallied
// while our home is below its troops over 1.1, and no home deters a cap
// that large, plan §1.4), outside the web's keep list (s.web.allySet: the
// web asks the extension of the allies in it at the same lead).
//
// keep:Z+gift (searchKeepGift): the same with a gold gift before the
// extension (DiplomacyController's pricing, B2's): friendPoints of relation
// at the tick it pays, which holds Z Friendly (≥ 50, decay 0.05 a tick)
// until FRIENDLY_PAST ticks past the expiry, bought in chunks of goldChunk
// priced for a payment up to GIFT_PAY_WITHIN ticks late. A Friendly nation
// accepts 67% of the time at each decision, before checkAlreadyEnough-
// Alliances and the strength tests, after hasTooManyAlliances [PIN
// FriendDonation]; an extension refused as too many alliances becomes a
// renewal decided with one fewer. Made for any strong expiring ally, kept
// by the web or not, whose extension forecast (the search's private
// NationModel) is below searchKeepGiftP and not "traitor", while its
// relation band is Neutral (Friendly needs no gift; below Neutral +100 may
// not reach it), it is not embargoed, and the gold is at most
// searchKeepGiftShare of ours.
//
// Every step is read at its tick through the same Scheduler as the web's
// sends, so a keep and the web's own extension of the same ally dedupe by
// key. Both plans judge at the renewal + searchH, as a lapse (its strike at
// the expiry + 2) does.

/** The renewal goes this many ticks after the expiry (the first live tick
 *  that sees the alliance gone). */
export const RENEW_DELAY = 1;
/** A cap this many times ours makes an ally strong (plan §1.4, §2.0b). */
export const KEEP_CAP_RATIO = 1.1;
/** The gift keeps the ally Friendly this many ticks past the expiry (for
 *  the renewal, answered at the nation's next decision; DiplomacyController
 *  FRIEND_PAST_EXPIRY). */
export const FRIENDLY_PAST = 60;
/** A gift is priced as if it paid this many ticks after it is sent
 *  (DiplomacyController GIFT_PAY_WITHIN: the chunk grows with the tick). */
export const GIFT_PAY_WITHIN = 20;
/** The gift goes this many ticks before the extension, so that the
 *  nation's decisions from the extension on see it paid (a donation pays
 *  in the turn after the one it is sent in). */
export const GIFT_LEAD = 2;
/** Relation per gold chunk, and the first Friendly value (DonateGold-
 *  Execution.calculateRelationUpdate, PlayerImpl.relationFromValue). */
const GOLD_POINTS = 5;
const FRIENDLY_FROM = 50;

/** A foe step ending `id`'s foe mark now, if a plan of ours set one that
 *  still holds (none otherwise). */
export function foeClear(sv: SearchView, id: PlayerID): DirectiveStep[] {
  const until = sv.host.state.search.foes[id];
  if (until === undefined || until < sv.t) return [];
  return [{ at: sv.t, label: `unfoe ${id}`, foe: { id, until: sv.t - 1 } }];
}

/** The extension step (the web's proposal). */
export function extensionStep(id: PlayerID, at: number): DirectiveStep {
  return {
    at,
    label: `extend ${id}`,
    when: { allied: id },
    p: {
      intent: { type: "allianceExtension", recipient: id },
      prio: Prio.Diplomacy,
      cls: "diplomacy",
      key: `ext:${id}`,
    },
  };
}

/** The renewal step after a lapse (the web's renew proposal). */
export function renewStep(id: PlayerID, at: number): DirectiveStep {
  return {
    at,
    label: `renew ${id}`,
    when: { unallied: id },
    p: {
      intent: { type: "allianceRequest", recipient: id },
      prio: Prio.Recall,
      cls: "defense",
      key: `ally:${id}`,
    },
  };
}

/** The gift step (B2's proposal). */
export function giftStep(id: PlayerID, at: number, gold: bigint): DirectiveStep {
  return {
    at,
    label: `gift ${id} ${gold}`,
    when: { allied: id },
    p: {
      intent: { type: "donate_gold", recipient: id, gold: Number(gold) },
      prio: Prio.Diplomacy,
      cls: "diplomacy",
      key: `donate:${id}`,
    },
  };
}

/** Whether `N` is strong for a keep plan (see the header). */
export function strongAlly(sv: SearchView, N: Player): boolean {
  const share = sv.o.searchKeepMinShare;
  if (share <= 0) return true;
  if (N.troops() >= share * sv.me.troops()) return true;
  const cfg = sv.game.config();
  return cfg.maxTroops(N) >= KEEP_CAP_RATIO * cfg.maxTroops(sv.me);
}

/**
 * The gold gift that holds `N` Friendly from its payment (sent at `at`,
 * paid at `at + 1`) through `until`, or null: at most +100 relation, while
 * its band is Neutral, not embargoed, donations allowed. `r` is the
 * relation estimate at the payment, clamped into Neutral as the web's
 * gifts clamp it.
 */
export function keepGift(
  sv: SearchView,
  N: Player,
  at: number,
  until: number,
  r: number,
): { gold: bigint; points: number } | null {
  const { me, game } = sv;
  if (N.relation(me) !== Relation.Neutral) return null;
  if (me.hasEmbargoAgainst(N) || !me.canDonateGold(N)) return null;
  const paid = at + 1;
  const rel = Math.min(FRIENDLY_FROM - 1, Math.max(0, r));
  const points = friendPoints(rel, paid, until);
  if (points === null) return null;
  const gold =
    BigInt(points / GOLD_POINTS) * goldChunk(game, at + GIFT_PAY_WITHIN);
  return { gold, points };
}

/** What a keep plan needs to know of its ally. */
export interface KeepTarget {
  N: Player;
  /** The alliance's expiry. */
  e: number;
}

/**
 * keep:<id> (unless `plain` is false) and keep:<id>+gift (under the gift's
 * conditions) for ally `k` at the search: the steps and what the rounds
 * read. Empty when the alliance is gone or ends this tick.
 */
export function keepCandidates(
  sv: SearchView,
  k: KeepTarget,
  plain: boolean,
): Candidate[] {
  const { o, t, me } = sv;
  const { N, e } = k;
  const id = N.id();
  if (e <= t || !me.isAlliedWith(N)) return [];
  const askAt = Math.max(t, e - o.extendLead);
  const renewAt = e + RENEW_DELAY;
  const base = (name: string, steps: DirectiveStep[]): Candidate => ({
    name,
    kind: "keep",
    target: id,
    steps,
    lastSend: renewAt - t,
    isBreak: false,
    strongCheck: false,
    defensive: true,
  });
  const out: Candidate[] = [];
  const unfoe = foeClear(sv, id);
  if (plain) {
    out.push(
      base(`keep:${id}`, [
        ...unfoe,
        extensionStep(id, askAt),
        renewStep(id, renewAt),
      ]),
    );
  }
  if (o.searchKeepGift) {
    const nm = sv.host.nationModel();
    const giftAt = Math.max(t, askAt - GIFT_LEAD);
    if (nm !== null) {
      const f = nm.acceptsAlliance(id, {
        kind: "extension",
        createdAt: askAt,
        atTick: nm.nextDecision(id, askAt + 1),
        embargoStoppedBy: null,
      });
      // Friendship cannot beat our treachery (refused 90% first). Refused
      // for the 25% rule it still helps the renewal, decided with one
      // alliance fewer (B2: 7 of 9 gifts were so, and all 7 renews passed).
      if (f.p < o.searchKeepGiftP && f.branch !== "traitor") {
        const g = keepGift(
          sv,
          N,
          giftAt,
          e + FRIENDLY_PAST,
          nm.relations.value(id, giftAt + 1),
        );
        if (
          g !== null &&
          Number(g.gold) <= o.searchKeepGiftShare * Number(me.gold())
        ) {
          out.push(
            base(`keep:${id}+gift`, [
              ...unfoe,
              giftStep(id, giftAt, g.gold),
              extensionStep(id, askAt),
              renewStep(id, renewAt),
            ]),
          );
        }
      }
    }
  }
  return out;
}

export const KEEP: CandidateGenerator = {
  name: "keep",
  phase: "r1",
  kinds: ["keep"],
  generate(sv: SearchView, _base: BaseView): Candidate[] {
    const { o, game, me, t, kinds } = sv;
    if (!o.searchKeep || !kinds.has("keep")) return [];
    const keepList = new Set(sv.host.state.web.allySet);
    const out: Candidate[] = [];
    // The bordering allies by contact, as the core's nations (ties: the
    // scan's ascending smallID).
    const nations = sv.wm.nations
      .filter((n) => n.type === PlayerType.Nation && game.hasPlayer(n.id))
      .filter((n) => n.contact >= o.searchMinContact)
      .sort((a, b) => b.contact - a.contact);
    for (const n of nations) {
      const N = game.player(n.id);
      if (!N.isAlive()) continue;
      const al = me.allianceWith(N);
      if (al === null) continue;
      const e = al.expiresAt();
      if (e - t > o.searchLapseLead || e <= t) continue;
      if (!strongAlly(sv, N)) continue;
      out.push(...keepCandidates(sv, { N, e }, !keepList.has(n.id)));
    }
    return out;
  },
};
