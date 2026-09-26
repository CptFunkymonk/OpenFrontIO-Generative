/**
 * Pins spec C2 (apex spec §0.2, §6.1 "TroopCapClamp"): troops above the cap
 * do not decay slowly; a refund that lifts home troops above the cap is cut
 * back to the cap on the next tick. The allocator's cap-headroom rule
 * (§3.6.7: keep home + expected refunds <= cap) rests on it.
 *
 * The rules (the code is the spec):
 * - Config.troopIncreaseRate (src/core/configuration/Config.ts:1058-1090)
 *   returns min(T + toAdd, max) - T (:1089). Above the cap, toAdd is itself
 *   negative (ratio = 1 - T/max < 0, :1063-1064), so the result is max - T:
 *   the whole excess, in one tick.
 * - PlayerExecution.tick adds it every tick (PlayerExecution.ts:97-98), and a
 *   negative addTroops goes through removeTroops (PlayerImpl.ts:1369-1383),
 *   which removes toInt(T - max) = floor(T - max) (Util.ts:401-408). T is an
 *   integer, so the player is left at ceil(max) (exactly max when max is an
 *   integer). The tick after, toAdd is in (-1, 0], removeTroops floors it to
 *   nothing, and T stays at ceil(max).
 * - A free-land attack with no free land left retreats and refunds its stack
 *   in full (AttackExecution.ts:302-306 → retreat(), :224-256, 0% malus) by
 *   addTroops(survivors). Nothing checks the cap there.
 * - Order inside a tick (GameImpl.executeNextTick, GameImpl.ts:526-551):
 *   running executions tick in the order they were added. A player's
 *   PlayerExecution is added at its spawn, before any of its attacks, so in
 *   the tick the refund lands, regrowth has already run: the excess survives
 *   that tick (visible to an agent reading the state after it) and is cut in
 *   the next one.
 *
 * VERDICT TRUE: the whole excess over ceil(cap) is lost on the tick after
 * the refund, for Humans and Nations alike; a refund that stays under the
 * cap is kept in full. Refinements: the floor is ceil(cap), not cap; and
 * the excess, although an agent sees it in the state after the refund
 * tick, cannot be spent: an intent sent then executes in the next turn,
 * after that turn's PlayerExecution has cut home to ceil(cap), and
 * AttackExecution.init takes min(asked, home) (AttackExecution.ts:130-139).
 * So a Purse must count at most ceil(cap) of home as available.
 *
 * Setting: the real Config class (FFA, Singleplayer, Impossible, as
 * GameRunner.ts:46 builds it), a synthetic all-plains field whose free land
 * is two columns wide, so a saturated free-land attack runs out of land in a
 * few ticks and retreats. The attacker's PlayerExecution runs (added before
 * the attack, as SpawnExecution adds it); no other execution runs. The
 * agent's attack goes through IntentSchema and Executor.createExec
 * (src/core/execution/ExecutionManager.ts:64-71), the path of ctx.send; the
 * nation's is built as AiAttackBehavior.sendLandAttack builds it
 * (src/core/execution/utils/AiAttackBehavior.ts:1107-1113).
 */
import { createModels } from "../../../src/agent/lib/Models";
import { Config } from "../../../src/core/configuration/Config";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Player,
  PlayerInfo,
  PlayerType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { genTerrainFromBin } from "../../../src/core/game/TerrainMapLoader";
import { UserSettings } from "../../../src/core/game/UserSettings";
import { GameConfig, IntentSchema } from "../../../src/core/Schemas";

const AGENT_CLIENT = "AGENTCL1";
const AGENT_ID = "AGENTID1";
const NATION_ID = "NATION01";

const GAME_CONFIG: GameConfig = {
  gameMap: GameMapType.Asia,
  gameMapSize: GameMapSize.Normal,
  gameMode: GameMode.FFA,
  gameType: GameType.Singleplayer,
  difficulty: Difficulty.Impossible,
  nations: "default",
  donateGold: false,
  donateTroops: false,
  bots: 400,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: false,
};

const W = 60;
const H = 50;
const FREE_COLUMNS = 2;

interface Field {
  game: Game;
  p: Player;
  /** Launches a free-land attack of `troops` from `p` (runs no tick). */
  launch(troops: number): void;
}

async function field(type: PlayerType.Human | PlayerType.Nation) {
  const land = (w: number, h: number) =>
    genTerrainFromBin(
      { width: w, height: h, num_land_tiles: w * h },
      new Uint8Array(w * h).fill(0x80 | 5), // plains
    );
  const config = new Config(GAME_CONFIG, new UserSettings(), false);
  const game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    [],
    await land(W, H),
    await land(W / 2, H / 2),
    config,
  );
  game.endSpawnPhase();
  const p =
    type === PlayerType.Human
      ? game.player(AGENT_ID)
      : game.addPlayer(
          new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
        );
  for (let x = 0; x < W - FREE_COLUMNS; x++) {
    for (let y = 0; y < H; y++) p.conquer(game.ref(x, y));
  }
  // Regrowth runs from here on; its first tick only init()s it.
  game.addExecution(new PlayerExecution(p));
  game.executeNextTick();
  const executor = new Executor(game, "game", undefined);
  const f: Field = {
    game,
    p,
    launch(troops: number) {
      if (type === PlayerType.Human) {
        const intent = { type: "attack" as const, targetID: null, troops };
        expect(IntentSchema.safeParse(intent).success).toBe(true);
        game.addExecution(
          executor.createExec({ ...intent, clientID: AGENT_CLIENT }),
        );
      } else {
        game.addExecution(
          new AttackExecution(troops, p, game.terraNullius().id()),
        );
      }
    },
  };
  return f;
}

