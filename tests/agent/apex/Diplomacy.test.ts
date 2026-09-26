/**
 * The DiplomacyController (apex spec §3.4, §4 step 3): the alliance web's
 * requests, counter-accepts and slots.
 *
 * Claims, checked on every allianceRequest the live policy sends:
 * - A request (web or recall; a counter-accept is the other kind: the
 *   recipient's own request to us is pending, so ours accepts it at once
 *   and no nation answers it) goes only to a nation whose forecast for that
 *   very request (created now, answered at its next decision) was computed
 *   in the same tick and is at least allyMinP.
 * - No request before ctx tick numSpawnPhaseTurns() + 2 (a request created
 *   at <= +1 is refused, NationAllianceBehavior.ts:64-70).
 * - Never more than the slot limit: web requests only while alliances plus
 *   pending requests are below webTarget; alliances never above A_max.
 * - Food-list nations are never requested and never counter-accepted.
 * - Only nations are asked; no breakAlliance, targetPlayer or emoji, ever.
 *
 * Settings:
 * - Pangaea through the arena path (arenaGameStart -> createGameRunner,
 *   NodeMapLoader, AgentHost; FFA, Singleplayer, Impossible, default
 *   nations, 400 tribes), apex with its defaults playing our seat, 900
 *   ticks. The policy's NationModel is wrapped (test only) to record each
 *   forecast; the policy runs unchanged.
 * - A synthetic 200x100 plains field with four nations and no nation AI
 *   (the test creates their requests): A (5,000 tiles, bordering us), B (20
 *   tiles inside our land: food), C and D (2,500 tiles each, beyond A). With
 *   5 non-bot players A_max = 2 and webTarget = 1.
 */
import path from "path";
import { Agent, AgentContext, AgentIntent } from "../../../src/agent/Agent";
import { AgentHost } from "../../../src/agent/AgentHost";
import { diplomacyMemory } from "../../../src/agent/agents/apex/controllers/DiplomacyController";
import { parseApexOptions } from "../../../src/agent/agents/apex/options";
import { ApexPolicy } from "../../../src/agent/agents/apex/policy";
import { ApexState, createState } from "../../../src/agent/agents/apex/state";
import {
  arenaGameStart,
  seatClientID,
  type ArenaGameSpec,
} from "../../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../../src/agent/arena/NodeMapLoader";
import {
  AllianceForecast,
  AllianceQuery,
  NationModel,
} from "../../../src/agent/lib/NationModel";
import { allySlots } from "../../../src/agent/lib/RaceField";
import { Config } from "../../../src/core/configuration/Config";
import { AllianceRequestExecution } from "../../../src/core/execution/alliance/AllianceRequestExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import {
  Cell,
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameType,
  Nation,
  Player,
  PlayerID,
  PlayerInfo,
  PlayerType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { createGameRunner } from "../../../src/core/GameRunner";
import { StampedIntent } from "../../../src/core/Schemas";
import {
  AGENT_CLIENT,
  AGENT_ID,
  Field,
  GAME_CONFIG,
  GAME_ID,
  Harness,
} from "./Field";

const MAPS_DIR = path.join(__dirname, "../../../resources/maps");

interface ForecastCall {
  tick: number;
  n: PlayerID;
  q: AllianceQuery;
  f: AllianceForecast;
}

/** Records every forecast the policy's NationModel makes (test only: a
 *  wrapper that returns the real answer). */
function spyForecasts(
  policy: ApexPolicy,
  calls: ForecastCall[],
  tick: () => number,
): boolean {
  const rt = (policy as unknown as { rt: { nm: NationModel } | null }).rt;
  if (rt === null) return false;
  const nm = rt.nm;
  const real = nm.acceptsAlliance.bind(nm);
  nm.acceptsAlliance = (n: PlayerID, q: AllianceQuery) => {
    const f = real(n, q);
    calls.push({ tick: tick(), n, q, f });
    return f;
  };
  return true;
}

type Kind = "web" | "recall" | "counter";

interface SentRequest {
  tick: number;
  to: PlayerID;
  kind: Kind;
  /** Alliances and pending requests of ours before this send. */
  held: number;
  pending: number;
  food: boolean;
  forecast: ForecastCall | null;
}

/**
 * Watches one seat: classifies each allianceRequest at its send, checks
 * every intent type, and after each tick that alliances stay <= A_max.
 */
