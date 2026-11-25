---
name: node-graceful-shutdown
description: Stops Node.js services cleanly with Fastify, BullMQ, Redis and wrpc. Use for SIGTERM, onClose order, drain deadlines or hangs on deploy
---

<!-- Alexis stack: Fastify, BullMQ, Redis/Valkey, wrpc and Pino. This skill owns shutdown:
     error-handling calls the idempotent shutdown(origin, exitCode) defined here, or relies on
     fastify-cli's handlers under `fastify start`. -->

# Node.js graceful shutdown

Make every long-running process stop the same way: refuse new work, let current work finish within
a deadline, tell long-lived clients to reconnect elsewhere, release resources in reverse order,
flush logs, and exit with a meaningful code. The trigger may be a deploy signal or a crash.

|  | Library `@alexify/*` | App (`auth8`) |
| --- | --- | --- |
| Signals | Never installs handlers | One handler set: fastify-cli's, or your entry's |
| Lifecycle | Exposes `close()`, idempotent | `fastify.close()`, `onClose` hooks |
| Injected resources | Never closes what it did not create | Each plugin closes what it opened |

Read when needed:

- [references/platforms.md](references/platforms.md): Fly.io, Docker, Kubernetes, PM2, systemd
- [references/node-http.md](references/node-http.md): bare `node:http`, raw WebSocket, cluster,
  worker threads

## Lifecycle

1. **Trigger:** `SIGTERM`, `SIGINT`, an IPC message, or a process-level error.
2. **Not ready:** the readiness endpoint returns 503. Keep serving for a short delay so load
   balancers stop routing here.
3. **Stop intake:** close the listener and idle keep-alive sockets, send `Connection: close` on
   in-flight responses, pause queue workers, stop schedulers and watchers.
4. **Drain:** wait for in-flight requests and jobs. Tell WebSocket and SSE clients to reconnect.
5. **Deadline:** after the drain timeout, drop what is left.
6. **Release:** close resources in reverse dependency order, the logger last.
7. **Exit:** `0` for a requested stop that drained cleanly, `1` for a crash, forced drain or failed
   cleanup.

## Rules

- Handle both `SIGTERM` and `SIGINT`. A listener removes Node's default exit for that signal, so the
  handler must end in `process.exit`.
- **One idempotent `shutdown(origin, exitCode)`.** The first call creates the promise, and later
  calls return it. A later call may **raise** the exit code: a crash during a requested drain must
  not exit `0`.
- Arm two timers at the start: a drain deadline that drops connections, and a hard exit deadline in
  case cleanup itself hangs. Keep the total below the platform's kill timeout.
- **Do not `unref()` the exit timer.** If cleanup hangs on a promise with no open handle, the event
  loop empties and the process exits `0` before an unref'd timer fires, with the remaining resources
  unclosed. The success path calls `process.exit`, so a ref'd timer delays nothing.
- **Fly.io's default kill timeout is 5 s**, and auth8 deploys there. Set `kill_timeout` explicitly.
- Do not free resources before the drain ends: in-flight requests still need the database, the
  cache and the logger.
- Close resources in reverse dependency order, each failure isolated, and keep closing the rest.
- Readiness fails as soon as shutdown starts. **Liveness keeps passing until exit**, or the
  orchestrator kills the process mid-drain.
- Pass an `AbortSignal` into long operations, so the deadline can cancel them.
- Jobs must be idempotent, because a forced stop can repeat them. Never acknowledge unfinished work.
- Exit codes: `0` clean, `1` crash or forced. `128 + n` means the signal itself killed the process
  (143 SIGTERM, 130 SIGINT, **137 SIGKILL**). 137 on deploys means the grace period is too short or
  shutdown hangs. Node exits with 7 when an `uncaughtException` handler throws and 13 on an unsettled
  top-level `await`.
- Call `process.exit(code)` after cleanup, because third-party handles often keep the loop alive. In
  tests, inspect leaks with `process.getActiveResourcesInfo()`.
- Run `node` as the container's main process in exec form, or under an init. Never rely on
  `pnpm start` or a shell to forward signals.
- **A request must never reach the crash path.** Parse untrusted URLs without throwing and put a
  `catch` on every async handler you wire by hand. Fastify routes do this for you
  (`references/node-http.md` shows the bug).

