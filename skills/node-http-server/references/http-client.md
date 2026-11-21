# Outgoing HTTP

App: undici behind an Application port. Library: global `fetch`, which is undici underneath, or a
client the caller injects. Axios is banned. Checked on Node.js 24 with undici 7.

## undici in an app

One `Pool` per upstream origin, created by an Infrastructure plugin and closed in `onClose`. Use an
`Agent` when the origins are dynamic (webhooks, identity providers).

```ts
import fp from 'fastify-plugin';
import { Pool } from 'undici';

import { createBillingClient, type BillingClient } from '../infrastructure/billing.ts';

declare module 'fastify' {
  interface FastifyInstance {
    billing: BillingClient;
  }
}

export default fp(
  async (fastify) => {
    const { BILLING_URL, BILLING_CONNECTIONS, BILLING_TIMEOUT_MS } = fastify.config;
    const timeouts = { headersTimeout: BILLING_TIMEOUT_MS, bodyTimeout: BILLING_TIMEOUT_MS };
    const pool = new Pool(BILLING_URL, { connections: BILLING_CONNECTIONS, ...timeouts });
    fastify.decorate('billing', createBillingClient(pool));
    fastify.addHook('onClose', async () => {
      await pool.close();
    });
  },
  { name: 'billing', dependencies: ['config'] },
);
```

```ts
import type { Pool } from 'undici';

class UpstreamError extends Error {
  readonly status: number;

  constructor(status: number, options?: ErrorOptions) {
    super(`Upstream answered ${status}`, options);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

const toUpstreamError = (error: Error & { code?: string | number }) => {
  const isTimeout = error.name === 'TimeoutError' || TIMEOUT_CODES.has(`${error.code}`);
  return new UpstreamError(isTimeout ? 504 : 502, { cause: error });
};

const createBillingClient = (pool: Pool) => {
  const getInvoice = async (id: string, signal: AbortSignal) => {
    const path = `/invoices/${encodeURIComponent(id)}`;
    const response = await pool.request({ method: 'GET', path, signal }).catch((error) => {
      throw toUpstreamError(error);
    });
    if (response.statusCode >= 400) {
      await response.body.dump();
      throw new UpstreamError(response.statusCode);
    }
    return response.body.json();
  };
  return { getInvoice };
};

export { createBillingClient, UpstreamError };
```

- `headersTimeout` and `bodyTimeout` default to 300 s. Set them per upstream. undici timers are
  coarse: a 1 s timeout fired at about 1.5 s.
- A per-call `signal` carries the deadline of the caller. Pass `request.signal` from a Fastify handler,
  so `handlerTimeout` cancels the call. Combine with `AbortSignal.any` when you need both.
- With `AbortSignal.timeout`, the error has `name === 'TimeoutError'`. Pool timeouts have
  `code === 'UND_ERR_HEADERS_TIMEOUT'` or `'UND_ERR_BODY_TIMEOUT'`. A refused connection has
  `code === 'ECONNREFUSED'`.
- **Always consume the body.** `body.dump()` when it is not needed. An unread body holds the
  connection, and the pool runs dry.
- `connections` caps concurrency to the upstream. An outage then cannot open unlimited sockets.
- Retry only idempotent requests, with backoff and jitter, and with a total deadline
  (`js-async-patterns`).
- Never fetch a URL taken from user input without an allowlist (SSRF, `node-security`).

## fetch in a library

```js
const fetchJson = async (url, { timeoutMs = 5000, ...options } = {}) => {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...options, signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
};
```

- Check `response.ok`, and consume or `response.body?.cancel()` the body.
- Timeout errors have `name === 'TimeoutError'`. Network errors are `TypeError('fetch failed')` with
  `error.cause.code` (`ECONNREFUSED`, ...).

## http.request

- Attach `'error'`, check `statusCode`, call `res.resume()` when the body is not needed, and `return`
  after `reject` or `callback(error)`.
- `http.globalAgent` keeps connections alive since Node 19. Create a dedicated
  `new http.Agent({ keepAlive: true, maxSockets })` per upstream when you need limits.
