/**
 * Pins how land attacks merge and cancel (docs/11-roadmap.md §11.3; the
 * risk table asks for every mechanic an agent relies on to be pinned here).
 *
 * The claim under test ("AttackMerge"): a new land attack on the same target
 * absorbs every earlier active attack of ours on that target, for terra
 * nullius and for players, so parallel attacks on the same target buy
 * nothing; attacks on different targets never merge. Also: what a new attack
 * does to an attack its target is running against us, and whether a boat
 * landing's attack merges with a later land attack.
 *
 * The rules, all in AttackExecution.init (src/core/execution/AttackExecution.ts:75-211):
 *   - :130-140  troops ??= attackAmount; clamp to owned troops; deduct (floored).
 *   - :141-146  PlayerImpl.createAttack pushes the new Attack onto our
 *               outgoing list and the target's incoming list
 *               (src/core/game/PlayerImpl.ts:1879-1899).
 *   - :148-152  frontier: a boat landing seeds from its sourceTile only,
 *               anything else from EVERY border tile we own (refreshToConquer,
 *               :213-222).
 *   - :157-170  for each incoming attack whose attacker is our target: the
 *               larger stack survives with the difference; if theirs is
 *               strictly larger ours is deleted and init returns (our troops
 *               are gone, nothing merges, the relation penalty at :190-210 is
 *               skipped, but the embargo at :113-123 and stats at :155
 *               already happened); otherwise theirs is deleted.
 *   - :171-181  every other outgoing attack of ours on the same target
 *               (land, boat landing, even one that is retreating) is added to
 *               the new attack and deleted, but only when the NEW attack has
 *               no sourceTile. A boat landing never absorbs, and is never
 *               absorbed at its own creation.
 * AttackImpl.delete (src/core/game/AttackImpl.ts:60-73) drops the attack from
 * both lists and clears isActive, but leaves troops() AND the retreated flag
 * untouched. That is how these tests read the exact stack that was absorbed,
 * and it is also a hole (see the retreat step below).
 *
 * What an absorbed (or cancelled-out) attack's own execution does next, in
 * AttackExecution.tick (:258-283), checked in this order:
 *   - :266-274  attack.retreated() -> retreat(): pays the owner the attack's
 *               troops() minus the malus (malusForRetreat = 25 for a player,
 *               0 for terra nullius, :37, :224-256) and ends.
 *   - :276-278  attack.retreating() -> return, every tick, forever.
 *   - :280-283  !attack.isActive() -> end, no refund.
 * The retreated flag is set only by RetreatExecution (the cancel_attack
 * intent, ExecutionManager.ts:72-73): init takes startTick = mg.ticks()
 * (RetreatExecution.ts:23-26); the first tick orders the retreat, and the
 * tick with ticks() >= startTick + cancelDelay (20, RetreatExecution.ts:11,
 * :34-37) calls PlayerImpl.executeRetreat (PlayerImpl.ts:714-721), which
 * sets it if the ID is still on our outgoing list. The attack's execution
 * ticks before the RetreatExecution in that step (added earlier), and new
 * intents init after both. So a land click (or an enemy attack on us) that
 * inits in exactly that step finds an attack that is still listed but
 * already retreated: it absorbs (or cancels against) the stack, and on the
 * next tick the old execution refunds the same troops anyway. The stack
 * exists twice. One step earlier the click is a clean rescue (the old
 * execution is left returning at :276-278 forever); one step later the
 * attack has already been refunded and deleted before the click inits.
 *
 * Timing (GameImpl.executeNextTick, src/core/game/GameImpl.ts:526-551):
 * running executions tick first, then new ones init, in the order added. So
 * a click absorbs a running attack AFTER that attack's tick in the same step,
 * and several clicks in one turn collapse into the last one.
 *
 * Setting: the real Config class (not TestConfig, which replaces attackLogic),
 * FFA, Singleplayer, Impossible, the agent as a Human and the enemy as a
 * Nation, the seat types createGameRunner gives them (src/core/GameRunner.ts:
 * 46-84). Intents go through IntentSchema (as AgentHost.isValid does,
 * src/agent/AgentHost.ts:193) and Executor.createExec (ExecutionManager.ts:
 * 64-73), the path an agent's ctx.send takes. Nation and tribe attacks are
 * built as AiAttackBehavior builds them (AiAttackBehavior.ts:1108-1112), boat
 * landings as TransportShipExecution builds them (TransportShipExecution.ts:
 * 275-283). No NationExecution runs, so the enemy never acts on its own, and
 * no PlayerExecution runs unless a test adds one, so home troops change only
 * by what the attacks pay and refund.
 */
import { Config } from "../../../src/core/configuration/Config";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import {
  Attack,
  Difficulty,
  Execution,
  Game,
  GameMode,
  GameType,
  Player,
  PlayerInfo,
  PlayerType,
  Relation,
  UnitType,
} from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import { Intent, IntentSchema } from "../../../src/core/Schemas";
import { setup } from "../../util/Setup";

const AGENT_CLIENT = "AGENTCL1";
const AGENT_ID = "AGENTID1";
const NATION_ID = "NATION01";
const TRIBE_ID = "TRIBE001";

