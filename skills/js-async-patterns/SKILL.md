---
name: js-async-patterns
description: Choose and convert async contracts in JS and Node. Use for promises, callbacks, AbortSignal, timeouts, async iterators or unhandled rejections
---

# Async Contracts and Patterns

Use this skill to choose one async contract for each layer, convert
contracts only at boundaries and only with adapters, make every
promise end up awaited or handled, and give every long operation a
way to be cancelled and a time limit. For concurrency limits, locks, queues
and race conditions, see `js-async-concurrency`.

## Decision guide

| Situation                                        | Contract                                         |
| ------------------------------------------------ | ------------------------------------------------ |
| Application/domain code, new public APIs         | `async` functions returning promises             |
| One result later, lightweight or lazy, awaitable | Thenable (`then(resolve, reject)`), e.g. builder |
| Many values over time, pull-based, with cleanup  | Async iterator / `async function*`               |
| Many events, many subscribers, push-based        | `EventEmitter` / `EventTarget` (`node-events`)   |
| Large or unbounded data with backpressure        | Streams (`node-streams`)                         |
| Measured hot library internals, legacy modules   | Callback-last, error-first                       |
| Wait for N independent results from any contract | Collector (see the reference)                    |
| Lazy, re-runnable computation (FP style)         | Future (`fork`, `map`, `chain`)                  |
| Resolve a promise from outside its executor      | `Promise.withResolvers()` (replaces Deferred)    |

`async`/`await` is the default, and `.then` is fine where it reads better.
Keep one contract per layer. Where two meet, an adapter converts one to the
other. To compose functions that use different contracts, first convert them
all to one contract, then compose.

- **Library**: callbacks are a reasonable default for hot internals (parsers,
  protocols, I/O) when measured; the public API stays promise-based. Check
  `engines` first: `Promise.withResolvers` and `Array.fromAsync` need
  Node.js 22, `using` and `Promise.try` need 24.
- **App** (Node.js 24+): `async`/`await` throughout. A callback appears only
  at the boundary with an older API.

## Rules

### Contracts and API design

- One function = one contract. Never accept a callback AND return a
  promise, never report errors both by `throw` and by `callback(error)`.
  If you must offer both styles, export two functions or two modules
  (like `node:fs` and `node:fs/promises`), and build one from the other
  with `callbackify`/`promisify`.
- For libraries, make the promise-based API primary, accept
  `{ signal }` in options for anything slow, and return Error
  instances (never strings) on failure.
- Callback contract: the callback is the last argument. Its first parameter
  is the error, which is `null` on success, and data comes after it. Call
  it exactly once, and always asynchronously. If a result is already
  available (from a cache, or a validation error), defer it with
  `process.nextTick` or `queueMicrotask`. Calling the callback
  synchronously sometimes and asynchronously other times is "Zalgo".
- A callback-last function must not throw; it reports every failure through
  the callback. Call the user's callback outside any `try` block and outside
  promise `.then/.catch` handlers, or a throwing consumer gets called twice.
- Having a callback argument does not make a function asynchronous. Code is
  asynchronous only when it reaches I/O, a timer or the microtask queue.
- Do not mutate `Array.prototype.then` or other built-ins to make values
  awaitable; wrap them in a thenable or call `Promise.all`.

### Promises and async/await

- Every promise is awaited, returned, passed to a combinator, or given a
  `.catch`. A floating promise that rejects crashes Node.js (the default
  `--unhandled-rejections=throw`, exit code 1).
- Never write `new Promise` around something that already returns a
  promise, and never use an `async` executor. Use `new Promise` /
  `Promise.withResolvers()` only at the boundary with a callback or event
  API, and keep the executor minimal. Prefer built-ins: `util.promisify`,
  `events.once`, `timers/promises`, `fs/promises`, `stream/promises`,
  `dns/promises`, `readline/promises`.
- In Node.js use the native `util.promisify` (supports
  `util.promisify.custom`); a hand-written one is for browsers.
