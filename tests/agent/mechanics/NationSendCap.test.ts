/**
 * Pins roadmap H4 (docs/11-roadmap.md §11.3; the risk table asks for every
 * mechanic an agent relies on to be pinned here) against real
 * NationExecutions.
 *
 * The claim under test ("NationSendCap"): in FFA an Impossible nation sends at
 * most `troops - 0.9 x (strongest non-allied, non-bot nearby player's
 * troops)` (troopSendCap); it refuses to send < 20% of the target's troops
 * unless it is itself under attack (isAttackTooWeak); while it borders free
 * land it launches no other land or boat attack (maybeAttack). [DERIVED] So
 * it cannot attack us by land while our HOME troops exceed ~0.91x its troops,
 * or by boat (it sends troops/5) while they exceed its troops; and at 1.11x
 * even a nation under attack is capped at the size of the attack it faces.
 *
 * The rules (the code is the spec; src/core/execution/utils/AiAttackBehavior.ts
 * unless named):
 * - Schedule. NationExecution.tick (src/core/execution/NationExecution.ts:
 *   109-229): the first tick after spawn builds the behaviours and force-sends
 *   troops/2 at free land, uncapped (:194-198, forceSendAttack :812-820);
 *   after that it decides once every attackRate ticks (Impossible 30-49,
 *   :102-103, :200-216), running maybeAttack last but two (:218-228). Its
 *   ratios come from its own PRNG (trigger 50-59%, reserve 30-39%, expand
 *   10-19% of cap, :76-78).
 * - maybeAttack (:98-157): if it borders unowned, un-nuked land (4-neighbours
 *   of its border, or free land in nearby()) and sendAttack(terra nullius)
 *   succeeds, it returns (:135-141). Otherwise: with no bordering enemy a
 *   1-in-5 random boat (:143-146); else a 1-in-10 random boat that also
 *   returns (:148-151), and alliance requests. Then attackBestTarget
 *   (:278-304): below reserveRatio x cap nothing (:290), below triggerRatio x
 *   cap only 1 decision in 10 (:293), then Impossible's strategy list
 *   [retaliate, bots, veryWeak, betray, assist, victim, traitor, juicy, afk,
 *   nuked, hated, weakest, island, donate] (:426-428).
 * - Every attack on a player goes through sendAttack (:822-840): land if it
 *   sharesBorderWith the target (PlayerImpl.ts:572-585), else sendBoatAttack.
 *   calculateAttackTroops (:1041-1096): land = troops - reserveRatio x cap
 *   (:1052-1054, :1101), boat = troops/5 (:1135-1138); then
 *   min(that, troopSendCap()) (:1071-1074), nothing below 1 troop (:1076),
 *   and isAttackTooWeak refuses (:1081-1083). The random boat does the same
 *   min and check with troops/5 (:192-202), without the reserve gate.
 * - troopSendCap (:986-1032): Bots and Team games are uncapped; Impossible
 *   keeps retainFraction = 0.9 (:997-998) of maxNeighborTroops, the most
 *   troops of any nearby() player that is not friendly and not a Bot
 *   (:1004-1014); cap = max(0, troops - ceil(0.9 x that)) or Infinity when
 *   there is none (:1016-1022). Under attack it rises to at least the sum of
 *   ALL incoming attacks, tribes' included (:1024-1029).
 * - isAttackTooWeak (:961-973): Hard/Impossible FFA refuse troops <
 *   0.2 x target.troops(), unless incomingAttacks() is non-empty — any
 *   attacker, tribes included (:966).
 * - "nearby" is PlayerImpl.nearby() (src/core/game/PlayerImpl.ts:605-695):
 *   the owners (players, or terra nullius) of land, passable tiles 4-adjacent
 *   to our border (forEachNeighbor, src/core/game/GameMap.ts:422-430; unowned
 *   fallout excluded), plus, for every 10th shore border tile, the owner of
 *   the land tile exactly 5 steps out in each direction whose first step is
 *   water (shoreReachableNeighbors :652-695): rivers up to 4 tiles wide.
 *   "friendly" is allied or same team, and a disconnected player never is
 *   (isFriendly :1296-1304).
 * - troops() is home troops: an attack's troops leave the owner when it is
 *   created (AttackExecution.ts:130-140).
 * - Retaliation: retaliate answers the largest incoming non-bot attacker with
 *   force (:313-319, findIncomingAttackPlayer :458-479, nations ignore tribe
 *   attackers :462-466).
 *
 * VERDICT: TRUE, every part as stated, with refinements an agent needs:
 * - The land line is exact: an adjacent nation with home troops T attacks us
 *   iff T - ceil(0.9 H) >= 0.2 H (H = our home troops; the send is also
 *   bounded by its reserve surplus), i.e. H <= H* ~ T / 1.1 = 0.909 T. For
 *   T = 172,823, H* = 157,111: attacked at H*, never at H* + 1 in five minutes
 *   although it picks us as a target at most decisions. A live game with
 *   income on both sides obeys the prediction at every decision.
 * - "Under attack" is any incoming attack, a tribe's included: a tribe
 *   poking the nation lifts the 20% floor for its attacks on us too, and
 *   the cap becomes max(cap, sum of all incoming attacks).
 * - At H >= T / 0.9 (1.111x) the cap is 0: a poke of ours is answered with
 *   exactly its size; the nation cannot even attack a weak tribe, and its
 *   free-land sends shrink to ceil(5%) of its troops per decision.
 * - Boats: the line is exactly T when we are not nearby (no cap; the target
 *   filters skip stronger players before sizing). Across a river of <= 4
 *   tiles we are nearby, and the 0.909 line applies to boats as well.
 * - A stronger non-bot player nearby the nation shields a weak us completely
 *   (cap 0); a stronger tribe does not count.
 * - The free-land gate held at every decision while free land bordered it
 *   (7 here); at the next decision after the land ran out, it attacked us.
 *   The opening troops/2 at free land is uncapped.
 * - With equal land, both at cap, we hold 1/1.25 = 0.8x and are attacked;
 *   being out of reach at cap takes 1.26x-1.6x its land (no cities).
 * - Its decision ticks and ratios follow from (gameID, nation id) alone.
 *
 * Setting: the real Config class (not TestConfig,
 * tests/util/TestConfig.ts), FFA, Singleplayer, Impossible, 400 tribes in the
 * config, Normal size, the game built as setup() builds it
 * (tests/util/Setup.ts: new Config(gameConfig, new UserSettings(), false),
 * createGame, endSpawnPhase); the arena makes the same class
 * (src/core/GameRunner.ts:46). Maps are synthesized in memory; every land
 * tile is owned unless a test adds free land. The NationExecution is the
 * real one, seeded as in a game (gameID + nation id). Except in the live
 * test, no PlayerExecution runs, so troops and gold stay where the test puts
 * them (no income, no structures); the test sets troops before a decision,
 * never during one. A scripted setup leaves hasSpawned() false and
 * largestClusterBoundingBox unset: the first is read only by the spawn-phase
 * branch (NationExecution.ts:127, :184), the second only for an island
 * target's centre, which falls back to the border's box (:758-763).
 * Our attacks go through IntentSchema and Executor.createExec, the path of
 * ctx.send. Every attack or boat is recorded as it is constructed, i.e. the
 * decision, before AttackExecution.init adjusts it.
 */