// Unexported constants, stated from source; the retreat-step tests below
// fail if either changes. cancelDelay: RetreatExecution.ts:11.
// malusForRetreat: AttackExecution.ts:37.
const CANCEL_DELAY = 20;
const MALUS_FOR_RETREAT = 25;

const ARENA_CONFIG = {
  gameMode: GameMode.FFA,
  gameType: GameType.Singleplayer,
  difficulty: Difficulty.Impossible,
};

interface Seat {
  game: Game;
  executor: Executor;
}

interface Scenario extends Seat {
  agent: Player;
  nation: Player;
  tribe: Player;
}

function fill(
  game: Game,
  p: Player,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
) {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) p.conquer(game.ref(x, y));
  }
}

/** Ticks until the nation's spawn immunity (which binds Human attackers only,
 * PlayerImpl.canAttackPlayer, PlayerImpl.ts:1917-1926) has run out. */
function endNationImmunity(game: Game, nation: Player) {
  let ticks = 0;
  while (nation.isImmune()) {
    game.executeNextTick();
    ticks++;
  }
  expect(ticks).toBe(game.config().nationSpawnImmunityDuration());
}

/**
 * plains is 100x100 of flat land:
 *   agent  x 0-19,  y 0-79  (1600 tiles)
 *   nation x 20-39, y 0-39  (800 tiles)
 *   tribe  x 20-39, y 40-79 (800 tiles)
 *   terra nullius everywhere else; the agent touches it along y = 80.
 */
async function plainsScenario(): Promise<Scenario> {
  const game = await setup(
    "plains",
    ARENA_CONFIG,
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    undefined,
    Config,
  );
  const nation = game.addPlayer(
    new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
  );
  const tribe = game.addPlayer(
    new PlayerInfo("tribe", PlayerType.Bot, null, TRIBE_ID),
  );
  const agent = game.player(AGENT_ID);
  fill(game, agent, 0, 20, 0, 80);
  fill(game, nation, 20, 40, 0, 40);
  fill(game, tribe, 20, 40, 40, 80);
  agent.setTroops(200_000);
  nation.setTroops(100_000);
  tribe.setTroops(50_000);
  endNationImmunity(game, nation);
  return {
    game,
    agent,
    nation,
    tribe,
    executor: new Executor(game, "game", undefined),
  };
}

/** The agent's path: IntentSchema (AgentHost.ts:193), then Executor.createExec. */
function send(s: Seat, intent: Intent): Execution {
  expect(IntentSchema.safeParse(intent).success).toBe(true);
  const exec = s.executor.createExec({ ...intent, clientID: AGENT_CLIENT });
  s.game.addExecution(exec);
  return exec;
}

function attack(s: Seat, targetID: string | null, troops: number) {
  return send(s, { type: "attack", targetID, troops });
}

function run(game: Game, ticks: number) {
  for (let i = 0; i < ticks; i++) game.executeNextTick();
}

function only<T>(xs: readonly T[]): T {
  expect(xs).toHaveLength(1);
  return xs[0];
}

function onTarget(p: Player, target: Player | null): Attack[] {
  return p
    .outgoingAttacks()
    .filter((a) =>
      target === null ? !a.target().isPlayer() : a.target() === target,
    );
}

/** Target tiles with a 4-neighbour we own: the border refreshToConquer seeds
 * (AttackExecution.ts:213-222 with addNeighbors :398-441). */
function contact(game: Game, attacker: Player, target: Player): number {
  const buf: TileRef[] = [0, 0, 0, 0];
  let n = 0;
  target.tiles().forEach((t) => {
    const k = game.map().neighbors4(t, buf);
    for (let i = 0; i < k; i++) {
      if (game.owner(buf[i]) === attacker) {
        n++;
        return;
      }
    }
  });
  return n;
}

