---
name: js-solid-grasp
description: Apply SOLID and GRASP to multi-paradigm async JS and TS. Use when designing or reviewing modules and contracts, or refactoring god classes
---

# SOLID and GRASP for JavaScript and Node.js

Treat SOLID and GRASP as rules about responsibilities and contracts between
any abstractions (functions, closures, modules, classes, services), not as a
mandate for Java-style class hierarchies. Choose the smallest JS construct
that keeps a contract, let the consumer own the contract, and verify async
behaviour with tests, because types cannot express it.

The creational and structural GoF catalogue, with Adapter, Bridge and Facade,
lives in `js-gof`. This skill covers the principles and the behavioural
patterns. More before/after code per principle, Expert, Creator, Controller
and Fastify wiring: [references/principles.md](references/principles.md).
Strategy, Command, Mediator, Chain and Observer in OOP, FP and mixed style:
[references/patterns.md](references/patterns.md).

|                   | Library `@alexify/*`                        | App (`auth8`)                                      |
| ----------------- | ------------------------------------------- | -------------------------------------------------- |
| Contract          | Handwritten `.d.ts`                         | TS `interface` in Domain or Application            |
| Composition root  | The caller; options in the constructor      | `main.ts` and the `fastify-plugin` tree            |
| Async primitives  | Written here, zero runtime dependencies     | Platform or a tested library, not written here     |
| Persistence       | Driver injected                             | Repository interface in Domain, native driver DAL  |

## How the principles change in JavaScript

| Java-style reading            | JavaScript / Node.js reading                                                  |
| ----------------------------- | ----------------------------------------------------------------------------- |
| Class has one responsibility  | Any abstraction has one reason to change: function, closure, module, class    |
| `interface` + `implements`    | Contract = shape + behaviour; structural typing; `.d.ts` or TS types          |
| Abstract base class           | Contract + several implementations (literals, closures, classes)              |
| Polymorphism via inheritance  | Duck typing, dispatch table, closures; inherit only platform classes          |
| DI container                  | Composition root + factory/constructor arguments; containers are optional     |
| Strategy / Command classes    | Object or `Map` of functions; commands as plain data + operations table       |
| Observer with two classes     | A listener is a function: `EventEmitter`, `EventTarget`                       |

A JS contract includes behaviour that type checkers do not see:

- sync vs async invocation of callbacks, ordering, and whether control yields
  to the event loop between steps (a socket and a blocking generator can both
  implement `Symbol.asyncIterator`);
- the error channel: `throw`, rejection, `callback(error)`, `'error'` event;
- cancellation (`{ signal }`), timeouts, and resource ownership (who closes).

## Rules

### General

- Apply principles to abstractions you create or import, not to built-ins
  such as `Array` or `Number`.
- Prefer a module of functions or a closure when there is no per-instance
  state or lifecycle; use a class for many instances with shared methods,
  `#private` state, or a lifecycle (open/close).
- Aim for medium granularity: no 20 classes per use case, no interface per
  method, no abstract classes that only throw. "Make it SOLID" never means
  `instanceof` chains, `setPrototypeOf`, mixins or a class per verb.
- Violate a principle only consciously, and compensate with tests or schemas.
- Recognize a pattern by the problem it solves, not by its class diagram.

### SOLID

- **SRP / SoC**: split by reason to change: domain data, persistence,
  transport, presentation, I/O, auth (a system `User` is not an HR
  `Employee`). Normalize and validate raw input once at the boundary so that
  domain code is linear (few `if`s) and returns one consistent shape.
- **OCP**: extend by adding (a strategy entry, an implementation of the same
  contract, a new method); never change an existing method's parameters,
  return type, error channel or sync/async nature. That is a semver-major
  change. Do not patch or rely on another module's internals (`_private`
  fields, undocumented properties): minor releases change them.
