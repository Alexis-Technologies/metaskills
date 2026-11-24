---
name: js-multiparadigm
description: Choose and combine JS and TS paradigms (OOP, FP, declarative, metaprogramming). Use when designing modules or picking class vs closure
---

# Multi-paradigm JavaScript

Pick the paradigm per part of the program instead of per project. Default
split: aggregates and value objects for the domain, classes for system
abstractions, pure functions for transformations, declarative data for
configuration, and metaprogramming only in infrastructure.

|        | Library `@alexify/*`                             | App (`auth8`)                                    |
| ------ | ------------------------------------------------ | ------------------------------------------------ |
| Shape  | Flat `src/`: system classes and pure functions   | Onion + DDD, see `node-layered-architecture`     |
| Domain | None; the driver and policies are injected       | Aggregates guard invariants, services orchestrate |
| Data   | Plain records and `Map`s                         | One repository per aggregate over the native driver |

## Decision guide

| Part of the app | Default style | Avoid |
| --- | --- | --- |
| System code: transport, connection, stream, pool, queue, cache, buffer, data structure | Class with `#private` state, methods, a private emitter, `Symbol.dispose` | Deep hierarchies, mixins |
| Domain: aggregates, value objects, invariants | Aggregate root with methods that guard its invariants; pure calculation functions; throw domain errors | Rules repeated in services; aggregates that touch other aggregates; `request`/`reply` inside domain |
| Application: services | Short `async` method: load the aggregate, call it, save it, publish events | Business rules in the service; driver calls |
| Data transformation: parse, map, validate, report | Pure functions, `pipe`, loops in `src/` | Mutating inputs, array iteration methods in `src/` |
| IO edges: fs, net, db, timers, console | `async` functions at the boundary, IO passed in as dependencies; `.then` chains where they read better | IO calls scattered through the core |
| Configuration, routing, workflows, rules, schemas | Declarative data + small interpreter (DSL) | Behavior hard-coded in `if` chains; `eval` |
| Small private state: once, memoize, counters, wrappers | Closures | A class for one function |
| Value objects and containers: Money, Point, Result | Immutable class or frozen record; methods return new instances | Setters; mixing `return this` mutation with new instances |
| Concurrency boundaries | Stateless functions, message passing, actor (queue per state owner) | Shared mutable state; `SharedArrayBuffer` without a measured need |
| Infrastructure: loaders, DI, schema to validator/API generation | Introspection, `Symbol` keys, `Proxy`/`Reflect` | Metaprogramming in domain code or hot paths |

A stream or connection really is state + OS handle + behavior + events, so
encapsulation fits. A domain invariant ("a written-off batch never changes")
belongs to the aggregate that owns the data: it is a method there, never a
check copied into services. A rule that spans aggregates goes to a domain
service, and repositories and routes stay thin adapters around all of it.

## Rules

General:

- Decide the paradigm per module and keep one style inside one
  abstraction; mixing is fine between modules, not inside one object.
- Separate system code from domain code; domain modules must not import
  transport, framework, or driver objects - pass what they need.
- Pass dependencies as arguments (function params, constructor params, or a
  frozen context object); do not reach for module-level globals.
- Prefer the simplest construct: function, record, closure, then class.
- Keep business logic framework-agnostic: one service serves a Fastify
  route, a BullMQ worker and a `@alexify/wrpc` procedure.

Domain:

- Model each aggregate with one root that owns its invariants; other code
  changes it only through its methods. Reference other aggregates by id.
- A service orchestrates: it loads an aggregate through a repository
  interface, calls it, saves it. Pattern choice: `node-architecture-styles`.
- Keep stable shapes (same keys and order, `null` for empty references) for
  records that cross layers.
- Throw domain errors with a code. Use `Result` only in FP-style pipelines
  or system code with explicit error contracts.
- Do not mutate arguments; return new records, or document the mutation in
  the name (`applyDiscountInPlace`) when performance demands it.

OOP:

- Use `#private` fields and methods, a constructor that initializes all
  fields in one order, and static factories (`Point.of`, `Item.fromTuple`)
  for alternative construction.
