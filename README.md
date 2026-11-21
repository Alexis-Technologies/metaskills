# metaskills

[![CI](https://github.com/Alexis-Technologies/metaskills/actions/workflows/ci.yml/badge.svg)](https://github.com/Alexis-Technologies/metaskills/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/Alexis-Technologies/metaskills)](./LICENSE)

🪄 **Agent skills for the Alexis JavaScript stack.** Reusable instructions for Claude Code, Cursor,
Windsurf, VS Code and Gemini: code style, data structures, design patterns, error handling and
release preparation, linked into a project by one command.

> **Status: not published yet.** `@alexify/metaskills` is a mechanical fork of
> [metarhia/metaskills](https://github.com/metarhia/metaskills) v1.0.6, adapted to the Alexis
> toolchain. Until it is on npm, install it from a tarball.

## Installation

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

The command is `alexify-metaskills`, so it cannot clash with the `metaskills` command of
`metarhia/metaskills`. It symlinks the skills directory of the IDE to the installed package and adds
the link to `.gitignore` and `.npmignore`. A directory that already holds your own skills is left
unchanged.

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

## Skills

34 skills in seven packs. Without an option the command links all of them. A project that needs less
links `core` and the packs it names, which keeps the skill descriptions within an agent's context:

```bash
pnpm exec alexify-metaskills claude --pack backend,security
```

| Pack       | Skills | Covers                                                                |
| ---------- | ------ | --------------------------------------------------------------------- |
| `core`     | 8      | Code style, errors, async, schemas, modules, tooling, `@alexify/*`    |
| `design`   | 5      | Patterns, SOLID and GRASP, paradigms, Onion + DDD, architecture styles |
| `library`  | 4      | Data structures and preparing an `@alexify` package for release       |
| `runtime`  | 8      | Event loop, concurrency, events, streams, files, threads, profiling   |
| `backend`  | 4      | Fastify and HTTP, the data access layer, shutdown, scaling            |
| `security` | 3      | Application security, crypto and authentication, access control       |
| `realtime` | 2      | WebSocket on wrpc, local-first sync                                   |

The [catalog](docs/reference/skills.md) lists every skill.

## Development

```bash
pnpm install
pnpm test
pnpm lint
pnpm run size --check
pnpm docs:dev
```

`pnpm evals` runs the agent evals with the `claude` CLI and is billed to your account, so CI does
not run it. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full list of gates.

## License

[MIT](./LICENSE). Copyright (c) 2026 Metarhia contributors, (c) 2026 Alexis Technologies.
