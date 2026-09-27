import {
  Difficulty,
  Game,
  GameMode,
  Player,
  PlayerID,
  PlayerType,
  Relation,
  Structures,
  Unit,
  UnitType,
} from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { NationModel } from "./NationModel";

// Nuke-rule replica and exposure (spec §2.9, §5.1 item 5; chapter 13 §2.11
// and §5.10, pinned by tests/agent/mechanics/NukeThreat.test.ts). A nation's
// nuke decision (NationNukeBehavior.maybeSendNuke, NNB below) runs once per
// decision tick, after its MIRV decision (NationExecution.ts:200-228):
//
// 1. WHO: findBestNukeTarget's ladder (NNB:222-316, 351-417), first match:
//    two players left; the sender of the largest single incoming attack; for
//    the richest nation 1 decision in 2 the densest structure holder; a
//    holder of > 50% of non-fallout land; a Friendly ally's target; the most
//    hostile player unless 2× weaker; last the crown rung: the land leader
//    once it leads the nation by more than 0.1, or, when the nation leads,
//    the runner-up at any margin. A tribe on a rung ends the decision.
// 2. WHAT (:139-155): a hydrogen bomb if its gold covers the perceived price,
//    else an atom bomb if it covers that one and the nation is no "hydro
//    nation" (1 in 3, a private PRNG draw) or is under heavy attack.
// 3. WHERE (:158-219): 30 random tiles of the target and its structure
//    tiles; an aim point needs both square rings (outer radius and half of
//    it) on the target's land or unowned tiles, a ready silo, and no enemy
//    SAM able to reach the trajectory; it scores structures within the
//    outer radius. The best must score > 0, else (Impossible) an atom salvo
//    at one of the target's SAMs (maybeDestroyEnemySam, :836-1061).
//
// In the arena (quick@20 and showcase-m2, package B3) 16 of the 19 bombs at
// the agent came from the last rung's runner-up half, the land leader
// aiming at us as its runner-up (1 crown lead, 2 with two players left);
// each took the city it was aimed at. Replayed against every real
// findBestNukeTarget call of 7 arena games (about 17,000), aimOf agreed on
// all but the density rung's random picks.
//
// Read-only: only getters (and the memoised unitCount / units(type) and
// nearbyUnits reads), no canBuild. Counts of launched bombs (the perceived
// prices) come from observe(), which the policy calls every tick.
//
// Where this departs from the code (the real code wins):
// - The richest nation's density rung draws random.chance(2); aimOf reports
//   it only when it names us (the worst case), else the rung below.
// - isHydroNation is a private PRNG draw (NNB:60). A launch can only show
//   that a nation is none (firesAtoms), never that it is one, so bombFor
//   keeps the worst case: every nation fires atoms.
// - A decision whose NukeExecution fails canBuild at its first tick raises
//   the nation's perceived price with no bomb to observe (World: 1 of 33
//   sends); the count then trails by one, the price errs low (the unsafe
//   side for the nation, the safe one for us).
// - nukeable() treats an aim point as interceptable only when it lies within
//   an enemy SAM's range (the trajectory's last tile); a path that crosses a
//   SAM's range on the way in is not credited (the unsafe side for us is
//   the other one, so this errs toward "nukeable").
// - Team mode (findStrongestTeamTarget, teammate checks) is not replicated.

export type NukeReason =
  | "twoPlayers"
  | "largestAttacker"
  | "dense"
  | "crown50"
  | "allyTarget"
  | "hated"
  | "crownLead"
  | "runnerUp";

export type Bomb = UnitType.AtomBomb | UnitType.HydrogenBomb;

export interface NukeExposure {
  nation: PlayerID;
  reason: NukeReason;
  /** The bomb its gold covers at its perceived prices (hydro first, as
   *  maybeSendNuke chooses), or null. */
  canPay: "atom" | "hydro" | null;
  /** Owns a silo, finished or not (maybeSendNuke's first gate counts
   *  both, :115-124; a launch needs a finished, ready one). */
  hasSilo: boolean;
  /** Not in spec §2.9: the ladder names us only below the rung that answers
   *  now (an incoming attack, a grudge, an ally's target), so its bombs go
   *  elsewhere until that rung clears. */
  latent: boolean;
  /** Not in spec §2.9: launch slots of its finished silos now (level less
   *  queued launches, SAMLauncher-style reload), what a SAM salvo needs. */
  slots: number;
  /** Not in spec §2.9: slots once its silos finish and reload, summed over
   *  every silo (level each), the salvo capacity it can reach without
   *  upgrading. */
  slotsMax: number;
}

