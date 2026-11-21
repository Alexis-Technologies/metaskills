# @alexify/protoarray

Schema-based serialization that stays JSON: objects travel as positional arrays, and a schema shared
by both sides maps each position back to its key. Version 2.1.0, tag `v2.1.0`, Node.js 18+, no
runtime dependencies. Needs metaschema 3.4+ where schemas are defined. A client that receives
snapshots needs protoarray alone.

| Entry | Holds |
| --- | --- |
| `@alexify/protoarray` | `Schema`, `encode`, `decode`, `stringify`, `parse`, `encodeEach`, `decodeEach`, errors |
| `/registry` | `SchemaRegistry`, envelopes with a schema id |
| `/resolve` | reading old payloads by name across a breaking change |
| `/evolve` | `compatible`, `baseline`, `restore` |
| `/stream` | `stringifyLines`, `parseLines`, `stringifyStream`, `parseStream`, `stringifyItems`, `parseItems` |
| `/binary` | `toBinary`, `fromBinary` |
| `/standalone` | `toSource`, `runtime`: generated code without the library |

## When to choose it

- High-volume payloads where repeated keys dominate: feeds, realtime events, large lists.
- Both ends deploy a shared schema, or the client fetches snapshots.

Not for public APIs, where consumers expect named keys, not for debugging-heavy low-volume endpoints,
and not as a validator: validation stays with metaschema. Measure the payload before adding it.

## API

```js
const { Schema } = require('@alexify/protoarray');
const { Schema: Definition } = require('@alexify/metaschema');

const definition = new Definition('User', { id: 'number', name: 'string', 'email?': 'string' });
const User = Schema.from(definition);

User.encode({ id: 1, name: 'Ada' }); // [1, 'Ada']
User.decode([1, 'Ada']); // { id: 1, name: 'Ada', email: null }
User.stringify({ id: 1, name: 'Ada' }); // '[1,"Ada"]'
User.parse('[1,"Ada"]'); // the object, the wire checked
```

The client builds the same codec from the snapshot, without metaschema:

```js
reply.send(User.snapshot);
const ClientUser = Schema.from(await response.json());
```

With wrpc, pass a packet `codec` of `encode(packet)` and `decode(text)`. No official codec ships yet.
`docs/guide/wrpc.md` of protoarray holds a schema for the packets.

## Evolution rules

1. **A position is forever.** Append. Never insert, reorder or delete. Renaming is free.
2. A new field is optional, has a `default`, or is `json`.
3. Retire a field by keeping its slot and making it optional.
4. Safe type changes: required to optional, appending to an `enum` or `flags`. Adding or changing
   `decimals` is breaking.
5. Deploy decoders before encoders when appending enum values or union branches.
6. `delta` and `intern` change the wire of what they name.
7. Whether a reference travels as a record or an id is part of the wire.
8. **An `Entity` id is the last field.** A field appended to an entity takes the position of the id.
   Declare the id in the definition (`userId: '?string'`) and append after it.

A breaking change goes through `/resolve`, which reads old payloads by name.

## Gotchas

- **`encode` trusts its input.** `User.encode({ id: 'x', name: 'Ada' })` gives `['x', 'Ada']`. Check
  values with `User.source.check` before encoding where a producer can be wrong.
- `decode` checks by default and throws `DecodeError` with `code` and `path`.
- **A reordered definition decodes silently into the wrong keys** when the types still fit, as they
  do for two strings. Add a test that pins `User.toString()`, the canonical form, or use `/evolve`.
- A decoded object always carries every key, with `null` for what was missing.
- A definition metaschema refuses throws metaschema's `SchemaDefinitionError`. It is not an
  `instanceof` protoarray's class. Compare `name` and `code`.

Related skills: `js-contracts-schemas`, `node-websocket-realtime`
