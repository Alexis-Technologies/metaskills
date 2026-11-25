# Packaging a library

Reference for `node-modules-packages`, Library profile: what an `@alexify` package ships and the
tests that hold it to that. The release steps, the tarball smoke test among them, are in the
`npm-publish` skill.

## package.json

```json
{
  "name": "@alexify/example",
  "version": "1.0.0",
  "type": "commonjs",
  "main": "index.js",
  "types": "index.d.ts",
  "browser": { "./src/platform.js": "./src/platform.browser.js" },
  "exports": {
    ".": { "types": "./index.d.ts", "default": "./index.js" },
    "./codec": { "types": "./src/codec/index.d.ts", "default": "./src/codec/index.js" },
    "./package.json": "./package.json"
  },
  "sideEffects": false,
  "files": ["index.js", "index.d.ts", "src", "!**/CLAUDE.md", "README.md", "CHANGELOG.md", "LICENSE"],
  "engines": { "node": ">=22.18.0" },
  "publishConfig": { "access": "public" }
}
```

- `"type": "commonjs"` is Node's default, stated for Deno, which reads a `.js` file as an ES module
  without it. An older library that omits it is CommonJS on Node; adding it changes nothing there.
- `"sideEffects": false`: no module does work on load, so a bundler drops what the consumer does
  not import. A module that must run on load is listed instead (`"sideEffects": ["./src/x.js"]`).
- `files` is an allowlist and ends with `!**/CLAUDE.md`, so the notes for agents in `src/` stay
  out of the tarball. A test (or `check:pack`) reads npm's packing list to prove it.

## Hosts and peers

A host (Fastify, the MongoDB driver, Redis, BullMQ, a WebSocket server) is injected by the caller
and checked by shape, never by `instanceof` against a class the library imports: the consumer's
copy of the class is not the one the library would load, and `src/` requires no host.

```js
const isRedis = (client) =>
  typeof client === 'object' &&
  client !== null &&
  typeof client.get === 'function' &&
  typeof client.set === 'function';

const createCache = ({ redis }) => {
  if (!isRedis(redis)) {
    throw new CacheError('redis needs get() and set()', { code: 'ALX_ERR_INVALID_REDIS' });
  }
  return { get: (key) => redis.get(key) };
};
```

`CacheError` is the library's own class with a `code` (`error-handling`). A library declares a peer
only for a package it requires lazily (on first use, never at load time) or takes from the caller,
and marks it optional in `peerDependenciesMeta` when most consumers never use it. migronaut
requires `mongodb` on first use and takes `mongoose` from the caller as an optional peer; syncom's
editor packages are optional peers the caller injects. Libraries such as wrpc, mailer and
protoarray declare none. A lazy require:

```js
let bson = null;

const getBson = () => {
  bson ??= require('mongodb').BSON;
  return bson;
};
```

## Barrels list exports by name

```js
// src/index.js
const { createCache } = require('./cache.js');
const { parse, format } = require('./codec/index.js');

module.exports = { createCache, parse, format };
```

Never `module.exports = { ...cache, ...codec }`. Node gives an ESM consumer its named imports
through cjs-module-lexer, which reads only the names it sees in the source: with spread objects,
`import { parse } from '@alexify/example'` fails with "Named export 'parse' not found".

## Export parity

The runtime exports and the handwritten `.d.ts` drift apart silently. A test holds them equal:

```js
// tests/unit/export-parity.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lib = require('../../index.js');

const VALUE = /^export (?:declare )?(?:const|let|function|class) (\w+)/gm;

const declaredValues = (file) => {
  const names = new Set();
  for (const match of fs.readFileSync(file, 'utf8').matchAll(VALUE)) names.add(match[1]);
  return names;
};

describe('export parity', () => {
  it('should export at runtime exactly the values index.d.ts declares', () => {
    const declared = declaredValues(path.join(__dirname, '../../index.d.ts'));
    assert.deepEqual(new Set(Object.keys(lib)), declared);
  });
});
```

Run the same check for every entry of the `exports` map, so a new subpath is covered as soon as it
is declared. Types (`interface`, `type`) have no runtime value and stay out of the comparison.

## A consumer type test under nodenext

tsd and `check:dts` compile the `.d.ts` files by path and never read the `exports` map: a `types`
condition that points at a missing file, or a subpath without one, passes both. A consumer type
test imports the package by name under `module: nodenext`, the strictest resolution:

```ts
// tests/consumer/esm.mts
import { createCache } from '@alexify/example';
import { parse } from '@alexify/example/codec';

createCache({ redis: { get: async () => null, set: async () => 'OK' } });
parse('{}');
```

`tests/consumer/tsconfig.json` sets `"module": "nodenext"`, `"moduleResolution": "nodenext"`,
`"strict": true`, `"noEmit": true` and `"types": ["node"]`, and the gate runs
`tsc -p tests/consumer`. The package resolves itself by name through its `exports`; a `.mts` file
checks the ESM consumer, a `.cts` one the CommonJS consumer. The bundler resolution is checked
against the tarball (`npm-publish`).

## Platform pairs

Code that differs between Node and a browser is a pair of files with the same exports,
`src/platform.js` and `src/platform.browser.js`, and the rest of `src/` requires `./platform.js`.
The browser file is chosen by `package.json#browser` (a map, for bundlers that read the field) and,
for an entry, by the `browser` export condition:

```json
{
  "browser": { "./index.js": "./browser.js", "./src/platform.js": "./src/platform.browser.js" },
  "exports": {
    ".": { "types": "./index.d.ts", "browser": "./browser.js", "default": "./index.js" }
  }
}
```

No `typeof window` branches in one file: a bundler cannot drop the Node half. A test compares the
export names of the two files.

## Size budgets

`scripts/size.js` bundles every entry of `exports` (esbuild, minified and gzipped) and fails over
the entry's row in `scripts/size-budgets.json`, and on an entry without a row. A budget is raised
only in the change that needs it, with the reason in that change, never ahead of time.

## A new subpath

One change brings all of it:

1. The entry `src/<subpath>/index.js`, listing its exports by name.
2. Its `.d.ts` beside it, `src/<subpath>/index.d.ts`.
3. The `exports` entry, `types` first: `"./<subpath>": { "types": …, "default": … }`.
4. A row in `scripts/size-budgets.json`.
5. A tsd file, `tests/types/<subpath>.test-d.ts`.

Export parity, the consumer type test and the size script read the `exports` map, so they pick
the subpath up once it is declared.
