#!/usr/bin/env node
// Coverage probe: how many SDK call sites in real code can apimigrate see at all?
//
//   node bench/coverage.mjs --calls calls.json --package @mux/mux-node --work <bench work dir>
//
// calls.json lists every method path of the SDK, e.g. "video.assets.create". The probe builds one
// manual rule per method, dry-runs it on each base checkout under <work>/repos, and compares what the
// tool reports with a plain text search for ".<method>(" in the same files. Each text hit is then:
//   proven     the tool traced the receiver to the package (it would be rewritten)
//   queued     the tool saw it but could not prove it (it would go to a person or an agent)
//   invisible  the tool did not report it at all (a migration would silently miss it)
// A text hit can be a false positive from another library with the same method names.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'apimigrate.js');
const CODE = /\.[cm]?[jt]sx?$/;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.apimigrate']);

const f = {};
for (let i = 2; i < process.argv.length; i += 2) f[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const calls = JSON.parse(readFileSync(f.calls, 'utf8'));
const idOf = (call) => 'probe-' + call.replace(/\./g, '-');
const callOf = new Map(calls.map((c) => [idOf(c), c]));

const probe = join(f.work, 'probe.rules.json');
writeFileSync(probe, JSON.stringify({
  schema: 'apimigrate/1', provider: 'probe', package: f.package, id: 'coverage-probe', from: 'any', to: 'any', sunset: '2099-01-01',
  rules: calls.map((call) => ({ id: idOf(call), kind: 'manual', match: { call }, fallback: { prompt: 'probe' } })),
}));

function codeFiles(dir, root = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink() || SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) codeFiles(full, root, acc);
    else if (e.isFile() && CODE.test(e.name) && statSync(full).size < 2 * 1024 * 1024) acc.push(relative(root, full));
  }
  return acc;
}

const patterns = calls.map((call) => [call, new RegExp(`\\.${call.replace(/\./g, '\\s*\\.\\s*')}\\s*\\(`)]);
const totals = { text: 0, proven: 0, queued: 0, invisible: 0 };
const rows = [];
const reposDir = join(f.work, 'repos');
for (const slug of readdirSync(reposDir).filter((d) => d.includes('__')).sort()) {
  const base = join(reposDir, slug, 'base');
  const r = spawnSync(process.execPath, [TOOL, 'apply', '--rules', probe, '--allow-unsigned', '--dry-run', '--root', base], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  // A run killed by the timeout or a crash reports nothing, so its text hits are counted but kept out of the totals.
  const error = r.status === null ? (r.signal === 'SIGTERM' ? 'apply did not finish in 10 minutes' : `apply crashed (${r.signal})`) : null;
  const seen = new Map();
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = line.match(/^unresolved: (.+):(\d+) (\S+): (.*)$/);
    if (m && callOf.has(m[3])) seen.set(`${m[1]}:${m[2]}:${callOf.get(m[3])}`, m[4].startsWith('manual rule') ? 'proven' : 'queued');
  }
  const row = { repo: slug.replace('__', '/'), ...(error && { error }), text: 0, proven: 0, queued: 0, invisible: 0, invisibleSites: [] };
  for (const file of codeFiles(base)) {
    const lines = readFileSync(join(base, file), 'utf8').split('\n');
    lines.forEach((text, i) => {
      for (const [call, re] of patterns) {
        if (!re.test(text)) continue;
        // A longer method path that also matched on this line wins, so a.b.c.list is not also counted as b.c.list.
        if (patterns.some(([other, ore]) => other !== call && other.endsWith('.' + call) && ore.test(text))) continue;
        row.text++;
        if (error) continue;
        const status = seen.get(`${file}:${i + 1}:${call}`) ?? 'invisible';
        row[status]++;
        if (status === 'invisible') row.invisibleSites.push(`${file}:${i + 1} ${call}`);
      }
    });
  }
  if (!error) for (const k of Object.keys(totals)) totals[k] += row[k];
  rows.push(row);
}

writeFileSync(join(f.work, 'coverage.json'), JSON.stringify({ totals, rows }, null, 1) + '\n');
const pct = (n) => (totals.text ? `${Math.round((n / totals.text) * 100)}%` : '0%');
console.log(`text hits ${totals.text}: proven ${totals.proven} (${pct(totals.proven)}), queued ${totals.queued} (${pct(totals.queued)}), invisible ${totals.invisible} (${pct(totals.invisible)})`);
for (const row of rows.filter((x) => x.text)) console.log(`${row.repo}: ${row.text} hits, ${row.error ?? `${row.proven} proven, ${row.queued} queued, ${row.invisible} invisible`}`);
