/**
 * Package WP2 (docs/14-m4-plan.md §2.3): when the live search runs.
 *
 * Claims:
 * - Nothing before searchFrom; the floor clock (T7) makes the first search
 *   at searchFrom (high priority) and one at least every floorTicks (low).
 * - T1 fires once per alliance term, in (extendLead, lapseLead] ticks
 *   before a bordering ally's expiry, whatever the gap since the last try;
 *   a budget refusal does not use the term up: T1 fires again at the
 *   budget's retry tick while the window is open.
 * - T2 fires `chain` ticks after an act; T3 at the stall onset, every
 *   stallEvery ticks in stall, and sooner when a bordering nation's
 *   alliance flips, an unallied one appears, or its troops fall by
 *   stallChange; never while a chain is pending, and the chain search
 *   takes T3's snapshot.
 * - T4 fires at a nation attack of at least attackMin of our home unless a
 *   search RAN in the last minGap ticks (a refusal or a trigger with no
 *   plan does not count), then never for that attack; T5 when the followed
 *   rollout's first attack of a nation is `foresight` ticks off.
 * - A refused low-priority trigger holds every low-priority one until its
 *   retry tick; the high-priority ones fire meanwhile.
 * - A search counts under the first trigger it matches, in T1-T7 order.
 * - The clock mode (act3) fires every `clock` ticks from searchFrom and
 *   nothing else.
 */