import { Config } from "../../../src/core/configuration/Config";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import { TransportShipExecution } from "../../../src/core/execution/TransportShipExecution";
import {
  Cell,
  Difficulty,
  Execution,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Nation,
  Player,
  PlayerID,
  PlayerInfo,
  PlayerType,
  TerraNullius,
  UnitType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl, TileRef } from "../../../src/core/game/GameMap";
import { UserSettings } from "../../../src/core/game/UserSettings";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import { GameConfig, IntentSchema } from "../../../src/core/Schemas";
import { simpleHash } from "../../../src/core/Util";

const GAME_ID = "nation-send-cap";
const AGENT_CLIENT = "AGENTCL1";
const AGENT_ID = "AGENTID1";
const NATION_ID = "NATION01";
const THIRD_CLIENT = "THIRDCL1";
const THIRD_ID = "THIRD001";

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

/** Five game minutes (10 ticks per second). */
const WINDOW = 3000;

// Terrain bytes (GameMap.ts:127-130: bit 7 land, bit 6 shoreline, bit 5
// ocean, bits 0-4 magnitude; land magnitude < 10 is Plains, :397-407).
const LAND = 0x80 | 5;
const OCEAN = 0x20;
const SHORELINE = 0x40;

type Seat = "us" | "nation" | "third" | "free" | "water";

interface Spec {
  width: number;
  height: number;
  seat: (x: number, y: number) => Seat;
  third?: PlayerType.Human | PlayerType.Nation | PlayerType.Bot;
}

/** NationExecution's private state, read (never written) by the test. */
interface NationInternals {
  attackRate: number;
  attackTick: number;
  triggerRatio: number;
  reserveRatio: number;
  expandRatio: number;
  behaviorsInitialized: boolean;
  attackBehavior: {
    troopSendCap(): number;
    isAttackTooWeak(troops: number, target: Player): boolean;
  };
}

/** One attack or boat some player decided to send (constructor arguments). */
interface Sent {
  tick: number;
  kind: "land" | "boat";
  from: PlayerID;
  /** Target player id; null for free land. */
  to: PlayerID | null;
  troops: number;
}

interface World {
  game: Game;
  config: Config;
  us: Player;
  nation: Player;
  third: Player | null;
  exec: NationExecution;
  n: NationInternals;
  sent: Sent[];
  executor: Executor;
}

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

/** The map and its half-size minimap (water where any of the 2x2 is water). */
function terrain(spec: Spec): { map: GameMapImpl; mini: GameMapImpl } {
  const { width: w, height: h } = spec;
  const water = (x: number, y: number) => spec.seat(x, y) === "water";
  const t = new Uint8Array(w * h);
  let land = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      t[y * w + x] = water(x, y) ? OCEAN : LAND;
      if (!water(x, y)) land++;
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
          if (sx < w && sy < h && water(sx, sy)) wet = true;
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

function world(spec: Spec): World {
  const { map, mini } = terrain(spec);
  const config = new Config(GAME_CONFIG, new UserSettings(), false);
  const humans = [
    new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID),
  ];
  const nationObj = new Nation(
    new Cell(0, 0),
    new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
  );
  const nations = [nationObj];
  if (spec.third === PlayerType.Human) {
    humans.push(
      new PlayerInfo("rival", PlayerType.Human, THIRD_CLIENT, THIRD_ID),
    );
  } else if (spec.third === PlayerType.Nation) {
    // A second nation with no NationExecution: a passive rival.
    nations.push(
      new Nation(
        new Cell(0, 0),
        new PlayerInfo("rival", PlayerType.Nation, null, THIRD_ID),
      ),
    );
  }
  const game = createGame(humans, nations, map, mini, config);
  if (spec.third === PlayerType.Bot) {
    game.addPlayer(new PlayerInfo("tribe", PlayerType.Bot, null, THIRD_ID));
  }
  game.endSpawnPhase();
  const us = game.player(AGENT_ID);
  const nation = game.player(NATION_ID);
  const third = spec.third === undefined ? null : game.player(THIRD_ID);
  for (let y = 0; y < spec.height; y++) {
    for (let x = 0; x < spec.width; x++) {
      const s = spec.seat(x, y);
      const tile = game.ref(x, y);
      if (s === "us") us.conquer(tile);
      else if (s === "nation") nation.conquer(tile);
      else if (s === "third") third!.conquer(tile);
    }
  }

  // Record every attack and boat as it is constructed (the decision), before
  // AttackExecution.init / TransportShipExecution.init adjust anything.
  const sent: Sent[] = [];
  const add = game.addExecution.bind(game);
  game.addExecution = (...execs: Execution[]) => {
    for (const e of execs) {
      if (e instanceof AttackExecution) {
        const v = e as unknown as { _owner: Player; startTroops: number };
        sent.push({
          tick: game.ticks(),
          kind: "land",
          from: v._owner.id(),
          to: e.targetID(),
          troops: v.startTroops,
        });
      } else if (e instanceof TransportShipExecution) {
        const v = e as unknown as {
          attacker: Player;
          ref: TileRef;
          troops: number;
        };
        const owner = game.owner(v.ref);
        sent.push({
          tick: game.ticks(),
          kind: "boat",
          from: v.attacker.id(),
          to: owner.isPlayer() ? owner.id() : null,
          troops: v.troops,
        });
      }
    }
    add(...execs);
  };

  const exec = new NationExecution(GAME_ID, nationObj);
  return {
    game,
    config,
    us,
    nation,
    third,
    exec,
    n: exec as unknown as NationInternals,
    sent,
    executor: new Executor(game, GAME_ID, undefined),
  };
}

