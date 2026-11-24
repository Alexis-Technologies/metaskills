---
name: node-fs-buffers
description: Node.js files and binary data with fs/promises, atomic writes, safe paths, Buffers and watchers. Use when handling files, bytes or encodings
---

# Node.js Files, Buffers and Binary Data

Make the agent use non-blocking, race-free file operations with explicit
encodings, keep big data out of memory, write state files atomically,
resolve untrusted paths safely, treat Buffers as views over shared memory,
and build watchers that survive editor and platform quirks.

Examples are ESM. Where the profiles differ:

- **Library:** CommonJS, `__dirname`, no logger dependency (report through a
  callback or an error). Read `engines` first: `glob` needs Node 22,
  `await using` needs 24, `dirent.parentPath` needs 18.20 or 20.12.
- **App:** ESM and TypeScript, `import.meta.dirname`, logs go to stdout through
  Pino, so an app rarely writes its own log files.

## Rules

### Choosing the API

- Use `node:fs/promises` by default. Use the callback API only where a code
  base already does; use `*Sync` only:
  - at startup, before the server accepts requests (configs, certificates,
    templates), and
  - in CLI tools and batch jobs with no concurrent users.

  Never call `*Sync` inside request handlers, event listeners, timers or
  after `listen()`: it blocks the whole process, while `await` blocks only
  the current async chain. By default keep one async style even at startup:
  the 10-15 ms a sync read saves is irrelevant.
- Pass the encoding when you want text: `readFile(path, 'utf8')`. Without it
  you get a `Buffer`.
- Do not check before acting (`exists` then `readFile`/`writeFile`): the
  file can change in between (TOCTOU). Do the operation and branch on
  `error.code` (`ENOENT`, `EEXIST`, `EACCES`, `EISDIR`, `ENOTDIR`, `EMFILE`,
  `EPERM`/`EBUSY` on Windows). Use `flag: 'wx'` for create-if-absent. Use
  `stat`/`access` checks only to report or branch, not to guard.
- Run independent operations in parallel with `Promise.all` /
  `Promise.allSettled`; bound concurrency for thousands of files to avoid
  `EMFILE` (`js-async-concurrency`).
- Prefer recursive built-ins over hand-written walkers:
  `mkdir(dir, { recursive: true })`, `rm(path, { recursive: true, force:
  true })`, `cp`, `readdir(dir, { withFileTypes: true, recursive: true })`,
  `opendir` for huge directories, `glob` (Node 22+).

### Big files and handles

- `readFile`/`writeFile` hold the whole content in memory (and `readFile`
  refuses files over 2 GiB with `ERR_FS_FILE_TOO_LARGE`). Use them for small,
  bounded files; stream anything large or of unknown size (`createReadStream`,
  `pipeline`, see `node-streams`).
- Read lines with `filehandle.readLines()` or `readline.createInterface({
  input, crlfDelay: Infinity })`; read a region with
  `createReadStream(path, { start, end })` (`end` inclusive) or
  `filehandle.read({ buffer, position })`.
- Close every `FileHandle` in `finally` (or `await using` on Node 24+).
  Relying on GC to close descriptors leaks them under load (`EMFILE`) and
  prints deprecation warnings. `readLines()` closes the handle only when the
  file is read to the end: a `break` or a thrown error leaves it open.
- For append-only output open one stream with `flags: 'a'` and reuse it,
  batching writes; `appendFile` per line opens and closes the file every
  time.

### Atomic and concurrent writes

- `writeFile` is not atomic: a crash or a concurrent reader can observe a
  truncated file. For state, config, cache and manifest files write a temp
  file in the same directory, `sync()` it, then `rename()` over the target
  (rename is atomic within one filesystem).
- Serialize writers of the same file (a per-path queue or lock); with
  atomic rename the last writer wins, without it bytes interleave.
- Use `'wx'` lock files for cross-process exclusion and remove them in
  `finally`; handle stale locks (pid/timestamp inside).

### Paths

- Build paths with `node:path` (`join`, `resolve`, `relative`, `dirname`,
  `basename`, `extname`, `parse`); never concatenate with `'/'`. Use
  `path.posix` for URL paths.
