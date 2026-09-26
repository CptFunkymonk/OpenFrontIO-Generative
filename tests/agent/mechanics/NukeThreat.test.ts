/**
 * Pins the nuke and MIRV threat from Impossible nations and what a SAM does
 * about it (roadmap H8, docs/11-roadmap.md §11.3; the risk table asks for
 * every mechanic an agent relies on to be pinned by a scenario test against
 * the real simulation).
 *
 * The claim ("NukeThreat", H8): nations nuke the largest incoming attacker
 * first; an Impossible nation also nukes the land leader once the leader is
 * more than 10 points of land ahead of it, unless allied
 * (findFFACrownTarget); Impossible nations MIRV anyone holding >= 40% of all
 * land tiles (fallout included) and the city leader with > 8 cities and
 * 1.15x the runner-up (NationMIRVBehavior) if they own a silo and can pay; a
 * MIRV cannot be intercepted and costs 25M rising 15M per launch; SAMs
 * intercept ordinary nukes (what range, what chance, what cost?).
 *
 * VERDICT: PARTIAL. The numbers are right, but the crown rule is the sixth
 * rung of a ladder, not a standing rule; a nation's aimed nukes only hit a
 * STRUCTURE it can reach unintercepted with clear land around it, and when
 * none qualifies it throws an atom salvo at the target's SAM instead (hydro
 * nations too, no clear-land check); "cities" are city levels; the MIRV
 * carrier cannot be intercepted but its warheads can, one per SAM
 * interceptor. The code is the spec (NationNukeBehavior.ts unless named):
 *
 * - Cadence: one nuke decision and one MIRV decision per nation decision
 *   tick, every 30-49 ticks at Impossible (NationExecution.ts:200-228;
 *   considerMIRV at :222 before maybeSendNuke at :228).
 * - WHO (findBestNukeTarget :222-316), the first rung that answers wins:
 *   0 exactly two players alive (tribes count; players() is the living,
 *     GameImpl.ts:691-693): the other one, even an ally (:224-233);
 *   1 the sender of the largest SINGLE incoming attack, not an ally's or a
 *     tribe's (AiAttackBehavior.findIncomingAttackPlayer :458-479). Attacks
 *     are not summed, but a new LAND attack absorbs its sender's other
 *     attacks on the same target (AttackExecution.init,
 *     AttackExecution.ts:171-181): only a boat landing (sourceTile set)
 *     stays a separate attack, so splitting a land attack does not dodge
 *     retaliation;
 *   2 the richest nation by gold (:318-326), 1 decision in 2: the player
 *     with the highest structure-level density above 1/75 per tile, level
 *     sum >= 5 (:44-47, :244-253, findHighDensityTarget :328-349);
 *   3 the tile leader if it holds > 50% of (land - fallout), not friendly
 *     (:256-274);
 *   4 a current target of an ally at relation >= Friendly (:277-287);
 *   5 the most hostile player (relation < -50, PlayerImpl.ts:946-957)
 *     unless the nation's maxTroops >= 2x its (:291-301);
 *   6 findFFACrownTarget (:351-417): the tile leader among ALL players,
 *     tribes included, if its share minus the nation's share of
 *     (numLandTiles - numTilesWithFallout) is > 0.1 (strict); never an ally,
 *     with no fallback; if the nation itself leads, the runner-up at ANY
 *     margin unless allied (:367-377).
 * - WHAT (maybeSendNuke :114-220): no silo, no nuke (:115-124); a tribe or
 *   teammate target ends it (:131-137, so a tribe on a rung blocks the rest;
 *   shouldAttack at :134 only refuses humans at Easy/Medium,
 *   AiAttackBehavior.ts:932-954). The TYPE (:139-155): a hydrogen bomb if
 *   gold >= its PERCEIVED price, else an atom bomb if gold >= its perceived
 *   price and the nation is not a "hydro nation" (random.chance(3), :60) or
 *   is under heavy attack (the troops of ALL incoming attacks, tribes' and
 *   allies' included, >= its troops, :533-544), else nothing. Perceived
 *   prices start at the real ones and grow x1.25 per hydro and x1.5 per
 *   atom launched (:814-823), unless the nation holds strictly more than
 *   MIRV + hydro, two players remain, or it is under heavy attack
 *   (:487-531). The type choice never downgrades a hydro to an atom, BUT a
 *   chosen type (hydro included) that finds no tile scoring > 0 falls
 *   through at Impossible to maybeDestroyEnemySam (:217-218), which fires
 *   ATOM bombs at one of the target's SAMs whatever isHydroNation says,
 *   with no ring or isValidNukeTile check (sendNuke(targetTile, AtomBomb)
 *   :1045-1051): it can blast the nation's own land. Its gates: atoms
 *   enabled (:837), none of its atoms in flight (:842-845), the target has
 *   a SAM (:848-851), a finished silo (:853-858), enough unblocked silo
 *   slots landing within SAMCooldown/2 = 45 ticks (:945-999), the REAL atom
 *   price x bombs fired (:1037-1041). The salvo is (sum of the levels of
 *   the enemy SAMs covering that SAM + 1) atoms plus 1 per 5 (:878-952);
 *   lacking slots it upgrades a silo instead (:1056-1060, :1093-1155).
 * - WHERE: 30 random tiles of the target plus its structures (:158-169); a
 *   tile qualifies at Impossible only if (a) both square rings
 *   (boundingBoxTiles, perimeter only, Util.ts:165-201) at the outer radius
 *   (atom 30, hydro 100) and half of it (15, 50) hold only the target's
 *   land or unowned tiles (:175-184, isValidNukeTile :686-704): the
 *   nation's own land and any third player's disqualify, land strictly
 *   between the rings does not; (b) canBuild(type, tile) finds a ready
 *   silo: finished, not on cooldown, spawn immunity over (:185-186,
 *   PlayerImpl.nukeSpawn :1625-1675); (c) no enemy SAM can reach the
 *   trajectory (:197-204, :603-684). The best must score > 0 (:212-216;
 *   nukeTileScore :706-804): structures within the outer radius (<=) score
 *   per level cities 25k, silos 50k, ports and factories 15k, defense posts
 *   5k; for a hydro, every SAM within 100 tiles below level 5 that it
 *   outranges (distance > samRange) adds 100k x level, whoever owns it
 *   (game.nearbyUnits, UnitGrid.ts:166-233); minus 30 per tile to the
 *   nearest silo, keeping 20%; minus 1M per recent aim point (sent in the
 *   last 600 ticks, :546-555) within that nuke's inner radius (atom 12,
 *   hydro 80). So a player without structures is never nuked by the tile
 *   search; only its SAMs draw the salvo above.
 * - MIRV (NationMIRVBehavior.considerMIRV :133-168): MIRVs enabled, a silo
 *   (:138), gold >= the price (:141), then 1 in 16 hesitates (:145, :66-80).
 *   Targets in order: (a) the largest player with a MIRV in flight at the
 *   nation (:171-179, :281-294); (b) the largest holder of >= 40% of
 *   numLandTiles(), fallout included (:86-100, :181-225); (c) the holder of
 *   the most city LEVELS (unitCount is level-weighted,
 *   PlayerImpl.ts:529-548) if > 8 and >= 1.15x the runner-up, who may be a
 *   tribe or the nation itself (:102-131, :227-254). Allies are fair game;
 *   only self, tribes and teammates are not (:268-279). A target MIRVed by
 *   ANY nation is skipped for 300 ticks (game.nationMirvTargets, :32,
 *   :257-265). Aim: calculateTerritoryCenter (Util.ts:306-354). Price 25M +
 *   15M x game.mirvsLaunched() (Config.ts:618-630), counted when any
 *   player's MIRV spawns (MIRVExecution.ts:107).
 * - SAM: range samRange(level) = 150 - 480 / (level + 5) = 70, 81.4, 90,
 *   96.7, 102 (Config.ts:1144-1151). No chance: the PseudoRandom at
 *   SAMLauncherExecution.ts:379 is never used and a missile that arrives
 *   deletes the nuke (SAMMissileExecution.ts:88-108). Level L = L
 *   interceptors, each reloading SAMCooldown() = 90 ticks after use
 *   (UnitImpl.ts:558-582, SAMLauncherExecution.ts:365-377). Only trajectory
 *   tiles within defaultNukeTargetableRange() = 150 of the launch or the aim
 *   point are targetable (NukeExecution.ts:347-372). Any non-friendly nuke is
 *   a target, whoever it is aimed at (SAMLauncherExecution.ts:197-215). The
 *   MIRV carrier is not on the list, its warheads are (:265,
 *   SAMMissileExecution.ts:63-73). Cost min(3M, (n + 1) x 1.5M): 1.5M for the
 *   first, 3M for every further SAM or upgrade (Config.ts:657-668,
 *   costWrapper :755-773); 300 ticks to build (Config.ts:204). A blast
 *   deletes every unit strictly inside its outer radius, whatever its level
 *   (NukeExecution.ts:467-483): a hydro's 100 outranges SAM levels 1-4.
 *
 * Setting: the real Config class as createGameRunner builds it
 * (GameRunner.ts:46), not TestConfig (tests/util/TestConfig.ts overrides
 * nukeMagnitudes, nukeSpeed, samRange and the targetable range), FFA,
 * Singleplayer, Impossible, bots 400 in the config (tribes are added by hand
 * where they matter); the game built as setup() builds it (createGame,
 * endSpawnPhase) on all-plains maps synthesized in memory. No
 * PlayerExecution runs, so gold, troops and relations stay where the test
 * puts them. The nation's behaviours are the ones
 * NationExecution.initializeBehaviors wires, seeded as in a game, and their
 * decisions are called directly; incoming attacks are "phantoms" (the Attack
 * object AttackExecution.init creates, alone), except in the merge test,
 * which runs real AttackExecutions. In a dry run the nukes and
 * MIRVs a decision creates are recorded, not run; elsewhere bombs, SAMs and
 * MIRVs fly in the real simulation.
 */
