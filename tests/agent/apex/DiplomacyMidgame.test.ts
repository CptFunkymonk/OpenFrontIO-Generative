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
  diplomacyMemory,
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

  test("requests go to the kept nation only, within the midgame slots", () => {
    const w = synth({ webMidgame: true }, TROOPS);
    const sent: AgentIntent[] = [];
    // No nation AI: requests expire unanswered (200 ticks).
    for (let i = 0; i < 400; i++) sent.push(...w.h.step());
    const reqs = sent.filter((i) => i.type === "allianceRequest");
    expect(reqs.length).toBeGreaterThan(0);
    for (const r of reqs) {
      expect(r.type === "allianceRequest" && r.recipient).toBe(A);
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
        // webExtendLead (1800) left: not yet.
        expect(ext).toEqual([]);
        const a = w.us.allianceWith(w.nation(A))!;
        (a as unknown as { expiresAt_: number }).expiresAt_ =
          w.game.ticks() + 1500;
        const later: AgentIntent[] = [];
        for (let i = 0; i < 6; i++) later.push(...w.h.step());
        expect(later).toContainEqual({
          type: "allianceExtension",
          recipient: A,
        });
        // Once per term.
        const again: AgentIntent[] = [];
        for (let i = 0; i < 30; i++) again.push(...w.h.step());
        expect(again.filter((i) => i.type === "allianceExtension")).toEqual([]);
      } else {
        expect(ext).toEqual([]);
      }
    });
  }
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
});

describe("boat reach (webBoatReach)", () => {
  test("a nation across open water, out of land reach, is ranked by boat at webBoatDiscount of its dmid", async () => {
    // Land x < 60 (us) and x >= 140 (N); ocean between: 80 tiles apart.
    const f = await field({
      width: 200,
      height: 100,
      terrain: (x) => (x < 60 || x >= 140 ? "plains" : "water"),
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
    const race = buildRaceGrid(game, o);
    const owners = ownerGrid(game, race, 2);
    const shore = shoreOwners(owners, race, game);
    expect(shore.has(me.smallID())).toBe(true);
    expect(shore.has(N.smallID())).toBe(true);
    for (const boat of [true, false]) {
      const s = createState();
      s.stall.since = -1000;
      const policy = new ApexPolicy({ ...o, webBoatReach: boat }, s);
      const h = new Harness(f, (ctx) => policy.tick(ctx));
      h.step();
      h.step();
      const mid = diplomacyMemory(s).mid!;
      if (boat) {
        // T/(1.1·cap) = 0.91, discounted: 0.68 (webBoatDiscount 0.75).
        expect(mid.dmid[N.id()]).toBeCloseTo(
          (0.75 * N.troops()) / (1.1 * cap),
          2,
        );
        expect(mid.keep).toEqual([N.id()]);
      } else {
        expect(mid.dmid[N.id()]).toBeUndefined();
      }
    }
    // With a discount of 0.5 it falls below webDangerMin.
    const s = createState();
    s.stall.since = -1000;
    const policy = new ApexPolicy({ ...o, webBoatDiscount: 0.5 }, s);
    const h = new Harness(f, (ctx) => policy.tick(ctx));
    h.step();
    expect(diplomacyMemory(s).mid!.rank).toEqual([]);
  });
});
