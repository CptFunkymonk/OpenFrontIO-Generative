import {
  Difficulty,
  Game,
  GameMode,
  Player,
  PlayerID,
  PlayerType,
  TerrainType,
} from "../../../core/game/Game";
import { createModels, Models } from "../Models";
import { nationParams } from "../NationModel";
import { scanWorld, WorldModel } from "../WorldModel";
import type { Danger, DangerModel } from "./Value";

// Package WP4 (docs/14-m4-plan.md §2.5): the danger terms of the search's
// value. Each is the tiles we expect to lose to one land attack by every
// unallied bordering nation N, sized the way the nation AI sizes a land
// attack on a player (AiAttackBehavior.ts):
//
//   S_N = min(T_N − r_N·M_N, T_N − ⌈retain·H⌉),  counted if S_N ≥ max(1, 0.2·H)
//   p_N = models.hit({Nation, n_N}, {us, n_us, H, me.isTraitor()}, S_N,
//                    Plains, border).attackerTroopLoss
//   D   = Σ_N S_N / p_N
//
// - D_now reads the state as it is (a rollout at its judged horizon): T_N,
//   H = me.troops().
// - D_cap is the same with both sides at their caps, T_N = M_N and
//   H = C = maxTroops(me): the steady-state exposure to a nation that
//   outgrows us.
//
// Where each piece comes from:
// - r_N·M_N: the land send is T − reserveRatio·maxTroops
//   (calculateAttackTroops, :1041-1054, :1099-1102). r_N is the nation's
//   reserve, replayed from the gameID (NationModel.nationParams); unknown
//   (no gameID) it is 0.30, NationModel's worst case (the most it can send).
// - ⌈retain·H⌉: troopSendCap keeps ⌈retain·(strongest unfriendly non-tribe
//   nearby troops)⌉, retain 0.9 at Impossible and 0.75 at Hard, no cap at
//   Easy, Medium or in team games (:986-1032). The terms read our H as that
//   neighbour (plan §2.5): a third player can only lower the send.
// - 0.2·H: isAttackTooWeak refuses a send under 0.2 of the target's troops,
//   at Hard and Impossible in FFA (:961-973); and no send under 1 troop
//   (:1076). A nation under attack is exempt from both and can send
//   max(cap, incoming): the terms ignore that (plan §2.5).
// - p_N: the price of the attack's first tile, attackLogic through
//   Models.hit. Traitors defend at half the loss (traitorDefenseDebuff), so
//   me.isTraitor() halves p_N and doubles D. The loss does not depend on
//   the border (Config.attackLogic); it is passed as contact + 2 by the
//   Models convention.
//
// "Bordering" is a land contact (WorldModel's scan: our border tile next to
// its passable land tile), at least minContact pairs; "unallied" is
// !me.isFriendly(N). Only PlayerType.Nation counts: the formulas are the
// nation AI's.
//
// Read-only: the game is only read (scanWorld's contract). No Math.random,
// no clocks: the same state gives the same terms.

/** NationModel's worst-case reserve when a nation's parameters are
 *  unknown (defaultParams: the lowest reserve sends the most). */
export const DEFAULT_RESERVE = 0.3;

/** troopSendCap's retainFraction by difficulty (AiAttackBehavior.ts:
 *  992-1000); absent: no cap. */
const RETAIN: Partial<Record<Difficulty, number>> = {
  [Difficulty.Hard]: 0.75,
  [Difficulty.Impossible]: 0.9,
};

/** isAttackTooWeak (AiAttackBehavior.ts:961-973): a send under this share
 *  of the target's troops is refused (Hard and Impossible, FFA). */
const TOO_WEAK_SHARE = 0.2;

/** The nation AI's land-send rules in one game (difficulty and mode). */
export interface SendRules {
  /** troopSendCap's retain share of our troops; null: no cap. */
  retain: number | null;
  /** isAttackTooWeak's share; 0: off. */
  tooWeak: number;
}

/** The send rules of `game` (troopSendCap and isAttackTooWeak are off in
 *  team games and below Hard). */
export function sendRules(game: Game): SendRules {
  const gc = game.config().gameConfig();
  if (gc.gameMode === GameMode.Team) return { retain: null, tooWeak: 0 };
  const retain = RETAIN[gc.difficulty];
  if (retain === undefined) return { retain: null, tooWeak: 0 };
  return { retain, tooWeak: TOO_WEAK_SHARE };
}

/**
 * S: the troops a nation with `T` troops, cap `M` and reserve `r` sends at
 * us by land while we hold `H` at home, or 0 when it cannot (under 1
 * troop, or under the too-weak share of H).
 */
export function nationSend(
  T: number,
  M: number,
  r: number,
  H: number,
  rules: SendRules,
): number {
  const land = T - r * M;
  const cap =
    rules.retain === null ? Infinity : T - Math.ceil(rules.retain * H);
  const S = Math.min(land, cap);
  if (!(S >= 1)) return 0;
  if (S < rules.tooWeak * H) return 0;
  return S;
}

