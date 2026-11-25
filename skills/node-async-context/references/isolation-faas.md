# Request isolation, sandboxes and serverless (FaaS)

## Why isolate request contexts

In one Node.js process, many requests run concurrently and share:

- the process itself: an uncaught error in one request can bring down all
  in-flight requests;
- the heap: a leak caused by one request type degrades every request;
- module-level state: caches, singletons, accidental globals;
- the OS environment: file descriptors, ports, credentials, env variables.

The goal is to isolate all of these (a failing request must not kill innocent
concurrent ones) while keeping Node's model of a long-lived process with
in-memory state, caches, open sockets and no per-request serialization.

## Isolation ladder (choose per granularity)

| Level                               | Cost                        | Isolates                                      | Use for                                         |
| ----------------------------------- | --------------------------- | --------------------------------------------- | ----------------------------------------------- |
| Objects / closures / frozen context | ~0                          | data, by discipline only                      | per-request state (default)                     |
| ALS store                           | small                       | data for cross-cutting reads                  | ids, logger, tracing                            |
| `vm` context (sandbox)              | ~0.2 ms to create           | globals and module scope of trusted code      | trusted plugins or modules                      |
| `worker_threads`                    | ms and MB per thread        | heap, event loop, globals; crash = one thread | tenants, CPU tasks                              |
| child process                       | tens of ms, separate memory | crash, memory limits, OS privileges           | untrusted plugins, external tools, other users  |
| container / VM                      | highest                     | OS, filesystem, network                       | services, tenants, security boundaries          |

Rules:

- `vm` is not a security boundary for hostile code. Use it to isolate your
  own or trusted code, so that nobody breaks out by accident (globals cannot
  leak to the host). Hostile code needs a process or a container, with the
  permission model, and still OS-level limits.
- Do not create a process (or a container) per request. That turns Node into
  CGI-style process-per-request and pays memory and context switches on
  every call. Containers scale the service; they do not isolate requests from
  each other.
- Separate classes of users (admin versus public) at the process or port
  level, so that privilege escalation needs more than one bug.

## vm sandbox pattern

```js
const vm = require('node:vm');

const CONTEXT_OPTIONS = { codeGeneration: { strings: false, wasm: false } };

const createSandbox = (api) => {
  const globals = { console, setTimeout, clearTimeout, ...api };
  return vm.createContext(Object.freeze(globals), CONTEXT_OPTIONS);
};

const loadHandler = (source, sandbox, filename) => {
  const script = new vm.Script(source, { filename });
  return script.runInContext(sandbox, { timeout: 1000 });
};

const sandbox = createSandbox({ db });
const getUser = loadHandler(
  'async ({ id }, context) => db.findUser(id, context.user)',
  sandbox,
  'api/getUser.js',
);

const context = Object.freeze({ requestId, user });
const result = await getUser({ id: 1 }, context);
```

- Pass dependencies in explicitly (IoC). The sandbox exposes only what the
  code may use: no `require`, `process` or `fs` unless deliberately wrapped.
- Disable `eval` and `new Function` with `codeGeneration.strings: false`.
- `timeout` only bounds synchronous execution. Bound async work with
  `AbortSignal.timeout()` or a timeout around the handler.
- Verified on Node 24: a handler that writes `globalThis.leak` never reaches
  the host global. The value does persist inside that sandbox for every later
  call, even when the context object is frozen. A sandbox shared by requests
  therefore isolates the app, not individual requests. Compile sources in
  strict mode (no implicit globals), keep handlers stateless and put
  per-request data in the `context` argument. Create a fresh context per
  call only when the code is not under your control.

## FaaS: why it is not the default, and how to write handlers anyway

The default position:

- FaaS reverses Node's design ("the web server inside the application",
  serving many concurrent contexts). It runs about one context per process,
  forbids in-memory state, removes long-lived sockets and WebSockets, adds
  cold starts and slow ramp-up, locks you into a vendor (balancer, gateway,
  databases), and becomes many times more expensive at sustained high load.
- It fits rare, small or scheduled tasks, and even those often fit on a small
  VM or in a BullMQ job.
- Do not migrate a layered app into handlers that mix HTTP, data access and
  business logic.
- Vendor starter guides teach one handler that does everything: `require`,
  `new Client()`, `connect()`, a query, header parsing and response formatting.
  That collapses the layers and pays connection setup on every call.

Anti-pattern (vendor-guide style):

```js
// BAD
exports.handler = async (event) => {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const id = event.pathParameters.id;
  const user = await client.db().collection('users').findOne({ cuid: id });
  return { statusCode: 200, body: JSON.stringify(user) };
};
```

Recommended shape:

```js
// users.repository.js - the client is created once per container, reused when warm
const { MongoClient } = require('mongodb');

const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 2 });
const collection = client.db().collection('users');
const projection = { _id: 0, cuid: 1, name: 1 };

const users = {
  findById: (id) => collection.findOne({ cuid: id }, { projection }),
};

module.exports = { users };
```

```js
// domain/getUser.js - transport-agnostic, receives explicit context
const { DomainError } = require('./errors.js');

const ID_PATTERN = /^[a-z0-9]{8,32}$/;

const getUser = async ({ id }, { users }) => {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new DomainError('ALX_ERR_VALIDATION', { message: 'Invalid id' });
  }
  return users.findById(id);
};

module.exports = getUser;
```

```js
// handler.js - thin adapter: event -> args + context -> result -> response
const { randomUUID } = require('node:crypto');

const { users } = require('./users.repository.js');
const getUser = require('./domain/getUser.js');

exports.handler = async (event) => {
  const id = event.pathParameters?.id;
  const requestId = event.requestContext?.requestId ?? randomUUID();
  const context = Object.freeze({ users, requestId });
  try {
    const user = await getUser({ id }, context);
    if (user) return { statusCode: 200, body: JSON.stringify(user) };
    const notFound = { code: 'ALX_ERR_NOT_FOUND', message: 'User not found' };
    return { statusCode: 404, body: JSON.stringify({ error: notFound }) };
  } catch (error) {
    if (error.code === 'ALX_ERR_VALIDATION') {
      const body = JSON.stringify({ error: { code: error.code, message: error.message } });
      return { statusCode: 400, body };
    }
    console.error({ requestId, error });
    const internal = { code: 'ALX_ERR_INTERNAL', message: 'Internal error', requestId };
    return { statusCode: 500, body: JSON.stringify({ error: internal }) };
  }
};
```

Only expected domain codes reach the client; anything else is logged with
the request id and answered with a generic 500 (`error-handling`). In an app,
validate with `@alexify/metaschema` (`js-contracts-schemas`) instead of the
inline pattern.

Rules for serverless code:

- Module scope holds only clients, pools and immutable config, never
  per-request data. Warm invocations reuse it, and some platforms run
  concurrent requests in one instance.
- Keep the domain layer free of vendor types (`event`, `context`, SDK
  clients). Wrap queues, storage and secrets in your own interfaces so you
  can move to VMs or containers later.
- Use ALS (or an explicit `context`) per invocation for request id and
  logging. Never rely on a module-level "current request".
- Size pools for the instance (`maxPoolSize` 1–2 per instance), because the
  platform multiplies instances, and the database sees instances × pool size
  connections.
- Keep the dependency graph small and lazy-load rare heavy dependencies once
  (cached at module level), since cold-start time grows with every require.
- Set explicit timeouts below the platform limit and release resources in
  `finally`.
