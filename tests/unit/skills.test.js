const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { parseFrontmatter } = require('../../scripts/frontmatter.js');
const { listSkills } = require('../../src/link.js');
const packs = require('../../src/packs.json');

const SKILLS_DIR = path.resolve(__dirname, '../../skills');

// Agent Skills spec: name up to 64 chars of [a-z0-9-]. The sizes are checked by scripts/size.js.
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const LINK_PATTERN = /\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g;
const REFERENCE_PATTERN = /^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm;
const EXTERNAL_LINK = /^[a-z]+:/;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const INLINE_CODE = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;
// A plain YAML scalar ends at ": " or " #", and a block scalar spans lines parseFrontmatter skips.
const UNSAFE_DESCRIPTION = /^[>|'"]|: | #/;
const PACK_NAMES = ['core', 'design', 'library', 'runtime', 'backend', 'security', 'realtime'];

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

const isClosingFence = (match, fence) => {
  if (!match || match[1][0] !== fence[0]) return false;
  return match[1].length >= fence.length && match[2].trim() === '';
};

const isOpeningFence = (match) => {
  if (!match) return false;
  return match[1][0] !== '`' || !match[2].includes('`');
};

// Code such as `handlers[method](...args)` reads as a link, so links are looked for outside it.
const stripCode = (text) => {
  const kept = [];
  const lines = text.split('\n');
  let fence = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = FENCE.exec(line);
    if (fence !== '') {
      if (isClosingFence(match, fence)) fence = '';
      kept.push('');
    } else if (isOpeningFence(match)) {
      fence = match[1];
      kept.push('');
    } else {
      kept.push(line.replace(INLINE_CODE, ''));
    }
  }
  return kept.join('\n');
};

const findLinks = (text) => {
  const prose = stripCode(text);
  const targets = [];
  for (const link of prose.matchAll(LINK_PATTERN)) targets.push(link[1]);
  for (const link of prose.matchAll(REFERENCE_PATTERN)) targets.push(link[1]);
  return targets;
};

const isOutside = (dir, target) => {
  const relative = path.relative(dir, target);
  if (path.isAbsolute(relative)) return true;
  return relative === '..' || relative.startsWith(`..${path.sep}`);
};

const names = listSkills(SKILLS_DIR);

test('findLinks ignores code in fences and inline', () => {
  const text = [
    'See [guide](guide.md) and `handlers[method](...args)`.',
    '```js',
    'const value = methods[name](...args);',
    '```',
    '  ~~~~',
    '  [Symbol.toPrimitive](hint) {}',
    '  ```',
    '  ~~~~',
    '``` not a fence ` here',
    '``a[b](c)`` and [`code`](code.md)',
  ].join('\n');
  assert.deepStrictEqual(findLinks(text), ['guide.md', 'code.md']);
});

test('findLinks reads titled and reference-style links', () => {
  const text = '[a](a.md "Title") [b](<b.md>)\n\n[ref]: ../other/SKILL.md\n';
  assert.deepStrictEqual(findLinks(text), ['a.md', 'b.md', '../other/SKILL.md']);
});

test('isOutside tells a link out of the skill folder', () => {
  const dir = path.join(SKILLS_DIR, 'js-gof');
  assert.ok(isOutside(dir, path.join(SKILLS_DIR, 'js-conventions', 'SKILL.md')));
  assert.ok(isOutside(dir, path.join(SKILLS_DIR, 'js-gof-x', 'SKILL.md')));
  assert.ok(isOutside(dir, SKILLS_DIR));
  assert.ok(!isOutside(dir, path.join(dir, 'patterns', 'adapter.md')));
  assert.ok(!isOutside(dir, path.join(dir, '..hidden.md')));
});

test('a description that a plain YAML scalar cannot hold is refused', () => {
  for (const text of ['> folded', '| literal', '"quoted"', 'Use it: now', 'one #two']) {
    assert.ok(UNSAFE_DESCRIPTION.test(text), text);
  }
  assert.ok(!UNSAFE_DESCRIPTION.test('Use Map, Set and C# when asked'));
});

test('the pack list has the known packs and each skill exactly once', () => {
  assert.deepStrictEqual(Object.keys(packs), PACK_NAMES);
  const seen = new Set();
  for (const pack of PACK_NAMES) {
    assert.ok(packs[pack].length > 0, `${pack} is empty`);
    for (const skill of packs[pack]) {
      assert.ok(names.includes(skill), `${pack} lists a missing skill: ${skill}`);
      assert.ok(!seen.has(skill), `${skill} is in two packs`);
      seen.add(skill);
    }
  }
  assert.deepStrictEqual([...seen].sort(), names);
});

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
    assert.ok(!UNSAFE_DESCRIPTION.test(description), 'description must be a plain one-line scalar');
  });

  test(`${name}: relative links resolve and stay in the skill`, () => {
    const skillDir = path.join(SKILLS_DIR, name);
    const files = listMarkdown(skillDir);
    for (let j = 0; j < files.length; j++) {
      const file = files[j];
      const links = findLinks(fs.readFileSync(file, 'utf8'));
      for (const link of links) {
        const target = link.split('#')[0];
        if (target === '' || EXTERNAL_LINK.test(target)) continue;
        const resolved = path.resolve(path.dirname(file), target);
        const where = `${path.relative(SKILLS_DIR, file)} -> ${target}`;
        assert.ok(fs.existsSync(resolved), `broken link ${where}`);
        assert.ok(!isOutside(skillDir, resolved), `link out of the skill ${where}`);
      }
    }
  });
}
