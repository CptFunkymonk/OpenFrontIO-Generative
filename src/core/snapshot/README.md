# Game snapshots

`snapshotGame(game)` serializes the whole core simulation at a tick boundary.
`restoreGame(bytes, deps)` rebuilds it in a fresh game that keeps ticking with
the same results as the original. Uses: pause and resume, fork, custom
scenarios, and replay seeking.

## API

- `GameRunner.snapshot()` / `snapshotGame(game)`: uncompressed bytes, taken
  between ticks.
- `createGameRunnerFromSnapshot(gameStart, bytes, ...)` /
  `restoreGame(bytes, deps)`: resume. Don't call `GameRunner.init()`; the
  first turn added afterwards is the turn for the snapshot's tick.
- Worker: `WorkerClient.snapshot()`, and `new WorkerClient(start, clientID,
snapshot)` to start from one.
- `compressSnapshot` / `decompressSnapshot`: gzip via CompressionStream.
- `readSnapshotHeader(bytes)`: tick, game id, writer's commit, and config,
  without restoring.

A late-game World snapshot (400 bots, 650k owned tiles, about 1,000 units
and executions) is about 2.7 MB raw and 1.2 MB gzipped. It takes about
90 ms to write and 150 ms to restore in Node.

## Structural clone

`GameCloneSource.take(game)` then `.clone(deps)`, or `cloneGame(game, deps)`
([GameClone.ts](GameClone.ts)), makes an exact copy of the game: the game
`restoreGame(snapshotGame(game))` would make, without the bytes, except that
it keeps the game's own water graph (below). It is what forks use
(`src/agent/Fork.ts`: `GameFork.clone`, `ForkSource`, `forkMany`).

- The small object graph goes through the same `snapshot()` and
  `restoreSnapshot()` as a restore. The records are copied with the codec's
  semantics (`copySnapshotData`: plain data rebuilt, typed arrays copied,
  strings as their UTF-8 round trip gives them, no identity kept) and read
  with `readVersioned`, so `restoreSnapshot` sees what it would after
  decoding. The copy is required: some records hold live objects
  (`StatsSnapshot` stores the live stats tree under `z.unknown`), and
  `restoreSnapshot` may keep what it reads.
- The parts that scale with the map are copied as they are:
  - player tile sets (`TileSet.clone`): a set written with
    `SnapshotWriter.tileSet` is a placeholder in structural mode, and must be
    read back with `SnapshotReader.tileSet`, which copies the set (a clone
    fails if a placeholder is read any other way; `w.tiles` always lists);
  - both maps (`GameMapImpl.clone`: terrain with its edits, owners, fallout
    and defense). A restore writes the owners from the players' tile sets,
    which the simulation keeps in step with the map;
  - the water components and the water graph with its path cache
    (`WaterManager`'s `source`, `AbstractGraph.cloneWith`), always. A
    restore rebuilds the graph from the components, which gives the game's
    graph only until water nukes change the water (see Known gaps); the
    graph is not in the snapshot, so the bytes agree either way.
- One take serves any number of clones, all made before the game ticks
  again, and before its territory or water changes between ticks (both
  checked: the big parts are read when a clone is made). To clone a state
  later, keep a clone and take from it.

`tests/core/snapshot/GameClone.test.ts` holds a clone to its game and to a
restore, in the variants of FullGameSnapshot.test.ts (free for all, water
nukes, teams): every 100 ticks through tick 2,000, the game's object graph
(`diffGraphs`, caches and scratch aside) and a restore's (the water graph
aside), snapshot bytes and map arrays; the same hashes and bytes for 600 ticks
with nukes and ships in flight; chains of clones every 100 ticks that stay on
the straight run's track through its winner (free for all, teams) or for
3,000 ticks (water nukes), and at every tick of a window from a restored
game; with water nukes, clones forked where a restore leaves the game's track
(after incremental graph rebuilds, and while the graph is stale) that stay on
it. It also checks that a clone shares no writable object or buffer with its
game or with another clone, and that a source refuses once the game changed.

When a class's snapshot changes, the clone follows by itself; a field that
restore rebuilds from the map (not from the record) needs its clone
counterpart, and the tests above say so.

## Compatibility

Snapshots must stay readable by later builds. Each stored object is a
versioned record, `{ v, d }`, and the encoding
([SnapshotCodec.ts](SnapshotCodec.ts)) is self-describing. It carries field
names and types, so an old record decodes to plain data and is then migrated.
zbin is not used here: it is positional, so an old layout cannot be decoded
at all.

A newer build runs different simulation code, so a restored game continues
_sensibly_ on it but not hash-identically. Exact continuation is only
guaranteed on the build that wrote the snapshot, which is what the tests check.

**Changing what a class stores** means:

1. Bump `version` on its snapshot type.
2. Add `migrations[oldVersion]`, a function from the old record data to the
   new one (for example, fill a new field with the value an old game would
   effectively have had).
3. Update the schema, `snapshot()` and `restoreSnapshot()`.

`snapshotType()` refuses to build a type that is missing a migration.
Record type names (`name`) are stored in snapshots, so never rename or reuse
one. To retire an execution class, keep a registry entry that restores its
old records as whatever replaced it.

The map file itself is not stored. A snapshot records a hash of the map's
terrain, and a restore onto a different map file fails.

## Layout

