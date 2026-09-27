import fs from "fs";
import os from "os";
import path from "path";
import type { ArenaGameResult } from "../../src/agent/arena/ArenaGame";
import {
  flowTable,
  goldAt,
  LOG_LINES_KEPT,
  lostBefore,
  nationBefore,
  nationReached,
  outBefore,
  peakRegrowth,
  quantile,
  readRun,
  regrowth,
  seatFlow,
  seatLogStats,
  shareAt,
  splitGameLog,
  storedGame,
  summarize,
  SummaryGame,
  SummarySeat,
  summaryTable,
  TimelineSample,
} from "../../src/agent/arena/Summary";
import { PlayerType } from "../../src/core/game/Game";

// The M4 plan's arena metrics (plan.md §2.10): troop flow over minutes 5-15,
// strikes and pile-ons, bombs, gold, the minute a nation takes half the land
// or wins, lost before minute 20, and the searches read from the log. The
// numbers are worked by hand from made-up results.

const NATION = PlayerType.Nation;

function seat(overrides: Partial<SummarySeat> = {}): SummarySeat {
  return {
    result: "timeout",
    eliminatedAtTick: null,
    placement: 5,
    peakShare: 0.08,
    finalShare: 0.04,
    stats: { errors: 0, intentsRateLimited: 0, thinkMs: { p95: 2 } },
    standings: [],
    ...overrides,
  };
}

const game = (
  s: SummarySeat,
  ticks = 12000,
  extra: Partial<SummaryGame> = {},
): SummaryGame => ({ ticks, gameMinutes: ticks / 600, seats: [s], ...extra });

/** Timeline samples every 300 ticks from 300 to `to`, as the arena takes
 *  them, with the fields `at` sets. */
function timeline(
  to: number,
  at: (tick: number) => Partial<TimelineSample>,
): TimelineSample[] {
  const out: TimelineSample[] = [];
  for (let tick = 300; tick <= to; tick += 300) {
    out.push({
      tick,
      tiles: 1000,
      share: 0.01,
      troops: 1e6,
      maxTroops: 1e6,
      gold: 0,
      alive: true,
      ...at(tick),
    });
  }
  return out;
}

const r = regrowth(420_000, 1e6);
const P = peakRegrowth(1e6);

describe("regrowth", () => {
  test("the formula: 10 at no troops, nothing at the cap", () => {
    expect(regrowth(0, 1000)).toBe(10);
    expect(regrowth(1000, 1000)).toBe(0);
    expect(regrowth(5000, 1000)).toBe(0);
    expect(regrowth(10, 0)).toBe(0);
    // (10 + 250,000^0.73 / 4) × 0.75, by hand: 250,000^0.73 = 8,704.
    expect(regrowth(250_000, 1e6)).toBeCloseTo((10 + 8704 / 4) * 0.75, -1);
  });

  test("its peak: near 0.42 of the cap, about 0.077 C^0.73 a tick", () => {
    // plan.md §1.2: 1.1M and 6.0M a minute at caps of 1M and 10M.
    expect((peakRegrowth(1e6) * 600) / 1e6).toBeCloseTo(1.1, 1);
    expect((peakRegrowth(10e6) * 600) / 1e6).toBeCloseTo(6.0, 1);
    for (const cap of [1e5, 1e6, 3e6, 2e7]) {
      const peak = peakRegrowth(cap);
      expect(peak / (0.077 * cap ** 0.73)).toBeCloseTo(1, 1);
      // Above every point of a 0.1% grid, and not by more than rounding.
      let grid = 0;
      for (let i = 1; i < 1000; i++) {
        grid = Math.max(grid, regrowth((cap * i) / 1000, cap));
      }
      expect(peak).toBeGreaterThanOrEqual(grid);
      expect(peak / grid).toBeLessThan(1 + 1e-5);
      expect(regrowth(0.42 * cap, cap) / peak).toBeGreaterThan(0.999);
    }
    expect(peakRegrowth(0)).toBe(0);
  });
});

