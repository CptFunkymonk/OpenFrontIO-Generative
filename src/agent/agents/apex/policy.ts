import { Game, Player, PlayerID, PlayerType } from "../../../core/game/Game";
import {
  AgentContext,
  AgentIntent,
  AgentOutcome,
  IntentBudgetRemaining,
  SendResult,
} from "../../Agent";
import { Ledger } from "../../lib/Ledger";
import {
  isValidIntent,
  Lookahead,
  RolloutPolicy,
  SimView,
} from "../../lib/Lookahead";
import { createModels, Models } from "../../lib/Models";
import { NationModel, relationTracker } from "../../lib/NationModel";
import { NukeModel } from "../../lib/NukeModel";
import {
  buildRaceGrid,
  OwnerGrid,
  ownerGrid,
  RaceGrid,
} from "../../lib/RaceField";
import {
  createPurse,
  HomeFloors,
  Proposal,
  Purse,
  Scheduler,
  SpendKind,
} from "../../lib/Scheduler";
import { scanWorld, WorldModel } from "../../lib/WorldModel";
import { DefenseController } from "./controllers/DefenseController";
import { DiplomacyController } from "./controllers/DiplomacyController";
import {
  EconomyController,
  finishedCityLevels,
  inboundNukeLevels,
} from "./controllers/EconomyController";
import { EndgameController } from "./controllers/EndgameController";
import {
  ExpansionController,
  inStall,
} from "./controllers/ExpansionController";
import { NavalController, NavalMemos } from "./controllers/NavalController";
import { SpawnController } from "./controllers/SpawnController";
import { StrikeController } from "./controllers/StrikeController";
import { homeFloors, NO_FLOORS } from "./HomeTarget";
import { leaderRefloor } from "./LeaderHook";
import { ApexOptions, BooleanOption } from "./options";
import {
  ApexState,
  DIRECTIVE_MIN_TROOPS,
  DirectiveStep,
  SearchMemory,
  stateLog,
} from "./state";

export type { DirectiveStep } from "./state";

// The apex policy (spec §2.10, §3.0): runs the controllers over one View per
// tick. Pure given (game, state): controllers never read ctx.random,
// Date.now() or performance.now(), keep no state of their own (it lives in
// ApexState), and act only through View.scheduler. So the same policy runs
// live and, cloned, inside a rollout (forRollout, forRolloutWith).
//
// Package WP1 (docs/14-m4-plan.md §2.1-2.2) makes the clone exact and lets a
// search play plans:
// - forRolloutWith(spec) copies the live policy with everything it carries
//   from tick to tick (the state, the last decision's scan and floors, the
//   Scheduler's send windows, the NationModel and NukeModel, the naval
//   memos), plus the spec's directive steps. Stepped on a fork taken at the
//   start of a live tick, the copy sends what the live policy will send.
// - setDirective(steps) gives the live policy the same steps. Each tick's
//   run offers the steps due after scheduler.begin and before the reflexes,
//   through the same Scheduler, Purse and Ledger as every send, so the live
//   game follows the chosen rollout.
// - A LiveSearch (WP2's SearchController) runs at the start of every live
//   tick past the spawn phase, before the run, with a SearchHost onto the
//   policy. Never inside a rollout: a copy has no search, so a rollout is
//   "the plan, then the rules".

/** What every controller sees. Rebuilt every tick; never reassign a field. */
export interface View {
  game: Game;
  me: Player;
  tick: number;
  gameID: string;
  o: ApexOptions;
  models: Models;
  /** The scan of the last decision (at most thinkEvery − 1 ticks old). */
  wm: WorldModel;
  nm: NationModel;
  /** Package B3: the nuke-rule replica (spec §2.9), observed every tick
   *  (launch counts for the perceived prices; O(1) while no bomb flies).
   *  Optional so hand-built Views stay valid. */
  nukes?: NukeModel;
  /** Not in spec §2.10's View; the allocator reads stacks and plans from it
   *  (§3.6.2-3.6.3, §3.6.7). */
  ledger: Ledger;
  race: RaceGrid | null;
  owners: OwnerGrid | null;
  scheduler: Scheduler;
  purse: Purse;
  /** Null inside rollouts (no nested forks), and live when no enabled
   *  feature forks (see usesLookahead). */
  lookahead: Lookahead | null;
  /** Not in spec §2.10's View: ApexPolicy.forRollout for the spawn rollouts
   *  (§3.2.5). Null inside rollouts. */
  forRollout: (() => RolloutPolicy) | null;
  /** Null inside rollouts. */
  live: AgentContext | null;
  /** Not in spec §2.10's View: appends to ApexState.log and, live, to
   *  ctx.log (the arena keeps it per game). Never read by decisions. */
  log?: (line: string) => void;
  /** Package WP1: the policy's naval memos, keyed by OwnerGrid stamp
   *  (NavalController). Optional so hand-built Views stay valid. */
  navalMemos?: NavalMemos;
}

export interface Controller {
  readonly name: string;
  /** Every tick, cheap. */
  onTick?(v: View, s: ApexState): void;
  /** Every decision. */
  decide?(v: View, s: ApexState): void;
}

/** Every controller but Spawn, by name, with the option that enables it.
 *  Spawn always runs in the spawn phase (its lowest setting is spawnMode
 *  "plan"). */
export const CONTROLLER_FLAGS = {
  defense: "defense",
  diplomacy: "diplomacy",
  endgame: "endgame",
  strike: "strike",
  expansion: "expansion",
  naval: "boats",
  economy: "economy",
} as const satisfies Record<string, BooleanOption>;

