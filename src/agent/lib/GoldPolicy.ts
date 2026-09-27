import {
  Difficulty,
  Game,
  Player,
  PlayerType,
  Structures,
  Unit,
  UnitType,
} from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { Bomb, NukeModel } from "./NukeModel";

// Package WP8, the leader's economy (docs/14-m4-plan.md §1.7, §2.8 items
// 1-2): when idle gold buys city levels. A level is 250k of cap
// (config.maxTroops), and a player that idles at its cap turns cap into
// troops, but the rule the agent plays today builds almost nothing after
// minute 4: EconomyController.exposedSite refuses every level while any
// living nation has a finished silo and the gold for an atom bomb (wide:
// also a silo started, or the gold for a silo and a bomb). Apex's
// defaults ("UE", arena quick20-int) held a median 0.9, 1.2 and 1.6M gold
// at minutes 10, 15 and 20, and up to 53M.
//
// What a structure draws [PIN NukeStructures, NukeThreat]: an Impossible
// nation's aimed atom and hydrogen bombs need a tile of ours that scores
// > 0, a City, Port, Factory, Defense post or Silo within the bomb's outer
// radius (NationNukeBehavior.nukeTileScore, NNB :706-804, :212-219). Bare
// land never draws one; a lone SAM draws an atom salvo (maybeDestroyEnemySam)
// or a hydrogen bomb that outranges it; and a nation never aims at a
// player it is friendly with (isFriendly) while more than two players
// live (findBestNukeTarget :222-316). MIRVs ignore alliances and
// structures, except the steamroll rung: the holder of the most City
// levels, above 8 and 1.15x the runner-up's (NationMIRVBehavior :102-131).
//
// The arms (goldPolicy) only add buys to today's rule: from tick goldFrom
// on, when today's rule refuses every site it tried (planCity's
// "exposed"), the EconomyController asks the arm's gate, which governs
// that buy. Before goldFrom, and with "exposure", today's rule decides
// alone:
// - "exposure": today's rule; cityGate returns null.
// - "model": no level at a site a nation that answers us can aim at
//   (modelThreats): NukeModel's ladder replica names us on the rung that
//   answers now (not latent), the nation owns a silo, and its gold covers
//   a bomb at its perceived price now, or will soon (package B3's test:
//   its gold projected nukeHorizon ticks ahead reaches nukePayShare of the
//   perceived price, or it fired a hydrogen bomb within nukeMemory ticks);
//   a nation with a bomb in flight at our land counts whatever its rung
//   and gold. A site is refused if one of the bombs it would pick has an
//   aim point there (NukeModel.nukeable: both rings clear, no SAM reaching
//   it). A latent ladder (we are named below the rung that answers now)
//   does not refuse.
// - "allied": no level while a silo owner (a silo finished or started)
//   holding the atom's price is not our ally, unless a finished SAM of
//   ours covers the site, since allies never aim at us; an alliance with
//   extendLead ticks or fewer left (the web asks its extension then) no
//   longer counts. With two players left an ally does aim at us, so none
//   is exempt. Unlike exposedSite's wide rule, gold for a silo and a bomb
//   without a silo does not count.
// - "free": no nuke gate (citySpread and cityMaxLevel still hold).
// Every arm, round 2 (the WP8 review's findings 3 and 4):
// - Never a level an enemy bomb in flight will delete: no build or upgrade
//   at a site strictly inside the outer radius of an enemy bomb's aim
//   (inboundNukeLevels' geometry; NukeExecution.ts:467-483).
// - A hold, whatever the site: "bombed" while an enemy bomb in flight is
//   aimed at our land (bombsInFlight), "attacked" while the attacks on us
//   carry at least our home troops (heavilyAttacked: the nations' own
//   isUnderHeavyAttack, NNB :533-544, applied to us). Attackers capture
//   the cities on the land they take (PlayerExecution captureUnit), and
//   the nation bombing us fires again at its next decision it can pay
//   for. quick@20, round 1: Bering Strait g19 ("model"): 5 buys (2.4M)
//   between ticks 2765 and 3035 while Alaska fired 6 bombs (2449-2939),
//   our City levels 0 by 2975; g3 ("allied"): an upgrade 10 ticks after
//   Alaska's hydrogen launch, inside its blast; Onion g4 ("free"): 7
//   levels (2.75M) between 2403 and 2673 while 1.3-2.2M-troop attacks cut
//   our land from 47k tiles to 4k, the cities captured, and apex
//   eliminated at 2975 (today's rule survived the game).
// - The SAM-hub rules of planCityModel (EconomyController.planCity).
// An arm's buys spend only the gold above goldReserve; with goldGuard they
// never cross the MIRV steamroll line or the line of the richest nation's
// dense-target rung (> 1/75 structure levels a tile, at least 5 levels,
// NNB :318-349); with goldHydroCap, while a hydrogen threat names us
// (hydroThreat), they keep the City levels one hydrogen bomb can take at
// most that many (hydroRoom). Today's buys keep today's rule.
//
// Pure in the game: only getters (and NukeModel.exposures, which samples
// the silo owners' gold as every call does); no ctx.random, no state of its
// own, so a rollout copy decides as the live policy does. So there is no
// memory of a bomb once it has landed: the hold lasts while one flies
// (50-150 ticks in the arena), and "model" then reads the shooter's gold
// against its perceived price, which each launch raises (1.5x an atom,
// 1.25x a hydrogen bomb, NNB :814-823).

