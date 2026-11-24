# Project layouts

## App: modules with layers inside

The target structure. Code moves into it module by module; the full tree and the
naming rules are in [modules.md](modules.md).

```text
src/
  main.ts                 entry: config, driver, listen
  app.ts                  buildApp: plugins, then modules
  plugins/                validation, errors, access guard, config, mongodb, redis, queues
  shared/                 shared kernel: domain/, app/, infra/
  modules/
    <name>/
      index.ts            public API and composition root of the module
      domain/             aggregates, value rules, events, repository interfaces
      app/                services, ports
      infra/              repositories, collections, migrations, clients
      presentation/       routes, schemas, workers, wRPC procedures
      tests/              fakes shared by the tests of the module
  tests/                  the architecture test
```

Every folder keeps its tests in its own `tests/`. Dependency rules to lint:
`domain/` imports nothing from other layers, `app/` imports only `domain/`,
`infra/` implements their interfaces, `presentation/` calls `app/`. Another
module is reached only through `#modules/<name>`.

## Monorepo: the `auth8` shape

```text
apps/
  auth8-api/              Fastify service
    src/main.ts           autoload of plugins/ and routes/
    src/plugins/          config, mongodb, redis, kerberos, authenticate, queues, swagger
    src/routes/           routes outside the modules: health
    src/modules/          business modules: auth
  auth8-jobs/             BullMQ workers
  auth8-web/              frontend
packages/
  node/src/dal/           connection, base repository, mapper, validation, transactions
  node/src/repositories/  repositories shared by api and jobs
  schemas/                schema source
  enums/                  `as const` objects
  kerberos/               authorization policies
```

- Dependencies flow `apps -> packages`, never back: a package never imports an
  app, and an app never imports another app. Every package declares what it
  uses as `workspace:*` in its own `package.json`, so pnpm and Nx see the graph.
- Check it with a test, not with `@nx/enforce-module-boundaries`, which is an
  ESLint rule:

```ts
// tests/boundaries.test.ts at the workspace root
import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const readManifest = (dir: string) => JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
const appNames = readdirSync('apps').map((name) => readManifest(`apps/${name}`).name);

describe('workspace boundaries', () => {
  it('should keep apps out of the dependencies of packages', () => {
    for (const name of readdirSync('packages')) {
      const manifest = readManifest(`packages/${name}`);
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
      for (const appName of appNames) expect(dependencies[appName]).toBeUndefined();
    }
  });
});
```

- The DAL belongs to infrastructure, and both the API and the jobs consume it.
- `buildRepositories({ connection, ajv, logger })` assembles every repository
  over one connection, and each one is `class XRepository extends
  RepositoryWithDefaultAutoFields`.
- Domain and app code depend on repository **interfaces**, and nothing above
  infrastructure imports `mongodb`.
- `auth8` already has `apps/auth8-api/src/modules/auth/`, but its logic sits in
  one `service.ts` and its repositories in `packages/node`. Split it with the
  [refactoring steps](refactoring-steps.md) when you touch it.
- A module that both the API and the jobs need becomes a workspace package with
  one entry for the plugin and one for the workers
  ([modules.md](modules.md)).

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
| Any app with a business rule | One module with `domain/`, `app/`, `infra/`, `presentation/` |
| Several contexts | One module per context; they talk through facades or domain events |
| A separate deployable | A new `apps/*`: copy the module, see `node-architecture-styles` |
