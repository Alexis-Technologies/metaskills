---
name: error-handling
description: Classify, wrap, retry and report errors in JS and Node.js, circuit breakers included. Use when code catches, retries or maps failures
---

# Error Handling

Treat errors as a designed data flow: classify every failure, wrap it once per
layer with `cause`, map it at one boundary to a safe transport error with an
error id, keep full context in logs, and choose an explicit process policy for
the unexpected. Shutdown mechanics live in `node-graceful-shutdown`.

## Project profile

|                   | Library (`@alexify/*`)                    | App                                         |
| ----------------- | ----------------------------------------- | ------------------------------------------- |
| Error type        | Its own class with an `ALX_ERR_` code     | `DomainError`, DAL errors                   |
| Logging           | Takes an injected logger, `logger: false` | Pino through `request.log`, at the boundary |
| Process handlers  | Never installs them                       | One policy in the composition root          |
| Transport mapping | None                                      | One Fastify `setErrorHandler`               |

- Invalid arguments and config of a library API throw the library's own class with a code too,
  never a bare `TypeError`. It may extend `TypeError` or `RangeError`, so `instanceof` keeps
  working for consumers.
- A library never logs on its own and takes an injected logger. Without one it may print
  important messages to `console`, and it offers `logger: false`, which silences even those.

Library classes, code unions, observers and a CLI inside a library:
[references/library-errors.md](references/library-errors.md).

## Classification

Decide before writing a `catch`.

| Kind | Examples | Mechanism | Handling |
| --- | --- | --- | --- |
| Bug | `TypeError`, `ReferenceError`, failed assertion | Let it throw | Never catch and continue. The boundary logs the stack and error id, the client gets a generic 500 |
| Operational | `ECONNREFUSED`, `ETIMEDOUT`, `EMFILE`, pool exhausted, disk full | Rejection from an I/O API | Recover where a strategy exists (retry, cache, replica). Otherwise wrap with `cause` and escalate |
| Domain | Out of stock, user not found, invalid input | Expected branch with `code` | Map to a status and safe message, log at `info` or `warn`, never restart |

- Recoverable means the state is known. An exception that reached the process
  level is not recoverable: collections may be half-mutated, transactions open,
  and handles leaked.
- Kinds chain: a domain error may be caused by an operational one, which may be
  caused by a bug.

## Error objects

- Throw and reject only `Error` instances: only they carry `stack` and `cause`.
- Put the machine-readable identity in `error.code`. Branch on `code`, never on
  `message` text.
- A string `code` we create always starts with `ALX_ERR_`, as Fastify's start
  with `FST_ERR_`: `ALX_ERR_VALIDATION`, `ALX_ERR_DAL_CONFLICT`. Codes of Node,
  the platform and third-party libraries stay as they are (`ENOENT`,
  `ECONNREFUSED`, `FST_ERR_*`, MongoDB `11000`).
- Every code a library can throw is a union in its `.d.ts` and a table in its
  docs, held by a test.
- A numeric status is `statusCode`, never `code`. Wire protocols may carry
  numeric codes on the wire: wrpc reads only a numeric `code`.
- Create one class per abstraction layer (`DomainError`, `DalError`), or when an
  error needs behaviour. Do not create one empty class per case.
- Every error class takes `(message, options = {})`, as `Error` does. `options`
  holds `cause` and the class's own fields (`code`, `details`, `statusCode`),
  and goes to `super` whole, so `cause` is set only when given.
- Chain, do not forward: when an error crosses a layer, create a new one in that
  layer's vocabulary with `{ cause }`. Keep chains to 2-4 levels.
- Create errors where they happen: the stack is captured at construction.
- Use `AggregateError(errors, message)` for independent causes: multi-field
  validation, retry attempts, closing many resources.
- Read causes from Node APIs: `fetch` rejects with `TypeError: fetch failed` and
  the real reason in `error.cause.code`.

