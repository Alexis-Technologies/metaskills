---
name: node-access-control
description: Authorization with @alexify/kerberos for roles, ownership, tenants, fields. Use when protecting routes or wrpc procedures or reviewing access
---

# Node.js Access Control

Design authorization as a small subsystem: policies as reviewable data in `@alexify/kerberos`, one
fail-closed enforcement point at the boundary, record and field checks in the application layer, and
an audit trail. Never hand-write an RBAC table or scatter role checks through handlers.

|             | Library `@alexify/*`                    | App (`auth8`)                                      |
| ----------- | --------------------------------------- | -------------------------------------------------- |
| Enforcement | Takes an injected `authorize` callback  | Fastify hook, wrpc `preValidation` hook            |
| Policies    | None of its own                         | `ResourcePolicy`, `DerivedRoles` in a package      |
| Data checks | Caller's concern                        | Repository of the DAL, filter from `planResources` |

More code: [references/framework-integration.md](references/framework-integration.md) (Fastify,
query plans, stored policies, relations),
[references/data-model.md](references/data-model.md) (collections, grants, journal).

**Target Kerberos 4.x.** Below 4.0 a partial-wildcard deny (`view:*`) does not deny. `auth8` still pins
`^2.0.1`: until that changes, list actions in deny rules there, and run the policy tests across the
upgrade, because 4.0 changed conflict resolution.

## Rules

### Structure

- Keep three subsystems apart: authentication (who is calling, see `node-crypto-auth`), authorization
  (policies and checks), and audit (journal of what was used).
- **Deny by default.** Every route and procedure declares its rule, and one without a declaration is
  refused. Anonymous access is an explicit `public`. Kerberos itself denies when no policy or rule
  matches.
- Declare access as metadata next to the endpoint and enforce it in one place: a Fastify hook or a
  wrpc router hook. Handlers never parse tokens or cookies.
- Application code asks for an action on a resource (`patient`, `update`), never for a role name.
  Roles appear only in policies.
- Two levels of checks:
  1. **Boundary:** may this caller use this kind of resource at all? A rule with no conditions on the
     record, such as the action `use`.
  2. **Application and data:** may this caller touch this record or field (ownership, tenant, state)?
     Load the record, pass its attributes to Kerberos, and filter lists with `planResources`.
- Take identity, tenant and roles from the server-side session, never from arguments, headers or the
  client.
- Set `onError: 'deny'`. The default is `'throw'`, so a failing condition or cache would surface as
  a 500 rather than a refusal.

### wrpc: `access` is not authorization

The default is `access: 'session'`: an anonymous caller gets 403, but **every authenticated session is
admitted**, whatever its role. Any value other than `'public'` or `'session'` throws when the procedure
is built, and wrpc has no roles. So authorization must run in a router-level `preValidation` hook,
which covers calls, subscriptions and inbound events. The hook is in the patterns below.

A subscription is authorized when it starts, never per value. When a role is revoked, end the
subscription or the session (see `node-crypto-auth`).

### Choosing a model

| Model | Kerberos feature | Use for | Watch out |
| --- | --- | --- | --- |
| RBAC | `ResourcePolicy` rules with `roles` | Actions per role | No record rules by itself |
| Ownership, ABAC | `DerivedRoles` with a condition on `P` and `R` | Owner, tenant, state, region | Conditions need the record's attributes |
| Per-user override | `PrincipalPolicy` | Exceptions for one account | Decides first, overrides role rules |
| Role ceiling | `RolePolicy` with `allowActions` | Keep a role read-only | Filters only that role |
| ReBAC | `relation` derived roles, `RelationResolver` | Teams, folders, sharing | Deep graphs, staleness |
| Tenant overrides | `scope` on policies | Per-tenant policy differences | Selects policy, does **not** isolate data |

Start with resource policies plus ownership and tenant conditions. Add relations when grants follow
a graph, such as a team that sees a folder of records.

### Kerberos semantics that decide security

- **Actions are independent. There are no levels.** `audit` does not imply `read`, and nothing implies
  `delete`. Never model actions as a ranked list: a scale such as
  `read < insert < update < delete < audit` hands an auditor the right to delete.
- **An allow from any role wins across roles.** A deny applies within the role it names, so
  `Deny close` for `AUDITOR` does not stop a user who is also `SUPPORT`. A deny that must always hold
  uses `roles: ['*']`.
- A `RolePolicy` narrows only its own role. A user with `auditor` and `editor` can still do what
  `editor` allows. Keep separation of duties by not granting both roles.
- A condition that reads a missing attribute sees `undefined`. Load the record first.
- **`[].every(...)` is `true`.** A condition such as `R.attr.ids.every(isMember)` grants access on an
  empty list. Require a non-empty list.
- Name globs work by segment: `read:*` matches `read:name`, not `read` or `read:a:b`.
- Conditions the planner must translate are `{ $expr: '...' }`. A JavaScript function plans as
  `opaque`.

