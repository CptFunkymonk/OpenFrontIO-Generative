/**
 * Pins when an Impossible ally betrays us (package WP10-PIN,
 * docs/13-mechanics.md §2.13; NationAlliance.test.ts and
 * NationTargeting.test.ts pin the three rules at their basic edges; this
 * file pins the exact line, the ranking, the cadence and the MIRV chain).
 * The code is the spec (NationAllianceBehavior.ts, NAB, unless named):
 *
 * - Cadence: the decision runs every attackRate ticks (30-49,
 *   NationExecution.ts:200-228). maybeAttack (AiAttackBehavior.ts:98-157)
 *   ends it early if a free-land send succeeds (:135-141) or, with a
 *   bordering enemy, 1 decision in 10 on a random boat (:147-151); then
 *   attackBestTarget needs troops >= reserveRatio x cap (:290) and >=
 *   triggerRatio x cap or a 1-in-10 chance (:293); then the Impossible list
 *   [retaliate, bots, veryWeak, betray, ...] (:428), the first strategy that
 *   sends ending the decision.
 * - Bordering (:104-133): the owners of land 4-adjacent to its border plus
 *   nearby() (land 5 tiles across water), sorted by troops, ascending;
 *   friends are allies (isFriendly), enemies everyone else, tribes too.
 * - maybeBetrayAndAttack (AiAttackBehavior.ts:583-608): juiciest =
 *   findJuiciestAlly(borderingFriends) once, then for each bordering
 *   friend in that order maybeBetray (:404-461), first match: (a) it is the
 *   juiciest ally and isSafeToBetray; (b) it is a traitor with troops < 1.2x
 *   the nation's; (c) it is the only bordering player and its troops x 3 <
 *   the nation's. The betrayed ally is attacked at once with
 *   sendAttack(friend, true).
 * - isSafeToBetray (:473-491): threats = the target, every bordering
 *   enemy, and (unless the target is a traitor) every other bordering
 *   ally; safe iff the sum of their troops() plus their outgoing attacks'
 *   troops < 0.33 x the nation's troops() (strict).
 * - findJuiciestTarget (NationUtils.ts:52-104): for each candidate, the
 *   level sum of its structures other than defense posts and silos, its
 *   empty share of cap (1 - troops / maxTroops) and its tiles, each
 *   min-max normalised over the candidates, summed; the first highest wins.
 * - betray() is player.breakAlliance (:493-497, GameImpl.ts:878-906): the
 *   nation turns traitor unless we are one; no relation moves and no
 *   neighbour pays -40 (that is BreakAllianceExecution's, used by intents).
 *
 * Setting: tests/agent/mechanics/LeaderWorld.ts; live tests run the real
 * NationExecution with no PlayerExecution (troops set on the eve of each
 * decision stay put).
 */
import { MirvExecution } from "../../../src/core/execution/MIRVExecution";
import { Player, PlayerType, UnitType } from "../../../src/core/game/Game";
import {
  ally,
  brains,
  isDecisionTick,
  LiveNation,
  nationOf,
  pastImmunity,
  relationValue,
  setGold,
  settle,
  siloAt,
  startNation,
  structureAt,
  tick,
  World,
  world,
} from "./LeaderWorld";

/**
 * 120 x 60: the betrayer B at x < 20; us at x 20-79 on rows 0-29; an ally
 * A2 at x 20-79 on rows 30-49; a tribe T at x 20-79 on rows 50-59; a human
 * Q at x 80-119 (not bordering B).
 */
function betrayWorld(gameID = "betrayal"): World {
  return world(
    120,
    60,
    {
      B: PlayerType.Nation,
      US: PlayerType.Human,
      A2: PlayerType.Nation,
      T: PlayerType.Bot,
      Q: PlayerType.Human,
    },
    (x, y) => {
      if (x < 20) return "B";
      if (x >= 80) return "Q";
      if (y < 30) return "US";
      if (y < 50) return "A2";
      return "T";
    },
    { gameID },
  );
}

