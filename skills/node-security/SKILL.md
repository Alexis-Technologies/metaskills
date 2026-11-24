---
name: node-security
description: Node.js security hardening for DoS, injection, XSS, CSRF, SSRF, secrets, supply chain. Use when writing or reviewing servers or outbound calls
---

# Node.js Application Security

Treat a Node.js process as one shared, privileged space serving every user at once. Apply concrete,
verifiable defenses at the boundary (limits, validation, encoding, least privilege) instead of
trusting framework defaults, hook order or the `vm` module.

|            | Library `@alexify/*`                     | App (`auth8`)                                                   |
| ---------- | ---------------------------------------- | --------------------------------------------------------------- |
| Limits     | Constructor options with safe defaults   | Fastify options, `@fastify/rate-limit`, `@fastify/under-pressure` |
| Headers    | None, unless it serves HTTP              | `@fastify/helmet`                                               |
| Secrets    | Passed in by the caller, never read from env | 12-factor env, one schema (`node-config`)                   |
| Outbound   | Injected client or `node:http`           | undici with a guarded `lookup`                                  |
| Data       | Driver is injected                       | Native `mongodb`, own DAL                                       |

Code for the rules below: [references/patterns.md](references/patterns.md). Attack notes and the SSRF
guard: [references/web-attacks.md](references/web-attacks.md). Permission Model and `vm`:
[references/permission-model-sandbox.md](references/permission-model-sandbox.md).

## Rules

### The shared process

- One process serves all users with one memory space, one set of OS rights, one DB pool and one
  network stack. Anything a request leaves in module scope, globals or a cached object can be read
  by the next user.
- Keep per-request data in an explicit call context (arguments, or `AsyncLocalStorage` when you
  must). Never put user data in module-level variables. In Fastify, declare what a request carries
  with `decorateRequest` and set it in one hook. Business logic stays out of hooks.
- Split privileged functionality (admin, infrastructure, config changes) into a separate process on
  a separate port, with its own OS user, DB role and allowed paths. The public process should be
  unable to do those things even if fully compromised.
- End every MongoDB session and transaction in `finally`, never keep a reference to it after that,
  and set `maxTimeMS` on queries. A leaked session or a slow query slowly drains the pool and takes
  the service down.
- A crash drops every connected user: handle errors per request, and shut down gracefully on fatal
  ones (see `node-graceful-shutdown`).

### Denial of service

- Limit every input: body size (Fastify `bodyLimit`, 1 MiB by default, answers 413), header size
  (`--max-http-header-size`, default 16 KiB), JSON depth and array length through the schema, number
  of files and parts in uploads, URL length.
- **Set server timeouts explicitly. Fastify turns one of them off.** Node.js defaults
  `requestTimeout` to 300 s, but Fastify overrides it with `0`, so a client that sends headers and
  then trickles the body is never closed by the server.
- `requestTimeout` alone is not enough. A slow body is closed at the **larger** of `requestTimeout`
  and `headersTimeout`, and Fastify leaves `headersTimeout` at 60 s. Set both, with `headersTimeout`
  at or below `requestTimeout`. Fastify takes it in the `http` option. Node.js checks on a
  `connectionsCheckingInterval` (30 s by default), so a close can lag by that much.
- Keep `keepAliveTimeout` above the balancer idle timeout (Fastify default 72 s; see
  `node-http-server`). Keep a reverse proxy or load balancer in front with its own limits.
- Bound concurrency and reply 503 instead of accepting unlimited work: `@fastify/under-pressure` in
  an app, the `queue` option of a wrpc procedure, or a small limiter in a library. Defense comes in
  layers: network, balancer, firewall, process.
- Rate-limit by route with `@fastify/rate-limit`, backed by Redis so the count spans instances.
  Sign-in needs a key of IP plus login. **A `keyGenerator` that reads `request.body` needs
  `hook: 'preHandler'`**: the default `onRequest` runs before parsing, so every login shares one
  counter and one user can lock out the rest.
