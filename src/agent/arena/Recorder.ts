import {
  Attack,
  Game,
  Player,
  PlayerType,
  Unit,
  UnitType,
} from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import {
  GameUpdateType,
  GameUpdateViewData,
  UnitUpdate,
} from "../../core/game/GameUpdates";
import { StampedIntent } from "../../core/Schemas";
import {
  ATTACK_INDEX_CANCEL,
  ATTACK_INDEX_SENT,
} from "../../core/StatsSchemas";
import { landShare } from "../lib/Perception";

// What the arena records about each seat beyond its timeline: standings at
// fixed minutes, the attacks it launched and received, the nukes aimed at it
// and who finished it off. Everything is read from the authoritative game and
// its per-tick updates; nothing here mutates the game.

/** Game minutes at which every seat's standing is sampled. */
export const STANDING_MINUTES = [1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 40, 50, 60];

/** Attack records kept per seat; later ones are only counted. */
export const MAX_ATTACK_RECORDS = 2000;

/** Ticks before an elimination that decide who eliminated the seat. */
const ELIMINATION_WINDOW = 600;

/** The owner's smallID in a packed tile state (GameMapImpl.PLAYER_ID_MASK). */
const OWNER_MASK = 0xfff;

/** What a retreat from a player, and a boat's return to our own shore,
 *  cost: AttackExecution's and TransportShipExecution's malusForRetreat. */
const RETREAT_MALUS = 0.25;

export interface StandingPoint {
  minute: number;
  tick: number;
  /** This seat's land share, as TimelinePoint.share. */
  share: number;
  /** 1 + nations and humans (alive or dead) with more land than us. */
  rank: number;
  /** Nations and humans in the game. */
  players: number;
  nationsAlive: number;
  /** Median land share over all nations, eliminated ones counting 0. */
  medianNationShare: number;
  /** The nation with the most land. */
  topNation: { name: string; share: number } | null;
}

export interface ByAttacker {
  nation: number;
  bot: number;
  human: number;
}

export interface Received {
  /** Land and boat attacks launched at this seat, each counted once. */
  attacks: ByAttacker;
  /** Their troops when first seen. A launch that absorbs its attacker's
   *  earlier attacks on us counts only the troops it added. */
  attackTroops: ByAttacker;
  /** Aimed at a tile this seat owned when the missile was first seen. */
  nukes: { atom: number; hydrogen: number; mirv: number; mirvWarhead: number };
  firstNukeTick: number | null;
  /** Who took the most of our tiles in the 600 ticks before we were out. */
  eliminatedBy: { name: string; type: string } | null;
}

export interface AttackRecord {
  /** The first attack's id; `boat:<unit id>` for an attack by sea,
   *  `launch:<tick>:<target smallID>` for one cancelled at launch. */
  id: string;
  startTick: number;
  /** Null while still running at the end of the game. */
  endTick: number | null;
  /** type is a PlayerType or "TerraNullius". */
  target: { name: string; type: string };
  boat: boolean;
  /** Troops committed at launch, plus what each later launch on the same
   *  target added when it absorbed this one. Where the game's stats cannot
   *  tell (a seat without a client id), as first seen, after any cancel. */
  troopsSent: number;
  /** Of troopsSent, those the target's attack on us took when ours was
   *  launched, or its boat landed (AttackExecution.init): 0 unless it met
   *  one. */
  troopsCancelledAtLaunch: number;
  /** Of troopsSent, those that did not come back: spent conquering, taken
   *  by the target, or lost to the malus of a retreat from a player or of a
   *  boat's return to our shore (a quarter). Null while running. */
  troopsLost: number | null;
  /**
   * Tiles that moved from the target to us while the attack was active,
   * whatever took them: besides the attack's own conquests, pockets of the
   * target that were enclosed and handed to us (PlayerExecution
   * removeCluster), and a dying target's tiles swept to us by any attack
   * (AttackExecution handleDeadDefender). Tiles from players we were not
   * attacking go to no record (SeatRecords.tilesUncredited).
   */
  tilesGained: number;
  /**
   * How it ended:
   * - "retreated": we ordered it back (a boat also turns back when its
   *   landing tile is nuked into water); the troops came home, less the
   *   malus from a player.
   * - "countered": the target launched an attack at us in the tick ours
   *   ended, and the two cancelled out; the troops were lost.
   * - "cancelled_at_launch": our launch, or our boat's landing, met a
   *   larger attack of the target's on us and vanished in the tick it
   *   began; the troops were lost.
   * - "target_dead": the target was eliminated; what was left came home.
   * - "burned_out": its troops ran out.
   * - "frontier_emptied": nothing of the target's was left in reach, or
   *   the target became our ally; the troops came home.
   * - "sunk": a boat destroyed at sea.
   * - "returned": a boat that came back without landing an attack: it
   *   reached our own shore (losing the malus), or landed on an ally.
   */
  end:
    | "running"
    | "retreated"
    | "countered"
    | "cancelled_at_launch"
    | "target_dead"
    | "burned_out"
    | "frontier_emptied"
    | "sunk"
    | "returned";
}