describe("seatFlow", () => {
  // Seat 1 plays through the window: near its peak (home 420k of 1M) at
  // the five samples 3000-4200, at its cap at the fifteen from 4500 to
  // 8700; it gains a tile a tick.
  const through = seat({
    timeline: timeline(9300, (tick) => ({
      troops: tick >= 3000 && tick <= 4200 ? 420_000 : 1e6,
      tiles: 10_000 + (tick - 3000),
      gold: tick * 10,
    })),
    attacks: [
      // Two strikes, one still running; a boat, free land, a tribe.
      strike(3100, NATION, false, 50_000, 1000),
      strike(5000, NATION, false, null, 300),
      strike(4000, NATION, true, 10_000, 100),
      strike(4100, "TerraNullius", false, 5000, 500),
      strike(4200, PlayerType.Bot, false, 5000, 500),
    ],
    received: {
      attacks: { nation: 5, bot: 1, human: 1 },
      nukes: { atom: 2, hydrogen: 1, mirv: 1, mirvWarhead: 350 },
      launches: [
        launch(2000, NATION),
        launch(3100, NATION), // with the first strike: piles on
        launch(3200, PlayerType.Bot),
        launch(3400, NATION), // 300 ticks after it: still
        launch(3401, NATION), // one tick too late
        launch(5050, PlayerType.Human),
        launch(5100, NATION), // after the second strike
      ],
      nukeLog: [
        nuke(4000, "atom", 0.1),
        nuke(5000, "atom", 0.2),
        nuke(6000, "hydrogen", 0.3),
        nuke(7000, "mirv", 0.4),
      ],
    },
  });

  test("utilization, idle share and price over minutes 5-15", () => {
    const f = seatFlow(game(through), 0);
    // Samples 3000-8700: five at r, fifteen at the cap (no regrowth).
    expect(f.utilization).toBeCloseTo((5 * r) / (20 * P), 12);
    expect(f.idleShare).toBe(15 / 20);
    // (5 × 300 × r − (1M − 420k)) ÷ (16,000 − 10,000) tiles.
    expect(f.allInPrice).toBeCloseTo((1500 * r - 580_000) / 6000, 9);
    // Only land attacks on nations are strikes; a running one has no price.
    expect(f.strikes).toBe(2);
    expect(f.strikeTroopsLost).toBe(50_000);
    expect(f.strikeTilesGained).toBe(1000);
    // Two nation attacks follow the first strike, one the second.
    expect(f.pileOns).toBe(3);
  });

  test("a game that ended in the window: its last sample is off the grid", () => {
    // A nation won at tick 5150; the arena sampled that tick too.
    const samples = timeline(5100, (tick) => ({
      troops: 420_000,
      tiles: tick < 3000 ? 5000 : 10_000 + ((tick - 3000) / 2100) * 2000,
    }));
    samples.push({ ...samples[samples.length - 1], tick: 5150, tiles: 13_000 });
    const g = game(seat({ result: "loss", timeline: samples }), 5150);
    const f = seatFlow(g, 0);
    // The regular samples 3000-5100 (eight), not the extra one at 5150.
    expect(f.utilization).toBeCloseTo(r / P, 12);
    expect(f.idleShare).toBe(0);
    // The price runs to the game's end: 7 × 300 + 50 ticks of regrowth.
    expect(f.allInPrice).toBeCloseTo((2150 * r) / 3000, 9);
    // No attack log, no received: nothing known of strikes' pile-ons.
    expect([f.strikes, f.pileOns]).toEqual([0, null]);
  });

  test("no price without a sample at minute 5, or without growth", () => {
    const late = seat({
      timeline: timeline(9000, () => ({})).filter((p) => p.tick !== 3000),
    });
    expect(seatFlow(game(late), 0).allInPrice).toBeNull();
    const flat = seat({ timeline: timeline(9000, () => ({ tiles: 500 })) });
    expect(seatFlow(game(flat), 0)).toMatchObject({
      allInPrice: null,
      utilization: 0,
      idleShare: 1,
    });
    // Out before minute 5: nothing in the window.
    const dead = seat({ timeline: timeline(9000, () => ({ alive: false })) });
    expect(seatFlow(game(dead), 0)).toMatchObject({
      utilization: null,
      idleShare: null,
      allInPrice: null,
    });
  });

  test("pile-ons of older runs: apex's `def why` lines, else unknown", () => {
    const strikes = [strike(3100, NATION, false, 1, 1)];
    const logged = (lines: string[], nationAttacks: number) =>
      seatFlow(
        game(
          seat({
            attacks: strikes,
            received: {
              attacks: { nation: nationAttacks, bot: 0, human: 0 },
              nukes: { atom: 0, hydrogen: 0, mirv: 0, mirvWarhead: 0 },
            },
            logs: lines,
          }),
        ),
        0,
      ).pileOns;
    expect(
      logged(
        [
          "[3150] 3150 def in Pakistan 1000 land ~10 tiles",
          "[3150] 3150 def why Pakistan T=1 [juicy]",
          "[3500] 3500 def why Pakistan T=1 [juicy]",
        ],
        2,
      ),
    ).toBe(1);
    // apex logged no `def why`: its nation attacks never landed.
    expect(logged(["[3000] 3000 def boat Oman 1000 to 1,1"], 1)).toBe(0);
    // An agent without apex's lines: known only if no nation attacked.
    expect(logged(["[3000] something"], 1)).toBeNull();
    expect(logged([], 0)).toBe(0);
  });

  test("gold at minutes 10, 15 and 20: the sample then, the seat alive", () => {
    const g = game(through);
    expect([10, 15, 20].map((m) => goldAt(g, 0, m))).toEqual([
      60_000,
      90_000,
      null,
    ]);
    const out = seat({ timeline: timeline(6000, () => ({ alive: false })) });
    expect(goldAt(game(out), 0, 10)).toBeNull();
  });
});

