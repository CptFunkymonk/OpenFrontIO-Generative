/**
 * Package WP7a, the web keep (apex o.webKeepStrong; docs/14-m4-plan.md §2.7
 * item 7a): every strong bordering ally is asked to extend at the lead, the
 * earlier of two strong expiries less than webKeepGap apart is asked sooner,
 * and a strong ally whose alliance lapsed gets a fresh request (webKeepRenew).
 *
 * Why (arena quick@20, UE's 32 games): former allies sent 214M of the 435M
 * nation troops sent at apex, 51M of them after an alliance that lapsed
 * unasked (11 strong allies lapsed so and then attacked), 162M after a
 * refused extension.
 *
 * Mechanics [PIN NationAlliance "allianceExtension works any time", "a
 * refused extension stays asked", "the extension counts us as its bordering
 * friend"]: an extension can be asked any time in the term, the nation
 * agrees at a decision where it would accept us now, and the term restarts
 * from that decision, so asks `gap` apart end the next terms `gap` apart.
 *
 * Settings: a synthetic 200x100 plains field without nation AI (as
 * DiplomacyMidgame.test.ts): A on x < usX0 (bordering us), us on
 * [usX0, 120), B on [120, 160) (bordering us), C on [160, 200) (bordering B
 * only), and 8 one-tile nations inside C, so 12 non-bot players (A_max 3,
 * A_ext 2). Our home is at the cap in stall mode, so every nation's §3.4.2
 * danger is below allyDangerMin: the spec web keeps none of them (allySet
 * empty) and would let every alliance lapse unasked.
 */
import { AgentIntent } from "../../../src/agent/Agent";
import {
  diplomacyMemory,
  keepAskTicks,
  StrongAlly,
} from "../../../src/agent/agents/apex/controllers/DiplomacyController";
import { parseApexOptions } from "../../../src/agent/agents/apex/options";
import { ApexPolicy } from "../../../src/agent/agents/apex/policy";
import { ApexState, createState } from "../../../src/agent/agents/apex/state";
import { NationModel } from "../../../src/agent/lib/NationModel";
import { Config } from "../../../src/core/configuration/Config";
import { AllianceExtensionExecution } from "../../../src/core/execution/alliance/AllianceExtensionExecution";
import { AllianceRequestExecution } from "../../../src/core/execution/alliance/AllianceRequestExecution";
import { BreakAllianceExecution } from "../../../src/core/execution/alliance/BreakAllianceExecution";
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
  GAME_CONFIG,
  GAME_ID,
  Harness,
} from "./Field";

const W = 200;
const H = 100;
const LAND = 0x80 | 5;
const A = "NATIONAA";
const B = "NATIONBB";
const C = "NATIONCC";
/** With `enclave`: 20 tiles inside our land, bordering only us. */
const E = "NATIONEE";
const TINY = Array.from({ length: 8 }, (_, i) => `NATIONT${i}`);
/** extendLead's default: the spec web's extension lead. */
const LEAD = 300;

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
 * The field in stall mode, our home at the cap; nation troops `share` x
 * our cap (default 0.05); A on [0, usX0). With `enclave`, E (20 tiles at
 * x 60-61, y 0-9, inside our land) replaces the last tiny nation, so the
 * slots stay A_max 3, A_ext 2.
 */