### Keep-alive under Fastify

Fastify's default `keepAliveTimeout` is **72 s**. `fastify.close()` closes idle sockets, but a socket
that was busy at that moment stays open after its response until that timeout. Measured on Fastify
5.8: one request in flight at `close()` held every `onClose` hook for **73 s**, far past any grace
period. The `onSend` hook below answers with `Connection: close` during the drain, and `close()` then
ends right after the last response.

Do not set `forceCloseConnections: true` to fix this: it drops in-flight requests at once.

### Crash policy

- An exception that reached the process level means unknown state, so replace the process within
  seconds, gracefully: stop accepting, give other requests 5-10 s, flush logs, exit `1`.
- Immediate exit is acceptable when instances are many and requests are short. It drops every
  in-flight request of that process.
- Never catch-and-continue after `uncaughtException` in code with shared mutable state.
- Use a shorter drain for a crash: skip the readiness delay, and start no new writes that depend on
  in-memory state.
- Supervisors restart with backoff, so a crash on startup does not spin.

## Fastify pattern

### Two ways to start, never both

| | `fastify start -o dist/main.js` | Your entry: `app.listen` |
| --- | --- | --- |
| Signal handlers | fastify-cli (close-with-grace): `SIGTERM`, `SIGINT`, uncaught errors | `createShutdown` below |
| Exit deadline | `FASTIFY_CLOSE_GRACE_DELAY`, default **500 ms**: set it | `exitTimeoutMs` |
| Readiness delay | Not in the app: delay in the platform | `readinessDelayMs` before `close()` |
| Exit code | `0` after a signal, `1` after an error or the deadline | `0` or `1`, a crash raises it |
| Used by | HTTP services laid out as a plugin tree (`auth8-api`) | Workers, CLIs, standalone servers |

- Under `fastify start`, `main.ts` exports a plugin, and fastify-cli owns the process. A plugin
  that also calls `process.on('SIGTERM')` runs a second shutdown.
- From the first line of `close()`, before any `preClose` hook, Fastify answers every new request
  with 503 and `Connection: close` (`return503OnClosing`). A delay inside `close()` serves no
  traffic. On Kubernetes use a `preStop` sleep (`node-deploy`), or start from your own entry.
- The default 500 ms grace delay kills every drain. Set it below the platform's kill timeout, for
  example `FASTIFY_CLOSE_GRACE_DELAY=25000` with `kill_timeout = "30s"`.

### Lifecycle plugin

Both ways use it. It answers health checks, marks in-flight responses with `Connection: close`
during the drain and drops what is left at the drain deadline.

```ts
// plugins/lifecycle.ts
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    lifecycle: { isDraining: boolean; isForced: boolean };
  }
}

export default fp(
  async (fastify) => {
    const lifecycle = { isDraining: false, isForced: false };
    let drainTimer: NodeJS.Timeout | null = null;
    fastify.decorate('lifecycle', lifecycle);

    fastify.addHook('onSend', async (request, reply) => {
      if (lifecycle.isDraining) reply.header('connection', 'close');
    });

    fastify.addHook('preClose', async () => {
      lifecycle.isDraining = true;
      drainTimer = setTimeout(() => {
        fastify.log.warn('drain deadline reached, dropping connections');
        lifecycle.isForced = true;
        fastify.server.closeAllConnections();
      }, fastify.config.SHUTDOWN_DRAIN_TIMEOUT_MS);
    });
    fastify.addHook('onClose', async () => {
      if (drainTimer !== null) clearTimeout(drainTimer);
    });

    fastify.get('/health/live', async () => ({ status: 'ok' }));
    fastify.get('/health/ready', async (request, reply) => {
      if (lifecycle.isDraining) return reply.code(503).send({ status: 'draining' });
      return { status: 'ok' };
    });
  },
  { name: 'lifecycle', dependencies: ['config'] },
);
```

Under `fastify start` a drain cut at the deadline still exits `0`: the warning above is the record.

### The shutdown routine of your own entry

