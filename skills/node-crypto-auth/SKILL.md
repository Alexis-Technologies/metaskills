---
name: node-crypto-auth
description: Password hashing, tokens, sessions, cookies, OAuth and SSO with node:crypto. Use when writing sign-in, storing secrets or reviewing auth code
---

# Node.js Crypto and Authentication

Build authentication from `node:crypto`: slow salted password hashes that carry their own parameters,
random tokens that the server can revoke at any moment, and constant-time comparisons.

|  | Library `@alexify/*` | App (`auth8`) |
| --- | --- | --- |
| Crypto | `node:crypto`, zero runtime deps | `node:crypto`; a vetted package for WebAuthn, TOTP, OAuth |
| Keys | Constructor options | 12-factor env, one schema (`node-config`), never logged |
| Sessions | Store is injected | MongoDB through the DAL, Redis as cache |
| Transport | Caller decides | `@fastify/cookie`, `Authorization: Bearer`, wrpc sessions |

More code: [references/sessions.md](references/sessions.md) (revocable tokens, OAuth, scaling),
[references/crypto-snippets.md](references/crypto-snippets.md) (HMAC, AES-GCM, random, TOTP),
[references/challenge-passkey.md](references/challenge-passkey.md) (passkeys).

## Rules

### Passwords

- Never store passwords or fast digests of them (`md5`, `sha1`, `sha256`, HMAC). A leaked table of
  fast hashes is equivalent to plain text because users reuse passwords across services.
- Hash with `crypto.scrypt` and a fresh `crypto.randomBytes(32)` salt per password. A random salt per
  hash defeats rainbow tables and makes equal passwords produce different hashes.
- **Policy: `N=2^17, r=8, p=1`, key length 64**, the OWASP minimum for scrypt and the policy of
  `auth8/packages/node/src/utils/crypto.ts`. Do not go below it.
- **Set `maxmem` to 256 MiB.** scrypt needs `128 * r * (N + p + 2)` bytes, just over 128 MiB here.
  Node's default of 32 MiB and a 64 MiB limit both throw a memory-limit error at this cost.
- `maxmem` is local policy. Never read it from the stored hash.
- Serialize parameters in the PHC form: `$scrypt$ln=17,r=8,p=1$<salt>$<hash>`, where `ln` is
  `log2(N)`. Verify with the parameters of the stored string, so old hashes keep working after you
  raise the cost, and rehash on the next successful login.
- **Stored parameters are untrusted.** An imported or tampered hash can ask for a huge `N` (memory
  DoS) or a tiny one (downgrade). Bound `N`, `r`, `p`, salt length and key length before deriving.
- `needsRehash` compares the whole canonical options string with the policy, so a change of `N`, `r`
  **or `p`** and any legacy format all trigger an upgrade.
- Always use async `scrypt` in request paths, never `scryptSync`. It runs on the libuv pool (4
  threads by default), so each concurrent sign-in holds 128 MiB and a pool thread for roughly
  150-300 ms, and starves `fs`, `dns` and `zlib`. Rate-limit sign-in and registration by IP and by
  login, and size container memory for the pool.
- Cap password length in the schema, so a megabyte-long password is refused before hashing.
- Default to scrypt. bcrypt is outdated (fixed memory cost, input truncated at 72 bytes). If a
  requirement asks for Argon2id (`crypto.argon2()`, Node.js 24.7+), add it as a second verifier keyed
  by the PHC algorithm id, so old hashes keep verifying.
- Export only `hashPassword`, `validatePassword` and `needsRehash`. Keep serialization private.

### Comparisons and secrets

- Compare secrets, MACs and hashes with `crypto.timingSafeEqual`. It throws `RangeError` on different
  lengths, so check `a.length === b.length` first and treat a mismatch as "invalid".
- Keep keys out of the repository and out of logs. Generate them with `crypto.randomBytes(32)`, load
  them from validated config (see `node-security`), give them an id, and support two active keys
  during rotation.

### Tokens, ids and randomness

- Opaque tokens are CSPRNG values: `crypto.randomBytes(32).toString('base64url')` (256 bits), with no
  user data, timestamps or counters inside. `Math.random()` is only for jitter, sampling and test data.
- Use `crypto.randomUUID()` (122 random bits) for request ids, session ids and storage names of
  uploaded files. Do not install `uuid`. For time-ordered database keys Node.js 26.1 has
  `crypto.randomUUIDv7()`; on 22 and 24 build one only when you need that ordering.
