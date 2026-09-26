import {
  Game,
  Player,
  PlayerID,
  PlayerType,
  Relation,
} from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { Models } from "./Models";
import { NationModel } from "./NationModel";

// Deterrence (apex spec §5.1 items 2-4; docs/13-mechanics.md §2.6-2.9 and
// §5.7-5.9). Read-only helpers: nothing here mutates the game.
//
// The land line [PIN NationSendCap]: while nothing attacks it, a bordering
// Impossible nation with T troops at its decision can land-attack us only
// if T − ceil(0.9·H) ≥ 0.2·H, so a home H above T/1.1 (nm.sendCapSafe())
// deters it. Its betrayal lines [PIN NationAlliance]: an ally at or above
// its reserve betrays a bordering ally whose home is under a third of its
// troops, so H ≥ 0.34·T keeps an ally honest.

/** Strategy thresholds of the Impossible list (AiAttackBehavior.ts; docs/13
 *  §5.8), for the diagnostics only. */
const VERY_WEAK_CAP = 0.15;
const STRONGER_GUARD = 1.2;
const VICTIM_SHARE = 0.5;
const JUICY_SHARE = 0.75;
const HATED_GUARD = 3;

export interface DeterrenceParams {
  /** Multiplies each line: (T + 1)/sendCapSafe·margin. */
  margin: number;
  /** A term above maxShare of our cap cannot be held without freezing the
   *  agent (and a nation that far ahead is not deterred by what we can
   *  hold): it is dropped, or with capLines held at maxShare·cap (a home
   *  that high still cuts its send, T − ceil(0.9·H), and the drop sets
   *  free for spending the home a stronger neighbour is about to hit). */
  maxShare: number;
  /** Cap lines above maxShare·cap at it instead of dropping them. */
  capLines: boolean;
  /** H ≥ betrayShare·T for a bordering ally (0: no betrayal guard). */
  betrayShare: number;
  /** Keep a land term only if wouldTargetUs names us at the probe home
   *  (the list picks another player first otherwise). */
  targetCheck: boolean;
  /** With targetCheck, a nation with at most this many affordable tribes
   *  (NationState.affordableTribes) keeps its term anyway: it eats its
   *  last tribes within a decision or two, and we cannot regrow home that
   *  fast (arena quick@20 Yellow Sea: Hebei attacked with one tribe left,
   *  our home 0.5 of its line). */
  tribeSlack: number;
  /** Ticks a nation's land line is held after it was last computed
   *  (0: off). While held, the line is the highest computed in that time:
   *  a nation's own attack or a tribe it turns to lowers or drops its line
   *  for a few decisions, the spending that frees brings our home down
   *  just as it regrows (arena quick Onion: the line fell to 0 five times
   *  in 1,000 ticks, each followed by a burst of tribe attacks and the
   *  next invasion). */
  hold: number;
}

/** A land line kept for DeterrenceParams.hold (plain data, in state). */
export interface HeldLine {
  floor: number;
  until: number;
}

export type DeterrenceKind = "land" | "betray";

/** One nation's line. Plain data. */
export interface DeterrenceTerm {
  id: PlayerID;
  kind: DeterrenceKind;
  /** The decision the line is for. */
  d: number;
  /** Its troops at d (nm.troopsAt). */
  T: number;
  /** The home that deters it at d. */
  floor: number;
}

export interface Deterrence {
  /** The largest kept term (0 with none). */
  floor: number;
  /** Id of the nation behind `floor`, or null. */
  by: PlayerID | null;
  /** Kept terms, in smallID order. */
  terms: DeterrenceTerm[];
  /** Terms above maxShare of the cap (dropped, or capped with capLines). */
  dropped: number;
}

export const NO_DETERRENCE: Deterrence = Object.freeze({
  floor: 0,
  by: null,
  terms: [],
  dropped: 0,
});

/**
 * The deterrence floor at `tick` (spec §5.1 items 2-3): for every living
 * nation of `cands` (the caller's list of nations that border us) that
 * NationModel's last full refresh also sees on our border, at its next
 * decision d:
 * - unallied: if it can land-attack us at the probe home `low` (the floor
 *   we would keep without deterrence) through canLandAttackUs, and, with
 *   targetCheck, its strategy list would pick us there (wouldTargetUs; a
 *   nation with an affordable tribe picks the tribe, but one with at most
 *   tribeSlack of them counts anyway), the term is
 *   (T(d) + 1)/sendCapSafe·margin: above it canLandAttackUs is false;
 * - allied and not locked or below its reserve at d (betrayal runs in its
 *   strategy list): betrayShare·T(d).
 * Terms above maxShare·cap are dropped (capLines: held at maxShare·cap).
 * Nations that free land or a tribe
 * with a structure locks at d add nothing. With p.hold > 0 and a `held`
 * map (the caller's state), a land line is kept for p.hold ticks after it
 * was last computed, at the highest value computed since it was set (a
 * line computed lower does not lower it; one computed higher, or after
 * the hold, resets it); an ally's held line is dropped. In smallID order,
 * so the result is deterministic.
 */
