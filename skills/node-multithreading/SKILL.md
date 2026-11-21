---
name: node-multithreading
description: Node.js worker threads, processes, IPC, shared memory and pools. Use when offloading CPU work, adding workers or debugging IPC, races or hangs
---

# Node.js Multithreading and Multiprocessing

With this skill the agent first checks whether parallelism is needed at all.
When it is, the agent picks the cheapest mechanism that isolates enough, has
threads and processes share nothing and talk through small correlated
messages, uses shared memory only with Atomics or locks, and handles errors,
timeouts and termination for every thread or child process it starts.

## Decision guide

| Situation                                                            | Use                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| I/O-bound request handling (DB, HTTP, fs)                            | Stay on the event loop; async I/O already uses the libuv pool       |
| CPU-bound task > a few ms per call (hash, parse, image, compression) | Fixed-size `worker_threads` pool                                    |
| Long CPU job, one at a time (report, import)                         | One dedicated worker per job, or a pool of size 1                   |
| Background job that must survive a restart or retry (App)            | BullMQ, with workers in a separate service                          |
| Run another program, or need a crash/memory boundary                 | `child_process` (`spawn`/`execFile`, or `fork` for Node code)       |
| More throughput than one machine / one process                       | Replicas behind a load balancer (containers); threads inside each   |
| Share hot numeric state between threads                              | `SharedArrayBuffer` + `Atomics`, guarded by a lock                  |
| Cross-thread critical section on a named resource                    | Single owner thread (actor), or a lock from `js-async-concurrency`  |
| Legacy app already on `cluster` / pm2 cluster mode                   | Keep it working; do not extend it; plan migration (see below)       |

Which pool:

- **Library:** zero runtime dependencies, so no Piscina. Prefer to accept a
  pool or a `run` function from the caller. If threads are the library's job,
  use the shape in [references/worker-pool.md](references/worker-pool.md).
- **App:** use Piscina. Write your own only for custom routing, per-thread
  state or balancing by event loop utilization.

Defaults, and why:

- JavaScript runs single-threaded, but Node.js does not: V8 runs GC and
  compiler threads, and libuv runs a thread pool (4 threads by default,
  `UV_THREADPOOL_SIZE`). Parallelism is something you choose, not something
  you get by default.
- Treat `cluster` as legacy. The primary process accepts every connection
  and passes the descriptors on, so it can become the bottleneck while the
  workers stay underused. The default is one container per replica, with the
  orchestrator doing delivery and balancing, and worker threads inside it for
  CPU work. A thread that serves the network owns its own port behind the
  balancer.
- Each `Worker` is a full V8 isolate with its own heap, GC, event loop and
  globals. It costs megabytes and several milliseconds to start. Too many
  threads cost CPU in context switches. Keep the number bounded and long-lived.
- Default to share-nothing message passing (the actor model). Shared memory is
  the fastest form of coupling and also the most dangerous one.

## Rules

Offloading

- Measure first: check `performance.eventLoopUtilization()` and
  `perf_hooks.monitorEventLoopDelay()`. Offload only synchronous work that
  measurably blocks the loop. Never move async I/O into workers "for speed".
- Never create a `Worker` per request or per task. Create a pool at startup
  with a fixed size (default `os.availableParallelism() - 1`, never above the
  core count) and reuse it.
- Keep the main thread a coordinator. It accepts I/O, dispatches work and
  merges results. It never runs `Atomics.wait` or long synchronous loops.

Messaging

- Give every request message an `id` and keep a map from id to
  `{ resolve, reject, timer }` on the caller side. Results arrive out of
  order.
- Put a timeout on every cross-thread or cross-process call. When it expires,
  reject, terminate the stuck worker and spawn a replacement. A CPU loop
  cannot be cancelled any other way.
- Send plain data (DTOs). `postMessage` uses structured clone: functions throw
  `DataCloneError`, class instances arrive as plain objects without prototype,
  getters or methods, and `Map`, `Set`, `Date`, `BigInt`, typed arrays and
  `Error` survive. `postMessage` throws synchronously, so a pool must catch it
  around every send, or a bad argument on a queued task crashes the process.
- Cloning copies, so its cost grows with payload size. Send ids or offsets
  instead of large object graphs. Move binary data with a transfer list
  (`postMessage(message, [arrayBuffer])`): the sender's buffer is then detached
  (`byteLength === 0`), so never touch it afterwards.
- Route messages through a handler table keyed by `message.name` (or
  `command`). Avoid `if/else` chains over message types.
- Use `MessageChannel` to give a request its own reply port, or to connect two
  workers directly. Use `BroadcastChannel` for one-to-all notifications
  (config reload, cache invalidation). Close ports and channels when done,
  because open ones keep threads alive.

Errors and lifecycle

- Always subscribe to `error` and `exit` on every `Worker` and `ChildProcess`
  (plus `messageerror` on workers). When a thread dies, reject its in-flight
  tasks and respawn it if the exit code is non-zero. Respawn after a short
  delay: a worker that fails at load otherwise restarts in a hot loop.
