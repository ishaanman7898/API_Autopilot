#!/usr/bin/env node
// Coverage probe: how many SDK call sites in real code can apimigrate see at all?
//
//   node bench/coverage.mjs --calls calls.json --package @mux/mux-node --work <bench work dir> [--receiver-types]
//
// calls.json lists every method path of the SDK, e.g. "video.assets.create". The probe builds one
// manual rule per method, dry-runs it on each base checkout under <work>/repos, and compares what the
// tool reports with a plain text search for ".<method>(" in the same files. Each text hit is then:
//   proven     the tool traced the receiver to the package (it would be rewritten)
//   queued     the tool saw it but could not prove it (it would go to a person or an agent)
//   invisible  the tool did not report it at all (a migration would silently miss it)
// A text hit can be a false positive from another library with the same method names.
//
// --receiver-types also opens each base checkout with the full TypeScript checker, strict, with the SDK installed in
// <work>/repos/node_modules and the path aliases of the nearest tsconfig.json or jsconfig.json, and asks for the type
// of the root receiver of every call the tool proves, such as `client` in client.video.assets.create(). A receiver
// that is not a class the SDK declares, such as any, unknown or a type from another package, is listed, because the
// proof may then be wrong. It checks proofs that no rule exercises, which the type-checks in run.mjs cannot.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'apimigrate.js');
const CODE = /\.[cm]?[jt]sx?$/;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.apimigrate']);

const f = {};
for (let i = 2; i < process.argv.length; i++) {
  const next = process.argv[i + 1];
  f[process.argv[i].replace(/^--/, '')] = next === undefined || next.startsWith('--') ? true : (i++, next);
}
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

const unwrap = (e) => (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) ? unwrap(e.expression) : e);

// What is left of the callee once the call path's segments are taken off: `client` in client.video.assets.create(),
// or `assets` when a variable holds client.video.assets. Of the calls that start on the line, the one that matches most segments wins.
function rootReceiver(sf, line, segs) {
  let best = null;
  const visit = (n) => {
    if (ts.isCallExpression(n) && sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 === line) {
      let e = unwrap(n.expression), k = 0;
      while (k < segs.length && ts.isPropertyAccessExpression(e) && e.name.text === segs[segs.length - 1 - k]) { e = unwrap(e.expression); k++; }
      if (!best || k > best.k) best = { e, k };
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return best?.e;
}

// The client and its resources are classes the SDK package declares. A union must be one in every member.
const sdkDir = f['receiver-types'] ? realpathSync(join(f.work, 'repos', 'node_modules', f.package)).replace(/\\/g, '/') + '/' : null;
const sdkClass = (t) => (t.isUnion() ? t.types.every(sdkClass) : t.isIntersection() ? t.types.some(sdkClass)
  : [t.getSymbol(), t.aliasSymbol].some((s) => s?.declarations?.some((d) => ts.isClassDeclaration(d) && d.getSourceFile().fileName.startsWith(sdkDir))));

// The paths and baseUrl of one config, or of the config it references when a solution-style tsconfig.json has none.
const noScan = { ...ts.sys, readDirectory: () => [] };
function aliases(path, seen = new Set()) {
  if (seen.has(path) || !existsSync(path)) return {};
  seen.add(path);
  const { options, projectReferences = [] } = ts.parseJsonConfigFileContent(ts.readConfigFile(path, ts.sys.readFile).config ?? {}, noScan, dirname(path), undefined, path);
  if (options.paths || options.baseUrl) return Object.fromEntries(['paths', 'baseUrl', 'pathsBasePath'].filter((k) => options[k] !== undefined).map((k) => [k, options[k]]));
  for (const ref of projectReferences) {
    const found = aliases(ts.resolveProjectReferencePath(ref), seen);
    if (found.paths || found.baseUrl) return found;
  }
  return {};
}
const configOf = (base, file) => {
  for (let dir = dirname(join(base, file)); ; dir = dirname(dir)) {
    const config = ['tsconfig.json', 'jsconfig.json'].map((n) => join(dir, n)).find(existsSync);
    if (config || dir === base) return config ?? null;
  }
};

// One program per config, since each config's aliases apply to the files under it.
function receiverTypes(base, sites) {
  const out = { types: {}, other: [] };
  const groups = new Map();
  for (const site of sites) {
    const config = configOf(base, site[0]);
    groups.set(config, [...(groups.get(config) ?? []), site]);
  }
  for (const [config, group] of groups) {
    const program = ts.createProgram([...new Set(group.map(([file]) => join(base, file)))], {
      strict: true, allowJs: true, skipLibCheck: true, noEmit: true, ...(config && aliases(config)),
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    });
    const checker = program.getTypeChecker();
    for (const [file, line, call] of group) {
      const sf = program.getSourceFile(join(base, file));
      const root = sf && rootReceiver(sf, +line, call.split('.'));
      const type = root && checker.getNonNullableType(checker.getTypeAtLocation(root));
      const name = type ? checker.typeToString(type) : 'call not found';
      if (type && sdkClass(type)) out.types[name] = (out.types[name] ?? 0) + 1;
      else out.other.push(`${file}:${line} ${call}: ${root ? `${root.getText(sf)} is ${name}` : name}`);
    }
  }
  return out;
}

const patterns = calls.map((call) => [call, new RegExp(`\\.${call.replace(/\./g, '\\s*\\.\\s*')}\\s*\\(`)]);
const totals = { text: 0, proven: 0, queued: 0, invisible: 0 };
const rows = [];
const receivers = { types: {}, other: [] };
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
  const proven = [...seen].filter(([, s]) => s === 'proven').map(([k]) => k.match(/^(.+):(\d+):(.+)$/).slice(1));
  if (f['receiver-types'] && !error && proven.length) {
    row.receivers = receiverTypes(base, proven);
    for (const [name, n] of Object.entries(row.receivers.types)) receivers.types[name] = (receivers.types[name] ?? 0) + n;
    receivers.other.push(...row.receivers.other.map((s) => `${row.repo} ${s}`));
  }
  if (!error) for (const k of Object.keys(totals)) totals[k] += row[k];
  rows.push(row);
}

writeFileSync(join(f.work, 'coverage.json'), JSON.stringify({ totals, ...(f['receiver-types'] && { receivers }), rows }, null, 1) + '\n');
const pct = (n) => (totals.text ? `${Math.round((n / totals.text) * 100)}%` : '0%');
console.log(`text hits ${totals.text}: proven ${totals.proven} (${pct(totals.proven)}), queued ${totals.queued} (${pct(totals.queued)}), invisible ${totals.invisible} (${pct(totals.invisible)})`);
for (const row of rows.filter((x) => x.text)) console.log(`${row.repo}: ${row.text} hits, ${row.error ?? `${row.proven} proven, ${row.queued} queued, ${row.invisible} invisible`}`);
if (f['receiver-types']) {
  const checked = Object.values(receivers.types).reduce((a, b) => a + b, 0) + receivers.other.length;
  console.log(`receivers of ${checked} proven calls: ${Object.entries(receivers.types).map(([name, n]) => `${n} ${name}`).join(', ') || 'none from the SDK'}; ${receivers.other.length} not an SDK class`);
  for (const s of receivers.other) console.log(`  ${s}`);
}