describe("outcomes by minute 20", () => {
  const cases: [string, SummaryGame, boolean | null, boolean | null][] = [
    // [what, game, out before 20, lost before 20]
    [
      "eliminated at 15",
      game(seat({ result: "loss", eliminatedAtTick: 9000 }), 9000),
      true,
      true,
    ],
    ["a nation won at 12", game(seat({ result: "loss" }), 7200), false, true],
    ["a nation won at 20", game(seat({ result: "loss" }), 12000), false, false],
    ["we won at 9", game(seat({ result: "win" }), 5400), false, false],
    [
      "alive at the cap",
      game(seat({ result: "timeout" }), 12000),
      false,
      false,
    ],
    ["capped at 10", game(seat({ result: "timeout" }), 6000), null, null],
    ["stopped on an error", game(seat({ result: "error" }), 900), null, null],
    [
      "--play-out: out at 25",
      game(seat({ result: "loss", eliminatedAtTick: 15000 }), 20000),
      false,
      false,
    ],
  ];
  test.each(cases)("%s", (_, g, out, lost) => {
    expect(outBefore(g, 0, 20)).toBe(out);
    expect(lostBefore(g, 0, 20)).toBe(lost);
  });

  test("the summary's rates, and the table's column beside out < 20", () => {
    const s = summarize(
      "x",
      cases.map(([, g]) => ({ r: g, seat: 0 })),
      0,
    );
    expect(s.eliminatedBefore20Games).toBe(6);
    expect(s.eliminatedBefore20).toBeCloseTo(1 / 6);
    expect(s.lostBefore20Games).toBe(6);
    expect(s.lostBefore20).toBeCloseTo(2 / 6);
    const [header, , row] = summaryTable([s])
      .split("\n")
      .map((l) => l.split("|").map((c) => c.trim()));
    const out = header.indexOf("out < 20 min");
    expect(header[out + 1]).toBe("lost < 20 min");
    expect(row[out + 1]).toBe("33.3% of 6");
  });

  test("land share at a minute, as the M4 plan counts it", () => {
    const standing = (minute: number, share: number) => ({
      minute,
      share,
      rank: 2,
      medianNationShare: 0.01,
      topNation: null,
    });
    const alive = game(
      seat({
        standings: [standing(10, 0.2)],
        timeline: timeline(12000, (tick) => ({ share: tick / 1e5 })),
        finalShare: 0.3,
      }),
    );
    // The standing, else the timeline's sample at the minute.
    expect(shareAt(alive, 0, 10)).toBe(0.2);
    expect(shareAt(alive, 0, 15)).toBe(0.09);
    // A game that ended earlier: the final share, or 0 once out.
    const won = game(seat({ result: "win", finalShare: 0.81 }), 5400);
    expect(shareAt(won, 0, 10)).toBe(0.81);
    const lost = game(seat({ result: "loss", finalShare: 0.05 }), 7200);
    expect(shareAt(lost, 0, 20)).toBe(0.05);
    const out = game(
      seat({ result: "loss", eliminatedAtTick: 6000, finalShare: 0 }),
      6000,
    );
    expect([shareAt(out, 0, 10), shareAt(out, 0, 20)]).toEqual([0, 0]);
    // Cut short by a cap before the minute: unknown.
    expect(shareAt(game(seat(), 6000), 0, 20)).toBeNull();
  });
});

