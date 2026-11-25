---
name: node-config
description: 12-factor Node.js config with one validated env schema, secrets and flags, no NODE_ENV. Use when adding a setting or an env var
---

<!-- Alexis stack. Written from the auth8 configuration skill and ADR-006 (12-factor, env-schema,
     no NODE_ENV), with @alexify/metaschema as the schema source. Checked with metaschema 3.4.1. -->

# Node.js configuration

Configuration is what differs between deploys of the same code: addresses, credentials, values tuned
per environment and feature switches. It lives in the environment (12-factor III), is read once at
startup, validated against one schema and passed down. Code never asks where it runs.

|  | Library `@alexify/*` | App |
| --- | --- | --- |
| Source | Constructor options from the caller | Environment variables |
| Reads `process.env` | Never | Only the composition root, once, through `loadConfig` |
| Validation | In the constructor | One `@alexify/metaschema` schema at boot |
| Defaults | In the constructor | In the schema |
| Secrets | Passed in by the caller | The platform's secret store, then the environment |

## What goes where

| Kind | Example | Where |
| --- | --- | --- |
| Deploy-specific | `MONGODB_URL`, `REDIS_URL`, `FASTIFY_PORT` | Environment |
| Secrets | `SESSION_SECRET`, API keys, signing keys | Environment, from the secret store |
| Tuned per deploy | `SHUTDOWN_DRAIN_TIMEOUT_MS`, pool sizes, shedding limits | Environment, defaults in the schema |
| Feature switches | `FEATURE_SSO` | Environment, booleans that default to `false` |
| Product rules | Password length, a token lifetime that must match everywhere | Constants in code |

A value that must be the same in every deploy is not configuration. Make it a constant, so staging
tests what production runs.

## Rules

- **One schema, one read.** The composition root (the `config` plugin, or `main.ts` of your own
  entry) calls `loadConfig(process.env)` once. Every module gets its slice through options or
  `fastify.config`. A `process.env` read inside a service, a repository or a route is a bug.
- **Fail fast with every issue.** An invalid or missing value stops the process before it listens,
  with all issues in one message. Never start with a partial config, never fall back silently.
- **No `NODE_ENV` branches.** One label then switches unrelated behaviour (log format, caching,
  error detail, CORS), staging is "production" or not by accident, and tests never run the
  production path. Give each behaviour its own variable: `FASTIFY_PRETTY_LOGS`, `CACHE_TTL_MS`. If a
  dependency still reads `NODE_ENV`, set it in the runtime image only (`node-deploy`), never in code.
- **No config hierarchy.** `config/default.json` plus `production.json` plus local overrides hide
  the effective value, drift apart and pull secrets into the repository. One flat list of
  variables, defaults in the schema, the platform sets the rest.
- **Names.** `SCREAMING_SNAKE_CASE`, grouped by prefix (`MONGODB_`, `REDIS_`, `SHUTDOWN_`), the unit
  in the name (`_MS`, `_BYTES`, `_COUNT`), switches as `FEATURE_*`. fastify-cli reads its own
  `FASTIFY_*` flags (`node-http-server`).
- **Parse, never compare strings.** Every variable is a string: `Number('')` is `0`, `'false'` is
  truthy, `Number(process.env.PORT) || 3000` turns a typo into port 3000. Let the schema coerce.
- **No default for a dependency or a secret.** A deploy that forgot `MONGODB_URL` must fail, not
  connect to localhost. Defaults are for tuning values only.
- **`.env` is for local development.** Commit `.env.example` with every key and fake values, and
  keep `.env` in `.gitignore` and `.dockerignore`. Run `node --env-file-if-exists=.env` locally.
  fastify-cli loads `.env` from the working directory by itself. A real variable wins over the file.
- **Secrets come from the platform**, never from a committed file or an image layer (see below).
  Pino `redact` covers every secret key, and a child process gets an explicit `env`
  (`node-security`).
- **Log a summary, never the object.** At boot, log the values of an allowlist (log level, limits,
  switches). Never `process.env`, never the whole config, never a secret.
- **Tests build config from a literal** with the same `loadConfig`. Never assign `process.env` in a
  test. If code under test reads the environment, fix the code; until then `vi.stubEnv` with
  `unstubEnvs: true`.
- **The frontend is public.** Only `VITE_*` variables reach a Vite bundle, and anyone can read them.
  No secret ever has that prefix. A value that varies per tenant comes from the API at runtime.

## The config module

```ts
// src/config.ts
import { Schema } from '@alexify/metaschema';
import type { InferOutput } from '@alexify/metaschema';
import { register as registerCoerce } from '@alexify/metaschema/coerce';
import { register as registerFormats } from '@alexify/metaschema/formats';

registerCoerce();
registerFormats();

const definition = {
  LOG_LEVEL: { enum: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'], default: 'info' },
  MONGODB_URL: { type: 'string', format: 'uri', length: { max: 2048 } },
  REDIS_URL: { type: 'string', format: 'uri', length: { max: 2048 } },
  SESSION_SECRET: { type: 'string', length: { min: 32, max: 256 } },
  SHUTDOWN_DRAIN_TIMEOUT_MS: { type: 'integer', min: 0, max: 300_000, default: 20_000 },
  FEATURE_SSO: { type: 'boolean', default: false },
} as const;

export const ConfigSchema = new Schema('Config', definition);
export type Config = InferOutput<typeof definition>;

export class ConfigError extends Error {
  readonly code = 'ALX_ERR_CONFIG';

  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const loadConfig = (env: Record<string, string | undefined>): Readonly<Config> => {
  const { valid, value, issues } = ConfigSchema.parse(env, { coerce: true, unknown: 'strip' });
  if (valid) return Object.freeze(value as Config);
  let message = 'Invalid configuration:';
  for (const issue of issues) message += `\n  ${issue.path.join('.')}: ${issue.message}`;
  throw new ConfigError(message);
};
```

