import { Game, Player, PlayerID, PlayerType } from "../../../core/game/Game";
import {
  AgentContext,
  AgentIntent,
  AgentOutcome,
  IntentBudgetRemaining,
  SendResult,
} from "../../Agent";
import { Ledger } from "../../lib/Ledger";
import { Lookahead, RolloutPolicy, SimView } from "../../lib/Lookahead";
import { createModels, Models } from "../../lib/Models";
import { NationModel, relationTracker } from "../../lib/NationModel";
import {
  buildRaceGrid,
  OwnerGrid,
  ownerGrid,
  RaceGrid,
} from "../../lib/RaceField";
import { createPurse, HomeFloors, Purse, Scheduler } from "../../lib/Scheduler";
import { scanWorld, WorldModel } from "../../lib/WorldModel";
import { DefenseController } from "./controllers/DefenseController";
import { DiplomacyController } from "./controllers/DiplomacyController";
import { EconomyController } from "./controllers/EconomyController";
import { EndgameController } from "./controllers/EndgameController";
import { ExpansionController } from "./controllers/ExpansionController";
import { NavalController } from "./controllers/NavalController";
import { SpawnController } from "./controllers/SpawnController";
import { StrikeController } from "./controllers/StrikeController";
import { homeFloors, NO_FLOORS } from "./HomeTarget";
import { ApexOptions, BooleanOption } from "./options";
import { ApexState, stateLog } from "./state";

// The apex policy (spec §2.10, §3.0): runs the controllers over one View per
// tick. Pure given (game, state): controllers never read ctx.random,
// Date.now() or performance.now(), keep no state of their own (it lives in
// ApexState), and act only through View.scheduler. So the same policy runs
// live and, cloned, inside a rollout (forRollout).

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
}

export class ApexPolicy {
  private readonly spawn = new SpawnController();
  private readonly expansion = new ExpansionController();
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
    Pick<Runtime, "wm" | "floors" | "owners" | "refreshList" | "refreshCursor">
  > | null = null;

  constructor(
    private readonly o: ApexOptions,
    private readonly s: ApexState,
  ) {
    const all: Record<ControllerName, Controller> = {
      defense: new DefenseController(),
      diplomacy: new DiplomacyController(),
      endgame: new EndgameController(),
      strike: new StrikeController(),
      expansion: this.expansion,
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

  /** Live: builds the View, runs the controllers in priority order (§3),
   *  flushes the Scheduler through ctx.send. */
  tick(ctx: AgentContext): void {
    this.run({
      game: ctx.game,
      me: ctx.me,
      tick: ctx.tick,
      gameID: ctx.gameID,
      budget: () => ctx.budget(),
      send: (i) => ctx.send(i),
      live: ctx,
      log: (line) => ctx.log(line),
    });
  }

  /** For rollouts: a copy with structuredClone(state) and lookahead
   *  disabled. Each call copies the live state as it is at the call. */
  forRollout(): RolloutPolicy {
    this.syncState();
    const copy = new ApexPolicy(this.o, structuredClone(this.s));
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
      });
    }
    return { step: (v) => copy.step(v) };
  }

  /** One rollout step: the intents this tick's policy sends, rate limited
   *  by the fork's BudgetMirror on the fork clock. */
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
    rt.ledger.observe(env.me, t);
    rt.nm.observe(t);

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
        { tick: t, o, me: env.me, models: rt.models, nm: rt.nm },
        s,
      );
    }
    const purse = createPurse(homeAvailable(env.me, rt.floors), rt.floors);
    rt.scheduler.begin(t, env.budget(), purse);
    const v = this.view(env, rt, wm, purse);

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
    // Step 5: full nation refreshes, round-robin (fewer on decision ticks,
    // see refreshNations).
    this.refreshNations(rt, t, decision);
    // Step 6.
    rt.scheduler.flush(env.send, rt.ledger, t);
    this.drainLogs(env, rt);
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
      `invalid ${st.invalid}; refused ${JSON.stringify(st.refused)}; ` +
      `relation mismatches ${rt.nm.log.length}`;
    stateLog(this.s, line);
    ctx.log(line);
  }

  private runtime(env: Env): Runtime {
    const rt = this.rt;
    if (rt !== null && rt.game === env.game && rt.me === env.me) return rt;
    const { o, s } = this;
    const models = createModels(env.game);
    const nm = new NationModel(env.game, env.me, env.gameID, models);
    nm.relations = relationTracker(s.relations);
    this.rt = {
      game: env.game,
      me: env.me,
      models,
      nm,
      ledger: Ledger.fromData(s.ledger),
      scheduler: new Scheduler(o, env.game.config().msPerTick()),
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
      for (const id of this.expansion.nationsNearTribes()) ids.add(id);
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
   * §3.0 step 5: nationRefreshPerTick full refreshes per tick, round-robin.
   * Think-time budget: a decision tick already carries the scan and the
   * allocator, so it does half of them (rounded down) and the ticks between
   * decisions make up the rest, keeping thinkEvery·nationRefreshPerTick per
   * decision cycle (thinkEvery ≥ 2).
   */
  private refreshNations(rt: Runtime, tick: number, decision: boolean): void {
    const list = rt.refreshList;
    if (list.length === 0) return;
    const per = this.o.nationRefreshPerTick;
    const te = Math.max(1, this.o.thinkEvery);
    let k = per;
    if (te >= 2) {
      const onDecision = Math.floor(per / 2);
      k = decision ? onDecision : Math.ceil((per * te - onDecision) / (te - 1));
    }
    k = Math.min(k, list.length);
    if (k <= 0) return;
    const start = rt.refreshCursor % list.length;
    for (let i = 0; i < k; i++) {
      rt.nm.refresh(list[(start + i) % list.length], "full");
    }
    rt.refreshCursor = (start + k) % list.length;
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
