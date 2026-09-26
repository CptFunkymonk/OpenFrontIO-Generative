import {
  Game,
  Player,
  PlayerID,
  PlayerType,
  UnitType,
} from "../../../../core/game/Game";
import type { TileRef } from "../../../../core/game/GameMap";
import type { NationModel } from "../../../lib/NationModel";
import { Prio } from "../../../lib/Scheduler";
import {
  conquestStack,
  isVulture,
  planStrike,
  postLossFactor,
  retaliationBound,
  retreatReason,
  StrikeSizing,
  StrikeWindowName,
  strikeYield,
  topUpReason,
  WindowInput,
} from "../../../lib/StrikeWindows";
import type { NeighborInfo } from "../../../lib/WorldModel";
import type { ApexOptions } from "../options";
import type { Controller, View } from "../policy";
import type { ApexState } from "../state";
import { BORDER_JITTER, incomingFrom, inStall } from "./ExpansionController";

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
// M4 (§5.2.2-3), package A1: window strikes (o.strikes, off by default;
// windowStrikes below, the rules in lib/StrikeWindows.ts). Not built:
// o.strikeWindows (E13; the window flags o.strikeW1..o.strikeOverwhelm
// stand in for it), o.strikeFork, steering (o.steering, o.steerGoldShare,
// E14) and bombs (o.bombs, E15).

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

// ── Window strikes (spec §5.2, package A1) ──────────────────────────────
//
// Every tick (the launch tick is exact, a decide every thinkEvery ticks
// would miss it), with o.strikes:
// - A bordering nation N that decided in the last turn (ctx.tick = d + 1)
//   is sampled (its troops, for W5) and, in stall mode (o.strikeStallOnly)
//   and while fewer than o.strikeMaxActive strikes run, evaluated: unallied,
//   attackable, not in s.web.allySet (§5.0: a nation is an ally or a
//   target), no alliance request pending either way (an accepted one
//   retreats our attack), no plan or stack of ours on it, not called back
//   within STRIKE_REST ticks, at least o.strikeMinContact contact, and with
//   o.strikeNukeVeto no finished silo and atom-bomb gold while we own a
//   city (a nation nukes the largest attacker first, §5.0). With
//   o.strikeLiveCheck the contact is counted live and a request to it
//   queued this tick (the DefenseController's recall) blocks too.
// - The stack is planStrike's: the conquest stack T1/ratio·margin (T1 its
//   troops at d1, its first decision to see the attack: launched now, the
//   attack runs rate − 1 ticks unseen), at least the kill cost, plus its
//   attacks on us (cancelled 1:1 at init); min(that, budget) if an enabled
//   window holds and the stack is at least T1/maxRatio after the answer.
//   The budget is purse.available("strike"), and with o.strikeDeterrence
//   home stays above every other unallied bordering nation's land line
//   (troopsAt/1.1 where its gates are open, at its decision
//   o.strikeDetHorizon ticks ahead) and 0.34× each bordering ally's troops
//   (betrayal); with o.strikeDetNearTarget also above those of the
//   nations bordering the target, which the conquest makes ours.
// - Value: tiles expected (all of them and gold/strikeGoldPerTile on a
//   kill, else the stack's worth at the loss per tile) per troop spent (on
//   a kill the tiles' losses and the answer's cancel, the rest comes home;
//   else the whole stack), at least o.strikeMinValue; a vulture (W5)
//   scores ×VULTURE_BONUS. The best of the tick's candidates is launched
//   (one launch per tick). With o.strikePosts the loss per tile is read at
//   the stack's real ratio after the answer, and the part of the front in
//   range of the target's finished defense posts costs
//   defensePostDefenseBonus× (postCover): nations post the front of any
//   land attack above 35% of their troops (NationStructureBehavior), so
//   long strikes meet posts within about 65 ticks. With o.strikeReachModel
//   the loss is read at the real ratio too, and the tiles over the
//   target's land reachable from our border (reachableTiles): a kill needs
//   all of it, and a pocket that runs out first sends the rest home
//   (strikeYield).
// - Top-ups: TOPUP_LEAD ticks before each decision of a nation we strike
//   (sent then, the top-up inits before the decision and is seen there),
//   the stack is raised to the conquest stack for its troops and answer
//   there (0 below its reserve, when locked, or when another attack on it
//   is larger than ours), if the purse can bring it back to ratio
//   maxRatio or lift it above an answer that would delete it (with
//   o.strikeSaveOpenOnly only at an open gate, and only to a stack within
//   maxRatio or able to kill); else the attack runs on with what it has.
//   With o.strikePosts, never into a front posted at o.strikePostCover or
//   more unless it makes the kill. The budget is strikeBudget's, the
//   deterrence floor recomputed at each top-up.
// - Not these: the ExpansionController's generic top-ups (§3.6.2) also
//   feed every plan of kind "strike", every tribeTopUpEvery ticks at the
//   tribe sizing from purse.available("strike") alone, so they bypass the
//   deterrence floor (review of A1: 21 sends, 2.08M troops over 8 of 42
//   strikes). Wiring for ExpansionController.topUps, not in this file:
//   skip plans of kind "strike" when o.strikes is on.
// - Reviews (o.strikeRetreat): one tick after each decision of a nation we
//   strike, a stack that can no longer kill is called back (cancel_attack)
//   when posts cover o.strikePostCover of the front or the nation holds
//   o.strikeRetreatRatio× our stack (retreatReason): the retreat ends
//   before the next decision, and 75% comes home. No strike on it for
//   STRIKE_REST ticks after. Off: in stall our home idles at the cap, so a
//   long strike that still buys land is worth its troops, and calling it
//   back cost survival in the A/B (options.ts, strikeRetreat).

