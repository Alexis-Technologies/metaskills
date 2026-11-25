---
name: node-streams
description: Move data through Node.js streams with pipeline and backpressure. Use for large files, uploads, exports, gzip, Web Streams or hanging streams
---

# Node.js Streams

Make the agent move data through bounded memory: compose with `pipeline`,
consume with `for await`, write transforms as async generators or
revealing-constructor options, respect backpressure, and make every error
destroy every stream in the chain.

- **Library**: accept and return streams or async iterables. Never hold a
  `reply`.
- **App**: send with `reply.send(stream)` and limit bodies with `bodyLimit`.
  Touch `reply.raw` only after `reply.hijack()`.

## Mental model

- A stream is an `EventEmitter` plus a contract: `Readable` (source),
  `Writable` (sink), `Duplex` (both, independent sides, e.g. sockets),
  `Transform` (Duplex where output is computed from input, e.g. zlib).
  `Readable` is also an async iterable.
- Streams exist so that data never sits in memory whole: a 64 KiB buffer is
  reused to move gigabytes (files, video, encryption, DB cursors in object
  mode). `fs.createReadStream` chunks are 64 KiB by default.
- You meet streams everywhere: `request.raw` (Readable) and `reply.raw`
  (Writable) in Fastify, `process.stdin/stdout`, `net.Socket`, `zlib`, `crypto` hashes/ciphers,
  `child_process` stdio, and Web Streams from `fetch`.
- Byte streams have no message boundaries: chunks are split and glued
  arbitrarily by buffers, the OS and the network. Byte count and order are
  preserved, chunk count is meaningless.

## Rules

### Composition

- Use `pipeline` from `node:stream/promises` for every chain. It forwards
  errors, destroys all streams on failure or abort, waits for the sink to
  finish, and accepts async iterables, async generator functions and Web
  Streams as stages.
- Do not use `a.pipe(b).pipe(c)` in production code: `.pipe()` does not
  forward errors and does not destroy the source when the destination fails
  (the file descriptor leaks). It is fine only in throwaway scripts.
- Pass `{ signal }` as the last `pipeline` argument for cancellation;
  use `AbortSignal.timeout(ms)` instead of `AbortController` + `setTimeout`,
  and `AbortSignal.any([...])` to combine with a shutdown signal.
- Write transforms as `async function* (source, { signal })` stages; use
  `Transform` classes only for reusable library components.

### Consumption

- Consume with `for await (const chunk of readable)`; wrap the loop (or the
  enclosing `async` call) in `try/catch` - stream errors are thrown into it.
  `break`/`return` destroys the stream.
- Choose exactly one consumption style per stream: `for await`, `pipeline`,
  `'data'`, or `'readable'` + `read()`. Mixing them reads data twice or
  steals chunks.
- One consumer per stream: never run several `for await` loops (e.g.
  recursion) over the same stream or `readline` interface - they compete
  for events and read ahead. Pull from a single iterator instead.
- Never pass an `async` function as a `'data'` listener to do I/O: events do
  not await, so there is no backpressure and concurrency is unbounded. Use
  `for await` or a `Writable`.
- A Readable that nobody consumes never emits `'end'`; waiting for it hangs.
- To collect a small stream use `node:stream/consumers` (`text`, `json`,
  `buffer`, `arrayBuffer`) or `Buffer.concat(chunks)`, but only with a size
  limit for untrusted input.

### Production (sources)

- Create sources with `Readable.from(iterable | asyncIterable)` or pass an
  async generator straight to `pipeline`. Note: `Readable.from()` defaults
  to object mode, and a string or Buffer is emitted as one chunk.
- Implement `read(size)` only for true pull sources; push until `push()`
  returns `false`, then wait for the next `read()`. `push(null)` ends the
  stream, so `null` can never be data, even in object mode.

### Backpressure and buffering

- When writing manually, honour `writable.write()` returning `false`: stop
  and `await once(writable, 'drain')` (or `pause()` the readable and
  `resume()` on `'drain'`, which is what `pipe/pipeline` do internally).
- `highWaterMark` is a threshold, not a limit: defaults are 64 KiB for byte
  streams (Node 22+) and 16 objects in object mode. Tune it only with a
  measurement (bigger for throughput on fast disks, smaller for latency).
