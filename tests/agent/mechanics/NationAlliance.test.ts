/**
 * Pins roadmap H6 (docs/11-roadmap.md §11.3; the risk table asks for every
 * mechanic an agent relies on to be pinned here) against a real
 * NationExecution and the real alliance executions.
 *
 * The claim under test ("NationAlliance"): Impossible accepts an alliance
 * request from anyone with 1.5x its troops, or with more troops and 1.5x its
 * cap or tiles (isAlliancePartnerThreat); it refuses traitors 90% of the time
 * and anyone already allied with >= 25% of the non-bot players; before tick
 * 700 in singleplayer it accepts 30% of other requests (isEarlygame); allies
 * cannot attack each other; alliances expire after 5 minutes at no cost;
 * breaking makes the breaker a traitor for 30 s (half attacker losses and 25%
 * faster attacks against it, -40 relation from its neighbours).
 *
 * The rules (the code is the spec; NationAllianceBehavior.ts unless named):
 * - When. NationExecution.tick (src/core/execution/NationExecution.ts:
 *   109-229) decides once every attackRate ticks (Impossible nextInt(30, 50),
 *   :102-103; gate :200-216): updateRelationsFromEmbargos (:219), then
 *   handleAllianceRequests (:220) and handleAllianceExtensionRequests (:221),
 *   later maybeAttack (:226). A request lives allianceRequestDuration() =
 *   200 ticks (Config.ts:807-809, AllianceRequestExecution.ts:80-86), so each
 *   is answered at the nation's next decision, 1-49 ticks after it is made.
 * - handleAllianceRequests (:60-77) rejects a request created at tick <=
 *   numSpawnPhaseTurns() + 1 (:64-70); that is 100 + 1 in singleplayer
 *   (Config.ts:856-864) however early our spawn ended the spawn phase
 *   (SpawnExecution.ts:121-128). Else getAllianceDecision(us, true)
 *   (:119-179), first match wins:
 *    1 confused: never on Impossible (isConfused :202-216);
 *    2 traitor: reject if nextInt(0, 100) >= 10, i.e. 90% (:127-133);
 *    3 hasTooManyAlliances (:181-200): reject if our alliances >= 0.25 x the
 *      living non-bot players (players() is the living, GameImpl.ts:691-693;
 *      us and it included, tribes not);
 *    4 isAlliancePartnerThreat (:251-283, Impossible :267-279): accept if
 *      our troops() > 1.5x its troops(), or ours > its and (Config.maxTroops
 *      > 1.5x its, or tiles > 1.5x its). troops() is home troops only; the
 *      Impossible cap is x1.25 (Config.ts:1024-1052);
 *    5 team games only (shouldRejectInTeamGame :285-303);
 *    6 reject if relation < Neutral, i.e. value < 0 (:155-161;
 *      PlayerImpl.ts:946-958);
 *    7 accept if Friendly (value >= 50) and nextInt(0, 100) >= 33 (:339-358);
 *    8 checkAlreadyEnoughAlliances (:305-337, Impossible :313-332): with >= 2
 *      non-bot neighbours, us among them, reject if all the others are its
 *      friends; otherwise reject if its alliances >= nextInt(2, 4);
 *    9 isEarlygame (:218-249, Impossible :240-245): accept if ticks() < 600 +
 *      numSpawnPhaseTurns() = 700 and nextInt(0, 100) >= 70;
 *   10 isAlliancePartnerSimilarlyStrong (:361-400): accept if our troops +
 *      outgoing attacks > its (troops + outgoing) x nextInt(80, 90)/100, or
 *      our tiles > its x nextInt(90, 100)/100 with our troops + outgoing >
 *      0.5x its; else reject. (nextInt is upper-exclusive,
 *      src/core/PseudoRandom.ts:61-65.)
 * - Acceptance (GameImpl.acceptAllianceRequest, GameImpl.ts:439-473) changes
 *   no relation; the counter-request path (both ask, AllianceRequestExecution
 *   .ts:45-65) also gives +100 both ways, ends temporary embargoes and
 *   destroys nukes in flight between the two.
 * - Duration: expiresAt = createdAt + allianceDuration() (AllianceImpl.ts:23;
 *   3000 ticks unless customAllianceDuration, Config.ts:813-819), expired by
 *   PlayerExecution.tick (PlayerExecution.ts:105-109) through
 *   GameImpl.expireAlliance (GameImpl.ts:910-930: stats and detach only).
 *   Extension: AllianceExtensionExecution has no timing check
 *   (AllianceExtensionExecution.ts:23-87); the nation agrees when
 *   getAllianceDecision(us) says yes now (:79-94), and extend() sets
 *   expiresAt = now + allianceDuration() (AllianceImpl.ts:88-92).
 * - Allies (isFriendly, PlayerImpl.ts:1296-1304): AttackExecution.init drops
 *   an attack on a friend (AttackExecution.ts:101-111) and a running attack
 *   retreats without loss once they are friends (:285-288, retreat
 *   :224-250). TransportShipExecution.init refuses a boat
 *   (TransportShipExecution.ts:109-112), but one already at sea conquers its
 *   landing tile and adds its troops home (:270-275). Nukes: nukeSpawn
 *   refuses teammates only (PlayerImpl.ts:1625-1645); at launch
 *   NukeExecution.maybeBreakAlliances (NukeExecution.ts:148-197, :232-234)
 *   breaks with every player listNukeBreakAlliance names (Util.ts:100-129):
 *   weighted tiles (1 inside inner, 0.5 to outer; AtomBomb 12/30,
 *   Config.ts:1103-1113) > nukeAllianceBreakThreshold() = 100
 *   (Config.ts:1115-1117), or a structure within outer.
 * - Relations: our attack on it -100 (AttackExecution.ts:190-209); its attack
 *   on us makes us embargo it (AttackExecution.ts:113-122), for which it
 *   takes -20 at its next decision until the embargo ends
 *   (NationExecution.ts:314-333); relations decay 0.05 a tick toward 0 in
 *   PlayerExecution (PlayerExecution.ts:57, PlayerImpl.ts:978-988).
 * - Breaking: GameImpl.breakAlliance marks the breaker a traitor unless the
 *   other already is one (GameImpl.ts:874-906, :887); isTraitor() holds for
 *   traitorDuration() = 300 ticks from the break tick (PlayerImpl.ts:869-879,
 *   Config.ts:293-295). BreakAllianceExecution (:33-59) gives -100 from the
 *   betrayed (:46) and -40 from every player in the breaker's nearby()
 *   (:48-56). attackLogic against a traitor multiplies the attacker's loss by
 *   traitorDefenseDebuff() = 0.5 and the time per tile by traitorSpeedDebuff()
 *   = 0.8 (Config.ts:287-292, :933-968; fed by AttackExecution.ts:377). An
 *   Impossible ally betrays a traitor with < 1.2x its troops (maybeBetray
 *   :440-448, via the betray strategy AiAttackBehavior.ts:346-347, :428,
 *   :583-608) and attacks it in the same decision (:604); non-allied ones
 *   attack traitors with < 1.2x their troops (traitor strategy, findTraitor
 *   AiAttackBehavior.ts:570-581; shouldAttack :932-943).
 *
 * VERDICT: PARTIAL. Every rule the claim lists holds as stated (threat test
 * strict and on home troops; traitors 12 of 100 accepted here; 25% of the
 * living non-bot players, tested before the threat; 30 of 100 before tick
 * 700; 3000-tick lapse with no cost; traitor for 300 ticks; x0.5 loss and
 * x0.8 time per tile, i.e. 1.25x speed; -40 from neighbours). Missing or
 * wrong:
 * - The threat test is not the main way in: at any time it accepts anyone
 *   "similarly strong" (>= 0.90x its troops counting attacks in flight on
 *   both sides always passes, <= 0.80x never), and 71 of 100 Friendly ones,
 *   unless its relation to us is below Neutral or the neighbour limit (8)
 *   applies. isEarlygame only adds 30% for requesters that are neither.
 * - Requests made by tick 101 are always refused, threats too.
 * - The relation gate: our attack makes it Hostile, its attack on us costs
 *   -20 through our automatic embargo (lifting the embargo restores it);
 *   either blocks everything but a threat.
 * - Extensions: askable any time, restart the 5 minutes from the nation's
 *   decision (not added), and need a yes now with this alliance counted in
 *   the 25% (so with 2 non-bot players never); a refused one stays asked.
 * - Allies cannot land-attack each other, and a running attack either way
 *   retreats in full the tick the alliance forms; a boat at sea still takes
 *   its landing tile; nukes on an ally are allowed and break the alliance
 *   (traitor) only above 100 weighted tiles or with one of its structures in
 *   range.
 * - Breaking also costs -100 from the betrayed (-140 if also a neighbour),
 *   -40 from every player next to us (tribes too, by the code), and the
 *   betrayal, plus an attack, by every Impossible ally we have less than
 *   1.2x the troops of, at its next decision that reaches its strategy list
 *   (above its reserve). Breaking with a traitor marks no one.
 *
 * Setting: the real Config class (not TestConfig, tests/util/TestConfig.ts),
 * built as the arena builds it (GameRunner.ts:46: new Config(config, null,
 * false)): FFA, Singleplayer, Impossible, 400 tribes in the config, Normal
 * size; the game made as tests/util/Setup.ts makes it (createGame,
 * endSpawnPhase at tick 0). Maps are synthesized plains (60 x 20, the
 * nation on 200 tiles bordering only us, unless a test says so), except in
 * the boat test (tests/testdata/maps/ocean_and_land through setup() with the
 * real Config). The NationExecution is the real one, seeded as in a game
 * (gameID + nation id); the seed sweeps vary the gameID. "Others" are
 * Nation seats with no NationExecution. No PlayerExecution runs except in
 * the lapse test, so troops and relations stay where the test puts them (the
 * real game adds income and relation decay). Tests set troops, relations,
 * tiles, gold and units to build scenarios (agents never may); our own
 * actions go through IntentSchema and Executor.createExec, the path of
 * ctx.send (AgentHost.isValid, src/agent/AgentHost.ts:197-205).
 */
