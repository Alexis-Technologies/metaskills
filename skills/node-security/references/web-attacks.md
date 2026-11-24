# Web attack notes and patterns

## XSS: encode on output

```js
const HTML_ESCAPE = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeHtml = (value) => `${value}`.replace(/[&<>"']/g, (char) => HTML_ESCAPE[char]);
```

- This covers HTML text and quoted attribute values only. URLs in `href` or `src` need a scheme
  allow-list (`https:`, `mailto:`), never `javascript:`. Data placed into inline scripts should be
  JSON in a `<script type="application/json">` element read with `JSON.parse`, not string
  concatenation.
- Reflected XSS: a search box echoes `q` from the URL into the result page. Stored XSS: a chat
  message rendered with `innerHTML`. Both are solved by encoding at render time, plus CSP.
- A strict CSP (`default-src 'self'`, no `'unsafe-inline'`, nonces for the few inline scripts) turns
  most injection bugs into harmless text.

## CSRF

- Cookies are sent automatically with cross-site requests. A page on another site can submit a form
  or load an image to your URL.
- Defenses, combine at least two: no side effects on `GET`; `SameSite` session cookies; reject
  state-changing requests whose `Origin` (or `Referer` when `Origin` is absent) is not in your
  allow-list; a CSRF token for cookie-authenticated forms.
- `SameSite=Lax` still sends the cookie on a cross-site top-level `GET`, which is why `GET` must not
  change state. An app with SSO usually needs `Lax` (see `node-crypto-auth`), so the `Origin` check
  carries more weight there.

```js
const ALLOWED_ORIGINS = new Set(['https://app.example.com']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const isAllowedOrigin = (request) => {
  if (SAFE_METHODS.has(request.method)) return true;
  const { origin } = request.headers;
  return origin !== undefined && ALLOWED_ORIGINS.has(origin);
};
```

- A SAML or `form_post` callback is a legitimate cross-site `POST`. Exempt that one route from the
  `Origin` check, and protect it with the signed assertion and the single-use `state` or
  `InResponseTo`.
- WebSocket: browsers send `Origin` on the upgrade request. Check it before accepting, because
  cookies are attached to the upgrade (cross-site WebSocket hijacking). In wrpc set `cors.origins`:
  without it any origin is accepted.
- Synchronizer token: store a random token in the session, embed it in the page, require it in a
  header (`X-CSRF-Token`) on every state-changing request, compare with `timingSafeEqual`.

## CORS

- CORS relaxes the browser's same-origin policy. It never protects the server. Without CORS headers
  the browser still sends simple requests, it only hides the response.
- Allow-list exact origins, add `Vary: Origin` when the response depends on it, and send
  `Access-Control-Allow-Credentials: true` only with a specific origin, never with `*`.

## Open redirect

Redirect targets from query parameters (`?next=`) must be relative paths starting with a single `/`
(reject `//host` and `/\host`) or match an allow-list. Otherwise phishing links look like your
domain. In OAuth, compare `redirect_uri` with the registered value exactly.

## Uploads

- Generate the storage name (`randomUUID()`), keep the original name as metadata only, store outside
  the static root.
- Enforce size while streaming (do not trust `Content-Length`), limit the number of files and fields,
  check type by magic bytes, not by extension.
- Serve user files with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and
  ideally from a separate domain so an uploaded HTML or SVG cannot run scripts on your origin.

## SSRF guard for server-side fetches

IPv4 is a deny list. IPv6 is an allow list of global unicast, because the space around it holds many
ways to reach an internal IPv4.

```js
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const DENIED_V4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const DENIED_V6_RANGES = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
];

const createList = (ranges, family) => {
  const list = new net.BlockList();
  for (let i = 0; i < ranges.length; i++) list.addSubnet(ranges[i][0], ranges[i][1], family);
  return list;
};

const DENIED_V4 = createList(DENIED_V4_RANGES, 'ipv4');
const DENIED_V6 = createList(DENIED_V6_RANGES, 'ipv6');
const GLOBAL_V6 = createList([['2000::', 3]], 'ipv6');
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const isPublicAddress = (address, family) => {
  if (family === 4) return !DENIED_V4.check(address, 'ipv4');
  if (family !== 6) return false;
  return GLOBAL_V6.check(address, 'ipv6') && !DENIED_V6.check(address, 'ipv6');
};

const safeLookup = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return void callback(error);
    for (let i = 0; i < addresses.length; i++) {
      const { address, family } = addresses[i];
      if (isPublicAddress(address, family)) continue;
      return void callback(new Error(`Blocked address ${address} for ${hostname}`));
    }
    if (options.all) return void callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

const parsePublicUrl = (rawUrl) => {
  const url = new URL(rawUrl);
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) throw new Error(`Protocol ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(host);
  if (family !== 0 && !isPublicAddress(host, family)) throw new Error(`Blocked address ${host}`);
  return url;
};

const readBody = async (res, maxBytes) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const fetchExternal = (rawUrl, { timeoutMs = 5000, maxBytes = 1e6 } = {}) =>
  new Promise((resolve, reject) => {
    const url = parsePublicUrl(rawUrl);
    const client = url.protocol === 'https:' ? https : http;
    const signal = AbortSignal.timeout(timeoutMs);
    const options = { agent: false, lookup: safeLookup, signal };
    const req = client.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return void reject(new Error('Redirects are not followed'));
      }
      readBody(res, maxBytes).then(resolve, reject);
    });
    req.on('error', reject);
  });
```

With undici, give the guard its own `Agent` and keep the URL check, because undici also skips
`lookup` for an IP literal:

```js
const { Agent, request } = require('undici');

const guardedAgent = new Agent({ connect: { lookup: safeLookup } });

const fetchPublic = (rawUrl) => {
  const url = parsePublicUrl(rawUrl);
  return request(url, { dispatcher: guardedAgent, signal: AbortSignal.timeout(5000) });
};
```

`undici.request` does not follow redirects by default. Global `fetch` does: pass
`redirect: 'manual'`.

What each part stops, all run on Node.js 24:

| Input | Why it is dangerous | Stopped by |
| --- | --- | --- |
| `http://[::]:port/` | connects to loopback | not in `2000::/3` |
| `[64:ff9b::a9fe:a9fe]` | NAT64 form of `169.254.169.254` | not in `2000::/3` |
| `[::ffff:7f00:1]`, `[::127.0.0.1]` | mapped and compatible IPv4 | not in `2000::/3` |
| `[2002:7f00:1::]`, Teredo `2001:0::` | 6to4 and Teredo embed an IPv4 | `DENIED_V6` |
| `http://0x7f000001/`, `127.1`, `2130706433` | alternative IPv4 spellings | `URL` normalizes, then `isPublicAddress` |
| a name that resolves to `10.0.0.5` | classic SSRF | `safeLookup` |
| a name that rebinds after a check | DNS rebinding | the check runs in the socket's `lookup` |
| one public and one private answer | a socket may pick either | every address is checked |
| a pooled keep-alive socket | no `lookup` on reuse | `agent: false` or a dedicated `Agent` |

- An IPv6-only network with DNS64 reaches public IPv4 hosts through `64:ff9b::/96`, so this guard
  refuses them. There, decode the last 32 bits and run them through the IPv4 list instead of allowing
  the prefix.
- If you need redirects, follow them manually and run every hop through the same checks.
- A host allow-list is stronger than any range check. Use it when the set of partners is known.

## Error responses

Return a stable error code and a request id, and log the details server-side. A raw database error in
the response helps an attacker refine the payload.
