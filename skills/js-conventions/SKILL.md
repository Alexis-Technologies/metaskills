---
name: js-conventions
description: Alexis JS and TS code style for naming, modules, iteration, async, performance. Apply when writing or reviewing .js, .mjs, .cjs, .ts or .d.ts files
---

<!-- Adapted from metaskills v1.0.6 (skills/js-conventions) for the Alexis toolchain:
     oxlint + oxfmt instead of ESLint + Prettier, pnpm instead of npm, 100 or 120 columns, from
     `.oxfmtrc.json`, instead of 80, no 'use strict', and loops in one pass instead of array
     iteration methods in src/. -->

# JavaScript conventions

Apply on every JavaScript or TypeScript change. Prefer readability unless the
task has a measured reason to do otherwise. See [examples.md](examples.md) to
compare code before and after applying most rules. Read
[performance.md](performance.md) for library or system code (runtimes, parsers,
protocols, I/O) or a measured hot path, and benchmark exceptions on the target
runtime.

## Preparations

- Linting is oxlint (`.oxlintrc.json`) and formatting is oxfmt (`.oxfmtrc.json`, `.editorconfig`);
  never add ESLint or Prettier
- The package manager is pnpm (pinned in `packageManager`); never use `npm` commands or create
  `package-lock.json`
- Use the scripts of `package.json`: `pnpm lint`, `pnpm format`, `pnpm format:check`, `pnpm test`
- Run `pnpm lint` and `pnpm test` before and after changing code with AI. Finish only when lint,
  format, and test checks pass
- Run `pnpm format` before fixing remaining issues by hand. Suppress a rule only for an intentional
  construct, with a targeted `// oxlint-disable-next-line <rule>`
- Preserve the existing module system, source and declaration file types, and
  package layout unless the task asks to change them. Before adding a file, read one of its kind
  nearby and repeat its shape and names