export type GoldPolicyArm = "exposure" | "model" | "allied" | "free";

export const GOLD_POLICIES: readonly GoldPolicyArm[] = [
  "exposure",
  "model",
  "allied",
  "free",
];

/** What cityGate reads of the agent's options. */
export interface GoldOptions {
  goldPolicy: GoldPolicyArm;
  goldFrom: number;
  goldReserve: number;
  goldGuard: boolean;
  goldHydroCap: number;
  /** Package B3's knobs, read by "model" (modelThreats) and the hydrogen
   *  threat (hydroThreat). */
  nukePayShare: number;
  nukeMemory: number;
  nukeHorizon: number;
  /** The web asks an ally's extension this many ticks before the end
   *  ("allied": a shorter alliance protects nothing). */
  extendLead: number;
}

/** Why an arm buys nothing now, whatever the site: an enemy bomb in flight
 *  is aimed at our land ("bombed"), or the attacks on us carry at least
 *  our home troops ("attacked"). */
export type GoldHold = "bombed" | "attacked";

/** The gold arm's gate on one city check (EconomyController.planCity). */
export interface CityGate {
  arm: Exclude<GoldPolicyArm, "exposure">;
  /** Gold the check may spend: ours less goldReserve (negative if short). */
  budget: bigint;
  /** City levels we may hold after the buy, as unitCount(City) counts
   *  them (levels of finished cities, 1 per city under construction);
   *  Infinity without goldGuard. */
  maxLevels: number;
  /** No buy at all now, and why (null: none). */
  hold: GoldHold | null;
  /** Whether a City level may go at `tile` (a build's tile, an upgrade's
   *  city). */
  allows(tile: TileRef): boolean;
  /** The most levels a city of ours at `tile` (`self`, if it stands) may
   *  reach under goldHydroCap: the cap less the levels of our other
   *  cities within twice a hydrogen bomb's outer radius, which one bomb
   *  can take together (Infinity: off). */
  cityRoom(tile: TileRef, self?: Unit): number;
  /** Names of the nations the arm refuses sites for (the log). */
  blockers: string[];
}

/**
 * The gate of o.goldPolicy on a city check at `tick`, or null for today's
 * rule ("exposure", before o.goldFrom, or "model" without a model).
 */
export function cityGate(
  game: Game,
  me: Player,
  o: GoldOptions,
  tick: number,
  nukes?: NukeModel,
): CityGate | null {
  if (o.goldPolicy === "exposure" || tick < o.goldFrom) return null;
  if (o.goldPolicy === "model" && nukes === undefined) return null;
  const reserve = BigInt(Math.max(0, Math.round(o.goldReserve)));
  const budget = me.gold() - reserve;
  const maxLevels = o.goldGuard
    ? Math.min(steamrollLine(game, me), densityLine(me))
    : Infinity;
  // The cap binds only under a hydrogen threat (without a model, always).
  const capped =
    o.goldHydroCap > 0 && (nukes === undefined || hydroThreat(game, nukes, o));
  const cityRoom = (tile: TileRef, self?: Unit) =>
    capped ? hydroRoom(game, me, tile, o.goldHydroCap, self) : Infinity;
  const flying = bombsInFlight(game, me);
  const hold: GoldHold | null = flying.some((b) => b.atUs)
    ? "bombed"
    : heavilyAttacked(me)
      ? "attacked"
      : null;
  const clear = (t: TileRef) => !inBlast(game, flying, t);
  const base = { budget, maxLevels, cityRoom, hold };
  switch (o.goldPolicy) {
    case "free":
      return { ...base, arm: "free", allows: clear, blockers: [] };
    case "allied": {
      const armed = unalliedArmed(game, me, o.extendLead);
      return {
        ...base,
        arm: "allied",
        allows: (t) =>
          clear(t) && (armed.length === 0 || samCovered(game, me, t)),
        blockers: armed.map((p) => p.name()),
      };
    }
    case "model": {
      const model = nukes!;
      const threats = modelThreats(game, model, o, flying);
      return {
        ...base,
        arm: "model",
        allows: (t) =>
          clear(t) &&
          threats.every((th) =>
            th.bombs.every((b) => !model.nukeable([t], b, th.nation)),
          ),
        blockers: threats.map(
          (th) =>
            `${th.nation.name()}:${th.why}:` +
            th.bombs
              .map((b) => (b === UnitType.HydrogenBomb ? "H" : "A"))
              .join(""),
        ),
      };
    }
  }
}