type ControllerName = keyof typeof CONTROLLER_FLAGS;

/** §3.0 step 3: Defense, then Diplomacy (recall and counter-accept). Other
 *  controllers with an onTick (timed launches) follow in decide order. */
const ON_TICK_ORDER: readonly ControllerName[] = [
  "defense",
  "diplomacy",
  "endgame",
  "strike",
  "expansion",
  "naval",
  "economy",
];
/** §3.0 step 4: Endgame, Strike, Expansion, Naval, Economy, then Diplomacy
 *  upkeep. */
const DECIDE_ORDER: readonly ControllerName[] = [
  "endgame",
  "strike",
  "expansion",
  "naval",
  "economy",
  "diplomacy",
  "defense",
];

/** Ticks between two full refreshes of one nation by the round-robin (the
 *  cadence without o.refreshBeforeDecision; a floor with it). */
export const REFRESH_MIN_TICKS = 10;
/** With o.refreshBeforeDecision a nation is refreshed once in the last
 *  REFRESH_LEAD ticks before each of its decisions. */
export const REFRESH_LEAD = 10;
/** Border tiles the round-robin's full refreshes may walk per tick (about
 *  1 ms, see refreshNations). */
export const REFRESH_BORDER_BUDGET = 5_000;

/** NationModel log lines copied to the host log at the end of a game. */
const NM_NOTES = 5;

/** Ticks between two status lines in the host log. */
const STATUS_EVERY = 300;

/** OwnerGrid refresh cadence in ticks (§3.0 cadence table). */
export const OWNER_GRID_EVERY = 100;
/** Tiles the OwnerGrid samples per refresh (stride √(W·H/40,000),
 *  model-first §4.6). */
const OWNER_GRID_SAMPLES = 40_000;

/** Home troops a spend can use: me.troops(), at most ceil(cap). Troops
 *  above the cap are cut by the next turn's regrowth step before an intent
 *  sent now executes, and the attack takes min(asked, home) [PIN
 *  TroopCapClamp]. `floors.cap` is the decision's cap (0 before the first
 *  decision: no bound). */
export function homeAvailable(me: Player, floors: HomeFloors): number {
  const home = me.troops();
  return floors.cap > 0 ? Math.min(home, Math.ceil(floors.cap)) : home;
}

/**
 * The round-robin's rule for one nation (refreshNations): never refreshed,
 * or REFRESH_MIN_TICKS since its last refresh and, given its next decision
 * `next` (o.refreshBeforeDecision), inside the REFRESH_LEAD ticks up to it
 * (next − REFRESH_LEAD, next] and not yet refreshed there.
 */
export function refreshDue(
  last: number | undefined,
  tick: number,
  next: number | null,
): boolean {
  if (last === undefined) return true;
  if (tick - last < REFRESH_MIN_TICKS) return false;
  if (next === null) return true;
  return next - tick < REFRESH_LEAD && last <= next - REFRESH_LEAD;
}

/**
 * o.nukeReflex: enemy bombs in flight will delete `lost` finished city
 * levels (inboundNukeLevels), and our home is above the cap left after
 * them, or null.
 */
export function nukeThreat(
  game: Game,
  me: Player,
  models: Models,
  tick: number,
): ApexState["nuke"] {
  const lost = inboundNukeLevels(game, me);
  if (lost <= 0) return null;
  const capAfter = models.capAt(
    PlayerType.Human,
    me.numTilesOwned(),
    Math.max(0, finishedCityLevels(me) - lost),
  );
  return me.troops() > capAfter ? { lost, capAfter, at: tick } : null;
}

/** Whether an enabled feature forks outside rollouts, so the live policy
 *  needs a Lookahead. */
export function usesLookahead(o: ApexOptions): boolean {
  return (
    o.spawnMode === "idle" ||
    o.spawnMode === "rollout" ||
    o.strikeFork ||
    o.allyOracle ||
    o.defenseSearch
  );
}

/** Where the policy reads the game and sends to: the live context, or a
 *  rollout's fork. */
interface Env {
  game: Game;
  me: Player;
  tick: number;
  gameID: string;
  budget(): IntentBudgetRemaining;
  send(i: AgentIntent): SendResult;
  live: AgentContext | null;
  /** ctx.log, live only. */
  log: ((line: string) => void) | null;
}

/** The objects built over one game. Rebuilt when the game changes (a
 *  rollout's fork). */
interface Runtime {
  game: Game;
  me: Player;
  models: Models;
  nm: NationModel;
  nukes: NukeModel;
  ledger: Ledger;
  scheduler: Scheduler;
  lookahead: Lookahead | null;
  race: RaceGrid | null;
  owners: OwnerGrid | null;
  wm: WorldModel | null;
  floors: HomeFloors;
  /** Nations refreshed round-robin (§3.0 step 5), set each decision. */
  refreshList: PlayerID[];
  /** Where the round-robin continues in refreshList. */
  refreshCursor: number;
  /** Tick of each nation's last full refresh by the round-robin. */
  refreshedAt: Map<PlayerID, number>;
  /** Package WP1: the naval memos (View.navalMemos). */
  naval: NavalMemos;
}

/** Package WP1: what a rollout copy takes from the live runtime, copied at
 *  forRolloutWith (so a copy stepped later still starts where the live
 *  policy was): the models are bound to the fork at the copy's first
 *  step. */
interface CopySource {
  nm: NationModel;
  nukes: NukeModel;
  scheduler: Scheduler;
  naval: NavalMemos;
}

