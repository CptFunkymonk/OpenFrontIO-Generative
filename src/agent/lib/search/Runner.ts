import { Game, Player, PlayerID, PlayerType } from "../../../core/game/Game";
import type { GameFork } from "../../Fork";
import { BudgetMirror, RolloutPolicy, stepRollout } from "../Lookahead";
import { scanWorld } from "../WorldModel";
import type { Roll } from "./Rounds";
import { Danger, DangerModel, landOf, Snap, snapOf } from "./Value";

// Package WP2 (docs/14-m4-plan.md §2.2, §2.5): one rollout of a search,
// resumable. It owns one fork and one policy copy, steps them on demand
// (advance), and records what the rounds read: snapshots at checkpoints,
// the nations whose attacks reach us, the state at a plan's send (the
// strong-target horizon), and the alliances that end (the break gate).
// Stepping is the act3 prototype's (/tmp/claude-0/search-wt3,
// SearchProbe.ts, Runner): the policy's sends of the fork's tick go into
// its next step, limited by an exact BudgetMirror of the live budget.
// Wall time is measured for the logs only; nothing reads it.

/** A nation's first attack on us in the rollout. */
export interface AttackSeen {
  /** Ticks after the fork of the step it was first seen after. */
  h: number;
  /** Troops of its attacks at first sight, added up. */
  troops: number;
}

/** An alliance of ours that ended during the rollout. */
export interface AllianceEnd {
  id: PlayerID;
  /** Ticks after the fork of the step it ended in. */
  h: number;
  /** It ended before its expiry (broken, not lapsed). */
  early: boolean;
  /** We were a traitor then. */
  traitor: boolean;
}

/** What a plan's send found: the target's troops and our home, read in the
 *  rollout at the start of the send's tick (the state the send sees). */
export interface SendState {
  h: number;
  targetTroops: number;
  home: number;
  targetAlive: boolean;
}

/** A bordering nation of a rollout's player, from a border scan. */
export interface BorderNation {
  id: PlayerID;
  contact: number;
  allied: boolean;
  maxTroops: number;
}

export interface RunnerInit {
  name: string;
  fork: GameFork;
  policy: RolloutPolicy;
  budget: BudgetMirror;
  gameID: string;
  clientID: string;
  /** The fork's cost in live-tick equivalents (the budget's φ). */
  phi: number;
  /** Wall ms the fork took (logs only). */
  forkMs: number;
  /** Checkpoints (ticks after the fork) to snap at as it passes them. */
  grid: readonly number[];
  /** Record the state at this step (ticks after the fork) for `target`. */
  send?: { h: number; target: PlayerID };
  /** Track the alliances we hold at the fork (the break gate). */
  alliances?: boolean;
  /** Package WP4's danger terms, computed at every snap (V's λ terms, and
   *  the logs WP4 fits them on). */
  danger?: DangerModel | null;
  /** Our transport ships' troops count in the snaps' out (searchOutBoats). */
  boats?: boolean;
}

export class Runner implements Roll {
  readonly name: string;
  readonly me: Player;
  readonly phi: number;
  readonly forkMs: number;
  /** Ticks advanced. */
  h = 0;
  dead = false;
  /** Snapshots, ascending h: each checkpoint passed, the death, and every
   *  horizon advanced to. */
  readonly snaps: Snap[] = [];
  /** The win bar's land at each snap's h. */
  readonly land = new Map<number, number>();
  /** The danger terms at each snap's h (with a DangerModel). */
  readonly dangers = new Map<number, Danger>();
  /** The win bar's land at the fork. */
  readonly land0: number;
  natAtks = 0;
  natTroops = 0;
  /** Nations (and humans) whose attacks reached us, in order of the first. */
  readonly attackers = new Map<PlayerID, AttackSeen>();
  /** Alliances held at the fork that ended, when tracked. */
  readonly ended: AllianceEnd[] = [];
  /** The send's state, once passed. */
  sent: SendState | null = null;
  simMs = 0;

  private readonly f: GameFork;
  private readonly grid: ReadonlySet<number>;
  private readonly policy: RolloutPolicy;
  private readonly budget: BudgetMirror;
  private readonly gameID: string;
  private readonly seen = new Set<string>();
  private readonly send: { h: number; target: PlayerID } | null;
  private readonly dangerModel: DangerModel | null;
  private readonly boats: boolean;
  /** Tracked alliances (those held at the fork, until they end): partner
   *  -> its expiry as last seen. */
  private readonly allied: Map<PlayerID, number> | null;

  constructor(init: RunnerInit) {
    this.name = init.name;
    this.f = init.fork;
    this.grid = new Set(init.grid);
    this.policy = init.policy;
    this.budget = init.budget;
    this.gameID = init.gameID;
    this.phi = init.phi;
    this.forkMs = init.forkMs;
    this.send = init.send ?? null;
    this.dangerModel = init.danger ?? null;
    this.boats = init.boats === true;
    const me = init.fork.game.playerByClientID(init.clientID);
    if (me === null) throw new Error("search: no player in the fork");
    this.me = me;
    this.land0 = landOf(init.fork.game);
    if (init.alliances === true) {
      this.allied = new Map();
      for (const a of me.alliances()) {
        this.allied.set(a.other(me).id(), a.expiresAt());
      }
    } else {
      this.allied = null;
    }
  }

  /** The fork's game (read only). */
  get game(): Game {
    return this.f.game;
  }

