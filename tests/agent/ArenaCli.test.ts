import fs from "fs";
import os from "os";
import path from "path";
import {
  ArenaJob,
  checkReplay,
  failedJobs,
  makeSpecs,
  parseArgs,
  playing,
  selection,
  selectJobs,
} from "../../src/agent/arena/Arena";
import { SUITE_NAMES, SUITES } from "../../src/agent/arena/Suites";
import { CrashedGame, StoredGame } from "../../src/agent/arena/Summary";
import { GameMapType, maps as MAP_INFO } from "../../src/core/game/Game";

// The arena's command line: suites, --shard/--range/--game selection and
// --from. None of these may change which map or game id game g gets, or
// ledger rows stop replaying.

const jobsOf = (...argv: string[]) => {
  const o = parseArgs(argv);
  return selectJobs(o, makeSpecs(o));
};
const key = (j: ArenaJob) => `${j.spec.index}:${j.spec.map}:${j.spec.gameID}`;
const DEFAULT_POOL = MAP_INFO.filter((m) => m.defaultNationCount > 0).map(
  (m) => m.type,
);

describe("existing seeds", () => {
  // Computed with Arena.ts as of 66b840d, before suites and selection.
  test("--seed plan-bench --games 20 draws the same maps and game ids", () => {
    const expected = [
      ["Lisbon", "G0o7mrsu"],
      ["Four Islands", "G0o7mrst"],
      ["Yellow Sea", "G0o7mrss"],
      ["Strait of Gibraltar", "G0o7mrsr"],
      ["Taiwan Strait", "G0o7mrsq"],
      ["Warship Warship", "G0o7mrsp"],
      ["Pulicat Lake", "G0o7mrso"],
      ["Rio de Janeiro", "G0o7mrsn"],
      ["Tourney 4 Teams", "G0o7mrsm"],
      ["Bering Strait", "G0o7mrsl"],
      ["Titan", "G0urmnyl"],
      ["Yangtze River", "G0urmnym"],
      ["Balkans", "G0urmnyn"],
      ["Caucasus", "G0urmnyo"],
      ["China", "G0urmnyp"],
      ["More Than Luck", "G0urmnyq"],
      ["The Box", "G0urmnyr"],
      ["Faroe Islands", "G0urmnys"],
      ["Deglaciated Antarctica", "G0urmnyt"],
      ["Central America", "G0urmnyu"],
    ];
    const jobs = jobsOf("--seed", "plan-bench", "--games", "20");
    expect(jobs.map((j) => [j.spec.map, j.spec.gameID])).toEqual(expected);
    expect(jobs.map((j) => j.spec.index)).toEqual(expected.map((_, i) => i));

    // Two entrants get the same games, interleaved.
    const paired = jobsOf(
      ...["--seed", "plan-bench", "--games", "20"],
      ...["--agent", "baseline", "--agent", "idle"],
    );
    expect(paired).toHaveLength(40);
    expect(
      paired.filter((j) => j.entrant === 1).map((j) => j.spec.gameID),
    ).toEqual(expected.map(([, id]) => id));
    expect(paired.map((j) => j.game)).toEqual(
      expected.flatMap((_, g) => [g, g]),
    );
  });

  test("plan-check and the showcase maps replay too", () => {
    expect(
      jobsOf("--seed", "plan-check", "--games", "4").map((j) => [
        j.spec.map,
        j.spec.gameID,
      ]),
    ).toEqual([
      ["Irish Sea", "G0891pie"],
      ["Strait Of Malacca", "G0891pid"],
      ["Mena", "G0891pic"],
      ["Alps", "G0891pib"],
    ]);
    const showcase = [
      ["World", "G0k8j06b"],
      ["Europe", "G0k8j06c"],
      ["Alps", "G0k8j06d"],
      ["ArchipelagoSea", "G0k8j06e"],
      ["Bering Strait", "G0k8j06f"],
      ["Mena", "G0k8j06g"],
    ];
    const maps = "World,Europe,Alps,ArchipelagoSea,BeringStrait,Mena";
    const ids = (jobs: ArenaJob[]) =>
      jobs.map((j) => [j.spec.map, j.spec.gameID]);
    expect(
      ids(jobsOf("--each-map", "--seed", "showcase", "--maps", maps)),
    ).toEqual(showcase);
    // The suite plays exactly the games of the M0 showcase ledger rows.
    expect(ids(jobsOf("--suite", "showcase"))).toEqual(showcase);
  });
});