```js
class DomainError extends Error {
  constructor(message, options = {}) {
    const { code = 'ALX_ERR_DOMAIN', details = null } = options;
    super(message, options);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

throw new DomainError('Login is taken', { code: 'ALX_ERR_CONFLICT', details: { login } });
```

## Return or throw

- Do not use Go-style `{ data, error }` or `[error, data]` as a cross-layer
  convention: it breaks the promise contract and drops automatic escalation.
  Wrap libraries that return such objects in an adapter that throws.
- Bugs and unexpected states throw. Expected business outcomes throw one
  `DomainError` class that the boundary maps.
- Result or Either types are fine inside one FP-style module or integration
  point. Do not thread them through handler, service, and repository.
- In hot system code (parsers, protocol loops, per-item library calls) prefer
  returning error values. In application code throwing is fine. Measure first.
- Fail fast: validate at the top of a function and leave immediately.

## Boundaries

- Map errors to the transport in exactly one place per entry point: Fastify
  error handler, RPC dispatcher, queue consumer, CLI `main`. Domain and data
  layers never know HTTP status codes.
- A known domain code becomes a status and safe message. Anything else becomes
  500 with `ALX_ERR_INTERNAL`, a generic message, and an `errorId` that is also
  logged.
- **Map only your own error classes.** DNS fails with `ENOTFOUND`, SMTP clients
  with `EAUTH`, and an `@alexify/*` library with `ALX_ERR_*` codes of its own, so
  a bare `code` lookup turns an outage into a 404.
- Never send `stack`, `cause`, queries, collection or field names, file paths,
  hostnames, or third-party messages to clients.
- Return one answer for "unknown user" and "wrong password", and spend the same
  time on both.
- Serialize errors explicitly to `{ code, message, details }`.
  `JSON.stringify(error)` drops `message` and `stack`, and `structuredClone` and
  `postMessage` drop custom fields such as `code`.

Status tables, the `node:http` adapter, and crossing threads and services:
[references/boundaries.md](references/boundaries.md).

```ts
import { randomUUID } from 'node:crypto';

import fp from 'fastify-plugin';

import { DalError } from './dal/errors.ts';
import { DomainError } from './domain/errors.ts';

const HTTP_STATUS: Record<string, number> = {
  ALX_ERR_VALIDATION: 400,
  ALX_ERR_AUTH: 401,
  ALX_ERR_FORBIDDEN: 403,
  ALX_ERR_NOT_FOUND: 404,
  ALX_ERR_DAL_NOT_FOUND: 404,
  ALX_ERR_CONFLICT: 409,
  ALX_ERR_DAL_CONFLICT: 409,
  ALX_ERR_DAL_DUPLICATE_KEY: 409,
  ALX_ERR_LIMIT: 429,
  ALX_ERR_DAL_UNAVAILABLE: 503,
  ALX_ERR_DAL_TIMEOUT: 504,
};

// DAL messages name collections, so every mapped DAL code has its own text
const SAFE_MESSAGES: Record<string, string> = {
  ALX_ERR_AUTH: 'Incorrect login or password',
  ALX_ERR_DAL_NOT_FOUND: 'Not found',
  ALX_ERR_DAL_CONFLICT: 'Changed concurrently',
  ALX_ERR_DAL_DUPLICATE_KEY: 'Already exists',
  ALX_ERR_DAL_UNAVAILABLE: 'Service unavailable',
  ALX_ERR_DAL_TIMEOUT: 'Timed out',
};

const sendError = (reply, status, error) => reply.code(status).send({ error });

export default fp(async (fastify) => {
  fastify.setErrorHandler((error, request, reply) => {
    if (error.validation) {
      const failure = { code: 'ALX_ERR_VALIDATION', message: 'Invalid input' };
      return sendError(reply, 400, failure);
    }
    const isOwn = error instanceof DomainError || error instanceof DalError;
    const status = isOwn ? HTTP_STATUS[error.code] : undefined;
    if (status !== undefined) {
      const message = SAFE_MESSAGES[error.code] ?? error.message;
      return sendError(reply, status, { code: error.code, message });
    }
    // 503 keeps load shedding visible: @fastify/under-pressure raises it with Retry-After
    const isSafeStatus = error.statusCode < 500 || error.statusCode === 503;
    const isFramework = `${error.code}`.startsWith('FST_') && isSafeStatus;
    if (isFramework) {
      return sendError(reply, error.statusCode, { code: error.code, message: error.message });
    }
    const errorId = randomUUID();
    request.log.error({ err: error, errorId }, 'unhandled error');
    return sendError(reply, 500, { code: 'ALX_ERR_INTERNAL', message: 'Internal error', errorId });
  });
});
```

