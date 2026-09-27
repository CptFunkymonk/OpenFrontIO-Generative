/**
 * Package SLICE: the time-sliced search (lib/search/Slicer.ts, Rounds'
 * roundsSteps, SearchController with searchSliceMs > 0).
 *
 * Claims:
 * - The rounds as a generator, run in slices, judge and choose exactly what
 *   the unsliced rounds do on the same rollouts, and advance the rollouts
 *   the same number of ticks (the tick-equivalent spend is unchanged): the
 *   slice decides only when the work happens.
 * - A plan chosen k ticks late is re-based: its steps and foe marks shift
 *   by k; it is dropped when its target died, changed alliance state with
 *   us or began attacking us since the search, or when its first step's
 *   `when` no longer holds (its window passed).
 * - Live (Onion, quick game 4, act3's clock at 2,200): a search whose
 *   rounds need several slices acts at t0 + k (k ≥ 3 with the test's
 *   clock) with the same choice as the unsliced search on the same state,
 *   sending its strike at t0 + k; with the same te.
 */
import { SearchController } from "../../../src/agent/agents/apex/controllers/SearchController";
import { parseApexOptions } from "../../../src/agent/agents/apex/options";
import type { DirectiveStep } from "../../../src/agent/agents/apex/state";
import type { Candidate } from "../../../src/agent/lib/search/Registry";
import {
  Roll,
  RoundsParams,
  RoundsResult,
  roundsSteps,
  runRounds,
} from "../../../src/agent/lib/search/Rounds";
import type {
  AllianceEnd,
  AttackSeen,
  BorderNation,
  SendState,
} from "../../../src/agent/lib/search/Runner";
import {
  NEAR_FORK,
  rebasePlan,
  rebaseSteps,
  shiftSteps,
  Slicer,
} from "../../../src/agent/lib/search/Slicer";
import type { Snap } from "../../../src/agent/lib/search/Value";
import { GameMapType } from "../../../src/core/game/Game";
import { simpleHash } from "../../../src/core/Util";
import { apexArena } from "../util/ApexArena";

const GRID = [50, 100, 150, 200, 300, 450, 600, 900, 1200, 1800];

type Point = [h: number, tiles: number, home?: number];

function snap(p: Point): Snap {
  const [h, tiles, home = 0] = p;
  return {
    h,
    tiles: Math.max(0, tiles),
    home,
    out: 0,
    inc: 0,
    cap: 0,
    gold: 0,
    alive: tiles >= 0,
    natAtks: 0,
    natTroops: 0,
    rank: 1,
    top: 0,
  };
}

/** A Roll over a step series that can step tick by tick (as a Runner). */
class FakeRoll implements Roll {
  h = 0;
  dead = false;
  readonly snaps: Snap[] = [];
  readonly attackers = new Map<string, AttackSeen>();
  readonly ended: AllianceEnd[] = [];
  readonly land0 = 1000;
  sent: SendState | null = null;
  ticks = 0;
  private readonly grid = new Set(GRID);
  private readonly points: Point[];

  constructor(
    readonly name: string,
    points: Point[],
  ) {
    this.points = [...points].sort((a, b) => a[0] - b[0]);
  }

  private pointAt(h: number): Point {
    let p = this.points[0];
    for (const x of this.points) if (x[0] <= h) p = x;
    return [h, p[1], p[2]];
  }

  stepTick(): void {
    this.h++;
    this.ticks++;
    const p = this.pointAt(this.h);
    if (p[1] < 0) this.dead = true;
    if (this.grid.has(this.h) || this.dead) this.snaps.push(snap(p));
  }

  advance(to: number, snapEnd = true): Snap {
    while (this.h < to && !this.dead) this.stepTick();
    const last = this.snaps[this.snaps.length - 1];
    if (last !== undefined && (last.h === this.h || !snapEnd)) return last;
    this.snaps.push(snap(this.pointAt(this.h)));
    return this.last();
  }

  last(): Snap {
    return this.snaps[this.snaps.length - 1];
  }

  at(h: number): Snap {
    let sn = this.snaps[0];
    for (const x of this.snaps) if (x.h <= h) sn = x;
    return sn;
  }