describe("suites", () => {
  test("resolve to the documented maps, seeds and flags", () => {
    const smoke = parseArgs(["--suite", "smoke"]);
    expect(smoke.maps).toEqual([
      GameMapType.Onion,
      GameMapType.ArchipelagoSea,
      GameMapType.FourIslands,
      GameMapType.BeringStrait,
    ]);
    expect(smoke).toMatchObject({
      suite: "smoke",
      seed: "smoke",
      eachMap: true,
      repeat: 1,
      isolate: true,
      strict: true,
      maxMinutes: 10,
      playOut: false,
    });
    expect(makeSpecs(smoke)).toHaveLength(4);

    const showcase = parseArgs(["--suite", "showcase"]);
    expect(showcase.maps).toEqual([
      GameMapType.World,
      GameMapType.Europe,
      GameMapType.Alps,
      GameMapType.ArchipelagoSea,
      GameMapType.BeringStrait,
      GameMapType.Mena,
    ]);
    expect(showcase).toMatchObject({
      seed: "showcase",
      eachMap: true,
      playOut: true,
      images: true,
      imageEvery: 1,
      isolate: false,
      maxMinutes: 60,
    });

    const quick = parseArgs(["--suite", "quick"]);
    expect(
      quick.maps.map((t) => MAP_INFO.find((m) => m.type === t)!.id),
    ).toEqual(
      // The maps of docs/11-roadmap.md §11.5, mixed by kind (Suites.ts).
      "World,ArchipelagoSea,Alps,BeringStrait,Onion,Passage,Europe,FourIslands,Japan,TheBox,MississippiRiver,Africa,YellowSea,MiddleEast,GiantWorldMap,NorthAmerica".split(
        ",",
      ),
    );
    expect(quick).toMatchObject({ seed: "quick", eachMap: true, repeat: 2 });
    expect(makeSpecs(quick)).toHaveLength(32);

    for (const name of ["dev", "holdout"] as const) {
      const o = parseArgs(["--suite", name]);
      expect(o.maps).toEqual(DEFAULT_POOL);
      expect(o).toMatchObject({ seed: name, eachMap: true });
    }
    expect(DEFAULT_POOL).toHaveLength(127);
    expect(makeSpecs(parseArgs(["--suite", "dev"]))).toHaveLength(254);
    expect(makeSpecs(parseArgs(["--suite", "holdout"]))).toHaveLength(381);
  });

  test("quick's first 8 games, and its next 8, mix every kind of map", () => {
    // What a tune's first cuts see (Tune.ts plays prefixes of the games).
    const manifest = (t: GameMapType) => {
      const id = MAP_INFO.find((m) => m.type === t)!.id.toLowerCase();
      const file = path.join(__dirname, "../../resources/maps", id);
      return JSON.parse(
        fs.readFileSync(path.join(file, "manifest.json"), "utf8"),
      ) as {
        map: { width: number; height: number; num_land_tiles: number };
        nations: unknown[];
      };
    };
    const games = makeSpecs(parseArgs(["--suite", "quick"])).map(
      (j) => j.spec.map,
    );
    const land = (t: GameMapType) => manifest(t).map.num_land_tiles;
    const smallest = [...new Set(games)].sort((a, b) => land(a) - land(b))[0];
    const kinds: Record<string, (t: GameMapType) => boolean> = {
      continent: (t) =>
        MAP_INFO.find((m) => m.type === t)!.categories.some(
          (c) => c === "continental" || c === "world",
        ),
      "islands (< 10% land)": (t) => {
        const m = manifest(t).map;
        return m.num_land_tiles < 0.1 * m.width * m.height;
      },
      "all land": (t) => {
        const m = manifest(t).map;
        return m.num_land_tiles === m.width * m.height;
      },
      "400 wide": (t) =>
        Math.min(manifest(t).map.width, manifest(t).map.height) <= 400,
      "few nations": (t) => manifest(t).nations.length <= 8,
    };
    const lacking = (maps: GameMapType[], names: string[]) =>
      names.filter((k) => !maps.some(kinds[k]));
    const first = games.slice(0, 8);
    expect(lacking(first, Object.keys(kinds))).toEqual([]);
    expect(first).toContain(smallest);
    expect(first.some((t) => manifest(t).nations.length === 2)).toBe(true);
    expect(
      lacking(games.slice(0, 4), [
        "continent",
        "islands (< 10% land)",
        "all land",
      ]),
    ).toEqual([]);
    expect(lacking(games.slice(8, 16), Object.keys(kinds))).toEqual([]);
  });

  test("every suite map is a real map with nations", () => {
    for (const name of SUITE_NAMES) {
      for (const t of SUITES[name].maps ?? []) {
        const info = MAP_INFO.find((m) => m.type === t);
        expect(info, `${name}: ${t}`).toBeDefined();
        expect(info!.defaultNationCount, `${name}: ${t}`).toBeGreaterThan(0);
        expect(Object.values(GameMapType)).toContain(t);
      }
    }
  });

  test("explicit flags override suite values, wherever they are given", () => {
    for (const argv of [
      ["--suite", "smoke", "--max-minutes", "3", "--seed", "mine"],
      ["--max-minutes", "3", "--seed", "mine", "--suite", "smoke"],
      ["--max-minutes", "3", "--suite", "smoke", "--seed", "mine"],
    ]) {
      const o = parseArgs(argv);
      expect(o.maxMinutes).toBe(3);
      expect(o.seed).toBe("mine");
      expect(o.isolate).toBe(true);
      expect(o.argv).toEqual(argv);
    }
    expect(
      parseArgs(["--maps", "Iceland,Onion", "--suite", "smoke"]).maps,
    ).toEqual([GameMapType.Iceland, GameMapType.Onion]);
    expect(parseArgs(["--suite", "quick", "--repeat", "1"]).repeat).toBe(1);
    expect(
      parseArgs(["--image-every", "5", "--suite", "showcase"]),
    ).toMatchObject({ imageEvery: 5 });
    // Filters narrow the suite's maps.
    expect(
      parseArgs(["--suite", "smoke", "--exclude", "Onion,BeringStrait"]).maps,
    ).toEqual([GameMapType.ArchipelagoSea, GameMapType.FourIslands]);

    // --games asks for random draws instead of the suite's --each-map...
    const drawn = parseArgs(["--games", "3", "--suite", "smoke"]);
    expect(drawn.eachMap).toBe(false);
    const jobs = makeSpecs(drawn);
    expect(jobs).toHaveLength(3);
    for (const j of jobs) expect(drawn.maps).toContain(j.spec.map);
    // ...unless --each-map is given too.
    expect(
      parseArgs(["--suite", "smoke", "--games", "3", "--each-map"]).eachMap,
    ).toBe(true);
    // The last --suite wins.
    expect(parseArgs(["--suite", "dev", "--suite", "quick"]).seed).toBe(
      "quick",
    );
    // A suite whose games the flags change is recorded as modified...
    for (const argv of [
      ["--suite", "smoke", "--maps", "Onion,Iceland"],
      ["--suite", "smoke", "--max-minutes", "2"],
      ["--suite", "quick", "--seed", "x"],
      ["--suite", "quick", "--games", "3"],
      ["--suite", "quick", "--repeat", "1"],
      ["--suite", "quick", "--max-minutes", "5"],
      ["--suite", "showcase", "--bots", "10"],
    ]) {
      expect(parseArgs(argv).suite, argv.join(" ")).toBe(
        `${argv[1]} (modified)`,
      );
    }
    // ...but not by the entrants, the selection, the output, or a value the
    // suite has anyway.
    for (const argv of [
      ["--suite", "smoke", "--max-minutes", "10", "--isolate"],
      ["--suite", "quick", "--agent", "idle", "--agent", "baseline"],
      ["--suite", "quick", "--shard", "1/4", "--range", "0:9", "--game", "3"],
      ["--suite", "showcase", "--image-every", "5", "--jobs", "2", "--quiet"],
      [
        "--suite",
        "dev",
        "--out",
        "/tmp/x",
        "--verbose",
        "--timeline-every",
        "5",
      ],
    ]) {
      expect(parseArgs(argv).suite, argv.join(" ")).toBe(argv[1]);
    }
    expect(() => parseArgs(["--suite", "nope"])).toThrow(/unknown suite/);
    expect(() => parseArgs(["--suite"])).toThrow(/missing value/);
  });
});

