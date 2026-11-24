---
name: js-local-first-sync
description: Local-first sync with @alexify/syncom, CRDTs, PWA, IndexedDB and OPFS. Use for offline support, merge conflicts or Service Worker bugs
---

# Local-First and Offline-First Sync in JavaScript

Make the local store the source of truth for the UI, turn every change into an identified, idempotent
operation kept in a persistent outbox, pick a merge rule per field instead of "last request wins",
sync through a log with cursors, and never lose a user's change silently.

> **`@alexify/syncom` is 0.0.1 and not published.** Never install it from the registry and never add
> it as a production dependency: the install commands in its docs describe a future release. Until
> then use it only through a workspace link or a git dependency, with the maintainer's agreement, and
> expect the API to change. For production today keep the server authoritative (REST or `wrpc` over
> the native driver) and apply the rules below with the code in `references/crdt-catalog.md`.

## Decision guide

| Data or requirement | Strategy | In syncom |
| --- | --- | --- |
| Field edited by one person on several devices | LWW register per field | `update()`, `set()` |
| Counters, likes, votes, view counts | PN-counter with per-replica totals | `inc()` |
| Limited stock, quotas that must not go negative | Server check, or split the budget | `authorizeWrite` |
| Tags, reactions, membership | OR-Set (add wins), 2P-Set, G-Set | `add()`, `remove()` |
| Collaborative text, ordered lists | A sequence CRDT, never hand-rolled | `text` plugin |
| Moves in a hierarchy | Movable tree | `tree` plugin |
| Fields that must stay together (address) | One register holding an object | One field |
| Records where users must see overwrites | CAS patches plus a conflict log | `swap()`, `conflict` event |
| Money, unique names, bookings, any invariant | Server-authoritative order and validation | Keep it on the server |
| Read-mostly content offline | Service Worker cache only | None |

|  | Library `@alexify/*` | App (`auth8`) |
| --- | --- | --- |
| Sync engine | Storage and transport injected | syncom only by agreement, else own outbox over REST or wrpc |
| Frontend | None | Vue 3, a `shallowRef` over a syncom store |
| Validation | Standard Schema from metaschema | The same `Schema` on client and server |
| Server data | Driver injected | Native `mongodb`, own DAL, one repository per aggregate |

Default positions and why:

- Synchronize only source data: user input, literals, formulas. Never sync derived values (formula
  results, aggregates). Every replica recomputes them, or the server broadcasts one result.
- Patch-based sync ends in manual resolution or rollback. Something can be lost, so both users are
  told: a toast, a conflict log panel, and an "apply mine anyway" action.
- Never lock a document, row or column while a conflict or a long computation resolves. Users keep
  editing, and their queued changes would arrive as a batch that conflicts with itself.
- Keep the server small: order, persist and relay operations. Rebase and conflict detection can run
  on clients, or in one shared module for the page, the Service Worker and the server.
- In synchronization nothing is obvious. Describe the algorithm on one or two pages with a sequence
  diagram, agree on it, and keep it stable.
- Keep one data format in storage, on the wire and in memory.

## Rules

### Architecture

- The UI reads and writes the local store (IndexedDB, OPFS, memory cache). The network only syncs
  that store in the background. Offline is the normal case, not an error path.
- Every change is an operation with a globally unique id (`${replicaId}:${seq}` or
  `crypto.randomUUID()`), applied idempotently: keep the applied ids and skip duplicates.
- Persist the outbox with the record change in one IndexedDB transaction. Memory queues die with the
  tab or the Service Worker. syncom's log is this outbox: a write is logged before it resolves.
- Use one sync connection per origin: a Service Worker or SharedWorker, or one leader tab elected
  with `navigator.locks`. In syncom `openShared()` does this over the IndexedDB engine.
- Validate everything that arrives from the network or another tab: shape, types, sizes. Reject the
  keys `__proto__`, `constructor`, `prototype` (prototype pollution through merges).

### Sync protocol

- The server keeps an append-only log and assigns positions. A client keeps a cursor
  `{ source, position }`, pulls after it in bounded batches with a `more` flag, and pushes its outbox
  with operation ids that the server deduplicates.