export interface SeatRecords {
  standings: StandingPoint[];
  received: Received;
  attacks: AttackRecord[];
  attacksDropped: number;
  /** Tiles gained before the seat's first attack or boat: its spawn. */
  spawnTiles: number;
  /** Tiles gained later that no record got: pockets of, and dying players'
   *  tiles swept from, players we were not attacking (see tilesGained). */
  tilesUncredited: number;
}

// ── Standings ──────────────────────────────────────────────────────────

export interface Contender {
  name: string;
  nation: boolean;
  share: number;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A seat's standing among `field`: every nation and human in the game, alive
 * or dead (dead ones with share 0), the seat itself included.
 */
export function standingPoint(
  minute: number,
  tick: number,
  share: number,
  field: readonly Contender[],
): StandingPoint {
  let above = 0;
  let nationsAlive = 0;
  let top: Contender | null = null;
  const nationShares: number[] = [];
  for (const c of field) {
    if (c.share > share) above++;
    if (!c.nation) continue;
    nationShares.push(c.share);
    if (c.share > 0) nationsAlive++;
    if (top === null || c.share > top.share) top = c;
  }
  return {
    minute,
    tick,
    share: round4(share),
    rank: 1 + above,
    players: field.length,
    nationsAlive,
    medianNationShare: round4(median(nationShares)),
    topNation:
      top === null ? null : { name: top.name, share: round4(top.share) },
  };
}

// ── Attacks launched ───────────────────────────────────────────────────

/** One of our attacks as seen after a tick. */
export interface AttackSighting {
  id: string;
  /** Target smallID; 0 is TerraNullius. */
  target: number;
  /** Where a boat landed; null for a land attack. */
  sourceTile: TileRef | null;
  troops: number;
  /** A retreat was ordered (it executes 20 ticks later). */
  retreating: boolean;
  /** The live attack, read once it is gone for the troops it held then
   *  (deleting an attack keeps them); without it, the troops last seen. */
  ref?: Pick<Attack, "troops">;
}

/** One of our transport ships as seen after a tick. */
export interface BoatSighting {
  unit: number;
  /** Owner (smallID) of its destination; read when first seen. */
  target: number;
  /** The landing tile, or the way home once retreating. */
  dst: TileRef;
  troops: number;
  retreating: boolean;
  /** The live unit, read once it is gone: was it sunk? */
  ref?: Pick<Unit, "wasDestroyedByEnemy">;
}

export interface AttackTick {
  tick: number;
  attacks: readonly AttackSighting[];
  boats: readonly BoatSighting[];
  /** Players (smallIDs) whose new attack on us appeared this tick. */
  counters: ReadonlySet<number>;
  /** Tiles we took this tick, as flat [tile, previous owner smallID] pairs. */
  gains: readonly number[];
  /** Targets (player smallIDs) of the land attacks the seat launched this
   *  tick (its executed attack intents). */
  launched?: readonly number[];
  /** Troops that the seat's attacks begun this tick started with, from the
   *  game's stats (sent + cancelled); null or missing if unknown. */
  committed?: number | null;
  /** Troops each player's attacks on us held before this tick, or started
   *  with in it: what a launch of ours at that player could meet. */
  opposing?: ReadonlyMap<number, number>;
}

export interface PlayerLookup {
  describe(smallID: number): { name: string; type: string };
  /** False once a player is eliminated; TerraNullius is always alive. */
  alive(smallID: number): boolean;
}

interface Entry {
  record: AttackRecord;
  /** False past MAX_ATTACK_RECORDS: followed but not reported. */
  kept: boolean;
}

interface Gone {
  group: Entry[];
  last: AttackSighting;
  absorbed: boolean;
}

/**
 * Turns per-tick sightings of one seat's attacks and boats into records.
 *
 * A new land attack absorbs our earlier attacks on the same target (see
 * AttackExecution.init), so its record continues theirs: that of the land
 * attack if there was one, else the boat's. A boat's record carries on into
 * the attack it lands. Every record whose troops ride in an attack ends when
 * that attack ends; only the first (the continued one) gains troops and
 * tiles, and the troops lost are shared out in proportion to troopsSent.
 * Tiles taken from a target go to the land attack on it if there is one,
 * else to a boat's; the landing tile goes to the boat that landed.
 *
 * A launch that meets the target's attack on us cancels against it before
 * it is ever seen: whole (no attack appears) or in part (it appears with
 * fewer troops). The game's stats count every attack begun at its full
 * size, so what they count this tick beyond the fresh attacks' troops was
 * taken at launch: it goes first to our boats whose landing left no attack,
 * then to this tick's land launches (known from the intents) that appeared
 * with fewer troops or whose target is attacking us.
 */
export class AttackLog {
  readonly records: AttackRecord[] = [];
  dropped = 0;
  spawnTiles = 0;
  tilesUncredited = 0;