describe("nations", () => {
  const leaders = (
    ...points: [number, [string, number][]][]
  ): SummaryGame["leaders"] =>
    points.map(([tick, ls]) => ({
      tick,
      leaders: ls.map(([type, share]) => ({ type, share })),
    }));

  test("the first minute a nation held half the land, or won", () => {
    const g = game(seat({ result: "loss" }), 9000, {
      winner: { type: NATION },
      leaders: leaders(
        [3000, [[NATION, 0.3]]],
        // A human's half does not count.
        [
          6000,
          [
            [PlayerType.Human, 0.55],
            [NATION, 0.2],
          ],
        ],
        [7200, [[NATION, 0.51]]],
        [9000, [[NATION, 0.8]]],
      ),
    });
    expect(nationReached(g, 0.5)).toBe(12);
    expect(nationReached(g, 0.8)).toBe(15);
    // From 45% to the win between two samples: the win is the minute.
    const fast = game(seat({ result: "loss" }), 7400, {
      winner: { type: NATION },
      leaders: leaders([7200, [[NATION, 0.45]]]),
    });
    expect(nationReached(fast, 0.5)).toBeCloseTo(7400 / 600);
    const none = game(seat(), 12000, {
      winner: null,
      leaders: leaders([6000, [[NATION, 0.49]]]),
    });
    expect(nationReached(none, 0.5)).toBeNull();
    expect(nationReached(none, 0.8)).toBeNull();

    // Before minute 20, paired in compare: a nation held half, or won.
    expect(nationBefore(g, 0, 0.5, 20)).toBe(true);
    expect(nationBefore(g, 0, 0.8, 20)).toBe(true);
    expect(nationBefore(g, 0, 0.5, 12)).toBe(false);
    expect(nationBefore(none, 0, 0.5, 20)).toBe(false);
    // Capped before minute 20 with no nation there yet: unknown.
    const capped = { ...none, ticks: 6000, gameMinutes: 10 };
    expect(nationBefore(capped, 0, 0.5, 20)).toBeNull();
    expect(nationBefore(game(seat()), 0, 0.5, 20)).toBeNull();

    const s = summarize(
      "x",
      [g, fast, none, game(seat())].map((x) => ({ r: x, seat: 0 })),
      0,
    );
    // The last game records neither leaders nor a winner: not known.
    expect(s.nationHalf).toEqual({
      games: 2,
      known: 3,
      medianMinute: (12 + 7400 / 600) / 2,
    });
    expect(s.nationWin).toEqual({
      games: 2,
      known: 3,
      medianMinute: (15 + 7400 / 600) / 2,
    });
  });
});