## Wrap per layer

```js
// Infrastructure: knows the driver, speaks DAL errors
const findByLogin = async (login) => {
  try {
    return await accounts.findOne({ login });
  } catch (error) {
    throw toDalError(error);
  }
};

// Hashed once at startup, so an unknown login costs the same as a wrong password
const DUMMY_HASH = await hashPassword(randomBytes(32).toString('base64url'));

// Application: speaks domain codes, one answer for both auth failures
const signIn = async ({ login, password }) => {
  const account = await findByLogin(login);
  const hash = account === null ? DUMMY_HASH : account.passwordHash;
  const isValid = await verifyPassword(password, hash);
  if (account === null || !isValid) {
    throw new DomainError('Wrong credentials', { code: 'ALX_ERR_AUTH' });
  }
  return createSession(account);
};
```

A driver failure now reaches the client as `500 { code: 'ALX_ERR_INTERNAL', errorId }`,
and the log holds the whole chain through `cause`.

## Async correctness

- Write `return await promise` inside `try`. Without `await` the `catch` never
  sees the rejection, `finally` runs before the promise settles, and the frame
  disappears from the async stack trace.
- Async stack traces follow `await` chains. They break at a missing `await`,
  `.then` callbacks, timers, callback APIs, and event listeners.
- Await or return every promise. For intentional fire-and-forget attach a
  `.catch` that logs.
- A `throw` inside a callback escapes the surrounding `try` and becomes
  `uncaughtException`. Use `node:timers/promises`, `fs/promises`, `events.once`,
  and `stream/promises`.
- Create emitters with `{ captureRejections: true }` when listeners are async,
  and always listen to `'error'` on emitters and streams.
- `Promise.all` rejects on the first failure and leaves the rest running. Use
  `allSettled` to keep partial results.
- Every wait needs a deadline: lock, semaphore, pool acquire, queue slot,
  outgoing call (`AbortSignal.timeout(ms)`). Release in `finally`.
- Diagnostics: `Error.captureStackTrace(error, factory)` hides helper frames,
  `--stack-trace-limit=50` while debugging, `--enable-source-maps` for
  TypeScript.

## Retry

Retry only operational failures that are safe to repeat, with a growing delay,
jitter, and a cap. Never retry bugs: they fail the same way and the error is lost.

```js
const { setTimeout: delay } = require('node:timers/promises');

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']);

const isTransient = (error) => TRANSIENT_CODES.has(error.code);

const retry = async (fn, options = {}) => {
  const { attempts = 3, delayMs = 100, maxDelayMs = 5000, isRetryable = isTransient } = options;
  const errors = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error)) throw error;
      errors.push(error);
      if (attempt + 1 === attempts) break;
      const ceilingMs = Math.min(maxDelayMs, delayMs * 2 ** attempt);
      await delay(Math.random() * ceilingMs);
    }
  }
  throw new AggregateError(errors, `Failed after ${errors.length} attempts`);
};
```

For user requests keep the total under the request timeout and fall back to a
cache when possible. MongoDB transactions retry on `TransientTransactionError`
labels instead of codes (`node-data-access`).

