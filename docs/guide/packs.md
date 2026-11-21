---
title: Packs
description: Link only the skills a project needs.
---

# Packs

An agent lists the description of every skill it can see, and Claude Code gives all of them about 1%
of the context window. Descriptions over that budget are dropped, starting with the least used
skills. A project that does not need all 34 skills links a part of them.

```bash
pnpm exec alexiskills claude --pack backend,security
```

`core` is always included. `--pack` takes a comma-separated list, can repeat, and also reads as
`--pack=backend`. It works with an IDE argument, with `LINK_IDE`, and with autodetect.

| Pack | Skills | For |
| --- | --- | --- |
| `core` | 8 | Every project: code style, errors, async, schemas, modules, tooling, `@alexify/*` |
| `design` | 5 | Patterns, SOLID and GRASP, paradigms, Onion + DDD, architecture styles |
| `library` | 4 | Data structures and preparing an `@alexify` package for release |
| `runtime` | 8 | Event loop, concurrency, events, streams, files, threads, async context, profiling |
| `backend` | 4 | Fastify and HTTP, the data access layer, shutdown, scaling |
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
| Holds your own skills | Skipped, exit 0 | Left alone, exit 1 |
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

## Keep the command in a script

A run without `--pack` turns a pack directory back into one symlink to all skills, and new skills of
a pack appear only after the next run. Keep the command in `package.json` so every run is the same:

```json
{
  "scripts": {
    "skills": "alexiskills claude --pack backend,security"
  }
}
```
