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
const PACKS_FILE = path.join('src', 'packs.json');
const PACK_FLAG = '--pack';
const PACK_ALL = 'all';
const PACK_CORE = 'core';
const LEGACY_LINK = 'metaskills';
const IGNORE_FILES = ['.gitignore', '.npmignore'];
const IGNORE_BEGIN = '# alexiskills:begin ';
const IGNORE_END = '# alexiskills:end ';

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
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  if (lines.includes(entry)) return;
  const isTerminated = content === '' || content.endsWith('\n');
  const separator = isTerminated ? '' : '\n';
  fs.writeFileSync(filePath, `${content}${separator}${entry}\n`);
};

const splitLines = (content) => {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const blockLines = (targetDir, names) => {
  const lines = [];
  if (names.length === 0) return lines;
  lines.push(`${IGNORE_BEGIN}${targetDir}`);
  for (let i = 0; i < names.length; i++) lines.push(`${targetDir}/${names[i]}`);
  lines.push(`${IGNORE_END}${targetDir}`);
  return lines;
};

// One line per link between markers, so project skills in the same directory stay tracked.
// The block is replaced in place, appended when missing and removed when it has no links.
const writeIgnoreBlock = (filePath, targetDir, names) => {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = splitLines(content);
  const block = blockLines(targetDir, names);
  const begin = lines.indexOf(`${IGNORE_BEGIN}${targetDir}`);
  const end = lines.indexOf(`${IGNORE_END}${targetDir}`);
  const hasBlock = begin !== -1 && end > begin;
  if (!hasBlock && block.length === 0) return;
  if (hasBlock && lines.slice(begin, end + 1).join('\n') === block.join('\n')) return;
  const next = hasBlock
    ? lines.slice(0, begin).concat(block, lines.slice(end + 1))
    : lines.concat(block);
  const text = next.length === 0 ? '' : `${next.join('\n')}\n`;
  fs.writeFileSync(filePath, text);
};

const ignoresWholeTarget = (filePath, targetDir) => {
  const lines = splitLines(fs.readFileSync(filePath, 'utf8'));
  const variants = [targetDir, `${targetDir}/`, `/${targetDir}`, `/${targetDir}/`];
  for (let i = 0; i < variants.length; i++) {
    if (lines.includes(variants[i])) return true;
  }
  return false;
};

// names is null for one directory symlink, or the links of a directory of links.
const updateIgnoreFiles = (targetDir, context, names, hasProjectEntries) => {
  const { root, warn } = context;
  for (let i = 0; i < IGNORE_FILES.length; i++) {
    const fileName = IGNORE_FILES[i];
    const filePath = path.join(root, fileName);
    if (!fs.existsSync(filePath)) continue;
    if (names === null) {
      addToIgnoreFile(filePath, targetDir);
      writeIgnoreBlock(filePath, targetDir, []);
      continue;
    }
    writeIgnoreBlock(filePath, targetDir, names);
    if (hasProjectEntries && ignoresWholeTarget(filePath, targetDir)) {
      warn(`${fileName} ignores all of ${targetDir}, so the project skills in it are not tracked`);
    }
  }
};

const splitPackNames = (value) => {
  const names = [];
  const parts = value.split(',');
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i].trim().toLowerCase();
    if (name !== '') names.push(name);
  }
  return names;
};

const parsePackOption = (args) => {
  const rest = [];
  let names = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith(PACK_FLAG)) {
      rest.push(arg);
      continue;
    }
    const isSeparate = arg === PACK_FLAG;
    if (!isSeparate && !arg.startsWith(`${PACK_FLAG}=`)) {
      return { rest, names, error: `Unknown option: ${arg}` };
    }
    if (isSeparate) i++;
    const value = isSeparate ? (args[i] ?? '') : arg.slice(PACK_FLAG.length + 1);
    const parsed = splitPackNames(value);
    if (parsed.length === 0) return { rest, names, error: `${PACK_FLAG} needs a pack name` };
    names = names === null ? parsed : names.concat(parsed);
  }
  return { rest, names, error: '' };
};

// Read from the installed package: a global CLI can differ from the project's version.
const loadPacks = (source) => {
  const file = path.join(source, '..', PACKS_FILE);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const packs = new Map();
  const names = Object.keys(data);
  for (let i = 0; i < names.length; i++) packs.set(names[i], data[names[i]]);
  return packs;
};

const selectSkills = (names, packs, source) => {
  const available = new Set(listSkills(source));
  const wanted = new Set();
  const selected = [PACK_CORE].concat(names);
  let isAll = false;
  for (let i = 0; i < selected.length; i++) {
    const name = selected[i];
    if (name === PACK_ALL) {
      isAll = true;
      continue;
    }
    const skills = packs.get(name);
    if (!skills) return { wanted: null, error: `Unknown pack: ${name}` };
    for (let j = 0; j < skills.length; j++) {
      const skill = skills[j];
      if (!available.has(skill)) {
        return { wanted: null, error: `Pack ${name} lists a missing skill: ${skill}` };
      }
      wanted.add(skill);
    }
  }
  return { wanted: isAll ? null : wanted, error: '' };
};

const resolveWanted = (names, source) => {
  if (names === null) return { wanted: null, error: '' };
  try {
    return selectSkills(names, loadPacks(source), source);
  } catch (error) {
    return { wanted: null, error: `cannot read the pack list: ${error.message}` };
  }
};

