import {
  homeFloors,
  HomeTargetInputs,
} from "../../../src/agent/agents/apex/HomeTarget";
import { parseApexOptions } from "../../../src/agent/agents/apex/options";
import { createState } from "../../../src/agent/agents/apex/state";
import { Models } from "../../../src/agent/lib/Models";
import {
  NationModel,
  NationState,
  sendCapSafe,
} from "../../../src/agent/lib/NationModel";
import { Difficulty, Player } from "../../../src/core/game/Game";

// The §3.1 formula over stand-ins for Models and NationModel (their real
// implementations have their own tests): the cap is 100k, and nation N's
// home troops at its next decision are `troops[N]`.
const CAP = 100_000;

function inputs(
  troops: Record<string, number>,
  bordering: string[],
  options: Record<string, unknown> = {},
  difficulty: Difficulty = Difficulty.Impossible,
): HomeTargetInputs {
  const models = { cap: () => CAP } as unknown as Models;
  const nm = {
    get: (id: string) =>
      id in troops
        ? ({ sharesBorderWithUs: bordering.includes(id) } as NationState)
        : undefined,
    nextDecision: (_id: string, from: number) => from + 7,
    sendCapSafe: () => sendCapSafe(difficulty),
    troopsAt: (id: string, d: number) => {
      expect(d).toBe(107);
      return troops[id];
    },
  } as unknown as NationModel;
  return {
    tick: 100,
    o: parseApexOptions(options),
    me: {} as Player,
    models,
    nm,
  };
}

describe("apex HomeTarget (§3.1)", () => {
  test("without food, H is homeX of the cap and the TN floor dips to tnKeep", () => {
    const f = homeFloors(inputs({}, []), createState());
    expect(f.cap).toBe(CAP);
    expect(f.econ).toBeCloseTo(30_000);
    expect(f.vw).toBeCloseTo(17_000);
    expect(f.food).toBe(0);
    expect(f.H).toBeCloseTo(30_000);
    expect(f.tn).toBeCloseTo(17_000); // max(vw, 0.5·30k)
    expect(f.strike).toBeCloseTo(30_000);
  });

  test("a bordering food nation raises H to (T + 1)/1.1·foodMargin", () => {
    const s = createState();
    s.web.food = ["A", "B", "C"];
    // A borders us; B does not; C is unknown to the model.
    const f = homeFloors(inputs({ A: 40_000, B: 45_000 }, ["A"]), s);
    expect(f.food).toBeCloseTo((40_001 / 1.1) * 1.05);
    expect(f.H).toBeCloseTo(f.food);
    expect(f.tn).toBeCloseTo(Math.max(17_000, 0.5 * f.food));
    expect(s.web.food).toEqual(["A", "B", "C"]);
  });

  test("a food term above detCap·cap drops the nation from the list", () => {
    const s = createState();
    s.web.food = ["A", "B", "C"];
    const f = homeFloors(
      inputs({ A: 40_000, B: 60_000, C: 10_000 }, ["A", "B", "C"]),
      s,
    );
    expect(s.web.food).toEqual(["A", "C"]);
    expect(f.food).toBeCloseTo((40_001 / 1.1) * 1.05);
  });

  test("the food floor's divisor is the difficulty's send-cap line: 1.1, 0.95 at Hard, none at Medium", () => {
    // troopSendCap retains 0.9·H (Impossible) or 0.75·H (Hard), and
    // isAttackTooWeak needs 0.2·H [PIN NationSendCap]; at Easy and Medium
    // neither applies, so no home deters.
    expect(sendCapSafe(Difficulty.Impossible)).toBeCloseTo(1.1);
    expect(sendCapSafe(Difficulty.Hard)).toBeCloseTo(0.95);
    expect(sendCapSafe(Difficulty.Medium)).toBe(Infinity);
    expect(sendCapSafe(Difficulty.Easy)).toBe(Infinity);
    const hard = createState();
    hard.web.food = ["A"];
    const f = homeFloors(
      inputs({ A: 40_000 }, ["A"], {}, Difficulty.Hard),
      hard,
    );
    expect(f.food).toBeCloseTo((40_001 / 0.95) * 1.05);
    const medium = createState();
    medium.web.food = ["A"];
    const g = homeFloors(
      inputs({ A: 40_000 }, ["A"], {}, Difficulty.Medium),
      medium,
    );
    expect(g.food).toBe(0);
    expect(g.H).toBeCloseTo(30_000);
    expect(medium.web.food).toEqual(["A"]);
  });

  test("the floors follow the options", () => {
    const f = homeFloors(
      inputs({}, [], { homeX: 0.25, vwGuard: 0.2, tnKeep: 0.4 }),
      createState(),
    );
    expect(f.H).toBeCloseTo(25_000);
    expect(f.vw).toBeCloseTo(20_000);
    expect(f.tn).toBeCloseTo(20_000); // max(20k, 0.4·25k)
  });
});
