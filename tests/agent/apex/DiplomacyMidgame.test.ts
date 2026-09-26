/**
 * The web through the midgame (apex o.webMidgame, package B2; spec §5.1
 * item 1, chapter 13 §2.9 and §5.9): the plan's keep set, extensions of
 * kept allies the spec would let lapse, the renew at a lapse, counter-accepts
 * that leave room for the kept nations, the lapse-for-target rule and the
 * boat reach.
 *
 * Why (arena quick@20, apex with webDiag, 32 games): 38 nations attacked
 * apex; 18 were former allies whose alliance had lapsed (125 of 152 lapses
 * were never asked to extend, among them allies whose extension forecast
 * was 1: Hokkaido on Japan, "threat", then eliminated us), and all 20
 * others had been allyable (forecast >= 0.8) before they attacked.
 *
 * Settings: a synthetic 200x100 plains field with four nations and no
 * nation AI (as tests/agent/apex/Diplomacy.test.ts, with other sizes): us
 * (10,000 tiles), A (6,000 tiles, bordering us), B (20 tiles inside our
 * land), C and D (2,000 tiles each, beyond A). With 5 non-bot players
 * A_max = 2 and A_ext = 1. Nation troops are set against our cap (their
 * caps: A 0.98, C and D 0.6, B 0.23 of ours), so a nation's dmid is about
 * its troops over 1.1 x our home. A water field for the boat reach.
 */
import { AgentIntent } from "../../../src/agent/Agent";
import {
  blockNeighbours,
  diplomacyMemory,
  friendPoints,
  goldChunk,
  islandThreat,
  shoreOwners,
} from "../../../src/agent/agents/apex/controllers/DiplomacyController";
import { parseApexOptions } from "../../../src/agent/agents/apex/options";
import { ApexPolicy } from "../../../src/agent/agents/apex/policy";
import { ApexState, createState } from "../../../src/agent/agents/apex/state";
import { AllianceQuery, NationModel } from "../../../src/agent/lib/NationModel";
import {
  allySlots,
  buildRaceGrid,
  ownerGrid,
} from "../../../src/agent/lib/RaceField";
import { Config } from "../../../src/core/configuration/Config";
import { AllianceRequestExecution } from "../../../src/core/execution/alliance/AllianceRequestExecution";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import {
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
import {
  AGENT_CLIENT,
  AGENT_ID,
  Field,
  field,
  GAME_CONFIG,
  GAME_ID,
  Harness,
  own,
  rect,
} from "./Field";

const W = 200;
const H = 100;
const LAND = 0x80 | 5;
const NATIONS = [
  { id: "NATIONAA", rect: [100, 0, 160, H] },
  { id: "NATIONBB", rect: [50, 0, 52, 10] },
  { id: "NATIONCC", rect: [160, 0, 180, H] },
  { id: "NATIONDD", rect: [180, 0, 200, H] },
] as const;
const [A, B, C, D] = NATIONS.map((n) => n.id);

interface Synth {
  game: Game;
  us: Player;
  s: ApexState;
  h: Harness;
  policy: ApexPolicy;
  nation(id: string): Player;
  cap: number;
}

/**
 * The field in stall mode: our home at the cap (the ExpansionController,
 * off here, would have set s.stall.since), nation troops `share` x our cap.
 */
function synth(
  options: Record<string, unknown>,
  share: Record<string, number>,
): Synth {
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
  }
  const cap = game.config().maxTroops(us);
  us.setTroops(cap);
  for (const n of NATIONS) {
    game.player(n.id).setTroops(Math.round((share[n.id] ?? 0.05) * cap));
  }
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
    webFrom: 0,
    ...options,
  });
  const s = createState();
  s.stall.since = -1000;
  const policy = new ApexPolicy(o, s);
  const h = new Harness(f, (ctx) => policy.tick(ctx));
  return { game, us, s, h, policy, nation: (id) => game.player(id), cap };
}

/** Allies us with N the way a counter-accept does (test only). */
function ally(w: Synth, id: string): void {
  w.game.addExecution(new AllianceRequestExecution(w.nation(id), AGENT_ID));
  w.h.step();
  const r = w.us
    .incomingAllianceRequests()
    .find((q) => q.requestor().id() === id);
  r?.accept();
  expect(w.us.isAlliedWith(w.nation(id))).toBe(true);
}

/** The policy's NationModel (test only). */
function nationModel(policy: ApexPolicy): NationModel {
  return (policy as unknown as { rt: { nm: NationModel } }).rt.nm;
}

/** A: similarly strong, not a threat (H < 1.1·T_A); C ranked, D not
 *  (0.5/1.1 < webDangerMin), B tiny. */
const TROOPS = { [A]: 0.95, [B]: 0.05, [C]: 0.58, [D]: 0.5 };

