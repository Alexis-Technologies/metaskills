---
name: node-performance-profiling
description: Measure and profile Node.js with benchmarks, perf_hooks, CPU and heap profiles. Use when code is slow, memory grows or before optimizing
---

# Node.js Performance Measurement and Profiling

Never optimize without a number. Classify the bottleneck first, measure it with
the tool that fits that class, change one thing, re-measure under identical
conditions, and keep runtime telemetry so regressions and leaks surface early.
Code-level V8 rules and how to verify them live in `js-conventions`
(`performance.md`); event-loop internals in `node-event-loop`; worker
offloading in `node-multithreading`.

Where the profiles differ:

- **Library:** benchmarks live in `bench/` and run through `pnpm bench` where
  the package defines it. They may use array methods. Keep a baseline and
  compare against it before a release.
- **App:** autocannon for quick per-service throughput, k6 for scripted load
  scenarios, `@fastify/under-pressure` for load shedding, Pino for telemetry
  logs.

## Workflow rules

1. Define the metric and target before touching code: throughput, latency
   p50/p99, job duration, memory ceiling. Record Node version, flags, CPU,
   configuration, data size.
2. Reproduce with realistic data and load (a load generator for HTTP, a fixed
   input set for jobs).
3. Classify the bottleneck (table below) using cheap runtime metrics: ELU,
   event-loop delay, CPU%, heap and RSS trend, GC time.
4. Profile with the matching tool; find the top one or two causes.
5. Make one change, re-run the same measurement, keep it only if the metric
   improved beyond the run-to-run spread; otherwise revert.
6. Leave a guard: a benchmark script, a leak test, or an alert on telemetry.
7. Stop when the target is met. By default uniform readable code is worth more
   than small gains; optimize when it changes a business outcome.

## Classify the bottleneck

| Class | Symptoms | Confirm with | Typical fixes |
| --- | --- | --- | --- |
| CPU-bound | ELU near 1, one core at ~100%, latency grows with concurrency | `--cpu-prof` flame chart (JS frames, GC share) | Better algorithm or data structure, precompute, memoize, V8-friendly code, `worker_threads` pool, more replicas |
| I/O-bound | Low ELU and CPU, high latency, many in-flight requests | spans (`performance.mark`/`measure`), DB slow log, pool wait time | Bounded parallelism, connection pools, batching, caching, streaming, indexes, fewer round trips (N+1), timeouts |
| Memory/GC-bound | `heapUsed` floor rising, long or frequent GC, latency spikes, `heap out of memory` | `gc` perf entries, `--trace-gc`, heap snapshots, `--heap-prof` | Remove retainers, bound caches, stream instead of buffering, typed arrays/Buffers for bulk data, reuse large buffers |
| Event loop blocked | p99/max latency spikes for all requests, loop delay p99 high while average CPU moderate | `monitorEventLoopDelay`, `--cpu-prof` showing one long frame | Async APIs, split work with `setImmediate`, workers, streaming parsers, fix catastrophic regexes, no sync fs/crypto/zlib in request path |

Notes:

- I/O-bound code does not get faster from micro-optimizing JS: a single network
  round trip (milliseconds) dwarfs anything a V8 tweak saves (nanoseconds).
- Sync APIs are fine at startup (loading config, modules) and can be 10-20%
  faster for batch jobs over millions of files; measure before switching.

## Benchmarking rules

These extend the "Measuring" section of `performance.md` in `js-conventions`.
A ready harness that follows them is in
[references/benchmark-harness.md](references/benchmark-harness.md).

- Benchmark whole operations, wrapped in a function (the function is V8's unit
  of optimization), with realistic and varying inputs; constants get folded
  and loop invariants hoisted.
- Run each case in its own process: cases sharing a process share feedback,
  inline caches, and heap state, so the case that runs second sees polymorphic
  call sites and leftover garbage.
- Warm up before measuring (code tiers up Ignition -> Sparkplug -> Maglev ->
  TurboFan), then take many samples; report median and spread (min/max or
  p95), never one run or a mean alone.
- Accumulate every result into a sink and print it, so dead-code elimination
  cannot drop the work; an unused result measured 2x "faster" on Node 24.
- Keep conditions identical: same data, iteration count, flags, machine load.
  Repeat runs; treat differences within the spread (often 5-20% for
  nanosecond-scale cases) as noise.
- Time with `performance.now()` or `process.hrtime.bigint()`, not `Date.now()`;
  `console.time` only for rough spot checks.
- Do not benchmark with `--inspect`, a profiler, or `--trace-*` flags enabled.
- When a result surprises you, check optimization status and deopts
  (`v8-verify.md` in `js-conventions`) before drawing conclusions.
- Confirm micro-benchmark wins with a macro benchmark of the real operation;
  shapes, inlining, and GC behave differently in real code. V8 changes between
  releases, so re-measure on the Node.js version you ship.

## perf_hooks rules

- Use `performance.now()` for durations; `performance.mark()` +
  `performance.measure()` for named spans; collect with a
  `PerformanceObserver`. Call `performance.clearMarks()`/`clearMeasures()` in
  long-running processes: entries accumulate until cleared.
