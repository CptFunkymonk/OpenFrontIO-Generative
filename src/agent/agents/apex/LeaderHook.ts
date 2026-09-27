import { PlayerID, UnitType } from "../../../core/game/Game";
import { CityGate, cityGate } from "../../lib/GoldPolicy";
import {
  alliancesEndedBy,
  betrayalFloor,
  BetrayalLine,
  betrayalLines,
  BetrayalParams,
  emptyGoldHistory,
  GoldHistory,
  leaderGuardModels,
  levelsFor,
  mirvDanger,
  MirvLines,
  MirvRule,
  noteGold,
  PendingBreaks,
} from "../../lib/LeaderGuard";
import type { HomeFloors } from "../../lib/Scheduler";
import type { HomeTargetInputs } from "./HomeTarget";
import type { ApexOptions } from "./options";
import type { View } from "./policy";
import { ApexState, NEVER } from "./state";

// Package WP10b, the leader guard's hooks (lib/LeaderGuard.ts; option
// o.leaderGuard, off by default). A base rule: the search's rollouts run
// the same code on a copy of the state, so they play it too.
// - The floor (leaderFloor, called by HomeTarget.homeFloors at each
//   decision): H, the TN floor and the strike floor are at least the
//   largest held betrayal line of our bordering allies, so tribe, boat,
//   free-land and strike sends (and the search's directive sends, sized
//   from the same purse) keep home at it. Snacks and defense keep vw (the
//   DefenseController's o.counter, off by default, keeps H: a counter of
//   ours spends nothing below a line either, review F6). The lines
//   are for the allies' decisions until the next recompute (thinkEvery
//   ticks on), and a break, MIRV or bomb of the search's directive due by
//   then that ends an alliance counts us a traitor already (review F1: the
//   break's strike goes out the tick after the break, before we are one).
//   The ExpansionController's stall test reads H without this floor
//   (floors.Hbase, review F6): troops held for a line are not idle work.
// - The cap (leaderCityGate, asked by the EconomyController when today's
//   City rule refuses every site): while a line is above leaderMaxShare of
//   our cap, the gold arm's gate ("model", or "free" with leaderCapFree)
//   buys City levels up to the cap that holds it, never past the MIRV
//   city-leader line or the dense-target line (goldGuard).
// - The MIRV lines and danger (mirvDanger, every GOLD_EVERY ticks): who
//   could MIRV us and when, for the logs, and in s.leader for other code
//   (the search's triggers, a gold guard) to read.

/** Ticks between two gold samples, and between two MIRV danger reads. */
export const GOLD_EVERY = 30;
/** Ticks between two log lines. */
export const LOG_EVERY = 600;
/** Ticks after a step's tick until the game shows the alliance it ends
 *  broken: a breakAlliance executes in the next turn (me.isTraitor() from
 *  tick + 2), a MIRV or bomb spawns, and breaks, in turn tick + 2 (docs/13
 *  §2.13: from tick + 3). */
export const BREAK_LAG = 3;

/** Pending breaks of ours (review F1), held until `until`. Plain data. */
export interface LeaderPending extends PendingBreaks {
  until: number;
}

/** The first silo owner that would MIRV us (lib/LeaderGuard MirvThreat,
 *  with null for "never"). Plain data. */
export interface LeaderDanger {
  id: PlayerID;
  rule: MirvRule;
  gold: number;
  price: number;
  /** Ticks until it can pay at its net gold rate (null: never). */
  eta: number | null;
  /** Its first decision after that (null: never). */
  at: number | null;
}