/** A finished SAM of ours as the model reads it. */
export interface SamCover {
  tile: TileRef;
  level: number;
  range: number;
}

/** Density rung (NNB:44-47): above 1/75 levels per tile, at least 5 levels. */
const HIGH_DENSITY = 1 / 75;
const MIN_DENSE_LEVELS = 5;
/** Crown rung margin by difficulty (NNB:392-411). */
const CROWN_MARGIN: Record<Difficulty, number> = {
  [Difficulty.Easy]: 0.4,
  [Difficulty.Medium]: 0.3,
  [Difficulty.Hard]: 0.2,
  [Difficulty.Impossible]: 0.1,
};
/** Majority rung (NNB:268): > 50% of non-fallout land. */
const MAJORITY = 0.5;
/** Perceived price growth per launch, in percent (NNB:814-823). */
const ATOM_GROWTH = 150n;
const HYDRO_GROWTH = 125n;
/** Structures an aimed bomb scores (nukeTileScore, NNB:716-734): every one
 *  but the SAM (which scores only for a hydrogen bomb that outranges it). */
const SCORED: ReadonlySet<UnitType> = new Set([
  UnitType.City,
  UnitType.DefensePost,
  UnitType.MissileSilo,
  UnitType.Port,
  UnitType.Factory,
]);
/** Aim points sampled around each structure, in tiles between samples, as
 *  a share of the bomb's outer radius. */
const AIM_STEP_SHARE = 1 / 6;
/** Ticks of gold history behind projectedGold's rate. */
const GOLD_WINDOW = 300;

interface Launches {
  atoms: number;
  hydros: number;
  /** Launched an atom bomb that was not aimed at a SAM tile while not
   *  under heavy attack: it is no hydro nation (NNB:147-151). */
  notHydro: boolean;
  /** Tick its last hydrogen bomb was first seen (−∞: none). */
  lastHydro: number;
  /** Tick its last atom bomb aimed at one of our SAMs was first seen, a
   *  salvo (maybeDestroyEnemySam) (−∞: none). */
  lastSalvo: number;
}

/** Bombs a salvo needs against SAMs of `levels` interceptors in all
 *  (maybeDestroyEnemySam :873-879, :949-952): one more than the levels,
 *  plus one per five of those. */
export function salvoBombs(levels: number): number {
  const needed = levels + 1;
  return needed + Math.floor(needed / 5);
}

/** One view of the land ranking, shared by every nation's ladder in a call. */
interface Ranking {
  sorted: Player[];
  /** numLandTiles − numTilesWithFallout. */
  land: number;
  players: number;
}

export class NukeModel {
  private readonly launches = new Map<PlayerID, Launches>();
  private readonly seen = new Set<number>();
  private readonly difficulty: Difficulty;
  private readonly ffa: boolean;
  private rankingAt = Number.NEGATIVE_INFINITY;
  private ranking: Ranking | null = null;
  private exposureAt = Number.NEGATIVE_INFINITY;
  private exposureCache: NukeExposure[] = [];
  /** Gold of each silo owner at exposures() calls, oldest first, over
   *  about GOLD_WINDOW ticks (projectedGold). */
  private readonly goldLog = new Map<
    PlayerID,
    { tick: number; gold: bigint }[]
  >();
  /** Nations whose ladder named us (any rung), with the last exposures()
   *  tick that saw it: the ranking flips back and forth. */
  private readonly named = new Map<
    PlayerID,
    { tick: number; reason: NukeReason }
  >();

  constructor(
    private readonly game: Game,
    private readonly me: Player,
    private readonly nm: NationModel,
  ) {
    const gc = game.config().gameConfig();
    this.difficulty = gc.difficulty;
    this.ffa = gc.gameMode === GameMode.FFA;
  }