- Run independent operations concurrently: `Promise.all` (fail fast),
  `Promise.allSettled` (collect all outcomes), `Promise.any` (first
  success), `Promise.race` (first settlement; only together with cleanup).
  `Promise.all` does not cancel the losers. Pass them a shared signal
  and abort it on the first failure.
- Do not create several promises and then `await` them one by one. If a
  later one rejects while you are still waiting for an earlier one, its
  rejection is unhandled at that moment and the process crashes. Use
  `Promise.all`/`allSettled`.
- Inside `try`, write `return await promise`, not `return promise`.
  Otherwise the rejection skips your `catch`/`finally` logic and the stack
  trace loses the frame.
- For a default value, attach a `.catch` to the awaited expression
  instead of declaring `let` before a `try`. Catch narrowly, for example
  only `ENOENT`.
- Every `await` is a point where other code runs. Re-check state you read
  before the `await` (see `js-async-concurrency` for races).
- Unbounded fan-out over a huge list is a bug: limit concurrency
  (`js-async-concurrency`).
- Recursive or long-running async loops need a real yield point.
  Recursion with no `await` before the recursive call overflows the stack.
  `await null` only yields to the microtask queue, and I/O still starves.
  Use `await setImmediate()` from `node:timers/promises` to let the event
  loop run (`node-event-loop`).

### Cancellation, timeouts and cleanup

- Every operation that can be slow takes `options.signal` and passes it
  down to everything it calls (`fetch`, `fs`, `timers/promises`,
  `events.once/on`, `stream.pipeline`, `navigator.locks`, child functions).
  Between steps, call `signal.throwIfAborted()`.
- Combine signals with `AbortSignal.any([signal, AbortSignal.timeout(ms)])`.
  Prefer this to `Promise.race` against a timer. A race only stops the
  waiting while the work goes on, and its timer must be cleared by hand.
- Know the error shapes. `fetch`, `signal.throwIfAborted()` and
  `navigator.locks` reject with `signal.reason` (a `TimeoutError` for
  `AbortSignal.timeout`). Node's `timers/promises` and `events.once/on`
  reject with an `AbortError` (`code: 'ABORT_ERR'`) and put the reason in
  `error.cause`. To detect a timeout, check `signal.reason`, not
  `error.name`.
- Remove listeners and timers on every exit path: `{ once: true }`,
  `events.addAbortListener` (it returns a Disposable), `clearTimeout` in
  `finally`.
- Release resources in `finally`, or with `await using` and
  `Symbol.asyncDispose` (Node.js 24+; a syntax error in Node.js 22).
  `Symbol.dispose` is synchronous: if it returns a promise, nobody awaits
  it. `using` disposes when the block exits, not when a promise started in
  that block settles, so write `return await` inside it.

## Patterns

### Callback-last, error-first done right

```js
const readJson = (path, callback) => {
  fs.readFile(path, 'utf8', (error, data) => {
    if (error) return void callback(error);
    let parsed = null;
    try {
      parsed = JSON.parse(data);
    } catch (parseError) {
      return void callback(parseError);
    }
    callback(null, parsed);
  });
};

const getUser = (id, callback) => {
  const cached = cache.get(id);
  if (cached) return void process.nextTick(callback, null, cached);
  db.loadUser(id, callback);
};
```

The callback is called outside the `try` block, so a consumer that throws
does not trigger a second call. The cached path is deferred, so it does not
release Zalgo.

### Adapters at the boundary

```js
const { promisify, callbackify } = require('node:util');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');

const readJsonAsync = promisify(readJson);
const readJsonCallback = callbackify(readJsonAsync);

const eventArgs = await once(socket, 'message', { signal });
const message = eventArgs[0];
await sleep(100, undefined, { signal });
```

Hand-written adapters for every direction (asyncify, promisifySync,
promise to callback, an abortable wrapper) are in
[references/adapters-and-primitives.md](references/adapters-and-primitives.md).

### Flat sequential and parallel steps

```js
const loadDashboard = async (userId, { signal } = {}) => {
  const user = await db.users.get(userId, { signal });
  const orders = db.orders.list(user.id, { signal });
  const stats = db.stats.get(user.id, { signal });
  const results = await Promise.all([orders, stats]);
  return { user, orders: results[0], stats: results[1] };
};
```

