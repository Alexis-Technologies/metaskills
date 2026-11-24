---
name: node-tooling-testing
description: Set up Node.js quality gates, tests and CI. Use for node:test, c8, tsd, Vitest, Playwright, k6, oxlint, oxfmt, type checks or a Node.js upgrade
---

# Node.js Tooling, Testing and CI

With this skill the agent finds the project's real gates and runs them the
same way locally and in CI, writes deterministic tests against public
contracts, and treats types as a checked contract rather than a build step.

## Project profile

|                   | Library `@alexify/*`                     | App (`auth8`)                 |
| ----------------- | ---------------------------------------- | ----------------------------- |
| Unit, integration | `node:test`, `node:assert/strict`        | Vitest                        |
| Coverage          | c8 with thresholds                       | `vitest run --coverage`       |
| Types             | Handwritten `.d.ts`, tsd, `tsc --noEmit` | TypeScript, `tsc --noEmit`    |
| HTTP in tests     | Real server on port `0`                  | `fastify.inject()`            |
| E2E, load         | None                                     | Playwright; autocannon and k6 |
| Gate              | `prepublishOnly` and CI                  | Nx targets and CI             |
| Lint, format      | oxlint, oxfmt                            | oxlint, oxfmt                 |
| Width             | `.oxfmtrc.json` (100 or 120)             | 120                           |

Read `package.json`, `.github/workflows/ci.yml`, `.oxlintrc.json` and
`.oxfmtrc.json` first: the project's configuration wins. The package manager
is pnpm. Never add ESLint or Prettier.

## Defaults

- **Library**: use what Node ships: `node:test` + `node:assert`, `--watch`,
  `--env-file`, and a handwritten `.d.ts` instead of a TypeScript build.
- **App**: one runner, Vitest, for unit, integration and Vue component tests,
  Playwright for user flows, autocannon for a quick throughput check and k6
  for load scenarios. Do not switch an app to `node:test`.
- Pure functions get table-driven tests (inputs, expected output, case
  name): positive, negative and boundary cases become visible in one table.
- Integration matters more than isolated mocks for system code: call the
  whole application through its public protocol.
- By default write tests once the structure has settled, since they slow down
  exploratory refactoring of class structure. A bug fix or security-critical
  code gets its test first. Async abstractions (queues, pools, semaphores)
  need stress tests with many concurrent runs to expose races and leaks.

## Rules

Quality gate and scripts

- Do not assume a list of gates: they differ per package. Read
  `prepublishOnly` and the CI workflow, and run each command. A library gate
  looks like this:

  ```json
  {
    "scripts": {
      "test": "node --test tests/unit/*.test.js",
      "test:coverage": "c8 --all --include 'src/**' --check-coverage --lines 98 --statements 98 --branches 90 --functions 100 --reporter text --reporter lcov node --test tests/unit/*.test.js",
      "test:types": "tsd",
      "check:dts": "tsc --noEmit --strict --target es2022 --skipLibCheck false index.d.ts",
      "lint": "oxlint index.js src tests scripts",
      "format": "oxfmt index.js src tests scripts",
      "format:check": "oxfmt --check index.js src tests scripts",
      "prepublishOnly": "pnpm run lint && pnpm run format:check && pnpm run test:coverage && pnpm run test:types && pnpm run check:dts"
    },
    "tsd": { "directory": "tests/types" }
  }
  ```

- An app package exposes the same names to Nx: `test`, `test:cov`,
  `test:integration`, `test:load`, `lint`, `lint:fix`, `format`,
  `format:check`, `typecheck`, `build`. Run them through the root
  (`pnpm run test`, `pnpm run typecheck`; the `:af` variants for affected
  projects).
- Run `pnpm format`, then lint and tests, before and after any change.
- Use `node --run <script>` for fast local runs of simple scripts; it skips
  `pre`/`post` hooks, so CI keeps `pnpm run`.
- Never add `--test-force-exit` or `process.exit()` to hide leaked handles;
  close servers, timers, sockets and pools in `after` hooks.

Tests

- Test the public contract of a module, not its private fields.
- **Library**: `node:test` (`describe`/`it`) and `node:assert/strict`, in
  `tests/unit/*.test.js`.
- **App**: Vitest in `src/**/tests/*.test.ts`. `describe` names the subject,
  every title starts with `should` plus the observable behaviour, and the
  body follows Arrange, Act, Assert, visibly separated. E2E lives in `e2e/`
  and load scripts in `load/`.
- Assert errors precisely: `assert.throws(fn, { code, name, message })`,
  `await assert.rejects(promise, { code: 'ETIMEOUT' })`,
  `await expect(promise).rejects.toMatchObject({ code })`. Never
  `try { ... } catch {}` without a failing assertion.
- No real waiting, clock, network or randomness: use `mock.timers` or
  `vi.useFakeTimers()`, inject clocks and ids, and keep
  `AbortSignal.timeout()` as a safety net on network calls.
