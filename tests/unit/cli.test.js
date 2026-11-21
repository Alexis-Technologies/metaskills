const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const BIN = path.resolve(__dirname, '../../bin/metaskills.js');
const PACKAGE_SKILLS = path.join('node_modules', '@alexify', 'metaskills', 'skills');

const createProject = (isInstalled = true) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metaskills-cli-'));
  if (isInstalled) {
    const skillPath = path.join(root, PACKAGE_SKILLS, 'alpha');
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# alpha\n');
  }
  return root;
};

const removeProject = (root) => {
  fs.rmSync(root, { recursive: true, force: true });
};

const runCli = (root, args = [], options = {}) => {
  const env = { ...process.env, ...options.env };
  if (!options.env?.LINK_IDE) delete env.LINK_IDE;
  const input = options.input ?? '';
  return spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, input, encoding: 'utf8' });
};

const isLinked = (root, target) => {
  const manifest = path.join(root, target, 'alpha', 'SKILL.md');
  return fs.lstatSync(path.join(root, target)).isSymbolicLink() && fs.existsSync(manifest);
};

test('without the package it prints a hint and installs nothing', () => {
  const root = createProject(false);
  try {
    const result = runCli(root, ['claude']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /pnpm add -D @alexify\/metaskills/);
    assert.strictEqual(fs.existsSync(path.join(root, 'node_modules')), false);
    assert.strictEqual(fs.existsSync(path.join(root, '.claude')), false);
  } finally {
    removeProject(root);
  }
});

test('an IDE argument links its directory, in any case', () => {
  const root = createProject();
  try {
    const result = runCli(root, ['CLAUDE']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Linked \.claude\/skills/);
    assert.ok(isLinked(root, '.claude/skills'));
  } finally {
    removeProject(root);
  }
});

test('LINK_IDE selects the IDE', () => {
  const root = createProject();
  try {
    const result = runCli(root, [], { env: { LINK_IDE: 'cursor' } });
    assert.strictEqual(result.status, 0);
    assert.ok(isLinked(root, '.cursor/skills'));
  } finally {
    removeProject(root);
  }
});

test('all links every IDE', () => {
  const root = createProject();
  try {
    const result = runCli(root, ['all']);
    assert.strictEqual(result.status, 0);
    const targets = ['.cursor', '.claude', '.windsurf', '.github', '.gemini', '.agents'];
    for (const target of targets) assert.ok(isLinked(root, `${target}/skills`));
  } finally {
    removeProject(root);
  }
});

test('an unknown IDE fails, a name from Object.prototype too', () => {
  const root = createProject();
  try {
    for (const name of ['nope', 'constructor', '__proto__']) {
      const result = runCli(root, [name]);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /Unknown ide/);
    }
  } finally {
    removeProject(root);
  }
});

test('autodetect links the IDE directories that exist', () => {
  const root = createProject();
  try {
    fs.mkdirSync(path.join(root, '.windsurf'));
    const result = runCli(root);
    assert.strictEqual(result.status, 0);
    assert.ok(isLinked(root, '.windsurf/skills'));
    assert.strictEqual(fs.existsSync(path.join(root, '.claude')), false);
  } finally {
    removeProject(root);
  }
});

test('.github counts as an IDE only with a skills directory', () => {
  const root = createProject();
  try {
    fs.mkdirSync(path.join(root, '.github'));
    const menu = runCli(root);
    assert.strictEqual(menu.status, 1);
    assert.match(menu.stdout, /Select IDE/);
    fs.mkdirSync(path.join(root, '.github', 'skills'));
    const result = runCli(root);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Linked \.github\/skills/);
  } finally {
    removeProject(root);
  }
});

test('the menu links the chosen IDE', () => {
  const root = createProject();
  try {
    const result = runCli(root, [], { input: '2\n' });
    assert.strictEqual(result.status, 0);
    assert.ok(isLinked(root, '.claude/skills'));
  } finally {
    removeProject(root);
  }
});

test('the last menu item links every IDE', () => {
  const root = createProject();
  try {
    const result = runCli(root, [], { input: '7\n' });
    assert.strictEqual(result.status, 0);
    assert.ok(isLinked(root, '.agents/skills'));
  } finally {
    removeProject(root);
  }
});

test('an invalid menu answer or a closed stdin fails', () => {
  const root = createProject();
  try {
    for (const input of ['9\n', 'abc\n', '']) {
      const result = runCli(root, [], { input });
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /Invalid choice/);
    }
  } finally {
    removeProject(root);
  }
});

test('a link that cannot be created fails with its target', () => {
  const root = createProject();
  try {
    fs.writeFileSync(path.join(root, '.cursor'), 'a file');
    const result = runCli(root, ['cursor']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Failed to link \.cursor\/skills/);
  } finally {
    removeProject(root);
  }
});

