import { AgentIntent, SendResult } from "../../../src/agent/Agent";
import { APEX_DEFAULTS } from "../../../src/agent/agents/apex/options";
import {
  IntentBudget,
  INTENTS_PER_MINUTE,
} from "../../../src/agent/IntentBudget";
import { Ledger, PlanKind, SendMeta } from "../../../src/agent/lib/Ledger";
import {
  createPurse,
  DUP_GUARD_TICKS,
  HomeFloors,
  IntentClass,
  Prio,
  Proposal,
  Purse,
  Scheduler,
  SchedulerOptions,
  SpendKind,
} from "../../../src/agent/lib/Scheduler";
import { PseudoRandom } from "../../../src/core/PseudoRandom";

// The Scheduler against the host's own IntentBudget (src/agent/IntentBudget.ts,
// the server's limiter), on the arena's clock: nowMs = tick × 100
// (ArenaGame.ts), 600 ticks per game minute.

const MS_PER_TICK = 100;
const TICKS_PER_MINUTE = 60_000 / MS_PER_TICK;

const FLOORS: HomeFloors = {
  cap: 100_000,
  econ: 30_000,
  vw: 17_000,
  food: 0,
  H: 30_000,
  tn: 17_000,
  strike: 40_000,
};

/** A purse that never refuses (for budget-only tests). */
function rich(): Purse {
  return createPurse(1e12, FLOORS);
}

function attack(troops = 100, targetID: string | null = null): AgentIntent {
  return { type: "attack", targetID, troops };
}

function proposal(
  cls: IntentClass,
  prio: Prio,
  extra: Partial<Proposal> = {},
): Proposal {
  return { intent: attack(), cls, prio, ...extra };
}

interface Recorded {
  intent: AgentIntent;
  tick: number;
  kind: PlanKind | null;
  meta?: SendMeta;
}

/** A Ledger stand-in that only records what flush hands it. */
function recorder(): { ledger: Ledger; sends: Recorded[] } {
  const sends: Recorded[] = [];
  const ledger = {
    recordSend: (
      intent: AgentIntent,
      tick: number,
      kind: PlanKind | null,
      meta?: SendMeta,
    ) => sends.push({ intent, tick, kind, meta }),
  } as unknown as Ledger;
  return { ledger, sends };
}

describe("apex Purse (§2.6, §3.1)", () => {
  test("each kind keeps its floor: snack and defense vw, tn the TN floor, tribe and boat H, strike its own", () => {
    const purse = createPurse(50_000, FLOORS);
    const want: Record<SpendKind, number> = {
      snack: 33_000,
      defense: 33_000,
      tn: 33_000,
      tribe: 20_000,
      boat: 20_000,
      strike: 10_000,
    };
    for (const [k, v] of Object.entries(want)) {
      expect(purse.available(k as SpendKind)).toBe(v);
    }
    expect(purse.home).toBe(50_000);
    expect(purse.floors).toBe(FLOORS);
  });

  test("a take debits the one home that every kind shares; available never goes below 0", () => {
    const purse = createPurse(50_000, FLOORS);
    expect(purse.take("tribe", 15_000)).toBe(true);
    expect(purse.home).toBe(35_000);
    expect(purse.available("tribe")).toBe(5_000);
    expect(purse.available("snack")).toBe(18_000);
    expect(purse.available("strike")).toBe(0);
    expect(purse.take("snack", 18_000)).toBe(true);
    expect(purse.home).toBe(17_000);
    expect(purse.available("tribe")).toBe(0);
  });

  test("an overdraft, a negative or a non-finite take is refused with no debit", () => {
    const purse = createPurse(50_000, FLOORS);
    expect(purse.take("tribe", 20_001)).toBe(false);
    expect(purse.take("tribe", -1)).toBe(false);
    expect(purse.take("tribe", NaN)).toBe(false);
    expect(purse.take("snack", Infinity)).toBe(false);
    expect(purse.home).toBe(50_000);
    expect(purse.take("tribe", 20_000)).toBe(true); // exactly available
    expect(purse.take("tribe", 0)).toBe(true);
    expect(purse.home).toBe(30_000);
  });

  test("home below a floor: nothing available for that kind", () => {
    const purse = createPurse(10_000, FLOORS);
    expect(purse.available("snack")).toBe(0);
    expect(purse.take("snack", 1)).toBe(false);
  });
});

