import path from "path";
import type {
  ArenaGameResult,
  SeatResult,
} from "../../src/agent/arena/ArenaGame";
import { gallery, galleryHtml } from "../../src/agent/arena/Gallery";
import { GameMapType, PlayerType } from "../../src/core/game/Game";

// Only the fields the gallery reads; the rest of a result is irrelevant here.
const DEFAULTS = { thinkEvery: 5, expandTrigger: 0.35, expandReserve: 0.2 };

function seat(
  options?: Record<string, unknown>,
  overrides: Partial<SeatResult> = {},
): SeatResult {
  const point = (tick: number, share: number, alive: boolean) => ({
    tick,
    tiles: 0,
    share,
    troops: 0,
    maxTroops: 0,
    gold: 0,
    alive,
  });
  return {
    agent: "baseline",
    ...(options ? { options } : {}),
    resolvedOptions: { ...DEFAULTS, ...options },
    result: "loss",
    eliminatedAtTick: 2400,
    peakShare: 0.05,
    timeline: [
      point(600, 0.02, true),
      point(1800, 0.05, true),
      point(2400, 0, false),
    ],
    ...overrides,
  } as SeatResult;
}

function result(
  dir: string,
  overrides: Partial<ArenaGameResult> = {},
): ArenaGameResult {
  const nation = (share: number) => ({
    name: "Finland",
    type: PlayerType.Nation,
    share,
  });
  return {
    index: 0,
    gameID: "G1",
    map: GameMapType.World,
    ticks: 2400,
    winner: { name: "Finland", type: PlayerType.Nation, isAgent: false },
    error: null,
    images: ["t600", "t1800", "final"].map((label) =>
      path.join(dir, "images", `game000-${label}.png`),
    ),
    leaders: [
      { tick: 600, leaders: [nation(0.03)] },
      {
        tick: 1800,
        leaders: [
          { name: "baseline0", type: PlayerType.Human, share: 0.05 },
          nation(0.04),
        ],
      },
      { tick: 2400, leaders: [nation(0.81)] },
    ],
    seats: [seat()],
    ...overrides,
  } as ArenaGameResult;
}

describe("gallery", () => {
  test("shows each requested minute, then the end", () => {
    const dir = path.join("/runs", "a");
    const g = gallery([{ dir, result: result(dir) }], dir, [1, 3, 5]);
    expect(g.rows).toHaveLength(1);
    const [row] = g.rows;
    expect(row.map).toBe("World");
    expect(row.outcome).toBe(
      "out at 4.0 min · peak 5.0% · Finland won at 4.0 min",
    );
    expect(row.frames).toEqual([
      {
        label: "1 min",
        image: "images/game000-t600.png",
        caption: "us 2.0% · top nation 3.0%",
      },
      {
        // The leader at 3 min is the agent; the caption names the top nation.
        label: "3 min",
        image: "images/game000-t1800.png",
        caption: "us 5.0% · top nation 4.0%",
      },
      { label: "5 min", image: null, caption: "ended" },
      {
        label: "end",
        image: "images/game000-final.png",
        caption: "4.0 min: us out · top nation 81.0%",
      },
    ]);
  });

  test("labels a lone entrant with its overrides, or as defaults", () => {
    const dir = "/runs/a";
    const plain = gallery([{ dir, result: result(dir) }], dir);
    expect(plain.entrants.map((e) => e.label)).toEqual([["defaults"]]);
    expect(plain.title).toBe("baseline: defaults");

    const tuned = gallery(
      [{ dir, result: result(dir, { seats: [seat({ expandReserve: 0.1 })] }) }],
      dir,
    );
    expect(tuned.entrants[0].label).toEqual(["expandReserve 0.1"]);
  });

  test("labels a sweep with only the options that differ", () => {
    const dir = "/runs/a";
    const variants = [
      undefined,
      { expandTrigger: 0.25, expandReserve: 0.1 },
      { expandTrigger: 0.5, expandReserve: 0.42 },
    ];
    const g = gallery(
      variants.map((options, i) => ({
        dir,
        result: result(dir, { index: i, seats: [seat(options)] }),
      })),
      dir,
    );
    expect(g.varied).toEqual(["expandTrigger", "expandReserve"]);
    expect(g.entrants.map((e) => e.label)).toEqual([
      ["expandTrigger 0.35 (default)", "expandReserve 0.2 (default)"],
      ["expandTrigger 0.25", "expandReserve 0.1"],
      ["expandTrigger 0.5", "expandReserve 0.42"],
    ]);
    expect(g.title).toBe("baseline: expandTrigger, expandReserve varied");
    expect(g.rows.map((r) => r.entrant)).toEqual([0, 1, 2]);
  });

  test("leads with the agent's name when agents differ", () => {
    const dir = "/runs/a";
    const g = gallery(
      [
        { dir, result: result(dir) },
        {
          dir,
          result: result(dir, {
            index: 1,
            seats: [seat({ lookahead: false }, { agent: "next" })],
          }),
        },
      ],
      dir,
    );
    expect(g.entrants.map((e) => e.label)).toEqual([
      ["baseline"],
      ["next", "lookahead false"],
    ]);
    expect(g.title).toBe("baseline vs next");
  });

  test("totals each entrant's games", () => {
    const dir = "/runs/a";
    const won = seat(undefined, {
      result: "win",
      eliminatedAtTick: null,
      peakShare: 0.81,
    });
    const g = gallery(
      [
        { dir, result: result(dir) },
        { dir, result: result(dir, { index: 1, gameID: "G2", seats: [won] }) },
      ],
      dir,
    );
    expect(g.entrants).toHaveLength(1);
    expect(g.entrants[0]).toMatchObject({
      games: 2,
      wins: 1,
      eliminated: 1,
      meanProgress: 0.531, // (0.05 / 0.8 + 1) / 2
      meanPeakShare: 0.43,
    });
  });

  test("puts the same game from different runs side by side", () => {
    const a = path.join("/runs", "a");
    const b = path.join("/runs", "b");
    const next = [seat(undefined, { agent: "next" })];
    // Shuffled: rows follow run order, then game order within a run.
    const g = gallery(
      [
        {
          dir: a,
          result: result(a, { index: 1, gameID: "G2", map: GameMapType.Mena }),
        },
        {
          dir: b,
          result: result(b, {
            index: 1,
            gameID: "G2",
            map: GameMapType.Mena,
            seats: next,
          }),
        },
        { dir: b, result: result(b, { index: 0, seats: next }) },
        { dir: a, result: result(a, { index: 0 }) },
      ],
      "/runs",
    );
    expect(g.rows.map((r) => `${r.map} ${r.agent}`)).toEqual([
      "World baseline",
      "World next",
      "Mena baseline",
      "Mena next",
    ]);
    expect(g.rows[1].frames[0].image).toBe("b/images/game000-t600.png");
  });

  test("escapes names and options in the page", () => {
    const dir = "/runs/a";
    const html = galleryHtml(
      gallery(
        [{ dir, result: result(dir, { seats: [seat({ note: "<b>" })] }) }],
        dir,
        undefined,
        "baseline & friends",
      ),
    );
    expect(html).toContain("<title>baseline &amp; friends</title>");
    expect(html).toContain("<div>note &lt;b&gt;</div>");
    expect(html).not.toContain("note <b>");
    expect(html).toContain('<img src="images/game000-t600.png"');
  });
});
