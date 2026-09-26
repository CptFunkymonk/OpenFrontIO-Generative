import { Game, Player, PlayerID, Relation } from "../../core/game/Game";
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
 * with a structure locks at d add nothing. In smallID order, so the result
 * is deterministic.
 */
export function deterrence(
  me: Player,
  nm: NationModel,
  models: Models,
  tick: number,
  low: number,
  cands: readonly PlayerID[],
  p: DeterrenceParams,
): Deterrence {
  const safe = nm.sendCapSafe();
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
      if (p.betrayShare <= 0) continue;
      const g = nm.gates(id, d);
      if (g === "locked" || g === "belowReserve") continue;
      const T = nm.troopsAt(id, d);
      term = { id, kind: "betray", d, T, floor: p.betrayShare * T };
    } else {
      if (!nm.canLandAttackUs(id, low, d)) continue;
      if (
        p.targetCheck &&
        nm.get(id)!.affordableTribes > p.tribeSlack &&
        nm.wouldTargetUs(id, low) === null
      ) {
        continue;
      }
      const T = nm.troopsAt(id, d);
      term = { id, kind: "land", d, T, floor: ((T + 1) / safe) * p.margin };
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

/** The largest line in `terms` of a nation other than `id` (0 with none). */
export function floorWithout(
  terms: readonly DeterrenceTerm[] | undefined,
  id: PlayerID,
): number {
  let f = 0;
  for (const t of terms ?? []) if (t.id !== id && t.floor > f) f = t.floor;
  return f;
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

/**
 * Diagnostics for a fresh nation attack of `a` troops on us (log only):
 * N's troops before the send (its troops now plus a), its share of its cap,
 * our home against the land line T/1.1, and which strategies of the
 * Impossible list (docs/13 §5.8) matched us at that decision: ret (we attack
 * N), vw (veryWeak), traitor (N betrayed an ally: N.isTraitor()), victim,
 * juicy, hated, weakest (H < T).
 */
export function attackWhy(
  me: Player,
  N: Player,
  a: number,
  models: Models,
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
  incoming -= a;
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
    `T=${Math.round(T)} T/M=${r(T / M)} H/T=${r(H / T)} ` +
    `line=${r(T / 1.1 / Math.max(1, H))} H/cap=${r(H / cap)} ` +
    `out=${Math.round(ours)} in=${Math.round(incoming)} ` +
    `tiles ${me.numTilesOwned()}/${N.numTilesOwned()} [${flags.join(",")}]`
  );
}
