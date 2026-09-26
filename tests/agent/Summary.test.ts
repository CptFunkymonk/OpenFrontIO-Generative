import fs from "fs";
import os from "os";
import path from "path";
import {
  EntrantSummary,
  median,
  provenance,
  readRun,
  StandingSample,
  summarize,
  summarizeEntrants,
  SummaryGame,
  SummarySeat,
  summaryTable,
  wilson,
} from "../../src/agent/arena/Summary";

// Hand-made results: only the fields the summary reads.

const standing = (
  minute: number,
  share: number,
  rank: number,
  medianNationShare: number,
  top: number | null,
): StandingSample => ({
  minute,
  share,
  rank,
  medianNationShare,
  topNation: top === null ? null : { name: "Finland", share: top },
});

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

const game = (s: SummarySeat, ticks = 36000): SummaryGame => ({
  ticks,
  gameMinutes: ticks / 600,
  seats: [s],
});

const rows = (games: SummaryGame[]) => games.map((r) => ({ r, seat: 0 }));

describe("summarize", () => {
  test("milestone metrics from standings", () => {
    const games = [
      // Above the median and the top nation at 3, top 3 at 10, alive at 60.
      game(
        seat({
          standings: [
            standing(3, 0.05, 1, 0.01, 0.04),
            standing(10, 0.1, 2, 0.01, 0.12),
          ],
        }),
      ),
      // Above the median only, 4th at 10, out at minute 15.
      game(
        seat({
          result: "loss",
          eliminatedAtTick: 9000,
          standings: [
            standing(3, 0.02, 4, 0.01, 0.04),
            standing(10, 0.03, 4, 0.01, 0.1),
            standing(15, 0, 30, 0.01, 0.2),
          ],
        }),
        9000,
      ),
      // Out at 2.5 minutes and the game stopped: behind at 3 and 10.
      game(
        seat({ result: "loss", eliminatedAtTick: 1500, standings: [] }),
        1500,
      ),
      // Won in 8 minutes: ahead at 10 though never sampled there.
      game(
        seat({
          result: "win",
          standings: [standing(3, 0.2, 1, 0.01, 0.1)],
        }),
        4800,
      ),
      // Recorded before standings existed: unknown, not a failure.
      game(seat({ standings: undefined }), 36000),
      // Capped at 5 minutes: minute 10 and minute 20 unknown.
      game(seat({ standings: [standing(3, 0.001, 20, 0.01, 0.04)] }), 3000),
    ];
    const s = summarize("x", rows(games), 1);
    expect(s.games).toBe(6);
    expect(s.crashed).toBe(1);
    expect(s.wins).toBe(1);
    // Minute 3 is known in 5 games: above the median in 3, above the top in 2.
    expect(s.m3Games).toBe(5);
    expect(s.m3AboveMedian).toBeCloseTo(3 / 5);
    expect(s.m3AboveTop).toBeCloseTo(2 / 5);
    // Minute 10 is known in 4: top 3 in the first and the won game.
    expect(s.top3At10Games).toBe(4);
    expect(s.top3At10).toBeCloseTo(2 / 4);
    // Out before 20 minutes: known in all but the 5-minute cap.
    expect(s.eliminatedBefore20Games).toBe(5);
    expect(s.eliminatedBefore20).toBeCloseTo(2 / 5);
    expect(s.medianWinMinutes).toBe(8);
    expect(s.eliminated).toBe(2);
    expect(s.meanSurvivalMinutes).toBeCloseTo((15 + 2.5) / 2);
  });

  test("no nation counts as above the top; nothing known is null", () => {
    const alone = game(seat({ standings: [standing(3, 0.3, 1, 0, null)] }));
    expect(summarize("x", rows([alone]), 0)).toMatchObject({
      m3AboveTop: 1,
      m3AboveMedian: 1,
      m3Games: 1,
    });
    const old = summarize(
      "old",
      rows([game(seat({ standings: undefined }))]),
      0,
    );
    expect(old).toMatchObject({
      m3AboveMedian: null,
      m3AboveTop: null,
      m3Games: 0,
      top3At10: null,
      top3At10Games: 0,
      medianWinMinutes: null,
      // Survival does not need standings.
      eliminatedBefore20: 0,
      eliminatedBefore20Games: 1,
    });
    const empty = summarize("none", [], 0);
    expect(empty.winRate).toBe(0);
    expect(empty.winRate95).toEqual([0, 1]);
    expect(empty.m3AboveMedian).toBeNull();
  });

  test("the table shows rates with their counts, and unknowns", () => {
    const known = summarize(
      "a",
      rows([
        game(
          seat({
            standings: [
              standing(3, 0.05, 1, 0.01, 0.04),
              standing(10, 0.05, 3, 0.01, 0.06),
            ],
          }),
        ),
        // Won before minute 3 was sampled.
        game(seat({ result: "win", standings: [] }), 1500),
      ]),
      0,
    );
    const unknown = summarize(
      "b",
      rows([game(seat({ standings: undefined }))]),
      0,
    );
    const table = summaryTable([known, unknown]).split("\n");
    expect(table).toHaveLength(4);
    const cells = (line: string) =>
      line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
    const header = cells(table[0]);
    const col = (row: string[], name: string) => row[header.indexOf(name)];
    const a = cells(table[2]);
    const b = cells(table[3]);
    expect(header).toContain("≥ median @3");
    expect(col(a, "≥ median @3")).toBe("100.0% of 2");
    expect(col(a, "≥ top @3")).toBe("100.0% of 2");
    expect(col(a, "top 3 @10")).toBe("100.0% of 2");
    expect(col(a, "win time")).toBe("2.5 min");
    expect(col(b, "≥ top @3")).toBe("–");
    expect(col(b, "win time")).toBe("–");
    expect(col(b, "out < 20 min")).toBe("0.0% of 1");
  });

  test("entrants: their own copies, or seat i of a --together game", () => {
    const two = (a: number, b: number): SummaryGame => ({
      ticks: 600,
      gameMinutes: 1,
      seats: [seat({ peakShare: a }), seat({ peakShare: b })],
    });
    const [x, y] = summarizeEntrants(
      ["x", "y"],
      [
        { ...game(seat({ peakShare: 0.1 })), entrant: 0 },
        { ...game(seat({ peakShare: 0.3 })), entrant: 1 },
        { ...game(seat({ peakShare: 0.2 })), entrant: 0 },
        { ...two(0.4, 0.5), entrant: null },
      ],
      [{ entrant: 1 }, { entrant: null }],
    );
    expect(x).toMatchObject<Partial<EntrantSummary>>({
      label: "x",
      games: 3,
      crashed: 1,
    });
    expect(x.meanPeakShare).toBeCloseTo((0.1 + 0.2 + 0.4) / 3);
    expect(y).toMatchObject({ label: "y", games: 2, crashed: 2 });
    expect(y.meanPeakShare).toBeCloseTo((0.3 + 0.5) / 2);
  });
});

