# Presentation adapters and incremental retrofit

The application from [example-app.md](example-app.md) exposes use cases that take
plain data and throw errors with a `code`. An adapter translates a protocol into
that call and back. Fastify is the HTTP adapter; a BullMQ worker, a wRPC
procedure and a CLI command are others over the same use cases.

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
await app.register(auth, deps); // decorates the use cases
await app.register(authRoutes); // every route declares config.access
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
3. Pick one route. Move its body into a use case that takes plain data and
   returns plain data. The handler becomes: read input, call, return. Read
   decorators exactly once, here.
4. Replace imports of db, config and logger inside that module with factory
   parameters. Create the instances in a named `fastify-plugin`.
5. Move driver calls into a repository with a small interface (`findByLogin`,
   `save`). The interface belongs to Domain, the implementation to
   Infrastructure. The use case talks to the interface.
6. Move the rules into the aggregate, so the use case only orchestrates.
7. Introduce domain errors with codes and one `setErrorHandler`. Remove
   `reply.code(...)` and `httpErrors` from non-adapter code.
8. Repeat for other routes.
9. Test use cases directly with fakes, and keep one `inject` test per adapter.
10. A second transport (queue worker, wRPC, CLI) is now a new adapter file.

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
  const anonymous = await app.inject({ url: '/me' });
  // Assert
  expect([duplicate.statusCode, invalid.statusCode, anonymous.statusCode]).toEqual([409, 400, 403]);
  await app.close();
});
```
