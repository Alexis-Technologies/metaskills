# Module internals, custom loaders and hooks

Reference for `node-modules-packages`. Behaviour checked on Node.js 24.14.

## CommonJS: what `require(name)` does

1. Built-in? `node:` names (and unprefixed built-in names) return the
   built-in. `module.isBuiltin(name)` answers this.
2. Resolve to an absolute filename:
   - `./`, `../`, `/` → try the file as is, then `.js`, `.json`, `.node`,
     then a directory (`package.json` `main`, then `index.js`).
   - `#name` → the nearest `package.json` `imports` map.
   - bare name → the package's own name (self-reference via `exports`), then
     `node_modules/<name>` in the current directory and every parent up to
     the root (`module.paths` shows the list). If the package has `exports`,
     only paths listed there are reachable.
3. `require.cache[filename]` hit → return its `exports` (no re-execution).
4. Otherwise create a `Module`, put it into the cache before running it
   (this is what makes cycles return partial exports), load by extension:
   `.json` is parsed, `.node` goes to `process.dlopen`, `.js`/`.cjs` source
   is wrapped and compiled:

   ```js
   (function (exports, require, module, __filename, __dirname) {
     // module source
   });
   ```

5. The function runs once; `module.exports` is the result for everyone.

Useful introspection:

```js
const resolved = require.resolve('./lib/user.js');
const record = require.cache[resolved];
console.log(record.id, record.loaded, record.children.length);
console.log(module.paths);
```

`delete require.cache[resolved]` makes the next `require` execute the file
again, but modules that already hold the old exports keep them. Use it only
in development demos of hot reload.

## Singletons, global pollution and monkey patching

- `require` always returns the same object, so these two modules share
  state without saying so:

  ```js
  // module1.js
  const library = require('./library.js');
  library.value = 100;
  library.f3 = (x) => library.value + x;
  ```

  Any other file that requires `library.js` now sees `value` and `f3`: global
  context pollution. Same for built-ins: wrapping `fs.readFile` in one place
  intercepts it for the whole process, including dependencies.

- Defences: freeze what you export (in sloppy CommonJS a write to a frozen
  object fails silently), review dependencies for patching and prototype
  pollution, and pass collaborators explicitly.

## Circular dependencies

- CommonJS: the second module gets the first module's exports as they are
  at that moment (often `{}`), and Node warns `Accessing non-existent
property 'x' of module exports inside circular dependency`.
- ESM: bindings exist but are uninitialised until the exporter has run;
  using them at evaluation time throws
  `ReferenceError: Cannot access 'x' before initialization`. Using them later
  (inside functions called after loading) works.
- Fix by moving the shared code into its own module, inverting the
  dependency (pass it as a function argument), or merging two modules that
  are really one.

## ES modules

- Phases: resolve (URL), load (source + format), link (bind imports to
  exports), evaluate (run, possibly with top-level `await`).
- Format is decided by extension (`.mjs`, `.cjs`), the nearest
  `package.json` `"type"`, or syntax detection for typeless `.js` (costs a
  reparse and warns when a `package.json` exists without `"type"`).
- ESM and CJS keep separate caches, but importing a CommonJS file goes
  through the CJS loader, so `import x from './a.cjs'` and
  `require('./a.cjs')` return the same object. Built-ins are the same object
  either way.
- `import.meta`: `url`, `dirname`, `filename`, `resolve(specifier)`.
  `import.meta.main` may not exist on your target version; check before use.
- Dynamic `import()` works in both systems and returns a promise of the
  namespace; a CommonJS module's `module.exports` is the `default` key.

## require(esm)

- Enabled by default in Node 20.19+, 22.12+, 23+. `require()` returns the
  namespace object (`__esModule: true`, named exports, `default`).
- An ESM graph with top-level `await` cannot be required:
  `ERR_REQUIRE_ASYNC_MODULE`. Use `await import()` instead.
- `export { value as 'module.exports' }` makes `require()` return `value`
  directly (useful when an ESM package replaces a CommonJS one whose
  consumers do `const Client = require('client')`).
- `--trace-require-module=all` prints where `require(esm)` is used.

## `node:vm` is not a sandbox

Do not build a module loader on `node:vm` for application code: wire it with
a composition root or Fastify plugins. `node:vm` is not a security boundary
for hostile code (the Node docs say so). Objects from another context fail
`instanceof` against your realm's classes, and `timeout` interrupts only
synchronous execution.

## Module customisation hooks

- `module.registerHooks({ resolve, load })` (synchronous, in-thread; Node
  22.15+/23.5+) and `module.register(url)` (asynchronous, off-thread) change
  how specifiers resolve and how sources load. Preload them with
  `node --import ./hooks.js app.js`.
- Use hooks for tooling (virtual modules, transpilers, test mocks,
  instrumentation), not for application logic.

```js
const { registerHooks } = require('node:module');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'virtual:config') {
      return { url: 'virtual:config', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual:config') {
      const source = 'export default { port: 8000 };';
      return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
```

## Error codes

| Code                                                       | Meaning / usual fix                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `MODULE_NOT_FOUND`                                         | `require` could not resolve; check path, extension, install              |
| `ERR_MODULE_NOT_FOUND`                                     | `import` could not resolve; ESM needs full relative paths with extension |
| `ERR_PACKAGE_PATH_NOT_EXPORTED`                            | subpath not in the package's `exports`; use a public entry               |
| `ERR_REQUIRE_ESM`                                          | old Node (< 20.19 / 22.12) requiring ESM; upgrade or use `import()`      |
| `ERR_REQUIRE_ASYNC_MODULE`                                 | required ESM graph has top-level `await`; use `import()`                 |
| `ERR_UNKNOWN_FILE_EXTENSION`                               | ESM loader cannot handle extension (e.g. `.ts` on old Node)              |
| `ERR_IMPORT_ATTRIBUTE_MISSING`                             | JSON import without `with { type: 'json' }`                              |
| `MODULE_TYPELESS_PACKAGE_JSON` (warning)                   | add `"type"` to `package.json`                                           |
| `ReferenceError: module is not defined in ES module scope` | CommonJS code in an ESM file; use ESM syntax or `.cjs`                   |

A confusing case: a CommonJS file without `"type"` that declares a
top-level `const module` (or `exports`, `require`) is a `SyntaxError` as
CommonJS (`Identifier 'module' has already been declared`), so syntax
detection retries it as ESM and you get `require is not defined in ES module
scope` instead. Rename the variable (`wasmModule`) and set `"type"`.
