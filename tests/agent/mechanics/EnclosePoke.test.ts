/**
 * Pins spec C10 (apex spec §3.6.5, §6.1 "EnclosePoke"): a tribe enclosed by
 * our land alone, touching no water and no map edge, is ours whole, gold
 * included, within 25 ticks of a poke (a small attack that changes its
 * tiles); with a shore, the map edge or a second owner the poke takes only
 * the tiles it conquers.
 *
 * The rules (the code is the spec; src/core/execution/PlayerExecution.ts):
 * - The cluster check runs in the tribe's PlayerExecution.tick (:120-133)
 *   only if the tribe's tiles changed since the last check
 *   (lastTileChange() >= lastCalc) and 20 ticks passed since it
 *   (TICKS_PER_CLUSTER_CALC :27; every tick below 100 tiles). Our tiles
 *   changing around it does not count: that is why an enclosed tribe sits
 *   untouched until something takes one of its tiles, and why a poke works.
 * - removeClusters (:139-321) walks the clusters of its BORDER tiles. With
 *   one cluster, surroundedBySamePlayer (:366-421) requires, for every
 *   border tile: not an ocean shore, not on the map edge (isOnEdgeOfMap,
 *   which also counts impassable neighbours, GameMap.ts:340-355); no
 *   4-neighbour with owner 0 (unowned land, and water of any kind, lakes
 *   included, which is never owned); exactly one foreign owner over the
 *   whole cluster; and that owner's neighbouring tiles' bounding box
 *   contains the cluster's. It must not be friendly with the tribe.
 * - removeCluster (:473-518) then checks isEnclosed (:531-563): a flood
 *   from the cluster through the tribe's own tiles and unowned land must
 *   reach neither water nor the edge. The flood's tiles go to
 *   getCapturingPlayer (the unfriendly neighbour with the most contact),
 *   and if they are all the tribe's tiles, GameImpl.conquerPlayer runs
 *   first: the captor takes the tribe's gold (Config.conquerGoldAmount,
 *   all of a tribe's) and the tribe is dead.
 * - The poke: any attack of >= 1 troop takes at least one tile (the stack
 *   is checked only before each tile, AttackExecution.ts:296-300)
 *   [PIN TribeStats].
 *
 * The agent side: ExpansionController.scanTribe's `enclosed` (one pass over
 * the tribe's border tiles: no ocean shore, no map edge, every 4-neighbour
 * the tribe's or ours) is checked against the outcome in every case.
 *
 * VERDICT TRUE. Enclosed inland tribe (400 tiles, 20,000 troops): untouched
 * for 60 ticks without a poke; with a 300-troop poke it is ours whole, gold
 * included, within 25 ticks. How soon depends on its last check: when that
 * is more than 20 ticks old (a tribe whose tiles stopped changing), the
 * capture comes the tick after the poke's first tile (3 ticks from the
 * send); right after a check that found it still open, it waits out the
 * 20-tick interval (22 ticks here). Map edge, ocean shore, lake shore, a
 * second owner: the poke takes its few tiles and nothing else happens.
 * scanTribe agrees in every case.
 *
 * Setting: the real Config (FFA, Singleplayer, Impossible), synthetic
 * plains built as the other pins build theirs (tests/agent/apex/Field.ts);
 * the tribe has its PlayerExecution (as SpawnExecution gives it) but no
 * TribeExecution, so it never attacks; our attack goes through IntentSchema
 * and Executor.createExec, the path of ctx.send.
 */
import { scanTribe } from "../../../src/agent/agents/apex/controllers/ExpansionController";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import { Player, PlayerInfo, PlayerType } from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import { Field, field, own, rect, submit, Terrain } from "../apex/Field";

const N = 60;
const TRIBE_TROOPS = 20_000;
const TRIBE_GOLD = 7_000n;
const POKE = 300;

type Case = "inland" | "edge" | "ocean" | "lake" | "secondOwner";

interface Scene {
  f: Field;
  tribe: Player;
  tribeTiles: number;
}

/**
 * A 20 × 20 tribe with our land 3 tiles thick around it, free land beyond.
 * - inland: at [20, 40)²;
 * - edge: at x ∈ [0, 20), so its west side is the map edge;
 * - ocean / lake: inland, but the column x = 19 beside it is water (and
 *   our ring is outside that column);
 * - secondOwner: inland, with another tribe on the 3 columns west of it.
 */
