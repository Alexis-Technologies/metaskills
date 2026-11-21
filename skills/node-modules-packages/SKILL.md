---
name: node-modules-packages
description: Structure Node.js modules, package.json and dependencies. Use for CJS vs ESM, exports, pnpm, ERR_REQUIRE_ESM, cycles or duplicated singletons
---

# Node.js Modules, Packages and Dependencies

With this skill the agent treats a module as a unit with a fixed contract,
keeps one module system per package, declares the public surface of every
package in `exports`, never relies on the module cache as hidden global
state, and adds a dependency only when Node.js has no built-in for the job.

## Project profile

|              | Library `@alexify/*`                 | App (`auth8`)                         |
| ------------ | ------------------------------------ | ------------------------------------- |
| Modules      | CommonJS, handwritten `.d.ts`        | ESM, TypeScript, `module: NodeNext`   |
| Runtime deps | None                                 | Allowed                               |
| Wiring       | Constructor options, injected driver | Fastify plugins with `fastify-plugin` |
| Node.js      | `engines` floor (18 to 24, by repo)  | 24+                                   |

The project's own `package.json` wins over this table. The package manager
is pnpm, pinned in `packageManager`.

## Key facts the rules rely on

- CommonJS: the loader reads the file, wraps it in
  `function (exports, require, module, __filename, __dirname) { ... }`,
  compiles it (the same mechanism `vm` exposes) and calls it. Nothing in
  that list is a real global.
- `require()` is synchronous and caches by resolved absolute path in
  `require.cache`. Every importer gets the same `module.exports` object, so a
  module is a singleton and the cache is process-wide shared state.
- Resolution of a bare name walks `node_modules` from the importing file's
  directory up to the filesystem root (`module.paths`). A package with the
  same name as a built-in can be found there, which is why `node:` matters.
- ESM is linked before it runs: `import` declarations are static and hoisted,
  bindings are live and read-only, top-level `await` is allowed, `require`,
  `module`, `exports`, `__filename` and `__dirname` do not exist.
- Since Node.js 20.19 and 22.12 (and in 24), `require()` loads an ES module
  graph if it has no top-level `await`. With TLA it throws
  `ERR_REQUIRE_ASYNC_MODULE`. `import` of a CommonJS file gives
  `module.exports` as `default`, plus statically detectable named exports.
- Two files of one package (`.cjs` and `.mjs` via conditional `exports`) are
  two module instances with two copies of the state: the dual-package hazard.

## Rules

Module system

- Prefix every built-in with `node:` (`require('node:fs')`,
  `import fs from 'node:fs/promises'`). It cannot be shadowed by an npm
  package.
- **Library**: CommonJS with a handwritten `.d.ts`. **App**: ESM and
  TypeScript with `module: NodeNext`. Do not mix both styles inside one
  package without a reason.
- A new package sets `"type"` explicitly. Existing `@alexify` libraries omit
  it, which means CommonJS; leave them as they are. A typeless package with
  ESM syntax in `.js` is parsed twice and warns
  (`MODULE_TYPELESS_PACKAGE_JSON`). Use `.cjs` / `.mjs` only for exceptions.
- Write relative specifiers with the extension (`./lib/user.js`). ESM
  requires it. In CommonJS it removes extension and directory probing and
  makes the target obvious. Never rely on implicit `index.js`. An app that
  imports `./logger.ts` needs `allowImportingTsExtensions`, and
  `rewriteRelativeImportExtensions` in its build config.
- In ESM use `import.meta.dirname`, `import.meta.filename`,
  `import.meta.url` and `createRequire(import.meta.url)` instead of the
  CommonJS locals. Load JSON with `fs` or `createRequire`, not ad hoc globals.
- Keep library entry points free of top-level `await`, so CommonJS consumers
  can `require()` them. Use TLA only in application entry modules.
- Use dynamic `import()` for optional or lazily loaded dependencies and to
  load ESM from CommonJS code that must still run on older Node versions.

Contracts and state

