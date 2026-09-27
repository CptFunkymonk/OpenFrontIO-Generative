import {
  Difficulty,
  Player,
  PlayerID,
  PlayerType,
  Relation,
} from "../../../../core/game/Game";
import {
  AllySlots,
  allySlots,
  OwnerGrid,
  ownerSampleTile,
  RaceGrid,
  reachCells,
} from "../../../lib/RaceField";
import { Prio } from "../../../lib/Scheduler";
import type { Controller, View } from "../policy";
import { ApexState, NEVER } from "../state";
import { offerEmbargoStop, stopInFlight } from "./DefenseController";
import { finishedCityLevels } from "./EconomyController";
import { inStall } from "./ExpansionController";

// The alliance web, food list, counter-accept, extensions (spec §3.4).
// Enabled by `o.diplomacy`.
//
//   §3.4.1 slots           A_max = ceil(0.25·N), A_ext = A_max − 1, webTarget
//                          = A_ext − o.allySlotsReserve (RaceField.allySlots)
//   §3.4.2 plan            every o.planEvery ticks and at allyFromTick: reach,
//                          danger, s.web.allySet (ranked by o.webRank) and
//                          s.web.food (o.foodList)
//   §3.4.3 requests        (o.web) from numSpawnPhaseTurns() + 2, to allySet
//                          nations whose forecast p >= o.allyMinP, up to
//                          webTarget alliances, o.allyPerSecond a second
//   §3.4.4 counter-accept  (o.counterAccept, every tick) nations outside the
//                          food list while alliances < A_max
//   §3.4.5 extensions      (o.extensions) allies still in allySet, once,
//                          o.extendLead ticks before expiry
//   §3.4.6 never           breakAlliance, requests to tribes, targetPlayer or
//                          insulting emojis: this controller sends none
//   §5.1.1 midgame web     (o.webMidgame, from o.webFrom; package B2) the plan
//                          keeps the reachable nations of highest dmid (their
//                          stack against the home we hold, a peak with
//                          hysteresis) allied, up to A_ext: requests and
//                          counter-accepts that never take us past A_ext
//                          (midCeiling), extensions of allies kept for
//                          webExtendStable ticks, a renew request at a
//                          lapse, gold for friendship before a refused
//                          extension of a dangerous bordering ally expires;
//                          every other ally lapses (never a break). The logs
//                          name every alliance change (`dip ally+/~/-`).
//
// The recall (§3.3.2) is the DefenseController's; both take the dedupe key
// `ally:<id>`, so no nation gets two requests in a tick. Slots: requests from
// nations are answered by the nation, which refuses us once our alliances
// reach 0.25·N (hasTooManyAlliances), so only our own acceptances
// (counter-accepts) can pass A_max, and they are held below it.

/** Package A1 (review F2): a strike of ours runs on the nation, or an
 *  attack on it was offered this tick. */
function underStrike(v: View, sid: number): boolean {
  return (
    v.ledger.plan(sid)?.kind === "strike" || v.scheduler.hasKey(`attack:${sid}`)
  );
}

/** Package A1 (review F2): our troops out on strikes. */
function strikeTroops(v: View): number {
  let out = 0;
  for (const p of v.ledger.allPlans()) {
    if (p.kind === "strike") out += v.ledger.stackOn(p.targetSmallID);
  }
  return out;
}

/** §3.4.2: land is projected this many ticks ahead. */
const GROWTH_HORIZON = 600;
/** Most projected relative growth over the horizon (land at most ×4). The
 *  opening grows 50× in its first 100 ticks; unclamped, every projection
 *  would be absurd and the ranking noise. */
const GROWTH_CAP = 3;
/** EMA weight of the newest growth sample (one per plan). */
const GROWTH_EMA = 0.5;
/** §3.9: allyReachCells null means ceil(REACH_TILES / cell). */
const REACH_TILES = 150;
/** Most alliance forecasts per decision (each may do one lazy full
 *  NationModel refresh). */
const MAX_FORECASTS = 6;
/** o.webFriend: DonateTroopsExecution.getMinTroopsForRelationUpdate
 *  (DonateTroopExecution.ts:99-129) draws the troops a donation needs for
 *  its +50 as nextInt(M/a, M/b), M the recipient's maxTroops; b per
 *  difficulty (not in Config), so a donation of ceil(M/b) + 1 always
 *  passes. */
const FRIEND_DIVISOR: Record<Difficulty, number> = {
  [Difficulty.Easy]: 11,
  [Difficulty.Medium]: 9,
  [Difficulty.Hard]: 7,
  [Difficulty.Impossible]: 5,
};
/** o.webFriend: the relation a large enough troop donation buys
 *  (DonateTroopExecution.ts:73). */
const TROOP_GIFT_POINTS = 50;
/** o.webFriend: the donation is cut to the recipient's cap headroom at
 *  its init (DonateTroopExecution.ts:52-56); keep this much slack for the
 *  regrowth before then. */
const FRIEND_HEADROOM = 1.05;
/** o.webFriendGold: DonateGoldExecution.getGoldChunkSize
 *  (DonateGoldExecution.ts:101-115), the gold one +5 buys before the time
 *  multiplier, per difficulty (private there, not in Config). */
const GOLD_CHUNK: Record<Difficulty, number> = {
  [Difficulty.Easy]: 2_500,
  [Difficulty.Medium]: 5_000,
  [Difficulty.Hard]: 12_500,
  [Difficulty.Impossible]: 25_000,
};
/** DonateGoldExecution.calculateRelationUpdate (:117-133): +5 per whole
 *  chunk, at most +100; the chunk grows by chunk·t/(3,000 +
 *  numSpawnPhaseTurns()), t the tick it pays in. */
const GOLD_POINTS = 5;
const GOLD_MAX_POINTS = 100;
const GOLD_PERIOD = 3_000;
/** Relation decay per tick toward 0 (PlayerImpl.decayRelations), and the
 *  value from which a relation is Friendly (PlayerImpl.relationFromValue). */
const RELATION_DECAY = 0.05;
const FRIENDLY_FROM = 50;
/** o.webFriendGold: Friendly is bought until this many ticks past the
 *  expiry, for the renew sent the tick we see the lapse and answered at
 *  the nation's next decision (at most 49 ticks later). */
const FRIEND_PAST_EXPIRY = 60;
/** o.webFriendGold: a gift is priced as if it paid this many ticks after
 *  it is sent. The chunk grows about 8 gold a tick (25,000/3,100 at
 *  Impossible), so k chunks priced for one tick later buy only k − 1 when
 *  the intent lands two or more turns late (the browser autopilot's
 *  latency); 20 ticks cost about 0.2% more gold. */
const GIFT_PAY_WITHIN = 20;
/** o.webBoatReach: an islander sends its boats at the nearest of the
 *  players it can reach, by the centres of their largest clusters, and one
 *  time in 3 at the second nearest (AiAttackBehavior.findNearestIslandEnemy:
 *  a literal there, not a Config value). */
const ISLAND_NEAREST = 2;
/** o.webKeepFeasible: request forecasts per plan (each may do one lazy full
 *  NationModel refresh); candidates past them are kept unchecked
 *  (requests forecast again before sending). */
const MID_FORECASTS = 4;
/** Ticks between two `dip mid` lines while the keep set stays the same. */
const MID_LOG_EVERY = 300;
/** o.webRenew: ticks past an alliance's expiry that its renew entry waits
 *  while the alliance is still seen. */
const RENEW_WAIT = 10;
/** o.webDiag: ticks between two `dip web` lines, the nations listed, and
 *  the smallest troops (a share of our home) listed. */
const DIAG_EVERY = 300;
const DIAG_ROWS = 6;
const DIAG_MIN_SHARE = 0.3;

/** Our memory, declared here rather than in state.ts (another engineer's
 *  file); created on first use, plain data. */