describe("apex Scheduler (§2.6, §3.10)", () => {
  const o: SchedulerOptions = {
    reservePerSecond: APEX_DEFAULTS.reservePerSecond,
    reservePerMinute: APEX_DEFAULTS.reservePerMinute,
    classCapsPerMinute: { ...APEX_DEFAULTS.classCapsPerMinute },
  };

  test("never sends an attack 17-23 ticks after a cancel (the duplication bug)", () => {
    const s = new Scheduler(o, MS_PER_TICK);
    const { ledger } = recorder();
    const send = (): SendResult => "ok";
    const at = (tick: number) => {
      s.begin(tick, { perSecond: 10, perMinute: 150 }, rich());
      return s.offer(proposal("tn", Prio.TN));
    };
    s.begin(100, { perSecond: 10, perMinute: 150 }, rich());
    expect(
      s.offer(
        proposal("defense", Prio.Emergency, {
          intent: { type: "cancel_attack", attackID: "a1" },
        }),
      ),
    ).toBe(true);
    s.flush(send, ledger, 100);
    const [from, to] = DUP_GUARD_TICKS;
    expect(from).toBeLessThanOrEqual(20);
    expect(to).toBeGreaterThanOrEqual(20);
    // A rescue re-click 1-16 ticks on is safe, and so is anything after.
    expect(at(100 + from - 1)).toBe(true);
    for (let d = from; d <= to; d++) {
      expect(at(100 + d)).toBe(false);
      expect(s.lastRefusal).toBe("dupGuard");
    }
    expect(at(100 + to + 1)).toBe(true);
    // A cancel_boat starts the same window.
    s.begin(200, { perSecond: 10, perMinute: 150 }, rich());
    s.offer(
      proposal("boat", Prio.Emergency, {
        intent: { type: "cancel_boat", unitID: 7 },
      }),
    );
    s.flush(send, ledger, 200);
    expect(at(220)).toBe(false);
  });

  test("refuses everything before begin", () => {
    const s = new Scheduler(o, MS_PER_TICK);
    expect(s.offer(proposal("tn", Prio.TN))).toBe(false);
    expect(s.lastRefusal).toBe("notBegun");
  });

  test("dedupes by key within a tick, and only against accepted proposals", () => {
    const s = new Scheduler(o, MS_PER_TICK);
    s.begin(10, { perSecond: 10, perMinute: 150 }, createPurse(20_000, FLOORS));
    const big = proposal("tribe", Prio.Tribe, {
      key: "attack:7",
      spend: { kind: "tribe", troops: 50_000 },
    });
    expect(s.offer(big)).toBe(false); // purse refusal: key not taken
    const fits = proposal("tribe", Prio.Tribe, { key: "attack:7" });
    expect(s.offer(fits)).toBe(true);
    expect(s.offer(proposal("tribe", Prio.Tribe, { key: "attack:7" }))).toBe(
      false,
    );
    expect(s.lastRefusal).toBe("key");
    expect(s.offer(proposal("tribe", Prio.Tribe, { key: "attack:8" }))).toBe(
      true,
    );
    // A new tick forgets the keys.
    s.begin(11, { perSecond: 10, perMinute: 150 }, rich());
    expect(s.offer(proposal("tribe", Prio.Tribe, { key: "attack:7" }))).toBe(
      true,
    );
  });

  test("low priorities leave the reserves; Emergency and Recall may use them", () => {
    const s = new Scheduler(o, MS_PER_TICK);
    s.begin(0, { perSecond: 10, perMinute: 150 }, rich());
    let low = 0;
    while (s.offer(proposal("snack", Prio.Snack))) low++;
    expect(low).toBe(10 - o.reservePerSecond);
    expect(s.lastRefusal).toBe("budget");
    expect(s.offer(proposal("defense", Prio.Recall))).toBe(true);
    expect(s.offer(proposal("defense", Prio.Emergency))).toBe(true);
    expect(s.offer(proposal("defense", Prio.Emergency))).toBe(false);
    expect(s.lastRefusal).toBe("budget");

    // The per-minute reserve binds the same way.
    s.begin(1, { perSecond: 10, perMinute: 17 }, rich());
    expect(s.offer(proposal("tn", Prio.TN))).toBe(true);
    expect(s.offer(proposal("tn", Prio.TN))).toBe(true);
    expect(s.offer(proposal("tn", Prio.TN))).toBe(false);
    expect(s.offer(proposal("defense", Prio.Recall))).toBe(true);
  });

  test("a refused offer debits nothing; an accepted one debits the purse at once", () => {
    const s = new Scheduler(o, MS_PER_TICK);
    const purse = createPurse(50_000, FLOORS);
    s.begin(0, { perSecond: 3, perMinute: 150 }, purse);
    const p = () =>
      proposal("tribe", Prio.Tribe, {
        spend: { kind: "tribe", troops: 5_000 },
      });
    expect(s.offer(p())).toBe(true);
    expect(purse.home).toBe(45_000);
    expect(s.offer(p())).toBe(false); // 3 − 1 used − 2 reserve = 0 left
    expect(s.lastRefusal).toBe("budget");
    expect(purse.home).toBe(45_000);
  });

  test("class caps count the last minute of game time, this tick's acceptances included", () => {
    const s = new Scheduler(
      { ...o, classCapsPerMinute: { tn: 3 } },
      MS_PER_TICK,
    );
    const { ledger, sends } = recorder();
    const send = (): SendResult => "ok";
    s.begin(100, { perSecond: 10, perMinute: 150 }, rich());
    expect(s.offer(proposal("tn", Prio.TN))).toBe(true);
    expect(s.offer(proposal("tn", Prio.TN))).toBe(true);
    s.flush(send, ledger, 100);
    s.begin(101, { perSecond: 10, perMinute: 150 }, rich());
    expect(s.offer(proposal("tn", Prio.TN))).toBe(true);
    expect(s.offer(proposal("tn", Prio.TN))).toBe(false);
    expect(s.lastRefusal).toBe("classCap");
    expect(s.offer(proposal("tribe", Prio.Tribe))).toBe(true); // uncapped class
    s.flush(send, ledger, 101);
    // Tick 100's two sends leave the window 600 ticks later, tick 101's one
    // tick after that.
    s.begin(
      100 + TICKS_PER_MINUTE - 1,
      { perSecond: 10, perMinute: 150 },
      rich(),
    );
    expect(s.offer(proposal("tn", Prio.TN))).toBe(false);
    s.begin(100 + TICKS_PER_MINUTE, { perSecond: 10, perMinute: 150 }, rich());
    expect(s.offer(proposal("tn", Prio.TN))).toBe(true);
    expect(s.offer(proposal("tn", Prio.TN))).toBe(true);
    expect(s.offer(proposal("tn", Prio.TN))).toBe(false);
    expect(sends).toHaveLength(4);
  });

  test("hasKey sees this tick's accepted keys only", () => {
    const s = new Scheduler(o, MS_PER_TICK);
    s.begin(5, { perSecond: 10, perMinute: 150 }, rich());
    expect(s.offer(proposal("tribe", Prio.Tribe, { key: "attack:7" }))).toBe(
      true,
    );
    expect(s.hasKey("attack:7")).toBe(true);
    expect(s.hasKey("attack:8")).toBe(false);
    expect(s.lastSent("tribe")).toBeNull();
    s.flush(() => "ok", recorder().ledger, 5);
    s.begin(6, { perSecond: 10, perMinute: 150 }, rich());
    expect(s.hasKey("attack:7")).toBe(false);
    expect(s.lastSent("tribe")).toBe(5);
    s.begin(5 + TICKS_PER_MINUTE, { perSecond: 10, perMinute: 150 }, rich());
    expect(s.lastSent("tribe")).toBeNull();
  });

  test("paceOk: a send now is refused when the cadence after it would hit the class cap before the window frees it", () => {
    // tn capped at 30 a minute, a cadence of one send per 21 ticks (28.6 a
    // minute): with the window empty a send now fits (1 + 28 ≤ 30); a
    // burst of sends 12 ticks apart is refused by paceOk before the cap
    // stops it, and a stream that sends early only while paceOk allows
    // never meets the cap.
    const cap = 30;
    const s = new Scheduler(
      { ...o, classCapsPerMinute: { tn: cap } },
      MS_PER_TICK,
    );
    const send = (): SendResult => "ok";
    const { ledger } = recorder();
    s.begin(0, { perSecond: 10, perMinute: 150 }, rich());
    expect(s.paceOk("tn", 0, 21)).toBe(true);
    expect(s.paceOk("tribe", 0, 1)).toBe(true); // uncapped
    // An unpaced burst: a send every 12 ticks while paceOk would refuse
    // them, until the cap refuses.
    let t = 0;
    let refusedByPace = -1;
    let stalled = -1;
    for (; t < 2 * TICKS_PER_MINUTE; t += 12) {
      s.begin(t, { perSecond: 10, perMinute: 150 }, rich());
      if (refusedByPace < 0 && !s.paceOk("tn", t, 21)) refusedByPace = t;
      if (!s.offer(proposal("tn", Prio.TN))) {
        stalled = t;
        break;
      }
      s.flush(send, ledger, t);
    }
    expect(refusedByPace).toBeGreaterThanOrEqual(0);
    expect(refusedByPace).toBeLessThan(stalled);
    expect(stalled).toBeLessThan(TICKS_PER_MINUTE);
    // A paced stream: early sends only while paceOk, else every 21 ticks.
    const p = new Scheduler(
      { ...o, classCapsPerMinute: { tn: cap } },
      MS_PER_TICK,
    );
    let last = -Infinity;
    let sent = 0;
    for (let tick = 0; tick < 5 * TICKS_PER_MINUTE; tick += 3) {
      p.begin(tick, { perSecond: 10, perMinute: 150 }, rich());
      const due =
        tick - last >= 20 || (tick - last >= 12 && p.paceOk("tn", tick, 21));
      if (!due) continue;
      expect(p.offer(proposal("tn", Prio.TN))).toBe(true);
      p.flush(send, ledger, tick);
      last = tick;
      sent++;
    }
    expect(sent).toBeGreaterThan(5 * 28);
  });

  test("an unflushed proposal counts toward nothing and is dropped at the next begin", () => {
    const s = new Scheduler(
      { ...o, classCapsPerMinute: { tn: 1 } },
      MS_PER_TICK,
    );
    s.begin(0, { perSecond: 10, perMinute: 150 }, rich());
    expect(s.offer(proposal("tn", Prio.TN))).toBe(true);
    s.begin(1, { perSecond: 10, perMinute: 150 }, rich());
    expect(s.offer(proposal("tn", Prio.TN))).toBe(true);
    const { ledger, sends } = recorder();
    s.flush(() => "ok", ledger, 1);
    expect(sends).toHaveLength(1);
  });

  test("flush sends in priority order (offer order within a priority) and records plan and meta", () => {
    const s = new Scheduler(o, MS_PER_TICK);
    s.begin(42, { perSecond: 10, perMinute: 150 }, rich());
    const offers: Proposal[] = [
      { intent: attack(1), cls: "build", prio: Prio.Build },
      { intent: attack(2), cls: "tribe", prio: Prio.Tribe, plan: "tribe" },
      {
        intent: attack(3, "N1"),
        cls: "snack",
        prio: Prio.Snack,
        plan: "snack",
        meta: { target: 9, expectedRefund: 250 },
      },
      { intent: attack(4), cls: "tn", prio: Prio.TN, plan: "tn" },
      { intent: attack(5), cls: "tribe", prio: Prio.Tribe },
      { intent: attack(6), cls: "defense", prio: Prio.Recall },
    ];
    for (const p of offers) expect(s.offer(p)).toBe(true);
    const sent: AgentIntent[] = [];
    const { ledger, sends } = recorder();
    s.flush(
      (i) => {
        sent.push(i);
        return "ok";
      },
      ledger,
      42,
    );
    const troops = (i: AgentIntent) => (i.type === "attack" ? i.troops : -1);
    expect(sent.map(troops)).toEqual([6, 3, 4, 2, 5, 1]);
    expect(sends.map((r) => [troops(r.intent), r.tick, r.kind])).toEqual([
      [6, 42, null],
      [3, 42, "snack"],
      [4, 42, "tn"],
      [2, 42, "tribe"],
      [5, 42, null],
      [1, 42, null],
    ]);
    expect(sends[1].meta).toEqual({ target: 9, expectedRefund: 250 });
    // A second flush has nothing left to send.
    s.flush(
      (i) => {
        sent.push(i);
        return "ok";
      },
      ledger,
      42,
    );
    expect(sent).toHaveLength(6);
  });

  test("flush into a real Ledger: plans and sentThisTick follow the accepted sends", () => {
    const s = new Scheduler(o, MS_PER_TICK);
    const ledger = new Ledger();
    s.begin(50, { perSecond: 10, perMinute: 150 }, createPurse(60_000, FLOORS));
    expect(
      s.offer({
        intent: attack(4_000, "TRIBE009"),
        cls: "tribe",
        prio: Prio.Tribe,
        key: "attack:9",
        spend: { kind: "tribe", troops: 4_000 },
        plan: "tribe",
        meta: { target: 9, clampTroops: 3_500, expectedRefund: 900 },
      }),
    ).toBe(true);
    expect(
      s.offer({
        intent: attack(9_000, null),
        cls: "tn",
        prio: Prio.TN,
        key: "attack:0",
        spend: { kind: "tn", troops: 9_000 },
        plan: "tn",
        meta: { target: 0 },
      }),
    ).toBe(true);
    s.flush(() => "ok", ledger, 50);
    expect(ledger.sentThisTick().map((i) => i.type)).toEqual([
      "attack",
      "attack",
    ]);
    expect(ledger.plan(9)).toMatchObject({
      kind: "tribe",
      launchedAt: 50,
      clampTroops: 3_500,
      expectedRefund: 900,
    });
    expect(ledger.plan(0)).toMatchObject({ kind: "tn", launchedAt: 50 });
    expect(ledger.stackOn(9)).toBe(4_000);
    expect(ledger.stackOn(0)).toBe(9_000);
    expect(ledger.expectedRefunds()).toBe(900);
  });

  test("a rate-limited send is logged, ends the flush and is not recorded; invalid ones are skipped", () => {
    const s = new Scheduler(o, MS_PER_TICK);
    s.begin(7, { perSecond: 10, perMinute: 150 }, rich());
    for (let i = 0; i < 4; i++) s.offer(proposal("tn", Prio.TN));
    const results: SendResult[] = ["invalid", "ok", "rate_limited", "ok"];
    let calls = 0;
    const { ledger, sends } = recorder();
    s.flush(() => results[calls++], ledger, 7);
    expect(calls).toBe(3);
    expect(sends).toHaveLength(1);
    expect(s.stats).toMatchObject({ sent: 1, invalid: 1, rateLimited: 1 });
    const log = s.takeLog();
    expect(log).toHaveLength(2);
    expect(log[1]).toMatch(/rate limited.*dropped 2 of 4/);
    expect(s.takeLog()).toEqual([]);
  });

  test("a random proposal stream over 10 game minutes is never rate limited, keeps the reserves for Emergency and Recall, and holds every class cap", () => {
    const rng = new PseudoRandom(20260926);
    let nowMs = 0;
    const budget = new IntentBudget(() => nowMs);
    const s = new Scheduler(o, MS_PER_TICK);
    const { ledger } = recorder();
    const low: [IntentClass, Prio][] = [
      ["snack", Prio.Snack],
      ["topup", Prio.TopUp],
      ["strike", Prio.Strike],
      ["tn", Prio.TN],
      ["tribe", Prio.Tribe],
      ["boat", Prio.Boat],
      ["diplomacy", Prio.Diplomacy],
      ["build", Prio.Build],
    ];
    let rateLimited = 0;
    let highOffered = 0;
    let highAccepted = 0;
    let lowSent = 0;
    let budgetRefusals = 0;
    // Fixed per-minute windows of the IntentBudget start at tick 0.
    const perWindow = new Map<number, number>();

    for (let tick = 0; tick < 10 * TICKS_PER_MINUTE; tick++) {
      nowMs = tick * MS_PER_TICK;
      const atBegin = budget.remaining();
      s.begin(tick, atBegin, rich());
      const offers: Proposal[] = [];
      // Emergencies at most 14 a minute, never more than 2 in one tick:
      // inside the reserves (2/s, 15/min).
      if (tick % 50 === 7) {
        const n = tick % 300 === 7 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          offers.push(
            proposal("defense", i === 0 ? Prio.Recall : Prio.Emergency),
          );
        }
      }
      // Low priorities: a few a tick, with bursts far over the budget.
      const n = rng.chance(40) ? rng.nextInt(20, 60) : rng.nextInt(0, 5);
      for (let i = 0; i < n; i++) {
        const [cls, prio] = low[rng.nextInt(0, low.length)];
        offers.push(proposal(cls, prio));
      }
      // Controllers offer in their own order; shuffle so the emergencies
      // often come after the budget is spoken for.
      let highThisTick = 0;
      for (const p of rng.shuffleArray(offers)) {
        const high = p.prio < Prio.Snack;
        const ok = s.offer(p);
        if (high) {
          highOffered++;
          highThisTick++;
          if (ok) highAccepted++;
        } else if (!ok && s.lastRefusal === "budget") {
          budgetRefusals++;
        }
      }
      s.flush(
        () => {
          if (!budget.tryConsume()) {
            rateLimited++;
            return "rate_limited";
          }
          return "ok";
        },
        ledger,
        tick,
      );
      const after = budget.remaining();
      const used = atBegin.perMinute - after.perMinute;
      const w = Math.floor(tick / TICKS_PER_MINUTE);
      perWindow.set(w, (perWindow.get(w) ?? 0) + used);
      if (highThisTick === 0) {
        expect(after.perSecond).toBeGreaterThanOrEqual(
          Math.min(o.reservePerSecond, atBegin.perSecond),
        );
        expect(after.perMinute).toBeGreaterThanOrEqual(
          Math.min(o.reservePerMinute, atBegin.perMinute),
        );
      }
      lowSent += used - highThisTick;
    }

    expect(rateLimited).toBe(0);
    expect(s.stats.rateLimited).toBe(0);
    expect(highAccepted).toBe(highOffered);
    expect(highOffered).toBeGreaterThan(100);
    // The stream really pressed on the budget: low priorities were refused
    // for it, and still used nearly all that the reserves leave them.
    expect(budgetRefusals).toBeGreaterThan(1000);
    expect(lowSent).toBeGreaterThan(
      0.9 * 10 * (INTENTS_PER_MINUTE - o.reservePerMinute),
    );
    for (const count of perWindow.values()) {
      expect(count).toBeLessThanOrEqual(INTENTS_PER_MINUTE);
    }
  });

  test("a random stream under an unlimited budget holds every class cap in every minute-long window", () => {
    const rng = new PseudoRandom(7);
    const caps = o.classCapsPerMinute;
    const s = new Scheduler(o, MS_PER_TICK);
    const classes = Object.keys(caps) as IntentClass[];
    const sent = new Map<IntentClass, number[]>();
    const { ledger } = recorder();
    for (let tick = 0; tick < 10 * TICKS_PER_MINUTE; tick++) {
      // An unlimited budget, so only the class caps bind.
      s.begin(tick, { perSecond: Infinity, perMinute: Infinity }, rich());
      const current: Proposal[] = [];
      const n = rng.nextInt(0, 4);
      for (let i = 0; i < n; i++) {
        const cls = classes[rng.nextInt(0, classes.length)];
        const p = proposal(cls, Prio.Tribe);
        if (s.offer(p)) current.push(p);
      }
      s.flush(() => "ok", ledger, tick);
      for (const p of current) {
        const list = sent.get(p.cls) ?? [];
        list.push(tick);
        sent.set(p.cls, list);
      }
    }
    for (const cls of classes) {
      const ticks = sent.get(cls) ?? [];
      const cap = caps[cls]!;
      // Somewhere the cap was reached (the stream offers ~3.3 a minute
      // above every cap)...
      let peak = 0;
      // ...and no window of 600 consecutive ticks holds more than the cap.
      for (let i = 0, j = 0; i < ticks.length; i++) {
        while (ticks[i] - ticks[j] >= TICKS_PER_MINUTE) j++;
        peak = Math.max(peak, i - j + 1);
      }
      expect(peak).toBeLessThanOrEqual(cap);
      expect(peak).toBe(cap);
    }
  });
});