  /**
   * Package WP1 (docs/14-m4-plan.md §2.2): a copy bound to `game`, a fork of
   * this model's game at the same tick, with `me` its player there and `nm`
   * its NationModel. It carries what observe and exposures remember from
   * tick to tick: the launch counts behind the perceived prices, the bombs
   * seen, the silo owners' gold samples and the nations whose ladder named
   * us. The per-tick caches (ranking, exposures) hold players of this game
   * and are rebuilt at their first use in the copy: at the start of a live
   * tick they hold an earlier tick's values, which neither model reads
   * again.
   */
  cloneFor(game: Game, me: Player, nm: NationModel): NukeModel {
    const c = new NukeModel(game, me, nm);
    for (const [id, l] of this.launches) c.launches.set(id, { ...l });
    for (const id of this.seen) c.seen.add(id);
    for (const [id, log] of this.goldLog) {
      c.goldLog.set(
        id,
        log.map((e) => ({ ...e })),
      );
    }
    for (const [id, e] of this.named) c.named.set(id, { ...e });
    return c;
  }

  /** N's next decision tick at or after `from` (NationModel.nextDecision:
   *  exact from the gameID, NationParams pin). */
  nextDecision(n: PlayerID, from: number): number {
    return this.nm.nextDecision(n, from);
  }

  // ── Observation ────────────────────────────────────────────────────────

  /**
   * Every tick: counts each new atom and hydrogen bomb by its owner, the
   * launch counts behind the perceived prices. O(1) while no bomb flies
   * (unitCount is memoised per unit-list version); a bomb flies for at
   * least a few ticks, so a policy that observes every tick sees them all.
   */
  observe(): void {
    const g = this.game;
    if (
      g.unitCount(UnitType.AtomBomb) === 0 &&
      g.unitCount(UnitType.HydrogenBomb) === 0
    ) {
      return;
    }
    for (const type of [UnitType.AtomBomb, UnitType.HydrogenBomb] as const) {
      for (const u of g.units(type)) {
        if (this.seen.has(u.id())) continue;
        this.seen.add(u.id());
        this.countLaunch(u);
      }
    }
  }

  private countLaunch(u: Unit): void {
    const owner = u.owner();
    const id = owner.id();
    const l = this.launches.get(id) ?? {
      atoms: 0,
      hydros: 0,
      notHydro: false,
      lastHydro: Number.NEGATIVE_INFINITY,
      lastSalvo: Number.NEGATIVE_INFINITY,
    };
    const tick = this.game.ticks();
    if (u.type() === UnitType.HydrogenBomb) {
      l.hydros++;
      l.lastHydro = tick;
    } else {
      l.atoms++;
      const t = u.targetTile();
      const sams =
        t === undefined
          ? []
          : this.game.nearbyUnits(t, 1, UnitType.SAMLauncher, undefined, true);
      if (sams.length === 0 && !this.heavyAttack(owner)) l.notHydro = true;
      if (sams.some(({ unit }) => unit.owner() === this.me)) {
        l.lastSalvo = tick;
      }
    }
    this.launches.set(id, l);
  }

  /** Whether N launched a hydrogen bomb (at anyone) at or after `since`: it
   *  had the gold for one (package B3 review: Korpoström fired one at
   *  10948, and its gold, 3.05M 7 ticks later, read as far from the next). */
  hydroSince(n: PlayerID, since: number): boolean {
    return (
      (this.launches.get(n)?.lastHydro ?? Number.NEGATIVE_INFINITY) >= since
    );
  }

  /** Whether N fired an atom bomb at one of our SAMs at or after `since`. */
  salvoSince(n: PlayerID, since: number): boolean {
    return (
      (this.launches.get(n)?.lastSalvo ?? Number.NEGATIVE_INFINITY) >= since
    );
  }

  /** Bombs of each type N has launched since this model started. */
  launched(n: PlayerID): { atoms: number; hydros: number } {
    const l = this.launches.get(n);
    return { atoms: l?.atoms ?? 0, hydros: l?.hydros ?? 0 };
  }

  // ── Prices ─────────────────────────────────────────────────────────────