  landAt(): number {
    return this.land0;
  }

  bordering(): readonly BorderNation[] {
    return [];
  }

  alliedWith(): boolean {
    return false;
  }

  capNow(): number {
    return 1_000_000;
  }
}

const P: RoundsParams = {
  H1: 150,
  prune: 0.03,
  H: 600,
  HStrong: 600,
  strongShare: 0.9,
  HBreak: [1200],
  HBreakGated: 0,
  keep: 2,
  dip: 0.2,
  need: 300,
  rival: 0,
  value: {
    cbar: 150,
    beta: 0.5,
    alpha: 0.5,
    dangerNow: 0,
    dangerCap: 0,
    share: false,
  },
  grid: 50,
  minContact: 8,
  tiles0: 10_000,
  lossShare: 0.1,
};

function cand(name: string, over: Partial<Candidate> = {}): Candidate {
  const kind = name.split(":")[0];
  return {
    name,
    kind,
    target: name.split(":")[1] ?? null,
    steps: [],
    lastSend: kind === "break" ? 1 : 0,
    isBreak: kind === "break",
    strongCheck: kind === "strike",
    defensive: false,
    ...over,
  };
}

/** The fixture: a base, two strikes (one better, one pruned) and a break. */
const SERIES: Record<string, Point[]> = {
  base: [[0, 10_000, 5000]],
  "strike:A": [
    [0, 10_000, 5000],
    [200, 11_000, 4000],
    [600, 13_000, 4000],
  ],
  "strike:B": [
    [0, 10_000, 5000],
    [100, 9500, 5000],
  ],
  "break:C": [
    [0, 10_000, 5000],
    [300, 10_500, 5000],
    [1200, 12_000, 5000],
  ],
};
const CANDS = ["strike:A", "strike:B", "break:C"].map((n) => cand(n));

function fixture() {
  const opened = new Map<string, FakeRoll>();
  const base = new FakeRoll("base", SERIES.base);
  const open = (c: Candidate) => {
    const r = new FakeRoll(c.name, SERIES[c.name]);
    opened.set(c.name, r);
    return r;
  };
  const ticks = () =>
    base.ticks + [...opened.values()].reduce((a, r) => a + r.ticks, 0);
  return { base, open, opened, ticks };
}

const verdicts = (res: RoundsResult) => ({
  chosen: res.chosen?.cand.name ?? null,
  best: res.best?.cand.name ?? null,
  judged: res.judged.map((j) => [
    j.cand.name,
    j.round,
    j.h,
    j.drop,
    Number.isFinite(j.gain) ? Math.round(j.gain) : null,
    j.roll.h,
    j.roll.snaps.map((s) => s.h),
  ]),
  baseAt: [...res.baseAt].map(([h, v]) => [h, Math.round(v)]),
});

describe("search slices: the rounds as a generator", () => {
  test("sliced, the rounds judge and choose what the unsliced rounds do, over the same ticks", () => {
    const whole = fixture();
    const res0 = runRounds(P, whole.base, CANDS, whole.open);
    expect(res0.chosen?.cand.name).toBe("strike:A");

    // A clock that ticks once per read: a slice of `ms` takes `ms` yields.
    const sliced = fixture();
    let clock = 0;
    const slicer = new Slicer(
      roundsSteps(P, sliced.base, CANDS, sliced.open),
      100,
      () => clock++,
    );
    let slices = 0;
    while (!slicer.run()) slices++;
    slices++;
    expect(slicer.finished).toBe(true);
    const res1 = slicer.result!;

    expect(verdicts(res1)).toEqual(verdicts(res0));
    expect(sliced.ticks()).toBe(whole.ticks());
    // Every rollout stepped in slices, not whole: the base to the break's
    // 1,200, A to 600, B to 150 (pruned), C to 1,200, plus a yield per
    // fork, in slices of 100 yields (the last one ends the rounds).
    expect(whole.ticks()).toBe(1200 + 600 + 150 + 1200);
    expect(slicer.steps).toBe(whole.ticks() + 3);
    expect(slices).toBe(Math.floor(slicer.steps / 100) + 1);
    expect(slices).toBeGreaterThanOrEqual(3);
  });

  test("a slice of 0 ms runs the rounds whole in one call", () => {
    const f = fixture();
    const slicer = new Slicer(roundsSteps(P, f.base, CANDS, f.open), 0);
    expect(slicer.run()).toBe(true);
    expect(slicer.slices).toBe(1);
    expect(slicer.result!.chosen?.cand.name).toBe("strike:A");
  });
});

