# @alexify/metaschema

The single source of truth for data shapes: validation, types, JSON Schema, OpenAPI, MongoDB
validators and Standard Schema from one definition. Version 3.4.1, tag `v3.4.1`, Node.js 18+, no
runtime dependencies, browser build. How the definition reaches each consumer is the Validation
chain of `js-contracts-schemas`. This page is the library itself.

| Entry | Exports |
| --- | --- |
| `@alexify/metaschema` | `Schema`, `Model`, `SchemaDefinitionError`, `ValidationResult`, `KIND` and kind helpers |
| `/generators` | `toJSONSchema`, `toTypeScript`, `saveTypes`, `fromJSONSchema`, `register` |
| `/derive` | `pick`, `omit`, `partial`, `required`, `extend`, `keyof`, `register` |
| `/mongodb` | `types`, `register`, `toDocument`, `fromDocument`, `fromDocumentAsync`, `indexesOf`, `checkUpdate`, `toUpdate` |
| `/formats` | `FORMATS`, `register` |
| `/coerce` | `COERCIONS`, `coerce`, `register` |
| `/compile` | `compile`, `compiled`, `register`, `canEval` (JIT backend) |
| `/model` | `fromJSON`, `diff`, `compatibility`, `compatibilityOf`, `sample`, `merge`, `infer`, `register` |
| `/stream` | `checkEach`, `parseEach`, `checkEachAsync`, `parseEachAsync`, `transform`, `register` |
| `/definition` | the definition language without validation |
| `/locales/en`, `/locales/uk` | messages |

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
| `'string'`, `'number'`, `'integer'`, `'bigint'`, `'boolean'`, `'date'`, `'bytes'`, `'null'`, `'any'`, `'unknown'`, `'json'` | scalars, the full list of 3.4.1 |
| `'?string'`, `'key?': 'string'` | optional, accepts `null` and an absent key |
| `{ type: 'string', nullable: true }` | required, accepts `null` |
| `{ enum: [...] }`, `{ flags: [...] }` | enumeration, named booleans |
| `{ array: T }`, `{ set: T }`, `{ object: { string: T } }`, `{ map: { string: T } }`, `[A, B]` | collections and tuples |
| `{ union: [A, B], discriminator: 'type' }` | union |
| `length`, `min`, `max`, `pattern`, `format`, `decimals`, `default` | rules and annotations |
| `validate`, `parse`, `serialize` | a custom rule, a decoder, an encoder |

The scalars are checked against `ScalarName` of `index.d.ts` 3.4.1, in its order. `'null'` accepts
`null` only. `'any'` and `'unknown'` are one type under two names and differ only in the TypeScript
they render.

Kinds are the first key of a model entity. Stored, with an id: `Entity`, `Registry`, `Dictionary`,
`Journal`, `Details`, `Relation`, `View`. Memory: `Struct`, `Scalar`, `Form`, `Projection`.

## check, parse, Standard Schema

| | `check` | `parse` | `~standard.validate` |
| --- | --- | --- | --- |
| Returns | `{ valid, issues, errors }` | `{ valid, value, issues }` | `{ value }` or `{ issues }` |
| Defaults, decoders | no | yes | yes |
| Coercion | never | `{ coerce: true }` | schema metadata or `libraryOptions` |
| `unknown` | `reject`, `ignore` | also `strip` | schema metadata or `libraryOptions` |

```js
const { valid, value, issues } = SignUp.parse(body, { unknown: 'strip' });
```

An issue is `{ code, path, message, params }`. Async validators need `checkAsync` or `parseAsync`.
The synchronous calls throw `ERR_ASYNC_VALIDATOR`.

## Gotchas

- **The generators are not in the core entry since 3.0.** Without `register()` of `/generators`,
  `model.dts` is `undefined` and `schema.toInterface` is not a function. Prefer the functions:
  `toTypeScript(model)`.
- **Error text changed in 3.x.** An unknown key at the root is now
  `Field "" has unexpected keys: isAdmin`, code `unexpected`. Match on `issue.code`, never on text.
- **`format` needs `register()`** of `/formats`, or building the schema throws `ERR_INVALID_RULE`.
- **`coerce: true` needs `register()`** of `/coerce`, or the first `parse` throws `ERR_NOT_REGISTERED`.
- `~standard.validate` is `parse` since 3.0, so it applies defaults and decoders.
- A required field with a `default` stays in `required` of the JSON Schema. A validator without
  `useDefaults` rejects the input `parse` accepts.
- `Infer` is the input side (`age?: number | null`), `toTypeScript` writes `age?: number` and a
  defaulted key as required. Use `Infer` for inputs and `InferOutput` for parsed values.
- Types are registered per process. Use `{ registry: 'isolated' }` for models that conflict.
- A first key that names a type reads as a type definition, not a struct. Start the struct with
  `Struct: {}` or use `{ schema: ... }`.
- **A kind is a kind name holding an object** since 3.4.1: a capital letter, then letters and
  digits with at least one lowercase (`Entity: {}`, `Settings: { ... }`). Upper-case keys
  (`DATABASE_URL`, `PORT`) are fields, for the runtime and for `Infer`. Up to 3.4.0 every
  capitalized first key was a kind and was dropped silently, so an environment schema lost its first
  variable, and `Infer` left capitalized keys out. Require `^3.4.1`.
- `partial` drops defaults so a patch does not overwrite stored values. It is shallow unless
  `deep: true`.
- `partial` is not the shape of a MongoDB `$set`. Use `checkUpdate`.
- Give every `pattern` a `length.max`. A pattern or format is not run past that bound, which is the
  ReDoS guard.
- `validate` functions, indexes and calculated fields are not exported to JSON Schema, `decimals`
  needs `multipleOfPrecision` in Ajv, and `bigint` has no JSON form.

Related skills: `js-contracts-schemas`, `node-data-access`
