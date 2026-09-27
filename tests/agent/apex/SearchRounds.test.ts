/**
 * Package WP2 (docs/14-m4-plan.md §2.5): the rounds of a search, on
 * synthetic snapshot series (no game).
 *
 * Claims:
 * - Round 1 drops a plan more than `prune` below the base's tiles at H1,
 *   or dead there.
 * - Judged horizons: a strike now at H, a lapse at ⌈lastSend + H⌉ on the
 *   50-tick grid, a strong target at lastSend + HStrong, a break at its
 *   last step; the base reaches every one of them, and no further.
 * - The stepwise break round drops a break that trails at a step, judges
 *   one that leads at its last step, and extends it to the gated horizon
 *   only when the gate fires: (a) an alliance other than the target's
 *   ended early while we were a traitor, (b) an unallied bordering nation
 *   at ≥ 1.1× our cap in the break world is allied or not bordering in the
 *   base world.
 * - The margin is strict (a gain equal to it keeps the base), ties between
 *   plans keep the first, and the dip guard drops a plan more than `dip`
 *   below the base at a common checkpoint.
 * - Round 2b runs on the base's longest horizon when the base shows an
 *   attacker or a loss over 10%.
 * - With act3's settings the rounds choose what act3 chose on its own
 *   rollouts (Japan g8, ticks 2,400 and 3,600: /tmp/claude-0/search/act3-g8).
 */
import type { Candidate } from "../../../src/agent/lib/search/Registry";
import {
  breakGate,
  Roll,
  RoundsParams,
  roundUp,
  runRounds,
} from "../../../src/agent/lib/search/Rounds";
import type {
  AllianceEnd,
  AttackSeen,
  BorderNation,
  SendState,
} from "../../../src/agent/lib/search/Runner";
import type { Snap } from "../../../src/agent/lib/search/Value";
import type { PlayerID } from "../../../src/core/game/Game";

const GRID = [50, 100, 150, 200, 300, 450, 600, 900, 1200, 1800];

/** Our state at h: tiles, home, out, inc (alive unless tiles < 0). */
type Point = [
  h: number,
  tiles: number,
  home?: number,
  out?: number,
  inc?: number,
];

function snap(p: Point, top = 0): Snap {
  const [h, tiles, home = 0, out = 0, inc = 0] = p;
  return {
    h,
    tiles: Math.max(0, tiles),
    home,
    out,
    inc,
    cap: 0,
    gold: 0,
    alive: tiles >= 0,
    natAtks: 0,
    natTroops: 0,
    rank: 1,
    top,
  };
}

interface FakeInit {
  /** Points at or before each h hold until the next (a step series). */
  points: Point[];
  attackers?: [PlayerID, AttackSeen][];
  sent?: SendState;
  ended?: AllianceEnd[];
  bordering?: BorderNation[];
  allied?: PlayerID[];
  cap?: number;
}

/** A Roll over a step series, advanced as a Runner advances. */
class FakeRoll implements Roll {
  h = 0;
  dead = false;
  readonly snaps: Snap[] = [];
  readonly attackers: Map<PlayerID, AttackSeen>;
  readonly ended: AllianceEnd[];
  readonly land0 = 1000;
  sent: SendState | null = null;
  private readonly grid = new Set(GRID);
  private readonly points: Point[];

  constructor(
    readonly name: string,
    private readonly init: FakeInit,
  ) {
    this.points = [...init.points].sort((a, b) => a[0] - b[0]);
    this.attackers = new Map(init.attackers ?? []);
    this.ended = init.ended ?? [];
  }

  private pointAt(h: number): Point {
    let p = this.points[0];
    for (const x of this.points) if (x[0] <= h) p = x;
    return [h, p[1], p[2], p[3], p[4]];
  }

  advance(to: number, snapEnd = true): Snap {
    while (this.h < to && !this.dead) {
      if (this.init.sent !== undefined && this.h === this.init.sent.h) {
        this.sent = this.init.sent;
      }
      this.h++;
      const p = this.pointAt(this.h);
      if (p[1] < 0) this.dead = true;
      if (this.grid.has(this.h) || this.dead) this.snaps.push(snap(p));
    }
    const last = this.snaps[this.snaps.length - 1];
    if (last !== undefined && (last.h === this.h || !snapEnd)) return last;
    this.snaps.push(snap(this.pointAt(this.h)));
    return this.last();
  }

