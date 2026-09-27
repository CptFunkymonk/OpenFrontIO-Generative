import {
  Game,
  Player,
  PlayerID,
  PlayerType,
  UnitType,
} from "../../../../core/game/Game";
import type { TileRef } from "../../../../core/game/GameMap";
import type { AgentContext } from "../../../Agent";
import {
  hostileWarships,
  nearWarship,
  routeNearWarship,
} from "../../../agents/apex/controllers/NavalController";
import type { SearchHost } from "../../../agents/apex/policy";
import type { DirectiveStep } from "../../../agents/apex/state";
import {
  cellOf,
  RaceGrid,
  voyageAt,
  VoyageField,
  voyageField,
} from "../../RaceField";
import { Prio } from "../../Scheduler";
import type {
  BaseView,
  Candidate,
  CandidateGenerator,
  SearchView,
} from "../Registry";

// Package WP3 (docs/14-m4-plan.md §2.3 T6, §2.4, §3 WP3): boat:N:f, a strike
// across water. 29 of the 130 out-of-sample searches of the act3 prototype
// had no bordering nation, so no plan at all: Four Islands g23 11 of 11,
// Bering g3 8 of 17, Yellow Sea g12 5 of 17, Mississippi g26 4 of 17 once
// it held 55% of the land with everything else across the river.
//
// Made while no nation borders us (contact ≥ searchMinContact), for the
// searchK nations across water nearest by sea, unallied and attackable:
// - the landing: the ocean-shore border tile of N nearest our coast on the
//   voyage field (RaceField.voyageField from our ocean-shore border sample,
//   a BFS over the race grid's water cells; computed here, read only), at
//   most searchBoatMaxVoyage tiles of sea (ties: the lowest tile). A boat's
//   landing is the target's reachable shore nearest the tile it is sent to
//   (TransportShipUtils.targetTransportTile), so the tile is the landing;
// - skipped when a warship that may shoot our boats lies within its
//   targeting range (+ boatWarshipMargin) of the landing, of the estimated
//   sea route (NavalController.routeNearWarship, as the naval guard reads
//   it), or of the straight line from the launch tile the game would pick
//   (me.canBuild(TransportShip): false for no launch, when no boat is free);
// - steps: a foe mark on N from now to the landing + BOAT_FOE_TICKS (no
//   request, extension or counter-accept of ours with N while our stack
//   lands and fights: an alliance would stop the attack), and the boat now
//   with share f of purse.available("strike") at the send (spend kind
//   strike, plan "boat" on N: the Ledger keeps a boat plan while its ship
//   heads for N's tile, then while the landing's attack on N runs);
// - judged from the landing (lastSend = the voyage + LANDING_SLACK ticks;
//   a boat sails a tile a tick, ETA ≈ route + 1 [PIN BoatsAndWin]), and
//   from HStrong after it when N then holds ≥ searchStrongShare of our home.
// The stack gate orders the boats as the core orders strikes: S ≥ N's
// troops plus its attacks on us, else last.
//
// T6 (the naval trigger, SearchController) asks wantsNaval while no nation
// borders us and home idles near the cap: whether some nation lies within
// searchBoatMaxVoyage clear of warships at the landing and on the route,
// memoised per OwnerGrid (the policy builds one every 100 ticks), since the
// controller asks it every such tick.

/** Ticks added to the voyage estimate for the landing: the judged horizon
 *  counts from it. */
export const LANDING_SLACK = 20;
/** The foe mark holds this many ticks past the landing (a lapse's). */
export const BOAT_FOE_TICKS = 900;

/** The landing of a boat plan on nation N. */
export interface BoatLanding {
  N: Player;
  tile: TileRef;
  /** Tiles of sea on the voyage field (−1: none reached). */
  voyage: number;
}

/**
 * N's ocean-shore border tile nearest our coast on the voyage field `f`
 * (ties: the lowest tile), or null when the field reaches none of them.
 */
export function landingOn(
  game: Game,
  grid: RaceGrid,
  f: VoyageField,
  N: Player,
): { tile: TileRef; voyage: number } | null {
  const best = { tile: -1, voyage: Infinity };
  N.borderTiles().forEach((t) => {
    if (!game.isOceanShore(t)) return;
    const d = voyageAt(f, grid, cellOf(grid, game, t));
    if (d < 0) return;
    if (d < best.voyage || (d === best.voyage && t < best.tile)) {
      best.tile = t;
      best.voyage = d;
    }
  });
  return best.tile < 0 ? null : best;
}

/** Whether a nation borders us (contact ≥ minContact) in the last scan. */
function landNeighbour(sv: Pick<SearchView, "game" | "wm" | "o">): boolean {
  return sv.wm.nations.some(
    (n) =>
      n.type === PlayerType.Nation &&
      n.contact >= sv.o.searchMinContact &&
      sv.game.hasPlayer(n.id) &&
      sv.game.player(n.id).isAlive(),
  );
}

/**
 * The nations across water a boat plan may land on, nearest by sea first
 * (ties: ascending smallID): alive, unallied, attackable, with a landing
 * within `max` tiles of sea that no hostile warship guards (the landing and
 * the estimated route).
 */