  /**
   * getPerceivedNukeCost (NNB:487-531): the real price with two players
   * left, MIRVs disabled, gold above MIRV + hydro, or under heavy attack
   * (Hard, Impossible); else 750k·1.5^atoms or 5M·1.25^hydros launched by
   * N, stepped in integers as sendNuke steps it (:814-823).
   */
  perceivedCost(n: PlayerID, t: Bomb): bigint {
    const g = this.game;
    const N = g.player(n);
    const config = g.config();
    const real = config.unitInfo(t).cost(g, N);
    if (g.players().length === 2) return real;
    if (config.isUnitDisabled(UnitType.MIRV)) return real;
    const hydro = config.unitInfo(UnitType.HydrogenBomb).cost(g, N);
    if (!this.ffa && N.gold() > hydro) return real;
    const mirv = config.unitInfo(UnitType.MIRV).cost(g, N);
    if (N.gold() > mirv + hydro) return real;
    if (
      (this.difficulty === Difficulty.Hard ||
        this.difficulty === Difficulty.Impossible) &&
      this.heavyAttack(N)
    ) {
      return real;
    }
    const l = this.launches.get(n);
    let cost = real;
    if (t === UnitType.AtomBomb) {
      for (let i = 0; i < (l?.atoms ?? 0); i++) {
        cost = (cost * ATOM_GROWTH) / 100n;
      }
    } else {
      for (let i = 0; i < (l?.hydros ?? 0); i++) {
        cost = (cost * HYDRO_GROWTH) / 100n;
      }
    }
    return cost;
  }

  /** isUnderHeavyAttack (NNB:533-544): every incoming attack's troops
   *  (tribes' and allies' too) at least N's troops. */
  heavyAttack(N: Player): boolean {
    let incoming = 0;
    for (const a of N.incomingAttacks()) incoming += a.troops();
    return incoming >= N.troops();
  }

  /**
   * The bomb N's decision would pick now (maybeSendNuke :139-155): a
   * hydrogen bomb if its gold covers the perceived price; else an atom bomb
   * if it covers that one and N may fire atoms (not known to be a hydro
   * nation, which a launch never proves, so always; or under heavy attack).
   */
  bombFor(n: PlayerID): Bomb | null {
    const g = this.game;
    const config = g.config();
    const N = g.player(n);
    const gold = N.gold();
    if (
      !config.isUnitDisabled(UnitType.HydrogenBomb) &&
      gold >= this.perceivedCost(n, UnitType.HydrogenBomb)
    ) {
      return UnitType.HydrogenBomb;
    }
    if (
      !config.isUnitDisabled(UnitType.AtomBomb) &&
      gold >= this.perceivedCost(n, UnitType.AtomBomb)
    ) {
      return UnitType.AtomBomb;
    }
    return null;
  }

  /** Whether a launch showed N fires atoms without being under attack. */
  firesAtoms(n: PlayerID): boolean {
    return this.launches.get(n)?.notHydro ?? false;
  }

  // ── Silos ──────────────────────────────────────────────────────────────

  /** Launch slots of N's finished silos now (maybeDestroyEnemySam :887-893:
   *  level less queued launches) and once every silo is finished and
   *  reloaded (the sum of levels). */
  slots(N: Player): { now: number; max: number; silos: number } {
    let now = 0;
    let max = 0;
    let silos = 0;
    for (const s of N.units(UnitType.MissileSilo)) {
      silos++;
      max += s.level();
      if (s.isUnderConstruction()) continue;
      now += Math.max(0, s.level() - s.missileTimerQueue().length);
    }
    return { now, max, silos };
  }

  // ── Who: the ladder ────────────────────────────────────────────────────

  private rank(): Ranking {
    const g = this.game;
    const tick = g.ticks();
    if (this.ranking !== null && this.rankingAt === tick) return this.ranking;
    const players = g.players();
    // Array.prototype.sort is stable, as in findFFACrownTarget (:362-365).
    const sorted = players
      .slice()
      .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
    this.ranking = {
      sorted,
      land: g.numLandTiles() - g.numTilesWithFallout(),
      players: players.length,
    };
    this.rankingAt = tick;
    return this.ranking;
  }

