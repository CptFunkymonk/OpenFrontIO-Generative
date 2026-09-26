/**
 * Pins roadmap H9's boat rules and the goal's win condition
 * (docs/11-roadmap.md §11.3; the risk table asks for every mechanic an agent
 * relies on to be pinned here).
 *
 * The claim under test ("BoatsAndWin"): transport ships are free, at most 3
 * at a time per player, with no cooldown, and take their landing tile
 * without combat; a nation's boat attack sends troops/5; the win condition
 * is holding > 80% of non-fallout land (WinCheckExecution) in FFA. Also:
 * where a ship's troops come from, what landing on free land or on a player
 * does, how fast a ship sails, and whether the arena's landShare
 * (src/agent/lib/Perception.ts:58-61) is exactly WinCheckExecution's test.
 *
 * The rules (the code is the spec):
 * - Intent to execution. BoatAttackIntentSchema (src/core/Schemas.ts:652-657)
 *   requires `troops: zb.float({ min: 0 })`, not nullable, and `dst`;
 *   Executor.createExec passes both straight to
 *   new TransportShipExecution(player, dst, troops)
 *   (src/core/execution/ExecutionManager.ts:87-88). cancel_boat becomes a
 *   BoatRetreatExecution (:74-75), which only sets isRetreating.
 * - TransportShipExecution.init (src/core/execution/TransportShipExecution.ts):
 *     :75       the target is the owner of the clicked tile, fixed at launch;
 *     :79-92    refused (nothing built, nothing paid) once the player has
 *               unitCount(TransportShip) >= config.boatMaxNumber(), which is 3
 *               (src/core/configuration/Config.ts:850-855); there is no timer
 *               anywhere in the check, so the cap is the only limit;
 *     :94-102   at launch, between two non-bots, the target's pending
 *               alliance request to us is rejected
 *               (rejectIncomingAllianceRequests :339-346);
 *     :109-112  refused if a Human cannot attack the target player (spawn
 *               immunity, PlayerImpl.canAttackPlayer, PlayerImpl.ts:1917-1926);
 *     :114-117  troops ??= config.boatAttackAmount(), then
 *               min(troops, attacker.troops()). The ??= only fires for
 *               null/undefined, which the schema never lets through, so
 *               boatAttackAmount (floor(troops / 5), Config.ts:975-977) is
 *               dead code for intents, and nations pass their own number;
 *     :119      landing tile = targetTransportTile: the target's shore tile
 *               nearest the click, within Manhattan 50, on water our shore
 *               touches (TransportShipUtils.ts:33-42, SpatialQuery.ts:126-155);
 *     :129-145  launch tile = canBuild(TransportShip), and buildUnit, which
 *               charges unitInfo(TransportShip).cost = 0n gold (Config.ts:
 *               572-575) and removeTroops(troops) (PlayerImpl.ts:1403-1416),
 *               floored by toInt (PlayerImpl.ts:1376-1383, Util.ts:401-409),
 *               while the unit keeps the unfloored number (UnitImpl.ts:90).
 * - TransportShipExecution.tick:
 *     :38, :246-295  ticksPerMove = 1: one step of the water path per tick
 *               (PathFinderStepper.next, src/core/pathfinding/
 *               PathFinderStepper.ts:37-103). The path is found on the half-
 *               size minimap and upscaled (transformers/MiniMapTransformer.ts:
 *               65-100). The chain (PathFinder.ts:47-66): with fewer than 100
 *               water-graph nodes (the small strait here), a 4-neighbour A*
 *               (algorithms/AStar.Water.ts); on real maps, HPA, then
 *               SmoothingWaterTransformer, whose tracePath inserts a
 *               staircase tile on every diagonal step (:296-333), so the
 *               route is 4-connected either way;
 *     :223-244  retreating (cancel_boat, or a landing tile turned to water,
 *               :215-221): the ship re-targets our shore tile nearest its
 *               position (bestTransportShipSpawn, PlayerImpl.ts:1961-1963);
 *     :248-270  arrival on a tile we already own (that retreat, or our land
 *               attack got to the landing tile first): 25% die
 *               (malusForRetreat, :32), the rest come home, no attack;
 *     :271      otherwise conquer(dst), unconditionally: no attackLogic, no
 *               troop loss on either side, WHOEVER holds the tile now (an
 *               ally or a third party included: nothing checks the owner);
 *     :272-274  if the ORIGINAL target is a player friendly by now (allied
 *               mid-voyage), the troops come home in full, the tile already
 *               taken; a free-land boat's target is terra nullius, so it
 *               never takes this branch;
 *     :275-285  else new AttackExecution(boat troops, attacker, target,
 *               sourceTile = dst, removeTroops = false). Its init
 *               (AttackExecution.ts:75-211) embargoes us and rejects the
 *               target's alliance requests (:113-122) and applies -100
 *               relation at Impossible (:190-210), for a player target, even
 *               with 0 troops; seeds the frontier from dst only (:148-152);
 *               and NETS 1:1 against every attack the target has on us
 *               (:157-170): the smaller side is deleted, the larger loses
 *               that many troops. A later attack by the target nets against
 *               the beachhead attack the same way (the same loop in its own
 *               init), and a deleted attack refunds nothing (its next tick
 *               sees !isActive, :280-283). Boat attacks never merge with our
 *               own attacks (:171-181); a later land attack of ours absorbs
 *               one (sibling AttackMerge.test.ts). Its tick fights with the
 *               real attackLogic, deletes a stack below 1 troop (:296-300),
 *               and when nothing is left to take refunds the rest in full
 *               (:302-306, retreat :224-256).
 * - A nation's boat, AiAttackBehavior (src/core/execution/utils/
 *   AiAttackBehavior.ts), three paths:
 *   - sendAttack (:822-840) boats a player it does not border via
 *     sendBoatAttack (:1117-1147): calculateAttackTroops (:1041-1096) with
 *     troops()/5 (:1135-1138), unfloored, min troopSendCap (:1071-1074),
 *     refused below 20% of the target (isAttackTooWeak :961-973); but a
 *     TRIBE target goes to calculateBotAttackTroops (:1057-1064,
 *     :1149-1165): 4 x the tribe's troops, bounded by troops - reserveRatio x
 *     maxTroops - botAttackTroopsSent (:1054, :1062-1065), or nothing if
 *     that budget is under 2 x the tribe. botAttackTroopsSent grows with
 *     every tribe attack (:1091-1093) and is reset only by attackBots when a
 *     tribe is nearby (:494-498), so a nation with no tribe nearby spends
 *     that budget once and then never boats a tribe this way again.
 *     sendAttack reaches an island tribe through the island strategy
 *     (:400-408, second to last in Impossible's order, :428); attackBots
 *     (:484-520) sees only nearby() players (land, or water at most 4 tiles
 *     wide, PlayerImpl.ts:626-660).
 *   - The random boat: maybeAttack (:98-157), with no bordering enemy,
 *     calls attackWithRandomBoat 1 time in 5 (:143-146), before
 *     attackBestTarget; its first search prefers unowned or TRIBE tiles
 *     (:182-190, :253-255) and it sends min(troops()/5, cap) (:192-196),
 *     a tribe included.
 *   - Free land it cannot walk to: sendBoatAttackToNearbyTerraNullius
 *     (:879-930), unowned land exactly 5 tiles out across water from every
 *     10th shore tile, with min(troops/5, troopSendCapForExpansion)
 *     (:917-920, :1035-1039).
 * - WinCheckExecution (src/core/execution/WinCheckExecution.ts): inactive in
 *   the spawn phase (:198-200); acts only when ticks % 10 === 0 (:38-40); in
 *   FFA sorts players() (alive only, GameImpl.ts:691-693) by tiles and judges
 *   only the leader, whatever its type (:87-114). hasWon (:118-142): the
 *   lobby timer (maxTimerValue) or 170 minutes (:29, :130) of
 *   elapsedGameSeconds, counted from the spawn phase's end (GameImpl.ts:
 *   966-983), end the game for the leader at any share; else
 *   tilesOwned * 100 > (numLandTiles - numTilesWithFallout) *
 *   percentageTilesOwnedToWin, which is 80 (Config.ts:255, :827-846) unless
 *   overtime is enabled (off by default, Config.ts:262-266, :325-334).
 *   The arena sets no timer and no overtime (ArenaGame.ts arenaGameStart,
 *   :185-212), nor does browser solo by default (client/SinglePlayerModal.ts
 *   :104, :120). The ARENA itself stops at --max-minutes, default 60
 *   (Arena.ts:401; makeSpecs :626, maxTicks = minutes x 600, absolute ticks
 *   with the spawn phase), and records "timeout" with no winner
 *   (ArenaGame.ts:363, :373; AgentHost.timeout, AgentHost.ts:158-160).
 *   numLandTiles is the manifest's num_land_tiles (TerrainMapLoader.ts:
 *   248-264), which the generator counts without impassable tiles
 *   (map-generator/map_generator.go:643-685); water nukes lower it
 *   (GameMap.ts:272-278, off unless waterNukes). Fallout sits only on
 *   unowned land (GameImpl.setFallout throws on owned tiles, :268-278) and
 *   conquering a tile clears it (GameImpl.conquer :799-821).
 *
 * VERDICT: PARTIAL. Every boat and win rule holds as stated; "a nation's
 * boat attack sends troops/5" holds against players and free land, and
 * against a tribe only on the random-boat path: sendAttack (the island
 * strategy) sends 4 x the tribe's troops, until its never-reset bot budget
 * runs dry. Refinements an agent needs:
 * - "Free": 0 gold; the troops aboard leave home at launch (floored: a
 *   fractional intent carries the fraction, under 1 troop, for free). A
 *   refused boat (4th at sea) costs nothing. Not free diplomatically: a
 *   launch at a nation rejects its pending alliance request, and a landing
 *   on it, even with 0 troops, embargoes us and costs -100 relation
 *   (Neutral to Hostile).
 * - "3 at a time, no cooldown": the three can leave in one tick, and the tick
 *   one lands a new one may sail.
 * - Troops: exactly the intent's number, clamped to home troops; 0 is legal,
 *   and a 0-troop boat still takes its landing tile from free land or from a
 *   player (whose troops are untouched).
 * - "Without combat": the landing tile never goes through attackLogic. The
 *   boat's troops then fight from that one tile, unless the target has an
 *   attack on us: then they cancel against it 1:1 at landing, and any later
 *   attack of the target (an Impossible nation retaliates first) deletes
 *   the beachhead attack 1:1, no refund. Traps: landing on our own tile
 *   (our land attack got there first, or cancel_boat) kills 25% and attacks
 *   nothing; a player allied mid-voyage still loses the tile; a free-land
 *   boat takes its landing tile from whoever holds it, an ally included.
 * - Speed: one tile per tick on a 4-connected route, landing one tick after
 *   reaching the shore, so ETA = route length + 1 ticks and a diagonal
 *   crossing costs its Manhattan length (on the world test map 442 steps
 *   for a Manhattan distance of 438 and a straight line of 389). Routes are
 *   planned on the 2x minimap: an odd row costs ~3 extra steps.
 * - A ship leaves from our shore tile nearest the landing by water, a
 *   beachhead included (SpatialQuery.closestShoreByWater, :187-221), so a
 *   second boat to the same coast hops along it instead of recrossing.
 * - Win: strictly more than 80%, judged once per 10 ticks; the leader of ANY
 *   type wins FFA, a tribe included. The 170-minute rule (leader wins at any
 *   share) is for the browser; in the arena the game stops at the cap (60
 *   minutes by default) as a winnerless "timeout", and even
 *   --max-minutes 170 stops before the rule fires. Impassable tiles are
 *   never land. landShare > 0.8 is exactly the win test on every real map.
 * It refutes nothing in docs/02 §2.6 or docs/07 §7.7; it sharpens §2.6's
 * "1 tile/tick" (4-connected, so Manhattan) and adds the 0-troop landing.
 *
 * Setting: the arena's own game config (arenaGameStart, src/agent/arena/
 * ArenaGame.ts) with the real Config class built as createGameRunner builds
 * it (src/core/GameRunner.ts:46: new Config(config, null, false)); FFA,
 * Singleplayer, Impossible, Normal size. Maps are synthesized in memory like
 * the generator's (bit 7 land, bit 6 shoreline, bit 5 ocean; a half-size
 * minimap where any water in a 2x2 block wins), plus the real world test map
 * for one route and a real resources map for the land count. RecordingConfig
 * only logs attackLogic and boatAttackAmount calls and returns the real
 * results. The agent's boats go through IntentSchema (AgentHost.isValid,
 * src/agent/AgentHost.ts:197-208) and Executor.createExec, the path of
 * ctx.send; nation boats come from a real AiAttackBehavior. No
 * PlayerExecution or NationExecution runs, so nobody's troops grow and no
 * one acts on their own; where a nation attacks, the test adds the
 * execution (tests may mutate; agents never may).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { makeSpecs, parseArgs } from "../../../src/agent/arena/Arena";
import { arenaGameStart } from "../../../src/agent/arena/ArenaGame";
import { landShare } from "../../../src/agent/lib/Perception";
import {
  AttackLogicInput,
  AttackLogicResult,
  Config,
} from "../../../src/core/configuration/Config";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { NationAllianceBehavior } from "../../../src/core/execution/nation/NationAllianceBehavior";
import { NationEmojiBehavior } from "../../../src/core/execution/nation/NationEmojiBehavior";
import { SpawnTimerExecution } from "../../../src/core/execution/SpawnTimerExecution";
import { TransportShipExecution } from "../../../src/core/execution/TransportShipExecution";
import { AiAttackBehavior } from "../../../src/core/execution/utils/AiAttackBehavior";
import { WinCheckExecution } from "../../../src/core/execution/WinCheckExecution";
import {
  Attack,
  Difficulty,
  Execution,
  Game,
  GameMapSize,
  GameMapType,
  GameType,
  Player,
  PlayerInfo,
  PlayerType,
  Relation,
  TerraNullius,
  Unit,
  UnitType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl, TileRef } from "../../../src/core/game/GameMap";
import { genTerrainFromBin } from "../../../src/core/game/TerrainMapLoader";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import { GameConfig, IntentSchema } from "../../../src/core/Schemas";
import { setup } from "../../util/Setup";

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const AGENT_CLIENT = "AGENT000";
const AGENT_ID = "AGENTID1";
const OTHER_ID = "OTHERID1";

/** The arena's game (src/agent/arena/ArenaGame.ts, arenaGameStart). */
const ARENA_START = arenaGameStart({
  index: 0,
  gameID: "BoatsWin",
  map: GameMapType.World,
  mapSize: GameMapSize.Normal,
  difficulty: Difficulty.Impossible,
  nations: "default",
  bots: 400,
  gameType: GameType.Singleplayer,
  seats: [{ agent: "baseline" }],
  maxTicks: 1,
  latencyTicks: 1,
  rateLimit: true,
  isolate: false,
  timelineEvery: 600,
  playOut: false,
  strict: false,
  imagesDir: null,
  imageEvery: 0,
});
const GAME_CONFIG: GameConfig = ARENA_START.config;

