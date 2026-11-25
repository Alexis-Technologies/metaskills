# Security patterns

## Fastify limits and timeouts

```js
const Fastify = require('fastify');

const app = Fastify({
  bodyLimit: 1024 * 1024,
  requestTimeout: 30_000,
  connectionTimeout: 60_000,
  keepAliveTimeout: 72_000,
  http: { headersTimeout: 10_000 },
});
```

Measured on Node.js 24 and Fastify 5.8 with a client that sends headers and part of a body:

| `requestTimeout` | `headersTimeout` | Result |
| --- | --- | --- |
| Fastify default (`0`) | default (60 s) | not closed by these timers |
| 300 ms | 200 ms | 408 at about 300 ms |
| 300 ms | 800 ms | 408 at about 800 ms, the larger value wins |
| 800 ms | 300 ms | 408 at about 800 ms |

`connectionTimeout` is the socket idle timeout: it destroys the socket without a 408.

## Rate limit on sign-in

```js
const rateLimit = require('@fastify/rate-limit');

await app.register(rateLimit, { global: false, redis: app.redis, nameSpace: 'RateLimit:' });

const keyGenerator = (request) => `${request.ip}:${request.body?.login ?? ''}`;
const signinLimit = { max: 5, timeWindow: '1 minute', keyGenerator, hook: 'preHandler' };

app.post('/signin', { config: { rateLimit: signinLimit } }, signin);
```

Without `hook: 'preHandler'` the key is computed in `onRequest`, where `request.body` is still empty,
so all logins from one IP share a counter. Set `trustProxy` only to the proxies you run, or
`request.ip` is whatever the client wrote in `X-Forwarded-For`.

## Bounded concurrency in a library

```js
class HttpError extends Error {
  constructor(message, options = {}) {
    const { statusCode = 500 } = options;
    super(message, options);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

const createLimiter = (concurrency, queueSize) => {
  let active = 0;
  const queue = [];
  const next = () => {
    active--;
    const resolve = queue.shift();
    if (resolve) {
      active++;
      resolve();
    }
  };
  return async (task) => {
    if (active >= concurrency) {
      if (queue.length >= queueSize) throw new HttpError('Busy', { statusCode: 503 });
      await new Promise((resolve) => queue.push(resolve));
    } else {
      active++;
    }
    try {
      return await task();
    } finally {
      next();
    }
  };
};
```

Add a queue wait timeout if requests must not wait long. In an app use `@fastify/under-pressure`
(`maxEventLoopDelay`, `maxHeapUsedBytes`, `maxRssBytes`, `maxEventLoopUtilization`, `retryAfter`), and
in wrpc the `queue: { concurrency, size, timeout }` option of a procedure.

## MongoDB filter from validated input

```js
const SORT_FIELDS = {
  __proto__: null,
  name: 'name',
  created: 'createdAt',
};

const findUsers = (users, { tenantId, group, sort }) => {
  const field = SORT_FIELDS[sort] ?? 'name';
  const filter = { tenantId, group: { $eq: group } };
  const options = { projection: { name: 1 }, sort: { [field]: 1 }, limit: 100, maxTimeMS: 2000 };
  return users.find(filter, options).toArray();
};
```

`SORT_FIELDS` is keyed by a query value, so it has no prototype: `sort=constructor` falls back to
`name`. `$eq` compares the value literally, so `{ "$ne": null }` matches nothing instead of everything. It is
the second layer: the schema at the boundary should already have rejected a non-string `group`.
`tenantId` comes from the session, never from the request.

## Safe static file path

```js
const path = require('node:path');
const fsp = require('node:fs/promises');

const isInside = (root, filePath) => filePath === root || filePath.startsWith(root + path.sep);

const resolveInside = (root, unsafePath) => {
  const filePath = path.resolve(root, `.${path.sep}${unsafePath}`);
  return isInside(root, filePath) ? filePath : null;
};

const resolveReal = async (root, unsafePath) => {
  const filePath = resolveInside(root, unsafePath);
  if (!filePath) return null;
  const realRoot = await fsp.realpath(root);
  const realPath = await fsp.realpath(filePath).catch(() => null);
  if (!realPath) return null;
  return isInside(realRoot, realPath) ? realPath : null;
};

const decodePath = (url) => {
  try {
    return decodeURIComponent(url.split('?')[0]);
  } catch {
    return null;
  }
};
```

`root` must be absolute (`path.resolve(...)` at startup). Null bytes are rejected by `fs` itself with
`ERR_INVALID_ARG_VALUE`.

## Merge without prototype pollution

```js
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const safeMerge = (target, source) => {
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (FORBIDDEN_KEYS.has(key)) continue;
    const value = source[key];
    if (!isRecord(value)) {
      target[key] = value;
      continue;
    }
    const base = isRecord(target[key]) ? target[key] : Object.create(null);
    target[key] = safeMerge(base, value);
  }
  return target;
};

const merged = safeMerge(Object.create(null), JSON.parse(body));
```

The recursion follows the input, so limit JSON depth in the schema first.

## Security headers

In an app:

```js
const helmet = require('@fastify/helmet');

await app.register(helmet);
```

Helmet sets CSP, `X-Content-Type-Options`, HSTS, `Referrer-Policy`, the cross-origin policies and
`X-XSS-Protection: 0`. Fastify sends no `X-Powered-By`. In a library that serves HTTP, a constant is
enough:

```js
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const API_HEADERS = {
  ...SECURITY_HEADERS,
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};
```

Send HSTS only over HTTPS.

## Secrets in logs

```js
const pino = require('pino');

const paths = ['config.JWT_ACCESS_SECRET', 'req.headers.authorization', 'req.headers.cookie'];
const logger = pino({ redact: { paths, remove: true } });
```

List every secret key of the config schema. `redact` matches exact paths, so a secret logged under
another key is not covered: the safer rule is to never log the config object.
