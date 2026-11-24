# wrpc patterns: a complete realtime service

Read this when building or reviewing a service on `@alexify/wrpc` 2.2. The files below were run
together on Node.js 24 against the real `wrpc`, `kerberos`, `metaschema` and Fastify, over real
sockets. An app writes the same code as ESM TypeScript.

## Packets

wrpc owns the wire. Know the shapes when reading a trace, never write them by hand.

| Packet | Shape |
| --- | --- |
| call | `{ type: 'call', id, method: 'unit/name', args, meta? }` |
| callback | `{ type: 'callback', id, result }` or `{ ..., error: { code, message, details? } }` |
| event | `{ type: 'event', name: 'unit/name', data }`, no id, both directions |
| subscribe | `{ type: 'subscribe', id, method, args, lastEventId? }` |
| data, end | `{ type: 'data', id, data, eventId? }`, then `{ type: 'end', id, error? }` |
| unsubscribe, cancel | `{ type: 'unsubscribe', id }`, `{ type: 'cancel', id }` |
| ping, pong | `{ type: 'ping' }`, `{ type: 'pong' }` |
| stream | a header packet, then binary chunks that carry the stream id |

Error codes are HTTP numbers on every transport: `400` invalid input, `403` no session or refused,
`404` unknown method, `408` timeout, `429` limit, `499` cancelled, `503` queue full or draining,
`500` otherwise. A 4xx message travels. A 5xx message is replaced with the status text.

## Authorization hook (`authorize.js`)

wrpc refuses a call without a session unless the procedure is `public`. It admits **every** session
to a procedure with no declared access, so the per-resource decision is a hook, and the hook fails
closed. It runs in `preHandler` because the rule reads `args`, which are validated by then. A rule
that reads no args can run in `preValidation`.

```js
// authorize.js
const { Kerberos, Effect } = require('@alexify/kerberos');

const SELF_AUTHORIZED = new Set(['system/introspect', 'auth/signOut']);

const condition = { match: ({ P, R }) => R.attr.members.includes(P.id) };
const rules = [{ actions: ['read', 'send'], effect: Effect.Allow, roles: ['USER'], condition }];
const roomPolicy = { resourcePolicy: { resource: 'room', version: 'default', rules } };
const kerberos = new Kerberos([roomPolicy], [], { onError: 'deny' });

const forbidden = () => {
  const error = new Error('Forbidden');
  error.code = 403;
  return error;
};

const authorize = async (context, args) => {
  const { procedure, session, method } = context;
  if (procedure.access === 'public' || SELF_AUTHORIZED.has(method)) return;
  if (method.startsWith('syncom/')) return; // the unit's own authorize and authorizeWrite decide
  const authz = procedure.meta.authz;
  if (!authz) throw forbidden();
  const { id, roles } = session.state.user;
  const attr = authz.load ? await authz.load(args) : {};
  const resourceId = authz.id ? authz.id(args) : authz.resource;
  const resource = { id: resourceId, kind: authz.resource, attr };
  const principal = { id, roles };
  const isAllowed = await kerberos.isAllowed({ principal, resource, action: authz.action });
  if (!isAllowed) throw forbidden();
};

module.exports = { authorize };
```

`auth/signOut` is listed because any session may end itself. The other two exemptions are required,
and both were observed failing without them:

- `system/introspect` has no `meta.authz`. Under `introspection: 'session'` a hook without the
  exemption answers 403 to `client.load()`.
- A mounted syncom unit has no `meta.authz` either. Without the exemption every `syncom/hello` is 403.
  Omit that line when the service mounts no syncom unit.

## Domain errors (`errors.js`)

wrpc reads only a **numeric** `error.code`. A domain error with `code: 'EPRECONDITION'` reaches the
client as `500 Internal Server Error`. Map it once, at the procedure boundary, with the table of
`error-handling`:

```js
// errors.js
const WIRE_CODES = new Map([
  ['EVALIDATION', 400],
  ['EAUTH', 401],
  ['EFORBIDDEN', 403],
  ['ENOTFOUND', 404],
  ['ECONFLICT', 409],
  ['EPRECONDITION', 409],
  ['ETOOLARGE', 413],
  ['ELIMIT', 429],
  ['EUNAVAILABLE', 503],
  ['ETIMEOUT', 504],
]);

const withDomainErrors = (handler) => async (context, args) => {
  try {
    return await handler(context, args);
  } catch (error) {
    const code = WIRE_CODES.get(error.code);
    if (code === undefined) throw error;
    const wire = new Error(error.message, { cause: error });
    wire.code = code;
    wire.details = error.details;
    throw wire;
  }
};

module.exports = { withDomainErrors };
```

It wraps call handlers. An async generator keeps its own `try` / `catch`.

## Router (`router.js`)

