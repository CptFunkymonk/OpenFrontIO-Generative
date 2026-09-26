import fs from "fs";
import os from "os";
import path from "path";
import { makeSpecs, parseArgs, selectJobs } from "../../src/agent/arena/Arena";
import { provenance, StoredSeat } from "../../src/agent/arena/Summary";
import {
  compareScores,
  ConfigScore,
  halvingSchedule,
  parseConfigs,
  parseTuneArgs,
  PlayRound,
  rankAll,
  rankingTable,
  rankScores,
  RoundPlan,
  runTune,
  scoreConfig,
  TuneReport,
} from "../../src/agent/arena/Tune";
import { COMMIT, seat, writeRun } from "./util/SyntheticRuns";

// Successive halving: the schedule of rounds and game ranges, the ranking
// that decides who goes on, the config file, and whole tunes played on
// made-up results directories whose jobs come from the arena itself.

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arena-tune-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const round = (
  r: number,
  configs: number,
  from: number,
  to: number,
  keep: number,
  final = false,
): RoundPlan => ({ round: r, configs, from, to, keep, final });

describe("the halving schedule", () => {
  test("16 configs, eta 2, 8 start games over a 32-game suite", () => {
    const plan = halvingSchedule(16, 32, 8, 2);
    expect(plan).toEqual([
      round(1, 16, 0, 8, 8),
      round(2, 8, 8, 16, 4),
      round(3, 4, 16, 32, 4, true),
    ]);
    // 128 + 64 + 64 games instead of 16 × 32 = 512.
    expect(plan.reduce((a, r) => a + r.configs * (r.to - r.from), 0)).toBe(256);
  });

  test("the arena's --range plays each round's new games of quick", () => {
    const agents = (n: number) =>
      Array.from({ length: n }, (_, i) => [
        "--agent",
        `baseline:{"expandTrigger":${i / 100}}`,
      ]).flat();
    const full = parseArgs(["--suite", "quick"]);
    const suite = makeSpecs(full).map((j) => [
      j.game,
      j.spec.map,
      j.spec.gameID,
    ]);
    expect(suite).toHaveLength(32);

    const seen: (string | number)[][] = [];
    for (const r of halvingSchedule(16, 32, 8, 2)) {
      const o = parseArgs([
        ...["--suite", "quick", ...agents(r.configs)],
        ...["--range", `${r.from}:${r.to}`],
      ]);
      const jobs = selectJobs(o, makeSpecs(o));
      expect(jobs).toHaveLength(r.configs * (r.to - r.from));
      // Every surviving config gets each new game, and game g is the same
      // map and game id whatever the entrants, so earlier rounds stay valid.
      for (let e = 0; e < r.configs; e++) {
        const mine = jobs.filter((j) => j.entrant === e);
        expect(mine.map((j) => [j.game, j.spec.map, j.spec.gameID])).toEqual(
          suite.slice(r.from, r.to),
        );
      }
      seen.push(
        ...jobs
          .filter((j) => j.entrant === 0)
          .map((j) => [j.game, j.spec.map, j.spec.gameID]),
      );
    }
    expect(seen).toEqual(suite);
  });

  test("the finalists play the rest of the suite", () => {
    // The tiny real tune: 3 configs over 4 games from 2.
    expect(halvingSchedule(3, 4, 2, 2)).toEqual([
      round(1, 3, 0, 2, 2),
      round(2, 2, 2, 4, 2, true),
    ]);
    // dev: the last two play games 32-253 rather than one being cut at 32.
    expect(halvingSchedule(16, 254, 8, 2)).toEqual([
      round(1, 16, 0, 8, 8),
      round(2, 8, 8, 16, 4),
      round(3, 4, 16, 32, 2),
      round(4, 2, 32, 254, 2, true),
    ]);
    // eta 3: nine configs, three after one round, and those are finalists.
    expect(halvingSchedule(9, 32, 4, 3)).toEqual([
      round(1, 9, 0, 4, 3),
      round(2, 3, 4, 32, 3, true),
    ]);
    // A non-integer eta rounds the game counts and the cuts up.
    expect(halvingSchedule(10, 100, 4, 2.5)).toEqual([
      round(1, 10, 0, 4, 4),
      round(2, 4, 4, 10, 2),
      round(3, 2, 10, 100, 2, true),
    ]);
    // More start games than the suite has: one round, everyone a finalist.
    expect(halvingSchedule(5, 4, 8, 2)).toEqual([round(1, 5, 0, 4, 5, true)]);
    expect(halvingSchedule(1, 10, 2, 2)).toEqual([round(1, 1, 0, 10, 1, true)]);
    expect(halvingSchedule(2, 10, 2, 2)).toEqual([round(1, 2, 0, 10, 2, true)]);
  });

  test("every schedule covers the suite once, halving as it goes", () => {
    for (const configs of [1, 2, 3, 5, 8, 16, 17, 64]) {
      for (const games of [1, 4, 32, 254]) {
        for (const start of [1, 2, 8, 40]) {
          for (const eta of [2, 3, 4]) {
            const plan = halvingSchedule(configs, games, start, eta);
            expect(plan[0].from).toBe(0);
            expect(plan[0].configs).toBe(configs);
            expect(plan[plan.length - 1].to).toBe(games);
            plan.forEach((r, i) => {
              expect(r.round).toBe(i + 1);
              expect(r.to).toBeGreaterThan(r.from);
              expect(r.final).toBe(i === plan.length - 1);
              if (i > 0) {
                expect(r.from).toBe(plan[i - 1].to);
                expect(r.configs).toBe(plan[i - 1].keep);
              }
              if (r.final) {
                expect(r.keep).toBe(r.configs);
              } else {
                // Every cut halves (or better) and leaves at least two.
                expect(r.keep).toBe(Math.ceil(r.configs / eta));
                expect(r.keep).toBeGreaterThanOrEqual(2);
                expect(r.to).toBe(Math.ceil(start * eta ** i));
              }
            });
          }
        }
      }
    }
  });

  test("bad arguments", () => {
    expect(() => halvingSchedule(0, 32, 8, 2)).toThrow(/at least one config/);
    expect(() => halvingSchedule(4, 0, 8, 2)).toThrow(/no games/);
    expect(() => halvingSchedule(4, 32, 0, 2)).toThrow(/--start-games/);
    expect(() => halvingSchedule(4, 32, 8, 1.5)).toThrow(/--eta/);
    expect(() => halvingSchedule(4, 32, 8, NaN)).toThrow(/--eta/);
  });
});

