# @alexify/wrpc

RPC protocol for Node.js and browsers: one router of procedures over WebSocket, HTTP, SSE,
WebTransport, WebRTC, worker ports and brokers. Version 2.2.0, tag `v2.2.0`, **Node.js 22+**, no
runtime dependencies, hosts injected. Uses `'use strict'` in `src/`, unlike the other libraries.

| Entry | Holds |
| --- | --- |
| `@alexify/wrpc` | `Server`, `WrpcClient`, `defineRouter`, `procedure`, `tracked`, `createEventLog`, `MemorySessionStore`, `WrpcError` |
| `/fastify`, `/express`, `/uws` | host adapters, `wrpcFastify` for Fastify |
| `/scaling` | backplanes, `createRedisAdapter` |
| `/broker`, `/broker/redis`, `/broker/nats`, `/broker/amqp`, `/broker/kafka` | message brokers |
| `/auth` | `bearerTransport`, `payloadTransport`, `bearerAuth`, token stores |
| `/sse`, `/wt`, `/webrtc`, `/ws`, `/engine` | transports and engines |
| `/encryption`, `/deflate`, `/query` | end-to-end encryption, compression, TanStack Query binding |

## When to choose it

Choose it for realtime: bidirectional calls, subscriptions that resume, rooms, binary streams.

REST stays the default for public and CRUD APIs. Do not move an HTTP API to RPC to save a route
file. In an app, mount wrpc inside Fastify so both share hooks, logging and shutdown.

## Access: what it does and does not check

| `access` | Without a session | With any session |
| --- | --- | --- |
| `'public'` | runs | runs |
| `'session'` (the default) | 403 | runs |
| any other value | `procedure()` throws `TypeError` at build | |

A procedure with no declared `access` is therefore closed to anonymous callers and **open to every
signed-in user**, whatever their role. wrpc has no roles. Authorization belongs in a hook:

```js
const router = defineRouter(units, { hooks: { preValidation: authorize } });
```

The fail-closed `authorize` hook with Kerberos is in `references/kerberos.md`. `docs/guide/router.md`
still says an unknown `access` string behaves like `'session'`. The source (`Procedure` in
`src/rpc/router.js`) throws, and the throw is what runs.

## Core API

```js
const { Server, WrpcClient, defineRouter, procedure } = require('@alexify/wrpc');

const send = procedure({
  input: SendMessage, // a metaschema Schema: Standard Schema, no adapter
  timeout: 5000,
  queue: { concurrency: 10, size: 100, timeout: 1000 },
  meta: { authz: { resource: 'chat', action: 'send' } },
  handler: async (context, { room, text }) => {
    context.server.to(room).except(context.client).emit('chat/message', { text });
    return { sent: true };
  },
});

const router = defineRouter({ chat: { send } }, { hooks: { preValidation: authorize } });
const server = new Server({ router, host: '127.0.0.1', port: 8000, protocol: 'http' });
await server.listen();

const client = await WrpcClient.connect('ws://127.0.0.1:8000/api');
await client.load('chat');
client.api.chat.on('message', ({ text }) => handleMessage(text));
await client.api.chat.send({ room: 'r1', text: 'hi' });
```

Inside Fastify:

```js
const { wrpcFastify } = require('@alexify/wrpc/fastify');

await fastify.register(wrpcFastify, { router });
fastify.wrpc.broadcast('system/announce', { text: 'maintenance in 5m' });
```

| Option of `procedure` | Meaning |
| --- | --- |
| `handler` | `(context, args, subscription) => result`, required |
| `access` | `'session'` by default, or `'public'` |
| `input`, `output` | function or Standard Schema. Failure is 400 or 500 |
| `schema` | Fastify-shaped JSON Schema. Needs `validation: { ajv }` on the router |
| `timeout` | ms, 408. Does not stop the handler |
| `queue` | `{ concurrency, size, timeout }`, 503 on overflow |
| `meta` | free-form, read by hooks and introspection |
| `http` | maps a procedure to a REST route |

Hook phases in order: `onRequest`, then the session gate, `preValidation`, input validation,
`preHandler`, the handler, `preSerialization`, output validation, `onSend`, `onResponse`. There is no
`(context, next)` chain: a hook returns or throws an error with a numeric `code`.

`context` has `client`, `session`, `server`, `signal`, `state`, `uuid`, `method`, `procedure`.

## Validation

Pass a metaschema `Schema` as `input` and `output`. wrpc reads `~standard`, so defaults and decoders
apply, and an unknown key is a 400:

```js
const signUp = procedure({ access: 'public', input: SignUp, handler: createAccount });
```

Checked over WebSocket on the shared fixtures of `js-contracts-schemas`: all 11 verdicts match
`SignUp.parse`. `schema` and `input`/`output` are mutually exclusive on one procedure.

## Sessions

```js
const login = procedure({
  access: 'public',
  handler: async (context, { user, password }) => {
    const account = await verify(user, password);
    context.client.startSession(undefined, { user: account });
    return { ok: true };
  },
});
```

- Over WebSocket, `startSession` sets no cookie, since an open socket has no response. The session
  lives for that connection. Log in over HTTP, and the upgrade restores it from the cookie.
- `state` writes are fire-and-forget and only top-level keys persist: reassign a nested branch.
- `MemorySessionStore` is the default. Use a shared store past one process.
- A dropped connection does not delete a session. Only `finalizeSession` and store expiry do.

## Gotchas

- `system/introspect` is **public by default** and lists every method and its input schema. Set
  `introspection: 'session'` or `false`, or `{ access: 'session', schemas: false }`.
- `timeout` rejects the caller and leaves the handler running. Watch `context.signal`. A timed-out
  call keeps its `queue` slot until the handler settles.
- Subscriptions take no `timeout` or `queue`, and hooks run only around their setup, never per value:
  a permission revoked later is not rechecked for a running feed.
- Reserved names in a unit: `on`, `hooks`, `emits`, `consumes`. A version key is `unit.vN`:
  `auth.1` and `auth.beta` are rejected.
- Never branch an access decision on `client.meta`: the client declares it.
- Rooms stay in one process without a backplane. `createEventLog` is per-process, and SSE channels
  need sticky routing.
- `server.close({ drain })` waits for calls, never for subscriptions. Close the injected backplane
  after it.
- An event for a unit the client did not `load()` surfaces as `unhandled-event` on the client.

## Before production

Set `cors.origins`, a real session store, `SIGTERM` with `close({ drain })`, `instanceId` from the
orchestrator, a Pino logger, a decision on `introspection`, per-connection limits (`maxCalls` is 1000
by default) and sticky routing if SSE or event logs are used.

Related skills: `node-websocket-realtime`, `node-access-control`, `js-contracts-schemas`
