import type { Controller, View } from "../policy";
import type { ApexState } from "../state";

/**
 * Spawn phase only (spec §3.2). The policy calls `onTick` on every
 * spawn-phase tick and runs no other controller then (§3.0 step 1), never
 * inside a rollout. It has no enable flag: `o.spawnMode` "plan" is its
 * lowest setting.
 */
export class SpawnController implements Controller {
  readonly name = "spawn";

  onTick(v: View, s: ApexState): void {
    // TODO(spec §3.2): at v.tick >= o.spawnDelay, pick the tile by
    // o.spawnMode: "plan" = SpawnPlanner.planSpawn (§4 step 1); "race" =
    // v.race (built by the policy) + staticArrival + spawnCandidates
    // (§3.2.1-3.2.4, step 4); "idle" = v.lookahead.idleFuture + idleArrival
    // (§3.2.2, step 8); "rollout" = successive halving with v.forRollout()
    // (§3.2.5, step 8); browser: plan on a fork advanced to T* (§3.2.6, when
    // v.live is the browser host). Offer {type: "spawn", tile} with cls
    // "spawn" and Prio.Emergency; record s.spawn.{planned, sentAt, mode};
    // resend the next candidate if !me.hasSpawned() 10 ticks after sending
    // (§3.2.4, §3.2.7).
  }
}