/** Window evaluations per tick (each a cheap NationModel refresh; a full
 *  one only for a nation never refreshed). */
export const WINDOW_EVALS = 2;
/** A running strike is topped up this many ticks before the target's
 *  decision: sent at d − 3 it inits in turn d − 3 and is seen at d. */
export const TOPUP_LEAD = 3;
/** Top up when the stack is below this share of the need. */
export const TOPUP_AT = 0.95;
/** A top-up smaller than this share of the shortfall is skipped unless it
 *  saves the stack from the answer. */
export const TOPUP_MIN_SHARE = 0.25;
/** W5 (spec §5.2.2): troops down 30% since its last decision, under 15% of
 *  its cap, or attacked by more than half its troops. */
export const VULTURE_DROP = 0.3;
export const VULTURE_LOW = 0.15;
export const VULTURE_INCOMING = 0.5;
/** W6: another attack must be 1.2× ours (both burn while it decides). */
export const DECOY_MARGIN = 1.2;
/** Score factor of a vulture target: others are eating it now. */
export const VULTURE_BONUS = 1.5;
/** Below its trigger a nation runs its strategy list, retaliate first,
 *  only 1 decision in 10 (AiAttackBehavior.ts:293, chance(10)) [PIN
 *  NationRetaliate]: the answer o.strikeReachModel expects there. */
export const BELOW_TRIGGER_ANSWER_ODDS = 0.1;
/** isSafeToBetray / the only-neighbour rule (NationAllianceBehavior.ts
 *  :404-491): an ally with 3× (about) our home betrays us [PIN
 *  NationAlliance: 0.32 betrayed, 0.34 not]. */
export const BETRAY_SHARE = 0.34;
/** Ticks after a strike was called back before a new one on that nation
 *  (its posts stay; the dup guard alone keeps attacks out 17-23 ticks). */
export const STRIKE_REST = 300;
/** Share of a stack a retreat from a player brings home
 *  (AttackExecution.ts:37, malusForRetreat 25%) [PIN AttackMerge]. */
export const RETREAT_KEEP = 0.75;
/** A strike is called back only if at least this share of what would come
 *  home fits under our cap: troops above it are cut the next tick [PIN
 *  TroopCapClamp], while a stack left running still buys tiles (and with
 *  a home that full, an answer beyond our stack cannot land). */
export const RETREAT_ROOM = 0.5;
/** The annex line: the last 99 tiles fall with the one that takes a
 *  player under 100 (AttackExecution.ts:448-482) [PIN TribeStats]. */
const KILL_FREE = 99;
/** Ticks between two skip lines for one nation in the log. */
const SKIP_LOG_EVERY = 600;
/** Ticks between two `wstats` lines in the log. */
const STATS_EVERY = 600;

/** The window strikes' memory (spec §2.10), declared here as the
 *  Diplomacy and Defense memories are; plain data, created on first use. */
export interface StrikeMemory {
  /** Each bordering nation's troops one tick after its last decision. */
  lastT: Record<PlayerID, number>;
  /** Tick of the last skip line per nation (logs only). */
  skipLogged: Record<PlayerID, number>;
  /** Tick each nation's strike was last called back (o.strikeRetreat). */
  rest: Record<PlayerID, number>;
  /** Tick of the last `wstats` line (logs only). */
  statsAt: number;
  stats: {
    launches: number;
    topUps: number;
    retreats: number;
    /** Candidates skipped, by reason (logs and tests). */
    skips: Record<string, number>;
  };
}

declare module "../state" {
  interface ApexState {
    /** StrikeController memory (StrikeController.ts). */
    strike?: StrikeMemory;
  }
}

export function strikeMemory(s: ApexState): StrikeMemory {
  s.strike ??= {
    lastT: {},
    skipLogged: {},
    rest: {},
    statsAt: 0,
    stats: { launches: 0, topUps: 0, retreats: 0, skips: {} },
  };
  return s.strike;
}

/** The windows and sizing of the options. */
export function strikeSizing(o: ApexOptions): StrikeSizing {
  const windows: StrikeWindowName[] = [];
  if (o.strikeW1) windows.push("W1");
  if (o.strikeW2) windows.push("W2");
  if (o.strikeW3) windows.push("W3");
  if (o.strikeW5) windows.push("W5");
  if (o.strikeW6) windows.push("W6");
  if (o.strikeOverwhelm) windows.push("overwhelm");
  return {
    windows,
    vultureDrop: VULTURE_DROP,
    vultureLow: VULTURE_LOW,
    vultureIncoming: VULTURE_INCOMING,
    decoyMargin: DECOY_MARGIN,
    ratio: o.strikeRatio,
    margin: o.strikeMargin,
    maxRatio: o.strikeMaxRatio,
  };
}

/** Attacks on N now but ours: their troops, and the largest single one its
 *  retaliate would pick over ours (not a tribe's, not a friend's of N). */
export function attacksOn(
  N: Player,
  me: Player,
): { others: number; largest: number } {
  let others = 0;
  let largest = 0;
  for (const a of N.incomingAttacks()) {
    const att = a.attacker();
    if (att === me) continue;
    others += a.troops();
    if (att.type() === PlayerType.Bot || N.isFriendly(att)) continue;
    if (a.troops() > largest) largest = a.troops();
  }
  return { others, largest };
}

/** The WindowInput of nation N for a launch now (its first decision to see
 *  it is d1). Refreshes N cheaply (full only if it never was). */