  /** Records riding in each of our attacks, by attack id; the first gains. */
  private readonly byAttack = new Map<string, Entry[]>();
  private readonly atSea = new Map<number, Entry>();
  private lastAttacks = new Map<string, AttackSighting>();
  private lastBoats = new Map<number, BoatSighting>();

  constructor(private readonly players: PlayerLookup) {}

  observe(t: AttackTick): void {
    const attacks = new Map(t.attacks.map((a) => [a.id, a]));
    const boats = new Map(t.boats.map((b) => [b.unit, b]));
    const fresh = t.attacks.filter((a) => !this.byAttack.has(a.id));
    // Troops the attacks begun this tick are seen to start with, and how
    // many began: the stats' count beyond this was taken at launch.
    let started = 0;
    let launches = 0;

    // Boats that are gone either landed (their attack starts this tick at
    // the landing tile), came home, or sank.
    const landings = new Map<TileRef, Entry>();
    const unlanded: { entry: Entry; last: BoatSighting }[] = [];
    for (const [unit, entry] of this.atSea) {
      if (boats.has(unit)) continue;
      this.atSea.delete(unit);
      const last = this.lastBoats.get(unit)!;
      if (last.ref?.wasDestroyedByEnemy() === true) {
        this.close([entry], "sunk", t.tick, 0);
        continue;
      }
      if (last.retreating) {
        const home = last.troops * (1 - RETREAT_MALUS);
        this.close([entry], "retreated", t.tick, home);
        continue;
      }
      landings.set(last.dst, entry);
      const i = fresh.findIndex((a) => a.sourceTile === last.dst);
      if (i < 0) {
        unlanded.push({ entry, last });
        continue;
      }
      // The landing's attack begins with the boat's troops (boat attacks
      // absorb nothing): any fewer were taken by the target's attack on us.
      this.byAttack.set(fresh[i].id, [entry]);
      const taken = Math.round(last.troops - fresh[i].troops);
      if (taken >= 1) entry.record.troopsCancelledAtLaunch += taken;
      started += last.troops;
      launches++;
      fresh.splice(i, 1);
    }

    const gone: Gone[] = [];
    for (const [id, group] of this.byAttack) {
      if (attacks.has(id)) continue;
      this.byAttack.delete(id);
      gone.push({ group, last: this.lastAttacks.get(id)!, absorbed: false });
    }

    // A fresh land attack absorbs our gone attacks on the same target: a
    // launch takes over the one running (AttackExecution.init). Unless those
    // ended by themselves earlier in the tick: the stats tell, as an
    // absorbed attack's troops are in the fresh one but were not committed.
    const merges = fresh.map((a) => {
      const absorbs: Gone[] = [];
      if (a.sourceTile === null) {
        for (const g of gone) {
          if (g.absorbed || g.last.target !== a.target) continue;
          g.absorbed = true;
          absorbs.push(g);
        }
      }
      // What each held when absorbed, as it had fought on this tick.
      const held = absorbs.reduce(
        (sum, g) => sum + (g.last.ref?.troops() ?? g.last.troops),
        0,
      );
      started += Math.max(0, a.troops - held);
      launches++;
      return { a, absorbs, held };
    });

    // What cancels at launch took (see the class comment); a troop per
    // launch of slack for the stats' flooring.
    const known = t.committed !== undefined && t.committed !== null;
    let taken = known ? t.committed! - started : 0;
    const slack = 1 + launches;
    for (const m of merges) {
      if (!known || m.absorbs.length === 0) continue;
      if (Math.abs(taken - m.held) > slack) continue;
      // Its launch committed all it holds: it began after they ended.
      for (const g of m.absorbs) g.absorbed = false;
      m.absorbs = [];
      taken -= m.held;
      started += m.held;
    }

    // Fresh land attacks by target, for a launch cancelled in part.
    const freshLand = new Map<number, Entry[]>();
    for (const { a, absorbs, held } of merges) {
      const group =
        absorbs.length === 0
          ? [this.open(a.id, t.tick, a.target, a.sourceTile !== null)]
          : continuedFirst(absorbs.flatMap((g) => g.group));
      group[0].record.troopsSent += Math.round(
        Math.max(0, a.troops - (absorbs.length === 0 ? 0 : held)),
      );
      if (a.sourceTile === null) freshLand.set(a.target, group);
      this.byAttack.set(a.id, group);
    }

    const opposing = t.opposing ?? new Map<number, number>();
    for (const { entry, last } of unlanded) {
      // A boat that landed (took its tile) without an attack either landed
      // on an ally, its troops going home, or its attack was cancelled at
      // once; one that did not land reached our own shore.
      let landed = false;
      for (let i = 0; i < t.gains.length && !landed; i += 2) {
        landed = t.gains[i] === last.dst;
      }
      if (landed && opposing.has(last.target) && taken > last.troops - slack) {
        taken -= last.troops;
        entry.record.troopsCancelledAtLaunch = entry.record.troopsSent;
        this.close([entry], "cancelled_at_launch", t.tick, 0);
      } else {
        const home = last.troops * (landed ? 1 : 1 - RETREAT_MALUS);
        this.close([entry], "returned", t.tick, home);
      }
    }
    for (const target of new Set(t.launched ?? [])) {
      if (taken <= slack) break;
      // A launch cancelled whole leaves the target's attack on us in view.
      // One cancelled in part may have met an attack the target launched
      // later in the tick, which the cancel deleted before it could be seen.
      const held = opposing.get(target);
      const group = freshLand.get(target);
      if (group === undefined && held === undefined) continue;
      const lost = Math.round(Math.min(taken, held ?? taken));
      taken -= lost;
      if (group !== undefined) {
        group[0].record.troopsSent += lost;
        group[0].record.troopsCancelledAtLaunch += lost;
        continue;
      }
      const entry = this.open(
        `launch:${t.tick}:${target}`,
        t.tick,
        target,
        false,
      );
      entry.record.troopsSent = lost;
      entry.record.troopsCancelledAtLaunch = lost;
      this.close([entry], "cancelled_at_launch", t.tick, 0);
    }

    for (const g of gone) {
      if (g.absorbed) continue;
      const { target, retreating } = g.last;
      // What the attack held when it went: what came home, unless lost.
      const left = g.last.ref?.troops() ?? g.last.troops;
      if (retreating) {
        const home = left * (target === 0 ? 1 : 1 - RETREAT_MALUS);
        this.close(g.group, "retreated", t.tick, home);
      } else if (t.counters.has(target)) {
        this.close(g.group, "countered", t.tick, 0);
      } else if (target !== 0 && !this.players.alive(target)) {
        this.close(g.group, "target_dead", t.tick, left < 1 ? 0 : left);
      } else if (left < 1) {
        this.close(g.group, "burned_out", t.tick, 0);
      } else {
        this.close(g.group, "frontier_emptied", t.tick, left);
      }
    }

    for (const b of t.boats) {
      if (this.atSea.has(b.unit)) continue;
      const entry = this.open(`boat:${b.unit}`, t.tick, b.target, true);
      entry.record.troopsSent = Math.round(b.troops);
      this.atSea.set(b.unit, entry);
    }

    // Credit this tick's gains. Attacks that ended this tick were active
    // during it too. Before the first attack or boat, gains are the spawn.
    const credit = new Map<number, { entry: Entry; land: boolean }>();
    const consider = (a: AttackSighting, group: Entry[]) => {
      const land = a.sourceTile === null;
      const cur = credit.get(a.target);
      if (cur === undefined || (land && !cur.land)) {
        credit.set(a.target, { entry: group[0], land });
      }
    };
    for (const a of t.attacks) consider(a, this.byAttack.get(a.id)!);
    for (const g of gone) if (!g.absorbed) consider(g.last, g.group);
    for (let i = 0; i < t.gains.length; i += 2) {
      const entry =
        landings.get(t.gains[i]) ?? credit.get(t.gains[i + 1])?.entry;
      if (entry !== undefined) entry.record.tilesGained++;
      else if (this.records.length + this.dropped === 0) this.spawnTiles++;
      else this.tilesUncredited++;
    }

    this.lastAttacks = attacks;
    this.lastBoats = boats;
  }