describe("selection", () => {
  const run = ["--suite", "quick", "--agent", "baseline", "--agent", "idle"];

  test("labels count games and jobs apart", () => {
    const label = (...argv: string[]) => {
      const o = parseArgs(argv);
      const all = makeSpecs(o);
      return `${playing(selectJobs(o, all))}${selection(o, all)}`;
    };
    const two = ["--agent", "idle", "--agent", "baseline", "--games", "4"];
    expect(label(...two)).toBe("4 games × 2 entrants");
    expect(label(...two, "--range", "2:3")).toBe(
      "1 game × 2 entrants (games 2-2 of 4 games)",
    );
    expect(label(...two, "--shard", "0/2")).toBe(
      "2 games × 2 entrants (shard 0/2 of 4 games)",
    );
    expect(label(...two, "--game", "3")).toBe("1 game (job 3 of 8 jobs)");
    expect(label(...two, "--range", "1:3", "--game", "3")).toBe(
      "1 game (games 1-2 of 4 games; job 3 of 8 jobs)",
    );
    expect(label(...two, "--together")).toBe("4 games");
    expect(label("--games", "4")).toBe("4 games");
  });

  test("failed jobs are listed for summary.md", () => {
    const [played] = makeSpecs(parseArgs(["--maps", "Onion", "--games", "3"]));
    const game = (index: number, error: string | null) =>
      ({
        index,
        map: played.spec.map,
        gameID: `G${index}`,
        gameMinutes: 1.5,
        error,
      }) as StoredGame;
    const crash: CrashedGame = {
      index: 1,
      game: 1,
      entrant: 0,
      map: played.spec.map,
      gameID: "G1",
      crash: "worker exited (code 1, signal null)",
    };
    expect(
      failedJobs([game(0, null), game(2, "Error: boom\n    at tick")], [crash]),
    ).toEqual([
      "- job 1, Onion G1: crashed: worker exited (code 1, signal null)",
      "- job 2, Onion G2: stopped at 1.5 min on an error: Error: boom",
    ]);
    expect(failedJobs([game(0, null)], [])).toEqual([]);
  });

  test("shards partition the games, every entrant's copy together", () => {
    const all = jobsOf(...run);
    expect(all).toHaveLength(64);
    for (const n of [1, 2, 3, 5, 64, 100]) {
      const shards = Array.from({ length: n }, (_, i) =>
        n > 32 && i >= 32
          ? [] // more shards than games: those select nothing
          : jobsOf(...run, "--shard", `${i}/${n}`),
      );
      const union = shards.flat().map(key).sort();
      expect(union).toEqual(all.map(key).sort());
      expect(new Set(union).size).toBe(union.length);
      shards.forEach((jobs, i) => {
        for (const j of jobs) expect(j.game % n).toBe(i);
        // Both entrants of each game are in the same shard.
        const entrants = new Map<number, number[]>();
        for (const j of jobs) {
          entrants.set(j.game, [...(entrants.get(j.game) ?? []), j.entrant]);
        }
        for (const e of entrants.values()) expect(e).toEqual([0, 1]);
      });
    }
    expect(() => jobsOf(...run, "--shard", "40/64")).toThrow(
      /leaves none of the run's 32 games/,
    );
  });

  test("--range and --game pick games without renumbering them", () => {
    const all = new Map(jobsOf(...run).map((j) => [j.spec.index, key(j)]));
    const range = jobsOf(...run, "--range", "3:7");
    expect(range.map((j) => j.game)).toEqual([3, 3, 4, 4, 5, 5, 6, 6]);
    for (const j of range) expect(key(j)).toBe(all.get(j.spec.index));

    const both = jobsOf(...run, "--range", "3:11", "--shard", "1/2");
    expect([...new Set(both.map((j) => j.game))]).toEqual([3, 5, 7, 9]);

    const one = jobsOf(...run, "--game", "7");
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ game: 3, entrant: 1 });
    expect(key(one[0])).toBe(all.get(7));

    // With --together the job index is the game number.
    const together = jobsOf(...run, "--together", "--game", "7");
    expect(together.map((j) => [j.game, j.entrant])).toEqual([[7, -1]]);
  });

  test("bad selections are refused", () => {
    for (const bad of ["2/2", "0/0", "1", "-1/2", "a/b", "1/2/3"]) {
      expect(() => parseArgs(["--shard", bad]), bad).toThrow(/--shard/);
    }
    for (const bad of ["5:5", "6:5", "3", "a:b", "-1:2"]) {
      expect(() => parseArgs(["--range", bad]), bad).toThrow(/--range/);
    }
    expect(() => parseArgs(["--game", "x"])).toThrow(/non-negative integer/);
    expect(() => jobsOf("--games", "4", "--game", "4")).toThrow(
      /--game 4: the run has jobs 0-3/,
    );
    expect(() => jobsOf("--games", "4", "--range", "4:9")).toThrow(
      /leaves none/,
    );
  });
});

