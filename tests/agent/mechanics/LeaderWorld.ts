/**
 * Worlds for the leader-phase pins (package WP10-PIN: OwnNukes, MirvEffect,
 * SiloStrike, NationMirvTargeting, Betrayal, ConquestSpoils), built as
 * NukeThreat.test.ts and tests/agent/apex/NukeWorld.ts build theirs: the real
 * Config class as the arena builds it (GameRunner.ts: new Config(gameConfig,
 * null, false), not tests/util/TestConfig.ts, which overrides the nuke
 * numbers), FFA, Singleplayer, Impossible, the game made as
 * tests/util/Setup.ts makes it (createGame, then endSpawnPhase), on maps
 * synthesized in memory (all plains unless a test passes its own terrain),
 * tiles handed out with conquer(). No PlayerExecution runs unless a test adds
 * one, so troops, gold and relations stay where the test puts them.
 *
 * Our actions go through IntentSchema and Executor.createExec, the path of
 * ctx.send (AgentHost.isValid, src/agent/AgentHost.ts). Tests set state to
 * build scenarios and read private fields through casts; agents may do
 * neither.
 */
import { Config } from "../../../src/core/configuration/Config";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { MirvExecution } from "../../../src/core/execution/MIRVExecution";
import { MissileSiloExecution } from "../../../src/core/execution/MissileSiloExecution";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { NukeExecution } from "../../../src/core/execution/NukeExecution";
import { SAMLauncherExecution } from "../../../src/core/execution/SAMLauncherExecution";
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
  Unit,
  UnitType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl, TileRef } from "../../../src/core/game/GameMap";
import { GameConfig, Intent, IntentSchema } from "../../../src/core/Schemas";

/** The arena's setting (ArenaGame.ts arenaGameStart). */
export const GAME_CONFIG: GameConfig = {
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

/** Terrain bytes (GameMap.ts: bit 7 land, bits 0-4 magnitude). */
export const PLAINS = 0x80 | 5;
export const IMPASSABLE = 0x80 | 31;
export const WATER = 0;

/** Which member owns (x, y); null leaves the tile unowned. */
export type Seat = (x: number, y: number) => string | null;

export interface Weapon {
  kind: "nuke" | "mirv";
  from: Player;
  type: UnitType;
  dst: TileRef;
}

export interface World {
  game: Game;
  config: Config;
  p: Record<string, Player>;
  executor: Executor;
  /** Every NukeExecution and MirvExecution constructed, in order. */
  weapons: Weapon[];
  /** When true, weapons are logged but not added to the game. */
  dryRun: boolean;
}

// Player and client ids must match the wire schema (GAME_ID_REGEX,
// Schemas.ts:608: 8-10 letters or digits), or an intent naming them fails
// IntentSchema.
export const idOf = (key: string) => `ID${key}`.padEnd(8, "0");
export const clientOf = (key: string) => `CL${key}`.padEnd(8, "0");

export interface WorldOptions {
  /** Terrain byte of (x, y); all plains by default. */
  terrain?: (x: number, y: number) => number;
  gameID?: string;
}

export function world(
  width: number,
  height: number,
  members: Record<string, PlayerType>,
  seat: Seat,
  opts: WorldOptions = {},
): World {
  const terrain = new Uint8Array(width * height);
  let land = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = opts.terrain ? opts.terrain(x, y) : PLAINS;
      terrain[y * width + x] = t;
      if (t & 0x80 && (t & 0x1f) !== 31) land++;
    }
  }
  const mw = Math.ceil(width / 2);
  const mh = Math.ceil(height / 2);
  const map = new GameMapImpl(width, height, terrain, land);
  const mini = new GameMapImpl(
    mw,
    mh,
    new Uint8Array(mw * mh).fill(PLAINS),
    mw * mh,
  );
  const config = new Config(GAME_CONFIG, null, false);
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
  const w: World = {
    game,
    config,
    p,
    executor: new Executor(game, opts.gameID ?? "leader-world", undefined),
    weapons: [],
    dryRun: false,
  };
  const add = game.addExecution.bind(game);
  game.addExecution = (...execs: Execution[]) => {
    const keep: Execution[] = [];
    for (const e of execs) {
      if (e instanceof NukeExecution) {
        const v = e as unknown as {
          nukeType: UnitType;
          player: Player;
          dst: TileRef;
        };
        w.weapons.push({
          kind: "nuke",
          from: v.player,
          type: v.nukeType,
          dst: v.dst,
        });
        if (!w.dryRun || v.nukeType === UnitType.MIRVWarhead) keep.push(e);
      } else if (e instanceof MirvExecution) {
        const v = e as unknown as { player: Player; dst: TileRef };
        w.weapons.push({
          kind: "mirv",
          from: v.player,
          type: UnitType.MIRV,
          dst: v.dst,
        });
        if (!w.dryRun) keep.push(e);
      } else {
        keep.push(e);
      }
    }
    add(...keep);
  };
  return w;
}