export function boatLandings(
  game: Game,
  me: Player,
  grid: RaceGrid,
  f: VoyageField,
  max: number,
  warshipMargin: number,
): BoatLanding[] {
  const guard = hostileWarships(game, me);
  const reach = game.config().warshipTargettingRange() + warshipMargin;
  const out: BoatLanding[] = [];
  for (const N of game.players()) {
    if (N === me || N.type() !== PlayerType.Nation || !N.isAlive()) continue;
    if (me.isAlliedWith(N) || !me.canAttackPlayer(N)) continue;
    const l = landingOn(game, grid, f, N);
    if (l === null || l.voyage > max) continue;
    if (nearWarship(game, guard, l.tile, l.tile, reach)) continue;
    if (routeNearWarship(game, grid, f, l.tile, guard, reach)) continue;
    out.push({ N, tile: l.tile, voyage: l.voyage });
  }
  return out.sort(
    (a, b) => a.voyage - b.voyage || a.N.smallID() - b.N.smallID(),
  );
}

/** The boat step: share `frac` of the strike purse at the send. */
export function boatStep(
  N: Player,
  tile: TileRef,
  at: number,
  frac: number,
): DirectiveStep {
  return {
    at,
    frac,
    label: `boat ${N.id()} ${frac}`,
    p: {
      intent: { type: "boat", troops: 1, dst: tile },
      prio: Prio.Strike,
      cls: "boat",
      key: `boat:${tile}`,
      spend: { kind: "strike", troops: 1 },
      plan: "boat",
      meta: { target: N.smallID(), expectedRefund: 0 },
    },
  };
}

/** The voyage field of the live game now (our ocean-shore border sample of
 *  the last scan), or null without a race grid or a shore. */
function fieldNow(
  game: Game,
  grid: RaceGrid | null,
  shore: readonly TileRef[],
): VoyageField | null {
  if (grid === null || shore.length === 0) return null;
  return voyageField(game, grid, shore);
}

/** Troops of `id`'s attacks on us now. */
function incomingFrom(me: Player, id: PlayerID): number {
  let inc = 0;
  for (const a of me.incomingAttacks()) {
    if (a.attacker().id() === id) inc += a.troops();
  }
  return inc;
}

/** T6's memo: per game, the OwnerGrid stamp asked last and its answer. */
const navalMemo = new WeakMap<Game, { stamp: number; want: boolean }>();

export const BOAT: CandidateGenerator = {
  name: "boat",
  phase: "r1",
  kinds: ["boat"],
  generate(sv: SearchView, _base: BaseView): Candidate[] {
    const { o, game, me, t, kinds } = sv;
    if (!o.searchBoat || !kinds.has("boat")) return [];
    if (landNeighbour(sv)) return [];
    const grid = sv.host.race();
    const f = fieldNow(game, grid, sv.wm.shoreSample);
    if (grid === null || f === null) return [];
    const guard = hostileWarships(game, me);
    const reach = game.config().warshipTargettingRange() + o.boatWarshipMargin;
    const avail = sv.host.available("strike");
    const out: Candidate[] = [];
    let k = 0;
    for (const l of boatLandings(
      game,
      me,
      grid,
      f,
      o.searchBoatMaxVoyage,
      o.boatWarshipMargin,
    )) {
      if (k >= o.searchK) break;
      // The launch the game would pick (a read-only probe; false: no free
      // boat, or no shore of ours reaches the landing).
      const src = me.canBuild(UnitType.TransportShip, l.tile);
      if (src === false) continue;
      if (nearWarship(game, guard, src, l.tile, reach)) continue;
      k++;
      const N = l.N;
      const id = N.id();
      const land = Math.ceil(l.voyage) + LANDING_SLACK;
      const need = N.troops() + incomingFrom(me, id);
      for (const frac of o.searchFracs) {
        out.push({
          name: `boat:${id}:${frac}`,
          kind: "boat",
          target: id,
          steps: [
            { at: t, foe: { id, until: t + land + BOAT_FOE_TICKS } },
            boatStep(N, l.tile, t, frac),
          ],
          lastSend: land,
          isBreak: false,
          strongCheck: true,
          frac,
          defensive: false,
          gate: { S: Math.floor(frac * avail), need },
        });
      }
    }
    return out;
  },
  wantsNaval(ctx: AgentContext, host: SearchHost): boolean {
    const o = host.o;
    if (!o.searchBoat) return false;
    const og = host.owners();
    const grid = host.race();
    const wm = host.wm();
    if (og === null || grid === null || wm === null) return false;
    const game = ctx.game;
    const memo = navalMemo.get(game);
    if (memo !== undefined && memo.stamp === og.stamp) return memo.want;
    const f = fieldNow(game, grid, wm.shoreSample);
    const want =
      f !== null &&
      boatLandings(
        game,
        ctx.me,
        grid,
        f,
        o.searchBoatMaxVoyage,
        o.boatWarshipMargin,
      ).length > 0;
    navalMemo.set(game, { stamp: og.stamp, want });
    return want;
  },
};
