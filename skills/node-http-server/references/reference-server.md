# Reference server (node:http, no dependencies)

A complete single-file server for a zero-dependency library or for learning what a framework does.
An app uses Fastify (`references/fastify.md`). It combines the rules of `SKILL.md`: transport-free
application functions, an HTTP adapter, bounded JSON bodies, domain-code to status mapping,
traversal-safe streamed static files with ETag, 304 and HEAD, explicit timeouts, `clientError`, and
graceful shutdown.

Verified on Node.js 24: `/../secret.txt`, `/%2e%2e/secret.txt`, `/..%2fsecret.txt`,
`/..%2fstatic-secret%2fsecret.txt` (sibling-prefix attack), `%00` and broken escapes all return 404. A
2 MB body, with or without `Content-Length`, returns 413. Malformed JSON and a non-object body return
400. A thrown `Error` returns a generic 500 while the stack is logged. A wrong method returns 405, and
a garbage request line gets `400 Bad Request` from `clientError`.

```js
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const PORT = 8000;
const STATIC_ROOT = path.resolve(__dirname, 'static');
const MAX_BODY_BYTES = 1024 * 1024;

const logger = { error: (error) => void process.stderr.write(`${error.stack}\n`) };

// Application layer: plain async functions, no req/res, no HTTP codes

class DomainError extends Error {
  constructor(code, { message = code } = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

const users = new Map([['1', { id: '1', name: 'Marcus' }]]);

const api = new Map();

api.set('user/get', async ({ id }) => {
  const user = users.get(id);
  if (!user) throw new DomainError('ENOTFOUND', { message: 'User not found' });
  return user;
});

api.set('user/create', async ({ name }) => {
  if (typeof name !== 'string') {
    throw new DomainError('EVALIDATION', { message: 'Name expected' });
  }
  const user = { id: `${users.size + 1}`, name };
  users.set(user.id, user);
  return user;
});

// Transport layer: HTTP adapter over the application

const STATUS_BY_CODE = new Map([
  ['EVALIDATION', 400],
  ['EAUTH', 401],
  ['ENOTFOUND', 404],
]);

const MIME_TYPES = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['json', 'application/json'],
  ['txt', 'text/plain; charset=utf-8'],
  ['png', 'image/png'],
  ['svg', 'image/svg+xml'],
  ['ico', 'image/x-icon'],
]);
const DEFAULT_MIME = 'application/octet-stream';

class HttpError extends Error {
  constructor(statusCode, message = http.STATUS_CODES[statusCode]) {
    super(message);
    this.statusCode = statusCode;
  }
}

const parseUrl = (url) => {
  const index = url.indexOf('?');
  const pathname = index === -1 ? url : url.slice(0, index);
  const query = index === -1 ? '' : url.slice(index + 1);
  return { pathname, params: new URLSearchParams(query) };
};

const receiveBody = async (req, limitBytes) => {
  const declared = Number(req.headers['content-length']);
  if (declared > limitBytes) throw new HttpError(413);
  const chunks = [];
  let sizeBytes = 0;
  for await (const chunk of req) {
    sizeBytes += chunk.length;
    if (sizeBytes > limitBytes) throw new HttpError(413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const parseJson = (buffer) => {
  if (buffer.length === 0) return {};
  let value = null;
  try {
    value = JSON.parse(buffer.toString());
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  const isRecord = typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isRecord) throw new HttpError(400, 'JSON object expected');
  return value;
};

const sendJson = (res, statusCode, data) => {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': MIME_TYPES.get('json'),
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};

const serveApi = async (req, res, name, params) => {
  const method = api.get(name);
  if (!method) throw new HttpError(404);
  if (req.method !== 'POST' && req.method !== 'GET') throw new HttpError(405);
  const body = await receiveBody(req, MAX_BODY_BYTES);
  const args = { ...Object.fromEntries(params), ...parseJson(body) };
  const result = await method(args);
  sendJson(res, 200, result);
};

const resolveStatic = (pathname) => {
  let decoded = '';
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const name = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const filePath = path.resolve(STATIC_ROOT, `.${path.sep}${name}`);
  const isInside = filePath === STATIC_ROOT || filePath.startsWith(STATIC_ROOT + path.sep);
  return isInside ? filePath : null;
};

const serveStatic = async (req, res, pathname) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405);
  const filePath = resolveStatic(pathname);
  if (!filePath) throw new HttpError(404);
  const handle = await fsp.open(filePath).catch(() => null);
  if (!handle) throw new HttpError(404);
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    throw new HttpError(404);
  }
  const mtime = Math.trunc(stat.mtimeMs).toString(16);
  const etag = `W/"${stat.size.toString(16)}-${mtime}"`;
  if (req.headers['if-none-match'] === etag) {
    await handle.close();
    res.writeHead(304, { ETag: etag });
    return void res.end();
  }
  const extension = path.extname(filePath).slice(1).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES.get(extension) ?? DEFAULT_MIME,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ETag: etag,
  });
  if (req.method === 'HEAD') {
    await handle.close();
    return void res.end();
  }
  await pipeline(handle.createReadStream(), res);
};

const toStatus = (error) => {
  if (error instanceof HttpError) return error.statusCode;
  return STATUS_BY_CODE.get(error.code) ?? 500;
};

const handleError = (res, error) => {
  const statusCode = toStatus(error);
  if (statusCode >= 500) logger.error(error);
  if (res.headersSent) return void res.destroy();
  const message = statusCode < 500 ? error.message : 'Internal Server Error';
  if (statusCode === 413) res.setHeader('Connection', 'close');
  sendJson(res, statusCode, { error: message });
};

const listener = async (req, res) => {
  const { pathname, params } = parseUrl(req.url);
  try {
    if (pathname.startsWith('/api/')) {
      const name = pathname.slice('/api/'.length);
      await serveApi(req, res, name, params);
    } else {
      await serveStatic(req, res, pathname);
    }
  } catch (error) {
    handleError(res, error);
  }
};

const server = http.createServer({
  requestTimeout: 30_000,
  headersTimeout: 10_000,
  keepAliveTimeout: 65_000,
});

server.on('request', listener);

server.on('clientError', (error, socket) => {
  if (error.code === 'ECONNRESET' || !socket.writable) return void socket.destroy();
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.on('error', (error) => {
  logger.error(error);
  process.exit(1);
});

server.listen(PORT);

const shutdown = () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  const forceClose = () => {
    server.closeAllConnections();
    process.exit(1);
  };
  setTimeout(forceClose, 5000).unref();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

## Notes

- For larger APIs replace the `api.get(name)` lookup with the router from `references/router.md`.
- The same `api` can be attached to a WebSocket transport, where only the packet format differs. In
  the Alexis stack that transport is `@alexify/wrpc`.
- Pass `context` (session, request id, abort signal) as the second argument of application functions
  instead of attaching data to `req` (see `node-async-context` for `AsyncLocalStorage`).
- API responses also need `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, and explicit
  CORS headers: `Access-Control-Allow-Origin` restricted to known origins, not `*`, when cookies are
  used. See `node-security`. In Fastify these come from `@fastify/helmet` and `@fastify/cors`.

