import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NPM_REGISTRY, findUpgrades } from '../registry.js';
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

// io.fetch replaces the global fetch in tests.
export async function run({ flags }, io) {
  const root = resolve(flags.root ?? '.');
  const cfg = loadConfig(root);
  const manifests = readTree(root, { paths: ['.'], match: (rel) => MANIFEST.test(rel) }).files;
  const registry = (flags.registry ?? NPM_REGISTRY).replace(/\/$/, '');
  const { upgrades, skipped } = await findUpgrades(manifests, { registry, fetchImpl: io.fetch, only: cfg.watch });

  const plan = { schema: PLAN_SCHEMA, upgrades: upgrades.map((u) => ({ ...u, source: 'none', rules: null, reason: 'no rule source is configured for this package' })), skipped };
  for (const u of plan.upgrades) {
    io.out(`${u.package}: ${u.from} -> ${u.to} in ${u.manifests.map((m) => m.file).join(', ')}${u.deprecated ? ` (latest is deprecated: ${String(u.deprecated).replace(/[\r\n]+/g, ' ')})` : ''}`);
  }
  for (const s of skipped) io.err(`skipped ${s.package}: ${s.reason}`);
  if (!plan.upgrades.length) io.out('no dependency has a new major version');
  if (flags['dry-run']) return 0;

  const out = resolve(root, flags.out ?? join('.apimigrate', 'watch'));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  io.out(`plan written to ${join(out, 'plan.json')}`);
  return 0;
}
