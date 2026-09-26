import { AgentIntent } from "../../../src/agent/Agent";
import {
  ExpansionController,
  inStall,
  SNACK_TILES,
  snackStack,
  tribeSizing,
} from "../../../src/agent/agents/apex/controllers/ExpansionController";
import { homeFloors } from "../../../src/agent/agents/apex/HomeTarget";
import {
  ApexOptions,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import {
  ApexPolicy,
  homeAvailable,
  View,
} from "../../../src/agent/agents/apex/policy";
import { ApexState, createState } from "../../../src/agent/agents/apex/state";
import { Ledger } from "../../../src/agent/lib/Ledger";
import { createModels } from "../../../src/agent/lib/Models";
import { NationModel } from "../../../src/agent/lib/NationModel";
import {
  createPurse,
  floorOf,
  HomeFloors,
  Proposal,
  Purse,
  Scheduler,
  SpendKind,
} from "../../../src/agent/lib/Scheduler";
import { scanWorld } from "../../../src/agent/lib/WorldModel";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import { Player } from "../../../src/core/game/Game";
import {
  addTribe,
  Field,
  field,
  GAME_ID,
  Harness,
  own,
  rect,
  submit,
} from "./Field";

// Spec §3.6 and §4 step 2 (Allocator.test): no partial clamp; every spend
// leaves home at or above its floor, except snacks, which leave ≥ H_vw;
// one attack per tribe. First one decision of the ExpansionController over
// a recording Purse (every take with its kind and what it leaves), then the
// whole live policy for 400 ticks on the same field, checked from outside.

const W = 120;
const H = 80;
const US_COLS = 10;

interface TribeSpec {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  density: number;
}

/** Tribes along our front x = 10, free land behind them. */
const TRIBES: TribeSpec[] = [
  // 60 tiles: a snack.
  { id: "SNACK001", x0: 10, y0: 0, x1: 20, y1: 6, density: 150 },
  // 600 tiles at density 20: affordable.
  { id: "CHEAP001", x0: 10, y0: 8, x1: 40, y1: 28, density: 20 },
  // 800 tiles at density 80: over tribeMaxPrice (p ≈ 26 > 1.5·16).
  { id: "DENSE001", x0: 10, y0: 30, x1: 50, y1: 50, density: 80 },
  // 400 tiles at density 30: affordable.
  { id: "MID00001", x0: 10, y0: 52, x1: 30, y1: 72, density: 30 },
  // 1,000... no: 200 tiles at density 400 (80k): does not fit.
  { id: "BIG00001", x0: 10, y0: 74, x1: 50, y1: 79, density: 400 },
];

async function scene(home: number) {
  const f = await field({ width: W, height: H });
  own(f.me, rect(f.game, 0, 0, US_COLS, H));
  const tribes = new Map<string, Player>();
  for (const t of TRIBES) {
    const tiles = rect(f.game, t.x0, t.y0, t.x1, t.y1);
    tribes.set(t.id, addTribe(f, t.id, tiles, t.density * tiles.length));
  }
  f.me.setTroops(home);
  f.game.executeNextTick();
  // Troops as set (the tribes' regrowth ran once).
  for (const t of TRIBES) {
    const p = tribes.get(t.id)!;
    p.setTroops(t.density * p.numTilesOwned());
  }
  return { f, tribes };
}

interface Take {
  kind: SpendKind;
  troops: number;
  left: number;
  floor: number;
}

/** A Purse that records every accepted take. */
function recording(inner: Purse, takes: Take[]): Purse {
  return {
    get home() {
      return inner.home;
    },
    floors: inner.floors,
    available: (k) => inner.available(k),
    take(k, troops) {
      const ok = inner.take(k, troops);
      if (ok) {
        takes.push({
          kind: k,
          troops,
          left: inner.home,
          floor: floorOf(inner.floors, k),
        });
      }
      return ok;
    },
  };
}

/** One decision of the ExpansionController alone, as the policy runs it. */
function decideOnce(f: Field, o: ApexOptions, s: ApexState) {
  const { game, me } = f;
  const tick = game.ticks();
  const models = createModels(game);
  const nm = new NationModel(game, me, GAME_ID, models);
  const ledger = new Ledger();
  ledger.observe(me, tick);
  const wm = scanWorld(game, me, null);
  const floors: HomeFloors = homeFloors({ tick, o, me, models, nm }, s);
  const takes: Take[] = [];
  const purse = recording(
    createPurse(homeAvailable(me, floors), floors),
    takes,
  );
  const scheduler = new Scheduler(o, game.config().msPerTick());
  scheduler.begin(tick, { perSecond: 10, perMinute: 150 }, purse);
  const accepted: Proposal[] = [];
  const offer = scheduler.offer.bind(scheduler);
  scheduler.offer = (p: Proposal) => {
    const ok = offer(p);
    if (ok) accepted.push(p);
    return ok;
  };
  const v: View = {
    game,
    me,
    tick,
    gameID: GAME_ID,
    o,
    models,
    wm,
    nm,
    ledger,
    race: null,
    owners: null,
    scheduler,
    purse,
    lookahead: null,
    forRollout: null,
    live: null,
  };
  new ExpansionController().decide(v, s);
  const sent: AgentIntent[] = [];
  scheduler.flush(
    (i) => {
      sent.push(i);
      return "ok";
    },
    ledger,
    tick,
  );
  return { takes, accepted, sent, floors, wm, models, ledger };
}

const OPTIONS = parseApexOptions({
  defense: false,
  diplomacy: false,
  strike: false,
  economy: false,
  endgame: false,
  boats: false,
});

describe("apex allocator (§3.6): one decision over a recording Purse", () => {
  test.each([60_000, 150_000, 400_000])(
    "home %i: each spend is taken through the Purse with its kind and leaves ≥ its floor; no partial clamp; one attack per target",
    async (home) => {
      const { f, tribes } = await scene(home);
      const s = createState();
      const { takes, accepted, sent, floors, wm, models } = decideOnce(
        f,
        OPTIONS,
        s,
      );
      // Every take leaves home at or above its kind's floor; snacks at or
      // above H_vw.
      for (const t of takes) {
        expect(t.left).toBeGreaterThanOrEqual(t.floor - 1e-6);
        if (t.kind === "snack") expect(t.floor).toBe(floors.vw);
      }
      // Every sent intent went through exactly one take of its troops.
      expect(sent).toHaveLength(accepted.length);
      expect(takes).toHaveLength(accepted.length);
      for (const p of accepted) {
        expect(p.spend).toBeDefined();
        expect(p.intent.type).toBe("attack");
      }
      // One attack per target.
      const targets = sent.map((i) => (i.type === "attack" ? i.targetID : 0));
      expect(new Set(targets).size).toBe(targets.length);

      for (const p of accepted) {
        const i = p.intent;
        if (i.type !== "attack") continue;
        if (i.targetID === null) {
          expect(p.spend!.kind).toBe("tn");
          continue;
        }
        const tribe = [...tribes.values()].find((t) => t.id() === i.targetID)!;
        const info = wm.neighbors.get(tribe.smallID())!;
        if (info.tiles <= SNACK_TILES) {
          expect(p.spend!.kind).toBe("snack");
          expect(i.troops).toBe(
            snackStack(
              models,
              wm.tiles,
              { ...info, isTraitor: false },
              OPTIONS,
            ),
          );
          continue;
        }
        // A launch: the whole S_b, never less.
        expect(p.spend!.kind).toBe("tribe");
        const sz = tribeSizing(
          models,
          wm.tiles,
          { ...info, isTraitor: false },
          models.regrowth(tribe),
          OPTIONS.tribeRatio,
          OPTIONS,
        );
        expect(i.troops).toBe(Math.ceil(sz.S));
        expect(i.troops).toBeGreaterThanOrEqual(
          (OPTIONS.tribeMargin * info.troops) / OPTIONS.tribeRatio,
        );
      }
      const hit = (id: string) => targets.includes(id);
      // The snack always goes: it only needs H_vw plus a few hundred.
      expect(hit("SNACK001")).toBe(true);
      // Too dense, and too big to fit: never.
      expect(hit("DENSE001")).toBe(false);
      expect(hit("BIG00001")).toBe(false);
      // Free land is there, and home is above the TN floor by more than the
      // minimum chunk at every level: a TN send.
      expect(floors.tn).toBeLessThan(home - 10_000);
      expect(targets.includes(null)).toBe(true);
      if (home === 60_000) {
        // Below H: no tribe launch.
        expect(hit("CHEAP001") || hit("MID00001")).toBe(false);
      }
      if (home === 400_000) {
        expect(hit("CHEAP001") && hit("MID00001")).toBe(true);
      }
    },
  );

  test("a tribe with a plan gets no second launch", async () => {
    const { f, tribes } = await scene(400_000);
    const s = createState();
    const first = decideOnce(f, OPTIONS, s);
    for (const i of first.sent) submit(f, i);
    f.game.executeNextTick();
    // The next decision with a fresh ledger that sees our attacks.
    const second = decideOnce(f, OPTIONS, s);
    const launched = first.sent
      .filter((i) => i.type === "attack" && i.targetID !== null)
      .map((i) => (i.type === "attack" ? i.targetID : null));
    expect(launched.length).toBeGreaterThan(0);
    for (const i of second.sent) {
      if (i.type !== "attack" || i.targetID === null) continue;
      expect(launched).not.toContain(i.targetID);
    }
    void tribes;
  });
});

describe("apex allocator: sends to a tribe that is attacking us", () => {
  test("carry its attack's troops, which the new attack cancels 1:1 at init [PIN AttackMerge]; the snack still kills and the launch keeps its S", async () => {
    const { f, tribes } = await scene(400_000);
    const snackT = tribes.get("SNACK001")!;
    const cheap = tribes.get("CHEAP001")!;
    // Both attack us (tribe attacks are built as AiAttackBehavior builds
    // them); the attacks init in this tick.
    f.game.addExecution(new AttackExecution(1_500, snackT, f.me.id()));
    f.game.addExecution(new AttackExecution(4_000, cheap, f.me.id()));
    f.game.executeNextTick();
    const incoming = (p: Player) =>
      f.me
        .incomingAttacks()
        .filter((a) => a.attacker() === p)
        .reduce((x, a) => x + a.troops(), 0);
    const X1 = incoming(snackT);
    const X2 = incoming(cheap);
    expect(X1).toBeGreaterThan(0);
    expect(X2).toBeGreaterThan(0);
    const s = createState();
    const { sent, wm, models } = decideOnce(f, OPTIONS, s);
    const to = (p: Player) =>
      sent.find((i) => i.type === "attack" && i.targetID === p.id());
    const snack = to(snackT);
    const launch = to(cheap);
    expect(snack).toBeDefined();
    expect(launch).toBeDefined();
    const info1 = wm.neighbors.get(snackT.smallID())!;
    expect(snack!.type === "attack" && snack!.troops).toBe(
      snackStack(models, wm.tiles, { ...info1, isTraitor: false }, OPTIONS) +
        Math.ceil(X1),
    );
    const info2 = wm.neighbors.get(cheap.smallID())!;
    const sz = tribeSizing(
      models,
      wm.tiles,
      { ...info2, isTraitor: false },
      models.regrowth(cheap),
      OPTIONS.tribeRatio,
      OPTIONS,
    );
    expect(launch!.type === "attack" && launch!.troops).toBe(
      Math.ceil(sz.S + X2),
    );
    for (const i of sent) submit(f, i);
    f.game.executeNextTick(); // init: both incoming attacks are cancelled
    expect(incoming(snackT)).toBe(0);
    expect(incoming(cheap)).toBe(0);
    // At least S is left: their attack ticked first in this turn and lost
    // troops taking our tiles, so it cancelled a little less than X.
    const ours = f.me.outgoingAttacks().find((a) => a.target() === cheap)!;
    expect(ours.troops()).toBeGreaterThanOrEqual(sz.S - 1);
    expect(ours.troops()).toBeLessThanOrEqual(sz.S + X2);
    f.game.executeNextTick(); // the snack's first tile
    expect(snackT.isAlive()).toBe(false);
  });
});

describe("apex allocator (§3.6): the live policy for 400 ticks", () => {
  test("no partial clamp, floors kept, one attack per tribe at a time", async () => {
    const { f, tribes } = await scene(100_000);
    // Regrowth for us, so the policy keeps spending.
    f.game.addExecution(new PlayerExecution(f.me));
    f.game.executeNextTick();
    const o = OPTIONS;
    const s = createState();
    const policy = new ApexPolicy(o, s);
    const h = new Harness(f, (ctx) => policy.tick(ctx));
    const byId = new Map<string, Player>();
    for (const p of tribes.values()) byId.set(p.id(), p);
    const cfg = f.game.config();
    let launches = 0;
    let stallLaunches = 0;
    let snacks = 0;
    let pokes = 0;
    for (let t = 0; t < 400; t++) {
      const home = f.me.troops();
      const cap = cfg.maxTroops(f.me);
      const attacking = new Set<string | null>();
      for (const a of f.me.outgoingAttacks()) {
        const tg = a.target();
        attacking.add(tg.isPlayer() ? tg.id() : null);
      }
      const logFrom = h.logs.length;
      const sent = h.step();
      const lines = h.logs.slice(logFrom).join("\n");
      const perTarget = new Map<string | null, number>();
      let spent = 0;
      for (const i of sent) {
        if (i.type !== "attack") continue;
        perTarget.set(i.targetID, (perTarget.get(i.targetID) ?? 0) + 1);
        spent += i.troops ?? 0;
        if (i.targetID === null) continue;
        const tribe = byId.get(i.targetID)!;
        if (attacking.has(i.targetID)) continue; // a top-up
        const D = tribe.troops();
        if (tribe.numTilesOwned() <= SNACK_TILES) {
          expect(lines).toContain(`snack ${i.targetID}`);
          snacks++;
          continue;
        }
        if (lines.includes(`poke ${i.targetID}`)) {
          expect(i.troops).toBe(o.pokeTroops);
          pokes++;
          continue;
        }
        // A launch carries its full clamp stack at its ratio.
        const stall = lines.includes(`stall-tribe ${i.targetID}`);
        if (!stall) expect(lines).toContain(`tribe ${i.targetID}`);
        const ratio = stall ? o.stallRatio : o.tribeRatio;
        if (stall) stallLaunches++;
        else launches++;
        expect(i.troops ?? 0).toBeGreaterThanOrEqual(
          (o.tribeMargin * D) / ratio - 1,
        );
      }
      // One attack per target per tick.
      for (const n of perTarget.values()) expect(n).toBe(1);
      // What is left at home: at least H_vw of the cap at the last
      // decision (the floors move with the cap between decisions).
      const left = Math.min(home, Math.ceil(cap)) - spent;
      expect(left).toBeGreaterThanOrEqual(o.vwGuard * cap * 0.97);
      // Never two of our attacks on one target.
      const seen = new Set<string | null>();
      for (const a of f.me.outgoingAttacks()) {
        const tg = a.target();
        const id = tg.isPlayer() ? tg.id() : null;
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect(snacks).toBe(1);
    expect(launches).toBeGreaterThan(0);
    // The field is small and our cap grows: it ends with land taken.
    expect(f.me.numTilesOwned()).toBeGreaterThan(US_COLS * H + 1000);
    expect(tribes.get("SNACK001")!.isAlive()).toBe(false);
    expect(tribes.get("CHEAP001")!.isAlive()).toBe(false);
    console.log(
      `launches ${launches}, stall launches ${stallLaunches}, snacks ${snacks}, pokes ${pokes}, tiles ${f.me.numTilesOwned()}, stall ${inStall(s, f.game.ticks(), o)}`,
    );
  });
});