  private open(id: string, tick: number, target: number, boat: boolean): Entry {
    const record: AttackRecord = {
      id,
      startTick: tick,
      endTick: null,
      target: this.players.describe(target),
      boat,
      troopsSent: 0,
      troopsCancelledAtLaunch: 0,
      troopsLost: null,
      tilesGained: 0,
      end: "running",
    };
    const kept = this.records.length < MAX_ATTACK_RECORDS;
    if (kept) this.records.push(record);
    else this.dropped++;
    return { record, kept };
  }

  /** Ends every record of `group`, `home` of their troops having come
   *  back; the rest are lost, shared out in proportion to troopsSent. */
  private close(
    group: Entry[],
    end: AttackRecord["end"],
    tick: number,
    home: number,
  ) {
    const sent = group.reduce((a, e) => a + e.record.troopsSent, 0);
    const lost = Math.max(0, sent - home);
    for (const { record } of group) {
      record.end = end;
      record.endTick = tick;
      record.troopsLost =
        sent === 0 ? 0 : Math.round((lost * record.troopsSent) / sent);
    }
  }
}

/** The record an absorbing attack continues goes first: a kept land
 *  attack's, else a kept boat's, else the oldest. */
function continuedFirst(group: Entry[]): Entry[] {
  const rank = (e: Entry) => (!e.kept ? 2 : e.record.boat ? 1 : 0);
  return [...group].sort(
    (a, b) => rank(a) - rank(b) || a.record.startTick - b.record.startTick,
  );
}

// ── Attacks received ───────────────────────────────────────────────────

/** An attack on this seat as seen after a tick. */
export interface IncomingSighting {
  id: string;
  attacker: number;
  attackerType: PlayerType;
  troops: number;
  /** It came by boat (counted when the boat set sail). */
  boat: boolean;
}

/** Counts the attacks one seat receives. */
export class IncomingLog {
  readonly attacks: ByAttacker = { nation: 0, bot: 0, human: 0 };
  readonly attackTroops: ByAttacker = { nation: 0, bot: 0, human: 0 };
  /** After each observe: troops each attacker's attacks on us held the tick
   *  before, plus those of its attacks on us that appeared in this one. */
  readonly opposing = new Map<number, number>();
  private last = new Map<string, IncomingSighting>();

