# Plain `ws` server and client: when the peer does not speak wrpc

Use wrpc by default (`references/wrpc-patterns.md`). This file is for a peer
that speaks plain WebSocket: a device, a third-party protocol, a bridge. It
shows what wrpc does for you. Verified on Node.js 24 with `ws` 8 and the global
`WebSocket` client: an unauthenticated upgrade is refused, calls get callbacks,
room broadcasts skip the sender, and a reconnecting client restores its room.

Replace the in-memory `sessions` map with your session store, and validate
`args` with a metaschema `Schema` before the handler call.

## Rooms registry (`rooms.js`)

```js
const OPEN = 1;
const MAX_BUFFERED_BYTES = 1024 * 1024;

class Rooms {
  #rooms = new Map();

  join(name, client) {
    let room = this.#rooms.get(name);
    if (!room) {
      room = new Set();
      this.#rooms.set(name, room);
    }
    room.add(client);
    client.rooms.add(name);
  }

  leave(name, client) {
    const room = this.#rooms.get(name);
    if (!room) return;
    room.delete(client);
    client.rooms.delete(name);
    if (room.size === 0) this.#rooms.delete(name);
  }

  leaveAll(client) {
    for (const name of client.rooms) this.leave(name, client);
  }

  // Serialize once, send many; skip closed and slow consumers
  broadcast(name, event, data, except = null) {
    const room = this.#rooms.get(name);
    if (!room) return 0;
    const packet = JSON.stringify({ type: 'event', name: event, data });
    let sent = 0;
    for (const client of room) {
      if (client === except) continue;
      const { socket } = client;
      if (socket.readyState !== OPEN) continue;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        socket.close(1013, 'Slow consumer');
        continue;
      }
      socket.send(packet);
      sent++;
    }
    return sent;
  }
}

module.exports = { Rooms };
```

`broadcast` returns how many clients received the packet; `1013` tells a
slow client to reconnect later instead of growing server memory.

## Server (`server.js`)

```js
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { Rooms } = require('./rooms.js');

const PING_INTERVAL_MS = 10000;
const ALLOWED_ORIGINS = new Set(['https://app.example.com']);
const sessions = new Map([['secret-token', { userId: 'marcus' }]]);
const STATUS_BY_CODE = {
  ALX_ERR_VALIDATION: 400,
  ALX_ERR_FORBIDDEN: 403,
};
const logger = console; // Pino in an app

class DomainError extends Error {
  constructor(message, options = {}) {
    const { code = 'ALX_ERR_DOMAIN', details = null } = options;
    super(message, options);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

const restoreSession = async (req) => {
  const cookie = req.headers.cookie ?? '';
  const match = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  return match ? (sessions.get(match[1]) ?? null) : null;
};

const reject = (socket, code, message) => {
  socket.end(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
};

const rooms = new Rooms();
const clients = new Set();

const api = {
  'room/join': ({ room }, client) => {
    rooms.join(room, client);
    rooms.broadcast(room, 'room/joined', { user: client.session.userId });
    return { joined: room };
  },
  'room/send': ({ room, text }, client) => {
    if (!client.rooms.has(room)) {
      throw new DomainError('Not a member', { code: 'ALX_ERR_FORBIDDEN' });
    }
    const data = { user: client.session.userId, text };
    rooms.broadcast(room, 'room/message', data, client);
    return { sent: true };
  },
};

// Domain errors carry a code, and the wire a numeric status, as in wrpc.
// Anything else is a bug: generic 500 + id
const toCallbackError = (error) => {
  const status = error instanceof DomainError ? STATUS_BY_CODE[error.code] : undefined;
  if (status !== undefined) return { code: status, message: error.message };
  const errorId = crypto.randomUUID();
  logger.error({ err: error, errorId }, 'unhandled error');
  return { code: 500, message: 'Internal error', errorId };
};

const call = async (client, { id, method, args }) => {
  const handler = Object.hasOwn(api, method) ? api[method] : null;
  if (!handler) {
    const error = { code: 404, message: 'Not found' };
    return void client.send({ type: 'callback', id, error });
  }
  try {
    const result = await handler(args ?? {}, client);
    client.send({ type: 'callback', id, result });
  } catch (error) {
    client.send({ type: 'callback', id, error: toCallbackError(error) });
  }
};

const receive = (client, data, isBinary) => {
  if (isBinary) return void client.socket.close(1003, 'Text only');
  let packet = null;
  try {
    packet = JSON.parse(data.toString());
  } catch {
    return void client.socket.close(1007, 'Invalid JSON');
  }
  const isCall = packet?.type === 'call' && typeof packet.method === 'string';
  if (isCall) return void call(client, packet);
  if (packet && Object.keys(packet).length === 0) return void client.send({});
  client.socket.close(1008, 'Unknown packet');
};

const server = http.createServer((req, res) => {
  res.end('static files and HTTP API live here');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

const upgrade = async (req, socket, head) => {
  const pathname = req.url.split('?')[0];
  if (pathname !== '/ws') return void reject(socket, 404, 'Not Found');
  const { origin } = req.headers;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return void reject(socket, 403, 'Forbidden');
  }
  const session = await restoreSession(req);
  if (!session) return void reject(socket, 401, 'Unauthorized');
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, session);
  });
};

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  upgrade(req, socket, head).catch(() => {
    reject(socket, 500, 'Internal Server Error');
  });
});

wss.on('connection', (socket, req, session) => {
  const client = {
    socket,
    session,
    rooms: new Set(),
    isAlive: true,
    send: (packet) => socket.send(JSON.stringify(packet)),
  };
  clients.add(client);
  socket.on('pong', () => {
    client.isAlive = true;
  });
  socket.on('message', (data, isBinary) => receive(client, data, isBinary));
  socket.on('error', () => socket.terminate());
  socket.on('close', () => {
    rooms.leaveAll(client);
    clients.delete(client);
  });
});

const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.isAlive) {
      client.socket.terminate();
      continue;
    }
    client.isAlive = false;
    client.socket.ping();
  }
}, PING_INTERVAL_MS);
heartbeat.unref();

const shutdown = () => {
  clearInterval(heartbeat);
  server.close();
  for (const client of clients) client.socket.close(1001, 'Server shutdown');
  const timer = setTimeout(() => {
    for (const client of clients) client.socket.terminate();
  }, 5000);
  timer.unref();
};

server.listen(8000);
process.on('SIGTERM', shutdown);
```

