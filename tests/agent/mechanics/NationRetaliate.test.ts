/**
 * Pins roadmap H5 (docs/11-roadmap.md §11.3; the risk table asks for every
 * mechanic an agent relies on to be pinned here) against a real
 * NationExecution.
 *
 * The claim under test ("NationRetaliate"): Impossible's first strategy is
 * retaliate: it answers the largest incoming attack with troops -
 * reserveRatio x cap (reserve 30-40%), and that new attack cancels ours 1:1
 * when created (AttackExecution.init). It skips its whole strategy list while
 * it borders free land or is below its reserve, and 90% of the time when
 * below its trigger of 50-60% of cap (maybeAttack, attackBestTarget).
 *
 * The rules (the code is the spec; src/core/execution/utils/AiAttackBehavior.ts
 * unless named):
 * - Schedule. NationExecution.tick (src/core/execution/NationExecution.ts:
 *   109-229) decides once every attackRate ticks (Impossible nextInt(30, 50)
 *   = 30-49, :102-103; phase attackTick :84; gate :200-216), maybeAttack
 *   last but two (:226). Its ratios come from its own PRNG (:73-78): trigger
 *   nextInt(50, 60) / 100 = 0.50-0.59, reserve 0.30-0.39, expand 0.10-0.19
 *   (nextInt is upper-exclusive, src/core/PseudoRandom.ts:61-65). "cap" is
 *   Config.maxTroops (Impossible nations x1.25,
 *   src/core/configuration/Config.ts:1024-1052).
 * - maybeAttack (:98-157): free land first: if it borders unowned, un-nuked
 *   land and sendAttack(terra nullius) succeeds, return (:135-141). Then,
 *   with a bordering enemy, chance(10) (1 in 10, PseudoRandom.ts:108-110)
 *   sends a random boat and RETURNS (:148-151); then alliance requests
 *   (:153) and attackBestTarget (:156).
 * - attackBestTarget (:278-304): a nearby tribe owning a structure is
 *   attacked first (:285-287, attackBots :484-520); nothing below
 *   reserveRatio x cap (:290, :446-450); below triggerRatio x cap only if
 *   chance(10) (:293, :452-456); then the Impossible list [retaliate, bots,
 *   veryWeak, betray, assist, victim, traitor, juicy, afk, nuked, hated,
 *   weakest, island, donate] (:426-428), first success wins (:301-303).
 * - retaliate (:313-319): findIncomingAttackPlayer (:458-479) takes
 *   incomingAttacks() (live attackers, src/core/game/PlayerImpl.ts:
 *   1903-1905), drops friendly ones (:461) and, for a non-bot, tribes
 *   (:462-467), and returns the attacker of the single attack with the most
 *   troops() now (:468-474); sendAttack(attacker, force = true) skips
 *   shouldAttack (:822-823) and goes by land when it sharesBorderWith the
 *   attacker (:826-827).
 * - Size: calculateAttackTroops (:1041-1096), land on a player: troops -
 *   reserveRatio x maxTroops (:1052-1054, :1101), then min(that,
 *   troopSendCap()) (:1071-1074), none below 1 (:1076-1078); the 20% floor
 *   is lifted under attack (isAttackTooWeak :966). troopSendCap (:986-1032):
 *   Impossible keeps ceil(0.9 x) the troops of the strongest non-friendly,
 *   non-bot nearby player (:997-998, :1004-1022) and, under attack, rises to
 *   at least the SUM of all incoming attacks, tribes' included (:1024-1029).
 * - Cancellation: AttackExecution.init (src/core/execution/
 *   AttackExecution.ts:75-211). The owner pays floor(min(troops, asked))
 *   (:130-140; PlayerImpl.removeTroops :1376-1383 floors via toInt,
 *   src/core/Util.ts:401-409). Then for every incoming attack whose attacker
 *   is the new attack's target (:157-170): if that one is strictly larger it
 *   keeps the difference and the new attack is deleted, else the new attack
 *   keeps the difference and that one is deleted. AttackImpl.delete
 *   (src/core/game/AttackImpl.ts:60-72) refunds nothing.
 * - Timing: GameImpl.executeNextTick (src/core/game/GameImpl.ts:526-551)
 *   ticks the running executions in the order added (the NationExecution
 *   before our attacks), then inits new ones. So the nation decides on the
 *   state after the previous tick; an attack of ours created in a decision
 *   tick is first seen at the NEXT decision; the answer's init, i.e. the
 *   cancellation, runs at the end of the decision tick, after our attack's
 *   own tick in it.
 *
 * VERDICT: PARTIAL. The mechanism is as claimed (first strategy, largest
 * attacker, 1:1 at init, the free-land, reserve and 1-in-10 trigger gates),
 * with these corrections:
 * - The answer is min(troops - reserveRatio x cap, troopSendCap), not the
 *   reserve surplus alone. With our home troops H >= T / 0.9 the send cap is
 *   exactly the incoming total, so the answer is min(surplus, our attack's
 *   CURRENT troops) and nothing lands on us. Only when H is small (it could
 *   attack us anyway, H4) is the answer its full surplus, the rest landing
 *   on us.
 * - 1:1 is exact but lagged by our attack's own tick in the decision tick:
 *   it pays our attack's troops as they were before that tick, we lose them
 *   as they are after it; the difference walks onto us.
 * - The largest attack is by troops() at decision time, non-bot attackers
 *   only; tribes' attacks are never answered but count in the size, so a
 *   tribe hitting the nation enlarges its answer to our small attack.
 * - Above its trigger it answers ~9 decisions in 10, not every one: the
 *   random-boat return in maybeAttack comes first (179 of 200 here).
 *   Between reserve and trigger ~1 in 11 (16 of 200), below the reserve
 *   never (0 of 200). The reserve range is 30-39%, the trigger 50-59%.
 * - A tribe next to it that owns a structure is attacked before retaliate.
 * - While it borders free land it answers nothing (8 of 8 decisions); under
 *   attack its expansion is sized by the incoming total (the send cap).
 * - The answer comes at its next decision, 1 to attackRate (30-49) ticks
 *   later; until then our attack conquers unopposed and the answer is sized
 *   on what is left of it (40,000 sent in a decision tick: 71 tiles and
 *   30,672 of its troops later, answered with 15,598).
 * - A retreating attack still counts: cancel_attack takes 20 ticks
 *   (RetreatExecution.ts:11) and an answer inside them erases the frozen
 *   stack, where a completed retreat returns 75% of it.
 * - A strike above its surplus survives the answer minus exactly the surplus
 *   and leaves it below its reserve (and so, without income, unanswered).
 *   With income it regrew from 0.35 to 0.58 of its cap in 90 ticks.
 *
 * Setting: the real Config class (not TestConfig, tests/util/TestConfig.ts),
 * built as the arena builds it (src/core/GameRunner.ts:46: new Config(config,
 * null, false)), FFA, Singleplayer, Impossible, 400 tribes in the config,
 * Normal size; the game built as tests/util/Setup.ts builds it (createGame,
 * endSpawnPhase). Maps are synthesized in memory (plains; every land tile
 * owned unless a test adds free land). The NationExecution is the real one,
 * seeded as in a game (gameID + nation id). Except in the live test no
 * PlayerExecution runs, so troops stay where the test puts them; the test
 * sets troops and gives tiles back only on the eve of a decision (tests may
 * mutate state; agents never may). The nation is attacked only after its
 * spawn immunity (config.nationSpawnImmunityDuration, PlayerImpl.ts:
 * 1907-1926). Our attacks go through IntentSchema and Executor.createExec,
 * the path of ctx.send. Every attack is recorded as constructed (the
 * decision) and around its init (the cancellation), without changing either.
 */
