import { Game, GameType, Player } from "../../../../core/game/Game";
import { TileRef } from "../../../../core/game/GameMap";
import type { AgentContext } from "../../../Agent";
import type { GameFork } from "../../../Fork";
import {
  Lookahead,
  RolloutPolicy,
  RolloutResult,
  value,
} from "../../../lib/Lookahead";
import {
  ArrivalField,
  buildRaceGrid,
  idleArrival,
  IdleSample,
  idleSample,
  MIN_DISC_FREE,
  RaceGrid,
  SpawnCandidate,
  spawnCandidates,
  spawnDiscFree,
  staticArrival,
} from "../../../lib/RaceField";
import { Prio } from "../../../lib/Scheduler";
import { planSpawn } from "../../../lib/SpawnPlanner";
import type { ApexOptions, SpawnMode } from "../options";
import type { Controller, View } from "../policy";
import { type ApexState, noteLine } from "../state";

// The spawn (spec §3.2). Modes, by o.spawnMode:
// - "plan": SpawnPlanner.planSpawn's tile, as the baseline spawns (E4's
//   control).
// - "race": RaceField's static arrival fields and candidates (§3.2.1-3.2.4).
// - "idle": the same candidates on arrival times read off a fork stepped
//   o.spawnIdleTicks with the spawn phase ended and us absent (§3.2.2).
// - "rollout": successive halving of real rollouts of this policy from the
//   best candidates (§3.2.5).
// "idle" and "rollout" need the policy's Lookahead; without it (or when the
// fork is refused) they fall back to "race", and the mode recorded in
// s.spawn.mode says which ran.
//
// Failure modes (§3.2.7): every send re-checks the candidate's disc (fewer
// than MIN_DISC_FREE free tiles: the next candidate), and if we have not
// spawned RESEND_TICKS after a send (the disc was taken, or the intent lost)
// the next candidate goes out. An exhausted list is planned again on the
// current state.
//
// Browser (§3.2.6): the replica keeps ticking while the worker plans, and
// nations hop, so a spawn planned on the current tick would land on a
// different map. The controller then plans on a fork advanced to a predicted
// tick T* and sends at T* − 1. An agent cannot see which host runs it, so the
// signal is the option the browser is told to pass: spawnWallBudgetMs ≤
// BROWSER_SPAWN_WALL_MS (see isBrowserSpawn).

/** Ticks after a send before a spawn that did not land is resent (§3.2.4). */
export const RESEND_TICKS = 10;
/** Idle fork: ticks between samples (§3.2.2). */
export const IDLE_SAMPLE_EVERY = 150;
/** Rollout value: c̄ = 17 troops per tile (§3.2.5, value(·, 17)). */
export const ROLLOUT_CBAR = 17;
/** spawnWallBudgetMs at or below this means the browser host (§3.2.6:
 *  "rollouts are off in the browser (spawnWallBudgetMs = 20,000)"). */
export const BROWSER_SPAWN_WALL_MS = 20_000;
/** §3.2.6 step 1: the planning wall time W of mode race (and plan). */
const BROWSER_RACE_MS = 1000;
/** §3.2.6 step 1: W of mode idle, per idle tick. */
const BROWSER_IDLE_MS_PER_TICK = 8;
/** §3.2.6 step 2: T* = tick + W/100 ms + 20. */
const T_STAR_SLACK = 20;
/** A timed (multiplayer) spawn phase: decide this many ticks before its end,
 *  as the baseline does, since nations hop until then. */
const TIMED_PHASE_LEAD = 30;
/** A timed phase: never plan to send later than this before its end. */
const TIMED_PHASE_LAST = 2;

/** Whether the browser's spawn rules apply (§3.2.6): planned at T*, and no
 *  rollouts. */
export function isBrowserSpawn(o: ApexOptions): boolean {
  return o.spawnWallBudgetMs <= BROWSER_SPAWN_WALL_MS;
}

/** The first tick the controller acts at: o.spawnDelay in singleplayer,
 *  whose phase is untimed and ends at our spawn [PIN SpawnPhaseSingleplayer];
 *  near the end of a timed phase otherwise. */
export function spawnTick(game: Game, o: ApexOptions): number {
  const config = game.config();
  if (config.gameConfig().gameType === GameType.Singleplayer) {
    return o.spawnDelay;
  }
  return Math.max(o.spawnDelay, config.numSpawnPhaseTurns() - TIMED_PHASE_LEAD);
}