- Use `crypto.randomInt(min, max)` for unbiased integers (codes, shuffles).

### Sessions and revocation

**Every token can be revoked on the server, immediately.** This is the rule, whatever the format.

- A token is valid only while its server-side record exists and has not expired. Deleting the record
  is the revocation: sign-out, "log out other devices", a blocked account, a removed role.
- **Opaque token** is the default. **A JWT is allowed only as a signed carrier**: verify the
  signature first (a cheap filter), then look up its record on every request, as `auth8` does in its
  `authenticate` plugin. A JWT that is accepted on signature alone cannot be revoked before it expires,
  so it is not allowed for users.
- Store `sha256(token)` as the key, never the raw token, so a leaked collection holds no live
  credentials. Keep claims minimal: roles are read from the server, not trusted from the token.
- Pin the JWT algorithm, and verify `iss`, `aud`, `exp` and `nbf`. Keep access tokens short-lived.
- Rotate refresh tokens on every use and consume the old one atomically (`findOneAndDelete`). If a
  consumed refresh token comes back, it was stolen or replayed: revoke the whole session.
- Enforce an absolute lifetime and an idle timeout, and extend only the idle timer on use. Issue a new
  token on sign-in and on privilege change (session fixation). Revoke all of an account's sessions on
  password change.
- Limit concurrent sessions per account and per IP.
- **Live connections need revocation too.** In wrpc, `finalizeSession()` ends the session on this
  instance only. Other instances keep their copy until the client reconnects, so publish the
  revocation over the cluster or the rooms backplane.
- To reject forged tokens before a storage lookup, append an HMAC tag (`key.tag`). This is a cheap DoS
  filter, not authentication.

### Cookies and SameSite

Browser clients carry the token in an `HttpOnly; Secure; Path=/` cookie with the `__Host-` prefix. Do
not set `Domain` from the `Host` header. API clients use `Authorization: Bearer`, never a URL query.

**`SameSite=Strict` breaks identity-provider flows.** The return from an IdP is a navigation started
on another site. Measured in Chromium:

| Request                                 | `Strict` | `Lax` | `None; Secure` |
| --------------------------------------- | -------- | ----- | -------------- |
| IdP page links to the callback (`GET`)  | no       | yes   | yes            |
| 302 from that callback into the app     | **no**   | yes   | yes            |
| IdP page posts to the callback (`POST`) | no       | **no** | yes           |

- **OAuth or OIDC code flow:** the transaction cookie (`state`, PKCE verifier, nonce) is
  `SameSite=Lax`, short-lived and single-use. With `Strict` the callback cannot read it and every
  sign-in fails.
- **SAML HTTP-POST or OIDC `form_post`:** the callback is a cross-site `POST`, so `Lax` is not sent
  either. Prefer no cookie: keep the transaction on the server, keyed by `RelayState` or
  `InResponseTo`. If a cookie is required, use `SameSite=None; Secure`.
- **Session cookie of an app with SSO: `Lax`.** A `Strict` session cookie set in the callback is not
  sent on the redirect that follows, so the user looks signed out until the next same-site click. The
  same happens on any link from an email or another site.
- `Strict` remains a good choice for an app without SSO, or for a separate cookie that guards
  high-risk actions.
- `Lax` allows cross-site top-level `GET`, so `GET` must not change state, and writes must check
  `Origin` (see `node-security`).
- WebSocket: rely on the cookie sent with the upgrade (with `Origin` checked), or restore the session
  by token in the first message.

### Sign-in flows

- Return the same error for "unknown login" and "wrong password", and spend the same time: verify
  against a dummy hash when the account is missing.
- Write sign-in with a single success branch at the end. Every other path falls through to the
  failure, so one obvious success path is easy to audit.
- Require TOTP or a passkey as a second factor for admin and support accounts.
- OAuth: use the authorization code flow with PKCE, bind `state` to the browser through the
  transaction cookie, compare `redirect_uri` exactly, and validate the ID token. See
  [references/sessions.md](references/sessions.md).
- Challenge-response and passkeys: challenges are 32 random bytes, single-use, typed (`registration`
  or `authentication`), short-lived (about 5 minutes) and bound to the expected origin. Verify the
  signature over the exact bytes the client signed. See
  [references/challenge-passkey.md](references/challenge-passkey.md).
