# Challenge-response sign-in and passkeys (WebAuthn)

The ceremonies need only `node:crypto` on the server and Web Crypto or
`navigator.credentials` in the browser. The server stores public keys only,
so a database leak exposes no password-equivalent. In an app, a vetted library
such as `@simplewebauthn/server` (used by `auth8`) covers the WebAuthn parsing;
the rules below still apply.

## Common server pieces

```js
const crypto = require('node:crypto');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const challenges = new Map();

const issueChallenge = (type, payload = {}) => {
  const challenge = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  challenges.set(challenge, { ...payload, type, expiresAt });
  return challenge;
};

const consumeChallenge = (challenge, type) => {
  const entry = challenges.get(challenge);
  challenges.delete(challenge);
  const valid = entry?.type === type && entry.expiresAt > Date.now();
  if (!valid) throw new Error('Invalid or expired challenge');
  return entry;
};
```

- Delete the challenge before checking it: a replayed response always fails.
- Type the challenge (`registration` vs `authentication`) so a response from
  one ceremony cannot be used in the other.
- Sweep expired challenges periodically; cap how many a single IP can open.
- With several instances keep challenges in Redis and consume them with the
  atomic `GETDEL`, so one challenge cannot be spent twice.

## Challenge-response with Web Crypto (no WebAuthn)

Browser: `crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' })`,
store the private key as a non-extractable `CryptoKey` in IndexedDB, send the
SPKI public key at registration, then
sign `JSON.stringify({ type, origin, challenge, credentialId })`.

Server verification:

```js
const ORIGIN = 'https://app.example.com';

const verifySignIn = ({ clientData, signature }, publicKeySpki) => {
  const bytes = Buffer.from(clientData, 'base64url');
  const data = JSON.parse(bytes.toString('utf8'));
  if (data.origin !== ORIGIN) throw new Error('Unexpected origin');
  consumeChallenge(data.challenge, 'authentication');
  const key = crypto.createPublicKey({
    key: Buffer.from(publicKeySpki, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  const sig = Buffer.from(signature, 'base64url');
  const options = { key, dsaEncoding: 'ieee-p1363' };
  return crypto.verify('sha256', bytes, options, sig);
};
```

Web Crypto ECDSA signatures are raw `r || s` (IEEE P1363), hence
`dsaEncoding: 'ieee-p1363'`; Node.js defaults to DER. Verify the exact bytes
the client signed (do not re-serialize the parsed JSON).

## Passkeys (WebAuthn) checklist

Registration (`navigator.credentials.create`):

- Options: `challenge`, `rp: { id, name }`, `user: { id: random, name }`,
  `pubKeyCredParams: [{ type: 'public-key', alg: -7 }]` (ES256),
  `authenticatorSelection: { residentKey: 'required', userVerification:
  'required' }`, `attestation: 'none'`.
- `clientDataJSON`: `type === 'webauthn.create'`, `origin` equals the
  configured origin, `challenge` consumed.
- `authenticatorData`: first 32 bytes equal `sha256(RP_ID)`; flags byte
  (offset 32) has UP `0x01`, UV `0x04`, and AT `0x40` on registration.
- Store `{ credentialId, userId, publicKey (SPKI), signCount }`.

Authentication (`navigator.credentials.get`):

- `allowCredentials: []` lets the authenticator show an account picker
  (discoverable credentials).
- `clientDataJSON.type === 'webauthn.get'`, origin, challenge as above.
- `userHandle` matches the stored `userId`.
- Signature: `crypto.verify('sha256', Buffer.concat([authData,
  sha256(clientDataJSON)]), publicKey, signature)`; WebAuthn signatures are
  DER, so the default `dsaEncoding` works.
- Compare a non-zero `signCount` with the stored value to detect cloned
  authenticators. Many synced passkeys always report 0.
- WebAuthn binds to the RP ID: serve on `localhost`, not `127.0.0.1`, during
  development, and use https in production.

After either ceremony, create a normal revocable server-side session and set
an `HttpOnly; Secure` cookie, with `SameSite=Lax` when the app also signs in
through an identity provider. The passkey replaces the password, not the
session.
