# Timers: API and recipes

Timers are not part of the JavaScript language; they are host APIs (browser
or Node). In Node the globals are the same functions as in `node:timers`
(`setTimeout === require('node:timers').setTimeout`). Verified on v24.14.1.

## API surface

| API | Returns / notes |
| --- | --- |
| `setTimeout(fn, ms, ...args)` | `Timeout` object; `ms` < 1, `NaN` or > 2147483647 becomes 1 |
| `setInterval(fn, ms, ...args)` | `Timeout`; re-armed after each callback, missed ticks dropped |
| `setImmediate(fn, ...args)` | `Immediate`; runs in the check phase |
| `clearTimeout(t)` / `clearInterval(t)` / `clearImmediate(i)` | `clearTimeout` also accepts the numeric id `+t` |
| `timeout.ref()` / `unref()` / `hasRef()` | Keep / stop keeping the process alive |
| `timeout.refresh()` | Restart the countdown with the same delay and callback, no new allocation |
| `timeout[Symbol.toPrimitive]()` | Numeric id, e.g. to store in a `Map` key |
| `timeout[Symbol.dispose]()` | Clears it; enables `using t = setTimeout(...)` (the `using` syntax needs Node 24+) |
| `process.nextTick(fn, ...args)` | Not a timer: runs before promise microtasks after the current callback |
| `queueMicrotask(fn)` | Standard microtask, same queue as promise reactions |

`node:timers/promises` (all accept `{ signal, ref }` options):

| API | Behaviour |
| --- | --- |
| `setTimeout(ms, value)` | Promise resolved with `value` after `ms` |
| `setImmediate(value)` | Promise resolved in the next check phase; the stable way to yield |
| `setInterval(ms, value)` | Async iterator yielding `value` every `ms`; buffers missed ticks; `break` disposes it |
| `scheduler.wait(ms)` | Same as `setTimeout(ms)` (marked experimental in docs) |
| `scheduler.yield()` | Same as `setImmediate()` (marked experimental in docs) |

Aborting rejects with `AbortError` (`code: 'ABORT_ERR'`); with
`AbortSignal.timeout(ms)` the error's `cause` is a `TimeoutError`.

Removed or internal, never use: `timers.enroll()`, `timers.active()`,
`timers.unenroll()` (gone in Node 24), `timeout._onTimeout`,
`_idleTimeout` and other underscore fields.

## Pitfalls

- **Minimum, not exact.** The callback runs no earlier than `ms` after the
  call; if the loop is blocked it runs whenever the loop is free, together
  with every other overdue timer.
- **Overlap.** `setInterval` does not wait for an async callback; a job that
  takes longer than the period runs concurrently with itself.
- **Drift.** The callback-based interval is re-armed relative to when its
  callback ran, so a slow or late tick shifts the whole schedule.
- **Burst.** The promise `setInterval` iterator queues missed ticks and
  yields them back to back after a slow iteration.
- **Leaks.** A timer holds its closure (request, response, buffers) until it
  fires or is cleared. Per-request timers that are never cleared keep memory
  alive and may act on a finished response.
- **Exit.** A ref'ed timer keeps the process alive (a forgotten
  `setInterval` in a CLI script means it never exits); an unref'ed one lets
  the process exit before it fires.
- **Overflow.** Delays above ~24.8 days fire after 1 ms with a
  `TimeoutOverflowWarning`.
- **Self-rescheduling.** In a `setTimeout` chain, a `stop()` called from
  inside the callback clears the handle that is already firing, and the
  callback then re-arms a new one (verified: it ran forever). Keep a
  `stopped` flag and check it before re-arming.
- **Mutation through `value`.** The promise `setInterval(ms, array)` yields
  the same `array` object on every tick; mutating it (`shift()`) changes
  caller data.

## Recipes

### Sleep, cancellable

```js
import { setTimeout as sleep } from 'node:timers/promises';

await sleep(1000);
await sleep(5000, undefined, { signal: AbortSignal.timeout(100) });
```

The second call rejects with `AbortError` after 100 ms.

### Timeout for a promise that takes no signal

```js
const withTimeout = async (promise, timeoutMs) => {
  const controller = new AbortController();
  const { signal } = controller;
  const timeout = sleep(timeoutMs, undefined, { signal }).then(() => {
    throw new Error(`Timeout of ${timeoutMs} ms exceeded`);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    controller.abort();
  }
};
```

The timer is always cleared, so a fast promise does not keep the process
alive for `timeoutMs`. The underlying operation keeps running; prefer APIs
that accept `{ signal }` so work is actually cancelled.

### Debounce with `refresh()`

```js
const debounce = (fn, delayMs) => {
  let timer = null;
  let lastArgs = [];
  const run = () => {
    timer = null;
    fn(...lastArgs);
  };
  return (...args) => {
    lastArgs = args;
    if (timer) timer.refresh();
    else timer = setTimeout(run, delayMs);
  };
};
```

### Wall-clock aligned periodic task (skips missed slots)

```js
const everyAligned = (fn, periodMs) => {
  const start = performance.now();
  let timer = null;
  let stopped = false;
  const tick = () => {
    fn();
    if (stopped) return;
    const elapsed = performance.now() - start;
    const next = (Math.floor(elapsed / periodMs) + 1) * periodMs;
    timer = setTimeout(tick, next - elapsed);
  };
  timer = setTimeout(tick, periodMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};
```

Verified: with a 250 ms stall on tick 2 of a 100 ms period, ticks ran at
102, 202, 500, 600, 702, 802 ms (slots 300 and 400 skipped, no burst, no
drift).

### Iterate with the promise interval without mutating data

```js
import { setInterval as every } from 'node:timers/promises';

let index = 0;
for await (const items of every(1000, electronics)) {
  console.log({ item: items[index] });
  index++;
  if (index === items.length) break;
}
```

`break` disposes the underlying interval, so the process can exit.

### Timer owned by an object

The object exposes `start`/`stop`, never
leaves a running timer behind, and is idempotent.

```js
class Ticker {
  #intervalMs = 0;
  #listeners = [];
  #timer = null;

  constructor(intervalMs) {
    this.#intervalMs = intervalMs;
  }

  on(listener) {
    this.#listeners.push(listener);
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      for (const listener of this.#listeners) listener();
    }, this.#intervalMs);
  }

  stop() {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
```

### Background maintenance

```js
const sweeper = setInterval(() => cache.prune(), 60_000);
sweeper.unref();
process.once('SIGTERM', () => clearInterval(sweeper));
```

Unref'ed so it never blocks exit; cleared on shutdown so it never runs
against already closed resources. See `node-graceful-shutdown`.
