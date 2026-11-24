# @alexify/mailer

Email for Node.js with a reliability layer: its own SMTP client, MIME builder, DKIM, eighteen HTTP
providers, a queue on BullMQ or a MongoDB outbox, delivery webhooks, audit and idempotency. Version
1.2.1, tag `v1.2.1`, **Node.js 22+**, no runtime dependencies. Everything else is injected: BullMQ,
MongoDB collections, the template engine, a Pino-like logger.

**1.x is email only.** The channels (SMS, chat apps, push) are in the code under their own subpaths,
but no channel is released: each ships in 2.0 after a live run on a real account. Do not build on
them yet.

| Entry | Holds |
| --- | --- |
| `@alexify/mailer` | `createMessage`, address helpers, receipts, error classification |
| `/smtp`, `/sendmail`, `/jmap` | protocol transports |
| `/ses`, `/resend`, `/sendgrid`, `/mailgun`, `/postmark`, `/brevo`, and others | HTTP providers |
| `/mock` | `MockTransport`, for tests |
| `/pool`, `/retry`, `/breaker`, `/ratelimit`, `/idempotency`, `/hooks`, `/tee`, `/otel`, `/logger` | decorators over any transport |
| `/queue`, `/bullmq`, `/mongodb` | the queue, its drivers and the outbox |
| `/templates`, `/render`, `/attachments`, `/mime` | content |
| `/webhooks`, `/webhooks/<provider>` | verified delivery events |
| `/audit` | the states of a message |

## When to choose it

Any transactional email. Replaces `nodemailer` where a project wants retries, idempotency and
delivery events without building them. `auth8` still uses `nodemailer`. Do not migrate it as a side
effect of another change.

| Need | Use |
| --- | --- |
| Send one email in a script | a transport and `createMessage` |
| Send from a request handler | `/queue`, so a provider outage does not fail the request |
| The email must go out exactly when a write commits | `/mongodb` outbox in the same transaction |
| Redis or Valkey is already there | `/bullmq` driver |
| Know what happened after sending | `/webhooks/<provider>` and `/audit` |

## API

```js
const { createMessage } = require('@alexify/mailer');
const { SmtpTransport } = require('@alexify/mailer/smtp');

const transport = new SmtpTransport({ host, port: 465, secure: true, auth: { user, pass } });
const content = { text: 'Your code is 123456' };
const message = createMessage({ from, to, subject: 'Sign-in code', content });

const receipt = await transport.send(message);
if (!receipt.successful) logger.error({ errors: receipt.errorMessages }, 'send failed');
```

`transport.send` reports a failure in the receipt: check `receipt.successful`.

A queue with a transactional outbox:

```js
const { createQueue } = require('@alexify/mailer/queue');
const { IdempotencyTransport } = require('@alexify/mailer/idempotency');
const mailerMongo = require('@alexify/mailer/mongodb');
const { createMongoOutbox, createMongoIdempotencyStore } = mailerMongo;

const outbox = createMongoOutbox({ collection: db.collection('mail_outbox'), changeStream: true });
const store = createMongoIdempotencyStore({ collection: db.collection('mail_idempotency') });
await outbox.ensureIndexes();
await store.ensureIndexes();

const queue = createQueue({ driver: outbox });
const job = {
  kind: 'content',
  subject: 'Reset your password',
  content: { text: url },
  from,
  to: user.email,
  idempotencyKey: `reset-password:${resetId}`,
};

await session.withTransaction(async () => {
  await db.collection('resets').insertOne({ _id: resetId, userId: user.id }, { session });
  await queue.enqueue(job, { transaction: session });
});

const worker = queue.createWorker({
  transport: new IdempotencyTransport(transport, { store }),
  concurrency: 5,
});
```

## Gotchas

- **`deliveryUnknown`.** After a timeout or a 5xx the provider may already have the message. `/retry`
  and `/pool` do not send it again. Do not write your own retry around `send`.
- An idempotency key names the request, never a secret: `reset-password:${resetId}`, not the token.
  A second `enqueue` under the same key returns the first job.
- A job is JSON, 256 KiB at most. The `context` of a template job refuses a `Date`, `Map`, class,
  `NaN` or a cycle: pass an ISO string. An attachment travels as bytes or as `{ ref }`, never a path.
- Webhooks need the **raw body**, since the signature covers its exact bytes. In Fastify, add a
  content-type parser that keeps a `Buffer` for that route.
- A CRLF in a subject is encoded by the MIME builder, so no header can be injected (checked).
- `expiresAt` matters for sign-in codes. A code delivered late is useless.
- `SIGTERM` must call `worker.close()`.

Checked by running: `createMessage`, `MockTransport`, address validation, MIME composition, and the
queue with its memory driver and `IdempotencyTransport`. Real providers, BullMQ, the MongoDB outbox
and webhooks were read from `index.d.ts` and `docs/`, not run.

Related skills: `node-graceful-shutdown`, `node-data-access`
