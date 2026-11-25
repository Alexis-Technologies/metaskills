---
name: node-http-server
description: Fastify and node:http servers with limits, timeouts and undici. Use for routes, plugins, hooks, proxies, hangs, 413s, 502s
---

# Node.js HTTP Server

Treat the HTTP layer as a small, explicit adapter. Fastify plugins wire the app, handlers call
application services, every input is bounded, every timeout is set on purpose, every outgoing call
has a deadline, and static files and proxies leave no traversal or SSRF holes.

## Project profile

|                    | Library `@alexify/*`                        | App (`auth8`)                                              |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------- |
| HTTP layer         | `node:http`, host injected, no dependencies | Fastify 5                                                  |
| Composition        | Constructor options                         | `@fastify/autoload`, `fastify-plugin`, declared decorators |
| Cross-cutting code | Per-route wrappers                          | Fastify hooks                                              |
| Outgoing HTTP      | Global `fetch`                              | undici behind an Application port. Axios is banned         |
| Validation         | Its own checks                              | `@alexify/metaschema`, see `js-contracts-schemas`          |
| Errors             | Own class with an `ALX_ERR_` code           | One `setErrorHandler`, see `error-handling`                |
| Logging            | Injected logger                             | Pino through `request.log`                                 |

## Defaults

- Fastify is the framework of every Node.js service: schema-driven validation and serialization,
  encapsulated plugins, one lifecycle. `node:http` is the foundation for understanding what Fastify
  configures, and the only choice for a zero-dependency library.
- Handlers belong to the Presentation layer: read the input, call an Application service, return the
  result. Services never see `request`, `reply`, headers or status codes (`node-layered-architecture`).
- REST stays for public and CRUD APIs. Realtime goes through `@alexify/wrpc` mounted inside Fastify
  (`alexis-libraries`), so both share hooks, logging and shutdown.
- Static assets belong on a CDN (Vercel in auth8). Node serves the API.

## Fastify

The full wiring, with a lifecycle table and an `inject` test, is in
[references/fastify.md](references/fastify.md).

### Plugins and decorators

- The entry point registers `@fastify/autoload` for `plugins/`, then `modules/` with `maxDepth: 1`,
  then `routes/`. One concern per file.
- Wrap with `fastify-plugin` only what the whole app shares: clients, decorators, global hooks. Give
  it `{ name, dependencies }`, so a missing or misordered plugin fails at boot.
- Route plugins stay encapsulated: no `fastify-plugin`, so their hooks and decorators do not leak.
- Declare every decorator: `fastify.decorate('orders', orders)` plus a `declare module 'fastify'`
  block. Declare request fields with `decorateRequest('user', null)`. Fastify 5 refuses an object or
  array default (`FST_ERR_DEC_REFERENCE_TYPE`), because it would be shared between requests.
- Whatever a plugin opens, it closes in its own `onClose` hook.
- Configuration comes from `fastify.config`, validated once at boot (`node-config`). No `NODE_ENV`
  branches.

```ts
// modules/orders/index.ts
import fp from 'fastify-plugin';

import { createOrderService, type OrderService } from './app/orders.service.js';

declare module 'fastify' {
  interface FastifyInstance {
    orders: OrderService;
  }
}

export default fp(
  async (fastify) => {
    const orders = createOrderService({ db: fastify.mongo.db, log: fastify.log });
    fastify.decorate('orders', orders);
    fastify.addHook('onClose', async () => {
      await orders.stop();
    });
  },
  { name: 'orders', dependencies: ['config', 'mongodb'] },
);
```

### Hooks, not middleware

- No `(req, res, next)` chains. Hooks carry transport concerns only: authentication, rate limits,
  security headers, request ids. Business rules stay in the Application layer.
- Attach a hook to the routes that need it: `preHandler: [fastify.authenticate]`. A global hook runs
  for health probes too.
- An authentication check that needs only headers fits `onRequest`: the body of an anonymous caller
  is then never read or parsed.
- Per-request state lives on a declared request decorator or in `AsyncLocalStorage`
  (`node-async-context`), never in a module variable.
- Async hooks take no `done`. After `reply.send()` in an async hook, `return reply`.

### Routes, validation, reply

