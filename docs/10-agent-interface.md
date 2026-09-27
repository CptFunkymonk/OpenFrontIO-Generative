# 10 — Interfacing an AI with the game

How an AI agent observes and plays OpenFront in this fork, why it is built
this way, and the loop for making the agent stronger. Code: `src/agent/`.

## 10.1 Why not a userscript

A Tampermonkey script can only run on the page's **main thread**. That is
the thread that renders the map (WebGL), runs the HUD (Lit), applies every
tick's updates to the `GameView`, and handles input. The simulation itself
lives in a Web Worker the script cannot reach, so a script sees only the
`GameView` projection and acts by faking clicks. Every millisecond it spends
thinking is a millisecond the renderer does not get: a script that does real
analysis per tick (a 2000×1000 map is 2M tiles) blocks frames, delays the
worker's update batches and the game stutters. The bigger and smarter the
script, the worse it gets. The problem is where the script runs, so no
amount of optimisation inside it will fix it.

This fork owns the source, so the agent does not have to live there.

## 10.2 The design: one agent, two hosts

The game is **deterministic lockstep**: the server only relays intents; every
client runs an identical simulation (`src/core`) from the same turns. So
anything that receives the turns can hold a perfect copy of the game, with
the full `Game` API rather than the view.

```
                       ┌──────────────────────────────────────────┐
  Agent (src/agent)    │ tick(ctx): read ctx.game, ctx.send(intent) │
                       └──────────────┬───────────────────────────┘
                                      │ same code
               ┌──────────────────────┴───────────────────────┐
     Headless arena (Node)                      Browser autopilot (Web Worker)
     npm run arena                              ?agent=baseline
     authoritative GameRunner, no rendering     own replica GameRunner, fed the
     ~240–1,500 ticks/s per core                same turns as the real game
     latency + server rate limits modelled      intents → Transport, like clicks
```

|                  | Userscript            | Arena                  | Browser autopilot            |
| ---------------- | --------------------- | ---------------------- | ---------------------------- |
| Thread           | page main thread      | own process per game   | own Web Worker               |
| Sees             | `GameView` projection | full `Game`            | full `Game` (replica)        |
| Acts by          | synthetic clicks      | intents                | intents                      |
| Cost to the game | every ms of thinking  | none (no game to slow) | forwarding turns and intents |
| Speed            | real time             | 24–150× real time      | real time                    |
| Lookahead        | no                    | `ctx.fork()`           | `ctx.fork()`                 |

The agent can think for a whole second in the browser and the game keeps
rendering at full speed: its replica just falls behind and catches up.

### What the agent may do

The agent is a **player**, not part of the simulation:

- **Observe everything.** There is no fog of war; every client holds the whole
  state, so reading it is fair play.
- **Act only through intents**: the same `Intent` objects a human's clicks
  produce (`AgentIntent`, see `07-action-api.md`), validated against the wire
  schema, subject to the server's limits (10/s, 150/min) and to latency
  (default 1 turn, as in singleplayer). Nations act directly inside the sim
  with zero latency; the agent never can.
- **Never mutate `ctx.game`** or anything reachable from it (`conquer`,
  `addGold`, `setTroops`, `buildUnit`, `addExecution`, `toUpdate`, …). In the
  browser a mutation desyncs the replica from the real game (detected via
  hashes; the autopilot stops); in the arena it would change the outcome in a
  way no real player could. `npm run arena -- --isolate` gives each agent its
  own replica and aborts the game the moment a replica's hash diverges. Run it
  before trusting a new agent.

## 10.3 Writing an agent

```ts
import { Agent, AgentContext } from "../Agent";

export class MyAgent implements Agent {
  readonly name = "mine";
  tick(ctx: AgentContext): void {
    const { game, me } = ctx;
    if (game.inSpawnPhase()) {
      /* ctx.send({ type: "spawn", tile }) */ return;
    }
    // me.troops(), game.config().maxTroops(me), me.borderTiles(), game.owner(t), …
    ctx.send({ type: "attack", targetID: null, troops: me.troops() / 3 });
  }
}
```

Register it in `src/agent/agents/index.ts` (`AGENTS`), then it runs in both
hosts by name. Options arrive as parsed JSON, so parameters can be swept
without code changes.

| `ctx` member   | What it is                                                            |
| -------------- | --------------------------------------------------------------------- |
| `game`         | the live `Game` (read-only by contract)                               |
| `me`           | this agent's `Player`, present before spawning                        |
| `tick`         | `game.ticks()`; may skip values in the browser (batched catch-up)     |
| `random`       | `PseudoRandom` seeded per game and seat: arena runs reproduce exactly |
| `send(intent)` | `"ok"` or why not: `"rate_limited"`, `"invalid"`, `"game_over"`       |
| `budget()`     | intents left this second / this minute                                |
| `fork()`       | independent copy of the game for lookahead (§10.6)                    |
| `log(msg)`     | per-game log; the arena writes it to `games/gameNNN.log`              |

Reusable read-only helpers live in `src/agent/lib/`: `scanBorder` (free
frontier, neighbours with contact counts, ocean-shore port sites),
`planSpawn` (coarse-grid spawn scoring), `pickInteriorTile`, `landShare`,
`unitCost`, `maxTroops`. `BaselineAgent` shows them in use.

**Pace by elapsed ticks, not `tick % n`.** The browser calls the agent once
per batch when the replica catches up, so tick numbers can jump.

## 10.4 The arena

```bash
npm run arena -- --help
npm run arena -- --games 16 # baseline vs Impossible nations, random maps
npm run arena -- --agent baseline --agent 'baseline:{"attackRatio":0.7}' --games 32
npm run arena -- --maps Europe,World --images --image-every 5
npm run arena -- --isolate --games 4 # prove the agent is read-only
```