- Use `cork()`/`uncork()` (or implement `writev`) to batch many small writes
  into one system call or one DB batch.

### Object mode and framing

- Use `objectMode: true` (or `readableObjectMode`/`writableObjectMode` on a
  parsing Transform) for records inside a process; `highWaterMark` then
  counts objects.
- Across processes or the network frame the bytes: newline-delimited JSON,
  length-prefixed binary frames (see `node-fs-buffers`), or a protocol
  library. Never treat one chunk as one message.
- Decode text with `{ encoding: 'utf8' }` / `setEncoding('utf8')`,
  `TextDecoder` with `{ stream: true }`, or `TextDecoderStream`;
  `chunk.toString()` corrupts multibyte characters split across chunks.

### Implementing streams

- Use the revealing constructor: `new Writable({ write })`,
  `new Transform({ transform, flush })`, `new Readable({ read })`,
  `new Duplex({ read, write })` instead of `class X extends Writable` with
  `_write`. The function is injected into a plain instance; no inheritance,
  no `super` ordering issues.
- Callback contract: call the callback of `write`, `writev`, `transform`,
  `flush`, `final`, `destroy` exactly once, with an `Error` on failure. These
  methods are callback-based: an `async` method that throws produces an
  unhandled rejection (process crash) instead of a stream error, and an
  `async` method that never calls the callback stalls the stream.
- Prepare async resources before constructing the stream (async factory)
  rather than inside the constructor; `construct(callback)` exists but keep
  initialisation explicit.
- Release resources in `destroy(error, callback)`; signal failure with
  `stream.destroy(error)` (or `callback(error)` inside methods), not by
  emitting `'error'` yourself.

### Errors and completion

- Completion events: Readable `'end'` (all data consumed), Writable
  `'finish'` (all data flushed after `end()`), `'close'` (resources released),
  `'error'`. Use `finished(stream)` from `node:stream/promises` instead of
  wiring these by hand.
- Every stream not under `pipeline`/`for await` needs an `'error'` listener:
  a stream is an emitter and an unhandled `'error'` kills the process.
- `reply.send(stream)` handles a client disconnect: Fastify destroys the
  source and logs it at `info`. A `pipeline` of your own rejects with
  `ERR_STREAM_PREMATURE_CLOSE` there; treat it as normal (the source is already
  destroyed).

### Web Streams

- Use Web Streams (`ReadableStream`, `WritableStream`, `TransformStream`,
  `TextDecoderStream`, `CompressionStream`) for isomorphic code and `fetch`;
  use Node streams for Node-only hot paths and Node APIs.
- Prefer `for await (const chunk of response.body)` over
  `getReader()`/`read()` loops; chunks are `Uint8Array`.
- Interop: pass web streams straight to `pipeline`, or convert with
  `Readable.fromWeb`, `Readable.toWeb`, `Writable.fromWeb`, `Writable.toWeb`,
  `Duplex.fromWeb/toWeb`. Details: `references/web-streams.md`.
- `enqueue(null)` does not end a web stream (Node null-EOF semantics do not
  carry over); call `controller.close()`.

## Patterns

### File to gzip with timeout

```js
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const compressFile = async (source, target, timeoutMs = 30_000) => {
  const signal = AbortSignal.timeout(timeoutMs);
  await pipeline(
    fs.createReadStream(source),
    zlib.createGzip(),
    fs.createWriteStream(target),
    { signal },
  );
};
```

On timeout or any error all three streams are destroyed and the promise
rejects (`AbortError` for the signal).

### Async generators as transforms (CSV to NDJSON)

```js
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

const splitLines = async function* (source) {
  let tail = '';
  for await (const chunk of source) {
    const lines = (tail + chunk).split('\n');
    tail = lines.pop();
    yield* lines;
  }
  if (tail) yield tail;
};

const toRecord = (header, cells) => {
  const record = Object.create(null); // keys come from the file, so no prototype
  for (let i = 0; i < header.length; i++) record[header[i]] = cells[i];
  return record;
};

const parseCsv = async function* (lines) {
  let header = null;
  for await (const line of lines) {
    const cells = line.split(',');
    if (!header) header = cells;
    else yield toRecord(header, cells);
  }
};

const toNdjson = async function* (records) {
  for await (const record of records) yield `${JSON.stringify(record)}\n`;
};

await pipeline(
  fs.createReadStream('orders.csv', { encoding: 'utf8' }),
  splitLines,
  parseCsv,
  toNdjson,
  fs.createWriteStream('orders.ndjson'),
);
```