import { Config } from "../../../src/core/configuration/Config";
import { AllianceRequestExecution } from "../../../src/core/execution/alliance/AllianceRequestExecution";
import { BreakAllianceExecution } from "../../../src/core/execution/alliance/BreakAllianceExecution";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import { computeNukeBlastCounts } from "../../../src/core/execution/Util";
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
  TerrainType,
  UnitType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl, TileRef } from "../../../src/core/game/GameMap";
import { GameConfig, Intent, IntentSchema } from "../../../src/core/Schemas";
import { setup } from "../../util/Setup";

const AGENT_CLIENT = "AGENTCL1";
const AGENT_ID = "AGENTID1";
const NATION_ID = "NATION01";

/** The arena's setting (the rest as tests/util/Setup.ts defaults it). */
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

// Terrain byte (GameMap.ts: bit 7 land, bits 0-4 magnitude; land magnitude
// < 10 is Plains). No water, so no shoreline bits are needed.
const LAND = 0x80 | 5;

/** Where the nation's 30-49 tick decision cycle is read (never written). */
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
  others: Player[];
  tribes: Player[];
  exec: NationExecution;
  n: NationInternals;
  executor: Executor;
}

interface Spec {
  width?: number;
  height?: number;
  /** Our tiles, filled column by column from x = 10 (default 200). */
  usTiles?: number;
  /** Inert non-bot players (Nation seats, no NationExecution). */
  others?: number;
  /** Tribes (PlayerType.Bot, no TribeExecution). */
  tribes?: number;
  gameID?: string;
}

function fill(
  game: Game,
  p: Player,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): void {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) p.conquer(game.ref(x, y));
  }
}

/**
 * A plains map with us (Human) and one Nation, built as the arena builds its
 * game (new Config(config, null, false), GameRunner.ts:46) and as
 * tests/util/Setup.ts builds a test game (createGame, endSpawnPhase).
 */
function base(width: number, height: number, gameID: string) {
  const t = new Uint8Array(width * height).fill(LAND);
  const mw = Math.ceil(width / 2);
  const mh = Math.ceil(height / 2);
  const m = new Uint8Array(mw * mh).fill(LAND);
  const map = new GameMapImpl(width, height, t, width * height);
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
  return {
    game,
    config,
    nationObj,
    us: game.player(AGENT_ID),
    nation: game.player(NATION_ID),
    executor: new Executor(game, gameID, undefined),
  };
}

/**
 * The nation holds x 0-9 (200 tiles at height 20), we hold the next usTiles
 * tiles column by column from x = 10, inert others hold 2-column strips from
 * x = 30 and tribes 1-column strips at the right edge; the rest is free land
 * that the nation does not touch (so it never expands).
 */
function world(spec: Spec = {}): World {
  const width = spec.width ?? 60;
  const height = spec.height ?? 20;
  const gameID = spec.gameID ?? "nation-alliance";
  const b = base(width, height, gameID);
  const { game } = b;
  fill(game, b.nation, 0, 10, 0, height);
  const usTiles = spec.usTiles ?? 200;
  for (let i = 0; i < usTiles; i++) {
    b.us.conquer(game.ref(10 + Math.floor(i / height), i % height));
  }
  const others: Player[] = [];
  for (let i = 0; i < (spec.others ?? 0); i++) {
    const p = game.addPlayer(
      new PlayerInfo(`other${i}`, PlayerType.Nation, null, `OTHER00${i}`),
    );
    fill(game, p, 30 + 2 * i, 32 + 2 * i, 0, height);
    others.push(p);
  }
  const tribes: Player[] = [];
  for (let i = 0; i < (spec.tribes ?? 0); i++) {
    const p = game.addPlayer(
      new PlayerInfo(`tribe${i}`, PlayerType.Bot, null, `TRIBE00${i}`),
    );
    fill(game, p, width - 1 - i, width - i, 0, height);
    tribes.push(p);
  }
  b.us.setTroops(10_000);
  b.nation.setTroops(20_000);
  const exec = new NationExecution(gameID, b.nationObj);
  return {
    game,
    config: b.config,
    us: b.us,
    nation: b.nation,
    others,
    tribes,
    exec,
    n: exec as unknown as NationInternals,
    executor: b.executor,
  };
}