import { Config } from "../../../src/core/configuration/Config";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { MirvExecution } from "../../../src/core/execution/MIRVExecution";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { NukeExecution } from "../../../src/core/execution/NukeExecution";
import { SAMLauncherExecution } from "../../../src/core/execution/SAMLauncherExecution";
import { SAMMissileExecution } from "../../../src/core/execution/SAMMissileExecution";
import { UpgradeStructureExecution } from "../../../src/core/execution/UpgradeStructureExecution";
import { calculateTerritoryCenter } from "../../../src/core/execution/Util";
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
  PlayerInfo,
  PlayerType,
  Relation,
  Structures,
  Unit,
  UnitType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl, TileRef } from "../../../src/core/game/GameMap";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import { GameConfig } from "../../../src/core/Schemas";

const GAME_ID = "nuke-threat";

/** The arena's setting (ArenaGame.ts:179-204 arenaGameStart). */
function arenaConfig(): GameConfig {
  return {
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
}

// Terrain byte: bit 7 land, magnitude 5 (< 10 is plains), GameMap.ts.
const LAND = 0x80 | 5;

/** An all-land map and its half-size minimap. */
function plains(w: number, h: number): { map: GameMapImpl; mini: GameMapImpl } {
  const mw = Math.ceil(w / 2);
  const mh = Math.ceil(h / 2);
  return {
    map: new GameMapImpl(w, h, new Uint8Array(w * h).fill(LAND), w * h),
    mini: new GameMapImpl(mw, mh, new Uint8Array(mw * mh).fill(LAND), mw * mh),
  };
}

/** Which member owns (x, y); null leaves the tile unowned. */
type Seat = (x: number, y: number) => string | null;

interface Launch {
  kind: "nuke" | "mirv" | "samMissile" | "upgrade";
  from: Player;
  type?: UnitType;
  dst?: TileRef;
  target?: Unit;
}

interface World {
  game: Game;
  config: Config;
  p: Record<string, Player>;
  /** Every nuke, MIRV, SAM missile and upgrade execution, as constructed. */
  log: Launch[];
  /**
   * When true, nukes, MIRVs and upgrades are logged but not added: the
   * decision alone is pinned and the world does not change.
   */
  dryRun: boolean;
}

const idOf = (key: string) => `ID_${key}`.padEnd(8, "0");
const clientOf = (key: string) => `CL_${key}`.padEnd(8, "0");

/**
 * A game built the way tests/util/Setup.ts builds one (createGame, then
 * endSpawnPhase) but with the real Config class the arena uses
 * (GameRunner.ts: new Config(gameConfig, null, false)), not TestConfig
 * (which overrides nukeMagnitudes, samRange, nukeSpeed and the targetable
 * range, tests/util/TestConfig.ts). No PlayerExecution runs, so gold, troops
 * and relations stay where the test puts them.
 */
function world(
  width: number,
  height: number,
  members: Record<string, PlayerType>,
  seat: Seat,
): World {
  const { map, mini } = plains(width, height);
  const config = new Config(arenaConfig(), null, false);
  const humans: PlayerInfo[] = [];
  const nations: Nation[] = [];
  const bots: PlayerInfo[] = [];
  for (const [key, type] of Object.entries(members)) {
    const info = new PlayerInfo(
      key,
      type,
      type === PlayerType.Human ? clientOf(key) : null,
      idOf(key),
    );
    if (type === PlayerType.Human) humans.push(info);
    else if (type === PlayerType.Nation)
      nations.push(new Nation(new Cell(0, 0), info));
    else bots.push(info);
  }
  const game = createGame(humans, nations, map, mini, config);
  for (const info of bots) game.addPlayer(info);
  game.endSpawnPhase();
  const p: Record<string, Player> = {};
  for (const key of Object.keys(members)) p[key] = game.player(idOf(key));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = seat(x, y);
      if (s !== null) p[s].conquer(game.ref(x, y));
    }
  }
  const w: World = { game, config, p, log: [], dryRun: false };
  const add = game.addExecution.bind(game);
  game.addExecution = (...execs: Execution[]) => {
    const log = w.log;
    const keep: Execution[] = [];
    for (const e of execs) {
      const weapon =
        e instanceof NukeExecution ||
        e instanceof MirvExecution ||
        e instanceof UpgradeStructureExecution;
      if (!weapon || !w.dryRun) keep.push(e);
      if (e instanceof NukeExecution) {
        const v = e as unknown as {
          nukeType: UnitType;
          player: Player;
          dst: TileRef;
        };
        log.push({
          kind: "nuke",
          from: v.player,
          type: v.nukeType,
          dst: v.dst,
        });
      } else if (e instanceof MirvExecution) {
        const v = e as unknown as { player: Player; dst: TileRef };
        log.push({ kind: "mirv", from: v.player, dst: v.dst });
      } else if (e instanceof SAMMissileExecution) {
        const v = e as unknown as { _owner: Player; target: Unit };
        log.push({ kind: "samMissile", from: v._owner, target: v.target });
      } else if (e instanceof UpgradeStructureExecution) {
        const v = e as unknown as { player: Player };
        log.push({ kind: "upgrade", from: v.player });
      }
    }
    add(...keep);
  };
  return w;
}

/** Row-major runs of tiles: the first n1 tiles to k1, the next n2 to k2... */
function runs(width: number, sizes: [string, number][]): Seat {
  return (x, y) => {
    let i = y * width + x;
    for (const [key, n] of sizes) {
      if (i < n) return key;
      i -= n;
    }
    return null;
  };
}

function tick(w: World, n = 1): void {
  for (let i = 0; i < n; i++) w.game.executeNextTick();
}

/**
 * Nukes cannot be launched during spawn immunity: nukeSpawn refuses while
 * isSpawnImmunityActive (PlayerImpl.ts:1625-1629), i.e. for
 * spawnImmunityDuration() = 50 ticks after the spawn phase ends
 * (Config.ts:189, :335-339; GameImpl.ts:959-964).
 */
function pastImmunity(w: World): void {
  tick(w, w.config.spawnImmunityDuration() + 1);
  expect(w.game.isSpawnImmunityActive()).toBe(false);
}

/** NationNukeBehavior's members, private ones read through a cast. */
interface NukeBrain {
  findBestNukeTarget(): Player | null;
  findFFACrownTarget(): Player | null;
  maybeSendNuke(): void;
  isValidNukeTile(t: TileRef, target: Player | null): boolean;
  nukeTileScore(
    tile: TileRef,
    silos: Unit[],
    targets: Unit[],
    type: UnitType,
  ): number;
  removeOldNukeEvents(): void;
  isHydroNation: boolean;
  atomBombPerceivedCost: bigint;
  hydrogenBombPerceivedCost: bigint;
}

/** NationMIRVBehavior's members, private ones read through a cast. */
interface MirvBrain {
  considerMIRV(): boolean;
  selectCounterMirvTarget(): Player | null;
  selectVictoryDenialTarget(): Player | null;
  selectSteamrollStopTarget(): Player | null;
}

/**
 * The nuke and MIRV behaviours of `key`, wired by the real
 * NationExecution.initializeBehaviors (NationExecution.ts:231-280) and seeded
 * as in a game (PseudoRandom(hash(id) + hash(gameID)), :68-78). The
 * execution is never added to the game, so nothing else it does runs.
 */
function brain(
  w: World,
  key: string,
  gameID = GAME_ID,
): { nuke: NukeBrain; mirv: MirvBrain } {
  const exec = new NationExecution(
    gameID,
    new Nation(new Cell(0, 0), w.p[key].info()),
  );
  exec.init(w.game);
  const x = exec as unknown as {
    initializeBehaviors(): void;
    nukeBehavior: NukeBrain;
    mirvBehavior: MirvBrain;
  };
  x.initializeBehaviors();
  return { nuke: x.nukeBehavior, mirv: x.mirvBehavior };
}

/** A phantom attack: the Attack object AttackExecution.init creates, alone. */
function attack(from: Player, to: Player, troops: number): { delete(): void } {
  return from.createAttack(to, troops, null, new Set<TileRef>());
}

function ally(a: Player, b: Player): void {
  const req = a.createAllianceRequest(b);
  if (req === null) throw new Error("no alliance request");
  req.accept();
  expect(a.isAlliedWith(b)).toBe(true);
}

