---
name: node-event-loop
description: How Node.js runs code, the event loop, libuv pool and timers. Use for callback order, blocked loops, latency spikes, timer leaks or a hung exit
---

# Node.js Event Loop

Reason about where each piece of code runs (the one JS thread, the libuv
thread pool, or the OS), keep that one thread free, write application code
that does not depend on loop-phase trivia, and use timers without leaks,
overlap or drift.

## Project profile

|             | Library (`@alexify/*`)              | App                                       |
| ----------- | ----------------------------------- | ----------------------------------------- |
| Deadlines   | A `signal` option                   | `AbortSignal.timeout` + client-gone signal |
| Timers      | `unref()`, cleared by `close()`     | Owned by a plugin, cleared in `onClose`   |
| Loop health | Never measures or sheds by itself   | `@fastify/under-pressure`, metrics        |

## How Node.js runs your code

- One JS thread per process (and per worker) runs every callback to
  completion. Nothing interleaves inside synchronous code; everything
  interleaves at `await`, callbacks, timers and events.
- "Node is single-threaded" was never true: libuv runs a thread pool
  (4 threads by default), V8 runs helper threads (GC, compiler), native
  addons may start their own threads. Only *your JS* is single-threaded.
- Network I/O does not use the pool: sockets are non-blocking and
  multiplexed by the OS (epoll, kqueue, IOCP). One thread serves thousands of
  connections because most of a request's life is waiting.
- The pool runs: async `fs.*`, `dns.lookup` (used by `http`/`net` for host
  names), async crypto (`pbkdf2`, `scrypt`, `randomBytes`, `randomFill`,
  `generateKeyPair`), async `zlib`. With the default pool, a few slow
  `pbkdf2` calls delay an unrelated `fs.readFile` until a pool thread frees
  up (measured: ~70 ms instead of ~1 ms).
- Promises live in V8's microtask queue. A promise that does no I/O never
  touches libuv; only callback-based operations underneath go through it.
- The process exits when the loop has no ref'ed handles or requests (timers,
  servers, sockets, in-flight fs ops). A pending promise does not keep it
  alive; an unsettled top-level `await` in ESM exits with code 13.

### Mental model: Reactor, Proactor, Actor

- **Reactor**: one thread, a queue, an endless loop; handlers for ready
  events run one at a time; phases group handlers of one kind per pass.
- **Proactor**: start an operation, the OS or a pool thread completes it,
  and the loop dispatches the completion callback.
- libuv is usually called a reactor (Unix polling uses readiness
  internally), but what Node exposes is proactor semantics: you start
  `fs.readFile` or `socket.write` and get a completion callback.
- **Actor**: private state plus a mailbox; messages are processed strictly
  one after another, so state stays consistent across `await` without locks.
- Reactor and Proactor already exist in libuv and browsers: never build them
  in application code. Actor is the one to use there. Code, usage and pitfalls:
  [references/reactor-proactor-actor.md](references/reactor-proactor-actor.md).

## Loop phases

| Phase             | Runs                                             | You schedule with                  |
| ----------------- | ------------------------------------------------ | ---------------------------------- |
| timers            | expired `setTimeout` / `setInterval` callbacks   | `setTimeout`, `setInterval`        |
| pending callbacks | some system callbacks deferred from last pass    | (internal, e.g. TCP errors)        |
| idle, prepare     | internal                                         |                                    |
| poll              | new I/O events and their callbacks; waits for I/O when nothing else is due | fs, net, http callbacks, `'data'` |
| check             | `setImmediate` callbacks                         | `setImmediate`                     |
| close callbacks   | `'close'` handlers of destroyed handles          | `socket.on('close')`               |

- After every single callback (Node 11+), Node drains the `process.nextTick`
  queue, then the microtask queue (promises, `queueMicrotask`), repeating
  until both are empty. Only then does the next callback or phase run.
- CommonJS entry: sync code, then nextTicks, then microtasks, then timers
  and immediates. ESM entry: microtasks run before nextTicks, because module
  evaluation is itself asynchronous.
- `setTimeout(fn, 0)` is `setTimeout(fn, 1)`. From the main module, the
  order of `setTimeout(0)` and `setImmediate` is unspecified (it depends on
  how long loop start-up took). Inside an I/O callback, `setImmediate`
  always runs first.