- The log has an identity (`source` id or epoch). When the server log is reset or restored from
  backup, the id changes and clients pull from zero and push their whole history again.
- Take the cursor from server replies. Never advance it by counting your own pushes: concurrent
  writers make the offset drift.
- Clear the outbox only for what the server acknowledged. Entries added during the push stay.
- Late joiners and reconnecting clients get a snapshot plus the tail of the log. Take snapshots from
  committed server history on a schedule: a client may disconnect before it can send its own.
- Stop echo loops: a delta that changes nothing is not logged, and deltas received from upstream are
  not pushed back upstream.
- Live updates are a hint: an event whose position does not continue the cursor triggers a pull.

### CRDT rules

- Merge must be commutative, associative and idempotent. Prove it in tests: apply the same deltas in
  every order and twice, expect one state.
- Prefer state or delta CRDTs that carry per-replica totals. An operation like "+1" is correct only
  with exactly-once delivery: a redelivery after a reconnect double counts.
- LWW needs a deterministic tie-break: compare time, then replica id (then value). Wall clocks drift,
  so use a hybrid clock: `time = max(Date.now(), latestSeenTime + 1)`.
- Deletion is a tombstone, never the absence of a key: absence is indistinguishable from "not yet
  received". Collect tombstones only after every replica has them, or at a snapshot epoch.
- Decide add-wins or remove-wins explicitly per collection.
- CRDTs guarantee convergence, not business validity. Invariants (balance >= 0, unique slug) need a
  server decision. In syncom that is `authorizeWrite`, and a refused op is reverted on the client.
- A replica id is stable per device installation and changes when local storage is cleared.
- In syncom a delete is a stamped marker: an edit stamped after it, by a node that had not seen it,
  brings the record back. A field keeps its kind: `inc()` on a register is refused.

### Conflicts with compare-and-swap patches

- A patch carries `{ key, prev, next }` per field. The server applies it only if every current value
  equals `prev`, otherwise it answers with the current values. Edits of different fields made from
  the same base both succeed.
- Do not use a hash of the whole document as the precondition: it rejects patches that do not overlap.
- Optimistic UI: apply locally, mark as pending, and on the server's order apply remote changes
  first, then re-apply (rebase) your pending ones. When rebase collides, roll back and notify.
- syncom's `swap(id, changes, expected)` is a check **on this node only**. It cannot stop another
  node writing offline. Across nodes the merge rules decide, and `conflict` reports a lost register
  with `winner` and `loser`. Show it, and let the user apply theirs again.

### Service Worker (PWA)

- Lifecycle: `register` -> `install` (precache a versioned asset list inside `event.waitUntil`) ->
  waiting -> `activate` (delete old caches, `clients.claim()`) -> `fetch`. Serve `worker.js` from the
  root to control `/`, over HTTPS (localhost is exempt).
- `skipWaiting()` on install is simple but lets a new worker serve new assets to a page that loaded
  old ones. Prefer: wait, show "new version available", and on confirmation post a message that calls
  `skipWaiting()`. Reload on `controllerchange`.
- Handle only same-origin `GET`. Never cache mutations, auth responses or API data in Cache Storage:
  data flows through the sync engine and IndexedDB. Cache only `response.ok` and `clone()` first.
- Pick a strategy per resource (code in `references/pwa-storage.md`):

| Resource | Strategy |
| --- | --- |
| Hashed or versioned assets, fonts, icons | Cache first |
| HTML navigations | Network first with timeout, then cache, then offline page |
| Avatars, non-critical JSON | Stale-while-revalidate |
| API calls, WebSocket, POST | Not handled by the fetch handler |

- A Service Worker may be stopped at any moment and has no DOM or `localStorage`. Keep state in
  IndexedDB or OPFS, not in globals. A WebSocket held by the worker can drop when the browser stops
  it, and tabs pinging the worker do not guarantee its lifetime.
- Background Sync (`registration.sync`) exists only in Chromium. Also flush the outbox on worker
  start, on `online`, on page load and on reconnect.

### Storage

