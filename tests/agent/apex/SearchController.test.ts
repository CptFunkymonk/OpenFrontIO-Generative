/**
 * Package WP2 (docs/14-m4-plan.md §2.2-2.6, §2.10): the live search on a
 * real arena game (Onion, quick game 4, the arena's settings).
 *
 * Claims:
 * - On act3's clock (S0's rules) with a tiny budget: at its first search
 *   (tick 2,200 on a 300-tick clock) the search forks the live game, rolls
 *   the base and the strikes out with exact copies of the live policy, and
 *   takes a strike: the live policy offers the attack in the same tick,
 *   sized from its purse. The live game then follows the chosen rollout:
 *   every checkpoint of it (+50 ... +600) matches the live tiles, home and
 *   outgoing troops. The next searches do not fit the budget (R = 0.001:
 *   the cap stays near 3,000 live-tick equivalents): each is refused and
 *   logged as a `search` line without `chosen=`, which the arena's summary
 *   counts as skipped.
 * - On the plan's triggers (the defaults, S1): the first search is at
 *   searchFrom (the floor clock's, or the stall onset's before it); every
 *   search and refusal names its rule
 *   (`why=`); the budget is never overrun (the tick-equivalents spent by
 *   each tick stay within R·(t − searchFrom) + searchSlack); the checks
 *   are the plan's (+50, +150, +300, +600 and the judged horizon) and all
 *   match the live game.
 * - The log lines parse as the arena reads them (seatLogStats).
 * - Options no run can mean are refused when the controller is built.
 */
import { SearchController } from "../../../src/agent/agents/apex/controllers/SearchController";
import {
  APEX_DEFAULTS,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import { seatLogStats } from "../../../src/agent/arena/Summary";
import { GameMapType } from "../../../src/core/game/Game";
import { simpleHash } from "../../../src/core/Util";
import { apexArena } from "../util/ApexArena";

/** The arena's game IDs (Arena.ts gameIDFor). */
function gameIDFor(seed: string, index: number): string {
  const h = simpleHash(`${seed}:${index}`) >>> 0;
  return `G${h.toString(36).padStart(7, "0").slice(-7)}`;
}

/** act3's rules (S0's, without its clock and horizons). */
const ACT3 = {
  searchHStrong: 600,
  searchStackGate: false,
  searchOnTop: false,
  searchLapseLead: 498,
  searchLapseFoeAt: 1,
  searchShare: false,
  searchOutBoats: false,
  searchCheckAll: true,
};

const OPTIONS = {
  search: true,
  searchFrom: 2200,
  searchClock: 300,
  searchKinds: "strike",
  searchR: 0.001,
  searchSlack: 3000,
  ...ACT3,
};

const msg = (l: string) => l.replace(/^\[\d+\] /, "");

describe("SearchController", () => {
  test("act3's clock: takes a strike, the live game follows its rollout, and a budget refusal is logged", async () => {
    const arena = await apexArena({
      gameID: gameIDFor("quick", 4),
      map: GameMapType.Onion,
      options: OPTIONS,
      search: new SearchController(parseApexOptions(OPTIONS)),
    });
    arena.play(2801);
    const lines = arena.host.logs;
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
        /^search 2500 clock skipped=budget need=\d+ room=\d+ why=clock$/,
      ),
      expect.stringMatching(
        /^search 2800 clock skipped=budget need=\d+ room=\d+ why=clock$/,
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

  test("the plan's triggers: the first at searchFrom, every rule named, the budget kept, the plan's checks matched", async () => {
    const o = { search: true, searchFrom: 2200 };
    const arena = await apexArena({
      gameID: gameIDFor("quick", 4),
      map: GameMapType.Onion,
      options: o,
      search: new SearchController(parseApexOptions(o)),
    });
    arena.play(3401);
    const lines = arena.host.logs.map(msg);
    const tries = lines.filter(
      (m) => m.startsWith("search ") || m.startsWith("search-none "),
    );
    // The first search is at searchFrom: the floor clock's, or a trigger
    // before it in T1-T7 order (Onion g4 is in stall there).
    expect(tries[0]).toMatch(
      /^search 2200 (floor|stall) cands=\d+ chosen=\S+ .* why=(floor|onset)$/,
    );
    for (const m of tries) expect(m, m).toMatch(/ why=\S+( reserve=\d+)?$/);

    // The budget, search by search.
    const R = APEX_DEFAULTS.searchR;
    const slack = APEX_DEFAULTS.searchSlack;
    let spent = 0;
    for (const m of lines.filter((l) => l.startsWith("search "))) {
      const t = Number(m.split(" ")[1]);
      const te = /\bte=(\d+)/.exec(m);
      if (te !== null) spent += Number(te[1]);
      // Rounded per search: allow one tick-equivalent each.
      expect(spent, m).toBeLessThanOrEqual(
        R * (t - 2200) + slack + tries.length,
      );
    }
    expect(spent).toBeGreaterThan(0);

    // The plan's checks, all matching.
    const judged = new Map<number, number>();
    for (const m of lines.filter((l) => l.startsWith("search-rows "))) {
      const d = JSON.parse(m.slice("search-rows ".length)) as {
        t: number;
        rows: { name: string; h: number; j: number | null }[];
      };
      const head = lines.find((l) => l.startsWith(`search ${d.t} `))!;
      const name = /chosen=(\S+)/.exec(head)![1];
      const row =
        name === "base" ? d.rows[0] : d.rows.find((r) => r.name === name)!;
      judged.set(d.t, row.j ?? row.h);
    }
    const checks = lines.filter((m) => m.startsWith("search-check "));
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) {
      const [, t0, h, verdict] = c.split(" ");
      expect(verdict, c).toBe("ok");
      const at = Number(h.slice(1));
      expect([50, 150, 300, 600, judged.get(Number(t0))].includes(at), c).toBe(
        true,
      );
    }
    const stats = seatLogStats(arena.host.logs).search!;
    expect(stats.searches + stats.skipped).toBe(
      lines.filter((l) => l.startsWith("search ")).length,
    );
    expect(stats.mismatches).toBe(0);
  }, 600_000);

  test("refuses options no run can mean", () => {
    const make = (o: Record<string, unknown>) => () =>
      new SearchController(parseApexOptions({ search: true, ...o }));
    expect(make({ searchMode: "maybe" })).toThrow(/searchMode/);
    expect(make({ searchKinds: "strike,strik" })).toThrow(/searchKinds/);
    expect(make({ searchFracs: [0, 1] })).toThrow(/searchFracs/);
    expect(make({ searchHBreak: [600, "1200"] })).toThrow(/searchHBreak/);
    expect(make({ searchHBreak: [] })).toThrow(/searchHBreak/);
    expect(make({ searchReserve: -1 })).toThrow(/searchReserve/);
    expect(make({ searchLapseFoeAt: -1 })).toThrow(/searchLapseFoeAt/);
    expect(make({ searchDangerNow: 1 })).toThrow(/DangerModel/);
    expect(make({})).not.toThrow();
    // The fork mode is gone: ctx.fork() is a clone, cloned per rollout.
    expect(() => parseApexOptions({ searchFork: "clone" })).toThrow();
  });
});
