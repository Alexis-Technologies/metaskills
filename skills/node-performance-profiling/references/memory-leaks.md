# Memory leaks: catalogue, hunting, tests

A leak is memory that stays reachable after the program no longer needs it.
GC only frees unreachable objects, and never frees OS resources (file
descriptors, sockets, timers, child processes) by itself. The usual families:
references, closures, OS and language objects, events and subscriptions,
caches, mixins, concurrency.

## Reading process.memoryUsage()

| Field | Grows when |
| --- | --- |
| `heapUsed` | JS objects, strings, closures, arrays are retained |
| `heapTotal` | V8 committed more heap; rarely shrinks, not a leak signal alone |
| `external` | C++ objects tied to JS, including Buffer memory |
| `arrayBuffers` | ArrayBuffer/Buffer/typed array backing stores (subset of external) |
| `rss` | Everything resident: heap, external, code, stacks, native allocations |

`fs.readFile(path)` returns a Buffer (counted in `external`/`arrayBuffers`);
`fs.readFile(path, 'utf8')` returns a string (counted in `heapUsed`). A cache of
file contents therefore leaks into different columns depending on encoding.

Quick reporter:

```js
const toMb = (bytes) => Math.round(bytes / 1e4) / 100;
const history = [];

const sampleMemory = () => {
  const usage = process.memoryUsage();
  history.push({
    rss: toMb(usage.rss),
    heapTotal: toMb(usage.heapTotal),
    heapUsed: toMb(usage.heapUsed),
    external: toMb(usage.external),
    arrayBuffers: toMb(usage.arrayBuffers),
  });
  if (history.length > 20) history.shift();
  console.table(history);
};

setInterval(sampleMemory, 1000).unref();
```

## Catalogue

| Source | Leaky shape | Fix |
| --- | --- | --- |
| Module-level collections | `const sessions = new Map()` filled per request, never deleted | Delete on close/expiry; TTL sweep; size cap; `WeakMap` when keyed by an object whose lifetime defines the entry |
| Caches / memoize | `cache[key] = result` forever | Max entries with eviction (Map insertion order = LRU), TTL, size in bytes |
| Global mixins | `global[key] = ...`, `process.x = ...`, `console.y = ...`, patched built-in prototypes | Pass dependencies explicitly; never attach state to globals |
| Listeners per operation | `emitter.on('data', handler)` inside a request handler on a long-lived emitter | `once`, remove in `finally`, `events.once(emitter, name, { signal })`, `for await (... of on(emitter, name, { signal }))` |
| AbortSignal listeners | `signal.addEventListener('abort', fn)` in a helper called many times with one long-lived signal | `{ once: true }` and `removeEventListener` when the operation completes, or `events.addAbortListener(signal, fn)` and dispose it |
| Timers | `setInterval` per connection never cleared; timer closure holds the connection | `clearInterval` on close; one shared timer for many items; `unref()` background timers |
| Shared closure context | Sibling closure references a big object, the long-lived closure keeps it | Capture copied primitives; split factories; null out large locals |
| Functions created in loops / per call | Thousands of closures each holding a context | Hoist functions; pass data as arguments |
| String slices | Caching `body.slice(0, 32)` keeps the whole multi-MB body | `structuredClone(part)` or parse into fields |
| Unsettled promises | Awaiting a promise that never settles keeps its whole async chain and context | Timeouts (`AbortSignal.timeout(ms)`), cancel on shutdown |
| OS handles | Opened fds/sockets/FileHandles never closed (`EMFILE`) | `try/finally` close, `await using` FileHandle (Node 24), `stream.pipeline` destroys on error |
| Streams | Readable never consumed or destroyed after an error | `pipeline()`, `stream.destroy()`, consume or `resume()` |
| `require`/`import`/`vm` in handlers | New module closures or contexts per call; `number_of_detached_contexts` grows | Load once at startup; reuse `vm.Script` and contexts |
| Workers and child processes | Spawned per task and never terminated | Pools with max size; `worker.terminate()`, `child.kill()` |
| perf_hooks entries | `performance.mark()` per request | `clearMarks()`/`clearMeasures()` or histograms |