import { Config } from "../../../src/core/configuration/Config";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import {
  Attack,
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
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { GameConfig, IntentSchema } from "../../../src/core/Schemas";

const GAME_ID = "nation-retaliate";
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

// Terrain bytes (GameMap.ts:127-130: bit 7 land, bit 6 shoreline, bit 5
// ocean, bits 0-4 magnitude; land magnitude < 10 is Plains).
const LAND = 0x80 | 5;
const OCEAN = 0x20;
const SHORELINE = 0x40;

type Seat = "us" | "nation" | "third" | "free" | "water";

interface Spec {
  width: number;
  height: number;
  seat: (x: number, y: number) => Seat;
  third?: PlayerType.Human | PlayerType.Bot;
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
    sendAttack(t: Player | TerraNullius, force?: boolean): boolean;
  };
}

/** An attack some player decided to send (constructor arguments). */
interface Sent {
  tick: number;
  from: PlayerID;
  /** Target player id, or terra nullius's id. */
  to: PlayerID | null;
  troops: number;
}

/** What one nation attack on a player did at its init (the cancellation). */
interface InitRecord {
  tick: number;
  to: PlayerID;
  asked: number;
  nationBefore: number;
  nationAfter: number;
  /** The target's attacks on the nation just before the init. */
  theirs: Attack[];
  theirsBefore: number[];
  theirsAfter: number[];
  theirsActiveAfter: boolean[];
  /** The target's home troops around the init. */
  homeBefore: number;
  homeAfter: number;
  /** The new attack right after init (null if init stopped before it). */
  answer: Attack | null;
}

