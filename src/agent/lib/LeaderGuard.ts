import { findJuiciestTarget } from "../../core/execution/nation/NationUtils";
import {
  Difficulty,
  Game,
  GameMode,
  Player,
  PlayerID,
  PlayerType,
  UnitType,
} from "../../core/game/Game";
import { steamrollLine } from "./GoldPolicy";
import { Models } from "./Models";
import { Gate, NationModel } from "./NationModel";

// Package WP10b, the leader guard (docs/14-m4-plan.md §2.8; docs/13-
// mechanics.md §2.16-2.17, §5.12): the lines where an Impossible nation's
// endgame rules turn on the leader, read from the game. Read-only helpers:
// nothing here mutates the game (Player.nearby() writes its own memo, as
// NationModel's refresh does, spec §2.1).
//
// The betrayal line [PIN Betrayal] (NationAllianceBehavior.ts, NAB): at a
// decision that reaches its strategy list, an ally Z that borders us
// betrays us (breaks the alliance and attacks at once) by the first rule
// that holds (maybeBetray :404-461):
//   (a) Hard, Impossible: we are its juiciest bordering ally and
//       isSafeToBetray (:473-491): our troops + our attacks' troops + the
//       same of every other bordering player of Z (its non-allies, tribes
//       too, and its other allies unless we are a traitor) < 0.33 T_Z;
//   (w) Easy (not a human), Medium: T_Z >= 10 x our home;
//   (b) not Easy: we are a traitor and our home < 1.2 T_Z;
//   (c) not Easy: we are Z's only bordering player and 3 x our home < T_Z.
// So each rule is a line our troops must hold: (a) on home + attacks, the
// others on home alone. The line that matters is the one at Z's next
// decision, with T_Z its troops then (NationModel.troopsAt: its regrowth).
//
// The MIRV lines [PIN NationMirvTargeting] (NationMIRVBehavior.ts, NMB): at
// each decision a nation with a silo (any state) and gold >= the MIRV's
// price (25M + 15M x MIRVs launched, Config.ts:618-630) fires 15 times in
// 16 (:133-168) at the first of: the sender of a MIRV in flight at it
// (:171-179); the largest holder of >= 40% of numLandTiles(), fallout
// counted (:181-225); the City-level leader above 8 levels and >= 1.15x
// the runner-up's (:227-254); each skipped for 300 ticks after a nation's
// MIRV at it (:257-265). Alliances do not protect: allies are targets.
//
// Team games are not modelled (the lines are the FFA ones).

/** isSafeToBetray's share of the betrayer's troops (NAB :490). */
export const BETRAY_SAFE_SHARE = 0.33;
/** Rule (b): a traitor with fewer than this many times the nation's troops
 *  is betrayed (NAB :441-447). */
export const BETRAY_TRAITOR_GUARD = 1.2;
/** Rule (c): the only bordering player is betrayed when this many times its
 *  troops are below the nation's (NAB :450-457). */
export const BETRAY_ONLY_NEIGHBOUR_MULT = 3;
/** Rule (w), Easy and Medium: the nation betrays an ally it outnumbers this
 *  many times (NAB :425-438; Easy never betrays a human). */
export const BETRAY_WEAK_MULT = 10;
/** The 300-tick skip after a nation's MIRV at a target (NMB :31-32). */
export const MIRV_COOLDOWN_TICKS = 300;

/** victoryDenialThresholdPercent (NMB :86-100): whole percent of
 *  numLandTiles(). */
const VICTORY_DENIAL_PERCENT: Record<Difficulty, number> = {
  [Difficulty.Easy]: 75,
  [Difficulty.Medium]: 65,
  [Difficulty.Hard]: 55,
  [Difficulty.Impossible]: 40,
};

// ── The betrayal line ────────────────────────────────────────────────────

/** Which rule a line is for (see the header). */
export type BetrayRule = "safe" | "weak" | "traitor" | "alone";

