import {
  conquestStack,
  isVulture,
  minimumStack,
  planStrike,
  postLossFactor,
  retaliationBound,
  retreatReason,
  STRIKE_WINDOW_NAMES,
  StrikeSizing,
  strikeTopUp,
  strikeWindows,
  strikeYield,
  topUpReason,
  WindowInput,
} from "../../../src/agent/lib/StrikeWindows";

// The strike windows of spec §5.2.2 and the sizing of §5.2.3 on constructed
// nation states (docs/13-mechanics.md §2.8, §5.7-5.8): one case per window,
// its negative, and the stack rules. The live counterpart is
// Strikes.test.ts (a W1 strike on a real NationExecution draws no answer).

const O: StrikeSizing = {
  windows: STRIKE_WINDOW_NAMES,
  vultureDrop: 0.3,
  vultureLow: 0.15,
  vultureIncoming: 0.5,
  decoyMargin: 1.2,
  ratio: 0.6,
  margin: 1.1,
  maxRatio: 1,
};

/** A nation of cap 1M at 70% (above its 0.55 trigger), nothing attacking
 *  it, not locked: no window but overwhelm. */
function nation(over: Partial<WindowInput> = {}): WindowInput {
  return {
    reserve: 0.35,
    trigger: 0.55,
    M: 1_000_000,
    T: 700_000,
    T1: 700_000,
    locked1: false,
    Tprev: 700_000,
    incomingOthers: 0,
    largestOther: 0,
    ...over,
  };
}

const only = (w: (typeof STRIKE_WINDOW_NAMES)[number]): StrikeSizing => ({
  ...O,
  windows: [w],
});

describe("StrikeWindows: one window each", () => {
  test("retaliationBound is T − reserve·M, 0 below the reserve", () => {
    expect(retaliationBound(700_000, 0.35, 1_000_000)).toBe(350_000);
    expect(retaliationBound(300_000, 0.35, 1_000_000)).toBe(0);
  });

  test("W1: troops at its next decision below reserve·M; no answer", () => {
    const inp = nation({ T: 330_000, T1: 349_999 });
    const v = strikeWindows(inp, 400_000, only("W1"));
    expect(v.open).toEqual(["W1"]);
    expect(v.window).toBe("W1");
    expect(v.answer).toBe(0);
    // At the reserve exactly it may answer: no W1.
    expect(
      strikeWindows(nation({ T1: 350_000 }), 400_000, only("W1")).window,
    ).toBeNull();
  });

  test("W2: its next decision is locked (free land first); no answer", () => {
    const v = strikeWindows(nation({ locked1: true }), 800_000, only("W2"));
    expect(v.window).toBe("W2");
    expect(v.answer).toBe(0);
    expect(strikeWindows(nation(), 800_000, only("W2")).window).toBeNull();
  });

  test("W3: below trigger·M; it answers 1 decision in 10, so the stack is sized for the answer", () => {
    const inp = nation({ T1: 549_999 });
    const v = strikeWindows(inp, 800_000, only("W3"));
    expect(v.window).toBe("W3");
    expect(v.answer).toBe(549_999 - 350_000);
    expect(
      strikeWindows(nation({ T1: 550_000 }), 800_000, only("W3")).window,
    ).toBeNull();
  });

  test("W5 vulture: down 30% since its last decision, under 15% of cap, or attacked by more than half its troops", () => {
    const drop = nation({ Tprev: 1_000_000, T: 700_000 });
    expect(isVulture(drop, O)).toBe(true);
    expect(strikeWindows(drop, 800_000, only("W5")).window).toBe("W5");
    expect(isVulture(nation({ Tprev: 1_000_000, T: 700_001 }), O)).toBe(false);
    expect(isVulture(nation({ T: 149_999, Tprev: null }), O)).toBe(true);
    expect(isVulture(nation({ incomingOthers: 350_001 }), O)).toBe(true);
    expect(isVulture(nation({ incomingOthers: 350_000 }), O)).toBe(false);
    // A vulture may still answer: the stack is sized for it.
    expect(strikeWindows(drop, 800_000, only("W5")).answer).toBe(350_000);
    expect(strikeWindows(nation(), 800_000, only("W5")).window).toBeNull();
  });

  test("W6 decoy: another attack at least 1.2× ours takes its answer", () => {
    const inp = nation({ largestOther: 1_200_000 });
    const v = strikeWindows(inp, 1_000_000, only("W6"));
    expect(v.window).toBe("W6");
    expect(v.answer).toBe(0);
    // A larger stack of ours would draw the answer itself.
    expect(strikeWindows(inp, 1_000_001, only("W6")).window).toBeNull();
  });

  test("overwhelm: our stack beats the answer T1 − reserve·M", () => {
    const v = strikeWindows(nation(), 350_001, only("overwhelm"));
    expect(v.window).toBe("overwhelm");
    expect(v.answer).toBe(350_000);
    expect(
      strikeWindows(nation(), 350_000, only("overwhelm")).window,
    ).toBeNull();
  });

  test("a no-answer window is the one the strike is sized by, and disabled windows never open", () => {
    const inp = nation({ T1: 300_000, T: 300_000, Tprev: 300_000 });
    const v = strikeWindows(inp, 600_000, O);
    expect(v.open).toEqual(["W1", "W3", "overwhelm"]);
    expect(v.window).toBe("W1");
    expect(v.answer).toBe(0);
    expect(strikeWindows(inp, 600_000, { ...O, windows: [] }).window).toBe(
      null,
    );
  });
});

