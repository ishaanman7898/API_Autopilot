import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { NPM_REGISTRY, findUpgrades, lineOf } from '../registry.js';
import { parseSources, signedRulesFor } from '../sources.js';
import { readTree } from '../tree.js';
import { loadConfig } from './common.js';

export const spec = {
  name: 'watch',
  summary: 'find dependencies with a new major version on npm and write a migration plan',
  usage: 'watch [--root dir] [--out dir] [--registry url] [--dry-run]',
  value: ['root', 'out', 'registry'],
  bool: ['dry-run'],
  positional: 0,
  options: [
    ['--root dir', 'repository root, default current directory'],
    ['--out dir', 'where to write plan.json and rule files, default .apimigrate/watch'],
    ['--registry url', `npm registry, default ${NPM_REGISTRY}`],
    ['--dry-run', 'print what was found and write nothing'],
  ],
};

export const PLAN_SCHEMA = 'apimigrate-watch/1';
const MANIFEST = /(?:^|\/)package\.json$/;
const slug = (u) => `${u.package.replace(/^@/, '').replace(/[^\w.-]+/g, '-')}-${u.line}-to-${lineOf(u.to)}`;

// io.fetch replaces the global fetch in tests.
export async function run({ flags }, io) {
  const root = resolve(flags.root ?? '.');
  const cfg = loadConfig(root);
  const manifests = readTree(root, { paths: ['.'], match: (rel) => MANIFEST.test(rel) }).files;
  const registry = (flags.registry ?? NPM_REGISTRY).replace(/\/$/, '');
  const sources = parseSources(cfg.sources);
  const { upgrades, skipped } = await findUpgrades(manifests, { registry, fetchImpl: io.fetch, only: cfg.watch });
  const out = resolve(root, flags.out ?? join('.apimigrate', 'watch'));
  const rel = (p) => relative(root, p).split(sep).join('/');
  const files = new Map();

  const plan = { schema: PLAN_SCHEMA, upgrades: [], skipped };
  for (const u of upgrades) {
    const entry = { ...u, source: 'none', rules: null, reason: 'no rule source is configured for this package' };
    const domain = sources.get(u.package);
    if (domain) {
      const found = await signedRulesFor(u, domain, { fetchImpl: io.fetch, cfg });
      if (found.ok) {
        const rules = join(out, `${slug(u)}.rules.json`);
        const keys = join(out, `${slug(u)}.keys.json`);
        files.set(rules, found.ruleSet);
        files.set(keys, { keys: found.keys });
        Object.assign(entry, { source: 'signed', rules: rel(rules), keys: rel(keys), domain, url: found.url, hash: found.hash, keyId: found.keyId, reason: null });
      } else entry.reason = `no usable signed rules from ${domain}: ${found.reason}`;
    }
    plan.upgrades.push(entry);
    const what = entry.source === 'signed' ? `signed rules from ${domain}` : entry.reason;
    io.out(`${u.package}: ${u.from} -> ${u.to} in ${u.manifests.map((m) => m.file).join(', ')}: ${what}${u.deprecated ? ` (latest is deprecated: ${String(u.deprecated).replace(/[\r\n]+/g, ' ')})` : ''}`);
  }
  for (const s of skipped) io.err(`skipped ${s.package}: ${s.reason}`);
  if (!plan.upgrades.length) io.out('no dependency has a new major version');
  if (flags['dry-run']) return 0;

  mkdirSync(out, { recursive: true });
  for (const [path, value] of files) writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  writeFileSync(join(out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  io.out(`plan written to ${rel(join(out, 'plan.json'))}`);
  return 0;
}
