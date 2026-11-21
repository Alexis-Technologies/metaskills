# Complete Onion + DDD example (runnable)

A small auth context in the App profile: ESM, TypeScript with erasable syntax,
Fastify, the native `mongodb` driver. Every file below runs on Node.js 24 with
type stripping, and the tests run under Vitest with DI fakes.

```text
src/
  domain/account.ts                     aggregate, rules, DomainError, repository interface
  application/access.ts                 the access decision, deny by default
  application/auth.ts                   use cases and their ports
  infrastructure/accounts.repository.ts repository over the native driver
  infrastructure/password.ts            scrypt hasher
  infrastructure/sessions.ts            session store
  presentation/plugins/validation.ts    metaschema validator compiler
  presentation/plugins/errors.ts        domain error codes to HTTP statuses
  presentation/plugins/access.ts        the guard: onRoute and onRequest
  presentation/plugins/auth.ts          wires the use cases, decorates the instance
  presentation/routes/auth.ts           routes: read input, call a use case
  app.ts                                composition root, takes infrastructure
  main.ts                               process entry: config, driver, listen
test/auth.test.ts                       use cases and HTTP through inject, with fakes
```

Dependencies point inward: `presentation -> application -> domain`, and
`infrastructure -> application, domain`. Only `app.ts` and `main.ts` see all of
them.

## Domain

No imports. The aggregate guards its invariants, and the repository interface
lives here.

```ts
// src/domain/account.ts
export class DomainError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

const LOGIN = /^[a-z][a-z0-9_]{2,31}$/;
const PASSWORD_MIN_LENGTH = 8;

export const normalizeLogin = (login: string) => {
  const value = login.trim().toLowerCase();
  if (!LOGIN.test(value)) throw new DomainError('Invalid login', 'EVALIDATION');
  return value;
};

export const checkPassword = (password: string) => {
  if (password.length >= PASSWORD_MIN_LENGTH) return;
  throw new DomainError('Password is too short', 'EVALIDATION');
};

export type AccountState = {
  id: string;
  login: string;
  passwordHash: string;
  blocked: boolean;
  rev: number;
};

export class Account {
  #state: AccountState;

  constructor(state: AccountState) {
    this.#state = { ...state };
  }

  static register(id: string, login: string, passwordHash: string) {
    const state = { id, login: normalizeLogin(login), passwordHash, blocked: false, rev: 0 };
    return new Account(state);
  }

  get id() {
    return this.#state.id;
  }

  get passwordHash() {
    return this.#state.passwordHash;
  }

  ensureCanSignIn() {
    if (this.#state.blocked) throw new DomainError('Account is blocked', 'EBLOCKED');
  }

  block() {
    if (this.#state.blocked) throw new DomainError('Already blocked', 'ECONFLICT');
    this.#state.blocked = true;
  }

  toState() {
    return { ...this.#state };
  }
}

export interface Accounts {
  findByLogin(login: string): Promise<Account | null>;
  insert(account: Account): Promise<void>;
  save(account: Account): Promise<boolean>;
}
```

## Application

One access decision for every transport. An undeclared or unknown value has no
policy, so it is refused.

```ts
// src/application/access.ts
export type Session = Readonly<{ accountId: string }>;

type Policy = (session: Session | null) => boolean;

const POLICIES = new Map<unknown, Policy>([
  ['public', () => true],
  ['session', (session) => session !== null],
]);

export const isDeclared = (access: unknown) => POLICIES.has(access);

export const isAllowed = (access: unknown, session: Session | null) => {
  const policy = POLICIES.get(access);
  return policy ? policy(session) : false;
};
```

Use cases orchestrate: they load an aggregate, call it and save it. Ports are
declared next to the consumer.