/** What one plan produced: tiles to try in order. */
export interface SpawnPlan {
  /** Candidate tiles, best first. */
  queue: TileRef[];
  /** Index of the tile last sent (or to send next, before the first send). */
  next: number;
  /** A tile is sent only while its disc holds this many free tiles. */
  minDisc: number;
  /** Browser: send when the replica reaches this tick (T* − 1). */
  sendAt: number | null;
  /** The mode that produced the queue ("race" when idle/rollout fell
   *  back). */
  mode: SpawnMode;
  /** The candidates behind the queue (null for "plan"), for logs and
   *  tests. */
  candidates: SpawnCandidate[] | null;
  /** Mode rollout: what each rolled-out candidate reached. */
  rollouts: RolloutRecord[];
}

export interface RolloutRecord {
  tile: TileRef;
  source: SpawnCandidate["source"];
  round: 1 | 2;
  result: RolloutResult;
  value: number;
}

/**
 * Spawn phase only (spec §3.2). The policy calls `onTick` on every
 * spawn-phase tick and runs no other controller then (§3.0 step 1), never
 * inside a rollout. It has no enable flag: `o.spawnMode` "plan" is its
 * lowest setting.
 *
 * Unlike the other controllers it keeps its plan (the candidate list) in the
 * instance rather than in ApexState: it never runs inside a rollout, its plan
 * ends with the spawn phase, and ApexState.spawn has room for the chosen tile
 * only. The decisions it records are in s.spawn.
 */
export class SpawnController implements Controller {
  readonly name = "spawn";
  private current: SpawnPlan | null = null;

  /** The plan in use (null before the first eligible tick). For tests and
   *  logs. */
  get plan(): Readonly<SpawnPlan> | null {
    return this.current;
  }

  onTick(v: View, s: ApexState): void {
    const { game, me, tick, o } = v;
    if (me.hasSpawned()) return;
    if (tick < spawnTick(game, o)) return;
    const sentAt = s.spawn.sentAt;
    if (sentAt !== null && tick - sentAt < RESEND_TICKS) return;

    let plan = this.current;
    if (plan === null) {
      plan = this.makePlan(v, true);
      this.current = plan;
      this.notePlan(v, s, plan, "");
    } else if (sentAt !== null) {
      // The last send did not land: the next candidate (§3.2.4, §3.2.7).
      this.note(v, s, `spawn at ${xy(game, plan.queue[plan.next])} failed`);
      plan.next++;
    }
    if (plan.sendAt !== null && tick < plan.sendAt) return;

    let tile = pickTile(game, plan);
    if (tile === null) {
      // Every candidate's disc is taken: plan again on this state.
      plan = this.makePlan(v, false);
      this.current = plan;
      this.notePlan(v, s, plan, "replan: ");
      tile = pickTile(game, plan);
    }
    if (tile === null) {
      this.note(v, s, "no spawnable tile found");
      return;
    }
    const accepted = v.scheduler.offer({
      intent: { type: "spawn", tile },
      prio: Prio.Emergency,
      cls: "spawn",
      key: "spawn",
    });
    if (!accepted) return;
    s.spawn.planned = tile;
    s.spawn.sentAt = tick;
    s.spawn.mode = plan.mode;
    this.note(
      v,
      s,
      `spawn (${plan.mode}) at ${xy(game, tile)}, candidate ${plan.next + 1}/${plan.queue.length}`,
    );
  }

  // ── Planning ──────────────────────────────────────────────────────────

  /** A plan by the mode in effect. `browser`: apply the T* rule when the
   *  host is the browser (never for a replan, which must send at once). */
  private makePlan(v: View, browser: boolean): SpawnPlan {
    const { o, game, me, live } = v;
    const mode = effectiveMode(v);
    if (browser && live !== null && isBrowserSpawn(o) && mode !== "plan") {
      const planned = this.browserPlan(v, live, mode);
      if (planned !== null) return planned;
    }
    return this.planOn(v, mode, game, me);
  }

  /** A plan by `mode` on (game, me): the live game, or a fork of it. */
  private planOn(v: View, mode: SpawnMode, game: Game, me: Player): SpawnPlan {
    if (mode === "plan") {
      const t = planSpawn(game, me);
      return {
        queue: t === null ? [] : [t],
        next: 0,
        minDisc: 1,
        sendAt: null,
        mode,
        candidates: null,
        rollouts: [],
      };
    }
    const grid = this.grid(v);
    if (mode === "idle") {
      const arr = this.idleField(v, grid);
      if (arr !== null) return candidatePlan(grid, arr, game, me, v.o, mode);
    }
    const plan = candidatePlan(
      grid,
      staticArrival(grid, game, v.o),
      game,
      me,
      v.o,
      "race",
    );
    if (mode === "rollout") this.rollouts(v, plan);
    return plan;
  }

  /** The policy's race grid, else one built for this plan. */
  private grid(v: View): RaceGrid {
    return v.race ?? buildRaceGrid(v.game, v.o);
  }

