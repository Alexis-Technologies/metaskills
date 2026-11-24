# CRDT catalog: types, merge semantics, logs, CAS, tests

Read this when choosing or implementing a CRDT, reviewing merge code, or explaining why replicas
diverge. All code here ran on Node.js 24 with `node:test`: order permutations and duplicate merges.

syncom implements these models for you, but it is 0.0.1 and unpublished. This code is what to write
in a production app today, and what to check a sync engine against.

## Three families

| Family | What travels | Requirements on delivery |
| --- | --- | --- |
| State-based (CvRDT) | Whole state | Any order, duplicates, loss tolerated |
| Operation-based (CmRDT) | Operations | Exactly once (or dedup by op id), causal order for non-commuting ops |
| Delta-state | Small states joined like full states | Any order, duplicates OK, resend lost deltas |

The merge (join) of a state-based or delta CRDT must be commutative (`a ⊔ b = b ⊔ a`), associative
and idempotent (`a ⊔ a = a`). Then replicas that received the same set of updates are equal, whatever
the order and however many duplicates arrived.

Operation-based CRDTs are cheaper on the wire but trust the channel. A counter that sends a numeric
delta and applies it with `+=` counts a resend twice. The minimum for safe redelivery is an
`id = replica:seq` per operation and a set of applied ids.

## Type table

| Type | State | Merge | Value | Use for |
| --- | --- | --- | --- | --- |
| G-Counter | `{ [replica]: total }` | per-replica max | sum | views, events counted |
| PN-Counter | `{ p: GCounter, n: GCounter }` | merge both | sum(p) - sum(n) | likes, votes, stock deltas |
| G-Set | set | union | set | append-only tags, seen ids |
| 2P-Set | `{ added, removed }` | union both | added - removed | removal is final (banned users) |
| LWW-Set | `{ added: {item: time}, removed: {...} }` | per-item max time | add time > remove time | simple membership, clock dependent |
| OR-Set | `{ tags: {tag: item}, tombstones }` | union tags and tombstones | items with a live tag | add-wins collections, reactions |
| PN-Set | per-item per-replica add/remove counts | per-replica max | adds > removes | toggles counted per replica |
| LWW-Register | `{ value, time, replica }` | later time, then larger replica | value | profile fields, titles, settings |
| MV-Register | values with version vectors | keep all concurrent values | list of siblings | show both edits to the user |
| RGA / sequence | linked elements with unique ids and tombstones | union, deterministic order | ordered list | text, lists: use a library |

## Implementations

Keep state JSON-serializable, so it can be stored and sent as is. Keys that come from the network
pass through `isSafeKey`: on a plain object `result['constructor'] ?? 0` is a function, and the merge
would produce `NaN`.

