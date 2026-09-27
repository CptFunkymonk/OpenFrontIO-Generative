import type { PlayerID } from "../../../../core/game/Game";
import { PlayerType } from "../../../../core/game/Game";
import type { AgentContext, AgentOutcome } from "../../../Agent";
import type { ForkSource, GameFork } from "../../../Fork";
import { BudgetMirror } from "../../../lib/Lookahead";
import {
  cheapest,
  CostModel,
  degrade,
  DEGRADE,
  phiFor,
  SearchBudget,
} from "../../../lib/search/Budget";
import { mirvThreatState, NUKE_KINDS } from "../../../lib/search/cands/nuke";
import { Checkpoints } from "../../../lib/search/Checkpoints";
import {
  BaseView,
  Candidate,
  CandidateGenerator,
  DANGER,
  GENERATORS,
  generatorsFor,
  roundOneCandidates,
  SearchView,
} from "../../../lib/search/Registry";
import { Judged, RoundsParams, runRounds } from "../../../lib/search/Rounds";
import type { AttackSeen } from "../../../lib/search/Runner";
import { Runner } from "../../../lib/search/Runner";
import {
  Fired,
  NationObs,
  TriggerObs,
  Triggers,
} from "../../../lib/search/Triggers";
import {
  actMargin,
  Snap,
  snapOf,
  value,
  ValueParams,
} from "../../../lib/search/Value";
import type { ApexOptions } from "../options";
import type { LiveSearch, RolloutSpec, SearchHost } from "../policy";

// Package WP2 (docs/14-m4-plan.md §2.0-2.6, §2.10): the live search. At
// the start of every live tick past the spawn phase (ApexPolicy's
// LiveSearch hook, package WP1) it
// 1. verifies the checkpoints due (the live game against the rollout it is
//    playing: `search-check` lines);
// 2. checks the triggers (lib/search/Triggers.ts), or its clock;
// 3. if one fires and the budget allows (lib/search/Budget.ts; a low-
//    priority trigger may not spend the last searchReserve): forks the
//    live game, rolls the base (the live policy's copy with the steps it
//    will play) and each candidate plan (lib/search/Registry.ts) forward
//    with an exact copy of the live policy (ApexPolicy.forRolloutWith), runs
//    the rounds (lib/search/Rounds.ts), and adopts the plan whose value
//    beats the base's by the margin: the live policy plays its directive
//    steps through the same Scheduler, Purse and Ledger, so the live game
//    follows that rollout.
// It never touches the live game: the forks are independent copies, and
// the copies' sends go only into their forks. Its decisions depend on the
// game and the committed φ table, never on wall time (timings are logged).
// Only live: rollout copies have no search. A search blocks its live tick
// for seconds to minutes (the arena's clock waits; a browser's would not):
// keep it to the arena until it is time-sliced (M7, §2.6).

/** Checkpoints of a rollout (ticks after the fork), act3's. */
export const CHECK_GRID: readonly number[] = [
  50, 100, 150, 200, 300, 450, 600, 900, 1200, 1800, 2400,
];
/** The plan's checkpoints (§2.2): these and the rollout's judged horizon
 *  (unless searchCheckAll: every snap, as act3 checked). */
export const PLAN_CHECKS: readonly number[] = [50, 150, 300, 600];
/** Judged horizons are rounded up to this many ticks (act3). */
export const HORIZON_GRID = 50;
/** Round 2b runs on a base loss above this share of our tiles (§2.5). */
export const DEFEND_LOSS = 0.1;
/** T3: a bordering nation's troops falling by more than this share. */
export const STALL_CHANGE = 0.25;
/** T5: a foreseen attack within this many ticks. */
export const FORESIGHT_TICKS = 300;
/** T6: home at this share of the cap, for this long, every this long. */
export const NAVAL_HOME = 0.8;
export const NAVAL_FOR = 600;
export const NAVAL_EVERY = 1200;