  /** §3.2.2 mode idle: arrival from a fork stepped o.spawnIdleTicks with the
   *  phase ended and us absent. Null when no fork is allowed. */
  private idleField(
    v: View,
    grid: RaceGrid,
    base?: GameFork,
  ): ArrivalField | null {
    const la = v.lookahead;
    if (la === null || v.live === null) return null;
    const f = base ?? la.fork(v.live, []);
    if (f === null) return null;
    const samples: IdleSample[] = [];
    la.idleFuture(f, v.o.spawnIdleTicks, IDLE_SAMPLE_EVERY, (g, t) =>
      samples.push(idleSample(g, grid, t)),
    );
    return idleArrival(grid, samples, v.o);
  }

  /**
   * §3.2.5: the best o.spawnRolloutK candidates plus planSpawn's and the
   * island ones, each rolled out o.spawnRound1 ticks from its spawn with a
   * copy of this policy; the best o.spawnKeep by value(·, 17) extended to
   * o.spawnFinal, chosen by tiles (V breaks ties). The wall budget
   * (o.spawnWallBudgetMs, enforced by Lookahead.fork) cuts it: the best so
   * far wins. Reorders plan.queue with the winner first.
   */
  private rollouts(v: View, plan: SpawnPlan): void {
    const la = v.lookahead;
    const live = v.live;
    const factory = v.forRollout;
    const cands = plan.candidates;
    if (la === null || live === null || factory === null || cands === null) {
      return;
    }
    const pool = rolloutPool(cands, v.o.spawnRolloutK);
    interface Run {
      cand: SpawnCandidate;
      fork: GameFork;
      policy: RolloutPolicy;
      result: RolloutResult;
      value: number;
      order: number;
    }
    // Best value first; among the dead (value −Infinity), the longest
    // survivor; then candidate order.
    const byValue = (a: Run, b: Run) =>
      b.value - a.value || b.result.ticks - a.result.ticks || a.order - b.order;
    let kept: Run[] = [];
    for (const [order, cand] of pool.entries()) {
      const fork = la.fork(live, [{ type: "spawn", tile: cand.tile }]);
      if (fork === null) break; // over the wall budget: the best so far wins
      const policy = factory();
      const result = la.rollout(fork, live.clientID, policy, v.o.spawnRound1);
      const val = value(result, ROLLOUT_CBAR);
      plan.rollouts.push({
        tile: cand.tile,
        source: cand.source,
        round: 1,
        result,
        value: val,
      });
      kept.push({ cand, fork, policy, result, value: val, order });
      // Only the best spawnKeep forks stay alive (each is a full game).
      kept = kept.sort(byValue).slice(0, Math.max(1, v.o.spawnKeep));
    }
    if (kept.length === 0) return;

    // Round 2: the living kept runs extended to spawnFinal, chosen by
    // tiles, V breaking ties. A round 2 cut by the budget decides among
    // the runs it finished; none finished: round 1's order.
    const extend = Math.max(0, v.o.spawnFinal - v.o.spawnRound1);
    const done: Run[] = [];
    for (const run of kept) {
      if (!run.result.alive) continue;
      if (extend === 0) {
        done.push(run);
        continue;
      }
      if (la.spawnMs() >= v.o.spawnWallBudgetMs) break;
      const r2 = la.rollout(run.fork, live.clientID, run.policy, extend);
      const result = { ...r2, ticks: run.result.ticks + r2.ticks };
      const val = value(result, ROLLOUT_CBAR);
      plan.rollouts.push({
        tile: run.cand.tile,
        source: run.cand.source,
        round: 2,
        result,
        value: val,
      });
      done.push({ ...run, result, value: val });
    }
    const pick =
      done.length > 0
        ? done.sort(
            (a, b) =>
              Number(b.result.alive) - Number(a.result.alive) ||
              b.result.tiles - a.result.tiles ||
              byValue(a, b),
          )[0]
        : kept[0];
    const winner = pick.cand.tile;
    plan.queue = [winner, ...plan.queue.filter((t) => t !== winner)];
    plan.mode = "rollout";
  }

