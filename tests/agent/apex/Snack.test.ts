import {
  ExpansionController,
  SNACK_TILES,
  snackStack,
} from "../../../src/agent/agents/apex/controllers/ExpansionController";
import {
  APEX_DEFAULTS,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import { ApexPolicy } from "../../../src/agent/agents/apex/policy";
import { createState } from "../../../src/agent/agents/apex/state";
import { createModels } from "../../../src/agent/lib/Models";
import { scanWorld } from "../../../src/agent/lib/WorldModel";
import { PlayerType, TerrainType } from "../../../src/core/game/Game";
import { addTribe, field, Harness, own, rect, submit, Terrain } from "./Field";

// Spec §3.6.1 and §4 step 2 (Snack.test): a bordering 52-tile tribe falls in
// the first attack tick for s = min(snackMax, ceil(snackSafety·firstTileLoss)
// + 1) on plains and mountains, and its gold is ours. The rule is
// AttackExecution.handleDeadDefender (:448-482): a player left under 100
// tiles by a lost tile is conquered whole (GameImpl.conquerPlayer, gold
// included, Config.conquerGoldAmount :735-744) [PIN TribeStats].
//
// Found here, as the TribeStats pin says: the attack pays min(stack, the
// first tile's loss), because the stack is checked (>= 1) only before each
// tile. So 1 troop takes the tribe for 1 troop; the spec's s pays the whole
// first-tile loss and gets the rest back. snackSafety 0 gives s = 1.

const W = 60;
const H = 40;
const US_COLS = 5;
const TRIBE_TROOPS = 10_000;
const TRIBE_GOLD = 5_000n;

/** We own x < 5; a 52-tile tribe (4 × 13) touches us at x = 5. */
async function scene(terrain: Terrain) {
  const f = await field({ width: W, height: H, terrain: () => terrain });
  own(f.me, rect(f.game, 0, 0, US_COLS, H));
  const tribe = addTribe(
    f,
    "SNACK001",
    rect(f.game, US_COLS, 10, US_COLS + 4, 23),
    TRIBE_TROOPS,
  );
  tribe.addGold(TRIBE_GOLD);
  f.me.setTroops(100_000);
  // The tribe's PlayerExecution inits in this tick.
  f.game.executeNextTick();
  return { f, tribe };
}

describe("apex snacks (§3.6.1)", () => {
  test.each([
    ["plains", TerrainType.Plains],
    ["mountain", TerrainType.Mountain],
  ] as const)(
    "%s: a 52-tile tribe falls in the first attack tick for s; gold and every tile are ours",
    async (terrain, type) => {
      const { f, tribe } = await scene(terrain);
      expect(tribe.numTilesOwned()).toBe(52);
      const models = createModels(f.game);
      const wm = scanWorld(f.game, f.me, null);
      const info = wm.neighbors.get(tribe.smallID())!;
      expect(info.contactMix[terrain as "plains" | "mountain"]).toBe(13);
      const loss = models.firstTileLoss(
        f.me.numTilesOwned(),
        {
          type: PlayerType.Bot,
          tiles: 52,
          troops: TRIBE_TROOPS,
          isTraitor: false,
        },
        type,
      );
      // 80·0.7·2·(0.463 + 0.0039·192) ≈ 136 on plains, ×1.5 on mountains.
      expect(loss).toBeCloseTo(terrain === "plains" ? 136 : 204, -1);
      const s = snackStack(
        models,
        f.me.numTilesOwned(),
        { ...info, isTraitor: false },
        APEX_DEFAULTS,
      );
      expect(s).toBe(Math.ceil(APEX_DEFAULTS.snackSafety * loss) + 1);

      const troops0 = f.me.troops();
      const gold0 = f.me.gold();
      const tiles0 = f.me.numTilesOwned();
      submit(f, { type: "attack", targetID: tribe.id(), troops: s });
      f.game.executeNextTick(); // init: the stack leaves home
      expect(f.me.troops()).toBe(troops0 - s);
      expect(tribe.isAlive()).toBe(true);
      // Its gold at the capture: what it has now plus this tick's wage
      // (its PlayerExecution ticks before our attack).
      const loot = tribe.gold() + f.game.config().goldAdditionRate(tribe);
      expect(loot).toBeGreaterThan(TRIBE_GOLD);
      // Its troops at the capture, after this tick's regrowth, set the loss.
      const D1 =
        tribe.troops() + Math.floor(f.game.config().troopIncreaseRate(tribe));
      const lossAtCapture = models.firstTileLoss(
        tiles0,
        { type: PlayerType.Bot, tiles: 52, troops: D1, isTraitor: false },
        type,
      );
      f.game.executeNextTick(); // the first tile falls, and the tribe with it
      expect(tribe.isAlive()).toBe(false);
      expect(tribe.numTilesOwned()).toBe(0);
      expect(f.me.numTilesOwned()).toBe(tiles0 + 52);
      expect(f.me.gold()).toBe(gold0 + loot);
      // Only the first tile's loss is spent; the rest comes home the next
      // tick (the first tile spent the tick's budget: at ratio 36 its
      // tickFraction is > 1), when the attack finds nothing left to take.
      f.game.executeNextTick();
      expect(f.me.outgoingAttacks()).toHaveLength(0);
      expect(
        Math.abs(f.me.troops() - (troops0 - lossAtCapture)),
      ).toBeLessThanOrEqual(1);
    },
  );

  test("[pin] one troop takes it too, for one troop (the stack is checked only before each tile)", async () => {
    const { f, tribe } = await scene("plains");
    const troops0 = f.me.troops();
    submit(f, { type: "attack", targetID: tribe.id(), troops: 1 });
    f.game.executeNextTick();
    const loot = tribe.gold() + f.game.config().goldAdditionRate(tribe);
    f.game.executeNextTick();
    expect(tribe.isAlive()).toBe(false);
    expect(f.me.gold()).toBe(loot);
    expect(f.me.troops()).toBe(troops0 - 1);
    // And snackSafety 0 is how the allocator sends it.
    const models = createModels(f.game);
    expect(
      snackStack(
        models,
        100,
        {
          tiles: 52,
          troops: TRIBE_TROOPS,
          isTraitor: false,
          contactMix: { plains: 13, highland: 0, mountain: 0 },
        },
        { snackSafety: 0, snackMax: 1000 },
      ),
    ).toBe(1);
  });

  test("the line is 100 tiles: a 100-tile tribe falls to one tile, a 101-tile one does not", async () => {
    for (const n of [SNACK_TILES, SNACK_TILES + 1]) {
      const f = await field({ width: W, height: H });
      own(f.me, rect(f.game, 0, 0, US_COLS, H));
      // n tiles: rows of 5 from y = 0, touching us at x = 5.
      const tiles = rect(f.game, US_COLS, 0, US_COLS + 5, 25).slice(0, n);
      const tribe = addTribe(f, "LINE0001", tiles, 20_000);
      f.me.setTroops(100_000);
      f.game.executeNextTick();
      expect(tribe.numTilesOwned()).toBe(n);
      submit(f, { type: "attack", targetID: tribe.id(), troops: 1 });
      f.game.executeNextTick();
      f.game.executeNextTick();
      expect(tribe.isAlive()).toBe(n > SNACK_TILES);
      if (n <= SNACK_TILES) continue;
      expect(tribe.numTilesOwned()).toBe(n - 1);
    }
  });

  test("the live policy sends exactly that snack at its first decision", async () => {
    const { f, tribe } = await scene("plains");
    const o = parseApexOptions({
      defense: false,
      diplomacy: false,
      strike: false,
      economy: false,
      endgame: false,
      boats: false,
    });
    const policy = new ApexPolicy(o, createState());
    const h = new Harness(f, (ctx) => policy.tick(ctx));
    const models = createModels(f.game);
    const info = scanWorld(f.game, f.me, null).neighbors.get(tribe.smallID())!;
    const s = snackStack(
      models,
      f.me.numTilesOwned(),
      { ...info, isTraitor: false },
      o,
    );
    const sent = h.step();
    const snacks = sent.filter(
      (i) => i.type === "attack" && i.targetID === tribe.id(),
    );
    expect(snacks).toEqual([
      { type: "attack", targetID: tribe.id(), troops: s },
    ]);
    h.step();
    expect(tribe.isAlive()).toBe(false);
    expect(f.me.gold()).toBeGreaterThanOrEqual(TRIBE_GOLD);
    // The snack's plan ends with the tribe: no further attack on it.
    for (let i = 0; i < 6; i++) {
      for (const x of h.step()) {
        expect(x.type === "attack" && x.targetID === tribe.id()).toBe(false);
      }
    }
    expect(new ExpansionController().name).toBe("expansion");
  });
});
