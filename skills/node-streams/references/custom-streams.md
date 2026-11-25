# Implementing and operating Node.js streams

## Revealing constructor (why stream options beat subclassing)

A revealing constructor receives a function (or an object of functions) and
uses it inside the instance. Three ways to hand a value to code: a constant,
a function returning it, or a function that receives a callback. The third
lets the producer deliver the value later and exposes the "write side" only
to the constructor code:

```js
const promise = new Promise((resolve) => {
  setTimeout(resolve, 1000, 5);
});
// resolve/reject are visible only inside the executor;
// consumers can only then() before or after settlement.
```

Streams accept the same shape: methods passed in options are installed as
`_read`, `_write`, `_transform`, ... of a plain instance.

```js
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const createRandomStream = () =>
  new Readable({
    read(size) {
      this.push(crypto.randomBytes(size));
    },
  });
```

Instead of:

```js
class RandomStream extends Readable {
  _read(size) {
    this.push(crypto.randomBytes(size));
  }
}
```

The same works for your own abstractions:
`new Timer(intervalMs, listener)`, `new Observable((subscriber) => ...)`.

## Option methods and their contracts

| Stream | Method | Contract |
| --- | --- | --- |
| Readable | `read(size)` | push data with `this.push(chunk)`; stop when it returns `false`; `this.push(null)` ends |
| Writable | `write(chunk, encoding, callback)` | call `callback()` / `callback(error)` once per chunk |
| Writable | `writev(entries, callback)` | receives buffered `{ chunk, encoding }[]` (after cork or while busy) |
| Writable | `final(callback)` | called after `end()`, before `'finish'`: flush buffers |
| Transform | `transform(chunk, encoding, callback)` | `callback(null, output)` or `this.push()` N times then `callback()` |
| Transform | `flush(callback)` | emit tail data at end (e.g. last partial line) |
| any | `destroy(error, callback)` | release resources, then `callback(error)` |
| any | `construct(callback)` | async init before first `read`/`write` |

None of these are promise-aware. Bridge async work explicitly:

```js
import { Transform } from 'node:stream';

const createEnricher = (lookup) =>
  new Transform({
    objectMode: true,
    transform(record, encoding, callback) {
      lookup(record.userId).then(
        (user) => callback(null, { ...record, user }),
        (error) => callback(error),
      );
    },
  });
```

An `async transform` that awaits and then calls the callback works only while
nothing inside can reject. Any throw in such a method becomes an unhandled rejection that crashes the
process instead of failing the pipeline.

Prefer an async generator stage when the transform is local to one
pipeline:

```js
const enrich = (lookup) =>
  async function* (records) {
    for await (const record of records) {
      const user = await lookup(record.userId);
      yield { ...record, user };
    }
  };
```

## Object-mode Transform with validation (revealing constructor)

```js
import { Transform } from 'node:stream';

const createSubtotal = () =>
  new Transform({
    objectMode: true,
    transform({ group, goods }, encoding, callback) {
      let amount = 0;
      for (const item of goods) {
        if (item.price < 0) {
          return void callback(new Error(`Negative price in ${group}`));
        }
        amount += item.price;
      }
      callback(null, { group, count: goods.length, amount });
    },
  });
```

`callback(error)` turns into a stream error that `pipeline`/`for await`
reports; `callback(null, value)` pushes one output object.

## Transform with flush: line splitter

```js
import { Transform } from 'node:stream';

const createLineSplitter = () => {
  let tail = '';
  return new Transform({
    readableObjectMode: true,
    decodeStrings: false,
    encoding: 'utf8',
    transform(chunk, encoding, callback) {
      const lines = (tail + chunk).split('\n');
      tail = lines.pop();
      for (const line of lines) this.push(line);
      callback();
    },
    flush(callback) {
      if (tail) this.push(tail);
      callback();
    },
  });
};
```

