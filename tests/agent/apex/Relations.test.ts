/**
 * RelationTracker (apex spec §2.4.4, §4 step 3): after scripted events the
 * tracker's value of the nation's relation to us equals the game's private
 * value (read through a cast, test only), and its band equals
 * N.relation(me), at every tick.
 *
 * The world runs the real executions: a NationExecution (added first, as in
 * a game, where nations' executions come before any player's), then both
 * players' PlayerExecutions, so relations decay (PlayerImpl.decayRelations)
 * and troops regrow; the nation decides by itself between the scripted
 * events (it may attack us, request alliances, embargo us). Our actions go
 * through IntentSchema and Executor.createExec, the path of ctx.send; the
 * nation's scripted actions are the executions its own code would add.
 * NationModel.observe runs after every tick, as the apex policy runs it,
 * and nothing calls refresh or acceptsAlliance (which reconcile), so any
 * missed event would show.
 */
import { createModels } from "../../../src/agent/lib/Models";
import {
  NationModel,
  relationTracker,
} from "../../../src/agent/lib/NationModel";
import { Config } from "../../../src/core/configuration/Config";
import { AllianceRequestExecution } from "../../../src/core/execution/alliance/AllianceRequestExecution";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import {
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
  UnitType,
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
const OCEAN = 0x20;
const SHORELINE = 0x40;

interface World {
  game: Game;
  config: Config;
  us: Player;
  nation: Player;
  executor: Executor;
  nm: NationModel;
  /** Ticks at which tracker and game were compared. */
  checked: number;
  mismatches: string[];
  /** Relation values seen, for coverage. */
  seen: Set<Relation>;
}

function world(gameID: string): World {
  const width = 60;
  const height = 20;
  const t = new Uint8Array(width * height).fill(LAND);
  const m = new Uint8Array((width / 2) * (height / 2)).fill(LAND);
  const map = new GameMapImpl(width, height, t, width * height);
  const mini = new GameMapImpl(width / 2, height / 2, m, m.length);
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
  // The nation x 0-9 (200 tiles), we x 10-29 (400 tiles); x 30-59 is free
  // land only we touch.
  for (let x = 0; x < 30; x++) {
    for (let y = 0; y < height; y++) {
      (x < 10 ? nation : us).conquer(game.ref(x, y));
    }
  }
  us.setTroops(60_000);
  nation.setTroops(40_000);
  // Nation first, then the players' executions (decay, income), as in a
  // game.
  game.addExecution(new NationExecution(gameID, nationObj));
  game.addExecution(new PlayerExecution(us), new PlayerExecution(nation));
  const nm = new NationModel(game, us, gameID, createModels(game));
  return {
    game,
    config,
    us,
    nation,
    executor: new Executor(game, gameID, undefined),
    nm,
    checked: 0,
    mismatches: [],
    seen: new Set(),
  };
}

/** Terrain bytes of a w×h map, shorelines marked (the pins' rule). */
function seaTerrain(
  w: number,
  h: number,
  isLand: (x: number, y: number) => boolean,
): { t: Uint8Array; land: number } {
  const t = new Uint8Array(w * h);
  let land = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = isLand(x, y);
      t[y * w + x] = l ? LAND : OCEAN;
      if (l) land++;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = (t[y * w + x] & 0x80) !== 0;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (((t[ny * w + nx] & 0x80) !== 0) !== l) {
          t[y * w + x] |= SHORELINE;
          break;
        }
      }
    }
  }
  return { t, land };
}