/** An enemy bomb in flight (bombsInFlight). */
export interface InFlight {
  owner: Player;
  type: UnitType;
  /** Its aim tile (Unit.targetTile). */
  tile: TileRef;
  /** Its blast's outer radius (config.nukeMagnitudes); 0 for a MIRV,
   *  whose warheads carry their own. */
  r: number;
  /** Aimed at a tile of ours. */
  atUs: boolean;
}

/** Every enemy bomb in flight: atom and hydrogen bombs, MIRVs and their
 *  warheads, active, owned by anyone but us. */
export function bombsInFlight(game: Game, me: Player): InFlight[] {
  const config = game.config();
  const us = me.smallID();
  const out: InFlight[] = [];
  for (const b of game.units([
    UnitType.AtomBomb,
    UnitType.HydrogenBomb,
    UnitType.MIRVWarhead,
    UnitType.MIRV,
  ])) {
    if (b.owner() === me || !b.isActive()) continue;
    const tile = b.targetTile();
    if (tile === undefined) continue;
    const type = b.type();
    out.push({
      owner: b.owner(),
      type,
      tile,
      r: type === UnitType.MIRV ? 0 : config.nukeMagnitudes(type).outer,
      atUs: game.ownerID(tile) === us,
    });
  }
  return out;
}

/** Whether `tile` is strictly inside the outer radius of one of `bombs`'
 *  aims: a blast deletes every unit there (NukeExecution.ts:467-483). */
export function inBlast(
  game: Game,
  bombs: readonly InFlight[],
  tile: TileRef,
): boolean {
  return bombs.some(
    (b) => b.r > 0 && game.euclideanDistSquared(b.tile, tile) < b.r * b.r,
  );
}

/** The nations' isUnderHeavyAttack (NNB :533-544) applied to us: the
 *  troops of every attack on us, at least our home troops (and some). */
export function heavilyAttacked(me: Player): boolean {
  let incoming = 0;
  for (const a of me.incomingAttacks()) incoming += a.troops();
  return incoming > 0 && incoming >= me.troops();
}

/** A nation "model" refuses sites for, the bombs it would pick, and why:
 *  it can pay for one at its next decision with a finished silo
 *  ("firing"), it will soon ("soon"), or a bomb of its flies at our land
 *  ("flying"). */
export interface ModelThreat {
  nation: Player;
  bombs: Bomb[];
  why: "firing" | "soon" | "flying";
}

/**
 * The nations whose ladder names us on the rung that answers now
 * (NukeModel.exposures, not latent), with a silo (finished or not), and a
 * bomb they can pay for at its perceived price now or soon, as package
 * B3's nukeThreats picks them (EconomyController): a hydrogen bomb alone
 * once its gold covers that price (the type choice never falls back to
 * atoms, NNB :139-155); else an atom bomb if its gold covers it or its
 * gold projected o.nukeHorizon ticks ahead (NukeModel.projectedGold)
 * reaches o.nukePayShare of its perceived price, and a hydrogen bomb too
 * on the same test or if it fired one within o.nukeMemory ticks. Every
 * nation with a bomb in flight at our land is one too ("flying" if not
 * already), and the type in flight joins its bombs (a MIRV or a warhead
 * as an atom bomb). Round 2: firing threats alone (round 1) missed the shooter
 * between two launches, its gold just below the price each launch raises
 * (quick@20 Bering Strait g19, see the header).
 */
