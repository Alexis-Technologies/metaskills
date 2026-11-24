# GoF patterns in OOP, FP and multi-paradigm JavaScript

How to apply behavioural patterns in JS without importing ceremony from other
runtimes. The creational and structural catalogue (factories, builder,
prototype, flyweight, singleton, pool, adapter, wrapper, decorator, proxy,
composite, facade, context and Bridge) is in `js-gof`; this file covers
Strategy, Mediator, Command, Chain of Responsibility and Observer.

## How to apply a pattern

- A pattern is a problem, forces and a solution idea, not a class diagram.
  Any structure that solves the problem is the pattern: classes, closures,
  function collections, plain data, or platform primitives.
- Extract the task the pattern solves, then pick the paradigm that fits
  the codebase and the data (see below).
- Patterns come from three sources: OOP principles, runtime limitations,
  and language culture. Observer needs two classes in Java because a
  listener used to have to be an object; in JS a listener is a function, so
  `EventEmitter` is one class plus functions. Do not copy ceremony that
  existed only because of another runtime.
- About 20% of patterns are used daily in Node.js (adapters, strategies,
  facades, commands, events); learn those deeply and do not force rare
  ones into application code.

Choosing the form:

| Use | When |
| --- | --- |
| Plain data + table of functions | Data must be serializable (commands, events, DTOs) or behaviour is chosen by key |
| Closure / factory returning an object literal | One or few instances, encapsulation without `this`, dependencies as arguments |
| Class | Many instances with shared methods, `#private` state and a lifecycle, or the platform expects a subclass (`Writable`, `Error`) |
| Platform primitive | It already exists: `EventEmitter`, `EventTarget`, streams, `AbortSignal`, `util.promisify`, `events.on` |

## Overview

| Pattern | Problem | OOP form | JS-native form |
| --- | --- | --- | --- |
| Strategy | Interchangeable behaviour | Interface + classes + context | Object/`Map` of functions; comparators, predicates, reducers |
| Mediator | Objects referencing each other | Mediator class with colleagues | Closure over services, or an event bus |
| Command | Action as an object | Command classes with `execute` | Plain data + operations table |
| Chain of responsibility | Unknown handler | Linked handler objects | Array of functions, first result wins |
| Observer | Notify subscribers | Subject + observer classes | `EventEmitter`/`EventTarget`, listener is a function |

## Strategy

JS form: a collection of functions with one contract, selected by key
once, called many times. Built-in strategy slots: `Array#toSorted`
comparator, `JSON.stringify` replacer, `new Writable({ write })`.

```js
const createStrategy = (strategyName, actions) => {
  const implementations = new Map();

  const register = (name, behaviour) => {
    const methods = {};
    for (const action of actions) {
      const fn = behaviour[action];
      if (typeof fn !== 'function') {
        throw new TypeError(`${strategyName}.${name}.${action} expected`);
      }
      methods[action] = fn;
    }
    implementations.set(name, Object.freeze(methods));
  };

  const get = (name, action) => {
    const behaviour = implementations.get(name);
    if (!behaviour) throw new Error(`${strategyName} "${name}" not found`);
    return behaviour[action];
  };

  return { register, get };
};

const notifier = createStrategy('notifier', ['notify', 'multicast']);

notifier.register('sms', {
  notify: (to, text) => `sms to ${to}: ${text}`,
  multicast: (text) => `sms to all: ${text}`,
});

const notify = notifier.get('sms', 'notify'); // select once, call many
```

Rules:

- Validate implementations at registration, not at call time.
- Strategies return values; they do not print or write (decouple from
  `console`, which becomes another strategy).
- Do not hide missing keys with `strategies[name] || strategies.default`;
  check presence explicitly and fail or fall back on purpose.
- Use classes for strategies only when an implementation has state or a
  lifecycle (a connection-backed storage).

## Before writing an adapter

Adapter, Facade and Bridge are in `js-gof`. Check the platform first:

| Need | Platform API |
| --- | --- |
| Callback-last function to promise | `util.promisify(fn)` |
| Async function to callback-last | `util.callbackify(fn)` |
| Wait for one event | `events.once(emitter, name, { signal })` |
| Events as an async iterator | `events.on(emitter, name, { signal })` |
| Iterable/async iterable to stream | `Readable.from(iterable)` |
| Pipe with error propagation | `pipeline()` from `node:stream/promises` |
| Timers as promises / async iterator | `setTimeout`, `setInterval` from `node:timers/promises` |

