# package.json, dual packages, workspaces and dependency hygiene

Reference for `node-modules-packages`. Release steps (version bump,
CHANGELOG, `pnpm pack --dry-run`) live in the `npm-publish` skill.

## package.json fields that change runtime behaviour

| Field                  | Effect                                                                      | Advice                                                   |
| ---------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `type`                 | how `.js` files are parsed (`commonjs` default, or `module`)                | set it in a new package                                  |
| `main`                 | entry for `require('pkg')` when there is no `exports`                       | keep as fallback for old tools                           |
| `exports`              | the only reachable entry points; conditions per environment                 | declare every public subpath                             |
| `imports`              | private `#aliases` inside the package                                       | replace deep relative paths                              |
| `types` / `typings`    | entry `.d.ts` for TypeScript when `exports` has no `types` condition        | keep in sync with `exports`                              |
| `browser`              | bundler substitution map (`metaschema` maps `index.js` to `browser.js`)     | only for packages used in browsers                       |
| `engines.node`         | supported Node range; warns (errors with `engine-strict`)                   | match the CI matrix                                      |
| `files`                | allowlist of published files                                                | `src`, entry files, `.d.ts`; never tests or configs      |
| `bin`                  | CLI executables                                                             | file starts with `#!/usr/bin/env node`                   |
| `scripts`              | lifecycle and custom commands                                               | see `node-tooling-testing`                               |
| `dependencies`         | runtime deps                                                                | none in a library, minimal in an app                     |
| `devDependencies`      | build/test/lint tools                                                       | never needed at runtime                                  |
| `peerDependencies`     | host library the consumer provides (plugins, adapters, a driver)            | widest compatible range; `peerDependenciesMeta.optional` |
| `optionalDependencies` | install may fail without failing the whole install                          | platform-specific binaries                               |
| `overrides`            | force transitive versions; with pnpm it lives in `pnpm-workspace.yaml`      | temporary security fixes; document why                   |
| `private: true`        | prevents an accidental publish                                              | set for applications                                     |

## exports patterns

```json
{
  "exports": {
    ".": "./lib/index.js",
    "./utils": "./lib/utils.js",
    "./features/*": "./lib/features/*.js",
    "./internal/*": null,
    "./package.json": "./package.json"
  }
}
```

- Subpath patterns (`*`) map whole groups; `null` hides a subtree.
- Conditions are matched in object order. Common ones: `types` (TypeScript,
  put first), `import`, `require`, `node`, `browser`, `default` (last).
  Custom conditions are enabled with `node -C development` /
  `--conditions=development`.
- `exports` also enables self-reference: inside the package,
  `require('example-lib/utils')` works.
- Adding `exports` to an existing package is a breaking change for anyone
  who deep-imported internal files: release it as a major.

## Dual packages without the hazard

Problem: `"import": "./index.mjs"` and `"require": "./index.cjs"` load two
independent copies. Singletons, caches, registries and `instanceof` break
when an application (or two of its dependencies) uses both forms.

Options, best first for an `@alexify` library:

1. One CommonJS implementation. ESM consumers import it directly, and named
   imports work when `module.exports = { a, b }` is statically detectable.
2. CommonJS implementation plus an ESM wrapper that re-exports it, so there
   is one instance:

   ```js
   // lib/index.mjs
   import lib from './index.cjs';

   export const { connect, Client } = lib;
   export default lib;
   ```

   ```json
   {
     "type": "commonjs",
     "exports": {
       ".": {
         "types": "./lib/index.d.ts",
         "import": "./lib/index.mjs",
         "default": "./lib/index.cjs"
       }
     }
   }
   ```

3. Two builds from one source only for code without module-level state, and
   only when old Node versions must be supported.

ESM-only needs `engines.node` `^20.19.0 || ^22.12.0 || >=24` for `require()` to
reach it, which is above the Node.js 18 floor of `metaschema` and `kerberos`.

