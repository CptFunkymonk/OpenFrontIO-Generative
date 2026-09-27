/**
 * Package WP2 (docs/14-m4-plan.md §2.5): what a search's rollout records
 * for the break gate, on a stand-in fork (a scripted game the Runner only
 * reads and steps).
 *
 * Claims:
 * - With `alliances`, the Runner records the ends of the alliances we held
 *   at the fork: early (before the expiry it last saw) or not, and whether
 *   we were a traitor then.
 * - An alliance made after the fork is never recorded (the gate's (a)
 *   counts only alliances held at the fork), even when it ends early while
 *   we are a traitor.
 * - An extension moves the expiry an end is judged against: an extended
 *   alliance that later lapses at its new expiry did not end early.
 * - Without `alliances` nothing is recorded.
 */
import type { GameFork } from "../../../src/agent/Fork";
import { BudgetMirror } from "../../../src/agent/lib/Lookahead";
import { Runner } from "../../../src/agent/lib/search/Runner";
import type { Game, Player } from "../../../src/core/game/Game";

interface Ally {
  id: string;
  expiresAt: number;
}

/** A scripted game: at each tick, the alliances we hold and whether we are
 *  a traitor. */
function stage(script: (tick: number) => { allies: Ally[]; traitor: boolean }) {
  let tick = 1000;
  const me = {
    id: () => "ME",
    isAlive: () => true,
    hasSpawned: () => true,
    alliances: () =>
      script(tick).allies.map((a) => ({
        other: () => ({ id: () => a.id }),
        expiresAt: () => a.expiresAt,
      })),
    isTraitor: () => script(tick).traitor,
    incomingAttacks: () => [],
    outgoingAttacks: () => [],
    units: () => [],
    numTilesOwned: () => 100,
    troops: () => 1000,
    gold: () => 0n,
    type: () => "HUMAN",
  } as unknown as Player;
  const game = {
    playerByClientID: () => me,
    players: () => [me],
    ticks: () => tick,
    numLandTiles: () => 10_000,
    numTilesWithFallout: () => 0,
    config: () => ({ maxTroops: () => 5000 }),
  } as unknown as Game;
  const fork = {
    game,
    step: () => {
      tick++;
    },
  } as unknown as GameFork;
  return { fork, at: () => tick };
}

function runner(fork: GameFork, alliances: boolean): Runner {
  return new Runner({
    name: "break:Z:1",
    fork,
    policy: { step: () => [] },
    // No live budget (a null state): the stand-in policy sends nothing.
    budget: BudgetMirror.fromLive({ perSecond: 0, perMinute: 0 }, 0, null),
    gameID: "G",
    clientID: "C",
    phi: 0,
    forkMs: 0,
    grid: [50, 100],
    alliances,
  });
}

describe("search runner: the alliances the gate reads", () => {
  test("ends of the alliances held at the fork; none made after it", () => {
    // At the fork (tick 1000) we hold Z and P. We break Z at 1001 (a
    // traitor from then), make N at 1010; P breaks with us at 1027 and N
    // at 1040, both before their expiries.
    const { fork } = stage((t) => ({
      allies: [
        ...(t < 1001 ? [{ id: "Z", expiresAt: 3000 }] : []),
        ...(t < 1027 ? [{ id: "P", expiresAt: 2500 }] : []),
        ...(t >= 1010 && t < 1040 ? [{ id: "N", expiresAt: 4010 }] : []),
      ],
      traitor: t >= 1001,
    }));
    const r = runner(fork, true);
    r.advance(100);
    expect(r.ended).toEqual([
      { id: "Z", h: 1, early: true, traitor: true },
      { id: "P", h: 27, early: true, traitor: true },
    ]);
  });

  test("an extension moves the expiry: a lapse at the new one is not early", () => {
    // P expires at 1030, is extended to 1060 at 1020, and lapses at 1060.
    const { fork } = stage((t) => ({
      allies:
        t < 1020
          ? [{ id: "P", expiresAt: 1030 }]
          : t < 1060
            ? [{ id: "P", expiresAt: 1060 }]
            : [],
      traitor: false,
    }));
    const r = runner(fork, true);
    r.advance(100);
    expect(r.ended).toEqual([{ id: "P", h: 60, early: false, traitor: false }]);
  });

  test("without `alliances` nothing is recorded", () => {
    const { fork } = stage((t) => ({
      allies: t < 1005 ? [{ id: "Z", expiresAt: 3000 }] : [],
      traitor: t >= 1005,
    }));
    const r = runner(fork, false);
    r.advance(50);
    expect(r.ended).toEqual([]);
    // It still snaps at the grid.
    expect(r.snaps.map((s) => s.h)).toEqual([50]);
  });
});
