# Fastify wiring

The composition used by `auth8-api`: an entry point, shared plugins, encapsulated route plugins. All
code below was run on Node.js 24 with Fastify 5.8, `fastify-plugin` 6 and `@fastify/autoload` 6.

## Layout

```text
src/
  main.ts            options, autoload of plugins/, modules/ and routes/, error handler
  plugins/           shared: config, clients, auth, limits (fastify-plugin)
  modules/<name>/    one business context: index.ts, domain/, app/, infra/, presentation/
  routes/            routes outside the modules: health
```

The module layout is in `node-layered-architecture`.

## Entry point

`fastify start -o src/main.ts` (fastify-cli) reads the exported `options` and registers the default
export as a plugin.

```ts
import path from 'node:path';

import AutoLoad from '@fastify/autoload';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

const options = {
  bodyLimit: 256 * 1024,
  requestTimeout: 30_000,
  handlerTimeout: 10_000,
  keepAliveTimeout: 72_000,
  http: { headersTimeout: 10_000 },
  trustProxy: 1,
};

const main = async (fastify: FastifyInstance, opts: FastifyPluginOptions) => {
  const plugins = path.join(import.meta.dirname, 'plugins');
  const modules = path.join(import.meta.dirname, 'modules');
  const routes = path.join(import.meta.dirname, 'routes');
  const ignorePattern = /^tests$/;
  await fastify.register(AutoLoad, { dir: plugins, ignorePattern, options: { ...opts } });
  await fastify.register(AutoLoad, {
    dir: modules,
    maxDepth: 1,
    dirNameRoutePrefix: false,
    options: { ...opts },
  });
  await fastify.register(AutoLoad, { dir: routes, ignorePattern, options: { ...opts } });
};

export { options };
export default main;
```

- `plugins/` loads first, so modules and routes can read every decorator.
- Autoload imports every file it finds, tests too. `maxDepth: 1` loads only `modules/<name>/index.ts`,
  and `ignorePattern` keeps `tests/` out of the other folders.
- Inside one directory, autoload orders plugins by their `dependencies`.
- The error handler is set once, here or in its own plugin (`error-handling`).

## Shared plugin

```ts
// modules/orders/index.ts
import fp from 'fastify-plugin';

import { createOrderService, type OrderService } from './app/orders.service.ts';
import { orderRoutes } from './presentation/orders.routes.ts';

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
    await fastify.register(orderRoutes, { prefix: '/orders' });
  },
  { name: 'orders', dependencies: ['config', 'mongodb'] },
);
```

The module decorates its facade for the whole app and registers its routes in their own context.

A plugin whose dependency is missing fails at boot (`The dependency 'x' of plugin 'y' is not
registered`), not on the first request.

## Status from the response schema

Fastify answers 200 unless the handler sets a code, and a `response` schema does not change that.
Without the code no schema matches 200, so the body leaves unfiltered, extra fields included. This
plugin sets the status once, from the contract: a route that declares exactly one 2xx code answers
with it.

```ts
// plugins/status-from-schema.ts
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';

const SUCCESS_CODE = /^2\d\d$/;

// One declared 2xx code becomes the status. Several leave the choice to the handler.
const successCodeOf = (response: object): number => {
  let found = '';
  for (const code of Object.keys(response)) {
    if (!SUCCESS_CODE.test(code)) continue;
    if (found !== '') return 0;
    found = code;
  }
  return found === '' ? 0 : Number(found);
};

export default fp(
  async (fastify) => {
    fastify.addHook('onRoute', (routeOptions) => {
      const response = routeOptions.schema?.response;
      if (!response) return;
      const status = successCodeOf(response);
      if (status === 0 || status === 200) return;
      const setStatus = async (request: FastifyRequest, reply: FastifyReply) => {
        reply.code(status);
      };
      const handlers: preHandlerHookHandler[] = [];
      routeOptions.preHandler = handlers.concat(routeOptions.preHandler ?? [], setStatus);
    });
  },
  { name: 'status-from-schema' },
);
```

- The status comes from the schema, not from the method: a POST that signs in or cancels declares 200.
- It runs last among `preHandler` hooks, so a guard that answers 401 keeps its code.
- `reply.code()` in the handler still wins, and a route with several 2xx codes keeps the default 200.
- **Register it before the routes.** `onRoute` sees only routes added after it. A plugin in
  `plugins/` loads before the modules and `routes/`.