function tick(w: { game: Game }, n = 1): void {
  for (let i = 0; i < n; i++) w.game.executeNextTick();
}

/** Runs ticks until the next tick to run is `t`. */
function advanceTo(w: { game: Game }, t: number): void {
  expect(w.game.ticks()).toBeLessThanOrEqual(t);
  while (w.game.ticks() < t) tick(w);
}

/** The agent's path: IntentSchema (AgentHost.ts:202), Executor.createExec. */
function send(w: { game: Game; executor: Executor }, intent: Intent): void {
  expect(IntentSchema.safeParse(intent).success).toBe(true);
  w.game.addExecution(
    w.executor.createExec({ ...intent, clientID: AGENT_CLIENT }),
  );
}

/**
 * Adds the NationExecution and runs it past its first ticks: init, then the
 * behaviours and the opening troops/2 on free land (NationExecution.ts:
 * 190-198), which with no free land next to it retreats in full the tick
 * after (AttackExecution.ts:302-306).
 */
function startNation(w: World): void {
  const troops = w.nation.troops();
  w.game.addExecution(w.exec);
  tick(w, 3);
  expect(w.n.behaviorsInitialized).toBe(true);
  expect(w.nation.outgoingAttacks()).toHaveLength(0);
  expect(w.nation.troops()).toBe(troops);
}

function isDecisionTick(w: World, t: number): boolean {
  return t % w.n.attackRate === w.n.attackTick;
}

function pendingFromUs(w: World): AllianceRequest {
  const reqs = w.nation
    .incomingAllianceRequests()
    .filter((r) => r.requestor() === w.us);
  expect(reqs).toHaveLength(1);
  return reqs[0];
}

/** Sends our request to the nation; returns it once created (next tick). */
function request(w: World): AllianceRequest {
  send(w, { type: "allianceRequest", recipient: NATION_ID });
  tick(w);
  const req = pendingFromUs(w);
  expect(req.createdAt()).toBe(w.game.ticks() - 1);
  return req;
}

/**
 * Sends our request and starts the nation in the same tick (request first),
 * so the nation has made no decision (and sent no request of its own) before
 * it sees ours.
 */
function requestThenStart(w: World): AllianceRequest {
  send(w, { type: "allianceRequest", recipient: NATION_ID });
  w.game.addExecution(w.exec);
  tick(w);
  const req = pendingFromUs(w);
  expect(req.createdAt()).toBe(w.game.ticks() - 1);
  return req;
}

interface Answer {
  accepted: boolean;
  /** The tick the nation answered in. */
  tick: number;
}

/** Runs until the nation answers `req`; it does so on a decision tick. */
function answer(w: World, req: AllianceRequest): Answer {
  for (let i = 0; i < 60 && req.status() === "pending"; i++) tick(w);
  expect(req.status()).not.toBe("pending");
  const t = w.game.ticks() - 1;
  expect(isDecisionTick(w, t)).toBe(true);
  // Answered by the nation, well inside the request's 200-tick life
  // (AllianceRequestExecution.ts:80-86).
  expect(t - req.createdAt()).toBeLessThanOrEqual(w.n.attackRate + 1);
  expect(w.us.isAlliedWith(w.nation)).toBe(req.status() === "accepted");
  return { accepted: req.status() === "accepted", tick: t };
}

/** Allies us with p through the counter-request path (both sides ask). */
function allyUsWith(
  w: { game: Game; executor: Executor; us: Player },
  p: Player,
) {
  w.game.addExecution(new AllianceRequestExecution(p, AGENT_ID));
  send(w, { type: "allianceRequest", recipient: p.id() });
  tick(w);
  expect(w.us.isAlliedWith(p)).toBe(true);
}

/** Breaks our alliance with p by intent; returns the tick it broke in. */
function breakWith(
  w: { game: Game; executor: Executor; us: Player },
  p: Player,
): number {
  send(w, { type: "breakAlliance", recipient: p.id() });
  tick(w); // init
  tick(w); // tick breaks it (BreakAllianceExecution.ts:33-59)
  expect(w.us.isAlliedWith(p)).toBe(false);
  return w.game.ticks() - 1;
}

/** A player's raw relation value toward another (read, never written). */
function relationValue(of: Player, toward: Player): number {
  const m = (of as unknown as { relations: Map<Player, number> }).relations;
  return m.get(toward) ?? 0;
}

/** Runs until the next tick to run is the eve of a decision tick. */
function toEveOfDecision(w: World): void {
  while (!isDecisionTick(w, w.game.ticks() + 1)) tick(w);
}

/** Runs until the nation's next decision tick has run; returns that tick. */
function throughNextDecision(w: World): number {
  while (!isDecisionTick(w, w.game.ticks())) tick(w);
  tick(w);
  return w.game.ticks() - 1;
}

