# SOLID and GRASP catalogue for JavaScript and Node.js

Per principle: what it means in JS, signs of violation, a before/after, and
caveats (where OOP-style application hurts in JS).

## Contents

- SOLID: [SRP and SoC](#srp-and-soc), [OCP](#ocp), [LSP](#lsp),
  [ISP](#isp), [DIP](#dip)
- GRASP: [Information Expert](#information-expert), [Creator](#creator),
  [Controller](#controller), [Pure Fabrication](#pure-fabrication),
  [Indirection](#indirection), [Polymorphism](#polymorphism),
  [Protected Variations](#protected-variations),
  [Low Coupling and High Cohesion](#low-coupling-and-high-cohesion)

## SRP and SoC

In JS: every abstraction (function, closure, module, class, service) has one
reason to change. SoC splits code by concern: domain rules, persistence,
serialization format, transport, presentation, I/O, auth.

Signs: an entity with `save()`/`read()`, `toString()` for UI and stdin
prompts; a function that detects input type, converts, computes and formats;
`if` chains caused by several accepted input shapes leaking into logic.

Before (one class, five reasons to change):

```js
class User {
  static async read(id) {} // file system + JSON format
  async save() {} // file system + JSON format
  toString() {} // presentation
  static checkPasswordStrength(password) {} // domain rule
  changePassword() {} // stdin raw mode, masking input
}
```

After (each piece changes for one reason):

```js
// Serialization strategy: { ext, parse, serialize }
const json = { ext: 'json', parse: JSON.parse, serialize: JSON.stringify };

// Persistence (Pure Fabrication), knows files and formats, not rules
const createStorage = ({ dir, format }) => {
  const fileName = (id) => path.join(dir, `user${id}.${format.ext}`);
  return {
    read: async (id) => format.parse(await fs.readFile(fileName(id), 'utf8')),
    save: (id, user) => fs.writeFile(fileName(id), format.serialize(user)),
  };
};

// Domain rules: pure functions over plain data
const EMAIL = /^[^@\s]+@[^@\s]+$/;
const changeEmail = (user, email) => {
  if (!EMAIL.test(email)) throw new Error(`Invalid email: ${email}`);
  return { ...user, email };
};

// Presentation
const formatUser = ({ name, login, email }) =>
  `User: ${login} (${name}) <${email}>`;

// The service wires the pieces
const updateEmail = async ({ storage, id, email }) => {
  const user = await storage.read(id);
  const updated = changeEmail(user, email);
  await storage.save(id, updated);
  return formatUser(updated);
};
```

Caveats:

- SRP does not require classes. The same split works as a class with
  methods, plain functions or a module object `{ login, register }`; the
  module of functions is the simplest form.
- An aggregate holds its data and its invariants; CRUD goes to a repository,
  not into the entity.
- A `User` of the system (login, password) and an `Employee` of the HR
  domain are different entities even if they share a person.
- An employee does not "transfer itself" to another department: operations
  that change several aggregates belong to a domain service or an application service.
- Do not over-split. Medium granularity is cheaper to read and maintain
  than one class per verb.
- Function-level SRP: isolate input normalization (`fromTuple`,
  `fromStruct`, `fromData`) from business functions (`getPrice`): logic gets
  linear, returns become consistent, call sites monomorphic.

## OCP

In JS: extend behaviour by adding a strategy entry, a new implementation of
an existing contract, or a new method; keep every existing signature,
return type, error channel and sync/async nature intact. Breaking it means
a semver-major release.

Signs: a growing `if`/`switch` on `type`; an override with a different
signature; consumers patching `_private` members or relying on
undocumented fields of a dependency.

Before/after with aggregation (strategy object injected instead of
subclassing or branching):

```js
// Before
class PaymentService {
  constructor(type) {
    this.type = type;
  }

  processPayment(to, amount) {
    if (this.type === 'card') return `Card: ${amount} to ${to}`;
    if (this.type === 'wire') return `Wire: ${amount} to ${to}`;
    throw new Error('Unsupported payment type');
  }
}
```

```js
// After
class PaymentService {
  #processor;

  constructor(processor) {
    this.#processor = processor; // any object with pay(to, amount)
  }

  processPayment(to, amount) {
    return this.#processor.pay(to, amount);
  }
}

const wire = { pay: (to, amount) => `Wire: ${amount} to ${to}` };
new PaymentService(wire).processPayment('contractor', 1000);
```

Caveats:

- Old JS had no private fields, so people patched "private" methods; such
  code breaks on minor updates of a dependency. Depend on public API only,
  hide your own state with `#private` or closures, and `Object.freeze`
  exported API objects if consumers must not patch them. Without
  `'use strict'` a write to a frozen object is ignored silently, so a test
  must check the value and cannot expect a throw.
- Platform classes (`EventEmitter`, `Readable`, `Writable`, `Console`) are
  effectively closed for modification and only extended, so depending on
  them directly is safe.
- Switching an inherited callback method to `async` is an OCP violation
  even if "it still works" for new callers; add a new method instead (see
  SKILL.md, LSP pattern).

## LSP

In JS: a value is substitutable if it honours the consumer's contract, not
if it inherits from the right class. `await` accepts any thenable,
`for...of` any iterable, `Array.from` any iterable or array-like,
`interceptErrors(emitter)` any `EventEmitter` descendant.

A substitute must keep: accepted inputs (no stronger preconditions), result
shape (no weaker postconditions), error channel, sync/async timing,
cancellation, and resource ownership.

Async substitution cases:

```js
// 1. async function where a sync callback is expected
const runAll = (tasks) => {
  for (const task of tasks) task(); // contract: sync, throws synchronously
};

runAll([
  async () => {
    throw new Error('lost'); // unhandledRejection, try/catch never sees it
  },
]);

const runAllAsync = async (tasks) => {
  for (const task of tasks) await task(); // explicit async contract
};
```

```js
// 2. async listeners: route rejections into the 'error' channel
const { EventEmitter } = require('node:events');

const bus = new EventEmitter({ captureRejections: true });
bus.on('error', (error) => console.error('handled:', error.message));
bus.on('job', async () => {
  throw new Error('job failed'); // becomes an 'error' event
});
bus.emit('job');
```

Other cases to check in review:

- Callback/promise switch in an override (`process(payment, cb)` becomes
  `async process(payment)`): old callers never get their callback.
- Error channel change: base throws synchronously, subtype rejects; base
  emits `'error'`, subtype throws; a `Readable` subclass handles errors
  differently from a plain `EventEmitter` (an unhandled `'error'` on an
  emitter throws to the top level, a stream also destroys itself).
- Timing change: a callback invoked sometimes synchronously and sometimes
  asynchronously; an async iterator that never yields to the event loop
  (blocking generator) where the consumer expects socket-like behaviour.
- Stronger precondition: base `withdraw(amount)` subtracts any amount, the
  subclass silently ignores `amount <= 0`. Either make the rule part of the
  base contract (and throw), or do not substitute.
- Cancellation: if the contract takes `{ signal }`, every implementation
  must abort and reject with an `AbortError`.
- `Promise` subclasses (e.g. `Cancelable extends Promise`): `then()` creates
  new instances through the species constructor and cancel state is not
  propagated; prefer `AbortSignal`.
- Array-like vs iterable: different contracts. Spread and `for...of` need
  `Symbol.iterator`; say which one a function accepts.

Verify substitutability with a contract suite run against every
implementation; types cannot see ordering or timing:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const implementations = { memoryQueue, delayedQueue };

for (const name in implementations) {
  const create = implementations[name];
  describe(`Queue contract: ${name}`, () => {
    it('should keep FIFO order for concurrent pushes', async () => {
      const queue = create();
      await Promise.all([queue.push(1), queue.push(2), queue.push(3)]);
      assert.equal(await queue.shift(), 1);
      assert.equal(await queue.shift(), 2);
    });

    it('should return null when empty, never throw', async () => {
      assert.equal(await create().shift(), null);
    });

    it('should always return a promise (no sync results)', () => {
      assert.ok(create().shift() instanceof Promise);
    });
  });
}
```

Caveats:

- TypeScript checks shapes, not behaviour: async behaviour (microtasks,
  ordering, gaps where other code runs) can only be checked by tests. Hence
  async abstractions belong in well-tested libraries, not in app code. A
  zero-dependency library writes its own and carries those tests.
- Inheritance chains like DB cursor extends `Readable` extends `Stream`
  extends `EventEmitter` are fine for platform integration; do not build
  such chains for domain types.

## ISP

In JS: consumers depend on the minimal shape they use. Destructure only the
used fields, accept plain objects, keep interfaces next to the consumer.
Structural typing means any object with the right members fits, no
`implements` needed.

Before: `Message` with `attach(filename)` (reads files itself), `send()`
and `warn()` (logging) — every consumer of messages depends on fs, mail
transport and logging.

After:

```js
class Message {
  constructor(to, subject, text) {
    this.to = to;
    this.subject = subject;
    this.text = text;
    this.files = [];
  }

  async attach({ filename, readable }) {
    const chunks = [];
    for await (const chunk of readable) chunks.push(chunk);
    this.files.push({ filename, content: Buffer.concat(chunks) });
  }
}

const send = async (message) => {
  // transport only
};

// Accepts anything with `filename`: Attachment instance, literal, record
const canAttach = async (files) => {
  for (const { filename } of files) {
    const exists = await fs.access(filename).then(...toBool);
    if (!exists) return false;
  }
  return true;
};
```

Where `toBool = [() => true, () => false]` maps fulfillment and rejection.
Typings for plain JS in an adjacent `delivery.d.ts`:

```ts
export interface IFile {
  filename: string;
}

export interface IAttachment {
  filename: string;
  readable: NodeJS.ReadableStream;
}

export interface IMessage {
  to: string;
  subject: string;
  text: string;
  files: Array<{ filename: string; content: Buffer }>;
  attach(attachment: IAttachment): Promise<void>;
}

export function send(message: IMessage): Promise<void>;
export function canAttach(files: Array<IFile>): Promise<boolean>;
```

Check JS against typings with `tsconfig.json`:
`{ "compilerOptions": { "allowJs": true, "checkJs": true, "noEmit": true,
"strict": true } }`.

Caveats:

- No interfaces in the language does not cancel ISP: the substitution works
  without typings; typings only make the contract visible and checkable.
- Do not create an interface per property: every interface must be kept
  consistent with implementations; find the balance by practice.
- `IFile`, `IAttachment` may describe the same object; they need not
  extend each other.

## DIP

In JS: high-level modules (domain, services) and low-level modules
(storage, logger, transport) both depend on contracts; the contract is
owned by the higher level (the caller), not by the provider. Arrows in the
dependency diagram point up to the contracts; only stable platform
contracts are referenced downward.

Before (responsibilities are split, but nothing is substitutable):

```js
// server.js
const { createServer } = require('node:http');
const { Storage } = require('./storage.js');
const { logger } = require('./logger.js');

const serveStatic = (folder, port) => {
  const storage = new Storage(folder); // concrete class, created inside
  createServer(async (req, res) => {
    const file = await storage.prepare(req.url);
    // ...
    logger.log(`${req.method} ${req.url}`); // module-level singleton
  }).listen(port);
};
```

After: `serveStatic(storage, logger, port)` receives an `IStorage`
(returning plain `{ found, ext, stream }` records instead of `new
PreparedFile`) and a `Console`; `main.js` picks implementations. Storage
can now be disk, S3/MinIO, or a database; transport can be HTTP/2.

Logger as a strategy with one output contract (`Console`):

```js
const fs = require('node:fs');
const { Console } = require('node:console');
const { PassThrough } = require('node:stream');

const createStdoutLogger = () => new Console({ stdout: process.stdout });

const createFileLogger = (path) => {
  const stdout = fs.createWriteStream(path, { flags: 'a' });
  return new Console({ stdout, stderr: stdout });
};

const createTeeLogger = (path) => {
  const tee = new PassThrough();
  tee.pipe(fs.createWriteStream(path, { flags: 'a' }));
  tee.pipe(process.stdout);
  return new Console({ stdout: tee, stderr: tee });
};

const LOGGERS = {
  stdout: createStdoutLogger,
  file: createFileLogger,
  tee: createTeeLogger,
};
// In an app the logger is Pino, injected as `fastify.log`
```

Ways to deliver a dependency:

| Way | Verdict |
| --- | --- |
| Factory/closure arguments (`(routing, port) => ...`) | Good, explicit |
| Constructor argument stored in `#private` field | Good |
| Options object or revealing constructor (`new Writable({ write })`) | Good |
| Setter method (`setLogger(next)`) | Acceptable: can defer the swap until a transaction ends |
| Property assignment from outside (`svc.logger = x`) | Bad: swap mid-operation splits logs, may lose audit records |
| Global context (`console`, `process`, timers) | Culture, not ideal; acceptable for stateless deps |
| Fastify decorators through `fastify-plugin` | Good: declared, with `dependencies`; read them in the handler |
| Service locator, DI container | Mechanisms subordinate to DIP, optional |

Caveats:

- DIP is not reducible to dependency injection: it is about formulating
  module contracts and plugging implementations in by some pattern.
- Platform classes (`console`, `http.Server`, `Readable`) change rarely and
  stay backward compatible, so treat them as interfaces.
- The goal is portability of domain code across server, browser, mobile and
  embedded JS runtimes; a logger or scheduler import nails it to one.

## Information Expert

In JS: assign a responsibility to the abstraction that has the information
to make the decision. Effects: lower coupling, simpler code, better
encapsulation, more reuse. In an app, the expert for an invariant is the
aggregate that owns the data.

```js
class Product {
  constructor(name, price) {
    this.name = name;
    this.productPrice = price;
  }

  get price() {
    return this.productPrice;
  }
}

class Purchase {
  constructor(name, ...items) {
    this.name = name;
    this.items = items;
  }

  get price() {
    let sum = 0;
    for (const item of this.items) sum += item.price;
    return sum;
  }
}
// A Purchase can contain Products and other Purchases (Composite)
```

The same expert works as a procedural module: `ring.alloc(size)`,
`ring.write(buf, data)`, `ring.read(buf)` keep the offset logic inside the
module that owns the buffer layout.

Expert and Creator together: the aggregate creates what it owns and hands
out copies.

```js
const fs = require('node:fs/promises');

class Shipment {
  #events = [];

  constructor(trackingNumber) {
    this.trackingNumber = trackingNumber;
  }

  track(type, location) {
    const event = { type, location, time: new Date() }; // owner creates
    this.#events.push(event);
    return event;
  }

  get delivered() {
    for (const event of this.#events) {
      if (event.type === 'Delivered') return true;
    }
    return false;
  }

  get history() {
    return this.#events.slice(); // callers cannot corrupt internal state
  }
}

// Whoever opens a resource closes it (Node 24: explicit resource management)
const exportHistory = async (shipment, path) => {
  await using file = await fs.open(path, 'w');
  for (const event of shipment.history) await file.write(`${event.type}\n`);
};
```

Signs of violation:

- `a.b.c.d` through live stateful instances (Law of Demeter: talk only to
  direct collaborators), e.g. `request.socket.remoteAddress` deep in business
  code, `list.last.prev.prev = node` corrupting a linked list from outside.
- Feature envy: `person.call()` digs into `phone` lookups instead of asking
  `phone` for a dial string.
- Runtime shape changes from outside: adding/removing methods or fields,
  mixins. Consumers then need `if`s and introspection wherever instances are
  used.

Caveats:

- JS culture routinely ignores Demeter for brevity. Allow it only
  consciously, paid for with more tests: a framework that wraps `request`
  may not expose `socket` at all.
- Namespaces (`api.users.read`) are not stateful instances; chains through
  them are fine.

## Creator

In JS: decide who instantiates, initializes, holds references and thus
controls the lifetime of an object. Candidates: the aggregate that
contains it; the code that uses it intensively; the code that has the data
to initialize it; a pool or collection that stores many instances.

```js
// Before: callers construct events and push into a public array
const event = new TrackingEvent('Picked Up', new Date(), 'Livorno');
shipment.trackingEvents.push(event);

// After: Shipment creates and owns its events (class above)
shipment.track('Picked Up', 'Livorno');
```

Lifetime rules:

- Whoever allocates, opens or subscribes releases, closes or unsubscribes:
  the garbage collector does not reliably release file descriptors, sockets,
  timers or listeners.
- If a ready instance is passed in (DI), the receiver must not destroy it.
- Node 24 supports explicit resource management: `await using` with
  objects implementing `Symbol.asyncDispose` (`FileHandle` does), so the
  creator's scope closes the resource.

Caveat: mixins break Creator. A component creates a logger, attaches it to
a socket and finishes; the socket now carries a logger nobody owns.

## Controller

In JS: a controller receives external events (HTTP requests, WebSocket
messages, CLI commands, queue jobs), which arrive asynchronously and
concurrently, and shields domain logic from them. It does system work:
routing, deserialization, validation, auth, serialization, error mapping.
After it, domain execution is as linear as possible. GoF Facade, Command
and layer isolation are related.

In an app the controller is a Fastify route handler (the Presentation layer).
Services are created in the plugin tree and arrive as decorators:

```js
const fp = require('fastify-plugin');

const createUsers = ({ store }) => ({
  read: async ({ id }) => store.get(id) ?? null,
  create: async ({ login }) => ({ id: await store.insert({ login }) }),
});

// Wiring: the only place that knows the implementations
const usersPlugin = fp(
  async (fastify, { store }) => {
    fastify.decorate('users', createUsers({ store }));
  },
  { name: 'users' },
);

// Controller: the only code that knows HTTP
const userRoutes = async (fastify) => {
  fastify.get('/users/:id', async (request, reply) => {
    const user = await fastify.users.read({ id: request.params.id });
    if (user) return user;
    const error = { code: 'ALX_ERR_NOT_FOUND', message: 'User not found' };
    return reply.code(404).send({ error });
  });
  fastify.post('/users', async (request, reply) => {
    const created = await fastify.users.create({ login: request.body.login });
    return reply.code(201).send(created);
  });
};
```

The same `users` object serves a BullMQ worker or a `@alexify/wrpc` procedure
without a change.

Fastify rules:

- Route handlers are controllers: read params and body, call a service with
  plain arguments, return the result. Validation comes from the route schema.
- Register services with `fastify-plugin` and declared `dependencies`, so
  the plugin tree is the composition root. Do not import a repository in a
  route file.
- A hook may set a request field only when `decorateRequest` declares it. The
  handler reads it once and passes it down as an argument. Never pass
  `request` or `reply` below the handler.
- Keep hooks generic: authentication, rate limit, headers. Business rules do
  not belong in a hook.
- TypeScript: declare interfaces where they are consumed. Code run directly by
  Node type stripping must use erasable syntax only (no `enum`, no parameter
  properties).

Caveats:

- Do not detect arguments by parsing `handler.toString()`; declare parameters
  with schemas (`js-contracts-schemas`).
- One controller per transport, not one per entity per transport.

## Pure Fabrication

In JS: abstractions absent from the domain, invented for the machine:
repositories, storages, loaders, connections, queries, queues, iterators,
promises, streams, loggers, errors. They are reused across domains and
remove machinery from domain code (compare business logic on callbacks vs
promises vs `async`/`await`).

```js
// Before (Active Record): the entity knows the driver and the collection
class UserRecord {
  constructor(collection, id, login) {
    this.collection = collection;
    this.id = id;
    this.login = login;
  }

  save() {
    return this.collection.updateOne({ id: this.id }, { $set: { login: this.login } });
  }
}

// After: plain entity + fabricated repository over the native driver
const createUser = ({ id, login }) => ({ id, login });

const createUserRepository = (collection) => ({
  findById: async (id) => {
    const document = await collection.findOne({ id });
    return document ? createUser(document) : null;
  },
  save: async (user) => {
    await collection.updateOne({ id: user.id }, { $set: { login: user.login } });
  },
});
```

A curried FP fabrication works too: `loader(db)(entity)(id)`.

Caveats (why Active Record is an anti-pattern here): it mixes domain and
persistence (SRP), forces overriding to read from one DB and write to another
(OCP), turns everything into a generic "record" so logic branches on record
kind (LSP), binds code to a concrete self-persisting class (DIP), and fails
when an entity spans several collections or databases.

## Indirection

In JS: an intermediate object or channel between two components so they
do not reference each other: GoF Mediator, the C in MVC, an adapter, an
event bus. The button does not know it buys; the controller knows both
sides and wires them.

Caveats:

- Each indirection costs readability; add it where variation is expected
  (Protected Variations), not everywhere.
- Events are indirection too, but overused `EventEmitter` turns into GOTO:
  an `emit` is a jump to unknown code. Use calls and promises by default.

## Polymorphism

In JS: replace branching on type with dispatch through a contract. Forms:
duck typing, dispatch table over plain data, closures returning objects
with the same methods, classes (with or without a base), ad-hoc overload
emulation via a `Map` from signature to handler.

```js
// Before: type switch grows with every new kind
const areaSwitch = (shape) => {
  switch (shape.kind) {
    case 'circle':
      return Math.PI * shape.radius ** 2;
    case 'rect':
      return shape.width * shape.height;
    default:
      throw new Error(`Unknown shape: ${shape.kind}`);
  }
};

// After 1: dispatch table, data stays plain (serializable)
const AREA = {
  circle: ({ radius }) => Math.PI * radius ** 2,
  rect: ({ width, height }) => width * height,
};

const area = (shape) => {
  const calculate = AREA[shape.kind];
  if (!calculate) throw new Error(`Unknown shape: ${shape.kind}`);
  return calculate(shape);
};

// After 2: polymorphic objects (closures), callers use the contract only
const circle = (radius) => ({ area: () => Math.PI * radius ** 2 });
const rect = (width, height) => ({ area: () => width * height });
```

Caveats:

- A `switch` returning values for a trivial mapping (error name to code)
  is fine; better as an object or `Map` lookup.
- An abstract base that throws "not implemented" adds little in JS; a
  contract (JSDoc/TS) plus a test is enough.
- Related to OCP and LSP: a collection may be in memory, on disk or loaded
  lazily from a DB as long as it exposes `length` and iteration.

## Protected Variations

In JS: both the result of applying all principles and a technique: put a
stable interface in front of every point of expected change; consumers
read the contract, never the implementation.

```js
// The rest of the app sees only this shape
const toUser = (data) => {
  const valid = typeof data?.id === 'number' && typeof data.login === 'string';
  if (!valid) throw new TypeError('Unexpected users-service response');
  return { id: data.id, login: data.login };
};

const createUsersClient = ({ baseUrl, timeoutMs = 2000 }) => ({
  getUser: async (id) => {
    const url = `${baseUrl}/v2/users/${id}`;
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`users-service: ${response.status}`);
    return toUser(await response.json());
  },
});
```

Rules:

- Version contracts with semver: patch = internal fix, minor = additive
  feature, major = OCP break. Publish `.d.ts` or an exported spec.
- Never let consumers depend on internals; expose a facade or exported
  interface instead.
- Validate at runtime whatever crosses a process boundary (DB rows,
  another service, a queue, another team's code); shared TS types are not
  enforced there (`js-contracts-schemas`).

## Low Coupling and High Cohesion

In JS: inside a module, parts may know and call each other freely; across
modules, interaction goes through few explicit exports (facade, exported
functions, public methods). The two correlate with Information Expert.

Before (hooks coupled through an undeclared `request` field):

```js
// BAD: the field is undeclared, and a later hook depends on the order
fastify.addHook('onRequest', async (request) => {
  request.startedAt = Date.now();
});

fastify.addHook('onResponse', async (request) => {
  console.log(request.url, Date.now() - request.startedAt);
});
```

After: the field is declared by the plugin that owns it. Per-request values
reach services only as arguments:

```js
const fp = require('fastify-plugin');

const timing = fp(
  async (fastify) => {
    fastify.decorateRequest('startedAt', 0);
    fastify.addHook('onRequest', async (request) => {
      request.startedAt = Date.now();
    });
    fastify.addHook('onResponse', async (request, reply) => {
      const timeMs = Date.now() - request.startedAt;
      request.log.info({ status: reply.statusCode, timeMs }, 'request completed');
    });
  },
  { name: 'timing' },
);

const reportRoutes = async (fastify) => {
  fastify.get('/reports/:id', async (request) => {
    const { id } = request.params;
    const signal = AbortSignal.timeout(5000);
    return fastify.reports.read({ id, signal });
  });
};
```

Signs of high coupling: shared mutable objects passed through layers,
order-dependent registration, many imports of a module's internals,
circular `require`, `_underscore` access across modules.