describe("StrikeWindows: the stack", () => {
  test("conquestStack: the answer cancels 1:1, the rest at the 0.6 ratio with margin, plus its attacks on us", () => {
    expect(conquestStack(600_000, 0, 0, O)).toBeCloseTo(1_100_000, 6);
    expect(conquestStack(600_000, 0, 50_000, O)).toBeCloseTo(1_150_000, 6);
    // An answer of 300k: 300k + 300k/0.6·1.1.
    expect(conquestStack(600_000, 300_000, 0, O)).toBeCloseTo(850_000, 6);
    // The answer never exceeds its troops.
    expect(conquestStack(100_000, 300_000, 0, O)).toBeCloseTo(100_000, 6);
  });

  test("minimumStack: at most maxRatio of its troops to ours after the answer", () => {
    expect(minimumStack(600_000, 0, 0, 1)).toBe(600_000);
    expect(minimumStack(600_000, 200_000, 10_000, 2)).toBe(410_000);
  });

  test("planStrike: the full conquest stack when the purse pays for it", () => {
    const p = planStrike(nation(), 0, 5_000_000, O);
    expect(p.S).toBe(Math.floor((700_000 / 0.6) * 1.1));
    expect(p.verdict.window).toBe("overwhelm");
    expect(p.want).toBeCloseTo((700_000 / 0.6) * 1.1, 6);
  });

  test("planStrike: a purse-limited stack at ratio ≤ maxRatio still goes, a smaller one does not", () => {
    const p = planStrike(nation(), 0, 700_000, O);
    expect(p.S).toBe(700_000);
    expect(p.min).toBe(700_000);
    expect(planStrike(nation(), 0, 699_999, O).S).toBe(0);
  });

  test("planStrike: without overwhelm, a nation above its trigger is never struck, one below its reserve is", () => {
    const quiet = { ...O, windows: O.windows.filter((w) => w !== "overwhelm") };
    expect(planStrike(nation(), 0, 5_000_000, quiet).S).toBe(0);
    const low = nation({ T: 300_000, T1: 320_000 });
    const p = planStrike(low, 0, 5_000_000, quiet);
    expect(p.verdict.window).toBe("W1");
    expect(p.S).toBe(Math.floor((320_000 / 0.6) * 1.1));
  });

  test("planStrike: the kill cost raises the stack for a thinly held nation", () => {
    const thin = nation({ T: 100_000, T1: 100_000 });
    const p = planStrike(thin, 0, 5_000_000, O, 400_000);
    // Answer bound 0 (below its reserve) + 400k·1.1.
    expect(p.S).toBe(440_000);
  });

  test("planStrike: the nation's attacks on us are paid on top, and a stack that cannot beat the answer after them is refused", () => {
    const p = planStrike(nation(), 100_000, 5_000_000, O);
    expect(p.S).toBe(Math.floor((700_000 / 0.6) * 1.1 + 100_000));
    // 800k budget: 700k left after the cancel, over the 350k answer and at
    // ratio 1 — goes; 799,999 does not reach the minimum stack.
    expect(planStrike(nation(), 100_000, 800_000, O).S).toBe(800_000);
    expect(planStrike(nation(), 100_000, 799_999, O).S).toBe(0);
  });

  test("strikeTopUp: raises a short stack to the need before the decision, within the budget", () => {
    const o = { ratio: 0.6, margin: 1.1, topUpAt: 0.95 };
    const need = conquestStack(600_000, 0, 0, o);
    expect(strikeTopUp(need, 600_000, 0, 0, 1e9, o)).toBe(0);
    expect(strikeTopUp(0.95 * need, 600_000, 0, 0, 1e9, o)).toBe(0);
    expect(strikeTopUp(500_000, 600_000, 0, 0, 1e9, o)).toBe(
      Math.floor(need - 500_000),
    );
    expect(strikeTopUp(500_000, 600_000, 0, 0, 10_000, o)).toBe(10_000);
  });
});

