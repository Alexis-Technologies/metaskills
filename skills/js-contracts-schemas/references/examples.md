# Extended examples

All blocks ran on Node.js 24. Native protocol examples are in
[native-protocols.md](native-protocols.md), the schema consumers in
[validation-chain.md](validation-chain.md).

## Contract test for several implementations

```js
const { test } = require('node:test');
const assert = require('node:assert');

const storageContract = (name, create) => {
  test(`${name}: get after set`, async () => {
    const storage = await create();
    await storage.set('a', 1);
    assert.strictEqual(await storage.get('a'), 1);
  });

  test(`${name}: callback is never synchronous`, async () => {
    const storage = await create();
    let isSync = true;
    const pending = storage.get('missing').then(() => {
      assert.strictEqual(isSync, false);
    });
    isSync = false;
    await pending;
  });
};

storageContract('memory', async () => {
  const data = new Map();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
  };
});
```

Run the same suite against the in-memory fake and the real adapter (a repository over the native
driver, Redis) so the fake cannot drift from the contract.

## Schema-driven negative tests

One definition also generates the fixtures, so a test does not restate the shape:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { Schema } = require('@alexify/metaschema');
const { sample } = require('@alexify/metaschema/model');

const Point = Schema.from({ x: 'number', y: 'number' });

test('accepts a generated value and refuses an unknown key', () => {
  const value = sample(Point);
  assert.strictEqual(Point.check(value).valid, true);
  const { issues } = Point.check({ ...value, isAdmin: true });
  assert.strictEqual(issues[0].code, 'unexpected');
});
```
