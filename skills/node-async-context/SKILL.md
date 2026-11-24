---
name: node-async-context
description: Request context in Node.js with Fastify request ids, explicit actors and AsyncLocalStorage. Use for correlation, audit fields or lost context
---

# Async Context and Request Isolation

With this skill the agent keeps per-request data (request id, actor, tenant,
transaction, abort signal) correct across async boundaries. It logs through
`request.log`, passes an explicit context through services, and uses
`AsyncLocalStorage` (ALS) only for cross-cutting concerns (logging, tracing, DB
adapters) where changing signatures is impractical. It fixes every place where
the context is lost, and never lets one request's data leak into another.

## Decision guide

| Need                                                              | Use                                                                           |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Log with the request id in a Fastify route or hook                | `request.log`, a child logger bound to `request.id`                           |
| Correlate one request across services                             | `request.id` from a validated `x-request-id`, forwarded on outgoing calls     |
| Who performed a write (`createdBy`, `updatedBy`, audit)           | Explicit actor in the service context, passed to the repository               |
| Domain/application functions need user, permissions, repositories | Explicit `context` argument or constructor injection                          |
| Logger/tracer/DB adapter needs the request id deep in the stack   | ALS, read at the edge (logger, adapter)                                       |
| A userland queue, pool, batcher or scheduler runs callbacks later | `AsyncResource.bind(fn)` / `AsyncLocalStorage.snapshot()` at enqueue time     |
| An emitter created per request but emitted elsewhere              | `EventEmitterAsyncResource`, or bind its listeners                            |
| Work crosses into a worker thread, process, job or service        | Serialize ids into the message or headers, then `run()` again on the receiver |
| Low-level resource lifecycle tracing                              | Do not do it in app code: `async_hooks.createHook` is legacy                  |

Where the profiles differ:

- **Library:** there is no request and no framework. Take context as an
  argument, never read or export a global store. If the library queues
  callbacks, bind them with `AsyncResource.bind` so the caller's ALS survives.
- **App:** Fastify gives every request an id and a child logger. Services get
  an explicit context from the Presentation layer. ALS stays in Infrastructure.

Defaults, and why:

- Application code gets its context explicitly, for transparency, testability
  and speed.
- ALS is the right tool where a signature should not change: log correlation,
  tracing, debugging, adapters that many call sites share.
- Avoid `createHook` and the old `domain` module: low level and fragile.
- One long-lived process serves many concurrent request contexts. Isolating
  them from each other (errors, leaks, data) is the application's job. Do not
  push it onto a process per request.

## Rules

Request id and logging (App)

- Log with `request.log` inside routes and hooks. A logger from `fastify.log`
  has no request id, so a service or repository that holds it loses
  correlation. Pass `request.log` in the service context, or add the id with
  a Pino `mixin` (pattern below).
- Fastify's default id is `req-1`, `req-2`: a per-process counter that repeats
  across replicas and restarts. Set `genReqId` to accept a validated
  `x-request-id` or generate a UUID. `requestIdHeader` alone trusts the header
  as sent.
- Forward the id on outgoing calls (`x-request-id`, W3C `traceparent`) and in
  job payloads.

Actor context (App)

- The actor is an input of the service, not ambient state. The Presentation
  layer or the job entry point builds it, and the service passes it to the
  repository, which stamps `createdBy` and `updatedBy`.
- User-initiated writes store the user's `cuid`, never the `_id`. System writes
  (job, scheduler, migration, webhook) store `sys:${type}:${name}`, built only
  by one `systemActor(type, name)` helper over `as const` objects. Both follow
  auth8 ADR-017, section 3.
- `createdAt` and `createdBy` never change after insert. Callers never supply
  the stamped fields, and the actor never comes from the request body.
- Do not read the actor from ALS: an audit field must not depend on whether a
  callback kept its context, and a test should see it as an argument.

Store design and scope

