import {
  IntentBudget,
  INTENTS_PER_MINUTE,
  INTENTS_PER_SECOND,
} from "../../src/agent/IntentBudget";

// The budget must refuse exactly what src/server/ClientMsgRateLimiter would,
// or an agent tuned offline loses intents to silent drops online.
describe("IntentBudget", () => {
  test("allows a burst of 10 per second, then refuses until the next window", () => {
    let now = 0;
    const budget = new IntentBudget(() => now);
    for (let i = 0; i < INTENTS_PER_SECOND; i++) {
      expect(budget.tryConsume()).toBe(true);
    }
    expect(budget.tryConsume()).toBe(false);
    now = 999;
    expect(budget.tryConsume()).toBe(false);
    now = 1000;
    expect(budget.tryConsume()).toBe(true);
  });

  test("sustains 10 per second but caps a minute at 150", () => {
    let now = 0;
    const budget = new IntentBudget(() => now);
    let accepted = 0;
    for (; now < 60_000; now += 100) {
      if (budget.tryConsume()) accepted++;
    }
    expect(accepted).toBe(INTENTS_PER_MINUTE);
    // The minute window restarts at the first request after it expires.
    expect(budget.tryConsume()).toBe(true);
  });

  test("reports what is left without consuming it", () => {
    const budget = new IntentBudget(() => 0);
    budget.tryConsume();
    budget.tryConsume();
    expect(budget.remaining()).toEqual({
      perSecond: INTENTS_PER_SECOND - 2,
      perMinute: INTENTS_PER_MINUTE - 2,
    });
    expect(budget.remaining().perSecond).toBe(INTENTS_PER_SECOND - 2);
  });

  test("a disabled budget never refuses", () => {
    const budget = new IntentBudget(() => 0, false);
    for (let i = 0; i < 1000; i++) expect(budget.tryConsume()).toBe(true);
  });
});
