# Case studies

Each case: the task, what the model did, what fixed it, and the rule it
supports.

## 1. GSID: prompt vs chat vs spec vs manual (Cursor, 2025)

Task: a globally unique id generator, an alternative to UUIDv4, as fast as
possible. Same task, five strategies.

- One-line prompt ("generate globally unique id alternative to UUIDv4, try
  to do it better, high performance is desired"): one `GSID` class with
  machine id from network interface MACs hashed with SHA-256 to hex, `pid`,
  `Date.now()` plus counter, 32-byte random chunks, hex-to-buffer round
  trips, `%`, `base64url` plus `replace`, a second "hybrid" generator, a
  `generateUUID` wrapper around `crypto.randomUUID`, and a benchmark inside
  the class. Unrequested tests looked like use cases. About 1.25M ids/s,
  slower than the built-in.
- Step-by-step chat: review comments (respect SRP; keep one file; move the
  benchmark to tests; drop `generateHybrid` and `generateUUID`) produced
  `MachineId`, `EntropyPool`, `CounterManager` classes around the same
  algorithm. Still about 1.27M ids/s. Dialogue fixed structure, not the
  algorithm.
- Written spec: 24 chars, 144 bits, 64-char
  alphabet; benchmark candidate randomness sources; prefetch random data
  like the existing `randomPrefetcher` (linked); avoid `%`, `/`, memory
  copies, nested loops, transcoding; typed arrays; numeric targets
  (>= 1M ids/s, < 1 MB memory, no GC impact); test plan; ordered steps.
  Result: Uint8Array alphabet, `byte & 0x3f` index, characters written back
  into the same random buffer, `toString()` once. About 6M ids/s; ~2 h of
  human time.
- By example (port the spec version to the browser with ESM and Web
  Crypto): faithful port, but `String.fromCharCode(...bytes)` replaced
  `Buffer#toString`, about 1.4M ids/s. Ports preserve algorithms, not
  platform-specific performance; measure after porting.
- Manual (expert, ~18-30 min): 256-entry lookup table (each of the 64
  chars repeated 4 times, so a raw byte indexes it directly), preallocated
  output buffer per length, big prefetch buffer, `TextDecoder`
  on the web. About 10.6M ids/s. The model then wrote tests, typings,
  entropy analysis, and the report.

Takeaways: vibe coding is cheap and bad; a spec works but is expensive;
the best return is an expert-written core plus AI for the routine. The
model never proposed the bit-mask/lookup-table idea itself; pushed to
"read how to optimize for V8" it reached only 2-3M ids/s. Its comparison
with nanoid/cuid used reimplementations of unknown origin - unfair
baselines. AI-written reports also spin numbers (a negative memory delta
reported as "memory freed"; per-char entropy inconsistent with the table).

## 2. Chunk encode/decode with typed arrays (ChatGPT 3.5/4)

Initial: `class Chunk { static encode(id, payload); static decode(view) }`
plus two helpers, allocating two typed arrays per packet.

- "Optimize complexity, readability, memory and speed": renamed constants,
  swapped `DataView` for `Int32Array`, assumed `payload.byteLength`
  (breaking string payloads); GPT-4 moved all four functions into the
  class. Neither removed the never-instantiated class.
- "Just optimize": GPT-3.5 proposed a shared module-level id buffer, which
  is correct only because `encode` is synchronous.
- Detailed prompt ("one typed array allocation instead of two, remove the
  unneeded class, just two functions"): both models produced the same
  code as the manual version: one `Uint8Array`, a `DataView` over the same
  buffer, `subarray` for the payload.

Rules: state input types; name the target structure; narrow goals beat
"optimize everything"; check reentrancy of shared buffers.

## 3. Config loading with a promise chain (ChatGPT 4)

Initial: IIFE, `let data`, empty `catch {}`, ternary with default config.

- Constraints added one by one (no `console.log` inside `try`, no `let`, no
  extra IIFE, no new async function) made the model answer that it was
  impossible and repeat the original code.
- After "maybe you can use a promise chain":
  `fs.readFile(...).then(JSON.parse).catch(() => ({ port: 80 }))`.
- Asked why it failed, the model said it stayed focused on async/await
  syntax.

Rules: restate all constraints each time; suggest the alternative
technique; a 1-minute manual fix took 15 minutes of dialogue.

## 4. Crypto random prefetcher (ChatGPT 4)

Initial: a class instantiated once, with `bufSize % valueSize` check
(dead for constant arguments) and a copied `vsz` field.

- The model produced a good closure-based factory and dropped a redundant
  argument, but insisted the dead check was needed until pointed at the
  exact `if`. Follow-ups: remove the copied field, use `UPPER_SNAKE` for
  file-wide constants.

Rules: point to exact lines; single-use classes become objects or
closures; check `node:` prefixes in generated imports.

## 5. GPT-4o puzzles (2024)

- Duplicate computed keys `{ [x]: 'Uno', [_]: 'Due', [x]: 'Tre', [_]:
  'Quatro' }` with `getSelected` expected to return `['Uno', 'Tre']`: the
  model returned symbol-based code and claimed that output; running it
  gives `['Tre']` (later keys overwrite). Always run the code.
- "Make `await [p1, p2, p3]` behave like `Promise.all`": the model patched
  `Array.prototype.then` - a global behavior change for every array.
- Stack overflow in `const f1 = async () => { await f1(); }`: the model
  matched the expected fix (`await null` before the recursive call yields
  to the microtask queue first).

## 6. Refactoring to closures and IO isolation (Cursor, 2025)

Task: rewrite class-based IO/monad examples into pure closures without object literals.

- First attempt attached methods to functions via mixins and duplicated
  the `run` logic instead of rewriting.
- Fixed by naming the duplicated functionality, saying what must stay
  unchanged ("keep createIO and createMonad as in previous examples"), and
  giving the target call shape (`move(-5, 10)` instead of a delta object).
- The result worked only after running it, and its long lines needed
  `pnpm format`.

Rules: state the target shape and invariants; forbid mixins; run and lint
after; expect weak FP in JavaScript (little training data).

## 7. Livecoding a browser console with Cursor and Codex (2025)

- Cursor, directed: "rewrite the lookup with a `Map`", "detect touch screen
  with the new web API" (second attempt produced `navigator.maxTouchPoints`
  after the first suggested a bloated `isMobile` helper), "make `isMobile`
  a constant and fix all calls in this file", "use `addEventListener`
  instead of `on*` and fix similar cases", "replace `keyCode` with `code`".
  The agent left string comparisons stale and moved an obsolete map into a
  function instead of deleting it; each was fixed by a pointed follow-up.
  Lint after the session caught an unused variable. Result: working code,
  committed.
- Codex: `/init` produced a verbose `AGENTS.md` with invented directory
  purposes; after manual edits (remove deployment and commit sections, add
  test and lint commands) the agent rewrote some of those edits. "Propose improvements for console.js" ran for minutes,
  ran tests, edited another package, added flags and
  `requestAnimationFrame`, and left suspicious broken indentation. Some
  ideas were good (inject `application` through the constructor instead of
  a module global), but the diff was not accepted unreviewed.

Rules: checkpoint commits; never let the agent run git; directed
instructions beat open-ended ones; the agent is great as an intelligent
search-and-replace and API reference, weak at design.

## 8. What a minimal agent harness shows

A ~1300-line Node.js harness: a loop that sends messages plus tool
definitions (`read`, `write`, `edit`, `patch`, `bash`, `grep`, `glob`,
`check`, `fetch`, `todo`), executes requested tools after approval, appends
results, and repeats until the model answers without tool calls.

- The model only sees what tools return; results are truncated (60k chars),
  so targeted reads (offset/limit, grep) beat dumping files.
- A step limit (30) bounds runaway loops; plan multi-step work explicitly.
- Workspace containment and approvals guard file tools, but `bash` can
  reach anything - "not a sandbox".
- Its system instructions are a good baseline for any agent: inspect before
  changing, prefer small focused changes, verify with a check after edits,
  never claim success without verification, recover from tool errors
  instead of pretending, summarize what was verified.
