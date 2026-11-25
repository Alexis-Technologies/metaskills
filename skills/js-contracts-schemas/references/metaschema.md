# Metaschema for contract authors (`@alexify/metaschema` 4.0)

The subset a contract author needs. The full library API and its gotchas are in `alexis-libraries`
(references/metaschema.md), and how a definition reaches each consumer is in
[validation-chain.md](validation-chain.md). Behaviour below was checked on metaschema 4.0.0 and Node.js 24.

## Fields

| Syntax | Meaning |
| --- | --- |
| `name: 'string'` | required string (shorthand for `{ type: 'string' }`) |
| `name: '?string'`, `'name?': 'string'` | optional: accepts `null` and an absent key |
| `name: { type: 'string', nullable: true }` | required, accepts `null` |
| `login: { type: 'string', length: { min: 3, max: 64 } }` | length rule (`length: 10` is the max) |
| `age: { type: 'integer', min: 18, max: 150 }` | numeric bounds |
| `price: { type: 'number', decimals: 2 }` | at most two decimals |
| `email: { type: 'string', format: 'email', length: { max: 254 } }` | a format, after `register()` of `/formats` |
| `code: { type: 'string', pattern: /^[A-Z]{3}$/, length: 3 }` | pattern. Always give it a `length.max` |
| `age: { type: 'number', validate: (value) => ... }` | custom rule: `true`, `null` or nothing when valid; `false`, an error text or `{ code, message }` when not |
| `role: { enum: ['admin', 'user'] }` | enumeration |
| `role: { enum: ['admin', 'user'], default: 'user' }` | `parse` fills it in, `check` still requires it |
| `tags: { array: 'string' }` | array of strings |
| `ids: { set: 'number' }` | `Set` of numbers |
| `scores: { object: { string: 'number' } }` | plain object as dictionary |
| `index: { map: { string: 'number' } }` | `Map` |
| `point: ['number', 'number']` | tuple |
| `address: { city: 'string', 'zip?': 'string' }` | nested struct |
| `company: 'Company'` | reference to another entity of the model |
| `data: 'json'` | any JSON object or array |
| `when: { type: 'string', parse: (text) => new Date(text) }` | a decoder, run by `parse` |

Scalars: `string`, `number`, `integer`, `bigint`, `boolean`, `date`, `bytes`, `null`, `any`,
`unknown`, `json`.

`check()` rejects unknown keys and returns `{ valid, issues, errors }`. An issue is
`{ code, path, message, params }`, with `path` an array of keys. Match on `code`. There is no limit
on the issues by default, so a boundary passes `maxErrors`:

```js
const { Schema } = require('@alexify/metaschema');

const SignUp = Schema.from({
  login: { type: 'string', length: { min: 3, max: 64 } },
  password: { type: 'string', length: { min: 8, max: 128 } },
  'email?': 'string',
  role: { enum: ['admin', 'user'] },
});

const input = { login: 'al', role: 'user', isAdmin: true };
const { valid, issues } = SignUp.check(input, { maxErrors: 20 });
// valid: false
// issue codes, in order: 'length' (login), 'required' (password), 'unexpected' (isAdmin)
```

A definition whose first key names a type reads as that type, not a struct: `{ set: 'string', name:
'string' }` is a `Set`. Start such a struct with `Struct: {}`, and so every branch of a union with
`discriminator: 'type'`, whose first key `type` would read as the long form of a field.

## A model for stored documents

```js
const { Model } = require('@alexify/metaschema');

const entities = new Map();
entities.set('Company', { Registry: {}, name: { type: 'string', unique: true } });
entities.set('Account', {
  Entity: {},
  login: { type: 'string', unique: true, length: { min: 3, max: 64 } },
  company: 'Company',
  active: { type: 'boolean', default: true },
  'fullName?': 'string',
  byCompany: { index: ['company', 'login'] },
});

const model = new Model({}, entities);
const Account = model.entities.get('Account');
```

- The first key is the kind. Stored, with an id: `Entity`, `Registry`, `Dictionary`, `Journal`,
  `Details`, `Relation`, `View`. In memory: `Struct`, `Scalar`, `Form`, `Projection`.
- A stored kind gets an id field named after it (`accountId`), a string in the program and `_id` in
  the database.
- `unique: true` and `index: true` mark a field, and a named key with `{ unique: [...] }` or
  `{ index: [...] }` declares a compound index. `indexesOf(model)` reads them all.
- A reference to a stored kind is an id string in the program and an ObjectId in the database. A
  reference to a memory kind (`Struct`) is the embedded record. `embed: true` on the field, or
  `{ references: 'embed' }` or `'id'` of a check, overrides it.

## Bodies derived from the entity

```js
const { omit, partial, pick } = require('@alexify/metaschema/derive');

const CreateAccount = omit(Account, ['active'], { name: 'CreateAccount' });
const UpdateAccount = partial(CreateAccount, { name: 'UpdateAccount' });
const AccountView = pick(Account, ['accountId', 'login'], { name: 'AccountView' });
```

Derive once at startup, never in a handler. `partial` is shallow and drops defaults, so a patch does
not overwrite stored values. `keys`, `defaults: true` and `deep: true` change that
(`alexis-libraries`).

## API method contract

A declarative contract next to a method is a useful default for any transport:

| Field | Purpose |
| --- | --- |
| `method` | `async ({ ...named }, context) => result` (required) |
| `parameters` | schema of the named-arguments object |
| `validate` | imperative preconditions, throw to reject |
| `returns` | schema of the result (postcondition) |
| `errors` | `{ CODE: 'message' }` for a thrown `DomainError` with that code |
| `access` | who may call it. Enforce with `@alexify/kerberos` |
| `timeout` | ms. The call rejects, the work is not cancelled |
| `queue` | `{ concurrency, size, timeout }` per-method limit |
| `deprecated` | mark old methods before removal |
| `caption`, `description`, `examples` | docs and generated tests |

In wrpc these map to `procedure({ input, output, timeout, queue, meta, handler })`. Roles go in a
`preValidation` hook, since `access` there only gates on a session (`alexis-libraries`).
