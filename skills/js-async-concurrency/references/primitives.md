# Single-thread primitives (reference)

The checks for these primitives covered the max concurrency, FIFO order,
queue-full rejection, the wait timeout, whether a timed-out waiter is removed,
and the release on throw.

## Counting semaphore

```js
class Semaphore {
  #counter;
  #queue = [];
  #size;
  #timeout;

  constructor({ concurrency, size = Infinity, timeout = 0 }) {
    this.#counter = concurrency;
    this.#size = size;
    this.#timeout = timeout;
  }

  enter() {
    if (this.#counter > 0) {
      this.#counter--;
      return Promise.resolve();
    }
    if (this.#queue.length >= this.#size) {
      return Promise.reject(new Error('Semaphore queue is full'));
    }
    const { promise, resolve, reject } = Promise.withResolvers();
    const waiter = { resolve, timer: null };
    if (this.#timeout > 0) {
      waiter.timer = setTimeout(() => {
        this.#queue.splice(this.#queue.indexOf(waiter), 1);
        reject(new Error('Semaphore timeout'));
      }, this.#timeout);
    }
    this.#queue.push(waiter);
    return promise;
  }

  leave() {
    const waiter = this.#queue.shift();
    if (!waiter) {
      this.#counter++;
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve();
  }

  async exec(fn, ...args) {
    await this.enter();
    try {
      return await fn(...args);
    } finally {
      this.leave();
    }
  }
}
```

- `leave()` hands the slot straight to the oldest waiter. The counter is
  never incremented and then decremented again, so a caller that arrives
  in between cannot take the slot, and waiters are served in order.
- The timeout handler removes exactly that waiter, not the head of the queue.
- `size` bounds memory. Choose it consciously: `Infinity` means you
  accept unbounded waiting, and `0` means "try-acquire or fail".
- To support per-call cancellation, accept `enter({ signal })`, remove the
  waiter on `abort`, and reject with `signal.reason`.

## FIFO async mutex

Use it where `navigator.locks` is not available (Node.js 22), or where a lock
name does not fit.

```js
class Mutex {
  #queue = [];
  #locked = false;

  enter() {
    if (!this.#locked) {
      this.#locked = true;
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers();
    this.#queue.push(resolve);
    return promise;
  }

  leave() {
    const next = this.#queue.shift();
    if (next) next();
    else this.#locked = false;
  }

  async exclusive(fn) {
    await this.enter();
    try {
      return await fn();
    } finally {
      this.leave();
    }
  }
}

class Account {
  #mutex = new Mutex();
  #balance = 0;

  deposit(amount) {
    return this.#mutex.exclusive(async () => {
      const before = this.#balance;
      await audit.log('deposit', amount);
      this.#balance = before + amount;
    });
  }
}
```

- Ownership passes directly to the next waiter, so `#locked` stays `true`
  across the hand-off.
- The mutex is not reentrant: calling `exclusive` inside `exclusive` on the
  same mutex deadlocks.
- With the mutex, deposits of 10, 20 and 30 sum to 60. Without it, the last
  writer wins.
- Expose only `exclusive(fn)` in public APIs. Callers of raw
  `enter`/`leave` pairs forget to call `leave` on the error path.

## Pool with leases

For objects that are expensive to create (workers, parsers, partner clients).
The MongoDB driver has its own pool: configure `maxPoolSize` and
`waitQueueTimeoutMS` instead of wrapping it.

```js
class Pool {
  #idle = [];
  #waiting = [];
  #timeout;

  constructor({ timeout = 0 } = {}) {
    this.#timeout = timeout;
  }

  add(resource) {
    this.#handOver(resource);
  }

  capture() {
    if (this.#idle.length > 0) {
      const resource = this.#idle.shift();
      return Promise.resolve(this.#lease(resource));
    }
    const { promise, resolve, reject } = Promise.withResolvers();
    const waiter = { resolve, timer: null };
    if (this.#timeout > 0) {
      waiter.timer = setTimeout(() => {
        this.#waiting.splice(this.#waiting.indexOf(waiter), 1);
        reject(new Error('Pool capture timeout'));
      }, this.#timeout);
    }
    this.#waiting.push(waiter);
    return promise;
  }

  #lease(resource) {
    let isReleased = false;
    const release = () => {
      if (isReleased) throw new Error('Lease is already released');
      isReleased = true;
      this.#handOver(resource);
    };
    return { resource, release, [Symbol.dispose]: release };
  }

  #handOver(resource) {
    const waiter = this.#waiting.shift();
    if (!waiter) return void this.#idle.push(resource);
    clearTimeout(waiter.timer);
    waiter.resolve(this.#lease(resource));
  }
}

const pool = new Pool({ timeout: 3000 });
for (const client of clients) pool.add(client);

const lease = await pool.capture();
try {
  await lease.resource.send(message);
} finally {
  lease.release();
}
```

- A lease releases exactly once: a second `release()` throws.
- A capture timeout removes the waiter, so a later release cannot hand the
  resource to a caller that has given up.
- On Node.js 24+ `using lease = await pool.capture()` releases at the end of
  the block. Use either `using` or `release()`, not both.

## Token bucket (rate, not concurrency)

A semaphore caps how many calls run at once, while a token bucket caps how
many start per time window. An external API that has a rate limit usually
needs both. For incoming requests in an app, use `@fastify/rate-limit`.

```js
const { setTimeout: delay } = require('node:timers/promises');

class TokenBucket {
  #capacity;
  #refillPerMs;
  #tokens;
  #updatedAt;

  constructor({ capacity, perSecond }) {
    this.#capacity = capacity;
    this.#refillPerMs = perSecond / 1000;
    this.#tokens = capacity;
    this.#updatedAt = performance.now();
  }

  // 0 when a call may start now, otherwise the milliseconds to wait
  take() {
    const now = performance.now();
    const refill = (now - this.#updatedAt) * this.#refillPerMs;
    this.#tokens = Math.min(this.#capacity, this.#tokens + refill);
    this.#updatedAt = now;
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - this.#tokens) / this.#refillPerMs);
  }
}

const acquire = async (bucket, signal) => {
  let waitMs = bucket.take();
  while (waitMs > 0) {
    await delay(waitMs, undefined, { signal });
    waitMs = bucket.take();
  }
};
```

`capacity` is the allowed burst and `perSecond` the sustained rate. This bucket
works per process: with several instances, keep the counter in Redis. For
debounce on timers, see `node-event-loop`.