function setGold(p: Player, gold: bigint): void {
  p.removeGold(p.gold());
  p.addGold(gold);
  expect(p.gold()).toBe(gold);
}

function cost(w: World, type: UnitType, p: Player): bigint {
  return w.game.unitInfo(type).cost(w.game, p);
}

const nukes = (w: World, from?: Player) =>
  w.log.filter((l) => l.kind === "nuke" && (!from || l.from === from));
const mirvs = (w: World) => w.log.filter((l) => l.kind === "mirv");
const samMissiles = (w: World) => w.log.filter((l) => l.kind === "samMissile");

/** Extra private members of NationNukeBehavior used by one test. */
interface DensityBrain {
  findHighDensityTarget(): Player | null;
}

/** A 100 x 100 plain: 10,000 land tiles, so 1 tile = 0.01 points. */
const SIDE = 100;

/** Puts fallout on the first `n` unowned tiles (setFallout needs no owner). */
function fallout(w: World, n: number): void {
  let left = n;
  for (let t = 0; t < SIDE * SIDE && left > 0; t++) {
    if (!w.game.hasOwner(t)) {
      w.game.setFallout(t, true);
      left--;
    }
  }
  expect(w.game.numTilesWithFallout()).toBe(n);
}

/** Gives up `n` tiles of `p` (the last ones it holds). */
function shed(p: Player, n: number): void {
  const tiles = [...p.tiles()].slice(-n);
  for (const t of tiles) p.relinquish(t);
}

describe("H8 who a nation nukes: NationNukeBehavior.findBestNukeTarget", () => {
  it("retaliation comes first: the sender of the largest SINGLE incoming attack (not the largest total); allies' and tribes' attacks are ignored", () => {
    // L holds 60% of the land and N hates L: both lower rungs are live.
    const w = world(
      SIDE,
      SIDE,
      {
        N: PlayerType.Nation,
        L: PlayerType.Human,
        A: PlayerType.Human,
        B: PlayerType.Nation,
        C: PlayerType.Human,
        T: PlayerType.Bot,
      },
      runs(SIDE, [
        ["L", 6000],
        ["N", 1000],
        ["A", 500],
        ["B", 500],
        ["C", 500],
        ["T", 500],
      ]),
    );
    const { N, L, A, B, C, T } = w.p;
    N.updateRelation(L, -100);
    ally(N, C);
    const { nuke } = brain(w, "N");
    attack(A, N, 2000);
    attack(A, N, 2000); // A's total, 4,000, beats B's 3,000 ...
    const b = attack(B, N, 3000); // ... but B's is the largest single attack
    attack(C, N, 9000); // an ally's attack: ignored (isFriendly)
    attack(T, N, 9000); // a tribe's attack: ignored for a non-tribe
    expect(nuke.findBestNukeTarget()).toBe(B);
    b.delete();
    expect(nuke.findBestNukeTarget()).toBe(A);
  });

  it("with real AttackExecutions a second LAND attack absorbs the first (AttackExecution.ts:171-181), so splitting does not dodge retaliation; only a boat landing stays separate", () => {
    // Row-major stripes: A borders N, N borders B.
    const make = () => {
      const w = world(
        SIDE,
        SIDE,
        { A: PlayerType.Human, N: PlayerType.Nation, B: PlayerType.Human },
        runs(SIDE, [
          ["A", 3000],
          ["N", 3000],
          ["B", 3000],
        ]),
      );
      w.p.A.addTroops(100_000);
      w.p.B.addTroops(100_000);
      pastImmunity(w);
      return w;
    };
    const fromA = (w: World) =>
      w.p.N.incomingAttacks()
        .filter((a) => a.attacker() === w.p.A)
        .map((a) => a.troops());
    // Two land clicks by A in one tick: one attack of 4,000 beats B's 3,000.
    let w = make();
    const nId = w.p.N.id();
    w.game.addExecution(
      new AttackExecution(2000, w.p.A, nId),
      new AttackExecution(2000, w.p.A, nId),
      new AttackExecution(3000, w.p.B, nId),
    );
    tick(w); // init only: new executions tick from the next step
    expect(fromA(w)).toEqual([4000]);
    expect(brain(w, "N").nuke.findBestNukeTarget()).toBe(w.p.A);
    // A land attack then a boat landing (sourceTile = the landing tile,
    // removeTroops false, as TransportShipExecution.ts:275-283 creates it):
    // the landing does not absorb, so A's 2,000 + 2,000 lose to B's single
    // 3,000. (A later land click would absorb the landing too.)
    w = make();
    const landing = [...w.p.A.tiles()][2950]; // A's last row, next to N
    w.game.addExecution(
      new AttackExecution(2000, w.p.A, nId),
      new AttackExecution(2000, w.p.A, nId, landing, false),
      new AttackExecution(3000, w.p.B, nId),
    );
    tick(w);
    expect(fromA(w)).toEqual([2000, 2000]);
    expect(brain(w, "N").nuke.findBestNukeTarget()).toBe(w.p.B);
  });

  it("then, in this order with every lower rung live: a crown above 50% of non-fallout land, an ally's target, the most hostile player that is not much weaker, and only then findFFACrownTarget", () => {
    const w = world(
      SIDE,
      SIDE,
      {
        N: PlayerType.Nation,
        L: PlayerType.Human,
        A: PlayerType.Human,
        C: PlayerType.Human,
        H: PlayerType.Human,
        W: PlayerType.Human,
      },
      runs(SIDE, [
        ["L", 5001],
        ["N", 1000],
        ["A", 300],
        ["C", 300],
        ["H", 300],
        ["W", 10],
      ]),
    );
    const { N, L, A, C, H, W } = w.p;
    const { nuke } = brain(w, "N");
    // N hates W most, but W is "much weaker" (N's maxTroops >= 2x W's);
    // H at -90 (< -50 is Hostile, PlayerImpl.ts:946-957) is not.
    N.updateRelation(W, -100);
    N.updateRelation(H, -90);
    expect(w.config.maxTroops(N)).toBeGreaterThanOrEqual(
      2 * w.config.maxTroops(W),
    );
    expect(w.config.maxTroops(N)).toBeLessThan(2 * w.config.maxTroops(H));
    // Rung 4 is live too: an ally's current target (:277-287); the ally must
    // be at relation >= Friendly (>= 50, PlayerImpl.ts:946-957).
    ally(N, C);
    N.updateRelation(C, 100);
    expect(N.relation(C)).toBeGreaterThanOrEqual(Relation.Friendly);
    C.target(A);
    // Rung 3: L holds 50.01% > 50% (NationNukeBehavior.ts:256-274), ahead
    // of the ally's target A, the hated H and the crown rule.
    expect(nuke.findBestNukeTarget()).toBe(L);
    // At exactly 50% the rung is skipped: the test is strict.
    shed(L, 1);
    expect(L.numTilesOwned()).toBe(5000);
    // Rung 4 now answers, ahead of the hated H (rung 5) and L (rung 6).
    expect(nuke.findBestNukeTarget()).toBe(A);
    N.updateRelation(C, -60); // 40: Neutral, the ally rung is skipped
    expect(N.relation(C)).toBeLessThan(Relation.Friendly);
    // Rung 5: relations from the most hostile (:291-301): W is skipped as
    // much weaker (:297-298), H is the target, ahead of L (rung 6).
    expect(nuke.findBestNukeTarget()).toBe(H);
    // Rung 6: with nobody hostile, findFFACrownTarget: L leads N by 40 points.
    N.updateRelation(H, 90);
    N.updateRelation(W, 100);
    expect(nuke.findBestNukeTarget()).toBe(L);
  });

  it("with exactly two players alive, an Impossible nation targets the other one, even an ally", () => {
    const w = world(
      SIDE,
      SIDE,
      { N: PlayerType.Nation, A: PlayerType.Human },
      runs(SIDE, [
        ["N", 5000],
        ["A", 100],
      ]),
    );
    ally(w.p.N, w.p.A);
    expect(w.game.players()).toHaveLength(2);
    expect(brain(w, "N").nuke.findBestNukeTarget()).toBe(w.p.A);
  });

  it("the richest nation, 1 decision in 2, hunts the player with the densest structures, level sum >= 5 and strictly above 1/75 per tile, ahead of even a > 50% crown", () => {
    const w = world(
      SIDE,
      SIDE,
      {
        N: PlayerType.Nation,
        Q: PlayerType.Nation,
        L: PlayerType.Human,
        D: PlayerType.Human,
        E: PlayerType.Human,
      },
      runs(SIDE, [
        ["L", 5001],
        ["N", 1000],
        ["Q", 1000],
        ["D", 100],
        ["E", 375],
      ]),
    );
    const { N, Q, L, D, E } = w.p;
    // One level-1 city on every 10th tile of p, from its `from`-th city on.
    const city = (p: Player, n: number, from = 0) => {
      const tiles = [...p.tiles()];
      for (let i = from; i < from + n; i++)
        p.buildUnit(UnitType.City, tiles[i * 10], {});
    };
    const dense = () =>
      (brain(w, "N").nuke as unknown as DensityBrain).findHighDensityTarget();
    // D: 4 levels on 100 tiles, density 0.04 >> 1/75, but the level sum is
    // below the minimum of 5 (MIN_LEVEL_SUM_FOR_HIGH_DENSITY_NUKE :47, :341).
    city(D, 4);
    // E: 5 levels on 375 tiles, density EXACTLY 1/75 (both sides round to
    // the same double): the strict > at :343 rejects it.
    city(E, 5);
    expect(5 / 375).toBe(1 / 75);
    expect(dense()).toBeNull();
    shed(E, 1); // 5 / 374 > 1/75
    expect(dense()).toBe(E);
    city(D, 1, 4); // 5 / 100 = 0.05: the densest wins (:342-346)
    expect(dense()).toBe(D);
    // random.chance(2) per decision (:244-253), before the crown (:256).
    const picks = (): Record<string, number> => {
      const count: Record<string, number> = {};
      for (let g = 0; g < 60; g++) {
        const t = brain(w, "N", `dense-${g}`).nuke.findBestNukeTarget();
        const k = t === D ? "D" : t === L ? "L" : "other";
        count[k] = (count[k] ?? 0) + 1;
      }
      return count;
    };
    const rich = picks();
    expect(rich.other).toBeUndefined();
    expect(rich.D).toBeGreaterThan(15);
    expect(rich.L).toBeGreaterThan(15);
    // Only the richest nation (by gold, ties included) does it (:318-326).
    setGold(N, 0n);
    setGold(Q, 1n);
    expect(picks()).toEqual({ L: 60 });
  });
});

