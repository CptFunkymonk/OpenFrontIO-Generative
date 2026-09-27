/**
 * Package WP2 (docs/14-m4-plan.md §2.2-2.6, §2.10): the live search on a
 * real arena game (Onion, quick game 4, the arena's settings), with a tiny
 * budget.
 *
 * Claims:
 * - At its first search (tick 2,200 on a 300-tick clock) the search forks
 *   the live game, rolls the base and the strikes out with exact copies of
 *   the live policy, and takes a strike: the live policy offers the attack
 *   in the same tick, sized from its purse.
 * - The live game then follows the chosen rollout: every checkpoint of it
 *   (+50 ... +600) matches the live tiles, home and outgoing troops.
 * - The next searches do not fit the budget (R = 0.001: the cap stays near
 *   3,000 live-tick equivalents): each is refused and logged as a `search`
 *   line without `chosen=`, which the arena's summary counts as skipped.
 * - The log lines parse as the arena reads them (seatLogStats).
 * - Options no run can mean are refused when the controller is built.
 */
import { SearchController } from "../../../src/agent/agents/apex/controllers/SearchController";
import { parseApexOptions } from "../../../src/agent/agents/apex/options";
import { seatLogStats } from "../../../src/agent/arena/Summary";
import { GameMapType } from "../../../src/core/game/Game";
import { simpleHash } from "../../../src/core/Util";
import { apexArena } from "../util/ApexArena";

/** The arena's game IDs (Arena.ts gameIDFor). */
function gameIDFor(seed: string, index: number): string {
  const h = simpleHash(`${seed}:${index}`) >>> 0;
  return `G${h.toString(36).padStart(7, "0").slice(-7)}`;
}

const OPTIONS = {
  search: true,
  searchFrom: 2200,
  searchClock: 300,
  searchKinds: "strike",
  searchR: 0.001,
};

describe("SearchController", () => {
  test("takes a strike, the live game follows its rollout, and a budget refusal is logged", async () => {
    const arena = await apexArena({
      gameID: gameIDFor("quick", 4),
      map: GameMapType.Onion,
      options: OPTIONS,
      search: new SearchController(parseApexOptions(OPTIONS)),
    });
    arena.play(2801);
    const lines = arena.host.logs;
    const msg = (l: string) => l.replace(/^\[\d+\] /, "");
    const searches = lines.map(msg).filter((m) => m.startsWith("search "));

    // The first search takes a strike, played in its own tick.
    const first = searches[0];
    expect(first).toMatch(
      /^search 2200 clock cands=\d+ chosen=strike:\S+:(0\.5|1) /,
    );
    const chosen = /chosen=(\S+)/.exec(first)![1];
    const [, target, frac] = chosen.split(":");
    expect(
      lines.some((l) =>
        new RegExp(
          `^\\[2200\\] 2200 directive attack ${target} ${frac} S=\\d+ ok$`,
        ).test(l),
      ),
    ).toBe(true);

    // Its rollout's checkpoints, all matching the live game.
    const checks = lines
      .map(msg)
      .filter((m) => m.startsWith("search-check 2200 "));
    expect(checks.map((c) => c.split(" ")[2])).toEqual([
      "+50",
      "+100",
      "+150",
      "+200",
      "+300",
      "+450",
      "+600",
    ]);
    expect(checks.every((c) => c.endsWith(" ok"))).toBe(true);

    // The later searches are refused by the budget.
    expect(searches.slice(1)).toEqual([
      expect.stringMatching(
        /^search 2500 clock skipped=budget need=\d+ room=\d+$/,
      ),
      expect.stringMatching(
        /^search 2800 clock skipped=budget need=\d+ room=\d+$/,
      ),
    ]);

    // As the arena reads them.
    const stats = seatLogStats(lines).search;
    expect(stats).toMatchObject({
      format: "search",
      searches: 1,
      skipped: 2,
      acts: 1,
      actsByKind: { strike: 1 },
      checks: 7,
      mismatches: 0,
    });
  }, 300_000);

  test("refuses options no run can mean", () => {
    const make = (o: Record<string, unknown>) => () =>
      new SearchController(parseApexOptions({ search: true, ...o }));
    expect(make({ searchMode: "maybe" })).toThrow(/searchMode/);
    expect(make({ searchFork: "copy" })).toThrow(/searchFork/);
    expect(make({ searchKinds: "strike,strik" })).toThrow(/searchKinds/);
    expect(make({ searchFracs: [0, 1] })).toThrow(/searchFracs/);
    expect(make({ searchHBreak: [600, "1200"] })).toThrow(/searchHBreak/);
    expect(make({ searchDangerNow: 1 })).toThrow(/DangerModel/);
    expect(make({})).not.toThrow();
  });
});
