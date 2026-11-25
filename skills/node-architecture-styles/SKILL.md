---
name: node-architecture-styles
description: Pick a Node.js architecture (Onion, modular monolith, DDD, CQRS, saga, outbox). Use when designing services or splitting monoliths
---

# Architecture Styles for Node.js

Pick the simplest style that satisfies measured requirements, name every
part by what it really is, and keep module contracts explicit so a part can
later move to another process without rewriting callers. For an app the
default is a **modular monolith in Onion + DDD layers on MongoDB**. Layer
internals (DI, folders, Fastify wiring) are in `node-layered-architecture`;
this skill is the map and the decision guide.

|  | Library `@alexify/*` | App (`auth8`) |
| --- | --- | --- |
| Style | `src/` by subpath or feature, kebab-case file names, none of the below | Onion + DDD, modular monolith |
| Domain logic | Pure functions and system classes | Aggregates with invariants, thin services |
| Persistence | Driver injected by the caller | Native `mongodb`, own DAL, one repository per aggregate |
| Consistency | Caller's concern | Single document first, transactions across aggregates |

## What architecture is

- Architecture = **naming** parts + **decomposing** the whole into parts +
  **linking** them (topology). The same laws apply to a module, an
  application, a solution of several apps, and an enterprise.
- Names are load-bearing: call something "event bus", "controller",
  "service", "repository" and developers will build and use it the textbook
  way, whatever it actually does. Rename instead of explaining.
- By topology only four families exist; everything else is a variation or a
  component:

| Family | Members (mostly synonyms or shades) | Fits |
| --- | --- | --- |
| Layered | layered, multilayer, onion, hexagonal (ports and adapters), clean, DDD layering | business apps, APIs |
| Hierarchical | SOA, microservices with gateways, master/worker, cluster | scaling, org split |
| Peer-to-peer | P2P, decentralized, local-first, CRDT sync, WebRTC mesh | offline, collaboration |
| Pipeline | unix pipes, streams, ETL, media/crypto/signal processing | one-way data flow |

- Broker, enterprise bus, message queue, event-driven, FaaS: interaction
  styles or components inside one of the families, not architectures of
  their own. Do not force every interaction through one of them.
- **Layer** = logical slice inside one process (domain, application,
  infrastructure, presentation). **Tier** = deployment unit (client, app
  server, DB, balancer). "3-tier" says nothing about how many layers the app
  server has.
- Hexagonal = layered + emphasis on ports (contracts owned by the core);
  clean = the same dependency rule with different vocabulary. Alexis uses the
  **Onion** vocabulary: Domain, Application, Infrastructure, Presentation.
  Ports-and-adapters mechanics apply unchanged.

## Rules

### Choosing the structure

- Default to a **modular monolith**: one deployable, several modules with
  explicit contracts (schema + types + contract tests), own collections, no
  cross-module imports of internals and no `$lookup` into another module's
  collections. It keeps refactoring cheap and leaves extraction open.
- Inside each module use **Onion + DDD** for all non-trivial code: dependencies
  point inward, invariants live in the aggregate.
- Treat microservices as an organisational tool first (team ownership,
  independent release).
- Extract a module into a service only for a reason you can state and
  measure: different scaling profile (CPU-bound, memory-heavy, bursty), fault
  or security isolation, a separate team or release cadence, a different
  runtime. "Cleaner code" is not a reason; module boundaries give that.
- Before extracting, the module must already pass the rules above. Then swap
  its in-process adapter for a network client implementing the same contract
  (timeouts via `AbortSignal.timeout()`, retries only for idempotent calls,
  idempotency keys for commands), move its data to its own database,
  and replace cross-module transactions with a saga or outbox. Move traffic
  route by route: [references/strangler.md](references/strangler.md).
- Keep services stateless when you can (restart, scale, deploy).
  Accept a stateful service only for interactive/near-real-time needs
  (WebSocket rooms, in-memory game state) and plan for sticky routing and
  state recovery (`node-scaling-highload`, `node-websocket-realtime`).
- Shared mutable state, inheritance-heavy code and singletons block
  clustering, workers and extraction. Prefer composition and injection.

### Domain logic and persistence patterns

- **Aggregate + Repository** is the default for business operations. The root
  guards invariants, a service loads it, calls it and saves it. Code:
  [references/ddd-building-blocks.md](references/ddd-building-blocks.md).
- **Transaction Script is rejected for non-trivial code** (auth8 ADR-003):
  logic leaks into services, invariants scatter, and the code couples to the
  framework and the database. A trivial path (a health check, a read-only
  lookup) may stay a route calling a repository.
- Map aggregates to documents: what must change atomically lives in one
  document, so **single-document atomicity** is the consistency boundary. Use a
  **multi-document transaction** (replica set) only for an operation that
  genuinely spans aggregates, and design aggregates to minimize that need.
- Let the database do set-based work: one `updateMany` or an aggregation
  pipeline beats loading 50 aggregates and writing them back. Keep it behind a
  repository method.
- Guard read-modify-write with the `rev` field: filter on the value read,
  `$inc: { rev: 1 }`, and treat `matchedCount === 0` as a conflict.
