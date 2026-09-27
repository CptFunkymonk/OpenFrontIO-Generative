/**
 * Package WP2 (docs/14-m4-plan.md §2.6): the search budget, in live-tick
 * equivalents.
 *
 * Claims:
 * - φ comes from the committed per-map table (a restore per rollout, or one
 *   restore, a take and a clone per search), with the fallback for a map
 *   the table lacks.
 * - restCost is an upper bound built from the plan's horizons: each
 *   candidate's fork and round 1, the longest `keep` non-break horizons,
 *   the break's longest look, the base to the longest.
 * - The degrade order is fixed and deterministic: all plans; drop the
 *   shares below 1; drop breaks; keep only lapse, keep and defensive plans;
 *   skip. The same input always gives the same level and the same plans in
 *   the same order.
 * - The cap is R·(t − searchFrom) + 3,000; R ≤ 0 has none.
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
  HStrong: 600,
  breakFirst: 1200,
  keep: 2,
  grid: 50,
};

/** act3's usual candidate set: strikes on N, a lapse and breaks on Z, an
 *  alliance request to an attacker. */
const SET = [
  cand("strike:N:0.5"),
  cand("strike:N:1"),
  cand("lapse:Z:1", { lastSend: 352 }),
  cand("break:Z:0.5"),
  cand("break:Z:1"),
  cand("ally:Y"),
];

describe("search budget", () => {
  test("φ: the table for every quick map, the fallback otherwise", () => {
    for (const map of SUITES.quick.maps!) {
      const row = (PHI.maps as Record<string, { restore: number }>)[map];
      expect(row, map).toBeDefined();
      expect(phiFor(map, "restore")).toEqual({
        first: row.restore,
        each: row.restore,
      });
    }
    const alps = PHI.maps["Alps"];
    expect(phiFor("Alps", "clone")).toEqual({
      first: alps.restore + alps.take + alps.clone,
      each: alps.clone,
    });
    expect(phiFor("No Such Map", "restore")).toEqual({ first: 300, each: 300 });
    expect(PHI.fallback.restore).toBe(300);
  });

  test("horizon bounds and the rest cost of a search", () => {
    expect(horizonBound(cand("strike:N:1"), MODEL)).toBe(600);
    expect(horizonBound(cand("lapse:Z:1", { lastSend: 352 }), MODEL)).toBe(
      1000,
    );
    expect(horizonBound(cand("break:Z:1"), MODEL)).toBe(1200);
    expect(horizonBound(cand("strike:N:1"), { ...MODEL, HStrong: 1200 })).toBe(
      1200,
    );
    // 6 × (φ + H1) + the two longest non-breaks (lapse 1000, a strike 600)
    // + the break to 1,200 + the base to 1,200, each past H1.
    expect(restCost(SET, MODEL)).toBe(
      6 * 250 + (1000 - 150) + (600 - 150) + (1200 - 150) + (1200 - 150),
    );
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

  test("the cap: R·(t − from) + 3,000, and none at R = 0", () => {
    const b = new SearchBudget(2.5, 2400);
    expect(b.cap(2400)).toBe(BUDGET_SLACK);
    expect(b.cap(2000)).toBe(BUDGET_SLACK);
    expect(b.cap(3400)).toBe(2.5 * 1000 + 3000);
    b.charge(4000);
    expect(b.room(3400)).toBe(1500);
    const free = new SearchBudget(0, 2400);
    expect(free.capped).toBe(false);
    expect(free.room(2400)).toBe(Infinity);
  });
});