- A blocked loop does not lose timers; it fires all overdue ones in one
  batch when it gets control back.
- Verified puzzles with outputs:
  [references/ordering-puzzles.md](references/ordering-puzzles.md).

Phases rarely matter in application code, and app code must not depend on
them. If you catch yourself choosing between `nextTick` and
`setImmediate` to make application code work, there is a hidden ordering
dependency; make it explicit (`await`, an event, a queue). Deep phase
knowledge is for system code: streams, semaphores, promise libraries.

## Rules

### Keep the loop free

- Treat any synchronous step that can take more than ~10 ms in a request
  path, event handler or timer callback as a bug.
- Do not call `*Sync` APIs (`fs.readFileSync`, `execSync`, `pbkdf2Sync`,
  `scryptSync`, `zlib.gzipSync`) after start-up. They are fine for loading
  config at start-up and in CLI scripts.
- Bound input size before `JSON.parse`, `JSON.stringify`, sorting or regex
  work on user data; stream big payloads instead of buffering them.
- Never run backtracking-prone regexes on untrusted input (ReDoS).
- CPU-bound work: short (tens of ms total) -> time-slice it and yield with
  `setImmediate`; long or frequent -> `worker_threads` behind a pool (see
  `node-multithreading`); huge -> a separate service or native code.
- Yield by time budget, not per item: `setTimeout(0)` per item costs at
  least 1 ms each (10k items took ~11 s; `setImmediate` per item ~0.16 s;
  time slices of 10 ms: a few ms per 1k items).
- `async` syntax is not yielding: `for await` over a plain array, `await` of
  resolved values and promise chains run as microtasks and starve timers and
  I/O exactly like a `for` loop.
- Never recurse through `process.nextTick` or `queueMicrotask` without a
  bound: both queues are drained to empty before any I/O runs.
- Less I/O beats async I/O: a long-lived process can keep caches, prepared
  models and connection pools in memory.

### Thread pool

- Know which calls use the pool (list above). Many concurrent `fs`, crypto
  or `dns.lookup` calls queue behind each other; limit their concurrency (see
  `js-async-concurrency`) or raise `UV_THREADPOOL_SIZE`.
- Set `UV_THREADPOOL_SIZE` in the environment that starts the process
  (max 1024); assigning `process.env` inside the app is unreliable because
  the pool may already exist. Raising it never fixes blocking JS, deep
  recursion or tangled code. Network-only services on tiny single-core VMs
  can run with as few as 2 threads.

### Scheduling and ordering

- Application code: use promises and `async`/`await`; do not sprinkle
  `nextTick`/`setImmediate` to fix ordering.
- Library code: an API that is asynchronous must be asynchronous on every
  path. Never call a callback synchronously on a cache hit and
  asynchronously otherwise; defer with `process.nextTick` (Node core
  convention) or `queueMicrotask`.
- Raw callbacks avoid promise wrappers and microtask hops, so they are fine
  in hot system code; in application code readability wins and the
  overhead is negligible. Measure before optimizing.
- Never rely on completion order of parallel pool operations (two
  `fs.readFile` calls finish in either order).

### Timers

- Prefer `node:timers/promises` (`setTimeout`, `setInterval`,
  `setImmediate`) with `{ signal }` for cancellation, and
  `AbortSignal.timeout(ms)` / `AbortSignal.any([...])` for deadlines on
  `fetch`, streams, `events.once` and your own async functions.
- Every timer needs an owner that clears it: the request (its deadline signal),
  the object (`stop`/`close` method), a plugin's `onClose` hook, or graceful
  shutdown (see `node-graceful-shutdown`).
- `unref()` background timers (metrics, heartbeats, cache sweepers) so they
  do not keep the process alive. Do not `unref()` a timer whose callback must
  run (final flush); clear and run it explicitly on shutdown.
- Timer delays are lower bounds, never exact (no hard real-time).
- `setInterval` does not await async callbacks: slow jobs overlap. Use a
  sequential loop (`await task(); await sleep(ms);`) instead.
