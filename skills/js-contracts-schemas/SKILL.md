---
name: js-contracts-schemas
description: Contracts at trust boundaries with one metaschema source for Fastify, Ajv, TypeBox, OpenAPI, MongoDB, wrpc. Use for APIs, validation, DTOs, .d.ts
---

<!-- Adapted for the Alexis stack: @alexify/metaschema is the single source, and this skill owns the
     Validation chain other skills refer to. Examples ran on Node.js 24 with metaschema 3.4. -->

# Contracts and Schemas in JS/TS

Fix the contract before the implementation: declare what a function or API accepts, returns and
fails with, check it at runtime where data crosses a trust boundary, and let one declarative schema
drive validation, typings, docs and tests. Inside the boundary, business code trusts the contract and
does not re-check its inputs.

## What a contract covers

| Part | Expressed by | Checked |
| --- | --- | --- |
| Signature, shapes | TS types, `.d.ts`, short JSDoc | design time, erased at runtime |
| Runtime data | `@alexify/metaschema` schema | at trust boundaries |
| Behaviour: sync vs async callback, order, gaps between chunks, cancellation, which errors | contract tests | in CI, for every implementation |
| Business rules (pre/post, invariants) | `validate`, value objects, aggregates, DB validators | at entry, in constructors, in DB |

Types cannot say whether a callback runs synchronously (like `Array#map`) or after an event-loop turn
(like stream chunks). Only tests fix that. Types, schemas and tests together are a reliable contract.
Any one alone is not.

## The Validation chain

`@alexify/metaschema` is the **single source of truth**. Every other schema is generated from it.

| Consumer | How it gets the schema |
| --- | --- |
| TypeScript types | `Infer`, `InferSchema`, `toTypeScript` |
| Backend (recommended) | metaschema directly: `parse` through a Fastify validator compiler |
| Ajv at route level | `toJSONSchema(schema, { target: 'draft-07' })` |
| TypeBox | `Type.Unsafe(toJSONSchema(schema, { target: 'draft-07' }))`: a wrapper, there is no generator |
| OpenAPI | `toJSONSchema(schema, { target: 'openapi-3.0' })` |
| MongoDB | `toJSONSchema(model, { target: 'mongodb', ids: 'objectId' })`, `indexesOf`, `toDocument`, `checkUpdate` |
| wrpc | Standard Schema directly: `procedure({ input: schema })` |
| Frontend (recommended) | Standard Schema directly. vee-validate 4 needs a small adapter |
| Zod (frontend only) | needs a `toZod` generator, which does not exist yet |

**`toZod` and `toTypeBox` do not exist.** Never hand-write a Zod, TypeBox or Ajv schema as a source.

- Ajv and TypeBox are backend only: at route level, or when the built-in validator does not fit. Say
  why in the code.
- Extensions live in the adapter of a validator (`addKeyword`, `refine`) and never change the source.
- `validate` functions are not exported to JSON Schema, `decimals` needs `multipleOfPrecision` in
  Ajv, and `bigint` has no JSON form.

Traps, each reproduced by running the chain on shared fixtures:

- **Fastify's default Ajv breaks the contract.** `removeAdditional: true` drops an unknown key and
  answers 200 instead of 400, and `multipleOf` rejects `19.99`. The metaschema compiler has neither
  problem. For Ajv set `removeAdditional: false`, `coerceTypes: false`, `multipleOfPrecision: 9`.
- The default 2020-12 document fails on Fastify's Ajv. Use `target: 'draft-07'`.
- A key with a `default` stays in `required` of the JSON Schema. Ajv needs `useDefaults: true`.
- `Type.Unsafe` works only where Ajv reads it. TypeBox's `Value.Check` and `TypeCompiler` throw.
- `@fastify/swagger` crashes on a raw `Schema`: convert it in `transform`.
- **vee-validate 4.15 given a raw `Schema` reports invalid input as valid.** Use the adapter.
- `format` and `coerce` need `register()` of `/formats` and `/coerce`.

The code for every consumer is in [references/validation-chain.md](references/validation-chain.md).

## Rules

### Boundaries

