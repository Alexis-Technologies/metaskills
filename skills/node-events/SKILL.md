---
name: node-events
description: Write and review event-driven code with EventEmitter, EventTarget and signals. Use for listener leaks, error events or async listeners
---

# Node.js Events: EventEmitter, EventTarget, Observer, Signals

Make the agent treat every subscription as a resource with an owner and an
explicit end, keep events at infrastructure edges instead of business logic,
and pick the right contract (promise, event, stream, signal) for each job.

## Decision guide

| Need | Use | Not |
| --- | --- | --- |
| One result of one operation | `async` function / Promise | emit `'done'` / `'result'` |
| 0..N notifications to unknown, optional subscribers | `EventEmitter` / `EventTarget` | direct callbacks list in fields |
| Ordered data with end, errors, backpressure | Stream or async iterator (`node-streams`) | `'data'` events of your own |
| Pull sequence for one consumer | async generator | emitter + manual buffer |
| Current value + derived values + change propagation | signals / observable state | events that carry full state |
| Wait for one event from an emitter | `await events.once(emitter, name, { signal })` | hand-written `new Promise` + `on` |
| Consume an event series as a loop | `for await (... of events.on(emitter, name, { signal }))` | `on` + shared mutable arrays |

An emitter is a tool for loose coupling: the publisher does not know who
listens, and an emit with no listeners is silently swallowed. That is no reason
to build all async flow on events. Every `on` needs a matching `off` on success,
error, timeout and abort, which is easy to miss. In business logic prefer plain
async functions; keep emitters in infrastructure: sockets, servers, watchers,
process signals, plugin buses.

- **Library**: compose a private `EventEmitter` from `node:events` and expose
  `on`/`off` or `subscribe`.
- **App**: request lifecycle work goes in Fastify hooks, without business
  logic, and durable background work in BullMQ. An in-process event is lost on
  a crash, so it must not carry a state change that has to happen.

## Rules

### EventEmitter vs EventTarget

- Use `EventTarget` + `Event`/`CustomEvent` (globals in Node, browsers, Deno,
  Bun) for isomorphic code; use `EventEmitter` from `node:events` for
  Node-only code and anything stream-related.
- Remember the semantic differences (they are concept-compatible, not
  implementation-compatible):

| Aspect | `EventEmitter` | `EventTarget` |
| --- | --- | --- |
| Subscribe / publish | `on(name, fn)` / `emit(name, ...args)` | `addEventListener(name, fn, options)` / `dispatchEvent(event)` |
| Payload | any arguments | `Event` object, data in `CustomEvent.detail` or subclass fields |
| Same listener added twice | called twice; `off` removes one registration | deduplicated; called once |
| `'error'` with no listener | throws `ERR_UNHANDLED_ERROR` (crashes process) | ordinary name, nothing happens |
| Listener throws | exception escapes from `emit()`, later listeners skipped | reported as `uncaughtException`, other listeners run |
| Built-in cleanup | `off`, `removeAllListeners`, `events.on/once({ signal })` | `{ once: true }`, `{ signal }` |
| Leak warning | `MaxListenersExceededWarning` at 11 per name | same for EventTarget; none by default for `AbortSignal` |

### Subscription lifecycle

- Every subscription has an owner that unsubscribes. Return an unsubscribe
  function (Observer style) or accept an `AbortSignal`; never subscribe in a
  per-request or per-call path to a long-lived emitter without removal.
- For `EventTarget` pass `{ signal }` (and `{ once: true }` for one-shot).
  For `EventEmitter` prefer `events.once(emitter, name, { signal })` and
  `events.on(emitter, name, { signal, close })`: they remove their listeners
  on resolve, reject, `break`, abort, or a `close` event.
- To listen to an `AbortSignal`, use `events.addAbortListener(signal, fn)`: it
  fires once, even if another listener calls `stopImmediatePropagation`, and
  returns a `Disposable`. Dispose it when the guarded operation finishes
  normally; otherwise the signal keeps the closure alive. Prefer APIs that
  accept `signal` (`timers/promises`, `fetch`, `stream/promises`, `events.once`)
  over hand-written abort wiring.
- `AbortSignal.timeout(ms)` uses an unref'ed timer: it never keeps the
  process alive by itself, and the operation it guards must hold the loop.
- `events.once()` (static, returns Promise of the args array) and
  `emitter.once()` (method, one-shot listener) are different APIs with a
  confusing shared name. The static one resolves to the args array: read
  `args[0]` from `const args = await once(emitter, 'name')`.
- `events.on()` buffers events while the loop body is busy (unbounded unless
  the emitter supports `pause/resume` and you set `highWaterMark`); make the
  body fast or hand items to a bounded queue.
- Remove listeners on the same object and name you added them to, with the
  same function reference; anonymous arrow listeners cannot be removed later,
  so keep a reference or use `signal`.
- Use one consumer loop per event iterator; do not start several
  `for await` loops over one source.

