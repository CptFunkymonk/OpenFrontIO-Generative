/**
 * Package B1, survival (apex spec §5.1 items 2-4; docs/13-mechanics.md
 * §2.3, §2.6-2.9, §5.7-5.9): the deterrence floor and betrayal guard
 * (lib/Deterrence.ts, HomeTarget with o.deterrence) and the winning
 * counter (DefenseController with o.detCounter).
 *
 * - The floor's rules over stand-ins for NationModel and Models (their real
 *   implementations have their own tests): which nations add a line, the
 *   line (T(d) + 1)/1.1·detMargin, the betrayal line detBetrayShare·T(d),
 *   lines above detMaxShare·cap dropped, the wouldTargetUs check and its
 *   tribe slack, and homeFloors folding the floor into H (and so the TN
 *   floor through tnKeep), off by default.
 * - The floor against a real NationExecution (the NationSendCap pin's
 *   setting: the real Config, FFA, Singleplayer, Impossible, an all-plains
 *   map with the nation on x 0-9 and us on the rest): with our home at the
 *   floor homeFloors computes from the real NationModel, its real
 *   decisions never attack us; at the floor we would keep without
 *   deterrence they do.
 * - The counter through the live ApexPolicy (only the DefenseController
 *   runs) at latency 1: a nation's land attack on us, sent by the test as
 *   its AttackExecution, is met the tick the policy sees it by one attack
 *   of ceil(S·detCounterSize) + 1 troops. With size > 1 it deletes their
 *   attack at init and goes on into the nation (the −100 relation hit
 *   included); below 1 it is deleted after cancelling as much, with no
 *   hit [PIN AttackMerge]. It is not sent when home would fall under
 *   detCounterKeep·cap, for stacks under detCounterMin of home, while a
 *   request to the nation is pending, with the option off, or (with
 *   detCounterNoUnlock) when it would let a second, deterred nation attack
 *   us (a two-nation field and the real NationModel).
 * - The hold (detHold): a land line kept at its highest value for hold
 *   ticks; unlockedBy and potentialSend over stand-ins.
 * - Defense posts (detPosts): front and site geometry, a reactive post
 *   that gets built, proactive posts before an attack, and the filters
 *   (detPostMinShare, detPostMinThreat, detPostLead, detPostsMax).
 */