- Validate every value that enters from outside the process or from less trusted code: request
  bodies, query strings, headers, WebSocket messages, queue and bus events, files and uploads, env and
  config, `worker.postMessage` data, documents from databases you do not own, third-party API
  responses.
- Validate on the client for fast feedback and **always re-validate on the server**: other clients do
  not run your checks.
- Inside the domain, do not repeat checks the boundary guarantees. Business code that receives
  `{ name, age, address }` past a contract trusts its types. Defensive `typeof` chains in domain code
  hide the real contract.
- Reject unknown fields, which metaschema does by default, or strip them explicitly with
  `parse(value, { unknown: 'strip' })`. Never spread raw input into DB writes (mass assignment of
  `isAdmin`, `ownerId`).
- Contract violations by callers are client errors (400, `ALX_ERR_VALIDATION`) with a list of reasons.
  Violated postconditions are server bugs (500, logged). See `error-handling`.

### Declarative over imperative

- Prefer a declarative contract next to the method over `assert(typeof a === 'number')` lines inside
  it: asserts are noisy, easy to get wrong, invisible to tools and cannot generate docs, typings or
  tests.
- A useful default shape for a method is `{ access, parameters, validate, method, returns, errors,
  timeout, queue, deprecated, examples }`. A runner checks `parameters`, calls `validate` for what a
  schema cannot express, invokes `method` with a timeout, maps thrown `DomainError` codes through
  `errors`, and checks `returns`. Field reference: [references/metaschema.md](references/metaschema.md).
- Keep one source of truth per shape. One definition drives runtime validation, types, MongoDB
  validators and indexes, docs for consumers, and fake data for tests (`sample`). Never maintain a TS
  interface and a schema for the same DTO by hand.
- Derive create, update and view bodies with `pick`, `omit`, `partial` of `/derive`.
- Build and derive schemas once at startup, never per request.
- Hand the contract (schemas, `.d.ts`, examples) to consumers before the implementation exists: both
  sides can test against it in parallel.

### Preconditions, postconditions, invariants

- Preconditions: schema and `validate` at the entry point. Fail fast with all reasons, before any I/O.
- Postconditions: check `returns` in development, tests and staging. Keep them in production at
  external boundaries (results sent to clients or partners). Disable checks only between trusted
  in-process parts after they ran with checks on.
- Invariants: enforce in constructors and factories of value objects and aggregates
  (`new Money(-1.5, 'usd')` throws) and in the DB (`$jsonSchema` validators, unique indexes). An object
  that exists is valid.
- Errors are part of the contract: declare the codes a method can produce
  (`errors: { ALX_ERR_LIMIT: 'Daily limit exceeded' }`) so clients know what to handle. Everything else is an
  exception mapped to a generic 500 (`error-handling`).

### Typings

| | Library `@alexify/*` | App (`auth8`) |
| --- | --- | --- |
| Source | CommonJS `.js` with a handwritten `.d.ts` | ESM TypeScript, NodeNext |
| Check | `tsd` or `tsc --noEmit` in `pnpm test` | `tsc --noEmit` |
| DTO types | `Infer` from the definition | `Infer` from the definition |

- `allowJs` alone does **not** type-check JS: TypeScript then only checks `.d.ts` and `.ts` files. Set
  `"checkJs": true`, or `// @ts-check` per file.
- A sibling `lib/x.d.ts` wins over inference from `lib/x.js` for importers. Keep them in sync through
  type tests, not by eye.
- JSDoc only when very short: one line that says what the signature cannot.
- Declare Fastify decorators with `declare module 'fastify'`, so `fastify.kerberos` is typed.
- Add `@types/node` and types for dependencies as devDependencies. Publishable libraries ship their
  own `.d.ts` and point `types` in `package.json` at it.

### Native protocols are contracts

Callables, callbacks, thenables, iterators, disposables, emitters and streams are interfaces without
the keyword. Implement the whole protocol: `return()` on iterators that hold resources,
`Symbol.asyncDispose` on resources, and never a `then` property on data. Rules and runnable code:
[references/native-protocols.md](references/native-protocols.md).

### API design and evolution

- Methods take one named-arguments object `({ login, password })` and return a plain serializable
  object. This survives reordering, optional fields and transport changes (HTTP, WebSocket, IPC).