- Resolve files shipped with a module from `import.meta.dirname` (Node
  20.11+) or `__dirname`, not from `process.cwd()`, which depends on where
  the process was started.
- Treat every path segment from outside (URL, upload filename, archive
  entry, API parameter) as hostile: decode (catching `URIError`), reject
  `'\0'`, resolve against a fixed root, and require
  `filePath === root || filePath.startsWith(root + path.sep)`. A bare
  `startsWith(root)` accepts `/static-old/...`. Use `fs.realpath` when
  symlinks inside the root may point outside; store uploads under generated
  names, not client names. More in `node-security` and `node-http-server`.

### Buffers and binary data

- `Buffer` is a `Uint8Array` subclass over an `ArrayBuffer`. Use
  `Buffer.alloc(size)` (zero-filled). Use `Buffer.allocUnsafe(size)` only
  when every byte is overwritten immediately: it may contain old memory of
  other requests or users, so never send or persist it partially filled.
- `buf.subarray()` and `buf.slice()` share memory with the original
  (`Buffer#slice` is deprecated, and unlike `Uint8Array#slice` it does not
  copy). Copy with `Buffer.from(buf)` / `Buffer.copyBytesFrom(view)` before
  mutating or keeping a small piece of a large buffer.
- Small `Buffer.from()`/`allocUnsafe()` results live in a shared 8 KiB pool:
  `buf.buffer` is the whole pool and `buf.byteOffset` is not 0. Always pass
  `byteOffset` and `byteLength` when wrapping: `new DataView(buf.buffer,
  buf.byteOffset, buf.byteLength)`.
- String length is not byte length: use `Buffer.byteLength(text)` for
  `Content-Length`, limits and framing.
- Concatenate byte chunks and decode once (`Buffer.concat(chunks)
  .toString('utf8')`) or use a streaming decoder; decoding chunk by chunk
  breaks multibyte characters.
- Know the encodings: `utf8` (default), `utf16le`, `latin1` (alias
  `binary`), `ascii`, `hex`, `base64` (3 bytes -> 4 chars, `=` padding),
  `base64url` (URL/JWT safe, no padding). Decoding base64 is lenient (skips
  invalid characters): validate strictly where it matters. `buffer.isUtf8()`
  checks input validity.
- Endianness: `DataView` and network protocols default to big-endian,
  typed arrays use the platform order (little-endian on x86/ARM); state it
  explicitly (`readUInt32BE`, `getInt32(offset, true)` for LE).
- For isomorphic code use `Uint8Array`, `DataView`, `TextEncoder` and
  `TextDecoder`; Node APIs accept `Uint8Array` wherever they take a Buffer.
- Frame binary messages with one allocation for header + payload and
  `subarray` for zero-copy payload access (`references/buffers-typedarrays.md`).
- Compare with `buf.equals()` / `Buffer.compare()`; compare secrets with
  `crypto.timingSafeEqual()` (`node-crypto-auth`).

### File watching

- `fs.watch` reports only `'rename'` and `'change'`; deletion and creation
  both arrive as `'rename'`, `filename` can be `null`, one save produces
  several events (editors write temp/backup files and rename), and
  platforms coalesce differently. Never act on the raw event type: collect
  paths, then `stat` each to decide changed vs deleted.
- Debounce and deduplicate: keep a `Map` or `Set` of paths, reset a timer on
  every event, process the batch when it fires.
- Watch directories, not single files: atomic-save editors replace the
  file, and a watcher bound to the old inode goes silent.
- `fs.watch(dir, { recursive: true })` works on Linux, macOS and Windows
  in Node 20+; on older targets watch each directory and add/remove
  watchers as directories appear and disappear.
- Use `fs.watchFile` (stat polling) only where events do not arrive
  (network filesystems, some container volumes).
- Attach `'error'` to every `FSWatcher`, ignore noise (`.git`,
  `node_modules`, dot and `~` files) by path segment, and `close()` watchers
  on shutdown or stop `fs/promises` `watch()` with an `AbortSignal`.
