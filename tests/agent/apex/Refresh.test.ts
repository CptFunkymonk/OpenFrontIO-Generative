import {
  REFRESH_LEAD,
  REFRESH_MIN_TICKS,
  refreshDue,
} from "../../../src/agent/agents/apex/policy";
import { nextDecision } from "../../../src/agent/lib/NationModel";

// The round-robin's refresh rule (ApexPolicy.refreshNations, spec §3.0 step
// 5). A full refresh costs one N.nearby(), linear in N's border: 3-5 ms for
// a late-game nation on GiantWorldMap. Refreshed every 10 ticks, each nation
// cost 3-5 refreshes per decision interval (30-49 ticks at Impossible); with
// o.refreshBeforeDecision it costs one, in the REFRESH_LEAD ticks before the
// decision it is forecast for.

const params = (rate: number, phase: number) => ({
  trigger: 0.5,
  reserve: 0.3,
  expand: 0.1,
  rate,
  phase,
  source: "gameID" as const,
});

/** Ticks at which the rule refreshes one nation over `ticks` ticks. */
function refreshes(
  rate: number,
  phase: number,
  beforeDecision: boolean,
  ticks: number,
): number[] {
  const p = params(rate, phase);
  const out: number[] = [];
  let last: number | undefined;
  for (let t = 0; t < ticks; t++) {
    const next = beforeDecision ? nextDecision(p, t) : null;
    if (refreshDue(last, t, next)) {
      out.push(t);
      last = t;
    }
  }
  return out;
}

describe("apex nation refresh cadence", () => {
  test("before each decision: once per interval, within REFRESH_LEAD ticks of it", () => {
    for (const [rate, phase] of [
      [30, 0],
      [37, 11],
      [49, 48],
    ]) {
      const p = params(rate, phase);
      const at = refreshes(rate, phase, true, 2000);
      // The first one at once (never refreshed), then one per decision.
      expect(at[0]).toBe(0);
      const decisions = Math.floor((2000 - phase - 1) / rate) + 1;
      expect(at.length).toBeGreaterThanOrEqual(decisions - 1);
      // (Plus one: the first may fall before the first decision's window.)
      expect(at.length).toBeLessThanOrEqual(decisions + 2);
      for (const t of at.slice(1)) {
        const d = nextDecision(p, t);
        expect(d - t).toBeLessThan(REFRESH_LEAD);
      }
      for (let i = 1; i < at.length; i++) {
        expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(REFRESH_MIN_TICKS);
      }
    }
  });

  test("without it (or before the parameters are known, rate 1): every REFRESH_MIN_TICKS", () => {
    const fixed = refreshes(37, 11, false, 400);
    expect(fixed).toHaveLength(400 / REFRESH_MIN_TICKS);
    // The default parameters decide on every tick (rate 1).
    expect(refreshes(1, 0, true, 400)).toEqual(fixed);
    // 3-5 refreshes per 30-49-tick interval against about one.
    expect(fixed.length / refreshes(37, 11, true, 400).length).toBeGreaterThan(
      3,
    );
  });
});
