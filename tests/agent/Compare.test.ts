import fs from "fs";
import os from "os";
import path from "path";
import type { StandingPoint } from "../../src/agent/arena/ArenaGame";
import {
  bootstrapCI,
  bootstrapMeanCI,
  compareMarkdown,
  compareRuns,
  DIAGNOSTICS,
  entrantLabels,
  eventStats,
  mapKinds,
  mapLandShare,
  pairedRatioStats,
  pairedStats,
  pairGames,
  rerunCommand,
  selectEntrant,
  sideGames,
  signTest,
} from "../../src/agent/arena/Compare";
import { mergeRuns } from "../../src/agent/arena/Merge";
import {
  LOG_LINES_KEPT,
  mean,
  readRun,
  Run,
  StoredSeat,
} from "../../src/agent/arena/Summary";
import { maps as MAP_INFO, PlayerType } from "../../src/core/game/Game";
import { COMMIT, seat as storedSeat, writeRun } from "./util/SyntheticRuns";

const NATION = PlayerType.Nation;

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

  test("paired statistics over the pairs both sides know, with ties", () => {
    const values: [number | null, number | null][] = [
      [1, 2],
      [null, 3],
      [2, 2.0005],
      [3, 1],
      [4, null],
    ];
    const d = pairedStats(values, 0.001);
    expect(d).toMatchObject({
      pairs: 3,
      meanA: 2,
      meanDelta: expect.closeTo((1 + 0.0005 - 2) / 3, 12),
      medianDelta: expect.closeTo(0.0005, 12),
      better: 1,
      worse: 1,
      ties: 1,
      signTestP: 1,
    });
    expect(d.meanB).toBeCloseTo((2 + 2.0005 + 1) / 3, 12);
    // Without a tolerance the small difference counts.
    expect(pairedStats(values)).toMatchObject({ better: 2, worse: 1, ties: 0 });
    expect(pairedStats([[null, 1]])).toMatchObject({
      pairs: 0,
      medianDelta: null,
      ci95: null,
      signTestP: 1,
    });
    // Ten pairs all better: p = 2 / 2^10.
    expect(
      pairedStats(Array.from({ length: 10 }, () => [0, 1])).signTestP,
    ).toBe(0.001953125);
  });

  test("paired events: discordant pairs and their sign test", () => {
    const e = eventStats([
      [true, false],
      [false, true],
      [true, true],
      [null, true],
      [false, false],
      [false, true],
    ]);
    expect(e).toEqual({
      pairs: 5,
      a: 2,
      b: 3,
      aOnly: 1,
      bOnly: 2,
      signTestP: 1,
    });
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

  test("bootstrapCI: the mean's interval, any statistic, nothing finite", () => {
    const sample = Array.from({ length: 20 }, (_, i) => i + 1);
    const meanOf = (pick: Uint32Array) =>
      [...pick].reduce((a, i) => a + sample[i], 0) / pick.length;
    expect(bootstrapCI(sample.length, meanOf)).toEqual(bootstrapMeanCI(sample));
    expect(bootstrapCI(0, meanOf)).toBeNull();
    // A statistic over nothing (a ratio of zeros) is left out; with fewer
    // than half the resamples left there is no interval.
    expect(bootstrapCI(3, () => NaN)).toBeNull();
    const some = bootstrapCI(3, (pick) => (pick[0] === 0 ? Infinity : 1))!;
    expect(some).toEqual([1, 1]);
  });

  test("prices pair pooled: one tiny game does not rule the difference", () => {
    // [troops, tiles]: A paid 100 a tile but 12,133 in a game it gained 21
    // tiles; B paid 90 a tile throughout.
    const values: [[number, number], [number, number]][] = [
      [
        [100_000, 1000],
        [90_000, 1000],
      ],
      [
        [200_000, 2000],
        [180_000, 2000],
      ],
      [
        [254_793, 21],
        [9000, 100],
      ],
    ];
    const d = pairedRatioStats(values);
    expect(d.pooled).toBe(true);
    expect(d.pairs).toBe(3);
    expect(d.meanA).toBeCloseTo(554_793 / 3021, 9);
    expect(d.meanB).toBeCloseTo(279_000 / 3100, 9);
    expect(d.meanDelta).toBeCloseTo(279_000 / 3100 - 554_793 / 3021, 9);
    // The mean of the per-game differences would be about -4,021.
    expect(
      pairedStats(values.map(([a, b]) => [a[0] / a[1], b[0] / b[1]])),
    ).toMatchObject({ meanDelta: expect.closeTo(-12_063 / 3, -1) });
    // Per game: -10, -10 and -12,043; B lower in all three.
    expect(d.medianDelta).toBeCloseTo(-10, 9);
    expect([d.better, d.worse, d.ties]).toEqual([0, 3, 0]);
    expect(d.signTestP).toBe(0.25);
    expect(d.ci95![0]).toBeLessThanOrEqual(d.meanDelta);
    expect(d.ci95![1]).toBeGreaterThanOrEqual(d.meanDelta);
    expect(pairedRatioStats(values)).toEqual(d);

    // Strikes that took no land cost the most; nothing lost or gained is
    // no price; a side without one leaves the pair out.
    const e = pairedRatioStats([
      [
        [5000, 0],
        [4000, 100],
      ],
      [
        [0, 0],
        [4000, 100],
      ],
      [null, [1, 1]],
      [
        [3000, 0],
        [6000, 0],
      ],
    ]);
    expect(e.pairs).toBe(2);
    expect([e.better, e.worse, e.ties]).toEqual([0, 1, 1]);
    expect(e.meanA).toBe(Infinity);
    expect(e.meanB).toBe(10_000 / 100);
    expect(e.medianDelta).toBe(-Infinity);
    expect(pairedRatioStats([])).toMatchObject({
      pairs: 0,
      medianDelta: null,
      ci95: null,
    });
  });
});

