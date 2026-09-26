import {
  KILL_FREE,
  tnPlan,
  topUpSizing,
  tribeSizing,
  TribeTarget,
} from "../../../src/agent/agents/apex/controllers/ExpansionController";
import { APEX_DEFAULTS } from "../../../src/agent/agents/apex/options";
import { createModels, Models } from "../../../src/agent/lib/Models";
import { scanWorld } from "../../../src/agent/lib/WorldModel";
import {
  AttackLogicInput,
  AttackLogicResult,
  Config,
} from "../../../src/core/configuration/Config";
import {
  Game,
  Player,
  PlayerType,
  TerrainType,
} from "../../../src/core/game/Game";
import { UserSettings } from "../../../src/core/game/UserSettings";
import {
  addTribe,
  Field,
  field,
  GAME_CONFIG,
  own,
  rect,
  submit,
} from "./Field";

// Spec §3.6.4 and §4 step 2 (TribeSizing.test), on a synthetic plains field
// (a straight 40-tile front, the tribe regrowing through its own
// PlayerExecution, no TribeExecution so it never answers):
// - S_b finishes a 1,000-tile tribe at density 5, 20 and 40; at d ≥ 20 with
//   no top-up (the allocator's own top-up rule never fires);
// - the observed loss per tile equals the loss at the 0.6 clamp while the
//   ratio is ≤ 0.6: every attackLogic call of the attack returns exactly
//   what models.hit returns at stack D/0.6 [PIN PlayerAttackSpeed:
//   attackerTroopLoss = mag·0.7·within(ratio, 0.6, 2)·(...)];
// - the stack comes home at the kill: home = start − Σ losses.
// At d = 5 the tribe is sparse (p > d/0.6, the drift term), and the top-ups
// of §3.6.2 keep the attack near the clamp until the kill.

/** The real Config, logging each attackLogic call; results untouched. */
class RecordingConfig extends Config {
  readonly calls: { input: AttackLogicInput; result: AttackLogicResult }[] = [];
  attackLogic(input: AttackLogicInput): AttackLogicResult {
    const result = super.attackLogic(input);
    this.calls.push({ input: structuredClone(input), result });
    return result;
  }
}

const W = 160;
const H = 60;
const US_COLS = 5;
const TRIBE_COLS = 25;
const TRIBE_Y0 = 10;
const TRIBE_Y1 = 50; // 25 × 40 = 1,000 tiles
const HOME = 1_000_000;

/** Models over a plain Config, so the test's own model calls are not
 *  recorded as the attack's. */
function plainModels(): Models {
  const config = new Config(GAME_CONFIG, new UserSettings(), false);
  return createModels({ config: () => config } as unknown as Game);
}

async function scene(density: number) {
  const f = await field({ width: W, height: H, ConfigClass: RecordingConfig });
  own(f.me, rect(f.game, 0, 0, US_COLS, H));
  const tribe = addTribe(
    f,
    "SIZE0001",
    rect(f.game, US_COLS, TRIBE_Y0, US_COLS + TRIBE_COLS, TRIBE_Y1),
    density * 1000,
  );
  f.me.setTroops(HOME);
  f.game.executeNextTick(); // the tribe's PlayerExecution inits
  tribe.setTroops(density * 1000);
  return { f, tribe, config: f.config as RecordingConfig };
}

function targetOf(f: Field, tribe: Player): TribeTarget {
  const info = scanWorld(f.game, f.me, null).neighbors.get(tribe.smallID());
  return {
    tiles: tribe.numTilesOwned(),
    troops: tribe.troops(),
    isTraitor: tribe.isTraitor(),
    contact: info?.contact ?? 0,
    contactMix: info?.contactMix ?? { plains: 0, highland: 0, mountain: 0 },
  };
}

interface Run {
  maxRatio: number;
  tilesTaken: number;
  lossSum: number;
  topUps: number;
  /** Ticks at which the allocator's top-up rule would have fired. */
  topUpDue: number;
  dead: boolean;
  ticks: number;
  /** Every call checked against the clamp loss (ratio ≤ 0.6 only). */
  clampChecked: number;
}

/** Launches S, then steps until the attack ends; with `topUp`, sends the
 *  §3.6.2 top-up every tribeTopUpEvery ticks when due. */