## HTTPS and HTTP/2 variants

```js
const fs = require('node:fs');
const https = require('node:https');
const http2 = require('node:http2');
const tls = require('node:tls');

const key = fs.readFileSync('./cert/key.pem');
const cert = fs.readFileSync('./cert/cert.pem');

// HTTPS: same (req, res) listener
https.createServer({ key, cert }, listener).listen(8443);

// Many domains on one port: SNI picks the certificate per hostname
const contexts = new Map([['example.com', tls.createSecureContext({ key, cert })]]);
const SNICallback = (servername, callback) => {
  const context = contexts.get(servername);
  if (!context) return void callback(new Error(`No cert: ${servername}`));
  callback(null, context);
};
https.createServer({ SNICallback }, listener).listen(9443);

// HTTP/2 with HTTP/1.1 fallback (ALPN), compatibility (req, res) API
http2.createSecureServer({ key, cert, allowHTTP1: true }, listener).listen(10443);
```

- Browsers speak HTTP/2 only over TLS. `allowHTTP1: true` keeps old clients and tools working with
  the same listener.
- The native `http2` stream API (`server.on('stream', (stream, headers))`, `headers[':path']`,
  `stream.respond()`) is faster but not compatible with `(req, res)` code. Keep the adapter boundary
  so either can be used.
- In production TLS is usually terminated at the balancer. Keep the listener protocol configurable.

## Cookie parsing

Verified: percent-decoding with fallback for broken escapes, pairs without `=` or without a name
skipped, null-prototype result. In a Fastify app use `@fastify/cookie` instead.

```js
const parseCookies = (header = '') => {
  const cookies = Object.create(null);
  const pairs = header.split(';');
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const name = pair.slice(0, index).trim();
    if (name === '') continue;
    const raw = pair.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }
  return cookies;
};
```

Build tokens and `Set-Cookie` values (including deletion with `Max-Age=0`) with the helpers in
`node-crypto-auth`, so cookie attributes are defined in one place.

- Production sessions live in a shared store with a per-process cache (`node-scaling-highload`).
- Do not put user data inside the token. An opaque token can be revoked by deleting one record.
