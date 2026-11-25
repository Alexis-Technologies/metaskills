---
name: js-ai-assisted-development
description: Drive LLM coding agents on JS and Node code. Use when writing prompts, specs or rules files, delegating work or reviewing AI-generated diffs
---

# AI-assisted JavaScript and Node.js development

Treat a coding model as a fast, well-read junior developer: it needs a
precise task, explicit constraints, a safe workspace, and a reviewer. On one
measured task (a UUIDv4 alternative), a one-line prompt and a step-by-step
chat gave the same weak algorithm, a written spec gave a fast one at high
cost, and an expert writing the core and delegating the routine was
cheapest. Apply these rules when you are the agent, when you
prepare tasks for other agents, and when you review their output.

## Decision guide

| Task | How to drive the model | Why |
| --- | --- | --- |
| New performance-critical or system algorithm | Human (or you, carefully) writes the core; delegate tests, typings, benchmarks, docs | Models do not invent the key optimizations; 18 min of expert work beat a 2 h spec session |
| Same, but it must be delegated | Written spec: contract, targets with numbers, constraints, optimization hints, reference code, test and benchmark plan | Spec run: 6M ids/s vs 1.25M for prompt and chat |
| Refactoring a big file, modernizing APIs | Narrow, located instructions, one change at a time, scope limited, diff reviewed per change | Precise instructions gave near bug-free results; "improve this" produced broken edits in other modules |
| Porting to a new style or platform | One example of the target style plus the source | Models learn a style from a single example |
| Routine: tests, `.d.ts`, docs, comparison tables, rename/replace across files, API lookup | Delegate, naming the tools (`node:test` in a library, Vitest in an app) | Strong area; still review |
| Architecture, class design, module boundaries, coupling | Human decides; agent may propose options | Weak area: god classes, wrong ownership, layer leaks |
| FP-style refactoring in JS (closures, IO, monads) | Give the exact target shape and what must not change; forbid mixins | Little training data; models write "OOP in function syntax" |

Numbers from that task (same machine, one harness):

| Approach | Human time | Result |
| --- | --- | --- |
| One-line prompt ("vibe coding") | ~5 min | 1.25M ids/s, god class, fake entropy sources |
| Step-by-step chat with review comments | ~20 min | 1.27M ids/s, same algorithm split into classes |
| Written technical spec | ~2 h | 6.04M ids/s, 24 chars, 144 bits |
| Expert manual implementation | ~18-30 min | 10.6M ids/s; AI wrote tests, typings, report |

## Rules

Prepare the workspace:

- Start from a clean checkpoint: commit, then run `pnpm test` and
  `pnpm lint`; repeat both after every agent change.
