# Complete modular example (runnable)

A small app in the App profile with one module, `accounts`: ESM, TypeScript with
erasable syntax, Fastify, the native `mongodb` driver. Every file below
type-checks with `tsc` under NodeNext. Node.js 24 runs the sources in development
(type stripping) and the build in `dist/` in production, and the tests run under
Vitest with DI fakes.
The layout and the naming rules are in [modules.md](modules.md).

```text
src/
  main.ts, app.ts                    process entry, composition root
  plugins/                           validation, errors, the access guard
  shared/                            DomainError, the access decision, the session store
  modules/accounts/
    index.ts                         public API and composition root of the module
    domain/                          aggregate, value rules, constants, types, repository interface
    app/                             ports, types, service
    infra/                           collection, repository, password hasher
    presentation/                    route schemas, routes
    */tests/, tests/fakes.ts         tests next to the code
  tests/architecture.test.ts         module boundaries, in modules.md
```

Inside the module dependencies point inward: `presentation -> app -> domain`, and
`infra -> app, domain`. Only `index.ts` sees all four. Outside the module only
`app.ts` imports it, through `#modules/accounts`.

## Project files

Relative imports end in `.ts`: Node.js runs the sources as written, and the
build rewrites them to `.js`. `package.json` maps the import aliases, written
without an extension: the `source` condition points Node.js in development,
`tsc` and Vitest at the TypeScript, and the default is the build in `dist/`:

```json
{
  "type": "module",
  "imports": {
    "#app": { "source": "./src/app.ts", "default": "./dist/app.js" },
    "#shared/*": { "source": "./src/shared/*.ts", "default": "./dist/shared/*.js" },
    "#modules/*": { "source": "./src/modules/*/index.ts", "default": "./dist/modules/*/index.js" }
  },
  "scripts": {
    "dev": "node --conditions=source --watch src/main.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js"
  }
}
```

`tsconfig.json` checks everything, `tsconfig.build.json` emits `dist/` without
the tests and rewrites the `.ts` specifiers:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "customConditions": ["source"],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"]
}
```

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist",
    "rewriteRelativeImportExtensions": true
  },
  "exclude": ["src/**/tests/**"]
}
```

Vitest runs Node tests as SSR, so the condition goes into `ssr.resolve`. A plain
`resolve.conditions` does not reach them:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: { resolve: { conditions: ['source'] } },
});
```

## Shared kernel

Every module may import it. It has the same layers as a module.

```ts
// src/shared/domain/domain-error.ts
type DomainErrorOptions = ErrorOptions & { code?: string; details?: unknown };

export class DomainError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, options: DomainErrorOptions = {}) {
    const { code = 'ALX_ERR_DOMAIN', details = null } = options;
    super(message, options);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}
```

One access decision for every transport. An undeclared or unknown value has no
policy, so it is refused.

```ts
// src/shared/app/access.ts
export type Session = Readonly<{ accountId: string }>;

export interface SessionStore {
  start(data: Session): Promise<string>;
  restore(token: string): Promise<Session | null>;
}

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

```ts
// src/shared/infra/session-store.ts
import { randomBytes } from 'node:crypto';

import type { Session, SessionStore } from '#shared/app/access';

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

A production session format and expiry are in `node-crypto-auth`. Behind a
balancer, inject a store over Redis with the same `{ start, restore }` contract.

## Module `accounts`

### Domain

The aggregate guards its invariants. Constants, types and the repository
interface each have their own file, and the value rules are domain code, not
helpers.

```ts
// src/modules/accounts/domain/accounts.constants.ts
export const LOGIN = /^[a-z][a-z0-9_]{2,31}$/;
export const PASSWORD_MIN_LENGTH = 8;
```

```ts
// src/modules/accounts/domain/accounts.types.ts
export type AccountState = {
  id: string;
  login: string;
  passwordHash: string;
  blocked: boolean;
  rev: number;
};
```

```ts
// src/modules/accounts/domain/credentials.ts
import { DomainError } from '#shared/domain/domain-error';

