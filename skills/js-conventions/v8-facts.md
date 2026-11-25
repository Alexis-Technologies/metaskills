# Measured facts (Node.js 24.14.1, V8 13.6, Apple Silicon)

Each row was checked with `--allow-natives-syntax` probes or an isolated
micro-benchmark (one process per case, 3 warm-up rounds, median of 10 rounds of
1M calls, results written to a sink). Absolute numbers are machine-specific;
ratios and verdicts are what matter, and they can change in future V8
versions, so re-run before relying on them.

## Shapes and properties

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Literals with same keys and order share a map | True | `%HaveSameMap({x:1,y:2}, {x:3,y:4})` true, even from different sites |
| Key order matters | True | `{x,y}` vs `{y,x}`: different maps |
| Adding a key later creates another map | True | `{x}` then `.y = 2` differs from `{x, y}` |
| `delete` drops to dictionary mode | True (even last key) | `%HasFastProperties` false after any `delete` |
| Assigning `undefined`/`null` keeps the map | True | same map, fast properties |
| Class instance and literal with same keys share a map | False | per-constructor root maps |
| Class with declared fields keeps one map despite branches | True | `y = null` declared, `if (flag) this.y = 2` -> same map |
| Changing a field type creates a per-object shape | False | V8 generalizes the field for all objects of the map (Smi -> Double -> Tagged), dependent code deopts |
| `Object.create(null)` objects are fast-mode | False | starts in dictionary mode; building `{a, b}` that way is 7-12x slower than a literal |
| `{ __proto__: null, x: 1 }` literals are fast-mode | False | dictionary mode from the start, like `Object.create(null)`: right for a dictionary, wrong for a record |
| Objects with computed keys go dictionary | True | at the 20th `obj['k' + i] = i` |
| Polymorphic IC holds up to 4 maps | True | `--max-valid-polymorphic-map-count=4`; 2M loads: 1 map 1.5 ms, 2: 2.1, 4: 3.5, 5: 6.6, 8: 6.6 |
| Getter with a simple body is as fast as a field | True | 0.30 vs 0.31 ms |

## Arrays and numbers

| Expression | Elements kind |
| --- | --- |
| `[1, 2, 3]` | `PACKED_SMI` |
| `[1, 2, 3]` then `push(1.5)` / `push(NaN)` / `push(-0)` | `PACKED_DOUBLE` |
| `[1.5, 2]` then `a[0] = 1` | stays `PACKED_DOUBLE` (one-way) |
| `[1, 'a']`, `[1, undefined, 3]` | `PACKED_ELEMENTS` |
| `[1, , 3]`, `new Array(3)`, `a[10] = 4` on length 3, `delete a[1]` | `HOLEY_*` |
| `new Array(3).fill(0)` | `PACKED_SMI` (full fill packs on V8 13.6; still `HOLEY_SMI` on Node 22) |
| index-writing every slot of `new Array(n)` | stays `HOLEY_SMI` |
| `[]` then `a[100000] = 1` | `DICTIONARY` elements |
| `new Array(n)` | holey up to `2 ** 25` (33,554,432), dictionary beyond (Node 22 and 24) |

| Loop over 10k numbers x5000 | Time |
| --- | --- |
| packed SMI array | 20 ms |
| holey SMI array | 42 ms |
| packed double array | 38 ms |
| `Float64Array` | 37 ms |
| array with 1% strings | 39 ms |

- Smi range on Node 24 (64-bit, no pointer compression): `2 ** 31 - 1` is a
  Smi, `2 ** 31` and `-0` are not.
- Memory for 1M points: `{ x, y }` doubles 82 MB heap, `{ x, y }` Smis 50 MB,
  `Float64Array(2_000_000)` 16 MB in `arrayBuffers` (off-heap).

## Calls, functions, control flow (1M calls)