function runAttack(
  f: Field,
  tribe: Player,
  config: RecordingConfig,
  models: Models,
  S: number,
  topUp: boolean,
): Run {
  const o = APEX_DEFAULTS;
  submit(f, { type: "attack", targetID: tribe.id(), troops: S });
  const c0 = config.calls.length;
  f.game.executeNextTick(); // init
  expect(f.me.troops()).toBe(HOME - S);
  const run: Run = {
    maxRatio: 0,
    tilesTaken: 0,
    lossSum: 0,
    topUps: 0,
    topUpDue: 0,
    dead: false,
    ticks: 0,
    clampChecked: 0,
  };
  let lastSend = f.game.ticks() - 1;
  for (let t = 0; t < 400 && f.me.outgoingAttacks().length > 0; t++) {
    const A = f.me.outgoingAttacks()[0].troops();
    if (tribe.isAlive() && f.game.ticks() - lastSend >= o.tribeTopUpEvery) {
      const tu = topUpSizing(
        models,
        f.me.numTilesOwned(),
        targetOf(f, tribe),
        A,
        o.tribeRatio,
        o,
      );
      if (tu.add > 0) {
        run.topUpDue++;
        if (topUp) {
          submit(f, {
            type: "attack",
            targetID: tribe.id(),
            troops: Math.ceil(tu.add),
          });
          run.topUps++;
          lastSend = f.game.ticks();
        }
      }
    }
    f.game.executeNextTick();
    run.ticks++;
  }
  run.dead = !tribe.isAlive();
  for (const { input, result } of config.calls.slice(c0)) {
    if (input.defender === null) continue;
    const ratio = input.defender.troops / input.attackTroops;
    run.maxRatio = Math.max(run.maxRatio, ratio);
    run.tilesTaken++;
    run.lossSum += result.attackerTroopLoss;
    if (ratio <= o.tribeRatio) {
      const atClamp = models.hit(
        { type: PlayerType.Human, tiles: input.attacker.numTiles },
        {
          type: PlayerType.Bot,
          tiles: input.defender.numTiles,
          troops: input.defender.troops,
          isTraitor: false,
        },
        input.defender.troops / o.tribeRatio,
        TerrainType.Plains,
        input.borderSize,
      );
      expect(result.attackerTroopLoss).toBeCloseTo(
        atClamp.attackerTroopLoss,
        9,
      );
      run.clampChecked++;
    }
  }
  return run;
}