/** 140×30: the nation's coast x 0-14 with a port, ocean, ours x 125-139. */
function seaWorld(gameID: string): World {
  const width = 140;
  const height = 30;
  const isLand = (x: number) => x < 15 || x >= 125;
  const main = seaTerrain(width, height, isLand);
  const mini = seaTerrain(
    width / 2,
    height / 2,
    (x) => isLand(2 * x) && isLand(2 * x + 1),
  );
  const config = new Config(GAME_CONFIG, null, false);
  const nationObj = new Nation(
    new Cell(0, 0),
    new PlayerInfo("nation", PlayerType.Nation, null, NATION_ID),
  );
  const game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    [nationObj],
    new GameMapImpl(width, height, main.t, main.land),
    new GameMapImpl(width / 2, height / 2, mini.t, mini.land),
    config,
  );
  game.endSpawnPhase();
  const us = game.player(AGENT_ID);
  const nation = game.player(NATION_ID);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < 15) nation.conquer(game.ref(x, y));
      else if (x >= 125) us.conquer(game.ref(x, y));
    }
  }
  us.setTroops(60_000);
  nation.setTroops(40_000);
  nation.addGold(50_000_000n);
  nation.buildUnit(UnitType.Port, game.ref(14, 25), {});
  game.addExecution(new NationExecution(gameID, nationObj));
  game.addExecution(new PlayerExecution(us), new PlayerExecution(nation));
  const nm = new NationModel(game, us, gameID, createModels(game));
  return {
    game,
    config,
    us,
    nation,
    executor: new Executor(game, gameID, undefined),
    nm,
    checked: 0,
    mismatches: [],
    seen: new Set(),
  };
}

function relationValue(from: Player, to: Player): number {
  const rel = (from as unknown as { relations: Map<Player, number> }).relations;
  return rel.get(to) ?? 0;
}

/** One tick, then observe and compare, as the policy would. */
function tick(w: World, n = 1): void {
  for (let i = 0; i < n; i++) {
    w.game.executeNextTick();
    const t = w.game.ticks();
    w.nm.observe(t);
    const real = relationValue(w.nation, w.us);
    const est = w.nm.relations.value(NATION_ID, t);
    const band = w.nm.relations.band(NATION_ID, t);
    w.checked++;
    w.seen.add(w.nation.relation(w.us));
    if (est !== real || band !== w.nation.relation(w.us)) {
      w.mismatches.push(`t${t}: real ${real} estimate ${est}`);
    }
  }
}

function send(w: World, intent: Intent): void {
  expect(IntentSchema.safeParse(intent).success).toBe(true);
  w.game.addExecution(
    w.executor.createExec({ ...intent, clientID: AGENT_CLIENT }),
  );
}