Feed it decoded text (`createReadStream(path, { encoding: 'utf8' })`), or
keep bytes and decode with a `StringDecoder`/`TextDecoder` inside.

## Batching with cork/uncork and writev

```js
import { Writable } from 'node:stream';

const createBatchWriter = (send) =>
  new Writable({
    writev(entries, callback) {
      const chunks = [];
      for (const entry of entries) chunks.push(entry.chunk);
      send(Buffer.concat(chunks)).then(() => callback(), callback);
    },
  });

const writer = createBatchWriter(async (payload) => {
  console.log('one packet', payload.length);
});
writer.cork();
writer.write('a');
writer.write('b');
writer.write('c');
process.nextTick(() => writer.uncork());
```

The same idea works for a terminal: cork while typing, uncork on Enter so a
line goes out as one packet. `writable.writableCorked` is the cork depth; call `uncork()` as many times
as `cork()`.

## Pause, resume and what pipe does

```js
import fs from 'node:fs';

const readable = fs.createReadStream('data.tmp', { highWaterMark: 12345 });
const writable = fs.createWriteStream('copy.tmp', { highWaterMark: 54321 });

readable.on('data', (chunk) => {
  if (!writable.write(chunk)) readable.pause();
});
writable.on('drain', () => readable.resume());
readable.on('end', () => writable.end());
writable.on('finish', () => console.log('Done'));
```

This is the machinery `pipe()` hides in closures (and `pipeline` adds error
propagation and destroy). Write it by hand only when building adapters
around non-stream APIs; otherwise use `pipeline`.

## Readable modes and events

- Paused mode (default): data waits in the buffer; `'readable'` fires when
  at least one chunk is available and once more at the end (`read()` then
  returns `null`); loop `while ((chunk = readable.read()) !== null)`.
- Flowing mode: entered by `'data'` listener, `pipe()`, `resume()` or
  `for await`; `'data'` fires per chunk only when there is data (an empty
  file emits `'readable'` but no `'data'`).
- `'end'`: no more data and everything was consumed. `'close'`: underlying
  resource closed (with `autoDestroy`, default `true`, after `'end'` or
  `'finish'` or `'error'`). `'error'`: followed by `'close'`.

| Event | Readable | Writable |
| --- | --- | --- |
| data available | `'data'`, `'readable'` | - |
| producer done | `'end'` | `'finish'` (after `end()` flushed) |
| buffer has room again | - | `'drain'` |
| resources released | `'close'` | `'close'` |
| failure | `'error'` | `'error'` |

## Cleanup helpers

```js
import { finished } from 'node:stream/promises';
import { addAbortSignal } from 'node:stream';

const watchUntilDone = async (stream, signal) => {
  addAbortSignal(signal, stream);
  await finished(stream);
};
```

- `finished(stream)` resolves on `'end'`/`'finish'` and rejects on errors or
  premature close; it does not consume the stream.
- `addAbortSignal(signal, stream)` destroys the stream with an `AbortError`
  when the signal aborts.
- `stream.destroy(error)` stops a stream now; pending writes are dropped.
- `readable.destroyed`, `writable.writableEnded`, `writable.writableFinished`,
  `readable.readableEnded` let you check state instead of tracking flags.

## Object mode notes

- `Readable.from(iterable)` sets `objectMode: true` by default; pass
  `{ objectMode: false }` for byte chunks.
- Object-mode `highWaterMark` counts items (default 16), so 16 huge objects
  can still be a lot of memory: size the page or batch accordingly.
- A parsing Transform typically has `writableObjectMode: false` (bytes in)
  and `readableObjectMode: true` (records out), or the reverse for
  serializers.

## stdin key handling

```js
process.stdin.setRawMode(true);
process.stdin.on('data', (data) => {
  const key = data[0];
  if (key === 3) process.exit(0);
});
```

In raw mode the terminal stops echoing and stops turning Ctrl+C into
SIGINT, so handle it yourself.