- Resolve runtime packages from the registry (or the project's declared source of truth), not from sibling `file:` links in a gitignored lockfile that other machines will not have

## Project profile

Read `package.json`, `.oxlintrc.json`, `.oxfmtrc.json`, and `.editorconfig` first: the project's configuration wins over the defaults here.

|              | Library (`@alexify/*`)                              | App                                  |
| ------------ | --------------------------------------------------- | ------------------------------------ |
| Modules      | CommonJS, handwritten `.d.ts`                       | ESM, TypeScript, NodeNext            |
| Tests        | `node:test`, c8, `should` titles                    | Vitest (AAA, `should` titles, fakes) |
| Runtime deps | None                                                | Allowed                              |
| Architecture | `src/` by subpath or feature, kebab-case file names | Onion + DDD                          |

## Formatting

For writing new code use single quotes, semicolons, trailing commas in multiline arrays, objects, and parameters, and one blank line between semantic blocks. Keep lines within the project's `printWidth` (100 or 120) except URLs. Let oxfmt and `.editorconfig` handle spacing and indentation (2 spaces, LF). Braces follow oxlint `curly: multi-line`: none for a body on the line of its `if` or loop, braces once it wraps.

## Naming

- Use `camelCase` for variables and parameters
- Use `UpperCamelCase` for classes and types
- Use `UPPER_SNAKE_CASE` for global constants
- Use `new` only with capitalized constructor names
- Prefer full words for all identifiers (`error`, not `err`). Use a short or
  single-letter name only when a familiar convention makes its meaning clear
  in a small scope, such as `i` and `j` for loop indexes, `x` and `y` for
  coordinates, or `a` and `b` in a short comparator. Otherwise use a name that
  states the role, such as `event`, `index`, or `item`
- Use boolean prefixes: `is`, `has`, `can`, `should`. Public API properties keep their API names without them (`closed`, `streaming`)
- Use singular names for entities and plural names for collections
- Use verb names for functions and handlers (`parse`, `create`, `handle`, `on`)
- Include units in numeric names (`timeoutMs`, `sizeBytes`) except options

## How to think

Apply these habits before picking an algorithm, a pattern, or a comment.

- **Data first.** Decide how values sit in memory and relate (string of chars, array or set of tokens, map of aliases, record with a stable object shape, graph, etc). Then write the walk. Do not invent a procedure and then hunt for a structure that fits it
- **Contracts.** Name what the function owns. Inputs are read-only, shared data can be changed just by its owners, unless the contract or tasks requires different approach
- **Name the steps.** Replace nested calls, concatenations, wrapped conditions, and fat object or argument literals with decomposed intermediate named identifiers plus their combinations/compositions/bindings. Each line says what a value _is_. Combine everything to one-line call, a one-line expressions, or a short return if possible
- **Split, then compose.** Break a hard piece into named parts and combine them where the whole reads at once. Isolate semantic complexity (protocol cases, scoring, aliases, special forms) in one table or one function, not in scattered `if`s, and not in a new layer "for Big-O". Computational cost matters in a hot path; unreadability is the default cost to minimize
- **Least accidental complexity.** Identifiers, calls, loops, conditions, expressions and other constructions carry the meaning, comments gives noice in most cases. Among working solutions pick the one with fewer bags, fewer indirections, and no patterns the data does not demand

## Modules

Order in the file and in the export list:

1. imports / requires
2. constants (literals, regexes, maps, lists, loaded assets)
3. functions (`const` arrows; no bare `function`)
4. classes
5. exports (in the order they appear in the file)

- Library types and the JSDoc of the public API go in a sibling handwritten `.d.ts`
- Alexis libraries are CommonJS: `require` and `module.exports`, no `import` / `export` in `.js` sources
- In TypeScript use `as const` objects, not `enum`
- Do not add `'use strict'` unless the project already uses it
- Node builtins always use the `node:` prefix: `require('node:fs')`, not `require('fs')`
- Packages: bare specifier, no extension
- Relative paths always include the extension (`.js` / `.cjs` / `.mjs`); prefer `./dir/moduleName.js` over `./dir`
- Named exports at the bottom (inline `export` only when the project already does that)
- One module per import/require statement; oxfmt decides the line breaks
- One blank line between Node builtins, npm packages, and project modules
- A file laid out this way, CommonJS and ESM: [examples.md](examples.md#module-head-and-tail)

## Expressions

- Use intermediate identifiers; one expression per line when it fits
- An assignment that wraps only because of length gets a named piece so it fits on one line. A chain that still does not fit becomes separate named steps, never one overlong line
- Use `===` and `!==` only. Null or undefined is `x === undefined || x === null`; one comparison when the kind is known
- Object shorthand: write `{ width }`, not `{ width: wrapWidth }`. Rename the local to match the field (`wrapWidth` to `width`); do not add an alias like `const width = wrapWidth`

## Variables and empty values

- Prefer `const`, minimize `let`, never use `var`
- Every `let` has an initial value of its own type: `''` for strings, `0` or `-1` for numbers, `false` for flags, `null` for objects and other references. Never `let value;`. When every path assigns before the read, bind `const` once instead (a one-line ternary or a function that returns the value)
- An absent value keeps its kind: `null` stands in for an object or other reference (instance, result object, callback, buffer), `undefined` stands in for a scalar (number, string, boolean). Never mix primitives and objects in one variable
- Clear a field by assigning `null` or `undefined` by the same rule. `delete` only removes a key of a dictionary or of data where a missing key means something, never of a record or instance
- Hot numeric fields are the one exception: see [performance.md](performance.md)

## Control flow

- A simple `cond ? left : right` is fine on one line. No nested ternaries: use `if` / `else if` / `else`
- A ternary evaluates one side. When expanding it into statements, call or mutate only the taken side; never compute the unused side and overwrite it
- A condition that wraps (`||`, `&&`, a chain of `===`) becomes a named boolean or a module-level `Set` (`KEYS.has(value)`), so the `if` stays one line
- An `if` chain that only picks a value, a list, or a small function is a lookup table: a module-level constant, read by a function that only chooses the key. Flags on the same case become extra keys, chosen before the lookup
- Avoid deep callback nesting
- Call-then-return is `return void fn(...)` (lint keeps `no-void` off). Never `void` with `await`

```js
const onEntry = async (done, isDirectory, entryPath) => {
  if (done) return void finish(null);
  if (isDirectory) {
    await reload(entryPath);
    return;
  }
  await open(entryPath);
};
```

## Functions

- Prefer arrow functions (except class methods). Avoid `arguments`
- Keep functions small and single-purpose; keep return types consistent
- The signature is one line. Keep defaults in the parameter list when it fits (`start(options = {})`); when they would wrap it, drop them and apply `??` on the first lines of the body
- An expression body only for a function that fits on one line. Anything else is a `{ }` block of named steps. Do not wrap a lone `return expr` in a block (`arrow-body-style: as-needed` unwraps it)

**Grain.** A dispatcher (token loop, protocol loop, key/event handler) reads as "what is this case?". Extract the stages a human would look up: span readers returning `{ text, end }`, classifiers, pipelines (`tokenize` then `pack`), lookup tables (`HANDLERS`, `KEY_BINDS`). The loop only combines them.

Do not over-split: no function per short `if` branch, no one-function-per-case split of a sequential event loop, no `context` bag inside a module unless nested helpers already close over many locals. Aim for 40-90 lines per dispatcher and 10-40 per helper. A function that is long because it is a sequential protocol stays long. Do not add a cache, a class, or an indirection to "simplify" what a table already states.

## Classes

- Use a class when state and methods belong together (session, connection, scheduler, state machines, mutual recursion over instance state)
- Instance methods, not `method = () => {}` fields
- Dispatch tables are module-level constants, not `static` fields, unless inheritance needs them
- Event listeners: keep the listener reference and remove it with `off`. Use
  `events.addAbortListener` to connect cleanup to an `AbortSignal`; pass
  `{ signal }` only to APIs that document it. No `.bind(this)` or arrow-field
  methods

## Data

Read the `js-data-structures` skill before choosing a collection or designing
lookup, membership, or alias structures.

**Do not mutate parameters.** Copy when the result must be reordered or filled (`entries.toSorted(byName)` on Node 20+, not `entries.sort(byName)`); mutate only instance fields or a buffer the caller handed over to fill.

**Coercion.** For unknown input: strings pass through, `null` / `undefined` become `''`, anything else `` `${value}` ``. Never `new String`; `String(value)` only where the value may be a symbol (a template literal throws). Digit width of a number is `` `${count}`.length ``, not the text helper.

**Reuse before rewriting.** When a dependency the project already has, or a sibling module, gives the same result, call it instead of a local clone (`jsonParse` instead of `try` / `catch` around `JSON.parse`); keep local code when the result differs (sync vs async, UTC vs local time, throw vs null, another fallback). A library adds no dependency for it.

## Iteration

Choose iteration by data type, code layer, and whether the path is hot:

- Copy: `list.slice()` or `[...list]`. Reorder with `toSorted` / `toReversed` / `with` where `engines` is Node 20+; on Node 18 copy, then `sort` in a statement of its own. Concat: `a.concat(b)`. Avoid `[...a, ...b]`
- No array destructuring in library `src/` (assignments, parameters, loops): read by index, `const name = pair[0]`, `const rest = list.slice(1)`. Apps and tests may destructure arrays; object destructuring is fine
- Loops depend on the layer:
  - Library and system code (runtimes, parsers, protocols, I/O, hot paths): C-like `for (let i = 0; i < list.length; i++)` over arrays. Dynamic-key collections are `Map`s: `for...of` over `map.values()` or `map.keys()` for one side, `for (const entry of map)` reading `entry[0]` / `entry[1]` for both; `keys()` plus `get` only on a measured hot path. A plain object the code receives (options, headers) is walked with `const keys = Object.keys(obj)` and an index loop
  - Domain and application code: `for...of` over arrays and `Map`, `for...in` over plain data objects, for readability; `Object.values` and `Object.entries` outside hot paths
  - Both: `for...of` for `Set`, generators, streams, and code points of a string. No `Object.entries` or `Object.values` in hot paths or library `src/`
- In `src/` of libraries and apps use no array iteration methods (`.map`, `.filter`, `.some`, `.every`, `.find`, `.findIndex`, `.findLast`, `.reduce`, `.flatMap`, `.forEach`), cold paths included. Compute everything a collection gives in one pass with an early exit; never chain passes (`.map().join()`, `Array.from().map()`), and do not build an array only to iterate it
- Tests, scripts, and benchmarks may use array iteration methods where they state the semantic. A `.forEach` callback that reads or writes outer variables (accumulators, flags, counters) is a loop instead
- Spread an iterable only when it really is one (`[...set]`, `[...string]` for code points) and `Array.from` does not read better
- Keep escaping allocations out of hot loops: spread, rest, closures created per iteration, and arrays or objects that outlive the call; move reusable callbacks outside loops. Small result objects that do not leave an inlined function (`{ text, end }` from a span reader) are removed by escape analysis and are fine. `try` / `catch` does not deoptimize: place it where the error handling belongs
- For measured allocation concerns and runtime-specific exceptions, read
  [performance.md](performance.md). Keyed data in each layer: [examples.md](examples.md#walking-keyed-data)

## Object shapes and hidden classes

- A constructor or factory defines the whole object shape. Initialize every
  field once, in the same order, with a stable type so V8 can reuse one hidden
  class. After creation, do not add or delete fields, apply mix-ins, use
  `Object.assign` on an instance, or call `setPrototypeOf`. Only hash-table
  objects may grow and shrink
- Give every instance every field (`null`, `0`, `''`, or `false` when unused).
  Never add a field only to some instances. V8 sizes objects from the first
  instances (slack tracking) and stores later fields outside the object, behind
  an extra indirection
- `delete`, `Object.create(null)` and a `{ __proto__: null }` literal put an
  object in dictionary mode: properties use a hash table, with no hidden-class
  inline cache or `for...in` enumeration cache. That is right for dictionaries
  and tables keyed by user or peer input (no prototype keys to collide with)
  and wrong for records: records and prototypes stay literals or classes, and
  a record field is never deleted. A fixed lookup table is an object literal,
  or `{ __proto__: null, ... }` when keys come from input
- Prototypes are set up once at module load and never changed afterwards: no methods added or deleted at runtime (deleting counts as a change), never touch `Object.prototype` or other built-in prototypes. Each change invalidates every cached lookup below it. Metaprogramming that generates a class or prototype runs at module load too

Library/system code and hot paths also follow [performance.md](performance.md): V8 inline caches, element kinds, numeric fields, module state, `JSON.stringify` fast path, and how to measure.

## Async

- Native promises, `async` / `await` by default; no promise libraries. `.then` is
  fine where it reads better (a bridge, a short chain, fire-and-forget with
  `.catch`). Awaited call sites appear in async stack traces
- `await` only real promises in hot paths; awaiting a plain value still allocates a wrapper promise

## Docs and comments

- In `src/` names and control flow are the documentation, and a comment says why: a gotcha, a historical bug, "do not simplify", a protocol or magic number, empty-`catch` intent (`// ignore`). Public API documentation is JSDoc in the handwritten `.d.ts`
- Remove comments that restate the next line, noisy section banners, and JSDoc in `src/` that repeats names or types. A JSDoc block says what the signature cannot. Never add comments to mark a style edit
- User-facing help goes in markdown tables (or other structured docs) next to the feature, not in long string literals. Keep it in sync with the real dispatch tables and special cases. Drop redundant aliases in docs and code unless the product intentionally keeps them
