# How Node.js works, where it fits, how to keep it current

The anatomy of Node.js, where it fits, and an upgrade checklist, for Node
22/24.

## Anatomy

- **V8** runs JavaScript (call stack, heap, GC, JIT, microtask queue). The
  engine is replaceable in principle; V8 is the default everywhere.
- **libuv** provides the event loop, non-blocking I/O over the OS
  (epoll, kqueue, IOCP), timers, and a thread pool (4 threads by default)
  for work the OS cannot do asynchronously (file system, `dns.lookup`,
  crypto, zlib).
- **C/C++ libraries**: OpenSSL, zlib, c-ares (DNS), llhttp (HTTP parser),
  and others, reached through Node's bindings.
- **Node standard library**: partly JavaScript, partly C++; loaded into the
  same V8 instance as your code and your npm dependencies. Your own code is
  usually a tiny fraction of what runs there.
- **Addons**: C/C++ or Node-API modules (any language, Rust included) that
  may start their own threads.

The life of `fs.readFile(path, callback)`: the call goes into the stdlib,
which hands the work to the libuv pool; when the read completes, libuv
queues the completion; the loop picks it up in the poll phase and calls
`callback(error, data)` on the JS stack (error-first, callback-last
contract). While the read is in flight the JS thread serves other requests.

## Core ideas

1. **Non-blocking I/O.** One thread serves many concurrent connections by
   filling the gaps while each request waits for the OS, a database or a
   remote API. This saves memory, OS threads and CPU context switches
   compared with process-per-request (CGI, classic Apache) or
   thread-per-request servers; Node is closer to nginx. Run about one
   process or worker per CPU core and confirm the number by measuring the
   real application on the real hardware.
2. **Long-lived processes.** State survives between requests: caches,
   preloaded models and configuration, database connection pools (take a
   connection, use it, return it). Initialization happens once.
3. **Less I/O beats async I/O.** Read-ahead, caching, write-behind and
   serving hot data from memory are faster than any I/O; but memory must
   then be protected because the process can crash.
4. **One address space for many users.** The cost of ideas 1 and 2: a
   blocked loop, a memory leak, a crash or a breach affects every user of
   the process. Blocking, error handling, security and isolation
   (processes > threads > V8 isolates > V8 contexts > closures, from heavy
   to light) need more attention than in process-per-request stacks.
5. **Server inside the application.** The process owns its HTTP server. In
   Alexis apps that is Fastify, composed from plugins with autoload and
   `fastify-plugin`; isolation and scaling come from replicas behind a load
   balancer.

## Where Node fits

| Fit | Examples |
| --- | -------- |
| Very good | API and web backends, SPA/PWA backends, BFF and SSR, WebSocket and TCP servers, chats, bots, game servers, integration services next to a legacy backend (collaborative editing, interactive features), crawlers and parsers, CLIs and build tooling |
| Possible, less common | Desktop apps (Electron), enterprise and database-centric systems, industrial automation, media streaming |
| Uncommon because the market is taken | CMS, e-commerce platforms, accounting |
| Poor | CPU-heavy computation, scientific modelling, hard real-time systems (no GC runtime can guarantee latency) |

For CPU-heavy parts inside an otherwise good fit: `worker_threads`, a
separate service, or WebAssembly.

```js
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';

const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2));

const runInWorker = async (n) => {
  const worker = new Worker(new URL(import.meta.url), { workerData: n });
  const messages = await once(worker, 'message');
  return messages[0];
};

if (isMainThread) console.log(await runInWorker(38));
else parentPort.postMessage(fib(workerData));
```

One worker per task shows the idea. Real services keep a fixed pool
(`node-multithreading`).

Performance claims need measurement. A process with light logic can serve tens
of thousands of requests per second, while transaction-heavy code can drop to
tens. A number means something only together with the concrete code.

Memory: V8 handles multi-gigabyte heaps when bulk data sits in typed
arrays or `Buffer`s; millions of small objects cause long GC pauses.
`SharedArrayBuffer` memory is outside the JS heap and can be shared
between threads.

