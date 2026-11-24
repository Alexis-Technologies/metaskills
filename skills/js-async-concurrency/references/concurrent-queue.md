# Concurrent queue (reference)

A promise-per-task concurrent queue with a concurrency limit, a bounded
waiting list, a wait timeout, a processing timeout with an `AbortSignal`,
priorities, pause/resume, clear and drain. It was verified on Node.js 24
for the max concurrency, priority order, timeouts that free slots even when
the task ignores the signal, sync throws, clear and drain. It lives in memory:
jobs that must survive a crash or run on another instance belong in BullMQ.

```js
class ConcurrentQueue {
  #concurrency;
  #size;
  #wait;
  #timeout;
  #process;
  #count = 0;
  #paused = false;
  #waiting = [];
  #idle = null;

  constructor(options) {
    const { concurrency = 1, size = Infinity } = options;
    const { wait = 0, timeout = 0, process } = options;
    this.#concurrency = concurrency;
    this.#size = size;
    this.#wait = wait;
    this.#timeout = timeout;
    this.#process = process;
  }

  get active() {
    return this.#count;
  }

  get waiting() {
    return this.#waiting.length;
  }

  add(task, { priority = 0 } = {}) {
    if (this.#waiting.length >= this.#size) {
      return Promise.reject(new Error('Queue is full'));
    }
    const { promise, resolve, reject } = Promise.withResolvers();
    const item = { task, priority, resolve, reject, timer: null };
    if (this.#wait > 0) {
      item.timer = setTimeout(() => {
        this.#waiting.splice(this.#waiting.indexOf(item), 1);
        reject(new Error('Queue wait timeout'));
        this.#checkIdle();
      }, this.#wait);
    }
    this.#enqueue(item);
    this.#next();
    return promise;
  }

  pause() {
    this.#paused = true;
  }

  resume() {
    this.#paused = false;
    this.#next();
  }

  drain() {
    if (this.#isIdle()) return Promise.resolve();
    this.#idle ??= Promise.withResolvers();
    return this.#idle.promise;
  }

  clear(reason = new Error('Queue cleared')) {
    const items = this.#waiting.splice(0);
    for (let i = 0; i < items.length; i++) {
      clearTimeout(items[i].timer);
      items[i].reject(reason);
    }
    this.#checkIdle();
  }

  #enqueue(item) {
    const queue = this.#waiting;
    let index = queue.length;
    while (index > 0 && queue[index - 1].priority < item.priority) index--;
    queue.splice(index, 0, item);
  }

  #next() {
    if (this.#paused) return;
    const free = this.#concurrency - this.#count;
    const launch = Math.min(free, this.#waiting.length);
    for (let i = 0; i < launch; i++) this.#start(this.#waiting.shift());
  }

  #start(item) {
    clearTimeout(item.timer);
    this.#count++;
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      this.#count--;
      if (error) item.reject(error);
      else item.resolve(result);
      this.#next();
      this.#checkIdle();
    };
    const timeout = this.#timeout;
    const signal = timeout > 0 ? AbortSignal.timeout(timeout) : null;
    if (signal) {
      const onAbort = () => finish(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    }
    this.#run(item.task, signal).then(
      (result) => finish(null, result),
      (error) => finish(error),
    );
  }

  async #run(task, signal) {
    return this.#process(task, { signal });
  }

  #isIdle() {
    return this.#count === 0 && this.#waiting.length === 0;
  }

  #checkIdle() {
    if (!this.#idle || !this.#isIdle()) return;
    this.#idle.resolve();
    this.#idle = null;
  }
}
```

Usage:

```js
const queue = new ConcurrentQueue({
  concurrency: 3,
  size: 1000,
  wait: 2000,
  timeout: 5000,
  process: async (job, { signal }) => sendEmail(job, { signal }),
});

const reply = await queue.add(job, { priority: 10 }); // higher runs first

// graceful shutdown: let active tasks finish, reject the waiting ones
queue.pause();
queue.clear(new Error('Shutting down'));
await queue.drain();
```