  /** Whether N counts as the richest nation (isRichestNation :318-326). */
  private richest(N: Player): boolean {
    for (const other of this.game.players()) {
      if (other === N || other.type() !== PlayerType.Nation) continue;
      if (other.gold() > N.gold()) return false;
    }
    return true;
  }

  /**
   * Every rung of N's ladder that names a player now, in ladder order
   * (findBestNukeTarget :222-316). The first is the target; the dense rung
   * (random 1 in 2) is listed only when it names us.
   */
  private rungs(
    N: Player,
    stopAtFirst: boolean,
  ): {
    reason: NukeReason;
    target: Player;
  }[] {
    const g = this.game;
    const out: { reason: NukeReason; target: Player }[] = [];
    const push = (reason: NukeReason, target: Player | null): boolean => {
      if (target === null) return false;
      out.push({ reason, target });
      return stopAtFirst;
    };
    const d = this.difficulty;
    const hardish = d === Difficulty.Hard || d === Difficulty.Impossible;
    const r = this.rank();
    if (hardish && r.players === 2) {
      const other = g.players().find((p) => p !== N) ?? null;
      if (push("twoPlayers", other)) return out;
    }
    if (push("largestAttacker", this.largestAttacker(N))) return out;
    if (d === Difficulty.Impossible && this.richest(N)) {
      const dense = this.denseTarget(N);
      if (dense === this.me && push("dense", dense)) return out;
    }
    if (d === Difficulty.Impossible && this.ffa && r.land > 0) {
      const crown = r.sorted[0];
      if (
        crown !== undefined &&
        crown !== N &&
        !N.isFriendly(crown) &&
        crown.numTilesOwned() / r.land > MAJORITY &&
        push("crown50", crown)
      ) {
        return out;
      }
    }
    if (push("allyTarget", this.allyTarget(N))) return out;
    if (push("hated", this.hated(N))) return out;
    const crown = this.crownTarget(N);
    if (crown !== null) push(crown.reason, crown.target);
    return out;
  }

  /** findIncomingAttackPlayer (AiAttackBehavior.ts:458-479): the sender of
   *  the largest single incoming attack, allies and tribes left out. */
  private largestAttacker(N: Player): Player | null {
    let best = 0;
    let who: Player | null = null;
    const bot = N.type() === PlayerType.Bot;
    for (const a of N.incomingAttacks()) {
      const attacker = a.attacker();
      if (N.isFriendly(attacker)) continue;
      if (!bot && attacker.type() === PlayerType.Bot) continue;
      if (a.troops() <= best) continue;
      best = a.troops();
      who = attacker;
    }
    return who;
  }

  /** findHighDensityTarget (:328-349). Only computed far enough to tell
   *  whether it is us: our density must pass the bar first. */
  private denseTarget(N: Player): Player | null {
    const mine = this.density(this.me);
    if (mine === null || N.isFriendly(this.me)) return null;
    let best: Player | null = null;
    let bestDensity = HIGH_DENSITY;
    for (const other of this.game.players()) {
      if (other === N || other.type() === PlayerType.Bot) continue;
      if (N.isFriendly(other)) continue;
      const dens = other === this.me ? mine : this.density(other);
      if (dens !== null && dens > bestDensity) {
        bestDensity = dens;
        best = other;
      }
    }
    return best;
  }

  private density(p: Player): number | null {
    const tiles = p.numTilesOwned();
    if (tiles === 0) return null;
    let levels = 0;
    for (const u of p.units(Structures.types)) levels += u.level();
    if (levels < MIN_DENSE_LEVELS) return null;
    return levels / tiles;
  }

  /** The ally-target rung (:277-287). */
  private allyTarget(N: Player): Player | null {
    for (const ally of N.allies()) {
      const targets = ally.targets();
      if (targets.length === 0) continue;
      if (N.relation(ally) < Relation.Friendly) continue;
      for (const t of targets) {
        if (t === N || N.isFriendly(t)) continue;
        return t;
      }
    }
    return null;
  }

  /** The most-hostile rung (:289-301). */
  private hated(N: Player): Player | null {
    const config = this.game.config();
    let mine: number | null = null;
    for (const rel of N.allRelationsSorted()) {
      if (rel.relation !== Relation.Hostile) continue;
      const other = rel.player;
      if (N.isFriendly(other)) continue;
      mine ??= config.maxTroops(N);
      if (mine >= config.maxTroops(other) * 2) continue;
      return other;
    }
    return null;
  }

