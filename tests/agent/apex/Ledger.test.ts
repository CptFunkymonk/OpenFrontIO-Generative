import path from "path";
import { AgentIntent } from "../../../src/agent/Agent";
import {
  ArenaGameSpec,
  arenaGameStart,
  seatClientID,
} from "../../../src/agent/arena/ArenaGame";
import { NodeMapLoader } from "../../../src/agent/arena/NodeMapLoader";
import {
  BOAT_RETREAT_MALUS,
  GONE_TTL,
  Ledger,
  LedgerData,
  PENDING_TTL,
} from "../../../src/agent/lib/Ledger";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameType,
  Player,
  PlayerType,
  UnitType,
} from "../../../src/core/game/Game";
import { createGameRunner } from "../../../src/core/GameRunner";
import { Intent } from "../../../src/core/Schemas";

// The Ledger (spec §2.5) first against stand-in attacks, where every case can
// be set up exactly, then against the real simulation on Pangaea as the arena
// builds it: merges [PIN AttackMerge] give the merged attack a new id, a snack
// on a fresh tribe ends the tick after it lands [PIN TribeStats], and a
// cancelled attack retreats for 20 ticks (RetreatExecution.ts).

interface FakeAttack {
  id: string;
  /** smallID and PlayerID of the target; null = TN. */
  target: { small: number; id: string } | null;
  troops: number;
  boat?: boolean;
  retreating?: boolean;
}

/** A stand-in for `me` with exactly what Ledger.observe reads. */
function fakeMe(attacks: FakeAttack[], ships = 0): Player {
  return {
    outgoingAttacks: () =>
      attacks.map((a) => ({
        id: () => a.id,
        target: () =>
          a.target === null
            ? { isPlayer: () => false, smallID: () => 0, id: () => null }
            : {
                isPlayer: () => true,
                smallID: () => a.target!.small,
                id: () => a.target!.id,
              },
        troops: () => a.troops,
        sourceTile: () => (a.boat === true ? 1234 : null),
        retreating: () => a.retreating === true,
      })),
    unitCount: (t: UnitType) => (t === UnitType.TransportShip ? ships : 0),
    units: (t: UnitType) =>
      t !== UnitType.TransportShip
        ? []
        : Array.from({ length: ships }, (_, i) => ({
            id: () => 1000 + i,
            targetTile: () => 99,
            troops: () => 8000,
            transportShipState: () => ({ isRetreating: false }),
          })),
    smallID: () => 1,
  } as unknown as Player;
}

const TRIBE = { small: 17, id: "TRIBE017" };
const OTHER = { small: 23, id: "TRIBE023" };

function atk(targetID: string | null, troops: number): AgentIntent {
  return { type: "attack", targetID, troops };
}