const MODES = ["act", "plans"] as const;
/** The plan's candidate kinds (§2.4); generators may add their own. */
const KNOWN_KINDS = ["strike", "lapse", "keep", "break", "ally", "boat"];

/** A rounded number for the logs, null if not finite. */
function finite(x: number): number | null {
  return Number.isFinite(x) ? Math.round(x) : null;
}

/** Throws for a Search option no run can mean (parseApexOptions checks
 *  only the types). */
export function validateSearchOptions(o: ApexOptions): void {
  const fail = (key: string, why: string) => {
    throw new Error(`apex option "${key}" ${why}`);
  };
  if (!(MODES as readonly string[]).includes(o.searchMode)) {
    fail("searchMode", `must be one of ${MODES.join(", ")}`);
  }
  const known = new Set([
    ...KNOWN_KINDS,
    ...GENERATORS.flatMap((g) => g.kinds),
  ]);
  for (const k of o.searchKinds.split(",")) {
    if (!known.has(k.trim())) {
      fail(
        "searchKinds",
        `has an unknown kind "${k}" (${[...known].join(", ")})`,
      );
    }
  }
  const numbers = (
    key: "searchFracs" | "searchHBreak",
    ok: (x: number) => boolean,
  ) => {
    const v = o[key] as unknown;
    if (
      !Array.isArray(v) ||
      v.length === 0 ||
      !v.every((x) => typeof x === "number" && ok(x))
    ) {
      fail(key, `must be a list of numbers, got ${JSON.stringify(v)}`);
    }
  };
  numbers("searchFracs", (f) => f > 0 && f <= 1);
  numbers("searchHBreak", (h) => Number.isInteger(h) && h > 0);
  if (o.searchH1 <= 0 || o.searchH < o.searchH1) {
    fail("searchH", "must be at least searchH1 > 0");
  }
  if (o.searchSlack < 0 || o.searchReserve < 0) {
    fail("searchReserve", "and searchSlack must be at least 0");
  }
  if (o.searchLapseFoeAt < 0) fail("searchLapseFoeAt", "must be at least 0");
  if ((o.searchDangerNow !== 0 || o.searchDangerCap !== 0) && DANGER === null) {
    fail(
      "searchDangerNow",
      "needs package WP4's DangerModel in lib/search/Registry.ts (DANGER)",
    );
  }
}

/** What a search did, for the logs and the game's summary line. */
interface Stats {
  searches: number;
  acts: number;
  refused: number;
  none: number;
  te: number;
  ms: number;
  byTrigger: Record<string, number>;
  actsByKind: Record<string, number>;
}

/** How a try ended: it ran, the budget refused it (the tick it could pay
 *  it), or it had no plan. */
type Outcome =
  | { ran: true; foreseen: { id: PlayerID; at: number }[] }
  | { ran: false; retryAt: number }
  | { ran: false; none: true };

export class SearchController implements LiveSearch {
  readonly name = "search";
  private readonly triggers: Triggers;
  private readonly checks = new Checkpoints();
  private readonly budget: SearchBudget;
  private readonly kinds: ReadonlySet<string>;
  private readonly grid: number[];
  private readonly stats: Stats = {
    searches: 0,
    acts: 0,
    refused: 0,
    none: 0,
    te: 0,
    ms: 0,
    byTrigger: {},
    actsByKind: {},
  };

  private readonly valueParams: ValueParams;
  /** The generators with a T6 test (boat plans, package WP3). */
  private readonly naval: readonly CandidateGenerator[];

