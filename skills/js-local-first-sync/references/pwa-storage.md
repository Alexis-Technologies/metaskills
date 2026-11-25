# PWA, Service Worker and client storage for local-first apps

Read this when writing or reviewing a Service Worker, caching rules, the
update flow, IndexedDB/OPFS persistence, or a shared sync connection. The
caching strategies were run on Node.js 24 with fake `caches` and `fetch`, and
the IndexedDB wrapper with `fake-indexeddb`. Registration and OPFS follow the
standard APIs and were not run in a browser.

## Service Worker lifecycle

| Phase      | Event / API                         | Do                                                    |
| ---------- | ----------------------------------- | ----------------------------------------------------- |
| Register   | `navigator.serviceWorker.register('/worker.js')` | Serve from the root so the scope is `/`; HTTPS or localhost |
| Install    | `install`, `event.waitUntil()`      | Precache a versioned list of assets                   |
| Waiting    | `registration.waiting`              | Old worker still controls open pages                  |
| Activate   | `activate`, `clients.claim()`       | Delete caches of other versions, take control         |
| Run        | `fetch`, `message`, `push`, `sync`  | Route requests, relay messages; may be stopped any time |

Calling `skipWaiting()` during install and `clients.claim()` during activate
makes every deploy take over immediately. That is fine for a demo. For
production either keep old asset URLs valid (hashed file names) or ask the
user before switching (see "Update flow").

## Worker with versioned precache and per-resource strategies

```js
const CACHE = 'app-v42'; // bump on every deploy (or inject a build hash)
const ASSETS = ['/', '/index.html', '/app.js', '/styles.css', '/offline.html'];

const cacheFirst = async (request) => {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
};

const networkFirst = async (request, timeoutMs = 3000) => {
  const cache = await caches.open(CACHE);
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(request, { signal });
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
};

const staleWhileRevalidate = async (request, waitUntil) => {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request).then(async (response) => {
    if (response.ok) await cache.put(request, response.clone());
    return response;
  });
  if (!cached) return refresh;
  waitUntil(refresh.catch(() => {}));
  return cached;
};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  const cleanup = async () => {
    const names = await caches.keys();
    const deletions = [];
    for (const name of names) {
      if (name !== CACHE) deletions.push(caches.delete(name));
    }
    await Promise.all(deletions);
    await self.clients.claim();
  };
  event.waitUntil(cleanup());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skipWaiting') self.skipWaiting();
});

const offline = () => caches.match('/offline.html');

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // data goes through sync
  if (request.mode === 'navigate') {
    return void event.respondWith(networkFirst(request).catch(offline));
  }
  if (url.pathname.startsWith('/avatars/')) {
    const waitUntil = (promise) => event.waitUntil(promise);
    return void event.respondWith(staleWhileRevalidate(request, waitUntil));
  }
  event.respondWith(cacheFirst(request));
});
```

Notes:

- `cache.addAll` fails the whole install if one asset fails; keep the list
  exact (generate it at build time).
- Returning without `respondWith` lets the browser handle the request
  normally; do that for everything you do not own.
- Cache-first HTML without a network path means users never see a deploy;
  navigations go network-first.
- Respect `Cache-Control: no-store` for personal data; clear caches on
  sign-out.

## Update flow in the page

```js
let isUpdating = false;

const offerUpdate = (worker) => {
  showBanner('New version available', () => {
    isUpdating = true;
    worker.postMessage({ type: 'skipWaiting' });
  });
};

const registration = await navigator.serviceWorker.register('/worker.js');
if (registration.waiting) offerUpdate(registration.waiting);
registration.addEventListener('updatefound', () => {
  const worker = registration.installing;
  worker.addEventListener('statechange', () => {
    const isUpdate = navigator.serviceWorker.controller !== null;
    if (worker.state === 'installed' && isUpdate) offerUpdate(worker);
  });
});
navigator.serviceWorker.addEventListener('controllerchange', () => {
  if (isUpdating) location.reload();
});
```

The `isUpdating` flag avoids a reload loop on the first install, when
`clients.claim()` also fires `controllerchange`.

## One connection for all tabs inside a worker

With wrpc, run `WrpcClientProxy` in the worker and connect pages with
`WrpcClient.connect(url, { worker })`: the proxy routes answers to the port
that asked and broadcasts events to every port. With syncom, `openShared()`
elects a leader tab that alone replicates.

