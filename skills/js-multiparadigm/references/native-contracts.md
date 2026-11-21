# Native contracts in JavaScript and Node.js

Contracts the language and platform already understand. Implement them
instead of inventing method names, and know which ones a value satisfies
by accident.

| Contract | Shape | Consumed by |
| --- | --- | --- |
| Callable | function, method, arrow, class constructor, `Proxy` over a function | `fn()`, `Reflect.apply` |
| Callback-last-error-first | `(...args, (error, result) => {})`, `error` is `Error` or `null` | `util.promisify`, legacy Node APIs |
| Thenable | object with `then(onFulfilled, onRejected)` | `await`, `Promise.resolve`, promise chains |
| Promise | thenable with `catch`, `finally` | combinators: `all`, `allSettled`, `any`, `race` |
| Iterable / Iterator | `[Symbol.iterator]()` returning `{ next, return?, throw? }` | `for..of`, spread, destructuring, `Array.from`, `Map`/`Set` constructors |
| Async iterable | `[Symbol.asyncIterator]()` returning async `next` | `for await`, `Readable.from`, `Array.fromAsync` |
| Generator | `function*` / `async function*`, produces an iterator with `next`, `throw`, `return` | as above |
| Array-like | indexed keys + numeric `length`, no array methods | `Array.from` |
| Observable | `addEventListener`/`dispatchEvent` (EventTarget) or `on`/`emit` (EventEmitter) | `events.once`, `events.on` |
| Stream | Node `Readable`/`Writable`/`Transform` or Web `ReadableStream` with backpressure | `stream/promises.pipeline`, `for await` |
| Transferable | `ArrayBuffer`, `MessagePort`, `FileHandle`, ... moved between threads | `postMessage(value, [transfer])`, `structuredClone(v, { transfer })` |
| Disposable | `[Symbol.dispose]()` / `[Symbol.asyncDispose]()` | `using`, `await using` |
| Conversion | `[Symbol.toPrimitive](hint)`, `toJSON()`, `toString()` | template literals, `+x`, `JSON.stringify` |

## Callable

Only functions are callable. A `Proxy` can intercept calls only if its
target is a function; there is no way to give a plain object a call
operator. `this` itself can be a function when a callable is bound as
context.

```js
const callable = (...args) => args.length;

const traced = new Proxy(callable, {
  apply(target, thisArg, args) {
    const result = Reflect.apply(target, thisArg, args);
    console.log(`call(${args.join(', ')}) -> ${result}`);
    return result;
  },
});

traced(1, 2, 3);

try {
  const notCallable = new Proxy({}, { apply: () => 0 });
  notCallable();
} catch (error) {
  console.log(error.constructor.name, error.message);
}

const createCounter = (initial) => {
  let count = initial;
  const inc = (delta = 1) => (count += delta);
  return { inc, value: () => count };
};

const counter = createCounter(10);
counter.inc();
counter.inc(5);
console.log(counter.value());
```

A wrapper with extra operations (`once`, `memoize` with `clear`) returns an
object literal like this one. Do not attach methods to a function with
`Object.assign`: `js-conventions` bans it on instances.

## Callback-last-error-first

The async callback convention: callback is the last argument, error is the
first callback argument (`null` on success). Convert at the edge, then use
promises.

```js
const { promisify } = require('node:util');

const legacyRead = (key, callback) => {
  setTimeout(() => {
    if (!key) callback(new Error('Key required'));
    else callback(null, `value of ${key}`);
  }, 1);
};

const read = promisify(legacyRead);

const main = async () => {
  console.log(await read('port'));
  await read('').catch((error) => console.log(error.message));
};

main();
```

## Thenable and accidental thenables

`await` adopts any object with a `then` method, so a thenable can defer
work until awaited. The same rule makes data with a `then` key dangerous.

```js
const lazy = (fn) => ({
  then(resolve, reject) {
    Promise.resolve().then(fn).then(resolve, reject);
  },
});

const main = async () => {
  const value = await lazy(() => 42);
  console.log({ value });
  const record = { id: 1, then: (resolve) => resolve('hijacked') };
  const loaded = await Promise.resolve(record);
  console.log({ loaded });
};

main();
```

Never "fix" syntax with prototype patches such as
`Array.prototype.then = function () { return Promise.all(this); }`, a fix
that code assistants do suggest: every awaited array, and every array
returned from an `async` function, silently becomes a `Promise.all`.

## Iterable, iterator, generator

`for..of` calls `[Symbol.iterator]()`, then `next()` until `done`, and
`return()` when the loop exits early (`break`, `return`, `throw`). Use a
generator method to get all of that for free.

```js
class Range {
  #from;
  #to;

  constructor(from, to) {
    this.#from = from;
    this.#to = to;
  }

  *[Symbol.iterator]() {
    try {
      for (let i = this.#from; i < this.#to; i++) yield i;
    } finally {
      console.log('range closed');
    }
  }
}

for (const n of new Range(0, 10)) {
  if (n === 2) break;
  console.log(n);
}
console.log([...new Range(0, 3)]);
```

## Async iterable

Use for pull-based sequences of async values (pages, rows, messages);
`return()` is the cleanup hook for early exit.