import { LOGIN, PASSWORD_MIN_LENGTH } from './accounts.constants.ts';

export const normalizeLogin = (login: string) => {
  const value = login.trim().toLowerCase();
  if (!LOGIN.test(value)) throw new DomainError('Invalid login', { code: 'ALX_ERR_VALIDATION' });
  return value;
};

export const checkPassword = (password: string) => {
  if (password.length >= PASSWORD_MIN_LENGTH) return;
  throw new DomainError('Password is too short', { code: 'ALX_ERR_VALIDATION' });
};
```

```ts
// src/modules/accounts/domain/account.ts
import { DomainError } from '#shared/domain/domain-error';

import type { AccountState } from './accounts.types.ts';
import { normalizeLogin } from './credentials.ts';

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
    if (!this.#state.blocked) return;
    throw new DomainError('Account is blocked', { code: 'ALX_ERR_BLOCKED' });
  }

  block() {
    if (this.#state.blocked) {
      throw new DomainError('Already blocked', { code: 'ALX_ERR_CONFLICT' });
    }
    this.#state.blocked = true;
  }

  toState() {
    return { ...this.#state };
  }
}
```

```ts
// src/modules/accounts/domain/accounts.repository.ts
import type { Account } from './account.ts';

export interface AccountsRepository {
  findByLogin(login: string): Promise<Account | null>;
  insert(account: Account): Promise<void>;
  save(account: Account): Promise<boolean>;
}
```

### App

Ports are declared next to their consumer. The dependencies arrive as one
object.

```ts
// src/modules/accounts/app/accounts.ports.ts
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface Logger {
  info(data: object, message: string): void;
}
```

```ts
// src/modules/accounts/app/accounts.types.ts
import type { SessionStore } from '#shared/app/access';

import type { AccountsRepository } from '../domain/accounts.repository.ts';
import type { Logger, PasswordHasher } from './accounts.ports.ts';

export type AccountsDeps = {
  repository: AccountsRepository;
  hasher: PasswordHasher;
  sessions: SessionStore;
  logger: Logger;
  createId: () => string;
  dummyHash: string;
};

export type Credentials = { login: string; password: string };
```

The service is the facade of the module, and each of its methods is one
operation. A larger module has several services, split by aggregate or
responsibility:

```ts
// src/modules/accounts/app/accounts.service.ts
import type { Session } from '#shared/app/access';
import { DomainError } from '#shared/domain/domain-error';

import { Account } from '../domain/account.ts';
import { checkPassword, normalizeLogin } from '../domain/credentials.ts';
import type { AccountsDeps, Credentials } from './accounts.types.ts';

export const createAccountsService = (deps: AccountsDeps) => {
  const { repository, hasher, sessions, logger, createId, dummyHash } = deps;

  const register = async ({ login, password }: Credentials) => {
    const normalized = normalizeLogin(login);
    checkPassword(password);
    const passwordHash = await hasher.hash(password);
    const account = Account.register(createId(), normalized, passwordHash);
    await repository.insert(account);
    logger.info({ accountId: account.id }, 'account registered');
    return { id: account.id };
  };

  const signIn = async ({ login, password }: Credentials) => {
    const account = await repository.findByLogin(normalizeLogin(login));
    const hash = account ? account.passwordHash : dummyHash;
    const isMatch = await hasher.verify(password, hash);
    if (!account || !isMatch) {
      throw new DomainError('Wrong credentials', { code: 'ALX_ERR_AUTH' });
    }
    account.ensureCanSignIn();
    const token = await sessions.start({ accountId: account.id });
    return { token };
  };

  const getProfile = async (session: Session) => ({ accountId: session.accountId });

  return Object.freeze({ register, signIn, getProfile });
};

export type AccountsService = ReturnType<typeof createAccountsService>;
```

`signIn` runs the hash for an unknown login too, so response time does not tell
which logins exist. The blocked check comes after the password check for the
same reason.

### Infra

The repository is the only code that knows the driver and the document shape.
The unique index on `login` decides a duplicate, so there is no
check-then-insert race. `rev` is the optimistic lock.

```ts
// src/modules/accounts/infra/accounts.types.ts
export type AccountDocument = {
  cuid: string;
  login: string;
  passwordHash: string;
  blocked: boolean;
  v: number;
  rev: number;
};
```

```ts
// src/modules/accounts/infra/accounts.collection.ts
import type { Db } from 'mongodb';