  /** findFFACrownTarget (:351-417). */
  crownTarget(N: Player): { reason: NukeReason; target: Player } | null {
    if (!this.ffa) return null;
    const r = this.rank();
    if (r.players <= 1) return null;
    const first = r.sorted[0];
    if (
      this.difficulty === Difficulty.Impossible &&
      first === N &&
      r.sorted.length >= 2
    ) {
      const second = r.sorted[1];
      if (!N.isFriendly(second)) return { reason: "runnerUp", target: second };
    }
    if (first === N || N.isFriendly(first)) return null;
    if (r.land <= 0) return null;
    // Two divisions, as the code has them (:394-395): the floating-point
    // difference decides the edge (0.4 − 0.3 is just above 0.1).
    const lead = first.numTilesOwned() / r.land - N.numTilesOwned() / r.land;
    return lead > CROWN_MARGIN[this.difficulty]
      ? { reason: "crownLead", target: first }
      : null;
  }

  /** findBestNukeTarget's answer for nation `n` now (the dense rung's
   *  worst case for us, see above). */
  aimOf(n: PlayerID): { target: PlayerID | null; reason: NukeReason | null } {
    if (!this.game.hasPlayer(n)) return { target: null, reason: null };
    const N = this.game.player(n);
    if (!N.isAlive()) return { target: null, reason: null };
    const first = this.rungs(N, true)[0];
    return first === undefined
      ? { target: null, reason: null }
      : { target: first.target.id(), reason: first.reason };
  }

  // ── Exposure ───────────────────────────────────────────────────────────

  /**
   * Every living nation with a silo (finished or not) whose ladder names us
   * now (latent false) or on a lower rung that the current answer hides
   * (latent true), with its slots and the bomb its gold covers. A nation
   * "would fire at us now if we owned value" exactly when !latent && canPay
   * && slots > 0. Cached per tick; samples each silo owner's gold
   * (projectedGold).
   */
  exposures(): NukeExposure[] {
    const g = this.game;
    const tick = g.ticks();
    if (this.exposureAt === tick) return this.exposureCache;
    const out: NukeExposure[] = [];
    for (const N of g.players()) {
      if (N === this.me || N.type() !== PlayerType.Nation) continue;
      // maybeSendNuke's first gate (:115-124): no silo, no decision.
      if (N.units(UnitType.MissileSilo).length === 0) continue;
      this.sampleGold(N, tick);
      const rungs = this.rungs(N, false);
      if (rungs.length === 0) continue;
      const at = rungs.findIndex((x) => x.target === this.me);
      if (at < 0) continue;
      this.named.set(N.id(), { tick, reason: rungs[at].reason });
      const s = this.slots(N);
      const bomb = this.bombFor(N.id());
      out.push({
        nation: N.id(),
        reason: rungs[at].reason,
        canPay:
          bomb === null
            ? null
            : bomb === UnitType.HydrogenBomb
              ? "hydro"
              : "atom",
        hasSilo: s.silos > 0,
        latent: at > 0,
        slots: s.now,
        slotsMax: s.max,
      });
    }
    this.exposureAt = tick;
    this.exposureCache = out;
    return out;
  }

  private sampleGold(N: Player, tick: number): void {
    const log = this.goldLog.get(N.id()) ?? [];
    if (log.length === 0 || log[log.length - 1].tick < tick) {
      log.push({ tick, gold: N.gold() });
    }
    while (log.length > 2 && log[1].tick <= tick - GOLD_WINDOW) log.shift();
    this.goldLog.set(N.id(), log);
  }