  /** Live-tick equivalents spent: the fork's φ plus the ticks advanced. */
  cost(): number {
    return this.phi + this.h;
  }

  /** The last snapshot. */
  last(): Snap {
    const s = this.snaps[this.snaps.length - 1];
    if (s === undefined) throw new Error(`search: ${this.name} has no snap`);
    return s;
  }

  /** The last snapshot at or before `h` (the first if none is). */
  at(h: number): Snap {
    let sn = this.snaps[0];
    for (const x of this.snaps) if (x.h <= h) sn = x;
    return sn;
  }

  /** The win bar's land at the snap at or before `h`. */
  landAt(h: number): number {
    return this.land.get(this.at(h).h) ?? this.land0;
  }

  /** The danger terms at the snap at or before `h` (null without a
   *  DangerModel). */
  dangerAt(h: number): Danger | null {
    return this.dangers.get(this.at(h).h) ?? null;
  }

  /** config.maxTroops(our player) in the fork now. */
  capNow(): number {
    return this.f.game.config().maxTroops(this.me);
  }

  /**
   * Steps to horizon `to` (or the death), snapping at every checkpoint of
   * the grid and at the death, and returns the snap at the runner's tick
   * (made there if no checkpoint fell there, unless `snapEnd` is off: then
   * the last snap). Package SLICE: stepTick is one iteration of this loop,
   * so a sliced search (Rounds' generator) steps a rollout tick by tick
   * between live ticks and gets the very same snaps.
   */
  advance(to: number, snapEnd = true): Snap {
    while (this.h < to && !this.dead) this.stepTick();
    const last = this.snaps[this.snaps.length - 1];
    if (last !== undefined && (last.h === this.h || !snapEnd)) return last;
    this.push(this.f.game);
    return this.last();
  }

  /** One tick of the rollout: the send's state if this is its tick, one
   *  step of the fork, the attacks and alliance ends seen, the death, and a
   *  snap at a checkpoint of the grid or at the death. */
  stepTick(): void {
    const me = this.me;
    const g = this.f.game;
    if (this.send !== null && this.sent === null && this.h === this.send.h) {
      this.sent = this.sendState();
    }
    const s0 = performance.now();
    stepRollout(this.f, me, this.gameID, this.policy, this.budget);
    this.simMs += performance.now() - s0;
    this.h++;
    for (const a of me.incomingAttacks()) {
      if (a.attacker().type() === PlayerType.Bot || this.seen.has(a.id())) {
        continue;
      }
      this.seen.add(a.id());
      this.natAtks++;
      this.natTroops += a.troops();
      const id = a.attacker().id();
      const prev = this.attackers.get(id);
      if (prev === undefined) {
        this.attackers.set(id, { h: this.h, troops: a.troops() });
      } else prev.troops += a.troops();
    }
    if (this.allied !== null) this.trackAlliances();
    if (me.hasSpawned() && !me.isAlive()) this.dead = true;
    if (this.grid.has(this.h) || this.dead) this.push(g);
  }

  /** The nations bordering us now with at least `minContact` contact
   *  pairs (a border scan of the fork; read only). */
  bordering(minContact: number): BorderNation[] {
    const g = this.f.game;
    const me = this.me;
    if (!me.isAlive()) return [];
    const wm = scanWorld(g, me, null);
    const out: BorderNation[] = [];
    for (const n of wm.nations) {
      if (n.type !== PlayerType.Nation || n.contact < minContact) continue;
      if (!g.hasPlayer(n.id)) continue;
      const N = g.player(n.id);
      if (!N.isAlive()) continue;
      out.push({
        id: n.id,
        contact: n.contact,
        allied: me.isAlliedWith(N),
        maxTroops: g.config().maxTroops(N),
      });
    }
    return out;
  }

  /** Whether we are allied with `id` now. */
  alliedWith(id: PlayerID): boolean {
    const g = this.f.game;
    return g.hasPlayer(id) && this.me.isAlliedWith(g.player(id));
  }

  private push(g: Game): void {
    this.snaps.push(
      snapOf(g, this.me, this.h, this.natAtks, this.natTroops, this.boats),
    );
    this.land.set(this.h, landOf(g));
    if (this.dangerModel !== null && this.me.isAlive()) {
      this.dangers.set(this.h, this.dangerModel(g, this.me));
    }
  }

  private sendState(): SendState {
    const g = this.f.game;
    const id = this.send!.target;
    const N = g.hasPlayer(id) ? g.player(id) : null;
    return {
      h: this.h,
      targetTroops: N !== null && N.isAlive() ? N.troops() : 0,
      home: this.me.troops(),
      targetAlive: N !== null && N.isAlive(),
    };
  }

  /** The alliances held at the fork that ended this step (the gate's (a)
   *  counts no alliance made after the fork); an extension moves the
   *  expiry an end is judged early against. */
  private trackAlliances(): void {
    const allied = this.allied!;
    if (allied.size === 0) return;
    const me = this.me;
    const now = new Map<PlayerID, number>();
    for (const a of me.alliances()) now.set(a.other(me).id(), a.expiresAt());
    const tick = this.f.game.ticks();
    for (const [id, expiresAt] of allied) {
      const still = now.get(id);
      if (still !== undefined) {
        allied.set(id, still);
        continue;
      }
      this.ended.push({
        id,
        h: this.h,
        early: expiresAt > tick,
        traitor: me.isTraitor(),
      });
      allied.delete(id);
    }
  }
}
