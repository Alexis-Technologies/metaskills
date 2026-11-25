# @alexify/mailer

Email for Node.js with a reliability layer: its own SMTP client, MIME builder, DKIM, eighteen HTTP
providers, a queue on BullMQ or a MongoDB outbox, delivery webhooks, audit and idempotency. Version
1.2.1, tag `v1.2.1`, **Node.js 22+**, no runtime dependencies. Everything else is injected: BullMQ,
MongoDB collections, the template engine, a Pino-like logger.

**Target 1.x, which is email only.** SMS, RCS, chat apps and push come in 2.0, which is unreleased
and described at the end of this page. Do not install it or build on its names yet.

| Entry | Holds |
| --- | --- |
| `@alexify/mailer` | `createMessage`, address helpers, receipts, error classification |
| `/smtp`, `/sendmail`, `/jmap` | protocol transports |
| `/ses`, `/resend`, `/sendgrid`, `/mailgun`, `/postmark`, `/brevo`, and others | HTTP providers |
| `/mock` | `MockTransport`, for tests |
| `/pool`, `/retry`, `/breaker`, `/ratelimit`, `/idempotency`, `/hooks`, `/tee`, `/otel`, `/logger` | decorators over any transport |
| `/queue`, `/bullmq`, `/mongodb` | the queue, its drivers and the outbox |
| `/templates`, `/render`, `/attachments`, `/mime` | content |
| `/webhooks` | verified delivery events of fifteen providers |
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
| Know what happened after sending | `/webhooks` and `/audit` |

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
const { createMailQueue } = require('@alexify/mailer/queue');
const { IdempotencyTransport } = require('@alexify/mailer/idempotency');
const mailerMongo = require('@alexify/mailer/mongodb');
const { createMongoOutbox, createMongoIdempotencyStore } = mailerMongo;

const outbox = createMongoOutbox({ collection: db.collection('mail_outbox'), changeStream: true });
const store = createMongoIdempotencyStore({ collection: db.collection('mail_idempotency') });
await outbox.ensureIndexes();
await store.ensureIndexes();

const queue = createMailQueue({ driver: outbox });
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

## 2.0, unreleased

Built on the branch `feature/messenger` of the mailer repository, after its `PLAN-channels.md`. Its
`package.json` still says 1.2.1: there is no tag and nothing on npm. A provider ships only after a
live run of its e2e suite on a real account, so the list below may shrink at release. Read this to
know where 1.x code is heading, and write against 1.x. The channels were planned as
`@alexify/messenger`, which will never be published.

### One model of messages

- `Message` gains `channel: 'email'`, which `createMessage` sets (a message built by hand without
  it is still email at run time), and an optional `tenantId`, never sent to a provider.
- `ChannelMessage` is one of twelve: `SmsMessage`, `RcsMessage`, `WhatsAppMessage`,
  `MessengerMessage`, `InstagramMessage`, `TelegramMessage`, `ViberMessage`, `SlackMessage`,
  `DiscordMessage`, `TeamsMessage`, `GoogleChatMessage`, `PushMessage`. `AnyMessage` is
  `Message | ChannelMessage`, `MessageOf<'sms'>` is `SmsMessage`, and `Channel` names all thirteen.
- A message of a channel has `channel`, a `to` of the channel's kind (an `E164` number for SMS, RCS
  and WhatsApp, a platform id, `{ token }`, `{ topic }` or a Web Push subscription), `from`, `text`,
  `media`, `buttons`, `payload` (a Block Kit, an Adaptive Card, an embed, passed as is), `mentions`
  (none by default), `tags`, `priority`, `metadata` (with `correlationId`), `tenantId`,
  `idempotencyKey`, `scheduledAt` and `expiresAt`. WhatsApp adds `template`, push adds `title` and
  `data`, and Telegram, Slack, Discord and Google Chat add `thread`.
- `Transport<TProviderId, TMessage>` takes the type of its messages, `Message` by default: a
  transport of SMS refuses an email at compile time, and an email transport an SMS.

### Entries

| Entry | Holds |
| --- | --- |
| `/channels` | `createChannelMessage`, `checkChannelMessage`, `isChannelMessage`, `normalizePhone`, `isE164`, `countSegments`, `escapeTelegramHtml`, `escapeSlackText`, `escapeDiscordMarkdown`, `neutralizeMentions` |
| `/router` | `createRouter`, `RouterTransport`: one transport that sends each message by its `channel` |
| `/twilio`, `/vonage`, `/infobip`, `/sinch`, `/aws-sms`, `/turbosms`, `/alphasms`, `/smsclub` | SMS; Twilio also MMS, WhatsApp and RCS, TurboSMS and AlphaSMS also Viber |
| `/rbm` | RCS Business Messaging |
| `/meta`, `/telegram`, `/viber` | WhatsApp, Messenger and Instagram in one entry; Telegram; Viber |
| `/slack`, `/discord`, `/teams`, `/google-chat` | work chats, through a bot or a webhook |
| `/fcm`, `/apns`, `/webpush` | push |
| `/webhooks/<provider>` | each email verifier in its own entry; `/webhooks` keeps `createMemoryReplayStore` and `WebhookVerificationError` |

An entry is per vendor, and its class is named after it: `TwilioTransport`, `MetaTransport`,
`TelegramTransport`, `FcmTransport`, and so on.

