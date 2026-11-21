---
title: Upstream
description: How this repository relates to metarhia/metaskills and how changes are ported.
---

# Upstream

`@alexify/metaskills` is a mechanical fork of
[metarhia/metaskills](https://github.com/metarhia/metaskills) v1.0.6, commit `ab13efe`. The files
were copied into this repository. It is not a GitHub fork, it shares no git history with upstream,
and it has no `upstream` remote.

## What differs

- The skills use the Alexis toolchain: oxlint, oxfmt, pnpm, 100 columns, CommonJS without
  `'use strict'`, and one-pass loops in `src/`.
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
