import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { UsageError } from '../errors.js';
import { parseConfig, withDefaults } from '../config.js';
import { fetchKeySet, loadKeySetFile } from '../keys.js';
import { DEFAULT_PROTECTED, isGateFile } from '../gate.js';
import { validateRuleSet } from '../rule.js';
import { TrustError } from '../signing.js';
import { readTree } from '../tree.js';

export const protectList = (cfg) => [...DEFAULT_PROTECTED, ...cfg.protect];

export const KEY_FLAGS = ['keys', 'pubkey', 'well-known', 'key-id'];

export function loadJson(path, what) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { throw new UsageError(`cannot read ${what} ${path}: ${e.message}`); }
  try { return JSON.parse(text); } catch (e) { throw new UsageError(`${what} ${path} is not valid JSON: ${e.message}`); }
}

export function loadRules(path) {
  const rs = loadJson(path, 'rule file');
  const errors = validateRuleSet(rs);
  if (errors.length) throw new UsageError(`invalid rule file:\n  ${errors.join('\n  ')}`);
  return rs;
}

export function loadConfig(root) {
  const p = join(root, '.apimigrate.yml');
  if (!existsSync(p)) return withDefaults({});
  return withDefaults(parseConfig(readFileSync(p, 'utf8')));
}

// Exactly one key source is required. No source is a trust failure, not a default.
export async function loadKeys(flags, rs) {
  const given = ['keys', 'pubkey', 'well-known'].filter((k) => flags[k]);
  if (given.length === 0) throw new TrustError('no key source: pass --keys, --pubkey or --well-known', 'no-keys');
  if (given.length > 1) throw new UsageError('pass only one of --keys, --pubkey and --well-known');
  if (flags['well-known']) return fetchKeySet(flags['well-known']);
  if (flags.keys) return loadKeySetFile(flags.keys);
  return loadKeySetFile(flags.pubkey, flags['key-id'] ?? rs?.signature?.keyId ?? '');
}

// tsconfig.json, jsconfig.json and variants such as tsconfig.base.json. Read from the whole repository,
// because the config that declares a path alias is often outside the scanned paths.
const PROJECT_CONFIG = /(?:^|\/)[jt]sconfig(?:\.[^/]+)?\.json$/;

// Scan files plus every test, CI and test config file the gate watches, all as LF text.
// configs holds the project config files the engine resolves path aliases with. Rules never edit them.
export function loadTrees(root, cfg, scan = { paths: cfg.paths, extensions: cfg.extensions }) {
  const code = readTree(root, scan);
  const watched = readTree(root, { paths: ['.'], match: (rel) => isGateFile(rel, protectList(cfg)) });
  const configs = readTree(root, { paths: ['.'], match: (rel) => PROJECT_CONFIG.test(rel) });
  return {
    files: { ...watched.files, ...code.files },
    scanFiles: code.files,
    configs: configs.files,
    styles: { ...watched.styles, ...code.styles },
    skipped: [...code.skipped, ...watched.skipped],
  };
}

export function audit(root, event) {
  const dir = join(resolve(root), '.apimigrate');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'audit.log'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
}

export function runTests(cmd, root) {
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  return { cmd, exitCode: r.status ?? 1 };
}

export function readCoverage(path) {
  if (!path) return null;
  const summary = loadJson(path, 'coverage summary');
  const pct = summary?.total?.lines?.pct;
  if (typeof pct !== 'number') throw new UsageError(`coverage summary ${path} has no total.lines.pct`);
  return pct;
}
