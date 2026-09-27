import type { PlayerID } from "../../../core/game/Game";

// Package WP2 (docs/14-m4-plan.md §2.3): when the live policy searches.
// Pure bookkeeping over what the SearchController observes each live tick,
// so a run replays. A search counts under the first trigger it matches:
//
// | T1 end       | a bordering ally expires within lapseLead ticks, before
// |              | the web would ask its extension (more than extendLead
// |              | left); once per alliance term; not held back by minGap
// |              | (its window is only lapseLead − extendLead ticks); a
// |              | refused one waits for the tick the budget can pay (the
// |              | controller's retry), or the window's last tick        |
// | T2 chain     | `chain` ticks after an act                            |
// | T3 stall     | stall onset; then every stallEvery ticks in stall (from
// |              | the last look: a search, or no plan), or
// |              | sooner when a bordering nation's alliance flips, an
// |              | unallied one appears, or its troops fall by more than
// |              | stallChange (a window opens); never while a chain is
// |              | pending (our own act's effects are the chain's)       |
// | T4 attack    | a nation attack on us starts with ≥ attackMin of our
// |              | home troops, and no search ran in the last minGap
// |              | ticks (then never for that attack)                    |
// | T5 foresight | the followed rollout shows a nation's first attack on
// |              | us within the next foresight ticks, and no search ran
// |              | in the last minGap ticks                              |
// | T6 naval     | no bordering nation, home ≥ navalHome of the cap for
// |              | navalFor ticks, a boat generator wants a search; every
// |              | navalEvery ticks                                      |
// | T7 floor     | floorTicks since the last look (so the first search
// |              | is at `from`)                                         |
//
// T2, T3, T6 and T7 also wait minGap ticks after the last try (a search, a
// budget refusal or a trigger with no plan). The stall re-searches (every,
// and a change other than an ally lost), T6 and every T7 but the first are
// low priority: the budget keeps searchReserve back from them for the rest. A try that did not run
// uses up only its own trigger's condition (a refused low-priority one
// holds the low-priority triggers until the budget can pay it).
//
// With `clock` > 0 the triggers are off and the search runs every `clock`
// ticks from `from` (the act3 prototype's clock).

export type TriggerName =
  | "clock"
  | "end"
  | "chain"
  | "stall"
  | "attack"
  | "foresight"
  | "naval"
  | "floor"
  | "nuke";

/** A trigger that fired. */
export interface Fired {
  name: TriggerName;
  /** Which rule, for the logs: "onset", "every", "ally:<id>", ... */
  why: string;
  /** Low priority: the budget keeps searchReserve back from it. */
  low: boolean;
  /** T1: the alliance term ("<id>:<expiresAt>") and the tick its window
   *  closes (the web asks its extension from then on). */
  term?: string;
  closes?: number;
  /** T1: the expiring ally; T4, T5: the attack's nation (and T5's ticks
   *  to its attack, `in`). */
  nation?: PlayerID;
  in?: number;
}

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
  /** Package WP10n T8 (MIRV threat): a silo owner is about to be able to
   *  MIRV us while we are a MIRV magnet (high priority). Absent/false unless
   *  o.searchNukes. */
  mirvThreat?: boolean;
  /** Package WP10n T8: we could MIRV offensively (we can pay and are rank
   *  ≤ 2); low priority. Absent/false unless o.searchNukes. */
  mirvChance?: boolean;
}

const NEVER = -1_000_000_000;

export class Triggers {
  /** The last search that ran (forked and rolled out). */
  lastRun: number;
  /** The last look at the live state: a search, or a trigger with no
   *  plan (T3's stallEvery and T7 count from it). */
  lastLook: number;
  /** The last try: a search, a refusal or a trigger with no plan. */
  lastTry = NEVER;
  lastAct = NEVER;
  /** Searches run. */
  runs = 0;
  /** Alliance terms searched for (T1): "id:expiresAt". */
  private readonly ends = new Set<string>();
  /** Refused T1 terms: the tick the budget can pay the search. */
  private readonly endRetry = new Map<string, number>();
  /** Low-priority triggers wait until this tick (a refused one's). */
  private lowHold = NEVER;
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
  /** Package WP10n T8: the last MIRV-threat try (its own minGap clock). */
  private lastMirv = NEVER;

  constructor(private readonly p: TriggerParams) {
    this.lastRun = p.from - p.floorTicks;
    this.lastLook = this.lastRun;
  }

