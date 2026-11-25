---
name: node-data-access
description: The Node.js data layer on native MongoDB. Use for a DAL, repositories, transactions, indexes, migrations or NoSQL injection
---

<!-- Alexis stack: database-independent rules first, then the MongoDB profile of auth8
     (ADR-010, ADR-017) with metaschema, migronaut, v and rev. -->

# Data access in Node.js

Keep persistence in a thin, explicit layer: one injected client, repositories that own their
queries, transactions with a clear boundary, and driver errors translated before they leave the
layer. Domain code calls `orders.markPaid(cuid, rev, context)`. It never sees the driver, a filter
built from input or a driver error.

|  | Library `@alexify/*` | App (`auth8`) |
| --- | --- | --- |
| Driver | Injected, no runtime dependency | Native `mongodb`, no ODM |
| Layer | Takes a collection or client | Own DAL, one repository per aggregate |
| Schema | `@alexify/metaschema` | `@alexify/metaschema`, validators generated from it |
| Migrations | None | `@alexify/migronaut`; shape migrations also as a BullMQ job |

Read when needed:

- [references/repository.md](references/repository.md): base repository, aggregate repository, mapper
- [references/schema-migrations.md](references/schema-migrations.md): model, `$jsonSchema`, indexes,
  migrations, shape versions, the BullMQ shape job
- [references/document-conventions.md](references/document-conventions.md): ADR-017 field by field,
  and where auth8 differs from it

## Rules for any database

### One client per process

- Create **one client per database per process** in the composition root and inject it. The client
  owns the connection pool. A client per request or per module exhausts the server.
- Use a short-lived client only in scripts and migrations.
- Budget connections: `pool size x instances + headroom <= server limit`. Headroom covers a rolling
  deploy (old and new connected together), jobs, migrations and emergency admin access.
- Close the client after the HTTP drain, never before it (`node-graceful-shutdown`).

### Explicit transactions

- Prefer one atomic write. Use a transaction only when an invariant really spans several records.
- Keep it short. No HTTP calls, queue waits, timers or user prompts inside.
- The callback can **run more than once**, so it must have no side effects outside the transaction.
  Send emails and publish events after the commit, or through an outbox written in the transaction.
- Pass the session to **every** call. A call without it commits on its own and is never rolled back.
- Run the statements of one transaction in sequence. A session is not safe for parallel calls.
- Do not catch a write error inside and carry on: the server has already aborted the transaction.
- Avoid check-then-act. Use a conditional write or an optimistic guard.

### Timeouts

Set every timeout explicitly: waiting for a server, for a pooled connection, and for the whole
operation. A default of "wait forever" turns one slow dependency into a hung service.

### Parameters and injection

- A value from outside is **data**. It never becomes query structure: an operator, a field name, a
  sort key, a collection name or code.
- Validate input against the schema before it reaches a repository.
- Take identifiers (fields, sort keys, directions) from a fixed allow-list.
- The application's database user has only the rights it needs. Admin credentials are for setup and
  never live in the repository (`node-security`).

### Error mapping

- Translate driver errors at the data boundary into typed errors, with the original as `cause`.
- Never send driver messages, key values or collection names to a client (`error-handling`).
- Retry automatically only what the database calls retryable, and retry the whole unit of work.

### Migrations

- Every structural change is an ordered, recorded migration, guarded by a lock. Never edit an
  applied one.
- Zero downtime: expand, backfill in batches, deploy code that handles both, contract.

### Pagination and large reads

- Use **keyset pagination** on a stable, unique sort key. Large offsets scan what they skip.
- Fetch `limit + 1` to learn whether a next page exists. Avoid exact totals on large collections.
- Cap `limit` on the server and validate the cursor like any other input.
- Stream large results through a cursor with `for await`.

## Alexis MongoDB profile

### Layers

```text
Domain          repository interfaces, aggregates, invariants
Application     services, transaction boundaries, the actor and tenant context
Infrastructure  dal/ (connection, base repository, mapper, errors, transaction)
                repositories/ (one per aggregate, implements the Domain interface)
```

No Mongoose and no other ODM. Nothing above Infrastructure imports `mongodb`.

### Client options