```js
const { createChannelMessage } = require('@alexify/mailer/channels');
const { createRouter } = require('@alexify/mailer/router');
const { TwilioTransport } = require('@alexify/mailer/twilio');

const twilio = new TwilioTransport({ accountSid, authToken, messagingServiceSid });
const transport = createRouter({ email: smtp, sms: twilio });

const sms = createChannelMessage(
  { channel: 'sms', to: '067 123 45 67', text: 'Your code is 123456', priority: 'high' },
  { defaultCountry: 'UA' },
);
const receipt = await transport.send(sms);
```

`createChannelMessage` throws a `TypeError` for a field its channel does not take, and keeps the
number in E.164 (`+380671234567`). `normalizePhone` gives E.164 or `undefined`.
`countSegments(text)` gives `{ encoding, segments, units, characters }`: any Cyrillic text is
UCS-2, 70 code units in one segment and 67 in each of several.

### The queue

One queue API for every channel. 2.0 renames it without `Mail`:

| 1.x | 2.0 |
| --- | --- |
| `createMailQueue`, `createMailJobHandler` | `createQueue`, `createJobHandler` |
| `prepareMailJob`, `parseMailJob` | `prepareJob`, `parseJob` |
| `MailQueueError` | `QueueError`, with the same `queue.*` codes |
| `MAIL_JOB_NAME`, `MAIL_JOB_VERSION` | `EMAIL_JOB_NAME`, `EMAIL_JOB_VERSION` |
| `MailJobData`, `MailQueue`, `MailWorkerOptions` | `JobData`, `MessageQueue`, `JobHandlerOptions` |
| `BullMQMailJobOptions`, `BullMQMailWorkerOptions` of `/bullmq` | `BullMQJobOptions`, `BullMQWorkerOptions` |

```js
const { createQueue } = require('@alexify/mailer/queue');

const queue = createQueue({ driver: channelOutbox, defaultCountry: 'UA' });
await queue.enqueue({
  channel: 'sms',
  kind: 'content',
  to: user.phone,
  text: 'Your code is 123456',
  idempotencyKey: `sign-in:${challengeId}`,
});
const worker = queue.createWorker({ transport: createRouter({ sms: twilio, telegram }) });
```

- A job of a channel is version 2 (`CHANNEL_JOB_VERSION`). An email job stays version 1, byte for
  byte. `enqueue` gives an `EmailEnqueueResult` with `messageId` for an email and a
  `ChannelEnqueueResult` with `channel` for the others.
- A template job renders the text of a message of a channel. The template WhatsApp approved is
  `providerTemplate`, since `template` names one of the renderer.
- **Give the channels a queue of their own:** another `queueName` of `/bullmq`, another collection
  of the outbox. A worker of 1.x gives a job of a channel back as `queue.unsupported_version`, and a
  rate limit of Telegram should not pause email.

### Receipts and errors

- A receipt is still read by `successful`. A success adds `channel`, `segments` (the parts of an
  SMS) and `state`: `accepted`, when the delivery comes in the provider's events, or `sent`, from a
  work chat or a push, which reports nothing later.
- A failure keeps `errorMessages` and `errors` (`ReceiptError` with `code`, `category`,
  `retryable`, `statusCode`, `retryAfterMilliseconds`). `deliveryUnknown` gains
  `deliveryUnknownReason`: `timeout`, `lost-answer`, `server-error`, `unreadable-answer`, `no-id`,
  `duplicate` or `in-flight`. A message of unknown delivery is still never sent again by hand.
- `ReceiptErrorCategory` adds `invalid-recipient`, `opted-out`, `outside-window`, `blocked`,
  `not-on-channel`, `unregistered` and `unreachable`. Of the seven, only `unreachable` is retryable
  unless the error says otherwise, and `/pool` fails over on it alone.
- `DeliveryEvent` requires `channel` and adds `error: { category, code }`. `DeliveryEventType` adds
  `sent`, `read`, `failed`, `expired` and `subscribed`, and `MessageState` adds `sent`, `read` and
  `expired`. An exhaustive `switch` over any of these unions breaks.

### Upgrading from 1.x, once it is released

- Import each webhook verifier from its own entry: `createSesWebhookVerifier` from
  `@alexify/mailer/webhooks/ses`.
- Rename the queue API as in the table above.
- Update dashboards and alerts: the metrics are `mailer.message.*` with `mailer.channel` (were
  `mailer.email.*`), the events of `/logger` are `message.*` (were `email.*`), and the logger sink
  of `/audit` writes `message.<state>` (was `mail.<state>`).
- Nothing persisted changes, so workers of 1.2 and 2.0 can share a queue of email during a rollout.

2.1 adds the webhooks of the channels, one `/suppression` for email and the channels, and
`/fallback` between channels and email; 2.2 adds their MongoDB stores and the crypto-shredding of
recipients.

Read on 2026-11-25 from `index.d.ts`, the `.d.ts` of `/channels`, `/router`, `/queue`, `/bullmq`
and the providers, `docs/`, `CHANGELOG.md` and `PLAN-channels.md` of `feature/messenger`. Nothing
of 2.0 was run.

Related skills: `node-graceful-shutdown`, `node-data-access`
