---
name: node-layered-architecture
description: Structure Node.js apps as Onion + DDD layers on Fastify with injected dependencies. Use when designing a layout or moving logic out of routes
---

# Onion + DDD layers for Node.js

Every non-trivial app uses Onion Architecture with Domain-Driven Design:
business rules in the center, dependencies pointing inward, Fastify and the
database at the edge. Application code does not know which transport, driver
or logger runs it. In an existing project apply the boundaries route by route
and keep the framework at the edge instead of rewriting it.

|              | Library `@alexify/*`             | App (`auth8`)                                         |
| ------------ | -------------------------------- | ----------------------------------------------------- |
| Structure    | Flat `src/`, no layers           | Domain, Application, Infrastructure, Presentation     |
| Dependencies | Constructor options, zero deps   | Injected through the `fastify-plugin` tree            |
| Data         | Driver is injected               | Native `mongodb`, own DAL, one repository per aggregate |
| Config       | Constructor options              | 12-factor, `env-schema`, no `NODE_ENV` branches       |

The rest of this skill is the App profile.

## Layers and dependency direction

| Layer | Holds | May use | Must not see |
| ----- | ----- | ------- | ------------ |
| Domain | aggregates, entities, value objects, domain events, domain services, repository **interfaces**, domain errors with codes | nothing outside domain | I/O, HTTP statuses, driver, framework |
| Application | use cases, DTOs, ports (interfaces for infrastructure) | Domain | `request`/`reply`, Fastify, drivers, config |
| Infrastructure | repository implementations over the DAL, Redis, BullMQ, undici clients, mailer, hasher | Application ports, Domain, OS, npm | routes |
| Presentation | Fastify routes and plugins, `@alexify/wrpc` procedures, queue workers, CLI | Application use cases **only** | Domain internals, drivers |
| Composition root | `main.ts` and the plugin tree: config, construction, wiring | everything | |

Inner layers never import from outer layers. Outer layers depend on
abstractions owned by inner ones. Enforce it with oxlint
(`no-restricted-imports` per layer, see
[references/refactoring-steps.md](references/refactoring-steps.md)).

## Rules

- Keep `request`, `reply`, sockets and framework objects inside Presentation.
  A handler reads input once, calls a use case with plain data, returns the
  result. Nothing past it has a `request` parameter.
- Invariants live in the aggregate, not in use cases. A use case orchestrates:
  load through a repository interface, call the aggregate, save, publish
  events. Use domain events for communication across aggregates.
- One repository per aggregate. Its interface is in Domain, its implementation
  in Infrastructure, built on the DAL (`packages/node/src/dal` in `auth8`).
  Nothing above Infrastructure imports `mongodb`.
- Prefer single-document atomicity inside an aggregate, guard read-modify-write
  with `rev`, and use a transaction only across aggregates
  (`node-architecture-styles`).
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
- Wire through `fastify-plugin` with a `name` and declared `dependencies`.
  Decorate the instance with use cases; do not import a repository in a route.
- Load config once (`@fastify/env` or `env-schema`) and pass each module only
  its slice. Never read `process.env` deep inside a module, and never branch
  on `NODE_ENV`.
- Inject Pino (`fastify.log`) as a logger contract. Application code never
  imports a logger package.
- Keep per-request state in arguments or declared decorators, never in
  module-level variables.
- Give domain errors codes and map them to statuses in one `setErrorHandler`.
  Log unexpected errors fully; send a generic message and an error id
  (`error-handling`).
- REST stays the API style. Use `@alexify/wrpc` for realtime, as another
  Presentation adapter over the same use cases.

## Patterns

### Layout

```text
src/
  domain/<context>/        aggregates, value objects, events, repository interfaces
  application/<context>/   use cases, DTOs, ports
  infrastructure/          repositories over the DAL, Redis, queues, clients
  presentation/
    plugins/               fastify-plugin: guard, errors, validation, wiring
    routes/                routes: read input, call a use case
  main.ts                  entry: autoload plugins, then routes
test/                      use cases with DI fakes, routes through inject
```