describe("NationAlliance: which requests an Impossible nation accepts", () => {
  test("a threat by troops (> 1.5x its troops) is accepted even when it hates us; exactly 1.5x is not", () => {
    for (const [extra, accepted] of [
      [0, false],
      [1, true],
    ] as const) {
      const w = world();
      // Hostile, as our attack would make it (pinned below), so only the
      // threat rule can say yes (NationAllianceBehavior.ts:155-161).
      w.nation.updateRelation(w.us, -100);
      expect(w.nation.relation(w.us)).toBe(Relation.Hostile);
      advanceTo(w, 100);
      startNation(w);
      w.us.setTroops(w.nation.troops() * 1.5 + extra);
      // Neither of the other two threat tests applies.
      expect(w.us.numTilesOwned()).toBe(w.nation.numTilesOwned());
      expect(w.config.maxTroops(w.us)).toBeLessThan(
        w.config.maxTroops(w.nation) * 1.5,
      );
      expect(answer(w, request(w)).accepted).toBe(accepted);
    }
  });

  test("a threat by cap: more troops and > 1.5x its cap (a City adds cityTroopIncrease to ours)", () => {
    for (const [city, extra, accepted] of [
      [false, 1, false],
      [true, 0, false],
      [true, 1, true],
    ] as const) {
      const w = world();
      w.nation.updateRelation(w.us, -100);
      advanceTo(w, 100);
      startNation(w);
      if (city) {
        const tile = w.game.ref(15, 10);
        w.us.addGold(w.game.unitInfo(UnitType.City).cost(w.game, w.us));
        const c = w.us.buildUnit(UnitType.City, tile, {});
        expect(c.isUnderConstruction()).toBe(false);
        expect(c.level()).toBe(1);
      }
      // Same tiles: the Impossible nation's cap is x1.25 ours
      // (Config.maxTroops, Config.ts:1024-1052); one City level adds
      // cityTroopIncrease() = 250,000 to ours.
      const capRatio = w.config.maxTroops(w.us) / w.config.maxTroops(w.nation);
      expect(capRatio).toBeCloseTo(city ? 2.15 : 0.8, 2);
      expect(capRatio > 1.5).toBe(city);
      w.us.setTroops(w.nation.troops() + extra);
      expect(answer(w, request(w)).accepted).toBe(accepted);
    }
  });

  test("a threat by tiles: more troops and > 1.5x its tiles; exactly 1.5x is not", () => {
    for (const [usTiles, extra, accepted] of [
      [300, 1, false],
      [301, 0, false],
      [301, 1, true],
    ] as const) {
      const w = world({ usTiles });
      w.nation.updateRelation(w.us, -100);
      advanceTo(w, 100);
      startNation(w);
      expect(w.us.numTilesOwned()).toBe(
        w.nation.numTilesOwned() * 1.5 + usTiles - 300,
      );
      expect(w.config.maxTroops(w.us)).toBeLessThan(
        w.config.maxTroops(w.nation) * 1.5,
      );
      w.us.setTroops(w.nation.troops() + extra);
      expect(answer(w, request(w)).accepted).toBe(accepted);
    }
  });

  test("REFUTES 'only threats after the early game': anyone 'similarly strong' is accepted while relation >= Neutral", () => {
    // isAlliancePartnerSimilarlyStrong (NationAllianceBehavior.ts:361-400),
    // Impossible: our troops + outgoing > its (troops + outgoing) x
    // nextInt(80, 90)/100 = 0.80-0.89, or our tiles > its tiles x 0.90-0.99
    // with our troops + outgoing > 0.5x its. Past tick 700, neutral.
    const cases: [number, number, boolean][] = [
      // [our tiles, our troops (nation 20,000), accepted]
      [150, 18_000, true], // 0.90x troops beats any draw
      [150, 16_000, false], // 0.80x troops never does
      [200, 10_001, true], // equal tiles and > 0.5x troops
      [200, 10_000, false], // equal tiles, exactly 0.5x
    ];
    for (const [usTiles, troops, accepted] of cases) {
      const w = world({ usTiles });
      advanceTo(w, 690);
      startNation(w);
      expect(w.nation.relation(w.us)).toBe(Relation.Neutral);
      w.us.setTroops(troops);
      const a = answer(w, request(w));
      expect(a.tick).toBeGreaterThanOrEqual(700);
      expect(a.accepted).toBe(accepted);
    }
  });

  test("the similarity test counts troops in flight; the threat test counts home troops only", () => {
    const cases: [number, boolean, boolean][] = [
      // [troops attacking free land, Hostile, accepted]; home is 5,000
      [0, false, false], // 0.25x: neither similar nor a threat
      [20_000, false, true], // 1.25x with the attack: similar
      [40_000, true, false], // 2.25x with the attack, but home < 1.5x
    ];
    for (const [inFlight, hostile, accepted] of cases) {
      const w = world({ usTiles: 150 });
      if (hostile) w.nation.updateRelation(w.us, -100);
      advanceTo(w, 690);
      startNation(w);
      w.us.setTroops(5_000 + inFlight);
      toEveOfDecision(w);
      // Both init at the end of the eve; at the decision tick the nation
      // runs before our attack's first tick, so the attack holds all of it.
      if (inFlight > 0) {
        send(w, { type: "attack", targetID: null, troops: inFlight });
      }
      send(w, { type: "allianceRequest", recipient: NATION_ID });
      tick(w);
      expect(w.us.troops()).toBe(5_000);
      expect(w.us.outgoingAttacks()).toHaveLength(inFlight > 0 ? 1 : 0);
      const req = pendingFromUs(w);
      const a = answer(w, req);
      expect(a.tick).toBe(req.createdAt() + 1);
      expect(a.accepted).toBe(accepted);
    }
  });

  test("relation gate: our attack makes it Hostile (-100) and it refuses a similarly strong request", () => {
    const w = world({ usTiles: 150 });
    advanceTo(w, 690);
    startNation(w);
    // A 1-troop attack: dies on its first tile, but init already cost us
    // 100 relation with it (AttackExecution.ts:190-209, Impossible -100).
    send(w, { type: "attack", targetID: NATION_ID, troops: 1 });
    tick(w);
    expect(relationValue(w.nation, w.us)).toBe(-100);
    tick(w, 5);
    expect(w.us.outgoingAttacks()).toHaveLength(0);
    w.nation.setTroops(20_000);
    w.us.setTroops(19_000); // similarly strong, not a threat
    expect(answer(w, request(w)).accepted).toBe(false);
  });

  test("its attack on us auto-embargoes it, costing -20 with it until we lift the embargo", () => {
    // AttackExecution.init: the target (us) embargoes the attacker
    // (AttackExecution.ts:113-122); at its next decision the nation takes
    // -20 for it, and gives it back once the embargo is gone
    // (updateRelationsFromEmbargos, NationExecution.ts:314-333, which runs
    // before handleAllianceRequests, :219-220).
    for (const lift of [false, true]) {
      const w = world({ usTiles: 150 });
      advanceTo(w, 690);
      startNation(w);
      w.game.addExecution(new AttackExecution(1, w.nation, AGENT_ID));
      tick(w);
      expect(w.us.hasEmbargoAgainst(w.nation)).toBe(true);
      throughNextDecision(w);
      expect(relationValue(w.nation, w.us)).toBe(-20);
      expect(w.nation.relation(w.us)).toBe(Relation.Distrustful);
      expect(w.nation.outgoingAttacks()).toHaveLength(0);
      if (lift) {
        send(w, { type: "embargo", targetID: NATION_ID, action: "stop" });
        tick(w, 2);
        expect(w.us.hasEmbargoAgainst(w.nation)).toBe(false);
      }
      w.nation.setTroops(20_000);
      w.us.setTroops(19_000);
      expect(answer(w, request(w)).accepted).toBe(lift);
      expect(relationValue(w.nation, w.us)).toBe(lift ? 0 : -20);
    }
  });

  test("checkAlreadyEnoughAlliances: no ally for its last non-allied neighbour, nor past 2-3 alliances when we are its only neighbour", () => {
    // NationAllianceBehavior.ts:305-337 (Impossible :313-332), reached only
    // by requests that are no threat and not Friendly (:169-172). Past tick
    // 700, similarly strong (19,000 against 20,000), neutral.
    interface Case {
      /** other0 takes one of our tiles next to the nation. */
      beside: boolean;
      /** The nation's allies among the others (0 is other0). */
      allies: number[];
      troops: number;
      accepted: boolean;
    }
    const cases: Case[] = [
      // Bordering [us, other0], other0 allied: 2 <= 1 + 1.
      { beside: true, allies: [0], troops: 19_000, accepted: false },
      // ... but a threat is decided before this rule.
      { beside: true, allies: [0], troops: 100_000, accepted: true },
      // Bordering [us, other0], none allied: 2 <= 0 + 1 is false.
      { beside: true, allies: [], troops: 19_000, accepted: true },
      // We are its only neighbour: alliances >= nextInt(2, 4) = 2 or 3.
      { beside: false, allies: [1], troops: 19_000, accepted: true },
      { beside: false, allies: [1, 2, 3], troops: 19_000, accepted: false },
    ];
    for (const c of cases) {
      const w = world({ usTiles: 150, others: 4 });
      if (c.beside) w.others[0].conquer(w.game.ref(10, 19));
      advanceTo(w, 690);
      startNation(w);
      for (const i of c.allies) {
        w.game.addExecution(
          new AllianceRequestExecution(w.nation, w.others[i].id()),
        );
        w.game.addExecution(
          new AllianceRequestExecution(w.others[i], NATION_ID),
        );
      }
      tick(w);
      expect(w.nation.alliances()).toHaveLength(c.allies.length);
      const neighbours = w.nation
        .nearby()
        .filter((p) => p.isPlayer() && p.type() !== PlayerType.Bot);
      expect(neighbours).toHaveLength(c.beside ? 2 : 1);
      advanceTo(w, 700);
      w.us.setTroops(c.troops);
      expect(answer(w, request(w)).accepted).toBe(c.accepted);
    }
  });

  test("requests created by tick numSpawnPhaseTurns() + 1 = 101 are refused, even from a threat", () => {
    // handleAllianceRequests (NationAllianceBehavior.ts:64-70). In
    // singleplayer numSpawnPhaseTurns() is 100 (Config.ts:856-864) however
    // early our spawn ended the spawn phase (SpawnExecution.ts:121-128).
    for (const [at, accepted] of [
      [101, false],
      [102, true],
    ] as const) {
      const w = world();
      expect(w.config.numSpawnPhaseTurns() + 1).toBe(101);
      w.nation.updateRelation(w.us, -100);
      advanceTo(w, 60);
      startNation(w);
      advanceTo(w, at);
      w.us.setTroops(100_000);
      const req = request(w);
      expect(req.createdAt()).toBe(at);
      expect(answer(w, req).accepted).toBe(accepted);
    }
  });

  test("hasTooManyAlliances: refused with >= 25% of the living non-bot players as allies, threat or not", () => {
    // NationAllianceBehavior.ts:181-200 (Impossible: alliances >= 0.25 x
    // players().filter(non-bot); players() is the living ones,
    // GameImpl.ts:691-693). Checked before the threat test (:134-138).
    // 7 others + us + the nation = 9 non-bot players, plus 2 tribes.
    const cases: [number, boolean, boolean][] = [
      // [our allies, one non-allied other dead, accepted]
      [2, false, true], // 2 < 0.25 x 9
      [3, false, false], // 3 >= 2.25
      [2, true, false], // 2 >= 0.25 x 8: the dead and the tribes don't count
    ];
    for (const [allies, dead, accepted] of cases) {
      const w = world({ others: 7, tribes: 2 });
      advanceTo(w, 100);
      startNation(w);
      for (let i = 0; i < allies; i++) allyUsWith(w, w.others[i]);
      if (dead) {
        const victim = w.others[6];
        for (const t of Array.from(victim.tiles())) victim.relinquish(t);
        expect(victim.isAlive()).toBe(false);
      }
      const nonBot = w.game
        .players()
        .filter((p) => p.type() !== PlayerType.Bot).length;
      expect(nonBot).toBe(dead ? 8 : 9);
      expect(w.us.alliances()).toHaveLength(allies);
      w.us.setTroops(100_000); // 5x its troops
      expect(answer(w, request(w)).accepted).toBe(accepted);
    }
  });
});

