# The same task in different paradigms

One tiny task solved many ways: create a point `(10, 20)`, print it, clone
it, move the clone by `(-5, 10)`, print it. Identical behavior in every style
makes the trade-offs concrete. The point is a toy: in an app, a value with
rules is a value object or an aggregate (`node-architecture-styles`).

## Comparison axes and the default choice for Node.js app code

| Axis | Options | Default |
| --- | --- | --- |
| Control flow | statements, expressions, do-notation, declarative steps, pipe | Statements; `pipe` for linear transforms; declarative for config/workflows |
| State | mutable record, mutable shape, immutable, copy-on-write, stateless | Immutable values in domain/transforms; encapsulated mutable state in system objects |
| Context | objects (`this`), records + functions, closures, containers, modules | Aggregates in the domain; records + functions for data; closures for small private state; `this` only in classes |
| Branching | `if`, ternary, guards, lookup tables, pattern matching on tags | Guards with early return; object/Map lookup instead of `switch` chains |
| Iteration | loops, recursion, iterators/generators, streams | Loops (`for..of` in app code, indexed in libraries), no array iteration methods in `src/`; generators for lazy sequences; streams/async iterators for IO |
| Instantiation | `new`, factories/builders, closures, containers, cloning | Static factory or plain factory function; `structuredClone` for deep copies |
| Reuse | classes, interfaces, prototypes, mixins, composition, partial application | Composition and partial application; inherit only from platform classes |
| Asynchrony | callbacks, promises, async/await, futures, async compose, events, streams | `async`/`await` + promise combinators; events/streams for many values |
| Purity | pure functions, side effects, IO containers | Pure core, effects at the edges |
| Dependencies | arguments, DI, global namespace, service locator, modules | Arguments or constructor/context injection; no hidden globals |
| Errors | total functions, exceptions, codes, null objects, Result/Either | Exceptions in domain; `Result` only in FP pipelines; null objects for defaults |
| Effects | idempotent, order-sensitive, commutative | Make handlers idempotent where retries are possible |
| Transparency | hidden state vs referential transparency | Referentially transparent value objects |
| Caching | hash table, memoization | `Map` cache or `memoize` for pure functions only |
| Resources | manual `dispose`, RAII/`using`, regions | `try/finally` or `using`/`await using` with `Symbol.(async)Dispose` |
| Concurrency | shared memory, stateless, message passing (actors), locks | Stateless + message passing; locks/Atomics only for shared memory |
| Granularity | one-liners, long blocks, moderate | Moderate: small single-purpose functions, named steps |

## Procedural: records + procedures

Explicit data, explicit mutation. Fits scripts and small utilities. Rules
that guard state belong in an aggregate instead.

```js
const { DomainError } = require('./errors.js');

const validatePoint = (x, y) => {
  const errors = [];
  if (!Number.isFinite(x)) errors.push(new TypeError(`Invalid x: ${x}`));
  if (!Number.isFinite(y)) errors.push(new TypeError(`Invalid y: ${y}`));
  return errors;
};

const createPoint = (x, y) => {
  const errors = validatePoint(x, y);
  if (errors.length > 0) {
    const cause = new AggregateError(errors, 'Validation');
    throw new DomainError('Bad coordinates', { code: 'ALX_ERR_VALIDATION', cause });
  }
  return { x, y };
};

const clone = ({ x, y }) => createPoint(x, y);
const move = (point, dx, dy) => {
  point.x += dx;
  point.y += dy;
};
const toString = ({ x, y }) => `(${x}, ${y})`;

const p1 = createPoint(10, 20);
console.log(toString(p1));
const c1 = clone(p1);
move(c1, -5, 10);
console.log(toString(c1));
```

The validation shape (collect errors, throw a `DomainError` with the code
`ALX_ERR_VALIDATION` and an `AggregateError` cause; the class is the one in
`error-handling`) is the same in every variant; the rest of this file omits it
for brevity. Invalid input is an expected outcome, not a bug, so it carries a
code the boundary maps.

## OOP: class with private fields

Encapsulation and identity. Best for system abstractions and aggregates.

```js
class Point {
  #x;
  #y;

  constructor(x, y) {
    this.#x = x;
    this.#y = y;
  }

  move(dx, dy) {
    this.#x += dx;
    this.#y += dy;
  }

  clone() {
    return new Point(this.#x, this.#y);
  }

  toString() {
    return `(${this.#x}, ${this.#y})`;
  }
}

const p1 = new Point(10, 20);
console.log(p1.toString());
const c1 = p1.clone();
c1.move(-5, 10);
console.log(c1.toString());
```

Variant to avoid: a class with only `static move(point)`,
`static toString(point)` - that is procedural code with extra syntax.

## Prototype-based: shared behavior object

Delegation without classes; same runtime model as classes.

```js
const PointPrototype = {
  move(dx, dy) {
    this.x += dx;
    this.y += dy;
  },
  clone() {
    return createPoint(this.x, this.y);
  },
  toString() {
    return `(${this.x}, ${this.y})`;
  },
};

