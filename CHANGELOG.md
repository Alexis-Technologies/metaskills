# Changelog

All notable changes to **alexiskills** (`@alexify/metaskills` on npm) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.1] - 2026-11-25

A patch release: the App profile runs its sources in development again, as auth8's ADR-016
describes, and CI may start below an `engines` floor that the package manager cannot run on.

### Fixed

- **Relative imports in TypeScript apps end in `.ts` again.** 1.1.0 asked for `.js`, which Node.js
  does not map to a `.ts` file, so an app could no longer run its sources in development. An app
  runs `src/` through Node's type stripping in development and the `tsc` build in `dist/` in
  production. `tsconfig.json` allows `.ts` specifiers, and `tsconfig.build.json` rewrites them
  with `rewriteRelativeImportExtensions`.
- **Import aliases and workspace packages resolve to the sources under a `source` condition** and
  to `dist/` by default. Aliases have no extension (`#shared/app/access`), development runs
  `node --conditions=source`, and a workspace package exports `source`, `types` and `default`.
  Production never loads a `.ts` file, which Node.js refuses under `node_modules`, where
  `pnpm deploy` copies a workspace package.
- **CI below an unreachable floor.** When the package manager cannot run on the floor of
  `engines` (pnpm 10 needs Node.js 18.12), the matrix starts at the lowest version it runs on,
  `engines` stays, and the project's CLAUDE.md records the gap.
- **Paths that only worked from the build.** A Piscina worker takes the extension of the file
  that starts it, and the migronaut config of `node-data-access` is `migronaut.config.ts`.
- **The image install of `dependencies.md`** is `pnpm deploy --prod`, as in `node-deploy`, not
  `pnpm install --prod`.

### Upgrading from 1.1.0

In an app that moved its relative imports to `.js` for 1.1.0:

1. Rename the relative specifiers back to `.ts`, set `allowImportingTsExtensions` in
   `tsconfig.json` and `rewriteRelativeImportExtensions` in `tsconfig.build.json`.
2. Write the aliases without an extension, with `source` and `default` targets, and run
   development with `node --conditions=source`.
3. Give each workspace package `source`, `types` and `default` exports and `"files": ["dist"]`.

## [1.1.0] - 2026-11-25

The skills agree with themselves and with the Alexis libraries. A review of the ten sibling
repositories found 23 places where the skills contradicted each other or their own lint, and
rules the libraries had proven that the skills lacked. The maintainer settled each one.

### Changed (breaking)

- **Strict comparisons, `null` included.** The lint drops `null: ignore` from `eqeqeq`, as the
  text of `js-conventions` always said. "null or undefined" is `x === undefined || x === null`.
- **`return void fn()` is the call-then-return, and `no-void` is off.** The skill asked for it
  while the lint refused it.
- **`describe` and `it` only, and every `it` title starts with `should`.** Libraries assert with
  `node:assert/strict`.
- **Error codes start with `ALX_ERR_`**, as Fastify's start with `FST_ERR_`: `ALX_ERR_VALIDATION`,
  `ALX_ERR_DAL_CONFLICT`. Codes of Node and of other libraries stay as they are, and so does the
  numeric `error.code` of a wrpc hook, which is wrpc's wire status. Every code a library throws is
  a union in its `.d.ts` and a table in its docs.
- **One `DomainError`.** `new DomainError(code, { message, cause, details })`, always thrown. Three
  skills used three signatures, and one returned it.
- **Invalid arguments and config of a library** throw the library's own class with a code, not a
  bare `TypeError`.

### Changed

- **Named exceptions instead of absolute bans.** `String()` for a value that may be a symbol,
  `delete` on dictionaries and on data whose missing key means something, `Object.entries` outside
  hot paths and library `src/`, `Object.create(null)` for dictionaries and peer-keyed tables.
- **Array destructuring** is banned in library `src/` only; apps and tests may use it.
- **Line breaks of a `require` belong to oxfmt**: one module per statement.
- **Comments say why.** The documentation of a public API is JSDoc in the handwritten `.d.ts`.
- **`toSorted`, `toReversed` and `with` by the engines floor.** On Node 18 a fresh copy is sorted in
  a statement of its own.