describe("apex tribe sizing (§3.6.4)", () => {
  test.each([5, 20, 40])(
    "density %i: S_b finishes a 1,000-tile tribe with no top-up, at the clamp loss, and the rest comes home",
    async (density) => {
      const { f, tribe, config } = await scene(density);
      const models = plainModels();
      const b = targetOf(f, tribe);
      expect(b.contact).toBe(TRIBE_Y1 - TRIBE_Y0);
      const sz = tribeSizing(
        models,
        f.me.numTilesOwned(),
        b,
        models.regrowth(tribe),
        APEX_DEFAULTS.tribeRatio,
        APEX_DEFAULTS,
      );
      expect(sz.k).toBe(1000 - KILL_FREE);
      // Dense tribes gain clamp headroom as they fall (p < d/0.6): no drift
      // term. A sparse one pays it up front.
      if (density >= 20) expect(sz.drift).toBe(0);
      else expect(sz.drift).toBeGreaterThan(0);
      const S = Math.ceil(sz.S);
      const run = runAttack(f, tribe, config, models, S, false);

      expect(run.dead).toBe(true);
      expect(f.me.numTilesOwned()).toBe(US_COLS * H + 1000);
      // The allocator's top-up rule (A < 0.95·need) never fires: the spec
      // asks this at d ≥ 20; at d = 5 the drift and regrowth terms cover a
      // 1,000-tile tribe as well.
      expect(run.topUpDue).toBe(0);
      expect(run.maxRatio).toBeLessThanOrEqual(APEX_DEFAULTS.tribeRatio);
      expect(run.clampChecked).toBe(run.tilesTaken);
      // One loss per tile paid for (the last 99 collapse for free).
      expect(run.tilesTaken).toBeGreaterThanOrEqual(sz.k);
      expect(run.tilesTaken).toBeLessThanOrEqual(sz.k + 1);
      // The launch price holds: the density moves little (regrowth).
      const mean = run.lossSum / run.tilesTaken;
      expect(mean).toBeGreaterThanOrEqual(sz.p * 0.97);
      expect(mean).toBeLessThanOrEqual(sz.p * 1.06);
      // Home: start − S + (S − Σ losses), up to the floors of removeTroops.
      expect(
        Math.abs(f.me.troops() - (HOME - run.lossSum)),
      ).toBeLessThanOrEqual(2);
      const refund = f.me.troops() - (HOME - S);
      expect(refund).toBeGreaterThan(0);
      expect(refund).toBeLessThanOrEqual(S - sz.cost * 0.97);
      expect(refund).toBeGreaterThanOrEqual(S - sz.cost * 1.06);
    },
  );

  test("top-ups (§3.6.2): a bare clamp on a sparse tribe drifts past 0.6 and dies short; topped up every 10 ticks it restores the clamp and finishes", async () => {
    const o = APEX_DEFAULTS;
    // The bare clamp margin·D/0.6: no regrowth or drift terms.
    const bare = (f: Field, tribe: Player) =>
      Math.ceil((o.tribeMargin * targetOf(f, tribe).troops) / o.tribeRatio);
    {
      const { f, tribe, config } = await scene(5);
      const run = runAttack(
        f,
        tribe,
        config,
        plainModels(),
        bare(f, tribe),
        false,
      );
      expect(run.maxRatio).toBeGreaterThan(o.tribeRatio);
      expect(run.dead).toBe(false);
      expect(tribe.numTilesOwned()).toBeGreaterThan(0);
    }
    const { f, tribe, config } = await scene(5);
    const models = plainModels();
    const c0 = config.calls.length;
    const run = runAttack(f, tribe, config, models, bare(f, tribe), true);
    expect(run.dead).toBe(true);
    expect(f.me.numTilesOwned()).toBe(US_COLS * H + 1000);
    expect(run.topUps).toBeGreaterThan(0);
    // Each top-up brings the ratio back under the clamp: the first tile
    // after a jump in the stack is taken at ratio <= 0.6.
    let prev: number | null = null;
    let restored = 0;
    for (const { input } of config.calls.slice(c0)) {
      if (input.defender === null) continue;
      if (prev !== null && input.attackTroops > prev + 1) {
        expect(input.defender.troops / input.attackTroops).toBeLessThanOrEqual(
          o.tribeRatio,
        );
        restored++;
      }
      prev = input.attackTroops;
    }
    expect(restored).toBe(run.topUps);
    expect(f.me.outgoingAttacks()).toHaveLength(0);
  });

  test("a strike plan's top-up is sized against a Nation defender, not a Bot (the 0.7 bot loss factor)", () => {
    const models = plainModels();
    const o = APEX_DEFAULTS;
    const mix = { plains: 40, highland: 0, mountain: 0 };
    const base = {
      tiles: 2000,
      troops: 40_000,
      isTraitor: false,
      contact: 40,
      contactMix: mix,
    };
    const A = 0.5 * ((o.tribeMargin * base.troops) / o.tribeRatio);
    const nation = topUpSizing(
      models,
      30_000,
      { ...base, type: PlayerType.Nation },
      A,
      o.tribeRatio,
      o,
    );
    const bot = topUpSizing(models, 30_000, base, A, o.tribeRatio, o);
    const want = models.hitMix(
      30_000,
      {
        type: PlayerType.Nation,
        tiles: 2000,
        troops: 40_000,
        isTraitor: false,
      },
      nation.need,
      mix,
      40 + 2,
    );
    expect(nation.p).toBeCloseTo(want.loss, 9);
    // attackLogic: mag ×0.7 against a Bot defender only (Config.ts:913-920).
    expect(bot.p / nation.p).toBeCloseTo(0.7, 6);
    expect(nation.need).toBe(bot.need);
    expect(nation.add).toBeGreaterThanOrEqual(bot.add);
  });

  test("tnPlan: the early trigger (A < 0.5·S_sat) only when `early` (o.tnPace); the tnHorizon cadence always", () => {
    const models = plainModels();
    const o = APEX_DEFAULTS;
    const mix = { plains: 100, highland: 0, mountain: 0 };
    const sat = models.tnSaturation(mix);
    const at = (tick: number, early: boolean) =>
      tnPlan(models, 100, mix, 0.2 * sat, 100, tick, 1e6, o, early);
    expect(at(112, true).due).toBe(true);
    expect(at(112, true).send).toBeGreaterThan(0);
    expect(at(112, false).due).toBe(false);
    expect(at(112, false).send).toBe(0);
    expect(at(100 + o.tnHorizon, false).due).toBe(true);
    expect(at(100 + o.tnHorizon, false).send).toBeGreaterThan(0);
  });
});