- IndexedDB for records and the outbox. Resolve on `transaction.oncomplete`, not on request success.
  Do not `await` network or timers inside a transaction: it auto-commits when idle
  (`TransactionInactiveError`). Migrate in `onupgradeneeded`, and close on `versionchange`.
- OPFS (`navigator.storage.getDirectory()`) for files and append-only logs.
  `createSyncAccessHandle()` works only in dedicated workers, and `createWritable()` is not in every
  browser, so feature-detect.
- Cache Storage only for HTTP responses. `localStorage` only for tiny preferences.
- Call `navigator.storage.persist()`, check `estimate()` and handle `QuotaExceededError`. Safari may
  delete script-written storage of sites unused for 7 days unless installed to the home screen: the
  server copy is the backup.
- Prefer a thin IndexedDB wrapper (schema, declarative `select`, validation before writes) over both
  inline raw calls and repository ceremony.
- In syncom OPFS is the default and one tab owns it (a second gets `LOCKED`). Use
  `idbEngine({ name })` for several tabs. `db.persist()` and `db.quota()` wrap the Storage API. A full
  origin is a `QUOTA` rejection, or an `UNPERSISTED` `error` event when the record is held in memory.

### Validation on the client

- `@alexify/metaschema` is the single source. A `Schema` is a Standard Schema, so it goes straight
  into a syncom entity. Every write is checked, and every node re-checks ops from peers.
- `db.check('Task', data)` validates a form without writing.
- **vee-validate 4.15 does not read Standard Schema**: given a raw `Schema` it reports invalid input
  as valid. Use the `toVeeSchema` adapter from `js-contracts-schemas`.

## Patterns

Hand-written CRDTs, the operation log and CAS patches, all tested, are in
`references/crdt-catalog.md`. The code below ran on Node.js 24 against real syncom and wrpc.

### Schema, host and client (syncom)

```js
// schema.js
const { Schema } = require('@alexify/metaschema');

const title = { type: 'string', length: { min: 1, max: 200 } };
const definition = { title, done: { type: 'boolean', default: false } };
const Task = Schema.from({ ...definition, 'votes?': 'number', 'tags?': { array: 'string' } });
const schema = { entities: { Task: { schema: Task, index: ['done'] } } };

module.exports = { Task, schema };
```

```js
// host.js
const { createDatabase } = require('@alexify/syncom/all');

const { schema } = require('./schema.js');

const createHost = async ({ path, engine }) => {
  const db = await createDatabase({ path, schema, engine });
  const unit = db.sync.unit({
    authorize: (context) => Boolean(context.session?.state.user), // access stays 'session'
    authorizeWrite: ({ op }) => op.type !== 'delete', // op.actor is the writer's own claim
  });
  return { db, unit }; // mount as defineRouter({ syncom: unit }, { hooks })
};

module.exports = { createHost };
```

A router-level fail-closed Kerberos hook refuses the unit, whose procedures declare no rule. Exempt
`syncom/` in that hook, as `node-websocket-realtime` shows: `authorize` and `authorizeWrite` decide.

```js
// board.js
const { WrpcClient } = require('@alexify/wrpc');
const { createDatabase } = require('@alexify/syncom/all');
const { createWrpcLink } = require('@alexify/syncom/wrpc');

const { keepDialing } = require('./dial.js');
const { schema } = require('./schema.js');

const openBoard = async ({ url, engine, signIn }) => {
  const reconnect = { minDelay: 500, maxDelay: 30000 };
  const connect = async (node) => {
    const client = await WrpcClient.connect(node.url, { reconnect, authenticate: signIn });
    return createWrpcLink(client);
  };
  const db = await createDatabase({ path: 'board', schema, engine, sync: { connect } });
  if (db.sync.listNodes().length === 0) await db.sync.addNode({ url });
  await db.persist();
  const stopDialing = keepDialing(db);
  return { db, stopDialing }; // never await the first replication before showing the UI
};

module.exports = { openBoard };
```

wrpc reconnects a link that was once open, and `authenticate` signs in again before the feed resumes.
A first dial while offline is different: `WrpcClient.connect` rejects, and syncom keeps the node
registered with no link until the next `db.sync.sync()`. Without `keepDialing` (in
`references/syncom-client.md`), an app opened offline never syncs.