- An uncaught exception or unhandled rejection in a worker emits `error` on
  the `Worker` object (the error class survives) and then `exit` with code 1.
  Inside a worker, `process.exit(n)` ends only that thread.
- Capture `worker.threadId` before `exit`, because it reads `-1` inside the
  exit handler.
- Shut down in two phases: send `{ name: 'stop' }`, let the worker close its
  servers and ports so the loop drains, and call `terminate()` only after a
  timeout. `terminate()` is abrupt: no `finally`, no flush. Worker stdout is
  forwarded asynchronously, so a `process.exit()` in the main thread can drop
  worker logs.
- Signals (`SIGINT`, `SIGTERM`) reach only the main thread. Coordinate
  shutdown from there, as described in `node-graceful-shutdown`.
- Use `resourceLimits` (`maxOldGenerationSizeMb`, `stackSizeMb`) to keep a
  runaway worker from eating the whole heap, but treat it as best effort: a
  burst of large allocations can still abort the whole process. For a hard
  memory or crash boundary, use a child process or a container.

Shared memory

- Every read-modify-write on a `SharedArrayBuffer` must use `Atomics.*` or
  happen under a lock. Plain `array[i] += 1` from two threads loses updates.
- Prefer not sharing: give a resource one owner thread and send it
  messages (actor model). When a cross-thread lock is unavoidable, the Web
  Locks API is the target shape:
  `navigator.locks.request(name, async (lock) => { ... })`, where the async
  callback is the critical section and the lock is released when its
  promise settles.
- Check the runtime before trusting Web Locks across threads: they are
  reliable on Node 26, broken across threads on Node 24 and absent on 22. The
  version matrix and a tested Atomics mutex are in `js-async-concurrency`.
- When you do write an Atomics lock, acquire it with an `Atomics.exchange` or
  `compareExchange` loop, never with "wait, then store" (see
  [references/shared-memory.md](references/shared-memory.md)). On the main
  thread use `Atomics.waitAsync`, never `Atomics.wait`.
- Acquire multiple locks in one global order, hold them briefly and release
  them in `finally`, to avoid deadlocks. Avoid state machines that retry
  forever, which cause livelocks.

Processes

- Use `spawn` or `execFile` with an argument array for external programs.
  Never use `exec` with interpolated input (shell injection). Pass `signal`
  (`AbortSignal.timeout(ms)`) or `timeout`, and handle the `error` event (for
  example ENOENT).
- Use `fork` for Node code that needs its own process. Pass
  `serialization: 'advanced'` to keep `Map`, `Set`, `Date`, `Buffer` and
  `BigInt` (the JSON default turns them into `{}` or strings).
- Kill child processes when the parent exits: they can outlive it if they are
  hung or ignore signals. Prefix logs with `pid` or `threadId`, because all
  children share one terminal and their lines interleave.
- Listening sockets and connections can be passed to child processes (as a
  `send` handle) but not to worker threads. Threads that serve the network
  each listen on their own port behind a balancer, or receive data through
  messages.

## Patterns

### Offload one CPU-bound function

```js
// main.mjs
import { Worker } from 'node:worker_threads';

const runWorker = (file, workerData, timeoutMs = 10_000) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(file, { workerData, name: 'report' });
    const timer = setTimeout(() => {
      reject(new Error('Worker timed out'));
      worker.terminate();
    }, timeoutMs);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    worker.once('message', (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    worker.once('error', fail);
    worker.once('messageerror', (error) => {
      fail(error);
      worker.terminate();
    });
    worker.once('exit', (code) => fail(new Error(`Worker exited with code ${code}`)));
  });
```

```js
// report.mjs
import { parentPort, workerData } from 'node:worker_threads';

const build = ({ year }) => ({ year, rows: [] });
parentPort.postMessage(build(workerData));
```

Call it with `runWorker(new URL('./report.mjs', import.meta.url), { year: 2026 })`.
The `exit` handler also covers a worker that ends without posting a result,
which would otherwise leave the promise pending forever; after a result, its
`reject` is a no-op.

This shape fits rare, long jobs. For frequent tasks, use a pool: see
[references/worker-pool.md](references/worker-pool.md) for a tested
`WorkerPool` with id correlation, a queue, timeouts, crash respawn and transfer
lists.

### Transfer instead of copy

```js
const pixels = new Uint8Array(width * height * 4);
const { buffer } = pixels;
const result = await pool.exec('blur', [buffer, width, height], [buffer]);
// buffer.byteLength === 0 here: ownership moved to the worker
```

### Direct reply port and broadcast

```js
const { MessageChannel, BroadcastChannel } = require('node:worker_threads');

const call = (worker, data, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel();
    const timer = setTimeout(() => {
      port2.close();
      reject(new Error('Call timed out'));
    }, timeoutMs);
    port2.once('message', (result) => {
      clearTimeout(timer);
      port2.close();
      resolve(result);
    });
    worker.postMessage({ name: 'invoke', data, port: port1 }, [port1]);
  });

const config = new BroadcastChannel('config');
config.postMessage({ name: 'reload', version: 2 });
```