A hand-written worker splits into caching, one connection (reconnect, outbox)
and sync (state in OPFS, CRDT apply). The worker sends its last log position
and receives missed deltas. Tabs send deltas to the worker, which applies,
broadcasts to other tabs, and forwards or queues.

```js
const broadcast = async (packet, exceptId = '') => {
  const tabs = await self.clients.matchAll({ includeUncontrolled: true });
  for (const tab of tabs) {
    if (tab.id !== exceptId) tab.postMessage(packet);
  }
};

self.addEventListener('message', (event) => {
  const { type, data } = event.data;
  if (type !== 'delta') return;
  const deliver = async () => {
    await outbox.add(data); // IndexedDB/OPFS: survives worker restarts
    await broadcast({ type: 'delta', data }, event.source.id);
    if (connection.isOpen) await connection.flush(outbox);
  };
  event.waitUntil(deliver());
});
```

Caveats: the browser may stop an idle Service Worker and its WebSocket with
it, and tabs pinging the worker do not guarantee its lifetime. Persist the
outbox and cursor, and re-sync on every worker start. A leader tab with
`navigator.locks` and `BroadcastChannel` (see SKILL.md) avoids the worker
lifetime problem at the cost of one more election.

## IndexedDB: a thin promise wrapper

```js
const openDatabase = (name, version, upgrade) =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = (event) => {
      upgrade(request.result, event.oldVersion);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close(); // let another tab upgrade
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => console.warn('Close other tabs to upgrade');
  });

// One transaction over one or more stores; resolves after commit
const transact = (db, stores, mode, body) =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const result = body(tx);
    tx.oncomplete = () => {
      resolve(result instanceof IDBRequest ? result.result : result);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });

const db = await openDatabase('app', 1, (database, oldVersion) => {
  if (oldVersion < 1) {
    database.createObjectStore('records', { keyPath: 'id' });
    database.createObjectStore('outbox', { autoIncrement: true });
    database.createObjectStore('meta'); // cursor, replica id
  }
});

// Record and its operation commit together or not at all
const saveChange = (record, op) =>
  transact(db, ['records', 'outbox'], 'readwrite', (tx) => {
    tx.objectStore('records').put(record);
    tx.objectStore('outbox').add(op);
  });

const readOutbox = () =>
  transact(db, 'outbox', 'readonly', (tx) => tx.objectStore('outbox').getAll());

// Remove acknowledged operations up to a key (outbox keys grow in order)
const acknowledge = (lastKey) =>
  transact(db, 'outbox', 'readwrite', (tx) => {
    tx.objectStore('outbox').delete(IDBKeyRange.upperBound(lastKey));
  });
```

Rules: no `await` of network or timers inside `body` (the transaction
commits as soon as it has no pending requests); version upgrades only in
`onupgradeneeded`, branching on `oldVersion`; validate records against a
schema before `put`. To know which keys to acknowledge, read the outbox
with `getAllKeys()` in the same way as `getAll()`. Prefer this thin wrapper,
with schemas and a declarative `select({ store, where, order, limit, offset })`,
over raw inline calls (untestable) and repository ceremony.

## OPFS for files and logs

```js
const readJson = async (name, fallback) => {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name, { create: true });
  const text = await (await handle.getFile()).text();
  return text ? JSON.parse(text) : fallback;
};

const writeJson = async (name, data) => {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name, { create: true });
  if (!handle.createWritable) throw new Error('Use createSyncAccessHandle');
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(data));
  await writable.close(); // the new content replaces the file on close
};
```

`createSyncAccessHandle()` (fast, synchronous reads and writes) exists only
in dedicated workers. Rewriting one big JSON file per change does not scale:
append deltas to segment files and compact with snapshots.

## Durability and quota

```js
const isPersisted = await navigator.storage.persist();
const { usage, quota } = await navigator.storage.estimate();
```

- Without persistence the browser may evict the origin's storage under
  pressure; Safari also removes script-written storage of sites not used
  for 7 days unless installed to the home screen. The server copy and the
  sync log are the recovery path; never keep the only copy of user data in
  the browser.
- Catch `QuotaExceededError` on writes and tell the user; compact logs and
  drop caches before failing.

In syncom, `db.persist()` and `db.quota()` wrap these calls. A full origin is a
`QUOTA` rejection when the log refuses the op, or an `UNPERSISTED` `error` event
when the op is logged and its record is held in memory until the next open.
