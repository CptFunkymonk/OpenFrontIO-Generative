/**
 * Pins the rule the gold policy relies on (package WP8, docs/14-m4-plan.md
 * §1.7, §2.8 item 2; lib/GoldPolicy.ts): an Impossible nation's aimed
 * atom and hydrogen bombs follow STRUCTURES, not land, and never an ally.
 *
 * The claim: an Impossible nation with a finished silo and bomb gold,
 * whose ladder names us by a crown rung (we hold more than half the
 * non-fallout land, we lead it by more than 10 points, or it leads and we
 * are the runner-up), sends no atom or hydrogen bomb while we own no
 * structure; it sends one at the next decision once we start a City; with
 * only a SAM it salvos the SAM; and as our ally it bombs nothing of ours.
 *
 * VERDICT: TRUE, with two refinements. The code is the spec
 * (NationNukeBehavior.ts, NNB):
 *
 * - WHO: the crown rungs of findBestNukeTarget (:256-274 crown50, :351-417
 *   crownLead and runnerUp) skip a friendly player (isFriendly), and every
 *   other rung but "two players left" (:224-233) does too; with none
 *   answering, the decision ends (:126-129). The agent's replica
 *   (lib/NukeModel.aimOf) names the same rung.
 * - WHERE: the aim candidates are 30 random tiles of ours plus our
 *   structures (:158-169); each scores the structures within its outer
 *   radius (nukeTileScore :706-804: City 25k a level, Silo 50k, Port and
 *   Factory 15k, Defense post 5k, SAM 0), less 30 a tile to the nearest
 *   silo, keeping 20%. The best must score > 0 at Impossible (:212-216),
 *   so bare land never draws an aimed bomb, whatever the bomb.
 * - Refinement 1: a City draws it from the tick its construction starts
 *   (ConstructionExecution builds the unit at once, under construction;
 *   units(Structures.types) lists it), 20 ticks before its level counts in
 *   the cap.
 * - Refinement 2: "only a SAM" draws bombs either way. With atom money
 *   the best score is 0, so the decision falls to maybeDestroyEnemySam
 *   (:217-218): level + 1 = 2 atoms at the SAM's tile from two ready silo
 *   slots; with one slot it buys a silo level instead (:1056-1060) and
 *   salvos at a later decision. With hydrogen money the SAM itself scores
 *   100k a level from any aim point that outranges it (> 70 tiles, within
 *   100, :749-778): one hydrogen bomb, which the SAM cannot intercept.
 *
 * Setting: tests/agent/apex/NukeWorld.ts (the real Config, FFA,
 * Singleplayer, Impossible; all-plains maps; no PlayerExecution runs, so
 * gold, troops and relations stay where the test puts them). The nation's
 * behaviours are the ones NationExecution.initializeBehaviors wires,
 * seeded as in a game, and its decision (maybeSendNuke) is called once
 * every DECISION ticks, as NationExecution calls it at Impossible (every
 * 30-49 ticks, the attack rate). A third player keeps the count at three
 * (with two the "two players left" rung answers first).
 */
import { ConstructionExecution } from "../../../src/core/execution/ConstructionExecution";
import { PlayerType, Structures, UnitType } from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import {
  ally,
  brain,
  columns,
  model,
  NukeBrain,
  pastImmunity,
  samAt,
  setGold,
  siloAt,
  tick,
  World,
  world,
} from "../apex/NukeWorld";

/** Ticks between two nuke decisions of a nation at Impossible. */
const DECISION = 40;
/** Decisions watched for a bomb that never comes. */
const WATCH = 15;

const W = 300;
const H = 200;
/** An atom bomb with room to spare, but no hydrogen bomb (5M). */
const ATOM_MONEY = 1_000_000n;
/** A hydrogen bomb at its real (and first perceived) price. */
const HYDRO_MONEY = 10_000_000n;

type Rung = "crown50" | "crownLead" | "runnerUp";

/**
 * Three vertical strips: N (the nation), H (us, the human) and Z (a third
 * human), with unowned land to the right. H's strip stops MARGIN tiles
 * short of the top and bottom edges, so its border tiles span it as a real
 * territory's do: a nation draws its 30 random aim tiles from the bounding
 * box of the target's BORDER tiles (NNB :163, NationUtils
 * randTerritoryTileArray), and the map edge is no border. `city` is a tile
 * deep in H whose atom rings (30, 15) hold only H's land; in the crown50
 * world its hydrogen rings (100, 50) hold only H's land and unowned tiles.
 */
const MARGIN = 3;
const WORLDS: Record<
  Rung,
  {
    strips: [string | null, number][];
    city: [number, number];
  }
