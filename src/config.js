import { UsageError } from './errors.js';

// Parser for the flat .apimigrate.yml subset: scalars, inline lists and "- item" lists.
const scalar = (v) => {
  v = v.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/^(['"])(.*)\1$/, '$2');
};

// List items stay strings, so a hash made only of digits keeps its leading zeros.
const listItem = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

export function parseConfig(text) {
  const cfg = {};
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    // YAML allows list items at the same indent as their key, so the leading space is optional.
    const bullet = line.match(/^\s*-\s+(.*)$/);
    if (bullet && list) {
      cfg[list].push(listItem(bullet[1]));
      continue;
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) throw new UsageError(`.apimigrate.yml: cannot parse "${raw.trim()}"`);
    const [, key, val] = kv;
    if (val === '') {
      cfg[key] = [];
      list = key;
    } else if (val.startsWith('[')) {
      cfg[key] = val.slice(1, -1).split(',').map(listItem).filter((x) => x !== '');
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
  protect: [],
  allow: [],
  coverageTolerance: 0,
  watch: [],
  sources: [],
};

const LISTS = ['providers', 'paths', 'extensions', 'pins', 'reviewers', 'protect', 'allow', 'watch', 'sources'];

// Unknown keys and wrong types are errors, so a typo cannot silently weaken a setting.
export function withDefaults(cfg) {
  for (const key of Object.keys(cfg)) if (!(key in DEFAULTS)) throw new UsageError(`.apimigrate.yml: unknown setting "${key}"`);
  for (const key of LISTS) {
    if (cfg[key] !== undefined && (!Array.isArray(cfg[key]) || cfg[key].some((x) => typeof x !== 'string'))) throw new UsageError(`.apimigrate.yml: ${key} must be a list of strings`);
  }
  if (cfg.draft !== undefined && typeof cfg.draft !== 'boolean') throw new UsageError('.apimigrate.yml: draft must be true or false');
  if (cfg.draft === false) throw new UsageError('.apimigrate.yml: draft: false is not supported, pull requests are always drafts');
  if (cfg.coverageTolerance !== undefined && (typeof cfg.coverageTolerance !== 'number' || cfg.coverageTolerance < 0)) throw new UsageError('.apimigrate.yml: coverageTolerance must be a number of at least 0');
  for (const pin of cfg.pins ?? []) if (!/^[0-9a-f]{64}$/.test(pin)) throw new UsageError(`.apimigrate.yml: pin "${pin}" is not a 64 character hex hash`);
  return { ...DEFAULTS, ...cfg };
}
