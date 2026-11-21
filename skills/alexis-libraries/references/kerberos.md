# @alexify/kerberos

In-process authorization engine with Cerbos-shaped policies: RBAC, ABAC, derived roles, scopes,
ReBAC and query plans. Version 4.3.0, tag `v4.3.0`, Node.js 18+, no runtime dependencies. Runs in
Node.js and the browser.

| Entry | Holds |
| --- | --- |
| `@alexify/kerberos` | `Kerberos`, `Effect`, `PlanKind`, `createSafeExprCodec`, `serializePolicy`, `deserializePolicy`, `createCacheReader`, error classes |
| `/tests` | `KerberosTests`, the declarative policy test runner |
| `/relations` | `RelationResolver`, the Zanzibar-lite ReBAC resolver |
| `/cerbos` | `importCerbosPolicies`, YAML and CEL import |
| `/loader` | `loadPolicyFile`, `loadPolicyDirectory`, `createPolicyBundle`, Node.js only |

## Target 4.x

This skill targets 4.x. Below 4.0, a partial wildcard in a `DENY` rule does not deny:

| Consumer | Pin | Installed | `DENY view:*` on `view:secret` |
| --- | --- | --- | --- |
| `alioth-api` | `^1.0.0` | 1.0.0 | **allowed** (fail-open) |
| `auth8` | catalog `^2.0.1` | 2.0.1 | **allowed** (fail-open) |
| this repository | | 4.3.0 | denied |

A caret range never crosses the major, so these consumers stay exposed until the pin changes. Until
then, do not write partial-wildcard deny rules there. List the actions.

Upgrading is not a drop-in change. 4.0 resolves resource-policy conflicts per principal role,
evaluates scoped policies per action and role, makes role policies a narrowing filter, and turns
`Effect` and `PlanKind` into const objects. 3.0 throws on duplicate policy keys. Run the policy test
suite of the app across the upgrade.

## When to choose it

- Roles, ownership, tenancy or attribute rules decide an action.
- The same policy must answer "may this user do X" and "which records may this user see".
- Rules should be data that can be reviewed, tested and audited.

Not for authentication (who the caller is) and not for rate limits. A single `isAdmin` check in a
script does not need an engine.

## Core API

```js
const { Kerberos, Effect } = require('@alexify/kerberos');

const expensePolicy = {
  resourcePolicy: {
    resource: 'expense',
    version: 'default',
    importDerivedRoles: ['common_roles'],
    rules: [
      { actions: ['*'], effect: Effect.Allow, roles: ['ADMIN'] },
      { actions: ['view', 'delete'], effect: Effect.Allow, derivedRoles: ['OWNER'] },
    ],
  },
};

const ownerMatch = ({ P, R }) => R.attr.ownerId === P.id;
const ownerRole = { name: 'OWNER', parentRoles: ['USER'], condition: { match: ownerMatch } };
const commonRoles = { name: 'common_roles', definitions: [ownerRole] };

const kerberos = new Kerberos([expensePolicy], [commonRoles], { onError: 'deny' });

const principal = { id: 'sally', roles: ['USER'] };
const resource = { id: 'e1', kind: 'expense', attr: { ownerId: 'sally' } };
await kerberos.isAllowed({ principal, resource, action: 'delete' }); // true
```

| Method | Returns |
| --- | --- |
| `isAllowed({ principal, resource, action })` | `Promise<boolean>` |
| `checkResources({ principal, resources: [{ resource, actions }] }, effectAsBoolean?)` | `{ kerberosCallId, results: [{ resource, actions, outputs }] }` |
| `planResources({ principal, resource: { kind }, action })` | `{ filter: { kind, condition } }` |
| `on`, `once`, `off` | lifecycle events that never affect a decision |

Options worth setting: `onError`, `logger` (a Pino instance gets one structured audit entry per
action), `hooks`, `hooksTimeoutMs`, `relationsTimeoutMs`, `maxConcurrency`, `cache` with `codec` for
stored policies, `schemas` for attribute enforcement.

## In a wrpc procedure

wrpc checks one thing itself: a call without a session is refused unless the procedure is `public`.
Everything finer is a hook. Run Kerberos in `preValidation`, which runs for calls, subscriptions and
inbound events, after the session gate and before input validation. Make the hook fail closed, so a
procedure that declares no rule is refused:

```js
const SELF_AUTHORIZED = new Set(['system/introspect']);

const forbidden = () => {
  const error = new Error('Forbidden');
  error.code = 403;
  return error;
};

const authorize = async (context) => {
  const { procedure, session, method } = context;
  if (procedure.access === 'public' || SELF_AUTHORIZED.has(method)) return;
  const authz = procedure.meta.authz;
  if (!authz) throw forbidden();
  const { id, roles } = session.state.user;
  const principal = { id, roles };
  const resource = { id: authz.id ?? authz.resource, kind: authz.resource, attr: {} };
  const isAllowed = await kerberos.isAllowed({ principal, resource, action: authz.action });
  if (!isAllowed) throw forbidden();
};

const handler = async () => loadReport();
const meta = { authz: { resource: 'report', action: 'read' } };
const units = { report: { read: procedure({ meta, handler }) } };
const router = defineRouter(units, { hooks: { preValidation: authorize } });
```

Checked over a real WebSocket: a `USER` session gets 403 on the guarded and on an undeclared
procedure, an `ADMIN` session passes the guarded one.

`system/introspect` has no `meta.authz`, so without the exemption `client.load()` gets 403 under
`introspection: 'session'`. A mounted syncom unit has none either: a service that mounts one also
returns early on `method.startsWith('syncom/')`, because the unit's own `authorize` and
`authorizeWrite` decide. The full hook is in `node-websocket-realtime`.

## List endpoints: query plans

`isAllowed` per row does not scale. `planResources` turns the policy into a filter for the DAL:

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
```

`null` means return nothing without a query. A plan is only as good as its conditions:

- MongoDB differs from JavaScript in two ways that can widen access. `{ a: { $eq: null } }` also
  matches a missing field, so null comparisons throw here. `$eq` also matches inside an array, so
  use `===` in policies only on scalar fields.
- A JavaScript function condition is `opaque` in the plan. Write conditions the planner must see as
  `{ $expr: "R.attr.ownerId === P.id" }` and load them with
  `deserializePolicy(policy, createSafeExprCodec({ jsep }))`. `jsep` is injected by the app.
- `opaque` and `relation` operands cannot become a filter. Fail, or fetch and post-filter with
  `checkResources`.
- A plan inlines values derived from the principal. Keep it on the server.

## Gotchas

- `onError` defaults to `'throw'`: a throwing condition rejects the call. Set `'deny'` in production
  so an evaluation error is a refusal.
- No matching policy means deny, for an empty policy set too.
- Name matching is a glob by segment: `view:*` matches `view:public`, not `view` or `view:a:b`. `**`
  crosses segments, a bare `*` matches anything.
- Kinds are sanitized on both sides: `a-b` and `a_b` are one resource, and duplicates throw.
- A role policy is a filter: it denies every action it does not allow for that role, across kinds.
- Hooks must not mutate `ctx.args`. Return a replacement from `beforeRequest`. A throw is a veto.
- `resource.attr` holds what the conditions read. Load the record first, or the rule sees nothing.

## Testing

Write policies with fixtures in `KerberosTests` from `/tests`: principals, resources and expected
effects as data. Include one negative case per rule, and pin every rule that denies.

Related skills: `node-access-control`, `node-crypto-auth`, `js-contracts-schemas`