// ── Package WP1: rollouts, plans and the live search ────────────────────

/**
 * A plan for forRolloutWith and, adopted, for the live policy. `steps` go
 * after the directive steps still pending (DirectiveStep; absolute live
 * ticks), or replace them with `replace`: a base rollout (no spec) plays
 * the pending steps, as the live game will unless a new plan is adopted.
 * So roll the base without `replace` unless keeping the base clears the
 * live directive too (a base with `replace` while steps are pending is not
 * what live plays). `replace` drops steps, not the foe marks in force: a
 * plan that allies a foe first clears its mark (a foe step with `until`
 * before its `at`).
 */
export interface RolloutSpec {
  steps?: readonly DirectiveStep[];
  replace?: boolean;
  /** Options of the copy (measurement only: such a plan cannot be played
   *  live, see adopt). */
  o?: Partial<ApexOptions>;
  /** Moves the copy's decision cadence this many ticks earlier (the null
   *  variants of /tmp/claude-0/growth/search.md §4; measurement only). */
  shift?: number;
}

/** A rollout copy of the live policy (forRolloutWith). */
export interface RolloutCopy extends RolloutPolicy {
  /** The copy's state (read only): its directive, foe marks, stats and
   *  log ring, and its Ledger's and relation tracker's data as of its last
   *  step (written into the state at each call). */
  state(): Readonly<ApexState>;
}

/**
 * The live policy as a LiveSearch sees it at the start of a live tick,
 * before the tick's run: everything as the last tick left it. Read only,
 * but for the plan it plays (setDirective, adopt). Queries go to copies
 * (nationModel, ledger), never to the live policy's own objects, so a
 * search never moves the live game except through its plan.
 */
export interface SearchHost {
  readonly o: ApexOptions;
  /** The live state, with its Ledger's and relation tracker's data as the
   *  last run left them (written into it at the first read after each
   *  run). Read only. */
  readonly state: Readonly<ApexState>;
  /** The last decision's scan (null before the first decision). */
  wm(): WorldModel | null;
  /** The last decision's floors (NO_FLOORS before the first). */
  floors(): HomeFloors;
  /** purse.available(kind) of a purse built now from me.troops() and
   *  floors(): what a step sized by `frac` gets at a send this tick unless
   *  this tick's decision moves the floors. */
  available(kind: SpendKind): number;
  /** Stall mode at `tick` on the live state (ExpansionController.inStall). */
  inStall(tick: number): boolean;
  /** The live models and grids (null before the first decision). Plain
   *  data or stateless: read them, never write them. */
  models(): Models | null;
  race(): RaceGrid | null;
  owners(): OwnerGrid | null;
  /** A private copy of the live NationModel, made at the first call of the
   *  tick and observed at this tick (as this tick's run will observe the
   *  live one before its decisions): refresh and query it at will, it
   *  never feeds the live policy. Null before the first decision. */
  nationModel(): NationModel | null;
  /** A private copy of the live Ledger, fresh at each call and observed at
   *  this tick as this tick's run will observe the live one: its plans, and
   *  our attacks and ships in flight (stackOn, retreatingOn,
   *  expectedRefunds). */
  ledger(): Ledger | null;
  /** A copy of the live policy as it is now, playing `spec`. */
  forRolloutWith(spec?: RolloutSpec): RolloutCopy;
  /** Plays `spec` live: the edit of the directive forRolloutWith(spec)
   *  made in its copy, so the live game follows that rollout. Call it in
   *  the tick the rollouts were forked. Throws for a spec with options or a
   *  shift, or with a step due before this tick. */
  adopt(spec: RolloutSpec): void;
  /** The same edit from steps (setDirective). */
  setDirective(steps: readonly DirectiveStep[], replace?: boolean): void;
}

/**
 * Package WP1's hook for WP2's SearchController. The live policy calls
 * tick() at the start of every live tick past the spawn phase while we are
 * alive, before anything else (no nested search: rollout copies have
 * none), then runs the tick, then calls afterTick with what the tick sent.
 * At latency 1 nothing we sent is in flight at that point, so a fork taken
 * in tick() is the state the tick's run will act on (at latency L the
 * turns in flight must be replayed into the fork, as Lookahead.fork and
 * tests/agent/ForkFidelity.test.ts describe). An exception is rethrown
 * after the tick's run, so the live game never loses a tick to it.
 * Construct the policy with it: `new ApexPolicy(o, s, search)` (ApexAgent,
 * when o.search is on).
 */
export interface LiveSearch {
  tick(ctx: AgentContext, host: SearchHost): void;
  /** After the tick's run, with the intents ctx.send accepted. */
  afterTick?(ctx: AgentContext, sent: readonly AgentIntent[]): void;
  gameOver?(ctx: AgentContext, outcome: AgentOutcome): void;
}

/** `p` with its troops set to `troops`: an attack's (intent, spend and
 *  meta.clampTroops, as the window strikes size theirs) or a boat's
 *  (intent and spend); null for any other intent. */
function withTroops(p: Proposal, troops: number): Proposal | null {
  const i = p.intent;
  const spend =
    p.spend === undefined ? undefined : { kind: p.spend.kind, troops };
  if (i.type === "attack") {
    return {
      ...p,
      intent: { ...i, troops },
      spend,
      meta: { ...p.meta, clampTroops: troops },
    };
  }
  if (i.type === "boat") return { ...p, intent: { ...i, troops }, spend };
  return null;
}

