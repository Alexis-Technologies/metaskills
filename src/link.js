const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const PACKAGE_NAME = '@alexify/metaskills';
// A stable path under pnpm too: the real one in .pnpm/ changes with every version.
const PACKAGE_SKILLS = path.join('node_modules', '@alexify', 'metaskills', 'skills');
const IDE_TARGETS = new Map([
  ['cursor', '.cursor'],
  ['claude', '.claude'],
  ['windsurf', '.windsurf'],
  ['vscode', '.github'],
  ['gemini', '.gemini'],
  ['antigravity', '.agents'],
]);
// These directories exist for other reasons, so only their skills/ marks the IDE as used.
const SHARED_BASES = new Set(['.github', '.agents']);

const detectTargetDirs = (root) => {
  const found = [];
  for (const base of IDE_TARGETS.values()) {
    const basePath = path.join(root, base);
    if (!fs.existsSync(basePath)) continue;
    const hasSkills = fs.existsSync(path.join(basePath, 'skills'));
    if (SHARED_BASES.has(base) && !hasSkills) continue;
    found.push(`${base}/skills`);
  }
  return found;
};

const listSkills = (source) => {
  const names = [];
  const entries = fs.readdirSync(source, { withFileTypes: true });
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.isDirectory()) continue;
    const manifest = path.join(source, entry.name, 'SKILL.md');
    if (fs.existsSync(manifest)) names.push(entry.name);
  }
  names.sort();
  return names;
};

const isInside = (target, dir) => {
  const relative = path.relative(dir, target);
  if (relative === '' || path.isAbsolute(relative)) return false;
  return !relative.startsWith('..');
};

const isOwnedLink = (linkPath, sourcePath) => {
  const linkTarget = fs.readlinkSync(linkPath);
  const resolved = path.resolve(path.dirname(linkPath), linkTarget);
  if (resolved === sourcePath) return true;
  return isInside(resolved, sourcePath);
};

// Agents read <target>/<skill-name>/SKILL.md. The target from the IDE table
// is the symlink, so .cursor/skills points at the package skills folder.
// Older releases added a metaskills directory under that target.
const removeOwnedLinks = (dirPath, sourcePath) => {
  const removed = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.isSymbolicLink()) continue;
    const linkPath = path.join(dirPath, entry.name);
    if (!isOwnedLink(linkPath, sourcePath)) continue;
    fs.unlinkSync(linkPath);
    removed.push(entry.name);
  }
  removed.sort();
  return removed;
};

const createLink = (linkPath, sourcePath) => {
  const parentPath = path.dirname(linkPath);
  const relativeTarget = path.relative(parentPath, sourcePath);
  fs.symlinkSync(relativeTarget, linkPath, 'dir');
};

const withRemoved = (message, removed) => {
  if (removed.length === 0) return message;
  return `${message}; removed ${removed.join(', ')}`;
};

const linkFresh = (linkPath, sourcePath, targetDir) => {
  createLink(linkPath, sourcePath);
  return {
    created: [targetDir],
    removed: [],
    skipped: [],
    message: `Linked ${targetDir}`,
  };
};

const reuseLink = (linkPath, sourcePath, targetDir) => {
  const linkTarget = fs.readlinkSync(linkPath);
  const resolved = path.resolve(path.dirname(linkPath), linkTarget);
  if (resolved === sourcePath) {
    return {
      created: [],
      removed: [],
      skipped: [],
      message: `Already linked ${targetDir}`,
    };
  }
  const message = `${targetDir} is a symlink; remove it to use skill links`;
  return { created: [], removed: [], skipped: [targetDir], message };
};

const directoryIsReplaceable = (dirPath, sourcePath) => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.isSymbolicLink()) return false;
    const linkPath = path.join(dirPath, entry.name);
    if (!isOwnedLink(linkPath, sourcePath)) return false;
  }
  return true;
};