export function windowInput(
  v: Pick<View, "nm" | "me" | "tick">,
  N: Player,
  Tprev: number | null,
): { inp: WindowInput; d1: number } {
  const id = N.id();
  const st = v.nm.refresh(id, "cheap");
  const d1 = v.nm.nextDecision(id, v.tick + 1);
  const on = attacksOn(N, v.me);
  return {
    d1,
    inp: {
      reserve: st.params.reserve,
      trigger: st.params.trigger,
      M: st.M,
      T: st.T,
      T1: v.nm.troopsAt(id, d1),
      locked1: v.nm.gates(id, d1) === "locked",
      Tprev,
      incomingOthers: on.others,
      largestOther: on.largest,
    },
  };
}

/**
 * The home troops no strike may spend below, other than the purse's
 * floor(strike) (o.strikeDeterrence): for each bordering nation but
 * `except`, unallied with its gates open or below trigger at its decision d
 * (the next one, or with o.strikeDetHorizon the first one that many ticks
 * ahead, its regrowth included), its land line (troopsAt(N, d) +
 * 1)/sendCapSafe [PIN NationSendCap]; for each bordering ally, BETRAY_SHARE
 * of its troops (at d with the horizon). 0 where no home deters
 * (sendCapSafe Infinity: Easy, Medium).
 *
 * With o.strikeDetNearTarget, also the nations that border the target
 * `except`: the conquest makes them ours while the stack is away. All its
 * neighbours (targetNeighbours), or the `near` ones given (with
 * o.strikeDetNearReach, those next to the land the stack can reach:
 * exposedNations). They are read as at a decision of theirs that sees us
 * as a neighbour: unallied ones at their land line unless below their
 * reserve (the free-land lock is not read: their state may be one full
 * refresh old, and their free land may be gone by the time they border
 * us), allies at the betrayal line.
 */
export function deterrenceFloor(
  v: Pick<View, "o" | "wm" | "nm" | "game" | "me" | "tick" | "models">,
  except: PlayerID | null,
  near?: readonly Player[],
): number {
  if (!v.o.strikeDeterrence) return 0;
  const safe = v.nm.sendCapSafe();
  if (!Number.isFinite(safe)) return 0;
  const horizon = Math.max(0, v.o.strikeDetHorizon);
  let floor = 0;
  const seen = new Set<PlayerID>();
  for (const info of v.wm.nations) {
    if (info.type !== PlayerType.Nation || info.id === except) continue;
    if (!v.game.hasPlayer(info.id)) continue;
    const N = v.game.player(info.id);
    if (!N.isAlive()) continue;
    seen.add(info.id);
    const d = v.nm.nextDecision(info.id, v.tick + horizon);
    if (v.me.isFriendly(N)) {
      const T = horizon > 0 ? v.nm.troopsAt(info.id, d) : N.troops();
      floor = Math.max(floor, BETRAY_SHARE * T);
      continue;
    }
    const g = v.nm.gates(info.id, d);
    if (g === "locked" || g === "belowReserve") continue;
    floor = Math.max(floor, (v.nm.troopsAt(info.id, d) + 1) / safe);
  }
  if (!v.o.strikeDetNearTarget || except === null) return floor;
  for (const N of near ?? targetNeighbours(v, except)) {
    const id = N.id();
    if (seen.has(id)) continue;
    const d = v.nm.nextDecision(id, v.tick + horizon);
    if (v.me.isFriendly(N)) {
      const T = horizon > 0 ? v.nm.troopsAt(id, d) : N.troops();
      floor = Math.max(floor, BETRAY_SHARE * T);
      continue;
    }
    const T = v.nm.troopsAt(id, d);
    if (T < v.nm.params(id).reserve * v.models.cap(N)) continue;
    floor = Math.max(floor, (T + 1) / safe);
  }
  return floor;
}

/** The live nations (type Nation) in the target's nearby() but us and the
 *  target: its land neighbours and those across a river, the players its
 *  land attacks can reach, as ours can once we hold its land (read-only:
 *  nearby() memoizes per territory version, as NationModel's full refresh
 *  reads it). Empty for a dead or unknown target. */
export function targetNeighbours(
  v: Pick<View, "game" | "me">,
  target: PlayerID,
): Player[] {
  if (!v.game.hasPlayer(target)) return [];
  const T = v.game.player(target);
  if (!T.isAlive()) return [];
  const out: Player[] = [];
  for (const x of T.nearby()) {
    if (!x.isPlayer()) continue;
    const N = x as Player;
    if (N === v.me || N === T || N.type() !== PlayerType.Nation) continue;
    if (!N.isAlive()) continue;
    out.push(N);
  }
  return out.sort((a, b) => a.smallID() - b.smallID());
}

/** Troops a strike on `target` may spend now: purse.available("strike"),
 *  at most home − deterrenceFloor (both after this tick's earlier takes). */
export function strikeBudget(
  v: View,
  target: PlayerID,
  near?: readonly Player[],
): number {
  const avail = v.purse.available("strike");
  if (avail <= 0) return 0;
  const det = deterrenceFloor(v, target, near);
  return Math.max(0, Math.min(avail, v.purse.home - det));
}

/**
 * o.strikeDetNearReach: the live nations (type Nation, not us or `N`) that
 * `exposed` (reachableTiles' third owners, each at the count of N's tiles
 * walked when first seen) meets within the first `depth` tiles of N's
 * land from our border: the neighbours a conquest that deep makes ours.
 * The walk goes breadth-first from our border, near enough the order an
 * attack takes tiles (AttackExecution conquers only tiles next to ours).
 */
