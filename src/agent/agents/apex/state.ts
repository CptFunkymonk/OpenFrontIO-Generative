import { PlayerID } from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { LedgerData } from "../../lib/Ledger";
import { RelationData } from "../../lib/NationModel";
import type { Proposal } from "../../lib/Scheduler";
import type { View } from "./policy";

// Everything apex remembers between ticks (spec §2.10). Plain data,
// structuredClone-able, IDs only (PlayerID, smallID, TileRef): everything is
// looked up in the current game each tick, so a clone of the state is valid
// inside a fork (§2.8). Controllers keep no state of their own; whatever they
// must remember goes here, so ApexPolicy.forRollout() can clone it.

/** "Never" for tick fields: far enough back that every elapsed-ticks test
 *  passes, and unlike -Infinity it survives JSON. */
export const NEVER = -1_000_000_000;

/** Lines kept in `log`. */
export const LOG_LINES = 200;

/**
 * Package WP1 (docs/14-m4-plan.md §2.1-2.2): one step of a plan the search
 * plays, offered by the policy in the run of tick `at`, after
 * scheduler.begin and before the reflexes, through the same Scheduler,
 * Purse and Ledger as every other send. Plain data. A step whose tick has
 * passed unoffered (the policy did not run then) goes at the next run.
 */
export interface DirectiveStep {
  /** Live tick of the run that offers it. */
  at: number;
  /** Names the step in the log lines (default: the intent's type). */
  label?: string;
  /** Marks a foe from this step's run on: until tick `until` (inclusive)
   *  the policy vetoes our alliance requests (`ally:<id>`: the web's, the
   *  recall's, the renewal's and the counter-accept's) and extensions
   *  (`ext:<id>`) with it. An `until` before `at` clears the mark. Foe
   *  marks go first, so a foe step and an offer in the same run see it. */
  foe?: { id: PlayerID; until: number };
  /** Offered through the Scheduler; refused, it is logged and dropped. */
  p?: Proposal;
  /** With p: its troops (an attack's or a boat's, and its spend and
   *  clampTroops) are this share of purse.available(p.spend.kind) at the
   *  send, floored; skipped (logged) below `minTroops`. */
  frac?: number;
  /** With frac: the least troops worth sending (default
   *  DIRECTIVE_MIN_TROOPS). */
  minTroops?: number;
  /** Offered only if, at the send, we are allied with `allied` (e.g. a
   *  break) or not allied with `unallied` (e.g. a renewal after a lapse);
   *  skipped otherwise (logged). */
  when?: { allied?: PlayerID; unallied?: PlayerID };
}

/** The least troops a directive attack sized by `frac` is sent with (act3,
 *  /tmp/claude-0/growth/search.md §6.1). */
export const DIRECTIVE_MIN_TROOPS = 1000;

/** Package WP1: the search's plan on this game and its marks. A rollout
 *  copy carries it with the rest of the state, so a copy plays the steps
 *  the live policy will. */
export interface SearchMemory {
  /** Steps not yet offered, in the order they were given. */
  directive: DirectiveStep[];
  /** Foe marks: nation id -> last tick of the veto. */
  foes: Record<PlayerID, number>;
  /** For the SearchController (WP2): the tick of the last act (chain
   *  trigger T2) and of the last search. Never read by the policy. */
  chainAt: number;
  lastSearch: number;
  /** Counts for logs and tests; never read by decisions. */
  stats: {
    offered: number;
    refused: number;
    skipped: number;
  };
}

export interface ApexState {
  spawn: {
    planned: TileRef | null;
    sentAt: number | null;
    endTick: number | null;
    mode: string;
  };
  /** Ledger's plain data. */
  ledger: LedgerData;
  /** Tracker events and marks. */
  relations: RelationData;
  // Spec §2.10's `params` cache is left out: NationModel keeps its own
  // (nothing ever read or wrote this one).
  web: {
    allySet: PlayerID[];
    food: PlayerID[];
    requested: Record<PlayerID, number>;
    extensionAsked: Record<PlayerID, number>;
    lastPlan: number;
  };
  stall: { since: number | null };
  /** Not in spec §2.10 (o.nukeReflex): enemy bombs in flight will delete
   *  `lost` finished city levels, and home is above the cap they leave
   *  (`capAfter`); set each decision. The allocator spends as in stall
   *  mode while it is set (inStall). */
  nuke: { lost: number; capAfter: number; at: number } | null;
  timers: {
    lastThink: number;
    lastCity: number;
    lastBoat: number;
  };
  /** Boat probe cache: coarse cell -> tick. */
  probes: Record<string, number>;
  /** Package WP1: nations touching the tribes the allocator scanned at its
   *  last decision (ExpansionController), which the policy adds to its
   *  NationModel refresh list. */
  nearTribes: PlayerID[];
  /** Package WP1: EconomyController's SAM-hub doom (package B3, o.hubDoom):
   *  the tick of the last city check that found a threat able to destroy
   *  our hub, and that threat as its log text. */
  economy: { doomAt: number; doomBy: string | null };
  /** Package WP1: the search's directive and foe marks. */
  search: SearchMemory;
  /** Ring buffer, not read by decisions. */
  log: string[];
}

export function createState(): ApexState {
  return {
    spawn: { planned: null, sentAt: null, endTick: null, mode: "none" },
    ledger: { plans: [], sentThisTick: [], tick: NEVER },
    relations: { values: {}, malusApplied: [] },
    web: {
      allySet: [],
      food: [],
      requested: {},
      extensionAsked: {},
      lastPlan: NEVER,
    },
    stall: { since: null },
    nuke: null,
    timers: {
      lastThink: NEVER,
      lastCity: NEVER,
      lastBoat: NEVER,
    },
    probes: {},
    nearTribes: [],
    economy: { doomAt: NEVER, doomBy: null },
    search: {
      directive: [],
      foes: {},
      chainAt: NEVER,
      lastSearch: NEVER,
      stats: { offered: 0, refused: 0, skipped: 0 },
    },
    log: [],
  };
}

/** Appends to the state's log, dropping the oldest line past LOG_LINES. */
export function stateLog(s: ApexState, line: string): void {
  s.log.push(line);
  if (s.log.length > LOG_LINES) s.log.splice(0, s.log.length - LOG_LINES);
}

/**
 * A controller's log line: through View.log when the policy set it (state
 * log and host log), else into the state log with its tick and to the live
 * context's log.
 */
export function noteLine(
  v: Pick<View, "log" | "tick" | "live">,
  s: ApexState,
  line: string,
): void {
  if (v.log !== undefined) {
    v.log(line);
    return;
  }
  stateLog(s, `[${v.tick}] ${line}`);
  v.live?.log(line);
}
