# 06 — Diplomacy, teams and the built-in AI

## 6.1 Alliances

| Constant | Value | Seconds |
|---|---|---|
| `allianceDuration()` | `customAllianceDuration × 600`, default **3,000** | 300 (5 min) |
| `allianceRequestDuration()` | 200 | 20 |
| `allianceRequestCooldown()` | 300 | 30 |
| `allianceExtensionPromptOffset()` | 300 | 30 |
| `disableAlliances()` | true if `customAllianceDuration === 0` | — |

### Request

`canSendAllianceRequest` is false if alliances are disabled, the target is
yourself, **either player is disconnected**, you are already friendly, you are
dead, or an outgoing request to them already exists. It is **true** if an
*incoming* request from them exists — that is the counter-accept path. Otherwise
the last outgoing request to that player must be ≥300 ticks old.

**The counter-request path does more than a plain accept**
(`src/core/execution/alliance/AllianceRequestExecution.ts:45-65`):
- `+100` relation **both ways**
- both sides' **temporary** embargoes against each other are dropped (permanent
  ones survive)
- **all in-flight nukes between the two are deleted**

> A normal accept via the UI accept button goes through
> `AllianceRequestImpl.accept()` and gets **none** of that. The asymmetry looks
> unintentional but it is what the code does. Flagged as not fully traced through
> the client.

Requests expire after 200 ticks. They are auto-rejected when you attack the
requester, or launch a nuke that would anger them.

### Expiry and extension

Expiry is checked every tick and is **free — no traitor mark, no relation
change**.

Extension: the window opens at `expiresAt <= ticks + 300`. Both sides must agree;
flags never expire on their own. `extend()` sets
`expiresAt = ticks() + allianceDuration()` — **not** `expiresAt + duration`, so
**extending early truncates the remaining time**.

### What an alliance actually does

| Mechanic | Effect |
|---|---|
| Land and boat attacks | **Blocked** |
| Nukes on an ally | **Allowed** — only *teammates* are protected. Breaks the alliance, marks you a traitor |
| Donations | Require `isFriendly` |
| Trade partner selection | Friendly ports get **double weight** in the lottery |
| **Train gold** | **35,000/stop for an ally** vs 25,000 for a teammate or stranger |
| Targeting | Allies see each other's `targets()`, and AI allies act on them |

> `isFriendly(other)` returns **false if `other.isDisconnected()`**. Every
> consequence below flows from that one line.

## 6.2 Betrayal and the traitor state

You are marked a traitor when you call `breakAlliance` — manually, by nuking an
ally hard enough, by MIRVing an ally, or (for AI) by the betray behaviour —
**only if the other player is not already a traitor and is not disconnected**.

> **Exploit**: breaking an alliance with someone who is already a traitor, or who
> is disconnected, costs you **nothing**. No traitor mark.

Duration: **300 ticks (30 s)**. Re-betraying restarts the clock.

| Penalty | Value |
|---|---|
| Attackers lose **half** the troops against you | `attackerTroopLoss × 0.5` |
| Attacks against you are **25% faster** | `tickFraction × 0.8` |
| Relation from the betrayed | **−100** |
| Relation from bystanders | **−40** to every `nearby()` non-teammate — including the betrayed if adjacent, so up to **−140** total |
| Nation AI | ~90% alliance rejection; non-Easy nations break with allied traitors; high in the Hard/Impossible attack order |
| Bots | pick random non-friendly traitor neighbours to attack |

`betrayals()` is **display only** — no mechanical effect.

> `Config.traitorSpeedDebuff()` is misleadingly named: 0.8 multiplies
> `tickFraction`, so attacks *against* a traitor go **faster**.

## 6.3 Relations

Stored per ordered pair, **asymmetric**, clamped to `[-100, 100]`. Buckets
(`PlayerImpl.ts:946-957`):

| Raw | `Relation` |
|---|---|
| `< -50` | Hostile |
| `-50 … <0` | Distrustful |
| `0 … <50` | Neutral |
| `≥ 50` | Friendly |

Unseen pairs start at **0 (Neutral)**.

