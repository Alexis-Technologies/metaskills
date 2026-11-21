# Contributing

Thanks for helping improve metaskills. This page covers the rules that are easy to break by
accident; [CLAUDE.md](CLAUDE.md) describes how the repository fits together.

## Getting set up

```bash
pnpm install
pnpm test
```

There is no build step. What you edit in `skills/`, `src/` and `bin/` is what ships.

## The rules that are not negotiable

**1. No runtime dependencies.** `package.json` has no `dependencies` key. devDependencies are fine.

**2. Plain CommonJS.** `require`/`module.exports`, no `import`/`export`, no TypeScript syntax, no
`'use strict'`. Built-in modules use the `node:` prefix, and relative requires include `.js`.

**3. `skills/` is the source of truth.** The repository has no tracked `.claude/` directory and no
symlinks to its own skills.

**4. A skill fits its budgets.** Up to 500 lines and 17500 characters for `SKILL.md`, up to 1024
for the description. Move detail into a file the skill links to.

**5. Generated files are not edited by hand.** `docs/reference/skills.md` and
`docs/public/llms.txt` come from `pnpm catalog`.

**6. The CLI installs nothing.** It links an installed package and edits only the ignore files.

## Tests

Node's built-in `node:test`, no external framework. Run one file with
`node --test tests/unit/cli.test.js`.

`pnpm run test:coverage` enforces 98% lines and statements, 90% branches and 100% functions for
`src/`. New behavior needs a test that fails without the change.

## Before opening a PR

```bash
pnpm lint
pnpm format
pnpm test
pnpm run test:coverage
pnpm run size --check
pnpm run check:pack
pnpm run catalog --check
pnpm run docs:build
```

That list is what CI runs, and the merge gate.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat(scope):`, `fix(scope):`, `test:`, `docs:`).