class Watch {
  readonly requests: SentRequest[] = [];
  readonly calls: ForecastCall[] = [];
  readonly other: AgentIntent[] = [];
  maxAlliances = 0;
  slotMaxSeen = Infinity;
  private spied = false;
  /** Pending requests sent earlier in this tick (not yet in the game). */
  private sentThisTick = 0;
  private tick = -1;

  constructor(
    readonly policy: ApexPolicy,
    readonly s: ApexState,
    readonly allyMinP: number,
  ) {}

  agent(): Agent {
    return {
      name: "apex",
      tick: (ctx) => this.run(ctx),
    };
  }

  run(ctx: AgentContext): void {
    if (ctx.tick !== this.tick) {
      this.tick = ctx.tick;
      this.sentThisTick = 0;
    }
    this.policy.tick({ ...ctx, send: (i) => this.send(ctx, i) });
    if (!this.spied) {
      this.spied = spyForecasts(this.policy, this.calls, () => this.tick);
    }
    const me = ctx.me;
    if (me.isAlive()) {
      const slots = allySlots(ctx.game, me, 0);
      this.maxAlliances = Math.max(this.maxAlliances, me.alliances().length);
      expect(me.alliances().length).toBeLessThanOrEqual(slots.max);
      this.slotMaxSeen = Math.min(this.slotMaxSeen, slots.max);
    }
  }

  private send(ctx: AgentContext, i: AgentIntent) {
    const r = ctx.send(i);
    if (r !== "ok") return r;
    if (i.type !== "allianceRequest") {
      this.other.push(i);
      return r;
    }
    const { game, me } = ctx;
    const N = game.player(i.recipient);
    expect(N.type()).toBe(PlayerType.Nation);
    const counter = me
      .incomingAllianceRequests()
      .some((q) => q.requestor() === N);
    const attacking = me.incomingAttacks().some((a) => a.attacker() === N);
    const kind: Kind = counter ? "counter" : attacking ? "recall" : "web";
    const forecast =
      [...this.calls]
        .reverse()
        .find((c) => c.tick === ctx.tick && c.n === N.id()) ?? null;
    this.requests.push({
      tick: ctx.tick,
      to: N.id(),
      kind,
      held: me.alliances().length,
      pending: me.outgoingAllianceRequests().length + this.sentThisTick,
      food: this.s.web.food.includes(N.id()),
      forecast,
    });
    if (kind !== "counter") this.sentThisTick++;
    return r;
  }

  /** The claims, for every request sent. */
  check(game: Game, webTarget: (tick: number) => number): void {
    const from = game.config().numSpawnPhaseTurns() + 2;
    for (const r of this.requests) {
      expect(r.food).toBe(false);
      if (r.kind === "counter") continue;
      expect(r.tick).toBeGreaterThanOrEqual(from);
      expect(r.forecast).not.toBeNull();
      const f = r.forecast!;
      expect(f.q.kind).toBe("request");
      expect(f.q.createdAt).toBe(r.tick);
      expect(f.q.atTick).toBeGreaterThan(r.tick);
      expect(f.f.p).toBeGreaterThanOrEqual(this.allyMinP);
      if (r.kind === "web") {
        expect(r.held + r.pending).toBeLessThan(webTarget(r.tick));
      }
    }
    const aggressive = new Set(["breakAlliance", "targetPlayer", "emoji"]);
    for (const i of this.other) expect(aggressive.has(i.type)).toBe(false);
  }
}

// ── Pangaea through the arena path ──────────────────────────────────────

