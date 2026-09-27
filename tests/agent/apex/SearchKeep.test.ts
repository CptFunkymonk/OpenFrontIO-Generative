/**
 * Package WP3 (docs/14-m4-plan.md §2.4, §3 WP3): keep:Z and keep:Z+gift
 * (lib/search/cands/keep.ts).
 *
 * Claims:
 * - Generation (a stand-in view of the game, as SearchCandidates.test.ts
 *   builds it): keep:Z for each bordering ally expiring within
 *   searchLapseLead that is strong (troops ≥ searchKeepMinShare of our
 *   home, or a cap ≥ 1.1 × ours) and outside the web's keep list;
 *   keep:Z+gift for a strong expiring ally, kept or not, whose extension
 *   forecast is below searchKeepGiftP (not "traitor"), Neutral, not
 *   embargoed, the gold at most searchKeepGiftShare of ours; a foe mark on
 *   Z ended first; nothing with searchKeep off (the core alone).
 * - The gift is B2's pricing: friendPoints of the relation at its payment
 *   to FRIENDLY_PAST past the expiry, in goldChunk's chunks priced
 *   GIFT_PAY_WITHIN ticks late (FriendDonation.test.ts pins both).
 * - Played live (the directive test world with PlayerExecutions, one-minute
 *   alliances, a nation with no AI that never answers): keep:A sends A's
 *   extension at the expiry − extendLead and, the alliance lapsed, the
 *   renewal at the expiry + 1; an extension agreed in time skips the
 *   renewal; the gift pays the tick after it is sent and holds A Friendly
 *   through FRIENDLY_PAST ticks past the expiry.
 */
import {
  friendPoints,
  goldChunk,
} from "../../../src/agent/agents/apex/controllers/DiplomacyController";
import {
  APEX_DEFAULTS,
  ApexOptions,
} from "../../../src/agent/agents/apex/options";
import {
  FRIENDLY_PAST,
  GIFT_LEAD,
  GIFT_PAY_WITHIN,
  giftStep,
  KEEP,
  keepCandidates,
  keepGift,
  RENEW_DELAY,
} from "../../../src/agent/lib/search/cands/keep";
import type { SearchView } from "../../../src/agent/lib/search/Registry";
import type { NeighborInfo } from "../../../src/agent/lib/WorldModel";
import { Config } from "../../../src/core/configuration/Config";
import { AllianceExtensionExecution } from "../../../src/core/execution/alliance/AllianceExtensionExecution";
import { AllianceRequestExecution } from "../../../src/core/execution/alliance/AllianceRequestExecution";
import { PlayerType, Relation } from "../../../src/core/game/Game";
import { AGENT_ID, GAME_CONFIG } from "./Field";
import { liveView, NATIONS, NO_BASE, world } from "./SearchWorld";

const T = 5000;
const CONFIG = new Config(GAME_CONFIG, null, false);

interface Nat {
  id: string;
  smallID: number;
  contact: number;
  troops: number;
  /** Its cap (default 3M). */
  M?: number;
  expiresAt?: number;
  relation?: Relation;
  embargo?: boolean;
}

interface Env {
  o?: Partial<ApexOptions>;
  allySet?: string[];
  foes?: Record<string, number>;
  /** The extension forecast (NationModel.acceptsAlliance). */
  forecast?: { p: number; branch: string };
  /** The relation estimate (RelationTracker.value). */
  relation?: number;
  gold?: bigint;
  home?: number;
  ourCap?: number;
}