  constructor(private readonly o: ApexOptions) {
    validateSearchOptions(o);
    this.valueParams = {
      cbar: o.searchCbar,
      beta: o.searchBeta,
      alpha: o.searchAlpha,
      dangerNow: o.searchDangerNow,
      dangerCap: o.searchDangerCap,
      share: o.searchShare,
    };
    const kinds = new Set(o.searchKinds.split(",").map((k) => k.trim()));
    // Package WP10n: our MIRV/bomb candidates ride on their own kinds, added
    // to the effective set only when o.searchNukes is on (off: no change).
    if (o.searchNukes) for (const k of NUKE_KINDS) kinds.add(k);
    this.kinds = kinds;
    this.naval = GENERATORS.filter(
      (g) =>
        g.wantsNaval !== undefined && g.kinds.some((k) => this.kinds.has(k)),
    );
    this.budget = new SearchBudget(o.searchR, o.searchFrom, o.searchSlack);
    this.triggers = new Triggers({
      from: o.searchFrom,
      clock: o.searchClock,
      lapseLead: o.searchLapseLead,
      extendLead: o.extendLead,
      chain: o.searchChain,
      stallEvery: o.searchStallEvery,
      stallChange: STALL_CHANGE,
      attackMin: o.searchAttackMin,
      foresight: FORESIGHT_TICKS,
      navalHome: NAVAL_HOME,
      navalFor: NAVAL_FOR,
      navalEvery: NAVAL_EVERY,
      floorTicks: o.searchFloorTicks,
      minGap: o.searchMinGap,
    });
    // act3's checkpoints: the grid to the longest horizon, and every step
    // of the break round.
    const maxH = Math.max(
      o.searchH,
      o.searchHStrong,
      ...o.searchHBreak,
      o.searchHBreakGated,
    );
    this.grid = [
      ...new Set([
        ...CHECK_GRID.filter((h) => h < o.searchH),
        o.searchH,
        ...CHECK_GRID.filter((h) => h > o.searchH && h <= maxH),
        ...o.searchHBreak,
        ...(o.searchHBreakGated > 0 ? [o.searchHBreakGated] : []),
      ]),
    ].sort((a, b) => a - b);
  }

  tick(ctx: AgentContext, host: SearchHost): void {
    const t = ctx.tick;
    for (const line of this.checks.verify(t, () => {
      const s = snapOf(ctx.game, ctx.me, 0, 0, 0, this.o.searchOutBoats);
      return { tiles: s.tiles, home: s.home, out: s.out };
    })) {
      ctx.log(line);
    }
    const obs = this.observe(ctx, host);
    const fired = this.triggers.check(obs);
    if (fired === null) return;
    let out: Outcome | null = null;
    try {
      out = this.search(ctx, host, obs, fired);
    } finally {
      // A search that threw still used its trigger (the error is rethrown
      // after the live run): no error storm.
      if (out === null) this.triggers.none(obs, fired);
      else if (out.ran) this.triggers.searched(obs, fired, out.foreseen);
      else if ("none" in out) this.triggers.none(obs, fired);
      else this.triggers.refused(obs, fired, out.retryAt);
    }
  }

  gameOver(ctx: AgentContext, outcome: AgentOutcome): void {
    const s = this.stats;
    const ticks = Math.max(1, ctx.tick);
    ctx.log(
      `search-summary ${JSON.stringify({
        result: outcome.result,
        searches: s.searches,
        acts: s.acts,
        refused: s.refused,
        none: s.none,
        byTrigger: s.byTrigger,
        actsByKind: s.actsByKind,
        te: Math.round(s.te),
        ticks: ctx.tick,
        R: Math.round((s.te / ticks) * 1000) / 1000,
        checks: this.checks.checks,
        mismatches: this.checks.mismatches,
        ms: Math.round(s.ms),
      })}`,
    );
  }