/**
 * `p` with meta.target set for an attack on a player that has none (review
 * F4): the Ledger resolves an attack without it from the targets it has
 * learnt, and a rollout copy's Ledger (from LedgerData) has learnt fewer
 * than the live one, so live would hold a plan and a pending stack from
 * the send that the copy holds only once the attack shows (never, if it
 * does not). Every controller sets it; a directive step may not.
 */
function withTarget(game: Game, p: Proposal): Proposal {
  const i = p.intent;
  if (i.type !== "attack" || p.meta?.target !== undefined) return p;
  const id = i.targetID;
  if (id !== null && !game.hasPlayer(id)) return p;
  const target = id === null ? 0 : game.player(id).smallID();
  return { ...p, meta: { ...p.meta, target } };
}

/** A plan's edit of a directive: the same in a copy and live. */
function applySteps(
  mem: SearchMemory,
  steps: readonly DirectiveStep[],
  replace: boolean,
): void {
  if (replace) mem.directive = [];
  for (const d of steps) mem.directive.push(structuredClone(d));
}

export class ApexPolicy {
  private readonly spawn = new SpawnController();
  private readonly onTicks: Controller[];
  private readonly decides: Controller[];
  private readonly rolloutFactory = () => this.forRollout();
  private rt: Runtime | null = null;
  private inRollout = false;
  /** Tick of the last status line (logs only). */
  private lastStatus = -Infinity;
  /** The live policy's race grid, handed to rollouts: its terrain arrays
   *  never change, and building one costs up to 0.6 s. */
  private sharedRace: RaceGrid | null = null;
  /** For a rollout copy: the live runtime's plain-data fields at the fork,
   *  so the copy keeps the live decision cadence (no extra decision at its
   *  first step) and the same scan, floors and refresh order. */
  private carry: Partial<
    Pick<
      Runtime,
      | "wm"
      | "floors"
      | "owners"
      | "refreshList"
      | "refreshCursor"
      | "refreshedAt"
    >
  > | null = null;
  /** For a rollout copy: the live runtime's models and memory, copied at
   *  forRolloutWith (package WP1). */
  private source: CopySource | null = null;
  /** Package WP1: the live search (null in rollout copies). */
  private readonly search: LiveSearch | null;
  private searchHost: SearchHost | null = null;
  /** SearchHost.nationModel's copy and the tick it was made at. */
  private nmCopy: { tick: number; nm: NationModel } | null = null;
  /** Whether the state holds the Ledger and relation data of the runtime
   *  as the last run left it (SearchHost.state). */
  private stateSynced = false;

  /** `search`: the LiveSearch to run live (package WP1), with o.search. */
  constructor(
    private readonly o: ApexOptions,
    private readonly s: ApexState,
    search: LiveSearch | null = null,
  ) {
    this.search = search;
    const all: Record<ControllerName, Controller> = {
      defense: new DefenseController(),
      diplomacy: new DiplomacyController(),
      endgame: new EndgameController(),
      strike: new StrikeController(),
      expansion: new ExpansionController(),
      naval: new NavalController(),
      economy: new EconomyController(),
    };
    const enabled = (n: ControllerName) => o[CONTROLLER_FLAGS[n]];
    this.onTicks = ON_TICK_ORDER.filter(
      (n) => enabled(n) && all[n].onTick !== undefined,
    ).map((n) => all[n]);
    this.decides = DECIDE_ORDER.filter(
      (n) => enabled(n) && all[n].decide !== undefined,
    ).map((n) => all[n]);
  }

  /** The controllers that run, spawn first, then in decide order (onTick-only
   *  controllers included). For logs and tests. */
  activeControllers(): string[] {
    const names = new Set<string>([this.spawn.name]);
    for (const n of DECIDE_ORDER) {
      if (this.o[CONTROLLER_FLAGS[n]]) names.add(n);
    }
    return [...names];
  }

  /** Live: the search's turn (package WP1), then builds the View, runs the
   *  controllers in priority order (§3), flushes the Scheduler through
   *  ctx.send. */
  tick(ctx: AgentContext): void {
    const search = this.search;
    if (search === null && this.o.search) {
      throw new Error(
        "apex option search is on, but no LiveSearch was given " +
          "(ApexAgent wires the SearchController, docs/14-m4-plan.md §3 WP2)",
      );
    }
    let error: unknown = null;
    const searching =
      search !== null && !ctx.game.inSpawnPhase() && ctx.me.isAlive();
    if (searching) {
      try {
        search.tick(ctx, this.host());
      } catch (e) {
        error = e;
      }
    }
    const sent: AgentIntent[] = [];
    // The run moves the Ledger and the relations: host.state syncs again.
    this.stateSynced = false;
    this.run({
      game: ctx.game,
      me: ctx.me,
      tick: ctx.tick,
      gameID: ctx.gameID,
      budget: () => ctx.budget(),
      send: (i) => {
        const r = ctx.send(i);
        if (r === "ok" && search !== null) sent.push(i);
        return r;
      },
      live: ctx,
      log: (line) => ctx.log(line),
    });
    if (searching && error === null) {
      try {
        search.afterTick?.(ctx, sent);
      } catch (e) {
        error = e;
      }
    }
    if (error !== null) throw error;
  }

  /** For rollouts: forRolloutWith() without a plan (the pending directive
   *  steps play). Each call copies the live policy as it is at the call. */
  forRollout(): RolloutPolicy {
    return this.forRolloutWith();
  }

