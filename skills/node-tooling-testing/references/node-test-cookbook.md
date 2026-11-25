# node:test cookbook

Reference for `node-tooling-testing`, for libraries. Apps use Vitest: see
`app-testing.md`. Every recipe was run on Node.js 24.14.

## CLI flags (Node 24)

| Flag                                                    | Purpose                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `node --test [globs...]`                                | run test files; without globs uses default discovery (below) |
| `--test --watch`                                        | re-run affected tests on change                              |
| `--test-name-pattern=<re>` / `--test-skip-pattern=<re>` | filter by test name                                          |
| `--test-only`                                           | run only tests marked `{ only: true }` / `it.only`           |
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
| `--test-force-exit`                                     | exit with handles open; only for one the code cannot close   |

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
const { describe, it, before, after, beforeEach } = require('node:test');
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

  it('should create a user', async () => {
    const id = await db.insert('users', { login: 'marcus' });
    assert.equal(typeof id, 'number');
  });

  it.todo('should paginate the list');
});

describe('plan and skip', () => {
  const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

  it('should count assertions, including async ones', async (t) => {
    t.plan(2);
    t.assert.ok(true);
    await Promise.resolve();
    t.assert.equal(1, 1);
  });

  it('should reach the real database', { skip }, async (t) => {
    const db = await openTestDatabase(process.env.DATABASE_URL);
    t.after(() => db.close());
    assert.equal(await db.ping(), true);
  });
});
```

- `t.signal` is aborted when the test times out or is cancelled; pass it
  to `fetch`, `events.once` and timers inside the test.
- `t.after(fn)` registers cleanup for the current test; call it on the line
  after the setup it undoes, and prefer it to `try/finally`.
- A skip carries its reason as a string, never a bare `true`.
- Subtests with `t.test()` must be awaited.

## Mocks

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('mocks', () => {
  it('should mock an implementation per call and a getter', (t) => {
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

  it('should spy on a method and restore it automatically', (t) => {
    const logger = { log: (msg) => msg };
    const spy = t.mock.method(logger, 'log', () => 'mocked');
    assert.equal(logger.log('x'), 'mocked');
    assert.deepEqual(spy.mock.calls[0].arguments, ['x']);
  });
});
```

`t.mock.*` mocks are restored after the test; top-level `mock.*` ones need
`mock.restoreAll()` / `mock.reset()`.

Module mocks (ESM and CJS), behind `--experimental-test-module-mocks`:

```js
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

describe('mock.module', () => {
  it('should replace a dependency', async () => {
    const fake = mock.module('node:os', {
      namedExports: { hostname: () => 'test-host' },
    });
    const { hostname } = await import('node:os');
    assert.equal(hostname(), 'test-host');
    fake.restore();
  });
});
```

Prefer dependency injection; module mocks couple tests to file layout.

## Timers and Date

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('mock timers', () => {
  it('should move Date and timers only when told', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const fired = [];
    setTimeout(() => fired.push(Date.now()), 500);
    t.mock.timers.tick(499);
    assert.deepEqual(fired, []);
    t.mock.timers.tick(1);
    assert.deepEqual(fired, [500]);
    assert.equal(new Date().toISOString(), '1970-01-01T00:00:00.500Z');
  });
});
```

APIs that can be mocked: `setTimeout`, `setInterval`, `setImmediate`,
`Date`, and the `node:timers/promises` equivalents. `mock.timers.runAll()`
fires everything pending.

## Snapshots

```js
const { describe, it, snapshot } = require('node:test');

snapshot.setDefaultSnapshotSerializers([(value) => JSON.stringify(value)]);

describe('api introspection', () => {
  it('should stay stable', (t) => {
    t.assert.snapshot({ routes: ['GET /users', 'POST /users'] });
  });
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

  it('should answer GET /users with a JSON list', async () => {
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
  it('should never exceed the concurrency for 1000 parallel tasks', async () => {
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

  it('should propagate rejections without blocking the queue', async () => {
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
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

describe('CLI', () => {
  it('should print the version', async () => {
    const { stdout } = await run(process.execPath, ['--version']);
    assert.match(stdout, /^v\d+\.\d+\.\d+/);
  });
});
```

Use `process.execPath` (not `'node'`) so the child runs the same binary.

## Non-deterministic functions

For random or sampled output assert a predicate, not a value:
`assert.ok(value >= min && value <= max)`.

## Suites, fixtures and CI

Rules the Alexis libraries hold, so the suites keep proving what they claim.

- **A runtime tier.** `tests/runtime/` uses the package as a consumer does:
  every entry required and imported by the package name, never through
  `../../src/`, with no mock. The same files run on Node, Bun and Deno
  (`bun test`, `deno test -A`), so they use `node:test` and `node:assert`
  alone, never `t.mock`.
- **Opt-in suites** (a real provider, a database, Docker) skip with a reason
  until their variables are set. The release aggregate that runs them
  (`pnpm test:stores` or the like, a step of the release checklist) fails
  when a variable is missing instead of skipping: a release never passes on
  a skip.
- **Golden fixtures are never regenerated.** A golden file (the bytes an
  earlier version produced, a recorded webhook with its real signature) is
  the truth the code is held to. When it fails, the code is wrong, or the
  change is a breaking one, called out in the CHANGELOG. Only a snapshot is
  regenerated, deliberately.
- **Teardown goes right after setup**: `t.after(() => server.close())` on the
  next line, so an assertion that fails in between still closes it.
- **One `waitFor` with a deadline** for real I/O to settle, shared from
  `tests/helpers/`. A sleep only proves that nothing more arrives.
- **No `await using`** in a file that Node 22 loads: Node 22 does not parse
  it, and the file fails whole on Node 22 alone. Close with `t.after`.
- **CI runs the exact engines floor** (`'22.18.0'` for `>=22.18.0`; `22` is
  the newest 22.x), and the aggregate job fails on a skipped job too. The
  workflow is in `ci-types-release.md`.

```js
// tests/runtime/exports.test.js: on Node, Bun and Deno
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const pkg = require('../../package.json');

describe('package entries', () => {
  for (const subpath of Object.keys(pkg.exports)) {
    if (subpath.endsWith('.json')) continue;
    const name = subpath === '.' ? pkg.name : `${pkg.name}${subpath.slice(1)}`;
    it(`should load ${name} by name from CommonJS and ESM`, async () => {
      const required = require(name);
      const imported = await import(name);
      for (const key of Object.keys(required)) {
        assert.equal(imported[key], required[key], key);
      }
    });
  }
});
```

```js
// tests/helpers/wait-for.js
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');

const waitFor = async (check, { timeout = 2000, interval = 10 } = {}) => {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) assert.fail(`The condition did not hold in ${timeout} ms`);
    await sleep(interval);
  }
};

module.exports = { waitFor };
```

```js
// tests/unit/queue.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');

const { createQueue } = require('../../src/queue.js');
const { waitFor } = require('../helpers/wait-for.js');

describe('queue', () => {
  it('should run a job once', async (t) => {
    const queue = createQueue();
    t.after(() => queue.close());
    const runs = [];
    queue.process(async (job) => runs.push(job.id));

    await queue.add({ id: 'a' });
    await waitFor(() => runs.length === 1);
    await sleep(50);
    assert.deepEqual(runs, ['a']);
  });
});
```
