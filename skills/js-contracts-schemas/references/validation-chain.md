# The Validation chain, consumer by consumer

One `@alexify/metaschema` definition, every consumer generated from it. The code below ran on
Node.js 24 with metaschema 3.4.0, Fastify 5.8, Ajv 8.20, TypeBox 0.34, `@fastify/swagger` 9.7,
wrpc 2.2.0, the mongodb 7.3 driver and vee-validate 4.15.

## The shared contract

```ts
// contracts/sign-up.ts
import { Schema } from '@alexify/metaschema';
import type { InferSchema } from '@alexify/metaschema';
import { register as registerCoercion } from '@alexify/metaschema/coerce';
import { pick } from '@alexify/metaschema/derive';
import { register as registerFormats } from '@alexify/metaschema/formats';

registerFormats();
registerCoercion();

export const SignUp = new Schema('SignUp', {
  login: { type: 'string', length: { min: 3, max: 64 } },
  email: { type: 'string', format: 'email', length: { max: 254 } },
  role: { enum: ['admin', 'user'], default: 'user' },
  'age?': { type: 'integer', min: 18, max: 150 },
  price: { type: 'number', decimals: 2 },
});

export type SignUpInput = InferSchema<typeof SignUp>;
export const AccountView = pick(SignUp, ['login', 'role'], { name: 'AccountView' });
```

`format` and `coerce` work only after their `register()`: a missing one throws `ERR_INVALID_RULE`
when the schema is built, or `ERR_NOT_REGISTERED` on the first coercing `parse`.

## What was checked

Eleven fixtures (valid, default applied, unknown key, short login, bad email, bad enum, missing
field, non-integer, below minimum, too many decimals) through each consumer:

| Consumer | Agrees with `parse` |
| --- | --- |
| Fastify with the metaschema compiler | 11/11 |
| Fastify with its **default** Ajv over `toJSONSchema` | **7/11** |
| Fastify Ajv with the settings below | 11/11 |
| Ajv 2020 directly | 11/11 |
| TypeBox `Type.Unsafe` through that Ajv | 11/11 |
| wrpc `input` over WebSocket | 11/11 |
| A Standard Schema consumer | 11/11 |
| vee-validate 4.15 through the adapter below | 11/11 |
| vee-validate 4.15 given the raw `Schema` | **accepts invalid input** |

The default Ajv of Fastify differs on two things. `removeAdditional: true` deletes an unknown key and
answers 200 where the contract says 400, and `multipleOf: 0.01` rejects `19.99`.

## Backend: Fastify validator compiler (recommended)

```ts
// plugins/validation.ts
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifySchemaCompiler } from 'fastify';
import type { Schema, ValidationIssue } from '@alexify/metaschema';

const TEXT_PARTS = ['querystring', 'params', 'headers'];

const toError = (issues: readonly ValidationIssue[]) => {
  const error = new Error('Validation failed') as Error & Record<string, unknown>;
  error.statusCode = 400;
  error.code = 'EVALIDATION';
  error.validation = issues;
  return error;
};

export const metaschemaCompiler: FastifySchemaCompiler<Schema> = ({ schema, httpPart }) => {
  const part = httpPart ?? '';
  const coerce = TEXT_PARTS.includes(part);
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

- The handler receives the parsed value, with defaults applied.
- Query, path and header values are text, so those parts coerce. A body never does.
- Headers carry keys no schema lists, so unknown keys are ignored there and rejected elsewhere.
- A `Schema` that reaches the default compiler fails loudly at `ready()`. A compiler is per
  encapsulation context: register this one through `fastify-plugin`.

Response schemas go to the serializer, which reads JSON Schema. It writes only declared keys:

```ts
const response = { 200: toJSONSchema(AccountView, { target: 'draft-07', io: 'output' }) };
app.post('/signup', { schema: { body: SignUp, response } }, handler);
```

## Ajv at route level (alternative)

Use it only where the built-in path does not fit, and say why in the code.

```ts
// Ajv here: this partner route needs a keyword the shared contract must not carry.
const ajv = new Ajv({ multipleOfPrecision: 9, useDefaults: true, coerceTypes: false, removeAdditional: false });
addFormats(ajv);
const isNotAdmin = (enabled: boolean, text: string) => !enabled || text !== 'admin';
ajv.addKeyword({ keyword: 'noAdminLogin', type: 'string', validate: isNotAdmin });

const body = toJSONSchema(SignUp, { target: 'draft-07' }) as Record<string, any>;
const login = { ...body.properties.login, noAdminLogin: true };
body.properties = { ...body.properties, login };

const validatorCompiler = ({ schema }) => ajv.compile(schema);
app.post('/partner', { schema: { body }, validatorCompiler }, handler);
```

- Use `target: 'draft-07'` with Fastify's Ajv. The default 2020-12 document throws
  `no schema with key or ref` at `ready()`. For 2020-12 use `ajv/dist/2020`.
- `multipleOfPrecision` is required for `decimals`. `removeAdditional: false` keeps the rejection of
  unknown keys. `useDefaults: true` is needed because a defaulted key stays in `required`.
- **An extension lives in the adapter** (`addKeyword` on a generated copy, as above) and never
  changes the source.

## TypeBox (wrapper only)

There is no generator. `Type.Unsafe` wraps the generated JSON Schema so TypeBox-typed code can hold it:

```ts
const SignUpBody = Type.Unsafe<SignUpInput>(toJSONSchema(SignUp, { target: 'draft-07' }));
app.post('/boxed', { schema: { body: SignUpBody }, validatorCompiler }, handler);
```

Ajv reads it as plain JSON Schema. **TypeBox's own checkers do not:** `Value.Check` and
`TypeCompiler.Compile` throw `Unknown type` on it. Use it only where Ajv validates.

## OpenAPI

```ts
const toOpenApi = (part: unknown) => {
  return part instanceof Schema ? toJSONSchema(part, { target: 'openapi-3.0' }) : part;
};