describe("apex Ledger (§2.5): stand-in attacks", () => {
  test("a send counts in stackOn until its attack shows under a new id, then the attack counts", () => {
    const l = new Ledger();
    l.observe(fakeMe([]), 10);
    l.recordSend(atk(null, 3000), 10, "tn", { target: 0 });
    expect(l.stackOn(0)).toBe(3000);
    expect(l.plan(0)).toMatchObject({
      targetSmallID: 0,
      kind: "tn",
      launchedAt: 10,
      lastSend: 10,
    });
    // Tick 11: the attack ran one tick and lost 40.
    l.observe(fakeMe([{ id: "a1", target: null, troops: 2960 }]), 11);
    expect(l.stackOn(0)).toBe(2960);
  });

  test("merged attacks: the later send's attack absorbs the earlier one under a new id; the plan keeps its launch", () => {
    const l = new Ledger();
    l.observe(fakeMe([]), 10);
    l.recordSend(atk(TRIBE.id, 5000), 10, "tribe", {
      target: TRIBE.small,
      clampTroops: 4000,
      expectedRefund: 1000,
    });
    l.observe(fakeMe([{ id: "a1", target: TRIBE, troops: 5000 }]), 11);
    // A top-up without a kind still moves lastSend.
    l.recordSend(atk(TRIBE.id, 2000), 11, null, { target: TRIBE.small });
    expect(l.stackOn(TRIBE.small)).toBe(7000);
    l.observe(fakeMe([{ id: "a2", target: TRIBE, troops: 6900 }]), 12);
    expect(l.stackOn(TRIBE.small)).toBe(6900);
    expect(l.plan(TRIBE.small)).toEqual({
      targetSmallID: TRIBE.small,
      kind: "tribe",
      launchedAt: 10,
      lastSend: 11,
      clampTroops: 4000,
      expectedRefund: 1000,
    });
    // Two clicks in one turn collapse into one attack: one new id clears
    // both sends.
    l.recordSend(atk(TRIBE.id, 100), 12, null, { target: TRIBE.small });
    l.recordSend(atk(TRIBE.id, 200), 12, null, { target: TRIBE.small });
    expect(l.stackOn(TRIBE.small)).toBe(7200);
    l.observe(fakeMe([{ id: "a3", target: TRIBE, troops: 7150 }]), 13);
    expect(l.stackOn(TRIBE.small)).toBe(7150);
  });

  test("finished plans are dropped: no attack, no pending send", () => {
    const l = new Ledger();
    l.observe(fakeMe([]), 10);
    l.recordSend(atk(TRIBE.id, 300), 10, "snack", { target: TRIBE.small });
    l.recordSend(atk(null, 3000), 10, "tn", { target: 0 });
    l.observe(
      fakeMe([
        { id: "s1", target: TRIBE, troops: 300 },
        { id: "t1", target: null, troops: 3000 },
      ]),
      11,
    );
    expect(l.allPlans().map((p) => p.targetSmallID)).toEqual([0, TRIBE.small]);
    // The snack took the whole tribe and came home.
    l.observe(fakeMe([{ id: "t1", target: null, troops: 2800 }]), 12);
    expect(l.plan(TRIBE.small)).toBeUndefined();
    expect(l.plan(0)).toBeDefined();
    expect(l.stackOn(TRIBE.small)).toBe(0);
  });

  test("a send whose attack never shows counts for PENDING_TTL ticks, then its plan goes", () => {
    const l = new Ledger();
    l.observe(fakeMe([]), 10);
    l.recordSend(atk(OTHER.id, 900), 10, "tribe", { target: OTHER.small });
    for (let t = 11; t <= 10 + PENDING_TTL; t++) {
      l.observe(fakeMe([]), t);
      expect(l.stackOn(OTHER.small)).toBe(900);
      expect(l.plan(OTHER.small)).toBeDefined();
    }
    l.observe(fakeMe([]), 11 + PENDING_TTL);
    expect(l.stackOn(OTHER.small)).toBe(0);
    expect(l.plan(OTHER.small)).toBeUndefined();
  });

  test("an id already seen does not clear a send, a new id on another target does not either, and a boat landing never does", () => {
    const l = new Ledger();
    const old = { id: "t1", target: null, troops: 1000 };
    l.observe(fakeMe([old]), 10);
    l.recordSend(atk(null, 500), 10, null, { target: 0 });
    l.observe(
      fakeMe([
        old,
        { id: "x1", target: OTHER, troops: 50 },
        { id: "b1", target: null, troops: 70, boat: true },
      ]),
      11,
    );
    // The TN send is refused or late: still pending, landing counted too.
    expect(l.stackOn(0)).toBe(1000 + 70 + 500);
    l.observe(
      fakeMe([
        { id: "t2", target: null, troops: 1490 },
        { id: "x1", target: OTHER, troops: 50 },
        { id: "b1", target: null, troops: 70, boat: true },
      ]),
      12,
    );
    expect(l.stackOn(0)).toBe(1490 + 70);
  });

  test("retreating attacks are not in stackOn but keep the plan and count as refund", () => {
    const l = new Ledger();
    l.observe(fakeMe([]), 10);
    l.recordSend(atk(null, 4000), 10, "tn", {
      target: 0,
      expectedRefund: 10_000,
    });
    l.observe(
      fakeMe([{ id: "t1", target: null, troops: 4000, retreating: true }]),
      11,
    );
    expect(l.stackOn(0)).toBe(0);
    expect(l.retreatingOn(0)).toBe(4000);
    expect(l.plan(0)).toBeDefined();
    expect(l.expectedRefunds()).toBe(4000);
  });

  test("expectedRefunds: each plan's refund, capped by the troops still in play", () => {
    const l = new Ledger();
    l.observe(fakeMe([]), 10);
    l.recordSend(atk(TRIBE.id, 5000), 10, "tribe", {
      target: TRIBE.small,
      expectedRefund: 1200,
    });
    l.recordSend(atk(OTHER.id, 900), 10, "tribe", {
      target: OTHER.small,
      expectedRefund: 2000,
    });
    // Before the attacks show, the pending troops bound the refund.
    expect(l.expectedRefunds()).toBe(1200 + 900);
    l.observe(
      fakeMe([
        { id: "a1", target: TRIBE, troops: 5000 },
        { id: "a2", target: OTHER, troops: 600 },
      ]),
      11,
    );
    expect(l.expectedRefunds()).toBe(1200 + 600);
    // A controller re-evaluating a plan updates it in place.
    l.plan(TRIBE.small)!.expectedRefund = 300;
    expect(l.expectedRefunds()).toBe(300 + 600);
  });

  test("an attack sent without a target smallID gets its plan when its attack first shows", () => {
    const l = new Ledger();
    l.observe(fakeMe([]), 10);
    l.recordSend(atk(TRIBE.id, 700), 10, "snack", { expectedRefund: 400 });
    expect(l.plan(TRIBE.small)).toBeUndefined();
    expect(l.stackOn(TRIBE.small)).toBe(0);
    l.observe(fakeMe([{ id: "s1", target: TRIBE, troops: 700 }]), 11);
    expect(l.plan(TRIBE.small)).toMatchObject({
      kind: "snack",
      launchedAt: 10,
      lastSend: 10,
      expectedRefund: 400,
    });
    expect(l.stackOn(TRIBE.small)).toBe(700);
    // Now the id is known: a later send resolves at once.
    l.recordSend(atk(TRIBE.id, 50), 11, null);
    expect(l.stackOn(TRIBE.small)).toBe(750);
    expect(l.plan(TRIBE.small)!.lastSend).toBe(11);
  });

  test("boats: a boat plan lives while a boat of ours is out, and never overrides a land plan", () => {
    const boat: AgentIntent = { type: "boat", troops: 8000, dst: 99 };
    const l = new Ledger();
    l.observe(fakeMe([]), 10);
    l.recordSend(boat, 10, "boat", { target: OTHER.small });
    l.recordSend(boat, 10, null); // no target: no plan
    expect(l.allPlans()).toHaveLength(1);
    expect(l.stackOn(OTHER.small)).toBe(0); // at sea, not attacking
    for (let t = 11; t < 60; t++) {
      l.observe(fakeMe([], 1), t);
      expect(l.plan(OTHER.small)?.kind).toBe("boat");
    }
    // Landed: the landing's attack keeps it.
    l.observe(
      fakeMe([{ id: "b1", target: OTHER, troops: 7900, boat: true }]),
      60,
    );
    expect(l.stackOn(OTHER.small)).toBe(7900);
    // A land send takes the plan over.
    l.recordSend(atk(OTHER.id, 1000), 60, "tribe", { target: OTHER.small });
    expect(l.plan(OTHER.small)).toMatchObject({
      kind: "tribe",
      launchedAt: 10,
      lastSend: 60,
    });
    // A boat to a target with a land plan changes nothing.
    l.recordSend(boat, 61, "boat", { target: OTHER.small });
    expect(l.plan(OTHER.small)).toMatchObject({ kind: "tribe", lastSend: 60 });
    // No attack, no boat at sea: gone.
    l.observe(fakeMe([], 0), 70);
    expect(l.plan(OTHER.small)).toBeUndefined();

    // A boat plan whose boat is gone is dropped after the latency grace.
    l.recordSend(boat, 80, "boat", { target: TRIBE.small });
    l.observe(fakeMe([], 0), 80 + PENDING_TTL);
    expect(l.plan(TRIBE.small)).toBeDefined();
    l.observe(fakeMe([], 0), 81 + PENDING_TTL);
    expect(l.plan(TRIBE.small)).toBeUndefined();
  });

  test("boats with the game: a boat plan lives only while a ship of ours lands on its target", () => {
    // Ships by landing tile; the stand-in game maps tile t to owner t.
    const withShips = (ships: { dst: number; retreating?: boolean }[]) =>
      ({
        ...fakeMe([], ships.length),
        units: (t: UnitType) =>
          t !== UnitType.TransportShip
            ? []
            : ships.map((s, i) => ({
                id: () => 500 + i,
                troops: () => 8000,
                targetTile: () => s.dst,
                transportShipState: () => ({
                  isRetreating: s.retreating === true,
                }),
              })),
      }) as unknown as Player;
    const game = {
      ownerID: (t: number) => t,
      manhattanDist: (a: number, b: number) => Math.abs(a - b),
    } as unknown as Game;
    const boat = (dst: number): AgentIntent => ({
      type: "boat",
      troops: 8000,
      dst,
    });
    const l = new Ledger();
    l.observe(withShips([]), 10, game);
    l.recordSend(boat(OTHER.small), 10, "boat", { target: OTHER.small });
    l.recordSend(boat(TRIBE.small), 10, "boat", { target: TRIBE.small });
    for (let t = 11; t < 40; t++) {
      // Only the ship to OTHER is still at sea (TRIBE's landing ended).
      l.observe(withShips([{ dst: OTHER.small }]), t, game);
      expect(l.plan(OTHER.small)?.kind).toBe("boat");
      if (t > 10 + PENDING_TTL) expect(l.plan(TRIBE.small)).toBeUndefined();
    }
    // Its ship retreats: the plan ends.
    l.observe(withShips([{ dst: OTHER.small, retreating: true }]), 40, game);
    expect(l.plan(OTHER.small)).toBeUndefined();
    // Without the game, any ship at sea keeps every boat plan (old rule).
    l.recordSend(boat(TRIBE.small), 50, "boat", { target: TRIBE.small });
    l.observe(withShips([{ dst: OTHER.small }]), 50 + PENDING_TTL + 1);
    expect(l.plan(TRIBE.small)?.kind).toBe("boat");
  });

  test("ships: each keeps its send's target and refund; ships at sea count in expectedRefunds by who owns the landing now", () => {
    // Stand-ins: ship `id` bound for tile `dst`; the game says who owns it.
    let owner = TRIBE.small;
    const ships: {
      id: number;
      dst: number;
      troops: number;
      retreating?: boolean;
    }[] = [];
    const me = {
      ...fakeMe([]),
      unitCount: (t: UnitType) =>
        t === UnitType.TransportShip ? ships.length : 0,
      units: () =>
        ships.map((x) => ({
          id: () => x.id,
          targetTile: () => x.dst,
          troops: () => x.troops,
          transportShipState: () => ({ isRetreating: x.retreating === true }),
        })),
      smallID: () => 1,
    } as unknown as Player;
    const game = {
      ownerID: (t: number) => (t === 99 ? owner : 0),
      manhattanDist: (a: number, b: number) => Math.abs(a - b),
    } as unknown as Game;
    const l = new Ledger();
    l.observe(me, 10, game);
    // A tribe landing at tile 99 (refund 3,000) and a free-land boat at 7.
    l.recordSend({ type: "boat", troops: 8000, dst: 99 }, 10, "boat", {
      target: TRIBE.small,
      expectedRefund: 3000,
    });
    l.recordSend({ type: "boat", troops: 9000, dst: 7 }, 10, null);
    // The ships show the next tick, the free-land one landing a tile off.
    ships.push(
      { id: 41, dst: 99, troops: 8000 },
      { id: 42, dst: 8, troops: 9000 },
    );
    l.observe(me, 11, game);
    expect(l.ship(41)).toMatchObject({
      target: TRIBE.small,
      refund: 3000,
      sentAt: 10,
    });
    expect(l.ship(42)).toMatchObject({ target: 0, dst: 8, refund: 0 });
    // At sea: the tribe landing's refund (the plan's own counts nothing
    // while no attack runs), the free-land boat nothing.
    expect(l.expectedRefunds()).toBe(3000);
    // A nation takes the landing: the landing will come home in full.
    owner = 50;
    l.observe(me, 12, game);
    expect(l.ship(41)?.target).toBe(TRIBE.small);
    expect(l.expectedRefunds()).toBe(8000);
    // It becomes ours: home with the malus; retreating likewise.
    owner = 1;
    l.observe(me, 13, game);
    expect(l.expectedRefunds()).toBe(8000 * (1 - BOAT_RETREAT_MALUS));
    owner = TRIBE.small;
    ships[0].retreating = true;
    l.observe(me, 14, game);
    expect(l.expectedRefunds()).toBe(8000 * (1 - BOAT_RETREAT_MALUS));
    // Gone: no refund from the ship; the record stays GONE_TTL ticks.
    ships.length = 0;
    l.observe(me, 15, game);
    expect(l.ship(41)?.goneAt).toBe(15);
    expect(l.expectedRefunds()).toBe(0);
    const copy = Ledger.fromData(l.toData());
    expect(copy.allShips()).toEqual(l.allShips());
    l.observe(me, 15 + GONE_TTL, game);
    expect(l.ship(41)).toBeDefined();
    l.observe(me, 16 + GONE_TTL, game);
    expect(l.allShips()).toEqual([]);
  });

  test("sentThisTick: this tick's accepted intents in order; a new tick starts empty", () => {
    const l = new Ledger();
    const a = atk(null, 1);
    const b: AgentIntent = { type: "allianceRequest", recipient: "N1" };
    const c: AgentIntent = { type: "spawn", tile: 5 };
    l.recordSend(c, 3, null); // spawn phase: no observe first
    expect(l.sentThisTick()).toEqual([c]);
    l.observe(fakeMe([]), 104);
    expect(l.sentThisTick()).toEqual([]);
    l.recordSend(a, 104, "tn", { target: 0 });
    l.recordSend(b, 104, null);
    expect(l.sentThisTick()).toEqual([a, b]);
    l.observe(fakeMe([]), 104); // same tick again: kept
    expect(l.sentThisTick()).toEqual([a, b]);
    l.recordSend(a, 105, null, { target: 0 }); // next tick, before observe
    expect(l.sentThisTick()).toEqual([a]);
  });

  test("toData is plain data, and a ledger restored from it goes on exactly like the original", () => {
    const run = (l: Ledger, from: number) => {
      const trace: unknown[] = [];
      const script: FakeAttack[][] = [
        [{ id: "t2", target: null, troops: 2500 }], // tick 12: shows
        [{ id: "t2", target: null, troops: 2400 }],
        [],
      ];
      for (let i = 0; i < script.length; i++) {
        const t = from + i;
        l.observe(fakeMe(script[i]), t);
        trace.push([t, l.stackOn(0), l.plan(0), l.sentThisTick().length]);
      }
      return trace;
    };
    const l = new Ledger();
    l.observe(fakeMe([{ id: "t1", target: null, troops: 1000 }]), 10);
    l.recordSend(atk(null, 1500), 10, "tn", { target: 0 });
    l.observe(fakeMe([{ id: "t1", target: null, troops: 990 }]), 11); // late
    l.recordSend(atk(TRIBE.id, 70), 11, "snack"); // target unresolved

    const data: LedgerData = l.toData();
    expect(structuredClone(data)).toEqual(data);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    const copy = Ledger.fromData(data);
    expect(copy.toData()).toEqual(data);
    expect(copy.sentThisTick()).toEqual(l.sentThisTick());
    expect(run(copy, 12)).toEqual(run(l, 12));
    // The copy is independent of the data it came from.
    data.plans.length = 0;
    expect(Ledger.fromData(l.toData()).allPlans()).toHaveLength(
      l.allPlans().length,
    );
  });
});

