/**
 * Package WP4 (docs/14-m4-plan.md §2.5): the danger terms of the search's
 * value (lib/search/Danger.ts), hand-computed.
 *
 * For each unallied bordering nation N:
 *   S_N = min(T_N − r_N·M_N, T_N − ⌈0.9·H⌉), counted if S_N ≥ max(1, 0.2·H)
 *   p_N = attackLogic's attacker loss for N's first tile of us, on plains
 *   D_now = Σ S_N / p_N;  D_cap the same with T_N = M_N and H = C.
 *
 * The send rules are the nation AI's (AiAttackBehavior.ts: the land send
 * T − reserve·maxTroops, troopSendCap's ⌈0.9·H⌉ at Impossible, and
 * isAttackTooWeak's 0.2·H), pinned in NationSendCap.test.ts. p_N is written
 * out from Config.attackLogic (mag 80 on plains, ×0.5 for a traitor
 * defender, the ratio clamp [0.6, 2], the base 0.463 with the two
 * territory bonuses and the density 0.0039 per troop a tile) and checked
 * against Models.hit.
 *
 * Setting: the real Config (FFA, Singleplayer, Impossible) on an all-plains
 * 400 × 250 field (tests/agent/apex/Field.ts):
 *   us     x < 150, y < 200   30,000 tiles
 *   A      x ≥ 150, y < 200   50,000 tiles, a nation, unallied
 *   B      y ≥ 200            20,000 tiles, a nation, allied with us
 * A touches us on 200 pairs, B on 150. Troops are set by the test; nothing
 * runs.
 *
 * Cases: able to attack (the ⌈0.9·H⌉ cap binding, then the reserve), the
 * land line's edge, deterred, and traitor (p halves, D doubles). Also: the
 * ally never counts, D_cap is independent of T and H, the tile clamp, the
 * reserve replay from the gameID, the Hard and Easy send rules.
 */
import { createModels, Models } from "../../../src/agent/lib/Models";
import { nationParams } from "../../../src/agent/lib/NationModel";
import {
  createDangerModel,
  dangerTerms,
  DangerTerms,
  DEFAULT_RESERVE,
  nationSend,
  sendRules,
} from "../../../src/agent/lib/search/Danger";
import {
  Difficulty,
  Game,
  GameMode,
  Player,
  PlayerInfo,
  PlayerType,
  TerrainType,
} from "../../../src/core/game/Game";
import { field, Field, GAME_ID, own, rect } from "./Field";

const W = 400;
const HGT = 250;
const US_TILES = 150 * 200;
const A_TILES = 250 * 200;
const B_TILES = W * 50;
/** Contact pairs: our column x = 149 against A's x = 150; our row y = 199
 *  against B's y = 200. */
const A_CONTACT = 200;
const B_CONTACT = 150;
/** The reserve the tests give A (a nation's is 0.30-0.39). */
const R_A = 0.35;

/** attackLogic's attacker troop loss per tile on plains, written out
 *  (Config.ts attackLogic). */
function handPrice(
  attackerTiles: number,
  defenderTiles: number,
  defenderTroops: number,
  stack: number,
  traitor: boolean,
): number {
  const sigma = (n: number) =>
    1 / (1 + Math.exp(-2.5 * (Math.log(n) - Math.log(300_000))));
  const bA = 1 - 0.7 * sigma(attackerTiles);
  const bD = 1 - 0.3 * sigma(defenderTiles);
  const ratio = Math.min(Math.max(defenderTroops / stack, 0.6), 2);
  return (
    80 *
    (traitor ? 0.5 : 1) *
    ratio *
    (0.463 * bA * bD + 0.0039 * (defenderTroops / defenderTiles))
  );
}

/** The Impossible land send, written out; 0 when refused. */
function handSend(T: number, M: number, r: number, H: number): number {
  const S = Math.min(T - r * M, T - Math.ceil(0.9 * H));
  return S >= 1 && S >= 0.2 * H ? S : 0;
}

