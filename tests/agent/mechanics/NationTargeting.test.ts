/**
 * Pins the target selection of the Impossible nation (roadmap H4,
 * docs/11-roadmap.md §11.3; the risk table asks for every mechanic an agent
 * relies on to be pinned by a scenario test against the real simulation).
 *
 * The claim under test ("NationTargeting"): the nation avoids nobody but
 * prefers `veryWeak` (< 15% of our cap?), `juicy` (<= 75% of its troops?)
 * and `victim` (incoming attacks > 50% of our troops?) players, and decides
 * every 30-50 ticks.
 *
 * VERDICT: PARTIAL. The three predicates are right but each has a second
 * condition; they are not the nation's first choices; "avoids nobody" holds
 * only for player type; the cadence is 30-49 ticks. The code is the spec
 * (AiAttackBehavior.ts unless named):
 *
 * - Cadence. NationExecution.tick (NationExecution.ts:109-229) runs the
 *   whole decision (alliances, MIRV, structures, warships, embargoes, then
 *   maybeAttack, then nukes; :218-228) only when ticks % attackRate ===
 *   attackTick (:200-216). attackRate = nextInt(30, 50) at Impossible
 *   (:102-103; Hard 45-59, Medium 55-69, Easy 65-99), and nextInt's max is
 *   exclusive (PseudoRandom.ts:60-65), so it is 30-49 ticks (3.0-4.9 s at
 *   100 ms a tick, Config.msPerTick). The offset attackTick = nextInt(0,
 *   attackRate) (:84), fixed for the game, as are the ratios trigger 50-59%,
 *   reserve 30-39%, expand 10-19% of the cap (:76-78), all from
 *   PseudoRandom(simpleHash(id) + simpleHash(gameID)) (:73-75). The first
 *   tick after spawn sends troops/2 at free land (:194-198, forceSendAttack
 *   :812-820). In a real Pangaea game no nation attack or boat was sent off
 *   its schedule (boat landings aside, TransportShipExecution.ts:271-283).
 * - Gates, in order (maybeAttack :98-157, attackBestTarget :278-304):
 *   (1) while it borders unowned, un-nuked land (or sees it across a
 *       <= 4-tile river, PlayerImpl.nearby) and that send succeeds, it
 *       attacks only free land (:135-141) -- even while attacked;
 *   (2) with a bordering enemy, 1 decision in 10 is a random boat that ends
 *       it (:147-151; with none, 1 in 5 and it goes on, :143-146); then
 *       alliance requests (:153);
 *   (3) a bordering tribe that owns a structure is attacked before the
 *       ratio checks (:285-287);
 *   (4) below reserveRatio x cap nothing -- not even retaliation (:290);
 *   (5) below triggerRatio x cap the list runs 1 decision in 10 (:293).
 * - The Impossible list (:426-428), first strategy that sends wins; a send
 *   refused by sizing (troopSendCap / the 20% floor, NationSendCap.test.ts)
 *   falls through to the next (:301-303). All predicates are on the
 *   bordering enemies (non-friendly nearby() players, tribes included)
 *   sorted by troops ascending (:103-133), "ours" meaning the target's:
 *    1 retaliate: the attacker of the largest single incoming attack that is
 *      not a tribe's or a friend's (findIncomingAttackPlayer :458-479),
 *      sent with force (:313-319);
 *    2 bots: every bordering tribe, structures first then lowest density, up
 *      to 100 (attackBots :484-520);
 *    3 veryWeak: troops < 0.15 x the TARGET's own maxTroops (strict) AND, in
 *      FFA, < 1.2 x the nation's troops (strict); the weakest such
 *      (findVeryWeakEnemy :655-666);
 *    4 betray: an ally it borders, if the juiciest ally and ally + bordering
 *      enemies (+ their outgoing attacks) < 0.33 x its troops, or a traitor
 *      ally < 1.2x, or its only bordering player with 3 x troops < its own
 *      (NationAllianceBehavior.maybeBetray :404-462, isSafeToBetray
 *      :473-491); sent with force;
 *    5 assist: a target of an ally (targets() lasts 100 ticks,
 *      PlayerImpl.ts:1010-1016) at relation >= Friendly (:540-567);
 *    6 victim: sum of ALL incoming attacks (any attacker, tribes and the
 *      nation itself included) > 0.5 x the target's troops (strict) AND, in
 *      FFA, target <= 1.2 x the nation's troops (findVictim :636-651);
 *    7 traitor: a traitor < 1.2x (strict) (findTraitor :570-581);
 *    8 juicy: troops <= 0.75 x the nation's (inclusive), then the JUICIEST,
 *      not the weakest: normalized structures (level-weighted; cities, ports,
 *      factories and SAMs count, defense posts and silos do not) +
 *      empty-cap share + tiles, a tie to the weaker
 *      (findJuicyTarget :669-674, findJuiciestTarget NationUtils.ts:52-104);
 *    9 afk: a disconnected enemy < 3x (strict) (:333-344);
 *   10 nuked: unowned fallout on its border (:349-354, :611-633);
 *   11 hated: its relations from the most hostile, relation < -50, not
 *      friendly, <= 3x in FFA, at ANY distance (by boat) (:369-378);
 *   12 weakest: the weakest bordering enemy if < 1x (strict) (:388-398);
 *   13 island: only with no bordering enemy, the nearest (bounding-box
 *      centres, Manhattan) reachable non-friendly player < 1x, 1 time in 3
 *      the second nearest (findNearestIslandEnemy :676-749);
 *   14 donate: team games only (:1168-1266).
 * - "Avoids nobody": shouldAttack never spares a human at Hard/Impossible
 *   (Medium 1 in 4, Easy 3 in 4) (:932-954), but every player-targeting
 *   strategy except retaliate, bots, betray and assist has the FFA strength
 *   guard above (isFFA :754-756), and friends are never targets except by
 *   betray.
 * - Each attack on an Impossible nation moves its relation to us by -100,
 *   clamped at -100 (AttackExecution.ts:188-210, updateRelation): from
 *   neutral that is Hostile (< -50, PlayerImpl.ts:946-957) for 1,001 ticks
 *   of decay (0.05 a tick, PlayerImpl.decayRelations
 *   :978-988, called by PlayerExecution.ts:57), so `hated` can pick us for
 *   ~100 s after the attack, wherever we are.
 * - Real game (Pangaea, 29 nations, 400 tribes, 3 minutes): of 1,329
 *   decisions 756 reached the list; the strategies that attacked: bots 273,
 *   retaliate 88, juicy 56 (+1 on our idle seat), victim 28, hated 12,
 *   weakest 9, veryWeak 1, island 1.
 *
 * Setting: the real Config class as createGameRunner builds it
 * (GameRunner.ts:46: new Config(gameConfig, null, false)), not TestConfig
 * (tests/util/TestConfig.ts overrides attackLogic, immunity and more), FFA,
 * Singleplayer, Impossible, 400 tribes; the game built as setup() builds it
 * (createGame, endSpawnPhase) on maps synthesized in memory, all plains,
 * every land tile owned unless a test frees it; the real NationExecution,
 * seeded as in a game. No PlayerExecution runs in those worlds, so troops,
 * gold and relations stay where the test puts them (no income, no decay, no
 * structures); the test sets troops only before a decision. Incoming
 * attacks are mostly "phantoms": the Attack object AttackExecution.init
 * creates (PlayerImpl.createAttack), without its execution, so it holds
 * still. Where the nation is shown deciding, it is a real decision tick;
 * finders and closures are also called directly (private members, read
 * through casts) to pin exact thresholds. The last block runs a real game
 * as the arena builds it (createGameRunner, NodeMapLoader). Every send is
 * recorded as it is constructed, i.e. the decision, before
 * AttackExecution.init adjusts it.
 */
import path from "path";
import {
  arenaGameStart,
  seatClientID,
  type ArenaGameSpec,
} from "../../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../../src/agent/arena/NodeMapLoader";
import { Config } from "../../../src/core/configuration/Config";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { NationExecution } from "../../../src/core/execution/NationExecution";
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
  Relation,
  TerraNullius,
  UnitType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl, TileRef } from "../../../src/core/game/GameMap";