/** A phantom outgoing attack of `troops` (the Attack object alone). */
function outgoing(w: World, p: Player, troops: number): void {
  p.createAttack(w.game.terraNullius(), troops, null, new Set());
}

describe("WP10 betrayal: the line (isSafeToBetray)", () => {
  it("safe iff the target's troops + its attacks + every bordering non-ally's (tribes too) + every other bordering ally's (not if the target is a traitor), all with their attacks, < 0.33 x the nation's troops, strictly", () => {
    const T = 300_000;
    const x = T * 0.33;
    const edge = Math.ceil(x); // the smallest sum that is not safe
    const safe = (
      set: (w: World) => void,
      friends: string[],
      enemies: string[],
    ) => {
      const w = betrayWorld();
      const { B, US, A2 } = w.p;
      ally(B, US);
      ally(B, A2);
      B.setTroops(T);
      for (const k of ["US", "A2", "T", "Q"]) w.p[k].setTroops(0);
      set(w);
      const a = brains(w, "B", "line").alliance;
      return a.isSafeToBetray(
        US,
        friends.map((k) => w.p[k]),
        enemies.map((k) => w.p[k]),
      );
    };
    // Us alone.
    expect(safe((w) => w.p.US.setTroops(edge - 1), ["US"], [])).toBe(true);
    expect(safe((w) => w.p.US.setTroops(edge), ["US"], [])).toBe(false);
    // Our attacks in flight count with our home troops.
    const split = (home: number) => (w: World) => {
      w.p.US.setTroops(home);
      outgoing(w, w.p.US, 10_000);
    };
    expect(safe(split(edge - 1 - 10_000), ["US"], [])).toBe(true);
    expect(safe(split(edge - 10_000), ["US"], [])).toBe(false);
    // A bordering tribe counts as a threat.
    const tribe = (ours: number) => (w: World) => {
      w.p.US.setTroops(ours);
      w.p.T.setTroops(20_000);
    };
    expect(safe(tribe(edge - 1 - 20_000), ["US"], ["T"])).toBe(true);
    expect(safe(tribe(edge - 20_000), ["US"], ["T"])).toBe(false);
    // Another bordering ally counts, with its attacks ...
    const other = (ours: number) => (w: World) => {
      w.p.US.setTroops(ours);
      w.p.A2.setTroops(15_000);
      outgoing(w, w.p.A2, 5_000);
    };
    expect(safe(other(edge - 1 - 20_000), ["US", "A2"], [])).toBe(true);
    expect(safe(other(edge - 20_000), ["US", "A2"], [])).toBe(false);
    // ... unless we are a traitor.
    const traitor = (w: World) => {
      other(edge - 1)(w);
      w.p.US.markTraitor();
    };
    expect(safe(traitor, ["US", "A2"], [])).toBe(true);
    // A player that does not border it (Q) is not in the lists at all.
    expect(safe((w) => w.p.US.setTroops(edge - 1), ["US"], [])).toBe(true);
  });

  it("the juiciest ally: min-max normalised structure levels (silos and defense posts excluded), empty share of cap and tiles, summed; rule (a) looks at that ally only", () => {
    const w = betrayWorld();
    const { B, US, A2 } = w.p;
    ally(B, US);
    ally(B, A2);
    const a = brains(w, "B", "juicy").alliance;
    const cap = (p: Player) => w.config.maxTroops(p);
    // US: more tiles (1,800 vs 1,200), A2: the emptier cap.
    US.setTroops(0.5 * cap(US));
    A2.setTroops(0.1 * cap(A2));
    // Scores: US 0 + 0 + 1 = 1, A2 0 + 1 + 0 = 1: a tie goes to the first
    // in the list.
    expect(a.findJuiciestAlly([US, A2])).toBe(US);
    expect(a.findJuiciestAlly([A2, US])).toBe(A2);
    // A silo and a defense post of ours do not count; a City does.
    structureAt(w, US, UnitType.MissileSilo, 30, 10, 5);
    structureAt(w, US, UnitType.DefensePost, 50, 10);
    expect(a.findJuiciestAlly([A2, US])).toBe(A2);
    structureAt(w, US, UnitType.City, 70, 10);
    expect(a.findJuiciestAlly([A2, US])).toBe(US);
    // Rule (a) is for the juiciest only: A2 at 1% of B's troops is not
    // betrayed by it while we are juicier (it is neither a traitor nor the
    // only bordering player).
    B.setTroops(1_000_000);
    A2.setTroops(10_000);
    US.setTroops(10_000);
    const friends = [US, A2];
    const juiciest = a.findJuiciestAlly(friends);
    expect(juiciest).toBe(US);
    expect(a.maybeBetray(A2, juiciest, friends, [])).toBe(false);
    expect(B.isAlliedWith(A2)).toBe(true);
    expect(a.maybeBetray(US, juiciest, friends, [])).toBe(true);
    expect(B.isAlliedWith(US)).toBe(false);
  });
});