describe("H8 the crown rule: NationNukeBehavior.findFFACrownTarget", () => {
  const crown = (sizes: [string, number][], leaderType = PlayerType.Human) =>
    world(
      SIDE,
      SIDE,
      {
        N: PlayerType.Nation,
        L: leaderType,
        S: PlayerType.Human,
        T: PlayerType.Bot,
      },
      runs(SIDE, sizes),
    );

  it("targets the land leader only when it leads by MORE than 10 points of (land - fallout)", () => {
    // 2,000 vs 1,000 of 10,000: 0.2 - 0.1 = 0.1, not > 0.1 (:390-414).
    let w = crown([
      ["L", 2000],
      ["N", 1000],
      ["S", 500],
      ["T", 100],
    ]);
    expect(brain(w, "N").nuke.findFFACrownTarget()).toBeNull();
    // One more tile: 0.2001 - 0.1 > 0.1.
    w = crown([
      ["L", 2001],
      ["N", 1000],
      ["S", 500],
      ["T", 100],
    ]);
    expect(brain(w, "N").nuke.findFFACrownTarget()).toBe(w.p.L);
    // Fallout shrinks the denominator (:384-391): with 1,000 fallout tiles
    // 2,000 vs 1,000 is 22.2% vs 11.1%, a lead of 11.1 points.
    w = crown([
      ["L", 2000],
      ["N", 1000],
      ["S", 500],
      ["T", 100],
    ]);
    fallout(w, 1000);
    expect(brain(w, "N").nuke.findFFACrownTarget()).toBe(w.p.L);
  });

  it("never targets an allied leader (and does not fall back to second place)", () => {
    const w = crown([
      ["L", 5000],
      ["N", 1000],
      ["S", 900],
      ["T", 100],
    ]);
    ally(w.p.N, w.p.L);
    expect(brain(w, "N").nuke.findFFACrownTarget()).toBeNull();
  });

  it("a nation that leads targets the runner-up at ANY margin, unless allied", () => {
    const w = crown([
      ["N", 3000],
      ["S", 2999],
      ["L", 100],
      ["T", 100],
    ]);
    expect(brain(w, "N").nuke.findFFACrownTarget()).toBe(w.p.S);
    ally(w.p.N, w.p.S);
    expect(brain(w, "N").nuke.findFFACrownTarget()).toBeNull();
  });

  it("the leader is ranked among ALL players, tribes included: a leading tribe blocks the rule, since maybeSendNuke never nukes a tribe", () => {
    const w = crown(
      [
        ["L", 3000],
        ["N", 1000],
        ["S", 500],
        ["T", 100],
      ],
      PlayerType.Bot,
    );
    expect(w.p.L.type()).toBe(PlayerType.Bot);
    const { nuke } = brain(w, "N");
    expect(nuke.findFFACrownTarget()).toBe(w.p.L);
    expect(nuke.findBestNukeTarget()).toBe(w.p.L);
    // With silo, gold and a city in reach, a tribe crown gets no nuke (the
    // gate at :131-137); the same map with a human crown does.
    for (const hType of [PlayerType.Bot, PlayerType.Human] as const) {
      const s = strikeWorld({ hType, attacked: false });
      s.dryRun = true;
      s.p.H.buildUnit(UnitType.City, s.game.ref(220, 150), {});
      const b = brainWith(s, "N", false).nuke;
      setGold(s.p.N, 10_000_000n);
      expect(b.findBestNukeTarget()).toBe(s.p.H); // > 50% crown
      b.maybeSendNuke();
      expect(nukes(s)).toHaveLength(hType === PlayerType.Bot ? 0 : 1);
    }
  });
});

/** Runs until no nuke, MIRV or warhead is in flight (at least `min` ticks). */
function settle(w: World, min = 2, max = 400): number {
  let n = 0;
  const flying = () =>
    w.game.units(UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRVWarhead)
      .length +
    w.game.units(UnitType.MIRV).length +
    w.game.units(UnitType.SAMMissile).length;
  while (n < min || (flying() > 0 && n < max)) {
    tick(w);
    n++;
  }
  expect(flying()).toBe(0);
  return n;
}

function dist(w: World, a: TileRef, b: TileRef): number {
  return Math.sqrt(w.game.euclideanDistSquared(a, b));
}

/** A SAM at (x, y) raised to `level`, with its execution. */
function samAt(w: World, owner: Player, x: number, y: number, level = 1): Unit {
  const u = owner.buildUnit(UnitType.SAMLauncher, w.game.ref(x, y), {});
  for (let l = 1; l < level; l++) u.increaseLevel();
  w.game.addExecution(new SAMLauncherExecution(owner, null, u));
  return u;
}

/**
 * Past spawn immunity and long enough for an upgraded SAM's new slots to
 * reload (SAMCooldown 90 ticks; a level gained arrives on cooldown,
 * UnitImpl.increaseLevel :738-757) and its range to grow (45 ticks,
 * Config.samUpgradeDuration).
 */
function ready(w: World): void {
  tick(
    w,
    Math.max(w.config.spawnImmunityDuration(), w.config.SAMCooldown()) + 1,
  );
  expect(w.game.isSpawnImmunityActive()).toBe(false);
}

/** A nation brain whose isHydroNation draw (NationNukeBehavior.ts:60) is `hydro`. */
function brainWith(
  w: World,
  key: string,
  hydro: boolean,
): { nuke: NukeBrain; mirv: MirvBrain } {
  for (let g = 0; g < 50; g++) {
    const b = brain(w, key, `${GAME_ID}-${g}`);
    if (b.nuke.isHydroNation === hydro) return b;
  }
  throw new Error("no such seed");
}

/**
 * N on the left (x < 40), H the rest; a small tribe T in H's top-right
 * corner keeps the player count at 3 (with 2 the rules change,
 * :224-233, :489-491). N has a silo, 1M troops and is attacked by H, so H
 * is its target (retaliation).
 */
function strikeWorld(
  opts: {
    sandwich?: boolean;
    silos?: number;
    hType?: PlayerType.Human | PlayerType.Bot;
    attacked?: boolean;
  } = {},
): World {
  const w = world(
    300,
    300,
    {
      N: PlayerType.Nation,
      H: opts.hType ?? PlayerType.Human,
      Z: PlayerType.Human,
      T: PlayerType.Bot,
    },
    (x, y) => {
      if (x < 40) return "N";
      if (opts.sandwich && x >= 140) return "Z";
      if (!opts.sandwich && x >= 290 && y < 10) return "T";
      return "H";
    },
  );
  const { N, H } = w.p;
  for (let i = 0; i < (opts.silos ?? 1); i++)
    N.buildUnit(UnitType.MissileSilo, w.game.ref(20, 150 + 10 * i), {});
  N.addTroops(1_000_000);
  if (opts.attacked ?? true) attack(H, N, 1000);
  ready(w);
  return w;
}

