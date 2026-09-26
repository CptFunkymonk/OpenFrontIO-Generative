/**
 * The DefenseController's recall by alliance (apex spec §3.3.2, §4 step 3),
 * embargo hygiene (§3.3.4) and free TN cancel (§3.3.3), driven through the
 * live ApexPolicy on the N3 pin's scenario
 * (tests/agent/mechanics/AllianceRecallEmbargo.test.ts, VERDICT TRUE): a
 * real NationExecution attacks us by its own decision, and the policy
 * reacts through ctx.send at latency 1 (the Harness of ./Field.ts).
 *
 * The scenario, as in the pin: the real Config, FFA, Singleplayer,
 * Impossible; a 100x20 all-plains map, the nation on x 0-9 (200 tiles), us
 * on the next 400 tiles, free land beyond (the nation never touches it, so
 * its only bordering player is us). No PlayerExecution runs, so troops and
 * relations stay where the test puts them. The test arms both sides before
 * each nation decision (never during one) so that it attacks us
 * ("weakest"), rejects any request of its own to us (the counter-accept path
 * would ally at once and skip the embargo), and sets troops before the
 * answering decision so that we are similarly strong for every draw. All of
 * that is the test acting on the game; the policy only reads it. Only the
 * DefenseController runs (every other controller is disabled by option).
 *
 * Claims:
 * - The policy sends `embargo stop` and `allianceRequest` together, at
 *   Prio.Recall, the first tick it sees the attack (tReq = T, the nation
 *   having just decided); the nation accepts at its next decision with its
 *   relation to us still 0, and its attack retreats in full.
 * - With embargoStop off the forecast sees the −20 malus and sends nothing;
 *   forced (recallMinP 0), the request goes alone and is refused (N3's
 *   negative control).
 * - An embargo re-created between the request and its decision (a boat
 *   landing's init does that; the test calls addEmbargo as it would) is
 *   stopped again the next tick, and the request is still accepted.
 * - Hygiene: with the recall off, the embargo is stopped the tick it is
 *   seen, so the nation's next decision applies no malus.
 * - Free TN cancel: incoming nation troops above home − H_vw cancel our
 *   free-land attack (Prio.Emergency), guarded the next tick, at most once
 *   per 50 ticks; the troops come home.
 * - The policy never counter-attacks, breaks an alliance, targets or sends
 *   emojis.
 */