### Sessions, caching, revocation

- Build the principal per request from server state. Do not copy derived permissions into the
  session, and never trust roles from JWT claims: they stay valid until the token expires.
- Revoke immediately: update the account's roles and revoke its sessions, including live WebSocket
  connections on every instance.
- Static policies live in code and ship by deploy. Stored policies go through the `cache` option with
  a `codec`. Kerberos only reads them, so invalidation is yours, and the staleness window equals your
  invalidation delay. Keep revocation-sensitive rules out of a slow cache.
- Bound session lifetime (hours, not months) so stale state ages out even if an invalidation is
  missed.

### Multi-tenancy

- `tenantId` comes from the session. Every repository method takes it and adds it to the filter, and
  unique indexes include it. Keep this even when a policy also checks the tenant: two independent
  checks must both fail before data leaks.
- Cross-tenant operations (support, billing) use a separate action and a separate code path, and are
  journaled.

### Objects and fields

- Check access on every request that takes an id (IDOR). Unguessable ids reduce enumeration, they do
  not replace checks.
- Choose one policy for "exists but forbidden" and apply it everywhere. Returning 404 for records
  outside the caller's scope avoids confirming they exist.
- Field rules apply both ways: project readable fields on output, and accept only writable fields on
  input. This blocks mass assignment such as `{ role: 'admin' }` in a profile update.
- Guard the write with the `rev` you checked, so a record closed between the check and the update is
  not changed.

### Audit and operations

- Journal every use of a privileged action and every change of grants: who, when, which resource,
  what changed, from which IP. Append-only, separate from application logs, readable by an `auditor`
  role that has no write rights.
- Write the journal entry in the same transaction as the change it records.
- Kerberos gives the decision trail: a Pino `logger` gets one structured entry per action, the
  `decision` event feeds metrics, and an awaited `afterRequest` hook suits a blocking audit sink.
- Support impersonation is an explicit permission: time-limited, visible to the user, and journaled.
- Serve admin and infrastructure APIs from a separate process or port with its own database role and
  OS rights (see `node-security`).

## Patterns

### Policy: independent actions, a read-only auditor

```js
const { Kerberos, createSafeExprCodec, deserializePolicy } = require('@alexify/kerberos');
const jsep = require('jsep');

const SAME_TENANT = 'R.attr.tenantId === P.attr.tenantId';
const ALLOW = 'EFFECT_ALLOW';

const tenantRole = (name, parent, extra = '') => {
  const $expr = extra === '' ? SAME_TENANT : `${SAME_TENANT} && ${extra}`;
  return { name, parentRoles: [parent], condition: { match: { $expr } } };
};

const careRoles = {
  name: 'care_roles',
  definitions: [
    tenantRole('treating_doctor', 'doctor', 'R.attr.doctorId === P.id'),
    tenantRole('tenant_auditor', 'auditor'),
    tenantRole('tenant_admin', 'admin'),
  ],
};

const DOCTOR_ACTIONS = ['read', 'update', 'read:name', 'read:diagnosis', 'write:diagnosis'];

const patientPolicy = {
  resourcePolicy: {
    resource: 'patient',
    version: 'default',
    importDerivedRoles: ['care_roles'],
    rules: [
      { actions: ['use'], effect: ALLOW, roles: ['doctor', 'auditor', 'admin'] },
      { actions: DOCTOR_ACTIONS, effect: ALLOW, derivedRoles: ['treating_doctor'] },
      { actions: ['read', 'read:name', 'audit'], effect: ALLOW, derivedRoles: ['tenant_auditor'] },
      { actions: ['delete'], effect: ALLOW, derivedRoles: ['tenant_admin'] },
      {
        name: 'closed-record',
        actions: ['update', 'delete'],
        effect: 'EFFECT_DENY',
        roles: ['*'],
        condition: { match: { $expr: "R.attr.status === 'closed'" } },
      },
    ],
  },
};

const codec = createSafeExprCodec({ jsep });
const policies = [deserializePolicy(patientPolicy, codec)];
const derivedRoles = [deserializePolicy(careRoles, codec)];
const kerberos = new Kerberos(policies, derivedRoles, { onError: 'deny' });
```

The auditor can `read` and `audit`, and is denied `update` and `delete`. `jsep` is a dependency of the
app, injected into the codec.

### wrpc: fail-closed authorization hook

```js
// wrpc's numeric wire status: the one exception to `ALX_ERR_` codes
const forbidden = () => {
  const error = new Error('Forbidden');
  error.code = 403;
  return error;
};

const authorize = async (context) => {
  if (context.procedure.access === 'public') return;
  const authz = context.procedure.meta.authz;
  if (!authz) throw forbidden();
  const { id, roles } = context.session.state.user;
  const principal = { id, roles };
  const resource = { id: authz.id ?? authz.resource, kind: authz.resource, attr: {} };
  const isAllowed = await kerberos.isAllowed({ principal, resource, action: authz.action });
  if (!isAllowed) throw forbidden();
};

const meta = { authz: { resource: 'patient', action: 'use' } };
const units = { patient: { update: procedure({ meta, handler: updateHandler }) } };
const router = defineRouter(units, { hooks: { preValidation: authorize } });
```