test('the link is added to the ignore files once', () => {
  const root = createProject();
  try {
    const gitignore = path.join(root, '.gitignore');
    const npmignore = path.join(root, '.npmignore');
    fs.writeFileSync(gitignore, 'node_modules');
    fs.writeFileSync(npmignore, '');
    runCli(root, ['claude']);
    runCli(root, ['claude']);
    assert.strictEqual(fs.readFileSync(gitignore, 'utf8'), 'node_modules\n.claude/skills\n');
    assert.strictEqual(fs.readFileSync(npmignore, 'utf8'), '.claude/skills\n');
  } finally {
    removeProject(root);
  }
});

test('a skipped target stays out of the ignore files', () => {
  const root = createProject();
  try {
    const gitignore = path.join(root, '.gitignore');
    fs.writeFileSync(gitignore, '');
    const own = path.join(root, '.claude', 'skills', 'mine');
    fs.mkdirSync(own, { recursive: true });
    const result = runCli(root, ['claude']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /not a symlink; skip/);
    assert.strictEqual(fs.readFileSync(gitignore, 'utf8'), '');
  } finally {
    removeProject(root);
  }
});

const PACKS = { core: ['alpha'], design: ['beta'], security: ['gamma'] };
const TARGET = '.claude/skills';

const createPackProject = (packs = PACKS) => {
  const root = createProject();
  const packagePath = path.dirname(path.join(root, PACKAGE_SKILLS));
  for (const name of ['beta', 'gamma']) {
    const skillPath = path.join(root, PACKAGE_SKILLS, name);
    fs.mkdirSync(skillPath);
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), `# ${name}\n`);
  }
  fs.mkdirSync(path.join(packagePath, 'src'));
  fs.writeFileSync(path.join(packagePath, 'src', 'packs.json'), JSON.stringify(packs));
  return root;
};

const linkedNames = (root) => fs.readdirSync(path.join(root, TARGET)).sort();

const isDirectoryOfLinks = (root) => {
  const targetPath = path.join(root, TARGET);
  if (!fs.lstatSync(targetPath).isDirectory()) return false;
  return fs
    .readdirSync(targetPath)
    .every((name) => fs.lstatSync(path.join(targetPath, name)).isSymbolicLink());
};

test('--pack links core and the chosen packs, in both spellings', () => {
  for (const args of [
    ['claude', '--pack', 'design'],
    ['claude', '--pack=design'],
    ['--pack', 'DESIGN', 'claude'],
  ]) {
    const root = createPackProject();
    try {
      const result = runCli(root, args);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Linked \.claude\/skills \(2 skills\)/);
      assert.deepStrictEqual(linkedNames(root), ['alpha', 'beta']);
      assert.ok(isDirectoryOfLinks(root));
      assert.ok(fs.existsSync(path.join(root, TARGET, 'beta', 'SKILL.md')));
    } finally {
      removeProject(root);
    }
  }
});

test('--pack takes a list and can repeat', () => {
  const root = createPackProject();
  try {
    const result = runCli(root, ['claude', '--pack', 'design', '--pack=security']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(linkedNames(root), ['alpha', 'beta', 'gamma']);
    const again = runCli(root, ['claude', '--pack', 'design,security']);
    assert.match(again.stdout, /Already linked/);
  } finally {
    removeProject(root);
  }
});

test('--pack works with LINK_IDE and autodetect', () => {
  const root = createPackProject();
  try {
    const byEnv = runCli(root, ['--pack', 'design'], { env: { LINK_IDE: 'cursor' } });
    assert.strictEqual(byEnv.status, 0, byEnv.stderr);
    assert.ok(fs.existsSync(path.join(root, '.cursor/skills/beta/SKILL.md')));
    const detected = runCli(root, ['--pack', 'security']);
    assert.strictEqual(detected.status, 0, detected.stderr);
    assert.ok(fs.existsSync(path.join(root, '.cursor/skills/gamma/SKILL.md')));
    assert.strictEqual(fs.existsSync(path.join(root, '.cursor/skills/beta')), false);
  } finally {
    removeProject(root);
  }
});

test('--pack replaces our directory symlink, and all brings it back', () => {
  const root = createPackProject();
  try {
    runCli(root, ['claude']);
    assert.ok(fs.lstatSync(path.join(root, TARGET)).isSymbolicLink());
    const packed = runCli(root, ['claude', '--pack', 'design']);
    assert.strictEqual(packed.status, 0, packed.stderr);
    assert.ok(isDirectoryOfLinks(root));
    const switched = runCli(root, ['claude', '--pack', 'security']);
    assert.match(switched.stdout, /removed beta/);
    assert.deepStrictEqual(linkedNames(root), ['alpha', 'gamma']);
    const all = runCli(root, ['claude', '--pack', 'all']);
    assert.strictEqual(all.status, 0, all.stderr);
    assert.ok(fs.lstatSync(path.join(root, TARGET)).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(root, TARGET, 'beta', 'SKILL.md')));
  } finally {
    removeProject(root);
  }
});