import { AgentIntent } from "../../../src/agent/Agent";
import { defenseMemory } from "../../../src/agent/agents/apex/controllers/DefenseController";
import {
  homeFloors,
  HomeTargetInputs,
  noteBorderNations,
} from "../../../src/agent/agents/apex/HomeTarget";
import { parseApexOptions } from "../../../src/agent/agents/apex/options";
import { ApexPolicy, View } from "../../../src/agent/agents/apex/policy";
import { ApexState, createState } from "../../../src/agent/agents/apex/state";
import {
  counterTroops,
  deterrence,
  DeterrenceParams,
  frontTiles,
  nationIds,
  postSites,
  potentialSend,
  unlockedBy,
} from "../../../src/agent/lib/Deterrence";
import { createModels, Models } from "../../../src/agent/lib/Models";
import {
  Gate,
  NationModel,
  NationState,
  sendCapSafe,
  TargetReason,
} from "../../../src/agent/lib/NationModel";
import { WorldModel } from "../../../src/agent/lib/WorldModel";
import { Config } from "../../../src/core/configuration/Config";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import {
  Cell,
  Difficulty,
  Execution,
  Game,
  Nation,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { AGENT_CLIENT, AGENT_ID, Field, GAME_CONFIG, Harness } from "./Field";

// ── Stand-ins ────────────────────────────────────────────────────────────

const CAP = 100_000;

interface FakeNation {
  T: number;
  border?: boolean;
  full?: boolean;
  allied?: boolean;
  gate?: Gate;
  can?: boolean;
  target?: TargetReason | null;
  tribes?: number;
  smallID: number;
}

interface Fake {
  me: Player;
  nm: NationModel;
  models: Models;
  /** (id, probe home) of every canLandAttackUs and wouldTargetUs call. */
  calls: string[];
}

function fake(
  nations: Record<string, FakeNation>,
  difficulty: Difficulty = Difficulty.Impossible,
): Fake {
  const calls: string[] = [];
  const me = {
    allies: () =>
      Object.entries(nations)
        .filter(([, n]) => n.allied === true)
        .map(([id]) => ({ id: () => id })),
  } as unknown as Player;
  const nm = {
    sendCapSafe: () => sendCapSafe(difficulty),
    get: (id: string) => {
      const n = nations[id];
      if (n === undefined) return undefined;
      return {
        id,
        smallID: n.smallID,
        full: n.full ?? true,
        sharesBorderWithUs: n.border ?? true,
        affordableTribes: n.tribes ?? 0,
      } as unknown as NationState;
    },
    nextDecision: (_id: string, from: number) => from + 7,
    gates: (id: string) => nations[id].gate ?? "open",
    troopsAt: (id: string, d: number) => {
      expect(d).toBe(109);
      return nations[id].T;
    },
    canLandAttackUs: (id: string, H: number, d: number) => {
      expect(d).toBe(109);
      calls.push(`can ${id} ${H}`);
      return nations[id].can ?? true;
    },
    wouldTargetUs: (id: string, H: number) => {
      calls.push(`target ${id} ${H}`);
      const t = nations[id].target;
      return t === undefined ? "weakest" : t;
    },
  } as unknown as NationModel;
  const models = { cap: () => CAP } as unknown as Models;
  return { me, nm, models, calls };
}

const PARAMS: DeterrenceParams = {
  margin: 1.05,
  maxShare: 0.8,
  capLines: false,
  betrayShare: 0.34,
  targetCheck: true,
  tribeSlack: 1,
  hold: 0,
};

const line = (T: number) => ((T + 1) / 1.1) * 1.05;

describe("deterrence floor: which nations add a line (stand-ins)", () => {
  test("an unallied nation that can attack us at the probe home adds (T(d) + 1)/1.1·margin; the largest line wins", () => {
    const f = fake({
      A: { T: 40_000, smallID: 3, tribes: 5 },
      B: { T: 60_000, smallID: 2 },
      C: { T: 70_000, smallID: 4, can: false },
    });
    const det = deterrence(
      f.me,
      f.nm,
      f.models,
      101,
      30_000,
      ["A", "B", "C"],
      PARAMS,
    );
    expect(det.terms.map((t) => t.id)).toEqual(["B", "A"]); // smallID order
    expect(det.terms[0]).toEqual({
      id: "B",
      kind: "land",
      d: 109,
      T: 60_000,
      floor: line(60_000),
    });
    expect(det.floor).toBeCloseTo(line(60_000));
    expect(det.by).toBe("B");
    expect(det.dropped).toBe(0);
    // Probed at the floor we would keep without deterrence.
    expect(f.calls).toContain("can A 30000");
    expect(f.calls).toContain("target A 30000");
  });

  test("a line above maxShare·cap is dropped, or with capLines held at maxShare·cap", () => {
    const f = fake({
      A: { T: 40_000, smallID: 1 },
      // (90,001/1.1)·1.05 = 85.9k > 80k.
      B: { T: 90_000, smallID: 2 },
    });
    const det = deterrence(
      f.me,
      f.nm,
      f.models,
      101,
      30_000,
      ["A", "B"],
      PARAMS,
    );
    expect(det.terms.map((t) => t.id)).toEqual(["A"]);
    expect(det.dropped).toBe(1);
    expect(det.floor).toBeCloseTo(line(40_000));
    // capLines: held at maxShare·cap instead.
    const held = deterrence(f.me, f.nm, f.models, 101, 30_000, ["A", "B"], {
      ...PARAMS,
      capLines: true,
    });
    expect(held.terms.map((t) => t.id)).toEqual(["A", "B"]);
    expect(held.dropped).toBe(1);
    expect(held.floor).toBeCloseTo(0.8 * CAP);
    expect(held.by).toBe("B");
  });

  test("nations not on our border, not fully refreshed or not in the candidates add nothing", () => {
    const f = fake({
      A: { T: 40_000, smallID: 1, border: false },
      B: { T: 40_000, smallID: 2, full: false },
      C: { T: 40_000, smallID: 3 },
    });
    const det = deterrence(
      f.me,
      f.nm,
      f.models,
      101,
      30_000,
      ["A", "B"],
      PARAMS,
    );
    expect(det.terms).toEqual([]);
    expect(det.floor).toBe(0);
    expect(det.by).toBeNull();
  });

  test("targetCheck: a nation whose list picks another player is skipped, unless it has at most tribeSlack affordable tribes left", () => {
    const f = fake({
      A: { T: 40_000, smallID: 1, target: null, tribes: 3 },
      B: { T: 50_000, smallID: 2, target: null, tribes: 1 },
      C: { T: 60_000, smallID: 3, target: "juicy", tribes: 5 },
    });
    const det = deterrence(
      f.me,
      f.nm,
      f.models,
      101,
      30_000,
      ["A", "B", "C"],
      PARAMS,
    );
    expect(det.terms.map((t) => t.id)).toEqual(["B", "C"]);
    // Off: every nation that can attack us counts.
    const all = deterrence(f.me, f.nm, f.models, 101, 30_000, ["A", "B", "C"], {
      ...PARAMS,
      targetCheck: false,
    });
    expect(all.terms.map((t) => t.id)).toEqual(["A", "B", "C"]);
  });

  test("betrayal guard: a bordering ally at or above its reserve adds betrayShare·T(d); locked or below reserve, or betrayShare 0, nothing", () => {
    for (const gate of [
      "open",
      "belowTrigger",
      "locked",
      "belowReserve",
    ] as Gate[]) {
      const f = fake({ A: { T: 150_000, smallID: 1, allied: true, gate } });
      const det = deterrence(f.me, f.nm, f.models, 101, 30_000, ["A"], PARAMS);
      if (gate === "open" || gate === "belowTrigger") {
        expect(det.terms).toEqual([
          {
            id: "A",
            kind: "betray",
            d: 109,
            T: 150_000,
            floor: 0.34 * 150_000,
          },
        ]);
      } else {
        expect(det.terms).toEqual([]);
      }
      // An ally is never probed for a land attack (allies cannot attack).
      expect(f.calls).toEqual([]);
    }
    const off = fake({ A: { T: 150_000, smallID: 1, allied: true } });
    expect(
      deterrence(off.me, off.nm, off.models, 101, 30_000, ["A"], {
        ...PARAMS,
        betrayShare: 0,
      }).terms,
    ).toEqual([]);
  });

  test("no line at Easy and Medium (no home deters there), or with no candidates", () => {
    const f = fake({ A: { T: 40_000, smallID: 1 } }, Difficulty.Medium);
    expect(
      deterrence(f.me, f.nm, f.models, 101, 30_000, ["A"], PARAMS).floor,
    ).toBe(0);
    const g = fake({ A: { T: 40_000, smallID: 1 } });
    expect(
      deterrence(g.me, g.nm, g.models, 101, 30_000, [], PARAMS).floor,
    ).toBe(0);
  });

  test("counterTroops", () => {
    expect(counterTroops(1000, 1.02)).toBe(1021);
    expect(counterTroops(1000, 0.97)).toBe(971);
  });
});

describe("deterrence floor: the hold (stand-ins)", () => {
  // One nation whose troops and ability to attack the test sets per call.
  function world() {
    const n = { T: 60_000, can: true, allied: false };
    const me = {
      allies: () => (n.allied ? [{ id: () => "A" }] : []),
    } as unknown as Player;
    const nm = {
      sendCapSafe: () => sendCapSafe(Difficulty.Impossible),
      get: () =>
        ({
          id: "A",
          smallID: 1,
          full: true,
          sharesBorderWithUs: true,
          affordableTribes: 0,
        }) as unknown as NationState,
      nextDecision: (_id: string, from: number) => from + 7,
      gates: () => "open" as Gate,
      troopsAt: () => n.T,
      canLandAttackUs: () => n.can,
      wouldTargetUs: () => "weakest" as TargetReason,
    } as unknown as NationModel;
    const models = { cap: () => CAP } as unknown as Models;
    const held: Record<string, { floor: number; until: number }> = {};
    const at = (tick: number, hold = 100) =>
      deterrence(me, nm, models, tick, 30_000, ["A"], { ...PARAMS, hold }, held)
        .floor;
    return { n, held, at };
  }

  test("off (hold 0): the line goes when the nation cannot attack us, and falls with its troops", () => {
    const w = world();
    expect(w.at(100, 0)).toBeCloseTo(line(60_000));
    w.n.T = 40_000;
    expect(w.at(110, 0)).toBeCloseTo(line(40_000));
    w.n.can = false;
    expect(w.at(120, 0)).toBe(0);
    expect(w.held).toEqual({});
  });

  test("on: kept for hold ticks at the highest line since it was set; a higher line resets it; an ally's is dropped", () => {
    const w = world();
    expect(w.at(100)).toBeCloseTo(line(60_000));
    expect(w.held.A).toEqual({ floor: line(60_000), until: 200 });
    // Its attack spent its troops: the line computed now is lower, and
    // then it cannot attack us at all; the held line stays.
    w.n.T = 30_000;
    expect(w.at(120)).toBeCloseTo(line(60_000));
    w.n.can = false;
    expect(w.at(150)).toBeCloseTo(line(60_000));
    // Regrown past it: the line rises and the hold restarts.
    w.n.can = true;
    w.n.T = 70_000;
    expect(w.at(180)).toBeCloseTo(line(70_000));
    expect(w.held.A.until).toBe(280);
    // Expired: gone.
    w.n.can = false;
    expect(w.at(279)).toBeCloseTo(line(70_000));
    expect(w.at(280)).toBe(0);
    expect(w.held).toEqual({});
    // An ally holds no land line.
    w.n.can = true;
    expect(w.at(300)).toBeGreaterThan(0);
    w.n.allied = true;
    w.at(310);
    expect(w.held).toEqual({});
  });
});

describe("deterrence floor in homeFloors (stand-ins)", () => {
  function inputs(
    f: Fake,
    options: Record<string, unknown>,
    wmNations?: string[],
  ): HomeTargetInputs {
    const wm =
      wmNations === undefined
        ? undefined
        : ({
            nations: wmNations.map((id) => ({ id, type: PlayerType.Nation })),
          } as unknown as WorldModel);
    return {
      tick: 101,
      o: parseApexOptions(options),
      me: f.me,
      models: f.models,
      nm: f.nm,
      wm,
    };
  }

  test("off by default: the floors are the spec's, det 0", () => {
    const f = fake({ A: { T: 60_000, smallID: 1 } });
    const s = createState();
    const fl = homeFloors(inputs(f, {}, ["A"]), s);
    expect(fl.H).toBeCloseTo(30_000);
    expect(fl.det).toBe(0);
    expect(f.calls).toEqual([]);
  });

  test("on: H = max(spec floor, det); the TN floor follows through tnKeep, the strike floor is H", () => {
    const f = fake({ A: { T: 60_000, smallID: 1 } });
    const fl = homeFloors(
      inputs(f, { deterrence: true }, ["A"]),
      createState(),
    );
    expect(fl.det).toBeCloseTo(line(60_000));
    expect(fl.detBy).toBe("A");
    expect(fl.H).toBeCloseTo(line(60_000));
    expect(fl.tn).toBeCloseTo(Math.max(17_000, 0.5 * line(60_000)));
    expect(fl.strike).toBeCloseTo(fl.H);
    expect(fl.econ).toBeCloseTo(30_000);
    expect(fl.vw).toBeCloseTo(17_000);
    // Probed at the spec's floor.
    expect(f.calls).toContain("can A 30000");
  });

  test("without a scan the candidates come from noteBorderNations (the last decision's scan)", () => {
    const f = fake({ A: { T: 60_000, smallID: 1 } });
    const s: ApexState = createState();
    const o = parseApexOptions({ deterrence: true });
    expect(homeFloors(inputs(f, { deterrence: true }), s).det).toBe(0);
    const wm = {
      tick: 99,
      nations: [
        { id: "A", type: PlayerType.Nation },
        { id: "H1", type: PlayerType.Human },
      ],
    } as unknown as WorldModel;
    noteBorderNations({ o, wm } as Pick<View, "o" | "wm">, s);
    expect(s.deterrence).toEqual({ cands: ["A"], at: 99 });
    expect(homeFloors(inputs(f, { deterrence: true }), s).det).toBeCloseTo(
      line(60_000),
    );
    // Off: nothing is noted.
    const s2 = createState();
    noteBorderNations(
      { o: parseApexOptions(), wm } as Pick<View, "o" | "wm">,
      s2,
    );
    expect(s2.deterrence).toBeUndefined();
  });
});

// ── The floor against a real NationExecution ─────────────────────────────

const NATION_ID = "NATION01";
const SECOND_ID = "NATION02";
const LAND = 0x80 | 5;

interface NationInternals {
  attackRate: number;
  attackTick: number;
  behaviorsInitialized: boolean;
}

interface Real {
  game: Game;
  config: Config;
  us: Player;
  nation: Player;
  n: NationInternals;
  nm: NationModel;
  models: Models;
  /** Troops of every attack the nation constructed on us. */
  attacksOnUs: number[];
}

function real(gameID: string, width = 60, height = 20): Real {
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
  const us = game.player(AGENT_ID);
  const nation = game.player(NATION_ID);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      (x < 10 ? nation : us).conquer(game.ref(x, y));
    }
  }
  const attacksOnUs: number[] = [];
  const add = game.addExecution.bind(game);
  game.addExecution = (...execs: Execution[]) => {
    for (const e of execs) {
      if (e instanceof AttackExecution && e.targetID() === AGENT_ID) {
        const v = e as unknown as { _owner: Player; startTroops: number };
        if (v._owner === nation) attacksOnUs.push(v.startTroops);
      }
    }
    add(...execs);
  };
  const exec = new NationExecution(gameID, nationObj);
  const models = createModels(game);
  const nm = new NationModel(game, us, gameID, models);
  const w: Real = {
    game,
    config,
    us,
    nation,
    n: exec as unknown as NationInternals,
    nm,
    models,
    attacksOnUs,
  };
  while (game.ticks() < 750) step(w);
  game.addExecution(exec);
  step(w, 3);
  expect(w.n.behaviorsInitialized).toBe(true);
  return w;
}

