# 16. Playing with apex

A guide for a person at their own machine: how to watch the `apex` bot
(`src/agent/agents/apex/`) play in the real browser client, how to play beside
it and against it, how to watch its reasoning, and how to look at arena games
as pictures. Everything here was either **executed** in a cloud container on
2026-09-27 (marked `[ran]`, with the evidence named in §16.9) or **read in the
code** (marked `[code]`, with the file). Nothing is from memory.

The mechanism is the browser autopilot of chapter 10 §10.5: open the client
with `?agent=<name>` and the agent plays your seat from its own Web Worker,
sending the same intents a click would. Its output goes to the browser console
under the prefix `[agent]`.

## 16.1 Setup

You need Node 24 and npm 12 (`engines` in `package.json`; README
"Prerequisites"). Then, from the repository root:

```bash
npm run inst # npm ci --ignore-scripts. Never npm install.
npm run dev  # client (Vite) + game server, with hot reload
```

`npm run dev` prints, among the server's JSON log lines, Vite's

```
➜  Local:   http://localhost:9000/
```

**The game is on port 9000** (`vite.config.ts`, `port: 9000`), not Vite's
usual 5173. `[ran]` Open that URL in Chrome, Edge or Firefox; the client needs
WebGL 2 with a real GPU (it refuses software rendering,
`src/client/render/gl/initGL.ts` `[code]`). The server log will repeat
`Error polling ... lobby: fetch failed` with `ECONNREFUSED 127.0.0.1:8787`:
that is the closed-source API not running in dev, and it is harmless for
everything in this guide `[ran]`. On the home page the console shows a
handful of `Failed to fetch` errors for cosmetics, news and the server list
for the same reason `[ran]`.

## 16.2 Watch apex play your seat (singleplayer)

1. Open **`http://localhost:9000/?agent=apex`**.
2. Click **Solo**. Pick a map and difficulty (the arena's opponents are
   **Impossible** nations; the headless watcher below uses 100 bots at
   Impossible). Click **Start**.
3. **Do not click the map.** Within the first second of the game apex
   spawns, and the spawn phase ends at once (in singleplayer it ends as soon
   as your seat spawns, `[ran]`: `spawnPhase=false` at tick 8). Then it
   expands, eats the tribes around it, and plays on. Your seat carries your
   normal username; the leaderboard, troop bar and event toasts
   ("Conquered Mossi Clan, received 100 gold") are all yours `[ran]`.

What you get in the console (F12 → Console; filter on `[agent]`) `[ran]`:

```
[agent] starting autopilot "apex"
[agent] ready
[agent] [4] spawn plan (race): 66 candidates best snack A 12998 B 21501 threat 1 score 18425
[agent] [4] spawn (race) at 374,623, candidate 1/66
[agent] [7] status t=7 tiles=52 home=25k cap=121k H=36k tn=21k vw=21k free=29 tribes=1 nations=0 plans={} stall=- refresh=4
[agent] [43] 43 tn 5970 A=759 want=19120 F=84
[agent] [58] 58 dip plan slots=8/7/7 allied=0 pending=0 reach=4 allySet=4 food=0 H+=93k top=[Colombia:2.59,Brazil:2.57,...]
```

The number in brackets is the game tick (10 per second). §16.3 says how to
read these lines and how to see the ones the console hides by default.

Controls that still work while it plays `[code]`:

- **`.` speeds the game up, `,` slows it down, `P` pauses** (default key
  binds `gameSpeedUp: "Period"`, `gameSpeedDown: "Comma"`, `pauseGame:
"KeyP"` in `src/core/game/UserSettings.ts:54-56`; the singleplayer
  server applies them, `src/client/LocalServer.ts:116-134`, four steps: slow,
  normal, fast, fastest). The agent is paced by game ticks, not wall time, so
  it plays the same game faster or slower. Not tested in this container
  (headless), read in the code.
- Pan and zoom as usual. Clicking the map also still works: see §16.4a.

**To take your seat back**, open `http://localhost:9000/?agent=off` (or
`?agent=`) in that tab. The choice is stored per tab in `sessionStorage`
under `openfront.autopilot` (`src/client/AgentAutopilot.ts:20-46`), which is
why it survives the client rewriting the URL and why a plain reload keeps the
bot. A new tab starts clean; a _duplicated_ tab copies the session storage
and keeps the bot.

