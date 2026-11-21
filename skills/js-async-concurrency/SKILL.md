---
name: js-async-concurrency
description: Bound async concurrency in JS and Node with pools, queues, semaphores and locks. Use for races, lost updates, retries, fan-out or pool exhaustion
---

# Async Concurrency Control

Treat every `await` as a point where other code can interleave. Bound every
fan-out and every wait, keep mutable shared state behind one owner or one
atomic write, and make retried operations idempotent. Add a lock only when
restructuring the code cannot remove the race. Contracts and cancellation are
in `js-async-patterns`, threads and shared memory in `node-multithreading`.

## Project profile

|                     | Library (`@alexify/*`)         | App                                         |
| ------------------- | ------------------------------ | ------------------------------------------- |
| Limits              | Constructor options            | `env-schema` config, tuned by measured load |
| Cross-process state | None, the driver is injected   | MongoDB atomic writes, `rev`, transactions  |
| Durable jobs        | Not a library concern          | BullMQ (`concurrency`, `limiter`)           |

## Mental model

- JavaScript runs one thread per isolate. Synchronous code between two
  `await`s (or callbacks) runs to completion without interruption, so it is
  atomic within that thread. Races appear at `await` boundaries.
  **Lost update** means reading state, awaiting, then writing a value
  computed from the stale read. **Check-then-act** means a condition
  checked before an `await` and acted upon after it.
- True data races, such as torn reads of a value, exist only with shared
  memory (`SharedArrayBuffer`) across threads or processes. They need
  `Atomics` or locks.
- A semaphore and a concurrent queue solve the same problem: they limit
  throughput so that async code does not grab all memory, sockets, file
  descriptors or DB connections. A semaphore guards entry to a section, and
  callers await their turn. A queue owns the tasks and dispatches them to
  channels, so producers just push.
- Concurrency (N at once) is not the same as rate (N per interval). A
  semaphore is not a rate limiter; for rate, use a token bucket.
- Under overload, answering "too busy" fast is better than hanging and
  running out of memory. Queues must be bounded, waits must time out, and
  limits belong in config, tuned by measured CPU and memory load.

## Decision guide

| Problem                                                    | Tool                                                |
| ---------------------------------------------------------- | --------------------------------------------------- |
| Process a known list, at most K at a time                  | `mapLimit` / async pool                             |
| Tasks arrive over time; priorities, timeouts, pause, drain | Concurrent queue                                    |
| Work must survive a crash or run on another instance       | BullMQ (App)                                        |
| At most K callers inside a code section                    | Counting semaphore (`exec(fn)`)                     |
| Serialize access to one in-process resource                | Async mutex or `navigator.locks.request(name, fn)`  |
| Serialize per entity (per user, per file), parallel across | Per-key promise chain or lock name `entity:${id}`   |
| Many callers ask for the same thing at once                | Single-flight (map of in-flight promises)           |
| Reuse expensive objects (workers, clients)                 | Pool with leases, capture timeout and release-once  |
| Named critical section across worker threads               | Atomics mutex (22/24), Web Locks (26+), see below   |
| Several processes or servers                               | Atomic update, `rev` filter, unique index, transaction |
| Limit calls per time unit                                  | Token bucket; `@fastify/rate-limit` for incoming    |

## Rules

### Bound everything

- Never use `Promise.all(items.map(task))` over a collection whose size
  you do not control. Use `mapLimit`, a semaphore or a queue, with the
  limit taken from config.
- Every wait has an upper bound: a time limit for waiting in the queue, a
  processing timeout per task, and an acquire timeout for locks and pools
  (`{ signal: AbortSignal.timeout(ms) }`). Every queue has a maximum size,
  and when the queue is full, reject at once (HTTP 503/429 plus
  `Retry-After`).
- A processing timeout must free the slot even if the task ignores its
  signal. Pass the signal to the task so it can stop, and ignore its late
  result.
