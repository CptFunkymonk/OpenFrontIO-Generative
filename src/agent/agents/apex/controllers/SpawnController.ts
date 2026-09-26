import { Game, GameType, Player, PlayerType } from "../../../../core/game/Game";
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
  cellOf,
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
import {
  EraseCandidate,
  eraseCandidates,
  placedNations,
  reachScore,
} from "../../../lib/SpawnErase";
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
//
// Preview (o.spawnPreview, package A3; chapter 13 §2.1, §5.1): a spawn sent
// at the agent's first call (ctx.tick === 1) lands in tick 2, before every
// nation, and ends the phase before any nation hops; but the live game at
// tick 1 shows neither the tribes (they land in tick 1) nor the nations
// (tick 2), and a race field planned on it is blind (spawnDelay 1: ≥ top at
// minute 3 in 28% of quick@4 games against 50%). So the plan is made on a
// fork advanced PREVIEW_ADVANCE ticks without us, which is exactly the
// layout the nations land in. With o.spawnErase it weighs spawning on a
// nation's pick, which covers the nation's disc so it is never placed
// (lib/SpawnErase.ts), verified in a second fork; only such a site needs
// tick 1. Without one the preview is dropped and the spawn is planned and
// sent at spawnDelay as without it (unless o.spawnPreviewEarly), so that
// game replays apex's exactly.

/** Ticks after a send before a spawn that did not land is resent (§3.2.4). */
export const RESEND_TICKS = 10;
/** The preview plans at the agent's first call: its spawn goes into turn 1
 *  and lands in tick 2, ahead of the nations' first SpawnExecutions
 *  [PIN SpawnPhaseSingleplayer 9]. */
export const PREVIEW_TICK = 1;
/** Ticks the preview fork is advanced: the tribes land in tick 1 and the
 *  nations in tick 2. */