The autopilot never starts on a replay or as a spectator
(`src/client/ClientGameRunner.ts:705-710` `[code]`), so it cannot be used to
replay a recorded game with a different brain.

If a tutorial box ("Step 3 of 22") sits in the bottom middle of the screen,
that is the client's first-game tutorial for a fresh profile, not the bot;
click Skip `[ran]` (visible in the evidence screenshots).

## 16.3 Watching it think

Every line apex logs arrives as `console.log("[agent] " + line)`; the worker's
own bookkeeping arrives as `console.debug`, which Chrome hides until you set
the console's level dropdown ("Default levels") to include **Verbose**
(`src/client/AgentAutopilot.ts:152-158` `[code]`). The kinds of lines:

| Line                                                                                                        | Meaning                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starting autopilot "apex"`, `ready`                                                                        | Worker loaded, replica of the game built, agent constructed.                                                                                                                                                                                                                                |
| `[t] spawn plan (race): …`, `[t] spawn (race) at x,y`                                                       | The spawn search: candidates scored (snack = tribes to eat, threat = nations nearby), and the tile it chose.                                                                                                                                                                                |
| `[t] status t=… tiles=… home=… cap=… tribes=… nations=… plans={…}`                                          | Periodic self-report: land, troops at home, troop cap, tribes and nations in contact, plans in flight.                                                                                                                                                                                      |
| `[t] tn …`, `[t] snack …`, `[t] dip plan …`                                                                 | An expansion order, a tribe being eaten, the diplomacy plan (alliance slots and who it courts).                                                                                                                                                                                             |
| `tick N, behind B, sent S, rate-limited R, last think T ms, errors E`                                       | _(Verbose)_ every few hundred ticks: `behind` is how many turns the replica still has to catch up (0 is healthy), `sent` intents so far, how many the client-side rate limit held back, the last decision's cost. `[ran]`: `behind 0 … last think 746.8 ms` at tick 4, `0.2 ms` at tick 54. |
| `game over for the agent: …`                                                                                | Your seat won or died; the agent stops.                                                                                                                                                                                                                                                     |
| `stopped: replica diverged from the real game at tick N; the agent stopped (did it mutate the game state?)` | The worker's replica and the real game produced different hashes. The agent is stopped and your seat goes idle. This never happened in the runs here; if you see it, it is a bug worth an issue (`src/agent/browser/AgentWorker.worker.ts:81-95` `[code]`).                                 |

**Options.** Add `&agentOptions=<url-encoded JSON>` to hand apex any key of
`src/agent/agents/apex/options.ts` (`AGENTS` in `src/agent/agents/index.ts`
parses it). A key apex does not have makes the worker throw at start and the
console shows `[agent] stopped: apex has no option "…" (it has …)`
(`index.ts:createAgent` `[code]`). Keys a viewer may want:

- `thinkEvery` (default 3): ticks between decisions. `{"thinkEvery":10}`
  makes it visibly more deliberate and cheaper; `1` is the most reactive.
  URL: `http://localhost:9000/?agent=apex&agentOptions=%7B%22thinkEvery%22%3A10%7D`
- `spawnMode` (default `"race"`): `"plan"` is the plain scored spawn (no
  race field), the cheapest spawn.
- `forkMsPer10s` (default 1000): the lookahead budget in ms per 10 s of game
  time. Lower it if the tab feels heavy; `0` disables lookahead.
- `&agentRateLimit=off` (separate parameter, not an option) lifts the
  client-side 10/s, 150/min intent limit the arena enforces (§10.5). Leave
  it on to see what the arena sees.
- **Do not set `"search": true`.** That is the exact midgame search
  (`SearchController`), built for the headless arena: a search "blocks its
  live tick for seconds to minutes, so it stays arena-only until it is
  time-sliced" (`options.ts`, the comment above `search` `[code]`). In the
  browser it would freeze the agent worker for that long, the replica would
  fall behind by hundreds of turns, and the page would appear hung.

None of the options change the game's speed; use the `.`/`,` keys for that.

The other agents registered beside `apex` are `baseline` (the first, simple
agent) and `idle` (spawns and does nothing): `?agent=baseline` and
`?agent=idle` work the same way `[code]`.

## 16.4 Playing with it

### a. Beside it, in one seat