describe("H8 where and with what an Impossible nation nukes: maybeSendNuke", () => {
  it("an AIMED nuke fires only at a tile scoring > 0, i.e. with a City, Port, Factory, Silo or Defense Post in the blast: a player without structures is never nuked", () => {
    const w = strikeWorld();
    const { N, H } = w.p;
    w.dryRun = true;
    const { nuke } = brainWith(w, "N", false);
    setGold(N, 1_000_000n); // an atom (750k), not a hydro (5M)
    expect(nuke.findBestNukeTarget()).toBe(H);
    nuke.maybeSendNuke();
    expect(nukes(w)).toHaveLength(0); // bestValue 0 is not > 0 (:212-219)
    const city = w.game.ref(220, 150);
    H.buildUnit(UnitType.City, city, {});
    nuke.maybeSendNuke();
    expect(nukes(w)).toHaveLength(1);
    const [n] = nukes(w);
    expect(n.type).toBe(UnitType.AtomBomb);
    expect(w.game.owner(n.dst!)).toBe(H);
    expect(dist(w, n.dst!, city)).toBeLessThanOrEqual(
      w.config.nukeMagnitudes(UnitType.AtomBomb).outer,
    );
  });

  it("throws a hydrogen bomb whenever it can pay the PERCEIVED price, which rises 25% per hydro (50% per atom) to save for a MIRV; holding STRICTLY more than MIRV + hydro, the real price applies", () => {
    const w = strikeWorld();
    const { N, H } = w.p;
    w.dryRun = true;
    const { nuke } = brainWith(w, "N", false);
    const city = w.game.ref(220, 150);
    H.buildUnit(UnitType.City, city, {});
    const hydro = cost(w, UnitType.HydrogenBomb, N);
    const atom = cost(w, UnitType.AtomBomb, N);
    expect(nuke.hydrogenBombPerceivedCost).toBe(hydro);
    setGold(N, hydro);
    nuke.maybeSendNuke();
    expect(nukes(w).map((n) => n.type)).toEqual([UnitType.HydrogenBomb]);
    const h = nukes(w)[0].dst!;
    expect(dist(w, h, city)).toBeLessThanOrEqual(
      w.config.nukeMagnitudes(UnitType.HydrogenBomb).outer,
    );
    // Perceived hydro price now 5M x 1.25 (:819-822).
    expect(nuke.hydrogenBombPerceivedCost).toBe((hydro * 125n) / 100n);
    // 6M buys a real hydro but not a perceived one: an atom instead.
    setGold(N, 6_000_000n);
    nuke.maybeSendNuke();
    expect(nukes(w).map((n) => n.type)).toEqual([
      UnitType.HydrogenBomb,
      UnitType.AtomBomb,
    ]);
    expect(nuke.atomBombPerceivedCost).toBe((atom * 150n) / 100n);
    // Holding STRICTLY more than MIRV + hydro, the real price applies
    // (:507-513). To see it the perceived price must exceed that sum: after
    // 9 hydros it is 5M x 1.25^9 = 37.25M > 30M. A fresh brain (same seed,
    // no recent aim points) is given that state.
    let after9 = hydro;
    for (let i = 0; i < 9; i++) after9 = (after9 * 125n) / 100n;
    const both = cost(w, UnitType.MIRV, N) + hydro;
    expect(after9).toBeGreaterThan(both + 1n);
    const fresh = () => {
      const b = brainWith(w, "N", false).nuke;
      b.hydrogenBombPerceivedCost = after9;
      w.log.length = 0;
      return b;
    };
    setGold(N, both); // not > MIRV + hydro: the 37M perceived price holds
    fresh().maybeSendNuke();
    expect(nukes(w).map((n) => n.type)).toEqual([UnitType.AtomBomb]);
    setGold(N, both + 1n);
    fresh().maybeSendNuke();
    expect(nukes(w).map((n) => n.type)).toEqual([UnitType.HydrogenBomb]);
  });

  it("a 'hydro nation' (isHydroNation, 1 in 3) with only atom money throws no aimed atom bomb unless the incoming troops reach its own (>=, all attacks summed)", () => {
    const w = strikeWorld(); // H already attacks N with 1,000
    const { N, H } = w.p;
    w.dryRun = true;
    H.buildUnit(UnitType.City, w.game.ref(220, 150), {});
    const { nuke } = brainWith(w, "N", true);
    setGold(N, 1_000_000n);
    nuke.maybeSendNuke();
    expect(nukes(w)).toHaveLength(0);
    // isUnderHeavyAttack sums every incoming attack and compares with >=
    // (:533-544): 1,000 + (troops - 1,001) is one short ...
    const short = attack(H, N, N.troops() - 1001);
    nuke.maybeSendNuke();
    expect(nukes(w)).toHaveLength(0);
    short.delete();
    // ... and 1,000 + (troops - 1,000) is exactly N's troops.
    attack(H, N, N.troops() - 1000);
    nuke.maybeSendNuke();
    expect(nukes(w).map((n) => n.type)).toEqual([UnitType.AtomBomb]);
    // The draw is random.chance(3) per nation and game (94 of 300 here).
    let hydroNations = 0;
    for (let g = 0; g < 300; g++)
      if (brain(w, "N", `seed-${g}`).nuke.isHydroNation) hydroNations++;
    expect(hydroNations).toBeGreaterThan(80);
    expect(hydroNations).toBeLessThan(120);
  });

  it("a hydro needs its square rings (Chebyshev 100 and 50) around the aim point free of every other player's land, the nation's own included; at a target WITHOUT SAMs a nation that can afford a hydro then fires nothing (no fallback to an aimed atom)", () => {
    // H is a 100-wide strip between N (x < 40) and Z (x >= 140): every
    // ring of radius 100 around an H tile touches N or Z.
    const w = strikeWorld({ sandwich: true });
    const { N, H } = w.p;
    w.dryRun = true;
    const city = w.game.ref(90, 150);
    H.buildUnit(UnitType.City, city, {});
    const { nuke } = brainWith(w, "N", false);
    setGold(N, 10_000_000n);
    nuke.maybeSendNuke();
    expect(nukes(w)).toHaveLength(0);
    // With only atom money the rings are 30 and 15 and the city is hit.
    setGold(N, 1_000_000n);
    nuke.maybeSendNuke();
    expect(nukes(w).map((n) => n.type)).toEqual([UnitType.AtomBomb]);
    expect(dist(w, nukes(w)[0].dst!, city)).toBeLessThanOrEqual(30);
    // The per-tile test (isValidNukeTile :686-704): the target's land and
    // unowned land pass; the nation's own and a third player's fail.
    const valid = (x: number, y: number) =>
      nuke.isValidNukeTile(w.game.ref(x, y), H);
    w.p.Z.relinquish(w.game.ref(299, 299));
    expect([
      valid(90, 150),
      valid(299, 299),
      valid(20, 150),
      valid(200, 150),
    ]).toEqual([true, true, false, false]);
  });

  it("the rings are perimeters at BOTH radii (atom: Chebyshev 30 and 15): a third player's land on either ring blocks the aim, land strictly between them does not, and is blasted", () => {
    const { outer } = new Config(arenaConfig(), null, false).nukeMagnitudes(
      UnitType.AtomBomb,
    );
    const half = Math.floor(outer / 2); // :179
    expect([outer, half]).toEqual([30, 15]);
    // H: a 5 x 5 patch around C = (120, 100) in unowned land, so every
    // candidate tile is within Chebyshev 2 of C and the city on C is in
    // every blast. Z: a one-tile square ring at Chebyshev `ring` from C, and
    // a far corner that keeps three players alive in every case.
    const C = { x: 120, y: 100 };
    const enclave = (ring: number | null) => {
      const w = world(
        200,
        200,
        { N: PlayerType.Nation, H: PlayerType.Human, Z: PlayerType.Human },
        (x, y) => {
          if (x < 30) return "N";
          const d = Math.max(Math.abs(x - C.x), Math.abs(y - C.y));
          if (d <= 2) return "H";
          if (d === ring) return "Z";
          if (x >= 190 && y >= 190) return "Z";
          return null;
        },
      );
      const { N, H } = w.p;
      N.buildUnit(UnitType.MissileSilo, w.game.ref(15, 100), {});
      N.addTroops(1_000_000);
      attack(H, N, 1000); // H is N's target (retaliation)
      H.buildUnit(UnitType.City, w.game.ref(C.x, C.y), {});
      ready(w);
      const { nuke } = brainWith(w, "N", false);
      setGold(N, 1_000_000n); // atom money only
      return { w, nuke };
    };
    const fired = (ring: number | null) => {
      const { w, nuke } = enclave(ring);
      w.dryRun = true;
      nuke.maybeSendNuke();
      return nukes(w).map((n) => n.type);
    };
    expect(fired(null)).toEqual([UnitType.AtomBomb]); // control
    expect(fired(outer)).toEqual([]); // the outer ring (:177)
    expect(fired(half)).toEqual([]); // the half ring (:179)
    expect(fired(20)).toEqual([UnitType.AtomBomb]); // between: unchecked
    // For real: the atom lands in the patch and takes some of Z's ring.
    const { w, nuke } = enclave(20);
    const zTiles = w.p.Z.numTilesOwned();
    nuke.maybeSendNuke();
    settle(w);
    expect(w.p.Z.numTilesOwned()).toBeLessThan(zTiles);
  });

  it("but a chosen type that finds no aim tile falls through to maybeDestroyEnemySam (:217-218): with hydro money at a ring-blocked target that owns a SAM, a hydro nation too fires an ATOM salvo at the SAM, with no ring check, even onto its own land", () => {
    const salvo = (hydroNation: boolean, samX: number, gold: bigint) => {
      const w = strikeWorld({ sandwich: true, silos: 2 });
      const { N, H } = w.p;
      H.buildUnit(UnitType.City, w.game.ref(90, 150), {});
      const sam = samAt(w, H, samX, 150);
      tick(w, 2);
      const { nuke } = brainWith(w, "N", hydroNation);
      setGold(N, gold);
      return { w, sam, nuke };
    };
    for (const hydroNation of [false, true]) {
      const { w, sam, nuke } = salvo(hydroNation, 95, 10_000_000n);
      w.dryRun = true;
      // Not under heavy attack: H's 1,000 against N's ~1M troops.
      expect(w.p.N.troops()).toBeGreaterThan(1000);
      nuke.maybeSendNuke();
      // (level 1 + 1) atoms at the SAM's own tile (:878-883, :1045-1051).
      expect(nukes(w).map((n) => [n.type, n.dst])).toEqual([
        [UnitType.AtomBomb, sam.tile()],
        [UnitType.AtomBomb, sam.tile()],
      ]);
    }
    // A hydro nation with only atom money stops at the type choice
    // (:153-155), before any salvo.
    {
      const { w, nuke } = salvo(true, 95, 1_000_000n);
      w.dryRun = true;
      nuke.maybeSendNuke();
      expect(nukes(w)).toHaveLength(0);
    }
    // The SAM 10 tiles from N's border (x < 40): the salvo still flies and
    // the blast takes some of N's own land.
    const { w, sam, nuke } = salvo(true, 50, 10_000_000n);
    const own = w.p.N.numTilesOwned();
    nuke.maybeSendNuke();
    expect(nukes(w).map((n) => n.type)).toEqual([
      UnitType.AtomBomb,
      UnitType.AtomBomb,
    ]);
    settle(w);
    expect(samMissiles(w)).toHaveLength(1);
    expect(sam.isActive()).toBe(false);
    expect(w.p.N.numTilesOwned()).toBeLessThan(own);
  });

  it("the tile score (nukeTileScore :706-804): structure levels within the outer radius, a hydro's bonus for each outranged SAM of any owner, the silo-distance penalty with its 20% floor, and -1M near a recent aim point for 600 ticks", () => {
    const w = strikeWorld();
    const { N, H } = w.p;
    w.dryRun = true;
    const nuke = brainWith(w, "N", false).nuke;
    const silos = N.units(UnitType.MissileSilo);
    expect(silos.map((u) => u.tile())).toEqual([w.game.ref(20, 150)]);
    const at = (x: number, y: number) => w.game.ref(x, y);
    const put = (
      owner: Player,
      type: UnitType,
      x: number,
      y: number,
      level = 1,
    ) => {
      const u = owner.buildUnit(type, at(x, y), {});
      for (let l = 1; l < level; l++) u.increaseLevel();
      return u;
    };
    const score = (
      tile: TileRef,
      targets: Unit[],
      type: UnitType = UnitType.AtomBomb,
    ) => nuke.nukeTileScore(tile, silos, targets, type);
    // P is 100 tiles from the silo: a penalty of 100 x 30 = 3,000 (:780-789).
    const P = at(120, 150);
    const pen = 100 * 30;
    expect(score(P, [])).toBe(0);
    const priced: [UnitType, number, number][] = [
      [UnitType.City, 1, 25_000],
      [UnitType.City, 3, 75_000],
      [UnitType.MissileSilo, 1, 50_000],
      [UnitType.MissileSilo, 2, 100_000],
      [UnitType.Port, 1, 15_000],
      [UnitType.Factory, 1, 15_000],
      [UnitType.DefensePost, 1, 5_000],
      [UnitType.SAMLauncher, 1, 0],
    ];
    for (const [type, level, value] of priced) {
      const u = put(H, type, 125, 150, level);
      expect(score(P, [u])).toBe(Math.max(value * 0.2, value - pen));
      u.delete(false);
    }
    // The outer radius is inclusive (euclDistFN <=, GameMap.ts:715-723).
    expect(score(P, [put(H, UnitType.City, 150, 150)])).toBe(25_000 - pen);
    expect(score(P, [put(H, UnitType.City, 151, 150)])).toBe(0);
    // The 20% floor: a defense post 150 tiles out, 5,000 - 4,500 < 1,000.
    const far = at(170, 150);
    expect(score(far, [put(H, UnitType.DefensePost, 170, 150)])).toBe(1_000);
    // Hydro only: +100k x level for every SAM within 100 tiles, below level
    // 5, farther than its range (:749-778). Q is 200 from the silo.
    const Q = at(220, 150);
    const qpen = 200 * 30;
    const withSam = (
      owner: Player,
      x: number,
      y: number,
      level: number,
      tile = Q,
      type: UnitType = UnitType.HydrogenBomb,
    ) => {
      const s = put(owner, UnitType.SAMLauncher, x, y, level);
      const v = score(tile, [], type);
      s.delete(false);
      return v;
    };
    expect(withSam(H, 220, 210, 1)).toBe(0); // 60 <= 70: not outranged
    expect(w.config.samRange(1)).toBe(70);
    expect(withSam(H, 220, 220, 1)).toBe(0); // exactly 70: > is strict
    expect(withSam(H, 220, 230, 1)).toBe(100_000 - qpen); // 80 > 70
    expect(withSam(H, 220, 230, 1, Q, UnitType.AtomBomb)).toBe(0);
    expect(withSam(H, 220, 235, 2)).toBe(200_000 - qpen); // 85 > 81.4
    expect(withSam(H, 220, 249, 4)).toBe(400_000 - qpen); // 99 > 96.7
    expect(withSam(H, 220, 250, 5)).toBe(0); // level 5: never
    expect(withSam(H, 220, 251, 1)).toBe(0); // 101: not searched
    // Whoever owns it: N's own SAM on its land, 80 from (110, 150), 90 from
    // the silo.
    expect(withSam(N, 30, 150, 1, at(110, 150))).toBe(100_000 - 90 * 30);
    // Recent aim points: after an atom, every tile within its inner radius
    // (12) of the aim point loses 1M (:791-801); kept while sent + 600 >=
    // now (:546-555).
    const clean = brainWith(w, "N", false).nuke; // same seed, no history
    setGold(N, 1_000_000n);
    nuke.maybeSendNuke();
    expect(nukes(w).map((n) => n.type)).toEqual([UnitType.AtomBomb]);
    const dst = nukes(w)[0].dst!;
    const targets = H.units(Structures.types);
    const loss = (t: TileRef) =>
      clean.nukeTileScore(t, silos, targets, UnitType.AtomBomb) -
      nuke.nukeTileScore(t, silos, targets, UnitType.AtomBomb);
    const inner = w.config.nukeMagnitudes(UnitType.AtomBomb).inner;
    const edge = at(w.game.x(dst), w.game.y(dst) + inner);
    const beyond = at(w.game.x(dst), w.game.y(dst) + inner + 1);
    expect([loss(dst), loss(edge), loss(beyond)]).toEqual([
      1_000_000, 1_000_000, 0,
    ]);
    tick(w, 600);
    nuke.removeOldNukeEvents();
    expect(loss(dst)).toBe(1_000_000);
    tick(w, 1);
    nuke.removeOldNukeEvents();
    expect(loss(dst)).toBe(0);
  });

  it("a level-1 SAM on the city: a hydro is aimed where it outranges the SAM (> 70, within 100) and kills it unopposed", () => {
    const w = strikeWorld();
    const { N, H } = w.p;
    const city = w.game.ref(220, 150);
    H.buildUnit(UnitType.City, city, {});
    const sam = samAt(w, H, 225, 150);
    tick(w, 2);
    const { nuke } = brainWith(w, "N", false);
    setGold(N, 10_000_000n);
    nuke.maybeSendNuke();
    expect(nukes(w).map((n) => n.type)).toEqual([UnitType.HydrogenBomb]);
    const d = dist(w, nukes(w)[0].dst!, sam.tile());
    expect(d).toBeGreaterThan(w.config.samRange(1));
    expect(d).toBeLessThan(
      w.config.nukeMagnitudes(UnitType.HydrogenBomb).outer,
    );
    settle(w);
    expect(samMissiles(w)).toHaveLength(0);
    expect(sam.isActive()).toBe(false);
  });

  it("a level-1 SAM on the city, atoms only: every aim point is interceptable, so it fires a salvo of level + 1 = 2 atoms at the SAM; one is shot down, the other kills SAM and city", () => {
    const w = strikeWorld({ silos: 2 });
    const { N, H } = w.p;
    const cityTile = w.game.ref(220, 150);
    const city = H.buildUnit(UnitType.City, cityTile, {});
    const sam = samAt(w, H, 225, 150);
    tick(w, 2);
    const { nuke } = brainWith(w, "N", false);
    setGold(N, 2_000_000n); // 2 atoms, no hydro
    nuke.maybeSendNuke();
    expect(nukes(w).map((n) => [n.type, n.dst])).toEqual([
      [UnitType.AtomBomb, sam.tile()],
      [UnitType.AtomBomb, sam.tile()],
    ]);
    settle(w);
    expect(samMissiles(w)).toHaveLength(1);
    expect(sam.isActive()).toBe(false);
    expect(city.isActive()).toBe(false);
  });
});

