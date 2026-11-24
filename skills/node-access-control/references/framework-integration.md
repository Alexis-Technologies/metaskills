# Enforcing access with Kerberos

Goal everywhere: the rule is declared on the route or procedure, enforced by one hook before the
handler runs, and a route without a rule fails closed, preferably at startup.

## Fastify

The rule lives in the route `config`. An `onRoute` hook refuses to start with an undeclared route, and
an `onRequest` hook enforces the rule before the body is parsed.

```js
const fp = require('fastify-plugin');

const isPreflightRoute = ({ method, url }) => method === 'OPTIONS' && url === '*';

const isReviewedRoute = (url, prefixes) => {
  for (const prefix of prefixes) {
    if (url === prefix || url.startsWith(`${prefix}/`)) return true;
  }
  return false;
};

const accessPlugin = async (fastify, { kerberos, authenticate, publicPrefixes = [] }) => {
  fastify.decorateRequest('principal', null);

  fastify.addHook('onRoute', (route) => {
    if (isPreflightRoute(route) || route.config?.access !== undefined) return;
    if (!isReviewedRoute(route.url, publicPrefixes)) {
      throw new Error(`No access rule for ${route.method} ${route.url}`);
    }
    route.config = { ...route.config, access: 'public' };
  });

  fastify.addHook('onRequest', async (request) => {
    if (request.is404) return;
    const { access } = request.routeOptions.config;
    if (access === 'public') return;
    if (!access?.resource) throw fastify.httpErrors.forbidden();
    const principal = await authenticate(request);
    if (principal === null) throw fastify.httpErrors.unauthorized();
    const { resource: kind, action } = access;
    const resource = { id: kind, kind, attr: {} };
    const isAllowed = await kerberos.isAllowed({ principal, resource, action });
    if (!isAllowed) throw fastify.httpErrors.forbidden();
    request.principal = principal;
  });
};

module.exports = fp(accessPlugin, { name: 'access', dependencies: ['@fastify/sensible'] });
```

```js
app.patch('/patients/:id', {
  config: { access: { resource: 'patient', action: 'use' } },
  handler: async (request) => updatePatient(deps, request.principal, request.params.id, request.body),
});

app.post('/signin', { config: { access: 'public' } }, signin);
```

- `fastify-plugin` puts the hooks in the parent scope, so child plugins inherit them. Register the
  plugin before any route.
- **Register `@fastify/cors` before this plugin.** Its hook then answers the preflight. In the other
  order the preflight gets 403.
- The auto-generated `HEAD` route inherits the `GET` config, so it passes `onRoute` and is enforced.
- Routes added by third-party plugins (docs UI, metrics) have no rule, so startup fails until you
  review them. List the ones that may be public in `publicPrefixes`: `/docs` covers `/docs/json`, not
  `/docs-private`. Anything else needs its own rule or must not be exposed.
- `request.routeOptions.config` is the Fastify 5 API.
- The boundary action is unconditional. Record rules run in the service, with the loaded record.

## wrpc

Use the `authorize` hook from `SKILL.md` as a router-level `preValidation`. It runs after the session
gate and before input validation, for calls, subscriptions and inbound events, and also when wrpc is
mounted in Fastify. Declare the rule in `meta.authz`.

Checked over a real WebSocket on wrpc 2.2.0 and Kerberos 4.3.0:

| Caller | Guarded procedure | No `meta.authz` | Bare function | Subscription |
| --- | --- | --- | --- | --- |
| Anonymous | 403 | | | |
| Session without the role | 403 | 403 | 403 | 403 |
| Session with the role | runs | 403 | | runs, undeclared one 403 |

## List endpoints: query plans

`isAllowed` per row does not scale, and loading rows to filter them leaks through timing and memory.
`planResources` turns the policy into a filter for the DAL:

```js
const { PlanKind } = require('@alexify/kerberos');

const ATTRIBUTE = 'request.resource.attr.';
const RESOURCE_ID = 'request.resource.id';
const COMPARE = { eq: '$eq', ne: '$ne', lt: '$lt', le: '$lte', gt: '$gt', ge: '$gte' };
const MIRROR = { eq: 'eq', ne: 'ne', lt: 'gt', le: 'ge', gt: 'lt', ge: 'le' };
const LOGIC = { and: '$and', or: '$or' };

const postFilter = (reason) => new Error(`post-filter required: ${reason}`);

const toField = ({ variable }) => {
  if (variable === RESOURCE_ID) return 'id';
  if (variable?.startsWith(ATTRIBUTE)) return variable.slice(ATTRIBUTE.length);
  throw postFilter('unsupported operand');
};

const toValue = (operand) => {
  if (operand.value === undefined || operand.value === null) throw postFilter('null comparison');
  return operand.value;
};

const toComparison = (operator, operands) => {
  const isVariableFirst = operands[0].variable !== undefined;
  const field = toField(isVariableFirst ? operands[0] : operands[1]);
  const value = toValue(isVariableFirst ? operands[1] : operands[0]);
  const name = isVariableFirst ? operator : MIRROR[operator];
  return { [field]: { [COMPARE[name]]: value } };
};

const toMembership = (operands) => {
  if (operands[0].variable !== undefined) return { [toField(operands[0])]: { $in: toValue(operands[1]) } };
  return { [toField(operands[1])]: { $eq: toValue(operands[0]) } };
};

const toFilter = (operand) => {
  if (!operand.expression) throw postFilter('bare operand');
  const { operator, operands } = operand.expression;
  if (operator === 'not') return { $nor: [toFilter(operands[0])] };
  if (operator === 'in') return toMembership(operands);
  if (COMPARE[operator]) return toComparison(operator, operands);
  if (!LOGIC[operator]) throw postFilter(operator);
  const parts = [];
  for (const item of operands) parts.push(toFilter(item));
  return { [LOGIC[operator]]: parts };
};

const planToFilter = (plan) => {
  if (plan.filter.kind === PlanKind.AlwaysAllowed) return {};
  if (plan.filter.kind === PlanKind.AlwaysDenied) return null;
  return toFilter(plan.filter.condition);
};

const listPatients = async ({ kerberos, patients }, principal) => {
  const resource = { kind: 'patient' };
  const plan = await kerberos.planResources({ principal, resource, action: 'read' });
  const filter = planToFilter(plan);
  if (filter === null) return [];
  const scoped = { $and: [{ tenantId: principal.attr.tenantId }, filter] };
  return patients.find(scoped, { limit: 100 }).toArray();
};
```

- `null` means return nothing, without a query.
- The tenant predicate is added even though the policy checks it too.
- `opaque` (a JavaScript function condition) and `relation` operands throw instead of being dropped.
  Handle them by fetching a bounded candidate set and post-filtering with `checkResources`, or expand
  relations first with `expandRelationOperands`.
- MongoDB differs from JavaScript in two ways that can widen access. `{ a: { $eq: null } }` also
  matches a missing field, so null comparisons throw here. `$eq` also matches **inside an array**, so
  use `===` in policies only on scalar fields, and `.includes` for array attributes.
- A plan inlines values from the principal. Keep it on the server.

## Stored policies

```js
const { Kerberos, createSafeExprCodec } = require('@alexify/kerberos');
const jsep = require('jsep');

const createEngine = (policies, derivedRoles, cache) => {
  const codec = createSafeExprCodec({ jsep });
  return new Kerberos(policies, derivedRoles, { cache, codec, onError: 'deny' });
};
```

- `cache` is anything with `get(key)`. Keys are `resource:<kind>:<version>:<scope>`,
  `role:<role>:<version>:<scope>`, `principal:<id>:<version>:<scope>` and `derivedRoles:<name>`.
- Kerberos only reads. Storage, TTL and invalidation across instances are yours.
- Stored conditions are `{ "$expr": "..." }` strings, evaluated by an allow-listing AST evaluator
  rather than `eval`. Still treat write access to the store as admin access.
- Use `cacheKeyPrefix` when tenants or environments share one store.

## Relations (ReBAC)

```js
const { RelationResolver } = require('@alexify/kerberos/relations');

const schema = {
  relationSchema: {
    definitions: {
      user: {},
      team: { relations: { member: ['user'] } },
      catalog: { relations: { viewer: ['user', 'team#member'] } },
      report: {
        relations: { catalog: ['catalog'], owner: ['user'] },
        permissions: { view: { anyOf: ['owner', { via: 'catalog', permission: 'viewer' }] } },
      },
    },
  },
};

const tuples = [
  'team:ops#member@user:olga',
  'catalog:q3#viewer@team:ops#member',
  'report:r1#catalog@catalog:q3',
];

const relations = new RelationResolver({ schema, tuples, onTruncated: 'throw' });
const reportRoles = { name: 'report_roles', definitions: [{ name: 'REPORT_VIEWER', relation: 'view' }] };
```

- A policy rule then uses `derivedRoles: ['REPORT_VIEWER']`, with `relations` passed to `Kerberos`.
- Set `onTruncated: 'throw'` when lookups feed a filter. By default `lookupResources` silently stops at
  `maxResults` (1000).
- Through a cache, a just-revoked subject may pass on another host until invalidation arrives. For
  revocation-sensitive checks, shorten that window or read the current state.

## Domain checks stay framework-free

Record rules live in services and repositories that receive the identity as an argument. Tests need
no HTTP server: pass a principal and a fake repository.