/** What the guard keeps between decisions. Plain data (JSON-safe). */
export interface LeaderMemory {
  gold: GoldHistory;
  /** Tick of the decision that computed the lines below. */
  at: number;
  /** Home floor from the betrayal lines, and the ally behind it. */
  floor: number;
  by: PlayerID | null;
  /** Cap we lack to hold the largest line above leaderMaxShare of the cap,
   *  the ally behind it, and the cap that would hold it. */
  capShort: number;
  shortBy: PlayerID | null;
  capWant: number;
  lines: BetrayalLine[];
  /** The alliances our pending acts end (review F1: the directive's
   *  steps due by the next decision, and the ones sent that the game does
   *  not show yet); null when none. */
  pending: LeaderPending | null;
  /** The MIRV lines and the first silo owner that would MIRV us, as of
   *  the last read (every GOLD_EVERY ticks). */
  mirv: MirvLines | null;
  danger: LeaderDanger | null;
  /** The silo owner with the most gold at the last read, whatever it aims
   *  at (rule null), with its time to the price. */
  richest: {
    id: PlayerID;
    gold: number;
    price: number;
    eta: number | null;
  } | null;
  /** Silo owners at the last read. */
  siloOwners: number;
  mirvAt: number;
  loggedAt: number;
}

declare module "./state" {
  interface ApexState {
    /** o.leaderGuard (package WP10b, LeaderHook.ts): the nations' gold
     *  samples and the last decision's betrayal lines, floor and cap need,
     *  and the MIRV danger. Read by the EconomyController's city gate; the
     *  search may read it (host.state). Plain data. */
    leader?: LeaderMemory;
  }
}

function newMemory(): LeaderMemory {
  return {
    gold: emptyGoldHistory(),
    at: NEVER,
    floor: 0,
    by: null,
    capShort: 0,
    shortBy: null,
    capWant: 0,
    lines: [],
    pending: null,
    mirv: null,
    danger: null,
    richest: null,
    siloOwners: 0,
    mirvAt: NEVER,
    loggedAt: NEVER,
  };
}

/** The guard's parameters from the options. */
export function leaderParams(o: ApexOptions): BetrayalParams {
  return {
    margin: o.leaderMargin,
    allyOut: o.leaderAllyOut,
    ourOut: o.leaderOurOut,
    maxShare: o.leaderMaxShare,
    gates: o.leaderGates,
  };
}

/**
 * o.leaderGuard: this decision's home floor from the betrayal lines of our
 * bordering allies (0 when off, without the game, or outside FFA), noted
 * with the lines and the cap they need in s.leader; every GOLD_EVERY ticks
 * also the nations' gold samples and the MIRV danger, and every LOG_EVERY
 * ticks, and at a decision a break of ours is pending in, a log line (live
 * only).
 */
export function leaderFloor(
  v: HomeTargetInputs,
  s: ApexState,
  cap: number,
): number {
  const { o, game, me, nm, tick } = v;
  if (!o.leaderGuard || game === undefined || !leaderGuardModels(game)) {
    return 0;
  }
  const mem = (s.leader ??= newMemory());
  const floor = leaderLines(v, s, mem, cap, pendingBreaks(v, s, mem));
  if (tick - mem.mirvAt >= GOLD_EVERY) {
    mem.mirvAt = tick;
    noteGold(mem.gold, game, tick, GOLD_EVERY, o.leaderGoldWindow);
    const d = mirvDanger(game, me, nm, mem.gold, tick);
    // Finite for JSON: with MIRVs disabled the city line is Infinity.
    const finite = (x: number) =>
      Number.isFinite(x) ? x : Number.MAX_SAFE_INTEGER;
    mem.mirv = {
      ...d.lines,
      cityLine: finite(d.lines.cityLine),
      cityRoom: finite(d.lines.cityRoom),
    };
    mem.siloOwners = d.threats.length;
    mem.richest =
      d.richest === null
        ? null
        : {
            id: d.richest.id,
            gold: d.richest.gold,
            price: d.richest.price,
            eta: Number.isFinite(d.richest.eta) ? d.richest.eta : null,
          };
    mem.danger =
      d.first === null || d.first.rule === null
        ? null
        : {
            id: d.first.id,
            rule: d.first.rule,
            gold: d.first.gold,
            price: d.first.price,
            eta: Number.isFinite(d.first.eta) ? d.first.eta : null,
            at: Number.isFinite(d.first.at) ? d.first.at : null,
          };
  }
  if (v.log) {
    if (tick - mem.loggedAt >= LOG_EVERY) {
      mem.loggedAt = tick;
      v.log(leaderText(v, mem, cap));
    } else if (mem.pending !== null) {
      // A decision a break of ours is pending in (off the log's cadence).
      v.log(leaderText(v, mem, cap));
    }
  }
  return floor;
}

