const assert = require('node:assert');
const { test } = require('node:test');

const { packProblems } = require('../../scripts/check-pack.js');

const MANIFEST = { bin: { metaskills: './bin/metaskills.js' } };
const SKILLS = ['alpha'];
const FILES = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'SECURITY.md',
  'bin/metaskills.js',
  'src/link.js',
  'skills/alpha/SKILL.md',
  'skills/alpha/examples/one.js',
];

test('packProblems passes a complete tarball', () => {
  assert.deepStrictEqual(packProblems(FILES, MANIFEST, SKILLS), []);
});

test('packProblems reports a missing bin, document or skill', () => {
  const missing = ['bin/metaskills.js', 'LICENSE', 'skills/alpha/SKILL.md'];
  const files = FILES.filter((file) => !missing.includes(file));
  const problems = packProblems(files, MANIFEST, SKILLS);
  for (const file of missing) assert.ok(problems.includes(`${file} is missing from the tarball`));
});

test('packProblems reports a file outside the allowlist', () => {
  const extra = ['tests/unit/link.test.js', 'scripts/size.js', 'evals/run.js', 'CLAUDE.md'];
  const problems = packProblems(FILES.concat(extra), MANIFEST, SKILLS);
  for (const file of extra) assert.ok(problems.includes(`${file} should not be in the tarball`));
});
