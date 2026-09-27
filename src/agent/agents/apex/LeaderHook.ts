import { PlayerID, UnitType } from "../../../core/game/Game";
import { CityGate, cityGate } from "../../lib/GoldPolicy";
import {
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
} from "../../lib/LeaderGuard";
import type { HomeTargetInputs } from "./HomeTarget";
import type { ApexOptions } from "./options";
import type { View } from "./policy";
import { ApexState, NEVER } from "./state";

// Package WP10b, the leader guard's hooks (lib/LeaderGuard.ts; option
// o.leaderGuard, off by default). A base rule: the search's rollouts run
// the same code on a copy of the state, so they play it too.
// - The floor (leaderFloor, called by HomeTarget.homeFloors at each
//   decision): H, the TN floor and the strike floor are at least the
//   largest holdable betrayal line of our bordering allies, so tribe, boat,
//   free-land and strike sends (and the search's directive sends, sized
//   from the same purse) keep home at it. Snacks and defense keep vw.
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
 * ticks a log line (live only).
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
  const p = leaderParams(o);
  const lines = betrayalLines({ game, me, nm, tick }, p);
  const f = betrayalFloor(lines, cap, p);
  mem.at = tick;
  mem.floor = f.floor;
  mem.by = f.by;
  mem.capShort = f.capShort;
  mem.shortBy = f.shortBy;
  mem.capWant = f.capShort > 0 ? cap + f.capShort : 0;
  mem.lines = lines;
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
  if (v.log && tick - mem.loggedAt >= LOG_EVERY) {
    mem.loggedAt = tick;
    v.log(leaderText(v, mem, cap));
  }
  return f.floor;
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
        `${name(l.id)}:${l.rule}${l.juiciest ? "*" : ""} T=${M(l.T)} ` +
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
  return (
    `${v.tick} leader floor=${M(mem.floor)} by=${name(mem.by)} ` +
    `home=${M(v.me.troops())} cap=${M(cap)}` +
    (mem.capShort > 0
      ? ` short=${M(mem.capShort)} by=${name(mem.shortBy)}`
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