export function exposedNations(
  v: Pick<View, "game" | "me">,
  N: Player,
  exposed: ReadonlyMap<number, number>,
  depth: number,
): Player[] {
  const out: Player[] = [];
  for (const [sid, at] of exposed) {
    if (at > depth) continue;
    const p = v.game.playerBySmallID(sid);
    if (!p.isPlayer()) continue;
    const X = p as Player;
    if (X === v.me || X === N || X.type() !== PlayerType.Nation) continue;
    if (!X.isAlive()) continue;
    out.push(X);
  }
  return out.sort((a, b) => a.smallID() - b.smallID());
}

/** Loss per tile (models.hitMix over the contact terrain) of a stack of
 *  `stack` troops on N while N holds `troops`: their ratio, clamped to
 *  [0.6, 2], scales it (Config.attackLogic). No defense post. */
export function strikeLoss(
  v: Pick<View, "models" | "wm">,
  N: Player,
  info: NeighborInfo,
  troops: number,
  stack: number,
): number {
  return v.models.hitMix(
    v.wm.tiles,
    {
      type: PlayerType.Nation,
      tiles: N.numTilesOwned(),
      troops: Math.max(0, troops),
      isTraitor: N.isTraitor(),
    },
    Math.max(1, stack),
    info.contactMix,
    info.contact + BORDER_JITTER,
  ).loss;
}

/** Loss per tile of a strike at the sizing ratio on N (models.hitMix), and
 *  the loss of every tile it pays for (the kill cost). */
export function strikeCost(
  v: Pick<View, "models" | "wm">,
  N: Player,
  info: NeighborInfo,
  T: number,
  ratio: number,
): { p: number; kill: number } {
  const tiles = N.numTilesOwned();
  const p = strikeLoss(v, N, info, T, Math.max(1, T / ratio));
  return { p, kill: p * Math.max(0, tiles - KILL_FREE) };
}

/**
 * The share of our contact with N (adjacency pairs, as NeighborInfo.contact
 * counts them: our tile, its tile) whose tile of N lies within
 * defensePostRange of a finished defense post of N, where an attack pays
 * defensePostDefenseBonus× losses and takes defensePostSpeedBonus× the time
 * (Config.attackLogic, AttackExecution.attackLogicInput). Walks the disc
 * around each post (radius 30: about 2,800 tiles), so it costs nothing
 * while N has none. Read-only.
 */
export function postCover(
  game: Game,
  me: Player,
  N: Player,
  contact: number,
): number {
  if (contact <= 0) return 0;
  const posts = N.units(UnitType.DefensePost).filter(
    (u) => u.isActive() && !u.isUnderConstruction(),
  );
  if (posts.length === 0) return 0;
  const R = game.config().defensePostRange();
  const R2 = R * R;
  const W = game.width();
  const H = game.height();
  const them = N.smallID();
  const us = me.smallID();
  const seen = new Set<TileRef>();
  let pairs = 0;
  const count = (n: TileRef) => {
    if (game.ownerID(n) === us) pairs++;
  };
  for (const u of posts) {
    const c = u.tile();
    const cx = game.x(c);
    const cy = game.y(c);
    for (let dy = -R; dy <= R; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > R2) continue;
        const x = cx + dx;
        if (x < 0 || x >= W) continue;
        const t = game.ref(x, y);
        if (game.ownerID(t) !== them || seen.has(t)) continue;
        seen.add(t);
        game.forEachNeighbor(t, count);
      }
    }
  }
  return Math.min(1, pairs / contact);
}

/** Whether N could nuke us for this strike (o.strikeNukeVeto): a finished
 *  silo and the gold for an atom bomb, while we own a city. */
export function nukeRisk(v: Pick<View, "models" | "me">, N: Player): boolean {
  if (v.me.units(UnitType.City).length === 0) return false;
  const silo = N.units(UnitType.MissileSilo).some(
    (u) => !u.isUnderConstruction(),
  );
  if (!silo) return false;
  return N.gold() >= v.models.unitCost(N, UnitType.AtomBomb);
}

/** The most tiles reachableTiles walks (o.strikeReachModel): at 4
 *  neighbour reads a tile, about 1 ms. A target with more reachable land
 *  counts as reaching whatever the stack can pay for. */
export const REACH_CAP = 1 << 14;
/** Slots of ReachSet: a power of two, twice REACH_CAP. */
const REACH_SLOTS = REACH_CAP << 1;

/** A reusable open-addressing set of tile refs (at most REACH_CAP), the
 *  BFS's visited set: a native Set of 16k tiles costs 4-8 ms a walk. */
export class ReachSet {
  private readonly slots = new Int32Array(REACH_SLOTS).fill(-1);
  private readonly used: number[] = [];

  get size(): number {
    return this.used.length;
  }

  /** Adds t; false if it was there. */
  add(t: TileRef): boolean {
    const mask = REACH_SLOTS - 1;
    let i = (Math.imul(t, 0x9e3779b1) >>> 16) & mask;
    for (;;) {
      const x = this.slots[i];
      if (x === t) return false;
      if (x === -1) {
        this.slots[i] = t;
        this.used.push(i);
        return true;
      }
      i = (i + 1) & mask;
    }
  }

  clear(): void {
    for (const i of this.used) this.slots[i] = -1;
    this.used.length = 0;
  }
}

/**
 * The tiles of N an attack of ours can reach (o.strikeReachModel): its
 * 4-neighbour components that touch our land. AttackExecution conquers
 * only a target tile with a 4-neighbour of ours, and when none is left it
 * retreats with no malus, so the rest comes home (AttackExecution.ts
 * :302-326). Walked breadth-first from our border, at most
 * min(cap, REACH_CAP) tiles: Infinity when the walk stops at that bound
 * short of N's size (at least that many), else the exact count. With
 * `exposed`, also notes each third player (smallID) next to a tile walked,
 * or next to our border, at the count of N's tiles walked when first seen
 * (o.strikeDetNearReach). Read-only.
 */
