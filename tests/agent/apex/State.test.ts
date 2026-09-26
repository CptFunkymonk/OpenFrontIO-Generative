import {
  createState,
  LOG_LINES,
  stateLog,
} from "../../../src/agent/agents/apex/state";

describe("apex state", () => {
  test("is plain data: structuredClone and JSON keep it whole", () => {
    const s = createState();
    expect(structuredClone(s)).toEqual(s);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  test("each call is independent", () => {
    const a = createState();
    const b = createState();
    a.web.food.push("N1");
    a.timers.lastThink = 5;
    expect(b.web.food).toEqual([]);
    expect(b.timers.lastThink).not.toBe(5);
  });

  test("a new state thinks, plans, builds and sends boats at its first chance", () => {
    const s = createState();
    for (const t of [
      s.timers.lastThink,
      s.web.lastPlan,
      s.timers.lastCity,
      s.timers.lastBoat,
    ])
      expect(0 - t).toBeGreaterThan(1e6);
  });

  test("the log keeps the last LOG_LINES lines", () => {
    const s = createState();
    for (let i = 0; i < LOG_LINES + 5; i++) stateLog(s, `line ${i}`);
    expect(s.log).toHaveLength(LOG_LINES);
    expect(s.log[0]).toBe("line 5");
    expect(s.log[LOG_LINES - 1]).toBe(`line ${LOG_LINES + 4}`);
  });
});