/** The real Config, logging calls; every result is the real one. */
class RecordingConfig extends Config {
  readonly logic: { input: AttackLogicInput; result: AttackLogicResult }[] = [];
  boatAttackAmountCalls = 0;
  attackLogic(input: AttackLogicInput): AttackLogicResult {
    const result = super.attackLogic(input);
    this.logic.push({ input, result });
    return result;
  }
  boatAttackAmount(attacker: Player, defender: Player | TerraNullius): number {
    this.boatAttackAmountCalls++;
    return super.boatAttackAmount(attacker, defender);
  }
}

// Terrain bytes (GameMap.ts:127-130): bit 7 land, bit 6 shoreline, bit 5
// ocean, bits 0-4 magnitude (land magnitude < 10 is Plains, :397-407).
const LAND = 0x80 | 5;
const OCEAN = 0x20;
const SHORELINE = 0x40;

function withShoreline(t: Uint8Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const land = (t[y * w + x] & 0x80) !== 0;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (((t[ny * w + nx] & 0x80) !== 0) !== land) {
          t[y * w + x] |= SHORELINE;
          break;
        }
      }
    }
  }
}

/** A map and its half-size minimap (water where any of the 2x2 is water). */
function maps(w: number, h: number, isLand: (x: number, y: number) => boolean) {
  const t = new Uint8Array(w * h);
  let land = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      t[y * w + x] = isLand(x, y) ? LAND : OCEAN;
      if (isLand(x, y)) land++;
    }
  }
  withShoreline(t, w, h);
  const mw = Math.ceil(w / 2);
  const mh = Math.ceil(h / 2);
  const m = new Uint8Array(mw * mh);
  let miniLand = 0;
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      let wet = false;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = 2 * x + dx;
          const sy = 2 * y + dy;
          if (sx < w && sy < h && !isLand(sx, sy)) wet = true;
        }
      }
      m[y * mw + x] = wet ? OCEAN : LAND;
      if (!wet) miniLand++;
    }
  }
  withShoreline(m, mw, mh);
  return {
    map: new GameMapImpl(w, h, t, land),
    mini: new GameMapImpl(mw, mh, m, miniLand),
  };
}

