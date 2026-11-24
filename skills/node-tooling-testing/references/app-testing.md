# App testing: Vitest, Playwright, autocannon, k6

Reference for `node-tooling-testing`, following `auth8` ADR-009. One tool per
level:

| Level                | Tool                         | Scope                                     |
| -------------------- | ---------------------------- | ----------------------------------------- |
| Unit                 | Vitest                       | Pure functions, domain logic, services    |
| Integration          | Vitest                       | Modules against a real DB, Fastify inject |
| Component (frontend) | Vitest + `@vue/test-utils`   | Vue 3 components in isolation             |
| E2E                  | Playwright                   | Full user flows through the SPA and API   |
| Load                 | autocannon, k6               | Quick throughput, scripted load scenarios |

Layout: `src/**/tests/` for unit and integration, `e2e/` for Playwright,
`load/` for load scripts.

## Vitest configuration

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
});
```

A separate `vitest.integration.config.ts` includes only
`src/**/*.integration.test.ts` and raises `testTimeout` and `hookTimeout`:
`mongodb-memory-server` may download a binary on first run.

## AAA with an injected clock and id

The service takes its collaborators, so the test needs no global mocks.

```ts
import { describe, expect, it, vi } from 'vitest';

type Session = { id: string; userId: string; expiresAt: number };
type Deps = {
  sessions: { insert: (session: Session) => Promise<void> };
  now: () => number;
  createId: () => string;
};

const TTL_MS = 1000;

const createSession = (deps: Deps) => async (userId: string) => {
  const session = { id: deps.createId(), userId, expiresAt: deps.now() + TTL_MS };
  await deps.sessions.insert(session);
  return session;
};

describe('createSession', () => {
  it('should store a session that expires after the ttl', async () => {
    // Arrange
    const sessions = { insert: vi.fn(async () => {}) };
    const create = createSession({ sessions, now: () => 5000, createId: () => 'session-1' });

    // Act
    const session = await create('user-1');

    // Assert
    expect(session).toEqual({ id: 'session-1', userId: 'user-1', expiresAt: 6000 });
    expect(sessions.insert).toHaveBeenCalledWith(session);
  });
});
```

## Fake timers

Restore them after each test, or later tests hang on a timer that never fires.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should call the handler when the delay has passed', () => {
    // Arrange
    const handler = vi.fn();
    setTimeout(handler, 500);

    // Act
    vi.advanceTimersByTime(500);

    // Assert
    expect(handler).toHaveBeenCalledOnce();
    expect(Date.now()).toBe(Date.parse('2026-01-01T00:00:00.500Z'));
  });
});
```

## Fastify through `inject`

`app.inject()` runs the whole lifecycle (hooks, validation, serialization,
error handler) without opening a socket, so tests are parallel-safe. Build the
instance with fakes in place of the infrastructure plugins:

```ts
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Users = { get: (id: string) => Promise<unknown> };

declare module 'fastify' {
  interface FastifyInstance {
    users: Users;
  }
}

const usersPlugin = (users: Users) => {
  const plugin = async (fastify: FastifyInstance) => {
    fastify.decorate('users', users);
  };
  return fp(plugin, { name: 'users' });
};

const routes = async (fastify: FastifyInstance) => {
  fastify.get<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
    const user = await fastify.users.get(request.params.id);
    if (user === null) return reply.code(404).send({ message: 'Not found' });
    return user;
  });
};

describe('GET /users/:id', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
  });

  it('should answer 404 for an unknown user', async () => {
    // Arrange
    const users = { get: vi.fn(async () => null) };
    app = Fastify();
    await app.register(usersPlugin(users));
    await app.register(routes);

    // Act
    const response = await app.inject({ method: 'GET', url: '/users/404' });

    // Assert
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: 'Not found' });
  });
});
```

A Fastify instance cannot be reused after `close()`, so each test builds its
own.

## MongoDB integration

Run the repository against a real server. `auth8` uses `mongodb-memory-server`,
and no container is needed in CI:

```ts
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('users repository', () => {
  let server: MongoMemoryServer | null = null;
  let client: MongoClient | null = null;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  beforeEach(async () => {
    await client?.db('test').collection('users').deleteMany({});
  });

  it('should find an inserted user by email', async () => {
    // Arrange
    const users = client!.db('test').collection('users');
    await users.insertOne({ email: 'marcus@example.com' });

    // Act
    const found = await users.findOne({ email: 'marcus@example.com' });

    // Assert
    expect(found?.email).toBe('marcus@example.com');
  });
});
```

The repository under test is the project's own DAL (`node-data-access`). The
collection calls above only keep the example short.

## Playwright (E2E)

```ts
import { expect, test } from '@playwright/test';

test.describe('sign-in', () => {
  test('should open the dashboard after a valid sign-in', async ({ page }) => {
    // Arrange
    await page.goto('/sign-in');

    // Act
    await page.getByLabel('Email').fill('user@example.com');
    await page.getByLabel('Password').fill(process.env.E2E_USER_PASSWORD ?? '');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Assert
    await expect(page).toHaveURL(/dashboard/);
  });
});
```

Prefer role and label locators to CSS selectors. Seed users through the API
or a fixture, never through another test.

## autocannon (quick throughput)

```js
const autocannon = require('autocannon');

const main = async () => {
  const url = process.env.BASE_URL;
  const result = await autocannon({ url, connections: 10, duration: 10 });
  const failed = result.errors + result.non2xx;
  console.log({ rps: result.requests.average, p99: result.latency.p99, failed });
  if (failed > 0) process.exitCode = 1;
};

main();
```

## k6 (scenarios)

```js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 20,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<200'],
  },
};

export default () => {
  const response = http.get(`${__ENV.BASE_URL}/health`);
  check(response, { 'status is 200': (result) => result.status === 200 });
  sleep(1);
};
```

Run with `k6 run -e BASE_URL=http://localhost:3000 load/health.js`. k6 is a
separate binary, not an npm package, and its scripts run in its own runtime.