export function deterrence(
  me: Player,
  nm: NationModel,
  models: Models,
  tick: number,
  low: number,
  cands: readonly PlayerID[],
  p: DeterrenceParams,
  held: Record<PlayerID, HeldLine> | null = null,
): Deterrence {
  const safe = nm.sendCapSafe();
  if (held !== null) {
    for (const id of Object.keys(held).sort()) {
      if (held[id].until <= tick) delete held[id];
    }
  }
  if (!Number.isFinite(safe) || cands.length === 0) return NO_DETERRENCE;
  const cap = models.cap(me);
  const max = p.maxShare * cap;
  const allies = new Set<PlayerID>();
  for (const a of me.allies()) allies.add(a.id());
  const seen: { id: PlayerID; smallID: number }[] = [];
  for (const id of cands) {
    const st = nm.get(id);
    if (st === undefined || !st.full || !st.sharesBorderWithUs) continue;
    seen.push({ id, smallID: st.smallID });
  }
  seen.sort((a, b) => a.smallID - b.smallID);
  const terms: DeterrenceTerm[] = [];
  let dropped = 0;
  let last: PlayerID | null = null;
  for (const { id } of seen) {
    if (id === last) continue;
    last = id;
    const d = nm.nextDecision(id, tick + 1);
    let term: DeterrenceTerm;
    if (allies.has(id)) {
      if (held !== null) delete held[id];
      if (p.betrayShare <= 0) continue;
      const g = nm.gates(id, d);
      if (g === "locked" || g === "belowReserve") continue;
      const T = nm.troopsAt(id, d);
      term = { id, kind: "betray", d, T, floor: p.betrayShare * T };
    } else {
      const line = landLine(nm, id, low, d, safe, p);
      const h = held !== null && p.hold > 0 ? held[id] : undefined;
      if (line === null && h === undefined) continue;
      const T = nm.troopsAt(id, d);
      let floor = line ?? 0;
      if (held !== null && p.hold > 0) {
        if (line !== null && (h === undefined || line >= h.floor)) {
          held[id] = { floor: line, until: tick + p.hold };
        } else if (h !== undefined) {
          floor = Math.max(floor, h.floor);
        }
      }
      term = { id, kind: "land", d, T, floor };
    }
    if (term.floor > max) {
      dropped++;
      if (!p.capLines) continue;
      term.floor = max;
    }
    terms.push(term);
  }
  let floor = 0;
  let by: PlayerID | null = null;
  for (const t of terms) {
    if (t.floor > floor) {
      floor = t.floor;
      by = t.id;
    }
  }
  return { floor, by, terms, dropped };
}

/** Nation id's land line at its decision d, (T(d) + 1)/safe·margin, if it
 *  could land-attack us at the probe home `low` (and, with targetCheck,
 *  its list picks us there or it has at most tribeSlack affordable
 *  tribes); else null. */
function landLine(
  nm: NationModel,
  id: PlayerID,
  low: number,
  d: number,
  safe: number,
  p: DeterrenceParams,
): number | null {
  if (!nm.canLandAttackUs(id, low, d)) return null;
  if (
    p.targetCheck &&
    nm.get(id)!.affordableTribes > p.tribeSlack &&
    nm.wouldTargetUs(id, low) === null
  ) {
    return null;
  }
  return ((nm.troopsAt(id, d) + 1) / safe) * p.margin;
}

/**
 * The land attack N could send us at its decision d with our home at
 * `home`: min(T(d) − reserve·M, troopSendCap) (AiAttackBehavior.ts:1041-
 * 1074), the cap NationModel.sendCap at N's troops now shifted by its
 * regrowth to d. 0 at Easy and Medium's uncapped sends is not special-
 * cased: callers gate on canLandAttackUs first.
 */
export function potentialSend(
  nm: NationModel,
  models: Models,
  N: Player,
  home: number,
  d: number,
): number {
  const id = N.id();
  const T = nm.troopsAt(id, d);
  const reserve = nm.params(id).reserve * models.cap(N);
  const cap = nm.sendCap(id, home) + (T - N.troops());
  return Math.max(0, Math.min(T - reserve, cap));
}

/** Ids of the living nations, in smallID order (deterministic). */
export function nationIds(game: Game): PlayerID[] {
  return game
    .players()
    .filter((p) => p.type() === PlayerType.Nation)
    .sort((a, b) => a.smallID() - b.smallID())
    .map((p) => p.id());
}

