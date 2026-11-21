# syncom client: opening offline

Read this when wiring `@alexify/syncom` into a client. It is 0.0.1 and unpublished: use a workspace
link or a git dependency, with the maintainer's agreement, and never the registry.

## A first dial that fails is not retried

wrpc reconnects a link that was once open. A **first** `WrpcClient.connect` to an unreachable server
rejects, and syncom then holds the node with no link. Observed on 0.0.1: one dial, then nothing for as
long as the test waited, and the offline write never reached the server once it came up. Only
`db.sync.sync()` dials such a node again, so an app that can open offline needs a loop:

```js
// dial.js
const keepDialing = (db, { minMs = 1000, maxMs = 30000 } = {}) => {
  let attempt = 0;
  let timer = null;
  let isDialing = false;
  let isStopped = false;
  const isConnected = () => {
    const peers = db.sync.peers();
    for (let i = 0; i < peers.length; i++) {
      if (!peers[i].connected) return false;
    }
    return peers.length > 0;
  };
  const tick = async () => {
    if (isStopped || isDialing) return;
    isDialing = true;
    clearTimeout(timer);
    if (isConnected()) attempt = 0;
    else await db.sync.sync().catch(() => {});
    isDialing = false;
    if (isStopped) return;
    const ceiling = Math.min(maxMs, minMs * 2 ** attempt++);
    timer = setTimeout(tick, Math.round(Math.random() * ceiling));
  };
  globalThis.addEventListener?.('online', tick);
  tick();
  return () => {
    isStopped = true;
    clearTimeout(timer);
    globalThis.removeEventListener?.('online', tick);
  };
};

module.exports = { keepDialing };
```

- Full jitter keeps a fleet of clients from redialing together after an outage.
- The loop only dials while a peer is down, and `online` wakes it at once.
- Call the returned function before `db.close()`.
- With `openShared()`, run it on the leader only: `shared.sync` throws `NOT_LEADER` on a follower.
  `onLeader` does not fire for a tab that already leads at open, so check `isLeader()` first.
