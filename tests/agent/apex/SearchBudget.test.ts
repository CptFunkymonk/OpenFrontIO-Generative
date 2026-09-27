/**
 * Package WP2 (docs/14-m4-plan.md §2.6): the search budget, in live-tick
 * equivalents.
 *
 * Claims:
 * - φ comes from the committed per-map table (measured in situ): a
 *   search's first rollout pays ctx.fork() (a structural clone of the live
 *   game), the take of that fork and its clone, every other rollout a
 *   clone; a map the table lacks costs the fallback.
 * - restCost prices a search up front from the plan's horizons: each
 *   candidate's fork and round 1, the longest `keep` non-break horizons (a
 *   strike now on a target known to be strong at lastSend + HStrong), the
 *   best break's whole stepwise look (its last step), the base to the
 *   longest. The looks only a rollout reveals (a strong target at a later
 *   send, the gated look) are not in it: Rounds buys them.
 * - The degrade order is fixed and deterministic: all plans; drop the
 *   shares below 1; drop breaks; keep only lapse, keep and defensive plans;
 *   skip. The same input always gives the same level and the same plans in
 *   the same order.
 * - The cap is R·(t − searchFrom) + slack (4,500 by default); R ≤ 0 has
 *   none; affordableAt is the first tick the room reaches a need.
 */
import { SUITES } from "../../../src/agent/arena/Suites";
import {
  BUDGET_SLACK,
  CostModel,
  degrade,
  DEGRADE,
  horizonBound,
  phiFor,
  restCost,
  SearchBudget,
} from "../../../src/agent/lib/search/Budget";
import PHI from "../../../src/agent/lib/search/phi.json";
import type { Candidate } from "../../../src/agent/lib/search/Registry";

function cand(name: string, over: Partial<Candidate> = {}): Candidate {
  const kind = name.split(":")[0];
  const frac = Number(name.split(":")[2] ?? NaN);
  return {
    name,
    kind,
    target: name.split(":")[1] ?? null,
    steps: [],
    lastSend: kind === "break" ? 1 : 0,
    isBreak: kind === "break",
    strongCheck: kind === "strike" || kind === "lapse",
    frac: Number.isFinite(frac) ? frac : undefined,
    defensive: kind === "lapse" || kind === "ally" || kind === "keep",
    ...over,
  };
}

const MODEL: CostModel = {
  phi: { first: 100, each: 100 },
  H1: 150,
  H: 600,
  HStrong: 1200,
  breakLast: 1200,
  keep: 2,
  grid: 50,
};

/** The usual candidate set: strikes on N (not strong), a lapse and breaks
 *  on Z, an alliance request to an attacker. */
const SET = [
  cand("strike:N:0.5", { strong: false }),
  cand("strike:N:1", { strong: false }),
  cand("lapse:Z:1", { lastSend: 352 }),
  cand("break:Z:0.5"),
  cand("break:Z:1"),
  cand("ally:Y"),
];

