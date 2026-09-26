/**
 * Pins apex spec N3 (§6.1 "AllianceRecallEmbargo", §3.3.2 recall by
 * alliance, C1) against a real NationExecution that attacks us by its own
 * decision.
 *
 * The claim under test: a nation attacking us accepts a similar-strength
 * alliance request if our `embargo stop` takes effect at least one turn
 * before its answering decision (and is re-sent after any new attack by
 * it); without the stop it refuses; on acceptance its attack retreats in
 * full.
 *
 * The rules (the code is the spec):
 * - Its attack makes US embargo IT: AttackExecution.init calls
 *   targetPlayer.addEmbargo(owner, true) for any non-bot pair
 *   (AttackExecution.ts:113-122), at the end of its decision turn. Every
 *   new attack (a top-up merges into a new Attack, :158-167) does it again.
 * - At each decision NationExecution.tick runs updateRelationsFromEmbargos
 *   (NationExecution.ts:219, :313-333) BEFORE handleAllianceRequests (:220):
 *   if we embargo it and it has not yet counted that, its relation to us
 *   takes -20; once we no longer do, it gets +20 back. A relation of 0
 *   becomes -20 (Distrustful), and getAllianceDecision refuses anything
 *   below Neutral that is not a threat (NationAllianceBehavior.ts:152-161).
 * - EmbargoExecution acts in its tick (EmbargoExecution.ts:31-36): a stop
 *   sent at ctx tick s is created at the end of turn s and ticks in turn
 *   s + 1, after the nation's execution (added earlier), so it counts for
 *   decisions d >= s + 2 (spec §2.1).
 * - A request sent at s is created at the end of turn s
 *   (AllianceRequestExecution.init) and answered at the first decision
 *   d > s (NationAllianceBehavior.ts:60-77).
 * - On acceptance, AttackExecution.tick (which runs after the nation's
 *   execution in the same turn) finds the target friendly and retreats
 *   without loss (AttackExecution.ts:285-289, retreat :224-250 with
 *   malusPercent 0).
 *
 * VERDICT: TRUE, on 5 game IDs (5 different decision phases), with the
 * timing made exact:
 * - With the stop and the request sent together at the first tick we see
 *   its attack (tReq = T, the §3.3.2 rule; it decided at T - 1, so its next
 *   decision is >= T + 2), it accepts at that next decision, its relation
 *   to us still 0: the malus was never applied (at the attack's own
 *   decision our embargo did not exist yet, it is created at the end of
 *   that turn).
 * - Without the stop it refuses: the malus lands first (relation -20,
 *   Distrustful), although we are similarly strong.
 * - "At least one turn before" is exact: stop and request sent at d - 2
 *   are accepted at d; sent at d - 1 the stop acts in turn d after the
 *   nation's tick, the malus lands, and it refuses.
 * - A new attack by it (a top-up at a later decision) re-creates our
 *   temporary embargo at its init; a stop sent before that does not carry
 *   over. Re-sent after the new attack, it is accepted.
 * - On acceptance its attack retreats in full in the same turn: its home
 *   gains exactly floor(attack troops) by the next tick, and no attack on
 *   us is left.
 * - Refinement: the similar-strength test counts its attack on us in its
 *   total troops (NationAllianceBehavior.ts:376-383), so the recall needs
 *   our home above 0.8-0.89x (its home + its attack), or our tiles above
 *   0.90-0.99x its tiles with half its total; the scenario sets troops
 *   before the answer so that it holds. And a nation attacking a similarly
 *   strong us may itself request an alliance (maybeSendAllianceRequests,
 *   1 in 30 per decision); a request of ours then counter-accepts at once
 *   (+100). The scenario rejects such requests to keep the test on the
 *   embargo path.
 *
 * Setting: the real Config class as createGameRunner builds it
 * (GameRunner.ts:46: new Config(gameConfig, null, false)), FFA,
 * Singleplayer, Impossible, 400 tribes in the config; the game built as
 * tests/util/Setup.ts builds it (createGame, endSpawnPhase at tick 0) on a
 * synthesized all-plains map: the nation holds x 0-9 (200 tiles), we hold
 * the next 400 tiles, the rest is free land the nation does not touch, so
 * its only bordering player is us and it never locks on free land. No
 * PlayerExecution runs, so troops and relations stay where the test puts
 * them (no income, no decay). The nation's troops are set before its
 * decisions (never during one), so it attacks us at its own decision
 * ("weakest": we are its only bordering enemy with fewer troops). Our
 * intents go through IntentSchema and Executor.createExec, the path of
 * ctx.send. Private fields are read through casts, test only.
 */