With `await` + `Promise.all`, mixed sequential and parallel composition
stays flat. With nested `.then` it grows a ladder to the right.

### Defaults without `let`

```js
const DEFAULT_CONFIG = { port: 8000 };
const toBool = [() => true, () => false];

const config = await fs
  .readFile('config.json', 'utf8')
  .then(JSON.parse)
  .catch(() => DEFAULT_CONFIG);

const exists = await fs.access(path).then(...toBool);
```

No mutable variable, no empty `catch`, and no handler that writes to the
outer scope. If only a missing file should fall back to the default, rethrow
everything else:
`.catch((error) => { if (error.code !== 'ENOENT') throw error; return DEFAULT_CONFIG; })`.

### Cancellation and timeout in one signal

```js
const DEFAULT_TIMEOUT = 5000;

const loadReport = async (id, options = {}) => {
  const { signal = null, timeout = DEFAULT_TIMEOUT } = options;
  const timer = AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([signal, timer]) : timer;
  const user = await fetchUser(id, combined);
  combined.throwIfAborted();
  const orders = fetchOrders(user, combined);
  const stats = fetchStats(user, combined);
  const results = await Promise.all([orders, stats]);
  return { user, orders: results[0], stats: results[1] };
};
```

The time limit is enforced without any timer to clean up.

### Cancel when the client disconnects

```js
const disconnectSignal = (res) => {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort(new Error('Client disconnected'));
  };
  res.once('close', onClose);
  return controller.signal;
};
```

Listen on the response, never with `req.on('close')`. Since Node.js 16 the
request's `close` fires once its body has been read, so it aborts a healthy
POST while the handler is still working. The response's `close` fires on
completion too, hence the guard: `writableEnded` means the answer was already
given. Use `writableFinished` instead to ask whether the client received all
of it. In Fastify pass `reply.raw`; the `onRequestAbort` hook does not fire
once the body has been read.

### Thenable: lazy, awaitable objects

```js
class Query {
  #table;
  #where = {};

  constructor(table) {
    this.#table = table;
  }

  where(conditions) {
    Object.assign(this.#where, conditions);
    return this;
  }

  then(resolve, reject) {
    return db.select(this.#table, this.#where).then(resolve, reject);
  }
}

const cities = await new Query('city').where({ country: 10 });
```

`await` calls `then` on every await (the work runs each time). The thenable
must eventually call `resolve` or `reject`, otherwise the awaiting code hangs
forever. Returning a thenable from an `async` function adopts it.

### Async iteration with cleanup

```js
const { on } = require('node:events');

const paginate = async function* (url, { signal } = {}) {
  let next = url;
  try {
    while (next) {
      const response = await fetch(next, { signal });
      const { items, nextUrl } = await response.json();
      yield* items;
      next = nextUrl;
    }
  } finally {
    // runs on completion, error, `break` and `return` in for await
  }
};

for await (const item of paginate(startUrl, { signal })) {
  if (isEnough(item)) break;
}

const all = await Array.fromAsync(paginate(startUrl));
const lines = on(emitter, 'line', { close: ['end'], signal });
```

`break` or `return` inside `for await` calls the iterator's `return()`. A
custom iterator therefore needs a `return()` that releases resources, and a
generator needs a `finally`.

### Resource cleanup

```js
const handle = async (url) => {
  await using connection = await Connection.open(url);
  return await connection.ping();
};
```

Here `Connection` is a class with a `static async open()` factory and an
`async [Symbol.asyncDispose]()` that closes the client (full class in the
reference). Without `await` the connection closes while the call is still
running. Below Node.js 24, use
`try { ... } finally { await connection.close(); }`. For async
initialization, prefer a static async factory. An "async constructor"
(`constructor() { return this.#init(); }`, called as `await new Logger(path)`)
works, but it confuses TypeScript and `instanceof`-based code, so keep it to
small internal classes.

## Anti-patterns

