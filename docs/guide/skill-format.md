---
title: Skill format
description: The layout of a skill and the checks it has to pass.
---

# Skill format

A skill is a folder under `skills/` with a `SKILL.md` and, when it needs them, more files that the
agent reads on demand.

```text
skills/js-gof/
  SKILL.md
  patterns/adapter.md
  examples/adapter.js
```

`SKILL.md` starts with a frontmatter block:

```markdown
---
name: js-gof
description: What the skill does, and when an agent should use it.
---
```

## What is checked

| Check | Limit | Where |
| --- | --- | --- |
| `name` matches the folder | `[a-z0-9-]`, up to 64 characters | `pnpm test` |
| Frontmatter keys | No key repeated | `pnpm test` |
| Relative links | Every target exists | `pnpm test` |
| `description` | Up to 1024 characters | `pnpm size --check` |
| `SKILL.md` | Up to 500 lines and 17500 characters | `pnpm size --check` |

The size budget comes from how agents load a skill. A description is always listed, and Claude Code
re-attaches only the first 5000 tokens of a skill after compaction. Move detail that is not needed
every time into a separate file and link it from `SKILL.md`.

## After changing a skill

```bash
pnpm catalog
pnpm test
pnpm run size --check
```

`pnpm catalog` regenerates the [skill catalog](/reference/skills) and `llms.txt` from the
frontmatter. Never edit those two files by hand.
