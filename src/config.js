// Minimal parser for the flat .apimigrate.yml subset: scalars, inline lists and "- item" lists.
const scalar = (v) => {
  v = v.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v.replace(/^(['"])(.*)\1$/, '$2');
};

export function parseConfig(text) {
  const cfg = {};
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && list) {
      cfg[list].push(scalar(item[1]));
      continue;
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) throw new Error(`.apimigrate.yml: cannot parse "${raw}"`);
    const [, key, val] = kv;
    if (val === '') {
      cfg[key] = [];
      list = key;
    } else if (val.startsWith('[')) {
      cfg[key] = val.slice(1, -1).split(',').map(scalar).filter((x) => x !== '');
      list = null;
    } else {
      cfg[key] = scalar(val);
      list = null;
    }
  }
  return cfg;
}

export const DEFAULTS = {
  providers: [],
  paths: ['.'],
  extensions: [],
  pins: [],
  draft: true,
  reviewers: [],
  model: null,
  group: 'per-provider',
};

export const withDefaults = (cfg) => ({ ...DEFAULTS, ...cfg });