import type { AccountDocument } from './accounts.types.ts';

export const ACCOUNTS = 'accounts';

export const openAccounts = async (db: Pick<Db, 'collection'>) => {
  const collection = db.collection<AccountDocument>(ACCOUNTS);
  await collection.createIndex({ login: 1 }, { unique: true });
  return collection;
};
```

```ts
// src/modules/accounts/infra/accounts.repository.ts
import type { Collection } from 'mongodb';

import { DomainError } from '#shared/domain/domain-error';

import { Account } from '../domain/account.ts';
import type { AccountsRepository } from '../domain/accounts.repository.ts';
import type { AccountDocument } from './accounts.types.ts';

const DUPLICATE_KEY = 11000;

const toAccount = ({ cuid, login, passwordHash, blocked, rev }: AccountDocument) =>
  new Account({ id: cuid, login, passwordHash, blocked, rev });

export const createAccountsRepository = (
  collection: Collection<AccountDocument>,
): AccountsRepository => ({
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
      throw new DomainError('Login is taken', { code: 'ALX_ERR_CONFLICT' });
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

In `auth8` the repository extends `RepositoryWithDefaultAutoFields` from
`packages/node/src/dal`, which also maintains timestamps and author stamps, and
the indexes come from a `@alexify/migronaut` migration of the module.

```ts
// src/modules/accounts/infra/password-hasher.ts
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import type { PasswordHasher } from '../app/accounts.ports.ts';

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

### Presentation

The routes get the service through plugin options, read input once and pass
plain values down:

```ts
// src/modules/accounts/presentation/accounts.schemas.ts
import { Schema } from '@alexify/metaschema';

export const CredentialsSchema = Schema.from({ login: 'string', password: 'string' });
```

```ts
// src/modules/accounts/presentation/accounts.routes.ts
import type { FastifyInstance } from 'fastify';

import type { AccountsService } from '../app/accounts.service.ts';
import type { Credentials } from '../app/accounts.types.ts';
import { CredentialsSchema } from './accounts.schemas.ts';

type RoutesOptions = { service: AccountsService };

export const accountsRoutes = async (fastify: FastifyInstance, { service }: RoutesOptions) => {
  const publicRoute = { config: { access: 'public' }, schema: { body: CredentialsSchema } };

  fastify.post<{ Body: Credentials }>('/', publicRoute, async (request, reply) => {
    const created = await service.register(request.body);
    return reply.code(201).send(created);
  });

  fastify.post<{ Body: Credentials }>('/sessions', publicRoute, async (request) => {
    return service.signIn(request.body);
  });

  fastify.get('/me', { config: { access: 'session' } }, async (request) => {
    const { session } = request;
    return service.getProfile(session!);
  });
};
```

### The public API

The index builds the module from what the app passes in, decorates only the
facade and registers the routes under `/accounts`. `fastify-plugin` checks the
declared dependencies at boot.

```ts
// src/modules/accounts/index.ts: the public API and the composition root of the module
import { randomUUID } from 'node:crypto';

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';

import type { SessionStore } from '#shared/app/access';

import { createAccountsService } from './app/accounts.service.ts';
import type { AccountsService } from './app/accounts.service.ts';
import { openAccounts } from './infra/accounts.collection.ts';
import { createAccountsRepository } from './infra/accounts.repository.ts';
import { createPasswordHasher } from './infra/password-hasher.ts';
import { accountsRoutes } from './presentation/accounts.routes.ts';

export type { AccountsService } from './app/accounts.service.ts';

export type AccountsOptions = {
  db: Pick<Db, 'collection'>;
  sessions: SessionStore;
  createId: () => string;
};

declare module 'fastify' {
  interface FastifyInstance {
    accounts: AccountsService;
  }
}

const accountsModule = async (fastify: FastifyInstance, options: AccountsOptions) => {
  const { db, sessions, createId } = options;
  const repository = createAccountsRepository(await openAccounts(db));
  const hasher = createPasswordHasher();
  const dummyHash = await hasher.hash(randomUUID());
  const deps = { repository, hasher, sessions, logger: fastify.log, createId, dummyHash };
  const service = createAccountsService(deps);
  fastify.decorate('accounts', service);
  await fastify.register(accountsRoutes, { prefix: '/accounts', service });
};

export default fp(accountsModule, {
  name: 'accounts',
  dependencies: ['validation', 'errors', 'access'],
});
```

## Plugins

Cross-cutting plugins live outside the modules. Each has a name, and the guard
runs before any route exists. The validator compiler is the recipe from
`js-contracts-schemas`.

```ts
// src/plugins/validation.ts
import fp from 'fastify-plugin';
import type { FastifySchemaCompiler } from 'fastify';
import type { Schema, ValidationIssue } from '@alexify/metaschema';

const TEXT_PARTS = new Set(['querystring', 'params', 'headers']);

const toError = (issues: readonly ValidationIssue[]) => {
  const error = new Error('Validation failed') as Error & Record<string, unknown>;
  error.statusCode = 400;
  error.code = 'ALX_ERR_VALIDATION';
  error.validation = issues;
  return error;
};

const metaschemaCompiler: FastifySchemaCompiler<Schema> = ({ schema, httpPart }) => {
  const part = httpPart ?? '';
  const coerce = TEXT_PARTS.has(part);
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
// src/plugins/errors.ts
import { randomUUID } from 'node:crypto';

import fp from 'fastify-plugin';

import { DomainError } from '#shared/domain/domain-error';

const STATUS: Record<string, number> = {
  ALX_ERR_VALIDATION: 400,
  ALX_ERR_AUTH: 401,
  ALX_ERR_BLOCKED: 403,
  ALX_ERR_CONFLICT: 409,
};

export default fp(
  async (fastify) => {
    fastify.setErrorHandler((error: any, request, reply) => {
      const status = error instanceof DomainError ? STATUS[error.code] : undefined;
      const isClientError = error.statusCode >= 400 && error.statusCode < 500;
      if (status !== undefined || isClientError) {
        const { code, message } = error;
        return reply.code(status ?? error.statusCode).send({ error: { code, message } });
      }
      const errorId = randomUUID();
      request.log.error({ err: error, errorId }, 'unexpected error');
      const failure = { code: 'ALX_ERR_INTERNAL', message: 'Internal error', errorId };
      return reply.code(500).send({ error: failure });
    });
  },
  { name: 'errors' },
);
```

The guard refuses twice. `onRoute` stops the boot when a route has no valid
`access`. `onRequest` refuses at run time, which also covers a route added
before the guard was registered, where `onRoute` did not fire.

```ts
// src/plugins/access.ts
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

import { isAllowed, isDeclared } from '#shared/app/access';
import type { Session, SessionStore } from '#shared/app/access';

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
    return reply.code(403).send({ error: { code: 'ALX_ERR_FORBIDDEN', message: 'Forbidden' } });
  });
};