describe("search budget", () => {
  test("φ: the table for every quick map, the fallback otherwise", () => {
    for (const map of SUITES.quick.maps!) {
      const row = (PHI.maps as Record<string, { first: number; each: number }>)[
        map
      ];
      expect(row, map).toBeDefined();
      expect(phiFor(map)).toEqual(row);
      // ctx.fork() is a structural clone: tens of live ticks, not a
      // restore's hundreds; the first rollout's costs more than a clone.
      expect(row.first, map).toBeLessThan(100);
      expect(row.each, map).toBeLessThanOrEqual(row.first);
    }
    expect(phiFor("No Such Map")).toEqual(PHI.fallback);
  });

  test("horizon bounds: a break's whole look, a known strong target's long one", () => {
    expect(horizonBound(cand("strike:N:1"), MODEL)).toBe(600);
    expect(horizonBound(cand("strike:N:1", { strong: false }), MODEL)).toBe(
      600,
    );
    expect(horizonBound(cand("strike:N:1", { strong: true }), MODEL)).toBe(
      1200,
    );
    // A lapse's strength is read at its send: priced short, bought later.
    expect(horizonBound(cand("lapse:Z:1", { lastSend: 352 }), MODEL)).toBe(
      1000,
    );
    expect(
      horizonBound(cand("lapse:Z:1", { lastSend: 352 }), {
        ...MODEL,
        HStrong: 600,
      }),
    ).toBe(1000);
    expect(horizonBound(cand("break:Z:1"), MODEL)).toBe(1200);
    expect(horizonBound(cand("break:Z:1"), { ...MODEL, breakLast: 1800 })).toBe(
      1800,
    );
  });

  test("the rest cost of a search: forks and round 1, the finalists, the break's whole look, the base", () => {
    // 6 × (φ + H1) + the two longest non-breaks (lapse 1000, a strike 600)
    // + the break to its last step, 1,200 + the base to 1,200, past H1.
    expect(restCost(SET, MODEL)).toBe(
      6 * 250 + (1000 - 150) + (600 - 150) + (1200 - 150) + (1200 - 150),
    );
    // Breaks always to 1,800 (S2): the break and the base go 600 further.
    expect(restCost(SET, { ...MODEL, breakLast: 1800 })).toBe(
      restCost(SET, MODEL) + 600 + 600,
    );
    // A strike known strong goes to 1,200 (and the base with it).
    const strong = [cand("strike:N:1", { strong: true })];
    expect(restCost(strong, MODEL)).toBe(250 + 1050 + 1050);
    // No candidate: the base to H.
    expect(restCost([], MODEL)).toBe(450);
  });

  test("the degrade order, level by level", () => {
    const at = (room: number) => {
      const d = degrade(SET, MODEL, room);
      return [DEGRADE[d.level], d.kept.map((c) => c.name)];
    };
    const full = restCost(SET, MODEL);
    const whole = restCost(
      SET.filter((c) => c.frac !== 0.5),
      MODEL,
    );
    const noBreak = restCost(
      SET.filter((c) => c.frac !== 0.5 && !c.isBreak),
      MODEL,
    );
    const defensive = restCost(
      SET.filter((c) => c.defensive),
      MODEL,
    );
    expect(full > whole && whole > noBreak && noBreak > defensive).toBe(true);
    expect(at(full)).toEqual(["full", SET.map((c) => c.name)]);
    expect(at(full - 1)).toEqual([
      "whole",
      ["strike:N:1", "lapse:Z:1", "break:Z:1", "ally:Y"],
    ]);
    expect(at(whole - 1)).toEqual([
      "nobreak",
      ["strike:N:1", "lapse:Z:1", "ally:Y"],
    ]);
    expect(at(noBreak - 1)).toEqual(["defensive", ["lapse:Z:1", "ally:Y"]]);
    expect(at(defensive - 1)).toEqual(["skip", []]);
    // Deterministic: the same input, the same answer.
    for (const room of [full, whole - 1, noBreak - 1, 0]) {
      expect(degrade(SET, MODEL, room)).toEqual(degrade(SET, MODEL, room));
    }
  });

  test("an empty level is passed over: strikes only go from whole to skip", () => {
    const strikes = [cand("strike:N:0.5"), cand("strike:N:1")];
    const one = restCost([strikes[1]], MODEL);
    expect(degrade(strikes, MODEL, one).kept.map((c) => c.name)).toEqual([
      "strike:N:1",
    ]);
    const d = degrade(strikes, MODEL, one - 1);
    expect(DEGRADE[d.level]).toBe("skip");
    expect(d.kept).toEqual([]);
  });

  test("the cap: R·(t − from) + slack, none at R = 0; when a need is payable", () => {
    const b = new SearchBudget(2.5, 2400);
    expect(BUDGET_SLACK).toBe(4500);
    expect(b.cap(2400)).toBe(BUDGET_SLACK);
    expect(b.cap(2000)).toBe(BUDGET_SLACK);
    expect(b.cap(3400)).toBe(2.5 * 1000 + 4500);
    b.charge(6000);
    expect(b.room(3400)).toBe(1000);
    // 1,000 left at 3,400: 2,000 needs 400 ticks more.
    expect(b.affordableAt(3400, 1000)).toBe(3400);
    expect(b.affordableAt(3400, 2000)).toBe(3800);
    expect(b.room(3800)).toBe(2000);
    expect(b.affordableAt(3400, 2001)).toBe(3801);
    const free = new SearchBudget(0, 2400);
    expect(free.capped).toBe(false);
    expect(free.room(2400)).toBe(Infinity);
    expect(free.affordableAt(2400, 1e9)).toBe(2400);
    expect(new SearchBudget(2.5, 2400, 3000).cap(2400)).toBe(3000);
  });
});