- `setInterval` skips missed ticks and drifts; the `timers/promises`
  `setInterval` iterator buffers missed ticks and then yields them in a
  burst. Compute the next deadline from a start time when you need
  wall-clock alignment.
- Delays above 2^31 - 1 ms (~24.8 days) become 1 ms with a
  `TimeoutOverflowWarning`; schedule long jobs with a scheduler or re-arm.
- Use `timeout.refresh()` to restart idle/debounce timers instead of
  clearing and creating new ones.
- `timers.enroll()` / `timers.active()` are removed in Node 24; use normal
  timers.
- API table and recipes: [references/timers.md](references/timers.md).

### State across `await`

- Every `await`, callback, timer or event is an interleaving point.
  Check-then-act across one (read stock, `await`, decrement) is a race even
  on one thread.
- Keep each invariant inside one synchronous section, serialize access with
  an Actor, queue or lock, or use an atomic update, `rev` or a transaction
  in MongoDB (`js-async-concurrency`).
- Do not leak references to actor-owned state; the guarantee holds only if
  the actor is the single entry point.

### Measure loop health

- Export event loop utilization (ELU) and loop delay percentiles in
  production. As a default, 10-30% ELU is normal and around 70% the process is
  saturated, so alert well below that, long before errors appear. Tune by
  measurement: capacity comes from the code, never a guess
  ([references/capacity.md](references/capacity.md)).
- **App**: `@fastify/under-pressure` sheds load with 503 and `Retry-After`
  once a limit is passed, and `fastify.isUnderPressure()` lets a route skip
  optional work. `auth8-api` sheds at `maxEventLoopUtilization: 0.98` and
  `maxEventLoopDelay: 1000` as a last resort; the 70% alert must fire long
  before that.

## Patterns

### Know the order (verified on Node 24, CommonJS)

```js
setTimeout(() => console.log('timeout'), 0);
setImmediate(() => console.log('immediate'));
Promise.resolve().then(() => console.log('promise'));
queueMicrotask(() => console.log('microtask'));
process.nextTick(() => console.log('nextTick'));
console.log('sync');
// CJS: sync nextTick promise microtask, then timeout/immediate in any order
// ESM: sync promise microtask nextTick, then timeout/immediate
```

### Time-sliced processing of a large array

Run synchronously until a time budget is spent, then yield to the loop.

```js
import { setImmediate as yieldToLoop } from 'node:timers/promises';

const SLICE_MS = 10;

const processInSlices = async (items, fn, signal) => {
  const results = [];
  let deadline = performance.now() + SLICE_MS;
  for (const item of items) {
    results.push(fn(item));
    if (performance.now() >= deadline) {
      await yieldToLoop(undefined, { signal });
      deadline = performance.now() + SLICE_MS;
    }
  }
  return results;
};
```

### Offload CPU work to a worker thread

A one-file sample is in [references/node-overview.md](references/node-overview.md).
Real services keep a fixed pool of workers instead of one per task; see
`node-multithreading`.

### Per-request deadline in Fastify

```js
const clientGone = (reply) => {
  const controller = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
};

fastify.post('/report', async (request, reply) => {
  const deadline = AbortSignal.timeout(REPORT_TIMEOUT_MS);
  const signal = AbortSignal.any([clientGone(reply), deadline]);
  try {
    return await loadReport(request.body, signal);
  } catch (error) {
    if (deadline.aborted) throw new DomainError('ETIMEOUT', { cause: error });
    if (signal.aborted) return undefined; // the client left, nobody reads the answer
    throw error;
  }
});
```

Map `ETIMEOUT` to 504 in the error handler. The work stops only if the signal
reaches it. **Do not use `handlerTimeout` or `request.signal` on a route with a
body**: on Fastify 5.8 with Node.js 24 the end of the body closes the raw
request, which aborts `request.signal` and cancels the timeout (a POST with a
40 ms limit ran 224 ms and answered 200). For a MongoDB query prefer
`maxTimeMS`: the driver's `signal` is experimental and closes the socket.

### Sequential periodic job (no overlap)

```js
import { setTimeout as sleep } from 'node:timers/promises';

const poll = async (task, intervalMs, signal, logger) => {
  while (!signal.aborted) {
    try {
      await task(signal);
    } catch (error) {
      if (signal.aborted) break;
      logger.error({ err: error }, 'periodic task failed');
    }
    await sleep(intervalMs, undefined, { signal }).catch(() => {});
  }
};
```

