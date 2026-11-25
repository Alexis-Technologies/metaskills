# Event abstractions: reference implementations

Small, readable implementations. Use them when a project needs an isomorphic
or async emitter, an observable with operators, or to explain how the built-ins
work. Prefer `node:events` / `EventTarget` when they fit.

## Minimal emitter

```js
class Emitter {
  #events = new Map();

  #event(name) {
    let event = this.#events.get(name);
    if (event) return event;
    event = { on: new Set(), once: new Set() };
    this.#events.set(name, event);
    return event;
  }

  on(name, listener) {
    this.#event(name).on.add(listener);
    return () => this.off(name, listener);
  }

  once(name, listener) {
    this.#event(name).once.add(listener);
    return () => this.off(name, listener);
  }

  off(name, listener) {
    const event = this.#events.get(name);
    if (!event) return;
    event.on.delete(listener);
    event.once.delete(listener);
    if (event.on.size + event.once.size === 0) this.#events.delete(name);
  }

  emit(name, ...args) {
    const event = this.#events.get(name);
    if (!event) {
      if (name === 'error') throw args[0];
      return false;
    }
    const listeners = [...event.on, ...event.once];
    event.once.clear();
    if (event.on.size === 0) this.#events.delete(name);
    for (const listener of listeners) listener(...args);
    return true;
  }
}
```

A separate `once` set avoids wrapper bookkeeping (`off` works with the
original function); emit iterates a copy so listeners may unsubscribe during
dispatch.

## Async emitter (await all listeners)

Here `emit` returns a promise, so the publisher can wait for hooks. A
synchronous throw in a listener becomes a rejection because every call goes
through the `async` `invoke`.

```js
const invoke = async (listener, args) => listener(...args);

class AsyncEmitter {
  #events = new Map();
  #maxListeners = 10;

  constructor({ maxListeners = 10 } = {}) {
    this.#maxListeners = maxListeners;
  }

  #event(name) {
    let event = this.#events.get(name);
    if (event) return event;
    event = { on: new Set(), once: new Set() };
    this.#events.set(name, event);
    return event;
  }

  #add(name, listener, isOnce) {
    const event = this.#event(name);
    if (event.on.has(listener) || event.once.has(listener)) {
      throw new Error(`Duplicate listener for "${name}"`);
    }
    if (event.on.size + event.once.size >= this.#maxListeners) {
      throw new Error(`Max listeners (${this.#maxListeners}) for "${name}"`);
    }
    if (isOnce) event.once.add(listener);
    else event.on.add(listener);
    return () => this.off(name, listener);
  }

  on(name, listener) {
    return this.#add(name, listener, false);
  }

  once(name, listener) {
    if (listener) return this.#add(name, listener, true);
    return new Promise((resolve) => {
      this.#add(name, resolve, true);
    });
  }

  off(name, listener) {
    const event = this.#events.get(name);
    if (!event) return;
    if (!listener) return void this.#events.delete(name);
    event.on.delete(listener);
    event.once.delete(listener);
    if (event.on.size + event.once.size === 0) this.#events.delete(name);
  }

  async emit(name, ...args) {
    const event = this.#events.get(name);
    if (!event) {
      if (name === 'error') throw args[0];
      return [];
    }
    const listeners = [...event.on, ...event.once];
    event.once.clear();
    if (event.on.size === 0) this.#events.delete(name);
    const promises = [];
    for (const listener of listeners) promises.push(invoke(listener, args));
    return Promise.all(promises);
  }

  listeners(name) {
    const event = this.#events.get(name);
    if (!event) return [];
    return [...event.on, ...event.once];
  }

  names() {
    return [...this.#events.keys()];
  }
}

