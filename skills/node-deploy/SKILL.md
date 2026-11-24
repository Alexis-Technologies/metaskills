---
name: node-deploy
description: Container images and Fly.io or Vercel deploys for Node.js apps. Use when writing a Dockerfile, fly.toml or a deploy pipeline
---

<!-- Alexis stack. Written from the auth8 cloud skill and ADR-011 (Fly.io for services, Vercel for
     the SPA), with the Node.js, pnpm and Kubernetes advice brought up to date. pnpm deploy, prune and
     prepare behaviour checked with pnpm 11. -->

# Deploying Node.js apps

Build an image once per commit, run the same image in every environment with a different
configuration (12-factor V), and let the platform stop it gracefully. Shutdown timings are in
`node-graceful-shutdown`, configuration in `node-config`, topology and scaling in
`node-scaling-highload`.

|  | Library `@alexify/*` | App |
| --- | --- | --- |
| Artifact | An npm tarball (`npm-publish`) | One image per process type: API, jobs |
| Runs on | The consumer's process | Fly.io machines; the SPA on Vercel |
| Process | None of its own | `node` as PID 1, one process per container |

## Rules

- **One image per app, one process per container.** Scale by machines, not with `cluster` or PM2
  inside the container.
- **Pin the base image** to a full version that matches `engines`: `node:24.14.1-slim`. Upgrade it
  deliberately with the Node.js upgrade checklist (`node-tooling-testing`). Debian slim by default;
  Alpine only when every native dependency supports musl.
- **Multi-stage.** The build stage has the devDependencies and runs the TypeScript build. The
  runtime stage holds `dist/` and production dependencies only: no compiler, no sources, no tests,
  no `.env`.
- **Install everything, then drop devDependencies.** Run the full `pnpm install --frozen-lockfile`
  in the build stage, so native builds and the root `prepare` run. Get production dependencies with
  `pnpm deploy --prod` in a workspace or `pnpm prune --prod` in a single package. Never
  `pnpm install --prod` in an image: it still runs the root `prepare`, whose tools (such as
  `alexiskills`) are devDependencies. `--ignore-scripts` would skip native builds too.
- **`pnpm deploy` needs `injectWorkspacePackages: true`** in `pnpm-workspace.yaml` since pnpm 10
  (or `--legacy`). It copies what `pnpm pack` would: without a `files` field it takes the whole
  package folder, **`.env` included**. Give every app `"files": ["dist"]`.
- **What `start` runs is a dependency.** An image that runs `fastify start` needs `fastify-cli` in
  `dependencies`. In `devDependencies` it is gone after `--prod`.