The hook passes no record attributes, so it can only answer the boundary question. A procedure with
no `meta.authz` is refused for every session, including a bare function.

### Record and field checks in a service

```js
const PATIENT_FIELDS = ['name', 'diagnosis', 'discount'];

const toPrincipal = ({ id, roles, tenantId }) => ({ id, roles, attr: { tenantId } });

const toResource = ({ id, tenantId, doctorId, status }) => {
  return { id, kind: 'patient', attr: { tenantId, doctorId, status } };
};

const grantedFields = async (kerberos, principal, resource, mode) => {
  const actions = [];
  for (const field of PATIENT_FIELDS) actions.push(`${mode}:${field}`);
  const resources = [{ resource, actions }];
  const response = await kerberos.checkResources({ principal, resources }, true);
  const effects = response.results[0].actions;
  const granted = new Set();
  for (const field of PATIENT_FIELDS) {
    if (effects[`${mode}:${field}`] === true) granted.add(field);
  }
  return granted;
};

const project = (record, fields) => {
  const result = {};
  for (const field of fields) {
    if (Object.hasOwn(record, field)) result[field] = record[field];
  }
  return result;
};

const assertWritable = (patch, fields) => {
  for (const key of Object.keys(patch)) {
    if (!fields.has(key)) throw new DomainError('ALX_ERR_FORBIDDEN', { details: { field: key } });
  }
};

const updatePatient = async ({ kerberos, patients, journal, transaction }, user, id, patch) => {
  const principal = toPrincipal(user);
  const filter = { id, tenantId: user.tenantId };
  const patient = await patients.findOne(filter);
  if (patient === null) throw new DomainError('ALX_ERR_NOT_FOUND');
  const resource = toResource(patient);
  const canUpdate = await kerberos.isAllowed({ principal, resource, action: 'update' });
  if (!canUpdate) throw new DomainError('ALX_ERR_NOT_FOUND');
  assertWritable(patch, await grantedFields(kerberos, principal, resource, 'write'));
  const guard = { ...filter, rev: patient.rev };
  const change = { $set: patch, $inc: { rev: 1 } };
  await transaction(async (session) => {
    const { matchedCount } = await patients.updateOne(guard, change, { session });
    if (matchedCount === 0) throw new DomainError('ALX_ERR_CONFLICT');
    const entry = { accountId: user.id, resource: `patient:${id}`, action: 'update', patch };
    await journal.insertOne({ ...entry, createdAt: new Date() }, { session });
  });
};
```

`DomainError` and the mapping of its codes to HTTP statuses come from `error-handling`.

## Anti-patterns

- `if (user.role === 'admin')` in handlers: role names in code, no single place to audit.
- Cumulative action levels: whatever ranks highest silently gains every action below it.
- A hook that sets `request.isAllowed` for a later hook to read: a reordering disables the check.
  Attach the rule to the route and fail closed.
- Relying on wrpc `access: 'session'` as authorization, or on `access: 'admin'`, which throws.
- A deny rule on one role expected to override another role's allow.
- Allow by default: new endpoints are open until someone remembers to add a check.
- Trusting `tenantId`, `userId` or `role` from the body, the query or a client-readable token.
- Loading all rows and filtering in JavaScript, or checking the owner on read but not on update.
- Roles and permissions inside JWT claims with long expiry.
- `R.attr.ids.every(...)` in a condition with no check that the list is non-empty.
- One shared "super admin" account, or an admin identified by a hard-coded email in a policy.
- `update(id, request.body)` without a writable-field list (mass assignment).

## Checklist

- [ ] Every route and procedure declares access; missing means refused; public ones are reviewed
- [ ] wrpc has a router-level `preValidation` authorization hook
- [ ] Kerberos 4.x with `onError: 'deny'`
- [ ] Code references actions, not role names
- [ ] No action implies another; the auditor has no write action
- [ ] Denies that must always hold use `roles: ['*']`
- [ ] Record rules (owner, tenant, state) run on every read, update and delete
- [ ] Lists use `planResources`; `opaque` and `relation` never become a silent allow
- [ ] Identity, tenant and roles come from the server-side session
- [ ] Readable and writable fields are restricted per role
- [ ] Revoking a role or blocking an account takes effect on live sessions and subscriptions
- [ ] Privileged actions and grant changes are journaled in the same transaction
- [ ] Admin APIs are on a separate process or port with their own DB role
- [ ] Tests cover "other user's id", "other tenant's id", "no session", "undeclared endpoint", and one
      negative case per policy rule

Related skills: `node-crypto-auth`, `node-security`, `alexis-libraries`, `error-handling`,
`node-layered-architecture`
