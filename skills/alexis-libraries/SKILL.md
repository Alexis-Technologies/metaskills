---
name: alexis-libraries
description: Picks and uses @alexify kerberos, wrpc, migronaut, metaschema, protoarray, syncom, mailer. Use when choosing or calling one of these packages
---

<!-- Rewritten from the Metarhia libraries cheat sheet as a decision guide for the @alexify packages.
     Every API and gotcha here was read from the package source or run against it. -->

# Alexis libraries

Choose an `@alexify/*` package by the problem, call only what its installed version exports, and
know where it stops. Each library has one reference with its API and verified gotchas. Read it before
writing code against the library:

[kerberos](references/kerberos.md), [wrpc](references/wrpc.md),
[migronaut](references/migronaut.md), [metaschema](references/metaschema.md),
[protoarray](references/protoarray.md), [syncom](references/syncom.md),
[mailer](references/mailer.md).

For metautil data structures use the `metautil-data-structures` skill. How one schema reaches every
consumer is the Validation chain of `js-contracts-schemas`.

## Versions and status

Read from each repository on 2026-11-21 (`package.json`, git tags, `CHANGELOG.md`). The npm registry
was not queried: before pinning, compare with `pnpm view <package> version`, and read
`node_modules/<package>/package.json` before trusting an API detail.

| Package | Version | Node.js | Status | Role |
| --- | --- | --- | --- | --- |
| `@alexify/kerberos` | 4.3.0 | 18+ | released | authorization policies |
| `@alexify/wrpc` | 2.2.0 | **22+** | released | realtime RPC |
| `@alexify/migronaut` | 2.5.0 | **22.18+** | released | MongoDB migrations |
| `@alexify/metaschema` | 3.4.0 | 18+ | released | single source of schemas |
| `@alexify/protoarray` | 2.1.0 | 18+ | released | positional JSON serialization |
| `@alexify/mailer` | 1.2.1 | **22+** | released, email only | email and its reliability layer |
| `@alexify/syncom` | 0.0.1 | **24+** | **not published** | local-first sync engine |

All are CommonJS with handwritten `.d.ts` and zero runtime dependencies. Hosts (Fastify, Redis, the
MongoDB driver, BullMQ) are injected by the application.

## Decision guide

| Need | Use | Not when |
| --- | --- | --- |
| Validate input, derive types and API docs | `metaschema` | never hand-write a second schema |
| MongoDB validator, indexes, document mapping | `metaschema/mongodb` | it does no I/O: the DAL calls the driver |
| Roles, ownership, tenancy, list filters | `kerberos` | authentication, rate limits |
| Bidirectional calls, subscriptions, rooms, streams | `wrpc` | public or CRUD API: REST stays |
| One-time data change, in order, with rollback | `migronaut` migration | indexes only: declared collection |
| Current indexes and validators of a collection | `migronaut converge` | experimental: review the plan |
| Fewer bytes for repeated records on a shared schema | `protoarray` | public APIs, low-volume endpoints |
| Transactional email with retries and delivery events | `mailer` | SMS, chat, push: not released |
| Email that must go out when a write commits | `mailer/mongodb` outbox | no replica set |
| Offline-first, CRDT sync | `syncom`, **experiments only** | anything shipping today |

### Replacing Metarhia packages

| Metarhia | Alexis |
| --- | --- |
| metacom | `@alexify/wrpc` |
| metaschema | `@alexify/metaschema` (a major rewrite: see its reference) |
| metasql | native driver, own DAL, `@alexify/metaschema/mongodb`, `@alexify/migronaut` |
| metalog | Pino |
| Impress, metavm | Fastify, autoload, `fastify-plugin` |
| Hand-written ACL or RBAC | `@alexify/kerberos` |
| globalstorage | `@alexify/syncom`, once it is published |
| metautil helpers | native APIs, or `metautil-data-structures` for its ADTs |
| metaconfiguration | 12-factor config with `env-schema` |
| metatests | `node:test` in libraries, Vitest in apps |

## Rules