- Authorization is a separate subsystem: see `node-access-control`.

## Decision guide: hash, MAC, signature, encryption

| Need | Use | Node.js API |
| --- | --- | --- |
| Store a password | slow salted KDF | `crypto.scrypt` (or `crypto.argon2`) |
| Integrity of a file, cache key | fast digest | `crypto.createHash('sha256')` |
| Look up a stored token | fast digest of a random value | `crypto.createHash('sha256')` |
| Prove a server-issued value is genuine | MAC with a secret | `crypto.createHmac('sha256', key)` |
| Verify a webhook | MAC + constant-time compare | `createHmac` + `timingSafeEqual` |
| Prove who signed, verify with public key | signature | `crypto.sign` / `crypto.verify` |
| Read the value back later (PII, API keys) | authenticated encryption | `aes-256-gcm` via `createCipheriv` |

Never "encrypt" passwords, and never use a fast hash where you need a KDF or a MAC. A fast digest is
fine for a token only because the token is already 256 random bits.

## Patterns

### Password hashing with an upgrade path

```js
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const SCRYPT_POLICY = { N: 2 ** 17, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const SCRYPT_LIMITS = { minN: 2 ** 14, maxN: 2 ** 18, maxR: 32, maxP: 8 };
const SALT_BYTES = 32;
const SALT_MIN_BYTES = 16;
const KEY_BYTES = 64;
const KEY_MIN_BYTES = 32;
const HASH_PARTS = 5;

const encode = (buffer) => buffer.toString('base64').split('=')[0];

const canonicalOptions = ({ N, r, p }) => `ln=${Math.log2(N)},r=${r},p=${p}`;

const parseOptions = (options) => {
  const values = new Map();
  const items = options.split(',');
  for (let i = 0; i < items.length; i++) {
    const separator = items[i].indexOf('=');
    values.set(items[i].slice(0, separator), Number(items[i].slice(separator + 1)));
  }
  return values;
};

// OpenSSL counts the B and V blocks: 128 * r * (N + p + 2) bytes.
const requiredMemory = ({ N, r, p }) => 128 * r * (N + p + 2);

const toParams = (values) => {
  const N = values.has('ln') ? 2 ** values.get('ln') : values.get('N');
  const r = values.get('r');
  const p = values.get('p');
  const { minN, maxN, maxR, maxP } = SCRYPT_LIMITS;
  const isValidN = Number.isInteger(Math.log2(N)) && N >= minN && N <= maxN;
  const isValidR = Number.isInteger(r) && r >= 1 && r <= maxR;
  const isValidP = Number.isInteger(p) && p >= 1 && p <= maxP;
  if (!isValidN || !isValidR || !isValidP) throw new Error('Unsupported scrypt params');
  if (requiredMemory({ N, r, p }) > SCRYPT_MAXMEM) throw new Error('scrypt params exceed memory');
  return { N, r, p };
};

const deserializeHash = (phcString) => {
  const parts = phcString.split('$');
  if (parts.length !== HASH_PARTS || parts[1] !== 'scrypt') throw new Error('Unsupported hash');
  const params = toParams(parseOptions(parts[2]));
  const salt = Buffer.from(parts[3], 'base64');
  const hash = Buffer.from(parts[4], 'base64');
  if (salt.length < SALT_MIN_BYTES) throw new Error('Invalid salt length');
  if (hash.length < KEY_MIN_BYTES || hash.length > KEY_BYTES) throw new Error('Invalid hash length');
  return { params, salt, hash };
};

const derive = (password, salt, length, params) => {
  const options = { ...params, maxmem: SCRYPT_MAXMEM };
  return scrypt(password, salt, length, options);
};

const hashPassword = async (password) => {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, KEY_BYTES, SCRYPT_POLICY);
  return `$scrypt$${canonicalOptions(SCRYPT_POLICY)}$${encode(salt)}$${encode(hash)}`;
};

const validatePassword = async (password, phcString) => {
  const { params, salt, hash } = deserializeHash(phcString);
  const actual = await derive(password, salt, hash.length, params);
  return crypto.timingSafeEqual(actual, hash);
};

const needsRehash = (phcString) => {
  deserializeHash(phcString);
  return phcString.split('$')[2] !== canonicalOptions(SCRYPT_POLICY);
};

module.exports = { hashPassword, validatePassword, needsRehash };
```