const createPoint = (x, y) => {
  const point = Object.create(PointPrototype);
  point.x = x;
  point.y = y;
  return point;
};

const c1 = createPoint(10, 20).clone();
c1.move(-5, 10);
console.log(`${c1}`);
```

## Closure: private state without `this`

Lightweight encapsulation; each instance allocates its own functions, so
use it for few long-lived objects, not millions of values.

```js
const createPoint = (ax, ay) => {
  let x = ax;
  let y = ay;
  const move = (dx, dy) => {
    x += dx;
    y += dy;
  };
  const clone = () => createPoint(x, y);
  const toString = () => `(${x}, ${y})`;
  return { move, clone, toString };
};

const c1 = createPoint(10, 20).clone();
c1.move(-5, 10);
console.log(c1.toString());
```

## FP: frozen records + pure functions

No mutation: `move` returns a new point. Best for transformations.

```js
const createPoint = (x, y) => Object.freeze({ x, y });
const move = ({ x, y }, dx, dy) => createPoint(x + dx, y + dy);
const toString = ({ x, y }) => `(${x}, ${y})`;

const p1 = createPoint(10, 20);
const c1 = move(p1, -5, 10);
console.log(toString(p1), toString(c1));
```

A namespace object (`point.create`, `point.move`) is the same style with
grouping; it is fine when the module exports several entity namespaces.

## FP: single-argument functions and a mappable value

Curried constructors and a value exposing only `map`. Shows how functors
work; rarely worth it in application code.

```js
const createPoint = (x) => (y) => ({ map: (fn) => fn({ x, y }) });
const move =
  (dx) =>
  (dy) =>
  ({ x, y }) =>
    createPoint(x + dx)(y + dy);
const toString = ({ x, y }) => `(${x}, ${y})`;

const p1 = createPoint(10)(20);
console.log(p1.map(toString), p1.map(move(-5)(10)).map(toString));
```

## Tagged union + pattern matching

Dispatch by a `tag` field through a handler table - the JavaScript
replacement for `switch` over types.

```js
const match = (variant, handlers) => handlers[variant.tag](variant);

const shapes = [
  { tag: 'point', x: 10, y: 20 },
  { tag: 'circle', x: 0, y: 0, r: 5 },
];

for (const shape of shapes) {
  const text = match(shape, {
    point: ({ x, y }) => `point (${x}, ${y})`,
    circle: ({ r }) => `circle r=${r}`,
  });
  console.log(text);
}
```

## Container with `map`, `chain`, `ap`, `tap`

`map` transforms into a new container, `chain` flattens a function that
already returns a container, `ap` applies a contained function, `tap` runs
a side effect and returns the same container.

```js
class Box {
  #value;

  constructor(value) {
    this.#value = value;
  }

  static of(value) {
    return new Box(value);
  }