  /**
   * Package WP1 (docs/14-m4-plan.md §2.2): an exact copy of this policy as
   * it is at the call, playing `spec`'s plan, with lookahead and search
   * off. It carries the state (structuredClone), the last decision's scan,
   * floors, owner grid and refresh order, the Scheduler's send windows and
   * cancel guard (copyFrom), the NationModel and NukeModel (cloneFor), the
   * naval memos and the race grid (shared: it never changes), all copied
   * now. Stepped on a fork taken at the start of a live tick, before the
   * live policy's run of that tick, with a BudgetMirror.fromContext of the
   * same moment, it sends tick for tick what the live policy sends given
   * the same directive (tests/agent/RolloutFidelity.test.ts).
   */
  forRolloutWith(spec: RolloutSpec = {}): RolloutCopy {
    this.syncState();
    const o = spec.o === undefined ? this.o : { ...this.o, ...spec.o };
    const copy = new ApexPolicy(o, structuredClone(this.s));
    copy.inRollout = true;
    copy.sharedRace = this.rt?.race ?? this.sharedRace;
    const rt = this.rt;
    if (rt !== null) {
      copy.carry = structuredClone({
        wm: rt.wm,
        floors: rt.floors,
        owners: rt.owners,
        refreshList: rt.refreshList,
        refreshCursor: rt.refreshCursor,
        refreshedAt: rt.refreshedAt,
      });
      const nm = rt.nm.cloneFor(rt.game, rt.me, rt.models);
      const scheduler = new Scheduler(o, rt.game.config().msPerTick());
      scheduler.copyFrom(rt.scheduler);
      copy.source = {
        nm,
        nukes: rt.nukes.cloneFor(rt.game, rt.me, nm),
        scheduler,
        naval: rt.naval.copy(),
      };
    }
    if (spec.shift !== undefined) copy.s.timers.lastThink -= spec.shift;
    applySteps(copy.s.search, spec.steps ?? [], spec.replace === true);
    return {
      step: (v) => copy.step(v),
      state: () => {
        copy.syncState();
        return copy.s;
      },
    };
  }

  /**
   * Package WP1: live, the steps of an adopted plan (after the pending
   * ones, or instead of them with `replace`), offered in the runs of their
   * ticks. The same edit forRolloutWith({steps, replace}) makes in its
   * copy, so the live game follows that copy's rollout.
   */
  setDirective(steps: readonly DirectiveStep[], replace = false): void {
    applySteps(this.s.search, steps, replace);
  }

  /** The SearchHost onto this (live) policy. */
  private host(): SearchHost {
    if (this.searchHost !== null) return this.searchHost;
    // The state's Ledger and relation data are written at each copy (and
    // read only when a runtime is built): written again at the first read
    // after each run, so host.state never shows an older tick's plans.
    const synced = () => {
      if (!this.stateSynced) {
        this.syncState();
        this.stateSynced = true;
      }
      return this.s;
    };
    this.searchHost = {
      o: this.o,
      get state() {
        return synced();
      },
      wm: () => this.rt?.wm ?? null,
      floors: () => this.rt?.floors ?? NO_FLOORS,
      available: (kind) => {
        const rt = this.rt;
        if (rt === null) return 0;
        const purse = createPurse(homeAvailable(rt.me, rt.floors), rt.floors);
        return purse.available(kind);
      },
      inStall: (tick) => inStall(this.s, tick, this.o),
      models: () => this.rt?.models ?? null,
      race: () => this.rt?.race ?? null,
      owners: () => this.rt?.owners ?? null,
      nationModel: () => {
        const rt = this.rt;
        if (rt === null) return null;
        const t = rt.game.ticks();
        if (this.nmCopy === null || this.nmCopy.tick !== t) {
          // Observed at this tick, as the run's step 2 observes the live
          // model (review F2: unobserved, it was one tick behind).
          const nm = rt.nm.cloneFor(rt.game, rt.me, rt.models);
          nm.observe(t);
          this.nmCopy = { tick: t, nm };
        }
        return this.nmCopy.nm;
      },
      ledger: () => {
        const rt = this.rt;
        if (rt === null) return null;
        // Observed at this tick, as the run's step 2 observes the live
        // Ledger (review F2: from LedgerData alone its view of our attacks
        // in flight is empty, and stackOn missed every one of them).
        const l = Ledger.fromData(rt.ledger.toData());
        l.observe(rt.me, rt.game.ticks(), rt.game);
        return l;
      },
      forRolloutWith: (spec) => this.forRolloutWith(spec),
      adopt: (spec) => {
        if (spec.o !== undefined || (spec.shift ?? 0) !== 0) {
          throw new Error(
            "adopt: a plan with options or a cadence shift cannot be played live",
          );
        }
        // A step due before this tick would go out later than its rollout
        // sent it: adopt a plan in the tick its rollouts were forked.
        const t = this.rt?.game.ticks() ?? -Infinity;
        const late = (spec.steps ?? []).find((d) => d.at < t);
        if (late !== undefined) {
          throw new Error(
            `adopt: a step at tick ${late.at} is before tick ${t}`,
          );
        }
        this.setDirective(spec.steps ?? [], spec.replace === true);
      },
      setDirective: (steps, replace) => this.setDirective(steps, replace),
    };
    return this.searchHost;
  }

