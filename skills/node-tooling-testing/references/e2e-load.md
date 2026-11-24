# App E2E and load tests: Playwright, autocannon, k6

Reference for `node-tooling-testing`, App profile. Both sit at the top of the pyramid: few, slow and
reserved for what unit and integration tests cannot prove. E2E checks a user journey through the
SPA and the API. Load tests answer how fast, how many and for how long, never whether the result
is correct.

## Playwright

Specs live in the app's `e2e/` as `*.e2e.ts`, on Playwright's own runner. The naming rules still
hold: `test.describe` names the journey, and every `test` title starts with `should`.

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

const isCi = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  reporter: isCi ? 'github' : 'html',
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173', trace: 'on-first-retry' },
  projects: [
    { name: 'setup', testMatch: '**/*.setup.ts' },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/user.json' },
      dependencies: ['setup'],
    },
  ],
});
```

### Locators and assertions

- Query as the user sees the page: `getByRole`, `getByLabel`, `getByText`. Add `data-testid` and
  `getByTestId` only for an anchor with no role or label. Never CSS classes or XPath.
- Use web-first assertions (`toBeVisible`, `toHaveText`, `toHaveURL`): they retry until the
  condition holds. `page.waitForTimeout()` is banned, it is the first source of flakes.
- Scope with chaining: `page.getByRole('row').filter({ hasText: 'marcus@example.com' })`.

```ts
import { expect, test } from '@playwright/test';

test.describe('sign-in', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('should show an error for a wrong password', async ({ page }) => {
    // Arrange
    await page.goto('/sign-in');

    // Act
    await page.getByLabel('Email').fill('marcus@example.com');
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Assert
    await expect(page.getByRole('alert')).toHaveText(/invalid credentials/i);
  });
});
```

### Sign in once

Every test gets a fresh browser context. Sign in once in a setup project, save the session with
`storageState`, and let the other projects depend on it. The sign-in journey itself runs with an
empty state, as above. Keep `e2e/.auth/` in `.gitignore`.

```ts
// e2e/auth.setup.ts
import { expect, test as setup } from '@playwright/test';

setup('should sign in the suite user', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env.E2E_USER_EMAIL ?? '');
  await page.getByLabel('Password').fill(process.env.E2E_USER_PASSWORD ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.context().storageState({ path: 'e2e/.auth/user.json' });
});
```

Seed users through the API or a fixture, never through another test.

### Third parties

Never call a service you do not own (an identity provider, email links, analytics). Answer it with
`page.route`:

```ts
await page.route('**/idp.example.com/token', (route) =>
  route.fulfill({ json: { access_token: 'fake', id_token: 'fake' } }),
);
```

### CI

- Linux runners, the projects of the config, `trace: 'on-first-retry'` for CI-only failures.
- Two retries absorb an infrastructure blip. A test that needs retries locally is broken.
- `--shard=1/4` splits a growing suite across machines.
- Run E2E in the pipeline (an `e2e` target), not on every local commit.

## Load tests

Scripts live in the app's `load/`, target a deployed instance (staging, never the in-process app)
through `BASE_URL`, and take credentials from the environment. No hard-coded host or password.

| Need | Tool |
| --- | --- |
| One endpoint, quickly, from a Node script or CI | autocannon |
| A pass/fail gate on p99 for one endpoint | autocannon, reading `result.latency.p99` |
| Ramping stages, several scenarios, think time | k6 |
| Thresholds as a pipeline gate with rich percentiles | k6 |

### autocannon

```js
// load/sessions.js: an ES module, like the rest of the app
import autocannon from 'autocannon';

const SLO_P99_MS = 200;

const result = await autocannon({
  url: `${process.env.BASE_URL}/v1/sessions`,
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.LOAD_USER_EMAIL, password: process.env.LOAD_USER_PASSWORD }),
  connections: 50,
  duration: 30,
  warmup: { connections: 5, duration: 3 },
});
const { p99 } = result.latency;
console.log({ p99, rps: result.requests.average, non2xx: result.non2xx, errors: result.errors });
if (p99 > SLO_P99_MS || result.non2xx > 0 || result.errors > 0) process.exitCode = 1;
```

- `result.latency`, `result.requests` and `result.throughput` carry `average`, `p50`, `p99`; there
  are also `errors`, `timeouts`, `non2xx` and `statusCodeStats`.
- The `requests` option scripts a multi-step flow, and `workers` keeps the generator from being the
  bottleneck at high concurrency.

### k6

k6 is a separate binary with its own runtime, not an npm package. `options` holds the workload,
the default function holds the requests, and a failed threshold exits non-zero.

```js
// load/sessions.k6.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '1m', target: 50 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300', 'p(99)<500'],
  },
};

export default () => {
  const body = JSON.stringify({ email: __ENV.LOAD_USER_EMAIL, password: __ENV.LOAD_USER_PASSWORD });
  const params = { headers: { 'Content-Type': 'application/json' } };
  const response = http.post(`${__ENV.BASE_URL}/v1/sessions`, body, params);
  check(response, { 'status is 201': (result) => result.status === 201 });
  sleep(1);
};
```

Run it with `k6 run -e BASE_URL=https://staging.example.com load/sessions.k6.js`. Keep the shape
simple (ramp up, plateau, ramp down) so a regression is easy to place.

### Profiles

| Profile | Question | Shape | When |
| --- | --- | --- | --- |
| Smoke | Does the script work, is the baseline healthy? | 1-5 VUs, seconds | Every change to the script |
| Average load | How does normal traffic behave? | Ramp to typical VUs, hold 5-60 min | Before a release |
| Stress | What happens above the expected peak? | Ramp above average, hold | Before a release |
| Soak | Does it stay healthy for hours (leaks, pools)? | Average load, hours | Nightly or weekly |
| Spike | Does it survive a surge and recover? | A jump to many VUs, briefly | Before an event |
| Breakpoint | Where is the ceiling? | Ramp until it fails | When sizing capacity |

- Warm up before measuring, and report p95 and p99, not averages.
- A load test is a gate (`process.exitCode`, k6 thresholds), or nobody reads it.
- Record the instance size, replica count and Node.js version with every result.