- Keep a short rules file (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`,
  `.github/copilot-instructions.md`): test, lint and format commands, code
  style (oxlint, oxfmt and the project's `printWidth`), Node.js version and
  module system, dependency policy, architecture constraints, and
  prohibitions (no obvious comments, no git commits or pushes, no deploys).
- Review generated rules files line by line: `/init`-style generators
  invent directory purposes and add irrelevant sections (deployment,
  commit/PR conventions). Re-check after the agent edits them.
- Keep version control with the human: the agent does not commit, push,
  rebase, or force-push unless explicitly asked; review via `git diff`.

Write the task:

- Put constraints first and make them checkable: function signatures,
  input and output types, sync vs async, error behavior, allowed
  dependencies (`node:` built-ins only), target Node.js version, numeric
  performance and memory targets, and what must not change.
- Link or paste reference code to reuse (an existing prefetcher, a sibling
  module) instead of describing it; agents read links and files.
- Show the target shape: an example call (`move(-5, 10)`), a signature, or
  one finished file in the target style.
- Name the technique when you know it: "use a promise chain", "two
  functions, no class", "Uint8Array lookup table with `& 0x3f`".
- Limit scope explicitly: "in this file only", "only `handleKey`", "and fix
  all similar cases in this file".
- Restate all accumulated constraints in every follow-up; models silently
  drop earlier constraints and regress.
- Split large work into ordered, verifiable steps (basic implementation,
  unit tests, performance tests, optimization, options).
- Ask for code only when you do not need explanations.

Supervise:

- Do not read code while the agent is still streaming edits; review the
  final diff.
- Accept or reject change by change; never accept a bulk "improvements"
  diff you have not read.
- Point to the exact place when something is wrong ("the `if` with
  `throw` in the constructor is dead: the condition is constant"); agents
  deny vague complaints.
- When the agent says a set of constraints is impossible, suggest the
  alternative approach (another syntax or paradigm) before relaxing them.
- Output is non-deterministic: regenerate or compare two runs for
  important code; do not treat one answer as authoritative.

Optimize with measurement:

- Measure a baseline first, including the native implementation
  (`crypto.randomUUID`, `Buffer`, built-in parsers), and keep it in every
  comparison; never benchmark against competitor code the model rewrote
  from memory.
- Benchmark the realistic scenario: retained vs discarded results, real
  input sizes, warm-up, several rounds, median, same machine and Node.js
  version, plus memory (`process.memoryUsage()`).
- Harness choice can flip rankings. On Node.js 24 we measured
  `crypto.randomUUID()` at ~30M/s in a discard loop but ~3-4M/s when 1M
  ids were kept in an array, while a buffer-based generator stayed at
  16-19M/s in both. Re-measure; do not copy numbers from articles or the
  model.
- Verify correctness before speed: format, uniqueness, and distribution
  tests on one generated sample, not a new sample per test.
- Keep benchmarks in separate files or tests, never inside the module.
- Review AI micro-optimizations for safety: a module-level scratch buffer
  is fine only for synchronous, single-thread code; it breaks with `await`,
  callbacks, or workers in between.

Self-discipline when you are the agent:

- Inspect the relevant code and project rules before editing; prefer the
  smallest change that satisfies the task.
- Do not widen scope: no unrelated refactors, renames, new files, new
  dependencies, or other modules.
- Do not add explanatory comments, helper layers, or classes the task did
  not need; delete obsolete code instead of moving it.
- Use current, verified APIs; when unsure, check the docs or run
  `node -e` instead of guessing.
- Run lint and tests (and the benchmark when performance was the goal);
  report exactly what was verified and what was not.

## Patterns

Directed refactoring instructions (one change per message, scoped):

```text
Rewrite the keyNames reverse lookup with a Map; keep the same keys.
Replace userAgent sniffing with a constant: isTouch = navigator.maxTouchPoints > 0.
Update all calls in THIS FILE only.
Use addEventListener instead of on* properties, here and in similar cases in this file.
Replace KeyboardEvent.keyCode with event.code everywhere in this file;
then delete the keyCode map (do not move it).
```

Rules file skeleton (keep it short; the agent reads it every session):

```text
# AGENTS.md
- Library: CommonJS, handwritten .d.ts, no runtime deps, Node.js per engines
- App: Node.js 24, ESM + TypeScript (NodeNext), Onion + DDD
- Built-ins via node: prefix; no array iteration methods in src/
- Test: pnpm test   Lint: pnpm lint   Format: pnpm format
- Style: oxlint + oxfmt; no comments restating code
- Layers: domain must not import transport or db drivers
- No new dependencies without asking; no git commit/push; no deploy
- After edits: run lint and tests, report results
```

Refactoring toward isolated IO, with the target shape stated:

```text
Refactor io.js: keep createIO and createMonad exactly as they are.
Do not use mixins or Object.assign on functions.
createPoint must return a closure (map) => map(x, y), no object literal.
move takes numbers: move(-5, 10), not a { x, y } delta.
Reading the point is an effect: wrap it in createIO.
Serialization is pure: do not wrap toString in IO.
Run the file; output must stay "(10, 20)" then "(5, 30)".
```

Spec skeleton (full template in
[references/spec-template.md](references/spec-template.md)):

```text
Goal / non-goals
Contract: signature, types, sync/async, errors
Constraints: Node 24, node: built-ins only, no deps, oxlint + oxfmt
Targets: >= 1M ops/s, < 1 MB extra memory, no GC churn per call
Hints: avoid %, /, copies, nested loops, transcoding; reuse buffers
Reference code: <links to existing modules to read>
Tests: node:test; generate one sample of 1M and analyze it
Benchmark: baseline crypto.randomUUID; warm-up; 5 rounds; median
Steps: implement -> tests -> perf tests -> optimize -> options
```

Benchmark harness the agent should produce (separate file):

```js
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const measure = (name, fn, { count = 1_000_000, rounds = 5 } = {}) => {
  for (let i = 0; i < 10_000; i++) fn();
  const rates = [];
  let sink = 0;
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    for (let i = 0; i < count; i++) sink += fn().length;
    const durationMs = performance.now() - start;
    rates.push(Math.round(count / (durationMs / 1000)));
  }
  rates.sort((a, b) => a - b);
  const median = rates[Math.floor(rates.length / 2)];
  return { name, opsPerSec: median, min: rates[0], sink };
};

const candidate = () => crypto.randomBytes(18).toString('base64url');