export interface BetrayalParams {
  /** Multiplies the troop term of every line: 1 is the nation's edge. */
  margin: number;
  /** Share of Z's own attack troops counted in T_Z: an attack that ends
   *  brings its survivors home (AttackExecution.retreat) and T_Z is home
   *  troops only (NAB :490). */
  allyOut: number;
  /** Share of our attack troops credited to rule (a) when it becomes a home
   *  floor: 0, home alone holds the line (an attack's troops die as it
   *  takes land); 1, today's attacks count in full, as the nation counts
   *  them now. */
  ourOut: number;
  /** A home floor above this share of our cap is not holdable: it is left
   *  out of the floor and counted in capShort instead. */
  maxShare: number;
  /** Leave out an ally whose gate at its next decision is "locked"
   *  (NationModel.gates: it sends at free land, or at a tribe holding
   *  structures, and returns before its strategy list). */
  gates: boolean;
}

/** The exact rule: margin 1, nothing added. */
export const EXACT_BETRAYAL: BetrayalParams = Object.freeze({
  margin: 1,
  allyOut: 0,
  ourOut: 1,
  maxShare: Infinity,
  gates: false,
});

/** One bordering ally's line at its next decision. Plain data. */
export interface BetrayalLine {
  id: PlayerID;
  smallID: number;
  /** Z's next decision the line is for. */
  d: number;
  /** nm.gates(Z, d). */
  gate: Gate;
  /** The troops the line is read against: troopsAt(Z, d) + allyOut x the
   *  troops of Z's attacks. */
  T: number;
  /** Rule (a)'s others: the troops and attack troops of Z's bordering
   *  players other than us that isSafeToBetray counts (-1 when rule (a)
   *  is off at this difficulty). */
  others: number;
  /** We are Z's only bordering player (rule c). */
  alone: boolean;
  /** We are, now, Z's juiciest bordering ally (findJuiciestTarget over its
   *  bordering allies); rule (a) needs it. The floor assumes it (our troop
   *  gap, one of its three terms, grows as our home falls). */
  juiciest: boolean;
  /** Rule (a)'s line on our home + attack troops: the least total, an
   *  integer, at which isSafeToBetray is false (0 when off). */
  total: number;
  /** The least home troops that hold every rule that applies, with our
   *  attack troops credited to rule (a) at `ourOut`. */
  home: number;
  /** The rule behind `home` ("safe" is rule a). */
  rule: BetrayRule;
  /** `home` without rule (b), whose line lasts only while we are a traitor
   *  (300 ticks after we break an alliance). */
  base: number;
}

/** What betrayalLines reads. */
export interface BetrayalInputs {
  game: Game;
  me: Player;
  nm: NationModel;
  tick: number;
}

/** The troops of a player's attacks (Player.outgoingAttacks, as NAB :485-
 *  487 and :379-384 sum them). */
export function attackTroops(p: Player): number {
  let s = 0;
  for (const a of p.outgoingAttacks()) s += a.troops();
  return s;
}

/**
 * The least integer n >= 0 with n + others >= share x T, in the float
 * arithmetic of isSafeToBetray (`sum < troops * 0.33` is safe): the total
 * of ours that makes Z's betrayal unsafe.
 */
export function safeTotal(T: number, others: number, share: number): number {
  const need = T * share;
  let n = Math.max(0, Math.ceil(need - others));
  while (n + others < need) n++;
  while (n > 0 && n - 1 + others >= need) n--;
  return n;
}

/** The bordering players of Z as its maybeAttack sees them: the players in
 *  Z.nearby() (land 4-adjacent to its border, and across a strip of water
 *  up to 4 tiles wide, PlayerImpl.ts:626-650; AiAttackBehavior.ts:104-133
 *  adds the same owners again), from NationModel's last full refresh of Z
 *  when there is one. */
function borderingOf(game: Game, nm: NationModel, Z: Player): Player[] {
  const ids = nm.nearbyOf(Z.id());
  const out: Player[] = [];
  if (ids !== undefined) {
    for (const sid of ids) {
      const x = game.playerBySmallID(sid);
      if (x.isPlayer() && x.isAlive()) out.push(x as Player);
    }
    return out;
  }
  for (const x of Z.nearby()) {
    if (x.isPlayer() && x.isAlive()) out.push(x as Player);
  }
  return out;
}

/**
 * The betrayal line of every living nation allied with us that has us
 * among its bordering players, at its next decision after `tick`, in
 * smallID order (deterministic). With p.gates, an ally whose gate there is
 * "locked" is left out. Rules by difficulty as in maybeBetray.
 */
