# Refactoring path: from a fat handler to a module

One route refactored in small steps. Each step removes one kind of coupling,
keeps the app working and makes the next one possible.

| Step | Coupling removed | What changes |
| ---- | ---------------- | ------------ |
| 1. Guard | open by omission | every route declares `access`; the guard refuses the rest |
| 2. Module | one context spread over the app | a `modules/<name>/` folder with an `index.ts` plugin; routes and service move in unchanged |
| 3. Thin handler | handler knows the rules | the body moves into a function with plain arguments; the handler reads input and returns the result |
| 4. Repository | driver calls repeated in handlers | one repository per aggregate over the DAL; the document shape stays there |
| 5. Interface | service bound to the driver | the repository interface moves into `domain/`; the implementation stays in `infra/` |
| 6. Aggregate | rules scattered across services | invariants move into the aggregate root; the service orchestrates |
| 7. Injection | imports of `db`, `logger`, `config` | factories with parameters, wired by the module's `index.ts` |
| 8. Config | constants inside modules | one schema, loaded once (`node-config`); modules get their slice |
| 9. Errors | HTTP inside services | domain error codes, one `setErrorHandler` |
| 10. Second adapter | hidden transport coupling | the same service runs in a BullMQ worker or a wRPC procedure |
| 11. Contracts | hand-written shapes | schemas in `@alexify/metaschema`; route schemas, types and validators come from them |
| 12. Lint | boundaries by discipline | oxlint forbids imports across layers; a test guards the module boundary |

## Step details

### 1. Close the door first

Install the guard from [example-app.md](example-app.md) before moving anything.
Declaring `access` on each route is a one-line change, and it makes every later
step safe. A route nobody can classify is a finding: ask before marking it
`public`.

### 2. One folder per module

Pick the business context of the route and give it `modules/<name>/` with an
`index.ts` plugin. Move its routes and its service there as they are, and
register the plugin from `app.ts`. Nothing inside changes yet, but every later
step now happens in one folder. In `auth8`, `apps/auth8-api/src/modules/auth/`
already has this shape; its `service.ts` is what the next steps take apart.

### 3. Thin handler

```ts
// Before
fastify.post('/transfers', async (request, reply) => {
  const { from, to, amount } = request.body;
  const account = await fastify.mongo.db.collection('accounts').findOne({ cuid: from });
  if (account.balance < amount) return reply.code(409).send({ message: 'Insufficient funds' });
  // more queries, cache, logging, formatting
});

// After
fastify.post('/', { config: { access: 'session' }, schema: { body: Transfer } }, async (request) => {
  const { session, body } = request;
  return service.execute({ actorId: session!.accountId, ...body });
});
```

### 4, 5. Repository and its interface

Introduce one repository per aggregate, not per collection. Keep query and
document details there. Then declare the interface in `domain/` and make the
service depend on it:

```ts
// modules/transfers/domain/accounts.repository.ts
export interface AccountsRepository {
  findById(id: string): Promise<Account | null>;
  save(account: Account): Promise<boolean>;
}
```

Do not chase a storage-agnostic domain at the cost of database features. Single
document atomicity, `$inc` and aggregation pipelines are worth using, and they
stay behind the repository.

### 6. Move the rules into the aggregate

A check that appears in two services is an invariant that lost its owner.

```ts
// Before: in the service
if (account.balance < amount) {
  throw new DomainError('Insufficient funds', { code: 'ALX_ERR_INSUFFICIENT_FUNDS' });
}
account.balance -= amount;

// After: in the aggregate
account.withdraw(amount);
```

### 7, 8. Injection and config

- Factories take dependencies: `createTransfersService({ repository, events, logger })`.
- The module's `index.ts` builds them, decorates the facade and passes the
  service to its routes.
- A transport that receives the whole config can read database passwords, which
  is both a coupling and a security problem. Pass slices.
- Never interpolate a collection or field name that comes from a client.

### 9. Errors

Replace `reply.code(...)` and `httpErrors` outside Presentation with domain
errors carrying a code, and map the codes in one `setErrorHandler`. Remove the
status logic from services.

### 10. A second adapter proves the boundary

Writing one more adapter early, a queue worker or a CLI command, is the cheapest
proof that nothing protocol-specific leaked into the service. See
[framework-adapters.md](framework-adapters.md).

### 11. Contracts and schemas

The schema is the single source (`js-contracts-schemas`): route validation,
TypeScript types, JSON Schema for OpenAPI and MongoDB validators all come from
`@alexify/metaschema`. Do not hand-write a second schema for one consumer.

### 12. Enforce the boundaries

The oxlint layer rules, `import/no-cycle` and the architecture test are in
[modules.md](modules.md). Add the rules for a module once it is clean, so the
lint stays green during the migration.

## Signals that a step is not finished

- A function outside Presentation has a parameter named `request` or `reply`.
- A service imports `fastify`, `mongodb`, a config module or a logger package.
- A file reaches another module by a relative path, or by a deep
  `#modules/<name>/...` path.
- A test needs an HTTP server to check a business rule.
- A rule is checked in one service and again in another one.
- A route has no `access`.