  /**
   * N's gold `horizon` ticks ahead at its net gain since the oldest sample
   * of its last ~GOLD_WINDOW ticks (exposures() samples silo owners), or
   * its gold now if it gained nothing. Nations gain gold in bursts
   * (conquest; quick@20 Bering Strait: Alaska from under 2.5M to 6M within
   * about 300 ticks, then a hydrogen bomb), so the rate is read, not the
   * wages. A purchase reads as no income (package B3 review: Korpoström,
   * 7.9M, fired a hydrogen bomb at 10948 and projected 3.05M at 10955);
   * hydroSince covers that case in nukeThreats. The rate stays round 1's:
   * in a shadow run over the 9 games round 1 changed, rates that leave
   * spending out (a gross rate, bombs bought added back) and samples taken
   * before a nation's silo moved the SAM rule both ways (they refused 3 of
   * the 5 SAMs that helped, or ordered one at 1835 in the game where round
   * 1's v2 lost its hub to a hydrogen bomb), and adding back the hydrogen
   * bomb alone still missed Korpoström (it had spent 1.6M more since the
   * window's first sample).
   */
  projectedGold(n: PlayerID, horizon: number): bigint {
    const N = this.game.player(n);
    const gold = N.gold();
    const log = this.goldLog.get(n);
    if (log === undefined || log.length === 0 || horizon <= 0) return gold;
    const first = log[0];
    const dt = this.game.ticks() - first.tick;
    if (dt <= 0 || gold <= first.gold) return gold;
    return gold + ((gold - first.gold) * BigInt(horizon)) / BigInt(dt);
  }

  /**
   * The gold N needs, over the decisions of one salvo plan, to destroy our
   * SAMs of `levels` interceptors in all (maybeDestroyEnemySam, :836-1061;
   * package B3 review): salvoBombs(levels) atoms at the real price, fired
   * from one decision whose type choice (:139-155) also needs the
   * perceived atom price, and one silo upgrade (instant, at the silo's
   * price, maybeUpgradeHelpfulSilo :1093-1155) per missing launch slot at
   * earlier decisions. Slots are counted once every silo of N is finished
   * and reloaded (the sum of levels). Arrival windows, trajectories other
   * SAMs block and the level-5 upgrade cap are not modelled (they only
   * raise the price); nor is a hydro nation's higher entry (the perceived
   * hydrogen price): the worst case, a nation that fires atoms.
   */
  salvoLine(n: PlayerID, levels: number): bigint {
    const g = this.game;
    const config = g.config();
    const N = g.player(n);
    const bombs = salvoBombs(levels);
    let slots = 0;
    for (const s of N.units(UnitType.MissileSilo)) slots += s.level();
    const upgrades = BigInt(Math.max(0, bombs - slots));
    const real = config.unitInfo(UnitType.AtomBomb).cost(g, N) * BigInt(bombs);
    const perceived = this.perceivedCost(n, UnitType.AtomBomb);
    const fire = real > perceived ? real : perceived;
    return upgrades * config.unitInfo(UnitType.MissileSilo).cost(g, N) + fire;
  }

  /** Nations whose ladder named us at an exposures() call at or after
   *  `since`, with the last such tick and rung. */
  namedSince(
    since: number,
  ): { nation: PlayerID; tick: number; reason: NukeReason }[] {
    const out: { nation: PlayerID; tick: number; reason: NukeReason }[] = [];
    for (const [nation, v] of this.named) {
      if (v.tick >= since) out.push({ nation, ...v });
    }
    return out;
  }

  /** Living humans and nations by tiles, most first: the crown rungs'
   *  ranking (ties in game.players() order) without the tribes, which the
   *  rungs count but which are eaten first. */
  nonBotRank(): Player[] {
    return this.rank().sorted.filter((p) => p.type() !== PlayerType.Bot);
  }

  // ── Where: aim points ──────────────────────────────────────────────────

  /** Our finished SAMs with their ranges (config.samRange). */
  ourSams(): SamCover[] {
    const config = this.game.config();
    const out: SamCover[] = [];
    for (const s of this.me.units(UnitType.SAMLauncher)) {
      if (s.isUnderConstruction() || !s.isActive()) continue;
      out.push({
        tile: s.tile(),
        level: s.level(),
        range: config.samRange(s.level()),
      });
    }
    return out;
  }

