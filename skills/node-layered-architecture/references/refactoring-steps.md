# Refactoring path: from a fat handler to Onion layers

One route refactored in small steps. Each step removes one kind of coupling,
keeps the app working and makes the next one possible.

| Step | Coupling removed | What changes |
| ---- | ---------------- | ------------ |
| 1. Guard | open by omission | every route declares `access`; the guard refuses the rest |
| 2. Thin handler | handler knows the rules | the body moves into a function with plain arguments; the handler reads input and returns the result |
| 3. Repository | driver calls repeated in handlers | one repository per aggregate over the DAL; the document shape stays there |
| 4. Interface | use case bound to the driver | the repository interface moves into Domain; the implementation stays in Infrastructure |
| 5. Aggregate | rules scattered across use cases | invariants move into the aggregate root; the use case orchestrates |
| 6. Injection | imports of `db`, `logger`, `config` | factories with parameters, wired by a named `fastify-plugin` |
| 7. Config | constants inside modules | `@fastify/env` or `env-schema` once; modules get their slice |
| 8. Errors | HTTP inside services | domain error codes, one `setErrorHandler` |
| 9. Second adapter | hidden transport coupling | the same use case runs in a BullMQ worker or a wRPC procedure |
| 10. Contracts | hand-written shapes | schemas in `@alexify/metaschema`; route schemas, types and validators come from them |
| 11. Lint | boundaries by discipline | oxlint forbids imports across rings |

## Step details

### 1. Close the door first

Install the guard from [example-app.md](example-app.md) before moving anything.
Declaring `access` on each route is a one-line change, and it makes every later
step safe. A route nobody can classify is a finding: ask before marking it
`public`.

### 2. Thin handler

```ts
// Before
fastify.post('/transfers', async (request, reply) => {
  const { from, to, amount } = request.body;
  const account = await fastify.mongo.db.collection('accounts').findOne({ cuid: from });
  if (account.balance < amount) return reply.code(409).send({ message: 'Insufficient funds' });
  // more queries, cache, logging, formatting
});

// After
fastify.post('/transfers', { config: { access: 'session' }, schema: { body: Transfer } }, async (request) => {
  const { session, body } = request;
  return fastify.transfers.execute({ actorId: session!.accountId, ...body });
});
```

### 3, 4. Repository and its interface

Introduce one repository per aggregate, not per collection. Keep query and
document details there. Then declare the interface in Domain and make the use
case depend on it:

```ts
// domain/account/accounts.ts
export interface Accounts {
  findById(id: string): Promise<Account | null>;
  save(account: Account): Promise<boolean>;
}
```

Do not chase a storage-agnostic domain at the cost of database features. Single
document atomicity, `$inc` and aggregation pipelines are worth using, and they
stay behind the repository.

### 5. Move the rules into the aggregate

A check that appears in two use cases is an invariant that lost its owner.

```ts
// Before: in the use case
if (account.balance < amount) throw new DomainError('Insufficient funds', 'EFUNDS');
account.balance -= amount;

// After: in the aggregate
account.withdraw(amount);
```

### 6, 7. Injection and config

- Factories take dependencies: `createTransfers({ accounts, events, logger })`.
- A named plugin builds them and decorates the instance.
- A transport that receives the whole config can read database passwords, which
  is both a coupling and a security problem. Pass slices.
- Never interpolate a collection or field name that comes from a client.

### 8. Errors

Replace `reply.code(...)` and `httpErrors` outside Presentation with domain
errors carrying a code, and map the codes in one `setErrorHandler`. Remove the
status logic from services.

### 9. A second adapter proves the boundary

Writing one more adapter early, a queue worker or a CLI command, is the cheapest
proof that nothing protocol-specific leaked into the use case. See
[framework-adapters.md](framework-adapters.md).

### 10. Contracts and schemas

The schema is the single source (`js-contracts-schemas`): route validation,
TypeScript types, JSON Schema for OpenAPI and MongoDB validators all come from
`@alexify/metaschema`. Do not hand-write a second schema for one consumer.

### 11. Enforce the rings with oxlint

Rules live in `.oxlintrc.json`, per layer:

```json
{
  "overrides": [
    {
      "files": ["src/domain/**"],
      "rules": {
        "no-restricted-imports": [
          "error",
          {
            "patterns": [
              {
                "group": ["fastify*", "mongodb", "**/application/**", "**/infrastructure/**", "**/presentation/**"],
                "message": "Domain imports nothing from outer layers"
              }
            ]
          }
        ]
      }
    },
    {
      "files": ["src/application/**"],
      "rules": {
        "no-restricted-imports": [
          "error",
          {
            "patterns": [
              {
                "group": ["fastify*", "mongodb", "**/infrastructure/**", "**/presentation/**"],
                "message": "Application depends only on Domain"
              }
            ]
          }
        ]
      }
    }
  ]
}
```

Add the rule for a context once it is clean, so the lint stays green during the
migration.

## Signals that a step is not finished

- A function outside Presentation has a parameter named `request` or `reply`.
- A use case imports `fastify`, `mongodb`, a config module or a logger package.
- A test needs an HTTP server to check a business rule.
- A rule is checked in a use case and again in another one.
- A route has no `access`.