Each stage is a pull loop, so backpressure flows from the file sink back to
the reader; the `encoding` option keeps UTF-8 characters intact. A throw in
any stage rejects `pipeline` and destroys the file streams. For lines only,
`(await fsp.open(path)).readLines()` or `readline` also work.

### MongoDB export over HTTP

```js
import { Readable } from 'node:stream';

const PAGE_SIZE = 500;
const FIELDS = { _id: 0, cuid: 1, ulid: 1, status: 1, total: 1 };

const readOrders = async function* (orders, tenantId) {
  const options = { sort: { ulid: 1 }, limit: PAGE_SIZE, projection: FIELDS };
  let after = '';
  let count = PAGE_SIZE;
  while (count === PAGE_SIZE) {
    count = 0;
    const filter = { tenantId, deletedAt: null, ulid: { $gt: after } };
    for await (const order of orders.find(filter, options)) {
      after = order.ulid;
      count++;
      yield order;
    }
  }
};

fastify.get('/orders/export', async (request, reply) => {
  const records = readOrders(orders, request.tenantId);
  const body = Readable.from(toNdjson(records));
  return reply.type('application/x-ndjson').send(body);
});
```

The next document is pulled only when the socket drains, so a slow client never
loads the collection into memory (`toNdjson` from above). Keyset pages on `ulid`
(ADR-017, index `{ tenantId: 1, ulid: 1 }`) stay fast at any depth, unlike
`skip`, and keep each server cursor short, so a stalled client cannot outlive
the cursor's idle timeout. On a disconnect Fastify destroys `body`, the
generators return, and `for await` closes the driver cursor.

### Manual writes with backpressure

```js
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

const writeAll = async (writable, chunks) => {
  for (const chunk of chunks) {
    const canWrite = writable.write(chunk);
    if (!canWrite) await once(writable, 'drain');
  }
  writable.end();
  await finished(writable);
};
```

Ignoring `false` makes the writable buffer grow without bound when the
consumer (disk, socket) is slower than the producer.

### Writable sink around an async API (batched)

```js
import { Writable } from 'node:stream';

const createInserter = (collection) =>
  new Writable({
    objectMode: true,
    highWaterMark: 100,
    write(record, encoding, callback) {
      collection.insertOne(record).then(() => callback(), callback);
    },
    writev(entries, callback) {
      const records = [];
      for (const entry of entries) records.push(entry.chunk);
      collection.insertMany(records).then(() => callback(), callback);
    },
  });

// await pipeline(readOrders(source, tenantId), createInserter(target));
```

`write`/`writev` stay non-async and settle the callback from the promise:
rejections become stream errors, and queued records arrive as one batch.

### Request body limits in Fastify

```js
const fastify = Fastify({ bodyLimit: 1024 * 1024 });

fastify.post('/import', { bodyLimit: 10 * 1024 * 1024 }, async (request) => {
  return importRows(request.body);
});
```

Fastify counts bytes while it buffers the body and answers 413
(`FST_ERR_CTP_BODY_TOO_LARGE`). **`bodyLimit` does not apply to a content-type
parser that passes the raw stream on**, so a streaming upload enforces its own
limit:

```js
const limitBytes = (maxBytes) =>
  async function* (source) {
    let size = 0;
    for await (const chunk of source) {
      size += chunk.length;
      if (size > maxBytes) {
        throw new DomainError('Payload too large', { code: 'ALX_ERR_PAYLOAD_TOO_LARGE' });
      }
      yield chunk;
    }
  };

const parseUpload = (request, payload, done) => {
  const declaredBytes = Number(request.headers['content-length'] ?? 0);
  if (declaredBytes > MAX_UPLOAD_BYTES) {
    return void done(new DomainError('Payload too large', { code: 'ALX_ERR_PAYLOAD_TOO_LARGE' }));
  }
  done(null, payload);
};

fastify.addContentTypeParser('application/octet-stream', parseUpload);

fastify.post('/upload', async (request, reply) => {
  const target = fs.createWriteStream(temporaryPath);
  const signal = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
  await pipeline(request.body, limitBytes(MAX_UPLOAD_BYTES), target, { signal });
  return reply.code(201).send();
});
```