describe("AttackMerge: a new land attack absorbs our earlier attacks on the same target", () => {
  test("clicks in one turn on terra nullius collapse into the last, costing exactly their sum", async () => {
    const s = await plainsScenario();
    const before = s.agent.troops();
    const execs = [1000, 2000, 3000].map((t) => attack(s, null, t));
    s.game.executeNextTick();

    const merged = only(s.agent.outgoingAttacks());
    expect(merged.target().isPlayer()).toBe(false);
    expect(merged.troops()).toBe(6000);
    expect(s.agent.troops()).toBe(before - 6000);

    // The first two executions notice their Attack was deleted on their next
    // tick (AttackExecution.ts:280-283) and end without refunding anything
    // (their attacks were never retreated; for one that was, see the
    // retreat-step tests).
    s.game.executeNextTick();
    expect(execs.map((e) => e.isActive())).toEqual([false, false, true]);
    expect(s.agent.troops()).toBe(before - 6000);
  });

  test("a running attack on terra nullius is absorbed with the troops it has left", async () => {
    const s = await plainsScenario();
    const first = attack(s, null, 20_000);
    run(s.game, 6);
    const old = only(s.agent.outgoingAttacks());
    const tilesBefore = s.agent.numTilesOwned();
    expect(tilesBefore).toBeGreaterThan(1600);

    const second = attack(s, null, 1000);
    s.game.executeNextTick();

    // old.troops() is frozen at the moment it was absorbed (after its own tick
    // in this step), and it had spent troops conquering.
    expect(old.isActive()).toBe(false);
    expect(old.troops()).toBeLessThan(20_000);
    const merged = only(s.agent.outgoingAttacks());
    expect(merged).not.toBe(old);
    expect(merged.troops()).toBe(old.troops() + 1000);

    s.game.executeNextTick();
    expect(first.isActive()).toBe(false);
    expect(second.isActive()).toBe(true);
    // One stack, still conquering.
    run(s.game, 5);
    expect(s.agent.numTilesOwned()).toBeGreaterThan(tilesBefore);
  });

  test("a running attack on a nation is absorbed the same way", async () => {
    const s = await plainsScenario();
    attack(s, NATION_ID, 30_000);
    run(s.game, 6);
    const old = only(s.agent.outgoingAttacks());
    expect(s.nation.numTilesOwned()).toBeLessThan(800);

    attack(s, NATION_ID, 5000);
    s.game.executeNextTick();

    expect(old.isActive()).toBe(false);
    expect(s.nation.incomingAttacks()).not.toContain(old);
    const merged = only(s.agent.outgoingAttacks());
    expect(merged.target()).toBe(s.nation);
    expect(merged.troops()).toBe(old.troops() + 5000);
    expect(only(s.nation.incomingAttacks())).toBe(merged);
  });

  test("a zero-troop click keeps the stack and re-seeds the frontier from our whole current border", async () => {
    const s = await plainsScenario();
    attack(s, TRIBE_ID, 20_000);
    run(s.game, 3);
    const old = only(s.agent.outgoingAttacks());

    // New contact with the tribe far from the running front: a strip under
    // its southern edge (x 30-39, y 80). The running attack's frontier heap
    // does not learn of it; it only grows from tiles it conquers
    // (AttackExecution.ts:328, addNeighbors).
    fill(s.game, s.agent, 30, 40, 80, 81);

    // troops: 0 is a valid intent (Schemas.ts:639-643, min 0).
    attack(s, TRIBE_ID, 0);
    const troopsBefore = s.agent.troops();
    s.game.executeNextTick();

    const merged = only(s.agent.outgoingAttacks());
    expect(old.isActive()).toBe(false);
    expect(merged.troops()).toBe(old.troops());
    expect(s.agent.troops()).toBe(troopsBefore);
    expect(merged.borderSize()).toBe(contact(s.game, s.agent, s.tribe));
    expect(merged.borderSize()).toBeGreaterThan(old.borderSize());
  });
});

describe("AttackMerge: attacks on different targets never merge", () => {
  test("terra nullius, a nation and a tribe attacked in one turn run as three stacks", async () => {
    const s = await plainsScenario();
    const before = s.agent.troops();
    attack(s, null, 10_000);
    attack(s, NATION_ID, 20_000);
    attack(s, TRIBE_ID, 15_000);
    s.game.executeNextTick();

    expect(s.agent.outgoingAttacks()).toHaveLength(3);
    expect(only(onTarget(s.agent, null)).troops()).toBe(10_000);
    expect(only(onTarget(s.agent, s.nation)).troops()).toBe(20_000);
    expect(only(onTarget(s.agent, s.tribe)).troops()).toBe(15_000);
    expect(s.agent.troops()).toBe(before - 45_000);

    // All three advance in parallel, each spending its own stack.
    run(s.game, 10);
    const stacks = [null, s.nation, s.tribe].map((t) =>
      only(onTarget(s.agent, t)),
    );
    expect(stacks[0].troops()).toBeLessThan(10_000);
    expect(stacks[1].troops()).toBeLessThan(20_000);
    expect(stacks[2].troops()).toBeLessThan(15_000);
    expect(s.nation.numTilesOwned()).toBeLessThan(800);
    expect(s.tribe.numTilesOwned()).toBeLessThan(800);
    const fromPlayers =
      800 - s.nation.numTilesOwned() + (800 - s.tribe.numTilesOwned());
    // Whatever the agent gained beyond the two players' losses was free land.
    expect(s.agent.numTilesOwned() - 1600).toBeGreaterThan(fromPlayers);
  });
});

