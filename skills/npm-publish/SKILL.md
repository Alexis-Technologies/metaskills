---
name: npm-publish
description: Prepare an @alexify package release with pnpm, covering version bump, CHANGELOG, typings, gates, docs and pack check. Use when asked to prepare a release or publish
disable-model-invocation: true
---

<!-- Adapted from metaskills v1.0.6 (skills/npm-publish) for the Alexis toolchain and release
     process: pnpm instead of npm, the gates of prepublishOnly and CI, Keep a Changelog headings,
     and a manual publish after the merge and the tag. -->

# npm Publish Preparation

Systematic workflow for preparing an @alexify package for a new release. Every step must pass before proceeding to the next. The package manager is pnpm (pinned in `packageManager`); never use `npm` commands and never create `package-lock.json`.

## Step 0: Gather Release Intent

Ask the user (with the agent's question tool if it has one, otherwise in chat):

1. **Version bump type**: patch / minor / major / explicit version / prerelease tag
2. **Prerelease label** (if any): e.g. `alpha`, `beta`, `rc`, `prerelease`
3. **Confirm changelog entries**: ask if the `[Unreleased]` section in CHANGELOG is complete, or if the user wants to draft entries from recent commits

If the user already specified intent (e.g. "prepare 4.1.0 release"), skip the question and proceed.

## Step 1: Pre-flight Checks

The gates differ per package, so read them instead of assuming a list:

1. Run `pnpm install --frozen-lockfile`
2. Read `prepublishOnly` in `package.json` and run each of its commands
3. Read `.github/workflows/ci.yml` and run the gates `prepublishOnly` does not cover (for example the docs build). Say which ones need tools or services that are not available here, and rely on CI for those
4. Follow the release section of the project's `CLAUDE.md` when it has one; it wins over this skill

Then in parallel: `pnpm outdated` and `pnpm audit` (report to user).

If any gate fails, stop and fix issues before continuing.

## Step 2: Version Bump

### Read current version from `package.json`

Compute the new version based on user intent and semver rules:

- **patch**: `1.2.3` -> `1.2.4`
- **minor**: `1.2.3` -> `1.3.0`
- **major**: `1.2.3` -> `2.0.0`
- **prerelease**: `1.2.3` -> `1.2.4-<label>.0`, or `1.2.4-beta.0` -> `1.2.4-beta.1`
- **Removing prerelease tag**: `4.0.3-prerelease` -> `4.0.3` (just strip the suffix)

Update `"version"` in `package.json` by editing the file directly, not with `pnpm version`: the commit, tag and changelog are handled by hand in the steps below.

## Step 3: Update CHANGELOG.md

The changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):

- **Sections**: `## [Unreleased]` at top; `## [X.Y.Z] - YYYY-MM-DD` for releases (date in ISO 8601)
- **Order**: newest first; every version gets an entry
- **Release body**: a short prose paragraph saying what the release is about, then subsections
- **Types of changes**: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, plus `Tooling` and `Upgrading from X.Y` when they apply. Omit empty subsections
- **Entries**: bullets starting with a **bold lead-in**, then the explanation; human-readable and curated (no raw git diffs); call out breaking changes clearly
- **Links**: reference-style link block at the bottom: `[unreleased]: ...`, `[X.Y.Z]: ...`

### 3a: Detect changelog structure

Read the full `CHANGELOG.md`. Identify:

- The `[Unreleased]` section
- The previous release heading (to derive the comparison base)
- The links block at the bottom of the file
- The GitHub repo URL from `package.json` `repository`

Release tags are `vX.Y.Z`.

### 3b: Create the new version entry

**Always** draft entries from `git log` since the previous release tag:

```bash
git log $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD~20")..HEAD --oneline
```

For the first release of the package there is no tag yet: draft from the whole history (`git log --oneline`).

Commits follow Conventional Commits: map `feat` -> Added, `fix` -> Fixed, `refactor!`/`feat!`/`fix!` -> call out as breaking, `ci`/`chore` -> Tooling (only when user-visible). Merge with the existing `[Unreleased]` content.

