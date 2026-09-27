/**
 * Package WP10n (docs/14-m4-plan.md §2.4, §2.8 item 3; docs/13-mechanics.md
 * §2.13-2.16): our own MIRV and bomb candidates for the search
 * (lib/search/cands/nuke.ts), the MIRV-threat state T8 reads, and the
 * value-comparison that makes the search prefer a pre-empting nuke when the
 * base rollout shows an enemy MIRV collapse.
 *
 * Claims:
 * - The generator, on a real world (LeaderWorld): when we own a finished
 *   silo and MIRV gold and a dangerous ally can pay a MIRV, it makes
 *   mirv:N at N's territory centre and a hydro/atom denial salvo at N's
 *   finished silos; with no silo it makes only the silo candidate; off
 *   (searchNukes false) it makes nothing.
 * - mirvThreatState: a silo owner about to pay a MIRV while we hold ≥ the
 *   land share is a threat; below the share and not near the city rung it
 *   is not; we can MIRV offensively (we can pay, rank ≤ 2) is the chance.
 * - The rounds (synthetic rollouts): when the base collapses (an enemy
 *   MIRV) and a mirv:N (or a denial) rollout holds and then conquers, the
 *   search plays that candidate over the base.
 */
import {
  ApexOptions,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import {
  mirvThreatState,
  NUKE,
  nukeTargets,
} from "../../../src/agent/lib/search/cands/nuke";
import type {
  BaseView,
  Candidate,
  SearchView,
} from "../../../src/agent/lib/search/Registry";
import {
  Roll,
  RoundsParams,
  runRounds,
} from "../../../src/agent/lib/search/Rounds";
import type {
  AllianceEnd,
  AttackSeen,
  BorderNation,
  SendState,
} from "../../../src/agent/lib/search/Runner";
import type { Snap } from "../../../src/agent/lib/search/Value";
import { PlayerID, PlayerType, UnitType } from "../../../src/core/game/Game";
import {
  ally,
  columns,
  idOf,
  pastImmunity,
  setGold,
  siloAt,
  world,
  World,
} from "../mechanics/LeaderWorld";

/** A SearchView the NUKE generator can read (it uses only game, me, o, t,
 *  kinds; host/wm/floors/ctx are unused, so stubbed). */
function view(w: World, me: string, o: ApexOptions, t = 3000): SearchView {
  const kinds = new Set([
    ...o.searchKinds.split(","),
    "mirv",
    "hydro",
    "atom",
    "silo",
  ]);
  return {
    ctx: {} as never,
    host: { available: () => 0 } as never,
    o,
    t,
    game: w.game,
    me: w.p[me],
    wm: { nations: [] } as never,
    floors: {} as never,
    kinds,
  };
}

const NO_BASE: BaseView = { h: 150, attackers: new Map(), snaps: [] };

const opts = (over: Record<string, unknown> = {}): ApexOptions =>
  parseApexOptions({ search: true, searchNukes: true, ...over });

/**
 * A wide all-plains world: us on the left, a dangerous ally on the right, a
 * gap and a free strip so neither player is enclosed (LeaderWorld's
 * enclosure annex fires otherwise). Us holds 40% of the land.
 */
function leaderWorld(): World {
  // 200 × 120: us 0-79 (9,600 tiles), gap 80-89, ally 90-149 (7,200), free
  // 150-199. Land 24,000; our share 0.40.
  const w = world(
    200,
    120,
    { US: PlayerType.Human, ALLY: PlayerType.Nation, OTHER: PlayerType.Nation },
    columns([
      ["US", 80],
      [null, 10],
      ["ALLY", 55],
      ["OTHER", 5],
      [null, 50],
    ]),
  );
  pastImmunity(w);
  return w;
}

describe("WP10n nuke candidates", () => {
  test("mirv and denial against a dangerous ally that can pay a MIRV", () => {
    const w = leaderWorld();
    ally(w.p.US, w.p.ALLY);
    siloAt(w, w.p.US, 40, 60);
    const allySilo = siloAt(w, w.p.ALLY, 120, 60);
    setGold(w.p.US, 60_000_000n);
    setGold(w.p.ALLY, 30_000_000n); // ≥ the 25M MIRV price
    const cands = NUKE.generate(view(w, "US", opts()), NO_BASE);
    const names = cands.map((c) => c.name);
    // The ally is the most dangerous nation → mirv:ALLY and a denial at it.
    expect(names).toContain(`mirv:${idOf("ALLY")}`);
    const mirv = cands.find((c) => c.name === `mirv:${idOf("ALLY")}`)!;
    expect(mirv.kind).toBe("mirv");
    expect(mirv.target).toBe(idOf("ALLY"));
    expect(mirv.steps).toHaveLength(1);
    const mstep = mirv.steps[0].p!.intent;
    expect(mstep.type).toBe("build_unit");
    expect((mstep as { unit: string }).unit).toBe(UnitType.MIRV);
    // The MIRV aims at a tile the ally owns (an owned tile is required).
    const aim = (mstep as { tile: number }).tile;
    expect(w.game.hasOwner(aim)).toBe(true);
    expect(w.game.owner(aim)).toBe(w.p.ALLY);
    // A hydrogen denial (we can pay 5M) at the ally's finished silo.
    const deny = cands.find((c) => c.name === `hydro:${idOf("ALLY")}`);
    expect(deny).toBeDefined();
    expect(deny!.kind).toBe("hydro");
    const dstep = deny!.steps[0].p!.intent as { unit: string; tile: number };
    expect(dstep.unit).toBe(UnitType.HydrogenBomb);
    expect(dstep.tile).toBe(allySilo.tile());
    // No silo candidate: we already own a silo.
    expect(names).not.toContain("silo");
  });

  test("with no silo of our own: the standalone silo and combined silo+launch", () => {
    const w = leaderWorld();
    ally(w.p.US, w.p.ALLY);
    const allySilo = siloAt(w, w.p.ALLY, 120, 60);
    setGold(w.p.US, 60_000_000n);
    setGold(w.p.ALLY, 30_000_000n);
    const cands = NUKE.generate(view(w, "US", opts()), NO_BASE);
    const names = cands.map((c) => c.name);
    expect(names).toContain("silo");
    // No same-tick mirv/denial: they need a finished silo of ours now.
    expect(names).not.toContain(`mirv:${idOf("ALLY")}`);
    expect(names).not.toContain(`hydro:${idOf("ALLY")}`);
    // But the combined silo+launch plans do fire (build now, launch at
    // silo-ready): silomirv and silohydro against the dangerous ally.
    const combo = cands.find((c) => c.name === `silomirv:${idOf("ALLY")}`)!;
    expect(combo).toBeDefined();
    expect(combo.kind).toBe("mirv");
    expect(combo.steps).toHaveLength(2);
    const [siloStep, mirvStep] = combo.steps;
    expect((siloStep.p!.intent as { unit: string }).unit).toBe(
      UnitType.MissileSilo,
    );
    expect(siloStep.at).toBe(3000);
    expect((mirvStep.p!.intent as { unit: string }).unit).toBe(UnitType.MIRV);
    // The launch is scheduled after the silo is ready (searchNukeSiloReady).
    expect(mirvStep.at).toBe(3000 + 110);
    expect(combo.lastSend).toBe(110);
    expect(combo.strongCheck).toBe(true);
    const hy = cands.find((c) => c.name === `silohydro:${idOf("ALLY")}`)!;
    expect(hy).toBeDefined();
    const hstep = hy.steps[1].p!.intent as { unit: string; tile: number };
    expect(hstep.unit).toBe(UnitType.HydrogenBomb);
    expect(hstep.tile).toBe(allySilo.tile());
    const silo = cands.find((c) => c.name === "silo")!;
    const step = silo.steps[0].p!.intent as { unit: string; tile: number };
    expect(step.unit).toBe(UnitType.MissileSilo);
    expect(w.game.owner(step.tile)).toBe(w.p.US);
  });

  test("atom denial when we cannot pay a hydrogen bomb", () => {
    const w = leaderWorld();
    ally(w.p.US, w.p.ALLY);
    siloAt(w, w.p.US, 40, 60);
    const allySilo = siloAt(w, w.p.ALLY, 120, 60);
    // 3M: a hydrogen bomb (5M) is out of reach, an atom (750k) is not; we
    // still deny (mirv needs 25M, so no mirv here).
    setGold(w.p.US, 3_000_000n);
    setGold(w.p.ALLY, 30_000_000n);
    const cands = NUKE.generate(view(w, "US", opts()), NO_BASE);
    const names = cands.map((c) => c.name);
    expect(names).toContain(`atom:${idOf("ALLY")}`);
    expect(names).not.toContain(`hydro:${idOf("ALLY")}`);
    expect(names).not.toContain(`mirv:${idOf("ALLY")}`);
    const deny = cands.find((c) => c.name === `atom:${idOf("ALLY")}`)!;
    const step = deny.steps[0].p!.intent as { unit: string; tile: number };
    expect(step.unit).toBe(UnitType.AtomBomb);
    expect(step.tile).toBe(allySilo.tile());
  });

  test("off: the generator makes nothing", () => {
    const w = leaderWorld();
    ally(w.p.US, w.p.ALLY);
    siloAt(w, w.p.US, 40, 60);
    siloAt(w, w.p.ALLY, 120, 60);
    setGold(w.p.US, 60_000_000n);
    setGold(w.p.ALLY, 30_000_000n);
    const cands = NUKE.generate(
      view(w, "US", opts({ searchNukes: false })),
      NO_BASE,
    );
    expect(cands).toEqual([]);
  });

  test("a nation that neither out-caps us nor can pay is not targeted", () => {
    const w = leaderWorld();
    ally(w.p.US, w.p.ALLY);
    siloAt(w, w.p.US, 40, 60);
    siloAt(w, w.p.ALLY, 120, 60);
    setGold(w.p.US, 60_000_000n);
    setGold(w.p.ALLY, 1_000_000n); // far below the MIRV price − a minute's income
    const targets = nukeTargets(w.game, w.p.US, opts());
    expect(targets).not.toContain(idOf("ALLY"));
    // With no dangerous nation there is no mirv/denial candidate.
    const names = NUKE.generate(view(w, "US", opts()), NO_BASE).map(
      (c) => c.name,
    );
    expect(
      names.some((n) => n.startsWith("mirv:") || n.startsWith("hydro:")),
    ).toBe(false);
  });
});

describe("WP10n MIRV-threat state (trigger T8)", () => {
  test("a silo owner about to pay, while we are a magnet, is a threat", () => {
    const w = leaderWorld(); // us at 40% of the land ≥ 0.35
    siloAt(w, w.p.ALLY, 120, 60);
    setGold(w.p.ALLY, 30_000_000n);
    const st = mirvThreatState(w.game, w.p.US, opts());
    expect(st.threat).toBe(true);
  });

  test("allies do not protect us: an allied silo owner is still a threat", () => {
    const w = leaderWorld();
    ally(w.p.US, w.p.ALLY);
    siloAt(w, w.p.ALLY, 120, 60);
    setGold(w.p.ALLY, 30_000_000n);
    expect(mirvThreatState(w.game, w.p.US, opts()).threat).toBe(true);
  });

  test("below the land share and not near the city rung: no threat", () => {
    // A narrow us: 20 columns of 120 = 2,400 tiles, 10% of the land.
    const w = world(
      200,
      120,
      { US: PlayerType.Human, ALLY: PlayerType.Nation },
      columns([
        ["US", 20],
        [null, 10],
        ["ALLY", 120],
        [null, 50],
      ]),
    );
    pastImmunity(w);
    siloAt(w, w.p.ALLY, 120, 60);
    setGold(w.p.ALLY, 30_000_000n);
    expect(mirvThreatState(w.game, w.p.US, opts()).threat).toBe(false);
  });

  test("the chance: we can pay a MIRV and are rank ≤ 2", () => {
    const w = leaderWorld();
    setGold(w.p.US, 30_000_000n); // ≥ the price; we hold the most land (rank 1)
    expect(mirvThreatState(w.game, w.p.US, opts()).chance).toBe(true);
    setGold(w.p.US, 1_000_000n); // cannot pay
    expect(mirvThreatState(w.game, w.p.US, opts()).chance).toBe(false);
  });

  test("MIRVs disabled: no threat, no chance", () => {
    const w = leaderWorld();
    siloAt(w, w.p.ALLY, 120, 60);
    setGold(w.p.ALLY, 30_000_000n);
    setGold(w.p.US, 60_000_000n);
    const disabled = { ...opts() } as ApexOptions;
    // Force the config to report MIRV disabled via the game's config.
    (
      w.game.config() as unknown as { isUnitDisabled: (u: UnitType) => boolean }
    ).isUnitDisabled = (u: UnitType) => u === UnitType.MIRV;
    const st = mirvThreatState(w.game, w.p.US, disabled);
    expect(st.threat).toBe(false);
    expect(st.chance).toBe(false);
  });
});

// ── The rounds prefer a pre-empting nuke over a collapsing base ──────────

type Point = [h: number, tiles: number, home?: number, out?: number];

function snap(p: Point): Snap {
  const [h, tiles, home = 0, out = 0] = p;
  return {
    h,
    tiles: Math.max(0, tiles),
    home,
    out,
    inc: 0,
    cap: 0,
    gold: 0,
    alive: tiles >= 0,
    natAtks: 0,
    natTroops: 0,
    rank: 1,
    top: 0,
  };
}

const GRID = [50, 100, 150, 200, 300, 450, 600, 900, 1200, 1800];

class FakeRoll implements Roll {
  h = 0;
  dead = false;
  readonly snaps: Snap[] = [];
  readonly attackers = new Map<PlayerID, AttackSeen>();
  readonly ended: AllianceEnd[] = [];
  readonly land0 = 1000;
  sent: SendState | null = null;
  private readonly grid = new Set(GRID);
  private readonly points: Point[];

  constructor(
    readonly name: string,
    points: Point[],
    private readonly send: SendState | null = null,
  ) {
    this.points = [...points].sort((a, b) => a[0] - b[0]);
  }

  private pointAt(h: number): Point {
    let p = this.points[0];
    for (const x of this.points) if (x[0] <= h) p = x;
    return [h, p[1], p[2], p[3]];
  }

  advance(to: number, snapEnd = true): Snap {
    while (this.h < to && !this.dead) {
      if (this.send !== null && this.h === this.send.h) this.sent = this.send;
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
    return [];
  }

  alliedWith(): boolean {
    return false;
  }

  capNow(): number {
    return 1_000_000;
  }
}

function nukeParams(over: Partial<RoundsParams> = {}): RoundsParams {
  return {
    H1: 150,
    prune: 0.03,
    H: 600,
    HStrong: 1200,
    strongShare: 0.9,
    HBreak: [600, 1200],
    HBreakGated: 1800,
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

describe("WP10n: the search prefers a pre-empting nuke", () => {
  test("base collapses to an enemy MIRV; mirv:N pre-empts and is chosen", () => {
    // Base: we lead at H1, then an ally MIRVs us and we collapse.
    const base = new FakeRoll("base", [
      [0, 10_000, 3_000_000],
      [150, 10_000, 3_000_000],
      [600, 2_000, 300_000],
      [1200, 1_500, 200_000],
    ]);
    // mirv:N: we pre-empt, hold our land, and conquer the crippled ally.
    const send: SendState = {
      h: 0,
      targetTroops: 5_000_000,
      home: 3_000_000,
      targetAlive: true,
    };
    const mirv = new FakeRoll(
      "mirv:IDALLY000",
      [
        [0, 10_000, 3_000_000],
        [150, 10_000, 3_000_000],
        [600, 11_000, 2_500_000],
        [1200, 13_000, 3_500_000],
      ],
      send,
    );
    const cand: Candidate = {
      name: "mirv:IDALLY000",
      kind: "mirv",
      target: "IDALLY000",
      steps: [],
      lastSend: 0,
      isBreak: false,
      strongCheck: true,
      strong: true,
      defensive: false,
    };
    const rolls: Record<string, FakeRoll> = { "mirv:IDALLY000": mirv };
    const res = runRounds(nukeParams(), base, [cand], (c) => rolls[c.name]);
    expect(res.chosen).not.toBeNull();
    expect(res.chosen!.cand.name).toBe("mirv:IDALLY000");
    expect(res.chosen!.gain).toBeGreaterThan(0);
    // The strong target gave it the long (HStrong) horizon.
    expect(res.chosen!.h).toBe(1200);
    expect(res.chosen!.strong).toBe(true);
  });

  test("a denial that holds is chosen over the collapsing base", () => {
    const base = new FakeRoll("base", [
      [0, 10_000, 3_000_000],
      [150, 10_000, 3_000_000],
      [600, 3_000, 400_000],
      [1200, 2_500, 300_000],
    ]);
    const deny = new FakeRoll(
      "hydro:IDALLY000",
      [
        [0, 10_000, 3_000_000],
        [150, 10_000, 3_000_000],
        [600, 10_500, 3_000_000],
        [1200, 11_500, 3_200_000],
      ],
      { h: 0, targetTroops: 5_000_000, home: 3_000_000, targetAlive: true },
    );
    const cand: Candidate = {
      name: "hydro:IDALLY000",
      kind: "hydro",
      target: "IDALLY000",
      steps: [],
      lastSend: 0,
      isBreak: false,
      strongCheck: true,
      strong: true,
      defensive: false,
    };
    const res = runRounds(nukeParams(), base, [cand], () => deny);
    expect(res.chosen?.cand.name).toBe("hydro:IDALLY000");
  });

  test("when the base does not collapse, a nuke with no gain keeps the base", () => {
    const base = new FakeRoll("base", [
      [0, 10_000, 3_000_000],
      [150, 10_000, 3_000_000],
      [600, 10_200, 3_000_000],
      [1200, 10_400, 3_000_000],
    ]);
    const mirv = new FakeRoll(
      "mirv:IDALLY000",
      [
        [0, 10_000, 3_000_000],
        [150, 10_000, 3_000_000],
        [600, 10_100, 2_800_000],
        [1200, 10_300, 2_900_000],
      ],
      { h: 0, targetTroops: 5_000_000, home: 3_000_000, targetAlive: true },
    );
    const cand: Candidate = {
      name: "mirv:IDALLY000",
      kind: "mirv",
      target: "IDALLY000",
      steps: [],
      lastSend: 0,
      isBreak: false,
      strongCheck: true,
      strong: true,
      defensive: false,
    };
    const res = runRounds(nukeParams(), base, [cand], () => mirv);
    expect(res.chosen).toBeNull();
  });
});