A browser entry is not a hazard: `metaschema` maps `index.js` to `browser.js`
through the `browser` field and a `browser` export condition, and that build
never runs in the same process as the Node one.

## Workspaces (monorepo basics)

Workspaces live in `pnpm-workspace.yaml`, not in `package.json`.

```yaml
packages:
  - 'apps/*'
  - 'packages/*'

catalog:
  fastify: ^5.8.0

allowBuilds:
  esbuild: true
```

- `pnpm install` links every workspace; one lockfile at the root.
- Add a dependency to one package: `pnpm --filter @example/db add mongodb`.
- Run a script in one package: `pnpm --filter @example/api run build`.
- Reference sibling packages with `workspace:*`, and shared versions with
  `catalog:`, never by relative path into another package's sources.
- Keep shared configs (`.oxlintrc.json`, `.oxfmtrc.json`, `tsconfig.base.json`)
  at the root. `auth8` orchestrates targets with Nx.
- The `@alexify` libraries are a polyrepo of small packages with the same
  tooling; a monorepo is a team choice, not a requirement.

## Dependency hygiene commands

| Task                                 | Command                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| Reproducible install (CI, Docker)    | `pnpm install --frozen-lockfile` (`--prod` for an image)  |
| Why is this package here             | `pnpm why <pkg>`                                          |
| Size of the tree                     | `pnpm list --depth Infinity`                              |
| Known vulnerabilities                | `pnpm audit` (`--prod` for runtime only)                  |
| Outdated packages                    | `pnpm outdated`                                           |
| Exact version for a new dependency   | `pnpm add --save-exact <pkg>`                             |
| Do not run install scripts           | The default; allow one in `allowBuilds`                   |
| Review blocked install scripts       | `pnpm approve-builds`                                     |
| Skip versions younger than N minutes | `minimumReleaseAge: <minutes>` in `pnpm-workspace.yaml`   |
| Force a transitive version           | `overrides:` in `pnpm-workspace.yaml`                     |

Semver reminders: `^1.2.3` allows `<2.0.0`; `^0.2.3` allows only `<0.3.0`;
`~1.2.3` allows `<1.3.0`. A lockfile pins the whole tree; ranges only matter
when the lockfile is regenerated or the package is installed as a
dependency of something else.

## Built-ins that replace common dependencies

| Instead of                        | Use (Node 22/24)                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `request`, `axios`, `node-fetch`  | App: `undici`. Library: global `fetch`, or an injected client                       |
| `uuid`                            | `crypto.randomUUID()`                                                               |
| `bcrypt`                          | `crypto.scrypt` (or `argon2` when required)                                         |
| `mocha`, `jest`, `ava`, `tap`     | Library: `node:test` + `node:assert/strict`. App: Vitest                            |
| `nodemon`                         | `node --watch`                                                                      |
| `dotenv`                          | `node --env-file=.env`, `process.loadEnvFile()`; an app validates with `env-schema` |
| `rimraf`, `mkdirp`, `ncp`         | `fs.rm({ recursive: true, force: true })`, `fs.mkdir({ recursive: true })`, `fs.cp` |
| `glob`                            | `fs.glob` / `fs.promises.glob`                                                      |
| `chalk`, `colors`                 | `util.styleText()`                                                                  |
| `yargs`, `minimist` (simple CLIs) | `util.parseArgs()`                                                                  |
| `moment`                          | `Intl` and `Date` (Temporal where available)                                        |
| `ejs` and small template engines  | template literals                                                                   |
| `zone.js`, `cls-hooked`, `domain` | `AsyncLocalStorage`                                                                 |
| `socket.io` (client side)         | `ws` on the server + native `WebSocket` client                                      |
| `pm2`, `forever`                  | containers / systemd restart policies                                               |
| `koa`, `connect`                  | Fastify                                                                             |
| `lodash.clonedeep`                | `structuredClone()`                                                                 |
| `ts-node` for simple scripts      | type stripping (`node file.ts`), see `node-tooling-testing`                         |