- Target the current major. A consumer on an older major gets the older behaviour, and a caret range
  never crosses a major.
- Validate at the boundary with metaschema, authorize with Kerberos, then run domain code. Keep that
  order on every transport.
- Never advise installing `@alexify/syncom`.
- Inject hosts and drivers. Do not add a runtime dependency to a library to reach one.
- Match errors on `code`, never on the message text.
- Release what a kit opens: `migrator.disconnect()`, `server.close({ drain })`, `worker.close()`.

## kerberos

Choose it when a decision depends on roles, ownership, tenancy or attributes, and when a list must
show only what the caller may see.

```js
const { Kerberos } = require('@alexify/kerberos');

const kerberos = new Kerberos(policies, derivedRoles, { onError: 'deny' });
const isAllowed = await kerberos.isAllowed({ principal, resource, action: 'delete' });
const plan = await kerberos.planResources({ principal, resource: { kind: 'expense' }, action });
```

- **Target 4.x.** Below 4.0 a `DENY` on a partial wildcard does not deny. Running it, `view:*` still
  allowed `view:secret` on 1.0.0 (`alioth-api`) and on **2.0.1 (`auth8`)**, and denied it on 4.3.0.
  On those consumers list actions in deny rules until the pin moves. The upgrade changes semantics.
- `onError` defaults to `'throw'`. Set `'deny'`.
- A function condition is `opaque` in a plan. Use `$expr` conditions for anything a list filter needs.
- A plan inlines principal data. Keep it on the server.

## wrpc

Choose it for realtime next to REST, mounted in Fastify through `@alexify/wrpc/fastify`.

```js
const { defineRouter, procedure } = require('@alexify/wrpc');

const meta = { authz: { resource: 'chat', action: 'send' } };
const send = procedure({ input: SendMessage, meta, handler: sendMessage });
const router = defineRouter({ chat: { send } }, { hooks: { preValidation: authorize } });
```

- **`access` is only a session gate.** A procedure without `access` defaults to `'session'`: anonymous
  callers get 403 and **every signed-in user is admitted**, whatever their role. Any other value
  throws when the procedure is built.
- **So Kerberos must run in a wrpc hook.** Use a router-level `preValidation` that refuses a
  non-public procedure with no declared rule. The hook is in `references/kerberos.md`.
- `system/introspect` is public by default and lists every method. Set `introspection`.
- `timeout` rejects the caller and leaves the handler running. Watch `context.signal`.
- A login over WebSocket sets no cookie. Log in over HTTP.
- `MemorySessionStore` is the default: replace it past one process.

## migronaut

Choose a migration for a change with a history, and a declared collection for an end state.

```js
const { MigratorKit } = require('@alexify/migronaut');

const migrator = new MigratorKit({ uri, dbName, migrationsDir: './migrations' });
await migrator.connect();
try {
  await migrator.up();
} finally {
  await migrator.disconnect();
}
```

- `up` and `down` are both required in a migration file.
- A transaction needs a replica set, and every driver call must pass `{ session }`.
- **Its versioning defaults are not the Alexis field names.** Set
  `versioning: { current, min, field: 'v', revisionField: 'rev' }`, and pass them to its helpers.
- Generate validators and indexes from the metaschema model. Declare `v`, `rev` and the timestamps in
  the model, since the validator is closed.
- Declared collections and versioning are experimental.

## metaschema

The single source of truth. All other schemas are generated from it.

```js
const { Schema } = require('@alexify/metaschema');

const Login = new Schema('Login', {
  login: { type: 'string', length: { min: 3, max: 64 } },
  password: { type: 'string', length: { min: 8, max: 128 } },
});

const { valid, value, issues } = Login.parse(body);
```

- `toZod` and `toTypeBox` do not exist.
- Generators live in `/generators` since 3.0: `model.dts` is `undefined` until its `register()` runs.
- `format` needs `register()` of `/formats`, and `coerce` needs `register()` of `/coerce`.
- The unknown-key error text changed in 3.x. Match on `issue.code === 'unexpected'`.
- A required field with a `default` stays in `required` of the JSON Schema.
- `validate` functions are not exported, `decimals` needs `multipleOfPrecision` in Ajv, and `bigint`
  has no JSON form.

