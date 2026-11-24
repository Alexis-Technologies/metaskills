---
name: node-layered-architecture
description: Structure Node.js apps as business modules with Onion + DDD layers on Fastify. Use when designing a layout, adding a module or moving logic out of routes
---

# Modules with Onion + DDD layers for Node.js

An app is split into modules, one per business context. Inside each module,
Onion Architecture with Domain-Driven Design: business rules in the center,
dependencies pointing inward, Fastify and the database at the edge. A module
holds everything of its context, so deleting its folder removes the feature
and copying it starts a service.

|              | Library `@alexify/*`             | App (`auth8`)                                         |
| ------------ | -------------------------------- | ----------------------------------------------------- |
| Structure    | Flat `src/`, no layers           | Modules by business context, four layers in each      |
| Dependencies | Constructor options, zero deps   | Injected through the `fastify-plugin` tree            |
| Data         | Driver is injected               | Native `mongodb`, own DAL, one repository per aggregate |
| Config       | Constructor options              | 12-factor, `env-schema`, no `NODE_ENV` branches       |

The rest of this skill is the App profile.

## Modules

- One module per business context (`user-management`, `billing`), not per
  entity: the users, sessions and tokens of one context are aggregates of one
  module. A small app has one module.
- A module owns its layers, collections, indexes and migrations, its
  `@alexify/kerberos` policies, workers, route schemas and tests.
  Cross-cutting plugins (config, connections, errors, the access guard) live in
  `src/plugins/`, and a small shared kernel in `src/shared/`.
- `index.ts` is the public API and the composition root of the module: a named
  `fastify-plugin` that builds the module, decorates only its facade and
  registers its routes under one prefix. It exports types, never internals.
- Relative imports stay inside the module. Everything else comes through the
  `package.json` imports `#shared/*` and `#modules/<name>`, never a deep path
  into another module.
- Another module declares `dependencies: ['accounts']` and calls the facade, or
  reacts to a domain event. It never touches another module's collections.
- Inside a module import a file by its path, not through the module's own
  `index.ts`: that cycle fails at load with a `ReferenceError`.

Layout, file names, enforcement, extraction: [references/modules.md](references/modules.md).

## Layers and dependency direction

| Layer, folder | Holds | May use | Must not see |
| ------------- | ----- | ------- | ------------ |
| Domain `domain/` | aggregates, entities, value objects, domain events, repository **interfaces**, error codes | domain, `#shared/domain` | I/O, HTTP statuses, driver, framework |
| Application `app/` | services, DTOs, ports | domain | `request`/`reply`, Fastify, drivers, config |
| Infrastructure `infra/` | repositories over the DAL, collections, migrations, Redis, BullMQ, undici clients, hasher | app ports, domain, OS, npm | routes |
| Presentation `presentation/` | routes, `@alexify/wrpc` procedures, queue workers, CLI | app **only** | domain internals, drivers |
| Composition root | `index.ts` of a module, `app.ts`, `main.ts` | everything | |

Inner layers never import from outer layers. Outer layers depend on
abstractions owned by inner ones. oxlint enforces the layers, and a test
enforces the module boundaries.

## Files

- One kind per file, prefixed by the aggregate in the plural:
  `users.types.ts`, `users.constants.ts`, `users.helpers.ts`,
  `users.repository.ts`, `users.service.ts`, `users.routes.ts`. A class file
  is named after its class (`user.ts`).
- Types, constants, interfaces and helpers never share a file with logic. Add
  such a file when it has content, not as a placeholder. Several files of one
  kind become a folder with an `index.ts`: `helpers/index.ts`.
- `app/` holds services only, one or several per module
  (`accounts.service.ts`, `sessions.service.ts`), each method one operation.
  A service that outgrows a screen splits into another service by aggregate or
  responsibility.
- The repository implementation is `infra/users.repository.ts` (or
  `users.dal.ts`), without the driver in its name.
- Helpers are pure: no I/O, no business rule. A rule belongs to the aggregate
  or a value object.
