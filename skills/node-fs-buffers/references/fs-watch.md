# File watching, caches and reloading data

## What `fs.watch` really reports

- Two event types only: `'rename'` (create, delete, rename, often also
  modify on macOS) and `'change'` (content or metadata). There is no
  "deleted" event: `stat` the path after the event.
- `filename` is relative to the watched directory and may be `null`;
  build the full path yourself and fall back to the watched path.
- One user action can produce several events: editors save through a temp
  file and rename (vim swap files and `4913` probes, JetBrains
  `___jb_tmp___`, dot-backups), formatters rewrite twice, git checkout
  touches many files.
- Backends differ:

| Platform | Backend | Notes |
| --- | --- | --- |
| Linux | inotify | per-directory watches; limit `fs.inotify.max_user_watches` (error `ENOSPC`); watches bind to inodes, so a replaced file goes silent |
| macOS | FSEvents | recursive natively, coalesces and may delay events, reports `'rename'` for most changes |
| Windows | ReadDirectoryChangesW | removing a watched directory raises `EPERM` on the watcher |
| Network FS, some container bind mounts | none / partial | events may never arrive: use `fs.watchFile` polling |

- `fs.watch(dir, { recursive: true })` is available on all three desktop
  platforms in Node 20+ (Linux support arrived in 19.1/20).

## Robust watcher shape

The debounced watcher in `SKILL.md` covers most needs. A watcher that cannot
rely on `recursive` adds these properties:

- watch each directory with `fs.watch`, scan subdirectories with
  `readdir({ withFileTypes: true })`, add watchers for new directories and
  remove watchers of deleted ones;
- after every raw event run `stat` to classify: directory -> (re)watch,
  file exists -> change, `ENOENT` -> delete;
- queue `Map<filePath, eventName>` (deduplicated, last event wins), reset a
  debounce timer, then report the whole batch at once;
- ignore results that arrive after `close()`, treat Windows `EPERM` as
  directory removal, and clear timers and watchers in `close()`.

Apply a batch atomically: rebuild derived data once per batch, not once per
file.

## Async iterator form

```js
import { watch } from 'node:fs/promises';

const followChanges = async (dir, signal, onChange) => {
  try {
    const events = watch(dir, { recursive: true, signal });
    for await (const { eventType, filename } of events) {
      onChange(eventType, filename);
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  }
};
```

Keep the loop body fast (push into a debounce queue); events are buffered
while it runs.

## Polling fallback

```js
import fs from 'node:fs';

const pollFile = (filePath, onChange, intervalMs = 2000) => {
  const listener = (current, previous) => {
    if (current.mtimeMs !== previous.mtimeMs) onChange(current);
  };
  fs.watchFile(filePath, { interval: intervalMs }, listener);
  return () => fs.unwatchFile(filePath, listener);
};
```

`watchFile` stats the file every interval: works everywhere, costs I/O,
reports deletion as `mtimeMs === 0`.

## In-memory cache refreshed by a watcher

Load a folder into a `Map` at start and refresh entries on change; requests
are served only from the cache (no disk access, no traversal by construction):

```js
import fsp from 'node:fs/promises';
import path from 'node:path';

const GONE = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

const createFileCache = (root) => {
  const files = new Map();
  const keyOf = (filePath) => path.relative(root, filePath).replaceAll(path.sep, '/');

  const load = async (filePath) => {
    const key = keyOf(filePath);
    try {
      const data = await fsp.readFile(filePath);
      files.set(key, data);
    } catch (error) {
      if (!GONE.has(error.code)) throw error;
      files.delete(key);
    }
  };

  const loadAll = async () => {
    const options = { withFileTypes: true, recursive: true };
    const entries = await fsp.readdir(root, options);
    const tasks = [];
    for (const entry of entries) {
      if (entry.isFile()) tasks.push(load(path.join(entry.parentPath, entry.name)));
    }
    await Promise.all(tasks);
  };

  return { files, load, loadAll };
};
```

Wire `load` to the debounced watcher (`change` and `delete` both call
`load`, which re-reads or drops the entry). A permission or descriptor error
propagates instead of silently evicting the file. Store Buffers (optionally
pre-gzipped) so a response is the buffer itself. Start the server only after
`loadAll()` resolves, otherwise a request can arrive before the cache is
ready.

## Restarting during development

| Flag | Effect |
| --- | --- |
| `node --watch app.js` | restart when the entry point or imported modules change |
| `--watch-path=./config` | watch these paths instead (repeatable); disables import tracking |
| `--watch-preserve-output` | do not clear the console on restart |
| `--watch-kill-signal=SIGINT` | signal sent to the old process (default `SIGTERM`; recent releases, check `node --help`) |

Handle the kill signal for graceful shutdown (`node-graceful-shutdown`).

## Reloading at runtime

- Reload data, not code. Templates, static files and local config can be
  refreshed by a watcher. New application code ships as a new image through a
  rolling restart.
- `delete require.cache[require.resolve(file)]` is for experiments only: old
  module objects stay referenced by importers, ESM has no cache deletion, and
  memory grows with every version.
- File deployments are not atomic (git pull, rsync): files land one by one.
  Accumulate changes, apply them after a quiet period, and keep the previous
  version if loading or validating the new one fails.
- While a batch is applied, a request in flight keeps what it already read.
  Swap the whole structure with one assignment rather than mutating it in
  place.
