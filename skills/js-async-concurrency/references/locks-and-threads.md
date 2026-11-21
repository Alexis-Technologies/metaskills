# Locks across threads (reference)

The thread APIs themselves (Worker, SharedArrayBuffer layout,
MessageChannel, transfer lists, the full Atomics table) are covered in
`node-multithreading`. This file covers the locking side and its gotchas.

## What changes with shared memory

- Inside one thread, synchronous code is never interrupted. Once a
  `SharedArrayBuffer` is shared, another thread can write in the middle of
  a multi-word read, which gives torn values and broken UTF-8 in strings
  stored in the buffer. Even code with no `await` is then not atomic.
- The tools form three layers:
  1. `Atomics`: compare-and-swap style operations (`load`, `store`,
     `add`, `sub`, `exchange`, `compareExchange`) plus `wait`, `waitAsync`
     and `notify`.
  2. `MessagePort`/`MessageChannel`/`BroadcastChannel`, used for
     notifications ("the lock was released", "region N is ready").
  3. The Web Locks API, a high-level layer built on the other two.
- Keep domain code free of `Atomics`. Wrap a buffer region in a class with
  getters and setters, so that domain code reads `enemy.x` while the class
  takes the lock internally.
- Read-only shared data needs no locks. Load a large immutable dataset
  (GeoIP ranges, catalogs, timetables) into a `SharedArrayBuffer` once,
  and every thread reads it with zero copies. For a hot reload, a single
  writer builds a new buffer and swaps the reference. The old buffer is
  collected once no thread references it.

## Web Locks API

```js
const { locks } = navigator; // or require('node:worker_threads').locks

const result = await locks.request(name, options, async (lock) => {
  // lock.name, lock.mode; return value becomes `result`
});
```

| Option              | Effect                                                          |
| ------------------- | --------------------------------------------------------------- |
| `mode: 'exclusive'` | Default; one holder                                             |
| `mode: 'shared'`    | Many shared holders at once; excludes exclusive holders         |
| `ifAvailable: true` | Do not wait; callback gets `null` when the lock is held         |
| `signal`            | Abort while waiting; rejects with `signal.reason`               |
| `steal: true`       | Take the lock now; the current holder's request rejects (Abort) |
| `locks.query()`     | Snapshot `{ held, pending }` for diagnostics                    |

```js
const state = await locks.request(
  'cache-refresh',
  { ifAvailable: true },
  async (lock) => {
    if (lock === null) return 'skipped'; // someone else is refreshing
    await refreshCache();
    return 'refreshed';
  },
);

const report = await locks.request('catalog', { mode: 'shared' }, () =>
  buildReport(catalog),
);

await locks.request('catalog', async () => {
  await rebuildCatalog(); // exclusive: waits for all shared holders
});
```

- The lock is released when the callback's promise settles. Because the
  release cannot be forgotten, this is better than an `enter`/`leave` pair.
- Use `steal` only for recovery, such as a holder that is known to be
  dead. The previous holder's `request()` promise rejects with
  `AbortError` at once, but its callback keeps running without the lock
  (verified).
- Locks are not reentrant. Requesting the same name inside the callback
  deadlocks.
- Opposite nesting (A then B, and B then A) deadlocks. Acquire locks in sorted
  order, and give every request a `signal: AbortSignal.timeout(ms)` so that a
  deadlock surfaces as an error.
- Lock names are symbolic (`enemy:503`, `account:42`). You lock a name,
  not a buffer.

### Acquire timeout and ordered multi-lock

```js
const { locks } = navigator;

await locks.request(`file:${path}`, { signal: AbortSignal.timeout(2000) }, async () => {
  const data = await fs.readFile(path, 'utf8');
  await fs.writeFile(path, transform(data));
});

const withLocks = (names, fn, options = {}) => {
  const sorted = [...new Set(names)].sort();
  const acquire = (index) => {
    if (index === sorted.length) return fn();
    return locks.request(sorted[index], options, () => acquire(index + 1));
  };
  return acquire(0);
};

const transfer = (from, to, amount) => {
  const names = [`account:${from}`, `account:${to}`];
  return withLocks(names, () => moveMoney(from, to, amount));
};
```

`request` resolves with the callback's result and rejects with its error
(or with `signal.reason`). The sorted order prevents the classic deadlock
where `A->B` meets `B->A`. In verification, 100 opposite transfers without
locks broke the balances; with `withLocks` they always summed up. These locks
hold inside one process only: balances shared by several instances need
`references/mongodb.md`.

