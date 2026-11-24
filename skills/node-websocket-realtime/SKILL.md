---
name: node-websocket-realtime
description: WebSocket and realtime on @alexify/wrpc with upgrade auth, rooms, feeds, reconnect, drain. Use for chat, live data, dropped or leaking sockets
---

# WebSocket and Real-Time Systems in Node.js

Treat every WebSocket as a long-lived, stateful, untrusted resource: authenticate before the `101`
response, authorize every procedure, detect dead peers, respect backpressure, release everything on
close, keep domain code transport-agnostic, and design reconnection and scale-out from day one.

## Decision guide

| Need | Use |
| --- | --- |
| Realtime in an Alexis app | `@alexify/wrpc` with `wrpcFastify` on the app's Fastify server |
| Public or CRUD API | REST stays. wrpc is for realtime |
| Realtime with no Fastify | wrpc `Server`, or `createWrpc` from `/express` on a bare `http.Server` |
| Presence, cursors, typing | Room events (at-most-once) |
| A feed the client must not miss | Subscription with `tracked` and `createEventLog`, or `brokerFeed` |
| Push through a proxy that blocks WebSocket | wrpc SSE: `transport: ['ws', 'sse']` |
| Node.js as a client | `WrpcClient`. Global `WebSocket` (Node 22+) for a non-wrpc peer |
| Browser-to-browser data | WebRTC data channel (`@alexify/wrpc/webrtc`), server for signaling |
| A peer that speaks plain WebSocket | `ws` with `noServer: true`, see `references/server-patterns.md` |
| Existing Socket.IO code | Keep it and apply the rules. It is not a plain WebSocket protocol |
| Framing bugs, a protocol library | `references/rfc6455.md` |

|  | Library `@alexify/*` | App (`auth8`) |
| --- | --- | --- |
| Host | Transport injected, no framework import | `wrpcFastify`, shares hooks, Pino, shutdown |
| Config | Constructor options | `node-config`: origins, limits, Redis URL |
| Sessions | Store injected | Redis through `createRedisSessionStore` |
| Tests | `node:test` with a real `WrpcClient` | Vitest with DI fakes, k6 or autocannon for load |

Default positions and why:

- Business logic, the database and serialization take most server CPU, not the WebSocket library.
  Do not choose by echo benchmarks: measure memory, CPU and `performance.eventLoopUtilization()`.
- Do not write protocol code in product projects. A framing parser is system code and belongs in a
  tested library. wrpc has its own RFC 6455 engine and no dependencies.
- JSON is the default. Binary protocols are harder to parse and often save little. Measure first.
- Business logic must not know which transport delivered a call. A wrpc procedure already runs the
  same over WebSocket, HTTP and SSE. Keep `context` in the Presentation layer and pass plain values
  to the Application layer.

## Rules

### Connection setup and authentication

- Serve HTTP and WebSocket on one port. `wrpcFastify` attaches to `fastify.server`. Unknown upgrade
  paths are refused with a status.
- **Set `cors.origins`.** Without it the upgrade accepts any origin, and browsers do not apply the
  same-origin policy to WebSocket (Cross-Site WebSocket Hijacking). `Origin` is not authentication:
  a request with no `Origin` passes, since non-browser clients may omit or forge it.
- **Authenticate before the `101`** when anonymous sockets have no purpose. `ws.verifyClient` is
  synchronous and **replaces** the default Origin and path gate, so do an async check through a
  manual upgrade (pattern below). Answer `401` for no session, `503` when the store fails.
- A connection that must reach a public `auth/signIn` stays open but can call only `public`
  procedures. Give it a deadline to authenticate.
- Browsers cannot set headers on `new WebSocket()`. Use an `HttpOnly`, `SameSite` session cookie, set
  by a login **over HTTP**: `startSession` over a socket sets no cookie and dies with the connection.
  With a bearer token use `bearerTransport()` and `bearerAuth()` from `@alexify/wrpc/auth`. Never put
  a long-lived token in the URL, because proxies log it.