- Prefer fakes passed through dependency injection (factory arguments,
  constructors, ports) over module mocking. Use `mock.fn`, `t.mock.method`
  or `vi.fn` for spies. `vi.mock` and `mock.module` (which needs
  `--experimental-test-module-mocks`) only for code you cannot inject into.
- Integration tests. **Library**: listen on port `0`, read
  `server.address().port`, call with `fetch` or the real client, close in
  `after`. **App**: build the Fastify instance with fakes and call
  `app.inject()`, with no socket and no port; use a real server only when the
  transport itself is under test. When the query matters, run a real database
  (`mongodb-memory-server` in `auth8`) instead of mocking the driver.
- Snapshots only for stable structural output (API introspection, generated
  schemas). Commit them and regenerate deliberately.
- Coverage is a signal: thresholds live in the gate, and tests are not
  written only to raise numbers.
- Use `--watch` while developing; `--test-name-pattern` and `--test-only` (or
  `vitest -t`) to focus; `--test-shard=i/n` to split slow suites in CI.

Lint and format

- oxlint (`.oxlintrc.json`) and oxfmt (`.oxfmtrc.json`, `.editorconfig`), in
  libraries and apps. oxlint holds no stylistic rules: formatting belongs to
  oxfmt alone.
- Fix `unicorn/no-nested-ternary` with `if`/`else` or a named value. Oxfmt
  strips grouping parentheses, so a parens-only fix comes back on the next
  format.
- Suppress a rule only for an intentional construct, with
  `// oxlint-disable-next-line <rule>`. Style follows `js-conventions`.
- oxlint and oxfmt declare `engines` of Node.js 20.19+ or 22.12+, so run them
  once on a current Node.js and not across a matrix that reaches 18.

Types

- **Library**: ship a handwritten `.d.ts`, point `types` (and the `types`
  export condition) at it, include it in `files`, compile it with `check:dts`
  and test it with tsd in `tests/types/*.test-d.ts` (`expectType`,
  `expectError`). Review it with the exports in the same PR.
- **App**: TypeScript with `strict`, `module: NodeNext`,
  `verbatimModuleSyntax` and `tsc --noEmit` in `typecheck`. Use `as const`
  objects, not `enum`.
- JSDoc only when very short and to the point. It does not replace `.d.ts`.
- Keep `typescript` and `@types/node` in `devDependencies`; match
  `@types/node` to the lowest Node major you support, so typings do not
  promise APIs that older runtimes lack.
- TypeScript run directly by Node (22.18+, 24): type stripping removes types
  but never checks them, so `tsc --noEmit` stays in the gate. Use only
  erasable syntax: no `enum`, `namespace` with code, parameter properties,
  `import =`; write `import type` for type-only imports and full `.ts`
  extensions in relative imports; `tsconfig` paths are ignored; `.ts` files
  inside `node_modules` are not stripped.
- Use a real build (`tsc`) to publish or deploy compiled JS. An app sets
  `rewriteRelativeImportExtensions` in its build config.

Runtime tooling

- `node --watch` (and `--watch-path`) is for development only. In
  production rely on the supervisor (container restart policy, systemd);
  the process must shut down gracefully on `SIGTERM`, which is also what
  `--watch` sends on restart (see `node-graceful-shutdown`).
- `--env-file=.env` for local development only. Real environment variables
  win over the file, later `--env-file` flags override earlier ones, and
  `--env-file-if-exists` tolerates a missing file. Never commit secrets;
  commit `.env.example`. An app validates its config with one schema and
  has no `NODE_ENV` branches (`node-config`).
- Single executable applications: steps and caveats in
  [references/ci-types-release.md](references/ci-types-release.md).

CI and upgrades

- CI runs `pnpm install --frozen-lockfile` and the project's gates on every
  pull request. A library tests every Node line in `engines.node`; an app
  runs on its one Node version. Cache pnpm via `actions/setup-node`.
- Upgrade Node in a dedicated PR with a checklist: bump CI matrix and
  `engines`, regenerate the lockfile in its own commit, run once with
  `--throw-deprecation` and `--pending-deprecation`, remove flags that became
  defaults, replace dependencies with new built-ins, then adopt new APIs.

## Patterns

Library: table-driven unit test.

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { ipToInt } = require('../../src/net.js');

const CASES = [
  { ip: '127.0.0.1', expected: 2130706433, name: 'localhost' },
  { ip: '10.0.0.1', expected: 167772161, name: 'class A network' },
  { ip: '192.168.1.10', expected: -1062731510, name: 'negative number' },
  { ip: '0.0.0.0', expected: 0, name: 'four zeros' },
  { ip: '255.255.255.255', expected: -1, name: 'four 255' },
];

