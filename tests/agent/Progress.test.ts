import { ProgressEntry, progressPage } from "../../src/agent/arena/Progress";

function entry(id: string, title: string): ProgressEntry {
  return {
    id,
    date: id.slice(0, 10),
    commit: "a535bc8",
    title,
    varied: ["expandReserve"],
    image: `${id}.jpg`,
    seeds: ["showcase"],
    maps: ["World", "Mena"],
    games: 4,
    entrants: [
      {
        agent: "baseline",
        options: {},
        label: ["expandReserve 0.2 (default)"],
        games: 2,
        wins: 0,
        eliminated: 1,
        meanProgress: 0.09,
        meanPeakShare: 0.072,
      },
      {
        agent: "baseline",
        options: { expandReserve: 0.1 },
        label: ["expandReserve 0.1"],
        games: 2,
        wins: 1,
        eliminated: 0,
        meanProgress: 0.5,
        meanPeakShare: 0.4,
      },
    ],
    notes: ["holds <more> land"],
  };
}

describe("progress page", () => {
  const html = progressPage([
    entry("2026-09-26-m0-baseline", "baseline: defaults"),
    entry("2026-09-27-reserve", "baseline: expandReserve varied"),
  ]);

  test("follows the artifact page contract", () => {
    expect(html.startsWith("<title>OpenFront Arena Filmstrips</title>")).toBe(
      true,
    );
    expect(html).not.toMatch(/<(!doctype|html|head|body)\b/i);
  });

  test("lists galleries newest first, each with its image and labels", () => {
    expect(html.indexOf('id="2026-09-27-reserve"')).toBeLessThan(
      html.indexOf('id="2026-09-26-m0-baseline"'),
    );
    expect(html).toContain('src="galleries/2026-09-27-reserve.jpg"');
    expect(html).toContain('<a href="#2026-09-26-m0-baseline">');
    expect(html).toContain("expandReserve 0.1");
    expect(html).toContain("1/2 wins · progress 0.500 · peak 40.0%");
  });

  test("escapes notes", () => {
    expect(html).toContain("holds &lt;more&gt; land");
    expect(html).not.toContain("<more>");
  });
});