describe("searches from the log", () => {
  const SEARCH = [
    "[2400] 2400 search 2400 T3 cands=5 chosen=break:abc:1 gain=1200.5 base=100000 h=1200 te=3000 ms=15000",
    "[2450] search-check 2400 +50 ok",
    "[2550] search-check 2400 +150 MISMATCH",
    "[3000] search 3000 T1 cands=3 chosen=base gain=0 base=120000 h=600 te=900 ms=4000",
    "[3000] search-check 2400 +600 ok",
    "[3600] search 3600 T7 skipped budget",
    "[3601] 3601 def why Pakistan T=1 [juicy]",
    "[3700] 3700 def in Pakistan 1000 land",
    "[4000] search 4000 T2 cands=4 chosen=strike:xyz:0.5 gain=800 base=130000 h=600 te=1500 ms=6000",
    '[4001] search-feat {"home":0.9}',
    // A log-only search chooses a plan but does not play it.
    "[4600] search 4600 T7 cands=2 chosen=lapse:q mode=plans gain=50 te=100 ms=1000",
    "[4100] 4100 wstrike xyz W3 S=100k",
  ];

  test("the SearchController's lines", () => {
    expect(seatLogStats(SEARCH)).toEqual({
      lines: SEARCH.length,
      truncated: false,
      defWhy: [3601],
      search: {
        format: "search",
        searches: 4,
        byTrigger: { T3: 1, T1: 1, T2: 1, T7: 1 },
        skipped: 1,
        acts: 2,
        actsByKind: { break: 1, strike: 1 },
        gain: 2000.5,
        ms: 26000,
        te: 5500,
        checks: 3,
        mismatches: 1,
      },
    });
  });

  test("the act3 prototype's PROBE lines", () => {
    const snap = (home: number) => `{"tiles":1,"home":${home},"out":3}`;
    const lines = [
      '[2400] PROBE {"mode":"act3","t":2400,"chosen":"break:x:1","gain":500,"totalMs":1000,"rows":[]}',
      `[2450] PROBE_CHECK {"t0":2400,"h":50,"pred":${snap(2)},"live":${snap(2)}}`,
      `[2500] PROBE_CHECK {"t0":2400,"h":100,"pred":${snap(2)},"live":${snap(5)}}`,
      // Log-only: rolls out, never acts.
      '[3000] PROBE {"mode":"plans","t":3000,"chosen":"strike:y:1","totalMs":2000}',
      // A cost probe chooses nothing; an error is no JSON.
      '[3600] PROBE {"mode":"cost","t":3600}',
      "[3700] PROBE error boom",
      "[3800] PROBE_TRACE from 3000 diffs=0",
      '[3900] PROBE {"mode":"act3", broken',
    ];
    expect(seatLogStats(lines)).toEqual({
      lines: lines.length,
      truncated: false,
      defWhy: null,
      search: {
        format: "probe",
        searches: 2,
        byTrigger: { act3: 1, plans: 1 },
        skipped: 0,
        acts: 1,
        actsByKind: { break: 1 },
        gain: 500,
        ms: 3000,
        te: null,
        checks: 2,
        mismatches: 1,
      },
    });
  });

  test("a log at the host's cap is flagged; no search is null", () => {
    const many = Array.from(
      { length: LOG_LINES_KEPT },
      (_, i) => `[${i}] ${i} tn`,
    );
    expect(seatLogStats(many).truncated).toBe(true);
    expect(seatLogStats(many.slice(1))).toEqual({
      lines: LOG_LINES_KEPT - 1,
      truncated: false,
      defWhy: null,
      search: null,
    });
  });

  test("a game log splits by seat", () => {
    const text = [
      "## apex (AGENT000)",
      "[1] one",
      "[2] two",
      "",
      "## odd (name) (AGENT001)",
      "[3] three",
      "",
      "## idle (AGENT002)",
    ].join("\n");
    expect(splitGameLog(text)).toEqual(
      new Map([
        ["AGENT000", ["[1] one", "[2] two"]],
        ["AGENT001", ["[3] three"]],
        ["AGENT002", []],
      ]),
    );
    expect(splitGameLog("## game000").size).toBe(0);
  });

  test("the summary adds them up, with R against the game's own time", () => {
    const probe = [
      '[2400] PROBE {"mode":"act3","chosen":"strike:x:1","gain":100,"totalMs":3000}',
    ];
    const rows = [
      // 26 s of search in a 36 s game: R = 26 / 10.
      game(seat({ logs: SEARCH }), 12000, { wallMs: 36_000 }),
      // 3 s in 4 s: R = 3; no tick-equivalents.
      game(seat({ logs: probe }), 6000, { wallMs: 4000 }),
      // No search: not among the search games.
      game(seat({ logs: ["[1] 1 tn"] }), 12000, { wallMs: 1000 }),
    ].map((r) => ({ r, seat: 0 }));
    const s = summarize("x", rows, 0).search!;
    expect(s).toMatchObject({
      games: 2,
      format: "mixed",
      searches: 5,
      skipped: 1,
      acts: 3,
      actsByKind: { break: 1, strike: 2 },
      gain: 2100.5,
      ms: 29000,
      checks: 3,
      mismatches: 1,
    });
    expect(s.R).toBeCloseTo(29000 / (10_000 + 1000));
    expect(s.rangeR).toEqual([2.6, 3]);
    expect(s.ticksR).toBeCloseTo(5500 / 12000);
    expect(summarize("x", rows.slice(2), 0).search).toBeNull();
  });
});