- Stop handing out new work after the first fatal error. `Promise.all`
  rejects but does not stop the others, so abort a shared controller.

### Writing a correct queue, semaphore or pool

- Use one guarded completion path per task. Make `finish(error, result)`
  idempotent with a `finished` flag. Success, failure and timeout all go
  through it, and late callbacks are ignored.
- Decrement the active counter before starting the next task and before
  checking for idle. Fire "drain" only when `active === 0` and nothing is
  waiting.
- Each task's completion triggers the next launch. Do not refill channels
  with `Promise.race` over a batch. Start
  `Math.min(freeChannels, waiting.length)` tasks in one synchronous loop.
- Hand a released slot directly to the next waiter (`queue.shift()` and
  resolve it) without incrementing the counter first. This gives FIFO
  fairness, and newcomers cannot barge in. Never use `pop()`, which is LIFO
  and starves the oldest waiters.
- When a waiter times out, remove it from the wait list. Otherwise a later
  release hands the resource to a waiter that has already given up, and the
  resource is lost.
- Release in `finally`. Better still, expose a scoped API (`exec(fn)`,
  `locks.request(name, fn)`, or `using lease` on Node.js 24+) so callers
  cannot forget to release.
- Run sync throws and async rejections of the task through the same path:
  `async #run(task) { return this.#process(task); }`.
- Keep one contract. A queue either returns a promise per `add()`, or it
  emits `success`/`failure`/`done`/`drain` events. Not both at once.
- Queue overhead is tiny next to the business logic. Profile before
  optimizing; use a heap or deque (`data-structures`) only for long lists.

### Critical sections and locks

- Remove the race before you add a lock. Do all the awaits first, then
  re-read and write in one synchronous block, or use one atomic update
  (`$inc` with a condition in the filter). Alternatively, give the state a
  single owner: a queue with `concurrency: 1`, or an actor.
- Keep critical sections short. Do not await unrelated I/O, user input or
  remote calls while holding a lock.
- Locks are not reentrant (Web Locks, typical mutexes). Requesting the same
  lock inside its own callback deadlocks.
- When you need several locks, acquire them in one global order (sorted
  names) or take one coarser lock. Always set an acquire timeout, so that
  a deadlock surfaces as an error instead of a silent hang.
- Prefer Web Locks over hand-written mutexes inside one thread: the lock is
  released when the callback's promise settles, and it supports `signal`,
  `ifAvailable`, `mode: 'shared'` and `steal`. `navigator.locks` exists in
  Node.js 24+ but not in 22. Across worker threads it broke under contention
  on 24.14 and was correct on 26.13, so on 22/24 use an Atomics
  `compareExchange` + `Atomics.waitAsync` mutex or a single owner thread.
  API, ordered multi-lock, stress results and the mutex:
  [references/locks-and-threads.md](references/locks-and-threads.md).
- Never spin or busy-wait. Never call `Atomics.wait` on a thread that
  serves I/O, because it blocks the event loop. Use `Atomics.waitAsync`
  or message notifications.

### Across processes: MongoDB

In-memory locks protect nothing once there are two instances. Pick the
cheapest guarantee that holds:

1. **Atomic operator** on one document: `$inc`, `$set`, `$setOnInsert`, with
   the rule in the filter. No `rev` needed.
2. **Optimistic concurrency** when the new value needs domain logic: filter
   by `{ cuid, rev }`, write with `$inc: { rev: 1 }`. `matchedCount === 0` is
   a conflict: retry the whole read-modify-write, then answer 409.
3. **Unique index** for "only once": idempotency keys, one active record.
4. **Transaction** only for invariants across documents. Pass `{ session }`
   to every call, run calls one after another, and keep external effects out
   of the callback, because it can run several times.

Code for all four: [references/mongodb.md](references/mongodb.md). Data
access itself: `node-data-access`.

### Fairness, starvation, idempotency

- Strict priority starves low-priority work. Add aging, a cap, or
  round-robin by source (for example a client id), so that one noisy client
  cannot occupy every channel.