Turn `[Unreleased]` into the release and leave an empty `[Unreleased]` above it:

```markdown
## [Unreleased]

## [NEW_VERSION] - YYYY-MM-DD

What the release is about, in one short paragraph.

### Added

- **Feature name.** What it does and why it matters.
```

### 3c: Update comparison links

At the bottom of `CHANGELOG.md`, update the `[unreleased]` link and add the new version link:

```markdown
[unreleased]: https://github.com/OWNER/REPO/compare/vNEW_VERSION...HEAD
[NEW_VERSION]: https://github.com/OWNER/REPO/compare/vPREVIOUS_VERSION...vNEW_VERSION
```

For the first release there is no previous version of this package: link it to `https://github.com/OWNER/REPO/releases/tag/vNEW_VERSION`.

Keep all existing links intact.

## Step 4: TypeScript Declarations

If `.d.ts` files exist:

1. Run the project's type gates (`check:dts`, `test:types`); they must pass with no errors
2. Verify the `.d.ts` public API surface matches the actual exports:
   - Read the main JS entry point's `module.exports`
   - Read the `.d.ts` file
   - Confirm every exported class, function, type, and method is declared
   - Confirm no private/internal fields leak into the declarations
3. If the release includes API changes, update the `.d.ts` and its type tests accordingly

## Step 5: README, Docs & License Review

**Update the year** of the `Alexis Technologies` copyright line in `LICENSE` (e.g. `2026` -> `2026-2027`).

Scan for staleness:

1. **README.md usage examples**: do they match the current API? Run them if in doubt
2. **Badges**: do the URLs point to `@alexify/<name>` and the `Alexis-Technologies` repository?
3. **docs/**: guide and API pages for anything the release changed. `pnpm run docs:build` must pass (dead links fail it)
4. **Generated docs**: rerun their generators instead of editing the output by hand
5. **SECURITY.md**: the supported-versions table on a major release

Only edit if something is factually wrong or outdated. Don't rewrite style or add unsolicited content.

## Step 6: Package Audit

### 6a: Verify `package.json` fields

Check these fields are correct:

- `"main"` / `"bin"` / `"exports"` — point to existing files; `exports` lists `types` first when it has them
- `"types"` — points to the `.d.ts` file when the package has one
- `"files"` — the explicit allowlist includes everything that ships and nothing else
- `"engines"` — matches the CI matrix (`.github/workflows/ci.yml`)
- `"dependencies"` — absent unless the project's `CLAUDE.md` allows them
- `"keywords"` — no typos, relevant terms
- `"license"`, `"repository"`, `"homepage"`, `"bugs"`, `"publishConfig"` (`access: public`) — valid

### 6b: Dry-run pack

```bash
pnpm pack --dry-run
```

Run `pnpm run check:pack` too when the project has it. Review the file list:

- Source files are included
- Type definitions are included
- Tests, docs, scripts, configs and CI files are excluded unless the package ships them on purpose
- No unexpected large files

Report the file count and the packed size to the user.

## Step 7: Final Verification

Run the gates of Step 1 one more time after all edits. They must exit 0. If one fails, fix and re-run.

## Step 8: Summary & Next Steps

Present a summary to the user:

```
Release preparation complete:
  Package:  <name>
  Version:  <old> -> <new>
  Tests:    ✓ passing
  Types:    ✓ valid
  Packed:   <N> files, <size>
```

Then list remaining manual steps:

1. `git add -A && git commit -m "chore(release): X.Y.Z"` on the release branch, then merge into `main` (or ask the user if they want you to commit)
2. `git tag vX.Y.Z` on the commit of `main`
3. `git push && git push --tags`
4. `pnpm publish` (or `pnpm publish --tag <label>` for prereleases), or `pnpm run release` when the project has it; `prepublishOnly` re-runs the gates

Do NOT run `pnpm publish`, `pnpm run release` or `git push` automatically — always let the user do it or explicitly confirm.

## Step 9: Lockfile

Run `pnpm install` only if dependencies changed during the release; commit the updated `pnpm-lock.yaml` with the release. Never generate or commit `package-lock.json`.