describe("the summary", () => {
  const strikes = [
    strike(3100, NATION, false, 50_000, 1000),
    strike(3200, NATION, false, 30_000, 1000),
  ];
  const received = (nukeLog: boolean) => ({
    attacks: { nation: 1, bot: 0, human: 0 },
    nukes: { atom: 2, hydrogen: 1, mirv: 1, mirvWarhead: 350 },
    launches: [launch(3300, NATION)],
    ...(nukeLog
      ? {
          nukeLog: [
            nuke(4000, "atom", 0.1),
            nuke(5000, "atom", 0.2),
            nuke(6000, "hydrogen", 0.3),
            nuke(7000, "mirv", 0.4),
          ],
        }
      : {}),
  });
  const games = [
    game(
      seat({
        timeline: timeline(12000, (t) => ({ gold: t, tiles: t })),
        attacks: strikes,
        received: received(true),
      }),
    ),
    game(
      seat({
        timeline: timeline(12000, (t) => ({ gold: 2 * t, troops: 420_000 })),
        attacks: [strike(4000, NATION, false, 1000, 0)],
        // Recorded before the nuke log: counted, no shares.
        received: received(false),
      }),
    ),
    // An old game: no attack log, received or timeline.
    game(seat()),
  ];

  test("flow, strikes, pile-ons, bombs and gold, over the games that know", () => {
    const s = summarize(
      "x",
      games.map((r) => ({ r, seat: 0 })),
      0,
    );
    // Game 1 idles at its cap; game 2 regrows at r all window.
    expect(s.flowGames).toBe(2);
    expect(s.utilization).toBeCloseTo((0 + r / P) / 2, 12);
    expect(s.idleShare).toBe(0.5);
    // Game 1 grew 6,000 tiles with no regrowth and no change of home.
    expect(s.allInPriceGames).toBe(1);
    expect(s.allInPrice).toBe(0);
    expect(s.strikes).toBe(3);
    expect(s.strikePrice).toBe((50_000 + 30_000 + 1000) / 2000);
    // The one nation attack follows both of game 1's strikes.
    expect([s.pileOns, s.pileOnStrikes]).toEqual([2, 3]);
    expect(s.pileOnsPerStrike).toBeCloseTo(2 / 3);
    expect([s.bombsReceived, s.mirvsReceived]).toEqual([6, 2]);
    expect(s.shareAtBombs).toBe(0.2);
    expect(s.shareAtMirvs).toBe(0.4);
    expect(s.gold).toEqual([
      { minute: 10, games: 2, median: 9000, p75: 10_500, max: 12_000 },
      { minute: 15, games: 2, median: 13_500, p75: 15_750, max: 18_000 },
      { minute: 20, games: 2, median: 18_000, p75: 21_000, max: 24_000 },
    ]);
    expect(s.truncatedLogs).toBe(0);

    const cells = flowTable([s, summarize("none", [], 0)])
      .split("\n")
      .map((l) => l.split("|").map((c) => c.trim()));
    const col = (row: number, name: string) =>
      cells[row][cells[0].indexOf(name)];
    expect(col(2, "utilization m5-15")).toBe(`${(r / P / 2).toFixed(3)} of 2`);
    expect(col(2, "idle m5-15")).toBe("50.0%");
    expect(col(2, "all-in price m5-15")).toBe("0 of 1");
    expect(col(2, "strikes")).toBe("3, 40.5/tile");
    expect(col(2, "pile-ons / strike")).toBe("0.67 (2 in 3)");
    expect(col(2, "bombs (MIRVs) in")).toBe("6 (2)");
    expect(col(2, "our share at bombs")).toBe("20.0%; MIRVs 40.0%");
    expect(col(2, "gold @10/15/20")).toBe("9k / 14k / 18k");
    expect(col(2, "searches")).toBe("–");
    // Nothing known of an entrant without games.
    for (const name of ["utilization m5-15", "pile-ons / strike", "R"]) {
      expect(col(3, name)).toBe("–");
    }
  });

  test("quantile interpolates between order statistics", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.75)).toBe(3.25);
    expect(quantile([5], 0.75)).toBe(5);
  });
});