**Decay runs every tick**: 0.05 toward zero, snapping to 0 below 0.1. That is
**0.5/second** — a −100 relation returns to neutral in **2,000 ticks ≈ 200 s**.

### Everything that changes relation

| Event | Δ | Direction |
|---|---|---|
| Alliance formed via counter-request | **+100** | both |
| Donate troops above the difficulty minimum | **+50** | recipient → sender |
| Donate gold | `+5` per chunk, capped **+100** | recipient → sender |
| Emoji ❤️ 🥰 🕊️ 🏳️ 👏 to a Nation | **+15**, *Easy only* | recipient → sender |
| Embargo placed / lifted against a nation | **−20** / **+20** | nation → you |
| Warship retaliation, trade capture / transport kill | **−7.5** / **−15** | nation → you |
| Nation assists an ally | **−20** | nation → ally (the cost of the favour) |
| **Being targeted** (`targetPlayer`) | **−40** | target → targeter |
| Neighbour breaks an alliance near you | **−40** | each nearby non-teammate → breaker |
| Emoji 🤡 / 🖕 to a Nation | **−10** / **−100** | recipient → sender |
| **Being attacked** | **−60 / −70 / −80 / −100** by difficulty | defender → attacker |
| Alliance broken on you | **−100** | betrayed → traitor |
| Qualifying nuke | **−100** | hit → launcher |
| MIRV launched at you | **−100** both ways | mutual |

Gold-donation chunk size: Easy 2,500 / Medium 5,000 / Hard 12,500 / Impossible
25,000, **scaled by `1 + ticks/(3000 + spawnTicks)`** — relation gets more
expensive as the game runs.

## 6.4 Embargoes

`canTrade(other)` is false if **either** side has an embargo. **A one-sided
embargo blocks trade in both directions.**

Blocked: sea trade (partner selection and in-flight ships), rail trade, AI
structure siting. **Not blocked**: attacks, nukes, alliances, donations.

| Item | Value |
|---|---|
| `temporaryEmbargoDuration()` | 3,000 ticks (5 min) |
| `embargoAllCooldown()` | 100 ticks |

A **permanent** embargo already in place is never downgraded to temporary, and
`endTemporaryEmbargo` is a no-op on it. The manual embargo button always sets
permanent. `EmbargoAllExecution` skips yourself, **all bots**, and teammates.

**Auto-embargo triggers:**
1. **Being attacked** — the only temporary embargo in the codebase. Applied
   whenever neither attacker nor defender is a bot. 5 minutes. Cleared early only
   by the alliance counter-request path.
2. Nation hostility (relation ≤ Hostile) — permanent.
3. Hard/Impossible nations in Team mode permanently embargo everyone not on their
   team, except bots.

## 6.5 Teams

Assignment order (`TeamAssignment.ts:15-161`): pinned `teamIndex` from the
matchmaker (ignores max team size) → **clans** (largest first, all-or-nothing,
overflow members are kicked to spectator) → **friends** (a soft preference only)
→ everyone else, with Nations shuffled last.

`HumansVsNations` gives exactly two teams. `Duos/Trios/Quads` give
`max(2, ceil(total / 2|3|4))`. Fewer than 8 teams use colour names; 8+ use
"Team N". A numeric `playerTeams < 2` **throws**.

**Bots are always on team `"Bot"`, and `isOnSameTeam` returns false for that
team** — bots freely attack each other, and the Bot team **can never win**.

### What teammates share

| Mechanic | Teammates | Allies |
|---|---|---|
| Attacks blocked | yes | yes |
| Nukes blocked | **yes** (plus a blast-radius structure check in Team mode) | **no** |
| Donations | yes | yes |
| Auto-embargo / `EmbargoAllExecution` | exempt | not exempt |
| Trade partner weight | normal | **doubled** |
| **Train gold** | 25,000 (same as a stranger) | **35,000** |
| Win condition | shared tile sum | separate |

### Disconnected players — a large exploitable surface

`isFriendly` returns false for a disconnected player. Therefore:

- You can **attack a disconnected ally or teammate** with no alliance check
  firing, the alliance is **not broken**, and you are **not marked a traitor**.
