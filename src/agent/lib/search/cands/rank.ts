import { Difficulty, Player, PlayerType } from "../../../../core/game/Game";
import { finishedCityLevels } from "../../../agents/apex/controllers/EconomyController";
import { KILL_FREE } from "../../../agents/apex/controllers/ExpansionController";
import {
  reachableTiles,
  strikeLoss,
} from "../../../agents/apex/controllers/StrikeController";
import { SEARCH_RANKS, SearchRank } from "../../../agents/apex/options";
import type { TerrainMix } from "../../Models";
import { nationParams } from "../../NationModel";
import { retaliationBound, strikeYield } from "../../StrikeWindows";
import type { NeighborInfo } from "../../WorldModel";
import type {
  BaseView,
  Candidate,
  CandidateGenerator,
  SearchView,
} from "../Registry";
import { CORE } from "./core";

// Package WP3 (docs/14-m4-plan.md §2.4, §3 WP3 `rank`, §9 Q6 of search.md):
// the prior that picks the searchK nations the core gives strike and break
// plans. WP2's core takes them by contact (act3's rule). With searchRank set
// the core runs unchanged on a view of the scan whose bordering nations are
// ordered by one of three analytic priors, best first:
// - "prey", the predator's prey score: the kill cost per tile of the
//   nation, (n − 99)·(22.2 + 0.187·d)·1.1 + the answer bound + 0.2·T, over
//   n tiles (the last 99 fall with the one that takes it under 100; d = T/n;
//   22.2 + 0.187·d is attackLogic's loss per tile at the cheapest ratio,
//   80·0.6·(0.463 + 0.0039·d); ×1.1 for terrain), times (1 + τ/150) with
//   τ = n/(0.63·contact), the ticks a front that wide takes to eat it.
//   Lowest first.
// - "yield", A1's strikeYield for a stack of the whole strike purse, as the
//   window strikes value a launch (StrikeController.windowStrikes): the
//   answer T − reserve·M cancels first, the rest pays attackLogic's loss per
//   tile at its ratio over the contact terrain, a kill takes the nation's
//   gold, and value/troop = (tiles + gold/strikeGoldPerTile)/spent. Highest
//   first.
// - "killsim", a port of the predator's killsim.py (a 600-tick aggregate of
//   one land strike of the purse, topped up by our regrowth: the answers at
//   each decision, defense posts from the nation's gold, the territory
//   bonuses, the nation's regrowth): tiles taken per troop lost. Highest
//   first.
// The view gives each ranked nation a contact past searchMinContact in its
// rank order, so the core's filter passes it and its sort follows the rank
// (its only reads of contact); nations the core would not have seen
// (contact below the minimum and no attack on us in the base) are left out.
// Ties: contact, then ascending smallID. "contact" is the core itself.

/** The modes of searchRank (options.ts SEARCH_RANKS: parseApexOptions
 *  refuses any other at construction; rankMode below is the backstop). */
export const RANK_MODES: readonly SearchRank[] = SEARCH_RANKS;
export type RankMode = SearchRank;

/** The prey score's terms: the cheapest loss per tile at defender density
 *  d is PREY_BASE + PREY_DENSITY·d, times PREY_TERRAIN. */
export const PREY_BASE = 22.2;
export const PREY_DENSITY = 0.187;
export const PREY_TERRAIN = 1.1;
/** Tiles a tick per contact pair of the front (τ = n/(0.63·contact)),
 *  and the ticks τ is weighed against. */
export const PREY_FRONT = 0.63;
export const PREY_TICKS = 150;
/** killsim's horizon. */
export const KILLSIM_TICKS = 600;

/** A nation as the priors read it. */
export interface PreyInput {
  /** Tiles, troops, cap. */
  n: number;
  T: number;
  M: number;
  /** Its reserve ratio (NationModel params). */
  reserve: number;
  /** Contact pairs with us. */
  contact: number;
}

/** The prey score (lower is a cheaper prey); Infinity without contact. */
export function preyScore(x: PreyInput): number {
  if (!(x.contact > 0) || !(x.n > 0)) return Infinity;
  const d = x.T / x.n;
  const answer = retaliationBound(x.T, x.reserve, x.M);
  const cost =
    Math.max(0, x.n - KILL_FREE) *
      (PREY_BASE + PREY_DENSITY * d) *
      PREY_TERRAIN +
    answer +
    0.2 * x.T;
  const tau = x.n / (PREY_FRONT * x.contact);
  return (cost / x.n) * (1 + tau / PREY_TICKS);
}

// ── killsim.py, ported (/tmp/claude-0/growth/ana/killsim.py) ────────────

