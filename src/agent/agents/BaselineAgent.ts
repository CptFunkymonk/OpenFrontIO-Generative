import { GameType, Player, PlayerType, UnitType } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { Agent, AgentContext } from "../Agent";
import {
  BorderScan,
  isBot,
  maxTroops,
  pickInteriorTile,
  scanBorder,
  unitCost,
} from "../lib/Perception";
import { planSpawn } from "../lib/SpawnPlanner";

export interface BaselineOptions {
  /** Ticks between decisions (10 ticks = 1 s). */
  thinkEvery: number;
  /** Ticks to wait in singleplayer before spawning, so everyone is placed. */
  spawnDelay: number;
  /** Start a free-land attack once troops exceed this share of the cap. */
  expandTrigger: number;
  /** Troops kept home (share of the cap) when expanding. */
  expandReserve: number;
  /** Minimum troops (share of the cap) before attacking a player. */
  attackTrigger: number;
  /** Share of troops committed to an attack on a player. */
  attackRatio: number;
  /** Our committed troops must exceed the target's troops by this factor. */
  attackAdvantage: number;
  /** Ask bordering nations for alliances until this many ticks after spawn. */
  allianceWindow: number;
  /** Territory per city before building another city instead of upgrading. */
  tilesPerCity: number;
}

export const BASELINE_DEFAULTS: BaselineOptions = {
  thinkEvery: 5,
  spawnDelay: 3,
  expandTrigger: 0.35,
  expandReserve: 0.2,
  attackTrigger: 0.55,
  attackRatio: 0.5,
  attackAdvantage: 1.3,
  allianceWindow: 600,
  tilesPerCity: 4000,
};

/**
 * A deliberately simple, readable starting point: spawn on open land near
 * the coast away from nations, grab free land continuously, buy a port then
 * cities, attack the softest neighbour, and ally with stronger neighbours
 * early. Tune or replace it; the arena will tell you whether you improved.
 */
export class BaselineAgent implements Agent {
  readonly name = "baseline";
  private readonly o: BaselineOptions;
  private spawnSentAt: number | null = null;
  private spawnEndTick: number | null = null;
  private lastThink = -Infinity;

  constructor(options: Partial<BaselineOptions> = {}) {
    this.o = { ...BASELINE_DEFAULTS, ...options };
  }

  get options(): Readonly<Record<string, unknown>> {
    return { ...this.o };
  }

  tick(ctx: AgentContext): void {
    const { game, me } = ctx;
    if (game.inSpawnPhase()) {
      this.spawn(ctx);
      return;
    }
    this.spawnEndTick ??= ctx.tick;
    // Ticks can arrive in batches (see Agent.tick), so pace by elapsed time.
    if (!me.isAlive() || ctx.tick - this.lastThink < this.o.thinkEvery) return;
    this.lastThink = ctx.tick;

    const scan = scanBorder(game, me);
    this.diplomacy(ctx, scan);
    this.economy(ctx, scan);
    this.military(ctx, scan);
  }

  // ── Spawn ────────────────────────────────────────────────────────────

  private spawn(ctx: AgentContext): void {
    const { game, me } = ctx;
    const config = game.config();
    // Singleplayer ends the spawn phase the moment we spawn, so go as soon
    // as the others are placed. Otherwise wait for the nations to settle.
    const spawnAt =
      config.gameConfig().gameType === GameType.Singleplayer
        ? this.o.spawnDelay
        : config.numSpawnPhaseTurns() - 30;
    if (ctx.tick < spawnAt) return;
    // Resend only if the last attempt clearly failed to land.
    if (
      this.spawnSentAt !== null &&
      (me.hasSpawned() || ctx.tick - this.spawnSentAt < 10)
    ) {
      return;
    }
    const tile = planSpawn(game, me);
    if (tile === null) {
      ctx.log("no spawnable tile found");
      return;
    }
    if (ctx.send({ type: "spawn", tile }) === "ok") {
      this.spawnSentAt = ctx.tick;
      ctx.log(`spawn at ${game.x(tile)},${game.y(tile)}`);
    }
  }

  // ── Diplomacy ────────────────────────────────────────────────────────

  private diplomacy(ctx: AgentContext, scan: BorderScan): void {
    const { me } = ctx;
    // Accept (by counter-request) alliances from anyone who could hurt us.
    for (const req of me.incomingAllianceRequests()) {
      const from = req.requestor();
      if (
        from.troops() >= me.troops() * 0.8 &&
        me.canSendAllianceRequest(from)
      ) {
        if (
          ctx.send({ type: "allianceRequest", recipient: from.id() }) === "ok"
        ) {
          ctx.log(`accept alliance from ${from.name()}`);
        }
        return;
      }
    }
    for (const ally of me.allies()) {
      if (me.allianceInfo(ally)?.canExtend) {
        ctx.send({ type: "allianceExtension", recipient: ally.id() });
        return;
      }
    }
    // Early on, nations accept most requests: neutralise strong neighbours.
    if (ctx.tick - (this.spawnEndTick ?? 0) > this.o.allianceWindow) return;
    const strongest = [...scan.neighbors.values()]
      .map((n) => n.player)
      .filter(
        (p) =>
          p.type() === PlayerType.Nation &&
          p.troops() > me.troops() &&
          me.canSendAllianceRequest(p),
      )
      .sort((a, b) => b.troops() - a.troops())[0];
    if (strongest !== undefined) {
      if (
        ctx.send({ type: "allianceRequest", recipient: strongest.id() }) ===
        "ok"
      ) {
        ctx.log(`request alliance with ${strongest.name()}`);
      }
    }
  }

