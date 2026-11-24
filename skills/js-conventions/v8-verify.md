# Verifying V8 behaviour (Node.js 24, V8 13.6)

Use these tools in scratch scripts to confirm a shape, elements kind, or
optimization claim before changing production code. Code containing `%` calls
is a `SyntaxError` without `--allow-natives-syntax`; never commit it to
application code, never enable the flag in production.

## Natives (`node --allow-natives-syntax file.js`)

| Call | Returns / does |
| --- | --- |
| `%HaveSameMap(a, b)` | `true` if both objects currently share a hidden class |
| `%HasFastProperties(obj)` | `false` once the object is in dictionary mode |
| `%DebugPrint(value)` | Map address, elements kind, properties, field representations |
| `%HasSmiElements(arr)`, `%HasDoubleElements(arr)`, `%HasObjectElements(arr)` | Elements kind family |
| `%HasHoleyElements(arr)`, `%HasDictionaryElements(arr)` | Holey or sparse storage |
| `%IsSmi(value)` | Unboxed small integer? |
| `%GetOptimizationStatus(fn)` | Bit field, see below |
| `%PrepareFunctionForOptimization(fn)` | Required before forcing optimization |
| `%OptimizeFunctionOnNextCall(fn)` | Force TurboFan on next call |
| `%OptimizeMaglevOnNextCall(fn)` | Force Maglev on next call |
| `%NeverOptimizeFunction(fn)` | Keep a function out of optimizing tiers (use this, not the old "wrap in `try {}`" trick) |
| `%DeoptimizeFunction(fn)` | Throw away optimized code |

`%HaveSameMap` does not migrate deprecated maps; read a property of each object
before comparing if you changed field types.

## Optimization status bits (V8 13.6)

| Bit | Value | Meaning |
| --- | --- | --- |
| 0 | 1 | is a function |
| 1 | 2 | never optimize |
| 2 | 4 | always optimize |
| 3 | 8 | maybe deopted |
| 4 | 16 | optimized (any tier) |
| 5 | 32 | Maglev code |
| 6 | 64 | TurboFan code |
| 7 | 128 | interpreted (Ignition) |
| 8 | 256 | marked for optimization |
| 9 | 512 | marked for concurrent optimization |
| 10 | 1024 | optimizing concurrently |
| 11 | 2048 | is executing |
| 12 | 4096 | topmost frame is TurboFan |
| 13 | 8192 | lite mode |
| 14 | 16384 | marked for deoptimization |
| 15 | 32768 | baseline (Sparkplug) code |

Older bit tables predate Maglev and Sparkplug and no longer match. Helper:

```js
const STATUS_BITS = [
  'function', 'never', 'always', 'maybeDeopted', 'optimized', 'maglev',
  'turbofan', 'interpreted', 'marked', 'markedConcurrent', 'optimizing',
  'executing', 'topFrameTurbofan', 'lite', 'markedDeopt', 'baseline',
];

const optStatus = (fn) => {
  const status = %GetOptimizationStatus(fn);
  return STATUS_BITS.filter((name, bit) => (status & (1 << bit)) !== 0);
};

const sum = (a, b) => a + b;

%PrepareFunctionForOptimization(sum);
sum(1, 2);
sum(3, 4);
%OptimizeFunctionOnNextCall(sum);
sum(5, 6);
console.log(optStatus(sum)); // [ 'function', 'optimized', 'turbofan' ]
sum('a', 'b');
console.log(optStatus(sum)); // [ 'function', 'interpreted' ]
```

## Trace flags

| Flag | Shows |
| --- | --- |
| `--trace-opt` | Tier-up decisions: `marking ... for optimization to MAGLEV`, then `TURBOFAN_JS`, with reason `hot and stable` |
| `--trace-deopt` | `bailout (kind: deopt-eager, reason: wrong map)` and the function name |
| `--trace-deopt-verbose` | Deopt with bytecode position and frame translation |
| `--trace-file-names` | Adds file names to opt/deopt traces |
| `--trace-turbo-inlining` | `Inlining <fn> into <caller>` lines; confirms what was inlined |
| `--trace-elements-transitions` | Array elements kind transitions |
| `--trace-generalization`, `--trace-migration` | Field representation generalization and map migration |
| `--log-ic` | IC state transitions into `v8.log` (view with V8's ic-processor / Indicium) |
| `--print-bytecode --print-bytecode-filter=name` | Ignition bytecode of one function |
| `--max-valid-polymorphic-map-count` | Polymorphic IC limit (default 4) |
| `--max-inlined-bytecode-size` | Inlining budget per callee (default 460 bytes) |

Typical deopt reasons and what to change:

- `wrong map`: an object with another shape reached optimized code. Find where
  that object is built (different key order, late key, other constructor).
- `not a Smi`, `not a Number`, `not a String`: argument or field type changed;
  normalize types at the boundary.
- `out of bounds`, `hole`: reading past `length` or from a holey array; check
  loop bounds and array construction.
- `Insufficient type feedback for ...`: code optimized before it saw this path
  (often OSR of top-level loops); usually harmless, warm up realistic paths.
- A function that deopts and re-optimizes repeatedly (look for the same name in
  many bailout lines) is the real problem; one deopt during warm-up is normal.

## Workflow

1. Extract the hot function and a realistic input generator into a scratch
   file (never edit the production module for experiments).
2. Warm it up with realistic data, then print `optStatus(fn)`.
3. Run with `--trace-opt --trace-deopt --trace-file-names` and grep for the
   function name.
4. Check shapes of the inputs with `%HaveSameMap` / `%DebugPrint`.
5. Change one thing, re-run the trace and an isolated benchmark
   (`node-performance-profiling`), keep the change only if both improve.