| Case | Median |
| --- | --- |
| `pair[0] + pair[1]` | 0.43 ms |
| `const [a, b] = pair` | 2.31 ms |
| `sum3(t[0], t[1], t[2])` | 0.42 ms |
| `sum3(...t)` | 6.27 ms |
| `sum3.apply(null, t)` | 6.40 ms |
| `(...args) => sum(...args)` forwarding | 0.46 ms (same as direct) |
| `sum3.call(obj, 1, 2, 3)` | 0.41 ms |
| once-bound `bound(1, 2, 3)` | 0.43 ms |
| `arguments` loop vs rest loop | 2.42 vs 2.38 ms |
| `try/catch` body vs plain | 0.42 vs 0.41 ms |
| ternary vs `if` | 0.84 vs 0.85 ms |
| `var` loop vs `let` loop | 36.4 vs 37.0 ms |

- `out.push(...list)` and `Math.max(...list)` passed with 100 000 elements and
  threw `RangeError: Maximum call stack size exceeded` with 125 000 (default
  stack size).
- `--trace-turbo-inlining` shows functions with `try/catch` and with three
  `return` statements inlined into their caller.
- Loop over 100 numbers, 1M times: indexed `for` 37 ms, `reduce` 34 ms,
  `for...of` 56 ms, `forEach` mutating an outer variable 83 ms.

## Strings

| Case | Result |
| --- | --- |
| 100 x `s += 'ab'` vs `push` + `join('')`, 1M times | 277 ms vs 653 ms |
| Keep `big.slice(0, 20)` of 100 strings of 1 MB | 103 MB retained |
| same with `structuredClone(part)` / Buffer or JSON round-trip | 4.4 MB |
| same with a template literal `` `${part}` `` | 103 MB (no copy) |

## Closures and allocation

- Two closures from one scope, one of which reads an 800 KB array, the returned
  one does not: 200 handlers retain 163 MB. Capturing a copied primitive
  instead: 3.4 MB. A sibling inside a never-executed `if` still forces
  retention (scope analysis is static).
- Prefetching 4 KiB of random bytes and reading `Uint32` values: 200k values in
  2.9 ms vs 144.7 ms for `crypto.randomBytes(4)` per value.
- Building `{ a, b }` with `Object.create(null)`: 27-64 ms vs 4-5 ms for a
  literal per 1M objects.
- Benchmark that discards the result: 16.7 ms vs 32.3 ms when the result is
  accumulated (the optimizer removed part of the work).

## Reproduction snippets

Shape probe:

```js
// node --allow-natives-syntax shapes.js
const a = { x: 1, y: 2 };
const b = { y: 2, x: 1 };
const c = { x: 1, y: 2, z: 3 };
delete c.z;
console.log(%HaveSameMap(a, b), %HasFastProperties(c)); // false false
```

Polymorphism cliff (`node poly.js 4` vs `node poly.js 5`):

```js
const SHAPES = Number(process.argv[2] || 1);
const KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

const make = (variant, value) => {
  const obj = {};
  for (let i = 0; i < variant; i++) obj[KEYS[i]] = i;
  obj.x = value;
  return obj;
};

const items = [];
for (let i = 0; i < 1024; i++) items.push(make(i % SHAPES, i));

const getX = (obj) => obj.x;

const run = () => {
  let sum = 0;
  for (let k = 0; k < 2000; k++) {
    for (let i = 0; i < items.length; i++) sum += getX(items[i]);
  }
  return sum;
};

run();
const begin = process.hrtime.bigint();
const result = run();
const ms = Number(process.hrtime.bigint() - begin) / 1e6;
console.log({ shapes: SHAPES, ms, result });
```

Shared closure context:

```js
// node --expose-gc closures.js leaky | clean
const leaky = () => {
  const big = new Array(100_000).fill(1);
  const log = () => big.length;
  log();
  return () => 1;
};

const clean = () => {
  const big = new Array(100_000).fill(1);
  const size = big.length;
  return () => size;
};

const factory = process.argv[2] === 'leaky' ? leaky : clean;
const handlers = Array.from({ length: 200 }, factory);
globalThis.gc();
const mb = process.memoryUsage().heapUsed / 1e6;
console.log(process.argv[2], mb.toFixed(1), 'MB', handlers.length);
```