- Create one ALS instance per concern at module level (`requestContext`,
  `tracing`). Never create one per request. Export small accessors
  (`getContext()`, `runWithContext()`), not the raw instance, so the store can
  be swapped or mocked.
- Enter the context only at entry points: an HTTP request, WebSocket message,
  queue job, cron tick or CLI command. Use `als.run(store, fn)` there and keep
  everything downstream inside `fn`.
- Never use `enterWith()` in application code. It switches the context for
  the rest of the current synchronous execution and the continuations that
  follow it (verified), so it leaks into callers. Tests may use it.
- Keep the store small and immutable:
  `Object.freeze({ requestId, tenantId, signal })`. In sloppy CommonJS a write
  to a frozen object is silently ignored, in ESM it throws. To add data later
  (after authentication, for example), run a nested scope with a derived copy,
  `als.run({ ...context, tenantId }, next)`, instead of mutating the shared
  object. Values that must be mutable (a transaction handle, timings) go in
  explicitly named fields.
- Always handle a missing store. `getStore()` returns `undefined` outside
  `run()` (at startup, in timers created at startup, in listeners emitted from
  elsewhere). Fall back (`requestId: null`) or throw a clear error when the
  context is mandatory. On Node 24, `new AsyncLocalStorage({ defaultValue })`
  is also available (Node 22 silently ignores the option).

Where to read it

- Read ALS in infrastructure (logger, tracer, DB/HTTP client wrappers),
  not in domain logic. Domain functions take explicit arguments, which keeps
  them testable and transport-agnostic.
- Do not use ALS as a service locator or DI container for business
  dependencies. Hidden inputs make functions impure and hard to test. Inject
  dependencies through a constructor, a closure or a context object.

Propagation (verified on Node 24; the full matrix, API cheat sheet and
benchmarks are in [references/propagation.md](references/propagation.md))

- Propagates automatically through `await` and promise chains, `setTimeout`,
  `setInterval`, `setImmediate`, `process.nextTick`, `queueMicrotask`, and
  core async I/O callbacks started inside the scope.
- Does **not** follow listeners: `EventEmitter` and stream listeners
  (`req.on('data' | 'end')`, `socket.on`) run in the context of whoever calls
  `emit()`, not the one that registered them. Fastify rebinds its body parser,
  so a store entered in `onRequest` survives parsing. A hand-written parser
  over raw `req` events does not.
- Does **not** survive userland callback queues: pools, batchers, schedulers
  and connection libraries that store callbacks and invoke them later run
  them in the drainer's context. Promise-based queues (where `await` resumes)
  keep the awaiting context.
- Is captured at creation by anything long-lived that owns I/O or timers. A
  connection pool, socket or interval created lazily inside the first
  request keeps that request's context forever (verified; a plain
  `EventEmitter` captures nothing, its listeners see the `emit()` caller).
  Create singletons at startup, outside any `run()`, or wrap their creation
  in `als.exit(() => ...)`.
- Does not cross threads or processes. Pass `{ requestId, traceparent, actorId }`
  in the message and call `run()` again in the worker. The same applies to
  queues and HTTP calls between services.

Fixing propagation

- Bind a callback at the moment you accept it:
  `queue.push(AsyncResource.bind(callback))`, or
  `const restore = AsyncLocalStorage.snapshot()` and later
  `restore(callback)`.
- For a class that represents an async operation (batcher, collector,
  request in a custom pool), extend `AsyncResource` or keep a
  `new AsyncResource('Name')` per operation. Invoke callbacks with
  `resource.runInAsyncScope(fn, thisArg, ...args)` and call `emitDestroy()`
  when done.
- For emitters created per request: use `EventEmitterAsyncResource` from
  `node:events` (listeners run in the creation context), or bind individual
  listeners with `AsyncResource.bind`.

Performance

- Node 24 implements ALS with `AsyncContextFrame` by default. A micro-
  benchmark of one million tiny async calls measured about 1.5–1.9x slower
  than passing an argument (roughly 480 ms vs 250–310 ms). Code with real I/O
  barely notices.