export interface DiplomacyMemory {
  /** Land growth per player (us included): tiles and tick at the last
   *  plan, and the EMA of relative growth per tick (null: one sample). */
  growth: Record<PlayerID, { tiles: number; at: number; g: number | null }>;
  /** The last plan's danger per reached nation (logs and tests). */
  danger: Record<PlayerID, number>;
  /** Our alliances as the last decision saw them: nation id -> expiry
   *  (watchAlliances; logs and the midgame web). */
  allies?: Record<PlayerID, number>;
  /** Tick of the last o.webDiag line. */
  diagAt?: number;
  /** o.webDiag: the expiry each let-lapse line was logged for. */
  lapseLogged?: Record<PlayerID, number>;
  /** o.webMidgame: the last midgame plan (planMid). */
  mid?: MidPlan;
  /** o.webBoatReach: shoreOwners of the OwnerGrid with this stamp, and
   *  the owners next to each owner's blocks (blockNeighbours). */
  shore?: { stamp: number; ids: number[]; next: Record<number, number[]> };
  /** o.webExtendStable: the tick since which each nation has been in
   *  every plan's keep set (removed when a plan leaves it out). */
  keptSince?: Record<PlayerID, number>;
  /** o.webRenew: the expiry of each kept alliance, for the renew request
   *  at its lapse (set each decision from the alliances held). */
  renew?: Record<PlayerID, number>;
  /** o.webFriendGold: the expiry each ally got its gift for (one a term). */
  gifts?: Record<PlayerID, number>;
  /** o.webFriendGold: gifts sent and not yet seen: the send tick and the
   *  relation they buy (RelationTracker.onEvent once seen, see onTick). */
  giftsPending?: Record<PlayerID, { at: number; points: number }>;
  /** o.webFriendGold: the expiry an unaffordable gift was logged for. */
  giftsSkipped?: Record<PlayerID, number>;
  /** The keep set of the last `dip mid` line, and its tick (logs only). */
  midLogged?: { keep: string; at: number };
  /** o.webPeakKeep: each nation's peak dmid, as of the last plan. */
  peak?: Record<PlayerID, number>;
  stats: {
    plans: number;
    requests: number;
    counters: number;
    extensions: number;
    /** Alliances that ended: at their expiry, or before it (a break). */
    lapsed?: number;
    broken?: number;
    extended?: number;
    /** o.webRenew requests sent. */
    renews?: number;
    /** o.webFriend donations sent. */
    gifts?: number;
    /** o.webFriendGold donations sent, and their gold. */
    goldGifts?: number;
    goldGiven?: number;
  };
}

/** o.webMidgame's plan (planMid), plain data. */
export interface MidPlan {
  at: number;
  /** Reachable nations with dmid ≥ webDangerMin (strike targets left out),
   *  most dangerous first. */
  rank: PlayerID[];
  /** The top `slots` of rank: the nations the web keeps allied. */
  keep: PlayerID[];
  /** dmid of every reachable nation (logs and tests). */
  dmid: Record<PlayerID, number>;
  /** Nations the midgame web keeps: A_max (webSlotsMax), else A_ext less
   *  the spare (webSlotSpare), at least 1. */
  slots: number;
  /** Ranked unallied nations left out of keep: a request now could not be
   *  sent or would be refused (o.webKeepFeasible). */
  infeasible: PlayerID[];
}

/** Whether the midgame web runs at tick t (o.webMidgame from o.webFrom). */
export function midActive(v: Pick<View, "o" | "tick">): boolean {
  return v.o.webMidgame && v.tick >= v.o.webFrom;
}

/**
 * o.webMidgame: the most alliances the web's own additions (its requests
 * and counter-accepts) may reach. A nation refuses every request and
 * extension of ours from A_max alliances on (hasTooManyAlliances, our
 * alliances ≥ 0.25·N), so a kept ally's extension passes only while we
 * hold A_ext or fewer: A_ext. A_max with webSlotsMax (extensions are left
 * to the renew then) or where A_ext is 0 (a lone alliance never extends).
 * Arena quick@20 (v2, which could fill A_max): apex sat above A_ext in 45%
 * of midgame plans, and 84 of the 124 kept alliances that lapsed with the
 * extension refused had been asked there.
 */
export function midCeiling(
  o: Pick<View["o"], "webSlotsMax">,
  slots: AllySlots,
): number {
  return o.webSlotsMax || slots.ext === 0 ? slots.max : slots.ext;
}

/** Whether a strike feature that eats nations is on (o.webLapseTarget
 *  lets a kept ally lapse only then): the window strikes (o.strikes), the
 *  stall strike or the spec's strike windows. */
function strikesOn(v: Pick<View, "o">): boolean {
  return v.o.strikes || v.o.stallStrike || v.o.strikeWindows.length > 0;
}

/** o.webFriendGold: the gold chunk that buys +5 when a donation pays at
 *  tick `paid` (DonateGoldExecution.calculateRelationUpdate). */
export function goldChunk(game: View["game"], paid: number): bigint {
  const cfg = game.config();
  const base = GOLD_CHUNK[cfg.gameConfig().difficulty];
  const mult = paid / (GOLD_PERIOD + cfg.numSpawnPhaseTurns());
  return BigInt(Math.round(base + base * mult));
}

/**
 * o.webFriendGold: the relation points (a multiple of 5, at most 100) that
 * keep a nation at relation `r` when paid Friendly through tick `until`
 * (decay 0.05 a tick from `paid`), or null if +100 is not enough.
 */
export function friendPoints(
  r: number,
  paid: number,
  until: number,
): number | null {
  const need =
    FRIENDLY_FROM - r + RELATION_DECAY * Math.max(0, until - paid) + 0.01;
  const points = Math.max(
    GOLD_POINTS,
    Math.ceil(need / GOLD_POINTS) * GOLD_POINTS,
  );
  return points > GOLD_MAX_POINTS ? null : points;
}

/** SmallIDs of the players owning an OwnerGrid block whose race cell, or
 *  one of its 8 neighbours, holds an ocean-shore tile (o.webBoatReach): a
 *  coarse "can launch and receive boats" (a block's sample is its middle
 *  tile, rarely the shore tile itself). */
export function shoreOwners(
  og: OwnerGrid,
  race: RaceGrid,
  game: View["game"],
): Set<number> {
  const out = new Set<number>();
  const n = og.ow * og.oh;
  const { cell, cw, ch, shore } = race;
  for (let b = 0; b < n; b++) {
    const id = og.owner[b];
    if (id <= 0 || out.has(id)) continue;
    const t = ownerSampleTile(og, game, b);
    const cx = Math.floor(game.x(t) / cell);
    const cy = Math.floor(game.y(t) / cell);
    search: for (
      let y = Math.max(0, cy - 1);
      y <= Math.min(ch - 1, cy + 1);
      y++
    ) {
      for (let x = Math.max(0, cx - 1); x <= Math.min(cw - 1, cx + 1); x++) {
        if (shore[y * cw + x] === 1) {
          out.add(id);
          break search;
        }
      }
    }
  }
  return out;
}

/**
 * smallID -> the owners of the OwnerGrid blocks next to its blocks (the 8
 * neighbours; 0 for unowned land; water and its own blocks left out),
 * ascending (o.webBoatReach's islander test). Coarse like the grid: a
 * border thinner than a block can hide.
 */
export function blockNeighbours(og: OwnerGrid): Map<number, number[]> {
  const { ow, oh, owner } = og;
  const sets = new Map<number, Set<number>>();
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const id = owner[y * ow + x];
      if (id <= 0) continue;
      let set = sets.get(id);
      if (set === undefined) {
        set = new Set();
        sets.set(id, set);
      }
      for (let ny = Math.max(0, y - 1); ny <= Math.min(oh - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(ow - 1, x + 1); nx++) {
          const o = owner[ny * ow + nx];
          if (o >= 0 && o !== id) set.add(o);
        }
      }
    }
  }
  const out = new Map<number, number[]>();
  for (const [id, set] of sets)
    out.set(
      id,
      [...set].sort((a, b) => a - b),
    );
  return out;
}

/**
 * o.webBoatReach: whether nation N, which cannot reach us by land, would
 * send its boats at us (AiAttackBehavior.ts). Past free land and its
 * bordering enemies, a nation picks player targets from those it borders,
 * except `island`: with no bordering enemy (every player it borders is
 * friendly, and no free land) it boats at the nearest reachable players by
 * the centres of their largest clusters, the second one time in 3, in FFA
 * only players with fewer troops than it (findNearestIslandEnemy). So: N is
 * an islander on the OwnerGrid (every neighbouring owner friendly to it;
 * `next` from blockNeighbours), and we are among its ISLAND_NEAREST nearest
 * ocean-shore players that it is not friendly with (us always, as if our
 * alliance had lapsed; others only while they hold fewer troops than it).
 * Its random boats land within 150 tiles of its shore, inside the land
 * reach (§3.4.2 counts water), so they need no boat reach.
 */
