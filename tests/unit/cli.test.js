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