  /** The triggers' view of the live game at this tick. */
  private observe(ctx: AgentContext, host: SearchHost): TriggerObs {
    const t = ctx.tick;
    const me = ctx.me;
    const nations: NationObs[] = [];
    const wm = host.wm();
    if (wm !== null && this.o.searchClock <= 0) {
      for (const n of wm.nations) {
        if (
          n.type !== PlayerType.Nation ||
          n.contact < this.o.searchMinContact
        ) {
          continue;
        }
        if (!ctx.game.hasPlayer(n.id)) continue;
        const N = ctx.game.player(n.id);
        if (!N.isAlive()) continue;
        const al = me.allianceWith(N);
        nations.push({
          id: n.id,
          allied: al !== null,
          expiresAt: al === null ? null : al.expiresAt(),
          troops: N.troops(),
        });
      }
    }
    const attacks: { id: string; attacker: string; troops: number }[] = [];
    for (const a of me.incomingAttacks()) {
      const type = a.attacker().type();
      if (type === PlayerType.Bot) continue;
      attacks.push({
        id: a.id(),
        attacker: a.attacker().id(),
        troops: a.troops(),
      });
    }
    const home = me.troops();
    const cap = ctx.game.config().maxTroops(me);
    // T6 asks the generators only when it could fire: no bordering nation,
    // home near the cap.
    const naval =
      this.o.searchClock <= 0 &&
      nations.length === 0 &&
      home >= NAVAL_HOME * cap &&
      this.naval.some((g) => g.wantsNaval!(ctx, host));
    // Package WP10n T8 (MIRV threat): only when the nuke candidates are on
    // and the triggers (not the clock) drive the search (off: both false, so
    // T8 never fires).
    const mirv =
      this.o.searchNukes && this.o.searchClock <= 0
        ? mirvThreatState(ctx.game, me, this.o)
        : { threat: false, chance: false };
    return {
      t,
      inStall: host.inStall(t),
      home,
      cap,
      nations,
      attacks,
      naval,
      mirvThreat: mirv.threat,
      mirvChance: mirv.chance,
    };
  }

  /** The attack trigger's nation, as the base's attackers would show it
   *  (T4: attacking now; T5: at the foreseen tick), for the generators. */
  private known(
    obs: TriggerObs,
    fired: Fired,
  ): ReadonlyMap<PlayerID, AttackSeen> {
    const known = new Map<PlayerID, AttackSeen>();
    if (fired.nation === undefined) return known;
    let troops = 0;
    for (const a of obs.attacks) {
      if (a.attacker === fired.nation) troops += a.troops;
    }
    known.set(fired.nation, { h: fired.in ?? 0, troops });
    return known;
  }