## Testing it with `node:test` and the global `WebSocket`

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

describe('ws server', () => {
  it('should reject an upgrade without a session', async () => {
    const ws = new WebSocket('ws://127.0.0.1:8000/ws');
    const events = await once(ws, 'close');
    assert.equal(events[0].code, 1006); // handshake refused with HTTP 401
  });

  it('should broadcast room/joined to a client that joins', async () => {
    const headers = { cookie: 'token=secret-token' };
    const ws = new WebSocket('ws://127.0.0.1:8000/ws', { headers });
    await once(ws, 'open');
    const args = { room: 'r1' };
    ws.send(JSON.stringify({ type: 'call', id: '1', method: 'room/join', args }));
    const messages = await once(ws, 'message');
    assert.equal(JSON.parse(messages[0].data).type, 'event'); // room/joined comes first
    ws.close();
  });
});
```

To test heartbeat termination, open a raw `net` socket, write the upgrade
request by hand, read the `101` answer and then never respond to pings: the
server must close the socket after at most two ping intervals.

## A dependency-free reconnecting client

For Node.js 22+ (global `WebSocket`). In a browser replace `EventEmitter` with
`EventTarget` or a small emitter. It speaks the envelope of the server above.

```js
const { EventEmitter } = require('node:events');

const CALL_TIMEOUT_MS = 7000;
const PING_INTERVAL_MS = 20000;
const PONG_TIMEOUT_MS = 5000;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30000;

const nextDelay = (attempt) => {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(Math.random() * ceiling);
};

class RealtimeClient extends EventEmitter {
  #url;
  #options;
  #socket = null;
  #attempt = 0;
  #calls = new Map();
  #seq = 0;
  #timer = null;
  #pinger = null;
  #lastSeen = 0;
  #isClosed = false;

  constructor(url, options = {}) {
    super();
    this.#url = url;
    this.#options = options;
    this.#open();
  }

  get isOpen() {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  #open() {
    const socket = new WebSocket(this.#url, this.#options.init);
    this.#socket = socket;
    socket.addEventListener('open', () => this.#onOpen());
    socket.addEventListener('message', ({ data }) => this.#onMessage(data));
    socket.addEventListener('close', () => this.#onClose());
    socket.addEventListener('error', () => {});
  }

  async #onOpen() {
    this.#attempt = 0;
    this.#lastSeen = Date.now();
    const { pingMs = PING_INTERVAL_MS } = this.#options;
    this.#pinger = setInterval(() => this.#ping(pingMs), pingMs);
    try {
      if (this.#options.restore) await this.#options.restore(this);
      this.emit('open');
    } catch (error) {
      if (this.listenerCount('error') > 0) this.emit('error', error);
      this.#socket.close(4001, 'Restore failed');
    }
  }

  // Any packet proves the link is alive; '{}' is answered with '{}'
  #ping(pingMs) {
    const { pongMs = PONG_TIMEOUT_MS } = this.#options;
    const silenceMs = Date.now() - this.#lastSeen;
    if (silenceMs > pingMs + pongMs) {
      return void this.#socket.close(4000, 'Heartbeat timeout');
    }
    this.#socket.send('{}');
  }

  #onMessage(data) {
    this.#lastSeen = Date.now();
    const packet = JSON.parse(data);
    const { type, name } = packet;
    if (type === 'event') return void this.emit(name, packet.data);
    if (type !== 'callback') return;
    const pending = this.#calls.get(packet.id);
    if (!pending) return;
    this.#calls.delete(packet.id);
    clearTimeout(pending.timer);
    if (packet.error) pending.reject(new Error(packet.error.message));
    else pending.resolve(packet.result);
  }

  #onClose() {
    clearInterval(this.#pinger);
    for (const pending of this.#calls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection lost'));
    }
    this.#calls.clear();
    this.emit('close');
    if (this.#isClosed) return;
    const delay = nextDelay(this.#attempt++);
    this.#timer = setTimeout(() => this.#open(), delay);
  }

  call(method, args = {}) {
    if (!this.isOpen) return Promise.reject(new Error('Not connected'));
    const id = `${++this.#seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#calls.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, CALL_TIMEOUT_MS);
      this.#calls.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ type: 'call', id, method, args }));
    });
  }

  close() {
    this.#isClosed = true;
    clearTimeout(this.#timer);
    this.#socket.close(1000, 'Client closed');
  }
}
```

`init` is `{ headers: { cookie } }` in Node.js only, because browsers read the
second argument as subprotocols. `restore` re-joins rooms on every open:
`(client) => client.call('room/join', { room: 'general' })`.