function step(w: Real, n = 1): void {
  for (let i = 0; i < n; i++) {
    w.game.executeNextTick();
    w.nm.observe(w.game.ticks());
  }
}

function nextDecisionTurn(w: Real, from: number): number {
  let d = from;
  while (d % w.n.attackRate !== w.n.attackTick) d++;
  return d;
}

describe("deterrence floor against a real NationExecution", () => {
  test("home at the floor homeFloors computes: no attack at its real decisions; home at the spec floor: attacked", () => {
    for (const gameID of ["det-a", "det-b", "det-c"]) {
      for (const atFloor of [true, false]) {
        const w = real(gameID);
        const o = parseApexOptions({ deterrence: true });
        let attackedAt = 0;
        let floors = 0;
        for (let k = 0; k < 4; k++) {
          const d = nextDecisionTurn(w, w.game.ticks() + 1);
          while (w.game.ticks() < d - 1) step(w);
          // The test sets troops (nothing regrows here: no
          // PlayerExecution), then the policy's floors are computed on
          // the eve of its decision, as the live policy does.
          const M = w.config.maxTroops(w.nation);
          w.nation.setTroops(Math.floor(0.62 * M));
          w.us.setTroops(Math.floor(0.3 * w.models.cap(w.us)));
          w.nm.refresh(NATION_ID, "full");
          const fl = homeFloors(
            {
              tick: w.game.ticks(),
              o,
              me: w.us,
              models: w.models,
              nm: w.nm,
              wm: {
                nations: [{ id: NATION_ID, type: PlayerType.Nation }],
              } as unknown as WorldModel,
            },
            createState(),
          );
          expect(fl.detBy).toBe(NATION_ID);
          expect(fl.det).toBeGreaterThan(fl.econ);
          expect(fl.H).toBe(fl.det);
          floors++;
          w.us.setTroops(Math.ceil(atFloor ? fl.H : fl.econ));
          const before = w.attacksOnUs.length;
          step(w, 2);
          if (w.attacksOnUs.length > before) attackedAt++;
          // Its attacks end (the test takes their troops back) so that the
          // next decision starts from the same state.
          for (const a of w.nation.outgoingAttacks()) a.delete();
        }
        expect(floors).toBe(4);
        if (atFloor) expect(attackedAt).toBe(0);
        else expect(attackedAt).toBeGreaterThan(0);
      }
    }
  });
});