  // ── Economy ──────────────────────────────────────────────────────────

  private economy(ctx: AgentContext, scan: BorderScan): void {
    const { game, me } = ctx;
    const gold = me.gold();

    if (me.unitCount(UnitType.Port) === 0 && scan.oceanShore.length > 0) {
      if (gold < unitCost(game, me, UnitType.Port)) return; // save for it
      const tile = scan.oceanShore.find(
        (t) => me.canBuild(UnitType.Port, t) !== false,
      );
      if (tile !== undefined) {
        this.build(ctx, UnitType.Port, tile);
        return;
      }
    }

    if (gold < unitCost(game, me, UnitType.City)) return;
    const cities = me.units(UnitType.City);
    const wanted = 1 + Math.floor(me.numTilesOwned() / this.o.tilesPerCity);
    if (cities.length > 0 && cities.length >= wanted) {
      const target = cities
        .filter((c) => !c.isUnderConstruction() && me.canUpgradeUnit(c))
        .sort((a, b) => a.level() - b.level())[0];
      if (target !== undefined) {
        ctx.send({
          type: "upgrade_structure",
          unit: UnitType.City,
          unitId: target.id(),
        });
        return;
      }
    }
    const tile = pickInteriorTile(
      game,
      me,
      ctx.random,
      (t) => me.canBuild(UnitType.City, t) !== false,
    );
    if (tile !== null) this.build(ctx, UnitType.City, tile);
  }

  private build(ctx: AgentContext, unit: UnitType, tile: TileRef): void {
    if (ctx.send({ type: "build_unit", unit, tile }) === "ok") {
      ctx.log(`build ${unit} at ${ctx.game.x(tile)},${ctx.game.y(tile)}`);
    }
  }

  // ── Military ─────────────────────────────────────────────────────────

  private military(ctx: AgentContext, scan: BorderScan): void {
    const { game, me } = ctx;
    const cap = maxTroops(game, me);
    const troops = me.troops();

    if (scan.freeFrontier > 0) {
      if (troops > cap * this.o.expandTrigger) {
        const amount = troops - cap * this.o.expandReserve;
        ctx.send({ type: "attack", targetID: null, troops: amount });
      }
      return;
    }

    if (troops < cap * this.o.attackTrigger) return;
    const commit = troops * this.o.attackRatio;
    const target = this.pickTarget(ctx, scan, commit);
    if (target !== null) {
      if (
        ctx.send({ type: "attack", targetID: target.id(), troops: commit }) ===
        "ok"
      ) {
        ctx.log(
          `attack ${target.name()} (${Math.round(target.troops())}) with ${Math.round(commit)}`,
        );
      }
      return;
    }
    if (scan.neighbors.size === 0) this.boat(ctx, commit);
  }

  /** The softest neighbour we clearly outgun, bots first. */
  private pickTarget(
    ctx: AgentContext,
    scan: BorderScan,
    commit: number,
  ): Player | null {
    const { me } = ctx;
    let best: Player | null = null;
    let bestScore = -Infinity;
    for (const { player, contact } of scan.neighbors.values()) {
      if (!me.canAttackPlayer(player)) continue;
      if (player.troops() * this.o.attackAdvantage > commit) continue;
      // Wide contact is fast conquest; low troops per tile is cheap conquest.
      const density = player.troops() / Math.max(1, player.numTilesOwned());
      const score = ((isBot(player) ? 2 : 1) * contact) / (1 + density);
      if (score > bestScore) {
        bestScore = score;
        best = player;
      }
    }
    return best;
  }

  /** Nothing borders us by land: ship troops to the nearest foreign coast. */
  private boat(ctx: AgentContext, troops: number): void {
    const { game, me } = ctx;
    const origin = me.spawnTile();
    if (origin === undefined) return;
    let best: TileRef | null = null;
    let bestDist = Infinity;
    const step = Math.max(
      2,
      Math.floor(Math.sqrt(game.width() * game.height()) / 200),
    );
    for (let y = 0; y < game.height(); y += step) {
      for (let x = 0; x < game.width(); x += step) {
        const t = game.ref(x, y);
        if (!game.isOceanShore(t) || game.ownerID(t) === me.smallID()) continue;
        const owner = game.owner(t);
        if (owner.isPlayer() && !me.canAttackPlayer(owner)) continue;
        const d = game.manhattanDist(origin, t);
        if (d < bestDist) {
          bestDist = d;
          best = t;
        }
      }
    }
    if (
      best !== null &&
      ctx.send({ type: "boat", troops, dst: best }) === "ok"
    ) {
      ctx.log(`boat to ${game.x(best)},${game.y(best)}`);
    }
  }
}
