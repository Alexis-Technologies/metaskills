---
name: node-scaling-highload
description: Node.js scaling with replicas, Redis state, BullMQ, wrpc clusters and load shedding. Use for topology, overload, lost sessions, restarts
---

# Scaling Node.js and High-Load Design

Choose a topology from the measured load and the state model of the service, keep state where every
instance can find it, bound work so overload becomes fast 503s instead of collapse, and restart
without dropping requests. Simple first: one well-written process, then more instances.

## Project profile

|                 | Library `@alexify/*`                     | App (`auth8`)                                         |
| --------------- | ---------------------------------------- | ----------------------------------------------------- |
| Process model   | Never forks, never owns the process      | One process per container, scaled by instances        |
| Shared state    | Store or backplane injected              | MongoDB as truth, Redis or Valkey beside it           |
| Background work | None                                     | BullMQ, producers in `auth8-api`, workers `auth8-jobs` |
| Realtime        | `@alexify/wrpc`, Redis client injected   | wrpc in Fastify with a Redis backplane                |
| Overload        | Bounded options, 503 from its own queues | `@fastify/under-pressure`, `handlerTimeout`           |

## Deployment of auth8

- `auth8-api` and `auth8-jobs` run as plain Docker images on **Fly.io**, multi-region capable. Secrets
  are injected as environment variables, with no `NODE_ENV` branches.
- `auth8-web` is a static Vue build on **Vercel**'s CDN, so Node never serves static assets.
- MongoDB is managed **Atlas**, the source of truth. Redis is managed **Redis Cloud**.
- Platformatic is not adopted. This is a PoC choice: managed Kubernetes may follow, and plain images
  keep that move free of application changes. Do not couple code to `fly.toml`. Images, `fly.toml`
  and the pipeline: `node-deploy`.

## Defaults

- Scalability cannot be added to a finished app. Rough best-case limits that force a redesign: about
  50k concurrent connections per process, 500k per server, and about 10M where traffic between
  servers becomes the bottleneck.
- Measure concurrent connections, RPS and latency together. Distinguish high load (RPS), high
  connectivity (open connections) and high interconnection (traffic between connected users).
- No I/O beats async I/O: keep the working set in memory, read ahead, write behind what is not
  critical. Critical operations (money, credentials) persist inside the request.
- Data-structure changes give orders of magnitude, algorithm tweaks give multiples. Look at data first.
- For constant high load a few big machines beat many small VMs. Elastic cloud pays off for spiky load.
- Client-side balancing is the most efficient for many connections: the client gets a list of
  endpoints and connects to its worker directly, and the server only checks ownership.
- One small VM can serve about 100M requests per month. Add a component only for a measured reason.
- Restarts do not fix bugs. Deploy by starting new processes and moving users over.

## Decision guide

| Option | Distribution | Pros | Cons | Use when |
| --- | --- | --- | --- | --- |
| Single process | none | simplest, no shared-state problems | one core | always the first step |
| **Replicas (containers)** | platform proxy | isolation, rolling deploys, multi-region | needs shared state | **the default for an app** |
| `node:cluster` | primary passes handles round-robin | one port, drop-in | the primary saturates with many workers, ignores real load | existing apps on few cores, never inside a one-CPU container |
| Process per port (`child_process.fork`) | external LB or client | no primary hop, isolation | memory, port bookkeeping | stateful protocols on a big machine |
| Thread per port (`worker_threads`) | external LB, redirect or client | half the memory of processes, fast restart | a native crash or OOM kills all threads; sockets cannot pass to threads | many cores on one machine |
| `listen({ reusePort: true })` | kernel | no primary, independent processes | `ENOTSUP` on macOS and Windows, no affinity | stateless HTTP on Linux, Node 22.12+ |
| Many machines | LB (L4/L7) or client | capacity, fault tolerance | state, consistency, deploys | after one machine is used well |