describe("NationAlliance: the random gates, over 100 seeds", () => {
  const SEEDS = 100;

  test("traitors are refused ~90% (nextInt(0, 100) >= 10); the rest fall through to the threat test", () => {
    let traitorAccepted = 0;
    let controlAccepted = 0;
    for (let i = 0; i < SEEDS; i++) {
      for (const traitor of [true, false]) {
        const w = world({ others: 1, gameID: `traitor-${i}` });
        w.us.setTroops(100_000);
        advanceTo(w, 99);
        if (traitor) {
          allyUsWith(w, w.others[0]);
          breakWith(w, w.others[0]);
          expect(w.us.isTraitor()).toBe(true);
          // We border the nation: -40 (BreakAllianceExecution.ts:48-56).
          expect(relationValue(w.nation, w.us)).toBe(-40);
        }
        advanceTo(w, 102);
        const a = answer(w, requestThenStart(w));
        expect(w.us.isTraitor()).toBe(traitor);
        if (a.accepted) {
          if (traitor) traitorAccepted++;
          else controlAccepted++;
        }
      }
    }
    // A threat is always accepted; as a traitor 12 of 100 got through here.
    expect(controlAccepted).toBe(SEEDS);
    expect(traitorAccepted).toBeGreaterThanOrEqual(3);
    expect(traitorAccepted).toBeLessThanOrEqual(20);
  });

  test("a Friendly relation (>= 50) gets a weak requester in ~67% of the time (nextInt(0, 100) >= 33)", () => {
    // isAlliancePartnerFriendly (NationAllianceBehavior.ts:339-358, :162-168).
    // +100 comes from allying through the counter-request path
    // (AllianceRequestExecution.ts:54-56), +50 from a big enough troop
    // donation (DonateTroopExecution.ts:73); set here directly.
    let accepted = 0;
    for (let i = 0; i < SEEDS; i++) {
      const w = world({ usTiles: 150, gameID: `friendly-${i}` });
      w.us.setTroops(8_000);
      w.nation.updateRelation(w.us, 60);
      expect(w.nation.relation(w.us)).toBe(Relation.Friendly);
      advanceTo(w, 700);
      if (answer(w, requestThenStart(w)).accepted) accepted++;
    }
    // 71 of 100 here.
    expect(accepted).toBeGreaterThanOrEqual(52);
    expect(accepted).toBeLessThanOrEqual(80);
  });

  test("early game: before tick 600 + numSpawnPhaseTurns() = 700 ~30% of plain requests pass; after, none", () => {
    // A weak requester (0.4x troops, 0.75x tiles), neutral: not a threat,
    // not similar; only isEarlygame (NationAllianceBehavior.ts:218-249,
    // Impossible ticks < 600 + spawnTicks && nextInt(0, 100) >= 70) can
    // say yes.
    const earlyEnd = 600 + world().config.numSpawnPhaseTurns();
    expect(earlyEnd).toBe(700);
    let early = 0;
    let late = 0;
    for (let i = 0; i < SEEDS; i++) {
      for (const at of [102, earlyEnd]) {
        const w = world({ usTiles: 150, gameID: `early-${i}` });
        w.us.setTroops(8_000);
        advanceTo(w, at);
        const a = answer(w, requestThenStart(w));
        if (at < earlyEnd) expect(a.tick).toBeLessThan(earlyEnd);
        if (a.accepted) {
          if (at < earlyEnd) early++;
          else late++;
        }
      }
    }
    // 30 of 100 here.
    expect(late).toBe(0);
    expect(early).toBeGreaterThanOrEqual(18);
    expect(early).toBeLessThanOrEqual(42);
  });
});

