# Modules: one business context, one folder

Folders split by layer at the top (`src/domain/`, `src/application/`) spread one
feature over four places, so deleting it or moving it into a service starts
with a search through the whole app. A module keeps every layer of one business
context, its data and its tests in one folder.

## Layout

```text
src/
  main.ts                          process entry: config, driver, listen
  app.ts                           buildApp: plugins first, then modules
  plugins/                         cross-cutting Fastify plugins
    validation.ts                  the metaschema validator compiler
    errors.ts                      one setErrorHandler
    access.ts                      the guard
    tests/
  shared/                          shared kernel, the same layers
    domain/domain-error.ts
    app/access.ts                  the access decision, deny by default
    infra/session-store.ts
  modules/
    accounts/
      index.ts                     public API and composition root of the module
      domain/
        account.ts                 aggregate
        credentials.ts             value rules: login, password
        accounts.constants.ts
        accounts.types.ts
        accounts.repository.ts     repository interface
        tests/account.test.ts
      app/
        accounts.ports.ts          hasher, logger
        accounts.types.ts          deps and DTOs
        accounts.service.ts        facade over the operations
        tests/accounts.service.test.ts
      infra/
        accounts.collection.ts     collection and indexes
        accounts.repository.ts     repository over the driver
        accounts.types.ts          document shape
        password-hasher.ts
        migrations/
        tests/accounts.repository.test.ts
      presentation/
        accounts.routes.ts
        accounts.schemas.ts
        tests/accounts.routes.test.ts
      tests/fakes.ts               fakes shared by the tests of the module
  tests/architecture.test.ts       module boundaries
```

The code of every file is in [example-app.md](example-app.md).

## What a module owns

- Its aggregates, services, ports and repositories.
- Its collections, their indexes and validators, and their migrations
  (`@alexify/migronaut`).
- The `@alexify/kerberos` policies of its resources, its BullMQ processors, its
  `@alexify/wrpc` procedures and its route schemas.
- The schema of its configuration slice, and its tests.

What stays outside: the plugins that open connections (MongoDB, Redis), load the
config, map errors and guard routes, in `src/plugins/`, and the shared kernel in
`src/shared/`.

## Choosing the cut

- A module is a business context: `user-management`, `billing`, `feedback`.
  Users, sessions and tokens of one context are aggregates of one module, not
  three modules.
- A technical kind (`validation`, `helpers`, `repositories`) is never a module.
- A wrong cut shows itself: two modules call each other in both directions, a
  change always touches both, or one transaction spans both. Merge them, or
  move the shared rule into one of them.
- A small app has one module. The cost is one folder level, and there is
  nothing to migrate when the second context arrives.

## File names

| Kind | Name | Layer |
| ---- | ---- | ----- |
| Aggregate, entity | `account.ts`, named after its class | domain |
| Value rules | `credentials.ts`, `email.ts` | domain |
| Repository interface | `accounts.repository.ts` | domain |
| Domain events | `accounts.events.ts` | domain |
| Ports | `accounts.ports.ts` | app |
| Service | `accounts.service.ts`, one or several per module | app |
| Repository | `accounts.repository.ts`, or `accounts.dal.ts` | infra |
| Collection and indexes | `accounts.collection.ts` | infra |
| Routes, route schemas | `accounts.routes.ts`, `accounts.schemas.ts` | presentation |
| Queue processor | `accounts.worker.ts` | presentation |
| Types, constants, helpers | `accounts.types.ts`, `accounts.constants.ts`, `accounts.helpers.ts` | any |
| Tests | `tests/<file>.test.ts`, `tests/<file>.integration.test.ts` | next to the code |

- The prefix is the aggregate in the plural, so the files of one aggregate sort
  together. Kebab case throughout.
- Types, constants, interfaces and helpers never share a file with logic. A file
  of a kind appears when it has content, never as an empty placeholder.
- Several files of one kind become a folder with an `index.ts` that re-exports
  them: `app/helpers/index.ts`, `app/helpers/normalize-email.ts`,
  `app/helpers/tests/normalize-email.test.ts`.
- Constants are `as const` objects, not TypeScript `enum`: type stripping only
  runs erasable syntax.
