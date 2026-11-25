# Extended examples

All blocks ran on Node.js 24. Native protocol examples are in
[native-protocols.md](native-protocols.md), the schema consumers in
[validation-chain.md](validation-chain.md).

## Contract test for several implementations

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const storageContract = (name, create) => {
  describe(`${name} storage`, () => {
    it('should get the value after set', async () => {
      const storage = await create();
      await storage.set('a', 1);
      assert.equal(await storage.get('a'), 1);
    });

    it('should never call back synchronously', async () => {
      const storage = await create();
      let isSync = true;
      const pending = storage.get('missing').then(() => {
        assert.equal(isSync, false);
      });
      isSync = false;
      await pending;
    });
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
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Schema } = require('@alexify/metaschema');
const { sample } = require('@alexify/metaschema/model');

const Point = Schema.from({ x: 'number', y: 'number' });

describe('Point', () => {
  it('should accept a generated value and refuse an unknown key', () => {
    const value = sample(Point);
    assert.equal(Point.check(value).valid, true);
    const { issues } = Point.check({ ...value, isAdmin: true });
    assert.equal(issues[0].code, 'unexpected');
  });
});
```
