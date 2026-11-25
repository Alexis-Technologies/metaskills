# @alexify/metaschema

The single source of truth for data shapes: validation, types, JSON Schema, OpenAPI, MongoDB
validators and Standard Schema from one definition. Version 4.0.0, tag `v4.0.0`, Node.js 18+, no
runtime dependencies, browser build. How the definition reaches each consumer is the Validation
chain of `js-contracts-schemas`. This page is the library itself.

| Entry | Exports |
| --- | --- |
| `@alexify/metaschema` | `Schema`, `Model`, `SchemaDefinitionError`, `SchemaUsageError`, `ValidationResult`, `KIND` and kind helpers |
| `/generators` | `toJSONSchema`, `toTypeScript`, `saveTypes`, `fromJSONSchema`, `register` |
| `/derive` | `pick`, `omit`, `partial`, `required`, `extend`, `keyof`, `register` |
| `/mongodb` | `types`, `register`, `toDocument`, `fromDocument`, `fromDocumentAsync`, `indexesOf`, `checkUpdate`, `toUpdate` |
| `/formats` | `FORMATS`, `register` |
| `/coerce` | `COERCIONS`, `coerce`, `register` |
| `/compile` | `compile`, `compiled`, `register`, `canEval` (JIT backend) |
| `/model` | `fromJSON`, `diff`, `compatibility`, `compatibilityOf`, `sample`, `merge`, `infer`, `register` |
| `/stream` | `checkEach`, `parseEach`, `checkEachAsync`, `parseEachAsync`, `transform`, `register` |
| `/definition` | the definition language without validation, both error classes |
| `/locales/en`, `/locales/uk` | messages: `check(value, { messages: uk })` |

There is no `toZod` and no `toTypeBox`.

## When to choose it

Every shape that crosses a boundary. Do not hand-write a Zod, TypeBox or Ajv schema as a source.
Those stay adapters generated from the definition, at the place a tool needs them.

## Definition language

```js
const { Schema } = require('@alexify/metaschema');
const { register } = require('@alexify/metaschema/formats');

register();

const SignUp = new Schema('SignUp', {
  login: { type: 'string', length: { min: 3, max: 64 } },
  email: { type: 'string', format: 'email', length: { max: 254 } },
  role: { enum: ['admin', 'user'], default: 'user' },
  'age?': { type: 'integer', min: 18, max: 150 },
  tags: { array: 'string' },
  address: { city: 'string', 'zip?': 'string' },
});
```

| Syntax | Meaning |
| --- | --- |
| `'string'`, `'number'`, `'integer'`, `'bigint'`, `'boolean'`, `'date'`, `'bytes'`, `'null'`, `'any'`, `'unknown'`, `'json'` | scalars, the full list of 4.0.0 |
| `'?string'`, `'key?': 'string'` | optional, accepts `null` and an absent key |
| `{ type: 'string', nullable: true }` | required, accepts `null` |
| `{ enum: [...] }`, `{ flags: [...] }` | enumeration, named booleans |
| `{ array: T }`, `{ set: T }`, `{ object: { string: T } }`, `{ map: { string: T } }`, `[A, B]` | collections and tuples |
| `{ union: [A, B], discriminator: 'type' }` | union |
| `length`, `min`, `max`, `pattern`, `format`, `decimals`, `default` | rules and annotations |
| `validate`, `parse`, `serialize` | a custom rule, a decoder, an encoder |

The scalars are checked against `ScalarName` of `index.d.ts` 4.0.0, in its order. `'null'` accepts
`null` only. `'any'` and `'unknown'` are one type under two names and differ only in the TypeScript
they render.

Kinds are the first key of a model entity. Stored, with an id: `Entity`, `Registry`, `Dictionary`,
`Journal`, `Details`, `Relation`, `View`. Memory: `Struct`, `Scalar`, `Form`, `Projection`.

## check, parse, Standard Schema

| | `check` | `parse` | `~standard.validate` |
| --- | --- | --- | --- |
| Returns | `{ valid, issues, errors }` | `{ valid, value, issues }` | `{ value }` or `{ issues }`, a promise of it when a validator is `async` |
| Defaults, decoders | no | yes | yes |
| Coercion | never | `{ coerce: true }` | schema metadata or `libraryOptions` |
| `unknown` | `reject`, `ignore` | also `strip` | schema metadata or `libraryOptions` |

```js
const { valid, value, issues } = SignUp.parse(body, { unknown: 'strip' });
```

An issue is `{ code, path, message, params }`. Async validators need `checkAsync` or `parseAsync`.
The synchronous calls throw `ALX_ERR_ASYNC_VALIDATOR`. `~standard.validate` returns a promise when
a validator, a decoder or a `checkType` is an `async function`; a plain function that returns a
promise makes it throw `ALX_ERR_ASYNC_VALIDATOR` too.

`validate` returns `true`, `null` or `undefined` for a valid value; `false` (a `custom` issue), an
error text, `{ code, message, path?, params? }`, a list of those or a `ValidationResult` for an
invalid one. What it throws becomes an `exception` issue whose message carries the thrown text.

### At a trust boundary

| Option or method | What it does |
| --- | --- |
| `maxErrors` | stops collecting after that many issues. **No limit by default**: 1,000 wrong items give 1,000 issues. Pair it with `length.max` on arrays, which also bounds the async validators a walk starts |
| `maxDepth` | how deep embedded references nest (128 by default): deeper is a `depth` issue |
| `root` | the label the error lines start with: the schema name by default, `''` for none |
| `references` | `'kind'` (a stored target as an id, a memory target as the record), `'embed'` or `'id'` |
| `messages` | a locale (`/locales/uk`) or a function that renders every issue |
| `result.flatten()`, `result.tree()` | `{ formErrors, fieldErrors }` and a nested tree, for forms |