- Timeouts plus retries produce duplicates, so operations that change
  state must be idempotent. Use an idempotency key stored under a unique
  index, upserts, or dedupe of in-flight work (single-flight).
- Retry only transient failures that are safe to repeat, with a growing
  delay, jitter and a cap, or contenders livelock. Use `retry` from
  `error-handling`. MongoDB transactions retry on the
  `TransientTransactionError` label instead of codes.

### Testing races

- Unit tests rarely catch races. Run stress tests with randomized delays,
  thousands of iterations, and several contenders. Assert invariants such
  as the maximum number of concurrent holders, totals and balances, not
  just the final value of one run. A failure that shows up once in ten
  million runs is still a bug.
- Shield application code from races with high-level abstractions:
  per-request context, scoped lock APIs, a queue per entity. Do not ask
  every developer to write locking code.

## Patterns

### Bounded parallel map (async pool)

```js
const mapLimit = async (items, limit, fn, { signal } = {}) => {
  if (!(limit >= 1)) throw new RangeError('limit must be at least 1');
  const results = new Array(items.length);
  let index = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && index < items.length) {
      signal?.throwIfAborted();
      const current = index++;
      try {
        results[current] = await fn(items[current], current);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const count = Math.min(limit, items.length);
  const workers = new Array(count);
  for (let i = 0; i < count; i++) workers[i] = worker();
  await Promise.all(workers);
  return results;
};

const signal = AbortSignal.timeout(30_000);
const fetchPage = (url) => fetch(url, { signal });
const pages = await mapLimit(urls, config.fetchConcurrency, fetchPage, { signal });
```

K workers pull from a shared cursor. `index++` is safe because it runs
synchronously between awaits. Results keep their input order.

### Semaphore and concurrent queue

```js
const partnerSlots = new Semaphore({ concurrency: 10, size: 100, timeout: 2000 });
const quote = await partnerSlots.exec(() => partner.getQuote(order));

const limits = { concurrency: 3, size: 1000, wait: 2000, timeout: 5000 };
const sendJob = async (job, { signal }) => sendEmail(job, { signal });
const queue = new ConcurrentQueue({ ...limits, process: sendJob });
const result = await queue.add(job, { priority: 1 });
await queue.drain();
```

Full classes: [references/primitives.md](references/primitives.md) (semaphore,
FIFO mutex, pool with leases, token bucket) and
[references/concurrent-queue.md](references/concurrent-queue.md). The MongoDB
driver has its own pool: set `maxPoolSize` and `waitQueueTimeoutMS` instead of
wrapping it. The queue lives in memory and loses its jobs on a crash: durable
work belongs in BullMQ.

### Lost update: fixes in order of preference

```js
// Race: two concurrent calls both read 100 and both save 100 - amount
const withdraw = async (cuid, amount) => {
  const account = await accounts.findOne({ cuid });
  await audit.log('withdraw', cuid, amount);
  const balance = account.balance - amount;
  await accounts.updateOne({ cuid }, { $set: { balance } });
};

// 1. One atomic update (safe across processes), balance in integer minor units
const withdrawAtomic = async (cuid, amount) => {
  const filter = { cuid, balance: { $gte: amount } };
  const result = await accounts.updateOne(filter, { $inc: { balance: -amount } });
  if (result.matchedCount === 0) throw new DomainError('EFUNDS');
};

// 2. Optimistic concurrency, when the aggregate must decide
const withdrawChecked = async (cuid, amount) => {
  const account = await accounts.findOne({ cuid });
  const balance = debit(account, amount);
  const update = { $set: { balance }, $inc: { rev: 1 } };
  const result = await accounts.updateOne({ cuid, rev: account.rev }, update);
  if (result.matchedCount === 0) throw new DomainError('ECONFLICT');
};

// 3. In-memory state: no await between read and write
const deposit = async (wallet, amount) => {
  wallet.balance += amount;
  await audit.log('deposit', amount);
};

// 4. Serialize per entity inside this process only
const withdrawLocked = (cuid, amount) =>
  navigator.locks.request(`account:${cuid}`, () => withdraw(cuid, amount));
```