- **Mixed contracts** in one function or module: a callback plus a returned
  promise, or `throw` plus `callback(error)`. Do this instead: one contract,
  plus an adapter.
- **Promise constructor around a promise**:
  `new Promise((res, rej) => api().then(res).catch(rej))`. Do this instead:
  `return api()`.
- **`new Promise(async (resolve) => ...)`**: a throw inside it is lost, and
  the promise never settles. The result is an unhandled rejection and a
  hanging promise.
- **Forgotten `await`**: `save(user);` in an async function, or
  `if (checkAccess())` on a promise, which is always truthy. Enable oxlint's
  `typescript/no-floating-promises` and `no-misused-promises` (they need
  `--type-aware` and the `oxlint-tsgolint` package), or review manually.
- **`items.forEach(async (item) => ...)`**: returns at once and drops
  errors. Use `for...of` with `await` (sequential), or collect the promises
  in a loop and pass them to `Promise.all` (parallel, bounded).
- **Sequential awaits for independent work** inside a loop or one after
  another. Use `Promise.all`. The opposite mistake, unbounded parallelism,
  is also a bug.
- **Pre-created promises awaited one by one** (an unhandled rejection
  window). Use `Promise.all`.
- **`return promise` inside `try`**: the rejection escapes the catch. Use
  `return await`.
- **Swallowing errors**: `.catch(() => {})`, an empty `catch {}`, or
  `.catch(console.log)`, which turns a rejection into
  `resolve(undefined)`. Handle, wrap with `cause`, or rethrow
  (`error-handling`).
- **Callback called inside `try`** or inside `.then`, with a second call in
  `catch`: the consumer's exception triggers a double call.
  `util.callbackify` defers with `process.nextTick`.
- **`req.on('close')` to detect a disconnect**: aborts healthy requests with
  a body. Use the response's `close` with a guard.
- **Each function knows the next one**: callback chains with no single
  place that controls the order, or flows chained through EventEmitter
  events. A shared emitter also cannot run two flows at once. Do this
  instead: an orchestrating `async` function, a composition, or a
  collector.
- **`Promise.race([work, timeout])` without clearing the timer** and
  without aborting the work. Do this instead: `AbortSignal.timeout` passed
  into the work.
- **Cancelable promise subclasses / `promise.cancel()` flags**. Do this
  instead: `AbortSignal`.
- **Deferred objects / `let resolve` hoisting**. Do this instead:
  `Promise.withResolvers()`.
- **New code on async.js/Bluebird/generator co-routines**. Use the native
  features.
- **Async `Symbol.dispose`** with `using`: nobody awaits it. Use
  `Symbol.asyncDispose` + `await using`.

## Checklist

- [ ] Each module exposes one async contract; conversions happen in
      adapters at the boundary.
- [ ] Callback APIs: callback last, error first, exactly once, always
      async, never thrown into, invoked outside `try`/`.then`.
- [ ] No `new Promise` around promise-returning calls; no async executors.
- [ ] Every promise is awaited, returned, combined or `.catch`-ed; no
      `async` callbacks passed to `forEach`, `setTimeout`, or `on()` without
      error handling.
- [ ] Independent awaits run concurrently with `Promise.all`; large
      fan-outs are bounded.
- [ ] `return await` inside `try` and `using` blocks; catches are narrow
      and never empty.
- [ ] Slow operations accept and forward `{ signal }`. Timeouts use
      `AbortSignal.timeout`/`any`, and listeners and timers are removed.
- [ ] Client disconnects are read from the response, not the request.
- [ ] Iterators and generators release resources in `return()`/`finally`.
- [ ] Resources are released in `finally` or with `await using` (Node 24+).
- [ ] Code does not trust state read before an `await` without checking it
      again afterwards.
- [ ] APIs fit `engines`: `Promise.withResolvers`, `Array.fromAsync` (22+);
      `Promise.try`, `using` (24+).

Related skills: `js-async-concurrency`, `node-event-loop`, `node-events`,
`node-streams`, `error-handling`, `node-async-context`, `js-gof`