interface World {
  game: Game;
  config: RecordingConfig;
  agent: Player;
  executor: Executor;
}

function world(
  w: number,
  h: number,
  isLand: (x: number, y: number) => boolean,
  opts: { spawnPhase?: boolean } = {},
): World {
  const { map, mini } = maps(w, h, isLand);
  const config = new RecordingConfig(GAME_CONFIG, null, false);
  const game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    [],
    map,
    mini,
    config,
  );
  if (!opts.spawnPhase) game.endSpawnPhase();
  return {
    game,
    config,
    agent: game.player(AGENT_ID),
    executor: new Executor(game, "game", undefined),
  };
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

/** Ticks until no spawn immunity binds a Human attacker (PlayerImpl.ts:1907-1926). */
function passImmunity(game: Game) {
  let n = 0;
  while (game.isSpawnImmunityActive() || game.isNationSpawnImmunityActive()) {
    game.executeNextTick();
    n++;
  }
  expect(n).toBe(game.config().spawnImmunityDuration());
}

/**
 * The strait: island A (x 0-7, the agent's 128 tiles), open water x 8-71,
 * island C (x 72-79, 128 tiles) held by nobody, a nation or a tribe.
 */
const W = 80;
const H = 16;
function strait(
  c: "free" | PlayerType.Nation | PlayerType.Bot = "free",
): World & { other: Player | null } {
  const s = world(W, H, (x) => x < 8 || x >= 72);
  fill(s.game, s.agent, 0, 8, 0, H);
  s.agent.setTroops(10_000);
  let other: Player | null = null;
  if (c !== "free") {
    other = s.game.addPlayer(new PlayerInfo("other", c, null, OTHER_ID));
    fill(s.game, other, 72, W, 0, H);
  }
  passImmunity(s.game);
  return { ...s, other };
}

/** The agent's path: IntentSchema (AgentHost.isValid), then Executor.createExec. */
function send(
  s: World,
  intent:
    | { type: "boat"; troops: number; dst: TileRef }
    | { type: "cancel_boat"; unitID: number },
): Execution {
  expect(IntentSchema.safeParse(intent).success).toBe(true);
  const exec = s.executor.createExec({ ...intent, clientID: AGENT_CLIENT });
  s.game.addExecution(exec);
  return exec;
}

function sendBoat(s: World, dst: TileRef, troops: number): Execution {
  const exec = send(s, { type: "boat", troops, dst });
  expect(exec).toBeInstanceOf(TransportShipExecution);
  return exec;
}

/** Sends one boat and runs its launch tick; returns the ship built. */
function launch(s: World, dst: TileRef, troops: number) {
  const before = new Set(s.agent.units(UnitType.TransportShip));
  sendBoat(s, dst, troops);
  const launchTick = s.game.ticks();
  s.game.executeNextTick();
  const built = s.agent
    .units(UnitType.TransportShip)
    .filter((u) => !before.has(u));
  expect(built).toHaveLength(1);
  return { ship: built[0], launchTick };
}

/** Runs ticks until `ship` is gone; returns its tile after every tick and the landing tick. */
function sail(s: World, ship: Unit, maxTicks = 3000) {
  const route: TileRef[] = [ship.tile()];
  for (let i = 0; i < maxTicks; i++) {
    const tick = s.game.ticks();
    s.game.executeNextTick();
    if (!ship.isActive()) return { route, landTick: tick };
    route.push(ship.tile());
  }
  throw new Error("the ship never landed");
}

/** Runs ticks until `ship` stands on its landing tile: the next tick lands it. */
function sailToShore(s: World, ship: Unit) {
  const dst = ship.targetTile()!;
  for (let i = 0; i < 3000 && ship.tile() !== dst; i++) {
    s.game.executeNextTick();
  }
  expect(ship.tile()).toBe(dst);
  expect(ship.isActive()).toBe(true);
}