```ts
const client = new MongoClient(config.DATABASE_URL, {
  appName: config.SERVICE_NAME,
  maxPoolSize: 20,
  serverSelectionTimeoutMS: 5_000,
  connectTimeoutMS: 5_000,
  waitQueueTimeoutMS: 2_000,
  timeoutMS: 10_000,
});
```

The driver defaults are 100 connections, 30 s to select a server, and **no limit** on the pool wait
or the socket. Retryable reads and writes are on by default: keep them. `timeoutMS` is marked
experimental in driver 7. Without it, set `maxTimeMS` per query, and never mix the two.

### Document shape

Every document has `_id` (internal), `cuid` (public id, unique), `ulid` (cursor), `v`, `rev`,
`createdAt`, `updatedAt`, `createdBy`, `updatedBy`. Tenant-dependent collections add `tenantId`.

- References between aggregates store the target's `cuid`, never `_id`.
- An actor is a user's `cuid` or a system actor such as `sys:job:audit-log-rollup`.
- Enums are stored as `int32`, with `0` reserved for `Unknown`, and codes are append-only.
- Dates are BSON `Date` in UTC. Money is `Decimal128` or integer minor units, never `double`.
- `createdAt` and `createdBy` never change after insert.

### Tenant scoping

**The DAL injects the tenant filter** (ADR-017 section 9), so application code cannot query across
tenants. `auth8/packages/node/src/dal` has no `tenantId` yet, so do not assume it is there.

- Every read and write of a tenant-dependent collection goes through the base repository's
  `scoped()`.
- It takes `tenantId` from the authenticated context, never from the request body.
- It throws when the tenant is missing. With `ignoreUndefined: true`, which auth8 sets, an
  `undefined` value **vanishes from the filter** and the query runs across all tenants.
- It writes the tenant last, so a caller's filter cannot replace it.
- Compound indexes start with `tenantId`.

A row-level rule from `@alexify/kerberos` is added to the filter, inside this scope. It never
replaces the tenant.

### Errors

```ts
// dal/errors.ts
import { MongoError } from 'mongodb';

const DUPLICATE_KEY = 11_000;
const DOCUMENT_VALIDATION = 121;
const MAX_TIME_EXPIRED = 50;
const TRANSACTION_LABELS = ['TransientTransactionError', 'UnknownTransactionCommitResult'];
const UNAVAILABLE = new Set([
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',
  'MongoNotConnectedError',
  'MongoTopologyClosedError',
  'MongoWaitQueueTimeoutError',
]);

export const hasTransactionLabel = (error: unknown): boolean => {
  if (!(error instanceof MongoError)) return false;
  for (const label of TRANSACTION_LABELS) {
    if (error.hasErrorLabel(label)) return true;
  }
  return false;
};

// A labelled error passes through unchanged: the driver retries only a MongoError with its label.
export const toDalError = (error: unknown): unknown => {
  if (!(error instanceof MongoError) || hasTransactionLabel(error)) return error;
  const options = { cause: error };
  if (error.code === DUPLICATE_KEY) {
    const { keyPattern } = error as MongoError & { keyPattern?: Record<string, unknown> };
    return new DuplicateKeyError(Object.keys(keyPattern ?? {}), options);
  }
  if (error.code === DOCUMENT_VALIDATION) {
    return new DalError('Document rejected by the validator', 'ALX_ERR_DAL_VALIDATION', options);
  }
  const isTimeout = error.code === MAX_TIME_EXPIRED || error.name === 'MongoOperationTimeoutError';
  if (isTimeout) return new DalError('Database timeout', 'ALX_ERR_DAL_TIMEOUT', options);
  if (UNAVAILABLE.has(error.name)) {
    return new DalError('Database unavailable', 'ALX_ERR_DAL_UNAVAILABLE', options);
  }
  return new DalError('Database operation failed', 'ALX_ERR_DAL', options);
};

export class DalError extends Error {
  readonly code: string;

  constructor(message: string, code = 'ALX_ERR_DAL', options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class DuplicateKeyError extends DalError {
  readonly fields: string[];

  constructor(fields: string[], options?: ErrorOptions) {
    super('Duplicate key', 'ALX_ERR_DAL_DUPLICATE_KEY', options);
    this.fields = fields;
  }
}

export class DocumentNotFoundError extends DalError {
  constructor(collection: string) {
    super(`Document not found in ${collection}`, 'ALX_ERR_DAL_NOT_FOUND');
  }
}

export class ConcurrentUpdateError extends DalError {
  constructor(collection: string) {
    super(`Concurrent update in ${collection}`, 'ALX_ERR_DAL_CONFLICT');
  }
}

export class InvalidQueryError extends DalError {
  constructor(message: string) {
    super(message, 'ALX_ERR_DAL_INVALID_QUERY');
  }
}

export class DocumentValidationError extends DalError {
  readonly issues: unknown;

  constructor(issues: unknown) {
    super('Document does not match its schema', 'ALX_ERR_DAL_VALIDATION');
    this.issues = issues;
  }
}

export class TransactionError extends DalError {
  constructor(options?: ErrorOptions) {
    super('Transaction failed after retries', 'ALX_ERR_DAL_TRANSACTION', options);
  }
}
```

