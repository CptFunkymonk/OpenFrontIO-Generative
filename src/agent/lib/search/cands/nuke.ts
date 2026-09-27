import {
  Difficulty,
  Game,
  Player,
  PlayerID,
  PlayerType,
  Unit,
  UnitType,
} from "../../../../core/game/Game";
import type { TileRef } from "../../../../core/game/GameMap";
import type { ApexOptions } from "../../../agents/apex/options";
import type { DirectiveStep } from "../../../agents/apex/state";
import { Prio } from "../../Scheduler";
import type {
  BaseView,
  Candidate,
  CandidateGenerator,
  SearchView,
} from "../Registry";
import { BREAK_FOE_TICKS } from "./core";
import {
  flightTiles,
  hostileAfterLaunch,
  mirvPrice,
  rivals,
  samLevelsOnPath,
} from "./nukeWatch";

// Package WP10n (docs/14-m4-plan.md §2.4 "Later candidates", §2.8 item 3;
// docs/13-mechanics.md §2.13-2.18, §5.12): our own MIRV and bomb candidates
// for the search, the countermeasure WP9 found the leader phase needs (every
// lost lead in WP9 fell to an ally or rival that out-capped us, through the
// nation MIRV rule, a two-players-left bomb, or a betrayal; §12 ledger).
//
// All of it is behind o.searchNukes (default off). When on, the
// SearchController adds this generator's kinds to the effective kind set and
// asks it in round 1. It reads only ctx.game (through the SearchView) and
// acts only by proposing directive steps; the rollout is the judge of
// whether a plan actually denies the MIRV and takes the crippled nation's
// land.
//
// Round-2 review fixes (/tmp/claude-0/review-WP10n):
// - F1: a MIRV plan now carries its own follow-up conquest. The base
//   StrikeController does NOT take a MIRVed nation's land: StrikeController
//   .ineligible skips a target with a pending alliance and (strikeNukeVeto,
//   on by default) one with a finished silo and atom gold while we own a
//   city, both of which a rich silo owner keeps after a MIRV. So mirv:N adds
//   attack steps on N timed to the warheads' landing, a foe mark so the web
//   does not re-ally N, and lastSend at the last attack so the horizon
//   covers the conquest.
// - F4: a denial salvo is sized from the SAMs of the target AND of every
//   player the launch turns hostile (the launch breaks our alliance with the
//   target, so its own SAM then fires), and from SAMs anywhere on the part
//   of the flight within 150 tiles of either end, not only the aim tile.
//   Salvos below the need are dropped (they would be shot down). Both atom
//   and hydrogen variants are offered.
// - F5: the pure-cost standalone silo candidate is gone; the combined
//   silo+launch candidate stays.
// - F7: an alliance-preserving price-denial MIRV (mirvx) at the nearest
//   tribe tile raises every nation's next MIRV by 15M without breaking any
//   alliance or making us a traitor.
//
// The MIRV, the salvos and the follow-up all carry strongCheck against N so
// a big target gets the long (searchHStrong) horizon: the payoff is the
// conquest after the strike.

/** The candidate kinds this generator makes. */
export const NUKE_KINDS: readonly string[] = ["mirv", "hydro", "atom", "silo"];

/** The steamroll-stop rung by difficulty (NationMIRVBehavior, the
 *  city-leader MIRV rule; mirrors lib/GoldPolicy.steamrollLine, kept here so
 *  this generator has no cross-package dependency). */
const STEAMROLL: Record<Difficulty, { min: number; gap: number }> = {
  [Difficulty.Easy]: { min: 20, gap: 2 },
  [Difficulty.Medium]: { min: 10, gap: 1.5 },
  [Difficulty.Hard]: { min: 10, gap: 1.25 },
  [Difficulty.Impossible]: { min: 8, gap: 1.15 },
};

export { mirvPrice };

/** Our finished, not-fully-in-cooldown silos' free launch slots now (level
 *  − queued launches; PlayerImpl.nukeSpawn needs a ready silo). */
export function readySlots(me: Player): number {
  let slots = 0;
  for (const s of me.units(UnitType.MissileSilo)) {
    if (s.isUnderConstruction()) continue;
    slots += Math.max(0, s.level() - s.missileTimerQueue().length);
  }
  return slots;
}