## Myths vs real problems

- "Node is single-threaded": false (pool, V8 threads, workers) and not a
  problem for I/O-bound work.
- Callback hell / promise hell: a code-style problem; named functions and
  flat async/await solve it.
- Real problems: blocking code in legacy projects (big loops, huge
  `JSON.parse`/`stringify`), memory leaks, poor error handling (restarting
  via Docker or a process manager does not fix uncaught errors), shared
  address space, huge dependency trees (hundreds of MB of `node_modules`
  around kilobytes of own code).

## Version hygiene

- Run apps on an LTS line (even-numbered majors; 22 "Jod",
  24 "Krypton" and 26 "Lithium" at the time of writing; `process.release.lts`
  holds the codename) and check
  https://github.com/nodejs/release#release-schedule.
  Node 18 and 20 are end-of-life. Drop EOL lines quickly instead of keeping
  feature checks and fallbacks for old V8 versions. A library's `engines`
  floor is its own decision: read it before using a newer API.
- Check feature support per version on https://node.green/.
- Test on every supported line with a version manager (nvm, n, nvs).

### Upgrade checklist

- Use the `node:` prefix for every built-in module.
- Use `#private` fields instead of `_pseudoPrivate` names.
- `cluster.isPrimary` / `cluster.setupPrimary` instead of the `Master`
  names.
- `crypto.randomUUID()` instead of hand-made or third-party UUID v4.
- No `fs.exists`; use `fs.promises.access` (or `stat`) and treat errors as
  "absent", e.g. `const toBool = [() => true, () => false];` then
  `await fs.promises.access(file).then(...toBool)`.
- `fs.rm(path, { recursive: true })` instead of recursive `fs.rmdir`.
- Check `stream.destroyed` and listen for `'close'` instead of the
  `aborted` property and `'abort'`/`'aborted'` events on HTTP objects.
- `server.getConnections()` instead of `server.connections`.
- The WHATWG `URL` class instead of legacy `url.parse()`.
- `node:timers/promises`, `AbortController` and `AbortSignal` in I/O APIs,
  `events.once` / `events.on`, `node:stream/promises`.
- `AsyncLocalStorage` instead of the deprecated `domain` module or
  `zone.js`.
- `node:test` instead of a third-party runner where it is enough.
- Declare the entry point explicitly (`"main"` / `"exports"`).
- `events.getEventListeners()` instead of reading listener arrays.
- Unhandled promise rejections terminate the process (default since
  Node 15). Handle rejections where they occur; a global
  `process.on('unhandledRejection', ...)` is for logging and a controlled
  exit, not for keeping a broken process alive. See `error-handling`.
- Only integer values for `process.exit(code)` and `process.exitCode`.
- `timers.enroll()` / `timers.active()` are removed in Node 24.

### Built-ins and defaults before new dependencies

- `fetch` or `undici` instead of `request`, `axios`, `node-fetch`.
- `worker_threads` for CPU work, and replicas under the orchestrator for
  scaling, instead of `node:cluster`.
- `@fastify/websocket` (over `ws`) on the server and the native `WebSocket`
  (global client since Node 22) instead of `socket.io`.
- `crypto.scrypt` or `argon2` for password hashing instead of `bcrypt`.
- Docker (or the platform's supervisor) instead of `pm2` / `forever`.
- Fastify for HTTP services.
- `Intl` instead of `moment`; template literals instead of `ejs`.
- Native promises instead of `bluebird`; `fs.mkdir(path, { recursive })`
  instead of `mkdirp`.
- Newer built-ins worth checking first (present in Node 22 and 24):
  `Promise.withResolvers`, `AbortSignal.any`, `Array.fromAsync`,
  `URL.parse`, `process.loadEnvFile`, `util.styleText`.

Libraries have no runtime dependencies at all. For an app that needs one, check
repository activity (issues, pull requests, releases), run `pnpm audit` and a
vulnerability scanner, read the code of small dependencies, inspect their
transitive dependencies, and prefer fewer of them. See `node-modules-packages`
and `node-security`.