describe("AttackMerge: boat landings", () => {
  /** A beachhead inside the nation (default x 30, y 20), as a landed boat leaves it:
   * TransportShipExecution conquers the landing tile, then adds this
   * execution (TransportShipExecution.ts:275-283); the boat's troops were
   * taken at departure (PlayerImpl.buildUnit, PlayerImpl.ts:1416). */
  function land(s: Scenario, troops: number, x = 30, y = 20): Execution {
    const beach = s.game.ref(x, y);
    s.agent.conquer(beach);
    expect(s.agent.removeTroops(troops)).toBe(troops);
    const exec = new AttackExecution(troops, s.agent, NATION_ID, beach, false);
    s.game.addExecution(exec);
    return exec;
  }

  function tilesNear(game: Game, p: Player, cx: number, cy: number, r: number) {
    let n = 0;
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = cy - r; y <= cy + r; y++) {
        if (game.owner(game.ref(x, y)) === p) n++;
      }
    }
    return n;
  }

  test("a later land attack absorbs the landing, and fights on at the beachhead", async () => {
    const s = await plainsScenario();
    land(s, 8000);
    run(s.game, 4);
    const beachhead = only(s.agent.outgoingAttacks());
    expect(beachhead.sourceTile()).toBe(s.game.ref(30, 20));

    attack(s, NATION_ID, 10_000);
    s.game.executeNextTick();

    expect(beachhead.isActive()).toBe(false);
    const merged = only(s.agent.outgoingAttacks());
    expect(merged.sourceTile()).toBeNull();
    expect(merged.troops()).toBe(beachhead.troops() + 10_000);

    // Refutes "the spread-out beachhead frontier is thrown away"
    // (docs/02-territory-and-combat.md §2.3 item 6, docs/09-playbook.md):
    // the merged attack seeds from every border tile we own, the beachhead's
    // included (AttackExecution.ts:151 -> refreshToConquer :213-222), so the
    // only attack left keeps taking tiles around the beachhead.
    expect(merged.borderSize()).toBe(contact(s.game, s.agent, s.nation));
    const nearBeach = tilesNear(s.game, s.agent, 30, 20, 4);
    run(s.game, 6);
    expect(only(s.agent.outgoingAttacks())).toBe(merged);
    expect(tilesNear(s.game, s.agent, 30, 20, 4)).toBeGreaterThan(nearBeach);
  });

  test("a landing never absorbs: land and boat stacks coexist until the next land click takes all", async () => {
    const s = await plainsScenario();
    attack(s, NATION_ID, 10_000);
    s.game.executeNextTick();
    // Two landings init after the running land attack's tick; neither
    // absorbs it or each other.
    land(s, 3000, 30, 20);
    land(s, 2000, 30, 10);
    s.game.executeNextTick();

    const stacks = onTarget(s.agent, s.nation);
    expect(stacks).toHaveLength(3);
    expect(stacks.map((a) => a.sourceTile() !== null)).toEqual([
      false,
      true,
      true,
    ]);
    expect(stacks[0].troops()).toBeLessThan(10_000);
    expect(stacks[1].troops()).toBe(3000);
    expect(stacks[2].troops()).toBe(2000);

    attack(s, NATION_ID, 1000);
    s.game.executeNextTick();
    const merged = only(s.agent.outgoingAttacks());
    expect(stacks.every((a) => !a.isActive())).toBe(true);
    // Summed in the merge loop's order: the new 1000, then the list.
    expect(merged.troops()).toBe(
      stacks.reduce((sum, a) => sum + a.troops(), 1000),
    );
  });

  test("end to end: a real transport ship's landing is absorbed by a later land attack", async () => {
    // ocean_and_land: land at x 0-7 (all rows) and an island at x 14-15,
    // y 6-8. The agent holds the island and mainland row y = 0; the nation
    // holds mainland rows 1-15 (120 tiles, above the 100-tile kill line of
    // handleDeadDefender, AttackExecution.ts:449).
    const game = await setup(
      "ocean_and_land",
      ARENA_CONFIG,
      [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
      undefined,
      Config,
    );
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
    );
    const agent = game.player(AGENT_ID);
    fill(game, agent, 14, 16, 6, 9);
    fill(game, agent, 0, 8, 0, 1);
    fill(game, nation, 0, 8, 1, 16);
    agent.setTroops(100_000);
    nation.setTroops(5_000);
    endNationImmunity(game, nation);
    const s: Seat = { game, executor: new Executor(game, "game", undefined) };

    send(s, { type: "boat", troops: 4000, dst: game.ref(7, 8) });
    game.executeNextTick();
    expect(agent.units(UnitType.TransportShip)).toHaveLength(1);
    let landing: Attack | undefined;
    for (let i = 0; i < 100 && landing === undefined; i++) {
      game.executeNextTick();
      landing = agent.outgoingAttacks().find((a) => a.sourceTile() !== null);
    }
    expect(landing).toBeDefined();
    expect(agent.units(UnitType.TransportShip)).toHaveLength(0);
    expect(landing!.target()).toBe(nation);
    expect(landing!.troops()).toBe(4000);

    attack(s, NATION_ID, 2000);
    game.executeNextTick();
    expect(landing!.isActive()).toBe(false);
    const merged = only(agent.outgoingAttacks());
    expect(merged.sourceTile()).toBeNull();
    expect(merged.troops()).toBe(landing!.troops() + 2000);
  });
});