describe("ranking", () => {
  type Seat = Partial<StoredSeat>;
  const peak = (peakShare: number): Seat => ({ peakShare });
  const won = (peakShare: number): Seat => ({ result: "win", peakShare });
  const score = (config: number, ...seats: Seat[]): ConfigScore =>
    scoreConfig(
      config,
      `c${config}`,
      seats.map((s) => ({
        r: { ticks: 36000, gameMinutes: 60, seats: [seat("baseline", 0, s)] },
        seat: 0,
      })),
      0,
    );
  const order = (scores: ConfigScore[]) =>
    rankScores(scores).map((s) => s.config);

  test("mean progress, then wins, then peak land, then file order", () => {
    // Progress 0.5 and 0.25.
    const better = score(3, peak(0.4), peak(0.4));
    const worse = score(0, peak(0.2), peak(0.2));
    expect(better.summary.meanProgress).toBe(0.5);
    expect(order([worse, better])).toEqual([3, 0]);
    expect(compareScores(better, worse)).toBeLessThan(0);

    // Both 0.5: a win and nothing against two games at half the bar.
    const winner = score(5, won(0.85), peak(0));
    const steady = score(1, peak(0.4), peak(0.4));
    expect(winner.summary.meanProgress).toBe(steady.summary.meanProgress);
    expect(order([steady, winner])).toEqual([5, 1]);

    // Progress caps at 0.99 below a win: equal, and no wins, so peak land.
    const high = score(4, peak(0.9), peak(0.9));
    const lower = score(2, peak(0.8), peak(0.8));
    expect(high.summary.meanProgress).toBe(lower.summary.meanProgress);
    expect(order([lower, high])).toEqual([4, 2]);
    // Two wins tie on progress and wins; peak land decides.
    expect(order([score(0, won(0.81)), score(1, won(0.95))])).toEqual([1, 0]);

    // Nothing to tell apart: the config file's order.
    expect(order([score(7, peak(0.1)), score(6, peak(0.1))])).toEqual([6, 7]);
    expect(
      order([worse, lower, winner, better, high, steady].reverse()),
    ).toEqual([4, 2, 5, 1, 3, 0]);
  });

  test("wins count as a rate, so a crashed game is not a loss", () => {
    // One game won and one crashed, against two won: the same progress and
    // win rate, so peak land decides.
    const crashedOnce = scoreConfig(
      1,
      "c1",
      [
        {
          r: { ticks: 1, gameMinutes: 1, seats: [seat("b", 0, won(0.9))] },
          seat: 0,
        },
      ],
      1,
    );
    const wonBoth = score(0, won(0.8), won(0.8));
    expect(crashedOnce.summary.crashed).toBe(1);
    expect(wonBoth.summary.wins).toBe(2);
    expect(order([wonBoth, crashedOnce])).toEqual([1, 0]);
  });

  test("the whole tune: later rounds first, then the score", () => {
    const e = (config: number, out: number | null, p: number) => ({
      score: score(config, peak(p)),
      out,
    });
    // Cut in round 1 with the best mean over 8 games still ranks below
    // those that went on: they were better on those same 8 games.
    const ranked = rankAll([
      e(0, 1, 0.5),
      e(1, null, 0.2),
      e(2, 2, 0.3),
      e(3, null, 0.25),
      e(4, 1, 0.1),
      e(5, 2, 0.35),
    ]);
    expect(ranked.map((x) => x.score.config)).toEqual([3, 1, 5, 2, 0, 4]);
  });
});