- A module's exports are its contract. Do not add, replace or delete
  properties of another module's exports at runtime (your own modules, npm
  packages or built-ins). That is monkey patching; every other importer sees
  it, and it hides the origin of bugs and security issues.
- Freeze aggregated objects you export (`Object.freeze`) when they are
  shared namespaces or configuration. In sloppy CommonJS a write to a frozen
  object fails silently; only strict code (ESM, TypeScript output) throws.
  Freezing prevents the change, it does not report it.
- Do not use a module as a mutable global store. If state is truly
  process-wide (connection pool, config), create it in one composition root
  and pass it on explicitly. Per-request data belongs in arguments or
  `AsyncLocalStorage` (see `node-async-context`), never in module scope.
- `delete require.cache[path]` is a dev-time trick only. Old references stay
  alive, and dependents keep the old instance. For reload in development use
  `node --watch`; in production restart the process.
- Treat circular imports as a design error. Extract the shared part into a
  third module, or pass the dependency as an argument. Never read an imported
  binding at module top level inside a cycle.

Packages

- Declare the public API with `exports`. Everything else becomes private
  (`ERR_PACKAGE_PATH_NOT_EXPORTED`). Add `"./package.json"` if tools read it.
  Keep `main` and `types` as a fallback for old tooling.
- In conditional exports put `"types"` first and `"default"` last; Node
  matches conditions in object order.
- Ship one implementation. A library is one CommonJS source; ESM consumers
  import it directly, and a thin ESM wrapper that re-exports it is added only
  when named imports cannot be detected. Keep module-level state out of
  anything that might be loaded twice.
- Use the `imports` field (`"#db": "./lib/db.js"`) for internal aliases
  instead of `../../..` chains or bundler-only path aliases.
- Set `engines.node` to the range you test in CI, and keep `files` an
  explicit allowlist of what ships. Release preparation is in `npm-publish`.

Dependencies

- **Library**: no runtime dependencies. A driver or host library is injected
  or declared in `peerDependencies`. **App**: dependencies are allowed, and
  the stack choices of its ADRs stand (Fastify, undici, Pino, BullMQ,
  `env-schema`).
- Before adding a package, check for a built-in: `fetch`,
  `crypto.randomUUID()`, `crypto.scrypt`, `AbortSignal.timeout()`,
  `structuredClone`, `util.parseArgs`, `util.styleText`, `fs.cp`, `fs.glob`,
  `--watch`, `AsyncLocalStorage`, `WebSocket` client, `node:sqlite` (still
  experimental in 24). The table in
  [references/dependencies.md](references/dependencies.md) lists replacements.
- For each new dependency check maintenance, transitive count
  (`pnpm list --depth Infinity`), install scripts, licence and size. Every
  dependency is attack surface and upgrade work.
- Commit `pnpm-lock.yaml`; never create `package-lock.json`. Install with
  `pnpm install --frozen-lockfile` in CI and production. Regenerate the
  lockfile in a separate commit from dependency upgrades, so reviews stay
  readable.
- Use caret ranges (`^1.2.3`) in libraries, let the lockfile pin applications.
  Use `peerDependencies` for plugins and host libraries the consumer must
  provide (mark optional ones in `peerDependenciesMeta`). Put `overrides` in
  `pnpm-workspace.yaml` to force a patched transitive version, and remove it
  once upstream catches up.
- Run `pnpm audit` and `pnpm outdated` regularly. pnpm does not run dependency
  install scripts unless the package is listed in `allowBuilds` in
  `pnpm-workspace.yaml`; approve each one deliberately. `minimumReleaseAge`
  there skips versions younger than the given number of minutes.

## Patterns

Library module in CommonJS: built-ins are prefixed, the export is created
once and nothing is exported mutable by accident.

```js
const fsp = require('node:fs/promises');
const path = require('node:path');

const readJson = async (filePath) => {
  const data = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(data);
};

const resolveConfig = (root, name) => path.join(root, 'config', `${name}.json`);

module.exports = { readJson, resolveConfig };
```

App module in ESM and TypeScript, with the replacements for CommonJS locals.