- Keep return types consistent: the same shape on every success path. Errors go through the error
  channel or `DomainError` codes, not `null` or `false` sentinels mixed with objects.
- Additive changes only within a version: new optional parameters, new result fields. Removing or
  renaming a field, adding a required parameter, tightening a type or changing meaning is a new
  version. Clients ignore unknown result fields and handle unknown error codes generically.
- Version the interface, not the method: `/v1/...` over HTTP, a `unit.v1` key in a wrpc router. Keep
  old versions for old clients, mark old methods `deprecated` and log their use before removal.
- Declare operational limits in the contract too: `timeout`, `queue`, access, payload size.

## Patterns

### One definition reaches a Fastify route

```ts
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifySchemaCompiler } from 'fastify';
import type { Schema, ValidationIssue } from '@alexify/metaschema';

const TEXT_PARTS = new Set(['querystring', 'params', 'headers']);

const toError = (issues: readonly ValidationIssue[]) => {
  const error = new Error('Validation failed') as Error & Record<string, unknown>;
  error.statusCode = 400;
  error.code = 'ALX_ERR_VALIDATION';
  error.validation = issues;
  return error;
};

export const metaschemaCompiler: FastifySchemaCompiler<Schema> = ({ schema, httpPart }) => {
  const part = httpPart ?? '';
  const coerce = TEXT_PARTS.has(part);
  const unknown = part === 'headers' ? 'ignore' : 'reject';
  return (data) => {
    const { valid, value, issues } = schema.parse(data, { coerce, unknown });
    return valid ? { value } : { error: toError(issues) };
  };
};

export default fp(async (fastify: FastifyInstance) => {
  fastify.setValidatorCompiler(metaschemaCompiler);
});
```

```ts
app.post('/signup', { schema: { body: SignUp } }, async (request) => createAccount(request.body));
```

### Portable contract runner

The same idea for a queue consumer, an RPC dispatcher or a service:

```js
const { Schema } = require('@alexify/metaschema');

const { DomainError } = require('./domain-error.js'); // the class of `error-handling`

class ContractError extends Error {
  constructor(code, reasons) {
    super(`Contract violation: ${reasons.join('; ')}`);
    this.name = 'ContractError';
    this.code = code;
    this.reasons = reasons;
  }
}

const compile = (definition) => (definition ? Schema.from(definition) : null);

const toReasons = (issues) => {
  const reasons = [];
  for (const { path, message } of issues) {
    const field = path.join('.');
    reasons.push(field === '' ? message : `${field}: ${message}`);
  }
  return reasons;
};

const parseContract = (schema, value, code) => {
  if (!schema) return value;
  const result = schema.parse(value);
  if (!result.valid) throw new ContractError(code, toReasons(result.issues));
  return result.value;
};

const rethrow = (error, errors) => {
  const isDeclared = error instanceof DomainError && Object.hasOwn(errors, error.code);
  if (!isDeclared) throw error;
  const { code, details } = error;
  throw new DomainError(code, { message: errors[code], cause: error, details });
};

const withContract = (definition) => {
  const parameters = compile(definition.parameters);
  const returns = compile(definition.returns);
  const { validate = null, method, errors = {} } = definition;
  const call = async (input, context) => {
    try {
      return await method(input, context);
    } catch (error) {
      rethrow(error, errors);
    }
  };
  return async (args, context) => {
    const input = parseContract(parameters, args, 'ALX_ERR_VALIDATION');
    if (validate) await validate(input);
    const result = await call(input, context);
    return parseContract(returns, result, 'ALX_ERR_RESULT');
  };
};
```

`withContract({ parameters: { a: 'number' }, method })({ a: 1, isAdmin: true })` rejects with
`ALX_ERR_VALIDATION` and the reason `has unexpected keys: isAdmin`. Match on the code, since the text of a
reason can change between versions.

### Value object enforces invariants