## protoarray

Choose it only after measuring that repeated keys dominate a payload both sides share a schema for.

```js
const { Schema } = require('@alexify/protoarray');
const { Schema: Definition } = require('@alexify/metaschema');

const User = Schema.from(new Definition('User', { id: 'number', name: 'string' }));
const wire = User.stringify({ id: 1, name: 'Ada' }); // '[1,"Ada"]'
const user = User.parse(wire);
```

- **A position is forever.** Append only. A reorder between fields of one type decodes silently into
  the wrong keys.
- `encode` trusts its input: check with `User.source.check` where a producer can be wrong.
- A field appended to an `Entity` takes the position of its id. Declare the id in the definition.

## mailer

Choose it for transactional email, through a queue from any request handler.

```js
const { createMessage } = require('@alexify/mailer');
const { SmtpTransport } = require('@alexify/mailer/smtp');

const transport = new SmtpTransport({ host, port: 465, secure: true, auth });
const message = createMessage({ from, to, subject, content: { text } });
const receipt = await transport.send(message);
if (!receipt.successful) logger.error({ errors: receipt.errorMessages }, 'send failed');
```

- `send` reports a failure in the receipt. Check `successful`.
- `deliveryUnknown` means the provider may have the message. Never resend it by hand.
- Webhooks are verified over the **raw body**: keep a `Buffer` for that route.
- 1.x is email only. The channel subpaths are unreleased.

## syncom

**Not published (0.0.1).** Never add it to a production dependency or advise installing it, even
though its own docs show an install command for a future release. For realtime data today use
`wrpc` over the native driver, with the concepts in `js-local-first-sync`. Use syncom only in
experiments, through a workspace link, with the maintainer's agreement.

## How they combine

A realtime write in an app:

1. `wrpc` receives the call and checks the session.
2. A `preValidation` hook asks `kerberos`.
3. The metaschema `Schema` passed as `input` validates and applies defaults.
4. The handler calls the service. The aggregate enforces invariants.
5. The DAL maps with `toDocument`, guards updates with `checkUpdate` and filters on `rev`.
6. `mailer` enqueues into the outbox in the same transaction.
7. `migronaut` owns the indexes and validators of those collections.

## Anti-patterns

- `procedure({ handler })` treated as protected for admins: it admits every session.
- `procedure({ access: 'admin' })`: it throws at build. Roles belong in a hook.
- A `DENY` rule on `view:*` in a project pinned below Kerberos 4.
- Authorizing a list with `isAllowed` per row instead of `planResources`.
- Writing a Zod, TypeBox or Ajv schema by hand next to a metaschema definition.
- `model.dts` without `register()` of `/generators`.
- Matching `'is not expected'` or any other validation message text.
- Migrations that change data without passing `{ session }` in a transaction.
- Letting migronaut versioning default its field names in an Alexis collection.
- Reordering fields of a protoarray schema.
- Resending an email marked `deliveryUnknown`.
- `pnpm add @alexify/syncom`.

## Checklist

- [ ] The installed major is the one the code is written for.
- [ ] Every non-public wrpc procedure declares a rule, and the hook refuses one that does not.
- [ ] `introspection` is decided, and the session store is shared past one process.
- [ ] Kerberos runs with `onError: 'deny'`, on 4.x, with policy tests that pin each deny.
- [ ] Schemas come from metaschema; no second hand-written schema exists.
- [ ] Validators are closed and declare `v`, `rev` and the timestamps.
- [ ] Transactions pass `{ session }` on every driver call.
- [ ] protoarray schemas only grow at the end.
- [ ] Email goes through a queue, and receipts are checked.
- [ ] syncom is not a dependency of anything shipping.

Related skills: `js-contracts-schemas`, `metautil-data-structures`, `node-access-control`,
`node-data-access`, `node-websocket-realtime`, `js-local-first-sync`, `node-graceful-shutdown`,
`js-conventions`, `error-handling`
