# Capacity arithmetic

Rough numbers for one Node.js process, to check a design and to read a load test. They never
replace the load test.

## CPU time per request

Let `C` be the time a request holds the event loop: the synchronous part before its I/O plus the
callbacks after it. Waiting for MongoDB or an upstream does not count, because the loop serves other
requests meanwhile.

- One process serves at most `1 / C` requests per second: `C = 20 ms` gives 50 req/s, `C = 2 ms`
  gives 500 req/s.
- `N` requests that arrive together leave the last one waiting `(N - 1) * C` before its own work
  starts. One 500 ms synchronous call delays every request behind it by 500 ms.

Measure `C` instead of guessing it: during a steady load test, `C ≈ ELU / rate`. ELU 0.4 at
100 req/s means 4 ms per request.

## Utilization and waiting

With arrival rate `λ`, utilization is `ρ = λ * C`, which is roughly what ELU reports. Arrivals are
uneven, so requests queue long before `ρ` reaches 1. A simple queueing model gives a loop time per
request of about `C / (1 - ρ)`, plus the I/O time:

| ELU | Loop time per request |
| --- | --- |
| 0.3 | 1.4 C |
| 0.5 | 2 C |
| 0.7 | 3.3 C |
| 0.9 | 10 C |

That is why about 70% is treated as saturated: the next small burst doubles the latency again.
Plan peak load around 50%, alert near 70%, and shed only as a last resort.

## Little's law

`in flight = rate * response time`. At 200 req/s and 150 ms, 30 requests are in flight per process.
Use it to size what every request holds:

- the MongoDB pool (`maxPoolSize`), with room for background jobs (`node-data-access`);
- concurrency limits and queue sizes of semaphores and worker pools (`js-async-concurrency`,
  `node-multithreading`);
- connections to an upstream (undici `connections`).

A pool smaller than the in-flight count turns into a queue with its own wait.

## Replicas

`replicas = peak rate / (target ρ / C)`, rounded up, plus one for a deploy or a failed instance.
Peak 600 req/s with `C = 4 ms` at a target of 0.5 gives 125 req/s per process, 5 replicas, 6 with
the spare.

## What breaks the arithmetic

- **The libuv pool.** `crypto.scrypt`, `pbkdf2`, native password hashing, `fs` and `dns.lookup`
  queue on 4 threads by default (`UV_THREADPOOL_SIZE`). A sign-in endpoint can saturate it while
  ELU stays low.
- **GC.** Allocation-heavy handlers add pauses that ELU counts but `C` measured at low load does not.
- **One slow path.** A rare request with a large `C` (an export, a report) dominates the tail. Move
  it to a worker or a queue (`node-multithreading`, BullMQ).
- **CPU quotas.** In a container, the process gets the quota, not the host's cores
  (`node-scaling-highload`).