/** Vertical stripes: the first n1 columns to k1, the next n2 to k2... */
export function columns(sizes: [string | null, number][]): Seat {
  return (x) => {
    let i = x;
    for (const [key, n] of sizes) {
      if (i < n) return key;
      i -= n;
    }
    return null;
  };
}

export function tick(w: { game: Game }, n = 1): void {
  for (let i = 0; i < n; i++) w.game.executeNextTick();
}

/** Runs ticks until the next tick to run is `t`. */
export function advanceTo(w: { game: Game }, t: number): void {
  while (w.game.ticks() < t) w.game.executeNextTick();
}

/** Past spawn immunity (nukeSpawn refuses during it, PlayerImpl.ts:1627). */
export function pastImmunity(w: World): void {
  advanceTo(w, w.config.spawnImmunityDuration() + 1);
  expect(w.game.isSpawnImmunityActive()).toBe(false);
}

/** The agent's path: IntentSchema (AgentHost.ts), Executor.createExec. */
export function send(w: World, key: string, intent: Intent): void {
  expect(IntentSchema.safeParse(intent).success).toBe(true);
  w.game.addExecution(
    w.executor.createExec({ ...intent, clientID: clientOf(key) }),
  );
}

export function setGold(p: Player, gold: bigint): void {
  p.removeGold(p.gold());
  p.addGold(gold);
}

export function price(w: World, type: UnitType, p: Player): bigint {
  return w.game.unitInfo(type).cost(w.game, p);
}

/** A finished silo of `level`, with the execution that reloads it. */
export function siloAt(
  w: World,
  owner: Player,
  x: number,
  y: number,
  level = 1,
): Unit {
  const u = owner.buildUnit(UnitType.MissileSilo, w.game.ref(x, y), {});
  for (let l = 1; l < level; l++) u.increaseLevel();
  // A level gained arrives with its slot in use (UnitImpl.increaseLevel):
  // clear it, so the silo starts with every slot free.
  while (u.missileTimerQueue().length > 0) u.reloadMissile();
  w.game.addExecution(new MissileSiloExecution(u));
  return u;
}

/** A finished SAM of `level`, with its execution. */
export function samAt(
  w: World,
  owner: Player,
  x: number,
  y: number,
  level = 1,
): Unit {
  const u = owner.buildUnit(UnitType.SAMLauncher, w.game.ref(x, y), {});
  for (let l = 1; l < level; l++) u.increaseLevel();
  while (u.missileTimerQueue().length > 0) u.reloadMissile();
  w.game.addExecution(new SAMLauncherExecution(owner, null, u));
  return u;
}

/** A finished structure of `type` and `level` (no execution). */
export function structureAt(
  w: World,
  owner: Player,
  type: UnitType,
  x: number,
  y: number,
  level = 1,
): Unit {
  const u = owner.buildUnit(type, w.game.ref(x, y), {});
  for (let l = 1; l < level; l++) u.increaseLevel();
  return u;
}

export function ally(a: Player, b: Player): void {
  const req = a.createAllianceRequest(b);
  if (req === null) throw new Error("no alliance request");
  req.accept();
  expect(a.isAlliedWith(b)).toBe(true);
}

/** A player's raw relation value toward another (read, never written). */
export function relationValue(of: Player, toward: Player): number {
  const m = (of as unknown as { relations: Map<Player, number> }).relations;
  return m.get(toward) ?? 0;
}

export function dist(w: World, a: TileRef, b: TileRef): number {
  return Math.sqrt(w.game.euclideanDistSquared(a, b));
}

