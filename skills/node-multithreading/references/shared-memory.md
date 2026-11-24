# Shared memory: SharedArrayBuffer, Atomics, locks

Share memory only when profiling shows that message copying is the
bottleneck, and only for numeric or binary data (counters, flags, ring
buffers, matrices). Everything else should go through messages.

## Setup

```js
const { Worker, isMainThread, workerData } = require('node:worker_threads');

if (isMainThread) {
  const shared = new SharedArrayBuffer(1024);
  new Worker(__filename, { workerData: { shared } });
} else {
  const view = new Int32Array(workerData.shared);
  Atomics.add(view, 0, 1);
}
```

A `SharedArrayBuffer` passed in `workerData` or `postMessage` is shared, not
copied (unlike an `ArrayBuffer`). Each thread wraps it in its own typed-array
view. Several views at different offsets can share one buffer, for example a
lock word at offset 0 and data after it.

## Atomics API (on Int32Array / BigInt64Array views for wait/notify)

| Call                                    | Returns / effect                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `Atomics.load(a, i)` / `store(a, i, v)` | Atomic read / write                                                          |
| `add`, `sub`, `and`, `or`, `xor`        | Atomic read-modify-write, returns the previous value                         |
| `exchange(a, i, v)`                     | Sets `v`, returns the previous value                                         |
| `compareExchange(a, i, expected, v)`    | Sets `v` only if the current value is `expected`; returns the previous value |
| `wait(a, i, v, timeoutMs?)`             | Blocks while `a[i] === v`: `'ok'`, `'not-equal'`, `'timed-out'`              |
| `waitAsync(a, i, v, timeoutMs?)`        | `{ async, value }`, where `value` is a promise of the same strings           |
| `notify(a, i, count?)`                  | Wakes up to `count` waiters, returns the number woken                        |

Node allows `Atomics.wait` on the main thread, but it freezes the event loop.
Use `Atomics.waitAsync` there.

## Race condition demo (verified)

Two threads increment and decrement the same `Int32Array` cells one million
times each without synchronization. The result ends up far from zero (for
example `[-759266, -170061]`). With the mutex below it is `[0, 0]`.

## Correct blocking mutex (worker threads only)

```js
const LOCKED = 0;
const UNLOCKED = 1;

class Mutex {
  constructor(shared, offset = 0, initial = false) {
    this.lock = new Int32Array(shared, offset, 1);
    if (initial) Atomics.store(this.lock, 0, UNLOCKED);
    this.owner = false;
  }

  enter() {
    let prev = Atomics.exchange(this.lock, 0, LOCKED);
    while (prev !== UNLOCKED) {
      Atomics.wait(this.lock, 0, LOCKED);
      prev = Atomics.exchange(this.lock, 0, LOCKED);
    }
    this.owner = true;
  }

  leave() {
    if (!this.owner) return false;
    this.owner = false;
    Atomics.store(this.lock, 0, UNLOCKED);
    Atomics.notify(this.lock, 0, 1);
    return true;
  }
}
```

The primary thread creates it with `new Mutex(shared, 0, true)`. Workers
create it with `new Mutex(shared)`. Always wrap the critical section:

```js
mutex.enter();
try {
  point.move(1, 1);
} finally {
  mutex.leave();
}
```

### The bug to recognise in reviews

```js
// BAD
class BrokenMutex {
  enter() {
    Atomics.wait(this.lock, 0, LOCKED);
    Atomics.store(this.lock, 0, LOCKED);
  }
}
```

Two threads can both return from `wait` (the value is UNLOCKED) before either
one calls `store`, so both enter the critical section. The check and the set
must be one atomic operation: an `exchange` or `compareExchange` loop.

## Counting semaphore (verified: never more than N inside)

```js
class CountingSemaphore {
  constructor(shared, offset = 0, initial) {
    this.counter = new Int32Array(shared, offset, 1);
    if (typeof initial === 'number') {
      Atomics.store(this.counter, 0, initial);
    }
  }

  enter() {
    while (true) {
      Atomics.wait(this.counter, 0, 0);
      const n = Atomics.load(this.counter, 0);
      if (n > 0) {
        const prev = Atomics.compareExchange(this.counter, 0, n, n - 1);
        if (prev === n) return;
      }
    }
  }

  leave() {
    Atomics.add(this.counter, 0, 1);
    Atomics.notify(this.counter, 0, 1);
  }
}
```

## Non-blocking cross-thread locks

Blocking `enter()` is acceptable inside a worker whose job is pure
computation. Threads that serve I/O must never block, so use an async lock:

- Web Locks API: `navigator.locks.request(name, options, callback)` or
  `require('node:worker_threads').locks`. The callback holds the lock until
  its promise settles. `options.signal` aborts waiting, `options.ifAvailable`
  calls the callback with `null` instead of waiting, and `locks.query()`
  returns `{ held, pending }`.
- Runtime support, from a stress test with 6 workers and 1-6 ms critical
  sections counting simultaneous holders through Atomics: exclusive on Node
  26.13; on Node 24.14 up to 4 holders at once and a hang, although a light
  test can pass. Within a single thread it is exclusive on 24 as well. Node 22
  has no `navigator.locks`.
- On Node 22 and 24 do not use Web Locks for cross-thread exclusion. Use an
  Atomics `compareExchange` + `Atomics.waitAsync` mutex (the async `SharedMutex`
  in `js-async-concurrency`) or a single owner thread.
- Never poll a lock with `setTimeout` outside a demo: it wastes CPU and adds
  latency.

Pitfall verified on Node 24.14: a pending `locks.request()` does not by
itself keep a worker's event loop alive. A worker whose only pending work is
waiting for a lock can exit with code 0 before it gets the lock. Real workers
usually keep a ref'd `parentPort` listener or a server, which prevents this.

## Concurrency hazards (name them in reviews)

- **Race condition**: an unsynchronized read-modify-write, or a check-then-act
  sequence split across `await` points. This also happens in single-threaded
  async code; see `js-async-concurrency`.
- **Deadlock**: thread A holds lock 1 and waits for 2, while thread B holds 2
  and waits for 1. Fix it with one global lock order, or by requesting all
  resources in sorted order.
- **Livelock**: threads keep reacting to each other (retry, back off, retry)
  and nobody progresses. Add randomized backoff and a retry limit.
- **Starvation**: one thread never gets a lock or a slot. Use FIFO queues
  and fairness.
- **Leaks**: locks never released because of a missing `finally`, or
  callbacks never settled. Prefer callback-scoped APIs (`locks.request`
  where it is reliable, or a `withLock(fn)` wrapper with `finally`) that
  release automatically.

## When not to share memory

- Data that is a JS object graph: it cannot live in a `SharedArrayBuffer`
  without manual layout. Use messages, or keep the data owned by one thread
  (actor) and send it requests.
- Rarely changing configuration: use `BroadcastChannel` or messages.
- Cross-process or cross-host state: use a database, Redis or a queue.
  Memory-mapped files are possible but need an agreed layout, locking flags
  and checksums, so they are the most coupled IPC option.