describe("AttackMerge: attacking a target that is attacking us cancels the stacks 1:1", () => {
  /** A nation attack on the agent, built as AiAttackBehavior builds it. */
  function nationAttacks(s: Scenario, troops: number): Execution {
    const exec = new AttackExecution(troops, s.nation, AGENT_ID);
    s.game.addExecution(exec);
    return exec;
  }

  test("their stack is larger: ours is spent entirely, theirs shrinks by ours", async () => {
    const s = await plainsScenario();
    const agentBefore = s.agent.troops();
    const nationBefore = s.nation.troops();
    nationAttacks(s, 5000);
    const counter = attack(s, NATION_ID, 2000);
    s.game.executeNextTick();

    const theirs = only(s.agent.incomingAttacks());
    expect(theirs.troops()).toBe(3000);
    expect(s.agent.outgoingAttacks()).toHaveLength(0);
    expect(counter.isActive()).toBe(false);
    // The 2000 are gone for good, and home troops are never touched.
    expect(s.agent.troops()).toBe(agentBefore - 2000);
    expect(s.nation.troops()).toBe(nationBefore - 5000);
    // The lost click still cost the embargo, which runs before the
    // cancellation (:113-123), but not the relation penalty, which runs after
    // the early return (:190-210).
    expect(s.nation.hasEmbargoAgainst(s.agent)).toBe(true);
    expect(s.nation.relation(s.agent)).toBe(Relation.Neutral);
  });

  test("our stack is larger: theirs is deleted, ours carries on with the difference", async () => {
    const s = await plainsScenario();
    nationAttacks(s, 2000);
    attack(s, NATION_ID, 5000);
    s.game.executeNextTick();

    expect(s.agent.incomingAttacks()).toHaveLength(0);
    expect(s.nation.outgoingAttacks()).toHaveLength(0);
    const ours = only(s.agent.outgoingAttacks());
    expect(ours.troops()).toBe(3000);
    // A surviving click does reach the -100 relation penalty (:203-209).
    expect(s.nation.relation(s.agent)).toBe(Relation.Hostile);
    run(s.game, 3);
    expect(s.nation.numTilesOwned()).toBeLessThan(800);
  });

  test("equal stacks: both are wiped out, ours lingers one tick at 0 troops", async () => {
    const s = await plainsScenario();
    const agentBefore = s.agent.troops();
    nationAttacks(s, 3000);
    attack(s, NATION_ID, 3000);
    s.game.executeNextTick();

    expect(s.agent.incomingAttacks()).toHaveLength(0);
    expect(only(s.agent.outgoingAttacks()).troops()).toBe(0);
    // troopCount < 1 deletes it on its first tick (AttackExecution.ts:296-300).
    s.game.executeNextTick();
    expect(s.agent.outgoingAttacks()).toHaveLength(0);
    expect(s.agent.troops()).toBe(agentBefore - 3000);
    expect(s.nation.numTilesOwned()).toBe(800);
  });

  test("against a running attack: theirs ends exactly our stack lower than in an identical game without the counter", async () => {
    // Two identical deterministic games; only one of them counters. The
    // counter inits after the enemy attack's tick (GameImpl.ts:529-546), so
    // everything else in the step is the same in both.
    const withCounter = await plainsScenario();
    const without = await plainsScenario();
    for (const s of [withCounter, without]) {
      nationAttacks(s, 12_000);
      run(s.game, 5);
    }
    expect(withCounter.agent.numTilesOwned()).toBeLessThan(1600);

    attack(withCounter, NATION_ID, 4000);
    withCounter.game.executeNextTick();
    without.game.executeNextTick();

    const a = only(withCounter.agent.incomingAttacks());
    const b = only(without.agent.incomingAttacks());
    expect(a.troops()).toBe(b.troops() - 4000);
    expect(withCounter.agent.outgoingAttacks()).toHaveLength(0);
    expect(withCounter.agent.troops()).toBe(without.agent.troops() - 4000);
    expect(withCounter.nation.troops()).toBe(without.nation.troops());
  });

  test("their new attack cancels our running one the same way", async () => {
    // Sized by hand. A real nation's send is min(its surplus above reserve,
    // troopSendCap) (AiAttackBehavior.calculateAttackTroops,
    // AiAttackBehavior.ts:1071-1074, sendLandAttack :1098-1102);
    // troopSendCap only raises the CAP to max(cap, total incoming from
    // everyone) (:1024-1028). It does not force a retaliation of that size.
    const s = await plainsScenario();
    attack(s, NATION_ID, 10_000);
    run(s.game, 3);
    const ours = only(s.agent.outgoingAttacks());
    nationAttacks(s, 15_000);
    s.game.executeNextTick();

    expect(ours.isActive()).toBe(false);
    expect(s.agent.outgoingAttacks()).toHaveLength(0);
    expect(only(s.agent.incomingAttacks()).troops()).toBe(
      15_000 - ours.troops(),
    );
  });

  test("each of their attacks is cancelled in turn, boat landings included", async () => {
    const s = await plainsScenario();
    // Their land attack, then their landing inside our land at (10, 40),
    // then our counter, all initialised in this order in one step.
    nationAttacks(s, 1000);
    const beach = s.game.ref(10, 40);
    s.nation.conquer(beach);
    s.nation.removeTroops(1500);
    s.game.addExecution(
      new AttackExecution(1500, s.nation, AGENT_ID, beach, false),
    );
    attack(s, NATION_ID, 2000);
    s.game.executeNextTick();

    // 2000 - 1000 leaves 1000; the 1500 landing is larger, so it survives
    // reduced by 1000 and ours dies (AttackExecution.ts:157-170).
    const boat = only(s.agent.incomingAttacks());
    expect(boat.sourceTile()).toBe(beach);
    expect(boat.troops()).toBe(500);
    expect(only(s.nation.outgoingAttacks())).toBe(boat);
    expect(s.agent.outgoingAttacks()).toHaveLength(0);
  });

  test("an attack on anyone else leaves their attack untouched", async () => {
    const s = await plainsScenario();
    nationAttacks(s, 5000);
    attack(s, null, 2000);
    attack(s, TRIBE_ID, 2000);
    s.game.executeNextTick();

    expect(only(s.agent.incomingAttacks()).troops()).toBe(5000);
    expect(s.agent.outgoingAttacks().map((a) => a.troops())).toEqual([
      2000, 2000,
    ]);
  });
});