  /**
   * §3.2.6: fork, advance to T* = tick + W/100 ms + 20 with no intents (the
   * nations hop in the fork as in the game), plan there, and send at T* − 1.
   * Mode idle takes its arrival times from the same fork stepped on from T*
   * and picks tiles on the live map (re-checked when sent). Null when no
   * fork can be made.
   */
  private browserPlan(
    v: View,
    live: AgentContext,
    mode: SpawnMode,
  ): SpawnPlan | null {
    const { o, game, tick } = v;
    const browserMode: SpawnMode = mode === "rollout" ? "idle" : mode;
    const wallMs =
      browserMode === "idle"
        ? o.spawnIdleTicks * BROWSER_IDLE_MS_PER_TICK
        : BROWSER_RACE_MS;
    let tStar =
      tick + Math.ceil(wallMs / game.config().msPerTick()) + T_STAR_SLACK;
    if (game.config().gameConfig().gameType !== GameType.Singleplayer) {
      tStar = Math.min(
        tStar,
        game.config().numSpawnPhaseTurns() - TIMED_PHASE_LAST,
      );
    }
    const f = forkOf(v.lookahead, live);
    if (f === null) return null;
    if (tStar > tick) f.advance(tStar - tick);
    const fme = f.game.playerByClientID(live.clientID);
    if (fme === null) return null;
    let plan: SpawnPlan;
    const grid = browserMode === "idle" ? this.grid(v) : null;
    const arr = grid !== null ? this.idleField(v, grid, f) : null;
    if (grid !== null && arr !== null) {
      // The fork is now past T*: pick the tiles on the live map.
      plan = candidatePlan(grid, arr, game, v.me, o, "idle");
    } else {
      plan = this.planOn(
        v,
        browserMode === "idle" ? "race" : browserMode,
        f.game,
        fme,
      );
    }
    plan.sendAt = tStar - 1;
    return plan;
  }

  private notePlan(v: View, s: ApexState, plan: SpawnPlan, prefix: string) {
    for (const r of plan.rollouts) {
      const res = r.result;
      this.note(
        v,
        s,
        `rollout r${r.round} at ${xy(v.game, r.tile)} (${r.source}): tiles ${res.tiles} value ${r.value.toFixed(0)} ticks ${res.ticks}${res.alive ? "" : " dead"}`,
      );
    }
    this.note(v, s, prefix + planLine(v, plan));
  }

  private note(v: View, s: ApexState, line: string): void {
    noteLine(v, s, line);
  }
}

/** o.spawnMode, degraded where it cannot run: without a Lookahead (or live
 *  context) idle and rollout become race; the browser never rolls out; a
 *  random-spawn game ignores the tile, so the cheapest mode will do. */
function effectiveMode(v: View): SpawnMode {
  const { o, game } = v;
  if (game.config().isRandomSpawn()) return "plan";
  const mode = o.spawnMode;
  if (mode === "idle" || mode === "rollout") {
    if (v.lookahead === null || v.live === null) return "race";
    if (mode === "rollout" && (v.forRollout === null || isBrowserSpawn(o))) {
      return isBrowserSpawn(o) ? "idle" : "race";
    }
  }
  return mode;
}

/** Candidates on these arrival times, as a plan (best first). */
function candidatePlan(
  grid: RaceGrid,
  arr: ArrivalField,
  game: Game,
  me: Player,
  o: ApexOptions,
  mode: SpawnMode,
): SpawnPlan {
  const candidates = spawnCandidates(grid, arr, game, me, o);
  return {
    queue: candidates.map((c) => c.tile),
    next: 0,
    minDisc: MIN_DISC_FREE,
    sendAt: null,
    mode,
    candidates,
    rollouts: [],
  };
}

/** §3.2.5: the best k candidates, then planSpawn's and the island ones
 *  (each once). */
export function rolloutPool(
  cands: readonly SpawnCandidate[],
  k: number,
): SpawnCandidate[] {
  const pool = cands.slice(0, Math.max(0, k));
  for (const c of cands) {
    if (
      (c.source === "planSpawn" || c.source === "island") &&
      !pool.includes(c)
    ) {
      pool.push(c);
    }
  }
  return pool;
}

/** From plan.next on, the first tile whose disc still holds plan.minDisc
 *  free tiles; moves plan.next to it. Null when none does. */
function pickTile(game: Game, plan: SpawnPlan): TileRef | null {
  for (let i = plan.next; i < plan.queue.length; i++) {
    const t = plan.queue[i];
    if (spawnDiscFree(game, t) >= plan.minDisc) {
      plan.next = i;
      return t;
    }
  }
  plan.next = plan.queue.length;
  return null;
}

/** A fork from the Lookahead when there is one (its budget), else the
 *  context's own; null when forking fails. */
function forkOf(la: Lookahead | null, live: AgentContext): GameFork | null {
  if (la !== null) return la.fork(live, []);
  try {
    return live.fork();
  } catch {
    return null;
  }
}

function xy(game: Game, t: TileRef | undefined): string {
  return t === undefined ? "none" : `${game.x(t)},${game.y(t)}`;
}

function planLine(v: View, plan: SpawnPlan): string {
  const head0 = plan.queue[0];
  const best = plan.candidates?.find((c) => c.tile === head0);
  const head =
    best !== undefined
      ? ` best ${best.source} A ${best.free} B ${best.pie} threat ${best.threat} score ${best.score.toFixed(0)}`
      : "";
  const at = plan.sendAt !== null ? `, send at ${plan.sendAt}` : "";
  return `spawn plan (${plan.mode}): ${plan.queue.length} candidates${head}${at}`;
}
