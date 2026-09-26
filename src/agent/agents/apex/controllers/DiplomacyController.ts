import { Player, PlayerID, PlayerType } from "../../../../core/game/Game";
import { AllySlots, allySlots, reachCells } from "../../../lib/RaceField";
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

/** Our memory, declared here rather than in state.ts (another engineer's
 *  file); created on first use, plain data. */
export interface DiplomacyMemory {
  /** Land growth per player (us included): tiles and tick at the last
   *  plan, and the EMA of relative growth per tick (null: one sample). */
  growth: Record<PlayerID, { tiles: number; at: number; g: number | null }>;
  /** The last plan's danger per reached nation (logs and tests). */
  danger: Record<PlayerID, number>;
  stats: {
    plans: number;
    requests: number;
    counters: number;
    extensions: number;
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
    const { o, me, tick: t } = v;
    if (!o.counterAccept) return;
    const reqs = me.incomingAllianceRequests();
    if (reqs.length === 0) return;
    const mem = diplomacyMemory(s);
    const slots = allySlots(v.game, me, o.allySlotsReserve);
    let held = me.alliances().length;
    // Slots are few: the web's nations (in rank order) first, then the
    // rest by smallID.
    const rank = (p: Player) => {
      const i = s.web.allySet.indexOf(p.id());
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
    const from = allyFromTick(v);
    if (
      t - s.web.lastPlan >= v.o.planEvery ||
      (s.web.lastPlan < from && t >= from)
    ) {
      this.plan(v, s, mem);
    }
    const slots = allySlots(v.game, v.me, v.o.allySlotsReserve);
    if (v.o.web && t >= from) this.requests(v, s, mem, slots);
    if (v.o.extensions) this.extensions(v, s, mem, slots);
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
    slots: AllySlots,
  ): void {
    const { o, me, nm, game, tick: t } = v;
    let room =
      slots.webTarget -
      me.alliances().length -
      me.outgoingAllianceRequests().length;
    if (room <= 0) return;
    const second = Math.max(1, Math.round(1000 / game.config().msPerTick()));
    let recent = 0;
    for (const at of Object.values(s.web.requested))
      if (at > t - second) recent++;
    let left = o.allyPerSecond - recent;
    let forecasts = 0;
    for (const id of s.web.allySet) {
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
      v.log?.(
        `${t} dip request ${N.name()} p=${f.p.toFixed(2)} ${f.branch} d=${d}` +
          ` danger=${(mem.danger[id] ?? 0).toFixed(2)}`,
      );
    }
  }

  // ── §3.4.5 Extensions ─────────────────────────────────────────────────

  /**
   * Once per term, extendLead ticks before expiry, for allies still in
   * allySet; the others lapse. The nation re-decides at each of its
   * decisions until expiry, and refuses while our alliances (this one
   * included) reach 0.25·N, so an extension passes at ≤ A_ext alliances
   * (C5): with more, it waits for another alliance to lapse.
   */
  private extensions(
    v: View,
    s: ApexState,
    mem: DiplomacyMemory,
    slots: AllySlots,
  ): void {
    const { o, me, tick: t } = v;
    for (const a of me.alliances()) {
      const N = a.other(me);
      const id = N.id();
      if (N.type() !== PlayerType.Nation) continue;
      if (!s.web.allySet.includes(id)) continue;
      if (a.expiresAt() - t > o.extendLead) continue;
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
      v.log?.(
        `${t} dip extend ${N.name()} expires=${a.expiresAt()} ` +
          `alliances=${held}${held > slots.ext ? " (over A_ext: waits for a lapse)" : ""}`,
      );
    }
  }
}