export function islandThreat(
  game: View["game"],
  me: Player,
  N: Player,
  next: readonly number[] | undefined,
  shore: ReadonlySet<number>,
): boolean {
  if (next === undefined) return false;
  for (const id of next) {
    if (id === 0) return false;
    const p = game.playerBySmallID(id);
    if (!p.isPlayer() || !N.isFriendly(p)) return false;
  }
  const at = centre(N);
  if (at === null) return false;
  const ours = centre(me);
  if (ours === null) return false;
  const dist = (c: { x: number; y: number }) =>
    Math.abs(c.x - at.x) + Math.abs(c.y - at.y);
  const dUs = dist(ours);
  let closer = 0;
  const T = N.troops();
  for (const p of game.players()) {
    if (p === N || p === me || !shore.has(p.smallID())) continue;
    if (N.isFriendly(p) || p.troops() >= T) continue;
    const c = centre(p);
    if (c === null) continue;
    const d = dist(c);
    if (d < dUs || (d === dUs && p.smallID() < me.smallID())) {
      if (++closer >= ISLAND_NEAREST) return false;
    }
  }
  return true;
}

/**
 * o.webMidgame: alliance requests sent this tick (s.web.requested at t: the
 * recall, a renew, a counter-accept, a web request) that the game does not
 * show yet, as a pending request or an alliance: intents run in the next
 * turn. Slot counts add them, so two sends in one tick (a renew in onTick,
 * a request in decide) cannot both take the last slot below the ceiling.
 */
export function sentThisTick(
  v: Pick<View, "game" | "me" | "tick">,
  s: ApexState,
): number {
  const { game, me, tick: t } = v;
  let n = 0;
  for (const [id, at] of Object.entries(s.web.requested)) {
    if (at !== t || !game.hasPlayer(id)) continue;
    const N = game.player(id);
    if (me.isAlliedWith(N)) continue;
    if (me.outgoingAllianceRequests().some((r) => r.recipient() === N)) {
      continue;
    }
    n++;
  }
  return n;
}

/** The centre of a player's largest cluster (AiAttackBehavior
 *  getPlayerCenter, Util.boundingBoxCenter; its border fallback, for a
 *  player PlayerExecution has not measured yet, is left out: null). */
function centre(p: Player): { x: number; y: number } | null {
  const box = p.largestClusterBoundingBox;
  if (box === null) return null;
  return {
    x: box.min.x + Math.floor((box.max.x - box.min.x) / 2),
    y: box.min.y + Math.floor((box.max.y - box.min.y) / 2),
  };
}

declare module "../state" {
  interface ApexState {
    /** DiplomacyController memory (DiplomacyController.ts). */
    diplomacy?: DiplomacyMemory;
  }
}

export function diplomacyMemory(s: ApexState): DiplomacyMemory {
  s.diplomacy ??= {
    growth: {},
    danger: {},
    stats: { plans: 0, requests: 0, counters: 0, extensions: 0 },
  };
  return s.diplomacy;
}

/** The first tick a request can be created without being refused as a
 *  spawn-phase request (NationAllianceBehavior.ts:64-70) [PIN C6]. */
export function allyFromTick(v: Pick<View, "game">): number {
  return v.game.config().numSpawnPhaseTurns() + 2;
}

interface Row {
  N: Player;
  id: PlayerID;
  sid: number;
  danger: number;
  contactShare: number;
  /** OwnerGrid cell distance; 0 for nations in me.nearby(). */
  dist: number;
}

export class DiplomacyController implements Controller {
  readonly name = "diplomacy";

  // ── §3.4.4 Counter-accept (every tick) ────────────────────────────────

  onTick(v: View, s: ApexState): void {
    if (midActive(v)) {
      const mem = diplomacyMemory(s);
      if (mem.giftsPending !== undefined) this.seeGifts(v, mem);
      if (v.o.webRenew) this.renew(v, s, mem);
      if (mem.mid !== undefined) {
        if (v.o.webFriendGold) this.goldFriends(v, mem, mem.mid);
        if (v.o.webFriend) this.friends(v, mem, mem.mid);
      }
    }
    this.counterAccept(v, s);
  }

  /**
   * o.webFriendGold (every tick): a bordering kept ally with dmid ≥
   * webFriendMinDanger, webFriendLead ticks or fewer before its expiry,
   * whose extension we asked and it has not agreed to, with the extension
   * forecast at its next decision below webFriendMinP for a reason
   * friendship fixes (the trap or a draw of checkAlreadyEnoughAlliances,
   * not similarly strong), while its relation band is Neutral, gets a gold
   * donation worth friendPoints: the relation it pays in turn t + 1
   * (DonateGoldExecution.tick, seen from t + 2; priced for a payment up to
   * GIFT_PAY_WITHIN ticks late) keeps it Friendly (≥ 50, decay 0.05 a
   * tick) until FRIEND_PAST_EXPIRY ticks past the expiry. Friendly is
   * decided before checkAlreadyEnoughAlliances and the strength tests
   * (NationAllianceBehavior.getAllianceDecision), but after
   * hasTooManyAlliances: 67% at every decision left and at the renew's
   * when the extension is refused for the trap or strength, and only at
   * the renew's (one alliance fewer) when it is refused as "tooMany" (7 of
   * the 9 gifts of arena quick@20 v2; all 7 renews passed). One gift a
   * term, from at most webFriendGoldShare of our gold; `donate:<id>`
   * dedupes it with the troop gift in a tick.
   */
  private goldFriends(v: View, mem: DiplomacyMemory, mid: MidPlan): void {
    const { o, me, nm, game, tick: t } = v;
    const gifts = (mem.gifts ??= {});
    for (const a of me.alliances()) {
      const N = a.other(me);
      const id = N.id();
      const e = a.expiresAt();
      if (N.type() !== PlayerType.Nation || !mid.keep.includes(id)) continue;
      // Package WP1 (review F1): no gift for a foe mark's extension.
      if (v.scheduler.vetoed(`ext:${id}`)) continue;
      if (e - t > o.webFriendLead || e <= t || gifts[id] === e) continue;
      if ((mid.dmid[id] ?? 0) < o.webFriendMinDanger) continue;
      if (!v.wm.nations.some((n) => n.id === id)) continue;
      if (!a.agreedToExtend(me) || a.agreedToExtend(N)) continue;
      if (N.relation(me) !== Relation.Neutral) continue;
      if (me.hasEmbargoAgainst(N) || !me.canDonateGold(N)) continue;
      const f = nm.acceptsAlliance(id, {
        kind: "extension",
        createdAt: t,
        atTick: nm.nextDecision(id, t + 1),
        embargoStoppedBy: null,
      });
      if (f.p >= o.webFriendMinP) continue;
      if (f.branch === "traitor" || f.branch === "spawnPhase") continue;
      const paid = t + 1;
      const r = Math.min(
        FRIENDLY_FROM - 1,
        Math.max(0, nm.relations.value(id, paid)),
      );
      const points = friendPoints(r, paid, e + FRIEND_PAST_EXPIRY);
      if (points === null) continue;
      // Priced for a payment up to GIFT_PAY_WITHIN ticks late: the chunk
      // only grows, so the gold buys `points` whenever it pays by then.
      const gold =
        BigInt(points / GOLD_POINTS) * goldChunk(game, t + GIFT_PAY_WITHIN);
      if (Number(gold) > o.webFriendGoldShare * Number(me.gold())) {
        if ((mem.giftsSkipped ??= {})[id] !== e) {
          mem.giftsSkipped[id] = e;
          v.log?.(
            `${t} dip gift ${N.name()} unaffordable: ${gold} gold for +${points} ` +
              `(have ${me.gold()}, ext p=${f.p.toFixed(2)} ${f.branch})`,
          );
        }
        continue;
      }
      const ok = v.scheduler.offer({
        intent: { type: "donate_gold", recipient: id, gold: Number(gold) },
        prio: Prio.Diplomacy,
        cls: "diplomacy",
        key: `donate:${id}`,
      });
      if (!ok) continue;
      gifts[id] = e;
      (mem.giftsPending ??= {})[id] = { at: t, points };
      mem.stats.goldGifts = (mem.stats.goldGifts ?? 0) + 1;
      mem.stats.goldGiven = (mem.stats.goldGiven ?? 0) + Number(gold);
      v.log?.(
        `${t} dip gift ${N.name()} ${gold} gold for +${points} (relation ~${r.toFixed(1)}, ` +
          `ext p=${f.p.toFixed(2)} ${f.branch}, expires ${e}, dmid ${(mid.dmid[id] ?? 0).toFixed(2)})`,
      );
    }
  }

