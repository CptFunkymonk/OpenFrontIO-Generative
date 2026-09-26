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
//
// The recall (§3.3.2) is the DefenseController's; both take the dedupe key
// `ally:<id>`, so no nation gets two requests in a tick. Slots: requests from
// nations are answered by the nation, which refuses us once our alliances
// reach 0.25·N (hasTooManyAlliances), so only our own acceptances
// (counter-accepts) can pass A_max, and they are held below it.

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
/** o.webFriend: the donation is cut to the recipient's cap headroom at
 *  its init (DonateTroopExecution.ts:52-56); keep this much slack for the
 *  regrowth before then. */
const FRIEND_HEADROOM = 1.05;
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
  /** o.webBoatReach: shoreOwners of the OwnerGrid with this stamp. */
  shore?: { stamp: number; ids: number[] };
  /** o.webRenew: the expiry of each kept alliance, for the renew request
   *  at its lapse (set each decision from the alliances held). */
  renew?: Record<PlayerID, number>;
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
  /** Alliances the midgame web may hold: A_max (webSlotsMax) or A_ext. */
  slots: number;
}

/** Whether the midgame web runs at tick t (o.webMidgame from o.webFrom). */
export function midActive(v: Pick<View, "o" | "tick">): boolean {
  return v.o.webMidgame && v.tick >= v.o.webFrom;
}

/** Whether a strike feature that eats nations is on (o.webLapseTarget
 *  lets a kept ally lapse only then). */
