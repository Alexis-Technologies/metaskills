# Schema, validators and migrations

`@alexify/metaschema` is the single source of the document shape. The types, the `$jsonSchema`
validator, the indexes and the update checks all come from it. `@alexify/migronaut` applies them.
ADR-010 and ADR-017 still name TypeBox: the target is metaschema. The system fields are `v` and
`rev`, as ADR-017 names them.

## The model

```ts
// schema/order.model.ts
import { Model } from '@alexify/metaschema';
import type { Schema } from '@alexify/metaschema';
import bson from '@alexify/metaschema/mongodb';
import * as mongodb from 'mongodb';

bson.register({ bson: mongodb });

export const OrderStatus = { Unknown: 0, Open: 1, Paid: 2, Cancelled: 3 } as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export type Order = {
  cuid: string;
  ulid: string;
  tenantId: string;
  customerId: string;
  status: OrderStatus;
  total: unknown;
  v: number;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
  deletedAt?: Date | null;
};

const TYPES = { ...bson.types, int32: { js: 'integer', metadata: { bson: 'int' } } };

const SYSTEM_FIELDS = {
  cuid: { type: 'string', unique: true },
  ulid: 'string',
  tenantId: 'string',
  v: 'int32',
  rev: 'integer',
  createdAt: 'date',
  updatedAt: 'date',
  createdBy: 'string',
  updatedBy: 'string',
  'deletedAt?': 'date',
};

export const model = new Model(TYPES, [
  [
    'Order',
    {
      Entity: {},
      ...SYSTEM_FIELDS,
      customerId: 'string',
      status: { type: 'int32', min: 0 },
      total: 'decimal128',
      byTenantUlid: { index: ['tenantId', 'ulid'] },
      byTenantCustomer: { index: ['tenantId', 'customerId', 'status', 'ulid'] },
    },
  ],
]);

export const OrderSchema = model.entities.get('Order') as Schema;
```

- **`int32`** is a custom type, because the built-in `integer` renders as `['int', 'long']`. A type
  with `metadata.bson` renders only its `bsonType`, so `min: 0` holds in `check` and `parse` but is
  not in the generated `$jsonSchema`.
- **`status` has `min: 0` and no closed `enum`.** During a rolling deploy a newer release writes a
  code the older one does not know. A closed list would refuse that write or that read.
- **A reference to another aggregate is a `string` holding its `cuid`.** A metaschema reference
  (`customer: 'Customer'`) is stored as an ObjectId, which is what ADR-017 section 8 rules out.
- **`ulid` has no index of its own here.** Lists are tenant-scoped, so `{ tenantId, ulid }` serves
  them and `{ ulid: 1 }` would have no query. Add it only to a collection with no tenant.
- `Entity` adds an id field (`orderId`). `toDocument` moves it to `_id`, or leaves `_id` to the
  driver when the field is empty.

## Validator and indexes for migronaut

`toJSONSchema` includes `v` and `rev`, and a migronaut `versioning` block refuses a validator that
constrains the fields it manages. Remove them from the generated schema and let the block add them
back:

```ts
// schema/collections.ts
import { toJSONSchema } from '@alexify/metaschema/generators';
import bson from '@alexify/metaschema/mongodb';

import { model } from './order.model.ts';

const MANAGED = new Set(['v', 'rev']);
const ACTIVE = { deletedAt: null };
const PARTIAL = new Set(['byTenantUlid', 'byTenantCustomer']);
const versioning = { current: 1, min: 1, field: 'v', revisionField: 'rev' };

type StoredSchema = { properties: Record<string, unknown>; required: string[] };

const withoutManaged = (schema: StoredSchema): StoredSchema => {
  const properties: Record<string, unknown> = {};
  for (const name in schema.properties) {
    if (!MANAGED.has(name)) properties[name] = schema.properties[name];
  }
  const required: string[] = [];
  for (const name of schema.required) {
    if (!MANAGED.has(name)) required.push(name);
  }
  return { ...schema, properties, required };
};

const options = { target: 'mongodb', ids: 'objectId' } as const;
const validators = toJSONSchema(model, options) as Record<string, StoredSchema>;
const indexes: Record<string, unknown>[] = [];
for (const index of bson.indexesOf(model).Order) {
  const isPartial = index.name !== undefined && PARTIAL.has(index.name);
  indexes.push(isPartial ? { ...index, partialFilterExpression: ACTIVE } : { ...index });
}

export const orders = {
  name: 'Orders',
  versioning,
  indexes,
  validator: { $jsonSchema: withoutManaged(validators.Order) },
};
```

