# Scaling recipes (verified on Node.js 24)

Each recipe is a complete file that was run locally, with the result stated above it. Ports and counts
are examples. They show what happens below the platform: an auth8 service runs one process per
container and scales by instances, so reach for these on a dedicated machine or in a zero-dependency
tool.

## 1. Rolling restart of a cluster (SIGHUP)

Verified: 40 concurrent requests sent while `kill -HUP <primary>` replaced both workers: 40 x 200, new
PIDs afterwards. Crashed workers respawn after 1 s. Workers that exit after `disconnect()` do not.

```js
const cluster = require('node:cluster');
const http = require('node:http');
const { once } = require('node:events');

const PORT = 8020;
const WORKERS = 2;
const STOP_TIMEOUT_MS = 10_000;

const stopWorker = async (worker) => {
  const timer = setTimeout(() => worker.kill('SIGKILL'), STOP_TIMEOUT_MS);
  worker.disconnect();
  await once(worker, 'exit');
  clearTimeout(timer);
};

const startWorker = async () => {
  const worker = cluster.fork();
  await once(worker, 'listening');
  return worker;
};

const restartAll = async () => {
  const old = Object.values(cluster.workers);
  for (const worker of old) {
    await startWorker();
    await stopWorker(worker);
  }
  process.stdout.write('Rolling restart done\n');
};

if (cluster.isPrimary) {
  cluster.on('exit', (worker, code, signal) => {
    if (worker.exitedAfterDisconnect) return;
    process.stderr.write(`Worker ${worker.process.pid} crashed: ${signal || code}\n`);
    setTimeout(() => cluster.fork(), 1000);
  });
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  process.on('SIGHUP', () => void restartAll());
} else {
  const server = http.createServer((req, res) => {
    setTimeout(() => res.end(`pid ${process.pid}\n`), 200);
  });
  server.keepAliveTimeout = 2000;
  server.listen(PORT);
  process.on('disconnect', () => {
    server.close();
    server.closeIdleConnections();
  });
}
```

## 2. IP-sticky distribution with cluster

Verified: the same client address (IPv4-mapped `::ffff:127.0.0.1` and IPv6 `::1`) always reached the
same worker. After `kill -9` of a worker it was respawned and other mappings did not change. Behind NAT
or a proxy all clients share an address: stick on a user or room id at the balancer instead, or use
client-side balancing (recipe 5).

```js
const cluster = require('node:cluster');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');

const PORT = 8010;
const WORKERS = Math.min(4, os.availableParallelism());

const hashString = (value) => {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
};

const startPrimary = () => {
  const workers = [];
  const spawn = (index) => {
    const worker = cluster.fork({ WORKER_INDEX: `${index}` });
    worker.on('exit', (code, signal) => {
      if (worker.exitedAfterDisconnect) return;
      process.stderr.write(`Worker ${index} died (${signal || code}), respawn\n`);
      setTimeout(() => spawn(index), 1000);
    });
    workers[index] = worker;
  };
  for (let i = 0; i < WORKERS; i++) spawn(i);

  const balancer = (socket) => {
    const key = socket.remoteAddress ?? '';
    const worker = workers[hashString(key) % workers.length];
    if (!worker || !worker.isConnected()) return void socket.destroy();
    worker.send({ name: 'sticky:connection' }, socket);
  };

  net.createServer({ pauseOnConnect: true }, balancer).listen(PORT);
};

const startWorker = () => {
  const index = process.env.WORKER_INDEX;
  const server = http.createServer((req, res) => {
    const ip = req.socket.remoteAddress;
    res.end(`worker ${index} pid ${process.pid} ip ${ip}\n`);
  });
  process.on('message', (message, socket) => {
    if (message?.name !== 'sticky:connection' || !socket) return;
    server.emit('connection', socket);
    socket.resume();
  });
};

if (cluster.isPrimary) startPrimary();
else startWorker();
```

