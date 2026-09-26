/**
 * Pins the mechanic behind apex o.webFriend (package B2): a troop gift to an
 * Impossible ally, timed to land in the turn before one of its decisions,
 * makes that decision judge our pending extension as Friendly, which beats
 * the extension trap (chapter 13 §2.9: with non-bot neighbours [us, X], X
 * not its ally, only a threat or a Friendly requester is extended).
 *
 * The rules (the code is the spec):
 * - DonateTroopsExecution (src/core/execution/DonateTroopExecution.ts)
 *   inits at the end of the turn its intent arrives in (s), cutting the gift
 *   to the recipient's cap headroom (:52-56), and pays in its tick in turn
 *   s + 1 (:60-73): +50 relation if the gift is at least
 *   nextInt(M/7, M/5) at Impossible, M the recipient's maxTroops (:99-129).
 *   It needs an ally (canDonateTroops, isFriendly) and 100 ticks
 *   (donateCooldown) since our last gift to it.
 * - Executions tick in the order they were added (GameImpl.executeNextTick):
 *   the gift, added last, pays after the nation's NationExecution and its
 *   PlayerExecution (added at its spawn) in turn s + 1. So the decision in
 *   turn s + 2 is the first to see the +50, before PlayerExecution's decay
 *   of that turn (PlayerImpl.decayRelations: 0.05 a tick toward 0): it
 *   reads 50 + r. The decision in turn s + 3 reads 49.95 + r.
 * - At its decision, handleAllianceExtensionRequests re-decides a pending
 *   extension (NationAllianceBehavior.ts:79-94) with getAllianceDecision:
 *   Friendly (value >= 50) is accepted when nextInt(0, 100) >= 33, before
 *   checkAlreadyEnoughAlliances (the trap) can refuse it.
 *
 * Setting as tests/agent/mechanics/NationAlliance.test.ts (its world:
 * 60 x 20 plains, the nation on x 0-9, us on 150 tiles from x = 10, three
 * inert non-bot others, one of them given a tile next to the nation so it
 * has two non-bot neighbours), with the nation's PlayerExecution running so
 * relations decay as in a game.
 */
import { Config } from "../../../src/core/configuration/Config";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import {
  AllianceRequest,
  Cell,
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Nation,
  Player,
  PlayerInfo,
  PlayerType,
  Relation,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { GameConfig, Intent, IntentSchema } from "../../../src/core/Schemas";

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
const LAND = 0x80 | 5;
const W = 60;
const H = 20;

interface NationInternals {
  attackRate: number;
  attackTick: number;
}

interface World {
  game: Game;
  config: Config;
  us: Player;
  nation: Player;
  exec: NationExecution;
  n: NationInternals;
  executor: Executor;
}

function world(gameID: string): World {
  const t = new Uint8Array(W * H).fill(LAND);
  const m = new Uint8Array((W / 2) * (H / 2)).fill(LAND);
  const map = new GameMapImpl(W, H, t, W * H);
  const mini = new GameMapImpl(W / 2, H / 2, m, (W * H) / 4);
  const config = new Config(GAME_CONFIG, null, false);
  const nationObj = new Nation(
    new Cell(0, 0),
    new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
  );
  const game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    [nationObj],
    map,
    mini,
    config,
  );
  game.endSpawnPhase();
  const us = game.player(AGENT_ID);
  const nation = game.player(NATION_ID);
  for (let x = 0; x < 10; x++) {
    for (let y = 0; y < H; y++) nation.conquer(game.ref(x, y));
  }
  for (let i = 0; i < 150; i++) {
    us.conquer(game.ref(10 + Math.floor(i / H), i % H));
  }
  // Three inert non-bot others (5 non-bot players: one alliance passes the
  // 25% limit), the first also next to the nation: the extension trap.
  for (let i = 0; i < 3; i++) {
    const p = game.addPlayer(
      new PlayerInfo(`other${i}`, PlayerType.Nation, null, `OTHER00${i}`),
    );
    for (let x = 30 + 2 * i; x < 32 + 2 * i; x++) {
      for (let y = 0; y < H; y++) p.conquer(game.ref(x, y));
    }
    if (i === 0) p.conquer(game.ref(10, 19));
  }
  us.setTroops(19_000);
  nation.setTroops(20_000);
  const exec = new NationExecution(gameID, nationObj);
  return {
    game,
    config,
    us,
    nation,
    exec,
    n: exec as unknown as NationInternals,
    executor: new Executor(game, gameID, undefined),
  };
}

function tick(w: World, n = 1): void {
  for (let i = 0; i < n; i++) w.game.executeNextTick();
}

