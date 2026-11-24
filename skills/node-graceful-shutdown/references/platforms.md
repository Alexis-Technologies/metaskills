# Shutdown behaviour per platform and framework

Size the drain so that `drain + cleanup + margin < kill timeout` of the
platform. Defaults below; configure them explicitly in the deploy files.

| Platform | Stop signal | Kill after | Setting |
| --- | --- | --- | --- |
| Fly.io (auth8) | `kill_signal` (**SIGINT**) | **5 s**, up to 300 s | `kill_signal`, `kill_timeout` in `fly.toml` |
| Docker `docker stop` | `STOPSIGNAL` (SIGTERM) | 10 s | `docker stop -t`, Compose `stop_grace_period` |
| Kubernetes pod deletion | preStop hook, then SIGTERM | 30 s total | `terminationGracePeriodSeconds` |
| PM2 stop/restart/reload | SIGINT | 1600 ms | `kill_timeout` |
| systemd `systemctl stop` | `KillSignal` (SIGTERM) | 90 s | `TimeoutStopSec` |
| Terminal | SIGINT to the whole process group | never | - |

## Fly.io

- The default signal is `SIGINT` and the default timeout is 5 s, which is shorter than a normal
  drain. Set both in `fly.toml`, with `kill_timeout` above the exit deadline:

```toml
kill_signal = "SIGTERM"
kill_timeout = "30s"
```

- auth8 has no `fly.toml` in the repository yet, so nothing sets these values there.

## Docker

- Use exec form: `CMD ["node", "main.js"]`. Shell form (`CMD node main.js`)
  runs `/bin/sh -c`, which does not forward SIGTERM; `pnpm start` adds another
  process that may not forward signals or wait for the child.
- Node as PID 1 has no default signal handling: without your own handlers
  SIGTERM and SIGINT are ignored and the container is killed after the
  timeout. With handlers installed it works, but PID 1 also must reap
  zombies of spawned children - use `docker run --init` (or tini) when the
  app spawns processes.
- Exit code 137 after `docker stop` = SIGKILL: shutdown exceeded the
  timeout or never started (signal not delivered).

## Kubernetes

- Deletion sequence: pod marked Terminating -> preStop hook runs -> SIGTERM
  -> after `terminationGracePeriodSeconds` (default 30, counted from the
  start, preStop included) SIGKILL.
- Endpoint removal happens concurrently with the preStop/SIGTERM path, and
  kube-proxy/ingress update with a delay, so new connections still arrive for
  a few seconds. Either add a preStop delay (`exec` of `sleep 5`, which needs
  `sleep` in the image; newer clusters also offer a built-in `sleep` action)
  or delay `server.close()` by a few seconds in the app while readiness
  already returns 503.
- Readiness probe: fail from the start of shutdown. Liveness probe: keep it
  passing until exit, otherwise the kubelet restarts the container
  mid-drain.
- Rolling updates (`maxSurge`, `maxUnavailable`) are zero-downtime only if
  each pod drains; set `minReadySeconds` so new pods prove themselves.
- Restart policy restarts containers regardless of exit code; repeated
  crashes back off (CrashLoopBackOff). Exit 1 after crashes keeps restart
  counters and alerts meaningful.

## PM2

- PM2 sends SIGINT, waits `kill_timeout` (1600 ms default), then SIGKILL:
  raise `kill_timeout` above the drain timeout.
- Zero-downtime `pm2 reload` in cluster mode: with `wait_ready: true` PM2
  waits for `process.send('ready')` (send it after `listen`), bounded by
  `listen_timeout`.
- On Windows signals are unreliable: `shutdown_with_message: true` makes PM2
  send a `'shutdown'` message; handle both:

```js
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('message', (message) => {
  if (message === 'shutdown') shutdown('pm2');
});
```

- Crash restarts: `autorestart`, `max_restarts`, `min_uptime`,
  `exp_backoff_restart_delay` to avoid tight crash loops.

## systemd

- `systemctl stop` sends `KillSignal=` (SIGTERM) to the main process and,
  with the default `KillMode=control-group`, to every process of the unit;
  after `TimeoutStopSec=` (default 90 s) it sends SIGKILL.
- `Restart=on-failure` with `RestartSec=` restarts after exit code 1 but not
  after a clean exit 0 from a requested stop - matching the exit code rules.
- Logs to stdout/stderr go to the journal; still flush the logger before
  exit.

## Windows

- Ctrl+C delivers `SIGINT`, Ctrl+Break `SIGBREAK`, closing the console
  window `SIGHUP`; `SIGTERM` from other processes is not delivered and
  `process.kill()` terminates abruptly. Use an IPC message or an admin
  endpoint to trigger shutdown.

## Cluster (`node:cluster`)

- The primary owns the listening handle; workers get connections from it, so
  a worker can be replaced while the port stays open.
- Rolling restart: fork the new worker, wait for its `'listening'`, then
  message the old one to shut down.
- `worker.disconnect()` closes the worker's servers and waits for them;
  combine it with a timeout and `worker.kill()` because keep-alive sockets
  can delay it.
- In a container only PID 1 (the primary) receives SIGTERM: the primary must
  propagate the stop to workers and exit after they do. In a terminal the
  whole group receives SIGINT; workers should ignore it and follow the
  primary.

## Worker threads

- Send a stop message, let the thread run its own cleanup and call
  `process.exit(0)` inside the thread (ends only that thread), wait for the
  `'exit'` event with a timeout, then `worker.terminate()`.
- Restart threads that exit with a non-zero code, with a limit or backoff.

## Libraries

- Fastify: `await fastify.close()` runs `preClose`, closes the server, waits for requests, then runs
  `onClose` hooks, last registered first. While closing it answers requests on open connections with
  503 (`return503OnClosing`). Its default `keepAliveTimeout` is 72 s: see the main skill.
- `ws`: track `wss.clients`, close each with 1012 or 1001 and terminate leftovers. `wss.close()`
  semantics differ between major versions.
- `@alexify/wrpc`: `server.close({ drain })`, or the `drain` option of the Fastify plugin.
- Clients: `client.close()` (mongodb), `redis.quit()` (graceful) or `disconnect()`. Close producers
  after consumers and after the HTTP drain.

## Health endpoints during shutdown

```js
const health = {
  live: () => 200,
  ready: () => (state.closing ? 503 : 200),
};
```

Expose them on the main server (they are served until `server.close()`), or
on a separate admin port when the main server stops accepting before the
orchestrator reads readiness.
