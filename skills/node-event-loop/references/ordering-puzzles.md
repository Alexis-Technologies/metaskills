# Ordering puzzles (verified)

All outputs below were produced on Node.js v24.14.1 (macOS) and repeated
several times; where order varies between runs it is called out. Puzzles 1,
4, 7, 8 and 13 were re-run on v22.23.1 and v26.13.1 with identical output.
Use these to answer "what does this print" questions and to explain bugs.
Application code must not depend on these details; they matter for system
code and debugging.

Queues in one picture:

- Sync code runs to completion on the call stack.
- After each macrotask callback: drain `process.nextTick` queue, then the
  microtask queue (promise reactions, `queueMicrotask`, `await`
  continuations), repeat until both are empty.
- Then the loop moves on: timers -> pending -> poll -> check
  (`setImmediate`) -> close callbacks -> timers ...

## 1. The basic five (CommonJS vs ESM)

```js
setTimeout(() => console.log('timeout'), 0);
setImmediate(() => console.log('immediate'));
Promise.resolve().then(() => console.log('promise'));
queueMicrotask(() => console.log('microtask'));
process.nextTick(() => console.log('nextTick'));
console.log('sync');
```

```
main.cjs: sync nextTick promise microtask timeout immediate
main.mjs: sync promise microtask nextTick timeout immediate
```

- CJS: the script is a plain callback; after it, nextTicks drain first,
  then microtasks.
- ESM: module evaluation is a promise job, so the microtask queue is drained
  while still "inside" evaluation; nextTicks run afterwards.
- The last two lines are not guaranteed (see puzzle 2).

## 2. `setTimeout(0)` vs `setImmediate`

```js
setTimeout(() => console.log('timeout'), 0);
setImmediate(() => console.log('immediate'));
```

100 runs of the bare script on one machine: 98 x `immediate` first,
2 x `timeout` first. In a bigger script (more work before the loop starts,
puzzle 9) timers came first in every run.

- `setTimeout(fn, 0)` is a 1 ms timer. If loop start-up took >= 1 ms the
  timer is already due in the first timers phase; otherwise the loop passes
  timers, polls, runs check (immediate), and fires the timer next pass.

Inside an I/O callback the order is fixed:

```js
fs.readFile(__filename, () => {
  setTimeout(() => console.log('timeout'), 0);
  setImmediate(() => console.log('immediate'));
  process.nextTick(() => console.log('nextTick'));
});
```

```
nextTick immediate timeout   (30 of 30 runs)
```

- The callback runs in poll; check (immediate) comes before the next timers
  phase.

## 3. Microtasks run between timer callbacks

```js
setTimeout(() => {
  console.log('timeout 1');
  Promise.resolve().then(() => console.log('promise in timeout 1'));
  process.nextTick(() => console.log('nextTick in timeout 1'));
}, 0);

setTimeout(() => console.log('timeout 2'), 0);
```

```
timeout 1
nextTick in timeout 1
promise in timeout 1
timeout 2
```

- Since Node 11 queues are drained after every callback, not after the
  whole phase (matches browser behaviour).

## 4. Nested nextTick and promises

```js
Promise.resolve().then(() => {
  console.log('promise 1');
  process.nextTick(() => console.log('nextTick from promise'));
  Promise.resolve().then(() => console.log('promise from promise'));
});

process.nextTick(() => {
  console.log('nextTick 1');
  process.nextTick(() => console.log('nextTick from nextTick'));
  Promise.resolve().then(() => console.log('promise from nextTick'));
});

console.log('sync');
```

```
sync
nextTick 1
nextTick from nextTick
promise 1
promise from nextTick
promise from promise
nextTick from promise
```

- The nextTick queue is drained completely (including ticks added while
  draining) before any promise reaction. Then the microtask queue is
  drained completely. A tick added from a promise waits until the microtask
  queue is empty, then the cycle repeats.

## 5. `async` functions run synchronously until the first `await`

```js
const task = async (name) => {
  console.log(`${name}: start`);
  await null;
  console.log(`${name}: after await`);
};

console.log('script start');
task('A');
task('B');
console.log('script end');
```

```
script start
A: start
B: start
script end
A: after await
B: after await
```

- `await` always suspends, even on a non-promise value; the continuation is
  a microtask. Code before the first `await` can block like any sync code.

## 6. Starvation: nextTick and microtasks vs `setImmediate`

A 0 ms timer is armed, then a step function re-schedules itself 1,000,000
times through different queues; we record how many steps ran before the
timer fired.

```
nextTick:       timer never fired before all 1,000,000 steps finished
queueMicrotask: timer never fired before all 1,000,000 steps finished
setImmediate:   timer fired after 61 steps
```

- Recursive nextTick/microtask scheduling starves timers and all I/O.
  `setImmediate` lets one full loop pass (timers, poll) run between steps.

## 7. Everything at once, inside an I/O callback (deterministic)

```js
fs.readFile(__filename, () => {
  console.log('A readFile callback');
  setTimeout(() => {
    console.log('F timeout');
    process.nextTick(() => console.log('G nextTick in timeout'));
  }, 0);
  setImmediate(() => {
    console.log('D immediate');
    Promise.resolve().then(() => console.log('E promise in immediate'));
  });
  Promise.resolve().then(() => console.log('C promise'));
  process.nextTick(() => console.log('B nextTick'));
});
console.log('0 sync');
```

```
0 sync
A readFile callback
B nextTick
C promise
D immediate
E promise in immediate
F timeout
G nextTick in timeout
```

