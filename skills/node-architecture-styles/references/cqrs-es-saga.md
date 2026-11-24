# CQRS, Event Sourcing, Saga, Outbox: runnable shapes

The CQRS block runs as is on Node.js 24. The saga, choreography and outbox blocks
are shapes with injected services (`inventory`, `payments`, `bus`, `session`).
Replace the in-process `EventEmitter` with a broker adapter in production.

## CQRS + Event Sourcing with ordered projections

The progression: (1) one class with command and query methods (CQS); (2) a writer
emits to a bus, and several readers keep their own logs (CQRS); (3) each read side
owns its projection, rebuilt from events (Event Sourcing). The version below has
sequence numbers, ordering of late events, and duplicate protection.

```js
const { EventEmitter } = require('node:events');

const createWriter = (bus, store) => {
  let seq = 0;
  const execute = (type, payload) => {
    const event = { seq: ++seq, type, payload, time: Date.now() };
    store.push(event);
    bus.emit('event', event);
    return event.seq;
  };
  return {
    openAccount: (id) => execute('AccountOpened', { id }),
    deposit: (id, amount) => execute('Deposited', { id, amount }),
    withdraw: (id, amount) => execute('Withdrawn', { id, amount }),
  };
};

const REDUCERS = {
  AccountOpened: (view, { id }) => view.set(id, 0),
  Deposited: (view, { id, amount }) => view.set(id, view.get(id) + amount),
  Withdrawn: (view, { id, amount }) => view.set(id, view.get(id) - amount),
};

const createReader = (bus) => {
  const balances = new Map();
  const pending = new Map();
  let applied = 0;
  const apply = (event) => {
    if (event.seq <= applied) return;
    pending.set(event.seq, event);
    while (pending.has(applied + 1)) {
      const next = pending.get(applied + 1);
      pending.delete(next.seq);
      REDUCERS[next.type](balances, next.payload);
      applied = next.seq;
    }
  };
  bus.on('event', apply);
  return {
    apply,
    balance: (id) => balances.get(id) ?? null,
    position: () => applied,
  };
};

const bus = new EventEmitter();
const store = [];
const writer = createWriter(bus, store);
const readers = [createReader(bus), createReader(bus)];

writer.openAccount('marcus');
writer.deposit('marcus', 1000);
writer.withdraw('marcus', 50);
for (const reader of readers) console.log(reader.balance('marcus')); // 950 950

const late = createReader(new EventEmitter());
for (const event of store.toReversed()) late.apply(event);
console.log(late.balance('marcus'), late.position()); // 950 3
```

Notes:

- The write side validates commands (balance checks) against its own state or the
  primary; read sides never accept writes.
- A new read model is built by replaying the store from position 0. Keep the last
  applied `seq` with the projection to resume after a restart.
- Keep the event log for temporal queries (sum of changes between two timestamps)
  and a materialized view for "current balance" queries.
- With MongoDB, replica-set secondaries give read-only copies without application
  code (`readPreference`), with replication lag. CQRS with projections is for read
  models that differ from the write schema.

## Saga orchestrator (async, with compensations)

```js
const runSaga = async (steps, context, log = console) => {
  const done = [];
  for (const step of steps) {
    try {
      await step.action(context);
      done.push(step);
    } catch (error) {
      for (const completed of done.toReversed()) {
        if (!completed.compensate) continue;
        try {
          await completed.compensate(context);
        } catch (compensationError) {
          log.error({ step: completed.name, compensationError });
        }
      }
      throw new Error(`Saga failed at "${step.name}"`, { cause: error });
    }
  }
  return context;
};

const steps = [
  {
    name: 'reserve item',
    action: (context) => inventory.reserve(context.sku, context.reservationId),
    compensate: (context) => inventory.release(context.reservationId),
  },
  {
    name: 'charge buyer',
    action: (context) => payments.charge(context.from, context.amount, context.paymentId),
    compensate: (context) => payments.refund(context.paymentId),
  },
  {
    name: 'send receipt',
    action: (context) => notifications.receipt(context.from, context.amount),
  },
];
```

Rules for production sagas:

- Generate ids (`reservationId`, `paymentId`) before the saga starts, so each step
  and compensation is idempotent and can be retried safely.
- Persist saga state (`step`, `status`, `context`) after every step. On a restart,
  resume or compensate from the stored position.
- Steps with no business undo (emails) go last. "Pivot" steps after which you only
  retry forward (payment captured) must be explicit.