describe("NationAlliance: duration", () => {
  /**
   * Allied with the nation as a threat. `others` inert non-bot players set
   * the 25% alliance limit (hasTooManyAlliances), which an extension must
   * pass with this alliance already counted.
   */
  function allied(others = 3): { w: World; at: number } {
    const w = world({ others });
    advanceTo(w, 100);
    startNation(w);
    w.us.setTroops(100_000);
    const a = answer(w, request(w));
    expect(a.accepted).toBe(true);
    return { w, at: a.tick };
  }

  test("an alliance lasts allianceDuration() = 3000 ticks (5 min) from acceptance, then lapses at no cost", () => {
    const { w, at } = allied();
    const alliance = w.us.allianceWith(w.nation)!;
    expect(alliance.createdAt()).toBe(at);
    expect(w.config.allianceDuration()).toBe(3000);
    expect(alliance.expiresAt()).toBe(at + w.config.allianceDuration());
    // Expiry is checked in PlayerExecution.tick (PlayerExecution.ts:105-109);
    // every spawned player has one (SpawnExecution.ts:112-113).
    w.game.addExecution(new PlayerExecution(w.us));
    const relation = relationValue(w.nation, w.us);
    advanceTo(w, alliance.expiresAt());
    expect(w.us.isAlliedWith(w.nation)).toBe(true);
    tick(w);
    expect(w.us.isAlliedWith(w.nation)).toBe(false);
    // No cost (GameImpl.expireAlliance, GameImpl.ts:910-930): no traitor,
    // no relation change, no embargo, no request cooldown.
    expect(w.us.isTraitor()).toBe(false);
    expect(w.nation.isTraitor()).toBe(false);
    expect(w.us.betrayals()).toBe(0);
    expect(relationValue(w.nation, w.us)).toBe(relation);
    expect(w.nation.hasEmbargoAgainst(w.us)).toBe(false);
    expect(w.us.hasEmbargoAgainst(w.nation)).toBe(false);
    expect(w.us.canSendAllianceRequest(w.nation)).toBe(true);
    // And it can be attacked again.
    send(w, { type: "attack", targetID: NATION_ID, troops: 1000 });
    tick(w);
    expect(w.us.outgoingAttacks()).toHaveLength(1);
  });

  test("allianceExtension works any time; it agrees at its next decision if it would accept us now, and 5 min restart from then", () => {
    const { w, at } = allied();
    const alliance = w.us.allianceWith(w.nation)!;
    const expires = alliance.expiresAt();
    // No timing check in AllianceExtensionExecution.init
    // (AllianceExtensionExecution.ts:23-87): ask right after the handshake,
    // far outside the UI's last-30-s prompt (allianceExtensionPromptOffset).
    send(w, { type: "allianceExtension", recipient: NATION_ID });
    tick(w);
    expect(alliance.agreedToExtend(w.us)).toBe(true);
    const decided = throughNextDecision(w);
    expect(decided - at).toBeLessThanOrEqual(w.n.attackRate + 1);
    expect(decided).toBeLessThan(
      expires - w.config.allianceExtensionPromptOffset(),
    );
    // handleAllianceExtensionRequests (NationAllianceBehavior.ts:79-94)
    // adds its own extension, which extends from now (AllianceImpl.ts:88-92):
    // the time left is replaced, not added to.
    expect(alliance.expiresAt()).toBe(decided + w.config.allianceDuration());
    expect(alliance.onlyOneAgreedToExtend()).toBe(false);
  });

  test("a refused extension stays asked and is re-decided at every decision", () => {
    const { w } = allied();
    const alliance = w.us.allianceWith(w.nation)!;
    const expires = alliance.expiresAt();
    w.us.setTroops(5_000);
    w.nation.updateRelation(w.us, -100);
    send(w, { type: "allianceExtension", recipient: NATION_ID });
    tick(w);
    throughNextDecision(w);
    throughNextDecision(w);
    expect(alliance.expiresAt()).toBe(expires);
    expect(alliance.agreedToExtend(w.us)).toBe(true);
    expect(alliance.agreedToExtend(w.nation)).toBe(false);
    w.us.setTroops(100_000);
    const decided = throughNextDecision(w);
    expect(alliance.expiresAt()).toBe(decided + w.config.allianceDuration());
  });

  test("the alliance being extended counts toward the 25% limit: with us and it the only non-bot players it never extends", () => {
    // getAllianceDecision (NationAllianceBehavior.ts:88) runs
    // hasTooManyAlliances (:136) with our alliances, this one included:
    // 1 >= 0.25 x 2.
    const { w } = allied(0);
    const alliance = w.us.allianceWith(w.nation)!;
    const expires = alliance.expiresAt();
    send(w, { type: "allianceExtension", recipient: NATION_ID });
    tick(w);
    for (let i = 0; i < 5; i++) throughNextDecision(w);
    expect(w.us.troops()).toBeGreaterThan(w.nation.troops() * 1.5);
    expect(alliance.expiresAt()).toBe(expires);
    expect(alliance.agreedToExtend(w.nation)).toBe(false);
  });
});