Defaults mirror the solo mode against the strongest AI: FFA, **Impossible
nations** (all the map's nations), 400 tribes, normal map size, 1 turn of
latency, the server's rate limits, a 60 game-minute cap. The map pool is every
map that has nations (nationless maps only measure play against tribes).
Each game is deterministic in its spec: the same `--seed` replays the same
games bit for bit, so a single bad game can be reproduced and debugged.

Several `--agent` entrants play **the same games** (same maps, same game IDs),
which pairs the comparison and cuts variance. `--together` seats all entrants
in one game instead (Private game type, 200-tick spawn phase), for self-play.

Output directory (default `arena-results/<seed>-<time>/`, git-ignored):

| File                   | Contents                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `summary.md`           | table per entrant: wins, win rate with 95% Wilson interval, progress, land, placement                                                                                   |
| `summary.json`         | the same plus one compact row per game                                                                                                                                  |
| `games/gameNNN.json`   | full result: per-seat timeline (tiles, share, troops, cap, gold every 30 s), top-3 leaders over time, intent counts by type, think-time percentiles, first agent errors |
| `games/gameNNN.log`    | the agent's `ctx.log` lines                                                                                                                                             |
| `images/gameNNN-*.png` | territory maps (`--images`): agent magenta, nations hashed colours, tribes grey                                                                                         |

`progress` is 1 for a win, otherwise peak land share ÷ 0.8 (the win
threshold): a shaped signal that still moves while the agent is losing every
game. Placement counts humans and nations only.

Measured on this container (4 cores): Iceland with 10 tribes runs at
~1,500 ticks/s; the World map with 400 tribes and 72 Impossible nations at
~240 ticks/s (24× real time). Eight full-strength games took 2 minutes of wall
time with 4 in parallel.

## 10.5 The browser autopilot

Open the client with `?agent=<name>` (and optionally
`&agentOptions=<url-encoded JSON>`, `&agentRateLimit=off`), start a
singleplayer game, and do not click: the agent spawns and plays as you. The
choice sticks for the tab (sessionStorage); `?agent=off` clears it.

`src/client/AgentAutopilot.ts` starts `src/agent/browser/AgentWorker.worker.ts`
after the game worker initialises. `ClientGameRunner` forwards each turn to both
workers and each game hash to the autopilot. The worker runs a replica
`GameRunner`, calls the agent once per batch of new ticks, and posts intents
back. They are emitted as `SendAgentIntentEvent` and leave through
`Transport.sendIntent`, exactly like a click's. The worker compares its
replica's hashes with the real game's and stops the agent on any divergence.
Console output is prefixed `[agent]`.

To watch it headless: `node .claude/skills/run-openfront/autopilot.mjs
baseline Iceland 90` (dev server up) writes screenshots and a state trace to
`/tmp/openfront-run/`. Verified here: the agent spawned unaided within the
first second and held 16k tiles a minute in, its replica never behind by even
one turn.

The apex search (`apex:{"search":true}`) blocks the tick it runs in for
seconds to minutes; in the browser the worker's replica would fall behind the
live game by as many ticks. There the search is time-sliced:
`"searchSliceMs":30` spends at most 30 ms of wall time per live tick on it
and acts when its rounds finish (the log's `k=` ticks later, the plan
re-based to that tick; `lib/search/Slicer.ts`). The arena leaves it 0: its
clock is game time, and only the unsliced search replays. A search's forks
(0.1-0.7 s each, one per rollout) cannot be sliced, so the worst tick is a
fork, not the slice.

The same worker would also work in multiplayer against a real server (turns
arrive over the socket instead of from `LocalServer`), subject to the same
10/s, 150/min limits the arena enforces.

## 10.6 Lookahead: `ctx.fork()`

`fork()` snapshots the game and restores it onto fresh maps: a completely
independent simulation. Step it with hypothetical intents and read the result:

```ts
const sim = ctx.fork();
sim.step([{ type: "attack", targetID: rival.id(), troops: 200_000 }]);
sim.advance(150); // 15 s ahead, everyone else's AI included
const gain =
  sim.game.playerByClientID(ctx.clientID)!.numTilesOwned() - me.numTilesOwned();
```

Nations, tribes, and everything already in motion keep acting in the fork
(they are part of the simulation); other humans' future intents are
unknowable. Cost on the World map at tick 3,000 (55 players, 369 units):
snapshot 2.1 MB in ~110 ms, fork ~290 ms, 100 simulated ticks ~400 ms. Use it
for deliberate decisions every few seconds of game time, not every tick.

## 10.7 The improvement loop

1. Change or add an agent in `src/agent/agents/`.
2. `npx vitest run tests/agent` (fast) and `npm run arena -- --isolate --games 2`.
3. `npm run arena -- --agent old --agent new --games 32 --seed <fixed>`: same
   games for both; compare win rate, progress, placement.
4. Read the losses: `games/gameNNN.json` timelines (when did land peak, who
   led), `.log` (what the agent decided), `--images --image-every 5` (what the
   map looked like).
5. Keep what wins; widen `--games` before trusting small differences (the 95%
   intervals in `summary.md` say how much the result can still move).

The baseline (`src/agent/agents/BaselineAgent.ts`) is a readable starting
point, not a strong player. Against Impossible nations it spawns well and
grabs land early, then stalls: it hoards troops at the cap instead of using
them, and it attacks only when it outnumbers a neighbour by 1.3×. Chapters 02,
03, 06 and 09 describe the mechanics and the nations' decision tree that a
stronger agent should exploit.