describe("the config file", () => {
  test("strings, name:JSON and objects", () => {
    expect(
      parseConfigs(
        [
          "baseline",
          'baseline:{"expandTrigger":0.25}',
          {
            agent: "baseline",
            options: { expandReserve: 0.1 },
            label: "low reserve",
          },
          { agent: "baseline", options: { expandReserve: 0.1, thinkEvery: 3 } },
          { agent: "idle" },
        ],
        "sweep.json",
      ),
    ).toEqual([
      { label: "baseline", agent: "baseline", options: null, arg: "baseline" },
      {
        label: 'baseline:{"expandTrigger":0.25}',
        agent: "baseline",
        options: { expandTrigger: 0.25 },
        arg: 'baseline:{"expandTrigger":0.25}',
      },
      {
        label: "low reserve",
        agent: "baseline",
        options: { expandReserve: 0.1 },
        arg: 'baseline:{"expandReserve":0.1}',
      },
      {
        label: 'baseline:{"expandReserve":0.1,"thinkEvery":3}',
        agent: "baseline",
        options: { expandReserve: 0.1, thinkEvery: 3 },
        arg: 'baseline:{"expandReserve":0.1,"thinkEvery":3}',
      },
      { label: "idle", agent: "idle", options: null, arg: "idle" },
    ]);
    // Empty options are the defaults; spaces in the JSON are normalized.
    expect(parseConfigs(['baseline:{ "expandTrigger": 0.3 }'], "f")[0]).toEqual(
      {
        label: 'baseline:{"expandTrigger":0.3}',
        agent: "baseline",
        options: { expandTrigger: 0.3 },
        arg: 'baseline:{"expandTrigger":0.3}',
      },
    );
    expect(parseConfigs(["baseline:{}"], "f")[0].arg).toBe("baseline");
  });

  test("mistakes are refused before any game is played", () => {
    const bad = (list: unknown) => () => parseConfigs(list, "sweep.json");
    expect(bad({})).toThrow(/sweep.json: expected a non-empty JSON list/);
    expect(bad([])).toThrow(/non-empty/);
    expect(bad([7])).toThrow(/sweep.json\[0\]: a config is/);
    expect(bad(["baseline", "nope"])).toThrow(
      /sweep.json\[1\]: unknown agent "nope". Available: baseline, idle/,
    );
    expect(bad(["baseline:{bad"])).toThrow(/bad options JSON/);
    expect(bad(["baseline:[1]"])).toThrow(/options must be a JSON object/);
    expect(bad([{ agent: "baseline", option: {} }])).toThrow(
      /unknown field\(s\) option/,
    );
    expect(bad([{ agent: "baseline", label: "" }])).toThrow(/label/);
    // A typo or a wrong type would silently tune the default.
    expect(bad(['baseline:{"expandTriger":0.2}'])).toThrow(
      /baseline has no option "expandTriger" \(it has thinkEvery, /,
    );
    expect(bad(['baseline:{"constructor":1}'])).toThrow(/no option/);
    expect(bad(['baseline:{"expandTrigger":"0.2"}'])).toThrow(
      /option "expandTrigger" is a number, got "0.2"/,
    );
    // The same entrant twice, whatever the key order or label.
    expect(
      bad([
        'baseline:{"expandTrigger":0.2,"expandReserve":0.1}',
        {
          agent: "baseline",
          options: { expandReserve: 0.1, expandTrigger: 0.2 },
          label: "again",
        },
      ]),
    ).toThrow(/configs 0 and 1 are the same/);
    expect(bad(["baseline", "baseline:{}"])).toThrow(/configs 0 and 1/);
    expect(
      bad([
        { agent: "baseline", label: "x" },
        { agent: "idle", label: "x" },
      ]),
    ).toThrow(/share the label "x"/);
  });
});

describe("the command line", () => {
  const configsFile = () => {
    const f = path.join(tmp, "sweep.json");
    fs.writeFileSync(
      f,
      JSON.stringify(["baseline", 'baseline:{"expandTrigger":0.25}']),
    );
    return f;
  };

  test("quick unless the flags choose the games", () => {
    const f = configsFile();
    const t = parseTuneArgs(["--configs", f]);
    expect(t.arenaArgs).toEqual(["--suite", "quick"]);
    expect([t.suite, t.seed, t.totalGames]).toEqual(["quick", "quick", 32]);
    expect([t.startGames, t.eta]).toEqual([8, 2]);
    expect(t.configs.map((c) => c.arg)).toEqual([
      "baseline",
      'baseline:{"expandTrigger":0.25}',
    ]);
    expect(path.basename(t.out)).toMatch(/^tune-quick-\d{4}-/);

    // Another seed or cap still plays quick's maps.
    const s = parseTuneArgs(["--configs", f, "--seed", "x", "--jobs", "2"]);
    expect(s.arenaArgs).toEqual([
      "--suite",
      "quick",
      "--seed",
      "x",
      "--jobs",
      "2",
    ]);
    expect([s.suite, s.seed, s.totalGames]).toEqual(["quick", "x", 32]);

    // Maps given: no suite, so none is recorded that was not played.
    const own = [
      ...["--maps", "Onion,Iceland", "--each-map", "--repeat", "2"],
      ...["--seed", "tune-test", "--max-minutes", "2"],
    ];
    const m = parseTuneArgs([
      ...["--configs", f, ...own, "--start-games", "2", "--eta", "3"],
      ...["--out", path.join(tmp, "t")],
    ]);
    expect(m.arenaArgs).toEqual(own);
    expect([m.suite, m.seed, m.totalGames]).toEqual([null, "tune-test", 4]);
    expect([m.startGames, m.eta, m.out]).toEqual([2, 3, path.join(tmp, "t")]);
    expect(parseTuneArgs(["--configs", f, "--suite", "smoke"]).totalGames).toBe(
      4,
    );
    expect(parseTuneArgs(["--configs", f, "--games", "5"]).suite).toBeNull();
  });

  test("refusals", () => {
    const f = configsFile();
    expect(() => parseTuneArgs([])).toThrow(/--configs FILE.json is required/);
    for (const flag of ["--agent", "--range", "--shard", "--game", "--from"]) {
      expect(() => parseTuneArgs(["--configs", f, flag, "x"])).toThrow(
        `${flag}: the tune sets it`,
      );
    }
    expect(() => parseTuneArgs(["--configs", f, "--together"])).toThrow(
      /the tune sets it/,
    );
    expect(() => parseTuneArgs(["--configs", f, "--eta", "1"])).toThrow(
      /--eta/,
    );
    expect(() => parseTuneArgs(["--configs", f, "--start-games", "0"])).toThrow(
      /--start-games/,
    );
    // The arena checks the rest.
    expect(() => parseTuneArgs(["--configs", f, "--bogus"])).toThrow(
      /unknown argument "--bogus"/,
    );
    expect(() => parseTuneArgs(["--configs", f, "--maps", "Nowhere"])).toThrow(
      /unknown map/,
    );
    expect(() =>
      parseTuneArgs(["--configs", path.join(tmp, "missing.json")]),
    ).toThrow(/--configs .*missing.json/);
  });
});

describe("a whole tune", () => {
  // Five configs, better the higher expandTrigger; config 4 also wins game 0
  // and config 0's first game crashes. 8 games from 2 with eta 2: rounds of
  // 5, 3 and 2 configs on games 0-1, 2-3 and 4-7.
  const TRIGGERS = [0.1, 0.2, 0.3, 0.4, 0.5];
  const writeConfigs = (triggers: number[]) => {
    const f = path.join(tmp, "sweep.json");
    fs.writeFileSync(
      f,
      JSON.stringify(triggers.map((x) => `baseline:{"expandTrigger":${x}}`)),
    );
    return f;
  };
  const tuneArgs = (f: string) => [
    ...["--configs", f, "--start-games", "2", "--out", path.join(tmp, "t")],
    ...["--maps", "Onion,Iceland", "--each-map", "--repeat", "4"],
    ...["--seed", "tune-test"],
  ];
  // Rounds as if played on this checkout, so none is warned of as stale.
  const checkout = provenance(path.join(__dirname, "../.."));
  const played: string[][] = [];
  const play: PlayRound = async (argv, dir) => {
    played.push(argv);
    const range = argv[argv.indexOf("--range") + 1];
    writeRun(dir, argv, {
      seat: (job) => {
        const x = job.spec.seats[0].options!.expandTrigger as number;
        return x === 0.5 && job.game === 0
          ? { result: "win", peakShare: 0.8 }
          : { peakShare: x / 2 + job.game / 1000 };
      },
      crash: range === "0:2" ? [0] : [],
      ...checkout,
    });
  };
  const quiet = () => {};
  const withoutTimes = (r: TuneReport) => ({
    ...r,
    wallSeconds: 0,
    rounds: r.rounds.map((x) => ({ ...x, reused: false, wallSeconds: 0 })),
  });
  beforeEach(() => (played.length = 0));

  test("halves on progress and ranks every config", async () => {
    const t = parseTuneArgs(tuneArgs(writeConfigs(TRIGGERS)));
    const report = await runTune(t, play, quiet);

    const agentsOf = (argv: string[]) =>
      argv.flatMap((a, i) => (argv[i - 1] === "--agent" ? [a] : []));
    const trig = (x: number) => `baseline:{"expandTrigger":${x}}`;
    expect(played.map((a) => a[a.indexOf("--range") + 1])).toEqual([
      "0:2",
      "2:4",
      "4:8",
    ]);
    expect(played.map(agentsOf)).toEqual([
      TRIGGERS.map(trig),
      [0.3, 0.4, 0.5].map(trig),
      [0.4, 0.5].map(trig),
    ]);
    expect(played[1].slice(0, 7)).toEqual(t.arenaArgs);
    expect(played[1][played[1].length - 1]).toBe(
      path.join(tmp, "t", "round-2"),
    );

    expect(report.done).toBe(true);
    expect(
      report.ranking.map((c) => [c.label, c.games, c.wins, c.crashed, c.out]),
    ).toEqual([
      [trig(0.5), 8, 1, 0, null],
      [trig(0.4), 8, 0, 0, null],
      [trig(0.3), 4, 0, 0, 2],
      [trig(0.2), 2, 0, 0, 1],
      [trig(0.1), 1, 0, 1, 1],
    ]);
    expect(report.ranking.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5]);
    // 0.4: peak 0.2 + g/1000 over games 0-7, progress ÷ 0.8.
    const second = report.ranking[1];
    expect(second.meanProgress).toBeCloseTo((0.2 + 0.0035) / 0.8, 12);
    expect(second.progress95![0]).toBeLessThanOrEqual(second.meanProgress);
    expect(second.progress95![1]).toBeGreaterThanOrEqual(second.meanProgress);
    expect(second.m3AboveMedian).toBeNull();
    expect(report.rounds.map((r) => r.standings.map((s) => s.kept))).toEqual([
      [true, true, true, false, false],
      [true, true, false],
      [true, true],
    ]);
    // The crash is accounted for, so only it is warned of.
    expect(report.warnings).toEqual([
      "round 1: 1 game(s) crashed; the configs are ranked on the games they played",
    ]);

    // tune.json is the report; tune.md has the table.
    const json = JSON.parse(
      fs.readFileSync(path.join(t.out, "tune.json"), "utf8"),
    ) as TuneReport;
    expect(json.ranking).toEqual(report.ranking);
    const md = fs.readFileSync(path.join(t.out, "tune.md"), "utf8");
    expect(md).toContain(rankingTable(report));
    expect(md).toContain(`| 1 | ${trig(0.5)} | 8 | 1 | `);
    expect(md).toMatch(/\| 5 \| .*0\.1.* \| 1 \| 0 \| .* \| 1 \|$/m);
    expect(md).toContain("| finalist |");
    expect(md).toContain("3. games 4–7 (4 new): 2 finalists");
    expect(md).toContain(
      `npm run arena -- --suite dev --agent '${trig(0.5)}' --agent '${trig(0.4)}'`,
    );
  });

  test("a rerun reads finished rounds back; another tune is refused", async () => {
    const f = writeConfigs(TRIGGERS);
    const first = await runTune(parseTuneArgs(tuneArgs(f)), play, quiet);
    expect(played).toHaveLength(3);

    // Same command, more jobs: nothing is played again.
    const noPlay: PlayRound = () => Promise.reject(new Error("played"));
    const again = await runTune(
      parseTuneArgs([...tuneArgs(f), "--jobs", "3"]),
      noPlay,
      quiet,
    );
    expect(again.rounds.every((r) => r.reused)).toBe(true);
    expect(withoutTimes(again)).toEqual({
      ...withoutTimes(first),
      arenaArgs: [...first.arenaArgs, "--jobs", "3"],
    });

    // Interrupted in round 3: that round is played again once removed.
    fs.rmSync(path.join(tmp, "t", "round-3", "summary.json"));
    await expect(
      runTune(parseTuneArgs(tuneArgs(f)), noPlay, quiet),
    ).rejects.toThrow(/round-3 holds an unfinished arena run/);
    fs.rmSync(path.join(tmp, "t", "round-3"), { recursive: true });
    played.length = 0;
    await runTune(parseTuneArgs(tuneArgs(f)), play, quiet);
    expect(played.map((a) => a[a.indexOf("--range") + 1])).toEqual(["4:8"]);

    // A round read back from other code than the checkout is warned of.
    const round1 = path.join(tmp, "t", "round-1", "summary.json");
    fs.writeFileSync(
      round1,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(round1, "utf8")),
        commit: COMMIT,
        dirty: false,
      }),
    );
    const stale = await runTune(parseTuneArgs(tuneArgs(f)), noPlay, quiet);
    expect(stale.warnings[stale.warnings.length - 1]).toMatch(
      /^round\(s\) 1 \(0123456\) ran on other code than the checkout/,
    );
    expect(stale.ranking).toEqual(first.ranking);

    // Other configs into the same directory are refused, not mixed in.
    await expect(
      runTune(
        parseTuneArgs(tuneArgs(writeConfigs([0.1, 0.2, 0.3, 0.4, 0.6]))),
        play,
        quiet,
      ),
    ).rejects.toThrow(/round-1 holds another arena run than this round's/);
  });
});