import { createGameRunner } from "../../../src/core/GameRunner";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import { GameConfig, Intent, IntentSchema } from "../../../src/core/Schemas";
import { simpleHash } from "../../../src/core/Util";

const GAME_ID = "nation-targeting";
const MAPS = path.join(__dirname, "../../../resources/maps");
const NATION_ID = "NATION01";

/** The arena's setting (Arena.ts / ArenaGame.arenaGameStart). */
function gameConfig(difficulty = Difficulty.Impossible): GameConfig {
  return {
    gameMap: GameMapType.Asia,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer,
    difficulty,
    nations: "default",
    donateGold: false,
    donateTroops: false,
    bots: 400,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
  };
}

// Terrain bytes (GameMap.ts: bit 7 land, bit 6 shoreline, bit 5 ocean,
// bits 0-4 magnitude; land magnitude < 10 is Plains).
const LAND = 0x80 | 5;
const OCEAN = 0x20;
const SHORELINE = 0x40;

/** Everyone but the nation under test. */
type MemberType = PlayerType.Human | PlayerType.Bot | PlayerType.Nation;

interface Spec {
  width: number;
  height: number;
  /** Other players, by key. */
  members: Record<string, MemberType>;
  /** A member key, "nation", "free" (unowned land) or "water". */
  seat: (x: number, y: number) => string;
  difficulty?: Difficulty;
}

/** AiAttackBehavior's private members, called by the test. */
interface Behavior {
  maybeAttack(): void;
  attackBestTarget(friends: Player[], enemies: Player[]): void;
  getAttackStrategies(
    friends: Player[],
    enemies: Player[],
  ): Array<() => boolean>;
  sendAttack(target: Player | TerraNullius, force?: boolean): boolean;
  shouldAttack(target: Player | TerraNullius): boolean;
  findIncomingAttackPlayer(): Player | null;
  findVeryWeakEnemy(enemies: Player[]): Player | null;
  findVictim(enemies: Player[]): Player | null;
  findJuicyTarget(enemies: Player[]): Player | null;
  findTraitor(enemies: Player[]): Player | null;
  findNearestIslandEnemy(): Player | null;
  maybeBetrayAndAttack(friends: Player[], enemies: Player[]): boolean;
  troopSendCap(): number;
}

/** NationExecution's private state, read (never written) by the test. */
interface NationInternals {
  attackRate: number;
  attackTick: number;
  triggerRatio: number;
  reserveRatio: number;
  expandRatio: number;
  behaviorsInitialized: boolean;
  attackBehavior: Behavior;
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
  nation: Player;
  /** The other players, by member key. */
  p: Record<string, Player>;
  exec: NationExecution;
  n: NationInternals;
  sent: Sent[];
  executor: Executor;
}

const idOf = (key: string) => `ID_${key}`.padEnd(8, "0");
const clientOf = (key: string) => `CL_${key}`.padEnd(8, "0");

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

/**
 * A game built the way tests/util/Setup.ts builds one (createGame, then
 * endSpawnPhase), but with the real Config class the arena uses
 * (GameRunner.ts:46: new Config(gameConfig, null, false)), not TestConfig.
 * The NationExecution is the real one, seeded as in a game (gameID + id).
 */
function world(spec: Spec): World {
  const { map, mini } = terrain(spec);
  const config = new Config(
    gameConfig(spec.difficulty ?? Difficulty.Impossible),
    null,
    false,
  );
  const humans: PlayerInfo[] = [];
  const nationObj = new Nation(
    new Cell(0, 0),
    new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
  );
  const nations = [nationObj];
  for (const [key, type] of Object.entries(spec.members)) {
    if (type === PlayerType.Human) {
      humans.push(
        new PlayerInfo(key, PlayerType.Human, clientOf(key), idOf(key)),
      );
    } else if (type === PlayerType.Nation) {
      // A nation with no NationExecution: a passive rival.
      nations.push(
        new Nation(
          new Cell(0, 0),
          new PlayerInfo(key, PlayerType.Nation, null, idOf(key)),
        ),
      );
    }
  }
  const game = createGame(humans, nations, map, mini, config);
  for (const [key, type] of Object.entries(spec.members)) {
    if (type === PlayerType.Bot) {
      game.addPlayer(new PlayerInfo(key, PlayerType.Bot, null, idOf(key)));
    }
  }
  game.endSpawnPhase();
  const nation = game.player(NATION_ID);
  const p: Record<string, Player> = {};
  for (const key of Object.keys(spec.members)) p[key] = game.player(idOf(key));
  for (let y = 0; y < spec.height; y++) {
    for (let x = 0; x < spec.width; x++) {
      const s = spec.seat(x, y);
      const tile = game.ref(x, y);
      if (s === "nation") nation.conquer(tile);
      else if (s in p) p[s].conquer(tile);
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
    nation,
    p,
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
 * attackTick; NationExecution.ts:81-91, GameImpl.executeNextTick inits new
 * executions at the end of a tick), then the behaviours and the opening
 * troops/2 at free land (NationExecution.ts:194-198), then one more tick in
 * which that attack, with no free land, retreats. `idle` ticks run first.
 */
function start(w: World, idle = 0): Behavior {
  tick(w, idle);
  w.game.addExecution(w.exec);
  tick(w, 2);
  expect(w.n.behaviorsInitialized).toBe(true);
  tick(w);
  return w.n.attackBehavior;
}

function isDecisionTick(w: World): boolean {
  return w.game.ticks() % w.n.attackRate === w.n.attackTick;
}

/** Runs ticks until the next tick to run is a decision tick. */
function toDecision(w: World): void {
  while (!isDecisionTick(w)) tick(w);
}

function nationSends(w: World, since = 0): Sent[] {
  return w.sent.slice(since).filter((s) => s.from === NATION_ID);
}

/**
 * Runs decisions (with `hold` before each) until one sends something; a
 * decision can pass with nothing when maybeAttack's 1-in-10 random-boat
 * branch returns early (AiAttackBehavior.ts:148-151). Returns the sends and
 * the nation's sendAttack calls of that decision, in order.
 */
function firstSend(
  w: World,
  hold: () => void = () => {},
  maxDecisions = 6,
): {
  sends: Sent[];
  attempts: (Player | TerraNullius)[];
  decisions: number;
} {
  const b = w.n.attackBehavior;
  const spy = vi.spyOn(b, "sendAttack");
  try {
    for (let d = 1; d <= maxDecisions; d++) {
      toDecision(w);
      hold();
      spy.mockClear();
      const i = w.sent.length;
      tick(w);
      const sends = nationSends(w, i);
      if (sends.length > 0) {
        return {
          sends,
          attempts: spy.mock.calls.map((c) => c[0]),
          decisions: d,
        };
      }
    }
  } finally {
    spy.mockRestore();
  }
  throw new Error(`no send in ${maxDecisions} decisions`);
}

/** A phantom attack: the Attack object AttackExecution.init creates, alone. */
function phantomAttack(
  from: Player,
  to: Player,
  troops: number,
): { setTroops(t: number): void; delete(): void } {
  return from.createAttack(to, troops, null, new Set<TileRef>());
}

describe("H4 NationTargeting: when a nation decides", () => {
  it("attackRate is drawn per nation in [30, 49] ticks at Impossible (nextInt's max is exclusive), the offset in [0, attackRate); slower on easier levels", () => {
    const ranges: Record<string, [number, number]> = {};
    for (const difficulty of [
      Difficulty.Easy,
      Difficulty.Medium,
      Difficulty.Hard,
      Difficulty.Impossible,
    ]) {
      const w = world({
        width: 10,
        height: 10,
        members: {},
        seat: () => "nation",
        difficulty,
      });
      let lo = Infinity;
      let hi = -Infinity;
      const ratios = {
        trigger: new Set(),
        reserve: new Set(),
        expand: new Set(),
      };
      for (let g = 0; g < 1500; g++) {
        const exec = new NationExecution(
          `game-${g}`,
          new Nation(
            undefined,
            new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
          ),
        );
        exec.init(w.game);
        const n = exec as unknown as NationInternals;
        lo = Math.min(lo, n.attackRate);
        hi = Math.max(hi, n.attackRate);
        expect(n.attackTick).toBeGreaterThanOrEqual(0);
        expect(n.attackTick).toBeLessThan(n.attackRate);
        expect(Number.isInteger(n.attackTick)).toBe(true);
        ratios.trigger.add(n.triggerRatio);
        ratios.reserve.add(n.reserveRatio);
        ratios.expand.add(n.expandRatio);
        if (difficulty === Difficulty.Impossible && g < 50) {
          // The draws of the constructor (NationExecution.ts:73-78) and init
          // (:83-84, :102-103), in order, from PseudoRandom(hash(id) +
          // hash(gameID)): anyone who knows both can replay the schedule.
          const r = new PseudoRandom(
            simpleHash(NATION_ID) + simpleHash(`game-${g}`),
          );
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
      }
      ranges[difficulty] = [lo, hi];
      const sorted = (s: Set<unknown>) => [...(s as Set<number>)].sort();
      expect(sorted(ratios.trigger)).toEqual(
        Array.from({ length: 10 }, (_, i) => (50 + i) / 100),
      );
      expect(sorted(ratios.reserve)).toEqual(
        Array.from({ length: 10 }, (_, i) => (30 + i) / 100),
      );
      expect(sorted(ratios.expand)).toEqual(
        Array.from({ length: 10 }, (_, i) => (10 + i) / 100),
      );
    }
    // NationExecution.getAttackRate (:93-107).
    expect(ranges).toEqual({
      [Difficulty.Easy]: [65, 99],
      [Difficulty.Medium]: [55, 69],
      [Difficulty.Hard]: [45, 59],
      [Difficulty.Impossible]: [30, 49],
    });
  });
});

describe("H4 NationTargeting: the live schedule", () => {
  it("a live nation runs maybeAttack exactly when ticks % attackRate === attackTick and sends nothing in between; its opening send is troops/2 at free land", () => {
    // Nation: an 8x8 block in a field of free land.
    const w = world({
      width: 120,
      height: 60,
      members: {},
      seat: (x, y) => (x < 8 && y < 8 ? "nation" : "free"),
    });
    const startTroops = w.nation.troops();
    expect(startTroops).toBe(
      w.config.startManpower(
        new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
      ),
    );
    const b = start(w);
    const opening = nationSends(w);
    expect(opening).toEqual([
      expect.objectContaining({
        kind: "land",
        to: null,
        troops: startTroops / 2,
      }),
    ]);

    const calls: number[] = [];
    const orig = b.maybeAttack.bind(b);
    vi.spyOn(b, "maybeAttack").mockImplementation(() => {
      calls.push(w.game.ticks());
      orig();
    });
    const since = w.sent.length;
    const rate = w.n.attackRate;
    const span = 20 * rate;
    const first = w.game.ticks();
    for (let t = 0; t < span; t++) {
      // Top the nation up to 1% of its cap above its expand ratio before
      // each decision, so that each one sends a little to free land.
      if (isDecisionTick(w)) {
        w.nation.setTroops(
          Math.ceil((w.n.expandRatio + 0.01) * w.config.maxTroops(w.nation)),
        );
      }
      tick(w);
    }
    expect(calls.length).toBe(20);
    for (const c of calls) {
      expect(c % rate).toBe(w.n.attackTick);
      expect(c).toBeGreaterThanOrEqual(first);
    }
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i] - calls[i - 1]).toBe(rate);
    }
    const sends = nationSends(w, since);
    expect(sends.length).toBe(20);
    for (const s of sends) expect(calls).toContain(s.tick);
  });
});

