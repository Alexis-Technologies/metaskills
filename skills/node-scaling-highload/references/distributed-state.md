# Distributed state: sessions, caches, replicas, queues

Scaling past one process turns every in-memory structure into a question: who else needs it, and what
happens when the process dies or the client lands elsewhere? Decide per kind of state.

| State | Home in auth8 | Routing need |
| --- | --- | --- |
| Session, refresh and rotation state | Redis with a TTL, short local cache | none |
| Rate-limit and brute-force counters | Redis | none |
| OTP, magic links, verification codes | Redis with a TTL | none |
| Permissions, policy and config lookups | `cacheable`: L1 memory, L2 Redis | none |
| WebSocket connection, subscriptions | the process holding the socket | none with a wrpc backplane |
| Room, document or match state | owner process plus persistence | route all members to the owner |
| Business data | MongoDB primary (Atlas) | none, but mind replica lag |
| Background jobs | BullMQ on its own Redis | none, consumers idempotent |

## Two Redis instances

| | Cache and secondary storage | Jobs |
| --- | --- | --- |
| Variables | `REDIS_CACHE_*` | `REDIS_JOBS_URL`, `REDIS_JOBS_*` |
| Eviction | `allkeys-lru` | **`noeviction`**, required by BullMQ |
| Losing data | Tolerated, falls back to MongoDB | Not tolerated, durable persistence |
| Clients | `ioredis`, `keyv`, `cacheable`, `qified` | BullMQ over `ioredis` |

The two connections are never shared or interchanged. On an eviction policy other than `noeviction`
BullMQ only logs a warning, then loses jobs under memory pressure.

Valkey is protocol-compatible, and auth8 reaches it through `@keyv/valkey`. Hosting is managed Redis
Cloud today.

## Cache layer

auth8 builds its cache in `packages/node/src/cache`:

```ts
const primary = new Keyv({ store: new KeyvCacheableMemory({ lruSize }), ttl });
const secondary = new Keyv({ store: new KeyvValKey(redis), ttl });
const cache = new Cache({ primary, secondary, ttl, namespace, sync: { qified } });
```

- `Cache` extends `Cacheable`: L1 in memory, L2 in Redis. `sync: { qified }` invalidates L1 on other
  instances.
- Domain and Application code see a cache **port**, never Redis.
- Prefer caching immutable or versioned data (the key holds a version), so invalidation is not needed.
- Protect the source from stampedes: cache the in-flight promise for a key, so concurrent misses wait
  for one load.
- Bound every cache (LRU) and count memory per process times process count.

## Session cache in front of a shared store

Verified: process B sees a session written by process A. After A deletes it, B serves its local copy
until the local TTL expires or it is invalidated, which is why the local TTL must be short and logout
must broadcast an invalidation. A retried idempotent command runs once, and two concurrent calls with
one key run the operation once.

```js
// Shared store contract: get, set with TTL, setIfAbsent, delete (Redis, a MongoDB collection, ...)
const createMemoryStore = () => {
  const data = new Map();

  const read = (key) => {
    const entry = data.get(key);
    return entry && entry.expires >= Date.now() ? entry : null;
  };

  const write = (key, value, ttlMs) => {
    data.set(key, { value: structuredClone(value), expires: Date.now() + ttlMs });
  };

  return {
    get: async (key) => {
      const entry = read(key);
      return entry ? structuredClone(entry.value) : null;
    },
    set: async (key, value, ttlMs) => void write(key, value, ttlMs),
    setIfAbsent: async (key, value, ttlMs) => {
      if (read(key)) return false;
      write(key, value, ttlMs);
      return true;
    },
    delete: async (key) => void data.delete(key),
  };
};

// Per-process read-through cache in front of the shared store
const createSessionCache = (store, { ttlMs, localTtlMs }) => {
  const local = new Map();

  const get = async (tokenHash) => {
    const hit = local.get(tokenHash);
    if (hit && hit.expires > Date.now()) return hit.session;
    const session = await store.get(`session:${tokenHash}`);
    if (!session) return null;
    local.set(tokenHash, { session, expires: Date.now() + localTtlMs });
    return session;
  };

  const save = async (tokenHash, session) => {
    await store.set(`session:${tokenHash}`, session, ttlMs);
    local.set(tokenHash, { session, expires: Date.now() + localTtlMs });
  };

  const invalidate = (tokenHash) => void local.delete(tokenHash);

  const remove = async (tokenHash) => {
    await store.delete(`session:${tokenHash}`);
    invalidate(tokenHash);
  };

  return { get, save, remove, invalidate };
};

// Claim the key atomically, so two identical requests cannot both run the operation
const createIdempotent = (store, ttlMs) => async (key, operation) => {
  const isClaimed = await store.setIfAbsent(`idem:${key}`, { status: 'running' }, ttlMs);
  if (!isClaimed) {
    const entry = await store.get(`idem:${key}`);
    if (entry?.status === 'done') return entry.result;
    throw new Error('EINPROGRESS');
  }
  try {
    const result = await operation();
    await store.set(`idem:${key}`, { status: 'done', result }, ttlMs);
    return result;
  } catch (error) {
    await store.delete(`idem:${key}`);
    throw error;
  }
};
```

