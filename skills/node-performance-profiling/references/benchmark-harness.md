# Process-isolated benchmark harness

A single-file harness that follows the benchmarking rules of `SKILL.md`. The
parent starts one child process per case, so a case never inherits the inline
caches, feedback or heap of another. Each child warms up, takes samples, and
prints its median, its spread and a value from the result sink.

Array methods are fine here: this is a benchmark, not `src/`.

```js
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const ITERATIONS = 1_000_000;
const WARMUP_ROUNDS = 3;
const SAMPLES = 10;
const SINK_SIZE = 1024;

const cases = {
  literal: () => ({ hello: 'world', size: 100500, flag: true }),
  createNull: () => {
    const obj = Object.create(null);
    obj.hello = 'world';
    obj.size = 100500;
    obj.flag = true;
    return obj;
  },
};

const sink = new Array(SINK_SIZE).fill(null);

const measure = (fn) => {
  const times = [];
  for (let round = 0; round < WARMUP_ROUNDS + SAMPLES; round++) {
    const begin = performance.now();
    for (let i = 0; i < ITERATIONS; i++) sink[i & (SINK_SIZE - 1)] = fn(i);
    const elapsed = performance.now() - begin;
    if (round >= WARMUP_ROUNDS) times.push(elapsed);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const spread = (times[times.length - 1] - times[0]) / median;
  return { median, spread, nsPerOp: (median * 1e6) / ITERATIONS };
};

const runAll = () => {
  const results = Object.keys(cases).map((name) => {
    const args = [__filename, name];
    const output = execFileSync(process.execPath, args, { encoding: 'utf8' });
    return JSON.parse(output);
  });
  const best = Math.min(...results.map((result) => result.median));
  const rows = results.map(({ name, median, spread, nsPerOp, sample }) => ({
    name,
    nsPerOp: nsPerOp.toFixed(2),
    spread: `${(spread * 100).toFixed(0)}%`,
    relative: `${(median / best).toFixed(2)}x`,
    sample,
  }));
  console.table(rows);
};

const name = process.argv[2];
if (name) {
  const result = measure(cases[name]);
  const sample = JSON.stringify(sink[0]).length;
  process.stdout.write(JSON.stringify({ name, ...result, sample }));
} else {
  runAll();
}
```

- Add a case by adding a key to `cases`. Keep the input realistic and vary it
  through the `i` argument, or the optimizer folds a constant.
- `sample` is printed so the results stay observable. If it differs between
  cases that should produce the same value, the benchmark compares different
  work.
- A difference inside the printed `spread` is noise. Re-run before believing it.
- Do not run it with `--inspect`, a profiler or `--trace-*` flags.
- For a clean heap between rounds, start it with `--expose-gc` and call `gc()`
  before each round.
- Confirm a win with a macro benchmark of the real operation.