import {
  Fired,
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

/** What happens to each firing: a search runs (the default), the budget
 *  refuses it (retry at the tick given), or no plan. */
type Fate = "run" | "none" | { retryAt: number };

/** Steps the triggers from `from` to `to` with `at(t)`'s observations;
 *  returns the firings as [tick, name, why?]. */
function drive(
  tr: Triggers,
  from: number,
  to: number,
  at: (t: number) => Partial<TriggerObs> = () => ({}),
  fate: (f: Fired, t: number) => Fate = () => "run",
  whys = false,
): (string | number)[][] {
  const out: (string | number)[][] = [];
  for (let t = from; t <= to; t++) {
    const o = obs(t, at(t));
    const fired = tr.check(o);
    if (fired === null) continue;
    out.push(whys ? [t, fired.name, fired.why] : [t, fired.name]);
    const f = fate(fired, t);
    if (f === "run") tr.searched(o, fired, []);
    else if (f === "none") tr.none(o, fired);
    else tr.refused(o, fired, f.retryAt);
  }
  return out;
}

const ally = (expiresAt: number, id = "Z"): NationObs => ({
  id,
  allied: true,
  expiresAt,
  troops: 500_000,
});

describe("search triggers", () => {
  test("the floor clock: first at searchFrom (high priority), then every floorTicks (low)", () => {
    const tr = new Triggers(P);
    const lows: boolean[] = [];
    const fired = drive(tr, 2000, 6000, undefined, (f) => {
      lows.push(f.low);
      return "run";
    });
    expect(fired).toEqual([
      [2400, "floor"],
      [4200, "floor"],
      [6000, "floor"],
    ]);
    expect(lows).toEqual([false, true, true]);
  });

  test("T1: once per alliance term, before the web would ask, whatever the gap", () => {
    const tr = new Triggers(P);
    drive(tr, 2400, 2400);
    // Expiry at 2,950: the window (2,450, 2,650] opens 50 ticks after the
    // search at 2,400, inside the gap; T1 fires at once.
    expect(drive(tr, 2401, 2949, () => ({ nations: [ally(2950)] }))).toEqual([
      [2450, "end"],
    ]);
    // Extended: a new term, a new search (after the floor clock's at 4,250:
    // 1,800 ticks since the last).
    expect(drive(tr, 4250, 4500, () => ({ nations: [ally(4800)] }))).toEqual([
      [4250, "floor"],
      [4300, "end"],
    ]);
  });

  test("T1 refused: retried at the budget's tick while the window is open, else given up", () => {
    const tr = new Triggers(P);
    drive(tr, 2400, 2400);
    const retries: Fate[] = [{ retryAt: 2600 }, "run"];
    // Expiry at 3,000: window (2,500, 2,700].
    expect(
      drive(
        tr,
        2401,
        2999,
        () => ({ nations: [ally(3000)] }),
        () => retries.shift()!,
      ),
    ).toEqual([
      [2500, "end"],
      [2600, "end"],
    ]);
    // A retry tick past the window: the term is given up.
    const late = new Triggers(P);
    drive(late, 2400, 2400);
    expect(
      drive(
        late,
        2401,
        2999,
        () => ({ nations: [ally(3000)] }),
        () => ({ retryAt: 2700 }),
      ),
    ).toEqual([[2500, "end"]]);
  });

  test("T2: chain ticks after an act; a search just before it counts as the chain", () => {
    const tr = new Triggers(P);
    drive(tr, 2400, 2400);
    tr.acted(2400);
    expect(drive(tr, 2401, 3100)).toEqual([[3000, "chain"]]);
    const early = new Triggers(P);
    drive(early, 2400, 2400);
    early.acted(2400);
    // T1 at 2,850, within minGap of the chain's 3,000: no second search.
    expect(
      drive(early, 2401, 3400, (t) => ({
        nations: t >= 2850 ? [ally(3350)] : [],
      })),
    ).toEqual([[2850, "end"]]);
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
    // Stall from 2,800; the neighbour's troops rise 30% at 4,100 (no
    // window) and fall 30% below the last search's at 4,500 (one opens).
    const fired = drive(
      tr,
      2401,
      5000,
      (t) => ({
        inStall: t >= 2800,
        nations: [
          nbr(t >= 4500 ? 700_000 : t >= 4100 ? 1_300_000 : 1_000_000),
        ],
      }),
      undefined,
      true,
    );
    expect(fired).toEqual([
      [2800, "stall", "onset"],
      [4000, "stall", "every"],
      [4500, "stall", "troops:N"],
    ]);
  });

  test("T3 waits out a pending chain: our own act's effects are the chain's", () => {
    const tr = new Triggers(P);
    drive(tr, 2400, 2400, () => ({ nations: [ally(9000, "Z")] }));
    tr.acted(2400);
    // The act broke Z (unallied from 2,401) and home fell out of stall and
    // back (a new onset at 2,700): nothing before the chain; the chain's
    // snapshot sees Z unallied, so no change fires after it.
    const fired = drive(
      tr,
      2401,
      4000,
      (t) => ({
        inStall: t < 2500 || t >= 2700,
        nations: [{ id: "Z", allied: false, expiresAt: null, troops: 1 }],
      }),
      undefined,
      true,
    );
    expect(fired).toEqual([[3000, "chain", "chain"]]);
  });

  test("T4: an attack is dropped only after a search that ran", () => {
    const attack = (id: string, troops: number) => ({
      attacks: [{ id, attacker: "N", troops }],
    });
    const tr = new Triggers(P);
    drive(tr, 2400, 2400);
    // Too small (5% of home), then within minGap of the search that ran:
    // dropped for good; then counted.
    expect(tr.check(obs(2800, attack("a1", 50_000)))).toBeNull();
    expect(tr.check(obs(2600, attack("a2", 500_000)))).toBeNull();
    expect(tr.check(obs(2800, attack("a2", 500_000)))).toBeNull();
    const a3 = tr.check(obs(2801, attack("a3", 500_000)));
    expect(a3).toMatchObject({ name: "attack", nation: "N", low: false });
    // A refusal and a trigger with no plan do not hold T4 back.
    for (const fate of ["none", { retryAt: 99_999 }] as Fate[]) {
      const t2 = new Triggers(P);
      drive(t2, 2400, 2400);
      drive(t2, 4200, 4200, undefined, () => fate); // the floor, not run
      const f = t2.check(obs(4210, attack(`b${String(fate)}`, 500_000)));
      expect(f?.name).toBe("attack");
    }
  });

  test("T5: a foreseen attack within its window", () => {
    const tr = new Triggers(P);
    const o = obs(2400);
    const f = tr.check(o)!;
    expect(f.name).toBe("floor");
    tr.searched(o, f, [{ id: "N", at: 3300 }]);
    expect(drive(tr, 2401, 3400)).toEqual([[3000, "foresight"]]);
  });

  test("a refused low-priority trigger holds the low ones; the high ones fire meanwhile", () => {
    const tr = new Triggers(P);
    drive(tr, 2400, 2400);
    const fates: Fate[] = ["run", { retryAt: 4500 }];
    const unallied: NationObs = {
      id: "N",
      allied: false,
      expiresAt: null,
      troops: 1,
    };
    const fired = drive(
      tr,
      2401,
      4600,
      (t) => ({
        inStall: t >= 2500,
        nations:
          t < 4000 ? [] : [ally(4400), ...(t >= 4100 ? [unallied] : [])],
      }),
      () => fates.shift() ?? "run",
      true,
    );
    // The onset (after the gap) runs; "every" at 3,900 is refused until
    // 4,500; T1 fires at 4,000 all the same; the new neighbour at 4,100
    // (a change) waits for the hold.
    expect(fired).toEqual([
      [2700, "stall", "onset"],
      [3900, "stall", "every"],
      [4000, "end", "end:Z"],
      [4500, "stall", "new:N"],
    ]);
  });

  test("a trigger with no plan counts as a look: the periodic ones wait", () => {
    const tr = new Triggers(P);
    // The first floor finds no plan: the next floor is floorTicks later.
    expect(drive(tr, 2400, 4300, undefined, () => "none")).toEqual([
      [2400, "floor"],
      [4200, "floor"],
    ]);
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
    expect(tr.check(o)?.name).toBe("chain");
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