console.table([
  measure('crypto.randomUUID', () => crypto.randomUUID()),
  measure('randomBytes+base64url', candidate),
]);
```

Add a second variant that retains results (push into a preallocated
array) when callers keep the values; compare both. On Node.js 24 this
harness shows per-call `crypto.randomBytes(18)` at ~1.3M/s, while a
generator drawing the same bytes from a prefetched 96 KB buffer with a
lookup table reaches ~19M/s, which is why a performance spec should ask for
prefetched randomness.

Correctness tests on one shared sample:

```js
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const generateId = () => crypto.randomBytes(18).toString('base64url');
const SAMPLE_SIZE = 100_000;

describe('generateId', () => {
  let sample = null;

  before(() => {
    sample = Array.from({ length: SAMPLE_SIZE }, generateId);
  });

  it('should return 24 url-safe chars', () => {
    for (const id of sample) assert.match(id, /^[\w-]{24}$/);
  });

  it('should have no collisions', () => {
    assert.equal(new Set(sample).size, SAMPLE_SIZE);
  });
});
```

Case studies with prompts, outputs, and what went wrong:
[references/case-studies.md](references/case-studies.md).

## Anti-patterns

- Vibe coding: a two-line prompt for a non-trivial algorithm, output not
  read. Typical result: a god class with fake entropy (MAC, `pid`, time),
  hex/buffer round trips, and a benchmark inside it.
- Dialogue that only fixes structure: SRP comments split the god class
  into classes, but the algorithm stayed the same ("structured nonsense").
- Open-ended requests ("propose improvements", "refresh to modern APIs")
  on a large file: the agent touched other modules, added flags and
  `requestAnimationFrame`, and left broken code.
- Accepting confident claims: a model "solved" duplicate computed keys
  (`{ [x]: 'Uno', [_]: 'Due', [x]: 'Tre', [_]: 'Quatro' }`, expected
  selection `['Uno', 'Tre']`) and claimed that output; running its code
  gives `['Tre']` because later keys overwrite earlier ones.
- Syntax hacks with global effects: `Array.prototype.then` to make
  `await [p1, p2]` behave like `Promise.all`.
- Over-engineering: a large helper instead of a one-liner, mixins instead
  of the requested rewrite, an obsolete collection moved inside a function
  instead of deleted, 10-line files, comments everywhere, unrequested
  "tests" that are really use cases.
- Silently changed contracts: an optimizer assumed `payload.byteLength`
  (typed array) and broke string payloads; JavaScript has no types to stop
  it - state input types in the task.
- Narrow attention: asked to remove `let`, empty `catch`, and extra async
  functions, the model declared it impossible until told to use a promise
  chain: `readFile(path, 'utf8').then(JSON.parse).catch(() => DEFAULTS)`.
- Retained dead code: a constructor check on constants (`4096 % 4`) kept
  until the exact line was pointed out.
- Outdated or deprecated APIs: `KeyboardEvent.keyCode`, user-agent
  sniffing, `onclick =`, `require('crypto')` without `node:`,
  `url.parse()` (runtime DEP0169 warning on Node 24), `new Buffer()`
  (DEP0005), `buf.readUInt32LE(0, true)` (removed `noAssert`),
  `buf.slice` instead of `subarray`, `crypto.createCipher` (removed).
- Unfair benchmarks: comparing with nanoid/cuid "implementations" the model
  made up, measuring with tiny iteration counts, or benchmarking the
  benchmark's own allocations.
- Letting the agent run git or deploy commands, or work without a
  checkpoint - one bad bulk edit costs the session.

## Checklist

Review every AI-produced diff for:

- [ ] Scope: only the requested files/functions changed; no new deps,
      files, or modules touched without a reason.
- [ ] Contracts: signatures, input/output types, sync/async, error
      behavior, and return shapes unchanged unless requested.
- [ ] APIs exist and are current for the target Node.js version (check
      docs or run `node -e`); `node:` prefix; no deprecated calls.
- [ ] Architecture: no layer leaks (domain importing transport/db), no new
      globals, dependencies still injected, framework-agnostic domain.
- [ ] Simplicity: no god classes, static-only classes, mixins, gratuitous
      helpers, or files split for no reason; obsolete code deleted.
- [ ] Style: project lint and formatter pass; no comments restating code.
- [ ] Correctness: tests run and pass (`pnpm test`); edge
      cases and error paths covered; claims verified by running code.
- [ ] Performance work: baseline included, realistic harness, multiple
      rounds, memory measured, results reproducible on this machine.
- [ ] Concurrency safety: shared buffers/state not used across `await`,
      callbacks, or threads.
- [ ] Security: no secrets in code or prompts, no `eval`/`new Function` on
      input, no prototype patching, no weakened randomness (`Math.random`
      for ids/tokens).

Related skills: `js-conventions`, `node-tooling-testing`,
`node-performance-profiling`, `js-multiparadigm`, `node-crypto-auth`,
`node-security`