- Every route declares `schema` for its input. The source of truth is `@alexify/metaschema`, and how
  it reaches a route is owned by `js-contracts-schemas`. Never hand-write a route schema as a source.
- Declare `response` schemas per status: serialization gets faster, and fields outside the schema
  never leave the server.
- A `response` schema does not set the status: without a code the answer is 200 and leaves
  unfiltered. Register `status-from-schema` before the routes (`references/fastify.md`): one declared
  2xx code becomes the status, and `reply.code()` still wins. After `reply.send()`, `return reply`.
- Return a `Readable` to stream: Fastify pipes it and handles its errors. `reply.hijack()` hands you
  the raw response, and hooks and error handling no longer apply.

```ts
import type { FastifyInstance } from 'fastify';

import { CreateOrderBody, OrderReply } from './orders.schemas.js';

const orderRoutes = async (fastify: FastifyInstance) => {
  const guarded = { preHandler: [fastify.authenticate] };
  const schema = { body: CreateOrderBody, response: { 201: OrderReply } };

  fastify.post('/orders', { ...guarded, schema, bodyLimit: 16_384 }, async (request) =>
    fastify.orders.create(request.user!.id, request.body),
  );
};

export default orderRoutes;
```

### Limits and timeouts

Fastify changes the defaults of `node:http`, and one of them removes a protection:

| Setting                 | `node:http` | Fastify 5                                 |
| ----------------------- | ----------- | ----------------------------------------- |
| `requestTimeout`        | 300 000     | **0 (off)**, set it                       |
| `headersTimeout`        | 60 000      | 60 000, only through the `http` option    |
| `keepAliveTimeout`      | 5 000       | 72 000                                    |
| `connectionTimeout`     | 0           | 0                                         |
| `handlerTimeout`        | none        | 0 (off)                                   |
| `bodyLimit`             | none        | 1 MiB, 413 `FST_ERR_CTP_BODY_TOO_LARGE`   |
| Idle sockets at close   | closed      | closed, `forceCloseConnections: 'idle'`   |

```ts
const options = {
  logger,
  bodyLimit: 256 * 1024,
  requestTimeout: 30_000,
  handlerTimeout: 10_000,
  keepAliveTimeout: 72_000,
  http: { headersTimeout: 10_000 },
  trustProxy: 1,
};
```

- `requestTimeout` bounds receiving the request (slowloris). Without a proxy in front it is required.
- `handlerTimeout` answers 503 and aborts `request.signal` only on a route without a body. With a
  body it never fires, and `request.signal` aborts once the body is read: use `AbortSignal.timeout`
  with a close guard (`node-event-loop`). Either way pass the signal down, or the work goes on.
- Raise `bodyLimit` only on the route that needs it. Keep `onProtoPoisoning: 'error'`.
- Keep `keepAliveTimeout` above the idle timeout of the balancer, or clients see random 502s on
  sockets the balancer is about to reuse.
- `trustProxy` is a hop count or a CIDR list of your own proxies, never `true` on a port reachable
  directly. Without it behind a platform proxy, `request.ip` is the proxy, and an IP-keyed rate limit
  puts every client in one bucket.

### Errors and shutdown

- One `setErrorHandler` maps errors at the boundary (`error-handling`). 5xx bodies stay generic.
- Keep the status of framework errors, 503 included: `FST_UNDER_PRESSURE` and
  `FST_ERR_HANDLER_TIMEOUT`. A handler that turns them into 500 breaks load shedding, while the
  `Retry-After` header still goes out.
- `fastify.close()` answers new requests with 503, closes idle sockets, waits for in-flight requests,
  then runs `onClose`. Upgraded sockets (WebSocket) block it: close them in `preClose`
  (`node-graceful-shutdown`).

## Outgoing HTTP

- App: one undici `Pool` or `Agent` per upstream, inside a thin client in the Infrastructure ring,
  behind an Application port. Base URLs and timeouts come from configuration.
- Library: global `fetch` (undici underneath), or a client the caller injects.
- Every call has a deadline: `headersTimeout` and `bodyTimeout` on the pool, plus a per-call `signal`.
- Always consume the body (`body.json()`, `body.dump()`), or the connection never returns to the pool.