describe('ipToInt', () => {
  for (const { ip, expected, name } of CASES) {
    it(`converts ${name}`, () => {
      assert.equal(ipToInt(ip), expected);
    });
  }

  it('rejects wrong input', () => {
    assert.throws(() => ipToInt(42), { name: 'TypeError' });
    assert.throws(() => ipToInt('1.2.3'), { message: 'Wrong IPv4 format' });
  });
});
```

Library: timers and spies without real waiting.

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSessions } = require('../../src/session.js');

test('session expires after ttl', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const storage = { save: t.mock.fn(async () => true), delete: t.mock.fn() };
  const sessions = createSessions({ storage, ttlMs: 1000 });
  await sessions.start('token1', { userId: 1 });
  assert.equal(storage.save.mock.callCount(), 1);
  t.mock.timers.tick(999);
  assert.ok(sessions.has('token1'));
  t.mock.timers.tick(1);
  assert.ok(!sessions.has('token1'));
  assert.equal(storage.delete.mock.callCount(), 1);
});
```

App: a route through `inject`, with AAA and a fake service.

```ts
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usersRoutes } from '../users.routes.ts';

describe('GET /users/:id', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
  });

  it('should return the user found by the service', async () => {
    // Arrange
    const users = { get: vi.fn(async (id: string) => ({ id, name: 'Marcus' })) };
    app = Fastify();
    app.decorate('users', users);
    await app.register(usersRoutes);

    // Act
    const response = await app.inject({ method: 'GET', url: '/users/7' });

    // Assert
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: '7', name: 'Marcus' });
    expect(users.get).toHaveBeenCalledWith('7');
  });
});
```

More recipes:

- [references/node-test-cookbook.md](references/node-test-cookbook.md): hooks,
  `t.plan`, mocks, snapshots, c8, reporters, a real HTTP server on port `0`,
  stress tests, CLI tests.
- [references/app-testing.md](references/app-testing.md): Vitest config, names,
  fakes, coverage, fake clocks, `inject`, MongoDB integration, benchmarks.
- [references/e2e-load.md](references/e2e-load.md): Playwright, autocannon, k6
  and the load profiles.
- [references/ci-types-release.md](references/ci-types-release.md): oxlint and
  oxfmt configs, GitHub Actions, `.d.ts` and tsd, `tsconfig`, SEA, the Node
  upgrade checklist.

## Anti-patterns

- Jest, Mocha, ts-node or nodemon added to a project: extra dependencies and
  transforms that differ from runtime. A library uses the built-ins, an app
  uses Vitest.
- ESLint, Prettier or stylistic lint rules next to oxfmt: two sources of
  truth for one concern.
- `setTimeout(..., 1000)` or `await sleep()` in tests: slow and flaky. Use
  fake timers or events (`await once(emitter, 'ready')`).
- Tests that share state through module scope or depend on execution order:
  pass fresh fixtures to each test; reset in `beforeEach`.
- `vi.mock` of an own module where a port could take a fake.
- A real listening port in an app route test where `inject` does the job.
- Mocking everything around the unit, including the database and HTTP:
  tests pass while integration breaks. Keep a layer of integration tests
  through the real protocol.
- Custom test runners with `process.exit(failed ? 1 : 0)`: the runner already
  gives isolation, timeouts, async support and exit codes.
- `.d.ts` written once and never checked: add `check:dts` and tsd to the gate
  and review typings with every API change.
- Shipping `.ts` sources to npm for consumers to strip: Node does not strip
  types inside `node_modules`; publish JS + `.d.ts`.
- `--watch` or `--env-file` in production start scripts.
- CI that runs only on the newest Node, or `engines` wider than the matrix.
- Upgrading Node, regenerating the lockfile and bumping dependencies in one
  commit: impossible to bisect or review.

## Checklist

- [ ] The gates were read from `prepublishOnly` and CI, run, and are green.
- [ ] Linting is oxlint, formatting is oxfmt, and no stylistic lint rules.
- [ ] Library tests use `node:test` + c8; app tests use Vitest.
- [ ] App tests: `should` titles, AAA, DI fakes, `inject` for routes.
- [ ] No real sleeps, clock or randomness; network calls have a timeout.
- [ ] Every test closes what it opens (servers, timers, pools, watchers).
- [ ] Pure functions have table-driven cases incl. negative and boundary inputs.
- [ ] At least one integration test exercises the real transport or `inject`.
- [ ] Error assertions check `code`/`name`/`message`, not just "throws".
- [ ] `.d.ts` checked by `check:dts` and tsd; `types` and `files` point at it.
- [ ] TS run by Node uses erasable syntax only, `import type`, `.ts` extensions.
- [ ] CI uses `--frozen-lockfile` on all lines of `engines`.
- [ ] `--watch`, `--env-file`, snapshots update flags never used in production.
- [ ] Node upgrades done via the checklist in a separate PR.

Related skills: `node-modules-packages`, `node-graceful-shutdown`,
`error-handling`, `js-conventions`, `npm-publish`
