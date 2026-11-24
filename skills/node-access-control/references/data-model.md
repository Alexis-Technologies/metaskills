# Permission data model

Who holds which role is data in your collections. What a role may do is a Kerberos policy. Start with
the core (marked *) and add the rest only when the domain needs record-level or grouped grants.

## Collections

One repository per aggregate, over the native driver (see `node-data-access`). System fields are `v`
and `rev`.

| Collection | Key fields | Notes |
| --- | --- | --- |
| `accounts` * | `id`, `login` (unique), `active`, `fullName` | full name is one string: name structure differs by country |
| `credentials` * | `accountId`, `passwordHash` | apart from the profile, never projected to a client |
| `memberships` * | `accountId`, `tenantId`, `roles` | unique on (`accountId`, `tenantId`); roles of this account in this tenant |
| `roles` | `tenantId`, `name`, `active`, `divisionId` | `active: false` disables the role everywhere at once |
| `divisions` | `tenantId`, `name`, `parentId` | department tree, only to organize roles and accounts |
| `divisionRoles` | `divisionId`, `roleId` | default roles copied to an account when it joins |
| `catalogs` | `tenantId`, `name` | named group of records from any collection; also navigation |
| `relationTuples` | `resource`, `relation`, `subject` | record, team and catalog grants for `RelationResolver` |
| `sessions` * | `id`, `accountId`, `expiresAt` | see `node-crypto-auth` |
| `locks` | `sessionId`, `resource`, `createdAt` | optional: exclusive edit of a resource, often a catalog |
| `journal` * | `accountId`, `sessionId`, `resource`, `action`, `details`, `ip`, `createdAt` | append-only audit trail |

Actions are independent names (`read`, `update`, `delete`, `audit`). Never store them as ranked levels:
a rank makes the highest action imply all the others.

## How a check resolves

For a principal with active roles, record `r` of kind `K`, and action `a`:

1. Load the principal's roles for the tenant from `memberships`, dropping inactive roles.
2. Kerberos evaluates the `ResourcePolicy` of `K`: rules by role, derived roles by conditions on the
   record, and relation-backed roles through the resolver.
3. Within a role, a deny beats an allow. Across roles, an allow from any role wins.
4. A `RolePolicy` can narrow a role. A `PrincipalPolicy` can override for one account.
5. Nothing decided means denied.

For a field, check the action `read:<field>` or `write:<field>`. For a list, use `planResources` and
add the result to the query.

## Grants through catalogs

A catalog groups records from different collections, so one grant covers what a role needs. Model it
as relations (`report#catalog@catalog:q3`, `catalog:q3#viewer@team:ops#member`) and read them with
`RelationResolver`.

Prefer explicit grants and copy defaults at assignment time. Inherited grants through deep trees make
it hard to see who gained what. When the domain really is a hierarchy, `via` expresses it, and
`maxDepth` (default 50) bounds the walk.

## Journal protection

Give the application's database role `insert` and `find` on `journal`, with no `update` or `remove`,
so even compromised application code cannot rewrite the trail:

```js
const resource = { db: 'app', collection: 'journal' };
const privileges = [{ resource, actions: ['insert', 'find'] }];

await adminDb.command({ createRole: 'journalWriter', privileges, roles: [] });
```

## Roles are data, policies are reviewed

- Seed default roles with a migration (see `alexis-libraries` for `@alexify/migronaut`). The
  application knows only actions and resource kinds.
- Typical roles: external user, internal employee, admin, auditor (reads the journal only), support
  (time-limited session takeover, visible to the user).
- Assigning a role is itself an action (`role`, `assign`), checked by Kerberos and journaled.
- Policies live in a package, go through code review, and have tests in `KerberosTests` from
  `@alexify/kerberos/tests`, with one negative case per rule.

## Simple usage first

The same model supports a minimal setup: `accounts`, `memberships`, one resource policy per kind, and
the journal. Relations, catalogs and field actions are added later without changing the collections
you already have.
