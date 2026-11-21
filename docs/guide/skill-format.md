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
| Relative links | Every target exists and stays inside the skill | `pnpm test` |
| Pack | The skill is in exactly one pack of `src/packs.json` | `pnpm test` |
| `description` | One plain line, no `: ` or ` #`, up to 200 characters | `pnpm test`, `pnpm size --check` |
| All descriptions | Up to 5100 characters in total | `pnpm size --check` |
| `SKILL.md` | Up to 500 lines and 17500 characters | `pnpm size --check` |

The size budget comes from how agents load a skill. A description is always listed, all of them
share about 1% of the context window, and Claude Code re-attaches only the first 5000 tokens of a
skill after compaction. Move detail that is not needed every time into a separate file and link it
from `SKILL.md`.

Refer to another skill by its name in backticks, never by a relative link: a [pack](/guide/packs) may
leave that skill out.

## After changing a skill

```bash
pnpm catalog
pnpm test
pnpm run size --check
```

`pnpm catalog` regenerates the [skill catalog](/reference/skills) and `llms.txt` from the
frontmatter. Never edit those two files by hand.