function tick(w: World, n = 1): void {
  for (let i = 0; i < n; i++) w.game.executeNextTick();
}

/**
 * Adds the NationExecution and runs its first ticks: init (attackRate,
 * attackTick, NationExecution.ts:81-91; GameImpl.executeNextTick inits new
 * executions at the end of the tick, src/core/game/GameImpl.ts:537-550), then
 * the behaviours and the uncapped opening attack of troops/2 on free land
 * (NationExecution.ts:194-198), then one more tick in which that attack, with
 * no free land, retreats in full (AttackExecution.ts:302-306). `idle` ticks
 * run first with no nation, e.g. to pass the nations' spawn immunity before
 * we attack one (GameImpl.isNationSpawnImmunityActive).
 */
function start(w: World, idle = 0): void {
  tick(w, idle);
  w.game.addExecution(w.exec);
  tick(w, 2);
  expect(w.n.behaviorsInitialized).toBe(true);
  tick(w);
}

function isDecisionTick(w: World): boolean {
  return w.game.ticks() % w.n.attackRate === w.n.attackTick;
}

/** Runs ticks until the next tick to run is a decision tick. */
function toDecision(w: World): void {
  while (!isDecisionTick(w)) tick(w);
}

/** Runs ticks until the next-but-one tick is a decision tick. */
function toEveOfDecision(w: World): void {
  while ((w.game.ticks() + 1) % w.n.attackRate !== w.n.attackTick) tick(w);
}

function nationSends(w: World, since = 0): Sent[] {
  return w.sent.slice(since).filter((s) => s.from === NATION_ID);
}

/** Runs the decision tick the world is parked on; returns the nation's sends. */
function decide(w: World): Sent[] {
  expect(isDecisionTick(w)).toBe(true);
  const i = w.sent.length;
  tick(w);
  return nationSends(w, i);
}

/**
 * Runs decisions (with `hold` before each) until one sends something; a
 * decision can pass with nothing when maybeAttack's 1-in-10 random-boat
 * branch returns early (AiAttackBehavior.ts:148-151). Returns the sends and
 * the prediction made just before that decision.
 */
function firstSend<T>(
  w: World,
  predict: () => T,
  hold: () => void = () => {},
  maxDecisions = 5,
): { sends: Sent[]; predicted: T; decisions: number } {
  for (let d = 1; d <= maxDecisions; d++) {
    toDecision(w);
    hold();
    const predicted = predict();
    const sends = decide(w);
    if (sends.length > 0) return { sends, predicted, decisions: d };
  }
  throw new Error(`no send in ${maxDecisions} decisions`);
}

/** Runs `ticks` ticks; returns the nation's sends and its decision count. */
function runWindow(
  w: World,
  ticks: number,
): { sends: Sent[]; decisions: number } {
  const i = w.sent.length;
  let decisions = 0;
  for (let t = 0; t < ticks; t++) {
    if (isDecisionTick(w)) decisions++;
    tick(w);
  }
  return { sends: nationSends(w, i), decisions };
}

/**
 * Counts the nation's sendAttack calls on `target` from now on (a spy that
 * calls through): the strategies that pick us as a target, before
 * calculateAttackTroops accepts or refuses the send.
 */
function attemptsOn(w: World, target: Player): () => number {
  const spy = vi.spyOn(
    w.n.attackBehavior as unknown as {
      sendAttack(t: Player | TerraNullius, force?: boolean): boolean;
    },
    "sendAttack",
  );
  return () => spy.mock.calls.filter((c) => c[0] === target).length;
}

/** Our attack, the way ctx.send delivers it (AgentHost -> Executor). */
function ourAttack(w: World, target: Player, troops: number): void {
  const intent = { type: "attack" as const, targetID: target.id(), troops };
  expect(IntentSchema.safeParse(intent).success).toBe(true);
  w.game.addExecution(
    w.executor.createExec({ ...intent, clientID: AGENT_CLIENT }),
  );
}

// The two constants, measured in beforeAll below.
let RETAIN = NaN;
let FLOOR = NaN;

/** troopSendCap (AiAttackBehavior.ts:986-1032) from the live state. */
function predictCap(w: World, threat: number, incoming = 0): number {
  let cap =
    threat === 0
      ? Infinity
      : Math.max(0, w.nation.troops() - Math.ceil(threat * RETAIN));
  if (incoming > 0) cap = Math.max(cap, incoming);
  return cap;
}

/**
 * calculateAttackTroops (AiAttackBehavior.ts:1041-1096) for an attack on a
 * non-bot player: land = troops - reserveRatio x cap, boat = troops / 5, then
 * the cap, the 1-troop minimum and the 20% floor. null = refused.
 */
function predictSend(
  w: World,
  kind: "land" | "boat",
  target: Player,
  threat: number,
  incoming = 0,
): number | null {
  const tn = w.nation.troops();
  const base =
    kind === "land"
      ? tn - w.config.maxTroops(w.nation) * w.n.reserveRatio
      : tn / 5;
  const troops = Math.min(base, predictCap(w, threat, incoming));
  if (troops < 1) return null;
  if (incoming === 0 && troops < target.troops() * FLOOR) return null;
  return troops;
}

/** Largest home troops H at which a nation with `tn` troops still sends. */
function landLine(tn: number): number {
  const sends = (h: number) => {
    const cap = Math.max(0, tn - Math.ceil(h * RETAIN));
    return cap >= 1 && !(cap < h * FLOOR);
  };
  let h = tn;
  while (!sends(h)) h--;
  return h;
}