Full runnable code of every file: [references/example-app.md](references/example-app.md).
Monorepo and library layouts: [references/project-templates.md](references/project-templates.md).

### Aggregate, repository interface, use case

```ts
// domain/account.ts: no imports
export class Account {
  #state: AccountState;

  constructor(state: AccountState) {
    this.#state = { ...state };
  }

  ensureCanSignIn() {
    if (this.#state.blocked) throw new DomainError('Account is blocked', 'EBLOCKED');
  }

  get passwordHash() {
    return this.#state.passwordHash;
  }

  get id() {
    return this.#state.id;
  }
}

export interface Accounts {
  findByLogin(login: string): Promise<Account | null>;
  save(account: Account): Promise<boolean>;
}
```

```ts
// application/auth.ts: depends on Domain and on its own ports
export const createAuth = ({ accounts, hasher, sessions, dummyHash }: AuthDeps) => {
  const signIn = async ({ login, password }: Credentials) => {
    const account = await accounts.findByLogin(normalizeLogin(login));
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

### Repository over the native driver

```ts
// infrastructure/accounts.repository.ts: the only code that knows the document
export const createAccountsRepository = (collection: Collection<AccountDocument>): Accounts => ({
  async findByLogin(login) {
    const document = await collection.findOne({ login });
    return document ? toAccount(document) : null;
  },

  async save(account) {
    const { id: cuid, blocked, rev } = account.toState();
    const update = { $set: { blocked }, $inc: { rev: 1 } };
    const result = await collection.updateOne({ cuid, rev }, update);
    return result.matchedCount === 1;
  },
});
```

`matchedCount === 0` is a lost-update conflict: retry or answer 409.

### Deny by default: one access decision for every transport

```ts
// application/access.ts
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
// presentation/plugins/access.ts
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
a route added before the guard, where `onRoute` did not fire. A third-party
plugin's routes (Swagger UI) carry no `access`: set it for that prefix in an
`onRoute` hook added before the guard.

### Route: read once, pass plain values

```ts
const authRoutes = async (fastify: FastifyInstance) => {
  const { auth } = fastify;
  const options = { config: { access: 'public' }, schema: { body: Credentials } };

  fastify.post<{ Body: Body }>('/sessions', options, async (request) => {
    return auth.signIn(request.body);
  });

  fastify.get('/me', { config: { access: 'session' } }, async (request) => {
    const { session } = request;
    return auth.getProfile(session!);
  });
};
```

### Transports without Fastify hooks

A queue worker or CLI calls use cases through one dispatcher with the same
decision. A `@alexify/wrpc` procedure already has it: `access` defaults to
`'session'` and any value but `'public'` or `'session'` throws.