  /**
   * o.webFriendGold, o.webFriend: a gift is first visible at ctx tick sent + 2. If the
   * nation is Friendly then and our RelationTracker does not know it yet,
   * the gift's points go in as a "donation" event (the forecasts then count
   * its Friendly branch); otherwise it is logged as not seen (the alliance
   * lapsed first, or the relation was lower than estimated).
   */
  private seeGifts(v: View, mem: DiplomacyMemory): void {
    const { me, nm, game, tick: t } = v;
    const pending = mem.giftsPending!;
    for (const [id, g] of Object.entries(pending)) {
      if (t < g.at + 2) continue;
      delete pending[id];
      if (!game.hasPlayer(id)) continue;
      const N = game.player(id);
      const friendly = N.isAlive() && N.relation(me) === Relation.Friendly;
      if (friendly && nm.relations.band(id, t) !== Relation.Friendly) {
        nm.relations.onEvent(id, g.at + 2, g.points, "donation");
      }
      if (!friendly) v.log?.(`${t} dip gift ${N.name()} not seen`);
    }
  }

  /**
   * o.webFriend (every tick): a kept ally with dmid >= webFriendMinDanger
   * whose extension we asked and it still refuses (forecast below
   * webFriendMinP, not for a reason friendship cannot fix: the 25% limit,
   * our treachery) webFriendLead ticks or fewer before expiry gets a troop
   * donation of ceil(M_N/b) + 1 (FRIEND_DIVISOR), sent at ctx tick s with
   * its next decision at s + 2:
   * - the donation inits at the end of turn s and pays in turn s + 1, after
   *   the nation's own tick there (executions run in the order they were
   *   added), so its +50 is first seen at the decision in turn s + 2;
   * - the nation's tick runs before its PlayerExecution's decay in a turn,
   *   so that decision reads 50 + r (r >= 0 the relation before): Friendly,
   *   and the pending extension is agreed 67% of the time; one turn later
   *   decay has taken it under 50 again (unless r > 0.05).
   * Only while its relation band is Neutral (Friendly needs no gift; below
   * Neutral, +50 does not reach Friendly), it is not embargoed (the -20 at
   * that decision), its decision timing is exact (params from the game ID),
   * its cap headroom takes the whole gift, and our home is at webFriendHome
   * of the cap or more; the troops come out of floor(strike).
   */
  private friends(v: View, mem: DiplomacyMemory, mid: MidPlan): void {
    const { o, me, nm, game, tick: t } = v;
    const cfg = game.config();
    if (me.troops() < o.webFriendHome * v.purse.floors.cap) return;
    const divisor = FRIEND_DIVISOR[cfg.gameConfig().difficulty];
    for (const a of me.alliances()) {
      const N = a.other(me);
      const id = N.id();
      if (N.type() !== PlayerType.Nation || !mid.keep.includes(id)) continue;
      // Package WP1 (review F1): no gift for a foe mark's extension.
      if (v.scheduler.vetoed(`ext:${id}`)) continue;
      if ((mid.dmid[id] ?? 0) < o.webFriendMinDanger) continue;
      if (!a.agreedToExtend(me) || a.agreedToExtend(N)) continue;
      if (a.expiresAt() - t > o.webFriendLead) continue;
      if (mem.gifts?.[id] === a.expiresAt()) continue;
      if (nm.params(id).source !== "gameID") continue;
      if (nm.nextDecision(id, t + 1) !== t + 2) continue;
      if (N.relation(me) !== Relation.Neutral) continue;
      if (me.hasEmbargoAgainst(N) || !me.canDonateTroops(N)) continue;
      const f = nm.acceptsAlliance(id, {
        kind: "extension",
        createdAt: t,
        atTick: t + 2,
        embargoStoppedBy: null,
      });
      if (f.p >= o.webFriendMinP) continue;
      if (
        f.branch === "tooMany" ||
        f.branch === "traitor" ||
        f.branch === "spawnPhase"
      ) {
        continue;
      }
      const M = cfg.maxTroops(N);
      const D = Math.ceil(M / divisor) + 1;
      if (M - nm.troopsAt(id, t + 1) < D * FRIEND_HEADROOM) continue;
      const ok = v.scheduler.offer({
        intent: { type: "donate_troops", recipient: id, troops: D },
        prio: Prio.Diplomacy,
        cls: "diplomacy",
        key: `donate:${id}`,
        spend: { kind: "strike", troops: D },
      });
      if (!ok) continue;
      mem.stats.gifts = (mem.stats.gifts ?? 0) + 1;
      // DonateTroopsExecution's +50, for the forecasts once seen (seeGifts).
      (mem.giftsPending ??= {})[id] = { at: t, points: TROOP_GIFT_POINTS };
      v.log?.(
        `${t} dip friend ${N.name()} gift ${D} (M=${Math.round(M)}) for its ` +
          `extension (p=${f.p.toFixed(2)} ${f.branch}, expires ${a.expiresAt()}, ` +
          `dmid ${(mid.dmid[id] ?? 0).toFixed(2)})`,
      );
    }
  }

  /**
   * §3.4.4. With the midgame web (o.webMidgame), no acceptance takes our
   * alliances and pending requests past midCeiling (A_ext: past it, every
   * kept extension fails), and a nation outside its keep set is accepted
   * only while room is left for the unallied kept nations (alliances +
   * unallied kept < the midgame slots): the +100 is cheap, but the slot is
   * the one a more dangerous nation needs.
   */
  private counterAccept(v: View, s: ApexState): void {
    const { o, me, tick: t } = v;
    if (!o.counterAccept) return;
    const reqs = me.incomingAllianceRequests();
    if (reqs.length === 0) return;
    const mem = diplomacyMemory(s);
    const slots = allySlots(v.game, me, o.allySlotsReserve);
    const mid = midActive(v) ? mem.mid : undefined;
    let held =
      me.alliances().length +
      (mid !== undefined
        ? me.outgoingAllianceRequests().length + sentThisTick(v, s)
        : 0);
    const limit = mid !== undefined ? midCeiling(o, slots) : slots.max;
    const order = mid !== undefined ? mid.keep : s.web.allySet;
    let wanted = 0;
    if (mid !== undefined) {
      for (const id of mid.keep) {
        // Package WP1 (review F1): a foe of the search's plan is not
        // wanted while its mark lasts (no request of ours can go to it).
        if (v.scheduler.vetoed(`ally:${id}`)) continue;
        if (!v.game.hasPlayer(id) || !me.isAlliedWith(v.game.player(id))) {
          wanted++;
        }
      }
    }
    // Slots are few: the web's nations (in rank order) first, then the
    // rest by smallID.
    const rank = (p: Player) => {
      const i = order.indexOf(p.id());
      return i < 0 ? Infinity : i;
    };
    const from = reqs
      .map((r) => r.requestor())
      .sort((a, b) => rank(a) - rank(b) || a.smallID() - b.smallID());
    for (const N of from) {
      if (held >= limit) break;
      if (N.type() !== PlayerType.Nation || !N.isAlive()) continue;
      if (me.isAlliedWith(N)) continue;
      // Package A1 (review F2; not A/B-tested): a nation we strike asks to
      // stop, and accepting retreats the strike (quick@20 0:12 with the two
      // lines above and below: 5 of 17 strikes ended so, none by our own
      // requests any more).
      if (o.strikes && underStrike(v, N.smallID())) continue;
      // Food-list nations' requests are left to expire (200 ticks).
      if (o.foodList && s.web.food.includes(N.id())) continue;
      // Package WP1 (review F1): so are a foe mark's. Its key is vetoed,
      // and the refusal ("key") would count it below as a slot taken.
      if (v.scheduler.vetoed(`ally:${N.id()}`)) continue;
      if (mid !== undefined) {
        if (mid.keep.includes(N.id())) wanted--;
        else if (held + wanted >= mid.slots) continue;
      }
      const ok = v.scheduler.offer({
        intent: { type: "allianceRequest", recipient: N.id() },
        prio: Prio.Diplomacy,
        cls: "diplomacy",
        key: `ally:${N.id()}`,
      });
      if (!ok) {
        // The recall took it this tick (the same acceptance).
        if (v.scheduler.lastRefusal === "key") held++;
        continue;
      }
      held++;
      mem.stats.counters++;
      s.web.requested[N.id()] = t;
      v.log?.(`${t} dip counter ${N.name()} (alliances ${held}/${limit})`);
    }
  }