/** Why lowering our home would expose us to a nation (unlockedBy). */
export interface Unlock {
  id: PlayerID;
  /** "land": it cannot land-attack us at the home we have but could at the
   *  lower one; "betray": a bordering ally at or above its reserve that
   *  the lower home puts under its betrayal line betrayShare·T(d). */
  kind: DeterrenceKind;
}

/**
 * The first nation of `cands` (other than `except`, in the given order)
 * that lowering our home from `home` to `after` would expose us to, at its
 * next decision d, or null:
 * - unallied, sharing a border with us in NationModel's last full refresh:
 *   canLandAttackUs is false at `home` and true at `after` (a nation that
 *   can already attack us is not counted: the lower home only raises its
 *   send, T − ceil(0.9·H));
 * - allied (betrayShare > 0), bordering, not locked or below its reserve at
 *   d: home ≥ betrayShare·T(d) > after (NationAllianceBehavior.ts:404-491
 *   betrays a bordering ally under a third of its troops; docs/13 §2.9).
 * Read-only. The arena showed why (quick Alps, package B1): two counters on
 * Ticino took home from 3.57M to 2.0M, under St. Gallen's line, and St.
 * Gallen's 1.84M invasion took half our land. It is not enough for
 * counters: a nation that can already attack us but picks another player
 * is not counted, and the lower home can make us its juiciest target
 * (H ≤ 0.75·T; quick World: Siberia joined Japan's invasion so).
 */
export function unlockedBy(
  me: Player,
  nm: NationModel,
  tick: number,
  cands: readonly PlayerID[],
  except: PlayerID | null,
  home: number,
  after: number,
  betrayShare: number,
): Unlock | null {
  if (after >= home) return null;
  if (!Number.isFinite(nm.sendCapSafe())) return null;
  const allies = new Set<PlayerID>();
  for (const a of me.allies()) allies.add(a.id());
  for (const id of cands) {
    if (id === except) continue;
    const st = nm.get(id);
    if (st === undefined || !st.full || !st.sharesBorderWithUs) continue;
    const d = nm.nextDecision(id, tick + 1);
    if (allies.has(id)) {
      if (betrayShare <= 0) continue;
      const g = nm.gates(id, d);
      if (g === "locked" || g === "belowReserve") continue;
      const line = betrayShare * nm.troopsAt(id, d);
      if (home >= line && after < line) return { id, kind: "betray" };
      continue;
    }
    if (nm.canLandAttackUs(id, home, d)) continue;
    if (nm.canLandAttackUs(id, after, d)) return { id, kind: "land" };
  }
  return null;
}

/**
 * The counter that deletes N's attacks on us (AttackExecution.ts:157-170):
 * a new attack of ours on N cancels each of N's attacks on us 1:1 at its
 * init, in N's incoming order, retreating ones and landed boats included;
 * one that is larger than the total deletes them all and goes on with the
 * rest, one that is smaller is deleted after cancelling as much [PIN
 * AttackMerge]. `stack` is the total of N's attacks on us now; their
 * attacks can only shrink before ours inits (they tick first,
 * GameImpl.ts:526-551), so ceil(stack·size) + 1 with size ≥ 1 wins.
 */
export function counterTroops(stack: number, size: number): number {
  return Math.ceil(stack * size) + 1;
}

/** Our border tiles 4-adjacent to N's land, in border order. */
export function frontTiles(game: Game, me: Player, N: Player): TileRef[] {
  const sid = N.smallID();
  const out: TileRef[] = [];
  let hit = false;
  const visit = (n: TileRef) => {
    if (!hit && game.ownerID(n) === sid) hit = true;
  };
  for (const t of me.borderTiles()) {
    hit = false;
    game.forEachNeighbor(t, visit);
    if (hit) out.push(t);
  }
  return out;
}

export interface PostSite {
  /** The tile to ask for (ours; the game builds at the valid tile nearest
   *  it, PlayerImpl.landBasedStructureSpawn). */
  tile: TileRef;
  /** Uncovered front tiles within reach of it. */
  covers: number;
}

/**
 * Where a defense post covers most of the front with N not yet covered
 * (docs/13 §5.8 and Config.ts:377-387: within defensePostRange of a post
 * of ours, attackers lose ×5 troops per tile and take ×3 as long). A front
 * tile is covered by a post within range − 1 of it. Candidates are every
 * k-th uncovered front tile (at most maxCands), each scored by the
 * uncovered front tiles within √(range² − depth²) − 1 of it, and moved
 * `depth` tiles inward (straight away from its neighbour of N's, the
 * farthest tile of ours on that line) so that an attack must take depth
 * tiles at the post's price before it reaches the post. Best first, ties
 * to the earlier candidate; empty when the front is covered.
 */