- Prefer composition: hold collaborators in fields; inherit only from
  platform classes where the platform expects a subclass (`Error`,
  `Readable`, `Transform`) and keep hierarchies at most one level deep.
- Keep an `EventEmitter` in a `#private` field and expose `on`/`off`, so
  outsiders cannot `emit` (`node-events`).
- No classes with only static methods: export functions from a module.
- Do not create a class to call one method once; use a function.
- Immutable classes return a new instance from every operation.

Prototype-based and mixins:

- Use `Object.create(proto)` for prototype objects and a `Map` for dynamic
  keys; avoid `__proto__` and runtime `setPrototypeOf`.
- Do not use mixins (`Object.assign(target, Movable, Serializable)`): they
  change object shapes after creation (deopt), hide dependencies on `this`,
  collide silently on names, and duplicate behavior. Compose objects or
  call functions instead.
- A wrapper with extra operations (`memoize` with `clear`) returns an object
  literal (`{ call, clear }`) or is a small class, never a function with
  methods attached by `Object.assign` (`js-conventions`).

Functional:

- Keep functions pure where possible: output depends only on input, no
  hidden state, no IO; isolate the impure rest at the edges.
- Use non-mutating operations: `toSorted`, `toReversed`, `toSpliced`, `with`,
  spread, `structuredClone` for deep copies; `Object.freeze` is shallow.
- Without `'use strict'` a write to a frozen object fails silently (CommonJS
  libraries); in ESM and TypeScript it throws. Never rely on the throw.
- Use `pipe`/`compose` when a flow is a linear chain of unary steps;
  otherwise write point-style code with named intermediate variables.
- Use partial application (`(x) => fn(a, x)`) for a specialized function;
  avoid generic `curry`: `fn.length` ignores rest and default parameters.
- In `src/` of libraries and apps use loops, not `.map`, `.filter`,
  `.reduce`, `.forEach` and the like, and compute everything in one pass.
  Tests, scripts and benchmarks may use them where they state the semantic.
- In a container, `map` transforms into a new container and `tap` runs an
  effect and passes the same one on. Never put side effects in `map`.
- Do not build generic monad frameworks in TypeScript: a universal
  container loses the value type through `map`/`chain` and needs many
  overloads. Promise is already the practical monad; add `Result` or
  `Maybe` only where branching on failure replaces `if` chains.
- FP on class syntax (immutable instance, methods returning new instances)
  is as valid as FP on closures.

Declarative and metaprogramming:

- Describe configuration, routes, workflows, permissions, and schemas as
  data with one consistent step shape (`{ op, args }`), validate it, and
  execute it with a small interpreter.
- Generate repetitive code (validators, API stubs, typings) from metadata
  instead of hand-writing many similar functions. The schema source is
  `@alexify/metaschema` (`js-contracts-schemas`).
- Use `Symbol` (or `Symbol.for('app.name')` across modules/realms) for
  protocol and metadata keys that must not collide with data keys.
- Use native `Proxy` only for tooling, test doubles, read-only views, and
  dev-time tracing; not in hot paths (deopts). In traps, forward with
  `Reflect.*` and keep invariants (`set` returns boolean).
- A `Proxy` `apply` trap works only when the target is a function.

Native contracts:

- Implement the platform protocol instead of inventing method names:
  `[Symbol.iterator]`, `[Symbol.asyncIterator]`, `then`, `toJSON`,
  `[Symbol.toPrimitive]`, `[Symbol.dispose]`, `[Symbol.asyncDispose]`.
- Never add a `then` method to a data object or a prototype by accident:
  `await` and promise resolution adopt any thenable.
- See [references/native-contracts.md](references/native-contracts.md).

## Patterns

System object, aggregate, repository and service side by side. In a real
app each part lives in its own layer:

```js
const { EventEmitter } = require('node:events');

class Pool {
  #items = [];
  #free = [];
  #events = new EventEmitter();

  on(name, listener) {
    this.#events.on(name, listener);
  }

  off(name, listener) {
    this.#events.off(name, listener);
  }

  add(item) {
    this.#items.push(item);
    this.#free.push(item);
  }

  capture() {
    const item = this.#free.pop() ?? null;
    if (!item) this.#events.emit('exhausted');
    return item;
  }

  release(item) {
    if (!this.#items.includes(item)) throw new Error('Not from this pool');
    if (this.#free.includes(item)) throw new Error('Already released');
    this.#free.push(item);
  }
}

class DomainError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

// Domain: the aggregate guards its invariants
class Batch {
  #state;

  constructor(state) {
    this.#state = { ...state };
  }

  get price() {
    return this.#state.price;
  }

  writeOff(now) {
    const { status, expires } = this.#state;
    if (status !== 'active') throw new DomainError('Not active', 'EBATCHSTATE');
    if (expires >= now) throw new DomainError('Not expired', 'EBATCHFRESH');
    this.#state.status = 'writtenOff';
  }

  toRecord() {
    return { ...this.#state };
  }
}

// Infrastructure: one repository per aggregate over the native driver
const createBatchRepository = (collection) => ({
  findExpired: async (before) => {
    const filter = { status: 'active', expires: { $lt: before } };
    const documents = await collection.find(filter).toArray();
    const batches = [];
    for (const document of documents) batches.push(new Batch(document));
    return batches;
  },

  save: async (batch) => {
    const { id, rev, status } = batch.toRecord();
    const update = { $set: { status }, $inc: { rev: 1 } };
    const result = await collection.updateOne({ id, rev }, update);
    return result.matchedCount === 1;
  },
});

// Application: the service orchestrates and holds no business rule
const writeOffExpired = async ({ batches }, { before }) => {
  const expired = await batches.findExpired(before);
  let count = 0;
  let total = 0;
  for (const batch of expired) {
    batch.writeOff(before);
    const isSaved = await batches.save(batch);
    if (!isSaved) continue;
    count++;
    total += batch.price;
  }
  return { count, total };
};

module.exports = { Pool, Batch, createBatchRepository, writeOffExpired };
```

Each batch is one document, so `updateOne` is atomic, and the `rev` filter
stops a lost update: a concurrent writer makes `save` return `false`. Only a
write across aggregates needs
`withTransaction(client, async (session) => { ... })` from the DAL, with
`{ session }` in every repository call.

Pure transformations, composition, partial application:

```js
const pipe =
  (...fns) =>
  (x) => {
    let value = x;
    for (let i = 0; i < fns.length; i++) value = fns[i](value);
    return value;
  };

const partial =
  (fn, ...bound) =>
  (...args) =>
    fn(...bound, ...args);

const trim = (text) => text.trim();
const lower = (text) => text.toLowerCase();
const capitalize = (text) => text.replace(/(^|\s)\S/g, (head) => head.toUpperCase());

const normalizeName = pipe(trim, lower, capitalize);
const scale = (factor, value) => value * factor;
const double = partial(scale, 2);

console.log(normalizeName('  MARCUS AURELIUS '), double(21));
```

Isolate effects as "pure core, async shell": domain functions take data and
return data, the caller awaits `readFile` or a repository around them. A lazy
`IO` container is in [references/same-task-paradigms.md](references/same-task-paradigms.md).

Declarative steps executed by a tiny interpreter:

```js
const createPoint = (x, y) => Object.freeze({ x, y });

const pointOps = {
  create: (point, { x, y }) => createPoint(x, y),
  clone: (point) => createPoint(point.x, point.y),
  move: (point, { dx, dy }) => createPoint(point.x + dx, point.y + dy),
};

const execute = (ops, steps, log) => {
  let state = null;
  for (const { op, args = {}, trace = false } of steps) {
    if (!Object.hasOwn(ops, op)) throw new Error(`Unknown operation: ${op}`);
    state = ops[op](state, args);
    if (trace) log(`(${state.x}, ${state.y})`);
  }
  return state;
};

const steps = [
  { op: 'create', args: { x: 10, y: 20 }, trace: true },
  { op: 'clone' },
  { op: 'move', args: { dx: -5, dy: 10 }, trace: true },
];

execute(pointOps, steps, console.log);
```

`Object.hasOwn` matters when steps come from outside: `ops['constructor']`
is truthy on a plain object.