```ts
// shutdown.ts
import { setTimeout as sleep } from 'node:timers/promises';

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

export type ShutdownOptions = {
  app: FastifyInstance;
  logger: Logger;
  readinessDelayMs: number;
  exitTimeoutMs: number;
};
export type Shutdown = (origin: string, exitCode?: number) => Promise<void>;

const flush = (logger: Logger): Promise<void> =>
  new Promise((resolve) => {
    logger.flush(() => resolve());
  });

export const createShutdown = (options: ShutdownOptions): Shutdown => {
  const { app, logger, readinessDelayMs, exitTimeoutMs } = options;
  let closing: Promise<void> | null = null;
  let finalCode = 0;

  // The app still serves during the delay: Fastify refuses requests only once close() starts.
  const drain = async (delayMs: number): Promise<void> => {
    app.lifecycle.isDraining = true;
    if (delayMs > 0) await sleep(delayMs);
    await app.close();
  };

  return (origin, exitCode = 0) => {
    if (exitCode > finalCode) finalCode = exitCode;
    if (closing !== null) return closing;
    logger.info({ origin, exitCode }, 'shutdown started');
    setTimeout(() => {
      logger.fatal('shutdown deadline reached');
      process.exit(1);
    }, exitTimeoutMs);
    const delayMs = exitCode === 0 ? readinessDelayMs : 0;
    closing = drain(delayMs)
      .catch((error: unknown) => {
        finalCode = 1;
        logger.error({ err: error }, 'shutdown failed');
      })
      .then(() => {
        if (app.lifecycle.isForced) finalCode = 1;
        return flush(logger);
      })
      .then(() => process.exit(finalCode));
    return closing;
  };
};
```

Keep `readinessDelayMs < SHUTDOWN_DRAIN_TIMEOUT_MS < exitTimeoutMs < platform kill timeout`, for
example 2 s, 20 s, 25 s and 30 s. Under `fastify start` the chain is drain timeout <
`FASTIFY_CLOSE_GRACE_DELAY` < kill timeout.

### Composition root of your own entry

```ts
// main.ts
import pino from 'pino';

import { buildApp } from './app.ts';
import { config } from './config.ts';
import { createShutdown } from './shutdown.ts';

const logger = pino({ level: config.LOG_LEVEL });
const app = await buildApp({ loggerInstance: logger });
const shutdown = createShutdown({
  app,
  logger,
  readinessDelayMs: config.SHUTDOWN_READINESS_DELAY_MS,
  exitTimeoutMs: config.SHUTDOWN_EXIT_TIMEOUT_MS,
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error, origin) => {
  logger.fatal({ err: error, origin }, 'uncaught exception');
  shutdown(origin, 1);
});

await app.listen({ host: config.HOST, port: config.PORT });
```

An unhandled rejection arrives here too, with `origin` set to `'unhandledRejection'`.

### `onClose` runs in reverse dependency order

`fastify.close()` runs `preClose` hooks, closes the server, waits for in-flight requests, then runs
`onClose` hooks **last registered first**. Declare `dependencies` in `fastify-plugin` and the order
follows. With `config`, `mongodb`, `redis`, `queues`, `workers` registered in that order, the hooks
ran as `workers`, `queues`, `redis`, `mongodb`, `config`.

| Hook | Use |
| --- | --- |
| `preClose` | Stop intake while the server still runs: pause workers, drain wrpc |
| `onClose` | Release resources, after the last request |

A `preClose` hook must return nothing: an async hook that resolves to a value fails `close()`.

### BullMQ workers and queues

```ts
// plugins/workers.ts
import type { Processor } from 'bullmq';
import { Worker } from 'bullmq';
import fp from 'fastify-plugin';

const JOB_DRAIN_MS = 15_000;

export const workerPlugin = (queueName: string, processor: Processor) =>
  fp(
    async (fastify) => {
      const connection = { host: fastify.config.REDIS_HOST, port: fastify.config.REDIS_PORT };
      const worker = new Worker(queueName, processor, { connection });
      worker.on('error', (error) => fastify.log.error({ err: error }, 'worker error'));

      fastify.addHook('preClose', async () => {
        await worker.pause(true);
      });
      fastify.addHook('onClose', async () => {
        const timer = setTimeout(() => worker.cancelAllJobs('shutdown'), JOB_DRAIN_MS);
        try {
          await worker.close();
        } finally {
          clearTimeout(timer);
        }
      });
    },
    { name: `worker-${queueName}`, dependencies: ['config', 'mongodb', 'redis'] },
  );
```

