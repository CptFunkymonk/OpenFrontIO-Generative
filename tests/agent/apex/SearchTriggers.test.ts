/**
 * Package WP2 (docs/14-m4-plan.md §2.3): when the live search runs.
 *
 * Claims:
 * - Nothing before searchFrom; the floor clock (T7) makes the first search
 *   at searchFrom and one at least every floorTicks.
 * - T1 fires once per alliance term, in (extendLead, lapseLead] ticks
 *   before a bordering ally's expiry.
 * - T2 fires `chain` ticks after an act; T3 at the stall onset, every
 *   stallEvery ticks in stall, and sooner on a bordering nation's change;
 *   T4 at a nation attack of at least attackMin of our home, unless a search
 *   ran in the last minGap ticks (then never for that attack); T5 when the
 *   followed rollout's first attack of a nation is `foresight` ticks off.
 * - A search counts under the first trigger it matches, in T1-T7 order,
 *   and nothing fires within minGap of the last search.
 * - The clock mode (act3) fires every `clock` ticks from searchFrom and
 *   nothing else.
 */
import {
  NationObs,
  TriggerObs,
  TriggerParams,
  Triggers,
} from "../../../src/agent/lib/search/Triggers";

const P: TriggerParams = {
  from: 2400,
  clock: 0,
  lapseLead: 500,
  extendLead: 300,
  chain: 600,
  stallEvery: 1200,
  stallChange: 0.25,
  attackMin: 0.1,
  foresight: 300,
  navalHome: 0.8,
  navalFor: 600,
  navalEvery: 1200,
  floorTicks: 1800,
  minGap: 300,
};

function obs(t: number, over: Partial<TriggerObs> = {}): TriggerObs {
  return {
    t,
    inStall: false,
    home: 1_000_000,
    cap: 2_000_000,
    nations: [],
    attacks: [],
    naval: false,
    ...over,
  };
}

/** Steps the triggers from `from` to `to` with `at(t)`'s observations,
 *  marking each firing as a search; returns the firings. */
function drive(
  tr: Triggers,
  from: number,
  to: number,
  at: (t: number) => Partial<TriggerObs> = () => ({}),
): [number, string][] {
  const out: [number, string][] = [];
  for (let t = from; t <= to; t++) {
    const o = obs(t, at(t));
    const fired = tr.check(o);
    if (fired !== null) {
      out.push([t, fired]);
      tr.searched(o, fired, null);
    }
  }
  return out;
}

describe("search triggers", () => {
  test("the floor clock: first at searchFrom, then every floorTicks", () => {
    const tr = new Triggers(P);
    expect(drive(tr, 2000, 6000)).toEqual([
      [2400, "floor"],
      [4200, "floor"],
      [6000, "floor"],
    ]);
  });

  test("T1: once per alliance term, before the web would ask", () => {
    const tr = new Triggers(P);
    drive(tr, 2400, 2400);
    const ally = (expiresAt: number): NationObs => ({
      id: "Z",
      allied: true,
      expiresAt,
      troops: 500_000,
    });
    // Expiry at 3,400: the window is (2,900, 3,100], after the gap.
    expect(drive(tr, 2401, 3399, () => ({ nations: [ally(3400)] }))).toEqual([
      [2900, "end"],
    ]);
    // Extended: a new term, a new search (after the floor clock's at 5,100:
    // 2,200 ticks since the last).
    expect(drive(tr, 5100, 5600, () => ({ nations: [ally(5900)] }))).toEqual([
      [5100, "floor"],
      [5400, "end"],
    ]);
  });

  test("T1 waits out the gap, and is dropped once the web would ask", () => {
    const tr = new Triggers(P);
    drive(tr, 2400, 2400);
    // Expiry at 3,050: the window opens at 2,550, the gap ends at 2,700.
    expect(
      drive(tr, 2401, 2800, () => ({
        nations: [{ id: "Z", allied: true, expiresAt: 3050, troops: 1 }],
      })),
    ).toEqual([[2700, "end"]]);
    const late = new Triggers(P);
    drive(late, 2400, 2400);
    // Expiry at 2,950: the window (2,450, 2,650] closes before the gap.
    expect(
      drive(late, 2401, 2900, () => ({
        nations: [{ id: "Z", allied: true, expiresAt: 2950, troops: 1 }],
      })),
    ).toEqual([]);
  });

  test("T2: chain ticks after an act", () => {
    const tr = new Triggers(P);
    drive(tr, 2400, 2400);
    tr.acted(2400);
    expect(drive(tr, 2401, 3100)).toEqual([[3000, "chain"]]);
  });

  test("T3: the stall onset, every stallEvery ticks, sooner on a change", () => {
    const tr = new Triggers(P);
    drive(tr, 2400, 2400);
    const nbr = (troops: number): NationObs => ({
      id: "N",
      allied: false,
      expiresAt: null,
      troops,
    });
    // Stall from 2,800; the neighbour's troops move 30% at 4,500.
    const fired = drive(tr, 2401, 5000, (t) => ({
      inStall: t >= 2800,
      nations: [nbr(t >= 4500 ? 1_300_000 : 1_000_000)],
    }));
    expect(fired).toEqual([
      [2800, "stall"],
      [4000, "stall"],
      [4500, "stall"],
    ]);
  });

  test("T4: a big enough nation attack, not within the gap of a search", () => {
    const tr = new Triggers(P);
    drive(tr, 2400, 2400);
    const attack = (id: string, troops: number) => ({
      attacks: [{ id, attacker: "N", troops }],
    });
    // Too small (5% of home), then within the gap, then counted.
    expect(tr.check(obs(2800, attack("a1", 50_000)))).toBeNull();
    expect(tr.check(obs(2600, attack("a2", 500_000)))).toBeNull();
    // a2 was seen inside the gap: never again.
    expect(tr.check(obs(2800, attack("a2", 500_000)))).toBeNull();
    expect(tr.check(obs(2801, attack("a3", 500_000)))).toBe("attack");
  });

  test("T5: a foreseen attack within its window", () => {
    const tr = new Triggers(P);
    const o = obs(2400);
    expect(tr.check(o)).toBe("floor");
    tr.searched(o, "floor", [{ id: "N", at: 3300 }]);
    expect(drive(tr, 2401, 3400)).toEqual([[3000, "foresight"]]);
  });

  test("the first matching trigger names the search", () => {
    const tr = new Triggers(P);
    drive(tr, 2400, 2400);
    tr.acted(2400);
    // At 3,000 the chain, a stall and an attack all hold.
    const o = obs(3000, {
      inStall: true,
      attacks: [{ id: "a", attacker: "N", troops: 900_000 }],
    });
    expect(tr.check(o)).toBe("chain");
  });

  test("the clock mode fires on the clock only", () => {
    const tr = new Triggers({ ...P, clock: 600 });
    expect(
      drive(tr, 2000, 4300, (t) => ({
        inStall: t > 2500,
        attacks: [{ id: `a${t}`, attacker: "N", troops: 900_000 }],
      })),
    ).toEqual([
      [2400, "clock"],
      [3000, "clock"],
      [3600, "clock"],
      [4200, "clock"],
    ]);
  });
});