export function postSites(
  game: Game,
  me: Player,
  N: Player,
  front: readonly TileRef[],
  posts: readonly TileRef[],
  range: number,
  depth: number,
  maxCands: number,
): PostSite[] {
  const r2 = (range - 1) * (range - 1);
  const uncovered = front.filter((f) =>
    posts.every((p) => game.euclideanDistSquared(p, f) > r2),
  );
  if (uncovered.length === 0) return [];
  const reach = Math.max(1, Math.sqrt(range * range - depth * depth) - 1);
  const reach2 = reach * reach;
  const step = Math.max(1, Math.ceil(uncovered.length / maxCands));
  const sid = N.smallID();
  const mine = me.smallID();
  const out: PostSite[] = [];
  for (let i = 0; i < uncovered.length; i += step) {
    const c = uncovered[i];
    let covers = 0;
    for (const f of uncovered) {
      if (game.euclideanDistSquared(c, f) <= reach2) covers++;
    }
    let dx = 0;
    let dy = 0;
    game.forEachNeighbor(c, (n) => {
      if (dx === 0 && dy === 0 && game.ownerID(n) === sid) {
        dx = game.x(c) - game.x(n);
        dy = game.y(c) - game.y(n);
      }
    });
    let tile = c;
    for (let k = depth; k > 0; k--) {
      const x = game.x(c) + k * dx;
      const y = game.y(c) + k * dy;
      if (!game.isValidCoord(x, y)) continue;
      const t = game.ref(x, y);
      if (game.ownerID(t) === mine) {
        tile = t;
        break;
      }
    }
    out.push({ tile, covers });
  }
  out.sort((a, b) => b.covers - a.covers);
  return out;
}

/** When attackWhy reads a send (log only). */
export type WhyAt =
  /** A land attack, seen the tick after N's decision: what N saw. */
  | "decision"
  /** A transport ship first seen at sea, the tick after its launch (the
   *  ship took the troops then, PlayerImpl.buildUnit): what N saw. */
  | "sea"
  /** A boat's attack, which exists only once the ship lands
   *  (TransportShipExecution.ts:271-283), often 100 ticks or more after
   *  the launch: T and H have moved since, so the strategy flags are left
   *  out (the random boat skips a target with more troops than N,
   *  AiAttackBehavior.ts:243-250, yet landings logged H/T up to 1.26). */
  | "landing";

/**
 * Diagnostics for a fresh nation send of `a` troops at us (log only): N's
 * troops before the send (its troops now plus a), its share of its cap,
 * our home against the land line T/safe (safe = nm.sendCapSafe()), and,
 * but at a landing, which strategies of the Impossible list (docs/13 §5.8)
 * matched us: ret (we attack N), vw (veryWeak), traitor (N betrayed an
 * ally: N.isTraitor()), victim, juicy, hated, weakest (H < T). The send is
 * one of me.incomingAttacks() but at sea, so the victim test leaves it out
 * of the other incoming troops.
 */
export function attackWhy(
  me: Player,
  N: Player,
  a: number,
  models: Models,
  safe: number,
  at: WhyAt = "decision",
): string {
  const T = N.troops() + a;
  const M = models.cap(N);
  const H = me.troops();
  const cap = models.cap(me);
  const flags: string[] = [];
  let ours = 0;
  let ret = false;
  for (const x of me.outgoingAttacks()) {
    if (x.target() === N) ret = true;
    ours += x.troops();
  }
  if (ret) flags.push("ret");
  if (H < VERY_WEAK_CAP * cap && H < STRONGER_GUARD * T) flags.push("vw");
  if (N.isTraitor()) flags.push("traitor");
  let incoming = 0;
  for (const x of me.incomingAttacks()) incoming += x.troops();
  if (at !== "sea") incoming -= a;
  if (incoming > VICTIM_SHARE * H && H <= STRONGER_GUARD * T) {
    flags.push("victim");
  }
  if (H <= JUICY_SHARE * T) flags.push("juicy");
  if (N.relation(me) === Relation.Hostile && H <= HATED_GUARD * T) {
    flags.push("hated");
  }
  if (H < T) flags.push("weakest");
  const r = (x: number) => x.toFixed(2);
  return (
    `${at === "landing" ? "at landing " : ""}` +
    `T=${Math.round(T)} T/M=${r(T / M)} H/T=${r(H / T)} ` +
    `line=${r(T / safe / Math.max(1, H))} H/cap=${r(H / cap)} ` +
    `out=${Math.round(ours)} in=${Math.round(incoming)} ` +
    `tiles ${me.numTilesOwned()}/${N.numTilesOwned()}` +
    (at === "landing" ? "" : ` [${flags.join(",")}]`)
  );
}
