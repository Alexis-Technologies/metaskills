# HTTP proxies

Hardened shapes of a reverse proxy and a CONNECT tunnel, verified on Node.js 24. Both are written on
`node:http` to show what a proxy must do.

## Reverse proxy (gateway in front of an upstream service)

Verified: body and query forwarded, hop-by-hop headers and headers listed in `Connection` stripped,
`//evil.com/path` forwarded as a path to the fixed upstream (no SSRF), upstream timeout 504, refused
connection 502.

```js
const http = require('node:http');
const { pipeline } = require('node:stream/promises');

const UPSTREAM = { hostname: '127.0.0.1', port: 8001 };
const UPSTREAM_TIMEOUT_MS = 1000;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const listConnectionHeaders = (headers) => {
  const dropped = new Set();
  const listed = (headers.connection ?? '').toLowerCase().split(',');
  for (let i = 0; i < listed.length; i++) dropped.add(listed[i].trim());
  return dropped;
};

const filterHeaders = (headers) => {
  const dropped = listConnectionHeaders(headers);
  const result = {};
  const names = Object.keys(headers);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (HOP_BY_HOP.has(name) || dropped.has(name)) continue;
    result[name] = headers[name];
  }
  return result;
};

const forward = (req, res) => {
  const headers = filterHeaders(req.headers);
  const prior = req.headers['x-forwarded-for'];
  const ip = req.socket.remoteAddress;
  headers['x-forwarded-for'] = prior ? `${prior}, ${ip}` : ip;
  const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const options = { ...UPSTREAM, method: req.method, path: req.url, headers, signal };
  const upstream = http.request(options, (response) => {
    res.writeHead(response.statusCode, filterHeaders(response.headers));
    pipeline(response, res).catch(() => {});
  });
  upstream.on('error', (error) => {
    if (res.headersSent) return void res.destroy();
    const isTimeout = error.name === 'AbortError';
    res.writeHead(isTimeout ? 504 : 502, { 'Content-Type': 'text/plain' });
    res.end(isTimeout ? 'Gateway Timeout' : 'Bad Gateway');
  });
  pipeline(req, upstream).catch(() => {});
};

http.createServer(forward).listen(8002);
```

- Copy `response.statusCode` and filtered `response.headers` before piping. `response.pipe(res)` alone
  answers 200 with Node's default headers.
- Stream the request body (`pipeline(req, upstream)`). Buffering it, or forwarding it only for `POST`,
  breaks `PUT`, `PATCH` and large uploads.
- `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`: append for the upstream. When reading
  them, trust only addresses of your own proxies (`trustProxy` in Fastify).
- Use a dedicated `http.Agent({ keepAlive: true, maxSockets })` per upstream to bound concurrency, so
  an upstream outage cannot open unlimited sockets.
- WebSocket through a reverse proxy: handle `server.on('upgrade', (req, socket, head))` and pipe raw
  sockets, or terminate WebSocket at the balancer (`node-websocket-realtime`).

## Forward proxy with CONNECT tunnels

Verified: an authenticated tunnel works (`curl -p -x`), missing or wrong credentials 407, a target
outside the allowlist 403, refused upstream 502, plain requests 405.

```js
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');

const PORT = 8070;
const CRLF = '\r\n';
const ALLOWED = new Set(['127.0.0.1:8071', 'example.com:443']);
const AUTH_HEADER = Buffer.from(`Basic ${process.env.PROXY_CREDENTIALS_BASE64}`);

const isAuthorized = (header = '') => {
  const received = Buffer.from(header);
  if (received.length !== AUTH_HEADER.length) return false;
  return crypto.timingSafeEqual(received, AUTH_HEADER);
};

const reply = (socket, status) => {
  const lines = [`HTTP/1.1 ${status}`];
  if (status.startsWith('407')) lines.push('Proxy-Authenticate: Basic realm="proxy"');
  lines.push('Content-Length: 0', CRLF);
  socket.end(lines.join(CRLF));
};

const server = http.createServer((req, res) => {
  res.writeHead(405, { Allow: 'CONNECT' });
  res.end();
});

server.on('connect', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  if (!isAuthorized(req.headers['proxy-authorization'])) {
    return void reply(socket, '407 Proxy Authentication Required');
  }
  if (!ALLOWED.has(req.url)) return void reply(socket, '403 Forbidden');
  const { hostname, port } = new URL(`http://${req.url}`);
  const upstream = net.connect(Number(port), hostname, () => {
    socket.write(`HTTP/1.1 200 Connection Established${CRLF}${CRLF}`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => {
    if (socket.writable) reply(socket, '502 Bad Gateway');
    else socket.destroy();
  });
  socket.on('close', () => upstream.destroy());
});

server.listen(PORT);
```

- The `connect` event gives `(req, socket, head)`. `socket` is a `net.Socket`, not a response, and
  `head` may hold the first bytes of the tunnel.
- Reply `200 Connection Established` only after the upstream connects, so failures can still be
  reported as 502.
- An open proxy is an SSRF and abuse tool: authenticate, allowlist `host:port` pairs, and block
  private address ranges if targets are dynamic.
- Through a TLS tunnel only encrypted bytes are visible: you can count them, not read headers.
- When parsing raw HTTP yourself (a `net`-based proxy), split the head from the body at the first
  `\r\n\r\n` (`buffer.indexOf`), then split header lines. Never assume the body is the last line, and
  guard empty header values before `trim()`.
- Client side: `ProxyAgent` from undici sends requests through a proxy.