The root ([GameSnapshot.ts](GameSnapshot.ts)) holds the game config, the game
state, both maps, and one table per shared object kind: players, units,
attacks, alliances, alliance requests, train stations, railroads, clusters
and executions.

Nothing holds an object pointer. Players are their small id (0 = terra
nullius), tiles are TileRefs, and every other shared object is an index into
its table ([SnapshotContext.ts](SnapshotContext.ts)). `SnapshotWriter`
assigns indexes in first-reference order and keeps draining the tables until
no new rows turn up, so dead units, deleted attacks and removed stations that
something still references get stored like live ones.

Restore runs in two passes. Pass 1 creates an empty shell per row with
`Object.create(Class.prototype)`, so no constructor or field initializer runs:
many have side effects such as spawning units, recording stats, or seeding a
PRNG from the current tick. Pass 2 calls `restoreSnapshot` on each shell.

## Writing `snapshot()` / `restoreSnapshot()`

Every `Execution` implements `snapshot(w: SnapshotWriter): ExecRecord` and
`restoreSnapshot(state, r: SnapshotReader)`. It exports
`<ClassName>Snapshot = execSnapshotType({ name, version, schema, cls })`,
which is listed in [ExecutionRegistry.ts](ExecutionRegistry.ts). Put the zod
schema in its own const so the state type does not circle back through the
class:

```ts
export class FooExecution implements Execution {
  private active = true;
  private mg: Game;
  private target: Player;
  private random: PseudoRandom;
  // ...

  snapshot(w: SnapshotWriter): ExecRecord {
    return FooExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      target: w.player(this.target),
      random: w.random(this.random),
    });
  }

  restoreSnapshot(s: FooState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.target = r.player(s.target);
    this.random = r.random(s.random);
  }
}

const FooStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  target: zPlayerRef(),
  random: zRandom(),
});
type FooState = z.infer<typeof FooStateSchema>;

export const FooExecutionSnapshot = execSnapshotType({
  name: "Foo",
  version: 1,
  schema: FooStateSchema,
  cls: () => FooExecution,
});
```

Rules:

- **Restore every field, exactly.** A shell starts with no fields at all.
  Anything the class declares must be assigned unless it was `undefined` in
  the live object. Preserve `undefined` versus `null`: an execution that was
  never `init`ed has no `mg`, and some classes test for that.
- **Only assign in `restoreSnapshot`.** Other objects may still be empty
  shells, so don't call methods on anything you get from the reader. If you
  need a player's id string, use `r.playerID(smallID)`, not
  `r.player(n).id()`.
- **Order is state.** Any Map, Set or array that is iterated during a tick is
  stored as an ordered list and rebuilt in that order.
- **Identity is state.** If two fields point at one object (a PRNG shared
  between a nation and its behaviors, a PlayerInfo shared with a player),
  restore must give both the same object. The tests check aliasing.
- **Caches are not state** if they are rebuilt on demand and never change a
  result. Leave them empty on restore and add the field name to
  `DERIVED_FIELDS` in `tests/util/Snapshot.ts`. Anything read while stale (a
  TTL cache, a cached path) is state.
- **Derived references** (`mg`, `mg.config()`, `game.railNetwork()`) come from
  `r.game`. Stored references go through the writer: `w.player`, `w.owner`
  (may be terra nullius), `w.unit`, `w.attack`, `w.alliance`,
  `w.allianceRequest`, `w.exec`, `w.station`, `w.railroad`, `w.cluster`.
- **PRNGs** are four state words: `w.random(r)` / `r.random(state)`.
- **Pathfinders** hold traversal state that is saved, not recomputed. See
  [PathfinderSnapshots.ts](PathfinderSnapshots.ts).
- **Floats** that may be non-finite use `zNum()`. Integers use `zInt()`.
- **Nested helper objects** (nation behaviors, for example) get their own
  `snapshot()` / `restoreSnapshot()` and their own schema, embedded in the
  owner's record.

## Tests

`tests/util/Snapshot.ts` has `expectSnapshotRoundTrip(game, mapName, ticks)`.
It checks that a restore reproduces the live object graph (`diffGraphs`,
including aliasing and collection order), that snapshotting is idempotent,
and that the original and restored games stay byte-identical tick by tick.
`tests/core/snapshot/` holds per-feature scenarios and a full-game test.

## Known gaps

- With water nukes, a restore can route ships differently from the game,
  where a structural clone does not (it copies the game's water graph):
  - for up to 20 ticks after a water nuke, the game routes on a stale water
    graph and on paths it cached before the change (`WaterManager` rebuilds
    on a throttle), where a restore rebuilds the graph from the current
    water;
  - after a rebuild, which is incremental, the game's graph has the same
    nodes and edges as a restore's full build but in another order, and
    route searches break ties in edge order. On the scripted test game,
    restores forked every 50 ticks and run 400 ticks left the game's track
    at 14 of the 29 fork points from tick 1,600 on; clones at none.
- A trade ship still counting down its rebuild stagger answers a query it
  repeats exactly (the same two tiles) from its graph version's route memo
  (`WaterPathMemo`), which can hold a route found before the rebuild; in a
  clone or a restore the ship asks the current graph. Water nukes only; not
  seen in any test.
- Client-side state (GameView, renderer) is not stored. The client rebuilds
  from the restored game's first full update.
