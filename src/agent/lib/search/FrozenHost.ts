import type { RolloutCopy, SearchHost } from "../../agents/apex/policy";
import type { DirectiveStep, SearchMemory } from "../../agents/apex/state";
import type { SpendKind } from "../Scheduler";

// Package SLICE (review D2, D3): what a sliced search takes from the live
// policy at its trigger tick t0, so that the work it does at later live
// ticks reads t0 and nothing later. The candidate generators read
// `sv.host` (available(), nationModel(), state, models, ...): frozen here
// at t0. The rollouts' policy copies are made at t0 too (a pool of blank
// copies, given their plan's steps when a rollout opens: the same edit
// forRolloutWith(spec) makes, ApexPolicy.applySteps), so a plan the base's
// attackers or round 2b add later still starts from the t0 policy.

const SPEND_KINDS: readonly SpendKind[] = [
  "snack",
  "defense",
  "tn",
  "tribe",
  "boat",
  "strike",
];

/**
 * A SearchHost that answers every read with the live host's answer at the
 * call (tick `t`): the state cloned, the purse's availability per kind,
 * the tick's private NationModel and Ledger copies, the last decision's
 * scan, floors and grids (replaced, never edited, by the live policy). The
 * writes (adopt, setDirective) and forRolloutWith still go to the live
 * host: a generator never calls them.
 */
export function freezeHost(host: SearchHost, t: number): SearchHost {
  const state = structuredClone(host.state);
  const wm = host.wm();
  const floors = host.floors();
  const available = new Map<SpendKind, number>();
  for (const k of SPEND_KINDS) available.set(k, host.available(k));
  const inStall = host.inStall(t);
  const models = host.models();
  const race = host.race();
  const owners = host.owners();
  const nm = host.nationModel();
  const ledger = host.ledger();
  return {
    o: host.o,
    state,
    wm: () => wm,
    floors: () => floors,
    available: (kind) => available.get(kind) ?? 0,
    inStall: () => inStall,
    models: () => models,
    race: () => race,
    owners: () => owners,
    nationModel: () => nm,
    ledger: () => ledger,
    forRolloutWith: (spec) => host.forRolloutWith(spec),
    adopt: (spec) => host.adopt(spec),
    setDirective: (steps, replace) => host.setDirective(steps, replace),
  };
}

/**
 * `copy` (a blank rollout copy, host.forRolloutWith() with no plan, not
 * yet stepped) given the plan `steps` in place of its pending directive:
 * the edit forRolloutWith({steps, replace: true}) makes at the copy's
 * making, so a copy taken at t0 plays a plan opened later as one made for
 * it at t0 would.
 */
export function withSteps(
  copy: RolloutCopy,
  steps: readonly DirectiveStep[],
): RolloutCopy {
  const mem = copy.state().search as SearchMemory;
  mem.directive = [];
  for (const d of steps) mem.directive.push(structuredClone(d));
  return copy;
}