`DuplicateKeyError.fields` names the unique key from `keyPattern`. Do not copy `keyValue`: it holds
the user's data. Map `ALX_ERR_DAL_DUPLICATE_KEY` and `ALX_ERR_DAL_CONFLICT` to 409,
`ALX_ERR_DAL_NOT_FOUND` to 404, `ALX_ERR_DAL_UNAVAILABLE` to 503 and `ALX_ERR_DAL_TIMEOUT` to 504.

### Transactions

```ts
// dal/transaction.ts
import type { ClientSession, MongoClient } from 'mongodb';

import { TransactionError, hasTransactionLabel, toDalError } from './errors.ts';

const TRANSACTION_TIMEOUT_MS = 10_000;

export const withTransaction = async <R>(
  client: MongoClient,
  work: (session: ClientSession) => Promise<R>,
  timeoutMS = TRANSACTION_TIMEOUT_MS,
): Promise<R> => {
  const session = client.startSession();
  try {
    return await session.withTransaction(work, { timeoutMS });
  } catch (error) {
    throw hasTransactionLabel(error) ? new TransactionError({ cause: error }) : toDalError(error);
  } finally {
    await session.endSession();
  }
};
```

- `session.withTransaction` already retries `TransientTransactionError` and an unknown commit
  result, for up to 120 s without `timeoutMS`. Do not add a second retry loop around it.
- **Never wrap a labelled error inside the callback.** The driver retries only a `MongoError` that
  carries the label. A repository that wraps every error turns a write conflict into a failure with
  no retry. Map at the boundary, as above.
- Transactions need a replica set. Prefer one document per aggregate, so most writes need none.

### Optimistic concurrency

Read `rev`, then write with `{ cuid, rev }` in the filter and `$inc: { rev: 1 }`:

```ts
const result = await collection.updateOne(
  { cuid: { $eq: cuid }, tenantId: { $eq: tenantId }, rev },
  { $set: { status, updatedAt: now, updatedBy: actor }, $inc: { rev: 1 } },
  { session },
);
if (result.matchedCount === 0) throw new ConcurrentUpdateError('Orders');
```

- Check `matchedCount`, not `modifiedCount`.
- Validate `rev` as an integer. An `undefined` guard vanishes from the filter like any other value.
- `rev` is on every document, but **not every write bumps it** (ADR-017 section 14): the guard is
  a choice per aggregate, and a single atomic operator (`$inc`) or an append-only collection needs
  none. Bump it on writes to fields a background migration rewrites: its guard sees only `rev`.
- `@alexify/migronaut/versioning` has `updateWithRevision`, `retryOnConflict` and `bumpRevision`. It
  defaults to other field names, so always pass `revisionField: 'rev'`, and `field: 'v'` in a
  `versioning` block.

### NoSQL operator injection

```ts
// BAD: a body of { "login": { "$ne": null } } matches the first account
const account = await accounts.findOne({ login: body.login });

// GOOD: the schema refuses an object, and $eq keeps a value a value
const { valid, value } = SignIn.parse(body);
if (!valid) throw new InvalidQueryError('Invalid credentials payload');
const found = await accounts.findOne({ login: { $eq: value.login }, tenantId: { $eq: tenantId } });
```