export function reachableTiles(
  game: Game,
  me: Player,
  N: Player,
  cap: number = REACH_CAP,
  set: ReachSet = new ReachSet(),
  exposed?: Map<number, number>,
): number {
  const them = N.smallID();
  const us = me.smallID();
  const size = N.numTilesOwned();
  const limit = Math.max(1, Math.min(cap, REACH_CAP, size));
  set.clear();
  const queue: TileRef[] = [];
  const visit = (n: TileRef) => {
    const owner = game.ownerID(n);
    if (owner !== them) {
      // o.strikeDetNearReach: a third player next to the land walked.
      if (exposed !== undefined && owner !== us && owner !== 0) {
        if (!exposed.has(owner)) exposed.set(owner, set.size);
      }
      return;
    }
    if (set.size >= limit) return;
    if (set.add(n)) queue.push(n);
  };
  // forEach walks the dense storage (the values() generator is slower); the
  // seeds past the limit cost one size check a tile.
  me.borderTiles().forEach((b) => {
    if (set.size < limit) game.forEachNeighbor(b, visit);
  });
  for (let i = 0; i < queue.length; i++) {
    // Capped short of N's size: stop. All of N walked: only the third
    // players next to the last tiles are left to note.
    if (set.size >= limit && (limit < size || exposed === undefined)) break;
    game.forEachNeighbor(queue[i], visit);
  }
  const n = set.size;
  set.clear();
  return n >= limit && n < size ? Infinity : n;
}

/** Whether our land touches N's in at least `need` adjacency pairs now
 *  (our border tile, its tile; as NeighborInfo.contact counts them), a
 *  live count that stops at `need` (o.strikeLiveCheck). Read-only. */
export function contactAtLeast(
  game: Game,
  me: Player,
  N: Player,
  need: number,
): boolean {
  if (need <= 0) return true;
  const them = N.smallID();
  let pairs = 0;
  const count = (n: TileRef) => {
    if (game.ownerID(n) === them) pairs++;
  };
  for (const b of me.borderTiles()) {
    game.forEachNeighbor(b, count);
    if (pairs >= need) return true;
  }
  return false;
}

interface Candidate {
  info: NeighborInfo;
  N: Player;
  S: number;
  score: number;
  line: string;
  clamp: number;
  refund: number;
}

/**
 * Strikes on nations (spec §3.5 in M2, §5.2 in M4). Enabled by `o.strike`;
 * the stall strike needs `o.stallStrike` (step 9), the window strikes
 * `o.strikes` (package A1).
 */
export class StrikeController implements Controller {
  readonly name = "strike";
  /** reachableTiles' scratch (o.strikeReachModel); holds nothing between
   *  calls. */
  private readonly reachSet = new ReachSet();

  onTick(v: View, s: ApexState): void {
    this.stallStrike(v, s);
    if (v.o.strikes) this.windowStrikes(v, s);
  }

  decide(v: View, s: ApexState): void {
    // M4 (§5.2): o.strikeWindows (E13), o.strikeFork, steering
    // (o.steering, o.steerGoldShare, E14), bombs (o.bombs, E15). The window
    // strikes run in onTick.
    void v;
    void s;
  }

  // ── §3.5 The stall strike (o.stallStrike) ──────────────────────────────