  /** Returns the attackers whose new attack on us appeared this tick. */
  observe(sightings: readonly IncomingSighting[]): Set<number> {
    const now = new Map(sightings.map((s) => [s.id, s]));
    this.opposing.clear();
    const hold = (s: IncomingSighting) =>
      this.opposing.set(
        s.attacker,
        (this.opposing.get(s.attacker) ?? 0) + s.troops,
      );
    for (const s of this.last.values()) hold(s);
    for (const s of sightings) if (!this.last.has(s.id)) hold(s);
    // A new land attack absorbs its attacker's earlier attacks on us, which
    // vanish in the same tick; their troops were already counted.
    const vanished = new Map<number, number>();
    for (const [id, s] of this.last) {
      if (now.has(id)) continue;
      vanished.set(s.attacker, (vanished.get(s.attacker) ?? 0) + s.troops);
    }
    const counters = new Set<number>();
    for (const s of sightings) {
      if (this.last.has(s.id)) continue;
      counters.add(s.attacker);
      if (s.boat) continue;
      const absorbed = vanished.get(s.attacker) ?? 0;
      vanished.delete(s.attacker);
      this.launched(s.attackerType, Math.max(0, s.troops - absorbed));
    }
    this.last = now;
    return counters;
  }

  launched(type: PlayerType, troops: number): void {
    const k = attackerKey(type);
    this.attacks[k]++;
    this.attackTroops[k] += troops;
  }
}

function attackerKey(type: PlayerType): keyof ByAttacker {
  switch (type) {
    case PlayerType.Nation:
      return "nation";
    case PlayerType.Bot:
      return "bot";
    case PlayerType.Human:
      return "human";
  }
}

// ── The recorder ───────────────────────────────────────────────────────

const NUKE_KEYS: Partial<Record<UnitType, keyof Received["nukes"]>> = {
  [UnitType.AtomBomb]: "atom",
  [UnitType.HydrogenBomb]: "hydrogen",
  [UnitType.MIRV]: "mirv",
  [UnitType.MIRVWarhead]: "mirvWarhead",
};

class SeatRecorder {
  readonly standings: StandingPoint[] = [];
  /** Targets of this tick's executed attack intents. */
  readonly launched: number[] = [];
  /** The stats' sent + cancelled attack troops so far. */
  private committedSoFar = 0;
  readonly log: AttackLog;
  readonly incoming = new IncomingLog();
  readonly nukes: Received["nukes"] = {
    atom: 0,
    hydrogen: 0,
    mirv: 0,
    mirvWarhead: 0,
  };
  firstNukeTick: number | null = null;
  eliminatedBy: Received["eliminatedBy"] = null;
  /** Our transport ships at sea, with the owner of their destination when
   *  they set sail. */
  boats: { unit: Unit; target: number }[] = [];
  /** This tick's gains, [tile, previous owner] pairs. */
  readonly gains: number[] = [];
  /** This tick's losses by taker smallID. */
  readonly lostTo = new Map<number, number>();
  /** Recent losses, flat [tick, taker, count] triples. */
  private losses: number[] = [];