- Avoid `--no-async-context-frame`: the legacy implementation enables promise
  hooks, which slows every promise in the process, not just ALS users.
- In hot inner loops (parsers, per-item processing), read the store once and
  pass values down as arguments.

Isolation

- Keep request state out of module scope, which every concurrent request
  shares. Module scope holds only immutable config and shared clients, created
  once at startup.
- Choose an isolation level per granularity. From cheapest to strongest:
  objects/closures, `vm` contexts (trusted code only, not a security
  boundary), worker threads, processes, containers, VMs.
- By default do not build interactive or high-load services on FaaS. For the
  reasons, and for writing handlers when you must, see
  [references/isolation-faas.md](references/isolation-faas.md).

## Patterns

### Request id and ALS in Fastify

```js
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fp from 'fastify-plugin';

const SAFE_REQUEST_ID = /^[\w-]{8,64}$/;
const requestContext = new AsyncLocalStorage();

const getContext = () => requestContext.getStore() ?? null;

const genReqId = (rawRequest) => {
  const header = rawRequest.headers['x-request-id'];
  const isSafe = typeof header === 'string' && SAFE_REQUEST_ID.test(header);
  return isSafe ? header : randomUUID();
};

const mixin = (mergeObject, level, logger) => {
  const context = getContext();
  if (context === null || logger.bindings().reqId !== undefined) return {};
  return { reqId: context.requestId };
};

const requestContextPlugin = async (fastify) => {
  fastify.addHook('onRequest', (request, reply, done) => {
    const store = Object.freeze({ requestId: request.id });
    requestContext.run(store, done);
  });
};

const contextPlugin = fp(requestContextPlugin, { name: 'request-context' });

export { genReqId, getContext, mixin, contextPlugin };
```

```js
const loggerInstance = pino({ mixin });
const app = Fastify({ loggerInstance, genReqId });
await app.register(contextPlugin);
```

- The hook takes `done` and is not `async`: an async hook returns before the
  rest of the lifecycle, so nothing downstream sees the store (verified).
- `fastify-plugin` removes encapsulation, so the hook applies to every route.
- With the `mixin`, a repository that holds `fastify.log` logs the same `reqId`
  as `request.log`. The bindings check stops `request.log` lines from getting
  the key twice.

### Explicit actor through a service

```ts
const ActorType = { Job: 'job', Scheduler: 'scheduler', Migration: 'migration' } as const;
type ActorType = (typeof ActorType)[keyof typeof ActorType];

const systemActor = (type: ActorType, name: string): string => `sys:${type}:${name}`;

type Logger = { info: (data: object, message: string) => void };
type ServiceContext = Readonly<{ actorId: string; log: Logger }>;
type UsersRepository = {
  setBlocked: (id: string, blocked: boolean, actorId?: string) => Promise<number>;
};

const blockUser = async (context: ServiceContext, users: UsersRepository, userId: string) => {
  const { actorId, log } = context;
  const updated = await users.setBlocked(userId, true, actorId);
  log.info({ userId, updated }, 'user blocked');
  return updated > 0;
};
```

```ts
// Presentation: the actor comes from the authenticated request
fastify.post('/users/:id/block', async (request) => {
  const context = { actorId: request.user.id, log: request.log };
  return { blocked: await blockUser(context, users, request.params.id) };
});

// Job: the actor is a system actor
const actorId = systemActor(ActorType.Job, 'session-cleanup');
const log = logger.child({ jobId: job.id });
await blockUser({ actorId, log }, users, job.data.userId);
```

The same service runs over HTTP, WebSocket or a queue, and a test passes a
fake context. Other shapes are a closure (partial application) and constructor
injection. The plain `node:http` form is in
[references/propagation.md](references/propagation.md).

### Keep context through a callback-based queue or pool

For a one-off callback, `queue.push(AsyncResource.bind(callback))` is enough.
A batcher that flushes many callers at once keeps one `AsyncResource` per item
and calls `resource.runInAsyncScope(callback, null, null, result)`: a tested
`Batcher` is in [references/propagation.md](references/propagation.md).