const replaceDirectory = (linkPath, sourcePath, targetDir) => {
  if (!directoryIsReplaceable(linkPath, sourcePath)) {
    const message = `${targetDir} exists and is not a symlink; skip`;
    return { created: [], removed: [], skipped: [targetDir], message };
  }
  const removed = removeOwnedLinks(linkPath, sourcePath);
  fs.rmdirSync(linkPath);
  createLink(linkPath, sourcePath);
  return {
    created: [targetDir],
    removed,
    skipped: [],
    message: withRemoved(`Linked ${targetDir}`, removed),
  };
};

const ensureSkillLinks = (targetDir, dirs) => {
  const { root, source } = dirs;
  const linkPath = path.join(root, targetDir);
  const sourcePath = path.resolve(source);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (!stat) return linkFresh(linkPath, sourcePath, targetDir);
  if (stat.isSymbolicLink()) return reuseLink(linkPath, sourcePath, targetDir);
  return replaceDirectory(linkPath, sourcePath, targetDir);
};

const addToIgnoreFile = (filePath, entry) => {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  if (lines.includes(entry)) return;
  const isTerminated = content === '' || content.endsWith('\n');
  const separator = isTerminated ? '' : '\n';
  fs.writeFileSync(filePath, `${content}${separator}${entry}\n`);
};

const ensureIgnored = (targetDir, root) => {
  addToIgnoreFile(path.join(root, '.gitignore'), targetDir);
  addToIgnoreFile(path.join(root, '.npmignore'), targetDir);
};

const linkTargets = (targetDirs, context) => {
  const { root, source, log, fail } = context;
  for (let i = 0; i < targetDirs.length; i++) {
    const targetDir = targetDirs[i];
    try {
      const result = ensureSkillLinks(targetDir, { root, source });
      if (result.skipped.length === 0) ensureIgnored(targetDir, root);
      log(result.message);
    } catch (error) {
      fail(`Failed to link ${targetDir}: ${error.message}`);
      return 1;
    }
  }
  return 0;
};

const selectTargets = (ide) => {
  const targets = [];
  if (ide === 'all') {
    for (const base of IDE_TARGETS.values()) targets.push(`${base}/skills`);
  } else if (IDE_TARGETS.has(ide)) {
    targets.push(`${IDE_TARGETS.get(ide)}/skills`);
  }
  return targets;
};

const linkIde = (ide, context) => {
  const targets = selectTargets(ide);
  if (targets.length > 0) return linkTargets(targets, context);
  context.fail(`Unknown ide: ${ide}`);
  return 1;
};

const menuText = () => {
  let items = '';
  let index = 1;
  for (const name of IDE_TARGETS.keys()) {
    items += `${index}) ${name} `;
    index++;
  }
  return `\nSelect IDE or AI Agent: ${items}${index}) all\n`;
};

const askChoice = (input, output) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    let answer = '';
    rl.once('line', (line) => {
      answer = line;
      rl.close();
    });
    rl.once('close', () => resolve(answer));
    rl.setPrompt('> ');
    rl.prompt();
  });

const ideByChoice = (answer) => {
  const choice = Number(answer.trim());
  if (choice === IDE_TARGETS.size + 1) return 'all';
  let index = 1;
  for (const name of IDE_TARGETS.keys()) {
    if (index === choice) return name;
    index++;
  }
  return '';
};

const run = async (options) => {
  const { args, env, root, input, output, errorOutput } = options;
  const log = (message) => {
    output.write(`${message}\n`);
  };
  const fail = (message) => {
    errorOutput.write(`${message}\n`);
  };
  const source = path.join(root, PACKAGE_SKILLS);
  if (!fs.existsSync(source)) {
    fail(`metaskills: ${PACKAGE_NAME} is not installed here. Run: pnpm add -D ${PACKAGE_NAME}`);
    return 1;
  }
  const context = { root, source, log, fail };
  const ide = (args[0] || env.LINK_IDE || '').toLowerCase();
  if (ide) return linkIde(ide, context);
  const detected = detectTargetDirs(root);
  if (detected.length > 0) return linkTargets(detected, context);
  log(menuText());
  const answer = await askChoice(input, output);
  const selected = ideByChoice(answer);
  if (selected) return linkIde(selected, context);
  fail('Invalid choice');
  return 1;
};

module.exports = { ensureSkillLinks, listSkills, run };