// ── The winning counter through the live policy ──────────────────────────

/** Only the DefenseController (as tests/agent/apex/Recall.test.ts). */
const DEFENSE_ONLY = {
  expansion: false,
  diplomacy: false,
  boats: false,
  economy: false,
  strike: false,
  endgame: false,
  spawnMode: "plan",
  recall: false,
  cancelTnOnThreat: false,
} as const;

interface Live {
  game: Game;
  us: Player;
  nation: Player;
  s: ApexState;
  h: Harness;
}

/** Our field: the nation on x 0-19, us on the rest; with `second`, a
 *  second nation on x 80-99 (it borders us, not the first). */
function live(options: Record<string, unknown>, second = false): Live {
  const width = 100;
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
  const nations = [nationObj];
  if (second) {
    nations.push(
      new Nation(
        new Cell(99, 0),
        new PlayerInfo("second", PlayerType.Nation, null, SECOND_ID),
      ),
    );
  }
  const game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    nations,
    map,
    mini,
    config,
  );
  game.endSpawnPhase();
  const us = game.player(AGENT_ID);
  const nation = game.player(NATION_ID);
  const other = second ? game.player(SECOND_ID) : null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      (x < 20 ? nation : other !== null && x >= 80 ? other : us).conquer(
        game.ref(x, y),
      );
    }
  }
  const f: Field = {
    game,
    config,
    me: us,
    executor: new Executor(game, "counter", undefined),
  };
  const s = createState();
  const policy = new ApexPolicy(
    parseApexOptions({ ...DEFENSE_ONLY, ...options }),
    s,
  );
  const h = new Harness(f, (ctx) => policy.tick({ ...ctx, gameID: "counter" }));
  for (let i = 0; i < 60; i++) h.step();
  return { game, us, nation, s, h };
}