// Usage
const app = new AsyncEmitter();
app.on('start', async (config) => {
  console.log('migrate', config.db);
});
await app.emit('start', { db: 'mongodb' });
const results = await Promise.all([app.once('login'), app.emit('login', 'u1')]);
const user = results[0];
```

Duplicate listeners and exceeding `maxListeners` throw instead of warning, so
leaks fail fast in tests.

## Emitter to async iterable (what `events.on` does)

```js
const toAsyncIterable = (emitter, eventName) => ({
  [Symbol.asyncIterator]() {
    const queue = [];
    const waiters = [];
    let failure = null;
    let isDone = false;
    const onEvent = (value) => {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value, done: false });
      else queue.push(value);
    };
    const onError = (error) => {
      failure = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
      finish();
    };
    const finish = () => {
      if (isDone) return;
      isDone = true;
      emitter.off(eventName, onEvent);
      emitter.off('error', onError);
    };
    emitter.on(eventName, onEvent);
    emitter.on('error', onError);
    return {
      next: () => {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift(), done: false });
        }
        if (failure) return Promise.reject(failure);
        if (isDone) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          waiters.push({ resolve, reject });
        });
      },
      return: () => {
        finish();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  },
});
```

`return()` is called by `break`/`return` inside `for await`, which is where
the listeners are removed. The queue is unbounded: same caveat as
`events.on`.

## Wildcard `'*'` listener

```js
import { EventEmitter } from 'node:events';

const createStarEmitter = () => {
  const emitter = new EventEmitter();
  const { emit } = emitter;
  emitter.emit = (name, ...args) => {
    if (name === '*') throw new Error('Event name "*" is reserved');
    const handled = emit.call(emitter, name, ...args);
    emit.call(emitter, '*', name, ...args);
    return handled;
  };
  return emitter;
};
```

Only do this on an emitter you create; never patch shared or third-party
emitters.

## Observable with operators and unsubscribe

```js
class Observable {
  #observers = new Set();
  #operators = [];

  constructor(producer = null) {
    if (producer) queueMicrotask(() => producer(this));
  }

  subscribe(observer) {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }

  pipe(...operators) {
    const destination = new Observable();
    destination.#operators = operators;
    this.subscribe((data) => destination.next(data));
    return destination;
  }

  next(data) {
    if (this.#observers.size === 0) return;
    let value = data;
    for (const operator of this.#operators) {
      if (operator.name === 'filter' && !operator.fn(value)) return;
      if (operator.name === 'map') value = operator.fn(value);
    }
    for (const observer of this.#observers) observer(value);
  }
}

const filter = (fn) => ({ name: 'filter', fn });
const map = (fn) => ({ name: 'map', fn });

// Usage
const source = new Observable();
const consonants = source.pipe(
  filter((char) => !'aeiou'.includes(char)),
  map((char) => char.toUpperCase()),
);
const unsubscribe = consonants.subscribe((char) => console.log(char));
for (const char of 'observer') source.next(char);
unsubscribe();
```

Operators are command objects (`{ name, fn }`) interpreted in `next`.

## Signals (naive, with effect and dispose)

```js
let collecting = null;

const signal = (initial) => {
  const effects = new Set();
  let value = initial;
  const read = () => {
    if (collecting) collecting.add(effects);
    return typeof value === 'function' ? value() : value;
  };
  read.set = (next) => {
    value = next;
    for (const run of [...effects]) run();
  };
  return read;
};

const computed = (fn) => signal(fn);

const effect = (run) => {
  const sources = new Set();
  collecting = sources;
  run();
  collecting = null;
  for (const effects of sources) effects.add(run);
  return () => {
    for (const effects of sources) effects.delete(run);
  };
};

// Usage
const count = signal(100);
const double = computed(() => count() * 2);
const dispose = effect(() => console.log({ count: count(), double: double() }));
count.set(200);
dispose();
count.set(300);
```

Production libraries (`@preact/signals-core`, framework signals) add
batching, lazy `computed` caching and glitch-free ordering; use them instead
of the naive version.

## EventTarget subclass that also exposes `on`

When an API must be usable from browser-style and Node-style code, wrap
rather than re-implement:

```js
class Channel extends EventTarget {
  on(name, listener, signal) {
    const handler = (event) => listener(event.detail);
    this.addEventListener(name, handler, { signal });
    return () => this.removeEventListener(name, handler);
  }

  emit(name, detail) {
    return this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
```

Remember `EventTarget` semantics stay: no special `'error'`, listener
exceptions become `uncaughtException`.

## EventTarget with typed events

```js
class PriceEvent extends Event {
  constructor(price) {
    super('price');
    this.price = price;
  }
}

const ticker = new EventTarget();
const controller = new AbortController();
const onPrice = (event) => console.log(event.price);
ticker.addEventListener('price', onPrice, { signal: controller.signal });
ticker.dispatchEvent(new PriceEvent(42));
controller.abort();
```

A subclass gives a stable shape instead of untyped `detail`; `abort()`
removes every listener registered with that signal.