/** The nuke and MIRV units in flight. */
export function inFlight(w: World): Unit[] {
  return w.game
    .units(UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRVWarhead)
    .concat(w.game.units(UnitType.MIRV))
    .concat(w.game.units(UnitType.SAMMissile));
}

/** Runs until nothing is in flight (at least `min` ticks); the ticks run. */
export function settle(w: World, min = 2, max = 2000): number {
  let n = 0;
  while (n < min || (inFlight(w).length > 0 && n < max)) {
    tick(w);
    n++;
  }
  expect(inFlight(w)).toHaveLength(0);
  return n;
}

/** A real NationExecution's private state (read through a cast). */
export interface NationInternals {
  attackRate: number;
  attackTick: number;
  reserveRatio: number;
  triggerRatio: number;
  expandRatio: number;
  behaviorsInitialized: boolean;
  mirvBehavior: unknown;
  nukeBehavior: unknown;
  allianceBehavior: unknown;
  attackBehavior: unknown;
}

export interface LiveNation {
  exec: NationExecution;
  n: NationInternals;
  player: Player;
}

/**
 * The real NationExecution of `key`, seeded as in a game (gameID + nation
 * id, NationExecution.ts:68-78); not yet added to the game.
 */
export function nationOf(w: World, key: string, gameID: string): LiveNation {
  const exec = new NationExecution(
    gameID,
    new Nation(new Cell(0, 0), w.p[key].info()),
  );
  return {
    exec,
    n: exec as unknown as NationInternals,
    player: w.p[key],
  };
}

/**
 * Adds the nation's execution and runs its first two ticks: init, then the
 * behaviours and its opening troops/2 at free land (NationExecution.ts:
 * 194-198). With no free land beside it that attack retreats in full.
 */
export function startNation(w: World, nation: LiveNation): void {
  w.game.addExecution(nation.exec);
  tick(w, 2);
  expect(nation.n.behaviorsInitialized).toBe(true);
}

export function isDecisionTick(nation: LiveNation, t: number): boolean {
  return t % nation.n.attackRate === nation.n.attackTick;
}

/** Runs until the next tick to run is the nation's next decision tick. */
export function toDecision(w: World, nation: LiveNation): number {
  while (!isDecisionTick(nation, w.game.ticks())) tick(w);
  return w.game.ticks();
}

/** NationMIRVBehavior's members, private ones read through a cast. */
export interface MirvBrain {
  considerMIRV(): boolean;
  selectCounterMirvTarget(): Player | null;
  selectVictoryDenialTarget(): Player | null;
  selectSteamrollStopTarget(): Player | null;
}

/** NationNukeBehavior's members, private ones read through a cast. */
export interface NukeBrain {
  findBestNukeTarget(): Player | null;
  maybeSendNuke(): void;
}

/** NationAllianceBehavior's members used by the betrayal pins. */
export interface AllianceBrain {
  findJuiciestAlly(borderingFriends: Player[]): Player | null;
  maybeBetray(
    other: Player,
    juiciest: Player | null,
    borderingFriends: Player[],
    borderingEnemies: Player[],
  ): boolean;
  isSafeToBetray(
    target: Player,
    borderingFriends: Player[],
    borderingEnemies: Player[],
  ): boolean;
}

export interface Brains {
  mirv: MirvBrain;
  nuke: NukeBrain;
  alliance: AllianceBrain;
}

/**
 * The behaviours of `key`, wired by the real
 * NationExecution.initializeBehaviors (NationExecution.ts:231-280) and seeded
 * as in a game; the execution is never added to the game, so nothing else
 * it does runs (as NukeThreat.test.ts's brain()).
 */
export function brains(w: World, key: string, gameID: string): Brains {
  const exec = new NationExecution(
    gameID,
    new Nation(new Cell(0, 0), w.p[key].info()),
  );
  exec.init(w.game);
  const x = exec as unknown as {
    initializeBehaviors(): void;
    mirvBehavior: MirvBrain;
    nukeBehavior: NukeBrain;
    allianceBehavior: AllianceBrain;
  };
  x.initializeBehaviors();
  return {
    mirv: x.mirvBehavior,
    nuke: x.nukeBehavior,
    alliance: x.allianceBehavior,
  };
}