function relationOf(from: Player, to: Player): number {
  const rel = (from as unknown as { relations: Map<Player, number> }).relations;
  return rel.get(to) ?? 0;
}

/** Our cap in the live field (1,600 tiles, no cities). */
function capOf(w: Live): number {
  return w.game.config().maxTroops(w.us);
}

/** The nation attacks us with `share`·cap troops (its AttackExecution, as
 *  its decision would add it) while our home is `home`·cap and it holds
 *  `nationMult` times its stack before the send. Returns the
 *  intents of the tick the policy first sees it, and the troops of their
 *  attack then (S). Those intents init in the same step. */
function invade(
  w: Live,
  share: number,
  home = 1,
  nationMult = 2,
): { sent: AgentIntent[]; S: number } {
  const cap = capOf(w);
  w.us.setTroops(Math.floor(home * cap));
  w.nation.setTroops(Math.floor(nationMult * share * cap));
  w.game.addExecution(
    new AttackExecution(Math.floor(share * cap), w.nation, AGENT_ID, null),
  );
  w.h.step(); // the turn it inits in
  let S = 0;
  for (const a of w.nation.outgoingAttacks()) {
    if (a.target() === w.us) S += a.troops();
  }
  return { sent: w.h.step(), S }; // the policy sees it; ours inits
}

const countersIn = (sent: AgentIntent[]) =>
  sent.filter((i) => i.type === "attack" && i.targetID === NATION_ID) as {
    type: "attack";
    troops: number;
  }[];