// ── The real simulation ─────────────────────────────────────────────────

const MAPS = path.join(__dirname, "../../../resources/maps");

interface Sim {
  game: Game;
  me: Player;
  /** Runs the next turn with these intents from us. */
  step(intents?: Intent[]): void;
}

/** A game built as the arena builds it (Impossible nations, 400 tribes),
 *  one seat for us, stepped turn by turn (latency 1). */
async function arenaSim(map: GameMapType): Promise<Sim> {
  const spec = {
    gameID: "LEDGER01",
    map,
    mapSize: GameMapSize.Normal,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Impossible,
    nations: "default",
    bots: 400,
    seats: [{ agent: "apex" }],
  } as ArenaGameSpec;
  const runner = await createGameRunner(
    arenaGameStart(spec),
    undefined,
    new NodeMapLoader(MAPS),
    (gu) => {
      if ("errMsg" in gu) throw new Error(gu.errMsg);
    },
  );
  const game = runner.game;
  const ME = seatClientID(0);
  const me = game.playerByClientID(ME);
  if (me === null) throw new Error("no seat player");
  return {
    game,
    me,
    step(intents: Intent[] = []) {
      runner.addTurn({
        turnNumber: game.ticks(),
        intents: intents.map((i) => ({ ...i, clientID: ME })),
      });
      if (!runner.executeNextTick()) throw new Error("tick failed");
    },
  };
}