- The memory store stands in for Redis. `setIfAbsent` is `SET key value NX PX ttl`. In MongoDB use a
  unique index and handle the duplicate-key error.
- Key sessions by a hash of the token, not the raw token (`hashToken` in `node-crypto-auth`).
- Any token can be revoked on the server: revocation deletes the record and broadcasts invalidation.
- A session stored with the same TTL policy everywhere needs an explicit decision on what survives a
  restart and what may be evicted under memory pressure.

## Read replicas

- Writes go to one primary, reads may go to secondaries. Reads usually outnumber writes 5-100x.
- Replication lag is real: after a write, read the user's own data from the primary, or use a causally
  consistent session, to avoid "my change vanished".
- On primary failure the system can stay read-only until an election finishes. Accept a loss window
  only where the domain allows it (never credentials or money).

## Jobs with BullMQ

```ts
import { Queue, Worker } from 'bullmq';

const connection = { url: process.env.REDIS_JOBS_URL, maxRetriesPerRequest: null };

const RETRY = { attempts: 5, backoff: { type: 'exponential', delay: 1000 } };
const RETENTION = { removeOnComplete: { count: 1000 }, removeOnFail: { age: 7 * 24 * 3600 } };

const mailQueue = new Queue('mail', { connection, defaultJobOptions: { ...RETRY, ...RETENTION } });

const enqueueVerification = (userId: string, email: string) => {
  const jobId = `verify-email-${userId}`;
  return mailQueue.add('verify-email', { userId, email }, { jobId });
};

const worker = new Worker(
  'mail',
  async (job) => {
    await sendOnce(job.id, job.data);
  },
  { connection, concurrency: 10, limiter: { max: 50, duration: 1000 } },
);

worker.on('failed', (job, error) => log.error({ err: error, jobId: job?.id }, 'job failed'));
```

Run on the options only, since no Redis was available: `Worker` throws without
`maxRetriesPerRequest: null`, and `add` throws on a `jobId` with a `:` unless it has exactly three
parts, or on an integer `jobId`.

- `jobId` deduplicates while a job with that id exists, including a kept completed one. Retention
  therefore defines how long the same id is refused.
- Delivery is at-least-once: a stalled job runs again. `sendOnce` must be idempotent.
- Queue names and payload types live in shared infrastructure. Payloads come from the metaschema
  contract (`js-contracts-schemas`).
- Enqueueing sits behind an Application port, so a use case depends on a job scheduler, not on BullMQ.
- Shut down with `await worker.close()`, which waits for active jobs, and `await queue.close()`.
- Do not chain synchronous calls across services as a pseudo-transaction. Use a saga (each step has a
  compensation), or keep the invariant inside one aggregate and one transaction.

## In-memory first, persistence behind

Keeping the working set in memory (read-ahead on login, write-behind on change) is the highest-capacity
design, because no I/O beats async I/O. Doing it safely requires:

- an owner process per piece of state (affinity), so there is one writer;
- persistence that survives a crash for anything that matters (a journal, or a synchronous write for
  critical operations);
- restart and migration paths: a new process loads state before the old one hands over its users.

An append-only event log also allows rebuilding state after a failure.