```js
// router.js
const { EventEmitter } = require('node:events');

const wrpc = require('@alexify/wrpc');
const { Schema } = require('@alexify/metaschema');

const { authorize } = require('./authorize.js');
const { withDomainErrors } = require('./errors.js');

const { defineRouter, procedure, createEventLog, createEventStream, tracked } = wrpc;

const RoomArgs = Schema.from({ room: 'string' });
const text = { type: 'string', length: { min: 1, max: 2000 } };
const SendMessage = Schema.from({ room: 'string', text });

const createChatRouter = ({ rooms }) => {
  const log = createEventLog({ size: 1000 });
  const bus = new EventEmitter();
  const loadRoom = async ({ room }) => ({ members: await rooms.members(room) });
  const roomRule = (action) => {
    const id = (args) => args.room;
    return { resource: 'room', action, id, load: loadRoom };
  };

  const join = async (context, { room }) => {
    context.client.join(room);
    const joined = new Set(context.session.state.rooms);
    joined.add(room);
    context.session.state.rooms = [...joined]; // reassign: only top-level keys persist
    return { joined: room };
  };

  const send = async (context, { room, text: body }) => {
    const message = { from: context.session.state.user.id, text: body };
    const id = log.push(message);
    bus.emit(room, tracked(id, message));
    context.server.to(room).except(context.client).emit('chat/message', message);
    return { id };
  };

  const feed = async function* (context, { room }, { lastEventId, signal }) {
    const stream = createEventStream({ signal, highWaterMark: 1000 });
    const listener = (item) => stream.push(item);
    bus.on(room, listener); // before since(), with no await between them: no gap
    try {
      const missed = log.since(lastEventId);
      if (missed === null) yield { type: 'snapshot', items: await rooms.recent(room) };
      else yield* missed;
      yield* stream;
    } finally {
      bus.off(room, listener);
    }
  };

  const onConnect = async (client) => {
    await client.sessionReady;
    const joined = client.session?.state.rooms ?? [];
    for (const room of joined) client.join(room);
  };

  const signOut = async (context) => context.client.finalizeSession();

  const units = {
    auth: { signOut: procedure({ handler: signOut }) },
    chat: {
      join: procedure({
        input: RoomArgs,
        meta: { authz: roomRule('read') },
        handler: withDomainErrors(join),
      }),
      send: procedure({
        input: SendMessage,
        timeout: 5000,
        queue: { concurrency: 10, size: 100, timeout: 1000 },
        meta: { authz: roomRule('send') },
        handler: withDomainErrors(send),
      }),
      feed: procedure.subscription({
        input: RoomArgs,
        meta: { authz: roomRule('read') },
        handler: feed,
      }),
    },
  };
  return defineRouter(units, { hooks: { preHandler: authorize, onConnect } });
};

module.exports = { createChatRouter };
```

Details that are easy to get wrong:

- `client.rooms` is empty after a reconnect. A reconnect is a new server-side client, so re-join from
  the session in `onConnect`. Dispatch waits for `onConnect`, so a racing call sees the rooms.
- Over WebSocket `startSession` sets no cookie. Log in over HTTP, or the session dies with the socket.
- `createEventStream({ signal, highWaterMark })` drops the **oldest** value on overflow and counts it
  in `stream.dropped`. The form `createEventStream(bus, name, options)` shown in `docs/guide/rooms.md`
  does not exist.
- `events.once(client, name)` does not work on a `WrpcClient`: its emitter has no `removeListener`
  and the process crashes on the next `error`. Wrap `client.on` in a promise.

## Auth before the `101` on Fastify (`realtime.js`)

`ws.verifyClient` is **synchronous**, and setting it **replaces** the default gate, so the Origin and
path checks go with it. An async session check needs a manual upgrade: `attach()` without `server`,
then `source.handleUpgrade()`. The plugin keeps its default gate (`cors.origins`, path) inside it.