- Development restarts: use `node --watch`, `--watch-path=dir`,
  `--watch-preserve-output`, `--watch-kill-signal=SIGINT` (recent
  releases; the old process gets `SIGTERM` by default) instead of extra
  tools. In production ship new code by a rolling restart, not by
  reloading modules in a running process. Watchers are for data: templates,
  static files, local config (`references/fs-watch.md`).

## Patterns

### Read optional JSON without an exists check

```js
import fsp from 'node:fs/promises';

const readJson = async (filePath, fallback = null) => {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
};
```

Missing file is an expected outcome; permission or parse errors propagate.

### Stat many files in parallel

```js
import fsp from 'node:fs/promises';

const statAll = async (fileNames) => {
  const tasks = [];
  for (const fileName of fileNames) tasks.push(fsp.lstat(fileName));
  const results = await Promise.allSettled(tasks);
  const stats = [];
  for (let i = 0; i < results.length; i++) {
    stats.push({ fileName: fileNames[i], ...results[i] });
  }
  return stats;
};
```

Results keep input order regardless of completion order, and one missing
file does not reject the batch.

### FileHandle lifetime

```js
import fsp from 'node:fs/promises';

const readHeader = async (filePath, sizeBytes = 16) => {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(sizeBytes);
    const { bytesRead } = await handle.read({ buffer, position: 0 });
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

// Node 24+: `await using handle = await fsp.open(filePath, 'r');`
// closes the handle when the block exits.
```

### Process a big file line by line

```js
import fsp from 'node:fs/promises';

const countMatches = async (filePath, pattern) => {
  await using handle = await fsp.open(filePath, 'r');
  let count = 0;
  for await (const line of handle.readLines()) {
    if (pattern.test(line)) count++;
  }
  return count;
};
```

Memory stays bounded by the stream buffer. `await using` closes the handle on
every exit, including `break` and errors, where `readLines()` does not; below
Node 24 use `try`/`finally`. Pass a `pattern` without the `g` or `y` flag:
those make `test()` stateful and skip matches.

### Atomic write

```js
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';

const writeFileAtomic = async (filePath, data) => {
  const suffix = crypto.randomUUID();
  const tmpPath = `${filePath}.${suffix}.tmp`;
  try {
    const handle = await fsp.open(tmpPath, 'wx', 0o644);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmpPath, filePath);
  } catch (error) {
    await fsp.rm(tmpPath, { force: true });
    throw error;
  }
};
```

Readers see either the old or the new complete file. The temp file lives in
the same directory so `rename` stays on one filesystem. The target takes the
temp file's mode, so pass the existing mode when it matters. To survive power
loss on POSIX, also open the directory and `sync()` it after the rename.

### Safe path under a root

```js
import path from 'node:path';

const resolveInside = (root, requestPath) => {
  let decoded = '';
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const filePath = path.resolve(root, `.${path.posix.sep}${decoded}`);
  const isInside = filePath === root || filePath.startsWith(root + path.sep);
  return isInside ? filePath : null;
};

// const STATIC_ROOT = path.resolve(import.meta.dirname, 'static');
```

Rejects `../`, `%2e%2e/`, `..%2f`, malformed escapes, NUL bytes and sibling
directories that share the root prefix. `root` must be absolute and normalized.

### Buffers share memory; views need offsets

```js
const packet = Buffer.from('xxHello');
const body = packet.subarray(2);
body[0] = 0x4a;
console.log(packet.toString());

const own = Buffer.from(body);
own[0] = 0x59;
console.log(packet.toString(), own.toString());

const frame = Buffer.concat([Buffer.from('id'), Buffer.alloc(4)]).subarray(2);
frame.writeInt32BE(123, 0);
const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
console.log(view.getInt32(0), Buffer.byteLength('Привіт'));
```

Prints `xxJello`, `xxJello Yello`, `123 12`; `new DataView(frame.buffer)`
would read bytes of the wrong region.

### Debounced directory watcher

