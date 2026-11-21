// skill: must be invoked before the first file edit
// noSkill: must not be invoked at all
// read: a Read call path must contain this fragment
// files: per written file, patterns it must contain and must not contain
const DESTRUCTURING = /\b(const|let|var)\s*\[|\(\s*\[[\w\s,]*\]\s*\)\s*=>/;

const CASES = [
  {
    name: 'conventions-object-walk',
    prompt:
      'Create src/headers.js (CommonJS library module) exporting ' +
      'applyHeaders(res, headers) that sets every header from a plain ' +
      'headers object on res.',
    skill: 'js-conventions',
    files: {
      'src/headers.js': {
        require: [/Object\.keys/],
        forbid: [/'use strict'/, /Object\.entries/, DESTRUCTURING, /\.forEach\(/],
      },
    },
  },
  {
    name: 'conventions-split',
    prompt:
      'Create src/version.js (CommonJS module) exporting parseVersion(text) ' +
      'that returns { major, minor, patch } numbers from x.y.z text.',
    skill: 'js-conventions',
    files: {
      'src/version.js': {
        require: [/module\.exports/],
        forbid: [DESTRUCTURING, /\bvar\b/, /\blet \w+;/],
      },
    },
  },
  {
    name: 'gof-object-pool',
    prompt:
      'Implement an object pool for reusable Buffer instances in ' +
      'src/pool.js (CommonJS), following the design pattern skills.',
    skill: 'js-gof',
    read: 'object-pool',
    files: {
      'src/pool.js': {
        require: [/acquire/, /release/],
        forbid: [/setPrototypeOf/, /(?<![.\w])delete\s+[\w$]/],
      },
    },
  },
  {
    name: 'data-structures-ring',
    prompt:
      'Implement a fixed-capacity ring buffer class RingBuffer in ' +
      'src/ring.js (CommonJS) with write(item) and read() methods.',
    skill: 'js-data-structures',
    files: {
      'src/ring.js': {
        require: [/null/],
        forbid: [/new Array\([^)]*\)(?!\.fill)/, /return undefined/],
      },
    },
  },
  {
    name: 'error-retry',
    prompt:
      'Write src/retry.js (CommonJS) exporting retry(fn, options) that ' +
      'retries transient failures with exponential backoff.',
    skill: 'error-handling',
    files: {
      'src/retry.js': {
        require: [/\*\*|Math\.pow\(/],
        forbid: [/catch \(err\)/],
      },
    },
  },
  {
    name: 'contracts-single-source',
    prompt:
      'Create src/user.schema.js (CommonJS) that defines the User contract of an Alexis library ' +
      'with login, email and age, and exports its JSON Schema for a Fastify route.',
    skill: 'js-contracts-schemas',
    files: {
      'src/user.schema.js': {
        require: [/@alexify\/metaschema/, /toJSONSchema/],
        forbid: [/require\('zod'\)/, /Type\.Object/],
      },
    },
  },
  {
    name: 'concurrency-map-limit',
    prompt:
      'Write src/map-limit.js (CommonJS) exporting mapLimit(items, limit, fn) that runs an async ' +
      'function over items with bounded concurrency and keeps the order of the results.',
    skill: 'js-async-concurrency',
    files: {
      'src/map-limit.js': {
        require: [/module\.exports/],
        forbid: [DESTRUCTURING, /\.forEach\(/, /\.map\(/],
      },
    },
  },
  {
    name: 'data-access-optimistic-update',
    prompt:
      'Write src/orders.repository.js (CommonJS) with a repository over the native mongodb driver ' +
      'whose rename(cuid, rev, name) method must not lose a concurrent update.',
    skill: 'node-data-access',
    files: {
      'src/orders.repository.js': {
        require: [/\brev\b/, /matchedCount|modifiedCount/],
        forbid: [/__rev/, /mongoose/, /prisma/i],
      },
    },
  },
  {
    name: 'crypto-password-hash',
    prompt:
      'Write src/password.js (CommonJS) exporting hashPassword and verifyPassword for storing ' +
      'user passwords with node:crypto.',
    skill: 'node-crypto-auth',
    files: {
      'src/password.js': {
        require: [/timingSafeEqual/, /scrypt|argon2/],
        forbid: [/createHash\('(?:md5|sha1|sha256)'\)/],
      },
    },
  },
  {
    name: 'realtime-wrpc-router',
    prompt:
      'Write src/chat.js (CommonJS) with a realtime chat router on @alexify/wrpc where only ' +
      'members of a room can send to it.',
    skill: 'node-websocket-realtime',
    files: {
      'src/chat.js': {
        require: [/@alexify\/wrpc/, /defineRouter/],
        forbid: [/metacom/],
      },
    },
  },
  {
    name: 'npm-publish-manual-only',
    prompt: 'In two sentences, what does `npm pack --dry-run` show?',
    noSkill: 'npm-publish',
    files: {},
  },
];

module.exports = { CASES };
