# alexiskills

[![CI](https://github.com/Alexis-Technologies/metaskills/actions/workflows/ci.yml/badge.svg)](https://github.com/Alexis-Technologies/metaskills/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/Alexis-Technologies/metaskills)](./LICENSE)

🪄 **Agent skills for the Alexis JavaScript stack.** Reusable instructions for Claude Code, Cursor,
Windsurf, VS Code and Gemini: code style, data structures, design patterns, error handling and
release preparation, linked into a project by one command.

📖 Documentation: [alexiskills.vercel.app](https://alexiskills.vercel.app)

alexiskills (`@alexify/metaskills` on npm) is a mechanical fork of
[metarhia/metaskills](https://github.com/metarhia/metaskills) v1.0.6, adapted to the Alexis
toolchain.

## Installation

```bash
pnpm add -D @alexify/metaskills
pnpm exec alexiskills claude
```

To relink on every install, so new skills of your packs appear after `pnpm update`, put the command
in `prepare`: `"prepare": "alexiskills claude --pack backend,security"`.

The command is `alexiskills`, so it cannot clash with the `metaskills` command of
`metarhia/metaskills`. It symlinks the skills directory of the IDE to the installed package and adds
the link to `.gitignore` and `.npmignore`. Your own skills in that directory stay, and each package
skill is linked next to them.

| IDE         | Command                   | Target directory    |
| ----------- | ------------------------- | ------------------- |
| Autodetect  | `alexiskills`             | Detected, or a menu |
| Cursor      | `alexiskills cursor`      | `.cursor/skills`    |
| Claude Code | `alexiskills claude`      | `.claude/skills`    |
| Windsurf    | `alexiskills windsurf`    | `.windsurf/skills`  |
| VS Code     | `alexiskills vscode`      | `.github/skills`    |
| Gemini      | `alexiskills gemini`      | `.gemini/skills`    |
| Antigravity | `alexiskills antigravity` | `.agents/skills`    |
| All         | `alexiskills all`         | All of the above    |

## Skills

37 skills in seven packs. Without an option the command links all of them. A project that needs less
links `core` and the packs it names, which keeps the skill descriptions within an agent's context:

```bash
pnpm exec alexiskills claude --pack backend,security
```

| Pack       | Skills | Covers                                                                |
| ---------- | ------ | --------------------------------------------------------------------- |
| `core`     | 9      | Code style, errors, async, schemas, config, modules, tooling, `@alexify/*` |
| `design`   | 5      | Patterns, SOLID and GRASP, paradigms, Onion + DDD, architecture styles |
| `library`  | 4      | Data structures and preparing an `@alexify` package for release       |
| `runtime`  | 8      | Event loop, concurrency, events, streams, files, threads, profiling   |
| `backend`  | 6      | Fastify and HTTP, data access, shutdown, scaling, deploy, observability |
| `security` | 3      | Application security, crypto and authentication, access control       |
| `realtime` | 2      | WebSocket on wrpc, local-first sync                                   |

The [catalog](https://alexiskills.vercel.app/reference/skills) lists every skill.

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