test('a run without --pack turns a pack directory back into one symlink', () => {
  const root = createPackProject();
  try {
    runCli(root, ['claude', '--pack', 'design']);
    const result = runCli(root, ['claude']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(fs.lstatSync(path.join(root, TARGET)).isSymbolicLink());
  } finally {
    removeProject(root);
  }
});

test('--pack removes a dangling link and the legacy link', () => {
  const root = createPackProject();
  try {
    runCli(root, ['claude', '--pack', 'design']);
    const targetPath = path.join(root, TARGET);
    const sourcePath = path.join(root, PACKAGE_SKILLS);
    fs.symlinkSync(path.relative(targetPath, path.join(sourcePath, 'gone')), `${targetPath}/gone`);
    fs.symlinkSync(path.relative(targetPath, sourcePath), `${targetPath}/metaskills`);
    const result = runCli(root, ['claude', '--pack', 'design']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /removed gone, metaskills/);
    assert.deepStrictEqual(linkedNames(root), ['alpha', 'beta']);
  } finally {
    removeProject(root);
  }
});

test('--pack leaves a foreign symlink alone and fails', () => {
  const root = createPackProject();
  try {
    const other = path.join(root, 'other-skills');
    fs.mkdirSync(other);
    fs.mkdirSync(path.join(root, '.claude'));
    fs.symlinkSync(other, path.join(root, TARGET), 'dir');
    const gitignore = path.join(root, '.gitignore');
    fs.writeFileSync(gitignore, '');
    const result = runCli(root, ['claude', '--pack', 'design']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /is a symlink/);
    assert.strictEqual(fs.readlinkSync(path.join(root, TARGET)), other);
    assert.deepStrictEqual(fs.readdirSync(other), []);
    assert.strictEqual(fs.readFileSync(gitignore, 'utf8'), '');
  } finally {
    removeProject(root);
  }
});

test('--pack leaves a directory with the skills of the user alone and fails', () => {
  const root = createPackProject();
  try {
    const own = path.join(root, TARGET, 'mine');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'SKILL.md'), '# mine\n');
    const result = runCli(root, ['claude', '--pack', 'design']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /holds other files/);
    assert.deepStrictEqual(linkedNames(root), ['mine']);
  } finally {
    removeProject(root);
  }
});

test('--pack treats a link of the user into the package as their own', () => {
  const root = createPackProject();
  try {
    const targetPath = path.join(root, TARGET);
    fs.mkdirSync(targetPath, { recursive: true });
    const betaPath = path.join(root, PACKAGE_SKILLS, 'beta');
    fs.symlinkSync(path.relative(targetPath, betaPath), path.join(targetPath, 'my-alias'), 'dir');
    const result = runCli(root, ['claude', '--pack', 'design']);
    assert.strictEqual(result.status, 1);
    assert.deepStrictEqual(linkedNames(root), ['my-alias']);
  } finally {
    removeProject(root);
  }
});

test('--pack fails on a regular file at the target', () => {
  const root = createPackProject();
  try {
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, TARGET), 'a file');
    const result = runCli(root, ['claude', '--pack', 'design']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Failed to link \.claude\/skills/);
  } finally {
    removeProject(root);
  }
});

test('invalid pack options fail before anything is written', () => {
  const root = createPackProject();
  try {
    const cases = [
      [['claude', '--pack', 'nope'], /Unknown pack: nope/],
      [['claude', '--pack', 'constructor'], /Unknown pack: constructor/],
      [['claude', '--pack', '__proto__'], /Unknown pack: __proto__/],
      [['claude', '--pack', 'all,nope'], /Unknown pack: nope/],
      [['claude', '--pack'], /--pack needs a pack name/],
      [['claude', '--pack='], /--pack needs a pack name/],
      [['claude', '--pack', ','], /--pack needs a pack name/],
      [['claude', '--packs', 'design'], /Unknown option: --packs/],
    ];
    for (const [args, expected] of cases) {
      const result = runCli(root, args);
      assert.strictEqual(result.status, 1, args.join(' '));
      assert.match(result.stderr, expected);
      assert.strictEqual(fs.existsSync(path.join(root, '.claude')), false);
    }
  } finally {
    removeProject(root);
  }
});

test('--pack fails cleanly without a pack list or with a stale one', () => {
  const missing = createProject();
  const stale = createPackProject({ core: ['alpha', 'removed'] });
  try {
    const noList = runCli(missing, ['claude', '--pack', 'design']);
    assert.strictEqual(noList.status, 1);
    assert.match(noList.stderr, /cannot read the pack list/);
    const noSkill = runCli(stale, ['claude', '--pack', 'all']);
    assert.strictEqual(noSkill.status, 1);
    assert.match(noSkill.stderr, /Pack core lists a missing skill: removed/);
  } finally {
    removeProject(missing);
    removeProject(stale);
  }
});