### Loop health monitor

```js
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
let last = performance.eventLoopUtilization();

const report = () => {
  const { utilization } = performance.eventLoopUtilization(last);
  last = performance.eventLoopUtilization();
  const p99Ms = delay.percentile(99) / 1e6;
  metrics.send({ elu: utilization, p99Ms, maxMs: delay.max / 1e6 });
  delay.reset();
};

setInterval(report, 5000).unref();
```

## Anti-patterns

| Don't | Why | Do instead |
| ----- | --- | ---------- |
| Busy-wait `sleep` (`while (Date.now() < end);`) | Freezes every user of the process | `await setTimeout(ms)` from `node:timers/promises` |
| `readFileSync`, `pbkdf2Sync`, `execSync` in handlers | Blocks all requests for the call duration | Async/promise API; sync only at start-up |
| `for await` over an array or `await` in a CPU loop "to make it async" | Microtasks never yield to I/O | Time-sliced loop with `setImmediate` or a worker |
| `setTimeout(fn, 0)` per item | >= 1 ms per item | Yield per time slice |
| Recursive `process.nextTick` / microtasks | Starves I/O and timers | Bounded loop, `setImmediate` |
| `setInterval(async () => ...)` | Overlapping runs, unhandled rejections | Sequential `poll` loop |
| Timeout timer per request that is never cleared | Leaks timers and closures, double reply | `AbortSignal.timeout`, `AbortSignal.any` |
| `unref()` on a must-run timer | Process exits before it fires | Clear and run it in graceful shutdown |
| Raising `UV_THREADPOOL_SIZE` to fix slow JS | Pool is not the JS thread | Profile, chunk, move CPU work to workers |
| Relying on `setTimeout(0)` vs `setImmediate` order in main code | Unspecified | State the dependency explicitly |
| `nextTick`/`setImmediate` juggling in business logic | Hidden ordering coupling | `await`, events, queues |
| Check-then-act across `await` on shared state | Lost updates, oversell | Actor, lock, atomic update, `rev` |
| Huge `JSON.parse`/`stringify` on the main thread | Long synchronous pause | Limit size, stream, or worker |

## Checklist

- [ ] No `*Sync` calls, busy waits or unbounded CPU loops on request paths,
      event handlers or timer callbacks.
- [ ] User-controlled sizes are bounded before parsing, sorting, regex.
- [ ] CPU-heavy work is time-sliced with `setImmediate` or offloaded to
      `worker_threads`.
- [ ] No unbounded `process.nextTick` / microtask recursion.
- [ ] Concurrency of pool-backed calls (fs, crypto, `dns.lookup`, zlib) is
      bounded; `UV_THREADPOOL_SIZE` is set only with a reason.
- [ ] Application logic does not depend on phase order or on the order of
      parallel completions.
- [ ] Async APIs never call their callback synchronously.
- [ ] Every timer is cleared by its owner (request close, `stop()`,
      shutdown); background timers are `unref()`ed.
- [ ] No `setInterval` with async callbacks; periodic jobs run sequentially.
- [ ] Deadlines use `AbortSignal.timeout` / `{ signal }`; no delays over
      2^31 - 1 ms.
- [ ] Shared mutable state touched across `await` is serialized (actor,
      lock) or written atomically (`$inc`, `rev`, transaction).
- [ ] ELU and loop delay are monitored; alerts fire well below 70% ELU, and
      apps shed load through `@fastify/under-pressure`.

## When Node fits

Good fit: I/O-bound APIs, real-time (WebSocket) backends, BFF and SSR layers,
integration services, crawlers. Poor fit: heavy numeric computation, hard
real-time (any GC runtime). One process serves many users in one address space,
so a blocked loop, a crash or a breach hits everyone. Anatomy and an upgrade
checklist:
[references/node-overview.md](references/node-overview.md).

Related skills: `js-async-patterns`, `js-async-concurrency`,
`node-multithreading`, `node-performance-profiling`, `node-graceful-shutdown`,
`node-events`, `node-streams`, `node-http-server`, `error-handling`.