describe("apex diplomacy on Pangaea (arena path, 900 ticks)", () => {
  test("requests only where the forecast says yes, from tick 102, within the slots, never to food", async () => {
    const gameID = "apexdiplo";
    const spec: Pick<
      ArenaGameSpec,
      | "gameID"
      | "map"
      | "mapSize"
      | "gameType"
      | "difficulty"
      | "nations"
      | "bots"
      | "seats"
    > = {
      gameID,
      map: GameMapType.Pangaea,
      mapSize: GameMapSize.Normal,
      gameType: GameType.Singleplayer,
      difficulty: Difficulty.Impossible,
      nations: "default",
      bots: 400,
      seats: [{ agent: "apex" }],
    };
    const gameStart = arenaGameStart(spec as ArenaGameSpec);
    const loader = new NodeMapLoader(MAPS_DIR);
    let fatal: string | null = null;
    const runner = await createGameRunner(
      gameStart,
      undefined,
      loader,
      (gu) => {
        if ("errMsg" in gu) fatal ??= gu.errMsg;
      },
    );
    const game = runner.game;
    const o = parseApexOptions();
    const s = createState();
    const policy = new ApexPolicy(o, s);
    const watch = new Watch(policy, s, o.allyMinP);
    const ME = seatClientID(0);
    const queue = new Map<number, StampedIntent[]>();
    let executed = 0;
    const host = new AgentHost({
      agent: watch.agent(),
      clientID: ME,
      gameStart,
      runner,
      deliver: (intent) => {
        const list = queue.get(executed) ?? [];
        list.push({ ...intent, clientID: ME });
        queue.set(executed, list);
      },
      nowMs: () => game.ticks() * 100,
      strict: true,
    });
    const webTargets = new Map<number, number>();
    for (let i = 0; i < 900; i++) {
      const intents = queue.get(executed) ?? [];
      queue.delete(executed);
      runner.addTurn({ turnNumber: executed, intents });
      if (!runner.executeNextTick() || fatal !== null) {
        throw new Error(fatal ?? `tick ${game.ticks()} did not execute`);
      }
      executed++;
      const me = game.playerByClientID(ME);
      if (me !== null) {
        webTargets.set(game.ticks(), allySlots(game, me, 0).webTarget);
      }
      host.tick();
    }
    expect(host.stats.errors).toBe(0);
    watch.check(game, (t) => webTargets.get(t) ?? 0);

    const me = game.playerByClientID(ME)!;
    const web = watch.requests.filter((r) => r.kind === "web");
    const accepted = web.filter((r) =>
      me.alliances().some((a) => a.other(me).id() === r.to),
    );
    const mem = diplomacyMemory(s);
    if (process.env.DIPLO_DEBUG) {
      process.stderr.write(
        `requests ${JSON.stringify(
          watch.requests.map((r) => [
            r.tick,
            r.kind,
            r.to,
            r.forecast?.f.p.toFixed(2),
            r.forecast?.f.branch,
          ]),
        )}\nalliances ${me.alliances().length} (max seen ${watch.maxAlliances}), ` +
          `food ${JSON.stringify(s.web.food)}, stats ${JSON.stringify(mem.stats)}\n`,
      );
    }
    // The web is used at all, and fills: most requests are accepted.
    expect(web.length).toBeGreaterThan(0);
    expect(web[0].tick).toBeGreaterThanOrEqual(
      game.config().numSpawnPhaseTurns() + 2,
    );
    expect(accepted.length).toBeGreaterThan(0);
    expect(me.alliances().length).toBeGreaterThan(0);
    expect(mem.stats.plans).toBeGreaterThan(900 / o.planEvery - 2);
  }, 120_000);
});

// ── A synthetic field: counter-accepts, food and slots ─────────────────

const W = 200;
const H = 100;
const LAND = 0x80 | 5;
const NATIONS = [
  { id: "NATIONAA", rect: [100, 0, 150, H], troops: 100_000 },
  { id: "NATIONBB", rect: [50, 0, 52, 10], troops: 5_000 },
  { id: "NATIONCC", rect: [150, 0, 175, H], troops: 80_000 },
  { id: "NATIONDD", rect: [175, 0, 200, H], troops: 80_000 },
] as const;
const [A, B, C, D] = NATIONS.map((n) => n.id);

interface Synth {
  f: Field;
  game: Game;
  us: Player;
  s: ApexState;
  watch: Watch;
  h: Harness;
  nation(id: string): Player;
}

