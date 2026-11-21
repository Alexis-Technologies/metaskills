# Buffers, ArrayBuffer, TypedArrays, DataView

## Memory model

- `ArrayBuffer`: raw fixed-length bytes, no element type, not indexable.
  Resizable form: `new ArrayBuffer(8, { maxByteLength: 64 })` + `resize()`.
- Views read and write the same bytes: typed arrays (one element type,
  platform byte order) and `DataView` (any type at any offset, explicit
  endianness, big-endian by default).
- `Buffer` is a `Uint8Array` subclass with Node helpers (encodings, numeric
  read/write, search). Any API that takes a Buffer also takes a
  `Uint8Array`; for isomorphic code stay with `Uint8Array`.
- `SharedArrayBuffer` + `Atomics` for memory shared between threads:
  `node-multithreading`.

| Type | Bytes | Range / note |
| --- | --- | --- |
| `Int8Array` / `Uint8Array` | 1 | -128..127 / 0..255, overflow wraps |
| `Uint8ClampedArray` | 1 | clamps to 0..255 (pixels) |
| `Int16Array` / `Uint16Array` | 2 | |
| `Int32Array` / `Uint32Array` | 4 | |
| `Float32Array` / `Float64Array` | 4 / 8 | |
| `BigInt64Array` / `BigUint64Array` | 8 | `bigint` elements |

`TypedArray.BYTES_PER_ELEMENT` gives the size; a view's offset must be a
multiple of it (use `DataView` for unaligned access).

```js
const memory = new ArrayBuffer(8);
const bytes = new Uint8Array(memory);
const words = new Uint16Array(memory);
bytes[0] = 1;
bytes[1] = 1;
console.log(words[0]);
```

Prints `257` on little-endian machines: two views, one memory.

## Copy or share

| Operation | Shares memory |
| --- | --- |
| `buf.subarray(a, b)`, `typed.subarray(a, b)` | yes |
| `buf.slice(a, b)` (Buffer, deprecated) | yes |
| `typed.slice(a, b)` (`Uint8Array#slice`) | no, copies |
| `Buffer.from(arrayBuffer, byteOffset, length)` | yes |
| `new Uint8Array(arrayBuffer, byteOffset, length)` | yes |
| `Buffer.from(buffer)`, `Buffer.from(uint8Array)` | no, copies |
| `Buffer.copyBytesFrom(view, offset, length)` | no, copies |
| `Buffer.concat(list, totalLength)` | no, new buffer |
| `arrayBuffer.slice(a, b)` | no, copies |

Zero-copy conversions:

```js
const toUint8 = (buf) =>
  new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

const toBuffer = (view) =>
  Buffer.from(view.buffer, view.byteOffset, view.byteLength);

const exactArrayBuffer = (buf) =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
```

`buf.buffer` alone may be the shared 8 KiB pool (`Buffer.poolSize`) or a
larger socket buffer; `exactArrayBuffer` copies only the region (needed for
`postMessage` transfer lists and APIs that take an `ArrayBuffer`).

## Allocation

