---
name: js-data-structures
description: Pick native JS collections (Map, Object, Set, Array, WeakMap, TypedArray) by Big-O and meaning. Use when choosing a built-in collection
---

<!-- Adapted from metaskills v1.0.6 (skills/js-data-structures): one description key in the
     frontmatter (upstream has two), the array-method, iteration, dictionary and membership rules
     of js-conventions, rules for collections a peer can grow, and the examples without the
     fragments of data-structures classes spliced into them upstream. -->

# Native Data Structures (JavaScript)

## Choosing a native collection

- Fixed schema / DTO / JSON: use `Object` (avoid `Map`, no `JSON.stringify`)
- Dynamic string-to-value dict: use `Map`, or a null-prototype object (`Object.create(null)`, `{ __proto__: null }`) where an object is needed; never a plain `{}` for keys from user or peer input
- Non-string keys, insertion order, `.size`: use `Map` (avoid `Object`)
- Ordered list, index access, transform: use `Array` (avoid `Set`, no indexes)
- Unique values, membership: use `Set`, a module-level one for a fixed list (avoid `Array.includes`)
- Attach data to objects without retaining them: use `WeakMap` (avoid `Map`, leaks)
- Track object presence without retaining: use `WeakSet` (avoid `Set`, leaks)
- Numeric / binary data, I/O, crypto: use TypedArray / `ArrayBuffer` (avoid `number[]` for hot binary work)
- Hot queue / deque / stack ends, or a queue a peer can grow: do not rely on `Array.shift`/`unshift` — use a custom ring, an index cursor or a linked structure

## Choosing a collection

Pick the smallest structure that matches how the values relate:

- Fixed schema (record, entity, options): object with fixed property access
  (`obj.x`)
- Distinct values or actions per key (dispatch): lookup table object
  `{ key: value }`, or `{ __proto__: null, key: value }` when the key comes
  from input; use `Object.fromEntries` to build one from a list
- Dynamic keys, added or deleted keys, or non-string keys: `Map`
- String-key dictionary that must be an object (JSON-like data, hot lookups):
  `Object.create(null)` or `{ __proto__: null }`, whose keys never collide
  with the prototype. Records stay literals or classes
- Membership: a module-level `Set` for a fixed list of tokens (`Set.has` is
  faster than `.includes` from four items, and oxlint's `unicorn/prefer-set-has`
  asks for it); a string + `.includes(ch)` for a group of characters;
  `Uint8Array(128)` indexed by `charCodeAt` for character classes in hot code
- Numeric and binary work: typed arrays

Use `obj[key]` only for lookup tables and string-key dictionaries. Use `obj.x`
for known fields.

Do not use `{ token: true, other: true }` for membership. Use a `Set`, a string
of characters, or a code table. Score and style tables keep real values in
objects; membership-only character groups stay strings. See the examples in the
`js-conventions` skill.

Keep aliases and synonyms in one map. Export small helpers such as `mapAlias`
or `isKind` instead of copying lists. Derive lists from maps, reuse shared maps
for overlapping subsets, and normalize aliases at the edge.

Custom structures built on these (the `data-structures` skill) follow the
object shape and array rules in the `js-conventions` skill: initialize fields
in constructors, keep arrays packed (`new Array(n)` only with a cited
benchmark), and clear consumed slots.

## Complexity and code characteristics

Choose a structure for the property you need to control — not only for speed.

**Big-O (typical average case; n = collection size):**

- `Object` field access: O(1) for fixed shapes; dynamic/`delete`-heavy objects degrade toward dictionary mode
- `Array` index get/set, `push`/`pop`: O(1); `includes`/`indexOf`/`splice`/`shift`/`unshift`: O(n)
- `Map` get/set/has/delete, `Set` add/has/delete: amortized O(1); iteration: O(n)
- `WeakMap`/`WeakSet` get/set/has/delete: amortized O(1); no iteration
- TypedArray index get/set: O(1); grow/copy: O(n)
- Prefer the structure whose hot operation is O(1); measure before optimizing rare paths

**Readability and semantics:**