- Alliance requests and extensions are impossible while either side is
  disconnected.
- **Conquering a disconnected teammate costs zero troops** — `attackLogic` sets
  `mag = 0` (`isDisconnectedTeammate`).
- Conquering a disconnected teammate **transfers their warships and transport
  ships to you**.
- Team-win credit: a disconnected player is still listed as a winner only if their
  team held ≥**70%** of the land when they disconnected, or they were already dead.

## 6.6 The AI, in decision order

Two distinct AIs: **Nations** (`NationExecution` + 7 behaviour modules) and
**Tribes/bots** (`TribeExecution`, which uses only `AiAttackBehavior` — no
structures, no nukes, no diplomacy logic).

### Nation cadence

`attackRate` rolled once at init:

| Difficulty | Ticks between decision passes |
|---|---|
| Easy | 65–100 |
| Medium | 55–70 |
| Hard | 45–60 |
| Impossible | 30–50 |

Per-nation ratios rolled at construction: `triggerRatio = 0.50–0.60`,
`reserveRatio = 0.30–0.40`, `expandRatio = 0.10–0.20`.

**Every** tick (not just decision ticks), non-Easy nations with a port run
warship tracking and retaliation. Structures get two extra passes per cycle at the
1/3 and 2/3 offsets.

On a decision tick, in this exact order: casual emoji → embargo relations →
alliance requests → alliance extensions → **MIRV** → structures → warship spawn →
hostile embargoes → **attack** → warship infestation counter → **nuke**.

### Target selection (`AiAttackBehavior.maybeAttack`)

1. Build the bordering set (border-tile neighbours **plus** `nearby()`, which
   reaches across rivers up to 4 wide), sorted **ascending by troops**.
2. If any non-fallout terra nullius borders you → attack it and **return**.
   **Nations always prefer free land.**
3. No bordering enemies → 1/5 chance of a random boat. Otherwise 1/10 chance of a
   boat (and return), else consider alliance requests.
4. `attackBestTarget`.

`attackBestTarget` gates:
- If a neighbouring **bot owns structures** → attack bots first, before any ratio gate.
- Gate 1: `troops/maxTroops >= reserveRatio` (0.30–0.40) or abort.
- Gate 2: `troops/maxTroops >= triggerRatio` (0.50–0.60), else a 1/10 chance to
  proceed anyway.
- Then run the difficulty-ordered strategy list, stopping at the first hit.

| Difficulty | Strategy order |
|---|---|
| Easy | nuked, bots, retaliate, assist, betray, hated, weakest |
| Medium | bots, nuked, retaliate, assist, betray, hated, afk, traitor, weakest, island, donate |
| Hard | bots, retaliate, assist, betray, nuked, traitor, afk, hated, veryWeak, juicy, victim, weakest, island, donate |
| Impossible | retaliate, bots, veryWeak, betray, assist, victim, traitor, juicy, afk, nuked, hated, weakest, island, donate |

Key strategies: `veryWeak` targets anyone with `troops < maxTroops × 0.15`;
`juicy` targets anyone with `troops <= yours × 0.75`, scored on structure levels,
troop-cap headroom and tiles; `victim` targets anyone whose incoming attacks
exceed half their troops; `afk` targets disconnected borderers; `island` fires
only when nothing borders you.

### Restraint mechanisms — the exploitable ones

- **`troopSendCap()`** (Hard/Impossible, FFA only, not vs bots): a nation refuses
  to drop below `ceil(strongestNonAlliedNeighbourTroops × retainFraction)` —
  **Hard 0.75, Impossible 0.90**.
- **`isAttackTooWeak()`** (Hard/Impossible, FFA): refuse an attack sending
  `< target.troops × 0.2`, unless already under attack.
- **`shouldAttack(human)`**: **Easy attacks a human only 1/5 of the time**, Medium
  refuses 1/4 of the time, Hard/Impossible always attack.

> **Four ways to freeze a Hard/Impossible nation:**
> 1. Park a large stack next to it — `troopSendCap` will not let it commit
>    elsewhere.
> 2. Leave unowned land on its border — step 2 short-circuits every decision tick.
> 3. Keep your troops above 15% of your `maxTroops` to stay out of `veryWeak`, and
>    above 75% of the nation's troops to stay out of `juicy`.
> 4. Note that *it* stops attacking entirely if *its* troops fall below
>    `reserveRatio` (~0.3–0.4 of its max), except via the bot branch.