```js
// crdt.js
const { randomUUID } = require('node:crypto');

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isSafeKey = (key) => !RESERVED_KEYS.has(key);

const mergeMax = (a = {}, b = {}) => {
  const result = { ...a };
  const keys = Object.keys(b);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!isSafeKey(key)) continue;
    result[key] = Math.max(result[key] ?? 0, b[key]);
  }
  return result;
};

const sumValues = (state) => {
  const keys = Object.keys(state);
  let total = 0;
  for (let i = 0; i < keys.length; i++) total += state[keys[i]];
  return total;
};

// G-Counter: { [replica]: total }, join = per-replica max
const gCounter = {
  empty: () => ({}),
  inc: (state, replica, amount = 1) => ({ ...state, [replica]: (state[replica] ?? 0) + amount }),
  merge: (a, b) => mergeMax(a, b),
  value: (state) => sumValues(state),
};

// PN-Counter: two G-Counters
const pnCounter = {
  empty: () => ({ p: {}, n: {} }),
  add: (state, replica, amount) => {
    if (amount < 0) return { ...state, n: gCounter.inc(state.n, replica, -amount) };
    return { ...state, p: gCounter.inc(state.p, replica, amount) };
  },
  merge: (a, b) => ({ p: gCounter.merge(a.p, b.p), n: gCounter.merge(a.n, b.n) }),
  value: (state) => gCounter.value(state.p) - gCounter.value(state.n),
};

// G-Set: union only
const gSet = {
  empty: () => [],
  add: (state, item) => (state.includes(item) ? state : [...state, item]),
  merge: (a, b) => [...new Set(a.concat(b))].sort(),
  value: (state) => state.toSorted(),
};

// 2P-Set: removed items can never be added again
const twoPhaseSet = {
  empty: () => ({ added: [], removed: [] }),
  add: (state, item) => ({ ...state, added: gSet.add(state.added, item) }),
  remove: (state, item) => {
    if (!state.added.includes(item)) return state;
    return { ...state, removed: gSet.add(state.removed, item) };
  },
  merge: (a, b) => ({
    added: gSet.merge(a.added, b.added),
    removed: gSet.merge(a.removed, b.removed),
  }),
  value: (state) => {
    const removed = new Set(state.removed);
    const alive = [];
    for (const item of state.added) {
      if (!removed.has(item)) alive.push(item);
    }
    return alive.sort();
  },
};

// OR-Set (add-wins): every add gets a unique tag, remove hides observed tags
const orSet = {
  empty: () => ({ tags: {}, tombstones: [] }),
  add: (state, item, tag = randomUUID()) => ({ ...state, tags: { ...state.tags, [tag]: item } }),
  remove: (state, item) => {
    const observed = [];
    for (const tag of Object.keys(state.tags)) {
      if (state.tags[tag] === item) observed.push(tag);
    }
    return { ...state, tombstones: gSet.merge(state.tombstones, observed) };
  },
  merge: (a, b) => ({
    tags: { ...a.tags, ...b.tags },
    tombstones: gSet.merge(a.tombstones, b.tombstones),
  }),
  value: (state) => {
    const dead = new Set(state.tombstones);
    const alive = new Set();
    for (const tag of Object.keys(state.tags)) {
      if (!dead.has(tag)) alive.add(state.tags[tag]);
    }
    return [...alive].sort();
  },
};

// LWW-Register: { value, time, replica }, deterministic tie-break
const mergeRegister = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  if (a.time !== b.time) return a.time > b.time ? a : b;
  return a.replica >= b.replica ? a : b;
};

const mergeCounter = (a, b) => ({
  inc: mergeMax(a?.inc, b?.inc),
  dec: mergeMax(a?.dec, b?.dec),
});

// A delta carries this replica's new total, so it can be merged many times
const increment = (counter, replica, amount = 1) => {
  const side = amount < 0 ? 'dec' : 'inc';
  const current = counter?.[side]?.[replica] ?? 0;
  const delta = { inc: {}, dec: {} };
  delta[side] = { [replica]: current + Math.abs(amount) };
  return delta;
};

const mergeDocument = (a, b) => ({
  title: mergeRegister(a.title, b.title),
  likes: mergeCounter(a.likes, b.likes),
});

module.exports = {
  gCounter,
  pnCounter,
  gSet,
  twoPhaseSet,
  orSet,
  mergeRegister,
  mergeCounter,
  increment,
  mergeDocument,
};
```

## Checking the laws with `node:test`

```js
// crdt.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const crdt = require('./crdt.js');
const { orSet, pnCounter, twoPhaseSet, mergeDocument, increment } = crdt;

const permutations = (list) => {
  if (list.length <= 1) return [list];
  return list.flatMap((item, index) => {
    const rest = [...list.slice(0, index), ...list.slice(index + 1)];
    return permutations(rest).map((tail) => [item, ...tail]);
  });
};

const checkLaws = (type, states) => {
  const join = (list) => list.reduce((a, b) => type.merge(a, b));
  const expected = type.value(join(states));
  for (const order of permutations(states)) {
    assert.deepEqual(type.value(join(order)), expected);
  }
  const twice = type.merge(join(states), join(states));
  assert.deepEqual(type.value(twice), expected);
  return expected;
};

test('OR-Set: concurrent add survives remove', () => {
  const base = orSet.add(orSet.empty(), 'x', 't1');
  const removed = orSet.remove(base, 'x');
  const readded = orSet.add(base, 'x', 't2');
  assert.deepEqual(checkLaws(orSet, [base, removed, readded]), ['x']);
});

test('PN-Counter: replicas converge', () => {
  const a = pnCounter.add(pnCounter.empty(), 'a', 3);
  const b = pnCounter.add(pnCounter.empty(), 'b', -1);
  const c = pnCounter.add(a, 'a', 2);
  assert.equal(checkLaws(pnCounter, [a, b, c]), 4);
});

test('2P-Set: a removal is final', () => {
  const base = twoPhaseSet.add(twoPhaseSet.empty(), 'x');
  const removed = twoPhaseSet.remove(base, 'x');
  assert.deepEqual(checkLaws(twoPhaseSet, [base, removed]), []);
});

test('a reserved replica id cannot corrupt a counter', () => {
  const hostile = JSON.parse('{"constructor": 5, "__proto__": 7, "a": 1}');
  const merged = crdt.gCounter.merge({ a: 2 }, hostile);
  assert.deepEqual(merged, { a: 2 });
});

test('document merge is order independent and idempotent', () => {
  const EMPTY = { title: null, likes: { inc: {}, dec: {} } };
  const first = { title: { value: 'A', time: 1, replica: 'r1' }, likes: increment(null, 'r1') };
  const second = { title: { value: 'B', time: 1, replica: 'r2' }, likes: increment(null, 'r2', 2) };
  const third = { title: null, likes: increment(first.likes, 'r1') };
  const deltas = [first, second, third];
  const apply = (list) => list.reduce((a, b) => mergeDocument(a, b), EMPTY);
  const expected = apply(deltas);
  for (const order of permutations(deltas)) assert.deepEqual(apply(order), expected);
  assert.deepEqual(apply([...deltas, ...deltas]), expected);
  assert.equal(expected.title.value, 'B');
  assert.deepEqual(expected.likes.inc, { r1: 2, r2: 2 });
});
```