- Use `performance.timerify(fn)` plus an observer of type `'function'` to time
  a function without editing it.
- Use `monitorEventLoopDelay({ resolution })` for loop health: values are in
  nanoseconds; read `percentile(99)`, `max`, `mean`, then `reset()` per window.
- Use `performance.eventLoopUtilization()` deltas for saturation (0..1): pass
  the current and previous readings to get a window.
- Record your own latencies in `createHistogram()` (integers, for example
  microseconds) instead of logging every event.
- Observe `'gc'` entries; `entry.detail.kind` distinguishes
  `NODE_PERFORMANCE_GC_MINOR` (scavenge) from `NODE_PERFORMANCE_GC_MAJOR`
  (mark-compact).

## Profiling rules

- CPU: `node --cpu-prof --cpu-prof-dir=prof app.js` writes a `.cpuprofile` on
  normal exit only; a server stopped by the default Ctrl+C/SIGTERM writes
  nothing, so handle the signal with `process.exit()` (or graceful shutdown).
  Open it in Chrome DevTools (Performance panel, load profile) or VS Code.
  Read self time first (bottom-up), then the call tree. `--prof` with
  `node --prof-process isolate-*.log` gives a text summary including GC and
  native ticks.
- Allocations: `--heap-prof` writes a sampling `.heapprofile` (who allocates);
  heap snapshots show who retains. Use the former for GC pressure, the latter
  for leaks.
- Snapshots: `v8.writeHeapSnapshot()`, `--heapsnapshot-signal=SIGUSR2`,
  `--heapsnapshot-near-heap-limit=2` (captures before OOM), or DevTools Memory
  panel. A snapshot pauses the process and needs roughly twice the current
  heap size in memory; take it on a drained instance.
- Interactive: `node --inspect app.js` (binds 127.0.0.1:9229; never expose the
  port publicly), open `chrome://inspect`, "Open dedicated DevTools for Node".
  `--inspect-brk` pauses on the first line.
- Production: profile on demand (signal handler + `node:inspector/promises`
  for 10-30 s) instead of running profilers permanently; `SIGUSR1` is reserved
  by Node to start the inspector, so use `SIGUSR2`.
- Hangs and handle leaks: `--report-on-signal` or `process.report.writeReport()`
  dump JS and native stacks, libuv handles, and resource usage.
- V8-level fixes are verified with `--trace-opt --trace-deopt`: the function
  should stop appearing in `bailout` lines after the fix.
- Flag and API reference: [references/tools-and-flags.md](references/tools-and-flags.md).

## Memory leak rules

- Prove the leak: under steady repeated load, `heapUsed` after GC (the floor of
  the sawtooth) keeps rising. `heapTotal` rarely shrinks and RSS keeps freed
  pages, so neither alone proves a leak.
- Locate the region: `heapUsed` (objects, strings, closures) vs `external` and
  `arrayBuffers` (Buffers, typed arrays; `fs.readFile` without encoding
  returns a Buffer stored there) vs RSS-only growth (native code, threads,
  fragmentation).
- Use the three-snapshot technique: warm up, snapshot, run N identical
  operations, snapshot, run N again, snapshot; in the last one show objects
  allocated between snapshots 1 and 2 (or Comparison view). Constructors whose
  count grows by about N per cycle are suspects; follow Retainers to the root.
- Check the usual retainers first (catalogue with fixes:
  [references/memory-leaks.md](references/memory-leaks.md)): module-level
  `Map`/arrays/caches without eviction, listeners added per request, timers
  never cleared, `AbortSignal` listeners not removed, closures capturing large
  objects, substrings of large strings, unsettled promises holding callbacks,
  mixins into `global`/`process`/`console`, unclosed handles, workers and
  child processes never terminated.
- Do not hide leaks: restarting on a schedule, raising `setMaxListeners`,
  or raising `--max-old-space-size` only postpones the crash; treat
  `MaxListenersExceededWarning` as a bug report.
- By default prefer async functions over `EventEmitter` in business logic;
  every subscription needs a guaranteed unsubscribe (`once`, `{ signal }`,
  `removeListener` in `finally`).
- Add a leak regression test: run N operations under `--expose-gc`, then
  assert collectability (`WeakRef` + `gc()`), listener counts
  (`events.getEventListeners`), or a bounded `heapUsed` delta.

## Telemetry rules

- Export per process: ELU, loop delay p50/p99/max, CPU%, `rss`, `heapUsed`,
  `heapTotal`, `external`, `arrayBuffers`, GC time by kind, in-flight
  requests, pool wait time, per-route latency histograms.
- Alert on trends, not single samples: rising `heapUsed` floor, loop delay p99
  above budget, ELU sustained above a threshold set well below 0.7 (default
  guidance: 10-30% is normal, around 70% a process is already saturated; see
  `node-event-loop`).
- Sample on an `unref()`ed interval (1-10 s) and aggregate into histograms;
  telemetry must not become the bottleneck or keep the process alive.
- Feed ELU and loop delay into load shedding and autoscaling
  (`node-scaling-highload`).
- Export them with OpenTelemetry and alert on them as `node-observability`
  shows.