- Never pass a request object as a filter, an update, a projection or a sort.
- Never use `$where`, `$function` or `$accumulator` with input.
- Build `$set` from validated fields and run `checkUpdate`, so a body cannot write `role` or `rev`.
- Escape and anchor any `$regex` built from input, or use Atlas Search.

### Pagination on `ulid`

```ts
const filter = { tenantId: { $eq: tenantId }, deletedAt: null, ulid: { $gt: after } };
const documents = await collection.find(filter).sort({ ulid: 1 }).limit(limit + 1).toArray();
```

The index is `{ tenantId: 1, ulid: 1 }`. Do not page on `createdAt`: timestamps collide, and the
cursor then skips or repeats documents. A full version is `list()` in `references/repository.md`.

### Indexes, deletion, TTL

- Create exactly the indexes real queries use, and verify them with `explain`.
- Soft delete sets `deletedAt`, and active queries send `deletedAt: null` to use partial indexes.
- **GDPR erasure is not a soft delete.** It is a physical delete or crypto-shredding.
- Add a TTL index where the business expires data, with a retention reason that fits compliance.

### Schema and migrations

`@alexify/metaschema` is the source: `toJSONSchema(model, { target: 'mongodb', ids: 'objectId' })`
for validators and `@alexify/metaschema/mongodb` for `toDocument`, `fromDocument`, `checkUpdate`,
`toUpdate` and `indexesOf`. `@alexify/migronaut` applies them with `converge` and runs migrations.

A shape migration (a new `v`) runs out of band, never on read: as the BullMQ job of ADR-017 section
13, or as a migronaut background migration. migronaut keeps the indexes and validators either way
(`references/schema-migrations.md`).

A `versioning` block refuses a validator that constrains `v` or `rev`. Remove both from the
generated schema first (`references/schema-migrations.md`).

## Anti-patterns

- A request body used as a filter, or a sort key taken from `req.query` without an allow-list.
- A repository method without tenant scope, or `tenantId` read from the body.
- `undefined` reaching a filter while `ignoreUndefined` is on.
- Wrapping driver errors inside a transaction callback, or a second retry loop around it.
- A transaction callback that sends email, calls HTTP or runs statements in `Promise.all`.
- `modifiedCount === 0` read as a conflict.
- An OCC write without the `rev` guard, or a write that skips the bump on fields a background
  migration rewrites.
- Shape migration on read as the default.
- `skip` for deep pagination, or `countDocuments` on every page.
- An index with no query, or a compound index that does not start with `tenantId`.
- `_id` in an API or as a reference.
- Enum labels stored as strings on high-volume collections, or a reused code.
- A soft delete presented as GDPR erasure.
- A hand-written validator beside the metaschema model.

## Checklist

- [ ] One client per process, injected, closed after the HTTP drain.
- [ ] Pool wait, server selection and operation timeouts are set.
- [ ] Nothing above Infrastructure imports `mongodb`.
- [ ] Every tenant-dependent query goes through `scoped()`, which throws without a tenant.
- [ ] Input is validated, values use `$eq`, identifiers come from an allow-list.
- [ ] Transactions are short, pass the session everywhere and have no external side effects.
- [ ] Labelled errors reach `session.withTransaction` unchanged.
- [ ] `11000` maps to `DuplicateKeyError`, and no key value reaches a client.
- [ ] Every write stamps `updatedAt` and `updatedBy`, and `createdAt` stays.
- [ ] OCC writes guard and bump `rev`.
- [ ] Lists use keyset pagination on `ulid` with a capped `limit`.
- [ ] Every query has an index, and every index has a query.
- [ ] The validator and indexes are generated from metaschema and applied by migronaut.
- [ ] Shape migrations run out of band: a BullMQ job or a migronaut background migration.
- [ ] Soft delete, erasure and TTL are decided per collection.

Related skills: `alexis-libraries`, `js-contracts-schemas`, `error-handling`,
`node-graceful-shutdown`, `node-layered-architecture`, `node-access-control`, `node-security`