describe("search slices: re-basing a late plan", () => {
  const steps: DirectiveStep[] = [
    { at: 2400, label: "foe", foe: { id: "Z", until: 2900 } },
    { at: 2400, label: "attack" },
    { at: 2650, label: "renew", when: { unallied: "Z" } },
  ];
  const plan = cand("strike:Z", { steps });
  const alive = {
    alive: true,
    allied: false,
    expiresAt: null as number | null,
    attacking: false,
  };
  const ally = { ...alive, allied: true, expiresAt: 3000 as number | null };

  test("a fork-anchored plan's steps and foe marks shift by k; k = 0 leaves them", () => {
    expect(shiftSteps(steps, 0)).toEqual(steps);
    expect(shiftSteps(steps, 7)).toEqual([
      { at: 2407, label: "foe", foe: { id: "Z", until: 2907 } },
      { at: 2407, label: "attack" },
      { at: 2657, label: "renew", when: { unallied: "Z" } },
    ]);
    const r = rebasePlan(plan, 2400, 7, alive, alive, () => false);
    expect(r).toEqual({ steps: shiftSteps(steps, 7) });
    expect(rebaseSteps("break", steps, 2400, 7)).toEqual(shiftSteps(steps, 7));
  });

  test("an event-anchored plan (lapse, keep) keeps its absolute ticks; a step at t0 goes now; a past step drops it", () => {
    // A lapse of an alliance ending at 3000, searched at 2400 (cands/core.ts):
    // the foe mark now, the strike at the expiry + 2.
    const lapse: DirectiveStep[] = [
      { at: 2401, label: "foe", foe: { id: "Z", until: 3300 } },
      { at: 3002, label: "attack" },
    ];
    expect(rebaseSteps("lapse", lapse, 2400, 150)).toEqual([
      { at: 2551, label: "foe", foe: { id: "Z", until: 3300 } },
      { at: 3002, label: "attack" },
    ]);
    // A step within NEAR_FORK of the fork tick means "now".
    const keep: DirectiveStep[] = [
      { at: 2400, label: "unfoe", foe: { id: "Z", until: 2399 } },
      { at: 2700, label: "extend", when: { allied: "Z" } },
      { at: 3005, label: "renew", when: { unallied: "Z" } },
    ];
    expect(rebaseSteps("keep", keep, 2400, 150)).toEqual([
      { at: 2550, label: "unfoe", foe: { id: "Z", until: 2549 } },
      { at: 2700, label: "extend", when: { allied: "Z" } },
      { at: 3005, label: "renew", when: { unallied: "Z" } },
    ]);
    // The extension's tick passed during the search: the plan is stale.
    expect(rebaseSteps("keep", keep, 2400, 301)).toBeNull();
    expect(
      rebasePlan(
        cand("keep:Z", { steps: keep }),
        2400,
        301,
        ally,
        ally,
        () => true,
      ),
    ).toEqual({ drop: "past" });
    // The lapse's strike tick passed too (and the alliance lapsed: unallied
    // comes first when the target's state is known).
    expect(rebaseSteps("lapse", lapse, 2400, 700)).toBeNull();
    expect(
      rebasePlan(
        cand("lapse:Z", { steps: lapse }),
        2400,
        700,
        ally,
        ally,
        () => true,
      ),
    ).toEqual({ drop: "past" });
    expect(
      rebasePlan(
        cand("lapse:Z", { steps: lapse }),
        2400,
        700,
        ally,
        alive,
        () => false,
      ),
    ).toEqual({ drop: "unallied" });
    // Adopted 150 ticks late with the alliance unchanged: the mark goes
    // now, the strike still at the term (not 150 ticks after it).
    expect(
      rebasePlan(
        cand("lapse:Z", { steps: lapse }),
        2400,
        150,
        ally,
        ally,
        () => true,
      ),
    ).toEqual({
      steps: [
        { at: 2551, label: "foe", foe: { id: "Z", until: 3300 } },
        { at: 3002, label: "attack" },
      ],
    });
    // A step NEAR_FORK or more after the fork is an event's tick.
    expect(rebaseSteps("keep", [{ at: 2400 + NEAR_FORK }], 2400, 5)).toEqual([
      { at: 2400 + NEAR_FORK },
    ]);
    expect(
      rebaseSteps("keep", [{ at: 2400 + NEAR_FORK - 1 }], 2400, 5),
    ).toEqual([{ at: 2400 + NEAR_FORK + 4 }]);
  });

  test("a target that died, changed alliance state, was extended or began attacking us drops the plan", () => {
    const now = (o: Partial<typeof alive>) => ({ ...alive, ...o });
    const r = (b: typeof alive, n: typeof alive) =>
      rebasePlan(plan, 2400, 3, b, n, () => false);
    expect(r(alive, now({ alive: false }))).toEqual({ drop: "died" });
    expect(r(alive, now({ allied: true, expiresAt: 3000 }))).toEqual({
      drop: "allied",
    });
    expect(r(ally, alive)).toEqual({ drop: "unallied" });
    // The alliance's term moved (the web extended it during the search).
    expect(r(ally, { ...ally, expiresAt: 4200 })).toEqual({ drop: "extended" });
    expect("steps" in r(ally, { ...ally })).toBe(true);
    expect(r(alive, now({ attacking: true }))).toEqual({ drop: "attacked" });
    // Attacking us already at the search: not a change.
    const atk = now({ attacking: true });
    expect("steps" in r(atk, atk)).toBe(true);
    // No target: nothing to compare.
    expect(
      "steps" in
        rebasePlan(cand("keep", { steps }), 2400, 3, null, null, () => false),
    ).toBe(true);
  });

  test("a step due now whose `when` no longer holds live: the window passed", () => {
    const renew = cand("ally:Z", {
      steps: [{ at: 2400, label: "renew", when: { unallied: "Z" } }],
    });
    const isZ = (id: string) => id === "Z";
    expect(rebasePlan(renew, 2400, 5, alive, alive, isZ)).toEqual({
      drop: "window",
    });
    expect(
      "steps" in rebasePlan(renew, 2400, 5, alive, alive, () => false),
    ).toBe(true);
    const brk = cand("break:Z", {
      steps: [{ at: 2400, label: "break", when: { allied: "Z" } }],
    });
    expect(rebasePlan(brk, 2400, 5, ally, ally, () => false)).toEqual({
      drop: "window",
    });
    // Not only the first step: a keep's extension due now (its gift step
    // went first) is checked too; a step due later is left to its send.
    const keep = cand("keep:Z", {
      steps: [
        { at: 2400, label: "gift" },
        { at: 2400, label: "extend", when: { allied: "Z" } },
        { at: 3005, label: "renew", when: { unallied: "Z" } },
      ],
    });
    expect(rebasePlan(keep, 2400, 5, ally, ally, () => false)).toEqual({
      drop: "window",
    });
    expect("steps" in rebasePlan(keep, 2400, 5, ally, ally, isZ)).toBe(true);
  });
});

