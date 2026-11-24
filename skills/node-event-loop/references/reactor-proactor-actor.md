# Reactor, Proactor, Actor: the mental model of Node.js

Three patterns explain the event loop. Reactor and Proactor create an asynchronous environment (libuv in Node, the browser's
loop); Actor protects state inside an environment that is already
asynchronous. Build the first two once to see that the core of libuv is a
small loop over queues; most of libuv's code is portability glue over
epoll (Linux), kqueue (macOS, BSD) and IOCP (Windows).

| Pattern  | Problem it solves | In Node |
| -------- | ----------------- | ------- |
| Reactor  | Turn synchronous code into an asynchronous environment: queue + endless loop + handlers for ready events, grouped into phases | The loop itself; readiness polling inside libuv on Unix |
| Proactor | Bind completion callbacks of a lower system (OS, thread pool) to userland callbacks | `fs.readFile(path, cb)`, `socket.write(data, cb)`, IOCP on Windows |
| Actor    | Keep state consistent when many async flows touch it, without locks | Your code: one owner per piece of state, messages in a queue |

Why "Reactor + Proactor": libuv is usually called a reactor, but the
contract Node offers to JavaScript is completion-based. You initiate an
operation and receive its result in a callback; who waited for readiness
(epoll) or did the work (a pool thread) is hidden.

## Reactor

```js
class Reactor {
  #phases = { timers: [], io: [], check: [], close: [] };
  #pending = 0;
  #active = false;

  enqueue(phase, fn) {
    const queue = this.#phases[phase];
    if (!queue) throw new Error(`Unknown phase: ${phase}`);
    queue.push(fn);
    this.#pending++;
  }

  start() {
    this.#active = true;
    const phases = Object.values(this.#phases);
    while (this.#active && this.#pending > 0) {
      for (const queue of phases) {
        const tasks = queue.splice(0);
        this.#pending -= tasks.length;
        for (const task of tasks) task();
      }
    }
    this.#active = false;
  }

  stop() {
    for (const queue of Object.values(this.#phases)) queue.length = 0;
    this.#pending = 0;
    this.#active = false;
  }
}

const loop = new Reactor();

const setTimer = (fn, delayMs) => {
  const start = Date.now();
  const check = () => {
    if (Date.now() - start >= delayMs) fn();
    else loop.enqueue('timers', check);
  };
  loop.enqueue('timers', check);
};

setTimer(() => console.log('timer 200'), 200);
setTimer(() => console.log('timer 100'), 100);
loop.start();
console.log('loop exited: nothing pending');
```

What it teaches:

- Each pass snapshots a queue (`splice(0)`) and runs it; work scheduled
  while running goes to the next pass. This is why a blocked loop fires
  overdue timers in one batch.
- Phases batch handlers of one kind per pass.
- A counter of pending handlers (instead of scanning every queue) decides
  whether the loop is alive; when it reaches zero the loop exits, exactly
  like a Node process with nothing ref'ed.
- Timers only guarantee "not earlier than": `check` re-enqueues itself
  millions of times per second until the deadline passes (a busy loop; the
  real libuv sleeps in poll until the nearest timer instead).
- Real loops use linked lists or preallocated ring buffers instead of
  arrays to avoid reallocations.
- Wrapping `readFileSync` into a callback on such a loop does not make it non-blocking; it only changes the contract. Real
  asynchrony needs the Proactor binding to the OS.

## Proactor

```js
const fs = require('node:fs');

class Proactor {
  #tasks = [];

  enqueue(operation, callback) {
    this.#tasks.push({ operation, callback });
  }

  start() {
    if (this.#tasks.length === 0) return;
    const tasks = this.#tasks.splice(0);
    let remaining = tasks.length;
    for (const { operation, callback } of tasks) {
      operation((error, data) => {
        callback(error, data);
        if (--remaining === 0) this.start();
      });
    }
  }
}

const loop = new Proactor();

const readFile = (path, callback) => {
  const operation = (done) => fs.readFile(path, 'utf8', done);
  loop.enqueue(operation, callback);
};

readFile(__filename, (error, data) => {
  if (error) console.error(error.message);
  else console.log(`read ${data.length} chars`);
});
loop.start();
```

What it teaches:

- The queue stores an operation plus its userland callback; the proactor
  inserts its own completion callback between them.
- Recursion that starts the next operation only after the previous one
  completed serializes all I/O. Initiating every operation of a batch and
  counting completions makes them concurrent.
- The callback version is the reference Proactor (C++ origins, libuv,
  Boost.Asio style). An `async`/`await` version is shorter but leans on the
  microtask queue and is no longer a pure Proactor.

## Actor

```js
class Actor {
  #queue = [];
  #processing = false;
  #state = null;
  #behavior = null;

  constructor(behavior, state) {
    this.#behavior = behavior;
    this.#state = state;
  }

  send(message) {
    const { promise, resolve, reject } = Promise.withResolvers();
    this.#queue.push({ message, resolve, reject });
    this.#process();
    return promise;
  }

  async #process() {
    if (this.#processing) return;
    this.#processing = true;
    while (this.#queue.length > 0) {
      const { message, resolve, reject } = this.#queue.shift();
      try {
        resolve(await this.#behavior(message, this.#state));
      } catch (error) {
        reject(error);
      }
    }
    this.#processing = false;
  }
}
```

Business logic, unchanged and unsafe on its own:

```js
const reserve = async ({ id, quantity }, stock) => {
  const available = stock.get(id) ?? 0;
  await sleep(Math.random() * 50);
  if (quantity > available) throw new Error(`Out of stock: ${id}`);
  stock.set(id, available - quantity);
  return stock.get(id);
};
```

Usage:

```js
const stock = new Actor(reserve, new Map([['1722', 5]]));

const results = await Promise.allSettled([
  stock.send({ id: '1722', quantity: 3 }),
  stock.send({ id: '1722', quantity: 1 }),
  stock.send({ id: '1722', quantity: 2 }),
]);
```

`Actor` keeps the state private, queues messages and runs `reserve` for one
message at a time; each `send` resolves or rejects with its own result.

Verified (three concurrent orders of 3, 1 and 2 units, stock 5):

```
direct calls: [ 2, 4, 3 ]  final stock 2..4 (all "succeed", 6 units sold)
via actor:    [ 2, 1, 'Out of stock: 1722' ]
```

Two details make it correct:

- `send` returns a promise for *its own* message, even when the actor is
  already busy.
- A throwing behavior rejects that message's promise instead of leaving
  `#processing` stuck at `true` forever.

Rules for actors:

- The actor must be the only holder of a reference to its state; leaking
  the state object (passing it elsewhere, returning it) voids the guarantee.
- Messages to one actor are processed strictly one after another; slow
  messages delay the rest, so keep behaviors short or split state across
  several actors.
- A boolean `#processing` flag is enough on one JS thread; with real
  parallelism (shared memory between workers) it is not, use
  `Atomics`-based locks (see `node-multithreading`,
  `js-async-concurrency`).
- Prefer composition: `new Actor(Point, 10, 20)` creates the entity privately
  and every interaction is `send({ method, args })`; the entity class stays a
  plain class without `extends`. Messages can then be queued, persisted,
  rate-limited and moved across threads, processes or machines.
- An actor protects one process. State shared by several instances needs
  MongoDB guarantees (`js-async-concurrency`).
