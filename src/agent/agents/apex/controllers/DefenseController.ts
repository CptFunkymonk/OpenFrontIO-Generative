import {
  Attack,
  Player,
  PlayerID,
  PlayerType,
  TerrainType,
  UnitType,
} from "../../../../core/game/Game";
import { TileRef } from "../../../../core/game/GameMap";
import {
  attackWhy,
  counterTroops,
  frontTiles,
  nationIds,
  postSites,
  potentialSend,
  unlockedBy,
} from "../../../lib/Deterrence";
import { allySlots } from "../../../lib/RaceField";
import { Prio, Proposal } from "../../../lib/Scheduler";
import { noteBorderNations } from "../HomeTarget";
import type { Controller, View } from "../policy";
import { ApexState, NEVER } from "../state";
import { BORDER_JITTER } from "./ExpansionController";

// Reflexes, every tick, highest priority (spec §3.3). Enabled by `o.defense`.
//
//   §3.3.1 absorb          the default: an incoming nation attack is left to
//                          run; it costs about a/p_def tiles (logged)
//   §3.3.2 recall          ally the attacker: `embargo stop` plus
//                          `allianceRequest`, timed so the stop acts before
//                          the answering decision (o.recall, o.recallMinP)
//   §3.3.3 free TN cancel  cancel our free-land attack when incoming nation
//                          troops exceed home − H_vw (o.cancelTnOnThreat)
//   §3.3.4 hygiene         stop every temporary embargo against a nation at
//                          once, unless it is a strike target (o.embargoStop)
//   §3.3.5 never           counter-attacks, breakAlliance, or spending home
//                          below H_vw: this controller offers none of them,
//                          but for the counters below (off by default)
//   winning counter        o.detCounter (package B1): an unallied nation's
//   (not in the spec)      attacks on us, S troops in all, are deleted by
//                          an attack of ceil(S·detCounterSize) + 1 on it
//                          (AttackExecution.ts:157-170), when home after it
//                          keeps max(detCounterKeep·cap, H_vw) and exposes
//                          us to no other nation; see counterWins. Harmful
//                          in the A/B (it starts a war of attrition): off
//   defense posts          o.detPosts (package B1): a post on the front
//   (not in the spec)      with a bordering unallied nation that attacks us
//                          or that our home cannot deter; see posts. No
//                          survival gain in the A/B: off
//   floor log              o.deterrence: a line when the deterrence floor
//                          moves (logFloor)
//   counter (not in the    o.counter: after absorbing a fresh land attack of
//   spec)                  an unallied nation estimated to take counterShare
//                          of our tiles or more, while home idles at
//                          counterNearCap of the cap, send it an attack of
//                          counterMargin of that attack's troops (at most
//                          home − H). Smaller than its attack, it is deleted
//                          at init after cancelling as many of its troops,
//                          and skips the −100 relation hit [PIN AttackMerge]
//
// The N3 pin (tests/agent/mechanics/AllianceRecallEmbargo.test.ts) is TRUE,
// so the recall is on by default. Timing, from §2.1 and the pin:
// - A nation's attack, created at its decision d0, makes us embargo it at
//   the attack's init (end of turn d0). We see it at ctx tick d0 + 1.
// - At each decision the nation applies −20 for our embargo before it
//   answers requests. A stop sent at ctx tick s acts in turn s + 1 after the
//   nation's tick, so it counts at decisions d >= s + 2. A request sent at s
//   is answered at the first decision d > s.
// - So stop and request go together at tReq = T, unless the nation decides
//   in turn T + 1: then at T + 1 (the next tick re-evaluates). Every new
//   attack by it re-creates the embargo; the stop is re-sent while a request
//   is pending and t <= d − 2 (re-sends and hygiene share one rule: stop
//   whatever embargo is there and not already being stopped).
// - A nation that has asked us itself is accepted at once by our request
//   (AllianceRequestExecution.ts:45-63, +100): no forecast needed.
//
// The recall is stateless: while an unallied nation attacks us and a
// request to it is possible (canSendAllianceRequest: none pending, cooldown
// over), it is sent when the forecast allows. What must be remembered (stops
// in flight, the TN cancel, recalls to report) is in ApexState.defense,
// declared below.

/** Ticks a stop sent at s is in flight: its EmbargoExecution ticks in turn
 *  s + 1, so the embargo is gone at ctx tick s + 2 (EmbargoExecution.ts:
 *  31-36). An embargo seen later is a new one. */
const STOP_IN_FLIGHT = 2;
/** §3.3.3: at most one free TN cancel per this many ticks. */
const TN_CANCEL_EVERY = 50;
/** o.detCounter: ticks between two counters on one nation. A counter sent
 *  at t inits in turn t + 1 and is seen at t + 1 (latency 1); the extra
 *  ticks cover the browser's latency jitter. */