  // ── Upkeep (every decision, last in §3.0 step 4) ──────────────────────

  decide(v: View, s: ApexState): void {
    const mem = diplomacyMemory(s);
    const t = v.tick;
    this.watchAlliances(v, s, mem);
    if (v.o.webDiag && t - (mem.diagAt ?? NEVER) >= DIAG_EVERY) {
      mem.diagAt = t;
      this.diag(v);
    }
    const from = allyFromTick(v);
    if (
      t - s.web.lastPlan >= v.o.planEvery ||
      (s.web.lastPlan < from && t >= from) ||
      // The midgame web plans at its first decision (webFrom), so the
      // spec's extensions never run past it.
      (midActive(v) && mem.mid === undefined)
    ) {
      this.plan(v, s, mem);
    }
    const slots = allySlots(v.game, v.me, v.o.allySlotsReserve);
    const mid = midActive(v) ? mem.mid : undefined;
    if (mid !== undefined) {
      if (v.o.web) {
        this.requests(v, s, mem, mid.keep, this.midRoom(v, s, mid, slots));
      }
      if (v.o.extensions) {
        this.extensions(v, s, mem, slots, mid.keep, v.o.webExtendLead);
      }
      if (v.o.webRenew) this.noteRenew(v, mem, mid);
      return;
    }
    if (v.o.web && t >= from) {
      const held =
        v.me.alliances().length + v.me.outgoingAllianceRequests().length;
      this.requests(v, s, mem, s.web.allySet, slots.webTarget - held);
    }
    if (v.o.extensions) {
      this.extensions(v, s, mem, slots, s.web.allySet, v.o.extendLead);
    }
  }

  /** o.webRenew: records the expiry of every kept alliance (entries of
   *  lapsed ones stay until onTick's renew has seen them). */
  private noteRenew(v: View, mem: DiplomacyMemory, mid: MidPlan): void {
    const { me } = v;
    const renew = (mem.renew ??= {});
    for (const a of me.alliances()) {
      const N = a.other(me);
      if (N.type() !== PlayerType.Nation) continue;
      if (mid.keep.includes(N.id())) renew[N.id()] = a.expiresAt();
      else delete renew[N.id()];
    }
  }

  /**
   * o.webRenew (every tick): a kept alliance that lapsed without an
   * extension gets a fresh request the first tick we see it gone. The
   * nation answers it at its next decision, before it creates any attack
   * there (handleAllianceRequests precedes attacks, §3.3.2), and decides a
   * request afresh:
   * - with our alliances one fewer, so hasTooManyAlliances passes where
   *   the extension failed at A_max;
   * - without us counted as its bordering friend, so the extension trap
   *   refuses it only when every other non-bot neighbour it has is its
   *   friend (checkAlreadyEnoughAlliances refuses a request while at most
   *   one of its bordering non-bot players is not its friend, and an
   *   extension counts us as one of its friends).
   * The renew restores the count we held before the lapse: up to A_max
   * with webRenewOver (at A_max at least one ally is outside the keep set,
   * the keep set being A_ext at most, so the spell ends at its lapse),
   * else up to midCeiling. One attempt per lapse; the regular requests
   * retry after the 300-tick cooldown.
   */
  private renew(v: View, s: ApexState, mem: DiplomacyMemory): void {
    const { o, me, nm, game, tick: t } = v;
    const renew = mem.renew;
    const mid = mem.mid;
    if (renew === undefined || mid === undefined) return;
    // Alliances and pending requests, with the renews sent this tick.
    let limit: number | null = null;
    let held = 0;
    for (const [id, e] of Object.entries(renew)) {
      if (t < e) continue;
      const N = game.hasPlayer(id) ? game.player(id) : null;
      if (N === null || !N.isAlive()) {
        delete renew[id];
        continue;
      }
      if (me.isAlliedWith(N)) {
        // Not expired yet as we see it (or extended: noteRenew updates).
        if (t > e + RENEW_WAIT) delete renew[id];
        continue;
      }
      delete renew[id];
      if (!mid.keep.includes(id)) continue;
      // Package WP1 (review F1): nor a foe mark's (its request would be
      // vetoed after the forecast and the embargo stop).
      if (v.scheduler.vetoed(`ally:${id}`)) {
        v.log?.(`${t} dip renew ${N.name()}: foe of the search`);
        continue;
      }
      if (!me.canSendAllianceRequest(N)) {
        v.log?.(`${t} dip renew ${N.name()}: cannot request`);
        continue;
      }
      if (limit === null) {
        const slots = allySlots(game, me, o.allySlotsReserve);
        limit = o.webRenewOver ? slots.max : midCeiling(o, slots);
        held =
          me.alliances().length +
          me.outgoingAllianceRequests().length +
          sentThisTick(v, s);
      }
      if (held >= limit) {
        v.log?.(
          `${t} dip renew ${N.name()}: no room (alliances ${held}/${limit})`,
        );
        continue;
      }
      const d = nm.nextDecision(id, t + 1);
      const stoppedBy = this.stoppedBy(v, s, N);
      const f = nm.acceptsAlliance(id, {
        kind: "request",
        createdAt: t,
        atTick: d,
        embargoStoppedBy: stoppedBy,
      });
      if (f.p < o.webRenewMinP) {
        v.log?.(
          `${t} dip renew ${N.name()}: p=${f.p.toFixed(2)} ${f.branch} (not sent)`,
        );
        continue;
      }
      if (stoppedBy === t && !offerEmbargoStop(v, s, N, Prio.Recall)) continue;
      const ok = v.scheduler.offer({
        intent: { type: "allianceRequest", recipient: id },
        prio: Prio.Recall,
        cls: "defense",
        key: `ally:${id}`,
      });
      if (!ok) continue;
      held++;
      s.web.requested[id] = t;
      mem.stats.renews = (mem.stats.renews ?? 0) + 1;
      v.log?.(
        `${t} dip renew ${N.name()} p=${f.p.toFixed(2)} ${f.branch} d=${d} ` +
          `dmid=${(mid.dmid[id] ?? 0).toFixed(2)}`,
      );
    }
  }

  // ── §3.4.2 Plan ────────────────────────────────────────────────────────