function send(w: World, intent: Intent): void {
  expect(IntentSchema.safeParse(intent).success).toBe(true);
  w.game.addExecution(
    w.executor.createExec({ ...intent, clientID: AGENT_CLIENT }),
  );
}

function isDecisionTick(w: World, t: number): boolean {
  return t % w.n.attackRate === w.n.attackTick;
}

function relationValue(of: Player, toward: Player): number {
  const m = (of as unknown as { relations: Map<Player, number> }).relations;
  return m.get(toward) ?? 0;
}

/** Allied at tick >= 700 (no early-game acceptance) as similarly strong
 *  (19k against 20k: not a threat), then the extension asked and refused
 *  at two decisions (the trap). Returns the alliance's expiry. */
function trapped(w: World): number {
  while (w.game.ticks() < 700) tick(w);
  w.game.addExecution(w.exec);
  tick(w, 3);
  send(w, { type: "allianceRequest", recipient: NATION_ID });
  tick(w);
  const req: AllianceRequest = w.nation
    .incomingAllianceRequests()
    .find((r) => r.requestor() === w.us)!;
  for (let i = 0; i < 60 && req.status() === "pending"; i++) tick(w);
  expect(req.status()).toBe("accepted");
  // From here relations decay (and its troops regrow) as in a game; added
  // after the NationExecution, as SpawnExecution adds it in a game.
  w.game.addExecution(new PlayerExecution(w.nation));
  const alliance = w.us.allianceWith(w.nation)!;
  send(w, { type: "allianceExtension", recipient: NATION_ID });
  tick(w);
  for (let k = 0; k < 2; k++) {
    while (!isDecisionTick(w, w.game.ticks())) tick(w);
    tick(w);
  }
  expect(alliance.agreedToExtend(w.us)).toBe(true);
  expect(alliance.agreedToExtend(w.nation)).toBe(false);
  return alliance.expiresAt();
}

/**
 * Gives ceil(M/5) + 1 troops `lead` turns before the nation's next decision
 * (sent when the next tick to run is d − lead); returns whether that
 * decision extended the alliance, and the relation it read.
 */
function giftBefore(
  w: World,
  lead: number,
): { extended: boolean; relation: number } {
  const alliance = w.us.allianceWith(w.nation)!;
  const expires = alliance.expiresAt();
  while (!isDecisionTick(w, w.game.ticks() + lead)) tick(w);
  const d = w.game.ticks() + lead;
  const M = w.config.maxTroops(w.nation);
  const gift = Math.ceil(M / 5) + 1;
  w.us.setTroops(19_000 + gift);
  expect(w.config.maxTroops(w.nation) - w.nation.troops()).toBeGreaterThan(
    gift,
  );
  send(w, { type: "donate_troops", recipient: NATION_ID, troops: gift });
  while (w.game.ticks() < d) tick(w);
  const relation = relationValue(w.nation, w.us);
  tick(w); // the decision
  expect(isDecisionTick(w, w.game.ticks() - 1)).toBe(true);
  return { extended: alliance.expiresAt() !== expires, relation };
}

describe("a timed troop gift beats the extension trap", () => {
  test("without a gift the trapped extension is refused at every decision", () => {
    const w = world("friend-none");
    const expires = trapped(w);
    for (let k = 0; k < 5; k++) {
      while (!isDecisionTick(w, w.game.ticks())) tick(w);
      // Its regrowth would soon make us weak enough to betray (isSafeToBetray:
      // our troops < 0.33x its); held where the trap is the only refusal.
      w.nation.setTroops(20_000);
      tick(w);
    }
    expect(w.us.allianceWith(w.nation)!.expiresAt()).toBe(expires);
    expect(w.nation.relation(w.us)).toBe(Relation.Neutral);
  });

  test("a gift paid in the turn before the decision (sent 2 turns ahead) reads 50: Friendly, extended about 2 times in 3; sent 3 turns ahead it reads 49.95 and is refused", () => {
    const SEEDS = 30;
    let onTime = 0;
    let early = 0;
    for (let i = 0; i < SEEDS; i++) {
      const a = world(`friend-${i}`);
      trapped(a);
      const r2 = giftBefore(a, 2);
      expect(r2.relation).toBe(50);
      if (r2.extended) onTime++;
      const b = world(`friend-${i}`);
      trapped(b);
      const r3 = giftBefore(b, 3);
      expect(r3.relation).toBeCloseTo(49.95, 10);
      expect(b.nation.relation(b.us)).toBe(Relation.Neutral);
      if (r3.extended) early++;
    }
    // isAlliancePartnerFriendly: nextInt(0, 100) >= 33, 67 in 100.
    expect(onTime).toBeGreaterThanOrEqual(12);
    expect(onTime).toBeLessThanOrEqual(28);
    expect(early).toBe(0);
  });
});
