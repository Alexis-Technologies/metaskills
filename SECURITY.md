# Security Policy

## Supported versions

Only the latest version receives fixes.

| Version | Supported |
| --- | --- |
| 1.x | ✅ |
| `metaskills` (metarhia) | ❌ (report upstream) |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/Alexis-Technologies/metaskills/security/advisories/new).

Include, as far as you can:

- what an attacker can do, and what they need in order to do it;
- the affected version, Node.js version and IDE or agent;
- a minimal reproduction.

You can expect an acknowledgement within a few days, and an assessment of severity and a fix
timeline once the report is confirmed.

## Threat model

- **A skill is an instruction to an agent.** An agent acts on it with the permissions it has in
  your project, so a change to a skill deserves the same review as a change to code. A skill that
  tells an agent to leak data, run an unrelated command or weaken a check is a vulnerability.
- **The CLI runs only when you call it.** The package has no install scripts and no runtime
  dependencies, and the CLI makes no network requests and installs nothing.
- **The CLI writes only inside the current project.** It creates a symlink for the IDE you choose
  and appends that path to `.gitignore` and `.npmignore` when they exist. A directory that holds
  your own files, or a symlink to somewhere else, is left unchanged.