- `Buffer.alloc(size, fill?)`: zero-filled (or filled), safe default.
- `Buffer.allocUnsafe(size)`: uninitialized, may come from the pool; may
  contain previous data of this process (other users' requests). Overwrite
  fully before exposing: fine for speed, never for data leaving the process
  half-written.
- `Buffer.allocUnsafeSlow(size)`: uninitialized, never pooled; for buffers
  retained a long time so a small piece does not pin a pool chunk.
- Wipe secrets after use: `buf.fill(0)`.

## Encodings

| Name | Use | Note |
| --- | --- | --- |
| `utf8` | text (default) | 1-4 bytes per character |
| `utf16le` (`ucs2`) | Windows APIs, JS internal strings | 2 or 4 bytes per character |
| `latin1` (`binary`) | legacy single-byte | each byte -> one code point 0..255 |
| `ascii` | 7-bit | high bit dropped on decode |
| `hex` | debugging, hashes | 2 chars per byte |
| `base64` | email, data URLs, JSON transport | 4 chars per 3 bytes, `=` padding |
| `base64url` | URLs, JWT, tokens | `-` and `_`, no padding |

```js
const text = 'Marcus Aurelius (Марк Аврелій)';
const bytes = Buffer.from(text);
console.log(text.length, bytes.length, Buffer.byteLength(text));
console.log(bytes.toString('hex').slice(0, 12));
console.log(bytes.toString('base64url').slice(0, 12));
```

Decoding `base64`/`hex` silently skips invalid input; validate with a
regular expression or round-trip comparison when input is untrusted.
`buffer.isUtf8(buf)` and `buffer.isAscii(buf)` validate encodings.
`TextEncoder#encodeInto(string, uint8Array)` writes into a preallocated
buffer without an intermediate allocation.

## Numbers and byte order

```js
const header = Buffer.alloc(14);
header.writeUInt16BE(0xcafe, 0);
header.writeUInt32LE(42, 2);
header.writeDoubleBE(Math.PI, 6);

console.log(header.readUInt16BE(0).toString(16));
console.log(header.readUInt32LE(2));

const view = new DataView(header.buffer, header.byteOffset, header.length);
console.log(view.getFloat64(6) === Math.PI);
console.log(view.getUint32(2, true));
```

- Buffer methods name the order (`BE`/`LE`); `DataView` takes a
  `littleEndian` flag (default `false` = big-endian = network order).
- `readBigUInt64BE`/`writeBigInt64LE` for 64-bit integers (`bigint`).
- `buf.swap16()`, `swap32()`, `swap64()` reverse byte order in place
  (length must be a multiple of the width).
- Fields must not overlap: offset of the next field = offset + width.
- Out-of-range offsets throw `ERR_OUT_OF_RANGE`; check lengths of
  received frames before reading.

## Searching, comparing, iterating

- `buf.includes(value)`, `indexOf`, `lastIndexOf` accept strings, numbers
  and buffers (search binary delimiters without decoding).
- `buf.equals(other)`; `Buffer.compare(a, b)` as a sort comparator.
- `for (const byte of buf)`, `buf.entries()`, `buf.values()`;
  in hot loops use an index `for` loop.
- Timing-safe comparison of secrets: `crypto.timingSafeEqual(a, b)` (same
  length required).

## Binary frame: one allocation, zero-copy payload

```js
const ID_LENGTH = 4;

const encodeChunk = (id, payload) => {
  const chunk = new Uint8Array(ID_LENGTH + payload.length);
  const view = new DataView(chunk.buffer);
  view.setInt32(0, id);
  chunk.set(payload, ID_LENGTH);
  return chunk;
};

const decodeChunk = (chunk) => {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const id = view.getInt32(0);
  const payload = chunk.subarray(ID_LENGTH);
  return { id, payload };
};

const encoder = new TextEncoder();
const packet = encodeChunk(123, encoder.encode('Hello'));
const { id, payload } = decodeChunk(packet);
console.log(id, new TextDecoder().decode(payload));
```

One typed array holds header and payload, and `subarray` avoids a copy.
`new DataView(chunk.buffer)` without the offset breaks as soon as a chunk is
a view into a larger buffer (socket reads, pooled Buffers, `subarray` of a
batch); always pass `byteOffset` and `byteLength`.

## Length-prefixed stream framing

Byte streams split and glue messages arbitrarily; accumulate and cut by a
length header:

```js
const createFrameParser = (onFrame) => {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 4) {
      const size = pending.readUInt32BE(0);
      if (pending.length < 4 + size) break;
      onFrame(pending.subarray(4, 4 + size));
      pending = pending.subarray(4 + size);
    }
  };
};

const frame = (payload) => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
};

const parse = createFrameParser((payload) => console.log(payload.toString()));
const frames = [frame(Buffer.from('one')), frame(Buffer.from('two'))];
const wire = Buffer.concat(frames);
parse(wire.subarray(0, 5));
parse(wire.subarray(5));
```

Enforce a maximum `size` before buffering when the peer is untrusted, and
copy frames (`Buffer.from(payload)`) if you keep them after the next chunk.