  last(): Snap {
    return this.snaps[this.snaps.length - 1];
  }

  at(h: number): Snap {
    let sn = this.snaps[0];
    for (const x of this.snaps) if (x.h <= h) sn = x;
    return sn;
  }

  landAt(): number {
    return this.land0;
  }

  bordering(): readonly BorderNation[] {
    return this.init.bordering ?? [];
  }

  alliedWith(id: PlayerID): boolean {
    return (this.init.allied ?? []).includes(id);
  }

  capNow(): number {
    return this.init.cap ?? 1_000_000;
  }
}

/** act3's settings (S0), with a margin of `need`. */
function params(over: Partial<RoundsParams> = {}): RoundsParams {
  return {
    H1: 150,
    prune: 0.03,
    H: 600,
    HStrong: 600,
    strongShare: 0.9,
    HBreak: [1200],
    HBreakGated: 0,
    keep: 2,
    dip: 0.2,
    need: 300,
    rival: 0,
    value: {
      cbar: 150,
      beta: 0.5,
      alpha: 0.5,
      dangerNow: 0,
      dangerCap: 0,
      share: false,
    },
    grid: 50,
    minContact: 8,
    tiles0: 10_000,
    lossShare: 0.1,
    ...over,
  };
}

function cand(name: string, over: Partial<Candidate> = {}): Candidate {
  const kind = name.split(":")[0];
  return {
    name,
    kind,
    target: name.split(":")[1] ?? null,
    steps: [],
    lastSend: kind === "break" ? 1 : 0,
    isBreak: kind === "break",
    strongCheck: kind === "strike" || kind === "lapse",
    defensive: kind === "lapse" || kind === "ally",
    ...over,
  };
}

/** Runs the rounds over fakes: `rolls` by candidate name. */
function run(
  p: RoundsParams,
  base: FakeRoll,
  cands: Candidate[],
  rolls: Record<string, FakeInit>,
  defend?: Parameters<typeof runRounds>[4],
) {
  const opened = new Map<string, FakeRoll>();
  const res = runRounds(
    p,
    base,
    cands,
    (c) => {
      const r = new FakeRoll(c.name, rolls[c.name]);
      opened.set(c.name, r);
      return r;
    },
    defend,
  );
  const judged = (name: string) =>
    res.judged.find((j) => j.cand.name === name)!;
  return { res, opened, judged };
}

const flat = (tiles: number, home = 0): FakeInit => ({
  points: [[0, tiles, home]],
});