const COUNTER_EVERY = 3;
/** o.detPosts: ticks between two post checks (a post takes 50 to build). */
const POST_EVERY = 20;
/** o.detPosts: candidate sites scored per check. */
const POST_CANDIDATES = 40;
/** o.detPosts: sites tried with canBuild per check (each floods about 700
 *  tiles). */
const POST_PROBES = 3;
/** o.detPosts: threats whose fronts are tried per check. */
const POST_THREATS = 3;
/** o.detPosts: a nation that attacked us within this many ticks is a
 *  threat whatever its list picks now (its next wave comes). */
const POST_RECENT = 600;
/** Logs only: ticks a transport ship is remembered after its unit is gone
 *  (a landed ship's attack is seen a tick or two after the unit goes). */
const BOAT_GONE = 20;

/** Our memory (spec §2.10: controllers keep none of their own). Declared
 *  here rather than in state.ts, which another engineer owns; it is created
 *  on first use and is plain data, so structuredClone and forRollout carry
 *  it. */
export interface DefenseMemory {
  /** Tick of our last embargo stop against each nation. */
  stops: Record<PlayerID, number>;
  /** The last free TN cancel: its tick and the attack ids it cancelled. */
  tnCancel: { at: number; ids: string[] };
  /** Nation (and human) attacks on us, id -> tick first seen. */
  seen: Record<string, number>;
  /** Recalls awaiting their answering decision. */
  recalls: Record<PlayerID, { at: number; d: number; p: number }>;
  /** o.detCounter: tick of our last winning counter on each nation (absent
   *  in memories created before it). */
  counters?: Record<PlayerID, number>;
  /** o.detPosts: tick of the last post check. */
  lastPost?: number;
  /** o.deterrence: the floor last logged (logs only). */
  lastDet?: { det: number; by: PlayerID | null };
  /** Tick of the last new attack on us (land or a boat landing) by each
   *  nation (absent in memories created before it). */
  lastIn?: Record<PlayerID, number>;
  /** Logs only (never read by decisions): nation transport ships, by unit
   *  id, from the scan that first saw them at sea until BOAT_GONE ticks
   *  after their unit is gone (scanBoats). */
  boats?: Record<number, SeenBoat>;
  stats: DefenseStats;
}

/** A nation transport ship as first seen at sea (logs only). Plain data. */
export interface SeenBoat {
  /** Tick first seen: at most one tick after its launch. */
  at: number;
  by: PlayerID;
  /** Its landing tile (Unit.targetTile), where its attack will start. */
  dst: TileRef;
  /** It was bound for our land when first seen (only these are logged). */
  ours: boolean;
  /** Its troops when first seen (only a bomb changes them at sea). */
  troops: number;
  /** Tick its unit was first missing (landed, retreated or sunk). */
  gone?: number;
}

/** Counts for logs and tests; never read by decisions. */
export interface DefenseStats {
  /** New nation attacks on us (a merge counts again, as in the arena's
   *  Recorder). */
  incoming: number;
  recalls: number;
  accepted: number;
  refused: number;
  stops: number;
  tnCancels: number;
  /** o.detCounter's counters (absent in memories created before it). */
  counterWins?: number;
  /** o.detPosts' posts ordered. */
  posts?: number;
}

declare module "../state" {
  interface ApexState {
    /** DefenseController memory (DefenseController.ts). */
    defense?: DefenseMemory;
  }
}

export function defenseMemory(s: ApexState): DefenseMemory {
  s.defense ??= {
    stops: {},
    tnCancel: { at: NEVER, ids: [] },
    seen: {},
    recalls: {},
    stats: {
      incoming: 0,
      recalls: 0,
      accepted: 0,
      refused: 0,
      stops: 0,
      tnCancels: 0,
    },
  };
  return s.defense;
}

/** Whether a stop against `id` is in flight (the embargo we see is the one
 *  it ends). */
export function stopInFlight(
  s: ApexState,
  id: PlayerID,
  tick: number,
): boolean {
  const at = s.defense?.stops[id] ?? NEVER;
  return tick - at < STOP_IN_FLIGHT;
}

/**
 * Offers `embargo stop` against N (cls "defense", key `embargo:<id>`).
 * True if a stop is sent this tick or already in flight; false if the
 * Scheduler refused it.
 */
export function offerEmbargoStop(
  v: View,
  s: ApexState,
  N: Player,
  prio: Prio,
): boolean {
  const id = N.id();
  if (stopInFlight(s, id, v.tick)) return true;
  const ok = v.scheduler.offer({
    intent: { type: "embargo", targetID: id, action: "stop" },
    prio,
    cls: "defense",
    key: `embargo:${id}`,
  });
  if (!ok) return false;
  const mem = defenseMemory(s);
  mem.stops[id] = v.tick;
  mem.stats.stops++;
  return true;
}

/** A strike target keeps its embargo (§3.3.4): a strike plan on it. */
function strikeTarget(v: View, N: Player): boolean {
  return v.ledger.plan(N.smallID())?.kind === "strike";
}