export function betrayalLines(
  x: BetrayalInputs,
  p: BetrayalParams,
): BetrayalLine[] {
  const { game, me, nm, tick } = x;
  if (game.config().disableAlliances()) return [];
  const difficulty = game.config().gameConfig().difficulty;
  const hard =
    difficulty === Difficulty.Hard || difficulty === Difficulty.Impossible;
  const easy = difficulty === Difficulty.Easy;
  const weakRule =
    difficulty === Difficulty.Medium ||
    (easy && me.type() !== PlayerType.Human);
  const traitor = me.isTraitor();
  const ours = attackTroops(me);
  const out: BetrayalLine[] = [];
  const allies = me
    .allies()
    .filter((Z) => Z.type() === PlayerType.Nation && Z.isAlive())
    .sort((a, b) => a.smallID() - b.smallID());
  for (const Z of allies) {
    const near = borderingOf(game, nm, Z);
    if (!near.includes(me)) continue;
    const id = Z.id();
    const d = nm.nextDecision(id, tick + 1);
    const gate = nm.gates(id, d);
    if (p.gates && gate === "locked") continue;
    const T = nm.troopsAt(id, d) + p.allyOut * attackTroops(Z);
    // Z's borderingFriends and borderingEnemies (isFriendly, as
    // AiAttackBehavior.ts:128-133 splits them; sorted by troops, ascending
    // and stable, :125-127).
    const friends: Player[] = [];
    let others = 0;
    let count = 0;
    for (const y of near) {
      if (y === Z) continue;
      count++;
      if (Z.isFriendly(y)) {
        friends.push(y);
        if (y !== me && !traitor && Z.isAlliedWith(y)) {
          others += y.troops() + attackTroops(y);
        }
      } else {
        others += y.troops() + attackTroops(y);
      }
    }
    friends.sort((a, b) => a.troops() - b.troops());
    const juiciest =
      findJuiciestTarget(
        game,
        friends.filter((f) => Z.isAlliedWith(f)),
      ) === me;
    const alone = count === 1;
    const m = p.margin;
    const total = hard ? safeTotal(T * m, others, BETRAY_SAFE_SHARE) : 0;
    let base = 0;
    let rule: BetrayRule = "safe";
    const raise = (h: number, r: BetrayRule) => {
      if (h > base) {
        base = h;
        rule = r;
      }
    };
    if (hard) raise(Math.max(0, total - p.ourOut * ours), "safe");
    // (w): betrayed at T >= 10 x home, so held at home > T/10.
    if (weakRule) raise(Math.floor((T * m) / BETRAY_WEAK_MULT) + 1, "weak");
    // (c): betrayed at 3 x home < T.
    if (!easy && alone) {
      raise(Math.ceil((T * m) / BETRAY_ONLY_NEIGHBOUR_MULT), "alone");
    }
    // (b): betrayed at home < 1.2 T.
    const traitorHome =
      !easy && traitor ? Math.ceil(T * m * BETRAY_TRAITOR_GUARD) : 0;
    out.push({
      id,
      smallID: Z.smallID(),
      d,
      gate,
      T,
      others: hard ? others : -1,
      alone,
      juiciest,
      total,
      home: Math.max(base, traitorHome),
      rule: traitorHome > base ? "traitor" : rule,
      base,
    });
  }
  return out;
}

/** The floor the lines put on our home, and what they ask of our cap. */
export interface BetrayalFloor {
  /** The largest holdable line's home troops (0: none). */
  floor: number;
  /** The ally behind `floor`. */
  by: PlayerID | null;
  /** Cap we lack to hold the largest line above maxShare x cap (rules a,
   *  c and w; a traitor's line lasts only while we are one): line /
   *  maxShare - cap, or 0. */
  capShort: number;
  /** The ally behind capShort. */
  shortBy: PlayerID | null;
}

/** Folds the lines into a home floor: lines above p.maxShare x cap are not
 *  holdable (holding them would freeze every spend and still not stop the
 *  betrayal), so they drop out of the floor and into capShort. */
