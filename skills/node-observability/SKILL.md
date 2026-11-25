---
name: node-observability
description: Traces, metrics and alerts for Node.js with OpenTelemetry and Pino. Use when adding spans, metrics, trace ids or alert rules
---

<!-- Alexis stack. Written from the auth8 scalability skill (OpenTelemetry, metrics, monitoring),
     with the ESM preload, fastify-cli and threshold advice brought up to date. -->

# Node.js observability

Logs tell what happened to one request, traces show where its time went across services, and
metrics show the trend for all of them. Wire all three at boot, join them by trace id, and alert
on symptoms users feel. What to log and how is in `error-handling`, which metrics matter for
performance in `node-performance-profiling`.

|  | Library `@alexify/*` | App |
| --- | --- | --- |
| Dependencies | None: no OpenTelemetry SDK | OpenTelemetry SDK, instrumentations, OTLP |
| Signals | `node:diagnostics_channel`, a `logger` option | Traces, metrics, Pino logs with trace ids |
| Who exports | The app that uses it | A preload module, before the app |

## Rules

- **Preload before the app.** Instrumentation patches modules as they load, so it must run before
  `fastify`, `http`, `mongodb` or `ioredis` are imported: `node --import ./dist/instrumentation.js`.
  fastify-cli's `-i` / `FASTIFY_IMPORT` does not work for this: it does not await the import, and
  fastify-cli has already loaded Fastify by then.
- **ESM needs the loader hook.** An ESM app registers OpenTelemetry's hook at the top of the
  preload. The setup changes between SDK releases: follow the current ESM guide of OpenTelemetry
  JS, and check that spans appear for an ESM-imported module before relying on it.
- **Instrument what you run, by name.** HTTP, Fastify (`@fastify/otel`), undici, MongoDB, ioredis,
  Pino and the runtime. The all-in-one bundle loads dozens of instrumentations you do not use and
  slows the start.
- **Configure through the standard variables:** `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`
  (`deployment.environment.name=staging`), `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_HEADERS` (a secret), `OTEL_TRACES_SAMPLER`. The SDK reads them itself; list
  them in `.env.example` with the rest (`node-config`).
- **Sample at the head, keep errors at the collector.** `parentbased_traceidratio` with a ratio
  from traffic (`0.1` is a common start) keeps whole traces. Keep every error trace with tail
  sampling in the collector, not in the app.
- **Propagate context.** W3C `traceparent` travels on every outgoing call; the undici and HTTP
  instrumentations do it. A BullMQ job carries the context of the request that queued it.
- **Low cardinality.** Span names and metric labels use the route template (`POST /v1/sessions`),
  the method and the status class, never a URL with ids, a user id or an email. Ids go into span
  attributes and logs.
- **No personal data or secrets** in span attributes, events or metric labels: no emails, tokens,
  cookies or request bodies. Redact as you do in logs.
- **Join logs to traces.** The Pino instrumentation adds `trace_id` and `span_id` to every record
  logged inside a span. Keep Fastify's `reqId` too; it is what the client sees (`node-async-context`).
- **Flush on shutdown.** The SDK batches spans. Call `sdk.shutdown()` from an `onClose` hook, so the
  last spans leave before the process exits (`node-graceful-shutdown`).

## Preload

```ts
// src/instrumentation.ts, run with `node --import ./dist/instrumentation.js`
import { FastifyOtelInstrumentation } from '@fastify/otel';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

// Register the ESM loader hook first, as the OpenTelemetry JS ESM guide of your version says.

export const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
  instrumentations: [
    new HttpInstrumentation(),
    new FastifyOtelInstrumentation({ registerOnInitialization: true }),
    new UndiciInstrumentation(),
    new MongoDBInstrumentation(),
    new IORedisInstrumentation(),
    new PinoInstrumentation(),
    new RuntimeNodeInstrumentation(),
  ],
});

sdk.start();
```

```ts
// plugins/telemetry.ts: registered first, so its onClose runs last
import fp from 'fastify-plugin';

import { sdk } from '../instrumentation.js';

export default fp(
  async (fastify) => {
    fastify.addHook('onClose', async () => {
      await sdk.shutdown();
    });
  },
  { name: 'telemetry' },
);
```

The plugin imports the module the preload already ran, so it gets the same `sdk`. The image runs
`node --import ./dist/instrumentation.js node_modules/fastify-cli/cli.js start -o dist/main.js`
(`node-deploy`).

## Custom spans

Auto-instrumentation covers I/O. Add a span for a business step that matters on its own: signing
in, issuing a token, evaluating a policy.