- Avoid **Active Record** (`user.save()`, `User.find()`) and ORM or ODM entity
  classes as the domain model: persistence leaks into every caller, tests need
  a DB, transactions become implicit. Data access details: `node-data-access`.
- **Value Object**: immutable, validated in the constructor, equality by
  value, operations return new instances (Money, Email, DateRange,
  Coordinates). Use it instead of passing raw strings/numbers across layers.
  Money is integer minor units or `Decimal128`, never a double.
- **Entity**: identity that survives state changes; equality by id.
  **Aggregate**: a cluster saved and loaded as a unit with one root that guards
  invariants; one transaction modifies one aggregate unless a rule truly spans
  several; reference other aggregates by id only. **Repository**: one per
  aggregate root, not per collection. **Domain Service**: stateless logic
  spanning several aggregates (transfer between accounts), a function module
  and not a "Manager" class.
- **DTO / Null Object**: DTOs cross process boundaries and are validated by
  schema; a Null Object replaces `null` checks only where a neutral
  behaviour exists. Never pass raw documents or `request` into the domain.

### Commands, queries, events

- **CQS** at method level: a command changes state and returns nothing (or
  an id/status), a query returns data and has no side effects. Low-level CQS
  alone buys little; never split check-then-act across an `await`
  (`if (await isAvailable()) await withdraw()` is a race): put the condition
  in the update filter, or use `rev`.
- **CQRS** = lift CQS to subsystems: Command and Query objects, separate
  write API and read API, one write store, N read replicas or read models.
  Use it when reads dominate (typical systems: ~90% reads) or the read model
  differs from the write model. Accept replication lag (seconds) and design
  UX for it (read-your-writes from the primary when needed).
- **Event Sourcing**: store facts (events) as the source of truth, derive
  state by folding them. Use only when history/audit/temporal queries are
  requirements (ledgers, compliance, "what changed between 10:00 and 11:00").
  Every event has a stream id, sequence number, type, version, timestamp and
  payload; consumers order by sequence and ignore duplicates. Keep both the
  log and materialized projections when queries need current state fast.
- **Saga** for consistency across services/modules without a distributed
  transaction: a sequence of local transactions, each with a compensating
  action executed in reverse order on failure. Orchestration (one
  coordinator owns the flow) for flows you must read and change in one
  place; choreography (services react to events) for loosely coupled,
  few-step flows. Compensations must be idempotent; their failures are logged
  and escalated, never swallowed.
- Publish integration events with an **outbox**: insert the event document in
  the same replica-set transaction as the state change, relay it to the bus
  afterwards. Never "update DB, then publish" without it: one of the two will
  fail. Domain events between aggregates of one module may stay in-process.
- Event envelope: `{ id, type, version, source, time, correlationId, data }`.
  Version events like API contracts; consumers tolerate unknown fields.

## Decision guide

| Situation | Choose | Not yet |
| --- | --- | --- |
| New product, 1-3 teams | modular monolith, Onion + DDD | microservices |
| One module CPU-bound or bursty | worker threads or separate process behind the same contract | rewrite as N services |
| Separate team needs own release cycle | extract that module as a service | splitting everything |
| CRUD-heavy back office | thin services over a repository, small aggregates | event sourcing |
| Trivial read-only path | route + repository | a full aggregate |
| Complex invariants on a cluster of objects | Aggregate + Repository, one document | Active Record, Transaction Script |
| Rule spans two aggregates | domain service + replica-set transaction | merging them into one document |
| Reads >> writes, heavy reporting | read replicas, then CQRS read models | ES |
| Audit trail / temporal queries mandatory | Event Sourcing for that bounded context | ES for the whole system |
| Business flow across services | Saga (orchestrator first) + outbox | 2PC, sync call chains |
| Stream processing, media, ETL | pipeline (`stream.pipeline`, queues) | request/response |
| Offline-first, collaborative editing | peer-to-peer / local-first sync | central locking |

## Patterns

### Module contract that can move out of process

```js
// billing/module.js: in-process implementation, atomic on one document
const createBillingModule = ({ accounts }) => ({
  async charge({ accountId, amount }) {
    const filter = { cuid: accountId, balance: { $gte: amount } };
    const update = { $inc: { balance: -amount, rev: 1 } };
    const result = await accounts.updateOne(filter, update);
    return { status: result.matchedCount === 1 ? 'charged' : 'rejected' };
  },
});

// billing/client.js: same contract over the network (Node's fetch is undici)
const createBillingClient = ({ baseUrl, timeoutMs = 2000 }) => ({
  async charge({ accountId, amount }) {
    const response = await fetch(`${baseUrl}/billing/charge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId, amount }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Billing unavailable: ${response.status}`);
    return response.json();
  },
});

// checkout depends on the contract only; the plugin tree picks the implementation
const createCheckout = ({ billing }) => ({
  async pay(accountId, amount) {
    const { status } = await billing.charge({ accountId, amount });
    return status === 'charged';
  },
});
```