export function betrayalFloor(
  lines: readonly BetrayalLine[],
  cap: number,
  p: Pick<BetrayalParams, "maxShare">,
): BetrayalFloor {
  const max = p.maxShare * cap;
  let floor = 0;
  let by: PlayerID | null = null;
  let capShort = 0;
  let shortBy: PlayerID | null = null;
  for (const l of lines) {
    // A traitor's line above the cap drops to the lines that outlast it.
    const h = l.home <= max ? l.home : l.base;
    if (h <= max) {
      if (h > floor) {
        floor = h;
        by = l.id;
      }
      continue;
    }
    if (!(p.maxShare > 0)) continue;
    const short = h / p.maxShare - cap;
    if (short > capShort) {
      capShort = short;
      shortBy = l.id;
    }
  }
  return { floor, by, capShort, shortBy };
}

/** The City levels to add so that our cap, cities under construction
 *  counted as finished (they will be), reaches `target` at our tiles: 0 if
 *  it does already, at most `max` (a level adds config.cityTroopIncrease,
 *  250k for a human, through models.capAt). */
export function levelsFor(
  models: Models,
  me: Player,
  target: number,
  max = 10_000,
): number {
  const tiles = me.numTilesOwned();
  const now = me.unitCount(UnitType.City);
  let k = 0;
  while (k < max && models.capAt(me.type(), tiles, now + k) < target) k++;
  return k;
}

// ── The MIRV lines ───────────────────────────────────────────────────────

/** Where we stand against the two MIRV rules that can name a leader. */
export interface MirvLines {
  /** numLandTiles() (fallout included, as NMB :183 reads it). */
  land: number;
  tiles: number;
  /** The least tiles the land rule names: tiles x 100 >= land x pct. */
  landLine: number;
  /** landLine - tiles: tiles we may still take (<= 0: over the line). */
  landRoom: number;
  /** Our City levels (unitCount: cities under construction 1 each, and
   *  captured ones, NMB :311-313). */
  levels: number;
  /** The most City levels of any other living player (tribes and nations:
   *  the runner-up of the city rule). */
  runner: number;
  /** The most City levels we can hold off the city rule
   *  (GoldPolicy.steamrollLine; Infinity with MIRVs disabled). */
  cityLine: number;
  /** cityLine - levels (< 0: the rule names us). */
  cityRoom: number;
}

export function mirvLines(game: Game, me: Player): MirvLines {
  const difficulty = game.config().gameConfig().difficulty;
  const pct = VICTORY_DENIAL_PERCENT[difficulty];
  const land = game.numLandTiles();
  const tiles = me.numTilesOwned();
  // Integers: the least n with n·100 >= land·pct.
  const landLine = Math.floor((land * pct + 99) / 100);
  const levels = me.unitCount(UnitType.City);
  let runner = 0;
  for (const p of game.players()) {
    if (p === me || !p.isPlayer()) continue;
    runner = Math.max(runner, p.unitCount(UnitType.City));
  }
  const cityLine = steamrollLine(game, me);
  return {
    land,
    tiles,
    landLine,
    landRoom: landLine - tiles,
    levels,
    runner,
    cityLine,
    cityRoom: cityLine - levels,
  };
}

/** The rule of a nation's MIRV decision that names us. */
export type MirvRule = "counter" | "land" | "city";

/** What every nation's MIRV decision reads alike, computed once per call
 *  (the rules differ per nation only by leaving the nation out). */
export interface MirvWorld {
  tick: number;
  /** Per nation smallID: the players with a MIRV in flight at its land. */
  inbound: Map<number, Player[]>;
  /** Non-bot players holding tiles x 100 >= numLandTiles() x pct, most
   *  tiles first (stable: players() order on ties). */
  landHolders: Player[];
  /** Every living player by City levels, most first (stable). */
  cities: { p: Player; n: number }[];
  gap: { min: number; gap: number };
  skip: Map<PlayerID, number>;
}

export function mirvWorld(game: Game): MirvWorld {
  const difficulty = game.config().gameConfig().difficulty;
  const players = game.players();
  const inbound = new Map<number, Player[]>();
  for (const m of game.units(UnitType.MIRV)) {
    const dst = m.targetTile();
    // `if (!dst) continue` (NMB :286): tile 0 is skipped too.
    if (!dst || !game.hasOwner(dst)) continue;
    const owner = game.owner(dst);
    if (!owner.isPlayer()) continue;
    const from = m.owner();
    const list = inbound.get(owner.smallID()) ?? [];
    if (!list.includes(from)) list.push(from);
    inbound.set(owner.smallID(), list);
  }
  const land = game.numLandTiles();
  const scaled = land * VICTORY_DENIAL_PERCENT[difficulty];
  const landHolders =
    land === 0
      ? []
      : players
          .filter(
            (p) =>
              p.type() !== PlayerType.Bot &&
              p.numTilesOwned() > 0 &&
              p.numTilesOwned() * 100 >= scaled,
          )
          .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
  const cities = players
    .filter((p) => p.isPlayer())
    .map((p) => ({ p, n: p.unitCount(UnitType.City) }))
    .sort((a, b) => b.n - a.n);
  return {
    tick: game.ticks(),
    inbound,
    landHolders,
    cities,
    gap: STEAMROLL_GAP[difficulty],
    skip: game.nationMirvTargets(),
  };
}

