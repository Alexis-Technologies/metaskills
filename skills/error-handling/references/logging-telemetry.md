# Logging, aggregation, telemetry, and release safety nets

Alexis apps log with Pino, through Fastify's `request.log` inside a request.
Libraries do not log: they take an injected logger when they need one.

## Record shape

One event per line. JSON in production, `pino-pretty` only in development.

```js
const record = {
  time: '2026-11-20T18:31:30.559Z',
  level: 'error',
  msg: 'Can not load profile',
  service: 'api',
  pid: 4121,
  reqId: 'abc-1', // correlation id, propagated
  processId: 'checkout-7f3', // business process id spanning services
  userId: 'ckv9x2', // ids only, never names, emails, or tokens
  operation: 'profile.get',
  code: 'EUNAVAILABLE',
  errorId: '69939c49-...', // also returned to the client
  durationMs: 812,
  err: { type: 'Error', code: 'EUNAVAILABLE', message: '...', stack: '...' },
};
```

Pass the error as `err`, so Pino's serializer records its type, message, stack,
and `cause` chain: `request.log.error({ err: error, errorId }, 'unhandled error')`.

Redact at the logger, so no call site can forget:

```js
const logger = pino({
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
});
```

## Levels

| Situation | Level |
| --- | --- |
| Bug reached a boundary, process-level error | `error` / `fatal`, with stack |
| Operational failure, will retry or fall back | `warn`, without repeated stacks |
| Operational failure after recovery is exhausted | `error` and an alert |
| Domain error (not found, validation) | `info` or `debug`, no stack |
| Security relevant (failed login, denied access, role change) | A separate audit stream |
| Every request (method, route, status, duration) | `info`, or an access stream |

## Correlation

- Accept `x-request-id` or W3C `traceparent` from the edge, otherwise generate
  an id. Return it in the response and pass it to every downstream call.
- Give business processes (checkout, payout) their own id spanning frontend and
  backend operations.
- Carry ids explicitly through a context object or with `AsyncLocalStorage`
  (`node-async-context`). A cheaper option: let errors escalate to the boundary,
  which already knows the session, user, and call, and log there.

## What not to log

- Passwords, tokens, cookies, API keys, full `Authorization` headers.
- Raw request bodies of auth, payment, or medical endpoints.
- Personal data beyond ids. Anonymize or use temporary ids.
- Absolute paths and home directories.

## Destinations and retention

- 12-factor: write the event stream to stdout and let the platform collect it.
- Security events go to an append-only external store the application cannot
  delete from. An attacker with shell access wipes local files.
- Retain by value:
  - code bugs: about a month, they are fixed fast;
  - domain and security errors (wrong passwords, id scanning): months to a year
    for investigations;
  - business events (payments, shipments): the system's lifetime or the legal
    retention policy.

## Aggregation and alerting

- Ship logs to one aggregation system. Frontend errors go to a backend endpoint
  first and carry the same correlation ids.
- Group by fingerprint (`code` plus the top application frame) and alert on
  rates, not single events.
- Never send unsanitized logs to external services, LLMs included.

## Telemetry cost

- Under an error storm, stack serialization and network shipping can be what
  overloads the process. Log less per error, aggregate repeats, sample debug
  logs, and batch shipping.
- Make the level switchable at runtime and load-test with each level.
- Flush on shutdown with `logger.flush()` before `process.exit`. Adding a
  `SIGINT` or `SIGTERM` listener removes Node's default exit on that signal, so
  the application must run its own shutdown and exit.

## Releases

| Practice | What it gives when a release is faulty |
| --- | --- |
| Blue-green | Switch traffic back to the old cluster at once |
| Canary | A small share of users meets the bug; watch the error rate per version |
| Rolling deploy | Instances replaced one by one; requires graceful shutdown |
| Feature toggle | Disable the faulty branch without a redeploy |
| Shadow deployment | New code gets mirrored traffic; only if contracts are unchanged |
| Rollback by version | Keep the previous version ready and route back |

- Tie releases to error telemetry: compare error rates per version and roll back
  on a threshold.
- Fallback chain for dependencies: another instance, a replica, a cache (rates
  for minutes, reference data for weeks), the previous deployed version.
