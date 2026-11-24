# Web Streams in Node.js and browsers

Globals in Node 18+ (and in `node:stream/web`): `ReadableStream`,
`WritableStream`, `TransformStream`, `TextEncoderStream`,
`TextDecoderStream`, `CompressionStream`, `DecompressionStream`,
`ByteLengthQueuingStrategy`, `CountQueuingStrategy`. You meet them in
`fetch` (`response.body`), `Blob.stream()`, `File`, service workers.

## Node streams vs Web Streams

| Concern | Node streams | Web Streams |
| --- | --- | --- |
| Create source | `Readable.from(iterable)`, `new Readable({ read })` | `new ReadableStream({ start, pull, cancel })`, `ReadableStream.from(iterable)` |
| Create sink | `new Writable({ write, final })` | `new WritableStream({ write, close, abort })` |
| Transform | `new Transform({ transform, flush })`, async generator stage | `new TransformStream({ transform(chunk, controller), flush })` |
| Read | `for await`, events | `for await`, `stream.getReader().read()` -> `{ done, value }` |
| Write | `write()` returns boolean + `'drain'` | `writer = stream.getWriter(); await writer.write(chunk)` |
| Compose | `pipeline(a, b, c, { signal })` | `a.pipeThrough(t).pipeTo(w, { signal })` |
| End | `push(null)` | `controller.close()` |
| Error | `destroy(error)`, `'error'` | `controller.error(error)`, rejected promises |
| Backpressure | `highWaterMark`, `write()` result | `highWaterMark` strategy, `controller.desiredSize`, `await writer.ready` |
| Locking | none | `getReader()`/`getWriter()` lock the stream until `releaseLock()` |
| Split one source | pipe to several destinations | `const [left, right] = stream.tee()` |
| Chunk type for bytes | `Buffer` | `Uint8Array` |

The reader API is clumsy (stream -> reader -> promise of `{ done, value }`);
use `for await` where available.

## Interop

```js
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// web -> node: pipeline accepts web streams directly
const saveResponse = async (response, filePath) => {
  await pipeline(response.body, fs.createWriteStream(filePath));
};

// web -> node stream object, for APIs that require one
const toNodeReadable = (response) => Readable.fromWeb(response.body);

// node -> web, e.g. to build a Response
const fileResponse = (filePath) => {
  const body = Readable.toWeb(fs.createReadStream(filePath));
  return new Response(body);
};

// node writable -> web writable
const webSink = (filePath) => Writable.toWeb(fs.createWriteStream(filePath));
```

`Duplex.fromWeb({ readable, writable })` and `Duplex.toWeb(duplex)` bridge
pairs (for example a TCP socket and a web-style transport).

## Recipes

### Read all bytes without Buffer (isomorphic)

```js
const readAllBytes = async (stream) => {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};
```

In Node prefer `Buffer.concat` or `new Response(stream).arrayBuffer()`.

### Transform and pipe

```js
const upper = new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(chunk.toUpperCase());
  },
});

const lines = [];
await new Response('web streams\n')
  .body.pipeThrough(new TextDecoderStream())
  .pipeThrough(upper)
  .pipeTo(
    new WritableStream({
      write(chunk) {
        lines.push(chunk);
      },
    }),
  );
```

### Lazy pull source with cancellation

```js
const countStream = (max) => {
  let current = 0;
  return new ReadableStream({
    pull(controller) {
      current += 1;
      controller.enqueue(current);
      if (current >= max) controller.close();
    },
    cancel(reason) {
      console.log('consumer stopped:', reason);
    },
  });
};

const reader = countStream(10).getReader();
const { value } = await reader.read();
await reader.cancel('got enough');
```

`pull` runs only when the internal queue is below `highWaterMark`, so data
is produced on demand. A `start()` that enqueues in a loop ignores demand;
check `controller.desiredSize` there or switch to `pull`.

### Compression without zlib (isomorphic)

```js
const gzipStream = (stream) =>
  stream.pipeThrough(new CompressionStream('gzip'));
```

## Pitfalls

- `enqueue(null)` is a value, not end-of-stream.
- A locked stream cannot be read by a second consumer; `tee()` buffers for
  the slower branch (unbounded if one side never reads).
- `pipeTo` closes the destination when the source ends unless
  `{ preventClose: true }`; it aborts the destination on source error
  unless `{ preventAbort: true }`.
- Web Streams in Node have historically been slower than Node streams for
  heavy byte throughput; keep server hot paths on Node streams, convert at
  the edge, and measure before switching.