/** One strike of ours on a nation, as killsim.sim models it. */
export interface KillsimInput {
  /** The prey: tiles, troops, finished city levels, border tiles of the
   *  front (our contact), gold (its defense posts), reserve and trigger. */
  n: number;
  T: number;
  L: number;
  b: number;
  gold: number;
  reserve: number;
  trigger: number;
  /** Its decision rate, and the ticks to its first decision after the
   *  launch (killsim's default: rate − 1). */
  rate: number;
  firstDecision?: number;
  /** Our launch stack, troops added to it each tick (top-ups from our
   *  regrowth), our tiles, and our home after the launch (its answer's
   *  0.9·H term). */
  S0: number;
  flow: number;
  usTiles: number;
  H: number;
  /** attackLogic's terrain factor on the loss and the tile cost (plains 1,
   *  highland 1.25, mountain 1.5). */
  terr: number;
  /** Default KILLSIM_TICKS. */
  maxTicks?: number;
}

export interface KillsimResult {
  killed: boolean;
  /** Tiles taken, and our troops lost. */
  tiles: number;
  lost: number;
  ticks: number;
}

const within = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));

/** killsim's territory bonus: 1 − depth·σ(2.5·(ln n − ln 300,000)). */
export function territoryBonus(n: number, depth: number): number {
  const s =
    1 / (1 + Math.exp(-2.5 * (Math.log(Math.max(n, 1)) - Math.log(300_000))));
  return 1 - depth * s;
}

/** An Impossible nation's cap on n tiles with L city levels. */
export function nationCap(n: number, L: number): number {
  return 1.25 * (2 * (Math.max(n, 0) ** 0.6 * 1000 + 50_000) + 250_000 * L);
}

/** Troop regrowth a tick at T of cap M (×mult). */
export function regrowth(T: number, M: number, mult = 1): number {
  if (T >= M) return 0;
  return mult * (10 + T ** 0.73 / 4) * (1 - T / M);
}

/**
 * killsim.sim with its defaults (answers in expectation below the
 * trigger, defense posts on, no front growth): the strike tick by tick.
 */
export function killsim(x: KillsimInput): KillsimResult {
  const maxTicks = x.maxTicks ?? KILLSIM_TICKS;
  let S = x.S0;
  let D = x.T;
  let n = x.n;
  let lost = 0;
  let gained = 0;
  let gold = x.gold;
  let nextDec = x.firstDecision ?? x.rate - 1;
  const posts: number[] = [];
  let postCost = 50_000;
  const bb = Math.max(1, x.b);
  for (let t = 1; t <= maxTicks; t++) {
    const M = nationCap(n, x.L);
    // Defense posts, ordered at a third of its rate while our stack holds
    // 0.35 of its troops, one per 0.4 of the ratio.
    if (t % Math.max(1, Math.floor(x.rate / 3)) === 0) {
      const ratio = S / Math.max(1, D);
      const allowed = ratio >= 0.35 ? Math.ceil(ratio / 0.4) : 0;
      if (posts.length < allowed && gold >= postCost) {
        gold -= postCost;
        postCost = Math.min(250_000, postCost + 50_000);
        posts.push(t + 50 + 2);
      }
    }
    let done = 0;
    for (const f of posts) if (f <= t) done++;
    const cover = Math.min(1, (done * 60) / bb);
    // Its answer at each decision (in expectation below its trigger).
    if (t === nextDec) {
      nextDec += x.rate;
      if (D >= x.reserve * M) {
        let A = Math.min(D - x.reserve * M, Math.max(D - 0.9 * x.H, S));
        A *= D >= x.trigger * M ? 1 : 0.1;
        if (A > 0) {
          if (A >= S) {
            // The answer takes the whole stack: the strike is over.
            return { killed: false, tiles: gained, lost: lost + S, ticks: t };
          }
          S -= A;
          D -= A;
          lost += A;
        }
      }
    }
    // Conquest this tick.
    const r = D / Math.max(1, S);
    const speedCost = (within(r, 0.82, 7.5) * within(r / 20, 1, 50)) / 8.55;
    const bA = territoryBonus(x.usTiles + gained, 0.73);
    const bD = territoryBonus(n, 0.3);
    const perTileFrac = (speedCost * 16.5 * x.terr * bA * bD) / bb;
    const eff = 1 - cover + cover / 3;
    let k = Math.max(1, eff / perTileFrac);
    k = Math.min(k, n > KILL_FREE ? n - KILL_FREE : 1);
    const d = D / Math.max(1, n);
    const pA =
      80 *
      x.terr *
      within(r, 0.6, 2) *
      (0.463 * territoryBonus(x.usTiles + gained, 0.7) * bD + 0.0039 * d);
    const posted = eff > 0 ? cover / 3 / eff : 0;
    const pEff = pA * (1 - posted + 5 * posted);
    let need = k * pEff;
    if (need > S) {
      k = S / pEff;
      need = S;
    }
    S -= need;
    lost += need;
    D -= k * d;
    n -= k;
    gained += k;
    D += regrowth(D, nationCap(n, x.L), 1.05);
    S += x.flow;
    if (n <= KILL_FREE) {
      return { killed: true, tiles: gained + n, lost, ticks: t };
    }
    if (S < 1) return { killed: false, tiles: gained, lost, ticks: t };
  }
  return { killed: false, tiles: gained, lost, ticks: maxTicks };
}