Code for `cluster`, IP-sticky routing, thread per port and client-side balancing:
[references/recipes.md](references/recipes.md).

## Rules

### Measure before scaling

- Remove blocking first: `*Sync` calls, CPU loops in handlers, `console.log` per request. An `async`
  function with a long loop still blocks.
- Size from per-user costs: memory per connection and session, CPU per active user, database latency
  per call, calls per session. Multiply by peak concurrency, not average.
- Load-test realistic scenarios (autocannon, k6) and record p99 latency, event loop delay and
  utilization, RSS.
- Every I/O dependency in the hot path costs roughly an order of magnitude of capacity: an idle
  WebSocket service holds tens of thousands of connections on a tiny VM, real logic far fewer.
- With several processes per machine, start from cores minus one for 4-40 cores and about 75% on big
  machines, then tune. Read cores with `os.availableParallelism()` and check container CPU quotas.

### Distribute connections

- `cluster`: the primary accepts every connection and passes the handle; parsing and TLS happen in
  workers. Fine for a few workers, with dozens the primary saturates. Keep existing deployments, but
  design new services as replicas.
- Long-lived connections are balanced only at connect time and drift. Rebalance with
  `maxRequestsPerSocket`, reconnect with jitter, or client-side balancing.
- A redirect balancer (302 for GET and HEAD, 307 otherwise), or an API call that returns endpoints,
  sends traffic straight to workers with no balancer hop per message.
- UDP has no connection: keep per-peer state keyed by `address:port` in a shared store, or route by
  its hash.

### Stateless and stateful

- Decide for each kind of state: domain data, connection state (sockets, subscriptions), control-flow
  state (multi-step operations). Write the decision down.
- Stateless HTTP: any instance serves any request. Scale by adding instances. This is the auth8 API.
- State held in one process (in-memory sessions, rooms, documents, games) needs affinity. Prefer
  moving it to a shared store. With a shared session store and a wrpc backplane, WebSocket needs no
  sticky routing at all. Only SSE channels and `createEventLog()` stay per instance.
- When you do need affinity: client-side balancing with an ownership check, a balancer cookie or a
  consistent hash of the user or room id. IP hash is cheap, but behind NAT or a proxy many users share
  one address.
- Co-locate users who interact (same room, document, match) to avoid cross-process hops.

### Shared state: Redis or Valkey

- Redis is **never a source of truth**. MongoDB is authoritative; Redis holds caches and explicitly
  ephemeral data with a TTL (sessions, counters, OTP). Code must survive a cold or empty Redis.
- Decide the failure mode per feature. A cache miss falls back to MongoDB. A rate limit fails open or
  closed deliberately, and for login that decision is a security one.
- Cache through `cacheable`: in-memory L1, Redis L2 through `keyv` over `ioredis`, and cross-instance
  invalidation through `qified`. Domain and Application code depend on a port, not on Redis.
- Cache and jobs use **two separate Redis instances** with separate variables (`REDIS_CACHE_*`,
  `REDIS_JOBS_*`). The cache evicts (`allkeys-lru`), and that would silently delete queued jobs.
- Per-process caches carry a TTL or are invalidated through pub/sub. Never assume two processes hold
  the same value.
- Read replicas: reads usually outnumber writes 5-100x. Read your own writes from the primary.
- Avoid distributed transactions. Use idempotency keys and sagas with compensations
  (`node-data-access`).
- Write-behind batching is fine for presence, counters and drafts, never for anything that must
  survive a crash.

Code and details: [references/distributed-state.md](references/distributed-state.md).

### Background jobs: BullMQ

- Move slow, retryable or bursty work (email, webhooks, reports) off the request path. Answer 202 with
  an id when the client must follow up.
- Producers enqueue from the API, workers run in a separate service, so a job backlog cannot slow
  requests and each side scales alone.
- The jobs Redis uses `maxmemory-policy=noeviction` and durable persistence. A `Worker` connection
  needs `maxRetriesPerRequest: null`, or BullMQ throws.