import { AgentIntent } from "../../../src/agent/Agent";
import { defenseMemory } from "../../../src/agent/agents/apex/controllers/DefenseController";
import { parseApexOptions } from "../../../src/agent/agents/apex/options";
import { ApexPolicy } from "../../../src/agent/agents/apex/policy";
import { ApexState, createState } from "../../../src/agent/agents/apex/state";
import { Config } from "../../../src/core/configuration/Config";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { NationExecution } from "../../../src/core/execution/NationExecution";
import {
  AllianceRequest,
  Attack,
  Cell,
  Game,
  Nation,
  Player,
  PlayerInfo,
  PlayerType,
  Relation,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { ATTACK_INDEX_CANCEL } from "../../../src/core/StatsSchemas";
import {
  AGENT_CLIENT,
  AGENT_ID,
  Field,
  GAME_CONFIG,
  Harness,
  submit,
} from "./Field";

const NATION_ID = "NATION01";
const LAND = 0x80 | 5;
const WIDTH = 100;
const HEIGHT = 20;
const US_TILES = 400;
/** The pin's troop shares (AllianceRecallEmbargo.test.ts). */
const NATION_SHARE = 0.62;
const US_SHARE = 0.8;
const SIMILAR = 0.9;
const GAME_IDS = ["recall-a", "recall-b", "recall-c", "recall-d", "recall-e"];

/** Only the DefenseController: everything else off by option. */
const DEFENSE_ONLY = {
  expansion: false,
  diplomacy: false,
  boats: false,
  economy: false,
  strike: false,
  endgame: false,
  spawnMode: "plan",
} as const;

interface NationInternals {
  attackRate: number;
  attackTick: number;
  behaviorsInitialized: boolean;
}

interface World {
  f: Field;
  game: Game;
  config: Config;
  us: Player;
  nation: Player;
  exec: NationExecution;
  n: NationInternals;
  s: ApexState;
  h: Harness;
  /** Every intent the policy sent, with its tick. */
  sent: { tick: number; intent: AgentIntent }[];
}

function world(gameID: string, options: Record<string, unknown> = {}): World {
  const t = new Uint8Array(WIDTH * HEIGHT).fill(LAND);
  const mw = WIDTH / 2;
  const mh = HEIGHT / 2;
  const m = new Uint8Array(mw * mh).fill(LAND);
  const map = new GameMapImpl(WIDTH, HEIGHT, t, WIDTH * HEIGHT);
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
  for (let x = 0; x < 10; x++) {
    for (let y = 0; y < HEIGHT; y++) nation.conquer(game.ref(x, y));
  }
  for (let i = 0; i < US_TILES; i++) {
    us.conquer(game.ref(10 + Math.floor(i / HEIGHT), i % HEIGHT));
  }
  const exec = new NationExecution(gameID, nationObj);
  const f: Field = {
    game,
    config,
    me: us,
    executor: new Executor(game, gameID, undefined),
  };
  const s = createState();
  const policy = new ApexPolicy(
    parseApexOptions({ ...DEFENSE_ONLY, ...options }),
    s,
  );
  const h = new Harness(f, (ctx) => policy.tick({ ...ctx, gameID }));
  return {
    f,
    game,
    config,
    us,
    nation,
    exec,
    n: exec as unknown as NationInternals,
    s,
    h,
    sent: h.sentLog,
  };
}

/** One agent tick and one turn. */
function step(w: World, n = 1): AgentIntent[] {
  const out: AgentIntent[] = [];
  for (let i = 0; i < n; i++) out.push(...w.h.step());
  return out;
}

/** Runs agent ticks and turns until game.ticks() === t. */
function stepTo(w: World, t: number): void {
  expect(w.game.ticks()).toBeLessThanOrEqual(t);
  while (w.game.ticks() < t) w.h.step();
}

function isDecision(w: World, t: number): boolean {
  return t % w.n.attackRate === w.n.attackTick;
}

function nextDecisionTurn(w: World, from: number): number {
  let d = from;
  while (!isDecision(w, d)) d++;
  return d;
}

function attackOnUs(w: World): Attack | undefined {
  return w.nation.outgoingAttacks().find((a) => a.target() === w.us);
}

function relationValue(from: Player, to: Player): number {
  const rel = (from as unknown as { relations: Map<Player, number> }).relations;
  return rel.get(to) ?? 0;
}

function arm(w: World): void {
  const T = Math.floor(w.config.maxTroops(w.nation) * NATION_SHARE);
  w.nation.setTroops(T);
  w.us.setTroops(Math.floor(T * US_SHARE));
}

/**
 * Past tick 700, adds the nation's execution and runs its decisions, armed,
 * until one attacks us. The policy acts on every tick but the decision
 * turns' aftermath when the nation asked us itself: then the test rejects
 * that request in a turn of its own, without the agent. Afterwards
 * game.ticks() is the first tick the policy has not yet seen the attack at.
 */
function untilItAttacks(w: World): number {
  stepTo(w, 750);
  w.game.addExecution(w.exec);
  step(w, 3);
  expect(w.n.behaviorsInitialized).toBe(true);
  for (let k = 0; k < 20; k++) {
    const d = nextDecisionTurn(w, w.game.ticks());
    stepTo(w, d);
    arm(w);
    step(w);
    const theirs = w.us
      .incomingAllianceRequests()
      .filter((r) => r.requestor() === w.nation);
    if (theirs.length > 0) {
      submit(w.f, { type: "allianceReject", requestor: NATION_ID });
      w.game.executeNextTick();
      expect(theirs[0].status()).toBe("rejected");
    }
    if (attackOnUs(w) !== undefined) return d;
  }
  throw new Error("the nation never attacked us");
}

function ourRequest(w: World): AllianceRequest | undefined {
  return w.nation
    .incomingAllianceRequests()
    .find((r) => r.requestor() === w.us);
}

interface Outcome {
  accepted: boolean;
  answeredAt: number;
  relation: number;
  attackTroops: number;
  homeBefore: number;
  homeAfter: number;
  attacksAfter: number;
}

/** Runs the policy to the decision answering `req`, sets the pin's troops
 *  just before it, and runs that turn. */
function answer(w: World, req: AllianceRequest): Outcome {
  const d = nextDecisionTurn(w, req.createdAt() + 1);
  stepTo(w, d);
  const attack = attackOnUs(w);
  const attackTroops = attack?.troops() ?? 0;
  const T = Math.floor(w.config.maxTroops(w.nation) * NATION_SHARE);
  w.nation.setTroops(T);
  w.us.setTroops(Math.floor((T + attackTroops) * SIMILAR) + 1);
  const homeBefore = w.nation.troops();
  step(w);
  expect(req.status()).not.toBe("pending");
  return {
    accepted: req.status() === "accepted",
    answeredAt: d,
    relation: relationValue(w.nation, w.us),
    attackTroops,
    homeBefore,
    homeAfter: w.nation.troops(),
    attacksAfter: attackOnUs(w) === undefined ? 0 : 1,
  };
}

const STOP: AgentIntent = {
  type: "embargo",
  targetID: NATION_ID,
  action: "stop",
};
const REQUEST: AgentIntent = {
  type: "allianceRequest",
  recipient: NATION_ID,
};

/** §3.3.5: nothing aggressive, ever. */
function expectNothingAggressive(w: World): void {
  const allowed = new Set(["embargo", "allianceRequest", "cancel_attack"]);
  for (const x of w.sent) expect(allowed.has(x.intent.type)).toBe(true);
  for (const x of w.sent) {
    if (x.intent.type === "embargo") expect(x.intent.action).toBe("stop");
  }
}

describe("apex recall (spec §3.3.2) on the N3 scenario", () => {
  test("stop + request the tick the attack is seen: accepted, and its attack retreats in full", () => {
    for (const id of GAME_IDS) {
      const w = world(id);
      untilItAttacks(w);
      const T = w.game.ticks();
      expect(nextDecisionTurn(w, T + 1)).toBeGreaterThanOrEqual(T + 2);
      // The policy's first look at the attack.
      const now = step(w);
      expect(now).toEqual([STOP, REQUEST]);
      const req = ourRequest(w);
      expect(req).toBeDefined();
      expect(req!.createdAt()).toBe(T);
      const o = answer(w, req!);
      expect(o.answeredAt).toBeGreaterThanOrEqual(T + 2);
      expect(o.accepted).toBe(true);
      expect(o.relation).toBe(0);
      expect(w.us.isAlliedWith(w.nation)).toBe(true);
      expect(o.attackTroops).toBeGreaterThan(0);
      expect(o.attacksAfter).toBe(0);
      expect(o.homeAfter - o.homeBefore).toBe(Math.floor(o.attackTroops));
      // Nothing else was needed: one stop, one request.
      expect(w.sent.map((x) => x.intent)).toEqual([STOP, REQUEST]);
      // The recall is logged as accepted once its decision has passed.
      step(w);
      const mem = defenseMemory(w.s);
      expect(mem.stats.recalls).toBe(1);
      expect(mem.stats.accepted).toBe(1);
      expectNothingAggressive(w);
    }
  });

  test("embargoStop off: the forecast sees the malus and sends nothing; forced, the lone request is refused", () => {
    for (const id of GAME_IDS) {
      const quiet = world(id, { embargoStop: false });
      untilItAttacks(quiet);
      step(quiet, 5);
      expect(quiet.sent).toEqual([]);
      expect(ourRequest(quiet)).toBeUndefined();

      const forced = world(id, { embargoStop: false, recallMinP: 0 });
      untilItAttacks(forced);
      expect(step(forced)).toEqual([REQUEST]);
      const o = answer(forced, ourRequest(forced)!);
      expect(o.accepted).toBe(false);
      expect(o.relation).toBe(-20);
      expect(forced.nation.relation(forced.us)).toBe(Relation.Distrustful);
      expect(forced.sent.map((x) => x.intent)).toEqual([REQUEST]);
      expectNothingAggressive(forced);
    }
  });

  test("an embargo re-created before the answering decision is stopped again", () => {
    for (const id of GAME_IDS) {
      const w = world(id);
      untilItAttacks(w);
      const T = w.game.ticks();
      expect(step(w)).toEqual([STOP, REQUEST]);
      const req = ourRequest(w)!;
      const d = nextDecisionTurn(w, T + 1);
      // Our first stop has acted by T + 2.
      stepTo(w, T + 2);
      expect(w.us.hasEmbargoAgainst(w.nation)).toBe(false);
      // A boat landing's init re-creates the embargo (AttackExecution.ts:
      // 113-122); here, well before d − 2.
      const at = Math.min(T + 5, d - 3);
      stepTo(w, at);
      w.us.addEmbargo(w.nation, true);
      expect(step(w)).toEqual([STOP]);
      const o = answer(w, req);
      expect(o.accepted).toBe(true);
      expect(o.relation).toBe(0);
      expect(w.sent.map((x) => x.intent)).toEqual([STOP, REQUEST, STOP]);
      expectNothingAggressive(w);
    }
  });

  test("hygiene: with the recall off, the embargo is stopped at once and no malus lands", () => {
    for (const id of GAME_IDS) {
      const w = world(id, { recall: false });
      untilItAttacks(w);
      expect(w.us.hasEmbargoAgainst(w.nation)).toBe(true);
      expect(step(w)).toEqual([STOP]);
      step(w);
      expect(w.us.hasEmbargoAgainst(w.nation)).toBe(false);
      // Its next decision: no malus, the relation stays 0.
      const d = nextDecisionTurn(w, w.game.ticks());
      stepTo(w, d);
      step(w);
      expect(relationValue(w.nation, w.us)).toBe(0);
      expect(w.nation.relation(w.us)).toBe(Relation.Neutral);
      expect(w.sent.filter((x) => x.intent.type === "allianceRequest")).toEqual(
        [],
      );
      expectNothingAggressive(w);
    }
  });

  test("counter (off by default): an absorbed attack is met by one smaller than it, deleted at init with no relation hit", () => {
    for (const on of [false, true]) {
      const w = world("counter-a", {
        recall: false,
        counter: on,
        counterShare: 0,
        counterNearCap: 0,
      });
      untilItAttacks(w);
      const theirs = attackOnUs(w)!;
      const before = theirs.troops();
      const relBefore = relationValue(w.nation, w.us);
      const sent = step(w);
      const counters = sent.filter(
        (i) => i.type === "attack" && i.targetID === NATION_ID,
      );
      if (!on) {
        expect(counters).toEqual([]);
        continue;
      }
      expect(counters).toHaveLength(1);
      const X = (counters[0] as { troops: number }).troops;
      expect(X).toBeGreaterThan(0);
      expect(X).toBeLessThan(before);
      step(w, 2);
      // It cancelled X of the attack's troops 1:1.
      expect(theirs.troops()).toBeLessThanOrEqual(before - X);
      // Deleted at init: no attack of ours on it, and its relation to us
      // took no −100 (only decay and its own malus moves it).
      expect(w.us.outgoingAttacks().some((a) => a.target() === w.nation)).toBe(
        false,
      );
      expect(relationValue(w.nation, w.us)).toBeGreaterThan(relBefore - 50);
      expect(w.s.log.some((l) => l.includes("def counter"))).toBe(true);
    }
  });

  test("free TN cancel: once per 50 ticks, guarded the next tick, troops come home", () => {
    const w = world(GAME_IDS[0], { recall: false });
    // Our free-land attack, sent by the test at the nation's attack
    // decision so that both run when the policy looks.
    stepTo(w, 750);
    w.game.addExecution(w.exec);
    step(w, 3);
    let seenAt = -1;
    for (let k = 0; k < 20 && seenAt < 0; k++) {
      const d = nextDecisionTurn(w, w.game.ticks());
      stepTo(w, d);
      arm(w);
      submit(w.f, { type: "attack", targetID: null, troops: 3000 });
      step(w);
      const theirs = w.us
        .incomingAllianceRequests()
        .filter((r) => r.requestor() === w.nation);
      if (theirs.length > 0) {
        submit(w.f, { type: "allianceReject", requestor: NATION_ID });
        w.game.executeNextTick();
      }
      if (attackOnUs(w) !== undefined) seenAt = w.game.ticks();
    }
    expect(seenAt).toBeGreaterThan(0);
    const tn = () =>
      w.us.outgoingAttacks().filter((a) => !a.target().isPlayer());
    expect(tn().length).toBe(1);
    const tnID = tn()[0].id();
    // Incoming above home − H_vw: our home just above the floor.
    const vw = 0.17 * w.config.maxTroops(w.us);
    const incoming = attackOnUs(w)!.troops();
    w.us.setTroops(Math.floor(vw + incoming / 2));
    const t0 = w.game.ticks();
    const cancel: AgentIntent = { type: "cancel_attack", attackID: tnID };
    expect(step(w)).toEqual([cancel, STOP]);
    // The guard: the retreat is ordered in this turn, so the cancel holds
    // the TN key once more.
    expect(step(w)).toEqual([cancel]);
    expect(tn()[0].retreating()).toBe(true);
    // It retreats 20 ticks after the cancel, without loss: every troop comes
    // home (the game's stats book them as cancelled survivors).
    const tnTroops = tn()[0].troops();
    const cancelled = () =>
      Number(
        w.game.stats().getPlayerStats(w.us)?.attacks?.[ATTACK_INDEX_CANCEL] ??
          0,
      );
    const c0 = cancelled();
    while (tn().length > 0 && w.game.ticks() < t0 + 25) step(w);
    expect(tn()).toEqual([]);
    expect(w.game.ticks()).toBeLessThanOrEqual(t0 + 22);
    expect(cancelled() - c0).toBe(Math.floor(tnTroops));
    // A new TN attack within 50 ticks of the cancel is not cancelled.
    stepTo(w, t0 + 30);
    submit(w.f, { type: "attack", targetID: null, troops: 6000 });
    step(w);
    expect(tn().length).toBe(1);
    const second = tn()[0].id();
    const before = w.sent.length;
    // Home just under H_vw: any incoming troops exceed home − H_vw, however
    // spent the nation's attack is by now.
    const low = () =>
      w.us.setTroops(Math.floor(0.9 * 0.17 * w.config.maxTroops(w.us)));
    while (w.game.ticks() < t0 + 50) {
      low();
      step(w);
    }
    expect(
      w.sent.slice(before).filter((x) => x.intent.type === "cancel_attack"),
    ).toEqual([]);
    // At t0 + 50 it is.
    expect(attackOnUs(w)).toBeDefined();
    expect(tn().map((a) => a.id())).toEqual([second]);
    low();
    expect(step(w)).toEqual([{ type: "cancel_attack", attackID: second }]);
    expect(defenseMemory(w.s).stats.tnCancels).toBeGreaterThanOrEqual(1);
    expectNothingAggressive(w);
  });
});