function synth(
  options: Record<string, unknown>,
  share: Record<string, number>,
  usX0 = 40,
  enclave = false,
): Synth {
  const t = new Uint8Array(W * H).fill(LAND);
  const m = new Uint8Array((W / 2) * (H / 2)).fill(LAND);
  const map = new GameMapImpl(W, H, t, W * H);
  const mini = new GameMapImpl(W / 2, H / 2, m, (W * H) / 4);
  const config = new Config(GAME_CONFIG, null, false);
  const rects: Record<string, [number, number, number, number]> = {
    [A]: [0, 0, usX0, H],
    [B]: [120, 0, 160, H],
    [C]: [160, 0, 200, H],
  };
  const tiny = enclave ? TINY.slice(0, -1) : TINY;
  tiny.forEach((id, i) => {
    rects[id] = [170 + 3 * i, 50, 171 + 3 * i, 51];
  });
  if (enclave) rects[E] = [60, 0, 62, 10];
  const ids = [A, B, C, ...(enclave ? [E] : []), ...tiny];
  const nations = ids.map(
    (id, i) =>
      new Nation(
        new Cell(rects[id][0], i),
        new PlayerInfo(id.toLowerCase(), PlayerType.Nation, null, id),
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
    for (let x = usX0; x < 120; x++) us.conquer(game.ref(x, y));
  }
  // C first: the tiny nations take their tiles from it (E from us).
  for (const id of ids) {
    const p = game.player(id);
    const [x0, y0, x1, y1] = rects[id];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) p.conquer(game.ref(x, y));
    }
  }
  const cap = game.config().maxTroops(us);
  us.setTroops(cap);
  for (const id of ids) {
    game.player(id).setTroops(Math.round((share[id] ?? 0.05) * cap));
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

/** Sets the expiry of our alliance with `id` (test only). */
function expireAt(w: Synth, id: string, tick: number): void {
  const a = w.us.allianceWith(w.nation(id))!;
  (a as unknown as { expiresAt_: number }).expiresAt_ = tick;
}

/** Steps until `until`, returning each tick's sends; `each` runs after the
 *  step with that tick's intents. */
function run(
  w: Synth,
  until: number,
  each?: (tick: number, sent: AgentIntent[]) => void,
): { tick: number; i: AgentIntent }[] {
  const out: { tick: number; i: AgentIntent }[] = [];
  while (w.game.ticks() < until) {
    const tick = w.game.ticks();
    const sent = w.h.step();
    for (const i of sent) out.push({ tick, i });
    each?.(tick, sent);
  }
  return out;
}

function extensionsTo(
  sent: { tick: number; i: AgentIntent }[],
  id: string,
): number[] {
  return sent
    .filter((x) => x.i.type === "allianceExtension" && x.i.recipient === id)
    .map((x) => x.tick);
}

/** The policy's NationModel (test only). */
function nationModel(policy: ApexPolicy): NationModel {
  return (policy as unknown as { rt: { nm: NationModel } }).rt.nm;
}

/** The policy's thinkEvery (decisions every this many ticks). */
function thinkEvery(w: Synth): number {
  return (w.policy as unknown as { o: { thinkEvery: number } }).o.thinkEvery;
}

describe("keepAskTicks", () => {
  const row = (id: string, e: number): StrongAlly => ({
    id,
    e,
    askAt: 0,
    before: null,
    cap: 1,
    home: 1,
  });

  test("asks at e − lead, and the earlier of two expiries less than gap apart gap before the later one's ask", () => {
    const rows = [row("a", 5000), row("b", 5100), row("c", 7000)];
    keepAskTicks(rows, LEAD, 600, 3000);
    expect(rows.map((r) => r.askAt)).toEqual([5100 - LEAD - 600, 4800, 6700]);
    expect(rows.map((r) => r.before)).toEqual(["b", null, null]);
  });

  test("a chain moves each earlier one again, never more than duration − gap before its expiry", () => {
    const rows = [row("a", 5000), row("b", 5050), row("c", 5100)];
    keepAskTicks(rows, LEAD, 600, 3000);
    // c 4800, b 4200, a 3600 (its floor, 5000 − 2400, is lower).
    expect(rows.map((r) => r.askAt)).toEqual([3600, 4200, 4800]);
    const tight = [row("a", 5000), row("b", 5010), row("c", 5020)];
    keepAskTicks(tight, LEAD, 1200, 3000);
    // c 4720, b 3520 (floor 5010 − 1800 = 3210), a max(2320, 3200) = 3200.
    expect(tight.map((r) => r.askAt)).toEqual([3200, 3520, 4720]);
  });

  test("the spacing is between the asks: a later ask that moved moves an earlier one whose expiry is gap or more away", () => {
    // b and c expire 50 apart, so b's ask moves to 850, 150 after a's
    // natural ask (700) though a expires 700 before b.
    const rows = [row("a", 1000), row("b", 1700), row("c", 1750)];
    keepAskTicks(rows, LEAD, 600, 3000);
    expect(rows.map((r) => r.askAt)).toEqual([250, 850, 1450]);
    expect(rows.map((r) => r.before)).toEqual(["b", "c", null]);
  });

  test("expiries gap or more apart, or gap 0, ask at the lead", () => {
    const apart = [row("a", 5000), row("b", 5600)];
    keepAskTicks(apart, LEAD, 600, 3000);
    expect(apart.map((r) => r.askAt)).toEqual([4700, 5300]);
    const off = [row("a", 5000), row("b", 5001)];
    keepAskTicks(off, LEAD, 0, 3000);
    expect(off.map((r) => [r.askAt, r.before])).toEqual([
      [4700, null],
      [4701, null],
    ]);
  });
});

describe("the strong rule's extensions", () => {
  for (const on of [true, false]) {
    test(`a strong bordering ally the web lets lapse is ${on ? "" : "not "}asked at the lead (webKeepStrong ${on})`, () => {
      // A holds 1.05x our home: strong by troops, not by cap (0.90x).
      const w = synth({ webKeepStrong: on }, { [A]: 1.05, [B]: 0.3 });
      while (w.game.ticks() < 110) w.h.step();
      ally(w, A);
      const e = w.game.ticks() + 500;
      expireAt(w, A, e);
      const sent = run(w, e - 1);
      // The spec web does not keep A (its danger is below allyDangerMin).
      expect(w.s.web.allySet).not.toContain(A);
      const asks = extensionsTo(sent, A);
      if (!on) {
        expect(asks).toEqual([]);
        expect(diplomacyMemory(w.s).strong).toBeUndefined();
        return;
      }
      expect(asks).toHaveLength(1);
      expect(asks[0]).toBeGreaterThanOrEqual(e - LEAD);
      expect(asks[0]).toBeLessThan(e - LEAD + thinkEvery(w));
      const st = diplomacyMemory(w.s).strong!.find((r) => r.id === A)!;
      expect(st.home).toBeGreaterThanOrEqual(1);
      expect(st.cap).toBeLessThan(1.1);
      expect(diplomacyMemory(w.s).stats.keepAsks).toBe(1);
      expect(
        w.h.logs.some(
          (l) =>
            l.includes(`dip extend nationaa expires=${e}`) &&
            l.includes("(outside the web)"),
        ),
      ).toBe(true);
    });
  }

  test("strong by cap alone (maxTroops 1.25x ours, troops 0.3x our home) is asked too", () => {
    // A 6,000 tiles against our 6,000: the nation cap is x1.25.
    const w = synth({ webKeepStrong: true }, { [A]: 0.3, [B]: 0.3 }, 60);
    while (w.game.ticks() < 110) w.h.step();
    ally(w, A);
    const e = w.game.ticks() + 500;
    expireAt(w, A, e);
    const asks = extensionsTo(run(w, e - 1), A);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toBeGreaterThanOrEqual(e - LEAD);
    const st = diplomacyMemory(w.s).strong!.find((r) => r.id === A)!;
    expect(st.cap).toBeGreaterThanOrEqual(1.1);
    expect(st.home).toBeLessThan(1);
  });

  test("a weak ally, and a strong one that does not border us, are not asked by this rule", () => {
    // B: 0.5x our home and 0.90x our cap; C: 1.2x our home, beyond B.
    const w = synth({ webKeepStrong: true }, { [B]: 0.5, [C]: 1.2 });
    while (w.game.ticks() < 110) w.h.step();
    ally(w, B);
    ally(w, C);
    const e = w.game.ticks() + 500;
    expireAt(w, B, e);
    expireAt(w, C, e + 10);
    const sent = run(w, e - 1);
    expect(extensionsTo(sent, B)).toEqual([]);
    expect(extensionsTo(sent, C)).toEqual([]);
    expect(diplomacyMemory(w.s).strong).toEqual([]);
    // The same C bordering us (A's place) is asked.
    const w2 = synth({ webKeepStrong: true }, { [A]: 1.2 });
    while (w2.game.ticks() < 110) w2.h.step();
    ally(w2, A);
    const e2 = w2.game.ticks() + 500;
    expireAt(w2, A, e2);
    expect(extensionsTo(run(w2, e2 - 1), A)).toHaveLength(1);
  });

  test("two strong expiries 100 ticks apart: the earlier is asked 600 before the later one's ask, and once both agree their terms end at least 600 apart", () => {
    const w = synth({ webKeepStrong: true }, { [A]: 1.05, [B]: 1.05 });
    while (w.game.ticks() < 110) w.h.step();
    ally(w, A);
    ally(w, B);
    const t0 = w.game.ticks();
    expireAt(w, A, t0 + 1000);
    expireAt(w, B, t0 + 1100);
    // Each nation agrees the tick after our ask is seen (its decision).
    const agree = (id: string) => {
      const a = w.us.allianceWith(w.nation(id));
      if (
        a !== null &&
        a.agreedToExtend(w.us) &&
        !a.agreedToExtend(w.nation(id))
      ) {
        w.game.addExecution(
          new AllianceExtensionExecution(w.nation(id), AGENT_ID),
        );
      }
    };
    const sent = run(w, t0 + 1000, () => {
      agree(A);
      agree(B);
    });
    const askA = extensionsTo(sent, A);
    const askB = extensionsTo(sent, B);
    expect(askA).toHaveLength(1);
    expect(askB).toHaveLength(1);
    const every = thinkEvery(w);
    // B at its lead, A 600 before B's ask (800 before its own expiry).
    expect(askB[0]).toBeGreaterThanOrEqual(t0 + 1100 - LEAD);
    expect(askB[0]).toBeLessThan(t0 + 1100 - LEAD + every);
    expect(askA[0]).toBeGreaterThanOrEqual(t0 + 1100 - LEAD - 600);
    expect(askA[0]).toBeLessThan(t0 + 1100 - LEAD - 600 + every);
    const eA = w.us.allianceWith(w.nation(A))!.expiresAt();
    const eB = w.us.allianceWith(w.nation(B))!.expiresAt();
    expect(eB - eA).toBeGreaterThanOrEqual(600 - every);
    expect(diplomacyMemory(w.s).stats.keepEarly).toBe(1);
    expect(
      w.h.logs.some(
        (l) =>
          l.includes("dip extend nationaa") &&
          l.includes("early 500 for nationbb"),
      ),
    ).toBe(true);
    // The new terms are 600 apart: nobody is asked again early.
    const later = run(w, eA - LEAD - 10);
    expect(extensionsTo(later, A)).toEqual([]);
    expect(extensionsTo(later, B)).toEqual([]);
  });

  test("webKeepGap 0: both are asked at the lead", () => {
    const w = synth(
      { webKeepStrong: true, webKeepGap: 0 },
      { [A]: 1.05, [B]: 1.05 },
    );
    while (w.game.ticks() < 110) w.h.step();
    ally(w, A);
    ally(w, B);
    const t0 = w.game.ticks();
    expireAt(w, A, t0 + 1000);
    expireAt(w, B, t0 + 1100);
    const sent = run(w, t0 + 1000);
    expect(extensionsTo(sent, A)[0]).toBeGreaterThanOrEqual(t0 + 1000 - LEAD);
    expect(extensionsTo(sent, B)[0]).toBeGreaterThanOrEqual(t0 + 1100 - LEAD);
  });
});

describe("with the midgame web (webMidgame)", () => {
  test("a strong bordering ally outside the midgame keep set is asked at webExtendLead; without webKeepStrong it lapses unasked", () => {
    // A_ext 2: the midgame web keeps A and B (the highest dmid); E, strong
    // too, is left out.
    const share = { [A]: 1.2, [B]: 1.15, [E]: 1.05 };
    for (const on of [true, false]) {
      const w = synth(
        { webMidgame: true, webFrom: 0, web: false, webKeepStrong: on },
        share,
        40,
        true,
      );
      while (w.game.ticks() < 110) w.h.step();
      ally(w, A);
      ally(w, B);
      ally(w, E);
      const at = diplomacyMemory(w.s).mid!.at;
      while (diplomacyMemory(w.s).mid!.at === at) w.h.step();
      const mid = diplomacyMemory(w.s).mid!;
      expect(mid.slots).toBe(2);
      expect(mid.keep).toEqual([A, B]);
      const e = w.game.ticks() + 700;
      expireAt(w, E, e);
      const asks = extensionsTo(run(w, e - 1), E);
      if (!on) {
        expect(asks).toEqual([]);
        continue;
      }
      const lead = (w.policy as unknown as { o: { webExtendLead: number } }).o
        .webExtendLead;
      expect(asks).toHaveLength(1);
      expect(asks[0]).toBeGreaterThanOrEqual(e - lead);
      expect(asks[0]).toBeLessThan(e - lead + thinkEvery(w));
    }
  });
});

describe("the renew of a strong ally (webKeepRenew)", () => {
  function lapse(
    options: Record<string, unknown>,
    share: Record<string, number>,
    id: string,
  ) {
    const w = synth({ webKeepStrong: true, web: false, ...options }, share);
    w.game.addExecution(new PlayerExecution(w.us));
    while (w.game.ticks() < 110) w.h.step();
    ally(w, id);
    expireAt(w, id, w.game.ticks() + 20);
    const sent: { tick: number; i: AgentIntent }[] = [];
    let lapsedAt = -1;
    for (let i = 0; i < 40; i++) {
      const tick = w.game.ticks();
      if (lapsedAt < 0 && !w.us.isAlliedWith(w.nation(id))) lapsedAt = tick;
      for (const x of w.h.step()) sent.push({ tick, i: x });
    }
    expect(lapsedAt).toBeGreaterThan(0);
    const requests = sent.filter(
      (x) => x.i.type === "allianceRequest" && x.i.recipient === id,
    );
    return { w, lapsedAt, requests };
  }

  test("a strong bordering ally whose alliance lapsed gets a fresh request the first tick we see it gone, with a passing forecast", () => {
    const { w, lapsedAt, requests } = lapse({}, { [A]: 1.05 }, A);
    expect(requests.map((x) => x.tick)).toEqual([lapsedAt]);
    const f = nationModel(w.policy).acceptsAlliance(A, {
      kind: "request",
      createdAt: lapsedAt,
      atTick: lapsedAt + 5,
      embargoStoppedBy: null,
    });
    expect(f.p).toBeGreaterThanOrEqual(0.25);
    expect(diplomacyMemory(w.s).stats.keepRenews).toBe(1);
    expect(w.h.logs.some((l) => l.includes("dip keep-renew nationaa p="))).toBe(
      true,
    );
  });

  test("no renew for a weak ally, nor with webKeepRenew off, nor below webKeepRenewMinP", () => {
    expect(lapse({}, { [B]: 0.3 }, B).requests).toEqual([]);
    expect(lapse({ webKeepRenew: false }, { [A]: 1.05 }, A).requests).toEqual(
      [],
    );
    const high = lapse({ webKeepRenewMinP: 1.01 }, { [A]: 1.05 }, A);
    expect(high.requests).toEqual([]);
    expect(high.w.h.logs.some((l) => l.includes("(not sent)"))).toBe(true);
  });

  test("an alliance the ally breaks before its expiry is not renewed at that expiry", () => {
    const w = synth({ webKeepStrong: true, web: false }, { [A]: 1.05 });
    w.game.addExecution(new PlayerExecution(w.us));
    while (w.game.ticks() < 110) w.h.step();
    ally(w, A);
    const e = w.game.ticks() + 60;
    expireAt(w, A, e);
    for (let i = 0; i < 6; i++) w.h.step();
    expect(diplomacyMemory(w.s).strongRenew![A]).toBe(e);
    w.game.addExecution(new BreakAllianceExecution(w.nation(A), AGENT_ID));
    const sent = run(w, e + 40);
    expect(w.us.isAlliedWith(w.nation(A))).toBe(false);
    expect(
      sent.filter((x) => x.i.type === "allianceRequest" && x.i.recipient === A),
    ).toEqual([]);
    expect(diplomacyMemory(w.s).strongRenew![A]).toBeUndefined();
  });
});