- Tokens are opaque and revocable on the server. `finalizeSession()` ends a session on this instance
  at once. Another instance holds its copy until reconnect or until told over the cluster.
- Lower the limits for untrusted connections: `ws.maxBuffer` (100 MiB by default, far too high),
  `maxCalls` (1000), `maxSubscriptions` (256), `maxBatch` (128), a per-procedure `queue` and
  `timeout`, and a rate-limit hook on `onRequest`.
- Leave `perMessageDeflate` off unless measured. Set `introspection: 'session'` or `false`: by
  default anyone can list every method.

### Authorization

- wrpc has two access values. `'public'` runs for anyone. `'session'`, the default, is `403` for an
  anonymous caller and **admits every signed-in user**. Any other value throws at build.
- Per-resource authorization is `@alexify/kerberos` in a router-level hook that **fails closed**: a
  procedure with no declared rule is refused (pattern below). Never rely on the access value alone.
- Run it in `preHandler` when the rule reads `args`, which are validated there. It also guards
  subscriptions and inbound events at setup. A running feed is **not** rechecked, so disconnect the
  client when a permission is revoked.
- Never branch an access decision on `client.meta`: the client declares it.

### Protocol and validation

- wrpc owns the envelope (`call`, `callback`, `event`, `subscribe`, `data`, `end`, `ping`). Packet
  shapes are in `references/wrpc-patterns.md`.
- Validate with `@alexify/metaschema`: a `Schema` is a Standard Schema and goes straight into `input`
  and `output`. A failure answers `400` with `error.details.issues`. See `js-contracts-schemas`.
- wrpc reads only a **numeric** `error.code`. A domain error with `code: 'EFORBIDDEN'` reaches the
  client as `500`. Map domain codes at the procedure boundary, with the table in `error-handling`.
- A 5xx message is replaced with the status text. Never set `expose` on an internal error.
- Give each call a `timeout`. It rejects the caller and does not stop the handler, so watch
  `context.signal`.
- Render received text with `textContent`, never `innerHTML`.

### Heartbeat and dead peers

- A TCP connection can die silently (NAT timeout, sleeping laptop, mobile handover). The wrpc engine
  runs one timer for all connections (`ws.pingInterval`, 10 s) and terminates a peer that missed a
  pong. Never add a `setInterval` per connection.
- Browsers cannot send ping frames, so the client sends an application ping
  (`heartbeat: { interval: 30000, timeout: 10000 }` by default) and reconnects on a miss.
- Keep the interval below every proxy and load balancer idle timeout on the path (commonly 60 s).

### Reconnection (client)

- `WrpcClient` reconnects with capped exponential backoff and full jitter, which breaks up the
  thundering herd after a deploy. The attempt counter resets only after `reconnect.stableAfter`.
- After reconnect, in this order: session (cookie, bearer header or the `authenticate` hook), then
  subscriptions from the last event id, then units. The `authenticate` hook runs before the restore.
- **Rooms are not restored.** A reconnect is a new server-side client. Keep memberships in the
  session and re-join in the `onConnect` hook. Dispatch waits for it.
- Never replay calls that were already sent: the server may have executed them. wrpc rejects them.
  Use the opt-in `retry` only for idempotent calls, or send a client-generated operation id that the
  server deduplicates.
- wrpc keeps no offline queue. Queue offline calls in a bounded outbox with an expiry per entry, see
  `js-local-first-sync`.

### Rooms and broadcasting

- Use `client.join(room)` and `server.to(room).except(client).emit('unit/name', data)`. The registry
  owns both directions and releases a client on disconnect. A broadcast is serialized once.
- `to()` with an empty list reaches nobody. `emit()` returns the **local** recipient count.
- One user has many tabs and devices. Address a user through a room such as `user:<id>`, never a
  `Map<userId, socket>`.
- Room events are at-most-once. For anything a client must not miss, use a subscription with an event
  log, and send a snapshot when `log.since()` answers `null`.