describe("--from", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-from-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (summary: unknown) =>
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary));

  test("reruns one game of a run with that run's flags", () => {
    const original = [
      ...["--suite", "quick", "--agent", "baseline", "--agent", "idle"],
      ...["--max-minutes", "20", "--out", "/tmp/elsewhere", "--shard", "1/4"],
    ];
    write({ argv: original, config: {} });
    const o = parseArgs([
      ...["--from", dir, "--game", "7", "--images", "--image-every", "1"],
      "--verbose",
    ]);
    expect(o).toMatchObject({
      // quick with a 20-minute cap is not the quick suite.
      suite: "quick (modified)",
      seed: "quick",
      maxMinutes: 20,
      onlyGame: 7,
      shard: null,
      imageEvery: 1,
      verbose: true,
    });
    expect(o.out).not.toBe("/tmp/elsewhere");
    expect(o.entrants.map((e) => e.label)).toEqual(["baseline", "idle"]);
    // The recorded command line needs no other directory to replay.
    expect(o.argv).not.toContain("--from");
    expect(o.argv).not.toContain("--out");

    const rerun = selectJobs(o, makeSpecs(o));
    const full = makeSpecs(parseArgs(original));
    expect(rerun.map(key)).toEqual([
      key(full.find((j) => j.spec.index === 7)!),
    ]);

    // Flags after --from override; an --agent replaces the entrants.
    const other = parseArgs([
      "--from",
      dir,
      "--max-minutes",
      "5",
      "--agent",
      "idle",
    ]);
    expect(other.maxMinutes).toBe(5);
    expect(other.entrants.map((e) => e.label)).toEqual(["idle"]);
    expect(makeSpecs(other).map((j) => j.spec.gameID)).toEqual(
      full.filter((j) => j.entrant === 0).map((j) => j.spec.gameID),
    );
  });

  test("replays a run recorded before argv was", () => {
    // The config of the ledger's plan-bench run (commit 7b52b78), from
    // before --each-map and argv were recorded.
    const flags = ["--agent", "baseline", "--agent", "idle", "--games", "20"];
    const now = parseArgs([...flags, "--seed", "plan-bench", "--play-out"]);
    const old = {
      together: false,
      games: 20,
      seed: "plan-bench",
      maps: now.maps,
      difficulty: "Impossible",
      nations: "default",
      bots: 400,
      size: "Normal",
      maxMinutes: 60,
      latency: 1,
      rateLimit: true,
      isolate: false,
      playOut: true,
      strict: false,
      out: "/home/user/OpenFrontIO-Generative/arena-results/plan-bench",
      images: false,
      imageEvery: 0,
      timelineEvery: 30,
      jobs: 4,
      verbose: false,
      quiet: false,
      entrants: ["baseline", "idle"],
    };
    write({ config: old, wallSeconds: 1, summaries: [], games: [] });
    const replay = parseArgs(["--from", dir]);
    expect(replay).toMatchObject({
      seed: "plan-bench",
      games: 20,
      playOut: true,
      eachMap: false,
      maps: now.maps,
    });
    expect(makeSpecs(replay).map(key)).toEqual(makeSpecs(now).map(key));
  });

  test("flags given before --from win too; any --agent replaces", () => {
    write({
      argv: [
        ...["--maps", "Onion,Iceland", "--agent", "baseline", "--agent"],
        ...["idle", "--max-minutes", "2", "--jobs", "2"],
      ],
      config: {},
    });
    const before = parseArgs([
      ...["--max-minutes", "5", "--jobs", "1", "--from", dir, "--game", "2"],
    ]);
    expect([before.maxMinutes, before.jobs, before.onlyGame]).toEqual([
      5, 1, 2,
    ]);
    expect(before.entrants.map((e) => e.label)).toEqual(["baseline", "idle"]);
    const agent = parseArgs(["--agent", "idle", "--from", dir]);
    expect(agent.entrants.map((e) => e.label)).toEqual(["idle"]);
    expect(agent.maxMinutes).toBe(2);
  });

  test("the run's map pool is pinned against a changed map list", () => {
    // A dev run from before a map was added to the generated list: every
    // later game of today's pool would be on the map after its own.
    const pool = DEFAULT_POOL.filter((m) => m !== DEFAULT_POOL[5]);
    const argv = ["--suite", "dev", "--agent", "baseline"];
    const then = { ...parseArgs(argv), maps: pool };
    const recorded = makeSpecs(then);
    write({
      argv,
      config: { maps: pool, entrants: ["baseline"] },
      games: recorded.map((j) => ({
        index: j.spec.index,
        game: j.game,
        entrant: 0,
        map: j.spec.map,
        gameID: j.spec.gameID,
      })),
    });
    // Today's dev suite puts game 10 elsewhere under the same game id.
    const today = makeSpecs(parseArgs(argv))[10].spec;
    expect(today.gameID).toBe(recorded[10].spec.gameID);
    expect(today.map).not.toBe(recorded[10].spec.map);

    const o = parseArgs(["--from", dir, "--game", "10"]);
    const jobs = selectJobs(o, makeSpecs(o));
    expect(jobs.map(key)).toEqual([key(recorded[10])]);
    expect(makeSpecs(o)).toHaveLength(recorded.length);
    // The pinned pool is not today's dev pool: not the dev suite now.
    expect(o.suite).toBe("dev (modified)");
    const head = { commit: "b".repeat(40), dirty: false };
    expect(checkReplay(o.from!, jobs, head)).toEqual([]);

    // Maps chosen with --from are not pinned over.
    const own = parseArgs(["--from", dir, "--maps", "Onion"]);
    expect(own.maps).toEqual([GameMapType.Onion]);
  });

  test("a rerun that would be another game is refused", () => {
    const argv = ["--maps", "Onion,Iceland", "--games", "4", "--seed", "s"];
    const jobs = makeSpecs(parseArgs(argv));
    const games = jobs.map((j) => ({
      index: j.spec.index,
      game: j.game,
      entrant: 0,
      map: j.spec.map,
      gameID: j.spec.gameID,
    }));
    const commit = "a".repeat(40);
    // As if the run's seed had been a default that has changed since.
    games[2] = { ...games[2], gameID: "Gchanged" };
    write({ argv, config: {}, games, commit, dirty: true });
    const head = { commit, dirty: false };
    const rerun = (...flags: string[]) => {
      const o = parseArgs(["--from", dir, ...flags]);
      return checkReplay(o.from!, selectJobs(o, makeSpecs(o)), head);
    };
    expect(() => rerun("--game", "2")).toThrow(
      /does not replay that run's games[\s\S]*game 2 was .* Gchanged, now /,
    );
    // Other games of the run still replay; the run's local changes are
    // warned of.
    expect(rerun("--game", "1")).toEqual([
      "--from: that run played with local changes",
    ]);
    // The check is on the run's own flags: one given with --from neither
    // causes a refusal nor hides one.
    expect(() => rerun("--game", "2", "--seed", "t")).toThrow(/game 2 was/);
    expect(rerun("--game", "1", "--seed", "t")).toHaveLength(1);
    expect(
      checkReplay(parseArgs(["--from", dir]).from!, [], {
        commit: "c".repeat(40),
        dirty: true,
      }),
    ).toEqual([
      `--from: that run played on aaaaaaa, this checkout is ccccccc: its games may not replay exactly`,
      "--from: that run played with local changes",
      "--from: this checkout has local changes",
    ]);
  });

  test("needs a finished run", () => {
    expect(() => parseArgs(["--from", dir])).toThrow(/summary.json not found/);
    write({ argv: ["--games", "2"] });
    expect(() => parseArgs(["--from", dir, "--from", dir])).toThrow(/once/);
    expect(() => parseArgs(["--from"])).toThrow(/missing value/);
  });
});

describe("agent options", () => {
  test("a misspelled option is refused before any game plays", () => {
    expect(() =>
      parseArgs(["--agent", 'baseline:{"expandTrigr":0.3}']),
    ).toThrow(/baseline has no option "expandTrigr"/);
    expect(() => parseArgs(["--agent", 'idle:{"x":1}'])).toThrow(
      /idle has no option "x" \(it takes none\)/,
    );
    expect(
      parseArgs(["--agent", 'baseline:{"expandTrigger":0.3}']).entrants,
    ).toHaveLength(1);
  });
});