  /** One try of a search at `fired`. */
  private search(
    ctx: AgentContext,
    host: SearchHost,
    obs: TriggerObs,
    fired: Fired,
  ): Outcome {
    const o = this.o;
    const t = ctx.tick;
    const wm = host.wm();
    if (wm === null) return { ran: false, none: true };
    const start = performance.now();
    const sv: SearchView = {
      ctx,
      host,
      o,
      t,
      game: ctx.game,
      me: ctx.me,
      wm,
      floors: host.floors(),
      kinds: this.kinds,
    };
    const map = ctx.game.config().gameConfig().gameMap;
    const phi = phiFor(map);
    const cm: CostModel = {
      phi,
      H1: o.searchH1,
      H: o.searchH,
      HStrong: o.searchHStrong,
      breakLast: Math.max(...o.searchHBreak),
      keep: o.searchKeepFinalists,
      grid: HORIZON_GRID,
    };
    const r1 = generatorsFor("r1", this.kinds);
    const known = this.known(obs, fired);
    // The base's attackers, with the attack trigger's nation (on top).
    const withKnown = (b: BaseView): BaseView =>
      known.size === 0
        ? b
        : {
            ...b,
            attackers: new Map([
              ...b.attackers,
              ...[...known].filter(([id]) => !b.attackers.has(id)),
            ]),
          };
    const listsOf = (b: BaseView) =>
      r1.map((g) => g.generate(sv, withKnown(b)));
    // A low-priority trigger may not spend the last searchReserve.
    const reserve = fired.low ? o.searchReserve : 0;
    const room = () => this.budget.room(t) - reserve;
    const why = `why=${fired.why}${reserve > 0 ? ` reserve=${reserve}` : ""}`;

    // Before forking: on the triggers, a search needs a plan from the live
    // state alone (the base's attackers add ally plans later), and the
    // budget must hold the base's first round and the smallest search.
    const first = phi.first + o.searchH1;
    const empty: BaseView = { h: 0, attackers: new Map(), snaps: [] };
    const pre = roundOneCandidates(
      listsOf(empty),
      o.searchStackGate,
      o.searchMaxCands,
    );
    if (o.searchClock <= 0 && pre.length === 0) {
      this.stats.none++;
      ctx.log(`search-none ${t} ${fired.name} ${why}`);
      return { ran: false, none: true };
    }
    if (this.budget.capped && pre.length > 0) {
      if (degrade(pre, cm, room() - first).kept.length === 0) {
        return this.refuse(ctx, fired, first + cheapest(pre, cm), why);
      }
    }

    // The forks: one ctx.fork() per search (a structural clone of the live
    // game), never stepped, and a clone of it for each rollout (a
    // ForkSource's forks must be made before its game ticks).
    let source: ForkSource | null = null;
    const fork = (): { f: GameFork; phi: number; ms: number } => {
      const f0 = performance.now();
      let firstFork = false;
      if (source === null) {
        source = ctx.fork().source();
        firstFork = true;
      }
      const f = source.fork();
      return {
        f,
        phi: firstFork ? phi.first : phi.each,
        ms: performance.now() - f0,
      };
    };
    const runners: Runner[] = [];
    const spent = () => runners.reduce((a, r) => a + r.cost(), 0);
    const open = (
      name: string,
      spec: RolloutSpec,
      send?: { h: number; target: string },
      alliances?: boolean,
    ): Runner => {
      const { f, phi: cost, ms } = fork();
      const r = new Runner({
        name,
        fork: f,
        policy: host.forRolloutWith(spec),
        budget: BudgetMirror.fromContext(ctx),
        gameID: ctx.gameID,
        clientID: ctx.clientID,
        phi: cost,
        forkMs: ms,
        grid: this.grid,
        send,
        alliances,
        danger: DANGER,
        boats: o.searchOutBoats,
      });
      runners.push(r);
      return r;
    };
    const openCand = (c: Candidate): Runner =>
      open(
        c.name,
        { steps: c.steps, replace: true },
        c.strongCheck && c.target !== null
          ? { h: c.lastSend, target: c.target }
          : undefined,
        c.isBreak,
      );

    // The base plays what live plays if no plan is adopted: the pending
    // steps (no replace).
    const base = open("base", {});
    base.advance(o.searchH1);
    const all = roundOneCandidates(
      listsOf({ h: base.h, attackers: base.attackers, snaps: base.snaps }),
      o.searchStackGate,
      o.searchMaxCands,
    );
    let cands = all;
    let level = 0;
    if (this.budget.capped && all.length > 0) {
      const d = degrade(all, cm, room() - base.cost());
      if (d.kept.length === 0) {
        // Nothing fits after the base's first round: a refusal (the base's
        // checks still hold: it is what live plays).
        const te = base.cost();
        this.budget.charge(te);
        this.stats.te += te;
        this.addChecks(t, base.snaps, base.h);
        return this.refuse(ctx, fired, te + cheapest(all, cm), why, te);
      }
      level = d.level;
      cands = d.kept;
    }

    // Round 2b's generators, within what the budget has left.
    const r2b = generatorsFor("r2b", this.kinds);
    const names = new Set(cands.map((c) => c.name));
    const defend =
      r2b.length === 0
        ? undefined
        : (b: BaseView): Candidate[] => {
            const out: Candidate[] = [];
            let left = room() - spent();
            for (const c of r2b.flatMap((g) => g.generate(sv, withKnown(b)))) {
              if (names.has(c.name)) continue;
              const cost = phi.each + b.h;
              if (this.budget.capped && cost > left) break;
              left -= cost;
              names.add(c.name);
              out.push(c);
            }
            return out;
          };

    const need = actMargin(
      ctx.me.numTilesOwned(),
      o.searchMargin,
      o.searchMarginAbs,
    );
    const p: RoundsParams = {
      H1: o.searchH1,
      prune: o.searchPrune,
      H: o.searchH,
      HStrong: o.searchHStrong,
      strongShare: o.searchStrongShare,
      HBreak: [...o.searchHBreak].sort((a, b) => a - b),
      HBreakGated: o.searchHBreakGated,
      keep: o.searchKeepFinalists,
      dip: o.searchDip,
      need,
      rival: o.searchRival,
      value: this.valueParams,
      grid: HORIZON_GRID,
      minContact: o.searchMinContact,
      tiles0: ctx.me.numTilesOwned(),
      lossShare: DEFEND_LOSS,
      afford: this.budget.capped
        ? (more) => room() - spent() >= more
        : undefined,
    };
    const res = runRounds(p, base, cands, openCand, defend);

    // Play the choice.
    const te = spent();
    this.budget.charge(te);
    const chosen = res.chosen;
    const act = chosen !== null && o.searchMode === "act";
    if (act) {
      host.adopt({ steps: chosen.cand.steps, replace: true });
      this.checks.invalidate(t);
      this.triggers.acted(t);
      this.stats.acts++;
      const kind = chosen.cand.kind;
      this.stats.actsByKind[kind] = (this.stats.actsByKind[kind] ?? 0) + 1;
    }
    const pick = act ? chosen.roll : base;
    this.addChecks(t, pick.snaps, act ? chosen.h! : base.h);
    const foreseen = [...pick.attackers].map(([id, a]) => ({
      id,
      at: t + a.h,
    }));

    // The logs.
    const ms = performance.now() - start;
    this.stats.searches++;
    this.stats.byTrigger[fired.name] =
      (this.stats.byTrigger[fired.name] ?? 0) + 1;
    this.stats.te += te;
    this.stats.ms += ms;
    const shown = chosen ?? res.best;
    const vb = shown?.vb ?? res.baseAt.get(o.searchH) ?? NaN;
    const r = (x: number) => (Number.isFinite(x) ? String(Math.round(x)) : "-");
    ctx.log(
      `search ${t} ${fired.name} cands=${cands.length} ` +
        `chosen=${chosen === null ? "base" : chosen.cand.name} ` +
        `gain=${res.best === null ? "-" : r(res.best.gain)} base=${r(vb)} ` +
        `h=${shown?.h ?? o.searchH} te=${Math.round(te)} ms=${Math.round(ms)} ` +
        `level=${DEGRADE[level]}` +
        (o.searchMode === "plans" ? " mode=plans" : "") +
        (res.gate !== null
          ? ` gate=${res.gate.a ? "a" : ""}${res.gate.b ? "b" : ""}${res.gate.a || res.gate.b ? "" : "-"}`
          : "") +
        (o.searchClock > 0 ? "" : ` ${why}`),
    );
    ctx.log(
      `search-feat ${JSON.stringify(this.features(ctx, host, fired, chosen, res.best, level))}`,
    );
    ctx.log(`search-rows ${JSON.stringify(this.rows(t, base, res.judged))}`);
    return { ran: true, foreseen };
  }