A dependency that keeps failing needs a circuit breaker around the retried call,
so requests fail fast instead of piling up:
[references/circuit-breaker.md](references/circuit-breaker.md).

## Process level

- An error that reaches `uncaughtException` or `unhandledRejection` is a bug in
  error handling. Default policy for shared-state servers: log it as fatal, start
  a graceful shutdown with a short drain (5-10 s), exit with code 1, and let the
  supervisor start a fresh process. Never keep serving.
- Since Node.js 15 an unhandled rejection crashes the process. A listener that
  only logs silently disables that crash.
- Without an `unhandledRejection` listener, rejections reach `uncaughtException`
  with `origin === 'unhandledRejection'`, so one handler covers both. Use
  `uncaughtExceptionMonitor` for telemetry that must not change behaviour.
- Count crashes and alert. A restart contains the problem and does not fix it.

```js
process.on('uncaughtException', (error, origin) => {
  logger.fatal({ err: error, origin }, 'process-level error');
  shutdown(origin, 1);
});
```

`shutdown` is the idempotent routine from `node-graceful-shutdown`. Under `fastify start`,
fastify-cli installs these handlers: do not add your own.

## Logging

- Structured, one event per line: `level`, `msg`, `requestId`, user or session
  ids (never names or credentials), operation, `code`, `errorId`, `durationMs`.
- Log an error once, at the boundary that handles it. Inner layers add context
  through `cause`.
- Propagate a correlation id to downstream services and into every record.
- Strip secrets, tokens, personal data, and absolute paths before writing.
- Logging can amplify an incident: aggregate repeats, sample, and make the level
  switchable at runtime.
- Observers (logger, telemetry, event listeners) never fail the operation they
  watch.

Record shape, retention, telemetry cost, and release safety nets:
[references/logging-telemetry.md](references/logging-telemetry.md).

## Anti-patterns

- An error handler that sends without `reply.code()`: the status of the route leaks into the
  error, a 201 when it is set from the response schema.
- `catch {}` or `catch { return null; }` around a bug: the state stays broken.
  Catch what you can handle, by `code`, and rethrow the rest.
- Logging and rethrowing at every layer: the same stack N times.
- `reply.code(500).send({ message: error.message, stack: error.stack })`: leaks
  queries, paths, and collection names.
- Different messages for "no such user" and "bad password": user enumeration.
- A user-controlled value in a file path or query without validation.
- `throw 'Not found'` or `reject({ status: 404 })`: no stack, no `cause`.
- Dozens of empty `XxxNotFoundError` classes: use one class per layer and `code`.
- `error.message.includes('duplicate key')`: branch on the driver code (`11000`
  in MongoDB), then wrap.
- `return somethingAsync()` inside `try`: the `catch` never runs.
- `process.on('unhandledRejection', console.error)` as the whole policy: the
  process keeps running with unknown state.
- Restarting on every domain or operational error: drops all users' connections.
- Logging per failed item in a hot loop: count and log once per batch.

## Checklist

- [ ] Every `catch` handles a specific `code`, wraps with `cause`, or is a boundary.
- [ ] Errors are `Error` instances with an `ALX_ERR_` `code`, one custom class per
      layer at most, each constructed as `new X(message, { code, cause, ... })`.
- [ ] Each entry point (HTTP, RPC, WebSocket, queue, cron, CLI) has one mapping
      function, and unknown errors become 500 with an `errorId`.
- [ ] Responses never contain stack, `cause`, queries, or paths. Auth failures are
      indistinguishable in content and timing.
- [ ] `return await` in `try`, no floating promises, no throws from callbacks.
- [ ] Retries only for safe operational failures, with backoff, jitter, and a cap.
- [ ] Process-level handlers log fatal and trigger shutdown with exit code 1.
- [ ] Logs are structured, carry `requestId` and `errorId`, and hold no secrets.

Related skills: `node-graceful-shutdown`, `node-data-access`, `node-async-context`,
`node-security`.