  private stallStrike(v: View, s: ApexState): void {
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

  // ── §5.2 Window strikes (o.strikes, package A1) ────────────────────────

  private windowStrikes(v: View, s: ApexState): void {
    const { o } = v;
    const mem = strikeMemory(s);
    this.stats(v, mem);
    // Nations that decided in the last turn: sample, and launch candidates.
    const due: { info: NeighborInfo; N: Player; prev: number | null }[] = [];
    for (const info of v.wm.nations) {
      if (info.type !== PlayerType.Nation) continue;
      if (v.nm.nextDecision(info.id, v.tick - 1) !== v.tick - 1) continue;
      if (!v.game.hasPlayer(info.id)) continue;
      const N = v.game.player(info.id);
      if (!N.isAlive()) continue;
      due.push({ info, N, prev: mem.lastT[info.id] ?? null });
      mem.lastT[info.id] = N.troops();
    }
    if (o.strikeRetreat) this.reviews(v, mem, due);
    this.topUps(v, s, mem);
    if (due.length === 0) return;
    if (o.strikeStallOnly && !inStall(s, v.tick, o)) return;
    let active = 0;
    for (const p of v.ledger.allPlans()) if (p.kind === "strike") active++;
    if (active >= o.strikeMaxActive) return;
    if (v.purse.available("strike") <= 0) return;

    const sizing = strikeSizing(o);
    let best: Candidate | null = null;
    let evals = 0;
    for (const { info, N, prev } of due) {
      if (evals >= WINDOW_EVALS) break;
      const why = this.ineligible(v, s, mem, info, N);
      if (why !== null) {
        this.skip(v, mem, info.id, why);
        continue;
      }
      evals++;
      const { inp, d1 } = windowInput(v, N, prev);
      const inc = incomingFrom(v, info.smallID);
      // o.strikeDetNearReach: the target's neighbours are read once the walk
      // below knows which of them the stack can reach; none yet.
      const nearReach = o.strikeDetNearTarget && o.strikeDetNearReach;
      let budget = strikeBudget(v, info.id, nearReach ? [] : undefined);
      if (budget < 1) {
        this.skip(v, mem, info.id, "budget");
        continue;
      }
      // o.strikePosts: the posted share of the front costs ×bonus a tile.
      const cover = o.strikePosts
        ? postCover(v.game, v.me, N, info.contact)
        : 0;
      const factor = o.strikePosts
        ? postLossFactor(cover, v.game.config().defensePostDefenseBonus())
        : 1;
      const size = N.numTilesOwned();
      const cost = strikeCost(v, N, info, inp.T1, o.strikeRatio);
      // o.strikeReachModel: the land an attack of ours can reach; no kill
      // stack for a target we cannot reach whole.
      let reach = Infinity;
      let near: Player[] | undefined = nearReach ? [] : undefined;
      if (o.strikeReachModel || nearReach) {
        const exposed = nearReach ? new Map<number, number>() : undefined;
        const r = reachableTiles(
          v.game,
          v.me,
          N,
          REACH_CAP,
          this.reachSet,
          exposed,
        );
        if (o.strikeReachModel) reach = r;
        if (exposed !== undefined) {
          // As deep as the budget before their lines pays for.
          const depth = Math.min(REACH_CAP, budget / Math.max(1, cost.p));
          near = exposedNations(v, N, exposed, depth);
          budget = strikeBudget(v, info.id, near);
          if (budget < 1) {
            this.skip(v, mem, info.id, "budget");
            continue;
          }
        }
      }
      const killable = reach >= size - KILL_FREE;
      const plan = planStrike(
        inp,
        inc,
        budget,
        sizing,
        killable ? cost.kill * factor : 0,
      );
      if (plan.S <= 0) {
        const k = (x: number) => `${Math.round(x / 1000)}k`;
        this.skip(
          v,
          mem,
          info.id,
          plan.verdict.window === null ? "window" : "stack",
          `min=${k(plan.min)} budget=${k(budget)} T1=${k(inp.T1)}`,
        );
        continue;
      }
      const left = plan.S - plan.verdict.answer - inc;
      // o.strikePosts, o.strikeReachModel: the loss at the stack's real
      // ratio after the answer (a purse-limited stack pays up to 3.3× the
      // cheapest a tile).
      const p =
        o.strikePosts || o.strikeReachModel
          ? strikeLoss(v, N, info, inp.T1 - plan.verdict.answer, left) * factor
          : cost.p;
      let kill: boolean;
      let pocket = false;
      let tiles: number;
      let spent: number;
      let refund: number;
      if (o.strikeReachModel) {
        // Valued at the answer expected, sized for it for certain: below
        // its trigger at d1 it answers 1 decision in 10.
        const odds =
          inp.T1 < inp.trigger * inp.M ? BELOW_TRIGGER_ANSWER_ODDS : 1;
        const y = strikeYield(
          plan.S,
          left,
          p,
          size,
          reach,
          KILL_FREE,
          inc + odds * plan.verdict.answer,
        );
        ({ kill, pocket, tiles, spent, refund } = y);
      } else {
        const killCost = o.strikePosts
          ? p * Math.max(0, size - KILL_FREE)
          : cost.kill;
        kill = left >= killCost;
        tiles = kill ? size : Math.min(size, left / Math.max(1, p));
        // Per troop spent: a kill pays its tiles and the answer's 1:1
        // cancel, the rest of the stack comes home; short of a kill all of
        // it burns.
        spent = kill ? killCost + plan.verdict.answer + inc : plan.S;
        refund = kill ? Math.max(0, left - killCost) : 0;
      }
      const value =
        tiles +
        (kill ? Number(N.gold()) / Math.max(1, o.strikeGoldPerTile) : 0);
      const perTroop = value / Math.max(1, spent);
      if (perTroop < o.strikeMinValue) {
        this.skip(
          v,
          mem,
          info.id,
          "value",
          `value/troop=${perTroop.toFixed(4)}`,
        );
        continue;
      }
      const vulture = isVulture(inp, sizing);
      const score = perTroop * (vulture ? VULTURE_BONUS : 1);
      if (best !== null && score <= best.score) continue;
      const k = (x: number) => `${Math.round(x / 1000)}k`;
      best = {
        info,
        N,
        S: plan.S,
        score,
        clamp: conquestStack(inp.T1, plan.verdict.answer, inc, sizing),
        refund: Math.max(0, refund),
        line:
          `wstrike ${info.id} ${plan.verdict.window} ` +
          `open=[${plan.verdict.open.join(",")}] S=${k(plan.S)} ` +
          `want=${k(plan.want)} min=${k(plan.min)} T=${k(inp.T)} ` +
          `T(d1=${d1})=${k(inp.T1)} M=${k(inp.M)} res=${inp.reserve} ` +
          `ans=${k(plan.verdict.answer)} inc=${k(inc)} budget=${k(budget)} ` +
          `tiles=${size} kill=${kill ? "y" : "n"} ` +
          `p=${p.toFixed(1)} value/troop=${perTroop.toFixed(4)}` +
          (vulture ? " vulture" : "") +
          (o.strikePosts ? ` cover=${cover.toFixed(2)}` : "") +
          (o.strikeReachModel
            ? ` reach=${Number.isFinite(reach) ? reach : "big"}` +
              (pocket ? " pocket" : "")
            : "") +
          (o.strikeDetNearTarget
            ? ` det=${k(deterrenceFloor(v, info.id, near))}` +
              (near !== undefined ? ` near=${near.length}` : "")
            : ""),
      };
    }
    if (best === null) return;
    const sid = best.info.smallID;
    const ok = v.scheduler.offer({
      intent: { type: "attack", targetID: best.info.id, troops: best.S },
      prio: Prio.Strike,
      cls: "strike",
      key: `attack:${sid}`,
      spend: { kind: "strike", troops: best.S },
      plan: "strike",
      meta: {
        target: sid,
        clampTroops: best.clamp,
        expectedRefund: best.refund,
      },
    });
    if (!ok) return;
    mem.stats.launches++;
    v.log?.(`${v.tick} ${best.line}`);
  }

  /** The launch filters of windowStrikes (before any refresh): why N is
   *  not a candidate, or null. */
  private ineligible(
    v: View,
    s: ApexState,
    mem: StrikeMemory,
    info: NeighborInfo,
    N: Player,
  ): string | null {
    if (info.friendly || v.me.isFriendly(N)) return "ally";
    if (!info.attackable) return "immune";
    // §5.0: a nation is either in allySet or a strike target.
    if (s.web.allySet.includes(info.id)) return "allySet";
    // An accepted request would retreat the attack.
    for (const r of v.me.outgoingAllianceRequests()) {
      if (r.recipient() === N) return "request";
    }
    for (const r of v.me.incomingAllianceRequests()) {
      if (r.requestor() === N) return "request";
    }
    const sid = info.smallID;
    const l = v.ledger;
    if (
      l.plan(sid) !== undefined ||
      l.stackOn(sid) > 0 ||
      l.retreatingOn(sid) > 0
    ) {
      return "busy";
    }
    const rest = mem.rest[info.id];
    if (rest !== undefined && v.tick - rest < STRIKE_REST) return "rest";
    if (info.contact < v.o.strikeMinContact) return "contact";
    if (v.o.strikeNukeVeto && nukeRisk(v, N)) return "nuke";
    if (v.o.strikeLiveCheck) {
      // A request queued earlier this tick (the DefenseController's recall
      // runs first) would retreat the attack once accepted.
      if (v.scheduler.hasKey(`ally:${info.id}`)) return "request";
      // The scan's contact may be thinkEvery − 1 ticks old.
      const need = Math.max(1, v.o.strikeMinContact);
      if (!contactAtLeast(v.game, v.me, N, need)) return "liveContact";
    }
    return null;
  }

  /** Counts a skipped candidate; logs it at most once per SKIP_LOG_EVERY
   *  ticks per nation. */
  private skip(
    v: View,
    mem: StrikeMemory,
    id: PlayerID,
    why: string,
    detail = "",
  ): void {
    mem.stats.skips[why] = (mem.stats.skips[why] ?? 0) + 1;
    const last = mem.skipLogged[id];
    if (last !== undefined && v.tick - last < SKIP_LOG_EVERY) return;
    mem.skipLogged[id] = v.tick;
    v.log?.(`${v.tick} wstrike-skip ${id} ${why}${detail ? ` ${detail}` : ""}`);
  }

  /** A `wstats` line every STATS_EVERY ticks (logs only). */
  private stats(v: View, mem: StrikeMemory): void {
    if (v.log === undefined || v.tick - mem.statsAt < STATS_EVERY) return;
    mem.statsAt = v.tick;
    const st = mem.stats;
    v.log(
      `${v.tick} wstats launches=${st.launches} topUps=${st.topUps} ` +
        `retreats=${st.retreats} skips=${JSON.stringify(st.skips)}`,
    );
  }

  /** The strike plans of ours on live nations: target, its NeighborInfo
   *  (null once it no longer borders us) and our live stack. */
  private strikes(
    v: View,
  ): { sid: number; N: Player; info: NeighborInfo | null; A: number }[] {
    const out: {
      sid: number;
      N: Player;
      info: NeighborInfo | null;
      A: number;
    }[] = [];
    for (const plan of v.ledger.allPlans()) {
      if (plan.kind !== "strike" || plan.targetSmallID === 0) continue;
      const sid = plan.targetSmallID;
      const p = v.game.playerBySmallID(sid);
      if (!p.isPlayer() || !p.isAlive() || p.type() !== PlayerType.Nation) {
        continue;
      }
      const A = v.ledger.stackOn(sid);
      if (A <= 0) continue;
      out.push({
        sid,
        N: p as Player,
        info: v.wm.neighbors.get(sid) ?? null,
        A,
      });
    }
    return out;
  }

  /** Whether a stack of A troops on N (holding T, answering `answer`) can
   *  still take every tile it pays for, at the loss per tile of its ratio
   *  and the posted share of the front (o.strikePosts). */
  private canKill(
    v: View,
    N: Player,
    info: NeighborInfo,
    T: number,
    A: number,
    answer: number,
    inc: number,
    factor: number,
  ): boolean {
    const left = A - answer - inc;
    if (left <= 0) return false;
    const p = strikeLoss(v, N, info, T - answer, left) * factor;
    return left >= p * Math.max(0, N.numTilesOwned() - KILL_FREE);
  }

  /**
   * o.strikeRetreat: one tick after the decision of a nation we strike
   * (`due` holds the nations that decided in the last turn), call back a
   * stack that can no longer kill when retreatReason says so. Its next
   * decision is rate − 1 ≥ 29 ticks away and the retreat takes 20, so no
   * answer meets the retreating stack [PIN NationRetaliate: a cancel does
   * not save a stack the answer reaches].
   */
  private reviews(
    v: View,
    mem: StrikeMemory,
    due: { info: NeighborInfo; N: Player }[],
  ): void {
    if (due.length === 0) return;
    const { o } = v;
    const decided = new Set(due.map((x) => x.N));
    for (const { sid, N, info, A } of this.strikes(v)) {
      if (!decided.has(N) || info === null) continue;
      const id = N.id();
      const T = N.troops();
      const cover = postCover(v.game, v.me, N, info.contact);
      const factor = postLossFactor(
        cover,
        v.game.config().defensePostDefenseBonus(),
      );
      const st = v.nm.refresh(id, "cheap");
      const dn = v.nm.nextDecision(id, v.tick);
      const answer =
        v.nm.gates(id, dn) === "open"
          ? retaliationBound(v.nm.troopsAt(id, dn), st.params.reserve, st.M)
          : 0;
      const inc = incomingFrom(v, sid);
      const kill = this.canKill(v, N, info, T, A, answer, inc, factor);
      const why = retreatReason(
        { cover, T, A, kill },
        { postCover: o.strikePostCover, ratio: o.strikeRetreatRatio },
      );
      if (why === null) continue;
      // Worth calling back only if what comes home fits under the cap.
      const room = v.models.cap(v.me) - v.me.troops();
      if (room < RETREAT_ROOM * RETREAT_KEEP * A) {
        this.skip(v, mem, id, "retreatRoom");
        continue;
      }
      let sent = 0;
      for (const a of v.me.outgoingAttacks()) {
        if (a.target() !== N || a.sourceTile() !== null) continue;
        if (a.retreating() || a.retreated()) continue;
        const ok = v.scheduler.offer({
          intent: { type: "cancel_attack", attackID: a.id() },
          prio: Prio.Strike,
          cls: "strike",
          key: `cancel:${a.id()}`,
        });
        if (!ok) break;
        sent++;
      }
      if (sent === 0) continue;
      mem.rest[id] = v.tick;
      mem.stats.retreats++;
      const k = (x: number) => `${Math.round(x / 1000)}k`;
      v.log?.(
        `${v.tick} wretreat ${id} ${why} A=${k(A)} T=${k(T)} ` +
          `cover=${cover.toFixed(2)} ans=${k(answer)} tiles=${N.numTilesOwned()}`,
      );
    }
  }

  /** Top-ups of our running strikes TOPUP_LEAD ticks before each of the
   *  target's decisions (window strikes and stall strikes alike). */
  private topUps(v: View, s: ApexState, mem: StrikeMemory): void {
    void s;
    const { o } = v;
    const sizing = strikeSizing(o);
    for (const { sid, N, info, A } of this.strikes(v)) {
      const id = N.id();
      const d = v.nm.nextDecision(id, v.tick);
      if (d - v.tick !== TOPUP_LEAD) continue;
      const st = v.nm.refresh(id, "cheap");
      const Td = v.nm.troopsAt(id, d);
      const g = v.nm.gates(id, d);
      const quiet =
        g === "locked" ||
        g === "belowReserve" ||
        attacksOn(N, v.me).largest >= DECOY_MARGIN * A;
      const answer = quiet ? 0 : retaliationBound(Td, st.params.reserve, st.M);
      const inc = incomingFrom(v, sid);
      const need = conquestStack(Td, answer, inc, sizing);
      if (A >= TOPUP_AT * need) continue;
      let near: Player[] | undefined;
      if (o.strikeDetNearTarget && o.strikeDetNearReach) {
        // The target's neighbours next to the land the topped-up stack can
        // reach from our border now.
        near = [];
        if (info !== null) {
          const exposed = new Map<number, number>();
          reachableTiles(v.game, v.me, N, REACH_CAP, this.reachSet, exposed);
          const most = A + strikeBudget(v, id, []);
          const p = strikeLoss(v, N, info, Td, most);
          const depth = Math.min(REACH_CAP, most / Math.max(1, p));
          near = exposedNations(v, N, exposed, depth);
        }
      }
      const budget = strikeBudget(v, id, near);
      const add = Math.floor(Math.min(need - A, budget));
      if (add < 1) continue;
      // Worth it if it restores a ratio of at most maxRatio after the
      // answer, or if it lifts a stack the answer would delete whole above
      // it (topUpReason).
      const why = topUpReason(
        { A, add, need, Td, answer, inc },
        {
          maxRatio: o.strikeMaxRatio,
          minShare: TOPUP_MIN_SHARE,
          saveOpenOnly: o.strikeSaveOpenOnly,
        },
        g === "open",
        () =>
          info !== null &&
          this.canKill(v, N, info, Td, A + add, answer, inc, 1),
      );
      if (why === null) continue;
      // o.strikePosts: no more troops into a posted front short of a kill.
      if (o.strikePosts && info !== null) {
        const cover = postCover(v.game, v.me, N, info.contact);
        if (cover >= o.strikePostCover) {
          const factor = postLossFactor(
            cover,
            v.game.config().defensePostDefenseBonus(),
          );
          if (!this.canKill(v, N, info, Td, A + add, answer, inc, factor)) {
            continue;
          }
        }
      }
      const ok = v.scheduler.offer({
        intent: { type: "attack", targetID: id, troops: add },
        prio: Prio.TopUp,
        cls: "topup",
        key: `attack:${sid}`,
        spend: { kind: "strike", troops: add },
        plan: "strike",
        meta: { target: sid, clampTroops: need },
      });
      if (!ok) {
        const why = v.scheduler.lastRefusal;
        if (why === "budget" || why === "classCap") return;
        continue;
      }
      mem.stats.topUps++;
      const k = (x: number) => `${Math.round(x / 1000)}k`;
      v.log?.(
        `${v.tick} wtopup ${id} +${k(add)} A=${k(A)} need=${k(need)} ` +
          `T(d=${d})=${k(Td)} ans=${k(answer)} gate=${g} why=${why}`,
      );
    }
  }
}