- **Relative imports in TypeScript apps end in `.js`.**
- **A library may print important messages to `console` when no logger is passed**, and then has
  `logger: false` to silence them.
- **CHANGELOG headings.** Keep a Changelog, plus `Changed (breaking)`, `Documentation`,
  `Upgrading from X.Y` and `Tooling`. The release commit is `chore(release): X.Y.Z`, and the
  package goes out with `pnpm publish` only.
- **`node-data-access` follows auth8's ADR-017**: `v` and `rev` as it defines them, `rev` not on
  every write, six actor types, and shape migrations as a BullMQ job beside migronaut.
- **`alexis-libraries` describes the unreleased mailer 2.0** next to 1.x, and lists messenger as
  not published.
- **`src/` of a library** is laid out by subpath or feature, with kebab-case file names, instead
  of "flat".

### Added

- **Rules the libraries proved.**
  - Never spread a data array into arguments, and a peer-grown queue is never an `Array` with
    `shift()`.
  - Barrels by name, an export-parity test and a tarball smoke test.
  - A runtime tier by package name, and CI on the exact engines floor.
  - Observers never fail the operation they watch.
- **The tests of an app under `src/`** may use array iteration methods: the lint exempts them.

### Fixed

- **Contradictions between skills.** Membership lists are a `Set`, fixed tables are literals, Map
  iteration has one rule, `node-tooling-testing` no longer says that oxlint has no stylistic rules,
  and the `examples.md` of `js-conventions` follows its own iteration rules.
- **The mailer 1.x reference.** Its queue example called `createQueue`, which 1.2.1 exports as
  `createMailQueue`, and it listed `/webhooks/<provider>` entries that first appear in 2.0.
- **The stale ADR-017 line.** `document-conventions` said auth8 used double-underscore system
  fields; ADR-017 names them `v` and `rev`.

### Tooling

- **The lint of this repository** turns off `no-void`, compares `null` strictly, and lets the tests
  of an app under `src/` use array iteration methods.
- **Its own tests** are `describe` and `it('should …')` with `node:assert/strict`.

### Upgrading from 1.0

In a library or app that copied the lint of alexiskills:

1. Remove `no-void` and the `null` option of `eqeqeq`, then rewrite `fn(); return;` as
   `return void fn()` and `== null` as strict comparisons.
2. Rewrite flat `test()` calls as `describe` and `it('should …')`.
3. Rename error codes to `ALX_ERR_*` in the next major, since consumers match on them.
4. Throw the library's own error classes for invalid arguments.
5. Give a library that prints to `console` without a logger the `logger: false` option.

## [1.0.1] - 2026-11-24

A patch release: `node-config` follows `@alexify/metaschema` 3.4.1, and the guide says when
`prepare` relinks the skills.

### Changed

- **`node-config` on metaschema 3.4.1.** An environment schema is a plain definition again, and
  `Config` is `InferOutput` of it: 3.4.1 reads upper-case keys as fields, so the `schema` wrapper
  and the generated `config.types.ts` are gone. `alexis-libraries` lists 3.4.1.
- **When `prepare` runs.** The packs guide says that pnpm skips it when an install changes nothing,
  so a change of packs needs `pnpm run prepare`.

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

[unreleased]: https://github.com/Alexis-Technologies/metaskills/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/Alexis-Technologies/metaskills/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Alexis-Technologies/metaskills/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Alexis-Technologies/metaskills/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Alexis-Technologies/metaskills/releases/tag/v1.0.0
[upstream-1.0.6]: https://github.com/metarhia/metaskills/compare/v1.0.5...v1.0.6
[upstream-1.0.5]: https://github.com/metarhia/metaskills/compare/v1.0.4...v1.0.5
[upstream-1.0.4]: https://github.com/metarhia/metaskills/compare/v1.0.3...v1.0.4
[upstream-1.0.3]: https://github.com/metarhia/metaskills/compare/v1.0.2...v1.0.3
[upstream-1.0.2]: https://github.com/metarhia/metaskills/compare/v1.0.1...v1.0.2
[upstream-1.0.1]: https://github.com/metarhia/metaskills/compare/v1.0.0...v1.0.1
[upstream-1.0.0]: https://github.com/metarhia/metaskills/releases/tag/v1.0.0
