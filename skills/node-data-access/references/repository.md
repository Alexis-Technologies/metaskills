# Base repository, aggregate repository, mapper

The target shape of an Alexis DAL in TypeScript (ESM, NodeNext). It extends what
`auth8/packages/node/src/dal` has today with the parts ADR-017 requires and the code does not do
yet: tenant scope, `v` and `rev` stamping, and the revision guard. Every block below ran on Node.js
24 against an in-memory fake of the collection. `dal/errors.ts` and `dal/transaction.ts` are in
`SKILL.md`.

## Base repository

```ts
// dal/base-repository.ts
import type { ClientSession, Collection, Document, Filter, UpdateFilter } from 'mongodb';

import { ConcurrentUpdateError, DocumentNotFoundError, InvalidQueryError } from './errors.js';
import { toDalError } from './errors.js';

export type Context = { tenantId: string; actor: string; session?: ClientSession };
export type Mapper<T> = {
  toDocument(entity: Document): Document;
  fromDocument(document: Document): T;
  toUpdate(update: UpdateFilter<Document>): UpdateFilter<Document>;
};
export type Ids = () => { cuid: string; ulid: string };
export type Page<T> = { items: T[]; nextCursor: string | null };
export type RepositoryDeps<T> = {
  collection: Collection;
  mapper: Mapper<T>;
  ids: Ids;
  version: number;
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SYSTEM_FIELDS = new Set([
  '_id',
  'cuid',
  'ulid',
  'tenantId',
  'v',
  'rev',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
  'deletedAt',
]);

const requireText = (value: unknown, name: string): string => {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new InvalidQueryError(`${name} must be a non-empty string`);
};

const requireRevision = (value: unknown): number => {
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  throw new InvalidQueryError('rev must be a non-negative integer');
};

const assertNoSystemFields = (update: UpdateFilter<Document>): void => {
  for (const operator in update) {
    if (!operator.startsWith('$')) throw new InvalidQueryError('An operator update is required');
    const fields = update[operator] as Document;
    for (const path in fields) {
      const root = path.split('.', 1)[0];
      if (SYSTEM_FIELDS.has(root)) throw new InvalidQueryError(`${root} is managed by the DAL`);
    }
  }
};

export class BaseRepository<T> {
  protected readonly collection: Collection;
  protected readonly mapper: Mapper<T>;
  protected readonly ids: Ids;
  protected readonly version: number;

  constructor(deps: RepositoryDeps<T>) {
    this.collection = deps.collection;
    this.mapper = deps.mapper;
    this.ids = deps.ids;
    this.version = deps.version;
  }

  // The only way a filter reaches the driver. The tenant is written last, so input cannot replace it.
  protected scoped(context: Context, filter: Document = {}): Filter<Document> {
    const tenantId = requireText(context.tenantId, 'tenantId');
    return { ...filter, tenantId: { $eq: tenantId } };
  }

  protected active(context: Context, filter: Document = {}): Filter<Document> {
    return this.scoped(context, { ...filter, deletedAt: null });
  }

  async create(input: Document, context: Context): Promise<T> {
    const actor = requireText(context.actor, 'actor');
    const tenantId = requireText(context.tenantId, 'tenantId');
    const now = new Date();
    const { cuid, ulid } = this.ids();
    const system = { cuid, ulid, tenantId, v: this.version, rev: 0 };
    const stamps = { createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor };
    const document = this.mapper.toDocument({ ...input, ...system, ...stamps });
    try {
      await this.collection.insertOne(document, { session: context.session });
    } catch (error) {
      throw toDalError(error);
    }
    return this.mapper.fromDocument(document);
  }

  async findByCuid(cuid: string, context: Context): Promise<T | null> {
    const id = requireText(cuid, 'cuid');
    const filter = this.active(context, { cuid: { $eq: id } });
    try {
      const document = await this.collection.findOne(filter, { session: context.session });
      return document === null ? null : this.mapper.fromDocument(document);
    } catch (error) {
      throw toDalError(error);
    }
  }

  async list(context: Context, page: { after?: string; limit?: number } = {}): Promise<Page<T>> {
    const limit = Math.min(Math.max(Math.trunc(page.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
    const filter: Document = {};
    if (page.after !== undefined) {
      if (typeof page.after !== 'string' || !ULID.test(page.after)) {
        throw new InvalidQueryError('Invalid cursor');
      }
      filter.ulid = { $gt: page.after };
    }
    const options = { session: context.session, sort: { ulid: 1 }, limit: limit + 1 } as const;
    try {
      const documents = await this.collection.find(this.active(context, filter), options).toArray();
      const size = Math.min(documents.length, limit);
      const items: T[] = new Array(size);
      for (let i = 0; i < size; i++) items[i] = this.mapper.fromDocument(documents[i]);
      const hasNext = documents.length > limit;
      return { items, nextCursor: hasNext ? documents[limit - 1].ulid : null };
    } catch (error) {
      throw toDalError(error);
    }
  }

  // Read-modify-write under the revision the caller read.
  async update(
    cuid: string,
    expectedRev: number,
    update: UpdateFilter<Document>,
    context: Context,
  ): Promise<number> {
    const id = requireText(cuid, 'cuid');
    const rev = requireRevision(expectedRev);
    const actor = requireText(context.actor, 'actor');
    assertNoSystemFields(update);
    const stored = this.mapper.toUpdate(update);
    const stamp = { updatedAt: new Date(), updatedBy: actor };
    const guarded = this.active(context, { cuid: { $eq: id }, rev });
    const write = {
      ...stored,
      $set: { ...stored.$set, ...stamp },
      $inc: { ...stored.$inc, rev: 1 },
    } as UpdateFilter<Document>;
    try {
      const { session } = context;
      const result = await this.collection.updateOne(guarded, write, { session });
      if (result.matchedCount === 1) return rev + 1;
      const current = this.active(context, { cuid: { $eq: id } });
      const found = await this.collection.findOne(current, { projection: { rev: 1 }, session });
      if (found === null) throw new DocumentNotFoundError(this.collection.collectionName);
      throw new ConcurrentUpdateError(this.collection.collectionName);
    } catch (error) {
      throw toDalError(error);
    }
  }

  async softDelete(cuid: string, expectedRev: number, context: Context): Promise<number> {
    const id = requireText(cuid, 'cuid');
    const rev = requireRevision(expectedRev);
    const actor = requireText(context.actor, 'actor');
    const now = new Date();
    const filter = this.active(context, { cuid: { $eq: id }, rev });
    const write = { $set: { deletedAt: now, updatedAt: now, updatedBy: actor }, $inc: { rev: 1 } };
    try {
      const { session } = context;
      const result = await this.collection.updateOne(filter, write, { session });
      if (result.matchedCount === 1) return rev + 1;
      const found = await this.collection.findOne(this.active(context, { cuid: { $eq: id } }), {
        projection: { rev: 1 },
        session,
      });
      if (found === null) throw new DocumentNotFoundError(this.collection.collectionName);
      throw new ConcurrentUpdateError(this.collection.collectionName);
    } catch (error) {
      throw toDalError(error);
    }
  }

  // Physical removal for an erasure request. It reaches soft-deleted documents on purpose.
  async erase(cuid: string, context: Context): Promise<boolean> {
    const id = requireText(cuid, 'cuid');
    const filter = this.scoped(context, { cuid: { $eq: id } });
    try {
      const { deletedCount } = await this.collection.deleteOne(filter, { session: context.session });
      return deletedCount === 1;
    } catch (error) {
      throw toDalError(error);
    }
  }
}
```