20 of 20 runs identical.

## 8. Close callbacks come after check

```js
socket.on('connect', () => {
  socket.on('close', () => console.log('close callback'));
  setImmediate(() => console.log('immediate'));
  setTimeout(() => console.log('timeout'), 0);
  socket.destroy();
});
```

```
immediate
close callback
timeout
```

## 9. Every scheduling API in one script

The file schedules: two `setTimeout(0)`, two `setTimeout(1)`, two
`setImmediate`, two `setInterval(0)` that clear themselves, two
`process.nextTick`, two synchronous callbacks, two `fs.readFile`, then logs
`main ended`. Output on v24 (3 runs):

```
callback #11 callback
callback #12 callback
main ended
callback #9 process.nextTick
callback #10 process.nextTick
callback #1 setTimeout 0
callback #2 setTimeout 0
callback #3 setTimeout 1
callback #4 setTimeout 1
callback #7 setInterval 0
callback #8 setInterval 0
callback #5 setImmediate
callback #6 setImmediate
callback #13 readFile   <- #13 and #14 swapped in one run of three
callback #14 readFile
```

- A callback passed to a function is not asynchronous by itself (#11, #12).
- 0 ms and 1 ms timers and 0 ms intervals all become 1 ms and share one
  timer list in insertion order.
- Timers before immediates here only because start-up took > 1 ms.
- Two parallel `readFile` calls complete in pool order, not call order.

## 10. A blocked loop delays every timer

```js
const begin = process.hrtime.bigint();
const diff = (end) => (end - begin) / 1000000n;
setTimeout(() => console.log('  0: ' + diff(process.hrtime.bigint())), 0);
setTimeout(() => console.log(' 10: ' + diff(process.hrtime.bigint())), 10);
setTimeout(() => console.log(' 20: ' + diff(process.hrtime.bigint())), 20);
const fib = (n) => (n < 2 ? 1 : fib(n - 1) + fib(n - 2));
for (let i = 0; i < 40; i++) fib(i);
```

```
  0: 1149
 10: 1151
 20: 1151
```

- All three fire together about 1.15 s late. Unblocked, timers are close to
  their delays: 10 ms -> 11, 100 -> 100, 500 -> 501, 1000 -> 1000.

## 11. `async` syntax over sync data still blocks

An interval increments `k` every 10 ms
while `for await` walks a 10,000,000-element array.

```
{ i: 10000000, k: 0 }   (~0.8 s with the loop fully blocked)
```

Yielding variants over 10,000 items:

```
setTimeout(0) per item:  ~11.5 s total
setImmediate per item:   ~0.16 s total, timers still ran (k = 13)
```

## 12. The thread pool is shared by unrelated work

```js
for (let i = 1; i <= 5; i++) {
  crypto.pbkdf2('secret', 'salt', 300_000, 64, 'sha512', () => {
    console.log(`pbkdf2 #${i}: ${elapsed()} ms`);
  });
}
fs.readFile(__filename, () => console.log(`readFile: ${elapsed()} ms`));
setTimeout(() => console.log(`timeout 10: ${elapsed()} ms`), 10);
```

```
default pool (4)                 UV_THREADPOOL_SIZE=8
timeout 10: 11 ms                readFile: 1 ms
pbkdf2 #1: 63 ms                 timeout 10: 11 ms
pbkdf2 #3: 70 ms                 pbkdf2 #5: 69 ms
readFile: 70 ms                  pbkdf2 #2: 77 ms
pbkdf2 #4: 72 ms                 pbkdf2 #1: 77 ms
pbkdf2 #2: 73 ms                 pbkdf2 #3: 78 ms
pbkdf2 #5: 123 ms                pbkdf2 #4: 85 ms
```

- The JS thread stays free (the timer is on time), but the fifth hash and
  the unrelated `readFile` wait for a pool thread.

## 13. What keeps the process alive

```js
const pending = new Promise(() => {});
pending.then(() => console.log('never'));
const heartbeat = setInterval(() => console.log('heartbeat'), 1000);
heartbeat.unref();
process.on('exit', (code) => console.log('exit', code));
console.log('main done');
```

```
main done
exit 0
```

- Neither a pending promise nor an unref'ed interval keeps the loop alive.
- ESM `await new Promise(() => {})` at top level prints
  `Warning: Detected unsettled top-level await` and exits with code 13.
- `process.getActiveResourcesInfo()` lists what still holds the loop
  (for example `[ 'FSReqCallback', 'Timeout' ]`), handy when a process will
  not exit.

## 14. `setInterval` drift and the promise iterator burst

Interval 100 ms, callback blocks 30 ms (250 ms on tick 2):

```
setInterval (callback API)      for await (setInterval(100)) with await sleep
tick 1 at 103 ms                tick 1 at 102 ms
tick 2 at 204 ms                tick 2 at 204 ms   (then sleeps 350 ms)
tick 3 at 454 ms                tick 3 at 555 ms
tick 4 at 557 ms                tick 4 at 568 ms   <- buffered ticks
tick 5 at 658 ms                tick 5 at 580 ms   <- arrive in a burst
tick 6 at 761 ms                tick 6 at 611 ms
```

- The callback API re-arms relative to when the callback ran: missed ticks
  are dropped and the schedule drifts (tick 6 at 761 ms instead of 600 ms).
- The async iterator never overlaps the loop body but queues missed ticks
  and yields them back to back.
- `setInterval(async () => job(), 50)` where `job` takes 250 ms ran up to
  5 jobs at the same time.