```ts
const getJson = async (pool: Pool, path: string, signal: AbortSignal) => {
  const { statusCode, body } = await pool.request({ method: 'GET', path, signal });
  if (statusCode >= 400) {
    await body.dump();
    throw new UpstreamError(statusCode);
  }
  return body.json();
};
```

Errors, retries, `fetch` and `http.request`: [references/http-client.md](references/http-client.md).

## node:http foundation

Rules for a zero-dependency library, and what Fastify does for you in an app.

### Request and response

- `req` is a Readable and `res` a Writable over one socket. Call `res.writeHead(status, headers)`
  once, then `res.end(body)`. Always send `Content-Type`, and `Content-Length` for buffered bodies.
- Pipe with `pipeline` from `node:stream/promises`, never bare `.pipe()`: an unhandled stream
  `'error'` crashes the process and leaks descriptors.
- In error paths check `res.headersSent`: if headers are out, `res.destroy()`, otherwise send an error.
- Parse `req.url` by splitting on `?` and using `URLSearchParams`. Do not pass a raw `req.url` to
  `new URL(req.url, base)` for routing or proxying: `//evil.com/x` becomes host `evil.com`.
- Handle `server.on('error')` for listen failures (`EADDRINUSE`, `EACCES`), and `clientError`: only
  the socket is available there.
- No `console.log`, `*Sync` calls or long loops in the request path. `async` does not make a function
  non-blocking.
- HTTP line endings are always `\r\n`. Never use `os.EOL` for protocol text.

### Routing

- Route with a `Map` keyed by `'METHOD /path'`. No `if/else` or `switch` over `req.url`.
- A plain object as a route table resolves `/api/constructor` to `Object`. Use a `Map`.
- Compile parameter routes once at startup, check exact routes first, and never build a RegExp from
  request data. Unknown route is 404, known path with a wrong method is 405.
- Add cross-cutting behaviour with per-route wrappers (`withAuth`, `withCache`).

The router and wrappers are in [references/router.md](references/router.md), and a complete server
with static files, errors, shutdown, HTTPS, SNI and HTTP/2 is in
[references/reference-server.md](references/reference-server.md).

### Bodies

- Reject early when `content-length` exceeds the limit, count bytes while reading (chunked bodies
  have no length), answer 413 and close the connection.
- Collect `Buffer` chunks and `Buffer.concat` them, then decode once. Never `chunks.join()`, and never
  concatenate binary chunks as strings: multi-byte characters split across chunks.
- `JSON.parse` inside `try`, failures are 400. Stream uploads with `pipeline` and a byte-counting
  Transform.

```js
const receiveBody = async (req, limitBytes) => {
  const declared = Number(req.headers['content-length']);
  if (declared > limitBytes) throw new HttpError(413);
  const chunks = [];
  let sizeBytes = 0;
  for await (const chunk of req) {
    sizeBytes += chunk.length;
    if (sizeBytes > limitBytes) throw new HttpError(413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
```

### Timeouts and keep-alive

- Set them as `createServer` options, which validate `headersTimeout <= requestTimeout`.
- `headersTimeout` and `requestTimeout` are checked every `connectionsCheckingInterval` (30 s), so
  short values fire late. Idle keep-alive time does not count against `headersTimeout`.
- Keep connections alive: a TCP and TLS handshake costs CPU, an idle socket a few KB. Use
  `maxRequestsPerSocket` when long-lived connections must rebalance across instances.
- On shutdown: `server.close()`, `server.closeIdleConnections()`, then `closeAllConnections()` after
  a grace timeout.

```js
const server = http.createServer({
  requestTimeout: 30_000,
  headersTimeout: 10_000,
  keepAliveTimeout: 65_000,
});
server.on('request', listener);
server.on('clientError', (error, socket) => {
  if (error.code === 'ECONNRESET' || !socket.writable) return void socket.destroy();
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});
```

### Static files and proxies

- Containment check on every path: decode in `try`, reject `\0`, resolve, then allow only
  `full === root || full.startsWith(root + path.sep)`. A bare `startsWith(root)` lets
  `/static-secret/` through. Code, MIME, ETag, Range and the in-memory cache:
  [references/static-files.md](references/static-files.md). Symlinks and uploads: `node-security`.
