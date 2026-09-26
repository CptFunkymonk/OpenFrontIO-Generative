import { createModels } from "../../../src/agent/lib/Models";
import { NationModel } from "../../../src/agent/lib/NationModel";
import { NukeModel } from "../../../src/agent/lib/NukeModel";
import { Config } from "../../../src/core/configuration/Config";
import { MissileSiloExecution } from "../../../src/core/execution/MissileSiloExecution";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { NukeExecution } from "../../../src/core/execution/NukeExecution";
import { SAMLauncherExecution } from "../../../src/core/execution/SAMLauncherExecution";
import { UpgradeStructureExecution } from "../../../src/core/execution/UpgradeStructureExecution";
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
import { GameConfig } from "../../../src/core/Schemas";

// Worlds for the package B3 tests (NukeModel.test, SamHub.test), built as
// tests/agent/mechanics/NukeThreat.test.ts builds its own: the real Config,
// createGame, endSpawnPhase, all-plains maps, tiles handed out directly; no
// PlayerExecution runs, so gold, troops and relations stay where the test
// puts them. The nation's behaviours are the ones
// NationExecution.initializeBehaviors wires, seeded as in a game; their
// private members are read through casts (tests may, agents may not). In a
// dry run the nukes and upgrades a decision creates are recorded, not run.

export const GAME_ID = "nuke-model";

const CONFIG: GameConfig = {
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

type Seat = (x: number, y: number) => string | null;

export interface World {
  game: Game;
  config: Config;
  p: Record<string, Player>;
  nukes: { from: Player; type: UnitType; dst: TileRef }[];
  upgrades: Player[];
  dryRun: boolean;
}

export const idOf = (key: string) => `ID_${key}`.padEnd(8, "0");

export function world(
  width: number,
  height: number,
  members: Record<string, PlayerType>,
  seat: Seat,
): World {
  const mw = Math.ceil(width / 2);
  const mh = Math.ceil(height / 2);
  const map = new GameMapImpl(
    width,
    height,
    new Uint8Array(width * height).fill(LAND),
    width * height,
  );
  const mini = new GameMapImpl(
    mw,
    mh,
    new Uint8Array(mw * mh).fill(LAND),
    mw * mh,
  );
  const config = new Config(CONFIG, null, false);
  const humans: PlayerInfo[] = [];
  const nations: Nation[] = [];
  const bots: PlayerInfo[] = [];
  for (const [key, type] of Object.entries(members)) {
    const info = new PlayerInfo(
      key,
      type,
      type === PlayerType.Human ? `CL_${key}`.padEnd(8, "0") : null,
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
  const w: World = { game, config, p, nukes: [], upgrades: [], dryRun: false };
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
        w.nukes.push({ from: v.player, type: v.nukeType, dst: v.dst });
        if (!w.dryRun) keep.push(e);
      } else if (e instanceof UpgradeStructureExecution) {
        w.upgrades.push((e as unknown as { player: Player }).player);
        if (!w.dryRun) keep.push(e);
      } else {
        keep.push(e);
      }
    }
    add(...keep);
  };
  return w;
}

/** Vertical stripes: the first `n1` columns to k1, the next n2 to k2... */
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

/** Row-major runs of tiles. */
export function runs(width: number, sizes: [string, number][]): Seat {
  return (x, y) => {
    let i = y * width + x;
    for (const [key, n] of sizes) {
      if (i < n) return key;
      i -= n;
    }
    return null;
  };
}

export function tick(w: World, n = 1): void {
  for (let i = 0; i < n; i++) w.game.executeNextTick();
}

export function pastImmunity(w: World): void {
  tick(
    w,
    Math.max(w.config.spawnImmunityDuration(), w.config.SAMCooldown()) + 1,
  );
}

/** NationNukeBehavior's members, private ones through a cast. */
export interface NukeBrain {
  findBestNukeTarget(): Player | null;
  maybeSendNuke(): void;
  isValidNukeTile(t: TileRef, target: Player | null): boolean;
  getPerceivedNukeCost(t: UnitType): bigint;
  sendNuke(tile: TileRef, type: UnitType, target: Player, wait?: number): void;
  isHydroNation: boolean;
}

/** The nuke behaviour of `key`, wired by the real initializeBehaviors and
 *  seeded as in a game; `hydro` overrides its isHydroNation draw. */
export function brain(w: World, key: string, hydro?: boolean): NukeBrain {
  const exec = new NationExecution(
    GAME_ID,
    new Nation(new Cell(0, 0), w.p[key].info()),
  );
  exec.init(w.game);
  const x = exec as unknown as {
    initializeBehaviors(): void;
    nukeBehavior: NukeBrain;
  };
  x.initializeBehaviors();
  if (hydro !== undefined) x.nukeBehavior.isHydroNation = hydro;
  return x.nukeBehavior;
}

export function model(w: World, key: string): NukeModel {
  const me = w.p[key];
  return new NukeModel(
    w.game,
    me,
    new NationModel(w.game, me, GAME_ID, createModels(w.game)),
  );
}

/** A finished silo of `level` with its execution (it reloads the slots a
 *  level-up queues, UnitImpl.increaseLevel :738-757). */
export function siloAt(
  w: World,
  owner: Player,
  x: number,
  y: number,
  level = 1,
): void {
  const u = owner.buildUnit(UnitType.MissileSilo, w.game.ref(x, y), {});
  for (let l = 1; l < level; l++) u.increaseLevel();
  w.game.addExecution(new MissileSiloExecution(u));
}

export function setGold(p: Player, gold: bigint): void {
  p.removeGold(p.gold());
  p.addGold(gold);
}

/** A phantom attack: the Attack object AttackExecution.init creates. */
export function attack(from: Player, to: Player, troops: number): void {
  from.createAttack(to, troops, null, new Set<TileRef>());
}

export function ally(a: Player, b: Player): void {
  const req = a.createAllianceRequest(b);
  if (req === null) throw new Error("no alliance request");
  req.accept();
}

/** A finished SAM of `level` with its execution. */
export function samAt(
  w: World,
  owner: Player,
  x: number,
  y: number,
  level = 1,
): Unit {
  const u = owner.buildUnit(UnitType.SAMLauncher, w.game.ref(x, y), {});
  for (let l = 1; l < level; l++) u.increaseLevel();
  w.game.addExecution(new SAMLauncherExecution(owner, null, u));
  return u;
}
