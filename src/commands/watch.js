import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { NPM_REGISTRY, findUpgrades, lineOf } from '../registry.js';
import { parseSources, signedRulesFor } from '../sources.js';
import { readTree } from '../tree.js';
import { draftedRulesFor } from '../upstream.js';
import { loadConfig } from './common.js';

export const spec = {
  name: 'watch',
  summary: 'find dependencies with a new major version on npm, then fetch signed rules or draft unsigned ones',
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
  const write = (name, value) => {
    const path = join(out, name);
    files.set(path, value);
    return rel(path);
  };
  for (const u of upgrades) {
    const entry = { ...u, source: 'none', signed: false, rules: null, reason: null };
    const notes = [];
    const domain = sources.get(u.package);
    if (domain) {
      const found = await signedRulesFor(u, domain, { fetchImpl: io.fetch, cfg });
      if (found.ok) {
        Object.assign(entry, { source: 'signed', signed: true, rules: write(`${slug(u)}.rules.json`, found.ruleSet), keys: write(`${slug(u)}.keys.json`, { keys: found.keys }), domain, url: found.url, hash: found.hash, keyId: found.keyId });
      } else notes.push(`no usable signed rules from ${domain}: ${found.reason}`);
    }
    if (entry.source === 'none') {
      const drafted = await draftedRulesFor(u, { registry, fetchImpl: io.fetch });
      if (drafted.ok) {
        const counts = { ruleCount: drafted.ruleSet.rules.length, likely: drafted.report.likely, needsReview: drafted.report.needsReview };
        Object.assign(entry, { source: 'draft', draftedFrom: drafted.basis, rules: write(`${slug(u)}.draft.json`, drafted.ruleSet), report: write(`${slug(u)}.draft.report.json`, drafted.report), upstream: { from: drafted.from, to: drafted.to }, ...counts });
        if (drafted.report.uncovered?.length) entry.uncovered = drafted.report.uncovered;
        if (drafted.report.groupedRemovals?.length) entry.grouped = drafted.report.groupedRemovals.map(({ pattern, count, summary }) => ({ pattern, count, summary }));
        if (drafted.report.defaultExportsRemoved?.length) entry.defaultExportsRemoved = drafted.report.defaultExportsRemoved;
      } else notes.push(`no draft: ${drafted.reason}`);
    }
    if (entry.source === 'none') entry.reason = notes.join('; ');
    else if (notes.length) entry.notes = notes;
    plan.upgrades.push(entry);
    const at = (s) => `${s.repo}@${s.ref.slice(0, 12)}`;
    const basis = () => (entry.draftedFrom === 'd.ts' ? `the type declarations of ${u.package}@${u.from} and ${u.package}@${u.to} on npm` : `api.md at ${at(entry.upstream.from)} and ${at(entry.upstream.to)}`);
    const grouped = entry.grouped ? [`${entry.grouped.reduce((n, g) => n + g.count, 0)} more removals grouped without rules`] : [];
    const defaults = (entry.defaultExportsRemoved ?? []).map((d) => `${d.import} has no default export`);
    const what = entry.source === 'signed' ? `signed rules from ${domain}`
      : entry.source === 'draft' ? [`${entry.ruleCount} unsigned draft rules from ${basis()}, ${entry.needsReview} need review`, ...grouped, ...defaults].join(', ')
        : entry.reason;
    io.out(`${u.package}: ${u.from} -> ${u.to} in ${u.manifests.map((m) => m.file).join(', ')}: ${what}${u.deprecated ? ` (latest is deprecated: ${String(u.deprecated).replace(/[\r\n]+/g, ' ')})` : ''}`);
    if (entry.source !== 'none') for (const n of notes) io.err(`${u.package}: ${n}`);
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
