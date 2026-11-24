# Native protocols are contracts

JavaScript has interfaces without the keyword: callable, callback-last-error-first `(error, result)`,
thenable `then(onFulfilled, onRejected)`, iterable `[Symbol.iterator]()`, async iterable
`[Symbol.asyncIterator]()`, iterator `next()` returning `{ value, done }` plus optional `return()` and
`throw()`, disposable `[Symbol.dispose]()` and `[Symbol.asyncDispose]()`, `EventTarget`,
`EventEmitter`, streams, array-like, transferable. Conformance is checked by tests, not by
declaration. Runnable code per protocol is in `js-multiparadigm`
(references/native-contracts.md), async conversions in `js-async-patterns`.

## Rules

- Implement the whole protocol: iterators that hold resources implement `return()` so `break` or
  `throw` in `for...of` and `for await` releases them. Resources implement `Symbol.asyncDispose` so
  callers can write `await using` (Node.js 24).
- Any object with a `then` method is assimilated by `await` and `Promise.resolve`. Use that
  deliberately (lazy query builders) and never put a `then` property on data objects or modules.
- Promises satisfy the thenable contract. A thenable is not a full promise (`catch` and `finally` are
  absent): wrap it with `Promise.resolve(value)` when needed.
- A callback is either always synchronous or always asynchronous, never sometimes each.

## Async iterator that releases its source

```js
const pages = (fetchPage) => ({
  [Symbol.asyncIterator]() {
    let page = 0;
    let isClosed = false;
    return {
      async next() {
        if (isClosed) return { value: undefined, done: true };
        const items = await fetchPage(page++);
        if (items.length === 0) isClosed = true;
        return { value: isClosed ? undefined : items, done: isClosed };
      },
      async return() {
        isClosed = true;
        return { value: undefined, done: true };
      },
    };
  },
});

for await (const items of pages(loadPage)) {
  if (handle(items) === 'enough') break; // calls return()
}
```

The iterator always returns the same `{ value, done }` shape. If it holds a cursor, socket or file
handle, close it in `return()`. An `async` generator gets this for free with
`try { ... } finally { close() }`.

## Lazy thenable query builder

```js
class Query {
  #run;
  #where = {};

  constructor(run) {
    this.#run = run;
  }

  where(conditions) {
    Object.assign(this.#where, conditions);
    return this;
  }

  then(onFulfilled, onRejected) {
    return this.#run({ ...this.#where }).then(onFulfilled, onRejected);
  }
}

const rows = await new Query(runQuery).where({ id: 1 });
```

Nothing runs until `await` or `then`. Do not add `then` to anything meant to be passed around as a
value, since `await` will call it.

## Disposable resource (`await using`, Node.js 24)

```js
const openLease = async (pool) => {
  const connection = await pool.acquire();
  return {
    run: (command) => connection.run(command),
    async [Symbol.asyncDispose]() {
      await pool.release(connection);
    },
  };
};

const countUsers = async (pool) => {
  await using lease = await openLease(pool);
  const { total } = await lease.run({ count: 'users' });
  return total;
}; // released here even if the command throws
```

The mongodb 7 `ClientSession` has `Symbol.asyncDispose`, so `await using session = client.startSession()`
ends the session. It does not commit or abort a transaction for you: use `withTransaction`.

Related skills: `js-multiparadigm`, `js-async-patterns`
