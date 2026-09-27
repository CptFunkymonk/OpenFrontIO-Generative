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

// Package WP10n (docs/14-m4-plan.md §2.4 "Later candidates", §2.8 item 3;
// docs/13-mechanics.md §2.13-2.16, §5.12): our own MIRV and bomb candidates
// for the search, the countermeasure WP9 found the leader phase needs (every
// lost lead in WP9 fell to an ally or rival that out-capped us, through the
// nation MIRV rule, a two-players-left bomb, or a betrayal; §12 ledger).
//
// All of it is behind o.searchNukes (default off). When on, the
// SearchController adds this generator's kinds to the effective kind set and
// asks it in round 1. It reads only ctx.game (through the SearchView) and
// acts only by proposing directive steps; the rollout is the judge of
// whether a plan actually denies the MIRV and whether the base policy then
// takes the crippled nation's land (there is no follow-up attack step: the
// base StrikeController strikes a nation left below its reserve, W1).
//
// Candidates (each sized from our gold and the live prices; the mechanics
// they rely on are pinned):
// - mirv:N — our MIRV at the most dangerous nation N (the richest silo owner
//   that can pay the MIRV price soon, or the strongest rival/ally whose cap
//   out-grows ours). It breaks our alliance with N at the MIRV's spawn tick
//   (we turn traitor pre-emptively), cuts N to ~3% of its cap and ~70% of
//   its land, and paralyses it for 270+ ticks (MirvEffect); the value's
//   share factor L0/Lh also rises as N's land turns to fallout. It raises
//   every nation's next MIRV by 15M (OwnNukes), the denial-by-price effect.
// - hydro:N / atom:N — a salvo at N's finished silos to remove them (a
//   nation with no finished silo cannot MIRV, SiloStrike): one build per
//   silo, each amount = the covering hostile SAM levels + 1 (two bombs beat
//   a level-1 SAM), capped by our ready slots and gold. Prefers hydrogen
//   (outer 100, kills a SAM within 100 from outside its range) when we can
//   pay, else atom (outer 30, 750k).
// - silo — a missile silo at a safe interior tile when we own none and gold
//   is past a threshold, so a later search can MIRV or deny (a new silo is
//   ready at intent + 102, OwnNukes).
//
// The MIRV and the salvos are marked strongCheck against N so a big target
// gets the long (searchHStrong) horizon: the payoff is the conquest after
// the strike, which 600 ticks may not reach (a MIRV lands 46-67 ticks out,
// then the target is paralysed 270+; SiloStrike/MirvEffect). No shared
// Rounds/Budget change is needed: the strong-target machinery already prices
// and judges a plan against a strong target at that horizon.

/** The candidate kinds this generator makes (added to the effective kind
 *  set by the SearchController when o.searchNukes is on). */
export const NUKE_KINDS: readonly string[] = ["mirv", "hydro", "atom", "silo"];

/** The steamroll-stop rung by difficulty (NationMIRVBehavior :102-131, the
 *  city-leader MIRV rule; mirrors lib/GoldPolicy.steamrollLine, kept here so
 *  this generator has no cross-package dependency). */
const STEAMROLL: Record<Difficulty, { min: number; gap: number }> = {
  [Difficulty.Easy]: { min: 20, gap: 2 },
  [Difficulty.Medium]: { min: 10, gap: 1.5 },
  [Difficulty.Hard]: { min: 10, gap: 1.25 },
  [Difficulty.Impossible]: { min: 8, gap: 1.15 },
};

/** The MIRV price now: 25M + 15M × MIRVs launched, game-wide (Config
 *  :618-630); the player only matters for a human's infinite gold. */
export function mirvPrice(game: Game, me: Player): bigint {
  return game.unitInfo(UnitType.MIRV).cost(game, me);
}

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

/** One minute (`lead` ticks) of N's gold income (Config.goldAdditionRate). */
function incomeOver(game: Game, N: Player, lead: number): bigint {
  return game.config().goldAdditionRate(N) * BigInt(Math.max(0, lead));
}

/** Our share of all land tiles (fallout counted, as the nation MIRV rule
 *  divides, NationMIRVBehavior :181-225). */
export function landShareOf(game: Game, me: Player): number {
  const land = game.numLandTiles();
  return land <= 0 ? 0 : me.numTilesOwned() / land;
}