While the autopilot runs, your own clicks still go through: the
autopilot only adds a second source of intents to the same `Transport`
(`SendAgentIntentEvent` → `Transport.sendIntent`,
`src/client/Transport.ts:349`); it does not touch the input handler
`[code]`. So in a singleplayer game you can attack, build and ally by hand
while apex also issues orders for the same troops. Expect it to keep doing
its own thing (it does not know you are there), so this is for nudging it,
not for a coherent co-op. `[ran]`: 25 s into a solo game apex was playing
(187 tiles), a scripted click on unowned land next to its border was
accepted as an attack, exactly as without the autopilot.

### b. Against it, in a private lobby

Yes, this works, and it is the real thing: the bot tab is an ordinary
client on the game server, so the human and apex are two players in one
game. `[ran]` with two separate browser profiles. Steps:

1. **Tab 1 (you):** `http://localhost:9000/`, click **Create Lobby**. The
   dialog creates a private lobby at once and the address bar becomes
   `http://localhost:9000/w1/game/<ID>?lobby&s=…` (the `/wN/` is the server
   worker). The **ID** is the ten-character code shown in the dialog (also
   the last path segment). Set the map and difficulty here; the nations are
   the lobby's bots.
2. **Tab 2 (apex):** open a **private/incognito window or a second browser**
   and load `http://localhost:9000/game/<ID>?agent=apex`. It joins the lobby
   as a second player straight from the URL (no Play click needed;
   `JoinLobbyModal.handleUrlJoin` `[code]`) and tab 1's player list shows
   two names `[ran]`. The address bar is rewritten to `/w1/game/<ID>` without
   the query; the autopilot choice is already in that tab's `sessionStorage`
   `[ran]`.
3. **Tab 1:** click **Start Game**. Both tabs load the game; tab 2's console
   prints `[agent] starting autopilot "apex"` `[ran]`. Spawn yourself in tab
   1 by clicking land during the spawn phase, as in any game. Apex spawns by
   itself in tab 2 and plays against you and the nations, subject to the
   same 10/s, 150/min intent limits the arena enforces.

Why the second profile: the server identifies a player by a persistent ID
that lives in the browser profile's `localStorage`
(`src/client/Auth.ts:773-780`), and a join carrying an ID it already seated
is treated as that player reconnecting (`src/server/GameServer.ts:453-457`,
`joinClient` → `rejoinClient` `[code]`). Two ordinary tabs of one profile
would therefore share one seat, and the bot would drive yours.

`[ran]`: lobby `aoswGmvZkN`, host seat `AnonTopaz6`, bot seat `AnonComet`.
The server drove turns at full speed (tick 1115 two minutes after start).
Apex spawned unaided; at tick 792 it held 6,717 tiles, at tick 1115 17,882
tiles and 504k troops with three alliances, `behind 0` and no divergence,
and both tabs agreed on every player's land (within one turn of lag). The
harness's own spawn click for the human seat timed out (a headless-click
problem: that seat was left unspawned), so the human half of this recipe is
the normal client flow, not something exercised here. Evidence:
`/tmp/claude-0/pkg-PLAYGUIDE/mp-*.png` and `mp-trace.json` from that
session.

### c. Taking over mid-game

