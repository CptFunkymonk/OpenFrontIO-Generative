/**
 * Package WP3 (docs/14-m4-plan.md §2.4, §3 WP3): boat:N:f
 * (lib/search/cands/boat.ts), on a synthetic channel map (the directive
 * test world with a sea between us and a nation, and a peninsula of its
 * reaching toward our coast).
 *
 * Claims:
 * - The landing is the nation's ocean-shore border tile nearest our coast
 *   on the voyage field (RaceField.voyageField from our ocean-shore border
 *   tiles), ties to the lowest tile: the tip of the peninsula, not the
 *   main coast.
 * - boatLandings: nearest by sea; none over the voyage limit, none when
 *   allied, none when a hostile warship lies within its targeting range (+
 *   margin) of the landing.
 * - BOAT.generate: off, or with a land neighbour, nothing; else for each
 *   share a plan with a foe mark on N to the landing + 900 and the boat
 *   step (spend kind strike, plan boat, meta.target N, key boat:<tile>),
 *   judged from the landing (lastSend = voyage + LANDING_SLACK), with the
 *   stack gate at N's troops.
 */
import { APEX_DEFAULTS } from "../../../src/agent/agents/apex/options";
import {
  buildRaceGrid,
  cellOf,
  voyageAt,
  voyageField,
} from "../../../src/agent/lib/RaceField";
import {
  BOAT,
  BOAT_FOE_TICKS,
  boatLandings,
  LANDING_SLACK,
  landingOn,
} from "../../../src/agent/lib/search/cands/boat";
import type { SearchView } from "../../../src/agent/lib/search/Registry";
import { PlayerType, UnitType } from "../../../src/core/game/Game";
import { H, liveView, NO_BASE, W, world } from "./SearchWorld";

const LAND = 0x80 | 5;
const OCEAN = 0x20;
const SHORE = 0x40;

/** Land on x < 80 (ours) and x ≥ 120 (the nation's), a peninsula of the
 *  nation's on x 110..119, y 45..54, sea between. */
function isLand(x: number, y: number): boolean {
  return x < 80 || x >= 120 || (x >= 110 && y >= 45 && y < 55);
}
function terrain(x: number, y: number): number {
  if (!isLand(x, y)) return OCEAN;
  const nearSea =
    (x > 0 && !isLand(x - 1, y)) ||
    (x + 1 < W && !isLand(x + 1, y)) ||
    (y > 0 && !isLand(x, y - 1)) ||
    (y + 1 < H && !isLand(x, y + 1));
  return LAND | (nearSea ? SHORE : 0);
}

const B = "NATIONBB";

function channel(options: Record<string, unknown> = {}) {
  const w = world(options, {
    terrain,
    ours: [0, 0, 80, H],
    nations: [
      {
        id: B,
        rect: [120, 0, W, H],
        also: [[110, 45, 120, 55]],
        troops: 300_000,
      },
    ],
  });
  // A scan and a host (the policy decides every 100 ticks).
  for (let i = 0; i < 120; i++) w.h.step();
  const game = w.game;
  const grid = buildRaceGrid(game, APEX_DEFAULTS);
  const shore: number[] = [];
  w.us.borderTiles().forEach((t) => {
    if (game.isOceanShore(t)) shore.push(t);
  });
  const f = voyageField(game, grid, shore);
  return { w, game, grid, shore, f, N: w.nation(B) };
}

describe("the boat landing", () => {
  test("the nation's ocean-shore tile nearest our coast by sea: the peninsula's tip", () => {
    const { game, grid, shore, f, N } = channel();
    expect(shore.length).toBe(H);
    const l = landingOn(game, grid, f, N)!;
    expect(l).not.toBeNull();
    // The tip's face (x 110, y 45..54) all tie on the voyage; the lowest
    // tile is (110, 45).
    expect([game.x(l.tile), game.y(l.tile)]).toEqual([110, 45]);
    expect(game.isOceanShore(l.tile)).toBe(true);
    expect(game.owner(l.tile)).toBe(N);
    expect(l.voyage).toBe(voyageAt(f, grid, cellOf(grid, game, l.tile)));
    // Nearer than the main coast.
    const main = voyageAt(f, grid, cellOf(grid, game, game.ref(120, 20)));
    expect(main).toBeGreaterThan(l.voyage);
    expect(l.voyage).toBeGreaterThan(0);
  });

  test("boatLandings: within the limit, unallied, not under a warship's guns", () => {
    const { w, game, grid, f, N } = channel();
    const margin = APEX_DEFAULTS.boatWarshipMargin;
    const l = landingOn(game, grid, f, N)!;
    const all = boatLandings(game, w.us, grid, f, l.voyage, margin);
    expect(all.map((x) => [x.N.id(), x.tile, x.voyage])).toEqual([
      [B, l.tile, l.voyage],
    ]);
    expect(boatLandings(game, w.us, grid, f, l.voyage - 1, margin)).toEqual([]);
    // A hostile warship at the tip: the landing is guarded.
    const sea = game.ref(105, 50);
    expect(game.isOcean(sea)).toBe(true);
    const ship = N.buildUnit(UnitType.Warship, sea, { patrolTile: sea });
    expect(boatLandings(game, w.us, grid, f, l.voyage, margin)).toEqual([]);
    ship.delete(false);
    expect(boatLandings(game, w.us, grid, f, l.voyage, margin)).toHaveLength(1);
  });
});