- Bound outbound work too: every external call gets `AbortSignal.timeout()` and goes through a pool
  or queue, otherwise your users' load is amplified onto third-party services and your sockets run
  out.
- Never block the event loop in request paths: no `*Sync` fs, crypto or zlib, no `JSON.parse` or
  `JSON.stringify` of unbounded payloads, no CPU-heavy loops. Move CPU work to `worker_threads`.
  Password hashing is a DoS vector too (128 MiB per scrypt call under the policy in
  `node-crypto-auth`): rate-limit sign-in.
- ReDoS: never run a regex with nested or overlapping quantifiers (`(a+)+`, `(.*a){n}`,
  `(\w+\s?)+$`) on user input. Cap input length before matching, and prefer `URL`, `split`,
  `startsWith` and parsers for routing and validation. `/^(a+)+$/` on 26 `a`s plus `!` takes about
  a third of a second, and each extra character doubles it.
- Reject cheaply and early: authenticate in `onRequest`, before body parsing, and verify token tags
  before storage lookups.

### Injection

- **MongoDB operator injection** is the default risk here. A JSON body can put `{ "$ne": null }`
  where a string is expected and turn a lookup into "match anything". Validate types at the boundary
  with `@alexify/metaschema` (see `js-contracts-schemas`), reject unknown fields, and wrap values
  from users in `$eq`.
- Never pass user input to `$where`, `$function`, `$accumulator` or `$expr`, and never let a client
  supply a filter, a pipeline stage, a sort document or a field name. Map names through an
  allow-list. Run `mongod` with `security.javascriptEnabled: false` when nothing needs server-side
  JavaScript.
- Any other query language: bind parameters only, identifiers from an allow-list, no concatenation.
- Do not send database error messages or stack traces to clients. Log them with a request id and
  return a generic error (see `error-handling`).
- Shell: use `execFile` or `spawn` with an argument array, never `exec` or `shell: true` with user
  input. Pass an explicit `env` to children.
- Code: never `eval`, `new Function`, `vm.runIn*`, `setTimeout(string)` or template compilation on
  user input. Run with `--disallow-code-generation-from-strings` when dependencies allow it.

### Browser-facing attacks

- XSS: encode output for its context (HTML text, attribute, URL, JS). Use auto-escaping templates
  and `textContent`, never `innerHTML` with data. Sanitize user HTML with an allow-list sanitizer and
  send a Content-Security-Policy. `X-XSS-Protection` is obsolete: helmet sets it to `0`.
- Session cookies are `HttpOnly; Secure; SameSite` so injected scripts cannot read them. Which
  `SameSite` value depends on the sign-in flow: `Strict` breaks the return from an identity provider
  (see `node-crypto-auth`).
- CSRF: no state change on `GET`. State-changing calls are `POST`, `PUT`, `PATCH` or `DELETE` with a
  JSON body. Check `Origin` on them and on WebSocket upgrades, and add a CSRF token if cookies must
  work cross-site. Bearer-header auth is not exposed to CSRF. A side-effecting `GET` can also be
  abused for DoS by embedding it in `<img>` tags on a busy site.
- CORS: allow-list origins with `@fastify/cors`. Never reflect the request `Origin` blindly and never
  combine `*` with credentials.
- wrpc: **without `cors.origins` the WebSocket upgrade accepts any origin**, and browsers do not
  apply the same-origin policy to WebSockets. Set `cors.origins`, `cors.credentials` and
  `sessions.cookie.secure` / `sameSite` before production.
- Security headers: `@fastify/helmet` in an app, a small constant in a library.

### Files and paths

- Resolve the path, then require it to equal the root or start with `root + path.sep`. `path.join`
  alone does not protect, and `startsWith(root)` without the separator lets `/srv/static-private`
  pass for root `/srv/static`.
- Use `fs.realpath` on the result when the tree can contain symlinks, and re-check the prefix.
- Take the pathname by splitting `url` on `?` (`new URL(url, base)` turns `//host/x` into a host,
  see `node-http-server`) and decode it with `decodeURIComponent` inside `try`: malformed escapes
  throw `URIError`. `%2e%2e` and `..%2f` sequences must still be rejected by the prefix check.