- `pauseOnConnect` keeps the primary from reading bytes the worker needs.
- Hash the address string: splitting on dots gives `NaN` for IPv6 and `::ffff:` addresses, and the
  connection hangs.
- The HTTP server in the worker never listens. It only receives connections through
  `server.emit('connection', socket)`.
- With `child_process.fork` instead of `cluster`, use `child.send(message, socket)` the same way.
- `worker_threads` cannot receive sockets, so threads need their own ports (recipe 3).
- On Linux, `server.listen({ port, reusePort: true })` (Node 22.12+/23.1+) lets independent processes
  share a port with kernel balancing. It throws `ENOTSUP` on macOS and Windows and gives no affinity.

## 3. Thread per port with a redirect balancer

Verified: the balancer answers 302 round-robin to 8031, 8032 and 8033 (`curl -L` follows), POST gets
307 and keeps its body, and a thread that calls `process.exit(1)` is restarted while the others keep
serving.

```js
const http = require('node:http');
const { Worker, isMainThread, workerData } = require('node:worker_threads');

const PUBLIC_HOST = 'localhost';
const BALANCER_PORT = 8030;
const PORTS = [8031, 8032, 8033];

const startThread = (port) => {
  const worker = new Worker(__filename, { workerData: { port } });
  worker.on('exit', (code) => {
    if (code !== 0) startThread(port);
  });
  worker.on('error', (error) => process.stderr.write(`Thread ${port}: ${error.message}\n`));
};

const startBalancer = () => {
  let next = 0;
  const server = http.createServer((req, res) => {
    const port = PORTS[next++ % PORTS.length];
    const code = req.method === 'GET' || req.method === 'HEAD' ? 302 : 307;
    res.writeHead(code, { Location: `http://${PUBLIC_HOST}:${port}${req.url}` });
    res.end();
  });
  server.listen(BALANCER_PORT);
};

const startServer = (port) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/crash') process.exit(1);
    res.end(`thread on ${port}\n`);
  });
  server.listen(port);
};

if (isMainThread) {
  for (let i = 0; i < PORTS.length; i++) startThread(PORTS[i]);
  startBalancer();
} else {
  startServer(workerData.port);
}
```

- A thread that calls `process.exit(1)` or throws ends alone and is restarted. Without an `'error'`
  listener on the `Worker`, an uncaught exception in the thread is rethrown in the main thread and
  kills everything.
- A redirect exposes worker ports to the client, so they must be reachable. Build `Location` from
  configuration, never from the `Host` header, which would make an open redirect.

## 4. Load shedding with readiness and liveness (node:http)

For a service without Fastify. In an app use `@fastify/under-pressure`.

Verified with `MAX_CONCURRENT = 2`: of four parallel slow requests two got 200 and two got 503 with
`Retry-After`. `/health/ready` returned 503 while saturated and 200 afterwards. After SIGTERM readiness
returned 503 while liveness stayed 200, then the process exited.

```js
const http = require('node:http');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const MAX_CONCURRENT = 2;
const MAX_LOOP_DELAY_MS = 200;

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

const state = { active: 0, draining: false };

const isOverloaded = () => {
  const p99Ms = loopDelay.percentile(99) / 1e6;
  return state.active >= MAX_CONCURRENT || p99Ms > MAX_LOOP_DELAY_MS;
};

setInterval(() => loopDelay.reset(), 10_000).unref();

const probes = new Map([
  ['/health/live', () => 200],
  ['/health/ready', () => (state.draining || isOverloaded() ? 503 : 200)],
]);

const work = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = http.createServer(async (req, res) => {
  const probe = probes.get(req.url);
  if (probe) return void res.writeHead(probe()).end();
  if (state.draining || isOverloaded()) {
    res.writeHead(503, { 'Retry-After': '1', Connection: 'close' });
    return void res.end('Overloaded');
  }
  state.active++;
  res.on('close', () => state.active--);
  await work(500);
  res.end('done');
});