describe("StrikeWindows: posts and reviews (o.strikePosts, o.strikeRetreat)", () => {
  test("postLossFactor: the posted share of the front costs bonus× a tile", () => {
    expect(postLossFactor(0, 5)).toBe(1);
    expect(postLossFactor(1, 5)).toBe(5);
    expect(postLossFactor(0.5, 5)).toBe(3);
    // Clamped to [0, 1].
    expect(postLossFactor(-1, 5)).toBe(1);
    expect(postLossFactor(2, 5)).toBe(5);
  });

  test("retreatReason: never while the stack can kill; posts first, then a hopeless ratio", () => {
    const o = { postCover: 0.5, ratio: 1.5 };
    const r = { cover: 0, T: 1_000_000, A: 1_000_000, kill: false };
    expect(retreatReason(r, o)).toBeNull();
    expect(retreatReason({ ...r, cover: 0.5 }, o)).toBe("posts");
    expect(retreatReason({ ...r, cover: 0.49 }, o)).toBeNull();
    expect(retreatReason({ ...r, T: 1_500_000 }, o)).toBe("ratio");
    expect(retreatReason({ ...r, T: 1_499_999 }, o)).toBeNull();
    expect(retreatReason({ ...r, cover: 1, T: 9e9, kill: true }, o)).toBeNull();
    // Nothing of ours left to call back.
    expect(retreatReason({ ...r, cover: 1, A: 0 }, o)).toBeNull();
  });
});