export function modelThreats(
  game: Game,
  nukes: NukeModel,
  o: Pick<GoldOptions, "nukePayShare" | "nukeMemory" | "nukeHorizon">,
  flying: readonly InFlight[] = [],
): ModelThreat[] {
  const config = game.config();
  const share = BigInt(Math.round(o.nukePayShare * 1000));
  const since = game.ticks() - o.nukeMemory;
  const soon = (N: Player, t: Bomb): boolean =>
    !config.isUnitDisabled(t) &&
    (nukes.projectedGold(N.id(), o.nukeHorizon) * 1000n >=
      nukes.perceivedCost(N.id(), t) * share ||
      (t === UnitType.HydrogenBomb &&
        o.nukeMemory > 0 &&
        nukes.hydroSince(N.id(), since)));
  const pick = (N: Player): Bomb[] => {
    const now = nukes.bombFor(N.id());
    if (now === UnitType.HydrogenBomb) return [now];
    const bombs: Bomb[] = [];
    if (now === UnitType.AtomBomb || soon(N, UnitType.AtomBomb)) {
      bombs.push(UnitType.AtomBomb);
    }
    if (soon(N, UnitType.HydrogenBomb)) bombs.push(UnitType.HydrogenBomb);
    return bombs;
  };
  const out: ModelThreat[] = [];
  for (const e of nukes.exposures()) {
    if (e.latent || !e.hasSilo) continue;
    const N = game.player(e.nation);
    const bombs = pick(N);
    if (bombs.length === 0) continue;
    const ready = N.units(UnitType.MissileSilo).some(
      (u) => !u.isUnderConstruction(),
    );
    const firing = ready && nukes.bombFor(N.id()) !== null;
    out.push({ nation: N, bombs, why: firing ? "firing" : "soon" });
  }
  for (const b of flying) {
    if (!b.atUs) continue;
    let t = out.find((x) => x.nation === b.owner);
    if (t === undefined) {
      t = { nation: b.owner, bombs: pick(b.owner), why: "flying" };
      out.push(t);
    }
    // A MIRV's warheads have an atom's reach or less.
    const type =
      b.type === UnitType.HydrogenBomb
        ? UnitType.HydrogenBomb
        : UnitType.AtomBomb;
    if (!t.bombs.includes(type)) t.bombs.push(type);
  }
  return out;
}

/**
 * Whether a hydrogen bomb may come our way (goldHydroCap binds then): a
 * silo owner whose nuke ladder names us, on the rung that answers now or a
 * lower one (NukeModel.exposures, latent included), holds at least
 * o.nukePayShare of its perceived hydrogen price (NukeModel.perceivedCost)
 * or launched a hydrogen bomb within o.nukeMemory ticks (package B3's
 * test of a hydrogen threat, EconomyController.nukeThreats). quick@20
 * (package WP8): an unconditional cap of 6 levels turned World g0's 27
 * levels, which no bomb came for and which deterred every nation attack,
 * into 4 (9.5% of the land at minute 20 against 0.2%), while it saved 4
 * levels and 11 points on Bering Strait, where Alaska's ladder named us.
 */
export function hydroThreat(
  game: Game,
  nukes: NukeModel,
  o: Pick<GoldOptions, "nukePayShare" | "nukeMemory">,
): boolean {
  const share = BigInt(Math.round(o.nukePayShare * 1000));
  const since = game.ticks() - o.nukeMemory;
  for (const e of nukes.exposures()) {
    if (!e.hasSilo) continue;
    const price = nukes.perceivedCost(e.nation, UnitType.HydrogenBomb);
    if (game.player(e.nation).gold() * 1000n >= price * share) return true;
    if (o.nukeMemory > 0 && nukes.hydroSince(e.nation, since)) return true;
  }
  return false;
}

/**
 * goldHydroCap: the most levels a city of ours at `tile` may reach so that
 * the cities one hydrogen bomb can take with it hold at most `cap` levels:
 * `cap` less the levels (unitCount's: 1 for a city under construction) of
 * our other cities within twice the bomb's outer radius
 * (config.nukeMagnitudes). A bomb deletes every unit strictly inside its
 * outer radius (NukeExecution.ts:467-483), so two cities it takes are
 * closer than twice that radius; aim points are scored by the structures
 * within the radius, so the nation picks the densest disk (NNB :706-804).
 * quick@20 Mississippi (package WP8, "free" before the cap): one hydrogen
 * bomb took 15 levels of cities 64 tiles apart.
 */
export function hydroRoom(
  game: Game,
  me: Player,
  tile: TileRef,
  cap: number,
  self?: Unit,
): number {
  const r = 2 * game.config().nukeMagnitudes(UnitType.HydrogenBomb).outer;
  let near = 0;
  for (const c of me.units(UnitType.City)) {
    if (c === self) continue;
    if (game.euclideanDistSquared(c.tile(), tile) < r * r) near += c.level();
  }
  return cap - near;
}