describe("map kinds", () => {
  test("water under 25% land, few-nation up to 4 nations, else land", () => {
    // From the manifests: Japan 7.7% land, Four Islands 23.0%, World 32.6%.
    expect(mapLandShare("Japan")).toBeCloseTo(0.077, 3);
    expect(mapLandShare("Four Islands")).toBeCloseTo(0.23, 3);
    expect(mapKinds("Japan", 12)).toEqual(["water"]);
    expect(mapKinds("Four Islands", 4)).toEqual(["water", "few-nation"]);
    expect(mapKinds("Bering Strait", 2)).toEqual(["few-nation"]);
    expect(mapKinds("World", 72)).toEqual(["land"]);
    expect(mapKinds("World", 5)).toEqual(["land"]);
    expect(mapKinds("World", null)).toEqual(["land"]);
    // A map without a manifest: its kind unknown unless few-nation.
    expect(mapLandShare("Atlantis")).toBeNull();
    expect(mapKinds("Atlantis", 30)).toEqual(["unknown"]);
    expect(mapKinds("Atlantis", 3)).toEqual(["few-nation"]);
    expect(mapKinds("World", 72, tmp)).toEqual(["unknown"]);
    // 20 of the 127 maps with nations are water (docs/11-roadmap.md H9).
    const water = MAP_INFO.filter(
      (m) =>
        m.defaultNationCount > 0 &&
        mapKinds(m.type, m.defaultNationCount).includes("water"),
    );
    expect(water).toHaveLength(20);
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
        kind: "crashed",
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
    expect(q.unpaired.map((u) => [u.game, u.kind, u.reason])).toEqual([
      [0, "maps", "maps differ: Onion in A, Iceland in B"],
      [1, "missing", "not in B"],
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
    // Every made-up game has 3 nations: few-nation, and none is water.
    expect(r.pairs.map((p) => p.kinds)).toEqual(
      r.pairs.map(() => ["few-nation"]),
    );
    expect(r.kinds.map((k) => [k.name, k.games, k.better, k.worse])).toEqual([
      ["few-nation", 5, 2, 2],
    ]);
    expect(r.kinds[0].ci95).toEqual(r.progress.ci95);

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
    expect(md).toContain(
      "**5 paired games** (A has 6, B 5; 1 unpaired: 1 crashed)",
    );
    expect(md).toContain(
      "Agent errors: in 0 of A's paired games and 0 of B's; they stay in " +
        "the pairs (--drop-errors leaves them out).",
    );
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
    expect(r.worst).toEqual([]);
    expect(r.milestones.b).toEqual({
      ...r.milestones.a,
      label: r.milestones.b.label,
    });
    expect(compareMarkdown(r)).toContain(
      "no difference shown (the interval includes 0)",
    );
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
    expect(md).toContain("(A has 5, B 4; 2 unpaired: 2 crashed)");
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

  test("a seat that never spawned is left out; agent errors stay in", () => {
    const args = ["--agent", "baseline", ...POOL];
    const stats = (errors: number) => ({
      ...storedSeat("baseline", 0).stats,
      errors,
      firstErrors: errors > 0 ? ["tick 5: Error: boom\n    at x"] : [],
    });
    writeRun(dir("a"), args, {
      seat: (job) => ({
        peakShare: 0.2,
        ...(job.game === 4 ? { spawnTiles: 0 } : { spawnTiles: 40 }),
      }),
    });
    writeRun(dir("b"), args, {
      seat: (job) => ({
        peakShare: 0.3,
        // Recorded before spawnTiles: taken as spawned.
        ...(job.game === 1 ? { stats: stats(3), peakShare: 0.01 } : {}),
        ...(job.game === 5 ? { stats: stats(1), spawnTiles: 0 } : {}),
      }),
    });
    const compare = (dropErrors: boolean) =>
      compareRuns(
        { run: readRun(dir("a")), entrant: 0 },
        { run: readRun(dir("b")), entrant: 0 },
        { head: { commit: COMMIT, dirty: false }, dropErrors },
      );
    const r = compare(false);
    // B's agent errors in game 1 are B's own failure: that game stays in.
    expect(r.paired).toBe(4);
    expect(r.unpaired.map((u) => [u.game, u.kind, u.reason])).toEqual([
      [4, "invalid", "no spawn in A"],
      [5, "invalid", "no spawn in B"],
    ]);
    expect(r.peakShare.worse).toBe(1);
    expect(r.events.agentErrors).toEqual({
      pairs: 4,
      a: 0,
      b: 1,
      aOnly: 0,
      bOnly: 1,
      signTestP: 1,
    });
    expect(r.milestones.b.agentErrors).toBe(3);
    expect(r.warnings).toEqual([
      "2 game(s) are left out of the pairs because a seat never spawned: " +
        "game 4 (Iceland) no spawn in A; game 5 (World) no spawn in B.",
      "B's seat had agent errors in 1 paired game(s), 3 in all. They stay " +
        "in the pairs as its own failures (--drop-errors leaves them out); " +
        "the first, game 1 (Iceland): tick 5: Error: boom.",
    ]);
    const md = compareMarkdown(r);
    expect(md).toContain("| 4 | Iceland |");
    expect(md).toContain("(A has 6, B 6; 2 unpaired: 2 invalid seat)");
    expect(md).toContain("in 0 of A's paired games and 1 of B's");
    expect(md).toContain("| agent errors | 0 | 1 | 0 | 1 | 1 | 4 |");

    // --drop-errors: B1's rule, for a harness fault that is not B's.
    const d = compare(true);
    expect(d.dropErrors).toBe(true);
    expect(d.paired).toBe(3);
    expect(d.unpaired.map((u) => [u.game, u.reason])).toEqual([
      [1, "3 agent error(s) in B"],
      [4, "no spawn in A"],
      [5, "1 agent error(s), no spawn in B"],
    ]);
    expect(d.warnings).toEqual([
      "3 game(s) are left out of the pairs because a seat never spawned or " +
        "had agent errors (--drop-errors): game 1 (Iceland) 3 agent " +
        "error(s) in B; game 4 (Iceland) no spawn in A; game 5 (World) 1 " +
        "agent error(s), no spawn in B.",
    ]);
    expect(d.milestones.b.agentErrors).toBe(0);
    expect(compareMarkdown(d)).toContain(
      "Agent errors: games where a seat had them are left out (--drop-errors).",
    );
  });

  test("a game one side lacks is not blamed on the other's errors", () => {
    const stats = { ...storedSeat("baseline", 0).stats, errors: 2 };
    const pool = ["--maps", "Onion,Iceland,World"];
    writeRun(dir("a"), ["--agent", "baseline", ...pool, "--games", "6"], {
      seat: (job) => (job.game === 5 ? { stats } : {}),
    });
    writeRun(dir("b"), ["--agent", "baseline", ...pool, "--games", "5"]);
    for (const dropErrors of [false, true]) {
      const r = compareRuns(
        { run: readRun(dir("a")), entrant: 0 },
        { run: readRun(dir("b")), entrant: 0 },
        { head: { commit: COMMIT, dirty: false }, dropErrors },
      );
      expect(r.unpaired.map((u) => [u.game, u.kind, u.reason])).toEqual([
        [5, "missing", "not in B"],
      ]);
      expect(r.warnings.filter((w) => /left out/.test(w))).toEqual([]);
      expect(compareMarkdown(r)).toContain("1 unpaired: 1 missing on a side");
    }
  });

  test("land by minute, events, identical games and the plan's metrics", () => {
    // g 0-5: Onion, Iceland, World, Onion, Iceland, World.
    const point = (minute: number, share: number, rank = 4): StandingPoint => ({
      minute,
      tick: minute * 600,
      share,
      rank,
      players: 10,
      nationsAlive: 8,
      medianNationShare: 0.05,
      topNation: { name: "Finland", share: 0.3 },
    });
    const timeline = [300, 600, 900].map((tick) => ({
      tick,
      tiles: tick,
      share: 0.1,
      troops: 1000,
      maxTroops: 2000,
      gold: tick,
      alive: true,
    }));
    const noNukes = { atom: 0, hydrogen: 0, mirv: 0, mirvWarhead: 0 };
    const base: Partial<StoredSeat> = {
      standings: [point(10, 0.1), point(15, 0.1), point(20, 0.1)],
      timeline,
      peakShare: 0.1,
      finalShare: 0.1,
      received: {
        attacks: { nation: 0, bot: 0, human: 0 },
        attackTroops: { nation: 0, bot: 0, human: 0 },
        nukes: noNukes,
        firstNukeTick: null,
        eliminatedBy: null,
      },
    };
    const A: Partial<StoredSeat>[] = [
      base,
      base,
      base,
      base,
      // A nation won at minute 12: lost, but not out.
      {
        ...base,
        result: "loss",
        standings: [point(10, 0.1)],
        finalShare: 0.05,
      },
      base,
    ];
    const B: Partial<StoredSeat>[] = [
      base,
      {
        ...base,
        standings: [point(10, 0.2, 2), point(15, 0.25, 2), point(20, 0.3, 2)],
        peakShare: 0.3,
        finalShare: 0.3,
      },
      // 0.02 points more at minute 20: a tie.
      {
        ...base,
        standings: [point(10, 0.1), point(15, 0.1), point(20, 0.1002)],
        finalShare: 0.1002,
      },
      // Out at minute 12.
      {
        ...base,
        result: "loss",
        eliminatedAtTick: 7200,
        standings: [point(10, 0.15, 3)],
        peakShare: 0.15,
        finalShare: 0,
      },
      base,
      // The same game, three bombs more on record.
      {
        ...base,
        received: { ...base.received!, nukes: { ...noNukes, atom: 3 } },
      },
    ];
    const args = ["--agent", "baseline", ...POOL];
    writeRun(dir("a"), args, {
      seat: (job) => A[job.game],
      ticks: (job) => (job.game === 4 ? 7200 : 12000),
      // Finland held 55% at minute 11 and won at 12.
      game: (job) =>
        job.game === 4
          ? {
              winner: { name: "Finland", type: NATION, isAgent: false },
              leaders: [
                {
                  tick: 6600,
                  leaders: [{ name: "Finland", type: NATION, share: 0.55 }],
                },
              ],
            }
          : {},
    });
    writeRun(dir("b"), args, {
      seat: (job) => B[job.game],
      ticks: (job) => (job.game === 3 ? 7200 : 12000),
      // B's seat logged searches in game 1.
      log: (job) =>
        [
          `## baseline (AGENT000)`,
          ...(job.game === 1
            ? [
                "[2400] search 2400 T3 cands=3 chosen=strike:x:1 gain=900 te=600 ms=500",
                "[3000] search 3000 T7 cands=2 chosen=base gain=0 te=300 ms=250",
              ]
            : []),
        ].join("\n"),
    });
    const r = compareRuns(
      { run: readRun(dir("a")), entrant: 0 },
      { run: readRun(dir("b")), entrant: 0 },
      { head: { commit: COMMIT, dirty: false } },
    );
    expect(r.paired).toBe(6);
    expect(r.identical).toBe(2);
    expect(r.pairs.map((p) => p.identical)).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
    // Minute 10: +0.1 in g1, +0.05 in g3 (still alive then).
    expect(r.land.at10).toMatchObject({
      pairs: 6,
      better: 2,
      worse: 0,
      ties: 4,
    });
    expect(r.land.at10.meanDelta).toBeCloseTo(0.15 / 6, 12);
    // Minute 15: B out in g3 (0), A's game over in g4 (its final 0.05).
    expect(r.land.at15).toMatchObject({ better: 2, worse: 1, ties: 3 });
    expect(r.land.at15.meanDelta).toBeCloseTo((0.15 - 0.1 + 0.05) / 6, 12);
    // Minute 20: g2's 0.0002 is a tie.
    expect(r.land.at20).toMatchObject({ better: 2, worse: 1, ties: 3 });
    expect(r.land.at20.meanDelta).toBeCloseTo((0.2 + 0.0002 - 0.1 + 0.05) / 6);
    expect(r.land.at20.signTestP).toBe(1);
    // B's game 3 stopped when B was out at minute 12, with no nation at
    // half the land: what the nations did then is unknown, so it does not
    // count (it was counted "no nation" before).
    expect(r.pairs[3].b.events.nationWonBefore20).toBeNull();
    const once = { pairs: 5, a: 1, b: 0, aOnly: 1, bOnly: 0, signTestP: 1 };
    const none = { pairs: 6, a: 0, b: 0, aOnly: 0, bOnly: 0, signTestP: 1 };
    expect(r.events).toEqual({
      outBefore20: { pairs: 6, a: 0, b: 1, aOnly: 0, bOnly: 1, signTestP: 1 },
      lostBefore20: { pairs: 6, a: 1, b: 1, aOnly: 1, bOnly: 1, signTestP: 1 },
      top3At10: { pairs: 6, a: 0, b: 2, aOnly: 0, bOnly: 2, signTestP: 0.5 },
      nationHalfBefore20: once,
      nationWonBefore20: once,
      agentErrors: none,
    });
    expect(r.milestones.a).toMatchObject({
      eliminatedBefore20: 0,
      lostBefore20: 1 / 6,
    });
    expect(r.diagnostics.map((d) => d.key)).toEqual(
      DIAGNOSTICS.map((d) => d.key),
    );
    const bombs = r.diagnostics.find((d) => d.key === "bombsReceived")!.stats;
    expect(bombs).toMatchObject({ pairs: 6, meanA: 0, meanB: 0.5, better: 1 });
    // A's logs hold no seat's lines: its searches are unknown.
    const searches = r.diagnostics.find((d) => d.key === "searches")!.stats;
    expect(searches.pairs).toBe(0);
    const inB = r.pairs.map((p) => [
      p.b.diagnostics.searches,
      p.b.diagnostics.acts,
      p.b.diagnostics.gain,
    ]);
    expect(inB).toEqual([
      [0, 0, 0],
      [2, 1, 900],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    // 750 ms of search in a game of 1,000 ms (the synthetic wall time).
    expect(r.pairs[1].b.diagnostics.R).toBe(3);

    const md = compareMarkdown(r);
    expect(md).toContain(
      "Identical games: 2 of 6 (the same result and timeline on both sides).",
    );
    expect(md).toContain("| land @10 | 10.0% | 12.5% | +2.5 pp |");
    expect(md).toContain("| out < 20 min | 0 | 1 | 0 | 1 | 1 | 6 |");
    expect(md).toContain(
      "| lost < 20 min, any cause | 1 | 1 | 1 | 1 | 1 | 6 |",
    );
    expect(md).toContain("| bombs received | 0.0 | 0.5 | +0.5 |");
    expect(md).toContain("| searches | – | – | – | – | – | – | – | 0 |");
    expect(md).toContain("| a nation won < 20 min | 1 | 0 | 1 | 0 | 1 | 5 |");
  });

  test("kinds, one tie rule, pooled prices and cut logs in a report", () => {
    // g 0-5: Japan (water), World (land), Onion (3 nations), twice.
    const pool = ["--maps", "Japan,World,Onion", "--each-map", "--repeat", "2"];
    const nations: Record<string, number> = {
      Japan: 12,
      World: 72,
      Onion: 3,
    };
    // Home 420k of a 1M cap all window: each game's all-in cost is 6,000
    // ticks of regrowth r, bought `gain` net tiles.
    const r = (10 + 420_000 ** 0.73 / 4) * 0.58;
    const flow = (gain: number) =>
      Array.from({ length: 31 }, (_, i) => ({
        tick: 300 * (i + 1),
        tiles: 10_000 + (300 * (i + 1) >= 9000 ? gain : 0),
        share: 0.1,
        troops: 420_000,
        maxTroops: 1e6,
        gold: 0,
        alive: true,
      }));
    const peakA = [0.2, 0.2, 0.2, 0.2, 0.2, 0.2];
    // B: better, a tie by 0.04 points, worse, equal, 0.04 points short (a
    // tie, not among the worst), equal.
    const peakB = [0.3, 0.2004, 0.1, 0.2, 0.1996, 0.2];
    const args = ["--agent", "baseline", ...pool];
    const search = "[2400] 2400 search 2400 T1 cands=2 chosen=base ms=5";
    const game = (job: { spec: { map: string } }) => ({
      nationsInGame: nations[job.spec.map],
    });
    writeRun(dir("a"), args, {
      seat: (job) => ({
        peakShare: peakA[job.game],
        timeline: flow(job.game === 1 ? 1100 : 2000),
      }),
      game,
      // A's seat logged no search: 0 searches, known.
      log: () => "## baseline (AGENT000)",
    });
    writeRun(dir("b"), args, {
      seat: (job) => ({
        peakShare: peakB[job.game],
        timeline: flow(3000),
      }),
      game,
      // B's log in game 5 reached AgentHost's cap.
      log: (job) =>
        [
          "## baseline (AGENT000)",
          search,
          ...(job.game === 5
            ? Array.from({ length: LOG_LINES_KEPT }, (_, i) => `[${i}] tn`)
            : []),
        ].join("\n"),
    });
    const rep = compareRuns(
      { run: readRun(dir("a")), entrant: 0 },
      { run: readRun(dir("b")), entrant: 0 },
      { head: { commit: COMMIT, dirty: false } },
    );
    expect(rep.pairs.map((p) => p.kinds)).toEqual([
      ["water"],
      ["land"],
      ["few-nation"],
      ["water"],
      ["land"],
      ["few-nation"],
    ]);
    // The headline's tie rule in every table.
    expect(rep.progress).toMatchObject({ better: 1, worse: 1, ties: 4 });
    expect(
      rep.kinds.map((k) => [k.name, k.games, k.better, k.worse, k.ties]),
    ).toEqual([
      ["land", 2, 0, 0, 2],
      ["water", 2, 1, 0, 1],
      ["few-nation", 2, 0, 1, 1],
    ]);
    const sum = (key: "better" | "worse" | "ties") =>
      rep.maps.reduce((n, m) => n + m[key], 0);
    expect([sum("better"), sum("worse"), sum("ties")]).toEqual([1, 1, 4]);
    expect(rep.maps.every((m) => m.ci95 === null)).toBe(true);
    expect(rep.worst.map((w) => w.game)).toEqual([2]);

    // Prices pooled: A bought 11,100 tiles with six games' cost, B 18,000.
    const price = rep.diagnostics.find((d) => d.key === "allInPrice")!.stats;
    expect(price).toMatchObject({ pooled: true, pairs: 6, better: 0 });
    expect(price.meanA).toBeCloseTo((6 * 6000 * r) / 11_100, 6);
    expect(price.meanB).toBeCloseTo((6 * 6000 * r) / 18_000, 6);
    expect(rep.pairs[1].a.ratios.allInPrice).toEqual([
      expect.closeTo(6000 * r, 6),
      1100,
    ]);
    expect(rep.pairs[1].a.diagnostics.allInPrice).toBeCloseTo(
      (6000 * r) / 1100,
      6,
    );

    // B's cut log: its searches there are unknown, and warned of.
    const searches = rep.diagnostics.find((d) => d.key === "searches")!.stats;
    expect(rep.pairs.map((p) => p.b.diagnostics.searches)).toEqual([
      1,
      1,
      1,
      1,
      1,
      null,
    ]);
    expect(searches.pairs).toBe(5);
    expect(rep.warnings).toEqual([
      "B's seat log reached AgentHost's 2000-line cap in 1 paired game(s): " +
        "the lines after it were not kept, so its searches, acts, gain, R " +
        "and checkpoint mismatches there are unknown (a mismatch past the " +
        "cap would not show), and so are pile-ons read from `def why` lines.",
    ]);
    const md = compareMarkdown(rep);
    const kinds = md.slice(md.indexOf("## By map kind"));
    expect(kinds.indexOf("| land |")).toBeLessThan(kinds.indexOf("| water |"));
    expect(kinds.indexOf("| water |")).toBeLessThan(
      kinds.indexOf("| few-nation |"),
    );
    expect(md).toContain("| all-in price m5-15 (pooled) |");
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