interface Trace {
  /** Home troops after each tick, from the launch tick on. */
  troops: number[];
  /** Whether the attack still existed after each tick. */
  attacking: boolean[];
  /** maxTroops after each tick. */
  cap: number[];
  /** What the agent's model says the next tick adds, after each tick. */
  growth: number[];
}

/**
 * Launches, then runs `ticks` ticks, recording the state after each. With
 * `refill`, home is set back to the cap after the launch tick, as if it had
 * regrown while the stack was out (the case the headroom rule guards).
 */
function run(f: Field, stack: number, ticks: number, refill: boolean): Trace {
  const t: Trace = { troops: [], attacking: [], cap: [], growth: [] };
  const models = createModels(f.game);
  f.launch(stack);
  for (let i = 0; i < ticks; i++) {
    f.game.executeNextTick();
    if (i === 0 && refill) {
      f.p.setTroops(Math.floor(f.game.config().maxTroops(f.p)));
    }
    t.troops.push(f.p.troops());
    t.attacking.push(f.p.outgoingAttacks().length > 0);
    t.cap.push(f.game.config().maxTroops(f.p));
    t.growth.push(models.regrowth(f.p));
  }
  return t;
}

describe("TroopCapClamp (C2): a refund above the cap is cut to the cap on the next tick", () => {
  it.each([PlayerType.Human, PlayerType.Nation] as const)(
    "%s: the whole excess is lost one tick after the refund",
    async (type) => {
      const f = await field(type);
      const stack = 50_000;
      f.p.setTroops(Math.floor(f.game.config().maxTroops(f.p)));
      const t = run(f, stack, 20, true);

      // The launch tick takes the stack; the attack runs, then retreats.
      expect(t.attacking[0]).toBe(true);
      const r = t.attacking.indexOf(false); // the refund tick
      expect(r).toBeGreaterThan(1);
      expect(f.p.numTilesOwned()).toBe(W * H); // all free land taken
      const cap = t.cap[r];
      expect(t.cap.slice(r)).toEqual(t.cap.slice(r).map(() => cap));

      // The refund lifted home far above the cap, and it survived its tick:
      // regrowth had already run in that tick.
      const refunded = t.troops[r];
      expect(refunded - cap).toBeGreaterThan(0.9 * stack - W * H);
      // What the agent's model says the next tick adds: the whole excess.
      expect(t.growth[r]).toBe(cap - refunded);

      // Next tick: cut to ceil(cap), and it stays there.
      expect(t.troops[r + 1]).toBe(Math.ceil(cap));
      for (let i = r + 1; i < t.troops.length; i++) {
        expect(t.troops[i]).toBe(Math.ceil(cap));
      }
    },
  );

  it("the excess cannot be spent: a stack sent at the refund tick takes at most ceil(cap)", async () => {
    const f = await field(PlayerType.Human);
    const capNow = () => f.game.config().maxTroops(f.p);
    f.p.setTroops(Math.floor(capNow()));
    f.launch(50_000);
    f.game.executeNextTick();
    f.p.setTroops(Math.floor(capNow()));
    for (let i = 0; i < 50 && f.p.outgoingAttacks().length > 0; i++) {
      f.game.executeNextTick();
    }
    expect(f.p.outgoingAttacks()).toHaveLength(0);
    // The state after the refund tick: what an agent reads at ctx.tick.
    const shown = f.p.troops();
    const cap = capNow();
    expect(shown - cap).toBeGreaterThan(40_000);
    // Send all of it. In the intent's turn PlayerExecution ticks first and
    // cuts home to ceil(cap); the attack init()s after and takes
    // min(asked, home) (AttackExecution.ts:130-139).
    f.launch(shown);
    f.game.executeNextTick();
    const attacks = f.p.outgoingAttacks();
    expect(attacks).toHaveLength(1);
    expect(attacks[0].troops()).toBe(Math.ceil(cap));
    expect(f.p.troops()).toBe(0);
  });

  it("a refund that stays under the cap is kept in full", async () => {
    const f = await field(PlayerType.Human);
    const M0 = f.game.config().maxTroops(f.p);
    // Room for the refund plus the regrowth on the way.
    const home = Math.floor(M0 * 0.5);
    f.p.setTroops(home);
    const stack = 20_000;
    const t = run(f, stack, 20, false);
    const r = t.attacking.indexOf(false);
    expect(r).toBeGreaterThan(1);
    // Replay: regrowth each tick (no cap bite), the refund once.
    const lost =
      FREE_COLUMNS *
      H *
      createModels(f.game).tnPrice({
        plains: 1,
        highland: 0,
        mountain: 0,
      });
    expect(t.troops[r]).toBeLessThan(t.cap[r]);
    expect(t.troops[r] - t.troops[r - 1]).toBeGreaterThan(stack - lost - 1);
    expect(t.troops[r + 1]).toBeGreaterThan(t.troops[r]);
  });
});