/**
 * B holds x < 340, the attacker A x >= 340 with silos at x = 380; a
 * bystander C holds a 41 x 41 patch around (100, 100) inside B.
 */
function samWorld(silos = 1): World {
  const w = world(
    400,
    200,
    { A: PlayerType.Human, B: PlayerType.Human, C: PlayerType.Human },
    (x, y) => {
      if (x >= 340) return "A";
      if (Math.abs(x - 100) <= 20 && Math.abs(y - 100) <= 20) return "C";
      return "B";
    },
  );
  for (let i = 0; i < silos; i++)
    w.p.A.buildUnit(UnitType.MissileSilo, w.game.ref(380, 60 + 20 * i), {});
  setGold(w.p.A, 1_000_000_000n);
  return w;
}

/** Fires an atom bomb from A at (x, y); true if it was shot down. */
function strike(w: World, x: number, y: number): boolean {
  const dst = w.game.ref(x, y);
  w.game.addExecution(new NukeExecution(UnitType.AtomBomb, w.p.A, dst));
  settle(w);
  return !w.game.hasFallout(dst);
}

describe("H8 SAMs against ordinary nukes: SAMLauncherExecution, SAMMissileExecution", () => {
  it("the numbers: range 150 - 480/(level + 5), 90-tick reload per interceptor, 300-tick build, 1.5M then 3M", () => {
    const w = samWorld();
    const c = w.config;
    expect([1, 2, 3, 4, 5].map((l) => c.samRange(l))).toEqual([
      70,
      150 - 480 / 7,
      90,
      150 - 480 / 9,
      102,
    ]);
    expect(c.maxSamRange()).toBe(150);
    expect(c.defaultNukeTargetableRange()).toBe(150); // Config.ts:1136-1138
    expect(c.SAMCooldown()).toBe(90);
    expect(c.defaultSamMissileSpeed()).toBe(12);
    expect(c.nukeSpeed(UnitType.AtomBomb)).toBe(10);
    expect(c.unitInfo(UnitType.SAMLauncher).constructionDuration).toBe(300);
    // Only level 5+ outreaches a hydro's 100-tile blast.
    expect(c.nukeMagnitudes(UnitType.HydrogenBomb).outer).toBe(100);
    expect(c.samRange(4)).toBeLessThan(100);
    expect(c.samRange(5)).toBeGreaterThan(100);
    const { B } = w.p;
    setGold(B, 100_000_000n);
    expect(cost(w, UnitType.SAMLauncher, B)).toBe(1_500_000n);
    const s = samAt(w, B, 200, 100);
    expect(cost(w, UnitType.SAMLauncher, B)).toBe(3_000_000n); // 2nd SAM
    B.upgradeUnit(s); // an upgrade is priced like the next SAM
    expect(cost(w, UnitType.SAMLauncher, B)).toBe(3_000_000n);
  });

  it("interception is certain, not a roll: a level-1 SAM downs every atom bomb aimed within 70 tiles of it", () => {
    const r = Math.floor(samWorld().config.samRange(1)) - 1; // 69
    for (const [dx, dy] of [
      [0, 0],
      [35, 0],
      [r, 0],
      [0, r],
      [-50, -48],
    ]) {
      const w = samWorld();
      samAt(w, w.p.B, 100, 100);
      ready(w);
      expect(strike(w, 100 + dx, 100 + dy)).toBe(true);
      expect(samMissiles(w)).toHaveLength(1);
    }
  });

  it("range = samRange(level): at 75 tiles level 1 misses and level 2 hits; at 85 level 2 misses and level 3 hits", () => {
    const shotDown = (level: number, d: number) => {
      const w = samWorld();
      samAt(w, w.p.B, 100, 100, level);
      ready(w);
      return strike(w, 100 + d, 100); // approach from the far side
    };
    const c = samWorld().config;
    const between = (l: number) =>
      Math.floor((c.samRange(l) + c.samRange(l + 1)) / 2);
    expect([between(1), between(2)]).toEqual([75, 85]);
    expect(shotDown(1, between(1))).toBe(false);
    expect(shotDown(2, between(1))).toBe(true);
    expect(shotDown(2, between(2))).toBe(false);
    expect(shotDown(3, between(2))).toBe(true);
  });

  it("a SAM defends everything in its range, whoever owns it: C's SAM downs A's bomb on B", () => {
    const w = samWorld();
    samAt(w, w.p.C, 100, 100);
    ready(w);
    expect(w.game.owner(w.game.ref(150, 100))).toBe(w.p.B);
    expect(strike(w, 150, 100)).toBe(true);
    expect(samMissiles(w)[0].from).toBe(w.p.C);
  });

  it("capacity: a level-L SAM has L interceptors, each reloading 90 ticks after use; two bombs at once beat a level-1 SAM but not a level-2 one", () => {
    const salvo = (level: number) => {
      const w = samWorld(2);
      samAt(w, w.p.B, 100, 100, level);
      ready(w);
      const a = w.game.ref(100, 130);
      const b = w.game.ref(130, 100);
      w.game.addExecution(
        new NukeExecution(UnitType.AtomBomb, w.p.A, a),
        new NukeExecution(UnitType.AtomBomb, w.p.A, b),
      );
      settle(w);
      return {
        detonated: [a, b].filter((t) => w.game.hasFallout(t)).length,
        interceptors: samMissiles(w).length,
      };
    };
    expect(salvo(1)).toEqual({ detonated: 1, interceptors: 1 });
    expect(salvo(2)).toEqual({ detonated: 0, interceptors: 2 });
  });

  it("only the ends of a flight are targetable (within 150 tiles of the launch or the aim point): a SAM under the mid-course cannot fire", () => {
    const w = world(
      700,
      200,
      { A: PlayerType.Human, B: PlayerType.Human, C: PlayerType.Human },
      (x) => (x < 60 ? "A" : "B"),
    );
    const { A, C } = w.p;
    A.buildUnit(UnitType.MissileSilo, w.game.ref(30, 150), {});
    A.buildUnit(UnitType.MissileSilo, w.game.ref(30, 190), {}); // for the control
    setGold(A, 1_000_000_000n);
    ready(w);
    const src = w.game.ref(30, 150);
    const dst = w.game.ref(670, 150);
    w.game.addExecution(new NukeExecution(UnitType.AtomBomb, A, dst));
    tick(w, 2);
    const [bomb] = w.game.units(UnitType.AtomBomb);
    const path = bomb.trajectory();
    const r2 = w.config.defaultNukeTargetableRange() ** 2;
    for (const t of path) {
      expect(t.targetable).toBe(
        w.game.euclideanDistSquared(t.tile, dst) < r2 ||
          w.game.euclideanDistSquared(t.tile, src) < r2,
      );
    }
    // A ready level-1 SAM right under the apex, placed while the bomb is
    // still climbing: the whole mid-course passes over it.
    const mid = path[Math.floor(path.length / 2)];
    expect(mid.targetable).toBe(false);
    const ax = w.game.x(mid.tile);
    const ay = w.game.y(mid.tile);
    for (let y = Math.max(0, ay - 5); y <= ay + 5; y++)
      for (let x = ax - 5; x <= ax + 5; x++) C.conquer(w.game.ref(x, y));
    samAt(w, C, ax, ay);
    const flight = settle(w);
    expect(flight).toBeGreaterThan(60); // 71 steps at 10 tiles a tick
    expect(w.game.hasFallout(dst)).toBe(true);
    expect(samMissiles(w)).toHaveLength(0);
    // The same SAM downs a bomb whose end of flight comes within its range.
    const near = w.game.ref(ax + 40, ay + 40);
    w.game.addExecution(new NukeExecution(UnitType.AtomBomb, A, near));
    settle(w);
    expect(w.game.hasFallout(near)).toBe(false);
    expect(samMissiles(w)).toHaveLength(1);
  });
});