  /**
   * The trigger that fires at this tick, or null. Call every live tick
   * (it notes the attacks and the stall onset as it goes), before `from`
   * too.
   */
  check(obs: TriggerObs): Fired | null {
    const p = this.p;
    const t = obs.t;
    // Bookkeeping first, whatever fires.
    const onset = obs.inStall && !this.wasInStall;
    this.wasInStall = obs.inStall;
    if (onset) this.stallOnset = true;
    if (!obs.inStall) this.stallOnset = false;
    let attack: PlayerID | null = null;
    for (const a of obs.attacks) {
      if (this.seenAttacks.has(a.id)) continue;
      this.seenAttacks.add(a.id);
      if (attack === null && a.troops >= p.attackMin * obs.home) {
        attack = a.attacker;
      }
    }
    const idle = obs.nations.length === 0 && obs.home >= p.navalHome * obs.cap;
    if (!idle) this.idleSince = null;
    else this.idleSince ??= t;

    if (t < p.from) return null;
    if (p.clock > 0) {
      return (t - p.from) % p.clock === 0
        ? { name: "clock", why: "clock", low: false }
        : null;
    }
    const sinceRun = t - this.lastRun;
    const sinceLook = t - this.lastLook;
    // T1, whatever the gap.
    for (const n of obs.nations) {
      if (!n.allied || n.expiresAt === null) continue;
      const left = n.expiresAt - t;
      if (left > p.lapseLead || left <= p.extendLead) continue;
      const term = `${n.id}:${n.expiresAt}`;
      if (this.ends.has(term)) continue;
      if (t < (this.endRetry.get(term) ?? NEVER)) continue;
      return {
        name: "end",
        why: `end:${n.id}`,
        low: false,
        term,
        closes: n.expiresAt - p.extendLead,
        nation: n.id,
      };
    }
    const gap = t - this.lastTry >= p.minGap;
    const low = t >= this.lowHold;
    // T2.
    if (gap && this.chainAt !== null && t >= this.chainAt) {
      return { name: "chain", why: "chain", low: false };
    }
    // T8 (MIRV threat, package WP10n): a silo owner about to be able to MIRV
    // us while we are a MIRV magnet. Urgent (the nation fires at its next
    // decision, ~30-50 ticks), so high priority, on its own minGap clock so
    // a recent stall search does not block it (absent unless o.searchNukes).
    if (obs.mirvThreat === true && t - this.lastMirv >= p.minGap) {
      return { name: "nuke", why: "threat", low: false };
    }
    // T3, not while a chain is pending.
    const chainWait = this.chainAt !== null && t < this.chainAt;
    if (gap && obs.inStall && !chainWait) {
      if (this.stallOnset) return { name: "stall", why: "onset", low: false };
      // An ally lost (its alliance ended, not by our act: the chain covers
      // those) is high priority: former allies sent most of the troops sent
      // at us (plan.md §2.7).
      const lost = this.allyLost(obs);
      if (lost !== null) return { name: "stall", why: lost, low: false };
      if (low && sinceLook >= p.stallEvery) {
        return { name: "stall", why: "every", low: true };
      }
      const why = low ? this.stallChanged(obs) : null;
      if (why !== null) return { name: "stall", why, low: true };
    }
    // T4, T5: timed by the last search that ran.
    const ran = sinceRun >= p.minGap;
    if (attack !== null && ran) {
      return {
        name: "attack",
        why: `attack:${attack}`,
        low: false,
        nation: attack,
      };
    }
    if (ran) {
      for (const f of this.foreseen) {
        if (t < f.at && f.at - t <= p.foresight) {
          if (!this.foreDone.has(`${f.id}:${f.at}`)) {
            return {
              name: "foresight",
              why: `foresight:${f.id}`,
              low: false,
              nation: f.id,
              in: f.at - t,
            };
          }
        }
      }
    }
    // T6.
    if (
      gap &&
      low &&
      obs.naval &&
      this.idleSince !== null &&
      t - this.idleSince >= p.navalFor &&
      t - this.lastNaval >= p.navalEvery
    ) {
      return { name: "naval", why: "naval", low: true };
    }
    // T8 low (package WP10n): we could MIRV offensively (we can pay and are
    // rank ≤ 2), so a search may consider it even with no imminent enemy MIRV.
    if (
      gap &&
      low &&
      obs.mirvChance === true &&
      t - this.lastMirv >= p.minGap
    ) {
      return { name: "nuke", why: "chance", low: true };
    }
    // T7.
    if (gap && sinceLook >= p.floorTicks && (low || this.runs === 0)) {
      return { name: "floor", why: "floor", low: this.runs > 0 };
    }
    return null;
  }

