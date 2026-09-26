import fs from "fs";
import os from "os";
import path from "path";
import {
  bootstrapMeanCI,
  compareMarkdown,
  compareRuns,
  entrantLabels,
  pairGames,
  rerunCommand,
  selectEntrant,
  sideGames,
  signTest,
} from "../../src/agent/arena/Compare";
import { mergeRuns } from "../../src/agent/arena/Merge";
import { mean, readRun, Run, StoredSeat } from "../../src/agent/arena/Summary";
import { maps as MAP_INFO } from "../../src/core/game/Game";
import { COMMIT, writeRun } from "./util/SyntheticRuns";

// The paired report: its statistics against known values, pairing by game
// id, entrant selection, and a whole report on made-up results directories
// whose jobs come from the arena itself.

describe("statistics", () => {
  test("exact sign test p-values", () => {
    expect(signTest(0, 10)).toBe(0.001953125);
    expect(signTest(10, 0)).toBe(0.001953125);
    expect(signTest(5, 5)).toBe(1);
    expect(signTest(0, 0)).toBe(1);
    expect(signTest(1, 0)).toBe(1);
    expect(signTest(2, 8)).toBe(0.109375);
    // Against 2 Σ C(n, i) / 2^n computed exactly elsewhere (Python).
    expect(signTest(10, 20)).toBeCloseTo(0.09873714670538902, 15);
    expect(signTest(3, 17)).toBeCloseTo(0.0025768280029296875, 15);
    expect(signTest(400, 600) / 2.7284641560660184e-10).toBeCloseTo(1, 10);
    // Past 2^1024 without overflow.
    expect(signTest(1500, 1300) / 0.0001684116226437612).toBeCloseTo(1, 10);
    expect(signTest(1100, 1100)).toBe(1);
  });

  test("bootstrap: a point for constant differences, the mean covered", () => {
    const constant = Array.from({ length: 37 }, () => 0.1);
    const [lo, hi] = bootstrapMeanCI(constant)!;
    expect(lo).toBe(hi);
    expect(lo).toBe(mean(constant));

    // 1..20: mean 10.5, standard error 1.32, so about 10.5 ± 2.6.
    const sample = Array.from({ length: 20 }, (_, i) => i + 1);
    const ci = bootstrapMeanCI(sample)!;
    expect(ci[0]).toBeLessThan(10.5);
    expect(ci[1]).toBeGreaterThan(10.5);
    expect(ci[0]).toBeCloseTo(7.9, 0);
    expect(ci[1]).toBeCloseTo(13.1, 0);
    // Seeded: the same interval every time, another for another seed.
    expect(bootstrapMeanCI(sample)).toEqual(ci);
    expect(bootstrapMeanCI(sample, 10_000, 7)).not.toEqual(ci);
    expect(bootstrapMeanCI([])).toBeNull();
    expect(bootstrapMeanCI([-0.25])).toEqual([-0.25, -0.25]);
  });
});

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arena-compare-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const dir = (name: string) => path.join(tmp, name);

// Three maps, each twice: g 0-5 on Onion, Iceland, World, Onion, Iceland, World.
const POOL = ["--maps", "Onion,Iceland,World", "--each-map", "--repeat", "2"];

type Seat = Partial<StoredSeat>;
const win: Seat = { result: "win" };
const alive = (peakShare: number): Seat => ({ peakShare });
const out = (tick: number, peakShare: number): Seat => ({
  result: "loss",
  eliminatedAtTick: tick,
  peakShare,
});
const at3 = (share: number): Seat => ({
  standings: [
    {
      minute: 3,
      tick: 1800,
      share,
      rank: 2,
      players: 5,
      nationsAlive: 4,
      medianNationShare: 0.01,
      topNation: { name: "Finland", share: 0.03 },
    },
  ],
});