/** V 4,000 of 10,000 land tiles (40%), nations N and N2, tribe T. */
function mirvWorld(vType = PlayerType.Human, v = 4000): World {
  return world(
    SIDE,
    SIDE,
    {
      V: vType,
      N: PlayerType.Nation,
      N2: PlayerType.Nation,
      R: PlayerType.Human,
      T: PlayerType.Bot,
    },
    runs(SIDE, [
      ["V", v],
      ["N", 1000],
      ["N2", 1000],
      ["R", 1000],
      ["T", 1000],
    ]),
  );
}

/** A silo and exactly the MIRV price in gold. */
function arm(w: World, key: string): void {
  const p = w.p[key];
  p.buildUnit(UnitType.MissileSilo, [...p.tiles()][500], {});
  setGold(p, cost(w, UnitType.MIRV, p));
}

/**
 * A game ID under which `key`'s first MIRV decision does not hesitate
 * (dry run; clears the shared cooldown map and the log).
 */
function willing(w: World, key: string): string {
  for (let g = 0; g < 40; g++) {
    const id = `willing-${key}-${g}`;
    w.game.nationMirvTargets().clear();
    const probe = brain(w, key, id).mirv.considerMIRV();
    w.log.length = 0;
    w.game.nationMirvTargets().clear();
    if (probe) return id;
  }
  throw new Error("always hesitates");
}