Map `ALX_ERR_PAYLOAD_TOO_LARGE` to 413 in the error handler (`error-handling`).
The header check refuses a declared oversize before any byte is read, and the
count stops a chunked body at the limit. Write to a temporary path and rename
on success. Do not pass `request.signal` here: it aborts as soon as the body
ends (`node-event-loop`).

### Streaming a file response

```js
import fs from 'node:fs';

const sendFile = async (reply, filePath, mimeType) => {
  const { size } = await fs.promises.stat(filePath);
  reply.type(mimeType).header('Content-Length', size);
  return reply.send(fs.createReadStream(filePath));
};
```

Fastify pipes the stream, sends a failure before the first byte to the error
handler, and destroys the file stream when the client disconnects. Range
requests: `createReadStream(path, { start, end })` (inclusive `end`) with
status 206. Small hot files: keep (pre-gzipped) Buffers in memory and
`reply.send(buffer)`.

### Fetch body to file (Web Streams interop)

```js
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

const download = async (url, filePath, timeoutMs = 60_000) => {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await pipeline(response.body, fs.createWriteStream(filePath), { signal });
};
```

`response.body` is a web `ReadableStream`; `pipeline` accepts it directly
(use `Readable.fromWeb(response.body)` where an API needs a Node stream).

## Anti-patterns

- `fs.readFile`/`JSON.parse` of large or unbounded inputs, or
  `Buffer.concat` of a request body without a limit - stream and bound it.
- `.pipe()` chains with no error handling; `on('error')` only on the last
  stream.
- `readable.on('data', async (chunk) => { await save(chunk); })` - no
  backpressure, unbounded parallel I/O.
- Ignoring `write()` return value in loops.
- `class Logger extends Writable { async _write(chunk) { await ... } }` -
  async callback-style method: crashes on rejection, stalls if the callback
  is forgotten. Use options + `.then(() => callback(), callback)`.
- Mixing `'data'`, `'readable'`, `pipe` and `for await` on one stream;
  several `for await` loops over one stream.
- Treating chunks as messages; counting "packets".
- `chunk.toString()` on byte chunks of text.
- Waiting for `'end'` on a writable or for `'finish'` on a readable; waiting
  for `'end'` on a stream nobody reads.
- Pushing `null` as a value in object mode.
- Manual `AbortController` + `setTimeout` + `clearTimeout` around a
  pipeline when `AbortSignal.timeout()` does it.
- Experimental helpers (`readable.map/filter/take`, `stream.compose`) in
  production code without checking their stability on the target Node.

## Checklist

- [ ] Every chain uses `pipeline` from `node:stream/promises` (or
      `for await`), awaited inside `try/catch`, with a `signal` when the
      operation can hang.
- [ ] No `.pipe()` without explicit error handling and destroy.
- [ ] Manual writers honour `write() === false` and `'drain'`.
- [ ] Custom streams use the revealing constructor; every callback is called
      exactly once; no `async` callback-style methods.
- [ ] Text decoding uses `encoding`/`setEncoding`/`TextDecoder` streaming.
- [ ] Untrusted inputs have byte limits: `bodyLimit` for parsed bodies, an own
      count for raw upload streams.
- [ ] Each stream has one consumer and one consumption style.
- [ ] Message boundaries are framed (NDJSON, length prefix) or object mode
      is used in-process.
- [ ] Handlers send streams with `reply.send`, tolerate
      `ERR_STREAM_PREMATURE_CLOSE` in their own pipelines, and never write
      after the response was sent.
- [ ] Exports page by a `ulid` keyset, not by `skip`.
- [ ] Web Streams are converted or passed to `pipeline`, not bridged by hand.

More: [references/custom-streams.md](references/custom-streams.md)
(implementing streams, events, cork/writev, revealing constructor) and
[references/web-streams.md](references/web-streams.md).

Related skills: `node-events`, `node-fs-buffers`, `node-http-server`,
`node-data-access`, `error-handling`, `node-graceful-shutdown`.
