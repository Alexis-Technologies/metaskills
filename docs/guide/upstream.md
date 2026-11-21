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
the base version and commit in `CLAUDE.md`, this page and `CHANGELOG.md`.
