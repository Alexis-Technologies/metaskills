# Worker pool: a tested reference implementation

**App:** use Piscina before copying this. **Library:** zero runtime
dependencies rule out Piscina, so use this shape when threads are really the
library's job. Write your own pool in an app only when you need custom routing,
per-thread state or a specific balancing policy. Keep these properties, all
verified on Node.js 24:

- The pool has a fixed size and is created once at startup.
- Each worker runs one task at a time. Tasks wait in a FIFO queue.
- Every task has an id, a timeout and exactly one settle path.
- On timeout the pool terminates the worker (the only way to stop a CPU loop)
  and spawns a replacement.
- On a crash (`error` or a non-zero `exit`) the pool rejects the in-flight
  task and respawns the worker after a short delay, so a worker file that
  fails at load cannot spin the CPU.
- A message that cannot be cloned rejects its task and leaves the worker free.
- `close()` rejects queued tasks and terminates every worker.
- Binary data travels through the transfer list.

## Piscina in an app

```ts
// plugins/imports.ts: one pool per kind of CPU work, created once
import { availableParallelism } from 'node:os';

import fp from 'fastify-plugin';
import { Piscina } from 'piscina';

declare module 'fastify' {
  interface FastifyInstance {
    imports: { parse: (text: string, signal: AbortSignal) => Promise<unknown> };
  }
}

export default fp(
  async (fastify) => {
    const maxThreads = fastify.config.IMPORT_THREADS ?? Math.max(availableParallelism() - 1, 1);
    const pool = new Piscina({
      filename: new URL('../workers/parse-import.js', import.meta.url).href,
      minThreads: 1,
      maxThreads,
      maxQueue: maxThreads * 4,
      idleTimeout: 30_000,
    });
    const parse = (text: string, signal: AbortSignal) => pool.run({ text }, { signal });
    fastify.decorate('imports', { parse });
    fastify.addHook('onClose', async () => {
      await pool.destroy();
    });
  },
  { name: 'imports', dependencies: ['config'] },
);
```

```ts
// workers/parse-import.ts: a plain function, unit-tested without threads
export default ({ text }: { text: string }) => parseImport(text);
```

- Size it from the CPU the container really gets, not the host's core count
  (`node-scaling-highload`), and leave one core for the event loop.
- Bound the queue. When it is full, `run()` rejects at once: map that to
  `EUNAVAILABLE` (503), never wait.
- Pass `request.signal` or `AbortSignal.timeout()`: a queued task is dropped,
  and a running one ends with its thread.
- The task is structured-cloned. Send small inputs, and move large binary
  data with `Piscina.move()`.
- Export `pool.utilization`, `pool.queueSize` and the wait time as metrics
  (`node-observability`).
- Close the pool in `onClose`, after the requests that used it have finished.

## pool.js

```js
const { Worker } = require('node:worker_threads');

const RESPAWN_DELAY_MS = 100;

class WorkerPool {
  #file;
  #timeoutMs;
  #idle = [];
  #queue = [];
  #busy = new Map();
  #nextId = 0;
  #closed = false;

  constructor(file, { size = 2, timeoutMs = 5000 } = {}) {
    this.#file = file;
    this.#timeoutMs = timeoutMs;
    for (let i = 0; i < size; i++) this.#spawn();
  }

  exec(method, args = [], transfer = []) {
    if (this.#closed) return Promise.reject(new Error('Pool is closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      const message = { id, method, args };
      const task = { id, message, transfer, resolve, reject, timer: null };
      const worker = this.#idle.shift();
      if (worker) this.#run(worker, task);
      else this.#queue.push(task);
    });
  }

  async close() {
    this.#closed = true;
    const error = new Error('Pool is closed');
    for (const task of this.#queue) task.reject(error);
    this.#queue = [];
    const exits = [];
    for (const worker of this.#idle) exits.push(worker.terminate());
    for (const worker of this.#busy.keys()) exits.push(worker.terminate());
    await Promise.allSettled(exits);
  }

  #spawn() {
    if (this.#closed) return;
    const worker = new Worker(this.#file);
    worker.on('message', ({ id, error, result }) => {
      const task = this.#take(worker, id);
      if (!task) return;
      if (error) task.reject(error);
      else task.resolve(result);
      this.#release(worker);
    });
    worker.on('messageerror', (error) => {
      const task = this.#take(worker);
      if (!task) return;
      task.reject(error);
      this.#release(worker);
    });
    worker.on('error', (error) => {
      const task = this.#take(worker);
      if (task) task.reject(error);
    });
    worker.on('exit', (code) => {
      const index = this.#idle.indexOf(worker);
      if (index !== -1) this.#idle.splice(index, 1);
      const task = this.#take(worker);
      if (task) task.reject(new Error(`Worker exited with code ${code}`));
      if (!this.#closed) setTimeout(() => this.#spawn(), RESPAWN_DELAY_MS);
    });
    this.#release(worker);
  }

  #take(worker, id) {
    const task = this.#busy.get(worker);
    if (!task || (id !== undefined && task.id !== id)) return null;
    clearTimeout(task.timer);
    this.#busy.delete(worker);
    return task;
  }

  #release(worker) {
    const next = this.#queue.shift();
    if (next) this.#run(worker, next);
    else this.#idle.push(worker);
  }

  #run(worker, task) {
    task.timer = setTimeout(() => {
      this.#take(worker);
      task.reject(new Error(`Task ${task.id} timed out`));
      worker.terminate();
    }, this.#timeoutMs);
    this.#busy.set(worker, task);
    try {
      worker.postMessage(task.message, task.transfer);
    } catch (error) {
      this.#take(worker);
      task.reject(error);
      this.#release(worker);
    }
  }
}

module.exports = { WorkerPool };
```

