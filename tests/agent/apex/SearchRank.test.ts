/**
 * Package WP3 (docs/14-m4-plan.md §2.4, §3 WP3 `rank`): the priors that
 * pick the searchK nations (lib/search/cands/rank.ts).
 *
 * Claims:
 * - preyScore is the predator's kill cost per tile times the front factor
 *   (hand-computed); Infinity without contact; the last 99 tiles are free.
 * - killsim's parts (territory bonus, the nation cap, regrowth) match
 *   their formulas; a big stack kills a small nation, an empty one takes
 *   nothing.
 * - terrainFactor weighs the contact mix as attackLogic does.
 * - rankMode accepts the four modes and refuses others; parseApexOptions
 *   refuses a searchRank outside SEARCH_RANKS at construction (review F4).
 * - rankedNations in "prey" mode orders the scan's nations by the score
 *   and rewrites their contacts so the core's contact filter and sort
 *   follow the rank; nations below searchMinContact that do not attack us
 *   in the base are left out. RANKED_CORE in "contact" mode is the core.
 */
import { KILL_FREE } from "../../../src/agent/agents/apex/controllers/ExpansionController";
import {
  APEX_DEFAULTS,
  ApexOptions,
  parseApexOptions,
  SEARCH_RANKS,
} from "../../../src/agent/agents/apex/options";
import { CORE } from "../../../src/agent/lib/search/cands/core";
import {
  killsim,
  nationCap,
  PREY_BASE,
  PREY_DENSITY,
  PREY_FRONT,
  PREY_TERRAIN,
  PREY_TICKS,
  preyScore,
  RANK_MODES,
  RANKED_CORE,
  rankedNations,
  rankMode,
  regrowth,
  terrainFactor,
  territoryBonus,
} from "../../../src/agent/lib/search/cands/rank";
import type {
  BaseView,
  SearchView,
} from "../../../src/agent/lib/search/Registry";
import { retaliationBound } from "../../../src/agent/lib/StrikeWindows";
import type { NeighborInfo } from "../../../src/agent/lib/WorldModel";
import { Config } from "../../../src/core/configuration/Config";
import { PlayerType } from "../../../src/core/game/Game";
import { GAME_CONFIG } from "./Field";

const CONFIG = new Config(GAME_CONFIG, null, false);

describe("the priors", () => {
  test("preyScore by hand", () => {
    const x = {
      n: 10_099,
      T: 200_000,
      M: 1_000_000,
      reserve: 0.3,
      contact: 20,
    };
    const d = x.T / x.n;
    const cost =
      (x.n - KILL_FREE) * (PREY_BASE + PREY_DENSITY * d) * PREY_TERRAIN +
      retaliationBound(x.T, x.reserve, x.M) +
      0.2 * x.T;
    const tau = x.n / (PREY_FRONT * x.contact);
    expect(preyScore(x)).toBeCloseTo((cost / x.n) * (1 + tau / PREY_TICKS), 9);
    expect(preyScore({ ...x, contact: 0 })).toBe(Infinity);
    expect(preyScore({ ...x, n: 0 })).toBe(Infinity);
    // A wider front is cheaper (τ falls); the last KILL_FREE tiles are free.
    expect(preyScore({ ...x, contact: 40 })).toBeLessThan(preyScore(x));
    const tiny = { ...x, n: KILL_FREE, T: 100 };
    expect(preyScore(tiny)).toBeCloseTo(
      ((retaliationBound(100, 0.3, x.M) + 20) / KILL_FREE) *
        (1 + KILL_FREE / (PREY_FRONT * 20) / PREY_TICKS),
      9,
    );
  });

  test("killsim's parts and outcomes", () => {
    expect(territoryBonus(300_000, 0.7)).toBeCloseTo(1 - 0.35, 12);
    expect(territoryBonus(1, 0.7)).toBeCloseTo(1, 6);
    expect(nationCap(100_000, 2)).toBeCloseTo(
      1.25 * (2 * (100_000 ** 0.6 * 1000 + 50_000) + 500_000),
      6,
    );
    expect(regrowth(1_000_000, 1_000_000)).toBe(0);
    expect(regrowth(100_000, 1_000_000, 1.05)).toBeCloseTo(
      1.05 * (10 + 100_000 ** 0.73 / 4) * 0.9,
      9,
    );
    const prey = {
      n: 400,
      T: 5_000,
      L: 0,
      b: 40,
      gold: 0,
      reserve: 0.3,
      trigger: 0.8,
      rate: 100,
      usTiles: 50_000,
      H: 500_000,
      terr: 1,
    };
    const kill = killsim({ ...prey, S0: 300_000, flow: 100 });
    expect(kill.killed).toBe(true);
    expect(kill.tiles).toBeCloseTo(400, 6);
    expect(kill.lost).toBeGreaterThan(0);
    expect(kill.ticks).toBeLessThan(600);
    const none = killsim({ ...prey, S0: 0, flow: 0 });
    expect(none).toEqual({ killed: false, tiles: 0, lost: 0, ticks: 1 });
    // A stack too small against a big defender is spent without a kill.
    const big = killsim({
      ...prey,
      n: 200_000,
      T: 2_000_000,
      S0: 20_000,
      flow: 0,
    });
    expect(big.killed).toBe(false);
    expect(big.tiles).toBeLessThan(200_000);
  });

  test("terrainFactor and rankMode", () => {
    expect(
      terrainFactor({ plains: 10, highland: 0, mountain: 0 } as never),
    ).toBe(1);
    expect(
      terrainFactor({ plains: 0, highland: 0, mountain: 4 } as never),
    ).toBe(1.5);
    expect(
      terrainFactor({ plains: 2, highland: 2, mountain: 0 } as never),
    ).toBe(1.125);
    expect(
      terrainFactor({ plains: 0, highland: 0, mountain: 0 } as never),
    ).toBe(1);
    for (const m of RANK_MODES) expect(rankMode(m)).toBe(m);
    expect(() => rankMode("best")).toThrow(/searchRank/);
    // Checked at construction too: a typo never runs, nor kills a game.
    expect(RANK_MODES).toEqual(SEARCH_RANKS);
    expect(parseApexOptions({ searchRank: "prey" }).searchRank).toBe("prey");
    expect(() => parseApexOptions({ searchRank: "best" })).toThrow(
      /searchRank.*must be one of contact, prey, yield, killsim/,
    );
    expect(() => parseApexOptions({ searchRank: 1 })).toThrow(/searchRank/);
  });
});