```ts
// migronaut.config.ts (migronaut init --ts)
import { orders } from './schema/collections.ts';

export default {
  uri: process.env.MIGRONAUT_URI,
  dbName: process.env.MIGRONAUT_DB,
  collections: [orders],
};
```

`migronaut converge --dry-run` shows the plan and `migronaut converge` applies it. The block adds
`v` and `rev` to the validator (`additionalProperties: false` stays correct) and creates the
`{ v: 1, _id: 1 }` index that background migrations scan.

`indexesOf` returns `key`, `name`, `unique` and `sparse`. TTL and partial options are added in the
definition, as above:

```js
const sessionIndexes = [{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }];
```

`expireAfterSeconds: 0` removes a document at the date in its field. The TTL monitor runs about once
a minute, so a read must still check the expiry itself.

## The metaschema calls

| Call | Use |
| --- | --- |
| `bson.register({ bson: mongodb })` | once per process, before the calls below |
| `toJSONSchema(model, { target: 'mongodb', ids: 'objectId' })` | one `$jsonSchema` per entity |
| `bson.indexesOf(model)` | `createIndexes` descriptions per entity |
| `bson.toDocument(schema, value)` | a parsed value to a document |
| `bson.fromDocument(schema, document, options)` | a document to `{ valid, value, issues }` |
| `bson.checkUpdate(schema, update)` | issues of an update operator document |
| `bson.toUpdate(schema, update)` | a checked update as the driver takes it |

`fromDocument` returns a result and does not throw, including for the `null` of an empty `findOne`.
Check `valid`.

## Migrations

Use a migration for a change that must run once and in order: a backfill, a rename, a dedupe. Use a
declared collection and `converge` for the current indexes and validator.

```js
// migrations/20261121120000-orders-default-status.js
export const description = 'Set the status of orders written before it existed';
export const useTransaction = true;

export const up = async ({ db, session }) => {
  const filter = { status: { $exists: false } };
  await db.collection('Orders').updateMany(filter, { $set: { status: 1 } }, { session });
};

export const down = async ({ db, session }) => {
  await db.collection('Orders').updateMany({}, { $unset: { status: '' } }, { session });
};
```

- `up` and `down` are both required, and an applied file is never edited: its checksum would fail.
- `useTransaction` needs a replica set. Without `{ session }` a call runs outside the transaction.
- A unique index over dirty data needs a dedupe migration first, then the declared index.
- A rewrite of a large collection is a **background migration**, because an ordinary one holds the
  migration lock until it ends.

## Changing a document's shape

Use expand, background migration, contract:

1. **Expand.** The release reads both shapes and writes the new one. Raise `current`, keep `min`.
2. **Background.** Rewrite the older documents beside the application: with the BullMQ job of
   ADR-017 section 13, or with a migronaut background migration.
3. **Contract.** A later release raises `min`. Converge refuses while older documents remain.

Both write only what a step changes, guarded by `_id`, the old `v` and the `rev` they read, so a
document the application wrote in between is not overwritten. In auth8 follow the ADR and use the
job. migronaut's background runner brings its own leases, checkpoints, throttle and dry run, and
runs from its CLI (`migronaut background`).

### As a migronaut background migration

```js
// migrations/20261201120000-orders-shipping.js
export const description = 'Move address into shipping';

export const background = {
  collection: 'Orders',
  from: 1,
  to: 2,
  versionField: 'v',
  revisionField: 'rev',
  migrate: ({ address, ...document }) => ({ ...document, shipping: { address } }),
  revert: ({ shipping, ...document }) => ({ ...document, address: shipping.address }),
};
```

