# Performance and V8

Rules for library/system code and measured hot paths, on top of
[SKILL.md](SKILL.md). They target current Node.js and V8 releases. Outside
measured hot code, readability wins.

## How V8 optimizes

- Tiers: Ignition bytecode with feedback vectors, then Sparkplug (baseline), Maglev (fast
  optimizer), and TurboFan (peak). Optimized code speculates on observed shapes, Smi or double
  values, and call targets. A failed guard deoptimizes back to bytecode and widens the feedback;
  repeated deopts cost more than never optimizing
- A hidden class holds property names, order, field representation (Smi, Double, HeapObject,
  Tagged), and prototype. A field that changes type is generalized for every object of that class
- Normalize polymorphic input once, at the boundary: a small factory turns tuples, differently
  ordered objects, aliases, and numeric strings into one shape, and business code sees only that
  shape. Polymorphism then lives in one function

## Safety and performance

Rules from the Alexis libraries, where a fast-looking spelling was a failure mode or a guess:

- Never spread a data array into arguments: `out.push(...items)`, `Math.max(...values)`,
  `fn(...list)` and `fn.apply(null, list)` throw `RangeError: Maximum call stack size exceeded`
  past the engine's argument limit (about 125 000 elements on Node.js 24 with the default stack,
  [v8-facts.md](v8-facts.md)). A peer or a data set decides that length, so a large fan-in becomes a
  hard failure. Loop with `push`, or `concat`. Forwarding rest parameters (`(...args) => fn(...args)`)
  is fine: the caller wrote those arguments
- A `switch` that dispatches to real handler calls stays a `switch` on a hot path. Measured in wrpc
  (`bench/dispatch.js`): with a handler call in the loop, a `switch` and an `if` chain were level and
  a table of handler functions was about 25% slower, because V8 inlines through a `switch` but not
  through a function value read from a table. Lookup tables (SKILL.md) pick values or allow late
  registration; order a long chain by frequency before rewriting it
- `new Array(n)` for speed only with a benchmark cited next to it; otherwise build a packed array
  with a literal or `push` (see Arrays). Slots written by index out of order (results kept in
  input order as tasks finish) are its other legitimate use
- A hand-optimization cites its benchmark in a comment (`// measured in bench/unmask.js`), and the
  benchmark stays in the repository. An unmeasured one only makes the code harder to read

## Object shapes, hidden classes, and inline caches

- Objects with the same properties added in the same order can share a V8 hidden
  class, also called an object shape. A hot property read or call site handles
up to four hidden classes before it becomes megamorphic. In hot paths, use
  one class with a `kind` field instead of many subclasses. If subclasses stay,
  declare every field in the base constructor in the same order
- Keep hot functions monomorphic with stable argument and return types
- Choose public fields, private fields and methods, or constructor assignments
  by design, not an assumed speed difference. Fields use define semantics:
  they do not call setters
- Prefer string or number literals for status and codes

## Numbers

- Hot numeric fields: initialize and reset them with a number (`0`, or `-1` as the absent sentinel), never `undefined` or `null`. A field that starts non-numeric becomes a generic tagged field and boxes every double write. Do not use `NaN` as a sentinel: it belongs to native APIs that return it instead of throwing

## Arrays

- Arrays the code builds have one element kind and no holes (an array the caller passes may
  have holes: see Iteration costs). Element kinds tend to generalize
  (integer -> double -> any, packed -> holey), so do not rely on them narrowing
  again. Build with a literal, `push`, or `Array.from({ length }, fn)`.
  Preallocate with `new Array(n)` only in the cases of Safety and performance:
  unfilled it is holey, and `fill` packs it only from V8 13.6 (Node.js 24). Never write past
  `length` or grow by setting `length`; do not mix integers, doubles, and
  objects in one array
- Integer arrays stay integer: normalize `-0` to `0` and reject `NaN` and `Infinity` before storing; one such value turns the whole array into doubles
- Never read past the end: `i < list.length`, never `i <= list.length`, never
  `while ((item = list[i]) !== undefined)`. An out-of-bounds read may walk the
  prototype chain and disrupt optimization
- Never `Object.defineProperty` on array indices: one non-default element moves the whole array to slow elements

## Typed arrays and binary data

- Store numeric and binary hot data in typed arrays and parse wire formats with `DataView`: values
  are unboxed, fixed-type, hole-free, and off the GC-traced heap. 1M `{ x, y }` double points take
  82 MB of heap, a `Float64Array(2e6)` takes 16 MB off-heap
- Always build a `DataView` with the `byteOffset` and `byteLength` of the view you got. A Node
  `Buffer` is often a slice of a shared 8 KiB pool, and `new DataView(chunk.buffer)` reads unrelated
  pool bytes
- For numeric records prefer a struct of arrays (`{ count, xs, ys }`) over an array of objects

```js
const decodeChunk = (chunk) => {
  const { buffer, byteOffset, byteLength } = chunk;
  const view = new DataView(buffer, byteOffset, byteLength);
  return { id: view.getInt32(0), payload: chunk.subarray(ID_LENGTH) };
};
```

## Functions and closures

- Small result objects that do not leave an inlined function (`{ text, end }` from a span reader) are removed by escape analysis and cost no allocation. `try` / `catch` does not deoptimize: place it where the error handling belongs
- Keep hot functions small: TurboFan inlines by bytecode size (460 bytes per callee, 920 cumulative
  per call site). Move error formatting, logging, and rare branches into separate functions
- Closures created in one scope share one context object. If any of them references a large value,
  every closure from that scope keeps it alive, even when the reference sits in a branch that never
  runs. Capture only what you need: 200 handlers retained 163 MB, and 3.4 MB after copying a
  primitive instead
