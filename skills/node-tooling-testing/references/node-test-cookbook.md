# node:test cookbook

Reference for `node-tooling-testing`, for libraries. Apps use Vitest: see
`app-testing.md`. Every recipe was run on Node.js 24.14.

## CLI flags (Node 24)

| Flag                                                    | Purpose                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `node --test [globs...]`                                | run test files; without globs uses default discovery (below) |
| `--test --watch`                                        | re-run affected tests on change                              |
| `--test-name-pattern=<re>` / `--test-skip-pattern=<re>` | filter by test name                                          |
| `--test-only`                                           | run only tests marked `{ only: true }` / `test.only`         |
| `--test-concurrency=<n>`                                | number of test files run in parallel                         |
| `--test-isolation=process\|none`                        | each file in its own process (default) or all in one         |
| `--test-timeout=<ms>`                                   | default timeout per test                                     |
| `--test-shard=<i>/<n>`                                  | split files across CI jobs                                   |
| `--test-reporter=<spec\|tap\|dot\|junit\|lcov>`         | output format; repeat with `--test-reporter-destination`     |
| `--experimental-test-coverage`                          | collect coverage                                             |
| `--test-coverage-lines/branches/functions=<pct>`        | fail (exit 1) when coverage is below the threshold           |
| `--test-coverage-include/exclude=<glob>`                | limit the report                                             |
| `--test-update-snapshots`                               | write/refresh `*.snapshot` files                             |
| `--experimental-test-module-mocks`                      | enable `mock.module()`                                       |
| `--test-global-setup=<file>`                            | module with global setup/teardown for the whole run          |
| `--test-force-exit`                                     | exit even if handles are open (last resort, hides leaks)     |

Default discovery (no globs): `**/*.test.{js,mjs,cjs}`, `**/*-test.*`,
`**/*_test.*`, `**/test-*.*`, `**/test.*`, and every file under `**/test/`;
with type stripping, the same patterns with `.ts`/`.mts`/`.cts`.
`node_modules` is skipped. Alexis libraries name the files explicitly
(`node --test tests/unit/*.test.js`). Before Node.js 21 the shell expands that
glob, which `cmd.exe` does not do, so Windows runs only on Node.js 22+.

Multiple reporters at once (CI artefacts plus readable output):

```bash
node --test --experimental-test-coverage \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=lcov --test-reporter-destination=lcov.info \
  --test-reporter=junit --test-reporter-destination=junit.xml
```

## Structure, hooks, plan, skip and todo

```js
const { describe, it, before, after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');

describe('users repository', () => {
  let db = null;

  before(async () => {
    db = await openTestDatabase();
  });

  after(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.truncate('users');
  });

  it('creates a user', async () => {
    const id = await db.insert('users', { login: 'marcus' });
    assert.equal(typeof id, 'number');
  });
});

test('plan counts assertions, including async ones', async (t) => {
  t.plan(2);
  t.assert.ok(true);
  await Promise.resolve();
  t.assert.equal(1, 1);
});

test.todo('document pagination');
test.skip('needs a real database', () => {});
```

- `t.signal` is aborted when the test times out or is cancelled; pass it
  to `fetch`, `events.once` and timers inside the test.
- `t.after(fn)` registers cleanup for the current test; prefer it to
  `try/finally` in long tests.
- Subtests with `t.test()` must be awaited.

## Mocks

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('mock implementation per call and getters', (t) => {
  const fn = t.mock.fn(() => 'default');
  fn.mock.mockImplementationOnce(() => 'first');
  assert.equal(fn(), 'first');
  assert.equal(fn(), 'default');
  assert.equal(fn.mock.callCount(), 2);

  const config = {
    get port() {
      return 80;
    },
  };
  t.mock.getter(config, 'port', () => 8080);
  assert.equal(config.port, 8080);
});

test('spy on a method and restore automatically', (t) => {
  const logger = { log: (msg) => msg };
  const spy = t.mock.method(logger, 'log', () => 'mocked');
  assert.equal(logger.log('x'), 'mocked');
  assert.deepEqual(spy.mock.calls[0].arguments, ['x']);
});
```

`t.mock.*` mocks are restored after the test; top-level `mock.*` ones need
`mock.restoreAll()` / `mock.reset()`.

Module mocks (ESM and CJS), behind `--experimental-test-module-mocks`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

test('mock.module replaces a dependency', async () => {
  const fake = mock.module('node:os', {
    namedExports: { hostname: () => 'test-host' },
  });
  const { hostname } = await import('node:os');
  assert.equal(hostname(), 'test-host');
  fake.restore();
});
```