function only<T>(xs: readonly T[]): T {
  expect(xs).toHaveLength(1);
  return xs[0];
}

function nationAi(game: Game, nation: Player, reserveRatio: number) {
  const random = new PseudoRandom(42);
  const emoji = new NationEmojiBehavior(random, game, nation);
  // Ratios in the ranges NationExecution draws (NationExecution.ts:76-78);
  // behaviors wired as NationExecution wires them (:245-266).
  return new AiAttackBehavior(
    random,
    game,
    nation,
    0.55,
    reserveRatio,
    0.15,
    new NationAllianceBehavior(random, game, nation, emoji),
    emoji,
  );
}

describe("BoatsAndWin: a transport ship is free, 3 at a time, no cooldown", () => {
  test("it costs 0 gold and only the troops aboard; a 4th boat in the same tick is refused and costs nothing", () => {
    const s = strait();
    const { game, config, agent } = s;
    expect(config.unitInfo(UnitType.TransportShip).cost(game, agent)).toBe(0n);
    expect(config.boatMaxNumber()).toBe(3);
    agent.addGold(1_000_000n);
    const gold = agent.gold();

    const execs = [2, 6, 10, 14].map((y) => sendBoat(s, game.ref(75, y), 1000));
    game.executeNextTick();
    const ships = agent.units(UnitType.TransportShip);
    expect(ships.map((u) => u.troops())).toEqual([1000, 1000, 1000]);
    expect(agent.troops()).toBe(7000);
    expect(agent.gold()).toBe(gold);
    expect(execs.map((e) => e.isActive())).toEqual([true, true, true, false]);
  });

  test("while three are at sea every launch is refused for free; the tick they land, the next one sails", () => {
    const s = strait();
    const { game, agent } = s;
    const t0 = game.ticks();
    // Even rows: the route is planned on the half-size minimap, so an odd
    // row costs a detour (see the speed test).
    for (const y of [2, 8, 12]) sendBoat(s, game.ref(75, y), 1000);
    game.executeNextTick();
    const first = agent.units(UnitType.TransportShip);
    expect(first).toHaveLength(3);

    let accepted = -1;
    let firstLanding = -1;
    while (accepted < 0 && game.ticks() < t0 + 500) {
      const troops = agent.troops();
      const exec = sendBoat(s, game.ref(75, 8), 1000);
      const tick = game.ticks();
      game.executeNextTick();
      if (firstLanding < 0 && first.some((u) => !u.isActive())) {
        firstLanding = tick;
      }
      if (exec.isActive()) {
        accepted = tick;
        expect(agent.troops()).toBe(troops - 1000);
      } else {
        expect(agent.troops()).toBe(troops);
        expect(agent.units(UnitType.TransportShip)).toHaveLength(3);
      }
    }
    // No gap at all: executions tick (the ships land) before new ones init
    // (GameImpl.executeNextTick, GameImpl.ts:526-551).
    expect(accepted).toBe(firstLanding);
    // All three crossed the same 65 tiles and landed together.
    expect(accepted).toBe(t0 + 66);
    expect(first.every((u) => !u.isActive())).toBe(true);
    expect(agent.units(UnitType.TransportShip)).toHaveLength(1);
    expect(agent.outgoingAttacks()).toHaveLength(3);
  });

  test("troops: exactly the intent's number, clamped to home troops and paid at launch; Config.boatAttackAmount is never asked", () => {
    const s = strait();
    const { game, config, agent } = s;
    const dst = game.ref(75, 8);
    for (const bad of [
      { type: "boat", troops: null, dst },
      { type: "boat", troops: -1, dst },
      { type: "boat", dst },
    ]) {
      expect(IntentSchema.safeParse(bad).success).toBe(false);
    }

    const a = launch(s, game.ref(75, 2), 2500).ship;
    expect(a.troops()).toBe(2500);
    expect(agent.troops()).toBe(7500);

    // Fractional: the ship keeps 1234.5, home pays floor(1234.5).
    const b = launch(s, game.ref(75, 8), 1234.5).ship;
    expect(b.troops()).toBe(1234.5);
    expect(agent.troops()).toBe(7500 - 1234);

    // More than we hold: everything goes.
    const c = launch(s, game.ref(75, 13), 1_000_000_000).ship;
    expect(c.troops()).toBe(6266);
    expect(agent.troops()).toBe(0);

    expect(config.boatAttackAmountCalls).toBe(0);
    // What it would have said: floor(troops / 5) (Config.ts:975-977).
    agent.setTroops(10_001);
    expect(config.boatAttackAmount(agent, game.terraNullius())).toBe(2000);
  });

  test("a 0-troop boat still takes its landing tile, from free land or from a player, and the empty attack then dies; on a nation it still embargoes us and makes us Hostile", () => {
    // C is split: the nation holds y 0-7, y 8-15 is free land.
    const s = world(W, H, (x) => x < 8 || x >= 72);
    const { game, agent } = s;
    fill(game, agent, 0, 8, 0, H);
    agent.setTroops(10_000);
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, OTHER_ID),
    );
    fill(game, nation, 72, W, 0, 8);
    nation.setTroops(5_000);
    passImmunity(game);
    expect(nation.relation(agent)).toBe(Relation.Neutral);

    const toNation = launch(s, game.ref(75, 3), 0).ship;
    const toFree = launch(s, game.ref(75, 12), 0).ship;
    expect(toNation.troops()).toBe(0);
    const nationDst = toNation.targetTile()!;
    const freeDst = toFree.targetTile()!;
    expect(game.owner(nationDst)).toBe(nation);
    expect(game.owner(freeDst).isPlayer()).toBe(false);

    sail(s, toNation);
    // The landing attack's init (AttackExecution.ts:113-122, :190-210) runs
    // before its first tick deletes the empty stack.
    expect(nation.hasEmbargoAgainst(agent)).toBe(true);
    expect(nation.relation(agent)).toBe(Relation.Hostile);
    sail(s, toFree);
    game.executeNextTick();
    expect(game.owner(nationDst)).toBe(agent);
    expect(game.owner(freeDst)).toBe(agent);
    expect(agent.numTilesOwned()).toBe(128 + 2);
    expect(nation.numTilesOwned()).toBe(64 - 1);
    expect(nation.troops()).toBe(5_000);
    expect(agent.troops()).toBe(10_000);
    expect(agent.outgoingAttacks()).toHaveLength(0);
  });
});