## Mediator

Problem: objects refer to each other directly; move the coupling into one
object that holds the colleagues and routes their interactions. Colleagues
can be aggregated (passed into the mediator) or composed (created by it).

Example: a scheduler that cannot log and a logger that cannot schedule; the
mediator logs when a task is queued and when it finishes.

```js
// OOP: aggregation through the constructor
class Planner {
  #scheduler;
  #logger;

  constructor(scheduler, logger) {
    this.#scheduler = scheduler;
    this.#logger = logger;
  }

  async add(name, task) {
    this.#logger.info(`queued ${name}`);
    const result = await this.#scheduler.run(name, task);
    this.#logger.info(`done ${name}`);
    return result;
  }
}

// FP: the same responsibility as a closure
const createPlanner = ({ scheduler, logger }) => {
  const add = async (name, task) => {
    logger.info(`queued ${name}`);
    const result = await scheduler.run(name, task);
    logger.info(`done ${name}`);
    return result;
  };
  return { add };
};

// Multi-paradigm: an event bus; colleagues know only event names
const wire = (bus, scheduler, logger) => {
  bus.on('task', async ({ name, task }) => {
    logger.info(`queued ${name}`);
    await scheduler.run(name, task);
    logger.info(`done ${name}`);
  });
};
// const bus = new EventEmitter({ captureRejections: true });
```

Prefer the explicit mediator (class or closure) when the interaction has a
result or must be awaited; use an event bus only for fire-and-forget
notifications, with `captureRejections` and an `'error'` listener.

## Command

JS form: a command is plain, serializable data; behaviour lives in an
operations table with `execute` and `undo`. Commands can be logged,
replayed, sent over the network (they look like API calls) and stored
(event sourcing).

```js
const change = (account, delta) => ({
  ...account,
  balance: account.balance + delta,
});

const OPERATIONS = {
  deposit: {
    execute: (account, { amount }) => change(account, amount),
    undo: (account, { amount }) => change(account, -amount),
  },
  withdraw: {
    execute: (account, { amount }) => {
      if (account.balance < amount) throw new Error('Insufficient funds');
      return change(account, -amount);
    },
    undo: (account, { amount }) => change(account, amount),
  },
};

const createLedger = (initial) => {
  let account = initial;
  const log = [];

  const apply = (command) => {
    const operation = OPERATIONS[command.type];
    if (!operation) throw new Error(`Unknown command: ${command.type}`);
    account = operation.execute(account, command);
    log.push(command);
    return account;
  };

  const undo = () => {
    const command = log.pop();
    if (command) account = OPERATIONS[command.type].undo(account, command);
    return account;
  };

  return { apply, undo, history: () => structuredClone(log) };
};

const ledger = createLedger({ id: 'ACC-1', balance: 0 });
ledger.apply({ type: 'deposit', amount: 100 });
ledger.apply({ type: 'withdraw', amount: 30 });
ledger.undo(); // { id: 'ACC-1', balance: 100 }
```

In TypeScript type the table as
`Record<CommandType, { execute(...): Account; undo(...): Account }>` so a
new command type without handlers fails to compile.

## Chain of Responsibility

JS form: an array of functions; each returns a result or `undefined` to
pass control on.

```js
const chain =
  (...handlers) =>
  async (input) => {
    for (const handler of handlers) {
      const result = await handler(input);
      if (result !== undefined) return result;
    }
    throw new Error('No handler accepted the input');
  };

const fromCache = (cache) => async (key) => cache.get(key);
const fromDb = (db) => async (key) => db.get(key);
const fallback = async (key) => ({ key, value: null });

const load = chain(fromCache(cache), fromDb(db), fallback);
```

Caveat: a chain whose links communicate by mutating a shared request object
hides coupling and depends on order. Prefer chains that pass values and return
results. Fastify hooks stay generic, and any field they set is declared with
`decorateRequest`.

## Observer and events

- `EventEmitter`: listener is any function with arbitrary arguments; simple
  but hard to type. `EventTarget`: the first argument is always an `Event`
  (`CustomEvent` with `detail`), which types well and matches the browser.
- Async listeners: create emitters with `{ captureRejections: true }` and
  subscribe to `'error'`; otherwise rejections become unhandled.
- Await a single event with `events.once`; consume a stream of events with
  `events.on` and an `AbortSignal`.
- Events are indirection: every `emit` is a jump to unknown code. Use them
  where the domain is naturally event-driven; do not make them the only
  async contract of a project.