async function scene(c: Case): Promise<Scene> {
  const x0 = c === "edge" ? 0 : 20;
  const y0 = 20;
  const water: Terrain | null =
    c === "ocean" ? "water" : c === "lake" ? "lake" : null;
  const f = await field({
    width: N,
    height: N,
    terrain: (x, y) =>
      water !== null && x === x0 - 1 && y >= y0 - 1 && y <= y0 + 20
        ? water
        : "plains",
  });
  const tribe = f.game.addPlayer(
    new PlayerInfo("tribe", PlayerType.Bot, null, "POKE0001"),
  );
  const inTribe = (x: number, y: number) =>
    x >= x0 && x < x0 + 20 && y >= y0 && y < y0 + 20;
  own(tribe, rect(f.game, x0, y0, x0 + 20, y0 + 20));
  tribe.setTroops(TRIBE_TROOPS);
  tribe.addGold(TRIBE_GOLD);
  // Its PlayerExecution inits after the tribe's tiles were set, so its
  // first check waits for a tile change (lastTileChange 0 < lastCalc).
  f.game.executeNextTick();
  f.game.executeNextTick();
  f.game.addExecution(new PlayerExecution(tribe));
  f.game.executeNextTick();

  // Our ring, 3 thick, around the tribe (and around the water column).
  const ring: TileRef[] = [];
  for (let y = y0 - 4; y < y0 + 24; y++) {
    for (let x = x0 - 4; x < x0 + 24; x++) {
      if (!f.game.isValidCoord(x, y)) continue;
      if (inTribe(x, y)) continue;
      const t = f.game.ref(x, y);
      if (!f.game.isLand(t)) continue;
      ring.push(t);
    }
  }
  own(f.me, ring);
  if (c === "secondOwner") {
    const other = f.game.addPlayer(
      new PlayerInfo("other", PlayerType.Bot, null, "OTHER001"),
    );
    own(other, rect(f.game, x0 - 3, y0, x0, y0 + 20));
    other.setTroops(10_000);
  }
  f.me.setTroops(100_000);
  f.game.executeNextTick();
  return { f, tribe, tribeTiles: tribe.numTilesOwned() };
}

function poke(s: Scene): void {
  submit(s.f, { type: "attack", targetID: s.tribe.id(), troops: POKE });
}

describe("EnclosePoke (C10): an enclosed inland tribe is ours whole after a poke", () => {
  test("inland, no poke: untouched for 60 ticks (the check waits for its tiles to change)", async () => {
    const s = await scene("inland");
    expect(s.tribeTiles).toBe(400);
    expect(scanTribe(s.f.game, s.tribe, s.f.me.smallID()).enclosed).toBe(true);
    for (let i = 0; i < 60; i++) s.f.game.executeNextTick();
    expect(s.tribe.isAlive()).toBe(true);
    expect(s.tribe.numTilesOwned()).toBe(400);
  });

  /** Steps until the tribe is dead (at most `max` ticks); returns the ticks
   *  taken and the tribe's gold at the capture. */
  function untilCaptured(s: Scene, max: number): { t: number; loot: bigint } {
    const { f, tribe } = s;
    let t = 0;
    let loot = 0n;
    for (; t < max && tribe.isAlive(); t++) {
      loot = tribe.gold() + f.game.config().goldAdditionRate(tribe);
      f.game.executeNextTick();
    }
    return { t, loot };
  }

  test("inland, a 300-troop poke after its last check went stale: every tile and the gold are ours within 3 ticks", async () => {
    const s = await scene("inland");
    const { f, tribe } = s;
    // Its last possible check (lastCalc <= init tick + 19) is > 20 ticks old.
    for (let i = 0; i < 25; i++) f.game.executeNextTick();
    const tiles0 = f.me.numTilesOwned();
    const gold0 = f.me.gold();
    poke(s);
    const { t, loot } = untilCaptured(s, 25);
    expect(tribe.isAlive()).toBe(false);
    // Queued, init, first tile; the check runs in the tick after the
    // tile changed hands.
    expect(t).toBeLessThanOrEqual(3);
    expect(f.me.numTilesOwned()).toBe(tiles0 + 400);
    expect(f.me.gold() - gold0).toBe(loot);
    expect(loot).toBeGreaterThanOrEqual(TRIBE_GOLD);
  });

  test("inland, poked right after a check that found it open: ours within 25 ticks (the 20-tick check interval)", async () => {
    const s = await scene("inland");
    const { f, tribe } = s;
    for (let i = 0; i < 25; i++) f.game.executeNextTick();
    // Open the ring (a third owner takes one ring tile next to the tribe),
    // change one of the tribe's tiles (test-only mutations) so its check
    // runs now and finds it open, then close the ring and poke.
    const gap = f.game.ref(19, 30);
    const third = f.game.addPlayer(
      new PlayerInfo("third", PlayerType.Bot, null, "THIRD001"),
    );
    third.conquer(gap);
    f.me.conquer(f.game.ref(20, 25));
    f.game.executeNextTick();
    expect(tribe.isAlive()).toBe(true);
    f.me.conquer(gap);
    expect(scanTribe(f.game, tribe, f.me.smallID()).enclosed).toBe(true);
    poke(s);
    const { t } = untilCaptured(s, 40);
    expect(tribe.isAlive()).toBe(false);
    expect(t).toBeGreaterThan(15);
    expect(t).toBeLessThanOrEqual(25);
  });

  test.each(["edge", "ocean", "lake", "secondOwner"] as const)(
    "%s: the poke takes only its tiles; the tribe lives on",
    async (c) => {
      const s = await scene(c);
      const { f, tribe } = s;
      expect(s.tribeTiles).toBe(400);
      expect(scanTribe(f.game, tribe, f.me.smallID()).enclosed).toBe(false);
      poke(s);
      for (let i = 0; i < 40; i++) f.game.executeNextTick();
      expect(tribe.isAlive()).toBe(true);
      const taken = 400 - tribe.numTilesOwned();
      expect(taken).toBeGreaterThan(0);
      expect(taken).toBeLessThan(10);
      expect(f.me.gold()).toBe(0n);
    },
  );

  test("scanTribe sees the second owner as a nation only when it is one", async () => {
    const s = await scene("secondOwner");
    const sc = scanTribe(s.f.game, s.tribe, s.f.me.smallID());
    expect(sc.enclosed).toBe(false);
    // The other owner is a tribe (Bot), so no nation is listed.
    expect(sc.nations).toEqual([]);
  });
});