`clear()` rejects the promises of tasks that are still waiting, so whoever
called `add()` must already be awaiting those promises or handling them.
Otherwise the rejections are unhandled. Verified with
`AsyncLocalStorage`: code that awaits `add()` keeps the caller's context,
but `process` runs in the context that started it, which is the context
of whichever task freed the slot.

Design notes:

- **Single completion path.** `finish` is guarded by `finished`, so
  success, failure and timeout cannot double-count, and a task that ignores
  the signal and settles late is ignored.
- **Slot accounting.** `#count--` runs before `#next()` and
  `#checkIdle()`. Drain resolves only when nothing is active and nothing is
  waiting. A paused queue with waiting items is not idle.
- **Launch loop.** `Math.min(free, waiting)` is computed once, and the loop
  is synchronous, so nothing can interleave with it.
- **Stable priority.** An item is inserted after all items with the same or
  higher priority, so FIFO order holds within a priority level. Insertion
  is O(n). Beyond a few thousand waiting items, switch to a heap
  (`data-structures`). Add aging if low priorities must not starve.
- **Timeout signal.** `AbortSignal.timeout` timers are unref'd and need no
  cleanup, but they do not keep the process alive: in a short script a hung task
  ends in a silent exit instead of a timeout. Pass `signal` down to `fetch`, DB drivers and `timers/promises`
  so that the work really stops.
- **Bounded.** `size` caps memory. Callers should turn `Queue is full` into
  503/429 with `Retry-After` instead of waiting.
- **Async context.** If `process` needs the caller's `AsyncLocalStorage`
  store (request id, user), capture it in `add()`. For example, store
  `AsyncResource.bind((signal) => this.#run(task, signal))` in the item
  and call it from `#start`. Alternatively, pass the context explicitly
  inside `task` (`node-async-context`).

## Bugs this design avoids

Each of these was reproduced in a real queue or pool:

- **Success skips the guarded `finish`.** The active counter is never
  decremented, so after `concurrency` tasks the queue moves on only through
  timeouts, and later tasks fail with a timeout. Route every outcome through one
  guarded completion function.
- **Drain checks `count === 0` before `count--`** (the decrement sits in a
  later `.finally`), so drain never fires. Decrement first, then compute idle.
- **A timed-out waiter stays in the queue.** It is rejected, but a later
  `release()` hands the instance to it and the instance is lost. Remove
  timed-out waiters.
- **The lock wakes the newest waiter** (`queue.pop()`), which starves the
  oldest, and nothing releases it in `finally`. Use FIFO plus `finally`.
- **Channels are refilled with `Promise.race` over a started batch**, so one
  hanging task stalls the refill. Each completion triggers `next()`.

## Variant: fluent callback queue

A fluent API with callback-last processing functions and listeners suits
fire-and-forget job processing, where results go to a sink:

```js
const queue = Queue.channels(3)
  .wait(4000)
  .timeout(5000)
  .process((task, next) => worker.run(task, next))
  .success((result) => logger.info({ result }, 'done'))
  .failure((error, task) => logger.error({ err: error, task }, 'failed'))
  .drain(() => logger.info('queue drain'));

queue.add({ name: 'Task1' });
```

- `wait(ms)` limits the time spent in the waiting list. Checking it lazily when
  an item is dequeued is cheap (no timer per item), but an expired item is then
  reported only when a channel frees up.
- `timeout(ms)` limits processing. The late `next()` call is ignored through
  a `finished` flag.
- `pause()`/`resume()` stop and restart dispatching. `priority()` switches
  to sorting by priority. `pipe(otherQueue)` forwards results into a
  second queue.
- Useful extensions: rate limiting on top of concurrency, LIFO for
  freshness-first work, and round-robin by a factor (for example a client id)
  for fairness.
- A queue can also be an object-mode `Readable`: `read()` launches up to the
  free channels, results are pushed downstream, and backpressure comes for free
  (`node-streams`).

Choose one style per codebase. Promise-per-task suits request/response
callers. Listener style suits job processing.