- Types travel through `import type` and `export type`: type stripping cannot
  tell a type from a value, so a plain import of a type fails at load.
- Tests sit in `tests/` next to the code they check, in every folder.

## Rules

- Keep `request`, `reply`, sockets and framework objects inside Presentation.
  A handler reads input once, calls the service with plain data, returns the
  result. Nothing past it has a `request` parameter.
- Invariants live in the aggregate, not in services. A service method
  orchestrates: load through a repository interface, call the aggregate, save,
  publish events. Use domain events for communication across aggregates and modules.
- One repository per aggregate. Its interface is in `domain/`, its
  implementation in `infra/`, built on the DAL (`packages/node/src/dal` in
  `auth8`). Nothing above `infra/` imports `mongodb`.
- Prefer single-document atomicity inside an aggregate, guard read-modify-write
  with `rev` (`matchedCount === 0` is a lost update: retry or answer 409), and
  use a transaction only across aggregates (`node-architecture-styles`).
- **Every route declares `access`. A missing or unknown declaration is refused**
  (deny by default): at boot, and again at run time. Fine-grained permissions go
  through `@alexify/kerberos` (`node-access-control`).
- Validate at the boundary with `@alexify/metaschema`, the single schema source
  (`js-contracts-schemas`). Calls between in-process modules need no runtime
  validation.
- Fastify hooks stay generic (auth, rate limit, headers, tracing). No business
  logic in a hook, and no `(req, res, next)` middleware.
- A hook may set a request field only when `decorateRequest` declares it. The
  handler reads it once and passes it down as an explicit argument.
- Export factories from replaceable modules: `(deps) => api`, so tests build
  the same object with fakes. A module-level singleton is a hidden global.
- Give every plugin a `name` and declared `dependencies`. Pass objects inside a
  module through plugin options; do not import a repository in a route.
- Load config once (`@fastify/env` or `env-schema`) and pass each module only
  its slice. Never read `process.env` deep inside a module, and never branch
  on `NODE_ENV`.
- Inject Pino (`fastify.log`) as a logger contract. Application code never
  imports a logger package.
- Give domain errors codes and map them to statuses in one `setErrorHandler`.
  Log unexpected errors fully; send a generic message and an error id
  (`error-handling`).
- REST stays the API style. Use `@alexify/wrpc` for realtime, as another
  Presentation adapter over the same services.

## Patterns

### Layout

```text
src/
  main.ts                      entry: config, driver, listen
  app.ts                       buildApp: plugins, then modules
  plugins/                     validation, errors, access guard, config, mongodb
  shared/                      shared kernel: domain/, app/, infra/
  modules/
    accounts/
      index.ts                 public API: plugin, facade, contract types
      domain/                  account.ts, accounts.constants.ts, accounts.types.ts,
                               accounts.repository.ts (interface), tests/
      app/                     accounts.ports.ts, accounts.service.ts, tests/
      infra/                   accounts.collection.ts, accounts.repository.ts, tests/
      presentation/            accounts.routes.ts, accounts.schemas.ts, tests/
      tests/fakes.ts           fakes shared by the tests of the module
  tests/architecture.test.ts   module boundaries
```

Full runnable code of every file: [references/example-app.md](references/example-app.md).
Monorepo and library layouts: [references/project-templates.md](references/project-templates.md).

### Repository interface and service

```ts
// modules/accounts/domain/accounts.repository.ts: imports only domain
export interface AccountsRepository {
  findByLogin(login: string): Promise<Account | null>;
  save(account: Account): Promise<boolean>;
}
```

```ts
// modules/accounts/app/accounts.service.ts: depends on domain and on its own ports
export const createAccountsService = (deps: AccountsDeps) => {
  const { repository, hasher, sessions, dummyHash } = deps;

  const signIn = async ({ login, password }: Credentials) => {
    const account = await repository.findByLogin(normalizeLogin(login));
    const hash = account ? account.passwordHash : dummyHash;
    const isMatch = await hasher.verify(password, hash);
    if (!account || !isMatch) throw new DomainError('Wrong credentials', 'EAUTH');
    account.ensureCanSignIn();
    const token = await sessions.start({ accountId: account.id });
    return { token };
  };

  return Object.freeze({ signIn });
};
```

