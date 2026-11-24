# Spec (technical task) template for coding agents

Write the spec as if for a capable junior developer who has the whole
internet but no context. Every line should be checkable.

```text
# <Feature name>

## Goal
One paragraph: what problem, who calls it, why now.

## Non-goals
What not to build (e.g. "no time-sortable ids", "no thread safety:
runs in one isolated thread", "no CLI").

## Contract
- Module path and exports: src/gsid.js -> { generateId, CHARS }
- Signature: generateId(length = 24): string
- Input validation and errors: RangeError for length outside 4..64
- Sync or async; reentrancy expectations; side effects (none / IO)
- Typings: update index.d.ts and its tsd test

## Constraints
- Node.js per engines, CommonJS, built-ins via node: prefix
- No runtime dependencies (in an app: an allowed list)
- Style: oxlint + oxfmt; no array iteration methods in src/; no comments
  restating code
- Architecture: lives in src/ (domain-free utility); no globals besides
  module-level constants; no changes outside src/gsid.js,
  tests/unit/gsid.test.js, index.d.ts
- Must not change: existing exports of other modules

## Design specification
Concrete decisions already made: format, alphabet, length, entropy,
data layout, algorithm outline. Link existing code to reuse:
- Reuse the approach of src/crypto.js randomPrefetcher (read it)

## Performance targets
- >= 1M ops/s on this machine, measured by the benchmark below
- Extra memory < 1 MB for 1M generated ids in the steady state
- No per-call allocations besides the returned string

## Optimization hints
- Prefetch randomness in a large buffer; refill with randomFillSync
- Avoid %, /, memory copies, nested loops, transcoding
  (hex <-> Buffer <-> string)
- Typed arrays and lookup tables; bit masks instead of modulo
- One allocation instead of two (subarray, DataView over the same buffer)

## Tests (library: node:test + node:assert/strict; app: Vitest with AAA)
- Generate one sample (e.g. 1M) in before(), then check:
  format/length, uniqueness, character distribution, option variants,
  error cases
- No network, no timers, deterministic where possible

## Benchmark (separate file, not in the module)
- Baselines: crypto.randomUUID(), previous implementation
- Warm-up, 5 rounds, report median and min, ops/s and memory
- Two scenarios: results discarded and results retained
- Same machine and Node.js version for all candidates

## Deliverables
- src/gsid.js, tests/unit/gsid.test.js, bench/gsid.js, typings update
- Short REPORT.md: numbers from the benchmark (copied, not estimated)

## Steps (stop and report after each)
1. Basic implementation meeting the contract
2. Unit tests passing (pnpm test)
3. Benchmark with baselines
4. Optimize against the benchmark; keep tests green
5. Options (configurable length)

## Verification before reporting done
- pnpm lint, pnpm format:check and pnpm test pass
- Benchmark run output pasted into REPORT.md
- List anything not verified
```

## Short task template (refactoring or small change)

```text
File: <path>. Scope: only <function/section>; do not touch other files.
Change: <one concrete instruction>.
Keep: <invariants: exports, signatures, behavior, output>.
Target shape: <example call or snippet>.
Do not: add comments, helpers, classes, dependencies; use mixins.
Then: run pnpm lint and pnpm test; show the diff only.
```

## Rules file template

Keep it under ~30 lines; agents read it every session, and long files
dilute the important lines.

```text
# AGENTS.md (or CLAUDE.md / .cursor/rules/project.mdc)

## Commands
- Install: pnpm install --frozen-lockfile
- Test: pnpm test
- Lint: pnpm lint   Format: pnpm format   Check: pnpm format:check

## Runtime and style
- Library: CommonJS, handwritten .d.ts. App: ESM + TypeScript (NodeNext)
- oxlint + oxfmt; printWidth from .oxfmtrc.json; single quotes
- No array iteration methods in src/
- No comments that restate code; JSDoc only when very short

## Architecture
- Library: flat src/, the driver is injected
- App: Onion + DDD; the domain has no transport, db drivers or globals
- Do not add dependencies without asking

## Workflow
- Inspect related code before editing; keep changes minimal
- After edits run lint and tests; report what was verified
- Never commit, push, rebase, or deploy
```
