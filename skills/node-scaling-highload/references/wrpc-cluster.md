# wrpc across instances

What `@alexify/wrpc` 2.2 offers once more than one process serves realtime traffic. Checked on Node.js
24 with two `Server` instances over `MemoryBackplane`, and over `createRedisAdapter` and
`createRedisSessionStore` with an ioredis-shaped fake. A real Redis was not available.

## Wiring

```js
const Redis = require('ioredis');
const { Server } = require('@alexify/wrpc');
const { createRedisAdapter, createRedisSessionStore } = require('@alexify/wrpc/scaling');

const redis = new Redis(process.env.REDIS_CACHE_URL);
const backplane = createRedisAdapter({ pub: redis });
const store = createRedisSessionStore({ client: redis, ttl: 24 * 3600_000 });
const instanceId = process.env.INSTANCE_ID;
const cluster = { secret: process.env.WRPC_CLUSTER_SECRET };

const server = new Server({ router, backplane, instanceId, cluster, sessions: { store } });
```

- wrpc has no dependencies: you inject the Redis client. A client you pass is never closed by wrpc,
  so close it yourself after the server.
- In Fastify the same options go to `register(wrpcFastify, { router, backplane, ... })`, and the core
  is `fastify.wrpc`.
- `instanceId` must be stable and must not contain a dot: a client id is `<instanceId>.<generated>`.
- Use `new MemoryBackplane()` from `@alexify/wrpc/scaling` to test several instances in one process.

## Who needs sticky routing

| Transport | Sticky? | Why |
| --- | --- | --- |
| WebSocket, WebTransport | No | Session from the shared store, rooms over the backplane |
| Packet HTTP, REST | No | Stateless per request |
| SSE | **Yes** | The channel lives on the instance that opened it. A misrouted request answers 409 |
| WebRTC | No | Peer to peer. Only signaling runs on a server |
| Broker binding | No | A session is bound to the instance that answered its `hello` |
| Subscriptions with `createEventLog` | No, but visible | A foreign epoch makes `since()` answer `null`, and the handler sends a snapshot |

Share the session store and the backplane. Keep event logs and SSE channels local. Never pin a
balancer on a wrpc client id.

## Cluster API

```js
server.cluster.count('chat');
server.cluster.presence('chat');
server.cluster.instances();

const clients = await server.cluster.fetchClients({ room: 'chat' });
if (clients.incomplete) log.warn('a node did not answer in time');

server.cluster.join(clientId, 'ops');
server.cluster.leave({ room: 'chat' }, 'archive');
server.cluster.disconnect({ room: 'banned' });
server.sendTo(clientId, 'chat/dm', { text: 'hi' });

server.cluster.sendEvent('cache/invalidate', { key });
server.cluster.on('cache/invalidate', ({ key }) => cache.delete(key));

server.cluster.respond('stats', async () => ({ load: readLoad() }));
const { answers, errors, incomplete } = await server.cluster.ask('stats');
```

- `count()` and `presence()` are local reads of a replicated table. Deltas plus a periodic digest
  (`presenceInterval`, 5 s) heal a lost message within one interval.
- `fetchClients` and `ask` never reject on a silent node. Check `incomplete` and `truncated`.
- Presence costs O(nodes × rooms) heap. With a per-user `user:<id>` room pattern, exclude that family:
  `cluster: { rooms: (room) => !room.startsWith('user:') }`.
- Without a backplane every operation degrades to its local half, so code does not branch on the
  deployment.

## Guarantees

- Delivery is **at-most-once**, for room events and for cluster commands. A subscriber that dropped
  for 200 ms loses messages, and `wrpc.server.backplane.gaps` counts them.
- A client that must not miss values uses subscriptions with `tracked()`, an event log, and the
  `lastEventId` it sends on reconnect.
- An emit to one room uses that room's channel. `to('a', 'b').emit(...)` falls back to the broadcast
  channel every instance holds, so prefer single-room emits on hot paths.

## Trust and health

- The backplane is a trust peer: whoever can publish on it can disconnect every client. Isolate and
  ACL the broker. `cluster: { secret }` signs commands with HMAC-SHA256 and refuses replays, and its
  nodes must keep clocks within `maxSkew` (30 s). Room events are not signed.
- `rooms: { encryption }` and `cluster: { encryption }` seal envelopes when the broker itself is in
  the threat model.
- `server.rpc.healthy` (in Fastify `fastify.wrpc.healthy`) is `false` while a backplane subscribe is
  failing: the node can publish but cannot hear. Wire it into readiness.

## Shutdown

```js
const stop = async () => {
  await server.close({ drain: 10_000 });
  await backplane.close();
  await redis.quit();
};
```

`close({ drain })` stops intake, refuses new calls with 503, waits for in-flight calls, sends peers
close code 1001 so they reconnect elsewhere with backoff, then tears down. Subscriptions are not
waited for, so size `drain` against the slowest call. Under Fastify pass `drain` to `wrpcFastify`, and
`fastify.close()` runs it.
