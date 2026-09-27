/**
 * Package WP2 (docs/14-m4-plan.md §2.4): the core candidates, as the act3
 * prototype made them (lib/search/cands/core.ts). The generator only reads
 * the game, so the test hands it a stand-in view of one (the players'
 * troops, alliances and attacks, and the last scan's neighbours); on real
 * games S0 replays act3's candidate lists exactly (the WP2 small screen).
 *
 * Claims:
 * - act3 (searchOnTop off): nations by contact (≥ searchMinContact, or
 *   attacking us in the base's first ticks), until searchK are counted: an
 *   unallied attackable one gets strike:N:f for each share (1 count); an
 *   ally expiring within searchLapseLead gets lapse:N:1 (a foe mark from
 *   searchLapseFoeAt on to the expiry + 900, the strike at the expiry + 2;
 *   1 count) and break:N:f (the break now, the attack next tick; 1 count for
 *   all shares).
 * - ally:N for each attacker of the base we are not allied with, in the
 *   order they attacked.
 * - The plan (searchOnTop, the defaults): every expiring ally's lapse and
 *   every attacker's strikes come on top of the searchK nations, the
 *   lapses and the alliance requests first; a strike knows at the search
 *   whether its target is strong (its send is now).
 * - Round 1's list is cut to searchMaxCands; the stack gate moves strikes
 *   below T + incoming last.
 */
import {
  APEX_DEFAULTS,
  ApexOptions,
} from "../../../src/agent/agents/apex/options";
import { CORE } from "../../../src/agent/lib/search/cands/core";
import {
  BaseView,
  roundOneCandidates,
  SearchView,
} from "../../../src/agent/lib/search/Registry";
import type { NeighborInfo } from "../../../src/agent/lib/WorldModel";
import { PlayerType } from "../../../src/core/game/Game";

interface Nat {
  id: string;
  smallID: number;
  contact: number;
  troops: number;
  /** Alliance expiry, if allied. */
  expiresAt?: number;
  attackable?: boolean;
  type?: PlayerType;
}

const T = 3000;

/** act3's candidate rules (S0); the plan's are APEX_DEFAULTS'. */
const ACT3: Partial<ApexOptions> = {
  searchOnTop: false,
  searchLapseLead: 498,
  searchLapseFoeAt: 1,
  searchStackGate: false,
};
/** The plan's (the defaults). */
const PLAN: Partial<ApexOptions> = {
  searchOnTop: APEX_DEFAULTS.searchOnTop,
  searchLapseLead: APEX_DEFAULTS.searchLapseLead,
  searchLapseFoeAt: APEX_DEFAULTS.searchLapseFoeAt,
  searchStackGate: APEX_DEFAULTS.searchStackGate,
};

function view(
  nations: Nat[],
  o: Partial<ApexOptions> = {},
  strikePurse = 1_000_000,
  incoming: { from: string; troops: number }[] = [],
  myHome = 1_000_000,
): SearchView {
  const byId = new Map(nations.map((n) => [n.id, n]));
  const player = (n: Nat) => ({
    id: () => n.id,
    isAlive: () => true,
    troops: () => n.troops,
    type: () => n.type ?? PlayerType.Nation,
  });
  const me = {
    troops: () => myHome,
    allianceWith: (p: { id(): string }) => {
      const n = byId.get(p.id())!;
      return n.expiresAt === undefined
        ? null
        : { expiresAt: () => n.expiresAt! };
    },
    isAlliedWith: (p: { id(): string }) =>
      byId.get(p.id())?.expiresAt !== undefined,
    incomingAttacks: () =>
      incoming.map((a) => ({
        attacker: () => player(byId.get(a.from)!),
        troops: () => a.troops,
      })),
  };
  const game = {
    hasPlayer: (id: string) => byId.has(id),
    player: (id: string) => player(byId.get(id)!),
  };
  const wm = {
    // The scan lists nations by ascending smallID.
    nations: [...nations]
      .sort((a, b) => a.smallID - b.smallID)
      .map(
        (n) =>
          ({
            id: n.id,
            smallID: n.smallID,
            type: n.type ?? PlayerType.Nation,
            contact: n.contact,
            attackable: n.attackable ?? true,
          }) as unknown as NeighborInfo,
      ),
  };
  const opts = { ...APEX_DEFAULTS, ...ACT3, ...o } as ApexOptions;
  return {
    o: opts,
    t: T,
    game,
    me,
    wm,
    host: { available: () => strikePurse },
    kinds: new Set(opts.searchKinds.split(",")),
  } as unknown as SearchView;
}