- Store uploads under generated names (`crypto.randomUUID()`), keep the original name only as
  metadata, cap sizes, check type by content, and serve them with
  `Content-Disposition: attachment` from a separate origin when possible.

### Objects and deserialization

- Prototype pollution: `JSON.parse('{"__proto__": {...}}')` creates an own `__proto__` key. A naive
  deep merge, a `set(obj, 'a.b.c', value)` helper or nested assignment `obj[a][b] = value` with
  user-controlled keys then writes into `Object.prototype` for the whole process. Skip `__proto__`,
  `constructor` and `prototype` keys, use `Map` or `Object.create(null)` for user-keyed dictionaries,
  and validate shapes. Run with `--disable-proto=delete` (or `throw`) as a process-wide backstop.
- Never deserialize untrusted data with anything that can construct code or arbitrary types:
  `eval`-based formats, `node-serialize`, YAML with custom tags, `v8.deserialize` of client data. Use
  `JSON.parse` with a size limit followed by schema validation.

### Outbound requests (SSRF)

When the server fetches a URL derived from user input:

- Prefer a host allow-list. Allow only `http:` and `https:`, set a timeout and a response size cap,
  and do not follow redirects automatically.
- **Allow public ranges for IPv6 instead of listing private ones.** Accept only global unicast
  `2000::/3` minus its special blocks. A block list misses `::` (which reaches loopback), NAT64
  `64:ff9b::/96`, IPv4-compatible `::a.b.c.d`, 6to4 and Teredo, which all embed an internal IPv4.
- Check IP literals yourself: the socket skips `lookup` for them. `URL` normalizes `0x7f000001`,
  `127.1` and `2130706433` to `127.0.0.1` first, so check `url.hostname`.
- **Validate in the socket's `lookup`**, not before the request: a check followed by a second
  resolution is open to DNS rebinding. Refuse the name if any returned address is denied.
- **Do not share a connection pool with unguarded code.** A keep-alive socket is reused without
  calling `lookup`, so a pooled connection to an internal host bypasses the guard. Use `agent: false`
  or a dedicated undici `Agent`.
- Behind an egress proxy the proxy resolves the name, so it must enforce the same ranges.

Guard and tests: [references/web-attacks.md](references/web-attacks.md).

### Dependencies and supply chain

- Prefer built-ins: `fetch`, `node:test`, `crypto.randomUUID`, `util.parseArgs`, `fs.glob`,
  `structuredClone`, promises, `AbortSignal`, `WebSocket` client, Web Streams. Packages from the
  callback era (bluebird, async, request, uuid, many lodash helpers) add attack surface for no gain.
- Before adding a package: read its code and its transitive tree, check maintenance activity and
  issue responsiveness. Stars and download counts are the weakest signals. Watch for typosquatted
  names.
- Commit `pnpm-lock.yaml`, install with `pnpm install --frozen-lockfile`, and run
  `pnpm audit --audit-level high` in CI. Review what `pnpm audit --fix` changed before shipping: by
  default it adds `overrides`, which force a version on every dependent.
- pnpm does not run dependency build scripts unless they are approved. Keep the list in
  `allowBuilds` of `pnpm-workspace.yaml` short, and review each entry (`pnpm approve-builds`).
- Install scripts and runtime code of every dependency run with your rights: develop and build in
  containers, and never run installs with `sudo`.

### Secrets

- No secrets in the repository, images, logs, error messages or client bundles. Separate them per
  environment and rotate them.
- **App:** secrets come from the environment (12-factor, ADR-006). Validate them at startup with
  the config schema (`node-config`) and fail fast, read them only through that validated config, and inject them from the
  platform's secret manager rather than a committed file. No `NODE_ENV` branches.
- **Never log them.** Do not log `process.env` or the config object. Set Pino `redact` for
  `authorization`, `cookie` and every secret key.