```js
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const IGNORED = new Set(['.git', 'node_modules']);
const GONE = new Set(['ENOENT', 'ENOTDIR']);

const isIgnored = (fileName) => {
  const segments = fileName.split(path.sep);
  for (const segment of segments) {
    if (IGNORED.has(segment)) return true;
  }
  return false;
};

const classify = async (filePath) => {
  try {
    await fsp.stat(filePath);
    return { filePath, kind: 'change' };
  } catch (error) {
    const kind = GONE.has(error.code) ? 'delete' : 'error';
    return { filePath, kind, error };
  }
};

const watchDirectory = (root, onBatch, onError, options = {}) => {
  const { timeoutMs = 300, signal } = options;
  const queue = new Set();
  let timer = null;
  const flush = async () => {
    timer = null;
    const tasks = [];
    for (const filePath of queue) tasks.push(classify(filePath));
    queue.clear();
    const changes = await Promise.all(tasks);
    await onBatch(changes);
  };
  const watcher = fs.watch(root, { recursive: true, signal });
  watcher.on('change', (event, fileName) => {
    if (fileName && isIgnored(fileName)) return;
    const filePath = fileName ? path.join(root, fileName) : root;
    queue.add(filePath);
    clearTimeout(timer);
    timer = setTimeout(() => void flush().catch(onError), timeoutMs);
  });
  watcher.on('error', onError);
  watcher.on('close', () => clearTimeout(timer));
  return watcher;
};
```

Events are collapsed per path and classified by `stat` after the burst. A
failure in `onBatch` goes to `onError` instead of crashing the process as an
unhandled rejection. The watcher stops on `signal` abort or `watcher.close()`.
Ignoring by segment keeps `.github/` and `.gitignore`, which a substring test
for `/.git` would drop. A fuller version also tracks directories and handles
platform errors (`references/fs-watch.md`).

## Anti-patterns

- `readFileSync`/`writeFileSync`/`existsSync` in handlers or after startup.
- `if (fs.existsSync(p)) fs.readFile(p)` or `access` before `open`: race
  and double work; handle `ENOENT` instead.
- `readFile` of logs, dumps, uploads or anything user-sized; JSON
  `stringify` of huge arrays into one `writeFile`.
- `writeFile` directly over important state files; concurrent unsynchronized
  writers.
- `fs.open` without `close` in all paths, including `break` out of
  `readLines()`; `appendFile` per log line.
- `path.join(root, userInput)` without a containment check, or
  `startsWith(root)` without the separator; `decodeURI` without `try`.
- Paths relative to `process.cwd()` for module assets.
- `Buffer.allocUnsafe(n)` returned or sent before every byte is written.
- Keeping `subarray`/`slice` pieces of big or pooled buffers (retains
  memory, sees later mutations); `new DataView(buf.buffer)` without offset.
- `text.length` as byte count; `chunk.toString()` per chunk.
- Acting on raw `fs.watch` event names; one watcher per file of a folder;
  no debounce; watchers never closed; an async watcher callback without a
  `catch`.
- `delete require.cache[...]` as a production hot-reload mechanism.

## Checklist

- [ ] No `*Sync` calls outside startup code or CLI/batch scripts.
- [ ] Text reads pass an encoding; binary reads expect Buffers.
- [ ] Missing/existing files handled via `error.code`, not pre-checks;
      exclusive creation uses `'wx'`.
- [ ] Large or unbounded files are streamed; FileHandles closed in
      `finally` or by `await using`.
- [ ] State/config writes are atomic (temp + sync + rename) and serialized.
- [ ] Every external path is decoded safely, NUL-checked and contained
      under `root + path.sep`.
- [ ] No partially filled `allocUnsafe`; shared-memory views copied when
      kept or mutated; DataView/TypedArray views pass `byteOffset`.
- [ ] Byte lengths use `Buffer.byteLength`/`byteLength`; endianness explicit.
- [ ] Watchers watch directories, debounce, classify by `stat`, handle
      `'error'`, and are closed on shutdown.

More: `references/buffers-typedarrays.md`, `references/fs-watch.md`.

Related skills: `node-streams`, `node-security`, `node-http-server`,
`node-modules-packages`, `node-crypto-auth`, `js-async-concurrency`,
`node-graceful-shutdown`.
