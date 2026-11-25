# App testing: Vitest

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
`load/` for load scripts. Playwright, autocannon and k6 are in
[e2e-load.md](e2e-load.md).

## Vitest configuration

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/domain/**', 'src/**/app/**'],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
```

- `clearMocks` drops call history before each test, and `restoreMocks` puts back
  what `vi.spyOn` replaced. Without them, one test's mock leaks into the next.
- The thresholds cover `domain/` and `app/`, where the logic is. `infra/` and
  `presentation/` are proved by integration tests. Start where the code is,
  then raise the numbers, never lower them.
- Cover every `throw`, every branch and every validation rule. A line that
  ran in a test without an assertion proves nothing.

A separate `vitest.integration.config.ts` includes only
`src/**/*.integration.test.ts` and raises `testTimeout` and `hookTimeout`:
`mongodb-memory-server` may download a binary on first run.

## Names

`describe` names the subject: a function (`decode`), an aggregate
(`Session`), a route (`POST /v1/sessions`) or a feature (`organization
invites`). It never starts with `should`. Every `it` does, followed by the
observable behaviour in the base verb. Nest `describe('when …')` for scenarios
of one subject.

| Block | Title before | Title after |
| --- | --- | --- |
| `it` | `returns the decoded payload` | `should return the decoded payload` |
| `it` | `throws on bad input` | `should throw on bad input` |
| `describe` | `should decode` | `decode` |

One behaviour per `it`: a title that needs "and" is two tests.

## Data and fakes

- Build inputs with a small factory per test, `makePayload({ role: 'admin' })`,
  not a shared mutable fixture.
- Pass fakes through the service's dependencies. Type the port narrowly (the
  service needs `info` and `warn` of a logger), so a fake needs no cast. Use
  `as unknown as T` only for a third-party type you cannot narrow.
- `vi.spyOn(object, 'method')` observes one real method; `vi.mock` is for an
  import you cannot inject. Never mock the subject or a value object.
- `toEqual` compares values, `toBe` compares identity.

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
    if (user === null) {
      return reply.code(404).send({ error: { code: 'ALX_ERR_NOT_FOUND', message: 'Not found' } });
    }
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
    expect(response.json()).toEqual({
      error: { code: 'ALX_ERR_NOT_FOUND', message: 'Not found' },
    });
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

## Benchmarks

`vitest bench` runs every case in one process, so a later case runs on call
sites the earlier ones already made polymorphic. Use it for a quick relative
check of a pure function. Before a decision, run each case in its own process,
as the performance notes of `js-conventions` say.