```ts
// src/application/auth.ts
import { Account, DomainError, checkPassword, normalizeLogin } from '../domain/account.ts';
import type { Accounts } from '../domain/account.ts';
import type { Session } from './access.ts';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface SessionStore {
  start(data: Session): Promise<string>;
  restore(token: string): Promise<Session | null>;
}

export interface Logger {
  info(data: object, message: string): void;
}

export type AuthDeps = {
  accounts: Accounts;
  hasher: PasswordHasher;
  sessions: SessionStore;
  logger: Logger;
  createId: () => string;
  dummyHash: string;
};

type Credentials = { login: string; password: string };

export const createAuth = (deps: AuthDeps) => {
  const { accounts, hasher, sessions, logger, createId, dummyHash } = deps;

  const register = async ({ login, password }: Credentials) => {
    const normalized = normalizeLogin(login);
    checkPassword(password);
    const passwordHash = await hasher.hash(password);
    const account = Account.register(createId(), normalized, passwordHash);
    await accounts.insert(account);
    logger.info({ accountId: account.id }, 'account registered');
    return { id: account.id };
  };

  const signIn = async ({ login, password }: Credentials) => {
    const account = await accounts.findByLogin(normalizeLogin(login));
    const hash = account ? account.passwordHash : dummyHash;
    const isMatch = await hasher.verify(password, hash);
    if (!account || !isMatch) throw new DomainError('Wrong credentials', 'EAUTH');
    account.ensureCanSignIn();
    const token = await sessions.start({ accountId: account.id });
    return { token };
  };

  const getProfile = async (session: Session) => ({ accountId: session.accountId });

  return Object.freeze({ register, signIn, getProfile });
};

export type Auth = ReturnType<typeof createAuth>;
```

`signIn` runs the hash for an unknown login too, so response time does not tell
which logins exist. The blocked check comes after the password check for the
same reason.

## Infrastructure

The repository is the only code that knows the driver and the document shape.
The unique index on `login` decides a duplicate, so there is no
check-then-insert race. `rev` is the optimistic lock.

```ts
// src/infrastructure/accounts.repository.ts
import type { Collection } from 'mongodb';

import { Account, DomainError } from '../domain/account.ts';
import type { Accounts } from '../domain/account.ts';

const DUPLICATE_KEY = 11000;

export type AccountDocument = {
  cuid: string;
  login: string;
  passwordHash: string;
  blocked: boolean;
  v: number;
  rev: number;
};

const toAccount = ({ cuid, login, passwordHash, blocked, rev }: AccountDocument) =>
  new Account({ id: cuid, login, passwordHash, blocked, rev });

export const createAccountsRepository = (collection: Collection<AccountDocument>): Accounts => ({
  async findByLogin(login) {
    const document = await collection.findOne({ login });
    return document ? toAccount(document) : null;
  },

  async insert(account) {
    const { id: cuid, login, passwordHash, blocked, rev } = account.toState();
    try {
      await collection.insertOne({ cuid, login, passwordHash, blocked, v: 1, rev });
    } catch (error) {
      if ((error as { code?: number }).code !== DUPLICATE_KEY) throw error;
      throw new DomainError('Login is taken', 'ECONFLICT');
    }
  },

  async save(account) {
    const { id: cuid, blocked, rev } = account.toState();
    const update = { $set: { blocked }, $inc: { rev: 1 } };
    const result = await collection.updateOne({ cuid, rev }, update);
    return result.matchedCount === 1;
  },
});
```

In `auth8` this class extends `RepositoryWithDefaultAutoFields` from
`packages/node/src/dal`, which also maintains timestamps and author stamps.

```ts
// src/infrastructure/password.ts
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import type { PasswordHasher } from '../application/auth.ts';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export const createPasswordHasher = (): PasswordHasher => ({
  async hash(password) {
    const salt = randomBytes(SALT_BYTES);
    const key = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
    return `${salt.toString('base64')}:${key.toString('base64')}`;
  },

  async verify(password, stored) {
    const separator = stored.indexOf(':');
    const salt = Buffer.from(stored.slice(0, separator), 'base64');
    const expected = Buffer.from(stored.slice(separator + 1), 'base64');
    const key = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
    return timingSafeEqual(key, expected);
  },
});
```

```ts
// src/infrastructure/sessions.ts
import { randomBytes } from 'node:crypto';

import type { Session } from '../application/access.ts';
import type { SessionStore } from '../application/auth.ts';

export const createSessionStore = (): SessionStore => {
  const sessions = new Map<string, Session>();
  return {
    async start(data) {
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, Object.freeze({ ...data }));
      return token;
    },
    async restore(token) {
      return sessions.get(token) ?? null;
    },
  };
};
```

