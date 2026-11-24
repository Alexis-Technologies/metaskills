# Shutdown without a framework

Fastify covers most of this in an app. Use these patterns for a bare `node:http` server, a raw
WebSocket server, or a process with several threads.

## node:http with keep-alive clients and a deadline

Runnable on Node.js 22.1+ (`URL.parse`).

```js
// server.js
const http = require('node:http');
const timers = require('node:timers/promises');

const PORT = Number(process.env.PORT) || 8000;
const DRAIN_TIMEOUT_MS = Number(process.env.DRAIN_TIMEOUT_MS) || 10000;
const EXIT_TIMEOUT_MS = DRAIN_TIMEOUT_MS + 5000;
const MAX_DELAY_MS = 60000;
const LOCAL_HOST = 'localhost';

const resources = [];
const responses = new Set();
const state = { closing: null, exitCode: 0 };

const parseTarget = (target) => {
  const url = URL.parse(target, `http://${LOCAL_HOST}`);
  return url !== null && url.host === LOCAL_HOST ? url : null;
};

const respond = (res, statusCode, body = '') => {
  res.statusCode = statusCode;
  res.end(body);
};

const handle = async (req, res) => {
  if (state.closing) res.setHeader('Connection', 'close');
  const url = parseTarget(req.url);
  if (url === null) return void respond(res, 400);
  if (url.pathname === '/health/live') return void respond(res, 200);
  if (url.pathname === '/health/ready') return void respond(res, state.closing ? 503 : 200);
  const requestedMs = Number(url.searchParams.get('ms')) || 0;
  const delayMs = Math.min(Math.max(requestedMs, 0), MAX_DELAY_MS);
  await timers.setTimeout(delayMs);
  respond(res, 200, `done in ${delayMs} ms\n`);
};

const server = http.createServer((req, res) => {
  responses.add(res);
  res.on('close', () => responses.delete(res));
  handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
});

const stopServer = () => {
  const closed = new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeIdleConnections();
  for (const res of responses) {
    if (!res.headersSent) res.setHeader('Connection', 'close');
  }
  return closed;
};

const closeResources = async () => {
  const errors = [];
  for (let i = resources.length - 1; i >= 0; i--) {
    const resource = resources[i];
    try {
      await resource.close();
      console.info(`Closed: ${resource.name}`);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Cleanup failed');
};

const shutdown = (origin, exitCode = 0) => {
  if (exitCode > state.exitCode) state.exitCode = exitCode;
  if (state.closing) return state.closing;
  console.info(`Graceful shutdown: ${origin}`);
  const drainTimer = setTimeout(() => {
    console.warn(`Dropping ${responses.size} unfinished requests`);
    state.exitCode = 1;
    server.closeAllConnections();
  }, DRAIN_TIMEOUT_MS);
  setTimeout(() => {
    console.error('Shutdown timeout, forced exit');
    process.exit(1);
  }, EXIT_TIMEOUT_MS);
  state.closing = stopServer()
    .then(closeResources)
    .catch((error) => {
      console.error(error);
      state.exitCode = 1;
    })
    .then(() => {
      clearTimeout(drainTimer);
      console.info(`Exit code: ${state.exitCode}`);
      process.exit(state.exitCode);
    });
  return state.closing;
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error, origin) => {
  console.error(origin, error);
  shutdown(origin, 1);
});

const openResource = async (name) => {
  const resource = { name, close: async () => {} };
  resources.push(resource);
  return resource;
};

const main = async () => {
  await openResource('db');
  await openResource('queue');
  server.listen(PORT, () => console.info(`Listening on ${PORT}`));
};

main();
```

Two details protect the process:

- **A request must not be able to reach the crash path.** `new URL('//', base)` throws, and in an
  async handler with no `catch` that is an unhandled rejection, then `uncaughtException`, then
  `shutdown(origin, 1)`. One `GET //` would stop the instance. `URL.parse` returns `null` instead,
  and the `.catch` on `handle` turns any other handler failure into a 500 for that request only.
- **The host is checked.** `//evil.example/health/ready` parses with another host and the path
  `/health/ready`. It is answered with 400 rather than routed.

A crash during a requested stop raises the exit code to 1, so a failed drain never reports success.

## WebSocket clients (`ws` or similar)

```js
const { once } = require('node:events');

const closeWebSockets = async (wss, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const { signal } = controller;
  const closed = [];
  for (const client of wss.clients) {
    closed.push(once(client, 'close', { signal }));
    client.send(JSON.stringify({ type: 'restart', reconnectMs: 1000 }));
    client.close(1012, 'Service restart');
  }
  await Promise.allSettled(closed);
  clearTimeout(timer);
  for (const client of wss.clients) client.terminate();
};
```

Run it in parallel with `stopServer()`, because upgraded sockets keep the HTTP server open. The timer
is ref'ed on purpose: `AbortSignal.timeout()` does not keep the loop alive, and the process could
exit mid-shutdown. Clients reconnect with exponential backoff plus jitter, so a restarted fleet does
not cause a reconnect storm. For SSE, write a final event and `res.end()`. Answer remaining plain
HTTP requests with `503` and `Retry-After`.

With `@alexify/wrpc` you do not write this: `close({ drain })` sends every peer `1001`.

## Resource registry with `AsyncDisposableStack` (Node.js 24+)

```js
const stack = new AsyncDisposableStack();
const client = stack.adopt(await connectMongo(config), (mongo) => mongo.close());
const redis = stack.adopt(await connectRedis(config), (connection) => connection.quit());
stack.use(server); // http.Server implements Symbol.asyncDispose
// on shutdown: await stack.disposeAsync(); // LIFO: server, redis, client
```

All disposers run even if one throws, and several failures surface as `SuppressedError`.

## Cluster or worker threads: replace without closing the port

The primary owns the listening socket, so a worker can stop while the port stays open. The worker
asks the primary for a replacement, stops accepting, drains and exits. The primary forks the new
worker at once, so old and new overlap. Workers ignore terminal `SIGINT` (the whole process group
receives Ctrl+C) and obey the primary's message.

For `worker_threads`, post `{ name: 'stop' }` to each thread, wait for their `exit` up to a timeout,
then `worker.terminate()`. Restart a thread that exits with a non-zero code, with a limit or
backoff.

Related skills: `node-http-server`, `node-websocket-realtime`, `node-multithreading`