/** Living non-tribe players other than us and our team. */
function rivals(game: Game, me: Player): Player[] {
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

/** Whether N could soon pay a MIRV: it owns a silo (any state, the MIRV
 *  gate passes one under construction) and its gold is within one `lead`
 *  ticks of income of the price. */
function canMirvSoon(
  game: Game,
  N: Player,
  price: bigint,
  lead: number,
): boolean {
  if (!anySilo(N)) return false;
  return N.gold() >= price - incomeOver(game, N, lead);
}

/** T8's state: whether some silo owner is about to be able to MIRV us
 *  while we are a MIRV magnet (the ≥ land-share or city-leader gate), and
 *  whether we could MIRV offensively (we can pay and are rank ≤ 2). The
 *  SearchController feeds this into the trigger's observation. */
export function mirvThreatState(
  game: Game,
  me: Player,
  o: ApexOptions,
): { threat: boolean; chance: boolean } {
  if (game.config().isUnitDisabled(UnitType.MIRV)) {
    return { threat: false, chance: false };
  }
  const price = mirvPrice(game, me);
  const magnet =
    landShareOf(game, me) >= o.searchNukeLandShare ||
    nearCityLeader(game, me, o.searchNukeCityLead);
  let threat = false;
  if (magnet) {
    for (const N of rivals(game, me)) {
      if (canMirvSoon(game, N, price, o.searchNukeLead)) {
        threat = true;
        break;
      }
    }
  }
  const chance =
    me.gold() >= price &&
    landRank(game, me) <= 2 &&
    rivals(game, me).length > 0;
  return { threat, chance };
}

/** Hostile (not friendly to us) SAM levels covering `tile` (Config.samRange
 *  by level); a salvo of that + 1 overwhelms them in one tick. */
function coveringSamLevels(game: Game, me: Player, tile: TileRef): number {
  let levels = 0;
  for (const p of game.players()) {
    if (!p.isPlayer() || p === me || me.isFriendly(p)) continue;
    for (const s of p.units(UnitType.SAMLauncher)) {
      if (s.isUnderConstruction()) continue;
      const r = game.config().samRange(s.level());
      if (game.euclideanDistSquared(s.tile(), tile) <= r * r)
        levels += s.level();
    }
  }
  return levels;
}

/** A central owned tile of `p`: the bounding-box centre of its border tiles
 *  when it owns it, else the border tile nearest that centre (the aim
 *  NationMIRVBehavior uses, calculateTerritoryCenter, recomputed here so the
 *  agent calls no core execution helper). Null if `p` owns nothing. */
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

/** A build_unit directive step for `unit` at `tile` (gold-priced, so no
 *  troop frac); `amount` > 1 fires a salvo at one aim (ConstructionExecution
 *  :109-136). */
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

/** How dangerous a rival is, for ranking (higher = more dangerous): a silo
 *  owner that can pay the MIRV price soon ranks by how close its gold is to
 *  the price; every rival also ranks by how far its cap out-grows ours. */
interface Threat {
  N: Player;
  canMirvUs: boolean;
  outCap: boolean;
  score: number;
}

function threats(game: Game, me: Player, o: ApexOptions): Threat[] {
  const price = mirvPrice(game, me);
  const myCap = game.config().maxTroops(me);
  const out: Threat[] = [];
  for (const N of rivals(game, me)) {
    const canMirvUs = canMirvSoon(game, N, price, o.searchNukeLead);
    const cap = game.config().maxTroops(N);
    const outCap = cap >= o.searchNukeCapRatio * myCap;
    if (!canMirvUs && !outCap) continue;
    // Pay-readiness dominates (an imminent MIRV at us), then the cap gap.
    const pay = canMirvUs ? Number(N.gold()) / Math.max(1, Number(price)) : 0;
    out.push({
      N,
      canMirvUs,
      outCap,
      score: pay * 1e6 + cap / Math.max(1, myCap),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** A hydro (preferred) or atom denial salvo at N's finished silos, capped by
 *  our ready slots and gold; null if we cannot afford or fire even one. */
function denialFor(sv: SearchView, N: Player, ready: number): Candidate | null {
  const { game, me, o, t, kinds } = sv;
  const config = game.config();
  const silos = finishedSilos(N);
  if (silos.length === 0 || ready < 1) return null;
  const hydroOk =
    kinds.has("hydro") && !config.isUnitDisabled(UnitType.HydrogenBomb);
  const atomOk = kinds.has("atom") && !config.isUnitDisabled(UnitType.AtomBomb);
  const hydroPrice = config.unitInfo(UnitType.HydrogenBomb).cost(game, me);
  const atomPrice = config.unitInfo(UnitType.AtomBomb).cost(game, me);
  const gold = me.gold();
  // Prefer hydrogen (outer 100, kills SAMs within 100) when we can pay for
  // at least one; else atom.
  let bomb: UnitType | null = null;
  let price = 0n;
  if (hydroOk && gold >= hydroPrice) {
    bomb = UnitType.HydrogenBomb;
    price = hydroPrice;
  } else if (atomOk && gold >= atomPrice) {
    bomb = UnitType.AtomBomb;
    price = atomPrice;
  }
  if (bomb === null || price <= 0n) return null;
  let slotsLeft = Math.min(ready, o.searchNukeMaxBombs);
  let goldLeft = gold;
  const steps: DirectiveStep[] = [];
  // Nearest silos to N's centre first (short flights, first denials land
  // soonest); ties by TileRef for determinism.
  const center = centerTile(game, N);
  const ordered = [...silos].sort((a, b) => {
    const da = center === null ? 0 : game.manhattanDist(a.tile(), center);
    const db = center === null ? 0 : game.manhattanDist(b.tile(), center);
    return da - db || a.tile() - b.tile();
  });
  const kind = bomb === UnitType.HydrogenBomb ? "hydro" : "atom";
  for (const s of ordered) {
    if (slotsLeft < 1 || goldLeft < price) break;
    const need = 1 + coveringSamLevels(game, me, s.tile());
    const afford = Number(goldLeft / price);
    const amount = Math.max(1, Math.min(need, slotsLeft, afford));
    steps.push(
      buildStep(bomb, s.tile(), `${kind}:${N.id()}:${s.id()}`, t, amount),
    );
    slotsLeft -= amount;
    goldLeft -= price * BigInt(amount);
  }
  if (steps.length === 0) return null;
  return {
    name: `${kind}:${N.id()}`,
    kind,
    target: N.id(),
    steps,
    lastSend: 0,
    isBreak: false,
    // A big target's conquest is slow: take the long (strong) horizon.
    strongCheck: true,
    strong: N.troops() >= o.searchStrongShare * me.troops(),
    defensive: false,
  };
}

export const NUKE: CandidateGenerator = {
  name: "nuke",
  phase: "r1",
  kinds: NUKE_KINDS,
  generate(sv: SearchView, _base: BaseView): Candidate[] {
    const { game, me, o, t, kinds } = sv;
    if (!o.searchNukes) return [];
    if (game.config().isUnitDisabled(UnitType.MIRV) && !kinds.has("atom")) {
      // Nothing to do with MIRVs disabled unless bombs are still wanted.
    }
    const out: Candidate[] = [];
    const ready = readySlots(me);
    const haveSilo = anySilo(me);
    const gold = me.gold();
    const price = mirvPrice(game, me);
    const ranked = threats(game, me, o);

    // mirv:N* — our MIRV at the single most dangerous nation.
    if (
      o.searchNukeMirv &&
      kinds.has("mirv") &&
      !game.config().isUnitDisabled(UnitType.MIRV) &&
      haveSilo &&
      ready >= 1 &&
      gold >= price &&
      ranked.length > 0
    ) {
      const N = ranked[0].N;
      const aim = centerTile(game, N);
      if (aim !== null) {
        out.push({
          name: `mirv:${N.id()}`,
          kind: "mirv",
          target: N.id(),
          steps: [buildStep(UnitType.MIRV, aim, `mirv:${N.id()}`, t)],
          lastSend: 0,
          isBreak: false,
          strongCheck: true,
          strong: N.troops() >= o.searchStrongShare * me.troops(),
          defensive: false,
        });
      }
    }

    // hydro:N / atom:N — MIRV denial by killing finished silos.
    if (o.searchNukeDeny && (kinds.has("hydro") || kinds.has("atom"))) {
      let made = 0;
      for (const th of ranked) {
        if (made >= o.searchNukeK) break;
        if (!th.canMirvUs) continue;
        const c = denialFor(sv, th.N, ready);
        if (c !== null) {
          out.push(c);
          made++;
        }
      }
    }

    // silo — build one so the other candidates are possible later.
    if (
      o.searchNukeSilo &&
      kinds.has("silo") &&
      !haveSilo &&
      gold >= BigInt(Math.floor(o.searchNukeSiloGold))
    ) {
      const aim = centerTile(game, me);
      if (aim !== null) {
        out.push({
          name: "silo",
          kind: "silo",
          target: null,
          steps: [buildStep(UnitType.MissileSilo, aim, "silo", t)],
          lastSend: 0,
          isBreak: false,
          strongCheck: false,
          defensive: false,
        });
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
): PlayerID[] {
  return threats(game, me, o).map((th) => th.N.id());
}