  map(fn) {
    return Box.of(fn(this.#value));
  }

  chain(fn) {
    return fn(this.#value);
  }

  ap(container) {
    return container.map(this.#value);
  }

  tap(fn) {
    fn(this.#value);
    return this;
  }
}

const move = (dx, dy) => (p) => ({ x: p.x + dx, y: p.y + dy });
const toString = ({ x, y }) => Box.of(`(${x}, ${y})`);

const p1 = Box.of({ x: 10, y: 20 });
p1.chain(toString).tap(console.log);
Box.of(move(-5, 10)).ap(p1).chain(toString).tap(console.log);
```

## IO container: lazy effects

Nothing runs until `run()`, so tests replace `readPoint` and `writeLine`.
Serialization is pure and stays outside IO.

```js
class IO {
  #effect;

  constructor(effect) {
    this.#effect = effect;
  }

  static of(effect) {
    return new IO(effect);
  }

  map(fn) {
    return new IO(() => fn(this.#effect()));
  }

  chain(fn) {
    return new IO(() => fn(this.#effect()).run());
  }

  run() {
    return this.#effect();
  }
}

const createPoint = (x, y) => Object.freeze({ x, y });
const move = (dx, dy) => (point) => createPoint(point.x + dx, point.y + dy);
const toString = ({ x, y }) => `(${x}, ${y})`;

const readPoint = () => IO.of(() => createPoint(10, 20));
const writeLine = (text) => IO.of(() => console.log(text));

const program = readPoint().map(move(-5, 10)).map(toString).chain(writeLine);
program.run();
```

## Actor: state owned by a message queue

Serializes access to state without locks; the transport (in-process
queue, worker `postMessage`, network) can change without touching the
entity.

```js
class Actor {
  #queue = [];
  #processing = false;
  #state;

  constructor(Entity, ...args) {
    this.#state = new Entity(...args);
  }

  send(method, ...args) {
    return new Promise((resolve, reject) => {
      this.#queue.push({ method, args, resolve, reject });
      this.#process();
    });
  }

  async #process() {
    if (this.#processing) return;
    this.#processing = true;
    while (this.#queue.length > 0) {
      const { method, args, resolve, reject } = this.#queue.shift();
      try {
        resolve(await this.#state[method](...args));
      } catch (error) {
        reject(error);
      }
    }
    this.#processing = false;
  }
}

class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }

  move(dx, dy) {
    this.x += dx;
    this.y += dy;
  }

  toString() {
    return `(${this.x}, ${this.y})`;
  }
}

const main = async () => {
  const point = new Actor(Point, 10, 20);
  await point.send('move', -5, 10);
  console.log(await point.send('toString'));
};

main();
```

## Reactive: observable value

Push-based: subscribers are notified on change; `map` derives a new
observable.

```js
class Observable {
  #value;
  #subscribers = new Set();

  constructor(value) {
    this.#value = value;
  }

  subscribe(fn) {
    this.#subscribers.add(fn);
    fn(this.#value);
    return () => this.#subscribers.delete(fn);
  }

  next(value) {
    this.#value = value;
    for (const fn of this.#subscribers) fn(value);
  }

  map(fn) {
    const derived = new Observable(fn(this.#value));
    this.subscribe((value) => derived.next(fn(value)));
    return derived;
  }
}

const point = new Observable({ x: 10, y: 20 });
const text = point.map(({ x, y }) => `(${x}, ${y})`);
const unsubscribe = text.subscribe(console.log);
point.next({ x: 5, y: 30 });
unsubscribe();
```

## Lazy: values computed on access

Getters as functions defer work and compose transformations without
computing intermediate states.

```js
const createPoint = (x, y) => ({ x: () => x, y: () => y });
const move = (point, dx, dy) => ({
  x: () => point.x() + dx,
  y: () => point.y() + dy,
});
const toString = (point) => `(${point.x()}, ${point.y()})`;

console.log(toString(move(createPoint(10, 20), -5, 10)));
```

## Shared memory: typed array + Atomics

Only when state must be shared between worker threads
(`postMessage` shares a `SharedArrayBuffer` by reference; it is neither
copied nor put in the transfer list).

```js
const createPoint = (x, y) => {
  const view = new Int32Array(new SharedArrayBuffer(8));
  view[0] = x;
  view[1] = y;
  const move = (dx, dy) => {
    Atomics.add(view, 0, dx);
    Atomics.add(view, 1, dy);
  };
  const toString = () => {
    const x = Atomics.load(view, 0);
    const y = Atomics.load(view, 1);
    return `(${x}, ${y})`;
  };
  return { move, toString, buffer: view.buffer };
};

const point = createPoint(10, 20);
point.move(-5, 10);
console.log(point.toString());
```

## Aspect: wrap methods with before/after advice

Cross-cutting logging/metrics without editing the class; keep it for
infrastructure (tracing), never for business rules.

```js
const withAdvice =
  (fn, { before, after }) =>
  (...args) => {
    before?.(...args);
    const result = fn(...args);
    after?.(result, ...args);
    return result;
  };

class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }

  move(dx, dy) {
    this.x += dx;
    this.y += dy;
  }
}

const point = new Point(10, 20);
const move = (dx, dy) => point.move(dx, dy);
const after = () => console.log(`moved to (${point.x}, ${point.y})`);
const tracedMove = withAdvice(move, { after });

tracedMove(-5, 10);
```

Wrap at the call site. Patching `Point.prototype` at runtime changes every
instance and invalidates inline caches (`js-conventions`).

## Exercises

- Rewrite a mutable `Adder` (`add` mutates and returns `this`) into an
  immutable class (`Adder.create(1).add(9)`), then into closures, then into
  a mutable closure; compare which callers break. Immutable versions:

```js
class Adder {
  #value;

  constructor(value) {
    this.#value = value;
  }

  static create(value) {
    return new Adder(value);
  }

  add(x) {
    return new Adder(this.#value + x);
  }

  valueOf() {
    return this.#value;
  }
}

const createAdder = (value) => ({
  add: (x) => createAdder(value + x),
  valueOf: () => value,
});

const base = Adder.create(1);
console.log(+base.add(9).add(7), +base, +createAdder(1).add(9).add(7));
```

- Rewrite the nested-object `execute({ read, then: { match, success,
  fail } })` interpreter into OOP and fix its inconsistent step shapes.
- Implement `Future` with `map`, `chain`, `fork` over callback APIs
  (`futurify(fs.readFile)`).
- Rewrite the same examples with a fixed `Monad` (`of`, `map`, `chain`,
  `ap`) without changing the monad.