Why it is written this way:

- **`requireText` before every filter.** auth8 connects with `ignoreUndefined: true`, so an
  `undefined` value disappears from a filter: `{ cuid: undefined }` matches the first document and
  `deleteOne` removes it. The same applies to `tenantId` and `rev`.
- **`$eq` on values from outside.** An object in that position is compared as a literal instead of
  being read as an operator.
- **`matchedCount`, never `modifiedCount`.** A write that sets the value already stored matches and
  modifies nothing, and that is not a conflict.
- **The read after a missed write** tells a conflict (409, reload) from a missing document (404).
  It runs in the same session.
- **`rev` is bumped on every write.** A background migration guards its own write with the revision
  it read. A write that leaves `rev` alone is invisible to it and can be overwritten.

## One repository per aggregate

```ts
// repositories/orders.repository.ts
import type { Context } from '../dal/base-repository.js';
import { BaseRepository } from '../dal/base-repository.js';
import type { Order } from '../schema/order.model.js';
import { OrderStatus } from '../schema/order.model.js';

export class OrdersRepository extends BaseRepository<Order> {
  markPaid(cuid: string, rev: number, context: Context): Promise<number> {
    return this.update(cuid, rev, { $set: { status: OrderStatus.Paid } }, context);
  }

  async findOpenByCustomer(customerId: string, context: Context): Promise<Order[]> {
    const filter = { customerId: { $eq: customerId }, status: OrderStatus.Open };
    const cursor = this.collection.find(this.active(context, filter), {
      session: context.session,
      sort: { ulid: 1 },
      limit: 100,
    });
    const orders: Order[] = [];
    for await (const document of cursor) orders.push(this.mapper.fromDocument(document));
    return orders;
  }
}
```

The repository interface belongs to the Domain layer and the class to Infrastructure. A method names
a business question, and each query it adds comes with its index (`{ tenantId: 1, customerId: 1,
status: 1, ulid: 1 }` here).

## Mapper over metaschema

```ts
// dal/mapper.ts
import bson from '@alexify/metaschema/mongodb';
import type { Schema } from '@alexify/metaschema';
import type { Update } from '@alexify/metaschema/mongodb';
import type { Document, UpdateFilter } from 'mongodb';

import type { Mapper } from './base-repository.js';
import { DocumentValidationError } from './errors.js';

export const createMapper = <T>(schema: Schema): Mapper<T> => ({
  toDocument(entity: Document): Document {
    const { valid, value, issues } = schema.parse(entity, { unknown: 'reject' });
    if (!valid) throw new DocumentValidationError(issues);
    return bson.toDocument(schema, value);
  },

  fromDocument(document: Document): T {
    const { valid, value, issues } = bson.fromDocument(schema, document, { coerce: false });
    if (!valid) throw new DocumentValidationError(issues);
    return value as T;
  },

  toUpdate(update: UpdateFilter<Document>): UpdateFilter<Document> {
    const { valid, issues } = bson.checkUpdate(schema, update as Update);
    if (!valid) throw new DocumentValidationError(issues);
    return bson.toUpdate(schema, update as Update) as UpdateFilter<Document>;
  },
});
```

- `fromDocument` puts the hex of `_id` into the entity's id field (`orderId`). The domain identity is
  `cuid`, so do not return that field from an API.
- `toUpdate` does not coerce: a `decimal128` field takes a `Decimal128`, not the string `'3.10'`.
- `checkUpdate` cannot see what depends on the stored document, such as a bound after `$inc`. The
  `$jsonSchema` validator is the check for that.

## Testing

Unit-test a repository with a fake collection, injected through `deps`. Assert the filter the driver
received: the tenant is there, values are wrapped, `rev` is guarded. A fake proves the logic only.
Indexes, transactions and validators need a real replica set in an integration test.

Related skills: `node-tooling-testing`, `error-handling`