describe("RelationTracker", () => {
  test("decay is bit-exact and bands follow relationFromValue", () => {
    const r = relationTracker();
    r.onEvent("N", 10, -100, "ourAttack");
    expect(r.value("N", 10)).toBe(-100);
    // Emulate decayRelations for 1,000 ticks by hand.
    let v = -100;
    for (let i = 0; i < 1000; i++) {
      v += 0.05;
      if (Math.abs(v) < 0.1) v = 0;
    }
    expect(r.value("N", 1010)).toBe(v);
    // Hostile below -50: still Hostile after 999 decays (-50.05...).
    expect(r.band("N", 1009)).toBe(Relation.Hostile);
    expect(r.band("N", 5000)).toBe(Relation.Neutral);
    expect(r.value("N", 5000)).toBe(0);
    // Clamped to [-100, 100].
    r.onEvent("N", 20, -100, "ourAttack");
    expect(r.value("N", 20)).toBe(-100);
    r.onEvent("M", 5, 100, "counterAccept");
    r.onEvent("M", 5, 100, "counterAccept");
    expect(r.value("M", 5)).toBe(100);
    expect(r.band("M", 5)).toBe(Relation.Friendly);
  });

  test("the embargo malus: -20 at a decision seeing our embargo, +20 back at one that does not", () => {
    const r = relationTracker();
    r.noteEmbargo("N", true);
    const m = r.embargoMalus("N");
    expect(m.applied).toBe(false);
    expect(m.atDecision(100, null)).toBe(-20);
    // A stop sent at 98 counts from decision 100 on, not at 99.
    expect(m.atDecision(100, 98)).toBe(0);
    expect(m.atDecision(99, 98)).toBe(-20);
    r.onEvent("N", 51, -20, "embargoMalus");
    expect(r.embargoMalus("N").applied).toBe(true);
    expect(r.embargoMalus("N").atDecision(100, null)).toBe(0);
    expect(r.embargoMalus("N").atDecision(100, 98)).toBe(20);
    r.noteEmbargo("N", false);
    expect(r.embargoMalus("N").atDecision(100, null)).toBe(20);
    r.onEvent("N", 101, 20, "embargoRestore");
    expect(r.embargoMalus("N").applied).toBe(false);
  });

  test("reconcile clamps into the real band; toData round-trips", () => {
    const r = relationTracker();
    r.onEvent("N", 10, -30, "neighbourBreak");
    r.reconcile("N", Relation.Hostile, 10);
    expect(r.band("N", 10)).toBe(Relation.Hostile);
    expect(r.value("N", 10)).toBeLessThan(-50);
    r.reconcile("N", Relation.Hostile, 10);
    const d = r.toData();
    expect(d.mismatches).toBe(1);
    const copy = relationTracker(structuredClone(d));
    expect(copy.value("N", 400)).toBe(r.value("N", 400));
    expect(copy.toData()).toEqual(d);
  });

  test("a reconciled estimate stays in the real band past the next decision", () => {
    // Clamped right to the edge nearer 0, the estimate left the band at the
    // next tick (−0.05 decays straight to 0), so every refresh logged the
    // same mismatch (arena quick@4: 27-50 per game).
    const bands = [
      { real: Relation.Hostile, from: 0 },
      { real: Relation.Distrustful, from: 0 },
      { real: Relation.Friendly, from: 0 },
      { real: Relation.Neutral, from: -30 },
      { real: Relation.Neutral, from: 80 },
    ];
    for (const { real, from } of bands) {
      const r = relationTracker();
      if (from !== 0) r.onEvent("N", 10, from, "neighbourBreak");
      r.reconcile("N", real, 10);
      // A nation decides every 30-49 ticks.
      for (let t = 10; t < 60; t++) expect(r.band("N", t)).toBe(real);
      r.reconcile("N", real, 59);
      expect(r.toData().mismatches).toBe(1);
    }
  });

  test("a reconcile marks the estimate clamped until the next event; toData keeps the mark", () => {
    const r = relationTracker();
    expect(r.clamped("N")).toBe(false);
    r.reconcile("N", Relation.Distrustful, 10);
    expect(r.clamped("N")).toBe(true);
    const copy = relationTracker(structuredClone(r.toData()));
    expect(copy.clamped("N")).toBe(true);
    // A matching band leaves the mark; an event clears it.
    r.reconcile("N", Relation.Distrustful, 20);
    expect(r.clamped("N")).toBe(true);
    r.onEvent("N", 30, -20, "embargoMalus");
    expect(r.clamped("N")).toBe(false);
    expect(r.toData().values.N.clamped).toBeUndefined();
  });

  test("a forecast past a clamp: an untracked drop below Neutral does not decay to Neutral by the answering decision", () => {
    // The nation's relation to us drops by more than anything the tracker
    // sees (an untracked −23; warship retaliations were the case in arena
    // quick@4). A refresh clamps the estimate to −2.6 (the Distrustful edge
    // less the margin); 40 ticks later it is −0.6, still Distrustful, so no
    // reconcile fires, and decay alone would reach 0 (Neutral) by a
    // decision 49 ticks on: p = 1 for a nation that refuses.
    const w = world("rel-clamp");
    tick(w, 100);
    w.us.setTroops(20_000); // no threat branch: H < T
    (
      w.nation as unknown as { updateRelation(p: Player, d: number): void }
    ).updateRelation(w.us, -23);
    w.nm.refresh(NATION_ID, "full");
    const t0 = w.game.ticks();
    expect(w.nm.relations.clamped(NATION_ID)).toBe(true);
    for (let i = 0; i < 40; i++) {
      w.game.executeNextTick();
      w.nm.observe(w.game.ticks());
    }
    const now = w.game.ticks();
    expect(now - t0).toBe(40);
    expect(w.nation.relation(w.us)).toBe(Relation.Distrustful);
    expect(w.nm.relations.band(NATION_ID, now)).toBe(Relation.Distrustful);
    // The tracker alone would call it Neutral at a decision 49 ticks out.
    expect(w.nm.relations.band(NATION_ID, now + 49)).toBe(Relation.Neutral);
    for (const lead of [10, 30, 49]) {
      const f = w.nm.acceptsAlliance(NATION_ID, {
        kind: "request",
        createdAt: now,
        atTick: now + lead,
        embargoStoppedBy: null,
      });
      expect(f.p, `lead ${lead}`).toBe(0);
      expect(f.branch).toBe("hostile");
      expect(f.deterministic).toBe(false);
    }
    // A tracked estimate (no clamp) still decays: the same value from an
    // event forecasts Neutral once decayed.
    const r = relationTracker();
    r.onEvent(NATION_ID, now, -0.6, "embargoMalus");
    expect(r.clamped(NATION_ID)).toBe(false);
    expect(r.band(NATION_ID, now + 49)).toBe(Relation.Neutral);
  });

  test("warship retaliation: a nation owning our boat's landing builds a warship at it and drops 15; the tracker follows within two ticks", () => {
    let retaliations = 0;
    for (const gameID of ["ws-a", "ws-b", "ws-c", "ws-d"]) {
      const w = seaWorld(gameID);
      for (let i = 0; i < 100; i++) {
        w.game.executeNextTick();
        w.nm.observe(w.game.ticks());
      }
      send(w, { type: "boat", troops: 5_000, dst: w.game.ref(14, 5) });
      let prev = relationValue(w.nation, w.us);
      let lastDrop = -Infinity;
      for (let i = 0; i < 60; i++) {
        w.game.executeNextTick();
        const t = w.game.ticks();
        w.nm.observe(t);
        const real = relationValue(w.nation, w.us);
        if (real < prev - 14) {
          retaliations++;
          lastDrop = t;
        }
        prev = real;
        // The warship shows two turns after the nation's tick.
        if (t - lastDrop <= 2) continue;
        expect(w.nm.relations.value(NATION_ID, t), `${gameID} t${t}`).toBe(
          real,
        );
      }
      expect(w.us.units(UnitType.TransportShip).length).toBeLessThanOrEqual(1);
    }
    // 80% at Impossible per boat.
    expect(retaliations).toBeGreaterThan(0);
  });

  test("scripted events in a live world: the estimate equals the game's value at every tick", () => {
    for (const gameID of ["rel-a", "rel-b"]) {
      const w = world(gameID);
      // Past the nations' 50-tick spawn immunity (PlayerImpl.isImmune): an
      // attack on an immune nation is dropped before the relation changes.
      tick(w, 100);
      // Counter-accept: its request to us, ours back (+100 both ways,
      // AllianceRequestExecution.ts:45-63).
      w.game.addExecution(new AllianceRequestExecution(w.nation, AGENT_ID));
      tick(w);
      send(w, { type: "allianceRequest", recipient: NATION_ID });
      tick(w, 3);
      expect(w.us.isAlliedWith(w.nation)).toBe(true);
      expect(w.nation.relation(w.us)).toBe(Relation.Friendly);
      tick(w, 200);
      // Our break: -100 from it, -40 as our neighbour
      // (BreakAllianceExecution.ts:46-56).
      send(w, { type: "breakAlliance", recipient: NATION_ID });
      tick(w, 3);
      expect(w.us.isAlliedWith(w.nation)).toBe(false);
      tick(w, 300);
      // Our attack: -100 (AttackExecution.ts:190-210), then decay.
      send(w, { type: "attack", targetID: NATION_ID, troops: 1 });
      tick(w, 150);
      expect(relationValue(w.nation, w.us)).toBeLessThan(-80);
      // Its attack on us: our temporary embargo, -20 at its next decision.
      w.game.addExecution(new AttackExecution(1, w.nation, AGENT_ID));
      tick(w, 60);
      expect(w.us.hasEmbargoAgainst(w.nation)).toBe(true);
      expect(w.nm.relations.embargoMalus(NATION_ID).applied).toBe(true);
      // Our embargo stop: +20 back at a later decision.
      send(w, { type: "embargo", targetID: NATION_ID, action: "stop" });
      tick(w, 120);
      expect(w.nm.relations.embargoMalus(NATION_ID).applied).toBe(false);
      // Our target: -40 (TargetPlayerExecution.ts:34).
      send(w, { type: "targetPlayer", target: NATION_ID });
      tick(w, 60);
      // A manual embargo of ours, then its stop.
      send(w, { type: "embargo", targetID: NATION_ID, action: "start" });
      tick(w, 110);
      expect(w.nm.relations.embargoMalus(NATION_ID).applied).toBe(true);
      send(w, { type: "embargo", targetID: NATION_ID, action: "stop" });
      tick(w, 110);
      expect(w.nm.relations.embargoMalus(NATION_ID).applied).toBe(false);
      tick(w, 1200);
      expect(w.mismatches).toEqual([]);
      expect(w.checked).toBeGreaterThan(2000);
      // Every band was visited.
      expect(w.seen.size).toBe(4);
    }
  });
});