/**
 * Whom nation N's considerMIRV aims at in `w`, past its silo, gold and
 * hesitation gates (NMB :149-168): the first of the counter, land and city
 * rules whose target no nation MIRVed in the last 300 ticks, with that
 * rule; null if none. Valid targets are the living non-bot players but N
 * (:268-279). FFA only: teammates and the land rule's team branch are not
 * modelled.
 */
export function mirvAim(
  w: MirvWorld,
  N: Player,
): { target: Player; rule: MirvRule } | null {
  const skipped = (p: Player) => {
    const t = w.skip.get(p.id());
    return t !== undefined && w.tick - t < MIRV_COOLDOWN_TICKS;
  };
  const valid = (p: Player) =>
    p !== N && p.type() !== PlayerType.Bot && !N.isOnSameTeam(p);
  // Counter: the valid sender with the most tiles (stable, :171-179).
  const senders = (w.inbound.get(N.smallID()) ?? []).filter(
    (p) => p.isAlive() && valid(p),
  );
  senders.sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
  if (senders.length > 0 && !skipped(senders[0])) {
    return { target: senders[0], rule: "counter" };
  }
  // Land: the largest valid holder (first largest on ties, :181-225).
  const holder = w.landHolders.find(valid);
  if (holder !== undefined && !skipped(holder)) {
    return { target: holder, rule: "land" };
  }
  // City: the top of every living player, N and tribes included, above
  // min levels and at gap x the second's (:227-254).
  if (w.cities.length >= 2) {
    const top = w.cities[0];
    if (top.n > w.gap.min && top.n >= w.cities[1].n * w.gap.gap) {
      if (valid(top.p) && !skipped(top.p)) {
        return { target: top.p, rule: "city" };
      }
    }
  }
  return null;
}

/** steamrollMinLeaderCities and steamrollCityGapMultiplier (NMB :102-131),
 *  as GoldPolicy.steamrollLine reads them. */
const STEAMROLL_GAP: Record<Difficulty, { min: number; gap: number }> = {
  [Difficulty.Easy]: { min: 20, gap: 2 },
  [Difficulty.Medium]: { min: 10, gap: 1.5 },
  [Difficulty.Hard]: { min: 10, gap: 1.25 },
  [Difficulty.Impossible]: { min: 8, gap: 1.15 },
};

/** Gold samples of the nations, for their net gold rate (plain data:
 *  numbers, so it survives JSON). */
export interface GoldHistory {
  /** Tick of the last sample. */
  at: number;
  /** Per nation: sample ticks and gold, oldest first. */
  byId: Record<PlayerID, { t: number[]; g: number[] }>;
}

/** "No sample yet": finite, so the history survives JSON. */
const NO_SAMPLE = -1_000_000_000;

export function emptyGoldHistory(): GoldHistory {
  return { at: NO_SAMPLE, byId: {} };
}

/**
 * Samples every living nation's gold at `tick` if the last sample is at
 * least `every` ticks old, keeping those within `window` ticks (and the
 * newest older one, the rate's base); nations gone are dropped. Ids in
 * sorted order, so the result is deterministic.
 */
export function noteGold(
  h: GoldHistory,
  game: Game,
  tick: number,
  every: number,
  window: number,
): void {
  if (tick - h.at < every) return;
  h.at = tick;
  const alive = new Set<PlayerID>();
  for (const N of game.players()) {
    if (N.type() !== PlayerType.Nation) continue;
    const id = N.id();
    alive.add(id);
    const s = (h.byId[id] ??= { t: [], g: [] });
    s.t.push(tick);
    s.g.push(Number(N.gold()));
    while (s.t.length > 2 && s.t[1] <= tick - window) {
      s.t.shift();
      s.g.shift();
    }
  }
  for (const id of Object.keys(h.byId).sort()) {
    if (!alive.has(id)) delete h.byId[id];
  }
}