- Delivery is **at-least-once**: handlers are idempotent. Set `attempts`, exponential `backoff`, and
  retention (`removeOnComplete`, `removeOnFail`), or Redis grows without bound.
- BullMQ is a job queue, not an event log. Lightweight pub/sub goes through `qified`.

### Realtime: wrpc cluster

- `createRedisAdapter` gives rooms a backplane, `createRedisSessionStore` shares sessions.
  `server.cluster` adds presence, `fetchClients`, addressed commands and node-to-node `ask`.
- Backplane delivery is **at-most-once**. Rooms say what happens now. A client that must not miss a
  value resumes through tracked subscriptions and an event log.
- Set a stable `instanceId` from the platform (no dots), `cluster: { secret }`, ACL the broker, and
  wire `healthy` into readiness.

Details: [references/wrpc-cluster.md](references/wrpc-cluster.md).

### Back-pressure and load shedding

- `@fastify/under-pressure` answers 503 with `Retry-After` past its thresholds. Take them from a load
  test. As a default, 10-30% event loop utilization is normal and about 70% is saturated
  (`node-event-loop`), so a limit near 1.0 sheds only after latency has already collapsed. Plan
  capacity so peak load stays well below the limit.
- Its hook runs on **every route, health probes included**. A liveness probe that gets 503 under load
  makes the platform restart a busy instance and worsens the overload. Exempt it (see below).
- A `healthCheck` that fails puts the whole service under pressure. Do not tie it to Redis: losing a
  cache must not turn into a total outage.
- Keep the 503 intact through the error handler (`node-http-server`).
- A read whose staleness is acceptable can answer from its last good result instead of 503: recipe 6
  in [references/recipes.md](references/recipes.md).
- Bound concurrent work per process: wrpc `queue: { concurrency, size, timeout }` for procedures, a
  semaphore with a bounded queue for the rest (`js-async-concurrency`). Overflow answers 503 at once.
- Every request has a deadline: `handlerTimeout` and `request.signal` on routes without a body,
  `AbortSignal.timeout` on routes with one, where `handlerTimeout` does not fire (`node-event-loop`).
- Respect stream back-pressure (`node-streams`), never grow an unbounded in-memory queue, and cap
  `server.maxConnections` when memory per connection is significant.

### Health checks

- Liveness answers from memory only. A failing liveness probe restarts the process, so never include
  dependencies.
- Readiness means "send me traffic": initialized, not draining, not overloaded, critical dependencies
  reachable (a cached result, not a query per probe).
- On SIGTERM: mark not ready, wait until the balancer notices, `fastify.close()`, exit before the
  platform kill timeout (`node-graceful-shutdown`).

### Zero-downtime restarts

- Rolling: start the replacement, wait until it is ready, then stop the old one, with a kill timeout.
- BullMQ: `await worker.close()` waits for active jobs. A job cut off by the kill timeout stalls and
  runs again, which is why handlers are idempotent.
- wrpc: `drain` lets calls finish and sends peers 1001, and clients reconnect with backoff and jitter
  so they do not stampede.
- Respawn crashed workers with a delay and alert on crash loops. No scheduled restarts to hide leaks.

## Patterns

### Load shedding with exempt probes

```ts
import underPressure from '@fastify/under-pressure';
import fp from 'fastify-plugin';

export default fp(
  async (fastify) => {
    const { MAX_LOOP_DELAY_MS, MAX_LOOP_UTILIZATION, MAX_RSS_BYTES } = fastify.config;
    await fastify.register(underPressure, {
      maxEventLoopDelay: MAX_LOOP_DELAY_MS,
      maxEventLoopUtilization: MAX_LOOP_UTILIZATION,
      maxRssBytes: MAX_RSS_BYTES,
      retryAfter: 5,
    });
  },
  { name: 'under-pressure', dependencies: ['config'] },
);
```