const NO_BASE: BaseView = { h: 150, attackers: new Map(), snaps: [] };

describe("core search candidates", () => {
  test("strikes at each share for the unallied, lapse and breaks for allies, by contact", () => {
    const sv = view([
      { id: "LOW", smallID: 1, contact: 5, troops: 1 },
      { id: "N", smallID: 2, contact: 40, troops: 300_000 },
      { id: "Z", smallID: 3, contact: 90, troops: 200_000, expiresAt: T + 400 },
      { id: "W", smallID: 4, contact: 20, troops: 1, expiresAt: T + 2000 },
    ]);
    const cands = CORE.generate(sv, NO_BASE);
    // Z (contact 90) counts twice (lapse and break): K = 2 is reached
    // before N and W.
    expect(cands.map((c) => c.name)).toEqual([
      "lapse:Z:1",
      "break:Z:0.5",
      "break:Z:1",
    ]);
    const lapse = cands[0];
    expect(lapse.steps).toEqual([
      { at: T + 1, foe: { id: "Z", until: T + 400 + 900 } },
      expect.objectContaining({ at: T + 402, frac: 1 }),
    ]);
    expect(lapse.lastSend).toBe(402);
    expect(lapse.defensive).toBe(true);
    const brk = cands[2];
    expect(brk.isBreak).toBe(true);
    expect(brk.steps.map((s) => [s.at, s.p?.intent.type, s.frac])).toEqual([
      [T, "breakAlliance", undefined],
      [T + 1, "attack", 1],
    ]);

    // With K = 3, N (contact 40) follows: its strikes, share by share.
    const more = CORE.generate(
      view(
        [
          { id: "N", smallID: 2, contact: 40, troops: 300_000 },
          {
            id: "Z",
            smallID: 3,
            contact: 90,
            troops: 200_000,
            expiresAt: T + 400,
          },
        ],
        { searchK: 3 },
      ),
      NO_BASE,
    );
    expect(more.map((c) => c.name)).toEqual([
      "lapse:Z:1",
      "break:Z:0.5",
      "break:Z:1",
      "strike:N:0.5",
      "strike:N:1",
    ]);
    expect(more[3].steps).toEqual([
      expect.objectContaining({
        at: T,
        frac: 0.5,
        p: expect.objectContaining({
          intent: { type: "attack", targetID: "N", troops: 1 },
          cls: "strike",
          meta: expect.objectContaining({ target: 2 }),
        }),
      }),
    ]);
  });

  test("no lapse beyond searchLapseLead; the unattackable and humans get nothing", () => {
    const cands = CORE.generate(
      view([
        { id: "Z", smallID: 3, contact: 90, troops: 1, expiresAt: T + 499 },
        { id: "P", smallID: 4, contact: 80, troops: 1, attackable: false },
        { id: "H", smallID: 5, contact: 70, troops: 1, type: PlayerType.Human },
        { id: "N", smallID: 6, contact: 60, troops: 1 },
      ]),
      NO_BASE,
    );
    expect(cands.map((c) => c.name)).toEqual([
      "break:Z:0.5",
      "break:Z:1",
      "strike:N:0.5",
      "strike:N:1",
    ]);
  });

  test("the base's attackers: counted when bordering thinly, and asked for an alliance", () => {
    const sv = view([
      { id: "A", smallID: 1, contact: 2, troops: 500_000 },
      { id: "B", smallID: 2, contact: 30, troops: 100_000 },
      { id: "Z", smallID: 3, contact: 10, troops: 1, expiresAt: T + 2000 },
    ]);
    const base: BaseView = {
      h: 150,
      attackers: new Map([
        ["B", { h: 90, troops: 1 }],
        ["A", { h: 40, troops: 1 }],
        ["Z", { h: 10, troops: 1 }],
      ]),
      snaps: [],
    };
    // A (contact 2) is in only as an attacker; Z, allied, is not asked.
    expect(CORE.generate(sv, base).map((c) => c.name)).toEqual([
      "strike:B:0.5",
      "strike:B:1",
      "break:Z:0.5",
      "break:Z:1",
      "ally:B",
      "ally:A",
    ]);
  });

  test("round 1's cut, and the stack gate", () => {
    const sv = view(
      [
        { id: "BIG", smallID: 1, contact: 90, troops: 800_000 },
        { id: "SMALL", smallID: 2, contact: 50, troops: 100_000 },
      ],
      {},
      1_000_000,
      [{ from: "BIG", troops: 300_000 }],
    );
    const cands = CORE.generate(sv, NO_BASE);
    // BIG needs 800k + 300k: both its strikes are gated out; SMALL's half
    // (500k) and whole (1M) stacks pass.
    expect(cands.map((c) => [c.name, c.gate])).toEqual([
      ["strike:BIG:0.5", { S: 500_000, need: 1_100_000 }],
      ["strike:BIG:1", { S: 1_000_000, need: 1_100_000 }],
      ["strike:SMALL:0.5", { S: 500_000, need: 100_000 }],
      ["strike:SMALL:1", { S: 1_000_000, need: 100_000 }],
    ]);
    expect(roundOneCandidates([cands], true, 3).map((c) => c.name)).toEqual([
      "strike:SMALL:0.5",
      "strike:SMALL:1",
      "strike:BIG:0.5",
    ]);
    expect(roundOneCandidates([cands], false, 3).map((c) => c.name)).toEqual([
      "strike:BIG:0.5",
      "strike:BIG:1",
      "strike:SMALL:0.5",
    ]);
    // A name made twice keeps the first.
    expect(roundOneCandidates([cands, cands], false, 8)).toHaveLength(4);
  });

  test("the plan: lapses and attackers' strikes on top of searchK, first", () => {
    const nations: Nat[] = [
      { id: "A", smallID: 1, contact: 100, troops: 400_000 },
      { id: "B", smallID: 2, contact: 80, troops: 950_000 },
      { id: "Z", smallID: 3, contact: 20, troops: 1, expiresAt: T + 400 },
      { id: "Y", smallID: 4, contact: 10, troops: 1 },
      { id: "W", smallID: 5, contact: 9, troops: 1, expiresAt: T + 2000 },
    ];
    const base: BaseView = {
      h: 150,
      attackers: new Map([["Y", { h: 60, troops: 1 }]]),
      snaps: [],
    };
    const cands = CORE.generate(view(nations, PLAN), base);
    // K = 2: A and B by contact; Z's lapse (expiring) and Y's strikes (an
    // attacker) on top; W (allied, not expiring, past K) nothing.
    expect(cands.map((c) => c.name)).toEqual([
      "lapse:Z:1",
      "ally:Y",
      "strike:A:0.5",
      "strike:A:1",
      "strike:B:0.5",
      "strike:B:1",
      "strike:Y:0.5",
      "strike:Y:1",
    ]);
    // The plan's lapse: the foe mark now, the lead 500.
    expect(cands[0].steps[0]).toEqual({
      at: T,
      foe: { id: "Z", until: T + 400 + 900 },
    });
    // Strength at the search (0.9 of our home, 1M): B is strong, A not.
    const strong = Object.fromEntries(
      cands.filter((c) => c.kind === "strike").map((c) => [c.name, c.strong]),
    );
    expect(strong["strike:A:1"]).toBe(false);
    expect(strong["strike:B:1"]).toBe(true);
    // act3 on the same state: K is reached at B; nothing on top.
    expect(
      CORE.generate(view(nations, ACT3), base).map((c) => c.name),
    ).toEqual([
      "strike:A:0.5",
      "strike:A:1",
      "strike:B:0.5",
      "strike:B:1",
      "ally:Y",
    ]);
  });

  test("the plan: an expiring ally counts once (its breaks), not twice", () => {
    const nations: Nat[] = [
      { id: "Z", smallID: 3, contact: 90, troops: 1, expiresAt: T + 400 },
      { id: "N", smallID: 2, contact: 40, troops: 300_000 },
    ];
    expect(
      CORE.generate(view(nations, PLAN), NO_BASE).map((c) => c.name),
    ).toEqual([
      "lapse:Z:1",
      "break:Z:0.5",
      "break:Z:1",
      "strike:N:0.5",
      "strike:N:1",
    ]);
  });
});
