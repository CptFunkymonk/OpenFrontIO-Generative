import path from "path";
import type {
  ArenaGameResult,
  SeatResult,
} from "../../src/agent/arena/ArenaGame";
import { galleryHtml, galleryRows } from "../../src/agent/arena/Gallery";
import { GameMapType, PlayerType } from "../../src/core/game/Game";

// Only the fields the gallery reads; the rest of a result is irrelevant here.
function seat(overrides: Partial<SeatResult> = {}): SeatResult {
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
    const [row, ...rest] = galleryRows(
      [{ dir, result: result(dir) }],
      dir,
      [1, 3, 5],
    );
    expect(rest).toEqual([]);
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

  test("puts the same game from different runs side by side", () => {
    const a = path.join("/runs", "a");
    const b = path.join("/runs", "b");
    const next = [seat({ agent: "next" })];
    // Shuffled: rows follow run order, then game order within a run.
    const rows = galleryRows(
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
    expect(rows.map((r) => `${r.map} ${r.entrant}`)).toEqual([
      "World baseline",
      "World next",
      "Mena baseline",
      "Mena next",
    ]);
    expect(rows[1].frames[0].image).toBe("b/images/game000-t600.png");
  });

  test("escapes names and options in the page", () => {
    const dir = "/runs/a";
    const options = { note: "<b>" };
    const html = galleryHtml(
      galleryRows(
        [{ dir, result: result(dir, { seats: [seat({ options })] }) }],
        dir,
      ),
      "baseline & friends",
    );
    expect(html).toContain("<title>baseline &amp; friends</title>");
    expect(html).toContain("baseline{&quot;note&quot;:&quot;&lt;b&gt;&quot;}");
    expect(html).not.toContain(JSON.stringify(options));
    expect(html).toContain('<img src="images/game000-t600.png"');
  });
});