- Let the type state the intent: `Set` = unique membership; `Map` = keyed registry; `Array` = ordered sequence; plain `Object` = record/DTO
- Prefer a named collection over encoding the same idea in ad-hoc flags, parallel arrays, or stringly keys
- In `src/` of libraries and apps, use explicit loops and no array iteration methods (`.map`, `.filter`, `.reduce`), as the `js-conventions` skill says; tests and scripts may use them where they state the transform
- Avoid over-abstracting: a fixed allowlist is a module-level `Set`, not a class or a helper module around one

**Naming:**

- Plural names for collections (`users`, `sessions`); singular for entities (`user`)
- Name by role, not by type: `seenIds` (Set), `socketToSession` (Map) — not `set1` / `mapData`
- Boolean membership reads as `has`/`is`: `if (seen.has(id))`, `blocked.has(user)`
- Include units in size names (`sizeBytes`, `timeoutMs`) when the collection holds measured quantities

**Stability and contracts:**

- Treat inputs as immutable at API boundaries; copy or freeze when you must share
- Prefer stable iteration order when callers rely on it (`Map`/`Set`/`Array` insertion order)
- Keep record shapes and array element kinds stable over time (see per-structure V8 hints)
- Document whether a returned collection is live (shared) or a snapshot

**Testability:**

- Prefer pure functions over collections: same inputs, same outputs; inject maps/sets as arguments when state is required
- Favor deterministic structures in tests: plain data over WeakMap (non-enumerable), over insertion-timed WeakRef behavior
- Assert on observable contents (`[...set]`, `Object.fromEntries(map)`, length/size) rather than private fields
- Small fixtures: build with literals/`Object.freeze` when the shape should not change under test

**Encapsulation, safety, operability:**

- Hide representation behind a small API (`add`/`has`, getters) so internals can change without call-site churn
- Use WeakMap/WeakSet when lifetime must follow the key (leak control)
- Cap growth (max size, TTL, eviction) for long-lived Maps/Sets; unbounded collections are operability bugs
- Pick serializable structures (`Object`/`Array`) at I/O boundaries; convert `Map`/`Set` explicitly

**Collections a peer can grow** (clients, sockets, network messages):

- A queue a peer can grow is never an `Array` read with `shift()`: past a few thousand elements every `shift` copies the rest, and the peer decides the length. Use an index cursor or a ring (`data-structures`)
- Its cap (a count, bytes, a TTL) counts what holding an element costs — key, wrapper object, timer, `Map` entry — not only the payload
- A table keyed by peer input reads with `Object.hasOwn(table, key)` or has no prototype (`{ __proto__: null }`, `Object.create(null)`), or is a `Map`. A plain literal answers `table.toString` with a function that passes a `typeof` check

## Object

Use for records with a known, stable shape (config, entities, options).

```javascript
const user = { id: 1, name: 'Ada', active: true };

// Dictionary keyed by input: no prototype, so `dict.toString` is not a key
const dict = Object.create(null);
dict[key] = value;

// Fixed table read with a key from input
const STATUS_TEXT = { __proto__: null, ok: 'OK', fail: 'Failed' };
const text = STATUS_TEXT[status] ?? 'Unknown';
```

**Hints:**

- Keep a stable shape (hidden class): same keys, types, and key order; init once in a factory/constructor
- Prefer fixed access (`obj.x`) over dynamic keys (`obj[key]`) when the schema is known
- Do not `delete` record fields; set `null` for refs, `undefined` for primitives. `delete` is for dictionaries and for data where a missing key means something
- A record is a literal or a class, never `Object.create(null)`: a null-prototype object starts in dictionary mode
- Objects that share a property should share the full shape — avoid polymorphic property reads
- Walk a plain data object with `for...in` in domain code; in library and hot code, take `Object.keys(obj)` and use an index loop. `Object.entries` only outside hot paths and library `src/`

## Array

Use for ordered sequences and stacks (`push`/`pop`).

```javascript
const ids = [10, 20, 30];
ids.push(40);
const last = ids.pop();
```

**Hints:**