```ts
import type { FastifyInstance } from 'fastify';

// A pressure handler that returns nothing lets the request through.
const skipShedding = () => undefined;

const healthRoutes = async (fastify: FastifyInstance) => {
  const config = { pressureHandler: skipShedding };

  fastify.get('/health/live', { config }, async () => ({ status: 'ok' }));

  fastify.get('/health/ready', { config }, async (request, reply) => {
    const isReady = !fastify.lifecycle.isDraining && !fastify.isUnderPressure();
    reply.code(isReady ? 200 : 503);
    return { status: isReady ? 'ready' : 'not-ready' };
  });
};

export default healthRoutes;
```

`fastify.lifecycle` is a declared decorator whose `isDraining` flips on SIGTERM. Verified: under
pressure, a business route and the plugin's `/status` answer 503 with `Retry-After`, while
`/health/live` stays 200 and `/health/ready` reports 503.

### Client-side balancing with an ownership check

```js
const endpointsFor = (userId) => {
  const first = hashString(userId) % ENDPOINTS.length;
  return ENDPOINTS.slice(first).concat(ENDPOINTS.slice(0, first));
};

const connect = async (userId) => {
  const endpoints = await getEndpoints(userId);
  for (const endpoint of endpoints) {
    const connection = await tryConnect(endpoint);
    if (connection) return connection;
  }
  throw new Error('No endpoint available');
};
```

A worker that is not the owner answers 421 unless membership marks the owner as down, so nobody can
pile all users onto one worker.

## Anti-patterns

- Adding instances before removing blocking code and measuring.
- `cluster` inside a one-CPU container, or dozens of workers behind one primary.
- In-memory sessions, caches or rooms behind a round-robin balancer with no shared store.
- Treating Redis as a source of truth, or crashing when it is empty.
- BullMQ on the cache Redis: eviction silently loses jobs.
- Job handlers that are not idempotent, or queues with no retention.
- A liveness route under `@fastify/under-pressure`, or a `healthCheck` that depends on a cache.
- An error handler that turns the 503 of load shedding into 500.
- IP-hash stickiness behind NAT, a CDN or a reverse proxy.
- Platform restarts used as error handling, or cron restarts to mask leaks.
- Health checks that query the database on every probe.
- Unbounded queues or `Promise.all` over user-controlled input.
- `os.cpus().length` workers inside a CPU-limited container.
- Many tiny one-core containers for a constant heavy load, each paying the runtime overhead.
- A balancer hop for every message of a long-lived connection when clients could connect directly.
- Chained HTTP calls between services without timeouts or idempotency.
- Killing old processes before replacements are ready.

## Checklist

- [ ] Target load is written down: connections, RPS, p99, peak vs average, growth.
- [ ] Hot path has no blocking calls; a load test recorded event loop delay, RSS and p99.
- [ ] Topology comes from the decision guide; an app runs one process per container.
- [ ] Every kind of state has a home; sessions survive switching instances.
- [ ] Redis is not a source of truth, a cold Redis works, and each feature has a failure mode.
- [ ] Cache and jobs use separate Redis instances; the jobs one is `noeviction`.
- [ ] Jobs are idempotent, with attempts, backoff and retention.
- [ ] wrpc: shared session store, backplane, stable `instanceId`, `healthy` in readiness.
- [ ] Shedding thresholds come from a load test; 503 survives the error handler.
- [ ] Liveness is exempt from shedding; readiness turns off on overload and on SIGTERM.
- [ ] Every request and downstream call has a deadline.
- [ ] Deploys are rolling, with a kill timeout and a crash respawn delay.
- [ ] No component was added without a measured reason.

Related skills: `node-http-server`, `node-graceful-shutdown`, `node-event-loop`,
`node-multithreading`, `node-websocket-realtime`, `node-data-access`, `node-streams`,
`js-async-concurrency`, `alexis-libraries`.