  /** One rollout step: the intents this tick's policy sends, rate limited
   *  by the fork's BudgetMirror on the fork clock. An invalid intent is
   *  refused before the budget, as AgentHost.send refuses it (review F3:
   *  counted as sent, it spent the mirror's budget and entered the Ledger
   *  and the class windows, which live it never does). */
  private step(v: SimView): AgentIntent[] {
    const sent: AgentIntent[] = [];
    const nowMs = v.tick * v.game.config().msPerTick();
    this.run({
      game: v.game,
      me: v.me,
      tick: v.tick,
      gameID: v.gameID,
      budget: () => v.budget.remaining(nowMs),
      send: (i) => {
        if (!isValidIntent(i)) return "invalid";
        if (!v.budget.tryConsume(nowMs)) return "rate_limited";
        sent.push(i);
        return "ok";
      },
      live: null,
      log: null,
    });
    return sent;
  }

  /** The loop of §3.0. */
  private run(env: Env): void {
    const { o, s } = this;
    const rt = this.runtime(env);
    const t = env.tick;

    // Step 1: in the spawn phase only the SpawnController, never in a
    // rollout (rollouts start after the spawn).
    if (env.game.inSpawnPhase()) {
      if (this.inRollout) return;
      if (rt.race === null && o.spawnMode !== "plan" && t >= o.spawnDelay) {
        rt.race = buildRaceGrid(env.game, o);
      }
      const wm = scanWorld(env.game, env.me, rt.wm);
      rt.wm = wm;
      const purse = createPurse(env.me.troops(), NO_FLOORS);
      rt.scheduler.begin(t, env.budget(), purse);
      this.spawn.onTick(this.view(env, rt, wm, purse), s);
      rt.scheduler.flush(env.send, rt.ledger, t);
      this.drainLogs(env, rt);
      return;
    }
    s.spawn.endTick ??= t;
    if (!env.me.isAlive()) return;

    // Step 2 (scheduler.begin below).
    rt.ledger.observe(env.me, t, env.game);
    rt.nm.observe(t);
    rt.nukes.observe();

    // Step 4's scanWorld, HomeTarget and Purse, moved ahead of step 3:
    // scheduler.begin takes the Purse, which needs this decision's floors,
    // and the reflexes read the scan. Paced by elapsed ticks: the browser
    // delivers ticks in batches.
    let wm = rt.wm;
    const decision = wm === null || t - s.timers.lastThink >= o.thinkEvery;
    // (`wm === null` again so the checker sees wm set after the block.)
    if (decision || wm === null) {
      s.timers.lastThink = t;
      wm = scanWorld(env.game, env.me, rt.wm);
      rt.wm = wm;
      this.refreshGrids(env, rt);
      rt.floors = homeFloors(
        // game and log: package WP10b's leader guard (o.leaderGuard).
        {
          tick: t,
          o,
          me: env.me,
          models: rt.models,
          nm: rt.nm,
          game: env.game,
          log: env.log,
        },
        s,
      );
      const nuke = o.nukeReflex
        ? nukeThreat(env.game, env.me, rt.models, t)
        : null;
      if (nuke !== null && s.nuke === null) {
        env.log?.(
          `${t} nuke inbound: ${nuke.lost} city levels, cap after ` +
            `${Math.round(nuke.capAfter)} < home ${Math.round(env.me.troops())}`,
        );
      }
      s.nuke = nuke;
    } else if (o.leaderGuard) {
      // Package WP10b (review F1): a break of a plan adopted since the
      // decision (the search acts at any tick) re-floors now.
      rt.floors = leaderRefloor(
        {
          tick: t,
          o,
          me: env.me,
          models: rt.models,
          nm: rt.nm,
          game: env.game,
          log: env.log,
        },
        s,
        rt.floors,
      );
    }
    const purse = createPurse(homeAvailable(env.me, rt.floors), rt.floors);
    rt.scheduler.begin(t, env.budget(), purse);
    const v = this.view(env, rt, wm, purse);

    // Package WP1: the search's plan, before the reflexes (docs/14-m4-plan.md
    // §2.1 steps 2-3).
    this.directive(v, s.search);

    // Step 3: reflexes.
    for (const c of this.onTicks) c.onTick?.(v, s);
    // Step 4: decisions.
    if (decision) {
      for (const c of this.decides) c.decide?.(v, s);
      // After Diplomacy's plan, which sets the web's lists.
      rt.refreshList = this.refreshList(env.game, wm);
      if (env.log !== null && t - this.lastStatus >= STATUS_EVERY) {
        this.lastStatus = t;
        this.status(v, rt);
      }
    }
    // Step 5: full nation refreshes, round-robin, under a think-time budget
    // (refreshNations).
    this.refreshNations(rt, t, decision);
    // Step 6.
    rt.scheduler.flush(env.send, rt.ledger, t);
    this.drainLogs(env, rt);
  }

  /**
   * Package WP1: the directive's run of this tick (after scheduler.begin,
   * before the reflexes). The steps due (at ≤ this tick) leave the
   * directive; their foe marks go first; then the foe marks in force veto
   * `ally:<id>` and `ext:<id>` (expired ones are dropped); then the due
   * proposals are offered in order, an attack or boat sized by `frac` from
   * this tick's purse. A skipped or refused step is logged and dropped.
   */
  private directive(v: View, mem: SearchMemory): void {
    const t = v.tick;
    const due: DirectiveStep[] = [];
    if (mem.directive.length > 0) {
      const later: DirectiveStep[] = [];
      for (const d of mem.directive) (d.at <= t ? due : later).push(d);
      if (due.length > 0) mem.directive = later;
    }
    for (const d of due) {
      if (d.foe === undefined) continue;
      mem.foes[d.foe.id] = d.foe.until;
      v.log?.(`${t} directive foe ${d.foe.id} until ${d.foe.until}`);
    }
    for (const [id, until] of Object.entries(mem.foes)) {
      if (until < t) {
        delete mem.foes[id];
        continue;
      }
      v.scheduler.veto(`ally:${id}`);
      v.scheduler.veto(`ext:${id}`);
    }
    for (const d of due) if (d.p !== undefined) this.offerStep(v, mem, d, d.p);
  }