interface World {
  spec: Spec;
  game: Game;
  config: Config;
  us: Player;
  nation: Player;
  third: Player | null;
  exec: NationExecution;
  n: NationInternals;
  sent: Sent[];
  inits: InitRecord[];
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
  const config = new Config(GAME_CONFIG, null, false);
  const humans = [
    new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID),
  ];
  if (spec.third === PlayerType.Human) {
    humans.push(
      new PlayerInfo("rival", PlayerType.Human, THIRD_CLIENT, THIRD_ID),
    );
  }
  const nationObj = new Nation(
    new Cell(0, 0),
    new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
  );
  const game = createGame(humans, [nationObj], map, mini, config);
  if (spec.third === PlayerType.Bot) {
    game.addPlayer(new PlayerInfo("tribe", PlayerType.Bot, null, THIRD_ID));
  }
  game.endSpawnPhase();
  const exec = new NationExecution(GAME_ID, nationObj);
  const w: World = {
    spec,
    game,
    config,
    us: game.player(AGENT_ID),
    nation: game.player(NATION_ID),
    third: spec.third === undefined ? null : game.player(THIRD_ID),
    exec,
    n: exec as unknown as NationInternals,
    sent: [],
    inits: [],
    executor: new Executor(game, GAME_ID, undefined),
  };
  restore(w);

  // Record every attack as it is constructed (the decision) and, for the
  // nation's attacks on players, what its init did (the cancellation).
  const add = game.addExecution.bind(game);
  game.addExecution = (...execs: Execution[]) => {
    for (const e of execs) {
      if (!(e instanceof AttackExecution)) continue;
      const v = e as unknown as {
        _owner: Player;
        startTroops: number;
        attack: Attack | null;
      };
      const sent: Sent = {
        tick: game.ticks(),
        from: v._owner.id(),
        to: e.targetID(),
        troops: v.startTroops,
      };
      w.sent.push(sent);
      const to = sent.to;
      if (sent.from !== NATION_ID || to === null || !game.hasPlayer(to)) {
        continue;
      }
      const init = e.init.bind(e);
      e.init = (mg: Game, ticks: number) => {
        const target = mg.player(to);
        const theirs = outgoingOn(target, w.nation);
        const nationBefore = w.nation.troops();
        const theirsBefore = theirs.map((a) => a.troops());
        const homeBefore = target.troops();
        init(mg, ticks);
        w.inits.push({
          tick: mg.ticks(),
          to,
          asked: sent.troops,
          nationBefore,
          nationAfter: w.nation.troops(),
          theirs,
          theirsBefore,
          theirsAfter: theirs.map((a) => a.troops()),
          theirsActiveAfter: theirs.map((a) => a.isActive()),
          homeBefore,
          homeAfter: target.troops(),
          answer: v.attack,
        });
      };
    }
    add(...execs);
  };
  return w;
}

/**
 * Gives every seat back to its owner, free land back to terra nullius (tests
 * may mutate; agents never).
 */
function restore(w: World, freeLand = true): void {
  for (let y = 0; y < w.spec.height; y++) {
    for (let x = 0; x < w.spec.width; x++) {
      const s = w.spec.seat(x, y);
      const owner =
        s === "us"
          ? w.us
          : s === "nation"
            ? w.nation
            : s === "third"
              ? w.third
              : null;
      const tile = w.game.ref(x, y);
      if (owner !== null && w.game.owner(tile) !== owner) owner.conquer(tile);
      const held = w.game.owner(tile);
      if (freeLand && s === "free" && held.isPlayer()) held.relinquish(tile);
    }
  }
}

function tick(w: World, n = 1): void {
  for (let i = 0; i < n; i++) w.game.executeNextTick();
}

/**
 * Adds the NationExecution and runs its first ticks: init, then the
 * behaviours and the uncapped opening troops/2 on free land
 * (NationExecution.ts:194-198), which with no free land retreats in full the
 * next tick (AttackExecution.ts:302-306). `idle` ticks run first with no
 * nation, e.g. to pass the nations' spawn immunity before we attack one.
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

function isEveOfDecision(w: World): boolean {
  return (w.game.ticks() + 1) % w.n.attackRate === w.n.attackTick;
}

/** Runs ticks until the next tick to run is a decision tick. */
function toDecision(w: World): void {
  while (!isDecisionTick(w)) tick(w);
}

