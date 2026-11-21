# Context propagation: verified matrix and API notes

All results below were observed on Node.js 24.14 with the default
`AsyncContextFrame` implementation, using one `AsyncLocalStorage` (`als`).

## What sees the store set by `als.run(store, fn)`

| Inside `fn` you start...                                                 | Callback sees                             |
| ------------------------------------------------------------------------ | ----------------------------------------- |
| `await` / `.then()`                                                      | `store`                                   |
| `setTimeout`, `setInterval`, `setImmediate`                              | `store` (captured at creation)            |
| `process.nextTick`, `queueMicrotask`                                     | `store`                                   |
| core async I/O (`fs`, `net`, `http` client)                              | `store`                                   |
| `emitter.on(...)` registered inside, emitted elsewhere                   | the emitter caller's context, not `store` |
| `req.on('data' / 'end')` on an incoming request                          | the HTTP parser's context (`undefined`)   |
| Fastify lifecycle after `run(store, done)` in `onRequest`, body included | `store` (its parser uses `AsyncResource`) |
| `AsyncResource.bind(listener)` registered inside                         | `store`                                   |
| `new EventEmitterAsyncResource()` created inside                         | `store` for all its listeners             |
| A raw callback pushed to a userland queue                                | the drainer's context                     |
| A callback pushed after `AsyncResource.bind`                             | `store`                                   |
| `const restore = AsyncLocalStorage.snapshot()`, then later `restore(fn)` | `store`                                   |
| `await` on a promise that another context resolves                       | `store` (the awaiting side wins)          |
| a `Worker`, child process or remote service                              | nothing; pass ids explicitly              |
| Code after `als.run()` returns                                           | the outer store (scope ended)             |
| Code after `als.enterWith(x)` in the same function and its later awaits  | `x` (leaks)                               |
| `als.exit(fn)`                                                           | `undefined` inside `fn`                   |

Promise-based pools (`acquire()` returns a promise that `release()` resolves)
keep the context of the awaiting request. Callback-based pools do not: a
`queue.push(callback)` design needs binding.

## Plain node:http

For a server without Fastify, enter the context per request and read the body
inside it with `await`, so the continuation keeps the store:

```js
const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

const SAFE_REQUEST_ID = /^[\w-]{8,64}$/;
const requestContext = new AsyncLocalStorage();
const getContext = () => requestContext.getStore() ?? null;

const log = (message) => {
  const requestId = getContext()?.requestId ?? null;
  console.log(JSON.stringify({ requestId, message }));
};

const handle = async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  log(`body ${Buffer.concat(chunks).length} bytes`);
  res.end('ok');
};

const server = http.createServer((req, res) => {
  const header = req.headers['x-request-id'];
  const isSafe = typeof header === 'string' && SAFE_REQUEST_ID.test(header);
  const requestId = isSafe ? header : randomUUID();
  const store = Object.freeze({ requestId });
  requestContext.run(store, () => {
    handle(req, res).catch((error) => {
      log(error.message);
      res.statusCode = 500;
      res.end();
    });
  });
});
```

## API cheat sheet

```js
const { AsyncLocalStorage, AsyncResource, executionAsyncId } = require('node:async_hooks');
const { EventEmitterAsyncResource } = require('node:events');

const als = new AsyncLocalStorage();
als.run(store, fn, ...args);
als.getStore();
als.exit(fn, ...args);
als.disable();

const bound = AsyncLocalStorage.bind(fn);
const restore = AsyncLocalStorage.snapshot();
restore(fn, ...args);

const resource = new AsyncResource('Type');
resource.runInAsyncScope(fn, thisArg, ...args);
resource.bind(fn);
resource.asyncId();
resource.triggerAsyncId();
resource.emitDestroy();
AsyncResource.bind(fn);

const emitter = new EventEmitterAsyncResource({ name: 'Job' });
emitter.emitDestroy();
```

- `run()` returns `fn`'s return value, so `await als.run(context, async () => ...)`
  works.
- Node 24 accepts `new AsyncLocalStorage({ defaultValue, name })`.
- `enterWith(store)` exists but is not for application code.
- `executionAsyncId()` identifies the current async resource. Prefer ALS for
  any data you need.

## Subclassing AsyncResource

```js
class Collector extends AsyncResource {
  constructor(expected, callback) {
    super('Collector');
    this.expected = expected;
    this.items = new Set();
    this.callback = callback;
  }

  add(item) {
    this.items.add(item);
    if (this.items.size !== this.expected) return;
    this.runInAsyncScope(this.callback, null, null, [...this.items]);
    this.emitDestroy();
  }
}
```

The callback runs in the context where the collector was created, even when
the last `add()` comes from another request (verified).

## Batcher with one resource per item

```js
const { AsyncResource } = require('node:async_hooks');

class Batcher {
  #items = [];
  #size;
  #flush;

  constructor(size, flush) {
    this.#size = size;
    this.#flush = flush;
  }

  add(item, callback) {
    const resource = new AsyncResource('BatcherItem');
    this.#items.push({ item, callback, resource });
    if (this.#items.length < this.#size) return;
    const batch = this.#items;
    this.#items = [];
    const items = [];
    for (let i = 0; i < batch.length; i++) items.push(batch[i].item);
    const results = this.#flush(items);
    for (let i = 0; i < batch.length; i++) {
      const { callback, resource } = batch[i];
      resource.runInAsyncScope(callback, null, null, results[i]);
      resource.emitDestroy();
    }
  }
}
```

Each callback sees the store of the request that added the item (verified),
even though the last request triggers the flush.

## Benchmarks

| Scenario (Node 24.14, 1M async call chains)       | Time       |
| ------------------------------------------------- | ---------- |
| explicit argument                                 | 250–310 ms |
| `als.run()` + `getStore()` (AsyncContextFrame)    | 470–500 ms |
| explicit argument with `--no-async-context-frame` | 490–600 ms |
| `als.run()` with `--no-async-context-frame`       | 610–620 ms |

The legacy mode slows all promise code once ALS is in use, because it
installs promise hooks. On real I/O the overhead largely disappears.

## async_hooks.createHook (legacy, avoid)

- It is a low-level `init`/`before`/`after`/`destroy`/`promiseResolve`
  callback API. Using it means building your own maps from async id to data,
  and it slows the whole process.
- Never call `console.log` (or anything that creates async resources) inside
  a hook. It re-enters the hook and loops forever. Even reading
  `process.stdout` lazily can trigger this. Write with
  `fs.writeSync(1, text)` and a hand-made serializer.
- The old `domain` module and the `continuation-local-storage` / `cls-hooked`
  packages are superseded by ALS. Migrate them.

## Libraries that pool callbacks

Database drivers, HTTP agents and job queues that keep their own callback
queues can run your callbacks in the context of another request. Symptoms:
logs show another request's id, or `getStore()` is `undefined` inside a
driver callback. Fixes, in order of preference:

1. Use the library's promise API, since the `await` continuation keeps the
   context.
2. Bind the callback: `driver.find(filter, AsyncResource.bind(callback))`.
3. Wrap the library behind your own adapter that captures
   `AsyncLocalStorage.snapshot()` per call.