export default fp(guard, { name: 'access' });
```

## Composition root

`buildApp` takes the infrastructure as an argument, so tests pass fakes. Order
matters: the plugins before the modules, and a module after the modules it
depends on.

```ts
// src/app.ts: the composition root of the application
import Fastify from 'fastify';
import type { FastifyServerOptions } from 'fastify';
import type { Db } from 'mongodb';

import accounts from '#modules/accounts';
import type { SessionStore } from '#shared/app/access';

import access from './plugins/access.ts';
import errors from './plugins/errors.ts';
import validation from './plugins/validation.ts';

export type AppDeps = {
  db: Pick<Db, 'collection'>;
  sessions: SessionStore;
  createId: () => string;
};

export const buildApp = async (deps: AppDeps, options: FastifyServerOptions = {}) => {
  const app = Fastify(options);
  await app.register(validation);
  await app.register(errors);
  await app.register(access, { sessions: deps.sessions });
  await app.register(accounts, deps);
  return app;
};
```

```ts
// src/main.ts: the process entry
import { randomUUID } from 'node:crypto';

import { MongoClient } from 'mongodb';

import { createSessionStore } from '#shared/infra/session-store';

import { buildApp } from './app.ts';

const { DATABASE_URL = '', PORT = '3000' } = process.env;

