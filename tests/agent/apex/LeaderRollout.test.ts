/**
 * Package WP10n round 2 (review F10): a REAL-rollout test — no FakeRoll, no
 * synthetic snaps — that the MIRV countermeasure the search would play
 * actually beats the do-nothing base when a rich allied nation MIRVs the
 * leader. Two identical LeaderWorlds (deterministic: same map, seeds and
 * setup) with a live NationExecution for the ally N:
 *
 * - BASE: we do nothing. N, an ally holding 25M and a silo, MIRVs us at a
 *   decision tick once we hold >= 40% of the land (NationMIRVBehavior; pinned
 *   by NationMirvTargeting.test.ts). Our troops collapse.
 * - NUKE: we play the mirv:N candidate's first step — a MIRV at N — before N
 *   can launch. Our MIRV spawning raises the game-wide MIRV price to 40M
 *   (OwnNukes), so N's saved 25M is short and it never MIRVs us; N is crippled
 *   instead, and our follow-up attack (the F1 conquest steps) takes its land.
 *
 * Judged by the search's own value with the win-bar share on (searchShare):
 * the NUKE rollout beats the base by more than the acting margin. This is the
 * live case the synthetic SearchNukes rounds test could not show (there share
 * is off); it also demonstrates F1 (the candidate's own conquest) and the
 * price-denial that keeps N from MIRVing us.
 */
import {
  actMargin,
  landOf,
  snapOf,
  value,
  ValueParams,
} from "../../../src/agent/lib/search/Value";
import { Player, PlayerType, UnitType } from "../../../src/core/game/Game";
import {
  ally,
  isDecisionTick,
  LiveNation,
  nationOf,
  pastImmunity,
  price,
  send,
  setGold,
  siloAt,
  startNation,
  tick,
  world,
  World,
} from "../mechanics/LeaderWorld";

const VP: ValueParams = {
  cbar: 150,
  beta: 0.5,
  alpha: 0.5,
  dangerNow: 0,
  dangerCap: 0,
  share: true, // the win-bar share (searchShare), on as in the live search
};

const HORIZON = 700; // past the MIRV's flight (~50-70 ticks) and its aftermath

/** 300 x 200 (60,000 land): us at x < 130 (26,000 tiles = 43.3%, a MIRV
 *  magnet); the ally N at x >= 230 with a silo; an inert nation Z; a tribe T;
 *  free land between. Identical to NationMirvTargeting's targetWorld(130). */
function magnetWorld(gameID: string): World {
  const w = world(
    300,
    200,
    {
      US: PlayerType.Human,
      N: PlayerType.Nation,
      Z: PlayerType.Nation,
      T: PlayerType.Bot,
    },
    (x) => {
      if (x < 130) return "US";
      if (x >= 230) return "N";
      if (x >= 140 && x < 180) return "Z";
      if (x >= 190 && x < 200) return "T";
      return null;
    },
    { gameID },
  );
  siloAt(w, w.p.N, 260, 100);
  return w;
}

/** Steps the world to HORIZON, feeding N `feed` gold on each decision tick
 *  when `when(t)` allows (its saved war chest), and running `each(t)` first.
 *  Returns the value of US (share on) at the horizon. */
function play(
  w: World,
  nation: LiveNation,
  N: Player,
  feed: bigint,
  when: (t: number) => boolean,
  each: (t: number) => void = () => {},
): { v: number; usTiles: number; nTiles: number; mirvsAtUs: boolean } {
  const land0 = landOf(w.game);
  const US = w.p.US;
  let mirvsAtUs = false;
  for (let i = 0; i < HORIZON; i++) {
    const t = w.game.ticks();
    each(t);
    if (isDecisionTick(nation, t) && when(t)) setGold(N, feed);
    tick(w);
    // A MIRV of N aimed at us that spawned (N turned traitor on us).
    if (!mirvsAtUs && N.isTraitor() && !US.isAlliedWith(N)) {
      if (N.units(UnitType.MIRV).length > 0) mirvsAtUs = true;
    }
  }
  const landH = landOf(w.game);
  const v = value(snapOf(w.game, US, HORIZON, 0, 0), VP, land0, landH);
  return {
    v,
    usTiles: US.numTilesOwned(),
    nTiles: N.numTilesOwned(),
    mirvsAtUs,
  };
}

describe("WP10n leader rollout: our MIRV beats the base when an ally MIRVs us", () => {
  it("BASE: the ally MIRVs us and we collapse; NUKE: we MIRV first, deny its MIRV, and win the value by more than the margin", () => {
    // ── BASE: do nothing; N MIRVs us. ──
    const wb = magnetWorld("leader-rollout-base");
    const { US: usb, N: nb } = wb.p;
    ally(usb, nb);
    expect(usb.numTilesOwned() * 100).toBeGreaterThanOrEqual(
      wb.game.numLandTiles() * 40,
    );
    const nationB = nationOf(wb, "N", "leader-rollout-base");
    pastImmunity(wb);
    startNation(wb, nationB);
    const cost = price(wb, UnitType.MIRV, nb);
    expect(cost).toBe(25_000_000n);
    const usTiles0 = usb.numTilesOwned();
    const base = play(wb, nationB, nb, 25_000_000n, () => true);
    // N MIRVed us: it turned traitor, and the warheads took our land (and
    // turned it to fallout, which the share factor then punishes).
    expect(base.mirvsAtUs).toBe(true);
    expect(base.usTiles).toBeLessThan(usTiles0);

    // ── NUKE: we MIRV N first (the candidate's step). ──
    const wn = magnetWorld("leader-rollout-nuke");
    const { US: usn, N: nn } = wn.p;
    ally(usn, nn);
    const nationN = nationOf(wn, "N", "leader-rollout-nuke");
    pastImmunity(wn);
    startNation(wn, nationN);
    // Our silo and the gold for a MIRV.
    siloAt(wn, usn, 60, 100);
    setGold(usn, 100_000_000n);
    // Aim our MIRV at N's centre and launch now.
    const aim = wn.game.ref(265, 100);
    send(wn, "US", { type: "build_unit", unit: UnitType.MIRV, tile: aim });
    let struck = false;
    const nuke = play(
      wn,
      nationN,
      nn,
      25_000_000n,
      // Feed N its war chest only AFTER our MIRV has spawned, so the price is
      // already 40M and its 25M is short (the price-denial), never letting a
      // pre-spawn decision MIRV us in this arm.
      () => wn.game.mirvsLaunched() >= 1,
      (t) => {
        // The follow-up conquest: once our warheads have landed (our MIRV
        // and warheads gone), attack N with everything (the F1 step).
        if (
          !struck &&
          wn.game.mirvsLaunched() >= 1 &&
          usn.units(UnitType.MIRV).length === 0 &&
          usn.units(UnitType.MIRVWarhead).length === 0 &&
          t > 3
        ) {
          struck = true;
          send(wn, "US", {
            type: "attack",
            targetID: nn.id(),
            troops: Number(usn.troops()),
          });
        }
      },
    );
    // We MIRVed N (the price rose), and N never MIRVed us.
    expect(wn.game.mirvsLaunched()).toBeGreaterThanOrEqual(1);
    expect(nuke.mirvsAtUs).toBe(false);
    // N is crippled: far fewer tiles than us.
    expect(nuke.nTiles).toBeLessThan(nuke.usTiles);
    // The search's judge (share on) prefers NUKE by more than the margin.
    const margin = actMargin(usn.numTilesOwned(), 0.01, 300);
    expect(nuke.v - base.v).toBeGreaterThan(margin);
  }, 120_000);
});