  /**
   * A search ran at this tick: every trigger's condition it covers is used
   * up (a chain due within minGap too). `foreseen` are the followed
   * rollout's first attacks on us (absolute ticks).
   */
  searched(
    obs: TriggerObs,
    fired: Fired,
    foreseen: { id: PlayerID; at: number }[],
  ): void {
    const t = obs.t;
    this.lastRun = t;
    this.runs++;
    this.looked(obs, fired);
    if (this.chainAt !== null && t >= this.chainAt - this.p.minGap) {
      this.chainAt = null;
    }
    this.foreseen = foreseen;
  }

  /** A trigger found no plan at this tick (nothing to search now): the
   *  conditions a search would have used up are, but T4 and T5 still count
   *  from the last search that ran. */
  none(obs: TriggerObs, fired: Fired): void {
    this.looked(obs, fired);
    if (fired.name === "chain") this.chainAt = null;
  }

  /**
   * The budget refused the search at this tick: it uses up its own
   * trigger's condition only. `retryAt`: the tick the budget can pay it; a
   * refused T1 is tried again then, or at its window's last tick if that
   * comes first (then given up); a refused low-priority trigger holds
   * every low-priority one until then.
   */
  refused(obs: TriggerObs, fired: Fired, retryAt: number): void {
    const t = obs.t;
    this.lastTry = t;
    switch (fired.name) {
      case "end": {
        // Retried when the budget can pay it, or at the window's last tick
        // at the latest (where the lapse's look is shortest); given up
        // after that.
        const at = Math.min(retryAt, (fired.closes ?? t) - 1);
        if (at > t) this.endRetry.set(fired.term!, at);
        else this.ends.add(fired.term!);
        break;
      }
      case "chain":
        this.chainAt = null;
        break;
      case "foresight":
        this.foreseenDone(t);
        break;
      case "naval":
        this.lastNaval = t;
        break;
      case "nuke":
        this.lastMirv = t;
        break;
      case "stall":
        if (fired.why === "onset") this.stallOnset = false;
        break;
      default:
        break;
    }
    if (fired.low) this.lowHold = retryAt;
  }

  /** The search at `t` played a plan: the chain restarts from it. */
  acted(t: number): void {
    this.lastAct = t;
    this.chainAt = t + this.p.chain;
  }

  /** The live state was looked at (a search or no plan): the terms in
   *  their window, the stall onset, T3's neighbours, the foreseen attacks
   *  due and T6's clock are used up. */
  private looked(obs: TriggerObs, fired: Fired): void {
    const t = obs.t;
    this.lastLook = t;
    this.lastTry = t;
    for (const n of obs.nations) {
      if (n.allied && n.expiresAt !== null) {
        if (n.expiresAt - t <= this.p.lapseLead) {
          const term = `${n.id}:${n.expiresAt}`;
          this.ends.add(term);
          this.endRetry.delete(term);
        }
      }
    }
    this.stallOnset = false;
    this.nbrs = new Map(
      obs.nations.map((n) => [n.id, { allied: n.allied, troops: n.troops }]),
    );
    this.foreseenDone(t);
    if (fired.name === "naval") this.lastNaval = t;
    if (fired.name === "nuke") this.lastMirv = t;
  }

  private foreseenDone(t: number): void {
    for (const f of this.foreseen) {
      if (f.at - t <= this.p.foresight) this.foreDone.add(`${f.id}:${f.at}`);
    }
  }

  /** T3's sooner rule, high priority: a bordering nation allied at the
   *  last search and unallied now ("lost:<id>"), or null. */
  private allyLost(obs: TriggerObs): string | null {
    for (const n of obs.nations) {
      if (!n.allied && this.nbrs.get(n.id)?.allied === true) {
        return `lost:${n.id}`;
      }
    }
    return null;
  }

  /** T3's sooner rule, low priority: what else changed since the last
   *  search (an ally made, an unallied neighbour new, troops fallen), or
   *  null. */
  private stallChanged(obs: TriggerObs): string | null {
    for (const n of obs.nations) {
      const was = this.nbrs.get(n.id);
      if (was === undefined) {
        if (!n.allied) return `new:${n.id}`;
        continue;
      }
      if (was.allied !== n.allied) return `ally:${n.id}`;
      if (was.troops - n.troops > this.p.stallChange * was.troops) {
        return `troops:${n.id}`;
      }
    }
    return null;
  }
}
