# OpenFront.io — Agent Reference

A complete mechanical reference for an autonomous agent playing OpenFront.io.
Written for a machine reader: formulas over prose, exact constants, `file.ts:LINE`
citations for every claim.

**Derived from source at commit `22722df` (2026-09-24).** This fork has diverged
from upstream OpenFront in ways that invalidate general knowledge about the game —
most importantly, **there is no population or worker system here**, and
**territory produces no gold**. See `99-quirks-and-traps.md`.

## Read in this order

| File                                                       | Subsystem                                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`00-overview.md`](00-overview.md)                         | The model, the four resources, phases, time constants                                                                              |
| [`01-spawn-and-map.md`](01-spawn-and-map.md)               | Tile encoding, terrain, map roster, pathfinding, water components, spawn selection                                                 |
| [`02-territory-and-combat.md`](02-territory-and-combat.md) | The attack formula, borders, retreat, amphibious assault, defense posts                                                            |
| [`03-economy.md`](03-economy.md)                           | Troops, `maxTroops`, gold, trade ships, trains, cost ladders, donations                                                            |
| [`04-units-and-structures.md`](04-units-and-structures.md) | Complete buildable catalog, upgrades, capture, warships, veterancy, rail                                                           |
| [`05-strategic-weapons.md`](05-strategic-weapons.md)       | Nukes, fallout, MIRV, SAM interception                                                                                             |
| [`06-diplomacy-and-ai.md`](06-diplomacy-and-ai.md)         | Alliances, betrayal, relations, embargoes, teams, the AI decision tree                                                             |
| [`07-action-api.md`](07-action-api.md)                     | Every intent schema, tick ordering, observation stream, netcode, win conditions                                                    |
| [`08-running-headless.md`](08-running-headless.md)         | Verified recipes for driving the sim without a browser                                                                             |
| [`09-playbook.md`](09-playbook.md)                         | **[DERIVED]** Spawn to victory, decision loop, exploits                                                                            |
| [`10-agent-interface.md`](10-agent-interface.md)           | How an agent plugs in: the agent API, the headless arena, the browser autopilot, lookahead                                         |
| [`11-roadmap.md`](11-roadmap.md)                           | The plan: measured starting point, goal, strategy hypotheses, milestones, evaluation protocol                                      |
| [`12-ledger.md`](12-ledger.md)                             | Arena results worth keeping, one row per adopted change or milestone run                                                           |
| [`13-mechanics.md`](13-mechanics.md)                       | Every mechanic the agent relies on, pinned by a scenario test; corrections to chapters 00–11                                       |
| [`14-m4-plan.md`](14-m4-plan.md)                           | The M4 build plan: exact search in the midgame, its evidence, work packages and decision rules                                     |
| [`15-m4-status.md`](15-m4-status.md)                       | The M4 build's status: each work package, its options (all off), evidence, runs in flight, remaining decision rules, open problems |
| [`16-playing-with-apex.md`](16-playing-with-apex.md)       | For a human: watch the `apex` bot play in your browser, play beside or against it, see arena games as pictures                     |
| [`99-quirks-and-traps.md`](99-quirks-and-traps.md)         | Dead code, wrong comments, fork divergences, traps                                                                                 |

## Conventions

- **[DERIVED]** marks reasoning from the mechanics, not statements in the code.
  Chapter 09 is entirely derived; elsewhere it is marked inline.
- Unmarked numbers come from source and carry a citation.
- Where the code is ambiguous, it says so rather than guessing. See
  `99-quirks-and-traps.md §99.6`.
- 1 tick = 100 ms. All durations are in ticks unless stated.

## Single-file build

```bash
node docs/agent/build.mjs # writes docs/AGENT_GUIDE.md
```

The concatenated build is for loading the whole reference into one context
window. The split files are for selective retrieval.

## The five things to internalise first

1. **Territory is the win condition and produces no gold.** Passive income is a
   flat 100/tick forever.
2. **Troops refill to 99% of cap in under 500 ticks.** `maxTroops` is the real
   constraint, and one city level is +250,000 of it.
3. **`borderSize` divides the attack speed formula.** Frontage is a resource.
4. **PvP attacks burn their entire stack.** Success returns nothing; only an
   emptied frontier or a cancel refunds anything.
5. **A port with a ≥300-tile sea route is ~13× your whole economy.** A port with a
   short hop is worth 4%.