```ts
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const readJson = async (filePath: string): Promise<unknown> => {
  const data = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(data);
};

const configDir = path.join(import.meta.dirname, 'config');
const version: string = pkg.version;

export { readJson, configDir, version };
```

Composition root: one place creates the shared instances and wires
dependencies explicitly. Other modules export factories that receive their
dependencies; they do not `require` each other's singletons.

**Library or a plain process**: one `main.js`.

```js
const config = require('./config.js');
const { createLogger } = require('./lib/logger.js');
const { createDb } = require('./lib/db.js');
const { createUsers } = require('./domain/users.js');

const logger = createLogger(config.log);
const db = createDb(config.db, { logger });
const users = createUsers({ db, logger });

module.exports = Object.freeze({ config, logger, db, users });
```

**App on Fastify**: `src/main.ts` is the root, and the plugins are the wiring.
Autoload registers `plugins/` first, then `routes/`. Each infrastructure plugin
is wrapped in `fastify-plugin`, so its decorator reaches `routes/`, and it
names itself and declares what it needs. A route plugin is not wrapped and
stays encapsulated. The domain factory knows nothing about Fastify.

```ts
// src/main.ts
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import AutoLoad from '@fastify/autoload';

const main = async (fastify: FastifyInstance, options: FastifyPluginOptions) => {
  const { dirname } = import.meta;
  await fastify.register(AutoLoad, { dir: `${dirname}/plugins`, options });
  await fastify.register(AutoLoad, { dir: `${dirname}/routes`, options });
};

export default main;
```

```ts
// src/plugins/users.ts
import fp from 'fastify-plugin';

import { createUsers } from '../domain/users.ts';

declare module 'fastify' {
  interface FastifyInstance {
    users: ReturnType<typeof createUsers>;
  }
}

const usersPlugin = fp(
  async (fastify) => {
    const users = createUsers({ db: fastify.db, logger: fastify.log });
    fastify.decorate('users', users);
  },
  { name: 'users', dependencies: ['db'] },
);

export default usersPlugin;
```

A missing dependency fails at boot, naming the plugin, not at the first
request.

Optional dependency loaded lazily, distinguishing "not installed" from a real
failure inside the package. A missing transitive dependency has the same
`code`, so the name must match too.

```js
const loadOptional = async (name) => {
  try {
    return await import(name);
  } catch (error) {
    const isMissing = error.code === 'ERR_MODULE_NOT_FOUND';
    if (isMissing && error.message.includes(`'${name}'`)) return null;
    throw error;
  }
};

const pino = await loadOptional('pino');
const logger = pino ? pino.default() : console;
```

Library `package.json` with an explicit public surface and one CommonJS
implementation, the shape `npm-publish` audits.

```json
{
  "name": "@alexify/example",
  "version": "1.0.0",
  "main": "index.js",
  "types": "index.d.ts",
  "exports": {
    ".": {
      "types": "./index.d.ts",
      "default": "./index.js"
    },
    "./utils": {
      "types": "./src/utils.d.ts",
      "default": "./src/utils.js"
    }
  },
  "imports": {
    "#internal/*": "./src/internal/*.js"
  },
  "files": ["index.js", "index.d.ts", "src", "README.md", "CHANGELOG.md", "LICENSE"],
  "engines": { "node": ">=18.0.0" },
  "publishConfig": { "access": "public" }
}
```

App `package.json`: private, ESM, and built before it starts.

```json
{
  "name": "@example/api",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "fastify start -o dist/main.js"
  }
}
```

An ES module can choose what `require()` returns to CommonJS consumers with
the special export name `module.exports` (checked on Node 22.23, 24.14
and 26.13; check your minimum supported version):

```js
export class Client {}
export { Client as 'module.exports' };
```

Breaking a cycle: instead of `a.js` and `b.js` requiring each other, the
shared function moves to its own module, or the dependency is passed in.

```js
const createOrders = ({ users }) => ({
  async create(userId, items) {
    const user = await users.get(userId);
    return { user, items, createdAt: Date.now() };
  },
});

module.exports = { createOrders };
```

Module resolution, cycles, `require(esm)`, customisation hooks and error
codes are in [references/module-internals.md](references/module-internals.md).

