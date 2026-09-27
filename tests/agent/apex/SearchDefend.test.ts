/**
 * Package WP3 (docs/14-m4-plan.md §2.4, §2.5 round 2b, §3 WP3): the
 * defensive plans of round 2b (lib/search/cands/defend.ts).
 *
 * Claims (a stand-in view of the game, as SearchKeep.test.ts builds it):
 * - Off: nothing. On: for each nation the base rollout shows attacking us,
 *   largest first attack first (ties: the earlier, then the id):
 *   - unallied: ally:N, one alliance request now, when nothing else is
 *     needed; ally:N:stop when its foe mark is ended first or our embargo
 *     on it stopped (embargoStop), the request one tick later when the
 *     nation's next decision would come before the stop is seen;
 *   - allied at the search: keep:N (and keep:N+gift under the gift's
 *     conditions), in the web's keep list or not, unless its attack comes
 *     before its expiry (a betrayal);
 *   - none when the request cannot be sent (canSendAllianceRequest), when
 *     the private NationModel's forecast is a deterministic 0, for a human
 *     or a dead nation, or when the kind (ally, keep) is degraded away.
 */
import {
  APEX_DEFAULTS,
  ApexOptions,
} from "../../../src/agent/agents/apex/options";
import {
  allyCandidate,
  DEFEND,
  requestStep,
  stopStep,
} from "../../../src/agent/lib/search/cands/defend";
import type {
  BaseView,
  SearchView,
} from "../../../src/agent/lib/search/Registry";
import type { AttackSeen } from "../../../src/agent/lib/search/Runner";
import { Config } from "../../../src/core/configuration/Config";
import { PlayerType, Relation } from "../../../src/core/game/Game";
import { GAME_CONFIG } from "./Field";

const T = 6000;
const CONFIG = new Config(GAME_CONFIG, null, false);

interface Nat {
  id: string;
  troops: number;
  expiresAt?: number;
  type?: PlayerType;
  alive?: boolean;
  canRequest?: boolean;
  embargo?: boolean;
  relation?: Relation;
}

interface Env {
  o?: Partial<ApexOptions>;
  foes?: Record<string, number>;
  forecast?: { p: number; branch: string; deterministic: boolean };
  /** The nation's next decision from a tick (default: the tick itself). */
  nextDecision?: (from: number) => number;
  kinds?: string;
}

function view(nats: Nat[], env: Env = {}): SearchView {
  const byId = new Map(nats.map((n) => [n.id, n]));
  const players = new Map<string, object>();
  const player = (n: Nat) => {
    let p = players.get(n.id);
    if (p === undefined) {
      p = {
        id: () => n.id,
        isAlive: () => n.alive ?? true,
        troops: () => n.troops,
        type: () => n.type ?? PlayerType.Nation,
        relation: () => n.relation ?? Relation.Neutral,
        __M: 3_000_000,
      };
      players.set(n.id, p);
    }
    return p;
  };
  const me = {
    troops: () => 1_000_000,
    gold: () => 10_000_000n,
    __M: 3_000_000,
    allianceWith: (p: { id(): string }) => {
      const n = byId.get(p.id())!;
      return n.expiresAt === undefined
        ? null
        : { expiresAt: () => n.expiresAt! };
    },
    isAlliedWith: (p: { id(): string }) =>
      byId.get(p.id())?.expiresAt !== undefined,
    canSendAllianceRequest: (p: { id(): string }) =>
      byId.get(p.id())?.canRequest ?? true,
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
    acceptsAlliance: () =>
      env.forecast ?? { p: 0.6, branch: "similar", deterministic: false },
    nextDecision: (_id: string, from: number) =>
      env.nextDecision ? env.nextDecision(from) : from,
    relations: { value: () => 0 },
  };
  const opts = {
    ...APEX_DEFAULTS,
    searchDefend: true,
    ...env.o,
  } as ApexOptions;
  return {
    o: opts,
    t: T,
    game,
    me,
    wm: { nations: [] },
    host: {
      state: {
        web: { allySet: [], extensionAsked: {} },
        search: { foes: env.foes ?? {} },
      },
      nationModel: () => nm,
      available: () => 1_000_000,
    },
    kinds: new Set((env.kinds ?? opts.searchKinds).split(",")),
  } as unknown as SearchView;
}

function base(attacks: [string, number, number][], h = 600): BaseView {
  const attackers = new Map<string, AttackSeen>();
  for (const [id, troops, at] of attacks) attackers.set(id, { h: at, troops });
  return { h, attackers, snaps: [] };
}