### Fields merge by kind

```js
await laptop.Task.update(id, { title: 'From laptop' }); // register: the later stamp wins
await laptop.inc(id, 'votes', 1); // counter: both increments count
await laptop.add(id, 'tags', ['urgent']); // set: takes an array, concurrent additions are kept

phone.on('conflict', ({ field, winner, loser }) => notifyOverwrite(field, winner, loser));
const isClaimed = await laptop.swap(id, { done: true }, { done: false }); // false if already done
```

### Vue 3

```js
import { onScopeDispose, shallowRef } from 'vue';
import { toStore } from '@alexify/syncom/store';

export const useStore = (store) => {
  const value = shallowRef(store.getSnapshot());
  onScopeDispose(store.subscribe((next) => (value.value = next)));
  return value;
};

// Create a store once per query, at module level: never inside a render
export const createOpenTasks = (db) => {
  const cursor = db.Task.select({ done: false }).order('title');
  return toStore(cursor, { initial: [] });
};
```

### One sync owner per origin

```js
const engine = idbEngine({ name: 'board' });
const election = { locks: navigator.locks };
const options = { createDatabase, engine, path: 'board', schema, election, sync: { connect } };
const board = await openShared(options);
let stopDialing = null;
const lead = () => {
  if (stopDialing) stopDialing();
  stopDialing = keepDialing(board); // only the leader replicates
};
if (board.isLeader()) lead(); // onLeader does not fire for a tab that already leads
board.onLeader(lead);
```

Without a `channel`, a follower's write is refused with `NOT_LEADER`. Pass one to forward writes.
A write that may have reached a lost leader rejects with `LEADER_LOST` and `maybeApplied: true`: read
the record before writing again. The alternative is one wrpc connection in a worker, through
`WrpcClientProxy` and `WrpcClient.connect(url, { worker })`.

## Anti-patterns

- "Last request wins" with no field-level merge: concurrent edits overwrite each other.
- Syncing computed values (totals, formula results, rendered HTML).
- Operations without ids, or `+1` increments retried after a timeout.
- An outbox in memory only, or written in a different transaction than its record.
- A cursor computed on the client. No log identity, so a server restore silently skips data.
- Absence as deletion. Tombstones collected while replicas are offline.
- Wall-clock LWW with no replica tie-break.
- Global document locks during conflict resolution. Silent dropping of the losing edit.
- Caching `/api` responses or POSTs in the Service Worker. Cache-first navigations with no update path.
- Unversioned cache names, no cleanup in `activate`, `skipWaiting()` mixing asset versions.
- Awaiting `fetch` inside an IndexedDB transaction. `localStorage` for data or queues.
- Merging network JSON into objects without validation (`__proto__`).
- Hand-writing a text CRDT for production. Blocking the UI on the first replication.
- Installing `@alexify/syncom` from the registry.

## Checklist

- [ ] UI works with the network off, including a **first open** offline.
- [ ] Every change has a unique id and is applied idempotently.
- [ ] Outbox and record are written in one transaction and survive reload.
- [ ] Each field has an explicit merge rule. Derived data is never synced.
- [ ] Merge functions have order and duplicate tests (`node:test`).
- [ ] LWW uses `(time, replica)` and a hybrid clock. Deletions are tombstones.
- [ ] Sync uses server positions, a log identity, bounded batches and `more`.
- [ ] Snapshot plus tail for joiners. No echo loops.
- [ ] Conflicts are detected and shown to users, never dropped.
- [ ] Network input is validated with metaschema. Reserved keys are rejected.
- [ ] Service Worker: versioned caches, cleanup, GET-only, per-resource strategy, offline fallback,
      update prompt.
- [ ] One sync connection per origin.
- [ ] `persist()` requested. Quota errors handled.
- [ ] The sync algorithm is documented with a diagram.

Related skills: `node-websocket-realtime`, `js-contracts-schemas`, `alexis-libraries`,
`node-data-access`, `node-security`
