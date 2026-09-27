import { Game, Player, PlayerType } from "../../../core/game/Game";

// Package WP2 (docs/14-m4-plan.md §2.5): what a search reads from a rollout
// at a checkpoint, and the value it judges a plan by.
//
// V = tiles·(L0/Lh) + β·(home + out)/c̄ − α·inc/c̄ − λ_now·D_now − λ_cap·D_cap,
// −∞ if dead. L = numLandTiles − numTilesWithFallout (the win bar's
// denominator); the share factor L0/Lh is off unless o.searchShare (it
// matters for M5's own bombs; with it off V is the act3 prototype's value
// exactly). The danger terms come from a DangerModel (package WP4) and are
// 0 until λ > 0. Every field is read, never written: the game is a fork.

/** Our state in a rollout (or the live game) at `h` ticks after the fork. */
export interface Snap {
  h: number;
  tiles: number;
  /** me.troops(), rounded. */
  home: number;
  /** Troops of our attacks (not boats) in flight, rounded. */
  out: number;
  /** Troops of the non-tribe attacks on us, rounded. */
  inc: number;
  /** config.maxTroops(me), rounded. */
  cap: number;
  gold: number;
  alive: boolean;
  /** Nation (non-tribe) attacks that reached us since the fork, and their
   *  troops at first sight. */
  natAtks: number;
  natTroops: number;
  /** 1 + the living non-tribe players with more tiles than us. */
  rank: number;
  /** The most tiles any other living non-tribe player holds. */
  top: number;
}

/** A Snap with the win bar's land (numLandTiles − fallout) beside it, for
 *  the share factor. Kept out of Snap so the logged rows stay act3's. */
export interface LandSnap {
  snap: Snap;
  land: number;
}

/** Rank and the top other player's tiles (living non-tribes only). */
export function rankOf(game: Game, me: Player): { rank: number; top: number } {
  let rank = 1;
  let top = 0;
  const mine = me.numTilesOwned();
  for (const p of game.players()) {
    if (p === me || p.type() === PlayerType.Bot || !p.isAlive()) continue;
    const n = p.numTilesOwned();
    if (n > mine) rank++;
    if (n > top) top = n;
  }
  return { rank, top };
}

/** Our snap in `game` at `h` (the counts are the rollout's). */
export function snapOf(
  game: Game,
  me: Player,
  h: number,
  natAtks: number,
  natTroops: number,
): Snap {
  let out = 0;
  for (const a of me.outgoingAttacks()) out += a.troops();
  let inc = 0;
  for (const a of me.incomingAttacks()) {
    if (a.attacker().type() !== PlayerType.Bot) inc += a.troops();
  }
  const { rank, top } = rankOf(game, me);
  return {
    h,
    tiles: me.numTilesOwned(),
    home: Math.round(me.troops()),
    out: Math.round(out),
    inc: Math.round(inc),
    cap: Math.round(game.config().maxTroops(me)),
    gold: Number(me.gold()),
    alive: me.isAlive(),
    natAtks,
    natTroops: Math.round(natTroops),
    rank,
    top,
  };
}

/** The win bar's land: numLandTiles − the tiles with fallout. */
export function landOf(game: Game): number {
  return Math.max(0, game.numLandTiles() - game.numTilesWithFallout());
}

/** Expected tiles lost to one land attack by each unallied bordering
 *  nation (docs/14-m4-plan.md §2.5): now, and with both sides at their
 *  caps. Package WP4's DangerModel computes them. */
export interface Danger {
  now: number;
  cap: number;
}

/** Package WP4's hook: the danger terms of `me` in `game` (a fork at a
 *  judged horizon). Registered with the search registry. */
export type DangerModel = (game: Game, me: Player) => Danger;

export interface ValueParams {
  /** c̄: troops per tile. */
  cbar: number;
  beta: number;
  alpha: number;
  /** λ_now, λ_cap: weights of the danger terms. */
  dangerNow: number;
  dangerCap: number;
  /** The share factor L0/Lh on the tiles. */
  share: boolean;
}

/**
 * V of a snap. `land0`/`land` are the win bar's land at the fork and at
 * the snap (used with p.share); `danger` the terms at the snap (used when
 * a λ is set; null counts 0).
 */
export function value(
  s: Snap,
  p: ValueParams,
  land0 = 0,
  land = 0,
  danger: Danger | null = null,
): number {
  if (!s.alive) return -Infinity;
  const c = p.cbar > 0 ? p.cbar : 1;
  const tiles =
    p.share && land > 0 && land0 > 0 && land !== land0
      ? (s.tiles * land0) / land
      : s.tiles;
  let v = tiles + (p.beta * (s.home + s.out)) / c - (p.alpha * s.inc) / c;
  if (danger !== null) {
    if (p.dangerNow !== 0) v -= p.dangerNow * danger.now;
    if (p.dangerCap !== 0) v -= p.dangerCap * danger.cap;
  }
  return v;
}

/** The margin a plan must beat the base's value by to be played:
 *  max(margin·tiles, marginAbs) (§2.5), with `tiles` ours at the search. */
export function actMargin(
  tiles: number,
  margin: number,
  marginAbs: number,
): number {
  return Math.max(marginAbs, margin * tiles);
}
