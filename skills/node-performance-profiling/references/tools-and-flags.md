# Tools, flags and APIs (verified on Node.js 24.14)

## CLI flags

| Flag | Output / use |
| --- | --- |
| `--cpu-prof`, `--cpu-prof-dir=dir`, `--cpu-prof-name=f`, `--cpu-prof-interval=us` | `.cpuprofile` written at exit; open in DevTools Performance panel or VS Code |
| `--heap-prof`, `--heap-prof-dir=dir`, `--heap-prof-interval=bytes` | Sampling allocation profile `.heapprofile` (DevTools Memory panel) |
| `--heapsnapshot-signal=SIGUSR2` | Writes `Heap.*.heapsnapshot` when the signal arrives |
| `--heapsnapshot-near-heap-limit=N` | Up to N snapshots when the heap approaches its limit (OOM forensics) |
| `--diagnostic-dir=dir` | Directory for profiles, snapshots, reports |
| `--prof` then `node --prof-process isolate-*.log` | V8 tick profiler, text bottom-up summary incl. GC and C++ |
| `--perf-basic-prof` | Symbol map for Linux `perf` flame graphs of JS + native |
| `--inspect[=127.0.0.1:9229]`, `--inspect-brk`, `--inspect-wait` | DevTools / VS Code debugger and profilers |
| `--report-on-signal`, `--report-on-fatalerror`, `--report-dir=dir` | JSON diagnostic report: JS/native stacks, libuv handles, resource usage |
| `--trace-gc`, `--trace-gc-nvp`, `--trace-gc-verbose` | One line per GC: `Scavenge` (young) / `Mark-Compact` (full), heap before -> after, pause ms |
| `--expose-gc` | `globalThis.gc()` for experiments and leak tests (not production) |
| `--max-old-space-size=MB`, `--max-semi-space-size=MB` | Old-generation limit; young-generation size (bigger can reduce scavenges for allocation-heavy code) |
| `--trace-opt`, `--trace-deopt`, `--trace-file-names` | Tier-up and deopt events (see `v8-verify.md` in `js-conventions`) |
| `--allow-natives-syntax` | `%GetOptimizationStatus` and friends, experiments only |

Reading `--trace-gc`:

```text
[39665:0x758e000000]   11 ms: Scavenge 7.8 (10.8) -> 6.8 (14.0) MB,
  pooled: 0 MB, 1.21 / 0.00 ms (average mu = 1.000, current mu = 1.000)
  allocation failure;
[39670:0x7a2080c000]   10 ms: Mark-Compact 3.4 (5.4) -> 3.2 (6.1) MB,
  pooled: 0 MB, 1.08 / 0.00 ms (average mu = 0.853, current mu = 0.853)
  testing; GC in old space requested
```

(One line per GC in real output.) Used heap (committed) before -> after, pause
time, mutator utilization (`mu`, share of time not spent in GC), and the
reason. Frequent scavenges = allocation pressure; Mark-Compact that frees
little = live data growing (possible leak); long Mark-Compact pauses or low
`mu` = big old generation or GC thrashing near the heap limit.

## process and v8 APIs

| API | Fields / use |
| --- | --- |
| `process.memoryUsage()` | `rss` (resident), `heapTotal` (V8 committed), `heapUsed` (live + garbage), `external` (C++ objects bound to JS, incl. Buffers), `arrayBuffers` (ArrayBuffer/Buffer backing stores, part of external) |
| `process.memoryUsage.rss()` | Cheap RSS only |
| `process.cpuUsage(prev)` | `{ user, system }` microseconds since `prev` |
| `process.resourceUsage()` | `userCPUTime`, `systemCPUTime`, `maxRSS`, page faults, context switches |
| `process.availableMemory()`, `process.constrainedMemory()` | Memory available to the process / cgroup limit |
| `v8.getHeapStatistics()` | `used_heap_size`, `heap_size_limit`, `external_memory`, `number_of_detached_contexts` |
| `v8.getHeapSpaceStatistics()` | Per space: `new_space`, `old_space`, `code_space`, `large_object_space`, ... |
| `v8.writeHeapSnapshot(file)` | Synchronous snapshot, returns file name |
| `v8.setFlagsFromString()` | Runtime V8 flags; avoid in production |
| `process.report.writeReport()` | Diagnostic report on demand |

## perf_hooks APIs

| API | Notes |
| --- | --- |
| `performance.now()`, `performance.timeOrigin` | Monotonic ms with fractions |
| `performance.mark(name)`, `performance.measure(name, start, end)` | Kept in a buffer until `clearMarks()`/`clearMeasures()` |
| `new PerformanceObserver(cb).observe({ type })` | Types: `'mark'`, `'measure'`, `'function'`, `'gc'`, `'http'`, `'net'`, `'dns'`, `'resource'` |
| `performance.timerify(fn)` | Emits `'function'` entries per call |
| `monitorEventLoopDelay({ resolution })` | `IntervalHistogram` in ns: `enable`, `disable`, `reset`, `min`, `max`, `mean`, `stddev`, `percentile(p)` |
| `performance.eventLoopUtilization(a, b)` | `{ idle, active, utilization }`; delta between readings |
| `createHistogram()` | `record(int)`, `percentile`, `count`; for your own latencies |
| `performance.nodeTiming` | Startup milestones (`nodeStart`, `v8Start`, `bootstrapComplete`, ...) |
| GC entry `detail.kind` | `constants.NODE_PERFORMANCE_GC_MINOR`, `_MAJOR`, `_INCREMENTAL`, `_WEAKCB` |

