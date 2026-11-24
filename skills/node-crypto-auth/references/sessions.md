# Sessions: revocable tokens, OAuth, scaling

## Session store with idle and absolute expiry

The store keys sessions by `sha256(token)`. Swap the `Map` for a repository of the DAL, or for Redis,
and keep the same operations.

```js
const crypto = require('node:crypto');

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('base64url');

class SessionStore {
  #sessions = new Map();
  #idleMs;
  #absoluteMs;

  constructor({ idleMs, absoluteMs }) {
    this.#idleMs = idleMs;
    this.#absoluteMs = absoluteMs;
  }

  create(token, accountId, data = {}) {
    const now = Date.now();
    const absoluteAt = now + this.#absoluteMs;
    const expiresAt = Math.min(now + this.#idleMs, absoluteAt);
    const session = { accountId, data, createdAt: now, expiresAt, absoluteAt };
    this.#sessions.set(hashToken(token), session);
    return session;
  }

  read(token) {
    const key = hashToken(token);
    const session = this.#sessions.get(key);
    if (!session) return null;
    const now = Date.now();
    if (session.expiresAt <= now || session.absoluteAt <= now) {
      this.#sessions.delete(key);
      return null;
    }
    session.expiresAt = Math.min(now + this.#idleMs, session.absoluteAt);
    return session;
  }

  rotate(oldToken, newToken) {
    const session = this.read(oldToken);
    if (!session) return null;
    this.#sessions.delete(hashToken(oldToken));
    this.#sessions.set(hashToken(newToken), session);
    return session;
  }

  delete(token) {
    return this.#sessions.delete(hashToken(token));
  }

  deleteByAccount(accountId) {
    for (const entry of this.#sessions) {
      if (entry[1].accountId === accountId) this.#sessions.delete(entry[0]);
    }
  }
}

module.exports = { SessionStore, hashToken };
```

Sweep expired entries on a timer (`setInterval(...).unref()`) so the `Map` does not grow without
bound. With MongoDB, a TTL index on `expiresAt` does the sweep, but it runs about once a minute, so
keep the expiry check in `read`. With Redis, `SET key value PX ttl` gives expiry for free.

Starting values: idle 2 hours, absolute 12 hours, 5 sessions per account, 20 per IP. Tune them to the
risk of the product.

## JWT as a revocable carrier

A JWT is accepted only when its signature is valid **and** its server-side record still exists:

```js
const authenticate = async ({ jwt, tokens }, bearer) => {
  const payload = await jwt.verify(bearer);
  const record = await tokens.findByHash(hashToken(bearer));
  const isLive = record !== null && record.expiresAt > Date.now();
  if (!isLive || record.userId !== payload.userId) return null;
  return { userId: record.userId, sessionId: record.sessionId };
};
```

Revocation is then a delete: `tokens.deleteBySession(sessionId)` or `tokens.deleteByUser(userId)`.

## Refresh rotation with reuse detection

```js
const refresh = async ({ tokens, sessions, issue }, refreshToken) => {
  const key = hashToken(refreshToken);
  const record = await tokens.consume(key);
  if (record === null) {
    const used = await tokens.findConsumed(key);
    if (used !== null) await sessions.revoke(used.sessionId);
    return null;
  }
  if (record.expiresAt <= Date.now()) return null;
  return issue(record.sessionId, record.userId);
};
```

`consume` must be atomic and leave a marker: `findOneAndUpdate({ key, consumedAt: null }, { $set: {
consumedAt: now } })`. A read followed by a delete lets two concurrent requests both spend one token.
Keep consumed rows until the token's original expiry, or reuse cannot be detected.

## OAuth or OIDC transaction

The transaction cookie binds the callback to the browser that started the flow. It must be `Lax`: a
`Strict` cookie is not sent on the return from the identity provider.

```js
const TX_COOKIE = '__Host-oauth_tx';
const TX_OPTIONS = { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600 };

const randomToken = () => crypto.randomBytes(32).toString('base64url');

const isSameSecret = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const beginSignIn = (reply, authorizeUrl) => {
  const state = randomToken();
  const verifier = randomToken();
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  reply.setCookie(TX_COOKIE, `${state}.${verifier}`, TX_OPTIONS);
  const url = new URL(authorizeUrl);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return reply.redirect(url.href);
};

const readTransaction = (request, reply) => {
  const raw = request.cookies[TX_COOKIE] ?? '';
  reply.clearCookie(TX_COOKIE, { ...TX_OPTIONS, maxAge: undefined });
  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  const state = raw.slice(0, dot);
  const received = request.query.state ?? '';
  return isSameSecret(state, received) ? { verifier: raw.slice(dot + 1) } : null;
};
```