/**
 * The silo owners holding the atom's price that are not our allies
 * ("allied"): living nations with a silo, finished or under construction
 * (maybeSendNuke's first gate counts both, NNB :115-124), and the gold for
 * an atom bomb at its real price (the perceived one is never lower, NNB
 * :487-531). Nations friendly with us are left out, unless only two
 * players live, or our alliance ends within `lead` ticks (round 2: a city
 * outlives an alliance that lapses; the web asks the extension o.extendLead
 * ticks before the end, and a nation may refuse it).
 */
export function unalliedArmed(game: Game, me: Player, lead = 0): Player[] {
  const atom = game.config().unitInfo(UnitType.AtomBomb);
  // With two players left even an ally aims at us (NNB :224-233).
  const twoLeft = game.players().length === 2;
  const now = game.ticks();
  const out: Player[] = [];
  for (const p of game.players()) {
    if (p === me || p.type() !== PlayerType.Nation || !p.isAlive()) continue;
    if (!twoLeft && p.isFriendly(me)) {
      // A teammate has no alliance (friendly for good).
      const a = me.allianceWith(p);
      if (a === null || a.expiresAt() - now > lead) continue;
    }
    if (p.units(UnitType.MissileSilo).length === 0) continue;
    if (p.gold() >= atom.cost(game, p)) out.push(p);
  }
  return out;
}

/** Whether a finished SAM of ours covers `tile` (config.samRange of its
 *  level), as exposedSite exempts it. */
export function samCovered(game: Game, me: Player, tile: TileRef): boolean {
  const config = game.config();
  for (const sam of me.units(UnitType.SAMLauncher)) {
    if (sam.isUnderConstruction()) continue;
    const r = config.samRange(sam.level());
    if (game.euclideanDistSquared(sam.tile(), tile) <= r * r) return true;
  }
  return false;
}

/** The steamroll-stop rung by difficulty (NationMIRVBehavior :102-131):
 *  the City-level leader is a target above `min` levels and at `gap`
 *  times the runner-up's or more. */
const STEAMROLL: Record<Difficulty, { min: number; gap: number }> = {
  [Difficulty.Easy]: { min: 20, gap: 2 },
  [Difficulty.Medium]: { min: 10, gap: 1.5 },
  [Difficulty.Hard]: { min: 10, gap: 1.25 },
  [Difficulty.Impossible]: { min: 8, gap: 1.15 },
};

/**
 * The most City levels (unitCount, level-weighted, cities under
 * construction included, as NationMIRVBehavior.countCities counts them)
 * we can hold without becoming the MIRV steamroll target: at most `min`,
 * or below `gap` times the most any other living player holds (tribes
 * and nations count as the runner-up; the product is the nation's own
 * float). Infinity if MIRVs are disabled.
 */
export function steamrollLine(game: Game, me: Player): number {
  const config = game.config();
  if (config.isUnitDisabled(UnitType.MIRV)) return Infinity;
  const { min, gap } = STEAMROLL[config.gameConfig().difficulty];
  let runner = 0;
  for (const p of game.players()) {
    if (p === me || !p.isPlayer()) continue;
    runner = Math.max(runner, p.unitCount(UnitType.City));
  }
  // The target test is `levels >= runner * gap`: the largest integer
  // below the product is ceil(product) - 1.
  return Math.max(min, Math.ceil(runner * gap) - 1);
}

/** The dense-target rung (NNB :44-47, :328-349). */
const DENSE_LEVELS = 5;
const DENSE_SHARE = 1 / 75;

/**
 * The most City levels we can hold without making us the densest target:
 * our structure levels (every structure, SAMs and cities under
 * construction included, as findHighDensityTarget sums them) stay below
 * 5 or at most 1/75 of our tiles (its test is a strict >, in floats).
 */
export function densityLine(me: Player): number {
  const tiles = me.numTilesOwned();
  let other = 0;
  for (const u of me.units(Structures.types)) {
    if (u.type() !== UnitType.City) other += u.level();
  }
  const dense = (levels: number) =>
    levels >= DENSE_LEVELS && levels / tiles > DENSE_SHARE;
  let cities = Math.max(
    DENSE_LEVELS - 1 - other,
    Math.floor(tiles * DENSE_SHARE) - other + 1,
  );
  while (cities > 0 && dense(other + cities)) cities--;
  return cities;
}