/** Net gold per tick of nation `id` since its oldest kept sample (spending
 *  and conquest included: the rate at which its purse grows), 0 if it has
 *  none or its gold fell. */
export function goldRate(
  h: GoldHistory,
  id: PlayerID,
  tick: number,
  goldNow: number,
): number {
  const s = h.byId[id];
  if (s === undefined || s.t.length === 0) return 0;
  const dt = tick - s.t[0];
  if (dt <= 0) return 0;
  return Math.max(0, (goldNow - s.g[0]) / dt);
}

/** One silo owner against the MIRV's price. Plain data. */
export interface MirvThreat {
  id: PlayerID;
  smallID: number;
  gold: number;
  price: number;
  /** Silos in any state (considerMIRV's gate, NMB :138-140). */
  silos: number;
  /** Free launch slots of its finished silos now (the launch needs one:
   *  canBuild, NMB :303). */
  slots: number;
  /** Net gold per tick (goldRate). */
  rate: number;
  /** Ticks until its gold reaches the price at `rate`: 0 if it has it,
   *  Infinity if it gains nothing. */
  eta: number;
  /** Its first decision at or after tick + eta (Infinity with eta). */
  at: number;
  /** The rule that aims its MIRV at us now, or null (another target, or
   *  none). */
  rule: MirvRule | null;
}

/** mirvDanger's answer: the lines, every silo owner, and the first that
 *  would MIRV us. Plain data. */
export interface MirvDanger {
  lines: MirvLines;
  /** Every living nation with a silo, in smallID order. */
  threats: MirvThreat[];
  /** The threat whose rule names us with the earliest `at` (ties: more
   *  gold, then smallID), or null: who, and when. */
  first: MirvThreat | null;
}

/**
 * Who could MIRV us, and when: each living nation with a silo (any state),
 * its gold against its price, the ticks its net gold rate needs to reach
 * it, its first decision after that, and whether its MIRV rules aim at us
 * now. `first` is the earliest of those they aim at us. With MIRVs
 * disabled, no threats. The price is the real one (unitInfo(MIRV).cost).
 */
export function mirvDanger(
  game: Game,
  me: Player,
  nm: NationModel,
  gold: GoldHistory,
  tick: number,
): MirvDanger {
  const lines = mirvLines(game, me);
  const threats: MirvThreat[] = [];
  if (!game.config().isUnitDisabled(UnitType.MIRV)) {
    const info = game.unitInfo(UnitType.MIRV);
    const world = mirvWorld(game);
    const nations = game
      .players()
      .filter((N) => N !== me && N.type() === PlayerType.Nation)
      .sort((a, b) => a.smallID() - b.smallID());
    for (const N of nations) {
      const silos = N.units(UnitType.MissileSilo);
      if (silos.length === 0) continue;
      let slots = 0;
      for (const s of silos) {
        if (s.isUnderConstruction()) continue;
        slots += Math.max(0, s.level() - s.missileTimerQueue().length);
      }
      const g = Number(N.gold());
      const price = Number(info.cost(game, N));
      const rate = goldRate(gold, N.id(), tick, g);
      const eta =
        g >= price ? 0 : rate > 0 ? Math.ceil((price - g) / rate) : Infinity;
      const at = Number.isFinite(eta)
        ? nm.nextDecision(N.id(), tick + Math.max(1, eta))
        : Infinity;
      const aim = mirvAim(world, N);
      threats.push({
        id: N.id(),
        smallID: N.smallID(),
        gold: g,
        price,
        silos: silos.length,
        slots,
        rate,
        eta,
        at,
        rule: aim !== null && aim.target === me ? aim.rule : null,
      });
    }
  }
  let first: MirvThreat | null = null;
  for (const t of threats) {
    if (t.rule === null) continue;
    if (
      first === null ||
      t.at < first.at ||
      (t.at === first.at && t.gold > first.gold)
    ) {
      first = t;
    }
  }
  return { lines, threats, first };
}

/** Whether the game is one these lines model (FFA). */
export function leaderGuardModels(game: Game): boolean {
  return game.config().gameConfig().gameMode === GameMode.FFA;
}