`Proxy` + `Reflect` for a read-only view, `Symbol` for metadata:

```js
const readOnly = (target, name = 'object') => {
  const deny = (obj, key) => {
    throw new TypeError(`Cannot change ${name}.${String(key)}`);
  };
  const get = (obj, key, receiver) => {
    const value = Reflect.get(obj, key, receiver);
    const isObject = typeof value === 'object' && value !== null;
    return isObject ? readOnly(value, `${name}.${String(key)}`) : value;
  };
  return new Proxy(target, { get, set: deny, deleteProperty: deny, defineProperty: deny });
};

const SCHEMA = Symbol.for('app.schema');
const User = { name: 'User', [SCHEMA]: { name: 'string', age: 'number' } };

const createValidator = (entity) => {
  const schema = entity[SCHEMA];
  const fields = Object.keys(schema);
  return (record) => {
    const problems = [];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const type = schema[field];
      if (typeof record[field] !== type) problems.push(`${field}: ${type} expected`);
    }
    return problems;
  };
};

const config = readOnly({ db: { port: 27017 } }, 'config');
console.log(config.db.port, createValidator(User)({ name: 'M', age: '4' }));
```

Do not wrap a frozen target: for its non-configurable properties the `get`
invariant forbids returning a proxy and the read throws.

More: the same task in a dozen styles with trade-offs in
[references/same-task-paradigms.md](references/same-task-paradigms.md);
`Result`, protocols and disposables in
[references/native-contracts.md](references/native-contracts.md).

## Anti-patterns

- God class mixing domain rules, IO and helpers - split by responsibility.
- `class Chunk { static encode() {} static decode() {} }` never
  instantiated - two exported functions.
- Inheritance chains for code reuse (`AdminUser extends User extends
  Entity`) - compose. `class Purchase extends EventEmitter` - a private
  emitter.
- Anemic aggregate: plain data with every rule in the services, so the
  same invariant is checked in several places, or not at all.
- Mixins assembled at runtime (`Object.assign(point, Movable, Clonable)`) -
  explicit composition; stable shapes.
- `let data; try { data = ... } catch {}` with a ternary afterwards - a
  promise chain or a helper returning a value:
  `readFile(path, 'utf8').then(JSON.parse).catch(() => DEFAULT_CONFIG)`.
- Side effects inside `map` (logging, writes) - use `tap` or a loop.
- Generic `curry` and point-free chains nobody can debug - named steps.
- A universal TypeScript `Monad<any>` for domain entities - aggregates, value
  objects, Promise and targeted `Result`.
- `arguments`, `bind`/`call`/`apply` juggling, `delete` on records, `for..in`
  on objects with prototypes - rest params, closures, `null` fields,
  `Object.keys`.
- `Proxy` around hot objects or as a hidden DI container - explicit
  wrappers (see GoF Proxy in `js-gof`).
- Objects that are thenable by accident (`{ then: ... }` in data) or
  patched prototypes (`Array.prototype.then = ...`).

## Checklist

- [ ] Each module has one dominant style matching the decision guide.
- [ ] Domain invariants live in the aggregate; no transport/framework types.
- [ ] System abstractions are classes with `#private` state, a private
      emitter where callers react, and cleanup (`close`, `Symbol.asyncDispose`).
- [ ] No static-only classes; no single-use classes; no mixins.
- [ ] Inheritance only from platform classes, at most one level.
- [ ] Pure functions do not mutate inputs; `src/` has no array iteration
      methods.
- [ ] IO is at the edges and injectable; core logic is testable without
      mocks of `fs`, `net`, or the db driver.
- [ ] Configuration/rules are data with a consistent shape plus a
      validator/interpreter.
- [ ] Protocols are implemented via well-known symbols / `then`; no
      accidental thenables; no prototype patching.
- [ ] `Proxy`/metaprogramming confined to infrastructure, not hot paths.

Related skills: `js-conventions` (style, shapes), `js-gof` (patterns, GoF
Proxy, Boxing), `js-solid-grasp`, `js-contracts-schemas`, `node-events`,
`node-layered-architecture`, `node-architecture-styles`, `node-data-access`,
`error-handling`, `js-async-patterns`.