/** attackLogic's terrain factor of a contact mix (plains 1, highland
 *  100/80, mountain 120/80), killsim's `terr`. */
export function terrainFactor(mix: TerrainMix): number {
  const total = mix.plains + mix.highland + mix.mountain;
  if (total <= 0) return 1;
  return (mix.plains + 1.25 * mix.highland + 1.5 * mix.mountain) / total;
}

// ── The live ranking ───────────────────────────────────────────────────

/** Score of one bordering nation by `mode`, higher is better (the prey
 *  score negated). */
export function rankScore(
  sv: SearchView,
  info: NeighborInfo,
  N: Player,
  mode: Exclude<RankMode, "contact">,
): number {
  const { game, me, ctx } = sv;
  const cfg = game.config();
  const M = cfg.maxTroops(N);
  const T = N.troops();
  const n = N.numTilesOwned();
  const params = nationParams(
    ctx.gameID,
    N.id(),
    cfg.gameConfig().difficulty ?? Difficulty.Impossible,
  );
  if (mode === "prey") {
    return -preyScore({
      n,
      T,
      M,
      reserve: params.reserve,
      contact: info.contact,
    });
  }
  const S = sv.host.available("strike");
  if (!(S > 0)) return -Infinity;
  let inc = 0;
  for (const a of me.incomingAttacks())
    if (a.attacker() === N) inc += a.troops();
  if (mode === "killsim") {
    const home = me.troops();
    const cap = cfg.maxTroops(me);
    const H = Math.max(0, home - S);
    const r = killsim({
      n,
      T,
      L: finishedCityLevels(N),
      b: info.contact,
      gold: Number(N.gold()),
      reserve: params.reserve,
      trigger: params.trigger,
      rate: params.rate,
      S0: Math.max(0, S - inc),
      flow: regrowth(H, cap),
      usTiles: me.numTilesOwned(),
      H,
      terr: terrainFactor(info.contactMix),
    });
    return r.lost > 0 ? r.tiles / r.lost : 0;
  }
  // "yield": A1's value per troop of the whole purse (windowStrikes'
  // strikeReachModel valuation, the answer assumed for certain).
  const models = sv.host.models();
  if (models === null) return -Infinity;
  const answer = retaliationBound(T, params.reserve, M);
  const left = S - answer - inc;
  if (!(left > 0)) return -Infinity;
  const p = strikeLoss({ models, wm: sv.wm }, N, info, T - answer, left);
  const reach = reachableTiles(game, me, N);
  const y = strikeYield(S, left, p, n, reach, KILL_FREE, inc + answer);
  const value =
    y.tiles +
    (y.kill ? Number(N.gold()) / Math.max(1, sv.o.strikeGoldPerTile) : 0);
  return value / Math.max(1, y.spent);
}

/** The core's view of the scan's nations in `mode`'s order (see the
 *  header). */
export function rankedNations(
  sv: SearchView,
  base: BaseView,
  mode: Exclude<RankMode, "contact">,
): NeighborInfo[] {
  const { o, game } = sv;
  const rows: { info: NeighborInfo; score: number }[] = [];
  for (const info of sv.wm.nations) {
    if (info.type !== PlayerType.Nation || !game.hasPlayer(info.id)) continue;
    if (info.contact < o.searchMinContact && !base.attackers.has(info.id)) {
      continue;
    }
    const N = game.player(info.id);
    const score = N.isAlive() ? rankScore(sv, info, N, mode) : -Infinity;
    rows.push({ info, score: Number.isNaN(score) ? -Infinity : score });
  }
  rows.sort(
    (a, b) =>
      (b.score === a.score ? 0 : b.score > a.score ? 1 : -1) ||
      b.info.contact - a.info.contact ||
      a.info.smallID - b.info.smallID,
  );
  const top = o.searchMinContact + rows.length;
  return rows.map((r, i) => ({ ...r.info, contact: top - i }));
}

/** The mode of searchRank, or an error for one no run can mean. */
export function rankMode(value: string): RankMode {
  const mode = RANK_MODES.find((m) => m === value);
  if (mode === undefined) {
    throw new Error(
      `apex option "searchRank" must be one of ${RANK_MODES.join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
  return mode;
}

/** The core generator, its nations ranked by searchRank ("contact": the
 *  core itself). Registered in the core's place. */
export const RANKED_CORE: CandidateGenerator = {
  name: CORE.name,
  phase: CORE.phase,
  kinds: CORE.kinds,
  generate(sv: SearchView, base: BaseView): Candidate[] {
    const mode = rankMode(sv.o.searchRank);
    if (mode === "contact") return CORE.generate(sv, base);
    const nations = rankedNations(sv, base, mode);
    return CORE.generate({ ...sv, wm: { ...sv.wm, nations } }, base);
  },
};