const client = new MongoClient(DATABASE_URL);
await client.connect();

const deps = { db: client.db(), sessions: createSessionStore(), createId: randomUUID };
const app = await buildApp(deps, { logger: true });
app.addHook('onClose', () => client.close());
await app.listen({ host: '0.0.0.0', port: Number(PORT) });
```

In `auth8` the same wiring is spread across named plugins loaded by
`@fastify/autoload` (over `modules/` with `maxDepth: 1`, see
[modules.md](modules.md)), the configuration is validated by `@fastify/env`, the
ids are CUID2, and the logger is Pino. Shutdown order: `node-graceful-shutdown`.

## Tests

Vitest, AAA, `should` titles, DI fakes. Each test sits in `tests/` next to the
code it checks. The fakes shared by the tests of the module live in the module:

```ts
// src/modules/accounts/tests/fakes.ts: fakes shared by the tests of the module
import type { Account } from '../domain/account.ts';
import type { AccountsRepository } from '../domain/accounts.repository.ts';

export const createFakeCollection = () => {
  const documents: any[] = [];
  return {
    documents,
    createIndex: async () => 'login_1',
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

export const createFakeDb = () => {
  const collection = createFakeCollection();
  return { collection, db: { collection: () => collection as any } };
};

export const createFakeRepository = (): AccountsRepository => {
  const accounts = new Map<string, Account>();
  return {
    findByLogin: async (login) => accounts.get(login) ?? null,
    insert: async (account) => {
      accounts.set(account.toState().login, account);
    },
    save: async () => true,
  };
};

export const fakeHasher = {
  hash: async (value: string) => `h:${value}`,
  verify: async (value: string, hash: string) => hash === `h:${value}`,
};
```

The domain needs no fake:

```ts
// src/modules/accounts/domain/tests/account.test.ts
import { describe, expect, it } from 'vitest';

import { Account } from '../account.ts';
import { normalizeLogin } from '../credentials.ts';

describe('Account', () => {
  it('should refuse to block an account twice', () => {
    // Arrange
    const account = Account.register('a1', 'marcus', 'hash');
    account.block();
    // Act
    const attempt = () => account.block();
    // Assert
    expect(attempt).toThrow(expect.objectContaining({ code: 'ALX_ERR_CONFLICT' }));
  });

  it('should normalize a login and reject a malformed one', () => {
    // Arrange
    const valid = ' Marcus ';
    // Act
    const normalized = normalizeLogin(valid);
    // Assert
    expect(normalized).toBe('marcus');
    const invalid = expect.objectContaining({ code: 'ALX_ERR_VALIDATION' });
    expect(() => normalizeLogin('1 bad')).toThrow(invalid);
  });
});
```

The service runs without a server, with a fake repository:

```ts
// src/modules/accounts/app/tests/accounts.service.test.ts
import { describe, expect, it } from 'vitest';

import { createSessionStore } from '#shared/infra/session-store';

import { createFakeRepository, fakeHasher } from '../../tests/fakes.ts';
import { createAccountsService } from '../accounts.service.ts';

const createDeps = () => ({
  repository: createFakeRepository(),
  hasher: fakeHasher,
  sessions: createSessionStore(),
  logger: { info: () => {} },
  createId: () => 'id-1',
  dummyHash: 'h:dummy',
});

const credentials = { login: 'marcus', password: '12345678' };

describe('accounts service', () => {
  it('should refuse an unknown login even with the dummy password', async () => {
    // Arrange
    const service = createAccountsService(createDeps());
    // Act
    const attempt = service.signIn({ login: 'ghost', password: 'dummy' });
    // Assert
    await expect(attempt).rejects.toMatchObject({ code: 'ALX_ERR_AUTH' });
  });

  it('should refuse a blocked account after the password check', async () => {
    // Arrange
    const deps = createDeps();
    const service = createAccountsService(deps);
    await service.register(credentials);
    const account = await deps.repository.findByLogin('marcus');
    account!.block();
    // Act
    const attempt = service.signIn(credentials);
    // Assert
    await expect(attempt).rejects.toMatchObject({ code: 'ALX_ERR_BLOCKED' });
  });
});
```

The repository runs over a fake collection that behaves like the unique index:

```ts
// src/modules/accounts/infra/tests/accounts.repository.test.ts
import { describe, expect, it } from 'vitest';

import { Account } from '../../domain/account.ts';
import { createFakeCollection } from '../../tests/fakes.ts';
import { createAccountsRepository } from '../accounts.repository.ts';

describe('accounts repository', () => {
  it('should reject a duplicate login through the unique index', async () => {
    // Arrange
    const repository = createAccountsRepository(createFakeCollection() as any);
    await repository.insert(Account.register('a1', 'marcus', 'hash'));
    // Act
    const attempt = repository.insert(Account.register('a2', 'MARCUS', 'hash'));
    // Assert
    await expect(attempt).rejects.toMatchObject({ code: 'ALX_ERR_CONFLICT' });
  });

  it('should detect a lost update through rev', async () => {
    // Arrange
    const repository = createAccountsRepository(createFakeCollection() as any);
    await repository.insert(Account.register('a1', 'marcus', 'hash'));
    const first = (await repository.findByLogin('marcus')) as Account;
    const second = (await repository.findByLogin('marcus')) as Account;
    first.block();
    second.block();
    // Act
    const results = [await repository.save(first), await repository.save(second)];
    // Assert
    expect(results).toEqual([true, false]);
  });
});
```

The routes run through `inject` on the real plugin tree:

```ts
// src/modules/accounts/presentation/tests/accounts.routes.test.ts
import { describe, expect, it } from 'vitest';

import { buildApp } from '#app';
import { createSessionStore } from '#shared/infra/session-store';

import { createFakeDb } from '../../tests/fakes.ts';

const createDeps = () => {
  let counter = 0;
  const { db } = createFakeDb();
  return { db, sessions: createSessionStore(), createId: () => `id-${++counter}` };
};

const credentials = { login: 'marcus', password: '12345678' };

describe('accounts routes', () => {
  it('should register, sign in and serve the profile', async () => {
    // Arrange
    const app = await buildApp(createDeps());
    await app.inject({ method: 'POST', url: '/accounts', payload: credentials });
    // Act
    const signIn = await app.inject({
      method: 'POST',
      url: '/accounts/sessions',
      payload: credentials,
    });
    const authorization = `Bearer ${signIn.json().token}`;
    const me = await app.inject({ url: '/accounts/me', headers: { authorization } });
    const anonymous = await app.inject({ url: '/accounts/me' });
    const missing = await app.inject({ url: '/nowhere' });
    // Assert
    expect(me.json()).toEqual({ accountId: 'id-1' });
    expect([anonymous.statusCode, missing.statusCode]).toEqual([403, 404]);
    await app.close();
  });

  it('should answer 409 to a taken login', async () => {
    // Arrange
    const app = await buildApp(createDeps());
    await app.inject({ method: 'POST', url: '/accounts', payload: credentials });
    // Act
    const again = await app.inject({ method: 'POST', url: '/accounts', payload: credentials });
    // Assert
    expect(again.statusCode).toBe(409);
    await app.close();
  });
});
```

The guard and the access decision are tested where they live:

```ts
// src/plugins/tests/access.test.ts
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { createSessionStore } from '#shared/infra/session-store';

import access from '../access.ts';

describe('access guard', () => {
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

```ts
// src/shared/app/tests/access.test.ts
import { describe, expect, it } from 'vitest';

import { isAllowed, isDeclared } from '../access.ts';

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
```

Run with `pnpm test` (Vitest). The module boundary test is in
[modules.md](modules.md).