> = {
  // H holds 57% of the land: more than half (NNB :256-274).
  crown50: {
    strips: [
      ["N", 60],
      ["Z", 60],
      ["H", 177],
      [null, 3],
    ],
    city: [230, 100],
  },
  // H 34%, N 15%, Z 25%: H leads N by 0.19 > 0.1 (NNB :384-414).
  crownLead: {
    strips: [
      ["N", 45],
      ["H", 105],
      ["Z", 75],
      [null, 75],
    ],
    city: [100, 100],
  },
  // N 40% leads, H 29% is second, Z 20%: a leader aims at the runner-up
  // at any margin (NNB :367-377).
  runnerUp: {
    strips: [
      ["N", 120],
      ["H", 90],
      ["Z", 60],
      [null, 30],
    ],
    city: [165, 100],
  },
};

/** The strips, H's cut MARGIN tiles short of the top and bottom edges. */
function seats(strips: [string | null, number][]) {
  const strip = columns(strips);
  return (x: number, y: number) => {
    const key = strip(x, y);
    return key === "H" && (y < MARGIN || y >= H - MARGIN) ? null : key;
  };
}

interface Scene {
  w: World;
  nuke: NukeBrain;
  city: TileRef;
}

/** The world of `rung` with N's finished silos at x = 20, past spawn
 *  immunity; N is no hydro nation unless `hydro`. */
function scene(rung: Rung, silos = 1, hydro = false): Scene {
  const spec = WORLDS[rung];
  const w = world(
    W,
    H,
    { N: PlayerType.Nation, H: PlayerType.Human, Z: PlayerType.Human },
    seats(spec.strips),
  );
  for (let i = 0; i < silos; i++) siloAt(w, w.p.N, 20, 60 + 40 * i);
  pastImmunity(w);
  return {
    w,
    nuke: brain(w, "N", hydro),
    city: w.game.ref(spec.city[0], spec.city[1]),
  };
}

/** One decision every DECISION ticks, `n` times, gold topped up to `gold`
 *  before each; the bombs (and upgrades) it created, as recorded. */
function decide(s: Scene, n: number, gold: bigint) {
  const from = s.w.nukes.length;
  const ups = s.w.upgrades.length;
  for (let i = 0; i < n; i++) {
    setGold(s.w.p.N, gold);
    s.nuke.maybeSendNuke();
    tick(s.w, DECISION);
  }
  return {
    bombs: s.w.nukes.slice(from),
    upgrades: s.w.upgrades.length - ups,
  };
}

const dist = (s: Scene, a: TileRef, b: TileRef) =>
  Math.sqrt(s.w.game.euclideanDistSquared(a, b));

/** Our structures, finished or not. */
const structures = (s: Scene) => s.w.p.H.units(Structures.types);

/** Starts a City at `tile` the way a build_unit intent does (with its
 *  price in gold), and runs the two ticks after which the unit stands under
 *  construction. */
function startCity(s: Scene, tile: TileRef) {
  const price = s.w.game.unitInfo(UnitType.City).cost(s.w.game, s.w.p.H);
  setGold(s.w.p.H, price);
  s.w.game.addExecution(
    new ConstructionExecution(s.w.p.H, UnitType.City, tile),
  );
  tick(s.w, 2);
  const [c] = s.w.p.H.units(UnitType.City);
  expect(c).toBeDefined();
  expect(c.isUnderConstruction()).toBe(true);
  return c;
}

/** Runs until no bomb or SAM missile is in flight. */
function settle(w: World, max = 600): void {
  const flying = () =>
    w.game.units(UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.SAMMissile)
      .length;
  for (let n = 0; n < max && (n < 2 || flying() > 0); n++) tick(w);
  expect(flying()).toBe(0);
}

const RUNGS: Rung[] = ["crown50", "crownLead", "runnerUp"];