```ts
import { SpanStatusCode, trace } from '@opentelemetry/api';

type SignInInput = { method: 'password' | 'passkey'; login: string; secret: string };
type SignIn = (input: SignInInput) => Promise<boolean>;

const tracer = trace.getTracer('auth8-api');

export const signInTraced = (signIn: SignIn): SignIn => (input) =>
  tracer.startActiveSpan('auth.sign_in', async (span) => {
    span.setAttribute('auth.method', input.method);
    try {
      return await signIn(input);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
```

- Wrap at the composition root, as a decorator of the service; domain code imports nothing from
  OpenTelemetry.
- Every started span ends on every path. `startActiveSpan` makes it the parent of the I/O inside.
- An expected outcome (a wrong password) is not a span error. Record it as an attribute or event.

## Metrics

| Group | What | From |
| --- | --- | --- |
| HTTP (RED) | Request rate, error rate by status class, duration histogram per route | HTTP and Fastify instrumentations |
| Runtime | Event loop utilization and delay, heap, GC time | `RuntimeNodeInstrumentation` |
| Dependencies | MongoDB pool waits and checked-out connections, Redis errors, upstream latency | Driver events, instrumentations |
| Queues | BullMQ waiting, active, failed, age of the oldest waiting job | A periodic gauge over queue counts |
| Business | Sign-ins, failed sign-ins, tokens issued | Counters from the services |

- Histograms for durations, never averages. Read p95 and p99.
- A business counter is a port of the service (`metrics.signIns.add(1)`), injected like the logger.
- On Fly.io, the built-in Prometheus can scrape an `[metrics]` endpoint instead of an OTLP push.
  Pick one path per service.

## Alerts

Alert on what users feel, then on what predicts it. Each alert has an owner and a runbook line.

| Alert | Start with |
| --- | --- |
| Error rate | 5xx above 1% of requests for 5 min |
| Latency | p95 above the route's SLO for 10 min |
| Saturation | ELU above 0.7 for 5 min (`node-event-loop`), or loop delay p99 above 100 ms |
| Memory | Rising `heapUsed` floor across GCs over hours, or RSS near the machine's memory |
| Restarts | More than one restart of an instance in 15 min, or any exit 137 |
| Queues | Oldest waiting job older than its deadline; failed jobs rising |
| Load shedding | Any 503 from `under-pressure` outside a load test |

The numbers are starting points: set them from a load test and the SLO, and tighten them as the
baseline becomes known.

## Library profile

A library depends on no SDK. It publishes events on `node:diagnostics_channel` (named channels, or
`tracingChannel` where every supported Node.js version has it) and takes a `logger` option; it
never logs on its own. Without a logger it may print what matters to `console`, and
`logger: false` silences even that. The app's instrumentation subscribes. A subscriber that is not
there costs nothing.

```js
const diagnostics = require('node:diagnostics_channel');

const queryChannel = diagnostics.channel('alexify:kerberos:check');

const check = async (request) => {
  const start = performance.now();
  const result = await evaluate(request);
  if (queryChannel.hasSubscribers) {
    queryChannel.publish({ action: request.action, durationMs: performance.now() - start });
  }
  return result;
};
```

## Anti-patterns

- Starting the SDK inside a plugin, after Fastify and the drivers are already loaded.
- `FASTIFY_IMPORT` for the tracing preload.
- `getNodeAutoInstrumentations()` with everything on, `fs` included.
- Span names or labels with raw URLs, user ids or emails.
- A span that never ends on the error path.
- Metrics averaged instead of histograms; alerts on a single sample.
- An alert at ELU 0.98, when the service is already shedding.
- A library that imports `@opentelemetry/sdk-node`.
- Exporting with no flush on shutdown, so every deploy loses the last seconds of traces.

## Checklist

- [ ] The preload runs with `node --import`, before the app, and spans appear for HTTP, MongoDB,
      Redis and outgoing calls.
- [ ] `OTEL_SERVICE_NAME`, the environment attribute and the endpoint are set per deploy.
- [ ] Logs carry `trace_id`; span names and labels have bounded cardinality and no personal data.
- [ ] RED metrics per route, runtime metrics and queue gauges are exported.
- [ ] Alerts exist for errors, latency, saturation, memory, restarts and queues, each with an owner.
- [ ] `sdk.shutdown()` runs in `onClose`.

Related skills: `error-handling`, `node-performance-profiling`, `node-event-loop`,
`node-async-context`, `node-scaling-highload`, `node-deploy`
