# Presentation adapters and incremental retrofit

The module from [example-app.md](example-app.md) exposes a service that takes
plain data and throws errors with a `code`. An adapter translates a protocol into
that call and back. Fastify is the HTTP adapter; a BullMQ worker, a wRPC
procedure and a CLI command are others over the same service. Each adapter
lives in the `presentation/` folder of its module.

Rules for every adapter:

- Read input once, build plain arguments, call the use case, write the result.
  Nothing else.
- Do not pass `request`, `reply`, a socket, a job or a framework instance past
  the adapter, not even "just for headers".
- Map errors in one place, log only unexpected ones, never send stack traces to
  clients.
- Every entry point declares who may call it, and an undeclared one is refused.
- Generic plugins (body limit, CORS, compression, rate limit, security headers)
  may stay in the framework. Domain logic and data loading may not.

## Fastify

Routes are the controllers. The plugin order is what makes the guard reliable:

```ts
await app.register(validation); // the metaschema validator compiler
await app.register(errors); // one setErrorHandler
await app.register(access, { sessions }); // onRoute and onRequest
await app.register(accounts, deps); // a module: its facade, and routes that declare config.access
```

- `onRoute` only sees routes added after it. The `onRequest` guard still covers
  an earlier route: it finds no `access` and refuses.
- The implicit `HEAD` route of a `GET` carries the same `config`, so it is
  guarded too.
- A 404 has no route config, so the guard skips it through `request.is404`.
- A compiler, an error handler and hooks are per encapsulation context: register
  them through `fastify-plugin`.
- A third-party plugin that adds routes (Swagger UI) has no option for
  `config.access`, so the guard stops the boot. Declare it in an `onRoute` hook
  added before the guard, for that prefix only:

```ts
app.addHook('onRoute', (route) => {
  if (route.url !== '/docs' && !route.url.startsWith('/docs/')) return;
  route.config = { ...route.config, access: 'public' };
});
await app.register(access, { sessions });
await app.register(swagger);
await app.register(swaggerUi, { routePrefix: '/docs' });
```

Decide on purpose whether the docs of an API are public in production.

Reading a declared decorator:

```ts
fastify.get('/me/sessions', { config: { access: 'session' } }, async (request) => {
  const { session } = request;
  return fastify.sessions.list({ accountId: session!.accountId });
});
```

## One dispatcher for transports without Fastify hooks

A queue worker or a CLI calls the module through one dispatcher with the same
access decision as the guard. A `@alexify/wrpc` procedure already has it:
`access` defaults to `'session'`, and any value but `'public'` or `'session'`
throws.

```ts
// shared/app/dispatcher.ts
export const createDispatcher = ({ endpoints, sessions }: DispatcherDeps) => {
  for (const name of endpoints.keys()) {
    const { access } = endpoints.get(name)!;
    if (!isDeclared(access)) throw new Error(`${name}: access is not declared`);
  }

  const call = async ({ name, args = {}, token = '', requestId }: Call) => {
    const endpoint = endpoints.get(name);
    if (!endpoint) throw new DomainError('Not found', 'ENOTFOUND');
    const session = token ? await sessions.restore(token) : null;
    if (!isAllowed(endpoint.access, session)) {
      throw new DomainError('Forbidden', 'EFORBIDDEN');
    }
    const { valid, value } = endpoint.schema.parse(args, { unknown: 'reject' });
    if (!valid) throw new DomainError('Invalid arguments', 'EVALIDATION');
    const context = Object.freeze({ requestId, session });
    return endpoint.method(value, context);
  };

  return Object.freeze({ call });
};
```

`Object.freeze` is shallow, so the session store freezes the session too. A
write to a frozen object throws only in strict code (ESM, TypeScript). In a
CommonJS module without `'use strict'` it is ignored silently: never base an
access decision on that throw, and in tests assert the value is unchanged.

## BullMQ worker

A worker is Presentation too: the job is its transport object. It validates the
payload, because a queue is a process boundary, and calls the same use case.