These are minimal shapes for the layering. A production password format and
session expiry are in `node-crypto-auth`. Behind a balancer, inject a store over
Redis with the same `{ start, restore }` contract.

## Presentation

Each plugin has a name, and the guard runs before any route exists. The
validator compiler is the recipe from `js-contracts-schemas`.

```ts
// src/presentation/plugins/validation.ts
import fp from 'fastify-plugin';
import type { FastifySchemaCompiler } from 'fastify';
import type { Schema, ValidationIssue } from '@alexify/metaschema';

const TEXT_PARTS = ['querystring', 'params', 'headers'];

const toError = (issues: readonly ValidationIssue[]) => {
  const error = new Error('Validation failed') as Error & Record<string, unknown>;
  error.statusCode = 400;
  error.code = 'EVALIDATION';
  error.validation = issues;
  return error;
};

const metaschemaCompiler: FastifySchemaCompiler<Schema> = ({ schema, httpPart }) => {
  const part = httpPart ?? '';
  const coerce = TEXT_PARTS.includes(part);
  const unknown = part === 'headers' ? 'ignore' : 'reject';
  return (data) => {
    const { valid, value, issues } = schema.parse(data, { coerce, unknown });
    return valid ? { value } : { error: toError(issues) };
  };
};

export default fp(
  async (fastify) => {
    fastify.setValidatorCompiler(metaschemaCompiler);
  },
  { name: 'validation' },
);
```

```ts
// src/presentation/plugins/errors.ts
import { randomUUID } from 'node:crypto';

import fp from 'fastify-plugin';

const STATUS = new Map<unknown, number>([
  ['EVALIDATION', 400],
  ['EAUTH', 401],
  ['EBLOCKED', 403],
  ['ECONFLICT', 409],
]);

export default fp(
  async (fastify) => {
    fastify.setErrorHandler((error: any, request, reply) => {
      const status = STATUS.get(error.code);
      if (status) return reply.code(status).send({ code: error.code, message: error.message });
      const isClientError = error.statusCode >= 400 && error.statusCode < 500;
      if (isClientError) return reply.code(error.statusCode).send({ message: error.message });
      const errorId = randomUUID();
      request.log.error({ err: error, errorId }, 'unexpected error');
      return reply.code(500).send({ message: 'Internal error', errorId });
    });
  },
  { name: 'errors' },
);
```

The guard refuses twice. `onRoute` stops the boot when a route has no valid
`access`. `onRequest` refuses at run time, which also covers a route added
before the guard was registered, where `onRoute` did not fire.

```ts
// src/presentation/plugins/access.ts
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

import { isAllowed, isDeclared } from '../../application/access.ts';
import type { Session } from '../../application/access.ts';
import type { SessionStore } from '../../application/auth.ts';

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
  }
  interface FastifyContextConfig {
    access?: string;
  }
}

const readToken = (header = '') => (header.startsWith('Bearer ') ? header.slice(7) : '');

const guard = async (fastify: FastifyInstance, { sessions }: { sessions: SessionStore }) => {
  fastify.decorateRequest('session', null);

  fastify.addHook('onRoute', (route) => {
    if (isDeclared(route.config?.access)) return;
    throw new Error(`${route.method} ${route.url}: access is not declared`);
  });

  fastify.addHook('onRequest', async (request, reply) => {
    if (request.is404) return;
    const token = readToken(request.headers.authorization);
    request.session = token ? await sessions.restore(token) : null;
    if (isAllowed(request.routeOptions.config.access, request.session)) return;
    return reply.code(403).send({ message: 'Forbidden' });
  });
};

export default fp(guard, { name: 'access' });
```

```ts
// src/presentation/plugins/auth.ts
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

import { createAuth } from '../../application/auth.ts';
import type { Auth, AuthDeps } from '../../application/auth.ts';

declare module 'fastify' {
  interface FastifyInstance {
    auth: Auth;
  }
}

const authPlugin = async (fastify: FastifyInstance, deps: AuthDeps) => {
  fastify.decorate('auth', createAuth(deps));
};

export default fp(authPlugin, { name: 'auth' });
```

A route reads the declared decorator once and passes plain values down:

```ts
// src/presentation/routes/auth.ts
import { Schema } from '@alexify/metaschema';
import type { FastifyInstance } from 'fastify';

const Credentials = Schema.from({ login: 'string', password: 'string' });
type Body = { login: string; password: string };

const authRoutes = async (fastify: FastifyInstance) => {
  const { auth } = fastify;
  const publicRoute = { config: { access: 'public' }, schema: { body: Credentials } };

  fastify.post<{ Body: Body }>('/accounts', publicRoute, async (request, reply) => {
    const created = await auth.register(request.body);
    return reply.code(201).send(created);
  });

  fastify.post<{ Body: Body }>('/sessions', publicRoute, async (request) => {
    return auth.signIn(request.body);
  });

  fastify.get('/me', { config: { access: 'session' } }, async (request) => {
    const { session } = request;
    return auth.getProfile(session!);
  });
};

export default authRoutes;
```

## Composition root

`buildApp` takes infrastructure as an argument, so tests pass fakes. Order
matters: the guard before the routes.

```ts
// src/app.ts
import Fastify from 'fastify';
import type { FastifyServerOptions } from 'fastify';

import type { AuthDeps } from './application/auth.ts';
import access from './presentation/plugins/access.ts';
import auth from './presentation/plugins/auth.ts';
import errors from './presentation/plugins/errors.ts';
import validation from './presentation/plugins/validation.ts';
import authRoutes from './presentation/routes/auth.ts';

export const buildApp = async (deps: AuthDeps, options: FastifyServerOptions = {}) => {
  const app = Fastify(options);
  await app.register(validation);
  await app.register(errors);
  await app.register(access, { sessions: deps.sessions });
  await app.register(auth, deps);
  await app.register(authRoutes);
  return app;
};
```

```ts
// src/main.ts
import { randomUUID } from 'node:crypto';

import { MongoClient } from 'mongodb';

import { buildApp } from './app.ts';
import { createAccountsRepository } from './infrastructure/accounts.repository.ts';
import type { AccountDocument } from './infrastructure/accounts.repository.ts';
import { createPasswordHasher } from './infrastructure/password.ts';
import { createSessionStore } from './infrastructure/sessions.ts';

const { DATABASE_URL = '', PORT = '3000' } = process.env;

const client = new MongoClient(DATABASE_URL);
await client.connect();
const collection = client.db().collection<AccountDocument>('accounts');
await collection.createIndex({ login: 1 }, { unique: true });

const hasher = createPasswordHasher();
const dummyHash = await hasher.hash(randomUUID());
const accounts = createAccountsRepository(collection);
const sessions = createSessionStore();
const logger = { info: (data: object, message: string) => console.info(data, message) };
const deps = { accounts, hasher, sessions, logger, createId: randomUUID, dummyHash };

const app = await buildApp(deps, { logger: true });
app.addHook('onClose', () => client.close());
await app.listen({ host: '0.0.0.0', port: Number(PORT) });
```

In `auth8` the same wiring is spread across named plugins loaded by
`@fastify/autoload` (`plugins/` first, then `routes/`), the configuration is
validated by `@fastify/env`, the ids are CUID2, and the logger is Pino.
Shutdown order: `node-graceful-shutdown`.

## Tests

Vitest, AAA, `should` titles, DI fakes. The use case runs without a server; the
guard runs through `inject` on the real plugin tree.

