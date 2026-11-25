# Router for node:http

For a zero-dependency library. An app uses Fastify's router.

## Dispatch table with parameters, compiled once

Exact routes live in a `Map`. Parameter routes are compiled at startup into a list of segments, and
compared segment by segment, so no RegExp is built or tested per request.

```js
const matchSegments = (segments, parts) => {
  if (segments.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.startsWith(':')) params[segment.slice(1)] = parts[i];
    else if (segment !== parts[i]) return null;
  }
  return params;
};

const createRouter = (routes) => {
  const exact = new Map();
  const templates = [];
  const paths = new Set();
  const keys = Object.keys(routes);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const separator = key.indexOf(' ');
    const method = key.slice(0, separator);
    const pattern = key.slice(separator + 1);
    const handler = routes[key];
    paths.add(pattern);
    if (pattern.includes('/:')) templates.push({ method, segments: pattern.split('/'), handler });
    else exact.set(key, handler);
  }

  const findTemplate = (method, parts) => {
    let isPathKnown = false;
    for (let i = 0; i < templates.length; i++) {
      const template = templates[i];
      const params = matchSegments(template.segments, parts);
      if (params === null) continue;
      isPathKnown = true;
      if (template.method === method) return { handler: template.handler, params, status: 200 };
    }
    return { handler: null, params: null, status: isPathKnown ? 405 : 404 };
  };

  return (method, pathname) => {
    const handler = exact.get(`${method} ${pathname}`);
    if (handler) return { handler, params: {}, status: 200 };
    const found = findTemplate(method, pathname.split('/'));
    if (found.status === 404 && paths.has(pathname)) return { ...found, status: 405 };
    return found;
  };
};

const route = createRouter({
  'GET /user/me': getCurrentUser,
  'GET /user/:id': getUser,
  'POST /user/:id/rename': renameUser,
});
```

Verified: `GET /user/me` wins over `/user/:id`, `GET /user/7` gives `{ id: '7' }`, `POST /user/me` and
`GET /user/7/rename` are 405, an unknown path is 404, and `/constructor` is 404 because keys are looked
up in a `Map`.

- Input-derived keys go through a `Map`, or `Object.create(null)` with `Object.hasOwn`. With a plain
  object `/api/constructor` resolves to `Object` and answers 200.
- Never build a RegExp from request data. A catastrophic pattern in a path matcher is a classic
  ReDoS.
- A handler returns data, and the transport serializes it with one serializer table.

## Per-route wrappers

In a library without a framework, wrappers replace middleware: each route states what applies, and a
wrapper cannot touch the socket.

```js
const withAuth = (handler) => async (args, context) => {
  if (!context.session) throw new DomainError('ALX_ERR_AUTH');
  return handler(args, context);
};

const withCache = (handler, { ttlMs }) => {
  const entries = new Map();
  return async (args, context) => {
    const key = JSON.stringify(args);
    const entry = entries.get(key);
    if (entry && entry.expires > Date.now()) return entry.value;
    const value = await handler(args, context);
    entries.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  };
};

const api = new Map();
api.set('catalog/list', withCache(listCatalog, { ttlMs: 10_000 }));
api.set('order/create', withAuth(createOrder));
```

Bound the `withCache` map (LRU, or a size check) when keys come from user input. In Fastify the same
job is done by `preHandler` hooks and `@fastify/caching`.