describe("the midgame plan", () => {
  test("keeps the most dangerous reachable nations (dmid), up to A_ext; the tiny one is not ranked", () => {
    const w = synth({ webMidgame: true }, TROOPS);
    w.h.step();
    w.h.step();
    const mid = diplomacyMemory(w.s).mid!;
    expect(mid).toBeDefined();
    expect(allySlots(w.game, w.us, 0)).toEqual({
      max: 2,
      ext: 1,
      webTarget: 1,
    });
    // H_ref is our home at the cap: dmid = max(T + out, trigger·M+) /
    // (1.1 · cap), at least T/(1.1·cap).
    for (const [id, share] of Object.entries(TROOPS)) {
      expect(mid.dmid[id]).toBeGreaterThanOrEqual(share / 1.1 - 0.001);
    }
    expect(mid.rank).toEqual([A, C]);
    expect(mid.rank).not.toContain(B);
    expect(mid.slots).toBe(1);
    expect(mid.keep).toEqual([A]);
    // Kept nations join the web (strikes skip it) and leave the food list.
    expect(w.s.web.allySet).toContain(A);
    expect(w.s.web.food).not.toContain(A);
    expect(w.s.web.food).toContain(B);
  });

  test("the spec web alone, in stall mode, has no one to keep: A reads as food (stallDangerHome) though it holds 0.95x our home", () => {
    const w = synth({ webMidgame: false }, TROOPS);
    w.h.step();
    w.h.step();
    expect(diplomacyMemory(w.s).mid).toBeUndefined();
    expect(w.s.web.allySet).toEqual([]);
    expect(w.s.web.food).toContain(A);
  });

  test("webSlotsMax keeps A_max; webFrom holds the midgame web back", () => {
    const w = synth({ webMidgame: true, webSlotsMax: true }, TROOPS);
    w.h.step();
    expect(diplomacyMemory(w.s).mid!.keep).toEqual([A, C]);
    const late = synth({ webMidgame: true, webFrom: 10_000 }, TROOPS);
    late.h.step();
    late.h.step();
    expect(diplomacyMemory(late.s).mid).toBeUndefined();
  });

  test("requests go to kept nations only, within the midgame slots: A first, C only while A cannot be asked (its request cooldown)", () => {
    const w = synth({ webMidgame: true }, TROOPS);
    const sent: { tick: number; to: string; mid: string[]; canA: boolean }[] =
      [];
    // No nation AI: requests expire unanswered (200 ticks), then the
    // 300-tick cooldown from their creation runs.
    for (let i = 0; i < 700; i++) {
      const tick = w.game.ticks();
      const canA = w.us.canSendAllianceRequest(w.nation(A));
      const keep = [...(diplomacyMemory(w.s).mid?.keep ?? [])];
      for (const x of w.h.step()) {
        if (x.type === "allianceRequest") {
          sent.push({ tick, to: x.recipient, mid: keep, canA });
        }
      }
    }
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0].to).toBe(A);
    for (const r of sent) {
      expect([A, C]).toContain(r.to);
      if (r.to === C) expect(r.canA).toBe(false);
    }
    // One at a time: A_ext = 1.
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i].tick - sent[i - 1].tick).toBeGreaterThanOrEqual(200);
    }
  });
});

describe("extensions of kept allies", () => {
  for (const on of [true, false]) {
    test(`an ally the spec lets lapse in stall mode is ${on ? "" : "not "}asked to extend (webMidgame ${on})`, () => {
      // extendLead 2999: the spec's window opens at once.
      const w = synth({ webMidgame: on, extendLead: 2999 }, TROOPS);
      w.h.step();
      ally(w, A);
      const sent: AgentIntent[] = [];
      for (let i = 0; i < 6; i++) sent.push(...w.h.step());
      const ext = sent.filter((i) => i.type === "allianceExtension");
      if (on) {
        // webExtendLead (600) left: not yet.
        expect(ext).toEqual([]);
        expireAt(w, A, w.game.ticks() + 500);
        const later: { tick: number; i: AgentIntent }[] = [];
        while (w.game.ticks() < 400) {
          const tick = w.game.ticks();
          for (const x of w.h.step()) later.push({ tick, i: x });
        }
        const asks = later.filter((x) => x.i.type === "allianceExtension");
        // Once per term, and only once A has been kept (from the first
        // plan, tick 0) for webExtendStable (150) ticks.
        expect(asks.map((x) => x.i)).toEqual([
          { type: "allianceExtension", recipient: A },
        ]);
        expect(asks[0].tick).toBeGreaterThanOrEqual(150);
        expect(asks[0].tick).toBeLessThanOrEqual(160);
      } else {
        expect(ext).toEqual([]);
      }
    });
  }

  for (const stable of [0, 150, 300]) {
    test(`webExtendStable ${stable}: the ask waits until the ally has been kept that long`, () => {
      const w = synth({ webMidgame: true, webExtendStable: stable }, TROOPS);
      w.h.step();
      ally(w, A);
      expireAt(w, A, w.game.ticks() + 500);
      const kept = diplomacyMemory(w.s).keptSince![A];
      expect(kept).toBe(0);
      let asked = -1;
      while (asked < 0 && w.game.ticks() < 480) {
        const tick = w.game.ticks();
        for (const x of w.h.step()) {
          if (x.type === "allianceExtension") asked = tick;
        }
      }
      expect(asked).toBeGreaterThanOrEqual(kept + stable);
      expect(asked).toBeLessThanOrEqual(kept + stable + 10);
    });
  }

  test("an ally that leaves the keep set is forgotten there: kept again, it waits webExtendStable afresh", () => {
    const w = synth({ webMidgame: true }, TROOPS);
    const o = (w.policy as unknown as { o: { webDangerMin: number } }).o;
    w.h.step();
    ally(w, A);
    for (let i = 0; i < 5; i++) w.h.step();
    expect(diplomacyMemory(w.s).keptSince![A]).toBe(0);
    // No nation is dangerous enough for one plan: A leaves the keep set.
    o.webDangerMin = 5;
    while (diplomacyMemory(w.s).mid!.keep.includes(A)) w.h.step();
    expect(diplomacyMemory(w.s).keptSince![A]).toBeUndefined();
    o.webDangerMin = 0.5;
    while (!diplomacyMemory(w.s).mid!.keep.includes(A)) w.h.step();
    const back = diplomacyMemory(w.s).mid!.at;
    expect(back).toBeGreaterThan(0);
    expect(diplomacyMemory(w.s).keptSince![A]).toBe(back);
    expireAt(w, A, w.game.ticks() + 500);
    let asked = -1;
    while (asked < 0 && w.game.ticks() < back + 400) {
      const tick = w.game.ticks();
      for (const x of w.h.step()) {
        if (x.type === "allianceExtension") asked = tick;
      }
    }
    expect(asked).toBeGreaterThanOrEqual(back + 150);
  });
});

