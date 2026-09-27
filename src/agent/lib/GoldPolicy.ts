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
// - "model": no level at a site a FIRING nation can aim at: NukeModel's
//   ladder replica names us on the rung that answers now, the nation owns
//   a finished silo and the gold for the bomb it would pick (bombFor), and
//   that bomb has an aim point at the site (nukeable: both rings clear, no
//   SAM reaching it). A latent ladder (we are named below the rung that
//   answers now) does not refuse.
// - "allied": no level while a silo owner (a silo finished or started)
//   holding the atom's price is not our ally, unless a finished SAM of
//   ours covers the site, since allies never aim at us. With two players
//   left an ally does aim at us, so none is exempt. Unlike exposedSite's
//   wide rule, gold for a silo and a bomb without a silo does not count.
// - "free": no nuke gate (citySpread and cityMaxLevel still hold).
// An arm's buys spend only the gold above goldReserve; with goldGuard they
// never cross the MIRV steamroll line or the line of the richest nation's
// dense-target rung (> 1/75 structure levels a tile, at least 5 levels,
// NNB :318-349); with goldHydroCap, while a hydrogen threat names us
// (hydroThreat), they keep the City levels one hydrogen bomb can take at
// most that many (hydroRoom). Today's buys keep today's rule.
//
// Pure in the game: only getters (and NukeModel.exposures, which samples
// the silo owners' gold as every call does); no ctx.random, no state of its
// own, so a rollout copy decides as the live policy does.

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
  /** Package B3's knobs, read by the hydrogen threat (hydroThreat). */
  nukePayShare: number;
  nukeMemory: number;
}

/** The gold arm's gate on one city check (EconomyController.planCity). */
export interface CityGate {
  arm: Exclude<GoldPolicyArm, "exposure">;
  /** Gold the check may spend: ours less goldReserve (negative if short). */
  budget: bigint;
  /** City levels we may hold after the buy, as unitCount(City) counts
   *  them (levels of finished cities, 1 per city under construction);
   *  Infinity without goldGuard. */
  maxLevels: number;
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
  const base = { budget, maxLevels, cityRoom };
  switch (o.goldPolicy) {
    case "free":
      return { ...base, arm: "free", allows: () => true, blockers: [] };
    case "allied": {
      const armed = unalliedArmed(game, me);
      return {
        ...base,
        arm: "allied",
        allows: (t) => armed.length === 0 || samCovered(game, me, t),
        blockers: armed.map((p) => p.name()),
      };
    }
    case "model": {
      if (nukes === undefined) return null;
      const firing = firingThreats(game, nukes);
      return {
        ...base,
        arm: "model",
        allows: (t) =>
          firing.every((f) => !nukes.nukeable([t], f.bomb, f.nation)),
        blockers: firing.map(
          (f) =>
            `${f.nation.name()}:${f.bomb === UnitType.HydrogenBomb ? "H" : "A"}`,
        ),
      };
    }
  }
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
 * players live.
 */
export function unalliedArmed(game: Game, me: Player): Player[] {
  const atom = game.config().unitInfo(UnitType.AtomBomb);
  // With two players left even an ally aims at us (NNB :224-233).
  const twoLeft = game.players().length === 2;
  const out: Player[] = [];
  for (const p of game.players()) {
    if (p === me || p.type() !== PlayerType.Nation || !p.isAlive()) continue;
    if (!twoLeft && p.isFriendly(me)) continue;
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

/** A nation that would fire at a structure of ours at its next decision
 *  ("model"), and the bomb it would pick. */
export interface FiringThreat {
  nation: Player;
  bomb: Bomb;
}

/**
 * The nations whose ladder names us on the rung that answers now
 * (NukeModel.exposures, not latent), with a finished silo and the gold for
 * the bomb they would pick at its perceived price (NukeModel.bombFor).
 */
export function firingThreats(game: Game, nukes: NukeModel): FiringThreat[] {
  const out: FiringThreat[] = [];
  for (const e of nukes.exposures()) {
    if (e.latent || !e.hasSilo) continue;
    const N = game.player(e.nation);
    if (!N.units(UnitType.MissileSilo).some((u) => !u.isUnderConstruction())) {
      continue;
    }
    const bomb = nukes.bombFor(e.nation);
    if (bomb !== null) out.push({ nation: N, bomb });
  }
  return out;
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
