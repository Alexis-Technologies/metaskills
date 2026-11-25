const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');

const budgets = require('../../scripts/size-budgets.json');
const { measureAll, measureSkill, sizeProblems, totalProblems } = require('../../scripts/size.js');

const SKILLS_DIR = path.resolve(__dirname, '../../skills');
const LIMITS = { skillChars: 100, skillLines: 5, descriptionChars: 10 };

describe('scripts/size.js', () => {
  it('should read the size and the description in measureSkill', () => {
    const text = '---\nname: alpha\ndescription: short\n---\n\n# alpha\n';
    const row = measureSkill('alpha', text);
    assert.deepStrictEqual(row, {
      name: 'alpha',
      chars: text.length,
      lines: 7,
      descriptionChars: 5,
    });
  });

  it('should count no description without frontmatter in measureSkill', () => {
    assert.strictEqual(measureSkill('alpha', '# alpha\n').descriptionChars, 0);
  });

  it('should pass a skill at every budget in sizeProblems', () => {
    const row = { name: 'alpha', chars: 100, lines: 5, descriptionChars: 10 };
    assert.deepStrictEqual(sizeProblems(row, LIMITS), []);
  });

  it('should name each budget a skill is over in sizeProblems', () => {
    const row = { name: 'alpha', chars: 101, lines: 6, descriptionChars: 11 };
    const problems = sizeProblems(row, LIMITS);
    assert.strictEqual(problems.length, 3);
    assert.match(problems[0], /alpha: 101 chars/);
    assert.match(problems[1], /alpha: 6 lines/);
    assert.match(problems[2], /alpha: description 11/);
  });

  it('should pass descriptions at the total budget and report them over it in totalProblems', () => {
    const rows = [{ descriptionChars: 6 }, { descriptionChars: 4 }];
    assert.deepStrictEqual(totalProblems(rows, { descriptionsTotalChars: 10 }), []);
    const problems = totalProblems(rows, { descriptionsTotalChars: 9 });
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0], /descriptions: 10 chars in total, budget 9/);
  });

  it('should fit every skill in the budgets without exceptions', () => {
    const rows = measureAll(SKILLS_DIR);
    assert.ok(rows.length > 0);
    for (const row of rows) assert.deepStrictEqual(sizeProblems(row, budgets), []);
    assert.deepStrictEqual(totalProblems(rows, budgets), []);
  });
});