```js
const EMAIL = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;
const MAX_EMAIL_LENGTH = 254;

class Email {
  #value;

  constructor(value) {
    if (typeof value !== 'string') throw new TypeError('Email must be a string');
    const normalized = value.trim().toLowerCase();
    const isValid = normalized.length <= MAX_EMAIL_LENGTH && EMAIL.test(normalized);
    if (!isValid) throw new RangeError('Email has an invalid format');
    this.#value = normalized;
    Object.freeze(this);
  }

  get value() {
    return this.#value;
  }

  equals(other) {
    return other instanceof Email && other.value === this.#value;
  }

  toJSON() {
    return this.#value;
  }
}
```

- **Keep the domain part free of dots in its repeated class.** `[^@\s]+\.[^@\s]+$` lets every dot be
  the split point, so a crafted string backtracks quadratically: 80 KB took 1.8 s. The pattern above
  took 0.26 ms on the same input, and the length cap bounds it further.
- The error does not echo the value: it may be personal data, and it may be huge.
- Without `'use strict'`, a write to the frozen object or to a getter-only property **fails silently**
  in calling code. The private field and the absent setter are what protect the value.
- In a schema use `format: 'email'` with `length: { max: 254 }`, which is linear too.

### Typings for a JS module

```ts
// lib/hash.d.ts, the header for lib/hash.js (CommonJS)
export function hash(password: string): Promise<string>;
export function verify(password: string, hash: string): Promise<boolean>;
```

```js
// @ts-check

/** @typedef {{ amount: number, currency: string }} Money */

/** @type {(a: Money, b: Money) => Money} */
const add = (a, b) => {
  if (a.currency !== b.currency) throw new Error('Currency mismatch');
  return { amount: a.amount + b.amount, currency: a.currency };
};
```

```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": true,
    "module": "nodenext",
    "target": "es2023",
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["**/*.js", "**/*.d.ts"]
}
```

Contract tests for several implementations: [references/examples.md](references/examples.md). The
library API of metaschema and its gotchas are owned by `alexis-libraries`.

## Anti-patterns

- Trusting TS types for network data: `req.body as SignUp` is a cast, not a check. Types are erased at
  runtime.
- Validation only in the frontend, or only in the domain layer after the data was already written or
  forwarded.
- A hand-written `interface`, or a Zod, TypeBox or Ajv schema, beside the definition of the same DTO.
- Fastify's default Ajv with a generated schema, trusted to reject unknown keys.
- Schemas compiled or derived per request.
- `assert` and `typeof` chains repeated in every function instead of one contract at the boundary, or
  the opposite: no runtime checks at all.
- Accepting unknown fields and spreading input into a DAL write.
- A regular expression over unbounded input, or with overlapping repetition.
- Matching validation errors by message text instead of `code`.
- `allowJs` without `checkJs`, so `tsc` passes while JS violates `.d.ts`.
- Partial protocol implementations: iterators without `return()` that leak cursors on `break`, `then`
  on plain objects, callbacks invoked sometimes sync and sometimes async.
- Positional API arguments (`api.move(name, x, y)`), mixed return types (`object | false | null`),
  errors as strings, silent breaking changes to a published contract instead of a new version.

## Checklist

- [ ] Every trust boundary validates input with a schema built once and rejects or strips unknown
      fields.
- [ ] Every schema of a DTO is generated from one metaschema definition.
- [ ] Ajv, if used, sets `removeAdditional: false`, `coerceTypes: false`, `useDefaults: true` and
      `multipleOfPrecision`, with a comment on why it is there.
- [ ] The server re-validates even when the client does.
- [ ] Each API method declares parameters, result, error codes, access and timeout next to its
      implementation.
- [ ] Value objects and aggregates enforce invariants in constructors, and the DB has matching
      validators and unique indexes.
- [ ] Postconditions are checked at least in tests, staging and at external boundaries.
- [ ] JS code is type-checked: `checkJs` or `// @ts-check`, `.d.ts` for modules, in `pnpm test`.
- [ ] Protocol objects implement the full protocol and have contract tests.
- [ ] Named-argument objects, consistent return shapes, explicit error codes.
- [ ] Breaking changes go to a new interface version. Old versions are deprecated and monitored before
      removal.

Related skills: `alexis-libraries`, `error-handling`, `js-conventions`, `js-multiparadigm`,
`js-async-patterns`, `node-layered-architecture`, `node-data-access`, `node-http-server`,
`node-security`
