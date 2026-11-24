# Hooks, decorators and why domain logic stays out of the chain

## What exactly is constrained

A middleware chain is a contract: handlers with one signature sharing one
mutable context, `(req, res, next)` in Connect or `(ctx, next)` in Koa. Alexis
apps run on Fastify and do not use that contract. Fastify hooks are a safer
mechanism, but the same failures return as soon as domain code moves into them.
The problem is not the word "middleware" but business logic living in the chain.

In GoF terms a middleware chain is a broken Chain of Responsibility: in a real
chain exactly one handler takes responsibility for a request; here every link
does a bit (parses, mutates, loads, authorizes, responds) and nobody owns the
result.

## Failure modes

1. Reference pollution. `request`, `reply` and `request.raw.socket` escape the
   handler: stored in module-level collections, passed to methods of other
   objects, emitted with events, captured in closures, timers and promise
   chains. Any holder can later write to the socket, end the response or read
   stale data.

   ```js
   // BAD
   fastify.addHook('onRequest', async (request, reply) => {
     setTimeout(() => {
       if (!reply.sent) reply.code(504).send();
     }, 5000);
   });
   ```

   Now every other place must check `reply.sent` before writing. Use the
   server's `requestTimeout`, or pass `AbortSignal.timeout(ms)` to the service.

2. Races on shared state. All concurrent requests run in one process. A value
   written by a hook into an outer scope is overwritten by the next request
   between two `await`s:

   ```js
   // BAD
   let currentUserId = null;

   fastify.addHook('onRequest', async (request) => {
     currentUserId = request.headers['x-user'];
   });

   fastify.get('/profile', async () => {
     await sleep(10);
     return `profile of ${currentUserId}`;
   });
   // alice and bob in parallel: both get "profile of bob"
   ```

   The explicit version `getProfile({ session })` returns the right profile for
   each caller. This is the most common real-world race of this kind.

3. Undeclared fields and implicit order. `request.user = ...`,
   `request.tenant = ...` without `decorateRequest` turn `request` into a bag
   whose shape depends on which hook ran before, and change its hidden class per
   request. Handlers start with `if (request.user)`, and people reorder
   registrations until things work.

4. Fat handlers. Because `request` and `reply` are available, the final handler
   collects everything: header parsing, validation, queries, cache, logging,
   third-party calls, serialization, error formatting. Splitting it into 20
   helpers that each take `(request, reply)` keeps the coupling (tramp data).

5. Leaky abstractions: `request.raw.socket._handle`, long chains
   (`a.b().c.d()`), Law of Demeter violations. The code depends on the transport
   (TLS vs plain, HTTP vs WebSocket) through `if`s.

6. Skipped error handling. Streams without `'error'` handlers and callbacks that
   `throw` crash the process, and restart loops hide the races instead of fixing
   them.

7. Lock-in. When the application structure is the framework contract, moving a
   service to a queue, wRPC or a CLI means rewriting business code.

Named anti-patterns behind these failures: pass-through parameters, accumulate
and fire, temporary field, mixins, inappropriate intimacy, high coupling, fat
controller, fat model, global and module-level mutable state.

## The rule that fixes most of it

`request`, `reply` and sockets never go past the handler. The handler receives
the request, calls a service with plain data, receives plain data and returns
it. Everything behind it is a layer that does not know there is a network.

A signal that layers are missing: logic keeps moving between the handler and the
repository. Introduce a service and put the rule in the aggregate.

## Declared decorators are fine

```ts
fastify.decorateRequest('user', null); // declared by the plugin that owns it

fastify.addHook('preHandler', fastify.authenticate); // sets request.user

fastify.get('/sessions', async (request) => {
  const { user } = request; // read once, in the handler
  return fastify.sessions.list({ userId: user.id }); // passed down as an argument
});
```

What makes this safe: the field is declared, so its shape is stable; one plugin
owns it; only the handler reads it; the service receives a plain argument and
stays testable without Fastify.

## What to use instead

| Typical chain step | Replacement |
| ------------------ | ----------- |
| body parser | Fastify's parser with `bodyLimit` |
| auth / session loader | a generic hook that sets a declared decorator; the route declares `access` |
| permission checks per route | declarative `access`, then `@alexify/kerberos` for resources (`node-access-control`) |
| validation step | the route `schema` through the metaschema compiler (`js-contracts-schemas`) |
| request logger | Fastify's Pino request logging; services get an injected logger |
| error-handling step | one `setErrorHandler` mapping domain codes to statuses |
| CORS, security headers, compression, rate limit | `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit` |
| per-request DB transaction | the service opens it through an injected unit of work, only across aggregates |
| response caching | an application service with an injected cache, or HTTP caching headers set by the route |
| token refresh "interceptor" | an explicit step in the auth service |
| correlation id for logs | `request.id`; `AsyncLocalStorage` only for infrastructure logging (`node-async-context`) |

## What may stay in a hook

Code that is generic, reusable across projects, free of domain logic and ideally
already published and tested: authentication, CORS, compression, security
headers, rate limiting, tracing. If a hook mentions an entity of your domain, it
belongs in a layer.

Fastify specifics:

- Use hooks (`onRequest`, `preHandler`, `onSend`) and plugins. Do not add
  `@fastify/middie` to run Express-style middleware.
- A hook that answers must `return reply` after `reply.send()`.
- Hooks follow encapsulation: a hook in a child plugin does not cover its
  siblings. A guard for the whole app goes through `fastify-plugin` at the root.