const PARTS = ['body', 'querystring', 'params', 'headers'];

const transform = ({ schema, url }) => {
  const next = { ...schema };
  for (const key of PARTS) {
    if (next[key]) next[key] = toOpenApi(next[key]);
  }
  return { schema: next, url };
};

await app.register(swagger, { openapi: { info: { title: 'api', version: '1.0.0' } }, transform });
```

`@fastify/swagger` crashes with `Maximum call stack size exceeded` on a raw `Schema`, so the
`transform` is required. A defaulted key is listed in `required`, so a generated client sends it.

## MongoDB

```js
const mongodb = require('mongodb');
const { Model } = require('@alexify/metaschema');
const bson = require('@alexify/metaschema/mongodb');
const { toJSONSchema } = require('@alexify/metaschema/generators');

bson.register({ bson: mongodb });

const accountDefinition = {
  Entity: {},
  login: { type: 'string', unique: true, length: { min: 3, max: 32 } },
  company: 'Company',
  visits: { type: 'integer', default: 0 },
  v: { type: 'integer', default: 1 },
  rev: { type: 'integer', default: 0 },
};
const companyDefinition = { Registry: {}, name: { type: 'string', unique: true } };
const entries = [['Company', companyDefinition], ['Account', accountDefinition]];
const model = new Model({ ...bson.types }, entries);
const Account = model.entities.get('Account');

const validators = toJSONSchema(model, { target: 'mongodb', ids: 'objectId' });
const indexes = bson.indexesOf(model);

const insertAccount = async (db, body) => {
  const { valid, value, issues } = Account.parse(body);
  if (!valid) return { issues };
  const { insertedId } = await db.collection('Account').insertOne(bson.toDocument(Account, value));
  return { accountId: insertedId.toHexString() };
};

const renameAccount = async (db, _id, rev, login) => {
  const update = { $set: { login }, $inc: { rev: 1 } };
  const { valid, errors } = bson.checkUpdate(Account, update);
  if (!valid) return { errors };
  const result = await db.collection('Account').updateOne({ _id, rev }, bson.toUpdate(Account, update));
  return { isConflict: result.matchedCount === 0 };
};
```

- The validator is closed. Declare `v`, `rev` and the timestamps in the model, or the database
  refuses what the DAL writes, and `fromDocument` reports an unexpected key.
- Install the validators and indexes through `migronaut` (see `alexis-libraries`).
- `toDocument` moves the id to `_id` and turns references into ObjectIds. A body that carries `_id`
  fails `parse` with `unexpected`.
- `checkUpdate` validates the operators. What depends on the stored document is the validator's.

Not run: a live `$jsonSchema` validator, since no MongoDB server was available. The generated
documents, `toDocument`, `fromDocument`, `indexesOf`, `checkUpdate` and `toUpdate` ran with the real
driver's BSON types.

## wrpc

A `Schema` is a Standard Schema, so it goes straight into `input` and `output`:

```js
const signUp = procedure({ access: 'public', input: SignUp, handler: createAccount });
```

A failure answers code 400 with `error.details.issues`. Defaults reach the handler.

## Frontend

Standard Schema, with no generated code. TanStack Form and other consumers of the specification take
the schema as it is (from the metaschema docs, not run here):

```ts
useForm({ defaultValues: { login: '' }, validators: { onChange: SignUp } });
```

**vee-validate 4.15 does not read `~standard`.** Given the raw `Schema` it reports invalid input as
valid. Use a small adapter:

```ts
const toVeeSchema = (schema) => ({
  __type: 'VVTypedSchema',
  async parse(values) {
    const result = await schema['~standard'].validate(values);
    if (!result.issues) return { value: result.value, errors: [] };
    const errors = [];
    for (const issue of result.issues) {
      errors.push({ path: issue.path.join('.'), errors: [issue.message] });
    }
    return { errors };
  },
});

const form = useForm({ validationSchema: toVeeSchema(SignUp) });
```

**Zod** is for the frontend only and needs a `toZod` generator, which does not exist yet. Until it
does, do not write a Zod schema by hand as a second source.

## TypeScript

```ts
type SignUpInput = InferSchema<typeof SignUp>; // what parse accepts
type SignUpValue = InferOutput<typeof definition>; // what parse returns
```

`toTypeScript(schema)` writes an interface for a generated `.d.ts`. It is the stored shape: a key with
a default is required and an optional key is `age?: number`. `Infer` is the input side, where the same
key is optional and may be `null`. Use `Infer` for request types.

## What does not cross

| Rule | In JSON Schema |
| --- | --- |
| `validate` functions | not exported: `check` and `parse` still apply them |
| `decimals` | `multipleOf`, needs `multipleOfPrecision` in Ajv |
| `bigint` | `ERR_UNREPRESENTABLE`, except `long` for the mongodb target |
| A key with a `default` | stays in `required` |
| `length` | counts UTF-16 units unless `unicode: true` |
