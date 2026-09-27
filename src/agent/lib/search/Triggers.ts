import type { PlayerID } from "../../../core/game/Game";

// Package WP2 (docs/14-m4-plan.md §2.3): when the live policy searches.
// Pure bookkeeping over what the SearchController observes each live tick,
// so a run replays. A search counts under the first trigger it matches:
//
// | T1 end       | a bordering ally expires within lapseLead ticks, before
// |              | the web would ask its extension (more than extendLead
// |              | left); once per alliance term                         |
// | T2 chain     | `chain` ticks after an act                            |
// | T3 stall     | stall onset; then every stallEvery ticks in stall, or
// |              | sooner when a bordering nation's alliance flips, one
// |              | appears, or its troops move more than stallChange     |
// | T4 attack    | a nation attack on us starts with ≥ attackMin of our
// |              | home troops, no search in the last minGap ticks       |
// | T5 foresight | the followed rollout shows a nation's first attack on
// |              | us within the next foresight ticks                    |
// | T6 naval     | no bordering nation, home ≥ navalHome of the cap for
// |              | navalFor ticks, a boat generator wants a search; every
// |              | navalEvery ticks                                      |
// | T7 floor     | floorTicks since the last search (so the first search
// |              | is at `from`)                                         |
//
// With `clock` > 0 the triggers are off and the search runs every `clock`
// ticks from `from` (the act3 prototype's clock). Every trigger but T4 waits
// for minGap ticks after the last search (T4 is dropped instead).

export type TriggerName =
  | "clock"
  | "end"
  | "chain"
  | "stall"
  | "attack"
  | "foresight"
  | "naval"
  | "floor";

export interface TriggerParams {
  from: number;
  clock: number;
  lapseLead: number;
  extendLead: number;
  chain: number;
  stallEvery: number;
  stallChange: number;
  attackMin: number;
  foresight: number;
  navalHome: number;
  navalFor: number;
  navalEvery: number;
  floorTicks: number;
  minGap: number;
}

/** A bordering nation (contact ≥ searchMinContact) at a live tick. */
export interface NationObs {
  id: PlayerID;
  allied: boolean;
  /** The alliance's expiry, if allied. */
  expiresAt: number | null;
  troops: number;
}

/** What the SearchController reads at the start of a live tick. */
export interface TriggerObs {
  t: number;
  inStall: boolean;
  home: number;
  cap: number;
  nations: readonly NationObs[];
  /** Nation (non-tribe) attacks on us now: id, attacker, troops. */
  attacks: readonly { id: string; attacker: PlayerID; troops: number }[];
  /** A registered boat generator would search now (T6's own test). */
  naval: boolean;
}

const NEVER = -1_000_000_000;

export class Triggers {
  /** The last search's tick (a refused one counts). */
  lastSearch: number;
  lastAct = NEVER;
  /** Alliance terms searched for (T1): "id:expiresAt". */
  private readonly ends = new Set<string>();
  private chainAt: number | null = null;
  private wasInStall = false;
  private stallOnset = false;
  /** Bordering nations at the last search (T3). */
  private nbrs = new Map<PlayerID, { allied: boolean; troops: number }>();
  private readonly seenAttacks = new Set<string>();
  /** The followed rollout's first attacks on us (T5): absolute ticks. */
  private foreseen: { id: PlayerID; at: number }[] = [];
  private readonly foreDone = new Set<string>();
  /** Since when home ≥ navalHome·cap with no bordering nation (T6). */
  private idleSince: number | null = null;
  private lastNaval = NEVER;

  constructor(private readonly p: TriggerParams) {
    this.lastSearch = p.from - p.floorTicks;
  }

  /**
   * The trigger that fires at this tick, or null. Call every live tick
   * (it notes the attacks and the stall onset as it goes), before `from`
   * too.
   */
  check(obs: TriggerObs): TriggerName | null {
    const p = this.p;
    const t = obs.t;
    // Bookkeeping first, whatever fires.
    const onset = obs.inStall && !this.wasInStall;
    this.wasInStall = obs.inStall;
    if (onset) this.stallOnset = true;
    if (!obs.inStall) this.stallOnset = false;
    let attack = false;
    for (const a of obs.attacks) {
      if (this.seenAttacks.has(a.id)) continue;
      this.seenAttacks.add(a.id);
      if (a.troops >= p.attackMin * obs.home) attack = true;
    }
    const idle = obs.nations.length === 0 && obs.home >= p.navalHome * obs.cap;
    if (!idle) this.idleSince = null;
    else this.idleSince ??= t;

    if (t < p.from) return null;
    if (p.clock > 0) return (t - p.from) % p.clock === 0 ? "clock" : null;
    const since = t - this.lastSearch;
    // T4's rule is at the attack's start: no search in the last minGap.
    const gap = since >= p.minGap;
    if (!gap) return null;
    // T1.
    for (const n of obs.nations) {
      if (!n.allied || n.expiresAt === null) continue;
      const left = n.expiresAt - t;
      if (left > p.lapseLead || left <= p.extendLead) continue;
      if (!this.ends.has(`${n.id}:${n.expiresAt}`)) return "end";
    }
    // T2.
    if (this.chainAt !== null && t >= this.chainAt) return "chain";
    // T3.
    if (obs.inStall) {
      if (this.stallOnset || since >= p.stallEvery) return "stall";
      if (this.stallChanged(obs)) return "stall";
    }
    // T4.
    if (attack) return "attack";
    // T5.
    for (const f of this.foreseen) {
      if (t < f.at && f.at - t <= p.foresight) {
        if (!this.foreDone.has(`${f.id}:${f.at}`)) return "foresight";
      }
    }
    // T6.
    if (
      obs.naval &&
      this.idleSince !== null &&
      t - this.idleSince >= p.navalFor &&
      t - this.lastNaval >= p.navalEvery
    ) {
      return "naval";
    }
    // T7.
    if (since >= p.floorTicks) return "floor";
    return null;
  }

  /**
   * A search ran (or was refused) at this tick: its trigger conditions are
   * used up. `foreseen` are the followed rollout's first attacks on us
   * (absolute ticks), or null to keep the last ones (no rollout ran).
   */
  searched(
    obs: TriggerObs,
    trigger: TriggerName,
    foreseen: { id: PlayerID; at: number }[] | null,
  ): void {
    const t = obs.t;
    this.lastSearch = t;
    for (const n of obs.nations) {
      if (n.allied && n.expiresAt !== null) {
        const left = n.expiresAt - t;
        if (left <= this.p.lapseLead) this.ends.add(`${n.id}:${n.expiresAt}`);
      }
    }
    if (this.chainAt !== null && t >= this.chainAt) this.chainAt = null;
    this.stallOnset = false;
    this.nbrs = new Map(
      obs.nations.map((n) => [n.id, { allied: n.allied, troops: n.troops }]),
    );
    for (const f of this.foreseen) {
      if (f.at - t <= this.p.foresight) this.foreDone.add(`${f.id}:${f.at}`);
    }
    if (foreseen !== null) this.foreseen = foreseen;
    if (trigger === "naval") this.lastNaval = t;
  }

  /** The search at `t` played a plan: the chain restarts from it. */
  acted(t: number): void {
    this.lastAct = t;
    this.chainAt = t + this.p.chain;
  }

  private stallChanged(obs: TriggerObs): boolean {
    for (const n of obs.nations) {
      const was = this.nbrs.get(n.id);
      if (was === undefined) return true;
      if (was.allied !== n.allied) return true;
      if (Math.abs(n.troops - was.troops) > this.p.stallChange * was.troops) {
        return true;
      }
    }
    return false;
  }
}