/** Whether we own a missile silo in any state. */
export function anySilo(me: Player): boolean {
  return me.units(UnitType.MissileSilo).length > 0;
}

/** N's finished (built) missile silos. */
function finishedSilos(N: Player): Unit[] {
  return N.units(UnitType.MissileSilo).filter((s) => !s.isUnderConstruction());
}

/** Our share of all land tiles (fallout counted, as the nation MIRV rule
 *  divides, NationMIRVBehavior). */
export function landShareOf(game: Game, me: Player): number {
  const land = game.numLandTiles();
  return land <= 0 ? 0 : me.numTilesOwned() / land;
}

/** Our land rank: 1 + the living non-tribe players with more tiles. */
function landRank(game: Game, me: Player): number {
  const mine = me.numTilesOwned();
  let rank = 1;
  for (const p of game.players()) {
    if (p === me || p.type() === PlayerType.Bot || !p.isAlive()) continue;
    if (p.numTilesOwned() > mine) rank++;
  }
  return rank;
}

/** Whether we are (at least tied) the city-levels leader and within
 *  `lead` levels of the steamroll rung (NationMIRVBehavior city rule;
 *  unitCount counts under-construction and captured cities). */
export function nearCityLeader(game: Game, me: Player, lead: number): boolean {
  const mine = me.unitCount(UnitType.City);
  let topOther = 0;
  for (const p of game.players()) {
    if (p === me || !p.isPlayer()) continue;
    topOther = Math.max(topOther, p.unitCount(UnitType.City));
  }
  if (mine < topOther) return false;
  const { min, gap } = STEAMROLL[game.config().gameConfig().difficulty];
  const line = Math.max(min + 1, Math.ceil(topOther * gap));
  return mine >= line - lead;
}

/** N's ticks until it can pay `price`: from the observed income the
 *  SearchView carries (review F2), or, without it, from the passive rate
 *  (goldAdditionRate) as a floor. */
function ticksToPrice(sv: SearchView, N: Player, price: bigint): number {
  const gold = N.gold();
  if (gold >= price) return 0;
  let income = sv.nukeIncome?.(N.id()) ?? 0n;
  if (income <= 0n) income = sv.game.config().goldAdditionRate(N);
  if (income <= 0n) return Infinity;
  return Math.ceil(Number(price - gold) / Number(income));
}

/** Whether N could soon pay a MIRV: it owns a silo (any state, the MIRV
 *  gate passes one under construction) and is within `lead` ticks of the
 *  price at its observed income. */
function canMirvSoon(
  sv: SearchView,
  N: Player,
  price: bigint,
  lead: number,
): boolean {
  if (!anySilo(N)) return false;
  return ticksToPrice(sv, N, price) <= lead;
}

/** T8's state: whether some silo owner is about to be able to MIRV us while
 *  we are a MIRV magnet (the ≥ land-share or city-leader gate), and whether
 *  we could MIRV offensively (we can pay and are rank ≤ 2). Backed by an
 *  observed-income function (review F2) when the caller has one; the
 *  stateless overload (tests) uses the passive rate. */
export function mirvThreatState(
  game: Game,
  me: Player,
  o: ApexOptions,
  income?: (id: PlayerID) => bigint,
): { threat: boolean; chance: boolean; term?: string } {
  if (game.config().isUnitDisabled(UnitType.MIRV)) {
    return { threat: false, chance: false };
  }
  const price = mirvPrice(game, me);
  const sv = { game, me, o, nukeIncome: income } as unknown as SearchView;
  const magnet =
    landShareOf(game, me) >= o.searchNukeLandShare ||
    nearCityLeader(game, me, o.searchNukeCityLead);
  let term: string | undefined;
  if (magnet) {
    let best: { N: Player; tt: number } | null = null;
    for (const N of rivals(game, me)) {
      if (!canMirvSoon(sv, N, price, o.searchNukeLead)) continue;
      const tt = ticksToPrice(sv, N, price);
      if (best === null || tt < best.tt) best = { N, tt };
    }
    if (best !== null) term = `${best.N.id()}:${price}`;
  }
  const chance =
    me.gold() >= price &&
    landRank(game, me) <= 2 &&
    rivals(game, me).length > 0;
  return { threat: term !== undefined, chance, term };
}