Named-argument objects, plain data results and explicit statuses make the
contract serializable, so extraction does not change callers.

### Consistency: one document first

```js
// Infrastructure: the aggregate is one document, so this write is atomic
const createOrderRepository = (collection) => ({
  async save(order) {
    const { id, rev, status, lines } = order.toState();
    const update = { $set: { status, lines }, $inc: { rev: 1 } };
    const result = await collection.updateOne({ cuid: id, rev }, update);
    if (result.matchedCount === 0) throw new DomainError('ALX_ERR_CONFLICT');
  },
});
```

No transaction: the filter on `rev` turns a concurrent change into a conflict.
`Money`, `Order` and the full repository are in
[references/ddd-building-blocks.md](references/ddd-building-blocks.md).

### Across aggregates: a transaction with an outbox

```js
// Application: the one case for a multi-document transaction
const createTransfer = ({ accounts, outbox, client, withTransaction, createId }) => {
  const transfer = async ({ fromId, toId, amount }) => {
    if (fromId === toId) throw new DomainError('ALX_ERR_TRANSFER', { message: 'Same account' });
    const eventId = createId();
    await withTransaction(client, async (session) => {
      const from = await accounts.findById(fromId, { session });
      const to = await accounts.findById(toId, { session });
      if (!from || !to) throw new DomainError('ALX_ERR_NOT_FOUND');
      from.withdraw(amount);
      to.deposit(amount);
      await accounts.save(from, { session });
      await accounts.save(to, { session });
      const data = { fromId, toId, amount };
      await outbox.add({ id: eventId, type: 'TransferCompleted', version: 1, data }, { session });
    });
    return { status: 'done', eventId };
  };
  return { transfer };
};
```

`withTransaction` is the DAL helper (`node-data-access`), injected so the
service imports no driver. Every repository call gets `{ session }`. It needs a
replica set and the whole callback is retried on a transient error, so it does
database work only: no publish, no email. The id is created outside it, so a
retry writes the same event.

The outbox relay, CQRS with ordered projections, the saga orchestrator and
choreography: [references/cqrs-es-saga.md](references/cqrs-es-saga.md).

## Inside the Alexis stack

- A module of the monolith exposes its services through one `fastify-plugin`
  (a facade). Do not inject another module's repository.
- Fastify routes translate HTTP to a service call and back; the service never
  sees `request` or `reply` (`node-layered-architecture`).
- Messaging (BullMQ, wRPC brokers): wrap it in a port (`publish(event)`,
  `subscribe(type, handler)`) so domain code and tests use an in-memory
  implementation (`EventEmitter` is enough).

## Anti-patterns

- Microservices first: N services sharing one database, synchronous call
  chains (A -> B -> C on every request), lock-step deployments: a distributed
  monolith with network failures added. Start modular, extract with evidence.
- Services that query or write each other's collections, or share document
  models via a "common" package. Communicate through contracts and events.
- "Service", "Manager", "Helper", "Controller" names that do not match the
  role; a folder per pattern (`/services`, `/repositories`) at the top instead
  of modules. Inside a module, `helpers/` holds pure functions only.
- Transaction Script for business rules; Active Record or ODM entities as the
  domain model; loading many aggregates to compute what one update can do.
- A transaction around every write: a single-document update is already atomic.
- CQS check-then-act across `await` or across processes without a condition in
  the filter, `rev` or a transaction.
- CQRS or Event Sourcing for the whole system "for scalability"; read and
  write sides sharing a static in-memory collection; events without sequence
  numbers or ids.
- Saga without compensations, compensations that are not idempotent, or a
  `catch {}` that hides a failed compensation.
- "Update DB, then publish event" without an outbox; publishing from inside a
  transaction callback, which may still roll back or run twice.
- One interaction style for everything, or five messaging technologies in one
  small system.

## Checklist

- [ ] The style is stated in one sentence with its family (layered,
      hierarchical, P2P, pipeline) and the reason for any distribution.
- [ ] Every module has an explicit contract (schema/types/tests) and owns its
      collections; no imports of another module's internals.
- [ ] Each extracted service has a measurable reason, its own data, timeouts,
      idempotent retries and no synchronous call chains on the hot path.
- [ ] Non-trivial operations go through aggregates; no Transaction Script.
- [ ] Value objects replace raw primitives for money, email, ids, ranges.
- [ ] Aggregates are single documents where possible and reference others by id.
- [ ] Transactions appear only across aggregates, and their callbacks do
      database work only.
- [ ] No Active Record/ODM entities in domain code.
- [ ] No check-then-act across `await` without a filter, `rev` or transaction.
- [ ] CQRS/ES only where reads dominate or history is required; replication
      lag handled; events carry id, sequence, type, version.
- [ ] Cross-service flows use sagas with idempotent compensations; events are
      published via an outbox.
- [ ] Names (bus, controller, service, repository) match textbook meaning.

Related skills: `node-layered-architecture`, `js-solid-grasp`,
`node-data-access`, `js-contracts-schemas`, `node-scaling-highload`,
`node-websocket-realtime`, `js-local-first-sync`, `error-handling`.
