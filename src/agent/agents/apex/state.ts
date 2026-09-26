import { PlayerID } from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { LedgerData } from "../../lib/Ledger";
import { AiParams, RelationData } from "../../lib/NationModel";

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
  /** Cache. */
  params: Record<PlayerID, AiParams>;
  web: {
    allySet: PlayerID[];
    food: PlayerID[];
    requested: Record<PlayerID, number>;
    extensionAsked: Record<PlayerID, number>;
    lastPlan: number;
  };
  stall: { since: number | null };
  timers: {
    lastThink: number;
    lastCity: number;
    lastBoat: number;
    lastPlan: number;
  };
  /** Boat probe cache: coarse cell -> tick. */
  probes: Record<string, number>;
  /** Ring buffer, not read by decisions. */
  log: string[];
}

export function createState(): ApexState {
  return {
    spawn: { planned: null, sentAt: null, endTick: null, mode: "none" },
    ledger: { plans: [], sentThisTick: [], tick: NEVER },
    relations: { values: {}, malusApplied: [] },
    params: {},
    web: {
      allySet: [],
      food: [],
      requested: {},
      extensionAsked: {},
      lastPlan: NEVER,
    },
    stall: { since: null },
    timers: {
      lastThink: NEVER,
      lastCity: NEVER,
      lastBoat: NEVER,
      lastPlan: NEVER,
    },
    probes: {},
    log: [],
  };
}

/** Appends to the state's log, dropping the oldest line past LOG_LINES. */
export function stateLog(s: ApexState, line: string): void {
  s.log.push(line);
  if (s.log.length > LOG_LINES) s.log.splice(0, s.log.length - LOG_LINES);
}