test("wilson and median", () => {
  const [lo, hi] = wilson(5, 10);
  expect(lo).toBeCloseTo(0.2366, 3);
  expect(hi).toBeCloseTo(0.7634, 3);
  expect(wilson(0, 20)[0]).toBe(0);
  expect(median([])).toBeNull();
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

describe("readRun", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-run-"));
    fs.mkdirSync(path.join(dir, "games"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writeGame = (index: number, extra: Record<string, unknown> = {}) =>
    fs.writeFileSync(
      path.join(dir, "games", `game${String(index).padStart(3, "0")}.json`),
      JSON.stringify({
        index,
        gameID: `G${index >> 1}`,
        map: "World",
        ticks: 600,
        gameMinutes: 1,
        seats: [seat({ standings: undefined })],
        ...extra,
      }),
    );
  const writeSummary = (summary: Record<string, unknown>) =>
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary));

  test("loads a run from before M1, deriving game and entrant", () => {
    for (const i of [3, 0, 2]) writeGame(i);
    fs.writeFileSync(path.join(dir, "games", "game000.log"), "## baseline");
    writeSummary({
      config: { entrants: ["baseline", "idle"], together: false, seed: "s" },
      wallSeconds: 1,
      summaries: [],
      games: [{ index: 1, map: "World", gameID: "G0", crash: "boom" }],
    });
    const run = readRun(dir);
    expect(run).toMatchObject({
      commit: null,
      dirty: null,
      suite: null,
      shard: null,
      range: null,
      argv: null,
    });
    expect(run.config?.seed).toBe("s");
    expect(run.games.map((g) => [g.index, g.game, g.entrant])).toEqual([
      [0, 0, 0],
      [2, 1, 0],
      [3, 1, 1],
    ]);
    expect(run.crashes).toEqual([
      {
        index: 1,
        game: 0,
        entrant: 1,
        map: "World",
        gameID: "G0",
        crash: "boom",
      },
    ]);
    const [a, b] = summarizeEntrants(
      run.config!.entrants,
      run.games,
      run.crashes,
    );
    expect([a.games, a.crashed, b.games, b.crashed]).toEqual([2, 0, 1, 1]);
  });

  test("--together games and new fields load as written", () => {
    writeSummary({
      config: { entrants: ["a", "b"], together: true, seed: "s" },
      commit: "abc",
      dirty: false,
      suite: "smoke",
      shard: { index: 1, count: 2 },
      range: null,
      argv: ["--suite", "smoke"],
      games: [],
    });
    writeGame(5);
    writeGame(7, { game: 3, entrant: null });
    const run = readRun(dir);
    expect(run).toMatchObject({
      commit: "abc",
      dirty: false,
      suite: "smoke",
      shard: { index: 1, count: 2 },
      argv: ["--suite", "smoke"],
    });
    expect(run.games.map((g) => [g.index, g.game, g.entrant])).toEqual([
      [5, 5, null],
      [7, 3, null],
    ]);
  });

  test("an unfinished run loads if its games say where they sit", () => {
    writeGame(4, { game: 2, entrant: 0 });
    const run = readRun(dir);
    expect(run.config).toBeNull();
    expect(run.games[0]).toMatchObject({ game: 2, entrant: 0 });
    writeGame(5);
    expect(() => readRun(dir)).toThrow(/does not record its game number/);
    expect(() => readRun(path.join(dir, "games"))).toThrow(/not an arena/);
  });
});

test("provenance names the commit, or null without git", () => {
  const root = path.join(__dirname, "../..");
  const p = provenance(root);
  expect(p.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(typeof p.dirty).toBe("boolean");
  expect(provenance(os.tmpdir())).toEqual({ commit: null, dirty: null });
});