/** The refund a retreated attack pays: retreat(malusForRetreat) against a
 * player, retreat() (0%) against terra nullius (AttackExecution.ts:266-271);
 * survivors = troops - troops * malus / 100 (:229, :246), and addTroops
 * floors (PlayerImpl.ts:1369-1375, toInt Util.ts:401-408). */
function refundFor(targetID: string | null, troops: number): number {
  const malus = targetID === null ? 0 : MALUS_FOR_RETREAT;
  return Math.floor(troops - troops * (malus / 100));
}

/** Attacks `targetID`, lets it run 3 steps, then sends cancel_attack for it.
 * cancelTick is the ticks() the RetreatExecution inits at, its startTick
 * (RetreatExecution.init, RetreatExecution.ts:23-26). */
function attackThenCancel(
  s: Scenario,
  targetID: string | null,
  troops: number,
) {
  const exec = attack(s, targetID, troops);
  run(s.game, 3);
  const a = only(s.agent.outgoingAttacks());
  const cancelTick = s.game.ticks();
  send(s, { type: "cancel_attack", attackID: a.id() });
  return { a, exec, cancelTick };
}

/** Steps until an intent added now inits in the step that runs at `tick`:
 * executeNextTick runs with ticks() = _ticks and increments it at the end
 * (GameImpl.ts:526-582). */
function runUntilStep(game: Game, tick: number) {
  expect(game.ticks()).toBeLessThanOrEqual(tick);
  while (game.ticks() < tick) game.executeNextTick();
}

describe("AttackMerge: retreats and attack IDs", () => {
  test("re-attacking a few steps after a cancel rescues the stack without the 25% malus", async () => {
    const rescued = await plainsScenario();
    const control = await plainsScenario();
    const frozenAt: number[] = [];
    for (const s of [rescued, control]) {
      attack(s, NATION_ID, 20_000);
      run(s.game, 3);
      const attackID = only(s.agent.outgoingAttacks()).id();
      send(s, { type: "cancel_attack", attackID });
      run(s.game, 2);
      const a = only(s.agent.outgoingAttacks());
      expect(a.retreating()).toBe(true);
      // A retreating attack takes no tiles and loses no troops
      // (AttackExecution.ts:276-278).
      const troops = a.troops();
      s.game.executeNextTick();
      expect(a.troops()).toBe(troops);
      frozenAt.push(troops);
    }
    expect(frozenAt[0]).toBe(frozenAt[1]);
    const frozen = frozenAt[0];
    const retreating = only(rescued.agent.outgoingAttacks());
    // This click inits 3 steps after the cancel; any of 1 .. CANCEL_DELAY-1
    // behaves the same. CANCEL_DELAY itself does not (next describe).
    attack(rescued, NATION_ID, 0);
    rescued.game.executeNextTick();
    const merged = only(rescued.agent.outgoingAttacks());
    expect(retreating.isActive()).toBe(false);
    expect(merged.retreating()).toBe(false);
    expect(merged.troops()).toBe(frozen);

    // RetreatExecution finishes CANCEL_DELAY ticks after the order
    // (RetreatExecution.ts:11, :34-37), but PlayerImpl.executeRetreat cannot
    // find the absorbed attack's ID (PlayerImpl.ts:714-721): no refund.
    const agentTroops = rescued.agent.troops();
    const nationTiles = rescued.nation.numTilesOwned();
    run(rescued.game, 25);
    expect(rescued.agent.troops()).toBe(agentTroops);
    expect(only(rescued.agent.outgoingAttacks())).toBe(merged);
    expect(rescued.nation.numTilesOwned()).toBeLessThan(nationTiles);

    // The control game, with no re-click, gets 75% back (retreat(25),
    // AttackExecution.ts:266-270 with malusForRetreat = 25 at :37, and
    // retreat :224-256) and the attack is gone.
    const controlTroops = control.agent.troops();
    run(control.game, 25);
    expect(control.agent.outgoingAttacks()).toHaveLength(0);
    expect(control.agent.troops() - controlTroops).toBe(
      refundFor(NATION_ID, frozen),
    );
  });

  test("merging mints a new attack ID; cancelling the absorbed one is a silent no-op", async () => {
    const s = await plainsScenario();
    attack(s, NATION_ID, 10_000);
    s.game.executeNextTick();
    const oldID = only(s.agent.outgoingAttacks()).id();
    attack(s, NATION_ID, 1000);
    s.game.executeNextTick();
    const merged = only(s.agent.outgoingAttacks());
    expect(merged.id()).not.toBe(oldID);

    send(s, { type: "cancel_attack", attackID: oldID });
    run(s.game, 25);
    expect(merged.retreating()).toBe(false);
    expect(only(s.agent.outgoingAttacks())).toBe(merged);
  });

  test("the retreated flag is set in the step CANCEL_DELAY after the cancel inits, after the attack's own tick, and paid on the next", async () => {
    const s = await plainsScenario();
    const { a, exec, cancelTick } = attackThenCancel(s, NATION_ID, 20_000);
    runUntilStep(s.game, cancelTick + CANCEL_DELAY);
    expect(a.retreating()).toBe(true);
    expect(a.retreated()).toBe(false);
    s.game.executeNextTick(); // the step at cancelTick + CANCEL_DELAY
    // Set, but the attack is still on our list: its execution ticked first
    // in that step (GameImpl.ts:529-536) and has not seen the flag yet.
    expect(a.retreated()).toBe(true);
    expect(a.isActive()).toBe(true);
    expect(only(s.agent.outgoingAttacks())).toBe(a);
    expect(exec.isActive()).toBe(true);
    const home = s.agent.troops();
    s.game.executeNextTick();
    expect(exec.isActive()).toBe(false);
    expect(s.agent.outgoingAttacks()).toHaveLength(0);
    expect(s.agent.troops()).toBe(home + refundFor(NATION_ID, a.troops()));
  });
});

