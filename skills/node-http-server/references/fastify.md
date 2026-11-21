# Fastify wiring

The composition used by `auth8-api`: an entry point, shared plugins, encapsulated route plugins. All
code below was run on Node.js 24 with Fastify 5.8, `fastify-plugin` 6 and `@fastify/autoload` 6.

## Layout

```text
src/
  main.ts            options, autoload of plugins/ and routes/, error handler
  plugins/           shared: config, clients, auth, limits (fastify-plugin)
  routes/            encapsulated route plugins
  modules/<name>/    routes, service and repositories of one bounded context
```

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
  const routes = path.join(import.meta.dirname, 'routes');
  await fastify.register(AutoLoad, { dir: plugins, options: { ...opts } });
  await fastify.register(AutoLoad, { dir: routes, options: { ...opts } });
};

export { options };
export default main;
```

- `plugins/` loads first, so routes can read every decorator.
- Inside one directory, autoload orders plugins by their `dependencies`.
- The error handler is set once, here or in its own plugin (`error-handling`).

## Shared plugin

```ts
import fp from 'fastify-plugin';

import { createOrderService, type OrderService } from '../application/orders.ts';

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
  },
  { name: 'orders', dependencies: ['config', 'mongodb'] },
);
```

A plugin whose dependency is missing fails at boot (`The dependency 'x' of plugin 'y' is not
registered`), not on the first request.

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

No `fastify-plugin` here: hooks added inside stay inside.

```ts
import type { FastifyInstance } from 'fastify';

import { CreateOrderBody, OrderReply } from '../contracts/orders.ts';

const orderRoutes = async (fastify: FastifyInstance) => {
  fastify.addHook('onRequest', fastify.authenticate);

  const schema = { body: CreateOrderBody, response: { 201: OrderReply } };

  fastify.post('/orders', { schema, bodyLimit: 16_384 }, async (request, reply) => {
    const order = await fastify.orders.create(request.user!.id, request.body);
    reply.code(201);
    return order;
  });

  fastify.get('/orders/:id', async (request) => {
    const { id } = request.params as { id: string };
    return fastify.orders.get(id, { signal: request.signal });
  });
};

export default orderRoutes;
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
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import routes from '../src/routes/orders.ts';

describe('POST /orders', () => {
  it('should answer 413 when the body exceeds the route limit', async () => {
    const app = Fastify();
    app.decorate('authenticate', async () => {});
    app.decorate('orders', { create: async () => ({ id: '1' }) });
    await app.register(routes);

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
