# Node.js Permission Model and sandboxing

## Permission Model: what it is

A process-wide, deny-by-default switch for selected capabilities. Node.js
docs call it a "seat belt": it stops trusted code from accidentally touching
files or spawning processes it was not granted; it does not protect against
malicious code. Stable (no `--experimental-` prefix) since Node.js 22.13.0
and 23.5.0; in Node.js 20 the flag was `--experimental-permission`.

## Flags (checked with `node --help` on Node.js 24.14)

| Flag | Grants |
| --- | --- |
| `--permission` | enables the model; everything below is denied unless allowed |
| `--allow-fs-read=<path>` | read; repeat the flag for several paths; `*` for all; relative paths resolve against cwd |
| `--allow-fs-write=<path>` | write, same syntax |
| `--allow-child-process` | spawn processes (prints a SecurityWarning) |
| `--allow-worker` | create worker threads (prints a SecurityWarning) |
| `--allow-addons` | load native addons |
| `--allow-wasi` | create WASI instances |
| `--allow-inspector` | use the inspector |

`--allow-inspector` does not exist on Node.js 22 ("bad option").

Network: on Node.js 22/24 there is no `--allow-net` ("bad option"), and
outbound and inbound sockets work under `--permission`. Network
restriction arrives in Node.js 25: on Node.js 26 (checked on 26.13)
`--permission` alone makes `listen`/`connect` throw `ERR_ACCESS_DENIED`,
so a server started with the flags above also needs `--allow-net` (prints
an ExperimentalWarning). Node.js 26 also has `--permission-audit`,
`--allow-openssl-store`, `--allow-ffi`, `--allow-fs-vfs` and
`process.permission.drop()`; check `node --help` for your exact version
before relying on them.

The entry script is readable implicitly. Quote wildcards in shells
(`'--allow-fs-read=*'`). A directory grant covers its contents; a trailing
`*` is a prefix match (`/home/test*` also matches `/home/test2`).

```bash
node --permission \
  --allow-fs-read=./config.json \
  --allow-fs-read=./worker.js \
  --allow-fs-write=./log/app.log \
  --allow-worker \
  app.js
```

## Runtime checks

```js
const hasPermission = (scope, reference) => {
  const { permission } = process;
  if (!permission) return true;
  return reference === undefined
    ? permission.has(scope)
    : permission.has(scope, reference);
};

if (hasPermission('fs.write', logFile)) await appendLog(logFile, line);
```

- `process.permission` is `undefined` when the model is off.
- Scopes: `fs.read`, `fs.write` (with optional path), `child`, `worker`,
  `addon`, `wasi`, `inspector` (and `net` on 26). On Node.js 22/24
  `has('net')` returns `false` even though networking is not restricted: do
  not use it as a signal there.
- A denied call throws `ERR_ACCESS_DENIED` with `error.permission` (for
  example `FileSystemRead`, `ChildProcess`, `WorkerThreads`) and
  `error.resource` (the path).

## Verified behavior and limits (Node.js 24.14)

- Workers and spawned `node` children were restricted as well in our test
  (reading an ungranted file failed in both).
- `--allow-child-process` lets code run any binary: `spawnSync('head',
  ['/etc/hosts'])` read a file that `fs` could not. Treat it as "full access".
- Symlinks inside a granted directory are followed to targets outside it
  (a link to `/etc/hosts` in an allowed folder was readable).
- Existing file descriptors bypass the model; files read at startup by
  flags such as `--env-file` are read before it is enforced.
- It does not limit CPU, memory or time, nor the network before 26.

Use it as defense in depth for your own code and dependencies (a
compromised package cannot read `~/.ssh` or write outside `./log`), combined
with OS-level isolation.

## node:vm is not a security boundary

What `vm` gives: a separate global object and built-ins, `timeout` for
synchronous code, `microtaskMode: 'afterEvaluate'` so the timeout also covers
promise jobs started during evaluation, and
`codeGeneration: { strings: false, wasm: false }` to forbid `eval`/`Function`
inside the context. It suits loading trusted application code with injected,
frozen namespaces: it is a structuring and DI tool.

Why it is not a sandbox (all verified on Node.js 24):

```js
const vm = require('node:vm');

const options = { codeGeneration: { strings: false, wasm: false } };

const leaky = vm.createContext({ console }, options);
const viaHostFunction = `console.log.constructor('return process')().pid`;
vm.runInContext(viaHostFunction, leaky);

const frozen = vm.createContext(Object.freeze({}), options);
const viaPrototype = `this.constructor.constructor('return process')()`;
vm.runInContext(viaPrototype, frozen);
```

- Any host function or object reachable from the context leads to the
  host `Function` constructor, which is not subject to the context's
  `codeGeneration` setting, and from there to `process` and `require`.
- Even an empty frozen object as the sandbox works as an escape route,
  because its prototype is the host `Object.prototype`. A
  `Object.create(null)` sandbox closes that particular path, but every
  value you inject reopens it.
- Asynchronous work (timers you pass in, promises outside
  `afterEvaluate`) escapes the `timeout`.
- The Node.js docs say it plainly: do not use `node:vm` to run untrusted
  code.

Options for untrusted code, weakest to strongest:

1. Do not run it: offer declarative configuration (JSON, schemas, a small
   expression language you interpret) instead of scripts.
2. A separate process (`child_process.fork`) started with `--permission`,
   minimal `--allow-fs-read`, no `--allow-child-process`, an explicit empty
   `env`, `--max-old-space-size`, a wall-clock kill timer, IPC with
   validated messages only. Workers (`resourceLimits`) bound memory but
   share the process and its OS rights.
3. A V8 isolate library such as `isolated-vm` (separate heap, memory
   limit, no Node.js APIs unless you copy them in).
4. OS isolation: containers or VMs with seccomp/AppArmor, read-only root,
   no network, cgroups for CPU and memory (gVisor/Firecracker style
   runtimes for multi-tenant code).

Combine 2 or 3 with 4 for anything exposed to the internet.

## Hardening flags worth knowing

| Flag | Effect |
| --- | --- |
| `--disallow-code-generation-from-strings` | `eval`/`new Function` throw `EvalError` |
| `--disable-proto=delete` or `=throw` | removes or blocks `Object.prototype.__proto__` (backstop for prototype pollution) |
| `--frozen-intrinsics` | experimental: freezes built-in prototypes |
| `--max-http-header-size=<bytes>` | header size cap (default 16 KiB) |
| `--enable-experimental-regexp-engine` | V8 flag: `/.../l` regexes use a linear-time engine (no backreferences or lookarounds) |

Test the application under each flag: some dependencies rely on `eval`,
`__proto__` or mutating built-ins.