// A: the champion, one of two entrants. B: the challenger, alone, whose
// worker crashed in game 3.
const A_GAMES: Seat[] = [
  win,
  alive(0.2),
  alive(0.1),
  out(3000, 0.05),
  win,
  alive(0.3),
];
const B_GAMES: Seat[] = [
  alive(0.4),
  win,
  win,
  alive(0.05),
  win,
  { ...out(1200, 0.1), standings: [] },
];
// Game lengths: a win ends the game at minute 20, B's loss at minute 2.
const ticks = (games: Seat[], g: number) =>
  games[g].result === "win"
    ? 12000
    : g === 5 && games === B_GAMES
      ? 1200
      : 36000;

function writePair(): { a: Run; b: Run } {
  writeRun(dir("a"), ["--agent", "baseline", "--agent", "idle", ...POOL], {
    seat: (job) =>
      job.entrant === 0 ? { ...at3(0.02), ...A_GAMES[job.game] } : {},
    ticks: (job) => (job.entrant === 0 ? ticks(A_GAMES, job.game) : 36000),
  });
  writeRun(dir("b"), ["--agent", 'baseline:{"expandTrigger":0.3}', ...POOL], {
    seat: (job) => ({ ...at3(0.04), ...B_GAMES[job.game] }),
    ticks: (job) => ticks(B_GAMES, job.game),
    crash: [3],
    dirty: true,
  });
  return { a: readRun(dir("a")), b: readRun(dir("b")) };
}

describe("entrants and pairing", () => {
  test("a run with several entrants needs one chosen", () => {
    const { a, b } = writePair();
    expect(entrantLabels(a)).toEqual(["baseline", "idle"]);
    expect(selectEntrant(entrantLabels(b), null, "--entrant-b")).toBe(0);
    expect(() => selectEntrant(entrantLabels(a), null, "--entrant-a")).toThrow(
      /2 entrants \(0: baseline, 1: idle\): choose one with --entrant-a/,
    );
    expect(selectEntrant(entrantLabels(a), "idle", "--entrant-a")).toBe(1);
    expect(selectEntrant(entrantLabels(a), "0", "--entrant-a")).toBe(0);
    expect(() => selectEntrant(entrantLabels(a), "2", "--entrant-a")).toThrow(
      /no such entrant/,
    );
    expect(() =>
      selectEntrant(entrantLabels(a), "baseline:{}", "--entrant-a"),
    ).toThrow(/no such entrant/);

    // A run that never wrote summary.json names its entrants by its seats.
    fs.rmSync(path.join(dir("b"), "summary.json"));
    expect(entrantLabels(readRun(dir("b")))).toEqual([
      'baseline:{"expandTrigger":0.3}',
    ]);
  });

  test("games pair by id whatever their order; the rest are listed", () => {
    const { a, b } = writePair();
    const as = sideGames(a, 0);
    const bs = sideGames(b, 0);
    expect(as.map((s) => s.game.index)).toEqual([0, 2, 4, 6, 8, 10]);
    const shuffled = [bs[3], bs[0], bs[4], bs[2], bs[1]];
    const p = pairGames([as[5], ...as.slice(0, 5)], shuffled, [], b.crashes);
    expect(p.pairs.map((x) => [x.a.game.game, x.b.game.game])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [4, 4],
      [5, 5],
    ]);
    expect(p.unpaired).toEqual([
      {
        gameID: as[3].game.gameID,
        game: 3,
        map: "Onion",
        reason: "crashed in B",
        a: 6,
        b: 3,
      },
    ]);

    // The same game id on another map (another pool, same seed) does not
    // pair, nor does a game one side lacks.
    const moved = { ...bs[0], game: { ...bs[0].game, map: as[1].game.map } };
    const q = pairGames(as.slice(0, 2), [moved]);
    expect(q.pairs).toEqual([]);
    expect(q.unpaired.map((u) => [u.game, u.reason])).toEqual([
      [0, "maps differ: Onion in A, Iceland in B"],
      [1, "not in B"],
    ]);
    expect(pairGames([], bs.slice(0, 1)).unpaired[0].reason).toBe("not in A");
  });

  test("an entrant of a --together run is its seat of each game", () => {
    writeRun(
      dir("t"),
      ["--agent", "baseline", "--agent", "idle", "--together", ...POOL],
      {
        seat: (_, i) => ({ peakShare: i === 1 ? 0.5 : 0.1 }),
      },
    );
    const run = readRun(dir("t"));
    const idle = sideGames(run, 1);
    expect(idle.map((s) => [s.game.index, s.seat])).toEqual(
      [0, 1, 2, 3, 4, 5].map((g) => [g, 1]),
    );
    const r = compareRuns(
      { run, entrant: 0 },
      { run, entrant: 1 },
      { head: { commit: COMMIT, dirty: false } },
    );
    expect(r.paired).toBe(6);
    expect(r.peakShare.meanDelta).toBeCloseTo(0.4);
  });
});