  constructor(
    private readonly game: Game,
    readonly player: Player,
    players: PlayerLookup,
  ) {
    this.log = new AttackLog(players);
  }

  /** Troops the attacks begun this tick started with: the growth of the
   *  stats' sent + cancelled (a retreat moves troops from one to the
   *  other); null for a player without a client id, which has no stats. */
  private committed(): number | null {
    if (this.player.clientID() === null) return null;
    const a = this.game.stats().getPlayerStats(this.player)?.attacks;
    const total =
      Number(a?.[ATTACK_INDEX_SENT] ?? 0) +
      Number(a?.[ATTACK_INDEX_CANCEL] ?? 0);
    const now = total - this.committedSoFar;
    this.committedSoFar = total;
    return now;
  }

  tick(tick: number): void {
    const me = this.player;
    const counters = this.incoming.observe(
      me.incomingAttacks().map((a) => ({
        id: a.id(),
        attacker: a.attacker().smallID(),
        attackerType: a.attacker().type(),
        troops: a.troops(),
        boat: a.sourceTile() !== null,
      })),
    );
    this.boats = this.boats.filter((b) => b.unit.isActive());
    this.log.observe({
      tick,
      attacks: me.outgoingAttacks().map((a) => ({
        id: a.id(),
        target: a.target().smallID(),
        sourceTile: a.sourceTile(),
        troops: a.troops(),
        retreating: a.retreating() || a.retreated(),
        ref: a,
      })),
      boats: this.boats.map(({ unit, target }) => ({
        unit: unit.id(),
        target,
        dst: unit.targetTile() ?? unit.tile(),
        troops: unit.troops(),
        retreating: unit.transportShipState().isRetreating,
        ref: unit,
      })),
      counters,
      gains: this.gains,
      launched: this.launched,
      committed: this.committed(),
      opposing: this.incoming.opposing,
    });
    this.gains.length = 0;
    this.launched.length = 0;

    for (const [taker, n] of this.lostTo) this.losses.push(tick, taker, n);
    this.lostTo.clear();
    let head = 0;
    while (
      head < this.losses.length &&
      this.losses[head] <= tick - ELIMINATION_WINDOW
    ) {
      head += 3;
    }
    if (head > 0) this.losses.splice(0, head);
  }

