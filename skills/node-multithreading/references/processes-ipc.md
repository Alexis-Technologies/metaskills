# Processes, IPC, cluster, actor model

## Picking an IPC transport

Rank transports by coupling. Data coupling, where processes touch the same
bytes, is the tightest. Call coupling comes next, and message/event coupling
is the loosest:

| Transport                             | Scope               | Notes                                                                          |
| ------------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| Shared / memory-mapped files          | one host            | Fastest, most fragile: agreed layout, lock flags, checksums                    |
| stdio pipes (`spawn` stdin/stdout)    | parent and child    | Streams; good for external tools and filters                                   |
| `fork` IPC channel (`send`/`message`) | parent and child    | Serialized messages; can pass socket/server handles                            |
| Unix domain socket / TCP (`node:net`) | one host / any host | Most universal: TCP code works unchanged when processes move to other machines |
| Database, Redis, message broker       | any host            | Durable queues, retries, fan-out; adds infrastructure                          |

When processes may later spread across hosts, design the protocol over sockets
or a broker from the start. You must then frame and serialize messages yourself
(Buffer to string to `JSON.parse`, or a binary format). In an app, durable
background work goes through BullMQ.

## child_process

```js
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
  timeout: 5000,
  maxBuffer: 1024 * 1024,
});

const child = spawn('ffmpeg', ['-i', input, output], {
  signal: AbortSignal.timeout(60_000),
  stdio: ['ignore', 'inherit', 'pipe'],
});
child.on('error', (error) => logger.error(error, 'ffmpeg failed'));
child.on('exit', (code, signal) => logger.info({ code, signal }, 'ffmpeg exited'));
```

- `exec` runs a shell, so treat any interpolated string as an injection
  vector. Use `execFile` or `spawn` with an args array.
- Always handle `error`: a missing binary, a failed spawn or an abort all
  arrive there, not in `exit`.
- Bound output with `maxBuffer`, or stream it with `spawn`.

### fork with an IPC channel

```js
// primary.js
const { fork } = require('node:child_process');
const path = require('node:path');

const file = path.join(__dirname, 'worker.js');
const child = fork(file, [], { serialization: 'advanced' });
const pending = new Map();
let nextId = 0;

const rejectAll = (error) => {
  for (const task of pending.values()) {
    clearTimeout(task.timer);
    task.reject(error);
  }
  pending.clear();
};

child.on('message', ({ id, error, result }) => {
  const task = pending.get(id);
  if (!task) return;
  pending.delete(id);
  clearTimeout(task.timer);
  if (error) task.reject(new Error(error.message));
  else task.resolve(result);
});

child.on('error', rejectAll);
child.on('exit', (code) => rejectAll(new Error(`Child exited with code ${code}`)));

const call = (method, args, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Call ${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.send({ id, method, args });
  });

process.on('exit', () => child.kill());
```

```js
// worker.js
const methods = {
  double: (items) => {
    const result = [];
    for (const item of items) result.push(item * 2);
    return result;
  },
};

process.on('message', ({ id, method, args }) => {
  try {
    const result = methods[method](...args);
    process.send({ id, result });
  } catch (error) {
    process.send({ id, error: { message: error.message } });
  }
});
```

- The `error` listener is required: `child.send` on a closed channel emits
  `error` on the child, and without a listener that crashes the parent.
- The default `serialization: 'json'` turns `Map` and `Set` into `{}`, `Date`
  into a string and `Buffer` into `{ type, data }`. `'advanced'` (structured
  clone) keeps them (verified).
- `process.send` exists only in a forked child. Check `process.send` or
  `process.channel` to detect it.
- Split big jobs into more chunks than there are processes and hand the next
  chunk to whichever child becomes free. Tag chunks with ids and reassemble
  them in order, because results return in any order.
- A parent exit does not kill hung children. Kill them explicitly, with
  SIGKILL as a fallback after a grace period.

### Passing handles

`child.send(message, socketOrServer)` moves a listening `net.Server` or a
connected `net.Socket` to another process. That is how `cluster` works. Worker
threads cannot receive sockets.

## cluster (legacy by default)

```js
const cluster = require('node:cluster');
const os = require('node:os');

if (cluster.isPrimary) {
  const count = os.availableParallelism();
  for (let i = 0; i < count; i++) cluster.fork();
  cluster.on('exit', (worker, code) => {
    if (code !== 0) cluster.fork();
  });
} else {
  require('./server.js');
}
```

- `cluster` is a thin wrapper over `child_process.fork`: the same entry file
  re-executes itself, and the primary accepts connections and hands them to
  workers (round-robin by default except on Windows).