interface Attacker {
  player: Player;
  troops: number;
  /** A new attack of its appeared this tick (for the absorb log). */
  fresh: boolean;
  /** Our tiles its fresh attacks take by the absorb estimate (§3.3.1). */
  estimate: number;
  /** Troops of its first land attack on us, in our incoming list's order
   *  (the one a counter meets first at init, AttackExecution.ts:157-170),
   *  retreating ones included; 0 for boats only. */
  first: number;
}

export class DefenseController implements Controller {
  readonly name = "defense";

  onTick(v: View, s: ApexState): void {
    const mem = defenseMemory(s);
    noteBorderNations(v, s);
    this.settleRecalls(v, mem);
    const { attackers, incoming } = this.scanIncoming(v, mem);
    if (v.live !== null && v.log !== undefined) this.scanBoats(v, mem);
    // §3.3.3 first: Emergency, and its key must precede the allocator's.
    this.tnCancel(v, mem, incoming);
    if (attackers.length > 0) this.recalls(v, s, mem, attackers);
    if (attackers.length > 0 && v.o.detCounter) {
      this.counterWins(v, mem, attackers);
    }
    if (v.o.detPosts) this.posts(v, s, mem, attackers);
    this.stops(v, s);
    if (v.o.deterrence && v.log !== undefined) this.logFloor(v, mem);
  }

  /** o.deterrence: a log line when the deterrence floor moves by a tenth
   *  of the cap or changes nation (logs only, never read by decisions). */
  private logFloor(v: View, mem: DefenseMemory): void {
    const f = v.purse.floors;
    const det = f.det ?? 0;
    const by = f.detBy ?? null;
    const last = mem.lastDet ?? { det: 0, by: null };
    if (by === last.by && Math.abs(det - last.det) < 0.1 * f.cap) return;
    mem.lastDet = { det, by };
    const name = (id: PlayerID) =>
      v.game.hasPlayer(id) ? v.game.player(id).name() : id;
    const terms = (f.detTerms ?? [])
      .map((x) => `${name(x.id)}:${x.kind}:${Math.round(x.floor / 1000)}k`)
      .join(",");
    v.log?.(
      `${v.tick} def floor det=${Math.round(det / 1000)}k ` +
        `by=${by === null ? "-" : name(by)} home=${Math.round(v.purse.home / 1000)}k ` +
        `cap=${Math.round(f.cap / 1000)}k [${terms}]`,
    );
  }

