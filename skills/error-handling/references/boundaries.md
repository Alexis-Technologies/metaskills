# Error boundaries and transport mapping

One mapping function per entry point turns any error into a safe transport
error. Domain code produces codes. The boundary owns statuses, messages, logging,
and error ids.

## Code to transport

| Situation | Code (example) | HTTP | JSON-RPC 2.0 | gRPC |
| --- | --- | --- | --- | --- |
| Malformed input, schema violation | `ALX_ERR_VALIDATION` | 400 (422 if the API uses it) | -32602 | INVALID_ARGUMENT |
| Not authenticated, bad credentials | `ALX_ERR_AUTH` | 401 | app code | UNAUTHENTICATED |
| Authenticated but not allowed | `ALX_ERR_FORBIDDEN` | 403, or 404 to hide existence | app code | PERMISSION_DENIED |
| Entity absent | `ALX_ERR_NOT_FOUND` | 404 | app code | NOT_FOUND |
| Duplicate, version conflict | `ALX_ERR_CONFLICT` | 409 | app code | ALREADY_EXISTS / ABORTED |
| Business rule (stock, limits, state) | `ALX_ERR_PRECONDITION` | 409 or 422 | app code | FAILED_PRECONDITION |
| Rate limit, quota | `ALX_ERR_LIMIT` | 429 with `Retry-After` | app code | RESOURCE_EXHAUSTED |
| Body too large | `ALX_ERR_TOO_LARGE` | 413 | app code | RESOURCE_EXHAUSTED |
| Overloaded, shutting down, circuit open | `ALX_ERR_UNAVAILABLE` | 503 with `Retry-After` | -32000..-32099 | UNAVAILABLE |
| Dependency timeout | `ALX_ERR_TIMEOUT` | 504 | -32000..-32099 | DEADLINE_EXCEEDED |
| Unknown method or route | - | 404 / 405 | -32601 | UNIMPLEMENTED |
| Unparsable packet | - | 400 | -32700 | INVALID_ARGUMENT |
| Anything else (bug) | `ALX_ERR_INTERNAL` | 500 | -32603 | INTERNAL |

- JSON-RPC reserves -32768..-32000. Application codes use other integers.
- WebSocket close codes are for connection-level failures: 1001 going away, 1008
  policy violation, 1011 internal error, 1012 service restart, 1013 try again
  later. Per-call errors travel inside messages.

## Response body

```js
// 4xx authored by us
const clientError = {
  error: {
    code: 'ALX_ERR_VALIDATION',
    message: 'Invalid input',
    details: [{ field: 'email', code: 'format' }],
  },
};

// 5xx and unknown
const internalError = {
  error: { code: 'ALX_ERR_INTERNAL', message: 'Internal error', errorId: '...' },
};
```

- `details` must be data designed for clients (public field names, limits), never
  `cause`, driver errors, or stack frames.
- Keep `message` readable. Translate on the server, or by `code` on the client.

## What must never reach a client

- `error.stack`, `error.cause`, and `AggregateError.errors` of internal origin.
- Queries, collection, index, and field names, driver messages and codes.
- Absolute paths, hostnames, internal IPs, library versions.
- Messages from third-party libraries: they change and may embed input.
- Distinct answers for "user exists" and "password wrong", or for "exists but
  forbidden" and "absent" when existence is sensitive.

## node:http adapter

Fastify apps use the handler in [SKILL.md](../SKILL.md). A library or a small
service on `node:http` keeps the same shape:

```js
const server = http.createServer(async (req, res) => {
  const requestId = req.headers['x-request-id'] ?? crypto.randomUUID();
  try {
    const result = await route(req);
    sendJson(res, 200, result);
  } catch (error) {
    if (res.headersSent) return void res.destroy(error);
    const { status, body } = toHttpError(error, requestId);
    sendJson(res, status, body);
  }
});
```

Fastify already has `request.id` and a Pino logger (`request.log`). Use them
instead of a second correlation mechanism.

## Crossing threads, processes, and services

`JSON.stringify(error)` gives only own enumerable fields. `structuredClone` and
`postMessage` keep `message`, `stack`, `cause`, and built-in names, but a custom
`name` becomes `Error` and `code` and other custom fields are lost (checked on
Node.js 22 and 24). Always convert explicitly:

```js
const toWire = (error, requestId) => ({
  code: error.code ?? 'ALX_ERR_INTERNAL',
  message: error.code ? error.message : 'Internal error',
  details: error.details ?? null,
  requestId,
});

const throwFromWire = (wire, service) => {
  const message = `${service}: ${wire.message}`;
  throw new DomainError(wire.code, { message, details: wire.details });
};
```

Between your own services forward a sanitized summary: code, message, business
operation, correlation id. Keep stacks in the logs of the service that produced
them.
