---
title: Getting Started
description: Install @alexify/metaskills and link its skills into your IDE.
---

# Getting Started

::: warning Not on npm yet
`@alexify/metaskills` is not published. Until it is, install it from a tarball built from a clone.
:::

## Install from a clone

```bash
git clone https://github.com/Alexis-Technologies/metaskills.git
cd metaskills
pnpm install
pnpm pack
```

Then, in your project:

```bash
pnpm add -D /path/to/metaskills/alexify-metaskills-1.0.0.tgz
pnpm exec alexify-metaskills claude
```

## Link your IDE

`alexify-metaskills` symlinks the skills directory of an IDE to
`node_modules/@alexify/metaskills/skills`. Skills are not copied, and each link is added to
`.gitignore` and `.npmignore` when those files exist. The command has its own name because pnpm and
npm drop the scope of a bin name, and a plain `metaskills` would clash with `metarhia/metaskills`.

| IDE         | Command                          | Target directory    |
| ----------- | -------------------------------- | ------------------- |
| Autodetect  | `alexify-metaskills`             | Detected, or a menu |
| Cursor      | `alexify-metaskills cursor`      | `.cursor/skills`    |
| Claude Code | `alexify-metaskills claude`      | `.claude/skills`    |
| Windsurf    | `alexify-metaskills windsurf`    | `.windsurf/skills`  |
| VS Code     | `alexify-metaskills vscode`      | `.github/skills`    |
| Gemini      | `alexify-metaskills gemini`      | `.gemini/skills`    |
| Antigravity | `alexify-metaskills antigravity` | `.agents/skills`    |
| All         | `alexify-metaskills all`         | All of the above    |

A target that already holds your own skills is left unchanged and reported as skipped.

To link only part of the skills, see [Packs](/guide/packs).

If the package is missing, the command prints how to install it and exits with code 1. It never
installs anything by itself.