- **Run `node` directly, in exec form:** `CMD ["node", "node_modules/fastify-cli/cli.js", ...]`.
  Not `pnpm start`, not a shell form, so the stop signal reaches Node. Node as PID 1 is fine once
  handlers are installed (fastify-cli's or yours). Add `--init` (tini) only when the app spawns
  child processes.
- **Non-root.** `USER node`, application files owned by root and read-only; only data directories
  are writable.
- **No secrets in the image.** Never in `ARG`, `ENV` or a copied file. A build-time token (a
  private registry) comes through `RUN --mount=type=secret`. Runtime secrets come from the platform
  (`node-config`).
- **`NODE_ENV` is not a switch.** Never set it in the build stage: pnpm skips devDependencies when
  `NODE_ENV=production`. If a runtime dependency still reads it, set it in the runtime stage only;
  your code never reads it.
- **Memory.** Set `--max-old-space-size` to about 75% of the machine's memory in `NODE_OPTIONS`,
  leaving room for buffers and native memory.
- **Listen on all interfaces.** fastify-cli binds to localhost unless it detects Docker or
  Kubernetes, so set `FASTIFY_ADDRESS=0.0.0.0` explicitly.
- **Immutable tags.** Tag images with the git SHA, promote the same image from staging to
  production, and roll back by deploying the previous image.

## Dockerfile for a workspace app

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_VERSION=24.14.1

FROM node:${NODE_VERSION}-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile
RUN pnpm --filter "@auth8/api..." run build
RUN pnpm --filter @auth8/api deploy --prod /out

FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "node_modules/fastify-cli/cli.js", "start", "-o", "dist/main.js"]
```

- `pnpm fetch` fills the store from the lockfile alone, so that layer is cached until the lockfile
  changes. The offline install then needs no network.
- `"@auth8/api..."` builds the app and the workspace packages it depends on.
- `corepack enable` installs the pnpm version of `packageManager`. Node.js 25 and later ship without
  Corepack: install pnpm with its standalone installer there.
- A worker image is the same with its own filter and `CMD`.

`.dockerignore` at the root of the build context, the repository root:

```text
**/node_modules
**/dist
**/coverage
**/.env
**/.env.*
!**/.env.example
.git
.claude
**/e2e/.auth
**/*.log
```

## Fly.io

```toml
# apps/auth8-api/fly.toml
app = "auth8-api"
primary_region = "fra"
kill_signal = "SIGTERM"
kill_timeout = "30s"

[deploy]
  release_command = "node dist/migrate.js"
  strategy = "rolling"

[env]
  FASTIFY_ADDRESS = "0.0.0.0"
  FASTIFY_PORT = "3000"
  FASTIFY_LOG_LEVEL = "info"
  FASTIFY_CLOSE_GRACE_DELAY = "25000"
  NODE_OPTIONS = "--max-old-space-size=384"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "off"
  min_machines_running = 2

  [[http_service.checks]]
    method = "GET"
    path = "/health/ready"
    interval = "10s"
    timeout = "2s"
    grace_period = "10s"

[[vm]]
  memory = "512mb"
  cpus = 1
  cpu_kind = "shared"
```

- Deploy from the repository root, so the lockfile is in the build context:
  `fly deploy --config apps/auth8-api/fly.toml --dockerfile apps/auth8-api/Dockerfile`.
- The default stop signal is `SIGINT` with a 5 s timeout. Set both, with `kill_timeout` above
  `FASTIFY_CLOSE_GRACE_DELAY` (`node-graceful-shutdown`).
- `[env]` holds non-secret values only. Secrets: `fly secrets set` (`node-config`).
- The HTTP checks decide routing, not restarts, so point them at readiness.
- `release_command` runs once per deploy in a temporary machine with the new image, before any
  machine is replaced, and a failure stops the deploy. Old machines keep serving during the rollout,
  so a migration must work with both versions: expand first, contract in a later release
  (`node-data-access`).
- A worker app (`auth8-jobs`) has no `[http_service]`. Give it a check on a small health port or
  rely on restarts, and size `kill_timeout` for its longest job drain.
- `min_machines_running = 2` keeps one machine serving while the other is replaced.

## Vercel for the SPA

The Vue build is static. Vercel serves it from its CDN, so Node never serves assets.

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }],
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }]
    }
  ]
}
```

- Only `VITE_*` variables reach the bundle, and they are public.
- The API allows the exact SPA origins in CORS, preview deployments included, never `*` with
  credentials (`node-security`).

## Pipeline

1. Lint, test and build on every push (`node-tooling-testing`).
2. Build the image once: `fly deploy --build-only --push --image-label <git-sha>`, or build in CI
   and push to `registry.fly.io/<app>:<git-sha>`.
3. Deploy that image to staging: `fly deploy --app <staging-app> --image registry.fly.io/<app>:<git-sha>`.
4. Run the smoke tests and the smoke load profile against staging.
5. Promote the same image to production. Roll back with the previous SHA.

Kubernetes, if the platform changes: [references/kubernetes.md](references/kubernetes.md).

## Anti-patterns

- `CMD pnpm start`, `CMD npm start` or a shell-form `CMD`: the signal stops at the wrapper.
- `pnpm install --prod` in an image with a root `prepare`, or `NODE_ENV=production` before the
  install.
- `pnpm deploy` of an app without `files`, which copies `.env` into the image.
- `fastify-cli` in `devDependencies` of an app whose image runs `fastify start`.
- A floating base tag (`node:latest`, `node:24`) or Alpine with untested native modules.
- Secrets in `ARG`, `ENV`, `.npmrc` or `fly.toml`.
- Building a new image per environment, or tagging `latest` and deploying the tag.
- A migration that breaks the version still running during the rollout.
- The Fly default `kill_timeout` of 5 s with a 25 s drain.

## Checklist

- [ ] Multi-stage build on a pinned `-slim` base that matches `engines`.
- [ ] Full install in the build stage; production dependencies from `pnpm deploy --prod` or
      `pnpm prune --prod`.
- [ ] `files: ["dist"]` in the app, `.dockerignore` covers `.env`, `node_modules`, `dist` and `.git`.
- [ ] The start command's package is in `dependencies`.
- [ ] `node` runs directly in exec form as a non-root user.
- [ ] No secret in the image or in `fly.toml`.
- [ ] `FASTIFY_ADDRESS`, `kill_signal`, `kill_timeout` and `FASTIFY_CLOSE_GRACE_DELAY` are set.
- [ ] Checks point at readiness; migrations run as `release_command` and are backward compatible.
- [ ] One image per commit, promoted unchanged, with a known rollback.

Related skills: `node-graceful-shutdown`, `node-config`, `node-scaling-highload`, `node-security`,
`node-observability`, `node-tooling-testing`