- `coerce: true` turns `'8080'` into `8080` and `'true'` into `true`, and rejects `'abc'` for an
  integer. It needs `register()` of `/coerce`, and `format` needs `register()` of `/formats`.
- `unknown: 'strip'` drops the rest of the environment (`PATH`, `HOME`), so the result holds only
  declared keys.
- Nothing is read at import time, so a test imports the module without an environment.
- `InferOutput` is the parsed side: a key with a default is required in `Config`. `as const` keeps
  the enum literals in the type.
- **Require `@alexify/metaschema` `^3.4.1`.** Before it, a struct whose first key started with a
  capital letter read that key as a kind and dropped it, so an environment schema lost its first
  variable, and `Infer` left upper-case keys out of the type.

### The plugin

```ts
// plugins/config.ts
import fp from 'fastify-plugin';

import { loadConfig, type Config } from '../config.ts';

declare module 'fastify' {
  interface FastifyInstance {
    config: Readonly<Config>;
  }
}

const PUBLIC_KEYS = ['LOG_LEVEL', 'SHUTDOWN_DRAIN_TIMEOUT_MS', 'FEATURE_SSO'] as const;

export default fp(
  async (fastify) => {
    const config = loadConfig(process.env);
    fastify.decorate('config', config);
    const summary: Record<string, unknown> = {};
    for (const key of PUBLIC_KEYS) summary[key] = config[key];
    fastify.log.info({ config: summary }, 'configuration loaded');
  },
  { name: 'config' },
);
```

Other plugins declare `dependencies: ['config']` and read `fastify.config`. A worker or a CLI with
its own entry calls `loadConfig(process.env)` in `main.ts` and passes the slices on.

An app that already uses `@fastify/env` keeps it and passes
`toJSONSchema(ConfigSchema, { target: 'draft-07' })` from `/generators` as its `schema`. Its Ajv
coerces types and applies defaults. Check that it knows every `format` the schema uses.

## Secrets per environment

| Where | How |
| --- | --- |
| Local | `.env`, copied from `.env.example`, never committed |
| CI (GitHub Actions) | Environment secrets, passed as `env:` only to the step that needs them |
| Fly.io | `fly secrets set KEY=value`, which restarts the machines (`--stage` defers it). Non-secret values go in `[env]` of `fly.toml` |
| Vercel (SPA) | Project environment variables; only `VITE_*` are bundled, and they are public |

- Rotate by setting the new value and restarting. A key that signs tokens needs an overlap: accept
  `*_PREVIOUS` until old tokens expire (`node-crypto-auth`).
- A secret is never a default, never in an error message and never in a test fixture that looks
  real.

## Feature switches

- `FEATURE_*` booleans, `false` by default, read once: flipping one is a restart, per deploy.
  Use them to release finished code gradually, not to park unfinished branches for months.
- Per tenant, per user or without a restart needs a store: a collection with a cached reader, or
  a flag service. Configuration is per deploy.
- Read the switch at the edge, where plugins and services are wired, and inject the chosen
  behaviour. No `if (config.FEATURE_SSO)` scattered through domain code.
- Test both sides while the switch lives, and delete it after the rollout. A switch older than two
  releases is debt.

## Library options

```js
const DEFAULTS = Object.freeze({ timeoutMs: 5000, retries: 2 });

class OptionsError extends RangeError {
  constructor(message) {
    super(message);
    this.name = 'OptionsError';
    this.code = 'ALX_ERR_OPTIONS';
  }
}

class Client {
  constructor(options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    const retries = options.retries ?? DEFAULTS.retries;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new OptionsError('timeoutMs must be a positive integer');
    }
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }
}
```

A library documents its options in the `.d.ts`, validates them once in the constructor and never
reads the environment. An invalid option throws the library's own class with a code, which may
extend `RangeError` or `TypeError` so `instanceof` keeps working (`error-handling`). The app maps its
config onto those options in a plugin.

## Anti-patterns

- `process.env.X` inside a service, a repository or a route.
- `if (process.env.NODE_ENV === 'production')`, or a log format chosen by `NODE_ENV`.
- `config/production.json` with values or secrets in the repository.
- `Number(process.env.PORT) || 3000`, `process.env.FEATURE_X === 'true'` spread across files.
- A default `MONGODB_URL` of `mongodb://localhost`.
- Logging `process.env` or the config object.
- `.env` copied into an image, or a secret baked in with `ARG` or `ENV`.
- An environment schema on `@alexify/metaschema` older than 3.4.1, which drops its first variable.
- `process.env` assigned in a test.

## Checklist

- [ ] One schema in `src/config.ts`, parsed once at boot with `coerce` and `unknown: 'strip'`.
- [ ] The process exits before listening when a value is missing or invalid, with every issue listed.
- [ ] `Config` is `InferOutput` of the definition, on `@alexify/metaschema` 3.4.1 or later.
- [ ] No `process.env` outside the composition root, no `NODE_ENV` in code.
- [ ] Dependencies and secrets have no defaults; tuning values do.
- [ ] `.env.example` lists every key; `.env` is ignored by git and Docker.
- [ ] Secrets come from the platform and are redacted in logs.
- [ ] The boot log shows the allowlisted values only.
- [ ] Every feature switch has an owner and a removal date.

Related skills: `node-http-server`, `node-security`, `node-deploy`, `js-contracts-schemas`,
`alexis-libraries`, `node-tooling-testing`
