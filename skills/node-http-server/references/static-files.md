# Static files: safe paths, in-memory cache, compression, Range

In an Alexis app static assets live on a CDN (the Vue SPA of auth8 is on Vercel) and Node serves the
API. Serve files from Node only in a library, a tool, or a small deployment.

## Rules

- Resolve the root once with `path.resolve`. For each request: `decodeURIComponent` inside `try`,
  reject `\0`, `path.resolve(root, '.' + path.sep + name)`, then allow only
  `full === root || full.startsWith(root + path.sep)`. Symlinks, `realpath` and uploads are in
  `node-security`.
- Open the file, `stat` the handle, require `isFile()`, then send headers and
  `pipeline(handle.createReadStream(), res)`. Failures before the headers become 404 or 500. After
  them, destroy the response.
- Map extensions to MIME types with `charset=utf-8` for text, default to
  `application/octet-stream`, and send `X-Content-Type-Options: nosniff`.
- Send `ETag` or `Last-Modified` and answer 304 to `If-None-Match`.
- Stream large files and support `Range` (206, and 416 with `Content-Range: bytes */size`).

## Traversal-safe path

```js
const STATIC_ROOT = path.resolve('static');

const resolveStatic = (pathname) => {
  let decoded = '';
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const name = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const filePath = path.resolve(STATIC_ROOT, `.${path.sep}${name}`);
  const isInside = filePath === STATIC_ROOT || filePath.startsWith(STATIC_ROOT + path.sep);
  return isInside ? filePath : null;
};
```

Verified against `/../x`, `/%2e%2e/x`, `/..%2fx`, `/..%2fstatic-secret%2fx`, `%00` and malformed
escapes.

## Two strategies, often combined

1. Small and hot files (HTML, JS, CSS, icons, fonts): read once at startup into a
   `Map<urlPath, entry>` with a precomputed ETag and compressed variants, refresh on file changes.
   Serving is a `Map.get` plus `res.end(buffer)`: no syscalls per request, and only known keys can be
   served, so traversal is impossible by construction.
2. Large files (video, archives): keep only metadata, stream from disk with `pipeline` and support
   `Range` requests.

Verified on Node.js 24: gzip negotiation with `Vary: Accept-Encoding`, ETag 304, `Range: bytes=0-9`,
suffix range `bytes=-5`, a suffix longer than the file, an end past the file clamped to the last byte,
invalid range 416, a 2 MB file streamed, `/../secret.txt` 404.

```js
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');

const ROOT = path.resolve(__dirname, 'static');
const MAX_CACHED_BYTES = 1024 * 1024;
const COMPRESSIBLE = new Set(['html', 'js', 'css', 'json', 'svg', 'txt']);
const DEFAULT_MIME = 'application/octet-stream';
const MIME_TYPES = {
  __proto__: null,
  html: 'text/html; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  bin: DEFAULT_MIME,
};
const RANGE = /^bytes=(\d*)-(\d*)$/;

const gzip = promisify(zlib.gzip);
const files = new Map();

const toKey = (filePath) => filePath.slice(ROOT.length).split(path.sep).join('/');

const cacheFile = async (filePath) => {
  const stat = await fsp.stat(filePath);
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const mime = MIME_TYPES[extension] ?? DEFAULT_MIME;
  const key = toKey(filePath);
  if (stat.size > MAX_CACHED_BYTES) {
    const file = { filePath, size: stat.size, mime, data: null, gzipped: null, etag: '' };
    return void files.set(key, file);
  }
  const data = await fsp.readFile(filePath);
  const hash = crypto.createHash('sha1').update(data).digest('base64url');
  const gzipped = COMPRESSIBLE.has(extension) ? await gzip(data) : null;
  files.set(key, { filePath, size: stat.size, mime, data, gzipped, etag: `"${hash}"` });
};

const cacheDirectory = async (directory) => {
  const items = await fsp.readdir(directory, { withFileTypes: true });
  const tasks = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemPath = path.join(directory, item.name);
    tasks.push(item.isDirectory() ? cacheDirectory(itemPath) : cacheFile(itemPath));
  }
  await Promise.all(tasks);
};

const parseRange = (header, size) => {
  const match = RANGE.exec(header);
  if (!match) return null;
  const from = match[1];
  const to = match[2];
  if (from === '' && to === '') return null;
  if (from === '') {
    const suffix = Number(to);
    if (suffix === 0 || size === 0) return null;
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (start > end) return null;
  return { start, end };
};

const serveLarge = async (req, res, file) => {
  const { range } = req.headers;
  if (!range) {
    const headers = { 'Content-Type': file.mime, 'Content-Length': file.size };
    res.writeHead(200, headers);
    return pipeline(fs.createReadStream(file.filePath), res);
  }
  const bounds = parseRange(range, file.size);
  if (!bounds) {
    res.writeHead(416, { 'Content-Range': `bytes */${file.size}` });
    return void res.end();
  }
  const { start, end } = bounds;
  res.writeHead(206, {
    'Content-Type': file.mime,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${file.size}`,
    'Accept-Ranges': 'bytes',
  });
  return pipeline(fs.createReadStream(file.filePath, { start, end }), res);
};

const serveCached = (req, res, file) => {
  if (req.headers['if-none-match'] === file.etag) {
    res.writeHead(304, { ETag: file.etag });
    return void res.end();
  }
  const accepts = req.headers['accept-encoding'] ?? '';
  const useGzip = file.gzipped !== null && accepts.includes('gzip');
  const body = useGzip ? file.gzipped : file.data;
  const headers = {
    'Content-Type': file.mime,
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
    ETag: file.etag,
    Vary: 'Accept-Encoding',
  };
  if (useGzip) headers['Content-Encoding'] = 'gzip';
  res.writeHead(200, headers);
  res.end(body);
};

const listener = (req, res) => {
  const index = req.url.indexOf('?');
  const pathname = index === -1 ? req.url : req.url.slice(0, index);
  const key = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const file = files.get(key);
  if (!file) return void res.writeHead(404).end();
  if (file.data) return void serveCached(req, res, file);
  serveLarge(req, res, file).catch(() => res.destroy());
};

const main = async () => {
  await cacheDirectory(ROOT);
  http.createServer(listener).listen(8060);
};

main();
```

## Rules of thumb

- Await the warm-up (`await cacheDirectory(ROOT)`) before `listen`, and keep Buffers: reading binary
  files as `utf8` corrupts PNG and ICO.
- Compress once at load time (`zlib.gzip`, `brotliCompress`, and `zstdCompress` on Node 22.15+/23.8+),
  never per request for static content. Skip already-compressed formats (png, jpg, webp, woff2, zip).
- Hash-named assets (`app.3f9c1a.js`): `Cache-Control: public, max-age=31536000, immutable`. Entry
  points (`index.html`) and API JSON: `no-cache` plus ETag, so clients revalidate.
- Directory URLs: map `/dir/` to `/dir/index.html`. Single-page apps fall back to one `index.html`.
- Directory listings are a development feature. Disable them in production.
- Refresh the cache with a debounced `fs.watch`. On delete remove the key, on change re-read and
  recompute ETag and compressed variants.