describe("the renew at a lapse", () => {
  test("a kept ally whose extension the trap refuses gets a fresh request the tick its alliance lapses, and that request's forecast passes", () => {
    // Web requests off: the renew is then the only request (a web request
    // of ours would also start the 300-tick cooldown).
    const w = synth({ webMidgame: true, web: false }, TROOPS);
    w.game.addExecution(new PlayerExecution(w.us));
    // Past the spawn-phase guard (requests created at tick <= 101 are
    // refused).
    while (w.game.ticks() < 110) w.h.step();
    ally(w, A);
    const nm = nationModel(w.policy);
    const t = w.game.ticks();
    const q = (kind: AllianceQuery["kind"]): AllianceQuery => ({
      kind,
      createdAt: t,
      atTick: t + 5,
      embargoStoppedBy: null,
    });
    // A's non-bot neighbours are [us, C], C unallied: the extension counts
    // us as its friend (2 <= 1 + 1, refused), a fresh request does not
    // (2 <= 0 + 1 is false) and passes on tiles (similar strength)
    // [PIN NationAlliance "the extension counts us as its bordering
    // friend"].
    expect(nm.acceptsAlliance(A, q("extension"))).toMatchObject({
      p: 0,
      branch: "enough",
    });
    const a = w.us.allianceWith(w.nation(A))!;
    const expiry = w.game.ticks() + 20;
    (a as unknown as { expiresAt_: number }).expiresAt_ = expiry;
    const sent: { tick: number; i: AgentIntent }[] = [];
    let lapsedAt = -1;
    for (let i = 0; i < 40; i++) {
      const tick = w.game.ticks();
      if (lapsedAt < 0 && !w.us.isAlliedWith(w.nation(A))) lapsedAt = tick;
      for (const x of w.h.step()) sent.push({ tick, i: x });
    }
    expect(lapsedAt).toBeGreaterThan(0);
    const renew = sent.filter(
      (x) => x.i.type === "allianceRequest" && x.i.recipient === A,
    );
    expect(renew).toHaveLength(1);
    // The first tick we see it gone.
    expect(renew[0].tick).toBe(lapsedAt);
    const f = nm.acceptsAlliance(A, {
      ...q("request"),
      createdAt: renew[0].tick,
      atTick: renew[0].tick + 5,
    });
    expect(f.p).toBeGreaterThanOrEqual(0.25);
    expect(diplomacyMemory(w.s).stats.renews).toBe(1);
  });

  test("no renew for an ally outside the keep set, nor with webRenew off", () => {
    for (const [opts, id] of [
      [{ webMidgame: true, web: false }, C],
      [{ webMidgame: true, web: false, webRenew: false }, A],
    ] as const) {
      const w = synth(opts, TROOPS);
      w.game.addExecution(new PlayerExecution(w.us));
      while (w.game.ticks() < 110) w.h.step();
      ally(w, id);
      const a = w.us.allianceWith(w.nation(id))!;
      (a as unknown as { expiresAt_: number }).expiresAt_ = w.game.ticks() + 20;
      const sent: AgentIntent[] = [];
      for (let i = 0; i < 40; i++) sent.push(...w.h.step());
      expect(w.us.isAlliedWith(w.nation(id))).toBe(false);
      expect(
        sent.filter((i) => i.type === "allianceRequest" && i.recipient === id),
      ).toEqual([]);
    }
  });
});