A declared collection already supplies the two field names. Keep them in the file anyway, so that it
stays correct if the declaration moves. Lazy migration on read stays the exception (ADR-017 section
13).

### As a BullMQ job (ADR-017)

```ts
// jobs/shape-migration.ts, in auth8-jobs
import { Actor, ActorType, systemActor } from '@auth8/enums';
import { ObjectId } from 'mongodb';
import type { AnyBulkWriteOperation, Collection, Document, UpdateFilter } from 'mongodb';

export type ShapeStep = {
  from: number;
  to: number;
  actor: string;
  // Only what changes, so every other field keeps its stored BSON type.
  migrate: (document: Document) => UpdateFilter<Document>;
};

const BATCH_SIZE = 500;

export const ordersShipping: ShapeStep = {
  from: 1,
  to: 2,
  actor: systemActor(ActorType.Migration, Actor.OrdersShipping),
  migrate: (order) => ({
    $set: { shipping: { address: order.address } },
    $unset: { address: '' },
  }),
};

// One batch per run: the cursor of the next batch, or null at the end of a pass.
export const migrateBatch = async (
  collection: Collection,
  step: ShapeStep,
  after: string | null,
): Promise<string | null> => {
  const filter: Document = { v: step.from };
  if (after !== null) filter._id = { $gt: new ObjectId(after) };
  const batch = await collection.find(filter).sort({ _id: 1 }).limit(BATCH_SIZE).toArray();
  const stamp = { v: step.to, updatedAt: new Date(), updatedBy: step.actor };
  const operations: AnyBulkWriteOperation[] = [];
  for (const document of batch) {
    const update = step.migrate(document);
    const set = { ...update.$set, ...stamp };
    const inc = { ...update.$inc, rev: 1 };
    operations.push({
      updateOne: {
        filter: { _id: document._id, v: step.from, rev: document.rev },
        update: { ...update, $set: set, $inc: inc },
      },
    });
  }
  if (operations.length > 0) await collection.bulkWrite(operations, { ordered: false });
  return batch.length < BATCH_SIZE ? null : String(batch[batch.length - 1]._id);
};
```

- The processor runs in `auth8-jobs` behind the job-scheduler port of ADR-013, on the jobs Redis.
  A job holds the collection, the step and `after`, and enqueues the next batch with the returned
  cursor under a job id of the step and cursor, so a retried job does not fork the sweep.
- Jobs are at least once. The guarded write makes a rerun harmless.
- `bulkWrite` throws when any write fails, a validator's 121 among them, after the others ran. Log
  the failed operations (`writeErrors`, by index) and fix the step, rather than let the job retry
  forever.
- A document whose `rev` moved matches nothing and stays at `v: from`. When a pass ends, start
  another from `after: null`. The sweep is done when a pass finds nothing at `v: from`.
- The query runs on the `{ v: 1, _id: 1 }` index the `versioning` block creates. Pace the batches
  with a delay or BullMQ's rate limiter, so the sweep does not starve the primary.

## Revision helpers

`@alexify/migronaut/versioning` holds the guard as functions. They default to the double-underscore
names, so pass the names on **every** call, or wrap the helpers once in the DAL:

```js
const { bumpRevision, retryOnConflict, updateWithRevision } = require('@alexify/migronaut/versioning');

const REVISION = { revisionField: 'rev' };

const markPaid = (orders, _id) =>
  retryOnConflict(async () => {
    const order = await orders.findOne({ _id });
    if (order === null) return null;
    return updateWithRevision(orders, { _id }, order.rev ?? 0, { $set: { status: 2 } }, REVISION);
  });

const moveRegion = (orders, customerId) =>
  orders.updateMany({ customerId }, bumpRevision({ $set: { region: 'eu' } }, REVISION));
```

A conflict throws `RevisionConflictError` with `context.reason` of `conflict`, `not-found` or
`unknown`. Retry only a pure read-decide-write: a retry after a user edit would overwrite that edit,
so answer 409 there. The versioning API is marked experimental in migronaut 2.5.

Related skills: `js-contracts-schemas`, `alexis-libraries`