- Types travel through `import type` and `export type`. Type stripping removes
  types without looking at other files, so `import { AccountState }` of a type
  fails at load: `does not provide an export named 'AccountState'`.
  `verbatimModuleSyntax` makes `tsc` report it first.
- The repository file does not name the driver. The folder already says it is
  infrastructure, and the driver may change.

### Services

`app/` holds services only, one or several per module: `accounts.service.ts`,
`sessions.service.ts`. A service is a factory over its ports, and each method is
one operation: load through a repository, call the aggregate, save, publish
events. It knows no HTTP. A service that outgrows one screen splits into another
service by aggregate or responsibility, and the module exposes only the services
other modules may call.

### Helpers

A helper is pure: no I/O and no business rule. A rule is the aggregate's or a
value object's, even when it looks like a small function. A helper used by two
modules moves to `src/shared/`, and one used by two apps moves to a package
(`packages/helpers` in `auth8`).

## The public API: `index.ts`

The index is a named `fastify-plugin` and the composition root of the module.
It builds the repository, the hasher and the service from what the app passes
in, decorates only the facade, and registers the routes in their own context
under the module prefix. It exports types of its contract and nothing from the
inside. The full file is in [example-app.md](example-app.md).

Another module declares the dependency and calls the facade:

```ts
// src/modules/profiles/index.ts: reaches accounts only through its facade
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

const profilesModule = async (fastify: FastifyInstance) => {
  const { accounts } = fastify;
  const routes = async (scope: FastifyInstance) => {
    scope.get('/me', { config: { access: 'session' } }, async (request) => {
      return accounts.getProfile(request.session!);
    });
  };
  await fastify.register(routes, { prefix: '/profiles' });
};

export default fp(profilesModule, { name: 'profiles', dependencies: ['accounts'] });
```

Registered before `accounts`, it stops the boot with `The dependency 'accounts'
of plugin 'profiles' is not registered`, not on the first request.

- Pass objects inside the module through plugin options (`{ service }` to the
  routes), and decorate only what other modules may call.
- A module never reads or writes another module's collections, and never
  `$lookup`s into them. It asks the facade, or reacts to a domain event. Across
  modules a write and its event go through an outbox (`node-architecture-styles`).

### Loading modules with `@fastify/autoload`

```ts
await app.register(AutoLoad, {
  dir: join(import.meta.dirname, 'modules'),
  maxDepth: 1,
  dirNameRoutePrefix: false,
  options: deps,
});
```

- `maxDepth: 1` loads only `modules/<name>/index.ts`. Autoload skips the other
  files beside an index but still walks its subfolders, and imports every file
  there, tests and migrations included: a test file calls `describe` outside
  Vitest and the boot crashes.
- `ignorePattern: /^tests$/` is not enough here. It keeps the tests out, but
  autoload still registers every default export inside the module as a plugin.
  A routes file with `export default` came up a second time at the root,
  without its prefix and its service, and answered 500. A migration with
  `export default` ran at every boot. The index is the only entry of a module,
  for autoload too.
- `dirNameRoutePrefix: false`, because the module sets its own prefix.
- Autoload orders the modules by their declared `dependencies`, not by name.
- The plugins load first, in their own autoload call over `plugins/` with
  `ignorePattern: /^tests$/`. Without it `plugins/tests/` is imported too, and
  the boot crashes the same way.

## Imports

```json
{
  "imports": {
    "#app": { "source": "./src/app.ts", "default": "./dist/app.js" },
    "#shared/*": { "source": "./src/shared/*", "default": "./dist/shared/*" },
    "#modules/*": { "source": "./src/modules/*/index.ts", "default": "./dist/modules/*/index.js" }
  }
}
```

Node.js resolves these `package.json` imports to the build in `dist/`. `tsc`
with `moduleResolution: nodenext` and `customConditions: ["source"]`, and Vitest
with `ssr.resolve.conditions: ['source']`, resolve them to the TypeScript
([example-app.md](example-app.md)). Specifiers end in `.js`:
`#shared/app/access.js`, `./accounts.service.js`.

- Relative imports stay inside the module.
- Everything outside it comes through `#shared/...` or `#modules/<name>`.
  `#modules/<name>/...` is a deep import and is refused.