// Narrower than isOwnedLink: another name pointing into the package is the user's alias.
const isPackLink = (linkPath, sourcePath, name) => {
  const resolved = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
  if (resolved === path.join(sourcePath, name)) return true;
  return name === LEGACY_LINK && resolved === sourcePath;
};

const isPackEntry = (dirPath, entry, sourcePath) => {
  if (!entry.isSymbolicLink()) return false;
  return isPackLink(path.join(dirPath, entry.name), sourcePath, entry.name);
};

// Anything that is not one of our links belongs to the project: its own skills, aliases, files.
const holdsProjectEntries = (linkPath, sourcePath) => {
  const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) return false;
  const entries = fs.readdirSync(linkPath, { withFileTypes: true });
  for (let i = 0; i < entries.length; i++) {
    if (!isPackEntry(linkPath, entries[i], sourcePath)) return true;
  }
  return false;
};

// Returns why the target must be left alone, or '' once it is a directory.
const preparePackDir = (linkPath, sourcePath, targetDir) => {
  const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (!stat) {
    fs.mkdirSync(linkPath);
    return '';
  }
  if (!stat.isSymbolicLink()) return '';
  const resolved = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
  if (resolved !== sourcePath) return `${targetDir} is a symlink; remove it to use packs`;
  fs.unlinkSync(linkPath);
  fs.mkdirSync(linkPath);
  return '';
};

const sortEntries = (linkPath, sourcePath) => {
  const ours = new Set();
  const theirs = new Set();
  const entries = fs.readdirSync(linkPath, { withFileTypes: true });
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (isPackEntry(linkPath, entry, sourcePath)) ours.add(entry.name);
    else theirs.add(entry.name);
  }
  return { ours, theirs };
};

const packMessage = (targetDir, changes) => {
  const { created, removed, kept, linked } = changes;
  const isUnchanged = created.length === 0 && removed.length === 0;
  const status = isUnchanged ? 'Already linked' : 'Linked';
  const message = withRemoved(`${status} ${targetDir} (${linked.length} skills)`, removed);
  if (kept.length === 0) return message;
  return `${message}; kept project skill ${kept.join(', ')}`;
};

const syncPackLinks = (targetDir, dirs, wanted) => {
  const { root, source } = dirs;
  const linkPath = path.join(root, targetDir);
  const sourcePath = path.resolve(source);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  const reason = preparePackDir(linkPath, sourcePath, targetDir);
  if (reason !== '') return { created: [], removed: [], skipped: [targetDir], message: reason };
  const { ours, theirs } = sortEntries(linkPath, sourcePath);
  const removed = [];
  for (const name of ours) {
    if (wanted.has(name)) continue;
    fs.unlinkSync(path.join(linkPath, name));
    removed.push(name);
  }
  const created = [];
  const kept = [];
  const linked = [];
  for (const name of wanted) {
    if (theirs.has(name)) {
      kept.push(name);
      continue;
    }
    linked.push(name);
    if (ours.has(name)) continue;
    createLink(path.join(linkPath, name), path.join(sourcePath, name));
    created.push(name);
  }
  removed.sort();
  created.sort();
  kept.sort();
  linked.sort();
  const message = packMessage(targetDir, { created, removed, kept, linked });
  const hasProjectEntries = theirs.size > 0;
  return { created, removed, kept, linked, hasProjectEntries, skipped: [], message };
};

const linkTarget = (targetDir, context) => {
  const { root, source, wanted, log, fail } = context;
  const dirs = { root, source };
  const linkPath = path.join(root, targetDir);
  const hasProjectEntries = holdsProjectEntries(linkPath, path.resolve(source));
  const isPackMode = wanted !== null || hasProjectEntries;
  const result = isPackMode
    ? syncPackLinks(targetDir, dirs, wanted ?? new Set(listSkills(source)))
    : ensureSkillLinks(targetDir, dirs);
  const isSkipped = result.skipped.length > 0;
  if (isPackMode && isSkipped) {
    fail(result.message);
    return 1;
  }
  log(result.message);
  if (isSkipped) return 0;
  const names = isPackMode ? result.linked : null;
  updateIgnoreFiles(targetDir, context, names, isPackMode && result.hasProjectEntries);
  return 0;
};

const linkTargets = (targetDirs, context) => {
  let exitCode = 0;
  for (let i = 0; i < targetDirs.length; i++) {
    const targetDir = targetDirs[i];
    try {
      if (linkTarget(targetDir, context) !== 0) exitCode = 1;
    } catch (error) {
      context.fail(`Failed to link ${targetDir}: ${error.message}`);
      return 1;
    }
  }
  return exitCode;
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
  const warn = (message) => {
    errorOutput.write(`warning: ${message}\n`);
  };
  const source = path.join(root, PACKAGE_SKILLS);
  if (!fs.existsSync(source)) {
    fail(`${PACKAGE_NAME}: not installed here. Run: pnpm add -D ${PACKAGE_NAME}`);
    return 1;
  }
  const { rest, names, error } = parsePackOption(args);
  const selection = error === '' ? resolveWanted(names, source) : { wanted: null, error };
  if (selection.error !== '') {
    fail(`${PACKAGE_NAME}: ${selection.error}`);
    return 1;
  }
  const context = { root, source, wanted: selection.wanted, log, fail, warn };
  const ide = (rest[0] || env.LINK_IDE || '').toLowerCase();
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