  /** The checks of the rollout live follows, forked at `t0` and judged at
   *  `h`: the plan's points and h, or every snap (searchCheckAll). */
  private addChecks(t0: number, snaps: readonly Snap[], h: number): void {
    if (this.o.searchCheckAll) {
      this.checks.add(t0, snaps);
      return;
    }
    const at = new Set([...PLAN_CHECKS, h]);
    this.checks.add(
      t0,
      snaps.filter((s) => at.has(s.h)),
    );
  }

  /** A budget refusal: logged; the search needs `need` (after `te`, the
   *  base's first round, when that ran and was charged), payable at the
   *  returned tick. */
  private refuse(
    ctx: AgentContext,
    fired: Fired,
    need: number,
    why: string,
    te = 0,
  ): Outcome {
    const t = ctx.tick;
    this.stats.refused++;
    const reserve = fired.low ? this.o.searchReserve : 0;
    const room = this.budget.room(t) - reserve;
    ctx.log(
      `search ${t} ${fired.name} skipped=budget need=${Math.round(need)} room=${Math.round(room)}` +
        (te > 0 ? ` te=${Math.round(te)}` : "") +
        ` ${why}`,
    );
    return {
      ran: false,
      retryAt: this.budget.affordableAt(t, need + reserve),
    };
  }