- `#app` is for tests that need the whole plugin tree.
- Inside a module import a file by its path, never through the module's own
  `index.ts`. The cycle `index.ts -> routes -> index.ts` fails at load with
  `ReferenceError: Cannot access '...' before initialization`. oxlint
  `import/no-cycle` reports it.

## Enforcement

oxlint checks the layers. The last override switches the rule off in tests:
only one `no-restricted-imports` applies to a file, and a later override wins.

```json
{
  "plugins": ["import", "typescript"],
  "rules": {
    "import/no-cycle": "error"
  },
  "overrides": [
    {
      "files": ["src/modules/*/domain/**", "src/shared/domain/**"],
      "rules": {
        "no-restricted-imports": [
          "error",
          {
            "patterns": [
              {
                "group": ["fastify*", "mongodb", "#modules/*", "**/app/**", "**/infra/**", "**/presentation/**"],
                "message": "domain imports only domain"
              }
            ]
          }
        ]
      }
    },
    {
      "files": ["src/modules/*/app/**", "src/shared/app/**"],
      "rules": {
        "no-restricted-imports": [
          "error",
          {
            "patterns": [
              {
                "group": ["fastify*", "mongodb", "**/infra/**", "**/presentation/**"],
                "message": "app depends only on domain and on its own ports"
              }
            ]
          }
        ]
      }
    },
    {
      "files": ["src/modules/*/presentation/**"],
      "rules": {
        "no-restricted-imports": [
          "error",
          {
            "patterns": [
              {
                "group": ["mongodb", "**/domain/**", "**/infra/**"],
                "message": "presentation calls app only"
              }
            ]
          }
        ]
      }
    },
    {
      "files": ["**/tests/**"],
      "rules": {
        "no-restricted-imports": "off"
      }
    }
  ]
}
```

oxlint has no `import/no-restricted-paths`, and a pattern cannot tell
`../../domain/x.js` inside a module from `../../billing/x.js` in the next one.
The module boundary is a test that resolves every relative import:

```ts
// src/tests/architecture.test.ts: a module is reached only through its index
import { globSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const MODULES = resolve(import.meta.dirname, '../modules');
const SPECIFIER = /(?:from|import)\s*\(?\s*'([^']+)'/g;
const DEEP = /^#modules\/[^/]+\//;

const ownerOf = (path: string) => relative(MODULES, path).split(sep)[0];

const findViolations = () => {
  const violations: string[] = [];
  for (const file of globSync('**/*.ts', { cwd: MODULES })) {
    const path = resolve(MODULES, file);
    const source = readFileSync(path, 'utf8');
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      const isRelative = specifier.startsWith('.');
      const target = isRelative ? resolve(dirname(path), specifier) : '';
      const leaves = isRelative && ownerOf(target) !== ownerOf(path);
      if (leaves || DEEP.test(specifier)) violations.push(`${file}: ${specifier}`);
    }
  }
  return violations;
};

describe('module boundaries', () => {
  it('should keep relative imports inside the module and reach others through #modules', () => {
    // Arrange, Act
    const violations = findViolations();
    // Assert
    expect(violations).toEqual([]);
  });
});
```

It reports `../../accounts/app/accounts.service.js`, `../../../app.js` and
`#modules/accounts/app/accounts.service.js`, and accepts `#modules/accounts`.

## Delete, extract, share

- **Delete:** remove the folder and its line in `app.ts`. The type check, the lint
  and the architecture test point at anything left. Drop its collections with a
  migration: the data outlives the code.
- **Extract into a service:** copy the folder into a new `apps/*` with its own
  `app.ts`. Callers keep the contract of the facade and get a network client
  that implements it, and the collections move to their own database
  (`node-architecture-styles`).
- **Two deployables, one module:** when the API and the job runner both need a
  module, move it into a workspace package (`packages/<name>`) with one entry
  for the plugin and one for the workers. Never import a folder of another app.

## Shared kernel

`src/shared/` has the same layers and the same lint rules, and every module may
import it. Keep it small: `DomainError`, ids, the access decision, the tenant
context. Something used by one module stays in that module. Something used by
several apps goes into `packages/*` (`constants`, `types`, `helpers`, `enums` in
`auth8`).
