import {
  Game,
  Player,
  PlayerID,
  PlayerType,
  UnitType,
} from "../../../../core/game/Game";
import type { TileRef } from "../../../../core/game/GameMap";
import { ParabolaUniversalPathFinder } from "../../../../core/pathfinding/PathFinder.Parabola";
import type { ApexOptions } from "../../../agents/apex/options";

// Package WP10n round 2 (review findings F2, F3, F4): the live, stateful
// side of the nuke candidates — the observed income of each nation (so the
// MIRV-threat trigger T8 has a real warning lead, not the 100-gold/tick
// passive rate F2 found), and the SAM cover along a bomb's whole flight
// (F4). Only the live SearchController holds a NukeWatch and only it calls
// update(); a rollout copy never does (the triggers do not run in rollouts),
// so nothing here rides in a fork and no fidelity is at stake. Every method
// is a deterministic function of the game state and the samples taken on
// earlier live ticks (no wall time, no Math.random).

/** One nation's gold-income samples: goldEarned() is cumulative and never
 *  falls (PlayerImpl.addGold), so a delta over a window is its gross income,
 *  immune to what it spends. */
interface Sample {
  t: number;
  earned: bigint;
}

/** The MIRV price now: 25M + 15M × MIRVs launched, game-wide (Config); the
 *  player only matters for a human's infinite gold. */
export function mirvPrice(game: Game, me: Player): bigint {
  return game.unitInfo(UnitType.MIRV).cost(game, me);
}

/** A nation's ticks until it can pay `price` at its observed income
 *  (Infinity if it earns nothing); 0 if it can already pay. */
export interface ThreatTerm {
  id: PlayerID;
  price: bigint;
  ticksToPrice: number;
  income: bigint;
}

/**
 * Tracks each living nation's gross income from its goldEarned() history, so
 * T8 can fire on ticks-to-price rather than on a near-zero passive lead
 * (review F2). Kept by the live SearchController, updated once per live tick.
 */
export class NukeWatch {
  /** nation id -> its samples, oldest first (ring, capped). */
  private readonly hist = new Map<PlayerID, Sample[]>();
  /** Ticks the income window spans (about a minute at 10 ticks/second). */
  private readonly window: number;
  private readonly maxSamples = 64;

  constructor(window = 600) {
    this.window = Math.max(1, window);
  }

  /** Records this tick's goldEarned for every living non-tribe player other
   *  than us and drops the dead. Deterministic. */
  sample(game: Game, me: Player, t: number): void {
    const live = new Set<PlayerID>();
    for (const p of game.players()) {
      if (p === me || !p.isPlayer() || p.type() === PlayerType.Bot) continue;
      if (!p.isAlive()) continue;
      const id = p.id();
      live.add(id);
      const arr = this.hist.get(id) ?? [];
      arr.push({ t, earned: p.goldEarned() });
      // Drop samples older than the window (keep one before it for the rate).
      let cut = 0;
      while (cut < arr.length - 1 && arr[cut + 1].t <= t - this.window) cut++;
      const trimmed = cut > 0 ? arr.slice(cut) : arr;
      if (trimmed.length > this.maxSamples) {
        trimmed.splice(0, trimmed.length - this.maxSamples);
      }
      this.hist.set(id, trimmed);
    }
    for (const id of [...this.hist.keys()]) {
      if (!live.has(id)) this.hist.delete(id);
    }
  }

  /** `id`'s observed gross income per tick (0 with too little history). */
  income(id: PlayerID): bigint {
    const arr = this.hist.get(id);
    if (arr === undefined || arr.length < 2) return 0n;
    const a = arr[0];
    const b = arr[arr.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0) return 0n;
    const d = b.earned - a.earned;
    return d <= 0n ? 0n : d / BigInt(dt);
  }

  /** `id`'s ticks until it can pay `price` at its observed income. */
  ticksToPrice(game: Game, id: PlayerID, price: bigint): number {
    if (!game.hasPlayer(id)) return Infinity;
    const gold = game.player(id).gold();
    if (gold >= price) return 0;
    const inc = this.income(id);
    if (inc <= 0n) return Infinity;
    return Math.ceil(Number(price - gold) / Number(inc));
  }
}