- Debounce noisy broadcasts (presence, cursors, typing). Prefer single-room emits: a multi-room emit
  uses the broadcast channel.

### Backpressure

- `socket.send()` never blocks, and unsent data accumulates in memory. A subscription generator is
  paced by the transport: the pump waits for drain before pulling the next value.
- `createEventStream({ signal, highWaterMark })` bounds a push source and drops the **oldest** value.
  Read `stream.dropped` if the client must know it fell behind.
- `ws.maxBackpressure` (default `maxBuffer`) is the cap for one slow consumer. Past it wrpc
  **terminates** the socket with no close frame, so the client sees `1006` and reconnects. Set it.
- For bulk data use binary streams and honour `write()` and `'drain'`.

### Lifecycle, close codes, shutdown

Close codes are for connection-level failures. Per-call errors (validation, auth, rate limit) travel
inside messages as numeric codes.

| Code | Use | In wrpc |
| --- | --- | --- |
| 1000 | Normal close | `client.close()` on the client |
| 1001 | Going away | `server.close()`, `fastify.close()`, `client.close()` on the server |
| 1002 | Protocol error | Engine, on a bad frame |
| 1003 | Unsupported data | Own `ws` servers |
| 1006 | Abnormal, no close frame. Never sent | Seen after `terminate()` |
| 1007 | Invalid payload (bad UTF-8) | Engine |
| 1008 | Policy violation | Sealed-session refusal, own `ws` servers |
| 1009 | Message too big | Engine, over `maxBuffer` or `maxPayload` |
| 1011 | Internal error | Engine |
| 1012 | Service restart | Own `ws` servers. wrpc drains with 1001 |
| 1013 | Try again later (overload) | Own `ws` servers |
| 3000-4999 | Application-defined | Yours |

- Browser and Node clients may call `close()` only with `1000` or `3000-4999`.
- A client that sees `1009` will fail the same way on retry: send less.
- Graceful shutdown: `await server.close({ drain: 10000 })`, or the `drain` option of `wrpcFastify`
  and `fastify.close()`. Intake stops, new calls answer `503`, calls in flight finish, peers get
  `1001`, the rest is torn down. Subscriptions are **not** waited for. Close an injected backplane
  after it. Sequence and timeouts are in `node-graceful-shutdown`.
- Each socket is a file descriptor. Leaked sockets exhaust `ulimit -n`, then nothing connects.

### Scaling

- One process holds tens of thousands of idle connections. The real limit is the work per message.
- A WebSocket is pinned to its process. Scaling out raises three problems: fan-out (a **backplane**,
  `createRedisAdapter`), reconnects to another node (a shared session store), and state locality
  (route all users of one document to the node that owns it).
- With a backplane and a shared store, WebSocket needs **no** sticky routing. SSE channels do. An
  event log is per-process: another instance answers `since() === null`, so send a snapshot.
- The backplane is a trust peer. Isolate and ACL it, and set `cluster: { secret }`.
- Proxies must forward `Upgrade` and `Connection` (nginx: `proxy_http_version 1.1`,
  `proxy_set_header Upgrade $http_upgrade`, `proxy_set_header Connection "upgrade"`).
- Set `instanceId` from the orchestrator, with no `.` in it.

### Collaborative design

The server orders operations, clients apply changes optimistically and rebase. Sync only source
data, give late joiners a snapshot plus the tail, show conflicts to users. See `js-local-first-sync`.

## Patterns

The full service, run over real sockets, is in `references/wrpc-patterns.md`.

### Fail-closed authorization with Kerberos

```js
const SELF_AUTHORIZED = new Set(['system/introspect', 'auth/signOut']);

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

const send = procedure({
  input: SendMessage, // a metaschema Schema
  timeout: 5000,
  meta: { authz: { resource: 'room', action: 'send', id: (args) => args.room, load: loadRoom } },
  handler: withDomainErrors(sendMessage),
});

const router = defineRouter({ chat: { send } }, { hooks: { preHandler: authorize } });
```