- Keep arrays dense and monomorphic (one element kind): SMI ints, doubles, or objects — do not mix
- Prefer SMI-friendly integers (31-bit signed) for indexes/counters (`PACKED_SMI_ELEMENTS`); a float, `NaN`, or hole promotes the whole array
- Avoid holey arrays (`new Array(n)` without a cited benchmark, deletes, skips); build with a literal or `push`
- Avoid `shift()` / `unshift()` in hot paths and in any queue a peer can grow; use a ring or index cursors
- Prefer `for` / `for...of` in hot loops; no array destructuring in library `src/` (read by index)

## Map

Use for dynamic key-value stores with any key type and predictable iteration.

```javascript
const sessions = new Map();
sessions.set(socket, { userId: 42 });
sessions.set('fallback', null);

// insertion order; entry[0] / entry[1] when both are needed, keys() or values() for one
for (const entry of sessions) {
  const key = entry[0];
  const value = entry[1];
  /* ... */
}
sessions.delete(socket);
console.log(sessions.size);
```

**Hints:**

- Dynamic keys on `Map` avoid dictionary-mode / shape pollution on `{}`
- Iterate entries when both key and value are needed; `keys()` plus `get` only on a measured hot path
- Values read on hot paths should still use stable shapes
- `NaN` is a valid single key; object keys compare by reference
- No `JSON.stringify` — use `Object.fromEntries(map)` only if keys are strings

## Set

Use for unique values and fast membership.

```javascript
const ROLES = new Set(['read', 'write']); // fixed membership list, module level
if (ROLES.has(role)) {
  /* ... */
}

const seen = new Set();
for (const id of incoming) {
  if (seen.has(id)) continue;
  seen.add(id);
  handle(id);
}

const unique = [...new Set(items)];
```

**Hints:**

- Uniqueness is by reference for objects, not deep value
- Insertion-order iteration; no index access
- Array/Set conversion allocates — do it at boundaries, not in hot loops

## WeakMap / WeakSet

Weak collections hold keys weakly so entries can be GC'd when the key is otherwise unreachable. Keys must be objects or symbols. Not iterable; no `.size`.

```javascript
const meta = new WeakMap();
const tracked = new WeakSet();

const attach = (obj, data) => {
  meta.set(obj, data);
  tracked.add(obj);
};
```

**Hints:**

- Prefer WeakMap side tables over adding ad-hoc fields to host objects
- Cannot enumerate — keep a strong list only if you must iterate
- `WeakRef` / `FinalizationRegistry` are for lifetime hooks, not general storage

## Typed arrays

Use for contiguous numeric/binary data: network frames, files, crypto, image/audio, WASM.

- `Uint8Array` — bytes, I/O, hashing
- `Int16Array` / `Uint16Array` — PCM, compact IDs
- `Uint32Array` / `Int32Array` — indexes, bitsets, WASM i32
- `Float32Array` / `Float64Array` — geometry, signals, tensors
- `BigInt64Array` / `BigUint64Array` — 64-bit IDs, timestamps
- `DataView` — endian-aware protocol parsing
- `ArrayBuffer` / `SharedArrayBuffer` — backing store; SAB for workers

```javascript
const buf = new ArrayBuffer(16);
const bytes = new Uint8Array(buf);
const view = new DataView(buf);
view.setUint32(0, 0xdeadbeef, true);
bytes[4] = 0xff;
const frame = bytes.subarray(0, 8); // shared memory; `slice` copies
```

**Hints:**

- Fixed length — size ahead or allocate larger and copy to grow
- Prefer typed arrays over `number[]` for tight numeric loops (stable element type)
- Use `DataView` for wire endianness; multi-byte typed views are platform-endian
- Reuse/pool buffers in hot paths; Node `Buffer` is a `Uint8Array` — prefer `Uint8Array` in shared code unless you need Buffer APIs

## Conventions

- Keep hot code monomorphic: stable argument count, types, return types, and object shapes
- Prefer SMI integers for indexes/sizes; do not mix ints and floats in one variable
- Reduce GC pressure: reuse arrays, objects, and buffers when safe
- Move reusable callbacks outside loops; keep spread, rest and per-iteration closures out of hot loops. `try` / `catch` does not deoptimize: place it where the error handling belongs
