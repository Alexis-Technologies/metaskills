# Library errors, codes and observers

What an `@alexify/*` library throws, how its codes stay declared, and the rules
that keep watching code from breaking the code it watches.

## Its own class, with a code

```js
class ConfigError extends TypeError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ConfigError';
    this.code = 'ALX_ERR_CONFIG';
  }
}

class ClosedError extends Error {
  constructor(message = 'Client is closed', options = {}) {
    super(message, options);
    this.name = 'ClosedError';
    this.code = 'ALX_ERR_CLOSED';
  }
}

const createClient = (options = {}) => {
  const { timeoutMs = 5000 } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError('timeoutMs must be a positive integer');
  }
  let isClosed = false;
  const request = async (path) => {
    if (isClosed) throw new ClosedError();
    return send(path, { signal: AbortSignal.timeout(timeoutMs) });
  };
  const close = () => {
    isClosed = true;
  };
  return { request, close };
};
```

- Invalid arguments and config throw the library's own class, never a bare
  `TypeError`. Extending `TypeError` or `RangeError` keeps `instanceof` working
  for consumers that already check it.
- One class per failure the caller handles differently, not one per message.
- The constructor is `(message, options = {})`, as `Error`'s: `cause` and the
  class's own fields arrive in `options`, and a class with a fixed code sets it
  itself.
- Every string `code` starts with `ALX_ERR_`. Codes of Node and of other
  packages pass through unchanged, wrapped with `{ cause }` when they cross the
  library's API.

## Every code: a union, a table, a test

```ts
// index.d.ts
export type ErrorCode = 'ALX_ERR_CONFIG' | 'ALX_ERR_CLOSED';

export class ConfigError extends TypeError {
  readonly code: 'ALX_ERR_CONFIG';
}

export class ClosedError extends Error {
  readonly code: 'ALX_ERR_CLOSED';
}
```

| Code | Class | Thrown when |
| --- | --- | --- |
| `ALX_ERR_CONFIG` | `ConfigError` | an option is missing or invalid |
| `ALX_ERR_CLOSED` | `ClosedError` | a call arrives after `close()` |

The table lives in the docs. A test holds the source, the `.d.ts` and the docs
to one set of codes:

```js
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const CODE = /ALX_ERR_[A-Z_]+/g;

const codesIn = (file) => new Set(fs.readFileSync(file, 'utf8').match(CODE));

const codesInSource = () => {
  const codes = new Set();
  for (const name of fs.readdirSync('src', { recursive: true })) {
    if (!name.endsWith('.js')) continue;
    for (const code of codesIn(path.join('src', name))) codes.add(code);
  }
  return codes;
};

describe('error codes', () => {
  it('should declare and document every code the source throws', () => {
    const thrown = codesInSource();
    assert.deepEqual(codesIn('index.d.ts'), thrown);
    assert.deepEqual(codesIn('docs/errors.md'), thrown);
  });
});
```

A code is part of the API: renaming or removing one is a breaking change.

## Extra fields never shadow the standard ones

`name`, `message`, `stack`, `cause` and `code` mean the same on every error.
Extra data goes under `details` or a field of its own name:

```js
const toUpstreamError = (status, body) => {
  const error = new UpstreamError(`Upstream answered ${status}`);
  error.details = { status, body };
  return error;
};
```

Never `Object.assign(error, body)`: a `message` or `code` in a peer's body
would replace the library's own, and a `stack` would hide where it failed.

## Observers never fail the operation they watch

A logger, a telemetry hook, a metrics callback and an event listener watch an
operation. A full disk, a broken exporter or a throwing listener must not fail a
write that succeeded, so the library catches their failure at the call:

```js
const notify = (listeners, event, onObserverError) => {
  for (const listener of listeners) {
    try {
      const result = listener(event);
      if (typeof result?.then === 'function') result.then(undefined, onObserverError);
    } catch (error) {
      onObserverError(error);
    }
  }
};
```

- `onObserverError` reports or counts the failure. It never rethrows it into the
  operation.
- `emitter.emit()` calls listeners synchronously and throws what they throw.
  Emit from inside an operation only through such a guard, or after it settled.
- The same holds in an app: an audit sink that must block the operation is not
  an observer, it is a step of the operation (`node-access-control`).

## A CLI inside a library is an app

The library never installs process handlers and never calls `process.exit`.
Its CLI (`bin/*.js`) is an app around the library: it may install signal
handlers, call `process.exit`, print to the console and choose an exit code.

```js
#!/usr/bin/env node
// bin/tool.js: the app around the library API
const { run } = require('../src/cli.js');

const main = async () => {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  try {
    process.exitCode = await run(process.argv.slice(2), { signal: controller.signal });
  } catch (error) {
    process.stderr.write(`${error.code ?? 'ALX_ERR_INTERNAL'}: ${error.message}\n`);
    process.exitCode = 1;
  }
};

main();
```

Keep the CLI thin: parse arguments, call the API, map errors to an exit code in
one place. The code under it keeps the library rules, so the same API works when
it is imported.