describe("H4 NationTargeting: the gates in front of the list", () => {
  /**
   * Calls maybeAttack directly `n` times (no ticks run, so nothing it queues
   * executes and the state stays put) with the strategy list stubbed empty;
   * returns the fraction of calls that reached attackBestTarget and the
   * strategy list.
   */
  function sample(
    w: World,
    b: Behavior,
    n: number,
  ): { best: number; list: number } {
    const best = vi.spyOn(b, "attackBestTarget");
    const list = vi.spyOn(b, "getAttackStrategies").mockReturnValue([]);
    for (let i = 0; i < n; i++) b.maybeAttack();
    const out = {
      best: best.mock.calls.length / n,
      list: list.mock.calls.length / n,
    };
    best.mockRestore();
    list.mockRestore();
    return out;
  }

  it("with a bordering enemy 1 decision in 10 is a random boat that ends it; below reserve no strategy runs, between reserve and trigger 1 in 10, from the trigger all", () => {
    const w = world({
      width: 40,
      height: 20,
      members: { e: PlayerType.Human },
      seat: (x) => (x < 20 ? "nation" : "e"),
    });
    const b = start(w);
    const cap = w.config.maxTroops(w.nation);
    const { reserveRatio: reserve, triggerRatio: trigger } = w.n;
    w.p.e.setTroops(10_000);
    const at = (ratio: number) => {
      w.nation.setTroops(Math.ceil(ratio * cap));
      return sample(w, b, 3000);
    };
    // 1% of the cap under the reserve, halfway to the trigger, at the trigger
    // (hasReserveRatioTroops / hasTriggerRatioTroops :446-456 are >=).
    const belowReserve = at(reserve - 0.01);
    const between = at((reserve + trigger) / 2);
    const atTrigger = at(trigger);
    // AiAttackBehavior.ts:148-151: chance(10) -> random boat and return.
    for (const s of [belowReserve, between, atTrigger]) {
      expect(s.best).toBeGreaterThan(0.87);
      expect(s.best).toBeLessThan(0.93);
    }
    // :290 and :293.
    expect(belowReserve.list).toBe(0);
    expect(between.list / between.best).toBeGreaterThan(0.07);
    expect(between.list / between.best).toBeLessThan(0.13);
    expect(atTrigger.list).toBe(atTrigger.best);
  });

  it("with no bordering enemy the random boat (1 in 5) does not end the decision", () => {
    const w = world({
      width: 20,
      height: 20,
      members: {},
      seat: () => "nation",
    });
    const b = start(w);
    w.nation.setTroops(w.config.maxTroops(w.nation));
    const s = sample(w, b, 1000);
    expect(s.best).toBe(1);
    expect(s.list).toBe(1);
  });

  it("below its reserve a nation under attack does not retaliate; above its trigger it does at the first decision that reaches the list", () => {
    const w = world({
      width: 40,
      height: 20,
      members: { r: PlayerType.Human },
      seat: (x) => (x < 20 ? "nation" : "r"),
    });
    start(w);
    const cap = w.config.maxTroops(w.nation);
    w.p.r.setTroops(50_000);
    const attack = phantomAttack(w.p.r, w.nation, 20_000);
    // Just below the reserve: 20 decisions, nothing at all.
    const since = w.sent.length;
    for (let d = 0; d < 20; d++) {
      toDecision(w);
      w.nation.setTroops(Math.ceil(w.n.reserveRatio * cap) - 1);
      tick(w);
    }
    expect(nationSends(w, since)).toEqual([]);
    // Above the trigger: it answers.
    const got = firstSend(w, () => {
      w.nation.setTroops(Math.ceil(w.n.triggerRatio * cap) + 1);
      attack.setTroops(20_000);
    });
    expect(got.attempts[0]).toBe(w.p.r);
    expect(got.sends).toEqual([
      expect.objectContaining({ kind: "land", to: w.p.r.id() }),
    ]);
  });
});

describe("H4 NationTargeting: a tribe holding a structure jumps the gates", () => {
  it("below its reserve a nation still attacks a bordering tribe that owns a structure, sized from its expand ratio; without the structure it does nothing", () => {
    const sendsBelowReserve = (withStructure: boolean) => {
      const w = world({
        width: 40,
        height: 20,
        members: { t: PlayerType.Bot },
        seat: (x) => (x < 20 ? "nation" : "t"),
      });
      const b = start(w);
      const t = w.p.t;
      if (withStructure) {
        t.buildUnit(UnitType.DefensePost, Array.from(t.tiles())[0], {});
      }
      t.setTroops(1_000);
      const cap = w.config.maxTroops(w.nation);
      w.nation.setTroops(
        Math.ceil(((w.n.expandRatio + w.n.reserveRatio) / 2) * cap),
      );
      const i = w.sent.length;
      b.attackBestTarget([], [t]);
      return nationSends(w, i);
    };
    // hasNeighboringBotWithStructures -> attackBots before :290
    // (AiAttackBehavior.ts:285-287); calculateAttackTroops uses expandRatio
    // for such a tribe (:1046-1053) and 4x its troops (:1149-1166).
    expect(sendsBelowReserve(true)).toEqual([
      expect.objectContaining({ kind: "land", to: idOf("t"), troops: 4_000 }),
    ]);
    expect(sendsBelowReserve(false)).toEqual([]);
  });
});