interface Nat {
  id: string;
  smallID: number;
  contact: number;
  troops: number;
  tiles: number;
  M?: number;
}

const T = 4000;

function view(nats: Nat[], o: Partial<ApexOptions> = {}): SearchView {
  const byId = new Map(nats.map((n) => [n.id, n]));
  const player = (n: Nat) => ({
    id: () => n.id,
    isAlive: () => true,
    troops: () => n.troops,
    numTilesOwned: () => n.tiles,
    type: () => PlayerType.Nation,
    __M: n.M ?? 2_000_000,
  });
  const me = {
    troops: () => 1_000_000,
    allianceWith: () => null,
    isAlliedWith: () => false,
    incomingAttacks: () => [],
  };
  const opts = { ...APEX_DEFAULTS, ...o } as ApexOptions;
  return {
    ctx: { gameID: "rank-test" },
    o: opts,
    t: T,
    game: {
      hasPlayer: (id: string) => byId.has(id),
      player: (id: string) => player(byId.get(id)!),
      config: () => ({
        maxTroops: (p: { __M: number }) => p.__M,
        gameConfig: () => CONFIG.gameConfig(),
      }),
    },
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
    host: { available: () => 1_000_000 },
    kinds: new Set(opts.searchKinds.split(",")),
  } as unknown as SearchView;
}

const NO_BASE: BaseView = { h: 150, attackers: new Map(), snaps: [] };

describe("the ranked core", () => {
  // Three bordering nations: by contact A > B > C; by prey score the
  // small, thin C is the cheapest, then B, then the big dense A.
  const NATS: Nat[] = [
    { id: "A", smallID: 1, contact: 60, troops: 900_000, tiles: 20_000 },
    { id: "B", smallID: 2, contact: 40, troops: 300_000, tiles: 15_000 },
    { id: "C", smallID: 3, contact: 20, troops: 30_000, tiles: 5_000 },
    // Below the minimum contact and not attacking: left out.
    { id: "D", smallID: 4, contact: 3, troops: 10, tiles: 100 },
  ];

  test("prey mode orders the scan by the score and rewrites the contacts", () => {
    const sv = view(NATS, { searchRank: "prey" });
    const ranked = rankedNations(sv, NO_BASE, "prey");
    expect(ranked.map((n) => n.id)).toEqual(["C", "B", "A"]);
    const min = APEX_DEFAULTS.searchMinContact;
    expect(ranked.map((n) => n.contact)).toEqual([min + 3, min + 2, min + 1]);
    // An attacker of the base below the minimum contact counts.
    const b: BaseView = {
      h: 150,
      attackers: new Map([["D", { h: 10, troops: 5 }]]),
      snaps: [],
    };
    expect(rankedNations(sv, b, "prey").map((n) => n.id)).toContain("D");
  });

  test("the core on the ranked view strikes the rank's first searchK; contact mode is the core", () => {
    const sv = view(NATS, { searchRank: "prey", searchOnTop: false });
    const names = RANKED_CORE.generate(sv, NO_BASE).map((c) => c.name);
    expect(names).toEqual([
      "strike:C:0.5",
      "strike:C:1",
      "strike:B:0.5",
      "strike:B:1",
    ]);
    const plain = view(NATS, { searchOnTop: false });
    expect(RANKED_CORE.generate(plain, NO_BASE)).toEqual(
      CORE.generate(plain, NO_BASE),
    );
    expect(CORE.generate(plain, NO_BASE).map((c) => c.name)).toEqual([
      "strike:A:0.5",
      "strike:A:1",
      "strike:B:0.5",
      "strike:B:1",
    ]);
    expect(() =>
      RANKED_CORE.generate(view(NATS, { searchRank: "x" as never }), NO_BASE),
    ).toThrow(/searchRank/);
  });
});