/** B allied with us, above its trigger (0.9 of its cap) on the eve of a
 *  decision: returns the live nation. */
function liveBetrayer(w: World, gameID: string): LiveNation {
  const { B, US } = w.p;
  ally(B, US);
  const nation = nationOf(w, "B", gameID);
  pastImmunity(w);
  startNation(w, nation);
  expect(nation.n.triggerRatio).toBeLessThan(0.9);
  return nation;
}

/** Runs to the nation's next decision tick, sets `eve` just before it,
 *  runs it; returns that tick. */
function decision(w: World, nation: LiveNation, eve: () => void): number {
  while (!isDecisionTick(nation, w.game.ticks())) tick(w);
  eve();
  const t = w.game.ticks();
  tick(w);
  return t;
}

describe("WP10 betrayal: live decisions", () => {
  /** Only us bordering B: A2 and T given to us. */
  function onlyUs(gameID: string): World {
    const w = betrayWorld(gameID);
    for (let x = 20; x < 80; x++)
      for (let y = 30; y < 60; y++) w.p.US.conquer(w.game.ref(x, y));
    return w;
  }

  it("the betrayal comes in a decision tick, with its attack on us in that tick; it turns traitor; the break moves no relation (its attack sets ours to it to -100, as any attack does) and no third party's", () => {
    const w = onlyUs("betray-live");
    const { B, US, Q } = w.p;
    const nation = liveBetrayer(w, "betray-live");
    const cap = w.config.maxTroops(B);
    const rel = () => [
      relationValue(US, B),
      relationValue(B, US),
      relationValue(Q, B),
      relationValue(Q, US),
    ];
    const before = rel();
    let t = -1;
    for (let i = 0; i < 10 && B.isAlliedWith(US); i++) {
      t = decision(w, nation, () => {
        B.setTroops(Math.ceil(0.9 * cap));
        US.setTroops(Math.floor(0.3 * B.troops()));
      });
    }
    expect(B.isAlliedWith(US)).toBe(false);
    expect(isDecisionTick(nation, t)).toBe(true);
    const attacks = B.outgoingAttacks().filter((a) => a.target() === US);
    expect(attacks).toHaveLength(1);
    // Sized troops - reserveRatio x cap (the send cap allows it), floored.
    expect(attacks[0].troops()).toBe(
      Math.floor(Math.ceil(0.9 * cap) - nation.n.reserveRatio * cap),
    );
    expect(B.isTraitor()).toBe(true);
    expect(rel()).toEqual([-100, before[1], before[2], before[3]]);
  });

  it("below its reserve ratio it never betrays: 20 decisions at 0.99 x its reserve with us at 1% of its troops", () => {
    const w = onlyUs("betray-reserve");
    const { B, US } = w.p;
    const nation = liveBetrayer(w, "betray-reserve");
    const cap = w.config.maxTroops(B);
    for (let i = 0; i < 20; i++) {
      decision(w, nation, () => {
        B.setTroops(Math.floor(0.99 * nation.n.reserveRatio * cap));
        US.setTroops(Math.floor(0.01 * B.troops()));
      });
      expect(B.isAlliedWith(US)).toBe(true);
    }
    expect(B.outgoingAttacks()).toHaveLength(0);
  });

  it("an attack on it is answered first: in the decision it retaliates against a bordering attacker it betrays no one, though we are at 1% of its troops", () => {
    // B x < 20; us x 20-79 on rows 0-49; the human Q x 20-79 on rows
    // 50-59, strong enough not to be 'very weak' (>= 15% of its cap).
    const w = world(
      120,
      60,
      { B: PlayerType.Nation, US: PlayerType.Human, Q: PlayerType.Human },
      (x, y) => (x < 20 ? "B" : x >= 80 ? null : y < 50 ? "US" : "Q"),
      { gameID: "betray-retaliate" },
    );
    const { B, US, Q } = w.p;
    const nation = liveBetrayer(w, "betray-retaliate");
    const cap = w.config.maxTroops(B);
    const q = Math.ceil(0.15 * w.config.maxTroops(Q)) + 1;
    Q.setTroops(q);
    Q.createAttack(B, 500, null, new Set());
    let retaliated = false;
    for (let i = 0; i < 10 && !retaliated; i++) {
      decision(w, nation, () => {
        B.setTroops(Math.ceil(0.9 * cap));
        US.setTroops(Math.floor(0.01 * B.troops()));
        Q.setTroops(q);
      });
      retaliated = B.outgoingAttacks().some((a) => a.target() === Q);
      expect(B.isAlliedWith(US)).toBe(true);
    }
    expect(retaliated).toBe(true);
    // Us + Q + Q's attack < 0.33 x its troops: betrayal was safe, only
    // pre-empted.
    expect(US.troops() + q + 500).toBeLessThan(0.33 * B.troops());
  });

  it("the MIRV chain: an ally that does not betray us at full strength betrays us at its first decision once a MIRV's warheads have cut our troops under 0.33x its own (the MIRV leaves us at about 3% of our cap)", () => {
    // 400 x 300: B x < 60 (18,000 tiles), us x 60-319 (78,000), the human
    // Q x >= 320 with a silo. (A MIRV needs a big target: its warheads are
    // 55 tiles apart, so a 60 x 60 one gets a single warhead.)
    const w = world(
      400,
      300,
      { B: PlayerType.Nation, US: PlayerType.Human, Q: PlayerType.Human },
      (x) => (x < 60 ? "B" : x < 320 ? "US" : "Q"),
      { gameID: "betray-mirv" },
    );
    const { B, US, Q } = w.p;
    const nation = liveBetrayer(w, "betray-mirv");
    const bCap = w.config.maxTroops(B);
    const eve = () => B.setTroops(Math.ceil(0.9 * bCap));
    // At full strength (home troops 1.2x its troops) nothing happens.
    US.setTroops(Math.ceil(1.2 * 0.9 * bCap));
    for (let i = 0; i < 5; i++) decision(w, nation, eve);
    expect(B.isAlliedWith(US)).toBe(true);
    // Q MIRVs us.
    siloAt(w, Q, 360, 150);
    setGold(Q, 25_000_000n);
    w.game.addExecution(new MirvExecution(Q, w.game.ref(190, 150)));
    let firstHit = -1;
    let at = -1;
    for (let i = 0; i < 300 && at < 0; i++) {
      const t = w.game.ticks();
      if (isDecisionTick(nation, t)) eve();
      tick(w);
      if (firstHit < 0 && w.game.numTilesWithFallout() > 0) firstHit = t;
      if (!B.isAlliedWith(US)) at = t;
    }
    // Betrayed at its first decision once the warheads had cut us below
    // 0.33 x its troops, not before the first warhead landed.
    expect(firstHit).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(firstHit);
    expect(isDecisionTick(nation, at)).toBe(true);
    expect(B.outgoingAttacks().some((a) => a.target() === US)).toBe(true);
    settle(w);
    const ours = US.troops() / w.config.maxTroops(US);
    expect(ours).toBeGreaterThan(0.03);
    expect(ours).toBeLessThan(0.04);
  });
});
