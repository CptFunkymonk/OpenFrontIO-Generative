/**
 * Package WP3's test world: the WP1 directive tests' synthetic field
 * (tests/agent/apex/Directive.test.ts: 200x100 plains, the agent on x < 100,
 * nations with no nation AI), with each player's PlayerExecution running so
 * alliances expire, relations decay and troops regrow as in a game, and a
 * LiveSearch that hands the test the SearchHost of every live tick.
 */
import { AgentContext, AgentIntent } from "../../../src/agent/Agent";
import {
  ApexOptions,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import {
  ApexPolicy,
  LiveSearch,
  SearchHost,
} from "../../../src/agent/agents/apex/policy";
import { ApexState, createState } from "../../../src/agent/agents/apex/state";
import type {
  BaseView,
  SearchView,
} from "../../../src/agent/lib/search/Registry";
import { Config } from "../../../src/core/configuration/Config";
import { Executor } from "../../../src/core/execution/ExecutionManager";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import {
  Cell,
  Game,
  Nation,
  Player,
  PlayerInfo,
  PlayerType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import {
  AGENT_CLIENT,
  AGENT_ID,
  Field,
  GAME_CONFIG,
  GAME_ID,
  Harness,
} from "./Field";

export const W = 200;
export const H = 100;
const LAND = 0x80 | 5;

export interface NationSpec {
  id: string;
  /** [x0, y0, x1, y1): its tiles. */
  rect: readonly [number, number, number, number];
  troops: number;
}

/** A (5,000 tiles, bordering us) and B (beyond A), as the directive tests'
 *  A and C. */
export const NATIONS: readonly NationSpec[] = [
  { id: "NATIONAA", rect: [100, 0, 150, H], troops: 100_000 },
  { id: "NATIONCC", rect: [150, 0, 200, H], troops: 80_000 },
];

/** The LiveSearch of the world: the host and context of the last tick. */
export class HostProbe implements LiveSearch {
  host: SearchHost | null = null;
  ctx: AgentContext | null = null;
  onTick: ((ctx: AgentContext, host: SearchHost) => void) | null = null;

  tick(ctx: AgentContext, host: SearchHost): void {
    this.host = host;
    this.ctx = ctx;
    this.onTick?.(ctx, host);
  }
}

export interface World {
  game: Game;
  us: Player;
  s: ApexState;
  policy: ApexPolicy;
  h: Harness;
  probe: HostProbe;
  nation(id: string): Player;
  /** Every intent the policy sent, with its tick. */
  sent(): { tick: number; intent: AgentIntent }[];
}

export function world(
  options: Record<string, unknown> = {},
  o2: { allianceMinutes?: number; nations?: readonly NationSpec[] } = {},
): World {
  const specs = o2.nations ?? NATIONS;
  const t = new Uint8Array(W * H).fill(LAND);
  const m = new Uint8Array((W / 2) * (H / 2)).fill(LAND);
  const map = new GameMapImpl(W, H, t, W * H);
  const mini = new GameMapImpl(W / 2, H / 2, m, (W * H) / 4);
  const config = new Config(
    o2.allianceMinutes === undefined
      ? GAME_CONFIG
      : { ...GAME_CONFIG, customAllianceDuration: o2.allianceMinutes },
    null,
    false,
  );
  const nations = specs.map(
    (n, i) =>
      new Nation(
        new Cell(n.rect[0], i),
        new PlayerInfo(n.id.toLowerCase(), PlayerType.Nation, null, n.id),
      ),
  );
  const game = createGame(
    [new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT, AGENT_ID)],
    nations,
    map,
    mini,
    config,
  );
  game.endSpawnPhase();
  const us = game.player(AGENT_ID);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < 100; x++) us.conquer(game.ref(x, y));
  }
  for (const n of specs) {
    const p = game.player(n.id);
    const [x0, y0, x1, y1] = n.rect;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) p.conquer(game.ref(x, y));
    }
    p.setTroops(n.troops);
  }
  us.setTroops(400_000);
  // Alliances expire, relations decay and troops regrow in PlayerExecution.
  for (const p of [us, ...specs.map((n) => game.player(n.id))]) {
    game.addExecution(new PlayerExecution(p));
  }
  const f: Field = {
    game,
    config,
    me: us,
    executor: new Executor(game, GAME_ID, undefined),
  };
  const o = parseApexOptions({
    expansion: false,
    boats: false,
    economy: false,
    strike: false,
    endgame: false,
    web: false,
    extensions: false,
    spawnMode: "plan",
    ...options,
  });
  const s = createState();
  const probe = new HostProbe();
  const policy = new ApexPolicy(o, s, probe);
  const h = new Harness(f, (ctx) => policy.tick(ctx));
  return {
    game,
    us,
    s,
    policy,
    h,
    probe,
    nation: (id) => game.player(id),
    sent: () => h.sentLog,
  };
}

/** The SearchView a search would build at this live tick (after the
 *  probe saw it), with `o` over the world's options. */
export function liveView(
  w: World,
  o: Record<string, unknown> = {},
): SearchView {
  const host = w.probe.host!;
  const ctx = w.probe.ctx!;
  const opts = { ...host.o, ...o } as ApexOptions;
  return {
    ctx,
    host,
    o: opts,
    t: ctx.tick,
    game: w.game,
    me: w.us,
    wm: host.wm()!,
    floors: host.floors(),
    kinds: new Set(opts.searchKinds.split(",")),
  } as SearchView;
}

/** A base with no attacker (round 1's view before the base's attackers
 *  matter). */
export const NO_BASE: BaseView = { h: 150, attackers: new Map(), snaps: [] };