/** A nation at 80% of its cap: above every trigger ratio (50-59%). */
function nationAt80(w: World): number {
  const tn = Math.round(0.8 * w.config.maxTroops(w.nation));
  w.nation.setTroops(tn);
  expect(tn / w.config.maxTroops(w.nation)).toBeGreaterThanOrEqual(
    w.n.triggerRatio,
  );
  return tn;
}

const halves = (x: number): Seat => (x < 20 ? "us" : "nation");

// The two constants of AiAttackBehavior (:998, :971), measured on the live
// behaviour of a real NationExecution rather than copied.
beforeAll(() => {
  const w = world({ width: 40, height: 20, seat: halves });
  start(w);
  expect(w.nation.incomingAttacks()).toHaveLength(0);
  const b = w.n.attackBehavior;
  // cap = troops - ceil(retain x threat)  =>  retain = (troops - cap) / threat
  w.us.setTroops(1_000_000);
  w.nation.setTroops(10_000_000);
  RETAIN = (10_000_000 - b.troopSendCap()) / 1_000_000;
  // The smallest send that is not too weak against a 1,000,000-troop target.
  let lo = 0;
  let hi = 1_000_000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (b.isAttackTooWeak(mid, w.us)) lo = mid + 1;
    else hi = mid;
  }
  FLOOR = lo / 1_000_000;
});

describe("H4 NationSendCap: the cap and the floor", () => {
  it("troopSendCap keeps 0.9 of the strongest threat; isAttackTooWeak refuses < 0.2 of the target", () => {
    expect(RETAIN).toBe(0.9);
    expect(FLOOR).toBe(0.2);

    const w = world({ width: 40, height: 20, seat: halves });
    start(w);
    const b = w.n.attackBehavior;
    // The cap floors at 0 (never negative) and depends on the threat's troops.
    w.us.setTroops(1_000_000);
    w.nation.setTroops(500_000);
    expect(b.troopSendCap()).toBe(0);
    w.us.setTroops(123_457);
    w.nation.setTroops(200_000);
    expect(b.troopSendCap()).toBe(200_000 - Math.ceil(123_457 * 0.9));
    // The floor is relative to the target, whatever the cap.
    expect(b.isAttackTooWeak(24_691, w.us)).toBe(true);
    expect(b.isAttackTooWeak(24_692, w.us)).toBe(false);

    // The land line: the nation sends iff T - ceil(0.9 H) >= 0.2 H, so H*
    // tends to T / (0.9 + 0.2) = 0.909 T; and the cap is 0 from H > T / 0.9.
    expect(landLine(1_000_000) / 1_000_000).toBeCloseTo(1 / 1.1, 5);
  });
});

describe("H4 NationSendCap: when a nation decides", () => {
  it("its decision ticks and ratios are a pure function of (gameID, nation id)", () => {
    const w = world({ width: 40, height: 20, seat: halves });
    for (const id of [NATION_ID, "Aztec Empire", "nation-7"]) {
      const exec = new NationExecution(
        GAME_ID,
        new Nation(undefined, new PlayerInfo(id, PlayerType.Nation, null, id)),
      );
      exec.init(w.game);
      const n = exec as unknown as NationInternals;
      // The draws of NationExecution's constructor (:73-78) and init
      // (:83-84, Impossible attackRate :102-103), in order.
      const r = new PseudoRandom(simpleHash(id) + simpleHash(GAME_ID));
      const trigger = r.nextInt(50, 60) / 100;
      const reserve = r.nextInt(30, 40) / 100;
      const expand = r.nextInt(10, 20) / 100;
      const rate = r.nextInt(30, 50);
      const offset = r.nextInt(0, rate);
      expect([
        n.triggerRatio,
        n.reserveRatio,
        n.expandRatio,
        n.attackRate,
        n.attackTick,
      ]).toEqual([trigger, reserve, expand, rate, offset]);
    }
  });
});