describe("StrikeWindows: yield and top-up saves (review of A1)", () => {
  // A stack of 1M on a 20,000-tile nation, 200k of it cancelled by the
  // answer and the nation's attacks on us (left 800k), 40 troops a tile.
  const S = 1_000_000;
  const left = 800_000;

  test("strikeYield: a kill needs all but the annex line reachable and paid for; the rest comes home", () => {
    // 20,000 tiles, 19,901 to pay for: 796,040 <= 800,000.
    const y = strikeYield(S, left, 40, 20_000, Infinity, 99);
    expect(y).toMatchObject({ kill: true, pocket: false, tiles: 20_000 });
    expect(y.spent).toBeCloseTo(40 * 19_901 + 200_000, 6);
    expect(y.refund).toBeCloseTo(left - 40 * 19_901, 6);
    // Reachable exactly to the line: still a kill; one tile short: not.
    expect(strikeYield(S, left, 40, 20_000, 19_901, 99).kill).toBe(true);
    expect(strikeYield(S, left, 40, 20_000, 19_900, 99).kill).toBe(false);
    // Paid one troop short: it burns out.
    const short = strikeYield(S, 796_039, 40, 20_000, Infinity, 99);
    expect(short).toMatchObject({ kill: false, pocket: false, spent: S });
    expect(short.refund).toBe(0);
  });

  test("strikeYield: a pocket smaller than the stack pays for is taken whole and the rest comes home", () => {
    // 1,100 reachable of 63,000 (arena quick@20 g4: Leafer).
    const y = strikeYield(S, left, 40, 63_000, 1_100, 99);
    expect(y).toMatchObject({ kill: false, pocket: true, tiles: 1_100 });
    expect(y.spent).toBe(40 * 1_100 + 200_000);
    expect(y.refund).toBe(left - 40 * 1_100);
    // As many reachable as it pays for: it burns out on them.
    const burn = strikeYield(S, left, 40, 63_000, 20_000, 99);
    expect(burn).toMatchObject({ kill: false, pocket: false, tiles: 20_000 });
    expect(burn.spent).toBe(S);
    // Unmeasured reach (Infinity): left/p tiles, all of it spent.
    expect(strikeYield(S, left, 40, 63_000, Infinity, 99)).toMatchObject({
      pocket: false,
      tiles: 20_000,
      spent: S,
      refund: 0,
    });
  });

  test("strikeYield: nothing left after the cancels buys nothing", () => {
    expect(strikeYield(S, 0, 40, 500, Infinity, 99)).toMatchObject({
      kill: false,
      pocket: false,
      tiles: 0,
      spent: S,
      refund: 0,
    });
  });

  // Td 600k with a 0.35 reserve on a 1M cap: answer 250k; need is the
  // conquest stack for it.
  const base = {
    A: 100_000,
    add: 200_000,
    need: conquestStack(600_000, 250_000, 0, O),
    Td: 600_000,
    answer: 250_000,
    inc: 0,
  };
  const opts = { maxRatio: 1, minShare: 0.25, saveOpenOnly: false };

  test("topUpReason: the ratio rule, then the save", () => {
    // Enough to reach ratio 1 after the answer and a quarter of the need.
    expect(
      topUpReason({ ...base, add: 500_000 }, opts, true, () => false),
    ).toBe("ratio");
    // 300k < 600k: not within maxRatio, but lifts 100k over the 250k answer.
    expect(topUpReason(base, opts, false, () => false)).toBe("save");
    // Does not lift it over the answer: nothing.
    expect(
      topUpReason({ ...base, add: 150_000 }, opts, true, () => true),
    ).toBeNull();
    // Already above the answer: no save to make.
    expect(
      topUpReason({ ...base, A: 260_000 }, opts, true, () => true),
    ).toBeNull();
  });

  test("topUpReason with saveOpenOnly: a save only where the answer is certain and the saved stack keeps maxRatio or kills", () => {
    const o = { ...opts, saveOpenOnly: true };
    let asked = 0;
    const kills = (k: boolean) => () => {
      asked++;
      return k;
    };
    // Below trigger (open false): never, and the kill test is not run.
    expect(topUpReason(base, o, false, kills(true))).toBeNull();
    expect(asked).toBe(0);
    // Open, far above maxRatio (ratio 350k/50k = 7 after the answer): only
    // if it can kill.
    expect(topUpReason(base, o, true, kills(false))).toBeNull();
    expect(topUpReason(base, o, true, kills(true))).toBe("save");
    // Open and within maxRatio but under the ratio rule's minimum share of
    // the need: a save.
    const big = { ...base, need: 10_000_000, add: 500_000 };
    expect(topUpReason(big, opts, true, kills(false))).toBe("save");
    expect(topUpReason(big, o, true, kills(false))).toBe("save");
  });
});
