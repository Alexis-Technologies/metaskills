---
title: Packs
description: Link only the skills a project needs.
---

# Packs

An agent lists the description of every skill it can see, and Claude Code gives all of them about 1%
of the context window. Descriptions over that budget are dropped, starting with the least used
skills. A project that does not need all 37 skills links a part of them.

```bash
pnpm exec alexiskills claude --pack backend,security
```

`core` is always included. `--pack` takes a comma-separated list, can repeat, and also reads as
`--pack=backend`. It works with an IDE argument, with `LINK_IDE`, and with autodetect.

| Pack | Skills | For |
| --- | --- | --- |
| `core` | 9 | Every project: code style, errors, async, schemas, config, modules, tooling, `@alexify/*` |
| `design` | 5 | Patterns, SOLID and GRASP, paradigms, Onion + DDD, architecture styles |
| `library` | 4 | Data structures and preparing an `@alexify` package for release |
| `runtime` | 8 | Event loop, concurrency, events, streams, files, threads, async context, profiling |
| `backend` | 6 | Fastify and HTTP, the data access layer, shutdown, scaling, deploy, observability |
| `security` | 3 | Application security, crypto and authentication, access control |
| `realtime` | 2 | WebSocket on wrpc, local-first sync |

The [skill catalog](/reference/skills) shows the pack of every skill.

## What the command does

With `--pack`, `<ide>/skills` is a directory with one symlink per skill.

| `<ide>/skills` before | Without `--pack` | With `--pack` |
| --- | --- | --- |
| Absent | One symlink to the package | A directory of links |
| Our symlink to the package | Already linked | Replaced by a directory of links |
| Our links only, broken ones too | Replaced by one symlink | Synced to the chosen packs |
| Another symlink | Skipped, exit 0 | Left alone, exit 1 |
| Holds your own skills | They stay, a link per skill next to them | They stay, the chosen packs next to them |
| A regular file | Fails, exit 1 | Fails, exit 1 |

`--pack all` is the same as running without the option.

## IDE support

A pack relies on the IDE following a symlink per skill. A run without `--pack` uses one directory
symlink instead. These notes come from vendor documentation and issue trackers, not from a test in
each IDE:

| IDE | Per-skill symlinks |
| --- | --- |
| Claude Code | Documented |
| Gemini CLI | Documented: `gemini skills link` creates them |
| Cursor | Fixed by the vendor after a discovery bug, with reports that links can still go missing |
| VS Code | Not documented |
| Windsurf | Not documented |
| Antigravity | Not documented, with user reports that symlinks are not discovered |

After linking a pack in anything but Claude Code or Gemini CLI, check that the skills are listed. If
they are not, run the command without `--pack`.

## Project skills

A directory inside `<ide>/skills` that is not one of our links is a project skill. The command never
changes or removes it, and links the package skills next to it, with or without `--pack`:

```text
.claude/skills/
  auth8-architecture/      a project skill, tracked in git
  error-handling -> ../../node_modules/@alexify/metaskills/skills/error-handling
  node-config -> ../../node_modules/@alexify/metaskills/skills/node-config
```

- A project skill with the name of a package skill wins: the command keeps it, links nothing under
  that name and says `kept project skill <name>`.
- Your own links into the package and other files stay too. Only our links, one per skill under its
  own name, are created and removed.
- In a directory of links, `.gitignore` and `.npmignore` get one line per link between
  `# alexiskills:begin .claude/skills` and `# alexiskills:end .claude/skills`. The block is
  rewritten on every run, so the links stay out of git and the project skills stay in.
- A line that ignores the whole directory (`.claude/skills`) would hide the project skills, and the
  command warns about it. Remove that line.

## Keep skills updated

Run the command on every install, from `prepare` in the project's `package.json`:

```json
{
  "scripts": {
    "prepare": "alexiskills claude --pack backend,security"
  }
}
```

- The links point at `node_modules/@alexify/metaskills/skills`, a path that does not change between
  versions, so `pnpm update @alexify/metaskills` updates the content at once.
- New skills of the chosen packs are linked, and removed ones unlinked, by the install that
  `pnpm update @alexify/metaskills` runs. pnpm skips `prepare` when an install changes nothing, so
  after editing the packs run `pnpm run prepare`.
- `prepare` runs on every install that changes something, `pnpm install --prod` included. In a Docker image, install
  everything first and drop devDependencies with `pnpm deploy --prod` or `pnpm prune --prod`, as the
  `node-deploy` skill shows. A production-only install runs `prepare` without the command and fails.
- A run without `--pack` links all skills, so keep the same options everywhere the command runs.