- Reverse proxy: fixed upstream from config, strip hop-by-hop headers, copy status and headers,
  `pipeline` both ways, 504 on upstream timeout, 502 on connection error. CONNECT proxy: authenticate
  and allowlist targets (SSRF). Code: [references/proxy.md](references/proxy.md).

### Cookies and sessions

- Cookie attributes and token generation are owned by `node-crypto-auth`. The HTTP layer reads the
  cookie or `Authorization` header, passes the token to the auth service, and writes the `Set-Cookie`
  value that service builds. Any token can be revoked on the server.
- In Fastify use `@fastify/cookie`. A dependency-free parser is in
  [references/reference-server.md](references/reference-server.md).
- An in-memory session `Map` works in one process only. Several instances need a shared store
  (`node-scaling-highload`).

## Anti-patterns

- `(req, res, next)` middleware, or business logic inside a Fastify hook.
- A shared plugin without `fastify-plugin` (its decorators stay invisible), or a route plugin wrapped
  in it (its hooks leak to the whole app).
- An undeclared `request.user = ...`, or per-request data in a module variable.
- `requestTimeout` left at Fastify's 0 on a public port.
- `handlerTimeout` or `request.signal` on a route with a body, or a deadline not passed down.
- An error handler that rewrites 503 from `@fastify/under-pressure` to 500.
- Hand-written route schemas next to the metaschema contract.
- Axios anywhere. An undici response whose body is neither read nor dumped.
- `trustProxy: true` on a directly reachable port, or no `trustProxy` behind a proxy with IP limits.
- `if (req.url === ...)` routing, or a RegExp tested per request per route.
- `fs.readFile(path.join(root, req.url))` without a containment check, or `startsWith(root)` without
  `path.sep`.
- Binary assets cached as `utf8` strings, `file.pipe(res)` without error handling, `writeHead(200)`
  before the file is known to open.
- Unbounded `for await (const chunk of req)`, `JSON.parse` outside `try`, `chunks.join()`.
- A proxy that calls `response.pipe(res)` without copying status and headers, forwards hop-by-hop
  headers, buffers the request body, or builds the target with `new URL(req.url, upstream)`.
- A timeout wrapper that ends `res` from a timer it never clears, or the `res.headerSent` typo.
- `os.EOL` in protocol strings, magic `443` and `80` literals, `parseInt(port) || DEFAULT` where `0`
  is valid.
- SNI callbacks that call `callback(error)` without `return`, then `callback(null, context)`.
- Session tokens from `Math.random`, cookies without `HttpOnly` and `Secure`.

## Checklist

- [ ] Shared plugins use `fastify-plugin` with `name` and `dependencies`; route plugins do not.
- [ ] Every decorator is declared; plugins close what they open in `onClose`.
- [ ] Hooks hold no business logic and are scoped to the routes that need them.
- [ ] Routes get input and response schemas from the metaschema contract.
- [ ] `requestTimeout`, `headersTimeout`, `handlerTimeout`, `keepAliveTimeout` and `bodyLimit` are set
      on purpose; `keepAliveTimeout` exceeds the balancer idle timeout.
- [ ] A deadline signal reaches downstream calls (`request.signal` only without a body).
- [ ] `trustProxy` matches the real proxy chain.
- [ ] One error handler; 5xx bodies are generic; framework 4xx and 503 keep their status.
- [ ] Outgoing calls use undici (or `fetch` in a library), have deadlines, and consume every body.
- [ ] `node:http`: table routing, 404 and 405 distinct, byte-limited bodies, `pipeline`,
      `clientError` and listen `error` handlers.
- [ ] Static: decode in `try`, reject `\0`, containment with `path.sep`, `isFile()`, `nosniff`, ETag.
- [ ] Proxy strips hop-by-hop headers, maps 502 and 504, uses a fixed upstream, allowlists CONNECT.

Related skills: `js-contracts-schemas`, `error-handling`, `node-layered-architecture`,
`node-graceful-shutdown`, `node-scaling-highload`, `node-security`, `node-crypto-auth`,
`node-async-context`, `alexis-libraries`.