/** A stand-in SearchView at tick T (the generator only reads the game). */
function view(nats: Nat[], env: Env = {}): SearchView {
  const byId = new Map(nats.map((n) => [n.id, n]));
  const home = env.home ?? 1_000_000;
  const ourCap = env.ourCap ?? 3_000_000;
  const players = new Map<string, object>();
  const player = (n: Nat) => {
    let p = players.get(n.id);
    if (p === undefined) {
      p = {
        id: () => n.id,
        isAlive: () => true,
        troops: () => n.troops,
        type: () => PlayerType.Nation,
        relation: () => n.relation ?? Relation.Neutral,
        __M: n.M ?? 3_000_000,
      };
      players.set(n.id, p);
    }
    return p;
  };
  const me = {
    troops: () => home,
    gold: () => env.gold ?? 10_000_000n,
    __M: ourCap,
    allianceWith: (p: { id(): string }) => {
      const n = byId.get(p.id())!;
      return n.expiresAt === undefined
        ? null
        : { expiresAt: () => n.expiresAt! };
    },
    isAlliedWith: (p: { id(): string }) =>
      byId.get(p.id())?.expiresAt !== undefined,
    hasEmbargoAgainst: (p: { id(): string }) =>
      byId.get(p.id())?.embargo === true,
    canDonateGold: () => true,
  };
  const game = {
    hasPlayer: (id: string) => byId.has(id),
    player: (id: string) => player(byId.get(id)!),
    config: () => ({
      maxTroops: (p: { __M: number }) => p.__M,
      gameConfig: () => CONFIG.gameConfig(),
      numSpawnPhaseTurns: () => CONFIG.numSpawnPhaseTurns(),
    }),
  };
  const nm = {
    acceptsAlliance: () => ({
      p: env.forecast?.p ?? 1,
      branch: env.forecast?.branch ?? "similar",
      deterministic: false,
    }),
    nextDecision: (_id: string, from: number) => from,
    relations: { value: () => env.relation ?? 0 },
  };
  const opts = {
    ...APEX_DEFAULTS,
    searchKeep: true,
    ...env.o,
  } as ApexOptions;
  return {
    o: opts,
    t: T,
    game,
    me,
    wm: {
      nations: [...nats]
        .sort((a, b) => a.smallID - b.smallID)
        .map(
          (n) =>
            ({
              id: n.id,
              smallID: n.smallID,
              type: PlayerType.Nation,
              contact: n.contact,
              attackable: true,
            }) as unknown as NeighborInfo,
        ),
    },
    host: {
      state: {
        web: { allySet: env.allySet ?? [] },
        search: { foes: env.foes ?? {} },
      },
      nationModel: () => nm,
      available: () => 1_000_000,
    },
    kinds: new Set(opts.searchKinds.split(",")),
  } as unknown as SearchView;
}

/** The expected gift for relation r, sent at `at`, held to `until`. */
function price(r: number, at: number, until: number): bigint {
  const points = friendPoints(r, at + 1, until)!;
  return BigInt(points / 5) * goldChunk(CONFIG as never, at + GIFT_PAY_WITHIN);
}