describe("round 2b's defensive plans", () => {
  test("off: nothing; on: ally:N for each unallied attacker, largest first", () => {
    const nats: Nat[] = [
      { id: "A", troops: 500_000 },
      { id: "B", troops: 500_000 },
      { id: "C", troops: 500_000 },
    ];
    const b = base([
      ["A", 100_000, 400],
      ["B", 300_000, 500],
      ["C", 300_000, 200],
    ]);
    expect(
      DEFEND.generate(view(nats, { o: { searchDefend: false } }), b),
    ).toEqual([]);
    const cands = DEFEND.generate(view(nats), b);
    // By troops, then the earlier attack: C (300k at +200), B, A.
    expect(cands.map((c) => c.name)).toEqual(["ally:C", "ally:B", "ally:A"]);
    expect(cands[0]).toMatchObject({
      kind: "ally",
      target: "C",
      lastSend: 0,
      isBreak: false,
      strongCheck: false,
      defensive: true,
    });
    expect(cands[0].steps).toEqual([requestStep("C", T)]);
    expect(cands[0].steps[0].p!.intent).toEqual({
      type: "allianceRequest",
      recipient: "C",
    });
    expect(cands[0].steps[0].p!.key).toBe("ally:C");
    // The kind degraded away: no ally plans.
    expect(
      DEFEND.generate(view(nats, { kinds: "strike,lapse,keep,break" }), b),
    ).toEqual([]);
  });

  test("a foe mark is ended first, an embargo stopped, the request delayed to be seen: ally:N:stop", () => {
    // A foe mark of ours (a lapse) still holding: the plan ends it.
    const c1 = allyCandidate(
      view([{ id: "A", troops: 1 }], { foes: { A: T + 500 } }),
      "A",
    )!;
    expect(c1.name).toBe("ally:A:stop");
    expect(c1.steps.map((s) => [s.at, s.foe, s.p?.intent.type])).toEqual([
      [T, { id: "A", until: T - 1 }, undefined],
      [T, undefined, "allianceRequest"],
    ]);
    // A mark that has run out is left alone.
    expect(
      allyCandidate(
        view([{ id: "A", troops: 1 }], { foes: { A: T - 1 } }),
        "A",
      )!.name,
    ).toBe("ally:A");
    // Our embargo on it: the stop now, the request now when its next
    // decision is at T + 2 or later (the stop is seen from T + 2 on).
    const emb: Nat[] = [{ id: "A", troops: 1, embargo: true }];
    const c2 = allyCandidate(
      view(emb, { nextDecision: (from) => Math.max(from, T + 2) }),
      "A",
    )!;
    expect(c2.name).toBe("ally:A:stop");
    expect(c2.steps).toEqual([stopStep("A", T), requestStep("A", T)]);
    expect(c2.steps[0].p!.intent).toEqual({
      type: "embargo",
      targetID: "A",
      action: "stop",
    });
    expect(c2.lastSend).toBe(0);
    // Its next decision would come at T + 1, before the stop is seen: the
    // request goes a tick later (the recall's rule).
    const c3 = allyCandidate(view(emb, { nextDecision: (from) => from }), "A")!;
    expect(c3.steps).toEqual([stopStep("A", T), requestStep("A", T + 1)]);
    expect(c3.lastSend).toBe(1);
    // embargoStop off: no stop, a plain request.
    expect(
      allyCandidate(view(emb, { o: { embargoStop: false } }), "A")!.steps,
    ).toEqual([requestStep("A", T)]);
  });

  test("none when it cannot pass: unsendable, a certain refusal, a human, dead, allied", () => {
    const sv = (n: Partial<Nat>, env: Env = {}) =>
      allyCandidate(view([{ id: "A", troops: 1, ...n }], env), "A");
    expect(sv({ canRequest: false })).toBeNull();
    expect(
      sv({}, { forecast: { p: 0, branch: "tooMany", deterministic: true } }),
    ).toBeNull();
    // A draw may still pass a 0 forecast that is not deterministic.
    expect(
      sv({}, { forecast: { p: 0, branch: "similar", deterministic: false } }),
    ).not.toBeNull();
    expect(sv({ type: PlayerType.Human })).toBeNull();
    expect(sv({ alive: false })).toBeNull();
    expect(sv({ expiresAt: T + 100 })).toBeNull();
    expect(allyCandidate(view([]), "Z")).toBeNull();
  });

  test("an ally attacking after its expiry gets keep:N (kept by the web or not); before it, nothing", () => {
    const nats: Nat[] = [
      { id: "Z", troops: 2_000_000, expiresAt: T + 400 },
      { id: "Y", troops: 2_000_000, expiresAt: T + 800 },
    ];
    // Z attacks at +450 (after its expiry at +400): keep:Z; Y at +300
    // (before its expiry at +800): a betrayal, no plan.
    const cands = DEFEND.generate(
      view(nats, { o: { searchKeepGift: false } }),
      base([
        ["Z", 500_000, 450],
        ["Y", 900_000, 300],
      ]),
    );
    expect(cands.map((c) => c.name)).toEqual(["keep:Z"]);
    expect(cands[0]).toMatchObject({
      kind: "keep",
      target: "Z",
      defensive: true,
    });
    expect(cands[0].steps.map((s) => [s.at, s.p?.intent.type])).toEqual([
      [T + 400 - APEX_DEFAULTS.extendLead, "allianceExtension"],
      [T + 401, "allianceRequest"],
    ]);
    // With a low extension forecast the gift variant comes too.
    const withGift = DEFEND.generate(
      view(nats, {
        forecast: { p: 0.1, branch: "enough", deterministic: false },
      }),
      base([["Z", 500_000, 450]]),
    );
    expect(withGift.map((c) => c.name)).toEqual(["keep:Z", "keep:Z+gift"]);
    expect(withGift[1].steps.map((s) => s.p?.intent.type)).toEqual([
      "donate_gold",
      "allianceExtension",
      "allianceRequest",
    ]);
    // The keep kind degraded away: nothing for an ally.
    expect(
      DEFEND.generate(
        view(nats, { kinds: "strike,lapse,break,ally" }),
        base([["Z", 500_000, 450]]),
      ),
    ).toEqual([]);
  });
});