/** |a − b| / |b|. DetMath's exp and log are good to about 1e-8. */
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe("search danger terms (WP4)", () => {
  let f: Field;
  let game: Game;
  let me: Player;
  let A: Player;
  let B: Player;
  let models: Models;
  const reserveOf = (id: string) => (id === A.id() ? R_A : 0.3);
  const terms = (): DangerTerms => dangerTerms(game, me, models, reserveOf);
  /** Our traitor flag off again (PlayerImpl's public field). */
  const clearTraitor = () => {
    (me as unknown as { markedTraitorTick: number }).markedTraitorTick = -1;
  };

  beforeAll(async () => {
    f = await field({ width: W, height: HGT });
    game = f.game;
    me = f.me;
    own(me, rect(game, 0, 0, 150, 200));
    A = game.addPlayer(
      new PlayerInfo("nationA", PlayerType.Nation, null, "NATIONA1"),
    );
    own(A, rect(game, 150, 0, W, 200));
    B = game.addPlayer(
      new PlayerInfo("nationB", PlayerType.Nation, null, "NATIONB1"),
    );
    own(B, rect(game, 0, 200, W, HGT));
    me.createAllianceRequest(B)!.accept();
    models = createModels(game);
  }, 60_000);

  beforeEach(() => {
    clearTraitor();
    B.setTroops(50_000_000);
  });

  it("builds the field it describes", () => {
    expect(me.numTilesOwned()).toBe(US_TILES);
    expect(A.numTilesOwned()).toBe(A_TILES);
    expect(B.numTilesOwned()).toBe(B_TILES);
    expect(me.isAlliedWith(B)).toBe(true);
    expect(me.isAlliedWith(A)).toBe(false);
    expect(me.sharesBorderWith(A)).toBe(true);
    expect(me.sharesBorderWith(B)).toBe(true);
    // A nation holds 1.25x a human's cap at the same tiles (Impossible),
    // and A outgrows us: M_A ≥ 1.1·C, so D_cap is not 0 below.
    expect(models.cap(A)).toBeGreaterThan(1.1 * models.cap(me));
  });

  it("able to attack: S_N is T − ⌈0.9·H⌉ (the send cap binds) and p_N is attackLogic's first-tile loss", () => {
    const H = 1_000_000;
    const T = 3_000_000;
    me.setTroops(H);
    A.setTroops(T);
    const M = models.cap(A);
    const t = terms();

    // Only A counts: B is allied, however large.
    expect(t.rows.map((r) => r.id)).toEqual([A.id()]);
    const row = t.rows[0];
    expect(row.contact).toBe(A_CONTACT);
    expect([row.T, row.M, row.n, row.r]).toEqual([T, M, A_TILES, R_A]);

    // S: the land send T − r·M = 2.38M exceeds the cap T − ⌈0.9·H⌉ = 2.1M.
    expect(T - R_A * M).toBeGreaterThan(T - Math.ceil(0.9 * H));
    expect(row.sNow).toBe(2_100_000);
    expect(row.sNow).toBe(handSend(T, M, R_A, H));

    // p: H/S = 0.476 clamps to 0.6, so p = 48·(0.463·bA·bD + 0.0039·H/n).
    const p = handPrice(A_TILES, US_TILES, H, row.sNow, false);
    expect(rel(row.pNow, p)).toBeLessThan(1e-7);
    expect(row.pNow).toBe(
      models.hit(
        { type: PlayerType.Nation, tiles: A_TILES },
        {
          type: PlayerType.Human,
          tiles: US_TILES,
          troops: H,
          isTraitor: false,
        },
        row.sNow,
        TerrainType.Plains,
        A_CONTACT + 2,
      ).attackerTroopLoss,
    );
    expect(p).toBeCloseTo(28.27, 2);

    // D_now = S/p: A's one attack takes about 74k tiles, more than our 30k
    // (the plan's term is not capped; clampTiles caps it).
    expect(rel(t.now, row.sNow / p)).toBeLessThan(1e-7);
    expect(t.now).toBeGreaterThan(US_TILES);
    const clamped = dangerTerms(game, me, models, reserveOf, {
      clampTiles: true,
    });
    expect(clamped.now).toBe(US_TILES);

    // On an all-plains border the contact-terrain price is the plains one.
    const mix = dangerTerms(game, me, models, reserveOf, { terrain: "mix" });
    expect(rel(mix.now, t.now)).toBeLessThan(1e-12);
  });

  it("able to attack: with a low home the reserve binds, S_N = T − r·M", () => {
    const H = 100_000;
    const T = 3_000_000;
    me.setTroops(H);
    A.setTroops(T);
    const M = models.cap(A);
    const row = terms().rows[0];
    expect(row.sNow).toBeCloseTo(T - R_A * M, 6);
    expect(row.sNow).toBe(handSend(T, M, R_A, H));
    // H/S is far under 0.6: the clamp holds, the density term is 0.013.
    const p = handPrice(A_TILES, US_TILES, H, row.sNow, false);
    expect(rel(row.pNow, p)).toBeLessThan(1e-7);
    expect(rel(row.dNow, row.sNow / p)).toBeLessThan(1e-7);
  });

  it("the land line: counted at T − ⌈0.9·H⌉ = 0.2·H, not one troop below", () => {
    const H = 1_000_000;
    me.setTroops(H);
    A.setTroops(1_100_000);
    const at = terms().rows[0];
    expect(at.sNow).toBe(200_000);
    const p = handPrice(A_TILES, US_TILES, H, 200_000, false);
    // H/S = 5 clamps to 2 on the other side.
    expect(rel(at.pNow, p)).toBeLessThan(1e-7);
    expect(rel(at.dNow, 200_000 / p)).toBeLessThan(1e-7);

    A.setTroops(1_099_999);
    const below = terms().rows[0];
    expect(below.sNow).toBe(0);
    expect(below.dNow).toBe(0);
  });

  it("deterred: T − ⌈0.9·H⌉ < 0.2·H gives S_N = 0 and no D_now, while D_cap stays", () => {
    const H = 2_800_000;
    const T = 3_000_000;
    me.setTroops(H);
    A.setTroops(T);
    // 3.0M − 2.52M = 480k < 0.2·2.8M = 560k: refused as too weak.
    expect(T - Math.ceil(0.9 * H)).toBeLessThan(0.2 * H);
    expect(handSend(T, models.cap(A), R_A, H)).toBe(0);
    const t = terms();
    expect(t.rows[0].sNow).toBe(0);
    expect(t.rows[0].pNow).toBe(0);
    expect(t.now).toBe(0);

    // D_cap: both at their caps. C = 1.07M, M = 1.77M: the send cap binds,
    // S = M − ⌈0.9·C⌉ ≈ 810k ≥ 0.2·C, and C/S = 1.32 is inside the clamp.
    const C = models.cap(me);
    const M = models.cap(A);
    const sCap = handSend(M, M, R_A, C);
    expect(sCap).toBe(M - Math.ceil(0.9 * C));
    expect(sCap).toBeGreaterThan(0.2 * C);
    expect(C / sCap).toBeGreaterThan(0.6);
    expect(C / sCap).toBeLessThan(2);
    const pCap = handPrice(A_TILES, US_TILES, C, sCap, false);
    expect(rel(t.rows[0].sCap, sCap)).toBeLessThan(1e-12);
    expect(rel(t.rows[0].pCap, pCap)).toBeLessThan(1e-7);
    expect(rel(t.cap, sCap / pCap)).toBeLessThan(1e-7);
    expect(t.C).toBe(C);

    // D_cap reads caps only: the same at any T and H.
    A.setTroops(10);
    me.setTroops(10);
    expect(terms().cap).toBe(t.cap);
  });

  it("traitor: me.isTraitor() halves p_N (traitorDefenseDebuff) and doubles both terms", () => {
    const H = 1_000_000;
    me.setTroops(H);
    A.setTroops(3_000_000);
    const loyal = terms();
    me.markTraitor();
    expect(me.isTraitor()).toBe(true);
    const t = terms();
    expect(t.traitor).toBe(true);
    const row = t.rows[0];
    expect(row.sNow).toBe(loyal.rows[0].sNow);
    const p = handPrice(A_TILES, US_TILES, H, row.sNow, true);
    expect(rel(row.pNow, p)).toBeLessThan(1e-7);
    expect(row.pNow).toBe(loyal.rows[0].pNow / 2);
    expect(row.pNow).toBe(
      models.hit(
        { type: PlayerType.Nation, tiles: A_TILES },
        { type: PlayerType.Human, tiles: US_TILES, troops: H, isTraitor: true },
        row.sNow,
        TerrainType.Plains,
        A_CONTACT + 2,
      ).attackerTroopLoss,
    );
    expect(t.now).toBe(2 * loyal.now);
    expect(t.cap).toBe(2 * loyal.cap);
  });

  it("an ally never counts; the same nation counts once the alliance is gone", () => {
    me.setTroops(1_000_000);
    A.setTroops(0);
    B.setTroops(3_000_000);
    // A is listed but sends nothing (0 troops); B is not listed.
    expect(terms().rows.map((r) => r.id)).toEqual([A.id()]);
    expect(terms().now).toBe(0);
    const al = me.allianceWith(B)!;
    al.expire();
    try {
      expect(me.isAlliedWith(B)).toBe(false);
      const t = terms();
      const rowB = t.rows.find((r) => r.id === B.id())!;
      expect(rowB.contact).toBe(B_CONTACT);
      expect(rowB.r).toBe(0.3);
      expect(rowB.sNow).toBe(
        handSend(3_000_000, models.cap(B), 0.3, 1_000_000),
      );
      expect(rel(rowB.dNow, rowB.sNow / rowB.pNow)).toBeLessThan(1e-12);
    } finally {
      me.createAllianceRequest(B)!.accept();
    }
    expect(me.isAlliedWith(B)).toBe(true);
  });

  it("minContact leaves out a nation with fewer contact pairs", () => {
    me.setTroops(1_000_000);
    A.setTroops(3_000_000);
    const few = dangerTerms(game, me, models, reserveOf, {
      minContact: A_CONTACT + 1,
    });
    expect(few.rows).toEqual([]);
    expect(few.now).toBe(0);
  });

  it("createDangerModel replays the reserves from the gameID, else takes the worst case", () => {
    me.setTroops(1_000_000);
    A.setTroops(3_000_000);
    const r = nationParams(GAME_ID, A.id(), Difficulty.Impossible).reserve;
    const want = dangerTerms(game, me, models, (id) =>
      id === A.id() ? r : undefined,
    );
    expect(createDangerModel({ gameID: GAME_ID })(game, me)).toEqual({
      now: want.now,
      cap: want.cap,
    });
    const worst = dangerTerms(game, me, models, () => DEFAULT_RESERVE);
    expect(createDangerModel({ gameID: null })(game, me)).toEqual({
      now: worst.now,
      cap: worst.cap,
    });
    expect(createDangerModel({ reserveOf })(game, me)).toEqual({
      now: terms().now,
      cap: terms().cap,
    });
  });

  it("send rules: 0.9 and 0.2 at Impossible, 0.75 and 0.2 at Hard, none at Easy or in teams", () => {
    const stub = (difficulty: Difficulty, gameMode: GameMode) =>
      ({
        config: () => ({ gameConfig: () => ({ difficulty, gameMode }) }),
      }) as unknown as Game;
    expect(sendRules(game)).toEqual({ retain: 0.9, tooWeak: 0.2 });
    const hard = sendRules(stub(Difficulty.Hard, GameMode.FFA));
    expect(hard).toEqual({ retain: 0.75, tooWeak: 0.2 });
    const easy = sendRules(stub(Difficulty.Easy, GameMode.FFA));
    expect(easy).toEqual({ retain: null, tooWeak: 0 });
    expect(sendRules(stub(Difficulty.Impossible, GameMode.Team))).toEqual({
      retain: null,
      tooWeak: 0,
    });
    // Hard: 3M − ⌈0.75·1M⌉ = 2.25M; Easy: only the reserve binds, and a
    // send under 0.2·H is not refused.
    expect(nationSend(3e6, 2e6, 0.3, 1e6, hard)).toBe(2_250_000);
    expect(nationSend(3e6, 2e6, 0.3, 1e6, easy)).toBe(2_400_000);
    expect(nationSend(1e5, 2e5, 0.3, 1e6, easy)).toBe(40_000);
    expect(nationSend(1e5, 2e5, 0.3, 1e6, hard)).toBe(0);
    // Under one troop nothing is sent.
    expect(nationSend(0.5, 0, 0.3, 0, easy)).toBe(0);
  });
});