  /**
   * isValidNukeTile over both rings of an aim point (NNB:175-184,
   * :686-704): every tile of the square perimeters at the bomb's outer
   * radius and at half of it (boundingBoxTiles, off-map tiles skipped) is
   * ours or unowned. At Hard and Impossible only; lower difficulties need
   * every tile to be ours (the unowned case is not modelled there).
   */
  ringsClear(aim: TileRef, bomb: Bomb): boolean {
    const outer = this.game.config().nukeMagnitudes(bomb).outer;
    return (
      this.ringClear(aim, outer) && this.ringClear(aim, Math.floor(outer / 2))
    );
  }

  private ringClear(aim: TileRef, r: number): boolean {
    const g = this.game;
    const us = this.me.smallID();
    const cx = g.x(aim);
    const cy = g.y(aim);
    const w = g.width();
    const h = g.height();
    const ok = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= w || y >= h) return true;
      const t = g.ref(x, y);
      if (!g.hasOwner(t)) return true;
      return g.ownerID(t) === us;
    };
    for (let x = cx - r; x <= cx + r; x++) {
      if (!ok(x, cy - r) || !ok(x, cy + r)) return false;
    }
    for (let y = cy - r + 1; y < cy + r; y++) {
      if (!ok(cx - r, y) || !ok(cx + r, y)) return false;
    }
    return true;
  }

  /** Whether a finished SAM (ours, or `by`'s enemy's) reaches the aim point,
   *  which makes its trajectory interceptable (isTrajectoryInterceptableBySam
   *  :603-684, credited only for the trajectory's last tile). */
  private covered(aim: TileRef, by: Player | null): boolean {
    const g = this.game;
    const config = g.config();
    for (const { unit, distSquared } of g.nearbyUnits(
      aim,
      config.maxSamRange(),
      UnitType.SAMLauncher,
    )) {
      const owner = unit.owner();
      if (by !== null) {
        if (owner === by || by.isFriendly(owner)) continue;
      } else if (owner !== this.me) {
        continue;
      }
      const range = config.samRange(unit.level());
      if (distSquared <= range * range) return true;
    }
    return false;
  }

  /**
   * True if some aim point within the bomb's outer radius of one of
   * `structureTiles` has both rings clear (ringsClear) and no SAM reaching
   * it: the structures there score > 0 (nukeTileScore :706-804, every
   * structure but a SAM), so a nation that aims at us fires. Aim points are
   * the structure tiles themselves (always candidates, :164-168) and a grid
   * of our tiles around each (the 30 random tiles, :158-163, can be any of
   * ours). With `by`, the SAMs that block are those of anyone but `by` and
   * its friends (the nation's own check); without, ours.
   */
  nukeable(
    structureTiles: TileRef[],
    bomb: Bomb,
    by: Player | null = null,
  ): boolean {
    return structureTiles.some((t) => this.aimPoint(t, bomb, by) !== null);
  }

  /** An aim point that would hit `site` (see nukeable), or null. */
  aimPoint(
    site: TileRef,
    bomb: Bomb,
    by: Player | null = null,
  ): TileRef | null {
    const g = this.game;
    const outer = g.config().nukeMagnitudes(bomb).outer;
    const us = this.me.smallID();
    const step = Math.max(2, Math.round(outer * AIM_STEP_SHARE));
    const sx = g.x(site);
    const sy = g.y(site);
    const r2 = outer * outer;
    const tryAim = (t: TileRef): boolean =>
      !this.covered(t, by) && this.ringsClear(t, bomb);
    if (tryAim(site)) return site;
    for (let dy = -outer; dy <= outer; dy += step) {
      for (let dx = -outer; dx <= outer; dx += step) {
        if (dx === 0 && dy === 0) continue;
        if (dx * dx + dy * dy > r2) continue;
        const x = sx + dx;
        const y = sy + dy;
        if (!g.isValidCoord(x, y)) continue;
        const t = g.ref(x, y);
        if (g.ownerID(t) !== us) continue;
        if (tryAim(t)) return t;
      }
    }
    return null;
  }

  /** Our structures an aimed bomb scores, finished or not. */
  scoredStructures(): Unit[] {
    return this.me.units(Structures.types).filter((u) => SCORED.has(u.type()));
  }
}

/** The spec's `constructor(game, me, nm)`. */
export type NukeModelConstructor = new (
  game: Game,
  me: Player,
  nm: NationModel,
) => NukeModel;