Bounded cache with eviction (Map keeps insertion order):

```js
const createCache = ({ maxEntries = 1000, ttlMs = 60_000 } = {}) => {
  const entries = new Map();

  const get = (key) => {
    const entry = entries.get(key);
    const isFresh = entry !== undefined && entry.expiresAt > Date.now();
    entries.delete(key);
    if (isFresh) entries.set(key, entry);
    return isFresh ? entry.value : undefined;
  };

  const set = (key, value) => {
    entries.delete(key);
    if (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
    entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  };

  return { get, set, clear: () => entries.clear() };
};
```

Memoize pitfalls: `if (val) return val` re-computes falsy
results, memoizing `fib` wraps only the outer call (inner recursion is not
memoized), and key building (`toString`, `join`, hashing) can cost more than
the computation.

Listener with a guaranteed cleanup path:

```js
const { once } = require('node:events');

const waitForReady = async (emitter, timeoutMs) => {
  const signal = AbortSignal.timeout(timeoutMs);
  const args = await once(emitter, 'ready', { signal });
  return args[0];
};
```

`events.once` removes its listener on resolve, on `'error'`, and on abort, so a
timed-out wait does not leave a handler behind. It rejects with an `AbortError`
whose `cause` is the `TimeoutError`.

## Hunting procedure

1. Reproduce with a loop of identical operations (requests, jobs, messages)
   and watch `heapUsed` after GC (`--trace-gc`, monitor, or `gc()` in tests).
   A rising floor across cycles means retention.
2. Decide the region: `heapUsed` vs `external`/`arrayBuffers` vs RSS only.
3. Three snapshots (DevTools Memory panel, `v8.writeHeapSnapshot()`, or
   `--heapsnapshot-signal=SIGUSR2` and `kill -USR2 <pid>`):
   - warm up (caches, JIT, pools filled), take snapshot 1;
   - run N operations, take snapshot 2;
   - run N more, take snapshot 3.
4. In snapshot 3 choose "Objects allocated between Snapshot 1 and Snapshot 2":
   what survived two cycles is the leak. Or use Comparison view and sort by
   `# Delta`; counts that grow by about N per cycle point to the leaked type
   (your class names, `(closure)`, `system / Context`, `(string)`,
   `Array`, `Timeout`, `AbortSignal`, `Socket`).
5. Open Retainers for one instance and walk up to the root: the first object
   you own on that path (a module-level `Map`, an emitter's `_events`, a timer
   list, a closure context) is where the fix goes.
6. Fix, then repeat the same loop and snapshots; add a regression test.

Near-OOM forensics: `node --heapsnapshot-near-heap-limit=2
--diagnostic-dir=/tmp/snaps app.js` captures snapshots right before the heap
limit, when the leaked type dominates.

## Leak tests (node:test, `node --expose-gc --test`)

Collectability with `WeakRef` (the target is kept until the current job ends,
so await a tick before `gc()`):

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: tick } = require('node:timers/promises');

const isCollected = async (factory) => {
  const ref = new WeakRef(factory());
  await tick();
  globalThis.gc();
  return ref.deref() === undefined;
};

test('session object is released after close', async () => {
  const collected = await isCollected(() => {
    const session = { user: { id: 1 }, buffer: new Uint8Array(1024) };
    return session;
  });
  assert.equal(collected, true);
});
```

Bounded heap growth (many operations, explicit GC, compare):

```js
const heapAfterGc = async () => {
  await tick();
  globalThis.gc();
  return process.memoryUsage().heapUsed;
};

test('1000 requests do not grow the heap', async () => {
  await runRequests(100);
  const before = await heapAfterGc();
  await runRequests(1000);
  const after = await heapAfterGc();
  assert.ok(after - before < 1024 * 1024, `grew ${after - before} bytes`);
});
```

(`runRequests` is your operation under test.) Listener counts:
`events.getEventListeners(target, 'abort').length` and
`emitter.listenerCount('data')` should return to their baseline after the
operations complete. Avoid `FinalizationRegistry` callbacks as assertions:
their timing is not guaranteed.