### Alliance decisions (`getAllianceDecision`, evaluated top-down)

1. **Confused** → coin flip. Easy 10%, Medium 5%, Hard 2.5%, **Impossible 0%**.
2. Traitor → reject with 90% probability.
3. Hard/Impossible: reject if the requester already has too many alliances
   (≥50% / ≥25% of the non-bot player count).
4. **They're a threat → ACCEPT.** Easy never; Medium if their troops > yours×2.5;
   Hard if troops > yours AND maxTroops > yours×2; Impossible if troops >
   yours×1.5, or several weaker combinations.
5. Team-game rejection: Easy 25%, Medium 50%, Hard 75%, **Impossible 100%** —
   Impossible nations never ally in Team mode unless rule 4 fired first.
6. Relation < Neutral → reject.
7. Relation == Friendly → accept (Hard/Impossible add 17%/33% extra rejection).
8. Already enough alliances (Medium 4–6, Hard 3–5, Impossible 2–4; Hard/Impossible
   also refuse to ally with *all* their neighbours).
9. **Earlygame free pass**: Easy `< 3000 + spawn` at 90%; Medium `< 1800` at 70%;
   Hard `< 1800` at 50%; Impossible `< 600` at 30%.
10. Similarly strong — accept if their troops (+ outgoing attacks) exceed yours by
    a difficulty-scaled percentage.

> **Ask for alliances early.** The earlygame free pass is the single largest
> acceptance term, and it closes at tick 1,800+spawn for Medium and Hard, and
> tick 600+spawn for Impossible.

### Betrayal (`maybeBetray`)

1. Hard/Impossible: the target is the juiciest ally **and** `isSafeToBetray()` —
   the sum of the target's and all bordering enemies' and other allies' troops is
   `< your troops × 0.33`.
2. Easy/Medium: `your troops >= theirs × 10`. **Easy never betrays humans.**
3. Non-Easy: the ally is a traitor and their troops `< yours × 1.2`.
4. Non-Easy: exactly one bordering player total and `theirs × 3 < yours`.

A successful betray is immediately followed by a forced attack.

### Structures (`NationStructureBehavior`)

Defence posts sit outside normal pacing: **Easy never builds them**; Medium 50%
chance and max 1; Hard/Impossible build `ceil(ratio / 0.4)` where
`ratio = incomingAttackTroops / ourTroops`, requiring `ratio >= 0.35`. If that
threshold is met and a post cannot be placed, **all other construction is
blocked**.

Build order: SAM first (Hard/Impossible with high starting gold and nukes
enabled), or Port first (high nation density), then **Port → Factory → SAM →
Silo**, each gated on `owned < floor(cityCount × ratio)`, falling back to
**City**. Cities are the default sink and drive every other ratio.

| Structure | ratio per city | perceived-cost inflation per owned |
|---|---|---|
| Port | 0.75 | +100% each |
| Factory | 0.75 (×0.33 if coastal and ports enabled) | +100% each |
| SAM | Easy 0.15 / Med 0.20 / Hard 0.25 / Imp 0.30 | +30% each |
| Missile Silo | 0.20 (0.40 for the first), **hard cap 3** | +100% each |

`getPerceivedCost` inflates prices **only while `gold < getSaveUpTarget()`** —
this is the mechanism that makes nations hoard for nukes.

### Nukes (`NationNukeBehavior`)

Target priority: two players left → the other one; **retaliate against the largest
incoming attacker ("Most important!")**; Impossible + richest + 1/2 chance →
highest structure density; Impossible FFA leader >50% land; ally assist; most
hated with maxTroops > yours/2; FFA crown gap (Easy 40% / Medium 30% / Hard 20% /
**Impossible 10%**); Team mode strongest enemy team.

**Never nuked**: bots, teammates, or anyone failing `shouldAttack`.