- **LSP**: a substitute accepts the same inputs (no stronger preconditions),
  returns compatible results, uses the same error channel and the same
  timing. Do not override a callback API with a promise API (or the reverse);
  add a new method or an adapter. Do not pass an `async` function where the
  consumer ignores the returned promise (`setTimeout`, array sort,
  `EventEmitter` without `captureRejections`).
- **ISP**: parameters ask only for what is used (`{ filename, readable }`,
  not a whole `Message`). Keep a few cohesive interfaces, defined next to the
  consumer. Rely on structural typing: no `implements` or inheritance needed.
  Library: an adjacent `.d.ts`, checked with `tsc --allowJs --checkJs
  --noEmit`. App: a TS `interface`. JSDoc only when one line says what the
  signature cannot.
- **DIP**: domain and application modules never import concrete
  infrastructure (DB driver, logger implementation, `node:http`, framework).
  They receive contracts owned by the higher layer, and one composition root
  wires implementations: `main.js`, or in a Fastify app `main.ts` plus the
  plugin tree, where each `fastify-plugin` declares its `dependencies` and
  decorates the instance. Stable platform contracts (`Console`, `Readable`,
  `EventEmitter`, `AbortSignal`) may be used directly; they act as
  interfaces. DIP is not "use a DI container".

### GRASP

- **Information Expert**: put behaviour where the data is, so aggregate
  invariants live in the aggregate; hide state with `#private`, closures or
  module-local variables; return copies. Do not walk `a.b.c.d` through live
  stateful objects (Law of Demeter): ask the nearest collaborator.
- **Creator**: the aggregate that contains, intensively uses, or has the data
  to initialize an object creates it. Whoever creates, opens or subscribes
  also destroys, closes or unsubscribes; never close an injected dependency;
  never attach a created object to someone else's instance (a logger glued
  onto a socket outlives its creator).
- **Controller**: one entry point per request/command converts transport
  (HTTP, WebSocket, CLI, queue) into a use-case call: parse, validate,
  authorize, serialize. In an app this is a Fastify route handler. After it,
  domain code is linear and transport-free.
- **Pure Fabrication**: persistence, serialization, caching, queues and
  connections live in fabricated objects (repository, storage, loader,
  queue), not in entities. Active Record is an anti-pattern here. Styles:
  `node-architecture-styles`; the DAL: `node-data-access`.
- **Indirection**: put a mediator, controller, adapter or event between
  components that must vary independently; do not add a layer where no
  variation is expected.
- **Polymorphism**: replace a growing `if`/`switch` on kind or `instanceof`
  ladder with a dispatch table or polymorphic objects; a lookup table is fine
  for plain value mapping.
- **Protected Variations**: identify likely change points (DB, transport,
  logger, third-party API, protocol version) and put a stable contract in
  front; version contracts with semver; validate data at process and network
  boundaries at runtime, because types are not shared with other services.