/** The arena's game IDs (Arena.ts gameIDFor). */
function gameIDFor(seed: string, index: number): string {
  const h = simpleHash(`${seed}:${index}`) >>> 0;
  return `G${h.toString(36).padStart(7, "0").slice(-7)}`;
}

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

describe("search slices: live", () => {
  test("a search sliced over several ticks acts at t0 + k with the unsliced search's choice, and the same te", async () => {
    // Unsliced: the search at 2,200 takes a strike in its tick.
    const whole = await apexArena({
      gameID: gameIDFor("quick", 4),
      map: GameMapType.Onion,
      options: OPTIONS,
      search: new SearchController(parseApexOptions(OPTIONS)),
    });
    whole.play(2401);
    const lines0 = whole.host.logs.map(msg);
    const first0 = lines0.find((m) => m.startsWith("search 2200 "))!;
    expect(first0).toMatch(/^search 2200 clock cands=\d+ chosen=strike:/);
    const chosen0 = /chosen=(\S+)/.exec(first0)![1];
    const te0 = /\bte=(\d+)/.exec(first0)![1];

    // Sliced, on a clock that ticks once per read: each slice runs 600
    // rollout ticks (or forks), so the rounds take several live ticks.
    const o = { ...OPTIONS, searchSliceMs: 600, searchSliceMaxTicks: 300 };
    let clock = 0;
    const sliced = await apexArena({
      gameID: gameIDFor("quick", 4),
      map: GameMapType.Onion,
      options: o,
      search: new SearchController(parseApexOptions(o), () => clock++),
    });
    sliced.play(2401);
    const lines1 = sliced.host.logs.map(msg);
    const first1 = lines1.find((m) => m.startsWith("search 2200 "))!;
    const k = Number(/\bk=(\d+)/.exec(first1)![1]);
    expect(k).toBeGreaterThanOrEqual(3);
    expect(k).toBeLessThan(20);
    expect(/chosen=(\S+)/.exec(first1)![1]).toBe(chosen0);
    expect(/\bte=(\d+)/.exec(first1)![1]).toBe(te0);
    expect(first1).not.toMatch(/dropped=/);

    // The strike goes out in the tick the search finished, not before.
    const [, target, frac] = chosen0.split(":");
    const attack = new RegExp(
      `^\\[(\\d+)\\] (\\d+) directive attack ${target} ${frac} S=\\d+ ok$`,
    );
    const sent = sliced.host.logs
      .map((l) => attack.exec(l))
      .filter((m) => m !== null)
      .map((m) => Number(m![2]));
    expect(sent).toEqual([2200 + k]);
    // Unsliced it went out at 2,200.
    expect(
      whole.host.logs.some((l) => {
        const m = attack.exec(l);
        return m !== null && Number(m[2]) === 2200;
      }),
    ).toBe(true);
    // No checkpoints for a re-based plan (the live game sends k ticks after
    // the rollout did).
    expect(lines1).toContain(`search-slice 2200 k=${k} checks=none`);
    expect(lines1.some((m) => m.startsWith("search-check 2200 "))).toBe(false);
  }, 900_000);

  test("a sliced search past searchSliceMaxTicks is given up (charged, no act); a trigger firing meanwhile waits; the next runs", async () => {
    // Two rollout ticks per slice: the rounds cannot finish in 400 ticks.
    // From 2,700 on the clock stands still: a slice runs to the end.
    const o = { ...OPTIONS, searchSliceMs: 2, searchSliceMaxTicks: 400 };
    let clock = 0;
    let still = false;
    const game = await apexArena({
      gameID: gameIDFor("quick", 4),
      map: GameMapType.Onion,
      options: o,
      search: new SearchController(parseApexOptions(o), () =>
        still ? 0 : clock++,
      ),
    });
    game.play(2700);
    still = true;
    game.play(101);
    const lines = game.host.logs.map(msg);
    const searches = lines.filter((m) => /^search \d+ /.test(m));
    expect(searches[0]).toMatch(
      /^search 2200 clock skipped=slice k=401 te=\d+ ms=\d+/,
    );
    // The clock trigger of 2,500 fired while the search was pending: held
    // (no second search ran, none was refused for budget); the one of
    // 2,800 ran whole in its tick.
    expect(searches.some((m) => m.startsWith("search 2500 "))).toBe(false);
    expect(searches[1]).toMatch(
      /^search 2800 clock cands=\d+ chosen=\S+ .* k=0 /,
    );
    // The given-up search played nothing: no directive before 2,800, no
    // search-slice line for it.
    expect(lines.some((m) => m.startsWith("search-slice 2200 "))).toBe(false);
    const sent = game.host.logs
      .map((l) => /^\[\d+\] (\d+) directive attack /.exec(l))
      .filter((m) => m !== null)
      .map((m) => Number(m![1]));
    expect(sent.every((t) => t >= 2800)).toBe(true);
  }, 900_000);
});
