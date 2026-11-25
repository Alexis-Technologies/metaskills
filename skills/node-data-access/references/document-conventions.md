# MongoDB document conventions

The binding conventions of ADR-017, with the corrections that apply today. Read this when you add a
collection or review one.

## Where the ADR and the code differ

| Topic | ADR-017 | Target | auth8 today |
| --- | --- | --- | --- |
| Schema source | TypeBox | `@alexify/metaschema` | TypeBox |
| System fields (sections 13, 14) | `v`, `rev` | as in the ADR | not stamped by the DAL |
| Tenant filter (section 9) | the DAL injects it | as in the ADR: the base repository's `scoped()` | `packages/node/src/dal` has no `tenantId` |
| Collection names (section 17) | PascalCase plural: `UserLogs` | as in the ADR | `users`, `userSessions` |
| System actors (section 3) | `systemActor()` in `packages/enums` | as in the ADR | not in the code yet |
| Shape migrations (section 13) | a BullMQ job | the job, or a migronaut background migration | none yet |

Do not describe a row of the last column as done. When you touch that code, move it toward the
target. An existing collection keeps its name until a migration renames it.

## Fields of every document

| Field | Type | Rule |
| --- | --- | --- |
| `_id` | ObjectId | Internal. Never in an API, never a reference |
| `cuid` | string, unique index | CUID2. The public id and the target of every reference |
| `ulid` | string | Sort key and pagination cursor |
| `tenantId` | string | The owner's `cuid`, on every tenant-dependent collection |
| `v` | int32 | Shape version, set from the current declaration |
| `rev` | int32 or int64 | Revision for optimistic concurrency, bumped by the writes that use it |
| `createdAt`, `updatedAt` | Date, UTC | `createdAt` never changes |
| `createdBy`, `updatedBy` | string | User `cuid` or `sys:type:name`. `createdBy` never changes |
| `deletedAt` | Date or null | Soft delete, where the collection uses it |

## Actors

A user write stores the user's `cuid`, never `_id`. A system write stores `sys:${type}:${name}`,
both parts from `as const` objects in `packages/enums`:

```ts
export const ActorType = {
  Job: 'job',
  Service: 'service',
  Scheduler: 'scheduler',
  Migration: 'migration',
  Webhook: 'webhook',
  System: 'system',
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];

// One entry per known system actor.
export const Actor = {
  AuditLogRollup: 'audit-log-rollup',
  SessionCleanup: 'session-cleanup',
} as const;
export type Actor = (typeof Actor)[keyof typeof Actor];

// The only way to build a system actor string.
export const systemActor = (type: ActorType, name: Actor): string => `sys:${type}:${name}`;

// systemActor(ActorType.Job, Actor.AuditLogRollup) === 'sys:job:audit-log-rollup'
```

Pass the actor through the service in the repository context. Do not read it from a global.

## Enums

- Store an `int32` code and use an `as const` object in code, so a reader sees `OrderStatus.Paid`.
- `0` is reserved for `Unknown`. A code this release does not know maps to it when read.
- Codes are append-only: never renumber or reuse one.

## References

- Store the target's `cuid`. Resolve it with a second indexed query or a `$lookup`, off hot paths.
- Prefer one `$in` query to a query per id.
- Denormalize a proven hot join before considering an `_id` reference, which is a documented
  exception only.

## BSON types

| Value | Store as |
| --- | --- |
| Timestamp | `Date`, UTC |
| Money | `Decimal128` or integer minor units, with the currency beside it. Never `double` |
| Enum code, small integer | `Int32` |
| Large integer | `Long`, read as `bigint` with `useBigInt64` |
| Key/value data | an array of `{ key, value }`. Never data values as field names |

## Deletion and retention

| Need | Mechanism |
| --- | --- |
| Hide, reversible | `deletedAt` and partial indexes on `{ deletedAt: null }` |
| GDPR erasure | Physical delete or crypto-shredding of the subject's key |
| Expiring data | TTL index with a documented retention reason |
| Audit log | Time Series collection with `expireAfterSeconds` |

- A soft delete never satisfies an erasure request.
- Each collection documents which modes apply and how its PII is erased. Remember copies in caches,
  search indexes, exports and backups.
- Set a TTL between the two limits that apply: the GDPR ceiling on keeping PII and the audit floor
  of SOC 2 or another certification.
- A partial index serves a query only when the query includes its filter, so active reads must send
  `deletedAt: null`.

## Sensitive fields

Secrets and PII are never stored in plaintext. Use Queryable Encryption, CSFLE, or application-level
envelope encryption with a KMS key hierarchy. Per-tenant data keys make crypto-shredding possible.
Declare the encrypted fields per collection.

## Search

Use Atlas Search for non-trivial search. `$regex` on user input is unindexed and can be a ReDoS
vector. If a small exact-prefix match is really enough, escape the input and anchor the pattern.

## Indexes

- Every query has a supporting index, and every index has a query. Check with `explain`.
- Tenant-scoped compound indexes start with `tenantId`.
- Order compound keys by equality, then sort, then range.
- Build large indexes from a deploy step, not at application startup.

Related skills: `node-security`, `node-access-control`