```js
// realtime.js
const fp = require('fastify-plugin');
const { wrpcFastify } = require('@alexify/wrpc/fastify');
const { createNodeEngine } = require('@alexify/wrpc/engine');

const refuseUpgrade = (socket, status, reason) => {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

const createGatedEngine = (hasSession) => {
  const engine = createNodeEngine();
  const attach = ({ server, ...options }) => {
    const source = engine.attach(options);
    const onUpgrade = async (req, socket, head) => {
      socket.on('error', () => socket.destroy());
      try {
        const isAllowed = await hasSession(req);
        if (socket.destroyed) return;
        if (isAllowed) source.handleUpgrade(req, socket, head);
        else refuseUpgrade(socket, 401, 'Unauthorized');
      } catch {
        // A failed store is not a missing session
        refuseUpgrade(socket, 503, 'Service Unavailable');
      }
    };
    server.on('upgrade', onUpgrade);
    return source;
  };
  return { ...engine, attach };
};

const realtime = async (fastify, { router, origins, store, backplane = null }) => {
  const hasSession = async (req) => {
    const { sessions } = fastify.wrpc;
    const token = sessions.transport.read({ headers: req.headers, url: req.url });
    if (!token) return false;
    const state = await sessions.store.get(token);
    return state !== null && state !== undefined;
  };
  const engine = createGatedEngine(hasSession);
  const cors = { origins, credentials: true };
  const ws = { maxBuffer: 64 * 1024, maxBackpressure: 1024 * 1024 };
  const sessions = { store };
  const limits = { maxCalls: 64, maxSubscriptions: 16, introspection: 'session' };
  await fastify.register(wrpcFastify, {
    router,
    engine,
    cors,
    ws,
    sessions,
    backplane,
    drain: 10000,
    ...limits,
  });
  if (backplane) fastify.addHook('onClose', () => backplane.close());
};

module.exports = fp(realtime, { name: 'realtime' });
```

Verified answers on the raw socket: no token `401`, unknown token `401`, foreign `Origin` `403`, a
valid session `101`, a store that throws `503`.

With `introspection: 'session'` a browser client must have its session at connect, from the cookie.

## Client (`client.js`)

```js
// client.js
const { WrpcClient } = require('@alexify/wrpc');

const connectChat = async (url, { headers, onMessage, onValue }) => {
  const reconnect = { minDelay: 500, maxDelay: 30000, factor: 2, jitter: true };
  const heartbeat = { interval: 20000, timeout: 5000 };
  const options = { headers, reconnect, heartbeat, callTimeout: 7000 };
  const client = await WrpcClient.connect(url, options);
  await client.load('chat');
  client.api.chat.on('message', onMessage); // listeners survive a reconnect
  await client.api.chat.join({ room: 'general' });
  const feed = client.api.chat.feed.subscribe({ room: 'general' }, { onData: onValue });
  return { client, feed };
};

module.exports = { connectChat };
```

- Call through `client.api` each time. Units are rebuilt on reconnect.
- In a browser the session cookie rides the upgrade. `headers` is for a Node.js client.
- With a bearer token, use `bearerTransport()` on the server and `bearerAuth()` on the client from
  `@alexify/wrpc/auth`. The token rides a subprotocol offer, never the URL.
- A call in flight when the socket dies rejects and is **not** replayed. `retry` is opt-in: enable it
  only for idempotent calls, or send a client-generated operation id the server deduplicates.
- wrpc keeps no offline queue. An outbox is the application's, see `js-local-first-sync`.

## Backplane and cluster

```js
const Redis = require('ioredis');
const { createRedisAdapter, createRedisSessionStore } = require('@alexify/wrpc/scaling');

const redis = new Redis(config.redisUrl);
const backplane = createRedisAdapter({ pub: redis });
const store = createRedisSessionStore({ client: redis, ttl: 24 * 3600000 });
```

`MemoryBackplane` from the same subpath stands in for Redis in tests: two `Server` instances sharing
one deliver room events to each other. The Redis adapter itself was not run here.

| Concern | wrpc |
| --- | --- |
| Fan-out across instances | `server.to(room).emit()` through the backplane, at-most-once |
| Loss detection | `backplane.gap` log line and `wrpc.server.backplane.gaps`. It detects, it does not replay |
| Guaranteed feed | A subscription over a log or a broker (`brokerFeed` from `/broker`) |
| Cluster-wide counts | `server.cluster.count(room)`, `presence(room)` |
| Find, kick, address | `fetchClients({ room })`, `disconnect({ room })`, `server.sendTo(id, name, data)` |
| Node-to-node | `cluster.sendEvent`, `cluster.respond`, `cluster.ask` |
| Command authenticity | `cluster: { secret }`, HMAC with replay protection |
| Readiness | `server.rpc.healthy`, false while a backplane subscribe is failing |

Sticky routing is needed only for SSE channels. A WebSocket reconnect to another instance restores
the session from the shared store, and an event log from another instance answers `since() === null`,
so the handler sends a snapshot.

## Rate limit

`maxCalls` bounds concurrency. A rate is a hook:

```js
const buckets = new WeakMap();

const rateLimit = (limit, windowMs) => async (context) => {
  const now = Date.now();
  let bucket = buckets.get(context.client);
  if (!bucket || now - bucket.start >= windowMs) {
    bucket = { start: now, used: 0 };
    buckets.set(context.client, bucket);
  }
  bucket.used++;
  if (bucket.used <= limit) return;
  const error = new Error('Rate limit exceeded');
  error.code = 429;
  throw error;
};
```

Register it as `onRequest`. It is keyed by connection, so key by user when a limit must survive a
reconnect. A limit is a per-call `429` inside a message, not a close code.
