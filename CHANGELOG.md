# Changelog

All notable changes to **alexiskills** (`@alexify/metaskills` on npm) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-24

The first version of alexiskills, a mechanical fork of
[metarhia/metaskills](https://github.com/metarhia/metaskills) v1.0.6 (commit `ab13efe`): 37 skills
for the Alexis stack in seven packs, and a CLI that links them next to a project's own skills.

### Added

- **Seven base skills.** `js-conventions`, `js-data-structures`, `data-structures`,
  `metautil-data-structures`, `js-gof`, `error-handling` and `npm-publish`.
- **27 skills for the Alexis stack.** Runtime and async, architecture, data access, HTTP, security,
  realtime, tooling, and `alexis-libraries`, a guide to the `@alexify/*` packages. They are adapted
  from course-based skills to Fastify, a DAL over the native MongoDB driver, `@alexify/metaschema`
  as the single source of schemas, oxlint and oxfmt. An app is laid out as modules by business
  context, each with `domain/`, `app/`, `infra/` and `presentation/` and its tests beside the code.
- **Skill packs.** `alexiskills claude --pack backend,security` links `core` and the chosen
  packs instead of all 37 skills, so their descriptions fit an agent's context.
- **Three skills from the auth8 material.** `node-config` (one validated environment schema,
  secrets, feature switches, no `NODE_ENV`), `node-deploy` (multi-stage images with pnpm, Fly.io and
  Vercel) and `node-observability` (OpenTelemetry traces and metrics, Pino with trace ids, alerts).
  The rest of auth8's skills went into existing ones: a circuit breaker, Playwright and load
  profiles, fastify-cli settings, the strangler, stale reads under pressure, Piscina and capacity
  arithmetic.
- **Project skills next to the links.** A directory of the project's own skills in
  `.claude/skills` stays, and the package skills are linked next to it, with or without `--pack`.
  A project skill wins over a package skill of the same name. The links go into a managed block of
  `.gitignore` and `.npmignore`, so the project skills stay tracked.
- **Repository gates.** oxlint, oxfmt, `node:test` with c8, context budgets for skills, a tarball
  check, a generated skill catalog and CI on Node.js 18 to 26.
- **Documentation site.** A VitePress guide and a catalog generated from the skills, at
  <https://alexiskills.vercel.app> with a sitemap and canonical URLs.

### Changed

- **Alexis toolchain in the skills.** oxlint and oxfmt instead of ESLint and Prettier, pnpm instead
  of npm, 100 or 120 columns by project, CommonJS without `'use strict'`, and one-pass loops in
  `src/` of libraries and apps.
- **The command is `alexiskills`.** A scoped bin name would still install `metaskills` and
  clash with `metarhia/metaskills`. Its logic moved to `src/link.js` behind
  `bin/alexiskills.js`.
- **`error-handling` is rewritten.** A Fastify boundary, DAL errors, retry only for transient
  failures, and a process policy that ends in a graceful shutdown.
- **Short descriptions.** At most 200 characters each and 5100 in total, because all descriptions
  share about 1% of the context window.
- **`js-data-structures` without the upstream splice.** v1.0.6 has fragments of the
  `data-structures` classes inside its examples; they are removed.
- **One way to start a Fastify app.** `node-graceful-shutdown` covers `fastify start`, where
  fastify-cli owns the signals, and an entry of your own, and never both.

### Removed

- **Automatic install.** The CLI no longer runs `npm install metaskills`, which would install the
  upstream package. It prints the command to run instead.

### Fixed

- **Duplicate frontmatter key.** `js-data-structures` declared `description` twice.
- **IDE names from `Object.prototype`.** `alexiskills constructor` is now an unknown IDE.
- **Closed stdin in the menu.** The CLI reports an invalid choice instead of ending silently.
- **Unsafe examples in the adapted skills.** A weak scrypt policy, a ReDoS in an email regex, an SSRF
  filter that passed `::` and NAT64, an auditor role that could delete, a request that crashed the
  process during shutdown, and undeclared access that admitted any session.

## Upstream history (metarhia/metaskills)

The releases of the project this one was copied from, up to the commit of the fork.

### [metaskills 1.0.6][upstream-1.0.6] - 2026-10-31

- Added skill validation for frontmatter, context size, and relative links
- Added agent evaluation scripts for skill selection and generated code
- Symlinked each IDE target directory:
  `.cursor/skills`, `.claude/skills`, and the other rows to the package
  skills folder, so agents load `<target>/<skill-name>/SKILL.md`; migrated
  legacy links and preserved directories containing users' own skills
- Merged JavaScript style guidance into js-conventions and expanded examples and
  performance guidance
- Expanded js-gof with structural patterns and moved examples into JavaScript files
- Updated data-structure, error-handling, and npm-publish guidance
- Updated development dependencies
- Removed duplicate development dependency entries from package.json

### [metaskills 1.0.5][upstream-1.0.5] - 2026-08-06

- Added skills: data-structures, metautil-data-structures
- Updated js-data-structures skill
- Fixed scripts code style

### [metaskills 1.0.4][upstream-1.0.4] - 2026-03-19

- Added GoF creational patterns
- Fixed npm-publish skill

### [metaskills 1.0.3][upstream-1.0.3] - 2026-03-16

- Fixed skills path

### [metaskills 1.0.2][upstream-1.0.2] - 2026-03-16

- Added skills: error-handling, js-data-structures
- Renamed skill to js-conventions

### [metaskills 1.0.1][upstream-1.0.1] - 2026-03-14

- Auto-install as dev dependency when running via `npx`
- Add `*/skills/metaskills` to `.gitignore` and `.npmignore` automatically

### [metaskills 1.0.0][upstream-1.0.0] - 2026-03-13

- Support for Cursor, Claude, Windsurf, and VS Code
- npm package with `npx metaskills` CLI to link skills into IDEs
- Interactive menu when run without IDE argument
- 2 skills: javascript-code-style, npm-publish
- Tests for link-ide script
- Autodetect IDE dirs and link skills without a menu prompt
- Prune stale symlinks on re-run after package update

[unreleased]: https://github.com/Alexis-Technologies/metaskills/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Alexis-Technologies/metaskills/releases/tag/v1.0.0
[upstream-1.0.6]: https://github.com/metarhia/metaskills/compare/v1.0.5...v1.0.6
[upstream-1.0.5]: https://github.com/metarhia/metaskills/compare/v1.0.4...v1.0.5
[upstream-1.0.4]: https://github.com/metarhia/metaskills/compare/v1.0.3...v1.0.4
[upstream-1.0.3]: https://github.com/metarhia/metaskills/compare/v1.0.2...v1.0.3
[upstream-1.0.2]: https://github.com/metarhia/metaskills/compare/v1.0.1...v1.0.2
[upstream-1.0.1]: https://github.com/metarhia/metaskills/compare/v1.0.0...v1.0.1
[upstream-1.0.0]: https://github.com/metarhia/metaskills/releases/tag/v1.0.0