describe.each([
  ["a nation", NATION_ID],
  ["terra nullius", null],
])(
  "AttackMerge: a 0-troop re-click timed against the retreat step, on %s",
  (_, target) => {
    /** Cancel, then a 0-troop land click on the same target that inits
     * `offset` steps after the cancel did. */
    async function reclickAt(offset: number) {
      const s = await plainsScenario();
      const { a, exec, cancelTick } = attackThenCancel(s, target, 20_000);
      runUntilStep(s.game, cancelTick + offset);
      expect(a.retreating()).toBe(true);
      const frozen = a.troops();
      const home = s.agent.troops();
      const click = attack(s, target, 0);
      s.game.executeNextTick();
      return { s, a, exec, click, frozen, home };
    }

    test("CANCEL_DELAY - 1 steps: the last clean rescue; no refund, and the absorbed execution never ends", async () => {
      const r = await reclickAt(CANCEL_DELAY - 1);
      expect(r.a.retreated()).toBe(false);
      expect(r.a.isActive()).toBe(false);
      const merged = only(r.s.agent.outgoingAttacks());
      expect(merged.troops()).toBe(r.frozen);
      // The RetreatExecution fires in the next step and finds no such ID.
      run(r.s.game, 3);
      expect(r.s.agent.troops()).toBe(r.home);
      expect(only(r.s.agent.outgoingAttacks())).toBe(merged);
      // The absorbed execution returns at retreating() (:276-278) every
      // tick: a leaked execution with no effect on the game.
      run(r.s.game, 20);
      expect(r.exec.isActive()).toBe(true);
    });

    test("exactly CANCEL_DELAY steps: the click absorbs an attack already retreated, which is refunded anyway: the stack exists twice", async () => {
      const r = await reclickAt(CANCEL_DELAY);
      expect(r.a.retreated()).toBe(true);
      expect(r.a.isActive()).toBe(false);
      const merged = only(r.s.agent.outgoingAttacks());
      expect(merged.troops()).toBe(r.frozen);
      expect(r.s.agent.troops()).toBe(r.home);

      // Next step: the old execution checks retreated() before isActive()
      // (AttackExecution.ts:266-274 vs :280-283) and pays out troops() that
      // AttackImpl.delete left in place, while the merged attack fights on.
      r.s.game.executeNextTick();
      const refund = refundFor(target, r.frozen);
      expect(r.exec.isActive()).toBe(false);
      expect(r.s.agent.troops()).toBe(r.home + refund);
      expect(only(r.s.agent.outgoingAttacks())).toBe(merged);
      expect(r.click.isActive()).toBe(true);
      // One step of fighting cost the merged stack far less than the refund
      // created: home + stack now exceed what we had before the click.
      expect(r.s.agent.troops() + merged.troops()).toBeGreaterThan(
        r.home + r.frozen + refund / 2,
      );
    });

    test("CANCEL_DELAY + 1 steps: the retreat pays out and deletes first; the 0-troop click has nothing to absorb and dies alone", async () => {
      const r = await reclickAt(CANCEL_DELAY + 1);
      expect(r.exec.isActive()).toBe(false);
      expect(r.s.agent.troops()).toBe(r.home + refundFor(target, r.frozen));
      const lone = only(r.s.agent.outgoingAttacks());
      expect(lone).not.toBe(r.a);
      expect(lone.troops()).toBe(0);
      // troopCount < 1 deletes it on its first tick (:296-300).
      r.s.game.executeNextTick();
      expect(r.s.agent.outgoingAttacks()).toHaveLength(0);
      expect(r.click.isActive()).toBe(false);
    });
  },
);