describe("BoatsAndWin: speed", () => {
  test("one tile per tick on a 4-connected route; the ship lands the tick after it reaches the shore", () => {
    const s = strait();
    const { game } = s;
    // A small water graph: the plain 4-neighbour A* chain (PathFinder.ts:51-56).
    const graph = game.miniWaterGraph();
    expect(graph === null || graph.nodeCount < 100).toBe(true);
    const { ship, launchTick } = launch(s, game.ref(75, 8), 1000);
    expect(ship.tile()).toBe(game.ref(7, 8));
    expect(ship.targetTile()).toBe(game.ref(72, 8));
    const { route, landTick } = sail(s, ship);
    expect(route.map((t) => game.x(t))).toEqual(
      Array.from({ length: 66 }, (_, i) => 7 + i),
    );
    expect(route.every((t) => game.y(t) === 8)).toBe(true);
    // 65 steps, then one tick to land: ETA = route length + 1.
    expect(landTick - launchTick).toBe(65 + 1);

    // An odd row: the minimap route (2x2 cells) is upscaled to even rows, so
    // the ship steps back onto (6, 12), crosses on row 12 and steps up to
    // (72, 13) at the end: 68 steps for the same 65-tile gap, and the only
    // diagonal step is the first.
    const s2 = strait();
    const odd = launch(s2, game.ref(75, 13), 1000);
    expect(odd.ship.tile()).toBe(game.ref(7, 13));
    const v = sail(s2, odd.ship);
    expect(v.route.length - 1).toBe(68);
    expect(v.route[1]).toBe(game.ref(6, 12));
    expect(v.route[v.route.length - 2]).toBe(game.ref(72, 12));
    expect(v.landTick - odd.launchTick).toBe(68 + 1);
  });

  test("on real terrain (tests/testdata/maps/world, the HPA chain) the route is a 4-connected staircase: a diagonal crossing costs its Manhattan length", async () => {
    const game = await setup(
      "world",
      GAME_CONFIG,
      [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
      undefined,
      RecordingConfig,
    );
    // HPA + smoothing (PathFinder.ts:58-66).
    expect(game.miniWaterHPA()).not.toBeNull();
    expect(game.miniWaterGraph()!.nodeCount).toBeGreaterThanOrEqual(100);
    const s: World = {
      game,
      config: game.config() as RecordingConfig,
      agent: game.player(AGENT_ID),
      executor: new Executor(game, "game", undefined),
    };
    // A North American and an Iberian ocean shore.
    const from = game.ref(514, 296);
    const to = game.ref(900, 244);
    expect(game.isOceanShore(from) && game.isOceanShore(to)).toBe(true);
    s.agent.conquer(from);
    s.agent.setTroops(10_000);
    const { ship, launchTick } = launch(s, to, 1000);
    expect(ship.tile()).toBe(from);
    expect(ship.targetTile()).toBe(to);
    const { route, landTick } = sail(s, ship);

    let diagonal = 0;
    for (let i = 1; i < route.length; i++) {
      const dx = Math.abs(game.x(route[i]) - game.x(route[i - 1]));
      const dy = Math.abs(game.y(route[i]) - game.y(route[i - 1]));
      expect(Math.max(dx, dy)).toBe(1);
      if (dx === 1 && dy === 1) diagonal++;
    }
    const steps = route.length - 1;
    expect(diagonal).toBe(0);
    expect(game.manhattanDist(from, to)).toBe(438);
    expect(Math.round(Math.sqrt(game.euclideanDistSquared(from, to)))).toBe(
      389,
    );
    expect(steps).toBe(442);
    expect(landTick - launchTick).toBe(steps + 1);
  });
});

describe("BoatsAndWin: landing", () => {
  test("on free land the landing tile costs nothing; the troops then take free land from it, and what is left comes home in full", () => {
    const s = strait();
    const { game, config, agent } = s;
    const { ship } = launch(s, game.ref(75, 8), 5000);
    const dst = ship.targetTile()!;
    sail(s, ship);

    // The landing tick: dst is ours with no attackLogic call and no loss.
    expect(game.owner(dst)).toBe(agent);
    expect(agent.numTilesOwned()).toBe(129);
    expect(config.logic).toHaveLength(0);
    const beach: Attack = only(agent.outgoingAttacks());
    expect(beach.sourceTile()).toBe(dst);
    expect(beach.target().isPlayer()).toBe(false);
    expect(beach.troops()).toBe(5000);
    expect(agent.troops()).toBe(5000);

    for (let i = 0; i < 500 && agent.outgoingAttacks().length > 0; i++) {
      game.executeNextTick();
    }
    expect(agent.outgoingAttacks()).toHaveLength(0);
    expect(agent.numTilesOwned()).toBe(256);
    // One real attackLogic call per tile but the landing tile.
    expect(config.logic).toHaveLength(127);
    expect(config.logic.every((c) => c.input.defender === null)).toBe(true);
    const spent = config.logic.reduce(
      (sum, c) => sum + c.result.attackerTroopLoss,
      0,
    );
    expect(spent).toBe(127 * 16);
    expect(agent.troops()).toBe(10_000 - spent);
  });

  test("on a player the landing tile is taken with no combat and no defender loss; the fight starts from it the next tick; the launch already rejected the player's alliance request", () => {
    const s = strait(PlayerType.Nation);
    const { game, config, agent } = s;
    const nation = s.other!;
    nation.setTroops(3000);
    nation.createAllianceRequest(agent);
    expect(agent.incomingAllianceRequests()).toHaveLength(1);
    const { ship } = launch(s, game.ref(75, 8), 5000);
    const dst = ship.targetTile()!;
    expect(game.owner(dst)).toBe(nation);
    // The launch (TransportShipExecution.ts:94-102) rejects the nation's
    // pending request; it does not embargo us or change the relation.
    expect(agent.incomingAllianceRequests()).toHaveLength(0);
    expect(nation.hasEmbargoAgainst(agent)).toBe(false);
    expect(nation.relation(agent)).toBe(Relation.Neutral);
    sail(s, ship);

    expect(game.owner(dst)).toBe(agent);
    expect(nation.numTilesOwned()).toBe(127);
    expect(nation.troops()).toBe(3000);
    expect(config.logic).toHaveLength(0);
    const beach = only(agent.outgoingAttacks());
    expect(beach.target()).toBe(nation);
    expect(beach.sourceTile()).toBe(dst);
    expect(beach.troops()).toBe(5000);
    // The landing attack's init embargoes us (AttackExecution.ts:113-122)
    // and costs -100 relation at Impossible (:190-210).
    expect(nation.hasEmbargoAgainst(agent)).toBe(true);
    expect(nation.relation(agent)).toBe(Relation.Hostile);

    game.executeNextTick();
    expect(config.logic.length).toBeGreaterThan(0);
    expect(
      config.logic.every((c) => c.input.defender?.type === PlayerType.Nation),
    ).toBe(true);
    expect(nation.troops()).toBeLessThan(3000);
    expect(beach.troops()).toBeLessThan(5000);
  });

  test("the landing attack nets 1:1 against an attack the target already has on us: the tile is taken, but the troops never fight", () => {
    for (const theirs of [8000, 2000]) {
      const s = strait(PlayerType.Nation);
      const { game, config, agent } = s;
      const nation = s.other!;
      nation.setTroops(30_000);
      const { ship } = launch(s, game.ref(75, 8), 5000);
      const dst = ship.targetTile()!;
      sailToShore(s, ship);
      // The nation's attack on us inits in the landing tick, just before
      // the landing attack (unInitExecs order, GameImpl.ts:538-546).
      game.addExecution(new AttackExecution(theirs, nation, agent.id()));
      game.executeNextTick();
      expect(ship.isActive()).toBe(false);
      expect(game.owner(dst)).toBe(agent);
      expect(nation.troops()).toBe(30_000 - theirs);
      expect(agent.troops()).toBe(5000);
      expect(config.logic).toHaveLength(0);
      if (theirs > 5000) {
        // Ours is deleted; theirs goes on with 8000 - 5000.
        expect(agent.outgoingAttacks()).toHaveLength(0);
        expect(only(agent.incomingAttacks()).troops()).toBe(theirs - 5000);
      } else {
        // Theirs is deleted; ours goes on with 5000 - 2000.
        expect(agent.incomingAttacks()).toHaveLength(0);
        const beach = only(agent.outgoingAttacks());
        expect(beach.sourceTile()).toBe(dst);
        expect(beach.troops()).toBe(5000 - theirs);
      }
    }
  });

  test("a later attack by the target deletes the beachhead attack 1:1 with no refund; the Impossible retaliation (a land attack across the beachhead) does exactly that", () => {
    // An explicit 8000 attack, a tick after the landing.
    const s = strait(PlayerType.Nation);
    const nation = s.other!;
    nation.setTroops(30_000);
    const { ship } = launch(s, s.game.ref(75, 8), 5000);
    sail(s, ship);
    const beach = only(s.agent.outgoingAttacks());
    s.game.executeNextTick();
    s.game.addExecution(new AttackExecution(8000, nation, s.agent.id()));
    s.game.executeNextTick();
    // The beachhead fought first this tick, then the nation's init netted.
    expect(beach.isActive()).toBe(false);
    expect(beach.troops()).toBeGreaterThan(0);
    expect(beach.troops()).toBeLessThan(5000);
    expect(s.agent.outgoingAttacks()).toHaveLength(0);
    expect(only(s.agent.incomingAttacks()).troops()).toBe(
      8000 - beach.troops(),
    );
    expect(s.agent.troops()).toBe(5000);
    s.game.executeNextTick();
    // Nothing came home (the nation's attack now eats the beachhead).
    expect(s.agent.troops()).toBeLessThanOrEqual(5000);

    // The real reply: retaliate is Impossible's first strategy
    // (AiAttackBehavior.ts:428); the beachhead gives the nation a land
    // border with us, so sendAttack sends a land attack (:825-827).
    const t = strait(PlayerType.Nation);
    const n2 = t.other!;
    n2.setTroops(t.config.maxTroops(n2));
    const boat = launch(t, t.game.ref(75, 8), 5000).ship;
    sail(t, boat);
    const beach2 = only(t.agent.outgoingAttacks());
    const ai = nationAi(t.game, n2, 0.35);
    expect(ai.findIncomingAttackPlayer()).toBe(t.agent);
    expect(n2.sharesBorderWith(t.agent)).toBe(true);
    expect(ai.sendAttack(t.agent, true)).toBe(true);
    t.game.executeNextTick();
    expect(beach2.isActive()).toBe(false);
    expect(t.agent.outgoingAttacks()).toHaveLength(0);
    expect(only(t.agent.incomingAttacks()).troops()).toBeGreaterThan(0);
    expect(t.agent.troops()).toBe(5000);
  });

  test("a beachhead is a port: the next boat to that coast launches from it, not from home", () => {
    const s = strait();
    const { game, agent } = s;
    const { ship } = launch(s, game.ref(75, 8), 1000);
    const beach = ship.targetTile()!;
    sail(s, ship);
    expect(game.owner(beach)).toBe(agent);
    // closestShoreByWater picks any shore tile of ours on the target's water
    // (SpatialQuery.ts:187-221), the beachhead included.
    const hop = launch(s, game.ref(75, 14), 100);
    expect(hop.ship.tile()).toBe(beach);
    expect(hop.ship.targetTile()).toBe(game.ref(72, 14));
    // A 10-step hop along the coast (x 70-71) instead of a 65-tile crossing.
    const v = sail(s, hop.ship);
    expect(v.route.length - 1).toBe(10);
    expect(v.landTick - hop.launchTick).toBe(10 + 1);
  });

  test("traps: landing on our own tile or cancelling loses 25%; a player allied mid-voyage still loses the tile; a free-land boat takes its tile from an ally", () => {
    // Our own land attack reached the landing tile first.
    const s = strait();
    const { ship } = launch(s, s.game.ref(75, 8), 4000);
    for (let i = 0; i < 10; i++) s.game.executeNextTick();
    s.agent.conquer(ship.targetTile()!);
    sail(s, ship);
    expect(s.agent.troops()).toBe(6000 + 4000 * 0.75);
    expect(s.agent.outgoingAttacks()).toHaveLength(0);
    expect(s.agent.numTilesOwned()).toBe(129);

    // cancel_boat: the ship sails back to our nearest shore and lands on our
    // own tile, so the same 25% die.
    const c = strait(PlayerType.Nation);
    const back = launch(c, c.game.ref(75, 8), 4000).ship;
    for (let i = 0; i < 20; i++) c.game.executeNextTick();
    send(c, { type: "cancel_boat", unitID: back.id() });
    const home = sail(c, back);
    expect(c.game.owner(home.route[home.route.length - 1])).toBe(c.agent);
    expect(c.agent.troops()).toBe(6000 + 4000 * 0.75);
    expect(c.agent.numTilesOwned()).toBe(128);
    expect(c.other!.numTilesOwned()).toBe(128);

    // Allied while the boat was at sea.
    const t = strait(PlayerType.Nation);
    const nation = t.other!;
    const boat = launch(t, t.game.ref(75, 8), 4000).ship;
    const dst = boat.targetTile()!;
    for (let i = 0; i < 10; i++) t.game.executeNextTick();
    t.agent.createAllianceRequest(nation)!.accept();
    expect(t.agent.isAlliedWith(nation)).toBe(true);
    sail(t, boat);
    expect(t.game.owner(dst)).toBe(t.agent);
    expect(nation.numTilesOwned()).toBe(127);
    expect(t.agent.troops()).toBe(10_000);
    expect(t.agent.outgoingAttacks()).toHaveLength(0);
    expect(t.agent.isAlliedWith(nation)).toBe(true);

    // A free-land boat; an ally takes the landing tile mid-voyage.
    const f = world(W, H, (x) => x < 8 || x >= 72);
    fill(f.game, f.agent, 0, 8, 0, H);
    f.agent.setTroops(10_000);
    const ally = f.game.addPlayer(
      new PlayerInfo("ally", PlayerType.Nation, null, OTHER_ID),
    );
    fill(f.game, ally, 76, W, 0, H);
    passImmunity(f.game);
    const free = launch(f, f.game.ref(73, 8), 1000).ship;
    const freeDst = free.targetTile()!;
    expect(f.game.owner(freeDst).isPlayer()).toBe(false);
    f.agent.createAllianceRequest(ally)!.accept();
    for (let i = 0; i < 10; i++) f.game.executeNextTick();
    ally.conquer(freeDst);
    sail(f, free);
    expect(f.game.owner(freeDst)).toBe(f.agent);
    expect(ally.numTilesOwned()).toBe(64);
    expect(f.agent.isAlliedWith(ally)).toBe(true);
    // Its landing attack is on terra nullius, as aimed.
    expect(only(f.agent.outgoingAttacks()).target().isPlayer()).toBe(false);
  });
});

describe("BoatsAndWin: an Impossible nation's boats (AiAttackBehavior)", () => {
  /** The strait with the nation on A and `target` on C. */
  function nationStrait(target: PlayerType.Human | PlayerType.Bot) {
    const s = world(W, H, (x) => x < 8 || x >= 72);
    const { game } = s;
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, OTHER_ID),
    );
    fill(game, nation, 0, 8, 0, H);
    const victim =
      target === PlayerType.Human
        ? s.agent
        : game.addPlayer(
            new PlayerInfo("tribe", PlayerType.Bot, null, "TRIBE1"),
          );
    fill(game, victim, 72, W, 0, H);
    expect(nation.sharesBorderWith(victim)).toBe(false);
    return { ...s, nation, victim };
  }

  test("at a player across the sea: troops()/5, unfloored (no cap applies: nobody is nearby)", () => {
    const { game, config, nation, victim } = nationStrait(PlayerType.Human);
    nation.setTroops(50_001);
    victim.setTroops(1000);
    const ai = nationAi(game, nation, 0.35);
    expect(ai.sendAttack(victim)).toBe(true);
    game.executeNextTick();
    const ship = only(nation.units(UnitType.TransportShip));
    expect(ship.troops()).toBe(50_001 / 5);
    expect(nation.troops()).toBe(50_001 - 10_000);
    expect(game.owner(ship.targetTile()!)).toBe(victim);
    expect(config.boatAttackAmountCalls).toBe(0);
  });

  test("at a tribe across the sea, sendAttack (the island strategy's path): 4 x the tribe's troops (calculateBotAttackTroops), not troops()/5", () => {
    const { game, config, nation, victim } = nationStrait(PlayerType.Bot);
    nation.setTroops(100_000);
    victim.setTroops(1000);
    const reserve = 0.35;
    // Room above the reserve must cover at least 2 x the tribe (:1157-1160).
    expect(100_000 - reserve * config.maxTroops(nation)).toBeGreaterThan(4000);
    const ai = nationAi(game, nation, reserve);
    expect(ai.sendAttack(victim)).toBe(true);
    game.executeNextTick();
    const ship = only(nation.units(UnitType.TransportShip));
    expect(ship.troops()).toBe(4 * 1000);
    expect(ship.troops()).not.toBe(100_000 / 5);
  });

  test("at a tribe across the sea, maybeAttack sends both sizes: the island strategy 4 x the tribe until its bot budget runs dry (it is never reset without a tribe nearby), the random boat troops()/5 all along", () => {
    const { game, config, nation, victim } = nationStrait(PlayerType.Bot);
    nation.setTroops(config.maxTroops(nation));
    const T = nation.troops();
    victim.setTroops(1000);
    const ai = nationAi(game, nation, 0.35);
    // Above the trigger ratio (0.55) every call, so attackBestTarget runs its
    // strategies (:289-303); with no bordering enemy and no nearby tribe, only
    // island (:400-408) finds the tribe.
    expect(T / config.maxTroops(nation)).toBeGreaterThan(0.55);
    // calculateAttackTroops' budget for a tribe (:1054, :1062-1065):
    // troops - reserveRatio x maxTroops - botAttackTroopsSent, where
    // botAttackTroopsSent grows with every tribe attack (:1091-1093) and is
    // reset only by attackBots when a tribe is nearby (:494-498).
    const reserve = config.maxTroops(nation) * 0.35;
    let sent = 0;
    const island: number[] = [];
    const randomCalls: number[] = [];
    for (let i = 0; i < 60; i++) {
      nation.setTroops(T);
      ai.maybeAttack();
      game.executeNextTick();
      const ships = nation.units(UnitType.TransportShip);
      for (const u of ships) {
        expect(game.owner(u.targetTile()!)).toBe(victim);
      }
      const sizes = ships.map((u) => u.troops());
      // The random boat: min(troops() / 5, troopSendCap() = Infinity).
      if (sizes.includes(T / 5)) randomCalls.push(i);
      const rest = sizes.filter((t) => t !== T / 5);
      expect(rest.length).toBeLessThanOrEqual(1);
      island.push(rest[0] ?? 0);

      // calculateBotAttackTroops (:1149-1165), replayed.
      const room = T - reserve - sent;
      const expected = 4000 > room ? (room < 2000 ? 0 : room) : 4000;
      expect(rest[0] ?? 0).toBe(expected);
      if (expected >= 1) sent += expected;
      for (const u of ships) u.delete(false);
    }
    const full = island.filter((t) => t === 4000).length;
    expect(full).toBe(Math.floor((T - reserve) / 4000));
    expect(full).toBe(27);
    // Then one remainder, then nothing for good.
    expect(island[full]).toBeGreaterThanOrEqual(2000);
    expect(island[full]).toBeLessThan(4000);
    expect(island.slice(full + 1).every((t) => t === 0)).toBe(true);
    // The random boat, about 1 call in 5 (:143-146), before and after.
    expect(randomCalls).toEqual([9, 11, 27, 37, 44]);
    expect(config.boatAttackAmountCalls).toBe(0);
  });

  test("at free land across a channel of 4 tiles: troops()/5 (capped for expansion)", () => {
    // A (x 0-7) the nation's, water x 8-11, free island B (x 12-19), sea.
    const s = world(40, H, (x) => x < 8 || (x >= 12 && x < 20));
    const { game } = s;
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, OTHER_ID),
    );
    fill(game, nation, 0, 8, 0, H);
    nation.setTroops(50_000);
    const ai = nationAi(game, nation, 0.35);
    expect(ai.sendAttack(game.terraNullius())).toBe(true);
    game.executeNextTick();
    const ship = only(nation.units(UnitType.TransportShip));
    expect(ship.troops()).toBe(10_000);
    expect(game.x(ship.targetTile()!)).toBe(12);
    expect(game.owner(ship.targetTile()!).isPlayer()).toBe(false);
  });
});

