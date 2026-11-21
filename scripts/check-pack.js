/**
 * Checks the files `pnpm publish` would pack, run by `prepublishOnly` and in CI: the tarball must
 * hold the CLI, the documents and every skill, and nothing the `files` allowlist is meant to keep
 * out (tests, docs, scripts, evals, the repository's tooling).
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { listSkills } = require('../src/link.js');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const DOCUMENTS = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'SECURITY.md'];
const PACK_LIST = 'src/packs.json';
const ALLOWED =
  /^(?:bin\/alexify-metaskills\.js|src\/link\.js|src\/packs\.json|skills\/[a-z0-9-]+\/.+\.(?:md|js)|package\.json|README\.md|CHANGELOG\.md|LICENSE|SECURITY\.md)$/;

const packProblems = (files, manifest, skills) => {
  const required = new Set(DOCUMENTS);
  required.add(PACK_LIST);
  const bins = Object.values(manifest.bin);
  for (let i = 0; i < bins.length; i++) required.add(path.posix.normalize(bins[i]));
  for (let i = 0; i < skills.length; i++) required.add(`skills/${skills[i]}/SKILL.md`);
  const packed = new Set(files);
  const problems = [];
  for (const file of required) {
    if (!packed.has(file)) problems.push(`${file} is missing from the tarball`);
  }
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!ALLOWED.test(file)) problems.push(`${file} should not be in the tarball`);
  }
  return problems;
};

const packedFiles = () => {
  const output = execFileSync('pnpm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return JSON.parse(output).files.map((file) => file.path);
};

if (require.main === module) {
  const files = packedFiles();
  const skills = listSkills(path.join(ROOT, 'skills'));
  const problems = packProblems(files, pkg, skills);
  for (let i = 0; i < problems.length; i++) console.error(problems[i]);
  if (problems.length > 0) process.exitCode = 1;
  else console.log(`The tarball holds the ${files.length} files it should.`);
}

module.exports = { packProblems };