describe("winning counter (o.detCounter) through the live policy", () => {
  test("off by default: the attack is absorbed", () => {
    const w = live({});
    expect(countersIn(invade(w, 0.4).sent)).toEqual([]);
  });

  test("size > 1: ceil(S·size) + 1 the tick it is seen; their attack is deleted at init, ours goes on, −100 relation", () => {
    const w = live({ detCounter: true });
    const tiles = w.us.numTilesOwned();
    const stack = Math.floor(0.4 * capOf(w));
    const { sent, S } = invade(w, 0.4);
    expect(S).toBeGreaterThan(0.95 * stack);
    expect(S).toBeLessThanOrEqual(stack);
    const c = countersIn(sent);
    expect(c).toEqual([
      { type: "attack", targetID: NATION_ID, troops: counterTroops(S, 1.02) },
    ]);
    // Our counter has init: their attack is gone.
    expect(w.nation.outgoingAttacks().some((a) => a.target() === w.us)).toBe(
      false,
    );
    const ours = w.us.outgoingAttacks().find((a) => a.target() === w.nation);
    expect(ours).toBeDefined();
    expect(ours!.troops()).toBeLessThan(0.05 * c[0].troops);
    expect(relationOf(w.nation, w.us)).toBeLessThanOrEqual(-99);
    // It took at most a few tiles before our counter.
    expect(w.us.numTilesOwned()).toBeGreaterThan(tiles - 60);
    expect(defenseMemory(w.s).stats.counterWins).toBe(1);
    expect(w.s.log.some((l) => l.includes("def counterwin nation"))).toBe(true);
    // Not re-sent while nothing new comes.
    for (let i = 0; i < 10; i++) expect(countersIn(w.h.step())).toEqual([]);
  });

  test("size < 1: ours is deleted after cancelling that much, theirs keeps the rest, no relation hit", () => {
    const w = live({ detCounter: true, detCounterSize: 0.97 });
    const { sent, S } = invade(w, 0.4);
    const c = countersIn(sent);
    expect(c).toEqual([
      { type: "attack", targetID: NATION_ID, troops: counterTroops(S, 0.97) },
    ]);
    // Ours has init and been deleted after cancelling as much of theirs.
    expect(w.us.outgoingAttacks().some((a) => a.target() === w.nation)).toBe(
      false,
    );
    const theirs = w.nation.outgoingAttacks().find((a) => a.target() === w.us);
    expect(theirs).toBeDefined();
    expect(theirs!.troops()).toBeLessThanOrEqual(S - c[0].troops);
    expect(theirs!.troops()).toBeGreaterThan(0);
    expect(relationOf(w.nation, w.us)).toBeGreaterThan(-50);
  });

  test("not sent when home would fall under detCounterKeep·cap, for stacks under detCounterMin of home, or while a request to it is pending", () => {
    // Home 0.6·cap, stack 0.4·cap: 0.6 − 0.408 < 0.3.
    const poor = live({ detCounter: true });
    expect(countersIn(invade(poor, 0.4, 0.6).sent)).toEqual([]);
    // With keep 0 it goes (home still keeps H_vw = 0.17·cap).
    const bold = live({ detCounter: true, detCounterKeep: 0 });
    expect(countersIn(invade(bold, 0.4, 0.6).sent)).toHaveLength(1);
    // A stack of 1% of home is under detCounterMin (5%).
    const small = live({ detCounter: true });
    expect(countersIn(invade(small, 0.01).sent)).toEqual([]);
    // A recall to it awaiting its answer (the DefenseController's own; a
    // request sent before its attack is rejected by that attack's init,
    // AttackExecution.ts:113-122).
    const pending = live({ detCounter: true });
    const t = pending.game.ticks();
    defenseMemory(pending.s).recalls[NATION_ID] = { at: t, d: t + 50, p: 1 };
    expect(countersIn(invade(pending, 0.4).sent)).toEqual([]);
  });

  test("detCounterDecisive: only when the nation cannot attack us again at its next decision", () => {
    // It keeps its stack's worth (0.4·cap) after the send: against our
    // home 0.59·cap it cannot send 20% of it (NationModel.canLandAttackUs).
    const spent = live({ detCounter: true, detCounterDecisive: true });
    expect(countersIn(invade(spent, 0.4, 1, 2).sent)).toHaveLength(1);
    // It keeps five stacks: it would attack again, so no counter.
    const rich = live({ detCounter: true, detCounterDecisive: true });
    expect(countersIn(invade(rich, 0.4, 1, 6).sent)).toEqual([]);
    // Not decisive-gated: the counter goes either way.
    const any = live({ detCounter: true });
    expect(countersIn(invade(any, 0.4, 1, 6).sent)).toHaveLength(1);
  });

  test("detCounterNoUnlock: no counter that would let a second, deterred nation attack us", () => {
    // The second nation holds 0.8 of our cap: against our home at the cap
    // its send cap T − ceil(0.9·H) is 0, against home − X (0.59·cap) it
    // passes the 20% floor (the real NationModel.canLandAttackUs).
    const run = (opts: Record<string, unknown>, share: number) => {
      const w = live({ detCounter: true, ...opts }, true);
      w.game.player(SECOND_ID).setTroops(Math.floor(share * capOf(w)));
      return { w, sent: countersIn(invade(w, 0.4).sent) };
    };
    const guarded = run({}, 0.8);
    expect(guarded.sent).toEqual([]);
    expect(
      guarded.w.s.log.some((l) =>
        l.includes("def counterskip nation unlocks second (land)"),
      ),
    ).toBe(true);
    // Without the guard the counter goes.
    expect(run({ detCounterNoUnlock: false }, 0.8).sent).toHaveLength(1);
    // A second nation that cannot attack us at home − X either: it goes.
    expect(run({}, 0.3).sent).toHaveLength(1);
  });
});

