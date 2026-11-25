# Concurrency in MongoDB (reference)

The practice of `auth8`: ADR-017 for the system fields and its DAL for
transactions. `retry` and `DomainError` are the ones from `error-handling`.

| Need                                             | Tool                                       |
| ------------------------------------------------ | ------------------------------------------ |
| Change one document, the rule fits a filter      | Atomic operators with a conditional filter |
| Read-modify-write of one aggregate, domain logic | Optimistic concurrency with `rev`          |
| A retried call must take effect once             | Idempotency key under a unique index       |
| Only one active record of a kind                 | Unique (or partial unique) index           |
| An invariant across documents or collections     | Transaction                                |

Every write to a single document is atomic. Prefer a model where one aggregate
is one document: then the first two rows cover most of the code.

## Atomic operators

```js
const reserveSeat = async (events, cuid) => {
  const filter = { cuid, seatsLeft: { $gt: 0 } };
  const result = await events.updateOne(filter, { $inc: { seatsLeft: -1 } });
  if (result.matchedCount === 0) throw new DomainError('Sold out', { code: 'ALX_ERR_SOLD_OUT' });
};
```

- The condition and the change run as one step on the server, across every
  process. There is no window for a race, and no `rev` is needed (ADR-017 §14).
- `matchedCount === 0` means the condition failed or the document is absent.
  Read it again only if the caller needs to tell these apart.
- Money is `Decimal128` or integer minor units, never `double` (ADR-017 §12).
- The base repository stamps `updatedAt` and `updatedBy` on every mutation.

## Optimistic concurrency with `rev`

Use it when the new value comes from domain logic that cannot be a filter.

```js
const isConflict = (error) => error.code === 'ALX_ERR_CONFLICT';

const withdrawOnce = async (accounts, cuid, amount) => {
  const account = await accounts.findOne({ cuid });
  if (account === null) throw new DomainError('Account not found', { code: 'ALX_ERR_NOT_FOUND' });
  const balance = debit(account, amount);
  const update = { $set: { balance }, $inc: { rev: 1 } };
  const result = await accounts.updateOne({ cuid, rev: account.rev }, update);
  if (result.matchedCount === 0) {
    throw new DomainError('Account changed', { code: 'ALX_ERR_CONFLICT' });
  }
  return balance;
};

const withdraw = async (accounts, cuid, amount) => {
  const attempt = () => withdrawOnce(accounts, cuid, amount);
  try {
    return await retry(attempt, { attempts: 5, delayMs: 20, isRetryable: isConflict });
  } catch (error) {
    if (!(error instanceof AggregateError)) throw error;
    throw new DomainError('Account changed', { code: 'ALX_ERR_CONFLICT', cause: error });
  }
};
```

- Retry the whole read-modify-write. Writing the old result again with a new
  `rev` is the lost update this pattern exists to stop.
- `retry` ends with an `AggregateError` that has no `code`. Wrap it, so the
  boundary answers 409 and not 500.
- Only conflicts are retried here. After a network error the write may already
  be applied, and a second debit would be wrong. The driver's `retryWrites`
  repeats one failed write safely.
- Do not put `rev` in `$set` together with `$inc: { rev: 1 }`: the server
  rejects two operators on one path.
- `rev` is on every collection, but a write uses it only when the aggregate
  needs it. Append-only collections never do.

## Idempotency key

```js
const runOnce = async (operations, key, run) => {
  try {
    await operations.insertOne({ key, status: 'started' });
  } catch (error) {
    if (error.code !== 'ALX_ERR_DAL_DUPLICATE_KEY') throw error;
    return operations.findOne({ key });
  }
  const result = await run();
  await operations.updateOne({ key }, { $set: { status: 'done', result } });
  return { key, status: 'done', result };
};
```

- The unique index on `key` is the lock: of two concurrent calls, one insert
  wins and the other gets a duplicate key error.
- The DAL maps the driver's code `11000` to `DuplicateKeyError` with the code
  `ALX_ERR_DAL_DUPLICATE_KEY`. Branch on the code, never on the message.
- A record stuck in `started` means the owner crashed or is still running.
  Answer 409 and let a TTL index (ADR-017 §4) or a job clear it.
- Concurrent upserts on one unique key can also fail with a duplicate key
  error, so `$setOnInsert` with `upsert: true` needs the same handling.

## Transactions

```ts
await withTransaction(client, async (session) => {
  await users.insertOne(user, { session });
  await orgs.updateOne({ cuid: orgId }, { $inc: { seats: 1 } }, { session });
});
```

`withTransaction` is the helper of the `auth8` DAL
(`packages/node/src/dal/session/transaction.ts`). It starts a session, runs
`session.withTransaction`, retries the unit of work on the
`TransientTransactionError` label, and ends the session in `finally`. When the
retries run out it throws `TransactionError` (`ALX_ERR_DAL_TRANSACTION`).

- Pass `{ session }` to every call. A call without it runs outside the
  transaction and is not rolled back.
- Await calls one after another. `Promise.all`, `allSettled` and `race` inside
  a transaction are undefined behaviour in the driver.
- The callback can run several times. Keep emails, queue jobs and HTTP calls
  out of it: do them after the commit, or write an outbox record inside it.
- Never swallow an error inside the callback. The driver then cannot tell
  whether the transaction was aborted and may retry it indefinitely.
- To hold a document for the duration, write to it first (`$inc: { rev: 1 }`).
  A concurrent transaction on it gets a write conflict and is retried.
- Transactions need a replica set or a sharded cluster, and they cost more than
  a single write. Keep them short and use them only for real cross-document
  invariants.

## Limits of the driver's `signal`

`signal` on driver operations is marked experimental. An abort during socket
I/O closes the connection, so frequent aborts can empty the pool. For a query
deadline prefer `maxTimeMS`, which the server enforces.