- **The error handler must always call `reply.code()`.** Otherwise an error body goes out with 201
  and the 201 schema: a loose schema let `201 {"error":{"code":"EINTERNAL"}}` through.

Checked on Fastify 5.8.5 and Node.js 24 with `tsc` 7 in strict mode: 201, 202 and 204 as declared, 200
for a 200 schema and for several 2xx codes, 401 from a guard, 400 on invalid input, 500 or the
error's 4xx when the handler throws, and 201 in an encapsulated route plugin.

## Authentication decorator

The decorator is a hook function, attached per route.

```ts
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: Authenticate;
  }
  interface FastifyRequest {
    user: { id: string } | null;
  }
}

export default fp(
  async (fastify) => {
    fastify.decorateRequest('user', null);

    const authenticate: Authenticate = async (request) => {
      const header = request.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const user = token === '' ? null : await fastify.tokens.resolve(token);
      if (user === null) throw fastify.httpErrors.unauthorized('Invalid or expired token');
      request.user = user;
    };

    fastify.decorate('authenticate', authenticate);
  },
  { name: 'authenticate', dependencies: ['sensible', 'tokens'] },
);
```

`tokens.resolve` checks the server-side record, so a revoked token stops working at once.

## Route plugin

No `fastify-plugin` here: hooks added inside stay inside. The module registers it under `/orders`.

```ts
// modules/orders/presentation/orders.routes.ts
import type { FastifyInstance } from 'fastify';

import { CreateOrderBody, OrderReply } from './orders.schemas.ts';

export const orderRoutes = async (fastify: FastifyInstance) => {
  fastify.addHook('onRequest', fastify.authenticate);

  const schema = { body: CreateOrderBody, response: { 201: OrderReply } };

  fastify.post('/', { schema, bodyLimit: 16_384 }, async (request) =>
    fastify.orders.create(request.user!.id, request.body),
  );

  fastify.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return fastify.orders.get(id, { signal: request.signal });
  });
};
```

`CreateOrderBody` and `OrderReply` come from the metaschema contract through the chain described in
`js-contracts-schemas`.

## Lifecycle

| Phase              | Runs                       | Typical use                                         |
| ------------------ | -------------------------- | --------------------------------------------------- |
| `onRequest`        | Before the body is read    | Authentication from headers, rate limit, shedding   |
| `preParsing`       | Before parsing             | Decode or meter the raw stream                      |
| `preValidation`    | After parsing              | Normalize input before the schema runs              |
| `preHandler`       | After validation           | Checks that need the parsed body                    |
| handler            |                            | Call an Application service                         |
| `preSerialization` | Before serializing         | Reshape an object payload                           |
| `onSend`           | Before writing             | Headers that depend on the payload                  |
| `onResponse`       | After the response is sent | Metrics                                             |
| `onError`          | On an error, before `onSend` | Logging only, cannot change the reply             |
| `onTimeout`        | On a socket timeout        | Metrics                                             |
| `preClose`         | First step of `close()`    | Close WebSockets and other upgraded connections     |
| `onClose`          | Last step of `close()`     | Close clients and pools                             |

## Testing

`inject` runs the whole lifecycle without a socket. Build the app in a function and pass fakes.

```ts
// modules/orders/presentation/tests/orders.routes.test.ts
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { orderRoutes } from '../orders.routes.ts';

describe('POST /orders', () => {
  it('should answer 413 when the body exceeds the route limit', async () => {
    const app = Fastify();
    app.decorate('authenticate', async () => {});
    app.decorate('orders', { create: async () => ({ id: '1' }) });
    await app.register(orderRoutes, { prefix: '/orders' });

    const payload = { note: 'x'.repeat(20_000) };
    const response = await app.inject({ method: 'POST', url: '/orders', payload });

    expect(response.statusCode).toBe(413);
    await app.close();
  });
});
```

## wrpc inside Fastify

Mount `wrpcFastify` from `@alexify/wrpc/fastify` as a plugin: HTTP calls then pass through the hooks
and the error handling of the app, and `fastify.close()` closes it. Its options are in
`alexis-libraries`.