import { Config } from "../../../src/core/configuration/Config";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import {
  AllianceRequest,
  Attack,
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
const WIDTH = 100;
const HEIGHT = 20;
const US_TILES = 400;
/** Its home troops before an attack decision, as a share of its cap: above
 *  every trigger (50-59%). */
const NATION_SHARE = 0.62;
/** Our home as a share of its troops: under the 0.909 line it attacks
 *  below (NationSendCap), above half its total (the tile test of
 *  isAlliancePartnerSimilarlyStrong), and no threat (< 1.5x). */
const US_SHARE = 0.8;
/** Our home at the answering decision against its home plus its attack on
 *  us: above every troop threshold of isAlliancePartnerSimilarlyStrong
 *  (nextInt(80, 90)/100 of its troops plus attacks in flight,
 *  NationAllianceBehavior.ts:361-400). */
const SIMILAR = 0.9;

interface NationInternals {
  attackRate: number;
  attackTick: number;
  reserveRatio: number;
  triggerRatio: number;
  behaviorsInitialized: boolean;
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
  const t = new Uint8Array(WIDTH * HEIGHT).fill(LAND);
  const mw = WIDTH / 2;
  const mh = HEIGHT / 2;
  const m = new Uint8Array(mw * mh).fill(LAND);
  const map = new GameMapImpl(WIDTH, HEIGHT, t, WIDTH * HEIGHT);
  const mini = new GameMapImpl(mw, mh, m, mw * mh);
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
    for (let y = 0; y < HEIGHT; y++) nation.conquer(game.ref(x, y));
  }
  for (let i = 0; i < US_TILES; i++) {
    us.conquer(game.ref(10 + Math.floor(i / HEIGHT), i % HEIGHT));
  }
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

function advanceTo(w: World, t: number): void {
  while (w.game.ticks() < t) tick(w);
}

function send(w: World, intent: Intent): void {
  expect(IntentSchema.safeParse(intent).success).toBe(true);
  w.game.addExecution(
    w.executor.createExec({ ...intent, clientID: AGENT_CLIENT }),
  );
}

function relationValue(from: Player, to: Player): number {
  const rel = (from as unknown as { relations: Map<Player, number> }).relations;
  return rel.get(to) ?? 0;
}

function isDecision(w: World, t: number): boolean {
  return t % w.n.attackRate === w.n.attackTick;
}

/** First decision turn >= from. */
function nextDecisionTurn(w: World, from: number): number {
  let d = from;
  while (!isDecision(w, d)) d++;
  return d;
}

/** Runs up to (not into) turn t: afterwards game.ticks() === t. */
function toTurn(w: World, t: number): void {
  expect(w.game.ticks()).toBeLessThanOrEqual(t);
  advanceTo(w, t);
}

function attackOnUs(w: World): Attack | undefined {
  return w.nation.outgoingAttacks().find((a) => a.target() === w.us);
}

/** Sets troops for an attack decision: its share of its cap, ours of its. */
function arm(w: World): void {
  const T = Math.floor(w.config.maxTroops(w.nation) * NATION_SHARE);
  w.nation.setTroops(T);
  w.us.setTroops(Math.floor(T * US_SHARE));
}

/**
 * Starts the nation past tick 700 (no early-game acceptance), then runs its
 * decisions until one attacks us, arming both sides before each. Returns
 * the decision turn d0; afterwards game.ticks() === d0 + 1 and the attack
 * exists.
 */
function untilItAttacks(w: World): number {
  advanceTo(w, 750);
  w.game.addExecution(w.exec);
  tick(w, 3);
  expect(w.n.behaviorsInitialized).toBe(true);
  for (let k = 0; k < 20; k++) {
    const d = nextDecisionTurn(w, w.game.ticks());
    toTurn(w, d);
    arm(w);
    tick(w);
    // A request of its own to us would open the counter-accept path
    // (+100, AllianceRequestExecution.ts:45-63): we refuse it
    // (allianceReject; no relation change, GameImpl.ts:477-489).
    refuseItsRequest(w);
    if (attackOnUs(w) !== undefined) return d;
  }
  throw new Error("the nation never attacked us");
}

/** Rejects a pending request of its own to us, in the next turn. */
function refuseItsRequest(w: World): void {
  const theirs = w.us
    .incomingAllianceRequests()
    .filter((r) => r.requestor() === w.nation);
  if (theirs.length === 0) return;
  send(w, { type: "allianceReject", requestor: NATION_ID });
  tick(w);
  expect(theirs[0].status()).toBe("rejected");
}

function ourRequest(w: World): AllianceRequest {
  const reqs = w.nation
    .incomingAllianceRequests()
    .filter((r) => r.requestor() === w.us);
  expect(reqs).toHaveLength(1);
  return reqs[0];
}

interface Outcome {
  accepted: boolean;
  /** Turn of the answering decision. */
  answeredAt: number;
  /** Its relation to us right after the decision. */
  relation: number;
  /** Troops of its attack on us just before the answering turn. */
  attackTroops: number;
  /** Its home troops just before and just after the answering turn. */
  homeBefore: number;
  homeAfter: number;
  /** Its attacks on us after the answering turn. */
  attacksAfter: number;
}

/**
 * Runs to the decision that answers our pending request and through it.
 * Just before it, both sides are set so that we are similarly strong by
 * troops for every draw and no threat: its home at 62% of its cap, ours just
 * above 90% of its home plus its attack on us, and not a threat by any
 * clause of isAlliancePartnerThreat (NationAllianceBehavior.ts:267-279).
 * The relation is then the only gate.
 */
function answer(w: World, req: AllianceRequest): Outcome {
  const d = nextDecisionTurn(w, req.createdAt() + 1);
  toTurn(w, d);
  const attack = attackOnUs(w);
  const attackTroops = attack?.troops() ?? 0;
  const T = Math.floor(w.config.maxTroops(w.nation) * NATION_SHARE);
  w.nation.setTroops(T);
  w.us.setTroops(Math.floor((T + attackTroops) * SIMILAR) + 1);
  const H = w.us.troops();
  expect(H).toBeGreaterThan((T + attackTroops) * 0.89);
  const threat =
    H > 1.5 * T ||
    (H > T &&
      (w.config.maxTroops(w.us) > 1.5 * w.config.maxTroops(w.nation) ||
        w.us.numTilesOwned() > 1.5 * w.nation.numTilesOwned()));
  expect(threat).toBe(false);
  const homeBefore = w.nation.troops();
  tick(w);
  expect(req.status()).not.toBe("pending");
  return {
    accepted: req.status() === "accepted",
    answeredAt: d,
    relation: relationValue(w.nation, w.us),
    attackTroops,
    homeBefore,
    homeAfter: w.nation.troops(),
    attacksAfter: attackOnUs(w) === undefined ? 0 : 1,
  };
}

const GAME_IDS = ["recall-a", "recall-b", "recall-c", "recall-d", "recall-e"];

describe("AllianceRecallEmbargo (N3)", () => {
  test("setting: it attacks us by its own decision and we embargo it", () => {
    for (const id of GAME_IDS) {
      const w = world(id);
      const d0 = untilItAttacks(w);
      expect(isDecision(w, d0)).toBe(true);
      // AttackExecution.init: we now embargo it (temporary).
      expect(w.us.hasEmbargoAgainst(w.nation)).toBe(true);
      // Its relation to us is untouched until its next decision.
      expect(relationValue(w.nation, w.us)).toBe(0);
      // It sent its attack from the reserve surplus, capped by our home
      // (troopSendCap, NationSendCap).
      expect(attackOnUs(w)!.troops()).toBeGreaterThan(0);
    }
  });

  test("stop + request timed as §3.3.2: accepted, and its attack retreats in full", () => {
    for (const id of GAME_IDS) {
      const w = world(id);
      untilItAttacks(w);
      const T = w.game.ticks();
      // tReq = T unless it decides in turn T + 1 (it just decided at T-1).
      expect(nextDecisionTurn(w, T + 1)).toBeGreaterThanOrEqual(T + 2);
      send(w, { type: "embargo", targetID: NATION_ID, action: "stop" });
      send(w, { type: "allianceRequest", recipient: NATION_ID });
      tick(w);
      const req = ourRequest(w);
      expect(req.createdAt()).toBe(T);
      const o = answer(w, req);
      expect(o.answeredAt).toBeGreaterThanOrEqual(T + 2);
      expect(o.accepted).toBe(true);
      expect(o.relation).toBe(0);
      expect(w.us.isAlliedWith(w.nation)).toBe(true);
      // In full: its home gains exactly the attack's troops, no attack
      // left (no PlayerExecution runs, so nothing else moves its troops).
      expect(o.attackTroops).toBeGreaterThan(0);
      expect(o.attacksAfter).toBe(0);
      expect(o.homeAfter - o.homeBefore).toBe(Math.floor(o.attackTroops));
    }
  });

  test("no stop: the embargo malus (-20) lands first and it refuses", () => {
    for (const id of GAME_IDS) {
      const w = world(id);
      untilItAttacks(w);
      send(w, { type: "allianceRequest", recipient: NATION_ID });
      tick(w);
      const o = answer(w, ourRequest(w));
      expect(o.accepted).toBe(false);
      expect(o.relation).toBe(-20);
      expect(w.nation.relation(w.us)).toBe(Relation.Distrustful);
    }
  });

  test("the stop must be sent 2 ticks before the answering decision: at d-2 accepted, at d-1 refused", () => {
    for (const id of GAME_IDS) {
      for (const lead of [2, 1]) {
        const w = world(id);
        untilItAttacks(w);
        const d = nextDecisionTurn(w, w.game.ticks());
        // Request and stop together, `lead` ticks before decision d.
        toTurn(w, d - lead);
        send(w, { type: "embargo", targetID: NATION_ID, action: "stop" });
        send(w, { type: "allianceRequest", recipient: NATION_ID });
        tick(w);
        const o = answer(w, ourRequest(w));
        expect(o.answeredAt).toBe(d);
        expect(o.accepted).toBe(lead === 2);
        expect(o.relation).toBe(lead === 2 ? 0 : -20);
      }
    }
  });

  test("a new attack by it re-creates the embargo: a stop sent before it does not carry over", () => {
    for (const id of GAME_IDS) {
      for (const reStop of [false, true]) {
        const w = world(id);
        untilItAttacks(w);
        // Stop now; it takes effect before its next decision.
        send(w, { type: "embargo", targetID: NATION_ID, action: "stop" });
        tick(w, 2);
        expect(w.us.hasEmbargoAgainst(w.nation)).toBe(false);
        // Its next decisions, armed, until it sends a new attack at us.
        let d1 = -1;
        for (let k = 0; k < 20 && d1 < 0; k++) {
          const d = nextDecisionTurn(w, w.game.ticks());
          toTurn(w, d);
          const before = attackOnUs(w)?.id();
          arm(w);
          tick(w);
          const after = attackOnUs(w)?.id();
          if (after !== undefined && after !== before) d1 = d;
        }
        expect(d1).toBeGreaterThan(0);
        // The stop was in effect at d1: no malus then.
        expect(relationValue(w.nation, w.us)).toBe(0);
        // Its new attack re-created our embargo.
        expect(w.us.hasEmbargoAgainst(w.nation)).toBe(true);
        if (reStop) {
          send(w, { type: "embargo", targetID: NATION_ID, action: "stop" });
        }
        send(w, { type: "allianceRequest", recipient: NATION_ID });
        tick(w);
        const o = answer(w, ourRequest(w));
        expect(o.accepted).toBe(reStop);
        expect(o.relation).toBe(reStop ? 0 : -20);
        if (reStop) {
          expect(o.attacksAfter).toBe(0);
          expect(o.homeAfter - o.homeBefore).toBe(Math.floor(o.attackTroops));
        }
      }
    }
  });
});
