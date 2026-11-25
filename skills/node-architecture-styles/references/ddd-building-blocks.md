# DDD building blocks on MongoDB

Value Object, Aggregate, Repository and Domain Service in the Onion layers. The
aggregate maps to one document, so one write is atomic. CommonJS is used here so
each block runs as is. In an app the same code is ESM TypeScript.

## Value Object

Immutable, validated in the constructor, equality by value. Operations return
new instances. Money is stored as integer minor units with its currency, never
as a double.

```js
class DomainError extends Error {
  constructor(code, options = {}) {
    const { message = code, cause, details = null } = options;
    super(message, { cause });
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

class Money {
  #amount;
  #currency;

  constructor(amount, currency) {
    if (!Number.isSafeInteger(amount)) throw new RangeError('Money: minor units');
    if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError('Money: ISO 4217');
    this.#amount = amount;
    this.#currency = currency;
  }

  get amount() {
    return this.#amount;
  }

  get currency() {
    return this.#currency;
  }

  add(other) {
    if (other.currency !== this.#currency) throw new DomainError('ALX_ERR_CURRENCY');
    return new Money(this.#amount + other.amount, this.#currency);
  }

  times(quantity) {
    return new Money(this.#amount * quantity, this.#currency);
  }

  equals(other) {
    return this.#amount === other.amount && this.#currency === other.currency;
  }

  toJSON() {
    return { amount: this.#amount, currency: this.#currency };
  }
}
```

Private fields make the value immutable in every module mode. `Object.freeze`
alone would not do it reliably: without `'use strict'` a write to a frozen object
is ignored silently, so a caller's bug goes unnoticed. In ESM it throws.

## Aggregate

One root guards the invariants of the whole cluster. Outside code changes it only
through its methods, and it hands out copies.

```js
class Order {
  #id;
  #lines;
  #status;
  #rev;

  constructor({ id, lines = [], status = 'draft', rev = 0 }) {
    this.#id = id;
    this.#lines = lines.slice();
    this.#status = status;
    this.#rev = rev;
  }

  get id() {
    return this.#id;
  }

  get status() {
    return this.#status;
  }

  addLine(sku, price, quantity) {
    if (this.#status !== 'draft') throw new DomainError('ALX_ERR_ORDER_STATE');
    if (!Number.isInteger(quantity) || quantity <= 0) {
      const message = 'Quantity must be a positive integer';
      throw new DomainError('ALX_ERR_QUANTITY', { message });
    }
    this.#lines.push({ sku, price, quantity });
  }

  submit() {
    if (this.#status !== 'draft') throw new DomainError('ALX_ERR_ORDER_STATE');
    if (this.#lines.length === 0) throw new DomainError('ALX_ERR_ORDER_EMPTY');
    this.#status = 'submitted';
  }

  total() {
    let sum = new Money(0, this.#lines[0].price.currency);
    for (const { price, quantity } of this.#lines) sum = sum.add(price.times(quantity));
    return sum;
  }

  toState() {
    return { id: this.#id, lines: this.#lines.slice(), status: this.#status, rev: this.#rev };
  }
}
```

## Repository

One per aggregate root. Its interface belongs to Domain, and this implementation
to Infrastructure. It is the only place that knows the document shape. The lines
are embedded, so `save` is one atomic write and needs no transaction.

```js
const toLineDocument = ({ sku, quantity, price }) => {
  const { amount: priceAmount, currency: priceCurrency } = price;
  return { sku, quantity, priceAmount, priceCurrency };
};

const toLine = ({ sku, quantity, priceAmount, priceCurrency }) => {
  const price = new Money(priceAmount, priceCurrency);
  return { sku, quantity, price };
};

const convert = (items, mapper) => {
  const result = [];
  for (const item of items) result.push(mapper(item));
  return result;
};

const createOrderRepository = (collection) => ({
  async findById(id, options = {}) {
    const document = await collection.findOne({ cuid: id }, options);
    if (!document) return null;
    const { cuid, status, rev, lines } = document;
    return new Order({ id: cuid, status, rev, lines: convert(lines, toLine) });
  },

  async insert(order, options = {}) {
    const { id: cuid, lines, status, rev } = order.toState();
    const document = { cuid, status, lines: convert(lines, toLineDocument), v: 1, rev };
    await collection.insertOne(document, options);
  },

  async save(order, options = {}) {
    const { id: cuid, lines, status, rev } = order.toState();
    const $set = { status, lines: convert(lines, toLineDocument) };
    const result = await collection.updateOne({ cuid, rev }, { $set, $inc: { rev: 1 } }, options);
    if (result.matchedCount === 0) throw new DomainError('ALX_ERR_CONFLICT');
  },
});
```

- `v` is the schema version of the document, and `rev` is the optimistic lock.
  Shape migrations run as background jobs and do not happen on read.
- `{ session }` passes through `options`, so the same repository works inside a
  transaction.
- In `auth8` a repository extends `RepositoryWithDefaultAutoFields`, which adds
  `cuid`, `ulid`, timestamps and author stamps. Its schema comes from the single
  schema source (`js-contracts-schemas`).

## Application service

Orchestrates and holds no rule:

```js
const createOrdersService = ({ orders, events }) => {
  const submitOrder = async ({ orderId }) => {
    const order = await orders.findById(orderId);
    if (!order) throw new DomainError('ALX_ERR_NOT_FOUND', { message: 'Order not found' });
    order.submit();
    await orders.save(order);
    await events.publish({ type: 'OrderSubmitted', data: { orderId } });
    return { status: order.status };
  };
  return { submitOrder };
};
```

`events.publish` here is a domain event inside one module. An integration event
that must not be lost goes through the outbox, in the same transaction as the
state change ([cqrs-es-saga.md](cqrs-es-saga.md)).

## Domain Service across aggregates

Stateless, and a function module and not a "Manager" class. It enforces a rule no
single aggregate can see. The caller opens the transaction.

```js
class Account {
  #id;
  #balance;
  #rev;

  constructor({ id, balance, rev }) {
    this.#id = id;
    this.#balance = balance;
    this.#rev = rev;
  }

  get id() {
    return this.#id;
  }

  withdraw(amount) {
    if (!Number.isInteger(amount) || amount <= 0) throw new DomainError('ALX_ERR_AMOUNT');
    if (this.#balance < amount) throw new DomainError('ALX_ERR_INSUFFICIENT_FUNDS');
    this.#balance -= amount;
  }

  deposit(amount) {
    if (!Number.isInteger(amount) || amount <= 0) throw new DomainError('ALX_ERR_AMOUNT');
    this.#balance += amount;
  }

  toState() {
    return { id: this.#id, balance: this.#balance, rev: this.#rev };
  }
}

const moveFunds = (from, to, amount) => {
  if (from.id === to.id) throw new DomainError('ALX_ERR_TRANSFER', { message: 'Same account' });
  from.withdraw(amount);
  to.deposit(amount);
};
```

## Choosing the document boundary

| Question | Embed in the aggregate | Separate aggregate, referenced by id |
| --- | --- | --- |
| Must it change atomically with the root? | Yes | No |
| Is it read with the root? | Usually | Rarely |
| Does it grow without bound? | No (a document is limited to 16 MB) | Yes: audit logs, sessions, messages |
| Does it have its own lifecycle? | No | Yes |
| Is it shared by several roots? | No | Yes |

When a rule keeps forcing a transaction over the same two aggregates, look at the
boundary again: they may be one aggregate.