function synth(options: Record<string, unknown>): Synth {
  const t = new Uint8Array(W * H).fill(LAND);
  const m = new Uint8Array((W / 2) * (H / 2)).fill(LAND);
  const map = new GameMapImpl(W, H, t, W * H);
  const mini = new GameMapImpl(W / 2, H / 2, m, (W * H) / 4);
  const config = new Config(GAME_CONFIG, null, false);
  const nations = NATIONS.map(
    (n, i) =>
      new Nation(
        new Cell(n.rect[0], i),
        new PlayerInfo(n.id.toLowerCase(), PlayerType.Nation, null, n.id),
      ),
  );
  const game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    nations,
    map,
    mini,
    config,
  );
  game.endSpawnPhase();
  const us = game.player(AGENT_ID);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < 100; x++) us.conquer(game.ref(x, y));
  }
  for (const n of NATIONS) {
    const p = game.player(n.id);
    const [x0, y0, x1, y1] = n.rect;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) p.conquer(game.ref(x, y));
    }
    p.setTroops(n.troops);
  }
  us.setTroops(150_000);
  const f: Field = {
    game,
    config,
    me: us,
    executor: new Executor(game, GAME_ID, undefined),
  };
  const o = parseApexOptions({
    expansion: false,
    boats: false,
    economy: false,
    strike: false,
    endgame: false,
    spawnMode: "plan",
    ...options,
  });
  const s = createState();
  const policy = new ApexPolicy(o, s);
  const watch = new Watch(policy, s, o.allyMinP);
  const h = new Harness(f, (ctx) => watch.run(ctx));
  return { f, game, us, s, watch, h, nation: (id) => game.player(id) };
}

describe("apex diplomacy on a synthetic field", () => {
  test("the plan: A in the ally set, B on the food list", () => {
    const w = synth({ web: false });
    w.h.step();
    w.h.step();
    expect(w.s.web.allySet).toEqual([A]);
    expect(w.s.web.food).toEqual([B]);
    expect(allySlots(w.game, w.us, 0)).toEqual({
      max: 2,
      ext: 1,
      webTarget: 1,
    });
  });

  test("in stall mode (stallDangerHome), danger is against the home we hold: A turns food when our home at the cap out-deters it", () => {
    for (const on of [true, false]) {
      const w = synth({ web: false, stallDangerHome: on });
      // Stall mode (the ExpansionController, off here, would set it).
      w.s.stall.since = -1000;
      w.us.setTroops(w.game.config().maxTroops(w.us));
      w.h.step();
      w.h.step();
      if (on) {
        expect(w.s.web.allySet).toEqual([]);
        expect([...w.s.web.food].sort()).toEqual([A, B].sort());
      } else {
        expect(w.s.web.allySet).toEqual([A]);
        expect(w.s.web.food).toEqual([B]);
      }
    }
  });

  test("counter-accept: web nations first, never food, never past A_max", () => {
    const w = synth({ web: false });
    for (let i = 0; i < 10; i++) w.h.step();
    // Every nation asks us (as maybeSendAllianceRequests would).
    for (const id of [D, C, B, A]) {
      w.game.addExecution(new AllianceRequestExecution(w.nation(id), AGENT_ID));
    }
    w.h.step();
    expect(w.us.incomingAllianceRequests().length).toBe(4);
    const sent = w.h.step();
    // A (the ally set) first, then the rest by smallID: C; B is food; D
    // would pass A_max = 2.
    expect(sent).toEqual([
      { type: "allianceRequest", recipient: A },
      { type: "allianceRequest", recipient: C },
    ]);
    const allies = () =>
      w.us
        .alliances()
        .map((a) => a.other(w.us).id())
        .sort();
    expect(allies()).toEqual([A, C].sort());
    // B's and D's requests are left to expire (200 ticks), unanswered.
    for (let i = 0; i < 220; i++) w.h.step();
    expect(allies()).toEqual([A, C].sort());
    expect(w.us.incomingAllianceRequests()).toEqual([]);
    expect(w.watch.maxAlliances).toBe(2);
    w.watch.check(w.game, () => 1);
    expect(w.watch.requests.every((r) => r.kind === "counter")).toBe(true);
  });

  test("web requests: from tick 102, the top of the ally set, one slot, never food", () => {
    const w = synth({});
    // No nation AI answers: each request expires (200 ticks) and is
    // retried after the 300-tick cooldown, one pending at a time.
    for (let i = 0; i < 720; i++) w.h.step();
    const reqs = w.watch.requests;
    w.watch.check(w.game, () => 1);
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    expect(reqs.every((r) => r.kind === "web")).toBe(true);
    expect(reqs[0].tick).toBe(102);
    expect(reqs[0].to).toBe(A);
    expect(reqs.some((r) => r.to === B)).toBe(false);
    for (const r of reqs) expect(w.s.web.allySet).toContain(r.to);
    // One slot: each request waits for the previous one to expire.
    for (let i = 1; i < reqs.length; i++) {
      expect(reqs[i].tick - reqs[i - 1].tick).toBeGreaterThan(200);
    }
  });
});
