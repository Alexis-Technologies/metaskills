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

| Skill                      | Covers                                                     |
| -------------------------- | ---------------------------------------------------------- |
| `js-conventions`           | Alexis JavaScript and TypeScript style, naming and modules |
| `js-data-structures`       | Choosing native JavaScript collections                     |
| `data-structures`          | Custom queues, lists, tries, heaps, graphs and CRDTs       |
| `metautil-data-structures` | The data structures of the `metautil` package              |
| `js-gof`                   | Creational and structural design patterns                  |
| `error-handling`           | Error handling and recovery in Node.js                     |
| `npm-publish`              | Preparing an `@alexify` package for release                |

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
