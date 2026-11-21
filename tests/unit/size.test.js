const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const budgets = require('../../scripts/size-budgets.json');
const { measureAll, measureSkill, sizeProblems } = require('../../scripts/size.js');

const SKILLS_DIR = path.resolve(__dirname, '../../skills');
const LIMITS = { skillChars: 100, skillLines: 5, descriptionChars: 10 };

test('measureSkill reads the size and the description', () => {
  const text = '---\nname: alpha\ndescription: short\n---\n\n# alpha\n';
  const row = measureSkill('alpha', text);
  assert.deepStrictEqual(row, {
    name: 'alpha',
    chars: text.length,
    lines: 7,
    descriptionChars: 5,
  });
});

test('measureSkill counts no description without frontmatter', () => {
  assert.strictEqual(measureSkill('alpha', '# alpha\n').descriptionChars, 0);
});

test('sizeProblems passes a skill at every budget', () => {
  const row = { name: 'alpha', chars: 100, lines: 5, descriptionChars: 10 };
  assert.deepStrictEqual(sizeProblems(row, LIMITS), []);
});

test('sizeProblems names each budget a skill is over', () => {
  const row = { name: 'alpha', chars: 101, lines: 6, descriptionChars: 11 };
  const problems = sizeProblems(row, LIMITS);
  assert.strictEqual(problems.length, 3);
  assert.match(problems[0], /alpha: 101 chars/);
  assert.match(problems[1], /alpha: 6 lines/);
  assert.match(problems[2], /alpha: description 11/);
});

test('every skill fits the budgets without exceptions', () => {
  const rows = measureAll(SKILLS_DIR);
  assert.ok(rows.length > 0);
  for (const row of rows) assert.deepStrictEqual(sizeProblems(row, budgets), []);
});