- Hoist callbacks, regexes, and constant objects out of loops and per-call code
- Do not spread arrays into hot calls: `fn(...list)` and `fn.apply(null, list)` were about 15x
  slower than positional arguments. Forwarding rest parameters (`(...args) => fn(...args)`) is
  optimized
- Never use `eval`, `with`, or `new Function` in hot code

## Strings

- Build strings with `+=` or template literals: V8 makes ropes, which were 2.4x faster than `push`
  with `join('')`. Use `join` when you already have an array
- Replace chains of `.replace()` and `.split()` over large text with one pass
- A short slice of a huge string keeps the whole parent alive, and a template literal does not copy
  it. When caching fragments of large payloads, copy them with `structuredClone(part)` or parse them
  into structures
- Prefer literal statuses and codes: literals are internalized and cheap to compare

## Memory and module state

- Module state: module-level tables and settings are `const` and never reassigned (optimized code embeds them and deoptimizes when they change). A mutable module-level counter holds only integers, so V8 updates it in place without allocation
- Buffers, queues, and pools set a consumed slot to `null` so the GC can free the item
- Reduce GC pressure: reuse arrays, objects, and buffers when safe
- Small short-lived objects are cheap. Retention is what costs: growing caches, maps, and arrays
  promoted to old space. Do not pool tiny objects speculatively; do reuse large buffers in hot loops
- Amortize expensive per-call work: prefetch random bytes, batch writes, reuse encoders
- For large static data (over about 10 KB), `JSON.parse('...')` parses faster than an equivalent
  object literal

## Serialization

- `JSON.stringify` fast path for data serialized often: no `replacer` or `space` argument (transform first), no `toJSON`, no numeric-like keys (`'0'`), no symbol keys or non-enumerable properties, keys without `"` or `\`, and arrays of objects with the same hidden class

## Iteration costs

Use the iteration rules in [SKILL.md](SKILL.md) as defaults, then benchmark the
current target runtime when iteration matters:

- Prefer `for i` for array iteration in library code, system code, and hot paths: over 100
  numbers it ran 37 ms to the 56 ms of `for...of` (`v8-facts.md`)
- `for...of` over arrays and other iterables is allowed in every layer; a hot path keeps the
  loop its benchmark picks
- `for...in` over a plain object, a literal or JSON with own, enumerable, string keys, is
  allowed in every layer. On a small object V8 walks it from the enum cache and beats
  `Object.keys` with an index loop; on a large dictionary-mode object (JSON with many keys,
  `Object.create(null)`, an object after `delete`) `Object.keys` wins. wrpc's
  `bench/object-walk.js` on Node.js 24.14: 7 headers, `for...in` 9.9 M ops/s against 6.8 M;
  1,000 rooms, 22,000 against 29,000
- Never `for...in` over an array (string indices, holes skipped), a class instance or an object
  of unknown origin (inherited enumerable keys walk too): use `Object.keys`, or `Object.hasOwn`
  per key
- Holes: `every`, `some`, `forEach`, `filter`, `map`, `reduce` and `flatMap` skip them; `find`,
  `findIndex`, `for...of` and an index loop read a hole as `undefined`. A loop that replaces a
  skipping method on an array the caller passes keeps that behaviour with
  `if (!(i in list)) continue;`, so a sparse array in options is accepted as before
- Avoid `.forEach`; it is usually the slowest direct array traversal. Use a
  loop for side effects or state changes
- Outside `src/`, a pure `.reduce` is fine for reductions; current engines optimize it well
- `Object.entries` only outside hot paths and library `src/`. For a `Map`, iterate `keys()` or
  `values()` for one side and `for (const entry of map)` for both; switch to `keys()` plus
  `map.get` only where a benchmark of that hot path shows the gain
- Use `slice()` or `[...list]` for an array copy and `concat()` for an array join; avoid `[...a, ...b]`

## Measuring

- Profile the real hot path before applying micro-rules; outside measured hot code, readability wins
- Shapes and arrays: `node --allow-natives-syntax` with `%HasFastProperties`, `%HasHoleyElements`, `%HaveSameMap`. Deopts and field changes: `--trace-opt`, `--trace-deopt`, `--trace-generalization`. Checks only, never in committed code
- Micro-benchmarks: one case per process (a shared harness makes its call site megamorphic and skews every case after the first), warm up before timing, accumulate results into a printed sink so the work is not eliminated, and take the median of several runs
- Recipes, status bits, and trace flags: [v8-verify.md](v8-verify.md). Measured numbers behind these
  rules: [v8-facts.md](v8-facts.md). V8 changes between releases, so re-measure on the Node.js
  version you ship

## Do not micro-optimize

These were equal or within noise on Node.js 24.14 (V8 13.6), so choose by readability:

- `var` or `let` and `const`, quotes or template literals, a ternary or `if`
- `obj.x` or `obj['x']`, a getter with a simple body or a field
- `try` / `catch` in a hot function, several `return` statements (both are inlined)
- `fn.call(ctx, a)` and once-bound functions or direct calls
- Outdated advice: "add `try {}` to stop inlining", "`+=` reallocates every time", "objects stay
  polymorphic up to 16-32 shapes"

## Primary sources

- [Node.js documentation](https://nodejs.org/api/)
- [V8 fast properties](https://v8.dev/blog/fast-properties)
- [V8 elements kinds](https://v8.dev/blog/elements-kinds)
- [V8 spread elements](https://v8.dev/blog/spread-elements)
- [V8 JSON serialization](https://v8.dev/blog/json-stringify)