- `worker.pause(true)` stops fetching at once without waiting for active jobs.
- `worker.close()` waits for active jobs. A later `close(true)` does nothing, because the first call
  is memoized, so the deadline uses `cancelAllJobs`.
- `cancelAllJobs` only aborts the `signal` a processor receives as its third argument
  (`(job, token, signal)`). A processor that ignores it runs until the hard exit, and BullMQ later
  redelivers the job as stalled.
- Close a `Queue` (producer) in `onClose`, because a request in flight may still add a job.
- A shared `ioredis` instance passed as `connection` is **not** closed by BullMQ. Its owner closes
  it, after the workers.

auth8 today closes only its queues (`apps/auth8-api/src/plugins/queues.ts`). `auth8-jobs` creates
workers with no close path and no signal handler, so a deploy drops active jobs there until the
pattern above is applied.

### Redis and MongoDB

- `@fastify/redis` and `@fastify/mongodb` close the client they created, in their own `onClose`. A
  client you pass in is yours to close.
- `redis.quit()` waits for pending replies. `disconnect()` drops them, so keep it for the deadline.
- `await client.close()` closes the MongoDB pool (`node-data-access`).

### wrpc

```ts
await fastify.register(wrpcFastify, { router, drain: 10_000 });
```

The plugin drains on `preClose`: new calls get 503, calls in flight get up to `drain` ms, peers get
a `1001` close and reconnect. The default `drain` is **0**, so set it. Subscriptions are not waited
for. Count `drain` inside `drainTimeoutMs`.

A standalone server closes the same way. The backplane is yours:

```ts
await server.close({ drain: 10_000 });
await backplane.close();
```

### Logger

Pino is flushed last, with `logger.flush(callback)`, after every hook has logged.

## Anti-patterns

- `process.on('SIGTERM', () => process.exit(0))`: drops every in-flight request.
- `server.close(() => process.exit(0))` with no deadline: waits for keep-alive and WebSocket sockets,
  then SIGKILL (137).
- Fastify defaults with no `Connection: close` during the drain: `close()` waits up to 72 s.
- `forceCloseConnections: true` as a fix for that: in-flight requests are cut.
- Closing the database before the HTTP drain: requests fail during every deploy.
- A plugin with `onClose` but no `dependencies`: the close order becomes accidental.
- `CMD pnpm start` or shell-form `CMD node main.js`: the signal never reaches Node.
- Readiness green during the drain, or liveness failing during it.
- Reconnecting all WebSocket clients at once, without jitter.
- A non-idempotent shutdown: a second signal runs cleanup twice.
- Signal handlers of your own under `fastify start`: two shutdowns race.
- `FASTIFY_CLOSE_GRACE_DELAY` left at 500 ms: every drain is cut and exits `1`.
- A crash during a requested stop that still exits `0`.
- An `unref()`-ed exit timer: a hung cleanup ends the process with `0`.
- `new URL(req.url, base)` in a hand-wired async handler with no `catch`: one `GET //` stops the
  process.
- Swallowing `uncaughtException` and continuing.

## Checklist

- [ ] One way to start: `fastify start` with `FASTIFY_CLOSE_GRACE_DELAY` set, or your entry.
- [ ] In your entry, `SIGTERM` and `SIGINT` call one idempotent `shutdown(origin, exitCode)`, and
      `uncaughtException` calls `shutdown(origin, 1)`, which can raise the exit code.
- [ ] Readiness flips to 503 at shutdown start, and liveness stays up.
- [ ] In-flight responses carry `Connection: close` during the drain.
- [ ] Workers are paused in `preClose` and closed in `onClose`, with a job deadline.
- [ ] Every plugin that opens a resource closes it and declares `dependencies`.
- [ ] wrpc has an explicit `drain`.
- [ ] Drain and exit deadlines exist, the exit timer is ref'd, and both fit the platform's timeout.
- [ ] The logger is flushed last.
- [ ] The exit code is 0 only for a clean requested stop.
- [ ] The container runs `node` directly, and `kill_timeout` or its equivalent exceeds the deadline.
- [ ] A test sends `SIGTERM` during a slow request and asserts: it completes, new connections are
      refused, the process exits in time.

Related skills: `error-handling`, `node-data-access`, `node-http-server`, `node-websocket-realtime`,
`node-scaling-highload`, `alexis-libraries`