### EventEmitter listeners

```js
const { EventEmitterAsyncResource } = require('node:events');

const job = new EventEmitterAsyncResource({ name: 'ImportJob' });
job.on('progress', (percent) => log(`progress ${percent}`));
// job.emit() from any context: listeners see the creation context
// call job.emitDestroy() when the job is finished
```

For an existing emitter, bind the listener at registration with
`emitter.on('done', AsyncResource.bind(onDone))`.

### Crossing a thread boundary

```js
const pending = new Map();
let nextId = 0;

const call = (worker, method, args) => {
  const { requestId } = getContext() ?? {};
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, method, args, context: { requestId } });
  });
};

// worker
parentPort.on('message', ({ id, method, args, context }) => {
  requestContext.run(context, async () => {
    try {
      const result = await methods[method](...args);
      parentPort.postMessage({ id, result });
    } catch (error) {
      parentPort.postMessage({ id, error });
    }
  });
});
```

Timeouts and the reply handler are in `node-multithreading`.

## Anti-patterns

- **Module-level `let currentUser` / `currentRequest`.** Concurrent requests
  overwrite each other. Use an explicit context or ALS.
- **`fastify.log` in request code.** The line has no request id. Use
  `request.log`, or the `mixin` above for shared infrastructure.
- **An actor taken from the body, or from ALS, for audit fields.** Build it
  from the authenticated request or the job, and pass it explicitly.
- **`new AsyncLocalStorage()` inside a request handler.** It leaks and never
  propagates. Create one module-level instance.
- **`als.enterWith(context)` in a hook.** Context bleeds into the caller's
  continuation. Use `run(context, done)`.
- **Mutating the shared store** (`getStore().user = user`) across awaits. A
  parallel branch sees half-updated data. Run a nested scope with a derived
  frozen copy.
- **Lazily creating a pool, socket or timer inside the first request.** It
  keeps that request's context and objects alive. Create it at startup or in
  `als.exit()`.
- **Assuming listeners inherit the registration context.** Bind listeners or
  use `EventEmitterAsyncResource`.
- **Expecting ALS in workers or child processes.** Serialize ids explicitly.
- **ALS as hidden DI for business logic** (`getStore().db.find(...)` inside
  domain code). Pass dependencies explicitly.
- **`async_hooks.createHook` with `console.log` inside**, which recurses
  forever. Avoid hooks; for diagnostics write with `fs.writeSync(1, text)`.
- **Storing `req`, `reply`, sockets or large buffers in the store.** It retains
  memory until the last async resource of the request ends. Store ids and
  small values.

## Checklist

- [ ] Route and hook logs use `request.log`; `genReqId` validates `x-request-id`.
- [ ] Every write passes an explicit actor: a user `cuid` or `sys:${type}:${name}`.
- [ ] One module-level ALS instance per concern; accessors exported; no `enterWith`.
- [ ] `run()` happens only at entry points (request, message, job, tick), in a `done`-style hook.
- [ ] The store is small and frozen; additions go through nested `run()` with a derived copy.
- [ ] Every `getStore()` call handles `undefined`.
- [ ] Domain functions take explicit arguments; ALS is read only in logger, tracer and adapters.
- [ ] Callback queues, pools and batchers bind callbacks (`AsyncResource.bind`, `snapshot`, `runInAsyncScope`).
- [ ] Per-request emitters use `EventEmitterAsyncResource` or bound listeners.
- [ ] Singletons (pools, timers, caches) are created at startup, outside request scope.
- [ ] Thread, process, job and service hops carry `requestId`/`traceparent` explicitly.
- [ ] No `createHook`, no `domain`, no `--no-async-context-frame`.

Related skills: `node-multithreading`, `node-layered-architecture`,
`node-architecture-styles`, `node-security`, `error-handling`,
`node-performance-profiling`
