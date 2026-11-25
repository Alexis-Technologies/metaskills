# Circuit breaker

Retry helps against a short blip. A dependency that keeps failing or slows down needs the opposite:
stop calling it for a while, answer fast, and try again later. Retries against a sick dependency
multiply its load and hold your own requests until their timeouts.

## States

| State | Calls | Moves to |
| --- | --- | --- |
| Closed | Pass through; failures are counted | Open, when failures cross the threshold |
| Open | Rejected at once with `ALX_ERR_UNAVAILABLE` | Half-open, after the reset delay |
| Half-open | One trial call passes, the rest are rejected | Closed on success, open on failure |

## Rules

- One breaker per dependency (a host, or one operation of it), created once in its plugin or
  module, never per request.
- Count only failures that say the dependency is unhealthy: timeouts, connection errors, 5xx and
  429. A 4xx, a validation error or a not-found is the caller's problem and must not open it.
- Require a minimum volume before opening, so two failures at night do not cut a quiet service.
- The breaker wraps the retry: `breaker.fire()` around `retry(call)`. An open-circuit error is not
  retryable.
- When open, answer with `ALX_ERR_UNAVAILABLE` (503 with `Retry-After`, see
  [boundaries.md](boundaries.md)), or a fallback that is honest: a cached read, a degraded
  response. Never report a write as done.
- A timeout of the breaker rejects the promise but does not stop the call. Give the call its own
  `AbortSignal.timeout()` too.
- An open breaker does not fail readiness: every replica would leave the pool at once. Export its
  state as a metric and log each transition instead.
- Test the transitions with an injected clock or fake timers: closed to open, open to half-open,
  half-open to closed and back to open.

## App: opossum

```ts
// modules/billing/infra/payments.client.ts
import CircuitBreaker from 'opossum';

import type { Logger } from 'pino';

import type { HttpClient } from '#shared/infra/http.client.js';

type ChargeInput = { orderId: string; amount: number };
type Deps = { http: HttpClient; logger: Logger };

const isCallerError = (error: { statusCode?: number }) =>
  error.statusCode !== undefined && error.statusCode < 500 && error.statusCode !== 429;

export const createPaymentsClient = ({ http, logger }: Deps) => {
  const charge = (input: ChargeInput) =>
    http.post('/charges', input, { signal: AbortSignal.timeout(3000) });
  const breaker = new CircuitBreaker(charge, {
    timeout: 3500,
    errorThresholdPercentage: 50,
    volumeThreshold: 20,
    resetTimeout: 30_000,
    errorFilter: isCallerError,
  });
  breaker.on('open', () => logger.warn({ circuit: 'payments' }, 'circuit open'));
  breaker.on('halfOpen', () => logger.info({ circuit: 'payments' }, 'circuit half-open'));
  breaker.on('close', () => logger.info({ circuit: 'payments' }, 'circuit closed'));
  const close = () => breaker.shutdown();
  return { charge: (input: ChargeInput) => breaker.fire(input), close };
};
```

- `errorFilter` returns `true` for errors that must **not** count as failures.
- An open breaker rejects with `code === 'EOPENBREAKER'`, and its own timeout with `ETIMEDOUT`.
  Map both to `ALX_ERR_UNAVAILABLE` in the infra layer, so the boundary sees one code.
- Call `close` from the plugin's `onClose` hook: `shutdown()` clears the breaker's timers.

## Library: a small one

Libraries have no runtime dependencies. Consecutive failures are enough there:

```js
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']);

const isTransient = (error) => TRANSIENT_CODES.has(error.code);

const createBreaker = (fn, options = {}) => {
  const { name = fn.name, threshold = 5, resetMs = 30_000 } = options;
  const { isFailure = isTransient, now = Date.now } = options;
  let failures = 0;
  let openedAt = 0;
  let isTrialRunning = false;

  return async (...args) => {
    const isOpen = failures >= threshold;
    if (isOpen) {
      const waitMs = resetMs - (now() - openedAt);
      if (waitMs > 0 || isTrialRunning) throw new CircuitOpenError(name, Math.max(waitMs, 0));
      isTrialRunning = true;
    }
    try {
      const result = await fn(...args);
      failures = 0;
      return result;
    } catch (error) {
      if (isFailure(error)) {
        failures++;
        if (failures >= threshold) openedAt = now();
      } else if (isOpen) {
        failures = 0;
      }
      throw error;
    } finally {
      if (isOpen) isTrialRunning = false;
    }
  };
};

class CircuitOpenError extends Error {
  constructor(name, retryAfterMs) {
    super(`Circuit ${name} is open`);
    this.name = 'CircuitOpenError';
    this.code = 'ALX_ERR_UNAVAILABLE';
    this.retryAfterMs = retryAfterMs;
  }
}

module.exports = { createBreaker, CircuitOpenError };
```

A trial that ends in an error the caller caused (a 404) still proves the dependency answers, so it
closes the breaker. Tests pass `now`, so no test waits for the reset delay.