- The environment is inherited: pass an explicit `env` to every child process, so a tool you spawn
  does not receive the signing keys.
- **Library:** never read `process.env`. Take keys as constructor options.
- Keep only what you need in memory, pass a key to the client that uses it, and prefer short-lived
  credentials obtained at runtime.

### Least privilege at runtime

- Run as a non-root user in a container with a read-only filesystem except for explicit data
  directories, bind to localhost behind the proxy, and give the DB role only the actions it needs.
- Use the Node.js Permission Model as a seat belt for trusted code:
  `node --permission --allow-fs-read=./ --allow-fs-write=./log app.js`. It is stable since
  Node.js 22.13 and 23.5 but does not restrict the network on Node.js 22 and 24. On Node.js 26
  `--permission` also denies sockets, so servers need `--allow-net`. `--allow-child-process` lets
  code bypass the file rules through other binaries.
- `node:vm` is not a security boundary. It isolates globals for trusted code, not hostile code: any
  host object passed in, and even the prototype of the sandbox object, leads back to the host realm
  and `process`. Run untrusted code in a separate process or container with the Permission Model, OS
  limits and timeouts.

## Anti-patterns

- `collection.findOne({ login: body.login, password: body.password })` with an unvalidated body:
  `{ "$ne": null }` signs in as the first user.
- `Fastify()` with default timeouts on a public port: a slow body holds a socket forever.
- `requestTimeout: 10_000` without `http: { headersTimeout }`: the real limit stays 60 s.
- `path.join(STATIC, url)` then `createReadStream`: `/%2e%2e/` serves your source. Resolve and
  prefix-check.
- Serving `./resources/${name}` with a client-supplied `name`: traversal for any signed-in user. Use
  generated ids.
- Global or module variables holding the "current user", or caches keyed by nothing.
- A security check in one hook that sets a flag for a later hook: a reordering silently disables it.
  Attach the rule to the route and fail closed.
- Regex-heavy routing or validation on raw user input.
- An SSRF check that resolves the name first and connects later, or a block list without `::`.
- `vm.runInNewContext(userCode, { console, require })` presented as a sandbox:
  `console.log.constructor('return process')()` escapes.
- `process.env.X` read all over the code base, config objects logged at startup, running as root
  with a DB user that may drop collections.

## Checklist

- [ ] Body, header, URL and upload limits set; 413 on overflow
- [ ] `requestTimeout` and `headersTimeout` both set, `keepAliveTimeout` above the balancer's
- [ ] Bounded concurrency with 503; timeouts on all outbound calls
- [ ] Sign-in rate-limited by IP and login, with `hook: 'preHandler'` for a body key
- [ ] No sync crypto, fs or zlib or unbounded JSON work in handlers; no vulnerable regexes
- [ ] Filters built from validated values; no client-supplied operators, stages or field names
- [ ] No `exec`, `shell: true`, `eval` or `new Function` with user input
- [ ] Inputs validated against schemas; unknown keys rejected; `__proto__`-safe merging
- [ ] Output encoded per context; CSP set; cookies `HttpOnly; Secure; SameSite`
- [ ] No side effects on GET; `Origin` checked on writes and WebSocket upgrades; CORS allow-list
- [ ] wrpc has `cors.origins` and secure session cookie settings
- [ ] File paths resolved, separator-prefix-checked, realpath-checked; uploads use generated names
- [ ] Server-side fetches pass an SSRF guard with its own connection pool
- [ ] Lockfile committed, `--frozen-lockfile`, `pnpm audit` in CI, `allowBuilds` reviewed
- [ ] Secrets validated at startup, redacted in logs, explicit `env` for children
- [ ] Process runs as non-root with minimal FS and DB rights; admin APIs in a separate process
- [ ] Untrusted code never runs in `vm` alone

Related skills: `node-crypto-auth`, `node-access-control`, `node-http-server`,
`node-graceful-shutdown`, `js-contracts-schemas`, `error-handling`
