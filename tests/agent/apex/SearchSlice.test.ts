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
  rebasePlan,
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
    // Every rollout stepped in slices, not whole: base 600 + A 600 + B 150
    // + C 1200 ticks, plus a yield per fork, in slices of 100 yields.
    expect(whole.ticks()).toBe(600 + 600 + 150 + 1200);
    expect(slicer.steps).toBe(whole.ticks() + 3);
    expect(slices).toBe(Math.ceil(slicer.steps / 100) + (slicer.steps % 100 === 0 ? 1 : 0));
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
  const alive = { alive: true, allied: false, attacking: false };

  test("steps and foe marks shift by k; k = 0 leaves them", () => {
    expect(shiftSteps(steps, 0)).toEqual(steps);
    expect(shiftSteps(steps, 7)).toEqual([
      { at: 2407, label: "foe", foe: { id: "Z", until: 2907 } },
      { at: 2407, label: "attack" },
      { at: 2657, label: "renew", when: { unallied: "Z" } },
    ]);
    const r = rebasePlan(plan, 7, alive, alive, () => false);
    expect(r).toEqual({ steps: shiftSteps(steps, 7) });
  });

  test("a target that died, changed alliance state or began attacking us drops the plan", () => {
    const now = (o: Partial<typeof alive>) => ({ ...alive, ...o });
    expect(rebasePlan(plan, 3, alive, now({ alive: false }), () => false)).toEqual(
      { drop: "died" },
    );
    expect(rebasePlan(plan, 3, alive, now({ allied: true }), () => false)).toEqual(
      { drop: "allied" },
    );
    expect(
      rebasePlan(plan, 3, now({ allied: true }), alive, () => false),
    ).toEqual({ drop: "unallied" });
    expect(
      rebasePlan(plan, 3, alive, now({ attacking: true }), () => false),
    ).toEqual({ drop: "attacked" });
    // Attacking us already at the search: not a change.
    const atk = now({ attacking: true });
    expect("steps" in rebasePlan(plan, 3, atk, atk, () => false)).toBe(true);
    // No target: nothing to compare.
    expect("steps" in rebasePlan(cand("keep", { steps }), 3, null, null, () => false)).toBe(true);
  });

  test("a first step whose `when` no longer holds live: the window passed", () => {
    const renew = cand("lapse:Z", {
      steps: [{ at: 2400, label: "renew", when: { unallied: "Z" } }],
    });
    expect(rebasePlan(renew, 5, alive, alive, (id) => id === "Z")).toEqual({
      drop: "window",
    });
    expect("steps" in rebasePlan(renew, 5, alive, alive, () => false)).toBe(
      true,
    );
    const brk = cand("break:Z", {
      steps: [{ at: 2400, label: "break", when: { allied: "Z" } }],
    });
    const ally = { ...alive, allied: true };
    expect(rebasePlan(brk, 5, ally, ally, () => false)).toEqual({
      drop: "window",
    });
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
    // No checkpoints for a re-based plan; the next search (the clock's, at
    // 2,500) is refused by the budget as in the unsliced run.
    expect(lines1).toContain(`search-slice 2200 k=${k} checks=none`);
    expect(lines1.some((m) => m.startsWith("search-check 2200 "))).toBe(false);
    expect(lines1.find((m) => m.startsWith("search 2500 "))).toMatch(
      /skipped=budget/,
    );
  }, 900_000);
});