describe("unlockedBy (stand-ins)", () => {
  // canLandAttackUs as the land line: T − ceil(0.9·H) ≥ 0.2·H.
  function nmOf(
    nations: Record<
      string,
      { T: number; border?: boolean; gate?: Gate; smallID: number }
    >,
  ): NationModel {
    return {
      sendCapSafe: () => sendCapSafe(Difficulty.Impossible),
      get: (id: string) =>
        nations[id] === undefined
          ? undefined
          : ({
              id,
              smallID: nations[id].smallID,
              full: true,
              sharesBorderWithUs: nations[id].border ?? true,
            } as unknown as NationState),
      nextDecision: (_id: string, from: number) => from + 7,
      gates: (id: string) => nations[id].gate ?? "open",
      troopsAt: (id: string) => nations[id].T,
      canLandAttackUs: (id: string, H: number) =>
        nations[id].T - Math.ceil(0.9 * H) >= 0.2 * H,
    } as unknown as NationModel;
  }
  const meWith = (allies: string[]) =>
    ({
      allies: () => allies.map((id) => ({ id: () => id })),
    }) as unknown as Player;

  test("a nation deterred at home but not at the lower home unlocks; one already able to attack, off our border, or the excepted one does not", () => {
    const nm = nmOf({
      A: { T: 100_000, smallID: 1 }, // line 90,909
      B: { T: 200_000, smallID: 2 }, // attacks us at 100k already
      C: { T: 100_000, smallID: 3, border: false },
    });
    const me = meWith([]);
    // 100k → 95k: A still deterred (95k > 90.9k).
    expect(
      unlockedBy(me, nm, 100, ["A", "B", "C"], null, 1e5, 95e3, 0.34),
    ).toBe(null);
    // 100k → 80k: A can attack at 80k.
    expect(
      unlockedBy(me, nm, 100, ["A", "B", "C"], null, 1e5, 80e3, 0.34),
    ).toEqual({ id: "A", kind: "land" });
    expect(unlockedBy(me, nm, 100, ["A", "B", "C"], "A", 1e5, 80e3, 0.34)).toBe(
      null,
    );
    // A raise never unlocks.
    expect(unlockedBy(me, nm, 100, ["A"], null, 80e3, 1e5, 0.34)).toBe(null);
  });

  test("an ally at or above its reserve whose betrayal line the lower home crosses; not when locked, below reserve, or with betrayShare 0", () => {
    const nm = nmOf({
      A: { T: 300_000, smallID: 1 }, // betrayal line 0.34·300k = 102k
      L: { T: 300_000, smallID: 2, gate: "locked" },
      R: { T: 300_000, smallID: 3, gate: "belowReserve" },
    });
    const me = meWith(["A", "L", "R"]);
    expect(
      unlockedBy(me, nm, 100, ["A", "L", "R"], null, 110e3, 100e3, 0.34),
    ).toEqual({ id: "A", kind: "betray" });
    expect(unlockedBy(me, nm, 100, ["L", "R"], null, 110e3, 100e3, 0.34)).toBe(
      null,
    );
    expect(unlockedBy(me, nm, 100, ["A"], null, 110e3, 100e3, 0)).toBe(null);
    // Already under the line: not counted (the counter does not cross it).
    expect(unlockedBy(me, nm, 100, ["A"], null, 100e3, 90e3, 0.34)).toBe(null);
  });

  test("nationIds: the living nations in smallID order", () => {
    const w = live({}, true);
    expect(nationIds(w.game)).toEqual([NATION_ID, SECOND_ID]);
  });
});