export const PREVIEW_ADVANCE = 2;
/** Erasure sites verified in a fork before the best race candidate wins. */
export const ERASE_VERIFY_MAX = 2;
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
  /** Planned on the preview fork (o.spawnPreview). */
  preview: boolean;
  /** The verified erasure site at the head of the queue, if one won. */
  erase: EraseCandidate | null;
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
  private layoutGrid: RaceGrid | null = null;

  /** The plan in use (null before the first eligible tick). For tests and
   *  logs. */
  get plan(): Readonly<SpawnPlan> | null {
    return this.current;
  }

  /** The race grid the preview built on its fork (null without one). Its
   *  terrain arrays are the game's; only `free`, which spawnCandidates
   *  alone reads, is the fork's at tick 3. So the policy can adopt it as
   *  its own race grid after the spawn instead of building another. */
  get previewGrid(): RaceGrid | null {
    return this.layoutGrid;
  }

  onTick(v: View, s: ApexState): void {
    const { game, me, tick, o } = v;
    if (me.hasSpawned()) return;
    const preview =
      this.current === null && tick === PREVIEW_TICK && previewAllowed(v);
    if (!preview && tick < spawnTick(game, o)) return;
    const sentAt = s.spawn.sentAt;
    if (sentAt !== null && tick - sentAt < RESEND_TICKS) return;

    let plan = this.current;
    if (plan === null) {
      // Null from the preview: plan as without it, at spawnTick.
      const previewed = preview ? this.previewPlan(v, s) : null;
      if (preview && previewed === null && tick < spawnTick(game, o)) return;
      plan = previewed ?? this.makePlan(v, true);
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
    const erase =
      plan.erase !== null && plan.erase.tile === tile
        ? `, erase ${plan.erase.name}`
        : "";
    this.note(
      v,
      s,
      `spawn (${plan.mode}${plan.preview ? ", preview" : ""}${erase}) at ${xy(game, tile)}, candidate ${plan.next + 1}/${plan.queue.length}`,
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
    if (mode === "plan") return planSpawnPlan(game, me);
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

  /**
   * o.spawnPreview at ctx.tick === PREVIEW_TICK: fork, advance
   * PREVIEW_ADVANCE ticks without us (the tribes and every nation land on
   * the fork as they will in the game, since nothing we do reaches them
   * before tick 2), plan by the mode on that layout, and send at once. Mode
   * idle reads its arrival times from a second such fork stepped on (with
   * o.spawnPreviewEarly only; otherwise the static field, which is what
   * the erasure sites are scored on); mode rollout forks the live game with
   * the spawn in turn 1, as always, once an erasure site is verified. With
   * o.spawnErase the erasure sites are weighed against the best candidate
   * (on the static field only: their scores are race scores). Null, and
   * the spawn planned at spawnTick as without the preview, when no fork can
   * be made or, unless o.spawnPreviewEarly, when no verified erasure site
   * heads the queue.
   */
  private previewPlan(v: View, s: ApexState): SpawnPlan | null {
    const { live, o } = v;
    const f = live === null ? null : previewFork(v.lookahead, live);
    const fme =
      live === null || f === null
        ? null
        : f.game.playerByClientID(live.clientID);
    if (live === null || f === null || fme === null) {
      this.note(v, s, "spawn preview: no fork, planning as without it");
      return null;
    }
    const layout = f.game;
    const mode = effectiveMode(v);
    let plan: SpawnPlan;
    let grid: RaceGrid | null = null;
    if (mode === "plan") {
      plan = planSpawnPlan(layout, fme);
    } else {
      grid = buildRaceGrid(layout, o);
      const race = staticArrival(grid, layout, o);
      // Mode idle's field only when the preview may send its own plan:
      // otherwise only an erasure goes out at tick 1, scored on the static
      // field, and mode idle plans at spawnTick as without the preview.
      let idle: ArrivalField | null = null;
      if (mode === "idle" && o.spawnPreviewEarly) {
        const base = previewFork(v.lookahead, live);
        if (base !== null) idle = this.idleField(v, grid, base);
      }
      plan = candidatePlan(
        grid,
        idle ?? race,
        layout,
        fme,
        o,
        idle !== null ? "idle" : "race",
      );
      if (o.spawnErase && idle === null) {
        this.erase(v, s, live, plan, grid, race, layout, fme);
      }
    }
    if (plan.erase === null && !o.spawnPreviewEarly) {
      // Only an erasure needs turn 1: plan (and roll out) at spawnTick on
      // the live game, as without the preview.
      this.note(v, s, "spawn preview: no erasure, planning as without it");
      return null;
    }
    if (mode === "rollout" && grid !== null) {
      if (plan.erase !== null) {
        // Roll it out with the others: the best candidate by score.
        plan.candidates = [
          eraseAsCandidate(grid, layout, plan.erase),
          ...(plan.candidates ?? []),
        ];
      }
      this.rollouts(v, plan);
    }
    this.layoutGrid = grid;
    plan.preview = true;
    return plan;
  }

  /**
   * o.spawnErase: the erasure sites scoring above (1 + spawnEraseMargin) ×
   * the best candidate's score, verified in a fork best first (at most
   * ERASE_VERIFY_MAX); the first that holds goes to the head of the queue,
   * the candidates follow it. None when an erasure would leave fewer than
   * o.spawnEraseMinLeft nations.
   */
  private erase(
    v: View,
    s: ApexState,
    live: AgentContext,
    plan: SpawnPlan,
    grid: RaceGrid,
    arr: ArrivalField,
    layout: Game,
    fme: Player,
  ): void {
    const placed = placedNations(layout);
    if (placed - 1 < v.o.spawnEraseMinLeft) {
      this.note(
        v,
        s,
        `erase: ${placed} nations placed, an erasure would leave ${placed - 1} (spawnEraseMinLeft ${v.o.spawnEraseMinLeft})`,
      );
      return;
    }
    // The best candidate's score, its A and B capped by the land connected
    // to it, as the erasure sites' are (SpawnErase.landReach).
    const head = plan.candidates?.[0];
    const best = head === undefined ? 0 : reachScore(layout, head, v.o);
    const floor = best * (1 + v.o.spawnEraseMargin);
    if (head !== undefined && best < head.score) {
      this.note(
        v,
        s,
        `erase: the best candidate's reach cuts its score ${head.score.toFixed(0)} to ${best.toFixed(0)}`,
      );
    }
    const cands = eraseCandidates(grid, arr, layout, fme, v.o, floor);
    if (cands.length === 0) {
      this.note(v, s, `erase: no site above ${floor.toFixed(0)}`);
      return;
    }
    let tried = 0;
    for (const e of cands) {
      const line =
        `erase ${e.name} at ${xy(layout, e.tile)}: A ${e.site.A} B ` +
        `${e.site.B} threat ${e.site.threat} score ` +
        `${e.site.score.toFixed(0)} (bound ${e.bound.toFixed(0)}` +
        `${e.site.reach !== undefined ? `, land reach ${e.site.reach}` : ""}` +
        `) against ${floor.toFixed(0)}`;
      if (e.site.score <= floor || tried >= ERASE_VERIFY_MAX) {
        this.note(v, s, line);
        continue;
      }
      tried++;
      const why = verifyErase(v.lookahead, live, e, layout);
      this.note(v, s, `${line}: ${why ?? "verified"}`);
      if (why !== null) continue;
      plan.erase = e;
      plan.queue = [e.tile, ...plan.queue.filter((t) => t !== e.tile)];
      plan.next = 0;
      return;
    }
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
    preview: false,
    erase: null,
  };
}

/** Mode plan: SpawnPlanner.planSpawn's tile on (game, me). */
function planSpawnPlan(game: Game, me: Player): SpawnPlan {
  const t = planSpawn(game, me);
  return {
    queue: t === null ? [] : [t],
    next: 0,
    minDisc: 1,
    sendAt: null,
    mode: "plan",
    candidates: null,
    rollouts: [],
    preview: false,
    erase: null,
  };
}

/** Whether the preview can run (o.spawnPreview, and something it can send:
 *  an erasure, or with o.spawnPreviewEarly any plan): singleplayer, whose
 *  phase ends at our spawn; a live context to fork; not the browser, where
 *  the first call may come after tick 1 and a spawn sent then need not land
 *  in tick 2 (§3.2.6 plans there); not a random-spawn game. */
function previewAllowed(v: View): boolean {
  const { o, game } = v;
  return (
    o.spawnPreview &&
    (o.spawnErase || o.spawnPreviewEarly) &&
    v.live !== null &&
    !isBrowserSpawn(o) &&
    game.config().gameConfig().gameType === GameType.Singleplayer &&
    !game.config().isRandomSpawn()
  );
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

/** A fork advanced PREVIEW_ADVANCE ticks without intents: the layout the
 *  nations land in. Null when forking or stepping fails. */
function previewFork(
  la: Lookahead | null,
  live: AgentContext,
): GameFork | null {
  const f = forkOf(la, live);
  if (f === null) return null;
  try {
    f.advance(PREVIEW_ADVANCE);
  } catch {
    return null;
  }
  return f;
}

/**
 * Plays the erasure in a fresh fork (our spawn in turn 1, as the live send
 * goes, then the nations' landing tick) and checks it on the result: we hold
 * the disc predicted, the erased nations were never placed, and every other
 * nation of the layout holds what it holds there. Null when it holds, else
 * what went wrong.
 */
function verifyErase(
  la: Lookahead | null,
  live: AgentContext,
  e: EraseCandidate,
  layout: Game,
): string | null {
  const f = forkOf(la, live);
  if (f === null) return "no fork";
  try {
    f.step([{ type: "spawn", tile: e.tile }]);
    f.advance(PREVIEW_ADVANCE - 1);
  } catch (err) {
    return `fork failed: ${String(err)}`;
  }
  const g = f.game;
  const me = g.playerByClientID(live.clientID);
  if (me === null || !me.hasSpawned()) return "our spawn did not land";
  if (me.numTilesOwned() !== e.disc) {
    return `we hold ${me.numTilesOwned()} tiles, not ${e.disc}`;
  }
  const erased = new Set([e.nation, ...e.also]);
  for (const id of erased) {
    const p = g.player(id);
    if (p.isAlive() || p.hasSpawned()) return `${p.name()} was placed`;
  }
  for (const n of layout.players()) {
    if (n.type() !== PlayerType.Nation || erased.has(n.id())) continue;
    const p = g.player(n.id());
    if (p.numTilesOwned() !== n.numTilesOwned()) {
      return `${n.name()} holds ${p.numTilesOwned()} tiles, not ${n.numTilesOwned()}`;
    }
  }
  return null;
}

/** An erasure site as a race candidate (mode rollout's pool). */
function eraseAsCandidate(
  grid: RaceGrid,
  game: Game,
  e: EraseCandidate,
): SpawnCandidate {
  return {
    tile: e.tile,
    cell: cellOf(grid, game, e.tile),
    free: e.site.A,
    pie: e.site.B,
    threat: e.site.threat,
    snack: e.site.snack,
    source: "race",
    score: e.site.score,
  };
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
  const e = plan.erase;
  const erase =
    e !== null
      ? `; erase ${e.name} A ${e.site.A} B ${e.site.B} threat ${e.site.threat} score ${e.site.score.toFixed(0)}`
      : "";
  const preview = plan.preview ? ", preview" : "";
  return `spawn plan (${plan.mode}${preview}): ${plan.queue.length} candidates${head}${erase}${at}`;
}