### Deny by default: one access decision for every transport

```ts
// shared/app/access.ts
const POLICIES = new Map<unknown, Policy>([
  ['public', () => true],
  ['session', (session) => session !== null],
]);

export const isDeclared = (access: unknown) => POLICIES.has(access);

export const isAllowed = (access: unknown, session: Session | null) => {
  const policy = POLICIES.get(access);
  return policy ? policy(session) : false;
};
```

Never write `access !== 'public' && !session`: it admits any session to a route
that declares nothing, or has a typo such as `'sesion'`. Look the policy up and
refuse when there is none.

```ts
// plugins/access.ts
const guard = async (fastify: FastifyInstance, { sessions }: GuardOptions) => {
  fastify.decorateRequest('session', null);

  fastify.addHook('onRoute', (route) => {
    if (isDeclared(route.config?.access)) return;
    throw new Error(`${route.method} ${route.url}: access is not declared`);
  });

  fastify.addHook('onRequest', async (request, reply) => {
    if (request.is404) return;
    const token = readToken(request.headers.authorization);
    request.session = token ? await sessions.restore(token) : null;
    if (isAllowed(request.routeOptions.config.access, request.session)) return;
    return reply.code(403).send({ message: 'Forbidden' });
  });
};

export default fp(guard, { name: 'access' });
```

`onRoute` fails the boot for a route without `access`; `onRequest` also refuses
a route added before the guard, where `onRoute` did not fire. A queue worker or CLI goes through one
dispatcher with the same decision, and a `@alexify/wrpc` procedure already has
it (`references/framework-adapters.md`).

### Route: read once, pass plain values

```ts
// modules/accounts/presentation/accounts.routes.ts
export const accountsRoutes = async (fastify: FastifyInstance, { service }: RoutesOptions) => {
  const publicRoute = { config: { access: 'public' }, schema: { body: CredentialsSchema } };

  fastify.post<{ Body: Credentials }>('/sessions', publicRoute, async (request) => {
    return service.signIn(request.body);
  });

  fastify.get('/me', { config: { access: 'session' } }, async (request) => {
    const { session } = request;
    return service.getProfile(session!);
  });
};
```

### Composition roots

```ts
// modules/accounts/index.ts: builds the module, exposes the facade
const accountsModule = async (fastify: FastifyInstance, options: AccountsOptions) => {
  const { db, sessions, createId } = options;
  const repository = createAccountsRepository(await openAccounts(db));
  const hasher = createPasswordHasher();
  const dummyHash = await hasher.hash(randomUUID());
  const deps = { repository, hasher, sessions, logger: fastify.log, createId, dummyHash };
  const service = createAccountsService(deps);
  fastify.decorate('accounts', service);
  await fastify.register(accountsRoutes, { prefix: '/accounts', service });
};

export default fp(accountsModule, {
  name: 'accounts',
  dependencies: ['validation', 'errors', 'access'],
});
```

`buildApp` in `app.ts` registers the plugins, then each module after the ones it
depends on. `@fastify/autoload` needs `maxDepth: 1` over `modules/`. Tests call
`buildApp` with fakes; a service runs in a unit test with no server.

Use a Service Locator only at the edge, for open-ended plugin sets or for
choosing an implementation by name in a composition root:
[references/di-and-service-locator.md](references/di-and-service-locator.md).

## Retrofitting an existing Fastify app

Do not rewrite. Per route, in shippable steps (details in
[references/framework-adapters.md](references/framework-adapters.md)):

1. Declare `access` on every route and install the guard, so nothing is open
   by omission.
2. Give each business context a `modules/<name>/` folder with an `index.ts`
   plugin, and move its routes and service there unchanged.