describe("H4 NationTargeting: the strategy list", () => {
  it("getAttackStrategies returns, in order, for each difficulty (AiAttackBehavior.ts:412-431)", () => {
    const names: Record<string, string[]> = {};
    for (const difficulty of [
      Difficulty.Easy,
      Difficulty.Medium,
      Difficulty.Hard,
      Difficulty.Impossible,
    ]) {
      const w = world({
        width: 10,
        height: 10,
        members: {},
        seat: () => "nation",
        difficulty,
      });
      const b = start(w);
      names[difficulty] = b.getAttackStrategies([], []).map((f) => f.name);
    }
    expect(names[Difficulty.Impossible]).toEqual([
      "retaliate",
      "bots",
      "veryWeak",
      "betray",
      "assist",
      "victim",
      "traitor",
      "juicy",
      "afk",
      "nuked",
      "hated",
      "weakest",
      "island",
      "donate",
    ]);
    expect(names[Difficulty.Hard]).toEqual([
      "bots",
      "retaliate",
      "assist",
      "betray",
      "nuked",
      "traitor",
      "afk",
      "hated",
      "veryWeak",
      "juicy",
      "victim",
      "weakest",
      "island",
      "donate",
    ]);
    expect(names[Difficulty.Medium]).toEqual([
      "bots",
      "nuked",
      "retaliate",
      "assist",
      "betray",
      "hated",
      "afk",
      "traitor",
      "weakest",
      "island",
      "donate",
    ]);
    expect(names[Difficulty.Easy]).toEqual([
      "nuked",
      "bots",
      "retaliate",
      "assist",
      "betray",
      "hated",
      "weakest",
    ]);
  });

  it("when nothing matches, one decision consults every finder in that order; island only when no enemy borders", () => {
    // Nation | a stronger human: every predicate fails.
    const w = world({
      width: 40,
      height: 20,
      members: { e: PlayerType.Human },
      seat: (x) => (x < 20 ? "nation" : "e"),
    });
    const b = start(w);
    const tn = Math.ceil(0.8 * w.config.maxTroops(w.nation));
    w.nation.setTroops(tn);
    w.p.e.setTroops(3 * tn + 1);
    const log: string[] = [];
    const methods = [
      "findIncomingAttackPlayer",
      "attackBots",
      "findVeryWeakEnemy",
      "maybeBetrayAndAttack",
      "assistAllies",
      "findVictim",
      "findTraitor",
      "findJuicyTarget",
      "isBorderingNukedTerritory",
      "findNearestIslandEnemy",
      "donateTroops",
    ];
    const target = b as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of methods) {
      const orig = target[m].bind(b);
      vi.spyOn(target, m).mockImplementation((...a: unknown[]) => {
        log.push(m);
        return orig(...a);
      });
    }
    const origRel = w.nation.allRelationsSorted.bind(w.nation);
    vi.spyOn(w.nation, "allRelationsSorted").mockImplementation(() => {
      log.push("allRelationsSorted (hated)");
      return origRel();
    });
    const send = vi.spyOn(b, "sendAttack");

    b.attackBestTarget([], [w.p.e]);
    expect(log).toEqual([
      "findIncomingAttackPlayer",
      "attackBots",
      "findVeryWeakEnemy",
      "maybeBetrayAndAttack",
      "assistAllies",
      "findVictim",
      "findTraitor",
      "findJuicyTarget",
      "isBorderingNukedTerritory",
      "allRelationsSorted (hated)",
      "donateTroops",
    ]);
    expect(send).not.toHaveBeenCalled();

    log.length = 0;
    b.attackBestTarget([], []);
    expect(log).toEqual([
      "findIncomingAttackPlayer",
      "attackBots",
      "findVeryWeakEnemy",
      "maybeBetrayAndAttack",
      "assistAllies",
      "findVictim",
      "findTraitor",
      "findJuicyTarget",
      "isBorderingNukedTerritory",
      "allRelationsSorted (hated)",
      "findNearestIslandEnemy",
      "donateTroops",
    ]);
    expect(send).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

/**
 * Wraps the nation's strategy list so that every decision logs the name of
 * the strategy that returned true (the one that attacked), if any.
 */
function logFiredStrategies(b: Behavior): string[] {
  const fired: string[] = [];
  const orig = b.getAttackStrategies.bind(b);
  vi.spyOn(b, "getAttackStrategies").mockImplementation((f, e) =>
    orig(f, e).map((s) => {
      const wrapped = () => {
        const r = s();
        if (r) fired.push(s.name);
        return r;
      };
      Object.defineProperty(wrapped, "name", { value: s.name });
      return wrapped;
    }),
  );
  return fired;
}

describe("H4 NationTargeting: the order, rung by rung", () => {
  // The nation owns the left half (x < 24); each rung is a 24x6 band on the
  // right, bordering it. Highest priority first; `fl` is free land.
  const RUNGS = [
    ["r", "retaliate"],
    ["tb", "bots"],
    ["vw", "veryWeak"],
    ["b", "betray"],
    ["a", "assist"],
    ["vc", "victim"],
    ["tr", "traitor"],
    ["jc", "juicy"],
    ["ak", "afk"],
    ["nk", "nuked"],
    ["hs", "hated"],
    ["wk", "weakest"],
    ["fl", "(free land, before the list)"],
  ] as const;
  const BAND = 6;
  const W = 48;
  const HALF = 24;
  const MEMBERS: Record<string, MemberType> = {
    r: PlayerType.Human,
    tb: PlayerType.Bot,
    vw: PlayerType.Human,
    b: PlayerType.Human,
    a: PlayerType.Human,
    vc: PlayerType.Human,
    x: PlayerType.Human, // the victim's attacker: one tile inside vc's band
    tr: PlayerType.Human,
    jc: PlayerType.Human,
    ak: PlayerType.Human,
    hs: PlayerType.Human,
    wk: PlayerType.Human,
  };
  const bandOf = (key: string) => RUNGS.findIndex(([k]) => k === key);

  function ladder(present: Set<string>) {
    const vcBand = bandOf("vc") * BAND;
    const w = world({
      width: W,
      height: RUNGS.length * BAND,
      members: MEMBERS,
      seat: (x, y) => {
        if (x < HALF) return "nation";
        const key = RUNGS[Math.floor(y / BAND)][0];
        if (!present.has(key) || key === "nk" || key === "fl") return "nation";
        if (key === "vc" && x === W - 1 && y === vcBand + 3) return "x";
        return key;
      },
    });
    const b = start(w);
    const p = w.p;
    const g = w.game;
    // After the opening send has retreated: nuked land and free land.
    for (const key of ["nk", "fl"]) {
      if (!present.has(key)) continue;
      for (let y = bandOf(key) * BAND; y < (bandOf(key) + 1) * BAND; y++) {
        for (let x = HALF; x < W; x++) {
          w.nation.relinquish(g.ref(x, y));
          if (key === "nk") g.setFallout(g.ref(x, y), true);
        }
      }
    }
    if (present.has("a")) {
      w.nation.createAllianceRequest(p.a)!.accept();
      w.nation.updateRelation(p.a, 100);
    }
    if (present.has("b")) w.nation.createAllianceRequest(p.b)!.accept();
    if (present.has("ak")) p.ak.markDisconnected(true);
    if (present.has("hs")) w.nation.updateRelation(p.hs, -100);
    const onVc = present.has("vc") ? phantomAttack(p.x, p.vc, 1) : null;
    const onUs = present.has("r") ? phantomAttack(p.r, w.nation, 1) : null;

    const hold = () => {
      const tn = Math.round(0.8 * w.config.maxTroops(w.nation));
      w.nation.setTroops(tn);
      const strong = Math.round(0.8 * tn);
      for (const key of ["r", "b", "a", "vc", "tr", "ak", "hs", "wk"]) {
        if (present.has(key)) p[key].setTroops(strong);
      }
      if (present.has("jc")) p.jc.setTroops(Math.round(0.5 * tn));
      if (present.has("vw")) {
        p.vw.setTroops(Math.floor(0.1 * w.config.maxTroops(p.vw)));
      }
      if (present.has("tb")) p.tb.setTroops(10_000);
      if (present.has("tr")) p.tr.markTraitor();
      if (present.has("b")) p.b.markTraitor();
      if (present.has("a")) p.a.target(p.wk);
      onVc?.setTroops(Math.floor(strong / 2) + 1);
      onUs?.setTroops(Math.round(0.3 * tn));
    };
    return { w, b, hold };
  }

  /**
   * The rungs whose predicate holds right now, each checked with the
   * nation's own finder (or the inline strategy's condition) on the bordering
   * enemies sorted as maybeAttack sorts them (:103-133).
   */
  function liveRungs(w: World, b: Behavior): string[] {
    const tn = w.nation.troops();
    const p = w.p;
    const enemies = w.nation
      .nearby()
      .filter((o): o is Player => o.isPlayer() && !w.nation.isFriendly(o))
      .sort((x, y) => x.troops() - y.troops());
    const live: string[] = [];
    if (b.findIncomingAttackPlayer() === p.r) live.push("r");
    if (enemies.some((e) => e.type() === PlayerType.Bot)) live.push("tb");
    if (b.findVeryWeakEnemy(enemies) === p.vw) live.push("vw");
    if (
      w.nation.isAlliedWith(p.b) &&
      p.b.isTraitor() &&
      p.b.troops() < 1.2 * tn
    ) {
      live.push("b");
    }
    if (
      w.nation.isAlliedWith(p.a) &&
      w.nation.relation(p.a) >= Relation.Friendly &&
      p.a.targets().includes(p.wk)
    ) {
      live.push("a");
    }
    if (b.findVictim(enemies) === p.vc) live.push("vc");
    if (b.findTraitor(enemies) === p.tr) live.push("tr");
    if (b.findJuicyTarget(enemies) !== null) live.push("jc");
    if (
      enemies.find((e) => e.isDisconnected() && e.troops() < 3 * tn) === p.ak
    ) {
      live.push("ak");
    }
    const nukedBorder = (
      b as unknown as { isBorderingNukedTerritory(): boolean }
    ).isBorderingNukedTerritory();
    if (nukedBorder) live.push("nk");
    if (
      w.nation.relation(p.hs) === Relation.Hostile &&
      p.hs.troops() <= 3 * tn
    ) {
      live.push("hs");
    }
    if (enemies.length > 0 && enemies[0].troops() < tn) live.push("wk");
    return live;
  }

  const expectedTarget = (w: World, key: string): Player | TerraNullius => {
    if (key === "nk" || key === "fl") return w.game.terraNullius();
    if (key === "a") return w.p.wk; // assist attacks the ally's target
    return w.p[key];
  };

  for (let i = RUNGS.length - 1; i >= 0; i--) {
    const [key, strategy] = RUNGS[i];
    const rungs = key === "fl" ? RUNGS.slice(0, -1) : RUNGS.slice(i + 1, -1);
    const lower = rungs.map(([, name]) => name).join(", ");
    it(`${strategy} beats ${lower === "" ? "nothing (last resort)" : lower}`, () => {
      const present = new Set<string>(
        key === "fl"
          ? RUNGS.map(([k]) => k)
          : RUNGS.slice(i, -1).map(([k]) => k),
      );
      const { w, b, hold } = ladder(present);
      const fired = logFiredStrategies(b);
      let live: string[] = [];
      const got = firstSend(w, () => {
        hold();
        live = liveRungs(w, b);
      });
      // Every rung in this world was live at the decision.
      expect(live).toEqual(
        RUNGS.map(([k]) => k).filter((k) => present.has(k) && k !== "fl"),
      );
      const target = expectedTarget(w, key);
      expect(got.attempts[0]).toBe(target);
      const to = target.isPlayer() ? target.id() : null;
      expect(got.sends.length).toBeGreaterThan(0);
      for (const s of got.sends) expect(s.to).toBe(to);
      expect(fired).toEqual(key === "fl" ? [] : [strategy]);
      vi.restoreAllMocks();
    });
  }
});

/**
 * The nation owns the left half (x < 20) of a 40-wide map; each member a
 * 20x5 band on the right, bordering it, in the order given; `far` members
 * get a 5x5 block at the right edge of the last band's row, not bordering
 * the nation.
 */
function fan(
  members: Record<string, MemberType>,
  far: Record<string, MemberType> = {},
): { w: World; b: Behavior } {
  const keys = Object.keys(members);
  const farKeys = Object.keys(far);
  const w = world({
    width: 40 + 10 * farKeys.length,
    height: 5 * Math.max(1, keys.length),
    members: { ...members, ...far },
    seat: (x, y) => {
      if (x >= 40) {
        const f = Math.floor((x - 40) / 10);
        return x - 40 - 10 * f >= 5 && y < 5 ? farKeys[f] : "water";
      }
      if (x < 20 || keys.length === 0) return "nation";
      return keys[Math.floor(y / 5)];
    },
  });
  const b = start(w);
  return { w, b };
}

/** Smallest integer in [lo, hi] at which `pred` turns true (it must be monotone). */
function firstTrue(lo: number, hi: number, pred: (v: number) => boolean) {
  expect(pred(hi)).toBe(true);
  expect(pred(lo)).toBe(false);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (pred(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

describe("H4 NationTargeting: the predicates", () => {
  it("veryWeak: troops < 15% of the TARGET's own cap (strict) and < 1.2x the nation's troops (strict); the weakest such enemy first", () => {
    const { w, b } = fan({ e: PlayerType.Human, f: PlayerType.Human });
    const { e, f } = w.p;
    const capE = w.config.maxTroops(e);
    w.nation.setTroops(10_000_000);
    // The line on the target's own cap (findVeryWeakEnemy :655-666).
    const notWeak = firstTrue(0, capE, (t) => {
      e.setTroops(t);
      return b.findVeryWeakEnemy([e]) === null;
    });
    expect(notWeak / capE).toBeCloseTo(0.15, 4);
    expect(notWeak).toBe(Math.ceil(capE * 0.15));
    // It is the target's cap, not the nation's (a nation's cap is 1.25x a
    // human's at equal tiles, Config.maxTroops :1024-1055, and it has more).
    expect(notWeak).toBeLessThan(0.15 * w.config.maxTroops(w.nation));

    // The FFA guard: very weak only while < 1.2x the nation's troops.
    e.setTroops(1_000);
    const need = firstTrue(0, 1_000, (tn) => {
      w.nation.setTroops(tn);
      return b.findVeryWeakEnemy([e]) === e;
    });
    expect(need).toBe(834); // 833 x 1.2 = 999.6 < 1,000 < 834 x 1.2
    // Of two very weak enemies the first of the troop-sorted list, i.e. the
    // one with fewer troops (maybeAttack sorts ascending, :125-127).
    w.nation.setTroops(100_000);
    e.setTroops(3_000);
    f.setTroops(2_000);
    expect(b.findVeryWeakEnemy([f, e])).toBe(f);
  });

  it("victim: incoming attacks (anyone's, the nation's own and tribes' included) > 50% of the target's troops (strict), target <= 1.2x the nation's troops", () => {
    const { w, b } = fan(
      { e: PlayerType.Human, t: PlayerType.Bot },
      { x: PlayerType.Human, y: PlayerType.Human },
    );
    const { e, t, x, y } = w.p;
    e.setTroops(100_000);
    w.nation.setTroops(100_000);
    const a1 = phantomAttack(x, e, 50_000);
    expect(b.findVictim([e])).toBeNull(); // 50,000 is not > 50,000
    a1.setTroops(50_001);
    expect(b.findVictim([e])).toBe(e);
    // A sum over attackers: two halves.
    a1.setTroops(25_000);
    const a2 = phantomAttack(y, e, 25_000);
    expect(b.findVictim([e])).toBeNull();
    a2.setTroops(25_001);
    expect(b.findVictim([e])).toBe(e);
    a1.delete();
    a2.delete();
    // A tribe's attack counts, and so does the nation's own.
    const byTribe = phantomAttack(t, e, 50_001);
    expect(b.findVictim([e])).toBe(e);
    byTribe.delete();
    expect(b.findVictim([e])).toBeNull();
    const own = phantomAttack(w.nation, e, 50_001);
    expect(b.findVictim([e])).toBe(e);
    // The FFA guard: e may have up to 1.2x the nation's troops (inclusive).
    own.setTroops(60_001);
    e.setTroops(120_000);
    w.nation.setTroops(100_000);
    expect(b.findVictim([e])).toBe(e);
    w.nation.setTroops(99_999);
    expect(b.findVictim([e])).toBeNull();
  });

  it("juicy: troops <= 75% of the nation's (inclusive); then the juiciest, not the weakest: structures (not defense posts or silos) + empty-cap share + tiles, each normalized", () => {
    const { w, b } = fan({
      s: PlayerType.Human,
      g1: PlayerType.Human,
      g2: PlayerType.Human,
      g3: PlayerType.Human,
    });
    const { s, g1, g2, g3 } = w.p;
    w.nation.setTroops(100_000);
    s.setTroops(75_000);
    expect(b.findJuicyTarget([s])).toBe(s);
    s.setTroops(75_001);
    expect(b.findJuicyTarget([s])).toBeNull();

    // g1..g3 are one band each (100 tiles); give g1 a second band's worth
    // by conquering s. A bigger, emptier player beats a weaker, smaller one.
    for (const tile of Array.from(s.tiles())) g1.conquer(tile);
    expect(g1.numTilesOwned()).toBe(2 * g2.numTilesOwned());
    const gap = (p: Player) => 1 - p.troops() / w.config.maxTroops(p);
    g2.setTroops(20_000);
    g1.setTroops(22_000);
    expect(gap(g1)).toBeGreaterThan(gap(g2));
    expect(b.findJuicyTarget([g2, g1])).toBe(g1); // 2 points to 0
    // With less empty cap than g2 each has one point: a tie keeps the first
    // of the troop-sorted list, the weaker.
    g1.setTroops(30_000);
    expect(gap(g1)).toBeLessThan(gap(g2));
    expect(b.findJuicyTarget([g2, g1])).toBe(g2);

    // Equal troops and tiles: a factory makes g3 juicier; a defense post and
    // a silo do not (findJuiciestTarget, NationUtils.ts:52-103), so the list
    // order decides.
    g2.setTroops(20_000);
    g3.setTroops(20_000);
    const at = (p: Player) => Array.from(p.tiles())[0];
    g3.buildUnit(UnitType.DefensePost, at(g3), {});
    g3.buildUnit(UnitType.MissileSilo, Array.from(g3.tiles())[5], {});
    expect(b.findJuicyTarget([g2, g3])).toBe(g2);
    expect(b.findJuicyTarget([g3, g2])).toBe(g3);
    g3.buildUnit(UnitType.Factory, Array.from(g3.tiles())[10], {});
    expect(b.findJuicyTarget([g2, g3])).toBe(g3);
    expect(b.findJuicyTarget([g3, g2])).toBe(g3);
  });

  it("traitor < 1.2x (strict), afk < 3x (strict), hated <= 3x and at any distance, weakest < 1x (strict) of the nation's troops", () => {
    const { w, b } = fan(
      { e: PlayerType.Human },
      { h1: PlayerType.Human, h2: PlayerType.Human },
    );
    const { e, h1, h2 } = w.p;
    const send = vi.spyOn(b, "sendAttack").mockReturnValue(false);
    const run = (name: string): Player | TerraNullius | null => {
      send.mockClear();
      const s = b.getAttackStrategies([], [e]).find((f) => f.name === name)!;
      s();
      return send.mock.calls.length > 0 ? send.mock.calls[0][0] : null;
    };
    w.nation.setTroops(100_000);

    e.markTraitor();
    e.setTroops(120_000);
    expect(run("traitor")).toBeNull(); // 120,000 is not < 120,000
    e.setTroops(119_999);
    expect(run("traitor")).toBe(e);

    e.markDisconnected(true);
    e.setTroops(300_000);
    expect(run("afk")).toBeNull();
    e.setTroops(299_999);
    expect(run("afk")).toBe(e);
    e.markDisconnected(false);

    // hated walks the nation's relations from the most hostile (:369-378),
    // skipping friends and, in FFA, anyone with > 3x its troops; h1 and h2
    // do not border the nation.
    expect(w.nation.nearby()).toEqual([e]);
    w.nation.updateRelation(h1, -100);
    w.nation.updateRelation(h2, -60);
    h1.setTroops(300_001);
    h2.setTroops(300_000);
    expect(run("hated")).toBe(h2);
    h1.setTroops(300_000);
    expect(run("hated")).toBe(h1);
    // Hostile is a relation value < -50 (PlayerImpl.relationFromValue).
    w.nation.updateRelation(h1, 50); // -50: Distrustful
    w.nation.updateRelation(h2, 10); // -50
    expect(w.nation.relation(h1)).toBe(Relation.Distrustful);
    expect(run("hated")).toBeNull();

    e.setTroops(100_000);
    expect(run("weakest")).toBeNull();
    e.setTroops(99_999);
    expect(run("weakest")).toBe(e);
    vi.restoreAllMocks();
  });

  it("retaliate: the attacker of the largest single incoming attack that is not a tribe's or a friend's; sent with force", () => {
    const { w, b } = fan({
      r1: PlayerType.Human,
      r2: PlayerType.Human,
      t: PlayerType.Bot,
    });
    const { r1, r2, t } = w.p;
    expect(b.findIncomingAttackPlayer()).toBeNull();
    phantomAttack(t, w.nation, 100_000);
    expect(b.findIncomingAttackPlayer()).toBeNull(); // tribes are ignored
    phantomAttack(r1, w.nation, 30_000);
    phantomAttack(r2, w.nation, 20_000);
    phantomAttack(r2, w.nation, 20_000);
    // The largest single attack, not the largest sum per attacker.
    expect(b.findIncomingAttackPlayer()).toBe(r1);
    phantomAttack(r2, w.nation, 30_000);
    expect(b.findIncomingAttackPlayer()).toBe(r1); // a tie keeps the first
    phantomAttack(r2, w.nation, 30_001);
    expect(b.findIncomingAttackPlayer()).toBe(r2);
    const send = vi.spyOn(b, "sendAttack").mockReturnValue(false);
    b
      .getAttackStrategies([], [r1, r2, t])
      .find((f) => f.name === "retaliate")!();
    expect(send.mock.calls).toEqual([[r2, true]]);
    vi.restoreAllMocks();
  });

  it("shouldAttack: Hard and Impossible never spare a human; Medium spares one in 4, Easy 3 in 4", () => {
    const spared: Record<string, number> = {};
    for (const difficulty of [
      Difficulty.Easy,
      Difficulty.Medium,
      Difficulty.Hard,
      Difficulty.Impossible,
    ]) {
      const w = world({
        width: 40,
        height: 10,
        members: { h: PlayerType.Human, t: PlayerType.Bot },
        seat: (x) => (x < 20 ? "nation" : x < 30 ? "h" : "t"),
        difficulty,
      });
      const b = start(w);
      let no = 0;
      for (let i = 0; i < 4000; i++) if (!b.shouldAttack(w.p.h)) no++;
      spared[difficulty] = no / 4000;
      // Tribes and free land are never spared (:932-943).
      for (let i = 0; i < 100; i++) {
        expect(b.shouldAttack(w.p.t)).toBe(true);
        expect(b.shouldAttack(w.game.terraNullius())).toBe(true);
      }
    }
    expect(spared[Difficulty.Impossible]).toBe(0);
    expect(spared[Difficulty.Hard]).toBe(0);
    expect(spared[Difficulty.Medium]).toBeGreaterThan(0.22);
    expect(spared[Difficulty.Medium]).toBeLessThan(0.28);
    expect(spared[Difficulty.Easy]).toBeGreaterThan(0.72);
    expect(spared[Difficulty.Easy]).toBeLessThan(0.78);
  });
});

describe("H4 NationTargeting: live consequences", () => {
  it("island (no bordering enemy): the nearest weaker player by centre distance, 1 time in 3 the second nearest; a stronger nearer one is skipped; a boat of troops/5", () => {
    // Four islands on one row, 8+ tiles of ocean apart (not nearby).
    const w = world({
      width: 70,
      height: 20,
      members: {
        n0: PlayerType.Human,
        n1: PlayerType.Human,
        n2: PlayerType.Human,
      },
      seat: (x, y) => {
        if (y < 3 || y >= 17) return "water";
        if (x >= 2 && x < 12) return "nation";
        if (x >= 20 && x < 28) return "n0";
        if (x >= 36 && x < 44) return "n1";
        if (x >= 52 && x < 60) return "n2";
        return "water";
      },
    });
    const b = start(w);
    const { n0, n1, n2 } = w.p;
    expect(w.nation.nearby()).toEqual([]);
    w.nation.setTroops(100_000);
    n0.setTroops(100_000); // not < the nation's troops: skipped
    n1.setTroops(50_000);
    n2.setTroops(50_000);
    const picks = new Map<Player | null, number>();
    for (let i = 0; i < 1500; i++) {
      const p = b.findNearestIslandEnemy();
      picks.set(p, (picks.get(p) ?? 0) + 1);
    }
    expect(picks.get(n0)).toBeUndefined();
    expect(picks.get(null)).toBeUndefined();
    const second = (picks.get(n2) ?? 0) / 1500;
    expect(second).toBeGreaterThan(0.29);
    expect(second).toBeLessThan(0.38);

    const fired = logFiredStrategies(b);
    const tn = Math.round(0.8 * w.config.maxTroops(w.nation));
    const got = firstSend(w, () => w.nation.setTroops(tn));
    expect(fired).toEqual(["island"]);
    expect(got.sends).toContainEqual(
      expect.objectContaining({ kind: "boat", troops: tn / 5 }),
    );
    for (const s of got.sends) expect([n1.id(), n2.id()]).toContain(s.to);
  });

  it("victim includes the nation's own attack: after it attacks (here as juicy) with > 50% of the target's troops, its next decision picks the same target as a victim and the send merges into the running attack", () => {
    // Nation: a 10x40 strip; e: the 50x40 rest (a target that survives one
    // interval of the attack).
    const w = world({
      width: 60,
      height: 40,
      members: { e: PlayerType.Human },
      seat: (x) => (x < 10 ? "nation" : "e"),
    });
    const b = start(w);
    const e = w.p.e;
    const fired = logFiredStrategies(b);
    const topUp = () =>
      w.nation.setTroops(Math.round(0.8 * w.config.maxTroops(w.nation)));
    const first = firstSend(w, () => {
      topUp();
      e.setTroops(Math.round(0.5 * w.nation.troops()));
    });
    expect(fired).toEqual(["juicy"]);
    expect(first.sends).toEqual([
      expect.objectContaining({ kind: "land", to: e.id() }),
    ]);
    // Ten ticks into that attack, the next strategy pass (called directly
    // here, so that no dice decide whether a decision reaches the list).
    tick(w, 10);
    topUp();
    const incoming = e
      .incomingAttacks()
      .reduce((sum, a) => sum + a.troops(), 0);
    expect(e.incomingAttacks()[0].attacker()).toBe(w.nation);
    expect(incoming).toBeGreaterThan(0.5 * e.troops());
    expect(b.findVeryWeakEnemy([e])).toBeNull();
    const i = w.sent.length;
    b.attackBestTarget([], [e]);
    expect(fired).toEqual(["juicy", "victim"]);
    expect(nationSends(w, i)).toEqual([
      expect.objectContaining({ kind: "land", to: e.id() }),
    ]);
    tick(w);
    // AttackExecution.init folds the running attack into the new one.
    expect(w.nation.outgoingAttacks()).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("our attack (sent as ctx.send sends it) makes an Impossible nation Hostile to us at -100 and it retaliates first; Hostile lasts 1,001 ticks of relation decay", () => {
    const w = world({
      width: 40,
      height: 20,
      members: { us: PlayerType.Human },
      seat: (x) => (x < 20 ? "nation" : "us"),
    });
    // Past the nations' spawn immunity (a human may not attack a nation
    // before it, PlayerImpl.canAttackPlayer).
    const b = start(w, w.config.nationSpawnImmunityDuration());
    const us = w.p.us;
    us.setTroops(50_000);
    w.nation.setTroops(Math.round(0.8 * w.config.maxTroops(w.nation)));
    const intent = {
      type: "attack" as const,
      targetID: NATION_ID,
      troops: 10_000,
    };
    expect(IntentSchema.safeParse(intent).success).toBe(true);
    w.game.addExecution(
      w.executor.createExec({ ...intent, clientID: clientOf("us") }),
    );
    expect(w.nation.relation(us)).toBe(Relation.Neutral);
    tick(w);
    // AttackExecution.init: target.updateRelation(attacker, -100) at
    // Impossible (AttackExecution.ts:188-210), the floor of the range.
    expect(w.nation.incomingAttacks()).toHaveLength(1);
    expect(w.nation.relation(us)).toBe(Relation.Hostile);
    const fired = logFiredStrategies(b);
    const got = firstSend(w);
    expect(fired).toEqual(["retaliate"]);
    expect(got.sends).toEqual([
      expect.objectContaining({ kind: "land", to: us.id() }),
    ]);
    // PlayerExecution.tick calls decayRelations every tick (0.05 toward 0,
    // PlayerImpl.decayRelations); Hostile is < -50.
    let ticks = 0;
    while (w.nation.relation(us) === Relation.Hostile) {
      w.nation.decayRelations();
      ticks++;
    }
    // 50 / 0.05 = 1,000 steps, plus one: the float sum of 0.05s is still a
    // hair below -50 after 1,000.
    expect(ticks).toBe(1001);
    vi.restoreAllMocks();
  });

  it("betray (Impossible) breaks an alliance with a bordering ally when: it is the juiciest ally and all threats < 0.33x the nation's troops; or it is a traitor with < 1.2x; or it is the only bordering player with 3x its troops < the nation's", () => {
    const betrays = (
      members: Record<string, MemberType>,
      set: (w: World) => void,
    ): boolean => {
      const { w, b } = fan(members);
      w.nation.createAllianceRequest(w.p.a)!.accept();
      set(w);
      vi.spyOn(b, "sendAttack").mockReturnValue(false);
      const friends = [w.p.a];
      const enemies = Object.keys(members)
        .filter((k) => k !== "a")
        .map((k) => w.p[k]);
      b.maybeBetrayAndAttack(friends, enemies);
      vi.restoreAllMocks();
      return !w.nation.isAlliedWith(w.p.a);
    };
    const alone = { a: PlayerType.Human };
    const pair = { a: PlayerType.Human, e: PlayerType.Human };
    // The only bordering player: 3 x a < T (strict).
    const only = (a: number) => (w: World) => {
      w.nation.setTroops(300_000);
      w.p.a.setTroops(a);
    };
    expect(betrays(alone, only(100_000))).toBe(false);
    expect(betrays(alone, only(99_999))).toBe(true);
    // The juiciest ally, when a + bordering enemies (+ their outgoing
    // attacks) < 0.33 T.
    const safe =
      (e: number, outgoing = 0) =>
      (w: World) => {
        w.nation.setTroops(100_000);
        w.p.a.setTroops(30_000);
        w.p.e.setTroops(e);
        if (outgoing > 0) phantomAttack(w.p.e, w.p.a, outgoing);
      };
    expect(betrays(pair, safe(2_000))).toBe(true);
    expect(betrays(pair, safe(4_000))).toBe(false);
    expect(betrays(pair, safe(2_000, 2_000))).toBe(false);
    // A traitor ally with < 1.2 T.
    const traitor = (a: number) => (w: World) => {
      w.nation.setTroops(100_000);
      w.p.a.setTroops(a);
      w.p.a.markTraitor();
      w.p.e.setTroops(100_000);
    };
    expect(betrays(pair, traitor(120_000))).toBe(false);
    expect(betrays(pair, traitor(119_999))).toBe(true);
  });
});

interface Census {
  nations: number;
  decisions: number;
  reachedList: number;
  /** "strategy->target type" -> count of decisions it attacked in. */
  fired: Map<string, number>;
  nationSends: number;
  /** Attacks nations' boats started on landing. */
  landings: number;
  openings: number;
  unscheduled: number;
}

/**
 * Pangaea as the arena builds it (createGameRunner, NodeMapLoader, FFA
 * singleplayer, Impossible, default nations, 400 tribes), one idle human
 * that spawns on a free inland site, run for three minutes after the
 * spawn phase. Every nation's strategy list is wrapped (read-only: each
 * wrapper calls through) to log which strategy attacked.
 */
async function census(ticks: number): Promise<Census> {
  const spec = {
    gameID: "TARGETNG",
    map: GameMapType.Pangaea,
    mapSize: GameMapSize.Normal,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Impossible,
    nations: "default",
    bots: 400,
    seats: [{ agent: "idle" }],
  };
  // The fields arenaGameStart reads; the rest of ArenaGameSpec steers the
  // arena's loop, which this test replaces with its own.
  const runner = await createGameRunner(
    arenaGameStart(spec as unknown as ArenaGameSpec),
    undefined,
    new NodeMapLoader(MAPS),
    (gu) => {
      if ("errMsg" in gu) throw new Error(gu.errMsg);
    },
  );
  const game = runner.game;
  const me = seatClientID(0);
  const step = (intents: Intent[] = []) => {
    runner.addTurn({
      turnNumber: game.ticks(),
      intents: intents.map((i) => ({ ...i, clientID: me })),
    });
    if (!runner.executeNextTick()) throw new Error("tick failed");
  };
  const nationExecs = () =>
    (game as unknown as { executions(): Execution[] })
      .executions()
      .filter((e): e is NationExecution => e instanceof NationExecution);
  const byId = new Map<PlayerID, NationInternals>();
  const out: Census = {
    nations: 0,
    decisions: 0,
    reachedList: 0,
    fired: new Map(),
    nationSends: 0,
    landings: 0,
    openings: 0,
    unscheduled: 0,
  };
  const seenSender = new Set<PlayerID>();
  const add = game.addExecution.bind(game);
  game.addExecution = (...execs: Execution[]) => {
    for (const e of execs) {
      let owner: Player | null = null;
      if (e instanceof AttackExecution) {
        const v = e as unknown as {
          _owner: Player;
          sourceTile: TileRef | null;
        };
        // A boat that lands becomes an attack from its landing tile
        // (TransportShipExecution.ts:271-283): not a decision.
        if (v.sourceTile !== null) {
          if (v._owner.type() === PlayerType.Nation) out.landings++;
          continue;
        }
        owner = v._owner;
      } else if (e instanceof TransportShipExecution) {
        owner = (e as unknown as { attacker: Player }).attacker;
      }
      if (owner === null || owner.type() !== PlayerType.Nation) continue;
      out.nationSends++;
      if (!byId.has(owner.id())) {
        for (const ex of nationExecs()) {
          const n = ex as unknown as NationInternals & { player: Player };
          if (n.player !== null) byId.set(n.player.id(), n);
        }
      }
      const n = byId.get(owner.id())!;
      const first = !seenSender.has(owner.id());
      seenSender.add(owner.id());
      if (game.ticks() % n.attackRate === n.attackTick) continue;
      if (first && e instanceof AttackExecution && e.targetID() === null) {
        out.openings++; // forceSendAttack, NationExecution.ts:194-198
      } else {
        out.unscheduled++;
      }
    }
    add(...execs);
  };

  // Tick 0 inits the tribes' spawns, tick 1 lands them, tick 2 the nations
  // (SpawnPhaseSingleplayer.test.ts); then we spawn, ending the phase.
  step();
  step();
  step();
  let site: TileRef | null = null;
  for (let y = 40; y < game.height() - 40 && site === null; y += 7) {
    for (let x = 40; x < game.width() - 40 && site === null; x += 7) {
      let ok = true;
      for (let dy = -10; dy < 10 && ok; dy++) {
        for (let dx = -10; dx < 10 && ok; dx++) {
          const t = game.ref(x + dx, y + dy);
          ok = game.isLand(t) && !game.isImpassable(t) && !game.hasOwner(t);
        }
      }
      if (ok) site = game.ref(x, y);
    }
  }
  step([{ type: "spawn", tile: site! }]);
  step();
  expect(game.inSpawnPhase()).toBe(false);

  const wrapped = new Set<NationExecution>();
  const bump = (k: string) => out.fired.set(k, (out.fired.get(k) ?? 0) + 1);
  for (let t = 0; t < ticks; t++) {
    for (const ex of nationExecs()) {
      const n = ex as unknown as NationInternals;
      if (!n.behaviorsInitialized || wrapped.has(ex)) continue;
      wrapped.add(ex);
      const b = n.attackBehavior;
      const maybeAttack = b.maybeAttack.bind(b);
      const list = b.getAttackStrategies.bind(b);
      const send = b.sendAttack.bind(b);
      let inStrategy = false;
      let target: string | null = null;
      b.maybeAttack = () => {
        out.decisions++;
        maybeAttack();
      };
      b.sendAttack = (to, force) => {
        const ok = send(to, force);
        if (ok && inStrategy && target === null) {
          target = to.isPlayer() ? to.type() : "TerraNullius";
        }
        return ok;
      };
      b.getAttackStrategies = (f, e) => {
        out.reachedList++;
        return list(f, e).map((s) => {
          const g = () => {
            inStrategy = true;
            target = null;
            const r = s();
            inStrategy = false;
            if (r) bump(`${s.name}->${target}`);
            return r;
          };
          Object.defineProperty(g, "name", { value: s.name });
          return g;
        });
      };
    }
    step();
  }
  out.nations = wrapped.size;
  return out;
}

describe("H4 NationTargeting: a real game (Pangaea, arena setting, 3 minutes)", () => {
  let real: Census;
  beforeAll(async () => {
    real = await census(1800);
  }, 60_000);

  it("every nation attack or boat is sent on one of that nation's decision ticks, or is its opening", () => {
    expect(real.nations).toBe(29);
    expect(real.nationSends).toBeGreaterThan(1000);
    expect(real.unscheduled).toBe(0);
    expect(real.openings).toBeLessThanOrEqual(real.nations);
    expect(real.landings).toBeGreaterThan(0);
    // 29 nations x 1,800 ticks / 30-49 ticks: measured 1,329 decisions.
    expect(real.decisions).toBeGreaterThan((29 * 1800) / 50);
    expect(real.decisions).toBeLessThan((29 * 1800) / 30);
  });

  it("what fires: tribes first, then retaliation and juicy; veryWeak almost never", () => {
    const f = (strategy: string, target: PlayerType) =>
      real.fired.get(`${strategy}->${target}`) ?? 0;
    const { Bot, Nation: N } = PlayerType;
    const names = new Set([...real.fired.keys()].map((k) => k.split("->")[0]));
    for (const n of names) {
      expect([
        "retaliate",
        "bots",
        "veryWeak",
        "betray",
        "assist",
        "victim",
        "traitor",
        "juicy",
        "afk",
        "nuked",
        "hated",
        "weakest",
        "island",
        "donate",
      ]).toContain(n);
    }
    const total = [...real.fired.values()].reduce((a, b) => a + b, 0);
    // Measured: bots->Bot 273, retaliate->Nation 88, juicy->Nation 56,
    // victim->Nation 28, hated->Nation 12, weakest->Nation 9, veryWeak 1,
    // juicy->Human 1 (our idle seat), island 1; 756 of 1,329 decisions
    // reached the list (the rest: free land, random boat, reserve, trigger).
    expect(f("bots", Bot)).toBeGreaterThan(total / 3);
    expect(f("retaliate", N)).toBeGreaterThan(f("juicy", N) / 2);
    expect(f("juicy", N)).toBeGreaterThan(f("victim", N));
    expect(f("victim", N)).toBeGreaterThan(0);
    expect(f("hated", N)).toBeGreaterThan(0);
    expect(f("veryWeak", N)).toBeLessThan(total / 50);
    expect(real.reachedList / real.decisions).toBeGreaterThan(0.4);
    expect(real.reachedList / real.decisions).toBeLessThan(0.8);
  });
});