## Interop cheat sheet

| From → to                 | How                                             | Notes                                                   |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| ESM imports CJS           | `import lib, { named } from './lib.cjs'`        | `default` is `module.exports`; named only if detectable |
| CJS requires ESM          | `const ns = require('./lib.mjs')`               | 20.19+/22.12+; no TLA; returns namespace (`ns.default`) |
| CJS loads ESM with TLA    | `const ns = await import('./lib.mjs')`          | inside an async function                                |
| ESM needs `require`       | `createRequire(import.meta.url)`                | for JSON, `.node` addons, CJS-only tools                |
| ESM needs `__dirname`     | `import.meta.dirname`                           | `import.meta.filename` for `__filename`                 |
| Check if name is built-in | `module.isBuiltin('node:fs')`                   | `process.getBuiltinModule('node:fs')` gets it sync      |
| Resolve without loading   | `require.resolve(name)` / `import.meta.resolve` | returns path / URL                                      |

## Anti-patterns

- `require('fs')` without `node:`: shadowable by `node_modules/fs`. Use
  `node:fs`.
- Patching a library from the outside (`fs.readFile = wrapped`,
  `Array.prototype.x = ...`, adding methods to another module's exports):
  changes behaviour for every importer. Wrap it in your own module instead.
- A "store" module that many modules mutate (`state.currentUser = user`):
  hidden coupling and race conditions under concurrency. Pass data
  explicitly, use an instance owned by the composition root, or
  `AsyncLocalStorage` for request context.
- A Fastify plugin that imports another plugin's singleton instead of
  declaring `dependencies` and reading its decorator.
- `require('./lib')` relying on `lib/index.js`, or extensionless relative
  imports: breaks in ESM and costs filesystem probes. Name the file.
- Deep imports into other packages (`pkg/lib/internal/x.js`): fails with
  `exports` and breaks on minor releases. Use the documented entry points.
- Two implementations (`index.cjs` + `index.mjs`) with module-level state:
  two singletons, `instanceof` across them fails. Keep one implementation.
- Top-level `await` in a library entry: breaks `require()` consumers with
  `ERR_REQUIRE_ASYNC_MODULE`.
- Fixing `ERR_REQUIRE_ESM` by pinning an old major forever, or by bundling
  ESM into CJS by hand: upgrade Node to 20.19+/22.12+/24 or use `import()`.
- Adding a dependency for one small function (`left-pad`, `uuid`,
  `node-fetch`, `rimraf`): use the built-in.
- `pnpm install` without `--frozen-lockfile` in CI or Docker builds, or an
  npm command that leaves a `package-lock.json`.

## Checklist

- [ ] Every built-in import uses the `node:` prefix.
- [ ] Library is CommonJS with a `.d.ts`; app is ESM and TypeScript (NodeNext).
- [ ] A new `package.json` sets `"type"`; `.cjs`/`.mjs` only for exceptions.
- [ ] Relative specifiers include file extensions; no implicit `index.js`.
- [ ] No ESM file uses `require`, `module`, `__dirname`, `__filename` directly.
- [ ] Library entry points have no top-level `await`.
- [ ] No code mutates exports of other modules or built-in prototypes.
- [ ] No module-level mutable state used as a cross-module store; shared
      instances are created in one composition root and passed explicitly.
- [ ] Fastify plugins declare `name` and `dependencies`; routes stay encapsulated.
- [ ] No circular imports (check warnings: "inside circular dependency").
- [ ] Libraries declare `exports` (types first, default last), `files`,
      `engines`, and have a single implementation.
- [ ] `pnpm-lock.yaml` committed; CI uses `--frozen-lockfile`; `pnpm audit`
      reviewed; every `allowBuilds` entry is deliberate.
- [ ] Every dependency is justified; built-in alternatives checked.
- [ ] Plugins/host libraries are `peerDependencies`, not `dependencies`.

Related skills: `node-tooling-testing`, `node-async-context`, `node-security`,
`node-layered-architecture`, `npm-publish`, `js-conventions`