## task.js (worker side)

The worker exposes a method table, never `eval` on received strings, and
answers every message. Errors are posted back as `Error` objects, which
structured clone preserves.

```js
const { parentPort } = require('node:worker_threads');

const methods = {
  fib: (n) => (n < 2 ? n : methods.fib(n - 1) + methods.fib(n - 2)),
  sum: (buffer) => {
    const numbers = new Float64Array(buffer);
    let total = 0;
    for (const value of numbers) total += value;
    return total;
  },
};

parentPort.on('message', ({ id, method, args }) => {
  const handler = methods[method];
  if (!handler) {
    const error = new Error(`Unknown method: ${method}`);
    parentPort.postMessage({ id, error });
    return;
  }
  try {
    const result = handler(...args);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error });
  }
});
```

For async methods, use `Promise.resolve(handler(...args)).then(...)` and keep
the same `{ id, error, result }` envelope.

## Usage

```js
const path = require('node:path');
const os = require('node:os');

const { WorkerPool } = require('./pool.js');

const size = Math.max(1, os.availableParallelism() - 1);
const file = path.join(__dirname, 'task.js');
const pool = new WorkerPool(file, { size, timeoutMs: 2000 });

const inputs = [30, 31, 32];
const tasks = [];
for (const input of inputs) tasks.push(pool.exec('fib', [input]));
const values = await Promise.all(tasks);

const numbers = new Float64Array([1, 2, 3.5]);
const { buffer } = numbers;
const total = await pool.exec('sum', [buffer], [buffer]);
// buffer.byteLength === 0: transferred, not copied

await pool.close();
```

Verified behaviour: results come back for parallel calls, a thrown error
rejects with an `Error`, `process.exit(3)` in the worker rejects with
"Worker exited with code 3" and the worker is replaced, an infinite loop
rejects with "timed out" and the worker is replaced, an argument that cannot
be cloned rejects with `DataCloneError` also when the task was queued, a worker
file with a syntax error rejects tasks without spinning the CPU, and the pool
keeps serving afterwards.

## Balance by event loop utilization

Round-robin is blind to load when threads run I/O-heavy routines. Pick the
thread with the lowest utilization since the last check:

```js
const pickLeastLoaded = (workers, previous) => {
  let best = 0;
  let min = Infinity;
  for (let i = 0; i < workers.length; i++) {
    const { performance } = workers[i];
    const current = performance.eventLoopUtilization();
    const delta = performance.eventLoopUtilization(current, previous[i]);
    previous[i] = current;
    if (delta.utilization < min) {
      min = delta.utilization;
      best = i;
    }
  }
  return workers[best];
};

const readBaseline = (workers) => {
  const previous = [];
  for (const worker of workers) previous.push(worker.performance.eventLoopUtilization());
  return previous;
};
```

Re-evaluate on an interval rather than per call, and add `wait` and `timeout`
limits around dispatch.

## Extensions worth adding in production

- A wait limit: reject queued tasks that wait longer than `waitMs`.
- Backpressure: cap `#queue.length` and reject or shed load when it is full.
- Metrics: queue length, task latency, and `worker.performance.eventLoopUtilization()`
  per thread.
- Exclusive and shared modes: a `capture()` that takes a thread exclusively
  next to a round-robin `next()`.
- Graceful close: stop accepting tasks, wait for the busy set to drain with a
  timeout, then terminate.