  /** The player that took the most of our tiles in the window. */
  topTaker(): number | null {
    const taken = new Map<number, number>();
    for (let i = 0; i < this.losses.length; i += 3) {
      const taker = this.losses[i + 1];
      taken.set(taker, (taken.get(taker) ?? 0) + this.losses[i + 2]);
    }
    let best: number | null = null;
    for (const [taker, n] of taken) {
      if (best === null || n > taken.get(best)!) best = taker;
    }
    return best;
  }
}

/**
 * Records standings, attacks and nukes for every seat of one game. Feed it
 * every update of the authoritative runner and call `afterTick` once per
 * executed tick, with the intents of the turn it executed. Its per-tick cost
 * is proportional to what changed: it keeps its own copy of tile owners,
 * updated from the packed tile updates, to see who took each tile from whom.
 */
export class ArenaRecorder {
  private readonly owner: Uint16Array;
  /** smallID -> seat index + 1 (0: not a seat). */
  private readonly seatOf = new Uint16Array(OWNER_MASK + 1);
  private readonly seats: SeatRecorder[];
  private readonly byClient = new Map<string, SeatRecorder>();
  private readonly seenUnits = new Set<number>();
  private readonly lookup: PlayerLookup;
  private pending: GameUpdateViewData[] = [];
  private nextStanding = 0;

  constructor(
    private readonly game: Game,
    players: Player[],
  ) {
    const size = game.width() * game.height();
    this.owner = new Uint16Array(size);
    for (let t = 0; t < size; t++) this.owner[t] = game.ownerID(t);
    this.lookup = {
      describe: (id) => {
        const p = game.playerBySmallID(id);
        return p.isPlayer()
          ? { name: p.name(), type: p.type() }
          : { name: "TerraNullius", type: "TerraNullius" };
      },
      alive: (id) => {
        const p = game.playerBySmallID(id);
        return !p.isPlayer() || p.isAlive();
      },
    };
    this.seats = players.map((p, i) => {
      this.seatOf[p.smallID()] = i + 1;
      const seat = new SeatRecorder(game, p, this.lookup);
      const client = p.clientID();
      if (client !== null) this.byClient.set(client, seat);
      return seat;
    });
  }

  /** Every GameUpdateViewData of the authoritative runner. */
  update(gu: GameUpdateViewData): void {
    this.pending.push(gu);
  }