```ts
// test/auth.test.ts
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { isAllowed, isDeclared } from '../src/application/access.ts';
import { createAuth } from '../src/application/auth.ts';
import { buildApp } from '../src/app.ts';
import { Account } from '../src/domain/account.ts';
import { createAccountsRepository } from '../src/infrastructure/accounts.repository.ts';
import { createSessionStore } from '../src/infrastructure/sessions.ts';
import access from '../src/presentation/plugins/access.ts';

const createFakeCollection = () => {
  const documents: any[] = [];
  return {
    documents,
    findOne: async ({ login }: any) => documents.find((item) => item.login === login) ?? null,
    insertOne: async (document: any) => {
      const isTaken = documents.some((item) => item.login === document.login);
      if (isTaken) throw Object.assign(new Error('E11000'), { code: 11000 });
      documents.push({ ...document });
    },
    updateOne: async ({ cuid, rev }: any, update: any) => {
      const found = documents.find((item) => item.cuid === cuid && item.rev === rev);
      if (!found) return { matchedCount: 0 };
      Object.assign(found, update.$set);
      found.rev += update.$inc.rev;
      return { matchedCount: 1 };
    },
  };
};

const createDeps = () => {
  const collection = createFakeCollection();
  let counter = 0;
  return {
    collection,
    accounts: createAccountsRepository(collection as any),
    hasher: {
      hash: async (value: string) => `h:${value}`,
      verify: async (value: string, hash: string) => hash === `h:${value}`,
    },
    sessions: createSessionStore(),
    logger: { info: () => {} },
    createId: () => `id-${++counter}`,
    dummyHash: 'h:dummy',
  };
};

const credentials = { login: 'marcus', password: '12345678' };

describe('auth use cases', () => {
  it('should reject a duplicate login through the unique index', async () => {
    // Arrange
    const auth = createAuth(createDeps());
    await auth.register(credentials);
    // Act
    const attempt = auth.register({ ...credentials, login: 'MARCUS' });
    // Assert
    await expect(attempt).rejects.toMatchObject({ code: 'ECONFLICT' });
  });

  it('should refuse an unknown login even with the dummy password', async () => {
    // Arrange
    const auth = createAuth(createDeps());
    // Act
    const attempt = auth.signIn({ login: 'ghost', password: 'dummy' });
    // Assert
    await expect(attempt).rejects.toMatchObject({ code: 'EAUTH' });
  });

  it('should detect a lost update through rev', async () => {
    // Arrange
    const deps = createDeps();
    const auth = createAuth(deps);
    await auth.register(credentials);
    const first = (await deps.accounts.findByLogin('marcus')) as Account;
    const second = (await deps.accounts.findByLogin('marcus')) as Account;
    first.block();
    second.block();
    // Act
    const results = [await deps.accounts.save(first), await deps.accounts.save(second)];
    // Assert
    expect(results).toEqual([true, false]);
  });
});

describe('access decision', () => {
  it('should refuse a missing or unknown declaration, even with a session', () => {
    // Arrange
    const session = Object.freeze({ accountId: 'a1' });
    const values = [undefined, null, '', 'sesion', 'constructor', '__proto__', true];
    // Act
    const decisions = values.map((value) => isAllowed(value, session));
    // Assert
    expect(decisions).toEqual(values.map(() => false));
    expect(values.some((value) => isDeclared(value))).toBe(false);
  });
});

describe('http guard', () => {
  it('should serve the declared routes', async () => {
    // Arrange
    const app = await buildApp(createDeps());
    await app.inject({ method: 'POST', url: '/accounts', payload: credentials });
    // Act
    const signIn = await app.inject({ method: 'POST', url: '/sessions', payload: credentials });
    const authorization = `Bearer ${signIn.json().token}`;
    const me = await app.inject({ url: '/me', headers: { authorization } });
    const anonymous = await app.inject({ url: '/me' });
    const forged = await app.inject({ url: '/me', headers: { authorization: 'Bearer nope' } });
    const missing = await app.inject({ url: '/nowhere' });
    // Assert
    expect(me.json()).toEqual({ accountId: 'id-1' });
    expect([anonymous.statusCode, forged.statusCode, missing.statusCode]).toEqual([403, 403, 404]);
    await app.close();
  });

  it('should fail the boot when a route declares no access', async () => {
    // Arrange
    const app = Fastify();
    await app.register(access, { sessions: createSessionStore() });
    app.register(async (scope) => {
      scope.get('/undeclared', async () => 'secret');
    });
    // Act
    const boot = app.ready();
    // Assert
    await expect(boot).rejects.toThrow('access is not declared');
  });

  it('should refuse at run time a route added before the guard', async () => {
    // Arrange
    const sessions = createSessionStore();
    const token = await sessions.start({ accountId: 'a1' });
    const app = Fastify();
    app.get('/early', async () => 'secret');
    await app.register(access, { sessions });
    await app.ready();
    // Act
    const headers = { authorization: `Bearer ${token}` };
    const response = await app.inject({ url: '/early', headers });
    // Assert
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
```

Run with `pnpm test` (Vitest). For the domain alone no fake is needed: `new
Account(state).block()` is a plain call.