### Errors

- Attach an `'error'` listener to every emitter that can emit it (streams,
  sockets, servers, child processes, watchers, your own) unless it is consumed
  through `events.once/on`, `pipeline` or `for await`, which turn `'error'`
  into a rejection.
- Emit only `Error` instances on `'error'`; never strings or plain objects.
- Use `'error'` for infrastructure failures of the emitter itself. Domain
  outcomes (validation failed, limit reached) belong in return values or
  rejections of the operation that caused them.
- Use `events.errorMonitor` to log errors without handling them (it does not
  suppress the crash when no real `'error'` listener exists).
- Keep listeners non-throwing: an exception in an `EventEmitter` listener
  surfaces inside whoever called `emit()` (often library internals) and stops
  remaining listeners.

### Async listeners

- `emit()` ignores returned promises: a rejected async listener becomes an
  unhandled rejection (process crash by default). Either wrap its body in
  `try/catch`, or create the emitter with `{ captureRejections: true }` so
  rejections go to `'error'` (or to `[events.captureRejectionSymbol]`).
- Do not set `EventEmitter.captureRejections = true` globally inside
  libraries; set it per instance.
- When the publisher must wait for listeners (hooks, plugin pipelines), do
  not emit: call listeners explicitly and `await Promise.all(...)` (pattern
  below), or use an emitter whose `emit` is async
  (`references/implementations.md`).

### Leaks and MaxListeners

- Treat `MaxListenersExceededWarning` as a bug report: find where listeners
  are added per request/iteration (`node --trace-warnings`), fix removal, use
  one shared listener that dispatches, or `once`.
- Raise the limit only for a known fan-out, with a concrete number on that
  emitter (`emitter.setMaxListeners(64)`); never `0`/`Infinity` and never
  `events.defaultMaxListeners` globally.
- `AbortSignal` has no default limit, so its leaks are silent: in tests set
  `events.setMaxListeners(10, signal)` or assert
  `events.getEventListeners(signal, 'abort').length === 0` after operations.
- In leak tests run N operations, `global.gc()` (`node --expose-gc`), and
  compare `process.memoryUsage().heapUsed` and listener counts.

### Own emitters and domain objects

- Prefer composition: keep an emitter in a private field (or inject one) and
  expose only `on/off` (or `subscribe` returning unsubscribe) instead of
  `class Purchase extends EventEmitter`, which lets anyone `emit` and
  `removeAllListeners` on your object.
- A home-grown emitter is fine (and small) when you need isomorphic code,
  async `emit`, strict policies (throw on duplicate listener or on exceeding
  max listeners) or `toPromise`/`toAsyncIterable` adapters. Store `Map<name, Set|Array>`, delete empty entries, iterate a
  copy during emit, return copies from `listeners()`, throw on unhandled
  `'error'`. Full versions: `references/implementations.md`.
- Use `Map` for the registry, not a plain object (`'__proto__'`,
  `'constructor'` names).
- Write emitters readably: no comma expressions or default-argument variables
  to save lines.

### Observer and signals

- Observer: `subscribe(observer)` returns an unsubscribe function or a
  `{ unsubscribe }` object; an Observable holds a collection of observers and
  returns early when there are none. Operators (`filter`, `map`) create new
  observables (stored as command objects); RxJS is the industrial version.
- Signals (`signal`, `computed`, `effect`) model state, not event streams:
  readers get the current value, `computed` re-derives, `effect` re-runs on
  change and returns `dispose` - always call it when the owner goes away.
  Libraries: `@preact/signals-core`, framework signals; TC39 Signals is still
  a proposal.

## Patterns

### Wait for one event, with timeout and error

```js
import { once } from 'node:events';

const waitReady = async (server, timeoutMs) => {
  const signal = AbortSignal.timeout(timeoutMs);
  const args = await once(server, 'ready', { signal });
  return args[0];
};
```

Rejects with `AbortError` on timeout and with the emitted error on
`'error'`; the listeners are removed in every case.

### Iterate events with cancellation and a terminating event

```js
import { on } from 'node:events';

const collectItems = async (purchase, signal) => {
  const items = [];
  const options = { signal, close: ['done'] };
  for await (const args of on(purchase, 'add', options)) {
    items.push(args[0]);
  }
  return items;
};
```

`close` ends the loop on `'done'`; `break`, `return`, a thrown error or
abort also remove listeners. Each iteration yields the args array.

### Subscription owned by a signal

```js
import { addAbortListener } from 'node:events';

const subscribe = (emitter, eventName, listener, signal) => {
  let abortListener = null;
  const unsubscribe = () => {
    emitter.off(eventName, listener);
    abortListener?.[Symbol.dispose]();
  };
  if (signal?.aborted) return unsubscribe;
  emitter.on(eventName, listener);
  if (signal) abortListener = addAbortListener(signal, unsubscribe);
  return unsubscribe;
};

// EventTarget has it built in:
// target.addEventListener('message', onMessage, { signal });
```

