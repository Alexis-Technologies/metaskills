# Dependency injection styles and Service Locator

## Why `require`/`import` everywhere is the problem

`require` and `import` are service locators: a module asks a global registry for
a concrete file. That couples the caller to one implementation, makes the module
a singleton (CommonJS until `require.cache` is cleared; ESM cannot be reloaded at
all), and spreads infrastructure knowledge into every file. Rules:

- A file is not a module. A module is a contract. Export a creational wrapper
  (factory, class, pool) so the implementation can be chosen by config or by the
  caller.
- Import infrastructure (drivers, frameworks, config, logger packages) only in
  the composition root and in the adapter modules that implement it.
- Less module-level state means lower coupling. Such code can later be rebuilt
  as a monolith, several processes, or services behind a queue without a rewrite.

## Styles compared

| Style | Shape | Use when | Costs |
| ----- | ----- | -------- | ----- |
| Callback / function argument | `server.shutdown(done)`, `new Server(log)` | one capability | grows into long parameter lists |
| Constructor injection | `new Server({ logger, db })` | classes, stateful services, libraries | must thread deps through every constructor |
| Closure factory (app default) | `export const createAuth = ({ accounts, logger }) => ({ ... })` | services, repositories | wiring code in plugins |
| Factory of a config slice | `createRedis(config.redis)` | infrastructure modules | none |
| Class factory | `const createServerClass = (deps) => class Server {}` | need a class bound to deps | unusual for readers |
| Fastify decorator through `fastify-plugin` | `fastify.decorate('auth', createAuth(deps))` | the composition root of an app | Presentation only; do not read it in inner layers |
| Service Locator | `locator.get('logger')` | plugin systems, choosing an implementation by name | hidden dependencies, order of registration |
| DI container | decorators or tokens | not needed in Alexis apps | magic, framework coupling |

Pass dependencies as ONE object, not one parameter per dependency: adding a
dependency then does not change every signature. Freeze it, and freeze nested
namespaces: `Object.freeze` is shallow.

```js
const context = Object.freeze({
  logger,
  accounts: Object.freeze(accounts),
  config: Object.freeze({ sessions: config.sessions }),
});
const auth = createAuth(context);
```

Without `'use strict'` a write to a frozen object is ignored silently. In ESM and
TypeScript it throws. Treat `freeze` as protection against accidents, and never
as a security or access check.

Give each module only what it needs. A transport gets `{ host, port }`, not the
whole config. Application code gets the config keys it reads.

## The plugin tree as the composition root

A `fastify-plugin` breaks encapsulation on purpose, so its decorators reach the
whole app. Name it and declare what it needs. Fastify then fails the boot when a
dependency is missing, instead of failing on the first request.

```ts
import fp from 'fastify-plugin';

export default fp(
  async (fastify) => {
    const accounts = createAccountsRepository(fastify.mongo.db.collection('accounts'));
    const auth = createAuth({ accounts, logger: fastify.log, ...fastify.authInfrastructure });
    fastify.decorate('auth', auth);
  },
  { name: 'auth', dependencies: ['mongodb', 'auth-infrastructure'] },
);
```

`@fastify/autoload` loads a folder of such plugins. `auth8` loads `plugins/`
first and `routes/` second. Encapsulated route plugins see every decorator of
the root and add nothing to it.

Keep the discipline with oxlint: forbid infrastructure imports in `domain/` and
`app/` (see [modules.md](modules.md)).

## Service Locator

Minimal locator: a `Map` hidden behind a facade, so callers cannot iterate, clear
or replace the collection.

```js
const services = new Map();

const get = (name) => services.get(name);
const set = (name, service) => void services.set(name, service);

module.exports = Object.freeze({ get, set });
```

Variants: a static class with `static #modules = new Map()`, a closure module
with `get` and `set`, or exporting `new Map()` directly (worst: it exposes
`clear`, `delete` and iteration).

Several locators can hold different implementations of the same names (per
environment, per tenant, front vs back), which is effectively a Strategy selected
by name.

Trade-offs, and why explicit injection is the default:

- Dependencies are hidden inside method bodies; the signature no longer tells
  what the module needs; tests must know which names to register.
- Order matters: `get` before `set` returns `undefined` at run time.
- It is a global: concurrent tests and multiple app instances share it.
- Acceptable at the boundary: plugin registries, choosing a transport or driver
  by name in the composition root.

Prefer: the composition root builds everything once and passes a frozen object.
Use a locator only where the set of implementations is open-ended.

## Per-call context

Request-specific data (session, account id, request id, client ip, deadline)
travels as an explicit argument. In a route it may sit in a declared decorator
until the handler reads it. It never sits in a module-level variable.

```js
const context = Object.freeze({ requestId: request.id, ip: request.ip, session });
const result = await accounts.block(args, context);
```

Three kinds of state in a server: call state (lives until the response),
client or connection state (until disconnect), session state (persisted, may
survive restarts). Keep them in separate objects with separate lifetimes.
`AsyncLocalStorage` is fine for infrastructure concerns such as log correlation
(`node-async-context`), and is not a hidden channel for inputs that business code
depends on.