describe("BoatsAndWin: the FFA win condition", () => {
  /** 13 x 7 = 91 tiles of land. */
  const allLand = (spawnPhase = false) =>
    world(13, 7, () => true, { spawnPhase });

  function tilesOf(game: Game): TileRef[] {
    const out: TileRef[] = [];
    game.map().forEachTile((t) => out.push(t));
    return out;
  }

  /** Runs ticks until someone wins or `max` ticks pass; returns the winning tick. */
  function runToWin(game: Game, max: number): number | null {
    for (let i = 0; i < max; i++) {
      const tick = game.ticks();
      game.executeNextTick();
      if (game.getWinner() !== null) return tick;
    }
    return null;
  }

  test("strictly more than 80% of the land, judged only on ticks divisible by 10 and never in the spawn phase; landShare agrees", () => {
    const { game, config, agent } = allLand(true);
    const land = game.numLandTiles();
    expect(land).toBe(91);
    expect(config.overtimeConfig().enabled).toBe(false);
    for (const t of [0, 1799, 1800, 3600, 10_199]) {
      expect(config.percentageTilesOwnedToWin(t)).toBe(80);
    }
    const tiles = tilesOf(game);
    for (const t of tiles) agent.conquer(t);
    game.addExecution(new WinCheckExecution());
    // Spawn phase: 100% of the land and no winner.
    expect(runToWin(game, 30)).toBeNull();

    // The smallest k with k * 100 > land * 80.
    const need = Math.floor((land * 80) / 100) + 1;
    expect(need).toBe(73);
    for (const t of tiles.slice(need - 1)) agent.relinquish(t);
    expect(agent.numTilesOwned()).toBe(need - 1);
    game.endSpawnPhase();
    expect(runToWin(game, 30)).toBeNull();
    expect(landShare(game, agent)).toBeLessThan(0.8);

    agent.conquer(tiles[need - 1]);
    expect(landShare(game, agent)).toBeGreaterThan(0.8);
    const next = game.ticks();
    const won = runToWin(game, 30);
    expect(won).toBe(Math.ceil(next / 10) * 10);
    expect(game.getWinner()).toBe(agent);
  });

  test("fallout leaves the denominator (at exactly 80% there is no win); conquering a fallout tile puts it back", () => {
    const { game, agent } = allLand();
    const tiles = tilesOf(game);
    for (const t of tiles.slice(0, 56)) agent.conquer(t);
    const free = tiles.slice(56);
    // 21 nuked tiles: 56 of 70 is exactly 80%, not more.
    for (const t of free.slice(0, 21)) game.setFallout(t, true);
    expect(game.numTilesWithFallout()).toBe(21);
    expect(() => game.setFallout(tiles[0], true)).toThrow();
    game.addExecution(new WinCheckExecution());
    expect(runToWin(game, 30)).toBeNull();
    expect(landShare(game, agent)).toBe(0.8);

    game.setFallout(free[21], true);
    expect(landShare(game, agent)).toBeGreaterThan(0.8);
    expect(runToWin(game, 30)).not.toBeNull();
    expect(game.getWinner()).toBe(agent);

    agent.conquer(free[0]);
    expect(game.hasFallout(free[0])).toBe(false);
    expect(game.numTilesWithFallout()).toBe(21);
  });

  test("the FFA winner is simply the player with the most tiles, of any type: a tribe that crosses the line ends the game", () => {
    const { game, agent } = allLand();
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "TRIBE1"),
    );
    const tiles = tilesOf(game);
    for (const t of tiles.slice(0, 73)) tribe.conquer(t);
    for (const t of tiles.slice(73)) agent.conquer(t);
    game.addExecution(new WinCheckExecution());
    expect(runToWin(game, 20)).not.toBeNull();
    expect(game.getWinner()).toBe(tribe);
  });

  test("time: the arena stops at its own cap (60 minutes by default) with no winner; WinCheck's 170-minute rule (the leader wins at any share) fires only later, even against --max-minutes 170", () => {
    expect(GAME_CONFIG.gameMode).toBe("Free For All");
    expect(GAME_CONFIG.maxTimerValue).toBeUndefined();
    expect(GAME_CONFIG.overtime).toBeUndefined();
    const limit = (WinCheckExecution as unknown as Record<string, number>)[
      "HARD_TIME_LIMIT_SECONDS"
    ];
    expect(limit).toBe(170 * 60);

    // The arena's cap: absolute ticks, spawn phase included (Arena.ts:401,
    // :626); ArenaGame.ts:363 stops there and :373 records "timeout".
    const defaults = parseArgs([]);
    expect(defaults.maxMinutes).toBe(60);
    expect(makeSpecs(defaults)[0].spec.maxTicks).toBe(36_000);
    const longest = makeSpecs(parseArgs(["--max-minutes", "170"]))[0].spec;
    expect(longest.maxTicks).toBe(102_000);

    // In the simulation: a real spawn timer (as GameRunner.ts:172 adds it)
    // ends the spawn phase; the 170 minutes count from there.
    const { game, agent } = allLand(true);
    const spawnTurns = game.config().numSpawnPhaseTurns();
    expect(spawnTurns).toBe(100);
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, OTHER_ID),
    );
    const tiles = tilesOf(game);
    for (const t of tiles.slice(0, 30)) agent.conquer(t);
    for (const t of tiles.slice(30, 70)) nation.conquer(t);
    game.addExecution(new SpawnTimerExecution(), new WinCheckExecution());
    const won = runToWin(game, spawnTurns + limit * 10 + 20);
    // SpawnTimerExecution ends the phase in the tick after spawnTurns.
    const startTick = spawnTurns + 1;
    expect(won).toBe(Math.ceil((startTick + limit * 10) / 10) * 10);
    expect(won).toBe(102_110);
    expect(game.getWinner()).toBe(nation);
    expect(landShare(game, nation)).toBeLessThan(0.5);
    // The arena's last tick is maxTicks - 1 (it stops once ticks() reaches
    // maxTicks): the rule never fires there.
    expect(longest.maxTicks - 1).toBeLessThan(won!);
  });

  test("what counts as land: the manifest's num_land_tiles is the land without impassable tiles (resources/maps/bosphorusstraits)", async () => {
    const dir = path.join(REPO, "resources/maps/bosphorusstraits");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
    );
    const map = await genTerrainFromBin(
      manifest.map,
      new Uint8Array(fs.readFileSync(path.join(dir, "map.bin"))),
    );
    let land = 0;
    let impassable = 0;
    map.forEachTile((t) => {
      if (map.isImpassable(t)) impassable++;
      else if (map.isLand(t)) land++;
    });
    expect(impassable).toBeGreaterThan(0);
    expect(map.numLandTiles()).toBe(land);
  });

  test("Perception.landShare > 0.8 is exactly the win test, on every real map's land count", () => {
    const root = path.join(REPO, "resources/maps");
    const counts = fs
      .readdirSync(root)
      .filter((m) => fs.existsSync(path.join(root, m, "manifest.json")))
      .map(
        (m) =>
          JSON.parse(
            fs.readFileSync(path.join(root, m, "manifest.json"), "utf8"),
          ).map.num_land_tiles as number,
      );
    expect(counts.length).toBeGreaterThan(100);
    const pct = new Config(GAME_CONFIG, null, false).percentageTilesOwnedToWin(
      0,
    );
    let checked = 0;
    for (const n of counts) {
      for (const fallout of [0, 1, 12_345]) {
        const denominator = n - fallout;
        const game = {
          numLandTiles: () => n,
          numTilesWithFallout: () => fallout,
        } as unknown as Game;
        const edge = Math.floor((denominator * pct) / 100);
        for (let k = edge - 2; k <= edge + 2; k++) {
          const p = { numTilesOwned: () => k } as unknown as Player;
          expect(landShare(game, p) > 0.8).toBe(k * 100 > denominator * pct);
          checked++;
        }
      }
    }
    expect(checked).toBe(counts.length * 15);
  });
});