  /**
   * o.detPosts (package B1): defense posts. Within defensePostRange (30) of
   * a post of ours an attacker loses ×5 troops per tile and takes ×3 as
   * long (Config.ts:377-387, AttackExecution.attackLogicInput); an attack
   * advances on every border tile at once (its queue ignores posts), so a
   * front covered in full loses about a fifth of the tiles. Every
   * POST_EVERY ticks, with gold for one (min(250k, 50k·(posts + 1))) and
   * fewer than detPostsMax posts ordered this game, the threats, most
   * troops first: with detPostReactive the nations attacking us by land
   * now, else with detPostProactive every bordering unallied nation that
   * could land-attack us at our home at its next decision
   * (NationModel.canLandAttackUs) with a potential send of at least
   * detPostMinThreat of our home (lib/Deterrence.potentialSend) and, with
   * detPostTargetCheck, a list that picks us or an attack on us in the
   * last POST_RECENT ticks; largest potential send first.
   * The first of up to POST_THREATS fronts with a site covering at least
   * detPostMinCover uncovered front tiles and detPostMinShare of the front
   * gets a post detPostDepth tiles behind it (lib/Deterrence.postSites). Why: in the showcase apex idled
   * at its cap for 15-30 minutes with 0.8-4.5M gold before one wave of
   * invasions took everything in 3 minutes (Mena: 97k tiles to 353 in 150
   * ticks, Tunisia 1.2M then 2.66M, Mali 1.33M).
   */
  private posts(
    v: View,
    s: ApexState,
    mem: DefenseMemory,
    attackers: Attacker[],
  ): void {
    const { o, me, game, nm, tick: t } = v;
    if (t - (mem.lastPost ?? NEVER) < POST_EVERY) return;
    mem.lastPost = t;
    const mine = me.units(UnitType.DefensePost);
    // Posts ordered, not alive: a conquered tile's defense post is
    // deleted, not captured (PlayerExecution.ts:72-74), and posts ordered
    // on a front under attack were destroyed before or soon after their 50
    // ticks of construction (arena quick Europe: 12 ordered, at most 4
    // standing at once).
    if ((mem.stats.posts ?? 0) >= o.detPostsMax) return;
    const cost = game.config().unitInfo(UnitType.DefensePost).cost(game, me);
    if (me.gold() < cost) return;
    // Threats, the largest stack first (their attack's troops, or the
    // potential send): with detPostReactive, nations attacking us by land
    // now; with detPostProactive, every bordering unallied nation that
    // could land-attack us at our home at its next decision (and, with
    // detPostTargetCheck, whose list would pick us).
    const threats: { N: Player; stack: number; why: string }[] = [];
    for (const x of o.detPostReactive ? attackers : []) {
      const p = x.player;
      if (p.type() !== PlayerType.Nation || me.isFriendly(p)) continue;
      if (x.first <= 0) continue;
      threats.push({
        N: p,
        stack: x.troops,
        why: `attack ${Math.round(x.troops)}`,
      });
    }
    if (threats.length === 0 && o.detPostProactive) {
      // Our home as the nations will see it: after an inbound bomb's city
      // levels are gone (the troops above the lower cap are cut), less
      // detPostLead, so a post is up before a regrowing nation crosses the
      // line (a post takes 50 ticks to build and does nothing until then).
      const nuked = s.nuke !== null ? s.nuke.capAfter : Infinity;
      const home = Math.min(me.troops(), nuked) * (1 - o.detPostLead);
      for (const n of v.wm.nations) {
        if (n.type !== PlayerType.Nation || n.friendly) continue;
        const st = nm.get(n.id);
        if (st === undefined || !st.full || !st.sharesBorderWithUs) continue;
        const d = nm.nextDecision(n.id, t + 1);
        if (!nm.canLandAttackUs(n.id, home, d)) continue;
        const N = game.player(n.id);
        const S = potentialSend(nm, v.models, N, home, d);
        if (S < o.detPostMinThreat * home) continue;
        const recent = t - (mem.lastIn?.[n.id] ?? NEVER) <= POST_RECENT;
        if (
          o.detPostTargetCheck &&
          !recent &&
          st.affordableTribes > o.detTribeSlack &&
          nm.wouldTargetUs(n.id, home) === null
        ) {
          continue;
        }
        threats.push({
          N,
          stack: S,
          why: `threat send=${Math.round(S)}${recent ? " recent" : ""}`,
        });
      }
    }
    threats.sort((a, b) => b.stack - a.stack || a.N.smallID() - b.N.smallID());
    const posts = mine.map((u) => u.tile());
    for (let k = 0; k < threats.length && k < POST_THREATS; k++) {
      const { N, why } = threats[k];
      const front = frontTiles(game, me, N);
      const sites = postSites(
        game,
        me,
        N,
        front,
        posts,
        game.config().defensePostRange(),
        o.detPostDepth,
        POST_CANDIDATES,
      );
      for (let i = 0; i < sites.length && i < POST_PROBES; i++) {
        if (sites[i].covers < o.detPostMinCover) break;
        if (sites[i].covers < o.detPostMinShare * front.length) break;
        const at = me.canBuild(UnitType.DefensePost, sites[i].tile);
        if (at === false) continue;
        const ok = v.scheduler.offer({
          intent: { type: "build_unit", unit: UnitType.DefensePost, tile: at },
          prio: Prio.Recall,
          cls: "defense",
          key: "build:post",
        });
        if (!ok) return;
        mem.stats.posts = (mem.stats.posts ?? 0) + 1;
        v.log?.(
          `${t} def post vs ${N.name()} (${why}) at ${game.x(at)},${game.y(at)} ` +
            `covers ${sites[i].covers}/${front.length} cost=${cost} ` +
            `gold=${me.gold()} posts=${mine.length + 1}`,
        );
        return;
      }
    }
  }

  // ── Incoming attacks (§3.3.1) ──────────────────────────────────────────