describe("search rounds", () => {
  test("round 1 prunes plans more than 3% below the base at H1, and dead ones", () => {
    const base = new FakeRoll("base", flat(10_000));
    const { res, judged } = run(
      params(),
      base,
      [cand("strike:A:0.5"), cand("strike:A:1"), cand("strike:B:1")],
      {
        "strike:A:0.5": flat(9_650),
        "strike:A:1": flat(9_750),
        "strike:B:1": {
          points: [
            [0, 10_000],
            [120, -1],
          ],
        },
      },
    );
    expect(judged("strike:A:0.5").drop).toBe("pruned");
    expect(judged("strike:A:1").drop).toBeNull();
    expect(judged("strike:A:1").h).toBe(600);
    expect(judged("strike:B:1").drop).toBe("pruned");
    // −250 tiles is no gain: the base is kept.
    expect(res.chosen).toBeNull();
    expect(res.best?.cand.name).toBe("strike:A:1");
  });

  test("round 2 takes the best two non-breaks by V at H1; the rest are cut", () => {
    const base = new FakeRoll("base", flat(10_000));
    const { judged } = run(
      params(),
      base,
      [cand("strike:A:0.5"), cand("strike:A:1"), cand("strike:B:1")],
      {
        "strike:A:0.5": flat(10_100),
        "strike:A:1": flat(10_300),
        "strike:B:1": flat(10_200),
      },
    );
    expect(judged("strike:A:0.5").drop).toBe("cut");
    expect(judged("strike:A:1").round).toBe(2);
    expect(judged("strike:B:1").round).toBe(2);
  });

  test("judged horizons: a strike at H, a lapse after its send, a strong target long", () => {
    const base = new FakeRoll("base", flat(10_000));
    const p = params({ HStrong: 1200 });
    const home = 1_000_000;
    const { res, judged } = run(
      p,
      base,
      [
        cand("strike:W:1"),
        cand("lapse:L:1", { lastSend: 352 }),
        cand("strike:S:1"),
      ],
      {
        "strike:W:1": {
          points: [[0, 10_400]],
          sent: { h: 0, targetTroops: 0.5 * home, home, targetAlive: true },
        },
        "lapse:L:1": {
          points: [[0, 10_500]],
          sent: { h: 352, targetTroops: 0.5 * home, home, targetAlive: true },
        },
        "strike:S:1": {
          points: [[0, 10_450]],
          sent: { h: 0, targetTroops: 0.95 * home, home, targetAlive: true },
        },
      },
    );
    // keep = 2: the lapse and the strong strike (best V at H1).
    expect(judged("lapse:L:1").h).toBe(1000); // ⌈352 + 600⌉ on the grid
    expect(judged("lapse:L:1").strong).toBe(false);
    expect(judged("strike:S:1").h).toBe(1200); // strong: 0 + 1200
    expect(judged("strike:S:1").strong).toBe(true);
    expect(judged("strike:W:1").drop).toBe("cut");
    // The base reached each horizon, and stopped at the longest.
    expect([...res.baseAt.keys()].sort((a, b) => a - b)).toEqual([
      600, 1000, 1200,
    ]);
    expect(base.h).toBe(1200);
    // A lapse with act3's settings: ⌈strikeAt + 600⌉.
    expect(roundUp(498 + 2 + 600, 50)).toBe(1100);
  });

  test("a break is judged at its last step; one trailing at a step is dropped there", () => {
    const p = params({ HBreak: [600, 1200] });
    let base = new FakeRoll("base", flat(10_000));
    let r = run(p, base, [cand("break:Z:1")], {
      "break:Z:1": {
        points: [
          [0, 10_000],
          [400, 10_200],
        ],
      },
    });
    expect(r.judged("break:Z:1").drop).toBe("trail");
    expect(r.judged("break:Z:1").h).toBe(600);
    expect(base.h).toBe(600); // the base did not go on to 1200
    expect(r.res.chosen).toBeNull();

    base = new FakeRoll("base", flat(10_000));
    r = run(p, base, [cand("break:Z:1")], {
      "break:Z:1": {
        points: [
          [0, 10_000],
          [400, 11_000],
          [1000, 12_000],
        ],
      },
    });
    expect(r.judged("break:Z:1").steps.map((s) => s.h)).toEqual([600, 1200]);
    expect(r.judged("break:Z:1").h).toBe(1200);
    expect(r.res.chosen?.cand.name).toBe("break:Z:1");
    expect(r.res.chosen?.gain).toBe(2000);
    expect(base.h).toBe(1200);
  });

  test("each further look of the break round is bought from the budget", () => {
    const p = params({ HBreak: [600, 1200], HBreakGated: 1800 });
    const leading: FakeInit = {
      points: [
        [0, 10_000],
        [400, 11_000],
      ],
      ended: [{ id: "OTHER", h: 27, early: true, traitor: true }],
    };
    const asked: number[] = [];
    // 1,200 left: pays for the step to 1,200 (the break and the base, 600
    // each), not for the gated look past it.
    let left = 1200;
    const afford = (te: number) => {
      asked.push(te);
      if (te > left) return false;
      left -= te;
      return true;
    };
    let base = new FakeRoll("base", flat(10_000));
    let r = run({ ...p, afford }, base, [cand("break:Z:1")], {
      "break:Z:1": leading,
    });
    expect(asked).toEqual([1200, 1200]);
    expect(r.judged("break:Z:1").drop).toBe("budget");
    expect(r.res.chosen).toBeNull();
    expect(base.h).toBe(1200);
    // No budget for the second step: dropped at 600, never judged short.
    base = new FakeRoll("base", flat(10_000));
    r = run({ ...p, afford: () => false }, base, [cand("break:Z:1")], {
      "break:Z:1": leading,
    });
    expect(r.judged("break:Z:1").drop).toBe("budget");
    expect(r.judged("break:Z:1").h).toBe(600);
    expect(base.h).toBe(600);
  });

  test("the gate extends a leading break to 1,800 on an early alliance end in our traitor window (a)", () => {
    const p = params({ HBreak: [600, 1200], HBreakGated: 1800 });
    const leading: Point[] = [
      [0, 10_000],
      [400, 11_000],
      [1500, 8_500],
    ];
    const cases: [AllianceEnd[], boolean][] = [
      [[{ id: "OTHER", h: 27, early: true, traitor: true }], true],
      // The target's own alliance, broken by us: not a cascade.
      [[{ id: "Z", h: 1, early: true, traitor: true }], false],
      // A lapse (not early), or an early end once the traitor mark is gone.
      [[{ id: "OTHER", h: 700, early: false, traitor: false }], false],
      [[{ id: "OTHER", h: 700, early: true, traitor: false }], false],
    ];
    for (const [ended, gated] of cases) {
      const base = new FakeRoll("base", flat(10_000));
      const r = run(p, base, [cand("break:Z:1")], {
        "break:Z:1": { points: leading, ended },
      });
      const j = r.judged("break:Z:1");
      expect(r.res.gate?.a, JSON.stringify(ended)).toBe(gated);
      expect(j.gated).toBe(gated);
      expect(j.h).toBe(gated ? 1800 : 1200);
      expect(base.h).toBe(gated ? 1800 : 1200);
      // The collapse at 1,500 is seen only through the gate.
      expect(r.res.chosen?.cand.name ?? "base").toBe(
        gated ? "base" : "break:Z:1",
      );
    }
  });

  test("the gate's (b): an undeterrable unallied neighbour the base world does not face", () => {
    const p = params({ HBreak: [600, 1200], HBreakGated: 1800 });
    const giant: BorderNation = {
      id: "G",
      contact: 40,
      allied: false,
      maxTroops: 1_200_000,
    };
    const leading: Point[] = [
      [0, 10_000],
      [400, 11_000],
    ];
    const cases: [string, FakeInit, boolean][] = [
      // Allied with G in the base world.
      [
        "allied",
        {
          points: [[0, 10_000]],
          allied: ["G"],
          bordering: [{ ...giant, allied: true }],
        },
        true,
      ],
      // G does not border the base world.
      ["not bordering", { points: [[0, 10_000]], bordering: [] }, true],
      // G unallied and bordering there too: the break does not change it.
      ["same", { points: [[0, 10_000]], bordering: [giant] }, false],
    ];
    for (const [label, baseInit, fires] of cases) {
      const base = new FakeRoll("base", baseInit);
      const r = run(p, base, [cand("break:Z:1")], {
        "break:Z:1": { points: leading, bordering: [giant], cap: 1_000_000 },
      });
      expect(r.res.gate?.b, label).toBe(fires);
      expect(r.judged("break:Z:1").h, label).toBe(fires ? 1800 : 1200);
    }
    // Below 1.1× our cap it never fires.
    const small = new FakeRoll("brk", {
      points: [[0, 1]],
      bordering: [{ ...giant, maxTroops: 1_050_000 }],
      cap: 1_000_000,
    });
    const b = new FakeRoll("base", { points: [[0, 1]], bordering: [] });
    expect(breakGate(small, b, "Z", 8)).toEqual({ a: false, b: false });
  });

  test("the margin is strict and ties keep the first plan", () => {
    const base = new FakeRoll("base", flat(10_000));
    let r = run(params({ need: 300 }), base, [cand("strike:A:1")], {
      "strike:A:1": flat(10_300),
    });
    expect(r.res.best?.gain).toBe(300);
    expect(r.res.chosen).toBeNull();
    r = run(
      params({ need: 300 }),
      new FakeRoll("base", flat(10_000)),
      [cand("strike:A:1")],
      {
        "strike:A:1": flat(10_301),
      },
    );
    expect(r.res.chosen?.cand.name).toBe("strike:A:1");
    r = run(
      params(),
      new FakeRoll("base", flat(10_000)),
      [cand("strike:A:1"), cand("strike:B:1")],
      { "strike:A:1": flat(11_000), "strike:B:1": flat(11_000) },
    );
    expect(r.res.chosen?.cand.name).toBe("strike:A:1");
  });

  test("the dip guard drops a plan more than 20% below the base at a checkpoint", () => {
    const series = (dipTo: number): FakeInit => ({
      points: [
        [0, 10_000],
        [250, dipTo],
        [400, 14_000],
      ],
    });
    let r = run(
      params(),
      new FakeRoll("base", flat(10_000)),
      [cand("strike:A:1")],
      {
        "strike:A:1": series(7_900),
      },
    );
    expect(r.judged("strike:A:1").drop).toBe("dip");
    expect(r.res.chosen).toBeNull();
    r = run(
      params(),
      new FakeRoll("base", flat(10_000)),
      [cand("strike:A:1")],
      {
        "strike:A:1": series(8_100),
      },
    );
    expect(r.res.chosen?.cand.name).toBe("strike:A:1");
  });

  test("round 2b: defensive plans on the base's longest horizon when the base shows an attacker or a big loss", () => {
    const ally = cand("ally:Y");
    const cases: [string, FakeInit, boolean][] = [
      [
        "attacker",
        { points: [[0, 10_000]], attackers: [["Y", { h: 403, troops: 5 }]] },
        true,
      ],
      [
        "loss",
        {
          points: [
            [0, 10_000],
            [500, 8_900],
          ],
        },
        true,
      ],
      [
        "quiet",
        {
          points: [
            [0, 10_000],
            [500, 9_500],
          ],
        },
        false,
      ],
    ];
    for (const [label, baseInit, runs] of cases) {
      let asked = -1;
      const base = new FakeRoll("base", baseInit);
      const r = run(
        params(),
        base,
        [cand("strike:A:1")],
        { "strike:A:1": flat(10_000), "ally:Y": flat(12_000) },
        (b) => {
          asked = b.h;
          return [ally];
        },
      );
      expect(r.res.defended, label).toBe(runs);
      expect(asked, label).toBe(runs ? 600 : -1);
      if (runs) {
        expect(r.judged("ally:Y").h).toBe(600);
        expect(r.res.chosen?.cand.name).toBe("ally:Y");
      }
    }
  });

  test("act3's settings choose act3's plans on its own rollouts (Japan g8)", () => {
    const P = (
      rows: [number, number, number, number, number, number][],
    ): FakeInit => ({
      points: rows.map(
        ([h, tiles, home, out, inc]) => [h, tiles, home, out, inc] as Point,
      ),
    });
    // Tick 2,400: the break with Tohoku (act3: gain 112,236 at 1,200).
    const base = new FakeRoll(
      "base",
      P([
        [0, 116966, 3929464, 0, 0, 1],
        [50, 116966, 3993407, 0, 0, 1],
        [100, 116966, 4046742, 0, 0, 1],
        [150, 116966, 4091065, 0, 0, 1],
        [200, 116966, 4127778, 0, 0, 1],
        [300, 116966, 4183116, 0, 0, 1],
        [450, 116966, 4234495, 0, 0, 1],
        [600, 116966, 4262846, 0, 0, 1],
        [900, 115711, 3533006, 0, 0, 1],
        [1200, 115711, 3533006, 0, 0, 1],
      ]),
    );
    const r = run(
      params({ need: Math.max(300, 0.01 * 116966) }),
      base,
      [cand("break:6f1i5qla:0.5"), cand("break:6f1i5qla:1")],
      {
        "break:6f1i5qla:0.5": P([
          [0, 116966, 3929464, 0, 0, 1],
          [50, 120954, 1441929, 2189752, 0, 1],
          [100, 127879, 1545319, 2002357, 0, 1],
          [150, 140222, 1424533, 1989013, 0, 1],
        ]),
        "break:6f1i5qla:1": P([
          [0, 116966, 3929464, 0, 0, 1],
          [50, 121860, 1539849, 2503600, 0, 1],
          [100, 130361, 1592810, 2328792, 0, 1],
          [150, 145195, 1636607, 2080441, 0, 1],
          [200, 168444, 1738284, 1541851, 0, 1],
          [300, 193775, 1960610, 1077163, 0, 1],
          [450, 217657, 2224903, 3775, 0, 1],
          [600, 222426, 2367050, 145240, 0, 1],
          [900, 221121, 4439604, 0, 0, 1],
          [1200, 221121, 5580776, 0, 0, 1],
        ]),
      },
    );
    expect(r.res.chosen?.cand.name).toBe("break:6f1i5qla:1");
    expect(Math.round(r.res.chosen!.gain)).toBe(112236);
    expect(r.res.chosen?.h).toBe(1200);
    expect(r.judged("break:6f1i5qla:0.5").drop).toBe("cut");
    expect(base.h).toBe(1200);

    // Tick 3,600: the whole-purse strike on Tokyo (act3: gain 35,505 at 600).
    const b2 = new FakeRoll(
      "base",
      P([
        [0, 221121, 5390000, 0, 0, 1],
        [50, 219323, 5417085, 0, 0, 1],
        [100, 219323, 5440293, 0, 0, 1],
        [150, 219323, 5459609, 0, 0, 1],
        [200, 219323, 5475672, 0, 0, 1],
        [300, 219323, 5500100, 0, 0, 1],
        [450, 219323, 5523253, 0, 0, 1],
        [600, 219323, 5536446, 0, 0, 1],
      ]),
    );
    const settled = (a: [number, number, number, number, number, number][]) =>
      P(a);
    const r2 = run(
      params({ need: Math.max(300, 0.01 * 221121) }),
      b2,
      [
        cand("strike:f8f0iuhh:0.5"),
        cand("strike:f8f0iuhh:1"),
        cand("strike:dxobcrlc:0.5"),
        cand("strike:dxobcrlc:1"),
      ],
      {
        "strike:f8f0iuhh:0.5": settled([
          [0, 221121, 5390000, 0, 0, 1],
          [50, 232444, 2984619, 773646, 0, 1],
          [100, 245090, 3277219, 304391, 0, 1],
          [150, 253815, 3719856, 0, 0, 1],
          [200, 253815, 4033739, 0, 0, 1],
          [300, 253815, 4590557, 0, 0, 1],
          [450, 253815, 5232630, 0, 0, 1],
          [600, 253815, 5664732, 0, 0, 1],
        ]),
        "strike:f8f0iuhh:1": settled([
          [0, 221121, 5390000, 0, 0, 1],
          [50, 234491, 2264067, 1737716, 0, 1],
          [100, 252609, 2614551, 1358195, 0, 1],
          [150, 253815, 4254608, 0, 0, 1],
          [200, 253815, 4526834, 0, 0, 1],
          [300, 253815, 4993207, 0, 0, 1],
          [450, 253815, 5507290, 0, 0, 1],
          [600, 253815, 5840339, 0, 0, 1],
        ]),
        "strike:dxobcrlc:0.5": settled([
          [0, 221121, 5390000, 0, 0, 1],
          [50, 222984, 3099918, 1316190, 0, 1],
          [100, 227499, 3390205, 1196524, 0, 1],
          [150, 232405, 3632946, 1029876, 0, 1],
        ]),
        "strike:dxobcrlc:1": settled([
          [0, 221121, 5390000, 0, 0, 1],
          [50, 223434, 2256791, 2214860, 0, 1],
          [100, 226120, 2472642, 2007905, 0, 1],
          [150, 231469, 2796376, 1847721, 0, 1],
        ]),
      },
    );
    expect(r2.res.chosen?.cand.name).toBe("strike:f8f0iuhh:1");
    expect(Math.round(r2.res.chosen!.gain)).toBe(35505);
    expect(r2.judged("strike:dxobcrlc:0.5").drop).toBe("cut");
    expect(r2.judged("strike:dxobcrlc:1").drop).toBe("cut");
  });
});