```ts
// application/dispatcher.ts
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

### Composition root

```ts
export const buildApp = async (deps: AuthDeps, options: FastifyServerOptions = {}) => {
  const app = Fastify(options);
  await app.register(validation);
  await app.register(errors);
  await app.register(access, { sessions: deps.sessions });
  await app.register(auth, deps);
  await app.register(authRoutes);
  return app;
};
```

`auth8` loads the same tree with `@fastify/autoload`: `plugins/` first, then
`routes/`, each plugin naming its `dependencies`. Tests call `buildApp` with
fakes.

### Test business rules without a server

```ts
it('should refuse an unknown login even with the dummy password', async () => {
  // Arrange
  const auth = createAuth(createDeps());
  // Act
  const attempt = auth.signIn({ login: 'ghost', password: 'dummy' });
  // Assert
  await expect(attempt).rejects.toMatchObject({ code: 'EAUTH' });
});
```

### Service Locator: only at the edge

`require`/`import` already are service locators bound to concrete files. A
locator hides dependencies inside method bodies and depends on registration
order. Use it for open-ended plugin sets or for choosing an implementation by
name in the composition root, not inside domain code:
[references/di-and-service-locator.md](references/di-and-service-locator.md).

## Retrofitting an existing Fastify app

Do not rewrite. Per route, in shippable steps (details in
[references/framework-adapters.md](references/framework-adapters.md)):

1. Declare `access` on every route and install the guard, so nothing is open
   by omission.
2. Stop adding hooks that write undeclared fields on `request`.
3. Move the handler body into a use case that takes plain data; the route
   reads declared decorators once and passes them as arguments.
4. Move the rules into the aggregate, and driver calls into a repository
   behind an interface owned by Domain.
5. Turn imports of db, config and logger into factory parameters, wired by a
   named `fastify-plugin`.
6. Add domain error codes and one `setErrorHandler` mapping.
7. Add the oxlint layer rules once a context is clean.

The ordered path, with the coupling each step removes:
[references/refactoring-steps.md](references/refactoring-steps.md).

## Anti-patterns

| Anti-pattern | Why it hurts | Instead |
| ------------ | ------------ | ------- |
| Route without `access`, or a check that admits it | one forgotten line opens an endpoint | deny by default, fail the boot |
| Transaction Script or anemic layered MVC | rules leak into services, invariants scatter, code couples to framework and DB | aggregates + use cases |
| Business logic in hooks | implicit order, nobody owns the request | hooks stay generic, logic in use cases |
| Undeclared `request.user = ...` | shape depends on which hook ran; `if (request.x)` everywhere | `decorateRequest`, read in the handler |
| Module-level request state (`let currentUserId`) | concurrent requests overwrite it between `await`s; wrong user gets data | an explicit argument |
| `request`/`reply`/socket passed to services, timers, events | any holder can end the response; races | the handler keeps them; pass plain data |
| Fat handler (parse, validate, query, cache, log, format errors) | mixed layers, untestable without HTTP | route + use case + repository |
| Imports of `db`, `config`, `logger` in every file | one implementation, singletons, init-order bugs | composition root + factories |
| Whole config passed to every module | transport can read DB passwords; hidden coupling | config slices |
| Services returning HTTP codes or throwing `httpErrors` | domain bound to one protocol | domain error codes mapped at the edge |
| ORM or driver types in the domain | lock-in, leaky abstractions | repository interface, plain state |
| Building module paths from config strings | arbitrary file load | explicit factory map |

Why hooks are constrained, with failure examples and a replacement table:
[references/middleware.md](references/middleware.md).

## Checklist

- [ ] Every route declares `access`; a route without it fails the boot and is
      refused at run time.
- [ ] No file outside Presentation has a `request`/`reply` parameter or imports
      `fastify`.
- [ ] `domain/` imports nothing from other layers; `application/` imports only
      Domain; oxlint enforces both.
- [ ] Invariants live in aggregates; use cases only orchestrate.
- [ ] One repository per aggregate, interface in Domain, native driver in
      Infrastructure; `rev` guards read-modify-write.
- [ ] Plugins have a `name` and declared `dependencies`; config is read once.
- [ ] No module-level mutable state written per request; request fields are
      declared and read only in handlers.
- [ ] Errors carry codes; exactly one place maps them to statuses; 500s send a
      generic message and an error id, and are logged.
- [ ] Business rules are tested without a server; each adapter has one
      behavioural test.
- [ ] Hooks are generic and hold no business logic.

## References

- [references/example-app.md](references/example-app.md): complete runnable
  Onion app with tests
- [references/framework-adapters.md](references/framework-adapters.md): Fastify,
  BullMQ, wRPC and CLI adapters; retrofit plan
- [references/refactoring-steps.md](references/refactoring-steps.md): the path
  from a fat handler to layers, and the oxlint rules
- [references/di-and-service-locator.md](references/di-and-service-locator.md):
  DI styles, plugin wiring, Service Locator
- [references/middleware.md](references/middleware.md): what hooks may do, and
  replacements
- [references/project-templates.md](references/project-templates.md): monorepo,
  app and library layouts

Related skills: `js-solid-grasp` (DIP, Low Coupling, Controller),
`node-architecture-styles` (style choice, DDD, CQRS, outbox),
`js-contracts-schemas`, `node-data-access`, `error-handling`,
`node-graceful-shutdown`, `node-async-context`, `node-http-server`,
`node-websocket-realtime`, `node-access-control`, `js-gof` (Strategy, Facade,
Proxy).