## Patterns

Time an existing function without editing it:

```js
const { performance, PerformanceObserver } = require('node:perf_hooks');

const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    console.log(`${entry.name}: ${entry.duration.toFixed(3)} ms`);
  }
});
observer.observe({ type: 'function' });

const parseConfig = (text) => JSON.parse(text);
const timedParse = performance.timerify(parseConfig);
timedParse('{"port":8000}');
```

Runtime health monitor (ELU, loop delay, CPU, memory, GC) - full version in
[references/tools-and-flags.md](references/tools-and-flags.md):

```js
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');

const startLoopMonitor = ({ intervalMs = 10_000, report }) => {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let lastElu = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const elu = performance.eventLoopUtilization();
    const recent = performance.eventLoopUtilization(elu, lastElu);
    const { heapUsed, rss, external } = process.memoryUsage();
    report({
      elu: recent.utilization,
      delayP99Ms: delay.percentile(99) / 1e6,
      delayMaxMs: delay.max / 1e6,
      heapUsed,
      rss,
      external,
    });
    lastElu = elu;
    delay.reset();
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    delay.disable();
  };
};
```

On-demand CPU profile in production (`kill -USR2 <pid>`):

```js
const { Session } = require('node:inspector/promises');
const fsp = require('node:fs/promises');
const { setTimeout: sleep } = require('node:timers/promises');

const captureCpuProfile = async (durationMs, file) => {
  const session = new Session();
  session.connect();
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.start');
    await sleep(durationMs);
    const { profile } = await session.post('Profiler.stop');
    await fsp.writeFile(file, JSON.stringify(profile));
  } finally {
    session.disconnect();
  }
};

const installProfileSignal = (logger) => {
  let isProfiling = false;
  process.on('SIGUSR2', () => {
    if (isProfiling) return;
    isProfiling = true;
    const file = `cpu-${process.pid}-${Date.now()}.cpuprofile`;
    captureCpuProfile(10_000, file)
      .catch((error) => logger.error(error, 'CPU profile failed'))
      .finally(() => {
        isProfiling = false;
      });
  });
};
```

Pass an error to Pino as the first argument or under `err`: under any other
key, such as `{ error }`, it serializes to `{}`.

Leak regression test (`node --expose-gc --test`) for an abort listener that a
helper must remove:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');

const delay = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return void reject(signal.reason);
    let timer = null;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

test('delay does not accumulate abort listeners', async () => {
  const { signal } = new AbortController();
  for (let i = 0; i < 1000; i++) await delay(0, signal);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});
```

## Anti-patterns

| Avoid | Why | Instead |
| --- | --- | --- |
| Optimizing without a baseline number | Cannot prove a gain, risks regressions | Measure, change one thing, re-measure |
| Micro-optimizing I/O-bound handlers | Network/DB time dominates | Fix queries, parallelism, caching |
| All benchmark cases in one process | Shared ICs and heap bias later cases | One process per case |
| Single run, mean only, no warm-up | Measures tier-up and noise | Warm-up, many samples, median + spread |
| Ignoring the result in a benchmark | Dead-code elimination | Printed sink or checksum |
| `Date.now()` for micro timing | Low resolution, wall clock | `performance.now()`, `hrtime.bigint()` |
| `performance.mark` per request without clearing | Entries accumulate forever | Clear, or use histograms |
| Profiling with `--inspect` open in benchmarks | Overhead skews numbers | Profile and benchmark separately |
| Restarting on leak, raising `setMaxListeners` | Hides the retainer | Find it with snapshots, fix, add a test |
| Heap snapshots on a loaded prod instance | Long pause, memory spike, OOM | Drain first or use `--heap-prof`, near-limit snapshots |
| Unbounded module-level caches/maps | Classic leak | Size/TTL limits, LRU, `WeakMap` keyed by object |
| Exposing `--inspect` on `0.0.0.0` | Remote code execution | Localhost plus SSH tunnel |

## Checklist

- [ ] Metric, target, and environment written down before changes.
- [ ] Bottleneck classified (CPU, I/O, memory/GC, blocked loop) with ELU,
      loop delay, CPU%, heap/RSS trend evidence.
- [ ] Profile (CPU, heap sampling, or snapshots) identifies the top cause.
- [ ] Benchmarks: realistic inputs, process per case, warm-up, median and
      spread, results consumed, no profilers attached.
- [ ] Each change measured before/after; gains exceed run-to-run spread;
      V8-level fixes confirmed with `--trace-deopt`.
- [ ] Leak suspicion confirmed by rising post-GC `heapUsed` floor and
      three-snapshot comparison; retainer path found and fixed.
- [ ] Listeners, timers, AbortSignal handlers, caches, and handles have a
      bounded lifetime; leak regression test added.
- [ ] Telemetry exports ELU, loop delay, CPU, memory, GC; timers `unref()`ed;
      alerts on trends.
- [ ] Production profiling is on demand (signal, inspector session), the
      inspector port is never public.

Related skills: `js-conventions`, `node-event-loop`, `node-multithreading`,
`node-scaling-highload`, `node-tooling-testing`
