import fs from "fs";
import os from "os";
import path from "path";
import { makeSpecs, parseArgs, selectJobs } from "../../src/agent/arena/Arena";
import { mergeRuns, ranges } from "../../src/agent/arena/Merge";
import { readRun, SummaryFile } from "../../src/agent/arena/Summary";
import { COMMIT, writeRun } from "./util/SyntheticRuns";

// Joining the parts of one run: the merged directory must read back as the
// run played in one session, and parts of different runs must be refused.

// 2 entrants × 6 games, so 12 jobs; entrant 1 wins game 4, entrant 0 is out
// in game 1, and every seat has standings at minute 3.
const RUN = [
  ...["--agent", "baseline", "--agent", "idle"],
  ...["--maps", "Onion,Iceland,World", "--games", "6", "--seed", "merge"],
];
const sketch = {
  seat: (job: { game: number; entrant: number }) => ({
    result:
      job.entrant === 1 && job.game === 4
        ? ("win" as const)
        : job.entrant === 0 && job.game === 1
          ? ("loss" as const)
          : ("timeout" as const),
    eliminatedAtTick: job.entrant === 0 && job.game === 1 ? 3000 : null,
    peakShare: 0.01 * (job.game + 1) + 0.1 * job.entrant,
    standings: [
      {
        minute: 3,
        tick: 1800,
        share: 0.01 * job.game,
        rank: 1 + job.game,
        players: 5,
        nationsAlive: 4,
        medianNationShare: 0.02,
        topNation: { name: "Finland", share: 0.04 },
      },
    ],
  }),
  images: (job: { spec: { index: number } }) => {
    const f = `game${String(job.spec.index).padStart(3, "0")}`;
    return [`${f}-t600.png`, `${f}-final.png`];
  },
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arena-merge-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const dir = (name: string) => path.join(tmp, name);
const readSummary = (d: string) =>
  JSON.parse(fs.readFileSync(path.join(d, "summary.json"), "utf8")) as Omit<
    SummaryFile,
    "argv"
  > & { argv?: string[]; missingGames: number[] };

test("two shards merge into the run played unsharded", () => {
  const whole = writeRun(dir("whole"), RUN, sketch);
  writeRun(dir("s0"), [...RUN, "--shard", "0/2", "--jobs", "3"], sketch);
  writeRun(dir("s1"), [...RUN, "--shard", "1/2"], sketch);
  const { summary, warnings } = mergeRuns(
    [dir("s1"), dir("s0")],
    dir("merged"),
  );
  expect(warnings).toEqual([]);

  const merged = readSummary(dir("merged"));
  expect(merged).toEqual(JSON.parse(JSON.stringify(summary)));
  expect(merged.summaries).toEqual(whole.summaries);
  expect(merged.games).toEqual(whole.games);
  expect(merged.config).toEqual({ ...whole.config, out: dir("merged") });
  expect(merged).toMatchObject({
    commit: COMMIT,
    dirty: false,
    suite: null,
    shard: null,
    range: null,
    missingGames: [],
  });
  // The command line of the whole run, without where and which parts ran.
  expect(merged.argv).toEqual(RUN);
  expect(merged.summaries[1]).toMatchObject({ label: "idle", wins: 1 });

  // Game files read back as the whole run's, frames beside them.
  const back = readRun(dir("merged"));
  const ref = readRun(dir("whole"));
  const noImages = (r: typeof back) =>
    r.games.map(({ images, ...g }) => ({ ...g, images: images.length }));
  expect(noImages(back)).toEqual(noImages(ref));
  for (const g of back.games) {
    for (const f of g.images) {
      expect(path.dirname(f)).toBe(path.join(dir("merged"), "images"));
      expect(fs.readFileSync(f, "utf8")).toBe(`png of ${path.basename(f)}`);
    }
    const log = path.join(
      dir("merged"),
      "games",
      `game${String(g.index).padStart(3, "0")}.log`,
    );
    expect(fs.existsSync(log)).toBe(true);
  }
  expect(fs.readdirSync(path.join(dir("merged"), "images"))).toHaveLength(24);
  expect(
    fs.readFileSync(path.join(dir("merged"), "summary.md"), "utf8"),
  ).toMatch(
    /merged from 2 parts[\s\S]*\| baseline \| 6 \|[\s\S]*shard 1\/2, 6 game file/,
  );

  // --from the merged run replays any of its games.
  const o = parseArgs(["--from", dir("merged"), "--game", "9"]);
  const [job] = selectJobs(o, makeSpecs(o));
  expect(o.shard).toBeNull();
  expect(job.spec.gameID).toBe(back.games[9].gameID);
  expect(job.spec.map).toBe(back.games[9].map);
});

test("a crash gives way to a rerun of it; missing games are reported", () => {
  writeRun(dir("s0"), [...RUN, "--shard", "0/3"], { ...sketch, crash: [6] });
  writeRun(dir("s1"), [...RUN, "--shard", "1/3"], { ...sketch, crash: [3] });
  // Rerun with frames a minute, as --help suggests for a look at a game.
  writeRun(
    dir("rerun"),
    [...RUN, "--game", "6", "--images", "--image-every", "1"],
    sketch,
  );
  const { summary, warnings } = mergeRuns(
    [dir("s0"), dir("s1"), dir("rerun")],
    dir("merged"),
  );
  // Games 2 and 5 were in shard 2/3, which is not merged.
  expect(summary.missingGames).toEqual([2, 5]);
  expect(warnings).toEqual([
    expect.stringMatching(/^the parts wrote different images/),
    "no part played 2 of the run's 6 games: g 2, 5",
    expect.stringMatching(/^1 job\(s\) crashed: 3 /),
  ]);
  const byIndex = new Map(summary.games.map((g) => [g.index, g]));
  expect("crash" in byIndex.get(6)!).toBe(false);
  expect("crash" in byIndex.get(3)!).toBe(true);
  expect([...byIndex.keys()]).toEqual([0, 1, 2, 3, 6, 7, 8, 9]);
  expect(
    summary.mergedFrom.map((m) => [m.games, m.crashes, m.onlyGame]),
  ).toEqual([
    [3, 0, null],
    [3, 1, null],
    [1, 0, 6],
  ]);
  expect(summary.summaries.map((s) => [s.games, s.crashed])).toEqual([
    [4, 0],
    [3, 1],
  ]);
});

test("parts of different runs are refused unless forced", () => {
  writeRun(dir("s0"), [...RUN, "--shard", "0/2"], sketch);
  writeRun(dir("seed"), [...RUN, "--shard", "1/2", "--seed", "other"], sketch);
  writeRun(dir("commit"), [...RUN, "--shard", "1/2"], {
    ...sketch,
    commit: "f".repeat(40),
  });
  writeRun(dir("cap"), [...RUN, "--shard", "1/2", "--max-minutes", "5"], {
    ...sketch,
    dirty: true,
  });
  writeRun(
    dir("entrants"),
    [...RUN, "--shard", "1/2", "--agent", "baseline"],
    sketch,
  );
  const refused = (part: string, why: RegExp) => {
    expect(() => mergeRuns([dir("s0"), dir(part)], dir(`m-${part}`))).toThrow(
      why,
    );
    expect(fs.existsSync(dir(`m-${part}`))).toBe(false);
  };
  refused("seed", /not parts of one run[\s\S]*seed "other"/);
  refused("commit", /commit "fff/);
  refused("cap", /dirty true[\s\S]*maxMinutes 5/);
  refused("entrants", /entrants \["baseline","idle","baseline"\]/);

  const forced = mergeRuns([dir("s0"), dir("commit")], dir("forced"), true);
  expect(forced.warnings[0]).toMatch(/^merged despite: .*commit/);
  expect(forced.summary.commit).toBeNull();
  expect(forced.summary.summaries[0].games).toBe(6);
});

test("a game file in two parts is refused, even forced", () => {
  writeRun(dir("s0"), [...RUN, "--shard", "0/2"], sketch);
  writeRun(dir("again"), [...RUN, "--range", "4:6"], sketch);
  expect(() => mergeRuns([dir("s0"), dir("again")], dir("m"), true)).toThrow(
    /games\/game008\.json is in both/,
  );
  expect(() => mergeRuns([dir("s0"), dir("s0")], dir("m"))).toThrow(
    /given twice/,
  );
  expect(() => mergeRuns([dir("s0")], dir("s0"))).toThrow(/is one of/);
  mergeRuns([dir("s0")], dir("m"));
  expect(() => mergeRuns([dir("again")], dir("m"))).toThrow(
    /already holds a run/,
  );
});

test("a part that never wrote summary.json merges only when forced", () => {
  writeRun(dir("s0"), [...RUN, "--shard", "0/2"], sketch);
  writeRun(dir("s1"), [...RUN, "--shard", "1/2"], sketch);
  fs.rmSync(path.join(dir("s1"), "summary.json"));
  expect(() => mergeRuns([dir("s0"), dir("s1")], dir("m"))).toThrow(
    /s1 has no summary\.json/,
  );
  const { summary } = mergeRuns([dir("s0"), dir("s1")], dir("m"), true);
  expect(summary.games).toHaveLength(12);
  expect(summary.missingGames).toEqual([]);
});

test("ranges", () => {
  expect(ranges([])).toBe("");
  expect(ranges([3])).toBe("3");
  expect(ranges([0, 1, 2, 5, 7, 8])).toBe("0-2, 5, 7-8");
});