describe("NationAlliance: what allies can and cannot do to each other", () => {
  function allied(): World {
    const w = world();
    advanceTo(w, 100);
    startNation(w);
    w.us.setTroops(100_000);
    expect(answer(w, request(w)).accepted).toBe(true);
    return w;
  }

  test("no land attack either way: dropped at init, nothing paid", () => {
    const w = allied();
    const ours = w.us.troops();
    const theirs = w.nation.troops();
    send(w, { type: "attack", targetID: NATION_ID, troops: 5000 });
    // As AiAttackBehavior.sendLandAttack builds one (AiAttackBehavior.ts:
    // 1107-1113).
    w.game.addExecution(new AttackExecution(5000, w.nation, AGENT_ID));
    tick(w);
    // AttackExecution.init's alliance check (AttackExecution.ts:101-111).
    expect(w.us.outgoingAttacks()).toHaveLength(0);
    expect(w.nation.outgoingAttacks()).toHaveLength(0);
    expect(w.us.troops()).toBe(ours);
    expect(w.nation.troops()).toBe(theirs);
  });

  test("an attack under way retreats in full, either way, the tick the alliance forms", () => {
    for (const attacker of ["us", "nation"] as const) {
      const w = world();
      advanceTo(w, 100);
      startNation(w);
      w.us.setTroops(100_000);
      if (attacker === "us") {
        send(w, { type: "attack", targetID: NATION_ID, troops: 10_000 });
      } else {
        w.game.addExecution(new AttackExecution(5_000, w.nation, AGENT_ID));
      }
      tick(w, 4);
      const [a, owner] =
        attacker === "us" ? [w.us, w.us] : [w.nation, w.nation];
      const attack = a.outgoingAttacks()[0];
      expect(attack.isActive()).toBe(true);
      const req = request(w);
      let home = owner.troops();
      let stack = attack.troops();
      while (req.status() === "pending") {
        home = owner.troops();
        stack = attack.troops();
        tick(w);
      }
      // Accepted as a threat although it is Hostile (our attack) or
      // Distrustful (its attack, the embargo malus) toward us.
      expect(req.status()).toBe("accepted");
      expect(w.nation.relation(w.us)).toBe(
        attacker === "us" ? Relation.Hostile : Relation.Distrustful,
      );
      // AttackExecution.tick sees the new alliance and retreats with no
      // malus (AttackExecution.ts:285-288, retreat :224-250).
      expect(attack.isActive()).toBe(false);
      expect(a.outgoingAttacks()).toHaveLength(0);
      // addTroops floors (PlayerImpl.ts:1369-1375, Util.toInt).
      expect(owner.troops()).toBe(home + Math.floor(stack));
    }
  });

  test("no boat at an ally; a boat already at sea lands, takes the landing tile, and its troops come home", async () => {
    // ocean_and_land: land at x 0-7 and an island at x 14-15, y 6-8. We
    // hold the island and mainland row 0, the nation mainland rows 1-15.
    const mk = async () => {
      const game = await setup(
        "ocean_and_land",
        GAME_CONFIG,
        [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
        undefined,
        Config,
      );
      const nation = game.addPlayer(
        new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
      );
      const us = game.player(AGENT_ID);
      fill(game, us, 14, 16, 6, 9);
      fill(game, us, 0, 8, 0, 1);
      fill(game, nation, 0, 8, 1, 16);
      us.setTroops(100_000);
      nation.setTroops(5_000);
      const w = {
        game,
        us,
        nation,
        executor: new Executor(game, "g", undefined),
      };
      while (nation.isImmune()) tick(w);
      return w;
    };

    const a = await mk();
    allyUsWith(a, a.nation);
    send(a, { type: "boat", troops: 4000, dst: a.game.ref(7, 8) });
    tick(a);
    // TransportShipExecution.init (TransportShipExecution.ts:109-112).
    expect(a.us.units(UnitType.TransportShip)).toHaveLength(0);
    expect(a.us.troops()).toBe(100_000);

    const b = await mk();
    send(b, { type: "boat", troops: 4000, dst: b.game.ref(7, 8) });
    tick(b);
    const [boat] = b.us.units(UnitType.TransportShip);
    expect(boat).toBeDefined();
    const dst = boat.targetTile()!;
    expect(b.game.owner(dst)).toBe(b.nation);
    expect(b.us.troops()).toBe(96_000);
    allyUsWith(b, b.nation);
    expect(boat.isActive()).toBe(true);
    const nationTiles = b.nation.numTilesOwned();
    for (let i = 0; i < 100 && boat.isActive(); i++) tick(b);
    expect(boat.isActive()).toBe(false);
    // TransportShipExecution.ts:270-275: conquer the landing tile, then, the
    // target being friendly, add the boat's troops instead of attacking.
    expect(b.game.owner(dst)).toBe(b.us);
    expect(b.nation.numTilesOwned()).toBe(nationTiles - 1);
    expect(b.us.troops()).toBe(100_000);
    expect(b.us.outgoingAttacks()).toHaveLength(0);
    expect(b.us.isAlliedWith(b.nation)).toBe(true);
  });

  test("nukes: allowed on an ally; the launch breaks the alliance (we turn traitor) iff > 100 weighted tiles or any of its structures are in range", () => {
    // us x 0-59, the nation x 60-99. PlayerImpl.nukeSpawn only refuses
    // teammates (PlayerImpl.ts:1625-1645). At launch, maybeBreakAlliances
    // (NukeExecution.ts:148-197, called :232-234) breaks with every player
    // listNukeBreakAlliance (Util.ts:100-129) names: weighted tiles (1 inside
    // `inner`, 0.5 out to `outer`) > nukeAllianceBreakThreshold() = 100, or a
    // structure within `outer`.
    const run = (x: number, structure: boolean) => {
      const b = base(100, 40, "nukes");
      const w = { ...b };
      fill(b.game, b.us, 0, 60, 0, 40);
      fill(b.game, b.nation, 60, 100, 0, 40);
      b.us.setTroops(100_000);
      b.nation.setTroops(100_000);
      b.us.buildUnit(UnitType.MissileSilo, b.game.ref(2, 2), {});
      if (structure) {
        b.nation.buildUnit(UnitType.DefensePost, b.game.ref(61, 20), {});
      }
      b.us.addGold(10_000_000n);
      advanceTo(w, b.config.spawnImmunityDuration());
      allyUsWith(w, b.nation);
      const before = relationValue(b.nation, b.us);
      const target: TileRef = b.game.ref(x, 20);
      const magnitude = b.config.nukeMagnitudes(UnitType.AtomBomb);
      const weight =
        computeNukeBlastCounts({
          gm: b.game,
          targetTile: target,
          magnitude,
        }).get(b.nation.smallID()) ?? 0;
      send(w, { type: "build_unit", unit: UnitType.AtomBomb, tile: target });
      for (
        let i = 0;
        i < 5 && b.us.units(UnitType.AtomBomb).length === 0;
        i++
      ) {
        tick(w);
      }
      expect(b.us.units(UnitType.AtomBomb)).toHaveLength(1);
      return {
        b,
        weight,
        broken: !b.us.isAlliedWith(b.nation),
        delta: relationValue(b.nation, b.us) - before,
      };
    };
    const threshold = base(10, 10, "t").config.nukeAllianceBreakThreshold();
    expect(threshold).toBe(100);

    const heavy = run(80, false);
    expect(heavy.weight).toBeGreaterThan(threshold);
    expect(heavy.broken).toBe(true);
    expect(heavy.b.us.isTraitor()).toBe(true);
    expect(heavy.delta).toBe(-100);

    const light = run(32, false);
    expect(light.weight).toBeGreaterThan(0);
    expect(light.weight).toBeLessThanOrEqual(threshold);
    expect(light.broken).toBe(false);
    expect(light.b.us.isTraitor()).toBe(false);
    // It still lands on the ally, allied all the way.
    const tilesBefore = light.b.nation.numTilesOwned();
    for (
      let i = 0;
      i < 300 && light.b.us.units(UnitType.AtomBomb).length;
      i++
    ) {
      tick(light.b);
    }
    expect(light.b.us.units(UnitType.AtomBomb)).toHaveLength(0);
    expect(light.b.nation.numTilesOwned()).toBeLessThan(tilesBefore);
    expect(light.b.us.isAlliedWith(light.b.nation)).toBe(true);

    const post = run(32, true);
    expect(post.weight).toBeLessThanOrEqual(threshold);
    expect(post.broken).toBe(true);
    expect(post.b.us.isTraitor()).toBe(true);
  });
});

describe("NationAlliance: breaking an alliance", () => {
  test("the breaker is a traitor for traitorDuration() = 300 ticks; -100 from the betrayed, -40 from every neighbour", () => {
    // us x 10-29: the nation (x 0-9) and other0 (x 30-31) border us,
    // other1 (x 32-33) does not.
    for (const betrayed of [1, 0]) {
      const w = world({ usTiles: 400, others: 2 });
      advanceTo(w, 100);
      allyUsWith(w, w.others[betrayed]);
      const players = [w.nation, w.others[0], w.others[1]];
      const before = players.map((p) => relationValue(p, w.us));
      const at = breakWith(w, w.others[betrayed]);
      const delta = players.map((p, i) => relationValue(p, w.us) - before[i]);
      // GameImpl.breakAlliance marks the breaker (GameImpl.ts:886-888);
      // BreakAllianceExecution.ts:46 gives the betrayed -100 and :48-56
      // every player in our nearby() -40 (FFA: no teams, so none is spared,
      // the betrayed included; relations clamp at +-100, PlayerImpl.ts:
      // 969-976). The counter-request path had put the betrayed at +100
      // (AllianceRequestExecution.ts:54-56).
      expect(before).toEqual(betrayed === 1 ? [0, 0, 100] : [0, 100, 0]);
      expect(delta).toEqual(betrayed === 1 ? [-40, -40, -100] : [-40, -140, 0]);
      expect(w.us.betrayals()).toBe(1);
      expect(w.config.traitorDuration()).toBe(300);
      advanceTo(w, at + w.config.traitorDuration() - 1);
      expect(w.us.isTraitor()).toBe(true);
      tick(w);
      expect(w.us.isTraitor()).toBe(false);
    }
  });

  test("breaking with a traitor costs no traitor mark (the relations still drop)", () => {
    const w = world({ usTiles: 400, others: 2 });
    advanceTo(w, 100);
    allyUsWith(w, w.others[0]);
    // other0 betrays other1 first.
    w.game.addExecution(
      new AllianceRequestExecution(w.others[0], w.others[1].id()),
    );
    w.game.addExecution(
      new AllianceRequestExecution(w.others[1], w.others[0].id()),
    );
    tick(w);
    w.game.addExecution(
      new BreakAllianceExecution(w.others[0], w.others[1].id()),
    );
    tick(w, 2);
    expect(w.others[0].isTraitor()).toBe(true);
    breakWith(w, w.others[0]);
    // GameImpl.breakAlliance: markTraitor only if the other is no traitor
    // (GameImpl.ts:887).
    expect(w.us.isTraitor()).toBe(false);
    expect(w.us.betrayals()).toBe(0);
    expect(relationValue(w.nation, w.us)).toBe(-40);
  });

  test("attacking a traitor: attackLogic halves the attacker's losses and takes 0.8x the time per tile", () => {
    const config = world().config;
    expect(config.traitorDefenseDebuff()).toBe(0.5);
    expect(config.traitorSpeedDebuff()).toBe(0.8);
    for (const ratio of [0.3, 1, 3]) {
      for (const terrain of [TerrainType.Plains, TerrainType.Mountain]) {
        const input = (isTraitor: boolean) => ({
          terrain,
          attackTroops: 50_000,
          attacker: { type: PlayerType.Nation, numTiles: 2000 },
          defender: {
            type: PlayerType.Human,
            numTiles: 1500,
            troops: 50_000 * ratio,
            isTraitor,
            isDisconnectedTeammate: false,
          },
          defenderHasDefensePost: false,
          falloutRatio: null,
          borderSize: 40,
        });
        const t = config.attackLogic(input(true));
        const n = config.attackLogic(input(false));
        expect(t.attackerTroopLoss / n.attackerTroopLoss).toBeCloseTo(0.5, 12);
        expect(t.tickFraction / n.tickFraction).toBeCloseTo(0.8, 12);
        expect(t.defenderTroopLoss).toBe(n.defenderTroopLoss);
      }
    }
  });

  test("live twin: the same nation attack on us takes more tiles and loses fewer troops while we are the traitor", () => {
    const run = (weBreak: boolean) => {
      const w = world({ usTiles: 400, others: 1 });
      advanceTo(w, 100);
      allyUsWith(w, w.others[0]);
      if (weBreak) breakWith(w, w.others[0]);
      else {
        w.game.addExecution(new BreakAllianceExecution(w.others[0], AGENT_ID));
        tick(w, 2);
      }
      expect(w.us.isTraitor()).toBe(weBreak);
      w.us.setTroops(50_000);
      w.nation.setTroops(60_000);
      w.game.addExecution(new AttackExecution(40_000, w.nation, AGENT_ID));
      tick(w);
      const attack = w.nation.outgoingAttacks()[0];
      const tiles0 = w.nation.numTilesOwned();
      tick(w, 5);
      return {
        tiles: w.nation.numTilesOwned() - tiles0,
        lost: 40_000 - attack.troops(),
      };
    };
    const traitor = run(true);
    const honest = run(false);
    // AttackExecution passes isTraitor: defender.isTraitor()
    // (AttackExecution.ts:377) into attackLogic (Config.ts:933-968). Here
    // 62 tiles for 2,820 troops against 48 tiles for 4,547.
    expect(traitor.tiles / honest.tiles).toBeGreaterThan(1.15);
    expect(traitor.tiles / honest.tiles).toBeLessThan(1.4);
    const perTile = (r: { tiles: number; lost: number }) => r.lost / r.tiles;
    expect(perTile(traitor) / perTile(honest)).toBeGreaterThan(0.4);
    expect(perTile(traitor) / perTile(honest)).toBeLessThan(0.6);
  });

  test("an Impossible ally betrays a traitor with < 1.2x its troops at its next decision, and attacks it at once", () => {
    // maybeAttack -> attackBestTarget (above reserve and trigger) -> the
    // Impossible strategy list [retaliate, bots, veryWeak, betray, ...]
    // (AiAttackBehavior.ts:428) -> maybeBetrayAndAttack (:583-608) ->
    // maybeBetray's traitor rule (NationAllianceBehavior.ts:440-448), then
    // sendAttack(friend, true) (:604).
    for (const [ratio, betrayed] of [
      [0.6, true],
      [1.25, false],
    ] as const) {
      const w = world({ others: 1 });
      advanceTo(w, 100);
      startNation(w);
      w.us.setTroops(100_000);
      expect(answer(w, request(w)).accepted).toBe(true);
      allyUsWith(w, w.others[0]);
      // Above its reserve and trigger (AiAttackBehavior.ts:289-293).
      const nationTroops = Math.ceil(0.9 * w.config.maxTroops(w.nation));
      expect(w.n.triggerRatio).toBeLessThan(0.9);
      expect(w.n.reserveRatio).toBeLessThan(w.n.triggerRatio);
      w.nation.setTroops(nationTroops);
      w.us.setTroops(Math.floor(ratio * nationTroops));
      breakWith(w, w.others[0]);
      expect(w.us.isTraitor()).toBe(true);
      expect(w.us.isAlliedWith(w.nation)).toBe(true);
      throughNextDecision(w);
      expect(w.us.isAlliedWith(w.nation)).toBe(!betrayed);
      // Betraying a traitor makes no traitor (GameImpl.ts:887).
      expect(w.nation.isTraitor()).toBe(false);
      const onUs = w.nation
        .outgoingAttacks()
        .filter((a) => a.target() === w.us);
      expect(onUs).toHaveLength(betrayed ? 1 : 0);
    }
  });
});