- A failed compensation needs a human or a retry queue: log with the saga id,
  raise an alert, do not hide it.

## Choreography sketch

Each service subscribes to the previous fact and emits its own, and nobody owns
the whole flow.

```js
bus.on('TransferRequested', async (context) => {
  const isBlocked = await fraud.isBlocked(context.to);
  bus.emit(isBlocked ? 'TransferRejected' : 'FraudCheckPassed', context);
});

bus.on('FraudCheckPassed', async (context) => {
  try {
    await bank.debit(context.from, context.amount);
    bus.emit('DebitSucceeded', context);
  } catch (error) {
    bus.emit('TransferFailed', { ...context, step: 'debit', reason: error.code });
  }
});

bus.on('CreditFailed', (context) => bus.emit('DebitCompensationRequested', context));
```

Async listeners need `new EventEmitter({ captureRejections: true })` and an
`'error'` listener (`node-events`). Choose choreography only for short flows: with
more than 3-4 steps the implicit flow is hard to trace, so use an orchestrator and
a correlation id.

## Transactional outbox on MongoDB

Multi-document transactions need a **replica set** (Atlas always is one). The event
is written in the same transaction as the state change, so both commit or neither.

```js
// Infrastructure: the outbox repository
const createOutbox = (collection) => {
  const add = async ({ id, type, version, data }, { session }) => {
    const status = 'pending';
    const document = { id, type, version, data, status, attempts: 0, lockedBy: null, lockedUntil: null };
    await collection.insertOne({ ...document, createdAt: new Date(), sentAt: null }, { session });
  };

  // Atomic on one document: two relays never claim the same event
  const claim = (workerId, now, leaseMs) => {
    const isExpired = { status: 'processing', lockedUntil: { $lt: now } };
    const filter = { $or: [{ status: 'pending' }, isExpired] };
    const lockedUntil = new Date(now.getTime() + leaseMs);
    const $set = { status: 'processing', lockedBy: workerId, lockedUntil };
    const options = { sort: { _id: 1 }, returnDocument: 'after' };
    return collection.findOneAndUpdate(filter, { $set, $inc: { attempts: 1 } }, options);
  };

  const markSent = (event, workerId, now) => {
    const $set = { status: 'sent', sentAt: now, lockedBy: null, lockedUntil: null };
    return collection.updateOne({ _id: event._id, lockedBy: workerId }, { $set });
  };

  const release = (event, workerId) => {
    const $set = { status: 'pending', lockedBy: null, lockedUntil: null };
    return collection.updateOne({ _id: event._id, lockedBy: workerId }, { $set });
  };

  return { add, claim, markSent, release };
};

// A relay: run one or more. Each pass drains what it can claim
const relay = async ({ outbox, publish, workerId, leaseMs = 30000, batchSize = 100 }) => {
  let sent = 0;
  for (let i = 0; i < batchSize; i++) {
    const event = await outbox.claim(workerId, new Date(), leaseMs);
    if (!event) break;
    try {
      const { id, type, version, data } = event;
      await publish({ id, type, version, data });
      await outbox.markSent(event, workerId, new Date());
      sent++;
    } catch (error) {
      await outbox.release(event, workerId);
      throw error;
    }
  }
  return sent;
};
```

Indexes:

```js
const createOutboxIndexes = async (collection, retentionSeconds) => {
  await collection.createIndex({ id: 1 }, { unique: true });
  await collection.createIndex({ status: 1, lockedUntil: 1, _id: 1 });
  await collection.createIndex({ sentAt: 1 }, { expireAfterSeconds: retentionSeconds });
};
```

- The TTL index removes only documents whose `sentAt` is a date. A pending event has
  `sentAt: null` and is never expired.
- Delivery is **at-least-once**: a relay can die after `publish` and before
  `markSent`, and the lease then expires and another relay sends the event again.
  Consumers deduplicate by event `id`.
- `markSent` and `release` filter on `lockedBy`, so a relay whose lease expired
  cannot overwrite the state of the relay that took over.
- Choose `leaseMs` longer than the slowest `publish`, and give `publish` a timeout
  shorter than the lease.
- `_id` order is only approximately the commit order across processes. When a
  consumer needs order, carry the aggregate id and its `rev` in the event, and let
  the consumer apply it by sequence as the CQRS reader above does.
- Count `attempts`, and alert on events that keep failing, so one poison event does
  not stay unnoticed.