It reads the legacy `N=32768,r=8,p=1,maxmem=...` dialect, ignores its stored `maxmem`, and flags it
for rehash.

### Sign-in: constant shape, single success branch, rehash

```js
const createAuth = ({ accounts, sessions, passwords }) => {
  const dummyHash = passwords.hashPassword(crypto.randomUUID());

  const signin = async ({ login, password }, { ip }) => {
    const account = await accounts.findByLogin(login);
    const hash = account ? account.passwordHash : await dummyHash;
    const isValid = await passwords.validatePassword(password, hash);
    if (isValid && account) {
      if (passwords.needsRehash(hash)) {
        const passwordHash = await passwords.hashPassword(password);
        await accounts.update(account.id, { passwordHash });
      }
      const token = crypto.randomBytes(32).toString('base64url');
      await sessions.create(token, { accountId: account.id, ip });
      return { token };
    }
    throw new DomainError('ALX_ERR_AUTH');
  };

  return { signin };
};
```

`DomainError` and the mapping of `ALX_ERR_AUTH` to 401 with one generic message come from `error-handling`.

### Cookies with Fastify

```js
const COOKIE_BASE = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
const SESSION_COOKIE = { ...COOKIE_BASE, maxAge: 12 * 60 * 60 };
const TRANSACTION_COOKIE = { ...COOKIE_BASE, maxAge: 10 * 60 };

const setSession = (reply, token) => reply.setCookie('__Host-token', token, SESSION_COOKIE);
const clearSession = (reply) => reply.clearCookie('__Host-token', COOKIE_BASE);
```

`__Host-` requires `Secure`, `Path=/` and no `Domain`. Browsers accept it on `http://localhost`.

## Anti-patterns

- `password` column with plain text, `md5(password)`, `sha256(salt + password)`, or one salt from
  config for all users.
- `salt:hash` without parameters: you cannot raise the cost later.
- scrypt below `N=2^17`, or a `maxmem` copied from the stored hash.
- A `needsRehash` that compares only `N` and `r`: a raised `p` never upgrades anything.
- `crypto.scrypt(..., (error, result) => { if (error) reject(error); resolve(...) })` without `return`
  after `reject`: on error it reads `result` and throws. Use `promisify`.
- Tokens from `Math.random()`, `Date.now()`, counters, or `base64(userId)`.
- `timingSafeEqual(Buffer.from(a), Buffer.from(b))` without a length check: short or multibyte input
  throws instead of returning false.
- Early `return` for unknown users before hashing: the response time tells an attacker which logins
  exist.
- A JWT accepted on its signature alone, or roles read from its claims: it cannot be revoked before
  it expires.
- Raw tokens stored in the database: a leak of that collection is a leak of live sessions.
- `SameSite=Strict` on the OAuth `state` cookie or on the session cookie of an SSO app.
- A session cookie without `HttpOnly` or `Secure`, or with `Domain` copied from `Host`.
- `uuid`, `bcrypt`, `crypto-js` or `jsonwebtoken` added by reflex: check `node:crypto` first.

## Checklist

- [ ] scrypt at `N=2^17, r=8, p=1` or stronger, random salt, parameters stored with the hash
- [ ] `maxmem` is a local constant; stored parameters are bounded before use
- [ ] Verification uses stored params and `timingSafeEqual`; rehash on login on any policy change
- [ ] No `scryptSync`, `pbkdf2Sync` or `argon2Sync` in handlers; sign-in is rate-limited
- [ ] Unknown login and wrong password give the same error and similar time
- [ ] Tokens are CSPRNG and stored hashed
- [ ] Every token, JWT included, is checked against a server-side record on each request
- [ ] Refresh tokens rotate, are consumed atomically, and reuse revokes the session
- [ ] Sessions have absolute and idle expiry, rotate on sign-in, end on sign-out and password change
- [ ] Revocation reaches live WebSocket connections on every instance
- [ ] Cookies `HttpOnly; Secure; Path=/`, no `Domain` from `Host`
- [ ] `SameSite=Lax` for OAuth transaction and SSO session cookies; SAML POST handled without `Lax`
- [ ] Every secret comparison is constant-time with a length check
- [ ] Encryption uses AES-256-GCM with a random 12-byte IV and checks the tag
- [ ] Admin accounts require a second factor

Related skills: `node-security`, `node-access-control`, `error-handling`, `alexis-libraries`