/** A central owned tile of `p`: the bounding-box centre of its border tiles
 *  when it owns it, else the border tile nearest that centre. Null if `p`
 *  owns nothing. */
export function centerTile(game: Game, p: Player): TileRef | null {
  const border = p.borderTiles();
  if (border.size === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const t of border) {
    const x = game.x(t);
    const y = game.y(t);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cx = Math.floor((minX + maxX) / 2);
  const cy = Math.floor((minY + maxY) / 2);
  const center = game.ref(cx, cy);
  if (game.hasOwner(center) && game.owner(center) === p) return center;
  let best: TileRef | null = null;
  let bestD = Infinity;
  for (const t of border) {
    const dx = game.x(t) - cx;
    const dy = game.y(t) - cy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/** A build_unit directive step for `unit` at `tile`. `amount` > 1 fires a
 *  salvo at one aim (ConstructionExecution). */
function buildStep(
  unit: UnitType,
  tile: TileRef,
  key: string,
  at: number,
  amount = 1,
): DirectiveStep {
  return {
    at,
    label: key,
    p: {
      intent:
        amount > 1
          ? { type: "build_unit", unit, tile, amount }
          : { type: "build_unit", unit, tile },
      prio: Prio.Build,
      cls: "build",
      key,
    },
  };
}

/** An attack step on N sized as share `frac` of the strike purse at the
 *  send (mirrors cands/core.attackStep, kept local so nuke owns its steps).
 *  `at` is an absolute live tick. */
function attackStep(
  id: PlayerID,
  smallID: number,
  at: number,
  frac: number,
): DirectiveStep {
  return {
    at,
    frac,
    label: `attack ${id} ${frac}`,
    p: {
      intent: { type: "attack", targetID: id, troops: 1 },
      prio: Prio.Strike,
      cls: "strike",
      key: `attack:${smallID}`,
      spend: { kind: "strike", troops: 1 },
      plan: "strike",
      meta: { target: smallID, clampTroops: 1, expectedRefund: 0 },
    },
  };
}

/** The conquest a MIRV plan tacks on (review F1): a foe mark on N until the
 *  break-foe horizon (so the web does not re-ally the nation we just
 *  MIRVed), then one attack per searchFracs share, staggered, from the tick
 *  the warheads land (`land`) on. Returns the steps and the last send's
 *  offset from the fork. */
function conquest(
  o: ApexOptions,
  N: Player,
  fork: number,
  land: number,
): { steps: DirectiveStep[]; lastSend: number } {
  const steps: DirectiveStep[] = [];
  const foeUntil = fork + Math.max(land, 0) + BREAK_FOE_TICKS;
  steps.push({ at: fork, foe: { id: N.id(), until: foeUntil } });
  const gap = Math.max(1, Math.floor(o.searchNukeStrikeGap));
  const fracs = [...o.searchFracs].sort((a, b) => a - b);
  let lastAt = fork + Math.max(land, 0);
  for (let i = 0; i < fracs.length; i++) {
    const at = fork + Math.max(land, 0) + i * gap;
    lastAt = at;
    steps.push(attackStep(N.id(), N.smallID(), at, fracs[i]));
  }
  return { steps, lastSend: lastAt - fork };
}

/**
 * An estimate of how long after launch a MIRV's warheads land, from the
 * straight-line distance to the aim (measured on all-plains maps: ~46 ticks
 * at 300 tiles rising to ~90 at 1,300). A rough affine fit, floored, used
 * only to time the follow-up attacks and set the horizon; the rollout plays
 * the real timing. */
function mirvLandTicks(game: Game, src: TileRef, dst: TileRef): number {
  const d = Math.sqrt(game.euclideanDistSquared(src, dst));
  return Math.round(40 + d * 0.045);
}

/** A ready silo of ours nearest `dst` (Manhattan), the one that would fire
 *  first (PlayerImpl.nukeSpawn), for flight-path SAM sizing; null if none. */
function nearestReadySilo(game: Game, me: Player, dst: TileRef): Unit | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const s of me.units(UnitType.MissileSilo)) {
    if (s.isUnderConstruction()) continue;
    const d = game.manhattanDist(s.tile(), dst);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** How dangerous a rival is, for ranking (higher = more dangerous). */
interface Threat {
  N: Player;
  canMirvUs: boolean;
  outCap: boolean;
  score: number;
}

function threats(sv: SearchView): Threat[] {
  const { game, me, o } = sv;
  const price = mirvPrice(game, me);
  const myCap = game.config().maxTroops(me);
  const out: Threat[] = [];
  for (const N of rivals(game, me)) {
    const canMirvUs = canMirvSoon(sv, N, price, o.searchNukeLead);
    const cap = game.config().maxTroops(N);
    const outCap = cap >= o.searchNukeCapRatio * myCap;
    if (!canMirvUs && !outCap) continue;
    // Pay-readiness dominates (an imminent MIRV at us), then the cap gap. A
    // sooner MIRV scores higher (smaller ticks-to-price).
    const tt = canMirvUs ? ticksToPrice(sv, N, price) : Infinity;
    const pay = canMirvUs ? 1 / (1 + tt) : 0;
    out.push({
      N,
      canMirvUs,
      outCap,
      score: pay * 1e6 + cap / Math.max(1, myCap),
    });
  }
  out.sort((a, b) => b.score - a.score || (a.N.id() < b.N.id() ? -1 : 1));
  return out;
}

/**
 * A denial salvo at N's finished silos (review F4), one build per silo, each
 * sized to the SAM levels that could down it + 1: the SAMs of N and of every
 * player the launch turns hostile, counted anywhere on the flight within 150
 * tiles of either end. A salvo below its need is dropped (it would only be
 * shot down). Both `bomb` variants (atom, hydrogen) are offered by the
 * caller; null if we cannot afford or fire even one full salvo.
 */
function denialFor(
  sv: SearchView,
  N: Player,
  bomb: UnitType,
  ready: number,
): Candidate | null {
  const { game, me, o, t } = sv;
  const config = game.config();
  const silos = finishedSilos(N);
  if (silos.length === 0 || ready < 1) return null;
  const price = config.unitInfo(bomb).cost(game, me);
  const outer = config.nukeMagnitudes(bomb).outer;
  const speed = config.nukeSpeed(bomb);
  const kind = bomb === UnitType.HydrogenBomb ? "hydro" : "atom";
  let slotsLeft = Math.min(ready, o.searchNukeMaxBombs);
  let goldLeft = me.gold();
  const steps: DirectiveStep[] = [];
  // Nearest silos to N's centre first (short flights land soonest); ties by
  // TileRef for determinism.
  const center = centerTile(game, N);
  const ordered = [...silos].sort((a, b) => {
    const da = center === null ? 0 : game.manhattanDist(a.tile(), center);
    const db = center === null ? 0 : game.manhattanDist(b.tile(), center);
    return da - db || a.tile() - b.tile();
  });
  for (const s of ordered) {
    if (slotsLeft < 1 || goldLeft < price) break;
    const dst = s.tile();
    const from = nearestReadySilo(game, me, dst);
    const path =
      from === null ? [dst] : flightTiles(game, from.tile(), dst, speed);
    const owners = hostileAfterLaunch(game, me, dst, outer);
    const from2 = from?.tile() ?? dst;
    const need = 1 + samLevelsOnPath(game, owners, path, from2, dst);
    // Drop a salvo the budget or our slots cannot fully cover: a partial one
    // is shot down (review F4).
    if (need > slotsLeft) continue;
    if (goldLeft < price * BigInt(need)) continue;
    steps.push(buildStep(bomb, dst, `${kind}:${N.id()}:${s.id()}`, t, need));
    slotsLeft -= need;
    goldLeft -= price * BigInt(need);
  }
  if (steps.length === 0) return null;
  return {
    name: `${kind}:${N.id()}`,
    kind,
    target: N.id(),
    steps,
    lastSend: 0,
    isBreak: false,
    strongCheck: true,
    strong: N.troops() >= o.searchStrongShare * me.troops(),
    // A threat response survives the budget's "defensive only" degrade (F9).
    defensive: true,
  };
}

/** Our MIRV at N's centre plus the follow-up conquest (review F1). Null if
 *  we cannot pay or N owns nothing. */
function mirvAt(sv: SearchView, N: Player): Candidate | null {
  const { game, me, o, t } = sv;
  if (game.config().isUnitDisabled(UnitType.MIRV)) return null;
  const aim = centerTile(game, N);
  if (aim === null) return null;
  const from = nearestReadySilo(game, me, aim);
  const land = from === null ? 60 : mirvLandTicks(game, from.tile(), aim);
  const { steps: after, lastSend } = conquest(o, N, t, land);
  return {
    name: `mirv:${N.id()}`,
    kind: "mirv",
    target: N.id(),
    steps: [buildStep(UnitType.MIRV, aim, `mirv:${N.id()}`, t), ...after],
    lastSend,
    isBreak: false,
    strongCheck: true,
    strong: N.troops() >= o.searchStrongShare * me.troops(),
    defensive: true,
  };
}

/** An alliance-preserving price-denial MIRV (review F7): a MIRV at the
 *  nearest tribe (Bot) tile. It breaks no alliance and makes us no traitor
 *  (MirvExecution only breaks the alliance with the target player, and we
 *  are never allied with tribes), but raises every nation's next MIRV by
 *  15M (OwnNukes). Null if no tribe owns a tile, or we cannot pay. */
function priceDenialMirv(sv: SearchView): Candidate | null {
  const { game, me, t } = sv;
  if (game.config().isUnitDisabled(UnitType.MIRV)) return null;
  const home = centerTile(game, me);
  let best: { tile: TileRef; d: number } | null = null;
  for (const p of game.players()) {
    if (!p.isPlayer() || p.type() !== PlayerType.Bot || !p.isAlive()) continue;
    const c = centerTile(game, p);
    if (c === null) continue;
    const d = home === null ? 0 : game.manhattanDist(home, c);
    if (best === null || d < best.d) best = { tile: c, d };
  }
  if (best === null) return null;
  return {
    name: "mirvx",
    kind: "mirv",
    target: null,
    steps: [buildStep(UnitType.MIRV, best.tile, "mirvx", t)],
    lastSend: 0,
    isBreak: false,
    // No conquest: this is price denial, not a strike, and the target is a
    // tribe. A short horizon is enough to see our lead hold.
    strongCheck: false,
    defensive: true,
  };
}

/**
 * A combined plan for when we own no silo: build one at a safe interior tile
 * now, then launch at the silo-ready tick (fork + searchNukeSiloReady, past
 * the 102-tick build). "mirv" aims a MIRV at N's centre (with the follow-up
 * conquest, F1); "hydro" a hydrogen bomb at N's nearest finished silo. Null
 * if we cannot afford the silo plus the launch.
 */
function siloThenLaunch(
  sv: SearchView,
  N: Player,
  kind: "mirv" | "hydro",
): Candidate | null {
  const { game, me, o, t } = sv;
  const config = game.config();
  const gold = me.gold();
  const siloCost = config.unitInfo(UnitType.MissileSilo).cost(game, me);
  const siloAim = centerTile(game, me);
  if (siloAim === null) return null;
  const ready = Math.max(1, Math.floor(o.searchNukeSiloReady));
  const launchAt = t + ready;
  const steps: DirectiveStep[] = [
    buildStep(UnitType.MissileSilo, siloAim, `silo:${N.id()}`, t),
  ];
  let cost: bigint;
  let lastSend = ready;
  if (kind === "mirv") {
    if (config.isUnitDisabled(UnitType.MIRV)) return null;
    const aim = centerTile(game, N);
    if (aim === null) return null;
    cost = mirvPrice(game, me);
    steps.push(buildStep(UnitType.MIRV, aim, `silomirv:${N.id()}`, launchAt));
    // The silo is at our centre; estimate the MIRV's flight from there.
    const land = mirvLandTicks(game, siloAim, aim);
    const { steps: after, lastSend: ls } = conquest(o, N, launchAt, land);
    steps.push(...after);
    lastSend = ready + ls;
  } else {
    if (config.isUnitDisabled(UnitType.HydrogenBomb)) return null;
    const silos = finishedSilos(N);
    if (silos.length === 0) return null;
    cost = config.unitInfo(UnitType.HydrogenBomb).cost(game, me);
    // A fresh level-1 silo has one slot: one bomb (the rollout judges
    // whether a covering SAM downs it).
    steps.push(
      buildStep(
        UnitType.HydrogenBomb,
        silos[0].tile(),
        `silohydro:${N.id()}`,
        launchAt,
      ),
    );
  }
  if (gold < siloCost + cost) return null;
  return {
    name: `silo${kind}:${N.id()}`,
    kind,
    target: N.id(),
    steps,
    lastSend,
    isBreak: false,
    strongCheck: true,
    strong: N.troops() >= o.searchStrongShare * me.troops(),
    defensive: true,
  };
}

export const NUKE: CandidateGenerator = {
  name: "nuke",
  phase: "r1",
  kinds: NUKE_KINDS,
  generate(sv: SearchView, _base: BaseView): Candidate[] {
    const { game, me, o, kinds } = sv;
    if (!o.searchNukes) return [];
    const out: Candidate[] = [];
    const ready = readySlots(me);
    const haveSilo = anySilo(me);
    const gold = me.gold();
    const price = mirvPrice(game, me);
    const ranked = threats(sv);

    // mirv:N* — our MIRV at the single most dangerous nation, with its
    // follow-up conquest.
    if (
      o.searchNukeMirv &&
      kinds.has("mirv") &&
      haveSilo &&
      ready >= 1 &&
      gold >= price &&
      ranked.length > 0
    ) {
      const c = mirvAt(sv, ranked[0].N);
      if (c !== null) out.push(c);
    }

    // mirvx — price-denial MIRV at a tribe (alliance-preserving, F7): when a
    // nation is a MIRV threat, we can pay, and a tribe tile exists.
    if (
      o.searchNukeMirvDeny &&
      kinds.has("mirv") &&
      haveSilo &&
      ready >= 1 &&
      gold >= price &&
      ranked.some((th) => th.canMirvUs)
    ) {
      const c = priceDenialMirv(sv);
      if (c !== null) out.push(c);
    }

    // hydro:N / atom:N — MIRV denial by killing finished silos.
    if (o.searchNukeDeny && (kinds.has("hydro") || kinds.has("atom"))) {
      let made = 0;
      for (const th of ranked) {
        if (made >= o.searchNukeK) break;
        if (!th.canMirvUs) continue;
        const config = game.config();
        // Prefer hydrogen (outer 100, kills SAMs within 100), but offer atom
        // too — the rollout picks the better; a partial salvo is dropped in
        // denialFor.
        let any = false;
        if (
          kinds.has("hydro") &&
          !config.isUnitDisabled(UnitType.HydrogenBomb) &&
          gold >= config.unitInfo(UnitType.HydrogenBomb).cost(game, me)
        ) {
          const c = denialFor(sv, th.N, UnitType.HydrogenBomb, ready);
          if (c !== null) {
            out.push(c);
            any = true;
          }
        }
        if (
          kinds.has("atom") &&
          !config.isUnitDisabled(UnitType.AtomBomb) &&
          gold >= config.unitInfo(UnitType.AtomBomb).cost(game, me)
        ) {
          const c = denialFor(sv, th.N, UnitType.AtomBomb, ready);
          if (c !== null) {
            out.push(c);
            any = true;
          }
        }
        if (any) made++;
      }
    }

    // silo+launch — when we own no silo (the base policy builds none), build
    // one now and launch at the silo-ready tick for the most dangerous
    // nation: crush it (mirv) or deny its silo (hydro). The standalone silo
    // candidate is gone (review F5: it was pure cost and never chosen).
    if (
      o.searchNukeSilo &&
      kinds.has("silo") &&
      !haveSilo &&
      ranked.length > 0
    ) {
      const N = ranked[0].N;
      if (o.searchNukeMirv && kinds.has("mirv")) {
        const c = siloThenLaunch(sv, N, "mirv");
        if (c !== null) out.push(c);
      }
      if (o.searchNukeDeny && kinds.has("hydro") && ranked[0].canMirvUs) {
        const c = siloThenLaunch(sv, N, "hydro");
        if (c !== null) out.push(c);
      }
    }

    return out;
  },
};

/** For the SearchController's foreseen-threat wiring and tests: the ids of
 *  the nations this generator would target now (most dangerous first). */
export function nukeTargets(
  game: Game,
  me: Player,
  o: ApexOptions,
  income?: (id: PlayerID) => bigint,
): PlayerID[] {
  const sv = { game, me, o, nukeIncome: income } as unknown as SearchView;
  return threats(sv).map((th) => th.N.id());
}