describe("counter-accepts with the midgame web", () => {
  test("a nation outside the keep set is not accepted while the kept nation still needs the slot; the kept one is", () => {
    const w = synth({ webMidgame: true, web: false }, TROOPS);
    for (let i = 0; i < 5; i++) w.h.step();
    for (const id of [D, C]) {
      w.game.addExecution(new AllianceRequestExecution(w.nation(id), AGENT_ID));
    }
    w.h.step();
    expect(w.us.incomingAllianceRequests()).toHaveLength(2);
    const first: AgentIntent[] = [];
    for (let i = 0; i < 5; i++) first.push(...w.h.step());
    expect(first.filter((i) => i.type === "allianceRequest")).toEqual([]);
    w.game.addExecution(new AllianceRequestExecution(w.nation(A), AGENT_ID));
    w.h.step();
    const second = w.h.step();
    expect(second).toContainEqual({ type: "allianceRequest", recipient: A });
    expect(second.filter((i) => i.type === "allianceRequest")).toHaveLength(1);
  });
});

describe("lapse for a target (webLapseTarget)", () => {
  test("boxed in (every bordering nation kept) with a strike feature on: the weakest bordering one leaves the keep set; inert without strikes", () => {
    const share = { [A]: 0.95, [B]: 0.8, [C]: 0.58, [D]: 0.5 };
    const on = synth(
      { webMidgame: true, webSlotsMax: true, stallStrike: true },
      share,
    );
    on.h.step();
    on.h.step();
    const mid = diplomacyMemory(on.s).mid!;
    expect(mid.rank).toEqual([A, B, C]);
    expect(mid.keep).toEqual([A]);
    const off = synth({ webMidgame: true, webSlotsMax: true }, share);
    off.h.step();
    off.h.step();
    expect(diplomacyMemory(off.s).mid!.keep).toEqual([A, B]);
  });

  test("while the weakest bordering ally's extension is asked it is not dropped (it would extend anyway), nor is a stronger ally in its place", () => {
    const share = { [A]: 0.95, [B]: 0.8, [C]: 0.58, [D]: 0.5 };
    const w = synth(
      { webMidgame: true, webSlotsMax: true, stallStrike: true, web: false },
      share,
    );
    while (w.game.ticks() < 110) w.h.step();
    ally(w, B);
    const nextPlan = () => {
      const at = diplomacyMemory(w.s).mid!.at;
      while (diplomacyMemory(w.s).mid!.at === at) w.h.step();
      return diplomacyMemory(w.s).mid!;
    };
    w.s.web.extensionAsked[B] = w.us.allianceWith(w.nation(B))!.expiresAt();
    expect(nextPlan().keep).toEqual([B, A]);
    delete w.s.web.extensionAsked[B];
    expect(nextPlan().keep).toEqual([A]);
  });
});