Without a fix, concurrent deposits of 10, 20 and 30 end with the last writer's
value instead of 60. On Node.js 22, without Web Locks, use the FIFO mutex.

### Per-key serialization and single-flight

```js
const serializeByKey = () => {
  const tails = new Map();
  return (key, fn) => {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
};

const singleFlight = (fn) => {
  const inFlight = new Map();
  return (key) => {
    const pending = inFlight.get(key);
    if (pending) return pending;
    const promise = fn(key).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };
};

const runForUser = serializeByKey();
await runForUser(userId, () => updateProfile(userId, patch));
const loadUser = singleFlight((cuid) => users.findOne({ cuid }));
```

Work for the same key runs strictly in order, and a failure does not block
the next task. Different keys run in parallel. The maps clean themselves
up, so they do not leak.

## Anti-patterns

- **Unbounded fan-out**: `await Promise.all(rows.map(sendEmail))` over a
  collection. It ends in EMFILE, rate-limit bans, memory spikes or an
  exhausted DB pool. Use `mapLimit` or a queue.
- **Unbounded or timeout-less queues and lock waits**: a stuck dependency
  turns into a memory leak and a hung service. Set a size, a wait timeout
  and an acquire signal.
- **Lock without `finally`**: an exception leaks the lock forever.
- **Reentrant request** of the same lock name, or nested locks taken in
  inconsistent order: deadlock.
- **Check-then-act across `await`**: `if (await isFree(name))` followed
  later by `await create(name)`. Use a unique index and handle the duplicate
  key error, or hold a lock around both steps.
- **In-memory locks for multi-instance invariants**: they do nothing once
  there are two processes. Use atomic updates, `rev` or transactions.
- **`Promise.all` inside a MongoDB transaction**: undefined behaviour in the
  driver. Await each call in turn.
- **Silently dropping writes while "locked"**: callers must wait or fail
  loudly.
- **`Atomics.wait` or spin loops** on threads that serve I/O. Wait-then-store
  is not atomic, so use `compareExchange` loops (`node-multithreading`).
- **Retrying non-idempotent operations** (payments, emails, job enqueues)
  without a key leads to double charges and duplicate jobs.

## Checklist

- [ ] Every fan-out over external or large input is bounded, and its limit
      comes from config.
- [ ] Queues, semaphores and pools have a max size, a wait timeout, and a
      processing or acquire timeout. Overload is rejected fast.
- [ ] The processing timeout frees the slot even if the task ignores the
      signal, and late results are ignored.
- [ ] One idempotent completion path per task. The counter is decremented
      before next/drain. Drain means `active === 0 && waiting === 0`.
- [ ] Waiters are served FIFO by direct hand-off. A waiter that times out
      is removed from the list.
- [ ] Locks are released in `finally` or by scoped APIs. No lock is
      requested again inside itself. Multi-lock order is global, and every
      acquire has a timeout.
- [ ] State read before an `await` is never written back from a stale
      copy. Read-modify-write is synchronous, atomic in MongoDB, guarded by
      `rev`, or locked.
- [ ] Invariants that span processes use atomic updates, unique indexes or
      transactions, not in-memory locks.
- [ ] Retried operations are idempotent, and only transient failures are
      retried, with jitter and a cap.
- [ ] Priority queues cannot starve low priorities (aging or round-robin).
- [ ] Stress tests with random delays assert the maximum concurrency and
      the invariants.
- [ ] Cross-thread locks on Node.js 22/24: Atomics mutex or owner thread.

Related skills: `js-async-patterns`, `error-handling`, `node-multithreading`,
`node-event-loop`, `node-data-access`, `node-scaling-highload`,
`node-graceful-shutdown`, `data-structures`.