describe("keep candidates", () => {
  test("keep:Z for a strong expiring ally outside the keep list, with its steps", () => {
    const e = T + 400;
    const cands = KEEP.generate(
      view([
        // Strong by troops (≥ 0.9 of our 1M home), expiring in 400.
        { id: "Z", smallID: 1, contact: 50, troops: 950_000, expiresAt: e },
        // Weak: troops 0.5 of home, cap 1.0 × ours.
        { id: "Y", smallID: 2, contact: 60, troops: 500_000, expiresAt: e },
        // Strong by cap (1.2 × ours), expiring later than the lead.
        {
          id: "X",
          smallID: 3,
          contact: 70,
          troops: 10,
          M: 3_600_000,
          expiresAt: T + 600,
        },
        // Strong by cap, expiring within the lead: kept.
        {
          id: "V",
          smallID: 4,
          contact: 40,
          troops: 10,
          M: 3_300_000,
          expiresAt: T + 350,
        },
        // Unallied, and thinly bordering allies: nothing.
        { id: "U", smallID: 5, contact: 80, troops: 2_000_000 },
        { id: "S", smallID: 6, contact: 5, troops: 2_000_000, expiresAt: e },
      ]),
      NO_BASE,
    );
    // By contact: Z (50) before V (40).
    expect(cands.map((c) => c.name)).toEqual(["keep:Z", "keep:V"]);
    const z = cands[0];
    expect(z).toMatchObject({
      kind: "keep",
      target: "Z",
      lastSend: e + RENEW_DELAY - T,
      isBreak: false,
      strongCheck: false,
      defensive: true,
    });
    expect(z.frac).toBeUndefined();
    expect(
      z.steps.map((s) => [s.at, s.p?.intent.type, s.p?.key, s.when]),
    ).toEqual([
      [e - 300, "allianceExtension", "ext:Z", { allied: "Z" }],
      [e + 1, "allianceRequest", "ally:Z", { unallied: "Z" }],
    ]);
  });

  test("off, in the keep list, or past the lead: no keep:Z; a foe mark is ended first", () => {
    const Z: Nat = {
      id: "Z",
      smallID: 1,
      contact: 50,
      troops: 950_000,
      expiresAt: T + 400,
    };
    expect(KEEP.generate(view([Z], { o: { searchKeep: false } }), NO_BASE)).toEqual(
      [],
    );
    expect(KEEP.generate(view([Z], { allySet: ["Z"] }), NO_BASE)).toEqual([]);
    expect(
      KEEP.generate(view([{ ...Z, expiresAt: T + 501 }]), NO_BASE),
    ).toEqual([]);
    // searchKeepMinShare 0: every expiring bordering ally.
    expect(
      KEEP.generate(
        view([{ ...Z, troops: 1 }], { o: { searchKeepMinShare: 0 } }),
        NO_BASE,
      ).map((c) => c.name),
    ).toEqual(["keep:Z"]);
    // A lapse of ours marked Z a foe: the plan ends the mark first (a foe
    // step with until before its tick), then asks.
    const [c] = KEEP.generate(view([Z], { foes: { Z: T + 1300 } }), NO_BASE);
    expect(c.steps[0]).toEqual({
      at: T,
      label: "unfoe Z",
      foe: { id: "Z", until: T - 1 },
    });
    expect(c.steps.slice(1).map((s) => s.p?.intent.type)).toEqual([
      "allianceExtension",
      "allianceRequest",
    ]);
    // A mark that has run out is left alone.
    expect(
      KEEP.generate(view([Z], { foes: { Z: T - 1 } }), NO_BASE)[0].steps,
    ).toHaveLength(2);
  });

  test("keep:Z+gift when the extension forecast is low, kept by the web or not, priced as B2's gifts", () => {
    const e = T + 400;
    const Z: Nat = { id: "Z", smallID: 1, contact: 50, troops: 950_000, expiresAt: e };
    const low = { forecast: { p: 0.2, branch: "enough" }, relation: 12.5 };
    const cands = KEEP.generate(view([Z], low), NO_BASE);
    expect(cands.map((c) => c.name)).toEqual(["keep:Z", "keep:Z+gift"]);
    const gift = cands[1];
    const askAt = e - 300;
    const giftAt = askAt - GIFT_LEAD;
    const gold = price(12.5, giftAt, e + FRIENDLY_PAST);
    expect(gift.steps.map((s) => [s.at, s.p?.intent])).toEqual([
      [giftAt, { type: "donate_gold", recipient: "Z", gold: Number(gold) }],
      [askAt, { type: "allianceExtension", recipient: "Z" }],
      [e + 1, { type: "allianceRequest", recipient: "Z" }],
    ]);
    expect(gift.lastSend).toBe(cands[0].lastSend);
    // Kept by the web: the web asks the extension itself, so only the
    // gift plan (with its renewal) differs from the base.
    expect(
      KEEP.generate(view([Z], { ...low, allySet: ["Z"] }), NO_BASE).map(
        (c) => c.name,
      ),
    ).toEqual(["keep:Z+gift"]);
    // A refusal for too many alliances still gets it (the renewal is
    // decided with one fewer); our treachery does not; nor a high forecast.
    const names = (env: object) =>
      KEEP.generate(view([Z], { ...low, ...env }), NO_BASE).map((c) => c.name);
    expect(names({ forecast: { p: 0, branch: "tooMany" } })).toEqual([
      "keep:Z",
      "keep:Z+gift",
    ]);
    expect(names({ forecast: { p: 0.1, branch: "traitor" } })).toEqual([
      "keep:Z",
    ]);
    expect(names({ forecast: { p: 0.5, branch: "similar" } })).toEqual([
      "keep:Z",
    ]);
    // Not Neutral, embargoed, too dear, or off: no gift.
    expect(
      KEEP.generate(
        view([{ ...Z, relation: Relation.Friendly }], low),
        NO_BASE,
      ).map((c) => c.name),
    ).toEqual(["keep:Z"]);
    expect(
      KEEP.generate(view([{ ...Z, embargo: true }], low), NO_BASE).map(
        (c) => c.name,
      ),
    ).toEqual(["keep:Z"]);
    expect(
      KEEP.generate(view([Z], { ...low, gold: gold }), NO_BASE).map(
        (c) => c.name,
      ),
    ).toEqual(["keep:Z"]);
    expect(
      KEEP.generate(view([Z], { ...low, o: { searchKeepGift: false } }), NO_BASE)
        .map((c) => c.name),
    ).toEqual(["keep:Z"]);
  });

  test("the gift's price: friendPoints to FRIENDLY_PAST past the expiry, in chunks priced GIFT_PAY_WITHIN late", () => {
    const sv = view([]);
    const N = {
      id: () => "Z",
      relation: () => Relation.Neutral,
    } as never;
    // Relation 0 at its payment (tick 4,999), Friendly through 5,460: 50 +
    // 0.05 × 461 = 73.05, in fives 75: 15 chunks.
    const g = keepGift(sv, N, 4998, 5460, 0)!;
    expect(g.points).toBe(75);
    expect(g.points).toBe(friendPoints(0, 4999, 5460));
    // goldChunk at 5,018: 25,000 + 25,000 × 5,018 / (3,000 + spawn turns).
    const chunk = BigInt(
      Math.round(
        25_000 + (25_000 * 5018) / (3000 + CONFIG.numSpawnPhaseTurns()),
      ),
    );
    expect(g.gold).toBe(15n * chunk);
    // The estimate is clamped into Neutral (below 0: 0; Friendly: 49).
    expect(keepGift(sv, N, 4998, 5460, -30)).toEqual(g);
    expect(keepGift(sv, N, 4998, 5460, 80)!.points).toBe(
      friendPoints(49, 4999, 5460),
    );
    // More than +100 is not for sale.
    expect(keepGift(sv, N, 3000, 5460, 0)).toBeNull();
  });
});

