# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

alexiskills is a package of agent skills for the Alexis JavaScript stack, with a small CLI that
links them into a project's IDE directory. Its npm name is `@alexify/metaskills` and its repository
is `Alexis-Technologies/metaskills`. It is a mechanical fork of
[metarhia/metaskills](https://github.com/metarhia/metaskills) v1.0.6, commit `ab13efe`: the files
were copied, there is no GitHub fork, no shared git history and no `upstream` remote.

**alexiskills is on npm.** Releases stay manual: do not run `pnpm publish`, push a tag, deploy the docs
or create a release unless the maintainer asks for that step. `package.json` has `private: false`,
so nothing else stops a publish.

**The course-based skills are imported and adapted.** This repository is public, so a push publishes
them: push only when the maintainer asks.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm lint                  # oxlint over bin, src, tests, scripts, evals and the skill examples
pnpm format                # oxfmt over the same paths; never over skills/**/*.md
pnpm format:check
pnpm test                  # node:test, tests/unit/*.test.js
pnpm run test:coverage     # c8 over src/: 98% lines and statements, 90% branches, 100% functions
pnpm run size --check      # the context budgets of scripts/size-budgets.json
pnpm run check:pack        # the tarball: the CLI, the documents, every skill, nothing else
pnpm catalog               # regenerate docs/reference/skills.md and docs/public/llms.txt
pnpm run catalog --check   # fails when those two files are stale
pnpm docs:dev
pnpm run docs:build        # a dead link fails it
pnpm evals                 # runs the `claude` CLI, billed to your account; not in CI
```

There is no build step. What is in `skills/`, `src/` and `bin/` is what ships.

## Repository layout

```text
bin/alexiskills.js         the thin CLI entry
src/link.js                linking, packs, IDE detection, the menu and run()
src/packs.json             which pack each skill belongs to
skills/                    the source of truth for every skill
tests/unit/                link, cli, skills, size and pack tests
evals/                     agent evals, outside CI
scripts/                   frontmatter, size, check-pack and catalog
docs/                      the VitePress site
```

## Skills

`skills/` holds 37 skills in seven packs, listed in `src/packs.json`. Every skill is in exactly one
pack, and `core` is always linked.

- **From upstream v1.0.6, adapted to the Alexis toolchain:** `js-conventions`, `npm-publish`,
  `js-gof`, `js-data-structures` and `data-structures`. Each says so in a comment under its
  frontmatter. `metautil-data-structures` differs from upstream only in its description.
- **Rewritten:** `error-handling`, from upstream and the deeper course material.
  `js-conventions/performance.md` also took the V8 material.
- **Adapted from the course-based skills:** 27 more. `docs/guide/upstream.md` records the
  snapshot and what was left out.
- **Written from the auth8 skills:** `node-config`, `node-deploy` and `node-observability`, brought
  up to the current stack. The rest of auth8's material went into the existing skills, and the
  page records what was dropped.

Skills follow two profiles, and the project's own configuration wins over both:

- **Library** (`@alexify/*`): CommonJS, handwritten `.d.ts`, `node:test` with c8, no runtime
  dependencies.
- **App** (`auth8` is the reference): ESM, TypeScript, Vitest, Onion + DDD, a DAL over the native
  MongoDB driver, Fastify.

Both use oxlint and oxfmt, and neither uses array iteration methods in `src/`.
`@alexify/metaschema` is the single source of truth for schemas. Documents carry the system fields
`v` and `rev`.

This repository has **no tracked `.claude/` directory** and no symlinks to its own skills, so an
agent does not load a draft as instructions while editing it. Read them directly instead:

- Before changing JavaScript, read `skills/js-conventions/SKILL.md`.
- Before preparing a release, read `skills/npm-publish/SKILL.md`.

A local `.claude/launch.json` for the docs preview is git-ignored.

After changing a skill, run `pnpm catalog`, `pnpm test` and `pnpm run size --check`. A new skill also
needs a place in `src/packs.json`. Skills refer to each other by name, never by a relative link,
because a pack may leave the other skill out.

## Conventions

- No runtime dependencies.
- CommonJS, no `'use strict'`, the `node:` prefix, `.js` in relative requires.
- `src/` uses no array iteration methods; oxlint enforces it. `src/` does not use `console` either:
  `run()` takes its streams.
- Node.js 18 is the engines floor, so `src/` and `bin/` avoid newer APIs such as `toSorted`.
- The project is called alexiskills in prose, titles and CLI messages. Identifiers keep
  `metaskills`: the npm name, the repository URL, the `node_modules` path, the tarball name and
  `LEGACY_LINK`, the on-disk name of the old grouped link. Upstream stays `metarhia/metaskills`.
- The command is `alexiskills`. pnpm and npm drop the scope of a bin name, so a bin called
  `@alexify/metaskills` would install a `metaskills` command and clash with the upstream package.
- The CLI never installs a package. The upstream one ran `npm install metaskills`, which would
  install the upstream package here.
- The skills path stays `node_modules/@alexify/metaskills/skills`. Do not derive it from
  `__dirname`: under pnpm that resolves into a versioned `.pnpm/` directory.

## Testing notes

`tests/unit/cli.test.js` runs the real CLI in temporary projects through `spawnSync`, so c8 covers
`src/link.js` through child processes. It creates directory symlinks, which on Windows need the
privileges GitHub's runners have.

## Documentation site

VitePress in `docs/`, with the Alexis violet theme. `docs/reference/skills.md` and
`docs/public/llms.txt` are generated by `scripts/catalog.js`; never edit them by hand. The site is
<https://alexiskills.vercel.app>, deployed by the Vercel project `metaskills`. `config.mts` builds
the sitemap and gives every page a canonical URL and `og:url` on that domain.

## Release process

Manual, as in the sibling repositories, and only when the maintainer asks. Follow
`skills/npm-publish/SKILL.md`: bump the version, turn `[Unreleased]` into the release, merge into
`main` (squashed), tag `vX.Y.Z` on that commit, push, then `pnpm publish`, gated by
`prepublishOnly`. The upstream history stays under its own heading at the bottom of the CHANGELOG
with `upstream-*` link references.

## Upstream sync

Compare a separate clone of upstream with the base commit, and port what is worth taking by hand
in its own commit, keeping the Alexis adaptations:

```bash
git -C /path/to/metarhia/metaskills fetch origin
git -C /path/to/metarhia/metaskills diff ab13efe origin/main -- skills scripts evals
```

Then update the base version and commit here, in `docs/guide/upstream.md` and in `CHANGELOG.md`.
`error-handling` is no longer a copy of upstream, so port changes to it by meaning.
