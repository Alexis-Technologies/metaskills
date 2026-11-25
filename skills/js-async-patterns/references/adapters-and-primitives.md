# Adapters and async primitives (reference)

All code below was run on Node.js 24. Snippets assume
`const fs = require('node:fs');` where `fs` is used. `Promise.withResolvers`
needs Node.js 22 and `using` needs 24: in a library with a lower `engines`
floor, write `new Promise` at the boundary and `try`/`finally`.

## Built-in adapters first

| Need                                      | Node.js built-in                                         |
| ----------------------------------------- | -------------------------------------------------------- |
| Callback-last fn to promise               | `util.promisify(fn)`, `fn[util.promisify.custom]`        |
| Promise fn to callback-last               | `util.callbackify(fn)`                                   |
| Wait for one event                        | `events.once(emitter, name, { signal })`                 |
| Async iterate events                      | `events.on(emitter, name, { signal, close: ['end'] })`   |
| Sleep / yield to event loop               | `timers/promises`: `setTimeout`, `setImmediate`          |
| Interval as async iterator                | `for await (const _ of setInterval(ms, v, { signal }))`  |
| Stream completion / pipeline              | `stream/promises`: `pipeline`, `finished`                |
| Promise-based core APIs                   | `fs/promises`, `dns/promises`, `readline/promises`       |
| Abort when signal fires (cleanup handle)  | `events.addAbortListener(signal, fn)` returns Disposable |
| Promise for an abort                      | `util.aborted(signal, resource)`                         |
| Sync or async fn to promise (Node.js 24+) | `Promise.try(fn, ...args)`                               |
| Resolve a promise from outside            | `Promise.withResolvers()` (Node.js 22+)                  |
| Collect an async iterable into an array   | `Array.fromAsync(iterable)` (Node.js 22+)                |

To make a custom callback API promisify nicely, define
`fn[util.promisify.custom] = (...args) => promiseVersion(...args)`.

## Hand-written adapters (all directions)

The callback is always deferred, and it is never called inside `try` or
`.then`.

```js
// sync -> callback-last (a sync fn may return or throw an Error)
const asyncify =
  (fn) =>
  (...args) => {
    const callback = args.pop();
    process.nextTick(() => {
      let result = null;
      try {
        result = fn(...args);
      } catch (error) {
        return void callback(error);
      }
      if (result instanceof Error) callback(result);
      else callback(null, result);
    });
  };

// callback-last -> promise (for browsers; in Node use util.promisify)
const promisify =
  (fn) =>
  (...args) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    fn(...args, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
    return promise;
  };

// sync -> promise
const promisifySync =
  (fn) =>
  (...args) => {
    try {
      const result = fn(...args);
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    }
  };

// promise-returning or async fn -> callback-last (callback called once)
const callbackify =
  (fn) =>
  (...args) => {
    const callback = args.pop();
    Promise.resolve()
      .then(() => fn(...args))
      .then(
        (value) => void process.nextTick(callback, null, value),
        (error) => void process.nextTick(callback, error),
      );
  };

// promise instance -> callback-last function
const promiseToCallback = (promise) => (callback) => {
  promise.then(
    (value) => void process.nextTick(callback, null, value),
    (error) => void process.nextTick(callback, error),
  );
};
```

Notes:

- Async to sync is impossible; the closest is returning a promise.
- `promisify` does not wrap `fn(...)` in `try`. By contract a
  callback-last function never throws (the "trusting" version). Add `try`
  plus `reject` only for untrusted code.
- Do not write `callbackify` as `.then(cb(null, v)).catch(cb(e))`. When the
  consumer's callback throws, `.catch` calls the callback a second time. The
  version above, like `util.callbackify`, defers the call with
  `process.nextTick`, so the throw becomes an `uncaughtException` instead.
- Each wrapper adds a closure and an allocation. That is fine in
  application code; avoid stacking wrappers on hot system paths.