- **Low coupling / high cohesion**: export few names; pass plain values, not
  `request`/`reply` or shared mutable objects. A Fastify hook may set a field
  on `request` only when it is declared with `decorateRequest`; the handler
  reads it once and passes it down as an explicit argument. An undeclared
  field, or one read below the handler, is hidden coupling. Code:
  [references/principles.md](references/principles.md#low-coupling-and-high-cohesion).

### Async contracts

- Use platform async contracts (promises, async iterators, streams, events,
  `AbortSignal`): mostly `async`/`await`, callbacks only in adapters, events
  where natural; never force one contract (EventEmitter) everywhere.
- **App:** do not build custom async primitives (queues, pools, thenables,
  cancelable promises); take the platform, BullMQ or a tested library.
- **Library:** a zero-dependency package has to write its own. Keep each in
  its own module, behind a small contract, with tests for ordering, errors
  and cancellation.
- Run the same contract test suite against every implementation of an async
  contract (ordering, errors, cancellation), not just a type check.

## Patterns

### SRP: isolate input variability at the boundary

```js
const fromTuple = (tuple) => ({ name: tuple[0], price: tuple[1] });
const fromStruct = ({ name, price, cost }) => ({ name, price: price ?? cost });

const normalizeItem = (data) => {
  const item = Array.isArray(data) ? fromTuple(data) : fromStruct(data);
  const { name, price } = item;
  const amount = typeof price === 'string' ? parseFloat(price) : price;
  return { name, price: amount ?? null };
};

// Domain code sees one shape: linear, monomorphic, easy to test
const total = (items) => {
  let sum = 0;
  for (const item of items) sum += item.price ?? 0;
  return sum;
};
```

### OCP + Polymorphism: strategy as a collection of functions

```js
const processors = new Map();

const registerProcessor = (type, pay) => {
  if (typeof pay !== 'function') throw new TypeError('pay must be function');
  processors.set(type, pay);
};

const pay = async (type, to, amount) => {
  const processor = processors.get(type);
  if (!processor) throw new Error(`Unsupported payment type: ${type}`);
  return processor(to, amount);
};

registerProcessor('card', async (to, amount) => `card: ${amount} to ${to}`);
registerProcessor('wire', async (to, amount) => `wire: ${amount} to ${to}`);
// New type = new entry; pay() and existing processors stay untouched
```

### LSP: extend without changing the inherited contract

```js
class PaymentService {
  process({ to, amount }, callback) {
    if (amount <= 0) return void callback(new Error('Amount must be > 0'));
    console.log(`Paid ${amount} to ${to}`);
    return void callback(null);
  }
}

// Wrong: `async process(payment)` in a subclass. Callers that pass a
// callback get no call at all. Right: keep process(), add a new method.
class Bank extends PaymentService {
  pay(payment) {
    return new Promise((resolve, reject) => {
      this.process(payment, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
```

An `async` function passed to a consumer that calls `task()` without
awaiting escapes `try/catch` as an `unhandledRejection` (Node crashes by
default): make the consumer contract async (`await task()`), or use
`new EventEmitter({ captureRejections: true })` for async listeners. More
cases: [references/principles.md](references/principles.md#lsp).

### ISP: narrow, consumer-owned, structural contracts (TypeScript)

```ts
import { Readable } from 'node:stream';

interface Named {
  filename: string;
}

interface Attachable extends Named {
  readable: Readable;
}

const attach = async ({ filename, readable }: Attachable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  return { filename, size: Buffer.concat(chunks).length };
};

const listNames = (files: Named[]) => {
  const names: string[] = [];
  for (const file of files) names.push(file.filename);
  return names;
};

// Any matching shape fits, no `implements`: class instance, literal, record
const file = { filename: 'b.txt', readable: Readable.from(['data']) };
console.log(listNames([{ filename: 'a.txt' }, file]), await attach(file));
```

### DIP: use case owns contracts, the plugin tree wires implementations

```ts
// app/accounts.ports.ts: imports nothing from infra
export interface Account {
  login: string;
  hash: string;
}
export interface Accounts {
  findByLogin(login: string): Promise<Account | null>;
}
export interface Hasher {
  verify(password: string, hash: string): Promise<boolean>;
}
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

// app/sign-in.use-case.ts: dummyHash keeps the timing of an unknown login
type SignInDeps = { accounts: Accounts; hasher: Hasher; logger: Logger; dummyHash: string };

export const createSignIn = ({ accounts, hasher, logger, dummyHash }: SignInDeps) => {
  return async (login: string, password: string) => {
    const account = await accounts.findByLogin(login);
    const hash = account ? account.hash : dummyHash;
    const isMatch = await hasher.verify(password, hash);
    const isValid = account !== null && isMatch;
    if (isValid) logger.info('Signed in');
    else logger.warn('Sign-in failed');
    return isValid;
  };
};
```

```ts
// index.ts of the module: wiring only; the sole place that knows implementations
import fp from 'fastify-plugin';

export default fp(
  async (fastify) => {
    const accounts = createMongoAccounts(fastify.mongo.db);
    const hasher = createScryptHasher();
    const dummyHash = await hasher.hash('dummy');
    const signIn = createSignIn({ accounts, hasher, logger: fastify.log, dummyHash });
    fastify.decorate('signIn', signIn);
  },
  { name: 'sign-in', dependencies: ['mongodb'] },
);
```

Deliver dependencies by factory or constructor arguments, options, or a
revealing constructor (`new Writable({ write })`). Never assign them from
outside: a swap in the middle of an async operation splits logs or loses audit
records. Containers and service locators: `node-layered-architecture`.

## Anti-patterns

| Anti-pattern | Why it hurts | Instead |
| --- | --- | --- |
| God class: entity reads files, prompts, validates, saves | Many reasons to change, untestable | Entity data + repository + input + validators |
| Active Record (`user.save()`, `BaseEntity`) | Mixes domain and persistence; breaks SRP, OCP, LSP, DIP; one DB per entity | Aggregate + repository (Pure Fabrication) |
| Growing `switch`/`if` on `kind`, `instanceof` ladders | Every new kind edits old code | Dispatch table or polymorphic objects |
| Subclass changes contract (callback to promise, sync to async, throw to `'error'`) | Callers holding the base type break silently | Keep contract, add method or adapter |
| Subclassing `Promise`/`Array` to add behaviour | Species/`then` semantics break expectations | Compose, or use `AbortSignal` for cancel |
| Mixins and monkey-patching from outside, `setPrototypeOf` in app code | Destroys the expert's consistency; `if`s everywhere | Composition, explicit contracts |
| Hooks coupled through undeclared `request` fields | Hidden order dependency and shared state | `decorateRequest`, read in the handler, passed as arguments |
| `request.socket.server...`, `_private` access | Breaks with framework wrappers or minor releases | Ask the owner for data, public API only |
| Injecting by property assignment (`svc.logger = x`) | Swap mid-operation corrupts logs/audits | Constructor or factory arguments |
| Home-grown async queue/thenable in an app | Ordering bugs only tests reveal | Platform API or a tested library |
| EventEmitter as the only async contract | Events become GOTO, untyped | `async`/`await`, events only where natural |
| Trusting TS types across services | Other process/team/version differs | Runtime schema checks at boundaries |

## Checklist

- [ ] Each module/class/function has one reason to change; raw input is
      normalized at the boundary; domain functions return consistent shapes.
- [ ] No `switch`/`if` chain on type or kind that grows with features.
- [ ] Overrides and alternative implementations keep parameters, return
      type, error channel, sync/async timing and cancellation semantics; no
      `async` function is passed to an API that ignores its promise.
- [ ] Parameters and interfaces request only used fields; contracts are
      declared next to the consumer.
- [ ] Domain/application code imports no driver, framework, `node:http`,
      concrete logger; wiring happens in the composition root or plugin tree.
- [ ] Dependencies arrive via arguments, constructor or options, never via
      property assignment; `request`/`reply` stop at the handler.
- [ ] No `a.b.c.d` through live objects; no access to `_private` or internals.
- [ ] Entities hold no queries, file paths or connections (no Active Record).
- [ ] Every created resource (file handle, socket, timer, listener) is
      released by its creator; injected ones are not closed by the receiver.
- [ ] External data (DB documents, other services, queues) is validated at
      runtime; contracts are versioned with semver.
- [ ] App: no custom async primitives. Library: each one has contract tests.
- [ ] No ceremony: no abstract-only classes, no interface per method, no
      container for a handful of services.

Related skills: `js-gof`, `js-conventions`, `node-layered-architecture`,
`node-architecture-styles`, `js-contracts-schemas`, `node-http-server`,
`js-async-patterns`, `js-multiparadigm`