Both exits (manual unsubscribe and abort) remove both listeners, so neither
the emitter nor a long-lived signal accumulates closures.

### Abortable timer without the listener leak

```js
import { addAbortListener } from 'node:events';

const delay = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return void reject(signal.reason);
    const abortListener = addAbortListener(signal, () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
    const timer = setTimeout(() => {
      abortListener[Symbol.dispose]();
      resolve();
    }, ms);
  });
```

Without the dispose, every finished timer stays attached to a shared signal.
Prefer the built-in `setTimeout(ms, value, { signal })` from
`node:timers/promises`, which already cleans up.

### Async listeners: capture rejections or await them

```js
import { EventEmitter } from 'node:events';

const purchase = new EventEmitter({ captureRejections: true });

purchase.on('add', async (item) => {
  if (item.price < 0) throw new Error('Negative price');
});

purchase.on('error', (error) => {
  logger.error({ err: error }, 'purchase listener failed');
});

purchase.emit('add', { name: 'Keyboard', price: -100 });
```

```js
const invoke = async (listener, args) => listener(...args);

const emitAsync = (emitter, eventName, ...args) => {
  const listeners = emitter.listeners(eventName);
  const promises = new Array(listeners.length);
  for (let i = 0; i < listeners.length; i++) promises[i] = invoke(listeners[i], args);
  return Promise.all(promises);
};

// await emitAsync(app, 'beforeStart', config);
```

`listeners()` returns a copy, and the `async` `invoke` turns synchronous
throws into rejections, so one failing listener does not skip others before
`Promise.all` settles.

### Composition instead of inheritance

```js
import { EventEmitter } from 'node:events';

class Cart {
  #events = new EventEmitter();
  #items = [];

  add(item) {
    this.#items.push(item);
    this.#events.emit('change', { count: this.#items.length });
  }

  subscribe(listener, signal) {
    return subscribe(this.#events, 'change', listener, signal);
  }
}
```

Only `Cart` can emit; consumers get a removable subscription
(`subscribe` is the helper above).

### Your own emitter

A minimal emitter, an async variant, an async-iterable adapter, wildcard,
Observable, signals and typed `EventTarget` events:
[references/implementations.md](references/implementations.md).

## Anti-patterns

- Request/response over events (`emit('getUser', id)` then wait for
  `'user'`): no correlation, no timeout, leaks on failure. Call an async
  function.
- `ee.on(...)` inside an HTTP handler, loop or retry on a shared emitter
  (process, db pool, socket, app bus) without `off` - the classic leak behind
  MaxListeners warnings. Use `once` with `signal`, or one global listener.
- Silencing the warning with `setMaxListeners(0)` or
  `events.defaultMaxListeners = Infinity`.
- `async` listener on a plain emitter without `try/catch` or
  `captureRejections` - unhandled rejection.
- `emit('error', 'text')` or emitting `'error'` for business outcomes.
- Relying on `process.on('uncaughtException')` to "handle" emitter errors:
  no context, no recovery; subscribe to `'error'` where the emitter is
  created.
- `signal.addEventListener('abort', ...)` per operation on an app-wide
  signal without `{ once: true }` and removal on success.
- Exposing internal listener arrays (`listeners()` returning the live array)
  or mutating the collection while iterating it.
- Monkey-patching `emit` of shared emitters for wildcards or logging; if you
  need `'*'`, own the emitter and reserve the name.
- Mixing `events.once()` and `emitter.once()` without noticing that the static
  one resolves to an array of arguments.
- Unreadable "clever" emitters (comma expressions, one-letter names).

## Checklist

- [ ] Each `on`/`addEventListener` has a matching removal path (unsubscribe,
      `once`, `{ signal }`, `events.on/once` with `signal`), including error
      and timeout paths.
- [ ] No subscriptions to long-lived emitters inside per-request/per-call
      code without cleanup; no MaxListeners warnings in tests.
- [ ] Every emitter that can emit `'error'` has a listener or is consumed via
      `once/on/pipeline/for await`.
- [ ] Only `Error` objects are emitted as `'error'`.
- [ ] Async listeners are wrapped or the emitter has `captureRejections`.
- [ ] Code that must wait for listeners awaits them explicitly instead of
      calling `emit()`.
- [ ] `events.once` results are read as an args array; `AbortSignal.timeout`
      is not the only thing expected to keep the process alive.
- [ ] Domain classes compose an emitter instead of extending it; emitters
      are not used for business control flow.
- [ ] Custom emitters use `Map`, delete empty entries, copy before dispatch,
      throw on unhandled `'error'`.
- [ ] Signals `effect` / observable subscriptions are disposed by their owner.

Related skills: `node-streams`, `js-async-patterns`, `error-handling`,
`node-graceful-shutdown`, `js-gof`.