describe("keep:A played live", () => {
  const A = NATIONS[0].id;

  /** Allied with A (its request, our counter-accept) on one-minute
   *  alliances; returns the world and the expiry. */
  function allied() {
    const w = world({}, { allianceMinutes: 1 });
    for (let i = 0; i < 10; i++) w.h.step();
    w.game.addExecution(new AllianceRequestExecution(w.nation(A), AGENT_ID));
    for (let i = 0; i < 5; i++) w.h.step();
    const al = w.us.allianceWith(w.nation(A));
    expect(al).not.toBeNull();
    return { w, e: al!.expiresAt() };
  }

  /** At live tick `at`, adopts keep:A (searchKeepMinShare 0: A is weak). */
  function adoptKeep(
    w: ReturnType<typeof allied>["w"],
    at: number,
    o: Partial<ApexOptions> = {},
  ): void {
    w.probe.onTick = (ctx, host) => {
      if (ctx.tick !== at) return;
      const sv = liveView(w, { searchKeep: true, searchKeepMinShare: 0, ...o });
      const [c] = KEEP.generate(sv, NO_BASE);
      expect(c.name).toBe(`keep:${A}`);
      host.adopt({ steps: c.steps, replace: true });
    };
  }

  const toA = (w: ReturnType<typeof allied>["w"], type: string) =>
    w
      .sent()
      .filter(
        (x) =>
          x.intent.type === type &&
          (x.intent as { recipient?: string }).recipient === A,
      )
      .map((x) => x.tick);

  test("the extension at the expiry − extendLead, the renewal at the expiry + 1", () => {
    const { w, e } = allied();
    const at = e - 400;
    adoptKeep(w, at);
    while (w.game.ticks() < e + 10) w.h.step();
    expect(toA(w, "allianceExtension")).toEqual([e - APEX_DEFAULTS.extendLead]);
    // A (no AI) never agreed: the alliance ended in game tick e, and the
    // first run past it (live tick e + 1) asks again.
    expect(toA(w, "allianceRequest")).toEqual([e + RENEW_DELAY]);
    expect(w.s.search.stats).toEqual({ offered: 2, refused: 0, skipped: 0 });

    // Without the plan the web (off) asks neither.
    const plain = allied();
    while (plain.w.game.ticks() < plain.e + 10) plain.w.h.step();
    expect(toA(plain.w, "allianceExtension")).toEqual([]);
    expect(toA(plain.w, "allianceRequest")).toEqual([]);
    expect(plain.w.us.isAlliedWith(plain.w.nation(A))).toBe(false);
  });

  test("an extension agreed in time skips the renewal", () => {
    const { w, e } = allied();
    adoptKeep(w, e - 400);
    while (w.game.ticks() < e - 250) w.h.step();
    // A agrees 50 ticks after our ask: both agreed, extended from now.
    w.game.addExecution(new AllianceExtensionExecution(w.nation(A), AGENT_ID));
    while (w.game.ticks() < e + 10) w.h.step();
    const al = w.us.allianceWith(w.nation(A));
    expect(al).not.toBeNull();
    expect(al!.expiresAt()).toBeGreaterThan(e);
    expect(toA(w, "allianceRequest")).toEqual([]);
    expect(
      w.h.logs.some((l) =>
        l.includes(`directive renew ${A} skipped (allied with ${A})`),
      ),
    ).toBe(true);
  });

  test("the gift pays the tick after it is sent and holds A Friendly past the expiry", () => {
    const { w, e } = allied();
    w.us.addGold(20_000_000n);
    const at = e - 302;
    let gold = 0n;
    w.probe.onTick = (ctx, host) => {
      if (ctx.tick !== at) return;
      const sv = liveView(w);
      const g = keepGift(
        sv,
        w.nation(A),
        at,
        e + FRIENDLY_PAST,
        // The tracker's estimate: no event yet, so 0 (decay toward 0).
        0,
      )!;
      gold = g.gold;
      host.adopt({ steps: [giftStep(A, at, g.gold)], replace: true });
    };
    const N = w.nation(A);
    const friendly: number[] = [];
    while (w.game.ticks() < e + FRIENDLY_PAST + 1) {
      w.h.step();
      if (N.relation(w.us) === Relation.Friendly) friendly.push(w.game.ticks());
    }
    expect(toA(w, "donate_gold")).toEqual([at]);
    expect(gold).toBeGreaterThan(0n);
    // Friendly from the payment on, without a gap, through e + 60.
    expect(friendly[0]).toBe(at + 2);
    expect(friendly[friendly.length - 1]).toBe(e + FRIENDLY_PAST + 1);
    expect(friendly).toHaveLength(e + FRIENDLY_PAST + 1 - (at + 2) + 1);
  });

  test("keepCandidates is empty once the alliance is gone", () => {
    const { w, e } = allied();
    while (w.game.ticks() < e + 2) w.h.step();
    const sv = liveView(w, { searchKeep: true, searchKeepMinShare: 0 });
    expect(keepCandidates(sv, { N: w.nation(A), e }, true)).toEqual([]);
  });
});
