# @alexify/syncom

> **Not published.** `package.json` carries `0.0.1`, a development placeholder. There is no release
> and no tag, and the API may still change. Never advise installing it from npm, and never add it to
> a production dependency. `npm install @alexify/syncom` in its own docs describes a future release.

Local-first data engine: records on disk or in the browser, a hash-linked operation log, and
replication that converges without coordination (registers, counters, sets, lists, text, trees).
Node.js 24+ by `engines` (the README still says 22, the `engines` field and the install guide say
24). No runtime dependencies. Uses `'use strict'`, as wrpc does.

## When to consider it

- Offline-first clients, collaborative documents, peer-to-peer sync, tamper-evident logs.

Until it is released, use it only for experiments, through a workspace link or git dependency, with
the maintainer's agreement. For production today, keep the server authoritative: REST or `wrpc` over
the native driver, with the concepts in `js-local-first-sync`.

## Shape of the API

```js
const { createDatabase } = require('@alexify/syncom');

const main = async () => {
  const storage = await createDatabase({ path: 'data' });
  const id = await storage.insert({ name: 'Ada' });
  const record = await storage.document(id);
  record.on('update', (data, delta) => handleChange(delta));
  record.name = 'Ada Lovelace';
  await record.save();
  await storage.inc(id, 'hits', 1);
  await storage.validate({ last: 10 });
};
```

- `@alexify/syncom/all` is the core with every plugin registered. Plugins are per database.
- Storage engines: files, OPFS, IndexedDB (`/idb`), SQLite (`/sqlite`), MongoDB (`/mongodb`), memory.
- Schemas: a metaschema model, or any Standard Schema, validates writes.
- Transport is injected. `@alexify/syncom/wrpc` takes a `WrpcClient` you create.

## Known limits (from its README)

- A counter straddling a concurrent reset.
- Encrypted records stay local.
- No proof of key possession at `hello`.
- The wire `PROTOCOL` stays 1 until the first publication, so checkouts of different branches can
  refuse each other's operations.

Related skills: `js-local-first-sync`, `node-websocket-realtime`