## Wrapping a non-abortable API with a signal

```js
const { addAbortListener } = require('node:events');

const abortable = (signal, executor) => {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers();
  const listener = addAbortListener(signal, () => reject(signal.reason));
  executor(resolve, reject);
  return promise.finally(() => listener[Symbol.dispose]());
};

const value = await abortable(signal, (resolve) => {
  legacy.compute(input, (result) => resolve(result));
});
```

Do not write `using listener = addAbortListener(...)` here. `using` would
dispose the listener when the function returns, before the abort can
happen (verified bug). Disposal must follow the promise's lifetime.

## Who rejects with what on abort

| API                                           | Rejection on abort                                   |
| --------------------------------------------- | ---------------------------------------------------- |
| `fetch`, `signal.throwIfAborted()`            | `signal.reason` itself                               |
| `navigator.locks.request(..., { signal })`    | `signal.reason` itself                               |
| `timers/promises`, `events.once`, `events.on` | `AbortError` (`code: 'ABORT_ERR'`), `cause = reason` |
| `stream/promises` `pipeline`, `fs/promises`   | `AbortError` (`code: 'ABORT_ERR'`), `cause = reason` |
| `AbortSignal.timeout(ms)` reason              | `DOMException` named `TimeoutError`                  |
| `controller.abort()` without argument         | `DOMException` named `AbortError`                    |

To find out why something was aborted, check `signal.reason`, because
`error.name` depends on which API rejected. The timer of
`AbortSignal.timeout()` is unref'd. If nothing else is pending, the process
can exit before the timeout fires, and this is by design.

## Collector (dependency-free)

A thenable that collects named results from any contract, with a timeout.
It resolves once all expected keys arrive and rejects on the first error or
timeout. It replaces `Promise.allSettled` + `Promise.race` + hand-made timers,
and lets results come from callbacks, promises or plain `set` calls.

```js
class Collector {
  #keys;
  #data = {};
  #count = 0;
  #done = false;
  #timer = null;
  #result = Promise.withResolvers();

  constructor(keys, { timeout = 0 } = {}) {
    this.#keys = new Set(keys);
    this.#result.promise.catch(() => {});
    if (timeout > 0) {
      const error = new Error(`Collector timed out after ${timeout}ms`);
      this.#timer = setTimeout(() => this.fail(error), timeout);
    }
  }

  set(key, value) {
    if (this.#done) return;
    if (!this.#keys.has(key)) return void this.fail(new Error(`Unexpected key: ${key}`));
    if (!Object.hasOwn(this.#data, key)) this.#count++;
    this.#data[key] = value;
    if (this.#count === this.#keys.size) {
      this.#finish();
      this.#result.resolve(this.#data);
    }
  }

  take(key, fn, ...args) {
    fn(...args, (error, value) => {
      if (error) this.fail(error);
      else this.set(key, value);
    });
  }

  wait(key, promise) {
    promise.then(
      (value) => this.set(key, value),
      (error) => this.fail(error),
    );
  }

  fail(error) {
    if (this.#done) return;
    this.#finish();
    this.#result.reject(error);
  }

  #finish() {
    this.#done = true;
    clearTimeout(this.#timer);
  }

  then(onFulfilled, onRejected) {
    return this.#result.promise.then(onFulfilled, onRejected);
  }
}

const dc = new Collector(['user', 'readme', 'config'], { timeout: 1000 });
dc.set('user', { name: 'Marcus' });
dc.take('readme', fs.readFile, 'README.md', 'utf8');
dc.wait('config', fs.promises.readFile('config.json', 'utf8'));
const result = await dc;
```

`this.#result.promise.catch(() => {})` marks the internal promise as
handled. Without it, a collector that fails before anyone awaits it
would crash the process with an unhandled rejection. A counting variant
waits for N values under any keys.

## Thenable rules

- A thenable is any object with `then(onFulfilled, onRejected)`; `await`,
  `Promise.resolve`, `Promise.all` and `async` returns adopt it.