describe("H4 NationSendCap: what nearby() counts", () => {
  it("4-adjacent owners count; a player touching only diagonally does not", () => {
    // Nation: the 10x10 top-left block. Third (a human): the single tile
    // (10,10), which touches the nation's (9,9) only at a corner.
    const w = world({
      width: 20,
      height: 20,
      third: PlayerType.Human,
      seat: (x, y) =>
        x < 10 && y < 10 ? "nation" : x === 10 && y === 10 ? "third" : "us",
    });
    start(w);
    expect(w.nation.nearby()).toEqual([w.us]);
    expect(w.nation.sharesBorderWith(w.third!)).toBe(false);
    w.us.setTroops(100_000);
    w.third!.setTroops(10_000_000);
    w.nation.setTroops(500_000);
    expect(w.n.attackBehavior.troopSendCap()).toBe(
      500_000 - Math.ceil(100_000 * RETAIN),
    );
  });

  it("across water only the land tile exactly 5 steps out counts: rivers up to 4 tiles wide", () => {
    const nearbyAcross = (river: number) => {
      const w = world({
        width: 40,
        height: 20,
        seat: (x) => (x < 15 ? "nation" : x < 15 + river ? "water" : "us"),
      });
      expect(w.nation.sharesBorderWith(w.us)).toBe(false);
      return w.nation.nearby().includes(w.us);
    };
    expect([1, 2, 3, 4, 5, 6].map(nearbyAcross)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("the cap counts nations and humans, not tribes or allies; no threat, no cap", () => {
    // us | nation | tribe
    const tribeSide = world({
      width: 60,
      height: 20,
      third: PlayerType.Bot,
      seat: (x) => (x < 20 ? "us" : x < 40 ? "nation" : "third"),
    });
    start(tribeSide);
    const cap = () => tribeSide.n.attackBehavior.troopSendCap();
    tribeSide.nation.setTroops(500_000);
    tribeSide.us.setTroops(100_000);
    tribeSide.third!.setTroops(10_000_000);
    expect(tribeSide.nation.nearby()).toHaveLength(2);
    expect(cap()).toBe(500_000 - Math.ceil(100_000 * RETAIN));
    // Allied with us: the only non-bot neighbour is friendly -> uncapped.
    tribeSide.nation.createAllianceRequest(tribeSide.us)!.accept();
    expect(tribeSide.nation.isFriendly(tribeSide.us)).toBe(true);
    expect(cap()).toBe(Infinity);

    // us | nation | rival nation, and us | nation | rival human
    for (const type of [PlayerType.Nation, PlayerType.Human] as const) {
      const w = world({
        width: 60,
        height: 20,
        third: type,
        seat: (x) => (x < 20 ? "us" : x < 40 ? "nation" : "third"),
      });
      start(w);
      w.nation.setTroops(500_000);
      w.us.setTroops(100_000);
      w.third!.setTroops(300_000);
      expect(w.n.attackBehavior.troopSendCap()).toBe(
        500_000 - Math.ceil(300_000 * RETAIN),
      );
    }
  });

  it("under attack the cap rises to the sum of all incoming attacks, a tribe's included", () => {
    const w = world({
      width: 60,
      height: 20,
      third: PlayerType.Bot,
      seat: (x) => (x < 20 ? "us" : x < 40 ? "nation" : "third"),
    });
    start(w, w.config.nationSpawnImmunityDuration());
    w.nation.setTroops(200_000);
    w.us.setTroops(220_000);
    w.third!.setTroops(1_000_000);
    // 200,000 - ceil(0.9 x 220,000) = 2,000; the tribe is not a threat.
    expect(w.n.attackBehavior.troopSendCap()).toBe(2_000);
    expect(w.n.attackBehavior.isAttackTooWeak(1, w.us)).toBe(true);
    w.game.addExecution(new AttackExecution(30_000, w.third!, NATION_ID));
    ourAttack(w, w.nation, 5_000);
    tick(w); // both inits run at the end of this tick
    const incoming = w.nation.incomingAttacks();
    expect(incoming).toHaveLength(2);
    const total = incoming.reduce((s, a) => s + a.troops(), 0);
    expect(total).toBe(35_000);
    // Our home fell to 215,000: 200,000 - ceil(193,500) = 6,500 < 35,000.
    expect(w.n.attackBehavior.troopSendCap()).toBe(total);
    expect(w.n.attackBehavior.isAttackTooWeak(1, w.us)).toBe(false);
  });
});

describe("H4 NationSendCap: a land-adjacent nation, no free land", () => {
  it("us at 0.95x its troops: no attack on us in five minutes", () => {
    const w = world({ width: 40, height: 20, seat: halves });
    start(w);
    const tn = nationAt80(w);
    const th = Math.round(0.95 * tn);
    w.us.setTroops(th);
    expect(w.n.reserveRatio).toBeLessThan(0.8);
    // The nation is live: every decision runs the full strategy list, and
    // `weakest` picks us (we have fewer troops, :388-398) nearly every time.
    const attempts = attemptsOn(w, w.us);
    const { sends, decisions } = runWindow(w, WINDOW);
    expect(decisions).toBeGreaterThanOrEqual(
      Math.floor(WINDOW / w.n.attackRate),
    );
    expect(attempts()).toBeGreaterThan(decisions / 2);
    expect(sends).toEqual([]);
    expect(w.nation.isFriendly(w.us)).toBe(false);
    expect(w.us.incomingAttacks()).toHaveLength(0);
    // Nothing moved: the state was held without touching it.
    expect([w.nation.troops(), w.us.troops()]).toEqual([tn, th]);
    // Why: cap 0.145 T < 0.2 x 0.95 T = 0.19 T.
    expect(predictSend(w, "land", w.us, th)).toBeNull();
  });

  it("us at 0.5x: it attacks at its first decision, with min(reserve surplus, cap)", () => {
    const w = world({ width: 40, height: 20, seat: halves });
    start(w);
    nationAt80(w);
    w.us.setTroops(Math.round(0.5 * w.nation.troops()));
    const { sends, predicted, decisions } = firstSend(w, () =>
      predictSend(w, "land", w.us, w.us.troops()),
    );
    // This seed's first decision does not draw the 1-in-10 early return.
    expect(decisions).toBe(1);
    expect(predicted).not.toBeNull();
    expect(sends).toEqual([
      expect.objectContaining({
        kind: "land",
        to: AGENT_ID,
        troops: predicted,
      }),
    ]);
    expect(w.us.incomingAttacks()).toHaveLength(1);
    expect(w.us.incomingAttacks()[0].attacker()).toBe(w.nation);
  });

  it("the line is exact: attacked at H*, not at H* + 1, H* = 0.909x its troops", () => {
    for (const offset of [0, 1]) {
      const w = world({ width: 40, height: 20, seat: halves });
      start(w);
      const tn = nationAt80(w);
      const line = landLine(tn);
      expect([tn, line]).toEqual([172_823, 157_111]);
      expect(line / tn).toBeCloseTo(1 / 1.1, 4);
      w.us.setTroops(line + offset);
      if (offset === 0) {
        const { sends, predicted } = firstSend(w, () =>
          predictSend(w, "land", w.us, w.us.troops()),
        );
        // The cap binds: exactly troops - ceil(0.9 H), >= 0.2 H.
        expect(predicted).toBe(tn - Math.ceil((line + offset) * RETAIN));
        expect(sends).toEqual([
          expect.objectContaining({
            kind: "land",
            to: AGENT_ID,
            troops: predicted,
          }),
        ]);
      } else {
        const attempts = attemptsOn(w, w.us);
        expect(runWindow(w, WINDOW).sends).toEqual([]);
        expect(attempts()).toBeGreaterThan(0);
      }
    }
  });

  it("home troops count: sending a quarter of our army at a tribe opens us to the nation", () => {
    // tribe | us | nation: the tribe is not nearby the nation.
    const w = world({
      width: 60,
      height: 20,
      third: PlayerType.Bot,
      seat: (x) => (x < 20 ? "third" : x < 40 ? "us" : "nation"),
    });
    start(w);
    const tn = nationAt80(w);
    const total = Math.round(0.95 * tn);
    w.us.setTroops(total);
    w.third!.setTroops(100_000);
    expect(w.nation.nearby()).toEqual([w.us]);
    // Safe while all 0.95 T is home.
    expect(runWindow(w, 500).sends).toEqual([]);
    toEveOfDecision(w);
    ourAttack(w, w.third!, Math.round(total / 4));
    tick(w);
    const home = w.us.troops();
    expect(home).toBe(total - Math.round(total / 4));
    const predicted = predictSend(w, "land", w.us, home);
    expect(predicted).not.toBeNull();
    expect(decide(w)).toEqual([
      expect.objectContaining({
        kind: "land",
        to: AGENT_ID,
        troops: predicted,
      }),
    ]);
  });

  it("equal land, both at their cap: we hold 0.8x (1/1.25) and are attacked", () => {
    const w = world({ width: 40, height: 20, seat: halves });
    start(w);
    expect(w.us.numTilesOwned()).toBe(w.nation.numTilesOwned());
    const capUs = w.config.maxTroops(w.us);
    const capNation = w.config.maxTroops(w.nation);
    expect(capUs / capNation).toBeCloseTo(0.8, 12);
    w.us.setTroops(Math.floor(capUs));
    w.nation.setTroops(Math.floor(capNation));
    const { sends, predicted } = firstSend(w, () =>
      predictSend(w, "land", w.us, w.us.troops()),
    );
    expect(sends).toEqual([
      expect.objectContaining({
        kind: "land",
        to: AGENT_ID,
        troops: predicted,
      }),
    ]);
  });

  it("at cap, being unattackable takes 1.26x-1.6x its land (Config.maxTroops)", () => {
    const w = world({ width: 40, height: 20, seat: halves });
    const cap = (type: PlayerType, tiles: number) =>
      w.config.maxTroops({
        type: () => type,
        numTilesOwned: () => tiles,
        units: () => [],
        isLobbyCreator: () => false,
      } as unknown as Player);
    const multiple = (nationTiles: number) => {
      const tn = cap(PlayerType.Nation, nationTiles);
      let lo = 1;
      let hi = 100 * nationTiles;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (cap(PlayerType.Human, mid) > landLine(tn)) hi = mid;
        else lo = mid + 1;
      }
      return lo / nationTiles;
    };
    const m = [400, 3_000, 30_000].map(multiple);
    expect(m[0]).toBeCloseTo(1.6, 1);
    expect(m[1]).toBeCloseTo(1.34, 1);
    expect(m[2]).toBeCloseTo(1.26, 1);
  });
});

describe("H4 NationSendCap: a live game with income", () => {
  it("with PlayerExecutions on both sides, every decision obeys the prediction", () => {
    const w = world({ width: 40, height: 20, seat: halves });
    // The order of a real game: NationExecutions are added at GameRunner.init,
    // PlayerExecutions when players spawn, so the nation decides on the
    // state at the start of its tick (GameImpl.ts:529-536).
    w.game.addExecution(w.exec);
    w.game.addExecution(new PlayerExecution(w.nation));
    w.game.addExecution(new PlayerExecution(w.us));
    // It starts below its reserve; we start near our cap.
    w.nation.setTroops(Math.round(0.3 * w.config.maxTroops(w.nation)));
    w.us.setTroops(Math.round(0.95 * w.config.maxTroops(w.us)));
    tick(w, 2);
    expect(w.n.behaviorsInitialized).toBe(true);

    let refused = 0;
    let sent = 0;
    let lastRefusedRatio = NaN;
    let firstSentRatio = NaN;
    for (let t = 0; t < WINDOW && w.us.isAlive(); t++) {
      if (!isDecisionTick(w)) {
        const i = w.sent.length;
        tick(w);
        expect(nationSends(w, i).filter((s) => s.to === AGENT_ID)).toEqual([]);
        continue;
      }
      const fill = w.nation.troops() / w.config.maxTroops(w.nation);
      const ratio = w.us.troops() / w.nation.troops();
      const predicted = predictSend(w, "land", w.us, w.us.troops());
      const onUs = decide(w).filter((s) => s.to === AGENT_ID);
      if (fill < w.n.reserveRatio || predicted === null) {
        expect(onUs).toEqual([]);
        // Above its trigger the strategy list surely ran (:290-293).
        if (fill >= w.n.triggerRatio && predicted === null) {
          refused++;
          lastRefusedRatio = ratio;
        }
      } else {
        for (const s of onUs) expect(s.troops).toBe(predicted);
        if (onUs.length > 0 && sent === 0) firstSentRatio = ratio;
        sent += onUs.length;
      }
    }
    // Both regimes occurred: refusals while our home troops held the line,
    // attacks once its larger cap (1.25x ours on equal land) carried it past
    // (this seed: refused at 0.973x, attacked at 0.907x, and we, passive,
    // were wiped out within 15 seconds).
    expect(refused).toBeGreaterThan(0);
    expect(sent).toBeGreaterThan(0);
    expect(lastRefusedRatio).toBeGreaterThan(1 / 1.1);
    expect(firstSentRatio).toBeLessThan(1 / 1.1);
  });
});

describe("H4 NationSendCap: the under-attack exception", () => {
  it("a 100-troop poke at 0.95x draws a counter-attack below the 20% floor", () => {
    const w = world({ width: 40, height: 20, seat: halves });
    start(w, w.config.nationSpawnImmunityDuration());
    const tn = nationAt80(w);
    w.us.setTroops(Math.round(0.95 * tn));
    toEveOfDecision(w);
    ourAttack(w, w.nation, 100);
    tick(w);
    const home = w.us.troops();
    expect(w.nation.incomingAttacks().map((a) => a.troops())).toEqual([100]);
    const predicted = predictSend(w, "land", w.us, home, 100);
    expect(predicted).not.toBeNull();
    // Refused without the poke, sent with it.
    expect(predicted!).toBeLessThan(home * FLOOR);
    expect(decide(w)).toEqual([
      expect.objectContaining({
        kind: "land",
        to: AGENT_ID,
        troops: predicted,
      }),
    ]);
    expect(w.us.incomingAttacks().map((a) => a.attacker())).toEqual([w.nation]);
  });

  it("at >= 1.12x a poke is answered with exactly the incoming troops", () => {
    const w = world({ width: 40, height: 20, seat: halves });
    start(w, w.config.nationSpawnImmunityDuration());
    const tn = nationAt80(w);
    w.us.setTroops(Math.ceil(1.12 * tn) + 100);
    toEveOfDecision(w);
    ourAttack(w, w.nation, 100);
    tick(w);
    expect(w.us.troops() / tn).toBeGreaterThanOrEqual(1.12);
    expect(predictCap(w, w.us.troops())).toBe(0);
    expect(decide(w)).toEqual([
      expect.objectContaining({ kind: "land", to: AGENT_ID, troops: 100 }),
    ]);
  });

  it("a tribe attacking the nation lifts the floor for its attacks on us", () => {
    // us | nation | tribe; the tribe is too strong for attackBots (it needs
    // 2x the tribe's troops, :1149-1166) and for hated (> 3x, :374).
    const w = world({
      width: 60,
      height: 20,
      third: PlayerType.Bot,
      seat: (x) => (x < 20 ? "us" : x < 40 ? "nation" : "third"),
    });
    start(w);
    const tn = nationAt80(w);
    const th = Math.round(0.95 * tn);
    w.us.setTroops(th);
    w.third!.setTroops(5 * tn);
    expect(runWindow(w, 500).sends).toEqual([]);
    toEveOfDecision(w);
    w.game.addExecution(new AttackExecution(1_000, w.third!, NATION_ID));
    tick(w);
    expect(w.nation.incomingAttacks()).toHaveLength(1);
    const predicted = predictSend(w, "land", w.us, th, 1_000);
    expect(predicted).toBe(predictCap(w, th));
    expect(predicted!).toBeLessThan(th * FLOOR);
    const sends = decide(w);
    expect(sends).toEqual([
      expect.objectContaining({
        kind: "land",
        to: AGENT_ID,
        troops: predicted,
      }),
    ]);
  });
});

describe("H4 NationSendCap: third parties next to the nation", () => {
  it("a stronger nearby nation shields a weak us: cap 0, nobody is attacked", () => {
    const w = world({
      width: 60,
      height: 20,
      third: PlayerType.Nation,
      seat: (x) => (x < 20 ? "us" : x < 40 ? "nation" : "third"),
    });
    start(w);
    const tn = nationAt80(w);
    w.us.setTroops(Math.round(0.5 * tn));
    w.third!.setTroops(Math.round(1.2 * tn));
    expect(w.n.attackBehavior.troopSendCap()).toBe(0);
    const attempts = attemptsOn(w, w.us);
    expect(runWindow(w, WINDOW).sends).toEqual([]);
    // It picks us (juicy: <= 0.75x, :669-674) and the cap refuses.
    expect(attempts()).toBeGreaterThan(0);
  });

  it("a stronger tribe does not shield us", () => {
    const w = world({
      width: 60,
      height: 20,
      third: PlayerType.Bot,
      seat: (x) => (x < 20 ? "us" : x < 40 ? "nation" : "third"),
    });
    start(w);
    const tn = nationAt80(w);
    w.us.setTroops(Math.round(0.5 * tn));
    w.third!.setTroops(5 * tn);
    const { sends, predicted } = firstSend(w, () =>
      predictSend(w, "land", w.us, w.us.troops()),
    );
    expect(sends).toEqual([
      expect.objectContaining({
        kind: "land",
        to: AGENT_ID,
        troops: predicted,
      }),
    ]);
  });

  it("from 1.11x (cap 0) it cannot even eat a weak tribe; at 0.95x it does", () => {
    // us | nation | tribe. attackBots sends 4x the tribe's troops
    // (calculateBotAttackTroops :1149-1166), then the cap (:1071-1074).
    const make = () => {
      const w = world({
        width: 60,
        height: 20,
        third: PlayerType.Bot,
        seat: (x) => (x < 20 ? "us" : x < 40 ? "nation" : "third"),
      });
      start(w);
      w.third!.setTroops(1_000);
      return { w, tn: nationAt80(w) };
    };

    const eats = make();
    eats.w.us.setTroops(Math.round(0.95 * eats.tn));
    const { sends } = firstSend(eats.w, () => null);
    expect(sends).toEqual([
      expect.objectContaining({ kind: "land", to: THIRD_ID, troops: 4_000 }),
    ]);

    const frozen = make();
    let h = Math.floor(frozen.tn / RETAIN) - 10;
    while (predictCap(frozen.w, h) >= 1) h++;
    expect(h / frozen.tn).toBeCloseTo(1 / 0.9, 4);
    frozen.w.us.setTroops(h);
    expect(frozen.w.n.attackBehavior.troopSendCap()).toBe(0);
    expect(runWindow(frozen.w, WINDOW).sends).toEqual([]);
    expect(frozen.w.third!.numTilesOwned()).toBe(400);
  });
});

describe("H4 NationSendCap: free land", () => {
  it("while it borders free land it attacks only free land; once that is gone, us", () => {
    // us | nation | 160 columns of free land
    const w = world({
      width: 200,
      height: 20,
      seat: (x) => (x < 20 ? "us" : x < 40 ? "nation" : "free"),
    });
    const tn0 = Math.round(0.8 * w.config.maxTroops(w.nation));
    w.nation.setTroops(tn0);
    w.us.setTroops(Math.round(0.5 * tn0));
    w.game.addExecution(w.exec);
    tick(w, 2);
    // The opening: troops/2 at free land, whatever the neighbours (uncapped).
    expect(nationSends(w)).toEqual([
      expect.objectContaining({ kind: "land", to: null, troops: tn0 / 2 }),
    ]);

    const map = w.game.map();
    const bordersFreeLand = () => {
      let found = false;
      w.nation.borderTiles().forEach((t) =>
        map.forEachNeighbor(t, (n) => {
          if (map.isLand(n) && !map.hasOwner(n) && !map.hasFallout(n))
            found = true;
        }),
      );
      return found;
    };
    // Before each decision: the nation at 80% of its (growing) cap, us at
    // half of that, so that without free land it would attack us.
    const hold = () => {
      const tn = Math.round(0.8 * w.config.maxTroops(w.nation));
      w.nation.setTroops(tn);
      w.us.setTroops(Math.round(0.5 * tn));
    };

    let freeLandDecisions = 0;
    for (;;) {
      toDecision(w);
      hold();
      if (!bordersFreeLand()) break;
      const cap = predictCap(w, w.us.troops());
      expect(cap).toBeGreaterThan(0);
      const expected = Math.min(
        w.nation.troops() - w.config.maxTroops(w.nation) * w.n.expandRatio,
        cap,
      );
      expect(predictSend(w, "land", w.us, w.us.troops())).not.toBeNull();
      expect(decide(w)).toEqual([
        expect.objectContaining({ kind: "land", to: null, troops: expected }),
      ]);
      freeLandDecisions++;
      expect(freeLandDecisions).toBeLessThan(40);
    }
    expect(freeLandDecisions).toBeGreaterThanOrEqual(3);
    expect(nationSends(w).filter((s) => s.to === AGENT_ID)).toEqual([]);

    // Free land gone: the same state now draws an attack on us.
    const { sends, predicted } = firstSend(
      w,
      () => predictSend(w, "land", w.us, w.us.troops()),
      hold,
    );
    expect(sends).toEqual([
      expect.objectContaining({
        kind: "land",
        to: AGENT_ID,
        troops: predicted,
      }),
    ]);
  });

  it("a neighbour at >= 1.11x throttles its free-land sends to ceil(5%) of its troops", () => {
    const w = world({
      width: 200,
      height: 20,
      seat: (x) => (x < 20 ? "us" : x < 40 ? "nation" : "free"),
    });
    const hold = () => {
      const tn = Math.round(0.8 * w.config.maxTroops(w.nation));
      w.nation.setTroops(tn);
      w.us.setTroops(Math.round(1.2 * tn));
    };
    hold();
    w.game.addExecution(w.exec);
    tick(w, 2);
    for (let d = 0; d < 3; d++) {
      toDecision(w);
      hold();
      expect(predictCap(w, w.us.troops())).toBe(0);
      // troopSendCapForExpansion (:1035-1039): a zero cap becomes 5%.
      const expected = Math.ceil(w.nation.troops() * 0.05);
      expect(decide(w)).toEqual([
        expect.objectContaining({ kind: "land", to: null, troops: expected }),
      ]);
    }
  });
});

describe("H4 NationSendCap: boats", () => {
  // Two 16x20 islands 14 tiles of ocean apart: not nearby.
  const islands: Spec = {
    width: 50,
    height: 24,
    seat: (x, y) =>
      y < 2 || y > 21
        ? "water"
        : x >= 2 && x <= 17
          ? "nation"
          : x >= 32 && x <= 47
            ? "us"
            : "water",
  };

  it("islands (not nearby, so no cap): at 0.95x it boats us with troops/5", () => {
    const w = world(islands);
    start(w);
    expect(w.nation.nearby()).toEqual([]);
    expect(w.n.attackBehavior.troopSendCap()).toBe(Infinity);
    const tn = nationAt80(w);
    w.us.setTroops(Math.round(0.95 * tn));
    // By land this would be refused: the land line is 0.909x.
    expect(predictSend(w, "land", w.us, w.us.troops())).toBeNull();
    const { sends, predicted } = firstSend(w, () =>
      predictSend(w, "boat", w.us, 0),
    );
    expect(predicted).toBe(tn / 5);
    expect(sends.length).toBeGreaterThan(0);
    for (const s of sends) {
      expect(s).toEqual(
        expect.objectContaining({ kind: "boat", to: AGENT_ID, troops: tn / 5 }),
      );
    }
    expect(w.nation.units(UnitType.TransportShip).length).toBe(sends.length);
  });

  it("islands: the boat line is its troops, none at T + 1 in five minutes, boats at T - 1", () => {
    const w = world(islands);
    start(w);
    const tn = nationAt80(w);
    w.us.setTroops(tn + 1);
    const attempts = attemptsOn(w, w.us);
    const { sends, decisions } = runWindow(w, WINDOW);
    expect(decisions).toBeGreaterThanOrEqual(
      Math.floor(WINDOW / w.n.attackRate),
    );
    expect(sends).toEqual([]);
    // Here the target filters stop it before any send is sized: the random
    // boat skips stronger players (:243-250), and so does `island`
    // (findNearestIslandEnemy :695-700).
    expect(attempts()).toBe(0);

    w.us.setTroops(tn - 1);
    const next = firstSend(w, () => predictSend(w, "boat", w.us, 0));
    expect(next.predicted).toBe(tn / 5);
    expect(next.sends.length).toBeGreaterThan(0);
    for (const s of next.sends) {
      expect(s).toEqual(
        expect.objectContaining({ kind: "boat", to: AGENT_ID, troops: tn / 5 }),
      );
    }
  });

  it("across a 3-tile river we are nearby: boats obey the land line", () => {
    const river: Spec = {
      width: 40,
      height: 20,
      seat: (x) => (x < 18 ? "nation" : x < 21 ? "water" : "us"),
    };
    const w = world(river);
    start(w);
    expect(w.nation.nearby()).toEqual([w.us]);
    expect(w.nation.sharesBorderWith(w.us)).toBe(false);
    const tn = nationAt80(w);
    const line = landLine(tn);
    w.us.setTroops(line + 1);
    expect(runWindow(w, WINDOW).sends).toEqual([]);
    w.us.setTroops(line);
    const atLine = firstSend(w, () =>
      predictSend(w, "boat", w.us, w.us.troops()),
    );
    // The cap binds, below troops/5.
    expect(atLine.predicted).toBe(tn - Math.ceil(line * RETAIN));
    expect(atLine.predicted!).toBeLessThan(tn / 5);
    expect(atLine.sends).toEqual([
      expect.objectContaining({
        kind: "boat",
        to: AGENT_ID,
        troops: atLine.predicted,
      }),
    ]);

    // Far below the line the boat carries troops/5, not the reserve surplus.
    const open = world(river);
    start(open);
    const tn2 = nationAt80(open);
    open.us.setTroops(Math.round(0.5 * tn2));
    const weak = firstSend(open, () =>
      predictSend(open, "boat", open.us, open.us.troops()),
    );
    expect(weak.predicted).toBe(tn2 / 5);
    expect(weak.sends).toEqual([
      expect.objectContaining({
        kind: "boat",
        to: AGENT_ID,
        troops: tn2 / 5,
      }),
    ]);
  });
});