**1/3 of nations are "hydro-nations"** that never fire atom bombs unless under
heavy attack. Perceived nuke cost grows **+50% per atom bomb launched** and **+25%
per hydrogen bomb launched**.

Hard/Impossible skip an aim point whose trajectory passes within any enemy SAM's
range. Impossible requires a positive target score (it will not nuke empty
ground); Easy/Medium/Hard will. When Impossible finds nothing it runs a full
**SAM-saturation planner**: compute covering SAM levels, require `sum(levels)+1`
bombs plus `floor(n/5)` extras, plan `waitTicks` so arrivals land inside the
45-tick reload window, and fire a salvo.

Target scoring: Missile Silo 50,000×level, City 25,000×level, Port/Factory
15,000×level, Defense Post 5,000×level, **SAM 0**. Minus 30×distance to the
nearest silo, minus 1,000,000 per recent nuke overlapping the tile.

### MIRV (`NationMIRVBehavior`)

Hesitation roll first: Easy 1/2, Medium 1/4, Hard 1/8, Impossible 1/16 chance to
skip. Then, each with a **global 300-tick per-target cooldown shared across all
nations**:
1. Counter-MIRV — anyone whose MIRV is currently aimed at you.
2. **Victory denial** — anyone (or the largest member of a team) holding ≥ Easy
   75% / Medium 65% / Hard 55% / **Impossible 40%** of total land.
3. **Steamroll stop** — the city leader, if cities > Easy 20 / Med-Hard 10 /
   Imp 8 **and** cities ≥ second place × (Easy 2 / Med 1.5 / Hard 1.25 / Imp 1.15).

> **Crossing 40% of the map in a lobby with Impossible nations invites a MIRV.**
> So does out-building everyone in cities by 15%.

### Warships

Baseline: 1/50 chance per decision tick, and **only when you have zero warships**
— the passive path never exceeds one.

Retaliation (every tick, non-Easy): triggered by your transports being destroyed,
your trade ships being captured, or incoming enemy transports. Build chance
**Easy 0% / Medium 15% / Hard 50% / Impossible 80%**, hard cap 10 warships.

`counterWarshipInfestation` (Hard/Impossible, among the 3 richest non-humans):
builds a warship **on top of a random enemy warship tile** when an enemy has >10
warships.

### Tribes (bots)

- `attackRate = 40–80` ticks, **difficulty-independent**.
- **They accept every incoming alliance request unconditionally** and auto-agree
  to every extension. No relation check, no traitor check. A free ally.
- They delete one captured structure per 300 ticks — which is why nations
  prioritise attacking bots that hold structures.
- Attack logic: a non-friendly traitor neighbour at 1/3 chance, then terra
  nullius, then a shuffled neighbour list skipping Nation/Human neighbours 50% of
  the time.
- Economy: 10,000 start, `maxTroops/3`, `troopIncreaseRate × 0.5`, 50 gold/tick,
  `attackAmount = troops/20`. Human/Nation attackers take **×0.7** losses against
  them.

## 6.7 Emoji and quick chat

| Item | Value |
|---|---|
| Emoji display / cooldown | 50 ticks each, per recipient |
| Quick chat cooldown | 30 ticks |

**Emoji have real effects only when the recipient is a Nation:**

| Emoji → Nation | Effect |
|---|---|
| 🖕 | **−100 relation** + an angry auto-reply |
| 🤡 | **−10 relation** |
| 🕊️ 🏳️ ❤️ 🥰 👏 | **+15 relation, on Easy difficulty only** |
| anything else | nothing |

So the only mechanically meaningful plays are 🖕 to instantly drive a nation to
Hostile (which triggers auto-embargo, the `hated` attack strategy and nuke
targeting), 🤡 for a small nudge, and the peace set against Easy nations.

**Quick chat has no mechanical effect whatsoever.** It calls `displayChat` twice
and records a cooldown. Nothing in `src/core` reads it; no AI responds.

**Targeting (`targetPlayer`) *is* mechanical**: 100-tick duration, 150-tick
cooldown, **−40 relation** from the target, and allies — including AI nations —
read `targets()` to decide whom to attack and nuke. It is how you ask an AI ally
for help.