```js
const { setTimeout: sleep } = require('node:timers/promises');

const pages = (total) => ({
  [Symbol.asyncIterator]() {
    let page = 0;
    return {
      async next() {
        if (page === total) return { value: undefined, done: true };
        await sleep(1);
        page++;
        return { value: { page, items: [page * 10] }, done: false };
      },
      async return() {
        console.log('release cursor');
        return { value: undefined, done: true };
      },
    };
  },
});

const main = async () => {
  for await (const { page, items } of pages(5)) {
    console.log(page, items);
    if (page === 2) break;
  }
  const all = await Array.fromAsync(pages(3));
  console.log(all.length);
};

main();
```

## Array-like

Indexed keys plus `length` (`arguments`, `NodeList`, typed-array-like
objects). Convert once with `Array.from`; do not use `arguments`.

```js
const arrayLike = { 0: 'a', 1: 'b', length: 2 };
console.log(Array.from(arrayLike), Array.isArray(arrayLike));

const join = (...parts) => parts.join('-');
console.log(join('a', 'b', 'c'));
```

## Observable: EventTarget and EventEmitter

Push-based subscription. `EventTarget` is the web standard (also global in
Node.js); `EventEmitter` is Node style. `events.once` turns one event into a
promise, `events.on` into an async iterator.

```js
const { EventEmitter, once } = require('node:events');

const target = new EventTarget();
target.addEventListener('buy', (event) => console.log(event.detail));
target.dispatchEvent(new CustomEvent('buy', { detail: { item: 'Laptop' } }));

const emitter = new EventEmitter();

const main = async () => {
  setTimeout(() => emitter.emit('ready', { port: 8080 }), 1);
  const args = await once(emitter, 'ready');
  console.log(args[0]);
};

main();
```

## Stream

Streams are async iterables of chunks with backpressure. Prefer
`stream/promises` `pipeline` for composition and `for await` for
consumption.

```js
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const upper = new Transform({
  transform(chunk, encoding, callback) {
    callback(null, chunk.toString().toUpperCase());
  },
});

const main = async () => {
  const chunks = [];
  await pipeline(
    Readable.from(['marcus ', 'aurelius']),
    upper,
    async (source) => {
      for await (const chunk of source) chunks.push(chunk.toString());
    },
  );
  console.log(chunks.join(''));

  const web = new ReadableStream({
    start(controller) {
      controller.enqueue('web ');
      controller.enqueue('stream');
      controller.close();
    },
  });
  let text = '';
  for await (const chunk of web) text += chunk;
  console.log(text);
};

main();
```

## Transferable

Transferring moves ownership of the underlying memory or handle to another
thread (or clone) instead of copying; the source becomes detached.

```js
const buffer = new ArrayBuffer(8);
new Uint32Array(buffer)[0] = 42;

const moved = structuredClone(buffer, { transfer: [buffer] });
console.log(buffer.byteLength, moved.byteLength, new Uint32Array(moved)[0]);

const { port1, port2 } = new MessageChannel();
port2.once('message', (data) => {
  console.log('received', new Uint32Array(data)[0]);
  port2.close();
});
port1.postMessage(moved, [moved]);
console.log('after postMessage', moved.byteLength);
```

With `worker_threads`, pass `transferList` in `new Worker(file, {
workerData, transferList })` or the second argument of `postMessage`.

## Disposable

`using` / `await using` call `[Symbol.dispose]()` /
`[Symbol.asyncDispose]()` at the end of the block, also on exceptions.
Supported natively in Node.js 24; in TypeScript set `target`/`lib` to
`esnext` (or `esnext.disposable`).

```js
class Connection {
  #name;

  constructor(name) {
    this.#name = name;
    console.log(`open ${name}`);
  }

  ping() {
    return `${this.#name}: ok`;
  }

  async [Symbol.asyncDispose]() {
    console.log(`close ${this.#name}`);
  }
}

const main = async () => {
  await using db = new Connection('main');
  console.log(db.ping());
};

main();
```

## Conversion protocols

```js
class Money {
  #cents;

  constructor(cents) {
    this.#cents = cents;
  }

  [Symbol.toPrimitive](hint) {
    if (hint === 'number') return this.#cents / 100;
    return `$${(this.#cents / 100).toFixed(2)}`;
  }

  toJSON() {
    return { cents: this.#cents };
  }
}

const price = new Money(1999);
console.log(`${price}`, +price, JSON.stringify({ price }));
```

## Result container (expected failures as values)

Use in FP-style pipelines or system code with explicit error contracts;
aggregates and use cases throw domain errors instead. `map` and `chain` here
are methods of the container, not array iteration.

```js
class Result {
  #value;
  #error;

  constructor(value, error) {
    this.#value = value;
    this.#error = error;
  }

  static ok(value) {
    return new Result(value, null);
  }

  static fail(error) {
    return new Result(null, error);
  }

  map(fn) {
    return this.#error ? this : Result.ok(fn(this.#value));
  }

  chain(fn) {
    return this.#error ? this : fn(this.#value);
  }

  match(onOk, onFail) {
    return this.#error ? onFail(this.#error) : onOk(this.#value);
  }
}

const parsePort = (text) => {
  const port = Number.parseInt(text, 10);
  const valid = Number.isInteger(port) && port > 0 && port < 65536;
  return valid ? Result.ok(port) : Result.fail(new RangeError(`Bad: ${text}`));
};

for (const input of [' 8080', 'http']) {
  const message = Result.ok(input)
    .map((s) => s.trim())
    .chain(parsePort)
    .match(
      (port) => `listen ${port}`,
      (error) => error.message,
    );
  console.log(message);
}
```