describe("boat:N:f", () => {
  /** The live view with the race grid and shore the policy would hold
   *  (boats and the web are off in the world, so it builds none). */
  function boatView(
    c: ReturnType<typeof channel>,
    o: Record<string, unknown> = {},
    nations?: unknown[],
  ): SearchView {
    const sv = liveView(c.w, { searchBoat: true, ...o });
    const host = Object.create(sv.host);
    host.race = () => c.grid;
    host.available = () => 1_000_000;
    return {
      ...sv,
      host,
      wm: { ...sv.wm, shoreSample: c.shore, nations: nations ?? sv.wm.nations },
    } as SearchView;
  }

  test("the plans, their steps and horizon", () => {
    const c = channel();
    const { game, grid, f, N, w } = c;
    const sv = boatView(c);
    const l = landingOn(game, grid, f, N)!;
    const cands = BOAT.generate(sv, NO_BASE);
    expect(cands.map((x) => x.name)).toEqual([`boat:${B}:0.5`, `boat:${B}:1`]);
    const land = Math.ceil(l.voyage) + LANDING_SLACK;
    const t = sv.t;
    for (const [i, frac] of [0.5, 1].entries()) {
      const x = cands[i];
      expect(x).toMatchObject({
        kind: "boat",
        target: B,
        lastSend: land,
        isBreak: false,
        strongCheck: true,
        frac,
        defensive: false,
        gate: { S: Math.floor(frac * 1_000_000), need: N.troops() },
      });
      expect(x.steps).toHaveLength(2);
      expect(x.steps[0]).toEqual({
        at: t,
        foe: { id: B, until: t + land + BOAT_FOE_TICKS },
      });
      const s = x.steps[1];
      expect(s.at).toBe(t);
      expect(s.frac).toBe(frac);
      expect(s.p).toMatchObject({
        intent: { type: "boat", troops: 1, dst: l.tile },
        cls: "boat",
        key: `boat:${l.tile}`,
        spend: { kind: "strike", troops: 1 },
        plan: "boat",
        meta: { target: N.smallID(), expectedRefund: 0 },
      });
    }
    // The game would launch it: a shore of ours reaches the landing.
    expect(w.us.canBuild(UnitType.TransportShip, l.tile)).not.toBe(false);
    // Off: nothing. A land neighbour (contact ≥ searchMinContact): nothing.
    expect(BOAT.generate(boatView(c, { searchBoat: false }), NO_BASE)).toEqual(
      [],
    );
    const nb = [{ id: B, type: PlayerType.Nation, contact: 50 }];
    expect(BOAT.generate(boatView(c, {}, nb), NO_BASE)).toEqual([]);
    expect(
      BOAT.generate(boatView(c, {}, [{ ...nb[0], contact: 7 }]), NO_BASE),
    ).toHaveLength(2);
    // Over the voyage limit: nothing.
    expect(
      BOAT.generate(
        boatView(c, { searchBoatMaxVoyage: l.voyage - 1 }),
        NO_BASE,
      ),
    ).toEqual([]);
  });

  test("T6 asks wantsNaval: a landing within reach, memoised per owner grid", () => {
    const c = channel();
    const host = Object.create(c.w.probe.host!);
    host.race = () => c.grid;
    host.owners = () => ({ stamp: 7 });
    host.wm = () => ({ ...c.w.probe.host!.wm()!, shoreSample: c.shore });
    const ctx = c.w.probe.ctx!;
    host.o = { ...host.o, searchBoat: true };
    expect(BOAT.wantsNaval!(ctx, host)).toBe(true);
    host.o = { ...host.o, searchBoat: false };
    expect(BOAT.wantsNaval!(ctx, host)).toBe(false);
    // Off the memo: a shorter limit at a new stamp finds nothing.
    host.o = { ...host.o, searchBoat: true, searchBoatMaxVoyage: 1 };
    expect(BOAT.wantsNaval!(ctx, host)).toBe(true);
    host.owners = () => ({ stamp: 8 });
    expect(BOAT.wantsNaval!(ctx, host)).toBe(false);
  });
});
