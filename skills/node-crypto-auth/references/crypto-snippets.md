# node:crypto snippets

All snippets were run on Node.js 24.

## Webhook signature (HMAC over the raw body)

```js
const crypto = require('node:crypto');

const verifyWebhook = (secret, rawBody, signatureHex) => {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(`${signatureHex}`, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
};
```

Compute the MAC over the raw body bytes before JSON parsing (re-serialized JSON differs), and reject
stale timestamps if the provider signs one.

## Opaque token with an HMAC tag

```js
const TAG_BYTES = 8;

const createSigner = (secret) => {
  const sign = (key) => {
    const hmac = crypto.createHmac('sha256', secret).update(key);
    return hmac.digest().subarray(0, TAG_BYTES).toString('base64url');
  };

  const generate = () => {
    const key = crypto.randomBytes(32).toString('base64url');
    return `${key}.${sign(key)}`;
  };

  const verify = (token) => {
    if (typeof token !== 'string' || token.length > 128) return false;
    const dot = token.indexOf('.');
    if (dot < 1) return false;
    const expected = Buffer.from(sign(token.slice(0, dot)));
    const actual = Buffer.from(token.slice(dot + 1));
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  };

  return { generate, verify };
};
```

`verify()` runs before any session lookup and rejects forged tokens cheaply. It does not replace the
lookup: only the server-side record makes a token valid and revocable.

## AES-256-GCM (encrypt data you must read back)

```js
const IV_BYTES = 12;
const TAG_LENGTH = 16;

const encrypt = (key, plaintext) => {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const head = cipher.update(plaintext, 'utf8');
  const data = Buffer.concat([head, cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString('base64url');
};

const decrypt = (key, encoded) => {
  const buffer = Buffer.from(encoded, 'base64url');
  const iv = buffer.subarray(0, IV_BYTES);
  const tag = buffer.subarray(IV_BYTES, IV_BYTES + TAG_LENGTH);
  const data = buffer.subarray(IV_BYTES + TAG_LENGTH);
  const options = { authTagLength: TAG_LENGTH };
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, options);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString();
};
```

- `key` is 32 random bytes from validated config. Never derive it from a short string without a KDF
  (`crypto.scrypt` or `crypto.hkdf`).
- Never reuse an IV with the same key. Random 12 bytes per message is fine up to about 2^32 messages
  per key.
- `decipher.final()` throws when the ciphertext or tag was modified. Treat it as "invalid", not as a
  server error.
- Prefix the output with a key id when you plan key rotation.

## Random values

```js
const token = crypto.randomBytes(32).toString('base64url');
const id = crypto.randomUUID();
const otp = `${crypto.randomInt(0, 1_000_000)}`.padStart(6, '0');
const hex = crypto.randomBytes(16).toString('hex');
```

`randomInt(min, max)` excludes `max` and needs `max - min < 2 ** 48`.
`randomUUID({ disableEntropyCache: true })` skips the internal batch of pre-generated UUIDs (about 20
times slower).

For a key from a custom alphabet, pick each character with `crypto.randomInt`. It is unbiased but slow
per character. Encoding random bytes as `base64url` or `hex` is faster and gives a known entropy (6
bits per base64url char, 4 per hex char).

## Random prefetcher for bulk floats

```js
const UINT32_MAX = 0xffffffff;
const BUFFER_BYTES = 1024 * Uint32Array.BYTES_PER_ELEMENT;

const createPrefetcher = () => {
  const buffer = crypto.randomBytes(BUFFER_BYTES);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let position = 0;
  return () => {
    if (position === buffer.length) {
      crypto.randomFillSync(buffer);
      position = 0;
    }
    const value = view.getUint32(position, true);
    position += Uint32Array.BYTES_PER_ELEMENT;
    return value / (UINT32_MAX + 1);
  };
};

const cryptoRandom = createPrefetcher();
```

One OpenSSL call fills 1024 values, which is about 100 times faster than `randomBytes(4)` per call.
Use it for bulk floats, `randomInt` for unbiased integers, and plain `randomBytes(32)` for tokens (one
call per sign-in is cheap). Prefetched bytes sit in memory until used, the same trade-off
`randomUUID()` makes.

## UUIDv7-like time-ordered id

Node.js 26.1+ ships `crypto.randomUUIDv7()` (its docs warn that ordering follows the wall clock, which
is not monotonic). On 22 and 24 build it yourself. Layout: 48-bit Unix milliseconds (big-endian),
4-bit version `7`, 12-bit sequence or random, 2-bit variant `10`, 62 random bits. Encode as hex with
dashes (standard) or `base64url` (22 chars). Keep generation monotonic within one millisecond
(increment the sequence, wait for the next ms on overflow). Use only for database keys that benefit
from ordering: it leaks creation time, so do not use it as a secret token.

## TOTP outline (RFC 6238)

- Secret: 20 random bytes, shown to the user as base32 in an `otpauth://totp/...` URI (QR code). Store
  it encrypted.
- Code: `counter = floor(now / 30s)` as 8-byte big-endian; `hmac = HMAC-SHA1(secret, counter)`; dynamic
  truncation (`offset = hmac[19] & 0x0f`, 31-bit integer from 4 bytes), modulo 10^6.
- Accept the current step and one step either side, remember the last used counter per account to
  block replays, and rate-limit attempts.

## Hash a file stream

```js
const { pipeline } = require('node:stream/promises');
const fs = require('node:fs');

const hashFile = async (filePath) => {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
};
```

md5 is fine for change detection, not for anything an attacker can influence.