**In a multiplayer game, yes** `[ran]`: in the bot's tab load
`http://localhost:9000/game/<ID>?agent=off`. The tab reloads, rejoins the
same seat (the server keeps it by persistent ID), clears the autopilot
setting, and replays the game's turns from the start to catch up
(`ClientGameRunner.ts` "Rejoin game from the start so we don't miss any
turns" `[code]`; a few seconds for a few minutes of game). From then on no
`[agent]` line appears and the empire apex built is yours to play. `[ran]`:
after the reload the tab was back in game `aoswGmvZkN` as `AnonComet`,
alive, `sessionStorage` empty, zero `[agent]` lines, catching up (tick 420
and climbing when sampled). The reverse also follows from the same code:
reload with `?agent=apex` to hand a seat you played to the bot.

**In singleplayer, no.** The autopilot setting is read once when the page
loads (`AgentAutopilot.ts:54-55`), and the singleplayer game lives in the
page (`src/client/LocalServer.ts`, in-memory turns), so the only way to
change the setting is a reload, which ends the game. `[ran]`: loading `?agent=off` in a running solo game landed on the home
page (Solo button visible, no game object, `sessionStorage` cleared).
To play by hand in a game apex opened, use the private-lobby recipe above
and take over with `?agent=off`; to play _beside_ it in singleplayer, click
while it runs (§16.4a).

## 16.5 The headless watcher (no browser window)

For a machine without a display, or to get screenshots and a trace, the
repository has a Playwright script that does §16.2 by itself:

```bash
npm run dev & # if not already up
node .claude/skills/run-openfront/autopilot.mjs apex Pangaea 90
# screenshots /tmp/openfront-run/autopilot-{0..8}.png, trace /tmp/openfront-run/autopilot-trace.json
```

It opens `?agent=apex`, starts a solo game on the map you name against 100
bots at Impossible, never clicks, prints every `[agent]` line and the seat's
state every 10 s, and screenshots each time. Requirements and gotchas are in
`.claude/skills/run-openfront/SKILL.md` (Chromium via Playwright; on a
machine without it, `bash .claude/skills/run-openfront/setup.sh`).

`[ran]` on Pangaea (1000×1000, 29 nations): apex planned and sent its spawn
at tick 4 (`last think 746.8 ms`), then

```
tick 8  spawnPhase=false tiles=52  troops=20970 gold=100  alive=true
tick 17 spawnPhase=false tiles=167 troops=23987 gold=1100 alive=true
tick 41 spawnPhase=false tiles=306 troops=32829 gold=3500 alive=true
tick 65 spawnPhase=false tiles=661 troops=36702 gold=5900 alive=true
```

with `behind 0` throughout and no divergence. (The container's 4 cores were
shared with arena runs, load average 22, so the game advanced at under one
tick a second; on your machine it runs at ten.)

**Known wart:** the script's last line was `AUTOPILOT FAILED: the agent did
not play` even though it had. Its success test looks for the literal text
`spawn at` in the agent's lines, which is what `baseline` logs; apex logs
`spawn (race) at x,y`. Judge the run by the `tiles=` trace and the
screenshots, not by that line, until the check is loosened
(`autopilot.mjs`, the `ok` expression at the end).

## 16.6 Arena games as pictures

The arena (`npm run arena`, chapter 10 §10.4) plays apex against Impossible
nations headless. Two flags draw the games: `--images` writes a final
territory PNG per game into `<out>/images/`, `--image-every M` adds one every
M game minutes (`npm run arena -- --help` `[ran]`). The `showcase` suite
(World, Europe, Alps, ArchipelagoSea, BeringStrait, Mena, seed `showcase`)
already sets `--play-out --image-every 1` (`src/agent/arena/Suites.ts:112-120`
`[code]`), so:

```bash
npm run arena -- --suite showcase --agent apex --images --out arena-results/showcase-apex
npm run arena:gallery -- arena-results/showcase-apex
# -> arena-results/showcase-apex/gallery.html, gallery.jpg (needs Playwright), gallery.json
```

The gallery is a contact sheet, one row per game, the territory at minutes 1,
3, 5, 10, 15, 20 and the end, captioned with apex's land share against the
leading nation's (`src/agent/arena/Gallery.ts` header `[code]`). Roadmap
§11.5 quotes about 3 minutes per entrant for an agent that dies early; apex
survives, and a played-out game is about 92 s of wall time each, so allow 10
minutes for the six games. To keep a gallery:

```bash
npm run arena:progress -- add arena-results/showcase-apex --id my-run --note "what the pictures show"
```

files it as `docs/progress/<date>-my-run.jpg` with an entry in
`docs/progress/galleries.json` (`src/agent/arena/Progress.ts` header
`[code]`). The galleries already filed are in `docs/progress/`; the latest,
`2026-09-27-m2-signoff.jpg`, is what to expect from the command above.

Not run in this container: the CPU budget for this guide was one smoke game.
The flags were checked against `--help` and the suite definition.

## 16.7 What to expect from apex

From `docs/12-ledger.md` as of 2026-09-27: **M2 is signed off** (381
`holdout` games, 4-minute cap: at minute 3 apex holds at least the median
nation's land in 98.7% of games and at least the top nation's in 65.9%;
none eliminated by minute 4). In the 254-game `dev` reference with a
20-minute cap it peaks at 15.2% of the land on average and is eliminated in
56 games; **it has not yet won a game against Impossible nations.** So in a
solo game you will see a strong opening and a good midgame position, then,
against many nations, a slow squeeze or a nuke. Chapter 11 has the plan for
the rest.

## 16.8 Troubleshooting

- **The bot is still (or no longer) playing after I changed the URL.** The
  setting lives in the tab's `sessionStorage` (`openfront.autopilot`), read
  once at page load (`AgentAutopilot.ts:54-55`). Load `?agent=apex` or
  `?agent=off` and let the page reload; check DevTools → Application →
  Session Storage → `http://localhost:9000` → `openfront.autopilot`. Closing
  the tab also clears it.
- **No `[agent]` lines at all.** Filter box set to `[agent]`? Level
  dropdown including Verbose for the `tick …` lines? Is it a replay or
  spectator tab (the autopilot refuses those)? Did the game start (the
  worker is created only after the game worker initialises,
  `ClientGameRunner.ts:705`)?
- **`[agent] stopped: apex has no option "…"`**: a typo in `agentOptions`;
  the message lists the real keys. JSON must be URL-encoded
  (`encodeURIComponent('{"thinkEvery":10}')`).
- **`[agent] stopped: replica diverged …`**: see §16.3. Reload with
  `?agent=off` to play on by hand.
- **The page reloaded and the game vanished.** Vite reloads every open page
  when a source file it serves changes, and the agent worker's chunk imports
  `src/agent/**`. `[ran]`: an edit to `src/agent/lib/LeaderGuard.ts` by
  another engineer reloaded both test tabs mid-game (server log
  `[vite] (client) page reload src/agent/lib/LeaderGuard.ts`). Do not edit
  source files while watching a singleplayer game; it cannot be resumed.
- **`GLUnavailableError: WebGL2 unavailable: software`** in the console:
  the client refuses software WebGL. Use a browser with GPU acceleration on,
  or the headless watcher, whose driver whitelists SwiftShader for the test
  browser only.
- **`EADDRINUSE` from `npm run dev`**: a previous server is still up:
  `pkill -f "tsx src/server/Server.ts"; pkill -f vite`.
- **The bot seems slow to decide.** `last think` in the Verbose status line
  is the cost of one decision; hundreds of ms right after spawn is normal
  (the spawn search), single-digit ms afterwards `[ran]`. `behind` growing
  means the tab cannot keep up: close other heavy tabs or raise
  `thinkEvery`.

## 16.9 Evidence

All runs on 2026-09-27 in a 4-core cloud container shared with arena runs
(load average 16–23), dev server from this checkout, Chromium 1194 through
Playwright 1.56.1 with SwiftShader.

| Claim                                               | How                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dev server URL and port                             | `npm run dev`; `curl http://localhost:9000` answered; Vite printed `Local: http://localhost:9000/`.                                                                                                                                                                                                                                                                                                                     |
| Autopilot spawns and grows, replica never diverges  | `node .claude/skills/run-openfront/autopilot.mjs apex Pangaea 90`, twice. Run 1 spawned at tick 6 (104 tiles at tick 16) and was cut short by a Vite reload from another engineer's edit. Run 2, same script with only Vite's HMR socket neutralised in the test browser, ran the full 90 s: tiles 52 → 661, `behind 0`, no `diverged` line, six screenshots.                                                           |
| Private lobby against apex                          | Two Chromium profiles: tab 1 created a private lobby (`Create Lobby`), tab 2 opened `/game/<ID>?agent=apex`, tab 1 saw two players and clicked `Start Game`; both games loaded; apex spawned and grew to 17,882 tiles by tick 1115, `behind 0`; the human seat's headless spawn click timed out. Log `/tmp/claude-0/pkg-PLAYGUIDE/mp-test.log`, screenshots `mp-1-host-lobby.png`, `mp-2-guest-join.png`, `mp-4-*.png`. |
| Arena flags                                         | `npm run arena -- --help`; `Suites.ts` read.                                                                                                                                                                                                                                                                                                                                                                            |
| Click beside the bot; `?agent=off` in singleplayer  | Solo game with `?agent=apex` on Pangaea: apex spawned at tick 14; at 25 s a scripted attack click on the human's behalf was accepted; then `?agent=off` returned the tab to the home page with the game gone. Log `solo-takeover.log`, screenshots `solo-1-apex-playing.png`, `solo-2-after-agent-off.png`.                                                                                                             |
| Speed/pause keys, replay guard, same-profile rejoin | Read in code only (files cited inline); not exercised headless.                                                                                                                                                                                                                                                                                                                                                         |
