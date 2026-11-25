---
title: Upstream
description: How this repository relates to metarhia/metaskills and how changes are ported.
---

# Upstream

alexiskills (`@alexify/metaskills` on npm) is a mechanical fork of
[metarhia/metaskills](https://github.com/metarhia/metaskills) v1.0.6, commit `ab13efe`. The files
were copied into this repository. It is not a GitHub fork, it shares no git history with upstream,
and it has no `upstream` remote.

## What differs

- The skills use the Alexis toolchain: oxlint, oxfmt, pnpm, 100 or 120 columns, from
  `.oxfmtrc.json`, CommonJS without `'use strict'`, and one-pass loops in `src/`.
- The CLI links `@alexify/metaskills` and never installs a package by itself.
- The repository has the gates, CI and documentation of the other Alexis libraries.

## Porting a change

Compare a separate clone of upstream with the commit this repository is based on:

```bash
git -C /path/to/metarhia/metaskills fetch origin
git -C /path/to/metarhia/metaskills diff ab13efe origin/main -- skills scripts evals
```

Apply what is worth taking by hand, in its own commit, keeping the Alexis adaptations. Then update
the base version and commit in `CLAUDE.md`, this page and `CHANGELOG.md`. `error-handling` is no
longer a copy of upstream, so port changes to it by meaning.

## Fixed here

- `js-data-structures` of v1.0.6 has fragments of the `data-structures` classes (LinkedList, Queue,
  the unrolled node, CircularBuffer, BST) spliced into its Array, Map, Set, WeakMap and typed array
  examples. They are removed, and its iteration hints follow `js-conventions`.

## Course-based skills

27 skills were adapted from a local snapshot of 31 course-based skills, taken on 2026-11-20. It has
no git history, so this SHA-256 over its sorted file hashes identifies it:

```text
d2e933cbcef5463ec6ca75e8176d02ded854592022ef0a038f6fe22c15496122
```

- **Merged:** `node-error-handling` into `error-handling`, and `js-v8-optimization` into
  `js-conventions/performance.md`.
- **Rewritten:** `metarhia-libraries` as `alexis-libraries`.
- **Left out:** `metarhia-impress-app`, since Alexis does not run Impress, and
  `node-native-addons-wasm`, since Alexis has no native code.

## auth8 skills

auth8 kept its own copies in `.claude/skills/`: eight `nodejs-enterprise*` skills, older copies of
four upstream skills, and its own `auth8-architecture` and `testing`. They are replaced by this
package, and auth8 keeps only `auth8-architecture` as a project skill.

- **New skills:** `node-config` (from `nodejs-enterprise-config`), `node-deploy` (from
  `nodejs-enterprise-cloud`) and `node-observability` (from `nodejs-enterprise-scalability`).
- **Merged into existing skills:** the circuit breaker (`error-handling`), Playwright and load
  profiles (`node-tooling-testing`), fastify-cli settings (`node-http-server`), the strangler
  (`node-architecture-styles`), serving the last good result under pressure
  (`node-scaling-highload`), Piscina (`node-multithreading`), capacity arithmetic
  (`node-event-loop`), the workspace boundary test (`node-layered-architecture`) and the
  Vitest rules for names, fakes, coverage and benchmarks (`node-tooling-testing`).
- **Left out:** `nodejs-enterprise-ssr` and Platformatic, since auth8 has a Vue SPA on Vercel;
  serverless; Node.js 22, `node:test` for apps, npm commands and `NODE_ENV` in images; loopbench and
  clinic; SQL examples; Testcontainers; use cases as a layer.