  /** One directive proposal (see directive). */
  private offerStep(
    v: View,
    mem: SearchMemory,
    d: DirectiveStep,
    given: Proposal,
  ): void {
    const t = v.tick;
    const label = d.label ?? given.intent.type;
    const skip = (why: string) => {
      mem.stats.skipped++;
      v.log?.(`${t} directive ${label} skipped (${why})`);
    };
    const allied = (id: PlayerID) =>
      v.game.hasPlayer(id) && v.me.isAlliedWith(v.game.player(id));
    const w = d.when;
    if (w?.allied !== undefined && !allied(w.allied)) {
      return skip(`not allied with ${w.allied}`);
    }
    if (w?.unallied !== undefined && allied(w.unallied)) {
      return skip(`allied with ${w.unallied}`);
    }
    let p: Proposal | null = withTarget(v.game, given);
    let size = "";
    if (d.frac !== undefined) {
      const S = Math.floor(
        d.frac * v.purse.available(given.spend?.kind ?? "strike"),
      );
      if (S < (d.minTroops ?? DIRECTIVE_MIN_TROOPS)) return skip(`S=${S}`);
      p = withTroops(p, S);
      if (p === null) return skip(`no troops to size on ${given.intent.type}`);
      size = ` S=${S}`;
    }
    mem.stats.offered++;
    const ok = v.scheduler.offer(p);
    if (!ok) mem.stats.refused++;
    v.log?.(
      `${t} directive ${label}${size} ` +
        (ok ? "ok" : `refused ${String(v.scheduler.lastRefusal)}`),
    );
  }

  /** A status line for the host log (never read by decisions). */
  private status(v: View, rt: Runtime): void {
    const kinds: Record<string, number> = {};
    for (const p of rt.ledger.allPlans()) {
      kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
    }
    const f = rt.floors;
    const k = (x: number) => `${Math.round(x / 1000)}k`;
    v.log?.(
      `status t=${v.tick} tiles=${v.wm.tiles} home=${k(v.wm.home)} ` +
        `cap=${k(f.cap)} H=${k(f.H)} tn=${k(f.tn)} vw=${k(f.vw)} ` +
        `free=${v.wm.freeFrontier} tribes=${v.wm.tribes.length} ` +
        `nations=${v.wm.nations.length} plans=${JSON.stringify(kinds)} ` +
        `stall=${this.s.stall.since ?? "-"} refresh=${rt.refreshList.length}`,
    );
  }

  /** A one-line summary for the end of the game (host logs only). */
  gameOver(ctx: AgentContext, outcome: AgentOutcome): void {
    const rt = this.rt;
    if (rt === null) return;
    const st = rt.scheduler.stats;
    const line =
      `apex ${outcome.result} at ${ctx.tick}: offered ${st.offered}, ` +
      `accepted ${st.accepted}, sent ${st.sent}, rate-limited ${st.rateLimited}, ` +
      `invalid ${st.invalid}; refused ${JSON.stringify(st.refused)} ` +
      `(class caps ${JSON.stringify(st.classCapped)}); ` +
      `NationModel notes ${rt.nm.log.length} (last ${NM_NOTES} follow)`;
    stateLog(this.s, line);
    ctx.log(line);
    for (const note of rt.nm.log.slice(-NM_NOTES)) ctx.log(`nm ${note}`);
    this.search?.gameOver?.(ctx, outcome);
  }

  private runtime(env: Env): Runtime {
    const rt = this.rt;
    if (rt !== null && rt.game === env.game && rt.me === env.me) return rt;
    // Review F5: the live runtime a copy carries is bound at its first step
    // and used up there; on another game it would silently start cold.
    if (rt !== null && this.inRollout) {
      throw new Error(
        "apex: a rollout copy plays only the game of its first step; " +
          "take a new one (forRolloutWith) for each fork",
      );
    }
    const { o, s } = this;
    const models = createModels(env.game);
    // A rollout copy binds the live runtime's models and memory, copied at
    // forRolloutWith, to its fork (package WP1).
    const src = this.source;
    this.source = null;
    let nm: NationModel;
    if (src !== null) {
      nm = src.nm.cloneFor(env.game, env.me, models);
    } else {
      nm = new NationModel(env.game, env.me, env.gameID, models);
      nm.relations = relationTracker(s.relations);
    }
    this.rt = {
      game: env.game,
      me: env.me,
      models,
      nm,
      nukes:
        src !== null
          ? src.nukes.cloneFor(env.game, env.me, nm)
          : new NukeModel(env.game, env.me, nm),
      ledger: Ledger.fromData(s.ledger),
      scheduler:
        src?.scheduler ?? new Scheduler(o, env.game.config().msPerTick()),
      lookahead:
        !this.inRollout && usesLookahead(o)
          ? new Lookahead({
              msPer10s: o.forkMsPer10s,
              wallBudgetMs: o.spawnWallBudgetMs,
            })
          : null,
      race: this.sharedRace,
      owners: null,
      wm: null,
      floors: NO_FLOORS,
      refreshList: [],
      refreshCursor: 0,
      refreshedAt: new Map(),
      naval: src?.naval ?? new NavalMemos(),
      ...this.carry,
    };
    this.carry = null;
    return this.rt;
  }