### Node.js version matrix (verified on this machine)

| Node.js | `navigator.locks`                    | Across worker threads                           |
| ------- | ------------------------------------ | ----------------------------------------------- |
| 22.23.1 | absent                               | Atomics mutex or a single owner thread          |
| 24.14.1 | present (`worker_threads.locks` too) | unreliable under contention, see below          |
| 26.13.1 | present                              | correct in all stress runs                      |

The stress test: N workers each request the same exclusive lock several
times, hold it for a few ms, and record the maximum number of concurrent
holders in a shared `Int32Array`. On 24.14.1, 2 workers x 10 requests
reached 2 simultaneous holders in 4 of 4 runs, 4 workers x 3 reached 3,
and 4 workers x 5 hung (no further progress) in 3 of 3 runs. Light
contention (3 workers x 1 request) looked fine, which is how a quick test
misses the bug. Within a single thread, 24.14.1 is correct. On Node.js 24,
do not use Web Locks for cross-thread exclusion; use message passing to a
single owner thread, or the Atomics mutex below.

Pitfall: a pending `locks.request()` or `Atomics.waitAsync()` does not keep
the event loop alive. A worker whose only remaining work is waiting
for a lock exits silently with code 0 and never runs its critical section.
Servers and `parentPort` listeners keep a thread alive. Short scripts and
tests need something else that stays pending (verified).

### Third-party polyfills

The `web-locks` package (0.0.9) failed the same stress test: each thread could
end up with its own flag buffer for one name, so every worker entered the
critical section at once, and in another configuration waiters were never
woken. On Node.js 22/24, do not use it or native `navigator.locks` for
cross-thread exclusion. Use the Atomics `compareExchange` +
`Atomics.waitAsync` mutex below (it passed 3, 8 and 16-worker stress tests) or
a single owner thread. Native cross-thread Web Locks were correct on
Node.js 26.13.

## Async mutex on SharedArrayBuffer (non-blocking)

Verified with 4 workers x 200 increments that include awaits: 800 of 800.

```js
const UNLOCKED = 0;
const LOCKED = 1;

class SharedMutex {
  #lock;

  constructor(buffer, offset = 0) {
    this.#lock = new Int32Array(buffer, offset, 1);
  }

  async enter() {
    const lock = this.#lock;
    while (Atomics.compareExchange(lock, 0, UNLOCKED, LOCKED) !== UNLOCKED) {
      const { async, value } = Atomics.waitAsync(lock, 0, LOCKED);
      if (async) await value;
    }
  }

  leave() {
    const prev = Atomics.compareExchange(this.#lock, 0, LOCKED, UNLOCKED);
    if (prev !== LOCKED) throw new Error('SharedMutex is not locked');
    Atomics.notify(this.#lock, 0, 1);
  }
}

const mutex = new SharedMutex(sharedBuffer);
await mutex.enter();
try {
  data[0] += 1;
} finally {
  mutex.leave();
}
```

- `UNLOCKED = 0` means a freshly zeroed buffer starts unlocked, so no
  initialization race can occur.
- The lock is taken by a `compareExchange` loop. `Atomics.wait(...)`
  followed by `Atomics.store(...)` is two steps, and two threads can both
  pass.
- `Atomics.waitAsync` keeps the thread's event loop free. A blocking
  `Atomics.wait` is acceptable only in a pure compute worker, and browsers
  forbid it on the main thread.
- This mutex is unfair (there is no queue) and not reentrant. For
  fairness, use Web Locks (across threads only on Node.js 26+) or a ticket
  lock built from two counters.
- A counting variant (at most N holders) loads the counter and
  `compareExchange`s `n` to `n - 1` while `n > 0`. `leave` does
  `Atomics.add(+1)` plus `notify`. When nested critical sections in one
  thread must be allowed, use such counters instead of a boolean flag.

## Choosing a technique (for reviews)

| Technique                                     | Verdict                       |
| --------------------------------------------- | ----------------------------- |
| `Atomics.wait` then `store`                   | race; blocks the thread       |
| `exchange` + `setTimeout` polling             | correct, wastes CPU           |
| `exchange` + MessagePort "leave" broadcast    | correct, non-blocking         |
| `locks.request` over SAB + messages           | the shape of Web Locks        |
| promise queue, FIFO, `finally`                | single-thread reference shape |
| `compareExchange` loop                        | correct counting semaphore    |