/** Living non-tribe players other than us and our team. */
export function rivals(game: Game, me: Player): Player[] {
  return game
    .players()
    .filter(
      (p) =>
        p !== me &&
        p.isPlayer() &&
        p.type() !== PlayerType.Bot &&
        p.isAlive() &&
        !me.isOnSameTeam(p),
    );
}

/**
 * The parabola trajectory a bomb of `nukeSpeed` follows from `src` to `dst`,
 * as the game computes it (NukeExecution.getTrajectory uses the same
 * ParabolaUniversalPathFinder). Read only: it builds its own pathfinder on
 * the game's map and never touches the game. Used to size a denial salvo
 * against every SAM that could intercept the flight, not only the aim tile
 * (review F4).
 */
export function flightTiles(
  game: Game,
  src: TileRef,
  dst: TileRef,
  nukeSpeed: number,
): TileRef[] {
  const finder = new ParabolaUniversalPathFinder(
    game.map(),
    { increment: nukeSpeed },
  );
  return finder.findPath(src, dst) ?? [dst];
}

/**
 * The summed levels of the SAMs of `owners` that could intercept a bomb
 * flying `path` (review F4): a SAM intercepts on the part of the flight
 * within the nuke-targetable range of either end (defaultNukeTargetableRange,
 * SAMLauncherExecution/NukeExecution.isTargetable), so a SAM whose range
 * reaches any such tile can shoot the bomb down. A salvo of that + 1
 * overwhelms them in one tick (two bombs beat a level-1 SAM; SiloStrike). We
 * over-count rather than under-count: a SAM that could reach the flight is
 * treated as firing.
 */
export function samLevelsOnPath(
  game: Game,
  owners: ReadonlySet<PlayerID>,
  path: readonly TileRef[],
  src: TileRef,
  dst: TileRef,
): number {
  if (owners.size === 0 || path.length === 0) return 0;
  const targetable = game.config().defaultNukeTargetableRange();
  const tr2 = targetable * targetable;
  // The tiles a SAM may intercept: those within `targetable` of src or dst.
  const flight = path.filter(
    (tile) =>
      game.euclideanDistSquared(tile, src) < tr2 ||
      game.euclideanDistSquared(tile, dst) < tr2,
  );
  const tiles = flight.length > 0 ? flight : [dst];
  let levels = 0;
  for (const id of owners) {
    if (!game.hasPlayer(id)) continue;
    const p = game.player(id);
    for (const s of p.units(UnitType.SAMLauncher)) {
      if (s.isUnderConstruction()) continue;
      const r = game.config().samRange(s.level());
      const r2 = r * r;
      const covers = tiles.some(
        (tile) => game.euclideanDistSquared(s.tile(), tile) <= r2,
      );
      if (covers) levels += s.level();
    }
  }
  return levels;
}

/**
 * The players whose relations a bomb aimed at `dst` will turn hostile at
 * launch (review F4), so their SAMs will then fire at it too: the tile's
 * owner (we are aiming at a nation's silo — its own SAM fires even when it
 * is our ally now, because the launch breaks that alliance), every player
 * with a structure inside the blast (listNukeBreakAlliance's structure
 * rule), and — as they are hostile already — every player not friendly to us.
 * Computed from read-only game queries (no core execution import), matching
 * the structure rule exactly and skipping only the rare tile-count-only
 * break of a player with no structure in the blast.
 */
export function hostileAfterLaunch(
  game: Game,
  me: Player,
  dst: TileRef,
  outer: number,
): Set<PlayerID> {
  const out = new Set<PlayerID>();
  // Already hostile: every living non-friendly player with a SAM.
  for (const p of game.players()) {
    if (!p.isPlayer() || p === me || !p.isAlive()) continue;
    if (!me.isFriendly(p)) out.add(p.id());
  }
  // The tile's owner (the launch breaks our alliance with it).
  if (game.hasOwner(dst)) {
    const owner = game.owner(dst);
    if (owner.isPlayer() && owner !== me) out.add(owner.id());
  }
  // Any player with a structure in the blast is turned hostile.
  for (const { unit } of game.nearbyUnits(dst, outer, [
    UnitType.MissileSilo,
    UnitType.SAMLauncher,
    UnitType.City,
    UnitType.Port,
    UnitType.DefensePost,
    UnitType.Factory,
  ])) {
    const owner = unit.owner();
    if (owner.isPlayer() && owner !== me) out.add(owner.id());
  }
  return out;
}