- Why it is not the default: the primary can become a hot spot, distribution
  can be uneven, there is a process per core with duplicated memory, and the
  coupling to one host stays. It is tolerable for legacy apps (about 6–16
  workers). For new work, run replicas behind a load balancer and use worker
  threads inside them for CPU work, or rely on the orchestrator's replicas.
- If you keep `cluster`: restart on a non-zero exit, cap the count at the
  core count, keep no state in worker memory that must survive (sessions go to
  shared storage, or use sticky sessions for WebSocket), and coordinate
  graceful shutdown from the primary.

## Actor model

Rules:

- An actor owns private state, never calls other actors directly, and only
  receives and sends messages. Messages are copied, so actors cannot corrupt
  each other.
- Actor state must not be critical: an actor may crash and be restarted.
  Durable state lives in storage.
- The input queue for each actor kind lives in the coordinator (system), not
  in the actor.
- The actor contract is `constructor` (start), `async message(data)` and
  `async exit()` (finalize: close transports, flush).
- The same actor classes run on promises in one thread, in worker threads, or
  in processes. Only the system (transport) changes. Code written in this
  style spreads to many machines.

A tested worker-threads actor system. A ready worker is tracked by its object,
so a busy actor returns to the ready list. A crashed actor leaves the system,
so `stop()` does not wait for it, and `exit()` runs only after the message in
progress:

```js
// actors/system.js
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const createSystem = () => {
  const actors = new Map();

  const send = (name, data) => {
    const record = actors.get(name);
    if (!record) throw new Error(`Unknown actor: ${name}`);
    const worker = record.ready.shift();
    if (worker) worker.postMessage({ command: 'message', data });
    else record.queue.push(data);
  };

  const onReady = (name, worker) => {
    const record = actors.get(name);
    if (record.queue.length === 0) return void record.ready.push(worker);
    const data = record.queue.shift();
    worker.postMessage({ command: 'message', data });
  };

  const onExit = (record, worker) => {
    record.instances.delete(worker);
    const index = record.ready.indexOf(worker);
    if (index !== -1) record.ready.splice(index, 1);
  };

  const start = (name, count = 1) => {
    if (!actors.has(name)) {
      actors.set(name, { ready: [], instances: new Set(), queue: [] });
    }
    const record = actors.get(name);
    for (let i = 0; i < count; i++) {
      const worker = new Worker(__filename, { workerData: { name }, name });
      worker.on('message', (message) => {
        if (message.command === 'ready') onReady(name, worker);
        else if (message.command === 'send') send(message.to, message.data);
      });
      worker.on('error', (error) => console.error(name, error.message));
      worker.on('exit', () => onExit(record, worker));
      record.instances.add(worker);
      record.ready.push(worker);
    }
  };

  const stopWorker = (worker) =>
    new Promise((resolve) => {
      worker.once('exit', resolve);
      worker.postMessage({ command: 'stop' });
    });

  const stop = async () => {
    const exits = [];
    for (const { instances } of actors.values()) {
      for (const worker of instances) exits.push(stopWorker(worker));
    }
    await Promise.all(exits);
  };

  return { start, send, stop };
};

const runActor = () => {
  const file = path.join(__dirname, `${workerData.name.toLowerCase()}.js`);
  const send = (to, data) => {
    parentPort.postMessage({ command: 'send', to, data });
  };
  const Actor = require(file);
  const actor = new Actor({ send });
  const handle = async ({ command, data }) => {
    if (command === 'stop') {
      await actor.exit();
      parentPort.close();
      return;
    }
    await actor.message(data);
    parentPort.postMessage({ command: 'ready' });
  };
  let tail = Promise.resolve();
  parentPort.on('message', (message) => {
    tail = tail.then(() => handle(message));
  });
};

if (!isMainThread) runActor();

module.exports = isMainThread ? createSystem() : null;
```

```js
// actors/mailer.js
module.exports = class Mailer {
  async message({ to, text }) {
    await transport.send({ to, text });
  }

  async exit() {
    await transport.close();
  }
};
```

```js
// main.js
const system = require('./actors/system.js');

system.start('Renderer');
system.start('Mailer', 2);
system.send('Renderer', { url: 'https://example.com', success: false });
process.on('SIGINT', () => system.stop().then(() => process.exit(0)));
```

`stop()` drops messages still waiting in the coordinator's queue. To harden
it, drain or persist that queue first, replace the plain array with an async
queue that has a wait timeout and drops stale messages, restart crashed actors,
and add an abnormal-termination timeout to `stop()`.