  /** `intents`: those of the turn the tick executed, so a launch that was
   *  cancelled before it could be seen is still known. */
  afterTick(intents: readonly StampedIntent[] = []): void {
    const tick = this.game.ticks();
    for (const intent of intents) {
      if (intent.type !== "attack" || intent.targetID === null) continue;
      const seat = this.byClient.get(intent.clientID);
      if (seat === undefined || !this.game.hasPlayer(intent.targetID)) continue;
      seat.launched.push(this.game.player(intent.targetID).smallID());
    }
    for (const gu of this.pending) {
      this.units(gu.updates[GameUpdateType.Unit] as UnitUpdate[], tick);
      this.tiles(gu.packedTileUpdates);
    }
    this.pending = [];
    for (const s of this.seats) s.tick(tick);
    this.sampleStandings(tick);
  }

  /** Seat `i` was just eliminated. */
  eliminated(i: number): void {
    const s = this.seats[i];
    const taker = s.topTaker();
    s.eliminatedBy = taker === null ? null : this.lookup.describe(taker);
  }

  records(i: number): SeatRecords {
    const s = this.seats[i];
    const troops = (b: ByAttacker): ByAttacker => ({
      nation: Math.round(b.nation),
      bot: Math.round(b.bot),
      human: Math.round(b.human),
    });
    return {
      standings: s.standings,
      received: {
        attacks: { ...s.incoming.attacks },
        attackTroops: troops(s.incoming.attackTroops),
        nukes: { ...s.nukes },
        firstNukeTick: s.firstNukeTick,
        eliminatedBy: s.eliminatedBy,
      },
      attacks: s.log.records,
      attacksDropped: s.log.dropped,
      spawnTiles: s.log.spawnTiles,
      tilesUncredited: s.log.tilesUncredited,
    };
  }

  private units(updates: UnitUpdate[], tick: number): void {
    for (const u of updates) {
      const nuke = NUKE_KEYS[u.unitType];
      if (nuke === undefined && u.unitType !== UnitType.TransportShip) {
        continue;
      }
      if (this.seenUnits.has(u.id)) continue;
      this.seenUnits.add(u.id);
      const targetOwner =
        u.targetTile === undefined ? 0 : this.game.ownerID(u.targetTile);
      const mine = this.seatOf[u.ownerID];
      if (u.unitType === UnitType.TransportShip && mine > 0) {
        const unit = this.game.unit(u.id);
        if (unit !== undefined) {
          this.seats[mine - 1].boats.push({ unit, target: targetOwner });
        }
      }
      const hit = this.seatOf[targetOwner];
      if (hit === 0 || targetOwner === u.ownerID) continue;
      const s = this.seats[hit - 1];
      if (nuke !== undefined) {
        s.nukes[nuke]++;
        s.firstNukeTick ??= tick;
      } else {
        const attacker = this.game.playerBySmallID(u.ownerID);
        if (attacker.isPlayer()) s.incoming.launched(attacker.type(), u.troops);
      }
    }
  }

  private tiles(packed: Uint32Array): void {
    const owner = this.owner;
    const seatOf = this.seatOf;
    for (let i = 0; i < packed.length; i += 2) {
      const tile = packed[i];
      const now = packed[i + 1] & OWNER_MASK;
      const before = owner[tile];
      if (now === before) continue;
      owner[tile] = now;
      const gainer = seatOf[now];
      if (gainer > 0) this.seats[gainer - 1].gains.push(tile, before);
      const loser = seatOf[before];
      if (loser > 0 && now !== 0) {
        const lost = this.seats[loser - 1].lostTo;
        lost.set(now, (lost.get(now) ?? 0) + 1);
      }
    }
  }

  private sampleStandings(tick: number): void {
    while (
      this.nextStanding < STANDING_MINUTES.length &&
      tick >= STANDING_MINUTES[this.nextStanding] * 600
    ) {
      const minute = STANDING_MINUTES[this.nextStanding++];
      const field: Contender[] = [];
      for (const p of this.game.allPlayers()) {
        if (p.type() === PlayerType.Bot) continue;
        field.push({
          name: p.name(),
          nation: p.type() === PlayerType.Nation,
          share: landShare(this.game, p),
        });
      }
      for (const s of this.seats) {
        const share = landShare(this.game, s.player);
        s.standings.push(standingPoint(minute, tick, share, field));
      }
    }
  }
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