- Each `await thenable` calls `then` again. You can use this on purpose for
  iteration (a thenable that yields the next number on each await). Remember
  it when `then` does work.
- `then` must eventually call one of the callbacks. A thenable that never
  calls back hangs its awaiter forever, with no error and no timeout.
- Returning `Promise.resolve(x).then(resolve, reject)` from `then` keeps
  chaining (`.then().then()`) working with the least amount of code.
- A monadic thenable (`of`, `map`, `chain`) satisfies the monad laws and can
  stand in for Future-style code.

## Promise vs Future vs Deferred

| Abstraction | Starts                  | State     | Re-run          | Use today                 |
| ----------- | ----------------------- | --------- | --------------- | ------------------------- |
| Promise     | eagerly, once           | stateful  | no (memoized)   | default                   |
| Future      | lazily, on `fork`/await | stateless | yes, every fork | FP pipelines, retries     |
| Deferred    | externally resolved     | stateful  | no              | `Promise.withResolvers()` |

```js
class Future {
  #executor;

  constructor(executor) {
    this.#executor = executor;
  }

  static of(value) {
    return new Future((resolve) => resolve(value));
  }

  chain(fn) {
    return new Future((resolve, reject) => {
      this.fork((value) => fn(value).fork(resolve, reject), reject);
    });
  }

  map(fn) {
    return this.chain((value) => Future.of(fn(value)));
  }

  fork(onSuccess, onFailure) {
    this.#executor(onSuccess, onFailure);
  }

  then(resolve, reject) {
    this.fork(resolve, reject);
  }
}

const readFuture = (path) =>
  new Future((resolve, reject) => {
    fs.readFile(path, 'utf8', (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });

const length = readFuture('data.txt').map((text) => text.length);
const size = await length; // the file is read only now, on await/fork
```

## Async composition

```js
const pipe =
  (...fns) =>
  async (input) => {
    let value = input;
    for (let i = 0; i < fns.length; i++) value = await fns[i](value);
    return value;
  };

const handle = pipe(parse, validate, save, toResponse);
const response = await handle(request);
```

Prefer a plain `async` orchestrator. Reach for a composition DSL only when
the flow is data (config, plugins).

## Async initialization and disposal

```js
class Connection {
  static async open(url) {
    const client = await driver.connect(url);
    return new Connection(client);
  }

  constructor(client) {
    this.client = client;
  }

  ping() {
    return this.client.ping();
  }

  async [Symbol.asyncDispose]() {
    await this.client.close();
  }
}

{
  await using connection = await Connection.open(url);
  await connection.ping();
} // closed here, even when ping throws
```

- With `using`, resources are disposed in reverse order of declaration.
  `DisposableStack`/`AsyncDisposableStack` (`stack.defer(fn)`,
  `stack.use(resource)`) handle a dynamic number of resources.
- To share one resource, count references. Each `use()` returns
  `Object.create(resource)` with its own `Symbol.asyncDispose`, and the real
  close runs when the count drops to zero.
- `FinalizationRegistry` is not a cleanup mechanism, because it is
  non-deterministic and may never run. Use it only as a leak detector.

- `static async create(...)` plus a sync constructor is the recommended
  shape. TypeScript types it well, and the constructor stays pure.
- `constructor() { return this.#init(); }` plus `await new X()` works, but
  `new X()` then returns a promise, which breaks TypeScript types and
  subclassing.
- An `init()` method called after `new` leaves a half-initialized object
  that others can see. Avoid it.

## Process-level signals of async bugs

- `unhandledRejection`: a rejected promise has no handler at the end of the
  microtask checkpoint. By default the process crashes.
- `rejectionHandled`: a handler was attached later. This typically shows
  that promises were created first and awaited one by one later.
- Install the process handlers for logging and graceful shutdown only, not
  for recovery (`error-handling`, `node-graceful-shutdown`).