export interface DangerOptions {
  /** Contact pairs for a nation to count as bordering (default 1). */
  minContact?: number;
  /** "plains" (plan §2.5, default) or "mix": price p_N over the terrain of
   *  the nation's contact tiles (Models.hitMix). */
  terrain?: "plains" | "mix";
  /** Cap each nation's term at our tiles (default false: plan §2.5 has no
   *  cap, so an overwhelming nation can count more tiles than we own). */
  clampTiles?: boolean;
}

/** One unallied bordering nation's terms. */
export interface DangerRow {
  id: PlayerID;
  contact: number;
  /** Its troops, cap, tiles and reserve. */
  T: number;
  M: number;
  n: number;
  r: number;
  /** Now: the send (0 = deterred), the price per tile, the tiles. */
  sNow: number;
  pNow: number;
  dNow: number;
  /** At both caps. */
  sCap: number;
  pCap: number;
  dCap: number;
}

/** The terms with what they were computed from. */
export interface DangerTerms extends Danger {
  /** Our home troops, cap, tiles and traitor flag. */
  H: number;
  C: number;
  tiles: number;
  traitor: boolean;
  /** Unallied bordering nations, ascending smallID. */
  rows: DangerRow[];
}

/** A nation's reserve share of its cap, or undefined when unknown. */
export type ReserveOf = (id: PlayerID) => number | undefined;

/**
 * The danger terms of `me` in `game` (a rollout at a judged horizon, or
 * the live game). `wm` is a scan of this state, if the caller has one.
 */
export function dangerTerms(
  game: Game,
  me: Player,
  models: Models,
  reserveOf: ReserveOf,
  opts: DangerOptions = {},
  wm: WorldModel | null = null,
): DangerTerms {
  const minContact = opts.minContact ?? 1;
  const mix = opts.terrain === "mix";
  const clamp = opts.clampTiles ?? false;
  const rules = sendRules(game);
  const H = me.troops();
  const C = models.cap(me);
  const tiles = me.numTilesOwned();
  const traitor = me.isTraitor();
  const type = me.type();
  const scan = wm ?? scanWorld(game, me, null);
  const rows: DangerRow[] = [];
  let now = 0;
  let cap = 0;
  // Tiles of `S` troops at `p` per tile, capped at ours when asked.
  const lost = (S: number, p: number) => {
    if (S <= 0 || !(p > 0)) return 0;
    const d = S / p;
    return clamp ? Math.min(d, tiles) : d;
  };
  for (const nb of scan.nations) {
    if (nb.type !== PlayerType.Nation || nb.contact < minContact) continue;
    const N = game.player(nb.id);
    if (!N.isAlive() || me.isFriendly(N)) continue;
    const T = N.troops();
    const M = models.cap(N);
    const n = N.numTilesOwned();
    const r = reserveOf(nb.id) ?? DEFAULT_RESERVE;
    const border = nb.contact + 2;
    const price = (S: number, troops: number) => {
      if (S <= 0) return 0;
      const def = { type, tiles, troops, isTraitor: traitor };
      const att = { type: PlayerType.Nation, tiles: n };
      return mix
        ? models.hitMix(att, def, S, nb.contactMix, border).loss
        : models.hit(att, def, S, TerrainType.Plains, border).attackerTroopLoss;
    };
    const sNow = nationSend(T, M, r, H, rules);
    const pNow = price(sNow, H);
    const sCap = nationSend(M, M, r, C, rules);
    const pCap = price(sCap, C);
    const dNow = lost(sNow, pNow);
    const dCap = lost(sCap, pCap);
    now += dNow;
    cap += dCap;
    rows.push({
      id: nb.id,
      contact: nb.contact,
      T,
      M,
      n,
      r,
      sNow,
      pNow,
      dNow,
      sCap,
      pCap,
      dCap,
    });
  }
  return { now, cap, H, C, tiles, traitor, rows };
}

/**
 * The search's DangerModel (Value.ts): D_now and D_cap of `me` in any fork
 * of this game. Reserves come from `reserveOf` if given (a NationModel's
 * params), else are replayed from `gameID` (nationParams, exact), else are
 * DEFAULT_RESERVE. Kept across calls: the replayed reserves (fixed for the
 * game) and one Models per game object (a fork is its own game); the terms
 * themselves are computed afresh from the state each call.
 */
export function createDangerModel(
  src: { gameID?: string | null; reserveOf?: ReserveOf },
  opts: DangerOptions = {},
): DangerModel {
  const models = new WeakMap<Game, Models>();
  const reserves = new Map<PlayerID, number>();
  const replayed = (game: Game): ReserveOf => {
    const gameID = src.gameID ?? null;
    if (gameID === null) return () => undefined;
    const d = game.config().gameConfig().difficulty;
    return (id) => {
      let r = reserves.get(id);
      if (r === undefined) {
        r = nationParams(gameID, id, d).reserve;
        reserves.set(id, r);
      }
      return r;
    };
  };
  return (game: Game, me: Player): Danger => {
    let m = models.get(game);
    if (m === undefined) {
      m = createModels(game);
      models.set(game, m);
    }
    const t = dangerTerms(game, me, m, src.reserveOf ?? replayed(game), opts);
    return { now: t.now, cap: t.cap };
  };
}
