# Strangler: replace or extract step by step

Use it when a legacy app is replaced, or a module of the monolith moves into its own service. A
big-bang rewrite trades known bugs for unknown ones and stops delivery until the end. The strangler
keeps both running and moves traffic one route at a time.

## Steps

1. **Put a facade at the edge.** Every request passes one entry (the Fastify app, or the proxy in
   front of it) that decides where it goes. Nothing calls the old system around it.
2. **Pick one bounded context** with a clear contract and few writers: sessions, notifications,
   billing. Not the module everything joins.
3. **Build it behind the same contract**: the same schemas from `@alexify/metaschema`, the same
   error codes, the same ids. Contract tests run against both sides.
4. **Route by path, behind a flag.** The new code serves its routes; the rest is proxied to the old
   system. Switching back is a config change, not a deploy.
5. **Compare before you cut.** For reads, call both and log the differences (shadow reads) for a
   while. For writes, there is one owner at a time.
6. **Move the data with the routes.** The new side owns its collections. Until the old side is
   gone, it learns about changes through events (outbox), never through writes to the other's
   collections.
7. **Delete the old code** when its routes carry no traffic. A strangler that never deletes is two
   systems to run.

## Fastify facade

```ts
// plugins/legacy-proxy.ts: routes not ported yet go to the old app
import proxy from '@fastify/http-proxy';
import fp from 'fastify-plugin';

export default fp(
  async (fastify) => {
    await fastify.register(proxy, {
      upstream: fastify.config.LEGACY_URL,
      prefix: '/v1/billing',
      rewritePrefix: '/billing',
    });
  },
  { name: 'legacy-proxy', dependencies: ['config'] },
);
```

Set the timeouts of the proxy's client, as for any upstream (`node-http-server`). When
`/v1/billing` is ported, the module registers its routes under that prefix and the proxy entry
is removed in the same change.

## Done for one context

- Its routes are served by the new code, with the flag kept for one release.
- Its collections have one writer, and the shadow comparison shows no differences.
- Errors and latency of the new side are on the dashboards (`node-observability`).
- The old code and its proxy entry are deleted.

## Anti-patterns

- A shared database written by both sides: neither can change its schema.
- Moving traffic by percentage on write routes: two owners of the same document.
- Porting the code as-is into the new service: the old coupling moves with it.
- A facade that is a new framework of its own (Platformatic, gateways with logic) instead of a
  thin route switch.