/**
 * o.leaderGuard between two decisions (called by the policy's run when it
 * is no decision tick; review F1): the search acts at any tick, so a plan
 * that breaks an alliance can be adopted after this decision's floors,
 * and its strike goes out the next tick. When the steps due by the next
 * decision end an alliance the floors did not count (a new id in the
 * pending breaks), the betrayal lines are read again with it and the
 * leader floor is put on the floors anew (H, tn and strike, over the base
 * H this decision's floors were built on, as homeFloors builds them);
 * otherwise the floors are returned as they are. The rest of homeFloors
 * (food, deterrence) waits for the decision.
 */
export function leaderRefloor(
  v: HomeTargetInputs,
  s: ApexState,
  floors: HomeFloors,
): HomeFloors {
  const { o, game } = v;
  const mem = s.leader;
  if (
    !o.leaderGuard ||
    mem === undefined ||
    game === undefined ||
    !leaderGuardModels(game)
  ) {
    return floors;
  }
  const pending = pendingBreaks(v, s, mem);
  const before = new Set(mem.pending?.leaving ?? []);
  if (pending === null || pending.leaving.every((id) => before.has(id))) {
    return floors;
  }
  const lead = leaderLines(v, s, mem, floors.cap, pending);
  v.log?.(leaderText(v, mem, floors.cap));
  const base = floors.Hbase ?? floors.H;
  return {
    ...floors,
    H: Math.max(base, lead),
    tn: Math.max(floors.vw, o.tnKeep * base, lead),
    strike: Math.max(base, lead),
    Hbase: base,
  };
}

/** The lines with `pending`, folded into the floor and noted in `mem`. */
function leaderLines(
  v: HomeTargetInputs,
  s: ApexState,
  mem: LeaderMemory,
  cap: number,
  pending: LeaderPending | null,
): number {
  const { o, game, me, nm, tick } = v;
  if (game === undefined) return 0;
  const p = leaderParams(o);
  const lines = betrayalLines(
    {
      game,
      me,
      nm,
      tick,
      span: o.thinkEvery,
      traitorSoon: pending?.traitor === true,
      leaving: pending?.leaving ?? [],
    },
    p,
  );
  const f = betrayalFloor(lines, cap, p, me.troops());
  mem.pending = pending;
  mem.at = tick;
  mem.floor = f.floor;
  mem.by = f.by;
  mem.capShort = f.capShort;
  mem.shortBy = f.shortBy;
  mem.capWant = f.capShort > 0 ? cap + f.capShort : 0;
  mem.lines = lines;
  return f.floor;
}

/**
 * The alliances our pending acts end (review F1; lib/LeaderGuard
 * alliancesEndedBy): the steps of the search's directive (s.search
 * .directive, set before the run) due by the next decision (tick +
 * thinkEvery) whose `when` holds now, each held until BREAK_LAG ticks
 * after its tick; and the ones noted before whose time has not run out
 * while we are still allied (a break sent is gone from the directive, and
 * the game shows it only a turn or two later). Null when none. The run's
 * directive offers the steps after homeFloors, so the steps due now are
 * still in it; a rollout copy carries the same directive and memory, so it
 * computes the same floors.
 */
function pendingBreaks(
  v: HomeTargetInputs,
  s: ApexState,
  mem: LeaderMemory,
): LeaderPending | null {
  const { game, me, tick } = v;
  if (game === undefined) return null;
  const allied = (id: PlayerID) =>
    game.hasPlayer(id) && me.isAlliedWith(game.player(id));
  const leaving = new Set<PlayerID>();
  let until = NEVER;
  const last = tick + v.o.thinkEvery;
  for (const d of s.search.directive) {
    if (d.p === undefined || d.at > last) continue;
    const w = d.when;
    if (w?.allied !== undefined && !allied(w.allied)) continue;
    if (w?.unallied !== undefined && allied(w.unallied)) continue;
    const e = alliancesEndedBy(game, me, [d.p.intent]);
    if (e.leaving.length === 0) continue;
    for (const id of e.leaving) leaving.add(id);
    until = Math.max(until, d.at + BREAK_LAG);
  }
  const old = mem.pending;
  if (old !== null && old.until >= tick) {
    for (const id of old.leaving) {
      if (!allied(id)) continue;
      leaving.add(id);
      until = Math.max(until, old.until);
    }
  }
  if (leaving.size === 0) return null;
  const ids = [...leaving].sort();
  let traitor = false;
  for (const id of ids) {
    const p = game.player(id);
    if (!p.isTraitor() && !p.isDisconnected()) traitor = true;
  }
  return { traitor, leaving: ids, until };
}