  /**
   * reach(N)  = N ∈ me.nearby() ∨ OwnerGrid distance ≤ allyReachCells
   * T_att(N)  = trigger_N · capAt(Nation, tiles_N·(1 + g_N·600), cities_N)
   * H^+       = homeX · capAt(Human, tiles·(1 + g·600), cities); in stall
   *             mode with o.stallDangerHome, at least our home now (at most
   *             the cap): a nation that cannot out-send the troops we hold
   *             idle at the cap is food, not a threat
   * danger(N) = T_att(N) / (safe·H^+), safe = nm.sendCapSafe() (1.1 at
   *             Impossible, 0.95 at Hard [PIN NationSendCap]; 1 where no
   *             home deters, Easy and Medium: no send-cap relief)
   *             (danger > 1: its trigger stack out-sends our deterrence
   *             line)
   * allySet   = reach ∧ danger ≥ allyDangerMin, ranked by o.webRank
   * food      = reach ∧ danger < allyDangerMin ∧ unallied (o.foodList)
   * g is the EMA of relative land growth per tick, g·600 clamped to
   * [0, GROWTH_CAP]. Idle-mode reach (predicted cells at tick 900) is not
   * used: the spawn search keeps no nation cells.
   */
  plan(v: View, s: ApexState, mem: DiplomacyMemory): void {
    const { game, me, models, o, nm, wm, tick: t } = v;
    const nations = game
      .players()
      .filter((p) => p.type() === PlayerType.Nation)
      .sort((a, b) => a.smallID() - b.smallID());
    const near = new Set<number>();
    for (const x of me.nearby()) if (x.isPlayer()) near.add(x.smallID());
    const dist =
      v.owners !== null && v.race !== null
        ? reachCells(
            v.owners,
            v.race,
            me.smallID(),
            o.allyReachCells ?? Math.ceil(REACH_TILES / v.race.cell),
          )
        : new Map<number, number>();
    const project = (tiles: number, g: number) =>
      tiles * (1 + Math.min(GROWTH_CAP, Math.max(0, g * GROWTH_HORIZON)));
    const gUs = this.growth(mem, me, t);
    let Hplus =
      o.homeX *
      models.capAt(
        PlayerType.Human,
        project(me.numTilesOwned(), gUs),
        finishedCityLevels(me),
      );
    if (o.stallDangerHome && inStall(s, t, o)) {
      Hplus = Math.max(Hplus, Math.min(me.troops(), models.cap(me)));
    }
    // Package A1 (review F2): while our strikes run, their troops count as
    // home (the launch dropped home and ended stall mode, and every danger
    // rose with it: quick@20 g27 allySet 1 -> 9, Benin allied mid-strike).
    if (o.strikes) {
      const out = strikeTroops(v);
      if (out > 0) {
        Hplus = Math.max(Hplus, Math.min(me.troops() + out, models.cap(me)));
      }
    }
    const safe = Number.isFinite(nm.sendCapSafe()) ? nm.sendCapSafe() : 1;
    let contact = wm.freeFrontier;
    for (const n of wm.neighbors.values()) contact += n.contact;

    const rows: Row[] = [];
    const alive = new Set<PlayerID>([me.id()]);
    for (const N of nations) {
      const id = N.id();
      alive.add(id);
      const g = this.growth(mem, N, t);
      const sid = N.smallID();
      if (!near.has(sid) && !dist.has(sid)) continue;
      // Package A1 (review F2): a nation we strike is a target, not an ally
      // (an accepted alliance retreats the strike).
      if (o.strikes && underStrike(v, sid)) continue;
      const Mplus = models.capAt(
        PlayerType.Nation,
        project(N.numTilesOwned(), g),
        finishedCityLevels(N),
      );
      const danger =
        (nm.params(id).trigger * Mplus) / (safe * Math.max(1, Hplus));
      rows.push({
        N,
        id,
        sid,
        danger,
        contactShare:
          (wm.neighbors.get(sid)?.contact ?? 0) / Math.max(1, contact),
        dist: near.has(sid) ? 0 : (dist.get(sid) ?? Infinity),
      });
    }
    const ally = rows.filter((r) => r.danger >= o.allyDangerMin);
    ally.sort(
      o.webRank === "nearest"
        ? (a, b) => a.dist - b.dist || b.danger - a.danger || a.sid - b.sid
        : (a, b) =>
            b.danger * (1 + b.contactShare) - a.danger * (1 + a.contactShare) ||
            a.sid - b.sid,
    );
    s.web.allySet = ally.map((r) => r.id);
    s.web.food = o.foodList
      ? rows
          .filter((r) => r.danger < o.allyDangerMin && !me.isAlliedWith(r.N))
          .map((r) => r.id)
      : [];
    s.web.lastPlan = t;
    mem.stats.plans++;
    mem.danger = {};
    for (const r of rows) mem.danger[r.id] = Math.round(r.danger * 1000) / 1000;

    // Forget the dead, and requests and extensions long past.
    for (const id of Object.keys(mem.growth)) {
      if (!alive.has(id)) delete mem.growth[id];
    }
    const cooldown = game.config().allianceRequestCooldown();
    for (const [id, at] of Object.entries(s.web.requested)) {
      if (t - at > cooldown) delete s.web.requested[id];
    }
    for (const id of Object.keys(s.web.extensionAsked)) {
      if (!game.hasPlayer(id) || !me.isAlliedWith(game.player(id))) {
        delete s.web.extensionAsked[id];
      }
    }

    const slots = allySlots(game, me, o.allySlotsReserve);
    const top = ally
      .slice(0, 5)
      .map((r) => `${r.N.name()}:${r.danger.toFixed(2)}`)
      .join(",");
    v.log?.(
      `${t} dip plan slots=${slots.max}/${slots.ext}/${slots.webTarget} ` +
        `allied=${me.alliances().length} pending=${me.outgoingAllianceRequests().length} ` +
        `reach=${rows.length} allySet=${ally.length} food=${s.web.food.length} ` +
        `H+=${Math.round(Hplus / 1000)}k top=[${top}]`,
    );
    if (midActive(v)) {
      this.planMid(v, s, mem, { nations, near, dist, project, safe, Hplus });
    }
  }

  // ── The web through the midgame (o.webMidgame, spec §5.1 item 1) ───────

