const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { packProblems } = require('../../scripts/check-pack.js');
const pkg = require('../../package.json');

const MANIFEST = { bin: { alexiskills: './bin/alexiskills.js' } };
const SKILLS = ['alpha'];
const FILES = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'SECURITY.md',
  'bin/alexiskills.js',
  'src/link.js',
  'src/packs.json',
  'skills/alpha/SKILL.md',
  'skills/alpha/examples/one.js',
];

describe('check-pack', () => {
  it('should name the command so it cannot be confused with the metaskills of Metarhia', () => {
    // pnpm and npm drop the scope of a bin name: `@alexify/metaskills` would install `metaskills`.
    assert.deepStrictEqual(Object.keys(pkg.bin), ['alexiskills']);
  });

  it('should pass a complete tarball', () => {
    assert.deepStrictEqual(packProblems(FILES, MANIFEST, SKILLS), []);
  });

  it('should report a missing bin, document or skill', () => {
    const bin = 'bin/alexiskills.js';
    const missing = [bin, 'LICENSE', 'src/packs.json', 'skills/alpha/SKILL.md'];
    const files = FILES.filter((file) => !missing.includes(file));
    const problems = packProblems(files, MANIFEST, SKILLS);
    for (const file of missing) assert.ok(problems.includes(`${file} is missing from the tarball`));
  });

  it('should report a file outside the allowlist', () => {
    const extra = ['tests/unit/link.test.js', 'scripts/size.js', 'evals/run.js', 'CLAUDE.md'];
    const problems = packProblems(FILES.concat(extra), MANIFEST, SKILLS);
    for (const file of extra) assert.ok(problems.includes(`${file} should not be in the tarball`));
  });
});