/** Runs ticks until the next-but-one tick is a decision tick. */
function toEveOfDecision(w: World): void {
  while (!isEveOfDecision(w)) tick(w);
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

/** An attack, the way ctx.send delivers it (AgentHost -> Executor). */
function attackFrom(
  w: World,
  client: string,
  target: Player,
  troops: number,
): void {
  const intent = { type: "attack" as const, targetID: target.id(), troops };
  expect(IntentSchema.safeParse(intent).success).toBe(true);
  w.game.addExecution(w.executor.createExec({ ...intent, clientID: client }));
}

function ourAttack(w: World, troops: number): void {
  attackFrom(w, AGENT_CLIENT, w.nation, troops);
}

function outgoingOn(p: Player, target: Player): Attack[] {
  return p.outgoingAttacks().filter((a) => a.target() === target);
}

function only<T>(xs: T[]): T {
  expect(xs).toHaveLength(1);
  return xs[0];
}

function sum(attacks: Attack[]): number {
  return attacks.reduce((s, a) => s + a.troops(), 0);
}

/** troops - reserveRatio x cap (AiAttackBehavior.ts:1052-1054, :1101). */
function surplus(w: World): number {
  return w.nation.troops() - w.config.maxTroops(w.nation) * w.n.reserveRatio;
}

/** The land answer calculateAttackTroops gives (:1041-1096); null = none. */
function predictAnswer(w: World): number | null {
  const troops = Math.min(surplus(w), w.n.attackBehavior.troopSendCap());
  return troops < 1 ? null : troops;
}

function fillOf(w: World): number {
  return w.nation.troops() / w.config.maxTroops(w.nation);
}

function setFill(w: World, fill: number): number {
  const tn = Math.round(fill * w.config.maxTroops(w.nation));
  w.nation.setTroops(tn);
  return tn;
}

/** Every call of retaliate: sendAttack(attacker, true) (:313-319). */
function retaliations(w: World): () => Player[] {
  const spy = vi.spyOn(w.n.attackBehavior, "sendAttack");
  return () =>
    spy.mock.calls.filter((c) => c[1] === true).map((c) => c[0] as Player);
}

/**
 * AttackExecution.init's arithmetic (:130-140, :157-170) applied to the
 * record: the nation pays floor(min(troops, asked)); against the target's one
 * attack on it the larger side keeps the difference, the other is deleted;
 * nothing is refunded to the target's home.
 */
function expectOneToOne(r: InitRecord): void {
  const paid = Math.floor(Math.min(r.nationBefore, r.asked));
  const ours = only(r.theirsBefore);
  expect(r.homeAfter).toBe(r.homeBefore);
  if (ours > paid) {
    expect(r.theirsAfter).toEqual([ours - paid]);
    expect(r.theirsActiveAfter).toEqual([true]);
    expect(r.answer!.isActive()).toBe(false);
  } else {
    expect(r.theirsActiveAfter).toEqual([false]);
    // Deleted attacks keep their last troops (AttackImpl.ts:60-72).
    expect(r.theirsAfter).toEqual([ours]);
    expect(r.answer!.isActive()).toBe(true);
    expect(r.answer!.troops()).toBe(paid - ours);
  }
}

const halves = (x: number): Seat => (x < 20 ? "us" : "nation");
const immunity = (w: World) => w.config.nationSpawnImmunityDuration();

describe("H5 NationRetaliate: this nation", () => {
  it("draws its ratios and decision rate from its seed, inside the claimed ranges", () => {
    const w = world({ width: 40, height: 20, seat: halves });
    start(w, immunity(w));
    const { triggerRatio, reserveRatio, expandRatio, attackRate } = w.n;
    expect({ triggerRatio, reserveRatio, expandRatio, attackRate }).toEqual({
      triggerRatio: 0.53,
      reserveRatio: 0.34,
      expandRatio: 0.17,
      attackRate: 30,
    });
    // 400 tiles, no cities: 1.25 x 2 x (400^0.6 x 1000 + 50,000).
    expect(w.config.maxTroops(w.nation)).toBeCloseTo(216_028.21, 1);
  });
});

describe("H5 NationRetaliate: the answer to one attack", () => {
  it("strong at home: answered at its next decision with exactly our attack's current troops; ours dies 1:1", () => {
    const w = world({ width: 40, height: 20, seat: halves });
    start(w, immunity(w));
    const tn = setFill(w, 0.8);
    const A = 40_000;
    // H >= T / 0.9: its send cap is 0 until we attack (:1016-1022).
    w.us.setTroops(Math.ceil(3.5 * tn) + A);
    const answered = retaliations(w);
    toDecision(w);
    const s = w.game.ticks();
    ourAttack(w, A);
    // Decision tick s: the nation ticks before our attack inits.
    expect(decide(w)).toEqual([]);
    const ours = only(outgoingOn(w.us, w.nation));
    expect(ours.troops()).toBe(A);
    const home = w.us.troops();
    expect(home).toBe(Math.ceil(3.5 * tn));

    // Nothing until its next decision, attackRate ticks later.
    const tilesBefore = w.nation.numTilesOwned();
    while (!isDecisionTick(w)) {
      const i = w.sent.length;
      tick(w);
      expect(nationSends(w, i)).toEqual([]);
    }
    expect(w.game.ticks() - s).toBe(w.n.attackRate);
    // Meanwhile our attack conquered freely and shrank.
    const left = ours.troops();
    expect([
      tilesBefore - w.nation.numTilesOwned(),
      tn - w.nation.troops(),
      Math.round(left),
    ]).toEqual([71, 30_672, 15_598]);

    // Its cap is the incoming total, which is our attack as it is now.
    expect(w.n.attackBehavior.troopSendCap()).toBe(left);
    expect(surplus(w)).toBeGreaterThan(left);
    expect(predictAnswer(w)).toBe(left);
    const d = w.game.ticks();
    expect(decide(w)).toEqual([
      { tick: d, from: NATION_ID, to: AGENT_ID, troops: left },
    ]);
    expect(answered()).toEqual([w.us]);

    // 1:1 at init, after our attack's own tick in the decision tick: we lose
    // what is left of it; the one tick of losses in between walks onto us.
    const r = only(w.inits);
    expect(r.theirs).toEqual([ours]);
    expectOneToOne(r);
    expect(r.theirsBefore[0]).toBeLessThan(left);
    expect(ours.isActive()).toBe(false);
    expect(w.us.outgoingAttacks()).toEqual([]);
    expect(w.us.troops()).toBe(home);
    expect(only(w.us.incomingAttacks()).troops()).toBe(
      Math.floor(left) - r.theirsBefore[0],
    );
  });

  it("a retreating attack is still answered and erased: cancelling inside the 20-tick retreat delay saves nothing", () => {
    const w = world({ width: 40, height: 20, seat: halves });
    start(w, immunity(w));
    const tn = setFill(w, 0.8);
    const A = 40_000;
    w.us.setTroops(Math.ceil(3.5 * tn) + A);
    const answered = retaliations(w);
    toDecision(w);
    ourAttack(w, A);
    tick(w);
    const ours = only(outgoingOn(w.us, w.nation));
    // Cancel 10 ticks before its next decision. The retreat is ordered at
    // once and carried out 20 ticks later (RetreatExecution.ts:11, :28-37);
    // meanwhile the attack stands still (AttackExecution.ts:276-278) but
    // stays in its target's incomingAttacks.
    while ((w.game.ticks() + 10) % w.n.attackRate !== w.n.attackTick) tick(w);
    const intent = { type: "cancel_attack" as const, attackID: ours.id() };
    expect(IntentSchema.safeParse(intent).success).toBe(true);
    w.game.addExecution(
      w.executor.createExec({ ...intent, clientID: AGENT_CLIENT }),
    );
    tick(w, 2);
    expect(ours.retreating()).toBe(true);
    const frozen = ours.troops();
    toDecision(w);
    expect(ours.troops()).toBe(frozen);
    expect(w.nation.incomingAttacks()).toEqual([ours]);
    expect(predictAnswer(w)).toBe(frozen);
    const home = w.us.troops();
    expect(decide(w)).toEqual([
      expect.objectContaining({ to: AGENT_ID, troops: frozen }),
    ]);
    expect(answered()).toEqual([w.us]);
    const r = only(w.inits);
    expectOneToOne(r);
    expect(r.theirsBefore).toEqual([frozen]);
    // It paid floor(frozen), so only the fraction of a troop survives.
    expect(ours.troops()).toBe(frozen - Math.floor(frozen));
    expect(ours.troops()).toBeLessThan(1);
    // The retreat then brings home nothing, where a completed retreat
    // returns 75% of the stack (malusForRetreat = 25, AttackExecution.ts:37,
    // :229-249, :266-270; addTroops floors).
    tick(w, 20);
    expect(w.us.troops()).toBe(home);
    expect(w.us.outgoingAttacks()).toEqual([]);
  });

  it("weak at home: answered with troops - reserveRatio x cap; ours is erased and the rest lands on us", () => {
    const w = world({ width: 40, height: 20, seat: halves });
    start(w, immunity(w));
    const tn = setFill(w, 0.8);
    const M = w.config.maxTroops(w.nation);
    // Out of its reach until the eve, so it has not attacked us yet.
    w.us.setTroops(Math.ceil(3.5 * tn));
    const answered = retaliations(w);
    toEveOfDecision(w);
    const low = Math.round(0.25 * M);
    const A = 10_000;
    w.us.setTroops(low + A);
    ourAttack(w, A);
    tick(w); // the eve: our attack inits at its end
    expect(w.us.troops()).toBe(low);
    expect(w.nation.troops()).toBe(tn);
    // The send cap (keeping 0.9 of our home troops) is above the surplus,
    // so the surplus binds: exactly troops - reserveRatio x cap.
    expect(w.n.attackBehavior.troopSendCap()).toBe(tn - Math.ceil(0.9 * low));
    const R = tn - M * w.n.reserveRatio;
    expect(w.n.attackBehavior.troopSendCap()).toBeGreaterThan(R);
    expect(predictAnswer(w)).toBe(R);
    expect(decide(w)).toEqual([
      expect.objectContaining({ to: AGENT_ID, troops: R }),
    ]);
    expect(answered()).toEqual([w.us]);
    const r = only(w.inits);
    expectOneToOne(r);
    expect(w.us.outgoingAttacks()).toEqual([]);
    const rest = only(w.us.incomingAttacks());
    expect(rest).toBe(r.answer);
    expect(rest.troops()).toBe(Math.floor(R) - r.theirsBefore[0]);
    expect(r.nationAfter).toBe(r.nationBefore - Math.floor(R));
  });

  it("a strike above its reserve surplus survives the answer minus exactly that surplus; without income it is never answered again", () => {
    const w = world({ width: 40, height: 20, seat: halves });
    start(w, immunity(w));
    const tn = setFill(w, 0.8);
    const answered = retaliations(w);
    toEveOfDecision(w);
    const R = surplus(w);
    const A = Math.round(1.25 * R);
    w.us.setTroops(Math.ceil(3.5 * tn) + A);
    ourAttack(w, A);
    tick(w);
    const ours = only(outgoingOn(w.us, w.nation));
    // Cap = the incoming total = A > surplus: the surplus binds.
    expect(w.n.attackBehavior.troopSendCap()).toBe(A);
    expect(predictAnswer(w)).toBe(R);
    expect(decide(w)).toEqual([
      expect.objectContaining({ to: AGENT_ID, troops: R }),
    ]);
    const r = only(w.inits);
    expectOneToOne(r);
    expect(ours.isActive()).toBe(true);
    expect(ours.troops()).toBe(r.theirsBefore[0] - Math.floor(R));
    expect(w.us.incomingAttacks()).toEqual([]);
    // Left below its reserve: the strategy list is closed to it.
    expect(fillOf(w)).toBeLessThan(w.n.reserveRatio);

    // Without income it never answers again; our attack runs on.
    let decisions = 0;
    const tiles = w.nation.numTilesOwned();
    while (ours.isActive()) {
      if (isDecisionTick(w)) {
        decisions++;
        expect(fillOf(w)).toBeLessThan(w.n.reserveRatio);
        expect(decide(w)).toEqual([]);
      } else {
        tick(w);
      }
    }
    expect([decisions, tiles - w.nation.numTilesOwned()]).toEqual([1, 123]);
    expect(answered()).toEqual([w.us]);
  });
});

describe("H5 NationRetaliate: whom it answers", () => {
  it("the largest attack by current troops, sized by all incoming; paying for it left our attack unanswered", () => {
    // us | nation | rival (a second human)
    const w = world({
      width: 60,
      height: 20,
      third: PlayerType.Human,
      seat: (x) => (x < 20 ? "us" : x < 40 ? "nation" : "third"),
    });
    start(w, immunity(w));
    const tn = setFill(w, 0.8);
    const rival = w.third!;
    const answered = retaliations(w);
    toEveOfDecision(w);
    const oursA = 30_000;
    const theirsA = 40_000;
    w.us.setTroops(Math.ceil(3.5 * tn) + oursA);
    rival.setTroops(Math.ceil(3.5 * tn) + theirsA);
    ourAttack(w, oursA);
    attackFrom(w, THIRD_CLIENT, w.nation, theirsA);
    tick(w);
    const ours = only(outgoingOn(w.us, w.nation));
    // Both incoming attacks size the answer (:1024-1029).
    expect(w.n.attackBehavior.troopSendCap()).toBe(oursA + theirsA);
    expect(predictAnswer(w)).toBe(oursA + theirsA);
    expect(decide(w)).toEqual([
      expect.objectContaining({ to: THIRD_ID, troops: oursA + theirsA }),
    ]);
    expect(answered()).toEqual([rival]);
    const r = only(w.inits);
    expect(r.to).toBe(THIRD_ID);
    expectOneToOne(r);
    // The rival's attack is erased; ours runs on, and the rival takes the
    // rest (our attack's share) on its own land.
    expect(ours.isActive()).toBe(true);
    expect(only(rival.incomingAttacks()).troops()).toBe(
      oursA + theirsA - r.theirsBefore[0],
    );

    // Paying 70,000 put it below its trigger, so our attack, now the only
    // one, is answered only if a 1-in-10 roll passes (:293): here it never
    // does, and ours runs until it is spent.
    const tiles = w.nation.numTilesOwned();
    const fills: number[] = [];
    while (ours.isActive()) {
      if (!isDecisionTick(w)) {
        tick(w);
        continue;
      }
      fills.push(Math.round(fillOf(w) * 1000) / 1000);
      expect(decide(w).filter((x) => x.to === AGENT_ID)).toEqual([]);
    }
    expect(fills).toEqual([0.389, 0.344]);
    expect(fills[0]).toBeGreaterThan(w.n.reserveRatio);
    expect(fills[0]).toBeLessThan(w.n.triggerRatio);
    expect(answered()).toEqual([rival]);
    expect(tiles - w.nation.numTilesOwned()).toBe(99);
  });

  it("tribes are never answered, but their attacks enlarge the answer to us", () => {
    // us | nation | tribe
    const w = world({
      width: 60,
      height: 20,
      third: PlayerType.Bot,
      seat: (x) => (x < 20 ? "us" : x < 40 ? "nation" : "third"),
    });
    start(w, immunity(w));
    const tn = setFill(w, 0.8);
    const tribe = w.third!;
    tribe.setTroops(tn);
    const answered = retaliations(w);
    toEveOfDecision(w);
    const oursA = 10_000;
    const tribeA = 30_000;
    w.us.setTroops(Math.ceil(3.5 * tn) + oursA);
    ourAttack(w, oursA);
    // A tribe's attack as AiAttackBehavior builds it (:1107-1113).
    w.game.addExecution(new AttackExecution(tribeA, tribe, NATION_ID));
    tick(w);
    expect(w.nation.incomingAttacks()).toHaveLength(2);
    // The larger attack is the tribe's; the answer goes to us regardless,
    // sized by both.
    expect(predictAnswer(w)).toBe(oursA + tribeA);
    expect(decide(w)).toEqual([
      expect.objectContaining({ to: AGENT_ID, troops: oursA + tribeA }),
    ]);
    expect(answered()).toEqual([w.us]);
    const r = only(w.inits);
    expectOneToOne(r);
    expect(w.us.outgoingAttacks()).toEqual([]);
    // The tribe's share lands on us.
    expect(only(w.us.incomingAttacks()).troops()).toBe(
      oursA + tribeA - r.theirsBefore[0],
    );
    expect(only(outgoingOn(tribe, w.nation)).isActive()).toBe(true);
  });
});

describe("H5 NationRetaliate: when it does not answer", () => {
  /**
   * `decisions` decisions, each with the nation at `fill` of its cap, us at
   * 3.5x its troops and a fresh 100-troop attack of ours, tiles restored on
   * each eve. Counts the decisions that answered it and those that reached
   * attackBestTarget (past maybeAttack's random-boat return).
   */
  function answers(fill: (w: World) => number, decisions: number) {
    const w = world({ width: 40, height: 20, seat: halves });
    start(w, immunity(w));
    const answered = retaliations(w);
    const best = vi.spyOn(
      w.n.attackBehavior as unknown as { attackBestTarget(): void },
      "attackBestTarget",
    );
    let n = 0;
    for (let d = 0; d < decisions; d++) {
      toEveOfDecision(w);
      restore(w);
      const tn = setFill(w, fill(w));
      w.us.setTroops(Math.ceil(3.5 * tn) + 100);
      ourAttack(w, 100);
      tick(w);
      expect(sum(w.nation.incomingAttacks())).toBe(100);
      const onUs = decide(w).filter((s) => s.to === AGENT_ID);
      if (onUs.length > 0) {
        expect(onUs).toEqual([expect.objectContaining({ troops: 100 })]);
        n++;
      }
    }
    expect(answered()).toHaveLength(n);
    return { answered: n, reached: best.mock.calls.length };
  }

  const N = 200;

  it("below its reserve: never", () => {
    const r = answers((w) => w.n.reserveRatio - 0.01, N);
    // It reaches attackBestTarget and stops at the reserve gate (:290).
    expect(r).toEqual({ answered: 0, reached: 181 });
  });

  it("between reserve and trigger: 1 in 10 of the decisions that pass the boat roll, ~1 in 11 overall", () => {
    const r = answers((w) => (w.n.reserveRatio + w.n.triggerRatio) / 2, N);
    expect(r).toEqual({ answered: 16, reached: 180 });
    // Binomial sanity for 1 in 10 of 180 (sd ~4): the roll, not a bias.
    expect(r.answered / r.reached).toBeGreaterThan(0.05);
    expect(r.answered / r.reached).toBeLessThan(0.15);
  });

  it("above its trigger: every decision that passes the boat roll, ~9 in 10", () => {
    const r = answers(() => 0.8, N);
    expect(r).toEqual({ answered: 179, reached: 179 });
    // 9 in 10 pass maybeAttack's 1-in-10 boat roll (:148-151), sd ~4 of 200.
    expect(r.reached / N).toBeGreaterThan(0.85);
    expect(r.reached / N).toBeLessThan(0.95);
  });

  it("a neighbouring tribe that owns a structure comes first: it attacks the tribe, ours goes unanswered", () => {
    // us | nation | tribe, the tribe owning a city (attackBestTarget
    // :285-287, before the reserve gate and the strategy list).
    const w = world({
      width: 60,
      height: 20,
      third: PlayerType.Bot,
      seat: (x) => (x < 20 ? "us" : x < 40 ? "nation" : "third"),
    });
    start(w, immunity(w));
    const tribe = w.third!;
    tribe.buildUnit(UnitType.City, w.game.ref(50, 10), {});
    tribe.setTroops(5_000);
    const tn = setFill(w, 0.8);
    const answered = retaliations(w);
    toEveOfDecision(w);
    w.us.setTroops(Math.ceil(3.5 * tn) + 10_000);
    ourAttack(w, 10_000);
    tick(w);
    const ours = only(outgoingOn(w.us, w.nation));
    // attackBots sends 4x the tribe's troops (calculateBotAttackTroops
    // :1149-1166), within the send cap, which our attack raised to its own
    // size (:1024-1029), and returns before retaliate is tried.
    expect(w.n.attackBehavior.troopSendCap()).toBe(10_000);
    expect(decide(w)).toEqual([
      expect.objectContaining({
        to: THIRD_ID,
        troops: Math.min(4 * 5_000, 10_000),
      }),
    ]);
    expect(answered()).toEqual([]);
    expect(ours.isActive()).toBe(true);
    expect(w.us.incomingAttacks()).toEqual([]);
  });

  it("while it borders free land it only expands, with exactly the incoming total; after the land is gone it answers", () => {
    // us | nation | free land
    const w = world({
      width: 60,
      height: 20,
      seat: (x) => (x < 20 ? "us" : x < 40 ? "nation" : "free"),
    });
    start(w, immunity(w));
    const answered = retaliations(w);
    const freeLeft = () => {
      let n = 0;
      for (let y = 0; y < 20; y++) {
        for (let x = 40; x < 60; x++) {
          if (!w.game.hasOwner(w.game.ref(x, y))) n++;
        }
      }
      return n;
    };
    const free0 = freeLeft();
    let decisions = 0;
    while (decisions < 8 && freeLeft() > 0) {
      toEveOfDecision(w);
      restore(w);
      const tn = setFill(w, 0.8);
      w.us.setTroops(Math.ceil(3.5 * tn) + 500);
      ourAttack(w, 500);
      tick(w);
      const incoming = sum(w.nation.incomingAttacks());
      expect(w.n.attackBehavior.troopSendCap()).toBe(incoming);
      const expansion = Math.min(
        w.nation.troops() - w.config.maxTroops(w.nation) * w.n.expandRatio,
        incoming,
      );
      const sends = decide(w);
      decisions++;
      expect(sends).toEqual([
        expect.objectContaining({
          to: w.game.terraNullius().id(),
          troops: expansion,
        }),
      ]);
    }
    // The opening troops/2 took 10 tiles; each eve gives the rest back.
    expect([free0, decisions, freeLeft()]).toEqual([390, 8, 400]);
    expect(answered()).toEqual([]);

    // The free land runs out (here: taken by the test).
    toEveOfDecision(w);
    for (let y = 0; y < 20; y++) {
      for (let x = 40; x < 60; x++) w.nation.conquer(w.game.ref(x, y));
    }
    restore(w, false);
    const tn = setFill(w, 0.8);
    w.us.setTroops(Math.ceil(3.5 * tn) + 500);
    ourAttack(w, 500);
    tick(w);
    expect(decide(w)).toEqual([
      expect.objectContaining({ to: AGENT_ID, troops: 500 }),
    ]);
    expect(answered()).toEqual([w.us]);
  });
});

describe("H5 NationRetaliate: a live game with income", () => {
  it("with PlayerExecutions every send on us is min(surplus, cap), answers are 1:1; a strike above its surplus buys two decisions", () => {
    const w = world({ width: 40, height: 20, seat: halves });
    start(w, immunity(w));
    // The order of a real game: NationExecutions are added at GameRunner.init,
    // PlayerExecutions when players spawn, so the nation decides first.
    w.game.addExecution(new PlayerExecution(w.nation));
    w.game.addExecution(new PlayerExecution(w.us));
    // Equal land, both at their caps (ours is 0.8 of its, Config.maxTroops).
    setFill(w, 0.8);
    w.us.setTroops(Math.floor(w.config.maxTroops(w.us)));
    tick(w, 2);

    // One strike above its surplus from our standing army; then we idle.
    toEveOfDecision(w);
    const A = Math.round(1.25 * surplus(w));
    ourAttack(w, A);
    tick(w);
    const ours = only(outgoingOn(w.us, w.nation));
    interface Row {
      tick: number;
      fill: number;
      incoming: boolean;
      onUs: number[];
      oursActive: boolean;
      usTiles: number;
      surplusBinds: boolean;
    }
    const rows: Row[] = [];
    for (let t = 0; t < 600; t++) {
      if (!isDecisionTick(w)) {
        tick(w);
        continue;
      }
      const f = fillOf(w);
      const incoming = w.nation.incomingAttacks().length > 0;
      // Any land attack on us is sized the same way (sendLandAttack).
      const predicted = predictAnswer(w);
      const surplusBinds = predicted === surplus(w);
      const i = w.inits.length;
      const onUs = decide(w).filter((s) => s.to === AGENT_ID);
      if (f < w.n.reserveRatio) expect(onUs).toEqual([]);
      for (const s of onUs) expect(s.troops).toBe(predicted);
      if (onUs.length > 0 && incoming) expectOneToOne(w.inits[i]);
      rows.push({
        tick: w.game.ticks() - 1,
        fill: Math.round(f * 100) / 100,
        incoming,
        onUs: onUs.map((s) => Math.round(s.troops)),
        oursActive: ours.isActive(),
        usTiles: w.us.numTilesOwned(),
        surplusBinds,
      });
    }
    const brief = (r: Row) => [r.tick, r.fill, r.incoming, r.onUs];
    expect(rows.slice(0, 7).map(brief)).toEqual([
      // The answer: its whole surplus; our strike survives it.
      [77, 0.83, true, [106_872]],
      // Just above its reserve, below its trigger: our running attack is
      // not answered (the 1-in-10 roll).
      [107, 0.35, true, []],
      // Our attack is spent; it regrows ~0.08 of its cap per decision.
      [137, 0.41, false, []],
      [167, 0.5, false, []],
      // Past its trigger, and our home is thin: attacks on us (H4).
      [197, 0.58, false, [23_327]],
      [227, 0.53, false, []],
      [257, 0.6, false, [31_074]],
    ]);
    expect(rows[0].surplusBinds).toBe(true);
    expect(rows[0].oursActive).toBe(true);
    expect(rows[1].oursActive).toBe(true);
    expect(rows[2].oursActive).toBe(false);
    // The strike took 126 tiles; idle afterwards, we are gone by tick 437.
    expect(Math.max(...rows.map((r) => r.usTiles)) - 400).toBe(126);
    expect(rows.find((r) => r.usTiles === 0)?.tick).toBe(437);
  });
});