`@fastify/oauth2` can manage `state` and PKCE for you. Its cookie defaults to `httpOnly` and
`sameSite: 'lax'` but **not** `secure`, so pass `cookie: { secure: true }`, and never set `Strict`.

| Flow | Callback | Keep the transaction in |
| --- | --- | --- |
| OAuth or OIDC code | cross-site `GET` | `SameSite=Lax` cookie |
| OIDC `form_post` | cross-site `POST` | server, keyed by `state`; or `SameSite=None; Secure` |
| SAML HTTP-Redirect | cross-site `GET` | `Lax` cookie, or server keyed by `RelayState` |
| SAML HTTP-POST | cross-site `POST` | server, keyed by `RelayState` or `InResponseTo` |

After a successful callback create a local session. A token from a third-party identity provider is
proof of identity, not your session: pin its algorithm, verify `iss`, `aud`, `exp`, `nbf` and the
nonce, then map the subject to a local, revocable session.

## Token transport

| Client | Carry token in | Notes |
| --- | --- | --- |
| Browser, no SSO | `HttpOnly` cookie | `SameSite=Strict` or `Lax`, `Secure`, `Path=/` |
| Browser, with SSO | `HttpOnly` cookie | `SameSite=Lax`, `Secure`, `Path=/` |
| Mobile, CLI, service | `Authorization: Bearer <token>` | never in the URL query |
| WebSocket from browser | cookie on upgrade | check `Origin` on upgrade |
| WebSocket, token known to client | first message, or the wrpc `authenticate` hook | close the socket if not restored in N seconds |

Tokens in URLs leak through logs, `Referer`, browser history and proxies.

## wrpc sessions

- `context.client.startSession(undefined, data)` creates a session. Over HTTP it also sends the
  cookie; over a WebSocket it does not, so log in over HTTP if the session must survive a reconnect.
- Set `sessions.cookie.secure` and `sameSite` for production, and replace `MemorySessionStore`.
- `context.session.state` writes through on top-level assignment only. Reassign a nested branch.
- `finalizeSession()` ends the session on every connection **of this instance**. Connections on other
  instances keep their copy until they reconnect or your app tells them, over the cluster or the
  rooms backplane.
- A store failure answers 503, not 403.

## Authentication subsystem

- One module owns authentication and exposes a storage-agnostic port: `createSession`, `readSession`,
  `rotateSession`, `revokeSession`, `revokeAccount`, `registerAccount`, `findAccount`. The DAL
  implements it, and tests use an in-memory fake.
- Collections: `accounts` (unique login), `credentials` (password hash, kept apart from the profile),
  `sessions` (account, device context, expiry), `tokens` (`sha256` of the token, session, type,
  expiry).
- A thin transport hook reads the cookie or header and attaches the identity through a declared
  decorator. Handlers never touch cookies or headers.
- Sign-in, registration and token refresh are the only public routes, and every other route requires
  a session and declares its access (see `node-access-control`).

## Scaling

- One session per browser across tabs. Different accounts in one browser need different cookie paths
  or a private window, not per-tab sessions.
- Keep sessions in shared storage and accept a lookup per request, with a short cache. A cache delays
  revocation by its TTL, so keep that TTL within what the product accepts, or invalidate through
  pub/sub.
- Sharding key: `HMAC(secret, token)` modulo shard count. A raw prefix lets an attacker send all
  forged tokens to one shard.

## Server record vs stateless JWT

| Concern | Token with a server record | Stateless JWT (not allowed for users) |
| --- | --- | --- |
| Revoke now (stolen device, role removed) | delete the record | impossible before `exp` |
| Data in token | none, or minimal claims | claims readable by anyone |
| Storage lookup per request | yes (cache it) | no |
| Failure modes | few | `alg: none`, key confusion, missing `aud` or `exp` checks |