describe("boat reach (webBoatReach)", () => {
  /**
   * Land x < 60 (us) and x >= 140 (N, 60 wide), ocean between: 80 tiles
   * apart, out of the land reach (allyReachCells 1). `others` are more
   * players on N's shore strip or on islands in the ocean.
   */
  async function across(
    others: (game: Game, N: Player) => void = () => {},
    islands: [number, number, number, number][] = [],
  ) {
    const f = await field({
      width: 200,
      height: 100,
      terrain: (x, y) =>
        x < 60 ||
        x >= 140 ||
        islands.some(
          ([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1,
        )
          ? "plains"
          : "water",
    });
    const { game, me } = f;
    own(me, rect(game, 0, 0, 60, 100));
    const N = game.addPlayer(
      new PlayerInfo("nn", PlayerType.Nation, null, "NATIONNN"),
    );
    own(N, rect(game, 140, 0, 200, 100));
    const cap = game.config().maxTroops(me);
    me.setTroops(cap);
    N.setTroops(cap);
    others(game, N);
    // PlayerExecution measures the clusters every so often (not run here).
    for (const p of game.players()) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -1;
      let y1 = -1;
      for (const t of p.tiles()) {
        x0 = Math.min(x0, game.x(t));
        y0 = Math.min(y0, game.y(t));
        x1 = Math.max(x1, game.x(t));
        y1 = Math.max(y1, game.y(t));
      }
      p.largestClusterBoundingBox = {
        min: new Cell(x0, y0),
        max: new Cell(x1, y1),
      };
    }
    const o = parseApexOptions({
      expansion: false,
      boats: false,
      economy: false,
      strike: false,
      endgame: false,
      spawnMode: "plan",
      webFrom: 0,
      webMidgame: true,
      allyReachCells: 1,
    });
    const run = (opts: Record<string, unknown> = {}) => {
      const s = createState();
      s.stall.since = -1000;
      const policy = new ApexPolicy({ ...o, ...opts }, s);
      const h = new Harness(f, (ctx) => policy.tick(ctx));
      h.step();
      h.step();
      return diplomacyMemory(s).mid!;
    };
    return { f, game, me, N, cap, o, run };
  }

  test("an islander across open water, out of land reach, is ranked by boat at webBoatDiscount of its dmid", async () => {
    const { game, me, N, cap, o, run } = await across();
    const race = buildRaceGrid(game, o);
    const owners = ownerGrid(game, race, 2);
    const shore = shoreOwners(owners, race, game);
    expect(shore.has(me.smallID())).toBe(true);
    expect(shore.has(N.smallID())).toBe(true);
    // N's blocks touch only its own and water.
    expect(blockNeighbours(owners).get(N.smallID())).toEqual([]);
    expect(islandThreat(game, me, N, [], shore)).toBe(true);
    const mid = run();
    // T/(1.1·cap) = 0.91, discounted: 0.68 (webBoatDiscount 0.75).
    expect(mid.dmid[N.id()]).toBeCloseTo((0.75 * N.troops()) / (1.1 * cap), 2);
    expect(mid.keep).toEqual([N.id()]);
    expect(run({ webBoatReach: false }).dmid[N.id()]).toBeUndefined();
    // With a discount of 0.5 it falls below webDangerMin.
    expect(run({ webBoatDiscount: 0.5 }).rank).toEqual([]);
  });

  test("a nation with a bordering enemy (here a tribe inland) attacks what it borders: no boat reach", async () => {
    const { game, N, run } = await across((g) => {
      const tribe = g.addPlayer(
        new PlayerInfo("tribe", PlayerType.Bot, null, "BOTTRIBE"),
      );
      own(tribe, rect(g, 190, 0, 200, 100));
    });
    const tribe = game.player("BOTTRIBE");
    expect(tribe.isAlive()).toBe(true);
    // N keeps its coast (x 140): a shore owner, but not an islander.
    const next = blockNeighbours(
      ownerGrid(game, buildRaceGrid(game, parseApexOptions({})), 2),
    );
    expect(next.get(N.smallID())).toContain(tribe.smallID());
    const mid = run();
    expect(mid.dmid[N.id()]).toBeUndefined();
    expect(mid.rank).toEqual([]);
  });

  test("an islander with two weaker players nearer than us boats at them: no boat reach; one nearer is not enough", async () => {
    for (const [count, reached] of [
      [2, false],
      [1, true],
    ] as const) {
      // Islands at x 100-110, 50 tiles from N's centre (170): nearer than
      // our centre (29, 141 away). Each owner holds 0.5 of N's troops.
      const isles: [number, number, number, number][] = [
        [100, 10, 110, 30],
        [100, 70, 110, 90],
      ].slice(0, count) as [number, number, number, number][];
      const { N, run } = await across((g, n) => {
        isles.forEach(([x0, y0, x1, y1], i) => {
          const p = g.addPlayer(
            new PlayerInfo(`isle${i}`, PlayerType.Nation, null, `NATIONI${i}`),
          );
          own(p, rect(g, x0, y0, x1, y1));
          p.setTroops(Math.round(n.troops() / 2));
        });
      }, isles);
      const mid = run();
      expect(mid.dmid[N.id()] !== undefined).toBe(reached);
    }
  });
});

/** Sets an alliance's expiry (test only). */
function expireAt(w: Synth, id: string, tick: number): void {
  const a = w.us.allianceWith(w.nation(id))!;
  (a as unknown as { expiresAt_: number }).expiresAt_ = tick;
}

describe("keep-set stability and feasibility (v2)", () => {
  test("an ally keeps its slot against an unallied nation less than webKeepBonus times more dangerous; without the bonus it lapses", () => {
    // dmid A 0.73 (unallied), C 0.56 (allied: 0.73 with the bonus).
    const share = { [A]: 0.8, [B]: 0.05, [C]: 0.62, [D]: 0.3 };
    for (const bonus of [1.3, 1]) {
      // o.web on: the reach beyond bordering nations needs the OwnerGrid
      // (policy.refreshGrids builds it for the web or boats). No request
      // passes allyMinP 2, so A is never asked (and never "held"); the
      // feasibility test is off for the same reason.
      const w = synth(
        {
          webMidgame: true,
          webKeepBonus: bonus,
          allyMinP: 2,
          webKeepFeasible: false,
        },
        share,
      );
      while (w.game.ticks() < 110) w.h.step();
      ally(w, C);
      for (let i = 0; i < 60; i++) w.h.step();
      const mid = diplomacyMemory(w.s).mid!;
      expect(mid.slots).toBe(1);
      expect(mid.keep).toEqual(bonus > 1 ? [C] : [A]);
    }
  });

  test("an unallied nation that would refuse a request leaves its keep slot to the next one (webKeepFeasible)", () => {
    const w = synth({ webMidgame: true }, TROOPS);
    // A's relation to us Distrustful: every request is refused (past the
    // spawn guard, which alone would still count as feasible).
    w.nation(A).updateRelation(w.us, -40);
    expect(w.nation(A).relation(w.us)).toBe(Relation.Distrustful);
    while (w.game.ticks() < 160) w.h.step();
    const mid = diplomacyMemory(w.s).mid!;
    expect(mid.rank).toEqual([A, C]);
    expect(mid.infeasible).toEqual([A]);
    expect(mid.keep).toEqual([C]);
    const off = synth({ webMidgame: true, webKeepFeasible: false }, TROOPS);
    off.nation(A).updateRelation(off.us, -40);
    while (off.game.ticks() < 160) off.h.step();
    expect(diplomacyMemory(off.s).mid!.keep).toEqual([A]);
  });
});

describe("peak dmid (webPeakKeep)", () => {
  test("a nation whose stack drops stays ranked at 0.9 of its peak per plan, then leaves; without the memory it leaves at once", () => {
    for (const keepShare of [0.9, 0]) {
      // C: dmid 0.62/1.1 = 0.56, then 0.3/1.1 = 0.27 (its trigger stack on
      // its 2,000 tiles is lower still).
      const share = { [A]: 0.3, [B]: 0.05, [C]: 0.62, [D]: 0.3 };
      const w = synth(
        { webMidgame: true, webPeakKeep: keepShare, allyMinP: 2 },
        share,
      );
      w.h.step();
      w.h.step();
      expect(diplomacyMemory(w.s).mid!.rank).toContain(C);
      w.nation(C).setTroops(Math.round(0.3 * w.cap));
      const ranked: boolean[] = [];
      for (let plan = 0; plan < 3; plan++) {
        const at = diplomacyMemory(w.s).mid!.at;
        while (diplomacyMemory(w.s).mid!.at === at) w.h.step();
        ranked.push(diplomacyMemory(w.s).mid!.rank.includes(C));
      }
      // 0.56 -> 0.51 -> 0.46: one more plan ranked, then out.
      expect(ranked).toEqual(
        keepShare > 0 ? [true, false, false] : [false, false, false],
      );
    }
  });
});

describe("slots and leads (v3)", () => {
  test("the keep set leaves floor(webSlotSpare * A_max) of A_ext free for nations dying (13 non-bot players: A_max 4, A_ext 3, kept 2)", () => {
    const w = synth(
      { webMidgame: true, allyMinP: 2, webSlotSpare: 0.25 },
      TROOPS,
    );
    // Eight inert one-tile nations far from everyone: 13 non-bot players.
    for (let i = 0; i < 8; i++) {
      const p = w.game.addPlayer(
        new PlayerInfo(`x${i}`, PlayerType.Nation, null, `NATIONX${i}`),
      );
      p.conquer(w.game.ref(199, 90 + i));
    }
    expect(allySlots(w.game, w.us, 0)).toEqual({
      max: 4,
      ext: 3,
      webTarget: 3,
    });
    w.h.step();
    w.h.step();
    expect(diplomacyMemory(w.s).mid!.slots).toBe(2);
    // The default (0): all of A_ext; with 5 players A_ext = 1 either way.
    const none = synth({ webMidgame: true }, TROOPS);
    none.h.step();
    expect(diplomacyMemory(none.s).mid!.slots).toBe(1);
  });

  for (const stable of [0, 150]) {
    test(`the midgame web plans at its first decision from webFrom, so the spec path never asks with the midgame's lead (webExtendStable ${stable})`, () => {
      // Not in stall mode's danger home: A is in the spec's allySet.
      const w = synth(
        {
          webMidgame: true,
          webFrom: 60,
          stallDangerHome: false,
          webExtendStable: stable,
        },
        TROOPS,
      );
      w.s.stall.since = null;
      w.h.step();
      ally(w, A);
      // 400 ticks left at webFrom: past the spec's extendLead (300), inside
      // webExtendLead (600).
      expireAt(w, A, 460);
      const sent: { tick: number; i: AgentIntent }[] = [];
      while (w.game.ticks() < 300) {
        const tick = w.game.ticks();
        for (const x of w.h.step()) sent.push({ tick, i: x });
      }
      expect(w.s.web.allySet).toContain(A);
      const mem = diplomacyMemory(w.s);
      // Plans at 0 and 50 (spec), the midgame's first at 60.
      expect(mem.keptSince![A]).toBe(60);
      const asks = sent.filter((x) => x.i.type === "allianceExtension");
      expect(asks.map((x) => x.i)).toEqual([
        { type: "allianceExtension", recipient: A },
      ]);
      expect(asks[0].tick).toBeGreaterThanOrEqual(60 + stable);
      expect(asks[0].tick).toBeLessThanOrEqual(60 + stable + 10);
    });
  }
});

describe("the ceiling: the web adds no alliance past A_ext (midCeiling)", () => {
  // A_ext = 1, A_max = 2: D (dmid 0.27, outside the keep set) holds the
  // A_ext slot; A is kept and unallied. Our PlayerExecution expires
  // alliances.
  const share = { [A]: 0.95, [B]: 0.05, [C]: 0.2, [D]: 0.3 };

  function heldByD(opts: Record<string, unknown>, lapse: number) {
    const w = synth({ webMidgame: true, web: false, ...opts }, share);
    w.game.addExecution(new PlayerExecution(w.us));
    while (w.game.ticks() < 110) w.h.step();
    ally(w, D);
    const lapseAt = w.game.ticks() + lapse;
    expireAt(w, D, lapseAt);
    // The web's requests from here on.
    (w.policy as unknown as { o: { web: boolean } }).o.web = true;
    return { w, lapseAt };
  }

  test("a kept nation is not requested while a weak ally holds the A_ext slot, and is the tick after it lapses", () => {
    const { w, lapseAt } = heldByD({}, 300);
    const sent: { tick: number; i: AgentIntent }[] = [];
    while (w.game.ticks() < lapseAt + 20) {
      const tick = w.game.ticks();
      for (const x of w.h.step()) sent.push({ tick, i: x });
    }
    expect(diplomacyMemory(w.s).mid!.keep).toEqual([A]);
    const req = sent.filter((x) => x.i.type === "allianceRequest");
    expect(req.map((x) => x.i)).toEqual([
      { type: "allianceRequest", recipient: A },
    ]);
    // Expired by our PlayerExecution at lapseAt, seen at the next decision.
    expect(req[0].tick).toBeGreaterThanOrEqual(lapseAt);
    expect(req[0].tick).toBeLessThanOrEqual(lapseAt + 5);
  });

  for (const slotsMax of [false, true]) {
    test(`a kept nation's own request is ${slotsMax ? "accepted at once with webSlotsMax (ceiling A_max)" : "accepted only once the weak ally has lapsed"}`, () => {
      const { w, lapseAt } = heldByD(
        { webSlotsMax: slotsMax, allyMinP: 2 },
        150,
      );
      w.game.addExecution(new AllianceRequestExecution(w.nation(A), AGENT_ID));
      const sent: { tick: number; i: AgentIntent }[] = [];
      while (w.game.ticks() < lapseAt + 20) {
        const tick = w.game.ticks();
        for (const x of w.h.step()) sent.push({ tick, i: x });
      }
      const toA = sent.filter(
        (x) => x.i.type === "allianceRequest" && x.i.recipient === A,
      );
      expect(toA).toHaveLength(1);
      if (slotsMax) expect(toA[0].tick).toBeLessThan(lapseAt - 100);
      else expect(toA[0].tick).toBeGreaterThanOrEqual(lapseAt);
      expect(w.us.isAlliedWith(w.nation(A))).toBe(true);
    });
  }

  test("at A_ext a kept nation's request waits; a nation dying mid-term takes A_max below our alliances, and a kept ally's renew restores the count only with webRenewOver", () => {
    // A kept and allied, C kept and unallied (dmid 0.64), D (0.27) and X1
    // allied outside the keep set.
    const share = { [A]: 0.95, [B]: 0.05, [C]: 0.7, [D]: 0.3 };
    for (const over of [true, false]) {
      const w = synth(
        { webMidgame: true, web: false, webRenewOver: over },
        share,
      );
      // Eight one-tile nations far from everyone: 13 non-bot players,
      // A_max 4, A_ext 3.
      const extra: Player[] = [];
      for (let i = 0; i < 8; i++) {
        const p = w.game.addPlayer(
          new PlayerInfo(`x${i}`, PlayerType.Nation, null, `NATIONX${i}`),
        );
        p.conquer(w.game.ref(199, 90 + i));
        extra.push(p);
      }
      w.game.addExecution(new PlayerExecution(w.us));
      while (w.game.ticks() < 110) w.h.step();
      for (const id of [A, D, extra[1].id()]) ally(w, id);
      (w.policy as unknown as { o: { web: boolean } }).o.web = true;
      expect(allySlots(w.game, w.us, 0)).toMatchObject({ max: 4, ext: 3 });
      // C asks us: accepting would take us to A_max (v2 did, kept nations
      // up to A_max).
      w.game.addExecution(new AllianceRequestExecution(w.nation(C), AGENT_ID));
      const sent: { tick: number; i: AgentIntent }[] = [];
      // To a plan with the OwnerGrid (built for the web) that reaches C.
      while (diplomacyMemory(w.s).mid!.at < 150) {
        const tick = w.game.ticks();
        for (const x of w.h.step()) sent.push({ tick, i: x });
      }
      expect(diplomacyMemory(w.s).mid!.keep).toEqual([A, C]);
      expect(w.us.incomingAllianceRequests()).toHaveLength(1);
      // X0 dies: 12 players, A_max 3, A_ext 2, three alliances.
      w.nation(D).conquer(w.game.ref(199, 90));
      expect(extra[0].isAlive()).toBe(false);
      expect(allySlots(w.game, w.us, 0)).toMatchObject({ max: 3, ext: 2 });
      const e = w.game.ticks() + 60;
      expireAt(w, A, e);
      while (w.game.ticks() < e + 20) {
        const tick = w.game.ticks();
        for (const x of w.h.step()) sent.push({ tick, i: x });
      }
      expect(diplomacyMemory(w.s).mid!.keep).toContain(A);
      const req = sent.filter((x) => x.i.type === "allianceRequest");
      // Neither C's counter-accept nor a request to it; then the renew of
      // A, back to A_max, only with webRenewOver.
      for (const r of req) expect(r.tick).toBeGreaterThanOrEqual(e);
      expect(req.map((x) => x.i)).toEqual(
        over ? [{ type: "allianceRequest", recipient: A }] : [],
      );
      if (!over) {
        expect(
          w.h.logs.some((l) => l.includes("dip renew nationaa: no room")),
        ).toBe(true);
      }
    }
  });
});

describe("gold for friendship (webFriendGold)", () => {
  // A (dmid 1.09, bordering us and C, C unallied: the extension trap).
  const share = { [A]: 1.2, [B]: 0.05, [C]: 0.58, [D]: 0.3 };

  function trappedAlly(opts: Record<string, unknown>, gold: bigint) {
    // webExtendStable 0: the ask goes as soon as the lead allows.
    const w = synth(
      { webMidgame: true, web: false, webExtendStable: 0, ...opts },
      share,
    );
    w.game.addExecution(new PlayerExecution(w.us));
    while (w.game.ticks() < 110) w.h.step();
    ally(w, A);
    w.us.addGold(gold);
    return w;
  }

  test("a trapped dangerous ally near its expiry gets gold worth Friendly past the expiry, once, and is Friendly when the forecast reads it", () => {
    const w = trappedAlly({}, 5_000_000n);
    const e = w.game.ticks() + 100;
    expireAt(w, A, e);
    const sent: { tick: number; i: AgentIntent }[] = [];
    for (let i = 0; i < 30; i++) {
      const tick = w.game.ticks();
      for (const x of w.h.step()) sent.push({ tick, i: x });
    }
    expect(sent.map((x) => x.i)).toContainEqual({
      type: "allianceExtension",
      recipient: A,
    });
    const gifts = sent.filter((x) => x.i.type === "donate_gold");
    expect(gifts).toHaveLength(1);
    const g = gifts[0];
    const points = friendPoints(0, g.tick + 1, e + 60)!;
    // 50 + 0.05 * (e + 60 - (t + 1)): about +58.
    expect(points).toBeGreaterThanOrEqual(55);
    expect(points).toBeLessThanOrEqual(60);
    // Priced for a payment up to 20 ticks late (the browser's latency):
    // the gold buys points / 5 chunks when it pays by g.tick + 20, one
    // fewer after.
    const gold = BigInt(points / 5) * goldChunk(w.game, g.tick + 20);
    expect(g.i).toEqual({
      type: "donate_gold",
      recipient: A,
      gold: Number(gold),
    });
    for (const paid of [g.tick + 1, g.tick + 3, g.tick + 20]) {
      expect(gold / goldChunk(w.game, paid)).toBe(BigInt(points / 5));
    }
    expect(gold / goldChunk(w.game, g.tick + 21)).toBe(BigInt(points / 5 - 1));
    expect(w.nation(A).relation(w.us)).toBe(Relation.Friendly);
    const nm = nationModel(w.policy);
    expect(nm.relations.band(A, w.game.ticks())).toBe(Relation.Friendly);
    // The extension's forecast now counts the Friendly branch.
    const f = nm.acceptsAlliance(A, {
      kind: "extension",
      createdAt: w.game.ticks(),
      atTick: w.game.ticks() + 5,
      embargoStoppedBy: null,
    });
    expect(f.p).toBeGreaterThanOrEqual(0.66);
    expect(f.branch).toBe("friendly");
    expect(diplomacyMemory(w.s).stats.goldGifts).toBe(1);
  });

  test("no gift without the gold, far from the expiry, for a weaker ally, or with webFriendGold off", () => {
    for (const [opts, gold, lead] of [
      [{}, 0n, 100],
      [{}, 5_000_000n, 1000],
      [{ webFriendMinDanger: 2 }, 5_000_000n, 100],
      [{ webFriendGold: false }, 5_000_000n, 100],
    ] as const) {
      const w = trappedAlly(opts, gold);
      expireAt(w, A, w.game.ticks() + lead);
      const sent: AgentIntent[] = [];
      for (let i = 0; i < 30; i++) sent.push(...w.h.step());
      expect(sent.filter((i) => i.type === "donate_gold")).toEqual([]);
      if (gold === 0n) {
        expect(
          w.h.logs.some((l) => l.includes("dip gift nationaa unaffordable")),
        ).toBe(true);
      }
    }
  });
});