Both exemptions are required: without them `client.load()` gets `403` under
`introspection: 'session'`, and a mounted syncom unit refuses every node.

### Session check before the `101`

```js
const createGatedEngine = (hasSession) => {
  const engine = createNodeEngine(); // from @alexify/wrpc/engine
  const attach = ({ server, ...options }) => {
    const source = engine.attach(options);
    const onUpgrade = async (req, socket, head) => {
      socket.on('error', () => socket.destroy());
      try {
        const isAllowed = await hasSession(req);
        if (socket.destroyed) return;
        if (isAllowed) source.handleUpgrade(req, socket, head); // runs the Origin and path gate
        else refuseUpgrade(socket, 401, 'Unauthorized');
      } catch {
        refuseUpgrade(socket, 503, 'Service Unavailable');
      }
    };
    server.on('upgrade', onUpgrade);
    return source;
  };
  return { ...engine, attach };
};

await fastify.register(wrpcFastify, { router, engine, cors, sessions, ws, drain: 10000 });
```

`hasSession` reads the token with `fastify.wrpc.sessions.transport.read({ headers, url })` and looks
it up in `sessions.store`, so it follows whichever carrier the server uses.

### A feed that resumes

```js
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
```

The publisher does `const id = log.push(message)`, then `bus.emit(room, tracked(id, message))`.

### Client

```js
const reconnect = { minDelay: 500, maxDelay: 30000, factor: 2, jitter: true };
const client = await WrpcClient.connect('wss://app.example/api', { reconnect, callTimeout: 7000 });
await client.load('chat');
client.api.chat.on('message', render); // listeners survive a reconnect
const feed = client.api.chat.feed.subscribe({ room }, { onData: render, onError: showError });
```

Call through `client.api` each time, because units are rebuilt on reconnect. `events.once()` does not
work on a `WrpcClient`: wrap `client.on` in a promise.

## Anti-patterns

- A procedure guarded only by `access: 'session'`: every signed-in user can call it.
- A custom `ws.verifyClient` that forgets Origin, since it replaces the default gate.
- No `cors.origins` in production. Tokens in query strings. `Origin` trusted as authentication.
- A domain error with a string `code` thrown through wrpc: the client gets `500`.
- A `setInterval` per connection. Socket handlers whose closures capture large buffers.
- `Map<userId, socket>` (the second tab replaces the first). Iterating all clients for room messages.
- Assuming rooms survive a reconnect, or that room events are delivered exactly once.
- Replaying non-idempotent calls after reconnect. No event id, so offline events are lost.
- Importing `ws` or wrpc in Domain or Application code. Business logic calling `socket.send`.
- Hand-written framing in an application. A parser that assumes one `data` event is one frame.
- A proxy idle timeout shorter than the heartbeat. `MemorySessionStore` across instances.

## Checklist

- [ ] HTTP and WebSocket share a port. Unknown upgrade paths get a status.
- [ ] `cors.origins` is set. Session is checked before the `101`, or the socket is public-only.
- [ ] Every non-public procedure has a Kerberos rule, and the hook fails closed.
- [ ] `input` is a metaschema `Schema`. Domain errors map to numeric codes.
- [ ] `maxBuffer`, `maxBackpressure`, `maxCalls`, a rate limit and `introspection` are set.
- [ ] Rooms are re-joined in `onConnect`. Feeds use `tracked` and handle `since() === null`.
- [ ] Already-sent calls are not replayed. Mutating calls carry ids where retried.
- [ ] Shutdown uses `drain`. The backplane closes after it.
- [ ] Multi-node: backplane, shared session store, `instanceId`, proxy forwards `Upgrade`, idle
      timeouts exceed the heartbeat.
- [ ] Domain code depends on plain values, not on wrpc or `ws`.

Related skills: `js-local-first-sync`, `alexis-libraries`, `js-contracts-schemas`, `error-handling`,
`node-access-control`, `node-http-server`, `node-scaling-highload`, `node-crypto-auth`,
`node-security`, `node-graceful-shutdown`, `node-streams`