function strikesOn(v: Pick<View, "o">): boolean {
  return v.o.stallStrike || v.o.strikeWindows.length > 0;
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
      if (v.o.webRenew) this.renew(v, s, mem);
      if (v.o.webFriend && mem.mid !== undefined) this.friends(v, mem, mem.mid);
    }
    this.counterAccept(v, s);
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
      if ((mid.dmid[id] ?? 0) < o.webFriendMinDanger) continue;
      if (!a.agreedToExtend(me) || a.agreedToExtend(N)) continue;
      if (a.expiresAt() - t > o.webFriendLead) continue;
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
      v.log?.(
        `${t} dip friend ${N.name()} gift ${D} (M=${Math.round(M)}) for its ` +
          `extension (p=${f.p.toFixed(2)} ${f.branch}, expires ${a.expiresAt()}, ` +
          `dmid ${(mid.dmid[id] ?? 0).toFixed(2)})`,
      );
    }
  }

  /**
   * §3.4.4. With the midgame web (o.webMidgame), a nation outside its keep
   * set is accepted only while room is left for the unallied kept nations
   * (alliances + unallied kept < the midgame slots): the +100 is cheap, but
   * the slot is the one a more dangerous nation needs.
   */
  private counterAccept(v: View, s: ApexState): void {
    const { o, me, tick: t } = v;
    if (!o.counterAccept) return;
    const reqs = me.incomingAllianceRequests();
    if (reqs.length === 0) return;
    const mem = diplomacyMemory(s);
    const slots = allySlots(v.game, me, o.allySlotsReserve);
    let held = me.alliances().length;
    const mid = midActive(v) ? mem.mid : undefined;
    const order = mid !== undefined ? mid.keep : s.web.allySet;
    let wanted = 0;
    if (mid !== undefined) {
      for (const id of mid.keep) {
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
      if (held >= slots.max) break;
      if (N.type() !== PlayerType.Nation || !N.isAlive()) continue;
      if (me.isAlliedWith(N)) continue;
      // Food-list nations' requests are left to expire (200 ticks).
      if (o.foodList && s.web.food.includes(N.id())) continue;
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
      v.log?.(`${t} dip counter ${N.name()} (alliances ${held}/${slots.max})`);
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
      (s.web.lastPlan < from && t >= from)
    ) {
      this.plan(v, s, mem);
    }
    const slots = allySlots(v.game, v.me, v.o.allySlotsReserve);
    const mid = midActive(v) ? mem.mid : undefined;
    if (mid !== undefined) {
      if (v.o.web) this.requests(v, s, mem, mid.keep, mid.slots);
      if (v.o.extensions) this.extensions(v, s, mem, slots, mid.keep);
      if (v.o.webRenew) this.noteRenew(v, mem, mid);
      return;
    }
    if (v.o.web && t >= from) {
      this.requests(v, s, mem, s.web.allySet, slots.webTarget);
    }
    if (v.o.extensions) this.extensions(v, s, mem, slots, s.web.allySet);
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
   * request afresh: without us counted as its bordering friend, so the
   * extension trap (a second unallied neighbour) does not refuse it, and
   * with our alliances one fewer, so hasTooManyAlliances passes where the
   * extension failed at A_max. One attempt per lapse; the regular requests
   * retry after the 300-tick cooldown.
   */
  private renew(v: View, s: ApexState, mem: DiplomacyMemory): void {
    const { o, me, nm, game, tick: t } = v;
    const renew = mem.renew;
    const mid = mem.mid;
    if (renew === undefined || mid === undefined) return;
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
      if (!me.canSendAllianceRequest(N)) {
        v.log?.(`${t} dip renew ${N.name()}: cannot request`);
        continue;
      }
      const d = nm.nextDecision(id, t + 1);
      let stoppedBy: number | null = null;
      if (o.embargoStop && me.hasEmbargoAgainst(N)) {
        stoppedBy = stopInFlight(s, id, t) ? (s.defense?.stops[id] ?? t) : t;
      }
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
   *                ocean-shore block of the OwnerGrid)
   * dmid(N)      = max(T_N + out_N, trigger_N·M_N^+) / (safe·H_ref),
   *                times webBoatDiscount when reached by boat only;
   *                H_ref = max(H^+ of §3.4.2, min(home, cap))
   * rank         = reach_mid ∧ dmid ≥ webDangerMin, no strike plan on it,
   *                most dangerous first
   * keep         = the top `slots` of rank (A_max with webSlotsMax, else
   *                A_ext); webLapseTarget drops one bordering ally (see the
   *                option)
   * s.web.allySet gains keep (strikes skip it, the refresh list covers it)
   * and s.web.food loses it.
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
    if (o.webBoatReach && v.owners !== null && v.race !== null) {
      // Once per OwnerGrid refresh (every OWNER_GRID_EVERY ticks).
      if (mem.shore?.stamp !== v.owners.stamp) {
        mem.shore = {
          stamp: v.owners.stamp,
          ids: [...shoreOwners(v.owners, v.race, game)],
        };
      }
      shore = new Set(mem.shore.ids);
    }
    const usShore = shore !== null && shore.has(me.smallID());
    const rows: { id: PlayerID; sid: number; d: number }[] = [];
    const dmid: Record<PlayerID, number> = {};
    for (const N of c.nations) {
      if (!N.isAlive()) continue;
      const sid = N.smallID();
      const land = c.near.has(sid) || c.dist.has(sid);
      const boat = !land && usShore && shore!.has(sid);
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
      if (v.ledger.plan(sid)?.kind === "strike") continue;
      if (d >= o.webDangerMin) rows.push({ id, sid, d });
    }
    rows.sort((a, b) => b.d - a.d || a.sid - b.sid);
    const allSlots = allySlots(game, me, o.allySlotsReserve);
    const slots =
      o.webSlotsMax || allSlots.ext === 0 ? allSlots.max : allSlots.ext;
    const rank = rows.map((r) => r.id);
    let keep = rank.slice(0, slots);
    let dropped: PlayerID | null = null;
    if (o.webLapseTarget && strikesOn(v) && inStall(s, t, o)) {
      // Boxed in: every bordering nation is kept allied, so nothing is
      // left to eat. The weakest bordering kept ally lapses.
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
      if (!target && weakest !== null) {
        dropped = weakest.id;
        keep = keep.filter((id) => id !== dropped);
      }
    }
    mem.mid = { at: t, rank, keep, dmid, slots };
    const inWeb = new Set(s.web.allySet);
    for (const id of keep) if (!inWeb.has(id)) s.web.allySet.push(id);
    const kept = new Set(keep);
    s.web.food = s.web.food.filter((id) => !kept.has(id));
    const names = keep
      .map((id) => {
        const N = game.player(id);
        return `${N.name()}:${dmid[id].toFixed(2)}${me.isAlliedWith(N) ? "*" : ""}`;
      })
      .join(",");
    v.log?.(
      `${t} dip mid slots=${slots} rank=${rank.length} H_ref=${Math.round(Href / 1000)}k ` +
        `keep=[${names}]${dropped !== null ? ` lapse-for-target=${game.player(dropped).name()}` : ""}`,
    );
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
   * To allySet nations in rank order that are unallied and requestable
   * (canSendAllianceRequest: nothing pending, the 300-tick cooldown over),
   * whose forecast at their answering decision is at least allyMinP; while
   * alliances + pending requests < webTarget, at most allyPerSecond a
   * second. A nation we embargo gets the stop with the request, and the
   * forecast counts it (§3.3.2).
   */
  private requests(
    v: View,
    s: ApexState,
    mem: DiplomacyMemory,
    list: readonly PlayerID[],
    limit: number,
  ): void {
    const { o, me, nm, game, tick: t } = v;
    let room =
      limit - me.alliances().length - me.outgoingAllianceRequests().length;
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
      const d = nm.nextDecision(id, t + 1);
      let stoppedBy: number | null = null;
      if (o.embargoStop && me.hasEmbargoAgainst(N)) {
        stoppedBy = stopInFlight(s, id, t) ? (s.defense?.stops[id] ?? t) : t;
      }
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
   * (C5): with more, it waits for another alliance to lapse.
   */
  private extensions(
    v: View,
    s: ApexState,
    mem: DiplomacyMemory,
    slots: AllySlots,
    keep: readonly PlayerID[],
  ): void {
    const { o, me, tick: t } = v;
    const lead = midActive(v) ? o.webExtendLead : o.extendLead;
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