describe("H8 MIRVs: NationMIRVBehavior", () => {
  it("price: 25M + 15M x every MIRV ANYONE has launched (Config.ts:618-630, a game-wide counter)", () => {
    const w = mirvWorld();
    const { V, N, R } = w.p;
    for (const p of [V, N, R])
      expect(cost(w, UnitType.MIRV, p)).toBe(25_000_000n);
    arm(w, "R");
    pastImmunity(w);
    w.game.addExecution(new MirvExecution(R, [...V.tiles()][2000]));
    tick(w, 2);
    expect(w.game.mirvsLaunched()).toBe(1);
    for (const p of [V, N, R])
      expect(cost(w, UnitType.MIRV, p)).toBe(40_000_000n);
  });

  it("victory denial: anyone holding >= 40% of ALL land tiles (fallout stays in the denominator), allies included, tribes never", () => {
    let w = mirvWorld();
    const { mirv } = brain(w, "N");
    expect(mirv.selectVictoryDenialTarget()).toBe(w.p.V); // exactly 40%
    shed(w.p.V, 1);
    expect(mirv.selectVictoryDenialTarget()).toBeNull(); // 39.99%
    // Fallout does not help: numLandTiles() counts it (:183-187), unlike
    // the crown rule's (land - fallout).
    fallout(w, 500);
    expect(mirv.selectVictoryDenialTarget()).toBeNull();
    // Allies are not exempt (getValidMirvTargetPlayers :268-279 filters
    // only self, tribes and teammates) ...
    w = mirvWorld();
    ally(w.p.N, w.p.V);
    expect(brain(w, "N").mirv.selectVictoryDenialTarget()).toBe(w.p.V);
    // ... tribes are.
    w = mirvWorld(PlayerType.Bot, 5000);
    expect(brain(w, "N").mirv.selectVictoryDenialTarget()).toBeNull();
  });

  it("steamroll stop: the city leader, counted in city LEVELS, with MORE than 8 and >= 1.15 x the runner-up (tribes and the nation itself count as runner-up)", () => {
    const cities = (p: Player, levels: number[]) => {
      const tiles = [...p.tiles()];
      levels.forEach((level, i) => {
        const c = p.buildUnit(UnitType.City, tiles[i * 30], {});
        for (let l = 1; l < level; l++) c.increaseLevel();
      });
    };
    const case_ = (v: number[], other: string, o: number[]) => {
      const w = mirvWorld(PlayerType.Human, 3000); // below 40%
      cities(w.p.V, v);
      cities(w.p[other], o);
      return brain(w, "N").mirv.selectSteamrollStopTarget() === w.p.V;
    };
    const ones = (n: number) => Array<number>(n).fill(1);
    expect(case_(ones(9), "R", ones(7))).toBe(true); // 9 >= 8.05
    expect(case_(ones(9), "R", ones(8))).toBe(false); // 9 < 9.2
    expect(case_(ones(8), "R", [])).toBe(false); // 8 is not > 8
    expect(case_([3, 3, 3], "R", [])).toBe(true); // 3 cities, 9 levels
    expect(case_(ones(9), "N", ones(8))).toBe(false); // the nation 2nd
    expect(case_(ones(9), "T", ones(8))).toBe(false); // a tribe 2nd
    // The multiplier is 1.15 with >= (:102-116, :247-249): 20 x 1.15 is
    // exactly 23 in floating point, and 23 levels vs 20 triggers; 57 vs 50
    // (1.14) does not. So the factor lies in (1.14, 1.15] and >= is pinned.
    expect(20 * 1.15).toBe(23);
    expect(case_([10, 10, 3], "R", [10, 10])).toBe(true);
    expect(case_([10, 10, 10, 10, 10, 7], "R", [10, 10, 10, 10, 10])).toBe(
      false,
    );
  });

  it("gates: a silo and gold >= the price; then 1 decision in 16 hesitates; the aim is calculateTerritoryCenter(target)", () => {
    const w = mirvWorld();
    const { V, N } = w.p;
    w.dryRun = true;
    pastImmunity(w);
    arm(w, "N");
    const id = willing(w, "N");
    const price = cost(w, UnitType.MIRV, N);
    const decide = () => {
      w.game.nationMirvTargets().clear();
      return brain(w, "N", id).mirv.considerMIRV();
    };
    expect(decide()).toBe(true);
    setGold(N, price - 1n);
    expect(decide()).toBe(false); // gold (:141-143)
    setGold(N, price);
    expect(decide()).toBe(true);
    N.units(UnitType.MissileSilo)[0].delete(false);
    expect(decide()).toBe(false); // no silo (:138-140)
    N.buildUnit(UnitType.MissileSilo, [...N.tiles()][500], {});
    setGold(N, price);
    w.log.length = 0;
    // random.chance(16) per decision (:145-147, hesitationOdds :66-80), the
    // first draw of considerMIRV: a copy of the nation's PRNG taken just
    // before predicts every decision exactly.
    let launched = 0;
    const trials = 160;
    for (let g = 0; g < trials; g++) {
      w.game.nationMirvTargets().clear();
      const b = brain(w, "N", `mirv-${g}`).mirv;
      const rnd = (b as unknown as { random: PseudoRandom }).random;
      const hesitates = PseudoRandom.fromState(rnd.getState()).chance(16);
      const fired = b.considerMIRV();
      expect(fired).toBe(!hesitates);
      if (fired) launched++;
    }
    expect(mirvs(w)).toHaveLength(launched);
    expect(trials - launched).toBeGreaterThan(3); // ~1/16 of 160 = 10
    expect(trials - launched).toBeLessThan(20);
    const center = calculateTerritoryCenter(w.game, V);
    for (const m of mirvs(w)) {
      expect(m.dst).toBe(center);
      expect(w.game.owner(m.dst!)).toBe(V);
    }
  });

  it("one MIRV per target per 300 ticks across ALL nations (game.nationMirvTargets); counter-MIRV comes before the 40% leader", () => {
    const w = mirvWorld();
    const { V, N, N2, R } = w.p;
    w.dryRun = true;
    arm(w, "N");
    arm(w, "N2");
    pastImmunity(w);
    const idN = willing(w, "N");
    const idN2 = willing(w, "N2");
    w.game.nationMirvTargets().clear();
    expect(brain(w, "N", idN).mirv.considerMIRV()).toBe(true);
    expect(w.game.nationMirvTargets().get(V.id())).toBe(w.game.ticks());
    expect(brain(w, "N2", idN2).mirv.considerMIRV()).toBe(false);
    tick(w, 299);
    expect(brain(w, "N2", idN2).mirv.considerMIRV()).toBe(false);
    tick(w, 1);
    expect(brain(w, "N2", idN2).mirv.considerMIRV()).toBe(true);
    expect(mirvs(w).map((m) => [m.from, w.game.owner(m.dst!)])).toEqual([
      [N, V],
      [N2, V],
    ]);
    // R (10% of the land, no cities) fires a real MIRV at N2: N2's next
    // MIRV goes back at R, not at the 40% leader V.
    w.dryRun = false;
    arm(w, "R");
    w.game.addExecution(new MirvExecution(R, [...N2.tiles()][100]));
    tick(w, 2);
    expect(R.units(UnitType.MIRV)).toHaveLength(1);
    w.dryRun = true;
    w.game.nationMirvTargets().clear();
    setGold(N2, cost(w, UnitType.MIRV, N2)); // now 40M
    const b = brain(w, "N2", idN2).mirv;
    expect(b.selectCounterMirvTarget()).toBe(R);
    expect(b.selectVictoryDenialTarget()).toBe(V);
    let fired = false;
    for (let g = 0; g < 10 && !fired; g++) {
      w.game.nationMirvTargets().clear();
      fired = brain(w, "N2", `counter-${g}`).mirv.considerMIRV();
    }
    expect(fired).toBe(true);
    const last = mirvs(w)[mirvs(w).length - 1];
    expect([last.from, w.game.owner(last.dst!)]).toEqual([N2, R]);
  });

  it("a MIRV cannot be stopped: SAMs never target the carrier, and a level-L SAM downs at most L of its warheads", () => {
    const run = (level: number) => {
      const w = world(
        200,
        200,
        { A: PlayerType.Human, B: PlayerType.Human },
        (x) => (x < 20 ? "A" : "B"),
      );
      const { A, B } = w.p;
      A.buildUnit(UnitType.MissileSilo, w.game.ref(10, 100), {});
      setGold(A, cost(w, UnitType.MIRV, A));
      samAt(w, B, 110, 100, level);
      ready(w);
      w.game.addExecution(new MirvExecution(A, w.game.ref(110, 100)));
      settle(w);
      const warheads = nukes(w).filter((n) => n.type === UnitType.MIRVWarhead);
      const hits = warheads.filter((n) => w.game.hasFallout(n.dst!)).length;
      return {
        warheads: warheads.length,
        hits,
        interceptors: samMissiles(w).map((m) => m.target!.type()),
      };
    };
    const one = run(1);
    const three = run(3);
    // 15 warheads on this 180 x 200 target (350 at most, >= 55 apart,
    // MIRVExecution.ts:52-53).
    expect(one.warheads).toBeGreaterThan(10);
    expect(three.warheads).toBe(one.warheads);
    expect(one.interceptors).toEqual([UnitType.MIRVWarhead]);
    expect(three.interceptors).toEqual(Array(3).fill(UnitType.MIRVWarhead));
    expect(one.hits).toBe(one.warheads - 1);
    expect(three.hits).toBe(three.warheads - 3);
  });
});