  /**
   * reach_mid(N) = reach(N) (§3.4.2) ∨ (webBoatReach ∧ we and N own an
   *                ocean-shore block of the OwnerGrid ∧ islandThreat: N
   *                has no bordering enemy and would boat at us first)
   * dmid(N)      = max(T_N + out_N, trigger_N·M_N^+) / (safe·H_ref),
   *                times webBoatDiscount when reached by boat only;
   *                H_ref = max(H^+ of §3.4.2, min(home, cap))
   * peak(N)      = max(dmid(N), webPeakKeep·peak(N) of the last plan)
   * value(N)     = peak(N), times webKeepBonus while allied or asked
   *                (either way): hysteresis
   * rank         = reach_mid ∧ value ≥ webDangerMin, no strike plan on it,
   *                most valuable first
   * keep         = the first `slots` of rank (A_max with webSlotsMax, else
   *                A_ext − ⌊webSlotSpare·A_max⌋, at least 1: A_max shrinks
   *                as nations die, 15-30% within an alliance's term from
   *                minute 3, and every extension fails while we hold more
   *                than A_ext) that are allied or asked, or (webKeepFeasible)
   *                that a request sent now would win (forecast ≥ allyMinP,
   *                or refused only by the spawn guard or our slot count;
   *                MID_FORECASTS a plan, the rest kept unchecked);
   *                webLapseTarget drops one bordering ally (see the option)
   * s.web.allySet gains keep (strikes skip it, the refresh list covers it)
   * and s.web.food loses it; mem.keptSince notes since when each kept
   * nation has been kept (webExtendStable).
   *
   * A nation's stack now counts, not only its trigger stack on projected
   * land: in stall mode H_ref is our home at the cap, and nations holding
   * more than their trigger (they save before a big send) read as food by
   * the §3.4.2 danger (arena quick@20: India at 1.13× our home had danger
   * 0.52 and lapsed).
   */
  private planMid(
    v: View,
    s: ApexState,
    mem: DiplomacyMemory,
    c: {
      nations: Player[];
      near: Set<number>;
      dist: Map<number, number>;
      project: (tiles: number, g: number) => number;
      safe: number;
      Hplus: number;
    },
  ): void {
    const { game, me, models, o, nm, wm, tick: t } = v;
    const cap = models.cap(me);
    const Href = Math.max(1, c.Hplus, Math.min(me.troops(), cap));
    let shore: Set<number> | null = null;
    let next: Record<number, number[]> = {};
    if (o.webBoatReach && v.owners !== null && v.race !== null) {
      // Once per OwnerGrid refresh (every OWNER_GRID_EVERY ticks).
      if (mem.shore?.stamp !== v.owners.stamp) {
        mem.shore = {
          stamp: v.owners.stamp,
          ids: [...shoreOwners(v.owners, v.race, game)],
          next: Object.fromEntries(blockNeighbours(v.owners)),
        };
      }
      shore = new Set(mem.shore.ids);
      next = mem.shore.next;
    }
    const usShore = shore !== null && shore.has(me.smallID());
    const asked = new Set<PlayerID>();
    for (const r of me.outgoingAllianceRequests())
      asked.add(r.recipient().id());
    for (const r of me.incomingAllianceRequests())
      asked.add(r.requestor().id());
    const rows: {
      N: Player;
      id: PlayerID;
      sid: number;
      value: number;
      held: boolean;
    }[] = [];
    const dmid: Record<PlayerID, number> = {};
    const peakBefore = mem.peak ?? {};
    const peak: Record<PlayerID, number> = {};
    for (const N of c.nations) {
      if (!N.isAlive()) continue;
      const sid = N.smallID();
      const land = c.near.has(sid) || c.dist.has(sid);
      const boat =
        !land &&
        usShore &&
        shore!.has(sid) &&
        islandThreat(game, me, N, next[sid], shore!);
      if (!land && !boat) continue;
      const id = N.id();
      let out = 0;
      for (const a of N.outgoingAttacks()) out += a.troops();
      const g = mem.growth[id]?.g ?? 0;
      const Mplus = models.capAt(
        PlayerType.Nation,
        c.project(N.numTilesOwned(), g),
        finishedCityLevels(N),
      );
      const Tplus = Math.max(N.troops() + out, nm.params(id).trigger * Mplus);
      const d = (Tplus / (c.safe * Href)) * (boat ? o.webBoatDiscount : 1);
      dmid[id] = Math.round(d * 1000) / 1000;
      const top = Math.max(d, o.webPeakKeep * (peakBefore[id] ?? 0));
      peak[id] = Math.round(top * 1000) / 1000;
      if (v.ledger.plan(sid)?.kind === "strike") continue;
      const held = me.isAlliedWith(N) || asked.has(id);
      const value = held ? top * o.webKeepBonus : top;
      if (value >= o.webDangerMin) rows.push({ N, id, sid, value, held });
    }
    rows.sort((a, b) => b.value - a.value || a.sid - b.sid);
    const allSlots = allySlots(game, me, o.allySlotsReserve);
    const slots =
      o.webSlotsMax || allSlots.ext === 0
        ? allSlots.max
        : Math.max(1, allSlots.ext - Math.floor(o.webSlotSpare * allSlots.max));
    const rank = rows.map((r) => r.id);
    let keep: PlayerID[] = [];
    const infeasible: PlayerID[] = [];
    let forecasts = 0;
    for (const r of rows) {
      if (keep.length >= slots) break;
      if (!r.held && o.webKeepFeasible) {
        if (!me.canSendAllianceRequest(r.N)) {
          infeasible.push(r.id);
          continue;
        }
        if (forecasts < MID_FORECASTS) {
          forecasts++;
          const f = nm.acceptsAlliance(r.id, {
            kind: "request",
            createdAt: t,
            atTick: nm.nextDecision(r.id, t + 1),
            embargoStoppedBy: this.stoppedBy(v, s, r.N),
          });
          // Refused for now by the clock or our slots only (the spawn
          // guard, hasTooManyAlliances): still ours to keep.
          const passing =
            f.p >= o.allyMinP ||
            f.branch === "spawnPhase" ||
            f.branch === "tooMany";
          if (!passing) {
            infeasible.push(r.id);
            continue;
          }
        }
      }
      keep.push(r.id);
    }
    let dropped: PlayerID | null = null;
    if (o.webLapseTarget && strikesOn(v) && inStall(s, t, o)) {
      // Boxed in: every bordering nation is kept allied, so nothing is
      // left to eat. The weakest bordering kept ally lapses, unless its
      // extension is already asked this term: an ask cannot be withdrawn,
      // so it would extend all the same, and it is dropped once its next
      // term starts unasked (never a stronger ally in its place).
      let target = false;
      let weakest: { id: PlayerID; d: number } | null = null;
      for (const n of wm.nations) {
        if (n.type !== PlayerType.Nation) continue;
        if (!keep.includes(n.id)) {
          target = true;
          break;
        }
        const d = dmid[n.id] ?? 0;
        if (weakest === null || d < weakest.d) weakest = { id: n.id, d };
      }
      const a =
        weakest !== null ? me.allianceWith(game.player(weakest.id)) : null;
      const asked =
        a !== null && s.web.extensionAsked[weakest!.id] === a.expiresAt();
      if (!target && weakest !== null && !asked) {
        dropped = weakest.id;
        keep = keep.filter((id) => id !== dropped);
      }
    }
    mem.mid = { at: t, rank, keep, dmid, slots, infeasible };
    mem.peak = peak;
    const since = (mem.keptSince ??= {});
    for (const id of Object.keys(since)) {
      if (!keep.includes(id)) delete since[id];
    }
    for (const id of keep) since[id] ??= t;
    const inWeb = new Set(s.web.allySet);
    for (const id of keep) if (!inWeb.has(id)) s.web.allySet.push(id);
    const kept = new Set(keep);
    s.web.food = s.web.food.filter((id) => !kept.has(id));
    if (v.log === undefined) return;
    const names = keep
      .map((id) => {
        const N = game.player(id);
        return `${N.name()}:${dmid[id].toFixed(2)}${me.isAlliedWith(N) ? "*" : ""}`;
      })
      .join(",");
    const key = keep.join(",");
    const last = mem.midLogged;
    if (last !== undefined && last.keep === key && t - last.at < MID_LOG_EVERY)
      return;
    mem.midLogged = { keep: key, at: t };
    const out = infeasible.map((id) => game.player(id).name()).join(",");
    v.log(
      `${t} dip mid slots=${slots} rank=${rank.length} H_ref=${Math.round(Href / 1000)}k ` +
        `keep=[${names}]${out !== "" ? ` refused=[${out}]` : ""}` +
        `${dropped !== null ? ` lapse-for-target=${game.player(dropped).name()}` : ""}`,
    );
  }

  /** The embargo stop a request to N sent now carries (§3.3.2): the one in
   *  flight, or one sent with it; null when we do not embargo N. */
  private stoppedBy(v: View, s: ApexState, N: Player): number | null {
    if (!v.o.embargoStop || !v.me.hasEmbargoAgainst(N)) return null;
    return stopInFlight(s, N.id(), v.tick)
      ? (s.defense?.stops[N.id()] ?? v.tick)
      : v.tick;
  }

  /**
   * o.webMidgame: requests the kept nations may still get now:
   * - kept: slots − (kept allies + kept nations asked);
   * - all: midCeiling (A_ext) − (alliances + our pending requests), so the
   *   extensions of kept allies see at most A_ext alliances. An ally
   *   outside the keep set counts until it lapses, even if its extension,
   *   asked while it was kept, may still pass.
   */
  midRoom(v: View, s: ApexState, mid: MidPlan, slots: AllySlots): number {
    const { me, o } = v;
    const keep = new Set(mid.keep);
    let kept = 0;
    let total = sentThisTick(v, s);
    for (const a of me.alliances()) {
      total++;
      if (keep.has(a.other(me).id())) kept++;
    }
    for (const r of me.outgoingAllianceRequests()) {
      total++;
      if (keep.has(r.recipient().id())) kept++;
    }
    return Math.min(mid.slots - kept, midCeiling(o, slots) - total);
  }

  /**
   * Logs every change to our alliances since the last decision: a new one
   * (`ally+`), an extension (`ally~`, a later expiry), and an end (`ally-`):
   * `lapsed` at its expiry (PlayerExecution.ts:106 expires it once
   * expiresAt <= ticks), else `broken` (by the side that is now a traitor)
   * or `gone` (the nation died). Reads only; decides nothing.
   */
  private watchAlliances(v: View, s: ApexState, mem: DiplomacyMemory): void {
    const { me, game, tick: t } = v;
    const before = mem.allies ?? {};
    const now: Record<PlayerID, number> = {};
    for (const a of me.alliances()) {
      const N = a.other(me);
      const id = N.id();
      const e = a.expiresAt();
      now[id] = e;
      const was = before[id];
      if (was === undefined) {
        v.log?.(`${t} dip ally+ ${N.name()} expires=${e}`);
      } else if (e > was) {
        mem.stats.extended = (mem.stats.extended ?? 0) + 1;
        v.log?.(`${t} dip ally~ ${N.name()} extended expires=${e}`);
      }
    }
    for (const [id, e] of Object.entries(before)) {
      if (now[id] !== undefined) continue;
      const N = game.hasPlayer(id) ? game.player(id) : null;
      let how: string;
      if (e <= t) {
        const asked = s.web.extensionAsked[id] === e;
        how = asked ? "lapsed (extension refused)" : "lapsed (not asked)";
        mem.stats.lapsed = (mem.stats.lapsed ?? 0) + 1;
      } else {
        mem.stats.broken = (mem.stats.broken ?? 0) + 1;
        how =
          N === null || !N.isAlive()
            ? "gone"
            : N.isTraitor()
              ? "broken by it"
              : me.isTraitor()
                ? "broken by us"
                : "broken";
      }
      v.log?.(`${t} dip ally- ${N?.name() ?? id} ${how} (expiry ${e})`);
    }
    mem.allies = now;
  }