Prefer dependency injection; module mocks couple tests to file layout.

## Timers and Date

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Date and timers move only when told', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const fired = [];
  setTimeout(() => fired.push(Date.now()), 500);
  t.mock.timers.tick(499);
  assert.deepEqual(fired, []);
  t.mock.timers.tick(1);
  assert.deepEqual(fired, [500]);
  assert.equal(new Date().toISOString(), '1970-01-01T00:00:00.500Z');
});
```

APIs that can be mocked: `setTimeout`, `setInterval`, `setImmediate`,
`Date`, and the `node:timers/promises` equivalents. `mock.timers.runAll()`
fires everything pending.

## Snapshots

```js
const { test, snapshot } = require('node:test');

snapshot.setDefaultSnapshotSerializers([(value) => JSON.stringify(value)]);

test('api introspection is stable', (t) => {
  t.assert.snapshot({ routes: ['GET /users', 'POST /users'] });
});
```

First run: `node --test --test-update-snapshots` writes
`<test file>.snapshot` next to the test; commit it. A missing snapshot file
fails the run with `ERR_INVALID_STATE`.

## Coverage with c8

The gate of a library is c8, with thresholds:

```bash
c8 --all --include 'src/**' --check-coverage \
  --lines 98 --statements 98 --branches 90 --functions 100 \
  --reporter text --reporter lcov node --test tests/unit/*.test.js
```

`--all` counts files that no test loads. The thresholds differ per package, so
read them from `test:coverage`. Exclude unreachable defensive branches
explicitly, not by lowering the threshold:

```js
/* c8 ignore next 3 */
if (Number.isNaN(now.getTime())) {
  throw new Error('Invalid clock');
}
```

`/* c8 ignore start */` ... `/* c8 ignore stop */` covers a block. For a quick
local look, `node --test --experimental-test-coverage` needs no dependency.

## A real HTTP server on an ephemeral port

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { createServer } = require('../../src/server.js');

describe('HTTP API', () => {
  const users = { list: async () => [{ id: 1, name: 'Marcus' }] };
  const server = createServer({ users });
  let baseUrl = '';

  before(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.close();
  });

  it('GET /users returns JSON list', async () => {
    const signal = AbortSignal.timeout(2000);
    const res = await fetch(`${baseUrl}/users`, { signal });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{ id: 1, name: 'Marcus' }]);
  });
});
```

## Stress tests for async abstractions

Test queues, semaphores and pools under many concurrent calls; races do not
show up in single-call tests.

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');
const { createLimiter } = require('../../src/limiter.js');

describe('limiter under stress', () => {
  it('never exceeds concurrency for 1000 parallel tasks', async () => {
    const limit = createLimiter(4);
    let active = 0;
    let peak = 0;
    const task = async (i) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(i % 3);
      active--;
      return i;
    };
    const jobs = Array.from({ length: 1000 }, (_, i) => limit(() => task(i)));
    const results = await Promise.all(jobs);
    assert.equal(results.length, 1000);
    assert.equal(peak, 4);
    assert.equal(active, 0);
  });

  it('propagates rejections without blocking the queue', async () => {
    const limit = createLimiter(1);
    const failing = limit(async () => {
      throw new Error('boom');
    });
    const ok = limit(async () => 'ok');
    await assert.rejects(failing, { message: 'boom' });
    assert.equal(await ok, 'ok');
  });
});
```

For leak checks run the same scenario many times and compare
`process.memoryUsage().heapUsed` after `global.gc()` (`node --expose-gc
--test`), or count open handles with `process.getActiveResourcesInfo()`.

## Testing CLIs and whole processes

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

test('CLI prints version', async () => {
  const { stdout } = await run(process.execPath, ['--version']);
  assert.match(stdout, /^v\d+\.\d+\.\d+/);
});
```

Use `process.execPath` (not `'node'`) so the child runs the same binary.

## Non-deterministic functions

For random or sampled output assert a predicate, not a value:
`assert.ok(value >= min && value <= max)`.