```ts
import { Worker } from 'bullmq';

export const createExpireSessionsWorker = ({ connection, expireSessions, logger }: WorkerDeps) => {
  const processor = async (job: { id?: string; data: unknown }) => {
    const { valid, value } = ExpireSessions.parse(job.data, { unknown: 'reject' });
    if (!valid) throw new Error(`Invalid payload in job ${job.id}`);
    return expireSessions(value);
  };
  const worker = new Worker('expire-sessions', processor, { connection });
  worker.on('failed', (job, error) => logger.error({ err: error, jobId: job?.id }, 'job failed'));
  return worker;
};
```

Whoever creates the worker closes it (`await worker.close()`) on shutdown
(`node-graceful-shutdown`). Jobs are retried, so the use case must be idempotent.

## wRPC procedure

For realtime. A procedure declares `access`: the default is `'session'`, and any
value other than `'public'` or `'session'` throws when the router is defined.

```js
const { defineRouter, procedure } = require('@alexify/wrpc');

const createRouter = ({ auth }) =>
  defineRouter({
    auth: {
      signIn: procedure({
        access: 'public',
        handler: async (context, { login, password }) => auth.signIn({ login, password }),
      }),
    },
  });
```

The procedure is an adapter too: it reads its arguments, calls the same use case
and returns the result. Sessions, rooms and subscriptions are in
`node-websocket-realtime`.

## CLI

```ts
import { parseArgs } from 'node:util';

export const runBlockAccount = async (argv: string[], { blockAccount }: CliDeps) => {
  const { values } = parseArgs({ args: argv, options: { login: { type: 'string' } } });
  if (!values.login) throw new Error('--login is required');
  return blockAccount({ login: values.login, actorId: 'sys:cli:block-account' });
};
```

The actor string follows the `sys:${actorType}:${actorName}` audit format.

## Retrofit an existing app step by step

Each step is shippable, so run the tests after each one.

1. Install the guard and declare `access` on every route. Nothing stays open by
   omission.
2. Freeze the hook stack: no new hook that writes undeclared fields on `request`.
   Generic plugins are fine.
3. Give each business context a `modules/<name>/` folder with an `index.ts`
   plugin, and move its routes and service there unchanged
   ([modules.md](modules.md)).
4. Pick one route. Move its body into the service or a use case that takes plain
   data and returns plain data. The handler becomes: read input, call, return.
   Read decorators exactly once, here.
5. Replace imports of db, config and logger inside that module with factory
   parameters. Create the instances in the module's `index.ts`.
6. Move driver calls into a repository with a small interface (`findByLogin`,
   `save`). The interface belongs to `domain/`, the implementation to `infra/`.
   The use case talks to the interface.
7. Move the rules into the aggregate, so the use case only orchestrates.
8. Introduce domain errors with codes and one `setErrorHandler`. Remove
   `reply.code(...)` and `httpErrors` from non-adapter code.
9. Repeat for other routes.
10. Test services directly with fakes, and keep one `inject` test per adapter.
11. A second transport (queue worker, wRPC, CLI) is now a new adapter file.

Signals that a step is not finished: a function outside Presentation has a
parameter named `request` or `reply`; a use case imports `fastify`, `mongodb`,
config or a logger package; a test needs an HTTP server to check a business rule.

## Adapter test

Every adapter passes a behavioural test of its own protocol mapping. For Fastify,
`inject` runs the whole plugin tree without a port:

```ts
it('should map domain errors to statuses', async () => {
  // Arrange
  const app = await buildApp(createDeps());
  const payload = { login: 'marcus', password: '12345678' };
  await app.inject({ method: 'POST', url: '/accounts', payload });
  // Act
  const duplicate = await app.inject({ method: 'POST', url: '/accounts', payload });
  const invalid = await app.inject({ method: 'POST', url: '/accounts', payload: { login: 'x' } });
  const anonymous = await app.inject({ url: '/accounts/me' });
  // Assert
  expect([duplicate.statusCode, invalid.statusCode, anonymous.statusCode]).toEqual([409, 400, 403]);
  await app.close();
});
```