describe("AttackMerge: the retreat-step duplication, repeated and with regrowth", () => {
  test("every cancel + re-click-at-CANCEL_DELAY cycle on terra nullius refunds the whole stack and keeps it", async () => {
    const s = await plainsScenario();
    attack(s, null, 20_000);
    run(s.game, 3);
    const home0 = s.agent.troops();
    const stack0 = only(s.agent.outgoingAttacks()).troops();
    let expectedHome = home0;
    for (let cycle = 0; cycle < 3; cycle++) {
      const a = only(s.agent.outgoingAttacks());
      const cancelTick = s.game.ticks();
      send(s, { type: "cancel_attack", attackID: a.id() });
      runUntilStep(s.game, cancelTick + CANCEL_DELAY);
      const frozen = a.troops();
      attack(s, null, 0);
      run(s.game, 2);
      expectedHome += refundFor(null, frozen);
      // No PlayerExecution runs here: home changed by exactly the refund.
      expect(s.agent.troops()).toBe(expectedHome);
      expect(only(s.agent.outgoingAttacks()).troops()).toBeGreaterThan(
        0.9 * frozen,
      );
    }
    const stack = only(s.agent.outgoingAttacks()).troops();
    expect(s.agent.troops() + stack).toBeGreaterThan(home0 + stack0 * 3);
  });

  test("with the agent's PlayerExecution running, the refund lands on top of regrowth while home is under the cap", async () => {
    const s = await plainsScenario();
    // Added before the attack, so it ticks first in every step, as a real
    // player's does (it is added at spawn).
    s.game.addExecution(new PlayerExecution(s.agent));
    const { a, exec, cancelTick } = attackThenCancel(s, NATION_ID, 20_000);
    runUntilStep(s.game, cancelTick + CANCEL_DELAY);
    const frozen = a.troops();
    attack(s, NATION_ID, 0);
    s.game.executeNextTick();
    const merged = only(s.agent.outgoingAttacks());
    expect(merged.troops()).toBe(frozen);

    // PlayerExecution.tick adds troopIncreaseRate (PlayerExecution.ts:97-98,
    // Config.ts:1058-1090), computed from the state at the start of the
    // step; then the old execution pays the refund.
    const home = s.agent.troops();
    const growth = s.game.config().troopIncreaseRate(s.agent);
    expect(growth).toBeGreaterThan(0);
    s.game.executeNextTick();
    expect(exec.isActive()).toBe(false);
    expect(s.agent.troops()).toBe(
      home + Math.floor(growth) + refundFor(NATION_ID, frozen),
    );
    // Under the cap, so regrowth keeps all of it. Above the cap the next
    // PlayerExecution tick would cut home back to ceil(maxTroops)
    // (troopIncreaseRate returns max - T, Config.ts:1089; pinned by
    // tests/agent/mechanics/TroopCapClamp.test.ts), so in a real game the
    // gain per cycle is bounded by cap headroom. The duplicated stack in
    // the attack is not capped.
    expect(s.agent.troops()).toBeLessThanOrEqual(
      s.game.config().maxTroops(s.agent),
    );
    expect(only(s.agent.outgoingAttacks())).toBe(merged);
  });
});

describe("AttackMerge: an enemy attack that inits in the retreat step", () => {
  /** Cancel ours, then a nation attack on us that inits `offset` steps after
   * the cancel. It carries ceil(our stack) troops: at least ours, so it
   * deletes ours untouched (AttackExecution.ts:165-167), and is left with
   * under one troop, so it dies on its first tick (:296-300) without
   * touching our land. */
  async function enemyAt(offset: number) {
    const s = await plainsScenario();
    const { a, exec, cancelTick } = attackThenCancel(s, NATION_ID, 20_000);
    runUntilStep(s.game, cancelTick + offset);
    const frozen = a.troops();
    const home = s.agent.troops();
    const tiles = s.agent.numTilesOwned();
    const nationHome = s.nation.troops();
    const theirs = Math.ceil(frozen);
    s.game.addExecution(new AttackExecution(theirs, s.nation, AGENT_ID));
    s.game.executeNextTick();
    // Cancelled out: ours is gone from both lists, theirs holds < 1 troop.
    expect(a.isActive()).toBe(false);
    expect(s.agent.outgoingAttacks()).toHaveLength(0);
    expect(only(s.agent.incomingAttacks()).troops()).toBeLessThan(1);
    expect(s.nation.troops()).toBe(nationHome - theirs);
    run(s.game, 3);
    expect(s.agent.incomingAttacks()).toHaveLength(0);
    expect(s.agent.numTilesOwned()).toBe(tiles);
    return { s, a, exec, frozen, home };
  }

  test("CANCEL_DELAY - 1 steps: our retreating stack is spent on theirs, and nothing comes back", async () => {
    const r = await enemyAt(CANCEL_DELAY - 1);
    expect(r.a.retreated()).toBe(false);
    expect(r.s.agent.troops()).toBe(r.home);
    expect(r.exec.isActive()).toBe(true); // returns at retreating() forever
  });

  test("exactly CANCEL_DELAY steps: our retreated stack cancels theirs 1:1 AND is refunded at 75%", async () => {
    const r = await enemyAt(CANCEL_DELAY);
    expect(r.a.retreated()).toBe(true);
    expect(r.exec.isActive()).toBe(false);
    expect(r.s.agent.troops()).toBe(r.home + refundFor(NATION_ID, r.frozen));
  });
});