describe("defense posts (o.detPosts)", () => {
  test("frontTiles and postSites: the front with the nation, a site depth tiles behind it, nothing once covered", () => {
    const w = live({});
    const front = frontTiles(w.game, w.us, w.nation);
    // The nation holds x 0-19, we hold x 20-99 on 20 rows.
    expect(front).toHaveLength(20);
    expect(front.every((t) => w.game.x(t) === 20)).toBe(true);
    const sites = postSites(w.game, w.us, w.nation, front, [], 30, 8, 40);
    expect(sites.length).toBeGreaterThan(0);
    // Every candidate is 8 tiles behind the front; the best covers it all.
    expect(sites.every((x) => w.game.x(x.tile) === 28)).toBe(true);
    expect(sites[0].covers).toBe(20);
    expect(
      postSites(w.game, w.us, w.nation, front, [w.game.ref(28, 10)], 30, 8, 40),
    ).toEqual([]);
  });

  function postsSent(w: Live, ticks: number): AgentIntent[] {
    const out: AgentIntent[] = [];
    for (let i = 0; i < ticks; i++) {
      for (const x of w.h.step()) {
        if (x.type === "build_unit" && x.unit === UnitType.DefensePost) {
          out.push(x);
        }
      }
    }
    return out;
  }

  test("an invasion with gold for a post: one post on the front, built; none without gold or with the option off", () => {
    for (const [opts, gold, want] of [
      [{ detPosts: true, detPostReactive: true }, 1_000_000n, 1],
      [{ detPosts: true, detPostReactive: true }, 10_000n, 0],
      [{ detPostReactive: true }, 1_000_000n, 0],
    ] as const) {
      const w = live(opts);
      w.us.addGold(gold);
      invade(w, 0.4);
      const sent = postsSent(w, 25);
      expect(sent).toHaveLength(want);
      if (want === 0) continue;
      const at = (sent[0] as { tile: number }).tile;
      expect(w.game.owner(at)).toBe(w.us);
      expect(w.game.x(at)).toBeGreaterThanOrEqual(24);
      for (let i = 0; i < 60; i++) w.h.step();
      const posts = w.us.units(UnitType.DefensePost);
      expect(posts).toHaveLength(1);
      expect(posts[0].isUnderConstruction()).toBe(false);
      expect(defenseMemory(w.s).stats.posts).toBe(1);
    }
  });

  test("proactive (the default): a post against a bordering nation our home cannot deter, before it attacks; none with detPostProactive off", () => {
    for (const proactive of [true, false]) {
      const w = live({ detPosts: true, detPostProactive: proactive });
      w.us.addGold(1_000_000n);
      // Its troops at 0.9 of its cap, our home at 0.3 of ours: it can
      // land-attack us (T − ceil(0.9·H) ≥ 0.2·H) and we are its weakest.
      w.nation.setTroops(Math.floor(0.9 * w.game.config().maxTroops(w.nation)));
      w.us.setTroops(Math.floor(0.3 * capOf(w)));
      const sent = postsSent(w, 25);
      expect(sent).toHaveLength(proactive ? 1 : 0);
      if (!proactive) continue;
      const at = (sent[0] as { tile: number }).tile;
      // detPostDepth (15) behind the front at x = 20.
      expect(w.game.x(at)).toBeGreaterThanOrEqual(33);
      expect(
        w.s.log.some((l) => l.includes("def post vs nation (threat")),
      ).toBe(true);
      // At most detPostsMax ordered in a game.
      const capped = live({ detPosts: true, detPostsMax: 0 });
      capped.us.addGold(1_000_000n);
      capped.nation.setTroops(
        Math.floor(0.9 * capped.game.config().maxTroops(capped.nation)),
      );
      capped.us.setTroops(Math.floor(0.3 * capOf(capped)));
      expect(postsSent(capped, 25)).toEqual([]);
    }
  });

  test("detPostMinShare, detPostMinThreat and detPostLead: none that covers too little of the front or against a small potential send; one against a nation just short of the line with the lead, none without", () => {
    // Its potential send at our home 0.3·cap is about 1.5 times that home:
    // over detPostMinThreat 0.15, under 2.
    // A post must cover detPostMinShare of the front: over 1, none can.
    const share = live({ detPosts: true, detPostMinShare: 1.1 });
    share.us.addGold(1_000_000n);
    share.nation.setTroops(
      Math.floor(0.9 * share.game.config().maxTroops(share.nation)),
    );
    share.us.setTroops(Math.floor(0.3 * capOf(share)));
    expect(postsSent(share, 25)).toEqual([]);
    const small = live({ detPosts: true, detPostMinThreat: 2 });
    small.us.addGold(1_000_000n);
    small.nation.setTroops(
      Math.floor(0.9 * small.game.config().maxTroops(small.nation)),
    );
    small.us.setTroops(Math.floor(0.3 * capOf(small)));
    expect(postsSent(small, 25)).toEqual([]);
    // Our home at 1.05 of its land line T/1.1: deterred now, not at 0.9 of
    // that home (the default lead).
    for (const [lead, want] of [
      [0.1, 1],
      [0, 0],
    ] as const) {
      const w = live({ detPosts: true, detPostLead: lead });
      w.us.addGold(1_000_000n);
      const T = Math.floor(0.9 * w.game.config().maxTroops(w.nation));
      w.nation.setTroops(T);
      w.us.setTroops(Math.floor((T / 1.1) * 1.05));
      expect(postsSent(w, 25)).toHaveLength(want);
    }
  });
});

describe("potentialSend (stand-ins)", () => {
  test("min(T(d) − reserve·M, the send cap at its troops now shifted by its regrowth to d)", () => {
    const N = { id: () => "N", troops: () => 100_000 } as unknown as Player;
    const models = { cap: () => 200_000 } as unknown as Models;
    const nmWith = (T: number, cap: number) =>
      ({
        troopsAt: () => T,
        params: () => ({ reserve: 0.3 }),
        sendCap: () => cap,
      }) as unknown as NationModel;
    // T(d) − reserve·M = 110k − 60k = 50k; the cap 30k + 10k of regrowth.
    expect(potentialSend(nmWith(110_000, 30_000), models, N, 0, 7)).toBe(
      40_000,
    );
    // The reserve binds.
    expect(potentialSend(nmWith(110_000, 90_000), models, N, 0, 7)).toBe(
      50_000,
    );
    // Never negative (below its reserve).
    expect(potentialSend(nmWith(50_000, 0), models, N, 0, 7)).toBe(0);
  });
});