/** Sum of our live attack troops on the target (0 = TN), not retreating. */
function liveOn(me: Player, target: number): number {
  let sum = 0;
  for (const a of me.outgoingAttacks()) {
    const t = a.target();
    if ((t.isPlayer() ? t.smallID() : 0) === target && !a.retreating()) {
      sum += a.troops();
    }
  }
  return sum;
}

describe("apex Ledger (§2.5): the real simulation", () => {
  test("plans follow sends, merges and a snack's end on Pangaea; a cancelled TN attack keeps its plan until it is home", async () => {
    const { game, me, step } = await arenaSim(GameMapType.Pangaea);
    step();
    step();
    step(); // tribes landed in tick 1, nations in tick 2
    // A fresh 52-tile tribe with free land 4..11 tiles to its east: a
    // spawn 8 tiles east touches it (as TribeStats.test.ts does).
    const free = (x: number, y: number) => {
      if (!game.isValidCoord(x, y)) return false;
      const t = game.ref(x, y);
      return game.isLand(t) && !game.isImpassable(t) && !game.hasOwner(t);
    };
    const tribe = game
      .allPlayers()
      .filter((p) => p.type() === PlayerType.Bot)
      .find((t) => {
        const c = t.spawnTile()!;
        if (t.numTilesOwned() !== 52) return false;
        for (let dy = -4; dy < 4; dy++) {
          for (let dx = 4; dx < 12; dx++) {
            if (!free(game.x(c) + dx, game.y(c) + dy)) return false;
          }
        }
        return true;
      })!;
    expect(tribe).toBeDefined();
    const c = tribe.spawnTile()!;
    step([{ type: "spawn", tile: game.ref(game.x(c) + 8, game.y(c)) }]);
    step();
    expect(game.inSpawnPhase()).toBe(false);
    expect(me.sharesBorderWith(tribe)).toBe(true);

    const l = new Ledger();
    const send = (
      i: AgentIntent,
      kind: Parameters<Ledger["recordSend"]>[2],
      target?: number,
    ) => {
      l.recordSend(
        i,
        game.ticks(),
        kind,
        target === undefined ? undefined : { target },
      );
      return i as Intent;
    };

    // T: a TN send. Pending until its attack shows at T+1.
    const T = game.ticks();
    l.observe(me, T);
    const tn1 = send(atk(null, 3000), "tn", 0);
    expect(l.stackOn(0)).toBe(3000);
    expect(l.sentThisTick()).toHaveLength(1);
    step([tn1]);

    // T+1: the attack shows (not yet ticked); a second TN send merges.
    l.observe(me, T + 1);
    expect(l.sentThisTick()).toHaveLength(0);
    expect(me.outgoingAttacks()).toHaveLength(1);
    const firstID = me.outgoingAttacks()[0].id();
    expect(l.stackOn(0)).toBe(liveOn(me, 0));
    expect(l.stackOn(0)).toBe(3000);
    const tn2 = send(atk(null, 2000), "tn", 0);
    expect(l.stackOn(0)).toBe(5000);
    step([tn2]);

    // T+2: one TN attack under a new id holds both stacks less a tick of
    // losses; the plan kept its launch.
    l.observe(me, T + 2);
    const tnAttacks = me
      .outgoingAttacks()
      .filter((a) => !a.target().isPlayer());
    expect(tnAttacks).toHaveLength(1);
    expect(tnAttacks[0].id()).not.toBe(firstID);
    expect(tnAttacks[0].troops()).toBeGreaterThan(4500);
    expect(tnAttacks[0].troops()).toBeLessThan(5000);
    expect(l.stackOn(0)).toBe(liveOn(me, 0));
    expect(l.plan(0)).toMatchObject({
      kind: "tn",
      launchedAt: T,
      lastSend: T + 1,
    });

    // T+2: a snack with no target smallID; the plan appears when its
    // attack does.
    const snack = send(atk(tribe.id(), 20_000), "snack");
    expect(l.plan(tribe.smallID())).toBeUndefined();
    step([snack]);
    l.observe(me, T + 3);
    expect(l.plan(tribe.smallID())).toMatchObject({
      kind: "snack",
      launchedAt: T + 2,
    });
    expect(l.stackOn(tribe.smallID())).toBe(20_000);
    expect(l.stackOn(tribe.smallID())).toBe(liveOn(me, tribe.smallID()));

    // T+4: the tribe fell to the first tile and the stack came home.
    step();
    l.observe(me, T + 4);
    expect(tribe.isAlive()).toBe(false);
    expect(l.plan(tribe.smallID())).toBeUndefined();
    expect(l.stackOn(tribe.smallID())).toBe(0);
    expect(l.plan(0)).toBeDefined();
    expect(l.stackOn(0)).toBe(liveOn(me, 0));

    // Cancel the TN attack: 20 ticks of retreat, plan kept, not in the
    // stack; then home and the plan is gone.
    const tnID = me
      .outgoingAttacks()
      .find((a) => !a.target().isPlayer())!
      .id();
    step([{ type: "cancel_attack", attackID: tnID }]);
    let t = T + 5;
    l.observe(me, t);
    // RetreatExecution orders the retreat at its first tick.
    step();
    l.observe(me, ++t);
    expect(me.outgoingAttacks()[0].retreating()).toBe(true);
    expect(l.stackOn(0)).toBe(0);
    expect(l.retreatingOn(0)).toBe(me.outgoingAttacks()[0].troops());
    expect(l.plan(0)).toBeDefined();
    while (me.outgoingAttacks().length > 0 && t < T + 40) {
      step();
      l.observe(me, ++t);
      const gone = me.outgoingAttacks().length === 0;
      expect(l.plan(0) === undefined).toBe(gone);
    }
    expect(me.outgoingAttacks()).toHaveLength(0);
    expect(l.allPlans()).toEqual([]);
  }, 60_000);
});