Map an `exception` issue to 500 or a generic text: its message may hold a driver's error.

## Errors

| Class | Thrown when | Codes |
| --- | --- | --- |
| `SchemaDefinitionError` | a definition is broken (`new Schema`, `new Model`), or cannot be rendered or compiled | 31, `DefinitionErrorCode` |
| `SchemaUsageError`, a `TypeError` | a call is wrong | `ALX_ERR_ASYNC_VALIDATOR`, `ALX_ERR_INVALID_TARGET`, `ALX_ERR_INVALID_OPTION`, `ALX_ERR_INVALID_RECORD`, `ALX_ERR_NOT_REGISTERED`, `ALX_ERR_UNSUPPORTED_RUNTIME` (`RuntimeErrorCode`) |

- Every code starts with `ALX_ERR_` since 4.0, and the name after the prefix is the 3.x one:
  `ERR_INVALID_RULE` is `ALX_ERR_INVALID_RULE`. A search for `'ERR_` finds the comparisons to
  change. Match on `code`, or on `instanceof TypeError`, which held in 3.x too.
- A wrong option of any call is `ALX_ERR_INVALID_OPTION`. `ALX_ERR_INVALID_OPTIONS` is only the
  metadata of a definition.
- Both classes take `(message, options = {})` with `code` and the standard `cause` in `options`,
  as every Alexis error does.
- `ALX_ERR_INVALID_RECORD` carries `index`, `record` and `result`: the record is input, so never
  log the error raw.
- Check and parse issues keep their codes (`unexpected`, `required`, `length`): only thrown errors
  changed.

## Gotchas

- **The generators are not in the core entry since 3.0.** Without `register()` of `/generators`,
  `model.dts` is `undefined` and `schema.toInterface` is not a function. Prefer the functions:
  `toTypeScript(model)`.
- **The error line starts with the schema name.** An unknown key at the root of `Login` is
  `Field "Login" has unexpected keys: isAdmin`, code `unexpected`; `""` only for `Schema.from` or
  `{ root: '' }`. The issue's own `message` has no label. Match on `issue.code`, never on text.
- **`format` needs `register()`** of `/formats`, or building the schema throws
  `ALX_ERR_INVALID_RULE`.
- **`coerce: true` needs `register()`** of `/coerce`, or the first `parse` throws
  `ALX_ERR_NOT_REGISTERED`. So does `fromDocument`, which parses with `coerce: true` by default:
  register `/coerce` or pass `{ coerce: false }`.
- `~standard.validate` is `parse` since 3.0, so it applies defaults and decoders.
- A required field with a `default` stays in `required` of the JSON Schema. A validator without
  `useDefaults` rejects the input `parse` accepts.
- `Infer` is the input side (`age?: number | null`), `toTypeScript` writes `age?: number` and a
  defaulted key as required. Use `Infer` for inputs and `InferOutput` for parsed values.
- Types are registered per process. Give models that conflict their own registry with the
  **fourth** argument: `new Model(types, entities, null, { registry: 'isolated' })`. Passed third,
  the options become `model.database` and the registry stays shared.
- A first key that names a type reads as a type definition, not a struct. Start the struct with
  `Struct: {}` or use `{ schema: ... }`. With `discriminator: 'type'`, a union branch whose first
  key is `type` reads as the long form of a field and fails: start each branch with `Struct: {}`.
- **A kind is a kind name holding a plain object** since 3.4.1: a capital letter, then letters and
  digits with at least one lowercase (`Entity: {}`, `Settings: { ... }`). Upper-case keys
  (`DATABASE_URL`, `PORT`) are fields, for the runtime and for `Infer`, and so is a list, a
  `Schema`, a built field or a function under a kind name. Up to 3.4.0 every capitalized first key
  was a kind and was dropped silently. Require `^4.0.0`.
- **A PascalCase key holding a nested struct is still a kind**: `{ Address: { street: 'string' },
  name: 'string' }` loses `Address`, and only `schema.warnings` (`ambiguous-kind`) says so. Put
  `Struct: {}` first.
- `schema.warnings` and `model.warnings` list what the definition accepts but probably did not
  mean: `ambiguous-kind`, `unbounded-pattern`, `missing-reference`. Assert them empty in a test.
- `partial` drops defaults so a patch does not overwrite stored values; `defaults: true` keeps
  them and `keys` limits it to some fields. It is shallow unless `deep: true`, which stops at
  collections, tuples, unions and references.
- `partial` is not the shape of a MongoDB `$set`. Use `checkUpdate`.
- Give every `pattern` a `length.max`. A pattern or format is not run past that bound, which is the
  ReDoS guard.
- `validate` functions, indexes and calculated fields are not exported to JSON Schema, and
  `decimals` needs `multipleOfPrecision` in Ajv. `bigint` makes `toJSONSchema` throw
  `ALX_ERR_UNREPRESENTABLE`; `unrepresentable: 'any'` renders `{}`, and the mongodb target writes
  `bsonType: 'long'`.

## Streams and the compiler

- `/stream` checks a sequence record by record: `checkEach`, `parseEach` and their async pair,
  which takes `concurrency` (1 by default), and `transform`, a stream that drops an invalid record
  through `onInvalid` or ends with `ALX_ERR_INVALID_RECORD`. `maxInvalid` (no limit by default)
  ends either after that many invalid records.
- `/compile` generates the check with `new Function`. `jit: 'auto'`, the default, keeps the
  closures **silently** under `--disallow-code-generation-from-strings`, which `node-security`
  recommends: `compiled(schema)` or `canEval()` says which runs, and `jit: true` throws
  `ALX_ERR_NO_EVAL` instead.

Related skills: `js-contracts-schemas`, `node-data-access`