## Runtime monitor (full version)

```js
const perfHooks = require('node:perf_hooks');

const { performance, monitorEventLoopDelay, PerformanceObserver, constants } = perfHooks;

const NS_PER_MS = 1e6;
const BYTES_PER_MB = 1024 * 1024;

const toMb = (bytes) => Math.round((bytes / BYTES_PER_MB) * 10) / 10;

const createRuntimeMonitor = ({ intervalMs = 10_000, report }) => {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  const gc = { minorMs: 0, majorMs: 0, count: 0 };
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.count++;
      if (entry.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) {
        gc.majorMs += entry.duration;
      } else {
        gc.minorMs += entry.duration;
      }
    }
  });
  let lastElu = performance.eventLoopUtilization();
  let lastCpu = process.cpuUsage();
  let lastTime = performance.now();

  const sample = () => {
    const elu = performance.eventLoopUtilization();
    const cpu = process.cpuUsage(lastCpu);
    const now = performance.now();
    const memory = process.memoryUsage();
    const elapsedMs = now - lastTime;
    report({
      elu: performance.eventLoopUtilization(elu, lastElu).utilization,
      cpuPercent: ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100,
      loopDelayP50Ms: delay.percentile(50) / NS_PER_MS,
      loopDelayP99Ms: delay.percentile(99) / NS_PER_MS,
      loopDelayMaxMs: delay.max / NS_PER_MS,
      gcCount: gc.count,
      gcMinorMs: gc.minorMs,
      gcMajorMs: gc.majorMs,
      rssMb: toMb(memory.rss),
      heapUsedMb: toMb(memory.heapUsed),
      heapTotalMb: toMb(memory.heapTotal),
      externalMb: toMb(memory.external),
      arrayBuffersMb: toMb(memory.arrayBuffers),
    });
    lastElu = elu;
    lastCpu = process.cpuUsage();
    lastTime = now;
    delay.reset();
    gc.count = 0;
    gc.minorMs = 0;
    gc.majorMs = 0;
  };

  delay.enable();
  gcObserver.observe({ type: 'gc' });
  const timer = setInterval(sample, intervalMs);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      delay.disable();
      gcObserver.disconnect();
    },
  };
};

module.exports = { createRuntimeMonitor };
```

Wire `report` to your metrics backend (Prometheus gauges/histograms,
OpenTelemetry, logs). Interpretation:

- ELU sustained above ~0.7 (CPU near 100% of a core): CPU-bound or blocked
  loop; take a CPU profile. 0.1-0.3 is a healthy range.
- Loop delay p99/max far above p50: occasional long synchronous tasks.
- `gcMajorMs` growing and `heapUsedMb` floor rising: retention; take snapshots.
- `arrayBuffersMb`/`externalMb` growing while heap is flat: Buffers retained
  (caches of file contents, unconsumed streams).
- RSS growing with flat heap and external: native addon, thread stacks,
  allocator fragmentation; compare `process.report` handle counts.

## DevTools workflow

CPU:

1. `node --inspect app.js`, open `chrome://inspect`, "Open dedicated DevTools
   for Node" (or load a `.cpuprofile` into the Performance panel).
2. Start recording, apply the load, stop after 10-30 s.
3. Bottom-up by self time: the top entries are the hot functions; `(garbage
   collector)` high means allocation pressure; `(program)`/`(idle)` high means
   waiting (I/O-bound).
4. Long single bars in the flame chart = event-loop blocking tasks.

Memory:

1. Memory panel: "Heap snapshot" for retention, "Allocations on timeline" or
   "Allocation sampling" for who allocates.
2. Three-snapshot technique (see `memory-leaks.md`); Comparison view shows
   `# New`, `# Deleted`, `# Delta`, `Size Delta` per constructor.
3. Select a suspect object, read the Retainers pane bottom-up to the GC root
   (a module-scope variable, `(Global handles)`, a listener array, a timer
   list, a closure `context`).
4. Distance and retained size help: a small object with huge retained size is
   the root of the leaked graph.

## Load generation and macro benchmarks

- HTTP: autocannon (`pnpm exec autocannon -c 100 -d 30 http://127.0.0.1:8000/`)
  for quick throughput checks, k6 for scripted scenarios, wrk. Report latency
  percentiles and errors, not only req/s.
- Warm the server first, run several 30-60 s rounds, keep the client on a
  separate machine or core set when possible.
- Compare branches with the same script, data set, and Node version.