3. Move the handler body into a service method that takes plain data;
   the route reads declared decorators once and passes them as arguments.
4. Move the rules into the aggregate, and driver calls into a repository
   behind an interface in `domain/`.
5. Turn imports of db, config and logger into factory parameters, wired by the
   module's `index.ts`.
6. Add domain error codes and one `setErrorHandler` mapping.
7. Add the oxlint layer rules and the architecture test once a module is clean.

The ordered path, with the coupling each step removes:
[references/refactoring-steps.md](references/refactoring-steps.md).

## Anti-patterns

| Anti-pattern | Why it hurts | Instead |
| ------------ | ------------ | ------- |
| Route without `access`, or a check that admits it | one forgotten line opens an endpoint | deny by default, fail the boot |
| Layer folders at the top for every context | one feature spreads over four folders; deleting or extracting it starts with a search | a folder per module, layers inside |
| A deep import into another module, or a read of its collection | the modules cannot be deleted or extracted apart | the facade through `#modules/<name>`, events |
| Types, constants and helpers in the file with the logic | changes collide, the file has no single reason to change | one kind per file |
| Transaction Script or anemic layered MVC | rules leak into services, invariants scatter | aggregates + thin services |
| Business logic in hooks | implicit order, nobody owns the request | hooks stay generic, logic in services |
| Module-level request state (`let currentUserId`) | concurrent requests overwrite it between `await`s | an explicit argument |
| Imports of `db`, `config`, `logger` in every file | one implementation, singletons, init-order bugs | composition roots + factories |
| Services returning HTTP codes or throwing `httpErrors` | domain bound to one protocol | domain error codes mapped at the edge |

Why hooks are constrained, with failure examples and a replacement table:
[references/middleware.md](references/middleware.md).

## Checklist

- [ ] One folder per business context in `src/modules/`, each with `domain/`,
      `app/`, `infra/`, `presentation/` and tests next to the code.
- [ ] Other code reaches a module only through `#modules/<name>`; the
      architecture test passes, and no module reads another one's collections.
- [ ] Every route declares `access`; a route without it fails the boot and is
      refused at run time.
- [ ] No file outside Presentation has a `request`/`reply` parameter or imports
      `fastify`; oxlint enforces the layer rules and `import/no-cycle`.
- [ ] Invariants live in aggregates; services only orchestrate.
- [ ] One repository per aggregate, interface in `domain/`, native driver in
      `infra/`; `rev` guards read-modify-write.
- [ ] Types, constants and helpers have their own files; types use `import type`.
- [ ] Plugins have a `name` and declared `dependencies`; config is read once.
- [ ] Errors carry codes; exactly one place maps them to statuses; 500s send a
      generic message and an error id, and are logged.
- [ ] Business rules are tested without a server; each adapter has one
      behavioural test.

## References

- [references/modules.md](references/modules.md): layout, what a module owns,
  file names, imports, enforcement, extraction
- [references/example-app.md](references/example-app.md): complete runnable
  app with one module and its tests
- [references/framework-adapters.md](references/framework-adapters.md): Fastify,
  BullMQ, wRPC and CLI adapters, the dispatcher; retrofit plan
- [references/refactoring-steps.md](references/refactoring-steps.md): the path
  from a fat handler to a module
- [references/di-and-service-locator.md](references/di-and-service-locator.md):
  DI styles, plugin wiring, Service Locator
- [references/middleware.md](references/middleware.md): what hooks may do, and
  replacements
- [references/project-templates.md](references/project-templates.md): monorepo,
  app and library layouts

Related skills: `js-solid-grasp` (DIP, Low Coupling, Controller),
`node-architecture-styles` (style choice, modular monolith, DDD, CQRS, outbox),
`js-contracts-schemas`, `node-data-access`, `error-handling`,
`node-graceful-shutdown`, `node-async-context`, `node-http-server`,
`node-websocket-realtime`, `node-access-control`, `js-gof` (Strategy, Facade,
Proxy).