  /**
   * o.webDiag: one `dip web` line with the unallied nations holding at
   * least DIAG_MIN_SHARE of our home troops, most troops first: troops as a
   * multiple of our home, tiles as a multiple of ours, `b` if it borders
   * us, and its forecast for a request sent now. Logs only.
   */
  private diag(v: View): void {
    const { game, me, nm, tick: t } = v;
    const H = Math.max(1, me.troops());
    const rows = game
      .players()
      .filter(
        (p) =>
          p.type() === PlayerType.Nation &&
          p.isAlive() &&
          !me.isAlliedWith(p) &&
          p.troops() >= DIAG_MIN_SHARE * H,
      )
      .sort((a, b) => b.troops() - a.troops() || a.smallID() - b.smallID())
      .slice(0, DIAG_ROWS);
    const near = new Set<number>();
    for (const x of me.nearby()) if (x.isPlayer()) near.add(x.smallID());
    const parts = rows.map((N) => {
      const f = nm.acceptsAlliance(N.id(), {
        kind: "request",
        createdAt: t,
        atTick: nm.nextDecision(N.id(), t + 1),
        embargoStoppedBy: null,
      });
      return (
        `${N.name()}:${(N.troops() / H).toFixed(2)}H,` +
        `${(N.numTilesOwned() / Math.max(1, me.numTilesOwned())).toFixed(2)}L` +
        `${near.has(N.smallID()) ? ",b" : ""},p=${f.p.toFixed(2)} ${f.branch}`
      );
    });
    const allies = me
      .alliances()
      .map((a) => {
        const N = a.other(me);
        return `${N.name()}:${(N.troops() / H).toFixed(2)}H@${a.expiresAt()}`;
      })
      .join(",");
    v.log?.(
      `${t} dip web H=${Math.round(H / 1000)}k tiles=${me.numTilesOwned()} ` +
        `allies=[${allies}] others=[${parts.join("; ")}]`,
    );
  }

  /** Updates and returns p's growth EMA (relative land growth per tick). */
  private growth(mem: DiplomacyMemory, p: Player, t: number): number {
    const tiles = p.numTilesOwned();
    const e = mem.growth[p.id()];
    if (e === undefined || t <= e.at || e.at === NEVER) {
      mem.growth[p.id()] = { tiles, at: t, g: e?.g ?? null };
      return e?.g ?? 0;
    }
    const inst = (tiles - e.tiles) / Math.max(1, e.tiles) / (t - e.at);
    const g = e.g === null ? inst : e.g + GROWTH_EMA * (inst - e.g);
    mem.growth[p.id()] = { tiles, at: t, g };
    return g;
  }

  // ── §3.4.3 Requests ────────────────────────────────────────────────────

  /**
   * To `list` nations in order (allySet, or the midgame keep set) that are
   * unallied and requestable (canSendAllianceRequest: nothing pending, the
   * 300-tick cooldown over), whose forecast at their answering decision is
   * at least allyMinP; at most `room` requests (webTarget − alliances −
   * pending requests; the midgame's midRoom), at most allyPerSecond a
   * second. A nation we embargo gets the stop with the request, and the
   * forecast counts it (§3.3.2).
   */
  private requests(
    v: View,
    s: ApexState,
    mem: DiplomacyMemory,
    list: readonly PlayerID[],
    room: number,
  ): void {
    const { o, me, nm, game, tick: t } = v;
    if (room <= 0) return;
    const second = Math.max(1, Math.round(1000 / game.config().msPerTick()));
    let recent = 0;
    for (const at of Object.values(s.web.requested))
      if (at > t - second) recent++;
    let left = o.allyPerSecond - recent;
    let forecasts = 0;
    for (const id of list) {
      if (room <= 0 || left <= 0 || forecasts >= MAX_FORECASTS) break;
      if (!game.hasPlayer(id)) continue;
      const N = game.player(id);
      if (!N.isAlive() || N.type() !== PlayerType.Nation) continue;
      if (me.isAlliedWith(N) || !me.canSendAllianceRequest(N)) continue;
      if (s.web.food.includes(id)) continue;
      // Package A1 (review F2).
      if (o.strikes && underStrike(v, N.smallID())) continue;
      // Package WP1 (review F1): a foe mark's nation takes no forecast and
      // gets no embargo stop (its request would be vetoed).
      if (v.scheduler.vetoed(`ally:${id}`)) continue;
      const d = nm.nextDecision(id, t + 1);
      const stoppedBy = this.stoppedBy(v, s, N);
      const f = nm.acceptsAlliance(id, {
        kind: "request",
        createdAt: t,
        atTick: d,
        embargoStoppedBy: stoppedBy,
      });
      forecasts++;
      if (f.p < o.allyMinP) continue;
      if (stoppedBy === t && !offerEmbargoStop(v, s, N, Prio.Diplomacy)) break;
      const ok = v.scheduler.offer({
        intent: { type: "allianceRequest", recipient: id },
        prio: Prio.Diplomacy,
        cls: "diplomacy",
        key: `ally:${id}`,
      });
      if (!ok) {
        const why = v.scheduler.lastRefusal;
        if (why === "key") continue;
        break;
      }
      s.web.requested[id] = t;
      room--;
      left--;
      mem.stats.requests++;
      const dm = mem.mid?.dmid[id];
      v.log?.(
        `${t} dip request ${N.name()} p=${f.p.toFixed(2)} ${f.branch} d=${d}` +
          ` danger=${(mem.danger[id] ?? 0).toFixed(2)}` +
          (midActive(v) && dm !== undefined ? ` dmid=${dm.toFixed(2)}` : ""),
      );
    }
  }

  // ── §3.4.5 Extensions ─────────────────────────────────────────────────

  /**
   * Once per term, extendLead ticks before expiry (webExtendLead with the
   * midgame web), for allies in `keep` (allySet, or the midgame keep set);
   * the others lapse. The nation re-decides at each of its
   * decisions until expiry, and refuses while our alliances (this one
   * included) reach 0.25·N, so an extension passes at ≤ A_ext alliances
   * (C5): with more, it waits for another alliance to lapse. An ask cannot
   * be withdrawn, and a passed extension holds the slot a fresh 3,000
   * ticks, so the midgame web asks only allies in its keep set for
   * webExtendStable ticks running (`keptSince`): v2 (1,800 ticks ahead,
   * no such test) won 127 of its 529 extensions (arena quick@20) for
   * allies the keep set had dropped within 600 ticks.
   */
  private extensions(
    v: View,
    s: ApexState,
    mem: DiplomacyMemory,
    slots: AllySlots,
    keep: readonly PlayerID[],
    lead: number,
  ): void {
    const { o, me, tick: t } = v;
    const since = midActive(v) ? (mem.keptSince ?? {}) : null;
    for (const a of me.alliances()) {
      const N = a.other(me);
      const id = N.id();
      if (N.type() !== PlayerType.Nation) continue;
      if (!keep.includes(id)) {
        if (
          o.webDiag &&
          a.expiresAt() - t <= Math.min(lead, o.extendLead) &&
          mem.lapseLogged?.[id] !== a.expiresAt()
        ) {
          (mem.lapseLogged ??= {})[id] = a.expiresAt();
          const f = v.nm.acceptsAlliance(id, {
            kind: "extension",
            createdAt: t,
            atTick: v.nm.nextDecision(id, t + 1),
            embargoStoppedBy: null,
          });
          v.log?.(
            `${t} dip let-lapse ${N.name()} danger=${(mem.danger[id] ?? 0).toFixed(2)} ` +
              `${s.web.food.includes(id) ? "food" : "unranked"} T/H=${(N.troops() / Math.max(1, me.troops())).toFixed(2)} ` +
              `ext p=${f.p.toFixed(2)} ${f.branch}`,
          );
        }
        continue;
      }
      if (a.expiresAt() - t > lead) continue;
      if (a.agreedToExtend(me) || s.web.extensionAsked[id] === a.expiresAt()) {
        continue;
      }
      if (since !== null && t - (since[id] ?? t) < o.webExtendStable) continue;
      const ok = v.scheduler.offer({
        intent: { type: "allianceExtension", recipient: id },
        prio: Prio.Diplomacy,
        cls: "diplomacy",
        key: `ext:${id}`,
      });
      if (!ok) {
        if (v.scheduler.lastRefusal === "key") continue;
        break;
      }
      s.web.extensionAsked[id] = a.expiresAt();
      mem.stats.extensions++;
      const held = me.alliances().length;
      let why = "";
      if (o.webDiag) {
        const f = v.nm.acceptsAlliance(id, {
          kind: "extension",
          createdAt: t,
          atTick: v.nm.nextDecision(id, t + 1),
          embargoStoppedBy: null,
        });
        why = ` p=${f.p.toFixed(2)} ${f.branch}`;
      }
      v.log?.(
        `${t} dip extend ${N.name()} expires=${a.expiresAt()} ` +
          `alliances=${held}${held > slots.ext ? " (over A_ext: waits for a lapse)" : ""}${why}`,
      );
    }
  }
}