const M = (x: number) => `${(x / 1e6).toFixed(2)}M`;

/** The guard's log line: floor, lines, cap need, MIRV lines and danger. */
export function leaderText(
  v: Pick<HomeTargetInputs, "tick" | "me" | "game">,
  mem: LeaderMemory,
  cap: number,
): string {
  const name = (id: PlayerID | null) =>
    id === null || v.game === undefined || !v.game.hasPlayer(id)
      ? "-"
      : v.game.player(id).name();
  const lines = mem.lines
    .map(
      (l) =>
        `${name(l.id)}${l.fresh ? "" : "~"}:${l.rule}${l.juiciest ? "*" : ""} T=${M(l.T)} ` +
        `oth=${l.others < 0 ? "-" : M(l.others)} home=${M(l.home)} ${l.gate}`,
    )
    .join("; ");
  const m = mem.mirv;
  const mirv =
    m === null
      ? ""
      : ` mirv land=${((100 * m.tiles) / Math.max(1, m.land)).toFixed(1)}% ` +
        `room=${m.landRoom} lv=${m.levels}/${m.cityLine} ` +
        `runner=${m.runner} silos=${mem.siloOwners}`;
  const d = mem.danger;
  const danger =
    d === null
      ? ""
      : ` danger ${name(d.id)}:${d.rule} gold=${M(d.gold)}/${M(d.price)} ` +
        `eta=${d.eta ?? "never"} at=${d.at ?? "never"}`;
  const r = mem.richest;
  const rich =
    r === null
      ? ""
      : ` richest ${name(r.id)} gold=${M(r.gold)}/${M(r.price)} ` +
        `eta=${r.eta ?? "never"}`;
  const pend = mem.pending;
  return (
    `${v.tick} leader floor=${M(mem.floor)} by=${name(mem.by)} ` +
    `home=${M(v.me.troops())} cap=${M(cap)}` +
    (mem.capShort > 0
      ? ` short=${M(mem.capShort)} by=${name(mem.shortBy)}`
      : "") +
    (pend !== null
      ? ` ending=[${pend.leaving.map(name).join(",")}]` +
        (pend.traitor ? " traitor" : "")
      : "") +
    ` [${lines}]` +
    mirv +
    danger +
    rich
  );
}

/**
 * o.leaderGuard with o.leaderCap: the gate for a City check that today's
 * rule refused at every site ("exposed") while a betrayal line is above
 * leaderMaxShare of our cap (s.leader.capShort): GoldPolicy.cityGate for
 * arm "model" (or "free" with o.leaderCapFree), with goldGuard (the MIRV
 * city-leader and dense-target lines) and its hold, sites and reserve, its
 * buys stopped at the levels that lift our cap to s.leader.capWant (cities
 * under construction counted). Null otherwise, or when the arm has no
 * gate ("model" without a NukeModel).
 */
export function leaderCityGate(v: View, s: ApexState): CityGate | null {
  const { o } = v;
  if (!o.leaderGuard || !o.leaderCap) return null;
  const mem = s.leader;
  if (mem === undefined || !(mem.capShort > 0)) return null;
  const need = levelsFor(v.models, v.me, mem.capWant);
  if (need <= 0) return null;
  const gate = cityGate(
    v.game,
    v.me,
    {
      ...o,
      goldPolicy: o.leaderCapFree ? "free" : "model",
      goldFrom: 0,
      goldGuard: true,
    },
    v.tick,
    v.nukes,
  );
  if (gate === null) return null;
  return {
    ...gate,
    maxLevels: Math.min(gate.maxLevels, v.me.unitCount(UnitType.City) + need),
    blockers: ["leader", ...gate.blockers],
  };
}