  /** The state features of a search (for learning when to search). */
  private features(
    ctx: AgentContext,
    host: SearchHost,
    fired: Fired,
    chosen: Judged | null,
    best: Judged | null,
    level: number,
  ): Record<string, unknown> {
    const me = ctx.me;
    const t = ctx.tick;
    const floors = host.floors();
    let rank = 1;
    let top = 0;
    for (const p of ctx.game.players()) {
      if (p === me || p.type() === PlayerType.Bot || !p.isAlive()) continue;
      if (p.numTilesOwned() > me.numTilesOwned()) rank++;
      top = Math.max(top, p.numTilesOwned());
    }
    const nbrs: unknown[] = [];
    for (const n of host.wm()?.nations ?? []) {
      if (n.type !== PlayerType.Nation || !ctx.game.hasPlayer(n.id)) continue;
      const N = ctx.game.player(n.id);
      if (!N.isAlive()) continue;
      const al = me.allianceWith(N);
      nbrs.push({
        id: n.id,
        T: Math.round(N.troops()),
        M: Math.round(ctx.game.config().maxTroops(N)),
        tiles: N.numTilesOwned(),
        contact: n.contact,
        ally: al === null ? null : al.expiresAt() - t,
      });
    }
    const stall = host.state.stall.since;
    return {
      t,
      trigger: fired.name,
      why: fired.why,
      map: ctx.game.config().gameConfig().gameMap,
      tiles: me.numTilesOwned(),
      land: ctx.game.numLandTiles() - ctx.game.numTilesWithFallout(),
      home: Math.round(me.troops()),
      cap: Math.round(ctx.game.config().maxTroops(me)),
      H: Math.round(floors.H),
      strike: Math.round(host.available("strike")),
      stall: stall === null ? null : t - stall,
      traitor: me.isTraitor(),
      rank,
      top,
      gold: Number(me.gold()),
      nbrs,
      chosen: chosen?.cand.name ?? "base",
      gain:
        best === null || !Number.isFinite(best.gain)
          ? null
          : Math.round(best.gain),
      level: DEGRADE[level],
      spent: Math.round(this.budget.spent),
      danger: DANGER === null ? null : DANGER(ctx.game, me),
    };
  }

  /** Every rollout of a search, as the act3 prototype logged them. */
  private rows(t: number, base: Runner, judged: readonly Judged[]): unknown {
    const row = (r: Runner, j: Judged | null) => ({
      name: r.name,
      te: Math.round(r.cost()),
      forkMs: Math.round(r.forkMs),
      simMs: Math.round(r.simMs),
      h: r.h,
      j: j?.h ?? null,
      v: finite(
        value(r.last(), this.valueParams, r.land0, r.landAt(r.last().h)),
      ),
      gain: j === null ? null : finite(j.gain),
      drop: j?.drop ?? null,
      strong: j?.strong ? true : undefined,
      gated: j?.gated ? true : undefined,
      steps:
        j !== null && j.steps.length > 0
          ? j.steps.map((s) => [s.h, Math.round(s.gain)])
          : undefined,
      atk: [...r.attackers].map(([id, x]) => [id, x.h, Math.round(x.troops)]),
      snaps: r.snaps,
    });
    return {
      t,
      rows: [row(base, null), ...judged.map((j) => row(j.roll as Runner, j))],
    };
  }
}
