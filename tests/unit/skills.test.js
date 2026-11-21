const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { parseFrontmatter } = require('../../scripts/frontmatter.js');
const { listSkills } = require('../../src/link.js');

const SKILLS_DIR = path.resolve(__dirname, '../../skills');

// Agent Skills spec: name up to 64 chars of [a-z0-9-]. The sizes are checked by scripts/size.js.
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const LINK_PATTERN = /\]\(([^)\s]+)\)/g;
const EXTERNAL_LINK = /^[a-z]+:/;

const listMarkdown = (dir) => {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = listMarkdown(entryPath);
      for (let j = 0; j < nested.length; j++) files.push(nested[j]);
    } else if (entry.name.endsWith('.md')) {
      files.push(entryPath);
    }
  }
  return files;
};

const readSkill = (name) => {
  const skillPath = path.join(SKILLS_DIR, name, 'SKILL.md');
  return fs.readFileSync(skillPath, 'utf8');
};

const names = listSkills(SKILLS_DIR);

test('parseFrontmatter reports a repeated key', () => {
  const text = '---\nname: alpha\ndescription: one\ndescription: two\n---\n';
  assert.deepStrictEqual(parseFrontmatter(text).duplicates, ['description']);
});

test('parseFrontmatter needs a closed block at the start', () => {
  assert.strictEqual(parseFrontmatter('# alpha\n'), null);
  assert.strictEqual(parseFrontmatter('---\nname: alpha\n'), null);
});

test('every skills/ folder is a skill', () => {
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.isDirectory()) continue;
    assert.ok(names.includes(entry.name), `${entry.name} has no SKILL.md`);
  }
});

for (let i = 0; i < names.length; i++) {
  const name = names[i];

  test(`${name}: frontmatter name and description`, () => {
    const frontmatter = parseFrontmatter(readSkill(name));
    assert.ok(frontmatter, 'SKILL.md must start with a --- frontmatter block');
    const { fields, duplicates } = frontmatter;
    assert.deepStrictEqual(duplicates, [], 'a frontmatter key is repeated');
    assert.strictEqual(fields.name, name, 'name must match the folder');
    assert.ok(NAME_PATTERN.test(name), 'name: lowercase letters, digits, -');
    assert.ok(name.length <= MAX_NAME, `name over ${MAX_NAME} chars`);
    const description = fields.description ?? '';
    assert.ok(description.length > 0, 'description is required');
  });

  test(`${name}: relative links resolve`, () => {
    const files = listMarkdown(path.join(SKILLS_DIR, name));
    for (let j = 0; j < files.length; j++) {
      const file = files[j];
      const text = fs.readFileSync(file, 'utf8');
      const links = text.matchAll(LINK_PATTERN);
      for (const link of links) {
        const target = link[1].split('#')[0];
        if (target === '' || EXTERNAL_LINK.test(target)) continue;
        const resolved = path.resolve(path.dirname(file), target);
        const where = `${path.relative(SKILLS_DIR, file)} -> ${target}`;
        assert.ok(fs.existsSync(resolved), `broken link ${where}`);
      }
    }
  });
}