describe("WP8 pin: an Impossible nation's bombs follow our structures (NationNukeBehavior)", () => {
  it.each(RUNGS)(
    "%s: the ladder names us, and the replica (NukeModel.aimOf) agrees",
    (rung) => {
      const s = scene(rung);
      setGold(s.w.p.N, ATOM_MONEY);
      expect(s.nuke.findBestNukeTarget()).toBe(s.w.p.H);
      expect(model(s.w, "H").aimOf(s.w.p.N.id())).toEqual({
        target: s.w.p.H.id(),
        reason: rung,
      });
    },
  );

  it.each(RUNGS)(
    "%s: while we own no structure, no atom or hydrogen bomb in 15 decisions; once we start a City, one at the next decision, and it takes the city",
    (rung) => {
      const s = scene(rung);
      const { w } = s;
      w.dryRun = true;
      expect(structures(s)).toHaveLength(0);
      // Atom money, not a hydro nation: it would fire an atom at anything
      // that scores.
      expect(decide(s, WATCH, ATOM_MONEY).bombs).toEqual([]);
      // Hydrogen money: the type choice picks a hydrogen bomb (NNB
      // :139-155), which finds no scoring tile either.
      expect(decide(s, WATCH, HYDRO_MONEY).bombs).toEqual([]);
      // A hydro nation with hydrogen money, likewise.
      const hydro = brain(w, "N", true);
      expect(hydro.isHydroNation).toBe(true);
      setGold(w.p.N, HYDRO_MONEY);
      hydro.maybeSendNuke();
      expect(w.nukes).toEqual([]);

      // The City, still under construction (its level not yet in the
      // cap), draws the next decision's bomb.
      const cap = w.config.maxTroops(w.p.H);
      const c = startCity(s, s.city);
      expect(w.config.maxTroops(w.p.H)).toBe(cap);
      const { bombs } = decide(s, 1, ATOM_MONEY);
      expect(bombs.map((b) => [b.from, b.type])).toEqual([
        [w.p.N, UnitType.AtomBomb],
      ]);
      expect(dist(s, bombs[0].dst, c.tile())).toBeLessThanOrEqual(
        w.config.nukeMagnitudes(UnitType.AtomBomb).outer,
      );
      expect(w.game.owner(bombs[0].dst)).toBe(w.p.H);

      // For real: the bomb flies and the city is gone.
      const live = scene(rung);
      const lc = startCity(live, live.city);
      decide(live, 1, ATOM_MONEY);
      settle(live.w);
      expect(lc.isActive()).toBe(false);
      expect(live.w.p.H.units(UnitType.City)).toHaveLength(0);
    },
  );

  it("crown50 with hydrogen money: a City draws a hydrogen bomb, and so does a lone SAM, from an aim point that outranges it", () => {
    const s = scene("crown50");
    const { w } = s;
    w.dryRun = true;
    startCity(s, s.city);
    expect(decide(s, 1, HYDRO_MONEY).bombs.map((b) => b.type)).toEqual([
      UnitType.HydrogenBomb,
    ]);
    // Only a SAM: its 100k a level makes the score > 0 wherever the aim
    // point outranges it (NNB :749-778).
    const t = scene("crown50");
    t.w.dryRun = true;
    const sam = samAt(t.w, t.w.p.H, 230, 100);
    tick(t.w, 2);
    const { bombs } = decide(t, 1, HYDRO_MONEY);
    expect(bombs.map((b) => b.type)).toEqual([UnitType.HydrogenBomb]);
    expect(t.w.game.owner(bombs[0].dst)).toBe(t.w.p.H);
    const d = dist(t, bombs[0].dst, sam.tile());
    expect(d).toBeGreaterThan(t.w.config.samRange(sam.level()));
    expect(d).toBeLessThanOrEqual(
      t.w.config.nukeMagnitudes(UnitType.HydrogenBomb).outer,
    );
  });

  it.each(RUNGS)(
    "%s: with only a SAM and atom money, it salvos the SAM: 2 atoms at its tile from two ready slots; with one slot it first buys a silo level, then salvos",
    (rung) => {
      const two = scene(rung, 2);
      two.w.dryRun = true;
      const [x, y] = WORLDS[rung].city;
      const sam = samAt(two.w, two.w.p.H, x, y);
      tick(two.w, 2);
      const { bombs } = decide(two, 1, 2n * ATOM_MONEY);
      expect(bombs.map((b) => [b.type, b.dst])).toEqual([
        [UnitType.AtomBomb, sam.tile()],
        [UnitType.AtomBomb, sam.tile()],
      ]);
      // One level-1 silo: one slot short of the salvo, it upgrades the
      // silo (instant, 1M) and fires no bomb; once the new slot has
      // reloaded, a later decision fires the salvo.
      const one = scene(rung, 1);
      const lone = samAt(one.w, one.w.p.H, x, y);
      tick(one.w, 2);
      const first = decide(one, 1, 2n * ATOM_MONEY);
      expect(first.bombs).toEqual([]);
      expect(first.upgrades).toBe(1);
      expect(one.w.p.N.units(UnitType.MissileSilo)[0].level()).toBe(2);
      let salvo: { type: UnitType; dst: TileRef }[] = [];
      for (let i = 0; i < 10 && salvo.length === 0; i++) {
        salvo = decide(one, 1, 2n * ATOM_MONEY).bombs;
      }
      expect(salvo.map((b) => [b.type, b.dst])).toEqual([
        [UnitType.AtomBomb, lone.tile()],
        [UnitType.AtomBomb, lone.tile()],
      ]);
    },
  );

  it.each(RUNGS)(
    "%s: as our ally the nation names no one and bombs no city of ours in 30 decisions; once the alliance ends, its next decision bombs the city",
    (rung) => {
      const s = scene(rung);
      const { w } = s;
      w.dryRun = true;
      ally(w.p.N, w.p.H);
      startCity(s, s.city);
      setGold(w.p.N, ATOM_MONEY);
      expect(s.nuke.findBestNukeTarget()).toBeNull();
      expect(model(w, "H").aimOf(w.p.N.id()).target).toBeNull();
      expect(decide(s, WATCH, ATOM_MONEY).bombs).toEqual([]);
      expect(decide(s, WATCH, HYDRO_MONEY).bombs).toEqual([]);
      w.p.N.allianceWith(w.p.H)!.expire();
      expect(w.p.N.isFriendly(w.p.H)).toBe(false);
      const { bombs } = decide(s, 1, ATOM_MONEY);
      expect(bombs.map((b) => [b.from, b.type])).toEqual([
        [w.p.N, UnitType.AtomBomb],
      ]);
    },
  );
});