Keep the number of states small, because permutations grow factorially. Add one test per conflict
scenario: add/remove race, equal timestamps, duplicate delivery, a replica offline for a long time.

## Clocks for LWW

Wall clocks drift and jump back. Use a hybrid clock: close to wall time, monotonic, and always ahead
of every time seen from others. Break equal times by replica id.

```js
const createClock = (replica, now = Date.now) => {
  let last = 0;
  return {
    stamp: () => {
      last = Math.max(now(), last + 1);
      return { time: last, replica };
    },
    observe: (time) => {
      if (time > last) last = time;
    },
  };
};
```

Call `observe(delta.time)` for every received register.

## Operation log with cursors

```js
// log.js
class SyncLog {
  #ops = [];
  #ids = new Set();
  source = crypto.randomUUID();

  push(ops) {
    for (const op of ops) {
      if (this.#ids.has(op.id)) continue;
      this.#ids.add(op.id);
      this.#ops.push(op);
    }
    return { source: this.source, position: this.#ops.length };
  }

  pull({ source, position = 0 }, limit = 256) {
    const start = source === this.source ? position : 0;
    const end = Math.min(this.#ops.length, start + limit);
    const ops = this.#ops.slice(start, end);
    const more = end < this.#ops.length;
    return { source: this.source, position: end, ops, more };
  }
}

// Push the outbox, then pull until the server says there is no more
const sync = async (replica, api) => {
  const batch = replica.pending.slice();
  if (batch.length > 0) {
    await api.push(batch);
    replica.pending = replica.pending.slice(batch.length); // keeps what was added meanwhile
  }
  let reply = null;
  do {
    reply = await api.pull(replica.cursor);
    for (const op of reply.ops) replica.applyOnce(op); // skips seen op ids
    replica.cursor = { source: reply.source, position: reply.position };
  } while (reply.more);
};

module.exports = { SyncLog, sync };
```

Persist `pending` and `cursor` in IndexedDB in real code. Clear `pending` only after the push is
acknowledged, and only the entries that were sent: assigning `[]` loses a change made during the push.

## Compare-and-swap patches with visible conflicts

```js
// cas.js
class SharedDocument {
  #cells = new Map();
  #history = [];

  apply({ author, changes }) {
    const conflicts = [];
    for (const { key, prev } of changes) {
      const current = this.#cells.get(key) ?? null;
      if (current !== prev) conflicts.push({ key, current });
    }
    if (conflicts.length > 0) return { ok: false, conflicts };
    for (const { key, next } of changes) this.#cells.set(key, next);
    this.#history.push({ author, changes });
    return { ok: true, version: this.#history.length };
  }

  since(version) {
    return this.#history.slice(version);
  }
}

module.exports = { SharedDocument };
```

On `ok: false` the client rolls back its optimistic value, shows who overwrote it, logs the conflict,
and can retry with the current value as `prev`. `since(version)` gives a reconnecting client the tail.

## Schema-based merge

Declare the merge rule next to the field type: `counter` fields travel as numeric differences and are
added, arrays travel as additions and are united, nested objects recurse, and a missing key becomes a
tombstone. A scalar that takes "the value of the delta applied last" depends on arrival order, so it
converges only when one party orders the deltas. Give scalars a register `{ value, time, replica }`
if replicas merge directly with each other.

## How syncom models the same types

| Kind | Made by | Two concurrent writes |
| --- | --- | --- |
| Register | `insert()`, `set()`, `update()` | The newer stamp wins on every node |
| Counter | `inc()` | Both count: a running sum per node |
| Set | `add()`, `remove()` | Both additions kept. A removal takes only the additions it had seen |
| List | `push()`, `splice()` with an array (`text` plugin) | Both insertions kept in place |
| Text | `updateText()`, `splice()` with a string (`text` plugin) | Both edits kept, per character |
| Tree | `treeMove()` (`tree` plugin) | Both apply. A move that would form a cycle is dropped everywhere |

- A stamp is above every stamp the node has seen for that record, so a write made after seeing another
  always wins it. Only writes made without seeing each other are decided by time, then node id.
- Metadata is per field and stays out of the record's data. There is no revision field.
- The first call that writes a field sets its kind. If two nodes pick different kinds at once, a fixed
  order decides the same way everywhere.
- A dropped register raises `conflict` with `{ kind, id, field, op, winner, loser }`.
- `diff`, `merge` and `apply` from the package root are helpers over plain objects, not how it
  replicates. `merge` **adds** numbers, so a delta from `diff` is not a plain patch for numeric fields.
- Known limits from its README: a counter straddling a concurrent reset, encrypted records stay local,
  no proof of key possession at `hello`.