describe("the report", () => {
  test("B against A, game by game", () => {
    const { a, b } = writePair();
    const r = compareRuns(
      { run: a, entrant: 0 },
      { run: b, entrant: 0 },
      { head: { commit: COMMIT, dirty: false }, root: tmp },
    );
    expect(r.a).toMatchObject({ label: "baseline", games: 6, crashed: 0 });
    expect(r.b).toMatchObject({
      label: 'baseline:{"expandTrigger":0.3}',
      games: 5,
      crashed: 1,
    });
    expect(r.paired).toBe(5);
    expect(r.unpaired.map((u) => u.reason)).toEqual(["crashed in B"]);
    // A won 0 and 4, B 1, 2 and 4.
    expect(r.wins).toEqual({ a: 2, b: 3, aOnly: 1, bOnly: 2, signTestP: 1 });

    // Δprogress by game: 0.5 − 1, 1 − 0.25, 1 − 0.125, 0, 0.125 − 0.375.
    const deltas = [-0.5, 0.75, 0.875, 0, -0.25];
    expect(r.pairs.map((p) => p.delta.progress)).toEqual(
      deltas.map((d) => expect.closeTo(d, 12)),
    );
    expect(r.progress.meanDelta).toBeCloseTo(0.175);
    expect(r.progress.meanA).toBeCloseTo((1 + 0.25 + 0.125 + 1 + 0.375) / 5);
    expect([r.progress.better, r.progress.worse, r.progress.ties]).toEqual([
      2, 2, 1,
    ]);
    expect(r.progress.ci95![0]).toBeLessThan(0.175);
    expect(r.progress.ci95![1]).toBeGreaterThan(0.175);
    // Peak land (a win keeps the default 1%): +0.39, -0.19, -0.09, 0, -0.2.
    expect(r.peakShare.meanDelta).toBeCloseTo(-0.09 / 5);
    // Survival: wins count as the 60-minute cap; B was out at minute 2 in
    // game 5, where A was alive at the cap.
    expect(r.pairs.map((p) => p.a.survivalMinutes)).toEqual([
      60, 60, 60, 60, 60,
    ]);
    expect(r.survivalMinutes.meanDelta).toBeCloseTo(-58 / 5);
    expect([r.survivalMinutes.worse, r.survivalMinutes.ties]).toEqual([1, 4]);

    // Milestones over the paired games only.
    expect(r.milestones.a).toMatchObject({
      label: "A: baseline",
      games: 5,
      m3AboveMedian: 1,
      m3AboveTop: 0,
      eliminatedBefore20: 0,
    });
    // B's game 5 has no minute-3 point: it was out at minute 2, so behind.
    expect(r.milestones.b).toMatchObject({
      games: 5,
      m3AboveMedian: 4 / 5,
      m3AboveTop: 4 / 5,
      m3Games: 5,
      eliminatedBefore20: 1 / 5,
      medianWinMinutes: 20,
    });

    // By map, B's worst first: Onion −0.5, World (0.875 − 0.25) / 2, Iceland.
    expect(r.maps.map((m) => [m.name, m.games])).toEqual([
      ["Onion", 1],
      ["World", 2],
      ["Iceland", 2],
    ]);
    expect(r.maps[1].meanDelta).toBeCloseTo(0.3125);
    const categories = (map: string) =>
      MAP_INFO.find((m) => m.type === map)!.categories as string[];
    for (const c of r.categories) {
      expect(c.games).toBe(
        r.pairs.filter((p) => categories(p.map).includes(c.name)).length,
      );
    }
    expect(r.categories.map((c) => c.name).sort()).toEqual(
      [...new Set(["Onion", "Iceland", "World"].flatMap(categories))].sort(),
    );

    // The games B lost most in, with each side's rerun of its own copy.
    expect(r.worst.map((w) => [w.game, w.a.index, w.b.index])).toEqual([
      [0, 0, 0],
      [5, 10, 5],
    ]);
    expect(r.worst[1].rerunB).toBe(
      "npm run arena -- --from b --game 5 --images --image-every 1",
    );
    expect(r.worst[1].rerunA).toBe(rerunCommand(dir("a"), 10, tmp));
    expect(rerunCommand("/x/my runs/b", 3, "/y")).toBe(
      "npm run arena -- --from '/x/my runs/b' --game 3 --images --image-every 1",
    );

    // Only B had local changes; both ran HEAD.
    expect(r.warnings).toEqual([
      expect.stringMatching(/^B ran on 0123456 with local changes/),
    ]);

    const md = compareMarkdown(r, tmp);
    expect(md).toContain("**5 paired games** (A has 6, B 5; 1 unpaired)");
    expect(md).toContain("Discordant: A only 1, B only 2; sign test p = 1.");
    expect(md).toContain("> **WARNING:** B ran on 0123456 with local changes");
    expect(md).toContain("| progress | 0.550 | 0.725 | +0.175 |");
    expect(md).toContain("| survival | 60.0 min | 48.4 min | -11.6 min |");
    expect(md).toContain(
      "`npm run arena -- --from b --game 5 --images --image-every 1`",
    );
    // B's copy may not replay exactly: it ran with local changes.
    expect(md).toContain(
      "--game 5 --images --image-every 1` (it ran with local changes)",
    );
    expect(md).toContain("--game 10 --images --image-every 1`\n");
    expect(md).toContain("| 3 | Onion |");
    expect(md).toContain(
      "Only 5 pairs: too few to trust a bootstrap interval.",
    );
    // Deterministic, so reports can be diffed.
    expect(
      compareMarkdown(
        compareRuns(
          { run: a, entrant: 0 },
          { run: b, entrant: 0 },
          { head: { commit: COMMIT, dirty: false }, root: tmp },
        ),
        tmp,
      ),
    ).toBe(md);
  });

  test("a merged run against the run it was sharded from: all ties", () => {
    const args = ["--agent", "baseline", ...POOL];
    const seat = (job: { game: number }) => ({
      ...B_GAMES[job.game],
      ...at3(0.02),
    });
    writeRun(dir("whole"), args, { seat });
    writeRun(dir("s0"), [...args, "--shard", "0/2"], { seat });
    writeRun(dir("s1"), [...args, "--shard", "1/2"], { seat });
    mergeRuns([dir("s0"), dir("s1")], dir("merged"));
    const r = compareRuns(
      { run: readRun(dir("whole")), entrant: 0 },
      { run: readRun(dir("merged")), entrant: 0 },
      { head: { commit: COMMIT, dirty: false } },
    );
    expect(r.paired).toBe(6);
    expect(r.warnings).toEqual([]);
    for (const d of [r.progress, r.peakShare, r.survivalMinutes]) {
      expect(d.meanDelta).toBe(0);
      expect(d.ci95).toEqual([0, 0]);
      expect(d.ties).toBe(6);
    }
    expect(r.wins).toMatchObject({ aOnly: 0, bOnly: 0, signTestP: 1 });
    expect(r.lostBefore20).toMatchObject({ aOnly: 0, bOnly: 0, signTestP: 1 });
    expect(r.worst).toEqual([]);
    expect(r.milestones.b).toEqual({
      ...r.milestones.a,
      label: r.milestones.b.label,
    });
    expect(compareMarkdown(r)).toContain(
      "no difference shown (the interval includes 0)",
    );
  });

  test("lost before minute 20 counts a nation's early win, pair by pair", () => {
    // At a 20-minute cap: a nation won at minute 7 while the seat held land
    // (lost, not out), alive at the cap (neither), out at minute 12 (both).
    const nationWon: Seat = { result: "loss", peakShare: 0.05 };
    const capped: Seat = { result: "timeout", peakShare: 0.1 };
    const out12 = out(7200, 0.05);
    const length = (s: Seat) =>
      s === nationWon ? 4200 : s === capped ? 12000 : 7200;
    // In game 5 a nation beat B at minute 7 where A was out at minute 12:
    // B looks better on out < 20 min and is worse on lost < 20 min.
    const A = [nationWon, capped, out12, capped, capped, out12];
    const B = [capped, nationWon, out12, nationWon, capped, nationWon];
    const cap = ["--max-minutes", "20"];
    writeRun(dir("a"), ["--agent", "baseline", ...POOL, ...cap], {
      seat: (job) => A[job.game],
      ticks: (job) => length(A[job.game]),
    });
    writeRun(
      dir("b"),
      ["--agent", 'baseline:{"expandTrigger":0.3}', ...POOL, ...cap],
      { seat: (job) => B[job.game], ticks: (job) => length(B[job.game]) },
    );
    const r = compareRuns(
      { run: readRun(dir("a")), entrant: 0 },
      { run: readRun(dir("b")), entrant: 0 },
      { head: { commit: COMMIT, dirty: false } },
    );
    expect(r.paired).toBe(6);
    expect(r.pairs.map((p) => [p.a.lostBefore20, p.b.lostBefore20])).toEqual([
      [true, false],
      [false, true],
      [true, true],
      [false, true],
      [false, false],
      [true, true],
    ]);
    expect(r.milestones.a).toMatchObject({
      eliminatedBefore20: 2 / 6,
      lostBefore20: 3 / 6,
      lostBefore20Games: 6,
    });
    expect(r.milestones.b).toMatchObject({
      eliminatedBefore20: 1 / 6,
      lostBefore20: 4 / 6,
      lostBefore20Games: 6,
    });
    expect(r.lostBefore20).toEqual({
      games: 6,
      a: 3,
      b: 4,
      aOnly: 1,
      bOnly: 2,
      signTestP: 1,
    });

    // The milestone table has the column beside out < 20 min.
    const md = compareMarkdown(r);
    const lines = md.split("\n");
    const cells = (line: string) =>
      line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
    const at = lines.findIndex((l) => l.startsWith("| entrant |"));
    const header = cells(lines[at]);
    const rates = (row: number) =>
      ["out < 20 min", "lost < 20 min"].map(
        (name) => cells(lines[at + 2 + row])[header.indexOf(name)],
      );
    expect(rates(0)).toEqual(["33.3% of 6", "50.0% of 6"]);
    expect(rates(1)).toEqual(["16.7% of 6", "66.7% of 6"]);
    expect(md).toContain(
      "A 3, B 4 of the 6 pairs known on both sides. " +
        "Discordant: A only 1, B only 2; sign test p = 1.",
    );
  });

  test("a pair counts toward lost before 20 only where both sides know", () => {
    // Capped at 4 minutes, as opening work runs: a seat alive at the cap
    // cannot say, even where the other side was out at minute 3.
    const args = ["--agent", "baseline", ...POOL, "--max-minutes", "4"];
    writeRun(dir("a"), args, {
      seat: (job) => (job.game === 0 ? out(1800, 0.01) : alive(0.05)),
      ticks: (job) => (job.game === 0 ? 1800 : 2400),
    });
    writeRun(dir("b"), args, { ticks: () => 2400 });
    const r = compareRuns(
      { run: readRun(dir("a")), entrant: 0 },
      { run: readRun(dir("b")), entrant: 0 },
      { head: { commit: COMMIT, dirty: false } },
    );
    expect(r.paired).toBe(6);
    expect(r.milestones.a).toMatchObject({
      lostBefore20: 1,
      lostBefore20Games: 1,
    });
    expect(r.milestones.b).toMatchObject({
      lostBefore20: null,
      lostBefore20Games: 0,
    });
    expect(r.lostBefore20).toEqual({
      games: 0,
      a: 0,
      b: 0,
      aOnly: 0,
      bOnly: 0,
      signTestP: 1,
    });
  });

  test("a game crashed on both sides is unpaired, not left out", () => {
    const args = ["--agent", "baseline", ...POOL];
    writeRun(dir("a"), args, { crash: [1] });
    writeRun(dir("b"), args, { crash: [1, 4] });
    const r = compareRuns(
      { run: readRun(dir("a")), entrant: 0 },
      { run: readRun(dir("b")), entrant: 0 },
      { head: { commit: COMMIT, dirty: false } },
    );
    expect(r.paired).toBe(4);
    expect(r.unpaired.map((u) => [u.game, u.reason, u.a, u.b])).toEqual([
      [1, "crashed in both", 1, 1],
      [4, "crashed in B", 4, 4],
    ]);
    const md = compareMarkdown(r);
    expect(md).toContain("(A has 5, B 4; 2 unpaired)");
    expect(md).toContain("| 1 | Iceland |");
    expect(md).not.toContain("every game of both sides paired");

    // A crash in one run whose other run never had the game.
    const p = pairGames([], [], readRun(dir("a")).crashes, []);
    expect(p.unpaired.map((u) => u.reason)).toEqual(["crashed in A, not in B"]);
  });

  test("games that stopped on an error are left out, loudly", () => {
    const args = ["--agent", "baseline", ...POOL];
    // Under --strict, B's agent threw in game 2 at minute 1.5.
    writeRun(dir("a"), args, { seat: () => alive(0.2) });
    writeRun(dir("b"), args, {
      seat: (job) =>
        job.game === 2 ? { result: "error", peakShare: 0.01 } : alive(0.3),
      ticks: (job) => (job.game === 2 ? 900 : 36000),
      error: (job) =>
        job.game === 2 ? "Error: boom\n    at BaselineAgent.tick" : null,
    });
    const r = compareRuns(
      { run: readRun(dir("a")), entrant: 0 },
      { run: readRun(dir("b")), entrant: 0 },
      { head: { commit: COMMIT, dirty: false } },
    );
    expect(r.paired).toBe(5);
    expect(r.unpaired.map((u) => [u.game, u.reason])).toEqual([
      [2, "errored in B"],
    ]);
    // Without the cut-short game, B is better in every pair.
    expect(r.peakShare.meanDelta).toBeCloseTo(0.1);
    expect(r.survivalMinutes.worse).toBe(0);
    expect(r.warnings).toEqual([
      "1 game(s) stopped early on an error and are left out of the pairs, " +
        "where each would weigh in as a quick loss: game 2 (World) in B " +
        "Error: boom.",
    ]);
    expect(r.milestones.b.errored).toBe(0);
  });

  test("loud warnings: unknown, stale or dirty code, other settings", () => {
    writeRun(dir("old"), ["--agent", "baseline", ...POOL], {
      commit: null,
      dirty: null,
    });
    writeRun(
      dir("new"),
      ["--agent", "baseline", ...POOL, "--max-minutes", "10", "--seed", "x"],
      {
        commit: "f".repeat(40),
        dirty: true,
      },
    );
    const r = compareRuns(
      { run: readRun(dir("old")), entrant: 0 },
      { run: readRun(dir("new")), entrant: 0 },
      // No git in the temp dir: the commit cannot be looked up.
      { head: { commit: COMMIT, dirty: false }, root: tmp },
    );
    expect(r.warnings).toEqual([
      expect.stringMatching(/^A records no commit/),
      expect.stringMatching(/^B ran on fffffff with local changes/),
      "B ran on fffffff, not HEAD 0123456 (that commit is not in this checkout).",
      expect.stringMatching(/different settings.*maxMinutes 60 in A, 10 in B/),
      expect.stringMatching(/^Different seeds \(arena in A, x in B\)/),
      expect.stringMatching(/^No paired games/),
    ]);
    expect(r.paired).toBe(0);
    expect(r.unpaired).toHaveLength(12);
    expect(r.progress.ci95).toBeNull();
    const md = compareMarkdown(r);
    expect(md).toContain("**0 paired games**");
    expect(md).toContain("95% CI –: no paired games.");
  });
});