  /** Live incoming nation and human attacks (the scan may be two ticks
   *  old); logs each new one with the absorb estimate. */
  private scanIncoming(
    v: View,
    mem: DefenseMemory,
  ): { attackers: Attacker[]; incoming: number } {
    const { me, tick: t } = v;
    const by = new Map<number, Attacker>();
    const seen: Record<string, number> = {};
    let incoming = 0;
    const firstOf = new Map<number, number>();
    for (const a of me.incomingAttacks()) {
      const p = a.attacker();
      const ty = p.type();
      if (ty !== PlayerType.Nation && ty !== PlayerType.Human) continue;
      const sid = p.smallID();
      if (!firstOf.has(sid)) firstOf.set(sid, a.troops());
      const first = mem.seen[a.id()] ?? t;
      seen[a.id()] = first;
      const fresh = first === t;
      const estimate = fresh ? this.logIncoming(v, mem, a, p) : 0;
      if (fresh) {
        mem.stats.incoming++;
        (mem.lastIn ??= {})[p.id()] = t;
      }
      if (a.retreating()) continue;
      incoming += a.troops();
      const x = by.get(sid);
      if (x === undefined) {
        by.set(sid, {
          player: p,
          troops: a.troops(),
          fresh,
          estimate,
          first: firstOf.get(sid)!,
        });
      } else {
        x.troops += a.troops();
        x.fresh ||= fresh;
        x.estimate += estimate;
      }
    }
    mem.seen = seen;
    const attackers = [...by.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, x]) => x);
    return { attackers, incoming };
  }

  /** §3.3.1: an attack of a troops takes about a/p_def of our tiles, p_def
   *  its loss per tile against our density. Logged; returned for the
   *  counter's gate (it has been 3-100× pessimistic, arena showcase). */
  private logIncoming(
    v: View,
    mem: DefenseMemory,
    a: Attack,
    N: Player,
  ): number {
    const { me, models } = v;
    const troops = a.troops();
    const r = models.hit(
      { type: N.type(), tiles: N.numTilesOwned() },
      {
        type: PlayerType.Human,
        tiles: me.numTilesOwned(),
        troops: me.troops(),
        isTraitor: me.isTraitor(),
      },
      Math.max(1, troops),
      TerrainType.Plains,
      Math.max(1, a.borderSize()) + BORDER_JITTER,
    );
    const tiles = troops / Math.max(1e-9, r.attackerTroopLoss);
    v.log?.(
      `${v.tick} def in ${N.name()} ${Math.round(troops)} ` +
        `${a.sourceTile() !== null ? "boat" : "land"} ~${Math.round(tiles)} tiles ` +
        `home=${Math.round(me.troops())} tiles=${me.numTilesOwned()}`,
    );
    if (v.log !== undefined && N.type() === PlayerType.Nation) {
      const st = v.nm.get(N.id());
      const f = v.purse.floors;
      const term = f.detTerms?.find((x) => x.id === N.id());
      // A boat's attack starts at the ship's landing tile: its launch, as
      // the nation saw it, is the ship's `def boat` line.
      const src = a.sourceTile();
      let why: string;
      if (src === null) {
        why = attackWhy(me, N, troops, models, v.nm.sendCapSafe());
      } else {
        const ship = this.landed(mem, N.id(), src, troops);
        why =
          `boat launch ${ship === null ? "not seen" : `seen at ${ship.at}`} ` +
          attackWhy(me, N, troops, models, v.nm.sendCapSafe(), "landing");
      }
      v.log(
        `${v.tick} def why ${N.name()} ${why} ` +
          `nm border=${st?.sharesBorderWithUs ?? "-"} ` +
          `free=${st?.bordersFreeLand ?? "-"} tribes=${st?.affordableTribes ?? "-"} ` +
          `at=${st?.refreshedAt ?? "-"} H=${Math.round(f.H)} ` +
          `det=${Math.round(f.det ?? 0)}${term !== undefined ? ` term=${Math.round(term.floor)}` : ""}`,
      );
    }
    return tiles;
  }

  /** Logs only: the ship a nation's fresh boat attack of `troops` landed
   *  from, forgotten once matched: one of its ships bound for the attack's
   *  source tile (the landing tile), the one whose troops when first seen
   *  are nearest (ships sent at one tile land in turn), the first seen on a
   *  tie. */
  private landed(
    mem: DefenseMemory,
    by: PlayerID,
    src: TileRef,
    troops: number,
  ): SeenBoat | null {
    const boats = mem.boats ?? {};
    let best: number | null = null;
    for (const k of Object.keys(boats)) {
      const b = boats[Number(k)];
      if (b.by !== by || b.dst !== src || !b.ours) continue;
      if (
        best === null ||
        Math.abs(b.troops - troops) < Math.abs(boats[best].troops - troops)
      ) {
        best = Number(k);
      }
    }
    if (best === null) return null;
    const b = boats[best];
    delete boats[best];
    return b;
  }

  /**
   * Logs only (live, not in rollouts; never read by decisions): a `def boat` line
   * for each nation transport ship first seen at sea bound for our land,
   * with attackWhy read then. A boat's attack exists only once it lands,
   * often 100 ticks or more after the launch, so what the nation saw at
   * its decision (the ship took its troops at the launch,
   * PlayerImpl.buildUnit) is read here, the tick after the launch. A ship
   * first seen bound elsewhere is remembered as not ours, so a landing
   * tile we take later does not make it look like a boat at us.
   */
  private scanBoats(v: View, mem: DefenseMemory): void {
    const { me, game, tick: t } = v;
    const boats = (mem.boats ??= {});
    const live = new Set<number>();
    // Every nation: a boat comes from over the sea, so its nation is not
    // among the scan's neighbours (v.wm.nations are land contacts).
    for (const N of game.players()) {
      if (N.type() !== PlayerType.Nation) continue;
      for (const u of N.units(UnitType.TransportShip)) {
        const dst = u.targetTile();
        if (dst === undefined) continue;
        const id = u.id();
        live.add(id);
        if (boats[id] !== undefined) continue;
        const ours = game.ownerID(dst) === me.smallID();
        boats[id] = { at: t, by: N.id(), dst, ours, troops: u.troops() };
        if (!ours) continue;
        v.log?.(
          `${t} def boat ${N.name()} ${Math.round(u.troops())} ` +
            `to ${game.x(dst)},${game.y(dst)} ` +
            attackWhy(me, N, u.troops(), v.models, v.nm.sendCapSafe(), "sea"),
        );
      }
    }
    for (const k of Object.keys(boats)) {
      const id = Number(k);
      if (live.has(id)) continue;
      const b = boats[id];
      b.gone ??= t;
      if (t - b.gone > BOAT_GONE) delete boats[id];
    }
  }

  // ── §3.3.2 Recall by alliance ──────────────────────────────────────────

  private recalls(
    v: View,
    s: ApexState,
    mem: DefenseMemory,
    attackers: Attacker[],
  ): void {
    const { o, me, tick: t } = v;
    if (!o.recall && !o.counter) return;
    const slots = allySlots(v.game, me, o.allySlotsReserve);
    let held = me.alliances().length;
    for (const x of attackers) {
      const { player: N, fresh } = x;
      if (N.type() !== PlayerType.Nation || !N.isAlive()) continue;
      const why = o.recall
        ? this.recall(v, s, mem, N, held, slots.max)
        : me.isAlliedWith(N)
          ? "allied"
          : "recall off";
      if (why === null) held++;
      else if (fresh) {
        v.log?.(`${t} def absorb ${N.name()}: ${why}`);
        if (why !== "allied") this.counter(v, x);
      }
    }
  }

  /**
   * o.counter (not in the spec, §3.3.5 rules counter-attacks out of M2):
   * a fresh land attack of nation N we absorb, estimated to take at least
   * counterShare of our tiles, while home is at counterNearCap of the cap
   * or more: attack N with X = min(counterMargin·a, home − H) troops, a its
   * first land attack on us. X < a, so our attack cancels X of its troops
   * and is deleted at init, before the −100 relation hit (the embargo and
   * its request rejection at init still happen) [PIN AttackMerge]. Ungated
   * by the cap, it halved Bering's land in a scratch A/B; gated, it moved
   * Mena from 13th to 8th.
   */
  private counter(v: View, x: Attacker): void {
    const { o, me, tick: t } = v;
    if (!o.counter || x.first <= 0) return;
    if (x.estimate < o.counterShare * me.numTilesOwned()) return;
    const cap = v.purse.floors.cap;
    if (me.troops() < o.counterNearCap * cap) return;
    const X = Math.floor(
      Math.min(o.counterMargin * x.first, v.purse.home - v.purse.floors.H),
    );
    if (X < 1 || X >= x.first) return;
    const N = x.player;
    const ok = v.scheduler.offer({
      intent: { type: "attack", targetID: N.id(), troops: X },
      prio: Prio.Recall,
      cls: "defense",
      key: `attack:${N.smallID()}`,
      spend: { kind: "defense", troops: X },
      meta: { target: N.smallID() },
    });
    if (!ok) return;
    v.log?.(
      `${t} def counter ${N.name()} ${X} (its attack ${Math.round(x.first)}, ` +
        `~${Math.round(x.estimate)} tiles)`,
    );
  }

  /**
   * o.detCounter (package B1; docs/13 §2.3, §2.8): a counter that wins.
   * Our new attack on N cancels N's attacks on us 1:1 at its init, in N's
   * incoming order, retreating ones and landed boats included
   * (AttackExecution.ts:157-170): X = ceil(S·detCounterSize) + 1 with S
   * their total now deletes them all (they only shrink before ours inits,
   * GameImpl.ts:526-551) and goes on into N with the rest. Absorbing costs
   * land, and with it cap, for good (every elimination in arena quick@20
   * began as an invasion of an agent idle at its cap); a counter costs X
   * home troops, which regrow, and leaves N without the stack it sent
   * (below its trigger it runs its list 1 decision in 10, docs/13 §2.8).
   * Largest stack first, each only if home − X keeps
   * max(detCounterKeep·cap, H_vw) and, with detCounterNoUnlock, exposes us
   * to no other nation (lib/Deterrence.unlockedBy: none that cannot
   * land-attack us at home could at home − X, no bordering ally's betrayal
   * line detBetrayShare·T is crossed); never while a request of ours to N
   * is pending (the recall comes first), at most once per COUNTER_EVERY
   * ticks per nation, and not while N's live (not retreating) stacks are
   * under detCounterMin of home (absorbed: a small stack takes few tiles,
   * and a counter costs −100 relation). An attack from N that inits in
   * the same turn as ours is not covered (N decides once per 30-49 ticks).
   * Without the unlock guard, arena quick Alps lost half its land: two
   * counters on Ticino took home under St. Gallen's line, and St. Gallen
   * invaded with 1.84M.
   */
  private counterWins(v: View, mem: DefenseMemory, attackers: Attacker[]) {
    const { o, me, nm, game, tick: t } = v;
    const floors = v.purse.floors;
    const cap = floors.cap;
    if (cap <= 0) return;
    const stacks = new Map<number, { S: number; live: number }>();
    for (const a of me.incomingAttacks()) {
      const sid = a.attacker().smallID();
      const x = stacks.get(sid) ?? { S: 0, live: 0 };
      x.S += a.troops();
      if (!a.retreating()) x.live += a.troops();
      stacks.set(sid, x);
    }
    const order = attackers
      .filter(
        (x) =>
          x.player.type() === PlayerType.Nation &&
          x.player.isAlive() &&
          !me.isFriendly(x.player),
      )
      .map((x) => ({
        N: x.player,
        fresh: x.fresh,
        ...(stacks.get(x.player.smallID()) ?? { S: 0, live: 0 }),
      }))
      .sort((a, b) => b.S - a.S || a.N.smallID() - b.N.smallID());
    if (order.length === 0) return;
    mem.counters ??= {};
    let cands: PlayerID[] | null = null;
    for (const { N, fresh, S, live } of order) {
      const id = N.id();
      const home = v.purse.home;
      if (live <= 0 || live < o.detCounterMin * home) continue;
      if (t - (mem.counters[id] ?? NEVER) < COUNTER_EVERY) continue;
      if (mem.recalls[id] !== undefined) continue;
      if (me.outgoingAllianceRequests().some((r) => r.recipient() === N)) {
        continue;
      }
      const X = counterTroops(S, o.detCounterSize);
      const after = home - X;
      const keep = Math.max(o.detCounterKeep * cap, floors.vw);
      const skip = (why: string) => {
        if (fresh) {
          v.log?.(
            `${t} def counterskip ${N.name()} ${why} (stack ${Math.round(S)}, ` +
              `home ${Math.round(home)})`,
          );
        }
      };
      if (after < keep) {
        skip(`keep ${Math.round(keep)}`);
        continue;
      }
      if (o.detCounterNoUnlock) {
        cands ??= nationIds(game);
        const u = unlockedBy(
          me,
          nm,
          t,
          cands,
          id,
          home,
          after,
          o.detBetrayShare,
        );
        if (u !== null) {
          skip(`unlocks ${game.player(u.id).name()} (${u.kind})`);
          continue;
        }
      }
      // o.detCounterDecisive: only a counter after which N cannot attack us
      // again at its next decision (its troops already paid for the stack
      // we delete; a send it sized at its reserve leaves it there).
      if (
        o.detCounterDecisive &&
        nm.canLandAttackUs(id, after, nm.nextDecision(id, t + 1))
      ) {
        skip("not decisive");
        continue;
      }
      const ok = v.scheduler.offer({
        intent: { type: "attack", targetID: id, troops: X },
        prio: Prio.Recall,
        cls: "defense",
        key: `attack:${N.smallID()}`,
        spend: { kind: "defense", troops: X },
        meta: { target: N.smallID() },
      });
      if (!ok) {
        skip(`refused (${v.scheduler.lastRefusal})`);
        continue;
      }
      mem.counters[id] = t;
      mem.stats.counterWins = (mem.stats.counterWins ?? 0) + 1;
      v.log?.(
        `${t} def counterwin ${N.name()} ${X} (stack ${Math.round(S)}, ` +
          `home ${Math.round(home)}, keep ${Math.round(keep)})`,
      );
    }
  }

  /** One recall attempt on N; null if sent, else why not (for the log). */
  private recall(
    v: View,
    s: ApexState,
    mem: DefenseMemory,
    N: Player,
    held: number,
    max: number,
  ): string | null {
    const { o, me, nm, tick: t } = v;
    if (me.isAlliedWith(N)) return "allied";
    if (held >= max) return `slots ${held}/${max}`;
    if (!me.canSendAllianceRequest(N)) {
      return me.outgoingAllianceRequests().some((r) => r.recipient() === N)
        ? "request pending"
        : "request cooldown";
    }
    const id = N.id();
    const asked = me
      .incomingAllianceRequests()
      .some((r) => r.requestor() === N);
    if (asked) {
      // Its own request is pending: ours accepts it at once.
      if (!this.request(v, s, N)) return "refused by the scheduler";
      v.log?.(`${t} def recall ${N.name()} by counter-accept`);
      return null;
    }
    // tReq = T unless it decides in turn T + 1 (then wait a tick).
    const d = nm.nextDecision(id, t + 1);
    if (d < t + 2) return "it decides next turn";
    const stop = o.embargoStop && me.hasEmbargoAgainst(N);
    const stoppedBy = stop
      ? stopInFlight(s, id, t)
        ? mem.stops[id]
        : t
      : null;
    const f = nm.acceptsAlliance(id, {
      kind: "request",
      createdAt: t,
      atTick: d,
      embargoStoppedBy: stoppedBy,
    });
    if (f.p < o.recallMinP) return `p=${f.p.toFixed(2)} ${f.branch}`;
    if (stop && !offerEmbargoStop(v, s, N, Prio.Recall)) {
      return "refused by the scheduler";
    }
    if (!this.request(v, s, N)) return "refused by the scheduler";
    mem.recalls[id] = { at: t, d, p: f.p };
    mem.stats.recalls++;
    v.log?.(
      `${t} def recall ${N.name()} p=${f.p.toFixed(2)} ${f.branch} ` +
        `d=${d}${stop ? " +stop" : ""}`,
    );
    return null;
  }

  /** allianceRequest to N at Prio.Recall. cls "defense": the recall never
   *  waits on the diplomacy class cap. */
  private request(v: View, s: ApexState, N: Player): boolean {
    const p: Proposal = {
      intent: { type: "allianceRequest", recipient: N.id() },
      prio: Prio.Recall,
      cls: "defense",
      key: `ally:${N.id()}`,
    };
    if (!v.scheduler.offer(p)) return false;
    s.web.requested[N.id()] = v.tick;
    return true;
  }

  /** Logs each recall once its decision has answered it. */
  private settleRecalls(v: View, mem: DefenseMemory): void {
    for (const [id, r] of Object.entries(mem.recalls)) {
      if (v.tick <= r.d) continue;
      delete mem.recalls[id];
      if (!v.game.hasPlayer(id)) continue;
      const N = v.game.player(id);
      const ok = v.me.isAlliedWith(N);
      if (ok) mem.stats.accepted++;
      else mem.stats.refused++;
      v.log?.(
        `${v.tick} def recall ${N.name()} ${ok ? "accepted" : "refused"} ` +
          `(sent ${r.at}, p=${r.p.toFixed(2)})`,
      );
    }
  }

  // ── Embargo stops: §3.3.2 re-sends and §3.3.4 hygiene ─────────────────

  /**
   * Every temporary embargo of ours against a nation is stopped as soon as
   * it is seen, unless the nation is a strike target. At Prio.Recall while
   * a request of ours to it is pending and the stop still acts before its
   * answering decision (t <= d − 2), else at Prio.Diplomacy. A permanent
   * embargo is one we started on purpose, and is kept.
   */
  private stops(v: View, s: ApexState): void {
    const { o, me, nm, tick: t } = v;
    if (!o.embargoStop) return;
    const embargoes = me.getEmbargoes();
    if (embargoes.length === 0) return;
    const pending = new Map<Player, number>();
    for (const r of me.outgoingAllianceRequests()) {
      pending.set(r.recipient(), r.createdAt());
    }
    embargoes.sort((a, b) => a.target.smallID() - b.target.smallID());
    for (const e of embargoes) {
      const N = e.target;
      if (!e.isTemporary || N.type() !== PlayerType.Nation) continue;
      if (!N.isAlive() || strikeTarget(v, N)) continue;
      const created = pending.get(N);
      const urgent =
        created !== undefined && t <= nm.nextDecision(N.id(), created + 1) - 2;
      offerEmbargoStop(v, s, N, urgent ? Prio.Recall : Prio.Diplomacy);
    }
  }

  // ── §3.3.3 Free TN cancel ──────────────────────────────────────────────

  /**
   * When incoming nation troops exceed home − H_vw, cancel our free-land
   * attack: it retreats in 20 ticks with no malus (RetreatExecution.ts,
   * AttackExecution.ts:266-270). The cancel takes the allocator's TN key
   * (`attack:0`) in its tick and, re-sent, in the next: a TN send in either
   * would inherit the retreating attack and undo the cancel [PIN
   * AttackMerge]; from the tick after, the allocator sees it retreating.
   */
  private tnCancel(v: View, mem: DefenseMemory, incoming: number): void {
    const { o, me, tick: t } = v;
    if (!o.cancelTnOnThreat) return;
    const last = mem.tnCancel;
    if (t === last.at + 1) {
      // The guard tick: our RetreatExecution orders the retreat this turn.
      for (const id of last.ids) {
        const a = me.outgoingAttacks().find((x) => x.id() === id);
        if (a === undefined) continue;
        v.scheduler.offer(this.cancel(id));
      }
      return;
    }
    if (incoming <= 0 || t - last.at < TN_CANCEL_EVERY) return;
    const home = me.troops();
    const vw = v.purse.floors.vw;
    if (incoming <= home - vw) return;
    const ids: string[] = [];
    let troops = 0;
    for (const a of me.outgoingAttacks()) {
      if (a.target().isPlayer() || a.sourceTile() !== null) continue;
      if (a.retreating() || a.retreated()) continue;
      if (!v.scheduler.offer(this.cancel(a.id()))) break;
      ids.push(a.id());
      troops += a.troops();
    }
    if (ids.length === 0) return;
    mem.tnCancel = { at: t, ids };
    mem.stats.tnCancels++;
    v.log?.(
      `${t} def cancel tn ${Math.round(troops)} (incoming ${Math.round(incoming)} ` +
        `> home ${Math.round(home)} - vw ${Math.round(vw)})`,
    );
  }

  private cancel(attackID: string): Proposal {
    return {
      intent: { type: "cancel_attack", attackID },
      prio: Prio.Emergency,
      cls: "defense",
      key: "attack:0",
    };
  }
}
