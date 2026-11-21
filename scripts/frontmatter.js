/**
 * Reads the top-level keys of a SKILL.md frontmatter block. Agent tools parse it as YAML, where a
 * repeated key is an error or silently wins, so the repeated keys are reported too.
 */

const parseFrontmatter = (text) => {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return null;
  const fields = {};
  const duplicates = [];
  const lines = text.slice(4, end).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    const isTopLevel = colon > 0 && !line.startsWith(' ');
    if (!isTopLevel) continue;
    const key = line.slice(0, colon);
    if (Object.hasOwn(fields, key)) duplicates.push(key);
    fields[key] = line.slice(colon + 1).trim();
  }
  return { fields, duplicates };
};

module.exports = { parseFrontmatter };
