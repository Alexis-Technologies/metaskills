/**
 * What the skills cost in an agent's context. A description is always listed, a SKILL.md is read
 * when the skill is used. Claude Code re-attaches only the first 5000 tokens of a skill after
 * compaction, about 17500 characters of Markdown with code, hence the budget.
 *
 * Usage: pnpm size [--check]   (`--check` exits 1 when a skill is over a budget)
 */

const fs = require('node:fs');
const path = require('node:path');

const { listSkills } = require('../src/link.js');
const { parseFrontmatter } = require('./frontmatter.js');
const budgets = require('./size-budgets.json');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

const measureSkill = (name, text) => {
  const frontmatter = parseFrontmatter(text);
  const description = frontmatter?.fields.description ?? '';
  const lines = text.split('\n').length;
  return { name, chars: text.length, lines, descriptionChars: description.length };
};

const sizeProblems = (row, limits) => {
  const problems = [];
  const { name, chars, lines, descriptionChars } = row;
  if (chars > limits.skillChars) {
    problems.push(`${name}: ${chars} chars, budget ${limits.skillChars}`);
  }
  if (lines > limits.skillLines) {
    problems.push(`${name}: ${lines} lines, budget ${limits.skillLines}`);
  }
  if (descriptionChars > limits.descriptionChars) {
    problems.push(`${name}: description ${descriptionChars}, budget ${limits.descriptionChars}`);
  }
  return problems;
};

const measureAll = (source) => {
  const rows = [];
  const names = listSkills(source);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const text = fs.readFileSync(path.join(source, name, 'SKILL.md'), 'utf8');
    rows.push(measureSkill(name, text));
  }
  return rows;
};

const main = () => {
  const isCheck = process.argv.includes('--check');
  const rows = measureAll(SKILLS_DIR);
  const problems = [];
  let descriptions = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    descriptions += row.descriptionChars;
    problems.push(...sizeProblems(row, budgets));
    const size = `${row.chars} chars, ${row.lines} lines`;
    console.log(`${row.name.padEnd(28)} ${size}, description ${row.descriptionChars}`);
  }
  console.log(`\n${rows.length} skills, ${descriptions} characters of descriptions in total`);
  for (let i = 0; i < problems.length; i++) console.error(problems[i]);
  if (isCheck && problems.length > 0) process.exitCode = 1;
};

if (require.main === module) main();

module.exports = { measureSkill, measureAll, sizeProblems };