  private view(env: Env, rt: Runtime, wm: WorldModel, purse: Purse): View {
    return {
      game: env.game,
      me: env.me,
      tick: env.tick,
      gameID: env.gameID,
      o: this.o,
      models: rt.models,
      wm,
      nm: rt.nm,
      nukes: rt.nukes,
      ledger: rt.ledger,
      race: rt.race,
      owners: rt.owners,
      scheduler: rt.scheduler,
      purse,
      lookahead: rt.lookahead,
      forRollout: this.inRollout ? null : this.rolloutFactory,
      live: env.live,
      log: (line) => {
        stateLog(this.s, line);
        env.log?.(line);
      },
      navalMemos: rt.naval,
    };
  }

  /** The race grid once, and the OwnerGrid every OWNER_GRID_EVERY ticks,
   *  when reach (the web) or boats need them. */
  private refreshGrids(env: Env, rt: Runtime): void {
    const { o } = this;
    if (!((o.diplomacy && o.web) || o.boats)) return;
    rt.race ??= buildRaceGrid(env.game, o);
    if (rt.owners === null || env.tick - rt.owners.stamp >= OWNER_GRID_EVERY) {
      const { game } = env;
      const stride = Math.max(
        1,
        Math.round(
          Math.sqrt((game.width() * game.height()) / OWNER_GRID_SAMPLES),
        ),
      );
      rt.owners = ownerGrid(game, rt.race, stride);
    }
  }

  /** Bordering nations, the web's reachable ones, then the nations next
   *  to our tribes (the allocator's contest and buffer weights, §3.6.4);
   *  living ones only (§3.0 step 5). */
  private refreshList(game: Game, wm: WorldModel): PlayerID[] {
    const ids = new Set<PlayerID>();
    for (const n of wm.nations) {
      if (n.type === PlayerType.Nation) ids.add(n.id);
    }
    for (const id of this.s.web.allySet) ids.add(id);
    for (const id of this.s.web.food) ids.add(id);
    if (this.o.expansion) {
      for (const id of this.s.nearTribes) ids.add(id);
    }
    const out: PlayerID[] = [];
    for (const id of ids) {
      if (!game.hasPlayer(id)) continue;
      const p = game.player(id);
      if (p.isAlive() && p.type() === PlayerType.Nation) out.push(id);
    }
    return out;
  }

  /**
   * §3.0 step 5: at most nationRefreshPerTick full refreshes per tick,
   * round-robin over refreshList, under a think-time budget. A full refresh
   * costs one N.nearby(), linear in N's border (0.18-0.20 µs per border
   * tile: about 1 ms for a 5,000-tile border at minute 3, 3-5 ms for the
   * 15-25k-tile borders of GiantWorldMap's late game), so:
   * - with o.refreshBeforeDecision, a nation is refreshed once per decision
   *   interval (30-49 ticks), in the REFRESH_LEAD ticks before its next
   *   decision: the state that decision is forecast from. Without it, or
   *   before its parameters are known (rate 1), every REFRESH_MIN_TICKS.
   *   Its live troops are read at every use anyway;
   * - a tick spends at most REFRESH_BORDER_BUDGET border tiles on them,
   *   half of it on a decision tick (which carries the scan and the
   *   allocator). A nation whose border alone is over the budget is
   *   refreshed alone, and only on a tick without a decision.
   * The budget is in border tiles, not wall time, so decisions stay
   * deterministic. A nation the budget stops is first on the next tick.
   * (Spec §3.0's "≤ 1 ms" holds to about minute 8 on GiantWorldMap; past
   * it, the refresh of one large nation alone costs more, on a tick with
   * little else.)
   */
  private refreshNations(rt: Runtime, tick: number, decision: boolean): void {
    const list = rt.refreshList;
    const n = list.length;
    if (n === 0) return;
    const budget = decision ? REFRESH_BORDER_BUDGET / 2 : REFRESH_BORDER_BUDGET;
    // With a decision every tick there is no other tick to run it on.
    const alone = !decision || this.o.thinkEvery <= 1;
    let done = 0;
    let used = 0;
    let i = 0;
    const start = rt.refreshCursor % n;
    for (; i < n && done < this.o.nationRefreshPerTick; i++) {
      const id = list[(start + i) % n];
      if (!this.refreshDue(rt, id, tick)) continue;
      const border = rt.game.player(id).borderTiles().size;
      if (used + border > budget && (done > 0 || !alone)) break;
      rt.nm.refresh(id, "full");
      rt.refreshedAt.set(id, tick);
      used += border;
      done++;
    }
    rt.refreshCursor = (start + i) % n;
  }

  /** Whether the round-robin refreshes nation `id` at `tick`. */
  private refreshDue(rt: Runtime, id: PlayerID, tick: number): boolean {
    return refreshDue(
      rt.refreshedAt.get(id),
      tick,
      this.o.refreshBeforeDecision ? rt.nm.nextDecision(id, tick) : null,
    );
  }

  /** The Scheduler's rate-limit and invalid notes into the logs. */
  private drainLogs(env: Env, rt: Runtime): void {
    for (const line of rt.scheduler.takeLog()) {
      stateLog(this.s, line);
      env.log?.(line);
    }
  }

  /** Writes the live objects' data into the state, so a clone carries them. */
  private syncState(): void {
    const rt = this.rt;
    if (rt === null) return;
    this.s.ledger = rt.ledger.toData();
    this.s.relations = rt.nm.relations.toData();
  }
}