describe("log stats in results directories", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-metrics-"));
    fs.mkdirSync(path.join(dir, "games"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("storedGame keeps what the summary reads of the log", () => {
    const logs = [
      "[2400] search 2400 T3 cands=2 chosen=strike:x:1 gain=5 base=9 h=600 te=10 ms=20",
    ];
    const result = {
      index: 0,
      gameID: "G",
      map: "World",
      ticks: 600,
      gameMinutes: 1,
      seats: [{ ...seat(), clientID: "AGENT000", logs }],
    } as unknown as ArenaGameResult;
    const stored = storedGame(result, 0, 0);
    expect(stored.seats[0]).not.toHaveProperty("logs");
    expect(stored.seats[0].logStats).toEqual(seatLogStats(logs));
    // In memory or stored, the summary is the same.
    expect(
      summarize("x", [{ r: stored as unknown as SummaryGame, seat: 0 }], 0),
    ).toEqual(
      summarize("x", [{ r: result as unknown as SummaryGame, seat: 0 }], 0),
    );
  });

  test("readRun reads them from the log for games stored without", () => {
    const write = (index: number, seats: Record<string, unknown>[]) =>
      fs.writeFileSync(
        path.join(dir, "games", `game${String(index).padStart(3, "0")}.json`),
        JSON.stringify({
          index,
          game: index,
          entrant: null,
          gameID: `G${index}`,
          map: "World",
          ticks: 600,
          gameMinutes: 1,
          seats,
        }),
      );
    const stored = seatLogStats(["[5] search 5 T1 chosen=base ms=1"]);
    write(0, [
      { ...seat(), clientID: "AGENT000" },
      { ...seat(), clientID: "AGENT001", logStats: stored },
      { ...seat(), clientID: "AGENT002" },
    ]);
    fs.writeFileSync(
      path.join(dir, "games", "game000.log"),
      [
        "## apex (AGENT000)",
        "[2400] 2400 search 2400 T3 cands=2 chosen=break:y:1 gain=7 te=1 ms=2",
        "[2500] 2500 def why Oman T=1",
        "",
        "## apex (AGENT001)",
        "[1] ignored: its stored stats stand",
      ].join("\n"),
    );
    // A game without a log keeps none.
    write(1, [{ ...seat(), clientID: "AGENT000" }]);
    const run = readRun(dir);
    const [a, b, c] = run.games[0].seats;
    expect(a.logStats).toMatchObject({
      lines: 2,
      defWhy: [2500],
      search: { searches: 1, acts: 1, actsByKind: { break: 1 }, gain: 7 },
    });
    expect(b.logStats).toEqual(stored);
    // No lines under its header: unknown, not empty.
    expect(c.logStats).toBeUndefined();
    expect(run.games[1].seats[0].logStats).toBeUndefined();
  });
});

function strike(
  startTick: number,
  type: string,
  boat: boolean,
  troopsLost: number | null,
  tilesGained: number,
) {
  return {
    startTick,
    target: { name: `T${startTick}`, type },
    boat,
    troopsLost,
    tilesGained,
  };
}

function launch(tick: number, type: string) {
  return { tick, by: { name: `N${tick}`, type }, troops: 1000, boat: false };
}

function nuke(tick: number, type: "atom" | "hydrogen" | "mirv", share: number) {
  return { tick, type, by: { name: "Nuker", type: NATION }, share, gold: 1e6 };
}