The worker answers on the transferred `port` and closes it.

### Cross-thread lock (Web Locks API)

```js
const { locks } = require('node:worker_threads');

const transfer = (from, to, amount) =>
  locks.request(`account:${from.id}`, async () => {
    const balance = await storage.getBalance(from.id);
    if (balance < amount) throw new Error('Insufficient funds');
    await storage.move(from.id, to.id, amount);
  });
```

The same code protects async races on one thread (Node 24+;
`worker_threads.locks` is `undefined` on 22) and, on Node 26+, across
worker threads. To lock two accounts, request them in sorted id order to
avoid deadlock.

### Graceful worker stop

```js
// worker side
parentPort.on('message', async (message) => {
  if (message.name !== 'stop') return;
  await new Promise((resolve) => server.close(resolve));
  parentPort.close();
});

// main side
const stopWorker = async (worker, timeoutMs = 5000) => {
  const exited = new Promise((resolve) => worker.once('exit', resolve));
  worker.postMessage({ name: 'stop' });
  const timer = setTimeout(() => worker.terminate(), timeoutMs);
  await exited;
  clearTimeout(timer);
};
```

### Actor model

Split the work into actors by responsibility (renderer, mailer, monitor). An
actor keeps private state, never calls other actors and only receives or sends
messages, which are always copied. The actor code stays the same whether the
actor system runs on promises, threads or processes; only the transport
changes. Keep each actor's input queue in the coordinator, not in the actor,
because actors can crash and restart. A tested threaded actor system is in
[references/processes-ipc.md](references/processes-ipc.md#actor-model).

## Anti-patterns

- **`new Worker()` per HTTP request.** It costs milliseconds and megabytes
  each time, and memory is unbounded under load. Use a pool created at
  startup.
- **Workers for async I/O** (moving `fetch` or DB queries into threads by
  default). This adds serialization and gains nothing. Keep I/O on the loop.
- **Blocking the main thread** with `Atomics.wait`, `while` spin loops or sync
  crypto/zlib/fs in request handlers. Use `Atomics.waitAsync`, the async APIs,
  or a worker.
- **Big object graphs in every `postMessage`.** Clone cost is O(size) on both
  sides. Send ids, transfer `ArrayBuffer`s, or keep the data in the worker.
- **Sending class instances or functions** and expecting methods on the other
  side. Send DTOs and rebuild objects on arrival.
- **No `error`/`exit` handlers.** Promises then hang forever when a worker
  dies. Reject in-flight tasks and respawn.
- **Unsynchronized shared memory** (`shared[i]++` from several threads).
  Use `Atomics.add` or a lock.
- **"Wait then store" locks**, which two threads can pass at once. Use an
  exchange or CAS loop.
- **Locks acquired in different orders** in different code paths, which
  deadlocks.
- **`exec()` with interpolated user input** (a template string passed to a
  shell), which allows shell injection. Use `execFile`/`spawn` with an args
  array.
- **`cluster` for new projects**, or more cluster processes than cores. Use
  replicas behind a balancer, with threads inside.
- **Forking a process per request** to isolate requests. This turns Node into
  CGI/PHP-style process-per-request, with memory and context-switch costs.
  Isolate in-process instead (see `node-async-context`).
- **Fire-and-forget children**: no kill on parent exit, no timeout, no
  `error` listener. They leak as zombie or orphan processes.

## Checklist

- [ ] The offloaded work is CPU-bound and measured (ELU or loop delay), not async I/O.
- [ ] Workers come from a bounded, long-lived pool sized to the cores.
- [ ] Every call has an id, a timeout and a rejection path; stuck workers are terminated and replaced.
- [ ] `error`, `exit` and `messageerror` handlers exist; in-flight tasks are rejected on crash.
- [ ] Respawn is delayed; `postMessage` failures reject the task instead of crashing.
- [ ] Messages are plain data; large binary data is transferred, not copied.
- [ ] Shared memory is accessed only via `Atomics` or under a lock; no "wait then store".
- [ ] Locks are taken in a fixed order and released in `finally` or by callback settlement.
- [ ] The main thread never calls `Atomics.wait` or runs long sync loops.
- [ ] Shutdown sends a stop message first and terminates only after a timeout.
- [ ] Child processes: `spawn`/`execFile` with an args array, `signal`/`timeout`, killed on parent exit.
- [ ] `fork` IPC uses `serialization: 'advanced'` when sending `Map`, `Set`, `Date` or `Buffer`.
- [ ] No new `cluster` code; scaling goes through replicas or threads per port.
- [ ] Logs include `pid`/`threadId`; threads have a `name` for debugging.

Related skills: `node-event-loop`, `js-async-concurrency`,
`node-scaling-highload`, `node-graceful-shutdown`, `node-async-context`,
`node-performance-profiling`