server.listen(8040);

process.on('SIGTERM', () => {
  state.draining = true;
  setTimeout(() => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  }, 1000);
});
```

To queue excess load instead of only rejecting it, use a semaphore with a bounded queue and a wait
timeout (`js-async-concurrency`): overflow and timeout reject, and the transport answers 503. wrpc
procedures have this built in as `queue: { concurrency, size, timeout }`.

## 5. Client-side balancing with an ownership check

Verified: users are routed to their owner endpoint directly, a request to a non-owner gets 421, and
when the owner (also the first entry point) is down, the client gets the list from another entry point
and fails over.

```js
const http = require('node:http');

const HOST = '127.0.0.1';
const PORTS = [8081, 8082, 8083];

const hashString = (value) => {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
};

const toOrigin = (port) => `http://${HOST}:${port}`;

// Server side: every worker can tell which endpoint owns a user
const endpointsFor = (userId) => {
  const first = hashString(userId) % PORTS.length;
  const endpoints = [];
  for (let i = 0; i < PORTS.length; i++) {
    endpoints.push(toOrigin(PORTS[(first + i) % PORTS.length]));
  }
  return endpoints;
};

const startWorker = (port) => {
  const server = http.createServer((req, res) => {
    const url = new URL(`http://${HOST}${req.url}`);
    const userId = url.searchParams.get('user') ?? '';
    if (url.pathname === '/api/endpoints') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify(endpointsFor(userId)));
    }
    const owner = endpointsFor(userId)[0];
    const isOwner = owner === toOrigin(port);
    const isFailover = url.searchParams.get('failover') === '1';
    if (!isOwner && !isFailover) return void res.writeHead(421).end('Misdirected Request');
    res.end(`user ${userId} served by ${port}\n`);
  });
  return server.listen(port);
};

const tryFetch = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok ? response : null;
  } catch {
    return null;
  }
};

const getEndpoints = async (entries, userId) => {
  for (let i = 0; i < entries.length; i++) {
    const response = await tryFetch(`${entries[i]}/api/endpoints?user=${userId}`);
    if (response) return response.json();
  }
  throw new Error('No entry point available');
};

// Client side: ask any entry point once, then talk to the owner directly
const connect = async (entries, userId) => {
  const endpoints = await getEndpoints(entries, userId);
  for (let i = 0; i < endpoints.length; i++) {
    const failover = i > 0 ? '&failover=1' : '';
    const response = await tryFetch(`${endpoints[i]}/api/hello?user=${userId}${failover}`);
    if (response) return response.text();
  }
  throw new Error('No endpoint available');
};

const main = async () => {
  const servers = new Map();
  const entries = [];
  for (let i = 0; i < PORTS.length; i++) {
    servers.set(PORTS[i], startWorker(PORTS[i]));
    entries.push(toOrigin(PORTS[i]));
  }
  const users = ['alice', 'bob', 'carol'];
  for (let i = 0; i < users.length; i++) process.stdout.write(await connect(entries, users[i]));

  const owner = endpointsFor('alice')[0];
  const stranger = endpointsFor('alice')[1];
  const direct = await fetch(`${stranger}/api/hello?user=alice`);
  process.stdout.write(`wrong worker status: ${direct.status}\n`);

  const ownerPort = Number(new URL(owner).port);
  const ownerServer = servers.get(ownerPort);
  ownerServer.close();
  ownerServer.closeAllConnections();
  servers.delete(ownerPort);
  const failover = await connect(entries, 'alice');
  process.stdout.write(`after owner down: ${failover}`);

  for (const server of servers.values()) {
    server.close();
    server.closeAllConnections();
  }
};

main();
```

In production the endpoint list comes from configuration or a membership registry, failover
acceptance is decided by membership rather than a client flag, and clients cache the list and retry
the owner first to reuse its warm cache.
