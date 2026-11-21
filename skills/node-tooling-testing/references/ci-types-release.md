# CI, lint configs, typings, runtime tooling, SEA and Node upgrades

Reference for `node-tooling-testing`. Release preparation (version bump,
CHANGELOG, `pnpm pack --dry-run`, publish) is covered by the `npm-publish`
skill.

## oxlint and oxfmt

`.oxfmtrc.json`. `printWidth` is 100 or 120, by project (`auth8` uses 120).

```json
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "semi": true,
  "singleQuote": true,
  "printWidth": 100,
  "trailingComma": "all",
  "sortPackageJson": false,
  "ignorePatterns": []
}
```

`.oxlintrc.json`, trimmed. There are no stylistic rules. The array-method ban
applies to `src/`, so tests, scripts and benchmarks turn it off.

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["node", "promise", "import"],
  "categories": { "correctness": "error", "suspicious": "error" },
  "env": { "builtin": true, "es2026": true, "node": true },
  "ignorePatterns": ["node_modules", "coverage", "dist", "**/*.d.ts", "**/*.test-d.ts"],
  "rules": {
    "no-var": "error",
    "no-restricted-properties": [
      "error",
      { "property": "forEach", "message": "Use a loop." },
      { "property": "map", "message": "Use a loop." },
      { "property": "filter", "message": "Use a loop." },
      { "property": "reduce", "message": "Use a loop that does the work in one pass." }
    ]
  },
  "overrides": [
    {
      "files": ["tests/**", "scripts/**", "bench/**"],
      "rules": { "no-restricted-properties": "off", "no-console": "off" }
    }
  ]
}
```

- `oxlint --report-unused-disable-directives-severity=error` keeps stale
  suppressions out.
- Set `categories` deliberately. With `"correctness": "off"` (as in `auth8`) new
  rules of a future oxlint are not enabled automatically, so revisit the file
  on upgrade.

## Scripts

| Script          | Library                                                |
| --------------- | ------------------------------------------------------ |
| `test`          | `node --test tests/unit/*.test.js`                     |
| `test:coverage` | `c8 ... node --test tests/unit/*.test.js`              |
| `test:types`    | `tsd`                                                  |
| `check:dts`     | `tsc --noEmit --strict --target es2022 index.d.ts`     |
| `lint`          | `oxlint <paths>`                                       |
| `format`        | `oxfmt <paths>`                                        |
| `format:check`  | `oxfmt --check <paths>`                                |
| `prepublishOnly`| every gate above that the package has                  |

| Script             | App package                                       |
| ------------------ | ------------------------------------------------- |
| `dev`              | `fastify start -o --watch src/main.ts`            |
| `build`            | `tsc -p tsconfig.build.json`                      |
| `start`            | `fastify start -o dist/main.js`                   |
| `test`             | `vitest run`                                      |
| `test:cov`         | `vitest run --coverage`                           |
| `test:integration` | `vitest run --config vitest.integration.config.ts`|
| `lint`, `lint:fix` | `oxlint src`, `oxlint src --fix`                  |
| `format`           | `oxfmt src`                                       |
| `format:check`     | `oxfmt --check src`                               |
| `typecheck`        | `tsc --noEmit`                                    |

## GitHub Actions

A library: lint and types once, tests across `engines`.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format:check
      - run: pnpm run test:types
      - run: pnpm run check:dts

  test:
    runs-on: ${{ matrix.os }}
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node-version: [18, 20, 22, 24]
        exclude:
          - os: windows-latest
            node-version: 18
          - os: windows-latest
            node-version: 20
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test

  coverage:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run test:coverage
```

- Matrix = every Node line you claim in `engines.node`.
- oxlint and oxfmt declare `engines` of Node.js 20.19+ or 22.12+, so they stay
  out of a matrix that includes 18.
- Keep Windows in the matrix for libraries that touch paths, fs or processes.
- Add one aggregate job (`needs: [...]`, failing on any failed or skipped
  need) and require only it in branch protection, so a new matrix leg is not
  silently un-required.

An app (`auth8`) runs one Node version, in this order:

```yaml
steps:
  - uses: actions/checkout@v5
  - uses: pnpm/action-setup@v4
  - uses: actions/setup-node@v5
    with:
      node-version: 24
      cache: pnpm
  - run: pnpm install --frozen-lockfile
  - run: pnpm run lint
  - run: pnpm run format:check
  - run: pnpm run typecheck
  - run: pnpm run build
  - run: pnpm run test
```

Integration tests on `mongodb-memory-server` need no service container.

## Typings for JavaScript

Handwritten declaration next to a CommonJS entry:

```ts
import { IncomingMessage } from 'node:http';

export interface LimitControl {
  fn: (...args: Array<unknown>) => void;
  cancel: () => void;
  flush: () => void;
}

export function delay(msec: number, signal?: AbortSignal): Promise<void>;
export function throttle(fn: () => void, msec: number): LimitControl;
export function parseCookies(req: IncomingMessage): Record<string, string>;
```

```json
{
  "main": "index.js",
  "types": "index.d.ts",
  "files": ["index.js", "index.d.ts", "src"]
}
```

Type tests with tsd, in `tests/types/*.test-d.ts`, with
`"tsd": { "directory": "tests/types" }` in `package.json`:

```ts
import { expectError, expectType } from 'tsd';

import { delay } from '../../index.js';

expectType<Promise<void>>(delay(100));
expectError(delay('100'));
```

`check:dts` compiles the declarations on their own, because nothing else
compiles a handwritten surface:

```bash
tsc --noEmit --strict --target es2022 --skipLibCheck false index.d.ts
```

`tsconfig.json` that only checks a handwritten `.d.ts`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["*.d.ts"]
}
```

App `tsconfig.base.json` (trimmed from `auth8`). `tsconfig.json` adds
`"noEmit": true` and `"allowImportingTsExtensions": true`; `tsconfig.build.json`
adds `"outDir"` and `"rewriteRelativeImportExtensions": true`.

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "types": ["node"]
  }
}
```

`tsconfig.json` for TypeScript executed directly by Node's type stripping:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "noEmit": true,
    "strict": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true
  }
}
```

## TypeScript type stripping (Node 22.18+, 24)

- `node file.ts` works without flags; `process.features.typescript` is
  `'strip'`. Format follows the same rules as JS (`.mts`, `.cts`, `"type"`).
- Types are replaced with whitespace, so stack traces keep line and column
  numbers without source maps.
- Not supported in strip mode (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`):
  `enum`, `namespace` with runtime code, parameter properties
  (`constructor(private x: number)`), `import x = require()`, legacy
  decorators. `--experimental-transform-types` enables the first ones but is
  experimental; prefer plain objects with `as const` and explicit fields.
- `import { User } from './types.ts'` where `User` is an interface fails at
  runtime ("does not provide an export named"); write `import type`.
  `verbatimModuleSyntax` makes `tsc` enforce this.
- Relative imports need the real extension (`./service.ts`); tsconfig
  `paths` and `baseUrl` are ignored; use package `imports` (`#lib/*`).
- `.ts` files under `node_modules` are not stripped: publish compiled JS
  and `.d.ts`.
- Type checking still needs `tsc --noEmit`; `erasableSyntaxOnly` (TS 5.8+)
  makes `tsc` reject syntax Node cannot strip.

## Runtime tooling

```bash
node --watch --watch-path=./src --watch-preserve-output server.js
node --env-file=.env --env-file-if-exists=.env.local server.js
node --run test
```

- `--watch` restarts the process on change of any imported file (or the
  `--watch-path` directories) and sends `SIGTERM` first; handle it for clean
  restarts.
- In code: `process.loadEnvFile('.env')` and `util.parseEnv(text)` parse the
  same format. Variables already in the environment are not overwritten by
  the file.
- `node --run <script>` runs a `package.json` script without npm; it does not
  run `pre`/`post` scripts.
- `module.enableCompileCache()` (or `NODE_COMPILE_CACHE=dir`) speeds up
  startup of large CLIs.

## Single executable application (Node 24)

```json
{
  "main": "dist/app.js",
  "output": "sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useCodeCache": true,
  "assets": { "config.json": "config/default.json" }
}
```

```bash
node --experimental-sea-config sea-config.json
cp "$(command -v node)" app
# macOS only:
codesign --remove-signature app
pnpm dlx postject app NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA
codesign --sign - app
# Linux: same postject command without --macho-segment-name
./app
```

- The entry must be one script: bundle the application first (esbuild,
  rollup). In Node 24 the entry is treated as CommonJS; check the docs of
  your version for ESM entry support.
- Inside the SEA `require()` resolves only built-ins; use
  `createRequire(__filename)` for files on disk and `node:sea`
  (`isSea()`, `getAsset()`, `getAssetAsBlob()`) for embedded assets.
- Build the blob with the same Node binary you inject into; one binary per
  OS/CPU. `useCodeCache` output is platform-specific.
- SEA is still marked experimental; keep a plain `node app.js` path.
- Node 26 (not 24): `node --build-sea sea-config.json` injects the blob
  into a copy of the running binary and writes `output` as the executable
  in one step (verified on 26.13; re-sign on macOS if needed).

## Node.js upgrade checklist

When the oldest LTS line reaches end of life, list (1) deprecated APIs to replace, (2) new APIs now available
in every supported line, (3) features still experimental in at least one
supported line (do not depend on them yet), (4) dependencies that built-ins
can replace. Applied to moving to Node 22/24:

1. Bump `engines.node`, CI matrix, `.nvmrc`/`.node-version`, Docker base
   image, `@types/node`. One PR for the upgrade alone.
2. `pnpm install --frozen-lockfile` on the new version; if the lockfile must
   change, regenerate it in a separate commit, dependency bumps in another.
3. Run tests once with `--throw-deprecation` and `--pending-deprecation`
   (`NODE_OPTIONS="--throw-deprecation" pnpm test`) and replace every hit, for
   example `url.parse()` (DEP0169) → `new URL()`.
4. Remove flags that became defaults: `--experimental-strip-types`,
   `--experimental-require-module`, `--experimental-detect-module`,
   `--experimental-websocket`, old `--experimental-fetch` style flags. Keep
   ones still needed (`--experimental-test-coverage`,
   `--experimental-test-module-mocks`, `--experimental-sea-config`).
5. Syntax: import assertions `assert { type: 'json' }` no longer parse; use
   `with { type: 'json' }`.
6. Modules: add `node:` prefixes everywhere, keep one implementation per
   package (see `node-modules-packages`).
7. Replace dependencies with built-ins (table in the `node-modules-packages`
   skill).
8. Adopt, where they simplify code: `fetch`, `AbortSignal.timeout()` and
   `AbortSignal.any()`, `Promise.withResolvers()`, `Object.groupBy()`, Set
   methods, iterator helpers, `using` / `Symbol.dispose` (24), `URLPattern`
   (24), `RegExp.escape` (24), `node:test` features, `--env-file`, `--watch`,
   `node --run`, the permission model (`--permission`).
9. Unhandled promise rejections terminate the process (since Node 15):
   make sure every promise chain is handled; see `error-handling`.
