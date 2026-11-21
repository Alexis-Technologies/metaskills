# Project layouts

## App: one context in Onion layers

The target structure of ADR-003. Code moves into it context by context.

```text
src/
  main.ts                 entry: autoload plugins, then routes
  domain/
    account/              aggregate, value objects, events, repository interface, errors
  application/
    account/              use cases, DTOs, ports
  infrastructure/
    repositories/         repository implementations
    clients/              undici clients, mailer
    queues/               BullMQ producers
  presentation/
    plugins/              guard, errors, validation, wiring, config
    routes/               Fastify routes
    workers/              BullMQ processors
test/
  application/*.test.ts   use cases with DI fakes
  presentation/*.test.ts  routes through inject
```

Dependency rules to lint: `domain/` imports nothing from other layers,
`application/` imports only `domain/`, `infrastructure/` implements their
interfaces, `presentation/` calls use cases.

As a context grows, keep one use case per file (`application/account/sign-in.ts`).

## Monorepo: the `auth8` shape

```text
apps/
  auth8-api/              Fastify service
    src/main.ts           autoload of plugins/ and routes/
    src/plugins/          config, mongodb, redis, kerberos, authenticate, queues, swagger
    src/routes/           HTTP routes
    src/modules/          feature modules
  auth8-jobs/             BullMQ workers
  auth8-web/              frontend
packages/
  node/src/dal/           connection, base repository, mapper, validation, transactions
  node/src/repositories/  one repository per aggregate, shared by api and jobs
  schemas/                schema source
  enums/                  `as const` objects
  kerberos/               authorization policies
```

- The DAL and the repositories belong to the Infrastructure ring, and both the
  API and the jobs consume them.
- `buildRepositories({ connection, ajv, logger })` assembles every repository
  over one connection, and each one is `class XRepository extends
  RepositoryWithDefaultAutoFields`.
- Domain and Application depend on repository **interfaces**, and nothing above
  Infrastructure imports `mongodb`.
- `auth8` does not fully follow the ring folders yet: part of its logic is in
  `apps/auth8-api/src/modules/auth/service.ts`. Apply the
  [refactoring steps](refactoring-steps.md) when you touch such a module, and do
  not copy that shape into new code.

## Library: flat `src/`

```text
index.js                the public entry: re-exports src/
index.d.ts              handwritten types
src/
  client.js             system classes and pure functions
  parser.js
tests/
  unit/*.test.js        node:test
```

A library has no layers and no domain. Dependencies arrive through constructor
options (`new Kerberos(policies, derivedRoles, { logger, cache })`), a driver is
injected by the caller, and there are no runtime dependencies. The app wraps it
in a plugin:

```ts
export default fp(
  async (fastify) => {
    const kerberos = new Kerberos(policies, derivedRoles, { logger: fastify.log, cache: fastify.cache });
    fastify.decorate('kerberos', kerberos);
  },
  { name: 'kerberos', dependencies: ['config', 'cache'] },
);
```

## Choosing the amount of structure

| Code | Structure |
| ---- | --------- |
| A library | Flat `src/` |
| A trivial path: health check, a static list | A route calling a repository is fine; say why |
| Any business rule | Domain + Application + Infrastructure + Presentation |
| Several contexts | One folder per context in each ring; contexts talk through use cases or domain events |
| A separate deployable | A new `apps/*` over the same `packages/node`, see `node-architecture-styles` |
